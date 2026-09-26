// Configuration/inspection helper only; never starts a native worker.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaults, loadConfig } from '../src/config.mjs';
import { profileCatalog, registryFingerprint } from '../src/catalog.mjs';
import { options } from '../src/util.mjs';
const args=options(process.argv.slice(2));
try {
  const config=args.config?(await loadConfig(path.resolve(args.config))).config:defaults(os.homedir());
  const out=args.registry?config.registry:{registryFingerprint:registryFingerprint(config.registry),
    note:'Declared capabilities and initial policies; not a benchmark or an account availability probe.',
    claude:profileCatalog(config.registry,'claude'),codex:profileCatalog(config.registry,'codex')};
  console.log(JSON.stringify(out,null,2));
}catch(e){console.error(e.code||e.message);process.exitCode=1;}
