import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory-store.mjs';
import { createIdGenerator } from '../src/util/ids.mjs';
import { MemberDirectory } from '../src/members/directory.mjs';
import { validateDisplayName } from '../src/members/names.mjs';

const directory = () => new MemberDirectory({ store: new MemoryStore(), ids: createIdGenerator('mb') });

test('members are registered with a cleaned-up name', async () => {
  const members = directory();
  const member = await members.register({ displayName: '  Bo   Kim ', email: 'bo@example.com' });
  assert.equal(member.displayName, 'Bo Kim');
  assert.deepEqual(await members.get(member.id), member);
});

test('a display name can be used once, whatever its capitalisation', async () => {
  const members = directory();
  await members.register({ displayName: 'Anna Lee' });
  await assert.rejects(members.register({ displayName: 'anna lee' }), { code: 'NAME_TAKEN' });
});

test('names are limited to 20 characters', () => {
  assert.equal(validateDisplayName('a'.repeat(20)), 'a'.repeat(20));
  assert.throws(() => validateDisplayName('a'.repeat(21)), { code: 'NAME_TOO_LONG' });
  assert.throws(() => validateDisplayName('   '), { code: 'NAME_REQUIRED' });
});

test('renaming frees the old name', async () => {
  const members = directory();
  const first = await members.register({ displayName: 'Dana' });
  await members.rename(first.id, 'Dana Park');
  const second = await members.register({ displayName: 'Dana' });
  assert.deepEqual((await members.list()).map((m) => m.displayName), ['Dana', 'Dana Park']);
  assert.notEqual(second.id, first.id);
});
