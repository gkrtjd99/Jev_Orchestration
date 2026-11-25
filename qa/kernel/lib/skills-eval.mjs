// Skill-routing evaluation: runs the shipped selectSkills pipeline per arm and scores it against gold.
import { performance } from 'node:perf_hooks';
import {
  SKILLS_POINT, selectSkills, skillContext, bm25Rank,
} from '../../../orchestration/src/kernel/skills.mjs';
import { calibrationReport } from '../../../orchestration/src/kernel/calibration.mjs';
import {
  armConfig, buildKernel, countingFetch, pool, isTimeout, isTransport, sumUsage, trailsByScope,
} from './harness.mjs';
import {
  ratio, mean, latencySummary, prf, binaryMetrics, binaryCalibration, countBy, groupBy, setEqual,
} from './stats.mjs';

export const AUTOLOAD_SWEEP = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
export const CANDIDATE_SWEEP = [4, 8, 12, 16, 40];
const LATENCY_BUDGETS_MS = [1200, 2500, 3000, 5000];

// ---------------------------------------------------------------- live run

/** Runs every item through selectSkills with the arm's judge chain. Returns raw rows and request attempts. */
export async function runSkillsArm({
  arm, runId, items, catalog, env, innerFetch, stateDir, timeoutMs, concurrency, openaiModel, retry, maxRequests, onProgress = () => {},
}) {
  const cfg = armConfig({ arm, pointId: SKILLS_POINT, stateDir, timeoutMs, openaiModel });
  const { fetchImpl, stats: http } = countingFetch(innerFetch, { maxRequests });
  const { kernel, log } = buildKernel(cfg, { arm, env, fetchImpl });
  const settings = kernel.kernel.skills;
  const inner = kernel.forPoint(SKILLS_POINT);
  const attempts = [];
  let done = 0;

  const attempt = async (item, n) => {
    // A fresh scope per attempt: no cache hit, and the request cap and circuit never couple two items.
    const scope = `qa:${runId}:skills:${arm}:${item.id}:a${n}`;
    let call = null;
    // Recording proxy around the real kernel point; it changes nothing that selectSkills sees.
    const judge = {
      evaluate: async (state, questions, sc, limits) => {
        const start = performance.now();
        try {
          const r = await inner.evaluate(state, questions, sc, limits);
          call = { ok: true, latencyMs: r.latencyMs, provider: r.provider, model: r.response.model, usage: r.response.usage ?? null };
          return r;
        } catch (e) {
          call = { ok: false, latencyMs: performance.now() - start };
          throw e;
        }
      },
    };
    const result = await selectSkills({ task: item.task, catalog, judge, scope, config: settings, limits: { timeoutMs: cfg.timeoutMs } });
    const code = result.status === 'unavailable' ? result.code ?? 'SKILL_JUDGE_FAILED' : null;
    if (call) attempts.push({ id: item.id, attempt: n, ok: call.ok, code, latencyMs: call.latencyMs });
    const context = result.status === 'selected' ? skillContext(result) : '';
    onProgress(++done);
    return {
      suite: 'skills', arm, id: item.id, lang: item.lang ?? null, category: item.category ?? null, attempt: n, scope,
      status: result.status, code, judged: call !== null, need: result.need, candidateCount: result.candidates,
      candidates: result.trace.filter(t => t.rank <= result.candidates).map(t => ({ name: t.name, rank: t.rank, bm25: t.bm25, p: t.probability, stage: t.stage })),
      load: result.load.map(s => ({ name: s.name, p: s.probability })),
      suggest: result.suggest.map(s => ({ name: s.name, p: s.probability })),
      ranking: result.trace.map(t => t.name),
      provider: call?.ok ? call.provider : null, model: call?.ok ? call.model : null, decisionId: result.decisionId,
      latencyMs: call ? call.latencyMs : null, usage: call?.ok ? call.usage : null, contextChars: context.length,
    };
  };

  const rows = await pool(items, concurrency, item => attempt(item, 1));
  const firstPassFailures = countBy(rows.filter(r => r.status === 'unavailable'), r => r.code);

  // One explicit, counted retry pass for transport errors only. Timeouts stay failures.
  const targets = retry ? rows.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 'unavailable' && isTransport(r.code)) : [];
  await pool(targets, concurrency, async ({ r, i }) => {
    const again = await attempt(items[i], 2);
    again.firstAttempt = { code: r.code, latencyMs: r.latencyMs };
    rows[i] = again;
  });

  const { map, decisions, corruptLines } = await trailsByScope(log, SKILLS_POINT);
  for (const row of rows) {
    const d = map.get(row.scope);
    row.trail = d ? d.trail : null;
    if (d && !row.decisionId && d.provider === 'none') row.failedDecisionId = d.decisionId;
  }
  return { cfg, kernel, log, settings, rows, attempts, http, retried: targets.length, firstPassFailures, logged: { decisions, corruptLines } };
}

// ---------------------------------------------------------------- scoring

const predFromRow = row => ({
  id: row.id, lang: row.lang, category: row.category, failed: row.status === 'unavailable', need: row.need,
  load: row.load.map(s => s.name), suggest: row.suggest.map(s => s.name),
  stage: Object.fromEntries(row.candidates.map(c => [c.name, c.stage])),
});

function selection(preds, gold, needGate) {
  const sets = { loaded: { tp: 0, fp: 0, fn: 0, exact: 0 }, loadedOrSuggested: { tp: 0, fp: 0, fn: 0, exact: 0 } };
  const need = [];
  const none = { tasks: 0, anyLoaded: 0, anyLoadedOrSuggested: 0 };
  const withGold = {
    tasks: 0, noGoldSkillLoaded: 0, notAllGoldLoaded: 0, noGoldSkillLoadedOrSuggested: 0, notAllGoldLoadedOrSuggested: 0,
  };
  const retrieval = { goldSkills: 0, inCandidates: 0, tasks: 0, tasksAllGoldInCandidates: 0 };
  const stopStage = {};
  let failed = 0;
  for (const pred of preds) {
    const g = gold.get(pred.id);
    const L = new Set(pred.load);
    const LS = new Set([...pred.load, ...pred.suggest]);
    if (pred.failed) failed++;
    for (const [key, S] of [['loaded', L], ['loadedOrSuggested', LS]]) {
      const tp = [...S].filter(x => g.has(x)).length;
      sets[key].tp += tp; sets[key].fp += S.size - tp; sets[key].fn += g.size - tp;
      if (setEqual(S, g)) sets[key].exact++;
    }
    need.push({ pred: !pred.failed && pred.need !== null && pred.need >= needGate, gold: g.size > 0 });
    if (g.size === 0) {
      none.tasks++;
      if (L.size) none.anyLoaded++;
      if (LS.size) none.anyLoadedOrSuggested++;
      continue;
    }
    withGold.tasks++;
    const hitL = [...g].filter(x => L.has(x)).length, hitLS = [...g].filter(x => LS.has(x)).length;
    if (!hitL) withGold.noGoldSkillLoaded++;
    if (hitL < g.size) withGold.notAllGoldLoaded++;
    if (!hitLS) withGold.noGoldSkillLoadedOrSuggested++;
    if (hitLS < g.size) withGold.notAllGoldLoadedOrSuggested++;
    retrieval.tasks++;
    let all = true;
    for (const name of g) {
      retrieval.goldSkills++;
      const stage = Object.hasOwn(pred.stage, name) ? pred.stage[name] : 'retrieval';
      if (stage !== 'retrieval') retrieval.inCandidates++; else all = false;
      if (!L.has(name)) stopStage[stage] = (stopStage[stage] ?? 0) + 1;
    }
    if (all) retrieval.tasksAllGoldInCandidates++;
  }
  const n = preds.length;
  const pack = s => ({ ...prf(s.tp, s.fp, s.fn), exactSetMatches: s.exact, exactSetMatchRate: ratio(s.exact, n) });
  return {
    n, failedItems: failed,
    retrievalAtMaxCandidates: {
      ...retrieval, goldSkillRecall: ratio(retrieval.inCandidates, retrieval.goldSkills),
      taskAllGoldRetrievedRate: ratio(retrieval.tasksAllGoldInCandidates, retrieval.tasks),
    },
    needGate: binaryMetrics(need),
    loaded: pack(sets.loaded),
    loadedOrSuggested: pack(sets.loadedOrSuggested),
    noneTasks: {
      ...none, falseInjectionRate: ratio(none.anyLoaded, none.tasks),
      falseInjectionOrSuggestionRate: ratio(none.anyLoadedOrSuggested, none.tasks),
    },
    goldTasks: {
      ...withGold, missRate: ratio(withGold.noGoldSkillLoaded, withGold.tasks),
      incompleteRate: ratio(withGold.notAllGoldLoaded, withGold.tasks),
      missRateCountingSuggested: ratio(withGold.noGoldSkillLoadedOrSuggested, withGold.tasks),
      incompleteRateCountingSuggested: ratio(withGold.notAllGoldLoadedOrSuggested, withGold.tasks),
    },
    // Where each gold skill that was not loaded stopped in the pipeline (why-not stage).
    goldSkillNotLoadedByStage: stopStage,
  };
}

function scoreVariant(preds, gold, needGate, { breakdown = true } = {}) {
  const scoped = preds.filter(p => gold.has(p.id));
  const out = selection(scoped, gold, needGate);
  // Failures count as "nothing selected" above, which is what the product does. This is the same scoring
  // restricted to items where a judge answered.
  out.answeredOnly = selection(scoped.filter(p => !p.failed), gold, needGate);
  if (breakdown) {
    const by = key => Object.fromEntries([...groupBy(scoped, p => p[key] ?? 'unknown').entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, group]) => [k, selection(group, gold, needGate)]));
    out.byLanguage = by('lang');
    out.byCategory = by('category');
  }
  return out;
}

/** Replays logged probabilities through the real selectSkills with another config. No judge is called. */
async function replay(row, item, catalog, config) {
  if (row.status === 'unavailable' || row.need === null) return { ...predFromRow(row), load: [], suggest: [] };
  const answers = { need: { type: 'noul', noul: row.need } };
  row.candidates.forEach((c, i) => { answers[`skill_${i}`] = { type: 'noul', noul: c.p }; });
  const result = await selectSkills({
    task: item.task, catalog, config, scope: 'qa-offline-replay',
    judge: { evaluate: async () => ({ response: { answers } }) },
  });
  const cut = result.trace.filter(t => t.rank <= result.candidates);
  if (cut.length !== row.candidates.length || cut.some((t, i) => t.name !== row.candidates[i].name)) {
    const e = new Error('QA_REPLAY_CANDIDATE_MISMATCH'); e.code = 'QA_REPLAY_CANDIDATE_MISMATCH'; throw e;
  }
  return {
    id: row.id, lang: row.lang, category: row.category, failed: false, need: result.need,
    load: result.load.map(s => s.name), suggest: result.suggest.map(s => s.name),
    stage: Object.fromEntries(cut.map(t => [t.name, t.stage])),
  };
}

function directCalibration(rows, gold) {
  const need = [], skill = [], byProvider = new Map();
  for (const row of rows) {
    if (row.status === 'unavailable' || row.need === null || !gold.has(row.id)) continue;
    const g = gold.get(row.id);
    const pairs = [{ p: row.need, y: g.size > 0 ? 1 : 0 }];
    need.push(pairs[0]);
    for (const c of row.candidates) { const pair = { p: c.p, y: g.has(c.name) ? 1 : 0 }; skill.push(pair); pairs.push(pair); }
    const key = row.provider ?? 'unknown';
    if (!byProvider.has(key)) byProvider.set(key, []);
    byProvider.get(key).push(...pairs);
  }
  return {
    need: binaryCalibration(need), perSkill: binaryCalibration(skill),
    // need + per-skill together, per accepting provider: the same grouping the product report uses.
    allNoulByProvider: Object.fromEntries([...byProvider.entries()].map(([k, pairs]) => [k, binaryCalibration(pairs)])),
  };
}

/** Labels every answered decision through the shipped log.label path, then runs the shipped report. */
async function productCalibration({ rows, gold, log, threshold, source }) {
  let labels = 0, decisions = 0;
  for (const row of rows) {
    if (!row.decisionId || !gold.has(row.id)) continue;
    const g = gold.get(row.id);
    decisions++;
    await log.label(row.decisionId, { questionId: 'need', outcome: g.size > 0, source });
    labels++;
    for (let i = 0; i < row.candidates.length; i++) {
      await log.label(row.decisionId, { questionId: `skill_${i}`, outcome: g.has(row.candidates[i].name), source });
      labels++;
    }
  }
  const report = calibrationReport(await log.read({ pointId: SKILLS_POINT }), { threshold });
  return { labeledDecisions: decisions, labelsWritten: labels, labelSource: source, report };
}

function crossCheck(report, direct) {
  const groups = report.groups.filter(g => g.type === 'noul');
  let maxAbsDiff = groups.length ? 0 : null, compared = 0, countMismatch = false;
  for (const g of groups) {
    const mine = direct.allNoulByProvider[g.provider];
    if (!mine) { if (g.counts.labeled) countMismatch = true; continue; }
    if (mine.n !== g.counts.labeled) countMismatch = true;
    for (const key of ['brier', 'ece']) {
      if (g.metrics[key] === null || mine[key] === null) continue;
      maxAbsDiff = Math.max(maxAbsDiff, Math.abs(g.metrics[key] - mine[key]));
      compared++;
    }
  }
  return { comparedMetrics: compared, maxAbsDiff, countMismatch, agrees: compared > 0 && !countMismatch && maxAbsDiff < 1e-9 };
}

function operations({ run, catalog }) {
  const { rows, attempts, http, retried, firstPassFailures } = run;
  const failed = rows.filter(r => r.status === 'unavailable');
  const latencies = attempts.map(a => a.latencyMs);
  const byJudge = new Map();
  for (const row of rows) for (const step of row.trail ?? []) {
    if (!byJudge.has(step.provider)) byJudge.set(step.provider, []);
    byJudge.get(step.provider).push(step.latencyMs);
  }
  const trailed = rows.filter(r => Array.isArray(r.trail) && r.trail.length);
  const escalated = trailed.filter(r => r.trail.length > 1);
  const noRemote = trailed.filter(r => r.trail.every(s => s.provider === 'local'));
  const injected = rows.filter(r => r.contextChars > 0).map(r => r.contextChars);
  const listing = catalog.skills.map(s => `- ${s.name}: ${s.description}`).join('\n').length;
  const meanInjected = mean(injected);
  return {
    items: rows.length, judgeCalls: attempts.length, itemsWithoutJudgeCall: rows.filter(r => !r.judged).length,
    retriedTransportErrors: retried, failuresFirstPassByCode: firstPassFailures,
    failedItems: failed.length, failureRate: ratio(failed.length, rows.length), failuresByCode: countBy(failed, r => r.code),
    timeouts: attempts.filter(a => isTimeout(a.code)).length,
    // One entry per judge call (chain = whole chain), failures and retries included.
    latencyMs: latencySummary(latencies),
    latencySuccessfulMs: latencySummary(attempts.filter(a => a.ok).map(a => a.latencyMs)),
    latencyByJudgeMs: Object.fromEntries([...byJudge.entries()].map(([k, v]) => [k, latencySummary(v)])),
    // Share of calls that would not have fit the shipped budgets (timeoutMs 1200, routeDeadlineMs 3000, max timeoutMs 5000).
    shareOverBudgetMs: Object.fromEntries(LATENCY_BUDGETS_MS.map(ms => [ms, ratio(latencies.filter(x => x > ms).length, latencies.length)])),
    // As exposed by the product adapter for the accepted answer (the local judge reports 0; the OpenAI adapter
    // turns a missing field into 0). http.wireUsage holds what the API bodies actually carried.
    tokens: sumUsage(rows.map(r => r.usage)),
    http,
    // Only meaningful when the point has more than one judge.
    chain: run.cfg.kernel.points[SKILLS_POINT].judges.length < 2 ? null : {
      decisionsWithTrail: trailed.length,
      escalated: escalated.length, escalationRate: ratio(escalated.length, trailed.length),
      lowConfidenceEscalations: trailed.filter(r => r.trail[0]?.code === 'KERNEL_LOW_CONFIDENCE').length,
      // Decisions settled without any attempt on a remote judge.
      savedRemoteCalls: noRemote.length, savedCallRate: ratio(noRemote.length, trailed.length),
      heldAnswerFallbacks: escalated.filter(r => r.provider === r.trail[0].provider && r.trail.slice(1).every(s => !s.ok)).length,
      acceptedBy: countBy(rows.filter(r => r.provider), r => r.provider),
    },
    context: {
      itemsWithInjection: injected.length, meanInjectedChars: meanInjected,
      maxInjectedChars: injected.length ? Math.max(...injected) : null,
      meanCharsOverAllItems: rows.length ? injected.reduce((a, b) => a + b, 0) / rows.length : null,
      wholeCatalogListingChars: listing, catalogSkills: catalog.skills.length,
      injectedToCatalogRatio: meanInjected === null ? null : ratio(meanInjected, listing),
    },
  };
}

export async function skillsMetrics({ run, items, catalog, gold }) {
  const { rows, settings, log } = run;
  const preds = rows.map(predFromRow);
  const byId = new Map(items.map(i => [i.id, i]));
  const variants = {};
  for (const name of ['consensus', 'author', 'blind']) variants[name] = gold[name] ? scoreVariant(preds, gold[name], settings.need) : null;

  // Offline autoLoad sweep through the shipped thresholding code.
  let replayMismatches = 0;
  const shipped = await Promise.all(rows.map(r => replay(r, byId.get(r.id), catalog, settings)));
  shipped.forEach((p, i) => {
    if (!setEqual(new Set(p.load), new Set(preds[i].load)) || !setEqual(new Set(p.suggest), new Set(preds[i].suggest))) replayMismatches++;
  });
  const sweep = [];
  for (const autoLoad of AUTOLOAD_SWEEP) {
    const config = { ...settings, autoLoad, suggest: Math.min(settings.suggest, autoLoad) };
    const replayed = await Promise.all(rows.map(r => replay(r, byId.get(r.id), catalog, config)));
    const entry = { autoLoad, suggest: config.suggest };
    for (const name of ['consensus', 'author']) {
      if (!gold[name]) { entry[name] = null; continue; }
      const s = scoreVariant(replayed, gold[name], settings.need, { breakdown: false });
      entry[name] = {
        n: s.n, loaded: s.loaded, loadedOrSuggested: s.loadedOrSuggested,
        falseInjectionRate: s.noneTasks.falseInjectionRate, missRate: s.goldTasks.missRate, incompleteRate: s.goldTasks.incompleteRate,
      };
    }
    sweep.push(entry);
  }

  const labelGold = gold.consensus ?? gold.author;
  const product = await productCalibration({
    rows, gold: labelGold, log, threshold: settings.autoLoad, source: gold.consensus ? 'qa-consensus-gold' : 'qa-author-gold',
  });
  const direct = {
    labelGold: directCalibration(rows, labelGold),
    author: directCalibration(rows, gold.author),
  };
  return {
    judges: run.cfg.kernel.points[SKILLS_POINT].judges, escalateBelow: run.cfg.kernel.points[SKILLS_POINT].escalateBelow,
    thresholds: { need: settings.need, autoLoad: settings.autoLoad, suggest: settings.suggest, maxCandidates: settings.maxCandidates, maxLoaded: settings.maxLoaded, maxSuggested: settings.maxSuggested },
    operations: operations({ run, catalog }),
    gold: variants,
    autoLoadSweep: { replayOfShippedThresholdsMismatches: replayMismatches, points: sweep },
    calibration: { product, direct, crossCheck: crossCheck(product.report, direct.labelGold) },
    decisionLog: run.logged,
  };
}

/** Arm-independent: recall of gold skills in the BM25 top-k, by language. No judge involved. */
export function retrievalAnalysis({ items, catalog, gold }) {
  const ranks = new Map();
  for (const item of items) {
    const order = bm25Rank(item.task, catalog.skills);
    ranks.set(item.id, new Map(order.map((r, i) => [r.skill.name, { rank: i + 1, score: r.score }])));
  }
  const at = (map, k) => {
    const cell = () => ({ goldSkills: 0, inTopK: 0, inTopKWithPositiveScore: 0, tasks: 0, tasksAllInTopK: 0 });
    const overall = cell(), byLang = new Map();
    for (const item of items) {
      const g = map.get(item.id);
      if (!g || g.size === 0) continue;
      const lang = String(item.lang ?? 'unknown');
      if (!byLang.has(lang)) byLang.set(lang, cell());
      let all = true;
      for (const c of [overall, byLang.get(lang)]) c.tasks++;
      for (const name of g) {
        const r = ranks.get(item.id).get(name);
        const hit = !!r && r.rank <= k;
        for (const c of [overall, byLang.get(lang)]) {
          c.goldSkills++;
          if (hit) c.inTopK++;
          if (hit && r.score > 0) c.inTopKWithPositiveScore++;
        }
        if (!hit) all = false;
      }
      if (all) for (const c of [overall, byLang.get(lang)]) c.tasksAllInTopK++;
    }
    const pack = c => ({ ...c, goldSkillRecall: ratio(c.inTopK, c.goldSkills), taskAllGoldRetrievedRate: ratio(c.tasksAllInTopK, c.tasks) });
    return { k, overall: pack(overall), byLanguage: Object.fromEntries([...byLang.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([l, c]) => [l, pack(c)])) };
  };
  const out = { catalogSkills: catalog.skills.length };
  for (const name of ['consensus', 'author', 'blind']) {
    out[name] = gold[name] ? CANDIDATE_SWEEP.map(k => at(gold[name], k)) : null;
  }
  return out;
}
