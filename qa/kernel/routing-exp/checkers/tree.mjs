// Which files differ between the pristine template and a project copy. Read-only.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Not part of the work product: harness settings and state, VCS, dependencies, editor droppings.
const IGNORED_DIRS = new Set(['.claude', '.git', 'node_modules', '.vscode', '.idea']);
const IGNORED_FILES = new Set(['.DS_Store']);

function walk(root, relative = '', out = new Map()) {
  let entries;
  try { entries = readdirSync(join(root, relative), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) { out.set(path, null); continue; }
    if (entry.isDirectory()) { if (!IGNORED_DIRS.has(entry.name)) walk(root, path, out); continue; }
    if (!entry.isFile() || IGNORED_FILES.has(entry.name)) continue;
    try { out.set(path, readFileSync(join(root, path))); } catch { out.set(path, null); }
  }
  return out;
}

/** [{ path, change: 'added' | 'modified' | 'deleted' }] sorted by path. */
export function diffTrees(template, project) {
  const before = walk(template);
  const after = walk(project);
  const changes = [];
  for (const [path, bytes] of after) {
    if (!before.has(path)) changes.push({ path, change: 'added' });
    else if (bytes === null || before.get(path) === null || !bytes.equals(before.get(path))) changes.push({ path, change: 'modified' });
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push({ path, change: 'deleted' });
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
