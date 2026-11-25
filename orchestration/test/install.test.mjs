import { defaultRegistry,profileCatalog } from '../src/catalog.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {install,uninstall,mergeHooks,hookConfig,agentDefinitions} from '../src/install.mjs';
import {writeJSON,readJSON,hash} from '../src/util.mjs';import {loadConfig} from '../src/config.mjs';
import {fixture} from './helpers.mjs';
test('dry-run never writes native settings or installed code',async t=>{const f=await fixture(t);const r=await install({home:f.home,project:f.project});assert.equal(r.applied,false);assert.ok(r.files.length>10);await assert.rejects(fs.stat(path.join(f.home,'.claude')),e=>e.code==='ENOENT');});
test('installation adds hooks and agents without editing model, permissions, AGENTS.md or Codex config.toml',async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.home,'.claude'));await fs.mkdir(path.join(f.home,'.codex'));
 const original={model:'my-main',permissions:{defaultMode:'default',deny:['Bash(rm *)']},hooks:{PreToolUse:[{matcher:'Bash',hooks:[{type:'command',command:'my-existing-hook'}]}]}};
 await writeJSON(path.join(f.home,'.claude','settings.json'),original);await fs.writeFile(path.join(f.home,'.codex','config.toml'),'model = "my-codex-main"\n');await fs.writeFile(path.join(f.home,'.claude','CLAUDE.md'),'my rules');
 const r=await install({home:f.home,project:f.project,yes:true});assert.equal(r.applied,true);
 const settings=await readJSON(path.join(f.home,'.claude','settings.json'));assert.equal(settings.model,'my-main');assert.deepEqual(settings.permissions,original.permissions);assert.ok(settings.hooks.PreToolUse.some(g=>g.hooks[0].command==='my-existing-hook'));
 assert.equal(await fs.readFile(path.join(f.home,'.codex','config.toml'),'utf8'),'model = "my-codex-main"\n');assert.equal(await fs.readFile(path.join(f.home,'.claude','CLAUDE.md'),'utf8'),'my rules');
 const codex=await readJSON(path.join(f.home,'.codex','hooks.json'));assert.ok(codex.hooks.PreToolUse);assert.equal(codex.hooks.PostToolUseFailure,undefined);
 const defs=await fs.readdir(path.join(f.home,'.claude','agents'));assert.equal(defs.length,profileCatalog(defaultRegistry(),'claude').length);
});
test('installed hooks contain no worker CLI, Skill, MCP, or permission bypass invocation',async t=>{
 const f=await fixture(t);await install({home:f.home,project:f.project,yes:true});
 const c=await readJSON(path.join(f.home,'.claude','settings.json'));const text=JSON.stringify(c);
 assert.ok(text.includes('jev-hook.mjs'));for(const forbidden of ['claude -p','codex exec','bypass-hook-trust','jev_start','SKILL.md','bypassPermissions'])assert.ok(!text.includes(forbidden));
});
test('reinstall is idempotent and does not duplicate hooks',async t=>{
 const f=await fixture(t);await install({home:f.home,project:f.project,yes:true});const before=await fs.readFile(path.join(f.home,'.claude','settings.json'),'utf8');
 const r=await install({home:f.home,project:f.project,yes:true});assert.equal(r.files.length,0);assert.equal(await fs.readFile(path.join(f.home,'.claude','settings.json'),'utf8'),before);
});
test('new allowed project extends config without importing its config',async t=>{
 const f=await fixture(t);await install({home:f.home,project:f.project,yes:true});const other=path.join(f.root,'other');await fs.mkdir(other);
 await install({home:f.home,project:other,runtime:'claude',yes:true});const c=await readJSON(path.join(f.home,'.config','jev-hooks','config.json'));assert.ok(c.allowedProjects.includes(f.project)&&c.allowedProjects.includes(other));assert.deepEqual(c.enabledRuntimes,['claude','codex']);
});
test('role model values come from explicit env example, never original reference repo',async t=>{
 const f=await fixture(t);const envFile=path.join(f.root,'my.env');await fs.writeFile(envFile,'TYPESAFE_API_KEY=installation-test-key\nJEV_CLAUDE_LIGHT_MODEL=my-custom-light\nJEV_CLAUDE_LIGHT_EFFORT_MAP={"brief":"low","balanced":"medium","deep":"high"}\nJEV_MODE=shadow\n');
 await install({home:f.home,project:f.project,yes:true,envFile});const file=path.join(f.home,'.config','jev-hooks','config.json');const {config,apiKey}=await loadConfig(file,{});assert.equal(config.mode,'shadow');assert.equal(apiKey,'installation-test-key');
 const reader=profileCatalog(config.registry,'claude').find(p=>p.role==='research'&&p.slot==='light'&&p.effort==='high');assert.match(await fs.readFile(config.installedProfiles.claude[reader.profileId].path,'utf8'),/my-custom-light/);
 const manifest=await fs.readFile(path.join(f.home,'.config','jev-hooks','installation.json'),'utf8');assert.ok(!manifest.includes('installation-test-key'));
 assert.equal((await fs.stat(path.join(f.home,'.config','jev-hooks','.env'))).mode&0o777,0o600);
});
test('native profile name collision fails before any installation writes',async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.home,'.claude','agents'),{recursive:true});await fs.writeFile(path.join(f.home,'.claude','agents',profileCatalog(defaultRegistry(),'claude').find(p=>p.role==='research'&&p.slot==='light'&&p.effort==='high').profileId+'.md'),'user-owned');
 await assert.rejects(install({home:f.home,project:f.project,yes:true}),/COLLISION/);await assert.rejects(fs.stat(path.join(f.home,'.codex')),e=>e.code==='ENOENT');assert.equal(await fs.readFile(path.join(f.home,'.claude','agents',profileCatalog(defaultRegistry(),'claude').find(p=>p.role==='research'&&p.slot==='light'&&p.effort==='high').profileId+'.md'),'utf8'),'user-owned');
});
test('malformed existing settings fail rather than resetting them',async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.home,'.claude'));const p=path.join(f.home,'.claude','settings.json');await fs.writeFile(p,'{INVALID');await assert.rejects(install({home:f.home,project:f.project,yes:true}));assert.equal(await fs.readFile(p,'utf8'),'{INVALID');
});
test('symlinked settings are not overwritten',async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.home,'.claude'));const target=path.join(f.root,'target.json');await writeJSON(target,{});await fs.symlink(target,path.join(f.home,'.claude','settings.json'));await assert.rejects(install({home:f.home,project:f.project,yes:true}),/SYMLINK/);assert.deepEqual(await readJSON(target),{});
});
test('uninstall preserves unrelated hooks and user edits to owned agent definitions',async t=>{
 const f=await fixture(t);await install({home:f.home,project:f.project,yes:true});
 const file=path.join(f.home,'.claude','settings.json');const c=await readJSON(file);c.model='keep';c.hooks.PreToolUse.push({matcher:'Read',hooks:[{type:'command',command:'keep-this'}]});await writeJSON(file,c);
 const own=path.join(f.home,'.claude','agents',profileCatalog(defaultRegistry(),'claude').find(p=>p.role==='research'&&p.slot==='light'&&p.effort==='high').profileId+'.md');await fs.appendFile(own,'user-edit');const r=await uninstall(f.home,true);assert.ok(r.preservedEditedFiles.includes(own));
 const x=await readJSON(file);assert.equal(x.model,'keep');assert.equal(x.hooks.PreToolUse.length,1);assert.equal(x.hooks.PreToolUse[0].hooks[0].command,'keep-this');assert.ok(await fs.stat(path.join(f.home,'.config','jev-hooks','.env')));
});
test('own native profiles reduce reader permissions instead of elevating writers',()=>{
 const r=defaultRegistry(); const c=agentDefinitions('claude',r),o=agentDefinitions('codex',r);
 for(const p of profileCatalog(r,'claude').filter(p=>p.readonly)){assert.match(c[p.profileId+'.md'],/tools: Read, Grep, Glob/);assert.ok(!c[p.profileId+'.md'].includes('Bash'));}
 for(const p of profileCatalog(r,'codex')){if(p.readonly)assert.match(o[p.profileId+'.toml'],/sandbox_mode = "read-only"/);else assert.ok(!o[p.profileId+'.toml'].includes('sandbox_mode'));}
});
test('hook command paths are shell-quoted for spaces and quotes',()=>{const c=hookConfig('claude',"/a b/c'd.mjs",'/config x.json','/node path');const s=c.hooks.PreToolUse[0].hooks[0].command;assert.ok(s.includes("'\\''"));assert.ok(s.startsWith("'/node path'"));});
test('installed matchers observe Workflow boundaries and Codex collaboration spawns exactly',()=>{
 const claude=hookConfig('claude','/hook','/config');const codex=hookConfig('codex','/hook','/config');
 assert.ok(new RegExp(claude.hooks.PreToolUse[0].matcher).test('Workflow'));
 assert.ok(new RegExp(claude.hooks.PostToolUse[0].matcher).test('Workflow'));
 for(const event of ['PreToolUse','PostToolUse']){
  const match=new RegExp(codex.hooks[event][0].matcher);
  assert.ok(match.test('collaborationspawn_agent'));
  assert.ok(!match.test('mcp__other__collaborationspawn_agent'));
 }
});
test('extension production path never imports child_process or an external worker engine',async()=>{
 for(const name of await fs.readdir('src',{recursive:true})){if(!name.endsWith('.mjs'))continue;const text=await fs.readFile(path.join('src',name),'utf8');assert.ok(!text.includes('node:child_process'),name);}
 await assert.rejects(fs.stat('src/worker.mjs'),e=>e.code==='ENOENT');await assert.rejects(fs.stat('src/engine.mjs'),e=>e.code==='ENOENT');await assert.rejects(fs.stat('skills'),e=>e.code==='ENOENT');
});
test('Codex managed profiles omit model to prevent overriding a Jev spawn-time decision',()=>{
 const defs=agentDefinitions('codex',defaultRegistry());
 for(const text of Object.values(defs)){assert.ok(!/^model\s*=/m.test(text));assert.ok(!/^model_reasoning_effort\s*=/m.test(text));}
});

test('old project-local v2.3 hooks must be explicitly migrated, not double-installed',async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.project,'.claude'));
 await writeJSON(path.join(f.project,'.claude','settings.local.json'),{hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:'python3 /project/.jev/runtime/hook.py'}]}]}});
 await assert.rejects(install({home:f.home,project:f.project,yes:true}),/COMPETING_PROJECT_JEV/);
 await assert.rejects(fs.stat(path.join(f.home,'.claude')),e=>e.code==='ENOENT');
});
