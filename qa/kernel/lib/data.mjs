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

const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };

/** A label file name given on the command line: relative to the data directory and never outside it. */
export function labelPath(rel) {
  const clean = typeof rel === 'string' ? path.posix.normalize(rel.trim().split(path.sep).join('/')) : '';
  if (!clean || clean === '.' || path.isAbsolute(clean) || clean.split('/').includes('..')) throw fail('DATA_INVALID_LABEL_PATH', String(rel));
  return clean;
}

/**
 * Returns { items, gold: { author: Map, blind: Map|null, consensus: Map|null }, labels, files, issues }.
 * author is always <stem>.gold.jsonl over all items. consensus holds only the ids on which label file A and
 * label file B agree exactly (skill sets as sets; outcome equal); blind is label file B. By default A is the
 * author gold, so consensus is "author and the second labeler agree".
 */
async function loadSuite(dir, stem, { parse, agree, merge, limit, labels = null, secondDefaults }) {
  const file = name => path.join(dir, name);
  const authorFile = `${stem}.gold.jsonl`;
  let items = await readJsonl(file(`${stem}.jsonl`));
  byId(items, `${stem}.jsonl`);
  if (Number.isInteger(limit) && limit > 0) items = items.slice(0, limit);
  const authorRows = byId(await readJsonl(file(authorFile)), authorFile);

  let aFile = authorFile, bFile = null;
  if (labels) {
    if (!Array.isArray(labels) || labels.length !== 2) throw fail('DATA_INVALID_LABEL_PATH', 'two label files are required');
    [aFile, bFile] = labels.map(labelPath);
    if (aFile === bFile) throw fail('DATA_INVALID_LABEL_PATH', 'the two label files are the same file');
  } else {
    for (const name of secondDefaults) if (await exists(file(name))) { bFile = name; break; }
  }
  // Named explicitly, a label file must exist; only the default second file is optional.
  const aRows = aFile === authorFile ? authorRows : byId(await readJsonl(file(aFile)), aFile);
  const bRows = bFile ? byId(await readJsonl(file(bFile)), bFile) : null;

  const author = new Map(), blind = bRows ? new Map() : null, consensus = bRows ? new Map() : null;
  const labelA = aFile === authorFile ? author : new Map();
  const issues = { missingAuthorGold: [], missingBlindGold: [], missingLabelA: [] };
  for (const item of items) {
    const row = authorRows.get(item.id);
    if (!row) issues.missingAuthorGold.push(item.id); else author.set(item.id, parse(row, authorFile));
    if (labelA !== author) {
      const a = aRows.get(item.id);
      if (!a) issues.missingLabelA.push(item.id); else labelA.set(item.id, parse(a, aFile));
    }
    if (!bRows) continue;
    const b = bRows.get(item.id);
    if (!b) { issues.missingBlindGold.push(item.id); continue; }
    const bg = parse(b, bFile);
    blind.set(item.id, bg);
    const ag = labelA.get(item.id);
    if (ag !== undefined && agree(ag, bg)) consensus.set(item.id, merge(ag, bg));
  }
  return {
    items, gold: { author, blind, consensus }, labelA, issues,
    labels: { author: authorFile, a: aFile, b: bFile },
    // Every data file this suite read, relative to the data directory (used by the hold-out check).
    files: [...new Set([`${stem}.jsonl`, authorFile, aFile, ...(bFile ? [bFile] : [])])],
  };
}

export async function loadSkillSuite(dir, { limit, labels } = {}) {
  const suite = await loadSuite(dir, 'skill-tasks', {
    parse: skillSet, agree: setEqual, merge: a => a, limit, labels,
    // The second labeling pass (no category hints) is preferred when it exists.
    secondDefaults: ['relabel/skill-tasks.blind2.jsonl', 'skill-tasks.blind.jsonl'],
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
    limit, secondDefaults: ['supervisor-reports.blind.jsonl'],
  });
  for (const item of suite.items) {
    if (typeof item.report !== 'string') throw fail('DATA_INVALID_REPORT', item.id);
  }
  return suite;
}

export function skillAgreement({ items, gold, labelA = gold.author, labels = null }, catalogNames) {
  const out = {
    // Which two files the agreement and the consensus subset are computed from (a, b), relative to the data dir.
    labelFiles: labels,
    items: items.length, authorLabeled: gold.author.size, blindLabeled: gold.blind ? gold.blind.size : null,
    consensus: gold.consensus ? gold.consensus.size : null, consensusShareOfItems: null, exactSetMatchRate: null, anySkillKappa: null,
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
  const both = items.filter(i => labelA.has(i.id) && gold.blind.has(i.id));
  out.bothLabeled = both.length;
  out.exactSetMatchRate = ratio(gold.consensus.size, both.length);
  out.anySkillKappa = cohenKappa(both.map(i => labelA.get(i.id).size > 0), both.map(i => gold.blind.get(i.id).size > 0));
  // Share of ALL items that are in the consensus subset (items missing a label count as not agreed).
  out.consensusShareOfItems = ratio(gold.consensus.size, items.length);
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
