#!/usr/bin/env node
// Builds the verification file the outcome collector accepts (collect.mjs --verification) for one arm.
//   node make-verification.mjs --project <arm project dir> --out <verification.json> [--transcripts <dir>] [--artifact-out <file>]
// Offline. Runs the experiment's checker (checkers/check.mjs) on the project and writes one entry per task:
//   { taskHash, passed, validator: { name: "routing-exp-checker", version }, artifactSha256 }
//   passed          the checker's `passed` for that task (done AND every hidden check)
//   validator       name "routing-exp-checker", version = SHA-256 of checkers/check.mjs
//   artifactSha256  SHA-256 of the checker's output exactly as its CLI prints it (JSON, two-space indent, final newline)
//   taskHash        the collector's taskHash(): SHA-256 of the UTF-8 bytes of the task text as Main first issued it,
//                   untrimmed; when that string ends in the routing tail the hooks append, of the text in front of it
// Which string is hashed:
//   without --transcripts  the task text of tasks.json (what Main is told to pass on character for character); one
//                          entry per task. An entry whose hash matches no delegation is simply unmatched in the collector.
//   with --transcripts     the prompt of the first Agent call in Main's transcript that contains the task text; a task
//                          Main never delegated gets no entry, and a prompt that is not the verbatim text is reported.
// The file holds hashes, booleans and the validator id only: no task text, no path, no id.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject, loadTasks } from './checkers/check.mjs';
import { taskHash, parseJsonl, parseMain, parseVerification } from '../../../orchestration/src/collector.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const VALIDATOR_NAME = 'routing-exp-checker';
const CHECKER_FILES = ['check.mjs', 'probes.mjs', 'probe.mjs', 'tree.mjs'];
const sha = (data) => createHash('sha256').update(data).digest('hex');
const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

export const validator = () => ({ name: VALIDATOR_NAME, version: sha(readFileSync(join(here, 'checkers', 'check.mjs'))) });
export const artifactText = (result) => JSON.stringify(result, null, 2) + '\n';

/** Agent calls of the Main transcript(s) directly under `dir`, in the order they were issued. */
export function mainCalls(dir) {
  const files = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name).sort();
  if (files.length === 0) throw new Error(`no Main transcript (*.jsonl) directly under ${dir}`);
  const rows = files.flatMap((name) => parseJsonl(readFileSync(join(dir, name), 'utf8')).rows);
  return [...parseMain(rows).calls.values()].filter((call) => call.prompt !== null).sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
}

export function buildVerification({ project, transcripts = null, tasks = loadTasks(), result = checkProject({ project, tasks }) }) {
  const artifact = artifactText(result);
  const stamp = { validator: validator(), artifactSha256: sha(artifact) };
  const calls = transcripts ? mainCalls(transcripts) : null;
  const results = [], summary = [];
  for (const task of tasks) {
    const checked = result.tasks.find((entry) => entry.id === task.id);
    const call = calls ? calls.find((c) => squash(c.prompt).includes(squash(task.text))) ?? null : null;
    const source = calls === null ? task.text : call?.prompt ?? null;
    const hash = source === null ? null : taskHash(source);
    summary.push({ task: task.id, delegated: calls === null ? null : call !== null, verbatim: calls === null || call === null ? null : hash === taskHash(task.text),
      done: checked?.done ?? null, passed: checked?.passed ?? null, entry: hash !== null && Boolean(checked) });
    if (hash === null || !checked) continue;
    results.push({ taskHash: hash, passed: checked.passed, ...stamp });
  }
  const file = { schema: 1, results };
  parseVerification(file); // the collector's own validation: throws if it would refuse the file
  return { file, artifact, summary: { entries: results.length, ...stamp, checkerFiles: Object.fromEntries(CHECKER_FILES.map((name) => [name, sha(readFileSync(join(here, 'checkers', name)))])),
    tasksFile: sha(readFileSync(join(here, 'tasks.json'))), hashedText: calls === null ? 'tasks.json text' : 'first Agent call of the Main transcript', tasks: summary } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  if (!args.project || !args.out) { console.error('usage: make-verification.mjs --project <dir> --out <file> [--transcripts <dir>] [--artifact-out <file>]'); process.exit(64); }
  const built = buildVerification({ project: resolve(args.project), transcripts: args.transcripts ? resolve(args.transcripts) : null });
  writeFileSync(resolve(args.out), JSON.stringify(built.file, null, 2) + '\n', { mode: 0o600 });
  if (args['artifact-out']) writeFileSync(resolve(args['artifact-out']), built.artifact, { mode: 0o600 });
  console.log(JSON.stringify(built.summary, null, 2));
}
