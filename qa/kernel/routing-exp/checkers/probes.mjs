// Behavioural checks, one function per task. They run in a child process (probe.mjs) and only ever call the
// project's public functions: no source text is inspected, no helper name or formatting matters.
//   basic(name, fn)   the requested thing exists and its headline behaviour works        -> "done"
//   hidden(name, fn)  what a correct solution must also handle                            -> "passed" (with done)
// A check passes only when fn resolves to exactly true; a throw, a rejection or a timeout is a failure.
// Model-authored synthetic material.

const settle = (promises) => Promise.allSettled(promises);
const fulfilled = (results) => results.filter((r) => r.status === 'fulfilled');
const rejectedWith = (results, code) => results.filter((r) => r.status === 'rejected' && r.reason?.code === code);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function throwsCode(fn, code, name) {
  try { fn(); } catch (error) { return error?.code === code && (name === undefined || error?.name === name); }
  return false;
}
async function rejectsCode(promise, code, name) {
  try { await promise; } catch (error) { return error?.code === code && (name === undefined || error?.name === name); }
  return false;
}

// ---------------------------------------------------------------- t01 cursor paging
async function t01({ load, basic, hidden }) {
  const mod = () => load('src/api/paginate.mjs');
  const list = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${String(i + 1).padStart(3, '0')}`, n: i + 1 }));
  const ids = (page) => page.items.map((item) => item.id);

  await basic('pages follow each other', async () => {
    const { paginateAfter } = await mod();
    const items = list(5);
    const first = paginateAfter(items, { limit: 2 });
    const second = paginateAfter(items, { after: first.nextCursor, limit: 2 });
    return same(ids(first), ['r001', 'r002']) && first.nextCursor === 'r002' && same(ids(second), ['r003', 'r004']) && second.nextCursor === 'r004';
  });
  await hidden('a last page that is exactly full has no next cursor', async () => {
    const { paginateAfter } = await mod();
    const items = list(4);
    const last = paginateAfter(items, { after: 'r002', limit: 2 });
    return same(ids(last), ['r003', 'r004']) && last.nextCursor === null && paginateAfter(list(3), { limit: 3 }).nextCursor === null;
  });
  await hidden('walking the cursors visits every record once and ends', async () => {
    const { paginateAfter } = await mod();
    for (let size = 0; size <= 9; size += 1) {
      for (let limit = 1; limit <= 4; limit += 1) {
        const items = list(size);
        const seen = [];
        let after = null, pages = 0;
        for (;;) {
          const page = paginateAfter(items, { after, limit });
          pages += 1;
          if (page.items.length > limit || pages > 20) return false;
          seen.push(...ids(page));
          if (page.nextCursor === null) break;
          if (page.items.length === 0) return false;
          after = page.nextCursor;
        }
        if (!same(seen, items.map((item) => item.id)) || pages !== Math.max(1, Math.ceil(size / limit))) return false;
      }
    }
    return true;
  });
  await hidden('nothing after the last record, nothing in an empty list', async () => {
    const { paginateAfter } = await mod();
    const end = paginateAfter(list(3), { after: 'r003', limit: 2 });
    const empty = paginateAfter([], { limit: 5 });
    return same(end.items, []) && end.nextCursor === null && same(empty.items, []) && empty.nextCursor === null;
  });
  await hidden('an unknown cursor is rejected', async () => {
    const { paginateAfter } = await mod();
    return throwsCode(() => paginateAfter(list(3), { after: 'nope', limit: 2 }), 'INVALID_CURSOR', 'ValidationError');
  });
  await hidden('limit defaults to 20 and is validated', async () => {
    const { paginateAfter } = await mod();
    const items = list(25);
    const byDefault = paginateAfter(items);
    return byDefault.items.length === 20 && byDefault.nextCursor === 'r020' && paginateAfter(items, { limit: 100 }).items.length === 25
      && [0, 101, 2.5, '5', -1].every((limit) => throwsCode(() => paginateAfter(items, { limit }), 'INVALID_LIMIT', 'ValidationError'));
  });
  await hidden('paginate is unchanged and inputs are not modified', async () => {
    const { paginate, paginateAfter } = await mod();
    const items = list(5);
    const copy = structuredClone(items);
    paginateAfter(items, { limit: 2 });
    return same(items, copy) && same(paginate(items, { page: 2, pageSize: 2 }), { items: copy.slice(2, 4), page: 2, pageSize: 2, total: 5, totalPages: 3 })
      && throwsCode(() => paginate(items, { page: 0 }), 'INVALID_PAGE');
  });
}

// ---------------------------------------------------------------- t02 maxWaitlist setting
async function t02({ load, basic, hidden }) {
  const mod = () => load('src/config/settings.mjs');
  await basic('maxWaitlist has a default and is read from the environment', async () => {
    const { loadSettings } = await mod();
    return loadSettings({}).maxWaitlist === 20 && loadSettings({ STUDIO_MAX_WAITLIST: '35' }).maxWaitlist === 35;
  });
  await hidden('an empty value means the default', async () => {
    const { loadSettings } = await mod();
    return loadSettings({ STUDIO_MAX_WAITLIST: '' }).maxWaitlist === 20;
  });
  await hidden('the smallest allowed value is 1', async () => {
    const { loadSettings } = await mod();
    return loadSettings({ STUDIO_MAX_WAITLIST: '1' }).maxWaitlist === 1;
  });
  await hidden('values that are not whole numbers from 1 are rejected', async () => {
    const { loadSettings } = await mod();
    return ['0', '-3', '2.5', '12명', 'abc', '-1', '3.0.1'].every((value) => {
      try { loadSettings({ STUDIO_MAX_WAITLIST: value }); } catch (error) { return error?.name === 'ConfigError'; }
      return false;
    });
  });
  await hidden('the other settings behave as before', async () => {
    const { loadSettings } = await mod();
    const defaults = loadSettings({});
    const set = loadSettings({ STUDIO_TIME_ZONE: 'Europe/London', STUDIO_CURRENCY: 'EUR', STUDIO_MAX_ACTIVE_BOOKINGS: '8', STUDIO_CACHE_TTL_MS: '0', STUDIO_MAX_WAITLIST: '7' });
    return defaults.timeZone === 'Asia/Seoul' && defaults.currency === 'KRW' && defaults.maxActiveBookings === 5 && defaults.cacheTtlMs === 30000
      && set.timeZone === 'Europe/London' && set.currency === 'EUR' && set.maxActiveBookings === 8 && set.cacheTtlMs === 0 && set.maxWaitlist === 7
      && throwsCode(() => loadSettings({ STUDIO_MAX_ACTIVE_BOOKINGS: '0' }), 'INVALID_SETTING', 'ConfigError')
      && throwsCode(() => loadSettings({ STUDIO_CURRENCY: 'GOLD' }), 'INVALID_SETTING', 'ConfigError');
  });
}

// ---------------------------------------------------------------- t03 display names
async function t03({ load, basic, hidden }) {
  const directory = async () => {
    const [{ MemberDirectory }, { MemoryStore }, { createIdGenerator }] = await Promise.all([
      load('src/members/directory.mjs'), load('src/store/memory-store.mjs'), load('src/util/ids.mjs')]);
    return new MemberDirectory({ store: new MemoryStore(), ids: createIdGenerator('mb') });
  };
  const taken = (promise) => rejectsCode(promise, 'NAME_TAKEN');
  const tooLong = (promise) => rejectsCode(promise, 'NAME_TOO_LONG');
  const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
  const X_ACUTE = 'x́'; // no precomposed form exists: always two code points, one character to a reader

  await basic('the same name in composed and decomposed form is one name', async () => {
    const members = await directory();
    await members.register({ displayName: 'José' });
    return await taken(members.register({ displayName: 'José' })) && (await members.list()).length === 1;
  });
  await hidden('decomposed first, composed second is also one name', async () => {
    const members = await directory();
    await members.register({ displayName: 'Zoë Brandt' });
    return taken(members.register({ displayName: 'ZOË brandt' }));
  });
  await hidden('a Hangul name typed as separate jamo equals the composed one', async () => {
    const members = await directory();
    await members.register({ displayName: '지수' });
    return taken(members.register({ displayName: '지수'.normalize('NFD') }));
  });
  await hidden('a decomposed Hangul name within the limit is accepted', async () => {
    const members = await directory();
    const name = '김민준 필라테스 선생님'; // 12 characters, 30+ jamo when decomposed
    const member = await members.register({ displayName: name.normalize('NFD') });
    return typeof member.id === 'string';
  });
  await hidden('a short name with family emoji is accepted', async () => {
    const members = await directory();
    const member = await members.register({ displayName: `Mia ${FAMILY}${FAMILY} Park` }); // 11 characters
    return typeof member.id === 'string';
  });
  await hidden('twenty characters built from combining marks are accepted', async () => {
    const members = await directory();
    const member = await members.register({ displayName: X_ACUTE.repeat(20) });
    return typeof member.id === 'string';
  });
  await hidden('twenty-one characters are still rejected', async () => {
    const members = await directory();
    return await tooLong(members.register({ displayName: 'a'.repeat(21) })) && await tooLong(members.register({ displayName: X_ACUTE.repeat(21) }))
      && await tooLong(members.register({ displayName: `${'ab '.repeat(6)}${FAMILY}${FAMILY}${FAMILY}x` })) // 6*3 + 3 + 1 = 22 characters
      && typeof (await members.register({ displayName: 'a'.repeat(20) })).id === 'string';
  });
  await hidden('names that read differently stay different', async () => {
    const members = await directory();
    await members.register({ displayName: 'Jose' });
    const accented = await members.register({ displayName: 'José' });
    await members.register({ displayName: 'Mia \u{1F468}' });
    const other = await members.register({ displayName: 'Mia \u{1F469}' });
    return typeof accented.id === 'string' && typeof other.id === 'string' && (await members.list()).length === 4;
  });
  await hidden('trimming, spaces, capitalisation and renaming work as before', async () => {
    const members = await directory();
    const bo = await members.register({ displayName: '  Bo   Kim ' });
    if (bo.displayName !== 'Bo Kim' || !(await taken(members.register({ displayName: 'bo kim' })))) return false;
    if (!(await rejectsCode(members.register({ displayName: '   ' }), 'NAME_REQUIRED'))) return false;
    await members.rename(bo.id, 'Bo Kim-Lee');
    const again = await members.register({ displayName: 'Bo Kim' });
    return again.id !== bo.id && (await members.get(bo.id)).displayName === 'Bo Kim-Lee';
  });
}

// ---------------------------------------------------------------- t04 waitlist order
async function t04({ load, basic, hidden }) {
  const mod = () => load('src/booking/waitlist.mjs');
  const entry = (memberId, tier, joinedAt) => ({ memberId, tier, joinedAt });
  const order = (list) => list.map((e) => e.memberId).join(',');

  await basic('vip before regular before trial', async () => {
    const { orderWaitlist } = await mod();
    const sorted = orderWaitlist([entry('r', 'regular', '2026-05-01T09:00:00Z'), entry('t', 'trial', '2026-05-01T08:00:00Z'), entry('v', 'vip', '2026-05-01T10:00:00Z')]);
    return order(sorted) === 'v,r,t';
  });
  await hidden('earlier joiners first within a tier', async () => {
    const { orderWaitlist } = await mod();
    const sorted = orderWaitlist([entry('r3', 'regular', '2026-05-03T09:00:00Z'), entry('v2', 'vip', '2026-05-02T09:00:00Z'), entry('r1', 'regular', '2026-05-01T09:00:00Z'),
      entry('v1', 'vip', '2026-05-01T23:00:00Z'), entry('r2', 'regular', '2026-05-02T09:00:00Z')]);
    return order(sorted) === 'v1,v2,r1,r2,r3';
  });
  await hidden('equal tier and time keep the given order', async () => {
    const { orderWaitlist } = await mod();
    const at = '2026-05-01T09:00:00Z';
    const names = ['m07', 'm03', 'm11', 'm01', 'm09', 'm05', 'm02', 'm10', 'm04', 'm08', 'm06', 'm12'];
    const sorted = orderWaitlist([...names.map((n) => entry(n, 'regular', at)), entry('v', 'vip', at), entry('late', 'regular', '2026-05-01T09:00:01Z')]);
    return order(sorted) === ['v', ...names, 'late'].join(',');
  });
  await hidden('join times are compared as instants, whatever their UTC offset', async () => {
    const { orderWaitlist } = await mod();
    // 09:00+09:00 is 00:00Z, which is before 00:30Z although its text sorts after it.
    const sorted = orderWaitlist([entry('utc', 'regular', '2026-05-01T00:30:00Z'), entry('seoul', 'regular', '2026-05-01T09:00:00+09:00')]);
    // The same instant written two ways is a tie: given order.
    const tie = orderWaitlist([entry('seoul', 'trial', '2026-05-01T09:00:00+09:00'), entry('utc', 'trial', '2026-05-01T00:00:00Z')]);
    return order(sorted) === 'seoul,utc' && order(tie) === 'seoul,utc';
  });
  await hidden('the given array is left alone and a new one is returned', async () => {
    const { orderWaitlist } = await mod();
    const input = [entry('t', 'trial', '2026-05-01T08:00:00Z'), entry('r', 'regular', '2026-05-01T09:00:00Z'), entry('v', 'vip', '2026-05-01T10:00:00Z')];
    const copy = structuredClone(input);
    const sorted = orderWaitlist(input);
    return sorted !== input && same(input, copy) && sorted.length === 3 && same(orderWaitlist([]), []);
  });
  await hidden('an unknown tier is rejected', async () => {
    const { orderWaitlist } = await mod();
    return throwsCode(() => orderWaitlist([entry('a', 'vip', '2026-05-01T08:00:00Z'), entry('b', 'gold', '2026-05-01T08:00:00Z')]), 'UNKNOWN_TIER', 'ValidationError');
  });
  await hidden('Waitlist.next and promote follow the new order', async () => {
    const { Waitlist } = await mod();
    let minute = 0;
    const waitlist = new Waitlist({ now: () => new Date(Date.UTC(2026, 4, 1, 9, minute++)) });
    if (waitlist.next() !== null || waitlist.promote() !== null) return false;
    waitlist.add('r1', 'regular'); waitlist.add('t1', 'trial'); waitlist.add('r2', 'regular'); waitlist.add('v1', 'vip'); waitlist.add('v2', 'vip');
    if (waitlist.next()?.memberId !== 'v1' || waitlist.size !== 5) return false;
    const taken = [];
    for (let i = 0; i < 5; i += 1) taken.push(waitlist.promote()?.memberId);
    return taken.join(',') === 'v1,v2,r1,r2,t1' && waitlist.size === 0 && waitlist.next() === null;
  });
  await hidden('adding, removing and listing work as before', async () => {
    const { Waitlist } = await mod();
    const waitlist = new Waitlist({ maxSize: 2 });
    waitlist.add('a'); waitlist.add('b', 'vip');
    return throwsCode(() => waitlist.add('a'), 'ALREADY_WAITING') && throwsCode(() => waitlist.add('c'), 'WAITLIST_FULL')
      && order(waitlist.entries()) === 'a,b' && waitlist.remove('a') === true && waitlist.remove('a') === false && waitlist.size === 1;
  });
}

// ---------------------------------------------------------------- t05 formatDuration
async function t05({ load, basic, hidden }) {
  const mod = () => load('src/util/duration.mjs');
  await basic('minutes and hours with minutes', async () => {
    const { formatDuration } = await mod();
    return formatDuration(45) === '45m' && formatDuration(90) === '1h 30m';
  });
  await hidden('a zero part is left out', async () => {
    const { formatDuration } = await mod();
    return formatDuration(120) === '2h' && formatDuration(60) === '1h' && formatDuration(1500) === '25h' && formatDuration(1501) === '25h 1m';
  });
  await hidden('zero minutes is 0m', async () => {
    const { formatDuration } = await mod();
    return formatDuration(0) === '0m' && formatDuration(1) === '1m' && formatDuration(59) === '59m';
  });
  await hidden('anything but a non-negative integer is rejected', async () => {
    const { formatDuration } = await mod();
    return [-5, 1.5, '90', Number.NaN, null, undefined, Infinity].every((value) => throwsCode(() => formatDuration(value), 'INVALID_DURATION', 'ValidationError'));
  });
}

// ---------------------------------------------------------------- t06 splitCharge
async function t06({ load, basic, hidden }) {
  const mod = () => load('src/billing/split.mjs');
  const UNITS = { KRW: 0, JPY: 0, USD: 2, EUR: 2, KWD: 3 };
  // The checker's own reading of amount text: exactly the currency's decimals, no sign, canonical digits.
  const minor = (text, currency) => {
    const units = UNITS[currency];
    const pattern = units === 0 ? /^(0|[1-9]\d*)$/ : new RegExp(`^(0|[1-9]\\d*)\\.(\\d{${units}})$`);
    const match = typeof text === 'string' ? pattern.exec(text) : null;
    return match ? BigInt(match[1]) * 10n ** BigInt(units) + BigInt(match[2] ?? 0) : null;
  };
  // Every share is chargeable, the shares add up to the total, and no share is a whole minor unit or more away
  // from total * weight / sum. Any split with these properties is accepted.
  const fair = (splitCharge, total, currency, weights) => {
    const shares = splitCharge(total, currency, weights);
    if (!Array.isArray(shares) || shares.length !== weights.length) return false;
    const parsed = shares.map((share) => minor(share, currency));
    if (parsed.some((value) => value === null)) return false;
    const totalMinor = minor(total, currency);
    const sum = weights.reduce((a, w) => a + BigInt(w), 0n);
    if (parsed.reduce((a, b) => a + b, 0n) !== totalMinor) return false;
    return parsed.every((value, i) => {
      const scaled = value * sum - totalMinor * BigInt(weights[i]); // (share - exact) * sum
      return scaled > -sum && scaled < sum;
    });
  };

  await basic('even and weighted splits that divide exactly', async () => {
    const { splitCharge } = await mod();
    return same(splitCharge('100.00', 'USD', [1, 1]), ['50.00', '50.00']) && same(splitCharge('90.00', 'USD', [2, 1]), ['60.00', '30.00']);
  });
  await hidden('shares add up when the amount does not divide', async () => {
    const { splitCharge } = await mod();
    return [['100.00', [1, 1, 1]], ['0.10', [1, 1, 1]], ['20.00', [1, 1, 1, 1, 1, 1]], ['99.99', [1, 2]], ['1000.00', [3, 3, 1]], ['33.34', [1, 1, 1, 1, 1, 1, 1]]]
      .every(([total, weights]) => fair(splitCharge, total, 'USD', weights));
  });
  await hidden('nobody is more than one minor unit off their share', async () => {
    const { splitCharge } = await mod();
    return [['0.05', [1, 1, 1, 1, 1, 1, 1]], ['0.02', [1, 1, 1, 1, 1]], ['0.01', [5, 1]], ['1.00', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]], ['0.07', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]]]
      .every(([total, weights]) => fair(splitCharge, total, 'USD', weights));
  });
  await hidden('currencies without decimals get whole amounts', async () => {
    const { splitCharge } = await mod();
    return same(splitCharge('30000', 'KRW', [1, 1, 1]), ['10000', '10000', '10000'])
      && [['10000', 'KRW', [1, 1, 1]], ['55000', 'KRW', [2, 1, 1, 1, 1, 1, 1]], ['1000', 'JPY', [1, 1, 1]], ['7', 'KRW', [1, 1, 1, 1]]]
        .every(([total, currency, weights]) => fair(splitCharge, total, currency, weights));
  });
  await hidden('currencies with three decimals keep three decimals', async () => {
    const { splitCharge } = await mod();
    return same(splitCharge('3.000', 'KWD', [1, 1]), ['1.500', '1.500'])
      && [['10.000', [1, 1, 1]], ['0.005', [1, 1]], ['12.345', [3, 2, 2]]].every(([total, weights]) => fair(splitCharge, total, 'KWD', weights));
  });
  await hidden('many totals and weights', async () => {
    const { splitCharge } = await mod();
    let seed = 20261125;
    const next = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 300; round += 1) {
      const currency = ['USD', 'KRW', 'KWD', 'EUR', 'JPY'][next(5)];
      const units = UNITS[currency];
      const amount = next(2000000) + 1;
      const digits = String(amount).padStart(units + 1, '0');
      const total = units === 0 ? digits : `${digits.slice(0, -units)}.${digits.slice(-units)}`;
      const weights = Array.from({ length: next(9) + 1 }, () => next(12) + 1);
      if (!fair(splitCharge, total, currency, weights)) return false;
    }
    return true;
  });
  await hidden('one payer pays everything and weights are validated', async () => {
    const { splitCharge } = await mod();
    return same(splitCharge('19.99', 'USD', [4]), ['19.99']) && same(splitCharge('0.00', 'USD', [1, 2]), ['0.00', '0.00'])
      && [[], [1, 0], [1, -1], [1.5, 1], ['2', 1], [1, Number.NaN]].every((weights) => throwsCode(() => splitCharge('10.00', 'USD', weights), 'INVALID_WEIGHTS', 'ValidationError'));
  });
}

// ---------------------------------------------------------------- t07 idempotent payments
async function t07({ load, basic, hidden }) {
  const setup = async (wrap = (store) => store) => {
    const [{ Ledger }, { MemoryStore }, { createIdGenerator }] = await Promise.all([
      load('src/payments/ledger.mjs'), load('src/store/memory-store.mjs'), load('src/util/ids.mjs')]);
    const inner = new MemoryStore();
    return { ledger: new Ledger({ store: wrap(inner), ids: createIdGenerator('pay') }), store: inner };
  };
  const pay = (extra = {}) => ({ memberId: 'mb-1', amount: '25.00', currency: 'USD', reference: 'June pass', ...extra });

  await basic('a retried delivery returns the first entry and adds nothing', async () => {
    const { ledger } = await setup();
    const first = await ledger.recordPayment(pay({ idempotencyKey: 'evt-1' }));
    const again = await ledger.recordPayment(pay({ idempotencyKey: 'evt-1' }));
    const entries = await ledger.entriesFor('mb-1');
    return typeof first.id === 'string' && again.id === first.id && entries.length === 1 && first.amountMinor === 2500;
  });
  await hidden('deliveries that overlap produce one entry', async () => {
    const { ledger } = await setup();
    const results = await settle(Array.from({ length: 6 }, () => ledger.recordPayment(pay({ idempotencyKey: 'evt-2' }))));
    const entries = await ledger.entriesFor('mb-1');
    return fulfilled(results).length === 6 && new Set(fulfilled(results).map((r) => r.value.id)).size === 1 && entries.length === 1
      && (await ledger.balance('mb-1', 'USD')) === '25.00';
  });
  await hidden('a key reused for another payment is a conflict and records nothing', async () => {
    const { ledger } = await setup();
    await ledger.recordPayment(pay({ idempotencyKey: 'evt-3' }));
    const conflicts = await Promise.all([
      rejectsCode(ledger.recordPayment(pay({ idempotencyKey: 'evt-3', amount: '26.00' })), 'IDEMPOTENCY_MISMATCH', 'ConflictError'),
      rejectsCode(ledger.recordPayment(pay({ idempotencyKey: 'evt-3', memberId: 'mb-2' })), 'IDEMPOTENCY_MISMATCH', 'ConflictError'),
      rejectsCode(ledger.recordPayment(pay({ idempotencyKey: 'evt-3', amount: '25', currency: 'KRW' })), 'IDEMPOTENCY_MISMATCH', 'ConflictError'),
    ]);
    return conflicts.every(Boolean) && (await ledger.entriesFor('mb-1')).length === 1 && (await ledger.entriesFor('mb-2')).length === 0;
  });
  await hidden('overlapping deliveries with one key and different payments record one entry', async () => {
    const { ledger } = await setup();
    const results = await settle([ledger.recordPayment(pay({ idempotencyKey: 'evt-4' })), ledger.recordPayment(pay({ idempotencyKey: 'evt-4', amount: '99.00' }))]);
    return fulfilled(results).length === 1 && rejectedWith(results, 'IDEMPOTENCY_MISMATCH').length === 1 && (await ledger.entriesFor('mb-1')).length === 1;
  });
  await hidden('a delivery retried after it failed is recorded once', async () => {
    let failures = 1;
    const { ledger } = await setup((inner) => ({
      get: (key) => inner.get(key),
      list: (prefix) => inner.list(prefix),
      delete: (key) => inner.delete(key),
      async set(key, value) {
        if (failures > 0) { failures -= 1; await inner.get('warm-up'); throw new Error('store unavailable'); }
        return inner.set(key, value);
      },
    }));
    const first = await settle([ledger.recordPayment(pay({ idempotencyKey: 'evt-5' }))]);
    if (first[0].status !== 'rejected') return false;
    const retry = await ledger.recordPayment(pay({ idempotencyKey: 'evt-5' }));
    const third = await ledger.recordPayment(pay({ idempotencyKey: 'evt-5' }));
    return typeof retry.id === 'string' && third.id === retry.id && (await ledger.entriesFor('mb-1')).length === 1;
  });
  await hidden('different keys and calls without a key are separate payments', async () => {
    const { ledger } = await setup();
    const a = await ledger.recordPayment(pay({ idempotencyKey: 'evt-6' }));
    const b = await ledger.recordPayment(pay({ idempotencyKey: 'evt-7' }));
    const c = await ledger.recordPayment(pay());
    const d = await ledger.recordPayment(pay());
    return new Set([a.id, b.id, c.id, d.id]).size === 4 && (await ledger.entriesFor('mb-1')).length === 4 && (await ledger.balance('mb-1', 'USD')) === '100.00';
  });
  await hidden('validation and the entry shape are as before', async () => {
    const { ledger } = await setup();
    const entry = await ledger.recordPayment(pay({ idempotencyKey: 'evt-8' }));
    return entry.memberId === 'mb-1' && entry.currency === 'USD' && entry.reference === 'June pass' && typeof entry.recordedAt === 'string'
      && await rejectsCode(ledger.recordPayment(pay({ amount: '0.00' })), 'INVALID_AMOUNT')
      && await rejectsCode(ledger.recordPayment(pay({ memberId: '' })), 'MEMBER_REQUIRED')
      && same((await ledger.entriesFor('mb-1')).map((e) => e.id), [entry.id]);
  });
}

// ---------------------------------------------------------------- t08 overbooking
async function t08({ load, basic, hidden }) {
  const setup = async (capacity, sessions = ['s1']) => {
    const [{ BookingService }, { MemoryStore }, { createIdGenerator }] = await Promise.all([
      load('src/booking/booking-service.mjs'), load('src/store/memory-store.mjs'), load('src/util/ids.mjs')]);
    const bookings = new BookingService({ store: new MemoryStore(), ids: createIdGenerator('bk') });
    for (const id of sessions) await bookings.addSession({ id, title: 'Pilates', startsAt: '2026-06-02T10:00:00Z', capacity });
    return bookings;
  };
  const members = (n, prefix = 'm') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

  await basic('two requests for the last seat give one booking', async () => {
    const bookings = await setup(2);
    await bookings.bookSeat('s1', 'early');
    const results = await settle([bookings.bookSeat('s1', 'm1'), bookings.bookSeat('s1', 'm2')]);
    return fulfilled(results).length === 1 && (await bookings.listBookings('s1')).length === 2;
  });
  await hidden('a rush fills the session exactly and turns the rest away as FULL', async () => {
    const bookings = await setup(5);
    const results = await settle(members(30).map((m) => bookings.bookSeat('s1', m)));
    const stored = await bookings.listBookings('s1');
    return fulfilled(results).length === 5 && rejectedWith(results, 'FULL').length === 25 && stored.length === 5
      && new Set(stored.map((b) => b.memberId)).size === 5 && (await bookings.seatsLeft('s1')) === 0;
  });
  await hidden('one member clicking many times gets one booking', async () => {
    const bookings = await setup(10);
    const results = await settle(Array.from({ length: 6 }, () => bookings.bookSeat('s1', 'same')));
    return fulfilled(results).length === 1 && rejectedWith(results, 'ALREADY_BOOKED').length === 5 && (await bookings.listBookings('s1')).length === 1;
  });
  await hidden('booking keeps working after requests were turned away', async () => {
    const bookings = await setup(2);
    const results = await settle(members(6).map((m) => bookings.bookSeat('s1', m)));
    if (fulfilled(results).length !== 2) return false;
    if (!(await rejectsCode(bookings.bookSeat('s1', 'late'), 'FULL', 'BookingError'))) return false;
    await bookings.cancel('s1', fulfilled(results)[0].value.id);
    const booked = await bookings.bookSeat('s1', 'after-cancel');
    return booked.memberId === 'after-cancel' && (await bookings.listBookings('s1')).length === 2
      && await rejectsCode(bookings.bookSeat('nope', 'm1'), 'SESSION_NOT_FOUND') && await rejectsCode(bookings.bookSeat('s1', 'after-cancel'), 'ALREADY_BOOKED');
  });
  await hidden('a rush on one session does not disturb another', async () => {
    const bookings = await setup(3, ['s1', 's2']);
    const results = await settle([...members(8).map((m) => bookings.bookSeat('s1', m)), ...members(8).map((m) => bookings.bookSeat('s2', m))]);
    return fulfilled(results).length === 6 && (await bookings.listBookings('s1')).length === 3 && (await bookings.listBookings('s2')).length === 3;
  });
  await hidden('several rushes in a row never go over capacity', async () => {
    const bookings = await setup(4);
    for (let wave = 0; wave < 3; wave += 1) {
      const results = await settle(members(7, `w${wave}-`).map((m) => bookings.bookSeat('s1', m)));
      const stored = await bookings.listBookings('s1');
      if (stored.length !== 4 || fulfilled(results).length !== (wave === 0 ? 4 : 2)) return false;
      await bookings.cancel('s1', stored[0].id);
      await bookings.cancel('s1', stored[1].id);
    }
    return (await bookings.seatsLeft('s1')) === 2;
  });
  await hidden('one-at-a-time behaviour is as before', async () => {
    const bookings = await setup(2);
    const a = await bookings.bookSeat('s1', 'm1');
    await bookings.bookSeat('s1', 'm2');
    return a.status === 'active' && a.sessionId === 's1' && await rejectsCode(bookings.bookSeat('s1', 'm3'), 'FULL', 'BookingError')
      && await rejectsCode(bookings.bookSeat('s1', 'm1'), 'ALREADY_BOOKED', 'BookingError')
      && (await bookings.cancel('s1', a.id)).status === 'cancelled' && await rejectsCode(bookings.cancel('s1', a.id), 'BOOKING_NOT_FOUND')
      && (await bookings.seatsLeft('s1')) === 1;
  });
}

// ---------------------------------------------------------------- t09 toCsv
async function t09({ load, basic, hidden }) {
  const mod = () => load('src/reports/csv.mjs');
  await basic('a header line and one line per row', async () => {
    const { toCsv } = await mod();
    return toCsv([{ name: 'Bo', visits: 3 }, { name: 'Ann', visits: 12 }], ['name', 'visits']) === 'name,visits\nBo,3\nAnn,12';
  });
  await hidden('quotes inside a quoted cell are doubled', async () => {
    const { toCsv } = await mod();
    return toCsv([{ note: 'said "hi"' }], ['note']) === 'note\n"said ""hi"""';
  });
  await hidden('commas and line breaks are quoted', async () => {
    const { toCsv } = await mod();
    return toCsv([{ a: 'Kim, Bo', b: 'line one\nline two' }], ['a', 'b']) === 'a,b\n"Kim, Bo","line one\nline two"';
  });
  await hidden('null and undefined are empty, other values are kept', async () => {
    const { toCsv } = await mod();
    return toCsv([{ a: null, b: undefined, c: 0, d: false, e: '' }, { a: 1 }], ['a', 'b', 'c', 'd', 'e']) === 'a,b,c,d,e\n,,0,false,\n1,,,,';
  });
  await hidden('the header follows the same rule and columns choose the order', async () => {
    const { toCsv } = await mod();
    return toCsv([{ 'last, first': 'Kim, Bo', id: 7, ignored: 'x' }], ['id', 'last, first']) === 'id,"last, first"\n7,"Kim, Bo"';
  });
  await hidden('no rows gives the header only, without a trailing line break', async () => {
    const { toCsv } = await mod();
    return toCsv([], ['a', 'b']) === 'a,b' && !toCsv([{ a: 1 }], ['a']).endsWith('\n');
  });
}

// ---------------------------------------------------------------- t10 weekly classes across clock changes
async function t10({ load, basic, hidden }) {
  const mod = () => load('src/schedule/recurrence.mjs');
  // The checker's own conversion, independent of the project: the instant whose wall-clock reading in the zone is the given one.
  const reading = (ms, timeZone) => {
    const parts = {};
    for (const part of new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(ms))) parts[part.type] = part.value;
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  };
  const instantAt = (local, timeZone) => {
    const [y, mo, d, h, mi] = local.match(/\d+/g).map(Number);
    const naive = Date.UTC(y, mo - 1, d, h, mi);
    for (let offset = -16 * 60; offset <= 16 * 60; offset += 15) {
      if (reading(naive - offset * 60000, timeZone) === local) return naive - offset * 60000;
    }
    throw new Error(`no instant for ${local} in ${timeZone}`);
  };
  const weekly = (start, timeZone, count, skip = []) => {
    const [y, mo, d, h, mi] = start.match(/\d+/g).map(Number);
    const out = [];
    for (let week = 0; out.length < count; week += 1) {
      const day = new Date(Date.UTC(y, mo - 1, d + 7 * week, h, mi));
      const local = `${day.toISOString().slice(0, 10)}T${day.toISOString().slice(11, 16)}`;
      if (skip.includes(local.slice(0, 10))) continue;
      out.push(new Date(instantAt(local, timeZone)).toISOString());
    }
    return out;
  };
  const NY_SPRING = { start: '2026-03-03T18:00', timeZone: 'America/New_York' };
  const NY_AUTUMN = { start: '2026-10-20T18:00', timeZone: 'America/New_York' };

  await basic('the New York class from the report keeps its time in March', async () => {
    const { expandWeekly } = await mod();
    return same(expandWeekly(NY_SPRING, 3), ['2026-03-03T23:00:00.000Z', '2026-03-10T22:00:00.000Z', '2026-03-17T22:00:00.000Z']);
  });
  await hidden('New York in autumn', async () => {
    const { expandWeekly } = await mod();
    return same(expandWeekly(NY_AUTUMN, 3), ['2026-10-20T22:00:00.000Z', '2026-10-27T22:00:00.000Z', '2026-11-03T23:00:00.000Z']);
  });
  await hidden('London, whose clocks change on other dates', async () => {
    const { expandWeekly } = await mod();
    return same(expandWeekly({ start: '2026-03-24T07:15', timeZone: 'Europe/London' }, 2), ['2026-03-24T07:15:00.000Z', '2026-03-31T06:15:00.000Z'])
      && same(expandWeekly({ start: '2026-10-20T07:15', timeZone: 'Europe/London' }, 2), ['2026-10-20T06:15:00.000Z', '2026-10-27T07:15:00.000Z']);
  });
  await hidden('Sydney, where the change goes the other way', async () => {
    const { expandWeekly } = await mod();
    return same(expandWeekly({ start: '2026-03-30T06:30', timeZone: 'Australia/Sydney' }, 2), ['2026-03-29T19:30:00.000Z', '2026-04-05T20:30:00.000Z'])
      && same(expandWeekly({ start: '2026-09-28T06:30', timeZone: 'Australia/Sydney' }, 2), ['2026-09-27T20:30:00.000Z', '2026-10-04T19:30:00.000Z']);
  });
  await hidden('a whole year of sessions in several zones', async () => {
    const { expandWeekly } = await mod();
    return [['2026-01-06T18:00', 'America/New_York'], ['2026-01-05T07:15', 'Europe/London'], ['2026-01-05T06:30', 'Australia/Sydney'],
      ['2026-01-07T21:45', 'America/Sao_Paulo'], ['2026-01-08T12:00', 'Pacific/Auckland'], ['2026-01-09T23:30', 'Europe/Berlin']]
      .every(([start, timeZone]) => same(expandWeekly({ start, timeZone }, 60), weekly(start, timeZone, 60)));
  });
  await hidden('zones without clock changes are as before', async () => {
    const { expandWeekly, sessionsInRange } = await mod();
    const seoul = { start: '2026-01-06T19:30', timeZone: 'Asia/Seoul' };
    return same(expandWeekly(seoul, 3), ['2026-01-06T10:30:00.000Z', '2026-01-13T10:30:00.000Z', '2026-01-20T10:30:00.000Z'])
      && same(expandWeekly({ start: '2026-03-01T06:00', timeZone: 'Asia/Kathmandu' }, 2), ['2026-03-01T00:15:00.000Z', '2026-03-08T00:15:00.000Z'])
      && same(sessionsInRange(seoul, '2026-01-13T10:30:00Z', '2026-01-27T10:30:00Z'), ['2026-01-13T10:30:00.000Z', '2026-01-20T10:30:00.000Z'])
      && same(sessionsInRange(seoul, '2025-12-01T00:00:00Z', '2026-01-06T10:30:00Z'), []) && same(expandWeekly(seoul, 0), []);
  });
  await hidden('a range finds the session at its real time after the clocks went forward', async () => {
    const { sessionsInRange } = await mod();
    return same(sessionsInRange(NY_SPRING, '2026-03-10T21:30:00Z', '2026-03-10T22:30:00Z'), ['2026-03-10T22:00:00.000Z'])
      && same(sessionsInRange(NY_SPRING, '2026-03-10T22:30:00Z', '2026-03-11T00:00:00Z'), []);
  });
  await hidden('a range finds the session at its real time after the clocks went back', async () => {
    const { sessionsInRange } = await mod();
    return same(sessionsInRange(NY_AUTUMN, '2026-11-03T22:30:00Z', '2026-11-04T00:00:00Z'), ['2026-11-03T23:00:00.000Z'])
      && same(sessionsInRange(NY_AUTUMN, '2026-11-03T21:30:00Z', '2026-11-03T22:30:00Z'), []);
  });
  await hidden('a range includes its start, excludes its end and matches the expanded list', async () => {
    const { sessionsInRange, expandWeekly } = await mod();
    const year = expandWeekly(NY_SPRING, 44).filter((iso) => iso < '2027-01-01T00:00:00.000Z');
    return same(sessionsInRange(NY_SPRING, '2026-03-10T22:00:00Z', '2026-03-17T22:00:00Z'), ['2026-03-10T22:00:00.000Z'])
      && same(sessionsInRange(NY_SPRING, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'), year) && year.length === 44
      && same(sessionsInRange(NY_SPRING, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z'), []);
  });
  await hidden('except dates are still skipped, by studio-local date', async () => {
    const { expandWeekly, sessionsInRange } = await mod();
    const sydney = { start: '2026-03-30T06:30', timeZone: 'Australia/Sydney', except: ['2026-04-06'] };
    return same(expandWeekly({ ...NY_SPRING, except: ['2026-03-10'] }, 2), ['2026-03-03T23:00:00.000Z', '2026-03-17T22:00:00.000Z'])
      && same(expandWeekly(sydney, 2), ['2026-03-29T19:30:00.000Z', '2026-04-12T20:30:00.000Z'])
      && same(sessionsInRange({ ...NY_SPRING, except: ['2026-03-10', '2026-03-24'] }, '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'),
        ['2026-03-03T23:00:00.000Z', '2026-03-17T22:00:00.000Z', '2026-03-31T22:00:00.000Z']);
  });
  await hidden('invalid input is rejected as before', async () => {
    const { expandWeekly, sessionsInRange } = await mod();
    return throwsCode(() => expandWeekly(NY_SPRING, -1), 'INVALID_COUNT') && throwsCode(() => expandWeekly({ start: '2026-03-03T18:00', timeZone: 'Mars/Base' }, 1), 'UNKNOWN_TIME_ZONE')
      && throwsCode(() => sessionsInRange(NY_SPRING, 'soon', '2026-04-01T00:00:00Z'), 'INVALID_RANGE');
  });
}

// ---------------------------------------------------------------- t11 cache writes
async function t11({ load, basic, hidden }) {
  // The checker's own backing store, so that reads can be counted without relying on any project module but the cache.
  const backing = (initial = {}) => {
    const data = new Map(Object.entries(initial));
    const calls = { get: [], list: [], set: 0, delete: 0 };
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    return {
      calls, data,
      async get(key) { await turn(); calls.get.push(key); return data.has(key) ? structuredClone(data.get(key)) : null; },
      async list(prefix = '') { await turn(); calls.list.push(prefix); return [...data.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => ({ key, value: structuredClone(value) })); },
      async set(key, value) { await turn(); calls.set += 1; data.set(key, structuredClone(value)); },
      async delete(key) { await turn(); calls.delete += 1; return data.delete(key); },
    };
  };
  const cacheOver = async (store, options) => new (await load('src/store/cache.mjs')).CachedStore(store, options);
  const keys = (rows) => rows.map((row) => row.key).join(',');

  await basic('set writes through and the new value is read back', async () => {
    const store = backing();
    const cache = await cacheOver(store);
    await cache.set('member:1', { name: 'Bo' });
    return same(store.data.get('member:1'), { name: 'Bo' }) && same(await cache.get('member:1'), { name: 'Bo' });
  });
  await hidden('a cached value is replaced by a write', async () => {
    const store = backing({ 'member:1': { name: 'Bo' } });
    const cache = await cacheOver(store);
    await cache.get('member:1');
    await cache.set('member:1', { name: 'Bo Kim' });
    return same(await cache.get('member:1'), { name: 'Bo Kim' }) && same(store.data.get('member:1'), { name: 'Bo Kim' });
  });
  await hidden('a remembered "not there" is forgotten when the key is written', async () => {
    const store = backing();
    const cache = await cacheOver(store);
    if ((await cache.get('member:7')) !== null) return false;
    await cache.set('member:7', { name: 'Ann' });
    return same(await cache.get('member:7'), { name: 'Ann' });
  });
  await hidden('delete removes the key from the store and from the cache', async () => {
    const store = backing({ 'member:1': { name: 'Bo' } });
    const cache = await cacheOver(store);
    await cache.get('member:1');
    await cache.delete('member:1');
    return (await cache.get('member:1')) === null && !store.data.has('member:1');
  });
  await hidden('listings show a new key after set', async () => {
    const store = backing({ 'member:1': { name: 'Bo' } });
    const cache = await cacheOver(store);
    if (keys(await cache.list('member:')) !== 'member:1' || keys(await cache.list('')) !== 'member:1') return false;
    await cache.set('member:2', { name: 'Ann' });
    return keys(await cache.list('member:')) === 'member:1,member:2' && keys(await cache.list('')) === 'member:1,member:2';
  });
  await hidden('listings show changed values and drop deleted keys', async () => {
    const store = backing({ 'member:1': { name: 'Bo' }, 'member:2': { name: 'Ann' } });
    const cache = await cacheOver(store);
    await cache.list('member:');
    await cache.set('member:1', { name: 'Bo Kim' });
    const afterSet = await cache.list('member:');
    await cache.delete('member:2');
    return same(afterSet.map((row) => row.value.name), ['Bo Kim', 'Ann']) && keys(await cache.list('member:')) === 'member:1';
  });
  await hidden('other keys stay cached across a write', async () => {
    const store = backing({ 'member:1': { name: 'Bo' }, 'member:2': { name: 'Ann' }, 'session:9': { title: 'Yoga' } });
    const cache = await cacheOver(store);
    await cache.get('member:2'); await cache.get('session:9'); await cache.get('member:404');
    const before = store.calls.get.length;
    await cache.set('member:1', { name: 'Bo Kim' });
    await cache.delete('member:3');
    const values = [await cache.get('member:2'), await cache.get('session:9'), await cache.get('member:404')];
    const reread = store.calls.get.slice(before).filter((key) => ['member:2', 'session:9', 'member:404'].includes(key));
    return same(values, [{ name: 'Ann' }, { title: 'Yoga' }, null]) && reread.length === 0;
  });
  await hidden('expiry and clear work as before', async () => {
    const store = backing({ 'member:1': { name: 'Bo' } });
    let clock = 1000;
    const cache = await cacheOver(store, { ttlMs: 500, now: () => clock });
    await cache.get('member:1'); await cache.get('member:1'); await cache.list('member:'); await cache.list('member:');
    if (store.calls.get.length !== 1 || store.calls.list.length !== 1) return false;
    clock += 600;
    await cache.get('member:1'); await cache.list('member:');
    if (store.calls.get.length !== 2 || store.calls.list.length !== 2) return false;
    cache.clear();
    await cache.get('member:1');
    return store.calls.get.length === 3;
  });
}

// ---------------------------------------------------------------- t12 contact helpers
async function t12({ load, basic, hidden }) {
  const mod = () => load('src/members/contact.mjs');
  await basic('normalizes and masks the example address', async () => {
    const { normalizeEmail, maskEmail } = await mod();
    return normalizeEmail('  Jane.Doe@Example.com ') === 'jane.doe@example.com' && maskEmail('Jane.Doe@Example.com') === 'j*******@example.com';
  });
  await hidden('the mask is as long as the part it hides', async () => {
    const { maskEmail } = await mod();
    return maskEmail(' Bob@Gym.KR ') === 'b**@gym.kr' && maskEmail('a@x.io') === 'a@x.io' && maskEmail('al@x.io') === 'a*@x.io'
      && maskEmail('membership.office@studio.example') === `m${'*'.repeat(16)}@studio.example`;
  });
  await hidden('addresses without exactly one @ are rejected', async () => {
    const { normalizeEmail } = await mod();
    return ['nope', 'a@b@c', 'a@@b.com', 'x@y@z.com'].every((value) => throwsCode(() => normalizeEmail(value), 'INVALID_EMAIL', 'ValidationError'));
  });
  await hidden('something must stand on both sides of the @', async () => {
    const { normalizeEmail } = await mod();
    return ['@x.com', 'x@', '@', '   ', ' @x.com '].every((value) => throwsCode(() => normalizeEmail(value), 'INVALID_EMAIL', 'ValidationError'));
  });
  await hidden('maskEmail rejects what normalizeEmail rejects', async () => {
    const { maskEmail } = await mod();
    return ['nope', 'a@b@c', '@x.com'].every((value) => throwsCode(() => maskEmail(value), 'INVALID_EMAIL', 'ValidationError'));
  });
}

export const PROBES = { t01, t02, t03, t04, t05, t06, t07, t08, t09, t10, t11, t12 };
