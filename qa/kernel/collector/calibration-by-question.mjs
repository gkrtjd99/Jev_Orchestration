#!/usr/bin/env node
// Splits the delegation.skills calibration of one decision log by question kind (`need` vs the per-skill
// questions), for one label source. The product report groups by point x provider x answer type, and both
// kinds are noul answers of the same point, so it shows them together. Metrics come from the product's own
// calibrationReport; this file only selects rows. Offline, read-only.
//   node calibration-by-question.mjs --log-dir <absolute decisions-log dir> --source <label source>
import { DecisionLog } from '../../../orchestration/src/kernel/log.mjs';
import { calibrationReport, applyRetractions, labelSourceInfo } from '../../../orchestration/src/kernel/calibration.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args['log-dir'] || !args.source) { console.error('usage: calibration-by-question.mjs --log-dir <dir> --source <name>'); process.exit(64); }
const { decisions, labels: logged } = await new DecisionLog(args['log-dir']).read({ pointId: 'delegation.skills' });
const { labels } = applyRetractions(logged);
const labelled = new Set(labels.filter(l => l.source === args.source).map(l => l.decisionId));
const part = keep => {
  const subset = decisions.filter(d => labelled.has(d.decisionId)).map(d => ({ ...d, answers: Object.fromEntries(Object.entries(d.answers).filter(([id]) => keep(id))) }));
  const report = calibrationReport({ decisions: subset, labels: labels.filter(l => keep(l.questionId)) }, { sources: [args.source] });
  const group = report.groups.find(g => g.type === 'noul');
  return group ? { labeledDecisions: group.counts.labeledDecisions, answers: group.counts.answers, labeled: group.counts.labeled, sufficient: group.sufficient,
    sufficientReason: group.sufficientReason, metricsLabelStrength: group.metricsLabelStrength, metrics: group.metrics } : null;
};
console.log(JSON.stringify({ point: 'delegation.skills', source: args.source, sourceInfo: labelSourceInfo(args.source),
  note: 'Labelled decisions are a non-random subset of the decisions logged at this point (decisionsAtPoint); metrics are conditional on it. '
    + '`need`: one question per judge request, about that request\'s own skills. `skill`: one question per judged skill.',
  decisionsAtPoint: decisions.length, labeledDecisions: labelled.size,
  need: part(id => id === 'need'), skill: part(id => id.startsWith('skill_')) }, null, 2));
