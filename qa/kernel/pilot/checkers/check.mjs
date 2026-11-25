#!/usr/bin/env node
// Objective checker for the paired pilot.
//   node check.mjs --project <dir> [--template <dir>] [--tasks <tasks.json>]
// Prints JSON { tasks: [{ id, done, convention, details }], unattributedChanges: [...] }.
// Reads only. Each task is probed in its own child process (it imports the project's modules), with a timeout.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inAnyScope } from './scopes.mjs';
import { changedPaths } from './tree.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PROBE_TIMEOUT_MS = 20000;

export function checkProject({ project, template = join(here, '..', 'template'), tasksFile = join(here, '..', 'tasks.json') }) {
  const projectDir = resolve(project);
  const templateDir = resolve(template);
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) throw new Error(`project folder not found: ${projectDir}`);
  const { tasks } = JSON.parse(readFileSync(tasksFile, 'utf8'));
  const changes = changedPaths(templateDir, projectDir);
  const unattributedChanges = [...changes.added, ...changes.modified, ...changes.removed].filter((rel) => !inAnyScope(rel)).sort();

  const results = tasks.map((task) => {
    const isSkill = task.kind === 'skill';
    const child = spawnSync(process.execPath, [join(here, 'probe.mjs'), task.id, projectDir, templateDir], {
      cwd: projectDir, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
    });
    let parsed = null;
    try { parsed = JSON.parse(child.stdout.trim().split('\n').pop()); } catch { /* fall through */ }
    if (!parsed || typeof parsed.done !== 'boolean' || !Array.isArray(parsed.details)) {
      const why = child.error?.code === 'ETIMEDOUT' ? 'probe timed out' : `probe produced no result (exit ${child.status})`;
      return { id: task.id, done: false, convention: isSkill ? false : null, details: [{ check: 'probe.failed', ok: false, note: why }] };
    }
    const details = [...parsed.details];
    let done = parsed.done;
    if (!isSkill) {
      // A control is "clean" when no file outside every task's declared paths changed in the project. In a
      // project where all eight tasks ran this cannot be pinned on one subagent; analyze.mjs does that from
      // the transcripts.
      details.push({ check: 'control.no_unattributed_changes', ok: unattributedChanges.length === 0,
        ...(unattributedChanges.length ? { note: unattributedChanges.slice(0, 20).join(', ') } : {}) });
    }
    return { id: task.id, done, convention: isSkill ? Boolean(parsed.convention) : null, details };
  });
  return { tasks: results, unattributedChanges };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.project) throw new Error('usage: check.mjs --project <dir> [--template <dir>] [--tasks <tasks.json>]');
    const result = checkProject({ project: args.project, ...(args.template ? { template: args.template } : {}), ...(args.tasks ? { tasksFile: args.tasks } : {}) });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(64);
  }
}
