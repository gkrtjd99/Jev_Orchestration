// Offline tests of the evaluation harness itself. The transport is an injected mock, so nothing here is a
// measurement of any real judge; the assertions only check that the harness counts what it is given.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runEvaluation, parseArgs } from '../run-eval.mjs';
import { cohenKappa, percentile, binaryCalibration, prf } from '../lib/stats.mjs';

const SKILLS = {
  pdf: 'Extract text and tables from PDF files.',
  docx: 'Create and edit Word documents.',
  'sql-migrate': 'Write and review database schema migrations.',
  'k8s-deploy': 'Deploy services to Kubernetes clusters. 쿠버네티스 배포.',
  'i18n-ko': '한국어 번역과 현지화 검수.',
  'chart-maker': 'Draw charts from tabular data.',
};
const TASKS = [
  { id: 's1', lang: 'en', category: 'single', task: 'Extract the tables from this PDF report', gold: ['pdf'], blind: ['pdf'] },
  { id: 's2', lang: 'en', category: 'single', task: 'Write a database schema migration for the orders table', gold: ['sql-migrate'], blind: ['sql-migrate'] },
  { id: 's3', lang: 'ko', category: 'single', task: '쿠버네티스 클러스터에 서비스 배포', gold: ['k8s-deploy'], blind: ['k8s-deploy'] },
  { id: 's4', lang: 'en', category: 'none', task: 'Rename the variable foo to bar in utils', gold: [], blind: [] },
  { id: 's5', lang: 'en', category: 'multi', task: 'Extract PDF tables and draw charts from the data', gold: ['pdf', 'chart-maker'], blind: ['pdf'] },
  { id: 's6', lang: 'ko', category: 'none', task: '함수 이름을 바꿔 주세요', gold: [], blind: [] },
];
const REPORTS = [
  { id: 'r1', lang: 'en', report: 'DONE changed src/a.js; ran npm test: 12 passed.', gold: 'complete', evidence: 2, blind: 'complete', blindEvidence: 2 },
  { id: 'r2', lang: 'en', report: 'FLAKY the test timed out once, a rerun should pass.', gold: 'retry', evidence: 1, blind: 'retry', blindEvidence: 0 },
  { id: 'r3', lang: 'ko', report: 'SCOPE 요구사항이 서로 충돌해서 범위를 다시 정해야 합니다.', gold: 'replan', evidence: 0, blind: 'escalate', blindEvidence: 0 },
  { id: 'r4', lang: 'en', report: 'ACCESS I have no access to the production database.', gold: 'escalate', evidence: 0, blind: 'escalate', blindEvidence: 0 },
];

async function fixture() {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'qa-kernel-fixture-'));
  const data = path.join(dir, 'data');
  for (const [name, description] of Object.entries(SKILLS)) {
    await fs.mkdir(path.join(data, 'skills', name), { recursive: true });
    await fs.writeFile(path.join(data, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
  }
  const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(path.join(data, 'skill-tasks.jsonl'), jsonl(TASKS.map(({ id, lang, category, task }) => ({ id, lang, category, task }))));
  await fs.writeFile(path.join(data, 'skill-tasks.gold.jsonl'), jsonl(TASKS.map(({ id, gold }) => ({ id, gold }))));
  await fs.writeFile(path.join(data, 'skill-tasks.blind.jsonl'), jsonl(TASKS.map(({ id, blind }) => ({ id, gold: blind }))));
  await fs.writeFile(path.join(data, 'supervisor-reports.jsonl'), jsonl(REPORTS.map(({ id, lang, report }) => ({ id, lang, report }))));
  await fs.writeFile(path.join(data, 'supervisor-reports.gold.jsonl'), jsonl(REPORTS.map(({ id, gold, evidence }) => ({ id, gold, evidence }))));
  await fs.writeFile(path.join(data, 'supervisor-reports.blind.jsonl'), jsonl(REPORTS.map(({ id, blind, blindEvidence }) => ({ id, gold: blind, evidence: blindEvidence }))));
  return { dir, data, out: path.join(dir, 'results') };
}

// A deterministic oracle that knows the author gold, so expected metrics are exact.
function oracle(state, questions) {
  const answers = {};
  if (typeof state.task === 'string') {
    const gold = new Set(TASKS.find(t => t.task === state.task).gold);
    for (const id of Object.keys(questions)) {
      if (id === 'need') { answers[id] = gold.size ? 0.97 : 0.03; continue; }
      const skill = state.skills[Number(id.slice(6))];
      answers[id] = gold.has(skill.name) ? 0.96 : 0.04;
    }
    return answers;
  }
  const r = REPORTS.find(x => x.report === state.report);
  const p = { complete: 0.02, retry: 0.02, replan: 0.02, escalate: 0.02 };
  // r3 is deliberately answered with low confidence so the shipped threshold hides it.
  p[r.gold] = r.id === 'r3' ? 0.4 : 0.94;
  if (r.id === 'r3') { p.complete = 0.2; p.retry = 0.2; p.escalate = 0.2; }
  const ev = { 0: 0.05, 1: 0.05, 2: 0.05 };
  ev[r.evidence] = 0.9;
  return { outcome: { choice: r.gold, confidence: p[r.gold], probabilities: p }, evidence: { score: r.evidence, confidence: 0.9, probabilities: ev } };
}

function mockFetch(calls) {
  return async (url, init) => {
    const u = new URL(url);
    calls.push({ host: u.host, auth: init.headers.Authorization });
    const body = JSON.parse(init.body);
    const json = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/v1/systemone') {
      const raw = oracle(body.state, body.questions);
      const answers = {};
      for (const [id, q] of Object.entries(body.questions)) {
        answers[id] = q.type === 'noul' ? { type: 'noul', noul: raw[id] } : { type: q.type, ...raw[id] };
      }
      return json({ model: 'mock-jev', answers, usage: { input_tokens: 10, output_tokens: 2 } });
    }
    if (u.pathname === '/v1/decisions') {
      const state = body.input[0].content[0].data;
      const questions = Object.fromEntries(body.questions.map(q => [q.name, q]));
      const raw = oracle(state, questions);
      const answers = body.questions.map(q => {
        if (q.type === 'predicate') return { type: 'predicate', name: q.name, probability: raw[q.name] };
        const a = raw[q.name];
        if (q.type === 'choice') return { type: 'choice', name: q.name, choice: a.choice, confidence: a.confidence, probabilities: Object.entries(a.probabilities).map(([value, probability]) => ({ value, probability })) };
        return { type: 'score', name: q.name, score: a.score, confidence: a.confidence, probabilities: Object.entries(a.probabilities).map(([label, probability]) => ({ label, value: Number(label), probability })) };
      });
      return json({ model: 'mock-openai', answers, usage: { input_tokens: 20, output_tokens: 4 } });
    }
    return new Response('{}', { status: 404 });
  };
}

const ENV = { TYPESAFE_API_KEY: 'tsf-test-key-not-real-000000', OPENAI_API_KEY: 'test-openai-key-not-real-000000' };
const quiet = { write() {} };

test('stats helpers', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([], 0.5), null);
  assert.equal(prf(0, 0, 0).precision, null);
  assert.equal(cohenKappa(['a', 'b', 'a', 'b'], ['a', 'b', 'a', 'b']).kappa, 1);
  assert.equal(cohenKappa(['a', 'a', 'b', 'b'], ['a', 'b', 'a', 'b']).kappa, 0);
  assert.equal(cohenKappa(['a', 'a'], ['a', 'a']).kappa, null);
  assert.equal(binaryCalibration([]).brier, null);
  assert.ok(Math.abs(binaryCalibration([{ p: 0.9, y: 1 }, { p: 0.1, y: 0 }]).brier - 0.01) < 1e-12);
});

test('missing keys abort before anything runs', async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      runEvaluation({ ...parseArgs(['--run-id', 't', '--data', fx.data, '--out', fx.out]) }, { env: {}, fetchImpl: mockFetch([]), stderr: quiet }),
      e => e.code === 'QA_MISSING_KEYS' && /TYPESAFE_API_KEY/.test(e.message) && /OPENAI_API_KEY/.test(e.message));
    await assert.rejects(fs.access(path.join(fx.out, 't')));
  } finally { await fs.rm(fx.dir, { recursive: true, force: true }); }
});

test('local arm needs no key and makes no HTTP request', async () => {
  const fx = await fixture();
  const calls = [];
  try {
    const { metrics } = await runEvaluation(parseArgs(['--run-id', 'local', '--arms', 'local', '--suite', 'skills', '--data', fx.data, '--out', fx.out]),
      { env: {}, fetchImpl: mockFetch(calls), stderr: quiet });
    assert.equal(calls.length, 0);
    assert.equal(metrics.liveRequests.total, 0);
    assert.equal(metrics.skills.local.operations.judgeCalls, 6);
    assert.equal(metrics.skills.local.operations.tokens.inputTokens, 0);
    assert.equal(metrics.skills.local.operations.http.wireUsage.inputTokens, null);
    assert.equal(metrics.skills.local.operations.chain, null);
  } finally { await fs.rm(fx.dir, { recursive: true, force: true }); }
});

test('all arms end to end against an oracle transport', async () => {
  const fx = await fixture();
  const calls = [];
  try {
    const { metrics, resultDir, summary } = await runEvaluation(
      parseArgs(['--run-id', 'e2e', '--data', fx.data, '--out', fx.out]), { env: ENV, fetchImpl: mockFetch(calls), stderr: quiet });
    assert.equal(metrics.live, false);
    assert.match(summary, /NOT LIVE/);

    // Dataset agreement: s5 differs between labelers, so 5 of 6 are consensus.
    assert.equal(metrics.dataset.skills.consensus, 5);
    assert.equal(metrics.dataset.skills.anySkillKappa.kappa, 1);
    assert.equal(metrics.dataset.supervisor.consensus, 3);
    assert.equal(metrics.dataset.supervisor.evidenceExactRate, 0.75);

    // Retrieval at k = catalog size finds everything.
    const full = metrics.retrieval.author.find(x => x.k === 40);
    assert.equal(full.overall.goldSkillRecall, 1);

    for (const arm of ['jev', 'openai']) {
      const a = metrics.skills[arm];
      assert.equal(a.operations.judgeCalls, 6);
      assert.equal(a.operations.failedItems, 0);
      // The oracle answers with the author gold, so the only possible loss is retrieval.
      const g = a.gold.author;
      assert.equal(g.loaded.fp, 0);
      assert.equal(g.loaded.tp, g.retrievalAtMaxCandidates.inCandidates);
      assert.equal(g.noneTasks.falseInjectionRate, 0);
      assert.equal(g.needGate.accuracy, 1);
      assert.equal(a.autoLoadSweep.replayOfShippedThresholdsMismatches, 0);
      assert.equal(a.autoLoadSweep.points.length, 6);
      assert.equal(a.calibration.crossCheck.agrees, true);
      assert.equal(a.calibration.product.labeledDecisions, 5);
      assert.ok(a.operations.context.meanInjectedChars > 0);
    }
    assert.deepEqual(metrics.skills.jev.operations.tokens, { responsesWithUsage: 6, inputTokens: 60, outputTokens: 12 });
    assert.deepEqual(metrics.skills.openai.operations.tokens, { responsesWithUsage: 6, inputTokens: 120, outputTokens: 24 });
    assert.deepEqual(metrics.skills.openai.operations.http.wireUsage, { responsesWithUsage: 6, fieldsSeen: ['input_tokens', 'output_tokens'], inputTokens: 120, outputTokens: 24 });

    // Chain: every decision has a trail and escalated + saved accounts for all of them.
    const chain = metrics.skills.chain.operations.chain;
    assert.equal(chain.decisionsWithTrail, 6);
    assert.equal(chain.escalated + chain.savedRemoteCalls, 6);
    assert.equal(metrics.skills.chain.operations.http.requests, chain.escalated);

    for (const arm of ['jev', 'openai']) {
      const s = metrics.supervisor[arm];
      assert.equal(s.gold.author.outcome.accuracy, 1);
      assert.equal(s.gold.author.evidence.mae, 0);
      // r3 is answered at confidence 0.4 and hidden by the shipped 0.65 threshold.
      assert.equal(s.gold.author.shippedThreshold.coverage, 0.75);
      assert.equal(s.gold.author.shippedThreshold.accuracyAmongSurfaced, 1);
      assert.equal(s.gold.consensus.outcome.n, 3);
      assert.equal(s.calibration.crossCheck.agrees, true);
      assert.equal(s.gold.author.outcome.confusion.replan.replan, 1);
    }
    assert.equal(metrics.supervisor.local, undefined);
    assert.equal(metrics.supervisor.chain, undefined);

    // Each arm only ever sent its own key to its own host.
    assert.ok(calls.every(c => (c.host === 'api.typesafe.ai' && c.auth === `Bearer ${ENV.TYPESAFE_API_KEY}`)
      || (c.host === 'api.openai.com' && c.auth === `Bearer ${ENV.OPENAI_API_KEY}`)));
    assert.equal(metrics.liveRequests.total, calls.length);

    // Outputs exist, carry no key, and include the copied decision logs with labels.
    const names = await fs.readdir(resultDir, { recursive: true });
    for (const name of names) {
      const file = path.join(resultDir, name);
      if (!(await fs.stat(file)).isFile()) continue;
      const text = await fs.readFile(file, 'utf8');
      assert.ok(!text.includes(ENV.TYPESAFE_API_KEY) && !text.includes(ENV.OPENAI_API_KEY), name);
    }
    assert.ok(names.some(n => /decision-log\/skills-jev\/decisions-\d{4}-\d{2}\.jsonl$/.test(n)));
    assert.ok(names.some(n => /decision-log\/supervisor-openai\/labels-\d{4}-\d{2}\.jsonl$/.test(n)));
    const rows = (await fs.readFile(path.join(resultDir, 'rows-skills-jev.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(rows.length, 6);
    assert.ok(rows.every(r => !('task' in r) && Array.isArray(r.trail)));

    // An existing run id is never overwritten silently.
    await assert.rejects(runEvaluation(parseArgs(['--run-id', 'e2e', '--arms', 'local', '--suite', 'skills', '--data', fx.data, '--out', fx.out]),
      { env: ENV, fetchImpl: mockFetch([]), stderr: quiet }), e => e.code === 'QA_RUN_ID_EXISTS');
  } finally { await fs.rm(fx.dir, { recursive: true, force: true }); }
});

test('failures are recorded with their code, timeouts are not retried, transport errors are retried once', async () => {
  const fx = await fixture();
  let n = 0;
  const flaky = async (url, init) => {
    n++;
    if (n === 1) return new Response('{}', { status: 503 });           // transport: retried once
    if (n === 2) return new Response('{}', { status: 400 });           // typed non-transport: not retried
    if (n === 3) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))); // timeout
    return mockFetch([])(url, init);
  };
  try {
    const { metrics } = await runEvaluation(
      parseArgs(['--run-id', 'flaky', '--arms', 'jev', '--suite', 'skills', '--concurrency', '1', '--timeout-ms', '200', '--data', fx.data, '--out', fx.out]),
      { env: ENV, fetchImpl: flaky, stderr: quiet });
    const o = metrics.skills.jev.operations;
    assert.deepEqual(o.failuresFirstPassByCode, { JEV_HTTP_503: 1, JEV_HTTP_400: 1, JEV_TIMEOUT: 1 });
    assert.equal(o.retriedTransportErrors, 1);
    assert.deepEqual(o.failuresByCode, { JEV_HTTP_400: 1, JEV_TIMEOUT: 1 });
    assert.equal(o.timeouts, 1);
    assert.equal(o.judgeCalls, 7);
    assert.equal(o.http.requests, 7);
    assert.equal(metrics.skills.jev.gold.author.failedItems, 2);
    assert.equal(metrics.skills.jev.gold.author.answeredOnly.n, 4);
  } finally { await fs.rm(fx.dir, { recursive: true, force: true }); }
});
