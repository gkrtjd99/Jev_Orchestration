#!/usr/bin/env node
// One small REAL headless Claude Code session against the installed hooks, fully isolated:
// HOME and CLAUDE_CONFIG_DIR point at the disposable install made by e2e-hooks.mjs --setup-only, the
// environment is rebuilt from scratch (nothing inherited from a host Claude session), and the real
// ~/.claude, ~/.claude.json and ~/.config/jev-hooks are never read or written.
//
// STATUS (2026-11-25, Claude Code 2.1.332): verified only up to authentication. Without a credential
// the session starts, runs the installed SessionStart and UserPromptSubmit hooks, lists the jev4_*
// agents and the project skills, and stops with "Not logged in" at zero cost. The checks (a)-(d) below
// have therefore NEVER run against a real transcript; treat their parsing as untested.
//
// A credential must come from the caller's environment (never copied from a keychain or a file):
//   CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY.
// TYPESAFE_API_KEY and OPENAI_API_KEY are needed by the setup step. No key value is printed or saved.
//
// Usage (worktree root):  node qa/kernel/e2e-real-session.mjs --root <empty dir> --out <file.json> [--model sonnet] [--budget 2]
// Exit: 0 all four checks passed, 1 a check failed, 3 BLOCKED (no credential / not logged in), 64 usage.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hash } from '../../orchestration/src/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = {};
for (let i = 2; i < process.argv.length; i++) { const k = process.argv[i].replace(/^--/, ''); args[k] = process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[++i]; }
if (typeof args.root !== 'string' || typeof args.out !== 'string') { console.error('usage: --root <empty dir> --out <file.json> [--model sonnet] [--budget 2]'); process.exit(64); }
const SKILL = 'changelog-hollowbrook';
const PROMPT = 'Use the Agent tool exactly once (subagent_type general-purpose) to delegate this task, then report the subagent\'s result verbatim. '
  + 'Do not do the work yourself and do not add instructions of your own. Task for the subagent: "Add a new entry to CHANGELOG.md under the existing '
  + '\\"## 1.4.0\\" heading that describes the new --retry-max flag implemented in src/retry.js. Follow this repository\'s changelog entry format exactly. '
  + 'Acceptance: exactly one new entry line under \\"## 1.4.0\\" in CHANGELOG.md and no other file is changed."';

const run = (file, argv, opts) => new Promise(resolve => {
  const child = spawn(file, argv, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.on('close', code => resolve({ code, stdout, stderr }));
});

const setup = await run(process.execPath, [path.join(HERE, 'e2e-hooks.mjs'), '--setup-only', '--alias-models', '--root', path.resolve(args.root)], { env: process.env });
const paths = (() => { try { return JSON.parse(setup.stdout.slice(0, setup.stdout.indexOf('\n}') + 2)); } catch { return null; } })();
if (!paths) { console.error('setup failed: ' + setup.stderr.slice(0, 300)); process.exit(1); }

const claude = execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim();
const version = execFileSync(claude, ['--version'], { encoding: 'utf8' }).trim();
const credential = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].find(k => process.env[k]);
// Fresh environment: a host Claude session exports CLAUDE_CODE_SIMPLE (bare mode, which skips hooks) and other CLAUDE_* state.
const env = { HOME: paths.home, CLAUDE_CONFIG_DIR: path.join(paths.home, '.claude'), PATH: process.env.PATH, USER: process.env.USER ?? '', LANG: 'en_US.UTF-8',
  TMPDIR: process.env.TMPDIR ?? '/tmp', JEV_MODE: 'active', JEV_SKILLS_MODE: 'active', ...(credential ? { [credential]: process.env[credential] } : {}) };
const session = await run(claude, ['-p', PROMPT, '--model', typeof args.model === 'string' ? args.model : 'sonnet', '--output-format', 'stream-json', '--verbose',
  '--include-hook-events', '--max-turns', '12', '--permission-mode', 'acceptEdits', '--allowedTools', 'Agent,Task,Read,Edit,Write,Glob,Grep,Skill',
  '--strict-mcp-config', '--max-budget-usd', typeof args.budget === 'string' ? args.budget : '2', '--debug-file', path.join(paths.root, 'claude-debug.log')],
{ cwd: paths.project, env });

const rows = session.stdout.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const init = rows.find(r => r.type === 'system' && r.subtype === 'init');
const result = rows.find(r => r.type === 'result');
const hookEvents = rows.filter(r => r.type === 'system' && r.subtype === 'hook_response').map(r => ({ event: r.hook_event, exit: r.exit_code ?? null }));
const notLoggedIn = /Not logged in/i.test(String(result?.result ?? ''));

// Evidence from the hook's own state (formats exercised by e2e-hooks.mjs).
const sessionDir = init ? path.join(paths.stateDir, 'sessions', hash({ project: paths.project, runtime: 'claude', session: init.session_id })) : null;
const readAll = async dir => { const out = []; try { for (const n of await fs.readdir(dir)) out.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'))); } catch { /* absent */ } return out; };
const events = sessionDir ? await readAll(path.join(sessionDir, 'events')) : [];
const tasks = sessionDir ? await readAll(path.join(sessionDir, 'decisions')) : [];
const route = events.find(e => e.type === 'route');
const skillsEvent = events.find(e => e.type === 'skills');
// Evidence from the session itself (UNTESTED parsing, see header).
const uses = rows.filter(r => r.type === 'assistant').flatMap(r => (r.message?.content || []).filter(c => c.type === 'tool_use').map(c => ({ ...c, parent: r.parent_tool_use_id ?? null })));
const agentCall = uses.find(u => ['Agent', 'Task'].includes(u.name) && !u.parent);
const transcripts = [];
const collect = async dir => { try { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) await collect(p); else if (p.endsWith('.jsonl')) transcripts.push(await fs.readFile(p, 'utf8')); } } catch { /* absent */ } };
await collect(path.join(paths.home, '.claude', 'projects'));
const subagentLoads = uses.filter(u => u.parent && ((u.name === 'Skill' && JSON.stringify(u.input).includes(SKILL)) || (u.name === 'Read' && JSON.stringify(u.input).includes(`${SKILL}/SKILL.md`))));
const changelog = await fs.readFile(path.join(paths.project, 'CHANGELOG.md'), 'utf8');
const added = changelog.split('## 1.3.0')[0].split('\n').filter(l => l.startsWith('- '));
const checks = {
  a_preToolUseFiredOnRealAgentCall: !!agentCall && !!route && route.taskId === agentCall.id,
  b_promptRewrittenWithSkillsBlock: tasks.some(t => typeof t.skillsText === 'string' && t.skillsText.includes(SKILL)) && skillsEvent?.injected === true
    && transcripts.some(t => t.includes('<jev-skills>') && t.includes(SKILL)),
  c_subagentLoadedTheSkill: subagentLoads.length > 0,
  d_outputFollowsConvention: added.length === 1 && /^- \[HB-0142\] [A-Z][^.]*[^.] \(owner: @[\w-]+\) ~hbk$/.test(added[0]),
};
const status = !credential || notLoggedIn ? 'BLOCKED' : Object.values(checks).every(Boolean) ? 'RAN_ALL_CHECKS_PASSED' : 'RAN_WITH_FAILED_CHECKS';
const output = {
  meta: { tool: 'qa/kernel/e2e-real-session.mjs', date: new Date().toISOString(), claudeCode: version, isolation: 'HOME and CLAUDE_CONFIG_DIR = disposable install; environment rebuilt from scratch' },
  status, blockedReason: status === 'BLOCKED' ? (credential ? 'credential rejected: ' : 'no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the environment: ') + String(result?.result ?? session.stderr).slice(0, 200) : null,
  credentialSource: credential ?? null, exitCode: session.code,
  init: init ? { model: init.model, sessionId: init.session_id, jevAgentsListed: (init.agents || []).filter(a => String(a).startsWith('jev4_')).length, projectSkillsListed: (init.skills || []).filter(s => ['changelog-hollowbrook', 'k6-load-test', 'pdf-table-extract', 'sql-migration-safety'].includes(s)) } : null,
  hookEvents, hookStateEvents: events.map(e => e.type),
  result: result ? { isError: result.is_error, numTurns: result.num_turns, totalCostUsd: result.total_cost_usd ?? null, usage: result.usage ?? null, modelUsage: result.modelUsage ?? null, text: String(result.result ?? '').slice(0, 600) } : null,
  checks: status === 'BLOCKED' ? null : checks,
  evidence: status === 'BLOCKED' ? null : { agentCall: agentCall ? { id: agentCall.id, subagentType: agentCall.input?.subagent_type } : null, routedProfile: route?.route?.profile ?? null, skillsEvent, subagentLoads: subagentLoads.map(u => ({ name: u.name, input: u.input })), addedChangelogLines: added },
  setup: paths,
};
const text = JSON.stringify(output, null, 2) + '\n';
for (const k of ['TYPESAFE_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) if (process.env[k] && text.includes(process.env[k])) { console.error('QA_SECRET_IN_OUTPUT'); process.exit(1); }
await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
await fs.writeFile(path.resolve(args.out), text);
console.log(`${status}${output.blockedReason ? ' - ' + output.blockedReason : ''}`);
console.log(`hooks fired in the real session: ${hookEvents.map(h => `${h.event}(exit ${h.exit})`).join(', ') || 'none'}`);
if (output.checks) for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
console.log('results: ' + path.resolve(args.out) + '\nkept: ' + paths.root);
process.exit(status === 'BLOCKED' ? 3 : status === 'RAN_ALL_CHECKS_PASSED' ? 0 : 1);
