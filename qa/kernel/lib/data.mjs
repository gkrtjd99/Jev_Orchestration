// Dataset loading, gold handling (author / blind / consensus) and inter-labeler agreement.
import fs from 'node:fs/promises';
import path from 'node:path';
import { cohenKappa, mean, ratio, setEqual } from './stats.mjs';

export const OUTCOMES = ['complete', 'retry', 'replan', 'escalate'];

function fail(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  return e;
}

export async function readJsonl(file, { optional = false } = {}) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT' && optional) return null; throw fail('DATA_FILE_MISSING', file); }
  const rows = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line)); } catch { throw fail('DATA_INVALID_JSONL', `${file}:${i + 1}`); }
  });
  return rows;
}

const byId = (rows, file) => {
  const map = new Map();
  for (const row of rows) {
    if (typeof row?.id !== 'string' || !row.id) throw fail('DATA_ROW_WITHOUT_ID', file);
    if (map.has(row.id)) throw fail('DATA_DUPLICATE_ID', `${file}: ${row.id}`);
    map.set(row.id, row);
  }
  return map;
};

const skillSet = (row, file) => {
  if (!Array.isArray(row.gold) || !row.gold.every(x => typeof x === 'string')) throw fail('DATA_INVALID_SKILL_GOLD', `${file}: ${row.id}`);
  return new Set(row.gold);
};

const supervisorGold = (row, file) => {
  if (!OUTCOMES.includes(row.gold)) throw fail('DATA_INVALID_OUTCOME_GOLD', `${file}: ${row.id}`);
  const evidence = Number.isInteger(row.evidence) && row.evidence >= 0 && row.evidence <= 2 ? row.evidence : null;
  return { outcome: row.gold, evidence };
};

/**
 * Returns { items, gold: { author: Map, blind: Map|null, consensus: Map|null }, issues }.
 * consensus holds only ids where both labelers agree exactly (skill sets as sets; outcome equal).
 */
async function loadSuite(dir, stem, { parse, agree, merge, limit }) {
  const file = name => path.join(dir, name);
  let items = await readJsonl(file(`${stem}.jsonl`));
  byId(items, `${stem}.jsonl`);
  if (Number.isInteger(limit) && limit > 0) items = items.slice(0, limit);
  const authorRows = byId(await readJsonl(file(`${stem}.gold.jsonl`)), `${stem}.gold.jsonl`);
  const blindRaw = await readJsonl(file(`${stem}.blind.jsonl`), { optional: true });
  const blindRows = blindRaw ? byId(blindRaw, `${stem}.blind.jsonl`) : null;
  const author = new Map(), blind = blindRows ? new Map() : null, consensus = blindRows ? new Map() : null;
  const issues = { missingAuthorGold: [], missingBlindGold: [] };
  for (const item of items) {
    const a = authorRows.get(item.id);
    if (!a) { issues.missingAuthorGold.push(item.id); continue; }
    const ag = parse(a, `${stem}.gold.jsonl`);
    author.set(item.id, ag);
    if (!blindRows) continue;
    const b = blindRows.get(item.id);
    if (!b) { issues.missingBlindGold.push(item.id); continue; }
    const bg = parse(b, `${stem}.blind.jsonl`);
    blind.set(item.id, bg);
    if (agree(ag, bg)) consensus.set(item.id, merge(ag, bg));
  }
  return { items, gold: { author, blind, consensus }, issues };
}

export async function loadSkillSuite(dir, { limit } = {}) {
  const suite = await loadSuite(dir, 'skill-tasks', {
    parse: skillSet, agree: setEqual, merge: a => a, limit,
  });
  for (const item of suite.items) {
    if (typeof item.task !== 'string' || !item.task.trim()) throw fail('DATA_INVALID_TASK', item.id);
  }
  return suite;
}

export async function loadSupervisorSuite(dir, { limit } = {}) {
  const suite = await loadSuite(dir, 'supervisor-reports', {
    parse: supervisorGold,
    agree: (a, b) => a.outcome === b.outcome,
    // The consensus evidence level exists only where both labelers also agree on it.
    merge: (a, b) => ({ outcome: a.outcome, evidence: a.evidence !== null && a.evidence === b.evidence ? a.evidence : null }),
    limit,
  });
  for (const item of suite.items) {
    if (typeof item.report !== 'string') throw fail('DATA_INVALID_REPORT', item.id);
  }
  return suite;
}

export function skillAgreement({ items, gold }, catalogNames) {
  const out = {
    items: items.length, authorLabeled: gold.author.size, blindLabeled: gold.blind ? gold.blind.size : null,
    consensus: gold.consensus ? gold.consensus.size : null, exactSetMatchRate: null, anySkillKappa: null,
    authorNoneTasks: [...gold.author.values()].filter(s => s.size === 0).length,
    goldNamesNotInCatalog: { author: [], blind: [] },
  };
  for (const [who, map] of [['author', gold.author], ['blind', gold.blind]]) {
    if (!map) continue;
    const unknown = new Set();
    for (const set of map.values()) for (const name of set) if (!catalogNames.has(name)) unknown.add(name);
    out.goldNamesNotInCatalog[who] = [...unknown].sort();
  }
  if (!gold.blind) return out;
  const both = items.filter(i => gold.author.has(i.id) && gold.blind.has(i.id));
  out.bothLabeled = both.length;
  out.exactSetMatchRate = ratio(gold.consensus.size, both.length);
  out.anySkillKappa = cohenKappa(both.map(i => gold.author.get(i.id).size > 0), both.map(i => gold.blind.get(i.id).size > 0));
  return out;
}

export function supervisorAgreement({ items, gold }) {
  const out = {
    items: items.length, authorLabeled: gold.author.size, blindLabeled: gold.blind ? gold.blind.size : null,
    consensus: gold.consensus ? gold.consensus.size : null, outcomeExactRate: null, outcomeKappa: null,
    evidenceExactRate: null, evidenceMeanAbsDiff: null,
    authorOutcomeCounts: Object.fromEntries(OUTCOMES.map(o => [o, [...gold.author.values()].filter(g => g.outcome === o).length])),
  };
  if (!gold.blind) return out;
  const both = items.filter(i => gold.author.has(i.id) && gold.blind.has(i.id));
  out.bothLabeled = both.length;
  out.outcomeExactRate = ratio(gold.consensus.size, both.length);
  out.outcomeKappa = cohenKappa(both.map(i => gold.author.get(i.id).outcome), both.map(i => gold.blind.get(i.id).outcome));
  const ev = both.map(i => [gold.author.get(i.id).evidence, gold.blind.get(i.id).evidence]).filter(([a, b]) => a !== null && b !== null);
  out.evidenceBothLabeled = ev.length;
  out.evidenceExactRate = ratio(ev.filter(([a, b]) => a === b).length, ev.length);
  out.evidenceMeanAbsDiff = mean(ev.map(([a, b]) => Math.abs(a - b)));
  return out;
}
