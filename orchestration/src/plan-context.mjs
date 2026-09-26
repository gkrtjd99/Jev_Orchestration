import fs from 'node:fs/promises';
import path from 'node:path';
import {assert, hash, object} from './util.mjs';
import {secretLike} from './safety.mjs';

// Only a deliberately written, goal-bound plan is eligible for external classification.
export async function planContext(project,goalHash,apiKey){
  const dir=path.join(project,'.jev');
  const file=path.join(dir,'routing-plan.json');
  let parent,stat;
  try{parent=await fs.lstat(dir);stat=await fs.lstat(file);}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
  assert(parent.isDirectory()&&!parent.isSymbolicLink()&&stat.isFile()&&!stat.isSymbolicLink(),'UNSAFE_PLAN_PATH');
  assert(stat.size<=4096,'PLAN_TOO_LARGE');
  if(process.platform!=='win32'){
    assert((stat.mode&0o077)===0,'PLAN_REQUIRES_MODE_600');
    if(typeof process.getuid==='function')assert(stat.uid===process.getuid(),'PLAN_OWNER_MISMATCH');
  }
  const handle=await fs.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  let text;
  try{
    const opened=await handle.stat();
    assert(opened.isFile()&&opened.dev===stat.dev&&opened.ino===stat.ino&&opened.size<=4096,'PLAN_CHANGED_DURING_READ');
    text=await handle.readFile('utf8');
  }finally{await handle.close();}
  const plan=JSON.parse(text);
  assert(object(plan)&&Object.keys(plan).every(k=>['schema','goalHash','summary','acceptance','delegations'].includes(k)),'INVALID_PLAN');
  assert(plan.schema===1&&typeof goalHash==='string'&&/^[0-9a-f]{64}$/.test(goalHash)&&plan.goalHash===goalHash,'PLAN_GOAL_MISMATCH');
  assert(typeof plan.summary==='string'&&plan.summary.trim()&&plan.summary.length<=1200,'INVALID_PLAN_SUMMARY');
  assert(typeof plan.acceptance==='string'&&plan.acceptance.length<=600,'INVALID_PLAN_ACCEPTANCE');
  assert(Array.isArray(plan.delegations)&&plan.delegations.length<=8&&plan.delegations.every(x=>typeof x==='string'&&x.length>0&&x.length<=160),'INVALID_PLAN_DELEGATIONS');
  assert(!secretLike(text,apiKey),'SECRET_GUARD');
  return {revision:hash(text),context:{summary:plan.summary,acceptance:plan.acceptance,delegations:plan.delegations}};
}
