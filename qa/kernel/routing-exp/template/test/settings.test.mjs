import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSettings } from '../src/config/settings.mjs';

test('defaults apply when nothing is set', () => {
  const settings = loadSettings({});
  assert.equal(settings.timeZone, 'Asia/Seoul');
  assert.equal(settings.currency, 'KRW');
  assert.equal(settings.maxActiveBookings, 5);
  assert.equal(settings.cacheTtlMs, 30000);
});

test('values are read from the environment and validated', () => {
  const settings = loadSettings({ STUDIO_TIME_ZONE: 'Europe/London', STUDIO_CURRENCY: 'EUR', STUDIO_MAX_ACTIVE_BOOKINGS: '8' });
  assert.equal(settings.timeZone, 'Europe/London');
  assert.equal(settings.maxActiveBookings, 8);
  assert.throws(() => loadSettings({ STUDIO_MAX_ACTIVE_BOOKINGS: '0' }), { name: 'ConfigError', code: 'INVALID_SETTING' });
  assert.throws(() => loadSettings({ STUDIO_CURRENCY: 'GOLD' }), { name: 'ConfigError' });
});
