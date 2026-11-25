import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, server, mockClient, answer } from './helpers.mjs';
import { sleep } from '../src/util.mjs';
import { routeQuestions, failureQuestions } from '../src/questions.mjs';
import { POINTS, MODES, PROVIDERS, kernelDefaults, mergeKernel, validateKernel, DecisionKernel, createKernel } from '../src/kernel/kernel.mjs';

const code = expected => error => { assert.equal(error.code, expected); return true; };
const fail = c => { const e = new Error(c); e.code = c; return e; };
const QUESTIONS = {
  safe: { type: 'noul', instructions: 'SECRET_INSTRUCTION_TEXT is the change safe?' },
  role: { type: 'choice', instructions: 'SECRET_INSTRUCTION_TEXT pick one.', criteria: { plan: 'SECRET_CRITERIA_TEXT a', implement: 'SECRET_CRITERIA_TEXT b' } },
  quality: { type: 'score', instructions: 'SECRET_INSTRUCTION_TEXT rate.', criteria: ['SECRET_CRITERIA_TEXT low', 'mid', 'high'] },
};
const STATE = { task: 'SENSITIVE_STATE_TEXT implement the toggle' };

function answers({ noul = 0.95, confidence = 0.9 } = {}) {
  const rest = (1 - confidence) / 2;
  return {
    safe: { type: 'noul', noul },
    role: { type: 'choice', choice: 'implement', confidence, probabilities: { plan: 1 - confidence, implement: confidence } },
    quality: { type: 'score', score: 2, confidence, probabilities: { 0: rest, 1: rest, 2: confidence } },
  };
}
/** Scripted judge: records calls and returns or throws the configured outcome. */
function judge(model, outcome = {}) {
  const calls = [];
  return {
    calls,
    async evaluate(state, questions, scope, limits) {
      calls.push({ state, questions, scope, limits });
      if (outcome.delayMs) await sleep(outcome.delayMs);
      if (outcome.error) throw outcome.error;
      return { response: { model, answers: answers(outcome), usage: { input_tokens: 5, output_tokens: 1 } }, cached: outcome.cached === true, latencyMs: 1 };
    },
  };
}
function memoryLog() {
  const records = [];
  return { records, async append(r) { records.push(structuredClone(r)); }, async label() {}, async read() { return { decisions: records, labels: [] }; } };
}
const configWith = (points, extra = {}) => ({ kernel: { points, ...extra } });
const input = (extra = {}) => ({ state: STATE, questions: QUESTIONS, scope: 'session-1', ...extra });

test('constants and defaults match the shared contract', () => {
  assert.deepEqual(POINTS, ['delegation.classify', 'delegation.profile', 'delegation.skills', 'supervisor.outcome', 'failure.classify', 'read.advice']);
  assert.deepEqual(MODES, ['off', 'shadow', 'active']);
  assert.deepEqual(PROVIDERS, ['jev', 'openai', 'local']);
  const on = { mode: 'active', judges: ['jev'], escalateBelow: 0 };
  const off = { mode: 'off', judges: ['jev'], escalateBelow: 0 };
  assert.deepEqual(kernelDefaults(), {
    log: true,
    providers: { openai: { endpoint: 'https://api.openai.com', model: 'gpt-6-luna', approved: false } },
    points: { 'delegation.classify': on, 'delegation.profile': on, 'delegation.skills': off, 'supervisor.outcome': off, 'failure.classify': on, 'read.advice': on },
    skills: { dirs: [], maxCandidates: 8, need: 0.5, autoLoad: 0.9, suggest: 0.5, maxLoaded: 3, maxSuggested: 3 },
    supervisor: { maxReportChars: 1600, confidence: 0.65 },
  });
  assert.equal(validateKernel(kernelDefaults()).log, true);
  // Defaults are fresh objects: mutating one copy must not leak into the next.
  kernelDefaults().points['read.advice'].judges.push('local');
  assert.deepEqual(kernelDefaults().points['read.advice'].judges, ['jev']);
});

test('mergeKernel handles missing and partial input', () => {
  assert.deepEqual(mergeKernel(), kernelDefaults());
  assert.deepEqual(mergeKernel(null), kernelDefaults());
  assert.deepEqual(mergeKernel({}), kernelDefaults());
  const judges = ['local', 'jev'];
  const merged = mergeKernel({
    log: false,
    providers: { openai: { approved: true } },
    points: { 'delegation.skills': { mode: 'shadow' }, 'read.advice': { judges, escalateBelow: 0.6 } },
    skills: { dirs: ['/opt/skills'], maxLoaded: 1 },
    supervisor: { confidence: 0.8 },
  });
  assert.equal(merged.log, false);
  assert.deepEqual(merged.providers.openai, { endpoint: 'https://api.openai.com', model: 'gpt-6-luna', approved: true });
  assert.deepEqual(merged.points['delegation.skills'], { mode: 'shadow', judges: ['jev'], escalateBelow: 0 });
  assert.deepEqual(merged.points['read.advice'], { mode: 'active', judges: ['local', 'jev'], escalateBelow: 0.6 });
  assert.deepEqual(merged.points['delegation.classify'], kernelDefaults().points['delegation.classify']);
  assert.deepEqual(merged.skills, { ...kernelDefaults().skills, dirs: ['/opt/skills'], maxLoaded: 1 });
  assert.deepEqual(merged.supervisor, { maxReportChars: 1600, confidence: 0.8 });
  assert.notEqual(merged.points['read.advice'].judges, judges);
  validateKernel(merged);
  for (const bad of ['active', [], 3]) assert.throws(() => mergeKernel(bad), code('INVALID_KERNEL'));
  // Unknown point ids survive the merge and are rejected by validation.
  assert.throws(() => validateKernel(mergeKernel({ points: { 'delegation.unknown': { mode: 'active' } } })), code('INVALID_KERNEL_POINTS'));
});

test('validateKernel rejects every malformed field with a typed code', () => {
  const bad = (change, expected) => {
    const k = kernelDefaults();
    change(k);
    assert.throws(() => validateKernel(k), code(expected));
  };
  assert.throws(() => validateKernel(null), code('INVALID_KERNEL'));
  bad(k => { k.log = 'yes'; }, 'INVALID_KERNEL_LOG');
  bad(k => { delete k.providers; }, 'INVALID_KERNEL_PROVIDERS');
  bad(k => { k.providers.openai = 'x'; }, 'INVALID_KERNEL_PROVIDERS');
  bad(k => { k.providers.openai.endpoint = 'api.openai.com'; }, 'INVALID_KERNEL_OPENAI_ENDPOINT');
  bad(k => { k.providers.openai.endpoint = 42; }, 'INVALID_KERNEL_OPENAI_ENDPOINT');
  bad(k => { k.providers.openai.model = 'gpt 6'; }, 'INVALID_KERNEL_OPENAI_MODEL');
  bad(k => { k.providers.openai.model = ''; }, 'INVALID_KERNEL_OPENAI_MODEL');
  bad(k => { k.providers.openai.model = 'm'.repeat(101); }, 'INVALID_KERNEL_OPENAI_MODEL');
  bad(k => { k.providers.openai.approved = 'true'; }, 'INVALID_KERNEL_OPENAI_APPROVED');
  bad(k => { k.points = []; }, 'INVALID_KERNEL_POINTS');
  bad(k => { delete k.points['read.advice']; }, 'INVALID_KERNEL_POINTS');
  bad(k => { k.points.extra = { mode: 'off', judges: ['jev'], escalateBelow: 0 }; }, 'INVALID_KERNEL_POINTS');
  bad(k => { k.points['read.advice'] = 'active'; }, 'INVALID_KERNEL_POINT');
  bad(k => { k.points['read.advice'].mode = 'on'; }, 'INVALID_KERNEL_POINT_MODE');
  bad(k => { k.points['read.advice'].judges = []; }, 'INVALID_KERNEL_POINT_JUDGES');
  bad(k => { k.points['read.advice'].judges = 'jev'; }, 'INVALID_KERNEL_POINT_JUDGES');
  bad(k => { k.points['read.advice'].judges = ['jev', 'jev']; }, 'INVALID_KERNEL_POINT_JUDGES');
  bad(k => { k.points['read.advice'].judges = ['jev', 'gemini']; }, 'INVALID_KERNEL_POINT_JUDGES');
  bad(k => { k.points['read.advice'].judges = ['jev', 'openai', 'local', 'jev']; }, 'INVALID_KERNEL_POINT_JUDGES');
  bad(k => { k.points['read.advice'].escalateBelow = 1.5; }, 'INVALID_KERNEL_POINT_ESCALATE');
  bad(k => { k.points['read.advice'].escalateBelow = '0.5'; }, 'INVALID_KERNEL_POINT_ESCALATE');
  bad(k => { k.skills = null; }, 'INVALID_KERNEL_SKILLS');
  bad(k => { k.skills.dirs = ['relative/skills']; }, 'INVALID_KERNEL_SKILLS_DIRS');
  bad(k => { k.skills.dirs = Array.from({ length: 9 }, (_, i) => `/skills/${i}`); }, 'INVALID_KERNEL_SKILLS_DIRS');
  bad(k => { k.skills.dirs = '/skills'; }, 'INVALID_KERNEL_SKILLS_DIRS');
  bad(k => { k.skills.maxCandidates = 0; }, 'INVALID_KERNEL_SKILLS_MAX_CANDIDATES');
  bad(k => { k.skills.maxCandidates = 33; }, 'INVALID_KERNEL_SKILLS_MAX_CANDIDATES');
  bad(k => { k.skills.maxCandidates = 2.5; }, 'INVALID_KERNEL_SKILLS_MAX_CANDIDATES');
  bad(k => { k.skills.need = -0.1; }, 'INVALID_KERNEL_SKILLS_NEED');
  bad(k => { k.skills.autoLoad = 1.1; }, 'INVALID_KERNEL_SKILLS_AUTOLOAD');
  bad(k => { k.skills.suggest = Number.NaN; }, 'INVALID_KERNEL_SKILLS_SUGGEST');
  bad(k => { k.skills.suggest = 0.95; }, 'INVALID_KERNEL_SKILLS_SUGGEST');
  bad(k => { k.skills.maxLoaded = 9; }, 'INVALID_KERNEL_SKILLS_MAX_LOADED');
  bad(k => { k.skills.maxSuggested = -1; }, 'INVALID_KERNEL_SKILLS_MAX_SUGGESTED');
  bad(k => { k.supervisor = []; }, 'INVALID_KERNEL_SUPERVISOR');
  bad(k => { k.supervisor.maxReportChars = 199; }, 'INVALID_KERNEL_SUPERVISOR_REPORT');
  bad(k => { k.supervisor.maxReportChars = 6001; }, 'INVALID_KERNEL_SUPERVISOR_REPORT');
  bad(k => { k.supervisor.confidence = 2; }, 'INVALID_KERNEL_SUPERVISOR_CONFIDENCE');
  const ok = kernelDefaults();
  ok.skills = { dirs: ['/a', '/b'], maxCandidates: 32, need: 0, autoLoad: 1, suggest: 1, maxLoaded: 0, maxSuggested: 8 };
  ok.points['read.advice'] = { mode: 'shadow', judges: ['local', 'openai', 'jev'], escalateBelow: 1 };
  assert.equal(validateKernel(ok), ok);
  assert.throws(() => new DecisionKernel({ kernel: { log: 1 } }), code('INVALID_KERNEL_LOG'));
});

test('default kernel is a transparent facade over the existing client', async () => {
  const client = mockClient({ role: 'review' });
  const kernel = createKernel({}, { client });
  const questions = routeQuestions([{ path: 'a.md' }]);
  const state = { task: 'Review the change' };
  const result = await kernel.forPoint('delegation.classify').evaluate(state, questions, 'session-1');
  assert.equal(client.count, 1);
  assert.deepEqual(result.response, answer(questions, { role: 'review' }));
  assert.equal(result.cached, false);
  assert.equal(result.provider, 'jev');
  assert.equal(result.mode, 'active');
  assert.equal(result.apply, true);
  assert.match(result.decisionId, /^[0-9a-f]{64}$/);
  assert.equal(typeof result.latencyMs, 'number');

  // The response object and cached flag are passed through untouched.
  const fixed = { response: answer(failureQuestions()), cached: true, latencyMs: 3 };
  const passthrough = createKernel({}, { client: { async evaluate() { return fixed; } } });
  const second = await passthrough.forPoint('failure.classify').evaluate({ failure: 'x' }, failureQuestions(), 's');
  assert.equal(second.response, fixed.response);
  assert.equal(second.cached, true);
});

test('point lookup and off mode', async () => {
  const jev = judge('jev-model');
  const kernel = new DecisionKernel({}, { judges: { jev } });
  assert.deepEqual(kernel.point('delegation.skills'), { mode: 'off', judges: ['jev'], escalateBelow: 0 });
  for (const id of ['nope', 'constructor', undefined]) assert.throws(() => kernel.point(id), code('KERNEL_UNKNOWN_POINT'));
  await assert.rejects(kernel.decide('nope', input()), code('KERNEL_UNKNOWN_POINT'));
  assert.throws(() => kernel.forPoint('nope'), code('KERNEL_UNKNOWN_POINT'));
  assert.deepEqual(await kernel.decide('delegation.skills', input()), { pointId: 'delegation.skills', mode: 'off', skipped: true, apply: false });
  await assert.rejects(kernel.forPoint('supervisor.outcome').evaluate(STATE, QUESTIONS, 's'), code('KERNEL_POINT_OFF'));
  assert.equal(jev.calls.length, 0);
});

test('shadow and active modes differ only in apply', async () => {
  const jev = judge('jev-model', { cached: true });
  const kernel = new DecisionKernel(configWith({ 'read.advice': { mode: 'shadow' } }), { judges: { jev } });
  const shadow = await kernel.decide('read.advice', input({ limits: { custom: 1 } }));
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.apply, false);
  assert.equal(shadow.skipped, false);
  assert.equal(shadow.cached, true);
  assert.equal(shadow.provider, 'jev');
  assert.deepEqual(shadow.response.answers, answers());
  assert.ok(Math.abs(shadow.confidence - 0.9) < 1e-9);
  assert.deepEqual(jev.calls[0].limits, { custom: 1, pointId: 'read.advice' });
  assert.equal(jev.calls[0].scope, 'session-1');
  assert.equal(jev.calls[0].state, STATE);
  const facade = await kernel.forPoint('read.advice').evaluate(STATE, QUESTIONS, 's');
  assert.equal(facade.apply, false);
  assert.equal(facade.mode, 'shadow');

  const active = await kernel.decide('failure.classify', input());
  assert.equal(active.mode, 'active');
  assert.equal(active.apply, true);
  assert.equal(active.trail.length, 1);
  assert.equal(active.trail[0].provider, 'jev');
  assert.equal(active.trail[0].ok, true);
});

test('chain falls back to the next judge on error', async () => {
  const jev = judge('jev-model', { error: fail('JEV_TIMEOUT') });
  const openai = judge('openai-model');
  const log = memoryLog();
  const kernel = new DecisionKernel(configWith({ 'read.advice': { judges: ['jev', 'openai'] } }), { judges: { jev, openai }, log });
  const d = await kernel.decide('read.advice', input());
  assert.equal(d.provider, 'openai');
  assert.equal(d.response.model, 'openai-model');
  assert.deepEqual(d.trail.map(s => [s.provider, s.ok, s.code]), [['jev', false, 'JEV_TIMEOUT'], ['openai', true, undefined]]);
  assert.ok(d.trail.every(s => typeof s.latencyMs === 'number'));
  assert.equal(log.records[0].provider, 'openai');
  assert.deepEqual(log.records[0].trail, d.trail);
});

test('all judges failing logs provider none and rethrows the last error', async () => {
  const last = fail('DECISIONS_HTTP_500');
  const untyped = new Error('boom with SENSITIVE_STATE_TEXT');
  const log = memoryLog();
  const kernel = new DecisionKernel(configWith({ 'read.advice': { judges: ['jev', 'openai'] } }),
    { judges: { jev: judge('a', { error: untyped }), openai: judge('b', { error: last }) }, log, now: () => 1234 });
  await assert.rejects(kernel.decide('read.advice', input({ subject: 'tool-1' })), e => e === last);
  assert.equal(log.records.length, 1);
  const r = log.records[0];
  assert.equal(r.provider, 'none');
  assert.equal(r.model, 'none');
  assert.deepEqual(r.answers, {});
  assert.equal(r.confidence, null);
  assert.equal(r.cached, false);
  assert.equal(r.time, 1234);
  assert.equal(r.subject, 'tool-1');
  assert.deepEqual(r.trail.map(s => [s.provider, s.ok, s.code]), [['jev', false, 'KERNEL_JUDGE_ERROR'], ['openai', false, 'DECISIONS_HTTP_500']]);
  assert.ok(!JSON.stringify(r).includes('SENSITIVE_STATE_TEXT'));
});

test('low confidence escalates to the next judge', async () => {
  const local = judge('local-model', { confidence: 0.55 });
  const jev = judge('jev-model', { confidence: 0.6 });
  const points = { 'read.advice': { judges: ['local', 'jev'], escalateBelow: 0.8 } };
  const kernel = new DecisionKernel(configWith(points), { judges: { local, jev } });
  const d = await kernel.decide('read.advice', input());
  // The last judge is accepted even below the threshold.
  assert.equal(d.provider, 'jev');
  assert.ok(Math.abs(d.confidence - 0.6) < 1e-9);
  assert.equal(d.trail.length, 2);
  assert.equal(d.trail[0].provider, 'local');
  assert.equal(d.trail[0].ok, true);
  assert.equal(d.trail[0].escalated, true);
  assert.ok(Math.abs(d.trail[0].confidence - 0.55) < 1e-9);
  assert.equal(d.trail[1].escalated, undefined);

  // A noul near 0.5 drags the minimum down even when choices are confident.
  const unsure = judge('local-model', { noul: 0.6, confidence: 0.99 });
  const k2 = new DecisionKernel(configWith(points), { judges: { local: unsure, jev } });
  assert.equal((await k2.decide('read.advice', input())).provider, 'jev');

  // A confident first judge stops the chain.
  const sure = judge('local-model', { confidence: 0.85, noul: 0.99 });
  const untouched = judge('jev-model');
  const k3 = new DecisionKernel(configWith(points), { judges: { local: sure, jev: untouched } });
  const accepted = await k3.decide('read.advice', input());
  assert.equal(accepted.provider, 'local');
  assert.equal(accepted.trail.length, 1);
  assert.equal(untouched.calls.length, 0);

  // Escalation followed by a failing judge fails closed with that judge's error.
  const k4 = new DecisionKernel(configWith(points), { judges: { local, jev: judge('x', { error: fail('JEV_CIRCUIT_OPEN') }) } });
  await assert.rejects(k4.decide('read.advice', input()), code('JEV_CIRCUIT_OPEN'));
});

test('a missing or broken provider counts as a failed judge', async () => {
  const jev = judge('jev-model');
  const kernel = new DecisionKernel(configWith({ 'read.advice': { judges: ['openai', 'local', 'jev'] } }),
    { judges: { jev, local: { notAJudge: true } } });
  const d = await kernel.decide('read.advice', input());
  assert.equal(d.provider, 'jev');
  assert.deepEqual(d.trail.map(s => [s.provider, s.code]), [['openai', 'KERNEL_JUDGE_UNAVAILABLE'], ['local', 'KERNEL_JUDGE_UNAVAILABLE'], ['jev', undefined]]);

  const alone = new DecisionKernel(configWith({ 'read.advice': { judges: ['openai'] } }), { judges: { jev } });
  await assert.rejects(alone.decide('read.advice', input()), code('KERNEL_JUDGE_UNAVAILABLE'));

  const malformed = new DecisionKernel({}, { judges: { jev: { async evaluate() { return { cached: false }; } } } });
  await assert.rejects(malformed.decide('read.advice', input()), code('KERNEL_INVALID_JUDGE_RESULT'));
});

test('timeoutMs is a total budget across the chain', async () => {
  const slow = judge('jev-model', { delayMs: 90, error: fail('JEV_TIMEOUT') });
  const local = judge('local-model');
  const log = memoryLog();
  const points = { 'read.advice': { judges: ['jev', 'local'] } };
  const kernel = new DecisionKernel(configWith(points), { judges: { jev: slow, local }, log });
  await assert.rejects(kernel.decide('read.advice', input({ limits: { timeoutMs: 120 } })), code('KERNEL_DEADLINE'));
  assert.equal(local.calls.length, 0);
  assert.ok(slow.calls[0].limits.timeoutMs <= 120 && slow.calls[0].limits.timeoutMs > 100);
  assert.equal(slow.calls[0].limits.pointId, 'read.advice');
  assert.deepEqual(log.records[0].trail.map(s => [s.provider, s.code]), [['jev', 'JEV_TIMEOUT'], ['local', 'KERNEL_DEADLINE']]);
  assert.equal(log.records[0].provider, 'none');

  // With enough budget the second judge gets only what is left.
  const quick = judge('jev-model', { delayMs: 30, error: fail('JEV_TIMEOUT') });
  const k2 = new DecisionKernel(configWith(points), { judges: { jev: quick, local } });
  const d = await k2.decide('read.advice', input({ limits: { timeoutMs: 2000 } }));
  assert.equal(d.provider, 'local');
  assert.ok(local.calls[0].limits.timeoutMs < 1980 && local.calls[0].limits.timeoutMs > 1000);

  // A budget already below the floor never reaches a judge.
  const never = judge('jev-model');
  const k3 = new DecisionKernel({}, { judges: { jev: never } });
  await assert.rejects(k3.decide('read.advice', input({ limits: { timeoutMs: 10 } })), code('KERNEL_DEADLINE'));
  assert.equal(never.calls.length, 0);

  // Without a budget no timeout is invented.
  await k3.decide('read.advice', input());
  assert.equal(Object.hasOwn(never.calls[0].limits, 'timeoutMs'), false);
});

test('judge factories are lazy and called once', async () => {
  let jevBuilt = 0;
  let openaiBuilt = 0;
  const jev = judge('jev-model');
  const kernel = new DecisionKernel({}, { judges: { jev: () => { jevBuilt++; return jev; }, openai: () => { openaiBuilt++; throw new Error('must not be built'); } } });
  assert.equal(jevBuilt, 0);
  await kernel.decide('read.advice', input());
  await kernel.decide('failure.classify', input());
  assert.equal(jevBuilt, 1);
  assert.equal(openaiBuilt, 0);
  assert.equal(jev.calls.length, 2);
});

test('createKernel wires jev, openai and local judges', async t => {
  const { config } = await fixture(t);
  const wire = questions => questions.map(q => ({ type: 'predicate', name: q.name, probability: 0.9 }));
  const s = await server(t, (req, res, parsed) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ model: 'decisions-fixture-not-live', answers: wire(parsed.questions) })); });
  config.allowLoopback = true;
  config.kernel = {
    providers: { openai: { endpoint: s.endpoint, approved: true } },
    points: { 'read.advice': { judges: ['local', 'openai'] }, 'failure.classify': { judges: ['local'] }, 'delegation.classify': { judges: ['openai', 'jev'] } },
  };
  const q = { safe: { type: 'noul', instructions: 'Safe?' } };
  const client = mockClient();
  const kernel = createKernel(config, {
    client, runtimeEnv: { OPENAI_API_KEY: 'unit-test-openai-credential' },
    localResolvers: { 'failure.classify': () => ({ safe: { type: 'noul', noul: 0 } }) },
  });
  const viaOpenai = await kernel.decide('read.advice', { state: { a: 1 }, questions: q, scope: 'session-1' });
  assert.equal(viaOpenai.provider, 'openai');
  assert.equal(viaOpenai.response.answers.safe.noul, 0.9);
  assert.deepEqual(viaOpenai.trail.map(x => [x.provider, x.code]), [['local', 'LOCAL_ABSTAIN'], ['openai', undefined]]);
  assert.equal(s.requests[0].authorization, 'Bearer unit-test-openai-credential');
  assert.equal(s.requests[0].body.model, 'gpt-6-luna');

  const viaLocal = await kernel.decide('failure.classify', { state: { a: 1 }, questions: q, scope: 'session-1' });
  assert.equal(viaLocal.provider, 'local');
  assert.equal(viaLocal.response.model, 'local-rules');
  assert.equal(viaLocal.confidence, 1);

  // Without a key the openai judge fails closed and the chain reaches the Jev client.
  const keyless = createKernel(config, { client });
  const fallback = await keyless.decide('delegation.classify', { state: { a: 2 }, questions: q, scope: 'session-1' });
  assert.equal(fallback.provider, 'jev');
  assert.deepEqual(fallback.trail.map(x => [x.provider, x.code]), [['openai', 'MISSING_OPENAI_API_KEY'], ['jev', undefined]]);
  assert.equal(client.count, 1);
  assert.equal(s.requests.length, 1);
});

test('createKernel builds a real JevClient lazily with the injected fetch', async t => {
  const { config } = await fixture(t);
  let calls = 0;
  const q = { safe: { type: 'noul', instructions: 'Safe?' } };
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ model: 'jev-fixture-not-live', answers: { safe: { type: 'noul', noul: 0.2 } } })); };
  const kernel = createKernel(config, { apiKey: 'unit-test-jev-credential', fetchImpl });
  const d = await kernel.decide('read.advice', { state: { a: 1 }, questions: q, scope: 'session-1' });
  assert.equal(d.provider, 'jev');
  assert.equal(d.response.answers.safe.noul, 0.2);
  assert.equal(calls, 1);
  const again = await kernel.decide('read.advice', { state: { a: 1 }, questions: q, scope: 'session-1' });
  assert.equal(again.cached, true);
  assert.equal(calls, 1);
});

test('decision log record follows the shared contract and carries no raw text', async () => {
  const log = memoryLog();
  const kernel = new DecisionKernel(configWith({ 'read.advice': { mode: 'shadow' } }),
    { judges: { jev: judge('jev-model', { cached: true, noul: 0.95, confidence: 0.8 }) }, log, now: () => 1700000000000 });
  const d = await kernel.decide('read.advice', input({ subject: 'tool-use-7' }));
  assert.equal(log.records.length, 1);
  const r = log.records[0];
  assert.deepEqual(Object.keys(r).sort(), ['answers', 'cached', 'confidence', 'decisionId', 'latencyMs', 'mode', 'model', 'pointId', 'provider',
    'questionsHash', 'schema', 'scope', 'stateHash', 'subject', 'time', 'trail']);
  assert.equal(r.schema, 1);
  assert.equal(r.decisionId, d.decisionId);
  assert.match(r.decisionId, /^[0-9a-f]{64}$/);
  assert.match(r.questionsHash, /^[0-9a-f]{64}$/);
  assert.match(r.stateHash, /^[0-9a-f]{64}$/);
  assert.notEqual(r.stateHash, r.questionsHash);
  assert.equal(r.time, 1700000000000);
  assert.equal(r.pointId, 'read.advice');
  assert.equal(r.mode, 'shadow');
  assert.equal(r.provider, 'jev');
  assert.equal(r.model, 'jev-model');
  assert.equal(r.cached, true);
  assert.equal(typeof r.latencyMs, 'number');
  assert.equal(r.scope, 'session-1');
  assert.equal(r.subject, 'tool-use-7');
  assert.ok(Math.abs(r.confidence - 0.8) < 1e-9);
  assert.deepEqual(r.answers.safe, { type: 'noul', p: 0.95 });
  assert.equal(r.answers.role.type, 'choice');
  assert.equal(r.answers.role.choice, 'implement');
  assert.deepEqual(Object.keys(r.answers.role).sort(), ['choice', 'confidence', 'p', 'type']);
  assert.deepEqual(Object.keys(r.answers.role.p), ['plan', 'implement']);
  assert.deepEqual(Object.keys(r.answers.quality).sort(), ['confidence', 'p', 'score', 'type']);
  assert.equal(r.answers.quality.score, 2);
  assert.deepEqual(Object.keys(r.answers.quality.p), ['0', '1', '2']);
  assert.equal(r.trail.length, 1);
  assert.equal(r.trail[0].provider, 'jev');
  assert.equal(r.trail[0].ok, true);
  const text = JSON.stringify(log.records);
  for (const marker of ['SENSITIVE_STATE_TEXT', 'SECRET_INSTRUCTION_TEXT', 'SECRET_CRITERIA_TEXT', 'toggle']) assert.ok(!text.includes(marker));

  // The id is deterministic in its inputs and changes with state, scope and time.
  const sameKernel = () => new DecisionKernel({}, { judges: { jev: judge('jev-model') }, now: () => 5 });
  const a = await sameKernel().decide('read.advice', input());
  const b = await sameKernel().decide('read.advice', input());
  const c = await sameKernel().decide('read.advice', input({ scope: 'session-2' }));
  const e = await sameKernel().decide('read.advice', input({ state: { task: 'other' } }));
  assert.equal(a.decisionId, b.decisionId);
  assert.notEqual(a.decisionId, c.decisionId);
  assert.notEqual(a.decisionId, e.decisionId);
});

test('logging is optional and its failures never change the result', async () => {
  const broken = { appended: 0, async append() { this.appended++; throw new Error('disk full'); } };
  const kernel = new DecisionKernel({}, { judges: { jev: judge('jev-model') }, log: broken });
  const d = await kernel.decide('read.advice', input());
  assert.equal(d.provider, 'jev');
  assert.equal(d.apply, true);
  assert.equal(broken.appended, 1);

  const failing = new DecisionKernel({}, { judges: { jev: judge('jev-model', { error: fail('JEV_HTTP_503') }) }, log: broken });
  await assert.rejects(failing.decide('read.advice', input()), code('JEV_HTTP_503'));
  assert.equal(broken.appended, 2);

  const sync = new DecisionKernel({}, { judges: { jev: judge('jev-model') }, log: { append() { throw new Error('sync failure'); } } });
  assert.equal((await sync.decide('read.advice', input())).provider, 'jev');

  // log:false and a missing log object both skip the append.
  const log = memoryLog();
  const muted = new DecisionKernel({ kernel: { log: false } }, { judges: { jev: judge('jev-model') }, log });
  await muted.decide('read.advice', input());
  assert.equal(log.records.length, 0);
  const bare = new DecisionKernel({}, { judges: { jev: judge('jev-model') } });
  assert.equal((await bare.decide('read.advice', input())).skipped, false);
  // Off points are never logged.
  const offLog = memoryLog();
  await new DecisionKernel({}, { judges: {}, log: offLog }).decide('delegation.skills', input());
  assert.equal(offLog.records.length, 0);
});
