// The alias demo helper (qa/kernel/collector/make-alias-demo-config.mjs) must not be a way to turn what the
// collector observed into a registry: ids come from the command line only, output stays below the work
// directory, and the output is marked as a demo. Synthetic data only.
//   node --test qa/kernel/test/alias-demo-config.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaults } from '../../../orchestration/src/config.mjs';
import { validateRegistry } from '../../../orchestration/src/catalog.mjs';

const HELPER = fileURLToPath(new URL('../collector/make-alias-demo-config.mjs', import.meta.url));
const run = args => new Promise(resolve => execFile(process.execPath, [HELPER, ...args], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));

test('the demo helper declares only ids named on the command line, only below the work directory, and marks its output', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jev-alias-demo-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const work = path.join(root, 'work'), outside = path.join(root, 'outside');
  await fs.mkdir(work); await fs.mkdir(outside);
  const config = defaults(path.join(root, 'home'));
  const source = path.join(root, 'recorded.json');
  await fs.writeFile(source, JSON.stringify(config));
  const before = await fs.readFile(source, 'utf8');
  const base = ['--work', work, '--config', source, '--state-dir', path.join(work, 'state')];

  const ok = await run([...base, '--out', path.join(work, 'c', 'config.json'), '--declare', 'claude-light=fixture-resolved-9-9']);
  assert.equal(ok.code, 0, ok.stderr);
  const written = JSON.parse(await fs.readFile(path.join(work, 'c', 'config.json'), 'utf8'));
  assert.equal(written.registry.revision, 'DEMO-NOT-FOR-INSTALL');
  assert.equal(written.stateDir, path.join(work, 'state'));
  assert.deepEqual(written.registry.models.filter(m => m.resolvesTo).map(m => [m.id, m.resolvesTo]), [['claude-light', ['fixture-resolved-9-9']]]);
  validateRegistry(written.registry);
  assert.equal(JSON.parse(ok.stdout).revision, 'DEMO-NOT-FOR-INSTALL');
  // Without --declare nothing is declared.
  const plain = await run([...base, '--out', path.join(work, 'plain.json')]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.ok(JSON.parse(await fs.readFile(path.join(work, 'plain.json'), 'utf8')).registry.models.every(m => !Object.hasOwn(m, 'resolvesTo')));

  // Refusals: nothing is written, and the source is never touched.
  await fs.symlink(outside, path.join(work, 'link'));
  const summary = path.join(root, 'summary.json');
  await fs.writeFile(summary, JSON.stringify({ modelMatch: { undeclared: [{ registryEntry: 'claude-light', observedModel: 'fixture-observed-1' }] } }));
  const refusals = [
    [...base, '--out', path.join(outside, 'config.json')],                                   // outside the work directory
    [...base, '--out', path.join(work, '..', 'outside', 'config.json')],                     // by ..
    [...base, '--out', path.join(work, 'link', 'config.json')],                              // through a symlink
    [...base, '--out', work],                                                                // the work directory itself
    ['--work', work, '--config', source, '--state-dir', path.join(outside, 'state'), '--out', path.join(work, 'x.json')],   // state outside
    [...base, '--out', path.join(work, 'x.json'), '--declare-from', summary],                // a collector summary is not an input
    [...base, '--out', path.join(work, 'x.json'), '--declare', 'claude-light=claude-*'],     // no pattern
    [...base, '--out', path.join(work, 'x.json'), '--declare', 'claude-light'],
    [...base, '--out', path.join(work, 'x.json'), '--declare', 'no-such-entry=fixture-id'],
    ['--config', source, '--state-dir', path.join(work, 'state'), '--out', path.join(work, 'x.json')],                       // no work directory
  ];
  for (const args of refusals) {
    const r = await run(args);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
  await assert.rejects(fs.lstat(path.join(outside, 'config.json')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(work, 'x.json')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(await fs.readFile(source, 'utf8'), before);
});
