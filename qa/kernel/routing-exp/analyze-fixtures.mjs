// Synthetic session files for the analyzer tests. Everything here is made up: the ids, the models' token counts,
// the timings. Only the SHAPES follow what the earlier real sessions looked like (see the header of analyze.mjs):
// conversation rows next to request-log rows, one API message split over several rows, the refused call and the
// re-issued call of a hooked arm, three files per subagent, hook events per tool-use id, a strict decision log.
//   writeArmFixture(dir, { arm, tasks, plan, ... }) -> { transcripts, stateDir }
// plan[taskId] is one of
//   { kind: 'plain', model, effort }                         one Agent call, launched as issued (arm N; or a hooked arm whose route was deferred)
//   { kind: 'routed', profile, model, effort, ... }          refused call + re-issued call, route + delegation_reissued events
//   { kind: 'deferred', reason, model, effort }              route_deferred event, one call, launched as issued
//   { kind: 'skipped' }                                      Main never delegates the task
// and may carry flags that damage the records on purpose: noMeta, noTranscript, noUsage, notFinished, twoModels.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeContext } from '../../../orchestration/src/policy.mjs';

const hex = (text) => createHash('sha256').update(String(text)).digest('hex');
const START = Date.parse('2026-11-20T01:00:00.000Z');
export const MAIN_MODEL = 'claude-fable-5-2';

export function writeArmFixture(dir, { arm, tasks, plan, mainPrompt = '', launcherText = 'Synthetic launcher line.\n\n', context = 'desktop-auto-v1',
  profiles = new Map(), decisionLog = true, judgeUsage = true, projectHash = hex('synthetic-project') }) {
  const transcripts = join(dir, 'transcripts');
  const stateDir = join(dir, 'state');
  mkdirSync(join(transcripts, 'subagents'), { recursive: true });
  const main = [];
  const events = [];
  const decisions = [];
  let clock = START, message = 0, sequence = 0;
  const tick = (ms) => { clock += ms; return new Date(clock).toISOString(); };
  const usage = (n) => ({ input_tokens: 10 + n, output_tokens: 100 + n, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 50 + n });
  const event = (type, fields) => events.push({ type, time: clock + (sequence += 1) / 1000, ...fields });

  main.push({ type: 'user', timestamp: tick(0), permissionMode: 'auto', version: '2.1.332', entrypoint: 'claude-desktop', cwd: '/synthetic/project',
    message: { role: 'user', content: launcherText + mainPrompt } });
  // A planning turn of Main: two rows of one API message, plus the request-log copy that must not be counted.
  const planId = `msg_main_${message += 1}`;
  for (const block of [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Starting.' }]) {
    main.push({ type: 'assistant', isSidechain: false, timestamp: tick(1000), effort: 'high', message: { id: planId, model: MAIN_MODEL, role: 'assistant', content: [block], usage: usage(1) } });
  }
  main.push({ type: 'api-request', timestamp: tick(0), message: { id: planId, model: MAIN_MODEL, role: 'assistant', content: [{ type: 'text', text: 'Starting.' }], usage: usage(1) } });

  tasks.forEach((task, index) => {
    const step = plan[task.id] ?? { kind: 'skipped' };
    if (step.kind === 'skipped') return;
    const n = index + 1;
    const agentId = `a${String(n).padStart(2, '0')}${hex(task.id).slice(0, 12)}`;
    const issue = (toolUseId, input) => {
      const id = `msg_main_${message += 1}`;
      main.push({ type: 'assistant', isSidechain: false, timestamp: tick(2000), effort: 'high', message: { id, model: MAIN_MODEL, role: 'assistant', content: [{ type: 'text', text: `Task ${n}.` }], usage: usage(n) } });
      main.push({ type: 'assistant', isSidechain: false, timestamp: tick(10), effort: 'high', message: { id, model: MAIN_MODEL, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input }], usage: usage(n) } });
      main.push({ type: 'api-request-blob', timestamp: tick(0), message: { id, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input }], usage: usage(n) } });
    };
    const first = `toolu_${task.id}_a`;
    const plainInput = { description: `task ${n}`, subagent_type: 'general-purpose', prompt: task.text };
    let launchedId = first, launchedInput = plainInput;
    issue(first, plainInput);

    if (step.kind === 'routed') {
      const profile = profiles.get(step.profile) ?? { profileId: step.profile, fingerprint: hex(step.profile), model: step.requestedModel ?? step.model, backend: step.requestedModel ?? step.model, role: 'implement', slot: 'light' };
      const ids = { classify: hex(`classify-${task.id}`), profile: hex(`profile-${task.id}`) };
      const route = { role: profile.role, tier: profile.slot, model: profile.model, backend: profile.backend, effort: step.routeEffort ?? step.effort, profile: profile.profileId, profileFingerprint: profile.fingerprint,
        reading: 'standard', risk: 'normal', documents: [], requiresReview: false, taskClass: 'implement-normal', optimizationBasis: 'policy_prior_not_measured',
        decisionId: hex(`route-${task.id}`), projectHash, evaluationContext: context };
      const rewritten = { description: plainInput.description, prompt: `${task.text}\n\n${routeContext(route, { maxContextChars: 3500 })}`, subagent_type: profile.profileId };
      event('route', { taskId: first, inputHash: hex(`in-${task.id}`), route, mode: step.mode ?? 'active', judgeDecisionIds: ids, cached: false, latencyMs: 700 + n, hookMs: 800 + n, questionVersion: 'synthetic' });
      for (const [point, id] of [['delegation.classify', ids.classify], ['delegation.profile', ids.profile]]) {
        decisions.push({ schema: 1, decisionId: id, time: clock, pointId: point, mode: 'active', provider: 'jev', model: 'jev-latest', cached: point === 'delegation.profile' && step.cachedProfileDecision === true,
          latencyMs: 300 + n, confidence: 0.9, scope: hex('scope'), subject: null, questionsHash: hex('q'), stateHash: hex(`s-${id}`), answers: {}, trail: [{ provider: 'jev', ok: true, latencyMs: 300 + n }],
          ...(judgeUsage && !(point === 'delegation.profile' && step.cachedProfileDecision === true) ? { usage: { input_tokens: 400 + n, output_tokens: 20 + n } } : {}) });
      }
      main.push({ type: 'attachment', timestamp: tick(900), attachment: { type: 'hook_success', hookName: 'PreToolUse:Agent', toolUseID: first, hookEvent: 'PreToolUse', content: '', stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: rewritten } }) } });
      main.push({ type: 'user', timestamp: tick(10), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: first, is_error: true, content: 'A hook changed the input of this call. Issue it again with the changed input (synthetic).' }] },
        toolUseResult: 'Error: refused (synthetic)', permissionDecision: { decision: 'reject', source: 'config', reasonType: 'classifier' }, toolDenialKind: 'automode-unavailable' });
      if (step.neverReissued) return;
      launchedId = `toolu_${task.id}_b`;
      launchedInput = rewritten;
      issue(launchedId, rewritten);
      if (step.reissueLinked !== false) event('delegation_reissued', { taskId: launchedId, reissueOf: first, decisionId: route.decisionId, profile: profile.profileId, skillsDecisionIds: [], skillsInjected: false, inputHash: hex(`out-${task.id}`), ageMs: 6000 + n });
    } else if (step.kind === 'deferred') {
      event('route_deferred', { taskId: first, reason: step.reason ?? 'selector_abstained' });
    }

    main.push({ type: 'user', timestamp: tick(300), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: launchedId, content: [{ type: 'text', text: 'Async agent launched (synthetic).' }] }] },
      toolUseResult: { status: 'async_launched', agentId, description: launchedInput.description } });
    if (arm !== 'N') {
      event('spawn_observed', { taskId: launchedId, failed: false, agentId, taskName: null });
      event('agent_started', { agentId, agentType: launchedInput.subagent_type });
    }

    // The subagent: prompt row, a harness reminder, three API messages (the second split over two rows), tool results.
    const agentModel = step.model, effort = step.effort;
    const rows = [];
    const sub = (row) => rows.push({ isSidechain: true, agentId, cwd: '/synthetic/project', ...row });
    sub({ type: 'user', timestamp: tick(200), message: { role: 'user', content: launchedInput.prompt } });
    sub({ type: 'user', isMeta: true, timestamp: tick(0), message: { role: 'user', content: '<system-reminder>synthetic</system-reminder>' } });
    sub({ type: 'attachment', timestamp: tick(0), attachment: { type: 'hook_success', hookName: 'SubagentStart', hookEvent: 'SubagentStart', content: '', stdout: '' } });
    const turn = (k, content, model = agentModel) => ({ type: 'assistant', timestamp: tick(4000), ...(effort ? { effort } : {}),
      message: { id: `msg_${task.id}_${k}`, model, role: 'assistant', content, ...(step.noUsage ? {} : { usage: usage(n * 10 + k) }) } });
    sub(turn(1, [{ type: 'tool_use', id: `toolu_${task.id}_s1`, name: 'Read', input: { file_path: '/synthetic/project/src/app.mjs' } }]));
    sub({ type: 'user', timestamp: tick(50), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${task.id}_s1`, content: 'file text' }] } });
    const second = turn(2, [{ type: 'text', text: 'Editing.' }]);
    sub(second);
    sub({ ...second, timestamp: tick(5), message: { ...second.message, content: [{ type: 'tool_use', id: `toolu_${task.id}_s2`, name: 'Edit', input: { file_path: '/synthetic/project/src/x.mjs', old_string: 'a', new_string: 'b' } }] } });
    sub({ type: 'api-request', timestamp: tick(0), message: { ...second.message } });
    sub({ type: 'user', timestamp: tick(50), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${task.id}_s2`, content: 'ok' }] } });
    sub(turn(3, [{ type: 'text', text: 'Done (synthetic report).' }], step.twoModels ? 'claude-other-9' : agentModel));
    sub({ type: 'system', timestamp: tick(30000), subtype: 'bookkeeping' });
    if (!step.noTranscript) {
      writeFileSync(join(transcripts, 'subagents', `agent-${agentId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      if (!step.noMeta) writeFileSync(join(transcripts, 'subagents', `agent-${agentId}.meta.json`), JSON.stringify({ agentType: launchedInput.subagent_type, isBuiltIn: launchedInput.subagent_type === 'general-purpose',
        description: launchedInput.description, toolUseId: launchedId, spawnDepth: 1, model: agentModel, finished: step.notFinished ? false : true }));
      writeFileSync(join(transcripts, 'subagents', `agent-${agentId}.prefix.json`), JSON.stringify({ v: 1 }));
    }
    if (arm !== 'N') event('agent_stopped', { agentId, agentType: launchedInput.subagent_type, reportHash: hex('report'), verification: 'not_inferred' });
    // The report comes back to Main later, as a user row; Main answers with one short turn.
    main.push({ type: 'user', timestamp: tick(500), message: { role: 'user', content: `<task-notification>agent ${agentId} finished (synthetic)</task-notification>` } });
    const ack = `msg_main_${message += 1}`;
    main.push({ type: 'assistant', isSidechain: false, timestamp: tick(1500), effort: 'high', message: { id: ack, model: MAIN_MODEL, role: 'assistant', content: [{ type: 'text', text: `Task ${n} reported.` }], usage: usage(n) } });
  });
  main.push({ type: 'system', timestamp: tick(60000), subtype: 'turn_duration' });
  // One line that is not JSON, as a cut or damaged line would be: it must be counted and skipped.
  const lines = main.map((row) => JSON.stringify(row));
  lines.splice(1, 0, 'not json at all');
  writeFileSync(join(transcripts, 'main.jsonl'), lines.join('\n') + '\n');

  if (arm !== 'N') {
    const scope = hex(`session-${arm}`);
    const setup = hex(`setup-${arm}`);
    mkdirSync(join(stateDir, 'sessions', scope, 'events'), { recursive: true });
    mkdirSync(join(stateDir, 'sessions', setup, 'events'), { recursive: true });
    writeFileSync(join(stateDir, 'sessions', setup, 'events', '0001.json'), JSON.stringify({ type: 'session_started', time: START - 60000, source: 'startup', runtime: 'claude' }));
    writeFileSync(join(stateDir, 'sessions', scope, 'events', '0000.json'), JSON.stringify({ type: 'session_started', time: START - 1, source: 'startup', runtime: 'claude' }));
    events.forEach((entry, i) => writeFileSync(join(stateDir, 'sessions', scope, 'events', `${String(i + 1).padStart(4, '0')}.json`), JSON.stringify(entry)));
    if (decisionLog) {
      mkdirSync(join(stateDir, 'decisions-log'), { recursive: true });
      writeFileSync(join(stateDir, 'decisions-log', 'decisions-2026-11.jsonl'), decisions.map((row) => JSON.stringify(row)).join('\n') + '\n');
    }
  }
  return { transcripts, stateDir: arm === 'N' ? null : stateDir };
}
