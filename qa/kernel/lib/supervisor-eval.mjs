// Supervisor evaluation: the same decide -> supervisorAdvice path the PostToolUse hook runs, scored against gold.
import { SWEEP_LABEL } from './holdout.mjs';
import { performance } from 'node:perf_hooks';
import { redact } from '../../../orchestration/src/util.mjs';
import { secretLike } from '../../../orchestration/src/safety.mjs';
import {
  SUPERVISOR_POINT, SUPERVISOR_OUTCOMES, supervisorQuestions, supervisorAdvice,
} from '../../../orchestration/src/kernel/supervisor.mjs';
import { calibrationReport } from '../../../orchestration/src/kernel/calibration.mjs';
import {
  armConfig, buildKernel, countingFetch, pool, isTimeout, isTransport, sumUsage, trailsByScope, typedCode,
} from './harness.mjs';
import { ratio, mean, latencySummary, prf, choiceCalibration, countBy, groupBy } from './stats.mjs';

export const CONFIDENCE_SWEEP = [0, 0.5, 0.6, 0.65, 0.7, 0.8, 0.9, 0.95];
const LATENCY_BUDGETS_MS = [1200, 2500, 3000, 5000];

const argmaxLevel = p => {
  let best = null;
  for (const [k, v] of Object.entries(p ?? {})) if (best === null || v > p[best]) best = k;
  return best === null ? null : Number(best);
};

export async function runSupervisorArm({
  arm, runId, items, env, innerFetch, stateDir, timeoutMs, concurrency, openaiModel, retry, maxRequests, onProgress = () => {},
}) {
  const cfg = armConfig({ arm, pointId: SUPERVISOR_POINT, stateDir, timeoutMs, openaiModel });
  const { fetchImpl, stats: http } = countingFetch(innerFetch, { maxRequests });
  const { kernel, log } = buildKernel(cfg, { arm, env, fetchImpl });
  const settings = kernel.kernel.supervisor;
  const attempts = [];
  let done = 0;

  const attempt = async (item, n) => {
    const scope = `qa:${runId}:supervisor:${arm}:${item.id}:a${n}`;
    const base = {
      suite: 'supervisor', arm, id: item.id, lang: item.lang ?? null, attempt: n, scope,
      reportChars: item.report.length, truncated: item.report.trim().length > settings.maxReportChars,
      status: 'judged', code: null, outcome: null, confidence: null, probabilities: null,
      evidenceScore: null, evidenceLevel: null, evidenceProbabilities: null, advisory: false,
      provider: null, model: null, decisionId: null, latencyMs: null, usage: null,
    };
    const text = item.report.trim();
    // Same pre-checks as the hook: an empty report or one with a key-like string is never sent.
    if (!text) { onProgress(++done); return { ...base, status: 'skipped', code: 'EMPTY_REPORT' }; }
    if (secretLike(text, env.TYPESAFE_API_KEY || '') || secretLike(text, env.OPENAI_API_KEY || '')) {
      onProgress(++done);
      return { ...base, status: 'skipped', code: 'SECRET_GUARD' };
    }
    const start = performance.now();
    try {
      const decision = await kernel.decide(SUPERVISOR_POINT, {
        state: { report: redact(text, settings.maxReportChars) }, questions: supervisorQuestions(), scope,
        limits: { timeoutMs: cfg.timeoutMs }, subject: null,
      });
      const answers = decision.response.answers;
      const advice = supervisorAdvice(answers, settings);
      attempts.push({ id: item.id, attempt: n, ok: true, code: null, latencyMs: decision.latencyMs });
      onProgress(++done);
      return {
        ...base, outcome: advice.outcome, confidence: advice.confidence, probabilities: { ...answers.outcome.probabilities },
        evidenceScore: advice.evidence, evidenceLevel: argmaxLevel(answers.evidence.probabilities),
        evidenceProbabilities: { ...answers.evidence.probabilities }, advisory: advice.advisory,
        provider: decision.provider, model: decision.response.model, decisionId: decision.decisionId,
        latencyMs: decision.latencyMs, usage: decision.response.usage ?? null,
      };
    } catch (e) {
      const code = typedCode(e);
      const latencyMs = performance.now() - start;
      attempts.push({ id: item.id, attempt: n, ok: false, code, latencyMs });
      onProgress(++done);
      return { ...base, status: 'unavailable', code, latencyMs };
    }
  };

  const rows = await pool(items, concurrency, item => attempt(item, 1));
  const firstPassFailures = countBy(rows.filter(r => r.status === 'unavailable'), r => r.code);
  const targets = retry ? rows.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 'unavailable' && isTransport(r.code)) : [];
  await pool(targets, concurrency, async ({ r, i }) => {
    const again = await attempt(items[i], 2);
    again.firstAttempt = { code: r.code, latencyMs: r.latencyMs };
    rows[i] = again;
  });
  const { map, decisions, corruptLines } = await trailsByScope(log, SUPERVISOR_POINT);
  for (const row of rows) row.trail = map.get(row.scope)?.trail ?? null;
  return { cfg, kernel, log, settings, rows, attempts, http, retried: targets.length, firstPassFailures, logged: { decisions, corruptLines } };
}

// ---------------------------------------------------------------- scoring

function outcomeMetrics(rows, gold) {
  const scoped = rows.filter(r => gold.has(r.id));
  const answered = scoped.filter(r => r.status === 'judged');
  const confusion = Object.fromEntries(SUPERVISOR_OUTCOMES.map(g => [g, Object.fromEntries([...SUPERVISOR_OUTCOMES, 'none'].map(p => [p, 0]))]));
  for (const r of scoped) confusion[gold.get(r.id).outcome][r.status === 'judged' ? r.outcome : 'none']++;
  const perClass = {};
  for (const c of SUPERVISOR_OUTCOMES) {
    const tp = confusion[c][c];
    const fp = SUPERVISOR_OUTCOMES.filter(g => g !== c).reduce((s, g) => s + confusion[g][c], 0);
    const fn = Object.values(confusion[c]).reduce((a, b) => a + b, 0) - tp;
    perClass[c] = { support: tp + fn, ...prf(tp, fp, fn) };
  }
  const correct = answered.filter(r => r.outcome === gold.get(r.id).outcome).length;
  const f1s = Object.values(perClass).filter(c => c.support > 0).map(c => c.f1 ?? 0);
  return {
    n: scoped.length, answered: answered.length, notAnswered: scoped.length - answered.length,
    // A failed or skipped item surfaces no advice; in `accuracy` it counts as wrong.
    accuracy: ratio(correct, scoped.length), accuracyAnsweredOnly: ratio(correct, answered.length),
    macroF1: mean(f1s), perClass,
    // Rows are gold, columns are predictions; `none` = no answer (failure or skipped).
    confusion,
  };
}

function evidenceMetrics(rows, gold) {
  const pairs = rows.filter(r => r.status === 'judged' && gold.has(r.id) && gold.get(r.id).evidence !== null)
    .map(r => ({ score: r.evidenceScore, level: r.evidenceLevel, y: gold.get(r.id).evidence }));
  return {
    n: pairs.length, mae: mean(pairs.map(p => Math.abs(p.score - p.y))),
    exactLevelRate: ratio(pairs.filter(p => p.level === p.y).length, pairs.length),
    withinOneRate: ratio(pairs.filter(p => Math.abs(p.level - p.y) <= 1).length, pairs.length),
  };
}

function thresholdEffect(rows, gold, threshold) {
  const scoped = rows.filter(r => gold.has(r.id));
  const surfaced = scoped.filter(r => r.status === 'judged' && r.confidence >= threshold);
  const correct = surfaced.filter(r => r.outcome === gold.get(r.id).outcome).length;
  const hidden = scoped.filter(r => r.status === 'judged' && r.confidence < threshold);
  return {
    threshold, n: scoped.length, surfaced: surfaced.length, coverage: ratio(surfaced.length, scoped.length),
    accuracyAmongSurfaced: ratio(correct, surfaced.length),
    accuracyAmongHidden: ratio(hidden.filter(r => r.outcome === gold.get(r.id).outcome).length, hidden.length),
    wrongAdviceSurfaced: surfaced.length - correct, wrongAdviceSurfacedShareOfAll: ratio(surfaced.length - correct, scoped.length),
  };
}

function scoreVariant(rows, gold, confidence) {
  const cal = rs => choiceCalibration(rs.filter(r => r.status === 'judged' && gold.has(r.id))
    .map(r => ({ p: r.probabilities, choice: r.outcome, y: gold.get(r.id).outcome })));
  const scoped = rows.filter(r => gold.has(r.id));
  return {
    outcome: outcomeMetrics(rows, gold),
    evidence: evidenceMetrics(rows, gold),
    calibrationDirect: cal(rows),
    shippedThreshold: thresholdEffect(rows, gold, confidence),
    thresholdSweep: { label: SWEEP_LABEL, points: CONFIDENCE_SWEEP.map(t => thresholdEffect(rows, gold, t)) },
    byLanguage: Object.fromEntries([...groupBy(scoped, r => r.lang ?? 'unknown').entries()].sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([lang, group]) => {
        const o = outcomeMetrics(group, gold);
        return [lang, {
          n: o.n, answered: o.answered, accuracy: o.accuracy, accuracyAnsweredOnly: o.accuracyAnsweredOnly, macroF1: o.macroF1,
          evidence: evidenceMetrics(group, gold), shippedThreshold: thresholdEffect(group, gold, confidence),
        }];
      })),
  };
}

async function productCalibration({ rows, gold, log, source }) {
  let labels = 0, decisions = 0;
  for (const row of rows) {
    if (!row.decisionId || !gold.has(row.id)) continue;
    const g = gold.get(row.id);
    decisions++;
    await log.label(row.decisionId, { questionId: 'outcome', outcome: g.outcome, source });
    labels++;
    if (g.evidence !== null) { await log.label(row.decisionId, { questionId: 'evidence', outcome: g.evidence, source }); labels++; }
  }
  return { labeledDecisions: decisions, labelsWritten: labels, labelSource: source, report: calibrationReport(await log.read({ pointId: SUPERVISOR_POINT })) };
}

function crossCheck(report, direct, directEvidence) {
  const choice = report.groups.filter(g => g.type === 'choice' && g.counts.labeled > 0);
  const score = report.groups.filter(g => g.type === 'score' && g.counts.labeled > 0);
  let maxAbsDiff = null, compared = 0;
  const cmp = (a, b) => {
    if (a === null || a === undefined || b === null || b === undefined) return;
    maxAbsDiff = Math.max(maxAbsDiff ?? 0, Math.abs(a - b)); compared++;
  };
  // Single-judge arms have exactly one provider group per type; more than one cannot be compared to a pooled figure.
  if (choice.length === 1) for (const k of ['brier', 'accuracy', 'ece']) cmp(choice[0].metrics[k], direct[k]);
  if (score.length === 1) { cmp(score[0].metrics.mae, directEvidence.mae); cmp(score[0].metrics.exactLevelAccuracy, directEvidence.exactLevelRate); }
  const countMismatch = (choice.length === 1 && choice[0].counts.labeled !== direct.n) || (score.length === 1 && score[0].counts.labeled !== directEvidence.n);
  return { comparedMetrics: compared, maxAbsDiff, countMismatch, agrees: compared > 0 && !countMismatch && maxAbsDiff < 1e-9 };
}

export async function supervisorMetrics({ run, gold, labelGold: labelGoldName = null }) {
  const { rows, attempts, settings, log, http } = run;
  const variants = {};
  for (const name of ['consensus', 'author', 'blind']) variants[name] = gold[name] ? scoreVariant(rows, gold[name], settings.confidence) : null;
  const useConsensus = labelGoldName ? labelGoldName === 'consensus' : gold.consensus !== null;
  const labelGold = useConsensus ? gold.consensus : gold.author;
  const product = await productCalibration({ rows, gold: labelGold, log, source: useConsensus ? 'qa-consensus-gold' : 'qa-author-gold' });
  const labelVariant = useConsensus ? variants.consensus : variants.author;
  const failed = rows.filter(r => r.status === 'unavailable');
  const latencies = attempts.map(a => a.latencyMs);
  return {
    judges: run.cfg.kernel.points[SUPERVISOR_POINT].judges,
    settings: { confidence: settings.confidence, maxReportChars: settings.maxReportChars },
    operations: {
      items: rows.length, judgeCalls: attempts.length, skipped: countBy(rows.filter(r => r.status === 'skipped'), r => r.code),
      truncatedReports: rows.filter(r => r.truncated).length,
      retriedTransportErrors: run.retried, failuresFirstPassByCode: run.firstPassFailures,
      failedItems: failed.length, failureRate: ratio(failed.length, rows.length), failuresByCode: countBy(failed, r => r.code),
      timeouts: attempts.filter(a => isTimeout(a.code)).length,
      latencyMs: latencySummary(latencies), latencySuccessfulMs: latencySummary(attempts.filter(a => a.ok).map(a => a.latencyMs)),
      shareOverBudgetMs: Object.fromEntries(LATENCY_BUDGETS_MS.map(ms => [ms, ratio(latencies.filter(x => x > ms).length, latencies.length)])),
      tokens: sumUsage(rows.map(r => r.usage)), http,
    },
    gold: variants,
    calibration: { product, crossCheck: crossCheck(product.report, labelVariant.calibrationDirect, labelVariant.evidence) },
    decisionLog: run.logged,
  };
}
