#!/usr/bin/env node
// Prints how separable the six target skills are from the 54 distractors by surface features of the
// description (length, language, folder mentions). Read-only.   node catalog-stats.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'template', '.claude', 'skills');
const { tasks } = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8'));
const targets = new Set(tasks.map((task) => task.targetSkill).filter(Boolean));
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const skills = readdirSync(root).sort().map((dir) => {
  const text = readFileSync(join(root, dir, 'SKILL.md'), 'utf8');
  const name = /^name: (.+)$/m.exec(text)?.[1] ?? null;
  const description = JSON.parse(/^description: (.+)$/m.exec(text)[1]);
  return { dir, name, description, korean: /[가-힣]/.test(description), target: targets.has(dir) };
});
const problems = [];
for (const skill of skills) {
  if (skill.name !== skill.dir || !NAME.test(skill.dir)) problems.push(`bad name: ${skill.dir}`);
  if (/\bnot for\b|전용|아니라/i.test(skill.description)) problems.push(`self-excluding description: ${skill.dir}`);
}
const stats = (list) => {
  const lengths = list.map((skill) => [...skill.description].length).sort((a, b) => a - b);
  return lengths.length ? `n=${lengths.length} min=${lengths[0]} median=${lengths[Math.floor(lengths.length / 2)]} max=${lengths[lengths.length - 1]}` : 'n=0';
};
const group = (target, korean) => skills.filter((skill) => skill.target === target && skill.korean === korean);
console.log(`skills: ${skills.length} (targets ${skills.filter((s) => s.target).length}, distractors ${skills.filter((s) => !s.target).length}); Korean descriptions: ${skills.filter((s) => s.korean).length}`);
console.log(`description length, English targets:     ${stats(group(true, false))}`);
console.log(`description length, English distractors: ${stats(group(false, false))}`);
console.log(`description length, Korean targets:      ${stats(group(true, true))}`);
console.log(`description length, Korean distractors:  ${stats(group(false, true))}`);
console.log(`sentences per description (count of ". " inside): targets ${skills.filter((s) => s.target && /\. /.test(s.description)).length}, distractors ${skills.filter((s) => !s.target && /\. /.test(s.description)).length}`);
const mentions = (re) => `targets ${skills.filter((s) => s.target && re.test(s.description)).length}/6, distractors ${skills.filter((s) => !s.target && re.test(s.description)).length}/54`;
console.log(`descriptions naming a src/ path: ${mentions(/\bsrc\//)}`);
console.log(`descriptions naming parceldesk:  ${mentions(/parceldesk/)}`);
for (const folder of ['src/reports', 'src/config', 'src/jobs', 'src/http', 'src/notify', 'src/']) {
  const hits = skills.filter((skill) => skill.description.includes(folder));
  console.log(`  ${folder.padEnd(12)} in ${hits.length} description(s): ${hits.map((skill) => (skill.target ? `${skill.dir}*` : skill.dir)).join(', ')}`);
}
if (skills.length !== 60 || skills.filter((s) => s.target).length !== 6) problems.push('expected 60 skills with 6 targets');
for (const problem of problems) console.log(`PROBLEM: ${problem}`);
console.log(problems.length ? 'CATALOG CHECK FAILED' : 'catalog check ok (* marks a target)');
process.exit(problems.length ? 1 : 0);
