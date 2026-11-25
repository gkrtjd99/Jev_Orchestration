// One probe per task. A probe imports the project's own modules, exercises them with fixed inputs and reads
// a few files. It never writes. Each returns { done, convention, details } where details is a list of
// { check, ok, note? }; "done.*" checks decide `done`, "conv.*" checks decide `convention`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const read = (root, rel) => {
  try { return readFileSync(join(root, rel), 'utf8'); } catch { return null; }
};
const load = (project, rel) => import(pathToFileURL(join(project, rel)).href);
const message = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 200);
const isInt = (value) => Number.isInteger(value);
const fileLines = (text) => (text ?? '').split('\n').map((line) => line.replace(/\r$/, ''));

function recorder() {
  const details = [];
  const add = (check, ok, note) => {
    details.push(note === undefined ? { check, ok: Boolean(ok) } : { check, ok: Boolean(ok), note: String(note) });
    return Boolean(ok);
  };
  const verdict = (isSkillTask) => {
    const all = (prefix) => {
      const picked = details.filter((d) => d.check.startsWith(prefix));
      return picked.length > 0 && picked.every((d) => d.ok);
    };
    const done = all('done.');
    return { done, convention: isSkillTask ? done && all('conv.') : null, details, blockedBy: [...blockedBy].sort() };
  };
  // Records that this task's result depends on a file of another task that cannot be loaded. The pair is
  // then reported as contaminated; the "blocked.*" detail is not part of `done` or `convention`.
  const blockedBy = new Set();
  const block = (taskId, note) => {
    blockedBy.add(taskId);
    details.push({ check: 'blocked.other_task_file', ok: false, note: String(note) });
  };
  return { add, verdict, block };
}

// Which of the given files of other tasks cannot be imported: [{ file, task, error }].
async function broken(project, files) {
  const out = [];
  for (const [file, task] of files) {
    if (!existsSync(join(project, file))) { out.push({ file, task, error: 'file is missing' }); continue; }
    try { await load(project, file); } catch (error) { out.push({ file, task, error: message(error) }); }
  }
  return out;
}

// Leaves of a JSON-like value as [path, value].
function leaves(value, path = '', out = []) {
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) leaves(child, path ? `${path}.${key}` : key, out);
  } else out.push([path, value]);
  return out;
}
const containsNumber = (value, wanted) => leaves(value).some(([, leaf]) => leaf === wanted);

// ---------------------------------------------------------------- t01: overdue parcels list
async function t01(project) {
  const { add, verdict } = recorder();
  const now = new Date('2026-11-20T12:00:00.000Z');
  const parcel = (id, status, arrivedAt, extra = {}) => ({
    id, lockerId: 'L-A1', compartment: 1, recipient: `Recipient ${id}`, phone: '010-0000-0000', sender: 'Sender',
    status, arrivedAt, collectedAt: null, pickupCode: null, codeExpiresAt: arrivedAt, ...extra,
  });
  const parcels = [
    parcel('PX101', 'stored', '2026-11-01T02:30:00.000Z'), // 19.4 days
    parcel('PX203', 'stored', '2026-11-18T08:00:00.000Z'), // 2 days: not overdue
    parcel('PX102', 'stored', '2026-11-10T09:05:00.000Z', { lockerId: 'L-B2' }), // 10.1 days
    parcel('PX304', 'collected', '2026-10-01T00:00:00.000Z', { collectedAt: '2026-10-02T00:00:00.000Z' }),
  ];
  let text;
  try {
    const module = await load(project, 'src/reports/overdue-parcels.mjs');
    text = await module.overdueParcelsCsv(parcels, now);
  } catch (error) {
    add('done.callable', false, message(error));
    return verdict(true);
  }
  if (!add('done.returns_text', typeof text === 'string' && text.length > 0)) return verdict(true);
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const lineOf = (id) => lines.find((line) => line.includes(id)) ?? '';
  add('done.overdue_included', lineOf('PX101') !== '' && lineOf('PX102') !== '');
  add('done.others_excluded', !text.includes('PX203') && !text.includes('PX304'));
  add('done.locker_and_recipient', lineOf('PX101').includes('L-A1') && lineOf('PX101').includes('Recipient PX101')
    && lineOf('PX102').includes('L-B2'));
  add('done.days_waiting', /(^|[^0-9])19([^0-9]|$)/.test(lineOf('PX101').replace(/2026[0-9T:.Z-]*/g, ''))
    && /(^|[^0-9])10([^0-9]|$)/.test(lineOf('PX102').replace(/2026[0-9T:.Z-]*/g, '')));

  // conventions
  const crlfOnly = text.endsWith('\r\n') && !/[\r\n]/.test(text.replaceAll('\r\n', ''));
  const strict = text.split('\r\n');
  add('conv.first_line', /^#pd-export v2 name=[a-z0-9]+(-[a-z0-9]+)* rows=2$/.test(strict[0] ?? ''), strict[0]?.slice(0, 80));
  add('conv.crlf_every_line', crlfOnly && strict.length === 5 && strict[4] === '');
  const fieldCounts = strict.slice(1, 4).map((line) => line.split(';').length);
  add('conv.semicolon_fields', fieldCounts.length === 3 && fieldCounts.every((count) => count === 5) && !/,/.test(strict[1] ?? ''),
    `fields per line: ${fieldCounts.join(',')}`);
  add('conv.snake_case_columns', (strict[1] ?? '').split(';').every((name) => /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name)), strict[1]?.slice(0, 80));
  add('conv.compact_utc_time', lineOf('PX101').split(';').includes('20261101T0230Z') && lineOf('PX102').split(';').includes('20261110T0905Z')
    && !/\d{4}-\d{2}-\d{2}/.test(text));
  return verdict(true);
}

// ---------------------------------------------------------------- t02: door alert delay as a setting
async function t02(project, template) {
  const { add, verdict } = recorder();
  const source = read(project, 'src/config/settings.mjs');
  const original = read(template, 'src/config/settings.mjs');
  const tokens = (text) => new Set((text ?? '').match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? []);
  // Candidate variable names: upper-case tokens that are new in settings.mjs, .env.example or docs/settings.md,
  // those tokens joined to a known or new prefix (a name built as PREFIX + 'NAME'), and, further down, every
  // name loadSettings actually reads from its env argument.
  const DOCS = ['.env.example', 'docs/settings.md'];
  const known = new Set([original, ...DOCS.map((rel) => read(template, rel))].flatMap((text) => [...tokens(text)]));
  const fresh = [...new Set([source, ...DOCS.map((rel) => read(project, rel))].flatMap((text) => [...tokens(text)]))].filter((token) => !known.has(token));
  const prefixes = [...new Set(['PARCELDESK_', 'PDESK_', ...fresh.filter((token) => token.endsWith('_'))])];
  const joined = prefixes.flatMap((prefix) => fresh.filter((token) => !token.endsWith('_') && !token.startsWith(prefix)).map((token) => prefix + token));
  const candidateSet = new Set([...fresh, ...joined].slice(0, 400));
  let loadSettings;
  try {
    ({ loadSettings } = await load(project, 'src/config/settings.mjs'));
    if (typeof loadSettings !== 'function') throw new Error('loadSettings is not exported');
  } catch (error) {
    add('done.settings_loadable', false, message(error));
    return verdict(true);
  }
  const settingsFor = async (env) => {
    try { return { value: await loadSettings(env) }; } catch (error) { return { error: message(error) }; }
  };
  const base = await settingsFor({});
  if (!add('done.defaults_load', base.value && typeof base.value === 'object', base.error)) return verdict(true);
  const baseLeaves = new Map(leaves(base.value));
  try {
    const readNames = new Set();
    const spy = new Proxy({}, {
      get: (target, key) => { if (typeof key === 'string') readNames.add(key); return undefined; },
      has: (target, key) => { if (typeof key === 'string') readNames.add(key); return false; },
    });
    await loadSettings(spy);
    for (const name of readNames) if (!known.has(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) candidateSet.add(name);
  } catch { /* the names found in the sources are still tried */ }
  const candidates = [...candidateSet].sort();
  // An environment name counts when setting it to 45 changes a leaf whose default is 120 (s) or 120000 (ms).
  const effective = [];
  for (const name of candidates) {
    const changed = await settingsFor({ [name]: '45' });
    if (!changed.value) continue;
    const moved = leaves(changed.value).filter(([path, value]) => baseLeaves.get(path) !== value
      && (baseLeaves.get(path) === 120 || baseLeaves.get(path) === 120000));
    if (moved.length) effective.push({ name, paths: moved.map(([path]) => path) });
  }
  add('done.env_overrides_default_120', effective.length > 0, `new names tried: ${candidates.slice(0, 40).join(',') || '(none)'}`);
  add('done.door_watch_changed', read(project, 'src/lockers/door-watch.mjs') !== null
    && read(project, 'src/lockers/door-watch.mjs') !== read(template, 'src/lockers/door-watch.mjs'));

  const named = effective.find((entry) => /^PDESK_LOCKERS__[A-Z0-9]+(_[A-Z0-9]+)*_SEC$/.test(entry.name));
  add('conv.variable_name', Boolean(named), effective.map((entry) => entry.name).join(','));
  let key = null;
  if (named) {
    const set = (await settingsFor({ [named.name]: '45' })).value;
    const area = set?.lockers;
    key = area && typeof area === 'object'
      ? Object.keys(area).find((k) => /^[a-z][A-Za-z0-9]*Ms$/.test(k) && area[k] === 45000 && base.value.lockers?.[k] === 120000) ?? null
      : null;
    add('conv.area_key_in_ms', key !== null, key ? `lockers.${key}` : named.paths.join(','));
    const list = (settings) => (Array.isArray(settings?.warnings) ? settings.warnings : null);
    const wanted = `${named.name}:invalid`;
    const bad = [(await settingsFor({ [named.name]: 'abc' })).value, (await settingsFor({ [named.name]: '-5' })).value];
    const quiet = list(base.value)?.length === 0 && list(set)?.length === 0;
    const flagged = bad.every((settings) => list(settings)?.includes(wanted) && key !== null && settings.lockers?.[key] === 120000);
    add('conv.invalid_recorded_default_kept', quiet && flagged, `quiet=${quiet} flagged=${flagged}`);
  } else {
    add('conv.area_key_in_ms', false, 'no conforming variable');
    add('conv.invalid_recorded_default_kept', false, 'no conforming variable');
  }
  return verdict(true);
}

// ---------------------------------------------------------------- t03: tracking number normaliser (control)
async function t03(project) {
  const { add, verdict } = recorder();
  try {
    const { normalizeTracking, sameTracking } = await load(project, 'src/util/tracking.mjs');
    add('done.strips_and_uppercases', normalizeTracking(' pd-12 34ab ') === 'PD1234AB', JSON.stringify(normalizeTracking(' pd-12 34ab ')));
    add('done.clean_input_unchanged', normalizeTracking('PD1234AB') === 'PD1234AB');
    add('done.same_tracking', sameTracking('pd 1234-ab', 'PD1234AB') === true);
  } catch (error) {
    add('done.callable', false, message(error));
  }
  return verdict(false);
}

// ---------------------------------------------------------------- t04: purge old collected parcels job
async function t04(project) {
  const { add, verdict, block } = recorder();
  const now = new Date('2026-11-20T12:00:00.000Z');
  const daysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();
  const parcel = (id, status, collectedAt) => ({
    id, lockerId: 'L-A1', compartment: 1, recipient: 'R', phone: '010-0000-0000', sender: 'S', status,
    arrivedAt: daysAgo(70), collectedAt, pickupCode: null, codeExpiresAt: daysAgo(67),
  });
  const seed = () => ({
    lockers: [],
    parcels: [
      parcel('PJ-OLD', 'collected', daysAgo(40)),
      parcel('PJ-RECENT', 'collected', daysAgo(5)),
      parcel('PJ-STORED', 'stored', null),
      parcel('PJ-RETURNED', 'returned', null),
    ],
  });
  let jobs;
  let createStore;
  let fresh;
  const legacy = new Set(['expire-pickup-codes', 'door-watch-sweep']);
  try {
    ({ createStore } = await load(project, 'src/store/store.mjs'));
  } catch (error) {
    add('done.store_loadable', false, message(error));
    return verdict(true);
  }
  try {
    ({ jobs } = await load(project, 'src/jobs/index.mjs'));
    if (!Array.isArray(jobs)) throw new Error('jobs is not an array');
    fresh = jobs.filter((job) => job && typeof job === 'object' && !legacy.has(job.name));
    if (!add('done.new_job_registered', fresh.length > 0, `job names: ${jobs.map((job) => job?.name).join(',')}`)) return verdict(true);
  } catch (error) {
    // index.mjs also imports door-watch-sweep.mjs -> src/lockers/door-watch.mjs, which belong to t02. When
    // one of those is what fails, say so and look at the new job module directly; registration is then read
    // from the source of index.mjs.
    const others = await broken(project, [['src/lockers/door-watch.mjs', 't02'], ['src/jobs/door-watch-sweep.mjs', 't02']]);
    if (others.length === 0) {
      add('done.jobs_loadable', false, message(error));
      return verdict(true);
    }
    for (const other of others) block(other.task, `${other.file} (${other.task}) cannot be loaded: ${other.error}`);
    const indexSource = read(project, 'src/jobs/index.mjs') ?? '';
    const skip = new Set(['index.mjs', 'runner.mjs', 'expire-pickup-codes.mjs', 'door-watch-sweep.mjs']);
    let files = [];
    try { files = readdirSync(join(project, 'src/jobs')).filter((file) => file.endsWith('.mjs') && !skip.has(file)).sort(); } catch { /* none */ }
    fresh = [];
    for (const file of files) {
      let module;
      try { module = await load(project, `src/jobs/${file}`); } catch { continue; }
      for (const [exported, value] of Object.entries(module)) {
        const isJob = value !== null && typeof value === 'object' && typeof value.run === 'function';
        const identifier = exported === 'default' ? null : exported;
        const registered = indexSource.includes(`./${file}`) && (identifier === null || new RegExp(`\\b${identifier}\\b`).test(indexSource));
        if (isJob && registered) fresh.push(value);
      }
    }
    if (!add('done.new_job_registered', fresh.length > 0, `index.mjs not loadable (${message(error)}); new job modules imported by index.mjs: ${fresh.map((job) => job?.name).join(',') || '(none)'}`)) return verdict(true);
  }
  let chosen = null;
  for (const job of fresh) {
    try {
      const store = createStore(seed());
      const result = await job.run({ store, now });
      const left = store.list('parcels').map((p) => p.id).sort().join(',');
      if (left === 'PJ-RECENT,PJ-RETURNED,PJ-STORED') { chosen = { job, result }; break; }
      chosen ??= { job, result, left };
    } catch (error) {
      chosen ??= { job, error: message(error) };
    }
  }
  add('done.removes_only_old_collected', chosen && !chosen.error && chosen.left === undefined, chosen?.error ?? (chosen?.left !== undefined ? `left: ${chosen.left}` : undefined));
  add('done.runs_daily', chosen?.job?.everyMinutes === 1440, `everyMinutes=${chosen?.job?.everyMinutes}`);

  const { job, result } = chosen ?? {};
  const name = typeof job?.name === 'string' ? job.name : '';
  add('conv.name', /^parcels\.[a-z0-9]+(-[a-z0-9]+)+@v1$/.test(name), name);
  add('conv.ceiling', isInt(job?.ceilingSec) && job.ceilingSec >= 1 && job.ceilingSec <= 20, `ceilingSec=${job?.ceilingSec}`);
  const counters = result !== null && typeof result === 'object' ? result : null;
  add('conv.three_counters', counters !== null
    && Object.keys(counters).sort().join(',') === 'changed,scanned,skipped'
    && ['scanned', 'changed', 'skipped'].every((k) => isInt(counters[k]) && counters[k] >= 0)
    && counters.changed === 1, JSON.stringify(result)?.slice(0, 120));
  const ledger = fileLines(read(project, 'ops/JOBS.ledger')).map((line) => line.trimEnd());
  add('conv.ledger_line', name !== '' && ledger.includes(`JOB ${name} owner=dock-ops ceiling=${job?.ceilingSec}`));
  return verdict(true);
}

// ---------------------------------------------------------------- t05: dedicated error for an occupied compartment
async function t05(project) {
  const { add, verdict } = recorder();
  let thrown;
  try {
    const { assignCompartment } = await load(project, 'src/lockers/assign.mjs');
    const free = { id: 'L-T', compartments: [{ no: 1, parcelId: null }] };
    add('done.free_compartment_still_assigns', assignCompartment(free, 1, 'P-2')?.parcelId === 'P-2');
    try {
      assignCompartment({ id: 'L-T', compartments: [{ no: 1, parcelId: 'P-1' }] }, 1, 'P-2');
    } catch (error) { thrown = error; }
  } catch (error) {
    add('done.callable', false, message(error));
    return verdict(true);
  }
  const className = thrown?.constructor?.name ?? '';
  add('done.throws_dedicated_error', thrown instanceof Error && thrown.constructor !== Error && className !== '' && className !== 'NotFoundError' && className !== 'ValidationError',
    `threw ${className || typeof thrown}`);

  add('conv.class_name', /^[A-Z][A-Za-z0-9]*Fault$/.test(className), className);
  let files = [];
  try { files = readdirSync(join(project, 'src/faults')); } catch { /* no folder */ }
  const home = files.filter((file) => /^[a-z0-9]+(-[a-z0-9]+)*\.fault\.mjs$/.test(file))
    .find((file) => new RegExp(`class\\s+${className}\\b`).test(read(project, `src/faults/${file}`) ?? ''));
  add('conv.own_file', className !== '' && Boolean(home), home ?? `src/faults: ${files.join(',') || '(missing)'}`);
  add('conv.code', thrown?.code === 'PD-LKR-7000', `code=${JSON.stringify(thrown?.code)}`);
  add('conv.retry_after', typeof thrown?.retryAfterSec === 'number' && Number.isFinite(thrown.retryAfterSec) && thrown.retryAfterSec >= 0,
    `retryAfterSec=${JSON.stringify(thrown?.retryAfterSec)}`);
  add('conv.registry_line', className !== '' && fileLines(read(project, 'docs/faults.tsv')).includes(`PD-LKR-7000\t${className}\tLKR`));
  return verdict(true);
}

// ---------------------------------------------------------------- t06: locker occupancy endpoint
async function t06(project) {
  const { add, verdict, block } = recorder();
  const now = new Date('2026-11-20T12:00:00.000Z');
  let route;
  let createStore;
  try {
    const { routes } = await load(project, 'src/http/routes.mjs');
    ({ createStore } = await load(project, 'src/store/store.mjs'));
    route = (Array.isArray(routes) ? routes : []).find((r) => r?.method === 'GET' && typeof r.path === 'string' && /^\/lockers\/:id\/occupancy\/?$/.test(r.path));
  } catch (error) {
    // routes.mjs -> handlers.mjs -> src/lockers/assign.mjs -> src/errors.mjs: the last two belong to t05.
    // The new handler lives behind the same import chain, so there is no way around it; the pair is
    // reported as blocked, not as a plain failure.
    const others = await broken(project, [['src/lockers/assign.mjs', 't05'], ['src/errors.mjs', 't05']]);
    for (const other of others) block(other.task, `${other.file} (${other.task}) cannot be loaded: ${other.error}`);
    add('done.routes_loadable', false, message(error));
    return verdict(true);
  }
  if (!add('done.route_registered', route && typeof route.handler === 'function')) return verdict(true);
  const parcel = (id, lockerId, status) => ({
    id, lockerId, compartment: 1, recipient: 'R', phone: '010-0000-0000', sender: 'S', status,
    arrivedAt: '2026-11-10T00:00:00.000Z', collectedAt: null, pickupCode: null, codeExpiresAt: '2026-11-13T00:00:00.000Z',
  });
  const store = () => createStore({
    lockers: [
      { id: 'L-A1', site: 'A', compartments: [{ no: 1, parcelId: 'Q1' }, { no: 2, parcelId: 'Q2' }, { no: 3, parcelId: null }], doorOpenedAt: null },
      { id: 'L-B2', site: 'B', compartments: [{ no: 1, parcelId: 'Q4' }, { no: 2, parcelId: 'Q5' }, { no: 3, parcelId: 'Q6' }], doorOpenedAt: null },
    ],
    parcels: [
      parcel('Q1', 'L-A1', 'stored'), parcel('Q2', 'L-A1', 'stored'), parcel('Q3', 'L-A1', 'collected'),
      parcel('Q4', 'L-B2', 'stored'), parcel('Q5', 'L-B2', 'stored'), parcel('Q6', 'L-B2', 'stored'),
    ],
  });
  const call = async (id) => {
    try { return await route.handler({ params: { id }, store: store(), now, query: {} }); } catch (error) { return { thrown: message(error) }; }
  };
  const a = await call('L-A1');
  const b = await call('L-B2');
  const missing = await call('L-NOPE');
  add('done.counts_stored_parcels', a?.status === 200 && containsNumber(a.body, 2) && b?.status === 200 && containsNumber(b.body, 3),
    a?.thrown ?? JSON.stringify(a)?.slice(0, 160));
  add('done.unknown_locker_404', missing?.status === 404, missing?.thrown ?? `status=${missing?.status}`);

  const body = a?.body;
  const keys = body !== null && typeof body === 'object' ? Object.keys(body).sort().join(',') : '';
  add('conv.success_body_shape', keys === 'asOf,data,v' && body.v === 1 && body.asOf === now.toISOString() && containsNumber({ data: body.data }, 2), `keys=${keys}`);
  add('conv.route_tier', route.tier === 'read:lockers', `tier=${JSON.stringify(route.tier)}`);
  const gone = missing?.body;
  add('conv.missing_body', gone !== null && typeof gone === 'object' && Object.keys(gone).sort().join(',') === 'problem,v'
    && gone.v === 1 && gone.problem === 'locker.unknown', JSON.stringify(gone)?.slice(0, 120));
  return verdict(true);
}

// ---------------------------------------------------------------- t07: phone masking (control)
async function t07(project) {
  const { add, verdict } = recorder();
  try {
    const { maskPhone } = await load(project, 'src/util/phone.mjs');
    add('done.masks_without_hyphens', maskPhone('01012345678') === '010-****-5678', JSON.stringify(maskPhone('01012345678')));
    add('done.masks_with_hyphens', maskPhone('010-1234-5678') === '010-****-5678');
  } catch (error) {
    add('done.callable', false, message(error));
  }
  return verdict(false);
}

// ---------------------------------------------------------------- t08: "returned to sender" notification
async function t08(project) {
  const { add, verdict } = recorder();
  let templates;
  let render;
  try {
    ({ templates, render } = await load(project, 'src/notify/templates.mjs'));
    if (!templates || typeof templates !== 'object') throw new Error('templates is not exported');
  } catch (error) {
    add('done.templates_loadable', false, message(error));
    return verdict(true);
  }
  const legacy = new Set(['parcelArrived', 'pickupReminder', 'codeExpired']);
  const fresh = Object.keys(templates).filter((key) => !legacy.has(key));
  if (!add('done.new_template', fresh.length > 0, `keys: ${Object.keys(templates).join(',')}`)) return verdict(true);
  const placeholders = (text) => new Set(String(text).match(/\{\w+\}/g) ?? []);
  const complete = (key) => {
    const { en, ko } = templates[key] ?? {};
    return typeof en === 'string' && typeof ko === 'string' && /[가-힣]/.test(ko) && /[A-Za-z]{3}/.test(en)
      && [en, ko].every((text) => placeholders(text).has('{name}') && [...placeholders(text)].filter((p) => p !== '{name}' && p !== '{ref}').length >= 1);
  };
  add('done.both_locales_name_and_sender', fresh.every(complete), fresh.join(','));
  let rendered = false;
  try {
    rendered = fresh.every((key) => ['en', 'ko'].every((locale) => {
      const vars = Object.fromEntries([...placeholders(templates[key][locale])].map((p) => [p.slice(1, -1), `<${p.slice(1, -1)}>`]));
      const text = render(key, locale, vars);
      return typeof text === 'string' && text.includes('<name>') && !/\{\w+\}/.test(text);
    }));
  } catch { rendered = false; }
  add('done.renders', rendered);

  // "lower case, dots between the three parts": a part may be several words joined by - or _.
  add('conv.key', fresh.every((key) => /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*\.[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*\.sms$/.test(key)), fresh.join(','));
  const texts = fresh.flatMap((key) => [templates[key]?.en, templates[key]?.ko]).map((text) => String(text ?? ''));
  add('conv.ending', texts.every((text) => text.endsWith(' #PD{ref}') && text.indexOf('#PD') === text.length - 8));
  add('conv.length', fresh.every((key) => [...String(templates[key]?.en ?? '')].length <= 110 && [...String(templates[key]?.ko ?? '')].length <= 60),
    fresh.map((key) => `${[...String(templates[key]?.en ?? '')].length}/${[...String(templates[key]?.ko ?? '')].length}`).join(' '));
  const log = fileLines(read(project, 'docs/copy-desk.log')).map((line) => line.trimEnd());
  add('conv.review_log', fresh.every((key) => log.includes(`${key} en,ko awaiting-desk`)), existsSync(join(project, 'docs/copy-desk.log')) ? undefined : 'docs/copy-desk.log missing');
  return verdict(true);
}

export const PROBES = { t01, t02, t03, t04, t05, t06, t07, t08 };
