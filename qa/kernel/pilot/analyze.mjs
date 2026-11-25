#!/usr/bin/env node
// Offline analyzer for one arm of the paired pilot. Reads only; no network, no session is started.
//   node analyze.mjs --arm <label> --project <dir> --state-dir <dir> --transcripts <dir> --out <file>
//                   [--sanitized-out <file>] [--template <dir>]
// Anything it cannot read in the expected shape becomes null plus a warning. It never guesses a value.
//
// Parsing was repaired on 2026-11-25 AFTER the two pilot sessions had run, against the real session files
// (see results/pilot-20261125/notes.txt). Outcome definitions were not changed. What the real files look like:
//  - A transcript holds conversation rows (type "user"/"assistant", plus "attachment") and request-log rows
//    ("api-request", "api-request-blob", ...). A request-log row repeats tool_use/tool_result items of the
//    conversation under the same ids; only conversation rows are read.
//  - In auto permission mode a hook that rewrites an Agent call's input makes the harness REFUSE that call
//    (tool_result is_error, permissionDecision.decision "reject", no PostToolUse, no spawn) and ask Main to issue
//    the call again with the rewritten input. So one delegation is two Agent tool calls: a refused attempt and
//    the call that launched. The refused attempt never ran; the task's delegation is the first call that was not
//    refused that way.
//  - The Agent tool returns at once ({ status: "async_launched", agentId }); the report comes back later.
//  - Each subagent has agent-<id>.jsonl plus agent-<id>.meta.json ({ agentType, model, toolUseId }).
//  - The harness shows a subagent the skills in an attachment row { type: "skill_listing", names: [...], content }.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject } from './checkers/check.mjs';
import { inScope } from './checkers/scopes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const CONVERSATION_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);
const SKILL_FILE = /(?:^|\/)\.claude\/skills\/([^/]+)\/SKILL\.md$/;
const SKILL_NAME_CHARS = 'A-Za-z0-9_.:-';
// How many catalog names a row must mention to be taken as the harness's skill listing.
const LISTING_MIN_NAMES = 3;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const str = (value) => (typeof value === 'string' && value !== '' ? value : null);

function listDir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return null; }
}

// Lines of a .jsonl file as objects; unparsable lines are counted, not guessed.
function readJsonl(file, warnings) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    warnings.push(`cannot read ${file}: ${error.code ?? error.message}`);
    return null;
  }
  const rows = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (isObject(parsed)) rows.push(parsed); else bad += 1;
    } catch { bad += 1; }
  }
  if (bad) warnings.push(`${bad} unparsable line(s) skipped in ${file}`);
  return rows;
}

// "user" / "assistant" for a conversation row, null for anything else (request-log rows carry a message with a
// role too, but they are copies). Rows without any "type" fall back to message.role.
const rowRole = (row) => {
  if (row?.type === 'user' || row?.type === 'assistant') return row.type;
  if (row?.type === undefined && (row?.message?.role === 'user' || row?.message?.role === 'assistant')) return row.message.role;
  return null;
};
const blockCount = (text, tag) => (typeof text === 'string' ? text.split(`<${tag}>`).length - 1 : null);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const round = (value) => (finite(value) === null ? null : Math.round(value));
const USAGE_FIELDS = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheCreation: 'cache_creation_input_tokens' };

// Sums message.usage over distinct message ids. One API message is written as several rows (one per content
// block) that repeat the same usage; each id is counted once. Rows without an id are counted as they come.
function tokenSums(usageByMessage, assistantMessages, warnings) {
  if (usageByMessage.size === 0) return null;
  const sum = (field) => {
    let total = 0;
    let any = false;
    for (const usage of usageByMessage.values()) {
      if (typeof usage[field] === 'number' && Number.isFinite(usage[field])) { total += usage[field]; any = true; }
    }
    return any ? total : null;
  };
  const tokens = { input: sum(USAGE_FIELDS.input), output: sum(USAGE_FIELDS.output), cacheRead: sum(USAGE_FIELDS.cacheRead), cacheCreation: sum(USAGE_FIELDS.cacheCreation),
    messages: usageByMessage.size, assistantMessages };
  const parts = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreation].filter((n) => n !== null);
  tokens.total = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  if (usageByMessage.size < assistantMessages) warnings.push(`token usage is present on ${usageByMessage.size} of ${assistantMessages} assistant messages; the token sums are partial`);
  return tokens;
}

const contentItems = (row) => (Array.isArray(row?.message?.content) ? row.message.content.filter(isObject) : []);

function messageText(row) {
  const content = row?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.filter((item) => isObject(item) && item.type === 'text' && typeof item.text === 'string').map((item) => item.text);
    return parts.length ? parts.join('\n') : null;
  }
  return null;
}

// ---------------------------------------------------------------- hook state
function readEvents(stateDir, warnings) {
  const events = [];
  const sessions = [];
  const sessionsDir = join(stateDir, 'sessions');
  const entries = listDir(sessionsDir);
  if (!entries) {
    warnings.push(`no sessions folder under state dir: ${sessionsDir}`);
    return { events, sessions };
  }
  for (const session of entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const files = (listDir(join(sessionsDir, session, 'events')) ?? []).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name).sort();
    sessions.push({ session, eventFiles: files.length });
    for (const file of files) {
      const full = join(sessionsDir, session, 'events', file);
      let parsed;
      try { parsed = JSON.parse(readFileSync(full, 'utf8')); } catch {
        warnings.push(`unparsable event file skipped: sessions/${session}/events/${file}`);
        continue;
      }
      for (const event of Array.isArray(parsed) ? parsed : [parsed]) {
        if (isObject(event) && typeof event.type === 'string') events.push({ ...event, _session: session, _file: file });
        else warnings.push(`event without a type skipped: sessions/${session}/events/${file}`);
      }
    }
  }
  if (sessions.length > 1) warnings.push(`state dir holds ${sessions.length} sessions; events of all of them were read`);
  return { events, sessions };
}

// decisions-log/*.jsonl: one row per judge decision ({ decisionId, pointId, provider, latencyMs, cached }).
function readDecisionLog(stateDir, warnings) {
  const byId = new Map();
  const rows = [];
  const dir = join(stateDir, 'decisions-log');
  for (const entry of (listDir(dir) ?? []).filter((item) => item.isFile() && item.name.endsWith('.jsonl')).map((item) => item.name).sort()) {
    for (const row of readJsonl(join(dir, entry), warnings) ?? []) {
      rows.push(row);
      if (str(row.decisionId)) byId.set(row.decisionId, row);
    }
  }
  return { rows, byId, found: rows.length > 0 };
}

const names = (list) => (Array.isArray(list)
  ? list.map((item) => (isObject(item) ? str(item.name) : str(item))).filter((name) => name !== null)
  : null);

// ---------------------------------------------------------------- Main transcript
function readMain(transcriptsDir, warnings) {
  const entries = listDir(transcriptsDir);
  const empty = { files: [], agentCalls: [], agentResults: new Map(), results: new Map(), rewrites: new Map(), info: null };
  if (!entries) {
    warnings.push(`transcripts folder not readable: ${transcriptsDir}`);
    return empty;
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name).sort();
  if (files.length === 0) warnings.push(`no Main transcript (*.jsonl) directly under ${transcriptsDir}`);
  if (files.length > 1) warnings.push(`${files.length} top-level transcripts found; all were read in name order: ${files.join(', ')}`);
  const agentCalls = [];
  const agentResults = new Map(); // tool_use_id -> agentId reported next to the tool result, when present
  const results = new Map(); // tool_use_id -> what the tool result row says (never its text)
  const rewrites = new Map(); // tool_use_id -> the input a PreToolUse hook produced for that call
  const seen = new Set();
  const seenTools = new Set();
  const toolNames = {};
  const usageByMessage = new Map();
  const assistantMessages = new Set();
  const models = new Set();
  const efforts = new Set();
  const permissionModes = new Set();
  const userPrompts = [];
  const stamps = [];
  let anonymous = 0;
  let taskToolCalls = 0;
  let requestLogRows = 0;
  for (const file of files) {
    for (const row of readJsonl(join(transcriptsDir, file), warnings) ?? []) {
      const stamp = Date.parse(str(row.timestamp) ?? '');
      if (Number.isFinite(stamp)) stamps.push(stamp);
      if (str(row.permissionMode)) permissionModes.add(row.permissionMode);
      // The input a PreToolUse hook returned for an Agent call (hook_success attachment, JSON on stdout).
      if (row.type === 'attachment' && isObject(row.attachment) && row.attachment.type === 'hook_success' && str(row.attachment.toolUseID)
        && String(row.attachment.hookName ?? '').startsWith('PreToolUse') && typeof row.attachment.stdout === 'string') {
        try {
          const updated = JSON.parse(row.attachment.stdout)?.hookSpecificOutput?.updatedInput;
          if (isObject(updated)) rewrites.set(row.attachment.toolUseID, { prompt: typeof updated.prompt === 'string' ? updated.prompt : null, subagentType: str(updated.subagent_type) });
        } catch { /* a hook that printed no JSON rewrote nothing */ }
      }
      const role = rowRole(row);
      if (role === null) {
        if (typeof row.type === 'string' && row.type.startsWith('api-request')) requestLogRows += 1;
        continue;
      }
      if (role === 'assistant') {
        assistantMessages.add(str(row.message?.id) ?? `anon-${anonymous += 1}`);
        if (str(row.message?.model)) models.add(row.message.model);
        if (str(row.effort)) efforts.add(row.effort);
        if (isObject(row.message?.usage)) usageByMessage.set(str(row.message.id) ?? `anon-usage-${anonymous += 1}`, row.message.usage);
      }
      if (role === 'user' && row.isMeta !== true && messageText(row) !== null && !contentItems(row).some((item) => item.type === 'tool_result')) userPrompts.push(messageText(row));
      for (const item of contentItems(row)) {
        if (item.type === 'tool_use' && typeof item.name === 'string' && typeof item.id === 'string' && !seenTools.has(item.id)) {
          seenTools.add(item.id);
          toolNames[item.name] = (toolNames[item.name] ?? 0) + 1;
        }
        if (item.type === 'tool_use' && item.name === 'Agent' && typeof item.id === 'string') {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          agentCalls.push({
            id: item.id,
            prompt: typeof item.input?.prompt === 'string' ? item.input.prompt : null,
            subagentType: str(item.input?.subagent_type),
            timestamp: str(row.timestamp),
          });
        } else if (item.type === 'tool_use' && item.name === 'Task') taskToolCalls += 1;
        else if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
          const detail = isObject(row.toolUseResult) ? row.toolUseResult : {};
          const decision = isObject(row.permissionDecision) ? row.permissionDecision : {};
          results.set(item.tool_use_id, {
            isError: item.is_error === true,
            agentId: str(detail.agentId),
            status: str(detail.status),
            resolvedModel: str(detail.resolvedModel),
            permission: str(decision.decision),
            reasonCode: str(decision.reasonCode) ?? str(row.toolDenialKind),
            timestamp: str(row.timestamp),
          });
          if (str(detail.agentId)) agentResults.set(item.tool_use_id, detail.agentId);
        }
      }
    }
  }
  if (taskToolCalls) warnings.push(`${taskToolCalls} tool call(s) named "Task" were seen and not counted as delegations (only "Agent" is)`);
  const info = {
    userPrompts,
    toolNames,
    models: [...models].sort(),
    efforts: [...efforts].sort(),
    permissionModes: [...permissionModes].sort(),
    tokens: tokenSums(usageByMessage, assistantMessages.size, warnings),
    wallMs: stamps.length >= 2 ? Math.max(...stamps) - Math.min(...stamps) : null,
    requestLogRowsIgnored: requestLogRows,
  };
  return { files, agentCalls, agentResults, results, rewrites, info };
}

// ---------------------------------------------------------------- subagent transcripts
function readSubagents(transcriptsDir, warnings) {
  const dir = join(transcriptsDir, 'subagents');
  const entries = listDir(dir);
  const agents = new Map();
  if (!entries) {
    warnings.push(`no subagents folder: ${dir}`);
    return agents;
  }
  for (const entry of entries) {
    const match = /^agent-(.+)\.jsonl$/.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    if (match[1].includes('.')) continue; // agent-<id>.meta.json / .prefix.json style siblings never match .jsonl, but be explicit
    let meta = null;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, `agent-${match[1]}.meta.json`), 'utf8'));
      if (isObject(parsed)) meta = { agentType: str(parsed.agentType), model: str(parsed.model), toolUseId: str(parsed.toolUseId) };
    } catch { /* no meta file: the transcript is still usable */ }
    agents.set(match[1], { file: join(dir, entry.name), rows: null, meta });
  }
  return agents;
}

function relativeToProject(filePath, projectRoots) {
  if (typeof filePath !== 'string' || filePath === '') return null;
  if (!isAbsolute(filePath)) return filePath.replace(/^\.\//, '');
  for (const root of projectRoots) {
    const rel = relative(root, filePath);
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split('\\').join('/');
  }
  return null; // outside the project
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The harness's skill listing as the subagent received it: the row before the first assistant turn that
// names the most catalog skills (at least LISTING_MIN_NAMES). The <jev-skills> block is cut out first, so a
// name that only the hook injected does not count as "listed". Shape-agnostic on purpose: the row is searched
// as serialised text, whatever its type (system, attachment, or a reminder inside the first user message).
function skillListing(rows, skillNames) {
  const none = { found: false, source: null, names: [], total: null, withDescription: null, otherNames: null };
  if (skillNames.size === 0) return none;
  // Real shape first: an attachment row { type: "skill_listing", names: [...], content: "- name: description" }.
  // "names" is exact, so nothing has to be guessed from text.
  for (const row of rows) {
    if (rowRole(row) === 'assistant') break;
    const attachment = isObject(row.attachment) ? row.attachment : null;
    if (attachment?.type !== 'skill_listing' || !Array.isArray(attachment.names)) continue;
    const listed = attachment.names.filter((name) => typeof name === 'string');
    const inCatalog = listed.filter((name) => skillNames.has(name)).sort();
    const content = typeof attachment.content === 'string' ? attachment.content : null;
    return {
      found: true, source: 'attachment:skill_listing', names: inCatalog, total: listed.length,
      // catalog names that the listing text shows as "- name: <something>", i.e. with a description
      withDescription: content === null ? null : inCatalog.filter((name) => new RegExp(`(?:^|\\n)- ${escapeRegExp(name)}: \\S`).test(content)).length,
      otherNames: listed.filter((name) => !skillNames.has(name)).sort(),
    };
  }
  let best = none;
  for (const row of rows) {
    if (rowRole(row) === 'assistant') break;
    if (typeof row.type === 'string' && !CONVERSATION_TYPES.has(row.type)) continue;
    let text;
    try { text = JSON.stringify(row); } catch { continue; }
    text = text.replace(/<jev-skills>[\s\S]*?<\/jev-skills>/g, ' ');
    const listed = [...skillNames].filter((name) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(name)}(?![A-Za-z0-9_-])`).test(text));
    if (listed.length >= LISTING_MIN_NAMES && listed.length > best.names.length) {
      const kind = str(row.type) ?? 'unknown';
      best = { ...none, found: true, source: isObject(row.attachment) && str(row.attachment.type) ? `${kind}:${row.attachment.type}` : kind, names: listed.sort() };
    }
  }
  return best;
}

// A Bash command that looks like it writes a file (redirect, heredoc, sed -i, tee, cp/mv). A heuristic used only
// to say "files were probably written through Bash"; it never feeds an outcome.
function bashWriteLike(command) {
  if (typeof command !== 'string') return false;
  const text = command.replace(/\d?>&\d/g, ' ').replace(/\b[12]>>?\s*\S+/g, ' ').replace(/>>?\s*\/dev\/null/g, ' ');
  return /\bsed\s+(?:-[A-Za-z]*i|--in-place)\b|\btee\s|\b(?:cp|mv)\s|writeFileSync|appendFileSync/.test(text) || /(?<![=\-0-9&|<>])>>?\s*["']?[\w./$~]/.test(text);
}

function summariseSubagent(rows, { task, projectRoots, skillNames }) {
  const warnings = [];
  const calls = [];
  const seenCalls = new Set();
  const usageByMessage = new Map();
  let anonymousUsage = 0;
  const stamps = [];
  let conversationRows = 0;
  let stampedConversationRows = 0;
  let firstUserText;
  const assistantMessages = new Set();
  let anonymousAssistant = 0;
  const models = new Set();
  const toolResults = new Map();
  for (const row of rows) {
    const stamp = str(row.timestamp);
    const ms = stamp !== null ? Date.parse(stamp) : NaN;
    if (Number.isFinite(ms)) stamps.push(ms);
    // Request-log rows (api-request, api-request-blob, ...) are copies of the conversation; they are not
    // counted as transcript rows and their tool_use items are not read.
    if (typeof row.type === 'string' && !CONVERSATION_TYPES.has(row.type)) continue;
    conversationRows += 1;
    if (Number.isFinite(ms)) stampedConversationRows += 1;
    const role = rowRole(row);
    if (role === 'user') {
      // The first prompt is the first user text that is not a harness reminder (isMeta) or a tool result.
      if (firstUserText === undefined && row.isMeta !== true && !contentItems(row).some((item) => item.type === 'tool_result')) {
        const text = messageText(row);
        if (text !== null) firstUserText = text;
      }
      for (const item of contentItems(row)) {
        if (item.type !== 'tool_result' || typeof item.tool_use_id !== 'string') continue;
        const decision = isObject(row.permissionDecision) ? row.permissionDecision : {};
        toolResults.set(item.tool_use_id, { isError: item.is_error === true, rejected: decision.decision === 'reject', reasonCode: str(decision.reasonCode) });
      }
    }
    if (role !== 'assistant') continue;
    assistantMessages.add(str(row.message?.id) ?? `anon-${anonymousAssistant += 1}`);
    if (str(row.message?.model)) models.add(row.message.model);
    for (const item of contentItems(row)) {
      if (item.type !== 'tool_use' || typeof item.name !== 'string') continue;
      const key = typeof item.id === 'string' ? item.id : `anon-${calls.length}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      calls.push({ id: key, name: item.name, input: isObject(item.input) ? item.input : {} });
    }
    const usage = row.message?.usage;
    if (isObject(usage)) {
      // One API message is often written as several lines (one per content block) that repeat the same
      // usage; count each message id once. Lines without an id are counted as they come.
      const id = str(row.message.id);
      if (id !== null) usageByMessage.set(id, usage);
      else usageByMessage.set(`anon-${anonymousUsage += 1}`, usage);
    }
  }

  // A load is: a Skill call naming the skill, a Read of its SKILL.md, or a Bash command that names its
  // SKILL.md. Anything else that touches the skill folders (Grep, Glob, a Bash command naming only a folder
  // or the whole skills folder, a Read of another file there) is kept as a "mention": the skill text may or
  // may not have been read, so it never counts as a load and never as "not loaded" either.
  const loaded = [];
  const mentions = [];
  const noteLoad = (name, via, index, raw) => {
    if (!loaded.some((entry) => entry.name === name)) loaded.push({ name, via, callIndex: index, ...(raw !== undefined && raw !== name ? { raw } : {}) });
  };
  const noteMention = (name, via, index) => {
    if (!mentions.some((entry) => entry.name === name && entry.via === via)) mentions.push({ name, via, callIndex: index });
  };
  const folderNames = (text) => [...String(text).matchAll(new RegExp(`\\.claude/skills/([A-Za-z0-9][${SKILL_NAME_CHARS}]{0,63})`, 'g'))].map((m) => m[1].replace(/[.:]+$/, ''));
  const scanText = (text, via, index, { loadsFromSkillFile }) => {
    if (typeof text !== 'string' || text === '') return;
    const touchesSkills = text.includes('.claude/skills');
    let named = 0;
    for (const name of skillNames) {
      const fileHit = new RegExp(`(?<![${SKILL_NAME_CHARS}])${escapeRegExp(name)}/SKILL\\.md`).test(text) && (touchesSkills || /SKILL\.md/.test(text));
      const folderHit = folderNames(text).includes(name);
      if (fileHit && loadsFromSkillFile) { noteLoad(name, via, index); named += 1; }
      else if (fileHit || folderHit) { noteMention(name, via, index); named += 1; }
    }
    if (touchesSkills && named === 0) noteMention(null, via, index);
  };
  const toolNames = {};
  const writes = [];
  const bashWrites = [];
  // Skill-search tools that belong to the owner's environment, not to the project: an MCP tool whose name
  // contains "skill", a ToolSearch query about skills, or a Skill call for a name outside the project catalog.
  const search = { mcpSkillTools: {}, toolSearchForSkill: 0, nonCatalogSkillCalls: [] };
  const rejectedCalls = [];
  let toolErrors = 0;
  calls.forEach((call, index) => {
    toolNames[call.name] = (toolNames[call.name] ?? 0) + 1;
    const outcome = toolResults.get(call.id);
    if (outcome?.isError) toolErrors += 1;
    if (outcome?.rejected) rejectedCalls.push({ tool: call.name, reasonCode: outcome.reasonCode });
    if (/^mcp__/.test(call.name) && /skill/i.test(call.name)) search.mcpSkillTools[call.name] = (search.mcpSkillTools[call.name] ?? 0) + 1;
    if (call.name === 'ToolSearch' && /skill/i.test(String(call.input.query ?? ''))) search.toolSearchForSkill += 1;
    if (call.name === 'Skill' && str(call.input.skill) && !skillNames.has(call.input.skill) && !skillNames.has(call.input.skill.split(':').pop())) search.nonCatalogSkillCalls.push(call.input.skill);
    if (call.name === 'Bash' && bashWriteLike(call.input.command)) bashWrites.push(index);
    if (call.name === 'Skill' && str(call.input.skill)) {
      const raw = call.input.skill;
      const last = raw.split(':').pop();
      // "plugin:name" style input: use the last segment when that is a catalog skill and the raw value is not.
      noteLoad(!skillNames.has(raw) && skillNames.has(last) ? last : raw, 'Skill', index, raw);
    }
    if (call.name === 'Read') {
      const path = String(call.input.file_path ?? '');
      const match = SKILL_FILE.exec(path);
      if (match) noteLoad(match[1], 'Read', index);
      else scanText(path, 'Read', index, { loadsFromSkillFile: false });
    }
    if (call.name === 'Bash') scanText(call.input.command, 'Bash', index, { loadsFromSkillFile: true });
    if (call.name === 'Grep' || call.name === 'Glob') {
      for (const field of ['path', 'glob', 'pattern']) scanText(call.name === 'Grep' && field === 'pattern' ? null : call.input[field], call.name, index, { loadsFromSkillFile: false });
    }
    if (WRITE_TOOLS.has(call.name)) {
      const raw = str(call.input.file_path) ?? str(call.input.notebook_path);
      writes.push({ index, raw, rel: relativeToProject(raw, projectRoots) });
    }
  });
  const unknownLoaded = loaded.filter((entry) => !skillNames.has(entry.name)).map((entry) => entry.name);
  if (unknownLoaded.length) warnings.push(`loaded skill name(s) not in the project catalog: ${unknownLoaded.join(', ')}`);

  const tokens = tokenSums(usageByMessage, assistantMessages.size, warnings);
  if (stamps.length >= 2 && stampedConversationRows < conversationRows) {
    warnings.push(`a timestamp is present on ${stampedConversationRows} of ${conversationRows} transcript rows; wall time covers only the stamped rows`);
  }

  let block = null;
  if (firstUserText !== undefined) {
    const match = /<jev-skills>\s*([\s\S]*?)\s*<\/jev-skills>/.exec(firstUserText);
    block = { present: Boolean(match), load: null, consider: null, skillsBlocks: blockCount(firstUserText, 'jev-skills'), routingBlocks: blockCount(firstUserText, 'jev-routing') };
    if (block.skillsBlocks > 1) warnings.push(`the subagent prompt holds ${block.skillsBlocks} <jev-skills> blocks; the first is read`);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        block.load = names(parsed?.load);
        block.consider = names(parsed?.consider);
      } catch { warnings.push('the <jev-skills> block in the subagent prompt is not valid JSON'); }
    }
  } else warnings.push('no first user message found in the subagent transcript');

  const listing = skillListing(rows, skillNames);
  const target = task.targetSkill;
  const targetEntry = target ? loaded.find((entry) => entry.name === target) ?? null : null;
  // true: a load was seen. false: no load and nothing touched the skill folders in a way that could have
  // read it. null: only an indeterminate access was seen (the target's folder, or the skills folder as a whole).
  let targetLoaded = null;
  if (target) {
    const unclear = mentions.filter((entry) => entry.name === target || entry.name === null);
    if (targetEntry !== null) targetLoaded = true;
    else if (unclear.length === 0) targetLoaded = false;
    else warnings.push(`target skill load not determined: no Skill/Read/Bash load of its SKILL.md, but ${unclear.map((entry) => `${entry.via} touched ${entry.name ? 'its folder' : 'the skills folder'}`).join('; ')}`);
  }
  if (target) {
    if (!listing.found) warnings.push('no skill listing found in the subagent transcript before its first assistant turn; whether the target was visible is unknown');
    else if (!listing.names.includes(target)) warnings.push(`the skill listing shown to the subagent (${listing.names.length} of ${skillNames.size} catalog names) does not contain the target skill`);
  }
  const firstWrite = writes.length ? writes[0].index : null;
  const firstBashWrite = bashWrites.length ? bashWrites[0] : null;
  const anyWrite = [firstWrite, firstBashWrite].filter((index) => index !== null);
  const firstAnyWrite = anyWrite.length ? Math.min(...anyWrite) : null;
  if (bashWrites.length) warnings.push(`${bashWrites.length} Bash command(s) look like file writes (redirect, heredoc, sed -i); files written that way are not in filesWritten/outOfScopeWrites`);
  const handbackCalls = calls.filter((call) => call.name === 'SubagentHandback').length;
  const outOfScope = writes.filter((write) => write.rel === null || !inScope(write.rel, task.id)).map((write) => write.rel ?? write.raw ?? '(unknown path)');
  return {
    summary: {
      toolCalls: calls.length,
      toolNames,
      loadedSkills: loaded,
      skillFolderMentions: mentions,
      targetSkillLoaded: targetLoaded,
      targetSkillLoadedVia: targetEntry ? targetEntry.via : null,
      targetLoadedBeforeFirstWrite: target && targetLoaded !== null ? (targetEntry !== null && (firstWrite === null || targetEntry.callIndex < firstWrite)) : null,
      skillListing: { found: listing.found, source: listing.source, catalogNamesListed: listing.found ? listing.names.length : null, catalogSize: skillNames.size },
      // More about the same listing row. totalNamesListed counts every skill the harness listed (project, user-level
      // and plugin skills together); catalogNamesWithDescription is how many catalog names had description text.
      listingDetail: { totalNamesListed: listing.total, catalogNamesWithDescription: listing.withDescription, nonCatalogNamesListed: listing.otherNames ? listing.otherNames.length : null, nonCatalogNames: listing.otherNames },
      targetListedToSubagent: target && listing.found ? listing.names.includes(target) : null,
      promptHadSkillsBlock: block ? block.present : null,
      promptBlockLoad: block ? block.load : null,
      promptBlockConsider: block ? block.consider : null,
      promptBlockCounts: block ? { skills: block.skillsBlocks, routing: block.routingBlocks } : null,
      firstPromptContainsTask: firstUserText !== undefined ? squash(firstUserText).includes(squash(task.text)) : null,
      tokens,
      wallMs: stamps.length >= 2 ? Math.max(...stamps) - Math.min(...stamps) : null,
      timestampCoverage: { rows: conversationRows, withTimestamp: stampedConversationRows },
      // Position (0-based, in tool-call order) of the target load and of the first write. firstBashWriteLike is a
      // heuristic; targetLoadedBeforeAnyWrite also takes it into account, targetLoadedBeforeFirstWrite does not.
      targetLoadCallIndex: targetEntry ? targetEntry.callIndex : null,
      firstWriteCallIndex: firstWrite,
      firstBashWriteLikeCallIndex: firstBashWrite,
      bashWriteLikeCommands: bashWrites.length,
      targetLoadedBeforeAnyWrite: target && targetLoaded !== null ? (targetEntry !== null && (firstAnyWrite === null || targetEntry.callIndex < firstAnyWrite)) : null,
      toolCallsWithoutHandback: calls.length - handbackCalls,
      handbackCalls,
      toolErrors,
      rejectedToolCalls: rejectedCalls,
      skillSearch: { mcpSkillToolCalls: Object.values(search.mcpSkillTools).reduce((a, b) => a + b, 0), mcpSkillTools: search.mcpSkillTools,
        toolSearchForSkill: search.toolSearchForSkill, nonCatalogSkillCalls: search.nonCatalogSkillCalls },
      models: [...models].sort(),
      filesWritten: [...new Set(writes.map((write) => write.rel ?? write.raw ?? '(unknown path)'))],
      outOfScopeWrites: [...new Set(outOfScope)],
    },
    warnings,
  };
}

// ---------------------------------------------------------------- main
export function analyze({ arm, project, stateDir, transcripts, template, tasksFile = join(here, 'tasks.json'), mainPromptFile = join(here, 'main-prompt.txt') }) {
  const warnings = [];
  const { tasks } = JSON.parse(readFileSync(tasksFile, 'utf8'));
  const projectDir = resolve(project);
  const projectRoots = [projectDir];
  try { const real = realpathSync(projectDir); if (real !== projectDir) projectRoots.push(real); } catch { /* reported by the checker */ }
  const skillNames = new Set((listDir(join(projectDir, '.claude', 'skills')) ?? []).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  if (skillNames.size === 0) warnings.push('no .claude/skills folder in the project; loaded skill names cannot be cross-checked');

  let check = null;
  try {
    check = checkProject({ project: projectDir, ...(template ? { template } : {}), tasksFile });
  } catch (error) {
    warnings.push(`checker failed: ${String(error?.message ?? error).slice(0, 200)}`);
  }
  const checkById = new Map((check?.tasks ?? []).map((entry) => [entry.id, entry]));

  const { events, sessions } = readEvents(resolve(stateDir), warnings);
  const main = readMain(resolve(transcripts), warnings);
  const agents = readSubagents(resolve(transcripts), warnings);
  const decisions = readDecisionLog(resolve(stateDir), warnings);
  const eventsFor = (type, toolUseId) => events.filter((event) => event.type === type && event.taskId === toolUseId);
  const probabilityList = (list) => (Array.isArray(list)
    ? list.filter((item) => isObject(item) && str(item.name)).map((item) => ({ name: item.name, probability: finite(item.probability) }))
    : null);

  // What happened to ONE Agent call, from its own tool result and its own spawn event:
  //   launched     - a subagent id came back (tool result or spawn_observed)
  //   spawn_failed - the hook saw the spawn fail
  //   refused      - the tool result is an error or a permission "reject", and the call has no spawn_observed
  //                  event at all: the harness turned the call down before the tool ran
  //   no_result / unknown - nothing conclusive in the files
  const outcomeOf = (call) => {
    const result = main.results.get(call.id) ?? null;
    const spawn = eventsFor('spawn_observed', call.id);
    if (result?.agentId || spawn.some((event) => event.failed !== true && str(event.agentId))) return 'launched';
    if (spawn.some((event) => event.failed === true)) return 'spawn_failed';
    if (result && (result.isError || result.permission === 'reject') && spawn.length === 0) return 'refused';
    return result ? 'unknown' : 'no_result';
  };

  // Detail of the hook's decision for ONE Agent call. Kept apart from "hook" so that object keeps its shape.
  const hookDetailOf = (call) => {
    const skills = eventsFor('skills', call.id).pop() ?? null;
    const route = eventsFor('route', call.id).pop() ?? null;
    const deferred = eventsFor('route_deferred', call.id).pop() ?? null;
    let judge = null;
    if (skills && Array.isArray(skills.decisionIds)) {
      const logged = skills.decisionIds.map((id) => decisions.byId.get(id)).filter(isObject);
      const latencies = logged.map((row) => finite(row.latencyMs)).filter((value) => value !== null);
      judge = {
        requests: finite(skills.retrieval?.requests) ?? skills.decisionIds.length,
        decisionsLogged: logged.length,
        // Sum over the logged decisions of this event. Whether the requests ran one after another or at the
        // same time is not recorded, so the max is given too.
        latencyMsSum: latencies.length ? round(latencies.reduce((a, b) => a + b, 0)) : null,
        latencyMsMax: latencies.length ? round(Math.max(...latencies)) : null,
        cached: skills.cached === true,
      };
    }
    const trace = skills && Array.isArray(skills.trace) ? skills.trace.filter(isObject) : null;
    return {
      need: skills ? finite(skills.need) : null,
      candidates: skills ? finite(skills.candidates) : null,
      judged: skills ? finite(skills.retrieval?.judged) : null,
      load: skills ? probabilityList(skills.load) : null,
      suggest: skills ? probabilityList(Array.isArray(skills.suggest) ? skills.suggest : skills.consider) : null,
      // The judge's three highest probabilities, whatever stage they ended in (e.g. "need_gate" = dropped
      // because the overall need was under the threshold).
      top: trace ? [...trace].sort((a, b) => (finite(b.probability) ?? -1) - (finite(a.probability) ?? -1)).slice(0, 3)
        .map((entry) => ({ name: str(entry.name), probability: finite(entry.probability), stage: str(entry.stage) })) : null,
      judge,
      route: route && isObject(route.route) ? { profile: str(route.route.profile), model: str(route.route.model), effort: str(route.route.effort), tier: str(route.route.tier),
        decisionReason: str(route.route.decisionReason), latencyMs: round(route.latencyMs), hookMs: round(route.hookMs), cached: typeof route.cached === 'boolean' ? route.cached : null } : null,
      routeDeferred: deferred ? (str(deferred.reason) ?? 'deferred') : null,
    };
  };
  const targetInTrace = (call, target) => {
    const skills = eventsFor('skills', call.id).pop() ?? null;
    const entry = target && skills && Array.isArray(skills.trace) ? skills.trace.find((item) => isObject(item) && item.name === target) : null;
    return entry ? { probability: finite(entry.probability), stage: str(entry.stage) } : null;
  };

  const anySkillsEvent = events.some((event) => event.type === 'skills');
  if (!anySkillsEvent && events.length) warnings.push('the hook state holds no skills event at all (expected when the delegation.skills point is off); "injected" is unmeasured for every task, not false');
  const EMPTY_HOOK = { skillsEvent: null, injected: null, load: null, consider: null, mode: null, status: null, route: null };
  const firstPromptOf = (agent) => {
    agent.rows ??= readJsonl(agent.file, warnings) ?? [];
    const first = agent.rows.find((row) => rowRole(row) === 'user' && row.isMeta !== true && messageText(row) !== null);
    return first ? squash(messageText(first)) : null;
  };

  // Everything known about ONE Agent call: its hook events and the subagent it started. Events and subagent
  // are never taken from a different call of the same task.
  const resolveCall = (call, { wanted, allowPromptMatch }) => {
    const notes = [];
    const skillEvents = eventsFor('skills', call.id);
    if (skillEvents.length === 0 && anySkillsEvent) notes.push('no skills event for this delegation');
    if (skillEvents.length > 1) notes.push(`${skillEvents.length} skills events for this delegation; the last one is used`);
    const skills = skillEvents[skillEvents.length - 1] ?? null;
    const routeEvents = eventsFor('route', call.id);
    const route = routeEvents[routeEvents.length - 1] ?? null;
    if (!route) notes.push('no route event for this delegation');
    // The hook stores optional entries under "suggest"; "consider" is the name used inside the injected block.
    const optional = skills ? (Array.isArray(skills.suggest) ? skills.suggest : Array.isArray(skills.consider) ? skills.consider : null) : null;
    if (skills && optional === null) notes.push('skills event has neither a "suggest" nor a "consider" list');
    const hook = {
      skillsEvent: skills !== null,
      injected: skills && typeof skills.injected === 'boolean' ? skills.injected : null,
      load: skills ? names(skills.load) : null,
      consider: names(optional),
      mode: skills ? str(skills.mode) : null,
      status: skills ? str(skills.status) : null,
      route: route && isObject(route.route) ? { profile: str(route.route.profile), model: str(route.route.model), effort: str(route.route.effort) } : null,
    };
    if (skills && typeof skills.injected !== 'boolean') notes.push('skills event has no boolean "injected"');

    const spawnEvents = eventsFor('spawn_observed', call.id);
    const spawnFailed = spawnEvents.length ? spawnEvents.some((event) => event.failed === true) : null;
    const spawned = spawnEvents.filter((event) => event.failed !== true).map((event) => str(event.agentId)).filter((id) => id !== null);
    let agentId = null;
    let agentIdSource = null;
    if (spawned.length > 1 && new Set(spawned).size > 1) notes.push(`several spawn_observed agent ids for this delegation: ${[...new Set(spawned)].join(', ')}; the first is used`);
    if (spawned.length) { agentId = spawned[0]; agentIdSource = 'spawn_observed'; }
    else if (spawnFailed === true) notes.push('spawn_observed reports failed=true for this Agent call; no subagent is scored for it');
    else if (main.agentResults.has(call.id)) {
      agentId = main.agentResults.get(call.id);
      agentIdSource = 'main_tool_result';
      if (spawnEvents.length) notes.push('spawn_observed has no agentId; the id comes from the tool result in the Main transcript');
    } else if (spawnEvents.length) notes.push('spawn_observed has no agentId for this Agent call and the Main transcript names none; no subagent is scored for it');
    else if ([...agents].some(([, agent]) => agent.meta?.toolUseId === call.id)) {
      // The harness's own record next to the transcript: agent-<id>.meta.json names the Agent call that started it.
      agentId = [...agents].find(([, agent]) => agent.meta?.toolUseId === call.id)[0];
      agentIdSource = 'subagent_meta';
      notes.push('no spawn_observed event; subagent found by the toolUseId in its meta file');
    } else if (!allowPromptMatch) notes.push('no spawn_observed event; the first-prompt fallback is not used because several Agent calls carry this task');
    else {
      // Last resort that is still evidence, not a guess: this is the only Agent call for the task, it has
      // no spawn event at all, and exactly one subagent transcript starts with the task text.
      const byPrompt = [...agents].filter(([, agent]) => firstPromptOf(agent)?.includes(wanted)).map(([id]) => id);
      if (byPrompt.length === 1) { agentId = byPrompt[0]; agentIdSource = 'prompt_match'; notes.push('no spawn_observed event; subagent found by its first prompt'); }
      else notes.push(byPrompt.length === 0 ? 'no spawn_observed event and no subagent transcript starts with this task' : `no spawn_observed event and ${byPrompt.length} subagent transcripts start with this task; none is used`);
    }
    const meta = agentId !== null ? agents.get(agentId)?.meta ?? null : null;
    if (meta?.toolUseId && meta.toolUseId !== call.id) notes.push('the subagent meta file names a different Agent call than the one this subagent is attributed to');
    return { hook, agentId, agentIdSource, spawnFailed, notes };
  };

  const claimed = new Set();
  const tasksByCall = new Map();
  const tasksByAgent = new Map();
  const taskRows = tasks.map((task) => {
    const notes = [];
    const verdict = checkById.get(task.id) ?? null;
    if (!verdict) notes.push('no checker result');
    const wanted = squash(task.text);
    const matches = main.agentCalls.filter((call) => call.prompt !== null && squash(call.prompt).includes(wanted));
    // PROTOCOL.md says "the first call". A call the harness refused before the tool ran is not a delegation that
    // happened: it started nothing and has no spawn event. The task's call is therefore the first call that was
    // not refused that way; when every call was refused it is still the first one. Refused attempts are counted
    // and listed (attempts, otherCalls), never dropped. This reading was fixed after the sessions ran.
    const outcomes = new Map(matches.map((match) => [match.id, outcomeOf(match)]));
    const refusedBefore = [];
    let call = matches[0] ?? null;
    for (const match of matches) {
      if (outcomes.get(match.id) !== 'refused') { call = match; break; }
      refusedBefore.push(match);
    }
    if (call && outcomes.get(call.id) === 'refused') refusedBefore.length = 0; // every call was refused: the literal rule applies
    if (!call) notes.push('no Agent call in the Main transcript contains this task text: the task was not delegated (its checker result still counts)');
    if (refusedBefore.length) notes.push(`${refusedBefore.length} Agent call(s) with this task text were refused by the harness before the tool ran; the first call that was not refused is scored`);
    const launchedCalls = matches.filter((match) => outcomes.get(match.id) === 'launched').length;
    if (matches.length - refusedBefore.length > 1) notes.push(`${matches.length} Agent calls contain this task text; the first one is scored, the others are listed under otherCalls`);
    for (const match of matches) claimed.add(match.id);

    let hook = { ...EMPTY_HOOK };
    let agentId = null;
    let agentIdSource = null;
    let spawnFailed = null;
    if (call) {
      tasksByCall.set(call.id, [...(tasksByCall.get(call.id) ?? []), task.id]);
      const resolved = resolveCall(call, { wanted, allowPromptMatch: matches.length === 1 });
      ({ hook, agentId, agentIdSource, spawnFailed } = resolved);
      notes.push(...resolved.notes);
    }
    const otherCalls = matches.filter((match) => match !== call).map((other) => {
      const resolved = resolveCall(other, { wanted, allowPromptMatch: false });
      return { toolUseId: other.id, agentId: resolved.agentId, agentIdSource: resolved.agentIdSource, spawnFailed: resolved.spawnFailed,
        injected: resolved.hook.injected, load: resolved.hook.load };
    });

    let subagent = null;
    if (agentId !== null) {
      const agent = agents.get(agentId);
      if (!agent) notes.push(`subagent transcript agent-${agentId}.jsonl not found`);
      else {
        agent.rows ??= readJsonl(agent.file, warnings) ?? [];
        tasksByAgent.set(agentId, [...(tasksByAgent.get(agentId) ?? []), task.id]);
        if (tasksByAgent.get(agentId).length > 1) notes.push(`subagent ${agentId} is also attributed to ${tasksByAgent.get(agentId).slice(0, -1).join(', ')}; run totals count it once`);
        const { summary, warnings: subWarnings } = summariseSubagent(agent.rows, { task, projectRoots, skillNames });
        subagent = summary;
        notes.push(...subWarnings);
      }
    }
    // Every Agent call that carried this task, in order, with what the hook did for that call. The prompt itself
    // is never copied: only whether it is the task text, how many blocks it holds and whether it is exactly what
    // the hook produced for the refused attempt before it (then Main added nothing of its own).
    const attempts = matches.map((match, index) => {
      const result = main.results.get(match.id) ?? null;
      const previous = index > 0 ? main.rewrites.get(matches[index - 1].id) ?? null : null;
      const rewrite = main.rewrites.get(match.id) ?? null;
      return {
        toolUseId: match.id,
        scored: match === call,
        outcome: outcomes.get(match.id),
        refusalCode: outcomes.get(match.id) === 'refused' ? (result?.reasonCode ?? null) : null,
        subagentType: match.subagentType,
        promptVerbatim: squash(match.prompt) === wanted,
        promptBlocks: { routing: blockCount(match.prompt, 'jev-routing'), skills: blockCount(match.prompt, 'jev-skills') },
        promptIsHookRewriteOfPreviousCall: previous && previous.prompt !== null ? match.prompt === previous.prompt && match.subagentType === previous.subagentType : null,
        hookRewrite: rewrite ? { subagentType: rewrite.subagentType, routingBlocks: blockCount(rewrite.prompt, 'jev-routing'), skillsBlocks: blockCount(rewrite.prompt, 'jev-skills') } : null,
        resolvedModel: result?.resolvedModel ?? null,
        injected: eventsFor('skills', match.id).length ? (typeof eventsFor('skills', match.id).pop().injected === 'boolean' ? eventsFor('skills', match.id).pop().injected : null) : null,
        target: targetInTrace(match, task.targetSkill),
        hookDetail: hookDetailOf(match),
      };
    });
    const agentMeta = agentId !== null ? agents.get(agentId)?.meta ?? null : null;
    const scoredAttempt = attempts.find((attempt) => attempt.scored) ?? null;
    // What actually ran, as the harness recorded it (not what a hook proposed).
    const effective = call ? { agentType: agentMeta?.agentType ?? null, model: agentMeta?.model ?? scoredAttempt?.resolvedModel ?? null,
      // Did the rewrite the hook produced for the SCORED call reach the subagent? false = the subagent's first prompt
      // is the input Main sent, and the hook's second rewrite (and its second route) was not applied.
      scoredCallRewriteApplied: subagent && scoredAttempt?.hookRewrite && subagent.promptBlockCounts
        ? subagent.promptBlockCounts.routing === scoredAttempt.hookRewrite.routingBlocks && subagent.promptBlockCounts.skills === scoredAttempt.hookRewrite.skillsBlocks : null } : null;
    if (effective?.scoredCallRewriteApplied === false) notes.push('the hook rewrote the scored call again, but the subagent received the input Main sent (the second rewrite and its route were not applied)');
    if (effective?.agentType && hook.route?.profile && effective.agentType !== hook.route.profile) notes.push(`the subagent ran as ${effective.agentType}, not as the profile in this call's route event (${hook.route.profile})`);

    if (verdict?.blockedBy?.length) notes.push(`checker: this task's modules could not be loaded because of a file of ${verdict.blockedBy.join(', ')}; the pair is contaminated`);

    return {
      id: task.id,
      lang: task.lang,
      kind: task.kind,
      targetSkill: task.targetSkill,
      check: verdict ? { done: verdict.done, convention: verdict.convention, blockedBy: verdict.blockedBy ?? [], failedChecks: verdict.details.filter((d) => !d.ok).map((d) => d.check) } : null,
      // every check of the checker for this task, by name (the checker's notes are left out)
      checkDetails: verdict ? verdict.details.map((d) => ({ check: d.check, ok: d.ok === true })) : null,
      delegation: call ? { toolUseId: call.id, subagentType: call.subagentType, promptVerbatim: squash(call.prompt) === wanted, agentCalls: matches.length, spawnFailed } : null,
      // agentCalls above counts every Agent call with the task text. Split: refused before the tool ran / launched.
      delegationDetail: call ? { refusedAttempts: matches.filter((match) => outcomes.get(match.id) === 'refused').length, launchedCalls,
        scoredCallIndex: matches.indexOf(call), scoredCallOutcome: outcomes.get(call.id),
        firstCallPromptVerbatim: squash(matches[0].prompt) === wanted, firstCallSubagentType: matches[0].subagentType,
        // null when the scored call is the first one; true when its input is exactly the hook's rewrite of the refused attempt
        scoredPromptIsHookRewrite: scoredAttempt?.promptIsHookRewriteOfPreviousCall ?? null } : null,
      attempts,
      hookDetail: call ? hookDetailOf(call) : null,
      targetJudged: call ? targetInTrace(call, task.targetSkill) : null,
      effective,
      otherCalls,
      hook,
      agentId,
      agentIdSource,
      subagent,
      warnings: notes,
    };
  });

  for (const [callId, ids] of tasksByCall) if (ids.length > 1) warnings.push(`one Agent call (${callId}) carries the text of ${ids.length} tasks: ${ids.join(', ')}`);
  for (const [agentId, ids] of tasksByAgent) if (ids.length > 1) warnings.push(`one subagent (${agentId}) is attributed to ${ids.length} tasks: ${ids.join(', ')}; its tool calls, tokens and wall time are counted once in the totals`);
  const stray = main.agentCalls.filter((call) => !claimed.has(call.id));
  if (stray.length) warnings.push(`${stray.length} Agent call(s) in the Main transcript match no task: ${stray.map((call) => call.id).join(', ')}`);
  const order = taskRows.map((row) => (row.delegation ? main.agentCalls.findIndex((call) => call.id === row.delegation.toolUseId) : null));
  const known = order.filter((index) => index !== null);
  const inOrder = known.every((index, i) => i === 0 || index > known[i - 1]);
  if (!inOrder) warnings.push('delegations did not happen in the fixed task order');

  const skillRows = taskRows.filter((row) => row.kind === 'skill');
  const controlRows = taskRows.filter((row) => row.kind === 'control');
  const count = (rows, pick) => {
    const values = rows.map(pick);
    const measured = values.filter((value) => value !== null && value !== undefined);
    return { yes: measured.filter((value) => value === true).length, measured: measured.length, of: rows.length };
  };
  // Sums over subagents, each counted once even when it is attributed to more than one task.
  const countedAgents = new Set();
  const distinctRows = taskRows.filter((row) => {
    if (row.agentId === null || row.subagent === null) return true;
    if (countedAgents.has(row.agentId)) return false;
    countedAgents.add(row.agentId);
    return true;
  });
  const total = (pick) => {
    const values = distinctRows.map(pick);
    const measured = values.filter((value) => typeof value === 'number');
    return { sum: measured.length ? measured.reduce((a, b) => a + b, 0) : null, measured: measured.length, of: distinctRows.length };
  };
  const via = (name) => skillRows.filter((row) => row.subagent?.targetSkillLoadedVia === name).length;

  // Judge cost, from the decision log. The log records latency per decision and no token counts.
  const byPoint = {};
  for (const row of decisions.rows) {
    const point = str(row.pointId) ?? '(no pointId)';
    const entry = byPoint[point] ??= { decisions: 0, cached: 0, latencyMsSum: 0, latencyMsMax: null, providers: {} };
    entry.decisions += 1;
    if (row.cached === true) entry.cached += 1;
    const latency = finite(row.latencyMs);
    if (latency !== null) { entry.latencyMsSum += latency; entry.latencyMsMax = Math.max(entry.latencyMsMax ?? 0, latency); }
    const provider = str(row.provider) ?? '(none)';
    entry.providers[provider] = (entry.providers[provider] ?? 0) + 1;
  }
  for (const entry of Object.values(byPoint)) { entry.latencyMsSum = round(entry.latencyMsSum); entry.latencyMsMax = round(entry.latencyMsMax); }
  const tokenFieldInLog = decisions.rows.some((row) => Object.keys(row).some((key) => /token|usage/i.test(key)));
  if (decisions.found && !tokenFieldInLog) warnings.push('the decision log has no token or usage field; judge tokens are unmeasured (null), only request counts and latency are known');
  if (!decisions.found) warnings.push('no decisions-log/*.jsonl under the state dir; judge cost is unmeasured');
  const allAttempts = taskRows.flatMap((row) => row.attempts);
  const hookMs = allAttempts.map((attempt) => attempt.hookDetail.route?.hookMs).filter((value) => typeof value === 'number');
  const skillsJudge = allAttempts.map((attempt) => attempt.hookDetail.judge).filter(isObject);
  const judge = {
    decisionLogFound: decisions.found,
    byPoint,
    // delegation.skills only: what the skill judge added. One skills event per Agent call (refused attempts included).
    skills: decisions.found || skillsJudge.length ? {
      events: skillsJudge.length,
      requests: skillsJudge.reduce((n, entry) => n + (entry.requests ?? 0), 0),
      latencyMsSum: skillsJudge.some((entry) => entry.latencyMsSum !== null) ? skillsJudge.reduce((n, entry) => n + (entry.latencyMsSum ?? 0), 0) : null,
      // of which for the scored (launched) calls only
      scoredCalls: (() => {
        const scored = taskRows.map((row) => row.hookDetail?.judge).filter(isObject);
        return { events: scored.length, requests: scored.reduce((n, entry) => n + (entry.requests ?? 0), 0),
          latencyMsSum: scored.some((entry) => entry.latencyMsSum !== null) ? scored.reduce((n, entry) => n + (entry.latencyMsSum ?? 0), 0) : null };
      })(),
    } : null,
    tokens: null, // not recorded anywhere in the hook state
    // Time the PreToolUse hook took per Agent call, as the route event reports it (hookMs), all calls of all tasks.
    hookMsPerAgentCall: { sum: hookMs.length ? hookMs.reduce((a, b) => a + b, 0) : null, measured: hookMs.length, of: allAttempts.length },
  };

  // Main session: what it was given and what it did besides delegating.
  let mainPromptText = null;
  try { mainPromptText = readFileSync(mainPromptFile, 'utf8').trim(); } catch { warnings.push('main-prompt.txt not readable; the Main prompt cannot be compared with it'); }
  const prompts = main.info?.userPrompts ?? null;
  const firstPrompt = prompts?.[0] ?? null;
  const mainSession = main.info ? {
    userPrompts: prompts.length,
    firstPromptEqualsMainPromptFile: firstPrompt !== null && mainPromptText !== null ? firstPrompt.trim() === mainPromptText : null,
    firstPromptContainsMainPromptFile: firstPrompt !== null && mainPromptText !== null ? firstPrompt.includes(mainPromptText) : null,
    firstPromptExtraChars: firstPrompt !== null && mainPromptText !== null && firstPrompt.includes(mainPromptText) ? firstPrompt.trim().length - mainPromptText.length : null,
    toolNames: main.info.toolNames,
    models: main.info.models,
    efforts: main.info.efforts,
    permissionModes: main.info.permissionModes,
    tokens: main.info.tokens,
    wallMs: main.info.wallMs,
    requestLogRowsIgnored: main.info.requestLogRowsIgnored,
  } : null;
  if (mainSession && mainSession.userPrompts !== 1) warnings.push(`the Main transcript holds ${mainSession.userPrompts} user prompts; the protocol gives it exactly one`);
  if (mainSession?.firstPromptEqualsMainPromptFile === false) {
    warnings.push(mainSession.firstPromptContainsMainPromptFile
      ? `the Main prompt contains main-prompt.txt word for word but is not equal to it: ${mainSession.firstPromptExtraChars} extra characters around it`
      : 'the Main prompt does not contain main-prompt.txt word for word');
  }
  const mainOwnTools = mainSession ? Object.keys(mainSession.toolNames).filter((name) => name !== 'Agent') : [];
  if (mainOwnTools.length) warnings.push(`Main used tools other than Agent: ${mainOwnTools.map((name) => `${name} x${mainSession.toolNames[name]}`).join(', ')}`);
  const profiles = {};
  for (const row of taskRows) if (row.effective) { const key = `${row.effective.agentType ?? '(unknown)'} / ${row.effective.model ?? '(unknown)'}`; (profiles[key] ??= []).push(row.id); }
  const tokenPart = (field) => total((row) => row.subagent?.tokens?.[field]);
  const searchUse = (pick) => taskRows.filter((row) => row.subagent && pick(row.subagent.skillSearch)).map((row) => row.id);
  return {
    schema: 3,
    arm: String(arm),
    inputs: { project: projectDir, stateDir: resolve(stateDir), transcripts: resolve(transcripts) },
    mainTranscripts: main.files,
    sessions,
    agentCallsInMain: main.agentCalls.length,
    delegationsInTaskOrder: known.length ? inOrder : null,
    unattributedChanges: check ? check.unattributedChanges : null,
    totals: {
      primary_conventionPassed: count(skillRows, (row) => row.check?.convention),
      skillTasksDone: count(skillRows, (row) => row.check?.done),
      controlsDone: count(controlRows, (row) => row.check?.done),
      skillTasksDelegated: { yes: skillRows.filter((row) => row.delegation !== null).length, of: skillRows.length },
      targetSkillLoaded: count(skillRows, (row) => row.subagent?.targetSkillLoaded),
      targetSkillLoadedVia: { Skill: via('Skill'), Read: via('Read'), Bash: via('Bash') },
      targetListedToSubagent: count(skillRows, (row) => row.subagent?.targetListedToSubagent),
      targetInInjectedLoad: count(skillRows, (row) => (Array.isArray(row.hook.load) ? row.hook.load.includes(row.targetSkill) : null)),
      blockedByOtherTask: taskRows.filter((row) => row.check?.blockedBy?.length).map((row) => ({ id: row.id, blockedBy: row.check.blockedBy })),
      injectedOnSkillTasks: count(skillRows, (row) => row.hook.injected),
      injectedOnControls: count(controlRows, (row) => row.hook.injected),
      subagentToolCalls: total((row) => row.subagent?.toolCalls),
      subagentTokens: total((row) => row.subagent?.tokens?.total),
      subagentWallMs: total((row) => row.subagent?.wallMs),
      // ---- added with schema 3 (reference values, not outcomes)
      subagentTokenParts: { input: tokenPart('input'), output: tokenPart('output'), cacheRead: tokenPart('cacheRead'), cacheCreation: tokenPart('cacheCreation') },
      subagentToolCallsWithoutHandback: total((row) => row.subagent?.toolCallsWithoutHandback),
      agentCalls: { all: main.agentCalls.length, refusedBeforeRunning: allAttempts.filter((attempt) => attempt.outcome === 'refused').length,
        launched: allAttempts.filter((attempt) => attempt.outcome === 'launched').length,
        tasksWithSeveralLaunchedCalls: taskRows.filter((row) => (row.delegationDetail?.launchedCalls ?? 0) > 1).map((row) => row.id) },
      blockInSubagentPrompt: { skillTasks: count(skillRows, (row) => row.subagent?.promptHadSkillsBlock), controls: count(controlRows, (row) => row.subagent?.promptHadSkillsBlock) },
      targetInSubagentPromptBlock: count(skillRows, (row) => (row.subagent?.promptHadSkillsBlock === true && Array.isArray(row.subagent.promptBlockLoad) ? row.subagent.promptBlockLoad.includes(row.targetSkill) : row.subagent?.promptHadSkillsBlock === false ? false : null)),
      targetLoadedBeforeFirstWrite: count(skillRows, (row) => row.subagent?.targetLoadedBeforeFirstWrite),
      targetLoadedBeforeAnyWrite: count(skillRows, (row) => row.subagent?.targetLoadedBeforeAnyWrite),
      targetLoadedAsFirstToolCall: count(skillRows, (row) => (row.subagent ? row.subagent.targetLoadCallIndex === 0 : null)),
      skillSearch: { tasksMeasured: taskRows.filter((row) => row.subagent).length,
        tasksUsingMcpSkillTool: searchUse((use) => use.mcpSkillToolCalls > 0), tasksUsingToolSearchForSkill: searchUse((use) => use.toolSearchForSkill > 0),
        tasksCallingNonCatalogSkill: searchUse((use) => use.nonCatalogSkillCalls.length > 0) },
      effectiveProfiles: profiles,
    },
    judge,
    mainSession,
    // Hook events by type, and how many agent stops were of agents that are not task subagents (the harness also
    // starts short helper agents; the hook records their stop with agentType "unknown" or empty).
    hookEventCounts: events.reduce((counts, event) => { counts[event.type] = (counts[event.type] ?? 0) + 1; return counts; }, {}),
    agentStops: { all: events.filter((event) => event.type === 'agent_stopped').length,
      ofTaskSubagents: events.filter((event) => event.type === 'agent_stopped' && taskRows.some((row) => row.agentId !== null && row.agentId === event.agentId)).length },
    tasks: taskRows,
    warnings,
  };
}

// A copy of the result that is safe to keep in a repository: no local paths, no session / agent / tool-use
// ids (replaced by task-scoped labels), no free text from a session. Numbers, booleans, skill names, profile
// ids, check names and the analyzer's own warnings stay.
export function sanitize(result) {
  const labels = new Map();
  for (const row of result.tasks) {
    row.attempts.forEach((attempt, index) => labels.set(attempt.toolUseId, `${row.id}-call${index + 1}`));
    if (row.agentId) labels.set(row.agentId, `${row.id}-subagent`);
    row.otherCalls.forEach((other) => { if (other.agentId && !labels.has(other.agentId)) labels.set(other.agentId, `${row.id}-other-subagent`); });
  }
  result.sessions.forEach((session, index) => labels.set(session.session, `session-${index + 1}`));
  const roots = Object.entries(result.inputs ?? {}).map(([name, dir]) => [dir, `<${name}>`]).sort((a, b) => b[0].length - a[0].length);
  const known = [...labels].sort((a, b) => b[0].length - a[0].length);
  const scrub = (text) => {
    if (/^\/\S*$/.test(text)) return '<path>'; // a value that is nothing but an absolute path
    let out = text;
    for (const [dir, label] of roots) out = out.split(dir).join(label);
    for (const [id, label] of known) out = out.split(id).join(label);
    return out
      .replace(/toolu_[A-Za-z0-9]+/g, '<tool-use>')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
      .replace(/\b[0-9a-f]{32,}\b/g, '<hash>')
      .replace(/agent-a[0-9a-f]{16}\b/g, 'agent-<id>')
      .replace(/\ba[0-9a-f]{16}\b/g, '<agent>')
      .replace(/(?<![\w.<>-])\/(?:Users|home|private|tmp|var|opt|Volumes)\/[^\s"',;)]*/g, '<path>');
  };
  const walk = (value) => {
    if (typeof value === 'string') return scrub(value);
    if (Array.isArray(value)) return value.map(walk);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  const { inputs: _inputs, ...rest } = result;
  return { ...walk(rest), sanitized: true };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument near ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2));
    for (const name of ['arm', 'project', 'state-dir', 'transcripts', 'out']) {
      if (!args[name]) throw new Error('usage: analyze.mjs --arm <label> --project <dir> --state-dir <dir> --transcripts <dir> --out <file> [--sanitized-out <file>] [--template <dir>]');
    }
    for (const name of ['project', 'state-dir', 'transcripts']) {
      if (!existsSync(args[name]) || !statSync(args[name]).isDirectory()) throw new Error(`--${name} is not a folder: ${args[name]}`);
    }
    const result = analyze({ arm: args.arm, project: args.project, stateDir: args['state-dir'], transcripts: args.transcripts, template: args.template });
    writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');
    if (args['sanitized-out']) writeFileSync(args['sanitized-out'], JSON.stringify(sanitize(result), null, 2) + '\n');
    const t = result.totals;
    console.log(`arm ${result.arm}: convention passed ${t.primary_conventionPassed.yes}/${t.primary_conventionPassed.of} skill tasks`
      + ` (measured ${t.primary_conventionPassed.measured}); target skill loaded ${t.targetSkillLoaded.yes}/${t.targetSkillLoaded.measured} measured;`
      + ` warnings ${result.warnings.length + result.tasks.reduce((n, row) => n + row.warnings.length, 0)}`);
    console.log(`wrote ${args.out}`);
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(64);
  }
}
