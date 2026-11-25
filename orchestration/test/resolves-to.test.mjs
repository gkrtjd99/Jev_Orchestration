// `resolvesTo`: the user's declaration of which concrete host model ids a registry entry may resolve to.
// Registry validation, fingerprints, the evidence importer and the evidence summary. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, validateConfig } from '../src/config.mjs';
import { defaultRegistry, validateRegistry, profileCatalog, registryFingerprint, applyModelEnvironment, RESOLVED_MODEL_ID, MAX_RESOLVED_IDS } from '../src/catalog.mjs';
import { profileDefinitions } from '../src/profiles.mjs';
import { taskClass, eligibleProfiles, optimizeCandidates, summarizeEvidence } from '../src/optimizer.mjs';
import { readEvidence, importEvaluations, validateEvaluation, effectiveModelMatch, evidenceReport, evidenceReadiness, evidenceFile } from '../src/feedback.mjs';
import { hash, writeJSON } from '../src/util.mjs';
import { fixture, child } from './helpers.mjs';

const code = expected => error => { assert.equal(error.code, expected); return true; };
const ALIAS_ID = 'fixture-resolved-model-7-1';
const OTHER_ID = 'fixture-resolved-model-7-2';
const features = { role: 'implement', complexity: 'bounded', reasoning: 'routine', risk: 'normal', information: 'sufficient', reading: 'targeted', uncertain: false };
const CONTEXT = 'fixture-resolves-to-v1';

function registryWith(list, { entry = 'claude-light' } = {}) {
  const r = defaultRegistry();
  for (const m of r.models) m.availability = 'confirmed';
  if (list !== undefined) r.models.find(m => m.id === entry).resolvesTo = list;
  return r;
}
function configWith(list, home = '/tmp/jev-resolves-to-tests') {
  const c = defaults(home);
  c.registry = registryWith(list);
  c.optimization.evaluationContext = CONTEXT;
  return c;
}
const lightProfile = config => eligibleProfiles(config.registry, 'claude', features, config).candidates.find(p => p.modelKey === 'claude-light');
function row(config, profile, { model = profile.backend, i = 0, ...extra } = {}) {
  return { schema: 1, kind: 'live-evaluation', taskId: `fixture-task-${i}`, taskClass: taskClass(features), context: config.optimization.evaluationContext,
    projectHash: hash('/fixture'), profileId: profile.profileId, profileFingerprint: profile.fingerprint, runtime: profile.runtime,
    createdAt: Date.now() - 1000, effective: { confirmed: true, model, effort: profile.effort, source: 'native-transcript' },
    verification: { source: 'independent-validator', passed: true, artifactSha256: hash(`fixture-report-${i}`), validatorVersion: 'fixture-tests-1' },
    durationMs: 1000, costUsd: 0.02, attempts: 1, accounting: 'all-attempts-including-failures-and-router', ...extra };
}

// ---------------------------------------------------------------- registry validation

test('resolvesTo is optional; a valid list is accepted and every malformed one is refused', () => {
  validateRegistry(registryWith(undefined));
  validateRegistry(registryWith([ALIAS_ID]));
  validateRegistry(registryWith(Array.from({ length: MAX_RESOLVED_IDS }, (_, i) => `fixture-id-${i}`)));
  // An id equal to the entry's own backend is redundant and allowed.
  validateRegistry(registryWith(['claude-sonnet-5', ALIAS_ID]));
  for (const id of ['claude-opus-5-5', 'us.vendor.model-v1:0', 'model@20260101', 'A', 'a'.repeat(80)]) assert.ok(RESOLVED_MODEL_ID.test(id), id);

  const refused = (list, expected = 'INVALID_RESOLVES_TO') => assert.throws(() => validateRegistry(registryWith(list)), code(expected), JSON.stringify(list));
  refused(null);
  refused([]);                                                   // absent is the only way to declare nothing
  refused('fixture-id');                                         // a single string is not a list
  refused({ 0: 'fixture-id' });
  refused(Array.from({ length: MAX_RESOLVED_IDS + 1 }, (_, i) => `fixture-id-${i}`));
  refused([7]);
  refused([null]);
  refused(['']);
  refused(['a'.repeat(81)]);                                     // length bound
  for (const bad of ['claude-*', '*', 'claude-opus-?', 'claude-opus-5-[0-9]', '^claude', 'claude.+', 'a|b', 'has space', 'tab\tid', 'line\nbreak', 'path/like', '-leading-dash',
    '.leading-dot', 'quote"d', 'back\\slash', 'paren(s)', 'curly{1}', 'comma,sep', 'semi;colon', 'unicode-모델', 'dollar$', 'percent%20']) refused([bad]);
  refused([ALIAS_ID, ALIAS_ID], 'DUPLICATE_RESOLVED_MODEL_ID');
  // The whole config is refused with the registry.
  const c = configWith(['claude-*']);
  assert.throws(() => validateConfig(c), code('INVALID_RESOLVES_TO'));
});

test('one id cannot be declared for two different backends of a runtime; the same backend or another runtime may share it', () => {
  const twice = registryWith([ALIAS_ID]);
  twice.models.find(m => m.id === 'claude-standard').resolvesTo = [ALIAS_ID];
  assert.throws(() => validateRegistry(twice), code('RESOLVED_MODEL_ID_DECLARED_FOR_ANOTHER_BACKEND'));
  // A disabled entry is checked like any other: enabling it later must not create the ambiguity.
  const disabled = registryWith([ALIAS_ID]);
  Object.assign(disabled.models.find(m => m.id === 'claude-micro'), { resolvesTo: [ALIAS_ID] });
  assert.throws(() => validateRegistry(disabled), code('RESOLVED_MODEL_ID_DECLARED_FOR_ANOTHER_BACKEND'));
  // The same model in two slots (same backend) may carry the same declaration.
  const same = registryWith([ALIAS_ID]);
  const standard = same.models.find(m => m.id === 'claude-standard');
  standard.model = standard.backend = 'claude-sonnet-5';
  standard.resolvesTo = [ALIAS_ID];
  validateRegistry(same);
  // Runtimes are separate hosts.
  const across = registryWith([ALIAS_ID]);
  across.models.find(m => m.id === 'codex-light').resolvesTo = [ALIAS_ID];
  validateRegistry(across);
});

test('an id that IS another entry\'s backend or model cannot be declared, whatever the entry order', () => {
  const reversed = r => ({ ...r, models: [...r.models].reverse() });
  const refused = r => { for (const x of [r, reversed(r)]) assert.throws(() => validateRegistry(x), code('RESOLVED_MODEL_ID_DECLARED_FOR_ANOTHER_BACKEND')); };
  const accepted = r => { for (const x of [r, reversed(r)]) validateRegistry(x); };
  // The shipped registry names concrete ids: the standard (opus) entry declaring the light entry's backend.
  refused(registryWith(['claude-sonnet-5'], { entry: 'claude-standard' }));
  refused(registryWith(['claude-opus-5-5'], { entry: 'claude-light' }));
  refused(registryWith([ALIAS_ID, 'claude-fable-5-1'], { entry: 'claude-light' }));
  // A disabled entry's backend counts as well.
  refused(registryWith(['haiku'], { entry: 'claude-standard' }));
  // An alias registry: 'sonnet' under the opus entry and the reverse.
  const alias = declare => {
    const r = registryWith(undefined);
    for (const [id, name] of [['claude-light', 'sonnet'], ['claude-standard', 'opus']]) Object.assign(r.models.find(m => m.id === id), { model: name, backend: name });
    for (const [id, list] of Object.entries(declare)) r.models.find(m => m.id === id).resolvesTo = list;
    return r;
  };
  refused(alias({ 'claude-standard': ['sonnet'] }));
  refused(alias({ 'claude-light': ['opus'] }));
  accepted(alias({ 'claude-light': ['claude-sonnet-5-5'], 'claude-standard': ['claude-opus-5-5'] }));
  // The model NAME of another entry (where it differs from that entry's backend) is that entry's too.
  const named = registryWith(undefined);
  Object.assign(named.models.find(m => m.id === 'claude-light'), { model: 'fixture-alias', backend: 'fixture-backend-1' });
  named.models.find(m => m.id === 'claude-standard').resolvesTo = ['fixture-alias'];
  refused(named);
  // Still allowed: the entry's own backend or model name, and one backend in two slots sharing a declaration.
  accepted(registryWith(['claude-sonnet-5', ALIAS_ID]));
  const ownName = registryWith(undefined);
  Object.assign(ownName.models.find(m => m.id === 'claude-light'), { model: 'fixture-alias', backend: 'fixture-backend-1', resolvesTo: ['fixture-alias', 'fixture-backend-1'] });
  accepted(ownName);
  const twoSlots = registryWith([ALIAS_ID, 'claude-sonnet-5']);
  Object.assign(twoSlots.models.find(m => m.id === 'claude-standard'), { model: 'claude-sonnet-5', backend: 'claude-sonnet-5', resolvesTo: [ALIAS_ID] });
  accepted(twoSlots);
  // Another runtime's backend is another host's name.
  accepted(registryWith(['gpt-6-luna']));
  // With the declaration refused, the row it would have let through is not accepted either.
  const c = configWith(undefined);
  const standard = eligibleProfiles(c.registry, 'claude', { ...features, complexity: 'broad' }, c).candidates.find(p => p.modelKey === 'claude-standard');
  assert.throws(() => validateEvaluation(row(c, standard, { model: 'claude-sonnet-5' }), c), code('EFFECTIVE_SETTING_MISMATCH'));
  // Ids are exact strings: a case variant is a different id (documented), not a match for the other entry.
  accepted(registryWith(['CLAUDE-OPUS-5-5']));
});

test('the shipped example registry shows the field as a marked placeholder on a disabled entry and changes no profile', async () => {
  const example = JSON.parse(await fs.readFile(new URL('../config/registry.example.json', import.meta.url), 'utf8'));
  validateRegistry(example);
  const declared = example.models.filter(m => Object.hasOwn(m, 'resolvesTo'));
  assert.deepEqual(declared.map(m => [m.id, m.enabled, m.resolvesTo]), [['claude-micro', false, ['EXAMPLE-ONLY.replace-with-the-id-your-host-records']]]);
  // No real-looking model id ships as a default declaration.
  assert.ok(declared.every(m => m.resolvesTo.every(id => id.startsWith('EXAMPLE-ONLY.'))));
  for (const runtime of ['claude', 'codex']) assert.deepEqual(profileCatalog(example, runtime), profileCatalog(defaultRegistry(), runtime));
  assert.ok(defaultRegistry().models.every(m => !Object.hasOwn(m, 'resolvesTo')));
});

// ---------------------------------------------------------------- fingerprints

test('a registry without the field keeps the fingerprints, profile ids and profile files it had before the field existed', () => {
  const r = defaultRegistry();
  const all = ['claude', 'codex'].flatMap(runtime => profileCatalog(r, runtime));
  // Digests computed from the tree before `resolvesTo` existed (commit 1bd9add), over the default registry.
  assert.equal(all.length, 54);
  assert.equal(hash(all.map(p => [p.profileId, p.fingerprint])), '9b620ca849c0af1d79b8c10aea2ebc008083735875a4211880955bb617b6914e');
  assert.equal(hash(['claude', 'codex'].map(runtime => profileCatalog(r, runtime))), '42833ba35dc21675402de9f66ddf1379707492c70f39c384c6553b999a822849');
  assert.equal(registryFingerprint(r), '51aeb67e81e61b87ea8b6c26b51d144d598a2466e7b459a10ff389119353b00a');
  // The formula itself: the whole model entry, the role and the effort.
  for (const p of all) {
    assert.equal(p.fingerprint, hash({ model: r.models.find(m => m.id === p.modelKey), role: p.role, effort: p.effort }));
    assert.ok(!Object.hasOwn(p, 'resolvesTo'));
  }
});

test('a declaration changes the fingerprint of that entry\'s profiles only, never a profile id or a profile file; it is hashed as a set', () => {
  const plain = registryWith(undefined), declared = registryWith([ALIAS_ID, OTHER_ID]);
  const before = profileCatalog(plain, 'claude'), after = profileCatalog(declared, 'claude');
  assert.deepEqual(after.map(p => p.profileId), before.map(p => p.profileId));
  assert.deepEqual(profileDefinitions('claude', declared), profileDefinitions('claude', plain));
  for (const [i, p] of after.entries()) {
    if (p.modelKey === 'claude-light') {
      assert.notEqual(p.fingerprint, before[i].fingerprint);
      assert.deepEqual(p.resolvesTo, [ALIAS_ID, OTHER_ID]);
    } else {
      assert.equal(p.fingerprint, before[i].fingerprint);
      assert.ok(!Object.hasOwn(p, 'resolvesTo'));
    }
  }
  assert.deepEqual(profileCatalog(declared, 'codex'), profileCatalog(plain, 'codex'));
  assert.notEqual(registryFingerprint(declared), registryFingerprint(plain));
  const fingerprints = list => profileCatalog(registryWith(list), 'claude').filter(p => p.modelKey === 'claude-light').map(p => p.fingerprint);
  // Order is not part of the declaration; every change of the set is.
  assert.deepEqual(fingerprints([OTHER_ID, ALIAS_ID]), fingerprints([ALIAS_ID, OTHER_ID]));
  const distinct = [undefined, [ALIAS_ID], [OTHER_ID], [ALIAS_ID, OTHER_ID]].map(list => fingerprints(list)[0]);
  assert.equal(new Set(distinct).size, 4);
});

test('an environment override that changes the model drops the declaration made for the old one; one that keeps the model keeps it', () => {
  const map = JSON.stringify({ brief: 'high', balanced: 'xhigh', deep: 'xhigh', exhaustive: 'max' });
  const changed = { registry: registryWith([ALIAS_ID]) };
  applyModelEnvironment(changed, { JEV_CLAUDE_LIGHT_MODEL: 'another-model', JEV_CLAUDE_LIGHT_EFFORT_MAP: map });
  assert.ok(!Object.hasOwn(changed.registry.models.find(m => m.id === 'claude-light'), 'resolvesTo'));
  const backend = { registry: registryWith([ALIAS_ID]) };
  applyModelEnvironment(backend, { JEV_CLAUDE_LIGHT_MODEL: 'claude-sonnet-5', JEV_CLAUDE_LIGHT_BACKEND: 'another-backend', JEV_CLAUDE_LIGHT_EFFORT_MAP: map });
  assert.ok(!Object.hasOwn(backend.registry.models.find(m => m.id === 'claude-light'), 'resolvesTo'));
  const kept = { registry: registryWith([ALIAS_ID]) };
  applyModelEnvironment(kept, { JEV_CLAUDE_LIGHT_MODEL: 'claude-sonnet-5', JEV_CLAUDE_LIGHT_EFFORT_MAP: map });
  assert.deepEqual(kept.registry.models.find(m => m.id === 'claude-light').resolvesTo, [ALIAS_ID]);
  const untouched = { registry: registryWith([ALIAS_ID]) };
  applyModelEnvironment(untouched, {});
  assert.deepEqual(untouched.registry, registryWith([ALIAS_ID]));
});

// ---------------------------------------------------------------- importer

test('the importer accepts the backend or a declared id and nothing else', () => {
  const plain = configWith(undefined), declared = configWith([ALIAS_ID]);
  const p0 = lightProfile(plain), p1 = lightProfile(declared);
  assert.equal(p0.backend, 'claude-sonnet-5');
  // Without a declaration: today's behaviour. Only the backend string itself.
  validateEvaluation(row(plain, p0), plain);
  for (const model of [ALIAS_ID, 'claude-sonnet-5-5', 'claude-sonnet', 'sonnet', 'claude-sonnet-5 ', 'CLAUDE-SONNET-5', 'claude-sonnet-5[1m]', '', null, 7, ['claude-sonnet-5']])
    assert.throws(() => validateEvaluation(row(plain, p0, { model }), plain), code('EFFECTIVE_SETTING_MISMATCH'), String(model));
  // With a declaration: the backend and the declared id, exactly.
  validateEvaluation(row(declared, p1), declared);
  validateEvaluation(row(declared, p1, { model: ALIAS_ID }), declared);
  for (const model of [OTHER_ID, ALIAS_ID + '-x', ALIAS_ID.slice(0, -1), ALIAS_ID.toUpperCase(), ' ' + ALIAS_ID, 'fixture-resolved-model', 'claude-sonnet-5-5', 'sonnet', '*', '', null, [ALIAS_ID]])
    assert.throws(() => validateEvaluation(row(declared, p1, { model }), declared), code('EFFECTIVE_SETTING_MISMATCH'), String(model));
  assert.deepEqual([effectiveModelMatch(p1, 'claude-sonnet-5'), effectiveModelMatch(p1, ALIAS_ID), effectiveModelMatch(p1, OTHER_ID), effectiveModelMatch(p0, ALIAS_ID), effectiveModelMatch(p1, null)],
    ['exact', 'declared', null, null, null]);
  // A declaration on one entry accepts nothing for another entry's profile.
  const standard = profileCatalog(declared.registry, 'claude').find(p => p.modelKey === 'claude-standard');
  assert.throws(() => validateEvaluation(row(declared, standard, { model: ALIAS_ID }), declared), code('EFFECTIVE_SETTING_MISMATCH'));
  // A row may state how it matched; a wrong statement is refused.
  validateEvaluation(row(declared, p1, { model: ALIAS_ID, effective: { confirmed: true, model: ALIAS_ID, effort: p1.effort, source: 'native-transcript', modelMatch: 'declared' } }), declared);
  for (const stated of ['exact', 'alias-undeclared', 'alias', null, true])
    assert.throws(() => validateEvaluation(row(declared, p1, { effective: { confirmed: true, model: ALIAS_ID, effort: p1.effort, source: 'native-transcript', modelMatch: stated } }), declared),
      code('EFFECTIVE_MODEL_MATCH_MISSTATED'), String(stated));
});

test('with a declared id every other importer check is exactly as strict as before', () => {
  const c = configWith([ALIAS_ID]);
  const p = lightProfile(c);
  const good = () => row(c, p, { model: ALIAS_ID });
  validateEvaluation(good(), c);
  const refused = (patch, expected, config = c) => assert.throws(() => validateEvaluation({ ...good(), ...patch }, config), code(expected), expected);
  refused({ kind: 'synthetic' }, 'LIVE_EVALUATION_REQUIRED');
  refused({ schema: 2 }, 'LIVE_EVALUATION_REQUIRED');
  refused({ taskId: '' }, 'INVALID_EVIDENCE_taskId');
  refused({ taskClass: 'x'.repeat(201) }, 'INVALID_EVIDENCE_taskClass');
  refused({ projectHash: 'not-a-hash' }, 'INVALID_EVIDENCE_projectHash');
  refused({ profileFingerprint: 'a'.repeat(63) }, 'INVALID_EVIDENCE_profileFingerprint');
  refused({ createdAt: Date.now() + 3600000 }, 'INVALID_EVIDENCE_TIMESTAMP');
  refused({ profileId: 'no-such-profile' }, 'STALE_EVIDENCE_PROFILE');
  refused({ profileFingerprint: 'a'.repeat(64) }, 'STALE_EVIDENCE_PROFILE');
  refused({ runtime: 'codex' }, 'STALE_EVIDENCE_PROFILE');
  refused({ effective: { confirmed: false, model: ALIAS_ID, effort: p.effort, source: 'native-transcript' } }, 'EFFECTIVE_SETTING_NOT_CONFIRMED');
  refused({ effective: { confirmed: true, model: ALIAS_ID, effort: p.effort, source: 'worker-report' } }, 'EFFECTIVE_SETTING_NOT_CONFIRMED');
  refused({ effective: { confirmed: true, model: ALIAS_ID, effort: 'low', source: 'native-transcript' } }, 'EFFECTIVE_SETTING_MISMATCH');
  refused({ verification: { source: 'worker', passed: true } }, 'INDEPENDENT_VERIFICATION_REQUIRED');
  refused({ verification: { source: 'independent-validator', passed: 'yes' } }, 'INDEPENDENT_VERIFICATION_REQUIRED');
  refused({ verification: { source: 'independent-validator', passed: true, artifactSha256: 'x', validatorVersion: 'v' } }, 'VERIFICATION_PROVENANCE_REQUIRED');
  refused({ accounting: 'successful-attempt-only' }, 'COMPLETE_ACCOUNTING_REQUIRED');
  refused({ attempts: 0 }, 'INVALID_ATTEMPTS');
  refused({ durationMs: 0 }, 'INVALID_DURATION');
  refused({ costUsd: -1 }, 'INVALID_COST');
  refused({ context: 'another-context' }, 'EVALUATION_CONTEXT_MISMATCH');
  // The default context refuses everything, declared id or not, whatever the row calls its context.
  const unbound = { ...c, optimization: { ...c.optimization, evaluationContext: 'native-default-unvalidated' } };
  refused({}, 'EVALUATION_CONTEXT_NOT_CONFIGURED', unbound);
  refused({ context: 'native-default-unvalidated' }, 'EVALUATION_CONTEXT_NOT_CONFIGURED', unbound);
  assert.throws(() => validateEvaluation(row(unbound, p), unbound), code('EVALUATION_CONTEXT_NOT_CONFIGURED'));
});

test('imported rows record how the model matched; a re-import is a duplicate; rows stored before the stamp still are', async t => {
  const f = await fixture(t);
  f.config.registry = registryWith([ALIAS_ID]);
  f.config.optimization.evaluationContext = CONTEXT;
  const p = lightProfile(f.config);
  const exact = row(f.config, p, { i: 1 }), declared = row(f.config, p, { i: 2, model: ALIAS_ID });
  await assert.rejects(importEvaluations(f.config, [exact, declared]), code('EXPLICIT_EVIDENCE_ACCEPTANCE_REQUIRED'));
  assert.deepEqual((await readEvidence(f.config)).rows, []);
  assert.deepEqual(await importEvaluations(f.config, [exact, declared], { acceptEvidence: true }).then(r => [r.added, r.duplicate, r.total]), [2, 0, 2]);
  const stored = (await readEvidence(f.config)).rows;
  assert.deepEqual(stored.map(r => [r.taskId, r.effective.model, r.effective.modelMatch]), [['fixture-task-1', p.backend, 'exact'], ['fixture-task-2', ALIAS_ID, 'declared']]);
  // The stamp is the only difference from what was submitted.
  assert.deepEqual(stored.map(r => { const { modelMatch, ...effective } = r.effective; return { ...r, effective }; }), [exact, declared]);
  assert.deepEqual(await importEvaluations(f.config, [exact, declared], { acceptEvidence: true }).then(r => [r.added, r.duplicate, r.total]), [0, 2, 2]);
  assert.deepEqual(await importEvaluations(f.config, stored, { acceptEvidence: true }).then(r => [r.added, r.duplicate]), [0, 2]);
  await assert.rejects(importEvaluations(f.config, [{ ...declared, costUsd: 9 }], { acceptEvidence: true }), code('CONFLICTING_EVALUATION_UNIT'));
  // One refused row refuses the batch and nothing is written.
  await assert.rejects(importEvaluations(f.config, [row(f.config, p, { i: 3 }), row(f.config, p, { i: 4, model: OTHER_ID })], { acceptEvidence: true }), code('EFFECTIVE_SETTING_MISMATCH'));
  assert.equal((await readEvidence(f.config)).rows.length, 2);

  assert.deepEqual(await evidenceReport(f.config), { schema: 1, rows: 2, current: 2, stale: 0, byMatch: { exact: 1, declared: 1, unrecorded: 0 },
    byProfile: { [p.profileId]: { current: 2, stale: 0, byMatch: { exact: 1, declared: 1, unrecorded: 0 }, currentEffectiveModels: { [p.backend]: 1, [ALIAS_ID]: 1 } } },
    mixedModelProfiles: [p.profileId] });

  // A store written before the stamp existed: the same row is still recognised as a duplicate, and reported as unrecorded.
  await writeJSON(evidenceFile(f.config), { schema: 1, rows: [exact] });
  assert.deepEqual(await importEvaluations(f.config, [exact], { acceptEvidence: true }).then(r => [r.added, r.duplicate, r.total]), [0, 1, 1]);
  assert.deepEqual((await evidenceReport(f.config)).byMatch, { exact: 0, declared: 0, unrecorded: 1 });
});

// ---------------------------------------------------------------- stale evidence and the router's summary

test('evidence accepted through a declared id counts while the declaration stands and stops counting when it changes or is removed', async t => {
  const f = await fixture(t);
  f.config.registry = registryWith([ALIAS_ID]);
  f.config.optimization.evaluationContext = CONTEXT;
  const p = lightProfile(f.config);
  // One model throughout: rows of two different effective models are not pooled (see the test below).
  const rows = Array.from({ length: 40 }, (_, i) => row(f.config, p, { i, model: ALIAS_ID }));
  await importEvaluations(f.config, rows, { acceptEvidence: true });
  const stored = (await readEvidence(f.config)).rows;
  const summarize = config => {
    const candidates = eligibleProfiles(config.registry, 'claude', features, config).candidates;
    return { candidates, stats: summarizeEvidence(stored, candidates, { context: CONTEXT, projectHash: hash('/fixture'), classKey: taskClass(features) }) };
  };
  const now = summarize(f.config);
  assert.equal(now.stats[p.profileId].n, 40);
  assert.equal(optimizeCandidates(now.candidates, now.stats, f.config.optimization).basis, now.candidates[0].profileId === p.profileId ? 'observed_quality_gated' : 'policy_prior_not_measured');

  for (const [label, list] of [['removed', undefined], ['changed', [OTHER_ID]], ['extended', [ALIAS_ID, OTHER_ID]]]) {
    const changed = { ...f.config, registry: registryWith(list) };
    const after = summarize(changed);
    assert.deepEqual(after.stats, {}, label);
    assert.equal(optimizeCandidates(after.candidates, after.stats, changed.optimization).basis, 'policy_prior_not_measured', label);
    // The stored rows are refused if offered again, and the store report calls them stale.
    assert.throws(() => validateEvaluation(rows[1], changed), code('STALE_EVIDENCE_PROFILE'), label);
    assert.deepEqual([(await evidenceReport(changed)).current, (await evidenceReport(changed)).stale], [0, 40], label);
  }
  // A summary never counts a row whose model is neither the backend nor a declared id, even with a current fingerprint.
  const forged = stored.map((r, i) => (i < 5 ? { ...r, effective: { ...r.effective, model: OTHER_ID } } : r));
  const candidates = now.candidates;
  assert.equal(summarizeEvidence(forged, candidates, { context: CONTEXT, projectHash: hash('/fixture'), classKey: taskClass(features) })[p.profileId].n, 35);
  // And never anything under the default context.
  assert.deepEqual(summarizeEvidence(stored, candidates, { context: 'native-default-unvalidated', projectHash: hash('/fixture'), classKey: taskClass(features) }), {});
});

test('rows of two effective models under one profile are not pooled: the profile stays unmeasured and the store report names it', async t => {
  const f = await fixture(t);
  f.config.registry = registryWith([ALIAS_ID, OTHER_ID]);
  f.config.optimization.evaluationContext = CONTEXT;
  const p = lightProfile(f.config);
  const options = { context: CONTEXT, projectHash: hash('/fixture'), classKey: taskClass(features) };
  const candidates = eligibleProfiles(f.config.registry, 'claude', features, f.config).candidates;
  // 15 runs of each declared id, same fingerprint: every row is valid, but 15 + 15 is not a sample of 30.
  const mixed = Array.from({ length: 30 }, (_, i) => row(f.config, p, { i, model: i < 15 ? ALIAS_ID : OTHER_ID }));
  for (const r of mixed) validateEvaluation(r, f.config);
  assert.deepEqual(summarizeEvidence(mixed, candidates, options), {});
  assert.equal(optimizeCandidates(candidates, summarizeEvidence(mixed, candidates, options), f.config.optimization).basis, 'policy_prior_not_measured');
  // The backend itself next to a declared id is two models as well; a single stray row is enough.
  const stray = Array.from({ length: 31 }, (_, i) => row(f.config, p, { i, model: i === 30 ? p.backend : ALIAS_ID }));
  assert.deepEqual(summarizeEvidence(stray, candidates, options), {});
  // One model: counted, and the summary says which.
  const single = summarizeEvidence(mixed.slice(0, 15), candidates, options)[p.profileId];
  assert.deepEqual([single.n, single.effectiveModel], [15, ALIAS_ID]);
  const all = Array.from({ length: 30 }, (_, i) => row(f.config, p, { i, model: OTHER_ID }));
  assert.deepEqual([summarizeEvidence(all, candidates, options)[p.profileId].n, summarizeEvidence(all, candidates, options)[p.profileId].effectiveModel], [30, OTHER_ID]);
  // A row of the second model that is too old to count does not block the first.
  const expired = [...mixed.slice(0, 15), { ...mixed[20], createdAt: Date.now() - 40 * 86400000 }];
  assert.equal(summarizeEvidence(expired, candidates, options)[p.profileId].n, 15);
  // The other profiles are unaffected by one mixed profile.
  const other = candidates.find(c => c.profileId !== p.profileId);
  if (other) {
    const otherRows = Array.from({ length: 3 }, (_, i) => row(f.config, other, { i }));
    assert.deepEqual(Object.keys(summarizeEvidence([...mixed, ...otherRows], candidates, options)), [other.profileId]);
  }

  await importEvaluations(f.config, mixed, { acceptEvidence: true });
  const report = await evidenceReport(f.config);
  assert.deepEqual([report.byProfile[p.profileId].currentEffectiveModels, report.mixedModelProfiles], [{ [ALIAS_ID]: 15, [OTHER_ID]: 15 }, [p.profileId]]);
});

test('after a declaration changes, the same tasks can be imported again; the old rows stay stale and uncounted', async t => {
  const f = await fixture(t);
  f.config.registry = registryWith([ALIAS_ID]);
  f.config.optimization.evaluationContext = CONTEXT;
  const before = lightProfile(f.config);
  const oldRows = Array.from({ length: 30 }, (_, i) => row(f.config, before, { i, model: ALIAS_ID }));
  assert.equal((await importEvaluations(f.config, oldRows, { acceptEvidence: true })).added, 30);

  // The host starts resolving the alias to another id: the user replaces the declaration. Same profile id, new fingerprint.
  const changed = { ...f.config, registry: registryWith([OTHER_ID]) };
  const after = lightProfile(changed);
  assert.equal(after.profileId, before.profileId);
  assert.notEqual(after.fingerprint, before.fingerprint);
  const newRows = Array.from({ length: 30 }, (_, i) => row(changed, after, { i, model: OTHER_ID }));
  assert.deepEqual(await importEvaluations(changed, newRows, { acceptEvidence: true }).then(r => [r.added, r.duplicate, r.total]), [30, 0, 60]);
  assert.deepEqual(await importEvaluations(changed, newRows, { acceptEvidence: true }).then(r => [r.added, r.duplicate, r.total]), [0, 30, 60]);
  // Within the current definition a different row for the same task is still a conflict, and nothing is written.
  await assert.rejects(importEvaluations(changed, [{ ...newRows[0], costUsd: 9 }], { acceptEvidence: true }), code('CONFLICTING_EVALUATION_UNIT'));
  await assert.rejects(importEvaluations(changed, [{ ...newRows[0], verification: { ...newRows[0].verification, passed: false } }], { acceptEvidence: true }), code('CONFLICTING_EVALUATION_UNIT'));
  // The old rows cannot come back in under the new definition, with either fingerprint.
  await assert.rejects(importEvaluations(changed, [oldRows[0]], { acceptEvidence: true }), code('STALE_EVIDENCE_PROFILE'));
  await assert.rejects(importEvaluations(changed, [{ ...oldRows[0], profileFingerprint: after.fingerprint }], { acceptEvidence: true }), code('EFFECTIVE_SETTING_MISMATCH'));

  const stored = (await readEvidence(changed)).rows;
  assert.equal(stored.length, 60);
  const report = await evidenceReport(changed);
  assert.deepEqual([report.current, report.stale, report.byProfile[after.profileId].currentEffectiveModels, report.mixedModelProfiles], [30, 30, { [OTHER_ID]: 30 }, []]);
  const candidates = eligibleProfiles(changed.registry, 'claude', features, changed).candidates;
  const stats = summarizeEvidence(stored, candidates, { context: CONTEXT, projectHash: hash('/fixture'), classKey: taskClass(features) });
  assert.deepEqual([stats[after.profileId].n, stats[after.profileId].effectiveModel], [30, OTHER_ID]);
  // Under the old declaration only the old rows count: the two definitions never mix.
  const oldCandidates = eligibleProfiles(f.config.registry, 'claude', features, f.config).candidates;
  const oldStats = summarizeEvidence(stored, oldCandidates, { context: CONTEXT, projectHash: hash('/fixture'), classKey: taskClass(features) });
  assert.deepEqual([oldStats[before.profileId].n, oldStats[before.profileId].effectiveModel], [30, ALIAS_ID]);
});

// ---------------------------------------------------------------- tooling

test('evidenceReadiness and the doctor say, per enabled entry, what is declared and whether evidence import is possible', async t => {
  const c = configWith([OTHER_ID, ALIAS_ID]);
  const ready = evidenceReadiness(c);
  assert.equal(ready.evaluationContextConfigured, true);
  assert.deepEqual(ready.models.map(m => m.id), ['claude-light', 'claude-standard', 'claude-strategic', 'codex-light', 'codex-standard', 'codex-strategic']);
  assert.deepEqual(ready.models[0], { id: 'claude-light', runtime: 'claude', model: 'claude-sonnet-5', backend: 'claude-sonnet-5', resolvesTo: [ALIAS_ID, OTHER_ID],
    acceptedEffectiveModels: ['claude-sonnet-5', ALIAS_ID, OTHER_ID].sort(), evidenceImport: 'possible:exact_backend_or_declared_id' });
  assert.deepEqual([ready.models[1].resolvesTo, ready.models[1].acceptedEffectiveModels, ready.models[1].evidenceImport], [null, ['claude-opus-5-5'], 'possible:exact_backend_only']);
  const unbound = evidenceReadiness({ ...c, optimization: { ...c.optimization, evaluationContext: 'native-default-unvalidated' } });
  assert.equal(unbound.evaluationContextConfigured, false);
  assert.ok(unbound.models.every(m => m.evidenceImport === 'blocked:evaluation_context_not_configured'));
  assert.deepEqual(unbound.models[0].resolvesTo, [ALIAS_ID, OTHER_ID]);

  // The doctor prints the same block (no --live: nothing is contacted). A fixture config in a fixture home.
  const f = await fixture(t);
  f.config.registry = registryWith([ALIAS_ID]);
  const dir = path.join(f.home, '.config', 'jev-hooks');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(f.config));
  const doctor = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));
  const out = JSON.parse((await child(process.execPath, [doctor, '--home', f.home])).stdout);
  assert.equal(out.jev, 'not_tested');
  assert.equal(out.evidence.evaluationContextConfigured, false);
  assert.deepEqual(out.evidence.models.find(m => m.id === 'claude-light').resolvesTo, [ALIAS_ID]);
  assert.equal(out.evidence.models.find(m => m.id === 'claude-light').evidenceImport, 'blocked:evaluation_context_not_configured');

  const feedback = fileURLToPath(new URL('../scripts/feedback.mjs', import.meta.url));
  const report = await child(process.execPath, [feedback, '--config', path.join(dir, 'config.json'), '--report']);
  assert.deepEqual([report.code, JSON.parse(report.stdout).rows], [0, 0]);
  const both = await child(process.execPath, [feedback, '--config', path.join(dir, 'config.json'), '--report', '--file', 'x.jsonl']);
  assert.deepEqual([both.code, both.stderr.trim()], [1, 'REPORT_TAKES_NO_FILE']);
});

test('installing a registry that declares ids writes the same profile files under the same names and records the new fingerprints', async t => {
  const { install } = await import('../src/install.mjs');
  const { loadConfig } = await import('../src/config.mjs');
  const installed = async list => {
    const f = await fixture(t);
    const env = path.join(f.root, 'source.env');
    await fs.writeFile(env, 'TYPESAFE_API_KEY=fixture-key\n');
    const registry = path.join(f.root, 'registry.json');
    await fs.writeFile(registry, JSON.stringify(registryWith(list)));
    await install({ home: f.home, project: f.project, runtime: 'claude', envFile: env, registryFile: registry, mode: 'shadow', yes: true });
    const { config } = await loadConfig(path.join(f.home, '.config', 'jev-hooks', 'config.json'), {});
    const dir = path.join(f.home, '.claude', 'agents');
    const files = {};
    for (const name of (await fs.readdir(dir)).sort()) files[name] = await fs.readFile(path.join(dir, name), 'utf8');
    return { config, files };
  };
  const plain = await installed(undefined), declared = await installed([ALIAS_ID]);
  assert.deepEqual(declared.files, plain.files);
  assert.deepEqual(declared.config.registry.models.find(m => m.id === 'claude-light').resolvesTo, [ALIAS_ID]);
  const fingerprints = c => Object.fromEntries(Object.entries(c.installedProfiles.claude).map(([id, rec]) => [id, rec.fingerprint]));
  const a = fingerprints(plain.config), b = fingerprints(declared.config);
  assert.deepEqual(Object.keys(b), Object.keys(a));
  for (const p of profileCatalog(declared.config.registry, 'claude')) {
    assert.equal(b[p.profileId], p.fingerprint);
    assert.equal(b[p.profileId] === a[p.profileId], p.modelKey !== 'claude-light', p.profileId);
  }
});
