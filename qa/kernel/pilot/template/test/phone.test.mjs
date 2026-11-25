import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskPhone } from '../src/util/phone.mjs';

test('maskPhone hides the middle block', () => {
  assert.equal(maskPhone('010-1234-5678'), '010-****-5678');
});
