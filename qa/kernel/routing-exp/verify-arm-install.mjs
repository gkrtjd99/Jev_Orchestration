#!/usr/bin/env node
// Offline check of the documented install order for arms R and L, with the REAL installer, in a temporary folder.
//   node verify-arm-install.mjs [--base alias|shipped|both]
// Nothing outside a fresh temporary directory is written, the real home is not touched (the installer always gets
// --home <temp>), no network is used and no API key exists in the run (the installer copies its own .env.example,
// whose key line is empty).
//
// For each base registry and each arm:
//   1. install.mjs --home <tmp>/home-X --project <tmp>/arm-x --runtime claude [--registry <base>] --yes
//   2. make-arm-config.mjs --arm X --work <tmp> --config ... --env ...
//   3. install.mjs ... --registry <tmp>/routing-exp-arm-X/registry.json --yes
//   4. make-arm-config.mjs --verify
//   5. project-hooks.mjs
// and then, through the product's own code: the config as the hook loads it (config.mjs loadConfig) and the check
// the hook makes before it rewrites a call to a profile (profiles.mjs assertInstalledProfile).
// Base registries:
//   alias    the registry shape of the owner's earlier real sessions: light = sonnet, standard = opus, strategic = opus
//   shipped  what install.mjs installs when no --registry is given (concrete model ids)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../orchestration/src/config.mjs';
import { profileCatalog } from '../../../orchestration/src/catalog.mjs';
import { assertInstalledProfile } from '../../../orchestration/src/profiles.mjs';
import { EVALUATION_CONTEXT } from './make-arm-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const product = path.join(here, '..', '..', '..', 'orchestration');
const installCli = path.join(product, 'scripts', 'install.mjs');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const ALIAS = { 'claude-light': 'sonnet', 'claude-standard': 'opus', 'claude-strategic': 'opus' };

function aliasRegistry() {
  const registry = JSON.parse(fs.readFileSync(path.join(product, 'config', 'registry.example.json'), 'utf8'));
  for (const entry of registry.models) if (ALIAS[entry.id]) { entry.model = ALIAS[entry.id]; entry.backend = ALIAS[entry.id]; }
  return registry;
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

export async function verifyBase(base, root) {
  const work = path.join(root, base);
  fs.mkdirSync(work, { recursive: true });
  let baseRegistryFile = null;
  if (base === 'alias') { baseRegistryFile = path.join(work, 'base-registry.json'); fs.writeFileSync(baseRegistryFile, JSON.stringify(aliasRegistry(), null, 2) + '\n'); }
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

    const first = run(installCli, [...install, ...(baseRegistryFile ? ['--registry', baseRegistryFile] : [])], home);
    steps.baseInstall = { exit: first.status, applied: firstJson(first.stdout)?.applied ?? null };
    const baseFiles = first.status === 0 ? agentFiles(home) : {};
    const envBefore = first.status === 0 ? fs.readFileSync(envFile, 'utf8') : '';

    const make = run(path.join(here, 'make-arm-config.mjs'), ['--arm', arm, '--work', work, '--config', configFile, '--env', envFile]);
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
        enabledClaude: config.registry.models.filter((m) => m.runtime === 'claude' && m.enabled).map((m) => ({ id: m.id, backend: m.backend, resolvesTo: m.resolvesTo ?? null })),
      };
      rewriteCheck = { profiles: catalog.length, verified: outcomes.filter((status) => status === 'installed_definition_verified').length, other: [...new Set(outcomes.filter((status) => status !== 'installed_definition_verified'))] };
    } catch (error) { effective = { error: error.code ?? error.message }; }

    const envAfter = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    const wanted = ['JEV_MODE=active', 'JEV_SKILLS_MODE=off', 'JEV_SUPERVISOR_MODE=off', `JEV_EVALUATION_CONTEXT=${EVALUATION_CONTEXT}`];
    const keyOf = (line) => /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    const touched = new Set(wanted.map(keyOf));
    const untouched = (text) => text.split('\n').filter((line) => !touched.has(keyOf(line)));
    const files = second.status === 0 ? agentFiles(home) : {};
    arms[arm] = {
      steps, effective, rewriteCheck, rewriteCheckIfRegistryWereOnlyEditedInConfig: inPlaceEdit,
      env: { linesPresentOnce: wanted.every((line) => envAfter.split('\n').filter((l) => l === line).length === 1),
        otherLinesUnchanged: JSON.stringify(untouched(envBefore).filter((line) => line !== '')) === JSON.stringify(untouched(envAfter).filter((line) => line !== '')),
        mode: (fs.statSync(envFile).mode & 0o777).toString(8) },
      declared: summary?.declared ?? null, notDeclared: summary?.notDeclared?.filter((e) => e.enabled) ?? null, disabled: summary?.disabled ?? null,
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
  return { base, arms, comparison };
}

export async function runInstallVerification(bases = ['alias', 'shipped']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-exp-install-'));
  try {
    const out = [];
    for (const base of bases) out.push(await verifyBase(base, root));
    return out;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const choice = process.argv[2] === '--base' ? process.argv[3] : 'both';
  if (!['alias', 'shipped', 'both'].includes(choice)) { console.error('usage: verify-arm-install.mjs [--base alias|shipped|both]'); process.exit(64); }
  console.log(JSON.stringify(await runInstallVerification(choice === 'both' ? ['alias', 'shipped'] : [choice]), null, 2));
}
