import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { child } from './helpers.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'compare-default-behavior.mjs');

// Runs the committed comparison (npm run compare:default) so a default-behaviour regression fails the suite.
// It needs the pre-kernel commit from git history; without it (tarball, shallow clone, copied tree) the
// script exits 3 and this test is reported as skipped, never as passed.
test('default kernel config is byte-identical to the pre-kernel tree for the compared hook scenario', async t => {
  const r = await child(process.execPath, [SCRIPT, '--json']);
  if (r.code === 3) { t.skip('pre-kernel commit unavailable: ' + r.stderr.trim()); return; }
  assert.equal(r.code, 0, r.stdout.slice(0, 4000) + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.status, 'identical');
  assert.deepEqual(report.differences, []);
  // 2 settings profiles x 3 hook modes x 2 runtimes x 9 events; the judged profile must really reach the judge.
  assert.equal(report.comparedOutputs, 108);
  assert.equal(report.perVariant.judged.outputs, 54);
  assert.equal(report.perVariant.judged.judgeCalls, 21);
  assert.equal(report.perVariant.untouched.judgeCalls, 0);
  assert.equal(report.thrownOutputs, 0);
  assert.ok(report.notCovered.length > 0, 'the report must state what it does not cover');
});

test('the comparison reports an unavailable base commit as exit 3, not as a pass', async () => {
  const r = await child(process.execPath, [SCRIPT, '--base', 'deadbeefdeadbeef']);
  // 3 either way: the commit does not exist, or this is not a git checkout at all.
  assert.equal(r.code, 3);
  assert.equal(r.stdout, '');
});
