import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

test('Reporivet-inspired evidence entrypoint points only to existing local files',async()=>{
  const guide=await fs.readFile(path.join(root,'AGENTS.md'),'utf8');
  const links=[...guide.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(m=>m[1]);
  assert.ok(links.length>=8);
  for(const relative of links){
    assert.ok(!relative.includes('://')&&!relative.startsWith('/')&&!relative.includes('..'),relative);
    const item=path.join(root,relative);
    const stat=await fs.lstat(item);
    assert.ok(stat.isFile()&&!stat.isSymbolicLink(),relative);
  }
});

test('ultracode 진입점은 짧은 skill 연결이며 권한·hook 설정을 담지 않는다',async()=>{
  const entry=await fs.readFile(path.join(root,'CLAUDE.md'),'utf8');
  const relative='.claude/skills/jev-ultracode/SKILL.md';
  assert.ok(entry.includes(relative));
  assert.ok(entry.trim().split('\n').length<=10,'CLAUDE 진입점 길이');
  const skill=await fs.readFile(path.join(root,relative),'utf8');
  assert.ok(Buffer.byteLength(skill)<=5120,'항상 읽는 skill은 5 KiB 이하');
  const frontmatter=skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter,'skill frontmatter');
  assert.match(frontmatter[1],/^name: jev-ultracode$/m);
  assert.doesNotMatch(frontmatter[1],/^(?:hooks|allowed-tools|model|context|agent):/m);
  const stat=await fs.lstat(path.join(root,relative));
  assert.ok(stat.isFile()&&!stat.isSymbolicLink());
});
