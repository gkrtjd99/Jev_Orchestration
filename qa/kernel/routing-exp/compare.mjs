#!/usr/bin/env node
// Side-by-side reading of the three arm files written by analyze.mjs. Offline, read-only.
//   node compare.mjs --n <armN.json> --r <armR.json> --l <armL.json> [--prices <prices.json>]
//                    [--collector-r <collect summary.json>] [--collector-l <collect summary.json>] [--json]
// Prints, per task, what each arm did (checker result, routed profile, effective model and effort, tokens), and per
// arm: tasks passed (of 12, by tier, by effective model), tokens PER MODEL (tokens of different models are not
// interchangeable and are never added together), Main-session tokens, judge cost, wall time and the routed
// profile distribution. With --collector-r / --collector-l (the JSON summaries collect.mjs printed) it also shows
// how many evaluation rows the collector produced and withheld, and why.
//
// Money appears ONLY with --prices. No price is shipped with this repository. The file is written by whoever
// runs this, with a source and a date:
//   { "currency": "USD", "source": "<where the prices come from>", "checkedAt": "<date>",
//     "perMillionTokens": { "<model id as recorded>": { "input": 0, "output": 0, "cacheRead": 0, "cacheCreation": 0 } } }
// A model without a complete price entry, or with an unmeasured token kind, gets no estimate. Judge requests are
// not priced.
// The numbers are descriptive: one run per arm, twelve tasks. No significance, no generalisation.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheCreation'];
const ARM_ORDER = ['N', 'R', 'L'];
const TIERS = ['routine', 'moderate', 'hard'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const show = (value) => (value === null || value === undefined ? '-' : String(value));
const count = (n) => (n === null || n === undefined ? '-' : n.toLocaleString('en-US'));
const seconds = (ms) => (ms === null || ms === undefined ? '-' : `${Math.round(ms / 1000)}s`);
const shortModel = (model) => (model ? model.replace(/^claude-/, '') : '-');
const shortProfile = (profile) => (profile ? profile.replace(/^jev4_/, '').replace(/_[0-9a-f]{10}$/, '') : '-');

function table(headers, rows) {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => String(row[i]).length)));
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

export function loadPrices(file) {
  const prices = JSON.parse(readFileSync(file, 'utf8'));
  const ok = isObject(prices) && typeof prices.currency === 'string' && typeof prices.source === 'string' && prices.source !== ''
    && typeof prices.checkedAt === 'string' && prices.checkedAt !== '' && isObject(prices.perMillionTokens);
  if (!ok) throw new Error('a prices file needs currency, source, checkedAt and perMillionTokens');
  for (const [model, entry] of Object.entries(prices.perMillionTokens)) {
    if (!isObject(entry) || !TOKEN_KEYS.every((key) => typeof entry[key] === 'number' && Number.isFinite(entry[key]) && entry[key] >= 0)) {
      throw new Error(`prices for ${model} need input, output, cacheRead and cacheCreation as numbers`);
    }
  }
  return prices;
}

/** Cost of one token bucket of one model, or null with the reason. */
export function estimate(tokens, model, prices) {
  const price = prices.perMillionTokens[model];
  if (!price) return { cost: null, reason: `no price for ${model}` };
  if (!TOKEN_KEYS.every((key) => Number.isSafeInteger(tokens?.[key]))) return { cost: null, reason: `a token kind of ${model} is unmeasured` };
  return { cost: TOKEN_KEYS.reduce((sum, key) => sum + (tokens[key] * price[key]) / 1e6, 0), reason: null };
}

function armSummary(arm, prices, collector) {
  const t = arm.totals;
  const tiers = Object.fromEntries(TIERS.map((tier) => [tier, t.byDifficulty?.[tier] ?? null]));
  const models = Object.fromEntries(Object.entries(t.subagentsByModel ?? {}).sort());
  const mainModels = Object.fromEntries(Object.entries(arm.main?.tokensByModel ?? {}).sort());
  let cost = null;
  if (prices) {
    const parts = [];
    for (const [model, bucket] of Object.entries(models)) parts.push({ where: 'subagents', model, ...estimate(bucket, model, prices) });
    for (const [model, bucket] of Object.entries(mainModels)) parts.push({ where: 'main', model, ...estimate(bucket, model, prices) });
    for (const [model, bucket] of Object.entries(t.unlinkedSubagents?.tokensByModel ?? {})) parts.push({ where: 'unlinked subagents', model, ...estimate(bucket, model, prices) });
    const complete = parts.length > 0 && parts.every((part) => part.cost !== null);
    cost = { currency: prices.currency, source: prices.source, checkedAt: prices.checkedAt, parts,
      total: complete ? parts.reduce((sum, part) => sum + part.cost, 0) : null,
      subagents: parts.filter((p) => p.where === 'subagents').every((p) => p.cost !== null) && parts.some((p) => p.where === 'subagents') ? parts.filter((p) => p.where === 'subagents').reduce((s, p) => s + p.cost, 0) : null,
      missing: parts.filter((part) => part.cost === null).map((part) => `${part.where}: ${part.reason}`), judgeRequestsPriced: false };
  }
  return {
    arm: arm.arm, name: arm.armName, tasks: t.tasks, delegated: t.delegated, done: t.done, passed: t.passed, byDifficulty: tiers,
    subagentsByModel: models, mainByModel: mainModels, mainApiTurns: arm.main?.apiTurns ?? null, mainWallMs: arm.main?.wallMs ?? null,
    mainEfforts: arm.main?.efforts ?? null, agentCalls: arm.main?.agentCalls ?? null, refusedCalls: arm.main?.refusedCalls ?? null,
    subagentWallMs: t.subagentWallMs, subagentEndToEndMs: t.subagentEndToEndMs, routing: t.routing, judge: t.judge,
    unlinkedSubagents: t.unlinkedSubagents, host: arm.host, warnings: arm.warnings.length, taskNotes: arm.tasks.reduce((n, row) => n + row.notes.length, 0),
    unattributedChanges: arm.unattributedChanges?.length ?? null, cost,
    collector: collector ? { context: collector.evaluations?.context ?? null, produced: collector.evaluations?.produced ?? null,
      producedByModelMatch: collector.evaluations?.producedByModelMatch ?? null, withheldTasks: collector.evaluations?.withheldTasks ?? null,
      withheld: collector.evaluations?.withheld ?? null, delegationsSeen: collector.delegations?.seen ?? null, joined: collector.delegations?.joined ?? null,
      modelMatch: collector.modelMatch?.delegations ?? null, verificationMatched: collector.verification?.matched ?? null } : null,
  };
}

export function compareArms(arms, { prices = null, collectors = {} } = {}) {
  const present = ARM_ORDER.filter((key) => arms[key]);
  for (const key of present) if (arms[key].arm !== key) throw new Error(`the file given as arm ${key} was analysed as arm ${arms[key].arm}`);
  const versions = new Set(present.map((key) => `${arms[key].checker?.version}/${arms[key].checker?.tasksFile}`));
  const ids = arms[present[0]].tasks.map((task) => task.id);
  const tasks = ids.map((id) => {
    const row = { id };
    for (const key of present) {
      const task = arms[key].tasks.find((entry) => entry.id === id) ?? null;
      row.lang ??= task?.lang; row.difficulty ??= task?.difficulty;
      row[key] = task ? {
        delegated: task.delegation.delegated, done: task.counted.done, passed: task.counted.passed, failedChecks: task.check.failed?.length ?? null,
        agentType: task.subagent?.agentType ?? null, model: task.subagent?.model ?? null, effort: task.subagent?.effort ?? null,
        tokens: task.subagent?.tokens ?? null, apiTurns: task.subagent?.apiTurns ?? null, toolCalls: task.subagent?.toolCalls ?? null, wallMs: task.subagent?.wallMs ?? null,
        agentCalls: task.delegation.agentCalls, refusedCalls: task.delegation.refusedCalls,
        routed: task.route ? task.route.recorded : null, deferred: task.route ? task.route.deferred : null, deferReason: task.route?.deferReason ?? null,
        profile: task.route?.profile ?? null, applied: task.route?.applied ?? null, judgeRequests: task.judge?.requests ?? null,
      } : null;
    }
    return row;
  });
  // "Routed" comparisons leave out every task whose route was deferred (or not applied) in R or in L: such a
  // delegation ran as the harness default, not as a routed profile. Arm totals keep every task.
  const hooked = present.filter((key) => key !== 'N');
  const excluded = tasks.filter((row) => hooked.some((key) => row[key] && !(row[key].routed === true && row[key].applied !== false))).map((row) => row.id);
  const routedOnly = Object.fromEntries(present.map((key) => {
    const kept = tasks.filter((row) => !excluded.includes(row.id) && row[key]);
    return [key, { tasks: kept.length, passed: kept.filter((row) => row[key].passed).length, done: kept.filter((row) => row[key].done).length,
      byDifficulty: Object.fromEntries(TIERS.map((tier) => [tier, { tasks: kept.filter((row) => row.difficulty === tier).length, passed: kept.filter((row) => row.difficulty === tier && row[key].passed).length }])) }];
  }));
  const summaries = Object.fromEntries(present.map((key) => [key, armSummary(arms[key], prices, collectors[key] ?? null)]));
  const allPassed = present.length === 3 && present.every((key) => summaries[key].passed === summaries[key].tasks);
  return {
    schema: 1, arms: present, sameCheckerAndTasks: versions.size === 1, tasks, summaries,
    routedComparison: { excludedTasks: excluded, rule: 'tasks whose route was deferred or not applied in arm R or arm L are left out here and kept in the arm totals', arms: routedOnly },
    ceiling: present.length === 3 ? allPassed : null,
    reading: 'Descriptive only: one run per arm, twelve model-authored synthetic tasks. No significance claim and no generalisation.',
  };
}

export function render(result) {
  const out = [];
  const arms = result.arms;
  out.push('Routing experiment: three arms, one run each. Descriptive numbers only (12 synthetic tasks, single runs): no significance, no generalisation.');
  out.push('Known arm differences: in R and L every rewritten delegation costs Main one extra round trip (the host refuses the rewritten call once and Main issues it again);');
  out.push('in N every subagent is the harness default for general-purpose. Token counts are listed per model and are never added across models.');
  if (!result.sameCheckerAndTasks) out.push('WARNING: the arm files were produced with different checker or task versions. They are not comparable.');
  out.push('');
  out.push('Per task: checker result (P = passed, D = done but a hidden check failed, x = not done, - = not delegated), then how the subagent ran.');
  const mark = (cell) => (!cell ? '?' : cell.delegated === false ? '-' : cell.passed ? 'P' : cell.done ? 'D' : 'x');
  const how = (cell, key) => {
    if (!cell || cell.delegated === false) return '-';
    const setting = `${shortModel(cell.model)}/${show(cell.effort)}`;
    if (key === 'N') return setting;
    return cell.routed ? `${shortProfile(cell.profile)}${cell.applied === false ? ' (NOT APPLIED)' : ''} -> ${setting}` : `${cell.deferred ? `deferred:${show(cell.deferReason)}` : 'no route'} -> ${setting}`;
  };
  out.push(table(['task', 'lang', 'tier', ...arms.flatMap((key) => [key, `${key} ran as`])],
    result.tasks.map((row) => [row.id, show(row.lang), show(row.difficulty), ...arms.flatMap((key) => [mark(row[key]), how(row[key], key)])])));
  out.push('');
  out.push('Per task: subagent tokens as input / output / cache read / cache creation, API turns, wall time.');
  const tokens = (cell) => (cell?.tokens ? `${TOKEN_KEYS.map((key) => count(cell.tokens[key])).join(' / ')}  ${show(cell.apiTurns)}t ${seconds(cell.wallMs)}` : '-');
  out.push(table(['task', ...arms.map((key) => `${key} (${'in / out / cache-r / cache-w  turns wall'})`)], result.tasks.map((row) => [row.id, ...arms.map((key) => tokens(row[key]))])));
  out.push('');
  out.push('Primary outcome: tasks passed per arm.');
  out.push(table(['arm', 'passed', 'done', 'delegated', ...TIERS.map((tier) => `${tier} passed`)], arms.map((key) => {
    const s = result.summaries[key];
    return [`${key} ${s.name}`, `${s.passed}/${s.tasks}`, `${s.done}/${s.tasks}`, `${s.delegated}/${s.tasks}`, ...TIERS.map((tier) => (s.byDifficulty[tier] ? `${s.byDifficulty[tier].passed}/${s.byDifficulty[tier].tasks}` : '-'))];
  })));
  if (result.ceiling === true) out.push('CEILING: every arm passed every task. The quality question stays open: these tasks did not separate the arms.');
  out.push('');
  out.push(`Routed comparison (${result.routedComparison.rule}). Left out: ${result.routedComparison.excludedTasks.join(', ') || 'none'}.`);
  out.push(table(['arm', 'tasks kept', 'passed', ...TIERS.map((tier) => `${tier} passed`)], arms.map((key) => {
    const r = result.routedComparison.arms[key];
    return [key, r.tasks, `${r.passed}/${r.tasks}`, ...TIERS.map((tier) => `${r.byDifficulty[tier].passed}/${r.byDifficulty[tier].tasks}`)];
  })));
  out.push('');
  out.push('Subagents by effective model (the model id the host recorded in the subagent\'s own rows). One line per arm and model.');
  const modelRows = arms.flatMap((key) => Object.entries(result.summaries[key].subagentsByModel).map(([model, b]) =>
    [key, model, b.tasks, `${b.passed}/${b.tasks}`, count(b.input), count(b.output), count(b.cacheRead), count(b.cacheCreation), show(b.apiTurns), show(b.toolCalls), seconds(b.wallMs)]));
  out.push(table(['arm', 'model', 'tasks', 'passed', 'input', 'output', 'cache read', 'cache creation', 'turns', 'tool calls', 'wall'], modelRows));
  out.push('');
  out.push('Main session by model (includes, in R and L, the extra round trip per rewritten delegation).');
  out.push(table(['arm', 'model', 'effort', 'turns', 'input', 'output', 'cache read', 'cache creation', 'Agent calls', 'refused', 'wall'], arms.flatMap((key) => {
    const s = result.summaries[key];
    const rows = Object.entries(s.mainByModel).map(([model, b]) => [key, model, (s.mainEfforts ?? []).join(',') || '-', show(b.apiTurns), count(b.input), count(b.output), count(b.cacheRead), count(b.cacheCreation), show(s.agentCalls), show(s.refusedCalls), seconds(s.mainWallMs)]);
    return rows.length ? rows : [[key, '-', '-', '-', '-', '-', '-', '-', '-', '-', '-']];
  })));
  out.push('');
  out.push('Routing and judge (arms with hooks). Judge tokens come from the decision log\'s usage field and are null when the log has none.');
  out.push(table(['arm', 'routed', 'applied', 're-issued', 'deferred', 'judge requests', 'judge in', 'judge out', 'judge latency', 'contexts'], arms.filter((key) => key !== 'N').map((key) => {
    const s = result.summaries[key];
    return [key, show(s.routing?.routed), show(s.routing?.applied), show(s.routing?.reissued), s.routing ? (s.routing.deferred.join(',') || 'none') : '-',
      show(s.judge?.all.requests), count(s.judge?.all.inputTokens), count(s.judge?.all.outputTokens), seconds(s.judge?.all.latencyMs), s.routing ? (s.routing.evaluationContexts.join(',') || '-') : '-'];
  })));
  for (const key of arms.filter((k) => k !== 'N')) {
    const profiles = Object.entries(result.summaries[key].routing?.profiles ?? {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    out.push(`  ${key} routed profiles: ${profiles.map(([profile, n]) => `${shortProfile(profile)} x${n}`).join(', ') || '-'}`);
  }
  out.push('');
  out.push('Wall time: subagents (sum of each subagent\'s first to last row), end to end (first Agent call of a task to its subagent\'s last row), Main session.');
  out.push(table(['arm', 'subagents', 'end to end', 'main session'], arms.map((key) => { const s = result.summaries[key]; return [key, seconds(s.subagentWallMs), seconds(s.subagentEndToEndMs), seconds(s.mainWallMs)]; })));
  const collected = arms.filter((key) => result.summaries[key].collector);
  if (collected.length) {
    out.push('');
    out.push('Outcome collector (evaluation rows). Rows produced here are far below the importer\'s minimumSamples (30 per profile on one task set): routing does not change because of them.');
    out.push(table(['arm', 'context', 'rows produced', 'by model match', 'tasks withheld', 'reasons'], collected.map((key) => {
      const c = result.summaries[key].collector;
      return [key, show(c.context), show(c.produced), JSON.stringify(c.producedByModelMatch ?? {}), show(c.withheldTasks), Object.entries(c.withheld ?? {}).map(([reason, n]) => `${reason} x${n}`).join(', ') || 'none'];
    })));
  }
  if (arms.some((key) => result.summaries[key].cost)) {
    const any = result.summaries[arms.find((key) => result.summaries[key].cost)].cost;
    out.push('');
    out.push(`Cost ESTIMATE from the prices file given on the command line (${any.currency}; source: ${any.source}; checked: ${any.checkedAt}). Judge requests are not priced.`);
    out.push(table(['arm', 'subagents', 'total (subagents + main)', 'not priced'], arms.map((key) => {
      const c = result.summaries[key].cost;
      return [key, c.subagents === null ? '-' : c.subagents.toFixed(4), c.total === null ? '-' : c.total.toFixed(4), c.missing.join('; ') || 'nothing'];
    })));
  } else {
    out.push('');
    out.push('No cost estimate: no --prices file was given (none is shipped).');
  }
  out.push('');
  for (const key of arms) {
    const s = result.summaries[key];
    out.push(`${key}: host ${JSON.stringify(s.host)}; ${s.warnings} warning(s), ${s.taskNotes} task note(s), ${show(s.unattributedChanges)} unattributed change(s), ${s.unlinkedSubagents?.files ?? 0} unlinked subagent transcript(s). Read the arm file for the text.`);
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'json') args.json = true; else { args[key] = argv[i + 1]; i += 1; }
  }
  if (!args.n || !args.r || !args.l) { console.error('usage: compare.mjs --n <armN.json> --r <armR.json> --l <armL.json> [--prices <file>] [--collector-r <file>] [--collector-l <file>] [--json]'); process.exit(64); }
  const read = (file) => JSON.parse(readFileSync(resolve(file), 'utf8'));
  const result = compareArms({ N: read(args.n), R: read(args.r), L: read(args.l) }, {
    prices: args.prices ? loadPrices(resolve(args.prices)) : null,
    collectors: { ...(args['collector-r'] ? { R: read(args['collector-r']) } : {}), ...(args['collector-l'] ? { L: read(args['collector-l']) } : {}) },
  });
  process.stdout.write(args.json ? JSON.stringify(result, null, 2) + '\n' : render(result));
}
