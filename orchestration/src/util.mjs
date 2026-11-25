import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const VERSION = '3.2.0';
export function assert(ok, code) { if (!ok) { const e = new Error(code); e.code = code; throw e; } }
export function object(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
export function stable(x) {
  if (Array.isArray(x)) return `[${x.map(stable).join(',')}]`;
  if (object(x)) return `{${Object.keys(x).sort().map(k => JSON.stringify(k)+':'+stable(x[k])).join(',')}}`;
  return JSON.stringify(x);
}
export const hash = x => createHash('sha256').update(typeof x === 'string' ? x : stable(x)).digest('hex');
/** fetch() rejects with TypeError('fetch failed') and a system cause (ECONNREFUSED, ENOTFOUND, ...) when no HTTP exchange happened. */
export const networkFailure = e => e instanceof TypeError && (e.message === 'fetch failed' || typeof e.cause?.code === 'string');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const within = (base, file) => { const r = path.relative(base, file); return r === '' || (!r.startsWith('..'+path.sep) && r !== '..' && !path.isAbsolute(r)); };
export function redact(value, max = 6000) {
  return String(value ?? '')
    .replace(/\b(?:sk|ts|jev)-[A-Za-z0-9_-]{8,}/g, '[REDACTED_KEY]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[:=]\s*["']?[^\s"'<>]+/gi, '[REDACTED_CREDENTIAL]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .slice(0, max);
}
export async function readJSON(file, fallback = undefined) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch(e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function atomicWrite(file, text, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { assert(!(await fs.lstat(file)).isSymbolicLink(), 'SYMLINK_DESTINATION'); }
  catch(e) { if (e.code !== 'ENOENT') throw e; }
  const tmp = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(tmp, text, { mode, flag: 'wx' }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}
export const writeJSON = (file, value) => atomicWrite(file, JSON.stringify(value, null, 2)+'\n');
export async function withLock(dir, fn, waitMs = 1500) {
  const deadline = Date.now()+waitMs;
  await fs.mkdir(path.dirname(dir), {recursive:true, mode:0o700});
  let acquired = false;
  do {
    try { await fs.mkdir(dir, {mode:0o700}); acquired=true; break; }
    catch(e) { if (e.code !== 'EEXIST') throw e; }
    if (Date.now() >= deadline) break;
    await sleep(10);
  } while (true);
  assert(acquired, 'LOCK_BUSY');
  try { return await fn(); }
  finally { await fs.rm(dir, {recursive:true,force:true}); }
}
export function options(argv) {
  const out = {};
  for (let i=0; i<argv.length; i++) {
    assert(argv[i].startsWith('--'), 'UNEXPECTED_ARGUMENT');
    const k = argv[i].slice(2); assert(!Object.hasOwn(out,k), 'DUPLICATE_ARGUMENT');
    out[k] = argv[i+1] && !argv[i+1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}
