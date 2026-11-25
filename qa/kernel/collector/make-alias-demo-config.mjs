#!/usr/bin/env node
// Demo helper for run-alias-demo.sh. Writes a TEMPORARY config for an offline dry run of the outcome collector:
// a copy of a recorded config.json whose stateDir points at a copy of the hook state and, with --declare-from,
// whose registry declares (resolvesTo) the model ids a previous collector summary listed as undeclared.
//
// This is exactly what the product does NOT do: the collector never writes a registry, because a declaration
// is the user's statement after checking the id. Here it is done mechanically, on a temp copy, only to show
// what the collector reports once ids are declared. The output is not a registry anyone should install.
// Only config.json is read. The .env next to it (API key) is never opened.
//   make-alias-demo-config.mjs --config <config.json> --state-dir <dir> --out <file> [--declare-from <summary.json>]
import fs from 'node:fs/promises';
import path from 'node:path';

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
for (const key of ['config', 'state-dir', 'out']) if (typeof args[key] !== 'string' || !path.isAbsolute(args[key])) { console.error(`--${key} must be an absolute path`); process.exit(2); }

const config = JSON.parse(await fs.readFile(args.config, 'utf8'));
config.stateDir = args['state-dir'];
const declared = [];
if (args['declare-from']) {
  const summary = JSON.parse(await fs.readFile(args['declare-from'], 'utf8'));
  for (const item of summary.modelMatch.undeclared) {
    const entry = config.registry.models.find(m => m.id === item.registryEntry);
    if (!entry) { console.error(`no registry entry for ${item.registryEntry}`); process.exit(1); }
    entry.resolvesTo = [...new Set([...(entry.resolvesTo ?? []), item.observedModel])];
    declared.push({ registryEntry: entry.id, backend: entry.backend, resolvesTo: entry.resolvesTo });
  }
}
await fs.mkdir(path.dirname(args.out), { recursive: true });
await fs.writeFile(args.out, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ evaluationContext: config.optimization.evaluationContext, declared,
  registry: config.registry.models.filter(m => m.runtime === 'claude').map(m => ({ id: m.id, model: m.model, backend: m.backend, enabled: m.enabled, resolvesTo: m.resolvesTo ?? null })) }, null, 2));
