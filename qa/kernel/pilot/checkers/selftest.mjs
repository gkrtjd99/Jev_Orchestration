#!/usr/bin/env node
// Self-test of the checker against the fixtures. Builds temp copies of template/, applies fixture sets and
// asserts the verdicts. Exits non-zero on the first set of failures. No network; temp folders are removed.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject } from './check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pilot = join(here, '..');
const template = join(pilot, 'template');
const fixtures = join(pilot, 'fixtures');
const { tasks } = JSON.parse(readFileSync(join(pilot, 'tasks.json'), 'utf8'));
const skillIds = tasks.filter((t) => t.kind === 'skill').map((t) => t.id);
const controlIds = tasks.filter((t) => t.kind === 'control').map((t) => t.id);

const temps = [];
function project(setName, ids) {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-selftest-'));
  temps.push(dir);
  cpSync(template, dir, { recursive: true });
  for (const id of ids) {
    const from = join(fixtures, setName, id);
    if (!existsSync(from)) throw new Error(`missing fixture ${setName}/${id}`);
    cpSync(from, dir, { recursive: true });
  }
  return dir;
}

let failures = 0;
let assertions = 0;
function expect(label, actual, wanted) {
  assertions += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(wanted);
  if (!ok) {
    failures += 1;
    console.log(`  FAIL ${label}: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(wanted)}`);
  }
  return ok;
}
const byId = (result) => Object.fromEntries(result.tasks.map((t) => [t.id, t]));
const row = (t) => `${t.id} done=${t.done} convention=${t.convention}`;
const failed = (t) => t.details.filter((d) => !d.ok).map((d) => d.check).join(',');
const projectTests = (dir) => {
  const run = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  return run.status;
};

try {
  console.log(`tasks: ${tasks.length} (skill ${skillIds.join(',')}; control ${controlIds.join(',')})`);
  expect('fixture folders (reference)', readdirSync(join(fixtures, 'reference')).sort(), tasks.map((t) => t.id).sort());
  expect('fixture folders (naive)', readdirSync(join(fixtures, 'naive')).sort(), tasks.map((t) => t.id).sort());

  console.log('\n[1] untouched template: nothing is done');
  {
    const result = checkProject({ project: project('reference', []) });
    for (const t of result.tasks) {
      console.log(`  ${row(t)}`);
      expect(`${t.id} done`, t.done, false);
      expect(`${t.id} convention`, t.convention, skillIds.includes(t.id) ? false : null);
    }
    expect('unattributed changes', result.unattributedChanges, []);
  }

  console.log('\n[2] reference fixtures, all tasks: done and convention pass');
  {
    const dir = project('reference', tasks.map((t) => t.id));
    const result = checkProject({ project: dir });
    for (const t of result.tasks) {
      console.log(`  ${row(t)}${failed(t) ? `  failed: ${failed(t)}` : ''}`);
      expect(`${t.id} done`, t.done, true);
      expect(`${t.id} convention`, t.convention, skillIds.includes(t.id) ? true : null);
      expect(`${t.id} every detail ok`, t.details.every((d) => d.ok), true);
    }
    expect('unattributed changes', result.unattributedChanges, []);
    expect('template test suite still passes on the reference project (exit code)', projectTests(dir), 0);
  }

  console.log('\n[3] naive fixtures, all tasks: done, convention fails for every skill task');
  {
    const dir = project('naive', tasks.map((t) => t.id));
    const result = checkProject({ project: dir });
    for (const t of result.tasks) {
      console.log(`  ${row(t)}  failed: ${failed(t)}`);
      expect(`${t.id} done`, t.done, true);
      expect(`${t.id} convention`, t.convention, skillIds.includes(t.id) ? false : null);
      if (skillIds.includes(t.id)) {
        expect(`${t.id} all done.* ok`, t.details.filter((d) => d.check.startsWith('done.')).every((d) => d.ok), true);
        expect(`${t.id} every conv.* fails`, t.details.filter((d) => d.check.startsWith('conv.')).every((d) => !d.ok), true);
      }
    }
    expect('unattributed changes', result.unattributedChanges, []);
    expect('template test suite still passes on the naive project (exit code)', projectTests(dir), 0);
  }

  console.log('\n[4] independence: one reference fixture at a time changes only its own task');
  for (const task of tasks) {
    const result = byId(checkProject({ project: project('reference', [task.id]) }));
    const done = tasks.filter((t) => result[t.id].done).map((t) => t.id);
    const conv = tasks.filter((t) => result[t.id].convention === true).map((t) => t.id);
    console.log(`  only ${task.id}: done=[${done.join(',')}] convention=[${conv.join(',')}]`);
    expect(`only ${task.id}: done`, done, [task.id]);
    expect(`only ${task.id}: convention`, conv, task.kind === 'skill' ? [task.id] : []);
  }

  console.log('\n[5] controls: a change outside every task\'s paths is reported');
  {
    const dir = project('reference', controlIds);
    writeFileSync(join(dir, 'package.json'), readFileSync(join(dir, 'package.json'), 'utf8').replace('0.8.3', '0.8.4'));
    writeFileSync(join(dir, 'NOTES.txt'), 'stray\n');
    const result = checkProject({ project: dir });
    console.log(`  unattributedChanges=${JSON.stringify(result.unattributedChanges)}`);
    expect('unattributed changes', result.unattributedChanges, ['NOTES.txt', 'package.json']);
    for (const id of controlIds) {
      const t = byId(result)[id];
      expect(`${id} done`, t.done, true);
      expect(`${id} clean flag`, t.details.find((d) => d.check === 'control.no_unattributed_changes')?.ok, false);
    }
  }

  console.log('\n[6] a project module that throws on import does not crash the checker');
  {
    const dir = project('reference', []);
    writeFileSync(join(dir, 'src/jobs/index.mjs'), 'throw new Error("boom");\n');
    writeFileSync(join(dir, 'src/http/routes.mjs'), 'export const routes = "not an array";\n');
    const result = byId(checkProject({ project: dir }));
    console.log(`  ${row(result.t04)}; ${row(result.t06)}`);
    expect('t04 done', result.t04.done, false);
    expect('t06 done', result.t06.done, false);
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${assertions - failures}/${assertions} assertions passed`);
if (failures) {
  console.log('SELFTEST FAILED');
  process.exit(1);
}
console.log('SELFTEST PASSED');
