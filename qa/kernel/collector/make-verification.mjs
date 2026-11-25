#!/usr/bin/env node
// Builds a collector verification file for one arm of the paired pilot. Offline, read-only on the evidence.
//   node make-verification.mjs --project <pilot project dir> --transcripts <dir> --out <verification.json> [--artifact-out <file>]
// It runs the pilot's scripted checker (../pilot/checkers/check.mjs, unchanged) on the project and writes one
// entry per pilot task that Main delegated: { taskHash, passed, conventionPassed?, validator, artifactSha256 }.
//   passed            the checker's `done`
//   conventionPassed  the checker's `convention` (skill tasks only; control tasks have none)
//   validator         name "pilot-checker", version = SHA-256 of check.mjs
//   artifactSha256    SHA-256 of the checker's JSON output exactly as its CLI prints it
//   taskHash          collector taskHash() of the prompt of the first Agent call whose prompt contains the task text
// The output holds hashes, booleans and the validator id only: no task text, no path, no id.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject } from '../pilot/checkers/check.mjs';
import { taskHash, parseJsonl, parseMain } from '../../../orchestration/src/collector.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args.project || !args.transcripts || !args.out) { console.error('usage: make-verification.mjs --project <dir> --transcripts <dir> --out <file> [--artifact-out <file>]'); process.exit(64); }

const checkerFile = join(here, '..', 'pilot', 'checkers', 'check.mjs');
const { tasks } = JSON.parse(readFileSync(join(here, '..', 'pilot', 'tasks.json'), 'utf8'));
const result = checkProject({ project: resolve(args.project) });
const artifact = JSON.stringify(result, null, 2) + '\n';
if (args['artifact-out']) writeFileSync(args['artifact-out'], artifact, { mode: 0o600 });
const validator = { name: 'pilot-checker', version: sha(readFileSync(checkerFile)) };
const main = parseMain(parseJsonl(readFileSync(join(resolve(args.transcripts), 'main.jsonl'), 'utf8')).rows);
const calls = [...main.calls.values()].filter(call => call.prompt !== null).sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

const results = [];
const summary = [];
for (const task of tasks) {
  const checked = result.tasks.find(entry => entry.id === task.id);
  const call = calls.find(c => squash(c.prompt).includes(squash(task.text)));
  summary.push({ task: task.id, kind: task.kind, delegated: Boolean(call), passed: checked?.done ?? null, conventionPassed: checked?.convention ?? null });
  if (!call || !checked) continue;
  results.push({ taskHash: taskHash(call.prompt), passed: checked.done, ...(typeof checked.convention === 'boolean' ? { conventionPassed: checked.convention } : {}),
    validator, artifactSha256: sha(artifact) });
}
writeFileSync(args.out, JSON.stringify({ schema: 1, results }, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ entries: results.length, validator, artifactSha256: sha(artifact), tasks: summary }, null, 2));
