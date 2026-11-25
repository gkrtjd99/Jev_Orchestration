#!/usr/bin/env node
// End-to-end QA of the decision kernel through the REAL installed hook entrypoint.
//
// What it does (nothing is mocked unless a scenario is marked live:false):
//   1. builds a disposable HOME, a synthetic project with synthetic skills, a private env file (0600,
//      outside the project) and a registry copy marked confirmed;
//   2. runs the real installer (orchestration/scripts/install.mjs) with HOME pointed at the disposable HOME;
//   3. pipes Claude-Code-shaped hook event JSON into the exact command the installer registered in
//      <HOME>/.claude/settings.json (the installed bin/jev-hook.mjs), with live Jev / OpenAI judges;
//   4. checks hook output, session state, decision log, wall-clock time and the inspection CLIs.
//
// Keys are read from the environment, written only to the private env file, never printed and never
// written to the results file (the results are scanned for both key values before they are saved).
// Only the synthetic texts defined in this file are sent to any API.
//
// Usage (from the worktree root):
//   node qa/kernel/e2e-hooks.mjs --out qa/kernel/results/<run>/hooks.json [--root <empty dir>] [--keep]
//                                [--only <scenario-prefix,...>] [--alias-models] [--setup-only]
// Exit code: 0 all expectations passed, 1 at least one failed, 2 keys missing, 64 bad usage.
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { hash, VERSION } from '../../orchestration/src/util.mjs';
import { isDecisionRecord } from '../../orchestration/src/kernel/log.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ORCH = path.join(REPO, 'orchestration');
const WATCHDOG_MS = 7000;      // bin/jev-hook.mjs
const HOST_HOOK_TIMEOUT_MS = 8000; // timeout the installer registers for every hook

// ------------------------------------------------------------------ arguments
const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { console.error('bad argument ' + argv[i]); process.exit(64); }
    const k = argv[i].slice(2);
    args[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  for (const k of Object.keys(args)) {
    if (!['out', 'root', 'keep', 'only', 'alias-models', 'setup-only'].includes(k)) { console.error('unknown option --' + k); process.exit(64); }
  }
}
const TS_KEY = process.env.TYPESAFE_API_KEY || '';
const OA_KEY = process.env.OPENAI_API_KEY || '';
if (!TS_KEY || !OA_KEY) { console.error('QA_MISSING_KEYS: TYPESAFE_API_KEY and OPENAI_API_KEY must be set (values are never printed)'); process.exit(2); }
const runId = Date.now().toString(36);
const only = typeof args.only === 'string' ? args.only.split(',') : null;
const wanted = id => !only || only.some(p => id.startsWith(p));

// ------------------------------------------------------------------ synthetic material
// Canary words: each appears in exactly one kind of text, so a leak into stored state is attributable.
const CANARY = { task: 'Larkspur', report: 'Quillfeather', description: 'Hollowbrook', body: 'Marrowgate' };
const SKILLS = {
  'changelog-hollowbrook': {
    description: 'Hollowbrook changelog convention: the required line format for every CHANGELOG.md entry in this repository (ticket marker prefix, imperative summary, trailing owner tag). Load before adding or editing changelog or release-note entries.',
    body: `# Hollowbrook changelog convention (${CANARY.body})

Every entry line added to CHANGELOG.md MUST have exactly this shape:

\`- [HB-<4 digits>] <Imperative summary without a trailing period> (owner: @<team>) ~hbk\`

Rules:
1. The marker is \`[HB-NNNN]\`; use the next free number after the highest one already in the file.
2. The summary starts with an imperative verb (Add, Fix, Remove, Change).
3. The line ends with the literal suffix \`~hbk\`.
4. In your final report, quote the exact line you added and end the report with the line \`convention: hollowbrook-v2\`.
`,
  },
  'sql-migration-safety': {
    description: 'Procedure for writing reversible PostgreSQL schema migrations: expand/contract steps, lock timeouts and batched backfills. Load before creating or editing files under migrations/.',
    body: '# SQL migration safety\n\nSet `lock_timeout`, add columns as nullable first, backfill in batches, always ship a down migration.\n',
  },
  'pdf-table-extract': {
    description: 'Extract tables from PDF reports into CSV with pdfplumber, including multi-page tables and header repair. Load before parsing PDF files.',
    body: '# PDF table extraction\n\nUse pdfplumber, merge multi-page tables by header signature.\n',
  },
  'k6-load-test': {
    description: 'Write and run k6 load test scripts with thresholds and ramping stages. Load before performance or load testing of HTTP endpoints.',
    body: '# k6 load tests\n\nDefine stages, thresholds on p95, run with `k6 run`.\n',
  },
};
const TASK = {
  changelog: `Add a new entry to CHANGELOG.md under the existing "## 1.4.0" heading that describes the new --retry-max flag implemented in src/retry.js. Follow this repository's changelog entry format exactly. Acceptance: exactly one new entry line under "## 1.4.0" in CHANGELOG.md and no other file is changed. Ticket ${CANARY.task}-7731.`,
  rename: `In src/retry.js rename the local variable n to attempt inside the function nextDelay and keep the behaviour identical. Acceptance: "node --check src/retry.js" passes and no other file is changed. Ticket ${CANARY.task}-7732.`,
  migration: `Create migrations/0007_orders_status.sql for PostgreSQL that adds a nullable text column "status" to the existing orders table defined in migrations/0006_init.sql, and include the matching down migration in the same file. Acceptance: the file contains an up and a down section and no other file is changed. Ticket ${CANARY.task}-7733.`,
  loadtest: `Write loadtest/checkout.js, a k6 load test script for the HTTP endpoint POST /checkout with a ramp to 50 virtual users and a threshold of p95 below 400 ms. Acceptance: the script defines stages and thresholds; no other file is changed. Ticket ${CANARY.task}-7734.`,
};
const REPORT = {
  complete: `Done. I added exactly one entry under "## 1.4.0" in CHANGELOG.md: "- [HB-0142] Add --retry-max flag to cap retry attempts (owner: @platform) ~hbk". Changed files: CHANGELOG.md only. Checks I ran: "git diff --stat" reported 1 file changed, 1 insertion; "grep -c HB-0142 CHANGELOG.md" printed 1; "node --check src/retry.js" exited 0. No unresolved issues. Ref ${CANARY.report}-5512.`,
  blocked: `I could not complete the rename. The ticket says the local variable in nextDelay must be renamed to "attempt", but a second instruction in the same ticket says every local name in src/retry.js must stay frozen for the 1.4.0 release. These two requirements conflict, and I have no way to tell which one is current. I changed no files and ran no checks. The parent has to decide which requirement wins before this can proceed. Ref ${CANARY.report}-5513.`,
};
const PROJECT_FILES = {
  'README.md': '# retry-kit (synthetic QA project)\n\nSmall retry helper used only for hook QA.\n',
  'CHANGELOG.md': '# Changelog\n\n## 1.4.0\n\n## 1.3.0\n- [HB-0141] Fix jitter overflow on large delays (owner: @platform) ~hbk\n- [HB-0140] Add exponential backoff helper (owner: @platform) ~hbk\n',
  'src/retry.js': "export function nextDelay(base, tries, retryMax = 5) {\n  const n = Math.min(tries, retryMax);\n  return base * 2 ** n;\n}\n",
  'migrations/0006_init.sql': '-- up\nCREATE TABLE orders (id bigint PRIMARY KEY, total_cents bigint NOT NULL);\n-- down\nDROP TABLE orders;\n',
};

// ------------------------------------------------------------------ small helpers
const results = { expectations: [], invocations: [], scenarios: {} };
let current = 'setup';
// Hard expectations are product contracts and decide the exit code. Soft ones (soft:true) depend on what a live
// judge chose for a secondary synthetic task; a miss is printed as WARN, counted separately and does not fail the run.
function expect(name, ok, detail = '', { soft = false } = {}) {
  results.expectations.push({ scenario: current, name, pass: !!ok, soft, detail: String(detail).slice(0, 400) });
  return !!ok;
}
const note = (key, value) => { (results.scenarios[current] ??= {})[key] = value; };
const exists = async p => { try { await fs.lstat(p); return true; } catch { return false; } };
const mode = async p => ((await fs.lstat(p)).mode & 0o777).toString(8).padStart(3, '0');
const readJSON = async p => JSON.parse(await fs.readFile(p, 'utf8'));
async function walk(dir, out = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out); else out.push(p);
  }
  return out;
}
function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
const stats = list => {
  const s = [...list].sort((a, b) => a - b);
  const r = x => (x === null ? null : Math.round(x));
  return { n: s.length, p50: r(percentile(s, 0.5)), p95: r(percentile(s, 0.95)), max: r(s.length ? s[s.length - 1] : null) };
};

function runProcess(file, argv, { env, input = null, cwd, timeoutMs = 60000 }) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const child = spawn(file, argv, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, killed, ms: performance.now() - t0, stdout, stderr }); });
    child.stdin.end(input ?? '');
  });
}

// ------------------------------------------------------------------ setup
const realTmp = await fs.realpath(os.tmpdir());
let root;
if (typeof args.root === 'string') {
  root = path.resolve(args.root);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await fs.readdir(root)).length) { console.error('QA_ROOT_NOT_EMPTY: ' + root); process.exit(64); }
  root = await fs.realpath(root);
} else root = await fs.mkdtemp(path.join(realTmp, 'jev-e2e-'));
const home = path.join(root, 'home');
const project = path.join(root, 'project');
const envFile = path.join(root, 'private-setup.env');
const registryFile = path.join(root, 'models.confirmed.json');
const realHome = os.homedir();
const realJevDir = path.join(realHome, '.config', 'jev-hooks');
const realBefore = {
  jevHooksDirExists: await exists(realJevDir),
  claudeSettingsMtime: await fs.stat(path.join(realHome, '.claude', 'settings.json')).then(s => s.mtimeMs, () => null),
};

await fs.mkdir(home, { mode: 0o700 });
await fs.mkdir(project, { mode: 0o700 });
for (const [rel, text] of Object.entries(PROJECT_FILES)) {
  await fs.mkdir(path.dirname(path.join(project, rel)), { recursive: true });
  await fs.writeFile(path.join(project, rel), text);
}
for (const [name, s] of Object.entries(SKILLS)) {
  const dir = path.join(project, '.claude', 'skills', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${s.description}\n---\n\n${s.body}`);
}
// Private env file outside the project. Written from process.env; never read back to stdout.
await fs.writeFile(envFile, [
  `TYPESAFE_API_KEY=${TS_KEY}`, `OPENAI_API_KEY=${OA_KEY}`, 'JEV_MODEL=jev-latest', 'JEV_MODE=shadow', 'JEV_ALLOW_EGRESS=true', '',
].join('\n'), { mode: 0o600, flag: 'wx' });
// Registry copy: every entry declared confirmed FOR THIS SYNTHETIC QA ONLY (not an account check).
{
  const registry = await readJSON(path.join(ORCH, 'config', 'registry.example.json'));
  const alias = { 'claude-light': 'sonnet', 'claude-standard': 'opus', 'claude-strategic': 'opus' };
  for (const m of registry.models) {
    m.availability = 'confirmed';
    m.capabilitySource = 'qa-e2e-synthetic-declaration-not-an-account-check';
    if (args['alias-models'] && alias[m.id]) { m.model = alias[m.id]; m.backend = alias[m.id]; }
  }
  registry.revision = 'qa-e2e-confirmed-copy';
  await fs.writeFile(registryFile, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
}

// Child processes get a minimal environment: no key and no JEV_* from the caller's shell, so the hook
// has to find its keys and switches in the INSTALLED private .env. Scenario switches are added per call.
const baseEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: realTmp, LANG: 'C.UTF-8' };

current = 'install';
const installArgs = [path.join(ORCH, 'scripts', 'install.mjs'), '--home', home, '--project', project, '--runtime', 'claude',
  '--registry', registryFile, '--env-file', envFile, '--mode', 'shadow'];
const planRun = await runProcess(process.execPath, installArgs, { env: baseEnv, cwd: REPO });
const planned = (() => { try { return JSON.parse(planRun.stdout.slice(0, planRun.stdout.lastIndexOf('}') + 1)); } catch { return null; } })();
expect('installer plan run exits 0 and applies nothing', planRun.code === 0 && planned?.applied === false && !(await exists(path.join(home, '.config'))), planRun.stderr);
const applyRun = await runProcess(process.execPath, [...installArgs, '--yes'], { env: baseEnv, cwd: REPO });
const applied = (() => { try { return JSON.parse(applyRun.stdout.slice(0, applyRun.stdout.lastIndexOf('}') + 1)); } catch { return null; } })();
expect('installer --yes exits 0 and reports applied', applyRun.code === 0 && applied?.applied === true, applyRun.stderr || applyRun.stdout.slice(0, 200));
if (!applied?.applied) { await finish(); }
expect('every installed file is inside the disposable HOME', applied.files.every(f => f.startsWith(home + path.sep)), `${applied.files.length} files`);
const confFile = path.join(home, '.config', 'jev-hooks', 'config.json');
const settingsFile = path.join(home, '.claude', 'settings.json');
const settings = await readJSON(settingsFile);
const installedConfig = await readJSON(confFile);
const stateDir = installedConfig.stateDir;
const entry = path.join(home, '.local', 'share', 'jev-hooks', VERSION, 'bin', 'jev-hook.mjs');
expect('installed entrypoint and kernel modules exist', await exists(entry)
  && await exists(path.join(path.dirname(path.dirname(entry)), 'src', 'kernel', 'kernel.mjs')));
expect('installed .env is mode 600', (await mode(path.join(home, '.config', 'jev-hooks', '.env'))) === '600');
expect('state directory is inside the disposable HOME', stateDir.startsWith(home + path.sep), stateDir);
{
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionEnd'];
  const ok = events.every(ev => settings.hooks?.[ev]?.length === 1 && settings.hooks[ev][0].hooks.length === 1
    && settings.hooks[ev][0].hooks[0].timeout === 8 && settings.hooks[ev][0].hooks[0].command.includes(entry));
  expect('settings.json registers the installed entrypoint for 9 events with timeout 8', ok, Object.keys(settings.hooks || {}).join(','));
  expect('installed defaults: skills and supervisor points off, OpenAI not approved',
    installedConfig.kernel.points['delegation.skills'].mode === 'off' && installedConfig.kernel.points['supervisor.outcome'].mode === 'off'
    && installedConfig.kernel.providers.openai.approved === false && installedConfig.mode === 'shadow');
  const profiles = Object.keys(installedConfig.installedProfiles?.claude || {});
  expect('claude profile definitions were installed', profiles.length > 0 && (await fs.readdir(path.join(home, '.claude', 'agents'))).length === profiles.length, `${profiles.length} profiles`);
}
results.setup = { root, home, project, envFile, registryFile, confFile, settingsFile, entry, stateDir, aliasModels: !!args['alias-models'] };
if (args['setup-only']) {
  console.log(JSON.stringify(results.setup, null, 2));
  await finish(true);
}

// ------------------------------------------------------------------ hook invocation
function commandFor(event, toolName, configOverride = null) {
  for (const group of settings.hooks[event] || []) {
    if (group.matcher && !(toolName && new RegExp(group.matcher).test(toolName))) continue;
    let command = group.hooks[0].command;
    if (configOverride) {
      if (!command.includes(`'${confFile}'`)) throw new Error('unexpected installed command quoting');
      command = command.replace(`'${confFile}'`, `'${configOverride}'`);
    }
    return command;
  }
  return null;
}
function shape(stdout) {
  let o;
  try { o = JSON.parse(stdout); } catch { return { kind: 'invalid' }; }
  const h = o.hookSpecificOutput;
  if (!h) return { kind: Object.keys(o).length ? 'other' : 'empty' };
  const context = typeof h.additionalContext === 'string' ? h.additionalContext : '';
  const block = text => {
    const m = /<jev-skills>\n(.*)\n<\/jev-skills>/.exec(text || '');
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return { unparsable: true }; }
  };
  if (h.permissionDecision === 'deny') return { kind: 'deny', reason: h.permissionDecisionReason };
  if (h.updatedInput) {
    return { kind: 'rewrite', permissionDecision: h.permissionDecision ?? null, subagentType: h.updatedInput.subagent_type,
      prompt: h.updatedInput.prompt, model: h.updatedInput.model ?? null, context, skills: block(h.updatedInput.prompt) };
  }
  const warn = /^Jev hooks: ([A-Z0-9_]+)\./.exec(context);
  if (warn) return { kind: 'warning', code: warn[1], context };
  if (context.startsWith('Jev advisory:')) return { kind: 'advice', context, skills: block(context) };
  if (context.startsWith('Jev supervisor (advisory):')) return { kind: 'supervisor', context };
  if (context.startsWith('Jev did not select')) return { kind: 'deferred', context };
  return { kind: context ? 'context' : 'empty', context };
}
let sequence = 0;
const sid = name => `qa-e2e-${runId}-${name}`;
async function hook(event, { session, env = {}, tool = null, input = undefined, id = null, extra = {}, config = null, step = '', live = true, raw = null }) {
  const command = commandFor(event, tool, config);
  if (!command) throw new Error(`no installed hook command matches ${event}/${tool}`);
  const payload = raw ?? JSON.stringify({ session_id: session, transcript_path: path.join(home, '.claude', 'projects', 'synthetic', session + '.jsonl'),
    cwd: project, permission_mode: 'default', hook_event_name: event, ...(tool ? { tool_name: tool } : {}),
    ...(input !== undefined ? { tool_input: input } : {}), ...(id ? { tool_use_id: id } : {}), ...extra });
  const r = await runProcess('/bin/sh', ['-c', command], { env: { ...baseEnv, ...env }, input: payload, cwd: project, timeoutMs: HOST_HOOK_TIMEOUT_MS });
  const out = shape(r.stdout);
  const rec = { n: ++sequence, scenario: current, step, event, tool, live, exit: r.code, signal: r.signal, killedAtHostTimeout: r.killed,
    ms: Math.round(r.ms), kind: out.kind, code: out.code ?? null, subagentType: out.subagentType ?? null,
    skillsBlock: out.skills ?? null, stderr: r.stderr.trim().slice(0, 200) };
  results.invocations.push(rec);
  return { ...r, out, rec };
}
const agentInput = (prompt, more = {}) => ({ description: 'synthetic QA delegation', prompt, subagent_type: 'general-purpose', ...more });
const pre = (session, id, prompt, opts = {}) => hook('PreToolUse', { session, tool: 'Agent', input: agentInput(prompt, opts.more), id, ...opts });
const post = (session, id, prompt, text, opts = {}) => hook('PostToolUse', { session, tool: 'Agent', input: agentInput(prompt), id,
  extra: { tool_response: { status: 'completed', prompt, agentId: 'qa' + id.slice(-6), content: [{ type: 'text', text }], totalDurationMs: 41234, totalTokens: 9876, totalToolUseCount: 7 } }, ...opts });
async function open(session, env, opts = {}) {
  await hook('SessionStart', { session, env, extra: { source: 'startup' }, step: 'session-start', ...opts });
  await hook('UserPromptSubmit', { session, env, extra: { prompt: 'Synthetic QA parent goal: prepare the 1.4.0 release of retry-kit.' }, step: 'user-prompt', ...opts });
}

const sessionDir = session => path.join(stateDir, 'sessions', hash({ project, runtime: 'claude', session }));
async function sessionEvents(session) {
  const dir = path.join(sessionDir(session), 'events');
  const out = [];
  let names = [];
  try { names = await fs.readdir(dir); } catch { return out; }
  for (const n of names.filter(x => x.endsWith('.json'))) out.push(await readJSON(path.join(dir, n)));
  return out.sort((a, b) => a.time - b.time);
}
const logDir = () => path.join(stateDir, 'decisions-log');
async function allDecisions() {
  const out = [];
  let names = [];
  try { names = await fs.readdir(logDir()); } catch { return out; }
  for (const n of names.filter(x => x.startsWith('decisions-'))) {
    for (const line of (await fs.readFile(path.join(logDir(), n), 'utf8')).split('\n')) if (line.trim()) out.push(JSON.parse(line));
  }
  return out;
}
const scopeOf = session => hash({ project, session, runtime: 'claude' });
const decisionsFor = async session => (await allDecisions()).filter(d => d.scope === scopeOf(session));
const trailText = d => d.trail.map(t => `${t.provider}:${t.ok ? 'ok' : t.code}${t.code === 'KERNEL_LOW_CONFIDENCE' ? '(low)' : ''}@${Math.round(t.latencyMs)}ms`).join(' > ');
const summarize = ds => ds.map(d => ({ point: d.pointId, mode: d.mode, provider: d.provider, model: d.model, cached: d.cached, latencyMs: Math.round(d.latencyMs), trail: trailText(d) }));

/** Common checks for a delegation that must be rewritten to an installed profile. */
function expectRewrite(r, original, label, { skills, soft = false }) {
  const o = r.out;
  // A live judge may legitimately defer (for example selector "defer"): never a deny, and the native call is unchanged.
  expect(`${label}: exit 0, valid output, never a deny`, r.code === 0 && !['deny', 'invalid'].includes(o.kind), `exit=${r.code} kind=${o.kind}`);
  expect(`${label}: prompt rewritten to an installed jev4_ profile without a permission decision`,
    r.code === 0 && o.kind === 'rewrite' && /^jev4_[a-z]+_[a-z]+_[a-z]+_[0-9a-f]{10}$/.test(o.subagentType || '')
    && Object.hasOwn(installedConfig.installedProfiles.claude, o.subagentType) && o.permissionDecision === null,
    `kind=${o.kind} code=${o.code ?? ''} profile=${o.subagentType ?? ''} ${o.context?.slice(0, 160) ?? ''}`, { soft });
  if (o.kind !== 'rewrite') return false;
  expect(`${label}: original task text preserved as the prefix, followed by the <jev-routing> packet`,
    o.prompt.startsWith(original + '\n\n<jev-routing>\n') && o.prompt.includes('</jev-routing>'));
  if (skills === false) expect(`${label}: no <jev-skills> block in the rewritten prompt`, !o.prompt.includes('<jev-skills>'));
  return true;
}
function expectBlock(block, label, expected, { soft = false } = {}) {
  const check = (n, ok, d) => expect(n, ok, d, { soft });
  const load = (block?.load || []).map(x => x.name), consider = (block?.consider || []).map(x => x.name);
  note(label + '.block', block);
  check(`${label}: <jev-skills> block present and parsable`, !!block && !block.unparsable, JSON.stringify(block));
  if (!block || block.unparsable) return;
  check(`${label}: expected skill "${expected}" selected (load or consider)`, [...load, ...consider].includes(expected), JSON.stringify(block));
  check(`${label}: expected skill "${expected}" is in "load"`, load.includes(expected), JSON.stringify(block));
  check(`${label}: no unrelated skill auto-loaded`, load.every(n => n === expected), JSON.stringify(load));
  const item = [...(block.load || []), ...(block.consider || [])].find(x => x.name === expected);
  check(`${label}: injected path is the logical .claude/skills/<folder>/SKILL.md`, item?.path === `.claude/skills/${expected}/SKILL.md`, item?.path);
  check(`${label}: block carries only name/path/p (no description text)`,
    [...(block.load || []), ...(block.consider || [])].every(x => Object.keys(x).every(k => ['name', 'path', 'p'].includes(k)))
    && !JSON.stringify(block).includes('trailing owner tag'));
}

const ACTIVE = { JEV_MODE: 'active' };
const scenario = async (id, fn) => {
  if (!wanted(id)) return;
  current = id;
  results.scenarios[id] ??= {};
  try { await fn(); } catch (e) { expect('scenario ran without a driver error', false, e.stack || e.message); }
};

// ------------------------------------------------------------------ scenarios (live judges)
await scenario('s01-lifecycle', async () => {
  const s = sid('s01');
  const a = await hook('SessionStart', { session: s, env: ACTIVE, extra: { source: 'startup' }, step: 'session-start' });
  expect('SessionStart exits 0 with visible context in active mode', a.code === 0 && a.out.kind === 'context');
  const b = await hook('UserPromptSubmit', { session: s, env: ACTIVE, extra: { prompt: 'Synthetic QA parent goal.' }, step: 'user-prompt' });
  expect('UserPromptSubmit exits 0 with visible context', b.code === 0 && b.out.kind === 'context');
  for (const [event, extra] of [['SubagentStart', { agent_id: 'qa-agent-1', agent_type: 'general-purpose' }], ['SubagentStop', { agent_id: 'qa-agent-1', agent_type: 'general-purpose' }],
    ['PreCompact', { trigger: 'auto' }], ['SessionEnd', { reason: 'other' }]]) {
    const r = await hook(event, { session: s, env: ACTIVE, extra, step: event });
    expect(`${event} exits 0 with valid JSON`, r.code === 0 && r.out.kind !== 'invalid', r.stderr);
  }
  const w = await hook('PreToolUse', { session: s, env: ACTIVE, tool: 'Workflow', input: { script: 'agent("x")' }, id: 'toolu_qa_s01_wf', step: 'workflow-boundary' });
  expect('Workflow PreToolUse is observed, not denied (default policy warn)', w.code === 0 && w.out.kind === 'context', w.out.kind);
  expect('no decision was logged for lifecycle events', (await decisionsFor(s)).length === 0);
});

await scenario('s02-default-active', async () => {
  const s = sid('s02');
  await open(s, ACTIVE);
  const r = await pre(s, 'toolu_qa_s02_a', TASK.changelog, { env: ACTIVE, step: 'pre' });
  const ok = expectRewrite(r, TASK.changelog, 'default config', { skills: false });
  const ds = await decisionsFor(s);
  note('decisions', summarize(ds));
  expect('decision log has delegation.classify for this session and no skills/supervisor record',
    ds.some(d => d.pointId === 'delegation.classify') && !ds.some(d => ['delegation.skills', 'supervisor.outcome'].includes(d.pointId)));
  expect('all decisions answered by jev (default chain)', ds.every(d => d.provider === 'jev'));
  const ev = await sessionEvents(s);
  expect('session state has a route event and no skills event', ev.some(e => e.type === 'route') && !ev.some(e => e.type === 'skills'));
  if (ok) {
    const again = await pre(s, 'toolu_qa_s02_a', TASK.changelog, { env: ACTIVE, step: 'replay' });
    expect('replay of the same tool_use_id gives byte-identical output', again.stdout === r.stdout && again.code === 0);
    expect('replay made no new judge call', (await decisionsFor(s)).length === ds.length);
  }
});

await scenario('s03-default-shadow', async () => {
  const s = sid('s03');
  await open(s, {});
  const r = await pre(s, 'toolu_qa_s03_a', TASK.changelog, { step: 'pre' });
  expect('installed default (shadow): exit 0 and empty output, native call untouched', r.code === 0 && r.stdout.trim() === '{}', r.stdout.slice(0, 120));
  const ev = await sessionEvents(s);
  expect('shadow still judged and recorded a route', ev.some(e => e.type === 'route') && (await decisionsFor(s)).some(d => d.pointId === 'delegation.classify'));
});

await scenario('s04-skills-shadow', async () => {
  const s = sid('s04');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'shadow' };
  await open(s, env);
  const r = await pre(s, 'toolu_qa_s04_a', TASK.changelog, { env, step: 'pre' });
  expectRewrite(r, TASK.changelog, 'skills shadow', { skills: false });
  const ds = await decisionsFor(s);
  note('decisions', summarize(ds));
  const sk = ds.filter(d => d.pointId === 'delegation.skills');
  expect('skills decision logged once with mode shadow', sk.length === 1 && sk[0].mode === 'shadow', JSON.stringify(summarize(sk)));
  const ev = (await sessionEvents(s)).find(e => e.type === 'skills');
  note('skillsEvent', ev);
  expect('skills event recorded with mode shadow and injected=false', ev?.mode === 'shadow' && ev?.injected === false, JSON.stringify(ev)?.slice(0, 300));
  expect('shadow judge still rated the matching skill (recorded, not applied)', ev?.trace?.some(t => t.name === 'changelog-hollowbrook' && typeof t.probability === 'number'));
});

let labelTarget = null;
await scenario('s05-skills-active-match', async () => {
  const s = sid('s05');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active' };
  await open(s, env);
  const r = await pre(s, 'toolu_qa_s05_a', TASK.changelog, { env, step: 'pre' });
  if (!expectRewrite(r, TASK.changelog, 'skills active (matching task)', { skills: null })) return;
  expectBlock(r.out.skills, 'matching task', 'changelog-hollowbrook');
  expect('block is appended after the routing packet, separated by a blank line', /<\/jev-routing>\n[^\n]+\n\n<jev-skills>\n/.test(r.out.prompt));
  expect('the injected path opens the synthetic SKILL.md inside the project', await exists(path.join(project, '.claude', 'skills', 'changelog-hollowbrook', 'SKILL.md')));
  const ds = await decisionsFor(s);
  note('decisions', summarize(ds));
  const sk = ds.find(d => d.pointId === 'delegation.skills');
  labelTarget = sk?.decisionId ?? null;
  expect('skills decision logged with mode active; answers are need + skill_N numbers only',
    sk?.mode === 'active' && Object.keys(sk.answers).every(k => k === 'need' || /^skill_\d+$/.test(k)) && Object.values(sk.answers).every(a => a.type === 'noul'));
  const ev = (await sessionEvents(s)).find(e => e.type === 'skills');
  note('skillsEvent', ev);
  expect('skills event: mode active, injected=true, decisionId matches the log', ev?.mode === 'active' && ev?.injected === true && ev?.decisionId === sk?.decisionId);
  const again = await pre(s, 'toolu_qa_s05_a', TASK.changelog, { env, step: 'replay' });
  expect('replay of the same tool_use_id gives byte-identical output (block included)', again.code === 0 && again.stdout === r.stdout);
  expect('replay made no new judge call', (await decisionsFor(s)).length === ds.length);
  // Claude Code can re-run PreToolUse on the already rewritten input (e.g. after a permission prompt).
  const h = JSON.parse(r.stdout).hookSpecificOutput;
  const twice = await hook('PreToolUse', { session: s, env, tool: 'Agent', input: h.updatedInput, id: 'toolu_qa_s05_a', step: 'replay-on-rewritten-input' });
  expect('PreToolUse on the already rewritten input does not append a second block', twice.code === 0 && twice.out.kind === 'rewrite'
    && twice.out.prompt === r.out.prompt, `kind=${twice.out.kind} code=${twice.out.code ?? ''}`);
});

await scenario('s06-skills-active-unrelated', async () => {
  const s = sid('s06');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active' };
  await open(s, env);
  const r = await pre(s, 'toolu_qa_s06_a', TASK.rename, { env, step: 'pre' });
  expectRewrite(r, TASK.rename, 'skills active (unrelated task)', { skills: false });
  const ev = (await sessionEvents(s)).find(e => e.type === 'skills');
  note('skillsEvent', ev);
  expect('skills event recorded with injected=false and nothing loaded', ev?.injected === false && (ev?.load || []).length === 0, JSON.stringify(ev)?.slice(0, 300));
  note('decisions', summarize(await decisionsFor(s)));
});

await scenario('s07-skills-active-other-skills', async () => {
  const s = sid('s07');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active' };
  await open(s, env);
  const a = await pre(s, 'toolu_qa_s07_a', TASK.migration, { env, step: 'pre-migration' });
  if (expectRewrite(a, TASK.migration, 'migration task', { skills: null, soft: true })) expectBlock(a.out.skills, 'migration task', 'sql-migration-safety', { soft: true });
  const b = await pre(s, 'toolu_qa_s07_b', TASK.loadtest, { env, step: 'pre-loadtest' });
  if (expectRewrite(b, TASK.loadtest, 'load-test task', { skills: null, soft: true })) expectBlock(b.out.skills, 'load-test task', 'k6-load-test', { soft: true });
  note('outputKinds', [a.out.kind, b.out.kind]);
  note('decisions', summarize(await decisionsFor(s)));
});

await scenario('s08-advisory', async () => {
  const s = sid('s08');
  const env = { JEV_MODE: 'advisory', JEV_SKILLS_MODE: 'active' };
  await open(s, env);
  const r = await pre(s, 'toolu_qa_s08_a', TASK.changelog, { env, step: 'pre' });
  expect('advisory: exit 0, advice only, pending call unchanged (no updatedInput, no permission decision)',
    r.code === 0 && r.out.kind === 'advice' && !r.stdout.includes('updatedInput') && !r.stdout.includes('permissionDecision'), `kind=${r.out.kind} ${r.out.context?.slice(0, 120) ?? ''}`);
  if (r.out.kind === 'advice') {
    expect('advisory text says the pending call is UNCHANGED', r.out.context.includes('The pending tool call is UNCHANGED'));
    expectBlock(r.out.skills, 'advisory', 'changelog-hollowbrook');
  }
  const again = await pre(s, 'toolu_qa_s08_a', TASK.changelog, { env, step: 'replay' });
  expect('advisory replay is byte-identical', again.stdout === r.stdout);
});

await scenario('s09-custom-agent', async () => {
  const s = sid('s09');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active', JEV_SUPERVISOR_MODE: 'active' };
  await open(s, env);
  const r = await pre(s, 'toolu_qa_s09_a', TASK.changelog, { env, more: { subagent_type: 'qa-custom-reviewer' }, step: 'pre' });
  expect('custom agent: exit 0 and empty output (delegation preserved)', r.code === 0 && r.stdout.trim() === '{}', r.stdout.slice(0, 160));
  const p = await post(s, 'toolu_qa_s09_a', TASK.changelog, REPORT.complete, { env, step: 'post' });
  expect('custom agent PostToolUse: generic observation only, no supervisor advice', p.code === 0 && p.out.kind === 'context', p.out.kind);
  const ev = await sessionEvents(s);
  expect('session records custom_agent_preserved and no skills/supervisor/route event',
    ev.some(e => e.type === 'custom_agent_preserved') && !ev.some(e => ['skills', 'supervisor', 'route'].includes(e.type)));
  expect('no judge was called for a custom agent', (await decisionsFor(s)).length === 0);
});

await scenario('s10-explicit-model', async () => {
  const s = sid('s10');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active' };
  await open(s, env);
  const r = await pre(s, 'toolu_qa_s10_a', TASK.changelog, { env, more: { model: 'haiku' }, step: 'pre' });
  expect('explicit model: exit 0, warning EXPLICIT_NATIVE_SETTINGS_PRESERVED, no rewrite, no deny',
    r.code === 0 && r.out.kind === 'warning' && r.out.code === 'EXPLICIT_NATIVE_SETTINGS_PRESERVED' && !r.stdout.includes('updatedInput'), `kind=${r.out.kind} code=${r.out.code}`);
  expect('no judge was called for an explicit-model delegation', (await decisionsFor(s)).length === 0);
  const g = await pre(s, 'toolu_qa_s10_b', TASK.rename + ' password=hunter2hunter2', { env, step: 'pre-secret-like' });
  expect('secret-like task text: SECRET_GUARD warning, nothing sent', g.code === 0 && g.out.kind === 'warning' && g.out.code === 'SECRET_GUARD' && (await decisionsFor(s)).length === 0, g.out.code);
});

await scenario('s11-supervisor-active', async () => {
  const s = sid('s11');
  const env = { ...ACTIVE, JEV_SUPERVISOR_MODE: 'active' };
  await open(s, env);
  const a = await pre(s, 'toolu_qa_s11_a', TASK.changelog, { env, step: 'pre-a' });
  expectRewrite(a, TASK.changelog, 'supervisor scenario delegation A', { skills: false });
  const pa = await post(s, 'toolu_qa_s11_a', TASK.changelog, REPORT.complete, { env, step: 'post-complete-report' });
  const b = await pre(s, 'toolu_qa_s11_b', TASK.rename, { env, step: 'pre-b' });
  expectRewrite(b, TASK.rename, 'supervisor scenario delegation B', { skills: false });
  const pb = await post(s, 'toolu_qa_s11_b', TASK.rename, REPORT.blocked, { env, step: 'post-blocked-report' });
  const sup = (await sessionEvents(s)).filter(e => e.type === 'supervisor');
  note('supervisorEvents', sup);
  note('outputs', { complete: pa.out.context, blocked: pb.out.context });
  const ea = sup.find(e => e.taskId === 'toolu_qa_s11_a'), eb = sup.find(e => e.taskId === 'toolu_qa_s11_b');
  expect('complete report: judged as "complete"', pa.code === 0 && ea?.status === 'judged' && ea?.outcome === 'complete', JSON.stringify(ea));
  expect('complete report: advice is shown to Main and says it judges the report text only',
    pa.out.kind === 'supervisor' && pa.out.context.includes('judgment of the report text only') && pa.out.context.includes('no retry, respawn or permission change'), pa.out.kind);
  expect('blocked report: judged as not complete (retry/replan/escalate)', pb.code === 0 && eb?.status === 'judged' && ['retry', 'replan', 'escalate'].includes(eb?.outcome), JSON.stringify(eb));
  expect('blocked report: output never denies or rewrites anything', !pb.stdout.includes('permissionDecision') && !pb.stdout.includes('updatedInput'));
  const ds = (await decisionsFor(s)).filter(d => d.pointId === 'supervisor.outcome');
  note('decisions', summarize(ds));
  expect('two supervisor.outcome decisions logged (mode active, choice + score answers)', ds.length === 2
    && ds.every(d => d.mode === 'active' && d.answers.outcome?.type === 'choice' && d.answers.evidence?.type === 'score'));
  const u = await post(s, 'toolu_qa_s11_never_routed', TASK.rename, REPORT.complete, { env, step: 'post-unrouted-id' });
  expect('report for a tool id this extension never routed is not judged', u.out.kind === 'context'
    && (await decisionsFor(s)).filter(d => d.pointId === 'supervisor.outcome').length === 2);
});

await scenario('s12-chain-local-jev', async () => {
  const s = sid('s12');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active', JEV_SKILLS_JUDGES: 'local,jev' };
  await open(s, env);
  const r = await pre(s, 'toolu_qa_s12_a', TASK.changelog, { env, step: 'pre' });
  expectRewrite(r, TASK.changelog, 'chain local,jev (escalateBelow 0)', { skills: null });
  const ds = await decisionsFor(s);
  note('decisions', summarize(ds));
  note('block', r.out.skills ?? null);
  const sk = ds.find(d => d.pointId === 'delegation.skills');
  expect('skills decision answered by the local judge alone (escalateBelow defaults to 0)', sk?.provider === 'local' && sk.trail.length === 1 && sk.trail[0].ok === true, sk ? trailText(sk) : 'no record');
  expect('classification still answered by jev', ds.find(d => d.pointId === 'delegation.classify')?.provider === 'jev');
});

// A copy of the installed config with delegation.skills.escalateBelow = 0.6 (the documented example); only
// config can set it. The copy lives in the disposable HOME; keys come from the caller's environment.
const altDir = name => path.join(home, '.config', 'jev-hooks-qa-' + name);
async function altConfig(name, mutate) {
  const c = structuredClone(installedConfig);
  mutate(c);
  const dir = altDir(name);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  return file;
}
const LIVE_KEYS = { TYPESAFE_API_KEY: TS_KEY, OPENAI_API_KEY: OA_KEY, JEV_ALLOW_EGRESS: 'true' };

await scenario('s13-chain-local-jev-escalate', async () => {
  const s = sid('s13');
  const config = await altConfig('escalate', c => { c.kernel.points['delegation.skills'] = { mode: 'active', judges: ['local', 'jev'], escalateBelow: 0.6 }; });
  const env = { ...ACTIVE, ...LIVE_KEYS };
  await open(s, env, { config });
  const r = await pre(s, 'toolu_qa_s13_a', TASK.changelog, { env, config, step: 'pre' });
  if (expectRewrite(r, TASK.changelog, 'chain local,jev (escalateBelow 0.6)', { skills: null })) note('block', r.out.skills ?? null);
  const ds = await decisionsFor(s);
  note('decisions', summarize(ds));
  const sk = ds.find(d => d.pointId === 'delegation.skills');
  const first = sk?.trail[0];
  expect('skills trail starts with local; a low-confidence local answer escalates to jev, which is adopted',
    first?.provider === 'local' && (first.confidence >= 0.6 ? sk.provider === 'local' : (first.code === 'KERNEL_LOW_CONFIDENCE' && sk.trail[1]?.provider === 'jev' && sk.provider === 'jev')),
    sk ? trailText(sk) : 'no record');
  if (sk?.provider === 'jev' && r.out.kind === 'rewrite') expectBlock(r.out.skills, 'escalated chain', 'changelog-hollowbrook');
});

await scenario('s14-chain-jev-openai', async () => {
  const s = sid('s14');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active', JEV_SKILLS_JUDGES: 'jev,openai', JEV_DECISION_JUDGES: 'jev,openai', JEV_OPENAI_DECISIONS_APPROVED: 'true' };
  await open(s, env);
  const r = await pre(s, 'toolu_qa_s14_a', TASK.changelog, { env, step: 'pre' });
  if (expectRewrite(r, TASK.changelog, 'chain jev,openai (jev healthy)', { skills: null })) expectBlock(r.out.skills, 'chain jev,openai', 'changelog-hollowbrook');
  const ds = await decisionsFor(s);
  note('decisions', summarize(ds));
  expect('with a healthy first judge every decision is answered by jev and openai is never asked',
    ds.length >= 2 && ds.every(d => d.provider === 'jev' && d.trail.length === 1), ds.map(trailText).join(' | '));
});

await scenario('s15-chain-jev-openai-fallback', async () => {
  const s = sid('s15');
  // Wrong TypeSafe key: the first judge fails with an HTTP error and the chain falls through to the real OpenAI judge.
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active', JEV_SKILLS_JUDGES: 'jev,openai', JEV_DECISION_JUDGES: 'jev,openai', JEV_SUPERVISOR_MODE: 'active',
    JEV_SUPERVISOR_JUDGES: 'jev,openai', JEV_OPENAI_DECISIONS_APPROVED: 'true', TYPESAFE_API_KEY: 'qa-invalid-typesafe-key' };
  await open(s, env);
  const r = await pre(s, 'toolu_qa_s15_a', TASK.changelog, { env, step: 'pre' });
  const ds = await decisionsFor(s);
  note('decisions', summarize(ds));
  const cl = ds.find(d => d.pointId === 'delegation.classify');
  expect('classification: jev fails with a typed code, the live OpenAI judge answers', cl?.provider === 'openai' && cl.trail[0]?.provider === 'jev' && cl.trail[0].ok === false
    && cl.trail[1]?.provider === 'openai' && cl.trail[1].ok === true, cl ? trailText(cl) : 'no record');
  if (expectRewrite(r, TASK.changelog, 'chain jev,openai (jev key rejected)', { skills: null })) expectBlock(r.out.skills, 'openai fallback', 'changelog-hollowbrook');
  const sk = ds.find(d => d.pointId === 'delegation.skills');
  expect('skills: answered by openai after the jev failure', sk?.provider === 'openai', sk ? trailText(sk) : 'no record');
  if (r.out.kind === 'rewrite') {
    const p = await post(s, 'toolu_qa_s15_a', TASK.changelog, REPORT.complete, { env, step: 'post-complete-report' });
    const sup = (await sessionEvents(s)).find(e => e.type === 'supervisor');
    note('supervisorEvent', sup);
    const sd = (await decisionsFor(s)).find(d => d.pointId === 'supervisor.outcome');
    expect('supervisor (choice + score) answered by openai through the hook: judged "complete"', p.code === 0 && sd?.provider === 'openai' && sup?.status === 'judged' && sup?.outcome === 'complete',
      `${sd ? trailText(sd) : 'no record'} ${JSON.stringify(sup)}`);
  }
});

await scenario('s16-openai-not-approved', async () => {
  const s = sid('s16');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active', JEV_SKILLS_JUDGES: 'openai' };
  await open(s, env);
  const r = await pre(s, 'toolu_qa_s16_a', TASK.changelog, { env, step: 'pre' });
  expectRewrite(r, TASK.changelog, 'openai in the chain without approval', { skills: false });
  const ev = (await sessionEvents(s)).find(e => e.type === 'skills');
  expect('skills unavailable with OPENAI_DECISIONS_NOT_APPROVED; routing unaffected', ev?.status === 'unavailable' && ev?.code === 'OPENAI_DECISIONS_NOT_APPROVED', JSON.stringify(ev)?.slice(0, 200));
  const sk = (await decisionsFor(s)).find(d => d.pointId === 'delegation.skills');
  expect('the refused judge is logged as a failed decision (provider none) with the typed code', sk?.provider === 'none' && sk.trail[0]?.code === 'OPENAI_DECISIONS_NOT_APPROVED', sk ? trailText(sk) : 'no record');
});

await scenario('s17-openai-only-cold-latency', async () => {
  // Every hook is a new process, so every OpenAI request here is a cold connection. Five delegations.
  const s = sid('s17');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active', JEV_SKILLS_JUDGES: 'openai', JEV_DECISION_JUDGES: 'openai', JEV_OPENAI_DECISIONS_APPROVED: 'true' };
  await open(s, env);
  const tasks = [TASK.changelog, TASK.migration, TASK.loadtest, TASK.rename, TASK.changelog + ' (second request)'];
  const kinds = [];
  for (let i = 0; i < tasks.length; i++) {
    const r = await pre(s, 'toolu_qa_s17_' + i, tasks[i], { env, step: 'pre-' + i });
    kinds.push(r.out.kind + (r.out.code ? ':' + r.out.code : ''));
    expect(`openai-only delegation ${i}: exit 0, never denied`, r.code === 0 && r.out.kind !== 'deny' && r.out.kind !== 'invalid', r.out.kind);
  }
  const ds = await decisionsFor(s);
  note('decisions', summarize(ds));
  note('outputKinds', kinds);
  const steps = ds.flatMap(d => d.trail.filter(t => t.provider === 'openai').map(t => ({ point: d.pointId, ok: t.ok, code: t.code ?? null, ms: Math.round(t.latencyMs) })));
  note('openaiSteps', steps);
  note('openaiLatencyMs', { ...stats(steps.filter(x => x.ok).map(x => x.ms)), timeouts: steps.filter(x => x.code === 'DECISIONS_TIMEOUT').length, failures: steps.filter(x => !x.ok).length });
  expect('no OpenAI request in a cold hook process hit the 2500 ms provider timeout', steps.length >= 5 && !steps.some(x => x.code === 'DECISIONS_TIMEOUT'), JSON.stringify(steps.filter(x => !x.ok)));
  expect('all five delegations were routed by the OpenAI judge', kinds.every(k => k === 'rewrite'), kinds.join(','), { soft: true });
});

await scenario('s18-parallel-delegations', async () => {
  const s = sid('s18');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active' };
  await open(s, env);
  const tasks = [TASK.changelog, TASK.migration, TASK.loadtest];
  const rs = await Promise.all(tasks.map((t, i) => pre(s, 'toolu_qa_s18_' + i, t, { env, step: 'parallel-' + i })));
  rs.forEach((r, i) => expectRewrite(r, tasks[i], `parallel delegation ${i}`, { skills: null, soft: i > 0 }));
  note('outputKinds', rs.map(r => r.out.kind));
  expect('three concurrent hooks in one session: no LOCK_BUSY or hook_error', !(await sessionEvents(s)).some(e => e.type === 'hook_error'),
    JSON.stringify((await sessionEvents(s)).filter(e => e.type === 'hook_error')));
  note('blocks', rs.map(r => r.out.skills ?? null));
});

// ------------------------------------------------------------------ failure injection
function expectDegraded(r, label, { codes = null, maxMs = WATCHDOG_MS } = {}) {
  expect(`${label}: exit 0, no deny, no rewrite (native call proceeds unchanged)`,
    r.code === 0 && !r.killed && !r.stdout.includes('"permissionDecision"') && !r.stdout.includes('updatedInput') && r.out.kind !== 'invalid', `exit=${r.code} kind=${r.out.kind}`);
  expect(`${label}: Main sees a typed warning${codes ? ' (' + codes.join('|') + ')' : ''}`, r.out.kind === 'warning' && (!codes || codes.some(c => r.out.code === c || r.out.code?.startsWith(c))), `kind=${r.out.kind} code=${r.out.code}`);
  expect(`${label}: finished in ${Math.round(r.ms)} ms, below ${maxMs} ms`, r.ms < maxMs);
}

await scenario('f1-wrong-key', async () => {
  const s = sid('f1');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active', JEV_SUPERVISOR_MODE: 'active', TYPESAFE_API_KEY: 'qa-invalid-typesafe-key' };
  await open(s, env);
  const r = await pre(s, 'toolu_qa_f1_a', TASK.changelog, { env, step: 'pre' });
  expectDegraded(r, 'wrong TypeSafe key (active)', { codes: ['JEV_HTTP_4'] });
  const ev = (await sessionEvents(s)).find(e => e.type === 'skills');
  expect('skills judge failure selects nothing (status unavailable)', ev === undefined || ev.status === 'unavailable', JSON.stringify(ev)?.slice(0, 200));
  const p = await post(s, 'toolu_qa_f1_a', TASK.changelog, REPORT.complete, { env, step: 'post' });
  expect('PostToolUse after a failed route: generic observation, exit 0', p.code === 0 && p.out.kind === 'context');
  const f = await hook('PostToolUseFailure', { session: s, env, tool: 'Agent', input: agentInput(TASK.changelog), id: 'toolu_qa_f1_a', extra: { error: 'synthetic QA failure: worker crashed' }, step: 'post-failure' });
  expect('PostToolUseFailure with a failing judge: exit 0 and a typed warning, no deny', f.code === 0 && f.out.kind === 'warning' && !f.stdout.includes('permissionDecision'), `${f.out.kind} ${f.out.code}`);
  const sh = sid('f1-shadow');
  const q = await pre(sh, 'toolu_qa_f1_s', TASK.changelog, { env: { TYPESAFE_API_KEY: 'qa-invalid-typesafe-key' }, step: 'pre-shadow' });
  expect('wrong key in shadow mode: exit 0 and empty output', q.code === 0 && q.stdout.trim() === '{}');
  note('decisions', summarize(await decisionsFor(s)));
});

await scenario('f2-unreachable-endpoint', async () => {
  // A port that was just closed: connection refused. Loopback needs allowLoopback in the config (approved-loopback copy).
  const port = await new Promise(res => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); }); });
  const config = await altConfig('refused', c => { c.allowLoopback = true; c.endpoint = `http://127.0.0.1:${port}`; });
  const s = sid('f2');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active', TYPESAFE_API_KEY: 'qa-dummy-key-for-loopback', JEV_ALLOW_EGRESS: 'true' };
  await open(s, env, { config, live: false });
  const r = await pre(s, 'toolu_qa_f2_a', TASK.changelog, { env, config, step: 'pre', live: false });
  expectDegraded(r, 'unreachable endpoint (connection refused)');
  note('code', r.out.code);
});

await scenario('f3-tiny-timeout', async () => {
  const s = sid('f3');
  const env = { ...ACTIVE, JEV_SKILLS_MODE: 'active', JEV_TIMEOUT_MS: '60' };
  await open(s, env);
  const r = await pre(s, 'toolu_qa_f3_a', TASK.changelog, { env, step: 'pre' });
  expectDegraded(r, 'JEV_TIMEOUT_MS=60 against the live API', { codes: ['JEV_TIMEOUT'], maxMs: 2000 });
  const o = sid('f3-openai');
  const env2 = { ...ACTIVE, JEV_DECISION_JUDGES: 'openai', JEV_OPENAI_DECISIONS_APPROVED: 'true', JEV_OPENAI_DECISIONS_TIMEOUT_MS: '60' };
  const r2 = await pre(o, 'toolu_qa_f3_b', TASK.changelog, { env: env2, step: 'pre-openai' });
  expectDegraded(r2, 'JEV_OPENAI_DECISIONS_TIMEOUT_MS=60 against the live API', { codes: ['DECISIONS_TIMEOUT'], maxMs: 2000 });
  // The documented minimum is 50 ms. Observed: the kernel's 50 ms minimum-budget check refuses before any request is sent.
  const m = sid('f3-min');
  const r3 = await pre(m, 'toolu_qa_f3_m', TASK.changelog, { env: { ...ACTIVE, JEV_TIMEOUT_MS: '50' }, step: 'pre-minimum-50ms' });
  expectDegraded(r3, 'JEV_TIMEOUT_MS=50 (documented minimum)', { maxMs: 2000 });
  const d3 = (await decisionsFor(m)).find(d => d.pointId === 'delegation.classify');
  note('minimumTimeoutTrail', d3 ? trailText(d3) : null);
  expect('JEV_TIMEOUT_MS=50 (documented minimum): the judge is actually asked and times out (JEV_TIMEOUT), as before the kernel',
    r3.out.code === 'JEV_TIMEOUT', `code=${r3.out.code} trail=${d3 ? trailText(d3) : 'none'}`, { soft: true });
  const bad = await pre(sid('f3-bad'), 'toolu_qa_f3_c', TASK.changelog, { env: { ...ACTIVE, JEV_OPENAI_DECISIONS_TIMEOUT_MS: '9999' }, step: 'pre-invalid-timeout-env' });
  expect('out-of-range JEV_OPENAI_DECISIONS_TIMEOUT_MS: exit 1, "{}" on stdout, typed code on stderr, no deny',
    bad.code === 1 && bad.stdout.trim() === '{}' && bad.stderr.includes('INVALID_JEV_OPENAI_DECISIONS_TIMEOUT_MS'), bad.stderr);
});

// Loopback servers started by this driver. They are NOT judges and nothing here is a live result:
// they exist only to hold a connection open so the worst-case wall-clock time of one hook can be observed.
async function withStub(handler, fn) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', sk => { sockets.add(sk); sk.on('close', () => sockets.delete(sk)); });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { for (const sk of sockets) sk.destroy(); await new Promise(res => server.close(res)); }
}
const STRESS_ENV = { ...ACTIVE, JEV_SKILLS_MODE: 'active', JEV_SUPERVISOR_MODE: 'active', JEV_SKILLS_JUDGES: 'jev,openai', JEV_DECISION_JUDGES: 'jev,openai',
  JEV_SUPERVISOR_JUDGES: 'jev,openai', JEV_OPENAI_DECISIONS_APPROVED: 'true', JEV_TIMEOUT_MS: '5000', JEV_OPENAI_DECISIONS_TIMEOUT_MS: '5000',
  TYPESAFE_API_KEY: 'qa-dummy-key-for-loopback', OPENAI_API_KEY: 'qa-dummy-key-for-loopback', JEV_ALLOW_EGRESS: 'true' };
const stressConfig = (name, origin) => altConfig(name, c => {
  c.allowLoopback = true; c.endpoint = origin; c.kernel.providers.openai.endpoint = origin; c.optimization.routeDeadlineMs = 5500;
});

await scenario('f4-blackhole-max-timeouts', async () => {
  await withStub(() => { /* never answers */ }, async origin => {
    const config = await stressConfig('blackhole', origin);
    const s = sid('f4');
    await open(s, STRESS_ENV, { config, live: false });
    const r = await pre(s, 'toolu_qa_f4_a', TASK.changelog, { env: STRESS_ENV, config, step: 'pre', live: false });
    expectDegraded(r, 'both judges hang, every timeout at its 5000 ms maximum, routeDeadlineMs 5500 (loopback, not live)');
    note('preMs', Math.round(r.ms)); note('preCode', r.out.code);
    const f = await hook('PostToolUseFailure', { session: s, env: STRESS_ENV, config, tool: 'Agent', input: agentInput(TASK.changelog), id: 'toolu_qa_f4_a',
      extra: { error: 'synthetic QA failure: worker crashed' }, step: 'post-failure', live: false });
    expect(`PostToolUseFailure with hanging judges: exit 0, no deny, ${Math.round(f.ms)} ms < ${WATCHDOG_MS} ms`, f.code === 0 && !f.killed && f.ms < WATCHDOG_MS && !f.stdout.includes('permissionDecision'), `${f.out.kind} ${f.out.code}`);
    note('postFailureMs', Math.round(f.ms));
  });
});

await scenario('f5-slow-classify-then-hang', async () => {
  // Stub: answers the classification question set after 4800 ms with a fixed valid answer, never answers anything else.
  // Worst realistic sequence for one PreToolUse: slow classification, then profile selection waits out the rest of the route deadline.
  const handler = (req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let q;
      try { q = JSON.parse(body).questions; } catch { return; }
      if (!q || !q.role) return; // skills / profile / supervisor: hang
      const answers = {};
      for (const [id, spec] of Object.entries(q)) {
        if (spec.type === 'noul') { answers[id] = { type: 'noul', noul: 0.1 }; continue; }
        const keys = Object.keys(spec.criteria);
        // plan + routine -> two strategic candidates and no mechanical fast path -> profile selection is asked
        const pick = id === 'role' ? 'plan' : id === 'reasoning' ? 'routine' : keys[0];
        answers[id] = { type: 'choice', choice: pick, confidence: 0.97, probabilities: Object.fromEntries(keys.map(k => [k, k === pick ? 0.97 : 0.03 / (keys.length - 1)])) };
      }
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ model: 'qa-loopback-stub', answers, usage: { input_tokens: 0, output_tokens: 0 } })); }, 4800);
    });
  };
  await withStub(handler, async origin => {
    const config = await stressConfig('slow', origin);
    const s = sid('f5');
    await open(s, STRESS_ENV, { config, live: false });
    const r = await pre(s, 'toolu_qa_f5_a', TASK.changelog, { env: STRESS_ENV, config, step: 'pre', live: false });
    note('preMs', Math.round(r.ms)); note('kind', r.out.kind + (r.out.code ? ':' + r.out.code : ''));
    const ev = (await sessionEvents(s)).find(e => e.type === 'route');
    note('routeReason', ev?.route?.decisionReason ?? null);
    expect(`slow classification (4.8 s) + hanging selector and skills judge: exit 0, no deny, ${Math.round(r.ms)} ms < ${WATCHDOG_MS} ms watchdog (loopback stub, not live)`,
      r.code === 0 && !r.killed && r.ms < WATCHDOG_MS && r.out.kind !== 'deny' && r.out.kind !== 'invalid', `kind=${r.out.kind} code=${r.out.code ?? ''} stderr=${r.stderr.trim()}`);
    expect('the hook process was not ended by its own watchdog (no HOOK_DEADLINE on stderr)', !r.stderr.includes('HOOK_DEADLINE'), r.stderr.trim());
  });
});

await scenario('f6-bad-input', async () => {
  const s = sid('f6');
  const r = await hook('PreToolUse', { session: s, tool: 'Agent', env: ACTIVE, raw: '{not json', step: 'garbage-stdin', live: false });
  expect('garbage on stdin: exit 1, "{}" on stdout, no deny', r.code === 1 && r.stdout.trim() === '{}', r.stderr);
  const outside = await hook('PreToolUse', { session: s, tool: 'Agent', env: ACTIVE, live: false, step: 'project-not-allowed',
    raw: JSON.stringify({ session_id: s, cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: agentInput(TASK.rename), tool_use_id: 'toolu_qa_f6' }) });
  expect('cwd outside the allow-listed project: exit 0 and empty output', outside.code === 0 && outside.stdout.trim() === '{}');
});

// ------------------------------------------------------------------ installed state: log, files, CLIs
await scenario('z1-decision-log', async () => {
  const dir = logDir();
  expect('decision log directory exists with mode 700', await exists(dir) && (await mode(dir)) === '700', await exists(dir) ? await mode(dir) : 'missing');
  const names = (await exists(dir)) ? await fs.readdir(dir) : [];
  const files = names.filter(n => /^(decisions|labels)-\d{4}-\d{2}\.jsonl$/.test(n));
  expect('decision log holds only decisions-/labels-YYYY-MM.jsonl files, each mode 600', files.length >= 1 && files.length === names.length
    && (await Promise.all(files.map(f => mode(path.join(dir, f))))).every(m => m === '600'), names.join(','));
  const all = await allDecisions();
  expect('every decision line passes the product record contract', all.length > 0 && all.every(isDecisionRecord), `${all.length} records`);
  const raw = (await Promise.all(files.map(f => fs.readFile(path.join(dir, f), 'utf8')))).join('\n');
  const needles = { taskText: CANARY.task, reportText: CANARY.report, skillDescription: CANARY.description, skillBody: CANARY.body,
    skillName: 'changelog-hollowbrook', taskWords: 'retry-max', reportWords: 'git diff --stat', descriptionWords: 'trailing owner tag' };
  const hits = Object.entries(needles).filter(([, n]) => raw.toLowerCase().includes(n.toLowerCase())).map(([k]) => k);
  expect('decision log contains no task, report, skill-description or skill-name text', hits.length === 0, hits.join(','));
  expect('decision log contains neither API key', !raw.includes(TS_KEY) && !raw.includes(OA_KEY));
  const byPoint = {};
  for (const d of all) { const k = `${d.pointId}|${d.mode}|${d.provider}`; byPoint[k] = (byPoint[k] || 0) + 1; }
  note('recordsByPointModeProvider', byPoint);
  note('records', all.length);
});

await scenario('z2-state-files', async () => {
  const files = await walk(stateDir);
  const bad = [];
  const leaks = { task: [], report: [], description: [], body: [], key: [] };
  for (const f of files) {
    if ((await mode(f)) !== '600') bad.push(path.relative(stateDir, f));
    const text = await fs.readFile(f, 'utf8');
    for (const k of ['task', 'report', 'description', 'body']) if (text.includes(CANARY[k])) leaks[k].push(path.relative(stateDir, f));
    if (text.includes(TS_KEY) || text.includes(OA_KEY)) leaks.key.push(path.relative(stateDir, f));
  }
  note('stateFiles', files.length);
  expect('every file under the state directory is mode 600', bad.length === 0, bad.slice(0, 5).join(','));
  expect('no API key anywhere under the state directory', leaks.key.length === 0, leaks.key.slice(0, 3).join(','));
  expect('no task text anywhere under the state directory (retainPromptText is off)', leaks.task.length === 0, leaks.task.slice(0, 3).join(','));
  expect('no worker report text anywhere under the state directory', leaks.report.length === 0, leaks.report.slice(0, 3).join(','));
  expect('no skill description or body text anywhere under the state directory', leaks.description.length === 0 && leaks.body.length === 0, [...leaks.description, ...leaks.body].slice(0, 3).join(','));
  // Keys must exist only in the two private env files.
  const holders = [];
  for (const f of await walk(root)) { const t = await fs.readFile(f, 'utf8').catch(() => ''); if (t.includes(TS_KEY) || t.includes(OA_KEY)) holders.push(path.relative(root, f)); }
  expect('key values exist only in the private setup env and the installed .env', holders.sort().join(',') === ['home/.config/jev-hooks/.env', 'private-setup.env'].sort().join(','), holders.join(','));
});

await scenario('z3-cli', async () => {
  const node = process.execPath;
  const cli = (script, argv, env = {}) => runProcess(node, [path.join(ORCH, 'scripts', script), ...argv], { env: { ...baseEnv, ...env }, cwd: REPO });
  const parse = r => { try { return JSON.parse(r.stdout); } catch { return null; } };
  // No --config: the CLI must find the installed config through HOME.
  const rep = await cli('decisions.mjs', ['--action', 'report']);
  const report = parse(rep);
  expect('decisions.mjs --action report (installed config via HOME): exit 0 with points and groups', rep.code === 0 && Array.isArray(report?.points) && Array.isArray(report?.groups) && report.corruptLines === 0, rep.stderr);
  if (report) {
    note('reportPoints', report.points.map(p => ({ point: p.pointId, decisions: p.decisions, failed: p.failed, escalated: p.escalated, judges: p.judges.map(j => `${j.provider}:${j.attempts}/${j.failures}f/${j.lowConfidence}low`) })));
    note('reportGroups', report.groups.map(g => ({ point: g.pointId, provider: g.provider, type: g.type, decisions: g.counts.decisions, labeled: g.counts.labeled, p50: g.operational.latencyMs.p50, p95: g.operational.latencyMs.p95, metrics: g.metrics ?? null })));
    expect('report covers classify, profile, skills and supervisor points', ['delegation.classify', 'delegation.skills', 'supervisor.outcome'].every(p => report.points.some(x => x.pointId === p)), report.points.map(p => p.pointId).join(','));
    const rates = ['brier', 'ece', 'accuracy', 'baseRate', 'precision', 'recall', 'f1', 'meanConfidence', 'mae', 'exactLevelAccuracy'];
    expect('unlabeled calibration metrics are null, not 0', report.groups.filter(g => g.counts.labeled === 0)
      .every(g => rates.every(k => g.metrics?.[k] === undefined || g.metrics[k] === null)), '');
  }
  const show = await cli('decisions.mjs', ['--action', 'show', '--point', 'delegation.skills', '--limit', '3']);
  expect('decisions.mjs --action show: exit 0 with at most 3 skills decisions', show.code === 0 && parse(show)?.decisions?.length >= 1 && parse(show).decisions.length <= 3 && parse(show).decisions.every(d => d.pointId === 'delegation.skills'), show.stderr);
  if (labelTarget) {
    const lab = await cli('decisions.mjs', ['--action', 'label', '--decision', labelTarget, '--question', 'need', '--outcome', 'true', '--source', 'qa-e2e']);
    expect('decisions.mjs --action label: exit 0', lab.code === 0 && parse(lab)?.decisionId === labelTarget, lab.stderr);
    const rep2 = parse(await cli('decisions.mjs', ['--action', 'report', '--point', 'delegation.skills']));
    expect('the label is joined in the next report (1 label, group not "sufficient")', rep2?.generatedFrom?.labels === 1 && rep2.groups.some(g => g.counts.labeled === 1 && g.sufficient === false), JSON.stringify(rep2?.generatedFrom));
    const unknown = await cli('decisions.mjs', ['--action', 'label', '--decision', 'f'.repeat(64), '--question', 'need', '--outcome', 'true', '--source', 'qa-e2e']);
    expect('label for an unknown decision is refused (UNKNOWN_DECISION, exit 1)', unknown.code === 1 && unknown.stderr.includes('UNKNOWN_DECISION'), unknown.stderr);
  }
  const list = await cli('skills.mjs', ['--project', project, '--list']);
  expect('skills.mjs --list: exit 0, the four synthetic skills, nothing skipped', list.code === 0 && parse(list)?.skills?.length === 4 && parse(list).skipped.length === 0, list.stderr || list.stdout.slice(0, 200));
  const why = await cli('skills.mjs', ['--project', project, '--task', TASK.changelog, '--why-not', 'sql-migration-safety']);
  note('whyNotLocal', parse(why));
  expect('skills.mjs --why-not (local judge, no network): exit 0 with a stage and reason', why.code === 0 && typeof parse(why)?.whyNot?.stage === 'string' && typeof parse(why).whyNot.reason === 'string', why.stderr);
  const missing = await cli('skills.mjs', ['--project', project, '--task', TASK.changelog, '--why-not', 'no-such-skill']);
  expect('skills.mjs --why-not for an unknown skill: not_in_catalog', parse(missing)?.whyNot?.stage === 'not_in_catalog', missing.stdout.slice(0, 120));
  const off = await cli('skills.mjs', ['--project', project, '--task', TASK.changelog, '--judge', 'config', '--config', confFile]);
  expect('skills.mjs --judge config with the installed default (point off): unavailable / KERNEL_POINT_OFF', off.code === 0 && parse(off)?.status === 'unavailable' && parse(off)?.code === 'KERNEL_POINT_OFF', off.stdout.slice(0, 160));
  const before = (await allDecisions()).length;
  const live = await cli('skills.mjs', ['--project', project, '--task', TASK.changelog, '--why-not', 'sql-migration-safety', '--judge', 'config', '--config', confFile], { JEV_SKILLS_MODE: 'shadow' });
  note('whyNotConfig', parse(live));
  expect('skills.mjs --why-not --judge config (installed chain, live Jev): exit 0 with a judged stage and probability',
    live.code === 0 && parse(live)?.judge === 'config' && typeof parse(live)?.whyNot?.probability === 'number' && !['retrieval', 'judge_unavailable'].includes(parse(live).whyNot.stage), live.stderr || live.stdout.slice(0, 200));
  expect('the CLI run was written to the installed decision log', (await allDecisions()).length === before + 1);
});

await finish();

// ------------------------------------------------------------------ summary
async function finish(setupOnly = false) {
  current = 'isolation';
  expect('the real ~/.config/jev-hooks was not created or touched', (await exists(realJevDir)) === realBefore.jevHooksDirExists);
  expect('the real ~/.claude/settings.json was not modified',
    (await fs.stat(path.join(realHome, '.claude', 'settings.json')).then(s => s.mtimeMs, () => null)) === realBefore.claudeSettingsMtime);

  const inv = results.invocations;
  const liveMs = inv.filter(i => i.live).map(i => i.ms);
  const group = fn => stats(inv.filter(fn).map(i => i.ms));
  const timing = {
    all: stats(inv.map(i => i.ms)),
    liveJudgeScenarios: stats(liveMs),
    livePreToolUseDelegation: group(i => i.live && i.event === 'PreToolUse' && i.tool === 'Agent'),
    livePostToolUse: group(i => i.live && i.event.startsWith('PostToolUse')),
    lifecycleEvents: group(i => !['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(i.event)),
    loopbackStress: group(i => !i.live),
    watchdogMs: WATCHDOG_MS, hostHookTimeoutMs: HOST_HOOK_TIMEOUT_MS,
    slowest: [...inv].sort((a, b) => b.ms - a.ms).slice(0, 5).map(i => ({ scenario: i.scenario, step: i.step, ms: i.ms, live: i.live })),
  };
  if (!setupOnly && inv.length) {
    expect(`no live-judge hook invocation approaches the watchdog (max ${timing.liveJudgeScenarios.max} ms < 5000 ms)`, timing.liveJudgeScenarios.max < 5000);
    expect(`no hook invocation at all reached the ${WATCHDOG_MS} ms watchdog or the host timeout (max ${timing.all.max} ms)`, timing.all.max < WATCHDOG_MS && !inv.some(i => i.killedAtHostTimeout));
  }

  // Live request accounting, derived from the decision-log trails (the hook has no HTTP counter):
  // one trail step of a network judge = one HTTP request, unless the code shows nothing was sent or the answer was cached.
  const NOT_SENT = new Set(['KERNEL_DEADLINE', 'EGRESS_NOT_APPROVED', 'OPENAI_DECISIONS_NOT_APPROVED', 'MISSING_OPENAI_API_KEY', 'MISSING_TYPESAFE_API_KEY',
    'OPENAI_ENDPOINT_NOT_APPROVED', 'SECRET_GUARD', 'JEV_CIRCUIT_OPEN', 'JEV_REQUEST_CAP', 'LOCK_BUSY', 'LOCAL_ABSTAIN']);
  const loopbackScopes = inv.length ? new Set(['f2', 'f4', 'f5'].map(n => scopeOf(sid(n)))) : new Set();
  const requests = { 'api.typesafe.ai': 0, 'api.openai.com': 0, loopbackNotLive: 0 };
  const failuresByCode = {};
  let decisions = [];
  try { decisions = stateDirKnown() && inv.length ? await allDecisions() : []; } catch { decisions = []; }
  for (const d of decisions) {
    d.trail.forEach((t, i) => {
      if (!['jev', 'openai'].includes(t.provider)) return;
      if (!t.ok && t.code !== 'KERNEL_LOW_CONFIDENCE') failuresByCode[`${t.provider}:${t.code}`] = (failuresByCode[`${t.provider}:${t.code}`] || 0) + 1;
      if (NOT_SENT.has(t.code)) return;
      if (d.cached && d.provider === t.provider && i === d.trail.length - 1) return;
      if (loopbackScopes.has(d.scope)) { requests.loopbackNotLive++; return; }
      requests[t.provider === 'jev' ? 'api.typesafe.ai' : 'api.openai.com']++;
    });
  }
  // Token usage as returned by the APIs: successful responses are stored (response body, no request text) in the
  // hook's cache files. Failed requests return no usage. The OpenAI adapter writes 0 for fields the API omits.
  const usage = {};
  if (stateDirKnown()) {
    for (const f of await walk(path.join(results.setup.stateDir, 'cache'))) {
      if (!f.endsWith('.json')) continue;
      let c; try { c = await readJSON(f); } catch { continue; }
      const model = c?.response?.model;
      if (typeof model !== 'string' || model === 'qa-loopback-stub') continue;
      const u = (usage[model] ??= { responses: 0, input_tokens: 0, output_tokens: 0, otherUsageFields: {} });
      u.responses++;
      for (const [k, v] of Object.entries(c.response.usage || {})) {
        if (typeof v !== 'number') continue;
        if (k === 'input_tokens' || k === 'output_tokens') u[k] += v; else u.otherUsageFields[k] = (u.otherUsageFields[k] || 0) + v;
      }
    }
  }
  function stateDirKnown() { return !!results.setup?.stateDir; }

  const failed = results.expectations.filter(e => !e.pass && !e.soft);
  const warned = results.expectations.filter(e => !e.pass && e.soft);
  let commit = null;
  try { commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
  const output = {
    meta: { tool: 'qa/kernel/e2e-hooks.mjs', date: new Date().toISOString(), node: process.version, productVersion: VERSION, commit,
      live: true, note: 'Invocations with live:false talk to a loopback socket started by this driver (failure/latency injection), never to a judge.',
      entrypoint: results.setup?.entry ?? null, runId },
    totals: { expectations: results.expectations.length, passed: results.expectations.length - failed.length - warned.length, failed: failed.length,
      softMisses: warned.length, softExpectations: results.expectations.filter(e => e.soft).length,
      hookInvocations: inv.length, liveInvocations: inv.filter(i => i.live).length, decisionRecords: decisions.length },
    timingMs: timing,
    liveRequests: { derivedFrom: 'decision-log trails (one network-judge step = one request; cached answers and not-sent codes excluded)', ...requests, failuresByCode },
    tokenUsageFromApiResponses: Object.keys(usage).length ? usage : null,
    setup: results.setup ?? null,
    scenarios: results.scenarios,
    expectations: results.expectations,
    invocations: inv,
  };
  let text = JSON.stringify(output, null, 2) + '\n';
  if (text.includes(TS_KEY) || text.includes(OA_KEY)) { console.error('QA_SECRET_IN_OUTPUT: results not written'); process.exit(1); }

  // pass/fail table
  const width = Math.max(...results.expectations.map(e => e.scenario.length), 8);
  console.log(`${'scenario'.padEnd(width)}  result  expectation`);
  for (const e of results.expectations) console.log(`${e.scenario.padEnd(width)}  ${e.pass ? 'PASS  ' : e.soft ? 'WARN  ' : 'FAIL  '}  ${e.name}${e.pass || !e.detail ? '' : '\n' + ' '.repeat(width + 10) + '-> ' + e.detail.replace(/\s+/g, ' ').slice(0, 300)}`);
  console.log('');
  console.log(`expectations: ${output.totals.passed} passed, ${output.totals.failed} failed, ${output.totals.softMisses} soft misses (WARN: live-judge choice or documented observation; of ${output.totals.expectations}, ${output.totals.softExpectations} soft)`);
  if (inv.length) {
    console.log(`hook invocations: ${inv.length} (${output.totals.liveInvocations} in live-judge scenarios); wall clock ms  all p50 ${timing.all.p50} max ${timing.all.max} | live p50 ${timing.liveJudgeScenarios.p50} p95 ${timing.liveJudgeScenarios.p95} max ${timing.liveJudgeScenarios.max} | live delegation PreToolUse p50 ${timing.livePreToolUseDelegation.p50} max ${timing.livePreToolUseDelegation.max}`);
    console.log(`live requests (from decision-log trails): api.typesafe.ai=${requests['api.typesafe.ai']} api.openai.com=${requests['api.openai.com']}; loopback (not live)=${requests.loopbackNotLive}`);
    console.log(`token usage returned by the APIs (successful responses): ${Object.entries(usage).map(([m, u]) => `${m} in=${u.input_tokens} out=${u.output_tokens} (${u.responses} responses)`).join('; ') || 'none'}`);
  }
  if (typeof args.out === 'string') {
    const out = path.resolve(args.out);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, text);
    console.log('results: ' + out);
  }
  if (args.keep || setupOnly) console.log('kept: ' + root);
  else await fs.rm(root, { recursive: true, force: true });
  process.exit(failed.length ? 1 : 0);
}
