// Tests of the experiment's tooling: the Main prompt, the arm configuration (with the real installer in a temporary
// home), the verification file, the analyzer and the comparison. Synthetic session files only (analyze-fixtures.mjs);
// no network, no session, nothing outside temporary directories.
//   node --test tools.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMainPrompt, problems, FORBIDDEN } from './build-main-prompt.mjs';
import { armRegistry, applyEnvLines, verifyInstalled, isCommittedBase, overridingEnvNames, DECLARED_IDS, ENV_LINES, EVALUATION_CONTEXT } from './make-arm-config.mjs';
import { baseRegistry, baseRegistryText, BASE_REGISTRY_FILE } from './make-base-registry.mjs';
import { runInstallVerification } from './verify-arm-install.mjs';
import { buildVerification, VALIDATOR_NAME } from './make-verification.mjs';
import { analyzeArm, mainUsage, judgeCost, addTokens } from './analyze.mjs';
import { compareArms, render, estimate, loadPrices } from './compare.mjs';
import { writeArmFixture, MAIN_MODEL } from './analyze-fixtures.mjs';
import { checkProject, loadTasks } from './checkers/check.mjs';
import { defaultRegistry, profileCatalog, validateRegistry } from '../../../orchestration/src/catalog.mjs';
import { defaults } from '../../../orchestration/src/config.mjs';
import { collect, parseVerification, taskHash } from '../../../orchestration/src/collector.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tasks = loadTasks();
const sha = (data) => createHash('sha256').update(data).digest('hex');
const work = mkdtempSync(join(tmpdir(), 'routing-exp-tools-'));
test.after(() => rmSync(work, { recursive: true, force: true }));
let counter = 0;
const fresh = (name) => { const dir = join(work, `${name}-${counter += 1}`); mkdirSync(dir, { recursive: true }); return dir; };

// The pre-registered base registry (light = sonnet, standard = opus, strategic = opus, all "declared").
const aliasRegistry = () => baseRegistry();
const CONFIRMED = { confirm: ['sonnet', 'opus'] };
/** A project copy: the template plus, per task, its reference solution, one flawed variant, or nothing. */
function projectWith(solutions) {
  const dir = fresh('project');
  cpSync(join(here, 'template'), dir, { recursive: true });
  for (const task of tasks) {
    const pick = solutions[task.id] ?? 'reference';
    if (pick === 'none') continue;
    cpSync(pick === 'reference' ? join(here, 'fixtures', 'reference', task.id) : join(here, 'fixtures', 'flawed', task.id, pick), dir, { recursive: true });
  }
  return dir;
}
const SONNET = 'claude-sonnet-5-5', OPUS = 'claude-opus-5-5';
const armR = armRegistry(aliasRegistry(), 'R', DECLARED_IDS, CONFIRMED);
const armL = armRegistry(aliasRegistry(), 'L', DECLARED_IDS, CONFIRMED);
const catalogR = profileCatalog(armR.registry, 'claude');
const profileOf = (role, slot, effort) => catalogR.find((p) => p.role === role && p.slot === slot && p.effort === effort);
const profilesById = new Map(catalogR.map((p) => [p.profileId, p]));
const routed = (slot, effort, extra = {}) => ({ kind: 'routed', profile: profileOf('implement', slot, effort).profileId, model: slot === 'light' ? SONNET : OPUS, effort, ...extra });
const mainPrompt = readFileSync(join(here, 'main-prompt.txt'), 'utf8');

// ---------------------------------------------------------------- Main prompt
test('the Main prompt is generated from tasks.json and says nothing about what is measured', () => {
  assert.equal(buildMainPrompt(tasks), mainPrompt);
  assert.deepEqual(problems(tasks, mainPrompt), []);
  for (const task of tasks) assert.ok(mainPrompt.includes(`\n<<<\n${task.text}\n>>>\n`), task.id);
  for (const word of ['difficulty', 'This task is hard', 'the hook', 'hooks', 'routing', 'routed', 'a weaker model', 'models', 'the checker', 'hidden checks', 'evaluation', 'experiment', 'arm R', '난이도', '채점']) {
    assert.ok(FORBIDDEN.test(word), `"${word}" must be caught`);
  }
  assert.ok(!FORBIDDEN.test('webhook deliveries'), 'a task may talk about webhooks');
  assert.ok(problems(tasks.slice(1), buildMainPrompt(tasks.slice(1))).some((p) => p.includes('expected 12 tasks')));
  assert.ok(problems(tasks, mainPrompt.replace('Task 1\n', 'Task 1 (difficulty: moderate)\n')).some((p) => p.includes('forbidden')));
  assert.deepEqual([...new Set(tasks.map((t) => t.difficulty))].sort(), ['hard', 'moderate', 'routine']);
});

test('the pre-registered material is as frozen', () => {
  const frozen = spawnSync(process.execPath, [join(here, 'freeze.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(frozen.status, 0, frozen.stderr);
  const stored = JSON.parse(readFileSync(join(here, 'FROZEN.json'), 'utf8'));
  assert.equal(stored['tasks.json'], sha(readFileSync(join(here, 'tasks.json'))));
  assert.equal(stored['main-prompt.txt'], sha(readFileSync(join(here, 'main-prompt.txt'))));
  assert.equal(stored.validatorVersion, sha(readFileSync(join(here, 'checkers', 'check.mjs'))));
  assert.ok(!existsSync(join(here, 'template', '.claude')) && !existsSync(join(here, 'template', 'CLAUDE.md')) && !existsSync(join(here, 'template', 'node_modules')));
  assert.deepEqual(JSON.parse(readFileSync(join(here, 'template', 'package.json'), 'utf8')).dependencies, undefined);
});

// ---------------------------------------------------------------- arm registry and env lines
test('arm R declares the resolved ids, arm L also disables every claude entry above the lowest enabled backend', () => {
  const base = aliasRegistry();
  const untouched = JSON.stringify(base);
  assert.deepEqual(armR.declared.map((d) => [d.registryEntry, d.backend, d.resolvesTo]), [['claude-light', 'sonnet', [SONNET]], ['claude-standard', 'opus', [OPUS]], ['claude-strategic', 'opus', [OPUS]]]);
  assert.deepEqual(armR.disabled, []);
  assert.deepEqual(armR.removedPlaceholders, ['claude-micro'], 'the example placeholder id is not carried into the experiment');
  assert.equal(JSON.stringify(base), untouched, 'the input registry is not modified');
  assert.deepEqual(armL.lowest, { registryEntry: 'claude-light', slot: 'light', backend: 'sonnet' });
  assert.deepEqual(armL.disabled.map((d) => d.registryEntry), ['claude-standard', 'claude-strategic']);
  assert.deepEqual(armL.registry.models.filter((m) => m.runtime === 'claude' && m.enabled).map((m) => [m.id, m.backend, m.resolvesTo]), [['claude-light', 'sonnet', [SONNET]]]);
  // Availability: nothing is confirmed unless the caller says so, per backend; R and L then differ in `enabled` only.
  assert.equal(readFileSync(BASE_REGISTRY_FILE, 'utf8'), baseRegistryText(), 'base-registry.json is what make-base-registry.mjs derives');
  assert.ok(base.models.filter((m) => m.runtime === 'claude' && m.enabled).every((m) => m.availability === 'declared'), 'the committed base confirms nothing');
  const plain = armRegistry(base, 'R');
  assert.deepEqual(plain.unconfirmed.map((e) => [e.registryEntry, e.backend, e.availability]), [['claude-light', 'sonnet', 'declared'], ['claude-standard', 'opus', 'declared'], ['claude-strategic', 'opus', 'declared']]);
  assert.deepEqual(armRegistry(base, 'R', DECLARED_IDS, { confirm: ['sonnet'] }).unconfirmed.map((e) => e.registryEntry), ['claude-standard', 'claude-strategic'], 'a partly confirmed registry is reported, not accepted');
  assert.deepEqual(armRegistry(base, 'L', DECLARED_IDS, { confirm: ['sonnet'] }).unconfirmed, [], 'arm L needs only its own backend confirmed');
  assert.throws(() => armRegistry(base, 'R', DECLARED_IDS, { confirm: ['sonet'] }), /no enabled claude entry has this backend/);
  assert.deepEqual([armR.unconfirmed, armL.unconfirmed, armR.undeclaredEnabled, armL.undeclaredEnabled], [[], [], [], []]);
  assert.deepEqual(armR.confirmed.map((e) => [e.registryEntry, e.was]), [['claude-light', 'declared'], ['claude-standard', 'declared'], ['claude-strategic', 'declared']]);
  assert.ok(armR.registry.models.filter((m) => m.runtime === 'claude' && m.enabled).every((m) => m.availability === 'confirmed'));
  const sameButEnabled = (registry) => JSON.stringify(registry.models.map((m) => ({ ...m, enabled: null })));
  assert.equal(sameButEnabled(armL.registry), sameButEnabled(armR.registry), 'the registries of R and L differ in `enabled` only');
  assert.equal(isCommittedBase(base), true); assert.equal(isCommittedBase(armR.registry), false); assert.equal(isCommittedBase(defaultRegistry()), false);
  assert.deepEqual(overridingEnvNames({ PATH: 'x', JEV_MODE: 'shadow', TYPESAFE_BASE_URL: 'y', TYPESAFE_API_KEY: 'k', CLAUDE_CODE_SUBAGENT_MODEL: 'z', HOME: 'h' }), ['CLAUDE_CODE_SUBAGENT_MODEL', 'JEV_MODE', 'TYPESAFE_BASE_URL'],
    'a key in the environment changes no setting of the arm and is reported separately');
  // Codex entries are left alone, and both registries are valid for the product.
  assert.deepEqual(armL.registry.models.filter((m) => m.runtime === 'codex'), base.models.filter((m) => m.runtime === 'codex'));
  validateRegistry(armR.registry); validateRegistry(armL.registry);
  // Profile names do not depend on a declaration; fingerprints do. L's profiles are R's light profiles, same fingerprints.
  const before = profileCatalog(base, 'claude');
  assert.deepEqual(armR.profiles.map((p) => p.profileId).sort(), before.map((p) => p.profileId).sort());
  assert.ok(armR.profiles.every((p) => before.find((b) => b.profileId === p.profileId).fingerprint !== p.fingerprint));
  assert.equal(armL.profiles.length, 9);
  for (const p of armL.profiles) assert.equal(armR.profiles.find((r) => r.profileId === p.profileId)?.fingerprint, p.fingerprint);
  assert.deepEqual(DECLARED_IDS, { sonnet: SONNET, opus: OPUS });
});

test('a registry with concrete model ids gets no declaration, and arm L still keeps only the lowest backend', () => {
  const shipped = defaultRegistry();
  const r = armRegistry(shipped, 'R'), l = armRegistry(shipped, 'L');
  assert.deepEqual(r.declared, []);
  assert.equal(r.notDeclared.filter((e) => e.enabled).length, 3);
  assert.deepEqual(r.undeclaredEnabled.map((e) => e.backend), ['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1'], 'such entries stop the tool unless --allow-undeclared is given');
  assert.deepEqual(l.undeclaredEnabled.map((e) => e.backend), ['claude-sonnet-5']);
  assert.deepEqual(l.registry.models.filter((m) => m.runtime === 'claude' && m.enabled).map((m) => m.backend), ['claude-sonnet-5']);
  // A typed declaration is applied; one that names another entry's model is refused by the product's own validation.
  assert.deepEqual(armRegistry(shipped, 'R', { ...DECLARED_IDS, 'claude-sonnet-5': SONNET }).declared.map((d) => d.resolvesTo), [[SONNET]]);
  assert.throws(() => armRegistry(shipped, 'R', { 'claude-sonnet-5': 'claude-opus-5-5' }), { code: 'RESOLVED_MODEL_ID_DECLARED_FOR_ANOTHER_BACKEND' });
  assert.throws(() => armRegistry(shipped, 'N'), /R or L/);
  const none = structuredClone(shipped); for (const m of none.models) if (m.runtime === 'claude') m.enabled = false;
  assert.throws(() => armRegistry(none, 'L'), /no enabled claude entry/);
});

test('the env lines are set once and every other line passes through untouched', () => {
  const secret = 'TYPESAFE_API_KEY=not-a-real-key-0123456789';
  const text = ['# private', secret, 'JEV_MODE=shadow', 'JEV_ALLOW_EGRESS=true', '#JEV_SKILLS_MODE=off', 'JEV_EVALUATION_CONTEXT=native-default-unvalidated', 'JEV_MODE=advisory', '  odd line  ', ''].join('\n');
  const edit = applyEnvLines(text);
  assert.deepEqual(edit.text.split('\n'), ['# private', secret, 'JEV_MODE=active', 'JEV_ALLOW_EGRESS=true', '#JEV_SKILLS_MODE=off', `JEV_EVALUATION_CONTEXT=${EVALUATION_CONTEXT}`, '  odd line  ',
    'JEV_SKILLS_MODE=off', 'JEV_SUPERVISOR_MODE=off', '']);
  assert.deepEqual([edit.replaced, edit.appended, edit.duplicatesDropped], [['JEV_MODE', 'JEV_EVALUATION_CONTEXT'], ['JEV_SKILLS_MODE', 'JEV_SUPERVISOR_MODE'], ['JEV_MODE']]);
  assert.equal(applyEnvLines(edit.text).text, edit.text, 'applying twice changes nothing');
  assert.equal(applyEnvLines('').text, Object.entries(ENV_LINES).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  assert.deepEqual(ENV_LINES, { JEV_MODE: 'active', JEV_SKILLS_MODE: 'off', JEV_SUPERVISOR_MODE: 'off', JEV_EVALUATION_CONTEXT: 'desktop-auto-v1' });
});

test('make-arm-config writes below --work only and prints nothing from the env file', () => {
  const dir = fresh('arm-work');
  const outside = fresh('outside');
  const config = { ...defaults(join(dir, 'home')), registry: aliasRegistry() };
  mkdirSync(join(dir, 'home/.config/jev-hooks'), { recursive: true });
  writeFileSync(join(dir, 'home/.config/jev-hooks/config.json'), JSON.stringify(config));
  writeFileSync(join(dir, 'home/.config/jev-hooks/.env'), 'TYPESAFE_API_KEY=not-a-real-key-0123456789\nJEV_MODE=shadow\n', { mode: 0o600 });
  writeFileSync(join(outside, 'config.json'), JSON.stringify(config));
  writeFileSync(join(outside, '.env'), 'JEV_MODE=shadow\n');
  const cli = (...argv) => spawnSync(process.execPath, [join(here, 'make-arm-config.mjs'), ...argv], { encoding: 'utf8' });
  const inside = join(dir, 'home/.config/jev-hooks/config.json');

  const refusedConfig = cli('--arm', 'R', '--work', dir, '--config', join(outside, 'config.json'));
  assert.equal(refusedConfig.status, 2); assert.match(refusedConfig.stderr, /below --work/);
  const refusedEnv = cli('--arm', 'R', '--work', dir, '--config', inside, '--env', join(outside, '.env'));
  assert.equal(refusedEnv.status, 2);
  assert.ok(!existsSync(join(dir, 'routing-exp-arm-R')), 'a refused run writes nothing at all');
  assert.equal(readFileSync(join(outside, '.env'), 'utf8'), 'JEV_MODE=shadow\n', 'a file outside --work is never written');
  symlinkSync(join(outside, '.env'), join(dir, 'link.env'));
  assert.equal(cli('--arm', 'R', '--work', dir, '--config', inside, '--env', join(dir, 'link.env')).status, 2, 'a link out of --work is refused');
  assert.equal(readFileSync(join(outside, '.env'), 'utf8'), 'JEV_MODE=shadow\n');
  assert.equal(cli('--arm', 'N', '--work', dir, '--config', inside).status, 2);
  assert.equal(cli('--arm', 'R', '--work', join(dir, 'missing'), '--config', inside).status, 2);

  // Availability is the owner's statement: without it nothing is written, with a partial one for arm R neither.
  const envText = () => readFileSync(join(dir, 'home/.config/jev-hooks/.env'), 'utf8');
  const unconfirmed = cli('--arm', 'L', '--work', dir, '--config', inside, '--env', join(dir, 'home/.config/jev-hooks/.env'));
  assert.equal(unconfirmed.status, 1); assert.match(unconfirmed.stderr, /claude-light \(backend sonnet, declared\) is enabled but not confirmed/); assert.match(unconfirmed.stderr, /--confirm-availability sonnet/);
  const partly = cli('--arm', 'R', '--work', dir, '--config', inside, '--confirm-availability', 'sonnet');
  assert.equal(partly.status, 1); assert.match(partly.stderr, /claude-standard \(backend opus, declared\), claude-strategic \(backend opus, declared\) are enabled but not confirmed/);
  assert.ok(!existsSync(join(dir, 'routing-exp-arm-L')) && !existsSync(join(dir, 'routing-exp-arm-R')) && envText().includes('JEV_MODE=shadow'), 'a refused run writes nothing');
  // A registry that is not the pre-registered base, and entries without a declared id, also stop it.
  mkdirSync(join(dir, 'other'), { recursive: true });
  writeFileSync(join(dir, 'other/config.json'), JSON.stringify({ ...config, registry: defaultRegistry() }));
  const shippedConfirm = ['--confirm-availability', 'claude-sonnet-5', '--confirm-availability', 'claude-opus-5-5', '--confirm-availability', 'claude-fable-5-1'];
  const otherBase = cli('--arm', 'R', '--work', dir, '--config', join(dir, 'other/config.json'), ...shippedConfirm);
  assert.equal(otherBase.status, 1); assert.match(otherBase.stderr, /not the pre-registered base-registry\.json/);
  const undeclared = cli('--arm', 'R', '--work', dir, '--config', join(dir, 'other/config.json'), '--allow-other-base', ...shippedConfirm);
  assert.equal(undeclared.status, 1); assert.match(undeclared.stderr, /claude-light \(backend claude-sonnet-5\).*no declared model id/);
  const allowed = cli('--arm', 'R', '--work', dir, '--config', join(dir, 'other/config.json'), '--allow-other-base', '--allow-undeclared', ...shippedConfirm);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual([JSON.parse(allowed.stdout).baseRegistry.isCommittedBase, JSON.parse(allowed.stdout).baseRegistry.allowOtherBase, JSON.parse(allowed.stdout).allowUndeclared], [false, true, true], 'the overrides are recorded');
  rmSync(join(dir, 'routing-exp-arm-R'), { recursive: true });

  const made = cli('--arm', 'L', '--work', dir, '--config', inside, '--env', join(dir, 'home/.config/jev-hooks/.env'), '--confirm-availability', 'sonnet', '--confirm-availability', 'opus');
  assert.equal(made.status, 0, made.stderr);
  assert.ok(!made.stdout.includes('not-a-real-key') && !made.stderr.includes('not-a-real-key'), 'nothing from the env file is printed');
  const summary = JSON.parse(made.stdout);
  assert.equal(summary.reinstallRequired, true);
  assert.deepEqual([summary.baseRegistry.isCommittedBase, summary.availability.confirmedOnCommandLine, summary.availability.entries.map((e) => e.registryEntry)], [true, ['sonnet', 'opus'], ['claude-light', 'claude-standard', 'claude-strategic']]);
  assert.deepEqual(summary.enabledClaudeEntries.map((e) => [e.registryEntry, e.availability, e.resolvesTo]), [['claude-light', 'confirmed', [SONNET]]]);
  assert.equal(summary.profileFiles.length, 9);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'routing-exp-arm-L/registry.json'), 'utf8')), armL.registry);
  assert.equal(readFileSync(join(dir, 'routing-exp-arm-L/env-lines.txt'), 'utf8'), 'JEV_MODE=active\nJEV_SKILLS_MODE=off\nJEV_SUPERVISOR_MODE=off\nJEV_EVALUATION_CONTEXT=desktop-auto-v1\n');
  assert.equal(readFileSync(join(dir, 'home/.config/jev-hooks/.env'), 'utf8'), 'TYPESAFE_API_KEY=not-a-real-key-0123456789\nJEV_MODE=active\nJEV_SKILLS_MODE=off\nJEV_SUPERVISOR_MODE=off\nJEV_EVALUATION_CONTEXT=desktop-auto-v1\n');
  assert.ok(!readFileSync(join(dir, 'routing-exp-arm-L/summary.json'), 'utf8').includes('not-a-real-key'));
  assert.equal(JSON.stringify(JSON.parse(readFileSync(inside, 'utf8'))), JSON.stringify(config), 'config.json is only read');
  // Without the second install the config is not the arm's: verify says so.
  const verify = cli('--verify', '--arm', 'L', '--work', dir, '--config', inside);
  assert.equal(verify.status, 1);
  const problemsFound = JSON.parse(verify.stdout).problems;
  assert.ok(problemsFound.some((p) => p.includes('mode is shadow')) && problemsFound.some((p) => p.includes('not the arm registry')) && problemsFound.some((p) => p.includes('is not installed')));
  assert.ok(problemsFound.some((p) => p.includes('claude-light (backend sonnet) is declared, not confirmed')) && problemsFound.some((p) => p.includes('JEV_ALLOW_EGRESS is not true')), 'verify names what would leave the arm unrouted');
  // Variables the hook reads before the arm's .env are reported by name, never by value.
  const withEnv = spawnSync(process.execPath, [join(here, 'make-arm-config.mjs'), '--verify', '--arm', 'L', '--work', dir, '--config', inside], { encoding: 'utf8', env: { ...process.env, JEV_MODE: 'shadow-value-not-printed' } });
  assert.ok(JSON.parse(withEnv.stdout).overridingEnvironmentNames.includes('JEV_MODE') && JSON.parse(withEnv.stdout).problems.some((p) => p.includes('JEV_MODE')) && !withEnv.stdout.includes('shadow-value-not-printed'));
  assert.deepEqual(verifyInstalled({ ...config, mode: 'active' }, armL).filter((p) => p.startsWith('mode is')), []);
});

test('the documented install order works with the real installer, the installed hook really rewrites, and arm L installs a subset of arm R\'s profile files', async () => {
  const run = await runInstallVerification();
  assert.equal(run.base, 'base-registry.json');
  for (const [arm, result] of Object.entries(run.arms)) {
    assert.deepEqual([result.steps.baseInstall.exit, result.steps.makeArmConfig.exit, result.steps.armInstall.exit, result.steps.verify.exit, result.steps.projectHooks.exit], [0, 0, 0, 0, 0], arm);
    assert.deepEqual(result.steps.makeArmConfigWithoutConfirmation, { exit: 1, saysNotConfirmed: true, wroteNothing: true }, `${arm}: no availability statement, no arm`);
    assert.deepEqual([result.steps.verify.ok, result.steps.verify.problems], [true, []], arm);
    assert.deepEqual(result.steps.installAfterProjectHooks, { exit: 1, error: 'COMPETING_PROJECT_JEV_HOOKS_REQUIRE_MIGRATION' }, 'the project hooks go in after the last install');
    assert.deepEqual([result.effective.mode, result.effective.evaluationContext, result.effective.skills, result.effective.supervisor, result.effective.classify, result.effective.profile],
      ['active', 'desktop-auto-v1', 'off', 'off', 'active', 'active'], arm);
    assert.equal(result.effective.stateDirBelowHome, true);
    assert.equal(result.effective.requireConfirmedAvailability, true, 'the product default is left on');
    assert.ok(result.effective.enabledClaude.every((m) => m.availability === 'confirmed'), `${arm}: every enabled claude entry is confirmed`);
    assert.deepEqual([result.baseIsCommitted, result.availabilityConfirmed], [true, ['claude-light', 'claude-standard', 'claude-strategic']]);
    assert.deepEqual(result.env, { linesPresentOnce: true, otherLinesUnchanged: true, mode: '600' }, arm);
    assert.equal(result.rewriteCheck.verified, result.rewriteCheck.profiles, `${arm}: every profile passes the hook's pre-rewrite check`);
    assert.equal(result.projectSettings, true);
    assert.equal(result.profileFiles.length, arm === 'R' ? 27 : 9, arm);
    assert.ok(result.profileFiles.every((name) => /^jev4_[a-z]+_[a-z]+_[a-z]+_[0-9a-f]{10}\.md$/.test(name)));
    // The hook itself, through the command in the project's settings.json, with a judge stub on 127.0.0.1.
    assert.equal(result.hookDrive.error, undefined, arm);
    for (const scenario of result.hookDrive.scenarios) {
      assert.equal(scenario.exit, 0, `${arm} ${scenario.scenario}`);
      if (scenario.rewritten) assert.deepEqual([scenario.installedProfile, scenario.promptKept, /^jev4_/.test(scenario.subagentType), `${scenario.subagentType}.md`], [true, true, true, result.profileFiles.find((name) => name === `${scenario.subagentType}.md`)], `${arm} ${scenario.scenario}`);
    }
  }
  const drive = (arm) => Object.fromEntries(run.arms[arm].hookDrive.scenarios.map((s) => [s.scenario, s.rewritten ? `${s.role}/${s.slot}/${s.backend}` : `deferred:${s.code}`]));
  // Arm R: every delegation is rewritten to an installed profile, on either backend.
  assert.deepEqual(drive('R'), { implement: 'implement/light/sonnet', research: 'research/light/sonnet', review: 'review/standard/opus', plan: 'plan/strategic/opus' });
  // Arm L: rewrites go to the lowest backend only. Roles the lowest entry does not have are deferred, and such a
  // delegation then runs as the harness default (PROTOCOL.md section 7).
  assert.deepEqual(drive('L'), { implement: 'implement/light/sonnet', research: 'research/light/sonnet', review: 'deferred:no_compatible_profile', plan: 'deferred:no_compatible_profile' });
  assert.deepEqual([run.comparison.armRFiles, run.comparison.armLFiles, run.comparison.armLIsSubsetOfArmR, run.comparison.sharedNames, run.comparison.sharedFilesByteIdentical, run.comparison.onlyInArmR.length], [27, 9, true, 9, true, 18]);
  assert.equal(run.arms.R.sameNamesAndBytesAsBaseInstall, true, 'neither a declaration nor a confirmation changes a profile file name or its content');
  assert.ok(run.arms.L.profileFiles.every((name) => /_light_/.test(name)));
  // Every profile's fingerprint changes with the declaration, so a registry edited into config.json without a
  // second install would have every rewrite refused.
  assert.deepEqual(run.arms.R.rewriteCheckIfRegistryWereOnlyEditedInConfig, { PROFILE_NOT_INSTALLED_OR_STALE: 27 });
  assert.deepEqual(run.arms.L.rewriteCheckIfRegistryWereOnlyEditedInConfig, { PROFILE_NOT_INSTALLED_OR_STALE: 9 });
  assert.deepEqual(run.arms.R.effective.enabledClaude.map((m) => [m.backend, m.resolvesTo]), [['sonnet', [SONNET]], ['opus', [OPUS]], ['opus', [OPUS]]]);
  assert.deepEqual(run.arms.L.effective.enabledClaude.map((m) => [m.backend, m.resolvesTo]), [['sonnet', [SONNET]]]);
  assert.equal(run.arms.R.profilesWithChangedFingerprint, 27);
  // An install that did not start from base-registry.json, and entries without a declared id, are refused.
  assert.deepEqual(run.refusals, { installerDefaultRegistry: { installExit: 0, exit: 1, saysNotBase: true }, undeclaredEntries: { exit: 1, saysNoDeclaredId: true } });
  // The pre-run checklist passes on the prepared folders and finds each kind of contamination.
  assert.deepEqual(run.preflight.clean, { ok: true, problems: [], agents: { expected: 27, present: 27 } });
  assert.deepEqual(run.preflight.dirty, { ok: false, problems: 6, found: { hookInSettings: true, armNClaudeFolder: true, environment: true, agentMissing: 1, agentExtra: 1, agentDiffering: 1 } });
});

const planN = Object.fromEntries(tasks.map((task) => [task.id, { kind: 'plain', model: MAIN_MODEL, effort: 'medium' }]));
const planR = {
  t01: routed('light', 'xhigh'), t02: routed('light', 'high'), t03: routed('standard', 'high'), t04: { kind: 'deferred', reason: 'selector_abstained', model: MAIN_MODEL, effort: 'medium' },
  t05: routed('light', 'high', { cachedProfileDecision: true }), t06: routed('standard', 'xhigh'), t07: routed('light', 'xhigh'), t08: routed('standard', 'high'),
  t09: routed('light', 'high'), t10: routed('standard', 'xhigh'), t11: routed('light', 'xhigh'), t12: { kind: 'skipped' },
};
const planL = Object.fromEntries(tasks.map((task, i) => [task.id, routed('light', ['high', 'xhigh', 'max'][i % 3])]));
const projectN = projectWith({});
const projectR = projectWith({ t03: 'strips-accents', t08: 'none' });
const projectL = projectWith({ t06: 'float-division', t10: 'range-keeps-fixed-weeks' });
const fixtureN = writeArmFixture(fresh('arm-n'), { arm: 'N', tasks, plan: planN, mainPrompt });
const fixtureR = writeArmFixture(fresh('arm-r'), { arm: 'R', tasks, plan: planR, mainPrompt, profiles: profilesById });
const fixtureL = writeArmFixture(fresh('arm-l'), { arm: 'L', tasks, plan: planL, mainPrompt, profiles: profilesById });
const armN = analyzeArm({ arm: 'N', project: projectN, transcriptsDir: fixtureN.transcripts });
const armRr = analyzeArm({ arm: 'R', project: projectR, transcriptsDir: fixtureR.transcripts, stateDir: fixtureR.stateDir });
const armLl = analyzeArm({ arm: 'L', project: projectL, transcriptsDir: fixtureL.transcripts, stateDir: fixtureL.stateDir });
const row = (arm, id) => arm.tasks.find((task) => task.id === id);
// Token sums of the synthetic subagent of task number n (three API messages; see analyze-fixtures.mjs).
const subTokens = (n) => ({ input: 36 + 30 * n, output: 306 + 30 * n, cacheRead: 30000 * n + 6000, cacheCreation: 156 + 30 * n });

// ---------------------------------------------------------------- analyzer
test('arm N: one launched call per task, the subagent is read from the host\'s own records, no route', () => {
  assert.deepEqual([armN.totals.tasks, armN.totals.delegated, armN.totals.done, armN.totals.passed], [12, 12, 12, 12]);
  assert.deepEqual(armN.totals.byDifficulty, { moderate: { tasks: 4, delegated: 4, done: 4, passed: 4 }, routine: { tasks: 4, delegated: 4, done: 4, passed: 4 }, hard: { tasks: 4, delegated: 4, done: 4, passed: 4 } });
  const t03 = row(armN, 't03');
  assert.deepEqual(t03.delegation, { delegated: true, agentCalls: 1, refusedCalls: 0, launchedCalls: 1, firstPromptVerbatim: true, firstRequestedType: 'general-purpose', launchedRequestedType: 'general-purpose' });
  assert.deepEqual([t03.subagent.agentType, t03.subagent.model, t03.subagent.effort, t03.subagent.finished, t03.subagent.files], ['general-purpose', MAIN_MODEL, 'medium', true, 3]);
  // Three API messages, one of them written as two rows and once more as a request-log row: counted once each.
  assert.deepEqual(t03.subagent.tokens, subTokens(3));
  assert.deepEqual([t03.subagent.apiTurns, t03.subagent.toolCalls, t03.subagent.wallMs], [3, 2, 12105]);
  assert.equal(t03.route, null); assert.equal(t03.judge, null); assert.equal(armN.totals.routing, null); assert.equal(armN.totals.judge, null);
  assert.deepEqual(t03.notes, []);
  assert.deepEqual(armN.host, { versions: ['2.1.332'], entrypoints: ['claude-desktop'], permissionModes: ['auto'] });
  assert.equal(armN.totals.subagentsByModel[MAIN_MODEL].tasks, 12);
  assert.deepEqual(Object.keys(armN.totals.subagentsByModel), [MAIN_MODEL]);
  assert.deepEqual(armN.unattributedChanges, []);
  assert.deepEqual(armN.warnings, ['1 unparsable line(s) skipped in the Main transcript']);
  assert.deepEqual(armN.totals.noRoutingCheck, { clean: true, refusedCalls: 0, firstCallAsOtherType: [], launchedAsOtherType: [], ranAsOtherType: [], agentTypeUnknown: [] });
  assert.ok(!JSON.stringify(armN).includes('toolu_') && !JSON.stringify(armN).includes('/synthetic/') && !JSON.stringify(armN).includes(tasks[0].text.slice(0, 40)), 'no id, path or prompt text in the output');
});

test('Main-session tokens are counted once per message id and per model, with the extra round trip visible in R', () => {
  // N: the planning message + per task one issuing message and one acknowledging message.
  const sumN = tasks.reduce((sum, _, i) => addTokens(sum, { input: 2 * (11 + i), output: 2 * (101 + i), cacheRead: 2000 * (i + 1), cacheCreation: 2 * (51 + i) }), { input: 11, output: 101, cacheRead: 1000, cacheCreation: 51 });
  assert.deepEqual(armN.main.tokensByModel, { [MAIN_MODEL]: { apiTurns: 25, ...sumN } });
  assert.deepEqual(armN.main.tokens, sumN);
  assert.deepEqual([armN.main.models, armN.main.efforts, armN.main.agentCalls, armN.main.refusedCalls, armN.main.launchedCalls, armN.main.strayAgentCalls], [[MAIN_MODEL], ['high'], 12, 0, 12, 0]);
  assert.deepEqual([armN.main.promptContainsMainPrompt, armN.main.promptExtraCharacters], [true, 'Synthetic launcher line.\n\n'.length]);
  // R: 10 routed tasks cost two issuing messages each, the deferred one a single one, t12 is never issued.
  assert.deepEqual([armRr.main.agentCalls, armRr.main.refusedCalls, armRr.main.launchedCalls, armRr.main.apiTurns], [21, 10, 11, 1 + 10 * 3 + 2]);
  assert.ok(armRr.main.wallMs > 0 && armN.main.wallMs > 0);
  // The helper alone: rows of one message count once, a request-log row never, a sidechain row never.
  const warnings = [];
  const usage = mainUsage([
    { type: 'assistant', timestamp: '2026-11-20T00:00:00Z', effort: 'high', message: { id: 'm1', model: 'model-a', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 } } },
    { type: 'assistant', timestamp: '2026-11-20T00:00:01Z', effort: 'high', message: { id: 'm1', model: 'model-a', usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 11, cache_creation_input_tokens: 13 } } },
    { type: 'api-request', message: { id: 'm1', role: 'assistant', model: 'model-a', usage: { input_tokens: 5, output_tokens: 7 } } },
    { type: 'assistant', isSidechain: true, message: { id: 'm9', model: 'model-z', usage: { input_tokens: 99, output_tokens: 99 } } },
    { type: 'assistant', timestamp: '2026-11-20T00:00:05Z', message: { id: 'm2', model: 'model-b', usage: { input_tokens: 1, output_tokens: 2 } } },
    { type: 'assistant', timestamp: '2026-11-20T00:00:06Z', message: { model: 'model-b', content: [{ type: 'tool_use', id: 'x1', name: 'Read', input: {} }, { type: 'tool_use', id: 'x2', name: 'Agent', input: {} }] } },
    { type: 'api-request', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x3', name: 'Bash', input: {} }] } },
  ], warnings);
  assert.deepEqual(usage.otherToolCalls, { Read: 1 }, 'what Main did besides delegating');
  assert.deepEqual(armN.main.otherToolCalls, {});
  assert.deepEqual(usage.tokensByModel, { 'model-a': { apiTurns: 1, input: 5, output: 7, cacheRead: 11, cacheCreation: 13 }, 'model-b': { apiTurns: 2, input: 1, output: 2, cacheRead: null, cacheCreation: null } });
  assert.equal(usage.wallMs, 6000);
  assert.equal(warnings.length, 3, JSON.stringify(warnings));
});

test('arm R: refused and re-issued calls are one delegation, the route comes from the first call, a deferral is reported', () => {
  assert.deepEqual([armRr.totals.delegated, armRr.totals.done, armRr.totals.passed], [11, 10, 9]);
  const t01 = row(armRr, 't01');
  assert.deepEqual(t01.delegation, { delegated: true, agentCalls: 2, refusedCalls: 1, launchedCalls: 1, firstPromptVerbatim: true, firstRequestedType: 'general-purpose', launchedRequestedType: profileOf('implement', 'light', 'xhigh').profileId });
  assert.deepEqual([t01.subagent.agentType, t01.subagent.model, t01.subagent.effort], [profileOf('implement', 'light', 'xhigh').profileId, SONNET, 'xhigh']);
  assert.deepEqual(t01.subagent.tokens, subTokens(1));
  assert.deepEqual([t01.route.recorded, t01.route.deferred, t01.route.profile, t01.route.tier, t01.route.role, t01.route.model, t01.route.backend, t01.route.effort, t01.route.mode, t01.route.evaluationContext, t01.route.reissued, t01.route.applied],
    [true, false, profileOf('implement', 'light', 'xhigh').profileId, 'light', 'implement', 'sonnet', 'sonnet', 'xhigh', 'active', 'desktop-auto-v1', true, true]);
  // The registry names the model by an alias; the host recorded the concrete id. Both are reported as recorded.
  assert.deepEqual([t01.route.modelEqualsBackend, t01.route.effortEqualsRoute, t01.route.reissueAgeMs, t01.route.hookMs], [false, true, 6001, 801]);
  assert.deepEqual(t01.judge, { decisions: 2, requests: 2, cached: 0, requestsWithUsage: 2, inputTokens: 802, outputTokens: 42, latencyMs: 602, decisionIdsOnRoute: 2 });
  assert.deepEqual(t01.notes, []);
  // A cached profile decision is a decision, not a request, and carries no usage.
  assert.deepEqual(row(armRr, 't05').judge, { decisions: 2, requests: 1, cached: 1, requestsWithUsage: 1, inputTokens: 405, outputTokens: 25, latencyMs: 305, decisionIdsOnRoute: 2 });
  // Deferred: one call, launched as issued, ran as the harness default.
  const t04 = row(armRr, 't04');
  assert.deepEqual([t04.delegation.agentCalls, t04.delegation.refusedCalls, t04.subagent.agentType, t04.subagent.model, t04.subagent.effort], [1, 0, 'general-purpose', MAIN_MODEL, 'medium']);
  assert.deepEqual([t04.route.recorded, t04.route.deferred, t04.route.deferReason, t04.route.profile, t04.route.applied, t04.route.reissued], [false, true, 'selector_abstained', null, null, false]);
  // Not delegated: counts as not passed although the project file is correct.
  const t12 = row(armRr, 't12');
  assert.deepEqual([t12.check.passed, t12.counted.passed, t12.counted.done, t12.delegation.delegated, t12.subagent], [true, false, false, false, null]);
  assert.ok(t12.notes.some((note) => note.includes('did not delegate')));
  // Done but a hidden check failed; not done at all.
  assert.deepEqual([row(armRr, 't03').counted, row(armRr, 't03').check.failed], [{ done: true, passed: false }, ['hidden: names that read differently stay different']]);
  assert.deepEqual(row(armRr, 't08').counted, { done: false, passed: false });
  assert.deepEqual(armRr.totals.routing, { routed: 10, deferred: ['t04'], applied: 10, notApplied: [], reissued: 10,
    profiles: { [profileOf('implement', 'light', 'xhigh').profileId]: 3, [profileOf('implement', 'light', 'high').profileId]: 3, [profileOf('implement', 'standard', 'high').profileId]: 2, [profileOf('implement', 'standard', 'xhigh').profileId]: 2 },
    evaluationContexts: ['desktop-auto-v1'],
    // t04 was deferred and ran as the harness default on the Main model; it passed, but not as a routed profile.
    byApplication: { asRoutedProfile: { tasks: 10, passed: 8, models: [OPUS, SONNET] }, notAsRoutedProfile: { tasks: ['t04'], passed: ['t04'], models: [MAIN_MODEL] } } });
  assert.equal(armRr.totals.noRoutingCheck, null);
  assert.deepEqual(armLl.totals.routing.byApplication, { asRoutedProfile: { tasks: 12, passed: 10, models: [SONNET] }, notAsRoutedProfile: { tasks: [], passed: [], models: [] } });
  assert.deepEqual(Object.keys(armRr.totals.subagentsByModel).sort(), [MAIN_MODEL, OPUS, SONNET]);
  assert.deepEqual([armRr.totals.subagentsByModel[SONNET].tasks, armRr.totals.subagentsByModel[OPUS].tasks, armRr.totals.subagentsByModel[MAIN_MODEL].tasks], [6, 4, 1]);
  assert.deepEqual([armRr.totals.subagentsByModel[OPUS].passed, armRr.totals.subagentsByModel[OPUS].done], [2, 3]);
  const sonnet = [1, 2, 5, 7, 9, 11].reduce((sum, n) => addTokens(sum, subTokens(n)), {});
  for (const key of ['input', 'output', 'cacheRead', 'cacheCreation']) assert.equal(armRr.totals.subagentsByModel[SONNET][key], sonnet[key], key);
  assert.deepEqual([armRr.totals.judge.all.decisions, armRr.totals.judge.all.requests, armRr.totals.judge.all.cached], [20, 19, 1]);
  assert.deepEqual(Object.keys(armRr.totals.judge.byPoint), ['delegation.classify', 'delegation.profile']);
  assert.equal(armRr.totals.judge.onTaskRoutes.requests, 19);
  assert.equal(armRr.totals.subagentWallMs, 11 * 12105);
});

test('damaged or missing records become null plus a note, never a guess', () => {
  const plan = { t01: routed('light', 'high', { noMeta: true }), t02: routed('light', 'high', { noTranscript: true }), t03: routed('light', 'high', { noUsage: true }), t04: routed('light', 'high', { notFinished: true }),
    t05: routed('light', 'high', { twoModels: true }), t06: routed('light', 'high', { neverReissued: true }), t07: routed('light', 'high', { reissueLinked: false }), t08: routed('light', 'high', { mode: 'shadow' }),
    t09: { kind: 'routed', profile: profileOf('implement', 'standard', 'high').profileId, model: SONNET, effort: null }, t10: { kind: 'plain', model: MAIN_MODEL, effort: 'medium' } };
  const fixture = writeArmFixture(fresh('arm-damaged'), { arm: 'R', tasks, plan, mainPrompt: 'something else', profiles: profilesById, judgeUsage: false });
  const fake = { tasks: tasks.map((task) => ({ id: task.id, done: true, passed: true, details: [{ name: 'basic: x', ok: true }] })), unattributedChanges: [{ path: 'README.md', change: 'modified' }] };
  const arm = analyzeArm({ arm: 'R', project: projectN, transcriptsDir: fixture.transcripts, stateDir: fixture.stateDir, check: fake });
  const of = (id) => row(arm, id);
  assert.deepEqual([of('t01').subagent.agentType, of('t01').subagent.model, of('t01').subagent.files, of('t01').route.applied], [null, SONNET, 2, null]);
  assert.ok(of('t01').notes.some((n) => n.includes('meta.json')) && of('t01').notes.some((n) => n.includes('2 of the 3')));
  assert.equal(of('t02').subagent, null); assert.ok(of('t02').notes.some((n) => n.includes('no transcript file')));
  assert.deepEqual(of('t03').subagent.tokens, { input: null, output: null, cacheRead: null, cacheCreation: null });
  assert.equal(of('t03').subagent.apiTurns, 3);
  assert.equal(of('t04').subagent.finished, false); assert.ok(of('t04').notes.some((n) => n.includes('not finished')));
  assert.equal(of('t05').subagent.model, null); assert.ok(of('t05').notes.some((n) => n.includes('no single model')));
  assert.deepEqual([of('t06').delegation.agentCalls, of('t06').delegation.refusedCalls, of('t06').delegation.launchedCalls, of('t06').subagent], [1, 1, 0, null]);
  assert.ok(of('t06').notes.some((n) => n.includes('launched a subagent')));
  assert.equal(of('t07').route.reissued, false); assert.ok(of('t07').notes.some((n) => n.includes('delegation_reissued')));
  assert.ok(of('t08').notes.some((n) => n.includes('mode shadow')));
  assert.deepEqual([of('t09').subagent.effort, of('t09').route.effortEqualsRoute, of('t09').route.applied], [null, null, true]);
  assert.ok(of('t09').notes.some((n) => n.includes('no single effort')));
  // A hooked arm with a call the hook recorded nothing for.
  assert.deepEqual([of('t10').route.recorded, of('t10').route.deferred], [false, false]);
  assert.ok(of('t10').notes.some((n) => n.includes('no route and no route_deferred')));
  // No usage in the decision log: requests and latency are known, tokens are not.
  assert.deepEqual([of('t01').judge.requests, of('t01').judge.inputTokens, of('t01').judge.outputTokens, of('t01').judge.latencyMs], [2, null, null, 602]);
  assert.deepEqual([arm.totals.judge.all.inputTokens, arm.totals.judge.all.outputTokens], [null, null]);
  assert.equal(arm.main.promptContainsMainPrompt, false);
  assert.deepEqual(arm.unattributedChanges, [{ path: 'README.md', change: 'modified' }]);
  assert.equal(arm.totals.unlinkedSubagents.files, 0);
  // Missing state, missing decision log, missing folders.
  const noLog = writeArmFixture(fresh('arm-nolog'), { arm: 'R', tasks, plan: { t01: routed('light', 'high') }, profiles: profilesById, decisionLog: false });
  const bare = analyzeArm({ arm: 'R', project: projectN, transcriptsDir: noLog.transcripts, stateDir: noLog.stateDir, check: fake });
  assert.ok(bare.warnings.some((w) => w.includes('no decision log rows')));
  assert.deepEqual([row(bare, 't01').judge.requests, row(bare, 't01').judge.inputTokens], [0, null]);
  assert.ok(row(bare, 't01').notes.some((n) => n.includes('not in the decision log')));
  const stateless = analyzeArm({ arm: 'L', project: projectN, transcriptsDir: noLog.transcripts, check: fake });
  assert.ok(stateless.warnings.some((w) => w.includes('no --state-dir')));
  assert.deepEqual([row(stateless, 't01').route, stateless.totals.judge], [null, null]);
  const empty = analyzeArm({ arm: 'N', project: projectN, transcriptsDir: fresh('empty'), check: fake });
  assert.deepEqual([empty.main, empty.totals.delegated, empty.totals.passed, row(empty, 't01').delegation.delegated], [null, 0, 12, null]);
  assert.ok(empty.warnings.some((w) => w.includes('no Main transcript')));
  const hookedN = analyzeArm({ arm: 'N', project: projectN, transcriptsDir: fixtureR.transcripts, stateDir: fixtureR.stateDir, check: fake });
  assert.ok(hookedN.warnings.some((w) => w.includes('did not run without hooks')));
  // A hooked session handed in as arm N WITHOUT its state dir is still recognised, from the transcripts alone.
  const contaminated = analyzeArm({ arm: 'N', project: projectN, transcriptsDir: fixtureR.transcripts, check: fake });
  const routedIds = ['t01', 't02', 't03', 't05', 't06', 't07', 't08', 't09', 't10', 't11'];
  assert.deepEqual(contaminated.totals.noRoutingCheck, { clean: false, refusedCalls: 10, firstCallAsOtherType: [], launchedAsOtherType: routedIds, ranAsOtherType: routedIds, agentTypeUnknown: [] });
  assert.ok(contaminated.warnings.some((w) => w.includes('arm N: 10 Agent call(s) were refused')) && contaminated.warnings.some((w) => w.includes('launched Agent call asked for another agent type'))
    && contaminated.warnings.some((w) => w.includes('subagent ran as another agent type')));
  const shownN = render(compareArms({ N: contaminated, R: armRr, L: armLl }));
  assert.ok(shownN.includes('WARNING: arm N did not run as a no-routing arm (refused calls: 10;') && shownN.includes('[RAN AS implement_light_xhigh: not a no-routing run]'), shownN);
  assert.throws(() => analyzeArm({ arm: 'X', project: projectN, transcriptsDir: fixtureN.transcripts, check: fake }), /N, R or L/);
  assert.deepEqual(judgeCost([]), { decisions: 0, requests: 0, cached: 0, requestsWithUsage: 0, inputTokens: null, outputTokens: null, latencyMs: null });
});

// ---------------------------------------------------------------- comparison
test('compare shows the three arms per task, totals per arm, by tier and by model, and keeps models apart', () => {
  const result = compareArms({ N: armN, R: armRr, L: armLl });
  assert.equal(result.sameCheckerAndTasks, true);
  assert.deepEqual(result.arms, ['N', 'R', 'L']);
  assert.deepEqual(Object.fromEntries(result.arms.map((key) => [key, [result.summaries[key].passed, result.summaries[key].done, result.summaries[key].delegated]])), { N: [12, 12, 12], R: [9, 10, 11], L: [10, 12, 12] });
  assert.deepEqual(result.summaries.L.byDifficulty, { routine: { tasks: 4, delegated: 4, done: 4, passed: 4 }, moderate: { tasks: 4, delegated: 4, done: 4, passed: 4 }, hard: { tasks: 4, delegated: 4, done: 4, passed: 2 } });
  assert.deepEqual(Object.keys(result.summaries.L.subagentsByModel), [SONNET]);
  assert.equal(result.ceiling, false);
  // t04 (deferred in R) and t12 (not delegated in R) are left out of the routed comparison and stay in the totals.
  assert.deepEqual(result.routedComparison.excludedTasks, ['t04', 't12']);
  assert.deepEqual([result.routedComparison.arms.N.tasks, result.routedComparison.arms.R.passed, result.routedComparison.arms.L.passed], [10, 8, 8]);
  const text = render(result);
  for (const expected of ['Descriptive numbers only', 'N ran as', 'deferred:selector_abstained -> fable-5-2/medium', 'implement_light_xhigh -> sonnet-5-5/xhigh', 'fable-5-2/medium',
    `R    ${SONNET}`, `R    ${OPUS}`, `L    ${SONNET}`, 'No cost estimate: no --prices file was given', 'Left out: t04, t12', 'N no routing', 'cache creation']) {
    assert.ok(text.includes(expected), `missing "${expected}" in:\n${text}`);
  }
  assert.ok(!text.includes('CEILING') && !text.includes('WARNING: arm N'));
  // Small differences are read by the rule fixed in advance: 12 vs 9 and 12 vs 10 are described, 9 vs 10 is not.
  assert.deepEqual(result.smallDifferences.pairs.map((pair) => [pair.arms.join(''), pair.difference, pair.verdict]),
    [['NR', 3, 'described as a difference'], ['NL', 2, 'described as a difference'], ['RL', 1, 'not distinguishable']]);
  assert.deepEqual(result.smallDifferences.pairs[2].passedOnlyIn, { R: ['t06', 't10'], L: ['t03', 't08', 't12'] });
  assert.equal(result.nearCeiling, false);
  for (const expected of ['R vs L: 9 vs 10, difference 1 -> not distinguishable (passed only in R: t06, t10; passed only in L: t03, t08, t12)', 'N vs L: 12 vs 10, difference 2 -> described as a difference',
    'R: of 9 passed, 8 ran as the routed profile (recorded models: opus-5-5, sonnet-5-5); 1 passed without an applied route (t04; ran as the harness default on: fable-5-2).',
    'L: of 10 passed, 10 ran as the routed profile (recorded models: sonnet-5-5); 0 passed without an applied route. Only the first number is a lower-model-only result']) {
    assert.ok(text.includes(expected), `missing "${expected}" in:\n${text}`);
  }
  // Near ceiling: every arm fails at most one task. Reported as such, and the one-task differences as not distinguishable.
  const oneDown = (arm, id) => ({ ...arm, tasks: arm.tasks.map((task) => (task.id === id ? { ...task, counted: { ...task.counted, passed: false } } : task)), totals: { ...arm.totals, passed: arm.totals.passed - 1 } });
  const near = compareArms({ N: armN, R: { ...armN, arm: 'R' }, L: oneDown({ ...armN, arm: 'L' }, 't08') });
  assert.deepEqual([near.ceiling, near.nearCeiling, near.smallDifferences.pairs.map((pair) => pair.verdict)], [false, true, ['not distinguishable', 'not distinguishable', 'not distinguishable']]);
  assert.ok(render(near).includes('NEAR CEILING: every arm failed at most one task. The quality question stays open'));
  assert.ok(!/\$|USD/.test(text), 'no money without --prices');
  const t03 = text.split('\n').find((line) => line.startsWith('t03 '));
  assert.match(t03, /^t03\s+en\s+hard\s+P\s+fable-5-2\/medium\s+D\s+implement_standard_high -> opus-5-5\/high\s+P\s+/);
  const t12 = text.split('\n').find((line) => line.startsWith('t12 '));
  assert.match(t12, /^t12\s+en\s+routine\s+P\s+\S+\s+-\s+-\s+P/);
  // Ceiling: every arm passes everything.
  const all = compareArms({ N: armN, R: { ...armN, arm: 'R' }, L: { ...armN, arm: 'L' } });
  assert.equal(all.ceiling, true);
  assert.ok(render(all).includes('CEILING: every arm passed every task. The quality question stays open'));
  assert.throws(() => compareArms({ N: armRr, R: armRr, L: armLl }), /analysed as arm R/);
  assert.equal(compareArms({ N: armN, R: { ...armRr, checker: { ...armRr.checker, version: 'other' } }, L: armLl }).sameCheckerAndTasks, false);
});

test('a cost estimate exists only with a prices file, per model, and is withheld when a price or a token count is missing', () => {
  const file = join(fresh('prices'), 'prices.json');
  const complete = { currency: 'USD', source: 'synthetic test prices', checkedAt: '2026-11-20', perMillionTokens: {
    [SONNET]: { input: 1, output: 2, cacheRead: 0.5, cacheCreation: 1.5 }, [OPUS]: { input: 10, output: 20, cacheRead: 5, cacheCreation: 15 }, [MAIN_MODEL]: { input: 100, output: 200, cacheRead: 50, cacheCreation: 150 } } };
  writeFileSync(file, JSON.stringify(complete));
  const prices = loadPrices(file);
  const priced = compareArms({ N: armN, R: armRr, L: armLl }, { prices });
  const l = priced.summaries.L.cost;
  const sonnetL = armLl.totals.subagentsByModel[SONNET];
  const expected = (sonnetL.input * 1 + sonnetL.output * 2 + sonnetL.cacheRead * 0.5 + sonnetL.cacheCreation * 1.5) / 1e6;
  assert.ok(Math.abs(l.subagents - expected) < 1e-12);
  assert.ok(l.total > l.subagents && l.missing.length === 0 && l.judgeRequestsPriced === false);
  assert.equal(priced.summaries.R.cost.parts.filter((p) => p.where === 'subagents').length, 3, 'one part per model');
  const text = render(priced);
  assert.ok(text.includes('Cost ESTIMATE from the prices file given on the command line (USD; source: synthetic test prices; checked: 2026-11-20). Judge requests are not priced.'));
  // A model without a price: no total for that arm, and the reason is named.
  const partial = structuredClone(complete); delete partial.perMillionTokens[OPUS];
  const withGap = compareArms({ N: armN, R: armRr, L: armLl }, { prices: partial });
  assert.deepEqual([withGap.summaries.R.cost.total, withGap.summaries.R.cost.subagents], [null, null]);
  assert.deepEqual(withGap.summaries.R.cost.missing, [`subagents: no price for ${OPUS}`]);
  assert.ok(withGap.summaries.L.cost.total !== null);
  assert.deepEqual(estimate({ input: 1, output: 1, cacheRead: null, cacheCreation: 1 }, SONNET, complete), { cost: null, reason: `a token kind of ${SONNET} is unmeasured` });
  writeFileSync(file, JSON.stringify({ perMillionTokens: {} }));
  assert.throws(() => loadPrices(file), /source/);
  writeFileSync(file, JSON.stringify({ ...complete, perMillionTokens: { x: { input: 1 } } }));
  assert.throws(() => loadPrices(file), /cacheCreation/);
  // The CLI prints the same table and refuses to run without the three arm files.
  const dir = fresh('cli');
  for (const [name, arm] of [['n', armN], ['r', armRr], ['l', armLl]]) writeFileSync(join(dir, `${name}.json`), JSON.stringify(arm));
  const cli = spawnSync(process.execPath, [join(here, 'compare.mjs'), '--n', join(dir, 'n.json'), '--r', join(dir, 'r.json'), '--l', join(dir, 'l.json')], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, render(compareArms({ N: armN, R: armRr, L: armLl })));
  assert.equal(spawnSync(process.execPath, [join(here, 'compare.mjs'), '--n', join(dir, 'n.json')], { encoding: 'utf8' }).status, 64);
  // A collector file that a failed command left empty, or that is not a collector summary, is named; no stack trace.
  writeFileSync(join(dir, 'empty.json'), '');
  writeFileSync(join(dir, 'other.json'), '{"x":1}');
  const three = ['--n', join(dir, 'n.json'), '--r', join(dir, 'r.json'), '--l', join(dir, 'l.json')];
  const emptyCollector = spawnSync(process.execPath, [join(here, 'compare.mjs'), ...three, '--collector-r', join(dir, 'empty.json')], { encoding: 'utf8' });
  assert.equal(emptyCollector.status, 1); assert.match(emptyCollector.stderr, /^--collector-r: .* is empty \(the command that should have written it failed/); assert.ok(!emptyCollector.stderr.includes('SyntaxError'));
  const notSummary = spawnSync(process.execPath, [join(here, 'compare.mjs'), ...three, '--collector-l', join(dir, 'other.json')], { encoding: 'utf8' });
  assert.equal(notSummary.status, 1); assert.match(notSummary.stderr, /not a summary printed by collect\.mjs/);
});

// ---------------------------------------------------------------- verification file and the collector
test('the verification file is what the collector accepts: checker result, validator, artifact hash, task hash', () => {
  const dir = fresh('verification');
  const cli = spawnSync(process.execPath, [join(here, 'make-verification.mjs'), '--project', projectR, '--out', join(dir, 'v.json'), '--artifact-out', join(dir, 'checker.json')], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const file = JSON.parse(readFileSync(join(dir, 'v.json'), 'utf8'));
  const checker = spawnSync(process.execPath, [join(here, 'checkers', 'check.mjs'), '--project', projectR], { encoding: 'utf8' });
  assert.equal(readFileSync(join(dir, 'checker.json'), 'utf8'), checker.stdout, 'the artifact is the checker output as its CLI prints it');
  assert.deepEqual(Object.keys(file), ['schema', 'results']);
  assert.equal(file.results.length, 12);
  const version = sha(readFileSync(join(here, 'checkers', 'check.mjs')));
  const result = JSON.parse(checker.stdout);
  file.results.forEach((entry, i) => {
    assert.deepEqual(Object.keys(entry), ['taskHash', 'passed', 'validator', 'artifactSha256']);
    assert.equal(entry.taskHash, sha(Buffer.from(tasks[i].text, 'utf8')), 'the documented hash: SHA-256 of the UTF-8 bytes of the task text, untrimmed');
    assert.equal(entry.taskHash, taskHash(tasks[i].text));
    assert.equal(entry.passed, result.tasks[i].passed);
    assert.deepEqual(entry.validator, { name: VALIDATOR_NAME, version });
    assert.equal(entry.artifactSha256, sha(checker.stdout));
  });
  assert.deepEqual(file.results.filter((entry) => !entry.passed).map((entry) => tasks.find((t) => taskHash(t.text) === entry.taskHash).id), ['t03', 't08']);
  assert.equal(parseVerification(file).length, 12);
  assert.equal(parseVerification(file)[0].validator, `routing-exp-checker@${version}`);
  const summary = JSON.parse(cli.stdout);
  assert.deepEqual([summary.entries, summary.hashedText, Object.keys(summary.checkerFiles)], [12, 'tasks.json text', ['check.mjs', 'probes.mjs', 'probe.mjs', 'tree.mjs']]);
  assert.ok(!JSON.stringify(file).includes('src/') && !cli.stdout.includes(tasks[0].text.slice(0, 30)), 'no path and no task text');
  // With the transcripts: the hash of what Main issued; a task Main never delegated has no entry.
  const built = buildVerification({ project: projectR, transcripts: fixtureR.transcripts, result });
  assert.equal(built.file.results.length, 11);
  assert.deepEqual(built.summary.tasks.find((t) => t.task === 't12'), { task: 't12', delegated: false, verbatim: null, done: true, passed: true, entry: false });
  assert.ok(built.summary.tasks.filter((t) => t.delegated).every((t) => t.verbatim === true));
  assert.deepEqual(built.file.results.map((entry) => entry.taskHash), file.results.slice(0, 11).map((entry) => entry.taskHash));
});

test('the collector matches the verification entries and produces evaluation rows for routed tasks under desktop-auto-v1', async () => {
  const check = checkProject({ project: projectR });
  const verification = parseVerification(buildVerification({ project: projectR, transcripts: fixtureR.transcripts, result: check }).file);
  const config = (registry) => ({ ...defaults('/nonexistent-home'), mode: 'active', registry, optimization: { ...defaults('/nonexistent-home').optimization, evaluationContext: EVALUATION_CONTEXT } });
  const run = (registry, context = EVALUATION_CONTEXT) => collect({ stateDir: fixtureR.stateDir, transcriptsDir: fixtureR.transcripts, verification, dryRun: true, evaluationContext: context, config: config(registry) });
  const declared = await run(armR.registry);
  assert.deepEqual([declared.verification.matched, declared.verification.unmatched], [11, 0]);
  assert.deepEqual([declared.delegations.seen, declared.delegations.joined, declared.delegations.refusedAndReissued], [11, 11, 10]);
  assert.deepEqual([declared.evaluations.context, declared.evaluations.produced, declared.evaluations.producedByModelMatch], [EVALUATION_CONTEXT, 10, { exact: 0, declared: 10 }]);
  assert.deepEqual([declared.evaluations.withheldTasks, declared.evaluations.withheld], [1, { delegation_not_routed: 1 }]);
  assert.deepEqual(declared.delegationIndex.filter((d) => d.verified === false).length, 2, 't03 and t08 carry a failed verification');
  // The same session read with a registry that declares nothing: no row, and the reason says why.
  const undeclared = await run(aliasRegistry());
  assert.equal(undeclared.evaluations.produced, 0);
  assert.ok(undeclared.evaluations.withheld.effective_model_alias_undeclared >= 10);
  // Read under another context name: the session ran under desktop-auto-v1, so nothing is relabelled.
  const renamed = await run(armR.registry, 'another-context');
  assert.equal(renamed.evaluations.produced, 0);
  assert.equal(renamed.evaluations.withheld.session_ran_under_another_evaluation_context, 10);
  // compare.mjs reads these summaries.
  const shown = compareArms({ N: armN, R: armRr, L: armLl }, { collectors: { R: declared } });
  assert.deepEqual(shown.summaries.R.collector, { context: EVALUATION_CONTEXT, produced: 10, producedByModelMatch: { exact: 0, declared: 10 }, withheldTasks: 1, withheld: { delegation_not_routed: 1 },
    delegationsSeen: 11, joined: 11, modelMatch: declared.modelMatch.delegations, verificationMatched: 11 });
  assert.ok(render(shown).includes('delegation_not_routed x1') && render(shown).includes('minimumSamples'));
});
