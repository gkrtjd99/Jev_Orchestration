import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { profileDefinitions } from '../src/profiles.mjs';
import { profileCatalog } from '../src/catalog.mjs';
import { hash } from '../src/util.mjs';
import { defaults } from '../src/config.mjs';
// Test files including fake env credentials are always private. Production chmod checks are tested separately.
process.umask(0o077);
// Synthetic tests must not inherit operator model/API configuration.
for(const k of Object.keys(process.env))if(/^(?:JEV_|TYPESAFE_|ANTHROPIC_|CLAUDE_|CODEX_)/.test(k))delete process.env[k];
export function confirmedConfig(home){const c=defaults(home);for(const m of c.registry.models)m.availability='confirmed';return c;}
export async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'jev-hooks-test-'));
 const home=path.join(root,'home');const project=path.join(root,'project');
 await fs.mkdir(home);await fs.mkdir(project);await fs.mkdir(path.join(project,'docs'));
 await fs.writeFile(path.join(project,'AGENTS.md'),'Keep existing requirements.');
 await fs.writeFile(path.join(project,'docs','api.md'),'Exact API contract.');
 await fs.writeFile(path.join(project,'docs','history.md'),'Old background.');
 const config=defaults(home);config.allowedProjects=[project];
 config.mode='active';config.safety.allowEgress=true;config.safety.codexRewriteApproved=true;
 for(const m of config.registry.models){m.availability='confirmed';}

 for(const rt of ['claude','codex']){
  const dir=path.join(root,'fixture-profiles',rt);await fs.mkdir(dir,{recursive:true});
  const ps=profileCatalog(config.registry,rt);
  for(const [name,content] of Object.entries(profileDefinitions(rt,config.registry))){
   const file=path.join(dir,name);await fs.writeFile(file,content);
   const p=ps.find(p=>name.startsWith(p.profileId+'.'));
   config.installedProfiles[rt][p.profileId]={path:file,sha256:hash(content),fingerprint:p.fingerprint};
  }
 }
 t?.after(()=>fs.rm(root,{recursive:true,force:true}));
 return {root,home,project,config};
}
export function event(project,runtime='claude',extra={}){
 return {hook_event_name:'PreToolUse',session_id:'session-test',cwd:project,tool_use_id:'tool-1',
  tool_name:runtime==='claude'?'Agent':'spawn_agent',permission_mode:'default',
  tool_input:runtime==='claude'?{prompt:'Implement the notification toggle.',subagent_type:'general-purpose',description:'toggle',run_in_background:true}:{message:'Implement the notification toggle.',task_name:'toggle',agent_type:'default',fork_turns:'none'},...extra};
}
export function answer(questions,overrides={}){
 const defaults={role:'implement',complexity:'bounded',risk:'normal',reading:'targeted',reasoning:'routine',information:'sufficient',failure:'environment',kind:'reference'};
 const answers={};
 for(const [key,q]of Object.entries(questions)){
  if(q.type==='noul'){answers[key]={type:'noul',noul:overrides[key]??0.1};continue;}
  const selected=overrides[key]??defaults[key]??Object.keys(q.criteria)[0];
  const probabilities=Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===selected?1:0]));
  answers[key]={type:'choice',choice:selected,confidence:overrides.confidence??1,probabilities};
 }
 return {model:'jev-fixture-not-live',answers,usage:{input_tokens:12,output_tokens:0}};
}
export function mockClient(overrides={}){
 let count=0;return {get count(){return count;},async evaluate(s,q){count++;return {response:answer(q,overrides),cached:false,latencyMs:0};}};
}
export async function server(t,respond=null){
 const requests=[];
 const httpServer=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  let parsed;try{parsed=JSON.parse(body);}catch{res.writeHead(400);res.end();return;}
  requests.push({url:req.url,authorization:req.headers.authorization,body:parsed});
  if(respond){await respond(req,res,parsed);return;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(answer(parsed.questions)));
 });
 await new Promise((resolve,reject)=>{httpServer.once('error',reject);httpServer.listen(0,'127.0.0.1',resolve);});
 const close=()=>new Promise(r=>{httpServer.closeAllConnections();httpServer.close(r);});
 t?.after(close);
 return {endpoint:`http://127.0.0.1:${httpServer.address().port}`,requests,close};
}
export function child(command,args,{input='',env=process.env,cwd}={}){
 return new Promise((resolve,reject)=>{
  const p=spawn(command,args,{env,cwd,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  p.on('error',reject);p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);
  p.on('close',code=>resolve({code,stdout,stderr}));p.stdin.end(input);
 });
}
