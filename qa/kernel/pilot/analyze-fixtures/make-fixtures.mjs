#!/usr/bin/env node
// Regenerates the tiny synthetic hook state and transcripts used by analyze.test.mjs. Everything here is
// made up to exercise the analyzer's parsing; it is not output of a real session. "__PROJECT__" in a path
// is replaced with the temp project folder by the test.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { tasks } = JSON.parse(readFileSync(join(here, '..', 'tasks.json'), 'utf8'));
const text = Object.fromEntries(tasks.map((task) => [task.id, task.text]));
const catalog = readdirSync(join(here, '..', 'template', '.claude', 'skills')).sort();
const out = (rel, content) => {
  mkdirSync(dirname(join(here, rel)), { recursive: true });
  writeFileSync(join(here, rel), content);
};
const jsonl = (rows) => rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row))).join('\n') + '\n';
for (const dir of ['state', 'transcripts', 'real-shape']) rmSync(join(here, dir), { recursive: true, force: true });

const at = (seconds) => new Date(Date.parse('2026-11-25T01:00:00.000Z') + seconds * 1000).toISOString();
const agentCall = (id, prompt, when, type = 'general-purpose') => ({
  type: 'assistant', timestamp: at(when),
  message: { id: `msg_main_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'task', prompt, subagent_type: type } }] },
});
const result = (id, when, agentId) => ({
  type: 'user', timestamp: at(when), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
  ...(agentId ? { toolUseResult: { agentId } } : {}),
});

// ---- Main transcript
out('transcripts/main-session.jsonl', jsonl([
  { type: 'user', timestamp: at(0), message: { role: 'user', content: 'coordinate the tasks' } },
  'this line is not JSON',
  { type: 'assistant', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'README.md' } }] } },
  agentCall('toolu_t01', text.t01, 2),
  result('toolu_t01', 60),
  agentCall('toolu_t02', `Please do this.\n\n${text.t02}\n\nThanks.`, 61),
  result('toolu_t02', 120),
  agentCall('toolu_t03', text.t03, 121),
  result('toolu_t03', 150, 'a03'),
  agentCall('toolu_t04a', text.t04, 151),
  agentCall('toolu_t04b', text.t04, 200),
  agentCall('toolu_t06', text.t06, 260),
  agentCall('toolu_t08', text.t08, 280),
  agentCall('toolu_other', 'Summarise the README.', 300, 'Explore'),
]));

// ---- hook state
const event = (name, body) => out(`state/sessions/sess-1/events/${name}.json`, JSON.stringify(body) + '\n');
// The skills event has the shape orchestration/src/hooks.mjs (skillsEvent) writes: optional entries are under
// "suggest", and the status of a decision that picked something is "selected".
const skillsEvent = (taskId, injected, load, suggest = []) => ({ type: 'skills', taskId, mode: 'active', status: load.length ? 'selected' : 'none', code: null, need: null,
  candidates: 60, decisionId: null, decisionIds: [], retrieval: 'full', cached: false, catalog: 'fp', injected, load, suggest, trace: [] });
event('0001-route', { type: 'route', taskId: 'toolu_t01', route: { profile: 'implement', model: 'model-x', effort: 'medium' } });
event('0002-skills', skillsEvent('toolu_t01', true, [{ name: 'partner-file-exports', probability: 0.97 }], [{ name: 'carrier-csv-intake', probability: 0.55 }]));
event('0003-spawn', { type: 'spawn_observed', taskId: 'toolu_t01', failed: false, agentId: 'a01', taskName: null });
event('0004-route', { type: 'route', taskId: 'toolu_t02', route: { profile: 'implement', model: 'model-x', effort: 'medium' } });
event('0005-skills', skillsEvent('toolu_t02', false, []));
event('0006-skills', skillsEvent('toolu_t03', true, [{ name: 'repo-tour', probability: 0.91 }]));
event('0007-skills', { type: 'skills', taskId: 'toolu_t04a', mode: 'active', status: 'ok', injected: 'yes', load: 'unexpected' });
event('0008-spawn', { type: 'spawn_observed', taskId: 'toolu_t06', agentId: 'a-missing' });
out('state/sessions/sess-1/events/0009-broken.json', '{ "type": "skills", ');
event('0010-untyped', { taskId: 'toolu_t06' });
// t04: the first spawn failed and Main delegated again. The second call has its own events and subagent.
event('0011-spawn', { type: 'spawn_observed', taskId: 'toolu_t04a', failed: true, agentId: null, taskName: null });
event('0012-skills', skillsEvent('toolu_t04b', true, [{ name: 'periodic-job-contract', probability: 0.93 }]));
event('0013-spawn', { type: 'spawn_observed', taskId: 'toolu_t04b', failed: false, agentId: 'a04b', taskName: null });
event('0014-skills', skillsEvent('toolu_t08', false, []));
event('0015-spawn', { type: 'spawn_observed', taskId: 'toolu_t08', failed: false, agentId: 'a08', taskName: null });

// ---- subagent transcripts
const block = '<jev-skills>\n{"load":[{"name":"partner-file-exports","path":".claude/skills/partner-file-exports/SKILL.md","p":0.97}],"consider":[{"name":"carrier-csv-intake","path":".claude/skills/carrier-csv-intake/SKILL.md","p":0.55}]}\n</jev-skills>\nBefore starting, load each "load" skill.';
const usage = (input, output, read, create) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: create });
const assistant = (when, id, content, use) => ({ type: 'assistant', isSidechain: true, ...(when === null ? {} : { timestamp: at(when) }), message: { ...(id ? { id } : {}), role: 'assistant', content, ...(use ? { usage: use } : {}) } });
const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });

// A made-up stand-in for the row in which the harness lists the available skills. The real row shape was not
// available offline; the analyzer does not depend on it (it looks for catalog names in any early row).
const listing = (when, names) => ({ type: 'attachment', isSidechain: true, timestamp: at(when), attachment: { type: 'skill_listing', content: names.map((name) => `- ${name}: (description)`).join('\n') } });

out('transcripts/subagents/agent-a01.jsonl', jsonl([
  { type: 'user', isSidechain: true, timestamp: at(3), message: { role: 'user', content: `[routing packet]\n${text.t01}\n\n${block}` } },
  listing(3, catalog),
  // one API message written as two lines with the same id and the same usage: counted once
  assistant(4, 'msg_1', [{ type: 'text', text: 'Loading the skill.' }], usage(100, 20, 1000, 50)),
  assistant(4, 'msg_1', [tool('tu_1', 'Skill', { skill: 'partner-file-exports' })], usage(100, 20, 1000, 50)),
  { type: 'user', isSidechain: true, timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } },
  assistant(6, 'msg_2', [tool('tu_2', 'Read', { file_path: '__PROJECT__/src/util/time.mjs' })], usage(200, 30, 2000, 0)),
  assistant(20, 'msg_3', [tool('tu_3', 'Write', { file_path: '__PROJECT__/src/reports/overdue-parcels.mjs', content: '...' }), tool('tu_4', 'Write', { file_path: '__PROJECT__/test/overdue.test.mjs', content: '...' })], usage(300, 400, 3000, 10)),
  assistant(45, 'msg_4', [{ type: 'text', text: 'Done.' }], usage(50, 60, 3500, 0)),
]));

// no timestamps, no usage, skill read by path after the first edit
out('transcripts/subagents/agent-a02.jsonl', jsonl([
  { type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'text', text: `Please do this.\n\n${text.t02}\n\nThanks.` }] } },
  assistant(null, null, [tool('tu_1', 'Edit', { file_path: 'src/config/settings.mjs', old_string: 'a', new_string: 'b' })]),
  assistant(null, null, [tool('tu_2', 'Read', { file_path: '__PROJECT__/.claude/skills/runtime-settings/SKILL.md' })]),
  assistant(null, null, [tool('tu_3', 'Bash', { command: 'node --test' })]),
]));

// control: loads an unrelated skill, writes outside its own paths (inside and outside the project)
out('transcripts/subagents/agent-a03.jsonl', jsonl([
  { type: 'user', isSidechain: true, timestamp: at(122), message: { role: 'user', content: text.t03 } },
  assistant(123, 'msg_1', [tool('tu_1', 'Skill', { skill: 'repo-tour' }), tool('tu_2', 'Skill', { skill: 'not-a-project-skill' })], { input_tokens: 10, output_tokens: 5 }),
  assistant(130, 'msg_2', [tool('tu_3', 'Edit', { file_path: '__PROJECT__/src/util/tracking.mjs' }), tool('tu_4', 'Edit', { file_path: '__PROJECT__/package.json' }), tool('tu_5', 'Write', { file_path: '/elsewhere/notes.txt' })], { input_tokens: 20, output_tokens: 5 }),
  'garbage',
]));
// second Agent call of t04 (never scored: the first call is the task's call)
out('transcripts/subagents/agent-a04b.jsonl', jsonl([
  { type: 'user', isSidechain: true, timestamp: at(201), message: { role: 'user', content: text.t04 } },
  assistant(202, 'msg_1', [tool('tu_1', 'Skill', { skill: 'periodic-job-contract' })], usage(10, 10, 0, 0)),
]));

// t08: a listing cut short that leaves the target out; the skill text read through Bash; a Grep over the whole
// skills folder; usage on one of three assistant messages; one row without a timestamp
out('transcripts/subagents/agent-a08.jsonl', jsonl([
  { type: 'user', isSidechain: true, timestamp: at(281), message: { role: 'user', content: text.t08 } },
  listing(281, ['repo-tour', 'who-owns-what', 'write-endpoints', 'api-doc-entries']),
  assistant(282, 'msg_1', [tool('tu_1', 'Grep', { pattern: 'template', path: '__PROJECT__/.claude/skills' })], usage(1000, 10, 0, 0)),
  assistant(283, 'msg_2', [tool('tu_2', 'Bash', { command: 'cat .claude/skills/customer-text-messages/SKILL.md | head -40' })]),
  assistant(null, 'msg_3', [tool('tu_3', 'Edit', { file_path: '__PROJECT__/src/notify/templates.mjs' })]),
]));

// ---------------------------------------------------------------------------------------------------------
// real-shape/: the same kind of made-up data, but in the row shapes seen in the two real pilot sessions
// (2026-11-25). Every id, name, number and text here is invented; nothing is copied from a session.
//  - request-log rows ("api-request", "api-request-blob") repeat tool_use / tool_result items of the conversation
//  - a hook rewrite makes the harness refuse the Agent call; Main issues it again with the rewritten input
//  - the Agent tool returns { status: "async_launched", agentId }; the report arrives later as a peer message
//  - agent-<id>.jsonl comes with agent-<id>.meta.json and agent-<id>.prefix.json
//  - the skill listing is an attachment row with a "names" array
{
  const R = 'real-shape';
  const mainPrompt = readFileSync(join(here, '..', 'main-prompt.txt'), 'utf8').trim();
  const routing = (n) => `\n\n<jev-routing>\n{"decisionId":"route-${n}","role":"implement"}\n</jev-routing>\nPerform only the original task.`;
  const skillsBlock = (name) => `\n\n<jev-skills>\n{"load":[{"name":"${name}","path":".claude/skills/${name}/SKILL.md","p":0.97}],"consider":[{"name":"carrier-csv-intake","path":".claude/skills/carrier-csv-intake/SKILL.md","p":0.6}]}\n</jev-skills>\nBefore starting, load each "load" skill.`;
  const p1 = `${text.t01}${routing(1)}${skillsBlock('partner-file-exports')}`;
  const p3 = `${text.t03}${routing(3)}`;
  const mainUsage = (n) => ({ input_tokens: 2, output_tokens: 100 * n, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 10 * n });
  const mainAgent = (when, msg, id, type, prompt, n) => ({ type: 'assistant', isSidechain: false, timestamp: at(when), effort: 'medium',
    message: { id: msg, model: 'model-main', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'synthetic', subagent_type: type, prompt } }], usage: mainUsage(n) } });
  const blobUse = (id, type, prompt) => ({ type: 'api-request-blob', hash: `h-${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'synthetic', subagent_type: type, prompt } }] } });
  const blobResult = (id) => ({ type: 'api-request-blob', hash: `hr-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'copy of the result (synthetic)' }] } });
  const rewrite = (when, id, prompt, type) => ({ type: 'attachment', timestamp: at(when), attachment: { type: 'hook_success', hookName: 'PreToolUse:Agent', toolUseID: id, hookEvent: 'PreToolUse', content: '',
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { description: 'synthetic', prompt, subagent_type: type } } }) } });
  const refused = (when, id) => ({ type: 'user', timestamp: at(when), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'refused: a hook changed the input (synthetic)' }] },
    toolUseResult: 'Error: refused (synthetic)', permissionDecision: { decision: 'reject', source: 'config', reasonType: 'classifier', reasonCode: 'classifier:auto-mode:unavailable' }, toolDenialKind: 'automode-unavailable' });
  const launched = (when, id, agentId, model) => ({ type: 'user', timestamp: at(when), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'launched (synthetic)' }] }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId, resolvedModel: model }, permissionDecision: { decision: 'accept', source: 'config', reasonType: 'classifier' } });
  const handback = (when) => ({ type: 'user', isMeta: true, timestamp: at(when), origin: { kind: 'peer' }, message: { role: 'user', content: 'report of a subagent (synthetic)' } });

  out(`${R}/transcripts/main.jsonl`, jsonl([
    { type: 'user', timestamp: at(0), permissionMode: 'auto', message: { role: 'user', content: `Background line (synthetic).\n\n${mainPrompt}\n\nNotes line (synthetic).` } },
    { type: 'user', isMeta: true, timestamp: at(0), message: { role: 'user', content: '<system-reminder>synthetic</system-reminder>' } },
    { type: 'assistant', timestamp: at(1), effort: 'medium', message: { id: 'msg_m0', model: 'model-main', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_plan', name: 'plan_tool', input: {} }], usage: mainUsage(1) } },
    // t01: refused attempt, then the launched call with the hook's rewrite as its input
    mainAgent(2, 'msg_m1', 'toolu_r01a', 'general-purpose', text.t01, 1),
    rewrite(3, 'toolu_r01a', p1, 'jev4_implement_light_x'),
    refused(3, 'toolu_r01a'),
    blobUse('toolu_r01a', 'general-purpose', text.t01),
    blobResult('toolu_r01a'),
    { type: 'api-request', timestamp: at(3), id: 'req-1' },
    // one API message on two rows (thinking, then the tool call) with the same id and usage
    { type: 'assistant', timestamp: at(8), effort: 'medium', message: { id: 'msg_m2', model: 'model-main', role: 'assistant', content: [{ type: 'thinking', thinking: '' }], usage: mainUsage(2) } },
    mainAgent(9, 'msg_m2', 'toolu_r01b', 'jev4_implement_light_x', p1, 2),
    rewrite(10, 'toolu_r01b', `${p1}${routing(11)}${skillsBlock('partner-file-exports')}`, 'jev4_implement_standard_y'),
    launched(10, 'toolu_r01b', 'ar01', 'model-light'),
    blobUse('toolu_r01b', 'jev4_implement_light_x', p1),
    handback(70),
    // t03 (control): refused attempt, then launched; no skills block
    mainAgent(71, 'msg_m3', 'toolu_r03a', 'general-purpose', text.t03, 3),
    rewrite(72, 'toolu_r03a', p3, 'jev4_implement_standard_y'),
    refused(72, 'toolu_r03a'),
    mainAgent(76, 'msg_m4', 'toolu_r03b', 'jev4_implement_standard_y', p3, 4),
    rewrite(77, 'toolu_r03b', `${p3}${routing(33)}`, 'jev4_implement_standard_y'),
    launched(77, 'toolu_r03b', 'ar03', 'model-standard'),
    handback(110),
    // t04: the router deferred, the hook rewrote nothing, the first call launched as it was
    mainAgent(111, 'msg_m5', 'toolu_r04', 'general-purpose', text.t04, 5),
    { type: 'attachment', timestamp: at(112), attachment: { type: 'hook_success', hookName: 'PreToolUse:Agent', toolUseID: 'toolu_r04', hookEvent: 'PreToolUse', content: '', stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'synthetic' } }) } },
    launched(112, 'toolu_r04', 'ar04', 'model-main'),
    handback(150),
    { type: 'assistant', timestamp: at(151), effort: 'medium', message: { id: 'msg_m6', model: 'model-main', role: 'assistant', content: [{ type: 'text', text: 'All done (synthetic).' }], usage: mainUsage(6) } },
  ]));

  // ---- hook state: two sessions (one holds only its start), events, decision log
  const ev = (session, name, body) => out(`${R}/state/sessions/${session}/events/${name}.json`, JSON.stringify(body) + '\n');
  const route = (taskId, profile, model, effort, hookMs) => ({ type: 'route', time: 1, taskId, inputHash: 'x', mode: 'active', cached: false, latencyMs: hookMs - 30.4, hookMs: hookMs + 0.3,
    route: { role: 'implement', tier: profile.includes('light') ? 'light' : 'standard', model, effort, profile, decisionReason: 'synthetic_reason' } });
  const skillsEv = (taskId, need, injected, load, suggest, trace, decisionIds) => ({ type: 'skills', time: 1, taskId, mode: 'active', status: load.length ? 'selected' : 'none', code: null, need, candidates: 60,
    decisionId: decisionIds[0], decisionIds, retrieval: { mode: 'full', wide: true, requests: 2, failed: 0, judged: 60, dropped: 0 }, cached: false, catalog: 'fp', injected, load, suggest, trace });
  ev('s-setup', '0001', { type: 'session_started', time: 0, source: 'startup' });
  ev('s-run', '0001', { type: 'session_started', time: 1, source: 'startup' });
  ev('s-run', 'e01', route('toolu_r01a', 'jev4_implement_light_x', 'small', 'xhigh', 1200));
  ev('s-run', 'e02', skillsEv('toolu_r01a', 0.7, true, [{ name: 'partner-file-exports', probability: 0.97 }], [{ name: 'carrier-csv-intake', probability: 0.6 }],
    [{ name: 'carrier-csv-intake', stage: 'suggested', probability: 0.6 }, { name: 'partner-file-exports', stage: 'loaded', probability: 0.97 }, { name: 'repo-tour', stage: 'below_threshold', probability: 0.1 }, { name: 'who-owns-what', stage: 'below_threshold', probability: 0.05 }], ['d1', 'd2']));
  ev('s-run', 'e03', route('toolu_r01b', 'jev4_implement_standard_y', 'large', 'high', 500));
  ev('s-run', 'e04', skillsEv('toolu_r01b', 0.8, true, [{ name: 'partner-file-exports', probability: 0.98 }], [], [{ name: 'partner-file-exports', stage: 'loaded', probability: 0.98 }], ['d3', 'd4']));
  ev('s-run', 'e05', { type: 'spawn_observed', time: 1, taskId: 'toolu_r01b', failed: false, agentId: 'ar01', taskName: null });
  ev('s-run', 'e06', { type: 'agent_started', time: 1, agentId: 'ar01', agentType: 'jev4_implement_light_x' });
  ev('s-run', 'e07', { type: 'agent_stopped', time: 1, agentId: 'helper-1', agentType: 'unknown' }); // an unrelated helper agent
  ev('s-run', 'e08', { type: 'agent_stopped', time: 1, agentId: 'ar01', agentType: 'jev4_implement_light_x' });
  ev('s-run', 'e09', route('toolu_r03a', 'jev4_implement_standard_y', 'large', 'high', 520));
  // the target of no task is judged here: need under the gate, so nothing is injected whatever the top probability
  ev('s-run', 'e10', skillsEv('toolu_r03a', 0.08, false, [], [], [{ name: 'repo-tour', stage: 'need_gate', probability: 0.14 }], ['d5', 'd6']));
  ev('s-run', 'e11', route('toolu_r03b', 'jev4_implement_standard_y', 'large', 'high', 540));
  ev('s-run', 'e12', skillsEv('toolu_r03b', 0.09, false, [], [], [{ name: 'repo-tour', stage: 'need_gate', probability: 0.12 }], ['d7', 'd8']));
  ev('s-run', 'e13', { type: 'spawn_observed', time: 1, taskId: 'toolu_r03b', failed: false, agentId: 'ar03', taskName: null });
  ev('s-run', 'e14', { type: 'route_deferred', time: 1, taskId: 'toolu_r04', reason: 'selector_abstained' });
  ev('s-run', 'e15', skillsEv('toolu_r04', 0.4, false, [], [], [{ name: 'periodic-job-contract', stage: 'need_gate', probability: 0.93 }, { name: 'job-interval-changes', stage: 'need_gate', probability: 0.2 }], ['d9', 'd-missing']));
  ev('s-run', 'e16', { type: 'spawn_observed', time: 1, taskId: 'toolu_r04', failed: false, agentId: 'ar04', taskName: null });
  const decision = (id, pointId, latencyMs, provider = 'jev') => ({ schema: 1, time: 1, pointId, mode: 'active', decisionId: id, provider, model: 'judge-x', cached: false, latencyMs, answers: {}, trail: [] });
  out(`${R}/state/decisions-log/decisions-2026-11.jsonl`, jsonl([
    decision('c1', 'delegation.classify', 400.2), decision('c2', 'delegation.classify', 300.4), decision('p1', 'delegation.profile', 200.6), decision('p2', 'delegation.profile', 1200, 'none'),
    decision('d1', 'delegation.skills', 300.4), decision('d2', 'delegation.skills', 310.4), decision('d3', 'delegation.skills', 290.1), decision('d4', 'delegation.skills', 295.1),
    decision('d5', 'delegation.skills', 280), decision('d6', 'delegation.skills', 281), decision('d7', 'delegation.skills', 282), decision('d8', 'delegation.skills', 283), decision('d9', 'delegation.skills', 270),
  ]));

  // ---- subagent transcripts
  const side = (row) => ({ isSidechain: true, ...row });
  const sub = (when, msg, content, use, model = 'model-light') => side({ type: 'assistant', timestamp: at(when), message: { id: msg, model, role: 'assistant', content, usage: use } });
  const res = (when, id, extra = {}) => side({ type: 'user', timestamp: at(when), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok (synthetic)', ...(extra.error ? { is_error: true } : {}) }] },
    permissionDecision: extra.reject ? { decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PreToolUse' } : { decision: 'accept', source: 'config' } });
  const realListing = (when, names) => side({ type: 'attachment', timestamp: at(when), attachment: { type: 'skill_listing', skillCount: names.length, isInitial: true, names,
    content: names.map((name) => `- ${name}: one synthetic sentence about ${name}`).join('\n'), digests: {} } });
  const reminder = (when) => side({ type: 'user', isMeta: true, timestamp: at(when), message: { role: 'user', content: '<system-reminder>\nYour final report is delivered through a tool (synthetic).\n</system-reminder>' } });
  const start = (when) => side({ type: 'attachment', timestamp: at(when), attachment: { type: 'hook_success', hookName: 'SubagentStart:x', hookEvent: 'SubagentStart', content: '', stdout: '' } });
  const blob = (items) => ({ type: 'api-request-blob', hash: 'h', message: { role: 'assistant', content: items } });
  const allListed = [...catalog, 'user-level-skill', 'plugin-x:plugin-skill'];
  const meta = (id, body) => { out(`${R}/transcripts/subagents/agent-${id}.meta.json`, JSON.stringify(body)); out(`${R}/transcripts/subagents/agent-${id}.prefix.json`, JSON.stringify({ v: 1 })); };

  // t01: a look around, then the Skill tool, a heredoc write through Bash, a Write, the hand-back
  const heredoc = "cd proj && mkdir -p src/reports && cat > src/reports/overdue-parcels.mjs <<'EOF'\nexport const x = 1;\nEOF";
  out(`${R}/transcripts/subagents/agent-ar01.jsonl`, jsonl([
    side({ type: 'user', timestamp: at(10), message: { role: 'user', content: p1 } }),
    start(10), reminder(10), realListing(10, allListed),
    sub(12, 'msg_s1', [{ type: 'thinking', thinking: '' }], usage(2, 60, 30000, 9000)),
    sub(12, 'msg_s1', [tool('tu_1', 'Bash', { command: 'cd proj && ls -la && cat package.json 2>/dev/null' })], usage(2, 60, 30000, 9000)),
    res(13, 'tu_1'),
    sub(15, 'msg_s2', [tool('tu_2', 'Skill', { skill: 'partner-file-exports' })], usage(2, 40, 39000, 500)),
    res(15, 'tu_2'),
    side({ type: 'user', timestamp: at(15), message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: (synthetic)' }] } }),
    blob([tool('tu_1', 'Bash', { command: 'copy' }), tool('tu_2', 'Skill', { skill: 'partner-file-exports' })]),
    { type: 'api-request', timestamp: at(16), id: 'req-s1' },
    { type: 'api-request-shape', shape: {} },
    sub(20, 'msg_s3', [tool('tu_3', 'Bash', { command: heredoc })], usage(2, 300, 39500, 800)),
    res(21, 'tu_3'),
    sub(30, 'msg_s4', [tool('tu_4', 'Write', { file_path: '__PROJECT__/test/overdue.test.mjs', content: '...' })], usage(2, 200, 40300, 600)),
    res(31, 'tu_4'),
    sub(40, 'msg_s5', [tool('tu_5', 'Bash', { command: 'npm test 2>&1 | tail -5' })], usage(2, 50, 40900, 300)),
    res(45, 'tu_5', { error: true }),
    sub(60, 'msg_s6', [tool('tu_6', 'SubagentHandback', { message: 'report (synthetic)' })], usage(2, 400, 41200, 200)),
    res(61, 'tu_6'),
    side({ type: 'attachment', timestamp: at(61), attachment: { type: 'hook_success', hookName: 'SubagentStop', hookEvent: 'SubagentStop', content: '', stdout: '' } }),
  ]));
  meta('ar01', { agentType: 'jev4_implement_light_x', isBuiltIn: false, description: 'synthetic', toolUseId: 'toolu_r01b', spawnDepth: 1, model: 'model-light', finished: true });

  // t03 (control): user-level skill search of three kinds, and one tool call a hook rejected
  out(`${R}/transcripts/subagents/agent-ar03.jsonl`, jsonl([
    side({ type: 'user', timestamp: at(77), message: { role: 'user', content: p3 } }),
    reminder(77), realListing(77, allListed),
    sub(79, 'msg_c1', [tool('tu_1', 'ToolSearch', { query: 'select:mcp__skill-finder__search_skills', max_results: 3 })], usage(2, 10, 1000, 100), 'model-standard'),
    res(79, 'tu_1'),
    sub(80, 'msg_c2', [tool('tu_2', 'mcp__skill-finder__search_skills', { query: 'synthetic' }), tool('tu_3', 'Skill', { skill: 'user-level-skill' })], usage(2, 10, 1100, 0), 'model-standard'),
    res(81, 'tu_2'), res(81, 'tu_3'),
    sub(82, 'msg_c3', [tool('tu_4', 'plan_tool', {})], usage(2, 10, 1200, 0), 'model-standard'),
    res(82, 'tu_4', { error: true, reject: true }),
    sub(90, 'msg_c4', [tool('tu_5', 'Edit', { file_path: '__PROJECT__/src/util/tracking.mjs', old_string: 'a', new_string: 'b' })], usage(2, 10, 1300, 0), 'model-standard'),
    res(91, 'tu_5'),
    sub(100, 'msg_c5', [tool('tu_6', 'SubagentHandback', { message: 'report (synthetic)' })], usage(2, 10, 1400, 0), 'model-standard'),
    res(101, 'tu_6'),
  ]));
  meta('ar03', { agentType: 'jev4_implement_standard_y', toolUseId: 'toolu_r03b', model: 'model-standard' });

  // t04: no meta file; the Skill tool is the very first call
  out(`${R}/transcripts/subagents/agent-ar04.jsonl`, jsonl([
    side({ type: 'user', timestamp: at(112), message: { role: 'user', content: text.t04 } }),
    realListing(112, allListed),
    sub(114, 'msg_j1', [tool('tu_1', 'Skill', { skill: 'periodic-job-contract' })], usage(2, 10, 500, 50), 'model-main'),
    res(114, 'tu_1'),
    sub(120, 'msg_j2', [tool('tu_2', 'Write', { file_path: '__PROJECT__/src/jobs/purge.mjs', content: '...' })], usage(2, 10, 600, 0), 'model-main'),
    res(121, 'tu_2'),
  ]));
}
console.log('fixtures written');
