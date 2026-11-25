/** Judges behind the decision kernel: OpenAI Decisions adapter and local rules. */
import { performance } from 'node:perf_hooks';
import { assert, object } from '../util.mjs';
import { secretLike } from '../safety.mjs';
import { JevClient } from '../jev.mjs';
import { validateAnswers } from './answers.mjs';

const OPENAI_ORIGIN = 'https://api.openai.com';
const MAX_REQUEST_BYTES = 524288;
const MAX_RESPONSE_BYTES = 262144;
/**
 * Per-provider request timeout for the OpenAI Decisions judge (kernel.providers.openai.timeoutMs).
 *
 * The global config.timeoutMs (1200 ms) is tuned for Jev. In the one live observation we have, a cold
 * first OpenAI request exceeded 1200 ms (its real duration was not captured) while later requests took
 * 280-580 ms. 2500 ms is roughly twice the limit the cold call broke and more than four times the
 * slowest warm call, and it still leaves 500 ms of the default 3000 ms route deadline for profile
 * selection (which needs 100 ms). It is an initial value, not a measured percentile.
 *
 * The bounds equal those of config.timeoutMs (50..5000). The upper bound matters: a single chain can
 * never be granted more than 5000 ms, which stays below the 7000 ms watchdog in bin/jev-hook.mjs.
 * This is only a ceiling for one request: the caller's remaining chain budget still wins when smaller,
 * and there is no retry and no warm-up request.
 */
export const OPENAI_TIMEOUT_DEFAULT_MS = 2500;
export const OPENAI_TIMEOUT_MIN_MS = 50;
export const OPENAI_TIMEOUT_MAX_MS = 5000;

function fail(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

function endpointApproved(endpoint, allowLoopback) {
  if (endpoint === OPENAI_ORIGIN) return true;
  if (allowLoopback !== true || typeof endpoint !== 'string') return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && endpoint === u.origin;
}

/** Normalized question map -> ordered wire questions; the question id becomes the wire name. */
export function toWireQuestions(questions) {
  assert(object(questions), 'DECISIONS_UNSUPPORTED_QUESTION');
  const ids = Object.keys(questions);
  assert(ids.length >= 1 && ids.length <= 400, 'DECISIONS_UNSUPPORTED_QUESTION');
  return ids.map(name => {
    const q = questions[name];
    assert(object(q) && typeof q.instructions === 'string', 'DECISIONS_UNSUPPORTED_QUESTION');
    const { instructions } = q;
    if (q.type === 'noul') return { type: 'predicate', name, instructions };
    if (q.type === 'choice') {
      assert(object(q.criteria), 'DECISIONS_UNSUPPORTED_QUESTION');
      const options = Object.entries(q.criteria);
      assert(options.length >= 2 && options.length <= 255, 'DECISIONS_UNSUPPORTED_QUESTION');
      const choices = options.map(([value, description]) => (description == null ? { value } : { value, description: String(description) }));
      return { type: 'choice', name, instructions, choices };
    }
    if (q.type === 'score') {
      assert(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10, 'DECISIONS_UNSUPPORTED_QUESTION');
      const levels = q.criteria.map((description, i) => ({ label: String(i), description: String(description) }));
      return { type: 'score', name, instructions, levels };
    }
    throw fail('DECISIONS_UNSUPPORTED_QUESTION');
  });
}

function distribution(list) {
  assert(Array.isArray(list), 'INVALID_DECISIONS_ENVELOPE');
  const out = {};
  for (const item of list) {
    assert(object(item) && ['string', 'number'].includes(typeof item.value), 'INVALID_DECISIONS_ENVELOPE');
    const key = String(item.value);
    assert(!Object.hasOwn(out, key), 'INVALID_DECISIONS_ENVELOPE');
    out[key] = item.probability;
  }
  return out;
}

/**
 * Score answers are keyed by `label`: the adapter sends the labels '0'..'n-1' itself, so they are the
 * only field guaranteed to match the normalized scale. `value` is trusted only as far as it can be
 * mapped onto that scale by one constant offset (for example 1-based levels); anything else fails closed.
 */
function scoreAnswer(a) {
  assert(Array.isArray(a.probabilities), 'INVALID_DECISIONS_ENVELOPE');
  if (!a.probabilities.some(item => object(item) && item.label !== undefined)) {
    return { type: 'score', score: a.score, confidence: a.confidence, probabilities: distribution(a.probabilities) };
  }
  const probabilities = {};
  let offset = null;
  for (const item of a.probabilities) {
    assert(object(item) && typeof item.label === 'string' && /^\d$/.test(item.label), 'INVALID_DECISIONS_ENVELOPE');
    assert(!Object.hasOwn(probabilities, item.label), 'INVALID_DECISIONS_ENVELOPE');
    probabilities[item.label] = item.probability;
    if (item.value === undefined) continue;
    const value = typeof item.value === 'string' && item.value.trim() !== '' ? Number(item.value) : item.value;
    assert(typeof value === 'number' && Number.isFinite(value), 'INVALID_DECISIONS_ENVELOPE');
    const delta = value - Number(item.label);
    assert(offset === null || Math.abs(delta - offset) < 1e-9, 'INVALID_DECISIONS_ENVELOPE');
    offset = delta;
  }
  const score = typeof a.score === 'number' && offset ? a.score - offset : a.score;
  return { type: 'score', score, confidence: a.confidence, probabilities };
}

/** Wire response -> normalized {model, answers, usage}; answers are positional and must echo the name. */
export function fromWireResponse(body, questions) {
  const ids = Object.keys(questions);
  assert(object(body) && typeof body.model === 'string' && Array.isArray(body.answers), 'INVALID_DECISIONS_ENVELOPE');
  assert(body.answers.every(object), 'INVALID_DECISIONS_ENVELOPE');
  assert(!body.answers.some(a => a.type === 'refusal'), 'DECISIONS_REFUSAL');
  assert(body.answers.length === ids.length, 'INVALID_DECISIONS_ENVELOPE');
  const answers = {};
  ids.forEach((id, i) => {
    const a = body.answers[i];
    assert(a.name === id, 'INVALID_DECISIONS_ENVELOPE');
    const expected = questions[id].type;
    if (a.type === 'predicate' && expected === 'noul') {
      answers[id] = { type: 'noul', noul: a.probability };
    } else if (a.type === 'choice' && expected === 'choice') {
      answers[id] = { type: 'choice', choice: a.choice, confidence: a.confidence, probabilities: distribution(a.probabilities) };
    } else if (a.type === 'score' && expected === 'score') {
      answers[id] = scoreAnswer(a);
    } else {
      throw fail('INVALID_DECISIONS_ENVELOPE');
    }
  });
  const count = x => (Number.isFinite(x) && x >= 0 ? x : 0);
  const usage = { input_tokens: count(body.usage?.input_tokens), output_tokens: count(body.usage?.output_tokens) };
  return { model: body.model, answers, usage };
}

export class OpenAIDecisionsClient extends JevClient {
  constructor(config, apiKey, options = {}) {
    const openai = config?.kernel?.providers?.openai;
    assert(object(openai) && typeof openai.endpoint === 'string' && typeof openai.model === 'string', 'OPENAI_DECISIONS_NOT_CONFIGURED');
    // The derived endpoint/model keep cache keys and circuit state separate from the Jev client.
    super({ ...config, endpoint: openai.endpoint, model: openai.model }, apiKey, options);
  }

  /** The provider's own request ceiling; a config built without mergeKernel falls back to the default. */
  get timeoutMs() {
    const t = this.config.kernel.providers.openai.timeoutMs;
    return Number.isInteger(t) && t >= OPENAI_TIMEOUT_MIN_MS && t <= OPENAI_TIMEOUT_MAX_MS ? t : OPENAI_TIMEOUT_DEFAULT_MS;
  }

  /**
   * Same cache, request cap and circuit as JevClient, plus one absolute deadline for the whole call:
   * time spent waiting on the cache or request-control locks is taken out of the request's allowance,
   * so the judge as a whole never outlives min(provider timeout, caller's remaining chain budget).
   */
  async evaluate(state, questions, scope, limits = {}) {
    const allowance = Number.isFinite(limits.timeoutMs) ? Math.min(this.timeoutMs, limits.timeoutMs) : this.timeoutMs;
    return super.evaluate(state, questions, scope, { ...limits, deadlineAt: performance.now() + allowance });
  }

  async request(state, questions, { timeoutMs = this.timeoutMs, deadlineAt = Infinity } = {}) {
    const c = this.config;
    const openai = c.kernel.providers.openai;
    assert(c.safety?.allowEgress === true, 'EGRESS_NOT_APPROVED');
    assert(openai.approved === true, 'OPENAI_DECISIONS_NOT_APPROVED');
    assert(typeof this.key === 'string' && this.key.length > 0, 'MISSING_OPENAI_API_KEY');
    assert(endpointApproved(c.endpoint, c.allowLoopback), 'OPENAI_ENDPOINT_NOT_APPROVED');
    assert(!secretLike(JSON.stringify(state), this.key), 'SECRET_GUARD');
    const input = typeof state === 'string' ? state : [{ role: 'user', content: [{ type: 'input_json', data: state }] }];
    const payload = JSON.stringify({ model: c.model, input, questions: toWireQuestions(questions) });
    assert(Buffer.byteLength(payload) <= MAX_REQUEST_BYTES, 'DECISIONS_REQUEST_TOO_LARGE');

    // The provider timeout replaces the Jev-tuned global one; the caller's limit and deadline can only shorten it.
    const allowed = Math.min(this.timeoutMs, Number.isFinite(timeoutMs) ? timeoutMs : Infinity, deadlineAt - performance.now());
    assert(allowed >= 1, 'DECISIONS_TIMEOUT'); // budget already spent: no request is sent
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), allowed);
    try {
      const response = await this.fetch(c.endpoint + '/v1/decisions', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body: payload,
      });
      assert(response.ok, `DECISIONS_HTTP_${response.status}`);
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          bytes += r.value.byteLength;
          assert(bytes <= MAX_RESPONSE_BYTES, 'DECISIONS_RESPONSE_TOO_LARGE');
          chunks.push(Buffer.from(r.value));
        }
      } finally {
        try { await reader.cancel(); } catch {}
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw fail('INVALID_DECISIONS_ENVELOPE'); }
      return validateAnswers(fromWireResponse(body, questions), questions);
    } catch (e) {
      if (controller.signal.aborted) throw fail('DECISIONS_TIMEOUT');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Deterministic in-process rules. A resolver may abstain by returning null/undefined. */
export class LocalJudge {
  constructor(resolvers = {}) {
    this.resolvers = resolvers;
  }

  async evaluate(state, questions, scope, limits = {}) {
    const start = performance.now();
    const resolver = Object.hasOwn(this.resolvers, limits.pointId ?? '') ? this.resolvers[limits.pointId] : null;
    assert(typeof resolver === 'function', 'LOCAL_ABSTAIN');
    const answers = await resolver(state, questions);
    assert(answers != null, 'LOCAL_ABSTAIN');
    const response = validateAnswers({ model: 'local-rules', answers, usage: { input_tokens: 0, output_tokens: 0 } }, questions);
    return { response, cached: false, latencyMs: performance.now() - start };
  }
}
