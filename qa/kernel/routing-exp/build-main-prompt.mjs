#!/usr/bin/env node
// Generates main-prompt.txt, the ONE prompt each arm's Main session gets, from tasks.json.
//   node build-main-prompt.mjs           writes main-prompt.txt
//   node build-main-prompt.mjs --check   exits 1 when the committed file is out of date or says something it must not
// The prompt carries the task texts and the delegation rules only. It must not tell a session what is being
// measured: no difficulty tier, nothing about hooks, routing, models, checks or evaluation.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const FORBIDDEN = /difficult|\bhard\b|\broutine\b|\bmoderate\b|\bhooks?\b|rout(?:e|ed|ing|er)\b|\bmodels?\b|checker|\bchecks?\b|\bchecked\b|evaluat|experiment|benchmark|\bgrad(?:e|ed|ing)\b|\barms?\b|\bjev|\btier (?:is|of the task)|난이도|라우팅|평가|채점|실험/i;

export function buildMainPrompt(tasks) {
  const n = tasks.length;
  const lines = [
    `You are coordinating ${n} independent tasks in this project. Do none of the work yourself: do not read, search, edit or run anything in the project.`,
    '',
    'For each task below, in the order given and strictly one at a time:',
    '',
    '1. Make exactly one Agent tool call with subagent_type "general-purpose". The prompt of that call is the task text exactly as written between the <<< and >>> lines, character for character. Add nothing before or after it: no context, no hints, no file lists, no advice, no instructions of your own. The <<< and >>> lines are not part of the task text.',
    '2. Wait for that agent\'s report before starting the next task. Never run two agents at once. Do not retry, re-delegate, follow up on or fix a task, whatever its report says.',
    '',
    `After the report for task ${n} has arrived, reply with one line per task (the task number and a one-sentence summary of what the agent reported) and stop.`,
  ];
  tasks.forEach((task, index) => {
    lines.push('', `Task ${index + 1}`, '<<<', task.text, '>>>');
  });
  return lines.join('\n') + '\n';
}

/** Problems with a task list or its prompt; empty when everything is as pre-registered. */
export function problems(tasks, text) {
  const found = [];
  if (tasks.length !== 12) found.push(`expected 12 tasks, found ${tasks.length}`);
  const tiers = {}, langs = {};
  for (const task of tasks) {
    tiers[task.difficulty] = (tiers[task.difficulty] ?? 0) + 1;
    langs[task.lang] = (langs[task.lang] ?? 0) + 1;
    if (task.text.includes('<<<') || task.text.includes('>>>') || task.text.includes('\n')) found.push(`${task.id}: text contains a delimiter or a line break`);
    if (!Array.isArray(task.allowedPaths) || task.allowedPaths.length === 0) found.push(`${task.id}: allowedPaths missing`);
    if (text.split(`\n<<<\n${task.text}\n>>>\n`).length !== 2) found.push(`${task.id}: text is not in the prompt exactly once`);
  }
  for (const tier of ['routine', 'moderate', 'hard']) if (tiers[tier] !== 4) found.push(`expected 4 ${tier} tasks, found ${tiers[tier] ?? 0}`);
  if (langs.en !== 6 || langs.ko !== 6) found.push(`expected 6 en and 6 ko tasks, found ${JSON.stringify(langs)}`);
  const hit = FORBIDDEN.exec(text);
  if (hit) found.push(`the prompt contains a forbidden word: "${hit[0]}" at offset ${hit.index}`);
  for (const key of ['"difficulty"', '"lang"', 'allowedPaths', ...tasks.map((task) => task.id)]) if (text.includes(key)) found.push(`the prompt contains ${key}`);
  return found;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { tasks } = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
  const text = buildMainPrompt(tasks);
  const target = join(here, 'main-prompt.txt');
  const found = problems(tasks, text);
  if (found.length) { console.error(found.join('\n')); process.exit(1); }
  if (process.argv.includes('--check')) {
    let current = null;
    try { current = readFileSync(target, 'utf8'); } catch { /* missing */ }
    if (current !== text) { console.error('main-prompt.txt is out of date'); process.exit(1); }
    console.log(`main-prompt.txt matches tasks.json (${tasks.length} tasks, ${text.length} characters, no forbidden word)`);
  } else {
    writeFileSync(target, text);
    console.log(`wrote ${target} (${tasks.length} tasks)`);
  }
}
