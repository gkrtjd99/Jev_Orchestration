#!/usr/bin/env node
// Puts the hooks of a DISPOSABLE install into one arm's project copy as project-level hooks.
//   node project-hooks.mjs --work <dir> --home <disposable home below work> --project <project copy below work>
// Reads  <home>/.claude/settings.json (written by install.mjs --home <home>)
// Writes <project>/.claude/settings.json = { "hooks": ... } and nothing else. Both paths must be below --work, and
// every hook command must point into that same disposable home, so a real ~/.claude can be neither source nor target.
// Run it AFTER the last install.mjs run for that project: the installer refuses a project that already carries
// these hooks (COMPETING_PROJECT_JEV_HOOKS_REQUIRE_MIGRATION).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (message) => { console.error(message); process.exit(2); };
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const key of ['work', 'home', 'project']) if (typeof args[key] !== 'string' || !path.isAbsolute(args[key])) fail(`--${key} must be an absolute path`);
const real = (dir) => { try { return fs.realpathSync(dir); } catch { return fail(`${dir} does not exist`); } };
const below = (base, target) => { const rel = path.relative(base, target); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const work = real(args.work), home = real(args.home), project = real(args.project);
const realHome = real(os.homedir());
if (work === realHome || below(work, realHome)) fail('--work must not be the home directory or a folder that contains it');
if (!below(work, home) || !below(work, project)) fail('--home and --project must be below --work');
if (home === realHome) fail('--home must be a disposable home');

const source = path.join(home, '.claude', 'settings.json');
let settings;
try { settings = JSON.parse(fs.readFileSync(source, 'utf8')); } catch { fail(`cannot read ${source}: run install.mjs --home ${home} first`); }
const hooks = settings.hooks;
if (hooks === null || typeof hooks !== 'object' || Object.keys(hooks).length === 0) fail(`${source} has no hooks`);
const commands = Object.values(hooks).flat().flatMap((group) => (group.hooks ?? []).map((hook) => hook.command));
const entry = path.join(home, '.local', 'share', 'jev-hooks');
const config = path.join(home, '.config', 'jev-hooks', 'config.json');
if (!commands.length || !commands.every((command) => typeof command === 'string' && command.includes(entry) && command.includes(config))) {
  fail('a hook command does not point into the disposable home: nothing written');
}
const target = path.join(project, '.claude', 'settings.json');
const text = JSON.stringify({ hooks }, null, 2) + '\n';
let existing = null;
try { if (fs.lstatSync(target).isSymbolicLink()) fail(`${target} is a link`); existing = fs.readFileSync(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing !== null && existing !== text) fail(`${target} already exists with other content: nothing written`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, text);
console.log(JSON.stringify({ written: target, events: Object.keys(hooks), commands: new Set(commands).size, hookRuntime: entry, config }, null, 2));
