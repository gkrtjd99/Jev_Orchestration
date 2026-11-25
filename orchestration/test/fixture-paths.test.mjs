import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture, event, mockClient } from './helpers.mjs';
import { handleHook } from '../src/hooks.mjs';

// Regression: macOS's default TMPDIR (/var/folders/...) is a symlink to /private/var/folders/...
// The product canonicalizes project paths, so a fixture built on the raw TMPDIR made 31 tests fail
// under a plain `npm test`. This reproduces a symlinked TMPDIR on every platform.
test('fixture paths are canonical even when TMPDIR is a symlink', async t => {
  const real = await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'jev-tmp-real-')));
  const link = real + '-link';
  await fs.symlink(real, link, 'dir');
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = link;
  t.after(async () => {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    await fs.rm(link, { force: true });
    await fs.rm(real, { recursive: true, force: true });
  });
  assert.equal(os.tmpdir(), link, 'the test must actually run with a symlinked temp directory');

  const f = await fixture(t);
  for (const p of [f.root, f.home, f.project]) {
    assert.equal(p, await fs.realpath(p));
    assert.ok(p.startsWith(real + path.sep), 'fixture must live under the resolved directory');
  }
  // The installed profile paths the product verifies are canonical as well.
  for (const rt of ['claude', 'codex']) {
    for (const p of Object.values(f.config.installedProfiles[rt])) assert.equal(p.path, await fs.realpath(p.path));
  }
  // End to end: an active delegation is rewritten, which requires the profile path check to pass.
  const out = await handleHook(event(f.project), 'claude', { config: f.config, apiKey: 'unit-test-key', client: mockClient() });
  assert.match(out.hookSpecificOutput?.updatedInput?.subagent_type ?? '', /^jev4_/, 'the routed call must be rewritten, not skipped for a path mismatch');
});
