import path from 'node:path';
import os from 'node:os';
import { options, assert } from '../src/util.mjs';
import { loadConfig } from '../src/config.mjs';
import { DecisionLog, decisionLogDir } from '../src/kernel/log.mjs';
import { calibrationReport, usageTotals } from '../src/kernel/calibration.mjs';

const KNOWN = ['action', 'config', 'log-dir', 'point', 'since', 'threshold', 'decision', 'question', 'outcome', 'source', 'exclude-source', 'type', 'limit'];
const string = x => typeof x === 'string' && x.length > 0;

async function openLog(args) {
  if (args['log-dir'] !== undefined) {
    assert(string(args['log-dir']) && path.isAbsolute(args['log-dir']), 'ABSOLUTE_DECISION_LOG_REQUIRED');
    return new DecisionLog(args['log-dir']);
  }
  const file = string(args.config) ? args.config : path.join(os.homedir(), '.config', 'jev-hooks', 'config.json');
  const { config } = await loadConfig(path.resolve(file));
  return new DecisionLog(decisionLogDir(config));
}

// Default: true/false -> boolean, pure integer -> integer, anything else -> option name.
function parseOutcome(raw, type) {
  assert(string(raw), 'INVALID_OUTCOME');
  assert(type === undefined || ['noul', 'choice', 'score'].includes(type), 'INVALID_OUTCOME_TYPE');
  const isBoolean = raw === 'true' || raw === 'false';
  const isInteger = /^\d{1,9}$/.test(raw);
  if (type === 'noul') { assert(isBoolean, 'INVALID_OUTCOME'); return raw === 'true'; }
  if (type === 'score') { assert(isInteger, 'INVALID_OUTCOME'); return Number(raw); }
  if (type === 'choice') return raw;
  return isBoolean ? raw === 'true' : isInteger ? Number(raw) : raw;
}

// --source a,b / --exclude-source a,b for the report: label sources to keep / to drop.
function sourceList(raw, fallback) {
  if (raw === undefined) return fallback;
  assert(string(raw), 'INVALID_SOURCE_FILTER');
  const list = raw.split(',').map(x => x.trim());
  assert(list.length <= 32 && list.every(x => x.length > 0 && x.length <= 128), 'INVALID_SOURCE_FILTER');
  return list;
}

function pointFilter(args) {
  if (args.point === undefined) return null;
  assert(string(args.point), 'INVALID_POINT');
  return args.point;
}

try {
  const args = options(process.argv.slice(2));
  assert(Object.keys(args).every(k => KNOWN.includes(k)), 'UNKNOWN_ARGUMENT');
  assert(['report', 'label', 'show'].includes(args.action),
    'Use --action report|label|show [--log-dir /absolute/dir | --config /absolute/config.json]; report also takes --source a,b and --exclude-source a,b');
  assert(args['exclude-source'] === undefined || args.action === 'report', 'EXCLUDE_SOURCE_IS_A_REPORT_FILTER');
  const log = await openLog(args);
  if (args.action === 'report') {
    let since = 0;
    if (args.since !== undefined) {
      since = string(args.since) ? Date.parse(args.since) : NaN;
      assert(Number.isFinite(since) && since >= 0, 'INVALID_SINCE');
    }
    let threshold = 0.5;
    if (args.threshold !== undefined) {
      threshold = string(args.threshold) ? Number(args.threshold) : NaN;
      assert(threshold >= 0 && threshold <= 1, 'INVALID_THRESHOLD');
    }
    const { corruptLines, ...data } = await log.read({ since, pointId: pointFilter(args) });
    const sources = sourceList(args.source, null);
    const excludeSources = sourceList(args['exclude-source'], []);
    console.log(JSON.stringify({ ...calibrationReport(data, { threshold, sources, excludeSources }), corruptLines }, null, 2));
  } else if (args.action === 'label') {
    assert(string(args.decision) && string(args.question) && string(args.source),
      'Use --action label --decision <id> --question <qid> --outcome <value> --source <text> [--type noul|choice|score]');
    const outcome = parseOutcome(args.outcome, args.type);
    assert(/^[0-9a-f]{64}$/.test(args.decision), 'INVALID_DECISION_ID');
    // Refuse labels that could never join, so a typo does not silently pollute the log.
    const decision = (await log.read()).decisions.find(d => d.decisionId === args.decision);
    assert(decision, 'UNKNOWN_DECISION');
    assert(Object.hasOwn(decision.answers, args.question), 'UNKNOWN_QUESTION');
    const label = await log.label(args.decision, { questionId: args.question, outcome, source: args.source });
    console.log(JSON.stringify(label, null, 2));
  } else {
    const limit = args.limit === undefined ? 20 : Number(args.limit);
    assert(string(args.limit ?? '20') && Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'INVALID_LIMIT');
    const { decisions, corruptLines } = await log.read({ pointId: pointFilter(args) });
    const shown = decisions.slice(-limit).reverse();
    // Judge tokens of the records listed here; the report action has the totals per point and provider.
    console.log(JSON.stringify({ decisions: shown, usage: usageTotals(shown), corruptLines }, null, 2));
  }
} catch (e) {
  console.error(e.code || e.message);
  process.exitCode = 1;
}
