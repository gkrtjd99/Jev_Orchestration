import { render } from './templates.mjs';

// Messages wait here until the delivery service collects them.
export function createOutbox() {
  const queued = [];
  return {
    queue(key, parcel, locale, vars = {}) {
      const text = render(key, locale, { name: parcel.recipient, locker: parcel.lockerId, ...vars });
      const message = { to: parcel.phone, key, locale, text };
      queued.push(message);
      return message;
    },
    drain() {
      return queued.splice(0, queued.length);
    },
    get size() {
      return queued.length;
    },
  };
}
