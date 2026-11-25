/** Provider-agnostic decision kernel: per-point mode, judge chain, escalation and hashed decision log. */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { assert, object, hash } from '../util.mjs';
import { JevClient } from '../jev.mjs';
import { minConfidence } from './answers.mjs';
import { OpenAIDecisionsClient, LocalJudge, OPENAI_TIMEOUT_DEFAULT_MS, OPENAI_TIMEOUT_MIN_MS, OPENAI_TIMEOUT_MAX_MS } from './judges.mjs';

export const POINTS = ['delegation.classify', 'delegation.profile', 'delegation.skills', 'supervisor.outcome', 'failure.classify', 'read.advice'];
export const MODES = ['off', 'shadow', 'active'];
export const PROVIDERS = ['jev', 'openai', 'local'];
const MIN_JUDGE_BUDGET_MS = 50;

export function kernelDefaults() {
  const point = mode => ({ mode, judges: ['jev'], escalateBelow: 0 });
  return {
    log: true,
    providers: { openai: { endpoint: 'https://api.openai.com', model: 'gpt-6-luna', approved: false, timeoutMs: OPENAI_TIMEOUT_DEFAULT_MS } },
    points: {
      'delegation.classify': point('active'),
      'delegation.profile': point('active'),
      'delegation.skills': point('off'),
      'supervisor.outcome': point('off'),
      'failure.classify': point('active'),
      'read.advice': point('active'),
    },
    skills: { dirs: [], maxCandidates: 8, need: 0.5, autoLoad: 0.9, suggest: 0.5, maxLoaded: 3, maxSuggested: 3 },
    supervisor: { maxReportChars: 1600, confidence: 0.65 },
  };
}

const copy = x => (Array.isArray(x) ? [...x] : x);
const overlay = (base, extra) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = copy(v);
  return out;
};

/** Merge a missing or partial user kernel object over the defaults. Validation is separate. */
export function mergeKernel(partial) {
  const k = kernelDefaults();
  if (partial === undefined || partial === null) return k;
  assert(object(partial), 'INVALID_KERNEL');
  for (const [key, value] of Object.entries(partial)) {
    if (key === 'providers' && object(value)) {
      for (const [name, provider] of Object.entries(value)) {
        k.providers[name] = object(provider) && object(k.providers[name]) ? overlay(k.providers[name], provider) : copy(provider);
      }
    } else if (key === 'points' && object(value)) {
      // Unknown ids are kept so validateKernel can reject them instead of silently dropping a typo.
      for (const [id, point] of Object.entries(value)) {
        k.points[id] = object(point) && object(k.points[id]) ? overlay(k.points[id], point) : copy(point);
      }
    } else if ((key === 'skills' || key === 'supervisor') && object(value)) {
      k[key] = overlay(k[key], value);
    } else {
      k[key] = copy(value);
    }
  }
  return k;
}

const unit = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
const intIn = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;

export function validateKernel(k) {
  assert(object(k), 'INVALID_KERNEL');
  assert(typeof k.log === 'boolean', 'INVALID_KERNEL_LOG');

  const openai = k.providers?.openai;
  assert(object(k.providers) && object(openai), 'INVALID_KERNEL_PROVIDERS');
  assert(typeof openai.endpoint === 'string' && URL.canParse(openai.endpoint), 'INVALID_KERNEL_OPENAI_ENDPOINT');
  assert(typeof openai.model === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(openai.model), 'INVALID_KERNEL_OPENAI_MODEL');
  assert(typeof openai.approved === 'boolean', 'INVALID_KERNEL_OPENAI_APPROVED');
  assert(intIn(openai.timeoutMs, OPENAI_TIMEOUT_MIN_MS, OPENAI_TIMEOUT_MAX_MS), 'INVALID_KERNEL_OPENAI_TIMEOUT');

  assert(object(k.points), 'INVALID_KERNEL_POINTS');
  const ids = Object.keys(k.points);
  assert(ids.length === POINTS.length && POINTS.every(id => Object.hasOwn(k.points, id)), 'INVALID_KERNEL_POINTS');
  for (const id of POINTS) {
    const p = k.points[id];
    assert(object(p), 'INVALID_KERNEL_POINT');
    assert(MODES.includes(p.mode), 'INVALID_KERNEL_POINT_MODE');
    assert(Array.isArray(p.judges) && p.judges.length >= 1 && p.judges.length <= 3
      && p.judges.every(j => PROVIDERS.includes(j)) && new Set(p.judges).size === p.judges.length, 'INVALID_KERNEL_POINT_JUDGES');
    assert(unit(p.escalateBelow), 'INVALID_KERNEL_POINT_ESCALATE');
  }

  const s = k.skills;
  assert(object(s), 'INVALID_KERNEL_SKILLS');
  assert(Array.isArray(s.dirs) && s.dirs.length <= 8 && s.dirs.every(d => typeof d === 'string' && path.isAbsolute(d)), 'INVALID_KERNEL_SKILLS_DIRS');
  assert(intIn(s.maxCandidates, 1, 32), 'INVALID_KERNEL_SKILLS_MAX_CANDIDATES');
  assert(unit(s.need), 'INVALID_KERNEL_SKILLS_NEED');
  assert(unit(s.autoLoad), 'INVALID_KERNEL_SKILLS_AUTOLOAD');
  assert(unit(s.suggest) && s.suggest <= s.autoLoad, 'INVALID_KERNEL_SKILLS_SUGGEST');
  assert(intIn(s.maxLoaded, 0, 8), 'INVALID_KERNEL_SKILLS_MAX_LOADED');
  assert(intIn(s.maxSuggested, 0, 8), 'INVALID_KERNEL_SKILLS_MAX_SUGGESTED');

  const v = k.supervisor;
  assert(object(v), 'INVALID_KERNEL_SUPERVISOR');
  assert(intIn(v.maxReportChars, 200, 6000), 'INVALID_KERNEL_SUPERVISOR_REPORT');
  assert(unit(v.confidence), 'INVALID_KERNEL_SUPERVISOR_CONFIDENCE');
  return k;
}

function fail(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

// Only typed codes reach the trail and log; arbitrary error text could carry state.
const errorCode = e => (typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code) ? e.code : 'KERNEL_JUDGE_ERROR');

/** Numbers and option names only: the log never carries state text or instructions. */
function compactAnswers(answers) {
  const out = {};
  for (const [id, a] of Object.entries(answers ?? {})) {
    if (a?.type === 'noul') out[id] = { type: 'noul', p: a.noul };
    else if (a?.type === 'choice') out[id] = { type: 'choice', choice: a.choice, p: { ...a.probabilities }, confidence: a.confidence };
    else if (a?.type === 'score') out[id] = { type: 'score', score: a.score, p: { ...a.probabilities }, confidence: a.confidence };
  }
  return out;
}

export class DecisionKernel {
  constructor(config, { judges = {}, log = null, now = Date.now } = {}) {
    this.config = config;
    this.kernel = validateKernel(mergeKernel(config?.kernel));
    this.judges = judges;
    this.log = log;
    this.now = now;
    this.resolved = new Map();
  }

  point(id) {
    assert(typeof id === 'string' && Object.hasOwn(this.kernel.points, id), 'KERNEL_UNKNOWN_POINT');
    return this.kernel.points[id];
  }

  /**
   * Total time one decision at this point may take: the largest per-provider request timeout in its
   * chain (jev: config.timeoutMs, openai: providers.openai.timeoutMs, local: none), never more than
   * the caller's ceiling (for example what is left of the route deadline). It is a budget for the
   * whole chain, not per judge, and each judge still enforces its own timeout inside it.
   * With the default chain ['jev'] this is exactly min(config.timeoutMs, ceiling), the value the
   * pre-kernel router passed to the client.
   * Returns null when nothing bounds the chain (no ceiling and no configured timeout).
   */
  budget(pointId, ceiling = Infinity) {
    const global = Number.isFinite(this.config?.timeoutMs) ? this.config.timeoutMs : null;
    let own = null;
    for (const provider of this.point(pointId).judges) {
      const t = provider === 'jev' ? global : provider === 'openai' ? this.kernel.providers.openai.timeoutMs : null;
      if (t !== null && (own === null || t > own)) own = t;
    }
    own ??= global; // a chain of local rules only keeps the previous default
    const limit = Math.min(own ?? Infinity, Number.isFinite(ceiling) ? ceiling : Infinity);
    return Number.isFinite(limit) ? limit : null;
  }

  // Factories run at most once and only for providers a point actually reaches.
  judge(provider) {
    if (this.resolved.has(provider)) return this.resolved.get(provider);
    const entry = Object.hasOwn(this.judges, provider) ? this.judges[provider] : null;
    const judge = typeof entry === 'function' ? entry() : entry;
    assert(judge && typeof judge.evaluate === 'function', 'KERNEL_JUDGE_UNAVAILABLE');
    this.resolved.set(provider, judge);
    return judge;
  }

  async record(entry) {
    if (this.kernel.log !== true || !this.log) return;
    // The log contract allows only provider/ok/code/confidence/latencyMs per trail step.
    const trail = entry.trail.map(step => {
      const out = { provider: step.provider, ok: step.ok };
      if (step.code !== undefined) out.code = step.code;
      else if (step.escalated) out.code = 'KERNEL_LOW_CONFIDENCE';
      if (step.confidence !== undefined) out.confidence = step.confidence;
      out.latencyMs = step.latencyMs;
      return out;
    });
    try { await this.log.append({ ...entry, trail }); } catch { /* the log is advisory; a decision never depends on it */ }
  }

  async decide(pointId, { state, questions, scope, limits = {}, subject = null } = {}) {
    const point = this.point(pointId);
    const { mode } = point;
    if (mode === 'off') return { pointId, mode: 'off', skipped: true, apply: false };

    const start = performance.now();
    const time = this.now();
    // timeoutMs is a total budget for the whole chain, not per judge. Without an explicit limit the
    // chain still gets a single budget (see budget()), so adding judges never multiplies the wait.
    const explicitBudget = Number.isFinite(limits.timeoutMs);
    const budget = explicitBudget ? limits.timeoutMs : this.budget(pointId);
    const stateHash = hash(state ?? null);
    const questionsHash = hash(questions ?? null);
    const scopeText = String(scope ?? '');
    const base = {
      schema: 1, time, pointId, mode, scope: scopeText, subject: typeof subject === 'string' ? subject : null,
      questionsHash, stateHash,
    };
    const id = provider => hash({ pointId, scope: scopeText, stateHash, questionsHash, provider, time });
    const trail = [];
    let lastError = null;
    // Best valid answer that was below escalateBelow. It is used only if no later judge answers.
    let held = null;

    const accept = async ({ provider, result, confidence }, fallback) => {
      const latencyMs = performance.now() - start;
      const decisionId = id(provider);
      const cached = result.cached === true;
      const model = typeof result.response.model === 'string' && result.response.model ? result.response.model : 'unknown';
      await this.record({
        ...base, decisionId, provider, model, cached, latencyMs, confidence,
        answers: compactAnswers(result.response.answers), trail,
      });
      return {
        pointId, mode, skipped: false, apply: mode === 'active', response: result.response, provider,
        cached, latencyMs, confidence, trail, decisionId, fallback,
      };
    };

    for (let i = 0; i < point.judges.length; i++) {
      const provider = point.judges[i];
      const judgeLimits = { ...limits, pointId };
      if (budget !== null) {
        const remaining = budget - (performance.now() - start);
        // Later judges need at least the floor of what is left. The first judge is refused only when the
        // caller's allowance itself is below the floor: an allowance of exactly 50 ms (the documented
        // minimum timeout) has 49.99 ms left by the time this line runs and must still reach its judge.
        // A defaulted budget always lets the first judge run; the judge enforces its own timeout.
        if (i > 0 ? remaining < MIN_JUDGE_BUDGET_MS : explicitBudget && budget < MIN_JUDGE_BUDGET_MS) {
          lastError = fail('KERNEL_DEADLINE');
          trail.push({ provider, ok: false, code: 'KERNEL_DEADLINE', latencyMs: 0 });
          break;
        }
        judgeLimits.timeoutMs = remaining;
      }
      const judgeStart = performance.now();
      let result;
      try {
        result = await this.judge(provider).evaluate(state, questions, scope, judgeLimits);
        assert(object(result) && object(result.response) && object(result.response.answers), 'KERNEL_INVALID_JUDGE_RESULT');
      } catch (error) {
        lastError = error;
        trail.push({ provider, ok: false, code: errorCode(error), latencyMs: performance.now() - judgeStart });
        continue;
      }
      const confidence = minConfidence(result.response.answers);
      const step = { provider, ok: true, latencyMs: performance.now() - judgeStart };
      if (confidence !== null) step.confidence = confidence;
      const last = i === point.judges.length - 1;
      const confident = point.escalateBelow <= 0 || (confidence !== null && confidence >= point.escalateBelow);
      if (!last && !confident) {
        trail.push({ ...step, escalated: true });
        if (!held || (confidence ?? -1) >= (held.confidence ?? -1)) held = { provider, result, confidence };
        continue;
      }
      trail.push(step);
      return accept({ provider, result, confidence }, false);
    }

    // Escalation must never make a point less available than its first judge alone:
    // when every later judge failed or the budget ran out, the held low-confidence answer stands.
    if (held) return accept(held, true);

    await this.record({
      ...base, decisionId: id('none'), provider: 'none', model: 'none', cached: false,
      latencyMs: performance.now() - start, confidence: null, answers: {}, trail,
    });
    throw lastError ?? fail('KERNEL_JUDGE_UNAVAILABLE');
  }

  /** Judge-interface facade so existing call sites can swap a client for a kernel point. */
  forPoint(pointId) {
    this.point(pointId);
    return {
      evaluate: async (state, questions, scope, limits = {}) => {
        const d = await this.decide(pointId, { state, questions, scope, limits });
        assert(!d.skipped, 'KERNEL_POINT_OFF');
        const { response, cached, latencyMs, provider, decisionId, mode, apply } = d;
        return { response, cached, latencyMs, provider, decisionId, mode, apply };
      },
    };
  }
}

export function createKernel(config, { apiKey = '', client = null, runtimeEnv = {}, fetchImpl, localResolvers = {}, log = null } = {}) {
  const options = fetchImpl ? { fetchImpl } : {};
  const kernel = mergeKernel(config?.kernel);
  return new DecisionKernel(config, {
    log,
    judges: {
      jev: client || (() => new JevClient(config, apiKey, options)),
      openai: () => new OpenAIDecisionsClient({ ...config, kernel }, runtimeEnv?.OPENAI_API_KEY || '', options),
      local: new LocalJudge(localResolvers),
    },
  });
}
