import { hash, assert, object } from './util.mjs';
import {applicationFingerprint} from './safety.mjs';
import {QUESTION_VERSION} from './questions.mjs';
import { registryFingerprint } from './catalog.mjs';
import { taskFeatures, eligibleProfiles } from './optimizer.mjs';
import { finalizeRoute } from './router.mjs';
import { mergeKernel } from './kernel/kernel.mjs';
export function chooseRoute(result,d,docs,cfg,runtime){
  const f=taskFeatures(result,d,cfg);const {candidates}=eligibleProfiles(cfg.registry,runtime,f,cfg);
  assert(candidates.length,'NO_ELIGIBLE_PROFILE');
  return finalizeRoute(candidates[0],f,docs,result,cfg,{optimizationBasis:'policy_prior_not_measured'});
}
// The fixed sentence that follows the packet. splitRoutingTail matches it literally.
const ROUTE_INSTRUCTION='Perform only the original native task. Preserve acceptance criteria, existing permissions, and write scope. Read required instructions and exact contracts before changes. Selected documents are a starting set, not an access allowlist. Seek missing evidence. Return changed files, executed checks, and unresolved issues. Never claim success from a worker stop. Main retains integration, scheduling and independent verification. Requested model/effort is not proof of the effective setting.';
export function routeContext(route,cfg){
  const packet={decisionId:route.decisionId,role:route.role,model:route.model,effort:route.effort,
    basis:route.optimizationBasis,reading:route.reading,documents:route.documents,independentReview:route.requiresReview};
  const text=`<jev-routing>\n${JSON.stringify(packet)}\n</jev-routing>\n${ROUTE_INSTRUCTION}`;
  assert(text.length<=cfg.maxContextChars,'ROUTING_CONTEXT_TOO_LARGE');return text;
}
const TAIL_OPEN='\n\n<jev-routing>\n';
const TAIL_CLOSE='\n</jev-routing>\n'+ROUTE_INSTRUCTION;
const SKILLS_TAIL=/^\n\n<jev-skills>\n[^\n]{1,8000}\n<\/jev-skills>\n[^\n]*$/;
/**
 * Splits a prompt that ENDS in exactly what this extension appends to a rewritten delegation: a blank line, one
 * routing packet, the fixed sentence, optionally followed by a blank line and one <jev-skills> block.
 * Returns {task} (the text in front of that tail) or null. This is a shape check, not provenance: anyone can
 * type such a tail. It is used for one thing only: when no stored decision of this session vouches for the
 * call, the tail is taken off before the task is routed, so the packet is never judged as task text and never
 * decides anything. A packet anywhere else in the prompt is ordinary task text.
 */
export function splitRoutingTail(text){
  if(typeof text!=='string')return null;
  const at=text.lastIndexOf(TAIL_OPEN);
  if(at<0)return null;
  const body=text.slice(at+TAIL_OPEN.length);
  const end=body.indexOf('\n');
  if(end<1||end>8000||!body.startsWith(TAIL_CLOSE,end))return null;
  const after=body.slice(end+TAIL_CLOSE.length);
  if(after!==''&&!SKILLS_TAIL.test(after))return null;
  try{
    const packet=JSON.parse(body.slice(0,end));
    if(!object(packet)||typeof packet.decisionId!=='string'||!/^[0-9a-f]{64}$/.test(packet.decisionId)||typeof packet.role!=='string')return null;
  }catch{return null;}
  const task=text.slice(0,at);
  return task.trim()?{task}:null;
}
export const policyFingerprint=cfg=>hash({registry:registryFingerprint(cfg.registry),optimization:cfg.optimization,
  minimumConfidence:cfg.minimumConfidence,nativeProfiles:cfg.nativeProfiles,customAgents:cfg.customAgents,mode:cfg.mode,application:applicationFingerprint(cfg),questions:QUESTION_VERSION,
  // A missing kernel equals the defaults; any kernel change invalidates a pending call.
  kernel:mergeKernel(cfg.kernel)});
