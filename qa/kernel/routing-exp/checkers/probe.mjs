#!/usr/bin/env node
// Child-process entry of the checker: runs the checks of ONE task against a project and prints them.
//   node probe.mjs <project dir> <task id>
// The project's modules are imported here, never in the checker's own process, so a module that throws,
// hangs or exits cannot take the checker down. The result is the last line that starts with the marker.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROBES } from './probes.mjs';

export const MARKER = '@@routing-exp-probe@@';
const CHECK_TIMEOUT_MS = 8000;

const [project, id] = process.argv.slice(2);
const details = [];
const load = (relative) => import(pathToFileURL(join(project, relative)).href);
const run = (kind) => async (name, fn) => {
  let ok = false;
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS); });
    ok = (await Promise.race([Promise.resolve().then(fn), timeout])) === true;
  } catch { ok = false; } finally { clearTimeout(timer); }
  details.push({ name: `${kind}: ${name}`, ok });
};
// A rejection nobody awaited inside project code must not end the probe.
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

if (!Object.hasOwn(PROBES, id)) { console.error(`unknown task ${id}`); process.exit(64); }
await PROBES[id]({ load, basic: run('basic'), hidden: run('hidden') });
process.stdout.write(`\n${MARKER}${JSON.stringify(details)}\n`);
process.exit(0);
