import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSettings } from '../src/config/settings.mjs';

test('built-in values', () => {
  const settings = loadSettings({});
  assert.equal(settings.port, 8080);
  assert.equal(settings.pickupCodeTtlHours, 72);
});

test('reads the environment', () => {
  assert.equal(loadSettings({ PORT: '9000' }).port, 9000);
  assert.equal(loadSettings({ PARCELDESK_LOCALE: 'en' }).locale, 'en');
});
