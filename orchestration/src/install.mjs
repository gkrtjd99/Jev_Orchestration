import fs from 'node:fs/promises';
import {safetyDefaults,applySafetyEnvironment,readPrivateEnv} from './safety.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, assert, object, atomicWrite, readJSON, writeJSON, hash, withLock } from './util.mjs';
import { defaults, loadConfig, validateConfig, parseEnv } from './config.mjs';
import { hookMatchers } from './adapters.mjs';
import { profileDefinitions } from './profiles.mjs';
import { profileCatalog, validateRegistry, applyModelEnvironment } from './catalog.mjs';
export const sourceRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function hookConfig(runtime,entry,config,node=process.execPath,readAdvice=false,controller=false){
  const command=[node,entry,'--runtime',runtime,'--config',config].map(quote).join(' ');
  const make=matcher=>({...matcher?{matcher}:{},hooks:[{type:'command',command,timeout:8}]});
  const hooks={SessionStart:[make()],UserPromptSubmit:[make()],PreToolUse:[make(hookMatchers(runtime,readAdvice,controller))],
    PostToolUse:[make(runtime==='claude'?'^(Agent|Task|Workflow|SubagentHandback)$':hookMatchers(runtime))],
    SubagentStart:[make()],SubagentStop:[make()],PreCompact:[make()],SessionEnd:[make()]};
  if(runtime==='claude')hooks.PostToolUseFailure=[make('^(Agent|Task)$')];
  return {hooks};
}
export function mergeHooks(existing,addition){
  assert(object(existing)&&(!existing.hooks||object(existing.hooks)),'INVALID_NATIVE_HOOK_CONFIG');
  const out=structuredClone(existing);out.hooks??={};
  for(const [event,groups] of Object.entries(addition.hooks)){
    const current=out.hooks[event]||[];assert(Array.isArray(current),'INVALID_HOOK_GROUPS');
    const commands=new Set(groups.flatMap(g=>g.hooks.map(h=>h.command)));
    const preserved=[];
    for(const group of current){
      assert(object(group)&&Array.isArray(group.hooks),'INVALID_HOOK_GROUP');
      const left=group.hooks.filter(h=>!commands.has(h.command));if(left.length)preserved.push({...group,hooks:left});
    }
    out.hooks[event]=[...preserved,...groups];
  }
  return out;
}
export function removeHooks(existing,commands){
  const out=structuredClone(existing);if(!object(out.hooks))return out;
  for(const [name,groups] of Object.entries(out.hooks)){
    out.hooks[name]=groups.map(g=>({...g,hooks:g.hooks.filter(h=>!commands.includes(h.command))})).filter(g=>g.hooks.length);
    if(!out.hooks[name].length)delete out.hooks[name];
  }
  if(!Object.keys(out.hooks).length)delete out.hooks;
  return out;
}
export const agentDefinitions = profileDefinitions;
async function oldBytes(file){
  try{assert(!(await fs.lstat(file)).isSymbolicLink(),'SYMLINK_DESTINATION');return await fs.readFile(file,'utf8');}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
async function rejectCompetingProjectHooks(project){
  for(const name of ['.claude/settings.json','.claude/settings.local.json','.codex/hooks.json']){
    const file=path.join(project,name);const text=await oldBytes(file);if(text===null)continue;
    const settings=JSON.parse(text);const groups=Object.values(settings.hooks||{}).flat();
    for(const group of groups)for(const hook of group.hooks||[]){
      if(typeof hook.command==='string'&&/(?:jev[-_]hook|[./\\]\.jev[\\/]|JEV_ENV_FILE)/i.test(hook.command))
        assert(false,'COMPETING_PROJECT_JEV_HOOKS_REQUIRE_MIGRATION');
    }
  }
}
export async function install({home,project,runtime='both',yes=false,envFile=null,mode=null,registryFile=null,root=sourceRoot}){
  assert(path.isAbsolute(home)&&path.isAbsolute(project),'ABSOLUTE_INSTALL_PATHS_REQUIRED');
  assert(['both','claude','codex'].includes(runtime),'INVALID_RUNTIME');
  home=await fs.realpath(home);project=await fs.realpath(project);
  await rejectCompetingProjectHooks(project);
  const rts=runtime==='both'?['claude','codex']:[runtime];
  const confDir=path.join(home,'.config','jev-hooks');const confFile=path.join(confDir,'config.json');
  const manifestFile=path.join(confDir,'installation.json');
  const snapshot=path.join(home,'.local','share','jev-hooks',VERSION);
  const existingManifest=await readJSON(manifestFile,{files:[],hooks:[],runtimes:[]});
  const oldConfig=await oldBytes(confFile);
  let config=oldConfig?JSON.parse(oldConfig):defaults(home);
  const legacyOverrides=[];
  config.safety={...safetyDefaults(),...config.safety};
  if(config.schema===3){
    const legacy=config.models;
    const starter=defaults(home);
    for(const m of starter.registry.models){
      const old=legacy?.[m.runtime]?.[m.slot];
      if(old&&old!==m.model)legacyOverrides.push({runtime:m.runtime,slot:m.slot});
    }
    config={...starter,...config,schema:4};delete config.models;
  }
  validateConfig(config);
  if(registryFile){assert(path.isAbsolute(registryFile),'ABSOLUTE_REGISTRY_REQUIRED');config.registry=validateRegistry(await readJSON(registryFile));}
  config.allowedProjects=[...new Set([...config.allowedProjects,project])];
  config.enabledRuntimes=[...new Set([...existingManifest.runtimes,...rts])];
  let envText=await oldBytes(path.join(confDir,'.env'));
  if(envText!==null)envText=await readPrivateEnv(path.join(confDir,'.env'));
  if(envFile){assert(path.isAbsolute(envFile),'ABSOLUTE_ENV_FILE_REQUIRED');envText=await readPrivateEnv(envFile);parseEnv(envText);}
  envText??=await fs.readFile(path.join(root,'.env.example'),'utf8');
  const env=parseEnv(envText);
  for(const prior of legacyOverrides){
    const prefix=`JEV_${prior.runtime.toUpperCase()}_${prior.slot.toUpperCase()}`;
    assert(registryFile||(env[prefix+'_MODEL']&&env[prefix+'_EFFORT_MAP']),'LEGACY_CUSTOM_MAPPING_REQUIRES_EXPLICIT_CAPABILITIES');
  }
  applyModelEnvironment(config,env);applySafetyEnvironment(config,k=>env[k]);
  if(env.JEV_OBJECTIVE)config.optimization.objective=env.JEV_OBJECTIVE;
  if(env.JEV_EVALUATION_CONTEXT)config.optimization.evaluationContext=env.JEV_EVALUATION_CONTEXT;
  if(env.JEV_MODE)config.mode=env.JEV_MODE;
  if(env.JEV_READ_ADVICE){assert(['true','false'].includes(env.JEV_READ_ADVICE),'INVALID_READ_ADVICE');config.readAdvice=env.JEV_READ_ADVICE==='true';}
  if(env.JEV_TIMEOUT_MS)config.timeoutMs=Number(env.JEV_TIMEOUT_MS);
  if(env.TYPESAFE_BASE_URL)config.endpoint=env.TYPESAFE_BASE_URL;
  if(env.JEV_MODEL)config.model=env.JEV_MODEL;
  if(mode){assert(['active','advisory','shadow','off','controller'].includes(mode),'INVALID_MODE');config.mode=mode;envText=/^JEV_MODE=.*$/m.test(envText)?envText.replace(/^JEV_MODE=.*$/m,'JEV_MODE='+mode):envText+'\nJEV_MODE='+mode+'\n';}
  validateConfig(config);
  const writes=[];const owned=[...existingManifest.files];const hooks=[...existingManifest.hooks];
  const add=async(file,content,own=false)=>{
    const old=await oldBytes(file);if(old===content)return;
    if(own&&old!==null){const prior=owned.find(x=>x.path===file);assert(prior?.sha256===hash(old),'OWNED_FILE_EDITED_OR_COLLISION');}
    writes.push({file,content,old});
  };
  // Copy only the small hook runtime. No old engine, worker runner, Skills, or MCP server is installed.
  for(const dir of ['src','bin']){
    // Recursive so src/kernel/*.mjs ships with the modules that import it.
    for(const name of (await fs.readdir(path.join(root,dir),{recursive:true})).sort()){if(!name.endsWith('.mjs'))continue;
      const file=path.join(snapshot,dir,name);const content=await fs.readFile(path.join(root,dir,name),'utf8');
      await add(file,content,true);const ix=owned.findIndex(x=>x.path===file);if(ix>=0)owned.splice(ix,1);owned.push({path:file,sha256:hash(content)});
    }
  }
  const entry=path.join(snapshot,'bin','jev-hook.mjs');
  for(const rt of config.enabledRuntimes){
    const nativeDir=path.join(home,rt==='claude'?'.claude':'.codex');
    const file=path.join(nativeDir,rt==='claude'?'settings.json':'hooks.json');
    const old=await oldBytes(file);const existing=old===null?{}:JSON.parse(old);
    const previous=hooks.find(h=>h.runtime===rt);
    const clean=previous?removeHooks(existing,previous.commands):existing;
    const addition=hookConfig(rt,entry,confFile,process.execPath,config.readAdvice,config.mode==='controller');
    const merged=mergeHooks(clean,addition);
    await add(file,JSON.stringify(merged,null,2)+'\n');
    if(previous)hooks.splice(hooks.indexOf(previous),1);
    hooks.push({runtime:rt,path:file,commands:[...new Set(Object.values(addition.hooks).flatMap(gs=>gs.flatMap(g=>g.hooks.map(h=>h.command))))]});
    config.installedProfiles[rt]={};
    const generated=profileCatalog(config.registry,rt);
    for(const [name,content] of Object.entries(agentDefinitions(rt,config.registry))){
      const p=path.join(nativeDir,'agents',name);await add(p,content,true);const ix=owned.findIndex(x=>x.path===p);if(ix>=0)owned.splice(ix,1);owned.push({path:p,sha256:hash(content)});
      const profile=generated.find(x=>name.startsWith(x.profileId+'.'));
      config.installedProfiles[rt][profile.profileId]={path:p,sha256:hash(content),fingerprint:profile.fingerprint};
    }
  }
  const currentProfilePaths=new Set(Object.values(config.installedProfiles).flatMap(x=>Object.values(x).map(y=>y.path)));
  for(const old of [...owned]){
    if(!old.path.includes(path.sep+'agents'+path.sep)||currentProfilePaths.has(old.path))continue;
    const text=await oldBytes(old.path);
    if(text===null)continue;
    assert(hash(text)===old.sha256,'OBSOLETE_PROFILE_WAS_EDITED');
    writes.push({file:old.path,content:null,old:text});owned.splice(owned.indexOf(old),1);
  }
  await add(confFile,JSON.stringify(config,null,2)+'\n');
  await add(path.join(confDir,'.env'),envText);
  await add(manifestFile,JSON.stringify({schema:4,version:VERSION,runtimes:config.enabledRuntimes,files:owned,hooks},null,2)+'\n');
  const plan={applied:false,config:confFile,files:writes.map(x=>x.file),runtime:rts,requiresNativeTrust:true};
  if(!yes)return plan;
  return withLock(confDir+'.install.lock',async()=>{
    // Recheck all observed bytes before any writes. Detect user edits during planning.
    for(const w of writes)assert(await oldBytes(w.file)===w.old,'INSTALL_CONCURRENT_CHANGE');
    const done=[];const backup=path.join(confDir,'backups',String(Date.now()));
    try{
      for(const w of writes){
        if(w.old!==null)await atomicWrite(path.join(backup,hash(w.file)+'.bak'),w.old);
        if(w.content===null)await fs.rm(w.file,{force:true});else await atomicWrite(w.file,w.content);done.push(w);
      }
    }catch(e){
      for(const w of done.reverse()){if(w.old===null)await fs.rm(w.file,{force:true});else await atomicWrite(w.file,w.old);}
      throw e;
    }
    return {...plan,applied:true,backup};
  });
}
export async function uninstall(home,yes=false){
  const file=path.join(home,'.config','jev-hooks','installation.json');const manifest=await readJSON(file);
  const edits=[];const preserved=[];
  for(const h of manifest.hooks){const old=await readJSON(h.path,{});edits.push({file:h.path,text:JSON.stringify(removeHooks(old,h.commands),null,2)+'\n'});}
  const removals=[];
  for(const f of manifest.files){const text=await oldBytes(f.path);if(text===null)continue;if(hash(text)===f.sha256)removals.push(f.path);else preserved.push(f.path);}
  if(yes){for(const e of edits)await atomicWrite(e.file,e.text);for(const p of removals)await fs.rm(p,{force:true});await fs.rm(file,{force:true});}
  return {applied:yes,hookFiles:edits.map(e=>e.file),remove:removals,preservedEditedFiles:preserved,retained:'config, API key, backups, and state are retained'};
}
