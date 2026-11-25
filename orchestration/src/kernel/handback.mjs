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
//   <hash(agent)>.json        latest hand-back of that agent: in_flight -> judged | skipped | unavailable.
//                             Written only by the SubagentHandback hook process (atomic rename).
//   <handback>.claim          this SubagentHandback tool_use_id was already processed (replay guard)
//   <handback>.prompt         this hand-back already corroborated one hand-back prompt (holds that prompt's hash)
//   <handback>.delivered      the advice of this hand-back was already returned to Main
// The three markers are created with O_EXCL, so "once" never depends on a read-modify-write.
// No report text and no prompt text is stored: only ids, hashes, numbers and the advice sentence built by
// supervisorAdvice() from the judge's option name and numbers.
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

const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEADER = /^<agent-message from="([A-Za-z0-9_-]{1,128})">\r?\n\[Subagent hand-back\] /;
const STATUSES = ['in_flight', 'judged', 'skipped', 'unavailable'];
const HEX = /^[0-9a-f]{64}$/;
const ADVICE_PREFIX = 'Jev supervisor (advisory): ';

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

/** Only the sentence supervisorAdvice() builds is ever returned to Main from a stored record. */
export const validAdviceText = text => typeof text === 'string' && text.startsWith(ADVICE_PREFIX) && text.length <= 600 && !/[\r\n]/.test(text);

function validRecord(record, agentId) {
  return object(record) && record.schema === 1 && record.agentId === agentId && typeof record.handbackId === 'string'
    && HEX.test(record.handbackId) && Number.isFinite(record.seenAt) && STATUSES.includes(record.status);
}

export class HandbackLedger {
  /** `sessionDir` is SessionStore.dir, so a record can never be read from another session, project or runtime. */
  constructor(sessionDir) {
    this.dir = path.join(sessionDir, 'handbacks');
  }

  agentFile(agentId) {
    return path.join(this.dir, hash(['handback-agent', agentId]) + '.json');
  }

  /** Latest hand-back record of this agent, or null when there is none or it is not a valid record. */
  async read(agentId) {
    if (!validAgentId(agentId)) return null;
    let record;
    try { record = await readJSON(this.agentFile(agentId), null); } catch { return null; }
    return validRecord(record, agentId) ? record : null;
  }

  async write(agentId, record) {
    await writeJSON(this.agentFile(agentId), record);
  }

  /** Create a once-only marker holding `value` (a hash or a timestamp). True for the first caller, false when it already exists. */
  async claim(id, kind, value = String(Date.now())) {
    if (!HEX.test(id) || !['claim', 'prompt', 'delivered'].includes(kind)) return false;
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
}
