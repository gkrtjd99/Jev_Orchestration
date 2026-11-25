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
for (const dir of ['state', 'transcripts']) rmSync(join(here, dir), { recursive: true, force: true });

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
console.log('fixtures written');
