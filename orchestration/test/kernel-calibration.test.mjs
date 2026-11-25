import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../src/util.mjs';
import { joinLabels, calibrationReport, reliabilityBins, usageTotals, applyRetractions } from '../src/kernel/calibration.mjs';

const close = (actual, expected, message) => {
  assert.equal(typeof actual, 'number', message);
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? 'value'}: ${actual} !== ${expected}`);
};

let counter = 0;
function decision(answers, overrides = {}) {
  counter++;
  return { schema: 1, decisionId: hash(`calibration-${counter}`), time: counter, pointId: 'delegation.classify', mode: 'shadow',
    provider: 'jev', model: 'fixture-model', cached: false, latencyMs: 10, confidence: 0.5, scope: 's', subject: null,
    questionsHash: hash('q'), stateHash: hash(`s${counter}`), answers,
    trail: [{ provider: 'jev', ok: true, latencyMs: 10 }], ...overrides };
}
const label = (d, questionId, outcome, time = 1000) => ({ schema: 1, time, decisionId: d.decisionId, questionId, outcome, source: 'human' });
const noul = p => ({ q: { type: 'noul', p } });
const choice = (selected, p) => ({ q: { type: 'choice', choice: selected, p, confidence: Math.max(...Object.values(p)) } });
const score = (value, p) => ({ q: { type: 'score', score: value, p, confidence: Math.max(...Object.values(p)) } });

test('noul metrics match hand-computed Brier, ECE, precision and recall', () => {
  const cases = [[0.9, true], [0.8, true], [0.7, false], [0.3, true], [0.2, false], [0.1, false]];
  const decisions = cases.map(([p]) => decision(noul(p)));
  const labels = cases.map(([, y], i) => label(decisions[i], 'q', y));
  const report = calibrationReport({ decisions, labels }, { minSamples: 6 });
  assert.deepEqual(report.generatedFrom, { decisions: 6, labels: 6 });
  assert.equal(report.groups.length, 1);
  const g = report.groups[0];
  assert.deepEqual([g.pointId, g.provider, g.type], ['delegation.classify', 'jev', 'noul']);
  assert.deepEqual(g.counts, { decisions: 6, answers: 6, labeled: 6, labeledDecisions: 6 });
  assert.equal(g.sufficient, true);
  assert.equal(g.invalidLabels, 0);
  // (0.01 + 0.04 + 0.49 + 0.49 + 0.04 + 0.01) / 6
  close(g.metrics.brier, 0.18, 'brier');
  // Each prediction sits alone in its bin: (0.1 + 0.2 + 0.7 + 0.7 + 0.2 + 0.1) / 6
  close(g.metrics.ece, 1 / 3, 'ece');
  assert.equal(g.metrics.baseRate, 0.5);
  assert.equal(g.metrics.threshold, 0.5);
  assert.deepEqual([g.metrics.tp, g.metrics.fp, g.metrics.tn, g.metrics.fn], [2, 1, 2, 1]);
  close(g.metrics.precision, 2 / 3, 'precision');
  close(g.metrics.recall, 2 / 3, 'recall');
  close(g.metrics.f1, 2 / 3, 'f1');

  // Two bins: [0,0.5) mean 0.2 vs observed 1/3; [0.5,1] mean 0.8 vs observed 2/3.
  close(calibrationReport({ decisions, labels }, { bins: 2 }).groups[0].metrics.ece, 0.4 / 3, 'ece with 2 bins');
  assert.equal(calibrationReport({ decisions, labels }).groups[0].sufficient, false);

  // A stricter threshold moves 0.8 and 0.7 to the negative side.
  const strict = calibrationReport({ decisions, labels }, { threshold: 0.85 }).groups[0].metrics;
  assert.deepEqual([strict.tp, strict.fp, strict.tn, strict.fn], [1, 0, 3, 2]);
  assert.equal(strict.precision, 1);
  close(strict.recall, 1 / 3, 'recall');
  close(strict.f1, 0.5, 'f1');
});

test('reliability bins expose per-bin counts, means and observed rates', () => {
  const table = reliabilityBins([{ p: 0.1, y: 0 }, { p: 0.3, y: true }, { p: 0.5, y: 1 }, { p: 1, y: false }], 2);
  assert.equal(table.length, 2);
  assert.deepEqual([table[0].lower, table[0].upper, table[0].count], [0, 0.5, 2]);
  close(table[0].meanPredicted, 0.2);
  assert.equal(table[0].observedRate, 0.5);
  // 0.5 opens the upper bin and 1.0 is included in it.
  assert.deepEqual([table[1].lower, table[1].upper, table[1].count], [0.5, 1, 2]);
  assert.equal(table[1].meanPredicted, 0.75);
  assert.equal(table[1].observedRate, 0.5);

  const empty = reliabilityBins([], 4);
  assert.equal(empty.length, 4);
  for (const bin of empty) assert.deepEqual([bin.count, bin.meanPredicted, bin.observedRate], [0, null, null]);
  assert.throws(() => reliabilityBins([], 0), e => e.code === 'INVALID_CALIBRATION_OPTIONS');
});

test('choice metrics match hand-computed multiclass Brier, accuracy and top-label ECE', () => {
  const decisions = [
    decision(choice('a', { a: 0.7, b: 0.2, c: 0.1 })),
    decision(choice('a', { a: 0.5, b: 0.3, c: 0.2 })),
    decision(choice('c', { a: 0.1, b: 0.1, c: 0.8 })),
  ];
  const labels = [label(decisions[0], 'q', 'a'), label(decisions[1], 'q', 'b'), label(decisions[2], 'q', 'c')];
  const g = calibrationReport({ decisions, labels }).groups[0];
  assert.equal(g.type, 'choice');
  // (0.09+0.04+0.01) + (0.25+0.49+0.04) + (0.01+0.01+0.04) = 0.98
  close(g.metrics.brier, 0.98 / 3, 'brier');
  close(g.metrics.accuracy, 2 / 3, 'accuracy');
  close(g.metrics.meanConfidence, 2 / 3, 'meanConfidence');
  // |0.7-1| + |0.5-0| + |0.8-1| over three single-row bins
  close(g.metrics.ece, 1 / 3, 'ece');
});

test('score metrics match hand-computed MAE and exact-level accuracy', () => {
  const decisions = [
    decision(score(2.4, { 0: 0.1, 1: 0.2, 2: 0.6, 3: 0.1 })),
    decision(score(1.0, { 0: 0.3, 1: 0.4, 2: 0.3 })),
  ];
  const labels = [label(decisions[0], 'q', 2), label(decisions[1], 'q', 0)];
  const g = calibrationReport({ decisions, labels }).groups[0];
  assert.equal(g.type, 'score');
  // (|2.4-2| + |1.0-0|) / 2
  close(g.metrics.mae, 0.7, 'mae');
  assert.equal(g.metrics.exactLevelAccuracy, 0.5);
});

test('metrics are null, never 0, without labeled rows or with an undefined denominator', () => {
  const decisions = [
    decision(noul(0.2)),
    decision(choice('a', { a: 0.6, b: 0.4 }), { pointId: 'failure.classify' }),
    decision(score(1, { 0: 0.2, 1: 0.8 }), { pointId: 'supervisor.outcome' }),
  ];
  const report = calibrationReport({ decisions, labels: [] });
  assert.equal(report.invalidLabels, 0);
  const by = type => report.groups.find(g => g.type === type);
  assert.deepEqual(report.groups.map(g => g.pointId), ['delegation.classify', 'failure.classify', 'supervisor.outcome']);
  for (const key of ['brier', 'ece', 'baseRate', 'precision', 'recall', 'f1']) assert.equal(by('noul').metrics[key], null, key);
  assert.deepEqual([by('noul').metrics.tp, by('noul').metrics.fp, by('noul').metrics.tn, by('noul').metrics.fn], [0, 0, 0, 0]);
  for (const key of ['brier', 'accuracy', 'ece', 'meanConfidence']) assert.equal(by('choice').metrics[key], null, key);
  for (const key of ['mae', 'exactLevelAccuracy']) assert.equal(by('score').metrics[key], null, key);
  for (const g of report.groups) {
    assert.equal(g.counts.labeled, 0);
    assert.equal(g.sufficient, false);
    assert.equal(g.operational.cachedRate, 0);
  }

  // Labeled, but nothing predicted positive and nothing actually positive.
  const negatives = [decision(noul(0.1)), decision(noul(0.2))];
  const m = calibrationReport({ decisions: negatives, labels: negatives.map(d => label(d, 'q', false)) }).groups[0].metrics;
  assert.equal(m.precision, null);
  assert.equal(m.recall, null);
  assert.equal(m.f1, null);
  assert.equal(m.baseRate, 0);
  assert.equal(m.tn, 2);
  close(m.brier, 0.025, 'brier');

  const { labels: labelSummary, ...emptyReport } = calibrationReport({ decisions: [], labels: [] });
  assert.deepEqual(emptyReport, { generatedFrom: { decisions: 0, labels: 0 }, invalidLabels: 0,
    usage: { reported: 0, input_tokens: null, output_tokens: null, providers: [] }, points: [], groups: [] });
  assert.deepEqual([labelSummary.bySource, labelSummary.weakSources, labelSummary.excludedByFilter], [[], [], 0]);
  assert.throws(() => calibrationReport({ decisions: [], labels: [] }, { threshold: 2 }), e => e.code === 'INVALID_CALIBRATION_OPTIONS');
  assert.throws(() => calibrationReport({ decisions: [], labels: [] }, { bins: 0 }), e => e.code === 'INVALID_CALIBRATION_OPTIONS');
});

test('latest label wins and labels for unknown decisions or questions are dropped', () => {
  const d = decision({ ...noul(0.9), role: { type: 'choice', choice: 'a', p: { a: 0.9, b: 0.1 }, confidence: 0.9 } });
  const labels = [
    label(d, 'q', false, 100),
    label(d, 'q', true, 300),
    label(d, 'q', false, 200),
    label(d, 'role', 'b', 100),
    label(d, 'role', 'a', 100),
    label(d, 'missing', true, 400),
    label(d, 'constructor', true, 400),
    { ...label(d, 'q', false, 500), decisionId: hash('unknown') },
  ];
  const rows = joinLabels({ decisions: [d], labels });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(r => r.questionId === 'q'), { pointId: 'delegation.classify', provider: 'jev', model: 'fixture-model',
    mode: 'shadow', questionId: 'q', type: 'noul', answer: { type: 'noul', p: 0.9 }, outcome: true });
  // Equal timestamps: the later-appended label wins.
  assert.equal(rows.find(r => r.questionId === 'role').outcome, 'a');
  const report = calibrationReport({ decisions: [d], labels });
  close(report.groups.find(g => g.type === 'noul').metrics.brier, 0.01, 'brier');
  assert.equal(report.groups.find(g => g.type === 'choice').metrics.accuracy, 1);
  assert.deepEqual(joinLabels(), []);
});

test('labels that do not fit the answer are counted as invalid and excluded', () => {
  const n = decision(noul(0.6));
  const c = decision(choice('a', { a: 0.6, b: 0.4 }));
  const s = decision(score(1, { 0: 0.2, 1: 0.8 }));
  const ok = decision(noul(0.6));
  const labels = [
    label(n, 'q', 'yes'), // string for a noul
    label(c, 'q', 'z'), // not one of the options
    label(s, 'q', 5), // level outside the scale
    label(ok, 'q', true),
  ];
  const report = calibrationReport({ decisions: [n, c, s, ok], labels });
  assert.equal(report.invalidLabels, 3);
  const by = type => report.groups.find(g => g.type === type);
  assert.deepEqual([by('noul').invalidLabels, by('choice').invalidLabels, by('score').invalidLabels], [1, 1, 1]);
  assert.deepEqual(by('noul').counts, { decisions: 2, answers: 2, labeled: 1, labeledDecisions: 1 });
  close(by('noul').metrics.brier, 0.16, 'brier');
  assert.equal(by('choice').metrics.accuracy, null);
  assert.equal(by('score').metrics.mae, null);
  // A boolean is not a score level and an integer is not a choice option.
  const cross = calibrationReport({ decisions: [c, s], labels: [label(c, 'q', 1), label(s, 'q', true)] });
  assert.equal(cross.invalidLabels, 2);
});

test('operational metrics cover all decisions and split groups by point, provider and type', () => {
  const decisions = [
    decision(noul(0.5), { latencyMs: 10, cached: true, confidence: 0.9 }),
    decision(noul(0.5), { latencyMs: 20, confidence: 0.7 }),
    decision(noul(0.5), { latencyMs: 30, confidence: null,
      trail: [{ provider: 'local', ok: false, code: 'LOW_CONFIDENCE', latencyMs: 5 }, { provider: 'jev', ok: true, latencyMs: 25 }] }),
    decision(noul(0.5), { latencyMs: 400, confidence: 0.8, model: 'other-model' }),
    decision(noul(0.5), { provider: 'local', model: 'local-model', latencyMs: 1 }),
    decision({}, { provider: 'none', model: 'none', confidence: null, latencyMs: 50,
      trail: [{ provider: 'jev', ok: false, code: 'JEV_TIMEOUT', latencyMs: 40 }, { provider: 'local', ok: false, code: 'LOCAL_FAILED', latencyMs: 10 }] }),
  ];
  const report = calibrationReport({ decisions, labels: [] });
  assert.deepEqual(report.groups.map(g => [g.provider, g.type]), [['jev', 'noul'], ['local', 'noul'], ['none', null]]);
  const jev = report.groups[0];
  assert.deepEqual(jev.models, ['fixture-model', 'other-model']);
  assert.equal(jev.counts.decisions, 4);
  assert.equal(jev.operational.cachedRate, 0.25);
  // Failure and escalation are point-level facts; a per-provider failure rate would be 0 or 1 by construction.
  assert.deepEqual(Object.keys(jev.operational).sort(), ['cachedRate', 'latencyMs', 'meanConfidence', 'usage']);
  // None of these records carries usage: the totals are null, not 0.
  assert.deepEqual(jev.operational.usage, { reported: 0, input_tokens: null, output_tokens: null });
  // Nearest rank over [10, 20, 30, 400].
  assert.deepEqual(jev.operational.latencyMs, { p50: 20, p95: 400 });
  close(jev.operational.meanConfidence, 0.8, 'meanConfidence');
  const failed = report.groups[2];
  assert.deepEqual(failed.counts, { decisions: 1, answers: 0, labeled: 0, labeledDecisions: 0 });
  assert.equal(failed.operational.meanConfidence, null);
  assert.deepEqual(failed.metrics, {});

  assert.equal(report.points.length, 1);
  const point = report.points[0];
  assert.deepEqual([point.pointId, point.decisions, point.failed, point.escalated], ['delegation.classify', 6, 1, 2]);
  close(point.failureRate, 1 / 6, 'failureRate');
  close(point.escalationRate, 2 / 6, 'escalationRate');
  assert.deepEqual(point.judges, [
    { provider: 'jev', attempts: 6, failures: 1, lowConfidence: 0, failureRate: 1 / 6 },
    { provider: 'local', attempts: 2, failures: 2, lowConfidence: 0, failureRate: 1 },
  ]);
});

test('failure and escalation rates are reported per point across all of its decisions', () => {
  const failedTrail = [{ provider: 'jev', ok: false, code: 'JEV_TIMEOUT', latencyMs: 40 }];
  const none = { provider: 'none', model: 'none', confidence: null };
  const decisions = [
    decision(noul(0.9)),
    decision({}, { ...none, trail: failedTrail }),
    decision({}, { ...none, trail: failedTrail }),
    // A held low-confidence answer that stood after the escalation judge failed.
    decision(noul(0.6), { pointId: 'read.advice', provider: 'local', trail: [
      { provider: 'local', ok: true, code: 'KERNEL_LOW_CONFIDENCE', confidence: 0.2, latencyMs: 1 },
      { provider: 'jev', ok: false, code: 'JEV_CIRCUIT_OPEN', latencyMs: 2 }] }),
    decision(noul(0.6), { pointId: 'read.advice', trail: undefined }),
  ];
  const report = calibrationReport({ decisions, labels: [] });
  // The provider groups alone cannot show 2/3: the failures sit in their own 'none' group.
  assert.deepEqual(report.groups.filter(g => g.pointId === 'delegation.classify').map(g => [g.provider, g.counts.decisions]), [['jev', 1], ['none', 2]]);
  const [classify, read] = report.points;
  assert.deepEqual([classify.pointId, classify.decisions, classify.failed, classify.escalated, classify.escalationRate], ['delegation.classify', 3, 2, 0, 0]);
  close(classify.failureRate, 2 / 3, 'failureRate');
  assert.deepEqual(classify.judges, [{ provider: 'jev', attempts: 3, failures: 2, lowConfidence: 0, failureRate: 2 / 3 }]);
  assert.deepEqual([read.pointId, read.decisions, read.failed, read.failureRate, read.escalated, read.escalationRate], ['read.advice', 2, 0, 0, 1, 0.5]);
  assert.deepEqual(read.judges, [
    { provider: 'jev', attempts: 1, failures: 1, lowConfidence: 0, failureRate: 1 },
    { provider: 'local', attempts: 1, failures: 0, lowConfidence: 1, failureRate: 0 },
  ]);
});

test('judge token usage is totalled per point and per provider, each record once, and null stays null', () => {
  const usage = (input_tokens, output_tokens) => ({ usage: { input_tokens, output_tokens } });
  const both = { ...noul(0.9), role: { type: 'choice', choice: 'a', p: { a: 0.7, b: 0.3 }, confidence: 0.7 } };
  const decisions = [
    decision(both, usage(1000, 200)),                                             // two answer types: in two groups, counted once
    decision(noul(0.2), usage(500, null)),                                        // the judge gave no output count
    decision(noul(0.3)),                                                          // a record from before the field existed
    decision(noul(0.4), { cached: true }),                                        // a cache hit carries no usage
    decision(noul(0.5), { provider: 'openai', model: 'other', ...usage(70, 7) }),
    decision(noul(0.6), { pointId: 'delegation.skills', ...usage(3000, 600) }),
    decision(noul(0.7), { pointId: 'delegation.skills', ...usage(3100, 610) }),   // chunked skills: one record per request
    decision({}, { pointId: 'delegation.skills', provider: 'none', model: 'none', confidence: null }), // a failed decision
    decision(noul(0.8), { pointId: 'supervisor.outcome', provider: 'local', model: 'local-rules', ...usage(0, 0) }),
    decision(noul(0.8), { pointId: 'read.advice', ...usage(null, null) }),
  ];
  const report = calibrationReport({ decisions, labels: [] });
  assert.deepEqual(report.usage, { reported: 7, input_tokens: 7670, output_tokens: 1417, providers: [
    { provider: 'jev', decisions: 7, reported: 5, input_tokens: 7600, output_tokens: 1410 },
    { provider: 'local', decisions: 1, reported: 1, input_tokens: 0, output_tokens: 0 },
    { provider: 'none', decisions: 1, reported: 0, input_tokens: null, output_tokens: null },
    { provider: 'openai', decisions: 1, reported: 1, input_tokens: 70, output_tokens: 7 },
  ] });
  const point = id => report.points.find(p => p.pointId === id).usage;
  assert.deepEqual(point('delegation.classify'), { reported: 3, input_tokens: 1570, output_tokens: 207, providers: [
    { provider: 'jev', decisions: 4, reported: 2, input_tokens: 1500, output_tokens: 200 },
    { provider: 'openai', decisions: 1, reported: 1, input_tokens: 70, output_tokens: 7 },
  ] });
  assert.deepEqual(point('delegation.skills'), { reported: 2, input_tokens: 6100, output_tokens: 1210, providers: [
    { provider: 'jev', decisions: 2, reported: 2, input_tokens: 6100, output_tokens: 1210 },
    { provider: 'none', decisions: 1, reported: 0, input_tokens: null, output_tokens: null },
  ] });
  // A local judge really reports zero; a judge that reported nothing usable stays null.
  assert.deepEqual(point('supervisor.outcome'), { reported: 1, input_tokens: 0, output_tokens: 0, providers: [
    { provider: 'local', decisions: 1, reported: 1, input_tokens: 0, output_tokens: 0 }] });
  assert.deepEqual(point('read.advice'), { reported: 1, input_tokens: null, output_tokens: null, providers: [
    { provider: 'jev', decisions: 1, reported: 1, input_tokens: null, output_tokens: null }] });
  // The per-group operational section: the two-type record appears in both of its groups.
  const group = (pointId, provider, type) => report.groups.find(g => g.pointId === pointId && g.provider === provider && g.type === type).operational.usage;
  assert.deepEqual(group('delegation.classify', 'jev', 'noul'), { reported: 2, input_tokens: 1500, output_tokens: 200 });
  assert.deepEqual(group('delegation.classify', 'jev', 'choice'), { reported: 1, input_tokens: 1000, output_tokens: 200 });
  assert.deepEqual(group('delegation.skills', 'none', null), { reported: 0, input_tokens: null, output_tokens: null });
  assert.deepEqual(usageTotals([]), { reported: 0, input_tokens: null, output_tokens: null });
});

test('sufficiency counts labelled decisions, and weak labels are never sufficient', () => {
  // One wide decision with 40 dependent questions: 40 labels, one decision.
  const wide = decision(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`skill_${i}`, { type: 'noul', p: 0.1 }])), { pointId: 'delegation.skills' });
  const many = Array.from({ length: 40 }, (_, i) => ({ ...label(wide, `skill_${i}`, false), source: 'human' }));
  const one = calibrationReport({ decisions: [wide], labels: many }).groups[0];
  assert.deepEqual([one.counts.labeled, one.counts.labeledDecisions, one.sufficient, one.sufficientReason], [40, 1, false, 'too_few_labeled_decisions']);

  // 40 decisions with one label each.
  const decisions = Array.from({ length: 40 }, () => decision({ q: { type: 'noul', p: 0.2 } }));
  const by = source => decisions.map(d => ({ ...label(d, 'q', false), source }));
  const human = calibrationReport({ decisions, labels: by('human') }).groups[0];
  assert.deepEqual([human.counts.labeledDecisions, human.sufficient, human.sufficientReason], [40, true, null]);
  for (const source of ['observed-load', 'observed-load-after-injection', 'external-verification-with-load']) {
    const weak = calibrationReport({ decisions, labels: by(source) }).groups[0];
    assert.deepEqual([weak.counts.labeled, weak.sufficient, weak.sufficientReason, weak.metricsLabelStrength], [40, false, 'weak_labels', 'weak'], source);
    assert.deepEqual(weak.labelSources.map(s => [s.labeledDecisions, s.sufficient, s.sufficientReason]), [[40, false, 'weak_labels']]);
  }
  const none = calibrationReport({ decisions, labels: [] }).groups[0];
  assert.deepEqual([none.sufficient, none.sufficientReason], [false, 'no_labels']);
});

test('a retraction marker takes back earlier labels of its source only; a later label stands again', () => {
  const d = decision({ q: { type: 'noul', p: 0.9 } });
  const at = (source, outcome, time) => ({ ...label(d, 'q', outcome, time), source });
  const labels = [at('external-verification-with-load', true, 1), at('human', false, 2), at('external-verification-with-load:retracted', true, 3)];
  const { labels: kept, retracted, markers } = applyRetractions(labels);
  assert.deepEqual([kept.map(l => l.source), retracted, markers], [['human'], 1, 1]);
  const report = calibrationReport({ decisions: [d], labels });
  assert.deepEqual([report.generatedFrom.labels, report.labels.retracted, report.labels.retractionMarkers, report.labels.bySource.map(s => s.source)], [1, 1, 1, ['human']]);
  assert.deepEqual(joinLabels({ decisions: [d], labels }).map(r => r.outcome), [false]);
  // A filter on the retracted source sees nothing, not the retracted label.
  assert.equal(calibrationReport({ decisions: [d], labels }, { sources: ['external-verification-with-load'] }).generatedFrom.labels, 0);
  const again = [...labels, at('external-verification-with-load', true, 4)];
  assert.deepEqual(applyRetractions(again).labels.map(l => [l.source, l.time]), [['human', 2], ['external-verification-with-load', 4]]);
});
