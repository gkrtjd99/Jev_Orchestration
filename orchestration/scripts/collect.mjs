#!/usr/bin/env node
// Outcome collector CLI. Offline: reads hook state and one session's transcripts, writes labels, observations
// and a candidate evaluation file. It never imports evaluations and never contacts anything.
//   node scripts/collect.mjs (--config <config.json> | --state-dir <dir>) --transcripts <dir>
//        [--verification <file.json>] [--out <dir>] [--dry-run] [--evaluation-context <name>] [--project <dir>]
//   node scripts/collect.mjs (--config <config.json> | --state-dir <dir>) --report      observations report (delegations by
//        model match kind: exact | declared | alias-undeclared | mismatch); with --config also the evidence store by match kind
//   node scripts/collect.mjs --task-hash <file>                                       task hash of a task text file
import fs from 'node:fs/promises';
import path from 'node:path';
import { options, assert } from '../src/util.mjs';
import { loadConfig } from '../src/config.mjs';
import { collect, parseVerification, taskHash, skillFoldersOf, MAX_VERIFICATION_BYTES } from '../src/collector.mjs';
import { ObservationLog, observationReport } from '../src/kernel/observations.mjs';
import { loadSkillCatalog } from '../src/kernel/skills.mjs';
import { evidenceReport } from '../src/feedback.mjs';

const KNOWN = ['config', 'state-dir', 'transcripts', 'verification', 'out', 'dry-run', 'evaluation-context', 'project', 'report', 'task-hash'];
const USAGE = 'Use (--config /absolute/config.json | --state-dir /absolute/dir) --transcripts /absolute/dir [--verification file.json] '
  + '[--out /absolute/dir] [--dry-run] [--evaluation-context name] [--project /absolute/dir] | --report | --task-hash file';
const string = x => typeof x === 'string' && x.length > 0;

async function plainFile(file, max) {
  const stat = await fs.lstat(file);
  assert(!stat.isSymbolicLink(), 'SYMLINK_SOURCE');
  assert(stat.isFile() && stat.size <= max, 'INPUT_TOO_LARGE_OR_NOT_A_FILE');
  return fs.readFile(file, 'utf8');
}

try {
  const args = options(process.argv.slice(2));
  assert(Object.keys(args).every(k => KNOWN.includes(k)), 'UNKNOWN_ARGUMENT');
  if (args['task-hash'] !== undefined) {
    assert(string(args['task-hash']) && Object.keys(args).length === 1, USAGE);
    // The file's bytes are the task text: no trimming, so a trailing newline in the file changes the hash.
    console.log(JSON.stringify({ taskHash: taskHash(await plainFile(path.resolve(args['task-hash']), 1048576)) }));
  } else {
    assert(string(args.config) !== string(args['state-dir']), USAGE);
    let config = null, stateDir;
    if (string(args.config)) {
      ({ config } = await loadConfig(path.resolve(args.config)));
      stateDir = config.stateDir;
    } else {
      assert(path.isAbsolute(args['state-dir']), 'ABSOLUTE_STATE_REQUIRED');
      stateDir = args['state-dir'];
    }
    if (args.report !== undefined) {
      assert(args.report === true && Object.keys(args).length === 2, USAGE);
      const { observations, corruptLines } = await new ObservationLog(path.join(stateDir, 'observations-log')).read();
      // With a config the report also says what stands in the evidence store, by how each row's model was accepted.
      const evidenceStore = config ? await evidenceReport(config) : null;
      console.log(JSON.stringify({ ...observationReport(observations), records: observations.length, corruptLines, evidenceStore }, null, 2));
    } else {
      for (const key of ['transcripts', 'out', 'project']) assert(args[key] === undefined || (string(args[key]) && path.isAbsolute(args[key])), `ABSOLUTE_${key.toUpperCase()}_REQUIRED`);
      assert(args['dry-run'] === undefined || args['dry-run'] === true, USAGE);
      assert(args['evaluation-context'] === undefined || string(args['evaluation-context']), 'INVALID_EVALUATION_CONTEXT');
      let verification = [];
      if (args.verification !== undefined) {
        assert(string(args.verification), USAGE);
        let parsed;
        try { parsed = JSON.parse(await plainFile(path.resolve(args.verification), MAX_VERIFICATION_BYTES)); }
        catch (e) { assert(e.code && e.code !== undefined && !(e instanceof SyntaxError), 'INVALID_VERIFICATION_FILE'); throw e; }
        verification = parseVerification(parsed);
      }
      // Optional: the project whose .claude/skills names the project skills, for a session whose hook state names none.
      const skillFolders = args.project ? skillFoldersOf(await loadSkillCatalog({ project: args.project })) : new Map();
      const summary = await collect({ stateDir, transcriptsDir: args.transcripts ?? null, verification, outDir: args.out ?? null,
        dryRun: args['dry-run'] === true, evaluationContext: args['evaluation-context'] ?? null, config, skillFolders });
      console.log(JSON.stringify(summary, null, 2));
    }
  }
} catch (e) {
  console.error(e.code || e.message);
  process.exitCode = 1;
}
