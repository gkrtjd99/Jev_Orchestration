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
import { profileCatalog } from '../src/catalog.mjs';
import { profileDefinitions } from '../src/profiles.mjs';
import { taskClass, eligibleProfiles, optimizeCandidates, summarizeEvidence } from '../src/optimizer.mjs';
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
/** After a registry edit: the profile files and their recorded fingerprints, as the installer would write them. */
async function reinstallProfiles(f) {
  f.config.installedProfiles.claude = {};
  const dir = path.join(f.root, 'fixture-profiles', 'claude');
  const profiles = profileCatalog(f.config.registry, 'claude');
  for (const [name, content] of Object.entries(profileDefinitions('claude', f.config.registry))) {
    await fs.writeFile(path.join(dir, name), content);
    const p = profiles.find(x => name.startsWith(x.profileId + '.'));
    f.config.installedProfiles.claude[p.profileId] = { path: path.join(dir, name), sha256: hash(content), fingerprint: p.fingerprint };
  }
}
const DEFAULT_CONTEXT = 'native-default-unvalidated';
async function prepared(t, { extraSkills = 2, skills = 'active', supervisor = 'active', context = 'ctx-fixture-1', registry = null } = {}) {
  const f = await fixture(t);
  if (skills !== 'off') {
    await addSkill(f.project, TARGET);
    for (let i = 0; i < extraSkills; i++) await addSkill(f.project, `fx-skill-${String(i).padStart(2, '0')}`);
  }
  // Sessions run under a named evaluation context unless a test asks for the default one: a row is only
  // produced for the context the session ran under.
  f.config.optimization.evaluationContext = context;
  if (registry) { registry(f.config.registry); await reinstallProfiles(f); }
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
// `resolved`: the model id the host says it resolved for the launch. A real Agent result always carries it and
// it names the model the subagent then runs on; fixtures that do not care about it leave it out.
const launched = (pre, agent, resolved = null) => ({ ...pre, hook_event_name: 'PostToolUse', tool_response: { isAsync: true, status: 'async_launched', agentId: agent, description: 'toggle',
  ...(resolved ? { resolvedModel: resolved } : {}), prompt: pre.tool_input.prompt, canReadOutputFile: true } });
const handback = (f, agent, report = REPORT) => ({ ...base(f.project), hook_event_name: 'PostToolUse', tool_name: 'SubagentHandback', tool_use_id: 'toolu_handback_' + agent,
  agent_id: agent, agent_type: 'general-purpose', tool_input: { message: report }, tool_response: { success: true, message: 'Report delivered to your caller.' } });

/** Auto permission mode: call A is rewritten and refused, Main issues B with the hook's input, B launches, the agent hands back. */
async function refusedAndReissued(f, { a = A, b = B, agent = AGENT, text = TASK, report = true, resolved } = {}) {
  const first = preCall(f, a, { description: 'toggle', subagent_type: 'general-purpose', prompt: text });
  const routed = await handleHook(first, 'claude', f.deps);
  const updated = routed.hookSpecificOutput.updatedInput;
  assert.ok(updated, 'the first call is rewritten');
  const second = preCall(f, b, { description: updated.description, prompt: updated.prompt, subagent_type: updated.subagent_type });
  assert.deepEqual(await handleHook(second, 'claude', f.deps), {});
  // By default the host resolved the model the route asked for (null: the result carries no resolvedModel).
  await handleHook(launched(second, agent, resolved === undefined ? (await f.store.getTask(a)).route.backend : resolved), 'claude', f.deps);
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
        : call.agentId ? { toolUseResult: { isAsync: true, status: 'async_launched', agentId: call.agentId, ...(call.resolvedModel ? { resolvedModel: call.resolvedModel } : {}), prompt: 'COPY_OF_PROMPT_MARKER', outputFile: '/PRIVATE/PATH/out' }, permissionDecision: { decision: 'accept' } } : {}) });
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
  // The host's launch result names the same model as the subagent's rows, unless `sub.resolved` says otherwise.
  const s = await refusedAndReissued(f, { resolved: Object.hasOwn(sub, 'resolved') ? sub.resolved : Object.hasOwn(sub, 'model') ? sub.model : undefined });
  const model = Object.hasOwn(sub, 'model') ? sub.model : s.route.backend;
  const effort = Object.hasOwn(sub, 'effort') ? sub.effort : s.route.effort;
  await writeTranscripts(f, {
    main: mainRows([{ id: A, input: s.first.tool_input, at: 0, refused: true }, { id: B, input: s.second.tool_input, at: 10, agentId: AGENT, resolvedModel: Object.hasOwn(sub, 'resultModel') ? sub.resultModel : model }], { stamp }),
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
  // The block of this decision was in the subagent's prompt, so the sources are the "-after-injection" ones.
  assert.deepEqual(summary.labels.written, {
    'delegation.skills': { 'observed-load-after-injection': 64, 'external-verification-with-load-after-injection': 2 },
    'supervisor.outcome': { 'external-verification': 1 },
  });
  assert.deepEqual([summary.labels.retracted, summary.labels.indeterminateAccess], [{}, {}]);

  // Every label sits on the question that was about that skill: the judge's probability for a name is unique.
  const { decisions, labels } = await logOf(f).read();
  const byId = new Map(decisions.map(d => [d.decisionId, d]));
  const observed = labels.filter(l => l.source === 'observed-load-after-injection');
  assert.equal(labels.filter(l => l.source === 'observed-load').length, 0);
  for (const label of observed.filter(l => l.questionId !== 'need')) {
    const names = event.asked.find(a => a.decisionId === label.decisionId).names;
    const name = names[Number(label.questionId.slice(6))];
    assert.equal(byId.get(label.decisionId).answers[label.questionId].p, probabilityOf(name), name);
    assert.equal(label.outcome, name === TARGET, name);
  }
  assert.equal(observed.filter(l => l.outcome === true && l.questionId !== 'need').length, 1);
  // `need` is asked per request about that request's own skills: only the request that held the loaded skill is true.
  const needs = observed.filter(l => l.questionId === 'need');
  assert.deepEqual(needs.map(l => [event.asked.find(a => a.decisionId === l.decisionId).names.includes(TARGET), l.outcome]).sort(), [[false, false], [true, true]]);
  const withLoad = labels.filter(l => l.source === 'external-verification-with-load-after-injection');
  assert.deepEqual(withLoad.map(l => l.outcome), [true, true]);
  assert.ok(withLoad.every(l => event.asked.find(a => a.decisionId === l.decisionId).names.includes(TARGET)));
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
    effective: { confirmed: true, model: route.backend, effort: route.effort, source: 'native-transcript', modelMatch: 'exact' },
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
  assert.deepEqual([again.labels.written, again.labels.alreadyPresent, again.labels.retracted, again.observations], [{}, 67, {}, { written: 0, alreadyPresent: 1, keptVerified: 0 }]);
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
  assert.deepEqual(summary.labels.written, { 'delegation.skills': { 'observed-load-after-injection': 4 } });
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
  assert.deepEqual(summary.labels.written, { 'delegation.skills': { 'observed-load-after-injection': 4 } });
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
  // The collecting config has the default context (whatever the session ran under): nothing is importable.
  assert.deepEqual((await withheld({}, f => ({ config: withContext(f.config, DEFAULT_CONTEXT) }))).summary.evaluations.withheld, { evaluation_context_not_configured: 1 });
  assert.deepEqual((await withheld({}, () => ({ config: null }))).summary.evaluations.withheld, { evaluation_context_not_configured: 1 });
  // The host resolved an alias to another id: reported as an alias match, and not good enough for an evaluation row.
  const alias = await withheld({ sub: { model: 'claude-fixturemodel-9-9' } }, none);
  assert.deepEqual(alias.summary.evaluations.withheld, { effective_model_mismatch: 1 });
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
  const plain = await run(g, { verification: verificationFor(TASK), evaluationContext: 'ctx-fixture-1' });
  assert.deepEqual([plain.evaluations.produced, plain.evaluations.context], [1, 'ctx-fixture-1']);
});

test('a verification entry can name a call id; unmatched entries are counted; a malformed file is refused', async t => {
  const { f } = await reissuedSession(t);
  const byCall = parseVerification({ schema: 1, results: [{ toolUseId: A, passed: true, validator: VALIDATOR, artifactSha256: ARTIFACT, costUsd: 0.25 },
    { taskHash: 'cd'.repeat(32), passed: true, validator: VALIDATOR, artifactSha256: ARTIFACT }] });
  const summary = await run(f, { verification: byCall, evaluationContext: 'ctx-fixture-1' });
  assert.deepEqual(summary.verification, { entries: 2, matched: 1, unmatched: 1 });
  // No convention result was supplied: the outcome label is written, the with-load label is not.
  assert.deepEqual(summary.labels.written, { 'delegation.skills': { 'observed-load-after-injection': 4 }, 'supervisor.outcome': { 'external-verification': 1 } });
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
  const summary = await run(f, { verification: verificationFor(TASK), evaluationContext: 'ctx-fixture-1' });
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
  const summary = await run(f, { verification: parseVerification([{ toolUseId: B, passed: true, validator: VALIDATOR, artifactSha256: ARTIFACT }]), evaluationContext: 'ctx-fixture-1' });
  assert.deepEqual([summary.delegations.seen, summary.delegations.routed, summary.delegations.joined, summary.delegations.unrouted], [2, 1, 2, { no_route_recorded: 1 }]);
  assert.deepEqual([summary.labels.written, summary.warnings], [{}, { project_skill_names_unknown: 1 }]);
  assert.deepEqual(summary.evaluations.withheld, { delegation_not_routed: 1 });
  const { observations } = await new ObservationLog(observationLogDir(f.config)).read();
  const unrouted = observations.find(o => !o.routed);
  assert.deepEqual([unrouted.requested.profile, unrouted.effective.agentType, unrouted.effective.model, unrouted.effective.profileMatch, unrouted.judge.routerRequests],
    [null, 'other', 'default-model', null, null]);
  // An agent type that is not a profile of this session's routes is not written by name.
  assert.ok(!JSON.stringify(observations).includes('general-purpose'));
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
    [['external-verification', 'verified', true, 1], ['external-verification-with-load-after-injection', 'weak', true, 2], ['human-review', 'unclassified', null, 1], ['observed-load-after-injection', 'weak', false, 4]]);
  assert.deepEqual([report.labels.weakSources, report.labels.oneSidedSources, report.labels.unclassifiedSources, report.labels.decisionInfluencedSources],
    [['external-verification-with-load-after-injection', 'observed-load-after-injection'], ['external-verification', 'external-verification-with-load-after-injection'], ['human-review'],
      ['external-verification-with-load-after-injection', 'observed-load-after-injection']]);
  const skills = report.groups.find(g => g.pointId === 'delegation.skills');
  // The combined metrics use the latest label per question whatever its source, and are marked as mixed.
  assert.deepEqual([skills.counts.labeled, skills.metricsLabelStrength], [4, 'mixed']);
  // Per source, a label of another source never replaces one: observed-load still has its own four.
  assert.deepEqual(skills.labelSources.map(s => [s.source, s.strength, s.labeled, s.metrics.tp + s.metrics.fn]),
    [['external-verification-with-load-after-injection', 'weak', 2, 2], ['human-review', 'unclassified', 1, 0], ['observed-load-after-injection', 'weak', 4, 2]]);
  const supervisor = report.groups.find(g => g.pointId === 'supervisor.outcome' && g.type === 'choice');
  assert.deepEqual([supervisor.metricsLabelStrength, supervisor.labelSources.map(s => [s.source, s.oneSided, s.metrics.accuracy])], ['verified', [['external-verification', true, 1]]]);

  const only = calibrationReport(data, { sources: ['observed-load-after-injection'] });
  assert.deepEqual([only.generatedFrom.labels, only.labels.excludedByFilter, only.labels.weakSources], [4, 4, ['observed-load-after-injection']]);
  // The labels that may inform a threshold are the ones the decision did not cause: none exist in this session.
  assert.equal(calibrationReport(data, { sources: ['observed-load'] }).generatedFrom.labels, 0);
  assert.equal(only.groups.find(g => g.pointId === 'delegation.skills').metricsLabelStrength, 'weak');
  const strong = calibrationReport(data, { excludeSources: ['observed-load-after-injection', 'external-verification-with-load-after-injection', 'human-review'] });
  assert.deepEqual([strong.generatedFrom.labels, strong.groups.find(g => g.pointId === 'delegation.skills').metricsLabelStrength], [1, null]);
  assert.throws(() => calibrationReport(data, { sources: [''] }), code('INVALID_CALIBRATION_OPTIONS'));
  assert.deepEqual(labelSourceInfo('anything-else'), { strength: 'unclassified', oneSided: null, decisionInfluenced: null });
  assert.deepEqual([labelSourceInfo('observed-load'), labelSourceInfo('observed-load-after-injection')],
    [{ strength: 'weak', oneSided: false, decisionInfluenced: false }, { strength: 'weak', oneSided: false, decisionInfluenced: true }]);
});

test('CLI: collect (dry run, real run, report, task hash) and the decisions report source filters', async t => {
  const { f } = await reissuedSession(t);
  const verification = path.join(f.root, 'verification.json');
  await fs.writeFile(verification, JSON.stringify([{ taskHash: taskHash(TASK), passed: true, conventionPassed: true, validator: VALIDATOR, artifactSha256: ARTIFACT }]));
  const cli = (...args) => child(process.execPath, [COLLECT, ...args]);
  const shared = ['--state-dir', f.stateDir, '--transcripts', f.transcripts, '--verification', verification, '--evaluation-context', 'ctx-fixture-1'];
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
  r = await decisions('--source', 'observed-load-after-injection', '--point', 'delegation.skills');
  const weak = JSON.parse(r.stdout);
  assert.deepEqual([weak.generatedFrom.labels, weak.labels.weakSources, weak.groups[0].metricsLabelStrength], [4, ['observed-load-after-injection'], 'weak']);
  assert.deepEqual([weak.groups[0].sufficient, weak.groups[0].sufficientReason, weak.groups[0].counts.labeledDecisions], [false, 'weak_labels', 1]);
  r = await decisions('--exclude-source', 'observed-load-after-injection,external-verification-with-load-after-injection');
  assert.deepEqual(JSON.parse(r.stdout).labels.bySource.map(s => s.source), ['external-verification']);
  r = await decisions('--source', ',');
  assert.deepEqual([r.code, r.stderr.trim()], [1, 'INVALID_SOURCE_FILTER']);
  r = await child(process.execPath, [DECISIONS, '--log-dir', decisionLogDir(f.config), '--action', 'show', '--exclude-source', 'x']);
  assert.equal(r.stderr.trim(), 'EXCLUDE_SOURCE_IS_A_REPORT_FILTER');
});

// ---------------------------------------------------------------- review findings: regression tests

test('a route that was recorded but not applied, or ran under another agent type, gives no evaluation row', async t => {
  // Shadow mode: the route is recorded, the call is launched as Main issued it. Even when the subagent happens
  // to run the profile's model and effort, the profile's agent definition never ran.
  const f = await prepared(t, { skills: 'off', supervisor: 'off' });
  f.config.mode = 'shadow';
  const pre = preCall(f, A, { description: 'toggle', subagent_type: 'general-purpose', prompt: TASK });
  assert.deepEqual(await handleHook(pre, 'claude', f.deps), {});
  const [event] = (await f.store.events()).filter(e => e.type === 'route');
  assert.equal(event.mode, 'shadow');
  await handleHook(launched(pre, AGENT), 'claude', f.deps);
  await writeTranscripts(f, {
    main: mainRows([{ id: A, input: pre.tool_input, at: 0, agentId: AGENT }]),
    subs: [{ agent: AGENT, rows: subRows({ prompt: TASK, steps: STEPS, model: event.route.backend, effort: event.route.effort }), agentType: 'general-purpose', toolUseId: A, model: event.route.backend }],
  });
  const shadow = await run(f, { verification: verificationFor(TASK), evaluationContext: 'ctx-fixture-1' });
  assert.deepEqual([shadow.evaluations.produced, shadow.evaluations.files, shadow.evaluations.withheld], [0, [], { route_not_applied: 1, agent_type_differs_from_profile: 1 }]);
  const [o] = (await new ObservationLog(observationLogDir(f.config)).read()).observations;
  assert.deepEqual([o.effective.profileMatch, o.effective.agentType, o.effective.modelMatch, o.effective.effortMatch], [false, 'other', 'exact', true]);

  // Active mode, but the host's record names another agent type than the route's profile.
  const { f: g, second, route } = await reissuedSession(t);
  await fs.writeFile(path.join(g.transcripts, 'subagents', `agent-${AGENT}.meta.json`), JSON.stringify({ agentType: 'general-purpose', toolUseId: B, model: route.backend, finished: true }));
  const other = await run(g, { verification: verificationFor(TASK), evaluationContext: 'ctx-fixture-1' });
  assert.deepEqual([other.evaluations.produced, other.evaluations.withheld], [0, { agent_type_differs_from_profile: 1 }]);
  assert.equal(second.tool_input.subagent_type, route.profile);
});

test('a subagent transcript without a confirmed end is not read as the whole run', async t => {
  const { f } = await reissuedSession(t);
  const meta = path.join(f.transcripts, 'subagents', `agent-${AGENT}.meta.json`);
  const file = path.join(f.transcripts, 'subagents', `agent-${AGENT}.jsonl`);
  const whole = await fs.readFile(file, 'utf8');
  // The host says the agent is still running and the copy ends before the Skill call: no "did not load" label,
  // no usage totals, no observation.
  await fs.writeFile(meta, JSON.stringify({ agentType: 'x', toolUseId: B, finished: false }));
  await fs.writeFile(file, whole.split('\n').slice(0, 4).join('\n') + '\n');
  const running = await run(f, { verification: verificationFor(TASK), evaluationContext: 'ctx-fixture-1' });
  assert.deepEqual([running.delegations.joined, running.delegations.unjoined, running.labels.written, running.observations.written],
    [0, { subagent_not_finished: 1 }, {}, 0]);
  // The skills decision and the report check of that delegation are counted as left without a label.
  assert.deepEqual(running.labels.unlabelled, { delegation_not_joined: 2 });
  assert.deepEqual(running.evaluations.withheld, { attempt_not_joined_to_transcripts: 1 });
  assert.equal((await logOf(f).read()).labels.length, 0);
  // `finished: false` wins over a stop the hooks saw: the copy of the transcript is what is being read.
  assert.ok((await f.store.events()).some(e => e.type === 'handback_observed' && e.agentId === AGENT));

  // A host record that says nothing about the end: the hooks' own hand-back event for that agent confirms it.
  await fs.writeFile(file, whole);
  await fs.writeFile(meta, JSON.stringify({ agentType: 'x', toolUseId: B }));
  assert.equal((await run(f, { dryRun: true })).delegations.joined, 1);
  // Neither the host nor the hooks say it ended.
  const quiet = await prepared(t);
  const s = await refusedAndReissued(quiet, { report: false });
  await writeTranscripts(quiet, {
    main: mainRows([{ id: A, input: s.first.tool_input, at: 0, refused: true }, { id: B, input: s.second.tool_input, at: 10, agentId: AGENT }]),
    subs: [{ agent: AGENT, rows: subRows({ prompt: s.second.tool_input.prompt, steps: STEPS, model: s.route.backend, effort: s.route.effort }), meta: { agentType: s.route.profile, toolUseId: B } }],
  });
  const unknown = await run(quiet, { dryRun: true });
  assert.deepEqual([unknown.delegations.joined, unknown.delegations.unjoined, unknown.labels.written], [0, { subagent_end_unconfirmed: 1 }, {}]);
});

test('a run without the verification file does not replace a verified observation; a corrected result does, and takes its labels back', async t => {
  const { f } = await reissuedSession(t);
  const passed = verificationFor(TASK);
  const first = await run(f, { verification: passed });
  assert.deepEqual(first.observations, { written: 1, alreadyPresent: 0, keptVerified: 0 });
  const report = async () => observationReport((await new ObservationLog(observationLogDir(f.config)).read()).observations);
  const stored = async () => (await new ObservationLog(observationLogDir(f.config)).read()).observations.length;

  // Same session, no verification file: nothing is appended, the verified record stands, no label is taken back.
  const bare = await run(f);
  assert.deepEqual([bare.observations, bare.labels.written, bare.labels.retracted], [{ written: 0, alreadyPresent: 0, keptVerified: 1 }, {}, {}]);
  assert.deepEqual([await stored(), (await report()).all.verified, (await report()).all.passRate], [1, 1, 1]);
  // A store that already holds an unverified line after a verified one (written by an older collector) reports the verified one.
  const [record] = (await new ObservationLog(observationLogDir(f.config)).read()).observations;
  const { time, observationId, ...content } = record;
  assert.equal(observationReport([record, { ...content, verification: null, time: time + 1, observationId: 'f'.repeat(64) }]).all.verified, 1);

  // The user corrects the result: the task failed its checks.
  const failed = verificationFor(TASK, { passed: false, conventionPassed: false });
  const corrected = await run(f, { verification: failed });
  assert.deepEqual(corrected.observations, { written: 1, alreadyPresent: 0, keptVerified: 0 });
  assert.deepEqual(corrected.labels.written, {});
  assert.deepEqual(corrected.labels.retracted, { 'delegation.skills': { 'external-verification-with-load-after-injection': 2 }, 'supervisor.outcome': { 'external-verification': 1 } });
  assert.deepEqual([(await report()).all.verified, (await report()).all.passRate], [1, 0]);
  const data = await logOf(f).read();
  assert.equal(data.labels.filter(l => l.source.endsWith(':retracted')).length, 3);
  const after = calibrationReport(data);
  assert.deepEqual(after.labels.bySource.map(s => [s.source, s.labels]), [['observed-load-after-injection', 4]]);
  assert.deepEqual([after.labels.retracted, after.labels.retractionMarkers], [3, 3]);
  assert.equal(after.groups.find(g => g.pointId === 'supervisor.outcome' && g.type === 'choice').counts.labeled, 0);
  // Running the corrected file again changes nothing.
  const again = await run(f, { verification: failed });
  assert.deepEqual([again.labels.written, again.labels.retracted, again.observations], [{}, {}, { written: 0, alreadyPresent: 1, keptVerified: 0 }]);
  // The result is corrected back to a pass: the labels are written again and stand.
  const back = await run(f, { verification: passed });
  assert.deepEqual(back.labels.written, { 'delegation.skills': { 'external-verification-with-load-after-injection': 2 }, 'supervisor.outcome': { 'external-verification': 1 } });
  assert.deepEqual([back.observations.written, (await report()).all.passRate], [1, 1]);
  assert.deepEqual(calibrationReport(await logOf(f).read()).labels.bySource.map(s => [s.source, s.labels]),
    [['external-verification', 1], ['external-verification-with-load-after-injection', 2], ['observed-load-after-injection', 4]]);
});

test('a verification by task hash is carried by the last attempt only; an abandoned first attempt is not counted as verified', async t => {
  const f = await prepared(t, { skills: 'off', supervisor: 'off' });
  const agents = [AGENT, 'b' + AGENT.slice(1)];
  const calls = [], subs = [];
  for (const [i, id] of [A, B].entries()) {
    // The same task text, delegated twice (the second with another description so that it is a new call, not a repeat).
    const pre = preCall(f, id, { description: 'toggle ' + i, subagent_type: 'general-purpose', prompt: TASK });
    const updated = (await handleHook(pre, 'claude', f.deps)).hookSpecificOutput.updatedInput;
    await handleHook(launched(pre, agents[i]), 'claude', f.deps);
    const route = (await f.store.getTask(id)).route;
    calls.push({ id, input: pre.tool_input, at: i * 100, agentId: agents[i] });
    subs.push({ agent: agents[i], rows: subRows({ agent: agents[i], prompt: updated.prompt, steps: STEPS, model: route.backend, effort: route.effort, start: i * 100 + 20 }), agentType: updated.subagent_type, toolUseId: id, model: route.backend });
  }
  await writeTranscripts(f, { main: mainRows(calls), subs });
  const summary = await run(f, { verification: verificationFor(TASK), evaluationContext: 'ctx-fixture-1' });
  assert.deepEqual([summary.delegations.seen, summary.delegations.joined, summary.verification], [2, 2, { entries: 1, matched: 1, unmatched: 0 }]);
  assert.deepEqual(summary.delegationIndex.map(d => [d.verified, d.supersededAttempt]), [[null, true], [true, false]]);
  const { observations } = await new ObservationLog(observationLogDir(f.config)).read();
  assert.deepEqual(observations.map(o => o.verification?.passed ?? null), [null, true]);
  assert.deepEqual([observationReport(observations).all.verified, observationReport(observations).all.passed], [1, 1]);
  // The task is still one evaluation unit with both attempts counted.
  const [row] = (await fs.readFile(path.join(f.stateDir, 'collector', summary.evaluations.files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual([summary.evaluations.produced, row.attempts], [1, 2]);
});

test('a load needs a reading tool and a non-error result; searches that reach the skills folder are indeterminate', () => {
  const known = new Map([['alpha', 'alpha'], ['beta', 'beta']]);
  const parse = (tools, { results = {} } = {}) => {
    const rows = subRows({ prompt: 'p', steps: tools.map((tool, i) => ({ id: 'm' + i, tools: [tool] })), model: 'm', effort: 'high' });
    for (const row of rows) for (const item of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (item.type === 'tool_result' && results[item.tool_use_id] === 'error') item.is_error = true;
    }
    return parseSubagent(rows.filter(row => !(row.message?.content?.[0]?.type === 'tool_result' && results[row.message.content[0].tool_use_id] === 'missing')), { knownSkills: known });
  };
  const bash = command => ({ name: 'Bash', input: { command } });
  const seen = (tools, options) => { const p = parse(tools, options); return [p.loaded.map(l => `${l.name}:${l.via}`), p.indeterminate]; };
  const ROOT = common.cwd;

  // Loads.
  assert.deepEqual(seen([{ name: 'Skill', input: { skill: 'alpha' } }]), [['alpha:Skill'], false]);
  assert.deepEqual(seen([bash(`cd ${ROOT} && cat .claude/skills/alpha/SKILL.md | head -40; npm test 2>&1 | tail -5`)]), [['alpha:Shell'], false]);
  assert.deepEqual(seen([bash(`head -n 30 "${ROOT}/.claude/skills/beta/SKILL.md"`)]), [['beta:Shell'], false]);
  // The call alone is not a load: an errored or missing result is indeterminate, never "loaded" and never "not loaded".
  for (const tool of [{ name: 'Skill', input: { skill: 'alpha' } }, { name: 'Read', input: { file_path: `${ROOT}/.claude/skills/alpha/SKILL.md` } }, bash('cat .claude/skills/alpha/SKILL.md')]) {
    assert.deepEqual(seen([tool], { results: { toolu_sub_1: 'error' } }), [[], true], tool.name);
    assert.deepEqual(seen([tool], { results: { toolu_sub_1: 'missing' } }), [[], true], tool.name);
  }
  assert.deepEqual(parse([{ name: 'Skill', input: { skill: 'alpha' } }], { results: { toolu_sub_1: 'error' } }).indeterminateReasons, { load_call_returned_an_error: 1 });
  // Naming the file is not reading it.
  for (const command of ['ls .claude/skills/alpha/SKILL.md', 'test -f .claude/skills/alpha/SKILL.md && echo yes', 'ls -la .claude/skills', 'find .claude/skills -name "*.md" | head',
    "find . -type f -not -path './node_modules/*' | head -100", 'echo "see .claude/skills/alpha/SKILL.md"'])
    assert.deepEqual(seen([bash(command)]), [[], false], command);
  for (const command of ['git status --short .claude/skills/alpha/SKILL.md', 'wc -l .claude/skills/alpha/SKILL.md', 'grep -n rule .claude/skills/alpha/SKILL.md',
    'cat /tmp/elsewhere/.claude/skills/alpha/SKILL.md', 'cd /tmp/elsewhere && cat .claude/skills/alpha/SKILL.md', 'cat docs/alpha/SKILL.md', 'cat .claude/skills/alpha/reference.md'])
    assert.deepEqual(seen([bash(command)]), [[], true], command);
  // A same-named SKILL.md outside the project, and another file inside a known skill folder.
  assert.deepEqual(seen([{ name: 'Read', input: { file_path: '/tmp/elsewhere/.claude/skills/alpha/SKILL.md' } }]), [[], true]);
  assert.deepEqual(seen([{ name: 'Read', input: { file_path: `${ROOT}/.claude/skills/alpha/reference.md` } }, { name: 'Glob', input: { pattern: '.claude/skills/**/*.md' } }]), [[], true]);
  assert.deepEqual(seen([{ name: 'Read', input: { file_path: '/home/someone/.claude/skills/unrelated/SKILL.md' } }, { name: 'Glob', input: { pattern: '.claude/skills/**/*.md' } }]), [[], false]);

  // Recursive content search from the project root reads skill text without naming a skill.
  for (const command of ['grep -rn -e runDue -e ledger --include=*.mjs --include=*.md . | grep -v "^./.claude/skills/periodic"', 'grep -rn "tracking" . | grep -v node_modules',
    `grep -Rl fault ${ROOT}`, 'grep -r fault .claude', 'rg --hidden fault', 'rg fault .claude/skills', 'git grep -n fault', "find . -name '*.md' -exec cat {} +",
    'find . -type f | xargs grep -l fault', 'grep -rn fault "$DIR"'])
    assert.deepEqual(seen([bash(command)]), [[], true], command);
  assert.deepEqual(parse([bash('grep -rn fault .')]).indeterminateReasons, { recursive_search_reaches_skills_folder: 1 });
  // ... unless the skills folder is left out as a whole, the search cannot match SKILL.md, or it does not reach the folder.
  for (const command of ['grep -rn fault . --exclude-dir=.claude', "grep -rn fault . | grep -v '^./.claude/skills/'", 'grep -rn fault --include=*.mjs --include=*.js .',
    'grep -rn fault src test docs README.md', 'rg fault', "rg --hidden -g '!.claude/**' fault", "find . -name '*.mjs' -exec cat {} +", "find . -not -path './.claude/*' -type f -exec cat {} +",
    'grep -n fault README.md', 'cat <<EOF > notes.txt\ngrep -rn fault .\ncat .claude/skills/alpha/SKILL.md\nEOF'])
    assert.deepEqual(seen([bash(command)]), [[], false], command);
  assert.deepEqual(seen([{ name: 'Grep', input: { pattern: 'fault' } }]), [[], true]);
  assert.deepEqual(seen([{ name: 'Grep', input: { pattern: 'fault', path: 'src' } }, { name: 'Grep', input: { pattern: 'fault', glob: '*.mjs' } }]), [[], false]);
  assert.deepEqual(seen([{ name: 'Grep', input: { pattern: 'fault' } }], { results: { toolu_sub_1: 'error' } }), [[], false]);
});

test('the skills block counts only at the end of the prompt and only with known skill names', () => {
  const known = new Map([['alpha', 'alpha']]);
  const packet = JSON.stringify({ decisionId: 'ab'.repeat(32), role: 'implement' });
  const tail = `\n\n<jev-routing>\n${packet}\n</jev-routing>\nPerform only the original native task. Preserve acceptance criteria, existing permissions, and write scope. Read required instructions and exact contracts before changes. Selected documents are a starting set, not an access allowlist. Seek missing evidence. Return changed files, executed checks, and unresolved issues. Never claim success from a worker stop. Main retains integration, scheduling and independent verification. Requested model/effort is not proof of the effective setting.`;
  const blockText = names => `<jev-skills>\n${JSON.stringify({ load: names.map(name => ({ name })), consider: [{ name: 'acme-internal-payroll' }] })}\n</jev-skills>\nLoad them.`;
  const parse = prompt => { const warnings = { counts: {}, add(k, n = 1) { this.counts[k] = (this.counts[k] ?? 0) + n; } };
    return { block: parseSubagent(subRows({ prompt, steps: STEPS, model: 'm', effort: 'high' }), { knownSkills: known }, warnings).block, warnings: warnings.counts }; };
  assert.equal(taskHash('TASK' + tail), taskHash('TASK'), 'the fixture tail is the tail the product recognises');
  // Where the hook puts it: names outside the session's project skills are dropped and counted, never stored.
  assert.deepEqual(parse('TASK' + tail + '\n\n' + blockText(['alpha', 'my-private-user-skill'])),
    { block: { present: true, load: ['alpha'], consider: [] }, warnings: { skills_block_name_not_a_known_project_skill: 2 } });
  // Typed by Main inside the task text: it is task text, not a block.
  assert.deepEqual(parse('TASK ' + blockText(['alpha']) + tail), { block: { present: false, load: null, consider: null }, warnings: {} });
  assert.deepEqual(parse('TASK ' + blockText(['alpha'])).block, { present: false, load: null, consider: null });
});

test('labels on a delegation without the block use the plain source; an unknown block gives no label and takes earlier ones back', async t => {
  // Skills point in shadow: the decision is logged, nothing is injected, so a load is not the decision's own doing.
  const { f } = await reissuedSession(t, { prepare: { skills: 'shadow' } });
  const summary = await run(f, { verification: verificationFor(TASK) });
  assert.deepEqual(summary.labels.written['delegation.skills'], { 'observed-load': 4, 'external-verification-with-load': 2 });
  const [o] = (await new ObservationLog(observationLogDir(f.config)).read()).observations;
  assert.deepEqual([o.skills.mode, o.skills.blockInPrompt, o.skills.injectedByHook], ['shadow', false, false]);
  const report = calibrationReport(await logOf(f).read());
  assert.deepEqual(report.labels.decisionInfluencedSources, []);

  // The same session read again from a transcript whose first prompt cannot be found: block presence is unknown.
  const file = path.join(f.transcripts, 'subagents', `agent-${AGENT}.jsonl`);
  const rows = parseJsonl(await fs.readFile(file, 'utf8')).rows;
  await fs.writeFile(file, jsonl(rows.filter(row => !(row.type === 'user' && typeof row.message?.content === 'string'))));
  const unknown = await run(f, { verification: verificationFor(TASK) });
  assert.deepEqual([unknown.labels.written['delegation.skills'] ?? null, unknown.labels.unlabelled.skills_block_presence_unknown, unknown.warnings.subagent_first_prompt_not_found], [null, 1, 1]);
  assert.deepEqual(unknown.labels.retracted['delegation.skills'], { 'observed-load': 4, 'external-verification-with-load': 2 });
  assert.deepEqual(calibrationReport(await logOf(f).read()).labels.bySource.map(s => s.source), ['external-verification']);
});

// ---------------------------------------------------------------- declared resolved model ids (registry `resolvesTo`)

// A registry that names the light Claude model by an alias, as the native subagent frontmatter takes it.
const aliasRegistry = (declare = null) => registry => {
  const m = registry.models.find(x => x.id === 'claude-light');
  m.model = m.backend = 'sonnet';
  if (declare) m.resolvesTo = declare;
};
const RESOLVED = 'claude-sonnet-9-9';
const observationsOf = async f => (await new ObservationLog(observationLogDir(f.config)).read()).observations;
const EMPTY_CHECK = { agreed: 0, disagreed: 0, absent: 0 };

test('model match kinds: an undeclared alias is withheld and named, a declared id gives a row, anything else is a mismatch', async t => {
  // 1. Alias, nothing declared: withheld, and the summary says exactly what would have to be declared - without declaring it.
  const a = await reissuedSession(t, { prepare: { registry: aliasRegistry() }, sub: { model: RESOLVED } });
  assert.deepEqual([a.route.model, a.route.backend], ['sonnet', 'sonnet']);
  const registryBefore = structuredClone(a.f.config.registry);
  const undeclared = await run(a.f, { verification: verificationFor(TASK), config: a.f.config });
  assert.deepEqual([undeclared.evaluations.produced, undeclared.evaluations.producedByModelMatch, undeclared.evaluations.withheld, undeclared.evaluations.files],
    [0, { exact: 0, declared: 0 }, { effective_model_alias_undeclared: 1 }, []]);
  assert.deepEqual(undeclared.modelMatch.delegations, { exact: 0, declared: 0, 'alias-undeclared': 1, mismatch: 0, notCompared: 0 });
  assert.deepEqual(undeclared.modelMatch.undeclared, [{ registryEntry: 'claude-light', backend: 'sonnet', observedModel: RESOLVED, delegations: 1,
    wouldNeed: { registryEntry: 'claude-light', resolvesTo: [RESOLVED] } }]);
  assert.match(undeclared.modelMatch.note, /^NOT ADDED\./);
  assert.equal(undeclared.modelMatch.declarationsKnown, true);
  assert.deepEqual(a.f.config.registry, registryBefore, 'the collector never touches the registry');
  assert.ok(a.f.config.registry.models.every(m => !Object.hasOwn(m, 'resolvesTo')));
  assert.equal((await observationsOf(a.f))[0].effective.modelMatch, 'alias-undeclared');
  await assert.rejects(fs.lstat(path.join(a.f.stateDir, 'collector')), code('ENOENT'));

  // 2. The same alias with the id declared BEFORE the session: a row, marked 'declared', that the importer accepts and stamps.
  const d = await reissuedSession(t, { prepare: { registry: aliasRegistry([RESOLVED]) }, sub: { model: RESOLVED } });
  const declared = await run(d.f, { verification: verificationFor(TASK), config: d.f.config });
  assert.deepEqual([declared.evaluations.produced, declared.evaluations.producedByModelMatch, declared.evaluations.withheld], [1, { exact: 0, declared: 1 }, {}]);
  assert.deepEqual([declared.modelMatch.delegations, declared.modelMatch.undeclared, declared.modelMatch.note],
    [{ exact: 0, declared: 1, 'alias-undeclared': 0, mismatch: 0, notCompared: 0 }, [], null]);
  assert.equal((await observationsOf(d.f))[0].effective.modelMatch, 'declared');
  const rows = (await fs.readFile(path.join(d.f.stateDir, 'collector', declared.evaluations.files[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(r => r.effective), [{ confirmed: true, model: RESOLVED, effort: d.route.effort, source: 'native-transcript', modelMatch: 'declared' }]);
  assert.equal((await importEvaluations(d.f.config, rows, { acceptEvidence: true })).added, 1);
  assert.deepEqual((await readEvidence(d.f.config)).rows.map(r => r.effective.modelMatch), ['declared']);
  // The same session collected with a registry that no longer declares the id: the profile fingerprint is another one.
  const withdrawn = structuredClone(d.f.config);
  aliasRegistry()(withdrawn.registry);
  delete withdrawn.registry.models.find(m => m.id === 'claude-light').resolvesTo;
  const after = await run(d.f, { verification: verificationFor(TASK), config: withdrawn, dryRun: true });
  assert.deepEqual([after.evaluations.produced, after.evaluations.withheld], [0, { effective_model_alias_undeclared: 1 }]);

  // 3. A declaration is a list of exact strings: another id of the same family is still undeclared, an unrelated id is a mismatch.
  const near = await reissuedSession(t, { prepare: { registry: aliasRegistry([RESOLVED]) }, sub: { model: 'claude-sonnet-9-8' } });
  const nearSummary = await run(near.f, { verification: verificationFor(TASK), config: near.f.config });
  assert.deepEqual([nearSummary.evaluations.produced, nearSummary.evaluations.withheld, nearSummary.modelMatch.undeclared.map(u => [u.registryEntry, u.observedModel])],
    [0, { effective_model_alias_undeclared: 1 }, [['claude-light', 'claude-sonnet-9-8']]]);
  for (const model of ['unrelated-model-1', 'claude-sonnetx-9-9', 'SONNET', 'sonnet5', RESOLVED + '-x-other']) {
    const m = await reissuedSession(t, { prepare: { registry: aliasRegistry([RESOLVED]) }, sub: { model } });
    const summary = await run(m.f, { verification: verificationFor(TASK), config: m.f.config });
    const expected = model.split(/[-.:/@]/).includes('sonnet') ? 'alias-undeclared' : 'mismatch';
    assert.deepEqual([summary.evaluations.produced, (await observationsOf(m.f))[0].effective.modelMatch], [0, expected], model);
    if (expected === 'mismatch') assert.deepEqual([summary.evaluations.withheld, summary.modelMatch.undeclared, summary.modelMatch.note], [{ effective_model_mismatch: 1 }, [], null], model);
  }

  // 4. Declared AFTER the session: the record says 'declared', but the route carries the fingerprint of the
  //    profile as it was defined then, so the importer refuses the row. New sessions are needed.
  const late = structuredClone(a.f.config);
  late.registry.models.find(m => m.id === 'claude-light').resolvesTo = [RESOLVED];
  const lateSummary = await run(a.f, { verification: verificationFor(TASK), config: late, dryRun: true });
  assert.deepEqual([lateSummary.evaluations.produced, lateSummary.evaluations.withheld, lateSummary.modelMatch.delegations.declared, lateSummary.modelMatch.undeclared],
    [0, { 'importer_refuses:STALE_EVIDENCE_PROFILE': 1 }, 1, []]);

  // 5. Without a config no declaration is known: an alias match stays withheld and the entry cannot be named.
  const bare = await run(a.f, { verification: verificationFor(TASK), evaluationContext: 'ctx-fixture-1', dryRun: true });
  assert.deepEqual([bare.evaluations.produced, bare.evaluations.withheld, bare.modelMatch.declarationsKnown, bare.modelMatch.undeclared.map(u => [u.registryEntry, u.backend, u.observedModel])],
    [0, { effective_model_alias_undeclared: 1 }, false, [[null, 'sonnet', RESOLVED]]]);
  assert.match(bare.modelMatch.note, /No config was given/);

  // Nothing in any of these summaries is text, a path or an id of the session.
  const text = JSON.stringify([undeclared, declared, nearSummary, lateSummary, bare]);
  for (const secret of ['MARKER', 'PRIVATE', AGENT, A, B, SESSION, a.f.root, 'toolu_', 'msg_']) assert.ok(!text.includes(secret), secret);
});

test('the model id the host resolved at launch is recorded by the hook and cross-checked against the subagent transcript', async t => {
  // Agreement in both places: counted, and the row is produced.
  const ok = await reissuedSession(t);
  const spawn = (await ok.f.store.events()).find(e => e.type === 'spawn_observed');
  assert.equal(spawn.resolvedModel, ok.route.backend);
  const agreed = await run(ok.f, { verification: verificationFor(TASK), config: ok.f.config });
  assert.deepEqual([agreed.evaluations.produced, agreed.modelMatch.resolvedModelCheck], [1, { hookEvent: { ...EMPTY_CHECK, agreed: 1 }, hostResult: { ...EMPTY_CHECK, agreed: 1 } }]);

  // The hook saw another id than the subagent's rows name: withheld.
  const hook = await reissuedSession(t, { sub: { resolved: 'another-model-1' } });
  const hookSummary = await run(hook.f, { verification: verificationFor(TASK), config: hook.f.config });
  assert.deepEqual([hookSummary.evaluations.produced, hookSummary.evaluations.withheld, hookSummary.modelMatch.resolvedModelCheck],
    [0, { resolved_model_disagrees_with_transcript: 1 }, { hookEvent: { ...EMPTY_CHECK, disagreed: 1 }, hostResult: { ...EMPTY_CHECK, agreed: 1 } }]);
  // Main's transcript keeps another id than the subagent's rows name: withheld.
  const result = await reissuedSession(t, { sub: { resultModel: 'another-model-1' } });
  const resultSummary = await run(result.f, { verification: verificationFor(TASK), config: result.f.config });
  assert.deepEqual([resultSummary.evaluations.produced, resultSummary.evaluations.withheld, resultSummary.modelMatch.resolvedModelCheck],
    [0, { resolved_model_disagrees_with_transcript: 1 }, { hookEvent: { ...EMPTY_CHECK, agreed: 1 }, hostResult: { ...EMPTY_CHECK, disagreed: 1 } }]);

  // A host (or older hook state) that records no resolved id: nothing to check, counted as absent, not a reason.
  const none = await reissuedSession(t, { sub: { resolved: null, resultModel: null } });
  assert.ok(!Object.hasOwn((await none.f.store.events()).find(e => e.type === 'spawn_observed'), 'resolvedModel'));
  const absent = await run(none.f, { verification: verificationFor(TASK), config: none.f.config });
  assert.deepEqual([absent.evaluations.produced, absent.modelMatch.resolvedModelCheck], [1, { hookEvent: { ...EMPTY_CHECK, absent: 1 }, hostResult: { ...EMPTY_CHECK, absent: 1 } }]);

  // Only a plain model id is stored: a value with a space, a non-string or an over-long one is dropped, and the hook output is the same.
  const f = await prepared(t);
  const pre = preCall(f, A, { description: 'toggle', subagent_type: 'general-purpose', prompt: TASK });
  await handleHook(pre, 'claude', f.deps);
  const post = (id, extra) => handleHook({ ...launched({ ...pre, tool_use_id: id }, AGENT), tool_response: { isAsync: true, status: 'async_launched', agentId: AGENT, ...extra } }, 'claude', f.deps);
  const without = await post('toolu_x0', {});
  for (const [id, value] of [['toolu_x1', 'SENTENCE_MARKER with spaces'], ['toolu_x2', { nested: 'x' }], ['toolu_x3', 'm'.repeat(161)], ['toolu_x4', 'plain-model-1']])
    assert.deepEqual(await post(id, { resolvedModel: value }), without, id);
  const stored = (await f.store.events()).filter(e => e.type === 'spawn_observed').map(e => [e.taskId, e.resolvedModel]).sort();
  assert.deepEqual(stored, [['toolu_x0', undefined], ['toolu_x1', undefined], ['toolu_x2', undefined], ['toolu_x3', undefined], ['toolu_x4', 'plain-model-1']]);
});

test('a row is evidence for the context the session ran under: the default context, or another name, cannot be relabelled afterwards', async t => {
  // The session ran under the default context, with the id declared. Nothing makes it importable.
  const s = await reissuedSession(t, { prepare: { context: DEFAULT_CONTEXT, registry: aliasRegistry([RESOLVED]) }, sub: { model: RESOLVED } });
  assert.equal(s.route.evaluationContext, DEFAULT_CONTEXT);
  const unchanged = await run(s.f, { verification: verificationFor(TASK), config: s.f.config });
  assert.deepEqual([unchanged.evaluations.produced, unchanged.evaluations.withheld, unchanged.modelMatch.delegations.declared], [0, { evaluation_context_not_configured: 1 }, 1]);
  const named = await run(s.f, { verification: verificationFor(TASK), config: withContext(s.f.config), dryRun: true });
  assert.deepEqual([named.evaluations.produced, named.evaluations.withheld], [0, { session_ran_under_default_evaluation_context: 1 }]);
  const flag = await run(s.f, { verification: verificationFor(TASK), evaluationContext: 'ctx-fixture-1', dryRun: true });
  assert.deepEqual([flag.evaluations.produced, flag.evaluations.withheld], [0, { session_ran_under_default_evaluation_context: 1, effective_model_alias_undeclared: 1 }]);
  await assert.rejects(fs.lstat(path.join(s.f.stateDir, 'collector')), code('ENOENT'));
  // A session under one named context is not evidence for another.
  const other = await reissuedSession(t);
  const renamed = await run(other.f, { verification: verificationFor(TASK), config: withContext(other.f.config, 'ctx-fixture-2'), dryRun: true });
  assert.deepEqual([renamed.evaluations.produced, renamed.evaluations.withheld], [0, { session_ran_under_another_evaluation_context: 1 }]);
});

test('end to end: named context + declared id + external verification -> candidate row -> explicit import -> the router sees it, and one row changes no choice', async t => {
  const { f, route } = await reissuedSession(t, { prepare: { registry: aliasRegistry([RESOLVED]) }, sub: { model: RESOLVED } });
  const config = f.config;
  assert.deepEqual([config.optimization.evaluationContext, route.evaluationContext, route.backend, route.optimizationBasis, route.evidence], ['ctx-fixture-1', 'ctx-fixture-1', 'sonnet', 'policy_prior_not_measured', null]);

  // Without verification there is no verdict and so no row; nothing reaches the evidence store by itself.
  const unverified = await run(f, { config, dryRun: true });
  assert.deepEqual([unverified.evaluations.produced, unverified.evaluations.withheldTasks], [0, 0]);
  const summary = await run(f, { verification: verificationFor(TASK), config });
  assert.deepEqual([summary.evaluations.produced, summary.evaluations.producedByModelMatch, summary.evaluations.imported], [1, { exact: 0, declared: 1 }, false]);
  assert.deepEqual((await readEvidence(config)).rows, []);
  const rows = (await fs.readFile(path.join(f.stateDir, 'collector', summary.evaluations.files[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  await assert.rejects(importEvaluations(config, rows), code('EXPLICIT_EVIDENCE_ACCEPTANCE_REQUIRED'));
  assert.deepEqual(await importEvaluations(config, rows, { acceptEvidence: true }).then(r => [r.added, r.total]), [1, 1]);

  // The router's own summary counts the row for the profile that ran...
  const features = { role: route.classification.role, complexity: route.classification.complexity, reasoning: route.classification.reasoning, risk: route.risk,
    information: route.classification.information, reading: route.reading, uncertain: route.uncertain };
  assert.equal(taskClass(features), route.taskClass);
  const candidates = eligibleProfiles(config.registry, 'claude', features, config).candidates;
  const stats = summarizeEvidence((await readEvidence(config)).rows, candidates, { context: config.optimization.evaluationContext, projectHash: route.projectHash, classKey: route.taskClass });
  assert.deepEqual(Object.keys(stats), [route.profile]);
  assert.deepEqual([stats[route.profile].n, stats[route.profile].successes], [1, 1]);
  // ...and one row is far below minimumSamples (30): the choice stays the policy's.
  assert.ok(stats[route.profile].n < config.optimization.minimumSamples);
  const choice = optimizeCandidates(candidates, stats, config.optimization);
  assert.deepEqual([choice.basis, choice.baseline.profileId], ['policy_prior_not_measured', optimizeCandidates(candidates, {}, config.optimization).baseline.profileId]);

  // Through the real hook, in a new session of the same project: the same profile, the same basis, and the row is visible to it.
  const session = 'session-AFTER-IMPORT';
  const next = { session_id: session, cwd: f.project, permission_mode: 'auto' };
  await handleHook({ ...next, hook_event_name: 'UserPromptSubmit', prompt_id: 'p2', prompt: 'GOAL_MARKER add a toggle', transcript_path: path.join(f.project, 't2.jsonl') }, 'claude', f.deps);
  await handleHook({ ...next, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_after_import', tool_input: { description: 'toggle', subagent_type: 'general-purpose', prompt: TASK } }, 'claude', f.deps);
  const again = (await new SessionStore(config, f.project, 'claude', session).getTask('toolu_after_import')).route;
  assert.deepEqual([again.profile, again.profileFingerprint, again.optimizationBasis, again.evidence?.n], [route.profile, route.profileFingerprint, 'policy_prior_not_measured', 1]);

  // Changing the declaration afterwards: the stored row no longer counts anywhere.
  const changed = structuredClone(config);
  changed.registry.models.find(m => m.id === 'claude-light').resolvesTo = ['claude-sonnet-9-8'];
  const later = eligibleProfiles(changed.registry, 'claude', features, changed).candidates;
  assert.deepEqual(summarizeEvidence((await readEvidence(config)).rows, later, { context: config.optimization.evaluationContext, projectHash: route.projectHash, classKey: route.taskClass }), {});
});

test('the observation report counts every match kind, reads records from before the kinds were renamed, and the CLI report shows the evidence store', async t => {
  const { f } = await reissuedSession(t, { prepare: { registry: aliasRegistry([RESOLVED]) }, sub: { model: RESOLVED } });
  const summary = await run(f, { verification: verificationFor(TASK), config: f.config });
  const [record] = await observationsOf(f);
  const variant = (kind, n) => ({ ...record, delegationId: hash(['fixture-delegation', n]), effective: { ...record.effective, modelMatch: kind } });
  const records = [record, variant('exact', 1), variant('exact', 2), variant('alias-undeclared', 3), variant('alias', 4), variant('mismatch', 5), variant(null, 6)];
  assert.ok(records.every(isObservationRecord));
  for (const bad of ['declared-ish', 'alias_undeclared', '', true]) assert.equal(isObservationRecord(variant(bad, 9)), false, String(bad));
  assert.deepEqual(observationReport(records).requestedVsEffective.model, { compared: 6, exact: 2, declared: 1, aliasUndeclared: 2, alias: 2, mismatch: 1,
    exactRate: 2 / 6, acceptedRate: 3 / 6, exactOrAliasRate: 5 / 6 });

  const rows = (await fs.readFile(path.join(f.stateDir, 'collector', summary.evaluations.files[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  await importEvaluations(f.config, rows, { acceptEvidence: true });
  const file = path.join(f.root, 'config.json');
  await fs.writeFile(file, JSON.stringify(f.config));
  let r = await child(process.execPath, [COLLECT, '--config', file, '--report']);
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual([report.requestedVsEffective.model.declared, report.requestedVsEffective.model.compared], [1, 1]);
  assert.deepEqual([report.evidenceStore.rows, report.evidenceStore.current, report.evidenceStore.byMatch], [1, 1, { exact: 0, declared: 1, unrecorded: 0 }]);
  r = await child(process.execPath, [COLLECT, '--state-dir', f.stateDir, '--report']);
  assert.deepEqual([r.code, JSON.parse(r.stdout).evidenceStore], [0, null]);
  // The collect CLI with the config names the context from the config and produces the declared row again (already present: nothing new).
  r = await child(process.execPath, [COLLECT, '--config', file, '--transcripts', f.transcripts, '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).modelMatch.delegations, { exact: 0, declared: 1, 'alias-undeclared': 0, mismatch: 0, notCompared: 0 });
});
