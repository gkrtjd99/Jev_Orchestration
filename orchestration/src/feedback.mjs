/** Only explicitly imported independent evaluations can affect measured routing. */
import path from 'node:path';
import { assert, object, hash, readJSON, writeJSON, withLock } from './util.mjs';
import { profileCatalog, RESOLVED_MODEL_ID } from './catalog.mjs';
export const evidenceFile = config => path.join(config.stateDir,'evaluations','accepted.json');
export async function readEvidence(config) {
  const data=await readJSON(evidenceFile(config),{schema:1,rows:[]});
  assert(data.schema===1&&Array.isArray(data.rows)&&data.rows.length<=20000,'INVALID_EVIDENCE_STORE');
  return {rows:data.rows,revision:hash(data.rows)};
}
/**
 * How a host-recorded model id matches a profile: 'exact' (string-equal to the profile's backend), 'declared'
 * (one of the ids the user declared for the profile's registry entry, `resolvesTo`), or null. Nothing else
 * counts: no prefix, no "contains the alias", no case folding.
 */
export function effectiveModelMatch(profile,model) {
  if(typeof model!=='string'||!model||!profile)return null;
  if(model===profile.backend)return 'exact';
  return Array.isArray(profile.resolvesTo)&&profile.resolvesTo.includes(model)?'declared':null;
}
/** The row as it is stored: with `effective.modelMatch` saying how the model was accepted. */
function stamped(row,config) {
  const p=profileCatalog(config.registry,row.runtime).find(p=>p.profileId===row.profileId);
  return {...row,effective:{...row.effective,modelMatch:effectiveModelMatch(p,row.effective.model)}};
}
// Identity of a row's content apart from the stamp, so a row stored before the stamp existed is still a duplicate of itself.
const unstamped=row=>{const {modelMatch,...effective}=row.effective??{};return hash({...row,effective});};
export function validateEvaluation(row,config) {
  assert(object(row)&&row.schema===1&&row.kind==='live-evaluation','LIVE_EVALUATION_REQUIRED');
  for(const k of ['taskId','taskClass','context'])assert(typeof row[k]==='string'&&row[k].length>0&&row[k].length<=200,`INVALID_EVIDENCE_${k}`);
  for(const k of ['projectHash','profileFingerprint'])assert(/^[a-f0-9]{64}$/.test(row[k]),`INVALID_EVIDENCE_${k}`);
  assert(Number.isInteger(row.createdAt)&&row.createdAt>0&&row.createdAt<=Date.now()+60000,'INVALID_EVIDENCE_TIMESTAMP');
  const p=profileCatalog(config.registry,row.runtime).find(p=>p.profileId===row.profileId);
  assert(p&&p.fingerprint===row.profileFingerprint,'STALE_EVIDENCE_PROFILE');
  assert(row.effective?.confirmed===true&&['native-transcript','provider-metadata'].includes(row.effective.source),'EFFECTIVE_SETTING_NOT_CONFIRMED');
  const match=effectiveModelMatch(p,row.effective.model);
  assert(match!==null&&row.effective.effort===p.effort,'EFFECTIVE_SETTING_MISMATCH');
  // A row may state how its model matched; a statement that is not what this registry gives is refused.
  assert(row.effective.modelMatch===undefined||row.effective.modelMatch===match,'EFFECTIVE_MODEL_MATCH_MISSTATED');
  assert(row.verification?.source==='independent-validator'&&typeof row.verification.passed==='boolean','INDEPENDENT_VERIFICATION_REQUIRED');
  assert(/^[a-f0-9]{64}$/.test(row.verification.artifactSha256)&&typeof row.verification.validatorVersion==='string'&&row.verification.validatorVersion.length>0,'VERIFICATION_PROVENANCE_REQUIRED');
  assert(row.accounting==='all-attempts-including-failures-and-router','COMPLETE_ACCOUNTING_REQUIRED');
  assert(Number.isInteger(row.attempts)&&row.attempts>0&&row.attempts<=100,'INVALID_ATTEMPTS');
  assert(typeof row.durationMs==='number'&&Number.isFinite(row.durationMs)&&row.durationMs>0,'INVALID_DURATION');
  assert(row.costUsd===null||(typeof row.costUsd==='number'&&Number.isFinite(row.costUsd)&&row.costUsd>=0),'INVALID_COST');
  assert(config.optimization.evaluationContext!=='native-default-unvalidated','EVALUATION_CONTEXT_NOT_CONFIGURED');
  assert(row.context===config.optimization.evaluationContext,'EVALUATION_CONTEXT_MISMATCH');
  return row;
}
/**
 * One stored row per (context, project, task, profile, profile definition). The profile fingerprint is part of
 * the key: a profile whose definition changed (for one, a changed `resolvesTo` declaration - the profile id
 * stays the same) starts a new unit, so the same tasks can be imported again under the new definition. The rows
 * of the old definition stay in the store as `stale` (evidenceReport) and are never counted. Within one
 * definition a second, different row for the same task is still refused.
 */
const unitKey=r=>hash([r.context,r.projectHash,r.taskId,r.profileId,r.profileFingerprint]);
export async function importEvaluations(config,rows,{acceptEvidence=false}={}) {
  assert(acceptEvidence,'EXPLICIT_EVIDENCE_ACCEPTANCE_REQUIRED');
  assert(Array.isArray(rows)&&rows.length>0&&rows.length<=5000,'INVALID_EVIDENCE_BATCH');
  rows.forEach(r=>validateEvaluation(r,config));
  rows=rows.map(r=>stamped(r,config));
  return withLock(evidenceFile(config)+'.lock',async()=>{
    const old=await readEvidence(config);const map=new Map(old.rows.map(r=>[unitKey(r),r]));let added=0;
    for(const row of rows) {
      const key=unitKey(row),prev=map.get(key);
      assert(!prev||unstamped(prev)===unstamped(row),'CONFLICTING_EVALUATION_UNIT');
      if(!prev){map.set(key,row);added++;}
    }
    assert(map.size<=20000,'EVIDENCE_STORE_LIMIT');
    const all=[...map.values()];await writeJSON(evidenceFile(config),{schema:1,rows:all});
    return {added,duplicate:rows.length-added,total:all.length,revision:hash(all)};
  });
}

/**
 * Read-only: what stands in the evidence store, by profile and by how the model was accepted. `current` rows
 * carry the fingerprint of the profile as the registry defines it now; `stale` rows do not (the profile is
 * gone, or its definition - including its declared `resolvesTo` - changed) and are not counted by the router.
 * `currentEffectiveModels` counts a profile's current rows per effective model id; `mixedModelProfiles` lists
 * the profiles where that is more than one id (several ids declared at once and both seen).
 */
export async function evidenceReport(config) {
  const {rows}=await readEvidence(config);
  const profiles=new Map(['claude','codex'].flatMap(rt=>profileCatalog(config.registry,rt)).map(p=>[p.profileId,p]));
  const kinds=()=>({exact:0,declared:0,unrecorded:0});
  const out={schema:1,rows:rows.length,current:0,stale:0,byMatch:kinds(),byProfile:{},mixedModelProfiles:[]};
  for(const r of rows) {
    const kind=['exact','declared'].includes(r.effective?.modelMatch)?r.effective.modelMatch:'unrecorded';
    const fresh=profiles.get(r.profileId)?.fingerprint===r.profileFingerprint;
    out[fresh?'current':'stale']++;out.byMatch[kind]++;
    const id=typeof r.profileId==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(r.profileId)?r.profileId:'(invalid)';
    const g=out.byProfile[id]??={current:0,stale:0,byMatch:kinds(),currentEffectiveModels:{}};
    g[fresh?'current':'stale']++;g.byMatch[kind]++;
    if(fresh) {
      const model=typeof r.effective?.model==='string'&&RESOLVED_MODEL_ID.test(r.effective.model)?r.effective.model:'(other)';
      g.currentEffectiveModels[model]=(g.currentEffectiveModels[model]??0)+1;
    }
  }
  // A profile whose current rows name more than one effective model. The router does not pool them: a
  // (context, project, task class) group that holds two models is left unmeasured (optimizer.mjs summarizeEvidence).
  out.mixedModelProfiles=Object.entries(out.byProfile).filter(([,g])=>Object.keys(g.currentEffectiveModels).length>1).map(([id])=>id).sort();
  return out;
}
/**
 * Read-only: per enabled registry entry, the declared ids and whether evidence could be imported for it.
 * It says what is configured, not that any evidence exists or that a declared id is right.
 */
export function evidenceReadiness(config) {
  const contextConfigured=config.optimization.evaluationContext!=='native-default-unvalidated';
  return {evaluationContextConfigured:contextConfigured,
    note:'A declared id is the user\'s statement of what the host reports; nothing here checks it against a session.',
    models:config.registry.models.filter(m=>m.enabled&&config.enabledRuntimes.includes(m.runtime)).map(m=>{
      const declared=Object.hasOwn(m,'resolvesTo');
      return {id:m.id,runtime:m.runtime,model:m.model,backend:m.backend,resolvesTo:declared?[...m.resolvesTo].sort():null,
        acceptedEffectiveModels:[...new Set([m.backend,...(declared?m.resolvesTo:[])])].sort(),
        evidenceImport:!contextConfigured?'blocked:evaluation_context_not_configured':declared?'possible:exact_backend_or_declared_id':'possible:exact_backend_only'};
    })};
}
