// Outcome collector: joins hook state with a session's transcripts. Every fixture is synthetic: the hook
// state is produced by the real hook code with an in-process mock judge, and the transcripts mimic the row
// shapes of a Claude Code desktop 2.1.330 session (conversation rows, request-log copies, attachment rows,
// agent-<id>.jsonl + .meta.json) with made-up text. Nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, answer, child } from './helpers.mjs';
import { handleHook } from '../src/hooks.mjs';
import { SessionStore } from '../src/state.mjs';
import { hash } from '../src/util.mjs';
import { importEvaluations, readEvidence } from '../src/feedback.mjs';
import { DecisionLog, decisionLogDir } from '../src/kernel/log.mjs';
import { calibrationReport, labelSourceInfo } from '../src/kernel/calibration.mjs';
import { selectSkills } from '../src/kernel/skills.mjs';
import { ObservationLog, isObservationRecord, observationReport, observationLogDir } from '../src/kernel/observations.mjs';
import { collect, taskHash, skillQuestionNames, parseVerification, parseSubagent, parseMain, parseJsonl, skillFoldersOf,
  MAX_TRANSCRIPT_BYTES, MAX_STATE_FILE_BYTES } from '../src/collector.mjs';

const COLLECT = fileURLToPath(new URL('../scripts/collect.mjs', import.meta.url));
const DECISIONS = fileURLToPath(new URL('../scripts/decisions.mjs', import.meta.url));
const SESSION = 'session-PRIVATE-ID';
const AGENT = 'a2172f571c38b5c59';
const A = 'toolu_PRIVATEcallA', B = 'toolu_PRIVATEcallB';
const TASK = 'TASK_MARKER Implement the notification toggle.';
const REPORT = 'REPORT_MARKER changed src/toggle.js\nand ran npm test: 12 passed, 0 failed.';
const TARGET = 'notification-toggle';
const VALIDATOR = { name: 'fixture-checker', version: '1.0.0' };
const ARTIFACT = 'ab'.repeat(32);
const code = expected => error => { assert.equal(error.code, expected); return true; };

// ---------------------------------------------------------------- judge

function judged(questions, state) {
  const response = answer(questions);
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'score') {
      const score = q.criteria.length - 1;
      response.answers[id] = { type: 'score', score, confidence: 1, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === score ? 1 : 0])) };
    }
    const m = /^skill_(\d+)$/.exec(id);
    if (m) response.answers[id] = { type: 'noul', noul: probabilityOf(state.skills[Number(m[1])].name) };
    if (id === 'need') response.answers[id] = { type: 'noul', noul: 0.9 };
  }
  return response;
}
// One distinct probability per skill name, so a wrong question -> name mapping cannot go unnoticed.
function probabilityOf(name) {
  if (name === TARGET) return 0.95;
  const n = Number(/(\d+)$/.exec(name)?.[1] ?? 0);
  return Number((0.01 + n * 0.005).toFixed(3));
}
function client() {
  const calls = [];
  return { calls, async evaluate(state, questions) { calls.push({ state, questions }); return { response: judged(questions, state), cached: false, latencyMs: 0 }; } };
}

// ---------------------------------------------------------------- hook state through the real hooks

const base = project => ({ session_id: SESSION, cwd: project, permission_mode: 'auto' });
async function addSkill(project, folder) {
  const dir = path.join(project, '.claude', 'skills', folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${folder}\ndescription: SKILL_DESCRIPTION_MARKER procedure for ${folder.replace(/-/g, ' ')}.\n---\nSKILL_BODY_MARKER\n`);
}
async function prepared(t, { extraSkills = 2, skills = 'active', supervisor = 'active' } = {}) {
  const f = await fixture(t);
  if (skills !== 'off') {
    await addSkill(f.project, TARGET);
    for (let i = 0; i < extraSkills; i++) await addSkill(f.project, `fx-skill-${String(i).padStart(2, '0')}`);
  }
  f.config.kernel.points['delegation.skills'].mode = skills;
  f.config.kernel.points['supervisor.outcome'].mode = supervisor;
  f.judge = client();
  f.deps = { config: f.config, apiKey: 'fixture-key', client: f.judge, runtimeEnv: {} };
  f.store = new SessionStore(f.config, f.project, 'claude', SESSION);
  f.stateDir = f.config.stateDir;
  f.transcripts = path.join(f.root, 'transcripts');
  await handleHook({ ...base(f.project), hook_event_name: 'UserPromptSubmit', prompt_id: 'p', prompt: 'GOAL_MARKER add a toggle', transcript_path: path.join(f.project, 't.jsonl') }, 'claude', f.deps);
  return f;
}
const preCall = (f, id, input) => ({ ...base(f.project), hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: id, tool_input: input });
const launched = (pre, agent) => ({ ...pre, hook_event_name: 'PostToolUse', tool_response: { isAsync: true, status: 'async_launched', agentId: agent, description: 'toggle',
  resolvedModel: 'fixture-model', prompt: pre.tool_input.prompt, canReadOutputFile: true } });
const handback = (f, agent, report = REPORT) => ({ ...base(f.project), hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', tool_use_id: 'toolu_handback_' + agent,
  agent_id: agent, agent_type: 'general-purpose', tool_input: { message: report }, tool_response: { success: true, message: 'Report delivered to your caller.' } });

/** Auto permission mode: call A is rewritten and refused, Main issues B with the hook's input, B launches, the agent hands back. */
async function refusedAndReissued(f, { a = A, b = B, agent = AGENT, text = TASK, report = true } = {}) {
  const first = preCall(f, a, { description: 'toggle', subagent_type: 'general-purpose', prompt: text });
  const routed = await handleHook(first, 'claude', f.deps);
  const updated = routed.hookSpecificOutput.updatedInput;
  assert.ok(updated, 'the first call is rewritten');
  const second = preCall(f, b, { description: updated.description, prompt: updated.prompt, subagent_type: updated.subagent_type });
  assert.deepEqual(await handleHook(second, 'claude', f.deps), {});
  await handleHook(launched(second, agent), 'claude', f.deps);
  await handleHook({ ...base(f.project), hook_event_name: 'SubagentStart', agent_id: agent, agent_type: updated.subagent_type }, 'claude', f.deps);
  if (report) await handleHook(handback(f, agent), 'claude', f.deps);
  return { first, second, route: (await f.store.getTask(a)).route };
}

// ---------------------------------------------------------------- synthetic transcripts in the observed shapes

const T0 = Date.now() - 3600000;
const at = seconds => new Date(T0 + seconds * 1000).toISOString();
const common = { userType: 'external', entrypoint: 'claude-desktop', cwd: '/PRIVATE/PATH/project', sessionId: 'HOST-SESSION-PRIVATE', version: '2.1.330', gitBranch: 'HEAD' };
const usage = (input, output, read, creation) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: creation });

/** calls: [{ id, input, at, refused?, agentId? }] */
function mainRows(calls, { stamp = true } = {}) {
  const rows = [{ type: 'queue-operation', operation: 'enqueue', content: 'QUEUE_TEXT_MARKER', sessionId: common.sessionId }];
  for (const call of calls) {
    const time = stamp ? { timestamp: at(call.at) } : {};
    rows.push({ ...common, ...time, type: 'assistant', isSidechain: false, effort: 'high',
      message: { model: 'main-model', id: 'msg_main_' + call.id, role: 'assistant', usage: usage(2, 500, 40000, 30000),
        content: [{ type: 'text', text: 'MAIN_TEXT_MARKER delegating' }, { type: 'tool_use', id: call.id, name: 'Agent', input: call.input }] } });
    // Request-log rows repeat the same tool_use under the same id; they must not be read.
    rows.push({ type: 'api-request', sessionId: common.sessionId, ...time, params: { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: 'Agent', input: { prompt: 'COPY' } }] }] } });
    rows.push({ ...common, ...(stamp ? { timestamp: at(call.at + 1) } : {}), type: 'user', permissionMode: 'auto',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, ...(call.refused ? { is_error: true } : {}), content: 'RESULT_TEXT_MARKER' }] },
      ...(call.refused ? { toolUseResult: 'Error: REFUSAL_TEXT_MARKER', permissionDecision: { decision: 'reject', reasonCode: 'classifier:auto-mode:unavailable' }, toolDenialKind: 'automode-unavailable' }
        : call.agentId ? { toolUseResult: { isAsync: true, status: 'async_launched', agentId: call.agentId, resolvedModel: 'fixture-model', prompt: 'COPY_OF_PROMPT_MARKER', outputFile: '/PRIVATE/PATH/out' }, permissionDecision: { decision: 'accept' } } : {}) });
  }
  return rows;
}
/** steps: [{ id, tools: [{ name, input }], usage? }] - one API message per step, written as one row per content block. */
function subRows({ agent = AGENT, prompt, steps, model, effort, start = 20, stamp = true, usageRows = true }) {
  const side = { ...common, isSidechain: true, agentId: agent };
  const time = n => (stamp ? { timestamp: at(start + n) } : {});
  const rows = [
    { ...side, ...time(0), type: 'user', parentUuid: null, message: { role: 'user', content: prompt } },
    { ...side, ...time(0), type: 'user', isMeta: true, message: { role: 'user', content: 'HARNESS_REMINDER_MARKER' } },
    { ...side, ...time(0), type: 'attachment', attachment: { type: 'skill_listing', names: ['LISTING_MARKER'], content: 'LISTING_TEXT_MARKER' } },
  ];
  let n = 1, toolId = 0;
  for (const step of steps) {
    const message = { role: 'assistant', id: step.id, ...(model ? { model } : {}), ...(usageRows ? { usage: step.usage ?? usage(2, 100, 1000, 10) } : {}) };
    rows.push({ ...side, ...time(n), type: 'assistant', ...(effort ? { effort } : {}), message: { ...message, content: [{ type: 'thinking', thinking: 'THINKING_MARKER' }] } });
    for (const tool of step.tools ?? []) {
      const id = `toolu_sub_${toolId += 1}`;
      rows.push({ ...side, ...time(n), type: 'assistant', ...(effort ? { effort } : {}), message: { ...message, content: [{ type: 'tool_use', id, name: tool.name, input: tool.input }] } });
      rows.push({ ...side, ...time(n + 1), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'TOOL_OUTPUT_MARKER' }] } });
    }
    rows.push({ type: 'api-request-blob', sessionId: common.sessionId, hash: 'x', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_copy', name: 'Skill', input: { skill: 'COPY' } }] } });
    n += 2;
  }
  return rows;
}
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const STEPS = [
  { id: 'msg_1', tools: [{ name: 'Skill', input: { skill: TARGET } }], usage: usage(2, 300, 0, 50000) },
  { id: 'msg_2', tools: [{ name: 'Write', input: { file_path: '/PRIVATE/PATH/project/src/toggle.js', content: 'FILE_BODY_MARKER' } }], usage: usage(3, 700, 50000, 2000) },
  { id: 'msg_3', tools: [{ name: 'SubagentHandback', input: { message: REPORT } }], usage: usage(4, 200, 52000, 500) },
];
async function writeTranscripts(f, { main, subs }) {
  await fs.rm(f.transcripts, { recursive: true, force: true });
  await fs.mkdir(path.join(f.transcripts, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(f.transcripts, 'main.jsonl'), typeof main === 'string' ? main : jsonl(main));
  for (const sub of subs) {
    await fs.writeFile(path.join(f.transcripts, 'subagents', `agent-${sub.agent}.jsonl`), typeof sub.rows === 'string' ? sub.rows : jsonl(sub.rows));
    if (sub.meta !== null) await fs.writeFile(path.join(f.transcripts, 'subagents', `agent-${sub.agent}.meta.json`),
      JSON.stringify(sub.meta ?? { agentType: sub.agentType, isBuiltIn: false, description: 'DESCRIPTION_MARKER', toolUseId: sub.toolUseId, model: sub.model, finished: true }));
  }
}
/** The whole auto-mode session: hook state plus matching transcripts. `sub` overrides what the subagent's rows say. */
async function reissuedSession(t, { extraSkills = 2, sub = {}, steps = STEPS, stamp = true, prepare = {} } = {}) {
  const f = await prepared(t, { extraSkills, ...prepare });
  const s = await refusedAndReissued(f);
  const model = Object.hasOwn(sub, 'model') ? sub.model : s.route.backend;
  const effort = Object.hasOwn(sub, 'effort') ? sub.effort : s.route.effort;
  await writeTranscripts(f, {
    main: mainRows([{ id: A, input: s.first.tool_input, at: 0, refused: true }, { id: B, input: s.second.tool_input, at: 10, agentId: AGENT }], { stamp }),
    subs: [{ agent: AGENT, rows: subRows({ prompt: s.second.tool_input.prompt, steps, model, effort, stamp, ...sub.rows }), agentType: s.second.tool_input.subagent_type, toolUseId: B, model }],
  });
  return { f, ...s };
}
const verificationFor = (text, extra = {}) => parseVerification([{ taskHash: taskHash(text), passed: true, conventionPassed: true, validator: VALIDATOR, artifactSha256: ARTIFACT, ...extra }]);
const withContext = (config, name = 'ctx-fixture-1') => ({ ...config, optimization: { ...config.optimization, evaluationContext: name } });
const run = (f, extra = {}) => collect({ stateDir: f.stateDir, transcriptsDir: f.transcripts, ...extra });
const logOf = f => new DecisionLog(decisionLogDir(f.config));
async function outputsText(f, summary) {
  let text = JSON.stringify(summary);
  for (const dir of [observationLogDir(f.config), path.join(f.stateDir, 'collector')]) {
    for (const name of await fs.readdir(dir).catch(() => [])) text += await fs.readFile(path.join(dir, name), 'utf8');
  }
  for (const name of (await fs.readdir(decisionLogDir(f.config))).filter(n => n.startsWith('labels-'))) text += await fs.readFile(path.join(decisionLogDir(f.config), name), 'utf8');
  return text;
}

// ---------------------------------------------------------------- the full join

test('a refused and re-issued delegation is joined from hook state through Main to the subagent: labels, observation, evaluation row', async t => {
  const { f, first, second, route } = await reissuedSession(t, { extraSkills: 61 });
  const config = withContext(f.config);
  const verification = verificationFor(TASK);

  // Dry run first: everything is counted, nothing is written.
  const dry = await run(f, { verification, config, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal((await logOf(f).read()).labels.length, 0);
  await assert.rejects(fs.lstat(observationLogDir(f.config)), code('ENOENT'));
  await assert.rejects(fs.lstat(path.join(f.stateDir, 'collector')), code('ENOENT'));

  const summary = await run(f, { verification, config });
  assert.deepEqual({ ...summary.labels, ...summary.observations }, { ...dry.labels, ...dry.observations });
  assert.deepEqual(summary.delegations, { seen: 1, routed: 1, joined: 1, unjoined: {}, unrouted: {}, refusedAndReissued: 1, reroutedAfterRefusal: 0, repeated: 0, agentCalls: 2 });
  assert.deepEqual(summary.warnings, {});
  assert.deepEqual(summary.host.versions, ['2.1.330']);
  assert.deepEqual(summary.host.permissionModes, ['auto']);
  assert.match(summary.host.codex, /^unsupported/);

  // 62 skills -> two requests of 31; each decision has need + 31 skill questions.
  const [event] = (await f.store.events()).filter(e => e.type === 'skills');
  assert.equal(event.retrieval.requests, 2);
  assert.deepEqual(event.asked.map(a => [a.decisionId, a.names.length]), event.decisionIds.map(id => [id, 31]));
  assert.deepEqual(summary.skillQuestionMapping, { decisions: 2, mapped: 2, asked: 2, derived: 0, unmapped: {}, answersCheckedAgainstLog: 62 });
  assert.deepEqual(summary.labels.written, {
    'delegation.skills': { 'observed-load': 64, 'external-verification-with-load': 3 },
    'supervisor.outcome': { 'external-verification': 1 },
  });

  // Every label sits on the question that was about that skill: the judge's probability for a name is unique.
  const { decisions, labels } = await logOf(f).read();
  const byId = new Map(decisions.map(d => [d.decisionId, d]));
  const observed = labels.filter(l => l.source === 'observed-load');
  for (const label of observed.filter(l => l.questionId !== 'need')) {
    const names = event.asked.find(a => a.decisionId === label.decisionId).names;
    const name = names[Number(label.questionId.slice(6))];
    assert.equal(byId.get(label.decisionId).answers[label.questionId].p, probabilityOf(name), name);
    assert.equal(label.outcome, name === TARGET, name);
  }
  assert.equal(observed.filter(l => l.outcome === true && l.questionId !== 'need').length, 1);
  assert.deepEqual(observed.filter(l => l.questionId === 'need').map(l => l.outcome), [true, true]);
  // What the judge was shown, request by request, is what `asked` says (independent of the collector).
  const shown = f.judge.calls.filter(c => Object.hasOwn(c.questions, 'need')).map(c => c.state.skills.map(s => s.name));
  assert.deepEqual(event.asked.map(a => a.names).sort(), shown.sort());
  const outcome = labels.find(l => l.source === 'external-verification');
  assert.deepEqual([byId.get(outcome.decisionId).pointId, outcome.questionId, outcome.outcome], ['supervisor.outcome', 'outcome', 'complete']);

  const { observations } = await new ObservationLog(observationLogDir(f.config)).read();
  assert.equal(observations.length, 1);
  const [o] = observations;
  assert.equal(o.taskHash, taskHash(TASK));
  assert.equal(o.taskHash, taskHash(second.tool_input.prompt), 'the appended tail is not part of the task text');
  assert.deepEqual(o.calls, { total: 2, refused: 1, reissued: true, repeated: false, reroutedAfterRefusal: false });
  assert.deepEqual(o.requested, { profile: route.profile, model: route.model, backend: route.backend, effort: route.effort, role: route.role, tier: route.tier,
    taskClass: route.taskClass, routeSource: 'reissue' });
  assert.deepEqual(o.effective, { agentType: route.profile, model: route.backend, effort: route.effort, source: 'native-transcript', profileMatch: true, modelMatch: 'exact', effortMatch: true });
  assert.deepEqual(o.skills, { mode: 'active', status: 'selected', need: 0.9, injectedByHook: true, blockInPrompt: true, blockLoad: [TARGET], blockConsider: [],
    loaded: [{ name: TARGET, via: 'Skill', beforeFirstWrite: true }], otherSkillCalls: 0, indeterminateAccess: false });
  // Three API messages, each written as several rows: every message id counts once.
  assert.deepEqual(o.usage, { apiTurns: 3, toolCalls: 3, tokens: { input: 9, output: 1200, cacheRead: 102000, cacheCreation: 52500 }, wallMs: 6000, endToEndMs: 26000 });
  assert.equal(o.judge.routerRequests, route.stageCount);
  assert.deepEqual([o.judge.skillsRequests, o.judge.supervisorRequests], [2, 1]);
  // classify + profile (when it ran) + two skills requests + the report check, each with the fixture's 12 input tokens.
  assert.equal(o.judge.tokensReported, o.decisions.length);
  assert.equal(o.judge.inputTokens, 12 * o.decisions.length);
  assert.deepEqual([...new Set(o.decisions.map(d => d.point))].sort().filter(p => p !== 'delegation.profile'), ['delegation.classify', 'delegation.skills', 'supervisor.outcome']);
  assert.ok(o.decisions.every(d => byId.has(d.decisionId) && d.role === 'governing'));
  assert.deepEqual(o.supervisor, { status: 'judged', outcome: 'complete', confidence: 1, evidence: 2, advisory: true, source: 'handback' });
  assert.deepEqual(o.verification, { passed: true, conventionPassed: true, validator: 'fixture-checker@1.0.0', artifactSha256: ARTIFACT });

  // The candidate row is written to a private file and is exactly what the unchanged importer accepts. Nothing was imported.
  assert.deepEqual([summary.evaluations.produced, summary.evaluations.withheldTasks, summary.evaluations.imported, summary.evaluations.context], [1, 0, false, 'ctx-fixture-1']);
  const file = path.join(f.stateDir, 'collector', summary.evaluations.files[0]);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const supervisorMs = byId.get(outcome.decisionId).latencyMs;
  assert.deepEqual(rows, [{ schema: 1, kind: 'live-evaluation', taskId: taskHash(TASK), taskClass: route.taskClass, context: 'ctx-fixture-1', projectHash: route.projectHash,
    profileId: route.profile, profileFingerprint: route.profileFingerprint, runtime: 'claude', createdAt: rows[0].createdAt,
    effective: { confirmed: true, model: route.backend, effort: route.effort, source: 'native-transcript' },
    verification: { source: 'independent-validator', passed: true, artifactSha256: ARTIFACT, validatorVersion: 'fixture-checker@1.0.0' },
    durationMs: 26000 + supervisorMs, costUsd: null, attempts: 2, accounting: 'all-attempts-including-failures-and-router' }]);
  assert.deepEqual((await readEvidence(config)).rows, []);
  await assert.rejects(importEvaluations(config, rows), code('EXPLICIT_EVIDENCE_ACCEPTANCE_REQUIRED'));
  assert.equal((await importEvaluations(config, rows, { acceptEvidence: true })).added, 1);

  // Private files, and a second run changes nothing.
  const store = path.join(observationLogDir(f.config), (await fs.readdir(observationLogDir(f.config)))[0]);
  assert.equal((await fs.stat(store)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(store))).mode & 0o777, 0o700);
  const before = await outputsText(f, {});
  const again = await run(f, { verification, config });
  assert.deepEqual([again.labels.written, again.labels.alreadyPresent, again.observations], [{}, 68, { written: 0, alreadyPresent: 1 }]);
  assert.equal(await outputsText(f, {}), before);

  // Nothing the collector wrote or printed carries text, a path or an id.
  const text = await outputsText(f, summary) + JSON.stringify(again);
  for (const secret of ['MARKER', 'PRIVATE', AGENT, A, B, SESSION, f.project, f.root, 'toolu_', 'msg_', 'toggle.js', '/'])
    assert.ok(!text.includes(secret), secret);
});

test('a rewrite applied in place (no refusal) joins on the one call; the inline report check is labelled only from an external result', async t => {
  const f = await prepared(t);
  const pre = preCall(f, A, { description: 'toggle', subagent_type: 'general-purpose', prompt: TASK });
  const routed = await handleHook(pre, 'claude', f.deps);
  const updated = routed.hookSpecificOutput.updatedInput;
  await handleHook({ ...pre, hook_event_name: 'PostToolUse', tool_response: { content: [{ type: 'text', text: REPORT }] } }, 'claude', f.deps);
  const route = (await f.store.getTask(A)).route;
  await writeTranscripts(f, {
    main: mainRows([{ id: A, input: pre.tool_input, at: 0, agentId: AGENT }]),
    subs: [{ agent: AGENT, rows: subRows({ prompt: updated.prompt, steps: STEPS, model: route.backend, effort: route.effort }), agentType: updated.subagent_type, toolUseId: A, model: route.backend }],
  });
  const none = await run(f, { dryRun: true });
  assert.deepEqual(none.labels.unlabelled, { supervisor_no_external_verification: 1 });
  assert.deepEqual(Object.keys(none.labels.written), ['delegation.skills']);

  // A failed external check: the report-check decision stays unlabelled (a failure does not tell retry from replan
  // from escalate), no with-load label is written, and the evaluation row carries passed: false.
  const failed = verificationFor(TASK, { passed: false, conventionPassed: false });
  const summary = await run(f, { verification: failed, config: withContext(f.config) });
  assert.deepEqual(summary.labels.written, { 'delegation.skills': { 'observed-load': 4 } });
  assert.deepEqual(summary.labels.unlabelled, { supervisor_verification_failed_no_outcome_class: 1 });
  assert.deepEqual(summary.warnings, {});
  const [o] = (await new ObservationLog(observationLogDir(f.config)).read()).observations;
  assert.deepEqual([o.calls.total, o.calls.refused, o.requested.routeSource, o.supervisor.source, o.verification.passed], [1, 0, 'own', 'inline', false]);
  const [row] = (await fs.readFile(path.join(f.stateDir, 'collector', summary.evaluations.files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual([row.verification.passed, row.attempts], [false, 1]);
});

// ---------------------------------------------------------------- question id -> skill name

const skillsDecision = (id, names, probabilities) => ({ decisionId: id, pointId: 'delegation.skills',
  answers: { need: { type: 'noul', p: 0.7 }, ...Object.fromEntries(names.map((_, i) => [`skill_${i}`, { type: 'noul', p: probabilities[i] }])) } });
function olderEvent(count, requests, { failed = [] } = {}) {
  const names = Array.from({ length: count }, (_, i) => `sk-${String(i).padStart(3, '0')}`);
  const size = Math.ceil(count / requests);
  const ids = [], log = new Map();
  const trace = names.map((name, i) => ({ name, stage: failed.includes(Math.floor(i / size)) ? 'judge_unavailable' : 'below_threshold', probability: failed.includes(Math.floor(i / size)) ? null : i / 1000 }));
  for (let r = 0; r < requests; r++) {
    if (failed.includes(r)) continue;
    const id = hash(['decision', r]);
    ids.push(id);
    log.set(id, skillsDecision(id, names.slice(r * size, (r + 1) * size), names.slice(r * size, (r + 1) * size).map((_, i) => (r * size + i) / 1000)));
  }
  return { names, size, ids, log, event: { candidates: count, decisionIds: ids, retrieval: { requests, failed: failed.length, judged: count }, trace } };
}

test('older skills events without `asked` map exactly from the trace, and anything that does not check out stays unmapped', () => {
  const two = olderEvent(61, 2);
  const mapped = skillQuestionNames(two.event, two.log);
  assert.equal(mapped.method, 'derived');
  assert.deepEqual([...mapped.mapped.entries()], [[two.ids[0], two.names.slice(0, 31)], [two.ids[1], two.names.slice(31)]]);
  assert.deepEqual(mapped.unmapped, []);

  // A failed request has no decision id: the surviving request keeps its own chunk, not the first one.
  const lost = olderEvent(61, 2, { failed: [0] });
  assert.deepEqual([...skillQuestionNames(lost.event, lost.log).mapped.entries()], [[lost.ids[0], lost.names.slice(31)]]);

  const reasons = (event, log) => skillQuestionNames(event, log).unmapped.map(u => u.reason);
  // The session event keeps at most 64 trace entries: a wider decision cannot be mapped from it.
  const wide = olderEvent(80, 2);
  assert.deepEqual(reasons({ ...wide.event, trace: wide.event.trace.slice(0, 64) }, wide.log), ['trace_incomplete', 'trace_incomplete']);
  const swapped = structuredClone(two.event);
  [swapped.trace[0], swapped.trace[1]] = [swapped.trace[1], swapped.trace[0]];
  assert.deepEqual(reasons(swapped, two.log), ['probability_mismatch']);
  assert.equal(skillQuestionNames(swapped, two.log).mapped.size, 1);
  assert.deepEqual(reasons(two.event, new Map()), ['decision_not_in_log', 'decision_not_in_log']);
  assert.deepEqual(reasons({ ...two.event, decisionIds: two.ids.slice(0, 1) }, two.log), ['decision_count_mismatch']);
  assert.deepEqual(reasons({ ...two.event, retrieval: { requests: 3 } }, two.log), ['decision_count_mismatch', 'decision_count_mismatch']);
  const shorter = new Map(two.log);
  shorter.set(two.ids[1], skillsDecision(two.ids[1], two.names.slice(31, 60), two.names.slice(31, 60).map((_, i) => (31 + i) / 1000)));
  assert.deepEqual(reasons(two.event, shorter), ['answer_count_mismatch']);
  assert.deepEqual(reasons({ decisionIds: two.ids, trace: 'unknown' }, two.log), ['event_shape_unknown', 'event_shape_unknown']);
  assert.deepEqual(skillQuestionNames(null).unmapped, []);
  // `asked` wins when present, and is still checked against the logged decision.
  const asked = { ...two.event, asked: [{ decisionId: two.ids[0], names: two.names.slice(0, 31) }, { decisionId: two.ids[1], names: two.names.slice(31, 60) }] };
  const result = skillQuestionNames(asked, two.log);
  assert.deepEqual([result.method, result.mapped.size, result.unmapped], ['asked', 1, [{ decisionId: two.ids[1], reason: 'answer_count_mismatch' }]]);
  assert.deepEqual(reasons({ ...two.event, asked: [{ decisionId: two.ids[0], names: ['not a name'] }] }, two.log), ['invalid_names', 'not_in_asked_list']);
});

test('selectSkills reports, per logged decision, the names its questions were about; the trace rule gives the same answer', async () => {
  const skills = Array.from({ length: 61 }, (_, i) => ({ name: `sk-${String(i).padStart(3, '0')}`, description: `procedure ${i} alpha`, path: `/x/${i}`, relPath: `.claude/skills/sk-${i}/SKILL.md` }));
  const seen = [];
  let n = 0;
  const judge = { async evaluate(state, questions) {
    const id = hash(['d', n += 1]);
    seen.push({ id, names: state.skills.map(s => s.name) });
    const answers = Object.fromEntries(Object.keys(questions).map(q => [q, { type: 'noul', noul: q === 'need' ? 0.2 : Number((Number(/\d+$/.exec(state.skills[Number(q.slice(6))].name)[0]) / 1000).toFixed(3)) }]));
    return { response: { answers }, decisionId: id, cached: false };
  } };
  const result = await selectSkills({ task: 'alpha task', catalog: { skills, fingerprint: 'f' }, judge, scope: 's',
    config: { maxCandidates: 8, need: 0.5, autoLoad: 0.9, suggest: 0.5, maxLoaded: 3, maxSuggested: 3, retrieval: 'full', minCoverage: 0.25, maxJudged: 64, chunk: 32 } });
  assert.deepEqual(result.asked.map(a => a.names.length), [31, 30]);
  assert.deepEqual(result.asked.map(a => ({ id: a.decisionId, names: a.names })).sort((a, b) => (a.id < b.id ? -1 : 1)), seen.sort((a, b) => (a.id < b.id ? -1 : 1)));
  // The event as the hook stores it, without `asked`: the derived mapping must equal what the judge was shown.
  const event = { candidates: result.candidates, decisionIds: result.decisionIds, retrieval: result.retrieval,
    trace: result.trace.filter(x => x.stage !== 'retrieval').map(x => ({ name: x.name, stage: x.stage, probability: x.probability })) };
  const log = new Map(seen.map(s => [s.id, skillsDecision(s.id, s.names, s.names.map(name => Number((Number(/\d+$/.exec(name)[0]) / 1000).toFixed(3))))]));
  const derived = skillQuestionNames(event, log);
  assert.deepEqual([...derived.mapped.entries()].sort(), result.asked.map(a => [a.decisionId, a.names]).sort());
});

// ---------------------------------------------------------------- state from before the re-issue fix

test('state from before the re-issue fix: both calls were routed; only the decision that reached the subagent is labelled', async t => {
  const f = await prepared(t);
  // Call A is routed by the real hook. The pre-fix hook then routed the re-issued call B a second time; that
  // second route is reproduced by hand in the stored shapes (route + skills events, a task record, two decisions).
  const first = preCall(f, A, { description: 'toggle', subagent_type: 'general-purpose', prompt: TASK });
  const updated = (await handleHook(first, 'claude', f.deps)).hookSpecificOutput.updatedInput;
  const taskA = await f.store.getTask(A);
  const input = { description: updated.description, prompt: updated.prompt, subagent_type: updated.subagent_type };
  const [skillsA] = (await f.store.events()).filter(e => e.type === 'skills');
  const log = logOf(f);
  const original = (await log.read()).decisions.find(d => d.decisionId === skillsA.decisionIds[0]);
  const secondId = hash('second-skills-decision');
  await log.append({ ...original, decisionId: secondId, time: original.time + 1, stateHash: hash('task plus packet') });
  await f.store.putTask(B, { inputHash: hash(input), outputHash: hash({ ...input, prompt: input.prompt + ' again' }), policy: taskA.policy, stamp: taskA.stamp,
    route: { ...taskA.route, profile: 'jev4_implement_other_profile_0000000000' } });
  await f.store.record('skills', { ...skillsA, taskId: B, decisionId: secondId, decisionIds: [secondId], asked: [{ decisionId: secondId, names: skillsA.asked[0].names }] }, B);
  await f.store.record('route', { taskId: B, inputHash: hash(input), route: { ...taskA.route, profile: 'jev4_implement_other_profile_0000000000' }, mode: 'active', hookMs: 400 }, B);
  await handleHook(launched(preCall(f, B, input), AGENT), 'claude', f.deps);
  await writeTranscripts(f, {
    main: mainRows([{ id: A, input: first.tool_input, at: 0, refused: true }, { id: B, input, at: 10, agentId: AGENT }]),
    subs: [{ agent: AGENT, rows: subRows({ prompt: input.prompt, steps: STEPS, model: taskA.route.backend, effort: taskA.route.effort }), agentType: updated.subagent_type, toolUseId: B, model: taskA.route.backend }],
  });
  const summary = await run(f);
  assert.deepEqual([summary.delegations.seen, summary.delegations.joined, summary.delegations.reroutedAfterRefusal, summary.delegations.refusedAndReissued], [1, 1, 1, 0]);
  // The first call's decision governs: its rewrite is the input the host launched. The second route was never applied.
  assert.deepEqual(summary.labels.written, { 'delegation.skills': { 'observed-load': 4 } });
  assert.deepEqual(summary.labels.unlabelled, { skills_decision_not_applied_to_launched_call: 1 });
  const labels = (await log.read()).labels;
  assert.ok(labels.every(l => l.decisionId === skillsA.decisionIds[0]));
  const [o] = (await new ObservationLog(observationLogDir(f.config)).read()).observations;
  assert.deepEqual([o.requested.profile, o.requested.routeSource, o.effective.profileMatch, o.calls.reroutedAfterRefusal], [taskA.route.profile, 'refused-call', true, true]);
  assert.deepEqual(o.decisions.filter(d => d.point === 'delegation.skills').map(d => [d.decisionId, d.role]), [[skillsA.decisionIds[0], 'governing'], [secondId, 'not-applied']]);
  assert.equal(o.judge.skillsRequests, 2 * skillsA.retrieval.requests);
});

// ---------------------------------------------------------------- what is not labelled, and what is not produced

test('skill access that cannot be read as a load or a non-load writes no label', async t => {
  const steps = [{ id: 'msg_1', tools: [{ name: 'Bash', input: { command: 'cat .claude/skills/*/SKILL.md | head -50' } }] }, ...STEPS.slice(1)];
  const { f } = await reissuedSession(t, { steps });
  const summary = await run(f);
  assert.deepEqual(summary.labels.written, {});
  assert.deepEqual(summary.labels.unlabelled, { skills_access_indeterminate: 1, supervisor_no_external_verification: 1 });
  const [o] = (await new ObservationLog(observationLogDir(f.config)).read()).observations;
  assert.deepEqual([o.skills.loaded, o.skills.indeterminateAccess], [[], true]);
});

test('skill loads are read from the Skill tool, a Read of SKILL.md and a shell word naming it; never from other text', () => {
  const known = new Map([['notification-toggle', 'notification-toggle'], ['folder-b', 'skill-b'], ['pdf-forms', 'pdf-forms']]);
  const steps = tools => parseSubagent(subRows({ prompt: 'p', steps: tools.map((tool, i) => ({ id: 'm' + i, tools: [tool] })), model: 'm', effort: 'high' }), { knownSkills: known });
  const loads = steps([
    { name: 'Bash', input: { command: "find . -type f | grep -v '^./.claude/skills/' | head" } },
    { name: 'Skill', input: { skill: 'plugin:notification-toggle' } },
    { name: 'Edit', input: { file_path: '/PRIVATE/PATH/a.js' } },
    { name: 'Read', input: { file_path: '/PRIVATE/PATH/project/.claude/skills/folder-b/SKILL.md' } },
    { name: 'Bash', input: { command: 'echo ---; cat .claude/skills/pdf-forms/SKILL.md; echo done' } },
    { name: 'Skill', input: { skill: 'some-user-level-skill' } },
    { name: 'SubagentHandback', input: { message: 'I loaded .claude/skills/other/SKILL.md and followed it' } },
  ]);
  assert.deepEqual(loads.loaded, [{ name: 'notification-toggle', via: 'Skill', beforeFirstWrite: true }, { name: 'skill-b', via: 'Read', beforeFirstWrite: false },
    { name: 'pdf-forms', via: 'Shell', beforeFirstWrite: false }]);
  assert.deepEqual([loads.otherSkillCalls, loads.indeterminate], [1, false]);
  for (const tool of [{ name: 'Bash', input: { command: 'grep -rl fault .claude/skills/pdf-forms' } }, { name: 'Read', input: { file_path: '.claude/skills/unknown-folder/SKILL.md' } },
    { name: 'Grep', input: { pattern: 'x', path: '.claude/skills' } }, { name: 'Bash', input: { command: 'cat "xpdf-forms/SKILL.md"' } }])
    assert.deepEqual([steps([tool]).loaded, steps([tool]).indeterminate], [[], true], JSON.stringify(tool));
  // No write tool call: "before the first write" is not measured, not true.
  assert.deepEqual(steps([{ name: 'Skill', input: { skill: 'pdf-forms' } }]).loaded, [{ name: 'pdf-forms', via: 'Skill', beforeFirstWrite: null }]);
  assert.deepEqual([...skillFoldersOf({ skills: [{ name: 'skill-b', relPath: '.claude/skills/folder-b/SKILL.md' }, { name: 'bad name', relPath: 'x/SKILL.md' }] })], [['folder-b', 'skill-b']]);
});

test('each reason an evaluation row is withheld is counted, and no row is written', async t => {
  const withheld = async (options, extra = {}) => {
    const { f } = await reissuedSession(t, options);
    const summary = await run(f, { verification: verificationFor(TASK), config: withContext(f.config), ...extra(f) });
    assert.deepEqual([summary.evaluations.produced, summary.evaluations.files, summary.evaluations.withheldTasks], [0, [], 1]);
    await assert.rejects(fs.lstat(path.join(f.stateDir, 'collector')), code('ENOENT'));
    return { summary, f };
  };
  const none = () => ({});
  assert.deepEqual((await withheld({}, f => ({ config: f.config }))).summary.evaluations.withheld, { evaluation_context_not_configured: 1 });
  assert.deepEqual((await withheld({}, () => ({ config: null }))).summary.evaluations.withheld, { evaluation_context_not_configured: 1 });
  // The host resolved an alias to another id: reported as an alias match, and not good enough for an evaluation row.
  const alias = await withheld({ sub: { model: 'claude-fixturemodel-9-9' } }, none);
  assert.deepEqual(alias.summary.evaluations.withheld, { effective_model_differs_from_profile_backend: 1 });
  assert.equal((await new ObservationLog(observationLogDir(alias.f.config)).read()).observations[0].effective.modelMatch, 'mismatch');
  assert.deepEqual((await withheld({ sub: { effort: 'low' } }, none)).summary.evaluations.withheld, { effective_effort_differs_from_profile: 1 });
  assert.deepEqual((await withheld({ sub: { effort: null } }, none)).summary.evaluations.withheld, { effective_setting_not_recorded_by_host: 1 });
  assert.deepEqual((await withheld({ stamp: false }, none)).summary.evaluations.withheld, { duration_not_measured: 1 });
  // The importer's own validation runs on the row: a registry that no longer has the profile refuses it.
  const stale = await withheld({}, f => { const c = structuredClone(withContext(f.config)); for (const m of c.registry.models) m.backend += '-renamed'; return { config: c }; });
  assert.deepEqual(stale.summary.evaluations.withheld, { 'importer_refuses:STALE_EVIDENCE_PROFILE': 1 });

  // The subagent transcript is missing: the delegation is unjoined, nothing is labelled or observed, and the row is withheld.
  const { f } = await reissuedSession(t);
  await fs.rm(path.join(f.transcripts, 'subagents', `agent-${AGENT}.jsonl`));
  const missing = await run(f, { verification: verificationFor(TASK), config: withContext(f.config) });
  assert.deepEqual([missing.delegations.joined, missing.delegations.unjoined, missing.labels.written, missing.observations.written], [0, { subagent_transcript_missing: 1 }, {}, 0]);
  assert.deepEqual(missing.evaluations.withheld, { attempt_not_joined_to_transcripts: 1 });
  // With a context name passed on the command line and no config, the row is produced without the importer check.
  const { f: g } = await reissuedSession(t);
  const plain = await run(g, { verification: verificationFor(TASK), evaluationContext: 'ctx-from-flag' });
  assert.deepEqual([plain.evaluations.produced, plain.evaluations.context], [1, 'ctx-from-flag']);
});

test('a verification entry can name a call id; unmatched entries are counted; a malformed file is refused', async t => {
  const { f } = await reissuedSession(t);
  const byCall = parseVerification({ schema: 1, results: [{ toolUseId: A, passed: true, validator: VALIDATOR, artifactSha256: ARTIFACT, costUsd: 0.25 },
    { taskHash: 'cd'.repeat(32), passed: true, validator: VALIDATOR, artifactSha256: ARTIFACT }] });
  const summary = await run(f, { verification: byCall, evaluationContext: 'ctx-1' });
  assert.deepEqual(summary.verification, { entries: 2, matched: 1, unmatched: 1 });
  // No convention result was supplied: the outcome label is written, the with-load label is not.
  assert.deepEqual(summary.labels.written, { 'delegation.skills': { 'observed-load': 4 }, 'supervisor.outcome': { 'external-verification': 1 } });
  const [row] = (await fs.readFile(path.join(f.stateDir, 'collector', summary.evaluations.files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(row.costUsd, 0.25);
  const entry = { taskHash: 'cd'.repeat(32), passed: true, validator: VALIDATOR, artifactSha256: ARTIFACT };
  for (const [bad, expected] of [
    [[{ ...entry, toolUseId: 'toolu_x' }], 'INVALID_VERIFICATION_KEY'], [[{ ...entry, taskHash: 'short' }], 'INVALID_VERIFICATION_KEY'],
    [[{ ...entry, passed: 'yes' }], 'INVALID_VERIFICATION_RESULT'], [[{ ...entry, note: 'free text' }], 'INVALID_VERIFICATION_ENTRY'],
    [[{ ...entry, validator: { name: 'has space', version: '1' } }], 'INVALID_VERIFICATION_VALIDATOR'], [[{ ...entry, artifactSha256: 'x' }], 'INVALID_VERIFICATION_ARTIFACT'],
    [[{ ...entry, costUsd: -1 }], 'INVALID_VERIFICATION_COST'], [{ results: [] }, 'INVALID_VERIFICATION_FILE'], ['text', 'INVALID_VERIFICATION_FILE'],
  ]) assert.throws(() => parseVerification(bad), code(expected));
  // Two entries that disagree about one delegation are an error, not a choice.
  await assert.rejects(run(f, { verification: parseVerification([{ ...entry, taskHash: taskHash(TASK) }, { toolUseId: B, passed: false, validator: VALIDATOR, artifactSha256: ARTIFACT }]) }), code('CONFLICTING_VERIFICATION'));
});

// ---------------------------------------------------------------- unknown shapes, refusals

test('malformed and unknown transcript shapes give null plus a counted warning, never a guess and never a crash', async t => {
  const { f, first, second, route } = await reissuedSession(t, { sub: { model: null, effort: null, rows: { usageRows: false } }, stamp: false });
  // Garbage lines, non-object lines, unknown row types and a tool call without an id in Main's transcript.
  const main = jsonl(mainRows([{ id: A, input: first.tool_input, at: 0, refused: true }, { id: B, input: second.tool_input, at: 10, agentId: AGENT }], { stamp: false }))
    + '{not json\n[1,2]\n"text"\n' + JSON.stringify({ type: 'future-row-type', payload: { nested: [1, 2, 3] } }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'x' } }, { type: 'tool_use', id: 'toolu_noinput', name: 'Agent' }, 'string item', null] } }) + '\n';
  await fs.writeFile(path.join(f.transcripts, 'main.jsonl'), main);
  await fs.writeFile(path.join(f.transcripts, 'subagents', `agent-${AGENT}.meta.json`), '["not an object"]');
  const summary = await run(f, { verification: verificationFor(TASK), evaluationContext: 'ctx-1' });
  assert.deepEqual(summary.warnings, { delegation_call_without_id: 1, delegation_call_without_input: 1, subagent_meta_shape_unknown: 1, unparsable_transcript_line: 3 });
  assert.equal(summary.delegations.joined, 1);
  const [o] = (await new ObservationLog(observationLogDir(f.config)).read()).observations;
  // Unmeasured is null, never 0; the profile is still known from the call Main issued.
  assert.deepEqual(o.effective, { agentType: route.profile, model: null, effort: null, source: null, profileMatch: true, modelMatch: null, effortMatch: null });
  assert.deepEqual(o.usage, { apiTurns: 3, toolCalls: 3, tokens: { input: null, output: null, cacheRead: null, cacheCreation: null }, wallMs: null, endToEndMs: null });
  assert.deepEqual(summary.evaluations.withheld, { effective_setting_not_recorded_by_host: 1, duration_not_measured: 1 });

  // A subagent transcript in a shape nobody has seen: no assistant rows are recognised, so the delegation is not joined.
  await fs.writeFile(path.join(f.transcripts, 'subagents', `agent-${AGENT}.jsonl`), jsonl([{ kind: 'turn', speaker: 'model', text: 'UNKNOWN_SHAPE_MARKER' }, { type: 'assistant' }, { type: 'user', message: 7 }]));
  const unknown = await run(f, { dryRun: true });
  assert.deepEqual([unknown.delegations.joined, unknown.delegations.unjoined], [0, { subagent_transcript_without_assistant_rows: 1 }]);
  assert.deepEqual([unknown.warnings.subagent_first_prompt_not_found, unknown.warnings.conversation_row_without_message], [1, 2]);
  // Pure parsers on nonsense.
  assert.deepEqual(parseJsonl('\n{}\n1\n{"a":'), { rows: [{}], bad: 2 });
  assert.equal(parseMain([{ type: 'assistant', message: { content: 'text' } }, { message: null }, {}]).calls.size, 0);
  assert.deepEqual(parseSubagent([{ type: 'assistant', message: { content: [{ type: 'tool_use' }, { type: 'tool_use', name: 'Skill', input: 'x' }] } }]).loaded, []);
});

test('symlinks and oversized inputs are refused; a state directory without the session is reported', async t => {
  const { f } = await reissuedSession(t);
  const real = path.join(f.transcripts, 'subagents', `agent-${AGENT}.jsonl`);
  const moved = path.join(f.root, 'elsewhere.jsonl');
  await fs.rename(real, moved);
  await fs.symlink(moved, real);
  const linked = await run(f, { dryRun: true });
  assert.deepEqual([linked.delegations.joined, linked.delegations.unjoined, linked.warnings.symlink_refused], [0, { subagent_transcript_unreadable: 1 }, 1]);
  await fs.rm(real);
  await fs.rename(moved, real);

  // A sparse file one byte over the limit: refused by size, never read.
  const meta = path.join(f.transcripts, 'subagents', `agent-${AGENT}.meta.json`);
  await fs.truncate(meta, MAX_STATE_FILE_BYTES + 1);
  assert.equal((await run(f, { dryRun: true })).warnings.subagent_meta_unreadable, 1);
  await fs.rename(real, moved);
  await fs.writeFile(real, '');
  await fs.truncate(real, MAX_TRANSCRIPT_BYTES + 1);
  const large = await run(f, { dryRun: true });
  assert.deepEqual([large.delegations.unjoined, large.warnings.transcript_too_large], [{ subagent_transcript_unreadable: 1 }, 1]);
  await fs.rm(real);
  await fs.rename(moved, real);

  const link = path.join(f.root, 'transcripts-link');
  await fs.symlink(f.transcripts, link);
  await assert.rejects(collect({ stateDir: f.stateDir, transcriptsDir: link }), code('SYMLINK_SOURCE'));
  const stateLink = path.join(f.root, 'state-link');
  await fs.symlink(f.stateDir, stateLink);
  await assert.rejects(collect({ stateDir: stateLink, transcriptsDir: f.transcripts }), code('SYMLINK_SOURCE'));
  await assert.rejects(collect({ stateDir: 'relative', transcriptsDir: f.transcripts }), code('ABSOLUTE_STATE_REQUIRED'));
  await assert.rejects(collect({ stateDir: f.stateDir, transcriptsDir: path.join(f.root, 'empty-missing') }), code('SOURCE_MISSING'));
  // The observation store refuses a symlinked destination file.
  const dir = observationLogDir(f.config);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.symlink(path.join(f.root, 'stolen.jsonl'), path.join(dir, `observations-${new Date().toISOString().slice(0, 7)}.jsonl`));
  await assert.rejects(run(f), code('SYMLINK_DESTINATION'));
  await assert.rejects(fs.lstat(path.join(f.root, 'stolen.jsonl')), code('ENOENT'));

  // Transcripts of some other session: nothing is joined and the summary says so.
  const other = await prepared(t);
  const elsewhere = await collect({ stateDir: other.stateDir, transcriptsDir: f.transcripts, dryRun: true });
  assert.deepEqual([elsewhere.sessions.selected, elsewhere.delegations.seen, elsewhere.warnings.no_session_state_for_transcript], [0, 0, 1]);
});

test('without transcripts only the hook state is summarised; a codex session is reported as unsupported', async t => {
  const { f } = await reissuedSession(t);
  const stateOnly = await collect({ stateDir: f.stateDir });
  assert.deepEqual([stateOnly.mode, stateOnly.delegations.seen, stateOnly.delegations.joined, stateOnly.delegations.unjoined, stateOnly.delegations.refusedAndReissued],
    ['state-only', 1, 0, { no_transcripts: 1 }, 1]);
  assert.deepEqual([stateOnly.skillQuestionMapping.mapped, stateOnly.supervisor.judged, stateOnly.labels.written, stateOnly.observations.written], [1, 1, {}, 0]);

  // The same events under a codex session: no transcript reader exists for that runtime.
  const codex = new SessionStore(f.config, f.project, 'codex', SESSION);
  for (const e of await f.store.events()) {
    const { type, time, ...data } = e;
    await codex.record(type, type === 'session_started' ? { ...data, runtime: 'codex' } : data, data.taskId ?? null);
  }
  await codex.record('session_started', { source: 'startup', runtime: 'codex' });
  await fs.rm(f.store.dir, { recursive: true });
  const summary = await run(f, { dryRun: true });
  assert.deepEqual([summary.delegations.joined, summary.delegations.unjoined], [0, { runtime_transcripts_unsupported: 1 }]);
});

// ---------------------------------------------------------------- default configuration

test('the default configuration records no skill names; a deferred, unrouted delegation is observed without a requested profile', async t => {
  const f = await prepared(t, { skills: 'off', supervisor: 'off' });
  const pre = preCall(f, A, { description: 'toggle', subagent_type: 'general-purpose', prompt: TASK });
  const updated = (await handleHook(pre, 'claude', f.deps)).hookSpecificOutput.updatedInput;
  const events = await f.store.events();
  assert.deepEqual(events.filter(e => e.type === 'skills'), []);
  const route = events.find(e => e.type === 'route');
  assert.match(route.judgeDecisionIds.classify, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(events).includes('asked'));
  // A second delegation that the hook never routed (only its launch was seen).
  const other = preCall(f, B, { description: 'x', subagent_type: 'general-purpose', prompt: 'OTHER_TASK_MARKER do something else' });
  await handleHook(launched(other, 'b' + AGENT.slice(1)), 'claude', f.deps);
  await writeTranscripts(f, {
    main: mainRows([{ id: A, input: pre.tool_input, at: 0, agentId: AGENT }, { id: B, input: other.tool_input, at: 30, agentId: 'b' + AGENT.slice(1) }]),
    subs: [{ agent: AGENT, rows: subRows({ prompt: updated.prompt, steps: STEPS, model: route.route.backend, effort: route.route.effort }), agentType: updated.subagent_type, toolUseId: A, model: route.route.backend },
      { agent: 'b' + AGENT.slice(1), rows: subRows({ agent: 'b' + AGENT.slice(1), prompt: other.tool_input.prompt, steps: STEPS, model: 'default-model', effort: 'medium', start: 40 }), agentType: 'general-purpose', toolUseId: B, model: 'default-model' }],
  });
  const summary = await run(f, { verification: parseVerification([{ toolUseId: B, passed: true, validator: VALIDATOR, artifactSha256: ARTIFACT }]), evaluationContext: 'ctx-1' });
  assert.deepEqual([summary.delegations.seen, summary.delegations.routed, summary.delegations.joined, summary.delegations.unrouted], [2, 1, 2, { no_route_recorded: 1 }]);
  assert.deepEqual([summary.labels.written, summary.warnings], [{}, { project_skill_names_unknown: 1 }]);
  assert.deepEqual(summary.evaluations.withheld, { delegation_not_routed: 1 });
  const { observations } = await new ObservationLog(observationLogDir(f.config)).read();
  const unrouted = observations.find(o => !o.routed);
  assert.deepEqual([unrouted.requested.profile, unrouted.effective.agentType, unrouted.effective.model, unrouted.effective.profileMatch, unrouted.judge.routerRequests],
    [null, 'general-purpose', 'default-model', null, null]);
  // With the project's skill folders supplied, a Skill call is recognised even though the hook state names no skill.
  await fs.rm(observationLogDir(f.config), { recursive: true });
  await run(f, { skillFolders: new Map([[TARGET, TARGET]]) });
  const again = (await new ObservationLog(observationLogDir(f.config)).read()).observations;
  assert.deepEqual(again.map(o => o.skills.loaded.map(l => l.name)), [[TARGET], [TARGET]]);

  const report = observationReport(again);
  assert.deepEqual([report.delegations, report.routed, report.byProfile.map(p => p.profile).sort()], [2, 1, ['(not-routed)', route.route.profile].sort()]);
  assert.deepEqual(report.requestedVsEffective.profile, { compared: 1, matched: 1, rate: 1 });
  assert.deepEqual(report.all.passRate, null);
  assert.deepEqual(report.skills.crossTab, { blockPresent: { loadedAny: 0, loadedNone: 0 }, blockAbsent: { loadedAny: 2, loadedNone: 0 }, blockUnknown: 0, loadUnknown: 0 });
  assert.equal(report.judge.tokens.judgeShare > 0 && report.judge.tokens.judgeShare < 1, true);
  assert.deepEqual(observationReport([]).all.perDelegation.wallMs, { mean: null, measured: 0 });
});

// ---------------------------------------------------------------- stores and consumers

test('the observation store accepts hashes, numbers, enums and identifiers only', async t => {
  const { f } = await reissuedSession(t);
  await run(f);
  const log = new ObservationLog(observationLogDir(f.config));
  const [valid] = (await log.read()).observations;
  assert.ok(isObservationRecord(valid));
  const { time, observationId, ...content } = valid;
  for (const broken of [
    { ...content, note: 'free text' },
    { ...content, requested: { ...content.requested, profile: 'a profile with spaces' } },
    { ...content, skills: { ...content.skills, loaded: [{ name: 'has space', via: 'Skill', beforeFirstWrite: null }] } },
    { ...content, skills: { ...content.skills, blockLoad: ['../../etc/passwd'] } },
    { ...content, effective: { ...content.effective, source: 'i think it was opus' } },
    { ...content, taskHash: 'The original task text' },
    { ...content, usage: { ...content.usage, tokens: { ...content.usage.tokens, input: -1 } } },
    { ...content, verification: { passed: true, conventionPassed: null, validator: 'ok', artifactSha256: 'not a hash' } },
    { ...content, decisions: [{ point: 'delegation.skills', decisionId: 'x', role: 'governing' }] },
  ]) await assert.rejects(log.append(broken), code('INVALID_OBSERVATION_RECORD'));
  assert.equal((await log.read()).observations.length, 1);
  await assert.rejects(async () => new ObservationLog('relative'), code('ABSOLUTE_OBSERVATION_LOG_REQUIRED'));
  // A corrupt line is counted and skipped.
  const file = path.join(log.dir, (await fs.readdir(log.dir))[0]);
  await fs.appendFile(file, '{"schema":1,"text":"hello"}\nnot json\n');
  assert.deepEqual([(await log.read()).observations.length, (await log.read()).corruptLines], [1, 2]);
});

test('the calibration report keeps label sources apart and says which are weak', async t => {
  const { f } = await reissuedSession(t);
  await run(f, { verification: verificationFor(TASK) });
  const log = logOf(f);
  const [event] = (await f.store.events()).filter(e => e.type === 'skills');
  // A hand-attached label that contradicts the observation on the target skill's question.
  const question = `skill_${event.asked[0].names.indexOf(TARGET)}`;
  await log.label(event.asked[0].decisionId, { questionId: question, outcome: false, source: 'human-review' });
  const data = await log.read();
  const report = calibrationReport(data);
  assert.deepEqual(report.labels.bySource.map(s => [s.source, s.strength, s.oneSided, s.labels]),
    [['external-verification', 'verified', true, 1], ['external-verification-with-load', 'weak', true, 2], ['human-review', 'unclassified', null, 1], ['observed-load', 'weak', false, 4]]);
  assert.deepEqual([report.labels.weakSources, report.labels.oneSidedSources, report.labels.unclassifiedSources],
    [['external-verification-with-load', 'observed-load'], ['external-verification', 'external-verification-with-load'], ['human-review']]);
  const skills = report.groups.find(g => g.pointId === 'delegation.skills');
  // The combined metrics use the latest label per question whatever its source, and are marked as mixed.
  assert.deepEqual([skills.counts.labeled, skills.metricsLabelStrength], [4, 'mixed']);
  // Per source, a label of another source never replaces one: observed-load still has its own four.
  assert.deepEqual(skills.labelSources.map(s => [s.source, s.strength, s.labeled, s.metrics.tp + s.metrics.fn]),
    [['external-verification-with-load', 'weak', 2, 2], ['human-review', 'unclassified', 1, 0], ['observed-load', 'weak', 4, 2]]);
  const supervisor = report.groups.find(g => g.pointId === 'supervisor.outcome' && g.type === 'choice');
  assert.deepEqual([supervisor.metricsLabelStrength, supervisor.labelSources.map(s => [s.source, s.oneSided, s.metrics.accuracy])], ['verified', [['external-verification', true, 1]]]);

  const only = calibrationReport(data, { sources: ['observed-load'] });
  assert.deepEqual([only.generatedFrom.labels, only.labels.excludedByFilter, only.labels.weakSources], [4, 4, ['observed-load']]);
  assert.equal(only.groups.find(g => g.pointId === 'delegation.skills').metricsLabelStrength, 'weak');
  const strong = calibrationReport(data, { excludeSources: ['observed-load', 'external-verification-with-load', 'human-review'] });
  assert.deepEqual([strong.generatedFrom.labels, strong.groups.find(g => g.pointId === 'delegation.skills').metricsLabelStrength], [1, null]);
  assert.throws(() => calibrationReport(data, { sources: [''] }), code('INVALID_CALIBRATION_OPTIONS'));
  assert.deepEqual(labelSourceInfo('anything-else'), { strength: 'unclassified', oneSided: null });
});

test('CLI: collect (dry run, real run, report, task hash) and the decisions report source filters', async t => {
  const { f } = await reissuedSession(t);
  const verification = path.join(f.root, 'verification.json');
  await fs.writeFile(verification, JSON.stringify([{ taskHash: taskHash(TASK), passed: true, conventionPassed: true, validator: VALIDATOR, artifactSha256: ARTIFACT }]));
  const cli = (...args) => child(process.execPath, [COLLECT, ...args]);
  const shared = ['--state-dir', f.stateDir, '--transcripts', f.transcripts, '--verification', verification, '--evaluation-context', 'ctx-cli'];
  let r = await cli(...shared, '--dry-run');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([JSON.parse(r.stdout).dryRun, JSON.parse(r.stdout).observations.written], [true, 1]);
  await assert.rejects(fs.lstat(observationLogDir(f.config)), code('ENOENT'));
  const out = path.join(f.root, 'out');
  r = await cli(...shared, '--out', out);
  assert.equal(r.code, 0, r.stderr);
  const summary = JSON.parse(r.stdout);
  assert.deepEqual([summary.evaluations.produced, await fs.readdir(out)], [1, summary.evaluations.files]);
  r = await cli('--state-dir', f.stateDir, '--report');
  assert.deepEqual([r.code, JSON.parse(r.stdout).delegations, JSON.parse(r.stdout).all.passRate, JSON.parse(r.stdout).records], [0, 1, 1, 1]);

  const text = path.join(f.root, 'task.txt');
  await fs.writeFile(text, TASK);
  r = await cli('--task-hash', text);
  assert.deepEqual(JSON.parse(r.stdout), { taskHash: taskHash(TASK) });
  await fs.symlink(verification, path.join(f.root, 'verification-link.json'));
  for (const [args, expected] of [
    [['--state-dir', f.stateDir, '--transcripts', 'relative'], 'ABSOLUTE_TRANSCRIPTS_REQUIRED'], [['--state-dir', 'relative'], 'ABSOLUTE_STATE_REQUIRED'],
    [['--state-dir', f.stateDir, '--bogus', '1'], 'UNKNOWN_ARGUMENT'], [[...shared.slice(0, 4), '--verification', path.join(f.root, 'verification-link.json')], 'SYMLINK_SOURCE'],
    [[...shared.slice(0, 4), '--evaluation-context', 'has space'], 'INVALID_EVALUATION_CONTEXT'],
  ]) {
    r = await cli(...args);
    assert.deepEqual([r.code, r.stderr.trim()], [1, expected]);
  }
  await fs.writeFile(verification, '{"schema":1,"results":[{"passed":true}]}');
  assert.equal((await cli(...shared)).stderr.trim(), 'INVALID_VERIFICATION_KEY');

  const decisions = (...args) => child(process.execPath, [DECISIONS, '--log-dir', decisionLogDir(f.config), '--action', 'report', ...args]);
  r = await decisions('--source', 'observed-load', '--point', 'delegation.skills');
  const weak = JSON.parse(r.stdout);
  assert.deepEqual([weak.generatedFrom.labels, weak.labels.weakSources, weak.groups[0].metricsLabelStrength], [4, ['observed-load'], 'weak']);
  r = await decisions('--exclude-source', 'observed-load,external-verification-with-load');
  assert.deepEqual(JSON.parse(r.stdout).labels.bySource.map(s => s.source), ['external-verification']);
  r = await decisions('--source', ',');
  assert.deepEqual([r.code, r.stderr.trim()], [1, 'INVALID_SOURCE_FILTER']);
  r = await child(process.execPath, [DECISIONS, '--log-dir', decisionLogDir(f.config), '--action', 'show', '--exclude-source', 'x']);
  assert.equal(r.stderr.trim(), 'EXCLUDE_SOURCE_IS_A_REPORT_FILTER');
});
