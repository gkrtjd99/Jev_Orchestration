/** Bounded retry guidance for the exact same task, never a worker execution loop. */
import {SLOTS,INTENTS,profileCatalog} from './catalog.mjs';
export function recoveryCandidates(candidates,retry,config,runtime){
  if(!retry||!retry.count)return {candidates,action:'none'};
  if(['context','design'].includes(retry.category))return {candidates:[],deferred:true,action:'gather_context_or_replan'};
  if(retry.category!=='implementation')return {candidates,action:'keep_profile_for_non_implementation_failure'};
  if(retry.count>config.optimization.maxRetryEscalations)return {candidates:[],deferred:true,action:'retry_escalation_budget_exhausted'};
  const previous=profileCatalog(config.registry,runtime).find(p=>p.profileId===retry.profileId);
  if(!previous)return {candidates:[],deferred:true,action:'unknown_previous_profile'};
  const level=p=>Math.max(...p.intents.map(i=>INTENTS.indexOf(i)));
  const sameModel=candidates.filter(p=>p.modelKey===previous.modelKey&&level(p)>level(previous));
  sameModel.sort((a,b)=>level(a)-level(b)||a.policyDistance-b.policyDistance);
  const higher=candidates.filter(p=>SLOTS.indexOf(p.slot)>SLOTS.indexOf(previous.slot));
  higher.sort((a,b)=>SLOTS.indexOf(a.slot)-SLOTS.indexOf(b.slot)||a.policyDistance-b.policyDistance);
  if(sameModel.length||higher.length)return {candidates:[...sameModel,...higher],action:'compare_more_effort_and_higher_tier'};
  return {candidates:[],deferred:true,action:'no_supported_escalation_remaining'};
}
