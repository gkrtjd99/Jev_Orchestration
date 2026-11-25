#!/usr/bin/env node
// Structural validation of the skill-routing evaluation set. Offline, no dependencies.
// Usage: node qa/kernel/data/validate-skill-tasks.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_NAME, parseFrontmatter } from '../../../orchestration/src/kernel/skills.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const errors = [];
const fail = message => errors.push(message);

// ---- catalog
const catalog = new Map();
const skillsDir = path.join(here, 'skills');
for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) { fail(`skills/${entry.name}: not a directory`); continue; }
  const file = path.join(skillsDir, entry.name, 'SKILL.md');
  if (!fs.existsSync(file)) { fail(`skills/${entry.name}: SKILL.md missing`); continue; }
  const text = fs.readFileSync(file, 'utf8');
  const meta = parseFrontmatter(text);
  if (!meta) { fail(`skills/${entry.name}: no frontmatter`); continue; }
  if (!SKILL_NAME.test(entry.name)) fail(`skills/${entry.name}: folder name violates SKILL_NAME`);
  if (typeof meta.name !== 'string' || !SKILL_NAME.test(meta.name)) fail(`skills/${entry.name}: bad name`);
  if (meta.name !== entry.name) fail(`skills/${entry.name}: name "${meta.name}" differs from folder`);
  if (typeof meta.description !== 'string' || !meta.description.trim()) fail(`skills/${entry.name}: description missing`);
  else if (meta.description.length > 600) fail(`skills/${entry.name}: description longer than 600 chars`);
  if (catalog.has(meta.name)) fail(`skills/${entry.name}: duplicate name`);
  if (!text.slice(text.indexOf('\n---', 3) + 4).trim()) fail(`skills/${entry.name}: empty body`);
  catalog.set(meta.name, meta.description);
}

// ---- jsonl
function readJsonl(name) {
  const rows = [];
  fs.readFileSync(path.join(here, name), 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line)); } catch (error) { fail(`${name}:${i + 1}: ${error.message}`); }
  });
  return rows;
}
const tasks = readJsonl('skill-tasks.jsonl');
const gold = readJsonl('skill-tasks.gold.jsonl');

const LANGS = new Set(['en', 'ko']);
const CATEGORIES = new Set(['single', 'multi', 'none', 'confusable']);
const taskById = new Map();
for (const t of tasks) {
  if (!/^st-\d{3}$/.test(t.id ?? '')) fail(`task id malformed: ${JSON.stringify(t.id)}`);
  if (taskById.has(t.id)) fail(`duplicate task id ${t.id}`);
  taskById.set(t.id, t);
  if (!LANGS.has(t.lang)) fail(`${t.id}: bad lang`);
  if (!CATEGORIES.has(t.category)) fail(`${t.id}: bad category`);
  if (typeof t.task !== 'string' || !t.task.trim()) fail(`${t.id}: empty task`);
  const extra = Object.keys(t).filter(k => !['id', 'lang', 'category', 'task'].includes(k));
  if (extra.length) fail(`${t.id}: unexpected keys in task file (labels must not leak): ${extra}`);
  const hangul = /[가-힣]/.test(t.task);
  if (t.lang === 'ko' && !hangul) fail(`${t.id}: lang ko without Hangul`);
  if (t.lang === 'en' && hangul) fail(`${t.id}: lang en with Hangul`);
}
const texts = new Set(tasks.map(t => t.task));
if (texts.size !== tasks.length) fail('duplicate task text');

const goldIds = new Set();
const WANT = { none: 0, single: 1, confusable: 1, multi: 2 };
const goldUse = new Map();
for (const g of gold) {
  if (goldIds.has(g.id)) fail(`duplicate gold id ${g.id}`);
  goldIds.add(g.id);
  const t = taskById.get(g.id);
  if (!t) { fail(`gold ${g.id}: no such task`); continue; }
  if (!Array.isArray(g.gold)) { fail(`gold ${g.id}: gold is not an array`); continue; }
  if (new Set(g.gold).size !== g.gold.length) fail(`gold ${g.id}: repeated skill`);
  for (const name of g.gold) {
    if (!catalog.has(name)) fail(`gold ${g.id}: unknown skill ${name}`);
    goldUse.set(name, (goldUse.get(name) ?? 0) + 1);
  }
  if (g.gold.length !== WANT[t.category]) fail(`gold ${g.id}: ${t.category} expects ${WANT[t.category]} skill(s), got ${g.gold.length}`);
  if (typeof g.rationale !== 'string' || !g.rationale.trim()) fail(`gold ${g.id}: rationale missing`);
}
for (const id of taskById.keys()) if (!goldIds.has(id)) fail(`task ${id}: no gold row`);

// ---- summary
const count = (rows, key) => Object.fromEntries([...rows.reduce((m, r) => m.set(r[key], (m.get(r[key]) ?? 0) + 1), new Map())].sort());
const cross = {};
for (const t of tasks) cross[`${t.category}/${t.lang}`] = (cross[`${t.category}/${t.lang}`] ?? 0) + 1;
const summary = {
  skills: catalog.size,
  tasks: tasks.length,
  goldRows: gold.length,
  byCategory: count(tasks, 'category'),
  byLang: count(tasks, 'lang'),
  byCategoryLang: Object.fromEntries(Object.entries(cross).sort()),
  skillsNeverGold: [...catalog.keys()].filter(n => !goldUse.has(n)).sort(),
  goldUse: Object.fromEntries([...goldUse].sort()),
  errors: errors.length,
};
console.log(JSON.stringify(summary, null, 2));
if (errors.length) { for (const e of errors) console.error(`ERROR ${e}`); process.exit(1); }
