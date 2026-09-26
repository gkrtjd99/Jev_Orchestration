import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';
import {hash,redact,within,readJSON,writeJSON,withLock,sleep} from '../src/util.mjs';
import {defaults,parseEnv,validateConfig,loadConfig,projectFor} from '../src/config.mjs';
import {inventory,metadata,revisionFingerprint} from '../src/documents.mjs';
import {routeQuestions} from '../src/questions.mjs';
import {chooseRoute,routeContext} from '../src/policy.mjs';
import {eventInput,delegation,rewrite,hookMatchers,isDelegation} from '../src/adapters.mjs';
import {SessionStore} from '../src/state.mjs';
import {handleHook} from '../src/hooks.mjs';
import {fixture,event,answer,mockClient,confirmedConfig} from './helpers.mjs';

test('canonical hashes ignore key order',()=>assert.equal(hash({b:1,a:2}),hash({a:2,b:1})));
test('path containment does not confuse prefix siblings',()=>{assert.ok(within('/a','/a/x'));assert.ok(!within('/a','/ab'));assert.ok(!within('/a','/a/../b'));});
test('redaction masks common keys and authorization without claiming complete DLP',()=>{const x=redact('api_key=abc Bearer abcdef sk-abcdefghijk');assert.ok(!x.includes('sk-abcdefghijk'));assert.ok(!x.includes('Bearer abcdef'));});
test('env parser rejects shell syntax instead of executing or silently accepting it',()=>assert.throws(()=>parseEnv('X=$(touch /tmp/nope)'),/SHELL_EXPANSION/));
test('env parser handles comments and quoted values',()=>assert.deepEqual(parseEnv('# hi\nA="hello world"\nB='),{A:'hello world',B:''}));
for(const v of ['bad line','export A=hello','A="unterminated'])test('invalid env rejected: '+v,()=>assert.throws(()=>parseEnv(v)));
for(const [key,value]of [['mode','fake'],['timeoutMs',0],['timeoutMs',6000],['cacheTtlMs',-1],['maxDocuments',33],['minimumConfidence',2],['stateDir','relative'],['allowedProjects',['relative']],['requiredDocuments',['../key']],['customAgents','replace'],['schema',2]]){
 test('config rejects '+key+' '+JSON.stringify(value),()=>{const c=confirmedConfig('/tmp/h');c[key]=value;assert.throws(()=>validateConfig(c));});
}
test('env process precedence and blank shell fallback',async t=>{const f=await fixture(t);const file=path.join(f.home,'config.json');await writeJSON(file,f.config);await fs.writeFile(path.join(f.home,'.env'),'TYPESAFE_API_KEY=disk\nJEV_MODE=shadow\n');const x=await loadConfig(file,{TYPESAFE_API_KEY:'process',JEV_MODE:''});assert.equal(x.apiKey,'process');assert.equal(x.config.mode,'shadow');});
test('working-project .env is never loaded',async t=>{const f=await fixture(t);const file=path.join(f.home,'config.json');await writeJSON(file,f.config);await fs.writeFile(path.join(f.project,'.env'),'TYPESAFE_API_KEY=untrusted');assert.equal((await loadConfig(file,{})).apiKey,'');});
test('env symlink rejected',async t=>{const f=await fixture(t);const file=path.join(f.home,'config.json');await writeJSON(file,f.config);await fs.writeFile(path.join(f.root,'key'),'TYPESAFE_API_KEY=secret');await fs.symlink(path.join(f.root,'key'),path.join(f.home,'.env'));await assert.rejects(loadConfig(file,{}));});
test('project whitelist resolves symlinks and chooses most specific root',async t=>{const f=await fixture(t);assert.equal(await projectFor(f.config,f.project),f.project);assert.equal(await projectFor(f.config,f.home),null);await fs.symlink(f.home,path.join(f.project,'escape'));assert.equal(await projectFor(f.config,path.join(f.project,'escape')),null);});
test('inventory includes mandatory files, skips keys, links and hidden env',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.project,'.env'),'secret');await fs.writeFile(path.join(f.project,'secrets.json'),'secret');await fs.symlink(path.join(f.project,'AGENTS.md'),path.join(f.project,'docs','alias.md'));const ds=await inventory(f.project,f.config);assert.ok(ds.some(x=>x.path==='AGENTS.md'&&x.required));assert.ok(ds.every(x=>!x.path.includes('secret')&&!x.path.includes('.env')&&!x.path.includes('alias')));assert.ok(!JSON.stringify(ds).includes('Exact API contract'));});
test('document metadata refuses traversal and external symlink ancestors',async t=>{const f=await fixture(t);await fs.writeFile(path.join(f.home,'doc.md'),'private');await fs.symlink(f.home,path.join(f.project,'foreign'));assert.equal(await metadata(f.project,'../home/doc.md'),null);assert.equal(await metadata(f.project,'foreign/doc.md'),null);});
test('document changes invalidate revision cache key',async t=>{const f=await fixture(t);const a=await revisionFingerprint(f.project,await inventory(f.project,f.config));await fs.appendFile(path.join(f.project,'docs','api.md'),'new contract');const b=await revisionFingerprint(f.project,await inventory(f.project,f.config));assert.notEqual(a,b);});
for(const [role,complexity,risk,tier]of [['plan','small','normal','strategic'],['research','small','normal','light'],['documentation','small','normal','light'],['review','small','normal','standard'],['implement','small','normal','light'],['implement','bounded','normal','light'],['implement','broad','normal','standard'],['implement','small','sensitive','standard']]){
 test(`routing policy ${role}/${complexity}/${risk}`,()=>{const c=confirmedConfig('/tmp/h');const q=routeQuestions([]);const route=chooseRoute(answer(q,{role,complexity,risk}),{kind:'general-purpose'},[],c,'claude');assert.equal(route.tier,tier);});
}
test('low confidence does not mean high probability of coding success; it prevents light downgrade',()=>{const c=confirmedConfig('/tmp/h');const q=routeQuestions([]);assert.equal(chooseRoute(answer(q,{complexity:'small',confidence:0.1}),{kind:'general-purpose'},[],c,'codex').tier,'standard');});
test('mandatory docs survive a negative Jev relevance decision',()=>{const c=confirmedConfig('/tmp/h');const docs=[{path:'AGENTS.md',required:true},{path:'unused.md',required:false}];const route=chooseRoute(answer(routeQuestions(docs)),{kind:'general-purpose'},docs,c,'claude');assert.deepEqual(route.documents,[{path:'AGENTS.md',required:true}]);});
test('oversized routing packet fails rather than truncating required evidence',()=>{const c=confirmedConfig('/tmp/h');c.maxContextChars=300;assert.throws(()=>routeContext({documents:[{path:'a'.repeat(500),required:true}]},c));});
test('Claude rewrite preserves tools, background flag, original prompt and default permission path',async t=>{const f=await fixture(t);const e=eventInput(event(f.project),'claude');const d=delegation(e);const route=chooseRoute(answer(routeQuestions([])),d,[],f.config,'claude');const out=rewrite(e,d,route,'route-context',f.config);assert.equal(out.hookSpecificOutput.permissionDecision,undefined);assert.equal(out.hookSpecificOutput.updatedInput.run_in_background,true);assert.ok(out.hookSpecificOutput.updatedInput.prompt.startsWith(d.text));assert.equal(e.input.model,undefined);});
test('Codex rewrite changes only model/profile/message; task and fork settings survive',async t=>{const f=await fixture(t);const e=eventInput(event(f.project,'codex'),'codex');const route=chooseRoute(answer(routeQuestions([])),delegation(e),[],f.config,'codex');const o=rewrite(e,delegation(e),route,'route',f.config);assert.equal(o.hookSpecificOutput.permissionDecision,'allow');assert.equal(o.hookSpecificOutput.updatedInput.task_name,'toggle');assert.equal(o.hookSpecificOutput.updatedInput.fork_turns,'none');assert.equal(o.continue,undefined);});
test('lookalike MCP tools are not classified as native spawn',()=>assert.equal(isDelegation({runtime:'codex',tool_name:'mcp__evil__spawn_agent'}),false));
test('matcher includes native namespace aliases',()=>assert.ok(new RegExp(hookMatchers('codex')).test('agents.spawn_agent')));
test('Codex collaboration name is exact and is routed only after separate rewrite consent',async t=>{
 const matcher=new RegExp(hookMatchers('codex'));
 for(const name of ['collaborationspawn_agent','spawn_agent','agents.spawn_agent','multi_agent.spawn_agent']){
  assert.ok(matcher.test(name));assert.ok(isDelegation({runtime:'codex',tool_name:name}));
 }
 for(const name of ['mcp__evil__collaborationspawn_agent','collaborationspawn_agent_extra','other.collaborationspawn_agent']){
  assert.ok(!matcher.test(name));assert.ok(!isDelegation({runtime:'codex',tool_name:name}));
 }
 const f=await fixture(t),e=event(f.project,'codex');e.tool_name='collaborationspawn_agent';const client=mockClient();
 let out=await handleHook(e,'codex',{config:f.config,client});
 assert.equal(out.hookSpecificOutput.updatedInput,undefined);
 assert.match(out.hookSpecificOutput.additionalContext,/UNCHANGED/);
 assert.ok(client.count>0);
 f.config.safety.codexCollaborationRewriteApproved=true;
 out=await handleHook({...e,tool_use_id:'approved'},'codex',{config:f.config,client});
 assert.equal(out.hookSpecificOutput.updatedInput.task_name,'toggle');
 assert.equal(out.hookSpecificOutput.permissionDecision,'allow');
 await handleHook({...e,hook_event_name:'PostToolUse',tool_response:{task_name:'toggle'}},'codex',{config:f.config,client});
 const s=await new SessionStore(f.config,f.project,'codex',e.session_id).snapshot();
 assert.ok(s.tasks.some(x=>x.status==='spawn_acknowledged'));
});
test('Codex collaboration cannot rewrite unsupported items or unfamiliar input fields',async t=>{
 const f=await fixture(t),client=mockClient();f.config.safety.codexCollaborationRewriteApproved=true;
 const e=event(f.project,'codex');e.tool_name='collaborationspawn_agent';e.tool_input.items=[{type:'image'}];
 const o=await handleHook(e,'codex',{config:f.config,client});assert.equal(o.hookSpecificOutput.updatedInput,undefined);assert.equal(client.count,0);
 delete e.tool_input.items;e.tool_input.unreviewed=true;
 const q=await handleHook(e,'codex',{config:f.config,client});assert.equal(q.hookSpecificOutput.updatedInput,undefined);assert.equal(client.count,0);
});
test('off and non-whitelisted projects never call Jev or modify tools',async t=>{const f=await fixture(t);const c=mockClient();f.config.mode='off';assert.deepEqual(await handleHook(event(f.project),'claude',{config:f.config,client:c}),{});f.config.mode='active';assert.deepEqual(await handleHook(event(f.home),'claude',{config:f.config,client:c}),{});assert.equal(c.count,0);});
test('shadow route evaluates but gives no model-visible guidance or rewrite',async t=>{const f=await fixture(t);f.config.mode='shadow';const client=mockClient();assert.deepEqual(await handleHook(event(f.project),'claude',{config:f.config,client}),{});assert.equal(client.count,2);});
test('specialized custom agents preserve their identity, model and tools without Jev call',async t=>{const f=await fixture(t);const e=event(f.project);e.tool_input.subagent_type='security-auditor';e.tool_input.model='special-model';const client=mockClient();assert.deepEqual(await handleHook(e,'claude',{config:f.config,client}),{});assert.equal(client.count,0);});
test('rich Codex items pass through instead of losing attachments',async t=>{const f=await fixture(t);const e=event(f.project,'codex');e.tool_input.items=[{type:'image',image_url:'private'}];const o=await handleHook(e,'codex',{config:f.config,client:mockClient()});assert.equal(o.hookSpecificOutput.updatedInput,undefined);});
test('same native tool id is idempotent and appended routing is not duplicated',async t=>{const f=await fixture(t);const client=mockClient();const e=event(f.project);const deps={config:f.config,client};const a=await handleHook(e,'claude',deps);const b=await handleHook(e,'claude',deps);const c=await handleHook({...e,tool_input:a.hookSpecificOutput.updatedInput},'claude',deps);assert.deepEqual(a,b);assert.deepEqual(a,c);assert.equal(client.count,2);});
test('concurrent identical native invocations route once',async t=>{const f=await fixture(t);const client=mockClient();const deps={config:f.config,client};const outputs=await Promise.all(Array.from({length:8},()=>handleHook(event(f.project),'claude',deps)));assert.equal(client.count,2);assert.ok(outputs.every(o=>o.hookSpecificOutput?.updatedInput));});
test('stored decisions never persist the original task prompt',async t=>{const f=await fixture(t);const e=event(f.project);e.tool_input.prompt='Implement UNIQUE_PRIVATE_TASK_TEXT';await handleHook(e,'claude',{config:f.config,client:mockClient()});const s=new SessionStore(f.config,f.project,'claude',e.session_id);const text=await fs.readFile(s.taskFile(e.tool_use_id),'utf8');assert.ok(!text.includes('UNIQUE_PRIVATE_TASK_TEXT'));});
test('tool id reused for different input is not silently applied to new work',async t=>{const f=await fixture(t);const deps={config:f.config,client:mockClient()};const e=event(f.project);await handleHook(e,'claude',deps);e.tool_input.prompt='A different request';const o=await handleHook(e,'claude',deps);assert.equal(o.hookSpecificOutput.updatedInput,undefined);assert.match(o.hookSpecificOutput.additionalContext,/REUSED/);});
for(const failureMode of ['native','block'])test('Jev failure policy '+failureMode,async t=>{const f=await fixture(t);f.config.failureMode=failureMode;const client={evaluate(){throw Object.assign(new Error(),{code:'JEV_TIMEOUT'});}};const o=await handleHook(event(f.project),'claude',{config:f.config,client});assert.equal(o.hookSpecificOutput.permissionDecision,failureMode==='block'?'deny':undefined);assert.equal(o.hookSpecificOutput.updatedInput,undefined);});
test('session resume restores observations without any API call',async t=>{const f=await fixture(t);const client=mockClient();const deps={config:f.config,client};const e=event(f.project);await handleHook(e,'claude',deps);await handleHook({...e,hook_event_name:'PreCompact'},'claude',deps);const o=await handleHook({...e,hook_event_name:'SessionStart',source:'compact'},'claude',deps);assert.match(o.hookSpecificOutput.additionalContext,/route_requested/);assert.match(o.hookSpecificOutput.additionalContext,/not authoritative/);assert.equal(client.count,2);});
test('spawn acknowledgement is not marked implementation complete',async t=>{const f=await fixture(t);const deps={config:f.config,client:mockClient()};const e=event(f.project,'codex');await handleHook(e,'codex',deps);await handleHook({...e,hook_event_name:'PostToolUse',tool_response:{task_name:'toggle'}},'codex',deps);const s=await new SessionStore(f.config,f.project,'codex',e.session_id).snapshot();assert.equal(s.tasks[0].status,'spawn_acknowledged');assert.equal(s.tasks[0].agentId,undefined);});
test('native SubagentStop is an observation, not a successful test result',async t=>{const f=await fixture(t);const e=event(f.project);const deps={config:f.config,client:mockClient()};await handleHook({...e,hook_event_name:'SubagentStart',agent_id:'child',agent_type:'jev_worker_standard'},'claude',deps);await handleHook({...e,hook_event_name:'SubagentStop',agent_id:'child',last_assistant_message:'all passed'},'claude',deps);const s=await new SessionStore(f.config,f.project,'claude',e.session_id).snapshot();assert.equal(s.agents[0].status,'stop_observed_not_verified');});
test('SubagentStart receives worker guidance rather than a replacement Main role',async t=>{const f=await fixture(t);const o=await handleHook({...event(f.project),hook_event_name:'SubagentStart',agent_id:'a'},'claude',{config:f.config,client:mockClient()});assert.match(o.hookSpecificOutput.additionalContext,/native subagent/);});
test('failure classification advises Main without spawning or retrying anything',async t=>{const f=await fixture(t);const o=await handleHook({...event(f.project),hook_event_name:'PostToolUseFailure',error:'provider refused'},'claude',{config:f.config,client:mockClient()});assert.match(o.hookSpecificOutput.additionalContext,/environment/);assert.match(o.hookSpecificOutput.additionalContext,/No automatic retry/);});
test('optional document read advice never denies reading or rewrites the file',async t=>{const f=await fixture(t);f.config.readAdvice=true;const o=await handleHook({...event(f.project),tool_name:'Read',tool_input:{file_path:path.join(f.project,'docs','api.md')}},'claude',{config:f.config,client:mockClient({kind:'api_schema',reading:'exact'})});assert.match(o.hookSpecificOutput.additionalContext,/api_schema/);assert.equal(o.hookSpecificOutput.permissionDecision,undefined);assert.equal(o.hookSpecificOutput.updatedInput,undefined);});
test('secret files never enter document advice API calls',async t=>{const f=await fixture(t);f.config.readAdvice=true;const client=mockClient();await handleHook({...event(f.project),tool_name:'Read',tool_input:{file_path:path.join(f.project,'.env')}},'claude',{config:f.config,client});assert.equal(client.count,0);});
test('concurrent event writes do not lose native lifecycle records',async t=>{const f=await fixture(t);const s=new SessionStore(f.config,f.project,'claude','x');await Promise.all(Array.from({length:40},(_,i)=>s.record('agent_started',{agentId:String(i)})));assert.equal((await s.events()).length,40);});
test('state identifiers cannot escape state directory',async t=>{const f=await fixture(t);const s=new SessionStore(f.config,f.project,'claude','../../escape');await s.record('test');assert.ok(within(f.config.stateDir,s.dir));assert.ok(!s.dir.includes('../'));});
test('session data files are owner-only',async t=>{const f=await fixture(t);const s=new SessionStore(f.config,f.project,'claude','x');await s.record('test');const files=await fs.readdir(path.join(s.dir,'events'));assert.equal((await fs.stat(path.join(s.dir,'events',files[0]))).mode&0o777,0o600);});
test('unrecognized events are no-ops',async t=>{const f=await fixture(t);assert.deepEqual(await handleHook({...event(f.project),hook_event_name:'UnknownFutureHook'},'claude',{config:f.config,client:mockClient()}),{});});
test('Claude forced-model setting is detected instead of claiming a route was applied',async t=>{
 const f=await fixture(t),client=mockClient();const out=await handleHook(event(f.project),'claude',{config:f.config,client,runtimeEnv:{CLAUDE_CODE_SUBAGENT_MODEL_FORCE:'1'}});
 assert.equal(client.count,0);assert.equal(out.hookSpecificOutput.updatedInput,undefined);assert.match(out.hookSpecificOutput.additionalContext,/FORCED_MODEL/);
});
test('bounded restore context keeps valid JSON rather than cutting a task record in half',async t=>{
 const f=await fixture(t);const s=new SessionStore(f.config,f.project,'claude','x');
 for(let i=0;i<20;i++)await s.record('agent_started',{agentId:'agent-'+i+'-'.repeat(120),agentType:'worker'});
 const text=await s.restoreContext();assert.ok(text.length<=f.config.maxContextChars);const index=text.indexOf('{');assert.ok(index>0);assert.doesNotThrow(()=>JSON.parse(text.slice(index)));
});
