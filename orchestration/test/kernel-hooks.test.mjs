// Integration of the decision kernel with the native hook path: skills, supervisor, config and policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, event, answer, mockClient, child } from './helpers.mjs';
import { handleHook } from '../src/hooks.mjs';
import { eventInput, delegation, rewrite } from '../src/adapters.mjs';
import { routeContext, policyFingerprint } from '../src/policy.mjs';
import { SessionStore } from '../src/state.mjs';
import { loadConfig, validateConfig, defaults } from '../src/config.mjs';
import { install } from '../src/install.mjs';
import { performance } from 'node:perf_hooks';
import { VERSION, writeJSON, readJSON, sleep } from '../src/util.mjs';
import { kernelDefaults } from '../src/kernel/kernel.mjs';
import { DecisionLog, decisionLogDir } from '../src/kernel/log.mjs';
import { supervisorQuestions, supervisorAdvice, reportText } from '../src/kernel/supervisor.mjs';

const TASK = 'Implement the notification toggle.';
const GENERIC = 'Native delegation result observed. A spawn acknowledgement is not task completion, and a worker report is not proof of test success. Reconcile native status and verify evidence before integration.';
const REPORT = 'REPORT_MARKER changed src/toggle.js and ran npm test: 12 passed, 0 failed.';
const code = expected => error => { assert.equal(error.code, expected); return true; };

/** helpers.answer() only knows noul and choice; score questions need their own normalized shape. */
function judged(questions, overrides = {}) {
  const response = answer(questions, overrides);
  for (const [id, q] of Object.entries(questions)) {
    if (q.type !== 'score') continue;
    const score = overrides[id] ?? q.criteria.length - 1;
    response.answers[id] = {
      type: 'score', score, confidence: overrides.confidence ?? 1,
      probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === score ? 1 : 0])),
    };
  }
  return response;
}

/** Counting judge. `failOn(questions)` makes selected calls throw; every state is kept for inspection. */
function client(overrides = {}, { failOn = null, delayMs = 0, delayOn = null } = {}) {
  const calls = [];
  return {
    calls,
    get count() { return calls.length; },
    async evaluate(state, questions, scope, limits) {
      calls.push({ state, questions, limits });
      if (delayMs && (!delayOn || delayOn(questions))) await sleep(delayMs);
      if (failOn?.(questions)) throw Object.assign(new Error('JEV_HTTP_503'), { code: 'JEV_HTTP_503' });
      return { response: judged(questions, overrides), cached: false, latencyMs: 0 };
    },
  };
}
const isSkills = questions => Object.hasOwn(questions, 'need');
const isSupervisor = questions => Object.hasOwn(questions, 'outcome');

async function addSkill(project, folder, description, root = path.join(project, '.claude', 'skills')) {
  await fs.mkdir(path.join(root, folder), { recursive: true });
  await fs.writeFile(path.join(root, folder, 'SKILL.md'), `---\nname: ${folder}\ndescription: ${description}\n---\nSKILL_BODY_MARKER\n`);
}
async function withSkills(t, mode = 'active') {
  const f = await fixture(t);
  await addSkill(f.project, 'notification-toggle', 'Implement a notification toggle setting. SKILL_DESCRIPTION_MARKER');
  await addSkill(f.project, 'pdf-forms', 'Fill and flatten PDF forms.');
  f.config.kernel.points['delegation.skills'].mode = mode;
  return f;
}
const SELECT = { need: 0.95, skill_0: 0.95 };
const store = (f, runtime = 'claude') => new SessionStore(f.config, f.project, runtime, 'session-test');
const eventsOf = async (f, type) => (await store(f).events()).filter(x => x.type === type);
const decisions = async f => (await new DecisionLog(decisionLogDir(f.config)).read()).decisions;

async function stateText(dir) {
  let text = '';
  for (const name of await fs.readdir(dir, { recursive: true })) {
    const file = path.join(dir, name);
    if ((await fs.lstat(file)).isFile()) text += await fs.readFile(file, 'utf8');
  }
  return text;
}
/** A routed synchronous delegation followed by its PostToolUse report. */
async function routedThenReport(f, judge, response = { content: [{ type: 'text', text: REPORT }] }, extra = {}) {
  const pre = event(f.project);
  delete pre.tool_input.run_in_background;
  const deps = { config: f.config, client: judge };
  const routed = await handleHook(pre, 'claude', deps);
  assert.ok(routed.hookSpecificOutput.updatedInput);
  const before = judge.count;
  const out = await handleHook({ ...pre, ...extra, hook_event_name: 'PostToolUse', tool_response: response }, 'claude', deps);
  return { out, postCalls: judge.count - before };
}

// ---------------------------------------------------------------- default behaviour

test('default kernel config leaves a routed delegation exactly as before', async t => {
  const f = await fixture(t);
  await addSkill(f.project, 'notification-toggle', 'Implement a notification toggle setting.');
  assert.deepEqual(f.config.kernel, kernelDefaults());
  const judge = mockClient();
  const raw = event(f.project);
  const out = await handleHook(raw, 'claude', { config: f.config, client: judge });
  assert.equal(judge.count, 2); // classification + profile selection, nothing else

  const task = await store(f).getTask('tool-1');
  assert.deepEqual(Object.keys(task).sort(), ['inputHash', 'outputHash', 'policy', 'route', 'stamp']);
  const e = eventInput(raw, 'claude');
  assert.deepEqual(out, rewrite(e, delegation(e), task.route, routeContext(task.route, f.config), f.config));
  assert.equal(out.hookSpecificOutput.updatedInput.prompt, TASK + '\n\n' + routeContext(task.route, f.config));
  assert.ok(!out.hookSpecificOutput.updatedInput.prompt.includes('jev-skills'));
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.deepEqual(await eventsOf(f, 'skills'), []);

  // Advisory and shadow hook modes keep their previous shapes too.
  f.config.mode = 'advisory';
  const advised = await handleHook({ ...raw, tool_use_id: 'tool-2' }, 'claude', { config: f.config, client: judge });
  const second = await store(f).getTask('tool-2');
  assert.deepEqual(advised, { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext:
    `Jev advisory: consider native profile ${second.route.profile} (${second.route.model}, ${second.route.effort}). The pending tool call is UNCHANGED; do not create a duplicate worker. ${routeContext(second.route, f.config)}` } });
  f.config.mode = 'shadow';
  assert.deepEqual(await handleHook({ ...raw, tool_use_id: 'tool-3' }, 'claude', { config: f.config, client: judge }), {});
  assert.equal(judge.count, 6);
});

test('default PostToolUse outputs and judge calls are unchanged; supervisor is off', async t => {
  const f = await fixture(t);
  const judge = client();
  const { out, postCalls } = await routedThenReport(f, judge);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: GENERIC } });
  assert.equal(postCalls, 0);
  assert.deepEqual(await eventsOf(f, 'supervisor'), []);

  const failed = await handleHook({ ...event(f.project), hook_event_name: 'PostToolUseFailure', error: 'network down' }, 'claude', { config: f.config, client: judge });
  assert.equal(failed.hookSpecificOutput.additionalContext,
    'Jev failure category: environment. Native Main must decide the next step using the actual error. No automatic retry, respawn, or permission escalation was performed.');
  assert.equal(judge.count, 3);
});

// ---------------------------------------------------------------- skills

test('skills shadow is logged but never injected or shown', async t => {
  const f = await withSkills(t, 'shadow');
  const judge = client(SELECT);
  const out = await handleHook(event(f.project), 'claude', { config: f.config, client: judge });
  assert.equal(judge.count, 3);
  const task = await store(f).getTask('tool-1');
  assert.equal(out.hookSpecificOutput.updatedInput.prompt, TASK + '\n\n' + routeContext(task.route, f.config));
  assert.ok(!JSON.stringify(out).includes('jev-skills'));
  assert.equal(task.skillsText, undefined);

  const [logged] = await eventsOf(f, 'skills');
  assert.equal(logged.mode, 'shadow');
  assert.equal(logged.status, 'selected');
  assert.equal(logged.injected, false);
  assert.deepEqual(logged.load, [{ name: 'notification-toggle', probability: 0.95 }]);
  assert.ok(logged.trace.every(x => Object.keys(x).sort().join() === 'name,probability,stage'));
  const record = (await decisions(f)).find(d => d.pointId === 'delegation.skills');
  assert.equal(record.mode, 'shadow');
  assert.equal(record.decisionId, logged.decisionId);
});

test('skills active appends the block after the routing packet and replays identically', async t => {
  const f = await withSkills(t);
  const judge = client(SELECT);
  const deps = { config: f.config, client: judge };
  const raw = event(f.project);
  const a = await handleHook(raw, 'claude', deps);
  const task = await store(f).getTask('tool-1');
  const prompt = a.hookSpecificOutput.updatedInput.prompt;
  assert.equal(prompt, TASK + '\n\n' + routeContext(task.route, f.config) + '\n\n' + task.skillsText);
  assert.match(task.skillsText, /^<jev-skills>\n\{"load":\[\{"name":"notification-toggle","path":"\.claude\/skills\/notification-toggle\/SKILL\.md","p":0\.95\}\],"consider":\[\]\}\n<\/jev-skills>\n/);
  // Untrusted skill descriptions and bodies never reach the worker brief.
  assert.ok(!prompt.includes('SKILL_DESCRIPTION_MARKER') && !prompt.includes('SKILL_BODY_MARKER'));
  assert.ok(prompt.length - TASK.length - 2 <= f.config.maxContextChars);

  const b = await handleHook(raw, 'claude', deps);
  const c = await handleHook({ ...raw, tool_input: a.hookSpecificOutput.updatedInput }, 'claude', deps);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.equal(judge.count, 3); // replays never judge again
  const [logged] = await eventsOf(f, 'skills');
  assert.equal(logged.injected, true);
  // The task was sent to the judge once, together with names and descriptions as state only.
  const sent = judge.calls.find(x => isSkills(x.questions));
  assert.equal(sent.state.task, TASK);
  assert.equal(sent.limits.pointId, 'delegation.skills');
});

test('skills active in advisory mode appends to the advice and leaves the call unchanged', async t => {
  const f = await withSkills(t);
  f.config.mode = 'advisory';
  const deps = { config: f.config, client: client(SELECT) };
  const out = await handleHook(event(f.project), 'claude', deps);
  assert.equal(out.hookSpecificOutput.updatedInput, undefined);
  const task = await store(f).getTask('tool-1');
  assert.ok(out.hookSpecificOutput.additionalContext.endsWith(routeContext(task.route, f.config) + '\n\n' + task.skillsText));
  assert.deepEqual(await handleHook(event(f.project), 'claude', deps), out);

  // Shadow hook mode shows nothing even when the skills point is active.
  const quiet = await withSkills(t);
  quiet.config.mode = 'shadow';
  assert.deepEqual(await handleHook(event(quiet.project), 'claude', { config: quiet.config, client: client(SELECT) }), {});
});

test('preserved delegations short-circuit before any skill work', async t => {
  const f = await withSkills(t);
  const judge = client(SELECT);
  const deps = { config: f.config, client: judge };
  const custom = event(f.project);
  custom.tool_input.subagent_type = 'security-auditor';
  assert.deepEqual(await handleHook(custom, 'claude', deps), {});

  const explicit = event(f.project, 'claude', { tool_use_id: 'explicit' });
  explicit.tool_input.model = 'special-model';
  const nested = event(f.project, 'claude', { tool_use_id: 'nested', agent_id: 'child-1' });
  const resumed = event(f.project, 'claude', { tool_use_id: 'resumed' });
  resumed.tool_input.resume = 'agent-7';
  for (const preserved of [explicit, nested, resumed]) {
    const out = await handleHook(preserved, 'claude', deps);
    assert.equal(out.hookSpecificOutput?.updatedInput, undefined);
    assert.ok(!JSON.stringify(out).includes('jev-skills'));
  }
  assert.equal(judge.count, 0);
  assert.deepEqual(await eventsOf(f, 'skills'), []);
  assert.deepEqual(await decisions(f), []);
});

test('a failing or slow skills judge never breaks or stalls the route', async t => {
  const f = await withSkills(t);
  const failing = client(SELECT, { failOn: isSkills });
  const out = await handleHook(event(f.project), 'claude', { config: f.config, client: failing });
  const task = await store(f).getTask('tool-1');
  assert.equal(out.hookSpecificOutput.updatedInput.prompt, TASK + '\n\n' + routeContext(task.route, f.config));
  assert.equal(out.hookSpecificOutput.updatedInput.subagent_type, task.route.profile);
  const [logged] = await eventsOf(f, 'skills');
  assert.deepEqual([logged.status, logged.code, logged.injected, logged.load], ['unavailable', 'JEV_HTTP_503', false, []]);
  const record = (await decisions(f)).find(d => d.pointId === 'delegation.skills');
  assert.deepEqual([record.provider, record.model, record.trail[0].code], ['none', 'none', 'JEV_HTTP_503']);

  const slow = await withSkills(t);
  slow.config.optimization.routeDeadlineMs = 200;
  const began = Date.now();
  const late = await handleHook(event(slow.project), 'claude', { config: slow.config, client: client(SELECT, { delayMs: 900, delayOn: isSkills }) });
  assert.ok(Date.now() - began < 800);
  assert.ok(late.hookSpecificOutput.updatedInput && !JSON.stringify(late).includes('jev-skills'));
  assert.equal((await eventsOf(slow, 'skills'))[0].code, 'SKILLS_DEADLINE');

  // A deferred route still records what the skills judge said, and injects nothing.
  const deferred = await withSkills(t);
  const text = await handleHook(event(deferred.project), 'claude', { config: deferred.config, client: client({ ...SELECT, information: 'missing' }) });
  assert.match(text.hookSpecificOutput.additionalContext, /gather_missing_context/);
  assert.equal((await eventsOf(deferred, 'skills'))[0].injected, false);
});

test('the skills block is dropped, not truncated, when the context budget is exceeded', async t => {
  const f = await withSkills(t);
  const judge = client(SELECT);
  const probe = await handleHook(event(f.project), 'claude', { config: f.config, client: judge });
  const first = await store(f).getTask('tool-1');
  assert.ok(probe.hookSpecificOutput.updatedInput.prompt.includes('<jev-skills>'));

  f.config.maxContextChars = routeContext(first.route, f.config).length + 20;
  const out = await handleHook(event(f.project, 'claude', { tool_use_id: 'tight' }), 'claude', { config: f.config, client: judge });
  const task = await store(f).getTask('tight');
  assert.equal(out.hookSpecificOutput.updatedInput.prompt, TASK + '\n\n' + routeContext(task.route, f.config));
  assert.equal((await store(f).events()).find(x => x.type === 'skills' && x.taskId === 'tight').injected, false);
});

test('the local skills judge needs no network call and extra skill dirs are honoured', async t => {
  const f = await fixture(t);
  const extra = path.join(f.root, 'shared-skills');
  await addSkill(f.project, 'notification-toggle', 'Implement notification toggle settings.', extra);
  Object.assign(f.config.kernel.points['delegation.skills'], { mode: 'active', judges: ['local'] });
  Object.assign(f.config.kernel.skills, { dirs: [extra], autoLoad: 0.2, suggest: 0.1, need: 0.1 });
  const judge = mockClient();
  const out = await handleHook(event(f.project), 'claude', { config: f.config, client: judge });
  assert.equal(judge.count, 2);
  assert.match(out.hookSpecificOutput.updatedInput.prompt, /<jev-skills>\n\{"load":\[\{"name":"notification-toggle"/);
  const record = (await decisions(f)).find(d => d.pointId === 'delegation.skills');
  assert.deepEqual([record.provider, record.model], ['local', 'local-rules']);
});

// ---------------------------------------------------------------- supervisor

test('supervisor active returns clearly advisory text and records numbers only', async t => {
  const f = await fixture(t);
  f.config.kernel.points['supervisor.outcome'].mode = 'active';
  const judge = client({ outcome: 'retry', evidence: 1, confidence: 0.9 });
  const { out, postCalls } = await routedThenReport(f, judge);
  assert.equal(postCalls, 1);
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /^Jev supervisor \(advisory\): retry \(confidence 0\.90, reported evidence level 1 of 2\)\./);
  assert.ok(text.endsWith('Main must verify real evidence; no retry, respawn or permission change was performed.'));
  assert.deepEqual(Object.keys(out.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);

  const sent = judge.calls.find(x => isSupervisor(x.questions));
  assert.deepEqual(sent.state, { report: REPORT });
  assert.deepEqual(sent.questions, supervisorQuestions());
  const [logged] = await eventsOf(f, 'supervisor');
  const record = (await decisions(f)).find(d => d.pointId === 'supervisor.outcome');
  assert.deepEqual([logged.status, logged.outcome, logged.confidence, logged.evidence, logged.advisory, logged.decisionId],
    ['judged', 'retry', 0.9, 1, true, record.decisionId]);
  assert.ok(!(await stateText(f.config.stateDir)).includes('REPORT_MARKER'));

  // A plain string report is accepted as well.
  const plain = await fixture(t);
  plain.config.kernel.points['supervisor.outcome'].mode = 'active';
  const second = await routedThenReport(plain, client({ outcome: 'complete' }), REPORT);
  assert.match(second.out.hookSpecificOutput.additionalContext, /^Jev supervisor \(advisory\): complete /);
});

test('supervisor stays quiet below the confidence floor, in shadow, and in advisory-less hook modes', async t => {
  const low = await fixture(t);
  low.config.kernel.points['supervisor.outcome'].mode = 'active';
  const unsure = await routedThenReport(low, client({ outcome: 'replan', confidence: 0.4 }));
  assert.deepEqual(unsure.out, { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: GENERIC } });
  assert.equal((await eventsOf(low, 'supervisor'))[0].advisory, false);

  const shadow = await fixture(t);
  shadow.config.kernel.points['supervisor.outcome'].mode = 'shadow';
  const logged = await routedThenReport(shadow, client({ outcome: 'escalate' }));
  assert.equal(logged.postCalls, 1);
  assert.equal(logged.out.hookSpecificOutput.additionalContext, GENERIC);
  assert.equal((await eventsOf(shadow, 'supervisor'))[0].outcome, 'escalate');
  assert.equal((await decisions(shadow)).find(d => d.pointId === 'supervisor.outcome').mode, 'shadow');

  const failing = await fixture(t);
  failing.config.kernel.points['supervisor.outcome'].mode = 'active';
  const broken = await routedThenReport(failing, client({}, { failOn: isSupervisor }));
  assert.equal(broken.out.hookSpecificOutput.additionalContext, GENERIC);
  assert.deepEqual((await eventsOf(failing, 'supervisor')).map(x => [x.status, x.code]), [['unavailable', 'JEV_HTTP_503']]);
});

test('supervisor never sends a report with a secret, an unrouted delegation, or a launch acknowledgement', async t => {
  const f = await fixture(t);
  f.config.kernel.points['supervisor.outcome'].mode = 'active';
  const judge = client();
  const leaked = await routedThenReport(f, judge, { content: [{ type: 'text', text: 'done. api_key=abcdefgh12345678 was used' }] });
  assert.equal(leaked.postCalls, 0);
  assert.equal(leaked.out.hookSpecificOutput.additionalContext, GENERIC);
  assert.deepEqual((await eventsOf(f, 'supervisor')).map(x => [x.status, x.reason]), [['skipped', 'secret_guard']]);
  assert.ok(!(await stateText(f.config.stateDir)).includes('abcdefgh12345678'));
  assert.equal((await decisions(f)).filter(d => d.pointId === 'supervisor.outcome').length, 0);

  const deps = { config: f.config, client: judge };
  const before = judge.count;
  // Custom agent: never routed, so its report is never judged.
  const custom = event(f.project, 'claude', { tool_use_id: 'custom', hook_event_name: 'PostToolUse', tool_response: REPORT });
  custom.tool_input.subagent_type = 'security-auditor';
  assert.equal((await handleHook(custom, 'claude', deps)).hookSpecificOutput.additionalContext, GENERIC);
  // Background launch of a routed call: the response is an acknowledgement, not a report.
  await handleHook(event(f.project, 'claude', { tool_use_id: 'bg' }), 'claude', deps);
  const routedCalls = judge.count;
  const ack = event(f.project, 'claude', { tool_use_id: 'bg', hook_event_name: 'PostToolUse', tool_response: { content: [{ type: 'text', text: 'Async agent launched.' }] } });
  assert.equal((await handleHook(ack, 'claude', deps)).hookSpecificOutput.additionalContext, GENERIC);
  assert.equal(routedCalls - before, 2);
  assert.equal(judge.count, routedCalls);

  // Without egress consent nothing is sent at all.
  const closed = await fixture(t);
  closed.config.kernel.points['supervisor.outcome'].mode = 'active';
  closed.config.safety.allowEgress = false;
  const silent = client();
  const post = event(closed.project, 'claude', { hook_event_name: 'PostToolUse', tool_response: REPORT });
  assert.equal((await handleHook(post, 'claude', { config: closed.config, client: silent })).hookSpecificOutput.additionalContext, GENERIC);
  assert.equal(silent.count, 0);
});

test('supervisor helpers validate answers and extract report text', () => {
  const answers = judged(supervisorQuestions(), { outcome: 'complete', evidence: 2, confidence: 0.7 }).answers;
  const advice = supervisorAdvice(answers, { maxReportChars: 1600, confidence: 0.65 });
  assert.deepEqual([advice.outcome, advice.confidence, advice.evidence, advice.advisory], ['complete', 0.7, 2, true]);
  assert.equal(supervisorAdvice(answers, { confidence: 0.71 }).advisory, false);
  assert.throws(() => supervisorAdvice({ outcome: { type: 'choice', choice: 'approve', confidence: 1 }, evidence: answers.evidence }, { confidence: 0.5 }), code('INVALID_SUPERVISOR_ANSWERS'));
  assert.throws(() => supervisorAdvice({ outcome: answers.outcome }, { confidence: 0.5 }), code('INVALID_SUPERVISOR_ANSWERS'));
  assert.throws(() => supervisorAdvice(answers, {}), code('INVALID_SUPERVISOR_CONFIG'));
  const q = supervisorQuestions();
  assert.deepEqual(Object.keys(q.outcome.criteria), ['complete', 'retry', 'replan', 'escalate']);
  assert.equal(q.evidence.criteria.length, 3);
  assert.equal(reportText('plain'), 'plain');
  assert.equal(reportText({ content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(reportText([{ type: 'text', text: 'c' }]), 'c');
  assert.equal(reportText({ agent_id: 'x' }), '');
  assert.equal(reportText(null), '');
});

// ---------------------------------------------------------------- decision log and existing points

test('the decision log receives hashed records without raw text, in private files', async t => {
  const f = await withSkills(t);
  f.config.kernel.points['supervisor.outcome'].mode = 'active';
  await routedThenReport(f, client(SELECT));
  const all = await decisions(f);
  assert.deepEqual(all.map(d => d.pointId).sort(), ['delegation.classify', 'delegation.profile', 'delegation.skills', 'supervisor.outcome']);
  assert.ok(all.every(d => d.provider === 'jev' && d.model === 'jev-fixture-not-live' && /^[0-9a-f]{64}$/.test(d.stateHash)));

  const dir = decisionLogDir(f.config);
  const raw = await stateText(dir);
  for (const marker of ['notification toggle', 'REPORT_MARKER', 'SKILL_DESCRIPTION_MARKER', 'Classify the main outcome', 'instructions'])
    assert.ok(!raw.includes(marker), marker);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    for (const name of await fs.readdir(dir)) assert.equal((await fs.stat(path.join(dir, name))).mode & 0o777, 0o600);
  }

  // JEV_DECISION_LOG=false equivalent: nothing is written, routing is unaffected.
  const off = await fixture(t);
  off.config.kernel.log = false;
  const out = await handleHook(event(off.project), 'claude', { config: off.config, client: mockClient() });
  assert.ok(out.hookSpecificOutput.updatedInput);
  await assert.rejects(fs.stat(decisionLogDir(off.config)), e => e.code === 'ENOENT');
});

test('existing judgments honour their point mode', async t => {
  const f = await fixture(t);
  f.config.kernel.points['failure.classify'].mode = 'off';
  const judge = client();
  const failure = { ...event(f.project), hook_event_name: 'PostToolUseFailure', error: 'network down' };
  assert.equal((await handleHook(failure, 'claude', { config: f.config, client: judge })).hookSpecificOutput.additionalContext, GENERIC);
  assert.equal(judge.count, 0);
  f.config.kernel.points['failure.classify'].mode = 'shadow';
  assert.equal((await handleHook(failure, 'claude', { config: f.config, client: judge })).hookSpecificOutput.additionalContext, GENERIC);
  assert.equal(judge.count, 1);
  assert.deepEqual(await eventsOf(f, 'failure'), []);

  const read = await fixture(t);
  read.config.readAdvice = true;
  const readEvent = { ...event(read.project), tool_name: 'Read', tool_input: { file_path: path.join(read.project, 'docs', 'api.md') } };
  read.config.kernel.points['read.advice'].mode = 'shadow';
  const reader = client({ kind: 'api_schema' });
  assert.deepEqual(await handleHook(readEvent, 'claude', { config: read.config, client: reader }), {});
  assert.equal(reader.count, 1);
  read.config.kernel.points['read.advice'].mode = 'off';
  assert.deepEqual(await handleHook(readEvent, 'claude', { config: read.config, client: reader }), {});
  assert.equal(reader.count, 1);

  // A shadow classification is logged but must not steer the native call.
  const shadow = await fixture(t);
  shadow.config.kernel.points['delegation.classify'].mode = 'shadow';
  const shadowJudge = client();
  assert.deepEqual(await handleHook(event(shadow.project), 'claude', { config: shadow.config, client: shadowJudge }), {});
  assert.equal(shadowJudge.count, 1);

  // A profile point that is off or shadow keeps the policy incumbent.
  for (const mode of ['off', 'shadow']) {
    const incumbent = await fixture(t);
    incumbent.config.kernel.points['delegation.profile'].mode = mode;
    const routed = await handleHook(event(incumbent.project), 'claude', { config: incumbent.config, client: client() });
    assert.ok(routed.hookSpecificOutput.updatedInput);
    const reason = (await store(incumbent).getTask('tool-1')).route.decisionReason;
    assert.equal(reason, mode === 'off' ? 'selector_unavailable_incumbent' : 'selector_shadow_only_incumbent');
  }
});

test('a shadow classification point is silent in every hook mode and stores no deferred task', async t => {
  for (const mode of ['active', 'advisory', 'shadow']) {
    const f = await fixture(t);
    f.config.mode = mode;
    f.config.failureMode = 'block';
    f.config.kernel.points['delegation.classify'].mode = 'shadow';
    const judge = client();
    const deps = { config: f.config, client: judge };
    assert.deepEqual(await handleHook(event(f.project), 'claude', deps), {}, mode);
    assert.equal(judge.count, 1);
    // Logged by the kernel, visible nowhere else: no deferred task, no "gather missing evidence" replay.
    assert.equal(await store(f).getTask('tool-1'), null);
    assert.deepEqual(await eventsOf(f, 'route_deferred'), []);
    assert.deepEqual((await eventsOf(f, 'routing_skipped')).map(x => x.reason), ['classification_point_shadow_only']);
    assert.deepEqual((await decisions(f)).map(d => [d.pointId, d.mode]), [['delegation.classify', 'shadow']]);
    assert.deepEqual(await handleHook(event(f.project), 'claude', deps), {}, mode + ' retry');
    assert.ok(!(await stateText(f.config.stateDir)).includes('gather missing evidence'));
  }
});

test('an off classification point disables routing without an error, a deny, or any judge call', async t => {
  const f = await withSkills(t, 'active');
  f.config.failureMode = 'block';
  f.config.kernel.points['delegation.classify'].mode = 'off';
  const judge = client(SELECT);
  for (const mode of ['active', 'advisory', 'shadow']) {
    f.config.mode = mode;
    assert.deepEqual(await handleHook(event(f.project), 'claude', { config: f.config, client: judge }), {}, mode);
  }
  // Neither classification nor the parallel skills judgment was started.
  assert.equal(judge.count, 0);
  assert.deepEqual(await decisions(f), []);
  assert.deepEqual(await eventsOf(f, 'hook_error'), []);
  assert.deepEqual(await eventsOf(f, 'skills'), []);
  assert.deepEqual((await eventsOf(f, 'routing_skipped')).map(x => x.reason), Array(3).fill('classification_point_off'));
  assert.equal(await store(f).getTask('tool-1'), null);

  // A real outage is still an outage: strict mode keeps denying when the classifier fails.
  const outage = await fixture(t);
  outage.config.failureMode = 'block';
  const denied = await handleHook(event(outage.project), 'claude', { config: outage.config, client: client({}, { failOn: () => true }) });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /JEV_HTTP_503/);
});

test('a classification judge chain shares one budget and still returns the strict deny', async t => {
  const f = await fixture(t);
  f.config.failureMode = 'block';
  f.config.timeoutMs = 1200;
  f.config.optimization.routeDeadlineMs = 200;
  f.config.kernel.points['delegation.classify'].judges = ['jev', 'local'];
  // The first judge stalls for most of the budget and then fails; the second must not get a fresh timeout.
  const judge = client({}, { delayMs: 170, failOn: () => true });
  const began = performance.now();
  const out = await handleHook(event(f.project), 'claude', { config: f.config, client: judge });
  assert.ok(performance.now() - began < 1000);
  assert.equal(judge.count, 1);
  assert.ok(judge.calls[0].limits.timeoutMs <= 200 && judge.calls[0].limits.timeoutMs > 100);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /KERNEL_DEADLINE/);
  const [record] = await decisions(f);
  assert.deepEqual(record.trail.map(s => [s.provider, s.code]), [['jev', 'JEV_HTTP_503'], ['local', 'KERNEL_DEADLINE']]);
  assert.deepEqual((await eventsOf(f, 'hook_error')).map(x => x.code), ['KERNEL_DEADLINE']);
});

test('an invalid kernel fails closed as a typed hook warning', async t => {
  const f = await fixture(t);
  f.config.kernel.points['delegation.skills'].mode = 'always';
  const judge = mockClient();
  const out = await handleHook(event(f.project), 'claude', { config: f.config, client: judge });
  assert.equal(out.hookSpecificOutput.updatedInput, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /INVALID_KERNEL_POINT_MODE/);
  assert.equal(judge.count, 0);
});

// ---------------------------------------------------------------- policy and config

test('a kernel change alters the policy fingerprint and invalidates a pending call', async t => {
  const f = await fixture(t);
  const base = policyFingerprint(f.config);
  const { kernel, ...legacy } = f.config;
  assert.equal(policyFingerprint(legacy), base); // a config without a kernel block means the defaults
  const judge = mockClient();
  const first = await handleHook(event(f.project), 'claude', { config: f.config, client: judge });
  assert.ok(first.hookSpecificOutput.updatedInput);

  f.config.kernel.points['delegation.skills'].mode = 'shadow';
  assert.notEqual(policyFingerprint(f.config), base);
  const again = await handleHook(event(f.project), 'claude', { config: f.config, client: judge });
  assert.match(again.hookSpecificOutput.additionalContext, /POLICY_CHANGED_DURING_PENDING_CALL/);
  assert.equal(again.hookSpecificOutput.updatedInput, undefined);
  assert.equal(judge.count, 2);

  for (const change of [k => { k.skills.autoLoad = 0.95; }, k => { k.supervisor.confidence = 0.7; }, k => { k.providers.openai.approved = true; }, k => { k.log = false; }]) {
    const c = structuredClone(f.config);
    c.kernel = kernelDefaults();
    change(c.kernel);
    assert.notEqual(policyFingerprint(c), base);
  }
});

async function configFile(t, edit = c => c) {
  const f = await fixture(t);
  const dir = path.join(f.home, '.config', 'jev-hooks');
  const file = path.join(dir, 'config.json');
  await writeJSON(file, edit(structuredClone(f.config)));
  return { ...f, dir, file };
}

test('a config file without a kernel block, or with a partial one, loads with defaults', async t => {
  const legacy = await configFile(t, c => { delete c.kernel; return c; });
  assert.deepEqual((await loadConfig(legacy.file, {})).config.kernel, kernelDefaults());

  const partial = await configFile(t, c => { c.kernel = { points: { 'delegation.skills': { mode: 'shadow' } }, skills: { maxLoaded: 1 } }; return c; });
  const { config } = await loadConfig(partial.file, {});
  assert.deepEqual(config.kernel.points['delegation.skills'], { mode: 'shadow', judges: ['jev'], escalateBelow: 0 });
  assert.equal(config.kernel.skills.maxLoaded, 1);
  assert.equal(config.kernel.skills.autoLoad, kernelDefaults().skills.autoLoad);
  assert.deepEqual(config.kernel.points['delegation.classify'], kernelDefaults().points['delegation.classify']);

  for (const [kernel, expected] of [
    [{ points: { 'delegation.skills': { mode: 'always' } } }, 'INVALID_KERNEL_POINT_MODE'],
    [{ points: { 'delegation.typo': { mode: 'off', judges: ['jev'], escalateBelow: 0 } } }, 'INVALID_KERNEL_POINTS'],
    [{ skills: { dirs: ['relative/dir'] } }, 'INVALID_KERNEL_SKILLS_DIRS'],
    ['shadow', 'INVALID_KERNEL'],
  ]) {
    const bad = await configFile(t, c => { c.kernel = kernel; return c; });
    await assert.rejects(loadConfig(bad.file, {}), code(expected));
  }
  const c = defaults('/tmp/h');
  delete c.kernel;
  assert.throws(() => validateConfig(c), code('INVALID_KERNEL')); // validation itself is strict; loading merges first
});

test('kernel env overrides parse from process env and the private .env', async t => {
  const f = await configFile(t);
  const dirs = [path.join(f.root, 'skills-a'), path.join(f.root, 'skills-b')];
  const { config } = await loadConfig(f.file, {
    JEV_SKILLS_MODE: 'active', JEV_SUPERVISOR_MODE: 'shadow', JEV_SKILLS_JUDGES: 'local, jev', JEV_SUPERVISOR_JUDGES: 'openai,jev',
    JEV_DECISION_JUDGES: 'jev,openai', JEV_SKILL_DIRS: dirs.join(path.delimiter), JEV_OPENAI_DECISIONS_APPROVED: 'true',
    JEV_OPENAI_DECISIONS_MODEL: 'operator-chosen-model', JEV_DECISION_LOG: 'false',
  });
  const k = config.kernel;
  assert.deepEqual(k.points['delegation.skills'], { mode: 'active', judges: ['local', 'jev'], escalateBelow: 0 });
  assert.deepEqual(k.points['supervisor.outcome'], { mode: 'shadow', judges: ['openai', 'jev'], escalateBelow: 0 });
  for (const id of ['delegation.classify', 'delegation.profile', 'failure.classify', 'read.advice'])
    assert.deepEqual(k.points[id], { mode: 'active', judges: ['jev', 'openai'], escalateBelow: 0 });
  assert.deepEqual(k.skills.dirs, dirs);
  assert.deepEqual(k.providers.openai, { endpoint: 'https://api.openai.com', model: 'operator-chosen-model', approved: true });
  assert.equal(k.log, false);

  // Private .env values apply too; process env wins; keys reach runtimeEnv only.
  await fs.writeFile(path.join(f.dir, '.env'), 'JEV_SKILLS_MODE=shadow\nJEV_SUPERVISOR_MODE=active\nOPENAI_API_KEY=openai-test-key-not-real\n', { mode: 0o600 });
  const disk = await loadConfig(f.file, { JEV_SUPERVISOR_MODE: 'off' });
  assert.equal(disk.config.kernel.points['delegation.skills'].mode, 'shadow');
  assert.equal(disk.config.kernel.points['supervisor.outcome'].mode, 'off');
  assert.equal(disk.runtimeEnv.OPENAI_API_KEY, 'openai-test-key-not-real');
  assert.ok(!JSON.stringify(disk.config).includes('openai-test-key-not-real'));
  assert.equal(disk.apiKey, '');
});

test('kernel env overrides reject bad values with typed codes', async t => {
  const f = await configFile(t);
  for (const [key, value] of [
    ['JEV_SKILLS_MODE', 'on'], ['JEV_SUPERVISOR_MODE', 'ACTIVE'],
    ['JEV_SKILLS_JUDGES', 'jev,gemini'], ['JEV_SKILLS_JUDGES', 'jev,jev'], ['JEV_SUPERVISOR_JUDGES', 'jev,,local'], ['JEV_DECISION_JUDGES', 'jev openai'],
    ['JEV_SKILL_DIRS', 'relative/skills'], ['JEV_SKILL_DIRS', Array.from({ length: 9 }, (_, i) => '/abs/' + i).join(path.delimiter)],
    ['JEV_OPENAI_DECISIONS_APPROVED', 'yes'], ['JEV_OPENAI_DECISIONS_MODEL', 'bad model name'], ['JEV_DECISION_LOG', '1'],
  ]) {
    await assert.rejects(loadConfig(f.file, { [key]: value }), code('INVALID_' + key), `${key}=${value}`);
  }
});

// ---------------------------------------------------------------- packaging and CLI

test('the installed runtime ships src/kernel and upgrades a config without a kernel block', async t => {
  const f = await fixture(t);
  const first = await install({ home: f.home, project: f.project, yes: true });
  const snapshot = path.join(await fs.realpath(f.home), '.local', 'share', 'jev-hooks', VERSION);
  for (const name of ['kernel.mjs', 'judges.mjs', 'answers.mjs', 'log.mjs', 'skills.mjs', 'supervisor.mjs', 'calibration.mjs'])
    assert.ok(first.files.includes(path.join(snapshot, 'src', 'kernel', name)), name);
  const file = path.join(f.home, '.config', 'jev-hooks', 'config.json');
  const installed = await readJSON(file);
  assert.deepEqual(installed.kernel, kernelDefaults());

  // The installed entrypoint resolves its kernel imports and stays silent in shadow mode.
  const run = await child(process.execPath, [path.join(snapshot, 'bin', 'jev-hook.mjs'), '--runtime', 'claude', '--config', file],
    { input: JSON.stringify({ ...event(f.project), hook_event_name: 'SessionStart' }), env: { PATH: process.env.PATH, HOME: f.home } });
  assert.deepEqual([run.code, run.stdout, run.stderr], [0, '{}\n', '']);

  delete installed.kernel;
  await writeJSON(file, installed);
  assert.deepEqual((await loadConfig(file, {})).config.kernel, kernelDefaults());
  const again = await install({ home: f.home, project: f.project, yes: true });
  assert.deepEqual(again.files, [file]);
  assert.deepEqual((await readJSON(file)).kernel, kernelDefaults());
});

test('skills CLI --judge config runs the configured point and writes the decision log', async t => {
  const f = await withSkills(t, 'shadow');
  Object.assign(f.config.kernel.points['delegation.skills'], { judges: ['local'] });
  Object.assign(f.config.kernel.skills, { autoLoad: 0.2, suggest: 0.1, need: 0.1 });
  const file = path.join(f.home, '.config', 'jev-hooks', 'config.json');
  await writeJSON(file, f.config);
  const run = args => child(process.execPath, ['scripts/skills.mjs', '--project', f.project, '--task', TASK, ...args], { env: { PATH: process.env.PATH, HOME: f.home } });

  const configured = await run(['--judge', 'config', '--config', file]);
  assert.equal(configured.code, 0, configured.stderr);
  const out = JSON.parse(configured.stdout);
  assert.deepEqual([out.judge, out.point, out.mode, out.judges, out.status], ['config', 'delegation.skills', 'shadow', ['local'], 'selected']);
  assert.equal(out.load[0].name, 'notification-toggle');
  const [record] = await decisions(f);
  assert.deepEqual([record.pointId, record.provider, record.scope, record.decisionId], ['delegation.skills', 'local', 'cli', out.decisionId]);

  // Local mode stays the default and leaves the log alone.
  const local = JSON.parse((await run([])).stdout);
  assert.equal(local.judge, 'local-lexical-uncalibrated');
  assert.equal((await decisions(f)).length, 1);

  f.config.kernel.points['delegation.skills'].mode = 'off';
  await writeJSON(file, f.config);
  const off = JSON.parse((await run(['--judge', 'config', '--config', file])).stdout);
  assert.deepEqual([off.status, off.code, off.load], ['unavailable', 'KERNEL_POINT_OFF', []]);

  for (const [args, expected] of [[['--judge', 'config'], 'CONFIG_NOT_ABSOLUTE'], [['--judge', 'remote'], 'INVALID_JUDGE'], [['--config', file], 'CONFIG_NOT_ABSOLUTE']]) {
    const bad = await run(args);
    assert.deepEqual([bad.code, bad.stderr.trim()], [1, expected]);
  }
});
