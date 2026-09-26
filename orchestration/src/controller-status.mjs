import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, hash, object } from './util.mjs';
import { secretLike } from './safety.mjs';

const digest=/^[a-f0-9]{64}$/;
const taskId=/^[a-z][a-z0-9-]{0,63}$/;

export async function loadControllerStatus(project,goalHash,planRevision,plan,store,apiKey='',epoch=0){
  const dir=path.join(project,'.jev'),file=path.join(dir,'controller-status.json');
  let parent,stat;
  try{parent=await fs.lstat(dir);stat=await fs.lstat(file);}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
  assert(parent.isDirectory()&&!parent.isSymbolicLink()&&stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=32768,
    'UNSAFE_CONTROLLER_STATUS_PATH');
  if(process.platform!=='win32'){
    assert((parent.mode&0o077)===0&&(stat.mode&0o022)===0,'STATUS_REQUIRES_PRIVATE_DIRECTORY');
    if(typeof process.getuid==='function')assert(parent.uid===process.getuid()&&stat.uid===process.getuid(),'STATUS_OWNER_MISMATCH');
  }
  const handle=await fs.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  let text;
  try{
    const opened=await handle.stat();
    assert(opened.isFile()&&opened.dev===stat.dev&&opened.ino===stat.ino&&opened.size<=32768,
      'STATUS_CHANGED_DURING_READ');
    text=await handle.readFile('utf8');
  }finally{await handle.close();}
  assert(!secretLike(text,apiKey),'SECRET_GUARD');
  const status=JSON.parse(text);
  assert(object(status)&&Object.keys(status).every(k=>['schema','goalHash','planRevision','accepted'].includes(k))&&
    status.schema===1&&status.goalHash===goalHash&&digest.test(status.goalHash)&&
    status.planRevision===planRevision&&digest.test(status.planRevision)&&
    Array.isArray(status.accepted)&&status.accepted.length<=32,'INVALID_CONTROLLER_STATUS');
  const taskIds=new Set(plan.tasks.map(t=>t.id)),accepted=new Set();
  const events=await store.events();
  for(const item of status.accepted){
    assert(object(item)&&Object.keys(item).every(k=>['taskId','toolUseId','agentId','evidenceHash'].includes(k))&&
      taskId.test(item.taskId)&&taskIds.has(item.taskId)&&!accepted.has(item.taskId)&&
      typeof item.toolUseId==='string'&&item.toolUseId.length>0&&item.toolUseId.length<=256&&
      typeof item.agentId==='string'&&item.agentId.length>0&&item.agentId.length<=256&&
      digest.test(item.evidenceHash),'INVALID_CONTROLLER_ACCEPTANCE');
    const routed=await store.getTask(item.toolUseId);
    assert(routed?.planRevision===planRevision&&routed?.taskId===item.taskId&&routed?.epoch===epoch,
      'ACCEPTANCE_ROUTE_MISMATCH');
    const route=events.find(e=>e.time>=epoch&&e.type==='route'&&e.taskId===item.toolUseId&&
      e.planTaskId===item.taskId&&e.planRevision===planRevision);
    const response=events.find(e=>route&&e.time>=route.time&&e.type==='spawn_observed'&&
      e.taskId===item.toolUseId&&e.agentId===item.agentId&&!e.failed);
    const started=events.find(e=>route&&e.time>=route.time&&e.type==='agent_started'&&e.agentId===item.agentId);
    const stopped=events.find(e=>started&&e.time>=started.time&&e.type==='agent_stopped'&&e.agentId===item.agentId);
    // Synchronous native Agent emits SubagentStop before PostToolUse; response links its agentId to this route.
    assert(route&&response&&started&&stopped,'ACCEPTANCE_WORKER_NOT_OBSERVED');
    // EvidenceHash is Main's attestation to a check artifact, not a check executed by this hook.
    accepted.add(item.taskId);
  }
  return {accepted,revision:hash(text),verification:'main_attested_worker_observed_not_independently_checked'};
}
