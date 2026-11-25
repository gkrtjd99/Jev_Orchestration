import { performance } from 'node:perf_hooks';
import { taskFeatures, taskClass, eligibleProfiles, optimizeCandidates, summarizeEvidence, candidateRubric, ROUTER_VERSION } from './optimizer.mjs';
import { registryFingerprint } from './catalog.mjs';
import { recoveryCandidates } from './recovery.mjs';
import { readEvidence } from './feedback.mjs';
import { routeQuestions, selectionQuestions } from './questions.mjs';
import { hash, redact } from './util.mjs';

export function finalizeRoute(profile,features,docs,result,config,extra={}) {
  return {role:features.role,tier:profile.slot,model:profile.model,backend:profile.backend,effort:profile.effort,
    profile:profile.profileId,profileFingerprint:profile.fingerprint,
    reading:features.reading,risk:features.risk,uncertain:features.uncertain,
    documents:docs.filter((d,i)=>d.required||result.answers[`doc_${i}`]?.noul>=0.55).map(d=>({path:d.path,required:d.required})),
    requiresReview:features.risk!=='normal',jevModel:result.model,taskClass:taskClass(features),
    proposed:{model:profile.model,effort:profile.effort},effective:{status:'not_observed'},
    registryFingerprint:registryFingerprint(config.registry),routerVersion:ROUTER_VERSION,...extra};
}
export async function routeTask({state,docs,delegation,config,runtime,project,client,scope,evidence:providedEvidence}) {
  const began=performance.now();
  if(delegation.text.length>config.maxTaskChars)return {deferred:true,reason:'task_exceeds_safe_classification_budget',stageCount:0};
  // A decision kernel exposes per-point judges; a plain client answers every point itself.
  const classifier=client.forPoint?.('delegation.classify')??client;
  const selectorJudge=client.forPoint?.('delegation.profile')??client;
  // An off classification point means routing is disabled, not broken: no judge is called and nothing is thrown.
  if(client.point?.('delegation.classify').mode==='off')return {deferred:true,reason:'classification_point_off',stageCount:0};
  // One total budget for the classification stage, however many judges the point chains.
  // A kernel sizes it from the point's own judges (a per-provider timeout may exceed config.timeoutMs);
  // the route deadline is the ceiling either way.
  const classify=await classifier.evaluate(state,routeQuestions(docs),scope,
    {timeoutMs:client.budget?.('delegation.classify',config.optimization.routeDeadlineMs)??Math.min(config.timeoutMs,config.optimization.routeDeadlineMs)});
  // A shadow point is logged only: its answer must not steer a native call.
  if(classify.apply===false)return {deferred:true,reason:'classification_point_shadow_only',stageCount:1};
  const features=taskFeatures(classify.response,delegation,config);
  // Missing information is not cured by spending more on a model.
  if(features.information==='missing'&&!features.uncertain)return {deferred:true,reason:'gather_missing_context',features,stageCount:1};
  const eligibility=eligibleProfiles(config.registry,runtime,features,config,{contextTokens:config.optimization.requiredContextTokens});
  const recovery=recoveryCandidates(eligibility.candidates,state.retry,config,runtime);
  eligibility.candidates=recovery.candidates;
  if(recovery.deferred)return {deferred:true,reason:recovery.action,features,stageCount:1};
  if(!eligibility.candidates.length)return {deferred:true,reason:'no_compatible_profile',features,stageCount:1};
  const observed=providedEvidence||(config.optimization.evaluationContext==='native-default-unvalidated'?{rows:[],revision:'unbound-no-training'}:await readEvidence(config));
  const statistics=summarizeEvidence(observed.rows,eligibility.candidates,{
    context:config.optimization.evaluationContext,projectHash:hash(project),classKey:taskClass(features),ttlDays:config.optimization.evidenceTtlDays});
  const options=optimizeCandidates(eligibility.candidates,statistics,config.optimization);
  let selected=options.baseline,reason=options.basis,stageCount=1,selector=null;
  const remaining=config.optimization.routeDeadlineMs-(performance.now()-began);
  const mechanicalFastPath=features.reasoning==='mechanical'&&features.complexity==='small'&&features.risk==='normal'&&!features.uncertain;
  if(mechanicalFastPath)reason='bounded_mechanical_policy_fast_path';
  if(options.pool.length>1&&config.optimization.jevSelectProfile&&!mechanicalFastPath&&remaining>=100) {
    stageCount++;
    try {
      const candidates=options.pool.map(p=>({id:p.profileId,model:p.model,backend:p.backend,effort:p.effort,
        role:p.role,slot:p.slot,deliberationIntents:p.intents,capabilitySource:p.capabilitySource,
        availability:p.availability,rubric:candidateRubric(p,features),policyDistance:p.policyDistance,statistics:statistics[p.profileId]||null}));
      const choice=await selectorJudge.evaluate({task:redact(delegation.text,config.maxTaskChars),features,
        ...(state.plan?{plan:state.plan,planRevision:state.planRevision}:{}),
        ...(state.parentGoal?{parentGoal:state.parentGoal}:{}),
        objective:config.optimization.objective,recoveryAction:recovery.action,candidates,baseline:options.baseline.profileId,
        evidenceBasis:options.basis,evidenceRevision:observed.revision,registryRevision:registryFingerprint(config.registry),
        note:'policyDistance is a declared startup preference, NOT measured cost, latency, or capability. Missing statistics are unknown.'},
        selectionQuestions(candidates),scope,{timeoutMs:client.budget?.('delegation.profile',Math.floor(remaining))??Math.min(config.timeoutMs,Math.floor(remaining))});
      const a=choice.response.answers.profile;
      const probs=Object.values(a.probabilities).sort((a,b)=>b-a);
      const margin=probs[0]-(probs[1]||0);
      selector={choice:a.choice,confidence:a.confidence,margin,cached:choice.cached};
      if(choice.apply===false)reason='selector_shadow_only_incumbent';
      else if(a.choice==='defer')return {deferred:true,reason:'selector_abstained',features,stageCount};
      else if(a.confidence<config.optimization.selectionConfidence||margin<config.optimization.selectionMargin)reason='selector_uncertain_incumbent';
      else {
        const candidate=options.pool.find(p=>p.profileId===a.choice);
        if(candidate){selected=candidate;reason=options.basis==='observed_quality_gated'?'jev_among_quality_gated_profiles':'jev_with_explicit_startup_rubric';}
      }
    } catch {
      // Profile selection failure is not a reason to discard a valid classification and policy route.
      reason='selector_unavailable_incumbent';
    }
  } else if(remaining<100)reason='route_deadline_incumbent';
  const route=finalizeRoute(selected,features,docs,classify.response,config,{decisionReason:reason,
    optimizationBasis:options.basis,recoveryAction:recovery.action,evidence:statistics[selected.profileId]||null,selector,
    policyTarget:eligibility.target,stageCount,taskSignature:hash([state.promptRevision||'',state.planRevision||'',delegation.text]),
    classification:{role:features.role,complexity:features.complexity,reasoning:features.reasoning,information:features.information},
    candidateIds:options.pool.map(p=>p.profileId),projectHash:hash(project),evaluationContext:config.optimization.evaluationContext});
  route.decisionId=hash({scope,task:state.task,profile:route.profile,registry:route.registryFingerprint,evidence:observed.revision,version:ROUTER_VERSION});
  return {route,profile:selected,deferred:false,cached:classify.cached,latencyMs:performance.now()-began,stageCount};
}
