/** Constraint-first selection. Scores below are policy distances, not measured costs. */
import { SLOTS, INTENTS, profileCatalog } from './catalog.mjs';
import { fixedRole } from './adapters.mjs';
import { hash } from './util.mjs';
export const ROUTER_VERSION='quality-native-router-3.0.0';
export function taskFeatures(response,delegation,config) {
  const a=response.answers;
  const pick=(k,fallback)=>a[k]?.choice??fallback;
  const uncertain=['role','complexity','risk','reasoning','information'].some(k=>a[k]&&a[k].confidence<config.minimumConfidence);
  return {role:fixedRole(delegation)||pick('role','implement'),complexity:pick('complexity','bounded'),risk:pick('risk','normal'),
    reasoning:pick('reasoning','routine'),information:pick('information','sufficient'),reading:pick('reading','targeted'),uncertain};
}
export const taskClass = f => [f.role,f.complexity,f.reasoning,f.risk,f.information,f.uncertain?'uncertain':'clear'].join('|');
export function targetPolicy(f) {
  let slot=f.role==='plan'?'strategic':f.role==='review'?'standard':
    ['research','documentation'].includes(f.role)?'light':f.complexity==='broad'?'standard':'light';
  if(f.role==='research'&&f.reasoning==='mechanical'&&f.complexity==='small'&&!f.uncertain&&f.risk==='normal')slot='micro';
  if((f.risk!=='normal'||f.uncertain)&&SLOTS.indexOf(slot)<2)slot='standard';
  let intent=f.reasoning==='novel'?'exhaustive':f.reasoning==='deep'||f.complexity==='broad'||f.risk!=='normal'?'deep':
    f.reasoning==='mechanical'?'brief':'balanced';
  if(f.role==='plan'&&intent==='brief')intent='balanced';
  return {slot,intent};
}
export function candidateRubric(p,f){
  const high=p.effort==='high',deep=['xhigh','max'].includes(p.effort);
  if(p.effort==='max')return {chooseWhen:'Sufficient evidence and demanding bounded reasoning, many interacting edge cases, or an observed reasoning failure. Compare this model at full effort against the larger model at high/xhigh. No prior failed attempt is required.',avoidWhen:'Exact mechanical lookup, missing context, environment failures, unapproved compute budget or a workload that already meets acceptance at less effort. Max is a model-specific setting, not a universal performance guarantee.',verification:f.risk==='normal'?'Independent acceptance evidence; preserve failures and total work.':'Independent review and exact security/data invariants.',calibration:'Policy candidate; benefit/cost unknown without comparable observations.'};
  return {chooseWhen:p.slot==='light'?(deep?'Decided requirements; demanding bounded logic, evidence synthesis or document work. Fully use this model before assuming a larger model is needed.':'Exact extraction or deterministic transformation with direct verification.'):
    p.slot==='standard'?(high?'Integrate related module contracts and familiar invariants. Compare against light xhigh/max, not an underpowered light baseline.':'Deep causality, concurrency, sensitive invariants or a verified reasoning failure with sufficient evidence.'):
    p.slot==='strategic'?'Planning, architecture or genuinely novel competing hypotheses.':'Optional exact lookup only; no unsupported effort requested.',
    avoidWhen:'Missing information, environment errors and raw file count are not evidence that higher effort solves the problem.',
    verification:f.risk==='normal'?'Task-specific acceptance checks and evidence.':'Independent review plus exact security/data invariants; no model choice authorizes execution.',
    calibration:'Unmeasured policy prior unless comparable independent observations are supplied.'};
}
function intentDistance(profile,target) {
  return Math.min(...profile.intents.map(i=>Math.abs(INTENTS.indexOf(i)-INTENTS.indexOf(target))));
}
export function eligibleProfiles(registry,runtime,f,config,{contextTokens=null}={}) {
  const target=targetPolicy(f);const reasons=[];
  let minSlot=0;
  if(f.role==='plan')minSlot=3;
  else if(f.risk!=='normal'||f.uncertain||f.role==='review'||(f.role==='implement'&&f.complexity==='broad'))minSlot=2;
  else if(f.role!=='research'||f.reasoning!=='mechanical'||f.complexity!=='small')minSlot=1;
  const minIntent=f.reasoning==='novel'?2:f.reasoning==='deep'||f.risk!=='normal'?1:0;
  const candidates=profileCatalog(registry,runtime).filter(p=>{
    let reason=null;
    if(p.role!==f.role)reason='different-role';
    else if(!config.safety?.allowMaxEffort&&p.effort==='max')reason='max-not-authorized';
    else if(!config.safety?.allowEconomy&&p.slot!=='micro'&&!['high','xhigh','max'].includes(p.effort))reason='below-quality-floor';
    else if(!config.safety?.allowEconomy&&p.slot==='light'&&f.reasoning!=='mechanical'&&!['xhigh','max'].includes(p.effort))reason='light-work-requires-deep-effort';
    else if(!config.safety?.allowEconomy&&p.slot==='standard'&&(f.reasoning==='deep'||f.reasoning==='novel'||f.risk!=='normal')&&!['xhigh','max'].includes(p.effort))reason='sensitive-or-deep-requires-xhigh';
    else if(SLOTS.indexOf(p.slot)<minSlot)reason='minimum-model-policy';
    else if(Math.max(...p.intents.map(i=>INTENTS.indexOf(i)))<minIntent)reason='minimum-reasoning-policy';
    else if(contextTokens!==null&&(p.contextTokens===null||p.contextTokens<contextTokens))reason='context-capability-unproven';
    else if(config.optimization.requireConfirmedAvailability&&p.availability!=='confirmed')reason='availability-unconfirmed';
    if(reason){reasons.push({profileId:p.profileId,reason});return false;}return true;
  }).map(p=>({...p,policyDistance:Math.abs(SLOTS.indexOf(p.slot)-SLOTS.indexOf(target.slot))*4+intentDistance(p,target.intent)}));
  candidates.sort((a,b)=>a.policyDistance-b.policyDistance||a.profileId.localeCompare(b.profileId));
  return {candidates,target,rejected:reasons};
}
export function wilsonLower(successes,n,z=1.96) {
  if(!n)return null;
  const p=successes/n,z2=z*z;
  return (p+z2/(2*n)-z*Math.sqrt(p*(1-p)/n+z2/(4*n*n)))/(1+z2/n);
}
export function summarizeEvidence(rows,profiles,{context,projectHash,classKey,now=Date.now(),ttlDays=30}) {
  if(context==='native-default-unvalidated')return {};
  const allowed=new Map(profiles.map(p=>[p.profileId,p]));const groups=new Map();const seen=new Set();
  for(const r of rows) {
    const p=allowed.get(r.profileId);
    if(!p||r.profileFingerprint!==p.fingerprint||r.context!==context||r.projectHash!==projectHash||r.taskClass!==classKey)continue;
    if(r.createdAt>now||now-r.createdAt>ttlDays*86400000)continue;
    if(r.verification?.source!=='independent-validator'||typeof r.verification.passed!=='boolean'||r.effective?.confirmed!==true)continue;
    // The backend itself, or an id the user declared for the profile's registry entry (catalog.mjs resolvesTo).
    if((r.effective.model!==p.backend&&!(Array.isArray(p.resolvesTo)&&p.resolvesTo.includes(r.effective.model)))||r.effective.effort!==p.effort)continue;
    const key=hash([r.context,r.projectHash,r.taskId,p.profileId]);if(seen.has(key))continue;seen.add(key);
    const g=groups.get(p.profileId)||[];g.push(r);groups.set(p.profileId,g);
  }
  return Object.fromEntries([...groups].map(([id,rs])=>{
    const successes=rs.filter(r=>r.verification.passed).length;
    const costs=rs.map(r=>r.costUsd);const times=rs.map(r=>r.durationMs);
    const fullCosts=costs.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0);
    const fullTimes=times.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>0);
    return [id,{n:rs.length,successes,successRate:successes/rs.length,successLower:wilsonLower(successes,rs.length),
      meanCostUsd:fullCosts?costs.reduce((a,b)=>a+b,0)/rs.length:null,
      meanDurationMs:fullTimes?times.reduce((a,b)=>a+b,0)/rs.length:null,
      cohortHash:hash(rs.map(r=>r.taskId).sort()),source:'independent-validator-observations'}];
  }));
}
export function optimizeCandidates(candidates,evidence,policy) {
  if(!candidates.length)return {pool:[],baseline:null,basis:'no_eligible_profile',evidence};
  const baseline=candidates[0];
  const baseEvidence=evidence[baseline.profileId];
  const matchedBaseline=baseEvidence&&baseEvidence.n>=policy.minimumSamples;
  let measured=candidates.filter(p=>{
    const e=evidence[p.profileId];return matchedBaseline&&e&&e.cohortHash&&e.cohortHash===baseEvidence.cohortHash&&e.n>=policy.minimumSamples&&e.successLower>=policy.qualityFloor&&
      e.meanCostUsd!==null&&e.meanDurationMs!==null;
  });
  if(measured.length) {
    const base=evidence[baseline.profileId];
    if(base&&base.n>=policy.minimumSamples)measured=measured.filter(p=>evidence[p.profileId].successLower>=base.successLower-policy.nonInferiorityTolerance);
  }
  if(!measured.length)return {pool:candidates.slice(0,policy.maxCandidates),baseline,basis:'policy_prior_not_measured',evidence};
  // Normalize empirical measurements across eligible profiles, not across model effort labels.
  const maxCost=Math.max(...measured.map(p=>evidence[p.profileId].meanCostUsd),1e-9);
  const maxTime=Math.max(...measured.map(p=>evidence[p.profileId].meanDurationMs),1);
  const weights=policy.objective==='latency'?{cost:.2,time:.8}:policy.objective==='cost'?{cost:.8,time:.2}:{cost:.5,time:.5};
  measured=measured.map(p=>({...p,measuredObjective:weights.cost*evidence[p.profileId].meanCostUsd/maxCost+weights.time*evidence[p.profileId].meanDurationMs/maxTime}));
  measured.sort((a,b)=>a.measuredObjective-b.measuredObjective||a.policyDistance-b.policyDistance);
  return {pool:measured.filter(p=>p.measuredObjective<=measured[0].measuredObjective+policy.objectiveSlack).slice(0,policy.maxCandidates),
    baseline:measured[0],basis:'observed_quality_gated',evidence};
}
