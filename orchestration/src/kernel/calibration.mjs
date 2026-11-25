// Calibration metrics over decision-log records. Pure functions, no IO.
// Convention: a metric with no labeled rows or an undefined denominator is null, never 0.
import { assert } from '../util.mjs';

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ratio = (n, d) => (d > 0 ? n / d : null);

// Nearest-rank percentile.
function percentile(sorted, q) {
  return sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null;
}

// Most probable key of a probability map; ties keep the first key in insertion order.
function argmax(p) {
  let best = null;
  for (const [k, v] of Object.entries(p ?? {})) if (best === null || v > p[best]) best = k;
  return best;
}

/**
 * What a label source is worth. A label is only as strong as the evidence behind it, and the three sources
 * the outcome collector writes are very different things:
 *   observed-load                    what a subagent DID (it loaded the skill or not). Weak: a subagent can load a
 *                                    skill it did not need and can skip one it needed.
 *   external-verification-with-load  the skill was loaded AND the task passed the user's external convention
 *                                    check. Still weak for "was the skill needed": the pass is not attributed
 *                                    to the skill. One-sided: it only ever says true.
 *   external-verification            a user-supplied external check passed, so the outcome is 'complete'.
 *                                    Verified, but one-sided: a failed check is left unlabelled, so every
 *                                    label of this source is 'complete' and accuracy over them is recall on
 *                                    'complete', not accuracy.
 * Any other source (labels attached by hand) is 'unclassified': this code cannot vouch for it either way.
 */
export const LABEL_SOURCES = Object.freeze({
  'observed-load': Object.freeze({ strength: 'weak', oneSided: false }),
  'external-verification-with-load': Object.freeze({ strength: 'weak', oneSided: true }),
  'external-verification': Object.freeze({ strength: 'verified', oneSided: true }),
});
export const labelSourceInfo = source => (Object.hasOwn(LABEL_SOURCES, source) ? LABEL_SOURCES[source] : { strength: 'unclassified', oneSided: null });
const LABEL_NOTE = 'Metrics are only as strong as their labels. A "weak" source records behaviour (for example that a subagent loaded a skill), '
  + 'not ground truth; a "one-sided" source only ever writes one outcome, so rates over it are not accuracy; "unclassified" sources were '
  + 'attached by hand and are not vouched for here. Read each group\'s labelSources before its metrics.';

/** Latest label per (decisionId, questionId) wins; labels for unknown decisions/questions are dropped. */
export function joinLabels(data = {}) {
  return joinWithSource(data).map(({ source, ...row }) => row);
}

function joinWithSource({ decisions = [], labels = [] } = {}) {
  const byId = new Map(decisions.map(d => [d.decisionId, d]));
  const latest = new Map();
  for (const label of labels) {
    const key = `${label.decisionId}\n${label.questionId}`;
    const prev = latest.get(key);
    // >= so that, at equal times, the later-appended label wins.
    if (!prev || label.time >= prev.time) latest.set(key, label);
  }
  const rows = [];
  for (const label of latest.values()) {
    const d = byId.get(label.decisionId);
    if (!d?.answers || !Object.hasOwn(d.answers, label.questionId)) continue;
    const answer = d.answers[label.questionId];
    rows.push({ pointId: d.pointId, provider: d.provider, model: d.model, mode: d.mode,
      questionId: label.questionId, type: answer.type, answer, outcome: label.outcome, source: label.source });
  }
  return rows;
}

/** Whether a joined row's outcome is usable for its answer type. */
export function labelFits({ type, answer, outcome }) {
  if (type === 'noul') return typeof outcome === 'boolean';
  if (type === 'choice') return typeof outcome === 'string' && Object.hasOwn(answer.p ?? {}, outcome);
  if (type === 'score') {
    if (!Number.isSafeInteger(outcome) || outcome < 0) return false;
    const levels = Object.keys(answer.p ?? {});
    return levels.length === 0 || Object.hasOwn(answer.p, String(outcome));
  }
  return false;
}

/**
 * Equal-width reliability table. rows: [{p: predicted probability 0..1, y: boolean|0|1}].
 * The last bin is closed on the right so p === 1 has a home.
 */
export function reliabilityBins(rows, bins = 10) {
  assert(Number.isInteger(bins) && bins >= 1 && bins <= 1000, 'INVALID_CALIBRATION_OPTIONS');
  const table = Array.from({ length: bins }, (_, i) => ({ lower: i / bins, upper: (i + 1) / bins, count: 0, sumP: 0, sumY: 0 }));
  for (const { p, y } of rows) {
    const bin = table[Math.min(bins - 1, Math.max(0, Math.floor(p * bins)))];
    bin.count++;
    bin.sumP += p;
    bin.sumY += y ? 1 : 0;
  }
  return table.map(({ lower, upper, count, sumP, sumY }) => ({
    lower, upper, count, meanPredicted: ratio(sumP, count), observedRate: ratio(sumY, count),
  }));
}

function expectedCalibrationError(table) {
  const total = table.reduce((n, b) => n + b.count, 0);
  if (!total) return null;
  return table.reduce((sum, b) => sum + (b.count ? (b.count / total) * Math.abs(b.meanPredicted - b.observedRate) : 0), 0);
}

function noulMetrics(rows, bins, threshold) {
  const pairs = rows.map(r => ({ p: r.answer.p, y: r.outcome ? 1 : 0 }));
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const { p, y } of pairs) {
    if (p >= threshold) { if (y) tp++; else fp++; }
    else if (y) fn++;
    else tn++;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision === null || recall === null || precision + recall === 0
    ? null : (2 * precision * recall) / (precision + recall);
  const reliability = reliabilityBins(pairs, bins);
  return { brier: mean(pairs.map(({ p, y }) => (p - y) ** 2)), ece: expectedCalibrationError(reliability),
    baseRate: mean(pairs.map(x => x.y)), threshold, precision, recall, f1, tp, fp, tn, fn, reliability };
}

function choiceMetrics(rows, bins) {
  const pairs = rows.map(r => ({ p: Math.max(...Object.values(r.answer.p)), y: r.answer.choice === r.outcome ? 1 : 0 }));
  const brier = mean(rows.map(r => Object.entries(r.answer.p)
    .reduce((sum, [option, p]) => sum + (p - (option === r.outcome ? 1 : 0)) ** 2, 0)));
  const reliability = reliabilityBins(pairs, bins);
  return { brier, accuracy: mean(pairs.map(x => x.y)), ece: expectedCalibrationError(reliability),
    meanConfidence: mean(pairs.map(x => x.p)), reliability };
}

function scoreMetrics(rows) {
  const level = r => {
    const top = argmax(r.answer.p);
    return top === null ? Math.round(r.answer.score) : Number(top);
  };
  return { mae: mean(rows.map(r => Math.abs(r.answer.score - r.outcome))),
    exactLevelAccuracy: mean(rows.map(r => (level(r) === r.outcome ? 1 : 0))) };
}

/**
 * Judge token totals over decision records. Only records with a `usage` field count (`reported`); a side is
 * null when no record gave a number for it, never 0. Records written before the field existed, failed
 * decisions and cache hits carry no usage, so `reported` can be smaller than the number of records.
 * The totals are a lower bound: a record holds the usage of the accepted judge's request only. A request that
 * answered below escalateBelow and was passed on, or that failed, spent tokens that are in no record (its step
 * is in the trail, which carries no usage). With a single-judge chain nothing is left out.
 */
export function usageTotals(decisions) {
  const out = { reported: 0, input_tokens: null, output_tokens: null };
  for (const d of decisions) {
    if (!d?.usage || typeof d.usage !== 'object') continue;
    out.reported++;
    for (const key of ['input_tokens', 'output_tokens']) {
      if (Number.isSafeInteger(d.usage[key]) && d.usage[key] >= 0) out[key] = (out[key] ?? 0) + d.usage[key];
    }
  }
  return out;
}

/** usageTotals per provider, sorted by provider name. */
function usageByProvider(decisions) {
  const providers = new Map();
  for (const d of decisions) {
    if (!providers.has(d.provider)) providers.set(d.provider, []);
    providers.get(d.provider).push(d);
  }
  return [...providers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([provider, members]) => ({ provider, decisions: members.length, ...usageTotals(members) }));
}

function operational(decisions) {
  const latencies = decisions.map(d => d.latencyMs).sort((a, b) => a - b);
  const n = decisions.length;
  return {
    cachedRate: ratio(decisions.filter(d => d.cached).length, n),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    meanConfidence: mean(decisions.map(d => d.confidence).filter(c => typeof c === 'number')),
    // Tokens of the records in this group. A record with answers of two types is in two groups, so group
    // totals must not be added up; the report's top-level `usage` and `points[].usage` count each record once.
    usage: usageTotals(decisions),
  };
}

/**
 * Failure and escalation rates per decision point. They cannot live in the provider groups: a failed
 * decision is logged with provider 'none', so its rate there is 1 by construction and 0 everywhere else.
 * Judges are counted from the trail, where each attempt names the provider that made it.
 */
function pointSummaries(decisions) {
  const points = new Map();
  for (const d of decisions) {
    if (!points.has(d.pointId)) points.set(d.pointId, { decisions: [], judges: new Map() });
    const point = points.get(d.pointId);
    point.decisions.push(d);
    for (const step of Array.isArray(d.trail) ? d.trail : []) {
      if (!point.judges.has(step.provider)) point.judges.set(step.provider, { attempts: 0, failures: 0, lowConfidence: 0 });
      const judge = point.judges.get(step.provider);
      judge.attempts++;
      if (step.ok !== true) judge.failures++;
      else if (step.code === 'KERNEL_LOW_CONFIDENCE') judge.lowConfidence++;
    }
  }
  return [...points.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([pointId, { decisions: all, judges }]) => {
    const failed = all.filter(d => d.provider === 'none').length;
    const escalated = all.filter(d => (d.trail?.length ?? 0) > 1).length;
    return {
      pointId, decisions: all.length, failed, failureRate: ratio(failed, all.length),
      escalated, escalationRate: ratio(escalated, all.length),
      usage: { ...usageTotals(all), providers: usageByProvider(all) },
      judges: [...judges.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([provider, j]) => ({
        provider, ...j, failureRate: ratio(j.failures, j.attempts),
      })),
    };
  });
}

/**
 * One group per pointId x provider x question type. A decision without any answers (typically a
 * failed one, provider 'none') lands in a group with type null so failures stay visible.
 */
export function calibrationReport({ decisions = [], labels: allLabels = [] } = {}, { bins = 10, threshold = 0.5, minSamples = 30, sources = null, excludeSources = [] } = {}) {
  assert(Number.isInteger(bins) && bins >= 1 && bins <= 1000, 'INVALID_CALIBRATION_OPTIONS');
  const names = list => Array.isArray(list) && list.every(x => typeof x === 'string' && x.length > 0);
  assert((sources === null || names(sources)) && names(excludeSources), 'INVALID_CALIBRATION_OPTIONS');
  // Source filters apply before anything is joined, so a filtered report never mixes in an excluded label.
  const labels = allLabels.filter(l => (sources === null || sources.includes(l.source)) && !excludeSources.includes(l.source));
  const metricsFor = (type, rows) => (type === 'noul' ? noulMetrics(rows, bins, threshold)
    : type === 'choice' ? choiceMetrics(rows, bins) : type === 'score' ? scoreMetrics(rows) : {});
  assert(typeof threshold === 'number' && threshold >= 0 && threshold <= 1, 'INVALID_CALIBRATION_OPTIONS');
  assert(Number.isInteger(minSamples) && minSamples >= 0, 'INVALID_CALIBRATION_OPTIONS');
  const groups = new Map();
  const groupFor = (pointId, provider, type) => {
    const key = JSON.stringify([pointId, provider, type]);
    if (!groups.has(key)) groups.set(key, { pointId, provider, type, decisions: new Set(), answers: 0, rows: [], invalidLabels: 0 });
    return groups.get(key);
  };
  for (const d of decisions) {
    const answers = Object.values(d.answers ?? {});
    if (!answers.length) groupFor(d.pointId, d.provider, null).decisions.add(d);
    for (const a of answers) {
      const g = groupFor(d.pointId, d.provider, a.type);
      g.decisions.add(d);
      g.answers++;
    }
  }
  for (const row of joinWithSource({ decisions, labels })) {
    const g = groupFor(row.pointId, row.provider, row.type);
    if (labelFits(row)) g.rows.push(row);
    else g.invalidLabels++;
  }
  // The same join once per source: within one source the latest label per question wins, and a label of
  // another source never replaces it. This is what keeps a weak label from being read as a verified one.
  const presentSources = [...new Set(labels.map(l => l.source))].sort();
  for (const source of presentSources) {
    for (const row of joinWithSource({ decisions, labels: labels.filter(l => l.source === source) })) {
      if (!labelFits(row)) continue;
      const g = groupFor(row.pointId, row.provider, row.type);
      g.bySource ??= new Map();
      if (!g.bySource.has(source)) g.bySource.set(source, []);
      g.bySource.get(source).push(row);
    }
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const out = [...groups.values()]
    .sort((a, b) => order(a.pointId, b.pointId) || order(a.provider, b.provider) || order(a.type ?? '', b.type ?? ''))
    .map(g => {
      const members = [...g.decisions];
      const metrics = metricsFor(g.type, g.rows);
      const strengths = new Set(g.rows.map(r => labelSourceInfo(r.source).strength));
      return {
        pointId: g.pointId, provider: g.provider, type: g.type,
        models: [...new Set(members.map(d => d.model))].sort(),
        counts: { decisions: members.length, answers: g.answers, labeled: g.rows.length },
        invalidLabels: g.invalidLabels, sufficient: g.rows.length >= minSamples,
        operational: operational(members),
        // What the labels behind `metrics` are worth: one strength, 'mixed', or null when nothing is labelled.
        metricsLabelStrength: strengths.size === 0 ? null : strengths.size === 1 ? [...strengths][0] : 'mixed',
        metrics,
        labelSources: [...(g.bySource ?? new Map()).entries()].map(([source, rows]) => ({
          source, ...labelSourceInfo(source), labeled: rows.length, sufficient: rows.length >= minSamples, metrics: metricsFor(g.type, rows),
        })),
      };
    });
  const bySource = presentSources.map(source => ({ source, ...labelSourceInfo(source), labels: labels.filter(l => l.source === source).length }));
  return { generatedFrom: { decisions: decisions.length, labels: labels.length },
    labels: { filter: { sources, excludeSources }, excludedByFilter: allLabels.length - labels.length, bySource,
      weakSources: bySource.filter(x => x.strength === 'weak').map(x => x.source),
      oneSidedSources: bySource.filter(x => x.oneSided === true).map(x => x.source),
      unclassifiedSources: bySource.filter(x => x.strength === 'unclassified').map(x => x.source), note: LABEL_NOTE },
    invalidLabels: out.reduce((n, g) => n + g.invalidLabels, 0),
    usage: { ...usageTotals(decisions), providers: usageByProvider(decisions) },
    points: pointSummaries(decisions), groups: out };
}
