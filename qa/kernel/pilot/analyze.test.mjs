// Test of analyze.mjs and compare.mjs against synthetic state/transcripts.   node --test analyze.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyze } from './analyze.mjs';
import { compare, render } from './compare.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'pilot-analyze-')); temps.push(dir); return dir; };

function project(fixtures) {
  const dir = temp();
  cpSync(join(here, 'template'), dir, { recursive: true });
  for (const [set, id] of fixtures) cpSync(join(here, 'fixtures', set, id), dir, { recursive: true });
  return dir;
}

// Copies the synthetic transcripts, pointing "__PROJECT__" at the temp project.
function transcriptsFor(projectDir) {
  const dir = temp();
  cpSync(join(here, 'analyze-fixtures', 'transcripts'), dir, { recursive: true });
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const full = join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else writeFileSync(full, readFileSync(full, 'utf8').replaceAll('__PROJECT__', projectDir));
    }
  };
  walk(dir);
  return dir;
}

const stateDir = join(here, 'analyze-fixtures', 'state');
const projectDir = project([['reference', 't01'], ['naive', 't02'], ['reference', 't03']]);
const result = analyze({ arm: 'B', project: projectDir, stateDir, transcripts: transcriptsFor(projectDir) });
const task = (id) => result.tasks.find((row) => row.id === id);

test('checker verdicts are carried per task', () => {
  assert.deepEqual([task('t01').check.done, task('t01').check.convention], [true, true]);
  assert.deepEqual([task('t02').check.done, task('t02').check.convention], [true, false]);
  assert.deepEqual([task('t03').check.done, task('t03').check.convention], [true, null]);
  assert.deepEqual([task('t05').check.done, task('t05').check.convention], [false, false]);
  assert.deepEqual(result.totals.primary_conventionPassed, { yes: 1, measured: 6, of: 6 });
  assert.deepEqual(result.totals.controlsDone, { yes: 1, measured: 2, of: 2 });
});

test('a fully observed task: events, skill load, tokens, wall time', () => {
  const t = task('t01');
  assert.deepEqual(t.delegation, { toolUseId: 'toolu_t01', subagentType: 'general-purpose', promptVerbatim: true, agentCalls: 1, spawnFailed: false });
  assert.deepEqual(t.otherCalls, []);
  assert.equal(t.hook.injected, true);
  assert.deepEqual(t.hook.load, ['partner-file-exports']);
  assert.deepEqual(t.hook.consider, ['carrier-csv-intake']); // stored by the hook under "suggest"
  assert.equal(t.hook.status, 'selected');
  assert.deepEqual(t.hook.route, { profile: 'implement', model: 'model-x', effort: 'medium' });
  assert.equal(t.agentId, 'a01');
  assert.equal(t.agentIdSource, 'spawn_observed');
  assert.equal(t.subagent.toolCalls, 4);
  assert.deepEqual(t.subagent.toolNames, { Skill: 1, Read: 1, Write: 2 });
  assert.deepEqual(t.subagent.loadedSkills, [{ name: 'partner-file-exports', via: 'Skill', callIndex: 0 }]);
  assert.equal(t.subagent.targetSkillLoaded, true);
  assert.equal(t.subagent.targetSkillLoadedVia, 'Skill');
  assert.equal(t.subagent.targetLoadedBeforeFirstWrite, true);
  assert.deepEqual(t.subagent.skillListing, { found: true, source: 'attachment:skill_listing', catalogNamesListed: 60, catalogSize: 60 });
  assert.equal(t.subagent.targetListedToSubagent, true);
  assert.equal(t.subagent.promptHadSkillsBlock, true);
  assert.deepEqual(t.subagent.promptBlockLoad, ['partner-file-exports']);
  // msg_1 appears on two lines with the same usage and is counted once
  assert.deepEqual(t.subagent.tokens, { input: 650, output: 510, cacheRead: 9500, cacheCreation: 60, messages: 4, assistantMessages: 4, total: 10720 });
  assert.equal(t.subagent.wallMs, 42000);
  assert.deepEqual(t.subagent.timestampCoverage, { rows: 8, withTimestamp: 8 });
  assert.deepEqual(t.subagent.filesWritten, ['src/reports/overdue-parcels.mjs', 'test/overdue.test.mjs']);
  assert.deepEqual(t.subagent.outOfScopeWrites, []);
  assert.deepEqual(t.warnings, []);
});

test('missing measurements are null with a warning, never a guess', () => {
  const t = task('t02');
  assert.equal(t.delegation.promptVerbatim, false);
  assert.equal(t.hook.injected, false);
  assert.deepEqual(t.hook.load, []);
  assert.equal(t.agentIdSource, 'prompt_match');
  assert.equal(t.subagent.tokens, null);
  assert.equal(t.subagent.wallMs, null);
  assert.deepEqual(t.subagent.loadedSkills, [{ name: 'runtime-settings', via: 'Read', callIndex: 1 }]);
  assert.equal(t.subagent.targetSkillLoaded, true);
  assert.equal(t.subagent.targetLoadedBeforeFirstWrite, false);
  assert.equal(t.subagent.promptHadSkillsBlock, false);
  assert.equal(t.subagent.targetListedToSubagent, null); // no listing row in this transcript
  assert.ok(t.warnings.some((w) => w.includes('no skill listing found')));
  assert.ok(t.warnings.some((w) => w.includes('no spawn_observed event')));

  const none = task('t05');
  assert.equal(none.delegation, null);
  assert.deepEqual(none.hook, { skillsEvent: null, injected: null, load: null, consider: null, mode: null, status: null, route: null });
  assert.equal(none.subagent, null);
  assert.ok(none.warnings.some((w) => w.includes('no Agent call') && w.includes('not delegated')));
  assert.deepEqual([none.check.done, none.check.convention], [false, false]); // an undelegated task is still scored
  assert.deepEqual(result.totals.skillTasksDelegated, { yes: 5, of: 6 });

  const lost = task('t06');
  assert.equal(lost.agentId, 'a-missing');
  assert.equal(lost.subagent, null);
  assert.equal(lost.hook.injected, null);
  assert.ok(lost.warnings.some((w) => w.includes('agent-a-missing.jsonl not found')));

  assert.deepEqual(result.totals.targetSkillLoaded, { yes: 3, measured: 3, of: 6 });
  assert.deepEqual(result.totals.targetSkillLoadedVia, { Skill: 1, Read: 1, Bash: 1 });
  assert.deepEqual(result.totals.targetListedToSubagent, { yes: 1, measured: 2, of: 6 });
  assert.deepEqual(result.totals.subagentTokens, { sum: 11770, measured: 3, of: 8 });
  assert.ok(result.warnings.some((w) => w.includes('unparsable event file')));
  assert.ok(result.warnings.some((w) => w.includes('event without a type')));
  assert.ok(result.warnings.some((w) => w.includes('unparsable line')));
  assert.ok(result.warnings.some((w) => w.includes('match no task') && w.includes('toolu_other')));
  assert.equal(result.agentCallsInMain, 8);
  assert.equal(result.delegationsInTaskOrder, true);
});

test('a retried delegation: events and subagent of the two Agent calls are never mixed', () => {
  const dup = task('t04');
  assert.deepEqual(dup.delegation, { toolUseId: 'toolu_t04a', subagentType: 'general-purpose', promptVerbatim: true, agentCalls: 2, spawnFailed: true });
  assert.equal(dup.hook.skillsEvent, true);
  assert.equal(dup.hook.injected, null); // the first call's event: "injected" was not a boolean
  assert.equal(dup.hook.load, null);
  assert.equal(dup.agentId, null);
  assert.equal(dup.agentIdSource, null);
  assert.equal(dup.subagent, null); // the second call's subagent (a04b) is not scored for the first call
  assert.deepEqual(dup.otherCalls, [{ toolUseId: 'toolu_t04b', agentId: 'a04b', agentIdSource: 'spawn_observed', spawnFailed: false, injected: true, load: ['periodic-job-contract'] }]);
  assert.ok(dup.warnings.some((w) => w.includes('2 Agent calls') && w.includes('otherCalls')));
  assert.ok(dup.warnings.some((w) => w.includes('no boolean "injected"')));
  assert.ok(dup.warnings.some((w) => w.includes('failed=true')));
  assert.ok(!dup.warnings.some((w) => w.includes('no spawn_observed event')));
});

test('skill read through Bash counts as a load; a short listing and partial usage/timestamps are flagged', () => {
  const t = task('t08');
  assert.deepEqual(t.subagent.loadedSkills, [{ name: 'customer-text-messages', via: 'Bash', callIndex: 1 }]);
  assert.deepEqual(t.subagent.skillFolderMentions, [{ name: null, via: 'Grep', callIndex: 0 }]);
  assert.equal(t.subagent.targetSkillLoaded, true);
  assert.equal(t.subagent.targetSkillLoadedVia, 'Bash');
  assert.deepEqual(t.subagent.skillListing, { found: true, source: 'attachment:skill_listing', catalogNamesListed: 4, catalogSize: 60 });
  assert.equal(t.subagent.targetListedToSubagent, false);
  assert.deepEqual([t.subagent.tokens.messages, t.subagent.tokens.assistantMessages, t.subagent.tokens.total], [1, 3, 1010]);
  assert.deepEqual(t.subagent.timestampCoverage, { rows: 5, withTimestamp: 4 });
  assert.ok(t.warnings.some((w) => w.includes('1 of 3 assistant messages')));
  assert.ok(t.warnings.some((w) => w.includes('4 of 5 transcript rows')));
  assert.ok(t.warnings.some((w) => w.includes('does not contain the target skill')));
});

// Ad-hoc synthetic runs for shapes the shared fixture does not hold.
function adHoc({ calls, events = [], subagents = {} }) {
  const dir = temp();
  const state = join(dir, 'state');
  const transcripts = join(dir, 'transcripts');
  mkdirSync(join(state, 'sessions', 's', 'events'), { recursive: true });
  mkdirSync(join(transcripts, 'subagents'), { recursive: true });
  events.forEach((event, i) => writeFileSync(join(state, 'sessions', 's', 'events', `${String(i).padStart(4, '0')}.json`), JSON.stringify(event)));
  writeFileSync(join(transcripts, 'main.jsonl'), calls.map(([id, prompt]) => JSON.stringify({ type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { prompt, subagent_type: 'general-purpose' } }] } })).join('\n') + '\n');
  for (const [agentId, rows] of Object.entries(subagents)) writeFileSync(join(transcripts, 'subagents', `agent-${agentId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return analyze({ arm: 'X', project: join(here, 'template'), stateDir: state, transcripts });
}
const tasksText = Object.fromEntries(JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8')).tasks.map((t) => [t.id, t.text]));
const userRow = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const toolRow = (id, name, input, usage) => ({ type: 'assistant', message: { id: `m_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }], ...(usage ? { usage } : {}) } });

test('prompt-match fallback is refused when two Agent calls carry the task and neither has a spawn event', () => {
  const run = adHoc({
    calls: [['c6', tasksText.t06], ['c6b', tasksText.t06]],
    events: [{ type: 'skills', taskId: 'c6b', injected: true, load: [{ name: 'read-endpoints', probability: 0.9 }], suggest: [] }],
    subagents: { a6b: [userRow(tasksText.t06), toolRow('u1', 'Skill', { skill: 'read-endpoints' })] },
  });
  const t = run.tasks.find((row) => row.id === 't06');
  assert.equal(t.delegation.toolUseId, 'c6');
  assert.equal(t.hook.injected, null);
  assert.equal(t.agentId, null);
  assert.equal(t.subagent, null);
  assert.deepEqual(t.otherCalls, [{ toolUseId: 'c6b', agentId: null, agentIdSource: null, spawnFailed: null, injected: true, load: ['read-endpoints'] }]);
  assert.ok(t.warnings.some((w) => w.includes('first-prompt fallback is not used')));
  assert.deepEqual(run.totals.targetSkillLoaded, { yes: 0, measured: 0, of: 6 });
});

test('namespaced Skill input, folder-only access, and the old "consider" event field', () => {
  const run = adHoc({
    calls: [['c4', tasksText.t04], ['c5', tasksText.t05], ['c1', tasksText.t01]],
    events: [
      { type: 'spawn_observed', taskId: 'c4', agentId: 'a4' }, { type: 'spawn_observed', taskId: 'c5', agentId: 'a5' }, { type: 'spawn_observed', taskId: 'c1', agentId: 'a1' },
      { type: 'skills', taskId: 'c4', injected: false, load: [], consider: [{ name: 'job-failure-runbook', probability: 0.4 }] },
    ],
    subagents: {
      a4: [userRow(tasksText.t04), toolRow('u1', 'Skill', { skill: 'project:periodic-job-contract' })],
      a5: [userRow(tasksText.t05), toolRow('u1', 'Glob', { pattern: '.claude/skills/domain-failure-types/*' }), toolRow('u2', 'Bash', { command: 'ls .claude/skills/domain-failure-types' })],
      a1: [userRow(tasksText.t01), toolRow('u1', 'Bash', { command: 'cd .claude/skills && cat partner-file-exports/SKILL.md' }), toolRow('u2', 'Bash', { command: 'cat .claude/skills/*/SKILL.md' })],
    },
  });
  const row = (id) => run.tasks.find((t) => t.id === id);
  assert.deepEqual(row('t04').subagent.loadedSkills, [{ name: 'periodic-job-contract', via: 'Skill', callIndex: 0, raw: 'project:periodic-job-contract' }]);
  assert.equal(row('t04').subagent.targetSkillLoaded, true);
  assert.deepEqual(row('t04').hook.consider, ['job-failure-runbook']);
  assert.ok(!row('t04').warnings.some((w) => w.includes('not in the project catalog')));
  // the target's folder was listed, never read: neither "loaded" nor "not loaded"
  assert.equal(row('t05').subagent.targetSkillLoaded, null);
  assert.deepEqual(row('t05').subagent.loadedSkills, []);
  assert.deepEqual(row('t05').subagent.skillFolderMentions.map((m) => [m.name, m.via]), [['domain-failure-types', 'Glob'], ['domain-failure-types', 'Bash']]);
  assert.ok(row('t05').warnings.some((w) => w.includes('target skill load not determined')));
  assert.equal(row('t01').subagent.targetSkillLoaded, true);
  assert.equal(row('t01').subagent.targetSkillLoadedVia, 'Bash');
  assert.deepEqual(row('t01').subagent.skillFolderMentions, [{ name: null, via: 'Bash', callIndex: 1 }]);
  assert.deepEqual(run.totals.targetSkillLoaded, { yes: 2, measured: 2, of: 6 });
  assert.deepEqual(run.totals.targetSkillLoadedVia, { Skill: 1, Read: 0, Bash: 1 });
});

test('one Agent call carrying two tasks: one subagent, counted once in the totals', () => {
  const run = adHoc({
    calls: [['c37', `${tasksText.t03}\n\n${tasksText.t07}`]],
    events: [{ type: 'spawn_observed', taskId: 'c37', agentId: 'a37' }],
    subagents: { a37: [userRow(`${tasksText.t03}\n\n${tasksText.t07}`), toolRow('u1', 'Edit', { file_path: 'src/util/phone.mjs' }, { input_tokens: 7, output_tokens: 3 }), toolRow('u2', 'Bash', { command: 'node --test' })] },
  });
  assert.deepEqual(run.tasks.filter((t) => t.agentId === 'a37').map((t) => t.id), ['t03', 't07']);
  assert.deepEqual(run.totals.subagentToolCalls, { sum: 2, measured: 1, of: 7 });
  assert.deepEqual(run.totals.subagentTokens, { sum: 10, measured: 1, of: 7 });
  assert.ok(run.warnings.some((w) => w.includes('one Agent call (c37) carries the text of 2 tasks')));
  assert.ok(run.warnings.some((w) => w.includes('one subagent (a37) is attributed to 2 tasks')));
});

test('a task blocked by another task\'s broken file is carried into the arm file and the table', () => {
  const dir = project([['reference', 't04'], ['reference', 't02']]);
  writeFileSync(join(dir, 'src/lockers/door-watch.mjs'), 'export function doorNeedsAlert( {\n');
  const empty = temp();
  const run = analyze({ arm: 'B', project: dir, stateDir: empty, transcripts: empty });
  const t = run.tasks.find((row) => row.id === 't04');
  assert.deepEqual([t.check.done, t.check.convention, t.check.blockedBy], [true, true, ['t02']]);
  assert.deepEqual(run.totals.blockedByOtherTask, [{ id: 't04', blockedBy: ['t02'] }]);
  assert.match(render(compare(run, run)), /Blocked by another task's file[\s\S]*t04 B: t02/);
});

test('control: false injection and writes outside the task paths are reported', () => {
  const t = task('t03');
  assert.equal(t.hook.injected, true);
  assert.deepEqual(t.hook.load, ['repo-tour']);
  assert.equal(t.agentIdSource, 'main_tool_result');
  assert.equal(t.subagent.targetSkillLoaded, null);
  assert.deepEqual(t.subagent.loadedSkills.map((entry) => entry.name), ['repo-tour', 'not-a-project-skill']);
  assert.deepEqual(t.subagent.outOfScopeWrites, ['package.json', '/elsewhere/notes.txt']);
  assert.ok(t.warnings.some((w) => w.includes('not in the project catalog')));
  assert.deepEqual(result.totals.injectedOnControls, { yes: 1, measured: 1, of: 2 });
  assert.deepEqual(result.totals.injectedOnSkillTasks, { yes: 1, measured: 3, of: 6 });
});

test('empty inputs give nulls and warnings, not a crash', () => {
  const empty = temp();
  const bare = analyze({ arm: 'A', project: project([]), stateDir: empty, transcripts: empty });
  assert.equal(bare.tasks.length, 8);
  assert.ok(bare.tasks.every((row) => row.delegation === null && row.subagent === null && row.hook.injected === null));
  assert.deepEqual(bare.totals.primary_conventionPassed, { yes: 0, measured: 6, of: 6 });
  assert.deepEqual(bare.totals.targetSkillLoaded, { yes: 0, measured: 0, of: 6 });
  assert.equal(bare.totals.subagentTokens.sum, null);
  assert.equal(bare.delegationsInTaskOrder, null);
  assert.ok(bare.warnings.some((w) => w.includes('no sessions folder')));
  assert.ok(bare.warnings.some((w) => w.includes('no Main transcript')));
});

test('compare prints a paired table and totals', () => {
  const empty = temp();
  const a = analyze({ arm: 'A', project: project([['naive', 't01'], ['reference', 't02']]), stateDir: empty, transcripts: empty });
  const paired = compare(a, result);
  assert.deepEqual(paired.paired, { pairsMeasured: 6, bothPass: 0, onlyA: 1, onlyB: 1, neither: 4 });
  const text = render(paired);
  assert.match(text, /PRIMARY convention passed, skill tasks\s+A: 1\/6\s+B: 1\/6/);
  assert.match(text, /^t01\s+skill\s+en\s+partner-file-exports\s+no\s+yes/m);
  assert.match(text, /only A 1, only B 1, neither 4/);
  assert.match(text, /No significance claim/);
});

test('command line: analyze writes the file, compare reads it', () => {
  const dir = temp();
  const outA = join(dir, 'a.json');
  const run = spawnSync(process.execPath, [join(here, 'analyze.mjs'), '--arm', 'A', '--project', projectDir, '--state-dir', stateDir,
    '--transcripts', join(here, 'analyze-fixtures', 'transcripts'), '--out', outA], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(outA, 'utf8')).arm, 'A');
  const table = spawnSync(process.execPath, [join(here, 'compare.mjs'), '--a', outA, '--b', outA], { encoding: 'utf8' });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /Paired convention outcome over 6 measured pair/);
  const bad = spawnSync(process.execPath, [join(here, 'analyze.mjs'), '--arm', 'A'], { encoding: 'utf8' });
  assert.equal(bad.status, 64);
});

test('main-prompt.txt is exactly what tasks.json generates', () => {
  const run = spawnSync(process.execPath, [join(here, 'build-main-prompt.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
