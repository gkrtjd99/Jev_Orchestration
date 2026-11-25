// Append-only store of delegation observations written by the outcome collector (src/collector.mjs).
// One record says what was requested for a delegation and what the host recorded as having run.
// Like the decision log, the strict validator is what keeps text out: a record holds hashes, numbers,
// booleans, enums and validated identifiers only. No prompt, no report, no path, no session or agent id.
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import { assert, object, hash } from '../util.mjs';

export const OBSERVATION_SCHEMA = 1;
export const MAX_OBSERVATION_LINE_BYTES = 32768;
const MAX_FILE_BYTES = 33554432;
const MAX_DIR_FILES = 240;
const MAX_LIST = 128;
const FILE_NAME = /^observations-\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/;
const APPEND_FLAGS = FS.O_WRONLY | FS.O_APPEND | FS.O_CREAT | FS.O_NOFOLLOW;

const HEX64 = /^[0-9a-f]{64}$/;
// Identifiers: profile ids, model ids, task classes, versions, validator names. No whitespace, so no sentence fits.
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/|+\[\]-]{0,159}$/;
export const SKILL_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

const hex = x => typeof x === 'string' && HEX64.test(x);
const id = x => typeof x === 'string' && IDENTIFIER.test(x);
const nullable = check => x => x === null || check(x);
const bool = x => typeof x === 'boolean';
const count = x => Number.isSafeInteger(x) && x >= 0;
const amount = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const unit = x => amount(x) && x <= 1;
const oneOf = (...values) => x => values.includes(x);
const skillList = x => Array.isArray(x) && x.length <= MAX_LIST && x.every(n => typeof n === 'string' && SKILL_ID.test(n));

// Every key is required and no other key is allowed. `null` always means "not measured", never zero.
function shape(value, spec) {
  if (!object(value)) return false;
  const keys = Object.keys(spec);
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k) && spec[k](value[k]));
}

const HOST = { version: nullable(id), entrypoint: nullable(id), permissionMode: nullable(id) };
const CALLS = { total: count, refused: count, reissued: bool, repeated: bool, reroutedAfterRefusal: bool };
const REQUESTED = {
  profile: nullable(id), model: nullable(id), backend: nullable(id), effort: nullable(id), role: nullable(id), tier: nullable(id),
  taskClass: nullable(id), routeSource: nullable(oneOf('own', 'reissue', 'repeat', 'refused-call')),
};
const EFFECTIVE = {
  agentType: nullable(id), model: nullable(id), effort: nullable(id), source: nullable(oneOf('native-transcript')),
  // modelMatch: exact | declared | declared-not-in-force | alias-undeclared | mismatch (src/collector.mjs).
  // 'declared' is only written for a route recorded with the profile definition that holds the declaration;
  // 'declared-not-in-force' is an id declared now but not when the session ran. 'alias' is what records
  // written before the registry could declare resolved ids call 'alias-undeclared'; it is still read.
  profileMatch: nullable(bool), modelMatch: nullable(oneOf('exact', 'declared', 'declared-not-in-force', 'alias-undeclared', 'alias', 'mismatch')), effortMatch: nullable(bool),
};
const LOADED = { name: x => typeof x === 'string' && SKILL_ID.test(x), via: oneOf('Skill', 'Read', 'Shell'), beforeFirstWrite: nullable(bool) };
const SKILLS = {
  mode: nullable(oneOf('shadow', 'active')), status: nullable(id), need: nullable(unit), injectedByHook: nullable(bool),
  blockInPrompt: nullable(bool), blockLoad: nullable(skillList), blockConsider: nullable(skillList),
  loaded: x => Array.isArray(x) && x.length <= MAX_LIST && x.every(e => shape(e, LOADED)),
  otherSkillCalls: nullable(count), indeterminateAccess: nullable(bool),
};
const TOKENS = { input: nullable(count), output: nullable(count), cacheRead: nullable(count), cacheCreation: nullable(count) };
const USAGE = { apiTurns: nullable(count), toolCalls: nullable(count), tokens: x => shape(x, TOKENS), wallMs: nullable(amount), endToEndMs: nullable(amount) };
const JUDGE = {
  routerRequests: nullable(count), skillsRequests: nullable(count), supervisorRequests: nullable(count), routerMs: nullable(amount),
  tokensReported: count, inputTokens: nullable(count), outputTokens: nullable(count),
};
const SUPERVISOR = {
  status: id, outcome: nullable(oneOf('complete', 'retry', 'replan', 'escalate')), confidence: nullable(unit), evidence: nullable(amount),
  advisory: nullable(bool), source: oneOf('inline', 'handback'),
};
const VERIFICATION = { passed: bool, conventionPassed: nullable(bool), validator: id, artifactSha256: hex };
const DECISION = { point: id, decisionId: hex, role: oneOf('governing', 'not-applied') };
const RECORD = {
  schema: x => x === OBSERVATION_SCHEMA, time: amount, observationId: hex, delegationId: hex, sessionScope: hex, taskHash: nullable(hex),
  runtime: oneOf('claude'), routed: bool,
  host: x => shape(x, HOST), calls: x => shape(x, CALLS), requested: x => shape(x, REQUESTED), effective: x => shape(x, EFFECTIVE),
  skills: x => shape(x, SKILLS), usage: x => shape(x, USAGE), judge: x => shape(x, JUDGE),
  supervisor: nullable(x => shape(x, SUPERVISOR)), verification: nullable(x => shape(x, VERIFICATION)),
  decisions: x => Array.isArray(x) && x.length <= MAX_LIST && x.every(d => shape(d, DECISION)),
};

export function isObservationRecord(r) {
  return shape(r, RECORD);
}

/** Content identity of an observation: everything except when it was written. Two runs over the same session give the same id. */
export function observationId(record) {
  const { time, observationId: _ignored, ...content } = record;
  return hash(content);
}

export function observationLogDir(config) {
  return path.join(config.stateDir, 'observations-log');
}

async function lstatOrNull(file) {
  try { return await fs.lstat(file); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export class ObservationLog {
  constructor(dir, { now = Date.now } = {}) {
    assert(typeof dir === 'string' && path.isAbsolute(dir), 'ABSOLUTE_OBSERVATION_LOG_REQUIRED');
    this.dir = dir;
    this.now = now;
  }

  /** Appends one record. The caller supplies everything but `time` and `observationId`. */
  async append(content) {
    const record = { ...content, time: this.now() };
    record.observationId = observationId(record);
    assert(isObservationRecord(record), 'INVALID_OBSERVATION_RECORD');
    const line = JSON.stringify(record) + '\n';
    const bytes = Buffer.byteLength(line);
    assert(bytes <= MAX_OBSERVATION_LINE_BYTES, 'OBSERVATION_RECORD_TOO_LARGE');
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const dirStat = await fs.lstat(this.dir);
    assert(!dirStat.isSymbolicLink(), 'SYMLINK_DESTINATION');
    assert(dirStat.isDirectory(), 'OBSERVATION_LOG_NOT_DIRECTORY');
    const month = new Date(this.now()).toISOString().slice(0, 7);
    const file = path.join(this.dir, `observations-${month}.jsonl`);
    const stat = await lstatOrNull(file);
    if (stat) {
      assert(!stat.isSymbolicLink(), 'SYMLINK_DESTINATION');
      assert(stat.isFile(), 'OBSERVATION_LOG_NOT_FILE');
      assert(stat.size + bytes <= MAX_FILE_BYTES, 'OBSERVATION_LOG_FULL');
    }
    try { await fs.appendFile(file, line, { mode: 0o600, flag: APPEND_FLAGS }); }
    catch (e) { assert(e.code !== 'ELOOP', 'SYMLINK_DESTINATION'); throw e; }
    return record;
  }

  /** Every valid record in append order, plus the number of lines that failed the validator. */
  async read() {
    const out = { observations: [], corruptLines: 0 };
    const dirStat = await lstatOrNull(this.dir);
    if (!dirStat) return out;
    assert(!dirStat.isSymbolicLink(), 'SYMLINK_DESTINATION');
    assert(dirStat.isDirectory(), 'OBSERVATION_LOG_NOT_DIRECTORY');
    const names = await fs.readdir(this.dir);
    assert(names.length <= MAX_DIR_FILES, 'OBSERVATION_LOG_LIMIT');
    for (const name of names.filter(n => FILE_NAME.test(n)).sort()) {
      const file = path.join(this.dir, name);
      const stat = await fs.lstat(file);
      assert(!stat.isSymbolicLink(), 'SYMLINK_DESTINATION');
      assert(stat.isFile() && stat.size <= MAX_FILE_BYTES, 'OBSERVATION_LOG_LIMIT');
      for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        let row = null;
        try { row = JSON.parse(line); } catch { /* counted below */ }
        if (isObservationRecord(row)) out.observations.push(row); else out.corruptLines++;
      }
    }
    return out;
  }
}

/**
 * The standing record of each delegation, in first-seen order: the most recently written one, except that a
 * record without a verification result never replaces one that has it (a later run without the verification
 * file must not erase a verified result; a later run WITH a result, pass or fail, does replace it).
 */
export function latestObservations(observations) {
  const latest = new Map();
  for (const o of observations) {
    const prior = latest.get(o.delegationId);
    if (prior && prior.verification !== null && o.verification === null) continue;
    latest.set(o.delegationId, o);
  }
  return [...latest.values()];
}

const ratio = (n, d) => (d > 0 ? n / d : null);
// Mean over the records that have a number; null when none has one. `measured` says how many did.
function meanOf(values) {
  const known = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  return { mean: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null, measured: known.length };
}
const sumOrNull = values => {
  const known = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};
const tokenTotal = t => sumOrNull([t.input, t.output, t.cacheRead, t.cacheCreation]);

/**
 * Descriptive summary of observation records (the latest record per delegation). Nothing here is a verdict
 * and nothing is fed back into routing. A rate whose denominator is zero and a mean with no measured value
 * are null, never 0.
 */
export function observationReport(observations) {
  const rows = latestObservations(observations);
  const compared = (key, hit) => {
    const known = rows.filter(r => r.effective[key] !== null);
    const matched = known.filter(r => hit(r.effective[key])).length;
    return { compared: known.length, matched, rate: ratio(matched, known.length) };
  };
  const model = rows.filter(r => r.effective.modelMatch !== null);
  const byKind = kind => model.filter(r => r.effective.modelMatch === kind).length;
  const profiles = new Map();
  for (const r of rows) {
    const key = r.requested.profile ?? '(not-routed)';
    if (!profiles.has(key)) profiles.set(key, []);
    profiles.get(key).push(r);
  }
  const describe = members => {
    const verified = members.filter(r => r.verification !== null);
    const convention = verified.filter(r => r.verification.conventionPassed !== null);
    return {
      delegations: members.length,
      verified: verified.length,
      passed: verified.length ? verified.filter(r => r.verification.passed).length : null,
      passRate: ratio(verified.filter(r => r.verification.passed).length, verified.length),
      conventionChecked: convention.length,
      conventionPassRate: ratio(convention.filter(r => r.verification.conventionPassed).length, convention.length),
      perDelegation: {
        tokens: {
          input: meanOf(members.map(r => r.usage.tokens.input)), output: meanOf(members.map(r => r.usage.tokens.output)),
          cacheRead: meanOf(members.map(r => r.usage.tokens.cacheRead)), cacheCreation: meanOf(members.map(r => r.usage.tokens.cacheCreation)),
          total: meanOf(members.map(r => tokenTotal(r.usage.tokens))),
        },
        apiTurns: meanOf(members.map(r => r.usage.apiTurns)), toolCalls: meanOf(members.map(r => r.usage.toolCalls)),
        wallMs: meanOf(members.map(r => r.usage.wallMs)), endToEndMs: meanOf(members.map(r => r.usage.endToEndMs)),
      },
    };
  };
  const judgeRequests = rows.map(r => sumOrNull([r.judge.routerRequests, r.judge.skillsRequests, r.judge.supervisorRequests]));
  const judgeTokens = sumOrNull(rows.flatMap(r => [r.judge.inputTokens, r.judge.outputTokens]));
  const workerTokens = sumOrNull(rows.map(r => tokenTotal(r.usage.tokens)));
  const timed = rows.filter(r => r.judge.routerMs !== null && r.usage.endToEndMs !== null && r.usage.endToEndMs > 0);
  const tab = { blockPresent: { loadedAny: 0, loadedNone: 0 }, blockAbsent: { loadedAny: 0, loadedNone: 0 }, blockUnknown: 0, loadUnknown: 0 };
  let blockLoadFollowed = 0, blockWithLoad = 0;
  for (const r of rows) {
    if (r.skills.blockInPrompt === null) { tab.blockUnknown++; continue; }
    if (r.skills.indeterminateAccess !== false) { tab.loadUnknown++; continue; }
    tab[r.skills.blockInPrompt ? 'blockPresent' : 'blockAbsent'][r.skills.loaded.length ? 'loadedAny' : 'loadedNone']++;
    if (r.skills.blockInPrompt && Array.isArray(r.skills.blockLoad) && r.skills.blockLoad.length) {
      blockWithLoad++;
      if (r.skills.blockLoad.every(name => r.skills.loaded.some(l => l.name === name))) blockLoadFollowed++;
    }
  }
  return {
    schema: 1,
    note: 'Descriptive only. A loaded skill is what a subagent did, not proof the skill was needed; a pass rate exists only where an '
      + 'external verification result was supplied; nothing in this report changes routing.',
    delegations: rows.length,
    routed: rows.filter(r => r.routed).length,
    requestedVsEffective: {
      profile: compared('profileMatch', x => x === true),
      // exact + declared are the two kinds the evidence importer accepts. `alias` counts the undeclared alias
      // matches under both their names ('alias-undeclared', and 'alias' in records from before that name).
      // acceptedRate is a comparison of model ids under the declaration in force for each route, not a count of
      // importable rows: a row also needs a verification result, a named context and everything else.
      model: { compared: model.length, exact: byKind('exact'), declared: byKind('declared'), declaredNotInForce: byKind('declared-not-in-force'), aliasUndeclared: byKind('alias-undeclared') + byKind('alias'),
        alias: byKind('alias-undeclared') + byKind('alias'), mismatch: byKind('mismatch'),
        exactRate: ratio(byKind('exact'), model.length), acceptedRate: ratio(byKind('exact') + byKind('declared'), model.length),
        exactOrAliasRate: ratio(model.length - byKind('mismatch'), model.length) },
      effort: compared('effortMatch', x => x === true),
    },
    byProfile: [...profiles.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([profile, members]) => ({ profile, ...describe(members) })),
    all: describe(rows),
    judge: {
      requests: { total: sumOrNull(judgeRequests), perDelegation: meanOf(judgeRequests) },
      // Token share needs judge usage in the decision log; a log without usage fields gives null here, not 0.
      tokens: { reportedDecisions: rows.reduce((n, r) => n + r.judge.tokensReported, 0), judge: judgeTokens, workers: workerTokens,
        judgeShare: judgeTokens !== null && workerTokens !== null ? ratio(judgeTokens, judgeTokens + workerTokens) : null },
      // Routing hook time (classification, profile selection and skill judging run inside it) against the
      // delegation's end-to-end time, over the delegations where both were measured.
      time: { measured: timed.length, routerMs: sumOrNull(timed.map(r => r.judge.routerMs)), endToEndMs: sumOrNull(timed.map(r => r.usage.endToEndMs)),
        routerShare: timed.length ? ratio(timed.reduce((n, r) => n + r.judge.routerMs, 0), timed.reduce((n, r) => n + r.usage.endToEndMs, 0)) : null },
    },
    skills: { crossTab: tab, blocksNamingALoadSkill: blockWithLoad, blocksWhoseLoadSkillsWereAllLoaded: blockLoadFollowed },
  };
}
