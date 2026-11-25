// Offline analysis of candidate retrieval on the DEVELOPMENT set (qa/kernel/data, author gold).
// No network and no API key: the judge is an in-process stub that answers 0 to everything, so the only
// thing observed is WHICH skills the shipped selectSkills() sends to a judge in each retrieval mode.
//
// What this measures: an upper bound. A gold skill that never reaches the judge cannot be selected, so
// "gold recall among judged skills" bounds load recall from above for any judge.
// What it does NOT measure: how well a judge picks the right skill when it is shown 40 skills instead of 8
// (precision, need accuracy, latency, tokens). That needs a live run.
//
// usage: node qa/kernel/dev-retrieval-analysis.mjs [--data dir] [--out file]
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kernelDefaults, validateKernel } from '../../orchestration/src/kernel/kernel.mjs';
import { LocalJudge } from '../../orchestration/src/kernel/judges.mjs';
import { SKILLS_POINT, lexicalCoverage, loadSkillCatalog, localSkillResolver, selectSkills } from '../../orchestration/src/kernel/skills.mjs';
import { options } from '../../orchestration/src/util.mjs';
import { readJsonl } from './lib/data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN_COVERAGE_GRID = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1];
const LEXICAL_K_GRID = [8, 16, 32];
const CHUNK_GRID = [16, 32, 64];

// Grids are stored as arrays so the order in the file is the order of the grid.
const grid = (name, values, run) => Promise.all(values.map(async value => ({ [name]: value, result: await run(value) })));
const ratio = (n, d) => (d > 0 ? n / d : null);
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : null);

/** Stub judge: answers every question with 0. It records nothing but the request count. */
function stubJudge() {
  return {
    async evaluate(state, questions) {
      const answers = {};
      for (const id of Object.keys(questions)) answers[id] = { type: 'noul', noul: 0 };
      return { response: { model: 'offline-stub', answers }, cached: false, latencyMs: 0 };
    },
  };
}

/** One pass of the shipped selectSkills over every task with the given kernel.skills settings. */
async function sweep({ items, gold, catalog, settings, judge = stubJudge() }) {
  const cell = () => ({ tasks: 0, wideTasks: 0, goldSkills: 0, goldReached: 0, goldTasks: 0, goldTasksAllReached: 0, judged: [], requests: [], unavailable: 0, unavailableWithGold: 0 });
  const cells = { overall: cell() };
  for (const item of items) {
    const result = await selectSkills({ task: item.task, catalog, judge, scope: 'dev-retrieval-analysis', config: settings });
    const reached = new Set(result.trace.filter(t => t.stage !== 'retrieval').map(t => t.name));
    const g = gold.get(item.id) ?? [];
    const lang = String(item.lang ?? 'unknown');
    cells[lang] ??= cell();
    for (const c of [cells.overall, cells[lang]]) {
      c.tasks++;
      if (result.retrieval.wide) c.wideTasks++;
      c.judged.push(result.retrieval.judged);
      c.requests.push(result.retrieval.requests);
      c.goldSkills += g.length;
      c.goldReached += g.filter(name => reached.has(name)).length;
      if (g.length) { c.goldTasks++; if (g.every(name => reached.has(name))) c.goldTasksAllReached++; }
      if (result.status === 'unavailable') { c.unavailable++; if (g.length) c.unavailableWithGold++; }
    }
  }
  const pack = c => ({
    tasks: c.tasks, wideTasks: c.wideTasks, wideShare: ratio(c.wideTasks, c.tasks),
    goldSkills: c.goldSkills, goldReached: c.goldReached, goldRecallAmongJudged: ratio(c.goldReached, c.goldSkills),
    goldTasks: c.goldTasks, goldTasksAllReached: c.goldTasksAllReached, taskAllGoldReachedRate: ratio(c.goldTasksAllReached, c.goldTasks),
    meanSkillsJudged: mean(c.judged), meanRequests: mean(c.requests), totalRequests: c.requests.reduce((a, b) => a + b, 0),
    unavailable: c.unavailable, unavailableWithGold: c.unavailableWithGold,
  });
  return Object.fromEntries(Object.keys(cells).sort((a, b) => (a === 'overall' ? -1 : b === 'overall' ? 1 : a < b ? -1 : 1)).map(k => [k, pack(cells[k])]));
}

function gitCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

async function main() {
  const args = options(process.argv.slice(2));
  for (const key of Object.keys(args)) if (!['data', 'out'].includes(key)) throw Object.assign(new Error('UNKNOWN_OPTION'), { code: 'UNKNOWN_OPTION' });
  const dataDir = path.resolve(typeof args.data === 'string' ? args.data : path.join(HERE, 'data'));
  const outFile = path.resolve(typeof args.out === 'string' ? args.out : path.join(HERE, 'results', 'dev-retrieval-offline', 'analysis.json'));

  // The dataset's skills are read through the extra-dir route; the catalog content is the same as via .claude/skills.
  const catalog = await loadSkillCatalog({ project: path.join(dataDir, 'no-such-project'), dirs: [path.join(dataDir, 'skills')] });
  if (!catalog.skills.length) throw Object.assign(new Error('DATA_EMPTY_SKILL_CATALOG'), { code: 'DATA_EMPTY_SKILL_CATALOG' });
  const items = await readJsonl(path.join(dataDir, 'skill-tasks.jsonl'));
  const gold = new Map((await readJsonl(path.join(dataDir, 'skill-tasks.gold.jsonl'))).map(r => [r.id, r.gold]));
  const missing = items.filter(i => !gold.has(i.id)).map(i => i.id);
  if (missing.length) throw Object.assign(new Error('DATA_MISSING_GOLD: ' + missing.join(',')), { code: 'DATA_MISSING_GOLD' });

  const shipped = kernelDefaults().skills;
  const settingsOf = extra => validateKernel({ ...kernelDefaults(), skills: { ...shipped, ...extra } }).skills;
  const run = extra => sweep({ items, gold, catalog, settings: settingsOf(extra) });

  // Distribution of the coverage statistic, the one input of the adaptive rule.
  const signals = items.map(i => ({ lang: String(i.lang ?? 'unknown'), signal: lexicalCoverage(i.task, catalog.skills) }));
  const distribution = {};
  for (const lang of ['overall', ...new Set(signals.map(s => s.lang))].sort((a, b) => (a === 'overall' ? -1 : b === 'overall' ? 1 : a < b ? -1 : 1))) {
    const values = signals.filter(s => lang === 'overall' || s.lang === lang).map(s => s.signal).sort((a, b) => a - b);
    distribution[lang] = {
      tasks: values.length, zero: values.filter(v => v === 0).length, mean: mean(values),
      quantiles: Object.fromEntries([0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map(q => [`p${Math.round(q * 100)}`, quantile(values, q)])),
      below: MIN_COVERAGE_GRID.map(c => ({ minCoverage: c, tasks: values.filter(v => v < c).length })),
    };
  }

  const out = {
    what: 'Offline candidate-retrieval analysis on the development set. Upper bound on recall only: the judge is a stub.',
    notMeasured: [
      'judge precision, need accuracy or calibration when the judge is shown the wide skill list',
      'latency, tokens and cost of the wide requests',
      'anything on a held-out set or a different skill catalog',
    ],
    commit: gitCommit(),
    dataset: {
      dir: path.relative(path.join(HERE, '..', '..'), dataDir), goldSource: 'author (skill-tasks.gold.jsonl)',
      tasks: items.length, byLanguage: Object.fromEntries([...new Set(items.map(i => String(i.lang ?? 'unknown')))].sort().map(l => [l, items.filter(i => String(i.lang ?? 'unknown') === l).length])),
      catalogSkills: catalog.skills.length, goldSkills: [...gold.values()].reduce((a, g) => a + g.length, 0),
    },
    statistic: 'lexicalCoverage(task, catalog.skills) = |distinct task tokens found in the catalog vocabulary| / |distinct task tokens|; 0 for a task with no tokens',
    shippedSettings: shipped,
    lexicalSignal: distribution,
    modes: {
      lexical: await run({ retrieval: 'lexical' }),
      full: await run({ retrieval: 'full' }),
      adaptive: await grid('minCoverage', MIN_COVERAGE_GRID, c => run({ retrieval: 'adaptive', minCoverage: c })),
    },
    sensitivity: {
      // The alternative that needs no new mechanism: a larger lexical top-k in a single request.
      lexicalMaxCandidates: await grid('maxCandidates', LEXICAL_K_GRID, k => run({ retrieval: 'lexical', maxCandidates: k })),
      // chunk only changes how many requests the same judged set is split into.
      fullChunk: await grid('chunk', CHUNK_GRID, c => run({ retrieval: 'full', chunk: c })),
      // A catalog cap below the catalog size: the BM25 top maxJudged are judged, the rest are dropped.
      fullMaxJudged: await grid('maxJudged', [16, 24, 32, 64], m => run({ retrieval: 'full', maxJudged: m })),
    },
    // The no-network judge alone (lexical retrieval): how often it now abstains instead of answering need 0.
    localJudgeAbstention: await grid('minCoverage', MIN_COVERAGE_GRID, c => sweep({
      items, gold, catalog, settings: settingsOf({ retrieval: 'lexical', minCoverage: c }),
      judge: new LocalJudge({ [SKILLS_POINT]: localSkillResolver() }),
    })),
  };

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(out, null, 2) + '\n');

  const pct = x => (x === null ? 'null' : (100 * x).toFixed(1) + '%');
  const fix = x => (x === null ? 'null' : x.toFixed(2));
  const langs = Object.keys(out.modes.lexical);
  const row = (label, r) => `${label.padEnd(16)} wide ${langs.map(l => `${l} ${r[l].wideTasks}/${r[l].tasks}`).join(' ')} | gold reach ${langs.map(l => `${l} ${pct(r[l].goldRecallAmongJudged)} (${r[l].goldReached}/${r[l].goldSkills})`).join(' ')} | judged/task ${fix(r.overall.meanSkillsJudged)} req/task ${fix(r.overall.meanRequests)}`;
  const lines = [
    `Development set: ${items.length} tasks (${Object.entries(out.dataset.byLanguage).map(([l, n]) => `${l} ${n}`).join(', ')}), ${catalog.skills.length} skills, ${out.dataset.goldSkills} gold skills (author gold). No API calls.`,
    `lexicalSignal: ${Object.entries(distribution).map(([l, d]) => `${l} zero ${d.zero}/${d.tasks} p50 ${fix(d.quantiles.p50)} p90 ${fix(d.quantiles.p90)}`).join(' | ')}`,
    row('lexical', out.modes.lexical),
    ...out.modes.adaptive.map(x => row(`adaptive ${x.minCoverage}`, x.result)),
    row('full', out.modes.full),
    ...out.sensitivity.lexicalMaxCandidates.map(x => row(`lexical k=${x.maxCandidates}`, x.result)),
    ...out.sensitivity.fullChunk.map(x => row(`full chunk=${x.chunk}`, x.result)),
    ...out.sensitivity.fullMaxJudged.map(x => row(`full maxJ=${x.maxJudged}`, x.result)),
    ...out.localJudgeAbstention.map(({ minCoverage: c, result: r }) => `local abstain @${c}`.padEnd(20) + langs.map(l => `${l} ${r[l].unavailable}/${r[l].tasks} (needing a skill: ${r[l].unavailableWithGold})`).join(' ')),
    'Upper bound only: this does not measure judge precision when the judge is shown the wide list.',
    `written: ${path.relative(process.cwd(), outFile)}`,
  ];
  console.log(lines.join('\n'));
}

main().catch(e => { console.error(e.code || e.message); process.exitCode = 1; });
