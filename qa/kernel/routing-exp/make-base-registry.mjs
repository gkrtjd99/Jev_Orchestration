#!/usr/bin/env node
// The base registry of the experiment: the one registry both hooked arms start from. Pre-registered.
//   node make-base-registry.mjs           writes base-registry.json
//   node make-base-registry.mjs --check   exits 1 when the committed file is not what this script derives
// It is the product's example registry (orchestration/config/registry.example.json) with the three enabled claude
// entries pointed at the model aliases the owner's earlier real sessions on this machine ran with:
//   claude-light -> sonnet, claude-standard -> opus, claude-strategic -> opus
// Nothing else is changed here: `availability` stays "declared" (confirming that an account can run a model is
// the owner's statement, typed as make-arm-config.mjs --confirm-availability <backend>), and the resolvesTo
// declarations are added per arm by make-arm-config.mjs. Reads one repository file, writes one file next to itself.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRegistry } from '../../../orchestration/src/catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const BASE_REGISTRY_FILE = join(here, 'base-registry.json');
export const ALIASES = Object.freeze({ 'claude-light': 'sonnet', 'claude-standard': 'opus', 'claude-strategic': 'opus' });
export const BASE_REVISION_SUFFIX = '+routing-exp-base';

export function baseRegistry() {
  const registry = JSON.parse(readFileSync(join(here, '..', '..', '..', 'orchestration', 'config', 'registry.example.json'), 'utf8'));
  const seen = new Set();
  for (const entry of registry.models) {
    if (!Object.hasOwn(ALIASES, entry.id)) continue;
    if (entry.runtime !== 'claude' || entry.enabled !== true) throw new Error(`${entry.id} is not an enabled claude entry of the example registry`);
    entry.model = ALIASES[entry.id]; entry.backend = ALIASES[entry.id];
    seen.add(entry.id);
  }
  for (const id of Object.keys(ALIASES)) if (!seen.has(id)) throw new Error(`the example registry has no entry ${id}`);
  const others = registry.models.filter((m) => m.runtime === 'claude' && m.enabled && !Object.hasOwn(ALIASES, m.id)).map((m) => m.id);
  if (others.length) throw new Error(`the example registry enables claude entries this experiment does not know: ${others.join(', ')}`);
  registry.revision = `${registry.revision}${BASE_REVISION_SUFFIX}`;
  validateRegistry(structuredClone(registry));
  return registry;
}
export const baseRegistryText = () => JSON.stringify(baseRegistry(), null, 2) + '\n';

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = baseRegistryText();
  if (process.argv.includes('--check')) {
    let current = null;
    try { current = readFileSync(BASE_REGISTRY_FILE, 'utf8'); } catch { /* missing */ }
    if (current !== text) { console.error('base-registry.json is not what make-base-registry.mjs derives from the example registry'); process.exit(1); }
    const enabled = JSON.parse(text).models.filter((m) => m.runtime === 'claude' && m.enabled);
    console.log(`base-registry.json is current: ${enabled.map((m) => `${m.id}=${m.backend}(${m.availability})`).join(', ')}`);
  } else {
    writeFileSync(BASE_REGISTRY_FILE, text);
    console.log(`wrote ${BASE_REGISTRY_FILE}`);
  }
}
