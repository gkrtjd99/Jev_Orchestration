#!/usr/bin/env node
// Splits the delegation.skills calibration of one decision log by question kind (`need` vs the per-skill
// questions), for one label source. The product report groups by point x provider x answer type, and both
// kinds are noul answers of the same point, so it shows them together. Metrics come from the product's own
// calibrationReport; this file only selects rows. Offline, read-only.
//   node calibration-by-question.mjs --log-dir <absolute decisions-log dir> --source <label source>
import { DecisionLog } from '../../../orchestration/src/kernel/log.mjs';
import { calibrationReport } from '../../../orchestration/src/kernel/calibration.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args['log-dir'] || !args.source) { console.error('usage: calibration-by-question.mjs --log-dir <dir> --source <name>'); process.exit(64); }
const { decisions, labels } = await new DecisionLog(args['log-dir']).read({ pointId: 'delegation.skills' });
const labelled = new Set(labels.filter(l => l.source === args.source).map(l => l.decisionId));
const part = keep => {
  const subset = decisions.filter(d => labelled.has(d.decisionId)).map(d => ({ ...d, answers: Object.fromEntries(Object.entries(d.answers).filter(([id]) => keep(id))) }));
  const report = calibrationReport({ decisions: subset, labels: labels.filter(l => keep(l.questionId)) }, { sources: [args.source] });
  const group = report.groups.find(g => g.type === 'noul');
  return group ? { decisions: group.counts.decisions, answers: group.counts.answers, labeled: group.counts.labeled, sufficient: group.sufficient,
    metricsLabelStrength: group.metricsLabelStrength, metrics: group.metrics } : null;
};
console.log(JSON.stringify({ point: 'delegation.skills', source: args.source,
  note: 'Decisions without a label of this source are left out. `need`: one question per judge request. `skill`: one question per judged skill.',
  need: part(id => id === 'need'), skill: part(id => id.startsWith('skill_')) }, null, 2));
