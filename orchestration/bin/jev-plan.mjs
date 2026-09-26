#!/usr/bin/env node
import { adviseUltracode } from '../src/ultracode-advisor.mjs';

const HELP=`Jev ultracode plan-time advisor (hook/worker 실행 없음)
사용법:
  node orchestration/bin/jev-plan.mjs --project ABS --input ABS --registry ABS --env-file ABS --run-id ID [--dry-run]
  node orchestration/bin/jev-plan.mjs --help

모든 경로는 symlink 없는 정규화된 절대 경로여야 합니다.
input/registry/env는 현재 사용자 소유의 owner-only 일반 파일(예: 600)이어야 합니다.
env와 registry는 project 밖에 둡니다. TYPESAFE_API_KEY, JEV_ALLOW_EGRESS=true,
JEV_SHARE_PLAN_CONTEXT=true만 읽으며 ambient env/모델/endpoint override는 무시합니다.

input JSON: {schema:1, goal:string, acceptance:string[], tasks:Task[]}
Task: {id, summary, role, risk, dependsOn:string[], readPaths:string[], writePaths:string[]}
role: research | plan | implement | review | integration
risk: normal | sensitive | unknown
1~8 tasks, 고유 id=[a-z][a-z0-9-]{0,31}, 의존 DAG 및 경로 충돌 검사.
research/plan/review는 writePaths=[]; 병렬 읽기/쓰기 및 쓰기/쓰기 충돌 금지.
프로젝트 상대 경로만 허용하며 민감 경로, symlink, secretLike, 미지 필드는 거부합니다.
input 최대 24576 bytes; goal 2048, summary 1024, acceptance 항목 512 bytes.

--dry-run: 전송/쓰기 없이 정확한 bounded 요청의 bytes/hash와 적격성만 출력합니다.
적격성은 입력/동의/capability 기준이며 실제 cache/budget 판정은 실행 때 합니다.
실행: Jev 1회 batch, 재시도 없음, project+run-id+purpose별 요청 cap=1.
동일 입력의 유효한 캐시는 재사용하지만 변경 계획/키도 같은 cap을 공유합니다.
HTTP 시도 전 private one-shot 예약을 남기며 실패도 cap을 소비합니다.
HTTP timeout은 1200ms이며 잠금 대기 또는 전체 실행 상한이 아닙니다.
상태: project/.jev/ultracode-advice (owner-only). 기존 모르는 파일은 보존합니다.
안전한 상태 파일의 내용 오류/과대 크기는 FALLBACK이며 원본을 지우지 않습니다.

출력은 4KiB 이내 JSON입니다. ADVICE/FALLBACK/DRY_RUN exit 0, 잘못된 입력/안전 파일 exit 2.
requested는 Workflow 작성자가 검토할 model/effort 권고이며 applied=false,
observed=null, workflow_compatibility=CALLER_MUST_CONFIRM입니다.
null 권고/FALLBACK이면 원래 ultracode 기본값을 유지합니다.
캐시 재사용의 usage는 null, usage_scope=cache_reuse이며 원요청 토큰을 재집계하지 않습니다.
실제 모델 적용, 작업 성공, 토큰/비용 절감 또는 기본 ultracode 대비 우위를 뜻하지 않습니다.
`;

function parse(argv){
  const names=new Map([['--project','project'],['--input','input'],['--registry','registry'],['--env-file','envFile'],['--run-id','runId']]);
  const options={dryRun:false},seen=new Set();
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];if(seen.has(flag))throw new Error('INVALID_ARGUMENT');seen.add(flag);
    if(flag==='--dry-run'){options.dryRun=true;continue;}
    if(!names.has(flag)||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('INVALID_ARGUMENT');
    options[names.get(flag)]=argv[++i];
  }
  if([...names.values()].some(k=>!Object.hasOwn(options,k)))throw new Error('INVALID_ARGUMENT');
  return options;
}

try{
  const argv=process.argv.slice(2);
  if(argv.length===1&&argv[0]==='--help')process.stdout.write(HELP);
  else process.stdout.write(JSON.stringify(await adviseUltracode(parse(argv)))+'\n');
}catch{
  // 예외의 메시지, 경로, 입력 원문 또는 자격 증명을 출력하지 않는다.
  process.stdout.write('{"status":"ERROR","code":"INVALID_INPUT"}\n');process.exitCode=2;
}
