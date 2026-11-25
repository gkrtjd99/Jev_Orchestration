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

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEADER = /^<agent-message from="([A-Za-z0-9_-]{1,128})">\r?\n\[Subagent hand-back\] /;
const STATUSES = ['in_flight', 'judged', 'skipped', 'unavailable'];
const HEX = /^[0-9a-f]{64}$/;
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

/**
 * Hash that binds a hand-back record to the prompt that carries the same report. The harness indents every
 * report line inside the agent-message element, so both sides are compared as their non-empty lines with
 * surrounding whitespace removed. The text itself is never stored.
 */
export function handbackReportHash(report) {
  return hash(['handback-report', String(report ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)]);
}

/**
 * handbackReportHash() of the report a well-formed hand-back prompt carries: every line between the
 * '[Subagent hand-back]' line and the closing tag. null when the prompt is not exactly one agent-message element.
 */
export function handbackPromptReportHash(prompt) {
  if (!handbackPromptWellFormed(prompt)) return null;
  return handbackReportHash(prompt.trimEnd().split(/\r?\n/).slice(2, -1).join('\n'));
}

function validRecord(record, agentId) {
  return object(record) && record.schema === 1 && record.agentId === agentId && typeof record.handbackId === 'string'
    && HEX.test(record.handbackId) && typeof record.reportHash === 'string' && HEX.test(record.reportHash)
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
