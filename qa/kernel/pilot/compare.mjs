#!/usr/bin/env node
// Paired table of two analyze.mjs outputs.   node compare.mjs --a <armA.json> --b <armB.json> [--json]
// Descriptive only: one run per arm, six pairs. It prints counts and differences, no test statistic.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const show = (value) => (value === null || value === undefined ? '-' : value === true ? 'yes' : value === false ? 'no' : String(value));
const seconds = (ms) => (typeof ms === 'number' ? (ms / 1000).toFixed(1) : null);
const ratio = (c) => (c ? `${c.yes}/${c.of}${c.measured !== c.of ? ` (measured ${c.measured})` : ''}` : '-');
const sum = (t) => (t ? `${show(t.sum)}${t.measured !== t.of ? ` (measured ${t.measured}/${t.of})` : ''}` : '-');

export function compare(a, b) {
  const ids = a.tasks.map((task) => task.id);
  const bById = new Map(b.tasks.map((task) => [task.id, task]));
  const problems = [];
  if (ids.join(',') !== b.tasks.map((task) => task.id).join(',')) problems.push('the two files do not list the same tasks in the same order');
  const pairs = a.tasks.map((ta) => {
    const tb = bById.get(ta.id) ?? null;
    const side = (t) => (t ? {
      done: t.check?.done ?? null,
      convention: t.check?.convention ?? null,
      injected: t.hook?.injected ?? null,
      injectedLoad: t.hook?.load ?? null,
      blockedBy: t.check?.blockedBy ?? [],
      delegated: t.delegation !== null && t.delegation !== undefined,
      agentCalls: t.delegation?.agentCalls ?? 0,
      targetSkillLoaded: t.subagent?.targetSkillLoaded ?? null,
      targetSkillLoadedVia: t.subagent?.targetSkillLoadedVia ?? null,
      targetListedToSubagent: t.subagent?.targetListedToSubagent ?? null,
      loadedSkills: t.subagent ? t.subagent.loadedSkills.map((entry) => entry.name) : null,
      toolCalls: t.subagent?.toolCalls ?? null,
      tokens: t.subagent?.tokens?.total ?? null,
      wallMs: t.subagent?.wallMs ?? null,
      outOfScopeWrites: t.subagent?.outOfScopeWrites ?? null,
      warnings: t.warnings?.length ?? 0,
      // ---- schema 3 fields (absent in older arm files: every one falls back to null)
      refusedAttempts: t.delegationDetail?.refusedAttempts ?? null,
      launchedCalls: t.delegationDetail?.launchedCalls ?? null,
      scoredPromptIsHookRewrite: t.delegationDetail?.scoredPromptIsHookRewrite ?? null,
      firstCallPromptVerbatim: t.delegationDetail?.firstCallPromptVerbatim ?? null,
      agentType: t.effective?.agentType ?? null,
      model: t.effective?.model ?? null,
      effort: t.effective?.effort ?? null,
      // Did this task run as PROTOCOL.md's design section describes: the bare task text to general-purpose, no routing packet?
      asPreRegistered: t.delegation && t.subagent?.promptBlockCounts && t.effective?.agentType
        ? t.effective.agentType === 'general-purpose' && t.subagent.promptBlockCounts.routing === 0 && t.subagent.promptBlockCounts.skills === 0 && t.delegation.promptVerbatim === true : null,
      routingBlocksInPrompt: t.subagent?.promptBlockCounts?.routing ?? null,
      apiTurns: t.subagent?.apiTurns ?? null,
      // The hook decision that reached the subagent (hookApplied); for an arm file without it, the scored call's event.
      sentInjected: t.hookApplied !== undefined ? (t.hookApplied?.injected ?? null) : (t.hook?.injected ?? null),
      appliedSource: t.hookApplied?.source ?? null,
      appliedAttemptIndex: t.hookApplied?.attemptIndex ?? null,
      appliedRouteDeferred: t.hookApplied?.routeDeferred ?? null,
      routeProfile: t.hook?.route?.profile ?? null,
      routeDeferred: t.hookDetail?.routeDeferred ?? null,
      need: t.hookDetail?.need ?? null,
      load: t.hookDetail?.load ?? null,
      suggest: t.hookDetail?.suggest ?? null,
      top: t.hookDetail?.top ?? null,
      targetJudged: t.targetJudged ?? null,
      judge: t.hookDetail?.judge ?? null,
      attemptsJudged: (t.attempts ?? []).map((attempt) => ({ outcome: attempt.outcome, need: attempt.hookDetail?.need ?? null, injected: attempt.injected ?? null, target: attempt.target ?? null,
        load: attempt.hookDetail?.load ?? null, suggest: attempt.hookDetail?.suggest ?? null, profile: attempt.hookDetail?.route?.profile ?? null })),
      blockInPrompt: t.subagent?.promptHadSkillsBlock ?? null,
      blockLoad: t.subagent?.promptBlockLoad ?? null,
      blockConsider: t.subagent?.promptBlockConsider ?? null,
      loadIndex: t.subagent?.targetLoadCallIndex ?? null,
      firstWriteIndex: t.subagent?.firstWriteCallIndex ?? null,
      firstBashWriteIndex: t.subagent?.firstBashWriteLikeCallIndex ?? null,
      beforeFirstWrite: t.subagent?.targetLoadedBeforeFirstWrite ?? null,
      beforeAnyWrite: t.subagent?.targetLoadedBeforeAnyWrite ?? null,
      listedCatalog: t.subagent?.skillListing?.catalogNamesListed ?? null,
      listedTotal: t.subagent?.listingDetail?.totalNamesListed ?? null,
      listedWithDescription: t.subagent?.listingDetail?.catalogNamesWithDescription ?? null,
      tokenParts: t.subagent?.tokens ? { input: t.subagent.tokens.input, output: t.subagent.tokens.output, cacheRead: t.subagent.tokens.cacheRead, cacheCreation: t.subagent.tokens.cacheCreation } : null,
      toolCallsWithoutHandback: t.subagent?.toolCallsWithoutHandback ?? null,
      skillSearch: t.subagent?.skillSearch ?? null,
    } : null);
    return { id: ta.id, kind: ta.kind, lang: ta.lang, targetSkill: ta.targetSkill, a: side(ta), b: side(tb) };
  });
  const skill = pairs.filter((pair) => pair.kind === 'skill');
  const both = skill.filter((pair) => typeof pair.a?.convention === 'boolean' && typeof pair.b?.convention === 'boolean');
  const paired = {
    pairsMeasured: both.length,
    bothPass: both.filter((pair) => pair.a.convention && pair.b.convention).length,
    onlyA: both.filter((pair) => pair.a.convention && !pair.b.convention).length,
    onlyB: both.filter((pair) => !pair.a.convention && pair.b.convention).length,
    neither: both.filter((pair) => !pair.a.convention && !pair.b.convention).length,
  };
  // Paired differences (b minus a) of the cost measures, only over pairs measured in both arms.
  const measures = { toolCalls: (x) => x?.toolCalls, apiTurns: (x) => x?.apiTurns, tokens: (x) => x?.tokens, outputTokens: (x) => x?.tokenParts?.output, inputTokens: (x) => x?.tokenParts?.input,
    cacheReadTokens: (x) => x?.tokenParts?.cacheRead, cacheCreationTokens: (x) => x?.tokenParts?.cacheCreation, wallMs: (x) => x?.wallMs };
  const differences = Object.fromEntries(Object.entries(measures).map(([name, pick]) => {
    // sameSetup: both subagents ran as the same agent type on the same model at the same effort (null when the agent type is unknown).
    const perTask = pairs.map((pair) => ({ id: pair.id, kind: pair.kind, a: pick(pair.a) ?? null, b: pick(pair.b) ?? null,
      sameSetup: pair.a?.agentType && pair.b?.agentType ? pair.a.agentType === pair.b.agentType && pair.a.model === pair.b.model && pair.a.effort === pair.b.effort : null }))
      .map((row) => ({ ...row, diff: typeof row.a === 'number' && typeof row.b === 'number' ? row.b - row.a : null }));
    const total = (rows) => {
      const measured = rows.filter((row) => row.diff !== null);
      return { pairsMeasured: measured.length, of: rows.length, a: measured.length ? measured.reduce((n, row) => n + row.a, 0) : null, b: measured.length ? measured.reduce((n, row) => n + row.b, 0) : null,
        diff: measured.length ? measured.reduce((n, row) => n + row.diff, 0) : null, bLower: measured.filter((row) => row.diff < 0).length, bHigher: measured.filter((row) => row.diff > 0).length };
    };
    return [name, { perTask, all: total(perTask), skillTasks: total(perTask.filter((row) => row.kind === 'skill')), controls: total(perTask.filter((row) => row.kind === 'control')),
      sameSetup: total(perTask.filter((row) => row.sameSetup === true)), sameSetupSkillTasks: total(perTask.filter((row) => row.sameSetup === true && row.kind === 'skill')) }];
  }));
  // Differences between the arms other than the skill block, per task: what the two subagents ran as.
  const setup = (x) => `${show(x?.agentType)} / ${show(x?.model)} / effort ${show(x?.effort)}${x?.appliedRouteDeferred ? ` (route deferred: ${x.appliedRouteDeferred})` : ''}`;
  const setupKnown = pairs.some((pair) => pair.a?.agentType || pair.b?.agentType);
  const armDifferences = setupKnown ? pairs.filter((pair) => pair.a && pair.b && (pair.a.agentType !== pair.b.agentType || pair.a.model !== pair.b.model || pair.a.effort !== pair.b.effort))
    .map((pair) => ({ id: pair.id, a: setup(pair.a), b: setup(pair.b) })) : null;
  return { arms: { a: a.arm, b: b.arm }, armDifferences, pairs, paired, differences, totals: { a: a.totals, b: b.totals }, judge: { a: a.judge ?? null, b: b.judge ?? null },
    mainSession: { a: a.mainSession ?? null, b: b.mainSession ?? null }, warnings: { a: a.warnings, b: b.warnings }, problems };
}

export function render(result) {
  const { arms, pairs, paired, totals } = result;
  const lead = [];
  if (Array.isArray(result.armDifferences)) {
    lead.push('Read first: differences between the arms other than the skill block (PROTOCOL.md rule 7 puts them before the results)');
    if (result.armDifferences.length === 0) lead.push('  none found in agent type, model or effort of the subagents');
    for (const entry of result.armDifferences) lead.push(`  ${entry.id}: ${arms.a} ran as ${entry.a}; ${arms.b} ran as ${entry.b}. Not a like-for-like pair: read no secondary measure of this pair as an effect of the block.`);
    const asDesigned = (side) => {
      const known = pairs.filter((pair) => typeof pair[side]?.asPreRegistered === 'boolean');
      const yes = known.filter((pair) => pair[side].asPreRegistered);
      return `${arms[side]} ${yes.length}/${known.length}${yes.length ? ` (${yes.map((pair) => pair.id).join(', ')})` : ''}`;
    };
    const routed = (side) => pairs.filter((pair) => (pair[side]?.routingBlocksInPrompt ?? 0) > 0).length;
    lead.push(`Delegation as pre-registered (the bare task text to general-purpose, nothing added): ${asDesigned('a')}, ${asDesigned('b')} of the task runs read.`,
      `A routing packet was in the subagent prompt in ${routed('a')} (${arms.a}) and ${routed('b')} (${arms.b}) task runs, so where a block was sent the pair compares "routing packet" with "routing packet plus block".`);
    lead.push('Only the conv / done columns and the PRIMARY line are the pre-registered outcome (read from the project folder). Every other figure is a secondary',
      'or reference measure, read under the attribution rule that was fixed after the sessions (PROTOCOL.md, last section): the first Agent call that',
      'was not refused before running. Under the rule as first written these figures are unmeasured wherever the first call was refused.', '');
  }
  const header = ['task', 'kind', 'lang', 'target skill', `conv ${arms.a}`, `conv ${arms.b}`, `done ${arms.a}`, `done ${arms.b}`,
    `listed ${arms.a}`, `listed ${arms.b}`, `loaded ${arms.a}`, `loaded ${arms.b}`, `block sent ${arms.a}`, `block sent ${arms.b}`, `tools ${arms.a}`, `tools ${arms.b}`,
    `tokens ${arms.a}`, `tokens ${arms.b}`, `wall s ${arms.a}`, `wall s ${arms.b}`];
  const rows = pairs.map((pair) => [pair.id, pair.kind, pair.lang, pair.targetSkill ?? '-',
    show(pair.a?.convention), show(pair.b?.convention), show(pair.a?.done), show(pair.b?.done),
    show(pair.a?.targetListedToSubagent), show(pair.b?.targetListedToSubagent),
    show(pair.a?.targetSkillLoaded), show(pair.b?.targetSkillLoaded), show(pair.a?.sentInjected), show(pair.b?.sentInjected),
    show(pair.a?.toolCalls), show(pair.b?.toolCalls), show(pair.a?.tokens), show(pair.b?.tokens),
    show(seconds(pair.a?.wallMs)), show(seconds(pair.b?.wallMs))]);
  const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  const out = [...lead, line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line),
    '"block sent" = the hook decision that reached the subagent said it injected a <jev-skills> block ("-" = no skills event: the point was off).', ''];
  const both = (label, pick, format) => out.push(`${label.padEnd(44)} ${arms.a}: ${format(pick(totals.a))}   ${arms.b}: ${format(pick(totals.b))}`);
  out.push('Totals ("-" or "measured n" means a value could not be read; it is not counted as a failure or a zero)');
  both('PRIMARY convention passed, skill tasks', (t) => t?.primary_conventionPassed, ratio);
  both('skill tasks done', (t) => t?.skillTasksDone, ratio);
  both('controls done', (t) => t?.controlsDone, ratio);
  both('skill tasks delegated by Main', (t) => t?.skillTasksDelegated, (c) => (c ? `${c.yes}/${c.of}` : '-'));
  both('target skill listed to the subagent', (t) => t?.targetListedToSubagent, ratio);
  both('target skill loaded by the subagent', (t) => t?.targetSkillLoaded, ratio);
  both('  of which via Skill / Read / Bash', (t) => t?.targetSkillLoadedVia, (v) => (v ? `${v.Skill} / ${v.Read} / ${v.Bash}` : '-'));
  both('target among the injected "load" skills', (t) => t?.targetInInjectedLoad, ratio);
  both('hook injected a block, skill tasks', (t) => t?.injectedOnSkillTasks, ratio);
  both('hook injected a block, controls (false inj.)', (t) => t?.injectedOnControls, ratio);
  if (totals.a?.appliedInjectedOnSkillTasks || totals.b?.appliedInjectedOnSkillTasks) {
    out.push('  The three lines above are read from the scored call\'s own skills event, as PROTOCOL.md defines. Where the scored call followed a refused');
    out.push('  attempt, that event is a second hook run whose rewrite was not applied. The same counts for the decision that reached the subagent:');
    both('  target among "load", decision sent', (t) => t?.targetInAppliedLoad, ratio);
    both('  block injected, skill tasks, decision sent', (t) => t?.appliedInjectedOnSkillTasks, ratio);
    both('  block injected, controls, decision sent', (t) => t?.appliedInjectedOnControls, ratio);
  }
  both('subagent API turns, all tasks', (t) => t?.subagentApiTurns, sum);
  both('subagent tool calls, all tasks', (t) => t?.subagentToolCalls, sum);
  both('subagent tokens, all tasks', (t) => t?.subagentTokens, sum);
  both('subagent wall time ms, all tasks', (t) => t?.subagentWallMs, sum);
  out.push('', `Paired convention outcome over ${paired.pairsMeasured} measured pair(s): both pass ${paired.bothPass}, only ${arms.a} ${paired.onlyA}, only ${arms.b} ${paired.onlyB}, neither ${paired.neither}`);
  const table = (head, body) => {
    const w = head.map((cell, i) => Math.max(cell.length, ...body.map((row) => row[i].length)));
    const fmt = (cells) => cells.map((cell, i) => cell.padEnd(w[i])).join('  ').trimEnd();
    return [fmt(head), fmt(w.map((n) => '-'.repeat(n))), ...body.map(fmt)];
  };
  const prob = (list) => (Array.isArray(list) ? (list.length ? list.map((entry) => `${entry.name} ${show(entry.probability)}`).join(', ') : '(none)') : '-');
  const signed = (n) => (typeof n === 'number' ? (n > 0 ? `+${n}` : String(n)) : '-');
  if (pairs.some((pair) => pair.a?.refusedAttempts !== null || pair.b?.refusedAttempts !== null)) {
    out.push('', 'Delegation as it ran (Agent calls = refused before running + launched; profile / model / effort are what the harness recorded for the subagent)');
    out.push(...table(['task', `calls ${arms.a}`, `calls ${arms.b}`, `ran as ${arms.a}`, `ran as ${arms.b}`, `block in prompt ${arms.a}`, `block in prompt ${arms.b}`],
      pairs.map((pair) => [pair.id, ...['a', 'b'].map((side) => (pair[side]?.delegated ? `${show(pair[side].refusedAttempts)} + ${show(pair[side].launchedCalls)}` : 'none')),
        ...['a', 'b'].map((side) => `${show(pair[side]?.agentType)} / ${show(pair[side]?.model)} / ${show(pair[side]?.effort)}`), show(pair.a?.blockInPrompt), show(pair.b?.blockInPrompt)])));
    out.push('', 'Target skill: listing, load route and order (index = position among the subagent\'s tool calls, 0 is the first; "bash write" is a heuristic)');
    out.push(...table(['task', 'arm', 'listed (catalog/all)', 'loaded via', 'load index', 'first Write/Edit', 'first bash write', 'before Write/Edit', 'before any write', 'other project skills loaded'],
      pairs.filter((pair) => pair.kind === 'skill').flatMap((pair) => ['a', 'b'].map((side) => {
        const x = pair[side];
        return [pair.id, arms[side], x?.listedCatalog === null || x?.listedCatalog === undefined ? '-' : `${show(x.targetListedToSubagent)} (${x.listedCatalog}/${show(x.listedTotal)})`,
          show(x?.targetSkillLoadedVia), show(x?.loadIndex), show(x?.firstWriteIndex), show(x?.firstBashWriteIndex), show(x?.beforeFirstWrite), show(x?.beforeAnyWrite),
          x?.loadedSkills ? (x.loadedSkills.filter((name) => name !== pair.targetSkill).join(', ') || '(none)') : '-'];
      }))));
    out.push('', `Skill judge per Agent call, ${arms.b} and ${arms.a} (each task: refused attempt first, then the launched call; "target" is the judge's probability for the target skill and the stage it ended in; "sent" = this is the decision whose rewrite reached the subagent)`);
    out.push(...table(['task', 'arm', 'call', 'need', 'injected', 'target', 'load', 'suggest', 'route profile', 'sent'],
      pairs.flatMap((pair) => ['a', 'b'].flatMap((side) => (pair[side]?.attemptsJudged ?? []).map((attempt, index) => ({ attempt, index })).filter(({ attempt }) => attempt.need !== null || attempt.injected !== null || side === 'b').map(({ attempt, index }) => [pair.id, arms[side], attempt.outcome,
        show(attempt.need), show(attempt.injected), attempt.target ? `${show(attempt.target.probability)} ${show(attempt.target.stage)}` : '-', prob(attempt.load), prob(attempt.suggest), show(attempt.profile),
        pair[side].appliedAttemptIndex === null ? '-' : show(pair[side].appliedAttemptIndex === index)])))));
    const d = result.differences;
    out.push('', `Subagent cost, paired (${arms.b} minus ${arms.a}); tokens = input + output + cache read + cache creation, each message id once`);
    out.push(...table(['task', `tools ${arms.a}`, `tools ${arms.b}`, 'diff', `turns ${arms.a}`, `turns ${arms.b}`, 'diff', `tokens ${arms.a}`, `tokens ${arms.b}`, 'diff', `output ${arms.a}`, `output ${arms.b}`, 'diff', `wall s ${arms.a}`, `wall s ${arms.b}`, 'diff s'],
      [...d.toolCalls.perTask.map((row, i) => [row.id, show(row.a), show(row.b), signed(row.diff), show(d.apiTurns.perTask[i].a), show(d.apiTurns.perTask[i].b), signed(d.apiTurns.perTask[i].diff), show(d.tokens.perTask[i].a), show(d.tokens.perTask[i].b), signed(d.tokens.perTask[i].diff),
        show(d.outputTokens.perTask[i].a), show(d.outputTokens.perTask[i].b), signed(d.outputTokens.perTask[i].diff),
        show(seconds(d.wallMs.perTask[i].a)), show(seconds(d.wallMs.perTask[i].b)), d.wallMs.perTask[i].diff === null ? '-' : signed(Number((d.wallMs.perTask[i].diff / 1000).toFixed(1)))]),
      ...['all', 'skillTasks', 'controls', 'sameSetup', 'sameSetupSkillTasks'].map((group) => [`sum ${group} (${d.toolCalls[group].pairsMeasured}/${d.toolCalls[group].of})`, show(d.toolCalls[group].a), show(d.toolCalls[group].b), signed(d.toolCalls[group].diff),
        show(d.apiTurns[group].a), show(d.apiTurns[group].b), signed(d.apiTurns[group].diff),
        show(d.tokens[group].a), show(d.tokens[group].b), signed(d.tokens[group].diff), show(d.outputTokens[group].a), show(d.outputTokens[group].b), signed(d.outputTokens[group].diff),
        show(seconds(d.wallMs[group].a)), show(seconds(d.wallMs[group].b)), d.wallMs[group].diff === null ? '-' : signed(Number((d.wallMs[group].diff / 1000).toFixed(1)))])]));
    const unlike = d.toolCalls.perTask.filter((row) => row.sameSetup === false).map((row) => row.id);
    out.push(`"sameSetup" rows count only pairs whose two subagents ran as the same agent type on the same model at the same effort${unlike.length ? `; left out: ${unlike.join(', ')}` : ''}. "turns" = API turns (distinct assistant message ids).`);
    out.push(`Token parts, all tasks: input ${arms.a} ${show(d.inputTokens.all.a)} / ${arms.b} ${show(d.inputTokens.all.b)}; output ${show(d.outputTokens.all.a)} / ${show(d.outputTokens.all.b)}; cache read ${show(d.cacheReadTokens.all.a)} / ${show(d.cacheReadTokens.all.b)}; cache creation ${show(d.cacheCreationTokens.all.a)} / ${show(d.cacheCreationTokens.all.b)}`);
    const share = (side) => (typeof d.cacheReadTokens.all[side] === 'number' && d.tokens.all[side] ? `${(100 * d.cacheReadTokens.all[side] / d.tokens.all[side]).toFixed(1)}%` : '-');
    out.push(`Cache reads are ${share('a')} (${arms.a}) and ${share('b')} (${arms.b}) of the token total, so the total follows the number of API turns; it is not billed cost.`);
    // Pairs that got the same prompt and the same setup in both arms and no block in either: their difference is run-to-run variation.
    const floor = pairs.map((pair, i) => ({ pair, row: d.tokens.perTask[i] })).filter(({ pair, row }) => row.sameSetup === true && row.diff !== null && pair.a?.blockInPrompt === false && pair.b?.blockInPrompt === false);
    const pct = (row) => (row.a ? ` (${row.diff >= 0 ? '+' : ''}${(100 * row.diff / row.a).toFixed(1)}%)` : '');
    out.push(floor.length
      ? `Pairs with no block in either arm and the same setup (nothing differed but the run): token diff ${floor.map(({ pair, row }) => `${pair.id} ${signed(row.diff)}${pct(row)}`).join(', ')}.`
      : 'No pair had the same setup and no block in both arms, so there is no within-run reference for run-to-run variation.');
    out.push('The cost figures are descriptive. One run per arm: a difference no larger than the ones on the line above cannot be told apart from run-to-run variation, and no direction is attributed to the block.');
    const judgeLine = (side) => {
      const j = result.judge?.[side];
      if (!j) return `${arms[side]}: -`;
      const points = Object.entries(j.byPoint ?? {}).map(([point, entry]) => `${point} ${entry.decisions} decisions, latency sum ${show(entry.latencyMsSum)} ms, max ${show(entry.latencyMsMax)} ms`).join('; ') || 'no decision log';
      return `${arms[side]}: ${points}. PreToolUse hook time over ${show(j.hookMsPerAgentCall?.measured)}/${show(j.hookMsPerAgentCall?.of)} Agent calls: ${show(j.hookMsPerAgentCall?.sum)} ms. Judge tokens: ${show(j.tokens)} (not recorded).`;
    };
    out.push('', 'Judge cost from the decision log (one decision = one judge request)', `  ${judgeLine('a')}`, `  ${judgeLine('b')}`);
    const searchLine = (side) => {
      const sk = totals[side]?.skillSearch;
      return sk ? `${arms[side]}: MCP skill tool in ${sk.tasksUsingMcpSkillTool.length} task(s)${sk.tasksUsingMcpSkillTool.length ? ` [${sk.tasksUsingMcpSkillTool.join(', ')}]` : ''}, ToolSearch about skills in ${sk.tasksUsingToolSearchForSkill.length}, Skill call outside the project catalog in ${sk.tasksCallingNonCatalogSkill.length} (of ${sk.tasksMeasured} subagents read)` : `${arms[side]}: -`;
    };
    out.push('', 'User-level skill search by subagents', `  ${searchLine('a')}`, `  ${searchLine('b')}`);
    const mainLine = (side) => {
      const m = result.mainSession?.[side];
      return m ? `${arms[side]}: ${m.userPrompts} user prompt(s); equals main-prompt.txt ${show(m.firstPromptEqualsMainPromptFile)}, contains it ${show(m.firstPromptContainsMainPromptFile)} (+${show(m.firstPromptExtraChars)} chars); model ${m.models.join(',') || '-'}, effort ${m.efforts.join(',') || '-'}, permission mode ${m.permissionModes.join(',') || '-'}; tools ${Object.entries(m.toolNames).map(([name, n]) => `${name} x${n}`).join(', ') || '-'}; tokens ${show(m.tokens?.total)}; wall ${show(seconds(m.wallMs))} s over user / assistant / attachment rows${m.wallMsAllRows !== undefined ? ` (${show(seconds(m.wallMsAllRows))} s over every stamped row)` : ''}` : `${arms[side]}: -`;
    };
    out.push('', 'Main session', `  ${mainLine('a')}`, `  ${mainLine('b')}`);
  }
  const scoped = pairs.flatMap((pair) => ['a', 'b'].filter((side) => pair[side]?.outOfScopeWrites?.length).map((side) => `${pair.id} ${arms[side]}: ${pair[side].outOfScopeWrites.join(', ')}`));
  if (scoped.length) out.push('', 'Writes outside the task\'s own paths:', ...scoped.map((entry) => `  ${entry}`));
  const blocked = pairs.flatMap((pair) => ['a', 'b'].filter((side) => pair[side]?.blockedBy?.length).map((side) => `${pair.id} ${arms[side]}: ${pair[side].blockedBy.join(', ')}`));
  if (blocked.length) out.push('', 'Blocked by another task\'s file (the pair is contaminated; read its result with that in mind):', ...blocked.map((entry) => `  ${entry}`));
  const retried = pairs.flatMap((pair) => ['a', 'b'].filter((side) => pair[side] && (!pair[side].delegated || pair[side].agentCalls > 1)).map((side) => `${pair.id} ${arms[side]}: ${pair[side].delegated
    ? `${pair[side].agentCalls} Agent calls${pair[side].refusedAttempts !== null ? ` (${pair[side].refusedAttempts} refused before running, ${pair[side].launchedCalls} launched${pair[side].scoredPromptIsHookRewrite === null ? '' : `; launched input is exactly the hook's rewrite: ${show(pair[side].scoredPromptIsHookRewrite)}`})` : ''}` : 'not delegated'}`));
  if (retried.length) out.push('', 'Delegation deviations (not delegated counts as measured done=false; a call refused before the tool ran is not scored, otherwise the first call is):', ...retried.map((entry) => `  ${entry}`));
  const noted = pairs.flatMap((pair) => ['a', 'b'].filter((side) => pair[side]?.warnings).map((side) => `${pair.id} ${arms[side]}: ${pair[side].warnings}`));
  out.push('', `Warnings: ${arms.a} ${result.warnings.a?.length ?? 0} run-level, ${arms.b} ${result.warnings.b?.length ?? 0} run-level${noted.length ? `; per task: ${noted.join('; ')}` : ''}. Read them in the arm files.`);
  for (const problem of result.problems) out.push(`PROBLEM: ${problem}`);
  out.push('Descriptive only: one run per arm and six pairs. No significance claim; see PROTOCOL.md.');
  return out.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  if (!value('--a') || !value('--b')) {
    console.error('usage: compare.mjs --a <armA.json> --b <armB.json> [--json]');
    process.exit(64);
  }
  try {
    const result = compare(JSON.parse(readFileSync(value('--a'), 'utf8')), JSON.parse(readFileSync(value('--b'), 'utf8')));
    process.stdout.write(argv.includes('--json') ? JSON.stringify(result, null, 2) + '\n' : render(result));
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
