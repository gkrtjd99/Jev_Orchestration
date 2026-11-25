#!/usr/bin/env node
// Paired table of two analyze.mjs outputs.   node compare.mjs --a <armA.json> --b <armB.json> [--json]
// Descriptive only: one run per arm, six pairs. It prints counts and differences, no test statistic.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const show = (value) => (value === null || value === undefined ? '-' : value === true ? 'yes' : value === false ? 'no' : String(value));
const seconds = (ms) => (typeof ms === 'number' ? (ms / 1000).toFixed(1) : null);
const ratio = (c) => (c ? `${c.yes}/${c.of}${c.measured !== c.of ? ` (measured ${c.measured})` : ''}` : '-');
const sum = (t) => (t ? `${show(t.sum)}${t.measured !== t.of ? ` (measured ${t.measured}/${t.of})` : ''}` : '-');

export function compare(a, b) {
  const ids = a.tasks.map((task) => task.id);
  const bById = new Map(b.tasks.map((task) => [task.id, task]));
  const problems = [];
  if (ids.join(',') !== b.tasks.map((task) => task.id).join(',')) problems.push('the two files do not list the same tasks in the same order');
  const pairs = a.tasks.map((ta) => {
    const tb = bById.get(ta.id) ?? null;
    const side = (t) => (t ? {
      done: t.check?.done ?? null,
      convention: t.check?.convention ?? null,
      injected: t.hook?.injected ?? null,
      injectedLoad: t.hook?.load ?? null,
      targetSkillLoaded: t.subagent?.targetSkillLoaded ?? null,
      loadedSkills: t.subagent ? t.subagent.loadedSkills.map((entry) => entry.name) : null,
      toolCalls: t.subagent?.toolCalls ?? null,
      tokens: t.subagent?.tokens?.total ?? null,
      wallMs: t.subagent?.wallMs ?? null,
      outOfScopeWrites: t.subagent?.outOfScopeWrites ?? null,
      warnings: t.warnings?.length ?? 0,
    } : null);
    return { id: ta.id, kind: ta.kind, lang: ta.lang, targetSkill: ta.targetSkill, a: side(ta), b: side(tb) };
  });
  const skill = pairs.filter((pair) => pair.kind === 'skill');
  const both = skill.filter((pair) => typeof pair.a?.convention === 'boolean' && typeof pair.b?.convention === 'boolean');
  const paired = {
    pairsMeasured: both.length,
    bothPass: both.filter((pair) => pair.a.convention && pair.b.convention).length,
    onlyA: both.filter((pair) => pair.a.convention && !pair.b.convention).length,
    onlyB: both.filter((pair) => !pair.a.convention && pair.b.convention).length,
    neither: both.filter((pair) => !pair.a.convention && !pair.b.convention).length,
  };
  return { arms: { a: a.arm, b: b.arm }, pairs, paired, totals: { a: a.totals, b: b.totals }, warnings: { a: a.warnings, b: b.warnings }, problems };
}

export function render(result) {
  const { arms, pairs, paired, totals } = result;
  const header = ['task', 'kind', 'lang', 'target skill', `conv ${arms.a}`, `conv ${arms.b}`, `done ${arms.a}`, `done ${arms.b}`,
    `loaded ${arms.a}`, `loaded ${arms.b}`, `inject ${arms.a}`, `inject ${arms.b}`, `tools ${arms.a}`, `tools ${arms.b}`,
    `tokens ${arms.a}`, `tokens ${arms.b}`, `wall s ${arms.a}`, `wall s ${arms.b}`];
  const rows = pairs.map((pair) => [pair.id, pair.kind, pair.lang, pair.targetSkill ?? '-',
    show(pair.a?.convention), show(pair.b?.convention), show(pair.a?.done), show(pair.b?.done),
    show(pair.a?.targetSkillLoaded), show(pair.b?.targetSkillLoaded), show(pair.a?.injected), show(pair.b?.injected),
    show(pair.a?.toolCalls), show(pair.b?.toolCalls), show(pair.a?.tokens), show(pair.b?.tokens),
    show(seconds(pair.a?.wallMs)), show(seconds(pair.b?.wallMs))]);
  const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line), ''];
  const both = (label, pick, format) => out.push(`${label.padEnd(44)} ${arms.a}: ${format(pick(totals.a))}   ${arms.b}: ${format(pick(totals.b))}`);
  out.push('Totals ("-" or "measured n" means a value could not be read; it is not counted as a failure or a zero)');
  both('PRIMARY convention passed, skill tasks', (t) => t?.primary_conventionPassed, ratio);
  both('skill tasks done', (t) => t?.skillTasksDone, ratio);
  both('controls done', (t) => t?.controlsDone, ratio);
  both('target skill loaded by the subagent', (t) => t?.targetSkillLoaded, ratio);
  both('hook injected a block, skill tasks', (t) => t?.injectedOnSkillTasks, ratio);
  both('hook injected a block, controls (false inj.)', (t) => t?.injectedOnControls, ratio);
  both('subagent tool calls, all tasks', (t) => t?.subagentToolCalls, sum);
  both('subagent tokens, all tasks', (t) => t?.subagentTokens, sum);
  both('subagent wall time ms, all tasks', (t) => t?.subagentWallMs, sum);
  out.push('', `Paired convention outcome over ${paired.pairsMeasured} measured pair(s): both pass ${paired.bothPass}, only ${arms.a} ${paired.onlyA}, only ${arms.b} ${paired.onlyB}, neither ${paired.neither}`);
  const scoped = pairs.flatMap((pair) => ['a', 'b'].filter((side) => pair[side]?.outOfScopeWrites?.length).map((side) => `${pair.id} ${arms[side]}: ${pair[side].outOfScopeWrites.join(', ')}`));
  if (scoped.length) out.push('', 'Writes outside the task\'s own paths:', ...scoped.map((entry) => `  ${entry}`));
  const noted = pairs.flatMap((pair) => ['a', 'b'].filter((side) => pair[side]?.warnings).map((side) => `${pair.id} ${arms[side]}: ${pair[side].warnings}`));
  out.push('', `Warnings: ${arms.a} ${result.warnings.a?.length ?? 0} run-level, ${arms.b} ${result.warnings.b?.length ?? 0} run-level${noted.length ? `; per task: ${noted.join('; ')}` : ''}. Read them in the arm files.`);
  for (const problem of result.problems) out.push(`PROBLEM: ${problem}`);
  out.push('Descriptive only: one run per arm and six pairs. No significance claim; see PROTOCOL.md.');
  return out.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  if (!value('--a') || !value('--b')) {
    console.error('usage: compare.mjs --a <armA.json> --b <armB.json> [--json]');
    process.exit(64);
  }
  try {
    const result = compare(JSON.parse(readFileSync(value('--a'), 'utf8')), JSON.parse(readFileSync(value('--b'), 'utf8')));
    process.stdout.write(argv.includes('--json') ? JSON.stringify(result, null, 2) + '\n' : render(result));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
