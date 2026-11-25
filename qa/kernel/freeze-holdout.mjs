#!/usr/bin/env node
// Freezes a dataset directory as a held-out set: writes <data-dir>/HOLDOUT.json with the sha256 of every file
// under skills/ and of every .jsonl task or label file. Never overwrites an existing HOLDOUT.json.
// Sends nothing anywhere and reads no key.
//
//   node qa/kernel/freeze-holdout.mjs --data-dir <dir> [--policy "<text>"]
//
// After this, run-eval.mjs refuses the directory unless --spend-holdout "<reason>" is given, verifies the
// hashes first, and records every run in <data-dir>/HOLDOUT_LEDGER.jsonl. See qa/kernel/README.md.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freezeHoldout, DEFAULT_POLICY } from './lib/holdout.mjs';

const USAGE = 'usage: node qa/kernel/freeze-holdout.mjs --data-dir <dir> [--policy "<text>"]';

export function parseArgs(argv) {
  const out = { dataDir: null, policy: DEFAULT_POLICY };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--data-dir' && arg !== '--policy') throw Object.assign(new Error(`QA_UNKNOWN_OPTION: ${arg}`), { code: 'QA_UNKNOWN_OPTION' });
    if (argv[i + 1] === undefined) throw Object.assign(new Error(`QA_OPTION_NEEDS_VALUE: ${arg}`), { code: 'QA_OPTION_NEEDS_VALUE' });
    if (arg === '--data-dir') out.dataDir = path.resolve(argv[++i]); else out.policy = argv[++i];
  }
  // No default directory: freezing the development set by accident must not be one keystroke away.
  if (!out.dataDir) throw Object.assign(new Error('QA_MISSING_DATA_DIR'), { code: 'QA_MISSING_DATA_DIR' });
  return out;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`${e.message}\n${USAGE}\n`); process.exit(64); }
  try {
    const { file, manifest } = await freezeHoldout(options.dataDir, { policy: options.policy });
    process.stdout.write(`frozen: ${file}\nfiles hashed: ${Object.keys(manifest.sha256).length}\npolicy: ${manifest.policy}\n`);
  } catch (e) {
    process.stderr.write(typeof e?.code === 'string' && e.code.startsWith('QA_') ? `${e.message}\n` : `QA_FREEZE_FAILED: ${e?.code ?? e?.name ?? 'Error'}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
