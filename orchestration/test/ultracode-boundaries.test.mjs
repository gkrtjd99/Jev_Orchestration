import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adviseUltracode, validateAdvisorPlan } from '../src/ultracode-advisor.mjs';
import { defaultRegistry } from '../src/catalog.mjs';
import { writeJSON } from '../src/util.mjs';
import { answer, server } from './helpers.mjs';

const entry=fileURLToPath(new URL('../bin/jev-plan.mjs',import.meta.url));
const task=(id,extra={})=>({id,summary:'명시한 파일을 검사한다.',role:'implement',risk:'normal',dependsOn:[],readPaths:[],writePaths:[],...extra});
const plan=tasks=>({schema:1,goal:'기존 계약을 보존한다.',acceptance:['독립 회귀 검사가 통과한다.'],tasks});
async function fixture(t,tasks=[task('fix')]){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'jev-advisor-boundary-')));
  const project=path.join(root,'project');await fs.mkdir(project,{mode:0o700});
  const input=plan(tasks),registry=defaultRegistry();registry.models.forEach(m=>m.availability='confirmed');
  const options={project,input:path.join(root,'input.json'),registry:path.join(root,'registry.json'),envFile:path.join(root,'private.env'),runId:'boundary'};
  await writeJSON(options.input,input);await writeJSON(options.registry,registry);
  await fs.writeFile(options.envFile,'TYPESAFE_API_KEY=synthetic-boundary-key\nJEV_ALLOW_EGRESS=true\nJEV_SHARE_PLAN_CONTEXT=true\n',{mode:0o600});
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,input,registry,options};
}

for(const [a,b] of [['strasse','straße'],['σ','ς'],['s','ſ'],['µ','μ'],['É','é']])
  test(`아직 없는 Unicode 별칭의 독립 쓰기/읽기 충돌 거부: ${a}/${b}`,()=>{
    for(const reader of [false,true]){
      const tasks=[task('writer',{writePaths:[`src/${a}.mjs`]}),task('other',reader?
        {role:'review',readPaths:[`src/${b}.mjs`]}:{writePaths:[`src/${b}.mjs`]})];
      assert.throws(()=>validateAdvisorPlan(plan(tasks)),/INVALID_ADVISOR_INPUT/);
    }
  });

for(const relative of ['.ſsh/config','ſecrets.json','.ＣＬＡＵＤＥ/settings.json'])
  test('민감 경로 별칭도 정규화해 거부한다: '+relative,()=>{
    assert.throws(()=>validateAdvisorPlan(plan([task('read',{readPaths:[relative]})])),/INVALID_ADVISOR_INPUT/);
  });

test('기존 파일의 Unicode canonical 철자가 다르면 전송 전에 거부한다',async t=>{
  const f=await fixture(t,[task('read',{role:'research',readPaths:['src/ſ.mjs']})]);
  await fs.mkdir(path.join(f.options.project,'src'));
  const original=path.join(f.options.project,'src/s.mjs'),alias=path.join(f.options.project,'src/ſ.mjs');
  await fs.writeFile(original,'fixture');
  let aliasStat;try{aliasStat=await fs.stat(alias);}catch(e){if(e.code==='ENOENT'){t.skip('이 파일 시스템은 해당 Unicode 별칭을 제공하지 않음');return;}throw e;}
  assert.equal(aliasStat.ino,(await fs.stat(original)).ino);
  await assert.rejects(adviseUltracode({...f.options,dryRun:true}),/INVALID_ADVISOR_INPUT/);
});

async function firmlink(t,project){
  const alias='/System/Volumes/Data'+project;
  let actual;try{actual=await fs.stat(alias);}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR'){t.skip('macOS data-volume 별칭이 없는 파일 시스템');return null;}throw e;}
  const original=await fs.stat(project);
  if(actual.dev!==original.dev||actual.ino!==original.ino||await fs.realpath(alias)!==alias){t.skip('동일 inode의 별도 canonical 경로가 아님');return null;}
  return alias;
}

test('동일 물리 프로젝트의 firmlink 별칭도 변경 초안의 cap을 공유한다',async t=>{
  const f=await fixture(t),alias=await firmlink(t,f.options.project);if(!alias)return;
  const s=await server(t),deps={testTransport:{endpoint:s.endpoint}};
  assert.equal((await adviseUltracode(f.options,deps)).status,'ADVICE');
  f.input.goal+=' 수정된 초안.';await writeJSON(f.options.input,f.input);
  const result=await adviseUltracode({...f.options,project:alias},deps);
  assert.equal(result.reason,'request_cap');assert.equal(s.requests.length,1);
});

for(const field of ['envFile','registry'])test('프로젝트 내부 '+field+'의 firmlink 외부 위장을 거부한다',async t=>{
  const f=await fixture(t),alias=await firmlink(t,f.options.project);if(!alias)return;
  const name=path.basename(f.options[field]);await fs.copyFile(f.options[field],path.join(f.options.project,name));
  await assert.rejects(adviseUltracode({...f.options,[field]:path.join(alias,name),dryRun:true}),/INVALID_ADVISOR_INPUT/);
});

test('병렬 권고도 의존 작업이 있으면 dependency_batches로 제한한다',async t=>{
  const f=await fixture(t,[task('fix',{writePaths:['src/a.mjs']}),task('review',{role:'review',dependsOn:['fix'],readPaths:['src/a.mjs']})]);
  const s=await server(t,(req,res,body)=>res.end(JSON.stringify(answer(body.questions,{strategy:'parallel_independent'}))));
  assert.equal((await adviseUltracode(f.options,{testTransport:{endpoint:s.endpoint}})).workflow.strategy,'dependency_batches');
});

test('최대 길이 모델 ID와 task ID도 출력 4KiB를 넘지 않는다',async t=>{
  const f=await fixture(t,Array.from({length:8},(_,i)=>task('t'.repeat(31)+i)));
  f.registry.models.forEach((m,i)=>{m.model='m'.repeat(158)+String(i).padStart(2,'0');m.backend=m.model;});
  await writeJSON(f.options.registry,f.registry);const s=await server(t);
  const result=await adviseUltracode(f.options,{testTransport:{endpoint:s.endpoint}});
  assert.equal(result.status,'ADVICE');assert.ok(Buffer.byteLength(JSON.stringify(result))<=4096);
});

test('잘못된 파일 소유자는 입력 단계에서 거부한다',async t=>{
  const f=await fixture(t),original=fs.lstat;
  try{
    fs.lstat=async(file,...args)=>{const stat=await original(file,...args);if(file===f.options.envFile)stat.uid=process.getuid()+1;return stat;};
    await assert.rejects(adviseUltracode({...f.options,dryRun:true}),/INVALID_ADVISOR_INPUT/);
  }finally{fs.lstat=original;}
});

test('실제 CLI는 종료되지 않는 HTTP 오류 body도 취소하고 fallback 후 종료한다',async t=>{
  const f=await fixture(t);let responseClosed=false;
  const s=await server(t,(req,res)=>{res.on('close',()=>{responseClosed=true;});res.writeHead(429);res.write('unfinished');});
  const preload=path.join(f.root,'loopback.mjs');
  await fs.writeFile(preload,`const original=globalThis.fetch;globalThis.fetch=(url,opts)=>{if(url!=='https://api.typesafe.ai/v1/systemone')throw new Error('BLOCKED');return original(${JSON.stringify(s.endpoint+'/v1/systemone')},opts);};\n`,{mode:0o600});
  const args=['--import',preload,entry,'--project',f.options.project,'--input',f.options.input,'--registry',f.options.registry,'--env-file',f.options.envFile,'--run-id',f.options.runId];
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{env:{PATH:process.env.PATH,HOME:f.root},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},3000);
    child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr,timedOut});});
  });
  assert.equal(result.timedOut,false,'fallback 후 열린 socket 때문에 프로세스가 남아서는 안 된다');
  assert.equal(result.code,0);assert.equal(result.stderr,'');assert.equal(JSON.parse(result.stdout).reason,'jev_unavailable');
  assert.equal(s.requests.length,1);assert.equal(responseClosed,true);
});
