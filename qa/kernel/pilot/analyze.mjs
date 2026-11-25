#!/usr/bin/env node
// Offline analyzer for one arm of the paired pilot. Reads only; no network, no session is started.
//   node analyze.mjs --arm <label> --project <dir> --state-dir <dir> --transcripts <dir> --out <file>
// Anything it cannot read in the expected shape becomes null plus a warning. It never guesses a value.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject } from './checkers/check.mjs';
import { inScope } from './checkers/scopes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SKILL_FILE = /(?:^|\/)\.claude\/skills\/([^/]+)\/SKILL\.md$/;

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

const names = (list) => (Array.isArray(list)
  ? list.map((item) => (isObject(item) ? str(item.name) : str(item))).filter((name) => name !== null)
  : null);

// ---------------------------------------------------------------- Main transcript
function readMain(transcriptsDir, warnings) {
  const entries = listDir(transcriptsDir);
  if (!entries) {
    warnings.push(`transcripts folder not readable: ${transcriptsDir}`);
    return { files: [], agentCalls: [], agentResults: new Map() };
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name).sort();
  if (files.length === 0) warnings.push(`no Main transcript (*.jsonl) directly under ${transcriptsDir}`);
  if (files.length > 1) warnings.push(`${files.length} top-level transcripts found; all were read in name order: ${files.join(', ')}`);
  const agentCalls = [];
  const agentResults = new Map(); // tool_use_id -> agentId reported next to the tool result, when present
  const seen = new Set();
  let taskToolCalls = 0;
  for (const file of files) {
    for (const row of readJsonl(join(transcriptsDir, file), warnings) ?? []) {
      for (const item of contentItems(row)) {
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
        else if (item.type === 'tool_result' && typeof item.tool_use_id === 'string' && isObject(row.toolUseResult) && str(row.toolUseResult.agentId)) {
          agentResults.set(item.tool_use_id, row.toolUseResult.agentId);
        }
      }
    }
  }
  if (taskToolCalls) warnings.push(`${taskToolCalls} tool call(s) named "Task" were seen and not counted as delegations (only "Agent" is)`);
  return { files, agentCalls, agentResults };
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
    agents.set(match[1], { file: join(dir, entry.name), rows: null });
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

function summariseSubagent(rows, { task, projectRoots, skillNames }) {
  const warnings = [];
  const calls = [];
  const seenCalls = new Set();
  const usageByMessage = new Map();
  let anonymousUsage = 0;
  const stamps = [];
  let firstUserText;
  for (const row of rows) {
    const stamp = str(row.timestamp);
    if (stamp !== null) {
      const ms = Date.parse(stamp);
      if (Number.isFinite(ms)) stamps.push(ms);
    }
    if (firstUserText === undefined && (row.type === 'user' || row.message?.role === 'user')) {
      const text = messageText(row);
      if (text !== null) firstUserText = text;
    }
    if (row.type !== 'assistant' && row.message?.role !== 'assistant') continue;
    for (const item of contentItems(row)) {
      if (item.type !== 'tool_use' || typeof item.name !== 'string') continue;
      const key = typeof item.id === 'string' ? item.id : `anon-${calls.length}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      calls.push({ name: item.name, input: isObject(item.input) ? item.input : {} });
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

  const loaded = [];
  const noteLoad = (name, via, index) => {
    if (!loaded.some((entry) => entry.name === name)) loaded.push({ name, via, callIndex: index });
  };
  const toolNames = {};
  const writes = [];
  calls.forEach((call, index) => {
    toolNames[call.name] = (toolNames[call.name] ?? 0) + 1;
    if (call.name === 'Skill' && str(call.input.skill)) noteLoad(call.input.skill, 'Skill', index);
    if (call.name === 'Read') {
      const match = SKILL_FILE.exec(String(call.input.file_path ?? ''));
      if (match) noteLoad(match[1], 'Read', index);
    }
    if (WRITE_TOOLS.has(call.name)) {
      const raw = str(call.input.file_path) ?? str(call.input.notebook_path);
      writes.push({ index, raw, rel: relativeToProject(raw, projectRoots) });
    }
  });
  const unknownLoaded = loaded.filter((entry) => !skillNames.has(entry.name)).map((entry) => entry.name);
  if (unknownLoaded.length) warnings.push(`loaded skill name(s) not in the project catalog: ${unknownLoaded.join(', ')}`);

  let tokens = null;
  if (usageByMessage.size > 0) {
    const sum = (field) => {
      let total = 0;
      let any = false;
      for (const usage of usageByMessage.values()) {
        if (typeof usage[field] === 'number' && Number.isFinite(usage[field])) { total += usage[field]; any = true; }
      }
      return any ? total : null;
    };
    tokens = { input: sum('input_tokens'), output: sum('output_tokens'), cacheRead: sum('cache_read_input_tokens'), cacheCreation: sum('cache_creation_input_tokens'), messages: usageByMessage.size };
    const parts = [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheCreation].filter((n) => n !== null);
    tokens.total = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  }

  let block = null;
  if (firstUserText !== undefined) {
    const match = /<jev-skills>\s*([\s\S]*?)\s*<\/jev-skills>/.exec(firstUserText);
    block = { present: Boolean(match), load: null, consider: null };
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        block.load = names(parsed?.load);
        block.consider = names(parsed?.consider);
      } catch { warnings.push('the <jev-skills> block in the subagent prompt is not valid JSON'); }
    }
  } else warnings.push('no first user message found in the subagent transcript');

  const target = task.targetSkill;
  const targetEntry = target ? loaded.find((entry) => entry.name === target) ?? null : null;
  const firstWrite = writes.length ? writes[0].index : null;
  const outOfScope = writes.filter((write) => write.rel === null || !inScope(write.rel, task.id)).map((write) => write.rel ?? write.raw ?? '(unknown path)');
  return {
    summary: {
      toolCalls: calls.length,
      toolNames,
      loadedSkills: loaded,
      targetSkillLoaded: target ? targetEntry !== null : null,
      targetLoadedBeforeFirstWrite: target ? (targetEntry !== null && (firstWrite === null || targetEntry.callIndex < firstWrite)) : null,
      promptHadSkillsBlock: block ? block.present : null,
      promptBlockLoad: block ? block.load : null,
      promptBlockConsider: block ? block.consider : null,
      firstPromptContainsTask: firstUserText !== undefined ? squash(firstUserText).includes(squash(task.text)) : null,
      tokens,
      wallMs: stamps.length >= 2 ? Math.max(...stamps) - Math.min(...stamps) : null,
      filesWritten: [...new Set(writes.map((write) => write.rel ?? write.raw ?? '(unknown path)'))],
      outOfScopeWrites: [...new Set(outOfScope)],
    },
    warnings,
  };
}

// ---------------------------------------------------------------- main
export function analyze({ arm, project, stateDir, transcripts, template, tasksFile = join(here, 'tasks.json') }) {
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
  const eventsFor = (type, toolUseId) => events.filter((event) => event.type === type && event.taskId === toolUseId);

  const claimed = new Set();
  const usedAgents = new Set();
  const taskRows = tasks.map((task) => {
    const notes = [];
    const verdict = checkById.get(task.id) ?? null;
    if (!verdict) notes.push('no checker result');
    const wanted = squash(task.text);
    const matches = main.agentCalls.filter((call) => call.prompt !== null && squash(call.prompt).includes(wanted));
    const call = matches[0] ?? null;
    if (!call) notes.push('no Agent call in the Main transcript contains this task text');
    if (matches.length > 1) notes.push(`${matches.length} Agent calls contain this task text; the first one is used`);
    for (const match of matches) claimed.add(match.id);

    let hook = { skillsEvent: null, injected: null, load: null, consider: null, mode: null, status: null, route: null };
    let agentId = null;
    let agentIdSource = null;
    if (call) {
      const skillEvents = eventsFor('skills', call.id);
      if (skillEvents.length === 0) notes.push('no skills event for this delegation');
      if (skillEvents.length > 1) notes.push(`${skillEvents.length} skills events for this delegation; the last one is used`);
      const skills = skillEvents[skillEvents.length - 1] ?? null;
      const routeEvents = eventsFor('route', call.id);
      const route = routeEvents[routeEvents.length - 1] ?? null;
      if (!route) notes.push('no route event for this delegation');
      hook = {
        skillsEvent: skills !== null,
        injected: skills && typeof skills.injected === 'boolean' ? skills.injected : null,
        load: skills ? names(skills.load) : null,
        consider: skills ? names(skills.consider) : null,
        mode: skills ? str(skills.mode) : null,
        status: skills ? str(skills.status) : null,
        route: route && isObject(route.route) ? { profile: str(route.route.profile), model: str(route.route.model), effort: str(route.route.effort) } : null,
      };
      if (skills && typeof skills.injected !== 'boolean') notes.push('skills event has no boolean "injected"');

      const spawn = eventsFor('spawn_observed', call.id).map((event) => str(event.agentId)).filter((id) => id !== null);
      if (spawn.length > 1 && new Set(spawn).size > 1) notes.push(`several spawn_observed agent ids for this delegation: ${[...new Set(spawn)].join(', ')}; the first is used`);
      if (spawn.length) { agentId = spawn[0]; agentIdSource = 'spawn_observed'; }
      else if (main.agentResults.has(call.id)) { agentId = main.agentResults.get(call.id); agentIdSource = 'main_tool_result'; }
      else {
        // Last resort that is still evidence, not a guess: the one subagent transcript whose first prompt
        // contains this task text.
        const byPrompt = [];
        for (const [id, agent] of agents) {
          agent.rows ??= readJsonl(agent.file, warnings) ?? [];
          const first = agent.rows.find((row) => (row.type === 'user' || row.message?.role === 'user') && messageText(row) !== null);
          if (first && squash(messageText(first)).includes(wanted)) byPrompt.push(id);
        }
        if (byPrompt.length === 1) { agentId = byPrompt[0]; agentIdSource = 'prompt_match'; notes.push('no spawn_observed event; subagent found by its first prompt'); }
        else notes.push(byPrompt.length === 0 ? 'no spawn_observed event and no subagent transcript starts with this task' : `no spawn_observed event and ${byPrompt.length} subagent transcripts start with this task; none is used`);
      }
    }

    let subagent = null;
    if (agentId !== null) {
      const agent = agents.get(agentId);
      if (!agent) notes.push(`subagent transcript agent-${agentId}.jsonl not found`);
      else {
        agent.rows ??= readJsonl(agent.file, warnings) ?? [];
        if (usedAgents.has(agentId)) notes.push(`subagent ${agentId} is also attributed to another task`);
        usedAgents.add(agentId);
        const { summary, warnings: subWarnings } = summariseSubagent(agent.rows, { task, projectRoots, skillNames });
        subagent = summary;
        notes.push(...subWarnings);
      }
    }

    return {
      id: task.id,
      lang: task.lang,
      kind: task.kind,
      targetSkill: task.targetSkill,
      check: verdict ? { done: verdict.done, convention: verdict.convention, failedChecks: verdict.details.filter((d) => !d.ok).map((d) => d.check) } : null,
      delegation: call ? { toolUseId: call.id, subagentType: call.subagentType, promptVerbatim: squash(call.prompt) === wanted, agentCalls: matches.length } : null,
      hook,
      agentId,
      agentIdSource,
      subagent,
      warnings: notes,
    };
  });

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
  const total = (pick) => {
    const values = taskRows.map(pick);
    const measured = values.filter((value) => typeof value === 'number');
    return { sum: measured.length ? measured.reduce((a, b) => a + b, 0) : null, measured: measured.length, of: taskRows.length };
  };
  return {
    schema: 1,
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
      targetSkillLoaded: count(skillRows, (row) => row.subagent?.targetSkillLoaded),
      injectedOnSkillTasks: count(skillRows, (row) => row.hook.injected),
      injectedOnControls: count(controlRows, (row) => row.hook.injected),
      subagentToolCalls: total((row) => row.subagent?.toolCalls),
      subagentTokens: total((row) => row.subagent?.tokens?.total),
      subagentWallMs: total((row) => row.subagent?.wallMs),
    },
    tasks: taskRows,
    warnings,
  };
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
      if (!args[name]) throw new Error('usage: analyze.mjs --arm <label> --project <dir> --state-dir <dir> --transcripts <dir> --out <file> [--template <dir>]');
    }
    for (const name of ['project', 'state-dir', 'transcripts']) {
      if (!existsSync(args[name]) || !statSync(args[name]).isDirectory()) throw new Error(`--${name} is not a folder: ${args[name]}`);
    }
    const result = analyze({ arm: args.arm, project: args.project, stateDir: args['state-dir'], transcripts: args.transcripts, template: args.template });
    writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');
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
