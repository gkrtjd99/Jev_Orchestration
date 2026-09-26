import fs from 'node:fs/promises';
import path from 'node:path';
import { profileCatalog } from './catalog.mjs';
import { sensitive } from './documents.mjs';
import { secretLike } from './safety.mjs';
import { assert, hash, object } from './util.mjs';

const phases = new Set(['research','contract','plan','implement','debug','test','tool','review','integration']);
const risks = new Set(['normal','sensitive','destructive']);
const complexities = new Set(['small','bounded','broad']);
const reasonings = new Set(['routine','deep','novel']);
const validId = /^[a-z][a-z0-9-]{0,63}$/;

function paths(value, label) {
  assert(Array.isArray(value)&&value.length<=16,`INVALID_${label}`);
  const seen=new Set();
  for(const p of value){
    assert(typeof p==='string'&&p.length<=200&&!p.includes('\\')&&!p.includes('\0')&&
      !path.posix.isAbsolute(p)&&p.split('/').every(x=>x&&x!=='.'&&x!=='..')&&
      !sensitive(p)&&!p.split('/').some(x=>['.git','.jev','.claude','.codex','node_modules'].includes(x)),`UNSAFE_${label}`);
    assert(!seen.has(p),`DUPLICATE_${label}`);seen.add(p);
  }
  return value;
}

export function validateControllerPlan(plan,goalHash){
  assert(object(plan)&&plan.schema===2&&Object.keys(plan).every(k=>['schema','goalHash','version','summary','tasks'].includes(k)),'INVALID_CONTROLLER_PLAN');
  assert(/^[a-f0-9]{64}$/.test(goalHash)&&plan.goalHash===goalHash,'PLAN_GOAL_MISMATCH');
  assert(Number.isInteger(plan.version)&&plan.version>=1&&plan.version<=10000,'INVALID_PLAN_VERSION');
  assert(typeof plan.summary==='string'&&plan.summary.trim()&&plan.summary.length<=1200,'INVALID_PLAN_SUMMARY');
  assert(Array.isArray(plan.tasks)&&plan.tasks.length>=1&&plan.tasks.length<=32,'INVALID_PLAN_TASKS');
  const byId=new Map();
  for(const t of plan.tasks){
    assert(object(t)&&Object.keys(t).every(k=>['id','phase','summary','acceptance','dependencies','readPaths','writePaths','risk','complexity','reasoning','uncertain','interfacesChanging','highLoss','information'].includes(k)),'INVALID_PLAN_TASK');
    assert(typeof t.id==='string'&&validId.test(t.id)&&!byId.has(t.id),'INVALID_PLAN_TASK_ID');
    assert(phases.has(t.phase)&&risks.has(t.risk)&&complexities.has(t.complexity)&&reasonings.has(t.reasoning),'INVALID_PLAN_CLASSIFICATION');
    assert(typeof t.summary==='string'&&t.summary.trim()&&t.summary.length<=1000&&
      typeof t.acceptance==='string'&&t.acceptance.trim()&&t.acceptance.length<=650,'INVALID_PLAN_OUTCOME');
    assert(['sufficient','missing'].includes(t.information)&&
      ['uncertain','interfacesChanging','highLoss'].every(k=>typeof t[k]==='boolean'),'INVALID_PLAN_FLAGS');
    assert(Array.isArray(t.dependencies)&&t.dependencies.length<=16&&t.dependencies.every(d=>typeof d==='string'&&validId.test(d)&&d!==t.id),'INVALID_PLAN_DEPENDENCIES');
    assert(new Set(t.dependencies).size===t.dependencies.length,'DUPLICATE_PLAN_DEPENDENCY');
    paths(t.readPaths,'READ_PATHS');paths(t.writePaths,'WRITE_PATHS');
    if(['research','contract','plan','test','review'].includes(t.phase))assert(t.writePaths.length===0,'READONLY_PHASE_HAS_WRITES');
    byId.set(t.id,t);
  }
  function ancestor(target,id,seen=new Set()){
    if(target===id)return true;
    if(seen.has(id))return false;
    seen.add(id);return byId.get(id).dependencies.some(d=>ancestor(target,d,seen));
  }
  for(const t of plan.tasks)for(const d of t.dependencies)assert(byId.has(d),'UNKNOWN_PLAN_DEPENDENCY');
  // A task depending on another may reuse a file; independent parallel tasks may not.
  for(const t of plan.tasks){
    assert(!t.dependencies.some(d=>ancestor(t.id,d)),'CYCLIC_PLAN_DEPENDENCY');
    for(const other of plan.tasks){
      if(other.id>=t.id||ancestor(other.id,t.id)||ancestor(t.id,other.id))continue;
      assert(!t.writePaths.some(p=>other.writePaths.some(q=>p===q||p.startsWith(q+'/')||q.startsWith(p+'/'))),
        'PARALLEL_WRITE_OWNERSHIP_CONFLICT');
    }
  }
  return plan;
}

export async function loadControllerPlan(project,goalHash,apiKey=''){
  const dir=path.join(project,'.jev'),file=path.join(dir,'controller-plan.json');
  let parent,stat;
  try{parent=await fs.lstat(dir);stat=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  assert(parent.isDirectory()&&!parent.isSymbolicLink()&&stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=32768,'UNSAFE_CONTROLLER_PLAN_PATH');
  if(process.platform!=='win32'){
    assert((parent.mode&0o077)===0&&(stat.mode&0o022)===0,'PLAN_REQUIRES_PRIVATE_DIRECTORY');
    if(typeof process.getuid==='function')assert(parent.uid===process.getuid()&&stat.uid===process.getuid(),'PLAN_OWNER_MISMATCH');
  }
  const handle=await fs.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  let text;
  try{
    const opened=await handle.stat();
    assert(opened.isFile()&&opened.dev===stat.dev&&opened.ino===stat.ino&&opened.size<=32768,'PLAN_CHANGED_DURING_READ');
    text=await handle.readFile('utf8');
  }finally{await handle.close();}
  assert(!secretLike(text,apiKey),'SECRET_GUARD');
  const plan=validateControllerPlan(JSON.parse(text),goalHash);
  return {plan,revision:hash(text)};
}

export function selectControllerProfile(registry,task,{allowMaxEffort=true}={}){
  if(task.information==='missing')return {deferred:true,reason:'gather_missing_evidence'};
  let role='implement',slot='standard',effort='xhigh',reason='bounded_work';
  switch(task.phase){
    case 'research': role='research';slot='light';effort='high';reason='evidence_collection';break;
    case 'contract': role='review';reason='contract_interpretation';break;
    case 'plan': role='plan';slot='strategic';reason='strategic_planning';break;
    case 'implement':
      effort=task.complexity==='small'&&task.reasoning==='routine'?'high':'xhigh';
      reason='approved_contract_implementation';break;
    case 'debug':
      effort=task.reasoning==='deep'&&task.complexity==='bounded'&&allowMaxEffort?'max':'xhigh';reason='bounded_causal_analysis';break;
    case 'test': role='review';reason='independent_test_design';break;
    case 'tool': effort='high';reason='run_actual_checks';break;
    case 'review': role='review';reason='independent_patch_review';break;
    case 'integration': slot='strategic';reason='cross_patch_integration';break;
    default: throw new Error('INVALID_CONTROLLER_PHASE');
  }
  if(task.interfacesChanging||task.reasoning==='novel'||task.highLoss){
    slot='strategic';effort='xhigh';reason='strategic_boundary_or_loss';
    if(task.phase==='research'||task.phase==='contract'||task.phase==='test')role='plan';
  }
  if(task.risk==='sensitive'||task.risk==='destructive'){
    if(slot==='light'){slot='standard';effort='xhigh';reason='sensitive_evidence_collection';}
    else if(slot==='standard'&&effort==='high'){effort='xhigh';reason='sensitive_quality_floor';}
  }
  if(task.uncertain){
    if(slot==='light'){slot='standard';effort='xhigh';reason='uncertain_evidence_collection';}
    else if(slot==='standard'&&effort==='high'){effort='xhigh';reason='uncertain_quality_floor';}
  }
  if(task.risk==='destructive'&&task.phase!=='research')return {deferred:true,reason:'destructive_work_requires_human_approval'};
  const p=profileCatalog(registry,'claude').find(p=>p.role===role&&p.slot===slot&&p.effort===effort&&p.availability==='confirmed');
  if(!p)return {deferred:true,reason:'confirmed_profile_unavailable',requested:{role,slot,effort}};
  return {profile:p,reason,deferred:false};
}

export function bootstrapTask(phase){
  const values={research:{phase:'research',complexity:'small',reasoning:'routine'},contract:{phase:'contract',complexity:'bounded',reasoning:'deep'},plan:{phase:'plan',complexity:'broad',reasoning:'novel'}};
  const v=values[phase];if(!v)return null;
  return {...v,information:'sufficient',risk:'normal',uncertain:false,interfacesChanging:false,highLoss:false};
}
