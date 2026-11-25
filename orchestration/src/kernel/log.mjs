// Append-only decision log. Records carry hashes, numbers and short identifiers only:
// the strict validator below is what keeps raw prompt/state text out of the files.
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import { assert, object } from '../util.mjs';

export const MAX_LINE_BYTES = 16384;
export const MAX_FILE_BYTES = 33554432;
export const MAX_DIR_FILES = 240;
export const MAX_STRING = 512;
const MAX_SHORT = 128;
const MAX_ANSWERS = 64;
const MAX_OPTIONS = 64;
const MAX_TRAIL = 16;

const HEX64 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^(decisions|labels)-\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/;
const DECISION_KEYS = ['schema', 'decisionId', 'time', 'pointId', 'mode', 'provider', 'model', 'cached', 'latencyMs',
  'confidence', 'scope', 'subject', 'questionsHash', 'stateHash', 'answers', 'trail'];
const LABEL_KEYS = ['schema', 'time', 'decisionId', 'questionId', 'outcome', 'source'];
const TRAIL_KEYS = ['provider', 'ok', 'code', 'confidence', 'latencyMs'];
const ANSWER_KEYS = {
  noul: ['type', 'p'],
  choice: ['type', 'choice', 'p', 'confidence'],
  score: ['type', 'score', 'p', 'confidence'],
};
// O_NOFOLLOW makes the append itself refuse a symlink swapped in after the lstat check.
const APPEND_FLAGS = FS.O_WRONLY | FS.O_APPEND | FS.O_CREAT | FS.O_NOFOLLOW;

const text = (x, max = MAX_STRING) => typeof x === 'string' && x.length > 0 && x.length <= max;
const finite = x => typeof x === 'number' && Number.isFinite(x);
const unit = x => finite(x) && x >= 0 && x <= 1;
const nonNegative = x => finite(x) && x >= 0;
const onlyKeys = (value, allowed) => Object.keys(value).every(k => allowed.includes(k));

function probabilityMap(p, keyPattern = null) {
  if (!object(p)) return false;
  const entries = Object.entries(p);
  return entries.length <= MAX_OPTIONS
    && entries.every(([k, v]) => text(k) && (!keyPattern || keyPattern.test(k)) && unit(v));
}

function validAnswer(a) {
  if (!object(a) || !Object.hasOwn(ANSWER_KEYS, a.type) || !onlyKeys(a, ANSWER_KEYS[a.type])) return false;
  if (a.type === 'noul') return unit(a.p);
  if (!unit(a.confidence)) return false;
  if (a.type === 'choice') return text(a.choice) && probabilityMap(a.p);
  return nonNegative(a.score) && probabilityMap(a.p, /^\d{1,2}$/);
}

function validTrailEntry(t) {
  return object(t) && onlyKeys(t, TRAIL_KEYS) && text(t.provider) && typeof t.ok === 'boolean' && nonNegative(t.latencyMs)
    && (t.code === undefined || text(t.code, MAX_SHORT))
    && (t.confidence === undefined || t.confidence === null || unit(t.confidence));
}

/** Strict shared-contract check: every key required, none unknown, no string over 512 chars. */
export function isDecisionRecord(r) {
  if (!object(r)) return false;
  if (Object.keys(r).length !== DECISION_KEYS.length || !DECISION_KEYS.every(k => Object.hasOwn(r, k))) return false;
  if (r.schema !== 1 || typeof r.decisionId !== 'string' || !HEX64.test(r.decisionId)) return false;
  if (!nonNegative(r.time) || !nonNegative(r.latencyMs) || typeof r.cached !== 'boolean') return false;
  if (!text(r.pointId, MAX_SHORT) || (r.mode !== 'shadow' && r.mode !== 'active')) return false;
  if (!text(r.provider) || !text(r.model) || !text(r.scope)) return false;
  if (r.confidence !== null && !unit(r.confidence)) return false;
  if (r.subject !== null && !text(r.subject)) return false;
  if (!text(r.questionsHash, MAX_SHORT) || !text(r.stateHash, MAX_SHORT)) return false;
  if (!object(r.answers) || !Array.isArray(r.trail) || r.trail.length > MAX_TRAIL) return false;
  const answers = Object.entries(r.answers);
  if (answers.length > MAX_ANSWERS || !answers.every(([id, a]) => text(id) && validAnswer(a))) return false;
  return r.trail.every(validTrailEntry);
}

const validOutcome = o => typeof o === 'boolean' || text(o, MAX_SHORT) || (Number.isSafeInteger(o) && o >= 0);

export function isLabelRecord(r) {
  return object(r) && Object.keys(r).length === LABEL_KEYS.length && LABEL_KEYS.every(k => Object.hasOwn(r, k))
    && r.schema === 1 && nonNegative(r.time) && typeof r.decisionId === 'string' && HEX64.test(r.decisionId)
    && text(r.questionId) && validOutcome(r.outcome) && text(r.source, MAX_SHORT);
}

export function decisionLogDir(config) {
  return path.join(config.stateDir, 'decisions-log');
}

async function lstatOrNull(file) {
  try { return await fs.lstat(file); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export class DecisionLog {
  constructor(dir, { now = Date.now } = {}) {
    assert(typeof dir === 'string' && path.isAbsolute(dir), 'ABSOLUTE_DECISION_LOG_REQUIRED');
    this.dir = dir;
    this.now = now;
  }

  async append(record) {
    assert(isDecisionRecord(record), 'INVALID_DECISION_RECORD');
    await this.#write('decisions', record);
    return record;
  }

  async label(decisionId, { questionId, outcome, source } = {}) {
    assert(typeof decisionId === 'string' && HEX64.test(decisionId), 'INVALID_DECISION_ID');
    const record = { schema: 1, time: this.now(), decisionId, questionId, outcome, source };
    assert(isLabelRecord(record), 'INVALID_LABEL');
    await this.#write('labels', record);
    return record;
  }

  async read({ since = 0, pointId = null } = {}) {
    assert(nonNegative(since) && (pointId === null || text(pointId, MAX_SHORT)), 'INVALID_DECISION_QUERY');
    const out = { decisions: [], labels: [], corruptLines: 0 };
    const dirStat = await lstatOrNull(this.dir);
    if (!dirStat) return out;
    assert(!dirStat.isSymbolicLink(), 'SYMLINK_DESTINATION');
    assert(dirStat.isDirectory(), 'DECISION_LOG_NOT_DIRECTORY');
    const names = await fs.readdir(this.dir);
    assert(names.length <= MAX_DIR_FILES, 'DECISION_LOG_LIMIT');
    for (const name of names.filter(n => FILE_NAME.test(n)).sort()) {
      const file = path.join(this.dir, name);
      const stat = await fs.lstat(file);
      assert(!stat.isSymbolicLink(), 'SYMLINK_DESTINATION');
      assert(stat.isFile() && stat.size <= MAX_FILE_BYTES, 'DECISION_LOG_LIMIT');
      const isDecision = name.startsWith('decisions-');
      for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        let row = null;
        try { row = JSON.parse(line); } catch { /* counted as corrupt below */ }
        if (isDecision ? isDecisionRecord(row) : isLabelRecord(row)) (isDecision ? out.decisions : out.labels).push(row);
        else out.corruptLines++;
      }
    }
    out.decisions = out.decisions.filter(d => d.time >= since && (pointId === null || d.pointId === pointId));
    if (since > 0 || pointId !== null) {
      // A filtered read only returns labels that belong to the decisions it returns.
      const kept = new Set(out.decisions.map(d => d.decisionId));
      out.labels = out.labels.filter(l => kept.has(l.decisionId));
    }
    // Stable sorts: records with equal times keep their append order.
    out.decisions.sort((a, b) => a.time - b.time);
    out.labels.sort((a, b) => a.time - b.time);
    return out;
  }

  async #write(kind, record) {
    const line = JSON.stringify(record) + '\n';
    const bytes = Buffer.byteLength(line);
    assert(bytes <= MAX_LINE_BYTES, 'DECISION_RECORD_TOO_LARGE');
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const dirStat = await fs.lstat(this.dir);
    assert(!dirStat.isSymbolicLink(), 'SYMLINK_DESTINATION');
    assert(dirStat.isDirectory(), 'DECISION_LOG_NOT_DIRECTORY');
    const month = new Date(this.now()).toISOString().slice(0, 7);
    const file = path.join(this.dir, `${kind}-${month}.jsonl`);
    const stat = await lstatOrNull(file);
    if (stat) {
      assert(!stat.isSymbolicLink(), 'SYMLINK_DESTINATION');
      assert(stat.isFile(), 'DECISION_LOG_NOT_FILE');
      assert(stat.size + bytes <= MAX_FILE_BYTES, 'DECISION_LOG_FULL');
    }
    try { await fs.appendFile(file, line, { mode: 0o600, flag: APPEND_FLAGS }); }
    catch (e) { assert(e.code !== 'ELOOP', 'SYMLINK_DESTINATION'); throw e; }
  }
}
