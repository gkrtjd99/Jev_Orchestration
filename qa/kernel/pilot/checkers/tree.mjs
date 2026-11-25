import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Folders that are session or tool state, not project content.
const IGNORED_DIRS = new Set(['.git', 'node_modules']);
const IGNORED_FILES = new Set(['.DS_Store']);

// Under .claude/ only the skill catalog is project content; settings, hook state and worktrees are not.
const ignoredPath = (rel) => rel.startsWith('.claude/') && !rel.startsWith('.claude/skills/');

export function snapshot(root) {
  const files = new Map();
  const walk = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(full, rel);
      } else if (entry.isFile()) {
        if (IGNORED_FILES.has(entry.name) || ignoredPath(rel)) continue;
        files.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
      } else if (lstatSync(full).isSymbolicLink() && !ignoredPath(rel)) {
        files.set(rel, 'symlink');
      }
    }
  };
  walk(root, '');
  return files;
}

// Paths that differ between the pristine template and the project, sorted.
export function changedPaths(templateDir, projectDir) {
  const before = snapshot(templateDir);
  const after = snapshot(projectDir);
  const added = [];
  const modified = [];
  const removed = [];
  for (const [rel, hash] of after) {
    if (!before.has(rel)) added.push(rel);
    else if (before.get(rel) !== hash) modified.push(rel);
  }
  for (const rel of before.keys()) if (!after.has(rel)) removed.push(rel);
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}
