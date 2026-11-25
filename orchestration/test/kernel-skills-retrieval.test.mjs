// Candidate retrieval for delegation.skills: lexical / adaptive / full, the coverage statistic, the wide
// fan-out and the abstaining local resolver. Every judge here is a mock, a loopback server or local rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { fixture, event, answer, child, server } from './helpers.mjs';
import { handleHook } from '../src/hooks.mjs';
import { SessionStore } from '../src/state.mjs';
import { loadConfig } from '../src/config.mjs';
import { hash, readJSON, sleep, writeJSON } from '../src/util.mjs';
import { createKernel, kernelDefaults, mergeKernel } from '../src/kernel/kernel.mjs';
import { LocalJudge } from '../src/kernel/judges.mjs';
import { DecisionLog, decisionLogDir, isDecisionRecord } from '../src/kernel/log.mjs';
import {
  DEFAULT_RETRIEVAL, DEFAULT_SKILLS_CONFIG, RETRIEVAL_MODES, SKILLS_POINT, bm25Rank, lexicalCoverage, localSkillResolver, selectSkills,
  skillContext, skillQuestions, tokenize, whyNot,
} from '../src/kernel/skills.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'skills.mjs');
const BASE = { maxCandidates: 3, need: 0.5, autoLoad: 0.8, suggest: 0.5, maxLoaded: 2, maxSuggested: 2 };
const code = expected => error => { assert.equal(error.code, expected); return true; };

function catalogOf(entries) {
  return {
    fingerprint: 'fp',
    skills: entries.map(([name, description]) => ({
      id: name, name, description, path: `/abs/.claude/skills/${name}/SKILL.md`, relPath: `.claude/skills/${name}/SKILL.md`, source: 'project',
    })),
  };
}
// n English-only skills. Names sort as s00, s01, ...; only s00 mentions pdf.
const many = n => catalogOf(Array.from({ length: n }, (_, i) => {
  const id = `s${String(i).padStart(2, '0')}`;
  return [id, i === 0 ? 'extract tables from pdf reports' : `procedure number ${id}`];
}));
const KOREAN = '분기 보고서에서 표를 뽑아 정리해 주세요';
const ENGLISH = 'extract tables from pdf reports';

/** Mock judge keyed by skill name. `need` may be a function of the request's state. */
function mockJudge(probabilities = {}, { need = 0.9, behave = null } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async evaluate(state, questions, scope, limits) {
      const index = n++;
      calls.push({ state, questions, scope, limits });
      if (behave) await behave(index, state);
      const answers = {};
      for (const id of Object.keys(questions)) {
        const m = /^skill_(\d+)$/.exec(id);
        answers[id] = { type: 'noul', noul: m ? probabilities[state.skills[Number(m[1])].name] ?? 0 : typeof need === 'function' ? need(state) : need };
      }
      return { response: { model: 'mock', answers }, cached: false, latencyMs: 1, decisionId: 'd'.repeat(63) + index };
    },
  };
}

// ---------------------------------------------------------------- coverage statistic

test('lexicalCoverage is the share of the task\'s distinct tokens found in the catalog vocabulary', () => {
  const { skills } = catalogOf([['pdf-forms', 'Fill and flatten PDF forms'], ['deploy', 'Ship services to production']]);
  // Distinct task tokens: fill, pdf, forms, quickly -> 3 of 4 are in the vocabulary. Repeats and stopwords do not count.
  assert.equal(lexicalCoverage('Fill the PDF forms, fill PDF forms quickly', skills), 0.75);
  assert.equal(lexicalCoverage('ship services', skills), 1);
  assert.equal(lexicalCoverage('refactor billing module', skills), 0);
  // Nothing to measure is no signal, never NaN.
  for (const task of ['', '   ', 'a . !', undefined, null]) assert.equal(lexicalCoverage(task, skills), 0);
  assert.equal(lexicalCoverage('fill pdf forms', []), 0);
  assert.equal(lexicalCoverage('fill pdf forms', null), 0);
});

test('lexicalCoverage needs no script detection: Korean and mixed-script tasks against an English catalog', () => {
  const { skills } = catalogOf([['pdf-forms', 'Fill and flatten PDF forms'], ['deploy', 'Ship services to production']]);
  assert.equal(lexicalCoverage(KOREAN, skills), 0);
  // Mixed script: the Latin-script token is known, the Hangul tokens (words and their bigrams) are not.
  const mixed = 'PDF 양식을 채워 주세요';
  const tokens = new Set(tokenize(mixed));
  assert.ok(tokens.has('pdf') && tokens.size > 4);
  assert.equal(lexicalCoverage(mixed, skills), 1 / tokens.size);
  // The same rule works the other way round: a Korean catalog covers a Korean task, not an English one.
  const korean = catalogOf([['korean-docs', '분기 보고서 표 정리 절차']]).skills;
  assert.ok(lexicalCoverage(KOREAN, korean) > 0.25);
  assert.equal(lexicalCoverage(ENGLISH, korean), 0);
  // Full-width forms are folded by the tokenizer's NFKC step.
  assert.equal(lexicalCoverage('ＰＤＦ ｆｏｒｍｓ', skills), 1);
});

test('lexicalCoverage is 0 exactly when every BM25 score is 0', () => {
  const { skills } = many(12);
  for (const task of [KOREAN, ENGLISH, 'procedure', 'PDF 보고서', 'unrelated words only', 's07', '']) {
    const anyScore = bm25Rank(task, skills).some(r => r.score > 0);
    assert.equal(lexicalCoverage(task, skills) > 0, anyScore, task);
  }
});

// ---------------------------------------------------------------- mode selection

test('retrieval defaults to full: a config without the retrieval settings shows the judge the whole catalog', async () => {
  assert.deepEqual(RETRIEVAL_MODES, ['lexical', 'adaptive', 'full']);
  assert.deepEqual(DEFAULT_RETRIEVAL, { retrieval: 'full', minCoverage: 0.25, maxJudged: 64, chunk: 32 });
  assert.equal(kernelDefaults().skills.retrieval, 'full');
  assert.equal(mergeKernel({ skills: { maxCandidates: 4 } }).skills.retrieval, 'full');
  assert.equal(DEFAULT_SKILLS_CONFIG.retrieval, 'full');
  const catalog = many(10);
  const judge = mockJudge({ s00: 0.95 });
  const result = await selectSkills({ task: ENGLISH, catalog, judge, scope: 's', config: BASE }); // no retrieval keys at all
  assert.equal(judge.calls.length, 1);
  assert.equal(judge.calls[0].state.skills.length, 10);
  assert.deepEqual(judge.calls[0].state.skills.slice(0, 3).map(s => s.name), ['s00', 's01', 's02']);
  assert.deepEqual(result.retrieval, { mode: 'full', wide: true, lexicalSignal: 1, requests: 1, failed: 0, judged: 10, dropped: 0 });
  assert.equal(result.candidates, 10);
  assert.deepEqual(result.decisionIds, ['d'.repeat(63) + '0']);
  assert.equal(result.decisionId, result.decisionIds[0]);
});

test('an explicit lexical setting keeps the BM25 cut that was the default before', async () => {
  const catalog = many(10);
  const judge = mockJudge({ s00: 0.95 });
  const result = await selectSkills({ task: ENGLISH, catalog, judge, scope: 's', config: { ...BASE, retrieval: 'lexical' } });
  assert.equal(judge.calls.length, 1);
  assert.deepEqual(judge.calls[0].state.skills.map(s => s.name), ['s00', 's01', 's02']);
  assert.deepEqual(result.retrieval, { mode: 'lexical', wide: false, lexicalSignal: 1, requests: 1, failed: 0, judged: 3, dropped: 7 });
  assert.equal(result.candidates, 3);
});

test('lexical mode with no lexical signal keeps the old candidates and says the signal is 0', async () => {
  const catalog = many(10);
  const judge = mockJudge({});
  const result = await selectSkills({ task: KOREAN, catalog, judge, scope: 's', config: { ...BASE, retrieval: 'lexical' } });
  // Compatibility: still the first maxCandidates in name order, one request ...
  assert.deepEqual(judge.calls.map(c => c.state.skills.map(s => s.name)), [['s00', 's01', 's02']]);
  // ... but visibly not a relevance ranking.
  assert.equal(result.retrieval.lexicalSignal, 0);
  assert.equal(result.retrieval.wide, false);
  assert.ok(result.trace.every(t => t.bm25 === 0));
  assert.equal(result.retrieval.dropped, 7);
});

test('adaptive goes wide below minCoverage and stays lexical at or above it', async () => {
  const catalog = many(10);
  const run = async (task, extra = {}) => {
    const judge = mockJudge({});
    const result = await selectSkills({ task, catalog, judge, scope: 's', config: { ...BASE, retrieval: 'adaptive', minCoverage: 0.25, maxJudged: 64, chunk: 32, ...extra } });
    return { result, judge };
  };
  const english = await run(ENGLISH);
  assert.deepEqual(english.result.retrieval, { mode: 'adaptive', wide: false, lexicalSignal: 1, requests: 1, failed: 0, judged: 3, dropped: 7 });

  const korean = await run(KOREAN);
  assert.deepEqual(korean.result.retrieval, { mode: 'adaptive', wide: true, lexicalSignal: 0, requests: 1, failed: 0, judged: 10, dropped: 0 });
  assert.equal(korean.judge.calls[0].state.skills.length, 10);
  assert.ok(korean.result.trace.every(t => t.stage !== 'retrieval'));

  // Mixed script: one known token among several unknown ones is below 0.25, so the judge sees everything.
  const mixedTask = 'PDF 보고서에서 표를 뽑아 주세요';
  const signal = lexicalCoverage(mixedTask, catalog.skills);
  assert.ok(signal > 0 && signal < 0.25);
  const mixed = await run(mixedTask);
  assert.equal(mixed.result.retrieval.wide, true);
  assert.equal(mixed.result.retrieval.lexicalSignal, signal);

  // The boundary is inclusive on the lexical side, and the rule is monotone in minCoverage.
  assert.equal((await run(mixedTask, { minCoverage: signal })).result.retrieval.wide, false);
  assert.equal((await run(mixedTask, { minCoverage: signal + 1e-9 })).result.retrieval.wide, true);
  assert.equal((await run(KOREAN, { minCoverage: 0 })).result.retrieval.wide, false); // 0 turns adaptive into lexical
  assert.equal((await run(ENGLISH, { minCoverage: 1 })).result.retrieval.wide, false); // full coverage is never below 1
  assert.equal((await run('extract tables from pdf reports today', { minCoverage: 1 })).result.retrieval.wide, true);
});

test('full always shows the judge the whole catalog, whatever the signal', async () => {
  const catalog = many(10);
  for (const task of [ENGLISH, KOREAN]) {
    const judge = mockJudge({});
    const result = await selectSkills({ task, catalog, judge, scope: 's', config: { ...BASE, retrieval: 'full', minCoverage: 0 } });
    assert.equal(result.retrieval.wide, true);
    assert.equal(result.retrieval.judged, 10);
    assert.equal(result.retrieval.dropped, 0);
    assert.equal(judge.calls.length, 1);
  }
});

test('retrieval settings are validated before anything is judged', async () => {
  const catalog = many(5);
  const judge = mockJudge({});
  for (const extra of [
    { retrieval: 'semantic' }, { retrieval: 'full', chunk: 0 }, { chunk: 2.5 }, { maxJudged: 2 }, { maxJudged: 6.5 }, { minCoverage: 1.5 }, { minCoverage: '0.2' },
  ]) {
    await assert.rejects(selectSkills({ task: 'x y', catalog, judge, scope: 's', config: { ...BASE, ...extra } }), code('INVALID_SKILLS_CONFIG'), JSON.stringify(extra));
  }
  assert.equal(judge.calls.length, 0);
});

// ---------------------------------------------------------------- wide fan-out

test('wide judging fans out in equal chunks with unchanged questions, and need is the maximum', async () => {
  const catalog = many(40);
  const judge = mockJudge({ s25: 0.95, s03: 0.6 }, { need: state => (state.skills.some(s => s.name === 's25') ? 0.9 : 0.1) });
  const limits = { timeoutMs: 400 };
  const result = await selectSkills({ task: KOREAN, catalog, judge, scope: 'scope-w', config: { ...BASE, retrieval: 'adaptive', chunk: 32 }, limits });

  // 40 skills, at most 32 per request -> ceil(40/32) = 2 requests of 20, in rank order.
  assert.equal(judge.calls.length, 2);
  assert.deepEqual(judge.calls.map(c => c.state.skills.length), [20, 20]);
  assert.deepEqual(judge.calls[0].state.skills.map(s => s.name), catalog.skills.slice(0, 20).map(s => s.name));
  assert.deepEqual(judge.calls[1].state.skills.map(s => s.name), catalog.skills.slice(20).map(s => s.name));
  for (const call of judge.calls) {
    // Each request is a complete, ordinary skills question set over its own skills, with local indexes.
    assert.deepEqual(call.questions, skillQuestions(call.state.skills));
    assert.deepEqual(call.state.skills.map(s => s.index), [...Array(20).keys()]);
    assert.equal(call.state.task, KOREAN);
    assert.equal(call.scope, 'scope-w');
    assert.equal(call.limits.pointId, SKILLS_POINT);
    assert.equal(call.limits.timeoutMs, 400); // the one allowance, not a share and not a multiple of it
    assert.deepEqual(call.limits.lexical, { signal: 0, minCoverage: 0.25 });
  }

  assert.equal(result.need, 0.9); // max(0.1, 0.9)
  assert.equal(result.status, 'selected');
  assert.deepEqual(result.load.map(s => s.name), ['s25']);
  assert.deepEqual(result.suggest.map(s => [s.name, s.probability]), [['s03', 0.6]]);
  assert.equal(result.load[0].relPath, '.claude/skills/s25/SKILL.md');
  assert.deepEqual(result.retrieval, { mode: 'adaptive', wide: true, lexicalSignal: 0, requests: 2, failed: 0, judged: 40, dropped: 0 });
  assert.equal(result.candidates, 40);
  assert.deepEqual(result.decisionIds, ['d'.repeat(63) + '0', 'd'.repeat(63) + '1']);
  assert.equal(result.decisionId, 'd'.repeat(63) + '0');

  // The trace still has exactly one line per catalog skill.
  assert.equal(result.trace.length, 40);
  assert.deepEqual(new Set(result.trace.map(t => t.name)), new Set(catalog.skills.map(s => s.name)));
  assert.deepEqual(result.trace.map(t => t.rank), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.ok(result.trace.every(t => typeof t.probability === 'number'));
  assert.equal(whyNot(result, 's25').stage, 'loaded');
  assert.equal(whyNot(result, 's03').stage, 'suggested');
  assert.equal(whyNot(result, 's39').reason, 'probability_below_suggest');
  assert.match(skillContext(result), /"load":\[\{"name":"s25"/);
});

test('the need gate uses the maximum over chunks and the caps apply across chunks', async () => {
  const catalog = many(12);
  const config = { ...BASE, retrieval: 'full', chunk: 4, maxLoaded: 2, maxSuggested: 1 };
  const low = await selectSkills({ task: KOREAN, catalog, judge: mockJudge({ s01: 0.99, s09: 0.99 }, { need: 0.4 }), scope: 's', config });
  assert.equal(low.status, 'none');
  assert.equal(low.need, 0.4);
  assert.ok(low.trace.every(t => t.stage === 'need_gate'));

  // One confident skill per chunk plus two more: load cap 2 and suggest cap 1 hold over all three requests.
  const judge = mockJudge({ s01: 0.99, s05: 0.97, s09: 0.95, s02: 0.7 }, { need: state => (state.skills[0].name === 's08' ? 0.8 : 0.2) });
  const result = await selectSkills({ task: KOREAN, catalog, judge, scope: 's', config });
  assert.equal(judge.calls.length, 3);
  assert.equal(result.need, 0.8);
  assert.deepEqual(result.load.map(s => s.name), ['s01', 's05']);
  assert.deepEqual(result.suggest.map(s => s.name), ['s09']); // above autoLoad but past the load cap: suggested first
  assert.equal(whyNot(result, 's02').stage, 'cap');
});

test('chunks are sent concurrently', async () => {
  const catalog = many(12);
  let inFlight = 0, peak = 0;
  const judge = mockJudge({}, { behave: async () => { inFlight++; peak = Math.max(peak, inFlight); await sleep(40); inFlight--; } });
  const started = performance.now();
  const result = await selectSkills({ task: KOREAN, catalog, judge, scope: 's', config: { ...BASE, retrieval: 'full', chunk: 4 }, limits: { timeoutMs: 2000 } });
  const elapsed = performance.now() - started;
  assert.equal(result.retrieval.requests, 3);
  assert.equal(peak, 3);
  assert.ok(elapsed < 110, `3 x 40 ms requests ran in ${elapsed} ms, so they were not sequential`);
});

test('all chunks share one deadline: a chunk that is not back in time is dropped and the rest still count', async () => {
  const catalog = many(8);
  // The second request never answers inside the allowance (a judge that ignores its timeout).
  const judge = mockJudge({ s01: 0.95, s06: 0.95 }, { behave: async index => { if (index === 1) await sleep(600); } });
  const started = performance.now();
  const result = await selectSkills({ task: KOREAN, catalog, judge, scope: 's', config: { ...BASE, retrieval: 'full', chunk: 4 }, limits: { timeoutMs: 120 } });
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 100 && elapsed < 400, `returned after ${elapsed} ms for a 120 ms allowance`);
  assert.deepEqual(result.retrieval, { mode: 'full', wide: true, lexicalSignal: 0, requests: 2, failed: 1, judged: 8, dropped: 0 });
  assert.equal(result.status, 'selected');
  assert.deepEqual(result.load.map(s => s.name), ['s01']); // s06 was in the late chunk: never loaded
  assert.deepEqual(result.trace.slice(4).map(t => [t.stage, t.probability]), Array(4).fill(['judge_unavailable', null]));
  assert.equal(whyNot(result, 's06').reason, 'judge_failed_nothing_loaded');
  assert.deepEqual(result.decisionIds, ['d'.repeat(63) + '0']);
  // Both requests were given the same allowance; nothing was retried.
  assert.deepEqual(judge.calls.map(c => c.limits.timeoutMs), [120, 120]);
  assert.equal(judge.calls.length, 2);
  await sleep(520); // let the late mock request finish before the test ends
});

test('a failed chunk makes only its own skills judge_unavailable; if every chunk fails the result is unavailable', async () => {
  const catalog = many(12);
  const config = { ...BASE, retrieval: 'full', chunk: 4 };
  const failing = which => mockJudge({ s01: 0.95, s05: 0.95, s09: 0.6 }, {
    behave: async index => { if (which(index)) throw Object.assign(new Error('JEV_HTTP_503'), { code: 'JEV_HTTP_503' }); },
  });

  const partialJudge = failing(index => index === 1);
  const partial = await selectSkills({ task: KOREAN, catalog, judge: partialJudge, scope: 's', config });
  assert.equal(partialJudge.calls.length, 3); // no retry
  assert.equal(partial.status, 'selected');
  assert.equal(partial.code, undefined);
  assert.deepEqual(partial.load.map(s => s.name), ['s01']);
  assert.deepEqual(partial.suggest.map(s => s.name), ['s09']);
  assert.deepEqual(partial.trace.map(t => t.stage === 'judge_unavailable'), [0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0].map(Boolean));
  assert.equal(partial.retrieval.failed, 1);
  assert.equal(partial.retrieval.requests, 3);
  assert.equal(partial.decisionIds.length, 2);

  // An invalid answer set fails its chunk the same way.
  const invalid = { evaluate: async (state, questions) => {
    const response = answer(questions);
    if (state.skills[0].name === 's04') response.answers.skill_2 = { type: 'noul', noul: 1.5 };
    return { response, cached: false, latencyMs: 0 };
  } };
  const withInvalid = await selectSkills({ task: KOREAN, catalog, judge: invalid, scope: 's', config });
  assert.equal(withInvalid.retrieval.failed, 1);
  assert.deepEqual(withInvalid.trace.slice(4, 8).map(t => t.stage), Array(4).fill('judge_unavailable'));

  const allJudge = failing(() => true);
  const all = await selectSkills({ task: KOREAN, catalog, judge: allJudge, scope: 's', config });
  assert.equal(all.status, 'unavailable');
  assert.equal(all.code, 'JEV_HTTP_503');
  assert.equal(all.need, null);
  assert.deepEqual([all.load, all.suggest, all.decisionIds, all.decisionId], [[], [], [], null]);
  assert.ok(all.trace.every(t => t.stage === 'judge_unavailable'));
  assert.equal(all.retrieval.failed, 3);
  assert.equal(skillContext(all), '');

  const missing = await selectSkills({ task: KOREAN, catalog, judge: null, scope: 's', config });
  assert.deepEqual([missing.status, missing.code], ['unavailable', 'SKILL_JUDGE_MISSING']);
});

test('a catalog larger than maxJudged is cut to the BM25 top maxJudged and the result says how many were dropped', async () => {
  const catalog = many(70);
  const judge = mockJudge({ s00: 0.95 });
  const config = { ...BASE, retrieval: 'full', maxJudged: 64, chunk: 32 };
  const result = await selectSkills({ task: ENGLISH, catalog, judge, scope: 's', config });
  assert.deepEqual(result.retrieval, { mode: 'full', wide: true, lexicalSignal: 1, requests: 2, failed: 0, judged: 64, dropped: 6 });
  assert.equal(judge.calls.length, 2); // never more than ceil(maxJudged / chunk)
  assert.deepEqual(judge.calls.map(c => c.state.skills.length), [32, 32]);
  assert.equal(result.trace.length, 70);
  assert.equal(result.trace.filter(t => t.stage === 'retrieval').length, 6);
  assert.deepEqual(result.trace.slice(64).map(t => [t.stage, t.probability]), Array(6).fill(['retrieval', null]));
  assert.equal(whyNot(result, result.trace[69].name).reason, 'not_sent_to_judge');
  assert.equal(result.load[0].name, 's00'); // the lexical best match is always among the judged

  // judged + dropped is the catalog size in every mode, and no chunk exceeds `chunk`.
  for (const [n, maxJudged, chunk, requests, sizes] of [[9, 64, 4, 3, [3, 3, 3]], [10, 9, 4, 3, [3, 3, 3]], [5, 64, 4, 2, [3, 2]], [4, 64, 4, 1, [4]], [33, 64, 32, 2, [17, 16]]]) {
    const j = mockJudge({});
    const r = await selectSkills({ task: KOREAN, catalog: many(n), judge: j, scope: 's', config: { ...BASE, retrieval: 'full', maxJudged, chunk } });
    assert.equal(r.retrieval.requests, requests);
    assert.deepEqual(j.calls.map(c => c.state.skills.length), sizes);
    assert.equal(r.retrieval.judged + r.retrieval.dropped, n);
    assert.ok(requests <= Math.ceil(maxJudged / chunk));
  }
});

// ---------------------------------------------------------------- real kernel: request cap and decision log

/** Loopback Jev that answers every noul with 0.1 except the `need` question (0.9) and named skills. */
async function jevServer(t, probabilities = {}) {
  return server(t, (req, res, parsed) => {
    const response = answer(parsed.questions);
    for (const id of Object.keys(parsed.questions)) {
      const m = /^skill_(\d+)$/.exec(id);
      response.answers[id] = { type: 'noul', noul: m ? probabilities[parsed.state.skills[Number(m[1])].name] ?? 0.1 : 0.9 };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  });
}

test('each chunk is a real judge request: it counts against the auxiliary cap and writes its own record without raw text', async t => {
  const f = await fixture(t);
  const s = await jevServer(t, { s07: 0.95 });
  f.config.endpoint = s.endpoint;
  f.config.allowLoopback = true;
  f.config.cacheTtlMs = 0;
  f.config.circuit.maxRequestsPerSession = 5;
  f.config.kernel.points[SKILLS_POINT] = { mode: 'active', judges: ['jev'], escalateBelow: 0 };
  f.config.kernel.skills = { ...f.config.kernel.skills, retrieval: 'full', maxJudged: 32, chunk: 4 };
  const log = new DecisionLog(decisionLogDir(f.config));
  const kernel = createKernel(f.config, { apiKey: 'fixture-key', log });
  const catalog = catalogOf(Array.from({ length: 12 }, (_, i) => [`s${String(i).padStart(2, '0')}`, `DESCRIPTION_MARKER procedure ${i}`]));
  const scope = 'scope-cap';
  const run = task => selectSkills({ task, catalog, judge: kernel.forPoint(SKILLS_POINT), scope, config: kernel.kernel.skills, limits: { timeoutMs: 2000 } });

  const first = await run('TASK_MARKER 첫 번째 작업');
  assert.equal(first.status, 'selected');
  assert.deepEqual(first.load.map(x => x.name), ['s07']);
  assert.equal(first.retrieval.requests, 3);
  assert.equal(s.requests.length, 3);
  assert.equal(new Set(first.decisionIds).size, 3);

  // The three requests were counted one by one in the auxiliary bucket, not in the routing bucket.
  const control = bucket => path.join(f.config.stateDir, 'request-control',
    hash({ scope, endpoint: f.config.endpoint, account: hash('fixture-key'), ...(bucket ? { bucket } : {}) }) + '.json');
  assert.equal((await readJSON(control('auxiliary'))).requests, 3);
  await assert.rejects(readJSON(control(null)), e => e.code === 'ENOENT');

  // One record per request, each a valid record with that request's answers and nothing but numbers and hashes.
  const { decisions, corruptLines } = await log.read();
  assert.equal(corruptLines, 0);
  assert.equal(decisions.length, 3);
  assert.deepEqual(new Set(decisions.map(d => d.decisionId)), new Set(first.decisionIds));
  for (const d of decisions) {
    assert.ok(isDecisionRecord(d));
    assert.equal(d.pointId, SKILLS_POINT);
    assert.deepEqual(Object.keys(d.answers), ['need', 'skill_0', 'skill_1', 'skill_2', 'skill_3']);
  }
  assert.equal(new Set(decisions.map(d => d.stateHash)).size, 3);
  const raw = (await Promise.all((await fs.readdir(log.dir)).map(name => fs.readFile(path.join(log.dir, name), 'utf8')))).join('');
  for (const marker of ['TASK_MARKER', 'DESCRIPTION_MARKER', '작업', 's07', 'fixture-key']) assert.ok(!raw.includes(marker), marker);

  // Cap 5: the next delegation gets two requests through; the third is refused, and only its skills are lost.
  const second = await run('TASK_MARKER 두 번째 작업');
  assert.equal(s.requests.length, 5);
  assert.equal(second.retrieval.failed, 1);
  assert.equal(second.trace.filter(x => x.stage === 'judge_unavailable').length, 4);
  assert.equal(second.decisionIds.length, 2);
  assert.equal((await readJSON(control('auxiliary'))).requests, 5);
  const third = await run('TASK_MARKER 세 번째 작업');
  assert.deepEqual([third.status, third.code, third.retrieval.failed], ['unavailable', 'JEV_REQUEST_CAP', 3]);
  assert.equal(s.requests.length, 5);
  // A refused request still leaves a record (provider none, no answers).
  const after = (await log.read()).decisions;
  assert.equal(after.length, 9);
  assert.equal(after.filter(d => d.provider === 'none').length, 4);
});

test('one record holds the largest allowed chunk: 64 skills plus the need question', async t => {
  const f = await fixture(t);
  f.config.kernel.points[SKILLS_POINT] = { mode: 'shadow', judges: ['jev'], escalateBelow: 0 };
  const log = new DecisionLog(decisionLogDir(f.config));
  const client = { evaluate: async (state, questions) => ({ response: answer(questions), cached: false, latencyMs: 0 }) };
  const kernel = createKernel(f.config, { client, log });
  const result = await selectSkills({
    task: KOREAN, catalog: many(64), judge: kernel.forPoint(SKILLS_POINT), scope: 's',
    config: { ...kernel.kernel.skills, retrieval: 'full', maxJudged: 64, chunk: 64 },
  });
  assert.equal(result.retrieval.requests, 1);
  const { decisions } = await log.read();
  assert.equal(decisions.length, 1);
  assert.equal(Object.keys(decisions[0].answers).length, 65);
});

// ---------------------------------------------------------------- local resolver and chains

test('localSkillResolver abstains only when there is no lexical signal at all, instead of answering need 0', async () => {
  const catalog = many(6);
  const state = task => ({ task, skills: catalog.skills.map((s, i) => ({ index: i, name: s.name, description: s.description })) });
  const questions = skillQuestions(catalog.skills);
  const resolver = localSkillResolver();

  assert.equal(resolver(state(KOREAN), questions), null); // signal 0
  // Signal above 0 but below minCoverage: one known token is a BM25 hit, so it answers (it used to abstain).
  const mixedTask = 'PDF 보고서에서 표를 뽑아 주세요';
  assert.ok(lexicalCoverage(mixedTask, catalog.skills) > 0 && lexicalCoverage(mixedTask, catalog.skills) < 0.25);
  assert.ok(resolver(state(mixedTask), questions).need.noul > 0);
  const answers = resolver(state(ENGLISH), questions);
  assert.ok(answers.need.noul > 0 && answers.skill_0.noul === answers.need.noul);

  // The caller's catalog-level statistic decides, and only its zero abstains: minCoverage is not a floor here.
  assert.ok(resolver(state(ENGLISH), questions, { lexical: { signal: 0.1, minCoverage: 0.25 } }).need.noul > 0);
  assert.equal(resolver(state(ENGLISH), questions, { lexical: { signal: 0, minCoverage: 0 } }), null);
  assert.ok(resolver(state('PDF 보고서에서 표를 뽑아 주세요'), questions, { lexical: { signal: 0.3, minCoverage: 0.25 } }).need.noul > 0);
  // Malformed hints are ignored, not trusted.
  assert.ok(resolver(state(ENGLISH), questions, { lexical: { signal: 'high', minCoverage: -1 } }).need.noul > 0);

  // LocalJudge hands the limits through and turns the abstention into LOCAL_ABSTAIN.
  const seen = [];
  const judge = new LocalJudge({ [SKILLS_POINT]: (s, q, limits) => { seen.push(limits); return resolver(s, q, limits); } });
  await assert.rejects(judge.evaluate(state(KOREAN), questions, 's', { pointId: SKILLS_POINT, lexical: { signal: 0, minCoverage: 0.25 } }), code('LOCAL_ABSTAIN'));
  assert.deepEqual(seen[0].lexical, { signal: 0, minCoverage: 0.25 });
  assert.equal((await judge.evaluate(state(ENGLISH), questions, 's', { pointId: SKILLS_POINT })).response.model, 'local-rules');
});

test('standalone local reports unavailable on a task it cannot read, in every retrieval mode', async () => {
  const catalog = many(10);
  const judge = new LocalJudge({ [SKILLS_POINT]: localSkillResolver() });
  for (const retrieval of RETRIEVAL_MODES) {
    const config = { ...BASE, retrieval, chunk: 4, need: 0.1, autoLoad: 0.3, suggest: 0.2 };
    const blind = await selectSkills({ task: KOREAN, catalog, judge, scope: 's', config });
    assert.deepEqual([blind.status, blind.code, blind.need], ['unavailable', 'LOCAL_ABSTAIN', null], retrieval);
    assert.deepEqual(blind.load, []);
    // With signal it answers; in wide modes the chunks without a matching skill answer 0 rather than abstain.
    const seen = await selectSkills({ task: ENGLISH, catalog, judge, scope: 's', config });
    assert.equal(seen.status, 'selected', retrieval);
    assert.equal(seen.load[0].name, 's00');
    assert.equal(seen.retrieval.failed, 0);
  }
});

test('a local,jev chain escalates exactly where the local judge is blind', async t => {
  const f = await fixture(t);
  f.config.kernel.points[SKILLS_POINT] = { mode: 'active', judges: ['local', 'jev'], escalateBelow: 0 };
  const jevCalls = [];
  const client = { evaluate: async (state, questions) => {
    jevCalls.push(state);
    const response = answer(questions);
    for (const id of Object.keys(questions)) response.answers[id] = { type: 'noul', noul: id === 'need' ? 0.9 : state.skills[Number(id.slice(6))].name === 's04' ? 0.95 : 0.05 };
    return { response, cached: false, latencyMs: 0 };
  } };
  const log = new DecisionLog(decisionLogDir(f.config));
  const kernel = createKernel(f.config, { client, log, localResolvers: { [SKILLS_POINT]: localSkillResolver() } });
  const catalog = many(6);
  const run = (task, extra = {}) => selectSkills({ task, catalog, judge: kernel.forPoint(SKILLS_POINT), scope: 's', config: { ...kernel.kernel.skills, ...extra } });

  // English task: the local judge has signal and answers; Jev is not asked (escalateBelow is 0).
  const english = await run(ENGLISH);
  assert.equal(jevCalls.length, 0);
  assert.equal(english.retrieval.lexicalSignal, 1);

  // Korean task: before this change local answered need 0 with confidence 1 and the chain stopped there.
  const korean = await run(KOREAN);
  assert.equal(jevCalls.length, 1);
  assert.equal(korean.status, 'selected');
  assert.deepEqual(korean.load.map(x => x.name), ['s04']);
  const record = (await log.read()).decisions.find(d => d.decisionId === korean.decisionId);
  assert.equal(record.provider, 'jev');
  assert.deepEqual(record.trail.map(step => [step.provider, step.ok, step.code]), [['local', false, 'LOCAL_ABSTAIN'], ['jev', true, undefined]]);

  // Adaptive: the same task goes wide, and every chunk escalates the same way.
  const wide = await run(KOREAN, { retrieval: 'adaptive', chunk: 4 });
  assert.equal(wide.retrieval.requests, 2);
  assert.equal(jevCalls.length, 3);
  assert.deepEqual(wide.load.map(x => x.name), ['s04']);
});

// ---------------------------------------------------------------- hooks

const store = f => new SessionStore(f.config, f.project, 'claude', 'session-test');
const skillsEvents = async f => (await store(f).events()).filter(x => x.type === 'skills');
async function addSkill(project, folder, description) {
  const dir = path.join(project, '.claude', 'skills', folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${folder}\ndescription: ${description}\n---\nBODY\n`);
}
/** Hook judge: answers classification like the fixtures do and skills questions by skill name. */
function hookJudge(probabilities) {
  const calls = [];
  return {
    calls,
    async evaluate(state, questions, scope, limits) {
      calls.push({ state, questions, limits });
      const response = answer(questions);
      if (Object.hasOwn(questions, 'need')) {
        for (const id of Object.keys(questions)) {
          response.answers[id] = { type: 'noul', noul: id === 'need' ? 0.95 : probabilities[state.skills[Number(id.slice(6))].name] ?? 0.05 };
        }
      }
      return { response, cached: false, latencyMs: 0 };
    },
  };
}
const skillCalls = judge => judge.calls.filter(c => Object.hasOwn(c.questions, 'need'));
const koreanEvent = (project, id = 'tool-1') => event(project, 'claude', {
  tool_use_id: id, tool_input: { prompt: '알림 설정 화면에 켜고 끄는 스위치를 구현해 주세요.', subagent_type: 'general-purpose', description: 'toggle', run_in_background: true },
});
async function nineSkills(t) {
  const f = await fixture(t);
  await addSkill(f.project, 'notification-toggle', 'Implement a notification toggle setting.');
  for (let i = 0; i < 8; i++) await addSkill(f.project, `zz-other-${i}`, `Unrelated procedure number ${i}.`);
  f.config.kernel.points[SKILLS_POINT].mode = 'active';
  return f;
}

test('hook: the default retrieval is full, so a Korean task reaches the judge with the whole catalog in one request', async t => {
  const f = await nineSkills(t);
  const judge = hookJudge({ 'notification-toggle': 0.95 });
  await handleHook(koreanEvent(f.project), 'claude', { config: f.config, client: judge });
  const sent = skillCalls(judge);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state.skills.length, 9);
  const [logged] = await skillsEvents(f);
  assert.deepEqual(logged.retrieval, { mode: 'full', wide: true, lexicalSignal: 0, requests: 1, failed: 0, judged: 9, dropped: 0 });
  assert.equal(logged.decisionIds.length, 1);
  assert.equal(logged.decisionId, logged.decisionIds[0]);
});

test('hook: an explicit lexical setting still sends a Korean task as one request with the first candidates', async t => {
  const f = await nineSkills(t);
  f.config.kernel.skills = { ...f.config.kernel.skills, retrieval: 'lexical' };
  const judge = hookJudge({ 'notification-toggle': 0.95 });
  await handleHook(koreanEvent(f.project), 'claude', { config: f.config, client: judge });
  const sent = skillCalls(judge);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].state.skills.length, 8);
  const [logged] = await skillsEvents(f);
  assert.deepEqual(logged.retrieval, { mode: 'lexical', wide: false, lexicalSignal: 0, requests: 1, failed: 0, judged: 8, dropped: 1 });
});

test('hook: a config written before the retrieval settings existed behaves exactly like an explicit full config', async t => {
  const outputs = [];
  for (const variant of ['older', 'explicit']) {
    const f = await nineSkills(t);
    const { retrieval, minCoverage, maxJudged, chunk, ...older } = f.config.kernel.skills;
    f.config.kernel.skills = variant === 'older' ? older : { ...older, retrieval: 'full', minCoverage, maxJudged, chunk };
    const judge = hookJudge({ 'notification-toggle': 0.95 });
    const steps = [];
    for (const raw of [event(f.project), event(f.project), koreanEvent(f.project, 'tool-2')]) {
      steps.push(JSON.stringify(await handleHook(raw, 'claude', { config: f.config, client: judge })));
    }
    // Fixture paths and the ids hashed from them differ per run; the hook outputs and every skills
    // request (state and questions) must otherwise match byte for byte.
    assert.equal(judge.calls.length, 6);
    const text = JSON.stringify({ steps, calls: skillCalls(judge).map(c => ({ state: c.state, questions: c.questions })) })
      .replaceAll(f.root, '<root>').replace(/[0-9a-f]{64}/g, '<hash>');
    outputs.push(text);
    assert.ok(text.includes('jev-skills'));
  }
  assert.equal(outputs[0], outputs[1]);
});

test('hook: adaptive retrieval fans a Korean task out, records every decision id and replays the same block', async t => {
  const f = await nineSkills(t);
  f.config.kernel.skills = { ...f.config.kernel.skills, retrieval: 'adaptive', maxJudged: 32, chunk: 4 };
  const judge = hookJudge({ 'zz-other-7': 0.95 });
  const deps = { config: f.config, client: judge };
  const raw = koreanEvent(f.project);
  const out = await handleHook(raw, 'claude', deps);

  // 9 skills in requests of at most 4 -> 3 requests of 3, next to the usual classification and profile calls.
  const sent = skillCalls(judge);
  assert.deepEqual(sent.map(c => c.state.skills.length), [3, 3, 3]);
  assert.equal(judge.calls.length, 5);
  for (const c of sent) assert.ok(c.limits.timeoutMs <= f.config.optimization.routeDeadlineMs);
  const task = await store(f).getTask('tool-1');
  assert.match(task.skillsText, /^<jev-skills>\n\{"load":\[\{"name":"zz-other-7","path":"\.claude\/skills\/zz-other-7\/SKILL\.md","p":0\.95\}\],"consider":\[\]\}\n<\/jev-skills>\n/);
  assert.ok(out.hookSpecificOutput.updatedInput.prompt.endsWith(task.skillsText));

  const [logged] = await skillsEvents(f);
  assert.deepEqual(logged.retrieval, { mode: 'adaptive', wide: true, lexicalSignal: 0, requests: 3, failed: 0, judged: 9, dropped: 0 });
  assert.equal(logged.candidates, 9);
  assert.equal(logged.injected, true);
  assert.equal(new Set(logged.decisionIds).size, 3);
  assert.equal(logged.trace.length, 9);
  assert.ok(logged.trace.every(x => Object.keys(x).sort().join() === 'name,probability,stage'));
  const records = (await new DecisionLog(decisionLogDir(f.config)).read()).decisions.filter(d => d.pointId === SKILLS_POINT);
  assert.deepEqual(new Set(records.map(d => d.decisionId)), new Set(logged.decisionIds));
  // The session state holds names and numbers only.
  assert.ok(!JSON.stringify(logged).includes('Unrelated procedure') && !JSON.stringify(logged).includes('알림'));

  // Replays reuse the stored text and never judge again.
  assert.deepEqual(await handleHook(raw, 'claude', deps), out);
  assert.deepEqual(await handleHook({ ...raw, tool_input: out.hookSpecificOutput.updatedInput }, 'claude', deps), out);
  assert.equal(judge.calls.length, 5);

  // An English task with lexical signal keeps the single lexical request under the same config.
  const english = hookJudge({ 'notification-toggle': 0.95 });
  await handleHook(event(f.project, 'claude', { tool_use_id: 'tool-2' }), 'claude', { config: f.config, client: english });
  assert.deepEqual(skillCalls(english).map(c => c.state.skills.length), [8]);
  const second = (await skillsEvents(f)).find(x => x.taskId === 'tool-2');
  assert.equal(second.retrieval.wide, false);
  assert.ok(second.retrieval.lexicalSignal >= 0.25);
});

test('hook: a chunk that misses the shared judge budget is dropped, the others count and the route is unaffected', async t => {
  const f = await nineSkills(t);
  f.config.kernel.skills = { ...f.config.kernel.skills, retrieval: 'full', maxJudged: 32, chunk: 4 };
  // Chain budget 200 ms (Jev's timeout) inside a 1000 ms route deadline, as in the default 1200 / 3000 split.
  f.config.timeoutMs = 200;
  f.config.optimization.routeDeadlineMs = 1000;
  const inner = hookJudge({ 'zz-other-7': 0.95, 'notification-toggle': 0.95 });
  let n = 0;
  const judge = {
    calls: inner.calls,
    async evaluate(state, questions, scope, limits) {
      // The first skills request hangs past the deadline; the others answer.
      if (Object.hasOwn(questions, 'need') && n++ === 0) await sleep(700);
      return inner.evaluate(state, questions, scope, limits);
    },
  };
  const started = performance.now();
  const out = await handleHook(koreanEvent(f.project), 'claude', { config: f.config, client: judge });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 600, `hook returned after ${elapsed} ms`);
  assert.ok(out.hookSpecificOutput.updatedInput, 'the route itself is unaffected');
  const [logged] = await skillsEvents(f);
  assert.equal(logged.retrieval.requests, 3);
  assert.equal(logged.retrieval.failed, 1);
  assert.equal(logged.status, 'selected');
  assert.equal(logged.trace.filter(x => x.stage === 'judge_unavailable').length, 3);
  for (const c of skillCalls(judge)) assert.ok(c.limits.timeoutMs <= 200);
  await sleep(500);

  // When nothing is back by the route deadline itself, skills are unavailable as with a single request.
  const g = await nineSkills(t);
  g.config.kernel.skills = { ...g.config.kernel.skills, retrieval: 'full', maxJudged: 32, chunk: 4 };
  g.config.optimization.routeDeadlineMs = 200;
  const slow = hookJudge({});
  const hung = { calls: slow.calls, async evaluate(state, questions, scope, limits) {
    if (Object.hasOwn(questions, 'need')) await sleep(500);
    return slow.evaluate(state, questions, scope, limits);
  } };
  const began = performance.now();
  await handleHook(koreanEvent(g.project), 'claude', { config: g.config, client: hung });
  assert.ok(performance.now() - began < 450);
  const [late] = await skillsEvents(g);
  assert.deepEqual([late.status, late.code], ['unavailable', 'SKILLS_DEADLINE']);
  await sleep(400);
});

// ---------------------------------------------------------------- config, env, CLI

test('retrieval settings can be set from the environment and reject bad values with typed codes', async t => {
  const f = await fixture(t);
  const dir = path.join(f.home, '.config', 'jev-hooks');
  const file = path.join(dir, 'config.json');
  await writeJSON(file, structuredClone(f.config));

  assert.deepEqual((await loadConfig(file, {})).config.kernel.skills, kernelDefaults().skills);
  const { config } = await loadConfig(file, { JEV_SKILLS_RETRIEVAL: 'adaptive', JEV_SKILLS_MIN_COVERAGE: '0.4', JEV_SKILLS_MAX_JUDGED: '120', JEV_SKILLS_CHUNK: '16' });
  assert.deepEqual(config.kernel.skills, { ...kernelDefaults().skills, retrieval: 'adaptive', minCoverage: 0.4, maxJudged: 120, chunk: 16 });
  for (const [env, expected] of [
    [{ JEV_SKILLS_RETRIEVAL: 'full' }, { retrieval: 'full' }], [{ JEV_SKILLS_MIN_COVERAGE: '0' }, { minCoverage: 0 }], [{ JEV_SKILLS_MIN_COVERAGE: '1.0' }, { minCoverage: 1 }],
    [{ JEV_SKILLS_MAX_JUDGED: '256' }, { maxJudged: 256 }], [{ JEV_SKILLS_MAX_JUDGED: '8' }, { maxJudged: 8 }], [{ JEV_SKILLS_CHUNK: '8' }, { chunk: 8 }], [{ JEV_SKILLS_CHUNK: '64' }, { chunk: 64 }],
    [{ JEV_SKILLS_MAX_JUDGED: '400', JEV_SKILLS_CHUNK: '64' }, { maxJudged: 400, chunk: 64 }], [{ JEV_SKILLS_MAX_JUDGED: '32', JEV_SKILLS_CHUNK: '4' }, { maxJudged: 32, chunk: 4 }],
  ]) {
    assert.deepEqual((await loadConfig(file, env)).config.kernel.skills, { ...kernelDefaults().skills, ...expected }, JSON.stringify(env));
  }
  // The private .env works too and the process environment wins.
  await fs.writeFile(path.join(dir, '.env'), 'JEV_SKILLS_RETRIEVAL=full\nJEV_SKILLS_CHUNK=8\n', { mode: 0o600 });
  assert.deepEqual([(await loadConfig(file, {})).config.kernel.skills.retrieval, (await loadConfig(file, {})).config.kernel.skills.chunk], ['full', 8]);
  assert.equal((await loadConfig(file, { JEV_SKILLS_RETRIEVAL: 'lexical' })).config.kernel.skills.retrieval, 'lexical');
  await fs.rm(path.join(dir, '.env'));

  for (const [key, value] of [
    ['JEV_SKILLS_RETRIEVAL', 'wide'], ['JEV_SKILLS_RETRIEVAL', 'FULL'], ['JEV_SKILLS_RETRIEVAL', 'lexical,full'],
    ['JEV_SKILLS_MIN_COVERAGE', '1.1'], ['JEV_SKILLS_MIN_COVERAGE', '-0.1'], ['JEV_SKILLS_MIN_COVERAGE', '.25'], ['JEV_SKILLS_MIN_COVERAGE', '2e-1'], ['JEV_SKILLS_MIN_COVERAGE', '25%'],
    ['JEV_SKILLS_MAX_JUDGED', '0'], ['JEV_SKILLS_MAX_JUDGED', '401'], ['JEV_SKILLS_MAX_JUDGED', '64.0'], ['JEV_SKILLS_MAX_JUDGED', '1e2'], ['JEV_SKILLS_MAX_JUDGED', 'all'],
    ['JEV_SKILLS_CHUNK', '3'], ['JEV_SKILLS_CHUNK', '65'], ['JEV_SKILLS_CHUNK', '-8'], ['JEV_SKILLS_CHUNK', '8 '.trim() + 'x'],
  ]) {
    await assert.rejects(loadConfig(file, { [key]: value }), code('INVALID_' + key), `${key}=${value}`);
  }
  // In range on its own but inconsistent with maxCandidates (8): the combined config is still refused.
  await assert.rejects(loadConfig(file, { JEV_SKILLS_MAX_JUDGED: '7' }), code('INVALID_KERNEL_SKILLS_MAX_JUDGED'));
  // Each in range on its own, but together more than MAX_SKILL_REQUESTS (8) requests per delegation.
  for (const env of [{ JEV_SKILLS_MAX_JUDGED: '400' }, { JEV_SKILLS_CHUNK: '4' }, { JEV_SKILLS_MAX_JUDGED: '400', JEV_SKILLS_CHUNK: '4' }, { JEV_SKILLS_MAX_JUDGED: '257' }]) {
    await assert.rejects(loadConfig(file, env), code('INVALID_KERNEL_SKILLS_FANOUT'), JSON.stringify(env));
  }
});

test('skills CLI: --retrieval, and the local judge abstaining on a task it cannot read', async t => {
  const f = await fixture(t);
  await addSkill(f.project, 'pdf-merge', 'Merge and split pdf documents into one pdf file');
  for (let i = 0; i < 13; i++) await addSkill(f.project, `zz-other-${String(i).padStart(2, '0')}`, `Unrelated procedure number ${i}.`);
  const run = (...args) => child(process.execPath, [SCRIPT, '--project', f.project, ...args]);

  const byDefault = JSON.parse((await run('--task', 'merge pdf documents into one pdf file')).stdout);
  assert.deepEqual(byDefault.retrieval, { mode: 'full', wide: true, lexicalSignal: 1, requests: 1, failed: 0, judged: 14, dropped: 0 });
  assert.equal(byDefault.trace[0].name, 'pdf-merge');

  const lexical = JSON.parse((await run('--task', 'merge pdf documents into one pdf file', '--retrieval', 'lexical')).stdout);
  assert.deepEqual(lexical.retrieval, { mode: 'lexical', wide: false, lexicalSignal: 1, requests: 1, failed: 0, judged: 12, dropped: 2 });
  assert.equal(lexical.trace[0].name, 'pdf-merge');

  const full = JSON.parse((await run('--task', 'merge pdf documents into one pdf file', '--retrieval', 'full')).stdout);
  assert.equal(full.retrieval.wide, true);
  assert.equal(full.retrieval.judged, 14);
  assert.equal(full.retrieval.dropped, 0);
  assert.ok(full.trace.every(x => x.stage !== 'retrieval'));

  const blind = JSON.parse((await run('--task', '문서 두 개를 하나로 합쳐 주세요')).stdout);
  assert.deepEqual([blind.status, blind.code, blind.retrieval.lexicalSignal], ['unavailable', 'LOCAL_ABSTAIN', 0]);
  const why = JSON.parse((await run('--task', '문서 두 개를 하나로 합쳐 주세요', '--why-not', 'pdf-merge')).stdout);
  assert.equal(why.whyNot.reason, 'judge_failed_nothing_loaded');

  const bad = await run('--task', 'x', '--retrieval', 'semantic');
  assert.deepEqual([bad.code, bad.stderr.trim(), bad.stdout], [1, 'INVALID_RETRIEVAL', '']);
});

// ---------------------------------------------------------------- regressions from the independent review

test('the local judge still answers a same-language task whose coverage is low: small catalog, long delegation brief', async () => {
  // Coverage falls with task length and with a small catalog vocabulary. Abstaining below minCoverage
  // made the local-only resolver answer none of these although BM25 has a clear best match.
  const catalog = catalogOf([
    ['pdf-merge', 'Merge and split pdf documents into one pdf file'],
    ['deploy', 'Ship services to production'],
    ['release-notes', 'Write release notes from merged changes'],
  ]);
  const brief = 'You are a careful engineer working inside an existing repository. Read the surrounding code before changing anything, '
    + 'keep the patch minimal, follow the house style, never touch unrelated modules, and report exactly what you verified at the end. '
    + 'Task: merge the three quarterly pdf documents into a single pdf. Constraints: no new dependencies, no network access, '
    + 'keep every existing test green, explain each trade-off briefly, and stop to ask whenever a requirement looks ambiguous or unsafe.';
  const signal = lexicalCoverage(brief, catalog.skills);
  assert.ok(signal > 0 && signal < DEFAULT_RETRIEVAL.minCoverage, `coverage ${signal}`);
  assert.equal(bm25Rank(brief, catalog.skills)[0].skill.name, 'pdf-merge');
  const judge = new LocalJudge({ [SKILLS_POINT]: localSkillResolver() });
  for (const retrieval of RETRIEVAL_MODES) {
    const result = await selectSkills({ task: brief, catalog, judge, scope: 's', config: { ...BASE, retrieval, need: 0.1, autoLoad: 0.3, suggest: 0.2 } });
    assert.deepEqual([result.status, result.code, result.retrieval.failed], ['selected', undefined, 0], retrieval);
    assert.equal(result.load[0].name, 'pdf-merge', retrieval);
  }
});

test('the fan-out is bounded: validateKernel refuses more than 8 requests per delegation and selectSkills never sends more', async t => {
  const f = await fixture(t);
  const withSkills = extra => ({ ...f.config, kernel: { ...f.config.kernel, skills: { ...f.config.kernel.skills, ...extra } } });
  for (const [maxJudged, chunk] of [[400, 4], [400, 32], [64, 4], [65, 8]]) {
    for (const retrieval of RETRIEVAL_MODES) { // refused whatever the mode is now: the env can switch the mode later
      assert.throws(() => createKernel(withSkills({ retrieval, maxJudged, chunk })), code('INVALID_KERNEL_SKILLS_FANOUT'), `${maxJudged}/${chunk}`);
    }
  }
  for (const [maxJudged, chunk] of [[400, 64], [256, 32], [64, 8], [32, 4], [64, 32]]) createKernel(withSkills({ retrieval: 'full', maxJudged, chunk }));

  // A caller that bypasses the kernel validation is clamped, and the cut is reported, not silent.
  const judge = mockJudge({ s00: 0.95 });
  const result = await selectSkills({ task: ENGLISH, catalog: many(60), judge, scope: 's', config: { ...BASE, retrieval: 'full', maxJudged: 64, chunk: 4 } });
  assert.equal(judge.calls.length, 8);
  assert.deepEqual(result.retrieval, { mode: 'full', wide: true, lexicalSignal: 1, requests: 8, failed: 0, judged: 32, dropped: 28 });
  assert.equal(result.load[0].name, 's00');
});

test('a wide mode is refused when one delegation could use more than a quarter of the per-session auxiliary request cap', async t => {
  const f = await fixture(t);
  const dir = path.join(f.home, '.config', 'jev-hooks');
  const file = path.join(dir, 'config.json');
  const write = async (skills, cap, mode = 'off') => {
    const c = structuredClone(f.config);
    c.kernel.skills = { ...c.kernel.skills, ...skills };
    c.kernel.points[SKILLS_POINT].mode = mode;
    c.circuit.maxRequestsPerSession = cap;
    await writeJSON(file, c);
  };
  // 8 requests per delegation: needs a cap of at least 32.
  await write({ retrieval: 'full', maxJudged: 64, chunk: 8 }, 31, 'active');
  await assert.rejects(loadConfig(file, {}), code('INVALID_KERNEL_SKILLS_FANOUT_CAP'));
  await write({ retrieval: 'adaptive', maxJudged: 64, chunk: 8 }, 31, 'shadow');
  await assert.rejects(loadConfig(file, {}), code('INVALID_KERNEL_SKILLS_FANOUT_CAP'));
  await write({ retrieval: 'full', maxJudged: 64, chunk: 8 }, 32, 'active');
  assert.equal((await loadConfig(file, {})).config.kernel.skills.retrieval, 'full');
  // The check applies only while delegation.skills is on. The shipped default is 'full' with the point off,
  // so an install that never routes skills loads with any cap, exactly as before the default changed.
  await write({}, 1);
  assert.equal((await loadConfig(file, {})).config.kernel.skills.retrieval, 'full');
  assert.equal((await loadConfig(file, { JEV_SKILLS_RETRIEVAL: 'adaptive' })).config.kernel.points[SKILLS_POINT].mode, 'off');
  // Turning the point on (config or env) with the default 'full' needs room for four delegations of two requests.
  for (const mode of ['shadow', 'active']) await assert.rejects(loadConfig(file, { JEV_SKILLS_MODE: mode }), code('INVALID_KERNEL_SKILLS_FANOUT_CAP'), mode);
  await write({}, 7);
  await assert.rejects(loadConfig(file, { JEV_SKILLS_MODE: 'active' }), code('INVALID_KERNEL_SKILLS_FANOUT_CAP'));
  await write({}, 8);
  assert.equal((await loadConfig(file, { JEV_SKILLS_MODE: 'active' })).config.kernel.skills.retrieval, 'full');
  // lexical sends one request per delegation and keeps working with any cap.
  await write({}, 1);
  assert.equal((await loadConfig(file, { JEV_SKILLS_MODE: 'active', JEV_SKILLS_RETRIEVAL: 'lexical' })).config.kernel.skills.retrieval, 'lexical');
});

test('one wide delegation leaves the auxiliary budget usable: later delegations still get their requests', async t => {
  const f = await fixture(t);
  const s = await jevServer(t, { s07: 0.95 });
  Object.assign(f.config, { endpoint: s.endpoint, allowLoopback: true, cacheTtlMs: 0 });
  f.config.kernel.points[SKILLS_POINT] = { mode: 'active', judges: ['jev'], escalateBelow: 0 };
  // The largest fan-out validation accepts, on a 400-skill catalog, with the default cap of 100.
  f.config.kernel.skills = { ...f.config.kernel.skills, retrieval: 'full', maxJudged: 400, chunk: 64 };
  const kernel = createKernel(f.config, { apiKey: 'fixture-key' });
  const catalog = catalogOf(Array.from({ length: 400 }, (_, i) => [`s${String(i).padStart(3, '0')}`, `procedure ${i}`]));
  const run = task => selectSkills({ task, catalog, judge: kernel.forPoint(SKILLS_POINT), scope: 'scope-budget', config: kernel.kernel.skills, limits: { timeoutMs: 3000 } });
  const first = await run('첫 번째 작업');
  assert.deepEqual([first.retrieval.requests, first.retrieval.failed, first.retrieval.judged], [7, 0, 400]);
  const second = await run('두 번째 작업');
  assert.deepEqual([second.status === 'unavailable', second.retrieval.failed], [false, 0]);
  assert.equal(s.requests.length, 14);
  const control = path.join(f.config.stateDir, 'request-control', hash({ scope: 'scope-budget', endpoint: f.config.endpoint, account: hash('fixture-key'), bucket: 'auxiliary' }) + '.json');
  assert.equal((await readJSON(control)).requests, 14); // 86 of the 100 left for supervisor.outcome and later delegations
});

test('real client: the chunks of one decision share its deadline and count as one circuit failure', async t => {
  const f = await fixture(t);
  const started = [];
  const s = await server(t, async (req, res, parsed) => { started.push(performance.now()); await sleep(900); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(answer(parsed.questions))); });
  Object.assign(f.config, { endpoint: s.endpoint, allowLoopback: true, cacheTtlMs: 0, timeoutMs: 3000 });
  f.config.circuit.failureThreshold = 3;
  f.config.kernel.points[SKILLS_POINT] = { mode: 'active', judges: ['jev'], escalateBelow: 0 };
  f.config.kernel.skills = { ...f.config.kernel.skills, retrieval: 'full', maxJudged: 32, chunk: 4 };
  const kernel = createKernel(f.config, { apiKey: 'fixture-key' });
  const scope = 'scope-deadline';
  const control = () => readJSON(path.join(f.config.stateDir, 'request-control', hash({ scope, endpoint: f.config.endpoint, account: hash('fixture-key'), bucket: 'auxiliary' }) + '.json'));
  const began = performance.now();
  // 12 skills -> 3 requests against a judge that needs 900 ms, with a 200 ms allowance and a 3000 ms client timeout.
  const result = await selectSkills({ task: KOREAN, catalog: many(12), judge: kernel.forPoint(SKILLS_POINT), scope, config: kernel.kernel.skills, limits: { timeoutMs: 200 } });
  const elapsed = performance.now() - began;
  assert.ok(elapsed < 600, `returned after ${elapsed} ms`);
  assert.deepEqual([result.status, result.retrieval.requests, result.retrieval.failed], ['unavailable', 3, 3]);
  assert.ok(['SKILLS_DEADLINE', 'JEV_TIMEOUT'].includes(result.code), result.code);
  // The requests were aborted at the shared deadline, not at the client's own 3000 ms timeout: well before
  // the judge would have answered, all three are booked as failed - as ONE failure, so the circuit stays closed.
  await sleep(250);
  const info = await control();
  assert.deepEqual([info.requests, info.failures, info.openUntil], [3, 1, 0]);
  assert.equal(started.length, 3);
  for (const at of started) assert.ok(at - began < 200 + 50, 'no request starts after the shared deadline');
  await sleep(300);
  assert.equal(started.length, 3); // and nothing is sent after the result was returned

  // Three separate failing decisions still open the circuit, exactly as three failing lexical requests would.
  for (const n of [2, 3]) await selectSkills({ task: `${KOREAN} ${n}`, catalog: many(12), judge: kernel.forPoint(SKILLS_POINT), scope, config: kernel.kernel.skills, limits: { timeoutMs: 120 } });
  await sleep(200);
  const after = await control();
  assert.equal(after.failures, 3);
  assert.ok(after.openUntil > Date.now());
  const refused = await selectSkills({ task: `${KOREAN} 4`, catalog: many(12), judge: kernel.forPoint(SKILLS_POINT), scope, config: kernel.kernel.skills, limits: { timeoutMs: 120 } });
  assert.deepEqual([refused.status, refused.code], ['unavailable', 'JEV_CIRCUIT_OPEN']);
  assert.equal(started.length, 9);
});

test('real client: a request whose turn comes after the shared deadline is neither sent nor counted', async t => {
  const f = await fixture(t);
  const s = await jevServer(t, {});
  Object.assign(f.config, { endpoint: s.endpoint, allowLoopback: true, cacheTtlMs: 0 });
  f.config.kernel.points[SKILLS_POINT] = { mode: 'active', judges: ['jev'], escalateBelow: 0 };
  f.config.kernel.skills = { ...f.config.kernel.skills, retrieval: 'full', maxJudged: 32, chunk: 4 };
  const kernel = createKernel(f.config, { apiKey: 'fixture-key' });
  const scope = 'scope-late';
  const controlFile = path.join(f.config.stateDir, 'request-control', hash({ scope, endpoint: f.config.endpoint, account: hash('fixture-key'), bucket: 'auxiliary' }) + '.json');
  // Hold the request-control lock so that no chunk can be counted until after the 80 ms allowance.
  await fs.mkdir(controlFile + '.lock', { recursive: true });
  const release = setTimeout(() => fs.rm(controlFile + '.lock', { recursive: true, force: true }), 200);
  t.after(() => clearTimeout(release));
  const result = await selectSkills({ task: KOREAN, catalog: many(12), judge: kernel.forPoint(SKILLS_POINT), scope, config: kernel.kernel.skills, limits: { timeoutMs: 80 } });
  assert.equal(result.status, 'unavailable');
  await sleep(450);
  assert.equal(s.requests.length, 0);
  assert.equal((await readJSON(controlFile, { requests: 0 })).requests, 0);
});

test('a partial failure that ends with nothing selected is not reported as a clean negative', async () => {
  const catalog = many(8);
  const config = { ...BASE, retrieval: 'full', chunk: 4 };
  // The request holding the only lexical match (s00, BM25 rank 1) times out; the other answers "no skill needed".
  const judge = mockJudge({}, { need: 0.05, behave: async (index, state) => {
    if (state.skills.some(x => x.name === 's00')) throw Object.assign(new Error('JEV_TIMEOUT'), { code: 'JEV_TIMEOUT' });
  } });
  const gated = await selectSkills({ task: ENGLISH, catalog, judge, scope: 's', config });
  assert.deepEqual([gated.status, gated.code, gated.partial, gated.failedCode, gated.need], ['none', 'JEV_TIMEOUT', true, 'JEV_TIMEOUT', 0.05]);
  assert.equal(gated.retrieval.failed, 1);
  assert.equal(whyNot(gated, 's00').stage, 'judge_unavailable');

  // Need gate open but nothing above the thresholds: same marking.
  const open = mockJudge({}, { need: 0.9, behave: async (index, state) => {
    if (state.skills.some(x => x.name === 's00')) throw Object.assign(new Error('JEV_HTTP_503'), { code: 'JEV_HTTP_503' });
  } });
  const below = await selectSkills({ task: ENGLISH, catalog, judge: open, scope: 's', config });
  assert.deepEqual([below.status, below.code, below.partial, below.failedCode], ['none', 'JEV_HTTP_503', true, 'JEV_HTTP_503']);

  // Something was still selected: the selection stands, flagged partial, without a failure code on the result.
  const some = mockJudge({ s05: 0.95 }, { behave: async (index, state) => {
    if (state.skills.some(x => x.name === 's00')) throw Object.assign(new Error('JEV_TIMEOUT'), { code: 'JEV_TIMEOUT' });
  } });
  const selected = await selectSkills({ task: ENGLISH, catalog, judge: some, scope: 's', config });
  assert.deepEqual([selected.status, selected.code, selected.partial, selected.failedCode], ['selected', undefined, true, 'JEV_TIMEOUT']);

  // No failure: neither field exists, so results of healthy decisions are unchanged.
  const clean = await selectSkills({ task: ENGLISH, catalog, judge: mockJudge({}, { need: 0.05 }), scope: 's', config });
  assert.deepEqual([clean.status, 'code' in clean, 'partial' in clean, 'failedCode' in clean], ['none', false, false, false]);
});

test('hook: the skills event says when a wide decision was only partly judged', async t => {
  const f = await nineSkills(t);
  f.config.kernel.skills = { ...f.config.kernel.skills, retrieval: 'full', maxJudged: 32, chunk: 4 };
  const inner = hookJudge({});
  let n = 0;
  const judge = { calls: inner.calls, async evaluate(state, questions, scope, limits) {
    if (Object.hasOwn(questions, 'need') && n++ === 0) throw Object.assign(new Error('JEV_HTTP_503'), { code: 'JEV_HTTP_503' });
    return inner.evaluate(state, questions, scope, limits);
  } };
  await handleHook(koreanEvent(f.project), 'claude', { config: f.config, client: judge });
  const [logged] = await skillsEvents(f);
  assert.deepEqual([logged.status, logged.code, logged.partial, logged.failedCode, logged.retrieval.failed], ['none', 'JEV_HTTP_503', true, 'JEV_HTTP_503', 1]);
  // A fully judged decision carries neither field.
  const g = await nineSkills(t);
  await handleHook(koreanEvent(g.project), 'claude', { config: g.config, client: hookJudge({}) });
  const [plain] = await skillsEvents(g);
  assert.deepEqual(['partial' in plain, 'failedCode' in plain], [false, false]);
});
