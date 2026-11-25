#!/usr/bin/env node
// Evaluation runner for the decision kernel (skill routing and supervisor).
// It drives the shipped product code under orchestration/src against the synthetic datasets in qa/kernel/data.
//
//   node qa/kernel/run-eval.mjs --run-id <id> [--arms jev,openai,local,chain] [--retrieval lexical,adaptive,full]
//        [--data-dir dir] [--gold author|consensus] [--labels fileA,fileB] [--limit n] [--suite skills|supervisor|all]
//        [--spend-holdout "<reason>"]
//
// A data directory that contains HOLDOUT.json is a held-out set: hashes are verified first, the run is refused
// without --spend-holdout, it is recorded in HOLDOUT_LEDGER.jsonl before the first request, and the output
// carries aggregate metrics only (no per-item files, no sweeps).
//
// See qa/kernel/README.md for every option and the meaning of each metric.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSkillCatalog, DEFAULT_RETRIEVAL } from '../../orchestration/src/kernel/skills.mjs';
import { VERSION } from '../../orchestration/src/util.mjs';
import { ARMS, RETRIEVAL_MODES, armKey } from './lib/harness.mjs';
import { loadSkillSuite, loadSupervisorSuite, skillAgreement, supervisorAgreement, labelPath } from './lib/data.mjs';
import { readHoldout, verifyHoldout, appendLedger, readLedger, suppressSweeps, SUPPRESSED, LEDGER_FILE } from './lib/holdout.mjs';
import { runSkillsArm, skillsMetrics, retrievalAnalysis } from './lib/skills-eval.mjs';
import { runSupervisorArm, supervisorMetrics } from './lib/supervisor-eval.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SUITES = ['skills', 'supervisor'];

function fail(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  return e;
}

export function parseArgs(argv) {
  const flags = new Set(['force', 'no-retry', 'help']);
  const known = new Set(['run-id', 'arms', 'retrieval', 'limit', 'suite', 'data', 'data-dir', 'gold', 'labels', 'spend-holdout', 'out',
    'timeout-ms', 'concurrency', 'openai-model', 'max-requests', ...flags]);
  const raw = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw fail('QA_UNEXPECTED_ARGUMENT', arg);
    const key = arg.slice(2);
    if (!known.has(key)) throw fail('QA_UNKNOWN_OPTION', arg);
    if (flags.has(key)) { raw[key] = true; continue; }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw fail('QA_OPTION_NEEDS_VALUE', arg);
    if (Object.hasOwn(raw, key)) throw fail('QA_INVALID_OPTION', `${arg} given twice`);
    raw[key] = argv[++i];
  }
  const int = (key, fallback, min, max) => {
    if (raw[key] === undefined) return fallback;
    const n = Number(raw[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw fail('QA_INVALID_OPTION', `--${key}`);
    return n;
  };
  const arms = (raw.arms ?? 'jev,openai,local,chain').split(',').map(s => s.trim()).filter(Boolean);
  if (!arms.length || arms.some(a => !Object.hasOwn(ARMS, a)) || new Set(arms).size !== arms.length) throw fail('QA_INVALID_OPTION', '--arms');
  const suite = raw.suite ?? 'all';
  if (!['all', ...SUITES].includes(suite)) throw fail('QA_INVALID_OPTION', '--suite');
  // --retrieval crosses every skills arm with each listed mode. Without it the arms run once, with the
  // product's default mode, under their plain names (the behaviour before retrieval modes existed).
  let retrieval = null;
  if (raw.retrieval !== undefined) {
    retrieval = raw.retrieval.split(',').map(s => s.trim()).filter(Boolean);
    if (!retrieval.length || retrieval.some(m => !RETRIEVAL_MODES.includes(m)) || new Set(retrieval).size !== retrieval.length) throw fail('QA_INVALID_OPTION', '--retrieval');
  }
  if (raw.gold !== undefined && !['author', 'consensus'].includes(raw.gold)) throw fail('QA_INVALID_OPTION', '--gold');
  let labels = null;
  if (raw.labels !== undefined) {
    const parts = raw.labels.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length !== 2) throw fail('QA_INVALID_OPTION', '--labels needs exactly two files');
    try { labels = parts.map(labelPath); } catch { throw fail('QA_INVALID_OPTION', '--labels'); }
    if (labels[0] === labels[1]) throw fail('QA_INVALID_OPTION', '--labels names the same file twice');
  }
  // --data is the older spelling of --data-dir.
  if (raw.data !== undefined && raw['data-dir'] !== undefined) throw fail('QA_INVALID_OPTION', '--data and --data-dir');
  const spend = raw['spend-holdout'];
  if (spend !== undefined && (!spend.trim() || spend.length > 500 || /[\u0000-\u001f]/.test(spend))) throw fail('QA_INVALID_OPTION', '--spend-holdout');
  return {
    help: raw.help === true, runId: raw['run-id'], arms, suites: suite === 'all' ? SUITES : [suite],
    retrieval, gold: raw.gold ?? null, labels, spendHoldout: spend === undefined ? null : spend.trim(),
    limit: int('limit', null, 1, 1e6), dataDir: path.resolve(raw['data-dir'] ?? raw.data ?? path.join(HERE, 'data')),
    outDir: path.resolve(raw.out ?? path.join(HERE, 'results')), timeoutMs: int('timeout-ms', 20000, 50, 120000),
    concurrency: int('concurrency', 4, 1, 16), openaiModel: raw['openai-model'] ?? null,
    maxRequests: int('max-requests', 3000, 1, 100000), retry: raw['no-retry'] !== true, force: raw.force === true,
  };
}

const USAGE = `usage: node qa/kernel/run-eval.mjs --run-id <id> [--arms jev,openai,local,chain] [--retrieval lexical,adaptive,full]
       [--suite skills|supervisor|all] [--limit n] [--data-dir dir] [--gold author|consensus] [--labels fileA,fileB]
       [--spend-holdout "<reason>"] [--out dir] [--timeout-ms 20000] [--concurrency 4] [--openai-model name]
       [--max-requests 3000] [--no-retry] [--force]`;

/** The product only reads project skills from <project>/.claude/skills, so the dataset is copied into a disposable project. */
async function buildCatalog(dataDir, workDir) {
  const source = path.join(dataDir, 'skills');
  try { await fs.access(source); } catch { throw fail('DATA_FILE_MISSING', source); }
  const project = path.join(workDir, 'project');
  await fs.cp(source, path.join(project, '.claude', 'skills'), { recursive: true });
  const catalog = await loadSkillCatalog({ project });
  if (!catalog.skills.length) throw fail('DATA_EMPTY_SKILL_CATALOG', source);
  return catalog;
}

function gitInfo() {
  const git = args => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try { return { commit: git(['rev-parse', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), dirty: git(['status', '--porcelain', '--', 'orchestration']) !== '' }; }
  catch { return { commit: null, branch: null, dirty: null }; }
}

async function copyLog(run, dest) {
  const dir = run.log.dir;
  let names = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  await fs.mkdir(dest, { recursive: true });
  for (const name of names) await fs.copyFile(path.join(dir, name), path.join(dest, name));
  return names.sort();
}

/**
 * Runs the evaluation. `fetchImpl` exists for offline tests of the harness itself; any run that uses it is
 * stamped transport: 'injected' / live: false in metrics.json and in the printed summary.
 */
export async function runEvaluation(options, { env = process.env, fetchImpl = null, stderr = process.stderr, now = () => new Date() } = {}) {
  if (typeof options.runId !== 'string' || !RUN_ID.test(options.runId)) throw fail('QA_INVALID_RUN_ID');

  // Held-out discipline comes first: hashes are verified before anything else is looked at.
  const holdout = await readHoldout(options.dataDir);
  let verified = null;
  if (holdout) {
    verified = await verifyHoldout(options.dataDir, holdout);
    if (!options.spendHoldout) throw fail('QA_HOLDOUT_REQUIRES_SPEND', `${path.join(options.dataDir, 'HOLDOUT.json')} is frozen; pass --spend-holdout "<reason>"`);
  } else if (options.spendHoldout) {
    // Never let a run look "spent and recorded" when there was nothing frozen to record against.
    throw fail('QA_HOLDOUT_NOT_FROZEN', path.join(options.dataDir, 'HOLDOUT.json'));
  }

  const plan = [];
  for (const suite of options.suites) for (const arm of options.arms) {
    if (!ARMS[arm].suites.includes(suite)) continue;
    if (suite === 'skills') for (const mode of options.retrieval ?? [null]) plan.push({ suite, arm, retrieval: mode, key: armKey(arm, mode) });
    else plan.push({ suite, arm, retrieval: null, key: arm });
  }
  if (!plan.length) throw fail('QA_NOTHING_TO_RUN');
  const neededKeys = [...new Set(plan.flatMap(p => ARMS[p.arm].keys))];
  const missing = neededKeys.filter(k => !env[k]);
  if (missing.length) throw fail('QA_MISSING_KEYS', missing.join(','));
  const secrets = neededKeys.map(k => env[k]).filter(v => typeof v === 'string' && v.length >= 8);

  const resultDir = path.join(options.outDir, options.runId);
  const write = async (name, text) => {
    // Last line of defence: nothing that contains a key value is ever written.
    if (secrets.some(s => text.includes(s))) throw fail('QA_SECRET_IN_OUTPUT', name);
    await fs.writeFile(path.join(resultDir, name), text);
  };

  const workDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'qa-kernel-eval-'));
  const startedAt = now().toISOString();
  const live = fetchImpl === null;
  const innerFetch = fetchImpl ?? globalThis.fetch;
  const git = gitInfo();
  const metrics = {
    schema: 2, runId: options.runId, startedAt, finishedAt: null,
    live, transport: live ? 'live' : 'injected',
    // True only when the plan contains an arm that calls a remote API. A local-only run sends nothing.
    remoteArms: plan.some(p => ARMS[p.arm].keys.length > 0),
    product: { version: VERSION, git }, node: process.version,
    options: {
      arms: options.arms, retrieval: options.retrieval, suites: options.suites, limit: options.limit, timeoutMs: options.timeoutMs,
      concurrency: options.concurrency, retryTransportErrorsOnce: options.retry, maxRequestsPerArm: options.maxRequests,
      openaiModelOverride: options.openaiModel, dataDir: path.relative(REPO, options.dataDir) || '.', gold: options.gold, labels: options.labels,
    },
    holdout: null,
    plan, dataset: {}, retrieval: null, skills: {}, supervisor: {}, liveRequests: { byHost: {}, total: 0 }, files: [],
  };
  const progress = label => {
    let last = 0;
    return n => { if (n - last >= 25) { last = n; stderr.write(`  ${label}: ${n}\n`); } };
  };
  const addHttp = http => {
    for (const [host, n] of Object.entries(http.byHost)) metrics.liveRequests.byHost[host] = (metrics.liveRequests.byHost[host] ?? 0) + n;
    metrics.liveRequests.total += http.requests;
  };

  try {
    const common = { runId: options.runId, env, innerFetch, timeoutMs: options.timeoutMs, concurrency: options.concurrency,
      openaiModel: options.openaiModel, retry: options.retry, maxRequests: options.maxRequests };

    // Everything is loaded and checked before the result folder exists and before any request is made.
    const reads = [];
    let skills = null, supervisor = null, catalog = null;
    if (plan.some(p => p.suite === 'skills')) {
      catalog = await buildCatalog(options.dataDir, workDir);
      skills = await loadSkillSuite(options.dataDir, { limit: options.limit, labels: options.labels });
      reads.push(...skills.files);
      // --gold consensus is a demand, not a preference: without a second label file there is no consensus subset.
      if (options.gold === 'consensus' && !skills.gold.consensus) throw fail('QA_NO_CONSENSUS', 'no second label file; see --labels');
    }
    if (plan.some(p => p.suite === 'supervisor')) {
      supervisor = await loadSupervisorSuite(options.dataDir, { limit: options.limit });
      reads.push(...supervisor.files);
      if (options.gold === 'consensus' && !supervisor.gold.consensus) throw fail('QA_NO_CONSENSUS', 'supervisor-reports.blind.jsonl');
    }
    // Every file this run reads must be one of the frozen ones (and nothing may have been added under skills/).
    if (holdout) await verifyHoldout(options.dataDir, holdout, { reads });

    try {
      await fs.access(resultDir);
      if (!options.force) throw fail('QA_RUN_ID_EXISTS', resultDir);
      await fs.rm(resultDir, { recursive: true, force: true });
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.mkdir(resultDir, { recursive: true });

    if (holdout) {
      const prior = await readLedger(options.dataDir);
      // Written BEFORE the first request: a run that dies half way has still spent a look at the set.
      const entry = await appendLedger(options.dataDir, {
        schema: 1, runId: options.runId, timestamp: now().toISOString(),
        productCommit: git.commit, productDirty: git.dirty, productVersion: VERSION,
        arms: options.arms, retrievalModes: options.retrieval ?? [`product default (${DEFAULT_RETRIEVAL.retrieval})`],
        plan: plan.map(p => `${p.suite}/${p.key}`), suites: options.suites, limit: options.limit,
        gold: options.gold, labels: skills ? [skills.labels.a, skills.labels.b] : null,
        transport: live ? 'live' : 'injected', remoteArms: metrics.remoteArms, reason: options.spendHoldout,
      });
      metrics.holdout = {
        frozen: true, frozenAt: holdout.frozenAt ?? null, policy: holdout.policy, verifiedFiles: verified.verifiedFiles,
        reason: options.spendHoldout, ledgerFile: LEDGER_FILE, ledgerEntry: entry, runsRecordedBefore: prior.length,
        suppressed: ['rows-*.jsonl', 'decision-log/', 'retrieval sweep', 'autoLoadSweep', 'thresholdSweep', 'item ids in dataset.issues'],
      };
      stderr.write(`HELD-OUT SET: run recorded in ${LEDGER_FILE} (${prior.length} earlier run${prior.length === 1 ? '' : 's'})\n`);
    }
    const idsOrCounts = issues => (holdout ? Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, v.length])) : issues);
    // The headline gold: what the summary shows first and what the product decision log is labeled with.
    const headlineOf = gold => options.gold ?? (gold.consensus ? 'consensus' : 'author');

    if (skills) {
      const suite = skills;
      metrics.dataset.skills = {
        ...skillAgreement(suite, new Set(catalog.skills.map(s => s.name))), issues: idsOrCounts(suite.issues), headlineGold: headlineOf(suite.gold),
        catalog: { skills: catalog.skills.length, skipped: catalog.skipped.length, skippedReasons: catalog.skipped.map(s => s.reason) },
        byLanguage: count(suite.items, i => i.lang ?? 'unknown'), byCategory: count(suite.items, i => i.category ?? 'unknown'),
      };
      // A sweep over k. Never produced for a held-out set.
      metrics.retrieval = holdout ? { ...SUPPRESSED } : retrievalAnalysis({ items: suite.items, catalog, gold: suite.gold });
      for (const { arm, retrieval, key } of plan.filter(p => p.suite === 'skills')) {
        stderr.write(`skills / ${key}: ${suite.items.length} items\n`);
        const stateDir = path.join(workDir, `state-skills-${key}`);
        const run = await runSkillsArm({ ...common, arm, retrieval, items: suite.items, catalog, stateDir, onProgress: progress(`skills/${key}`) });
        metrics.skills[key] = await skillsMetrics({ run, items: suite.items, catalog, gold: suite.gold, labelGold: headlineOf(suite.gold) });
        addHttp(run.http);
        if (holdout) continue; // aggregate metrics only: no per-item rows, no copied decision log
        await write(`rows-skills-${key}.jsonl`, run.rows.map(r => JSON.stringify(withGold(r, suite.gold, g => [...g].sort()))).join('\n') + '\n');
        metrics.files.push(`rows-skills-${key}.jsonl`);
        for (const name of await copyLog(run, path.join(resultDir, 'decision-log', `skills-${key}`))) metrics.files.push(`decision-log/skills-${key}/${name}`);
      }
    }

    if (supervisor) {
      const suite = supervisor;
      metrics.dataset.supervisor = {
        ...supervisorAgreement(suite), issues: idsOrCounts(suite.issues), headlineGold: headlineOf(suite.gold),
        byLanguage: count(suite.items, i => i.lang ?? 'unknown'),
      };
      for (const { arm } of plan.filter(p => p.suite === 'supervisor')) {
        stderr.write(`supervisor / ${arm}: ${suite.items.length} items\n`);
        const stateDir = path.join(workDir, `state-supervisor-${arm}`);
        const run = await runSupervisorArm({ ...common, arm, items: suite.items, stateDir, onProgress: progress(`supervisor/${arm}`) });
        metrics.supervisor[arm] = await supervisorMetrics({ run, gold: suite.gold, labelGold: headlineOf(suite.gold) });
        addHttp(run.http);
        if (holdout) continue;
        await write(`rows-supervisor-${arm}.jsonl`, run.rows.map(r => JSON.stringify(withGold(r, suite.gold, g => g))).join('\n') + '\n');
        metrics.files.push(`rows-supervisor-${arm}.jsonl`);
        for (const name of await copyLog(run, path.join(resultDir, 'decision-log', `supervisor-${arm}`))) metrics.files.push(`decision-log/supervisor-${arm}/${name}`);
      }
    }

    if (holdout) suppressSweeps(metrics);
    metrics.finishedAt = now().toISOString();
    const text = summary(metrics, path.relative(process.cwd(), resultDir) || '.');
    await write('metrics.json', JSON.stringify(metrics, null, 2) + '\n');
    await write('summary.txt', text + '\n');
    return { metrics, resultDir, summary: text };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function count(items, key) {
  const out = {};
  for (const item of items) { const k = String(key(item)); out[k] = (out[k] ?? 0) + 1; }
  return out;
}

function withGold(row, gold, show) {
  const pick = map => (map && map.has(row.id) ? show(map.get(row.id)) : null);
  return { ...row, gold: { author: pick(gold.author), blind: pick(gold.blind), consensus: pick(gold.consensus) } };
}

// ---------------------------------------------------------------- one-screen summary

const num = (x, d = 3) => (x === null || x === undefined ? 'n/a' : Number(x).toFixed(d));
const pct = x => (x === null || x === undefined ? 'n/a' : (100 * x).toFixed(1) + '%');
const ms = x => (x === null || x === undefined ? 'n/a' : String(Math.round(x)));
const pad = (s, n) => String(s).padEnd(n);
const table = rows => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i]).length)));
  return rows.map(r => '  ' + r.map((c, i) => pad(c, widths[i])).join('  ').trimEnd()).join('\n');
};

export function summary(m, where) {
  const lines = [];
  const pick = d => d.headlineGold ?? (d && d.consensus !== null ? 'consensus' : 'author');
  const note = h => (h === 'author' ? 'author gold, all items' : 'consensus subset');
  lines.push(`Decision kernel evaluation  run=${m.runId}  ${!m.live ? 'NOT LIVE (injected transport)' : m.remoteArms === false ? 'OFFLINE (local judge only, no API call)' : 'LIVE API'}  product=${m.product.version}@${(m.product.git.commit ?? 'unknown').slice(0, 8)}${m.product.git.dirty ? '+dirty' : ''}`);
  if (m.holdout) {
    lines.push(`HELD-OUT SET (${m.options.dataDir}): ${m.holdout.verifiedFiles} file hashes verified; run recorded in ${m.holdout.ledgerFile} after ${m.holdout.runsRecordedBefore} earlier run(s); reason: ${m.holdout.reason}`);
    lines.push('  aggregate metrics only: no per-item files, no sweeps. Nothing may be tuned on these numbers (qa/kernel/DECISION_RULE.md).');
  }
  lines.push('failures count as "nothing selected / no advice"; tok = usage fields in the API response bodies (n/a = not returned)');
  const ds = m.dataset.skills;
  if (ds) {
    const headline = pick(ds);
    const lf = ds.labelFiles;
    lines.push(`skills data: ${ds.items} tasks, ${ds.catalog.skills} skills; label files A=${lf?.a ?? 'n/a'} B=${lf?.b ?? 'none'}`);
    lines.push(`  agreement A vs B: exact-set ${pct(ds.exactSetMatchRate)} of ${ds.bothLabeled ?? 'n/a'} labeled by both, any-skill kappa ${num(ds.anySkillKappa?.kappa)}; consensus subset ${ds.consensus ?? 'n/a'} of ${ds.items} tasks (${pct(ds.consensusShareOfItems)})`);
    const r = m.retrieval?.[headline];
    if (Array.isArray(r)) {
      lines.push(`[${m.retrieval.label}] BM25 top-k recall of gold skills (${note(headline)}): ${r.map(x => `@${x.k} ${pct(x.overall.goldSkillRecall)}`).join('  ')}`);
      const at = r.find(x => x.k === 8) ?? r[0];
      lines.push(`  by language @${at.k}: ${Object.entries(at.byLanguage).map(([l, c]) => `${l} ${pct(c.goldSkillRecall)} (${c.inTopK}/${c.goldSkills})`).join('  ')}`);
    }
    const first = Object.values(m.skills)[0];
    const t = first?.thresholds;
    if (t) lines.push(`SKILLS thresholds: need ${t.need}, autoLoad ${t.autoLoad}, maxCandidates ${t.maxCandidates}; wide retrieval: minCoverage ${t.minCoverage}, maxJudged ${t.maxJudged}, chunk ${t.chunk}`);
    // Both golds are always shown: the consensus subset and author gold over all items. The headline comes first.
    for (const goldName of headline === 'author' ? ['author', 'consensus'] : ['consensus', 'author']) {
      if (!first?.gold[goldName]) { lines.push(`SKILLS on ${note(goldName)}: n/a (no second label file, so no consensus subset)`); continue; }
      const rows = [['arm', 'n', 'fail', 'needAcc', 'load P', 'load R', 'load F1', 'exact', 'F1+sugg', 'falseInj', 'miss', 'ECE need', 'ECE skill']];
      for (const [arm, a] of Object.entries(m.skills)) {
        const g = a.gold[goldName];
        const c = goldName === headline ? a.calibration.direct.labelGold : a.calibration.direct.author;
        rows.push([arm, g.n, g.failedItems, pct(g.needGate.accuracy), num(g.loaded.precision), num(g.loaded.recall), num(g.loaded.f1),
          pct(g.loaded.exactSetMatchRate), num(g.loadedOrSuggested.f1), pct(g.noneTasks.falseInjectionRate), pct(g.goldTasks.missRate),
          num(c.need.ece), num(c.perSkill.ece)]);
      }
      lines.push(`SKILLS on ${note(goldName)}${goldName === headline ? ' [headline]' : ''}`);
      lines.push(table(rows));
      const langRows = [['arm', 'lang', 'n', 'load P', 'load R', 'load F1', 'falseInj']];
      for (const [arm, a] of Object.entries(m.skills)) for (const [lang, g] of Object.entries(a.gold[goldName].byLanguage)) {
        langRows.push([arm, lang, g.n, num(g.loaded.precision), num(g.loaded.recall), num(g.loaded.f1), pct(g.noneTasks.falseInjectionRate)]);
      }
      lines.push(`  by language (${note(goldName)})`);
      lines.push(table(langRows).replace(/^/gm, '  '));
    }
    const ops = [['arm', 'mode', 'wide', 'req/task', 'max req', 'judged/task', 'tok in/task', 'tok out/task', 'task p50ms', 'task p95ms', 'task maxms', 'failed req', 'requests']];
    for (const [arm, a] of Object.entries(m.skills)) {
      const o = a.operations, rt = o.retrieval;
      ops.push([arm, rt.mode, pct(rt.wideShare), num(rt.requestsPerTask.mean, 2), rt.requestsPerTask.max ?? 'n/a', num(rt.skillsJudgedPerTask.mean, 1),
        num(o.tokensPerTask.input, 1), num(o.tokensPerTask.output, 1), ms(o.taskLatencyMs.p50), ms(o.taskLatencyMs.p95), ms(o.taskLatencyMs.max),
        rt.failedRequests, o.judgeCalls]);
    }
    lines.push('SKILLS retrieval and cost per arm (latency is per TASK: wall clock across its chunk requests)');
    lines.push(table(ops));
    for (const [arm, a] of Object.entries(m.skills)) {
      const o = a.operations;
      const codes = Object.entries(o.failuresByCode).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
      let line = `  ${arm}: failures ${codes}; retried ${o.retriedTransportErrors}; injected ctx mean ${ms(o.context.meanInjectedChars)} chars vs catalog ${o.context.wholeCatalogListingChars}; product/direct calibration ${a.calibration.crossCheck.agrees ? 'agree' : 'DIFFER or n/a'}`;
      if (o.chain) line += `; escalation ${pct(o.chain.escalationRate)}, saved calls ${pct(o.chain.savedCallRate)}`;
      lines.push(line);
    }
  }
  const dv = m.dataset.supervisor;
  if (dv) {
    const headline = pick(dv);
    lines.push(`supervisor data: ${dv.items} reports; consensus ${dv.consensus ?? 'n/a'}; outcome agreement ${pct(dv.outcomeExactRate)}, kappa ${num(dv.outcomeKappa?.kappa)}`);
    const rows = [['arm', 'n', 'fail', 'acc', 'macroF1', 'evMAE', 'evExact', 'ECE', 'coverage', 'accSurfaced', 'p50ms', 'p95ms', 'maxms', 'tok in/out']];
    for (const [arm, a] of Object.entries(m.supervisor)) {
      const g = a.gold[headline], o = a.operations;
      rows.push([arm, g.outcome.n, o.failedItems, pct(g.outcome.accuracy), num(g.outcome.macroF1), num(g.evidence.mae), pct(g.evidence.exactLevelRate),
        num(g.calibrationDirect.ece), pct(g.shippedThreshold.coverage), pct(g.shippedThreshold.accuracyAmongSurfaced),
        ms(o.latencyMs.p50), ms(o.latencyMs.p95), ms(o.latencyMs.max), `${o.http.wireUsage.inputTokens ?? 'n/a'}/${o.http.wireUsage.outputTokens ?? 'n/a'}`]);
    }
    lines.push(`SUPERVISOR (gold: ${dv.consensus === null ? 'author (no blind labels found, so no consensus subset)' : note(headline)}; surfaced when confidence >= ${Object.values(m.supervisor)[0]?.settings.confidence})`);
    lines.push(table(rows));
    for (const [arm, a] of Object.entries(m.supervisor)) {
      const o = a.operations;
      const codes = Object.entries(o.failuresByCode).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
      lines.push(`  ${arm}: failures ${codes}; skipped ${Object.entries(o.skipped).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}; retried ${o.retriedTransportErrors}; product/direct calibration ${a.calibration.crossCheck.agrees ? 'agree' : 'DIFFER or n/a'}`);
    }
  }
  const hosts = Object.entries(m.liveRequests.byHost).map(([h, n]) => `${h}=${n}`).join('  ') || 'none';
  lines.push(`${m.live ? 'live' : 'injected (not live)'} HTTP requests: ${hosts}  (total ${m.liveRequests.total})`);
  lines.push(`results: ${where}/metrics.json`);
  return lines.join('\n');
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`${e.message}\n${USAGE}\n`); process.exit(64); }
  if (options.help) { process.stdout.write(USAGE + '\n'); return; }
  if (!options.runId) { process.stderr.write(`QA_MISSING_RUN_ID\n${USAGE}\n`); process.exit(64); }
  try {
    const { summary: text } = await runEvaluation(options);
    process.stdout.write(text + '\n');
  } catch (e) {
    // Only the typed code and our own detail are printed; nothing from a request or response.
    const known = typeof e?.code === 'string' && /^(QA|DATA)_/.test(e.code);
    process.stderr.write(known ? `${e.message}\n` : `QA_RUN_FAILED: ${typeof e?.code === 'string' ? e.code : e?.name ?? 'Error'}\n`);
    if (process.env.QA_DEBUG === '1' && !known) process.stderr.write(`${e?.stack ?? ''}\n`);
    process.exit(e?.code === 'QA_MISSING_KEYS' ? 2 : 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
