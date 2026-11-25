#!/usr/bin/env node
// Generates main-prompt.txt from tasks.json. `--check` exits 1 when the committed file is out of date.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { tasks } = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
  const text = buildMainPrompt(tasks);
  const target = join(here, 'main-prompt.txt');
  if (process.argv.includes('--check')) {
    let current = null;
    try { current = readFileSync(target, 'utf8'); } catch { /* missing */ }
    if (current !== text) { console.error('main-prompt.txt is out of date'); process.exit(1); }
    console.log('main-prompt.txt matches tasks.json');
  } else {
    writeFileSync(target, text);
    console.log(`wrote ${target} (${tasks.length} tasks)`);
  }
}
