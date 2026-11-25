#!/usr/bin/env node
// Checker of the routing experiment. Deterministic, offline, read-only on the project.
//   node check.mjs --project <dir> [--template <dir>]
// prints { tasks: [{ id, done, passed, details: [{ name, ok }] }], unattributedChanges: [...] }
//   done    every "basic: ..." check holds: the requested thing exists and its headline behaviour works
//   passed  done AND every "hidden: ..." check holds (what a correct solution must also handle)
//   unattributedChanges  files that differ from the template and that no task is allowed to touch
// The checks (probes.mjs) call the project's public functions in a child process per task (probe.mjs) with
// TZ=UTC and a timeout. Nothing in the project is written, and nothing here is ever copied into a session.
// Model-authored synthetic material.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffTrees } from './tree.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MARKER = '@@routing-exp-probe@@';
const PROBE_TIMEOUT_MS = 120000;
export const TASKS_FILE = join(here, '..', 'tasks.json');
export const TEMPLATE_DIR = join(here, '..', 'template');

export const loadTasks = () => JSON.parse(readFileSync(TASKS_FILE, 'utf8')).tasks;

function runProbe(project, id, timeoutMs) {
  const child = spawnSync(process.execPath, [join(here, 'probe.mjs'), project, id], {
    cwd: here, encoding: 'utf8', timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', TZ: 'UTC', LANG: 'C.UTF-8', NODE_ENV: 'test' },
  });
  const line = String(child.stdout ?? '').split('\n').filter((text) => text.startsWith(MARKER)).at(-1);
  if (line) {
    try {
      const details = JSON.parse(line.slice(MARKER.length));
      if (Array.isArray(details) && details.every((d) => typeof d?.name === 'string' && typeof d?.ok === 'boolean')) return details;
    } catch { /* fall through */ }
  }
  return [{ name: 'basic: the checks could be run against the project', ok: false }];
}

const allowedFor = (tasks) => (path, change) =>
  tasks.some((task) => task.allowedPaths.includes(path)) || (change === 'added' && path.startsWith('test/'));

export function checkProject({ project, template = TEMPLATE_DIR, tasks = loadTasks(), probeTimeoutMs = PROBE_TIMEOUT_MS }) {
  const root = resolve(project);
  const results = tasks.map((task) => {
    const details = runProbe(root, task.id, probeTimeoutMs);
    const basic = details.filter((d) => d.name.startsWith('basic: '));
    const done = basic.length > 0 && basic.every((d) => d.ok);
    return { id: task.id, done, passed: done && details.every((d) => d.ok), details };
  });
  const allowed = allowedFor(tasks);
  const unattributedChanges = diffTrees(resolve(template), root).filter((entry) => !allowed(entry.path, entry.change));
  return { tasks: results, unattributedChanges };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  if (typeof args.project !== 'string') { console.error('usage: check.mjs --project <dir> [--template <dir>]'); process.exit(64); }
  console.log(JSON.stringify(checkProject({ project: args.project, ...(args.template ? { template: args.template } : {}) }), null, 2));
}
