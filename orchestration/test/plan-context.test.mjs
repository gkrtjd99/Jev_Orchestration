import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {hash,writeJSON,VERSION} from '../src/util.mjs';
import {defaults,loadConfig,validateConfig} from '../src/config.mjs';
import {install} from '../src/install.mjs';
import {mockClient,child} from './helpers.mjs';
import {planContext} from '../src/plan-context.mjs';
import {handleHook} from '../src/hooks.mjs';
import {SessionStore} from '../src/state.mjs';
import {fixture,event,answer} from './helpers.mjs';

const goal='Implement a safe native delegation fix.';
const plan={schema:1,goalHash:hash(goal),summary:'Fix the observed Codex spawn boundary, then independently review it.',
  acceptance:'Check exact tool names, preserve explicit settings, and run regression tests.',
  delegations:['Inspect native event shape','Implement safe adapter','Review permission contract']};
async function setup(t){
  const f=await fixture(t);await fs.mkdir(path.join(f.project,'.jev'));
  await writeJSON(path.join(f.project,'.jev','routing-plan.json'),plan);
  f.config.safety.sharePlanContext=true;
  const prompt={...event(f.project),hook_event_name:'UserPromptSubmit',prompt:goal};
  await handleHook(prompt,'claude',{config:f.config});
  return f;
}
function capture(){const calls=[];return {calls,async evaluate(state,questions){calls.push(state);return {response:answer(questions),cached:false,latencyMs:0};}};}

test('explicit goal-bound plan reaches classification and selection, not the native child',async t=>{
  const f=await setup(t),client=capture();f.config.safety.retainPromptText=true;
  const result=await handleHook(event(f.project),'claude',{config:f.config,client});
  assert.ok(result.hookSpecificOutput.updatedInput);
  assert.ok(client.calls.length>=1);
  assert.deepEqual(client.calls[0].plan,{summary:plan.summary,acceptance:plan.acceptance,delegations:plan.delegations});
  assert.equal(client.calls[0].promptRevision,plan.goalHash);
  for(const c of client.calls)assert.deepEqual(c.plan,client.calls[0].plan);
  assert.ok(!JSON.stringify(result).includes(plan.summary));
  const store=new SessionStore(f.config,f.project,'claude','session-test');
  assert.ok(!(await fs.readFile(store.taskFile('tool-1'),'utf8')).includes(plan.summary));
});
test('unattributed nested prompts never replace the parent goal or reuse its plan',async t=>{
  const f=await setup(t),client=capture();f.config.safety.retainPromptText=true;
  await handleHook({...event(f.project),hook_event_name:'UserPromptSubmit',prompt:'Unattributed internal worker prompt'},'claude',{config:f.config});
  const s=await new SessionStore(f.config,f.project,'claude','session-test').snapshot();
  assert.equal(s.goalHash,hash(goal));assert.equal(s.goalEligible,false);
  await handleHook(event(f.project),'claude',{config:f.config,client});
  assert.equal(client.calls[0].plan,undefined);
  assert.equal(client.calls[0].parentGoal,undefined);
  assert.equal(client.calls[0].promptRevision,'');
});
test('plan sharing is off by default even when a plan file exists',async t=>{
  const f=await setup(t),client=capture();f.config.safety.sharePlanContext=false;
  await handleHook(event(f.project),'claude',{config:f.config,client});
  assert.equal(client.calls[0].plan,undefined);
});
test('parent goal text requires both sharing and explicit retention',async t=>{
  const f=await fixture(t);f.config.safety.sharePlanContext=true;
  let client=capture();await handleHook({...event(f.project),hook_event_name:'UserPromptSubmit',prompt:goal},'claude',{config:f.config});
  await handleHook(event(f.project),'claude',{config:f.config,client});assert.equal(client.calls[0].parentGoal,undefined);
  f.config.safety.retainPromptText=true;client=capture();
  await handleHook({...event(f.project),hook_event_name:'SessionStart',source:'clear'},'claude',{config:f.config});
  await handleHook({...event(f.project),hook_event_name:'UserPromptSubmit',prompt:goal+' again'},'claude',{config:f.config});
  await handleHook({...event(f.project),tool_use_id:'other'},'claude',{config:f.config,client});
  assert.equal(client.calls[0].parentGoal,goal+' again');
});
test('changed plan invalidates a pending decision rather than reusing it',async t=>{
  const f=await setup(t),client=capture(),e=event(f.project);
  await handleHook(e,'claude',{config:f.config,client});
  await writeJSON(path.join(f.project,'.jev','routing-plan.json'),{...plan,summary:'Revised assignment'});
  const result=await handleHook(e,'claude',{config:f.config,client});
  assert.equal(result.hookSpecificOutput.updatedInput,undefined);
  assert.match(result.hookSpecificOutput.additionalContext,/WORKSPACE_OR_GOAL_CHANGED/);
});
test('unbound, symlinked, world-readable or secret-bearing plans never reach Jev',async t=>{
  const f=await setup(t),file=path.join(f.project,'.jev','routing-plan.json'),client=capture();
  const check=async code=>{const result=await handleHook(event(f.project),'claude',{config:f.config,client});
    assert.equal(client.calls.length,0);assert.match(result.hookSpecificOutput.additionalContext,new RegExp(code));};
  await writeJSON(file,{...plan,goalHash:hash('different')});await check('PLAN_GOAL_MISMATCH');
  await writeJSON(file,plan);await fs.chmod(file,0o644);await check('PLAN_REQUIRES_MODE_600');
  await fs.chmod(file,0o600);await writeJSON(file,{...plan,summary:'api_key=supersecretvalue'});await check('SECRET_GUARD');
  await fs.rm(file);const target=path.join(f.project,'outside.json');await writeJSON(target,plan);await fs.symlink(target,file);
  await assert.rejects(planContext(f.project,plan.goalHash,''),/UNSAFE_PLAN_PATH/);
});
test('Workflow boundary is observed but neither sent to Jev nor rewritten',async t=>{
  const f=await fixture(t),client=capture();const e=event(f.project);
  e.tool_name='Workflow';e.tool_input={script:"await agent('private worker task')"};
  const o=await handleHook(e,'claude',{config:f.config,client});
  assert.equal(client.calls.length,0);assert.equal(o.hookSpecificOutput.updatedInput,undefined);
  assert.match(o.hookSpecificOutput.additionalContext,/cannot route agents started inside Workflow/);
  const s=new SessionStore(f.config,f.project,'claude',e.session_id);
  assert.ok(!(JSON.stringify(await s.events())).includes('private worker task'));
  assert.ok((await s.events()).some(x=>x.type==='workflow_boundary'&&x.routed===false));
});

const workflow=project=>({...event(project),tool_name:'Workflow',tool_input:{script:"await agent('private task')"}});

test('Workflow policy defaults to warning without Jev call',async t=>{
  const f=await fixture(t),client=mockClient();
  assert.equal(defaults(f.home).safety.workflowPolicy,'warn');
  const output=await handleHook(workflow(f.project),'claude',{config:f.config,client});
  assert.equal(client.count,0);
  assert.equal(output.hookSpecificOutput.permissionDecision,undefined);
  assert.match(output.hookSpecificOutput.additionalContext,/cannot route agents started inside Workflow/);
});

test('opt-in active policy denies named and anonymous Workflows before Jev',async t=>{
  const f=await fixture(t),client=mockClient();f.config.safety.workflowPolicy='block';
  for(const [i,input] of [
    {script:"await agent('private task')"},
    {name:'trusted-looking',script:'return {ok:true}'},
    {name:'saved-workflow'},
  ].entries()){
    const e={...workflow(f.project),tool_use_id:'workflow-'+i,tool_input:input};
    const output=await handleHook(e,'claude',{config:f.config,client});
    assert.equal(output.hookSpecificOutput.permissionDecision,'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason,/native Agent\/Task/);
    assert.equal(output.hookSpecificOutput.updatedInput,undefined);
  }
  assert.equal(client.count,0);
  const records=await new SessionStore(f.config,f.project,'claude','session-test').events();
  assert.equal(records.filter(x=>x.type==='workflow_boundary'&&x.blocked).length,3);
  assert.ok(!JSON.stringify(records).includes('private task'));
});

test('Workflow denial is limited to allowed Claude active PreToolUse',async t=>{
  const f=await fixture(t),client=mockClient(),e=workflow(f.project);f.config.safety.workflowPolicy='block';
  for(const mode of ['advisory','shadow','off']){
    f.config.mode=mode;
    const output=await handleHook(e,'claude',{config:f.config,client});
    assert.notEqual(output.hookSpecificOutput?.permissionDecision,'deny');
  }
  f.config.mode='active';
  for(const eventName of ['PostToolUse','PostToolUseFailure']){
    const output=await handleHook({...e,hook_event_name:eventName},'claude',{config:f.config,client});
    assert.notEqual(output.hookSpecificOutput?.permissionDecision,'deny');
  }
  assert.deepEqual(await handleHook(workflow(f.home),'claude',{config:f.config,client}),{});
  assert.equal(client.count,0);
});

test('state write failure cannot turn explicit Workflow denial into warning',async t=>{
  const f=await fixture(t);f.config.safety.workflowPolicy='block';
  const file=path.join(f.root,'not-a-directory');await fs.writeFile(file,'occupied');f.config.stateDir=file;
  const output=await handleHook(workflow(f.project),'claude',{config:f.config,client:mockClient()});
  assert.equal(output.hookSpecificOutput.permissionDecision,'deny');
});

test('a separate native Agent call after Workflow denial can route',async t=>{
  const f=await fixture(t),client=mockClient();f.config.safety.workflowPolicy='block';
  assert.equal((await handleHook(workflow(f.project),'claude',{config:f.config,client})).hookSpecificOutput.permissionDecision,'deny');
  const output=await handleHook(event(f.project),'claude',{config:f.config,client});
  assert.match(output.hookSpecificOutput.updatedInput.subagent_type,/^jev4_/);
  assert.equal(client.count,2);
  // The second call is explicit: a denial does not prove Main retried.
});

test('invalid policy is rejected; installed CLI applies the explicit policy',async t=>{
  const f=await fixture(t);f.config.safety.workflowPolicy='unsafe';
  assert.throws(()=>validateConfig(f.config),/INVALID_WORKFLOW_POLICY/);
  f.config.safety.workflowPolicy='warn';
  const standalone=path.join(f.home,'standalone.json');await writeJSON(standalone,f.config);
  await assert.rejects(loadConfig(standalone,{JEV_WORKFLOW_POLICY:'deny-all'}),/INVALID_JEV_WORKFLOW_POLICY/);
  const envFile=path.join(f.root,'test.env');
  await fs.writeFile(envFile,'JEV_MODE=active\nJEV_ALLOW_EGRESS=false\nJEV_WORKFLOW_POLICY=block\n');
  await install({home:f.home,project:f.project,runtime:'claude',envFile,yes:true});
  const file=path.join(f.home,'.config','jev-hooks','config.json');
  assert.equal((await loadConfig(file,{})).config.safety.workflowPolicy,'block');
  const entry=path.join(f.home,'.local','share','jev-hooks',VERSION,'bin','jev-hook.mjs');
  const result=await child(process.execPath,[entry,'--runtime','claude','--config',file],{
    input:JSON.stringify(workflow(f.project)),env:{PATH:process.env.PATH||''},cwd:f.project,
  });
  assert.equal(result.code,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,'deny');
  const invalid=await child(process.execPath,[entry,'--runtime','claude','--config',file],{
    input:JSON.stringify(workflow(f.project)),env:{PATH:process.env.PATH||'',JEV_WORKFLOW_POLICY:'invalid'},cwd:f.project,
  });
  assert.equal(invalid.code,1);
  assert.deepEqual(JSON.parse(invalid.stdout),{});
  assert.match(invalid.stderr,/INVALID_JEV_WORKFLOW_POLICY/);
});

test('Workflow block does not pretend that an unroutable native fallback was routed',async t=>{
  const f=await fixture(t),client=mockClient();
  f.config.safety.workflowPolicy='block';f.config.safety.allowEgress=false;
  const denied=await handleHook(workflow(f.project),'claude',{config:f.config,client});
  const original=await handleHook(event(f.project),'claude',{config:f.config,client});
  assert.equal(denied.hookSpecificOutput.permissionDecision,'deny');
  assert.equal(original.hookSpecificOutput.updatedInput,undefined);
  assert.match(original.hookSpecificOutput.additionalContext,/EGRESS_NOT_APPROVED/);
  assert.equal(client.count,0);
});
