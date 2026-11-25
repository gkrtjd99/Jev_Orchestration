// Pure statistics for the kernel evaluation. No IO.
// Convention (same as the product's calibration.mjs): an undefined denominator gives null, never 0.

export const ratio = (n, d) => (d > 0 ? n / d : null);
export const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Nearest-rank percentile over an ascending array (same rule as the product's calibration report). */
export function percentile(sorted, q) {
  return sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null;
}

export function latencySummary(values) {
  const xs = values.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  return {
    n: xs.length, p50: percentile(xs, 0.5), p90: percentile(xs, 0.9), p95: percentile(xs, 0.95),
    max: xs.length ? xs[xs.length - 1] : null, mean: mean(xs),
  };
}

export function prf(tp, fp, fn) {
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

/** pairs: [{pred: boolean, gold: boolean}] */
export function binaryMetrics(pairs) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const { pred, gold } of pairs) {
    if (pred && gold) tp++; else if (pred) fp++; else if (gold) fn++; else tn++;
  }
  return { n: pairs.length, tn, accuracy: ratio(tp + tn, pairs.length), ...prf(tp, fp, fn) };
}

/** Cohen's kappa for two equal-length label arrays. kappa is null when chance agreement is 1. */
export function cohenKappa(a, b) {
  const n = a.length;
  if (!n || n !== b.length) return { n, observed: null, expected: null, kappa: null };
  const labels = [...new Set([...a, ...b].map(String))];
  let agree = 0;
  const ca = new Map(), cb = new Map();
  for (let i = 0; i < n; i++) {
    const x = String(a[i]), y = String(b[i]);
    if (x === y) agree++;
    ca.set(x, (ca.get(x) ?? 0) + 1);
    cb.set(y, (cb.get(y) ?? 0) + 1);
  }
  const observed = agree / n;
  const expected = labels.reduce((s, l) => s + ((ca.get(l) ?? 0) / n) * ((cb.get(l) ?? 0) / n), 0);
  return { n, observed, expected, kappa: expected >= 1 ? null : (observed - expected) / (1 - expected) };
}

/** Equal-width reliability bins; the last bin is closed on the right. pairs: [{p, y: 0|1|boolean}] */
export function reliability(pairs, bins = 10) {
  const table = Array.from({ length: bins }, (_, i) => ({ lower: i / bins, upper: (i + 1) / bins, count: 0, sumP: 0, sumY: 0 }));
  for (const { p, y } of pairs) {
    const bin = table[Math.min(bins - 1, Math.max(0, Math.floor(p * bins)))];
    bin.count++; bin.sumP += p; bin.sumY += y ? 1 : 0;
  }
  return table.map(b => ({ lower: b.lower, upper: b.upper, count: b.count, meanPredicted: ratio(b.sumP, b.count), observedRate: ratio(b.sumY, b.count) }));
}

export function ece(pairs, bins = 10) {
  if (!pairs.length) return null;
  return reliability(pairs, bins).reduce((s, b) => s + (b.count ? (b.count / pairs.length) * Math.abs(b.meanPredicted - b.observedRate) : 0), 0);
}

/** Binary calibration summary. pairs: [{p, y}] */
export function binaryCalibration(pairs, bins = 10) {
  return {
    n: pairs.length,
    brier: mean(pairs.map(({ p, y }) => (p - (y ? 1 : 0)) ** 2)),
    ece: ece(pairs, bins),
    baseRate: mean(pairs.map(x => (x.y ? 1 : 0))),
    meanPredicted: mean(pairs.map(x => x.p)),
    reliability: reliability(pairs, bins),
  };
}

/** Multi-class calibration. rows: [{p: {option: prob}, choice, y: gold option}] */
export function choiceCalibration(rows, bins = 10) {
  const top = rows.map(r => ({ p: Math.max(...Object.values(r.p)), y: r.choice === r.y ? 1 : 0 }));
  return {
    n: rows.length,
    brier: mean(rows.map(r => Object.entries(r.p).reduce((s, [o, p]) => s + (p - (o === r.y ? 1 : 0)) ** 2, 0))),
    accuracy: mean(top.map(x => x.y)),
    ece: ece(top, bins),
    meanConfidence: mean(top.map(x => x.p)),
    reliability: reliability(top, bins),
  };
}

export function countBy(items, key) {
  const out = {};
  for (const item of items) { const k = String(key(item)); out[k] = (out[k] ?? 0) + 1; }
  return out;
}

export function groupBy(items, key) {
  const out = new Map();
  for (const item of items) { const k = String(key(item)); if (!out.has(k)) out.set(k, []); out.get(k).push(item); }
  return out;
}

export const setEqual = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
