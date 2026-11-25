import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../src/util.mjs';
import { DecisionLog, decisionLogDir, isDecisionRecord, MAX_FILE_BYTES } from '../src/kernel/log.mjs';
import { child } from './helpers.mjs';

const CLI = fileURLToPath(new URL('../scripts/decisions.mjs', import.meta.url));
const JAN = Date.UTC(2026, 0, 31, 23, 59, 59);
const FEB = Date.UTC(2026, 1, 1, 0, 0, 1);

async function tempDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-decisions-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function record(overrides = {}) {
  const seed = overrides.seed ?? 'decision-1';
  delete overrides.seed;
  return {
    schema: 1, decisionId: hash(seed), time: JAN, pointId: 'delegation.classify', mode: 'shadow', provider: 'jev',
    model: 'fixture-model', cached: false, latencyMs: 12, confidence: 0.8, scope: 'project-scope', subject: null,
    questionsHash: hash('questions'), stateHash: hash('state'),
    answers: {
      risky: { type: 'noul', p: 0.25 },
      role: { type: 'choice', choice: 'implement', p: { implement: 0.8, review: 0.2 }, confidence: 0.8 },
      quality: { type: 'score', score: 1.5, p: { 0: 0.1, 1: 0.4, 2: 0.5 }, confidence: 0.5 },
    },
    trail: [{ provider: 'jev', ok: true, confidence: 0.8, latencyMs: 12 }],
    ...overrides,
  };
}

const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);

test('decision log requires an absolute directory and derives it from config', () => {
  assert.throws(() => new DecisionLog('relative/dir'), e => e.code === 'ABSOLUTE_DECISION_LOG_REQUIRED');
  assert.throws(() => new DecisionLog(undefined), e => e.code === 'ABSOLUTE_DECISION_LOG_REQUIRED');
  assert.equal(decisionLogDir({ stateDir: '/state' }), path.join('/state', 'decisions-log'));
});

test('append and label write private JSONL files and read them back', async t => {
  const dir = path.join(await tempDir(t), 'nested', 'decisions-log');
  let now = JAN;
  const log = new DecisionLog(dir, { now: () => now });
  assert.deepEqual(await log.read(), { decisions: [], labels: [], corruptLines: 0 });
  const first = record();
  await log.append(first);
  await log.append(record({ seed: 'decision-2', pointId: 'read.advice', time: JAN + 1 }));
  const label = await log.label(first.decisionId, { questionId: 'risky', outcome: true, source: 'human' });
  assert.deepEqual(label, { schema: 1, time: JAN, decisionId: first.decisionId, questionId: 'risky', outcome: true, source: 'human' });

  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  const names = (await fs.readdir(dir)).sort();
  assert.deepEqual(names, ['decisions-2026-01.jsonl', 'labels-2026-01.jsonl']);
  for (const name of names) assert.equal((await fs.stat(path.join(dir, name))).mode & 0o777, 0o600);
  const lines = (await fs.readFile(path.join(dir, 'decisions-2026-01.jsonl'), 'utf8')).split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), first);

  const all = await log.read();
  assert.equal(all.decisions.length, 2);
  assert.deepEqual(all.decisions[0], first);
  assert.deepEqual(all.labels, [label]);
  assert.equal(all.corruptLines, 0);

  const filtered = await log.read({ pointId: 'read.advice' });
  assert.deepEqual(filtered.decisions.map(d => d.pointId), ['read.advice']);
  assert.deepEqual(filtered.labels, []);
  assert.equal((await log.read({ since: JAN + 1 })).decisions.length, 1);
  assert.equal((await log.read({ since: JAN + 2 })).decisions.length, 0);
  await rejects(log.read({ since: -1 }), 'INVALID_DECISION_QUERY');
});

test('records roll over into monthly UTC files via the injected clock', async t => {
  const dir = path.join(await tempDir(t), 'log');
  let now = JAN;
  const log = new DecisionLog(dir, { now: () => now });
  await log.append(record());
  now = FEB;
  await log.append(record({ seed: 'decision-2', time: FEB }));
  await log.label(hash('decision-1'), { questionId: 'risky', outcome: false, source: 'acceptance-test' });
  assert.deepEqual((await fs.readdir(dir)).sort(), ['decisions-2026-01.jsonl', 'decisions-2026-02.jsonl', 'labels-2026-02.jsonl']);
  const { decisions, labels } = await log.read();
  assert.deepEqual(decisions.map(d => d.time), [JAN, FEB]);
  assert.equal(labels[0].time, FEB);
});

test('strict validation rejects leaks, unknown keys and malformed answers', async t => {
  const dir = path.join(await tempDir(t), 'log');
  const log = new DecisionLog(dir, { now: () => JAN });
  const bad = [
    record({ prompt: 'raw text' }),
    record({ scope: 'x'.repeat(513) }),
    record({ subject: 'x'.repeat(513) }),
    record({ model: 'x'.repeat(513) }),
    record({ decisionId: 'abc' }),
    record({ decisionId: hash('x').toUpperCase() }),
    record({ schema: 2 }),
    record({ mode: 'live' }),
    record({ cached: 'no' }),
    record({ confidence: 1.5 }),
    record({ latencyMs: Number.NaN }),
    record({ time: -1 }),
    record({ questionsHash: 'x'.repeat(129) }),
    record({ answers: { q: { type: 'noul', p: 0.5, text: 'why' } } }),
    record({ answers: { q: { type: 'noul', noul: 0.5 } } }),
    record({ answers: { q: { type: 'noul', p: 1.2 } } }),
    record({ answers: { q: { type: 'choice', choice: 'a', p: { a: 1 } } } }),
    record({ answers: { q: { type: 'choice', choice: 'x'.repeat(513), p: { a: 1 }, confidence: 1 } } }),
    record({ answers: { q: { type: 'choice', choice: 'a', p: { ['x'.repeat(513)]: 1 }, confidence: 1 } } }),
    record({ answers: { q: { type: 'score', score: 1, p: { high: 1 }, confidence: 1 } } }),
    record({ answers: { q: { type: 'score', score: -1, p: { 0: 1 }, confidence: 1 } } }),
    record({ answers: { q: { type: 'essay', p: 1 } } }),
    record({ answers: { ['x'.repeat(513)]: { type: 'noul', p: 0.5 } } }),
    record({ answers: [] }),
    record({ trail: [{ provider: 'jev', ok: true, latencyMs: 1, response: 'raw' }] }),
    record({ trail: [{ provider: 'jev', ok: 'yes', latencyMs: 1 }] }),
    record({ trail: [{ provider: 'jev', ok: false, code: 'x'.repeat(129), latencyMs: 1 }] }),
    record({ trail: 'jev' }),
    null, 'record', [],
  ];
  for (const r of bad) await rejects(log.append(r), 'INVALID_DECISION_RECORD');
  const missing = record();
  delete missing.stateHash;
  await rejects(log.append(missing), 'INVALID_DECISION_RECORD');
  // Nothing was written, not even the directory.
  await assert.rejects(fs.stat(dir), e => e.code === 'ENOENT');

  assert.equal(isDecisionRecord(record()), true);
  const failed = record({ provider: 'none', model: 'none', confidence: null, answers: {},
    trail: [{ provider: 'jev', ok: false, code: 'JEV_TIMEOUT', latencyMs: 30 }, { provider: 'fallback', ok: false, code: 'NO_PROVIDER', confidence: null, latencyMs: 1 }] });
  await log.append(failed);
  assert.deepEqual((await log.read()).decisions, [failed]);
});

test('a record line is capped at 16384 bytes', async t => {
  const log = new DecisionLog(path.join(await tempDir(t), 'log'), { now: () => JAN });
  const answers = {};
  // Every string stays under 512 chars, yet the serialized line is too long.
  for (let i = 0; i < 40; i++) answers[`${String(i).padStart(2, '0')}-${'q'.repeat(450)}`] = { type: 'noul', p: 0.5 };
  const big = record({ answers });
  assert.equal(isDecisionRecord(big), true);
  await rejects(log.append(big), 'DECISION_RECORD_TOO_LARGE');
});

test('appending stops once the monthly file is full', async t => {
  const dir = path.join(await tempDir(t), 'log');
  const log = new DecisionLog(dir, { now: () => JAN });
  await log.append(record());
  const file = path.join(dir, 'decisions-2026-01.jsonl');
  const before = (await fs.stat(file)).size;
  await fs.truncate(file, MAX_FILE_BYTES - 10);
  await rejects(log.append(record({ seed: 'decision-2' })), 'DECISION_LOG_FULL');
  assert.equal((await fs.stat(file)).size, MAX_FILE_BYTES - 10);
  await fs.truncate(file, before);
  await log.append(record({ seed: 'decision-2' }));
  assert.equal((await log.read()).decisions.length, 2);
});

test('symlinked directories and files are refused', async t => {
  const root = await tempDir(t);
  const real = path.join(root, 'real');
  await fs.mkdir(real);
  const linkDir = path.join(root, 'link');
  await fs.symlink(real, linkDir);
  const viaLink = new DecisionLog(linkDir, { now: () => JAN });
  await rejects(viaLink.append(record()), 'SYMLINK_DESTINATION');
  await rejects(viaLink.label(hash('decision-1'), { questionId: 'risky', outcome: true, source: 'human' }), 'SYMLINK_DESTINATION');
  await rejects(viaLink.read(), 'SYMLINK_DESTINATION');
  assert.deepEqual(await fs.readdir(real), []);

  const dir = path.join(root, 'log');
  await fs.mkdir(dir, { mode: 0o700 });
  const target = path.join(root, 'target.jsonl');
  await fs.writeFile(target, '');
  await fs.symlink(target, path.join(dir, 'decisions-2026-01.jsonl'));
  // A dangling link must be refused too, not created through.
  await fs.symlink(path.join(root, 'missing.jsonl'), path.join(dir, 'labels-2026-01.jsonl'));
  const log = new DecisionLog(dir, { now: () => JAN });
  await rejects(log.append(record()), 'SYMLINK_DESTINATION');
  await rejects(log.label(hash('decision-1'), { questionId: 'risky', outcome: true, source: 'human' }), 'SYMLINK_DESTINATION');
  await rejects(log.read(), 'SYMLINK_DESTINATION');
  assert.equal(await fs.readFile(target, 'utf8'), '');
  await assert.rejects(fs.stat(path.join(root, 'missing.jsonl')), e => e.code === 'ENOENT');
});

test('read skips and counts corrupt lines and ignores unrelated files', async t => {
  const dir = path.join(await tempDir(t), 'log');
  const log = new DecisionLog(dir, { now: () => JAN });
  const good = record();
  await log.append(good);
  await fs.appendFile(path.join(dir, 'decisions-2026-01.jsonl'),
    `{"truncated":\nnot json\n${JSON.stringify({ ...good, extra: 'x' })}\n\n${JSON.stringify(record({ seed: 'decision-2' }))}\n`);
  await fs.writeFile(path.join(dir, 'labels-2026-01.jsonl'),
    `${JSON.stringify({ schema: 1, time: JAN, decisionId: good.decisionId, questionId: 'risky', outcome: true, source: 'human' })}\n`
    + `${JSON.stringify({ schema: 1, time: JAN, decisionId: 'short', questionId: 'risky', outcome: true, source: 'human' })}\n{oops\n`);
  await fs.writeFile(path.join(dir, 'notes.txt'), 'not a log file');
  await fs.writeFile(path.join(dir, 'decisions-2026-13.jsonl'), 'ignored: bad month\n');
  const out = await log.read();
  assert.equal(out.decisions.length, 2);
  assert.equal(out.labels.length, 1);
  assert.equal(out.corruptLines, 5);
});

test('read refuses directories with more than 240 files', async t => {
  const dir = path.join(await tempDir(t), 'log');
  await fs.mkdir(dir);
  for (let i = 0; i < 240; i++) await fs.writeFile(path.join(dir, `file-${i}`), '');
  const log = new DecisionLog(dir);
  assert.equal((await log.read()).decisions.length, 0);
  await fs.writeFile(path.join(dir, 'file-240'), '');
  await rejects(log.read(), 'DECISION_LOG_LIMIT');
});

test('label validates the decision id, outcome and source', async t => {
  const log = new DecisionLog(path.join(await tempDir(t), 'log'), { now: () => JAN });
  const id = hash('decision-1');
  await rejects(log.label('nope', { questionId: 'q', outcome: true, source: 'human' }), 'INVALID_DECISION_ID');
  await rejects(log.label(id.slice(1), { questionId: 'q', outcome: true, source: 'human' }), 'INVALID_DECISION_ID');
  await rejects(log.label(id), 'INVALID_LABEL');
  await rejects(log.label(id, { questionId: 'q', outcome: 'x'.repeat(129), source: 'human' }), 'INVALID_LABEL');
  await rejects(log.label(id, { questionId: 'q', outcome: 1.5, source: 'human' }), 'INVALID_LABEL');
  await rejects(log.label(id, { questionId: 'q', outcome: -1, source: 'human' }), 'INVALID_LABEL');
  await rejects(log.label(id, { questionId: 'q', outcome: null, source: 'human' }), 'INVALID_LABEL');
  await rejects(log.label(id, { questionId: 'q', outcome: true, source: 'x'.repeat(129) }), 'INVALID_LABEL');
  await rejects(log.label(id, { questionId: 'q', outcome: true }), 'INVALID_LABEL');
  await rejects(log.label(id, { questionId: '', outcome: true, source: 'human' }), 'INVALID_LABEL');
  assert.equal((await log.label(id, { questionId: 'q', outcome: false, source: 'human' })).outcome, false);
  assert.equal((await log.label(id, { questionId: 'q', outcome: 'implement', source: 'human' })).outcome, 'implement');
  assert.equal((await log.label(id, { questionId: 'q', outcome: 0, source: 'acceptance-test' })).outcome, 0);
  assert.equal((await log.read()).labels.length, 3);
});

test('decisions CLI labels, shows and reports through --log-dir', async t => {
  const dir = path.join(await tempDir(t), 'log');
  const log = new DecisionLog(dir, { now: () => JAN });
  const first = record();
  const second = record({ seed: 'decision-2', time: JAN + 5, pointId: 'read.advice',
    answers: { useful: { type: 'noul', p: 0.9 }, '7': { type: 'choice', choice: '7', p: { 7: 0.6, true: 0.4 }, confidence: 0.6 } } });
  await log.append(first);
  await log.append(second);
  const run = (...args) => child(process.execPath, [CLI, '--log-dir', dir, ...args]);
  const labelArgs = (decision, question, outcome, ...rest) =>
    ['--action', 'label', '--decision', decision, '--question', question, '--outcome', outcome, '--source', 'human', ...rest];

  let r = await run(...labelArgs(first.decisionId, 'risky', 'true'));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outcome, true);
  r = await run(...labelArgs(first.decisionId, 'role', 'review'));
  assert.equal(JSON.parse(r.stdout).outcome, 'review');
  r = await run(...labelArgs(first.decisionId, 'quality', '2'));
  assert.equal(JSON.parse(r.stdout).outcome, 2);
  // --type disambiguates option names that look like booleans or integers.
  r = await run(...labelArgs(second.decisionId, '7', '7', '--type', 'choice'));
  assert.equal(JSON.parse(r.stdout).outcome, '7');
  r = await run(...labelArgs(second.decisionId, 'useful', 'false', '--type', 'noul'));
  assert.equal(JSON.parse(r.stdout).outcome, false);

  const failures = [
    [labelArgs(first.decisionId, 'risky', 'maybe', '--type', 'noul'), 'INVALID_OUTCOME'],
    [labelArgs(first.decisionId, 'quality', 'high', '--type', 'score'), 'INVALID_OUTCOME'],
    [labelArgs(first.decisionId, 'risky', 'true', '--type', 'other'), 'INVALID_OUTCOME_TYPE'],
    [labelArgs('abc', 'risky', 'true'), 'INVALID_DECISION_ID'],
    [labelArgs(hash('absent'), 'risky', 'true'), 'UNKNOWN_DECISION'],
    [labelArgs(first.decisionId, 'absent', 'true'), 'UNKNOWN_QUESTION'],
    [['--action', 'report', '--since', 'yesterday-ish'], 'INVALID_SINCE'],
    [['--action', 'report', '--threshold', '2'], 'INVALID_THRESHOLD'],
    [['--action', 'show', '--limit', '0'], 'INVALID_LIMIT'],
    [['--action', 'show', '--bogus', '1'], 'UNKNOWN_ARGUMENT'],
  ];
  for (const [args, code] of failures) {
    r = await run(...args);
    assert.equal(r.code, 1);
    assert.equal(r.stderr.trim(), code);
    assert.equal(r.stdout, '');
  }
  r = await child(process.execPath, [CLI, '--log-dir', 'relative', '--action', 'show']);
  assert.equal(r.stderr.trim(), 'ABSOLUTE_DECISION_LOG_REQUIRED');
  assert.equal((await log.read()).labels.length, 5);

  r = await run('--action', 'show', '--limit', '1');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { decisions: [second], usage: { reported: 0, input_tokens: null, output_tokens: null }, corruptLines: 0 });
  r = await run('--action', 'show', '--point', 'delegation.classify');
  assert.deepEqual(JSON.parse(r.stdout).decisions, [first]);

  r = await run('--action', 'report', '--threshold', '0.95');
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.generatedFrom, { decisions: 2, labels: 5 });
  assert.equal(report.corruptLines, 0);
  assert.equal(report.invalidLabels, 0);
  assert.equal(report.groups.length, 5);
  const noul = report.groups.find(g => g.pointId === 'read.advice' && g.type === 'noul');
  // p=0.9 is below the 0.95 threshold and the label is false: one true negative.
  assert.deepEqual([noul.metrics.tp, noul.metrics.fp, noul.metrics.tn, noul.metrics.fn], [0, 0, 1, 0]);
  assert.equal(noul.metrics.precision, null);
  assert.equal(noul.counts.labeled, 1);
  assert.equal(noul.sufficient, false);

  r = await run('--action', 'report', '--point', 'delegation.classify', '--since', '2026-01-01T00:00:00Z');
  const scoped = JSON.parse(r.stdout);
  assert.deepEqual(scoped.generatedFrom, { decisions: 1, labels: 3 });
  assert.deepEqual(scoped.groups.map(g => g.type), ['choice', 'noul', 'score']);
  r = await run('--action', 'report', '--since', '2027-01-01');
  assert.deepEqual(JSON.parse(r.stdout).groups, []);
});

test('the optional usage field round-trips, records without it stay valid, and anything else is rejected', async t => {
  const dir = await tempDir(t);
  const log = new DecisionLog(dir, { now: () => JAN });
  const old = record({ seed: 'old' });
  const counted = record({ seed: 'counted', usage: { input_tokens: 1736, output_tokens: 356 } });
  const partial = record({ seed: 'partial', usage: { input_tokens: 12, output_tokens: null } });
  const unknown = record({ seed: 'unknown', usage: { input_tokens: null, output_tokens: null } });
  const zero = record({ seed: 'zero', usage: { input_tokens: 0, output_tokens: 0 } });
  for (const r of [old, counted, partial, unknown, zero]) await log.append(r);
  const back = (await log.read()).decisions;
  assert.deepEqual(back, [old, counted, partial, unknown, zero]);
  assert.equal(Object.hasOwn(back[0], 'usage'), false);
  assert.equal(back[3].usage.input_tokens, null);

  for (const usage of [null, 7, 'many', [], {}, { input_tokens: 1 }, { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    { input_tokens: -1, output_tokens: 0 }, { input_tokens: 1.5, output_tokens: 0 }, { input_tokens: '12', output_tokens: 0 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 }, { input_tokens: 1, output_tokens: undefined },
    { input_tokens: 1, output_tokens: 'SECRET_TEXT' }]) {
    assert.equal(isDecisionRecord(record({ usage })), false, JSON.stringify(usage));
    await rejects(log.append(record({ usage })), 'INVALID_DECISION_RECORD');
  }
  // usage does not make room for another unknown key, and it cannot stand in for a required one.
  assert.equal(isDecisionRecord(record({ usage: { input_tokens: 1, output_tokens: 1 }, tokens: 2 })), false);
  const missing = record({ usage: { input_tokens: 1, output_tokens: 1 } });
  delete missing.subject;
  assert.equal(isDecisionRecord(missing), false);

  const run = (...args) => child(process.execPath, [CLI, '--log-dir', dir, ...args]);
  let r = await run('--action', 'show', '--limit', '4');
  assert.equal(r.code, 0, r.stderr);
  const shown = JSON.parse(r.stdout);
  assert.equal(shown.decisions.length, 4);
  assert.deepEqual(shown.usage, { reported: 4, input_tokens: 1748, output_tokens: 356 });
  r = await run('--action', 'report');
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.usage, { reported: 4, input_tokens: 1748, output_tokens: 356,
    providers: [{ provider: 'jev', decisions: 5, reported: 4, input_tokens: 1748, output_tokens: 356 }] });
  assert.deepEqual(report.points.map(p => [p.pointId, p.usage.reported, p.usage.input_tokens, p.usage.output_tokens]), [['delegation.classify', 4, 1748, 356]]);
});
