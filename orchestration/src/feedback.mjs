/** Only explicitly imported independent evaluations can affect measured routing. */
import path from 'node:path';
import { assert, object, hash, readJSON, writeJSON, withLock } from './util.mjs';
import { profileCatalog } from './catalog.mjs';
export const evidenceFile = config => path.join(config.stateDir,'evaluations','accepted.json');
export async function readEvidence(config) {
  const data=await readJSON(evidenceFile(config),{schema:1,rows:[]});
  assert(data.schema===1&&Array.isArray(data.rows)&&data.rows.length<=20000,'INVALID_EVIDENCE_STORE');
  return {rows:data.rows,revision:hash(data.rows)};
}
export function validateEvaluation(row,config) {
  assert(object(row)&&row.schema===1&&row.kind==='live-evaluation','LIVE_EVALUATION_REQUIRED');
  for(const k of ['taskId','taskClass','context'])assert(typeof row[k]==='string'&&row[k].length>0&&row[k].length<=200,`INVALID_EVIDENCE_${k}`);
  for(const k of ['projectHash','profileFingerprint'])assert(/^[a-f0-9]{64}$/.test(row[k]),`INVALID_EVIDENCE_${k}`);
  assert(Number.isInteger(row.createdAt)&&row.createdAt>0&&row.createdAt<=Date.now()+60000,'INVALID_EVIDENCE_TIMESTAMP');
  const p=profileCatalog(config.registry,row.runtime).find(p=>p.profileId===row.profileId);
  assert(p&&p.fingerprint===row.profileFingerprint,'STALE_EVIDENCE_PROFILE');
  assert(row.effective?.confirmed===true&&['native-transcript','provider-metadata'].includes(row.effective.source),'EFFECTIVE_SETTING_NOT_CONFIRMED');
  assert(row.effective.model===p.backend&&row.effective.effort===p.effort,'EFFECTIVE_SETTING_MISMATCH');
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
const unitKey=r=>hash([r.context,r.projectHash,r.taskId,r.profileId]);
export async function importEvaluations(config,rows,{acceptEvidence=false}={}) {
  assert(acceptEvidence,'EXPLICIT_EVIDENCE_ACCEPTANCE_REQUIRED');
  assert(Array.isArray(rows)&&rows.length>0&&rows.length<=5000,'INVALID_EVIDENCE_BATCH');
  rows.forEach(r=>validateEvaluation(r,config));
  return withLock(evidenceFile(config)+'.lock',async()=>{
    const old=await readEvidence(config);const map=new Map(old.rows.map(r=>[unitKey(r),r]));let added=0;
    for(const row of rows) {
      const key=unitKey(row),prev=map.get(key);
      assert(!prev||hash(prev)===hash(row),'CONFLICTING_EVALUATION_UNIT');
      if(!prev){map.set(key,row);added++;}
    }
    assert(map.size<=20000,'EVIDENCE_STORE_LIMIT');
    const all=[...map.values()];await writeJSON(evidenceFile(config),{schema:1,rows:all});
    return {added,duplicate:rows.length-added,total:all.length,revision:hash(all)};
  });
}
