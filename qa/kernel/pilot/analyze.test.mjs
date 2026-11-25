// Test of analyze.mjs and compare.mjs against synthetic state/transcripts.   node --test analyze.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(t.delegation, { toolUseId: 'toolu_t01', subagentType: 'general-purpose', promptVerbatim: true, agentCalls: 1 });
  assert.equal(t.hook.injected, true);
  assert.deepEqual(t.hook.load, ['partner-file-exports']);
  assert.deepEqual(t.hook.consider, ['carrier-csv-intake']);
  assert.deepEqual(t.hook.route, { profile: 'implement', model: 'model-x', effort: 'medium' });
  assert.equal(t.agentId, 'a01');
  assert.equal(t.agentIdSource, 'spawn_observed');
  assert.equal(t.subagent.toolCalls, 4);
  assert.deepEqual(t.subagent.toolNames, { Skill: 1, Read: 1, Write: 2 });
  assert.deepEqual(t.subagent.loadedSkills, [{ name: 'partner-file-exports', via: 'Skill', callIndex: 0 }]);
  assert.equal(t.subagent.targetSkillLoaded, true);
  assert.equal(t.subagent.targetLoadedBeforeFirstWrite, true);
  assert.equal(t.subagent.promptHadSkillsBlock, true);
  assert.deepEqual(t.subagent.promptBlockLoad, ['partner-file-exports']);
  // msg_1 appears on two lines with the same usage and is counted once
  assert.deepEqual(t.subagent.tokens, { input: 650, output: 510, cacheRead: 9500, cacheCreation: 60, messages: 4, total: 10720 });
  assert.equal(t.subagent.wallMs, 42000);
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
  assert.ok(t.warnings.some((w) => w.includes('no spawn_observed event')));

  const dup = task('t04');
  assert.equal(dup.delegation.toolUseId, 'toolu_t04a');
  assert.equal(dup.delegation.agentCalls, 2);
  assert.equal(dup.hook.skillsEvent, true);
  assert.equal(dup.hook.injected, null); // "injected" was not a boolean
  assert.equal(dup.hook.load, null);
  assert.equal(dup.subagent, null);
  assert.ok(dup.warnings.some((w) => w.includes('2 Agent calls')));
  assert.ok(dup.warnings.some((w) => w.includes('no boolean "injected"')));

  const none = task('t05');
  assert.equal(none.delegation, null);
  assert.deepEqual(none.hook, { skillsEvent: null, injected: null, load: null, consider: null, mode: null, status: null, route: null });
  assert.equal(none.subagent, null);
  assert.ok(none.warnings.some((w) => w.includes('no Agent call')));

  const lost = task('t06');
  assert.equal(lost.agentId, 'a-missing');
  assert.equal(lost.subagent, null);
  assert.equal(lost.hook.injected, null);
  assert.ok(lost.warnings.some((w) => w.includes('agent-a-missing.jsonl not found')));

  assert.deepEqual(result.totals.targetSkillLoaded, { yes: 2, measured: 2, of: 6 });
  assert.deepEqual(result.totals.subagentTokens, { sum: 10760, measured: 2, of: 8 });
  assert.ok(result.warnings.some((w) => w.includes('unparsable event file')));
  assert.ok(result.warnings.some((w) => w.includes('event without a type')));
  assert.ok(result.warnings.some((w) => w.includes('unparsable line')));
  assert.ok(result.warnings.some((w) => w.includes('match no task') && w.includes('toolu_other')));
  assert.equal(result.agentCallsInMain, 7);
  assert.equal(result.delegationsInTaskOrder, true);
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
  assert.deepEqual(result.totals.injectedOnSkillTasks, { yes: 1, measured: 2, of: 6 });
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
