/** Judges behind the decision kernel: OpenAI Decisions adapter and local rules. */
import { performance } from 'node:perf_hooks';
import { assert, object } from '../util.mjs';
import { secretLike } from '../safety.mjs';
import { JevClient } from '../jev.mjs';
import { validateAnswers } from './answers.mjs';

const OPENAI_ORIGIN = 'https://api.openai.com';
const MAX_REQUEST_BYTES = 524288;
const MAX_RESPONSE_BYTES = 262144;

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
      answers[id] = { type: 'score', score: a.score, confidence: a.confidence, probabilities: distribution(a.probabilities) };
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

  async request(state, questions, { timeoutMs = this.config.timeoutMs } = {}) {
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(c.timeoutMs, timeoutMs));
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
