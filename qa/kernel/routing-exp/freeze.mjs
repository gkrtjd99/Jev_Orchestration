#!/usr/bin/env node
// Records what is fixed before the first session starts: the hashes of the tasks, the Main prompt, the checker,
// the fixtures and the template. `--check` exits 1 when any of them differs from FROZEN.json.
//   node freeze.mjs           writes FROZEN.json
//   node freeze.mjs --check   compares
// PROTOCOL.md rule 3: nothing listed here changes after the first session has started. PROTOCOL.md itself (its
// configuration table is filled in before the sessions) and the analyzer (whose reading of real files may have to
// be repaired, see rule 3) are not hashed here; git history is their record.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const filesOf = (root, base = root) => readdirSync(root, { withFileTypes: true }).filter((entry) => entry.name !== '.DS_Store')
  .flatMap((entry) => (entry.isDirectory() ? filesOf(join(root, entry.name), base) : [relative(base, join(root, entry.name)).split('\\').join('/')])).sort();
const tree = (dir) => { const files = filesOf(join(here, dir)); return { files: files.length, sha256: sha(files.map((file) => `${file}\0${sha(readFileSync(join(here, dir, file)))}`).join('\n')) }; };
const file = (name) => sha(readFileSync(join(here, name)));

export function snapshot() {
  return {
    schema: 1,
    note: 'SHA-256 of the pre-registered material. A tree hash is the hash of "<path>\\0<file hash>" lines, sorted by path.',
    'tasks.json': file('tasks.json'),
    'main-prompt.txt': file('main-prompt.txt'),
    checkers: Object.fromEntries(['check.mjs', 'probes.mjs', 'probe.mjs', 'tree.mjs'].map((name) => [name, file(join('checkers', name))])),
    validatorVersion: file(join('checkers', 'check.mjs')),
    template: tree('template'),
    fixtures: tree('fixtures'),
    'make-arm-config.mjs': file('make-arm-config.mjs'),
    'make-verification.mjs': file('make-verification.mjs'),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const now = snapshot();
  const target = join(here, 'FROZEN.json');
  if (process.argv.includes('--check')) {
    let stored = null;
    try { stored = JSON.parse(readFileSync(target, 'utf8')); } catch { /* missing */ }
    const differing = stored ? Object.keys(now).filter((key) => JSON.stringify(now[key]) !== JSON.stringify(stored[key])) : ['FROZEN.json is missing'];
    if (differing.length) { console.error(`not as frozen: ${differing.join(', ')}`); process.exit(1); }
    console.log(`as frozen: tasks.json ${now['tasks.json'].slice(0, 12)}, main-prompt.txt ${now['main-prompt.txt'].slice(0, 12)}, check.mjs ${now.validatorVersion.slice(0, 12)}, template ${now.template.files} files, fixtures ${now.fixtures.files} files`);
  } else {
    writeFileSync(target, JSON.stringify(now, null, 2) + '\n');
    console.log(`wrote ${target}`);
  }
}
