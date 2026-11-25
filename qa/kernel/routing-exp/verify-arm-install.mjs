#!/usr/bin/env node
// Offline check of the documented install order for arms R and L, with the REAL installer, in a temporary folder.
//   node verify-arm-install.mjs
// Nothing outside a fresh temporary directory is written, the real home is not touched (the installer always gets
// --home <temp>), no network is used and no API key exists in the run (the installer copies its own .env.example,
// whose key line is empty; the private env file of this run holds a placeholder that is not a key, and the hook
// drive below talks to a judge stub on 127.0.0.1 only).
//
// For each arm, starting from the pre-registered base-registry.json:
//   1. install.mjs --home <tmp>/home-X --project <tmp>/arm-x --runtime claude --env-file <tmp>/private.env --registry base-registry.json --yes
//   2. make-arm-config.mjs --arm X --work <tmp> --config ... --env ... --confirm-availability sonnet --confirm-availability opus
//   3. install.mjs ... --registry <tmp>/routing-exp-arm-X/registry.json --yes
//   4. make-arm-config.mjs --verify
//   5. project-hooks.mjs
// and then, through the product's own code: the config as the hook loads it (config.mjs loadConfig), the check the
// hook makes before it rewrites a call to a profile (profiles.mjs assertInstalledProfile), and THE HOOK ITSELF:
// synthetic Agent PreToolUse events are piped into the command that project-hooks.mjs put into the project's
// .claude/settings.json, with a judge stub on 127.0.0.1, and the hook's answer is read. An install whose every
// step exits 0 can still be one in which nothing is routed (unconfirmed availability); only the hook's answer shows it.
// For that drive the installed config.json is COPIED next to the install with three fields changed (endpoint ->
// the loopback stub, allowLoopback, stateDir -> a folder of the drive) together with a copy of its .env. The
// arm's own config, .env and state folder are not touched by it.
// Also checked: make-arm-config.mjs refuses (exit 1) when availability is not confirmed on the command line, and
// when the install did not start from base-registry.json (the installer's own default registry).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../orchestration/src/config.mjs';
import { profileCatalog } from '../../../orchestration/src/catalog.mjs';
import { assertInstalledProfile } from '../../../orchestration/src/profiles.mjs';
import { EVALUATION_CONTEXT } from './make-arm-config.mjs';
import { BASE_REGISTRY_FILE } from './make-base-registry.mjs';
import { preflight } from './preflight.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const product = path.join(here, '..', '..', '..', 'orchestration');
const installCli = path.join(product, 'scripts', 'install.mjs');
const sha = (data) => createHash('sha256').update(data).digest('hex');
export const CONFIRM = ['--confirm-availability', 'sonnet', '--confirm-availability', 'opus'];

// ---------------------------------------------------------------- the hook, driven offline
// A judge stub: answers every question of a request with one choice at confidence 1. `overrides` picks the choice
// per question name; otherwise a fixed default, otherwise the first criterion (for the profile question: the
// first candidate the product offered). The shape is the one the product's own tests use for the Jev judge.
const DEFAULT_CHOICES = { role: 'implement', complexity: 'bounded', risk: 'normal', reading: 'targeted', reasoning: 'routine', information: 'sufficient', failure: 'environment', kind: 'reference' };
function judgeAnswer(questions, overrides) {
  const answers = {};
  for (const [key, question] of Object.entries(questions ?? {})) {
    if (question.type === 'noul') { answers[key] = { type: 'noul', noul: 0.1 }; continue; }
    const selected = overrides[key] ?? DEFAULT_CHOICES[key] ?? Object.keys(question.criteria)[0];
    answers[key] = { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((k) => [k, k === selected ? 1 : 0])) };
  }
  return { model: 'judge-stub-not-live', answers, usage: { input_tokens: 12, output_tokens: 0 } };
}
export const DRIVE_SCENARIOS = [
  { name: 'implement', overrides: {}, prompt: 'Add src/util/duration.mjs exporting formatDuration(minutes) for the class schedule.' },
  { name: 'research', overrides: { role: 'research' }, prompt: 'Find out which modules read the studio time zone and report the list.' },
  { name: 'review', overrides: { role: 'review' }, prompt: 'Review src/payments/ledger.mjs for mistakes and report them.' },
  { name: 'plan', overrides: { role: 'plan' }, prompt: 'Plan how the waitlist could be stored in the shared store.' },
];

/** Pipes synthetic Agent PreToolUse events into the hook command of the project's settings.json. */
export async function driveInstalledHook({ root, arm, home, project, configFile, envFile }) {
  const settings = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'));
  const command = (settings.hooks?.PreToolUse ?? []).flatMap((group) => group.hooks ?? []).map((hook) => hook.command).find((text) => typeof text === 'string' && text.includes('jev-hook'));
  if (!command) return { error: 'the project settings carry no PreToolUse jev-hook command' };
  const argv = [...command.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  const at = argv.indexOf('--config');
  if (argv.length < 2 || at < 0 || argv[at + 1] !== configFile) return { error: 'the hook command does not name the arm install\'s config.json' };
  const requests = [];
  let overrides = {};
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    let parsed; try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
    requests.push(Object.keys(parsed.questions ?? {}));
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(judgeAnswer(parsed.questions, overrides)));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const dir = path.join(root, `hook-drive-${arm}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const installed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const driveConfig = path.join(dir, 'config.json');
    fs.writeFileSync(driveConfig, JSON.stringify({ ...installed, endpoint: `http://127.0.0.1:${server.address().port}`, allowLoopback: true, stateDir: path.join(dir, 'state') }, null, 2) + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, '.env'), fs.readFileSync(envFile, 'utf8'), { mode: 0o600 });
    argv[at + 1] = driveConfig;
    const byId = new Map(profileCatalog(installed.registry, 'claude').map((p) => [p.profileId, p]));
    const out = [];
    for (const [index, scenario] of DRIVE_SCENARIOS.entries()) {
      overrides = scenario.overrides;
      const before = requests.length;
      const event = { hook_event_name: 'PreToolUse', session_id: `hook-drive-${arm}`, cwd: fs.realpathSync(project), tool_use_id: `toolu_drive_${arm}_${index}`, tool_name: 'Agent', permission_mode: 'auto',
        tool_input: { prompt: scenario.prompt, subagent_type: 'general-purpose', description: scenario.name } };
      const result = await new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), { env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: os.tmpdir() }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.on('error', reject); child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => resolve({ code, stdout, stderr })); child.stdin.end(JSON.stringify(event));
      });
      let parsed = null; try { parsed = JSON.parse(result.stdout || '{}'); } catch { /* not JSON */ }
      const updated = parsed?.hookSpecificOutput?.updatedInput ?? null;
      const text = [parsed?.hookSpecificOutput?.additionalContext, parsed?.systemMessage].filter((t) => typeof t === 'string').join(' ');
      const profile = updated ? byId.get(updated.subagent_type) ?? null : null;
      out.push({ scenario: scenario.name, exit: result.code, rewritten: Boolean(updated), subagentType: updated?.subagent_type ?? null,
        installedProfile: updated ? Boolean(profile) : null, slot: profile?.slot ?? null, role: profile?.role ?? null, backend: profile?.backend ?? null, effort: profile?.effort ?? null,
        promptKept: updated ? typeof updated.prompt === 'string' && updated.prompt.includes(scenario.prompt) : null,
        permissionDecision: parsed?.hookSpecificOutput?.permissionDecision ?? null,
        code: updated ? null : (/Jev hooks: ([A-Z_]+)/.exec(text)?.[1] ?? /\(([a-z_]+)\)/.exec(text)?.[1] ?? (text ? 'other' : 'no output')),
        judgeRequests: requests.length - before });
    }
    return { scenarios: out, rewritten: out.filter((r) => r.rewritten).length, deferred: out.filter((r) => !r.rewritten).length };
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

// The installer runs with HOME pointing at the disposable home (it gets --home as well). The experiment's own tools
// run with the caller's HOME, because their guard against the real home directory reads it.
function run(file, argv, home = null) {
  const child = spawnSync(process.execPath, [file, ...argv], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home ?? os.homedir(), TMPDIR: os.tmpdir() } });
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}
const firstJson = (text) => { try { return JSON.parse(text.slice(0, text.lastIndexOf('\n}') + 2)); } catch { return null; } };
const agentFiles = (home) => {
  const dir = path.join(home, '.claude', 'agents');
  return Object.fromEntries(fs.readdirSync(dir).filter((name) => /^jev4_.*\.md$/.test(name)).sort().map((name) => [name, sha(fs.readFileSync(path.join(dir, name)))]));
};

export async function verifyBase(root) {
  const work = path.join(root, 'run');
  fs.mkdirSync(work, { recursive: true });
  const baseRegistryFile = BASE_REGISTRY_FILE;
  // Stands in for the owner's private env file of README step 1: egress approved, and a placeholder that is not a key.
  const privateEnv = path.join(work, 'private.env');
  fs.writeFileSync(privateEnv, 'TYPESAFE_API_KEY=placeholder-not-a-key\nJEV_ALLOW_EGRESS=true\n', { mode: 0o600 });
  const arms = {};
  for (const arm of ['R', 'L']) {
    const home = path.join(work, `home-${arm.toLowerCase()}`);
    const project = path.join(work, `arm-${arm.toLowerCase()}`);
    fs.mkdirSync(home, { recursive: true });
    fs.cpSync(path.join(here, 'template'), project, { recursive: true });
    const configFile = path.join(home, '.config', 'jev-hooks', 'config.json');
    const envFile = path.join(home, '.config', 'jev-hooks', '.env');
    const install = ['--home', home, '--project', project, '--runtime', 'claude', '--yes'];
    const steps = {};

    const first = run(installCli, [...install, '--env-file', privateEnv, '--registry', baseRegistryFile], home);
    steps.baseInstall = { exit: first.status, applied: firstJson(first.stdout)?.applied ?? null };
    const baseFiles = first.status === 0 ? agentFiles(home) : {};
    const envBefore = first.status === 0 ? fs.readFileSync(envFile, 'utf8') : '';

    // Without the owner's availability statement the tool must stop and write nothing.
    const unconfirmed = run(path.join(here, 'make-arm-config.mjs'), ['--arm', arm, '--work', work, '--config', configFile, '--env', envFile]);
    steps.makeArmConfigWithoutConfirmation = { exit: unconfirmed.status, saysNotConfirmed: /not confirmed/.test(unconfirmed.stderr), wroteNothing: !fs.existsSync(path.join(work, `routing-exp-arm-${arm}`)) && fs.readFileSync(envFile, 'utf8') === envBefore };
    const make = run(path.join(here, 'make-arm-config.mjs'), ['--arm', arm, '--work', work, '--config', configFile, '--env', envFile, ...CONFIRM]);
    const summary = firstJson(make.stdout);
    steps.makeArmConfig = { exit: make.status, reinstallRequired: summary?.reinstallRequired ?? null };

    // Why the installer has to run again: with the arm registry merely written into the installed config.json, the
    // installed profile records still carry the old fingerprints (or name profiles the arm no longer has), and the
    // hook's check before a rewrite refuses every profile whose entry got a declaration. Computed in memory only.
    let inPlaceEdit = null;
    if (make.status === 0) {
      const installed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      const edited = { ...installed, registry: JSON.parse(fs.readFileSync(path.join(work, `routing-exp-arm-${arm}`, 'registry.json'), 'utf8')) };
      const codes = {};
      for (const profile of profileCatalog(edited.registry, 'claude')) {
        let code;
        try { code = (await assertInstalledProfile(edited, profile, fs.realpathSync(project))).status; } catch (error) { code = error.code ?? 'error'; }
        codes[code] = (codes[code] ?? 0) + 1;
      }
      inPlaceEdit = codes;
    }
    const second = run(installCli, [...install, '--registry', path.join(work, `routing-exp-arm-${arm}`, 'registry.json')], home);
    steps.armInstall = { exit: second.status, applied: firstJson(second.stdout)?.applied ?? null, error: second.status === 0 ? null : second.stderr.trim().split('\n')[0] };
    const verify = run(path.join(here, 'make-arm-config.mjs'), ['--verify', '--arm', arm, '--work', work, '--config', configFile]);
    steps.verify = { exit: verify.status, ok: firstJson(verify.stdout)?.ok ?? null, problems: firstJson(verify.stdout)?.problems ?? null };
    const hooks = run(path.join(here, 'project-hooks.mjs'), ['--work', work, '--home', home, '--project', project]);
    steps.projectHooks = { exit: hooks.status, events: firstJson(hooks.stdout)?.events?.length ?? null };
    // A third installer run must now be refused: the project carries the hooks.
    const third = run(installCli, install, home);
    steps.installAfterProjectHooks = { exit: third.status, error: third.stderr.trim().split('\n')[0] || null };

    // The config as a hook process loads it (config.json plus the .env beside it), and the pre-rewrite check.
    let effective = null, rewriteCheck = null;
    try {
      const { config } = await loadConfig(configFile, {});
      const catalog = profileCatalog(config.registry, 'claude');
      const outcomes = [];
      for (const profile of catalog) {
        try { outcomes.push((await assertInstalledProfile(config, profile, fs.realpathSync(project))).status); } catch (error) { outcomes.push(error.code ?? 'error'); }
      }
      effective = {
        mode: config.mode, evaluationContext: config.optimization.evaluationContext,
        skills: config.kernel.points['delegation.skills'].mode, supervisor: config.kernel.points['supervisor.outcome'].mode,
        classify: config.kernel.points['delegation.classify'].mode, profile: config.kernel.points['delegation.profile'].mode,
        allowedProjects: config.allowedProjects.length, stateDirBelowHome: config.stateDir.startsWith(fs.realpathSync(home)),
        requireConfirmedAvailability: config.optimization.requireConfirmedAvailability,
        enabledClaude: config.registry.models.filter((m) => m.runtime === 'claude' && m.enabled).map((m) => ({ id: m.id, backend: m.backend, availability: m.availability, resolvesTo: m.resolvesTo ?? null })),
      };
      rewriteCheck = { profiles: catalog.length, verified: outcomes.filter((status) => status === 'installed_definition_verified').length, other: [...new Set(outcomes.filter((status) => status !== 'installed_definition_verified'))] };
    } catch (error) { effective = { error: error.code ?? error.message }; }

    // The hook itself, through the command in the project's settings.json.
    let hookDrive;
    try { hookDrive = await driveInstalledHook({ root: work, arm, home, project, configFile, envFile }); } catch (error) { hookDrive = { error: error.code ?? error.message }; }

    const envAfter = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    const wanted = ['JEV_MODE=active', 'JEV_SKILLS_MODE=off', 'JEV_SUPERVISOR_MODE=off', `JEV_EVALUATION_CONTEXT=${EVALUATION_CONTEXT}`];
    const keyOf = (line) => /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    const touched = new Set(wanted.map(keyOf));
    const untouched = (text) => text.split('\n').filter((line) => !touched.has(keyOf(line)));
    const files = second.status === 0 ? agentFiles(home) : {};
    arms[arm] = {
      steps, effective, rewriteCheck, hookDrive, rewriteCheckIfRegistryWereOnlyEditedInConfig: inPlaceEdit,
      env: { linesPresentOnce: wanted.every((line) => envAfter.split('\n').filter((l) => l === line).length === 1),
        otherLinesUnchanged: JSON.stringify(untouched(envBefore).filter((line) => line !== '')) === JSON.stringify(untouched(envAfter).filter((line) => line !== '')),
        mode: (fs.statSync(envFile).mode & 0o777).toString(8) },
      declared: summary?.declared ?? null, notDeclared: summary?.notDeclared?.filter((e) => e.enabled) ?? null, disabled: summary?.disabled ?? null,
      availabilityConfirmed: summary?.availability?.entries?.map((e) => e.registryEntry) ?? null, baseIsCommitted: summary?.baseRegistry?.isCommittedBase ?? null,
      lowestEnabledClaude: summary?.lowestEnabledClaude ?? null,
      profilesWithChangedFingerprint: summary?.profilesWithChangedFingerprint?.length ?? null,
      profileFiles: Object.keys(files), fileHashes: files,
      sameNamesAndBytesAsBaseInstall: arm === 'R' ? JSON.stringify(files) === JSON.stringify(baseFiles) : null,
      projectSettings: fs.existsSync(path.join(project, '.claude', 'settings.json')),
    };
  }
  const r = arms.R.fileHashes, l = arms.L.fileHashes;
  const shared = Object.keys(l).filter((name) => Object.hasOwn(r, name));
  const comparison = {
    armRFiles: Object.keys(r).length, armLFiles: Object.keys(l).length,
    armLIsSubsetOfArmR: Object.keys(l).every((name) => Object.hasOwn(r, name)),
    sharedNames: shared.length, sharedFilesByteIdentical: shared.every((name) => r[name] === l[name]),
    onlyInArmR: Object.keys(r).filter((name) => !Object.hasOwn(l, name)),
  };
  for (const arm of Object.values(arms)) delete arm.fileHashes;

  // The pre-run checklist on these folders: a clean set-up passes; a hook in a settings file, a .claude folder in
  // arm N, a JEV_* variable in the environment and a wrong agents folder are each found.
  fs.cpSync(path.join(here, 'template'), path.join(work, 'arm-n'), { recursive: true });
  const userSettings = path.join(work, 'user-settings.json'), agentsDir = path.join(work, 'user-agents');
  fs.writeFileSync(userSettings, JSON.stringify({ permissions: {} }));
  fs.mkdirSync(agentsDir);
  for (const name of arms.R.profileFiles) fs.copyFileSync(path.join(work, 'home-r', '.claude', 'agents', name), path.join(agentsDir, name));
  const cleanCheck = preflight({ work, settings: [userSettings, path.join(work, 'no-such-settings.json')], agents: agentsDir, env: { PATH: 'x' } });
  fs.writeFileSync(userSettings, fs.readFileSync(path.join(work, 'home-r', '.claude', 'settings.json')));
  fs.mkdirSync(path.join(work, 'arm-n', '.claude'));
  fs.rmSync(path.join(agentsDir, arms.R.profileFiles[0]));
  fs.writeFileSync(path.join(agentsDir, arms.R.profileFiles[1]), 'changed');
  fs.writeFileSync(path.join(agentsDir, 'jev4_implement_light_high_0000000000.md'), 'stale');
  const dirtyCheck = preflight({ work, settings: [userSettings], agents: agentsDir, env: { PATH: 'x', JEV_MODE: 'shadow', TYPESAFE_BASE_URL: 'u' } });
  const preflightCheck = { clean: { ok: cleanCheck.ok, problems: cleanCheck.problems, agents: cleanCheck.agents && { expected: cleanCheck.agents.expected, present: cleanCheck.agents.present } },
    dirty: { ok: dirtyCheck.ok, problems: dirtyCheck.problems.length, found: {
      hookInSettings: dirtyCheck.problems.some((p) => p.includes('jev-hook command')), armNClaudeFolder: dirtyCheck.problems.some((p) => p.includes('arm-n has a .claude folder')),
      environment: dirtyCheck.problems.some((p) => p.includes('JEV_MODE, TYPESAFE_BASE_URL')), agentMissing: dirtyCheck.agents.missing.length, agentExtra: dirtyCheck.agents.extra.length, agentDiffering: dirtyCheck.agents.differing.length } } };

  // An install that did not start from base-registry.json (the installer's own default registry) is refused.
  const otherHome = path.join(work, 'home-other'), otherProject = path.join(work, 'arm-other');
  fs.mkdirSync(otherHome, { recursive: true });
  fs.cpSync(path.join(here, 'template'), otherProject, { recursive: true });
  const otherInstall = run(installCli, ['--home', otherHome, '--project', otherProject, '--runtime', 'claude', '--yes'], otherHome);
  const otherConfig = path.join(otherHome, '.config', 'jev-hooks', 'config.json');
  const otherBase = run(path.join(here, 'make-arm-config.mjs'), ['--arm', 'R', '--work', work, '--config', otherConfig, ...CONFIRM]);
  const undeclared = run(path.join(here, 'make-arm-config.mjs'), ['--arm', 'R', '--work', work, '--config', otherConfig, '--allow-other-base',
    '--confirm-availability', 'claude-sonnet-5', '--confirm-availability', 'claude-opus-5-5', '--confirm-availability', 'claude-fable-5-1']);
  const refusals = {
    installerDefaultRegistry: { installExit: otherInstall.status, exit: otherBase.status, saysNotBase: /not the pre-registered base-registry\.json/.test(otherBase.stderr) },
    undeclaredEntries: { exit: undeclared.status, saysNoDeclaredId: /no declared model id/.test(undeclared.stderr) },
  };
  return { base: 'base-registry.json', arms, comparison, refusals, preflight: preflightCheck };
}

export async function runInstallVerification() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'routing-exp-install-')));
  try { return await verifyBase(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(JSON.stringify(await runInstallVerification(), null, 2));
}
