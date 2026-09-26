import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture,child } from './helpers.mjs';
import { handleHook } from '../src/hooks.mjs';
import { validateControllerPlan,selectControllerProfile,loadControllerPlan } from '../src/controller-plan.mjs';
import { loadControllerStatus } from '../src/controller-status.mjs';
import { profileCatalog } from '../src/catalog.mjs';
import { SessionStore } from '../src/state.mjs';
import { emitTelemetry } from '../src/telemetry.mjs';
import { hookConfig,install } from '../src/install.mjs';
import { hash,VERSION } from '../src/util.mjs';

const goal='Create an accessible dashboard with actual checks.';
const task=(id,phase,change={})=>({id,phase,summary:'Assigned outcome for '+id,acceptance:'Confirm observed checks and actual output.',
  dependencies:[],readPaths:['src'],writePaths:phase==='implement'?['src/app.mjs']:[],risk:'normal',
  complexity:'bounded',reasoning:'routine',uncertain:false,interfacesChanging:false,highLoss:false,
  information:'sufficient',...change});
const plan=()=>({schema:2,goalHash:hash(goal),version:1,summary:'Design task boundaries before coding.',
  tasks:[task('find','research'),task('build','implement',{dependencies:['find']})]});
const event=(f,eventName,more={})=>({hook_event_name:eventName,session_id:'controller-session',cwd:f.project,...more});
const agent=(f,id,marker,more={})=>event(f,'PreToolUse',{tool_use_id:id,tool_name:'Agent',
  tool_input:{description:marker,prompt:'Untrusted extra request from Main',subagent_type:'general-purpose'},...more});
const denied=x=>assert.equal(x.hookSpecificOutput?.permissionDecision,'deny');
async function setup(t){
  const f=await fixture(t);f.config.mode='controller';f.config.safety.allowEgress=false;
  await fs.mkdir(path.join(f.project,'.jev'),{mode:0o700});
  await handleHook(event(f,'UserPromptSubmit',{prompt:goal}),'claude',{config:f.config,runtimeEnv:{}});
  return f;
}
async function savePlan(f,value=plan()){
  const file=path.join(f.project,'.jev','controller-plan.json');
  await fs.writeFile(file,JSON.stringify(value),{mode:0o600});
  return {file,revision:hash(await fs.readFile(file,'utf8'))};
}

test('controller plan rejects reserved paths, parent/child concurrent writes and cycles',()=>{
  for(const p of ['.git/hooks/pre-commit','.git','.claude','.jev/controller-status.json','src/../secrets']){
    const value=plan();value.tasks[1].writePaths=[p];assert.throws(()=>validateControllerPlan(value,value.goalHash),/UNSAFE/);
  }
  const conflict=plan();conflict.tasks=[task('alpha','implement',{writePaths:['src']}),
    task('beta','implement',{writePaths:['src/app.mjs']})];
  assert.throws(()=>validateControllerPlan(conflict,conflict.goalHash),/PARALLEL_WRITE/);
  const cycle=plan();cycle.tasks[0].dependencies=['build'];
  assert.throws(()=>validateControllerPlan(cycle,cycle.goalHash),/CYCLIC/);
});

test('selector applies confirmed-only and sensitive quality floor',async t=>{
  const x=await fixture(t),r=x.config.registry;
  const cases=[
    [task('scan','research'),'light','high'],
    [task('scan','research',{risk:'sensitive'}),'standard','xhigh'],
    [task('code','implement',{complexity:'small',risk:'sensitive'}),'standard','xhigh'],
    [task('scan','research',{uncertain:true}),'standard','xhigh'],
    [task('code','implement',{complexity:'small',uncertain:true}),'standard','xhigh'],
    [task('architect','plan',{reasoning:'novel',complexity:'broad'}),'strategic','xhigh'],
    [task('trace','debug',{reasoning:'deep'}),'standard','max'],
    [task('trace','debug',{reasoning:'deep',complexity:'broad'}),'standard','xhigh']
  ];
  for(const [item,slot,effort]of cases){const d=selectControllerProfile(r,item);assert.equal(d.profile.slot,slot);assert.equal(d.profile.effort,effort);}
  r.models.find(m=>m.runtime==='claude'&&m.slot==='light').availability='declared';
  assert.equal(selectControllerProfile(r,task('scan','research')).reason,'confirmed_profile_unavailable');
});

test('bootstrap plan selects verified Astra profile, preserves native permission, and does not call Jev',async t=>{
  const f=await setup(t),input=agent(f,'boot','JEV:bootstrap:plan');
  let calls=0;const output=await handleHook(input,'claude',{config:f.config,client:{async evaluate(){calls++;throw Error('unexpected');}},runtimeEnv:{}});
  const updated=output.hookSpecificOutput.updatedInput;
  assert.match(updated.subagent_type,/^jev4_plan_strategic_xhigh_/);
  assert.equal(updated.prompt,input.tool_input.prompt);
  assert.equal(updated.model,undefined);assert.equal(output.hookSpecificOutput.permissionDecision,undefined);
  assert.equal(calls,0);
  const recorded=await new SessionStore(f.config,await fs.realpath(f.project),'claude','controller-session').getTask('boot');
  assert.equal(recorded.taskId,'bootstrap-plan');
});

test('Main work and Workflow are denied, worker tool with reported agent ID is unchanged',async t=>{
  const f=await setup(t);
  for(const name of ['Bash','Glob','WebSearch','mcp__other__write','Workflow']){
    denied(await handleHook(event(f,'PreToolUse',{tool_name:name,tool_use_id:name,tool_input:{command:'ls'}}),
      'claude',{config:f.config,runtimeEnv:{}}));
  }
  assert.deepEqual(await handleHook(event(f,'PreToolUse',{tool_name:'Read',agent_id:'worker-1',
    tool_input:{file_path:path.join(f.project,'docs/api.md')}}),'claude',{config:f.config,runtimeEnv:{}}),{});
  const matcher=new RegExp(hookConfig('claude','/hook','/config',process.execPath,false,true).hooks.PreToolUse[0].matcher);
  assert.ok(matcher.test('mcp__other__write')&&matcher.test('Bash'));
});

test('private plan artifact is accessible to Main, symlinked plan and non-private directory are denied',async t=>{
  const f=await setup(t),target=path.join(f.project,'.jev','controller-plan.json');
  const access=()=>handleHook(event(f,'PreToolUse',{tool_name:'Write',tool_input:{file_path:target,content:'{}'}}),
    'claude',{config:f.config,runtimeEnv:{}});
  assert.deepEqual(await access(),{});
  await fs.symlink(path.join(f.project,'docs','api.md'),target);denied(await access());
  await fs.rm(target);if(process.platform!=='win32'){
    await fs.chmod(path.join(f.project,'.jev'),0o755);denied(await access());
  }
});

test('plan packet replaces Main free text and dependency without acceptance is denied',async t=>{
  const f=await setup(t);await savePlan(f);
  const first=await handleHook(agent(f,'route-find','JEV:find'),'claude',{config:f.config,runtimeEnv:{}});
  const packet=first.hookSpecificOutput.updatedInput.prompt;
  assert.match(packet,/"taskId":"find"/);assert.match(packet,/"acceptance"/);
  assert.doesNotMatch(packet,/Untrusted extra request/);
  assert.match(first.hookSpecificOutput.updatedInput.subagent_type,/^jev4_research_light_high_/);
  const second=await handleHook(agent(f,'route-build','JEV:build'),'claude',{config:f.config,runtimeEnv:{}});
  denied(second);assert.match(second.hookSpecificOutput.permissionDecisionReason,/Dependencies/);
  assert.equal((await loadControllerPlan(await fs.realpath(f.project),hash(goal))).plan.tasks.length,2);
});

test('Main acceptance requires matching revision, native start and stop; still not objective proof',async t=>{
  const f=await setup(t),saved=await savePlan(f),deps={config:f.config,runtimeEnv:{}};
  const first=agent(f,'route-find','JEV:find');await handleHook(first,'claude',deps);
  const statusFile=path.join(f.project,'.jev','controller-status.json');
  const status={schema:1,goalHash:hash(goal),planRevision:saved.revision,
    accepted:[{taskId:'find',toolUseId:'route-find',agentId:'agent-7',evidenceHash:hash('report-file')}]};
  await fs.writeFile(statusFile,JSON.stringify(status),{mode:0o600});
  denied(await handleHook(agent(f,'build-1','JEV:build'),'claude',deps));
  await handleHook(event(f,'SubagentStop',{agent_id:'agent-7',last_assistant_message:'Premature stop.'}),'claude',deps);
  await new Promise(resolve=>setTimeout(resolve,4));
  await handleHook({...first,hook_event_name:'PostToolUse',tool_response:{agent_id:'agent-7'}},'claude',deps);
  denied(await handleHook(agent(f,'build-before-start','JEV:build'),'claude',deps));
  await handleHook(event(f,'SubagentStart',{agent_id:'agent-7'}),'claude',deps);
  denied(await handleHook(agent(f,'build-before-stop','JEV:build'),'claude',deps));
  await handleHook(event(f,'SubagentStop',{agent_id:'agent-7',last_assistant_message:'I think checks passed.'}),'claude',deps);
  const accepted=await handleHook(agent(f,'build-2','JEV:build'),'claude',deps);
  assert.match(accepted.hookSpecificOutput.updatedInput.prompt,/"taskId":"build"/);
  assert.match(accepted.hookSpecificOutput.updatedInput.prompt,/"writePaths":\["src\/app.mjs"\]/);
  const state=await loadControllerStatus(await fs.realpath(f.project),hash(goal),saved.revision,plan(),
    new SessionStore(f.config,await fs.realpath(f.project),'claude','controller-session'));
  assert.equal(state.verification,'main_attested_worker_observed_not_independently_checked');
  await fs.writeFile(saved.file,JSON.stringify({...plan(),version:2}));
  denied(await handleHook(agent(f,'build-3','JEV:build'),'claude',deps));
});

test('synchronous Agent stop before PostToolUse still permits goal-bound dependency acceptance',async t=>{
  const f=await setup(t),saved=await savePlan(f),deps={config:f.config,runtimeEnv:{}};
  const first=agent(f,'route-find','JEV:find');await handleHook(first,'claude',deps);
  const status={schema:1,goalHash:hash(goal),planRevision:saved.revision,
    accepted:[{taskId:'find',toolUseId:'route-find',agentId:'agent-7',evidenceHash:hash('checked-artifact')}]};
  await fs.writeFile(path.join(f.project,'.jev','controller-status.json'),JSON.stringify(status),{mode:0o600});
  await handleHook(event(f,'SubagentStart',{agent_id:'agent-7'}),'claude',deps);
  await handleHook(event(f,'SubagentStop',{agent_id:'agent-7',last_assistant_message:'Checked.'}),'claude',deps);
  denied(await handleHook(agent(f,'build-before-post','JEV:build'),'claude',deps));
  await handleHook({...first,hook_event_name:'PostToolUse',tool_response:{agentId:'agent-7'}},'claude',deps);
  const accepted=await handleHook(agent(f,'build-after-post','JEV:build'),'claude',deps);
  assert.match(accepted.hookSpecificOutput.updatedInput.prompt,/"taskId":"build"/);
});

test('a second unattributed prompt invalidates goal provenance rather than reusing old plan',async t=>{
  const f=await setup(t);await savePlan(f);const deps={config:f.config,runtimeEnv:{}};
  await handleHook(event(f,'UserPromptSubmit',{prompt:'A different goal'}),'claude',deps);
  denied(await handleHook(agent(f,'route','JEV:find'),'claude',deps));
});

test('malformed plan, stale profile and reused tool ID deny rather than falling back to native',async t=>{
  const f=await setup(t),deps={config:f.config,runtimeEnv:{}};
  await fs.writeFile(path.join(f.project,'.jev','controller-plan.json'),'{oops');
  denied(await handleHook(agent(f,'bad','JEV:find'),'claude',deps));
  await savePlan(f);
  const first=await handleHook(agent(f,'good','JEV:find'),'claude',deps);assert.ok(first.hookSpecificOutput.updatedInput);
  denied(await handleHook(agent(f,'good','JEV:find'),'claude',deps));
  const p=profileCatalog(f.config.registry,'claude').find(x=>x.role==='research'&&x.slot==='light'&&x.effort==='high');
  await fs.appendFile(f.config.installedProfiles.claude[p.profileId].path,'tampered');
  denied(await handleHook(agent(f,'stale','JEV:find'),'claude',deps));
});

test('Jev critique is opt-in, nonbinding, and cannot override the chosen profile',async t=>{
  const f=await setup(t);await savePlan(f);
  f.config.safety.allowEgress=true;f.config.safety.sharePlanContext=true;
  const client={async evaluate(_state,q){return {response:{answers:Object.fromEntries(Object.keys(q).map(k=>
    [k,{type:'noul',noul:.9}]))},cached:false};}};
  const result=await handleHook(agent(f,'advised','JEV:find'),'claude',
    {config:f.config,apiKey:'test-key',client,runtimeEnv:{JEV_CONTROLLER_CRITIQUE:'true'}});
  assert.match(result.hookSpecificOutput.updatedInput.subagent_type,/^jev4_research_light_high_/);
  assert.match(result.hookSpecificOutput.additionalContext,/nonbinding/);
});

test('installed CLI observes Main work and selects a native controller profile',async t=>{
  const f=await fixture(t),registryFile=path.join(f.root,'confirmed-registry.json');
  await fs.writeFile(registryFile,JSON.stringify(f.config.registry));
  const installation=await install({home:f.home,project:f.project,runtime:'claude',mode:'controller',
    registryFile,yes:true});
  assert.equal(installation.applied,true);
  const confFile=path.join(f.home,'.config','jev-hooks','config.json');
  const config=JSON.parse(await fs.readFile(confFile,'utf8'));
  const entry=path.join(f.home,'.local','share','jev-hooks',VERSION,'bin','jev-hook.mjs');
  const invoke=async input=>{
    const run=await child(process.execPath,[entry,'--runtime','claude','--config',confFile],
      {input:JSON.stringify(input),cwd:f.project});
    assert.equal(run.code,0,run.stderr);return JSON.parse(run.stdout);
  };
  assert.equal(config.mode,'controller');
  await invoke(event(f,'UserPromptSubmit',{prompt:goal}));
  denied(await invoke(event(f,'PreToolUse',{tool_name:'Bash',tool_use_id:'direct',tool_input:{command:'ls'}})));
  const routed=await invoke(agent(f,'cli-boot','JEV:bootstrap:plan'));
  assert.match(routed.hookSpecificOutput.updatedInput.subagent_type,/^jev4_plan_strategic_xhigh_/);
  const native=JSON.parse(await fs.readFile(path.join(f.home,'.claude','settings.json'),'utf8'));
  assert.ok(new RegExp(native.hooks.PreToolUse.at(-1).matcher).test('Bash'));
});

function fields(data){
  let offset=0;
  function number(){let n=0,power=1,byte;do{byte=data[offset++];if(byte===undefined)throw Error('truncated varint');
    n+=(byte&127)*power;power*=128;}while(byte&128);return n;}
  const rows=[];
  while(offset<data.length){const key=number(),id=Math.floor(key/8),wire=key%8;
    if(wire===2){const len=number();rows.push({id,wire,value:data.subarray(offset,offset+len)});offset+=len;}
    else if(wire===0)rows.push({id,wire,value:number()});
    else if(wire===1){rows.push({id,wire,value:data.subarray(offset,offset+8)});offset+=8;}
    else throw Error('unexpected wire '+wire);
    if(offset>data.length)throw Error('truncated payload');
  }
  return rows;
}
const value=(rows,id)=>rows.find(x=>x.id===id)?.value;

test('OTLP exporter sends protobuf with no source text and detects partial rejection',async()=>{
  const env={JEV_OTEL_ENABLED:'true',JEV_OTEL_PROJECT_ID:'123e4567-e89b-42d3-a456-426614174000',
    JEV_OTEL_INGEST_TOKEN:'test-ingest-token'};
  let sent;
  const fetchImpl=async(_url,init)=>{sent=init;return new Response(Buffer.alloc(0),{status:200});};
  const result=await emitTelemetry(env,'/project','session','route_selected',
    {phase:'research',reason:'password=do-not-send',plan_version:2,task_hash:hash('identifier'),task:'source text'},fetchImpl);
  assert.equal(result.sent,true);assert.equal(sent.headers['Content-Type'],'application/x-protobuf');
  assert.ok(Buffer.isBuffer(sent.body));
  assert.ok(sent.body.includes(Buffer.from('agentotel.project.id')));
  assert.ok(!sent.body.includes(Buffer.from('source text'))&&!sent.body.includes(Buffer.from('do-not-send')));
  const request=fields(sent.body),resourceSpan=fields(value(request,1));
  const resource=fields(value(resourceSpan,1)),scopeSpan=fields(value(resourceSpan,2));
  const span=fields(value(scopeSpan,2)),attrs=span.filter(x=>x.id===9).map(x=>fields(x.value));
  assert.equal(value(span,1).length,16);assert.equal(value(span,2).length,8);
  assert.equal(value(span,4).length,8);assert.equal(value(span,5).toString(),'jev.route_selected');
  assert.ok(attrs.some(x=>value(x,1)?.toString()==='jev.plan_version'&&
    value(fields(value(x,2)),3)===2));
  const resourceAttrs=resource.filter(x=>x.id===1).map(x=>fields(x.value));
  assert.ok(resourceAttrs.some(x=>value(x,1)?.toString()==='agentotel.project.id'&&
    value(fields(value(x,2)),1)?.toString()===env.JEV_OTEL_PROJECT_ID));
  assert.equal((await emitTelemetry(env,'/project','session','route_selected',{},
    async()=>new Response(Buffer.from([10,2,8,1]),{status:200}))).sent,false);
  assert.equal((await emitTelemetry(env,'/project','session','route_selected',{},
    async()=>new Response(Buffer.from([10,7,18,3,98,97,100,8,1]),{status:200}))).sent,false);
  assert.equal((await emitTelemetry(env,'/project','session','route_selected',{},
    async()=>new Response(Buffer.from([10,7,18,3,98,97,100,8,0]),{status:200}))).sent,true);
  let errorBody;
  await emitTelemetry(env,'/project','session','delegation_observed',{result:'spawn_failed'},
    async(_url,init)=>{errorBody=init.body;return new Response(Buffer.alloc(0),{status:200});});
  const errorSpan=fields(value(fields(value(fields(errorBody),1)),2));
  const errorSpanFields=fields(value(errorSpan,2));
  assert.equal(value(fields(value(errorSpanFields,15)),2),2);
  assert.equal((await emitTelemetry({...env,JEV_OTEL_ENDPOINT:'not-a-url'},'/p','s','session_started')).sent,false);
  assert.equal((await emitTelemetry({...env,JEV_OTEL_ENDPOINT:'http://127.0.0.1:9000'},'/p','s','session_started')).sent,false);
});
