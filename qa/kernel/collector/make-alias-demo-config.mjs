#!/usr/bin/env node
// Demo helper for run-alias-demo.sh. Writes a TEMPORARY config for an offline dry run of the outcome collector:
// a copy of a recorded config.json whose stateDir points at a copy of the hook state and, with --declare, whose
// registry declares (resolvesTo) the ids NAMED ON THE COMMAND LINE.
//
// It does not read a collector summary. What the collector observed is not a declaration: the ids to declare are
// typed by whoever runs this, entry by entry, exactly as a user types them into a registry after checking them.
// The output is not a registry anyone should install: its revision is DEMO-NOT-FOR-INSTALL, it is only written
// below the given work directory, and its stateDir must be below that directory too.
// Only config.json is read. The .env next to it (API key) is never opened.
//   make-alias-demo-config.mjs --work <dir> --config <config.json> --state-dir <dir under work> --out <file under work>
//                              [--declare <registry entry id>=<model id> ...]
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEMO_REVISION = 'DEMO-NOT-FOR-INSTALL';
const fail = (message, code = 2) => { console.error(message); process.exit(code); };
const args = {}; const declarations = [];
const argv = process.argv.slice(2);
if (argv.length % 2) fail('every option takes one value');
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i].replace(/^--/, '');
  if (key === 'declare') declarations.push(argv[i + 1]);
  else if (['work', 'config', 'state-dir', 'out'].includes(key) && !(key in args)) args[key] = argv[i + 1];
  else fail(`unknown or repeated option --${key}`);
}
for (const key of ['work', 'config', 'state-dir', 'out']) if (typeof args[key] !== 'string' || !path.isAbsolute(args[key])) fail(`--${key} must be an absolute path`);

// Symlinks are resolved on the nearest existing ancestor, so a link out of the work directory is refused.
async function real(target) {
  let current = path.resolve(target); const tail = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...tail); } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
      tail.unshift(path.basename(current)); current = path.dirname(current);
    }
  }
}
const work = await fs.realpath(args.work).catch(() => fail('--work must be an existing directory'));
const inside = async target => { const relative = path.relative(work, await real(target)); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };
if (!(await inside(args.out))) fail('--out must be below --work: this helper writes demo configs only');
if (!(await inside(args['state-dir']))) fail('--state-dir must be below --work: a demo config never points at real state');

const config = JSON.parse(await fs.readFile(args.config, 'utf8'));
config.stateDir = args['state-dir'];
config.registry.revision = DEMO_REVISION;
const declared = [];
for (const text of declarations) {
  const match = /^([a-z0-9-]{1,48})=([A-Za-z0-9][A-Za-z0-9._:@-]{0,79})$/.exec(text ?? '');
  if (!match) fail('--declare takes <registry entry id>=<model id>');
  const entry = config.registry.models.find(m => m.id === match[1]);
  if (!entry) fail(`no registry entry ${match[1]}`, 1);
  entry.resolvesTo = [...new Set([...(entry.resolvesTo ?? []), match[2]])];
}
for (const entry of config.registry.models) if (entry.resolvesTo) declared.push({ registryEntry: entry.id, backend: entry.backend, resolvesTo: entry.resolvesTo });
await fs.mkdir(path.dirname(args.out), { recursive: true });
await fs.writeFile(args.out, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ revision: config.registry.revision, evaluationContext: config.optimization.evaluationContext, declared,
  registry: config.registry.models.filter(m => m.runtime === 'claude').map(m => ({ id: m.id, model: m.model, backend: m.backend, enabled: m.enabled, resolvesTo: m.resolvesTo ?? null })) }, null, 2));
