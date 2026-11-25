// Offline tests of the runner's retrieval-mode arms, consensus gold and held-out discipline.
// The transport is an injected mock and the datasets are tiny fixtures written to a temp folder, so nothing
// here measures any real judge and nothing here touches the network or qa/kernel/data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runEvaluation, parseArgs, rowParts, MAX_ROWS_FILE_BYTES } from '../run-eval.mjs';
import { parseArgs as parseFreezeArgs } from '../freeze-holdout.mjs';
import { freezeHoldout, readHoldout, readLedger, readRunLedger, sha256File, SWEEP_LABEL, HOLDOUT_FILE, LEDGER_FILE, RUN_LEDGER_FILE } from '../lib/holdout.mjs';
import { loadSkillSuite, skillAgreement } from '../lib/data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Six real skills plus 40 fillers: 46 skills, so 'full' judges 46 in two balanced requests of 23 (chunk 32),
// while 'lexical' judges 8 in one request.
const SKILLS = {
  pdf: 'Extract text and tables from PDF files.',
  docx: 'Create and edit Word documents.',
  'sql-migrate': 'Write and review database schema migrations.',
  'k8s-deploy': 'Deploy services to Kubernetes clusters.',
  'i18n-ko': 'Review localization and translation quality.',
  'chart-maker': 'Draw charts from tabular data.',
};
for (let i = 1; i <= 40; i++) SKILLS[`filler-${String(i).padStart(2, '0')}`] = `Unrelated procedure number ${i} for widget${i} gadgets.`;

// The Korean tasks and QX-ITEM-004 share no token with the catalog (lexicalSignal 0), so 'adaptive' goes wide on them.
const TASKS = [
  { id: 'QX-ITEM-001', lang: 'en', category: 'single', task: 'Extract the tables from this PDF report', gold: ['pdf'], second: ['pdf'], third: ['pdf'] },
  { id: 'QX-ITEM-002', lang: 'en', category: 'single', task: 'Write a database schema migration for the orders table', gold: ['sql-migrate'], second: ['sql-migrate'], third: ['sql-migrate'] },
  { id: 'QX-ITEM-003', lang: 'ko', category: 'single', task: '쿠버네티스에 서비스를 올려 주세요', gold: ['k8s-deploy'], second: ['k8s-deploy'], third: ['k8s-deploy'] },
  { id: 'QX-ITEM-004', lang: 'en', category: 'none', task: 'Rename the variable foo to bar in utils', gold: [], second: [], third: [] },
  { id: 'QX-ITEM-005', lang: 'en', category: 'multi', task: 'Extract PDF tables and draw charts from the data', gold: ['pdf', 'chart-maker'], second: ['pdf'], third: ['pdf', 'chart-maker'] },
  { id: 'QX-ITEM-006', lang: 'ko', category: 'none', task: '함수 이름을 바꿔 주세요', gold: [], second: [], third: ['docx'] },
  { id: 'QX-ITEM-007', lang: 'ko', category: 'single', task: '번역 품질을 검수해 주세요', gold: ['i18n-ko'], second: ['i18n-ko'], third: ['i18n-ko'] },
];
const WIDE_ONLY = ['QX-ITEM-003', 'QX-ITEM-007'];

const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';

async function fixture({ blind = true, blind2 = false } = {}) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'qa-kernel-holdout-'));
  const data = path.join(dir, 'data');
  for (const [name, description] of Object.entries(SKILLS)) {
    await fs.mkdir(path.join(data, 'skills', name), { recursive: true });
    await fs.writeFile(path.join(data, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
  }
  await fs.writeFile(path.join(data, 'skill-tasks.jsonl'), jsonl(TASKS.map(({ id, lang, category, task }) => ({ id, lang, category, task }))));
  await fs.writeFile(path.join(data, 'skill-tasks.gold.jsonl'), jsonl(TASKS.map(({ id, gold }) => ({ id, gold }))));
  if (blind) await fs.writeFile(path.join(data, 'skill-tasks.blind.jsonl'), jsonl(TASKS.map(({ id, second }) => ({ id, gold: second }))));
  if (blind2) {
    await fs.mkdir(path.join(data, 'relabel'), { recursive: true });
    await fs.writeFile(path.join(data, 'relabel', 'skill-tasks.blind2.jsonl'), jsonl(TASKS.map(({ id, third }) => ({ id, gold: third, confidence: 'high', doubt: '' }))));
  }
  return { dir, data, out: path.join(dir, 'results'), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

// An oracle transport that answers with the author gold. `onRequest` runs before every response.
function mockFetch({ calls = [], onRequest = async () => {}, failChunkOf = null } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ host: new URL(url).host, skills: body.state.skills.length, task: body.state.task });
    await onRequest(body);
    const item = TASKS.find(t => t.task === body.state.task);
    // Optionally fail exactly the request of one task that does NOT contain its gold skill.
    if (failChunkOf === item.id && !body.state.skills.some(s => item.gold.includes(s.name))) return new Response('{}', { status: 400 });
    const gold = new Set(item.gold);
    const answers = {};
    for (const id of Object.keys(body.questions)) {
      if (id === 'need') { answers[id] = { type: 'noul', noul: body.state.skills.some(s => gold.has(s.name)) ? 0.97 : 0.03 }; continue; }
      answers[id] = { type: 'noul', noul: gold.has(body.state.skills[Number(id.slice(6))].name) ? 0.96 : 0.04 };
    }
    return new Response(JSON.stringify({ model: 'mock-jev', answers, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

const ENV = { TYPESAFE_API_KEY: 'tsf-test-key-not-real-000000' };
const quiet = { write() {} };
const args = (fx, extra) => parseArgs(['--suite', 'skills', '--data-dir', fx.data, '--out', fx.out, ...extra]);
const run = (fx, extra, deps = {}) => runEvaluation(args(fx, extra), { env: ENV, fetchImpl: mockFetch(), stderr: quiet, ...deps });
const allOutput = async dir => {
  const names = await fs.readdir(dir, { recursive: true });
  const texts = [];
  for (const name of names) if ((await fs.stat(path.join(dir, name))).isFile()) texts.push([name, await fs.readFile(path.join(dir, name), 'utf8')]);
  return { names, texts };
};

// ---------------------------------------------------------------- options

test('parseArgs: retrieval modes, gold, labels, data-dir and spend-holdout', () => {
  const o = parseArgs(['--run-id', 'x', '--retrieval', 'lexical,adaptive,full', '--gold', 'consensus', '--labels', 'a.jsonl,relabel/b.jsonl', '--data-dir', '/tmp/q', '--spend-holdout', ' final check ']);
  assert.deepEqual(o.retrieval, ['lexical', 'adaptive', 'full']);
  assert.equal(o.gold, 'consensus');
  assert.deepEqual(o.labels, ['a.jsonl', 'relabel/b.jsonl']);
  assert.equal(o.dataDir, path.resolve('/tmp/q'));
  assert.equal(o.spendHoldout, 'final check');
  const d = parseArgs(['--run-id', 'x']);
  assert.equal(d.retrieval, null);
  assert.equal(d.gold, null);
  assert.equal(d.labels, null);
  assert.equal(d.spendHoldout, null);
  assert.equal(d.dataDir, path.resolve(HERE, '..', 'data'));
  assert.equal(parseArgs(['--run-id', 'x', '--data', '/tmp/old']).dataDir, path.resolve('/tmp/old'));
  const bad = argv => assert.throws(() => parseArgs(['--run-id', 'x', ...argv]), e => e.code === 'QA_INVALID_OPTION' || e.code === 'QA_OPTION_NEEDS_VALUE', argv.join(' '));
  bad(['--retrieval', 'lexical,wide']);
  bad(['--retrieval', 'full,full']);
  bad(['--retrieval', ',']);
  bad(['--gold', 'blind']);
  bad(['--labels', 'only-one.jsonl']);
  bad(['--labels', 'a.jsonl,a.jsonl']);
  bad(['--labels', 'a.jsonl,../outside.jsonl']);
  bad(['--labels', '/abs/a.jsonl,b.jsonl']);
  bad(['--data', '/a', '--data-dir', '/b']);
  bad(['--spend-holdout', '   ']);
  bad(['--spend-holdout']);
  bad(['--spend-holdout', 'first', '--respend-holdout', '  ']);
  bad(['--respend-holdout', 'second look without the first reason']);
  assert.equal(parseArgs(['--run-id', 'x', '--spend-holdout', 'a', '--respend-holdout', ' b ']).respendHoldout, 'b');
  assert.equal(d.respendHoldout, null);
  bad(['--retrieval', 'full', '--retrieval', 'lexical']);
});

// ---------------------------------------------------------------- consensus gold

test('consensus = items on which the two label files agree exactly; default second file prefers relabel/blind2', async () => {
  const fx = await fixture({ blind: true, blind2: true });
  try {
    // Default: gold.jsonl vs relabel/skill-tasks.blind2.jsonl. Only QX-ITEM-006 differs ([] vs [docx]).
    const d = await loadSkillSuite(fx.data);
    assert.deepEqual(d.labels, { author: 'skill-tasks.gold.jsonl', a: 'skill-tasks.gold.jsonl', b: 'relabel/skill-tasks.blind2.jsonl' });
    assert.deepEqual([...d.gold.consensus.keys()].sort(), TASKS.filter(t => t.id !== 'QX-ITEM-006').map(t => t.id));
    assert.deepEqual(d.files, ['skill-tasks.jsonl', 'skill-tasks.gold.jsonl', 'relabel/skill-tasks.blind2.jsonl']);
    const agree = skillAgreement(d, new Set(Object.keys(SKILLS)));
    assert.equal(agree.consensus, 6);
    assert.equal(agree.bothLabeled, 7);
    assert.equal(agree.exactSetMatchRate, 6 / 7);
    assert.equal(agree.consensusShareOfItems, 6 / 7);
    assert.deepEqual(agree.labelFiles, d.labels);

    // Named explicitly: gold.jsonl vs blind.jsonl. Only QX-ITEM-005 differs (set comparison, order-free).
    const e = await loadSkillSuite(fx.data, { labels: ['skill-tasks.gold.jsonl', 'skill-tasks.blind.jsonl'] });
    assert.deepEqual([...e.gold.consensus.keys()].sort(), TASKS.filter(t => t.id !== 'QX-ITEM-005').map(t => t.id));

    // Two non-author files: consensus is their agreement (005 and 006 differ), author gold still covers all items.
    const f = await loadSkillSuite(fx.data, { labels: ['skill-tasks.blind.jsonl', 'relabel/skill-tasks.blind2.jsonl'] });
    assert.equal(f.gold.consensus.size, 5);
    assert.equal(f.gold.author.size, 7);
    assert.ok(!f.gold.consensus.has('QX-ITEM-005') && !f.gold.consensus.has('QX-ITEM-006'));

    await assert.rejects(loadSkillSuite(fx.data, { labels: ['skill-tasks.gold.jsonl', 'nope.jsonl'] }), e2 => e2.code === 'DATA_FILE_MISSING');
    await assert.rejects(loadSkillSuite(fx.data, { labels: ['skill-tasks.gold.jsonl', '../x.jsonl'] }), e2 => e2.code === 'DATA_INVALID_LABEL_PATH');
  } finally { await fx.cleanup(); }
});

test('default second label file falls back to skill-tasks.blind.jsonl; none at all means no consensus subset', async () => {
  const withBlind = await fixture({ blind: true, blind2: false });
  const none = await fixture({ blind: false, blind2: false });
  try {
    assert.equal((await loadSkillSuite(withBlind.data)).labels.b, 'skill-tasks.blind.jsonl');
    const n = await loadSkillSuite(none.data);
    assert.equal(n.labels.b, null);
    assert.equal(n.gold.consensus, null);

    // Without a second file the run still works on author gold and says so; demanding consensus is refused before any request.
    const calls = [];
    const { metrics, summary } = await run(none, ['--run-id', 'a', '--arms', 'jev'], { fetchImpl: mockFetch({ calls }) });
    assert.equal(metrics.dataset.skills.consensus, null);
    assert.equal(metrics.dataset.skills.headlineGold, 'author');
    assert.equal(metrics.skills.jev.gold.consensus, null);
    assert.match(summary, /SKILLS on consensus subset: n\/a/);
    const before = calls.length;
    await assert.rejects(run(none, ['--run-id', 'b', '--arms', 'jev', '--gold', 'consensus'], { fetchImpl: mockFetch({ calls }) }), e => e.code === 'QA_NO_CONSENSUS');
    assert.equal(calls.length, before);
    await assert.rejects(fs.access(path.join(none.out, 'b')));
  } finally { await withBlind.cleanup(); await none.cleanup(); }
});

test('a run reports agreement, the consensus size and metrics on BOTH golds', async () => {
  const fx = await fixture({ blind: true, blind2: true });
  try {
    const { metrics, summary } = await run(fx, ['--run-id', 'both', '--arms', 'jev', '--retrieval', 'full']);
    const ds = metrics.dataset.skills;
    assert.equal(ds.items, 7);
    assert.equal(ds.consensus, 6);
    assert.equal(ds.exactSetMatchRate, 6 / 7);
    assert.equal(ds.labelFiles.b, 'relabel/skill-tasks.blind2.jsonl');
    const g = metrics.skills['jev-full'].gold;
    assert.equal(g.consensus.n, 6);
    assert.equal(g.author.n, 7);
    assert.equal(metrics.skills['jev-full'].calibration.product.labelSource, 'qa-consensus-gold');
    assert.match(summary, /consensus subset 6 of 7 tasks/);
    assert.match(summary, /SKILLS on consensus subset \[headline\]/);
    assert.match(summary, /SKILLS on author gold, all items\n/);

    // --gold author makes author gold the headline and the label source; both are still reported.
    const a = await run(fx, ['--run-id', 'author', '--arms', 'jev', '--gold', 'author', '--labels', 'skill-tasks.gold.jsonl,skill-tasks.blind.jsonl']);
    assert.equal(a.metrics.dataset.skills.labelFiles.b, 'skill-tasks.blind.jsonl');
    assert.equal(a.metrics.skills.jev.calibration.product.labelSource, 'qa-author-gold');
    assert.equal(a.metrics.skills.jev.gold.consensus.n, 6);
    assert.match(a.summary, /SKILLS on author gold, all items \[headline\]/);
    assert.match(a.summary, /SKILLS on consensus subset\n/);
  } finally { await fx.cleanup(); }
});

// ---------------------------------------------------------------- arms x retrieval modes

test('--retrieval crosses with --arms: one arm per combination, each with its own state and per-task accounting', async () => {
  const fx = await fixture();
  const calls = [];
  try {
    const { metrics, resultDir, summary } = await run(fx, ['--run-id', 'cross', '--arms', 'jev,local', '--retrieval', 'lexical,adaptive,full'], { fetchImpl: mockFetch({ calls }) });
    assert.deepEqual(Object.keys(metrics.skills), ['jev-lexical', 'jev-adaptive', 'jev-full', 'local-lexical', 'local-adaptive', 'local-full']);
    assert.deepEqual(metrics.plan.map(p => p.key), Object.keys(metrics.skills));
    assert.deepEqual(metrics.options.retrieval, ['lexical', 'adaptive', 'full']);

    const lex = metrics.skills['jev-lexical'], ada = metrics.skills['jev-adaptive'], full = metrics.skills['jev-full'];
    for (const [a, mode] of [[lex, 'lexical'], [ada, 'adaptive'], [full, 'full']]) {
      assert.equal(a.retrievalMode, mode);
      assert.equal(a.judgeArm, 'jev');
      assert.equal(a.operations.retrieval.mode, mode);
      assert.equal(a.thresholds.retrieval, mode);
      assert.equal(a.operations.retrieval.tasks, 7);
      assert.equal(a.operations.taskLatencyMs.n, 7);          // one latency per TASK, not per request
      assert.ok(a.operations.taskLatencyMs.p50 !== null && a.operations.taskLatencyMs.p95 !== null && a.operations.taskLatencyMs.max !== null);
      assert.equal(a.autoLoadSweep.replayOfShippedThresholdsMismatches, 0);
      assert.equal(a.autoLoadSweep.label, SWEEP_LABEL);
      assert.equal(a.calibration.crossCheck.agrees, true);    // product report and direct computation agree per request
      assert.equal(a.operations.retrieval.failedRequests, 0);
      assert.deepEqual(Object.keys(a.gold.author.byLanguage), ['en', 'ko']);
    }

    // lexical: never wide, one request of 8 skills per task.
    assert.equal(lex.operations.retrieval.wideShare, 0);
    assert.deepEqual(lex.operations.retrieval.requestsPerTask, { mean: 1, max: 1 });
    assert.deepEqual(lex.operations.retrieval.skillsJudgedPerTask, { mean: 8, max: 8 });
    assert.equal(lex.operations.judgeCalls, 7);
    assert.deepEqual(lex.operations.tokensPerTask, { input: 10, output: 2 });
    // full: always wide, 46 skills in two requests of 23.
    assert.equal(full.operations.retrieval.wideShare, 1);
    assert.deepEqual(full.operations.retrieval.requestsPerTask, { mean: 2, max: 2 });
    assert.deepEqual(full.operations.retrieval.skillsJudgedPerTask, { mean: 46, max: 46 });
    assert.equal(full.operations.judgeCalls, 14);
    assert.equal(full.operations.http.requests, 14);
    assert.deepEqual(full.operations.tokensPerTask, { input: 20, output: 4 });
    assert.equal(full.decisionLog.decisions, 14);
    assert.equal(full.calibration.product.labeledDecisions, 12); // 6 consensus tasks x 2 requests
    // adaptive: wide exactly for the four tasks that share no token with the catalog (three Korean, one English).
    assert.equal(ada.operations.retrieval.wideTasks, 4);
    assert.equal(ada.operations.retrieval.wideShare, 4 / 7);
    assert.deepEqual(ada.operations.retrieval.wideShareByLanguage, { en: { tasks: 4, wideTasks: 1, wideShare: 0.25 }, ko: { tasks: 3, wideTasks: 3, wideShare: 1 } });
    assert.equal(ada.operations.retrieval.requestsPerTask.mean, 11 / 7);
    assert.equal(ada.operations.retrieval.requestsPerTask.max, 2);
    assert.equal(ada.operations.judgeCalls, 11);

    // The oracle answers with author gold, so recall is bounded only by what reached the judge.
    assert.equal(full.gold.author.loaded.recall, 1);
    assert.equal(full.gold.author.loaded.precision, 1);
    assert.equal(ada.gold.author.loaded.recall, 1);
    assert.equal(lex.gold.author.byLanguage.en.loaded.recall, 1);
    assert.equal(full.gold.author.byLanguage.ko.loaded.recall, 1);
    assert.equal(full.gold.author.noneTasks.falseInjectionRate, 0);

    // local judge: no HTTP, and it abstains on the four tasks without lexical signal in every mode.
    for (const mode of ['lexical', 'adaptive', 'full']) {
      const l = metrics.skills[`local-${mode}`];
      assert.equal(l.operations.http.requests, 0);
      assert.deepEqual(l.operations.tokensPerTask, { input: null, output: null });
      assert.deepEqual(l.operations.failuresByCode, { LOCAL_ABSTAIN: 4 });
    }
    assert.equal(metrics.skills['local-full'].operations.retrieval.requestsPerTask.mean, 2);
    assert.equal(calls.length, 7 + 11 + 14);
    assert.equal(metrics.liveRequests.total, calls.length);

    // Own state per combination: separate decision logs and row files, and scopes that name the combination.
    const { names } = await allOutput(resultDir);
    for (const key of Object.keys(metrics.skills)) {
      assert.ok(names.includes(`rows-skills-${key}.jsonl`), key);
      assert.ok(names.some(n => n.startsWith(`decision-log/skills-${key}/decisions-`)), key);
    }
    const rows = (await fs.readFile(path.join(resultDir, 'rows-skills-jev-full.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.ok(rows.every(r => r.scope.startsWith('qa:cross:skills:jev-full:') && r.calls.length === 2 && r.decisions.length === 2 && r.retrieval.wide && r.decisionIds.length === 2));
    assert.ok(rows.every(r => r.calls.every(c => c.names.length === 23)));
    const lexRows = (await fs.readFile(path.join(resultDir, 'rows-skills-jev-lexical.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    // These two have a gold skill and no lexical signal: in lexical mode the candidates are a name-order tie.
    for (const id of WIDE_ONLY) assert.equal(lexRows.find(r => r.id === id).retrieval.lexicalSignal, 0);

    // The summary shows the per-arm retrieval table and labels the sweep.
    assert.match(summary, /SKILLS retrieval and cost per arm/);
    assert.match(summary, /jev-full\s+full\s+100\.0%\s+2\.00\s+2\s+46\.0\s+20\.0\s+4\.0/);
    assert.match(summary, /\[development analysis - not a result\] BM25 top-k recall/);
    assert.equal(metrics.retrieval.label, SWEEP_LABEL);
  } finally { await fx.cleanup(); }
});

test('without --retrieval the arms keep their plain names and the product default mode', async () => {
  const fx = await fixture();
  try {
    const { metrics } = await run(fx, ['--run-id', 'plain', '--arms', 'jev,local']);
    assert.deepEqual(Object.keys(metrics.skills), ['jev', 'local']);
    assert.equal(metrics.skills.jev.retrievalMode, 'lexical');
    assert.equal(metrics.options.retrieval, null);
  } finally { await fx.cleanup(); }
});

test('a wide task that loses one of its requests is scored on what was answered and counted as a partial failure', async () => {
  const fx = await fixture();
  try {
    const { metrics, resultDir } = await run(fx, ['--run-id', 'partial', '--arms', 'jev', '--retrieval', 'full'], { fetchImpl: mockFetch({ failChunkOf: 'QX-ITEM-001' }) });
    const a = metrics.skills['jev-full'];
    assert.equal(a.operations.retrieval.failedRequests, 1);
    assert.equal(a.operations.retrieval.tasksWithPartialFailure, 1);
    assert.equal(a.operations.retrieval.tasksPartialNothingSelected, 0); // the answered request selected the gold skill
    assert.equal(a.operations.failedItems, 0);
    assert.equal(a.operations.retriedTransportErrors, 0);
    assert.equal(a.gold.author.loaded.recall, 1);              // the answered request held the gold skill
    assert.equal(a.autoLoadSweep.replayOfShippedThresholdsMismatches, 0);
    assert.equal(a.calibration.crossCheck.agrees, true);
    assert.equal(a.decisionLog.decisions, 14);
    const rows = (await fs.readFile(path.join(resultDir, 'rows-skills-jev-full.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const row = rows.find(r => r.id === 'QX-ITEM-001');
    assert.deepEqual(row.calls.map(c => c.ok).sort(), [false, true]);
    assert.equal(row.calls.find(c => !c.ok).code, 'JEV_HTTP_400');
    assert.deepEqual([row.status, row.partial, row.partialCode], ['selected', true, 'JEV_HTTP_400']);
    assert.ok(rows.filter(r => r.id !== 'QX-ITEM-001').every(r => r.partial === false && r.partialCode === null));
    assert.equal(row.candidates.filter(c => c.stage === 'judge_unavailable').length, 23);
  } finally { await fx.cleanup(); }
});

// ---------------------------------------------------------------- held-out discipline

test('freezeHoldout hashes skills/** and every task and label file, and never overwrites', async () => {
  const fx = await fixture({ blind: true, blind2: true });
  try {
    await fs.writeFile(path.join(fx.data, 'README.md'), 'not hashed\n');
    const fixed = new Date('2026-11-25T00:00:00.000Z');
    const { file, manifest } = await freezeHoldout(fx.data, { now: () => fixed });
    assert.equal(file, path.join(fx.data, HOLDOUT_FILE));
    assert.equal(manifest.frozen, true);
    assert.equal(manifest.frozenAt, fixed.toISOString());
    assert.ok(manifest.policy.length > 0);
    const listed = Object.keys(manifest.sha256);
    assert.equal(listed.filter(f => f.startsWith('skills/')).length, Object.keys(SKILLS).length);
    assert.deepEqual(listed.filter(f => !f.startsWith('skills/')).sort(),
      ['relabel/skill-tasks.blind2.jsonl', 'skill-tasks.blind.jsonl', 'skill-tasks.gold.jsonl', 'skill-tasks.jsonl']);
    assert.equal(manifest.sha256['skill-tasks.jsonl'], await sha256File(path.join(fx.data, 'skill-tasks.jsonl')));
    assert.deepEqual(await readHoldout(fx.data), JSON.parse(await fs.readFile(file, 'utf8')));

    const before = await fs.readFile(file, 'utf8');
    await assert.rejects(freezeHoldout(fx.data, { policy: 'another' }), e => e.code === 'QA_HOLDOUT_EXISTS');
    assert.equal(await fs.readFile(file, 'utf8'), before);
    await assert.rejects(freezeHoldout(path.join(fx.dir, 'empty')), e => e.code === 'QA_HOLDOUT_NO_SKILLS');
    await assert.rejects(freezeHoldout(fx.data, { policy: '  ' }), e => e.code === 'QA_HOLDOUT_INVALID_POLICY');
  } finally { await fx.cleanup(); }
});

test('freeze-holdout.mjs CLI: writes once, exits 1 on a second call, 64 without --data-dir', async () => {
  const fx = await fixture();
  const cli = argv => new Promise(resolve => execFile(process.execPath, [path.join(HERE, '..', 'freeze-holdout.mjs'), ...argv], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  try {
    assert.throws(() => parseFreezeArgs([]), e => e.code === 'QA_MISSING_DATA_DIR');
    assert.throws(() => parseFreezeArgs(['--force']), e => e.code === 'QA_UNKNOWN_OPTION');
    assert.equal((await cli([])).code, 64);
    const first = await cli(['--data-dir', fx.data, '--policy', 'scored once']);
    assert.equal(first.code, 0);
    assert.match(first.stdout, /files hashed: 49/);
    assert.equal((await readHoldout(fx.data)).policy, 'scored once');
    const second = await cli(['--data-dir', fx.data]);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /QA_HOLDOUT_EXISTS/);
    assert.equal((await readHoldout(fx.data)).policy, 'scored once');
  } finally { await fx.cleanup(); }
});

test('a frozen set is refused without --spend-holdout: no request, no ledger line, no result folder', async () => {
  const fx = await fixture();
  const calls = [];
  try {
    await freezeHoldout(fx.data);
    await assert.rejects(run(fx, ['--run-id', 'nospend', '--arms', 'jev'], { fetchImpl: mockFetch({ calls }) }), e => e.code === 'QA_HOLDOUT_REQUIRES_SPEND');
    // The offline local arm is refused as well: any look at the set is a spend.
    await assert.rejects(run(fx, ['--run-id', 'nospend2', '--arms', 'local'], { fetchImpl: mockFetch({ calls }) }), e => e.code === 'QA_HOLDOUT_REQUIRES_SPEND');
    assert.equal(calls.length, 0);
    assert.deepEqual(await readLedger(fx.data), []);
    await assert.rejects(fs.access(path.join(fx.data, LEDGER_FILE)));
    await assert.rejects(fs.access(fx.out));
  } finally { await fx.cleanup(); }
});

test('hashes are verified before anything else; a changed, missing or added file refuses the run even with --spend-holdout', async () => {
  const spend = ['--arms', 'jev', '--spend-holdout', 'final scoring'];
  const cases = [
    ['changed label file', async fx => fs.appendFile(path.join(fx.data, 'skill-tasks.gold.jsonl'), '\n'), 'QA_HOLDOUT_HASH_MISMATCH'],
    ['changed skill', async fx => fs.writeFile(path.join(fx.data, 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Extract text, tables and the answer from PDF files.\n---\n'), 'QA_HOLDOUT_HASH_MISMATCH'],
    ['deleted task file', async fx => fs.rm(path.join(fx.data, 'skill-tasks.blind.jsonl')), 'QA_HOLDOUT_FILE_MISSING'],
    ['skill added after the freeze', async fx => { await fs.mkdir(path.join(fx.data, 'skills', 'late')); await fs.writeFile(path.join(fx.data, 'skills', 'late', 'SKILL.md'), '---\nname: late\ndescription: Added later.\n---\n'); }, 'QA_HOLDOUT_UNLISTED_FILE'],
    ['label file added after the freeze', async fx => { await fs.mkdir(path.join(fx.data, 'relabel')); await fs.writeFile(path.join(fx.data, 'relabel', 'skill-tasks.blind2.jsonl'), jsonl(TASKS.map(({ id, gold }) => ({ id, gold })))); }, 'QA_HOLDOUT_UNLISTED_FILE'],
  ];
  for (const [name, tamper, code] of cases) {
    const fx = await fixture();
    const calls = [];
    try {
      await freezeHoldout(fx.data);
      await tamper(fx);
      // Missing keys would normally be reported first; the hash check still wins for listed files.
      const deps = { fetchImpl: mockFetch({ calls }), ...(code === 'QA_HOLDOUT_UNLISTED_FILE' ? {} : { env: {} }) };
      await assert.rejects(run(fx, ['--run-id', 'tampered', ...spend], deps), e => e.code === code, name);
      assert.equal(calls.length, 0, name);
      assert.deepEqual(await readLedger(fx.data), [], name);
      await assert.rejects(fs.access(path.join(fx.out, 'tampered')), undefined, name);
    } finally { await fx.cleanup(); }
  }
});

test('HOLDOUT.json that is present but not a valid frozen manifest is refused, and --spend-holdout needs a frozen set', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(run(fx, ['--run-id', 'dev', '--arms', 'jev', '--spend-holdout', 'oops']), e => e.code === 'QA_HOLDOUT_NOT_FROZEN');
    for (const text of ['{', '{"frozen":false,"sha256":{"skill-tasks.jsonl":"' + 'a'.repeat(64) + '"},"policy":"p"}', '{"frozen":true,"sha256":{},"policy":"p"}',
      '{"frozen":true,"sha256":{"../x":"' + 'a'.repeat(64) + '"},"policy":"p"}', '{"frozen":true,"sha256":{"skill-tasks.jsonl":"zz"},"policy":"p"}']) {
      await fs.writeFile(path.join(fx.data, HOLDOUT_FILE), text);
      await assert.rejects(run(fx, ['--run-id', 'bad', '--arms', 'jev', '--spend-holdout', 'r']), e => e.code === 'QA_HOLDOUT_INVALID', text);
      await assert.rejects(run(fx, ['--run-id', 'bad', '--arms', 'jev']), e => e.code === 'QA_HOLDOUT_INVALID', text);
    }
    await assert.rejects(fs.access(fx.out));
  } finally { await fx.cleanup(); }
});

test('a spent held-out run writes the ledger line before the first request and outputs aggregate metrics only', async () => {
  const fx = await fixture();
  const calls = [];
  let ledgerAtFirstRequest = null;
  try {
    await freezeHoldout(fx.data);
    const onRequest = async () => { if (ledgerAtFirstRequest === null) ledgerAtFirstRequest = await readLedger(fx.data); };
    const { metrics, resultDir, summary } = await run(fx,
      ['--run-id', 'holdout-1', '--arms', 'jev', '--retrieval', 'lexical,adaptive', '--spend-holdout', 'score the chosen mode once'],
      { fetchImpl: mockFetch({ calls, onRequest }) });

    // (c) one ledger line, already there when the first request went out.
    assert.equal(ledgerAtFirstRequest.length, 1);
    const ledger = await readLedger(fx.data);
    assert.equal(ledger.length, 1);
    assert.deepEqual(ledger[0], ledgerAtFirstRequest[0]);
    const entry = ledger[0];
    assert.equal(entry.runId, 'holdout-1');
    assert.equal(entry.reason, 'score the chosen mode once');
    assert.deepEqual(entry.arms, ['jev']);
    assert.deepEqual(entry.retrievalModes, ['lexical', 'adaptive']);
    assert.deepEqual(entry.plan, ['skills/jev-lexical', 'skills/jev-adaptive']);
    assert.equal(entry.productCommit, metrics.product.git.commit);
    assert.ok(typeof entry.productCommit === 'string' && /^[0-9a-f]{40}$/.test(entry.productCommit));
    assert.ok(!Number.isNaN(Date.parse(entry.timestamp)));
    assert.equal(entry.transport, 'injected');
    assert.deepEqual(metrics.holdout.ledgerEntry, entry);
    assert.equal(metrics.holdout.verifiedFiles, 49);
    assert.equal(metrics.holdout.runsRecordedBefore, 0);

    // (d) aggregate metrics are there ...
    assert.equal(calls.length, 7 + 11);
    const a = metrics.skills['jev-adaptive'];
    assert.equal(a.gold.author.loaded.recall, 1);
    assert.equal(a.gold.consensus.n, 6);
    assert.equal(a.operations.retrieval.wideTasks, 4);
    assert.equal(a.operations.taskLatencyMs.n, 7);
    assert.ok(a.gold.author.byLanguage.ko);
    // ... and sweeps and per-item material are not.
    assert.deepEqual(Object.keys(a.autoLoadSweep), ['suppressed']);
    assert.deepEqual(Object.keys(metrics.retrieval), ['suppressed']);
    assert.deepEqual(metrics.files, []);
    assert.deepEqual(metrics.dataset.skills.issues, { missingAuthorGold: 0, missingBlindGold: 0, missingLabelA: 0 });
    const { names, texts } = await allOutput(resultDir);
    assert.deepEqual(names.sort(), ['metrics.json', 'summary.txt']);
    for (const [name, text] of texts) {
      assert.ok(!/QX-ITEM-\d+/.test(text), `${name} lists an item id`);
      assert.ok(!text.includes(SWEEP_LABEL), `${name} carries a sweep`);
      for (const t of TASKS) assert.ok(!text.includes(t.task), `${name} carries a task text`);
    }
    assert.match(summary, /HELD-OUT SET/);
    assert.match(summary, /aggregate metrics only/);
    assert.doesNotMatch(summary, /BM25 top-k recall/);

    // "Once" is enforced: a set with a recorded run is refused, with no request, no ledger line and no result folder.
    const before = calls.length;
    await assert.rejects(run(fx, ['--run-id', 'holdout-2', '--arms', 'local', '--spend-holdout', 'second look'], { fetchImpl: mockFetch({ calls }) }),
      e => e.code === 'QA_HOLDOUT_ALREADY_SPENT');
    assert.equal(calls.length, before);
    assert.equal((await readLedger(fx.data)).length, 1);
    await assert.rejects(fs.access(path.join(fx.out, 'holdout-2')));

    // Deleting the set's own ledger does not reset it: the run ledger of the output directory still knows the manifest.
    const kept = await fs.readFile(path.join(fx.data, LEDGER_FILE), 'utf8');
    await fs.rm(path.join(fx.data, LEDGER_FILE));
    await assert.rejects(run(fx, ['--run-id', 'holdout-2', '--arms', 'local', '--spend-holdout', 'second look']), e => e.code === 'QA_HOLDOUT_ALREADY_SPENT');
    await fs.writeFile(path.join(fx.data, LEDGER_FILE), kept);

    // An explicit second look is possible, is recorded as one, and appends a second line.
    const again = await run(fx, ['--run-id', 'holdout-2', '--arms', 'local', '--spend-holdout', 'second look', '--respend-holdout', 'first run died'], { fetchImpl: mockFetch({ calls }) });
    assert.equal(again.metrics.holdout.runsRecordedBefore, 1);
    assert.deepEqual((await readLedger(fx.data)).map(e => [e.runId, e.reason, e.respendReason ?? null, e.retrievalModes[0]]),
      [['holdout-1', 'score the chosen mode once', null, 'lexical'], ['holdout-2', 'second look', 'first run died', 'product default (lexical)']]);
    const runLedger = await readRunLedger(fx.out);
    assert.deepEqual(runLedger.map(e => [e.runId, e.holdout.runsRecordedBefore, e.holdout.respendReason]), [['holdout-1', 0, null], ['holdout-2', 1, 'first run died']]);
    assert.equal(runLedger[0].holdout.manifestSha256, await sha256File(path.join(fx.data, HOLDOUT_FILE)));
    assert.equal(entry.manifestSha256, runLedger[0].holdout.manifestSha256);

    // A refused run id (already used) is not a look at the set and adds no line.
    await assert.rejects(run(fx, ['--run-id', 'holdout-2', '--arms', 'local', '--spend-holdout', 'third', '--respend-holdout', 'again']), e => e.code === 'QA_RUN_ID_EXISTS');
    assert.equal((await readLedger(fx.data)).length, 2);
    assert.equal((await readRunLedger(fx.out)).length, 2);
  } finally { await fx.cleanup(); }
});

test('the supervisor threshold sweep is labeled on a development set', async () => {
  const fx = await fixture();
  try {
    await fs.writeFile(path.join(fx.data, 'supervisor-reports.jsonl'), jsonl([{ id: 'r1', lang: 'en', report: 'DONE ran npm test: 12 passed.' }]));
    await fs.writeFile(path.join(fx.data, 'supervisor-reports.gold.jsonl'), jsonl([{ id: 'r1', gold: 'complete', evidence: 2 }]));
    const fetchImpl = async () => new Response(JSON.stringify({
      model: 'mock-jev', usage: { input_tokens: 1, output_tokens: 1 },
      answers: {
        outcome: { type: 'choice', choice: 'complete', confidence: 0.9, probabilities: { complete: 0.9, retry: 0.04, replan: 0.03, escalate: 0.03 } },
        evidence: { type: 'score', score: 2, confidence: 0.9, probabilities: { 0: 0.05, 1: 0.05, 2: 0.9 } },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const { metrics } = await runEvaluation(parseArgs(['--run-id', 'sup', '--suite', 'supervisor', '--arms', 'jev', '--data-dir', fx.data, '--out', fx.out]), { env: ENV, fetchImpl, stderr: quiet });
    const sweep = metrics.supervisor.jev.gold.author.thresholdSweep;
    assert.equal(sweep.label, SWEEP_LABEL);
    assert.ok(Array.isArray(sweep.points) && sweep.points.length > 0);

    // Frozen: the supervisor sweep is suppressed too.
    await freezeHoldout(fx.data);
    const held = await runEvaluation(parseArgs(['--run-id', 'sup-held', '--suite', 'supervisor', '--arms', 'jev', '--data-dir', fx.data, '--out', fx.out, '--spend-holdout', 'r']), { env: ENV, fetchImpl, stderr: quiet });
    assert.deepEqual(Object.keys(held.metrics.supervisor.jev.gold.author.thresholdSweep), ['suppressed']);
    assert.deepEqual((await fs.readdir(held.resultDir)).sort(), ['metrics.json', 'summary.txt']);
  } finally { await fx.cleanup(); }
});

test('dev-retrieval-analysis.mjs (a sweep script) refuses a frozen set and labels its output on a development set', async () => {
  const fx = await fixture();
  const script = path.join(HERE, '..', 'dev-retrieval-analysis.mjs');
  const cli = argv => new Promise(resolve => execFile(process.execPath, [script, ...argv], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));
  try {
    const outFile = path.join(fx.dir, 'analysis.json');
    const dev = await cli(['--data', fx.data, '--out', outFile]);
    assert.equal(dev.code, 0, dev.stderr);
    assert.ok(dev.stdout.startsWith(`[${SWEEP_LABEL}]`));
    assert.equal(JSON.parse(await fs.readFile(outFile, 'utf8')).label, SWEEP_LABEL);

    await freezeHoldout(fx.data);
    const held = path.join(fx.dir, 'held.json');
    const refused = await cli(['--data', fx.data, '--out', held]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /QA_HOLDOUT_NO_SWEEPS/);
    await assert.rejects(fs.access(held));
  } finally { await fx.cleanup(); }
});

// ---------------------------------------------------------------- pinned inputs, run ledger, file sizes

test('every run records the sha256 of the files it read, in metrics.json and in the append-only run ledger', async () => {
  const fx = await fixture({ blind2: true });
  try {
    const calls = [];
    let ledgerAtFirstRequest = null;
    const onRequest = async () => { ledgerAtFirstRequest ??= await readRunLedger(fx.out); };
    const { metrics, summary } = await run(fx, ['--run-id', 'dev-1', '--arms', 'jev', '--retrieval', 'lexical', '--gold', 'consensus',
      '--labels', 'skill-tasks.gold.jsonl,relabel/skill-tasks.blind2.jsonl'], { fetchImpl: mockFetch({ calls, onRequest }) });
    const expected = {};
    for (const rel of ['relabel/skill-tasks.blind2.jsonl', 'skill-tasks.gold.jsonl', 'skill-tasks.jsonl']) expected[rel] = await sha256File(path.join(fx.data, rel));
    assert.deepEqual(metrics.inputs.files, expected);
    assert.match(metrics.inputs.catalogFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(summary.includes(`sha256 ${expected['relabel/skill-tasks.blind2.jsonl'].slice(0, 12)}`));
    // Written before the first request, so a run that dies half way is still on record.
    assert.equal(ledgerAtFirstRequest.length, 1);
    const [entry] = await readRunLedger(fx.out);
    assert.deepEqual(entry, metrics.runLedger.entry);
    assert.deepEqual([entry.runId, entry.transport, entry.remoteArms, entry.replacedExistingResult, entry.holdout], ['dev-1', 'injected', true, false, null]);
    assert.deepEqual(entry.inputs.files, expected);
    assert.deepEqual(entry.labels, ['skill-tasks.gold.jsonl', 'relabel/skill-tasks.blind2.jsonl']);

    // A changed label file shows up as a different hash in the next run's record.
    await fs.appendFile(path.join(fx.data, 'relabel', 'skill-tasks.blind2.jsonl'), '\n');
    const second = await run(fx, ['--run-id', 'dev-2', '--arms', 'local']);
    assert.notEqual(second.metrics.inputs.files['relabel/skill-tasks.blind2.jsonl'], expected['relabel/skill-tasks.blind2.jsonl']);
    assert.equal(second.metrics.inputs.files['skill-tasks.gold.jsonl'], expected['skill-tasks.gold.jsonl']);

    // --force replaces an injected or offline result and says so in the ledger ...
    await run(fx, ['--run-id', 'dev-2', '--arms', 'local', '--force']);
    assert.deepEqual((await readRunLedger(fx.out)).map(e => [e.runId, e.replacedExistingResult]), [['dev-1', false], ['dev-2', false], ['dev-2', true]]);
    // ... but never a result that came from a live API run.
    const file = path.join(fx.out, 'dev-1', 'metrics.json');
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), live: true, transport: 'live' }));
    await assert.rejects(run(fx, ['--run-id', 'dev-1', '--arms', 'jev', '--force']), e => e.code === 'QA_RUN_ID_HAS_LIVE_RESULT');
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).live, true);
    assert.equal((await readRunLedger(fx.out)).length, 3);
    assert.equal(RUN_LEDGER_FILE, 'RUN_LEDGER.jsonl');
  } finally { await fx.cleanup(); }
});

test('rows files are split so that no result file passes the 1,000,000-byte limit for committed files', async () => {
  assert.ok(MAX_ROWS_FILE_BYTES < 1000000);
  const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify({ id: i, pad: '가'.repeat(100) })); // multi-byte: sizes are bytes, not characters
  const parts = rowParts(lines, 2000);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(Buffer.byteLength(part) <= 2000 && part.endsWith('\n'));
  assert.equal(parts.join(''), lines.map(l => l + '\n').join('')); // lossless and in order
  assert.deepEqual(rowParts(['a', 'b']), ['a\nb\n']);
  assert.deepEqual(rowParts(['x'.repeat(50), 'y'], 10), ['x'.repeat(50) + '\n', 'y\n']); // an oversized line stands alone
  assert.deepEqual(rowParts([]), ['']);
});

test('a wide run on a larger catalog writes its rows in parts, all listed in metrics.files', async () => {
  const fx = await fixture();
  try {
    // 600 more skills with long descriptions: every row of the 'full' arm lists 64 judged candidates.
    for (let i = 0; i < 600; i++) {
      const name = `zz-bulk-${String(i).padStart(3, '0')}`;
      await fs.mkdir(path.join(fx.data, 'skills', name), { recursive: true });
      await fs.writeFile(path.join(fx.data, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: bulk filler procedure ${i} ${'lorem '.repeat(60)}\n---\nbody\n`);
    }
    const tasks = Array.from({ length: 150 }, (_, i) => ({ id: `QX-BULK-${i}`, lang: 'ko', category: 'none', task: TASKS[4].task }));
    await fs.appendFile(path.join(fx.data, 'skill-tasks.jsonl'), jsonl(tasks));
    await fs.appendFile(path.join(fx.data, 'skill-tasks.gold.jsonl'), jsonl(tasks.map(({ id }) => ({ id, gold: [] }))));
    const { metrics, resultDir } = await run(fx, ['--run-id', 'big', '--arms', 'local', '--retrieval', 'full']);
    const parts = metrics.files.filter(f => f.startsWith('rows-skills-local-full'));
    assert.ok(parts.length > 1, `expected several parts, got ${parts}`);
    assert.deepEqual(parts.slice(0, 2), ['rows-skills-local-full.jsonl', 'rows-skills-local-full.part2.jsonl']);
    let rows = 0;
    for (const name of await fs.readdir(resultDir, { recursive: true })) {
      const stat = await fs.stat(path.join(resultDir, name));
      if (!stat.isFile()) continue;
      assert.ok(stat.size <= 1000000, `${name} is ${stat.size} bytes`);
      if (parts.includes(name)) rows += (await fs.readFile(path.join(resultDir, name), 'utf8')).trim().split('\n').length;
    }
    assert.equal(rows, TASKS.length + 150);
  } finally { await fx.cleanup(); }
});

test('no file under qa/kernel/results or qa/kernel/data passes the size limit that bash scripts/test-all.sh enforces on committed files', async () => {
  const over = [];
  for (const dir of ['results', 'data']) {
    const root = path.join(HERE, '..', dir);
    for (const name of await fs.readdir(root, { recursive: true })) {
      const stat = await fs.stat(path.join(root, name));
      if (stat.isFile() && stat.size > 1000000) over.push(`${dir}/${name} (${stat.size} bytes)`);
    }
  }
  assert.deepEqual(over, []);
});

test('DECISION_RULE.md pins the label files of the deciding run: sha256 and consensus size match the data directory', async () => {
  const rule = await fs.readFile(path.join(HERE, '..', 'DECISION_RULE.md'), 'utf8');
  const pins = [...rule.matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)].map(m => [m[2], m[1]]);
  assert.deepEqual(pins.map(p => p[0]).sort(), ['relabel/skill-tasks.blind2.jsonl', 'relabel/skill-tasks.nocategory.jsonl', 'skill-tasks.gold.jsonl', 'skill-tasks.jsonl']);
  const data = path.join(HERE, '..', 'data');
  for (const [rel, hash] of pins) assert.equal(await sha256File(path.join(data, rel)), hash, rel);
  const size = /consensus 부분집합 크기: (\d+) \/ (\d+)/.exec(rule);
  assert.ok(size, 'the rule states the expected consensus size');
  const suite = await loadSkillSuite(data, { labels: ['skill-tasks.gold.jsonl', 'relabel/skill-tasks.blind2.jsonl'] });
  assert.deepEqual([suite.gold.consensus.size, suite.items.length], [Number(size[1]), Number(size[2])]);
  // The command in the rule names exactly these two label files and a fixed run id.
  assert.match(rule, /--labels skill-tasks\.gold\.jsonl,relabel\/skill-tasks\.blind2\.jsonl/);
  assert.match(rule, /--run-id dev-retrieval-decision-1 /);
});
