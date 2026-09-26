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
