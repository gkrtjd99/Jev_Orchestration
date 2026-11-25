// Hand-back delivery for point 'supervisor.outcome'.
//
// Recent Claude Code builds launch every Agent call asynchronously: the Agent PostToolUse carries only a
// launch acknowledgement, and the worker's final report arrives later as a PostToolUse for the
// 'SubagentHandback' tool, fired in the SUBAGENT's context. Hook output of that event would go to the
// finishing subagent, so the judgment made there is parked in a small private record and handed to Main at
// the next point where hook output reaches it: the UserPromptSubmit whose prompt is the harness's
// '<agent-message from="<agent id>">' hand-back block.
//
// Everything here is session-private bookkeeping under <session dir>/handbacks (0700 dir, 0600 files):
//   <hash(agent)>-<handback>.json   one record per hand-back: in_flight -> judged | skipped | unavailable.
//                                   Written only by the SubagentHandback hook process (atomic rename).
//                                   The newest HANDBACK_KEEP records of an agent are kept; older ones are
//                                   removed together with their markers when a new hand-back is recorded.
//   <handback>.claim                this SubagentHandback tool_use_id was already processed (replay guard; holds the time)
//   <handback>.retry                a replay took over a hand-back whose hook process died mid-judgment (once)
//   <handback>.prompt               this hand-back already corroborated one hand-back prompt (holds that prompt's hash)
//   <handback>.delivered            the advice of this hand-back was already returned to Main
//   <hash(task, n)>.slot            the n-th judged hand-back of one routed delegation (HANDBACK_MAX_JUDGED_PER_TASK slots)
// The markers are created with O_EXCL, so "once" never depends on a read-modify-write.
// No report text, no prompt text and no advice text is stored: only ids, hashes, an option name and numbers.
// A record is bound to the prompt that carries its report by hashes only (handbackPromptMatches()).
// The sentence shown to Main is rebuilt from those validated fields at delivery (supervisorSentence()).
import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, object, readJSON, writeJSON } from '../util.mjs';

/** How long the hand-back prompt hook waits for an in-flight judgment (see docs/KERNEL.ko.md for the bound). */
export const HANDBACK_WAIT_MS = 3000;
/** No waiting of any kind continues past this point of the UserPromptSubmit handler's own runtime. */
export const HANDBACK_HOOK_BUDGET_MS = 3500;
/** Grace for the SubagentHandback hook process (started about 70 ms earlier) to write its record. */
export const HANDBACK_GRACE_MS = 250;
export const HANDBACK_POLL_MS = 25;
/** An in-flight marker older than the hook watchdog (7 s) belongs to a process that no longer exists. */
export const HANDBACK_STALE_MS = 7000;
/** A hand-back prompt is corroborated only by a SubagentHandback event observed at most this long before it. */
export const HANDBACK_PROMPT_WINDOW_MS = 10000;
/** Parked advice older than this is never delivered (an initial value, not a measured one). */
export const HANDBACK_DELIVERY_MAX_AGE_MS = 600000;
/** Judge calls spent on the hand-backs of one routed delegation. Later hand-backs are recorded as skipped (handback_limit). */
export const HANDBACK_MAX_JUDGED_PER_TASK = 4;
/** Hand-back records (and their markers) kept per agent. */
export const HANDBACK_KEEP = 4;
/** Line hashes a record keeps from each end of the report (so at most twice this many, 19 bytes each in the file). */
export const HANDBACK_LINE_HASHES = 64;
/** Harness notice lines ('  [harness: ...') tolerated in front of the report in a hand-back prompt. One was observed. */
export const HANDBACK_NOTICE_MAX_LINES = 1;
export const HANDBACK_NOTICE_MAX_CHARS = 4096;

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEADER = /^<agent-message from="([A-Za-z0-9_-]{1,128})">\r?\n\[Subagent hand-back\] /;
const STATUSES = ['in_flight', 'judged', 'skipped', 'unavailable'];
const HEX = /^[0-9a-f]{64}$/;
const LINE_HEX = /^[0-9a-f]{16}$/;
const MARKERS = ['claim', 'retry', 'prompt', 'delivered'];

export const validAgentId = id => typeof id === 'string' && AGENT_ID.test(id);

/**
 * Agent id of a harness hand-back prompt, or null. Only the id in the fixed header is parsed, with a strict
 * pattern; everything after it is untrusted worker text and is never read for meaning.
 */
export function handbackPromptAgent(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = HEADER.exec(prompt);
  return m ? m[1] : null;
}

/**
 * True when the prompt is exactly one agent-message element: the header on the first line, the closing tag
 * alone on the last line and no other line that opens or closes an agent-message at column zero. The
 * harness indents every report line, so a report cannot close the element early and append text after it.
 */
export function handbackPromptWellFormed(prompt) {
  if (handbackPromptAgent(prompt) === null) return false;
  const lines = prompt.trimEnd().split(/\r?\n/);
  if (lines.length < 3 || lines.at(-1) !== '</agent-message>') return false;
  return lines.slice(1, -1).every(line => !/^<\/?agent-message\b/.test(line));
}

/** Stable id of one SubagentHandback event. Without a tool_use_id the agent and the report hash stand in. */
export function handbackId(toolUseId, agentId, message) {
  return typeof toolUseId === 'string' && toolUseId
    ? hash(['handback', toolUseId])
    : hash(['handback-without-tool-use-id', agentId ?? null, hash(String(message ?? ''))]);
}

const reportLines = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
/** Undo the harness's documented control-tag neutralization ('<' -> '<\') in one line. */
const unneutralized = line => line.replaceAll('<\\', '<');
/** '<' followed by any run of backslashes counts as '<'. Used only for the whole-report hash. */
const folded = line => line.replace(/<\\+/g, '<');
/** Hash of one trimmed report line, keyed by the agent and the hand-back so it is comparable with nothing else. */
const lineHash = (agentId, id, line) => hash(['handback-line', agentId, id, line]).slice(0, 16);
const NOTICE = /^[ \t]+\[harness:/;

/**
 * Hash of a whole report: its non-empty lines, trimmed (the harness indents every report line inside the
 * agent-message element) and with '<\' folded to '<' (the harness may neutralize control tags that way).
 * The text itself is never stored.
 */
export function handbackReportHash(report) {
  return hash(['handback-report', reportLines(report).map(folded)]);
}

/**
 * What a hand-back record keeps to recognise the one prompt that carries its report, without any text:
 *   reportHash  handbackReportHash() of the whole report
 *   lines       { total, head, tail }: the number of non-empty lines and the keyed 64-bit hashes of the first
 *               HANDBACK_LINE_HASHES and the last HANDBACK_LINE_HASHES of them (a report of at most twice
 *               that many lines has every line hash; a longer one has no line hash for its middle, which is
 *               then covered by reportHash only).
 */
export function handbackReportBinding(report, agentId, id) {
  const lines = reportLines(report), n = HANDBACK_LINE_HASHES, h = line => lineHash(agentId, id, line);
  return {
    reportHash: handbackReportHash(report),
    lines: { total: lines.length, head: lines.slice(0, n).map(h), tail: lines.slice(Math.max(n, lines.length - n)).map(h) },
  };
}

function validLines(lines) {
  if (!object(lines) || !Number.isInteger(lines.total) || lines.total < 0 || !Array.isArray(lines.head) || !Array.isArray(lines.tail)) return false;
  const n = HANDBACK_LINE_HASHES;
  return lines.head.length === Math.min(lines.total, n) && lines.tail.length === Math.min(n, Math.max(0, lines.total - n))
    && [...lines.head, ...lines.tail].every(x => typeof x === 'string' && LINE_HEX.test(x));
}

/**
 * True when a hand-back prompt carries the report of this record. Nothing but hashes is compared.
 *
 * The prompt must be exactly one agent-message element. Its body is every non-blank line between the
 * '[Subagent hand-back]' line and the closing tag. The body must be, in this order:
 *   1. at most HANDBACK_NOTICE_MAX_LINES harness notices: an indented line starting with '[harness:', at
 *      most HANDBACK_NOTICE_MAX_CHARS long, whose hash is not one of the record's line hashes;
 *   2. the report's lines, all of them and nothing else, in order. A body line equals a report line when it
 *      is the same after trimming, or the same after trimming and undoing the neutralization ('<\' -> '<').
 *      Lines the record has no line hash for (the middle of a very long report) are held by reportHash.
 * Anything else is no match: an extra, missing, reordered or otherwise rewritten line, a notice anywhere but
 * at the top, a notice that is not indented, a notice in front of an empty report.
 *
 * What a worker can and cannot do with this. A worker chooses the report lines and nothing else.
 *   - Report lines that start with '[harness:' are report lines: they are in the record and must be in the
 *     prompt at their own positions. They widen nothing. The only tolerated line is one notice at the very
 *     top that is NOT a line of this report (as far as the record's line hashes reach), so a prompt cannot
 *     pass by repeating or moving one of the report's own '[harness:' lines.
 *   - A report line that already contains '<\' is hashed as it is; the prompt line must be that line, or
 *     that line with one more backslash after each '<' it holds. The rule is one-directional: a prompt line
 *     with fewer backslashes than the report line never matches a stored line hash.
 *   - The record is looked up by the agent id of the prompt's header and its line hashes are keyed by that
 *     agent id and the hand-back id, so no report text makes the prompt of another agent, or another
 *     hand-back's record, match.
 * What this tolerance does give up: a prompt that is the report plus one indented '[harness:' line of
 * arbitrary content on top is accepted as that hand-back's prompt (once, inside the time window, like any
 * hand-back prompt). Such a prompt is neither stored nor made the goal; see docs/KERNEL.ko.md.
 */
export function handbackPromptMatches(prompt, record) {
  if (!handbackPromptWellFormed(prompt) || !object(record) || !validAgentId(record.agentId) || !HEX.test(String(record.handbackId))
    || !HEX.test(String(record.reportHash)) || !validLines(record.lines) || handbackPromptAgent(prompt) !== record.agentId) return false;
  const body = prompt.trimEnd().split(/\r?\n/).slice(2, -1).filter(line => line.trim());
  const { total, head, tail } = record.lines;
  const notices = body.length - total;
  if (notices < 0 || notices > HANDBACK_NOTICE_MAX_LINES || (notices && !total)) return false;
  const h = line => lineHash(record.agentId, record.handbackId, line);
  const stored = new Set([...head, ...tail]);
  for (const raw of body.slice(0, notices)) {
    if (!NOTICE.test(raw) || raw.length > HANDBACK_NOTICE_MAX_CHARS) return false;
    const line = raw.trim();
    if (stored.has(h(line)) || stored.has(h(unneutralized(line)))) return false;
  }
  const lines = body.slice(notices).map(line => line.trim());
  const same = (line, want) => h(line) === want || (line.includes('<\\') && h(unneutralized(line)) === want);
  return head.every((want, i) => same(lines[i], want)) && tail.every((want, j) => same(lines[total - tail.length + j], want))
    && hash(['handback-report', lines.map(folded)]) === record.reportHash;
}

function validRecord(record, agentId) {
  return object(record) && record.schema === 2 && record.agentId === agentId && typeof record.handbackId === 'string'
    && HEX.test(record.handbackId) && typeof record.reportHash === 'string' && HEX.test(record.reportHash) && validLines(record.lines)
    && Number.isFinite(record.seenAt) && STATUSES.includes(record.status);
}

export class HandbackLedger {
  /** `sessionDir` is SessionStore.dir, so a record can never be read from another session, project or runtime. */
  constructor(sessionDir) {
    this.dir = path.join(sessionDir, 'handbacks');
  }

  file(agentId, id) {
    return path.join(this.dir, `${hash(['handback-agent', agentId])}-${id}.json`);
  }

  /** One hand-back record of this agent, or null when there is none or it is not a valid record. */
  async get(agentId, id) {
    if (!validAgentId(agentId) || !HEX.test(String(id))) return null;
    let record;
    try { record = await readJSON(this.file(agentId, id), null); } catch { return null; }
    return validRecord(record, agentId) && record.handbackId === id ? record : null;
  }

  /** The valid hand-back records of this agent, newest first. */
  async records(agentId) {
    if (!validAgentId(agentId)) return [];
    let names;
    try { names = await fs.readdir(this.dir); } catch { return []; }
    const prefix = hash(['handback-agent', agentId]) + '-';
    const found = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const record = await this.get(agentId, name.slice(prefix.length, -'.json'.length));
      if (record) found.push(record);
    }
    return found.sort((a, b) => b.seenAt - a.seenAt);
  }

  /** Latest hand-back record of this agent, or null. */
  async read(agentId) {
    return (await this.records(agentId))[0] ?? null;
  }

  async write(agentId, record) {
    await writeJSON(this.file(agentId, record.handbackId), record);
  }

  /** Remove this agent's records beyond the newest `keep`, with their markers. Best effort; never throws. */
  async prune(agentId, keep = HANDBACK_KEEP) {
    try {
      for (const old of (await this.records(agentId)).slice(keep)) {
        await fs.rm(this.file(agentId, old.handbackId), { force: true });
        for (const kind of MARKERS) await fs.rm(path.join(this.dir, `${old.handbackId}.${kind}`), { force: true });
      }
    } catch { /* bookkeeping only */ }
  }

  /** Create a once-only marker holding `value` (a hash or a timestamp). True for the first caller, false when it already exists. */
  async claim(id, kind, value = String(Date.now())) {
    if (!HEX.test(id) || ![...MARKERS, 'slot'].includes(kind)) return false;
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(path.join(this.dir, `${id}.${kind}`), String(value) + '\n', { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  }

  /** The value an existing marker was created with, or null. */
  async claimed(id, kind) {
    if (!HEX.test(id)) return null;
    try { return (await fs.readFile(path.join(this.dir, `${id}.${kind}`), 'utf8')).trim(); } catch { return null; }
  }

  /** Take one of the `max` judgment slots of a routed delegation. False when all are used. */
  async slot(taskId, max = HANDBACK_MAX_JUDGED_PER_TASK) {
    for (let n = 0; n < max; n++) if (await this.claim(hash(['handback-slot', String(taskId), n]), 'slot')) return true;
    return false;
  }
}
