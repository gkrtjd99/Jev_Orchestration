// Test of analyze.mjs and compare.mjs against synthetic state/transcripts.   node --test analyze.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyze, sanitize } from './analyze.mjs';
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
function transcriptsFor(projectDir, set = 'transcripts') {
  const dir = temp();
  cpSync(join(here, 'analyze-fixtures', set), dir, { recursive: true });
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

// ---------------------------------------------------------------------------------------------------------
// The row shapes of the real sessions (analyze-fixtures/real-shape, synthetic content): request-log copies,
// a refused Agent attempt followed by the launched call, meta files, the skill_listing attachment.
const realProject = project([['reference', 't01'], ['reference', 't03'], ['reference', 't04']]);
const real = analyze({ arm: 'R', project: realProject, stateDir: join(here, 'analyze-fixtures', 'real-shape', 'state'), transcripts: transcriptsFor(realProject, join('real-shape', 'transcripts')) });
const realTask = (id) => real.tasks.find((row) => row.id === id);

test('real shape: a refused attempt is not the delegation; request-log copies are not counted', () => {
  assert.equal(real.agentCallsInMain, 5); // 5 Agent tool_use ids; the api-request-blob copies add none
  const t = realTask('t01');
  assert.deepEqual(t.delegation, { toolUseId: 'toolu_r01b', subagentType: 'jev4_implement_light_x', promptVerbatim: false, agentCalls: 2, spawnFailed: false });
  assert.deepEqual(t.delegationDetail, { refusedAttempts: 1, launchedCalls: 1, scoredCallIndex: 1, scoredCallOutcome: 'launched',
    firstCallPromptVerbatim: true, firstCallSubagentType: 'general-purpose', scoredPromptIsHookRewrite: true });
  assert.deepEqual(t.attempts.map((attempt) => [attempt.toolUseId, attempt.scored, attempt.outcome, attempt.refusalCode]),
    [['toolu_r01a', false, 'refused', 'classifier:auto-mode:unavailable'], ['toolu_r01b', true, 'launched', null]]);
  assert.deepEqual(t.attempts[0].hookRewrite, { subagentType: 'jev4_implement_light_x', routingBlocks: 1, skillsBlocks: 1 });
  assert.deepEqual(t.attempts[1].promptBlocks, { routing: 1, skills: 1 });
  assert.deepEqual(t.attempts[1].hookRewrite, { subagentType: 'jev4_implement_standard_y', routingBlocks: 2, skillsBlocks: 2 });
  assert.deepEqual(t.otherCalls, [{ toolUseId: 'toolu_r01a', agentId: null, agentIdSource: null, spawnFailed: null, injected: true, load: ['partner-file-exports'] }]);
  assert.equal(t.agentId, 'ar01');
  assert.equal(t.agentIdSource, 'spawn_observed');
  // the hook events are those of the scored call, never of the refused attempt
  assert.equal(t.hook.injected, true);
  assert.deepEqual(t.hook.route, { profile: 'jev4_implement_standard_y', model: 'large', effort: 'high' });
  assert.deepEqual(t.hookDetail.load, [{ name: 'partner-file-exports', probability: 0.98 }]);
  assert.deepEqual(t.hookDetail.suggest, []);
  assert.deepEqual(t.attempts[0].hookDetail.suggest, [{ name: 'carrier-csv-intake', probability: 0.6 }]);
  assert.deepEqual(t.attempts[0].target, { probability: 0.97, stage: 'loaded' });
  assert.deepEqual(t.targetJudged, { probability: 0.98, stage: 'loaded' });
  assert.deepEqual(t.hookDetail.judge, { requests: 2, decisionsLogged: 2, latencyMsSum: 585, latencyMsMax: 295, cached: false });
  assert.deepEqual(t.hookDetail.route, { profile: 'jev4_implement_standard_y', model: 'large', effort: 'high', tier: 'standard', decisionReason: 'synthetic_reason', latencyMs: 470, hookMs: 500, cached: false });
  // what ran is what the harness recorded, not the route of the second rewrite
  assert.deepEqual(t.effective, { agentType: 'jev4_implement_light_x', model: 'model-light', effort: null, scoredCallRewriteApplied: false });
  // ... and the hook decision that reached the subagent is the refused attempt's, not the scored call's second run
  assert.deepEqual(t.hookApplied, { source: 'refused_attempt', attemptIndex: 0, injected: true, need: t.attempts[0].hookDetail.need,
    load: [{ name: 'partner-file-exports', probability: 0.97 }], suggest: [{ name: 'carrier-csv-intake', probability: 0.6 }], target: { probability: 0.97, stage: 'loaded' },
    route: { profile: 'jev4_implement_light_x', model: t.attempts[0].hookDetail.route.model, effort: t.attempts[0].hookDetail.route.effort }, routeDeferred: null });
  assert.ok(!t.warnings.some((w) => w.includes('hookApplied')));
  assert.ok(t.warnings.some((w) => w.includes('refused by the harness before the tool ran')));
  assert.ok(t.warnings.some((w) => w.includes('second rewrite and its route were not applied')));
  assert.ok(t.warnings.some((w) => w.includes('ran as jev4_implement_light_x')));
  assert.ok(!t.warnings.some((w) => w.includes('otherCalls')));
  assert.equal(real.delegationsInTaskOrder, true);
  assert.ok(!real.warnings.some((w) => w.includes('match no task')));
});

test('real shape: subagent tool calls, load order, listing, tokens and wall time', () => {
  const s = realTask('t01').subagent;
  assert.equal(s.toolCalls, 6); // the api-request-blob row repeats two of them under the same ids
  assert.deepEqual(s.toolNames, { Bash: 3, Skill: 1, Write: 1, SubagentHandback: 1 });
  assert.deepEqual([s.toolCallsWithoutHandback, s.handbackCalls, s.toolErrors], [5, 1, 1]);
  assert.deepEqual(s.loadedSkills, [{ name: 'partner-file-exports', via: 'Skill', callIndex: 1 }]);
  assert.deepEqual([s.targetLoadCallIndex, s.firstWriteCallIndex, s.firstBashWriteLikeCallIndex, s.bashWriteLikeCommands], [1, 3, 2, 1]);
  assert.deepEqual([s.targetLoadedBeforeFirstWrite, s.targetLoadedBeforeAnyWrite], [true, true]);
  assert.deepEqual(s.skillListing, { found: true, source: 'attachment:skill_listing', catalogNamesListed: 60, catalogSize: 60 });
  assert.deepEqual(s.listingDetail, { totalNamesListed: 62, catalogNamesWithDescription: 60, nonCatalogNamesListed: 2, nonCatalogNames: ['plugin-x:plugin-skill', 'user-level-skill'] });
  assert.equal(s.targetListedToSubagent, true);
  // the first prompt is the delegation text, not the harness reminder that follows it
  assert.deepEqual([s.firstPromptContainsTask, s.promptHadSkillsBlock], [true, true]);
  assert.deepEqual([s.promptBlockLoad, s.promptBlockConsider, s.promptBlockCounts], [['partner-file-exports'], ['carrier-csv-intake'], { skills: 1, routing: 1 }]);
  assert.deepEqual(s.tokens, { input: 12, output: 1050, cacheRead: 230900, cacheCreation: 11400, messages: 6, assistantMessages: 6, total: 243362 });
  assert.equal(s.wallMs, 51000);
  assert.deepEqual(s.timestampCoverage, { rows: 19, withTimestamp: 19 }); // request-log rows are not transcript rows
  assert.deepEqual(s.filesWritten, ['test/overdue.test.mjs']);
  assert.deepEqual(s.skillSearch, { mcpSkillToolCalls: 0, mcpSkillTools: {}, toolSearchForSkill: 0, nonCatalogSkillCalls: [] });
  assert.deepEqual(s.models, ['model-light']);
  assert.ok(realTask('t01').warnings.some((w) => w.includes('1 Bash command(s) look like file writes')));
});

test('real shape: user-level skill search and a rejected tool call are reported per task', () => {
  const t = realTask('t03');
  assert.deepEqual(t.subagent.skillSearch, { mcpSkillToolCalls: 1, mcpSkillTools: { 'mcp__skill-finder__search_skills': 1 }, toolSearchForSkill: 1, nonCatalogSkillCalls: ['user-level-skill'] });
  assert.deepEqual(t.subagent.rejectedToolCalls, [{ tool: 'plan_tool', reasonCode: 'hook:PreToolUse' }]);
  assert.equal(t.hook.injected, false);
  assert.equal(t.hookDetail.need, 0.09);
  assert.equal(t.subagent.promptHadSkillsBlock, false);
  assert.ok(t.warnings.some((w) => w.includes('not in the project catalog')));
  assert.deepEqual(real.totals.skillSearch, { tasksMeasured: 3, tasksUsingMcpSkillTool: ['t03'], tasksUsingToolSearchForSkill: ['t03'], tasksCallingNonCatalogSkill: ['t03'] });
});

test('real shape: a deferred route leaves one call, launched as Main sent it', () => {
  const t = realTask('t04');
  assert.deepEqual(t.delegation, { toolUseId: 'toolu_r04', subagentType: 'general-purpose', promptVerbatim: true, agentCalls: 1, spawnFailed: false });
  assert.deepEqual(t.delegationDetail, { refusedAttempts: 0, launchedCalls: 1, scoredCallIndex: 0, scoredCallOutcome: 'launched',
    firstCallPromptVerbatim: true, firstCallSubagentType: 'general-purpose', scoredPromptIsHookRewrite: null });
  assert.equal(t.hook.route, null);
  assert.equal(t.hookDetail.routeDeferred, 'selector_abstained');
  // need under the gate: nothing injected although the judge rated the target 0.93
  assert.deepEqual([t.hook.injected, t.hookDetail.need], [false, 0.4]);
  assert.deepEqual(t.targetJudged, { probability: 0.93, stage: 'need_gate' });
  assert.deepEqual(t.hookDetail.judge, { requests: 2, decisionsLogged: 1, latencyMsSum: 270, latencyMsMax: 270, cached: false });
  assert.deepEqual(t.effective, { agentType: null, model: 'model-main', effort: null, scoredCallRewriteApplied: null }); // no meta file
  // the hook rewrote nothing for this call, so its own events are the decision that applied
  assert.deepEqual([t.hookApplied.source, t.hookApplied.attemptIndex, t.hookApplied.injected, t.hookApplied.route, t.hookApplied.routeDeferred], ['scored_call', 0, false, null, 'selector_abstained']);
  assert.deepEqual([t.subagent.targetLoadCallIndex, t.subagent.targetLoadedBeforeAnyWrite], [0, true]);
});

test('real shape: run totals, judge cost and the Main session', () => {
  assert.deepEqual(real.totals.agentCalls, { all: 5, refusedBeforeRunning: 2, launched: 3, tasksWithSeveralLaunchedCalls: [] });
  assert.deepEqual(real.totals.injectedOnSkillTasks, { yes: 1, measured: 2, of: 6 });
  assert.deepEqual(real.totals.injectedOnControls, { yes: 0, measured: 1, of: 2 });
  assert.deepEqual(real.totals.blockInSubagentPrompt, { skillTasks: { yes: 1, measured: 2, of: 6 }, controls: { yes: 0, measured: 1, of: 2 } });
  assert.deepEqual(real.totals.targetLoadedAsFirstToolCall, { yes: 1, measured: 2, of: 6 });
  assert.deepEqual(real.totals.subagentTokenParts.output, { sum: 1050 + 50 + 20, measured: 3, of: 8 });
  assert.deepEqual(real.totals.effectiveProfiles, { 'jev4_implement_light_x / model-light': ['t01'], 'jev4_implement_standard_y / model-standard': ['t03'], '(unknown) / model-main': ['t04'] });
  assert.deepEqual(real.judge.byPoint['delegation.skills'], { decisions: 9, cached: 0, latencyMsSum: 2592, latencyMsMax: 310, providers: { jev: 9 } });
  assert.deepEqual(real.judge.byPoint['delegation.profile'].providers, { jev: 1, none: 1 });
  assert.deepEqual(real.judge.skills, { events: 5, requests: 10, latencyMsSum: 611 + 585 + 561 + 565 + 270, scoredCalls: { events: 3, requests: 6, latencyMsSum: 585 + 565 + 270 } });
  assert.equal(real.judge.tokens, null); // the decision log has no token field: unmeasured, not zero
  assert.deepEqual(real.judge.hookMsPerAgentCall, { sum: 1200 + 500 + 520 + 540, measured: 4, of: 5 });
  assert.ok(real.warnings.some((w) => w.includes('judge tokens are unmeasured')));
  const m = real.mainSession;
  assert.deepEqual([m.userPrompts, m.firstPromptEqualsMainPromptFile, m.firstPromptContainsMainPromptFile, m.firstPromptExtraChars], [1, false, true, 55]);
  assert.deepEqual(m.toolNames, { plan_tool: 1, Agent: 5 });
  assert.deepEqual([m.models, m.efforts, m.permissionModes], [['model-main'], ['medium'], ['auto']]);
  assert.deepEqual(m.tokens, { input: 14, output: 2200, cacheRead: 22000, cacheCreation: 220, messages: 7, assistantMessages: 7, total: 24434 });
  assert.equal(m.wallMs, 151000);
  assert.ok(m.wallMsAllRows >= m.wallMs);
  assert.deepEqual(real.totals.appliedInjectedOnSkillTasks, { yes: 1, measured: 2, of: 6 });
  assert.deepEqual(real.totals.appliedInjectedOnControls, { yes: 0, measured: 1, of: 2 });
  assert.deepEqual(real.totals.targetInAppliedLoad, { yes: 1, measured: 2, of: 6 });
  assert.deepEqual(real.totals.subagentApiTurns, { sum: 6 + realTask('t03').subagent.apiTurns + realTask('t04').subagent.apiTurns, measured: 3, of: 8 });
  assert.ok(real.warnings.some((w) => w.includes('contains main-prompt.txt word for word but is not equal')));
  assert.ok(real.warnings.some((w) => w.includes('state dir holds 2 sessions')));
});

test('when no call was launched the literal first-call rule still applies, and a meta file can name the subagent', () => {
  const dir = temp();
  const transcripts = join(dir, 'transcripts');
  mkdirSync(join(transcripts, 'subagents'), { recursive: true });
  mkdirSync(join(dir, 'state'), { recursive: true });
  const call = (id, prompt) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { prompt, subagent_type: 'general-purpose' } }] } });
  const refusal = (id) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'refused' }] }, permissionDecision: { decision: 'reject', reasonCode: 'x' } });
  writeFileSync(join(transcripts, 'main.jsonl'), [call('k5a', tasksText.t05), refusal('k5a'), call('k5b', tasksText.t05), refusal('k5b'), call('k6', tasksText.t06)].map((row) => JSON.stringify(row)).join('\n') + '\n');
  // wall time spans user / assistant / attachment rows only: the later "system" row and the request-log row do not stretch it
  const stamped = (row, second) => ({ ...row, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString() });
  writeFileSync(join(transcripts, 'subagents', 'agent-m6.jsonl'), [stamped(userRow('not the task text'), 0), stamped({ ...toolRow('u1', 'Skill', { skill: 'read-endpoints' }), effort: 'xhigh' }, 10),
    stamped({ type: 'system', subtype: 'turn_duration' }, 14), stamped({ type: 'api-request', requestId: 'r' }, 15)].map((row) => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(transcripts, 'subagents', 'agent-m6.meta.json'), JSON.stringify({ agentType: 'some-profile', model: 'model-z', toolUseId: 'k6' }));
  const run = analyze({ arm: 'X', project: join(here, 'template'), stateDir: join(dir, 'state'), transcripts });
  const t5 = run.tasks.find((row) => row.id === 't05');
  assert.equal(t5.delegation.toolUseId, 'k5a');
  assert.deepEqual([t5.delegationDetail.refusedAttempts, t5.delegationDetail.launchedCalls, t5.delegationDetail.scoredCallOutcome], [2, 0, 'refused']);
  assert.equal(t5.subagent, null); // unmeasured, not a failure
  const t6 = run.tasks.find((row) => row.id === 't06');
  assert.deepEqual([t6.agentId, t6.agentIdSource], ['m6', 'subagent_meta']);
  assert.deepEqual(t6.effective, { agentType: 'some-profile', model: 'model-z', effort: 'xhigh', scoredCallRewriteApplied: null });
  assert.deepEqual([t6.subagent.efforts, t6.subagent.apiTurns, t6.subagent.wallMs], [['xhigh'], 1, 10000]);
  assert.equal(t5.hookApplied, null); // nothing launched: no decision reached a subagent
  assert.equal(t6.subagent.targetSkillLoaded, true);
});

test('the sanitized copy keeps numbers and names and drops paths and ids', () => {
  const clean = sanitize(real);
  const text = JSON.stringify(clean);
  assert.equal(clean.sanitized, true);
  assert.equal(clean.inputs, undefined);
  for (const leak of ['toolu_', 'ar01', 'ar03', 'ar04', 's-run', 's-setup', realProject, tmpdir(), here]) assert.ok(!text.includes(leak), `sanitized output still holds ${leak}`);
  const t = clean.tasks.find((row) => row.id === 't01');
  assert.deepEqual([t.delegation.toolUseId, t.agentId, t.attempts.map((attempt) => attempt.toolUseId)], ['t01-call2', 't01-subagent', ['t01-call1', 't01-call2']]);
  assert.deepEqual(clean.sessions.map((entry) => entry.session), ['session-1', 'session-2']);
  assert.deepEqual(t.subagent.tokens, realTask('t01').subagent.tokens);
  // the owner's user-level / plugin skill names are reduced to a count; only skill-search skills keep their name
  assert.deepEqual(t.subagent.listingDetail, { totalNamesListed: 62, catalogNamesWithDescription: 60, nonCatalogNamesListed: 2, nonCatalogSearchSkillNames: [] });
  assert.ok(!text.includes('"nonCatalogNames"') && !text.includes('plugin-x:plugin-skill'));
  const withSearch = JSON.parse(JSON.stringify(real));
  withSearch.tasks[0].subagent.listingDetail.nonCatalogNames = ['find-skills', 'other-skill', 'plugin-y:using-skill-rag'];
  assert.deepEqual(sanitize(withSearch).tasks[0].subagent.listingDetail.nonCatalogSearchSkillNames, ['find-skills', 'plugin-y:using-skill-rag']);
  assert.deepEqual(t.checkDetails, realTask('t01').checkDetails);
  assert.ok(t.checkDetails.length > 0 && t.checkDetails.every((entry) => typeof entry.check === 'string' && typeof entry.ok === 'boolean'));
  // a write outside the project keeps no path
  const outside = sanitize(result).tasks.find((row) => row.id === 't03').subagent.outOfScopeWrites;
  assert.deepEqual(outside, ['package.json', '<path>']);
});

test('compare: delegation, load order, judge and paired cost sections', () => {
  const paired = compare(real, real);
  assert.deepEqual(paired.differences.tokens.all, { pairsMeasured: 3, of: 8, a: 243362 + 6160 + 1174, b: 243362 + 6160 + 1174, diff: 0, bLower: 0, bHigher: 0 });
  assert.equal(paired.differences.tokens.sameSetup.pairsMeasured, 2); // t04 has no recorded agent type on either side
  const text = render(paired);
  assert.match(text, /^t01\s+1 \+ 1\s+1 \+ 1\s+jev4_implement_light_x \/ model-light/m);
  assert.match(text, /^t04\s+0 \+ 1\s+0 \+ 1\s+- \/ model-main/m);
  assert.match(text, /^t01\s+R\s+yes \(60\/62\)\s+Skill\s+1\s+3\s+2\s+yes\s+yes/m);
  assert.match(text, /^t04\s+R\s+launched\s+0\.4\s+no\s+0\.93 need_gate/m);
  assert.match(text, /delegation\.skills 9 decisions, latency sum 2592 ms/);
  assert.match(text, /Judge tokens: - \(not recorded\)/);
  assert.match(text, /MCP skill tool in 1 task\(s\) \[t03\]/);
  assert.match(text, /t01 R: 2 Agent calls \(1 refused before running, 1 launched; launched input is exactly the hook's rewrite: yes\)/);
  // arm differences come before the table; the decision that reached the subagent is marked; cost is labelled descriptive
  assert.ok(text.startsWith('Read first: differences between the arms other than the skill block'));
  assert.match(text, /none found in agent type, model or effort/);
  assert.match(text, /^t01\s+R\s+refused\s.*\syes$/m);
  assert.match(text, /^t01\s+R\s+launched\s.*\sno$/m);
  assert.match(text, /no direction is attributed to the block/);
  const other = JSON.parse(JSON.stringify(real));
  other.arm = 'S';
  other.tasks[0].effective.effort = 'xhigh';
  const unlike = compare(real, other);
  assert.deepEqual(unlike.armDifferences.map((entry) => entry.id), ['t01']);
  assert.equal(unlike.differences.tokens.sameSetup.pairsMeasured, 1);
  assert.match(render(unlike), /^ {2}t01: R ran as jev4_implement_light_x \/ model-light \/ effort -; S ran as jev4_implement_light_x \/ model-light \/ effort xhigh\. Not a like-for-like pair/m);
  // an arm file written before schema 3 still renders
  const old = JSON.parse(JSON.stringify(real));
  delete old.judge; delete old.mainSession;
  for (const row of old.tasks) { delete row.delegationDetail; delete row.attempts; delete row.hookDetail; delete row.effective; }
  assert.match(render(compare(old, old)), /PRIMARY convention passed/);
});

test('main-prompt.txt is exactly what tasks.json generates', () => {
  const run = spawnSync(process.execPath, [join(here, 'build-main-prompt.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
