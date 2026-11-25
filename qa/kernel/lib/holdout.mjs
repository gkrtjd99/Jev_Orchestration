// Held-out set discipline: a frozen manifest of file hashes, a refusal to run without an explicit reason,
// and an append-only ledger of every run that looked at the set. No network, no product code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const HOLDOUT_FILE = 'HOLDOUT.json';
export const LEDGER_FILE = 'HOLDOUT_LEDGER.jsonl';
export const DEFAULT_POLICY = 'Held-out set. Scored once, with the retrieval mode chosen by qa/kernel/DECISION_RULE.md plus the lexical baseline. '
  + 'Every run is recorded in HOLDOUT_LEDGER.jsonl. Nothing is tuned on results from this set.';
// Labels every sweep the tools print or store. A sweep is for looking at the development set, never a result.
export const SWEEP_LABEL = 'development analysis - not a result';
const SHA256 = /^[0-9a-f]{64}$/;

function fail(code, detail) {
  const e = new Error(detail ? `${code}: ${detail}` : code);
  e.code = code;
  return e;
}

const posix = rel => rel.split(path.sep).join('/');

export async function sha256File(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

/** Every regular file under `dir`, as sorted posix paths relative to `root`. A symlink anywhere is refused. */
export async function listFiles(root, dir = root) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw fail('QA_HOLDOUT_SYMLINK', posix(path.relative(root, full)));
    if (entry.isDirectory()) out.push(...await listFiles(root, full));
    else if (entry.isFile()) out.push(posix(path.relative(root, full)));
  }
  return out.sort();
}

/** The files a freeze covers: everything under skills/, and every .jsonl task or label file except the ledger. */
export async function holdoutFiles(dataDir) {
  const all = await listFiles(dataDir);
  return all.filter(rel => rel.startsWith('skills/') || (rel.endsWith('.jsonl') && rel !== LEDGER_FILE));
}

/** Writes HOLDOUT.json for `dataDir`. Refuses to replace an existing one, and refuses an empty or unusable set. */
export async function freezeHoldout(dataDir, { policy = DEFAULT_POLICY, now = () => new Date() } = {}) {
  if (typeof policy !== 'string' || !policy.trim()) throw fail('QA_HOLDOUT_INVALID_POLICY');
  const target = path.join(dataDir, HOLDOUT_FILE);
  try { await fs.lstat(target); throw fail('QA_HOLDOUT_EXISTS', target); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const files = await holdoutFiles(dataDir);
  if (!files.some(f => f.startsWith('skills/'))) throw fail('QA_HOLDOUT_NO_SKILLS', path.join(dataDir, 'skills'));
  if (!files.some(f => /^[^/]+\.gold\.jsonl$/.test(f))) throw fail('QA_HOLDOUT_NO_LABELS', dataDir);
  const sha256 = {};
  for (const rel of files) sha256[rel] = await sha256File(path.join(dataDir, rel));
  const manifest = { frozen: true, frozenAt: now().toISOString(), policy: policy.trim(), sha256 };
  // 'wx': a concurrent freeze loses instead of overwriting.
  try { await fs.writeFile(target, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') throw fail('QA_HOLDOUT_EXISTS', target); throw e; }
  return { file: target, manifest };
}

/** Returns null when the directory has no HOLDOUT.json, otherwise the validated manifest. */
export async function readHoldout(dataDir) {
  let text;
  try { text = await fs.readFile(path.join(dataDir, HOLDOUT_FILE), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw fail('QA_HOLDOUT_INVALID', HOLDOUT_FILE); }
  let manifest;
  try { manifest = JSON.parse(text); } catch { throw fail('QA_HOLDOUT_INVALID', 'not JSON'); }
  const ok = manifest && typeof manifest === 'object' && !Array.isArray(manifest) && manifest.frozen === true
    && typeof manifest.policy === 'string' && manifest.sha256 && typeof manifest.sha256 === 'object' && !Array.isArray(manifest.sha256)
    && Object.keys(manifest.sha256).length > 0
    && Object.entries(manifest.sha256).every(([rel, hash]) => typeof hash === 'string' && SHA256.test(hash)
      && rel && !path.isAbsolute(rel) && !rel.split('/').includes('..') && !rel.includes('\\'));
  // A manifest that is present but not a valid frozen one is never treated as "no hold-out".
  if (!ok) throw fail('QA_HOLDOUT_INVALID', 'expected {frozen:true, sha256:{file:hash}, policy}');
  return manifest;
}

/**
 * Verifies every listed hash, then that every file the run is about to read (`reads`, relative to dataDir)
 * and every file under skills/ is listed. Throws on the first problem; reads nothing but bytes to hash.
 */
export async function verifyHoldout(dataDir, manifest, { reads = [] } = {}) {
  for (const [rel, expected] of Object.entries(manifest.sha256)) {
    let actual;
    try { actual = await sha256File(path.join(dataDir, rel)); }
    catch { throw fail('QA_HOLDOUT_FILE_MISSING', rel); }
    if (actual !== expected) throw fail('QA_HOLDOUT_HASH_MISMATCH', rel);
  }
  const skills = (await listFiles(dataDir, path.join(dataDir, 'skills')));
  for (const rel of [...skills, ...reads.map(posix)]) {
    if (!Object.hasOwn(manifest.sha256, rel)) throw fail('QA_HOLDOUT_UNLISTED_FILE', rel);
  }
  return { verifiedFiles: Object.keys(manifest.sha256).length };
}

/** Appends one line to the ledger and returns the entry. Called before the first request of a run. */
export async function appendLedger(dataDir, entry) {
  const line = JSON.stringify(entry);
  await fs.appendFile(path.join(dataDir, LEDGER_FILE), line + '\n', { flag: 'a' });
  return entry;
}

export async function readLedger(dataDir) {
  let text;
  try { text = await fs.readFile(path.join(dataDir, LEDGER_FILE), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// Append-only record of every evaluation run in an output directory (development and held-out alike).
export const RUN_LEDGER_FILE = 'RUN_LEDGER.jsonl';

export async function appendRunLedger(outDir, entry) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.appendFile(path.join(outDir, RUN_LEDGER_FILE), JSON.stringify(entry) + '\n', { flag: 'a' });
  return entry;
}

export async function readRunLedger(outDir) {
  let text;
  try { text = await fs.readFile(path.join(outDir, RUN_LEDGER_FILE), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

const SWEEP_KEYS = new Set(['autoLoadSweep', 'thresholdSweep']);
export const SUPPRESSED = Object.freeze({ suppressed: 'held-out set: sweeps and per-item listings are not produced' });

/** Replaces every threshold sweep in a metrics tree, in place. Aggregate metrics are left as they are. */
export function suppressSweeps(node) {
  if (Array.isArray(node)) { node.forEach(suppressSweeps); return node; }
  if (!node || typeof node !== 'object') return node;
  for (const key of Object.keys(node)) {
    if (SWEEP_KEYS.has(key)) node[key] = { ...SUPPRESSED };
    else suppressSweeps(node[key]);
  }
  return node;
}
