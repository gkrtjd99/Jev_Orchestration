import test from 'node:test';import assert from 'node:assert/strict';
import path from 'node:path';import fs from 'node:fs/promises';
import {JevClient,validateAnswers} from '../src/jev.mjs';
import {routeQuestions} from '../src/questions.mjs';
import {writeJSON,hash,sleep} from '../src/util.mjs';
import {handleHook} from '../src/hooks.mjs';
import {fixture,event,answer,server,child} from './helpers.mjs';
const entry=path.resolve('bin/jev-hook.mjs');
function liveLocalConfig(f,s){return {...f.config,endpoint:s.endpoint,allowLoopback:true,timeoutMs:200,cacheTtlMs:10000};}
for(const type of ['missing-envelope','missing-answer','bad-type','bad-choice','bad-confidence','missing-probability','bad-sum','bad-noul'])test('HTTP answer validation: '+type,()=>{
 const q=routeQuestions([{path:'doc.md'}]);const r=answer(q);
 if(type==='missing-envelope')delete r.answers;
 if(type==='missing-answer')delete r.answers.role;
 if(type==='bad-type')r.answers.role.type='score';
 if(type==='bad-choice')r.answers.role.choice='arbitrary-model';
 if(type==='bad-confidence')r.answers.role.confidence=2;
 if(type==='missing-probability')delete r.answers.role.probabilities.plan;
 if(type==='bad-sum')r.answers.role.probabilities.plan=0.5;
 if(type==='bad-noul')r.answers.doc_0.noul=-1;
 assert.throws(()=>validateAnswers(r,q));
});
test('real loopback HTTP uses the official endpoint shape and Bearer header',async t=>{
 const f=await fixture(t),s=await server(t),cfg=liveLocalConfig(f,s);const q=routeQuestions([]);
 const response=await new JevClient(cfg,'fixture-key').request({task:'small task'},q);
 assert.equal(response.model,'jev-fixture-not-live');assert.equal(s.requests.length,1);
 assert.equal(s.requests[0].url,'/v1/systemone');assert.equal(s.requests[0].authorization,'Bearer fixture-key');
 assert.deepEqual(Object.keys(s.requests[0].body).sort(),['model','questions','state']);
});
test('persistent cache shares an identical decision between separate client instances',async t=>{
 const f=await fixture(t),s=await server(t),cfg=liveLocalConfig(f,s),q=routeQuestions([]);
 const a=await new JevClient(cfg,'fixture-key').evaluate({task:'same'},q,'scope');
 const b=await new JevClient(cfg,'fixture-key').evaluate({task:'same'},q,'scope');
 assert.equal(a.cached,false);assert.equal(b.cached,true);assert.equal(s.requests.length,1);
});
test('parallel real HTTP cache misses collapse to one API request',async t=>{
 const f=await fixture(t),s=await server(t,async(req,res,body)=>{await sleep(35);res.end(JSON.stringify(answer(body.questions)));});
 const cfg=liveLocalConfig(f,s),q=routeQuestions([]);
 const r=await Promise.all(Array.from({length:6},()=>new JevClient(cfg,'fixture-key').evaluate({task:'parallel'},q,'scope')));
 assert.equal(s.requests.length,1);assert.equal(r.filter(x=>!x.cached).length,1);
});
test('different project scopes cannot reuse another project decision',async t=>{
 const f=await fixture(t),s=await server(t),cfg=liveLocalConfig(f,s),q=routeQuestions([]);
 const c=new JevClient(cfg,'fixture-key');await c.evaluate({task:'same'},q,'project-a');await c.evaluate({task:'same'},q,'project-b');assert.equal(s.requests.length,2);
});
test('Jev real HTTP deadline includes waiting for response body',async t=>{
 // Keep the body open: a client that times only response headers hangs instead
 // of passing. Avoid sub-250ms wall assertions, which flake under parallel CI.
 const f=await fixture(t),s=await server(t,async(req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.write('{');});
 const cfg=liveLocalConfig(f,s);cfg.timeoutMs=150;
 let guard;
 try{
  await assert.rejects(Promise.race([
   new JevClient(cfg,'fixture-key').request({},routeQuestions([])),
   new Promise((_,reject)=>{guard=setTimeout(()=>reject(new Error('BODY_DEADLINE_NOT_ENFORCED')),5000);})
  ]),/JEV_TIMEOUT/);
 }finally{clearTimeout(guard);}
});
test('HTTP errors are surfaced without retry storms',async t=>{
 const f=await fixture(t),s=await server(t,(req,res)=>{res.writeHead(429);res.end('limit');});
 await assert.rejects(new JevClient(liveLocalConfig(f,s),'fixture-key').request({},routeQuestions([])),/JEV_HTTP_429/);assert.equal(s.requests.length,1);
});
test('oversized HTTP responses are bounded',async t=>{
 const f=await fixture(t),s=await server(t,(req,res)=>res.end('x'.repeat(300000)));
 await assert.rejects(new JevClient(liveLocalConfig(f,s),'fixture-key').request({},routeQuestions([])),/JEV_RESPONSE_TOO_LARGE/);
});
test('HTTP redirects are not followed to another credential recipient',async t=>{
 const f=await fixture(t),s=await server(t,(req,res)=>{res.writeHead(302,{Location:'http://127.0.0.1:1/steal'});res.end();});
 await assert.rejects(new JevClient(liveLocalConfig(f,s),'fixture-key').request({},routeQuestions([])));assert.equal(s.requests.length,1);
});
test('no key means no outgoing HTTP request',async t=>{
 const f=await fixture(t),s=await server(t);await assert.rejects(new JevClient(liveLocalConfig(f,s),'').request({},routeQuestions([])),/MISSING_TYPESAFE/);assert.equal(s.requests.length,0);
});
for(const rt of ['claude','codex'])test(rt+' real hook subprocess receives stdin and emits documented native rewrite JSON',async t=>{
 const f=await fixture(t),s=await server(t);const cfg=liveLocalConfig(f,s);cfg.timeoutMs=1000;
 const file=path.join(f.home,'config.json');await writeJSON(file,cfg);
 const result=await child(process.execPath,[entry,'--runtime',rt,'--config',file],{input:JSON.stringify(event(f.project,rt)),env:{...process.env,TYPESAFE_API_KEY:'fixture-key'}});
 assert.equal(result.code,0,result.stderr);const o=JSON.parse(result.stdout);assert.equal(o.hookSpecificOutput.hookEventName,'PreToolUse');if(rt==='claude'){assert.match(o.hookSpecificOutput.updatedInput.subagent_type,/^jev4_implement_light_xhigh_/);assert.equal(o.hookSpecificOutput.updatedInput.model,undefined);}else{assert.equal(o.hookSpecificOutput.updatedInput.model,'gpt-6-luna');assert.equal(o.hookSpecificOutput.updatedInput.reasoning_effort,'xhigh');}assert.equal(s.requests.length,2);
});
test('actual hook subprocess cache persists over independent process lifetimes',async t=>{
 const f=await fixture(t),s=await server(t);const cfg=liveLocalConfig(f,s);cfg.timeoutMs=1000;const file=path.join(f.home,'config.json');await writeJSON(file,cfg);
 for(const id of ['t1','t2']){
  const r=await child(process.execPath,[entry,'--runtime','claude','--config',file],{input:JSON.stringify(event(f.project,'claude',{tool_use_id:id})),env:{...process.env,TYPESAFE_API_KEY:'fixture-key'}});
  assert.equal(r.code,0);assert.ok(JSON.parse(r.stdout).hookSpecificOutput.updatedInput);
 }
 assert.equal(s.requests.length,2);
});
test('actual hook reports malformed input without echoing its secret content',async t=>{
 const f=await fixture(t);const r=await child(process.execPath,[entry,'--runtime','claude','--config',path.join(f.home,'missing.json')],{input:'{"secret":"NEVER_ECHO_THIS"'});
 assert.notEqual(r.code,0);assert.deepEqual(JSON.parse(r.stdout),{});assert.ok(!r.stderr.includes('NEVER_ECHO_THIS'));
});
test('secret-looking tasks do not produce an HTTP request at all',async t=>{
 const f=await fixture(t),s=await server(t);const cfg=liveLocalConfig(f,s);const e=event(f.project);e.tool_input.prompt='Check api_key=private-value and sk-abcdefghijklmnop';
 await handleHook(e,'claude',{config:cfg,apiKey:'fixture-key'});
 assert.equal(s.requests.length,0);
});
