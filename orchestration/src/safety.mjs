/** Local policy gates, not model judgments or an OS security boundary. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {assert, hash, object} from './util.mjs';
export const safetyDefaults=()=>({allowEgress:false,codexRewriteApproved:false,codexCollaborationRewriteApproved:false,
  retainPromptText:false,sharePlanContext:false,allowEconomy:false,allowMaxEffort:true,
  workflowPolicy:'warn',approvedEndpoints:['https://api.typesafe.ai']});
export async function readPrivateEnv(file){
  const s=await fs.lstat(file);
  assert(s.isFile()&&!s.isSymbolicLink(),'ENV_MUST_BE_REGULAR_FILE');
  assert(s.size<=32768,'ENV_TOO_LARGE');
  if(process.platform!=='win32'){
    assert((s.mode&0o077)===0,'ENV_REQUIRES_MODE_600');
    if(typeof process.getuid==='function')assert(s.uid===process.getuid(),'ENV_OWNER_MISMATCH');
  }
  return fs.readFile(file,'utf8');
}
export function applySafetyEnvironment(c,get){
  c.safety={...safetyDefaults(),...c.safety};
  for(const [key,field] of Object.entries({JEV_ALLOW_EGRESS:'allowEgress',JEV_CODEX_REWRITE_APPROVED:'codexRewriteApproved',
    JEV_CODEX_COLLABORATION_REWRITE_APPROVED:'codexCollaborationRewriteApproved',
    JEV_RETAIN_PROMPT_TEXT:'retainPromptText',JEV_SHARE_PLAN_CONTEXT:'sharePlanContext',
    JEV_ALLOW_ECONOMY_CANDIDATES:'allowEconomy',JEV_MAX_EFFORT_ALLOWED:'allowMaxEffort'})){
    const v=get(key);if(v===undefined||v==='')continue;
    assert(v==='true'||v==='false','INVALID_'+key);c.safety[field]=v==='true';
  }
  const workflowPolicy=get('JEV_WORKFLOW_POLICY');
  if(workflowPolicy!==undefined&&workflowPolicy!==''){
    assert(['warn','block'].includes(workflowPolicy),'INVALID_JEV_WORKFLOW_POLICY');
    c.safety.workflowPolicy=workflowPolicy;
  }
}
export function validateSafety(c){
  assert(object(c.safety),'MISSING_SAFETY_CONFIGURATION');
  for(const k of ['allowEgress','codexRewriteApproved','codexCollaborationRewriteApproved','retainPromptText','sharePlanContext','allowEconomy','allowMaxEffort'])assert(typeof c.safety[k]==='boolean','INVALID_SAFETY_'+k);
  assert(['warn','block'].includes(c.safety.workflowPolicy),'INVALID_WORKFLOW_POLICY');
  assert(!c.safety.codexCollaborationRewriteApproved||c.safety.codexRewriteApproved,'COLLABORATION_REWRITE_REQUIRES_CODEX_APPROVAL');
  assert(Array.isArray(c.safety.approvedEndpoints)&&c.safety.approvedEndpoints.every(x=>typeof x==='string'&&new URL(x).protocol==='https:'),'INVALID_ENDPOINT_ALLOWLIST');
  const u=new URL(c.endpoint);
  const loop=c.allowLoopback===true&&u.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(u.hostname);
  assert(loop||c.safety.approvedEndpoints.includes(u.origin)&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password,'ENDPOINT_NOT_APPROVED');
}
export function secretLike(text,key=''){
  return !!key&&text.includes(key)||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)||
    /\b(?:sk-|sk-ant-|tsf_|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{16,}/.test(text)||
    /(?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[:=]\s*["']?[^\s"']{8,}/i.test(text);
}
export function explicitNativeSettings(e,d){
  if(d.managed)return false;
  return ['model','reasoning_effort','effort','model_reasoning_effort'].some(k=>Object.hasOwn(e.input,k));
}
export function applicationGuard(e,d,c){
  if(e.agent_id||e.agent_type)return 'NESTED_DELEGATION_PRESERVED';
  if(explicitNativeSettings(e,d))return 'EXPLICIT_NATIVE_SETTINGS_PRESERVED';
  if(e.permission_mode==='plan'&&!['Plan','Explore','explorer'].includes(d.kind))return 'PLAN_MODE_PRESERVED';
  if(e.runtime==='codex'){
    const known=new Set(['message','agent_type','model','reasoning_effort','task_name','fork_turns','fork_context']);
    if(Object.keys(e.input).some(k=>!known.has(k)))return 'UNREVIEWED_CODEX_INPUT_PRESERVED';
  }
  return null;
}
export const applicationFingerprint=c=>hash({safety:c.safety,installed:c.installedProfiles,documents:c.requiredDocuments,
  maxDocuments:c.maxDocuments,readAdvice:c.readAdvice,endpoint:c.endpoint,model:c.model});
