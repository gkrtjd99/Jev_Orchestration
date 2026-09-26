import path from 'node:path';
import fs from 'node:fs/promises';
import { isDelegation,delegation,contextOutput,denyOutput,rewrite } from './adapters.mjs';
import { loadControllerPlan,selectControllerProfile,bootstrapTask } from './controller-plan.mjs';
import { assertInstalledProfile } from './profiles.mjs';
import { emitTelemetry } from './telemetry.mjs';
import { critiqueControllerTask } from './controller-critique.mjs';
import { loadControllerStatus } from './controller-status.mjs';
import { hash, withLock } from './util.mjs';

const planTools=new Set(['Read','Edit','Write']);
const scheduleTools=new Set(['TaskOutput','TaskGet','TaskList','TaskStop','SendMessage','AskUserQuestion','TodoWrite']);
export const controllerManagedTool=e=>e.runtime==='claude'&&typeof e.tool_name==='string';

async function planArtifact(e,project){
  if(!planTools.has(e.tool_name))return false;
  const target=e.input?.file_path;
  const dir=path.join(project,'.jev');
  if(typeof target!=='string')return false;
  let file,parent;
  try{
    const absolute=path.resolve(e.cwd,target);
    file=path.join(await fs.realpath(path.dirname(absolute)),path.basename(absolute));
    parent=await fs.lstat(dir);
  }catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(!['controller-plan.json','controller-status.json'].some(name=>file===path.join(dir,name)))return false;
  if(!parent.isDirectory()||parent.isSymbolicLink())return false;
  if(process.platform!=='win32'&&((parent.mode&0o077)!==0||
    typeof process.getuid==='function'&&parent.uid!==process.getuid()))return false;
  try{
    const stat=await fs.lstat(file);
    return stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=32768&&
      (process.platform==='win32'||(stat.mode&0o022)===0&&
        (typeof process.getuid!=='function'||stat.uid===process.getuid()));
  }catch(error){if(error.code==='ENOENT')return e.tool_name==='Write';throw error;}
}
function marker(input){
  const m=typeof input?.description==='string'&&input.description.match(/^JEV:(?:bootstrap:(research|contract|plan)|([a-z][a-z0-9-]{0,63}))$/);
  return m?{bootstrap:m[1]||null,id:m[2]||null}:null;
}
function assignment(plan,task,route){
  const packet={planVersion:plan.version,taskId:task.id,phase:task.phase,summary:task.summary,
    acceptance:task.acceptance,dependencies:task.dependencies,readPaths:task.readPaths,writePaths:task.writePaths,
    risk:task.risk,model:route.model,effort:route.effort};
  return `<jev-controller-task>\n${JSON.stringify(packet)}\n</jev-controller-task>\nThis is the assigned native task. Read exact contracts before changes. Do not modify outside the listed write paths; an empty list means no edits. Do not delegate again. Report actual checks and unresolved issues. A worker report is not proof of acceptance. Escalate changed interfaces, missing evidence or new risks to Main for Astra replanning.`;
}

export async function handleControllerHook(e,cfg,store,{project,apiKey='',client=null,runtimeEnv=process.env}={}){
  const telemetry=async(name,fields={})=>{
    try{
      if(runtimeEnv.JEV_OTEL_ENABLED!=='true')return;
      const epoch=(await store.snapshot()).epoch;
      const delivery=await emitTelemetry(runtimeEnv,project,`${e.session_id}:${epoch}`,name,fields);
      await store.record('telemetry_delivery',
        {name,sent:delivery.sent,reason:delivery.reason});
    }catch{} // Observation must not change routing.
  };
  if(e.event==='SessionStart'){
    if(e.source==='clear')await store.record('session_reset');
    await store.record('session_started',{source:e.source||'unknown',runtime:'claude'});
    await telemetry('session_started');
    return contextOutput(e.event,'Jev controller mode: Main ONLY routes, schedules and verifies reports; delegate ALL source reading, coding, shell checks, review and integration via native Agent/Task. Begin with JEV:bootstrap:plan (Astra xhigh), or bounded JEV:bootstrap:research (Luna high) when Astra needs evidence. The operator must prepare an owner-only .jev directory; a goal-bound controller-plan.json (schema 2) supplies tasks and controller-status.json records Main-attested dependent work. Use description JEV:<task-id>. Jev is advisory only and never selects the worker here. Native permissions and user approvals remain in force.');
  }
  if(e.event==='UserPromptSubmit'){
    if(e.agent_id||e.agent_type)return {};
    const before=await store.snapshot();
    if(before.goalHash){
      await store.record('unverified_prompt',{promptHash:hash(e.prompt||'')});
      return contextOutput(e.event,'Controller goal provenance is no longer verifiable in this session. Start a new native session before using a goal-bound plan.');
    }
    if(before.tasks.length||before.agents.length)return {};
    const goalHash=hash(e.prompt||'');
    await store.record('user_prompt',{prompt:'',goalHash,actor:'first-prompt-unreported'});
    return contextOutput(e.event,`Main is a routing-only controller. First-observed goalHash=${goalHash}. Use native Agent/Task with description JEV:bootstrap:plan for Astra planning. Delegate evidence collection as JEV:bootstrap:research and contract analysis as JEV:bootstrap:contract when needed. Write only the private controller plan/status artifacts; do not read/edit the application or execute tests yourself.`);
  }
  if(e.event==='SubagentStart'||e.event==='SubagentStop'){
    if(typeof e.agent_id==='string'){
      await store.record(e.event==='SubagentStart'?'agent_started':'agent_stopped',
        {agentId:e.agent_id,agentType:e.agent_type||'unknown',verification:'not_inferred',
          ...(e.event==='SubagentStop'&&typeof e.last_assistant_message==='string'?
            {reportHash:hash(e.last_assistant_message)}:{})},e.agent_id);
      await telemetry(e.event==='SubagentStart'?'worker_started':'worker_stopped',
        {agent_hash:hash([e.session_id,e.agent_id])});
    }
    return {};
  }
  if(e.event==='PreCompact'||e.event==='SessionEnd')return {};
  if(e.event==='PreToolUse'){
    if(e.tool_name==='Workflow'){
      await store.record('workflow_boundary',{blocked:true,routed:false});
      await telemetry('workflow_denied');
      return denyOutput('Controller mode requires individually observable native Agent/Task delegations; Workflow internal workers cannot be routed.');
    }
    if(!e.agent_id&&!e.agent_type&&!isDelegation(e)){
      if(await planArtifact(e,project)||scheduleTools.has(e.tool_name))return {};
      await store.record('main_direct_work_denied',{tool:e.tool_name});
      await telemetry('main_direct_work_denied');
      return denyOutput('Main only routes. Delegate source reading, writing, checks and other tools to a native worker; Main may access only the private controller plan artifact and scheduling tools.');
    }
    if(!isDelegation(e))return {};
    if(e.agent_id||e.agent_type)return denyOutput('Only Main routes workers in controller mode; a worker must return its finding to Main.');
    if(e.tool_name!=='Agent'&&e.tool_name!=='Task')return denyOutput('Unsupported controller delegation.');
    const d=delegation(e),m=marker(e.input);
    if(!d||d.custom||!m||!e.tool_use_id)return denyOutput('Use a supported native Agent with a nonempty prompt and description JEV:bootstrap:<phase> or JEV:<plan-task-id>.');
    if(e.input.resume)return denyOutput('Native resume preserves the already running worker settings; it cannot be routed as a new controller task. Reconcile that worker separately.');
    if(['model','reasoning_effort','effort','model_reasoning_effort'].some(k=>Object.hasOwn(e.input,k)))
      return denyOutput('Explicit model/effort input conflicts with the approved controller profile.');
    const snap=await store.snapshot();
    if(!snap.goalEligible)return denyOutput('No verified first parent goal for this session; start a new native session.');
    return withLock(store.taskFile(e.tool_use_id)+'.lock',async()=>{
    const prior=await store.getTask(e.tool_use_id);
    if(prior)return denyOutput('This native tool_use_id was already routed; Main must issue a new call rather than replay or change it.');
    let plan=null,task,planRevision=null;
    if(m.bootstrap){
      const b=bootstrapTask(m.bootstrap);
      task={...b,id:'bootstrap-'+m.bootstrap,summary:d.text,acceptance:'Return evidence and unresolved questions to Main.',
        dependencies:[],readPaths:[],writePaths:[]};
      plan={version:0};
    } else {
      const file=await loadControllerPlan(project,snap.goalHash,apiKey);
      if(!file)return denyOutput('A private goal-bound .jev/controller-plan.json is required before planned delegation.');
      plan=file.plan;planRevision=file.revision;
      task=plan.tasks.find(t=>t.id===m.id);
      if(!task)return denyOutput('The requested task ID is not present in the current Astra plan.');
      if(task.dependencies.length){
        const status=await loadControllerStatus(project,snap.goalHash,planRevision,plan,store,apiKey,snap.epoch);
        const unresolved=task.dependencies.filter(id=>!status?.accepted.has(id));
        if(unresolved.length){
          await store.record('route_deferred',{taskId:e.tool_use_id,reason:'dependency_not_attested',
            planVersion:plan.version,taskHash:hash([e.session_id,task.id])});
          await telemetry('route_deferred',{reason:'dependency_not_attested',
            task_hash:hash([e.session_id,task.id]),delegation_hash:hash([e.session_id,e.tool_use_id])});
          return denyOutput('Dependencies lack a goal-and-plan-bound Main acceptance record linked to an observed worker stop; reconcile evidence in .jev/controller-status.json first. A worker stop alone is not verification.');
        }
      }
    }
    const decision=selectControllerProfile(cfg.registry,task,{allowMaxEffort:cfg.safety.allowMaxEffort});
    if(decision.deferred){
      await store.record('route_deferred',{taskId:e.tool_use_id,reason:decision.reason,planVersion:plan.version});
      await telemetry('route_deferred',{reason:decision.reason,task_hash:hash([e.session_id,task.id]),
        delegation_hash:hash([e.session_id,e.tool_use_id])});
      return denyOutput(`Controller did not route task (${decision.reason}). Gather evidence, obtain user approval, or request an Astra plan revision.`);
    }
    const p=decision.profile;
    await assertInstalledProfile(cfg,p,project,e.cwd);
    if(planRevision){
      const current=await loadControllerPlan(project,snap.goalHash,apiKey);
      if(!current||current.revision!==planRevision||(await store.snapshot()).goalEligible!==true)
        return denyOutput('Controller plan or goal changed during this pending delegation. Start a new native tool call after reviewing the revision.');
    }
    const route={role:p.role,tier:p.slot,profile:p.profileId,model:p.model,effort:p.effort,
      decisionReason:decision.reason,taskSignature:hash([snap.goalHash,plan.version,task.id]),
      effective:{status:'not_observed'}};
    const input={...e,input:{...e.input,prompt:m.bootstrap?d.text:assignment(plan,task,route)}};
    const updated=rewrite(input,d,route,'',cfg,true);
    // The plan packet replaces Main's free-form prompt; no ad hoc instructions are appended.
    await store.putTask(e.tool_use_id,{inputHash:hash(e.input),outputHash:hash(updated.hookSpecificOutput.updatedInput),
      planVersion:plan.version,planRevision,epoch:snap.epoch,taskId:task.id,profile:p.profileId});
    await store.record('route',{taskId:e.tool_use_id,planTaskId:task.id,route,mode:'controller',
      planVersion:plan.version,planRevision,evidence:'policy_and_goal_bound_plan_not_measured_quality'},e.tool_use_id);
    await telemetry('route_selected',{phase:task.phase,role:p.role,slot:p.slot,model:p.model,effort:p.effort,
      reason:decision.reason,plan_version:plan.version,task_hash:hash([e.session_id,task.id]),
      delegation_hash:hash([e.session_id,e.tool_use_id])});
    if(planRevision){
      const advice=await critiqueControllerTask({cfg,apiKey,client,runtimeEnv,project,session:e.session_id,
        plan,task,store});
      if(advice.status==='advice'&&advice.flags.length)
        updated.hookSpecificOutput.additionalContext+=` Jev advisory (nonbinding, not execution approval): ${advice.flags.join(', ')}. Main may ask Astra to inspect the plan.`;
    }
    return updated;
    });
  }
  if(['PostToolUse','PostToolUseFailure'].includes(e.event)&&isDelegation(e)){
    const response=e.tool_response||{};
    const failed=e.event==='PostToolUseFailure'||response.is_error===true||response.success===false;
    const agentId=response.agent_id||response.agentId||null;
    await store.record('spawn_observed',{taskId:e.tool_use_id||'unknown',failed,agentId},e.tool_use_id||null);
    await telemetry('delegation_observed',{result:failed?'spawn_failed':'spawn_observed',
      ...(e.tool_use_id?{delegation_hash:hash([e.session_id,e.tool_use_id])}:{}),
      ...(typeof agentId==='string'?{agent_hash:hash([e.session_id,agentId])}:{})});
    return contextOutput(e.event,'Native worker response observed; Main must reconcile evidence, not equate a completed worker with passing acceptance. Ask Astra to revise the plan when a boundary changes.');
  }
  return {};
}
