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
export function routeContext(route,cfg){
  const packet={decisionId:route.decisionId,role:route.role,model:route.model,effort:route.effort,
    basis:route.optimizationBasis,reading:route.reading,documents:route.documents,independentReview:route.requiresReview};
  const text=`<jev-routing>\n${JSON.stringify(packet)}\n</jev-routing>\nPerform only the original native task. Preserve acceptance criteria, existing permissions, and write scope. Read required instructions and exact contracts before changes. Selected documents are a starting set, not an access allowlist. Seek missing evidence. Return changed files, executed checks, and unresolved issues. Never claim success from a worker stop. Main retains integration, scheduling and independent verification. Requested model/effort is not proof of the effective setting.`;
  assert(text.length<=cfg.maxContextChars,'ROUTING_CONTEXT_TOO_LARGE');return text;
}
const ROUTING_PACKET=/\n\n<jev-routing>\n(\{[^\n]{1,8000}\})\n<\/jev-routing>\n/;
/**
 * True when the text carries a routing packet in the exact form routeContext appends it. This is a shape check,
 * not provenance: anyone can type such a block. It is used for one thing only, to leave a call alone.
 */
export function hasRoutingPacket(text){
  const found=typeof text==='string'?ROUTING_PACKET.exec(text):null;
  if(!found)return false;
  try{const packet=JSON.parse(found[1]);return object(packet)&&typeof packet.decisionId==='string'&&/^[0-9a-f]{64}$/.test(packet.decisionId)&&typeof packet.role==='string';}
  catch{return false;}
}
export const policyFingerprint=cfg=>hash({registry:registryFingerprint(cfg.registry),optimization:cfg.optimization,
  minimumConfidence:cfg.minimumConfidence,nativeProfiles:cfg.nativeProfiles,customAgents:cfg.customAgents,mode:cfg.mode,application:applicationFingerprint(cfg),questions:QUESTION_VERSION,
  // A missing kernel equals the defaults; any kernel change invalidates a pending call.
  kernel:mergeKernel(cfg.kernel)});
