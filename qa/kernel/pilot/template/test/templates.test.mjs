import assert from 'node:assert/strict';
import { test } from 'node:test';
import { render, templates } from '../src/notify/templates.mjs';
import { createOutbox } from '../src/notify/outbox.mjs';

test('every template has both locales', () => {
  for (const [key, template] of Object.entries(templates)) {
    assert.equal(typeof template.en, 'string', key);
    assert.equal(typeof template.ko, 'string', key);
  }
});

test('render fills placeholders', () => {
  const text = render('parcelArrived', 'en', { name: 'Jiwoo', locker: 'L-A1', code: '123456' });
  assert.equal(text, 'Hi Jiwoo, your parcel is waiting in locker L-A1. Pickup code: 123456');
});

test('outbox queues a rendered message', () => {
  const outbox = createOutbox();
  outbox.queue('pickupReminder', { recipient: 'Sora', lockerId: 'L-A1', phone: '010-5555-0101' }, 'ko', { days: 3 });
  assert.equal(outbox.size, 1);
  assert.match(outbox.drain()[0].text, /3일째/);
});
