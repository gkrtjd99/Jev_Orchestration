import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, server } from './helpers.mjs';
import { sleep } from '../src/util.mjs';
import { validateAnswers as jevValidateAnswers, JevClient } from '../src/jev.mjs';
import { validateAnswers, answerConfidence, minConfidence } from '../src/kernel/answers.mjs';
import { OpenAIDecisionsClient, LocalJudge, toWireQuestions, fromWireResponse } from '../src/kernel/judges.mjs';
import { mergeKernel, createKernel } from '../src/kernel/kernel.mjs';
import { performance } from 'node:perf_hooks';

const KEY = 'unit-test-openai-credential';
const QUESTIONS = {
  safe: { type: 'noul', instructions: 'Is the change safe?' },
  role: { type: 'choice', instructions: 'Pick a role.', criteria: { plan: 'Plan the work.', implement: null, review: 'Review it.' } },
  quality: { type: 'score', instructions: 'Rate quality.', criteria: ['bad', 'ok', 'great'] },
};
const code = expected => error => { assert.equal(error.code, expected); return true; };

/** Wire answers a well-behaved Decisions endpoint would return for the wire questions. */
function wireAnswers(questions) {
  return questions.map(q => {
    if (q.type === 'predicate') return { type: 'predicate', name: q.name, probability: 0.8 };
    if (q.type === 'choice') {
      const probabilities = q.choices.map((c, i) => ({ value: c.value, probability: i === 1 ? 0.7 : 0.3 / (q.choices.length - 1) }));
      return { type: 'choice', name: q.name, choice: q.choices[1].value, probabilities, confidence: 0.7 };
    }
    const probabilities = q.levels.map((l, i) => ({ value: i, label: l.label, probability: i === q.levels.length - 1 ? 0.6 : 0.4 / (q.levels.length - 1) }));
    return { type: 'score', name: q.name, score: q.levels.length - 1, probabilities, confidence: 0.6 };
  });
}
const wireBody = questions => ({
  model: 'decisions-fixture-not-live', answers: wireAnswers(questions),
  usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25, cached_tokens: 3 },
});
const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

async function setup(t, respond = null, openai = {}) {
  const f = await fixture(t);
  const s = await server(t, respond ?? ((req, res, parsed) => json(res, wireBody(parsed.questions))));
  f.config.allowLoopback = true;
  f.config.kernel = mergeKernel({ providers: { openai: { endpoint: s.endpoint, approved: true, ...openai } } });
  return { ...f, server: s, client: new OpenAIDecisionsClient(f.config, KEY) };
}

test('openai adapter translates all question types and a structured state', async t => {
  const { client, server: s, config } = await setup(t);
  const state = { task: 'Implement the toggle', features: ['a', 'b'] };
  const response = await client.request(state, QUESTIONS);
  assert.equal(s.requests.length, 1);
  const sent = s.requests[0];
  assert.equal(sent.url, '/v1/decisions');
  assert.equal(sent.authorization, `Bearer ${KEY}`);
  assert.deepEqual(sent.body, {
    model: config.kernel.providers.openai.model,
    input: [{ role: 'user', content: [{ type: 'input_json', data: state }] }],
    questions: [
      { type: 'predicate', name: 'safe', instructions: 'Is the change safe?' },
      { type: 'choice', name: 'role', instructions: 'Pick a role.',
        choices: [{ value: 'plan', description: 'Plan the work.' }, { value: 'implement' }, { value: 'review', description: 'Review it.' }] },
      { type: 'score', name: 'quality', instructions: 'Rate quality.',
        levels: [{ label: '0', description: 'bad' }, { label: '1', description: 'ok' }, { label: '2', description: 'great' }] },
    ],
  });
  assert.deepEqual(response, {
    model: 'decisions-fixture-not-live',
    answers: {
      safe: { type: 'noul', noul: 0.8 },
      role: { type: 'choice', choice: 'implement', confidence: 0.7, probabilities: { plan: 0.15, implement: 0.7, review: 0.15 } },
      quality: { type: 'score', score: 2, confidence: 0.6, probabilities: { 0: 0.2, 1: 0.2, 2: 0.6 } },
    },
    usage: { input_tokens: 21, output_tokens: 4 },
  });
});

test('openai adapter sends a string state as-is and tolerates missing usage', async t => {
  const { client, server: s } = await setup(t, (req, res, parsed) => json(res, { model: 'm', answers: wireAnswers(parsed.questions) }));
  const response = await client.request('plain text state', { safe: QUESTIONS.safe });
  assert.equal(s.requests[0].body.input, 'plain text state');
  assert.deepEqual(response.usage, { input_tokens: 0, output_tokens: 0 });
});

test('question translation rejects unsupported shapes', () => {
  const bad = q => assert.throws(() => toWireQuestions(q), code('DECISIONS_UNSUPPORTED_QUESTION'));
  bad({});
  bad({ a: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } });
  bad({ a: { type: 'score', instructions: 'x', criteria: ['one'] } });
  bad({ a: { type: 'score', instructions: 'x', criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) } });
  bad({ a: { type: 'essay', instructions: 'x' } });
  bad({ a: { type: 'noul' } });
  bad(Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`q${i}`, QUESTIONS.safe])));
  assert.equal(toWireQuestions(Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`q${i}`, QUESTIONS.safe]))).length, 400);
});

test('response translation checks order, names, types and envelope', () => {
  const wire = toWireQuestions(QUESTIONS);
  const good = wireBody(wire);
  assert.equal(fromWireResponse(good, QUESTIONS).answers.safe.noul, 0.8);
  const bad = (body, expected = 'INVALID_DECISIONS_ENVELOPE') => assert.throws(() => fromWireResponse(body, QUESTIONS), code(expected));
  bad(null);
  bad({ answers: good.answers });
  bad({ model: 'm', answers: {} });
  bad({ model: 'm', answers: good.answers.slice(0, 2) });
  bad({ model: 'm', answers: [...good.answers, good.answers[0]] });
  bad({ model: 'm', answers: [good.answers[1], good.answers[0], good.answers[2]] });
  bad({ model: 'm', answers: [{ ...good.answers[0], name: 'other' }, good.answers[1], good.answers[2]] });
  bad({ model: 'm', answers: [{ type: 'predicate', probability: 0.5 }, good.answers[1], good.answers[2]] });
  bad({ model: 'm', answers: [{ ...good.answers[1], name: 'safe' }, good.answers[1], good.answers[2]] });
  bad({ model: 'm', answers: [good.answers[0], { ...good.answers[1], probabilities: { plan: 1 } }, good.answers[2]] });
  bad({ model: 'm', answers: [good.answers[0], { ...good.answers[1], probabilities: [{ value: 'plan', probability: 0.5 }, { value: 'plan', probability: 0.5 }] }, good.answers[2]] });
  bad({ model: 'm', answers: [good.answers[0], 'nope', good.answers[2]] });
  bad({ model: 'm', answers: [good.answers[0], good.answers[1], { type: 'refusal', name: 'quality' }] }, 'DECISIONS_REFUSAL');
});

test('score distributions are keyed by the adapter-controlled label, not the wire value', () => {
  const q = { quality: QUESTIONS.quality };
  const body = (score, items) => ({ model: 'm', answers: [{ type: 'score', name: 'quality', score, confidence: 0.6, probabilities: items }] });
  const expected = { type: 'score', score: 2, confidence: 0.6, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } };
  const ps = [0.1, 0.3, 0.6];
  const items = value => ps.map((probability, i) => ({ value: value(i), label: String(i), probability }));

  // 1-based values: the labels still address levels 0..2 and the score moves onto the same scale.
  const oneBased = validateAnswers(fromWireResponse(body(3, items(i => i + 1)), q), q);
  assert.deepEqual(oneBased.answers.quality, expected);
  const fractional = fromWireResponse(body(2.5, items(i => i + 1)), q).answers.quality;
  assert.equal(fractional.score, 1.5);
  // 0-based numbers, numeric strings, and labels without any value all normalize identically.
  for (const value of [i => i, i => String(i), () => undefined]) {
    assert.deepEqual(validateAnswers(fromWireResponse(body(2, items(value)), q), q).answers.quality, expected);
  }
  // No labels at all: values are the keys, as before.
  const bare = ps.map((probability, i) => ({ value: i, probability }));
  assert.deepEqual(validateAnswers(fromWireResponse(body(2, bare), q), q).answers.quality, expected);

  // Anything that cannot be mapped by one constant offset fails closed instead of being guessed.
  const bad = [
    items(i => i * 2),                                             // not a constant offset
    items(i => ['low', 'mid', 'high'][i]),                         // non-numeric values
    ps.map((probability, i) => ({ value: i, label: 'x' + i, probability })), // labels the adapter never sent
    [...items(i => i).slice(0, 2), { value: 2, label: '1', probability: 0.6 }], // duplicate label
    [{ value: 0, label: '0', probability: 0.4 }, { value: 1, probability: 0.6 }], // mixed
  ];
  for (const list of bad) assert.throws(() => fromWireResponse(body(2, list), q), code('INVALID_DECISIONS_ENVELOPE'));
  // A level the question does not have is still rejected by the shared validation.
  const extra = [...items(i => i), { value: 3, label: '3', probability: 0 }];
  assert.throws(() => validateAnswers(fromWireResponse(body(2, extra), q), q), code('INVALID_JEV_SCORE'));
});

test('skills and supervisor judgments use their own request cap and circuit', async t => {
  const f = await fixture(t);
  const s = await server(t);
  f.config.endpoint = s.endpoint;
  f.config.allowLoopback = true;
  f.config.circuit.maxRequestsPerSession = 2;
  const jev = new JevClient(f.config, 'fixture-key');
  const noul = { q: { type: 'noul', instructions: 'yes?' } };
  let n = 0;
  const ask = pointId => jev.evaluate({ task: n++ }, noul, 'one-session', pointId ? { pointId } : {});

  // Opt-in points spend their own budget ...
  await ask('delegation.skills');
  await ask('supervisor.outcome');
  await assert.rejects(ask('delegation.skills'), code('JEV_REQUEST_CAP'));
  await assert.rejects(ask('supervisor.outcome'), code('JEV_REQUEST_CAP'));
  // ... so routing still has all of its own, shared by every routing point and by plain callers.
  await ask('delegation.classify');
  await ask(null);
  for (const pointId of ['delegation.classify', 'delegation.profile', 'failure.classify', 'read.advice', null]) {
    await assert.rejects(ask(pointId), code('JEV_REQUEST_CAP'));
  }
  assert.equal(s.requests.length, 4);

  // A failing auxiliary point opens only its own circuit.
  const g = await fixture(t);
  let fail = true;
  const flaky = await server(t, (req, res, parsed) => {
    if (fail) { res.writeHead(503); res.end(); return; }
    json(res, { model: 'm', answers: { q: { type: 'noul', noul: 0.5 } } });
  });
  g.config.endpoint = flaky.endpoint;
  g.config.allowLoopback = true;
  g.config.circuit.failureThreshold = 2;
  const other = new JevClient(g.config, 'fixture-key');
  const again = pointId => other.evaluate({ task: n++ }, noul, 'one-session', { pointId });
  for (let i = 0; i < 2; i++) await assert.rejects(again('delegation.skills'), code('JEV_HTTP_503'));
  await assert.rejects(again('supervisor.outcome'), code('JEV_CIRCUIT_OPEN'));
  fail = false;
  assert.equal((await again('delegation.classify')).response.answers.q.noul, 0.5);
});

test('openai adapter fails closed on refusal, bad envelopes and invalid distributions', async t => {
  let body;
  const { client } = await setup(t, (req, res, parsed) => (typeof body === 'string' ? res.end(body) : json(res, body(parsed.questions))));
  const q = { safe: QUESTIONS.safe, role: QUESTIONS.role };

  body = questions => ({ model: 'm', answers: [wireAnswers(questions)[0], { type: 'refusal', name: 'role' }] });
  await assert.rejects(client.request({ n: 1 }, q), code('DECISIONS_REFUSAL'));

  body = questions => ({ model: 'm', answers: wireAnswers(questions).reverse() });
  await assert.rejects(client.request({ n: 2 }, q), code('INVALID_DECISIONS_ENVELOPE'));

  body = 'not json';
  await assert.rejects(client.request({ n: 3 }, q), code('INVALID_DECISIONS_ENVELOPE'));

  body = questions => { const a = wireAnswers(questions); a[0].probability = 1.5; return { model: 'm', answers: a }; };
  await assert.rejects(client.request({ n: 4 }, q), code('INVALID_JEV_NOUL'));

  body = questions => { const a = wireAnswers(questions); a[1].probabilities[0].probability = 0.9; return { model: 'm', answers: a }; };
  await assert.rejects(client.request({ n: 5 }, q), code('INVALID_JEV_DISTRIBUTION'));

  body = questions => { const a = wireAnswers(questions); a[1].choice = 'invented'; return { model: 'm', answers: a }; };
  await assert.rejects(client.request({ n: 6 }, q), code('UNKNOWN_JEV_CHOICE'));
});

test('openai adapter reports HTTP errors and timeouts with typed codes', async t => {
  const http = await setup(t, (req, res) => json(res, { error: 'rate limited' }, 429));
  await assert.rejects(http.client.request({ a: 1 }, { safe: QUESTIONS.safe }), code('DECISIONS_HTTP_429'));

  const slow = await setup(t, async (req, res, parsed) => { await sleep(400); json(res, wireBody(parsed.questions)); });
  const started = Date.now();
  await assert.rejects(slow.client.request({ a: 1 }, { safe: QUESTIONS.safe }, { timeoutMs: 60 }), code('DECISIONS_TIMEOUT'));
  assert.ok(Date.now() - started < 350);
});

// ---------------------------------------------------------------- per-provider timeout (loopback server, no live API)

const delayed = ms => async (req, res, parsed) => { await sleep(ms); json(res, wireBody(parsed.questions)); };

test('openai adapter uses its own provider timeout instead of the Jev-tuned global one', async t => {
  // Global timeout far below the response time: before the per-provider timeout this request timed out.
  const cold = await setup(t, delayed(300), { timeoutMs: 1500 });
  cold.config.timeoutMs = 100;
  const response = await cold.client.request({ a: 1 }, { safe: QUESTIONS.safe });
  assert.equal(response.answers.safe.noul, 0.8);
  const viaEvaluate = await cold.client.evaluate({ a: 2 }, { safe: QUESTIONS.safe }, 'scope-timeout');
  assert.equal(viaEvaluate.cached, false);
  assert.equal(cold.server.requests.length, 2); // one request per call: no warm-up, no retry

  // And the other way round: a generous global timeout does not extend a short provider timeout.
  const strict = await setup(t, delayed(600), { timeoutMs: 120 });
  strict.config.timeoutMs = 5000;
  const began = performance.now();
  await assert.rejects(strict.client.request({ a: 1 }, { safe: QUESTIONS.safe }), code('DECISIONS_TIMEOUT'));
  await assert.rejects(strict.client.evaluate({ a: 2 }, { safe: QUESTIONS.safe }, 'scope-timeout'), code('DECISIONS_TIMEOUT'));
  assert.ok(performance.now() - began < 550, 'both calls must stop at the 120 ms provider timeout');
  assert.equal(strict.server.requests.length, 2); // a timed-out call is not retried

  // The default applies when the config carries none, and the Jev client is unaffected by the OpenAI value.
  const plain = await setup(t);
  assert.equal(plain.config.kernel.providers.openai.timeoutMs, 2500);
  assert.equal(plain.client.timeoutMs, 2500);
  assert.equal(plain.client.config.timeoutMs, plain.config.timeoutMs);
});

test('the caller budget and deadline still win over a longer provider timeout', async t => {
  const { client, server: s } = await setup(t, delayed(600), { timeoutMs: 5000 });
  let began = performance.now();
  await assert.rejects(client.request({ a: 1 }, { safe: QUESTIONS.safe }, { timeoutMs: 100 }), code('DECISIONS_TIMEOUT'));
  assert.ok(performance.now() - began < 450);
  began = performance.now();
  await assert.rejects(client.evaluate({ a: 2 }, { safe: QUESTIONS.safe }, 'scope-budget', { timeoutMs: 100 }), code('DECISIONS_TIMEOUT'));
  assert.ok(performance.now() - began < 450);
  assert.equal(s.requests.length, 2);

  // A deadline that already passed (for example after waiting on a lock) sends nothing at all.
  await assert.rejects(client.request({ a: 3 }, { safe: QUESTIONS.safe }, { deadlineAt: performance.now() - 1 }), code('DECISIONS_TIMEOUT'));
  await assert.rejects(client.request({ a: 3 }, { safe: QUESTIONS.safe }, { timeoutMs: 0 }), code('DECISIONS_TIMEOUT'));
  assert.equal(s.requests.length, 2);
});

test('a kernel chain gives openai its provider timeout but never more than the remaining chain budget', async t => {
  const f = await fixture(t);
  const s = await server(t, delayed(350));
  f.config.allowLoopback = true;
  f.config.timeoutMs = 100; // Jev-tuned global, deliberately shorter than the OpenAI response
  f.config.kernel = mergeKernel({
    log: false,
    providers: { openai: { endpoint: s.endpoint, approved: true, timeoutMs: 2000 } },
    points: { 'read.advice': { judges: ['openai'] }, 'failure.classify': { judges: ['jev', 'openai'] } },
  });
  const questions = { safe: QUESTIONS.safe };
  const jev = { calls: [], async evaluate(state, q, scope, limits) { this.calls.push(limits); await sleep(60); throw Object.assign(new Error('JEV_TIMEOUT'), { code: 'JEV_TIMEOUT' }); } };
  const kernel = createKernel(f.config, { client: jev, runtimeEnv: { OPENAI_API_KEY: KEY } });

  // No explicit limit: the chain budget is the provider timeout (2000), so a 350 ms response succeeds.
  const slowOk = await kernel.decide('read.advice', { state: { n: 1 }, questions, scope: 'chain' });
  assert.equal(slowOk.provider, 'openai');
  assert.ok(slowOk.latencyMs >= 300);

  // After a failed first judge, openai still answers inside the same single budget.
  const second = await kernel.decide('failure.classify', { state: { n: 2 }, questions, scope: 'chain' });
  assert.equal(second.provider, 'openai');
  assert.deepEqual(second.trail.map(x => [x.provider, x.ok]), [['jev', false], ['openai', true]]);
  assert.ok(jev.calls[0].timeoutMs <= 2000 && jev.calls[0].timeoutMs > 1900);

  // An explicit chain budget below the response time wins over the 2000 ms provider timeout.
  const began = performance.now();
  await assert.rejects(kernel.decide('read.advice', { state: { n: 3 }, questions, scope: 'chain', limits: { timeoutMs: 150 } }), code('DECISIONS_TIMEOUT'));
  assert.ok(performance.now() - began < 330, 'stopped by the 150 ms chain budget, before the 350 ms response');

  // The chain budget is shared: 60 ms spent by the first judge leaves openai less than its response needs.
  const shared = performance.now();
  await assert.rejects(kernel.decide('failure.classify', { state: { n: 4 }, questions, scope: 'chain', limits: { timeoutMs: 300 } }), code('DECISIONS_TIMEOUT'));
  assert.ok(performance.now() - shared < 420);
  assert.equal(s.requests.length, 4); // exactly one request per decision that reached openai
});

test('openai adapter caps request and response sizes', async t => {
  const { client, server: s } = await setup(t, (req, res) => json(res, { model: 'm', answers: [], padding: 'x'.repeat(300000) }));
  await assert.rejects(client.request('x'.repeat(530000), { safe: QUESTIONS.safe }), code('DECISIONS_REQUEST_TOO_LARGE'));
  assert.equal(s.requests.length, 0);
  await assert.rejects(client.request('small', { safe: QUESTIONS.safe }), code('DECISIONS_RESPONSE_TOO_LARGE'));
  assert.equal(s.requests.length, 1);
});

test('openai adapter gates egress, approval, key, endpoint and secrets before any request', async t => {
  const { config, server: s } = await setup(t);
  const q = { safe: QUESTIONS.safe };
  const variant = (change, key = KEY) => {
    const c = structuredClone(config);
    change(c);
    return new OpenAIDecisionsClient(c, key);
  };
  await assert.rejects(variant(c => { c.safety.allowEgress = false; }).request({ a: 1 }, q), code('EGRESS_NOT_APPROVED'));
  await assert.rejects(variant(c => { c.kernel.providers.openai.approved = false; }).request({ a: 1 }, q), code('OPENAI_DECISIONS_NOT_APPROVED'));
  await assert.rejects(variant(c => { c.kernel.providers.openai.approved = 'true'; }).request({ a: 1 }, q), code('OPENAI_DECISIONS_NOT_APPROVED'));
  await assert.rejects(variant(() => {}, '').request({ a: 1 }, q), code('MISSING_OPENAI_API_KEY'));
  await assert.rejects(variant(c => { c.allowLoopback = false; }).request({ a: 1 }, q), code('OPENAI_ENDPOINT_NOT_APPROVED'));
  for (const endpoint of ['https://api.openai.com/', 'https://api.openai.com.evil.example', 'http://api.openai.com',
    'https://example.com', s.endpoint + '/proxy', 'http://10.0.0.1:8080', 'not a url']) {
    await assert.rejects(variant(c => { c.kernel.providers.openai.endpoint = endpoint; }).request({ a: 1 }, q), code('OPENAI_ENDPOINT_NOT_APPROVED'));
  }
  const client = variant(() => {});
  await assert.rejects(client.request({ note: `token ${KEY}` }, q), code('SECRET_GUARD'));
  await assert.rejects(client.request({ note: 'password=hunter2hunter2' }, q), code('SECRET_GUARD'));
  await assert.rejects(client.request('-----BEGIN PRIVATE KEY-----', q), code('SECRET_GUARD'));
  assert.equal(s.requests.length, 0);
  assert.throws(() => new OpenAIDecisionsClient({ ...config, kernel: undefined }, KEY), code('OPENAI_DECISIONS_NOT_CONFIGURED'));
});

test('openai adapter accepts the production origin with an injected fetch', async t => {
  const { config } = await fixture(t);
  config.kernel = mergeKernel({ providers: { openai: { approved: true } } });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(wireBody(JSON.parse(init.body).questions)), { status: 200 });
  };
  const client = new OpenAIDecisionsClient(config, KEY, { fetchImpl });
  const response = await client.request({ a: 1 }, { safe: QUESTIONS.safe });
  assert.equal(response.answers.safe.noul, 0.8);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/decisions');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('openai adapter reuses the JevClient cache through evaluate', async t => {
  const { client, server: s } = await setup(t);
  const first = await client.evaluate({ task: 'cache me' }, QUESTIONS, 'session-a');
  const second = await client.evaluate({ task: 'cache me' }, QUESTIONS, 'session-a');
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.deepEqual(second.response, first.response);
  assert.equal(s.requests.length, 1);
  assert.equal(typeof first.latencyMs, 'number');
  await client.evaluate({ task: 'different' }, QUESTIONS, 'session-a');
  assert.equal(s.requests.length, 2);
});

test('LocalJudge answers from resolvers and abstains otherwise', async () => {
  const q = { safe: QUESTIONS.safe };
  const seen = [];
  const judge = new LocalJudge({
    'failure.classify': (state, questions) => { seen.push([state, Object.keys(questions)]); return { safe: { type: 'noul', noul: 1 } }; },
    'read.advice': () => null,
    'delegation.skills': () => undefined,
    'delegation.profile': () => ({ safe: { type: 'noul', noul: 2 } }),
    'supervisor.outcome': async () => ({ safe: { type: 'noul', noul: 0 } }),
  });
  const result = await judge.evaluate({ s: 1 }, q, 'scope', { pointId: 'failure.classify' });
  assert.deepEqual(result.response, { model: 'local-rules', answers: { safe: { type: 'noul', noul: 1 } }, usage: { input_tokens: 0, output_tokens: 0 } });
  assert.equal(result.cached, false);
  assert.ok(result.latencyMs >= 0);
  assert.deepEqual(seen, [[{ s: 1 }, ['safe']]]);
  assert.equal((await judge.evaluate({}, q, 'scope', { pointId: 'supervisor.outcome' })).response.answers.safe.noul, 0);
  for (const pointId of ['read.advice', 'delegation.skills', 'delegation.classify', 'constructor', undefined]) {
    await assert.rejects(judge.evaluate({}, q, 'scope', { pointId }), code('LOCAL_ABSTAIN'));
  }
  await assert.rejects(judge.evaluate({}, q, 'scope'), code('LOCAL_ABSTAIN'));
  await assert.rejects(new LocalJudge().evaluate({}, q, 'scope', { pointId: 'failure.classify' }), code('LOCAL_ABSTAIN'));
  await assert.rejects(judge.evaluate({}, q, 'scope', { pointId: 'delegation.profile' }), code('INVALID_JEV_NOUL'));
});

test('validateAnswers is shared with jev.mjs and keeps choice and noul codes', () => {
  assert.equal(jevValidateAnswers, validateAnswers);
  const q = { safe: QUESTIONS.safe, role: QUESTIONS.role };
  const good = () => ({ model: 'm', answers: {
    safe: { type: 'noul', noul: 0.25 },
    role: { type: 'choice', choice: 'plan', confidence: 0.9, probabilities: { plan: 0.9, implement: 0.05, review: 0.05 } },
  } });
  assert.equal(validateAnswers(good(), q).answers.role.choice, 'plan');
  const bad = (change, expected) => { const r = good(); change(r); assert.throws(() => validateAnswers(r, q), code(expected)); };
  assert.throws(() => validateAnswers({ answers: {} }, q), code('INVALID_JEV_ENVELOPE'));
  bad(r => { delete r.answers.safe; }, 'INVALID_JEV_ANSWER_TYPE');
  bad(r => { r.answers.safe.noul = Number.NaN; }, 'INVALID_JEV_NOUL');
  bad(r => { r.answers.role.confidence = 2; }, 'INVALID_JEV_CHOICE');
  bad(r => { r.answers.role.choice = 'other'; }, 'UNKNOWN_JEV_CHOICE');
  bad(r => { delete r.answers.role.probabilities.review; }, 'INVALID_JEV_PROBABILITIES');
  bad(r => { r.answers.role.probabilities.review = 0.5; }, 'INVALID_JEV_DISTRIBUTION');
  bad(r => { r.answers.role.choice = 'review'; }, 'CHOICE_DISTRIBUTION_MISMATCH');
  assert.throws(() => validateAnswers({ model: 'm', answers: { x: { type: 'essay' } } }, { x: { type: 'essay' } }), code('INVALID_JEV_CHOICE'));
});

test('score validation edge cases', () => {
  const q = { quality: QUESTIONS.quality };
  const good = () => ({ model: 'm', answers: { quality: { type: 'score', score: 1.5, confidence: 0.5, probabilities: { 0: 0.1, 1: 0.4, 2: 0.5 }, legend: ['bad', 'ok', 'great'] } } });
  assert.equal(validateAnswers(good(), q).answers.quality.score, 1.5);
  const bad = (change, questions = q) => { const r = good(); change(r); assert.throws(() => validateAnswers(r, questions), code('INVALID_JEV_SCORE')); };
  bad(r => { r.answers.quality.score = -0.1; });
  bad(r => { r.answers.quality.score = 2.01; });
  bad(r => { r.answers.quality.score = '1'; });
  bad(r => { r.answers.quality.score = Infinity; });
  bad(r => { r.answers.quality.confidence = 1.1; });
  bad(r => { delete r.answers.quality.confidence; });
  bad(r => { r.answers.quality.probabilities = [0.1, 0.4, 0.5]; });
  bad(r => { delete r.answers.quality.probabilities[2]; });
  bad(r => { r.answers.quality.probabilities[3] = 0; });
  bad(r => { r.answers.quality.probabilities = { 0: 0.1, 1: 0.4, great: 0.5 }; });
  bad(r => { r.answers.quality.probabilities[2] = 0.6; });
  bad(r => { r.answers.quality.probabilities[0] = -0.1; r.answers.quality.probabilities[1] = 0.6; });
  bad(() => {}, { quality: { type: 'score', instructions: 'x', criteria: ['only'] } });
  bad(() => {}, { quality: { type: 'score', instructions: 'x', criteria: { 0: 'a', 1: 'b', 2: 'c' } } });
  bad(() => {}, { quality: { type: 'score', instructions: 'x', criteria: Array.from({ length: 11 }, () => 'l') } });
  const r = good();
  r.answers.quality.type = 'choice';
  assert.throws(() => validateAnswers(r, q), code('INVALID_JEV_ANSWER_TYPE'));
  // Boundary scores and the summation tolerance are accepted.
  const edge = good();
  edge.answers.quality.score = 2;
  edge.answers.quality.probabilities = { 0: 0.1004, 1: 0.4, 2: 0.5 };
  assert.equal(validateAnswers(edge, q), edge);
});

test('answerConfidence and minConfidence', () => {
  assert.equal(answerConfidence({ type: 'choice', confidence: 0.7 }), 0.7);
  assert.equal(answerConfidence({ type: 'score', confidence: 0.4 }), 0.4);
  assert.equal(answerConfidence({ type: 'noul', noul: 0.5 }), 0);
  assert.equal(answerConfidence({ type: 'noul', noul: 1 }), 1);
  assert.ok(Math.abs(answerConfidence({ type: 'noul', noul: 0.1 }) - 0.8) < 1e-12);
  assert.equal(answerConfidence({ type: 'unknown' }), 0);
  assert.equal(minConfidence({}), null);
  assert.equal(minConfidence(undefined), null);
  assert.equal(minConfidence({ a: { type: 'choice', confidence: 0.9 }, b: { type: 'noul', noul: 0.75 }, c: { type: 'score', confidence: 0.6 } }), 0.5);
});
