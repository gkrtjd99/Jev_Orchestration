// Arm configuration, kernel construction and request bookkeeping shared by both suites.
// The judges, the kernel, the decision log and the label/report path are the shipped product code.
import { defaults, validateConfig } from '../../../orchestration/src/config.mjs';
import { createKernel } from '../../../orchestration/src/kernel/kernel.mjs';
import { DecisionLog, decisionLogDir } from '../../../orchestration/src/kernel/log.mjs';
import { SKILLS_POINT, localSkillResolver } from '../../../orchestration/src/kernel/skills.mjs';

export const ARMS = {
  jev: { judges: ['jev'], escalateBelow: 0, suites: ['skills', 'supervisor'], keys: ['TYPESAFE_API_KEY'] },
  openai: { judges: ['openai'], escalateBelow: 0, suites: ['skills', 'supervisor'], keys: ['OPENAI_API_KEY'] },
  local: { judges: ['local'], escalateBelow: 0, suites: ['skills'], keys: [] },
  chain: { judges: ['local', 'jev'], escalateBelow: 0.6, suites: ['skills'], keys: ['TYPESAFE_API_KEY'] },
};

// The product caps config.timeoutMs at 5000 ms. The harness may run with a larger budget so that slow
// calls are measured instead of truncated; everything else in the config must still pass validateConfig.
const PRODUCT_TIMEOUT_CAP_MS = 5000;

/**
 * Harness-only config: a disposable stateDir, egress and the OpenAI judge approved here and nowhere else,
 * response cache disabled, and the point under test set to the arm's judge chain.
 */
export function armConfig({ arm, pointId, stateDir, timeoutMs, openaiModel }) {
  const spec = ARMS[arm];
  const cfg = defaults('/qa-kernel-eval-unused-home');
  cfg.stateDir = stateDir;
  cfg.safety.allowEgress = true;
  cfg.kernel.providers.openai.approved = true;
  if (openaiModel) cfg.kernel.providers.openai.model = openaiModel;
  // Since 9166142 the OpenAI judge has its own request ceiling (default 2500 ms, at most 5000 ms) that
  // config.timeoutMs no longer lifts. The harness raises it to the product maximum so slow calls are
  // measured rather than cut at the default; anything slower than 5000 ms still ends as DECISIONS_TIMEOUT.
  cfg.kernel.providers.openai.timeoutMs = Math.max(50, Math.min(timeoutMs, PRODUCT_TIMEOUT_CAP_MS));
  cfg.kernel.points[pointId] = { mode: 'shadow', judges: [...spec.judges], escalateBelow: spec.escalateBelow };
  cfg.cacheTtlMs = 0;
  cfg.circuit.maxRequestsPerSession = 10000;
  validateConfig({ ...structuredClone(cfg), timeoutMs: Math.min(timeoutMs, PRODUCT_TIMEOUT_CAP_MS) });
  cfg.timeoutMs = timeoutMs;
  return cfg;
}

function fail(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

/**
 * Counts real HTTP requests by host and status, and reads the `usage` object of each JSON response body
 * straight off the wire (the OpenAI adapter coerces a missing token field to 0, so the adapter's own numbers
 * cannot tell "0" from "not returned"). Never touches request headers or the request body.
 */
export function countingFetch(inner, { maxRequests }) {
  const stats = {
    requests: 0, byHost: {}, byStatus: {}, threw: 0,
    wireUsage: { responsesWithUsage: 0, fieldsSeen: [], inputTokens: null, outputTokens: null },
  };
  const readUsage = async response => {
    try {
      const usage = JSON.parse(await response.text())?.usage;
      if (!usage || typeof usage !== 'object') return;
      const w = stats.wireUsage;
      w.responsesWithUsage++;
      for (const key of Object.keys(usage)) if (/^[a-z_]{1,40}$/.test(key) && !w.fieldsSeen.includes(key)) w.fieldsSeen.push(key);
      if (Number.isFinite(usage.input_tokens)) w.inputTokens = (w.inputTokens ?? 0) + usage.input_tokens;
      if (Number.isFinite(usage.output_tokens)) w.outputTokens = (w.outputTokens ?? 0) + usage.output_tokens;
    } catch { /* not JSON, or no body: nothing to count */ }
  };
  const fetchImpl = async (url, init) => {
    if (stats.requests >= maxRequests) throw fail('QA_REQUEST_BUDGET');
    stats.requests++;
    let host = 'unknown';
    try { host = new URL(String(url)).host; } catch { /* keep 'unknown' */ }
    stats.byHost[host] = (stats.byHost[host] ?? 0) + 1;
    try {
      const response = await inner(url, init);
      stats.byStatus[response.status] = (stats.byStatus[response.status] ?? 0) + 1;
      // The product reads the same (small, size-capped) body right after, so this adds no wait of its own.
      if (response.ok) await readUsage(response.clone());
      return response;
    } catch (e) { stats.threw++; throw e; }
  };
  return { fetchImpl, stats };
}

export function buildKernel(cfg, { arm, env, fetchImpl }) {
  const needs = new Set(ARMS[arm].keys);
  const log = new DecisionLog(decisionLogDir(cfg));
  const kernel = createKernel(cfg, {
    // Each arm only ever sees the key it needs.
    apiKey: needs.has('TYPESAFE_API_KEY') ? env.TYPESAFE_API_KEY || '' : '',
    runtimeEnv: needs.has('OPENAI_API_KEY') ? { OPENAI_API_KEY: env.OPENAI_API_KEY || '' } : {},
    fetchImpl, log,
    localResolvers: { [SKILLS_POINT]: localSkillResolver() },
  });
  return { kernel, log };
}

export async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const TIMEOUT_CODES = new Set(['JEV_TIMEOUT', 'DECISIONS_TIMEOUT', 'KERNEL_DEADLINE']);
// Untyped failures are what a thrown fetch (DNS, reset, TLS) looks like once it leaves the product code.
const UNTYPED_CODES = new Set(['SKILL_JUDGE_FAILED', 'KERNEL_JUDGE_ERROR', 'UNTYPED_ERROR']);

export const isTimeout = code => TIMEOUT_CODES.has(code);
/** Transport-level failures eligible for the single counted retry pass. Timeouts are never retried. */
export const isTransport = code => typeof code === 'string' && !isTimeout(code)
  && (UNTYPED_CODES.has(code) || /_HTTP_(429|5\d\d)$/.test(code) || code === 'LOCK_BUSY');

export const typedCode = e => (typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code) ? e.code : 'UNTYPED_ERROR');

/** Sum the token usage the API returned. A field stays null when no response carried it. */
export function sumUsage(usages) {
  const out = { responsesWithUsage: 0, inputTokens: null, outputTokens: null };
  for (const u of usages) {
    if (!u || typeof u !== 'object') continue;
    const i = Number.isFinite(u.input_tokens) ? u.input_tokens : null;
    const o = Number.isFinite(u.output_tokens) ? u.output_tokens : null;
    if (i === null && o === null) continue;
    out.responsesWithUsage++;
    if (i !== null) out.inputTokens = (out.inputTokens ?? 0) + i;
    if (o !== null) out.outputTokens = (out.outputTokens ?? 0) + o;
  }
  return out;
}

/** Decision-log records keyed by the per-attempt scope the harness used. */
export async function trailsByScope(log, pointId) {
  const { decisions, corruptLines } = await log.read({ pointId });
  const map = new Map();
  for (const d of decisions) map.set(d.scope, d);
  return { map, decisions: decisions.length, corruptLines };
}
