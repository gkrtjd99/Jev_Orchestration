import fs from 'node:fs/promises';
import path from 'node:path';
import { profileCatalog } from './catalog.mjs';
import { assert, hash, within } from './util.mjs';
const purpose={plan:'Plan requirements and architecture; do not implement.',research:'Find and read evidence; do not edit.',documentation:'Write bounded documentation with sourced facts.',implement:'Implement assigned scope and run actual checks.',review:'Review independently; report defects and missing checks.'};
export function profileDefinitions(runtime,registry) {
  const result={};
  for(const p of profileCatalog(registry,runtime)) {
    const instruction=`${purpose[p.role]} Keep the original goal, acceptance criteria, tool restrictions and write scope. The existing native parent remains Main. Do not start another CLI orchestrator. Missing information must be reported, not guessed. A worker stop is not proof of success. Return paths, observed checks and unresolved issues.`;
    const desc=`Jev ${p.role}: ${p.slot}/${p.effort??'default'}.`;
    if(runtime==='claude') {
      result[p.profileId+'.md']=`---\nname: ${p.profileId}\ndescription: ${JSON.stringify(desc)}\nmodel: ${JSON.stringify(p.model)}\n${p.effort===null?'':`effort: ${p.effort}\n`}${p.readonly?'tools: Read, Grep, Glob, WebSearch, WebFetch\n':''}---\n\n${instruction}\n`;
    } else {
      // Spawn settings must not be shadowed by model/effort keys in a custom-agent file.
      result[p.profileId+'.toml']=`name = ${JSON.stringify(p.profileId)}\ndescription = ${JSON.stringify(desc)}\n${p.readonly?'sandbox_mode = "read-only"\n':''}developer_instructions = ${JSON.stringify(instruction)}\n`;
    }
  }
  return result;
}
export async function assertInstalledProfile(config,p,project,cwd=project) {
  assert(p,'PROFILE_NO_LONGER_ELIGIBLE');
  const rec=config.installedProfiles?.[p.runtime]?.[p.profileId];
  assert(rec&&rec.fingerprint===p.fingerprint,'PROFILE_NOT_INSTALLED_OR_STALE');
  assert(!(await fs.lstat(rec.path)).isSymbolicLink(),'PROFILE_SYMLINK');
  assert(hash(await fs.readFile(rec.path,'utf8'))===rec.sha256,'PROFILE_DEFINITION_CHANGED');
  // A project definition has higher priority than the installed user definition.
  // Scan bounded text files, not only the filename: identity comes from name.
  let dir=await fs.realpath(cwd);let levels=0;
  assert(within(project,dir),'PROFILE_CWD_OUTSIDE_PROJECT');
  while(within(project,dir)&&levels++<32) {
    const root=path.join(dir,p.runtime==='claude'?'.claude':'.codex','agents');
    const queue=[root];let count=0;
    while(queue.length) {
      const q=queue.shift();let entries;
      try{assert(within(project,await fs.realpath(q)),'PROJECT_AGENT_DIRECTORY_ESCAPES_ROOT');assert(!(await fs.lstat(q)).isSymbolicLink(),'PROJECT_AGENT_SYMLINK_REQUIRES_REVIEW');entries=await fs.readdir(q,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
      for(const f of entries) {
        assert(++count<=256,'PROJECT_AGENT_SCAN_LIMIT');
        const file=path.join(q,f.name);
        assert(!f.isSymbolicLink(),'PROJECT_AGENT_SYMLINK_REQUIRES_REVIEW');
        if(f.isDirectory()){queue.push(file);continue;}
        if(!f.isFile()||!f.name.endsWith(p.runtime==='claude'?'.md':'.toml'))continue;
        if((await fs.stat(file)).size>65536)continue;
        const text=await fs.readFile(file,'utf8');
        const names=p.runtime==='claude'?text.match(/^name:\s*["']?([\w-]+)/m):text.match(/^name\s*=\s*["']([\w-]+)/m);
        assert(names?.[1]!==p.profileId,'PROJECT_AGENT_SHADOWS_PROFILE');
      }
    }
    if(dir===project)break;dir=path.dirname(dir);
  }
  return {status:'installed_definition_verified',effectiveSetting:'not_observed'};
}
