// Outcome collector: after a session, joins what the hooks decided (session state + decision log) with what
// the host recorded (the session's transcripts) and writes
//   1. outcome labels for logged decisions (DecisionLog.label), each with a source that says what kind of evidence it is,
//   2. one observation record per delegation (kernel/observations.mjs),
//   3. candidate evaluation rows in the format src/feedback.mjs accepts, to a file the user reviews and imports.
// It sends nothing anywhere, starts nothing and changes no routing. Nothing is inferred from a subagent's own
// report text, and no pass/fail verdict is ever synthesised: a verdict exists only when the user supplies an
// externally verified result (--verification).
//
// Transcripts are not a stable contract. Every reader below takes what it recognises and turns the rest into
// null plus a counted warning. Shapes actually seen: Claude Code desktop 2.1.330 (see docs/KERNEL.ko.md).
// Codex transcripts were never observed, so a codex session is reported as unsupported.
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assert, object, hash, atomicWrite } from './util.mjs';
import { splitRoutingTail } from './policy.mjs';
import { validateEvaluation, effectiveModelMatch } from './feedback.mjs';
import { profileCatalog, RESOLVED_MODEL_ID } from './catalog.mjs';
import { DecisionLog } from './kernel/log.mjs';
import { ObservationLog, observationId, latestObservations, isObservationRecord, IDENTIFIER, SKILL_ID } from './kernel/observations.mjs';
import { SKILLS_POINT } from './kernel/skills.mjs';
import { SUPERVISOR_POINT } from './kernel/supervisor.mjs';
import { RETRACTION_SUFFIX } from './kernel/calibration.mjs';
import { classifySkillAccess } from './collector-access.mjs';

export const COLLECTOR_VERSION = 'outcome-collector-4';
// Label sources. Each says what kind of evidence the label is (kernel/calibration.mjs LABEL_SOURCES).
// The "-after-injection" sources are used when the subagent's prompt carried the skills block of the very
// decision being labelled: the block tells the subagent what to load, so the label is partly caused by the
// decision. They are separate sources so that a report can leave them out.
export const SOURCE_OBSERVED_LOAD = 'observed-load';
export const SOURCE_OBSERVED_LOAD_INJECTED = 'observed-load-after-injection';
export const SOURCE_EXTERNAL = 'external-verification';
export const SOURCE_EXTERNAL_WITH_LOAD = 'external-verification-with-load';
export const SOURCE_EXTERNAL_WITH_LOAD_INJECTED = 'external-verification-with-load-after-injection';
const LOAD_SOURCES = [SOURCE_OBSERVED_LOAD, SOURCE_OBSERVED_LOAD_INJECTED];
const WITH_LOAD_SOURCES = [SOURCE_EXTERNAL_WITH_LOAD, SOURCE_EXTERNAL_WITH_LOAD_INJECTED];
export const UNVALIDATED_CONTEXT = 'native-default-unvalidated';

export const MAX_TRANSCRIPT_BYTES = 134217728;
export const MAX_STATE_FILE_BYTES = 1048576;
export const MAX_VERIFICATION_BYTES = 10000000;
const MAX_VERIFICATION_ENTRIES = 5000;
const MAX_SESSIONS = 512;
const MAX_EVENT_FILES = 5000;
const MAX_MAIN_FILES = 16;
const MAX_SUBAGENT_FILES = 4000;

const HEX64 = /^[0-9a-f]{64}$/;
const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,80})\.jsonl$/;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const DELEGATION_TOOLS = new Set(['Agent', 'Task']);
const CONVERSATION_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);
const SPAN_TYPES = new Set(['user', 'assistant', 'attachment']);

const str = x => (typeof x === 'string' && x !== '' ? x : null);
const finite = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const ident = x => (typeof x === 'string' && IDENTIFIER.test(x) ? x : null);
const hex = x => (typeof x === 'string' && HEX64.test(x) ? x : null);
const fail = code => Object.assign(new Error(code), { code });

/**
 * The task hash is UNKEYED. It keeps the task text out of the files, but anyone who can guess a task text can
 * confirm the guess by hashing it, and short or formulaic delegations are guessable. Files that carry task
 * hashes (observations, the summary's delegationIndex, verification files, candidate evaluation rows and the
 * evidence store) should therefore not be shared for real projects.
 *
 * The task hash that a verification file refers to: the lowercase hex SHA-256 of the UTF-8 bytes of the
 * ORIGINAL delegated task text, i.e. the `prompt` string of the Agent call exactly as Main first issued it,
 * before any hook rewrite. No trimming and no normalisation. If that string ends in the tail this extension
 * appends to a rewritten delegation (blank line, <jev-routing> packet, the fixed sentence, optionally a
 * <jev-skills> block: policy.mjs splitRoutingTail), the task text is what stands in front of the tail.
 */
export function taskHash(text) {
  assert(typeof text === 'string' && text.length > 0, 'INVALID_TASK_TEXT');
  const tail = splitRoutingTail(text);
  return createHash('sha256').update(tail ? tail.task : text, 'utf8').digest('hex');
}

class Warnings {
  constructor() { this.counts = {}; }
  add(kind, n = 1) { this.counts[kind] = (this.counts[kind] ?? 0) + n; }
}
const bump = (map, key, n = 1) => { map[key] = (map[key] ?? 0) + n; };

// ---------------------------------------------------------------- bounded, symlink-refusing reads

async function readBounded(file, maxBytes) {
  let stat;
  try { stat = await fs.lstat(file); } catch (e) { throw fail(e.code === 'ENOENT' ? 'SOURCE_MISSING' : 'SOURCE_UNREADABLE'); }
  if (stat.isSymbolicLink()) throw fail('SYMLINK_SOURCE');
  if (!stat.isFile()) throw fail('SOURCE_NOT_A_FILE');
  if (stat.size > maxBytes) throw fail('SOURCE_TOO_LARGE');
  let handle;
  try { handle = await fs.open(file, FS.O_RDONLY | FS.O_NOFOLLOW); }
  catch (e) { throw fail(e.code === 'ELOOP' ? 'SYMLINK_SOURCE' : 'SOURCE_UNREADABLE'); }
  try {
    const now = await handle.stat();
    if (!now.isFile()) throw fail('SOURCE_NOT_A_FILE');
    if (now.size > maxBytes) throw fail('SOURCE_TOO_LARGE');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function listDirectory(dir, max) {
  let stat;
  try { stat = await fs.lstat(dir); } catch (e) { throw fail(e.code === 'ENOENT' ? 'SOURCE_MISSING' : 'SOURCE_UNREADABLE'); }
  if (stat.isSymbolicLink()) throw fail('SYMLINK_SOURCE');
  if (!stat.isDirectory()) throw fail('SOURCE_NOT_A_DIRECTORY');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  if (entries.length > max) throw fail('SOURCE_TOO_MANY_ENTRIES');
  return entries;
}

async function readJsonFile(file, maxBytes) {
  const text = await readBounded(file, maxBytes);
  try { return JSON.parse(text); } catch { throw fail('SOURCE_NOT_JSON'); }
}

/** Lines of a .jsonl text as objects. Anything that is not a JSON object is counted, not guessed. */
export function parseJsonl(text) {
  const rows = [];
  let bad = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (object(row)) rows.push(row); else bad++;
    } catch { bad++; }
  }
  return { rows, bad };
}

// ---------------------------------------------------------------- transcript shapes (pure)

// "user" / "assistant" for a conversation row. Request-log rows (api-request, ...) repeat the conversation
// under the same ids and are never read.
function rowRole(row) {
  if (row.type === 'user' || row.type === 'assistant') return row.type;
  if (row.type === undefined && (row.message?.role === 'user' || row.message?.role === 'assistant')) return row.message.role;
  return null;
}
const contentItems = row => (Array.isArray(row?.message?.content) ? row.message.content.filter(object) : []);
function messageText(row) {
  const content = row?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter(item => object(item) && item.type === 'text' && typeof item.text === 'string').map(item => item.text);
  return parts.length ? parts.join('\n') : null;
}
const stampOf = row => { const ms = Date.parse(str(row.timestamp) ?? ''); return Number.isFinite(ms) ? ms : null; };

/** Main transcript rows -> delegation calls, their tool results and what the host says about itself. */
export function parseMain(rows, warnings = new Warnings()) {
  const calls = new Map();
  const results = new Map();
  const host = { versions: new Set(), entrypoints: new Set(), permissionModes: new Set() };
  let conversation = 0;
  for (const row of rows) {
    if (ident(row.version)) host.versions.add(row.version);
    if (ident(row.entrypoint)) host.entrypoints.add(row.entrypoint);
    if (ident(row.permissionMode)) host.permissionModes.add(row.permissionMode);
    const role = rowRole(row);
    if (role === null) continue;
    conversation++;
    for (const item of contentItems(row)) {
      if (role === 'assistant' && item.type === 'tool_use' && DELEGATION_TOOLS.has(item.name)) {
        if (typeof item.id !== 'string' || !item.id) { warnings.add('delegation_call_without_id'); continue; }
        if (calls.has(item.id)) { if (calls.get(item.id).time === null) calls.get(item.id).time = stampOf(row); continue; }
        if (!object(item.input)) { warnings.add('delegation_call_without_input'); continue; }
        calls.set(item.id, { id: item.id, input: item.input, prompt: typeof item.input.prompt === 'string' ? item.input.prompt : null,
          subagentType: str(item.input.subagent_type), time: stampOf(row) });
      } else if (role === 'user' && item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
        const detail = object(row.toolUseResult) ? row.toolUseResult : {};
        const decision = object(row.permissionDecision) ? row.permissionDecision : {};
        results.set(item.tool_use_id, { isError: item.is_error === true, rejected: decision.decision === 'reject',
          agentId: str(detail.agentId), status: ident(detail.status), resolvedModel: ident(detail.resolvedModel), time: stampOf(row) });
      }
    }
  }
  if (rows.length && !conversation) warnings.add('main_transcript_without_conversation_rows');
  return { calls, results, host };
}

function tokenSums(usageByMessage) {
  const sum = field => {
    let total = 0, any = false;
    for (const usage of usageByMessage.values()) {
      if (Number.isSafeInteger(usage[field]) && usage[field] >= 0) { total += usage[field]; any = true; }
    }
    return any ? total : null;
  };
  return { input: sum('input_tokens'), output: sum('output_tokens'), cacheRead: sum('cache_read_input_tokens'), cacheCreation: sum('cache_creation_input_tokens') };
}

/**
 * One subagent transcript -> what it was told and what it did. Text is read here (the first prompt, tool
 * inputs) but only derived facts leave this function: flags, counts, validated names.
 * knownSkills: Map of skill folder name -> skill name for the project skills this session knows about.
 */
export function parseSubagent(rows, { knownSkills = new Map() } = {}, warnings = new Warnings()) {
  const calls = [];
  const seenCalls = new Set();
  const results = new Map();
  const roots = new Set();
  const usageByMessage = new Map();
  const turns = new Set();
  const models = new Set();
  const efforts = new Set();
  const stamps = [];
  let firstPrompt = null, anonymous = 0, conversation = 0;
  for (const row of rows) {
    if (typeof row.type === 'string' && !CONVERSATION_TYPES.has(row.type)) continue;
    const role = rowRole(row);
    const stamp = stampOf(row);
    if (stamp !== null && (SPAN_TYPES.has(row.type) || role !== null)) stamps.push(stamp);
    if (role === null) continue;
    if (!object(row.message)) { warnings.add('conversation_row_without_message'); continue; }
    conversation++;
    // The project root as the host recorded it. Used here to tell a project path from another one; never returned.
    if (typeof row.cwd === 'string' && row.cwd.startsWith('/') && row.cwd.length > 1) roots.add(row.cwd.replace(/\/+$/, ''));
    if (role === 'user') {
      for (const item of contentItems(row)) {
        if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') results.set(item.tool_use_id, { isError: item.is_error === true });
      }
      // The first prompt is the first user text that is neither a harness reminder (isMeta) nor a tool result.
      if (firstPrompt === null && row.isMeta !== true && !contentItems(row).some(item => item.type === 'tool_result')) firstPrompt = messageText(row);
      continue;
    }
    // One API message is written as several rows (one per content block) that repeat the same usage: each id counts once.
    const messageId = str(row.message?.id) ?? `anonymous-${anonymous += 1}`;
    turns.add(messageId);
    if (ident(row.message?.model)) models.add(row.message.model);
    if (ident(row.effort)) efforts.add(row.effort);
    if (object(row.message?.usage)) usageByMessage.set(messageId, row.message.usage);
    for (const item of contentItems(row)) {
      if (item.type !== 'tool_use' || typeof item.name !== 'string') continue;
      const key = typeof item.id === 'string' ? item.id : `anonymous-${calls.length}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      calls.push({ id: typeof item.id === 'string' ? item.id : null, name: item.name, input: object(item.input) ? item.input : {} });
    }
  }
  if (anonymous) warnings.add('assistant_row_without_message_id', anonymous);
  const unanswered = calls.filter(call => call.id === null || !results.has(call.id)).length;
  if (unanswered) warnings.add('subagent_tool_call_without_result', unanswered);

  // Loads and indeterminate access: collector-access.mjs. A load needs a non-error tool result.
  const access = classifySkillAccess(calls, results, { known: knownSkills, roots: [...roots] });
  const firstWrite = calls.findIndex(call => WRITE_TOOLS.has(call.name));

  // The skills block as the subagent received it. It only counts where the hook puts it: at the very end of
  // the prompt, behind the routing packet (policy.mjs splitRoutingTail). A block typed anywhere else is task
  // text. Names are kept only when they are project skills this session knows; the others are counted.
  let block = { present: null, load: null, consider: null };
  if (firstPrompt !== null) {
    const tail = splitRoutingTail(firstPrompt);
    const match = tail ? /\n\n<jev-skills>\n([^\n]{1,8000})\n<\/jev-skills>\n[^\n]*$/.exec(firstPrompt.slice(tail.task.length)) : null;
    block = { present: Boolean(match), load: null, consider: null };
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        const names = new Set(knownSkills.values());
        let foreign = 0;
        const list = value => {
          if (!Array.isArray(value)) return null;
          const out = [];
          for (const entry of value) {
            const name = object(entry) ? entry.name : null;
            if (typeof name === 'string' && SKILL_ID.test(name) && names.has(name)) out.push(name); else foreign++;
          }
          return out;
        };
        block.load = list(parsed?.load);
        block.consider = list(parsed?.consider);
        if (foreign) warnings.add('skills_block_name_not_a_known_project_skill', foreign);
      } catch { warnings.add('skills_block_not_json'); }
    }
  } else warnings.add('subagent_first_prompt_not_found');
  if (models.size > 1) warnings.add('subagent_ran_on_several_models');
  if (efforts.size > 1) warnings.add('subagent_rows_carry_several_efforts');
  return {
    firstPrompt, block, conversationRows: conversation, apiTurns: turns.size, toolCalls: calls.length, unansweredToolCalls: unanswered,
    tokens: usageByMessage.size ? tokenSums(usageByMessage) : { input: null, output: null, cacheRead: null, cacheCreation: null },
    model: models.size === 1 ? [...models][0] : null, effort: efforts.size === 1 ? [...efforts][0] : null,
    wallMs: stamps.length >= 2 ? Math.max(...stamps) - Math.min(...stamps) : null,
    lastTime: stamps.length ? Math.max(...stamps) : null,
    loaded: access.loaded.map(l => ({ name: l.name, via: l.via, beforeFirstWrite: firstWrite < 0 ? null : l.index < firstWrite })),
    otherSkillCalls: access.otherSkillCalls, indeterminate: access.indeterminate, indeterminateReasons: access.reasons,
  };
}

// ---------------------------------------------------------------- question id -> skill name

/**
 * Which skill each `skill_<i>` question of each logged delegation.skills decision was about.
 * Returns { mapped: Map(decisionId -> [name, ...]), unmapped: [{ decisionId, reason }], method }.
 *
 * Rule (kernel/skills.mjs selectSkills): the judged skills are the first `candidates` entries of the BM25
 * ranking, cut into `requests` consecutive chunks of size ceil(candidates / requests) (the last may be
 * shorter). Request r asks `need` plus skill_0..skill_k about its chunk in rank order. decisionIds holds the
 * decision id of every request that answered, in request order; a failed request has none and its skills
 * carry stage 'judge_unavailable'.
 *
 * 1. A skills event that carries `asked` (written since this collector exists) states the names directly.
 * 2. Older events: the event's `trace` is the ranking with the unjudged entries removed, in rank order, so
 *    while it is complete (trace.length === candidates; it is cut at 64) entry r*size+i is skill_i of request
 *    r. This is exact, not a heuristic, and it is still cross-checked: the logged decision must have exactly
 *    chunk-length + 1 answers and every skill_i probability must equal the trace probability. Anything else
 *    stays unmapped.
 */
export function skillQuestionNames(event, decisionsById = new Map()) {
  const mapped = new Map();
  const unmapped = [];
  const ids = Array.isArray(event?.decisionIds) ? event.decisionIds.filter(id => hex(id)) : [];
  const consistent = (decisionId, names, probabilities) => {
    const logged = decisionsById.get(decisionId);
    if (!logged) return 'decision_not_in_log';
    if (logged.pointId !== SKILLS_POINT) return 'decision_of_another_point';
    const answers = object(logged.answers) ? logged.answers : {};
    if (Object.keys(answers).length !== names.length + 1 || !Object.hasOwn(answers, 'need')) return 'answer_count_mismatch';
    for (let i = 0; i < names.length; i++) {
      const answer = answers[`skill_${i}`];
      if (answer?.type !== 'noul') return 'answer_count_mismatch';
      if (probabilities && probabilities[i] !== answer.p) return 'probability_mismatch';
    }
    return null;
  };
  if (Array.isArray(event?.asked) && event.asked.length) {
    for (const entry of event.asked) {
      const decisionId = hex(entry?.decisionId);
      if (!decisionId) continue;
      const names = Array.isArray(entry.names) ? entry.names : [];
      const reason = !names.length || !names.every(n => typeof n === 'string' && SKILL_ID.test(n)) ? 'invalid_names' : consistent(decisionId, names, null);
      if (reason) unmapped.push({ decisionId, reason }); else mapped.set(decisionId, names);
    }
    for (const id of ids) if (!mapped.has(id) && !unmapped.some(u => u.decisionId === id)) unmapped.push({ decisionId: id, reason: 'not_in_asked_list' });
    return { mapped, unmapped, method: 'asked' };
  }
  const all = reason => ({ mapped, unmapped: ids.map(decisionId => ({ decisionId, reason })), method: 'derived' });
  const trace = Array.isArray(event?.trace) ? event.trace : null;
  const candidates = event?.candidates, requests = event?.retrieval?.requests;
  if (!trace || !Number.isSafeInteger(candidates) || candidates < 1 || !Number.isSafeInteger(requests) || requests < 1) return all('event_shape_unknown');
  if (trace.length !== candidates) return all('trace_incomplete');
  if (!trace.every(t => object(t) && typeof t.name === 'string' && SKILL_ID.test(t.name) && typeof t.stage === 'string')) return all('event_shape_unknown');
  const size = Math.ceil(candidates / requests);
  const chunks = [];
  for (let from = 0; from < candidates; from += size) chunks.push(trace.slice(from, from + size));
  if (chunks.length !== requests) return all('chunk_count_mismatch');
  const answered = chunks.filter(chunk => chunk.every(t => t.stage !== 'judge_unavailable'));
  // A chunk is answered or failed as a whole; a mixed chunk or a count that differs from decisionIds means
  // the event does not have the shape the rule was proven for.
  if (chunks.some(chunk => chunk.some(t => t.stage === 'judge_unavailable') && !chunk.every(t => t.stage === 'judge_unavailable'))) return all('event_shape_unknown');
  if (answered.length !== ids.length) return all('decision_count_mismatch');
  answered.forEach((chunk, k) => {
    const names = chunk.map(t => t.name);
    const reason = consistent(ids[k], names, chunk.map(t => t.probability));
    if (reason) unmapped.push({ decisionId: ids[k], reason }); else mapped.set(ids[k], names);
  });
  return { mapped, unmapped, method: 'derived' };
}

// ---------------------------------------------------------------- verification file

/**
 * A user-supplied file of externally verified task results: a JSON array, or { schema: 1, results: [...] }.
 * Each entry: exactly one of taskHash (see taskHash()) or toolUseId (any Agent call id of the delegation),
 * passed (boolean), optional conventionPassed (boolean), optional costUsd (number >= 0),
 * validator { name, version } (identifiers) and artifactSha256 (hex SHA-256 of the validator's report).
 * Unknown keys are refused: a file that carries more than this is not the file this reader expects.
 */
export function parseVerification(value) {
  const list = Array.isArray(value) ? value : object(value) && value.schema === 1 && Array.isArray(value.results) && Object.keys(value).every(k => ['schema', 'results'].includes(k)) ? value.results : null;
  assert(list && list.length <= MAX_VERIFICATION_ENTRIES, 'INVALID_VERIFICATION_FILE');
  const allowed = ['taskHash', 'toolUseId', 'passed', 'conventionPassed', 'costUsd', 'validator', 'artifactSha256'];
  const short = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,63}$/.test(x);
  return list.map(entry => {
    assert(object(entry) && Object.keys(entry).every(k => allowed.includes(k)), 'INVALID_VERIFICATION_ENTRY');
    const byHash = Object.hasOwn(entry, 'taskHash'), byCall = Object.hasOwn(entry, 'toolUseId');
    assert(byHash !== byCall, 'INVALID_VERIFICATION_KEY');
    if (byHash) assert(hex(entry.taskHash), 'INVALID_VERIFICATION_KEY');
    else assert(typeof entry.toolUseId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(entry.toolUseId), 'INVALID_VERIFICATION_KEY');
    assert(typeof entry.passed === 'boolean', 'INVALID_VERIFICATION_RESULT');
    assert(entry.conventionPassed === undefined || typeof entry.conventionPassed === 'boolean', 'INVALID_VERIFICATION_RESULT');
    assert(entry.costUsd === undefined || (finite(entry.costUsd) !== null && entry.costUsd >= 0), 'INVALID_VERIFICATION_COST');
    assert(object(entry.validator) && Object.keys(entry.validator).every(k => ['name', 'version'].includes(k))
      && short(entry.validator.name) && short(entry.validator.version), 'INVALID_VERIFICATION_VALIDATOR');
    assert(hex(entry.artifactSha256), 'INVALID_VERIFICATION_ARTIFACT');
    return { taskHash: byHash ? entry.taskHash : null, toolUseId: byCall ? entry.toolUseId : null, passed: entry.passed,
      conventionPassed: entry.conventionPassed ?? null, costUsd: entry.costUsd ?? null,
      validator: `${entry.validator.name}@${entry.validator.version}`, artifactSha256: entry.artifactSha256 };
  });
}

// ---------------------------------------------------------------- the join (pure)

/**
 * How the model id the host recorded compares with what the route asked for.
 *   exact             string-equal to the route's backend: accepted by the evidence importer
 *   declared          one of the ids the user declared for the profile's registry entry (`resolvesTo`): accepted
 *   alias-undeclared  not accepted. The route names the model by an alias that appears as a whole word of the
 *                     recorded id ("opus" in "claude-opus-5-5") and the registry declares no such id. This word
 *                     test only chooses between this label and 'mismatch' and decides what the summary suggests
 *                     the user look at; it never makes a row acceptable.
 *   mismatch          not accepted: anything else
 * `declared` is the list the caller passes: the declaration that was IN FORCE for the route, i.e. the list of
 * the profile as the given registry defines it now, and only when the route was recorded with that very profile
 * definition (same fingerprint). joinSession passes an empty list otherwise and labels a route whose recorded id
 * is declared now, but was not part of the definition the session ran with, 'declared-not-in-force' - not
 * accepted (the importer refuses such a row as STALE_EVIDENCE_PROFILE).
 */
export function modelMatch(effective, route, declared = []) {
  if (!effective || !route) return null;
  const backend = str(route.backend) ?? str(route.model);
  if (!backend) return null;
  const accepted = effectiveModelMatch({ backend, resolvesTo: declared }, effective);
  if (accepted) return accepted;
  const parts = effective.split(/[-.:/@]/);
  return [route.backend, route.model].some(w => str(w) && parts.includes(w)) ? 'alias-undeclared' : 'mismatch';
}

/**
 * Joins one session. Inputs are plain data (already read); output is plain data (nothing written).
 *   events        the session's hook events
 *   tasks         Map(tool_use_id -> stored decision record) for outputHash / reissueOf / repeatOf
 *   main          parseMain() result, or null when no transcripts were given
 *   subagents     Map(agentId -> { parsed, meta, error })
 *   decisionsById Map(decisionId -> decision log record)
 */
export function joinSession({ scope, runtime, events, tasks = new Map(), main = null, subagents = new Map(), decisionsById = new Map(),
  verification = [], evaluationContext = null, config = null }, warnings = new Warnings()) {
  const byTask = type => {
    const map = new Map();
    for (const e of events) if (e.type === type && typeof e.taskId === 'string') map.set(e.taskId, e);
    return map;
  };
  const routes = byTask('route'), deferred = byTask('route_deferred'), reissued = byTask('delegation_reissued'), repeated = byTask('delegation_repeated');
  const spawns = byTask('spawn_observed'), skillsEvents = byTask('skills');
  const supervisorEvents = events.filter(e => e.type === 'supervisor' && typeof e.taskId === 'string');
  // Declared resolved ids come from the registry of the given config and from nowhere else. A profile id
  // contains a hash of its model and backend, so a profile found by id is the one the route named.
  let catalog = [];
  if (config && runtime === 'claude') { try { catalog = profileCatalog(config.registry, 'claude'); } catch { warnings.add('registry_unreadable_for_declared_ids'); } }
  const profileOf = route => catalog.find(p => p.profileId === route?.profile && p.backend === route.backend) ?? null;
  const entryOf = route => {
    const profile = profileOf(route);
    if (profile) return profile.modelKey;
    const same = (config?.registry?.models ?? []).filter(m => m.runtime === 'claude' && m.backend === route.backend && m.model === route.model);
    return same.length === 1 && ident(same[0].id) ? same[0].id : null;
  };
  const matchCounts = { exact: 0, declared: 0, 'declared-not-in-force': 0, 'alias-undeclared': 0, mismatch: 0, notCompared: 0 };
  const undeclared = new Map();
  const resolvedCheck = { hookEvent: { agreed: 0, disagreed: 0, absent: 0 }, hostResult: { agreed: 0, disagreed: 0, absent: 0 } };
  // Agents the hooks saw end (SubagentStop, or the hand-back tool call).
  const ended = new Set(events.filter(e => (e.type === 'agent_stopped' || e.type === 'handback_observed') && typeof e.agentId === 'string').map(e => e.agentId));
  // Profile ids this session's routes named. Any other agent type is an inventory of the owner's environment
  // (user-level or plugin agents) and is stored as 'other'.
  const sessionProfiles = new Set(events.filter(e => e.type === 'route').map(e => ident(e.route?.profile)).filter(Boolean));
  const ids = new Set([...routes.keys(), ...deferred.keys(), ...reissued.keys(), ...repeated.keys(), ...spawns.keys(), ...(main ? main.calls.keys() : [])]);
  ids.delete('unknown');
  const timeOf = id => main?.calls.get(id)?.time ?? routes.get(id)?.time ?? reissued.get(id)?.time ?? repeated.get(id)?.time ?? deferred.get(id)?.time ?? spawns.get(id)?.time ?? 0;
  const ordered = [...ids].sort((a, b) => timeOf(a) - timeOf(b) || (a < b ? -1 : 1));

  // Which earlier call a call carries the decision of.
  //   reissue      the hook linked it (delegation_reissued): the refused call's decision, never judged twice
  //   repeat       the hook linked it (delegation_repeated): same input as an earlier routed call
  //   refused-call state from before the re-issue fix: the refused call and the call that launched were BOTH
  //                routed. The launched call's input is exactly the refused call's rewritten input
  //                (inputHash === the other's outputHash) and the refused call has no spawn event.
  const origin = new Map();
  const absorbed = new Set();
  for (const id of ordered) {
    const again = reissued.get(id);
    if (again && typeof again.reissueOf === 'string') { origin.set(id, { id: again.reissueOf, kind: 'reissue' }); absorbed.add(again.reissueOf); continue; }
    const repeat = repeated.get(id);
    if (repeat && typeof repeat.repeatOf === 'string') { origin.set(id, { id: repeat.repeatOf, kind: 'repeat' }); continue; }
    const inputHash = tasks.get(id)?.inputHash ?? routes.get(id)?.inputHash;
    if (!routes.has(id) || !hex(inputHash)) continue;
    const earlier = ordered.find(other => other !== id && !absorbed.has(other) && routes.has(other) && !spawns.has(other)
      && tasks.get(other)?.outputHash === inputHash && tasks.get(other)?.inputHash !== inputHash && timeOf(other) <= timeOf(id));
    if (earlier) { origin.set(id, { id: earlier, kind: 'refused-call' }); absorbed.add(earlier); }
  }

  const verificationFor = new Map();
  const groups = [];
  for (const id of ordered) {
    if (absorbed.has(id)) continue;
    const link = origin.get(id) ?? null;
    const callIds = link && link.kind !== 'repeat' ? [link.id, id] : [id];
    const result = main?.results.get(id) ?? null;
    const spawn = spawns.get(id) ?? null;
    const agentId = result?.agentId ?? (spawn && spawn.failed !== true ? str(spawn.agentId) : null);
    const sub = agentId ? subagents.get(agentId) ?? null : null;
    const ownRoute = object(routes.get(id)?.route) ? routes.get(id).route : null;
    const originRoute = link ? (object(routes.get(link.id)?.route) ? routes.get(link.id).route : object(tasks.get(id)?.route) ? tasks.get(id).route : null) : null;
    const agentType = ident(sub?.meta?.agentType) ?? ident(main?.calls.get(id)?.subagentType);
    // Which route the launched input came from. For the pre-fix shape the launched call was routed a second
    // time, but the host launched the input as issued (the first rewrite); the second route is only taken as
    // governing when the host's own record names its profile and not the first one's.
    let route = ownRoute, routeSource = ownRoute ? 'own' : null;
    if (link && originRoute) {
      const second = link.kind === 'refused-call' && ownRoute && agentType !== null && agentType === ownRoute.profile && agentType !== originRoute.profile;
      if (!second) { route = originRoute; routeSource = link.kind; }
    }
    const governingCall = routeSource === 'own' || !link ? id : link.id;

    // Original task text -> task hash. Read from the first call of the delegation in Main's transcript.
    const first = main?.calls.get(callIds[0]) ?? null;
    const head = main?.calls.get(id) ?? null;
    let hashOfTask = null;
    if (first?.prompt) hashOfTask = taskHash(first.prompt);
    else if (head?.prompt && splitRoutingTail(head.prompt)) hashOfTask = taskHash(head.prompt);

    let unjoined = null;
    if (!main) unjoined = 'no_transcripts';
    else if (runtime !== 'claude') unjoined = 'runtime_transcripts_unsupported';
    else if (!head) unjoined = 'agent_call_not_in_transcript';
    else if (spawn?.failed === true) unjoined = 'spawn_failed';
    else if (!agentId) unjoined = result && (result.rejected || result.isError) ? 'refused_and_not_reissued' : 'never_launched';
    else if (!sub) unjoined = 'subagent_transcript_missing';
    else if (sub.error) unjoined = 'subagent_transcript_unreadable';
    else if (!sub.parsed.apiTurns) unjoined = 'subagent_transcript_without_assistant_rows';
    else if (str(sub.meta?.toolUseId) && sub.meta.toolUseId !== id) unjoined = 'subagent_meta_names_another_call';
    // A transcript is read as the whole run only when something says the run ended: the host's own record
    // (meta `finished`), or, where the host recorded nothing, a stop or hand-back the hooks saw for that agent.
    // Otherwise "did not load" and the token totals would be guesses about a run still in progress or a cut copy.
    else if (sub.meta?.finished === false) unjoined = 'subagent_not_finished';
    else if (sub.meta?.finished !== true && !ended.has(agentId)) unjoined = 'subagent_end_unconfirmed';
    if (main && head) {
      const stored = tasks.get(id)?.inputHash ?? routes.get(id)?.inputHash ?? reissued.get(id)?.inputHash ?? repeated.get(id)?.inputHash;
      if (hex(stored) && hash(head.input) !== stored) warnings.add('transcript_input_differs_from_hook_input');
    }
    const routeMode = route ? str(routes.get(governingCall)?.mode) : null;
    groups.push({ id, callIds, link, route, routeSource, routeMode, governingCall, ownRoute, agentType, agentId, sub: unjoined ? null : sub, unjoined,
      taskHash: hashOfTask, startTime: first?.time ?? head?.time ?? null, time: timeOf(id),
      unrouted: route ? null : deferred.has(id) ? 'route_deferred' : 'no_route_recorded' });
  }

  // Verification entries -> groups. An entry by task hash is about the task: it is kept for every delegation of
  // that task text (verificationFor, used for the task's evaluation row), but it describes the FINAL state of
  // the work, so only the last launched delegation of the task carries it in its observation and its labels
  // (attemptVerification). An entry by call id names its delegation itself.
  const lastOfTask = new Map();
  for (const g of groups) if (g.taskHash && g.agentId) lastOfTask.set(g.taskHash, g.id);
  const namedByCall = new Set();
  let matchedEntries = 0;
  for (const entry of verification) {
    const hits = groups.filter(g => (entry.taskHash ? g.taskHash === entry.taskHash : g.callIds.includes(entry.toolUseId)));
    if (hits.length) matchedEntries++;
    for (const g of hits) {
      const prior = verificationFor.get(g.id);
      assert(!prior || hash(prior) === hash({ ...entry, taskHash: null, toolUseId: null }), 'CONFLICTING_VERIFICATION');
      verificationFor.set(g.id, { ...entry, taskHash: null, toolUseId: null });
      if (entry.toolUseId) namedByCall.add(g.id);
    }
  }
  const isLastOfTask = g => !g.taskHash || lastOfTask.get(g.taskHash) === g.id;
  const attemptVerification = g => (isLastOfTask(g) || namedByCall.has(g.id) ? verificationFor.get(g.id) ?? null : null);

  const observations = [], labels = [], settled = [], unlabelled = {}, accessReasons = {}, mapping = { decisions: 0, mapped: 0, asked: 0, derived: 0, unmapped: {}, answersCheckedAgainstLog: 0 };
  const usageOf = decisionId => decisionsById.get(decisionId)?.usage ?? null;
  const index = [];
  for (const g of groups) {
    const verified = attemptVerification(g);
    const skillsCalls = g.callIds.filter(id => skillsEvents.has(id));
    const governingSkills = skillsEvents.get(g.governingCall) ?? null;
    const decisions = [];
    const push = (point, decisionId, role) => { if (hex(decisionId) && !decisions.some(d => d.decisionId === decisionId)) decisions.push({ point, decisionId, role }); };
    for (const id of g.callIds) {
      const role = id === g.governingCall ? 'governing' : 'not-applied';
      const known = routes.get(id)?.judgeDecisionIds;
      if (object(known)) { push('delegation.classify', known.classify, role); push('delegation.profile', known.profile, role); }
      for (const decisionId of skillsEvents.get(id)?.decisionIds ?? []) push(SKILLS_POINT, decisionId, role);
    }
    // A repeated call shares the governing decisions of the call it repeats.
    if (g.link?.kind === 'repeat') {
      const known = routes.get(g.link.id)?.judgeDecisionIds;
      if (object(known)) { push('delegation.classify', known.classify, 'governing'); push('delegation.profile', known.profile, 'governing'); }
      for (const decisionId of skillsEvents.get(g.link.id)?.decisionIds ?? []) push(SKILLS_POINT, decisionId, 'governing');
    }
    const supervised = supervisorEvents.filter(e => g.callIds.includes(e.taskId)).sort((a, b) => a.time - b.time);
    const judged = supervised.filter(e => e.status === 'judged' && hex(e.decisionId));
    for (const e of judged) push(SUPERVISOR_POINT, e.decisionId, 'governing');
    const lastSupervisor = judged.at(-1) ?? supervised.at(-1) ?? null;

    // Skill question mapping for every skills decision of this delegation (reported even when nothing is labelled).
    const mappings = new Map();
    for (const id of g.link?.kind === 'repeat' ? [...skillsCalls, g.link.id].filter(x => skillsEvents.has(x)) : skillsCalls) {
      const m = skillQuestionNames(skillsEvents.get(id), decisionsById);
      mappings.set(id, m);
      mapping.decisions += m.mapped.size + m.unmapped.length;
      mapping.mapped += m.mapped.size;
      mapping[m.method] += m.mapped.size;
      for (const u of m.unmapped) bump(mapping.unmapped, u.reason);
      for (const names of m.mapped.values()) mapping.answersCheckedAgainstLog += names.length;
    }

    index.push({ delegationId: hash(['jev-collector-delegation', scope, g.id]), taskHash: g.taskHash, routed: Boolean(g.route),
      joined: !g.unjoined && Boolean(g.sub), profile: ident(g.route?.profile), verified: verified ? verified.passed : null,
      supersededAttempt: Boolean(g.taskHash && g.agentId) && !isLastOfTask(g) });
    if (g.unjoined || !g.sub) {
      // Decisions of a delegation that could not be joined to a finished, readable run get no label. Counted,
      // because the labelled decisions are what is left after this and every later filter.
      const lost = [...mappings.values()].reduce((n, m) => n + m.mapped.size + m.unmapped.length, 0) + judged.length;
      if (lost) bump(unlabelled, 'delegation_not_joined', lost);
      continue;
    }
    const s = g.sub.parsed;
    const effectiveModel = s.model ?? ident(g.sub.meta?.model);
    if (s.model && ident(g.sub.meta?.model) && s.model !== g.sub.meta.model) warnings.add('subagent_rows_and_meta_name_different_models');
    const routerEvents = g.callIds.map(id => routes.get(id)).filter(Boolean);
    const routerMs = routerEvents.length && routerEvents.every(e => finite(e.hookMs) !== null) ? routerEvents.reduce((n, e) => n + e.hookMs, 0) : null;
    const stages = routerEvents.map(e => e.route?.stageCount);
    const skillsRequests = skillsCalls.map(id => skillsEvents.get(id)?.retrieval?.requests);
    const reported = decisions.map(d => usageOf(d.decisionId)).filter(object);
    const tokenSum = key => { const known = reported.map(u => u[key]).filter(n => Number.isSafeInteger(n)); return known.length ? known.reduce((a, b) => a + b, 0) : null; };
    const endToEndMs = g.startTime !== null && s.lastTime !== null && s.lastTime >= g.startTime ? s.lastTime - g.startTime : null;
    // The subagent's first prompt is the call as issued, or (a rewrite applied in place) the issued text plus the appended tail.
    if (s.firstPrompt !== null && main.calls.get(g.id).prompt !== null && !s.firstPrompt.startsWith(main.calls.get(g.id).prompt)) warnings.add('subagent_prompt_differs_from_issued_call');
    // A declaration counts only for a route recorded with the profile definition that contains it. A session
    // that ran before the id was declared (the route carries another fingerprint) is not 'declared'.
    const routeProfile = profileOf(g.route);
    const inForce = Boolean(routeProfile) && routeProfile.fingerprint === g.route.profileFingerprint;
    let matchKind = modelMatch(effectiveModel, g.route, inForce ? routeProfile.resolvesTo ?? [] : []);
    if (!inForce && matchKind !== 'exact' && modelMatch(effectiveModel, g.route, routeProfile?.resolvesTo ?? []) === 'declared') matchKind = 'declared-not-in-force';
    if (g.route) {
      bump(matchCounts, matchKind ?? 'notCompared');
      if (matchKind === 'alias-undeclared') {
        const entry = entryOf(g.route);
        const key = `${entry}\n${g.route.backend}\n${effectiveModel}`;
        // `declarable`: whether the id has the form a declaration accepts at all (catalog.mjs RESOLVED_MODEL_ID).
        // A host id with other characters (brackets, a slash) is recorded and listed, but cannot be declared.
        const item = undeclared.get(key) ?? { registryEntry: entry, backend: ident(g.route.backend), observedModel: effectiveModel, declarable: RESOLVED_MODEL_ID.test(effectiveModel), delegations: 0 };
        item.delegations++;
        undeclared.set(key, item);
      }
    }
    // The host states the model it resolved for a launch in two more places: the Agent result the PostToolUse
    // hook saw (spawn_observed.resolvedModel, recorded by hooks from this version on) and the same result as
    // Main's transcript keeps it. Where one is present it must name the model the subagent's own rows name.
    g.resolvedDisagrees = false;
    if (effectiveModel !== null) {
      for (const [where, value] of [['hookEvent', ident(spawns.get(g.id)?.resolvedModel)], ['hostResult', main.results.get(g.id)?.resolvedModel ?? null]]) {
        if (value === null) resolvedCheck[where].absent++;
        else if (value === effectiveModel) resolvedCheck[where].agreed++;
        else { resolvedCheck[where].disagreed++; g.resolvedDisagrees = true; }
      }
    }
    const content = {
      schema: 1, delegationId: hash(['jev-collector-delegation', scope, g.id]), sessionScope: scope, taskHash: g.taskHash, runtime: 'claude', routed: Boolean(g.route),
      host: { version: [...main.host.versions].sort().at(-1) ?? null, entrypoint: [...main.host.entrypoints].sort()[0] ?? null,
        permissionMode: main.host.permissionModes.size === 1 ? [...main.host.permissionModes][0] : null },
      calls: { total: g.callIds.length, refused: g.callIds.length - 1, reissued: g.link?.kind === 'reissue', repeated: g.link?.kind === 'repeat',
        reroutedAfterRefusal: g.link?.kind === 'refused-call' },
      requested: { profile: ident(g.route?.profile), model: ident(g.route?.model), backend: ident(g.route?.backend), effort: ident(g.route?.effort),
        role: ident(g.route?.role), tier: ident(g.route?.tier), taskClass: ident(g.route?.taskClass), routeSource: g.routeSource },
      effective: { agentType: g.agentType === null ? null : sessionProfiles.has(g.agentType) ? g.agentType : 'other', model: effectiveModel, effort: s.effort, source: effectiveModel !== null || s.effort !== null ? 'native-transcript' : null,
        profileMatch: g.route && g.agentType ? g.agentType === g.route.profile : null, modelMatch: matchKind,
        effortMatch: g.route && s.effort !== null && typeof g.route.effort === 'string' ? s.effort === g.route.effort : null },
      skills: { mode: ['shadow', 'active'].includes(governingSkills?.mode) ? governingSkills.mode : null, status: ident(governingSkills?.status),
        need: finite(governingSkills?.need) !== null && governingSkills.need >= 0 && governingSkills.need <= 1 ? governingSkills.need : null,
        injectedByHook: typeof governingSkills?.injected === 'boolean' ? governingSkills.injected : null,
        blockInPrompt: s.block.present, blockLoad: s.block.load, blockConsider: s.block.consider,
        loaded: s.loaded, otherSkillCalls: s.otherSkillCalls, indeterminateAccess: s.indeterminate },
      usage: { apiTurns: s.apiTurns, toolCalls: s.toolCalls, tokens: s.tokens, wallMs: s.wallMs, endToEndMs },
      // A route event states how many judge stages ran; a delegation without one (deferred, preserved) has no count, not zero.
      judge: { routerRequests: stages.length && stages.every(Number.isSafeInteger) ? stages.reduce((a, b) => a + b, 0) : null,
        skillsRequests: skillsRequests.every(Number.isSafeInteger) ? skillsRequests.reduce((a, b) => a + b, 0) : null,
        supervisorRequests: judged.length, routerMs, tokensReported: reported.length, inputTokens: tokenSum('input_tokens'), outputTokens: tokenSum('output_tokens') },
      supervisor: lastSupervisor ? { status: ident(lastSupervisor.status) ?? 'unknown',
        outcome: ['complete', 'retry', 'replan', 'escalate'].includes(lastSupervisor.outcome) ? lastSupervisor.outcome : null,
        confidence: finite(lastSupervisor.confidence) !== null && lastSupervisor.confidence >= 0 && lastSupervisor.confidence <= 1 ? lastSupervisor.confidence : null,
        evidence: finite(lastSupervisor.evidence) !== null && lastSupervisor.evidence >= 0 ? lastSupervisor.evidence : null,
        advisory: typeof lastSupervisor.advisory === 'boolean' ? lastSupervisor.advisory : null, source: lastSupervisor.source === 'handback' ? 'handback' : 'inline' } : null,
      verification: verified ? { passed: verified.passed, conventionPassed: verified.conventionPassed, validator: verified.validator, artifactSha256: verified.artifactSha256 } : null,
      decisions,
    };
    // A record that fails its own validator is a collector defect or an unknown shape; it is dropped and counted, never written.
    if (!isObservationRecord({ ...content, time: 0, observationId: observationId({ ...content, time: 0 }) })) { warnings.add('observation_failed_validation'); continue; }
    observations.push(content);
    g.observation = content;
    g.supervisorJudged = judged;

    // ---- labels
    const isLast = isLastOfTask(g);
    const taskVerified = verificationFor.has(g.id);
    const loadedNames = new Set(s.loaded.map(l => l.name));
    for (const [reason, n] of Object.entries(s.indeterminateReasons ?? {})) bump(accessReasons, reason, n);
    const label = (decisionId, questionId, outcome, source, point) => labels.push({ decisionId, questionId, outcome, source, point });
    // What the subagent was told decides the source: with the block of this decision in its prompt, a load is
    // partly the decision's own doing. Unknown block presence gives no label at all.
    const injected = s.block.present;
    const loadSource = injected === true ? SOURCE_OBSERVED_LOAD_INJECTED : SOURCE_OBSERVED_LOAD;
    const withLoadSource = injected === true ? SOURCE_EXTERNAL_WITH_LOAD_INJECTED : SOURCE_EXTERNAL_WITH_LOAD;
    for (const [callId, m] of mappings) {
      const count = m.mapped.size + m.unmapped.length;
      if (!count) continue;
      if (m.unmapped.length) bump(unlabelled, 'skills_question_mapping_unproven', m.unmapped.length);
      if (!m.mapped.size) continue;
      // Only the decision whose result reached this subagent is labelled from what the subagent did.
      if (g.link?.kind === 'repeat') { bump(unlabelled, 'skills_decision_shared_with_repeated_call', m.mapped.size); continue; }
      if (callId !== g.governingCall) { bump(unlabelled, 'skills_decision_not_applied_to_launched_call', m.mapped.size); continue; }
      // From here on this run decides what the labels of these decisions are: a label an earlier run wrote
      // that this run does not derive is retracted by the caller (`settled`).
      for (const [decisionId, names] of m.mapped) {
        settled.push({ decisionId, point: SKILLS_POINT, questionIds: ['need', ...names.map((_, i) => `skill_${i}`)],
          sources: [...LOAD_SOURCES, ...(taskVerified ? WITH_LOAD_SOURCES : [])] });
      }
      if (s.indeterminate) { bump(unlabelled, 'skills_access_indeterminate', m.mapped.size); continue; }
      if (injected === null) { bump(unlabelled, 'skills_block_presence_unknown', m.mapped.size); continue; }
      for (const [decisionId, names] of m.mapped) {
        // Each judge request asked `need` about its OWN skills only, so its label is about those skills only.
        const needed = names.some(name => loadedNames.has(name));
        label(decisionId, 'need', needed, loadSource, SKILLS_POINT);
        names.forEach((name, i) => label(decisionId, `skill_${i}`, loadedNames.has(name), loadSource, SKILLS_POINT));
        if (verified?.conventionPassed === true && isLast) {
          if (needed) label(decisionId, 'need', true, withLoadSource, SKILLS_POINT);
          names.forEach((name, i) => { if (loadedNames.has(name)) label(decisionId, `skill_${i}`, true, withLoadSource, SKILLS_POINT); });
        }
      }
    }
    if (judged.length) {
      const target = judged.at(-1);
      if (judged.length > 1) bump(unlabelled, 'supervisor_earlier_handback', judged.length - 1);
      const logged = decisionsById.get(target.decisionId);
      if (taskVerified) settled.push({ decisionId: target.decisionId, point: SUPERVISOR_POINT, questionIds: ['outcome'], sources: [SOURCE_EXTERNAL] });
      if (!taskVerified) bump(unlabelled, 'supervisor_no_external_verification');
      else if (!verified) bump(unlabelled, 'supervisor_earlier_attempt_of_task');
      // A failed check says the work is not complete; it does not say whether to retry, replan or escalate.
      else if (!verified.passed) bump(unlabelled, 'supervisor_verification_failed_no_outcome_class');
      else if (!isLast) bump(unlabelled, 'supervisor_earlier_attempt_of_task');
      else if (!logged || !Object.hasOwn(logged.answers ?? {}, 'outcome')) bump(unlabelled, 'supervisor_decision_not_in_log');
      else label(target.decisionId, 'outcome', 'complete', SOURCE_EXTERNAL, SUPERVISOR_POINT);
    }
  }

  // ---- candidate evaluation rows: one per verified task text
  const evaluations = [], withheld = {};
  let withheldTasks = 0;
  const context = str(evaluationContext) ?? str(config?.optimization?.evaluationContext);
  const tasksSeen = new Map();
  for (const g of groups) {
    if (!verificationFor.has(g.id)) continue;
    const key = g.taskHash ?? `call:${g.id}`;
    if (!tasksSeen.has(key)) tasksSeen.set(key, []);
    tasksSeen.get(key).push(g);
  }
  for (const [key, members] of tasksSeen) {
    const reasons = new Set();
    const verified = verificationFor.get(members.at(-1).id);
    // Every delegation of this task text in the session counts as an attempt, verified entry or not.
    const all = key.startsWith('call:') ? members : groups.filter(g => g.taskHash === key);
    const ran = all.filter(g => g.observation);
    if (key.startsWith('call:')) reasons.add('task_hash_unknown');
    if (!context || context === UNVALIDATED_CONTEXT) reasons.add('evaluation_context_not_configured');
    if (all.some(g => !g.observation)) reasons.add('attempt_not_joined_to_transcripts');
    if (all.some(g => !g.route)) reasons.add('delegation_not_routed');
    // A row credits the route's profile, so the route must have been applied (a shadow-mode route is recorded
    // and never applied) and the host must have recorded that profile's agent as the one that ran.
    for (const g of all) {
      if (!g.route) continue;
      // A row is evidence for the evaluation context the session actually ran under. A route recorded under
      // the default (unvalidated) context, or under another name, is not relabelled by naming a context later.
      if (context && context !== UNVALIDATED_CONTEXT) {
        const recorded = str(g.route.evaluationContext);
        if (recorded === null) reasons.add('route_evaluation_context_unknown');
        else if (recorded === UNVALIDATED_CONTEXT) reasons.add('session_ran_under_default_evaluation_context');
        else if (recorded !== context) reasons.add('session_ran_under_another_evaluation_context');
      }
      if (g.routeMode !== 'active') reasons.add(g.routeMode === null ? 'route_mode_unknown' : 'route_not_applied');
      if (g.observation && g.agentType === null) reasons.add('agent_type_unknown');
      else if (g.observation && g.agentType !== g.route.profile) reasons.add('agent_type_differs_from_profile');
    }
    const routesUsed = ran.map(g => g.route).filter(Boolean);
    const route = routesUsed[0] ?? null;
    if (new Set(routesUsed.map(r => r.profile)).size > 1) reasons.add('task_ran_under_several_profiles');
    // The row states one effective model; attempts on two different accepted ids are not folded into one.
    if (new Set(ran.map(g => g.observation.effective.model)).size > 1) reasons.add('task_ran_on_several_models');
    if (route && !(ident(route.profile) && hex(route.profileFingerprint) && hex(route.projectHash) && typeof route.taskClass === 'string' && route.taskClass)) reasons.add('route_fields_missing');
    // The importer's stale-profile check, stated here as well so that it is counted next to the other reasons
    // (the importer itself only sees a row that nothing else withheld): the profile as the given registry
    // defines it now - declared resolved ids included - must be the one the route was recorded with.
    if (route && catalog.length && catalog.find(p => p.profileId === route.profile)?.fingerprint !== route.profileFingerprint) reasons.add('importer_refuses:STALE_EVIDENCE_PROFILE');
    for (const g of ran) {
      const e = g.observation.effective;
      if (e.model === null || e.effort === null) reasons.add('effective_setting_not_recorded_by_host');
      else if (g.route) {
        // Only an exact backend match or an id the user declared is accepted; an alias match is not.
        if (e.modelMatch === 'alias-undeclared') reasons.add('effective_model_alias_undeclared');
        else if (e.modelMatch === 'declared-not-in-force') reasons.add('effective_model_declared_after_session');
        else if (e.modelMatch !== 'exact' && e.modelMatch !== 'declared') reasons.add('effective_model_mismatch');
        if (e.effort !== g.route.effort) reasons.add('effective_effort_differs_from_profile');
      }
      if (g.resolvedDisagrees) reasons.add('resolved_model_disagrees_with_transcript');
      if (g.observation.usage.endToEndMs === null || g.observation.usage.endToEndMs <= 0) reasons.add('duration_not_measured');
      // Judge time after the subagent ended (the report check) is added from the decision log; without the record it is unknown.
      if (g.supervisorJudged.some(e2 => finite(decisionsById.get(e2.decisionId)?.latencyMs) === null)) reasons.add('supervisor_judge_time_unknown');
    }
    let row = null;
    if (!reasons.size && route && ran.length) {
      const supervisorMs = ran.flatMap(g => g.supervisorJudged).reduce((n, e) => n + decisionsById.get(e.decisionId).latencyMs, 0);
      row = {
        schema: 1, kind: 'live-evaluation', taskId: key, taskClass: route.taskClass, context, projectHash: route.projectHash,
        profileId: route.profile, profileFingerprint: route.profileFingerprint, runtime: 'claude',
        createdAt: Math.round(Math.max(...ran.map(g => g.sub.parsed.lastTime))),
        effective: { confirmed: true, model: ran[0].observation.effective.model, effort: ran[0].observation.effective.effort, source: 'native-transcript',
          modelMatch: ran[0].observation.effective.modelMatch },
        verification: { source: 'independent-validator', passed: verified.passed, artifactSha256: verified.artifactSha256, validatorVersion: verified.validator },
        // End-to-end: from Main issuing the first call (so the routing hook, a refused call and the re-issue
        // round are inside) to the subagent's last row, summed over the task's delegations, plus report-check judge time.
        durationMs: ran.reduce((n, g) => n + g.observation.usage.endToEndMs, 0) + supervisorMs,
        costUsd: verified.costUsd,
        attempts: all.reduce((n, g) => n + g.callIds.length, 0),
        accounting: 'all-attempts-including-failures-and-router',
      };
      if (config) {
        // The importer's own validation, with the context this run stamps: a row it would refuse is not produced.
        try { validateEvaluation(row, { ...config, optimization: { ...config.optimization, evaluationContext: context } }); }
        catch (e) { reasons.add(`importer_refuses:${/^[A-Z0-9_]+$/.test(e.code ?? '') ? e.code : 'UNKNOWN'}`); row = null; }
      }
    }
    if (row) evaluations.push(row);
    else { withheldTasks++; for (const reason of reasons.size ? reasons : ['no_joined_attempt']) bump(withheld, reason); }
  }

  const unjoined = {}, unrouted = {};
  for (const g of groups) {
    if (g.unjoined) bump(unjoined, g.unjoined);
    if (g.unrouted) bump(unrouted, g.unrouted);
  }
  return {
    groups: groups.length, calls: ordered.length, index, observations, labels, settled, unlabelled, accessReasons, mapping, evaluations,
    evaluationsWithheld: { tasks: withheldTasks, reasons: withheld }, evaluationContext: context ?? null,
    modelMatch: { delegations: matchCounts, undeclared: [...undeclared.values()], resolvedModelCheck: resolvedCheck },
    counts: { seen: groups.length, routed: groups.filter(g => g.route).length, joined: groups.filter(g => g.observation).length, unjoined, unrouted,
      refusedAndReissued: groups.filter(g => g.link?.kind === 'reissue').length, reroutedAfterRefusal: groups.filter(g => g.link?.kind === 'refused-call').length,
      repeated: groups.filter(g => g.link?.kind === 'repeat').length },
    verification: { entries: verification.length, matched: matchedEntries, unmatched: verification.length - matchedEntries },
  };
}

// ---------------------------------------------------------------- IO

async function readState(stateDir, warnings) {
  const sessions = [];
  let entries;
  try { entries = await listDirectory(path.join(stateDir, 'sessions'), MAX_SESSIONS); }
  catch (e) { if (e.code === 'SOURCE_MISSING') return sessions; throw e; }
  for (const entry of entries.filter(e => e.isDirectory() && HEX64.test(e.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const dir = path.join(stateDir, 'sessions', entry.name);
    let files;
    try { files = await listDirectory(path.join(dir, 'events'), MAX_EVENT_FILES); } catch (e) { warnings.add(`session_events_${e.code === 'SOURCE_MISSING' ? 'missing' : 'unreadable'}`); continue; }
    const events = [];
    for (const file of files.filter(f => f.name.endsWith('.json')).map(f => f.name).sort()) {
      try {
        const event = await readJsonFile(path.join(dir, 'events', file), MAX_STATE_FILE_BYTES);
        if (object(event) && typeof event.type === 'string' && finite(event.time) !== null) events.push(event); else warnings.add('event_shape_unknown');
      } catch (e) { warnings.add(e.code === 'SYMLINK_SOURCE' ? 'symlink_refused' : 'event_unreadable'); }
    }
    events.sort((a, b) => a.time - b.time);
    // Events before the last /clear belong to an earlier epoch of the same session id.
    const reset = events.filter(e => e.type === 'session_reset').at(-1)?.time ?? 0;
    sessions.push({ scope: entry.name, dir, events: events.filter(e => e.time >= reset) });
  }
  return sessions;
}

async function readTasks(session, ids, warnings) {
  const tasks = new Map();
  for (const id of ids) {
    try {
      const task = await readJsonFile(path.join(session.dir, 'decisions', hash(id) + '.json'), MAX_STATE_FILE_BYTES);
      if (object(task)) tasks.set(id, task);
    } catch (e) { if (e.code !== 'SOURCE_MISSING') warnings.add(e.code === 'SYMLINK_SOURCE' ? 'symlink_refused' : 'task_record_unreadable'); }
  }
  return tasks;
}

async function readTranscripts(dir, warnings) {
  const entries = await listDirectory(dir, MAX_SUBAGENT_FILES);
  const mains = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => e.name).sort();
  if (entries.some(e => e.isSymbolicLink())) warnings.add('symlink_refused');
  assert(mains.length > 0, 'MAIN_TRANSCRIPT_NOT_FOUND');
  assert(mains.length <= MAX_MAIN_FILES, 'TOO_MANY_MAIN_TRANSCRIPTS');
  if (mains.length > 1) warnings.add('several_main_transcripts_read');
  const rows = [];
  for (const name of mains) {
    const parsed = parseJsonl(await readBounded(path.join(dir, name), MAX_TRANSCRIPT_BYTES));
    if (parsed.bad) warnings.add('unparsable_transcript_line', parsed.bad);
    rows.push(...parsed.rows);
  }
  const files = new Map();
  let subEntries = [];
  try { subEntries = await listDirectory(path.join(dir, 'subagents'), MAX_SUBAGENT_FILES); }
  catch (e) { warnings.add(e.code === 'SOURCE_MISSING' ? 'subagents_folder_missing' : e.code === 'SYMLINK_SOURCE' ? 'symlink_refused' : 'subagents_folder_unreadable'); }
  for (const entry of subEntries) {
    const match = AGENT_FILE.exec(entry.name);
    if (!match) continue;
    if (entry.isSymbolicLink()) { warnings.add('symlink_refused'); files.set(match[1], { error: 'SYMLINK_SOURCE' }); continue; }
    files.set(match[1], { file: path.join(dir, 'subagents', entry.name), meta: path.join(dir, 'subagents', `agent-${match[1]}.meta.json`) });
  }
  return { mainRows: rows, files };
}

async function loadSubagents(files, knownSkills, warnings) {
  const out = new Map();
  for (const [agentId, entry] of files) {
    if (entry.error) { out.set(agentId, { error: entry.error }); continue; }
    try {
      const parsed = parseJsonl(await readBounded(entry.file, MAX_TRANSCRIPT_BYTES));
      if (parsed.bad) warnings.add('unparsable_transcript_line', parsed.bad);
      let meta = null;
      try {
        const raw = await readJsonFile(entry.meta, MAX_STATE_FILE_BYTES);
        if (object(raw)) meta = { agentType: str(raw.agentType), model: str(raw.model), toolUseId: str(raw.toolUseId), finished: typeof raw.finished === 'boolean' ? raw.finished : null }; else warnings.add('subagent_meta_shape_unknown');
      } catch (e) { warnings.add(e.code === 'SOURCE_MISSING' ? 'subagent_meta_missing' : e.code === 'SYMLINK_SOURCE' ? 'symlink_refused' : 'subagent_meta_unreadable'); }
      out.set(agentId, { parsed: parseSubagent(parsed.rows, { knownSkills }, warnings), meta });
    } catch (e) {
      warnings.add(e.code === 'SYMLINK_SOURCE' ? 'symlink_refused' : e.code === 'SOURCE_TOO_LARGE' ? 'transcript_too_large' : 'subagent_transcript_unreadable');
      out.set(agentId, { error: e.code ?? 'SOURCE_UNREADABLE' });
    }
  }
  return out;
}

const candidateFileName = scope => `evaluations-${scope.slice(0, 16)}.candidate.jsonl`;

/**
 * Runs the collector over one state directory and (optionally) one session's transcripts.
 *   stateDir        absolute hook state directory (holds sessions/ and decisions-log/)
 *   transcriptsDir  folder with the session's main *.jsonl and subagents/; without it only the state is summarised
 *   verification    parsed verification entries (parseVerification)
 *   skillFolders    Map(folder -> skill name) of project skills, for sessions whose state names none (skills point off)
 *   config          loaded config; when given, candidate rows also pass the importer's own validation
 * Returns the summary. With dryRun nothing is written anywhere.
 */
export async function collect({ stateDir, transcriptsDir = null, verification = [], outDir = null, dryRun = false, evaluationContext = null,
  config = null, skillFolders = new Map(), now = Date.now } = {}) {
  assert(typeof stateDir === 'string' && path.isAbsolute(stateDir), 'ABSOLUTE_STATE_REQUIRED');
  assert(transcriptsDir === null || (typeof transcriptsDir === 'string' && path.isAbsolute(transcriptsDir)), 'ABSOLUTE_TRANSCRIPTS_REQUIRED');
  assert(outDir === null || (typeof outDir === 'string' && path.isAbsolute(outDir)), 'ABSOLUTE_OUT_REQUIRED');
  assert(evaluationContext === null || (typeof evaluationContext === 'string' && IDENTIFIER.test(evaluationContext) && evaluationContext.length <= 200), 'INVALID_EVALUATION_CONTEXT');
  const warnings = new Warnings();
  const stat = await fs.lstat(stateDir).catch(() => null);
  assert(stat && !stat.isSymbolicLink() && stat.isDirectory(), stat?.isSymbolicLink() ? 'SYMLINK_SOURCE' : 'STATE_DIR_NOT_FOUND');
  const log = new DecisionLog(path.join(stateDir, 'decisions-log'), { now });
  const store = new ObservationLog(path.join(stateDir, 'observations-log'), { now });
  const logged = await log.read();
  if (logged.corruptLines) warnings.add('decision_log_corrupt_line', logged.corruptLines);
  const decisionsById = new Map(logged.decisions.map(d => [d.decisionId, d]));
  const sessions = await readState(stateDir, warnings);
  const transcripts = transcriptsDir ? await readTranscripts(transcriptsDir, warnings) : null;
  const main = transcripts ? parseMain(transcripts.mainRows, warnings) : null;

  // The sessions this run is about: with transcripts, the ones whose events name a delegation call of the
  // transcript; without, every session that recorded a delegation.
  const taskIds = session => new Set(session.events.filter(e => typeof e.taskId === 'string' && e.taskId !== 'unknown'
    && ['route', 'route_deferred', 'delegation_reissued', 'delegation_repeated', 'spawn_observed', 'skills', 'supervisor'].includes(e.type)).map(e => e.taskId));
  const selected = sessions.filter(session => { const idsOf = taskIds(session); return main ? [...main.calls.keys()].some(id => idsOf.has(id)) : idsOf.size > 0; });
  if (main && main.calls.size && !selected.length) warnings.add('no_session_state_for_transcript');
  if (main && selected.length > 1) warnings.add('transcript_calls_found_in_several_sessions');

  const summary = {
    schema: 1, collector: COLLECTOR_VERSION, dryRun: Boolean(dryRun), mode: transcripts ? 'state-and-transcripts' : 'state-only',
    sessions: { inState: sessions.length, selected: selected.length },
    delegations: { seen: 0, routed: 0, joined: 0, unjoined: {}, unrouted: {}, refusedAndReissued: 0, reroutedAfterRefusal: 0, repeated: 0, agentCalls: 0 },
    skillQuestionMapping: { decisions: 0, mapped: 0, asked: 0, derived: 0, unmapped: {}, answersCheckedAgainstLog: 0 },
    labels: { written: {}, alreadyPresent: 0, retracted: {}, unlabelled: {}, indeterminateAccess: {} },
    observations: { written: 0, alreadyPresent: 0, keptVerified: 0 },
    evaluations: { produced: 0, producedByModelMatch: { exact: 0, declared: 0 }, withheldTasks: 0, withheld: {}, context: null, files: [], imported: false },
    // Routed, joined delegations by how the recorded model id compares with the route (see modelMatch()).
    // `undeclared` lists what was observed for the alias matches (entry, backend, recorded id). Nothing is
    // added to any registry by the collector.
    modelMatch: { delegations: { exact: 0, declared: 0, 'declared-not-in-force': 0, 'alias-undeclared': 0, mismatch: 0, notCompared: 0 }, declarationsKnown: Boolean(config), undeclared: [],
      resolvedModelCheck: { hookEvent: { agreed: 0, disagreed: 0, absent: 0 }, hostResult: { agreed: 0, disagreed: 0, absent: 0 } }, note: null },
    verification: { entries: verification.length, matched: 0, unmatched: 0 },
    supervisor: { judged: 0 },
    delegationIndex: [],
    warnings: {},
    host: { versions: main ? [...main.host.versions].sort() : [], entrypoints: main ? [...main.host.entrypoints].sort() : [],
      permissionModes: main ? [...main.host.permissionModes].sort() : [], subagentTranscripts: transcripts ? transcripts.files.size : null,
      supportedRuntimes: ['claude'], codex: 'unsupported: no codex transcript was ever observed, so none is parsed' },
  };
  // The label that currently stands for each (decision, question, source): the latest one, unless a later
  // retraction marker took it back. Idempotence and retraction both work on this, not on "was it ever written".
  const standing = new Map();
  const labelKey = (decisionId, questionId, source) => `${decisionId}\n${questionId}\n${source}`;
  for (const l of logged.labels) {
    if (l.source.endsWith(RETRACTION_SUFFIX)) standing.delete(labelKey(l.decisionId, l.questionId, l.source.slice(0, -RETRACTION_SUFFIX.length)));
    else standing.set(labelKey(l.decisionId, l.questionId, l.source), l.outcome);
  }
  // The record that currently stands for each delegation (kernel/observations.mjs latestObservations).
  const standingObservation = new Map(latestObservations((await store.read()).observations).map(o => [o.delegationId, o]));
  for (const session of selected) {
    const runtime = session.events.find(e => e.type === 'session_started')?.runtime ?? 'claude';
    const known = new Map(skillFolders);
    for (const e of session.events) {
      if (e.type !== 'skills') continue;
      for (const name of [...(Array.isArray(e.trace) ? e.trace.map(t => t?.name) : []), ...(Array.isArray(e.asked) ? e.asked.flatMap(a => a?.names ?? []) : [])]) {
        if (typeof name === 'string' && SKILL_ID.test(name) && ![...known.values()].includes(name)) known.set(name, name);
      }
    }
    if (transcripts && !known.size) warnings.add('project_skill_names_unknown');
    const subagents = transcripts && runtime === 'claude' ? await loadSubagents(transcripts.files, known, warnings) : new Map();
    const ids = new Set([...taskIds(session), ...(main ? main.calls.keys() : [])]);
    const tasks = await readTasks(session, ids, warnings);
    const joined = joinSession({ scope: session.scope, runtime, events: session.events, tasks, main, subagents, decisionsById, verification, evaluationContext, config }, warnings);

    const d = summary.delegations;
    d.seen += joined.counts.seen; d.routed += joined.counts.routed; d.joined += joined.counts.joined; d.agentCalls += joined.calls;
    d.refusedAndReissued += joined.counts.refusedAndReissued; d.reroutedAfterRefusal += joined.counts.reroutedAfterRefusal; d.repeated += joined.counts.repeated;
    for (const [k, n] of Object.entries(joined.counts.unjoined)) bump(d.unjoined, k, n);
    for (const [k, n] of Object.entries(joined.counts.unrouted)) bump(d.unrouted, k, n);
    const m = summary.skillQuestionMapping;
    for (const k of ['decisions', 'mapped', 'asked', 'derived', 'answersCheckedAgainstLog']) m[k] += joined.mapping[k];
    for (const [k, n] of Object.entries(joined.mapping.unmapped)) bump(m.unmapped, k, n);
    for (const [k, n] of Object.entries(joined.unlabelled)) bump(summary.labels.unlabelled, k, n);
    summary.supervisor.judged += session.events.filter(e => e.type === 'supervisor' && e.status === 'judged').length;
    summary.delegationIndex.push(...joined.index);
    summary.verification.matched += joined.verification.matched;

    for (const [k, n] of Object.entries(joined.accessReasons)) bump(summary.labels.indeterminateAccess, k, n);
    const derived = new Set();
    for (const l of joined.labels) {
      const key = labelKey(l.decisionId, l.questionId, l.source);
      derived.add(key);
      if (standing.has(key) && standing.get(key) === l.outcome) { summary.labels.alreadyPresent++; continue; }
      standing.set(key, l.outcome);
      if (!dryRun) await log.label(l.decisionId, { questionId: l.questionId, outcome: l.outcome, source: l.source });
      summary.labels.written[l.point] ??= {};
      bump(summary.labels.written[l.point], l.source);
    }
    // Retraction: a label of a collector source that stands for a decision this run settled, and that this run
    // does not derive (a corrected verification result, a transcript now read as indeterminate, a changed
    // rule), is taken back with a marker. The log is append-only; the marker is what calibration honours.
    for (const entry of joined.settled) {
      for (const questionId of entry.questionIds) {
        for (const source of entry.sources) {
          const key = labelKey(entry.decisionId, questionId, source);
          if (!standing.has(key) || derived.has(key)) continue;
          if (!dryRun) await log.label(entry.decisionId, { questionId, outcome: standing.get(key), source: source + RETRACTION_SUFFIX });
          standing.delete(key);
          summary.labels.retracted[entry.point] ??= {};
          bump(summary.labels.retracted[entry.point], source);
        }
      }
    }
    for (const content of joined.observations) {
      const key = observationId({ ...content, time: 0 });
      const current = standingObservation.get(content.delegationId) ?? null;
      if (current?.observationId === key) { summary.observations.alreadyPresent++; continue; }
      // A record without a verification result never replaces one that has it: the earlier record stays the
      // standing one. Re-run with the verification file to refresh it.
      if (current && current.verification !== null && content.verification === null) { summary.observations.keptVerified++; continue; }
      standingObservation.set(content.delegationId, { ...content, observationId: key });
      if (!dryRun) await store.append(content);
      summary.observations.written++;
    }
    summary.evaluations.produced += joined.evaluations.length;
    for (const row of joined.evaluations) bump(summary.evaluations.producedByModelMatch, row.effective.modelMatch);
    for (const [k, n] of Object.entries(joined.modelMatch.delegations)) bump(summary.modelMatch.delegations, k, n);
    for (const where of ['hookEvent', 'hostResult']) for (const [k, n] of Object.entries(joined.modelMatch.resolvedModelCheck[where])) bump(summary.modelMatch.resolvedModelCheck[where], k, n);
    for (const item of joined.modelMatch.undeclared) {
      const prior = summary.modelMatch.undeclared.find(u => u.registryEntry === item.registryEntry && u.backend === item.backend && u.observedModel === item.observedModel);
      if (prior) prior.delegations += item.delegations;
      else summary.modelMatch.undeclared.push({ ...item });
    }
    summary.evaluations.withheldTasks += joined.evaluationsWithheld.tasks;
    summary.evaluations.context = joined.evaluationContext;
    for (const [k, n] of Object.entries(joined.evaluationsWithheld.reasons)) bump(summary.evaluations.withheld, k, n);
    if (joined.evaluations.length && !dryRun) {
      const dir = outDir ?? path.join(stateDir, 'collector');
      const name = candidateFileName(session.scope);
      await atomicWrite(path.join(dir, name), joined.evaluations.map(row => JSON.stringify(row)).join('\n') + '\n');
      summary.evaluations.files.push(name);
    }
  }
  if (summary.modelMatch.undeclared.length) {
    summary.modelMatch.note = 'NOT ADDED. For each item, the host recorded `observedModel` for a route whose registry entry names `backend`. '
      + 'To have such runs accepted as evidence, the user adds the id to `resolvesTo` of that registry entry after checking that it is the model the entry means, '
      + 'reinstalls, and runs new sessions: a declaration changes the profile fingerprint, so sessions recorded before it stay unimportable.'
      + ' This list is what was observed, not a declaration and not a patch to apply: a host that re-points an alias to another model is listed here in the same way.'
      + (summary.modelMatch.undeclared.some(u => !u.declarable) ? ' An item with declarable:false has an id whose form `resolvesTo` does not accept; such runs cannot be made importable by a declaration.' : '')
      + (config ? '' : ' No config was given, so declared ids are unknown to this run and registryEntry is null.');
  }
  summary.verification.unmatched = verification.length - Math.min(verification.length, summary.verification.matched);
  summary.warnings = Object.fromEntries(Object.entries(warnings.counts).sort(([a], [b]) => (a < b ? -1 : 1)));
  return summary;
}

/** Folder -> skill name for a project's skills, from a loaded skill catalog (kernel/skills.mjs loadSkillCatalog). */
export function skillFoldersOf(catalog) {
  const out = new Map();
  for (const skill of Array.isArray(catalog?.skills) ? catalog.skills : []) {
    const match = /(?:^|[\\/])([^\\/]+)[\\/]SKILL\.md$/.exec(String(skill?.relPath ?? ''));
    if (match && typeof skill.name === 'string' && SKILL_ID.test(skill.name)) out.set(match[1], skill.name);
  }
  return out;
}
