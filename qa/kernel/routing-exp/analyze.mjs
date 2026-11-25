#!/usr/bin/env node
// Offline analysis of ONE arm of the routing experiment. Reads only; no network, no session is started.
//   node analyze.mjs --arm N|R|L --project <dir> --transcripts <dir> [--state-dir <hook state dir>] --out <file>
//     --transcripts  folder with the session's Main transcript (*.jsonl directly inside) and subagents/
//                    (agent-<id>.jsonl, agent-<id>.meta.json, agent-<id>.prefix.json: three files per subagent)
//     --state-dir    the arm's hook state (sessions/<scope>/events/*.json, decisions-log/*.jsonl); arms R and L only
// The output names no path, no session / agent / tool-use id and no prompt text.
// Anything that is not in the expected shape becomes null plus a warning. Nothing is guessed.
//
// File shapes (as observed in the earlier real sessions; see ../pilot/analyze.mjs and orchestration/src/collector.mjs,
// whose transcript parsers are reused here):
//  - Conversation rows have type "user" / "assistant" (plus "attachment", "system"). Request-log rows ("api-request",
//    ...) repeat the same content under the same ids and are ignored.
//  - One API message is written as several rows that repeat the same `message.usage`; tokens are counted once per
//    `message.id`.
//  - In permission mode auto a hook that rewrites an Agent call makes the host refuse it once (error result,
//    permissionDecision.decision "reject") and Main issues it again with the hook's input under a new tool-use id. In a
//    hooked arm a task is therefore two Agent calls: a refused one and the one that launched. The hook links the two
//    with a `delegation_reissued` event; the route belongs to the refused (first) call.
//  - The Agent tool result carries { status: "async_launched", agentId }; the subagent's own rows carry
//    `message.model` and `effort`; agent-<id>.meta.json carries { agentType, toolUseId, model?, finished? }.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject, loadTasks } from './checkers/check.mjs';
import { parseJsonl, parseMain, parseSubagent } from '../../../orchestration/src/collector.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const ARMS = { N: 'no routing', R: 'routed', L: 'lower-model only' };
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheCreation'];
const USAGE_FIELDS = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheCreation: 'cache_creation_input_tokens' };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const str = (value) => (typeof value === 'string' && value !== '' ? value : null);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const sha = (data) => createHash('sha256').update(data).digest('hex');
const emptyTokens = () => ({ input: null, output: null, cacheRead: null, cacheCreation: null });

/** a + b per token kind; null stays null only when both are null. */
export function addTokens(a, b) {
  const out = {};
  for (const key of TOKEN_KEYS) out[key] = a?.[key] == null && b?.[key] == null ? null : (a?.[key] ?? 0) + (b?.[key] ?? 0);
  return out;
}
const listDir = (dir) => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return null; } };
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; } };
const stampOf = (row) => { const ms = Date.parse(str(row?.timestamp) ?? ''); return Number.isFinite(ms) ? ms : null; };
const roleOf = (row) => {
  if (row?.type === 'user' || row?.type === 'assistant') return row.type;
  if (row?.type === undefined && (row?.message?.role === 'user' || row?.message?.role === 'assistant')) return row.message.role;
  return null;
};

// ---------------------------------------------------------------- Main transcript
/** Main-session usage: tokens per model (once per message id), API turns, efforts, wall time. */
export function mainUsage(rows, warnings) {
  const byMessage = new Map();
  const efforts = new Set();
  const stamps = [];
  const toolIds = new Set();
  const otherTools = {};
  let anonymous = 0, sidechain = 0;
  for (const row of rows) {
    const role = roleOf(row);
    if (role === null) continue;
    if (row.isSidechain === true) { sidechain += 1; continue; }
    const stamp = stampOf(row);
    if (stamp !== null) stamps.push(stamp);
    if (role !== 'assistant' || !isObject(row.message)) continue;
    const id = str(row.message.id) ?? `anonymous-${anonymous += 1}`;
    const prior = byMessage.get(id) ?? { model: null, usage: null };
    byMessage.set(id, { model: str(row.message.model) ?? prior.model, usage: isObject(row.message.usage) ? row.message.usage : prior.usage });
    if (str(row.effort)) efforts.add(row.effort);
    // What Main did besides delegating: it is told to do nothing itself, so anything here is a protocol deviation.
    for (const item of Array.isArray(row.message.content) ? row.message.content : []) {
      if (!isObject(item) || item.type !== 'tool_use' || typeof item.name !== 'string' || item.name === 'Agent' || item.name === 'Task') continue;
      const key = typeof item.id === 'string' ? item.id : `anonymous-${toolIds.size}`;
      if (toolIds.has(key)) continue;
      toolIds.add(key);
      otherTools[item.name] = (otherTools[item.name] ?? 0) + 1;
    }
  }
  if (anonymous) warnings.push(`${anonymous} Main assistant row(s) without a message id: each was counted as its own API turn`);
  if (sidechain) warnings.push(`${sidechain} sidechain row(s) in the Main transcript were ignored`);
  const tokensByModel = {};
  let unknownModel = 0, withoutUsage = 0;
  for (const { model, usage } of byMessage.values()) {
    const key = model ?? 'unknown';
    if (model === null) unknownModel += 1;
    const bucket = tokensByModel[key] ?? { apiTurns: 0, ...emptyTokens() };
    bucket.apiTurns += 1;
    if (usage === null) withoutUsage += 1;
    else {
      for (const [name, field] of Object.entries(USAGE_FIELDS)) {
        if (Number.isSafeInteger(usage[field]) && usage[field] >= 0) bucket[name] = (bucket[name] ?? 0) + usage[field];
      }
    }
    tokensByModel[key] = bucket;
  }
  if (unknownModel) warnings.push(`${unknownModel} Main API turn(s) carry no model id`);
  if (withoutUsage) warnings.push(`${withoutUsage} Main API turn(s) carry no usage: Main tokens are a lower bound`);
  if (byMessage.size === 0) warnings.push('no assistant rows in the Main transcript: Main tokens are unmeasured');
  return {
    models: Object.keys(tokensByModel).filter((model) => model !== 'unknown').sort(), efforts: [...efforts].sort(), apiTurns: byMessage.size || null, tokensByModel,
    tokens: Object.values(tokensByModel).reduce((sum, bucket) => addTokens(sum, bucket), emptyTokens()),
    wallMs: stamps.length >= 2 ? Math.max(...stamps) - Math.min(...stamps) : null,
    otherToolCalls: Object.fromEntries(Object.entries(otherTools).sort()),
  };
}

function readMain(transcriptsDir, warnings) {
  const entries = listDir(transcriptsDir);
  if (!entries) { warnings.push('the transcripts folder cannot be read'); return null; }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name).sort();
  if (files.length === 0) { warnings.push('no Main transcript (*.jsonl) directly under the transcripts folder'); return null; }
  if (files.length > 1) warnings.push(`${files.length} Main transcript files were read as one session`);
  const rows = [];
  for (const name of files) {
    let text;
    try { text = readFileSync(join(transcriptsDir, name), 'utf8'); } catch { warnings.push('a Main transcript file cannot be read'); continue; }
    const parsed = parseJsonl(text);
    if (parsed.bad) warnings.push(`${parsed.bad} unparsable line(s) skipped in the Main transcript`);
    rows.push(...parsed.rows);
  }
  const parsed = parseMain(rows);
  const firstPrompt = rows.find((row) => roleOf(row) === 'user' && row.isMeta !== true && typeof row.message?.content === 'string')?.message.content ?? null;
  return { rows, calls: parsed.calls, results: parsed.results, host: parsed.host, firstPrompt };
}

// ---------------------------------------------------------------- subagent transcripts
function readSubagents(transcriptsDir, warnings) {
  const dir = join(transcriptsDir, 'subagents');
  const entries = listDir(dir);
  const agents = new Map();
  if (!entries) { warnings.push('no subagents folder under the transcripts folder'); return agents; }
  for (const entry of entries) {
    const match = /^agent-([A-Za-z0-9_-]{1,80})\.jsonl$/.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const id = match[1];
    const local = [];
    let parsed = null;
    try {
      const lines = parseJsonl(readFileSync(join(dir, entry.name), 'utf8'));
      if (lines.bad) local.push(`${lines.bad} unparsable line(s) skipped in a subagent transcript`);
      const collected = { counts: {}, add(kind, n = 1) { this.counts[kind] = (this.counts[kind] ?? 0) + n; } };
      parsed = parseSubagent(lines.rows, {}, collected);
      for (const [kind, n] of Object.entries(collected.counts)) {
        if (!['subagent_tool_call_without_result'].includes(kind)) local.push(`subagent transcript: ${kind} (${n})`);
      }
    } catch { local.push('a subagent transcript cannot be read'); }
    const rawMeta = readJson(join(dir, `agent-${id}.meta.json`));
    let meta = null;
    if (rawMeta === undefined) local.push('a subagent has no readable agent-<id>.meta.json: its agent type is unknown');
    else if (!isObject(rawMeta)) local.push('agent-<id>.meta.json is not an object');
    else meta = { agentType: str(rawMeta.agentType), model: str(rawMeta.model), toolUseId: str(rawMeta.toolUseId), finished: typeof rawMeta.finished === 'boolean' ? rawMeta.finished : null };
    const files = 1 + (rawMeta === undefined ? 0 : 1) + (existsSync(join(dir, `agent-${id}.prefix.json`)) ? 1 : 0);
    agents.set(id, { parsed, meta, files, warnings: local });
  }
  return agents;
}

// ---------------------------------------------------------------- hook state
function readState(stateDir, warnings) {
  const events = [];
  const sessions = listDir(join(stateDir, 'sessions'));
  if (!sessions) { warnings.push('no sessions folder under the state dir: routes are unknown'); return { events, decisions: new Map(), decisionRows: [], found: false }; }
  let bad = 0;
  for (const session of sessions.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    for (const file of (listDir(join(stateDir, 'sessions', session, 'events')) ?? []).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort()) {
      const event = readJson(join(stateDir, 'sessions', session, 'events', file));
      if (isObject(event) && typeof event.type === 'string') events.push(event); else bad += 1;
    }
  }
  if (bad) warnings.push(`${bad} hook event file(s) could not be read as an event`);
  const decisions = new Map();
  const decisionRows = [];
  for (const file of (listDir(join(stateDir, 'decisions-log')) ?? []).filter((entry) => entry.isFile() && /^decisions-.*\.jsonl$/.test(entry.name)).map((entry) => entry.name).sort()) {
    let text;
    try { text = readFileSync(join(stateDir, 'decisions-log', file), 'utf8'); } catch { continue; }
    const parsed = parseJsonl(text);
    if (parsed.bad) warnings.push(`${parsed.bad} unparsable line(s) skipped in the decision log`);
    for (const row of parsed.rows) { decisionRows.push(row); if (str(row.decisionId)) decisions.set(row.decisionId, row); }
  }
  if (decisionRows.length === 0) warnings.push('no decision log rows under the state dir: judge requests, tokens and latency are unmeasured');
  return { events, decisions, decisionRows, found: true };
}

/** Judge cost of a set of decision-log rows. Tokens are null when no row carries a `usage` object. */
export function judgeCost(rows) {
  const live = rows.filter((row) => row.cached !== true);
  const usages = live.map((row) => row.usage).filter(isObject);
  const sum = (field) => { const known = usages.map((u) => u[field]).filter((n) => Number.isSafeInteger(n)); return known.length ? known.reduce((a, b) => a + b, 0) : null; };
  const latencies = live.map((row) => finite(row.latencyMs)).filter((ms) => ms !== null);
  return { decisions: rows.length, requests: live.length, cached: rows.length - live.length, requestsWithUsage: usages.length,
    inputTokens: sum('input_tokens'), outputTokens: sum('output_tokens'), latencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0)) : null };
}

// ---------------------------------------------------------------- the arm
export function analyzeArm({ arm, project, transcriptsDir, stateDir = null, tasks = loadTasks(), check = null }) {
  if (!Object.hasOwn(ARMS, arm)) throw new Error('arm must be N, R or L');
  const warnings = [];
  const hooked = arm !== 'N';
  const checked = check ?? checkProject({ project, tasks });
  const main = readMain(transcriptsDir, warnings);
  const subagents = readSubagents(transcriptsDir, warnings);
  if (hooked && !stateDir) warnings.push('no --state-dir for a hooked arm: routes and judge cost are unmeasured');
  if (!hooked && stateDir) warnings.push('a --state-dir was given for arm N, which must run without hooks');
  const state = stateDir ? readState(stateDir, warnings) : null;
  const eventsOf = (type) => { const map = new Map(); for (const event of state?.events ?? []) if (event.type === type && typeof event.taskId === 'string') map.set(event.taskId, event); return map; };
  const routes = eventsOf('route'), deferred = eventsOf('route_deferred'), reissued = eventsOf('delegation_reissued'), repeated = eventsOf('delegation_repeated');
  if (!hooked && state?.events.some((event) => event.type === 'route' || event.type === 'route_deferred')) warnings.push('arm N has routing events in its state dir: it did not run without hooks');

  const calls = main ? [...main.calls.values()].sort((a, b) => (a.time ?? 0) - (b.time ?? 0)) : [];
  const claimed = new Set();
  const linkedAgents = new Set();
  const taskRows = tasks.map((task) => {
    const notes = [];
    const result = checked.tasks.find((entry) => entry.id === task.id) ?? null;
    if (!result) notes.push('the checker returned nothing for this task');
    const wanted = squash(task.text);
    const mine = calls.filter((call) => call.prompt !== null && squash(call.prompt).includes(wanted));
    for (const call of mine) claimed.add(call.id);
    const outcome = (call) => main.results.get(call.id) ?? null;
    const launched = mine.filter((call) => outcome(call)?.agentId);
    const refused = mine.filter((call) => { const r = outcome(call); return r && !r.agentId && (r.rejected || r.isError); });
    const unanswered = mine.filter((call) => !outcome(call));
    if (unanswered.length) notes.push(`${unanswered.length} Agent call(s) for this task have no tool result in the transcript`);
    if (launched.length > 1) notes.push(`${launched.length} subagents were launched for this task (the first is analysed; the others are listed under unlinkedSubagents)`);
    const first = mine[0] ?? null;
    const run = launched[0] ?? null;
    const delegation = {
      delegated: main ? mine.length > 0 : null, agentCalls: main ? mine.length : null, refusedCalls: main ? refused.length : null, launchedCalls: main ? launched.length : null,
      firstPromptVerbatim: first ? first.prompt === task.text : null, firstRequestedType: first ? first.subagentType : null,
      launchedRequestedType: run ? run.subagentType : null,
    };

    // The subagent, from the host's own records.
    let subagent = null;
    if (run) {
      const agentId = outcome(run).agentId;
      const found = subagents.get(agentId) ?? null;
      if (!found) notes.push('the launched subagent has no transcript file under subagents/');
      else {
        linkedAgents.add(agentId);
        notes.push(...found.warnings);
        const p = found.parsed;
        if (found.files !== 3) notes.push(`${found.files} of the 3 expected files exist for this subagent`);
        if (found.meta?.toolUseId && found.meta.toolUseId !== run.id) notes.push('agent-<id>.meta.json names another Agent call than the one that launched this subagent');
        if (p?.model && found.meta?.model && p.model !== found.meta.model) notes.push('the subagent rows and its meta file name different models: the rows are reported');
        if (found.meta?.finished === false) notes.push('the host recorded this subagent as not finished: its totals may be partial');
        const startTime = first?.time ?? null;
        subagent = {
          agentType: found.meta?.agentType ?? null, model: p?.model ?? null, modelInMeta: found.meta?.model ?? null, effort: p?.effort ?? null,
          finished: found.meta?.finished ?? null, files: found.files,
          tokens: p ? { ...p.tokens } : emptyTokens(), apiTurns: p?.apiTurns || null, toolCalls: p ? p.toolCalls : null, wallMs: p?.wallMs ?? null,
          endToEndMs: startTime !== null && p?.lastTime != null && p.lastTime >= startTime ? p.lastTime - startTime : null,
        };
        if (p && !p.apiTurns) notes.push('the subagent transcript has no assistant rows');
        if (p && p.apiTurns && p.model === null) notes.push('the subagent rows name no single model');
        if (p && p.apiTurns && p.effort === null) notes.push('the subagent rows carry no single effort');
      }
    } else if (main && mine.length) notes.push('no Agent call for this task launched a subagent');
    else if (main) notes.push('Main did not delegate this task (counts as not passed)');

    // The route (hooked arms): recorded for the first call; the launched call is linked to it by delegation_reissued.
    let route = null, judge = null;
    if (hooked && state?.found) {
      const ids = mine.map((call) => call.id);
      const routeEvents = ids.map((id) => routes.get(id)).filter(Boolean);
      const event = routeEvents[0] ?? null;
      const deferral = ids.map((id) => deferred.get(id)).find(Boolean) ?? null;
      const link = run ? reissued.get(run.id) ?? null : null;
      const repeat = run ? repeated.get(run.id) ?? null : null;
      if (routeEvents.length > 1) notes.push(`${routeEvents.length} route events for this task: the launched call was judged again (not recognised as a re-issue)`);
      if (event && run && refused.length && !link) notes.push('the launched call is not linked to the refused call by a delegation_reissued event');
      if (repeat) notes.push('the launched call was recorded as a repeat of an earlier call');
      const r = isObject(event?.route) ? event.route : null;
      const applied = r && subagent?.agentType ? subagent.agentType === str(r.profile) : null;
      route = {
        recorded: Boolean(r), deferred: !r && Boolean(deferral), deferReason: !r ? str(deferral?.reason) : null,
        profile: str(r?.profile), tier: str(r?.tier), role: str(r?.role), model: str(r?.model), backend: str(r?.backend), effort: r ? r.effort ?? null : null,
        taskClass: str(r?.taskClass), evaluationContext: str(r?.evaluationContext), mode: str(event?.mode), basis: str(r?.optimizationBasis),
        reissued: run ? Boolean(link) : null, reissueAgeMs: finite(link?.ageMs),
        // Whether the host ran the profile the route named, and with what setting: compared as recorded strings.
        applied, modelEqualsBackend: r && subagent?.model ? subagent.model === (str(r.backend) ?? str(r.model)) : null,
        effortEqualsRoute: r && subagent && subagent.effort !== null ? subagent.effort === (r.effort ?? null) : null,
        hookMs: routeEvents.length && routeEvents.every((e) => finite(e.hookMs) !== null) ? Math.round(routeEvents.reduce((n, e) => n + e.hookMs, 0)) : null,
      };
      if (!r && !deferral && mine.length) notes.push('no route and no route_deferred event for this task: the hook did not see the call or recorded nothing');
      if (r && route.mode !== 'active') notes.push(`the route was recorded in mode ${route.mode}: it was not applied`);
      if (applied === false) notes.push('the subagent did not run as the routed profile');
      const decisionIds = new Set();
      for (const e of routeEvents) for (const id of Object.values(isObject(e.judgeDecisionIds) ? e.judgeDecisionIds : {})) if (str(id)) decisionIds.add(id);
      const rows = [...decisionIds].map((id) => state.decisions.get(id)).filter(Boolean);
      if (decisionIds.size !== rows.length) notes.push(`${decisionIds.size - rows.length} judge decision(s) of this task are not in the decision log`);
      judge = event || deferral ? { ...judgeCost(rows), decisionIdsOnRoute: decisionIds.size } : null;
      if (deferral && decisionIds.size === 0) notes.push('a deferred route records no judge decision ids: its judge cost is in the arm total only');
    }
    return {
      id: task.id, lang: task.lang, difficulty: task.difficulty,
      check: result ? { done: result.done, passed: result.passed, failed: result.details.filter((d) => !d.ok).map((d) => d.name) } : { done: null, passed: null, failed: null },
      // A task Main did not delegate counts as not passed, whatever the project looks like.
      counted: { done: Boolean(result?.done) && delegation.delegated !== false, passed: Boolean(result?.passed) && delegation.delegated !== false },
      delegation, subagent, route, judge, notes,
    };
  });

  // Agent calls that carry no task text, and subagent transcripts no task launched: counted, never attributed.
  const strayCalls = calls.filter((call) => !claimed.has(call.id)).length;
  if (strayCalls) warnings.push(`${strayCalls} Agent call(s) carry no task text of this experiment`);
  let unlinked = { files: 0, tokensByModel: {} };
  for (const [id, agent] of subagents) {
    if (linkedAgents.has(id)) continue;
    unlinked.files += 1;
    const model = agent.parsed?.model ?? 'unknown';
    unlinked.tokensByModel[model] = addTokens(unlinked.tokensByModel[model], agent.parsed?.tokens ?? emptyTokens());
  }
  if (unlinked.files) warnings.push(`${unlinked.files} subagent transcript(s) belong to no analysed task launch: their tokens are listed under unlinkedSubagents`);

  const usage = main ? mainUsage(main.rows, warnings) : null;
  if (usage && Object.keys(usage.otherToolCalls).length) warnings.push(`Main used tools other than Agent (${Object.entries(usage.otherToolCalls).map(([name, n]) => `${name} x${n}`).join(', ')}): it was told to do no work itself`);
  const mainPromptFile = join(here, 'main-prompt.txt');
  const expectedPrompt = existsSync(mainPromptFile) ? readFileSync(mainPromptFile, 'utf8').trim() : null;

  const byModel = {};
  for (const row of taskRows) {
    if (!row.subagent) continue;
    const key = row.subagent.model ?? 'unknown';
    const bucket = byModel[key] ?? { tasks: 0, done: 0, passed: 0, apiTurns: null, toolCalls: null, wallMs: null, ...emptyTokens() };
    bucket.tasks += 1; bucket.done += row.counted.done ? 1 : 0; bucket.passed += row.counted.passed ? 1 : 0;
    Object.assign(bucket, addTokens(bucket, row.subagent.tokens));
    for (const key2 of ['apiTurns', 'toolCalls', 'wallMs']) if (row.subagent[key2] !== null) bucket[key2] = (bucket[key2] ?? 0) + row.subagent[key2];
    byModel[key] = bucket;
  }
  const byDifficulty = {};
  for (const row of taskRows) {
    const bucket = byDifficulty[row.difficulty] ?? { tasks: 0, delegated: 0, done: 0, passed: 0 };
    bucket.tasks += 1; bucket.delegated += row.delegation.delegated ? 1 : 0; bucket.done += row.counted.done ? 1 : 0; bucket.passed += row.counted.passed ? 1 : 0;
    byDifficulty[row.difficulty] = bucket;
  }
  const profiles = {};
  for (const row of taskRows) if (row.route?.recorded) profiles[row.route.profile ?? 'unknown'] = (profiles[row.route.profile ?? 'unknown'] ?? 0) + 1;
  const pointCost = {};
  for (const row of state?.decisionRows ?? []) { const point = str(row.pointId) ?? 'unknown'; (pointCost[point] ??= []).push(row); }
  const sumOf = (pick) => { const known = taskRows.map(pick).filter((n) => n !== null && n !== undefined); return known.length ? known.reduce((a, b) => a + b, 0) : null; };

  return {
    schema: 1, generatedBy: 'qa/kernel/routing-exp/analyze.mjs', arm, armName: ARMS[arm],
    checker: { name: 'routing-exp-checker', version: sha(readFileSync(join(here, 'checkers', 'check.mjs'))), tasksFile: sha(readFileSync(join(here, 'tasks.json'))) },
    host: main ? { versions: [...main.host.versions].sort(), entrypoints: [...main.host.entrypoints].sort(), permissionModes: [...main.host.permissionModes].sort() } : null,
    main: main ? {
      ...usage, agentCalls: calls.length, refusedCalls: calls.filter((call) => { const r = main.results.get(call.id); return r && !r.agentId && (r.rejected || r.isError); }).length,
      launchedCalls: calls.filter((call) => main.results.get(call.id)?.agentId).length, strayAgentCalls: strayCalls,
      promptContainsMainPrompt: main.firstPrompt !== null && expectedPrompt !== null ? main.firstPrompt.includes(expectedPrompt) : null,
      promptExtraCharacters: main.firstPrompt !== null && expectedPrompt !== null && main.firstPrompt.includes(expectedPrompt) ? main.firstPrompt.trim().length - expectedPrompt.length : null,
    } : null,
    tasks: taskRows,
    totals: {
      tasks: taskRows.length, delegated: taskRows.filter((row) => row.delegation.delegated).length,
      done: taskRows.filter((row) => row.counted.done).length, passed: taskRows.filter((row) => row.counted.passed).length,
      byDifficulty, subagentsByModel: byModel,
      subagentWallMs: sumOf((row) => row.subagent?.wallMs), subagentEndToEndMs: sumOf((row) => row.subagent?.endToEndMs),
      routing: hooked ? {
        routed: taskRows.filter((row) => row.route?.recorded).length, deferred: taskRows.filter((row) => row.route?.deferred).map((row) => row.id),
        applied: taskRows.filter((row) => row.route?.applied === true).length, notApplied: taskRows.filter((row) => row.route?.applied === false).map((row) => row.id),
        reissued: taskRows.filter((row) => row.route?.reissued === true).length, profiles,
        evaluationContexts: [...new Set(taskRows.map((row) => row.route?.evaluationContext).filter(Boolean))].sort(),
      } : null,
      // Judge cost of the whole state dir (every logged decision, by decision point) and of the task routes alone.
      judge: hooked && state?.found ? { all: judgeCost(state.decisionRows), byPoint: Object.fromEntries(Object.entries(pointCost).sort().map(([point, rows]) => [point, judgeCost(rows)])),
        onTaskRoutes: { requests: sumOf((row) => row.judge?.requests), inputTokens: sumOf((row) => row.judge?.inputTokens), outputTokens: sumOf((row) => row.judge?.outputTokens), latencyMs: sumOf((row) => row.judge?.latencyMs) } } : null,
      unlinkedSubagents: unlinked,
    },
    unattributedChanges: checked.unattributedChanges,
    warnings,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  if (!Object.hasOwn(ARMS, args.arm ?? '') || !args.project || !args.transcripts || !args.out) {
    console.error('usage: analyze.mjs --arm N|R|L --project <dir> --transcripts <dir> [--state-dir <dir>] --out <file>');
    process.exit(64);
  }
  const result = analyzeArm({ arm: args.arm, project: resolve(args.project), transcriptsDir: resolve(args.transcripts), stateDir: args['state-dir'] ? resolve(args['state-dir']) : null });
  writeFileSync(resolve(args.out), JSON.stringify(result, null, 2) + '\n');
  const t = result.totals;
  console.log(`arm ${result.arm} (${result.armName}): passed ${t.passed}/${t.tasks}, done ${t.done}/${t.tasks}, delegated ${t.delegated}/${t.tasks}; ${result.warnings.length} warning(s), ${result.tasks.reduce((n, row) => n + row.notes.length, 0)} task note(s)`);
  console.log(`wrote ${resolve(args.out)}`);
}
