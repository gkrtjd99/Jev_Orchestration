import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adviseUltracode, advisorCandidates, validateAdvisorPlan, ADVISOR_LIMITS } from '../src/ultracode-advisor.mjs';
import { defaultRegistry } from '../src/catalog.mjs';
import { hash, writeJSON } from '../src/util.mjs';
import { QUESTION_VERSION } from '../src/questions.mjs';
import { answer, server, child } from './helpers.mjs';

const entry=fileURLToPath(new URL('../bin/jev-plan.mjs',import.meta.url));
const KEY='fixture-only-advisor-key';
const task=(id='change',extra={})=>({id,summary:'작은 알림 표시를 구현한다.',role:'implement',risk:'normal',
  dependsOn:[],readPaths:['docs/api.md'],writePaths:['src/button.mjs'],...extra});
const plan=()=>({schema:1,goal:'사용자의 알림 표시 요구를 충족한다.',acceptance:['알림 표시의 회귀 검사가 통과한다.'],tasks:[task()]});
const registry=()=>{const r=defaultRegistry();r.models.forEach(m=>m.availability='confirmed');return r;};
async function fixture(t,{env=`TYPESAFE_API_KEY=${KEY}\nJEV_ALLOW_EGRESS=true\nJEV_SHARE_PLAN_CONTEXT=true\n`,input=plan(),catalog=registry()}={}){
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'jev-plan-test-'));
  const root=await fs.realpath(temporary),project=path.join(root,'project');
  await fs.mkdir(project,{mode:0o700});
  const options={project,input:path.join(root,'input.json'),registry:path.join(root,'registry.json'),envFile:path.join(root,'private.env'),runId:'run-1'};
  await writeJSON(options.input,input);await writeJSON(options.registry,catalog);await fs.writeFile(options.envFile,env,{mode:0o600});
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,options,input,catalog,state:path.join(project,'.jev','ultracode-advice')};
}
function mock(overrides={},mutate=r=>r){
  const calls=[];
  return {calls,clientFactory:(cfg,key)=>({async evaluate(state,questions,scope,limits){
    calls.push({cfg,key,state,questions,scope,limits});
    return {response:mutate(answer(questions,{information:'sufficient',strategy:'preserve',reading:'preserve',...overrides})),cached:false,latencyMs:0};
  }})};
}
const flags=f=>['--project',f.options.project,'--input',f.options.input,'--registry',f.options.registry,'--env-file',f.options.envFile,'--run-id',f.options.runId];
const exists=async file=>{try{await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
async function snapshot(root){
  const records=[];
  async function walk(dir){
    for(const name of (await fs.readdir(dir)).sort()){
      const file=path.join(dir,name),s=await fs.lstat(file);records.push([path.relative(root,file),s.mode,s.size,s.mtimeMs]);
      if(s.isDirectory())await walk(file);
    }
  }
  await walk(root);return records;
}

for(const [label,env,reason] of [
  ['egress 미동의',`TYPESAFE_API_KEY=${KEY}\nJEV_SHARE_PLAN_CONTEXT=true\n`,'egress_not_approved'],
  ['context 미동의',`TYPESAFE_API_KEY=${KEY}\nJEV_ALLOW_EGRESS=true\n`,'plan_context_not_approved'],
  ['ambient 키만 있음','JEV_ALLOW_EGRESS=true\nJEV_SHARE_PLAN_CONTEXT=true\n','missing_key'],
  ['ambient 동의만 있음',`TYPESAFE_API_KEY=${KEY}\n`,'egress_not_approved']
])test(label+'이면 0 calls, 0 state writes',async t=>{
  const f=await fixture(t,{env}),m=mock();
  const old={...process.env};
  Object.assign(process.env,{TYPESAFE_API_KEY:'ambient-only-key',JEV_ALLOW_EGRESS:'true',JEV_SHARE_PLAN_CONTEXT:'true'});
  try{
    const result=await adviseUltracode(f.options,m);
    assert.equal(result.status,'FALLBACK');assert.equal(result.reason,reason);assert.equal(m.calls.length,0);
    assert.deepEqual(result.usage,{input_tokens:null,output_tokens:null});assert.equal(await exists(f.state),false);
  }finally{for(const k of ['TYPESAFE_API_KEY','JEV_ALLOW_EGRESS','JEV_SHARE_PLAN_CONTEXT']){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}}
});

test('dry-run은 정확한 요청 bytes/hash만 남기고 calls/writes가 없다',async t=>{
  const f=await fixture(t),m=mock(),before=await snapshot(f.root);
  const dry=await adviseUltracode({...f.options,dryRun:true},m);
  assert.equal(dry.status,'DRY_RUN');assert.equal(dry.eligible,true);assert.equal(m.calls.length,0);
  assert.deepEqual(await snapshot(f.root),before);assert.ok(!JSON.stringify(dry).includes(f.input.goal));
  await adviseUltracode(f.options,m);
  const c=m.calls[0],payload=JSON.stringify({model:c.cfg.model,state:c.state,questions:c.questions});
  assert.equal(dry.request_bytes,Buffer.byteLength(payload));assert.equal(dry.request_hash,hash(payload));
  assert.ok(dry.request_bytes<=ADVISOR_LIMITS.requestBytes);
  assert.equal(c.cfg.circuit.maxRequestsPerSession,1);
  assert.ok(Object.hasOwn(c.questions,'task_0'));assert.ok(Object.hasOwn(c.questions,'information'));
  assert.equal(c.state.input_hash,dry.input_hash);assert.equal(c.state.tasks[0].task_hash,hash(f.input.tasks[0]));
});

test('dry-run은 지원/동의 부재도 전송 없이 보고한다',async t=>{
  const f=await fixture(t,{env:'',catalog:defaultRegistry()}),m=mock(),before=await snapshot(f.root);
  const r=await adviseUltracode({...f.options,dryRun:true},m);
  assert.equal(r.eligible,false);assert.deepEqual(r.reasons,['egress_not_approved','plan_context_not_approved','missing_key','unsupported_capability']);
  assert.equal(m.calls.length,0);assert.deepEqual(await snapshot(f.root),before);
});

test('registry 모델을 그대로 쓰며 ambient/explicit 모델 및 endpoint override는 무시한다',async t=>{
  const r=registry();r.models.find(m=>m.runtime==='claude'&&m.slot==='light').model='confirmed-custom-model';
  const f=await fixture(t,{catalog:r,env:`TYPESAFE_API_KEY=${KEY}\nJEV_ALLOW_EGRESS=true\nJEV_SHARE_PLAN_CONTEXT=true\nTYPESAFE_BASE_URL=http://127.0.0.1:1\nJEV_MODEL=forged-jev\nJEV_CLAUDE_LIGHT_MODEL=forged-worker\n`});
  const m=mock(),result=await adviseUltracode(f.options,m);
  assert.equal(m.calls[0].cfg.endpoint,'https://api.typesafe.ai');assert.equal(m.calls[0].cfg.model,'jev-latest');
  assert.equal(result.tasks[0].requested.model,'confirmed-custom-model');assert.equal(result.tasks[0].requested.effort,'xhigh');
  assert.equal(result.applied,false);assert.equal(result.observed,null);assert.equal(result.tasks[0].reason,'requested_not_observed');
});

for(const role of ['research','plan','implement','review','integration'])for(const risk of ['normal','sensitive','unknown'])
  test(`quality floor: ${role}/${risk}`,()=>{
    const candidates=advisorCandidates(registry(),task('work',{role,risk}));assert.ok(candidates.length);
    for(const p of candidates){
      assert.ok(['high','xhigh','max'].includes(p.effort));assert.notEqual(p.slot,'micro');
      if(['plan','integration'].includes(role)){assert.equal(p.slot,'strategic');assert.ok(['xhigh','max'].includes(p.effort));}
      if(role==='review'||risk!=='normal'){assert.ok(['standard','strategic'].includes(p.slot));assert.ok(['xhigh','max'].includes(p.effort));}
      if(role==='implement'&&risk==='normal'&&p.slot==='light')assert.ok(['xhigh','max'].includes(p.effort));
    }
  });

test('실제 catalog role/effort 없는 capability는 만들어 내지 않는다',async t=>{
  const r=registry();
  for(const m of r.models){m.roles=['implement'];m.supportedEfforts=['high'];m.effortByIntent={brief:'high'};}
  assert.deepEqual(advisorCandidates(r,task('x',{role:'research'})),[]);
  assert.deepEqual(advisorCandidates(r,task('x',{role:'integration'})),[]);
  const f=await fixture(t,{catalog:r,input:{...plan(),tasks:[task('x',{role:'review',writePaths:[]})]}}),m=mock();
  const result=await adviseUltracode(f.options,m);
  assert.equal(result.reason,'unsupported_capability');assert.equal(m.calls.length,0);assert.equal(await exists(f.state),false);
});
for(const availability of ['declared','unavailable'])test(availability+' registry는 권고에 사용하지 않는다',async t=>{
  const r=registry();r.models.forEach(m=>m.availability=availability);
  const f=await fixture(t,{catalog:r}),m=mock();const result=await adviseUltracode(f.options,m);
  assert.equal(result.status,'FALLBACK');assert.equal(m.calls.length,0);
});

test('일부 task의 capability만 없으면 그 task만 기본값을 유지한다',async t=>{
  const r=registry();r.models.filter(m=>m.slot==='strategic').forEach(m=>m.availability='unavailable');
  const input=plan();input.tasks.push(task('integrate',{role:'integration',dependsOn:['change']}));
  const f=await fixture(t,{catalog:r,input}),m=mock();const result=await adviseUltracode(f.options,m);
  assert.equal(m.calls.length,1);assert.ok(result.tasks[0].requested);assert.equal(result.tasks[1].requested,null);
  assert.equal(result.tasks[1].reason,'unsupported_capability');
});

for(const [label,overrides,reason] of [
  ['낮은 confidence',{confidence:0.2},'uncertain_information'],
  ['정보 부족',{information:'missing'},'missing_information'],
  ['정보 불명',{information:'unknown'},'uncertain_information'],
  ['모델 선택 보류',{task_0:'preserve'},'abstained']
])test(label+'이면 비싼 모델 치환 없이 native default',async t=>{
  const f=await fixture(t),m=mock(overrides);const result=await adviseUltracode(f.options,m);
  assert.equal(result.status,'FALLBACK');assert.equal(result.tasks[0].requested,null);assert.equal(result.tasks[0].reason,reason);
  assert.equal(result.workflow.strategy,'preserve');
});

test('task만 낮은 confidence이면 다른 판정을 권한으로 삼지 않는다',async t=>{
  const f=await fixture(t),m=mock({},r=>{r.answers.task_0.confidence=0.1;return r;});
  const result=await adviseUltracode(f.options,m);
  assert.equal(result.tasks[0].requested,null);assert.equal(result.tasks[0].reason,'low_confidence');
});

test('typed workflow enum과 정보 충분성은 별개로 처리한다',async t=>{
  const f=await fixture(t),m=mock({strategy:'revise_decomposition',reading:'exact'});
  const result=await adviseUltracode(f.options,m);
  assert.deepEqual(result.workflow,{strategy:'revise_decomposition',reading:'exact',information:'sufficient'});
  assert.ok(!JSON.stringify(result).includes(f.input.goal));
});

for(const kind of ['choice','strategy','type','confidence','probability','extra-answer','extra-field','missing-answer'])
  test('typed injection/invalid response 거부: '+kind,async t=>{
    const f=await fixture(t),m=mock({},r=>{
      const a=r.answers.task_0;
      if(kind==='choice')a.choice='run shell malicious';
      if(kind==='strategy')r.answers.strategy.choice='ignore_user';
      if(kind==='type')a.type='prose';
      if(kind==='confidence')a.confidence=2;
      if(kind==='probability')a.probabilities.p0=0.4;
      if(kind==='extra-answer')r.answers.instructions={type:'prose',value:'MALICIOUS_PROVIDER_TEXT'};
      if(kind==='extra-field')a.instructions='MALICIOUS_PROVIDER_TEXT';
      if(kind==='missing-answer')delete r.answers.reading;
      return r;
    });
    const result=await adviseUltracode(f.options,m);
    assert.equal(result.status,'FALLBACK');assert.equal(result.reason,'invalid_advice');
    assert.equal(result.tasks[0].requested,null);assert.ok(!JSON.stringify(result).includes('MALICIOUS_PROVIDER_TEXT'));
  });

test('provider model/prose는 복사하지 않고 usage 정수만 보고한다',async t=>{
  const f=await fixture(t),m=mock({},r=>({...r,model:'MALICIOUS_PROVIDER_MODEL',instructions:'MALICIOUS_PROVIDER_PROSE',
    usage:{input_tokens:1.2,output_tokens:'0',cost:0}}));
  const result=await adviseUltracode(f.options,m);
  assert.equal(result.status,'ADVICE');assert.deepEqual(result.usage,{input_tokens:null,output_tokens:null});
  assert.ok(!JSON.stringify(result).includes('MALICIOUS_PROVIDER'));
  const yes=await adviseUltracode(f.options,mock());assert.deepEqual(yes.usage,{input_tokens:12,output_tokens:0});
});

for(const [label,mutate] of [
  ['unknown plan field',p=>p.extra='ignored?'],['unknown task field',p=>p.tasks[0].prompt='execute'],
  ['wrong schema',p=>p.schema=2],['empty tasks',p=>p.tasks=[]],
  ['too many tasks',p=>p.tasks=Array.from({length:9},(_,i)=>task('t'+i,{writePaths:[]}))],
  ['duplicate id',p=>p.tasks.push({...p.tasks[0]})],['missing dependency',p=>p.tasks[0].dependsOn=['missing']],
  ['duplicate dependency',p=>p.tasks[0].dependsOn=['other','other']],
  ['self dependency',p=>p.tasks[0].dependsOn=['change']],
  ['cycle',p=>{p.tasks[0].dependsOn=['other'];p.tasks.push(task('other',{dependsOn:['change']}));}],
  ['write/write conflict',p=>p.tasks.push(task('other'))],
  ['directory write conflict',p=>p.tasks.push(task('other',{writePaths:['src']}))],
  ['case-folded write conflict',p=>p.tasks.push(task('other',{writePaths:['SRC/Button.mjs']}))],
  ['unicode write conflict',p=>{p.tasks[0].writePaths=['src/café.mjs'];p.tasks.push(task('other',{writePaths:['src/café.mjs']}));}],
  ['read/write conflict',p=>p.tasks.push(task('other',{role:'review',readPaths:['src/button.mjs'],writePaths:[]}))],
  ['readonly writes',p=>p.tasks[0].role='review'],['relative escape',p=>p.tasks[0].readPaths=['../other']],
  ['absolute path',p=>p.tasks[0].writePaths=['/etc/file']],['windows escape',p=>p.tasks[0].readPaths=['..\\other']],
  ['wildcard',p=>p.tasks[0].readPaths=['src/*']],['sensitive file',p=>p.tasks[0].readPaths=['config/.env.local']],
  ['sensitive pem',p=>p.tasks[0].readPaths=['cert.pem']],['settings path',p=>p.tasks[0].writePaths=['.claude/settings.json']],
  ['duplicate path',p=>p.tasks[0].readPaths=['a','a']],['empty acceptance',p=>p.acceptance=[]],
  ['goal byte bound',p=>p.goal='가'.repeat(700)],['summary byte bound',p=>p.tasks[0].summary='가'.repeat(350)],
  ['acceptance byte bound',p=>p.acceptance=['a'.repeat(513)]],['secret text',p=>p.goal='password=NOT_FOR_EGRESS_VALUE'],
  ['actual private key',p=>p.tasks[0].summary=KEY],
  ['quoted goal secret',p=>p.goal='password="SYNTHETIC_TEST_PASSWORD"'],
  ['quoted acceptance secret',p=>p.acceptance=['api_key="SYNTHETIC_TEST_VALUE"']],
  ['quoted summary secret',p=>p.tasks[0].summary='secret="SYNTHETIC_TEST_VALUE"'],
  ['quoted path secret',p=>p.tasks[0].readPaths=['docs/password="SYNTHETIC_TEST_VALUE"']]
])test('invalid plan: '+label,async t=>{
  const input=plan();mutate(input);
  const f=await fixture(t,{input}),m=mock();
  await assert.rejects(adviseUltracode(f.options,m),/^Error: INVALID_ADVISOR_INPUT$/);
  assert.equal(m.calls.length,0);assert.equal(await exists(f.state),false);
});

test('의존 순서가 있으면 겹치는 read/write 경로도 유효하다',()=>{
  const p=plan();p.tasks.push(task('review',{role:'review',readPaths:['src/button.mjs'],writePaths:[],dependsOn:['change']}));
  assert.deepEqual(validateAdvisorPlan(p),p);
});

test('총 입력 byte bound는 개별 한도를 통과하는 계획에도 적용된다',()=>{
  const p=plan();p.goal='g'.repeat(2048);p.acceptance=Array(8).fill('a'.repeat(512));
  p.tasks=Array.from({length:8},(_,i)=>task('t'+i,{summary:'s'.repeat(1024),writePaths:[],
    readPaths:Array.from({length:8},(_,j)=>`docs/${i}-${j}-${'a'.repeat(180)}.md`)}));
  assert.throws(()=>validateAdvisorPlan(p),/INVALID_ADVISOR_INPUT/);
});

for(const name of ['input','registry','envFile'])for(const unsafe of ['symlink','public','directory','hardlink'])
  test(`safe file guard: ${name}/${unsafe}`,async t=>{
    const f=await fixture(t),file=f.options[name],m=mock();
    if(unsafe==='public')await fs.chmod(file,0o644);
    if(unsafe==='symlink'){await fs.rename(file,file+'.target');await fs.symlink(file+'.target',file);}
    if(unsafe==='directory'){await fs.rm(file);await fs.mkdir(file);}
    if(unsafe==='hardlink')await fs.link(file,file+'.linked');
    await assert.rejects(adviseUltracode(f.options,m),/INVALID_ADVISOR_INPUT/);assert.equal(m.calls.length,0);
  });

for(const field of ['envFile','registry'])test(field+'은 프로젝트 안에 두지 않는다',async t=>{
  const f=await fixture(t),inside=path.join(f.options.project,path.basename(f.options[field]));await fs.copyFile(f.options[field],inside);
  await assert.rejects(adviseUltracode({...f.options,[field]:inside},mock()),/INVALID_ADVISOR_INPUT/);
});

test('입력과 프로젝트의 symlink ancestor 및 실제 task 경로 탈출을 거부한다',async t=>{
  const f=await fixture(t),link=path.join(f.root,'linked');await fs.symlink(f.options.project,link);
  await assert.rejects(adviseUltracode({...f.options,project:link},mock()),/INVALID_ADVISOR_INPUT/);
  const files=path.join(f.root,'files');await fs.mkdir(files);await fs.rename(f.options.input,path.join(files,'input.json'));
  const linkedFiles=path.join(f.root,'linked-files');await fs.symlink(files,linkedFiles);
  await assert.rejects(adviseUltracode({...f.options,input:path.join(linkedFiles,'input.json')},mock()),/INVALID_ADVISOR_INPUT/);
  await fs.rename(path.join(files,'input.json'),f.options.input);
  await fs.symlink(f.root,path.join(f.options.project,'src'));
  await assert.rejects(adviseUltracode(f.options,mock()),/INVALID_ADVISOR_INPUT/);
});

test('hardlink 별칭의 독립 읽기/쓰기 충돌을 전송 전에 거부한다',async t=>{
  const input=plan();input.tasks[0].writePaths=['src/foo.mjs'];
  input.tasks.push(task('inspect',{role:'review',readPaths:['src/alias.mjs'],writePaths:[]}));
  const f=await fixture(t,{input}),m=mock({strategy:'parallel_independent'});
  await fs.mkdir(path.join(f.options.project,'src'));
  await fs.writeFile(path.join(f.options.project,'src/foo.mjs'),'original');
  await fs.link(path.join(f.options.project,'src/foo.mjs'),path.join(f.options.project,'src/alias.mjs'));
  await assert.rejects(adviseUltracode(f.options,m),/INVALID_ADVISOR_INPUT/);assert.equal(m.calls.length,0);
  assert.equal(await exists(f.state),false);
});

test('공개 쓰기 가능한 project ancestor를 거부한다',async t=>{
  const f=await fixture(t);await fs.chmod(f.root,0o777);
  await assert.rejects(adviseUltracode(f.options,mock()),/INVALID_ADVISOR_INPUT/);
});

for(const relative of ['.jev','.jev/ultracode-advice','.jev/ultracode-advice/cache','.jev/ultracode-advice/request-control','.jev/ultracode-advice/reservations'])
  for(const unsafe of ['symlink','public'])test(`state guard: ${relative}/${unsafe}`,async t=>{
    const f=await fixture(t),target=path.join(f.options.project,relative),m=mock();
    await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
    if(unsafe==='symlink')await fs.symlink(f.root,target);else{await fs.mkdir(target);await fs.chmod(target,0o755);}
    await assert.rejects(adviseUltracode(f.options,m),/INVALID_ADVISOR_INPUT/);assert.equal(m.calls.length,0);
  });

test('state의 모르는 기존 파일/링크는 수정하거나 제거하지 않는다',async t=>{
  const f=await fixture(t);await fs.mkdir(f.state,{recursive:true,mode:0o700});
  const unknown=path.join(f.state,'user-notes.txt');await fs.writeFile(unknown,'KEEP_USER_TEXT');
  await fs.symlink(f.options.input,path.join(f.state,'unknown-link'));
  await adviseUltracode(f.options,mock());
  assert.equal(await fs.readFile(unknown,'utf8'),'KEEP_USER_TEXT');assert.equal((await fs.lstat(path.join(f.state,'unknown-link'))).isSymbolicLink(),true);
  for(const dir of [path.dirname(f.state),f.state,path.join(f.state,'cache'),path.join(f.state,'request-control')])assert.equal((await fs.stat(dir)).mode&0o077,0);
});

test('real HTTP는 batch 1회이며 같은 입력 캐시, 수정 revision은 고정 cap을 공유한다',async t=>{
  const f=await fixture(t),s=await server(t),deps={testTransport:{endpoint:s.endpoint}};
  const first=await adviseUltracode(f.options,deps),second=await adviseUltracode(f.options,deps);
  assert.equal(first.status,'ADVICE');assert.equal(first.cached,false);assert.equal(second.cached,true);assert.equal(second.source,'cache');
  assert.deepEqual(second.usage,{input_tokens:null,output_tokens:null});assert.equal(second.usage_scope,'cache_reuse');
  assert.equal(first.workflow_compatibility,'CALLER_MUST_CONFIRM');
  assert.equal(s.requests.length,1);assert.equal(s.requests[0].url,'/v1/systemone');assert.equal(s.requests[0].authorization,`Bearer ${KEY}`);
  assert.ok(Object.hasOwn(s.requests[0].body.questions,'task_0'));
  f.input.tasks[0].summary+=' 회귀 오류도 고친다.';await writeJSON(f.options.input,f.input);
  const changed=await adviseUltracode(f.options,deps);
  assert.equal(changed.reason,'request_cap');assert.notEqual(changed.input_hash,first.input_hash);assert.equal(s.requests.length,1);
  await adviseUltracode({...f.options,runId:'run-2'},deps);assert.equal(s.requests.length,2);
  for(const dir of ['cache','request-control'])for(const file of await fs.readdir(path.join(f.state,dir)))assert.equal((await fs.stat(path.join(f.state,dir,file))).mode&0o077,0);
});

test('실제 동시 호출은 같은 입력에서 하나의 HTTP 요청으로 합쳐진다',async t=>{
  const f=await fixture(t),s=await server(t),deps={testTransport:{endpoint:s.endpoint}};
  const results=await Promise.all(Array.from({length:5},()=>adviseUltracode(f.options,deps)));
  assert.equal(s.requests.length,1);assert.equal(results.filter(r=>r.cached).length,4);
});

test('동의가 취소되면 기존 캐시도 사용하지 않으며 쓰지 않는다',async t=>{
  const f=await fixture(t),s=await server(t),deps={testTransport:{endpoint:s.endpoint}};
  await adviseUltracode(f.options,deps);await fs.writeFile(f.options.envFile,`TYPESAFE_API_KEY=${KEY}\nJEV_ALLOW_EGRESS=false\nJEV_SHARE_PLAN_CONTEXT=true\n`);
  const before=await snapshot(f.state),result=await adviseUltracode(f.options,deps);
  assert.equal(result.reason,'egress_not_approved');assert.equal(result.cached,false);assert.equal(s.requests.length,1);
  assert.deepEqual(await snapshot(f.state),before);
});

test('기존 cache/control/reservation 파일의 unsafe mode 또는 symlink를 거부한다',async t=>{
  for(const dir of ['cache','request-control','reservations'])for(const unsafe of ['public','symlink']){
    const f=await fixture(t),s=await server(t),deps={testTransport:{endpoint:s.endpoint}};await adviseUltracode(f.options,deps);
    const file=path.join(f.state,dir,(await fs.readdir(path.join(f.state,dir)))[0]);
    if(unsafe==='public')await fs.chmod(file,0o644);else{await fs.rename(file,file+'.target');await fs.symlink(file+'.target',file);}
    await assert.rejects(adviseUltracode(f.options,deps),/INVALID_ADVISOR_INPUT/);assert.equal(s.requests.length,1);
  }
});

test('만료 캐시가 있어도 cap을 다시 열지 않는다',async t=>{
  const f=await fixture(t),s=await server(t),deps={testTransport:{endpoint:s.endpoint}};await adviseUltracode(f.options,deps);
  const file=path.join(f.state,'cache',(await fs.readdir(path.join(f.state,'cache')))[0]);
  const cache=JSON.parse(await fs.readFile(file,'utf8'));cache.expires=0;await writeJSON(file,cache);
  const result=await adviseUltracode(f.options,deps);assert.equal(result.reason,'request_cap');assert.equal(s.requests.length,1);
});

for(const kind of ['error','body-timeout','invalid','redirect'])test('HTTP failure/no retries: '+kind,async t=>{
  const f=await fixture(t),s=await server(t,(req,res,body)=>{
    if(kind==='error'){res.writeHead(429);res.end('MUST_NOT_LOG_PROVIDER_BODY');}
    if(kind==='body-timeout'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');}
    if(kind==='invalid'){const r=answer(body.questions);r.answers.reading.choice='MALICIOUS_PROVIDER_TEXT';res.end(JSON.stringify(r));}
    if(kind==='redirect'){res.writeHead(302,{Location:'http://127.0.0.1:1/steal'});res.end();}
  });
  const deps={testTransport:{endpoint:s.endpoint,timeoutMs:150}};
  const result=await adviseUltracode(f.options,deps);
  assert.equal(result.status,'FALLBACK');assert.equal(result.tasks[0].requested,null);assert.equal(s.requests.length,1);
  assert.deepEqual(result.usage,{input_tokens:null,output_tokens:null});assert.ok(!JSON.stringify(result).includes('MALICIOUS'));
  if(kind==='body-timeout')assert.equal(result.reason,'jev_timeout');
  const again=await adviseUltracode(f.options,deps);assert.equal(again.reason,'request_cap');assert.equal(s.requests.length,1);
});

test('typed 부가 지시는 캐시에 저장하지 않고 재호출도 하지 않는다',async t=>{
  const f=await fixture(t),s=await server(t,(req,res,body)=>{
    const r=answer(body.questions);r.answers.task_0.instructions='DO_NOT_COPY';res.end(JSON.stringify(r));
  }),deps={testTransport:{endpoint:s.endpoint}};
  const first=await adviseUltracode(f.options,deps),second=await adviseUltracode(f.options,deps);
  assert.equal(first.reason,'invalid_advice');assert.equal(second.reason,'request_cap');
  assert.ok(!JSON.stringify(first).includes('DO_NOT_COPY'));assert.deepEqual(await fs.readdir(path.join(f.state,'cache')),[]);
  assert.equal(s.requests.length,1);
});

test('legacy invalid typed 캐시의 fallback은 cache/source 메타데이터를 보존한다',async t=>{
  const f=await fixture(t),s=await server(t),deps={testTransport:{endpoint:s.endpoint}};await adviseUltracode(f.options,deps);
  const file=path.join(f.state,'cache',(await fs.readdir(path.join(f.state,'cache')))[0]);
  const cache=JSON.parse(await fs.readFile(file,'utf8'));cache.response.answers.task_0.instructions='DO_NOT_COPY';await writeJSON(file,cache);
  const result=await adviseUltracode(f.options,deps);
  assert.equal(result.reason,'invalid_advice');assert.equal(result.cached,true);assert.equal(result.source,'cache');
  assert.equal(result.usage_scope,'cache_reuse');assert.deepEqual(result.usage,{input_tokens:null,output_tokens:null});
  assert.equal(s.requests.length,1);assert.ok(!JSON.stringify(result).includes('DO_NOT_COPY'));
});

test('깊은 provider envelope는 저장 전에 제거하여 cache 팽창을 막는다',async t=>{
  const f=await fixture(t),s=await server(t,(req,res,body)=>{
    const response=answer(body.questions);let nested='PROVIDER_ONLY_DO_NOT_STORE';for(let i=0;i<800;i++)nested=[nested];
    response.diagnostics=nested;response.usage.extra=nested;response.model='PROVIDER_ONLY_MODEL';
    res.end(JSON.stringify(response));
  }),deps={testTransport:{endpoint:s.endpoint}};
  const first=await adviseUltracode(f.options,deps),second=await adviseUltracode(f.options,deps);
  assert.equal(first.status,'ADVICE');assert.equal(second.status,'ADVICE');assert.equal(second.cached,true);assert.equal(s.requests.length,1);
  const file=path.join(f.state,'cache',(await fs.readdir(path.join(f.state,'cache')))[0]),contents=await fs.readFile(file,'utf8');
  assert.ok(Buffer.byteLength(contents)<16384);assert.ok(!contents.includes('PROVIDER_ONLY'));
  const response=JSON.parse(contents).response;assert.deepEqual(Object.keys(response).sort(),['answers','model','usage']);
  assert.equal(response.model,'jev-latest');assert.deepEqual(response.usage,{input_tokens:12,output_tokens:0});
});

for(const dir of ['cache','request-control'])for(const kind of ['oversized','invalid-json','wrong-shape','invalid-utf8'])
  test(`안전한 상태 파일 내용 오류는 보존하고 FALLBACK: ${dir}/${kind}`,async t=>{
    const f=await fixture(t),s=await server(t),deps={testTransport:{endpoint:s.endpoint}};await adviseUltracode(f.options,deps);
    const file=path.join(f.state,dir,(await fs.readdir(path.join(f.state,dir)))[0]);
    const contents=kind==='oversized'?'x'.repeat(dir==='cache'?1048577:2049):kind==='invalid-json'?'{broken':kind==='wrong-shape'?'{}':Buffer.from([255]);
    await fs.writeFile(file,contents);
    const result=await adviseUltracode(f.options,deps);
    assert.equal(result.status,'FALLBACK');assert.equal(result.reason,'state_unavailable');assert.equal(s.requests.length,1);
    assert.deepEqual(await fs.readFile(file),Buffer.from(contents));
  });

for(const failure of [false,true])test('키 교체도 같은 run의 one-shot cap을 초기화하지 않는다: '+failure,async t=>{
  const f=await fixture(t),s=await server(t,failure?(req,res)=>{res.writeHead(500);res.end();}:null),deps={testTransport:{endpoint:s.endpoint}};
  await adviseUltracode(f.options,deps);
  await fs.writeFile(f.options.envFile,`TYPESAFE_API_KEY=${KEY}-changed\nJEV_ALLOW_EGRESS=true\nJEV_SHARE_PLAN_CONTEXT=true\n`);
  const result=await adviseUltracode(f.options,deps);
  assert.equal(result.reason,'request_cap');assert.equal(s.requests.length,1);
  const files=await fs.readdir(path.join(f.state,'reservations'));assert.equal(files.length,1);
  const marker=await fs.stat(path.join(f.state,'reservations',files[0]));assert.equal(marker.size,0);assert.equal(marker.mode&0o077,0);
});

test('서로 다른 키의 동시 요청도 run당 한 번만 전송한다',async t=>{
  const f=await fixture(t),s=await server(t),deps={testTransport:{endpoint:s.endpoint}},otherEnv=path.join(f.root,'other.env');
  await fs.writeFile(otherEnv,`TYPESAFE_API_KEY=${KEY}-other\nJEV_ALLOW_EGRESS=true\nJEV_SHARE_PLAN_CONTEXT=true\n`,{mode:0o600});
  const results=await Promise.all([adviseUltracode(f.options,deps),adviseUltracode({...f.options,envFile:otherEnv},deps)]);
  assert.equal(s.requests.length,1);assert.equal(results.filter(r=>r.status==='ADVICE').length,1);assert.equal(results.filter(r=>r.reason==='request_cap').length,1);
});

test('잠금 대기는 HTTP timeout으로 표기하지 않고 기존 lock 내용을 보존한다',async t=>{
  const f=await fixture(t),s=await server(t),captured=mock();await adviseUltracode(f.options,captured);
  const {state,questions,scope}=captured.calls[0];
  const key=hash({scope,account:hash(KEY),endpoint:s.endpoint,model:'jev-latest',questions,state,version:QUESTION_VERSION});
  const lock=path.join(f.state,'cache',key+'.json.lock');await fs.mkdir(lock,{mode:0o700});await fs.writeFile(path.join(lock,'owner'),'KEEP');
  const result=await adviseUltracode(f.options,{testTransport:{endpoint:s.endpoint,timeoutMs:50}});
  assert.equal(result.reason,'state_busy');assert.equal(s.requests.length,0);assert.equal(await fs.readFile(path.join(lock,'owner'),'utf8'),'KEEP');
});

test('test transport도 numeric loopback 이외 endpoint는 거부한다',async t=>{
  const f=await fixture(t);
  for(const endpoint of ['https://example.com','http://localhost:80','http://127.0.0.1:80/else','http://user@127.0.0.1:80'])
    await assert.rejects(adviseUltracode(f.options,{testTransport:{endpoint}}),/INVALID_ADVISOR_INPUT/);
});

test('8개 task 출력은 4KiB 안이며 원문 목표/요약/키가 없다',async t=>{
  const input=plan();input.tasks=Array.from({length:8},(_,i)=>task('task-'+i,{writePaths:['src/'+i+'.mjs']}));
  const f=await fixture(t,{input}),result=await adviseUltracode(f.options,mock());
  const text=JSON.stringify(result);assert.ok(Buffer.byteLength(text)<=4096);assert.ok(!text.includes(KEY));assert.ok(!text.includes(input.tasks[0].summary));
});

test('CLI help와 unknown/duplicate/trailing flag는 실제 subprocess에서 분리된다',async t=>{
  const help=await child(process.execPath,[entry,'--help']);assert.equal(help.code,0);assert.match(help.stdout,/--dry-run/);assert.equal(help.stderr,'');
  const f=await fixture(t);
  for(const args of [[],[...flags(f),'--unknown'],[...flags(f),'--project','/other'],[...flags(f),'--dry-run','true'],['--help','--dry-run'],[...flags(f),'--registry']]){
    const result=await child(process.execPath,[entry,...args]);assert.equal(result.code,2);assert.equal(result.stderr,'');
    assert.deepEqual(JSON.parse(result.stdout),{status:'ERROR',code:'INVALID_INPUT'});
  }
});

test('CLI dry-run/미동의는 ambient key/endpoint를 상속하지 않고 writes/calls도 없다',async t=>{
  const f=await fixture(t,{env:''}),s=await server(t),before=await snapshot(f.root);
  const env={...process.env,TYPESAFE_API_KEY:KEY,JEV_ALLOW_EGRESS:'true',JEV_SHARE_PLAN_CONTEXT:'true',TYPESAFE_BASE_URL:s.endpoint};
  const dry=await child(process.execPath,[entry,...flags(f),'--dry-run'],{env});
  assert.equal(dry.code,0);assert.equal(JSON.parse(dry.stdout).status,'DRY_RUN');assert.equal(JSON.parse(dry.stdout).eligible,false);
  const plain=await child(process.execPath,[entry,...flags(f)],{env});assert.equal(plain.code,0);assert.equal(JSON.parse(plain.stdout).status,'FALLBACK');
  assert.equal(dry.stderr+plain.stderr,'');assert.equal(s.requests.length,0);assert.deepEqual(await snapshot(f.root),before);
});

test('CLI는 malformed input/env 및 secret guard를 generic exit2로만 보고한다',async t=>{
  const f=await fixture(t);
  for(const value of ['{"goal":"MUST_NOT_ECHO_SUMMARY"',JSON.stringify({...plan(),goal:KEY})]){
    await fs.writeFile(f.options.input,value);const r=await child(process.execPath,[entry,...flags(f)]);
    assert.equal(r.code,2);assert.equal(r.stderr,'');assert.deepEqual(JSON.parse(r.stdout),{status:'ERROR',code:'INVALID_INPUT'});
  }
  await writeJSON(f.options.input,plan());await fs.writeFile(f.options.envFile,'TYPESAFE_API_KEY=$(MUST_NOT_EXECUTE)\n');
  const r=await child(process.execPath,[entry,...flags(f)]);assert.equal(r.code,2);assert.ok(!r.stdout.includes('MUST_NOT'));
});

test('CLI 실제 evaluate/캐시/수정 cap을 loopback fetch 주입으로 검증한다',async t=>{
  const f=await fixture(t),s=await server(t),preload=path.join(f.root,'loopback-preload.mjs');
  // 실제 CLI의 승인 endpoint를 확인한 뒤 테스트 HTTP 서버에만 전달한다.
  await fs.writeFile(preload,`const original=globalThis.fetch;globalThis.fetch=(url,options)=>{if(url!=='https://api.typesafe.ai/v1/systemone')throw new Error('UNEXPECTED_ENDPOINT');return original(${JSON.stringify(s.endpoint)}+'/v1/systemone',options);};\n`);
  const env={...process.env,TYPESAFE_API_KEY:'ambient-wrong-key',TYPESAFE_BASE_URL:'http://127.0.0.1:1',JEV_MODEL:'ambient-wrong-model'};
  const invoke=()=>child(process.execPath,['--import',preload,entry,...flags(f)],{env});
  const first=await invoke(),cached=await invoke();assert.equal(first.code,0);assert.equal(cached.code,0);
  assert.equal(JSON.parse(first.stdout).status,'ADVICE');assert.equal(JSON.parse(cached.stdout).cached,true);
  assert.equal(first.stderr+cached.stderr,'');assert.equal(s.requests.length,1);assert.equal(s.requests[0].authorization,`Bearer ${KEY}`);
  assert.equal(s.requests[0].body.model,'jev-latest');
  f.input.acceptance.push('새 수용 검사를 유지한다.');await writeJSON(f.options.input,f.input);
  const changed=await invoke();assert.equal(changed.code,0);assert.equal(JSON.parse(changed.stdout).reason,'request_cap');assert.equal(s.requests.length,1);
  assert.ok(!first.stdout.includes(KEY));assert.ok(!first.stdout.includes(f.input.goal));
  f.input.acceptance.pop();await writeJSON(f.options.input,f.input);
  const cacheFile=path.join(f.state,'cache',(await fs.readdir(path.join(f.state,'cache')))[0]);
  await fs.writeFile(cacheFile,'{BROKEN_PRIVATE_CACHE');
  const corrupt=await invoke();assert.equal(corrupt.code,0);assert.equal(JSON.parse(corrupt.stdout).reason,'state_unavailable');
  assert.equal(corrupt.stderr,'');assert.ok(!corrupt.stdout.includes('BROKEN_PRIVATE_CACHE'));assert.equal(s.requests.length,1);
  assert.equal(await fs.readFile(cacheFile,'utf8'),'{BROKEN_PRIVATE_CACHE');
});
