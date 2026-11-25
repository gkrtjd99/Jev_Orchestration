#!/usr/bin/env node
// Self-test of the checker. Works on temporary copies only; the template and the fixtures are never written.
//   node checkers/selftest.mjs
// Asserts:
//   1. the untouched template: no task is done, nothing is unattributed
//   2. all twelve reference solutions together: every task passes, nothing is unattributed, the template's own
//      tests still pass, two runs print the same bytes, and the project copy is not written by the checker
//   3. every flawed solution: its task does not pass, `done` and the failing checks are exactly what
//      fixtures/flawed/manifest.json says (including the hidden check written for that flaw), and no other task moves
//   4. one reference solution at a time: only its own task is done and passes
//   5. every fixture touches only files its task is allowed to touch; every task has a reference and two flawed variants
//   6. a project module that throws on import, exits the process or never finishes does not crash the checker
//   7. files outside every task's allowed paths are reported; .claude/ and new test files are not
//   8. the result does not depend on the time zone of the machine
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject, loadTasks, TEMPLATE_DIR } from './check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');
const tasks = loadTasks();
const manifest = JSON.parse(readFileSync(join(fixtures, 'flawed', 'manifest.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'routing-exp-selftest-'));
let copies = 0, assertions = 0;
const ok = (value, message) => { assert.ok(value, message); assertions += 1; };
const equal = (actual, expected, message) => { assert.deepStrictEqual(actual, expected, message); assertions += 1; };

function copyOf(...overlays) {
  const dir = join(work, `project-${copies += 1}`);
  cpSync(TEMPLATE_DIR, dir, { recursive: true });
  for (const overlay of overlays) cpSync(overlay, dir, { recursive: true });
  return dir;
}
function filesOf(root, relativeTo = root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
    ? filesOf(join(root, entry.name), relativeTo) : [relative(relativeTo, join(root, entry.name))])).sort();
}
const treeHash = (root) => createHash('sha256').update(filesOf(root).map((file) => `${file}\0${createHash('sha256').update(readFileSync(join(root, file))).digest('hex')}`).join('\n')).digest('hex');
const byId = (result) => Object.fromEntries(result.tasks.map((task) => [task.id, task]));
const reference = (id) => join(fixtures, 'reference', id);
const section = (title) => console.log(`\n== ${title}`);

try {
  equal(tasks.map((task) => task.id), Array.from({ length: 12 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`), 'twelve tasks t01..t12');

  section('1. untouched template');
  {
    const result = checkProject({ project: copyOf() });
    equal(result.tasks.map((task) => task.id), tasks.map((task) => task.id));
    for (const task of result.tasks) { ok(task.done === false, `${task.id} must not be done on the template`); ok(task.passed === false); ok(task.details.length > 0); }
    equal(result.unattributedChanges, []);
    console.log(`all ${result.tasks.length} tasks: done=false passed=false, unattributedChanges=[]`);
  }

  section('2. all reference solutions');
  {
    const project = copyOf(...tasks.map((task) => reference(task.id)));
    const before = treeHash(project);
    const first = checkProject({ project });
    for (const task of first.tasks) {
      ok(task.done === true && task.passed === true, `${task.id} reference must pass: ${task.details.filter((d) => !d.ok).map((d) => d.name).join(' | ')}`);
      ok(task.details.some((d) => d.name.startsWith('basic: ')) && task.details.some((d) => d.name.startsWith('hidden: ')), `${task.id} has basic and hidden checks`);
      console.log(`${task.id} done=true passed=true (${task.details.filter((d) => d.name.startsWith('basic: ')).length} basic, ${task.details.filter((d) => d.name.startsWith('hidden: ')).length} hidden checks)`);
    }
    equal(first.unattributedChanges, []);
    equal(JSON.stringify(checkProject({ project })), JSON.stringify(first), 'two runs give the same result');
    equal(treeHash(project), before, 'the checker does not write the project');
    const own = spawnSync(process.execPath, ['--test'], { cwd: project, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TZ: 'UTC' } });
    ok(own.status === 0, `the template's own tests must pass with every reference applied:\n${own.stdout}\n${own.stderr}`);
    const count = /^ℹ pass (\d+)$/m.exec(own.stdout)?.[1];
    console.log(`template's own test suite with all references applied: exit 0, pass ${count}`);
    const plain = spawnSync(process.execPath, ['--test'], { cwd: copyOf(), encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TZ: 'UTC' } });
    ok(plain.status === 0, 'the untouched template passes its own tests');
    console.log(`template's own test suite untouched: exit 0, pass ${/^ℹ pass (\d+)$/m.exec(plain.stdout)?.[1]}`);
  }

  section('3. flawed solutions');
  {
    const seen = new Map();
    for (const entry of manifest.variants) {
      const result = byId(checkProject({ project: copyOf(join(fixtures, 'flawed', entry.task, entry.variant)) }));
      const task = result[entry.task];
      const fails = task.details.filter((d) => !d.ok).map((d) => d.name);
      ok(task.passed === false, `${entry.task}/${entry.variant} must not pass`);
      equal(task.done, entry.done, `${entry.task}/${entry.variant} done`);
      equal(fails, entry.fails, `${entry.task}/${entry.variant} failing checks`);
      ok(entry.intended.startsWith('hidden: ') && fails.includes(entry.intended), `${entry.task}/${entry.variant} fails its intended hidden check`);
      ok(entry.done === false || fails.every((name) => name.startsWith('hidden: ')), `${entry.task}/${entry.variant}: done means only hidden checks fail`);
      for (const other of tasks.filter((t) => t.id !== entry.task)) ok(result[other.id].done === false, `${other.id} must stay untouched by ${entry.variant}`);
      seen.set(entry.task, (seen.get(entry.task) ?? 0) + 1);
      console.log(`${entry.task} ${entry.variant}: done=${task.done} passed=false, fails ${fails.length} check(s), intended "${entry.intended.slice(8)}"`);
    }
    const onDisk = readdirSync(join(fixtures, 'flawed'), { withFileTypes: true }).filter((e) => e.isDirectory())
      .flatMap((e) => readdirSync(join(fixtures, 'flawed', e.name)).map((variant) => `${e.name}/${variant}`)).sort();
    equal(manifest.variants.map((v) => `${v.task}/${v.variant}`).sort(), onDisk, 'manifest lists every flawed fixture');
    for (const task of tasks) ok((seen.get(task.id) ?? 0) >= 2, `${task.id} needs at least two flawed variants`);
    ok(manifest.variants.filter((v) => v.done).length >= 24, 'most flawed variants are done but not passed');
  }

  section('4. one reference at a time');
  for (const task of tasks) {
    const result = checkProject({ project: copyOf(reference(task.id)) });
    for (const other of result.tasks) {
      equal([other.done, other.passed], other.id === task.id ? [true, true] : [false, false], `reference ${task.id} alone: ${other.id}`);
    }
    equal(result.unattributedChanges, []);
    console.log(`reference ${task.id} alone: only ${task.id} done and passed`);
  }

  section('5. fixtures stay inside their task\'s allowed paths');
  {
    let files = 0;
    for (const task of tasks) {
      const roots = [reference(task.id), ...manifest.variants.filter((v) => v.task === task.id).map((v) => join(fixtures, 'flawed', v.task, v.variant))];
      for (const root of roots) for (const file of filesOf(root)) { ok(task.allowedPaths.includes(file), `${root}: ${file} is outside ${task.id}'s allowed paths`); files += 1; }
    }
    const owners = new Map();
    for (const task of tasks) for (const path of task.allowedPaths) { ok(!owners.has(path), `${path} is allowed for two tasks`); owners.set(path, task.id); }
    console.log(`${files} fixture files, all inside allowedPaths; no path is allowed for two tasks`);
  }

  section('6. broken project modules');
  {
    const others = tasks.filter((task) => !['t05', 't01', 't09'].includes(task.id)).map((task) => reference(task.id));
    const project = copyOf(...others);
    writeFileSync(join(project, 'src/util/duration.mjs'), "throw new Error('boom on import');\n");
    writeFileSync(join(project, 'src/api/paginate.mjs'), "process.exit(7);\nexport function paginate() {}\nexport function paginateAfter() {}\n");
    mkdirSync(join(project, 'src/reports'), { recursive: true });
    writeFileSync(join(project, 'src/reports/csv.mjs'), 'export function toCsv() { for (;;) {} }\n');
    const result = byId(checkProject({ project, probeTimeoutMs: 4000 }));
    for (const id of ['t05', 't01', 't09']) { ok(result[id].done === false && result[id].passed === false, `${id} with a broken module`); ok(result[id].details.length > 0); }
    for (const task of tasks.filter((t) => !['t05', 't01', 't09'].includes(t.id))) ok(result[task.id].passed === true, `${task.id} is unaffected by other broken modules`);
    console.log('module that throws on import (t05), exits the process (t01), never returns (t09): done=false each, the other 9 tasks pass, checker returned normally');
  }

  section('7. unattributed changes');
  {
    const project = copyOf(reference('t05'));
    writeFileSync(join(project, 'README.md'), 'changed\n');
    writeFileSync(join(project, 'src/extra.mjs'), 'export const x = 1;\n');
    writeFileSync(join(project, 'test/duration.test.mjs'), "import test from 'node:test';\ntest('x', () => {});\n");
    writeFileSync(join(project, 'test/app.test.mjs'), '// emptied\n');
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, '.claude/settings.json'), '{}\n');
    rmSync(join(project, 'src/reports/attendance.mjs'));
    equal(checkProject({ project }).unattributedChanges, [
      { path: 'README.md', change: 'modified' }, { path: 'src/extra.mjs', change: 'added' },
      { path: 'src/reports/attendance.mjs', change: 'deleted' }, { path: 'test/app.test.mjs', change: 'modified' }]);
    console.log('README.md modified, src/extra.mjs added, src/reports/attendance.mjs deleted, test/app.test.mjs modified are reported; .claude/ and a new test file are not');
  }

  section('8. machine time zone');
  {
    const project = copyOf(join(fixtures, 'flawed', 't10', 'machine-local-time'));
    const cli = (TZ) => spawnSync(process.execPath, [join(here, 'check.mjs'), '--project', project], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TZ } });
    const [newYork, seoul] = [cli('America/New_York'), cli('Asia/Seoul')];
    ok(newYork.status === 0 && seoul.status === 0, 'CLI exits 0');
    equal(newYork.stdout, seoul.stdout, 'same output under two machine time zones');
    const parsed = JSON.parse(newYork.stdout);
    equal(Object.keys(parsed), ['tasks', 'unattributedChanges']);
    equal(Object.keys(parsed.tasks[0]), ['id', 'done', 'passed', 'details']);
    ok(byId(parsed).t10.done === false, 'a fix that only works in the machine\'s own zone is not done');
    console.log('check.mjs CLI under TZ=America/New_York and TZ=Asia/Seoul: identical output; machine-local fix stays done=false');
  }

  console.log(`\nSELFTEST PASSED (${assertions} assertions, ${copies} temporary project copies, ${manifest.variants.length} flawed variants)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
