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

/** Latest label per (decisionId, questionId) wins; labels for unknown decisions/questions are dropped. */
export function joinLabels({ decisions = [], labels = [] } = {}) {
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
      questionId: label.questionId, type: answer.type, answer, outcome: label.outcome });
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

function operational(decisions) {
  const latencies = decisions.map(d => d.latencyMs).sort((a, b) => a - b);
  const n = decisions.length;
  return {
    cachedRate: ratio(decisions.filter(d => d.cached).length, n),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    escalationRate: ratio(decisions.filter(d => (d.trail?.length ?? 0) > 1).length, n),
    failureRate: ratio(decisions.filter(d => d.provider === 'none').length, n),
    meanConfidence: mean(decisions.map(d => d.confidence).filter(c => typeof c === 'number')),
  };
}

/**
 * One group per pointId x provider x question type. A decision without any answers (typically a
 * failed one, provider 'none') lands in a group with type null so failures stay visible.
 */
export function calibrationReport({ decisions = [], labels = [] } = {}, { bins = 10, threshold = 0.5, minSamples = 30 } = {}) {
  assert(Number.isInteger(bins) && bins >= 1 && bins <= 1000, 'INVALID_CALIBRATION_OPTIONS');
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
  for (const row of joinLabels({ decisions, labels })) {
    const g = groupFor(row.pointId, row.provider, row.type);
    if (labelFits(row)) g.rows.push(row);
    else g.invalidLabels++;
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const out = [...groups.values()]
    .sort((a, b) => order(a.pointId, b.pointId) || order(a.provider, b.provider) || order(a.type ?? '', b.type ?? ''))
    .map(g => {
      const members = [...g.decisions];
      const metrics = g.type === 'noul' ? noulMetrics(g.rows, bins, threshold)
        : g.type === 'choice' ? choiceMetrics(g.rows, bins)
        : g.type === 'score' ? scoreMetrics(g.rows) : {};
      return {
        pointId: g.pointId, provider: g.provider, type: g.type,
        models: [...new Set(members.map(d => d.model))].sort(),
        counts: { decisions: members.length, answers: g.answers, labeled: g.rows.length },
        invalidLabels: g.invalidLabels, sufficient: g.rows.length >= minSamples,
        operational: operational(members), metrics,
      };
    });
  return { generatedFrom: { decisions: decisions.length, labels: labels.length },
    invalidLabels: out.reduce((n, g) => n + g.invalidLabels, 0), groups: out };
}
