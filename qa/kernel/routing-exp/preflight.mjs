#!/usr/bin/env node
// Pre-run checklist of the routing experiment. Read-only: it writes nothing, anywhere.
//   node preflight.mjs --work <dir> [--settings <settings file> ...] [--agents <agents folder>]
// It looks only at <work> (the folders README.md creates: arm-n, arm-r, arm-l, home-r, home-l,
// routing-exp-arm-R) and at the paths named on the command line. It never goes looking for a home directory:
// the user-level and managed settings files and the user-level agents folder are checked only when whoever runs
// this names them. Nothing from those files is printed except file names of jev4_* profiles and counts.
// Exit 0 when nothing was found, 1 otherwise. What it checks, and why:
//   * arm N's project has no .claude folder, and no settings file named with --settings carries a jev-hook
//     command: a hook that reaches the arm N session makes it a routed arm (and doubles the hooks of R and L)
//   * arms R and L carry project hooks that point into their own disposable install
//   * no project copy has a CLAUDE.md or a .claude/skills folder
//   * this process has no JEV_* / TYPESAFE_* / CLAUDE_CODE_SUBAGENT_MODEL* variable (names only): the hook reads
//     the environment BEFORE the arm's .env, so such a variable in the environment the desktop app starts from
//     silently replaces the arm's fixed settings. Run this from that same environment.
//     (TYPESAFE_API_KEY in the environment is reported as keyFromEnvironment and is not a problem: it replaces
//     the key of the .env, not a setting of the arm.)
//   * with --agents: the folder holds exactly arm R's jev4_* profile files, byte for byte as installed in home-r
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { overridingEnvNames, keyFromEnvironment } from './make-arm-config.mjs';

const sha = (data) => createHash('sha256').update(data).digest('hex');
const exists = (target) => { try { fs.lstatSync(target); return true; } catch { return false; } };
const hookCommands = (settings) => Object.values(settings?.hooks ?? {}).flat().flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : [])).map((hook) => hook?.command).filter((c) => typeof c === 'string');

export function preflight({ work, settings = [], agents = null, env = process.env }) {
  const problems = [];
  const report = { work, projects: {}, settingsFiles: [], overridingEnvironmentNames: overridingEnvNames(env), keyFromEnvironment: keyFromEnvironment(env), agents: null };
  for (const arm of ['n', 'r', 'l']) {
    const project = path.join(work, `arm-${arm}`);
    const entry = { exists: exists(project), claudeFolder: exists(path.join(project, '.claude')), claudeMd: exists(path.join(project, 'CLAUDE.md')), skillsFolder: exists(path.join(project, '.claude', 'skills')), projectHooks: null };
    report.projects[`arm-${arm}`] = entry;
    if (!entry.exists) { problems.push(`${project} does not exist`); continue; }
    if (entry.claudeMd) problems.push(`arm-${arm} has a CLAUDE.md`);
    if (entry.skillsFolder) problems.push(`arm-${arm} has a .claude/skills folder`);
    if (arm === 'n') { if (entry.claudeFolder) problems.push('arm-n has a .claude folder: arm N must carry no hooks and no settings'); continue; }
    const config = path.join(work, `home-${arm}`, '.config', 'jev-hooks', 'config.json');
    let commands = null;
    try { commands = hookCommands(JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'))); } catch { /* reported below */ }
    entry.projectHooks = commands === null ? null : commands.length;
    if (!commands || commands.length === 0) problems.push(`arm-${arm} has no project hooks: run project-hooks.mjs after the last install`);
    else if (!commands.every((command) => command.includes('jev-hook') && command.includes(`'${config}'`))) problems.push(`arm-${arm}: a project hook does not point at ${config}`);
  }
  for (const file of settings) {
    const entry = { file, exists: exists(file), jevHookCommands: null };
    if (entry.exists) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { problems.push(`${file} cannot be read`); }
      let parsed = null; try { parsed = JSON.parse(text); } catch { /* counted from the text */ }
      entry.jevHookCommands = parsed ? hookCommands(parsed).filter((command) => command.includes('jev-hook')).length : (text.match(/jev-hook/g) ?? []).length;
      if (entry.jevHookCommands > 0) problems.push(`${file} carries ${entry.jevHookCommands} jev-hook command(s): every session, arm N included, would run them. Remove them for the run`);
    }
    report.settingsFiles.push(entry);
  }
  if (report.overridingEnvironmentNames.length) problems.push(`environment variables the hook reads before the arm's .env are set: ${report.overridingEnvironmentNames.join(', ')} (names only)`);
  if (agents !== null) {
    let expected = null;
    try { expected = JSON.parse(fs.readFileSync(path.join(work, 'routing-exp-arm-R', 'summary.json'), 'utf8')).profileFiles; } catch { problems.push('routing-exp-arm-R/summary.json is missing: prepare arm R first'); }
    let present = [];
    try { present = fs.readdirSync(agents).filter((name) => /^jev4_.*\.md$/.test(name)).sort(); } catch { problems.push(`${agents} cannot be listed`); }
    if (Array.isArray(expected)) {
      const source = path.join(work, 'home-r', '.claude', 'agents');
      const missing = expected.filter((name) => !present.includes(name));
      const extra = present.filter((name) => !expected.includes(name));
      const differing = expected.filter((name) => present.includes(name)).filter((name) => {
        try { return sha(fs.readFileSync(path.join(agents, name))) !== sha(fs.readFileSync(path.join(source, name))); } catch { return true; }
      });
      report.agents = { folder: agents, expected: expected.length, present: present.length, missing, extra, differing };
      if (missing.length) problems.push(`${missing.length} of arm R's profile files are not in ${agents}: a rewrite to such a profile cannot run`);
      if (extra.length) problems.push(`${agents} holds ${extra.length} jev4_* file(s) that are not arm R's: ${extra.join(', ')}`);
      if (differing.length) problems.push(`${differing.length} profile file(s) in ${agents} differ from the ones installed in home-r: ${differing.join(', ')}`);
    }
  }
  return { ok: problems.length === 0, problems, ...report };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = { settings: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, ''), value = argv[i + 1];
    if (!argv[i].startsWith('--') || value === undefined || !path.isAbsolute(value)) { console.error(`${argv[i]} needs an absolute path`); process.exit(64); }
    if (key === 'settings') args.settings.push(value); else if (['work', 'agents'].includes(key) && !(key in args)) args[key] = value; else { console.error(`unknown or repeated option --${key}`); process.exit(64); }
  }
  if (!args.work) { console.error('usage: preflight.mjs --work <dir> [--settings <settings file> ...] [--agents <agents folder>]'); process.exit(64); }
  const result = preflight({ work: fs.realpathSync(args.work), settings: args.settings, agents: args.agents ?? null });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
