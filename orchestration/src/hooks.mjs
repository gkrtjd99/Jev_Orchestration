import path from 'node:path';
import {applicationGuard,secretLike} from './safety.mjs';
import { performance } from 'node:perf_hooks';
import { eventInput, isDelegation, delegation, isRead, contextOutput, denyOutput, rewrite } from './adapters.mjs';
import { projectFor } from './config.mjs';
import { SessionStore } from './state.mjs';
import { inventory, revisionFingerprint, readDocumentMetadata } from './documents.mjs';
import { routeQuestions, failureQuestions, readQuestions, QUESTION_VERSION } from './questions.mjs';
import { routeContext, policyFingerprint } from './policy.mjs';
import { routeTask } from './router.mjs';
import { assertInstalledProfile } from './profiles.mjs';
import { profileCatalog } from './catalog.mjs';
import { JevClient } from './jev.mjs';
import { planContext } from './plan-context.mjs';
import { handleControllerHook,controllerManagedTool } from './controller-hooks.mjs';
import { hash, object, redact, withLock } from './util.mjs';

function errorCode(error){return /^[A-Z0-9_]+$/.test(error.code||error.message||'')?(error.code||error.message):'JEV_UNAVAILABLE';}
function warning(event,code){
  if(['PreToolUse','SessionStart','UserPromptSubmit','PostToolUse','PostToolUseFailure','SubagentStart'].includes(event))
    return contextOutput(event,`Jev hooks: ${code}. No worker was started by this extension. The native runtime retains control.`);
  return {};
}
function failedResponse(e){return e.event==='PostToolUseFailure'||e.tool_response?.is_error===true||e.tool_response?.success===false;}
export async function handleHook(raw,runtime,{config:cfg,apiKey='',client=null,runtimeEnv=process.env}={}){
  const began=performance.now();const e=eventInput(raw,runtime);
  if(!cfg.enabledRuntimes.includes(runtime)||cfg.mode==='off')return {};
  const project=await projectFor(cfg,e.cwd);if(!project)return {};
  const store=new SessionStore(cfg,project,runtime,e.session_id);
  const visible=['active','advisory'].includes(cfg.mode);const active=cfg.mode==='active';
  const jev=client||new JevClient(cfg,apiKey);
  const scope=hash({project,session:e.session_id,runtime});
  try{
    if(cfg.mode==='controller')return runtime==='claude'?await handleControllerHook(e,cfg,store,{project,apiKey,client,runtimeEnv}):{};
    if(e.event==='SessionStart'){
      if(e.source==='clear')await store.record('session_reset');
      await store.record('session_started',{source:e.source||'unknown',runtime});
      return visible?contextOutput('SessionStart',await store.restoreContext()):{};
    }
    if(e.event==='UserPromptSubmit'){
      if(e.agent_id||e.agent_type)return {}; // Child prompts must not replace the parent goal.
      // Native child prompts may omit agent_id and share the parent's session_id.
      const before=await store.snapshot();
      if(before.goalHash){
        if(before.goalHash!==hash(e.prompt||''))await store.record('unverified_prompt',{promptHash:hash(e.prompt||'')});
        return visible?contextOutput(e.event,'Jev cannot prove whether a later prompt in this session came from Main or a worker. The original parent goal is preserved, but plan and stored goal text will not be sent to Jev for subsequent routes. Start a new native session to establish a new goal.'):{};
      }
      if(before.tasks.length||before.agents.length){await store.record('unverified_prompt',{promptHash:hash(e.prompt||'')});return {};}
      await store.record('user_prompt',{prompt:cfg.safety.retainPromptText?redact(e.prompt,700):'',goalHash:hash(e.prompt||''),actor:e.agent_id||'first-prompt-unreported'});
      const planHint=cfg.safety.sharePlanContext?` If safe and useful, Main may write a concise private .jev/routing-plan.json (schema=1, goalHash=${hash(e.prompt||'')}, summary, acceptance, delegations) before delegating. Do not include secrets. Jev reads it only for supported native Agent/Task or Codex spawn calls; Workflow's internal agents cannot be routed by these hooks.`:'';
      return visible?contextOutput(e.event,'Use native delegation for substantial specialist work. Hooks evaluate supported calls. Active mode applies verified eligible profiles; advisory mode only advises and leaves the pending call unchanged. No Skill command is required. Parent Main owns sequencing, integration and real verification.'+planHint):{};
    }
    if(e.event==='PreCompact'){
      await store.record('compaction_observed',{trigger:e.trigger||'unknown'});
      return {};
    }
    if(e.event==='SessionEnd'){
      await store.record('session_ended',{reason:redact(e.reason,100)});
      // Never kill, resume, or respawn native agents from a lifecycle hook.
      return {};
    }
    if(e.event==='SubagentStart'){
      if(typeof e.agent_id==='string')await store.record('agent_started',{agentId:e.agent_id,agentType:e.agent_type||'unknown',runtimeReportedModel:e.model||null,modelScope:'not_assumed_child'},e.agent_id);
      return visible?contextOutput(e.event,'You are a native subagent. Keep your assigned scope and existing tool restrictions. Follow the original task and routing packet. Return concrete evidence; the parent Main owns integration. Do not start an external CLI orchestrator.'):{};
    }
    if(e.event==='SubagentStop'){
      if(typeof e.agent_id==='string')await store.record('agent_stopped',{agentId:e.agent_id,agentType:e.agent_type||'unknown',reportHash:hash(e.last_assistant_message||''),verification:'not_inferred'},e.agent_id);
      // Stop != successful implementation. Handback may hold the actual report on recent Claude builds.
      return {};
    }
    if(e.tool_name==='Workflow'&&runtime==='claude'&&['PreToolUse','PostToolUse','PostToolUseFailure'].includes(e.event)){
      const blocked=active&&cfg.safety.workflowPolicy==='block'&&e.event==='PreToolUse';
      // Logging is best-effort here: a broken state directory must not turn an opted-in deny into approval.
      try{await store.record('workflow_boundary',{event:e.event,scriptHash:hash(e.input?.script||''),routed:false,blocked});}catch{}
      if(blocked)return denyOutput('Jev Workflow policy blocked this call: internal agent() workers have no individually routable native PreToolUse boundary. Main: delegate through native Agent/Task for Jev evaluation, then verify the resulting work independently. No worker was started by this extension. Native delegation may still be preserved unchanged when routing is ineligible; do not claim complete worker coverage.');
      return visible&&e.event==='PreToolUse'?contextOutput(e.event,'Jev cannot route agents started inside Workflow scripts: no per-agent native PreToolUse boundary is exposed. This pending Workflow is unchanged. If Jev routing must apply, use native Agent/Task calls instead; do not count these Workflow workers as Jev-routed.'):{};
    }
    if(e.event==='PreToolUse'&&isDelegation(e)){
      if(!cfg.safety.allowEgress){await store.record('routing_skipped',{reason:'egress_not_approved'});return visible?warning(e.event,'EGRESS_NOT_APPROVED'):{};}
      if(cfg.optimization.requireConfirmedAvailability&&!cfg.registry.models.some(m=>m.runtime===runtime&&m.enabled&&m.availability==='confirmed'))return visible?warning(e.event,'CAPABILITIES_UNCONFIRMED'):{};
      if(runtime==='claude'&&(runtimeEnv.CLAUDE_CODE_SUBAGENT_MODEL_FORCE==='1'||runtimeEnv.CLAUDE_CODE_SUBAGENT_MODEL)){
        await store.record('forced_model_override_detected');return visible?warning(e.event,'NATIVE_FORCED_MODEL_OVERRIDE'):{};
      }
      const d=delegation(e);
      if(!d){await store.record('unsupported_input',{tool:e.tool_name});return visible?warning(e.event,'UNSUPPORTED_NATIVE_INPUT'):{};}
      if(e.input.resume){await store.record('native_resume_preserved');return {};}
      if(d.managed&&!Object.hasOwn(cfg.installedProfiles[runtime]||{},d.kind)){await store.record('unknown_managed_identity_preserved');return visible?warning(e.event,'UNREGISTERED_PROFILE_IDENTITY'):{};}
      if(d.custom){await store.record('custom_agent_preserved',{agentType:d.kind});return {};}
      const guard=applicationGuard(e,d,cfg);
      if(guard){await store.record('routing_skipped',{reason:guard});return visible?warning(e.event,guard):{};}
      if(secretLike(d.text,apiKey)){await store.record('routing_skipped',{reason:'secret_guard'});return visible?warning(e.event,'SECRET_GUARD'):{};}
      if(typeof e.tool_use_id!=='string'||!e.tool_use_id){await store.record('unsupported_input',{tool:e.tool_name});return visible?warning(e.event,'MISSING_TOOL_USE_ID'):{};}
      const inputHash=hash(e.input);const policy=policyFingerprint(cfg);
      const docs=await inventory(project,cfg);const snap=await store.snapshot();
      const revision=await revisionFingerprint(project,docs);
      const plan=cfg.safety.sharePlanContext&&snap.goalEligible?await planContext(project,snap.goalHash,apiKey):null;
      const stamp=hash({revision,goal:snap.goalEligible?snap.goalHash:null,
        goalEligible:snap.goalEligible,plan:plan?.revision||null,turn:e.turn_id||null});
      const canRewrite=active&&(runtime!=='codex'||(cfg.safety.codexRewriteApproved&&
        (e.tool_name!=='collaborationspawn_agent'||cfg.safety.codexCollaborationRewriteApproved)));
      const advice=route=>contextOutput(e.event,'Jev advisory: consider native profile '+route.profile+' ('+route.model+', '+route.effort+'). The pending tool call is UNCHANGED; do not create a duplicate worker. '+routeContext(route,cfg));
      return await withLock(store.taskFile(e.tool_use_id)+'.lock',async()=>{
        const previous=await store.getTask(e.tool_use_id);
        if(previous){
          if(previous.stamp!==stamp)return visible?warning(e.event,'WORKSPACE_OR_GOAL_CHANGED'):{};
          if(previous.policy!==policy)return visible?warning(e.event,'POLICY_CHANGED_DURING_PENDING_CALL'):{};
          if(previous.deferred&&previous.inputHash===inputHash)return visible?contextOutput(e.event,previous.message):{};
          if([previous.inputHash,previous.outputHash].includes(inputHash)){
            if(canRewrite){
              const p=profileCatalog(cfg.registry,runtime).find(x=>x.profileId===previous.route.profile);
              await assertInstalledProfile(cfg,p,project,e.cwd);
              return rewrite(e,d,previous.route,routeContext(previous.route,cfg),cfg,inputHash===previous.outputHash);
            }
            return visible?advice(previous.route):{};
          }
          return visible?warning(e.event,'TOOL_ID_REUSED_WITH_DIFFERENT_INPUT'):{};
        }
        const routeGoal=snap.goalEligible?snap.goalHash:'';
        const retry=await store.failureFor(hash([routeGoal,plan?.revision||'',d.text]));
        const parentGoal=cfg.safety.sharePlanContext&&cfg.safety.retainPromptText&&snap.goalEligible?snap.goal:'';
        if(secretLike(parentGoal,apiKey)){await store.record('routing_skipped',{reason:'secret_guard'});return visible?warning(e.event,'SECRET_GUARD'):{};}
        const state={retry,task:redact(d.text,cfg.maxTaskChars),native_role:d.kind,documents:docs,revision,
          promptRevision:routeGoal,...(plan?{plan:plan.context,planRevision:plan.revision}:{}),
          ...(parentGoal?{parentGoal}:{})};
        const decision=await routeTask({state,docs,delegation:d,config:cfg,runtime,project,client:jev,scope});
        if(decision.deferred){
          const message=`Jev did not select a model/effort (${decision.reason}). Main should gather missing evidence or inspect the model registry. No replacement execution was started. The original native call is unchanged.`;
          await store.putTask(e.tool_use_id,{inputHash,policy,stamp,deferred:true,message});
          await store.record('route_deferred',{taskId:e.tool_use_id,reason:decision.reason},e.tool_use_id);
          return visible?contextOutput(e.event,message):{};
        }
        const currentDocs=await inventory(project,cfg);
        const currentSnapshot=await store.snapshot();
        const currentPlan=cfg.safety.sharePlanContext&&currentSnapshot.goalEligible?await planContext(project,currentSnapshot.goalHash,apiKey):null;
        const currentStamp=hash({revision:await revisionFingerprint(project,currentDocs),
          goal:currentSnapshot.goalEligible?currentSnapshot.goalHash:null,goalEligible:currentSnapshot.goalEligible,
          plan:currentPlan?.revision||null,turn:e.turn_id||null});
        if(currentStamp!==stamp){await store.record('routing_skipped',{reason:'workspace_or_goal_changed_in_flight'});return visible?warning(e.event,'WORKSPACE_OR_GOAL_CHANGED'):{};}
        const route=decision.route;
        let output=visible?advice(route):{};
        if(canRewrite){
          if(!cfg.nativeProfiles)throw Object.assign(new Error('NATIVE_PROFILES_REQUIRED_FOR_EFFORT'),{code:'NATIVE_PROFILES_REQUIRED_FOR_EFFORT'});
          route.application=await assertInstalledProfile(cfg,decision.profile,project,e.cwd);
          output=rewrite(e,d,route,routeContext(route,cfg),cfg);
        }
        await store.putTask(e.tool_use_id,{inputHash,outputHash:hash(output.hookSpecificOutput?.updatedInput||e.input),policy,stamp,route});
        await store.record('route',{taskId:e.tool_use_id,inputHash,route,mode:cfg.mode,cached:decision.cached,latencyMs:decision.latencyMs,hookMs:performance.now()-began,questionVersion:QUESTION_VERSION},e.tool_use_id);
        return output;
      },Math.min(cfg.optimization.routeDeadlineMs+400,5800));
    }
    if(e.event==='PreToolUse'&&isRead(e)&&cfg.readAdvice&&cfg.safety.allowEgress){
      const document=await readDocumentMetadata(project,e.input);if(!document)return {};
      const s=await store.snapshot();
      const decision=await jev.evaluate({document,task:s.goal},readQuestions(),scope);
      await store.record('read_advice',{document:document.path,kind:decision.response.answers.kind.choice,reading:decision.response.answers.reading.choice,cached:decision.cached});
      // Never block reads or silently replace a requested file with a summary.
      return visible?contextOutput(e.event,`Document hint: ${decision.response.answers.kind.choice}; reading=${decision.response.answers.reading.choice}. Metadata-only classification. Read the requested source; this is not permission or a replacement for exact requirements.`):{};
    }
    if(['PostToolUse','PostToolUseFailure'].includes(e.event)){
      if(e.tool_name==='SubagentHandback'){
        await store.record('handback_observed',{agentId:e.agent_id||null,reportHash:hash(e.input?.message||''),verification:'not_inferred'});return {};
      }
      if(!isDelegation(e))return {};
      const failed=failedResponse(e);
      const response=object(e.tool_response)?e.tool_response:{};
      const agentId=response.agent_id||response.agentId||null;
      await store.record('spawn_observed',{taskId:e.tool_use_id||'unknown',failed,agentId,taskName:typeof response.task_name==='string'?response.task_name:null},e.tool_use_id||null);
      if(failed&&cfg.classifyFailures&&cfg.safety.allowEgress){
        const evidence=redact(e.error||JSON.stringify(e.tool_response||{}),1600);
        const decision=await jev.evaluate({failure:evidence},failureQuestions(),scope);
        const category=decision.response.answers.failure.choice;
        const prior=e.tool_use_id?await store.getTask(e.tool_use_id):null;
        await store.record('failure',{category,taskId:e.tool_use_id||null,taskSignature:prior?.route?.taskSignature||null,profileId:prior?.route?.profile||null},e.tool_use_id||null);
        return visible?contextOutput(e.event,`Jev failure category: ${category}. Native Main must decide the next step using the actual error. No automatic retry, respawn, or permission escalation was performed.`):{};
      }
      return visible?contextOutput(e.event,'Native delegation result observed. A spawn acknowledgement is not task completion, and a worker report is not proof of test success. Reconcile native status and verify evidence before integration.'):{};
    }
    return {};
  }catch(error){
    const code=errorCode(error);
    try{await store.record('hook_error',{code,event:e.event,tool:e.tool_name||null});}catch{}
    if(cfg.mode==='controller'&&e.event==='PreToolUse'&&controllerManagedTool(e))
      return denyOutput(`Controller unavailable (${code}); no fallback worker or Main work authorized. Fix hook health or explicitly change mode.`);
    if(active&&runtime==='claude'&&e.event==='PreToolUse'&&e.tool_name==='Workflow'&&cfg.safety.workflowPolicy==='block')
      return denyOutput(`Jev Workflow policy blocked this call despite a hook error (${code}). Use native Agent/Task for individually observable delegation; inspect hook health before claiming routing coverage.`);
    if(!visible)return {};
    if(active&&e.event==='PreToolUse'&&isDelegation(e)&&cfg.failureMode==='block')return denyOutput(`Jev routing unavailable (${code}); strict delegation policy blocked this call. Resolve the configuration or switch the explicit failure policy.`);
    return warning(e.event,code);
  }
}
