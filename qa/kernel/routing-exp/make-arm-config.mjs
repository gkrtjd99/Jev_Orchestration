#!/usr/bin/env node
// Arm configuration for the routing experiment (arms R and L; arm N has no hooks and needs nothing).
//
//   node make-arm-config.mjs --arm R|L --work <dir> --config <installed config.json> [--env <installed .env>]
//                            --confirm-availability <backend> [--confirm-availability <backend> ...]
//                            [--declare <backend>=<model id> ...] [--allow-undeclared] [--allow-other-base]
//   node make-arm-config.mjs --verify --arm R|L --work <dir> --config <installed config.json>
//
// --config is the config.json of a DISPOSABLE install (install.mjs --home <dir under --work> --registry
// base-registry.json). It is only read.
//
// Three things make this tool stop (exit 1) instead of producing an arm in which nothing is routed or measured:
//   * an enabled claude entry of the arm registry whose availability is not "confirmed". The product does not
//     rewrite a delegation to a profile of an unconfirmed entry (optimization.requireConfirmedAvailability, on by
//     default): with none confirmed every delegation gets CAPABILITIES_UNCONFIRMED, with some confirmed the
//     others are silently left out. Confirming is the owner's statement that this account can run that backend
//     at the registry's efforts; it is typed, per backend, as --confirm-availability <backend>, and recorded in
//     summary.json. This tool never confirms anything on its own.
//   * an enabled claude entry without a declared id whose backend is not itself an id the host records
//     (no resolvesTo): its runs would not become evaluation rows. --allow-undeclared overrides, and is recorded.
//   * an installed registry that is not the pre-registered base-registry.json. --allow-other-base overrides, and
//     is recorded (PROTOCOL.md section 8 then needs an entry).
// Written, all below --work and nowhere else:
//   <work>/routing-exp-arm-<R|L>/registry.json   the registry to hand to the installer (install.mjs --registry)
//   <work>/routing-exp-arm-<R|L>/env-lines.txt   the four env lines of the experiment
//   <work>/routing-exp-arm-<R|L>/summary.json    what was declared / disabled and which profiles the install must create
//   --env <file>  (optional, must be below --work) the four lines are set in that file in place
//
// Why a registry file and a second install instead of editing config.json: a `resolvesTo` declaration is part of
// the profile fingerprint, and the installed config records the fingerprint of every installed profile. Editing
// the registry in config.json alone leaves those records stale (rewrites are then refused with
// PROFILE_NOT_INSTALLED_OR_STALE), and arm L's smaller profile set has to be installed as such. So:
//   1. install.mjs --home <work>/home-X --project <arm project> --runtime claude --env-file <private env> --registry <this folder>/base-registry.json --yes
//   2. make-arm-config.mjs --arm X --work <work> --config <work>/home-X/.config/jev-hooks/config.json --env <work>/home-X/.config/jev-hooks/.env
//        --confirm-availability sonnet --confirm-availability opus
//   3. install.mjs --home <work>/home-X --project <arm project> --runtime claude --registry <work>/routing-exp-arm-X/registry.json --yes
//   4. make-arm-config.mjs --verify --arm X --work <work> --config <work>/home-X/.config/jev-hooks/config.json
// (README.md has the full sequence, including the project-level hooks and the user-level agent files.)
//
// What the arm registry is:
//   R  the installed registry, plus the declarations below on every claude entry whose backend they name
//   L  the same, and every claude entry whose backend is not the lowest enabled claude backend is disabled
// Declarations (the repository owner's choice for this experiment, ids seen in earlier real sessions on the
// owner's machine): backend "sonnet" -> "claude-sonnet-5-5", backend "opus" -> "claude-opus-5-5".
// Nothing is learned from a transcript; any further declaration must be typed with --declare.
//
// The .env: this tool never parses it and never prints, logs or copies anything from it. With --env it rewrites
// the file in place, replacing or appending only the four lines whose keys are listed in ENV_LINES; every other
// line passes through as opaque text. No API key is read as a value, none is needed, and nothing leaves --work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateRegistry, profileCatalog, SLOTS } from '../../../orchestration/src/catalog.mjs';
import { baseRegistry } from './make-base-registry.mjs';

export const EVALUATION_CONTEXT = 'desktop-auto-v1';
export const DECLARED_IDS = Object.freeze({ sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' });
export const ENV_LINES = Object.freeze({ JEV_MODE: 'active', JEV_SKILLS_MODE: 'off', JEV_SUPERVISOR_MODE: 'off', JEV_EVALUATION_CONTEXT: EVALUATION_CONTEXT });
export const PLACEHOLDER_ID = /^EXAMPLE-ONLY\./;
const ARMS = ['R', 'L'];
const fail = (message, code = 2) => Object.assign(new Error(message), { exitCode: code });

/**
 * Names (never values) of environment variables that the hook reads BEFORE the .env file of an install and that
 * change what the arm does. TYPESAFE_API_KEY is left out: a key in the environment replaces the key of the .env
 * but no setting of the arm (keyFromEnvironment reports it).
 */
export const overridingEnvNames = (env = process.env) => Object.keys(env).filter((name) => name !== 'TYPESAFE_API_KEY' && (/^(?:JEV_|TYPESAFE_)/.test(name) || /^CLAUDE_CODE_SUBAGENT_MODEL/.test(name))).sort();
export const keyFromEnvironment = (env = process.env) => Object.hasOwn(env, 'TYPESAFE_API_KEY');

/**
 * The arm's registry and what was done to get it. Pure: the input is not modified.
 * `confirm` is the list of backends whose availability the caller states is confirmed (typed by the owner).
 */
export function armRegistry(installed, arm, declarations = DECLARED_IDS, { confirm = [] } = {}) {
  if (!ARMS.includes(arm)) throw fail('--arm must be R or L');
  const registry = structuredClone(validateRegistry(structuredClone(installed)));
  const claude = registry.models.filter((m) => m.runtime === 'claude');
  const declared = [], notDeclared = [], removedPlaceholders = [], confirmed = [];
  // Availability is set on the entries that are enabled in the base, before arm L disables anything, so that
  // the registries of R and L differ in `enabled` only.
  for (const backend of confirm) {
    const entries = claude.filter((m) => m.enabled && m.availability !== 'unavailable' && m.backend === backend);
    if (entries.length === 0) throw fail(`--confirm-availability ${backend}: no enabled claude entry has this backend`, 1);
    for (const entry of entries) {
      confirmed.push({ registryEntry: entry.id, slot: entry.slot, backend: entry.backend, was: entry.availability });
      entry.availability = 'confirmed';
    }
  }
  for (const entry of claude) {
    if (Array.isArray(entry.resolvesTo) && entry.resolvesTo.some((id) => PLACEHOLDER_ID.test(id))) {
      // The example registry ships a placeholder that is not a model id. It must not travel into an experiment.
      entry.resolvesTo = entry.resolvesTo.filter((id) => !PLACEHOLDER_ID.test(id));
      if (entry.resolvesTo.length === 0) delete entry.resolvesTo;
      removedPlaceholders.push(entry.id);
    }
    const id = Object.hasOwn(declarations, entry.backend) ? declarations[entry.backend] : null;
    if (id !== null && id !== entry.backend) {
      entry.resolvesTo = [id];
      declared.push({ registryEntry: entry.id, backend: entry.backend, resolvesTo: [id], enabled: entry.enabled });
    } else {
      notDeclared.push({ registryEntry: entry.id, backend: entry.backend, enabled: entry.enabled, existing: entry.resolvesTo ?? null,
        reason: id !== null ? 'the declared id is the backend itself: rows match exactly, no declaration needed' : 'no declaration is pre-registered for this backend' });
    }
  }
  const usable = (m) => m.enabled && m.availability !== 'unavailable';
  const active = claude.filter(usable).sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
  if (active.length === 0) throw fail('the installed registry has no enabled claude entry', 1);
  const lowest = active[0];
  const disabled = [];
  if (arm === 'L') {
    for (const entry of claude) {
      if (usable(entry) && entry.backend !== lowest.backend) { entry.enabled = false; disabled.push({ registryEntry: entry.id, slot: entry.slot, backend: entry.backend }); }
    }
  }
  registry.revision = `${installed.revision}+routing-exp-arm-${arm}`;
  validateRegistry(registry);
  const profiles = profileCatalog(registry, 'claude').map((p) => ({ profileId: p.profileId, file: `${p.profileId}.md`, slot: p.slot, role: p.role, model: p.model, backend: p.backend, effort: p.effort, fingerprint: p.fingerprint }));
  const enabledNow = registry.models.filter((m) => m.runtime === 'claude' && m.enabled && m.availability !== 'unavailable');
  const unconfirmed = enabledNow.filter((m) => m.availability !== 'confirmed').map((m) => ({ registryEntry: m.id, slot: m.slot, backend: m.backend, availability: m.availability }));
  const undeclaredEnabled = notDeclared.filter((e) => enabledNow.some((m) => m.id === e.registryEntry) && e.reason.startsWith('no declaration') && e.existing === null);
  return { registry, declared, notDeclared, removedPlaceholders, confirmed, unconfirmed, undeclaredEnabled, disabled,
    lowest: { registryEntry: lowest.id, slot: lowest.slot, backend: lowest.backend }, profiles };
}

/** Whether a registry is the pre-registered base (base-registry.json as make-base-registry.mjs derives it). */
export function isCommittedBase(registry) {
  try { return JSON.stringify(validateRegistry(structuredClone(registry))) === JSON.stringify(validateRegistry(baseRegistry())); } catch { return false; }
}

/** The env text with the experiment's lines set. Other lines are passed through untouched and never inspected further. */
export function applyEnvLines(text, lines = ENV_LINES) {
  const pending = new Map(Object.entries(lines));
  const replaced = [], dropped = [];
  const out = [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  for (const line of text === '' ? [] : body.split('\n')) {
    const key = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    if (key === undefined || !Object.hasOwn(lines, key)) { out.push(line); continue; }
    if (pending.has(key)) { out.push(`${key}=${lines[key]}`); pending.delete(key); replaced.push(key); } else dropped.push(key);
  }
  const appended = [...pending.keys()];
  for (const key of appended) out.push(`${key}=${lines[key]}`);
  return { text: out.join('\n') + '\n', replaced, appended, duplicatesDropped: dropped };
}

// ---------------------------------------------------------------- paths
function realOf(target) {
  let current = path.resolve(target);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail); } catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
      tail.unshift(path.basename(current));
      current = path.dirname(current);
    }
  }
}
const below = (base, target) => { const rel = path.relative(base, target); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };

function checkedWork(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw fail('--work must be an absolute path');
  let work;
  try { work = fs.realpathSync(dir); } catch { throw fail('--work must be an existing directory'); }
  if (!fs.statSync(work).isDirectory()) throw fail('--work must be an existing directory');
  const home = realOf(os.homedir());
  if (work === home || below(work, home)) throw fail('--work must not be the home directory or a folder that contains it');
  return work;
}
function inside(work, file, option) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail(`${option} must be an absolute path`);
  const real = realOf(file);
  if (!below(work, real)) throw fail(`${option} must be below --work: this tool reads and writes a disposable install only`);
  for (const guarded of [path.join(os.homedir(), '.config'), path.join(os.homedir(), '.claude')].map(realOf)) {
    if (real === guarded || below(guarded, real)) throw fail(`${option} points into the real home configuration`);
  }
  return real;
}
function regularFile(file, option) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw fail(`${option}: no such file`, 1); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw fail(`${option} must be a regular file, not a link`);
  return stat;
}
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
}

// ---------------------------------------------------------------- what an installed config must look like
/** Differences between an installed config and what the arm needs; empty when the install is the arm's. */
export function verifyInstalled(config, armResult) {
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };
  expect(config.mode === 'active', `mode is ${config.mode}, expected active`);
  expect(config.optimization?.evaluationContext === EVALUATION_CONTEXT, `evaluationContext is ${config.optimization?.evaluationContext}, expected ${EVALUATION_CONTEXT}`);
  expect(config.kernel?.points?.['delegation.skills']?.mode === 'off', 'delegation.skills is not off');
  expect(config.kernel?.points?.['supervisor.outcome']?.mode === 'off', 'supervisor.outcome is not off');
  expect(config.kernel?.points?.['delegation.classify']?.mode === 'active', 'delegation.classify is not active');
  expect(config.kernel?.points?.['delegation.profile']?.mode === 'active', 'delegation.profile is not active');
  expect(Array.isArray(config.enabledRuntimes) && config.enabledRuntimes.includes('claude'), 'the claude runtime is not installed');
  expect(JSON.stringify(config.registry) === JSON.stringify(armResult.registry), 'the installed registry is not the arm registry (install.mjs --registry <arm registry> has not been run, or the env overrides a model slot)');
  const installed = config.installedProfiles?.claude ?? {};
  const want = new Map(armResult.profiles.map((p) => [p.profileId, p.fingerprint]));
  for (const [id, fingerprint] of want) {
    if (!Object.hasOwn(installed, id)) problems.push(`profile ${id} is not installed`);
    else if (installed[id].fingerprint !== fingerprint) problems.push(`profile ${id} is installed with a stale fingerprint`);
  }
  for (const id of Object.keys(installed)) if (!want.has(id)) problems.push(`profile ${id} is installed but is not in the arm registry`);
  // What the hook needs before it rewrites anything (hooks.mjs, optimizer.mjs): confirmed entries.
  const enabled = (config.registry?.models ?? []).filter((m) => m.runtime === 'claude' && m.enabled && m.availability !== 'unavailable');
  expect(enabled.length > 0, 'the installed registry has no enabled claude entry');
  if (config.optimization?.requireConfirmedAvailability !== false) {
    for (const m of enabled) if (m.availability !== 'confirmed') problems.push(`registry entry ${m.id} (backend ${m.backend}) is ${m.availability}, not confirmed: its profiles are never chosen`);
  }
  return problems;
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const args = { declare: [], confirm: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'verify') { args.verify = true; continue; }
    if (key === 'allow-undeclared') { args.allowUndeclared = true; continue; }
    if (key === 'allow-other-base') { args.allowOtherBase = true; continue; }
    const value = argv[i + 1];
    if (!argv[i].startsWith('--') || value === undefined) throw fail(`option ${argv[i]} needs a value`);
    i += 1;
    if (key === 'declare') args.declare.push(value);
    else if (key === 'confirm-availability') args.confirm.push(value);
    else if (['arm', 'work', 'config', 'env'].includes(key) && !(key in args)) args[key] = value;
    else throw fail(`unknown or repeated option --${key}`);
  }
  return args;
}

export function main(argv) {
  const args = parseArgs(argv);
  if (!ARMS.includes(args.arm)) throw fail('--arm must be R or L (arm N installs nothing)');
  const work = checkedWork(args.work);
  const configFile = inside(work, args.config, '--config');
  regularFile(configFile, '--config');
  const declarations = { ...DECLARED_IDS };
  const typed = [];
  for (const text of args.declare) {
    const match = /^([A-Za-z0-9_./:[\]-]{1,160})=([A-Za-z0-9][A-Za-z0-9._:@-]{0,79})$/.exec(text);
    if (!match) throw fail('--declare takes <backend>=<model id>');
    declarations[match[1]] = match[2];
    typed.push({ backend: match[1], id: match[2] });
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { throw fail('--config is not JSON', 1); }
  const outDir = path.join(work, `routing-exp-arm-${args.arm}`);
  const registryFile = path.join(outDir, 'registry.json');

  if (args.verify) {
    let stored;
    try { stored = JSON.parse(fs.readFileSync(registryFile, 'utf8')); } catch { throw fail(`${registryFile} is missing: run make-arm-config.mjs without --verify first`, 1); }
    const profiles = profileCatalog(validateRegistry(stored), 'claude').map((p) => ({ profileId: p.profileId, fingerprint: p.fingerprint }));
    const problems = verifyInstalled(config, { registry: stored, profiles });
    const files = Object.values(config.installedProfiles?.claude ?? {}).map((record) => path.basename(record.path)).sort();
    const envNames = overridingEnvNames();
    const egress = config.safety?.allowEgress === true;
    if (!egress) problems.push('JEV_ALLOW_EGRESS is not true in this install: no judge is called and nothing is routed');
    if (envNames.length) problems.push(`this process has environment variables the hook reads before the arm's .env: ${envNames.join(', ')} (names only). Unset them in the environment the desktop app starts from`);
    console.log(JSON.stringify({ arm: args.arm, ok: problems.length === 0, problems, stateDir: config.stateDir, allowedProjects: config.allowedProjects,
      egressAllowed: egress, requireConfirmedAvailability: config.optimization?.requireConfirmedAvailability ?? null,
      enabledClaudeEntries: (config.registry?.models ?? []).filter((m) => m.runtime === 'claude' && m.enabled).map((m) => ({ registryEntry: m.id, slot: m.slot, backend: m.backend, availability: m.availability, resolvesTo: m.resolvesTo ?? null })),
      overridingEnvironmentNames: envNames, keyFromEnvironment: keyFromEnvironment(), judges: Object.fromEntries(Object.entries(config.kernel?.points ?? {}).map(([id, point]) => [id, { mode: point.mode, judges: point.judges }])),
      profileFiles: files }, null, 2));
    return problems.length === 0 ? 0 : 1;
  }

  // Every path is checked before anything else, and nothing is written until every check below has passed.
  let envFile = null;
  if (args.env !== undefined) {
    envFile = inside(work, args.env, '--env');
    if (regularFile(envFile, '--env').size > 32768) throw fail('--env is larger than an env file can be');
  }
  for (const backend of args.confirm) if (!/^[A-Za-z0-9_./:[\]-]{1,160}$/.test(backend)) throw fail('--confirm-availability takes a backend name');
  const committedBase = isCommittedBase(config.registry);
  if (!committedBase && !args.allowOtherBase) {
    throw fail('the installed registry is not the pre-registered base-registry.json: install with --registry <routing-exp>/base-registry.json first (step 1), or pass --allow-other-base and record the deviation in PROTOCOL.md section 8', 1);
  }
  const result = armRegistry(config.registry, args.arm, declarations, { confirm: [...new Set(args.confirm)] });
  if (result.unconfirmed.length) {
    throw fail(`not written: ${result.unconfirmed.map((e) => `${e.registryEntry} (backend ${e.backend}, ${e.availability})`).join(', ')} ${result.unconfirmed.length === 1 ? 'is' : 'are'} enabled but not confirmed. `
      + 'The hook never rewrites a delegation to a profile of an unconfirmed entry, so the arm would not be the arm of the protocol. '
      + `If this account can run ${[...new Set(result.unconfirmed.map((e) => e.backend))].join(' and ')} at the registry's efforts, say so with ${[...new Set(result.unconfirmed.map((e) => `--confirm-availability ${e.backend}`))].join(' ')}.`, 1);
  }
  if (result.undeclaredEnabled.length && !args.allowUndeclared) {
    throw fail(`not written: ${result.undeclaredEnabled.map((e) => `${e.registryEntry} (backend ${e.backend})`).join(', ')} ${result.undeclaredEnabled.length === 1 ? 'has' : 'have'} no declared model id. `
      + 'Runs of such an entry become evaluation rows only if the host records exactly the backend string. Declare the id with --declare <backend>=<model id>, or pass --allow-undeclared.', 1);
  }
  const before = new Map(Object.entries(config.installedProfiles?.claude ?? {}).map(([id, record]) => [id, record.fingerprint]));
  const changed = result.profiles.filter((p) => before.has(p.profileId) && before.get(p.profileId) !== p.fingerprint).map((p) => p.profileId);
  const added = result.profiles.filter((p) => !before.has(p.profileId)).map((p) => p.profileId);
  const removed = [...before.keys()].filter((id) => !result.profiles.some((p) => p.profileId === id));
  const reinstallRequired = changed.length > 0 || added.length > 0 || removed.length > 0 || JSON.stringify(config.registry) !== JSON.stringify(result.registry);

  writePrivate(registryFile, JSON.stringify(result.registry, null, 2) + '\n');
  writePrivate(path.join(outDir, 'env-lines.txt'), Object.entries(ENV_LINES).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  let env = { edited: false };
  if (envFile !== null) {
    const edit = applyEnvLines(fs.readFileSync(envFile, 'utf8'));
    writePrivate(envFile, edit.text);
    env = { edited: true, file: envFile, replaced: edit.replaced, appended: edit.appended, duplicatesDropped: edit.duplicatesDropped };
  }
  const summary = {
    arm: args.arm, evaluationContext: EVALUATION_CONTEXT, envLines: ENV_LINES, env,
    registryFile, registryRevision: result.registry.revision,
    baseRegistry: { isCommittedBase: committedBase, allowOtherBase: args.allowOtherBase === true, revision: config.registry?.revision ?? null },
    availability: { confirmedOnCommandLine: [...new Set(args.confirm)], entries: result.confirmed,
      statement: 'typed by whoever ran this tool: this account can run these backends at the efforts of the registry' },
    declared: result.declared, typedDeclarations: typed, notDeclared: result.notDeclared, allowUndeclared: args.allowUndeclared === true, removedPlaceholders: result.removedPlaceholders,
    lowestEnabledClaude: result.lowest, disabled: result.disabled,
    enabledClaudeEntries: result.registry.models.filter((m) => m.runtime === 'claude' && m.enabled).map((m) => ({ registryEntry: m.id, slot: m.slot, model: m.model, backend: m.backend, availability: m.availability, roles: m.roles, resolvesTo: m.resolvesTo ?? null })),
    reinstallRequired, profilesWithChangedFingerprint: changed, profilesToAdd: added, profilesToRemove: removed,
    profileFiles: result.profiles.map((p) => p.file).sort(),
    next: [
      `node orchestration/scripts/install.mjs --home <the disposable home of this arm> --project <this arm's project copy> --runtime claude --registry ${registryFile} --yes`,
      `node qa/kernel/routing-exp/make-arm-config.mjs --verify --arm ${args.arm} --work ${work} --config ${configFile}`,
    ],
  };
  writePrivate(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  for (const entry of result.undeclaredEnabled) {
    console.error(`note (--allow-undeclared): ${entry.registryEntry} (backend ${entry.backend}) has no declared id. Its runs become evaluation rows only if the host records exactly "${entry.backend}".`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) {
    console.error(error.exitCode ? error.message : (error.code ?? error.message));
    process.exitCode = error.exitCode ?? 1;
  }
}
