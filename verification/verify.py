#!/usr/bin/env python3
"""One-command independent local verification. Exit 0/1/2/3 = PASS/FAIL/BLOCKED/INCONCLUSIVE."""
from __future__ import annotations
import argparse, datetime, getpass, json, os, shutil, sys, time, uuid
from pathlib import Path
from verifier.common import VERSION, Blocked, Report, load_env, read_json, write_json, write_private, sha, canonical, tree_manifest, secrets_from
from verifier.gateway import Gateway
from verifier.tasks import TASKS,validate_suite
from verifier.stages import preflight, offline_checks, direct_jev_checks, live_router_checks, native_smoke, benchmark
ROOT=Path(__file__).resolve().parent


def configure():
    file=ROOT/'.env'
    if file.exists():raise ValueError('.env already exists; edit it without overwriting existing secrets.')
    sut=input('오케스트레이션 소스 폴더의 절대경로: ').strip()
    key=getpass.getpass('TypeSafe API 키 (화면에 표시되지 않음): ').strip()
    anth=getpass.getpass('Anthropic API 키 (기존 파일 로그인 재사용은 빈칸): ').strip()
    codex=getpass.getpass('Codex API 키 (기존 파일 로그인 재사용은 빈칸): ').strip()
    values={'VERIFY_SUT_PATH':str(Path(sut).expanduser().resolve()),'TYPESAFE_API_KEY':key,
            'ANTHROPIC_API_KEY':anth,'CODEX_API_KEY':codex}
    if any('\n' in v or '\r' in v for v in values.values()):raise ValueError('Invalid multiline value')
    write_private(file,'\n'.join(k+'='+v for k,v in values.items())+'\n')
    print('.env 작성 완료. 실제 키는 보고서나 Git에 포함하지 마세요.')
    return 0


def parser():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--sut',type=Path,help='Extracted orchestration source directory; never imported by the verifier')
    p.add_argument('--env-file',type=Path,default=ROOT/'.env')
    p.add_argument('--suite',choices=['offline','jev','native','benchmark','all'],default='offline')
    p.add_argument('--preset',choices=['smoke','full'],default='smoke')
    p.add_argument('--runtimes',choices=['both','claude','codex'],default='both')
    p.add_argument('--out',type=Path)
    p.add_argument('--registry',type=Path,help='Explicit SUT registry file, optional; only passed to the isolated installer')
    p.add_argument('--task-suite',type=Path,help='Independent trusted JSON task suite; tests execute locally without API keys')
    p.add_argument('--repetitions',type=int)
    p.add_argument('--timeout',type=float,default=240,help='Per-native-process timeout, seconds; not a dollar cap')
    p.add_argument('--seed',type=int,default=20260925)
    p.add_argument('--max-native-runs',type=int,default=20,help='Benchmark CLI sessions, not LLM request count')
    p.add_argument('--max-jev-calls',type=int,default=100,help='Total forwarded Jev requests after one direct API probe')
    p.add_argument('--accept-costs',action='store_true',help='Consent to actual paid provider calls')
    p.add_argument('--approve-test-hooks',action='store_true',help='Explicit one-invocation Codex trust approval for the isolated generated hook set; not an execution permission bypass')
    p.add_argument('--reuse-cli-login',action='store_true',help='Temporarily copy only file-based CLI login material; remove it at cleanup')
    p.add_argument('--plan',action='store_true',help='Print requested run counts; execute nothing')
    p.add_argument('--self-test',action='store_true',help='Run verifier tests only; no paid calls')
    p.add_argument('--configure',action='store_true',help='Write local .env interactively without displaying API keys')
    return p


def main():
    args=parser().parse_args()
    if args.configure:return configure()
    if args.self_test:
        if args.sut:os.environ['JEV_VERIFIER_TEST_SUT']=str(args.sut.resolve())
        import unittest
        suite=unittest.defaultTestLoader.discover(str(ROOT/'tests'))
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    if sys.version_info<(3,11):raise ValueError('Python 3.11+ is required')
    if args.timeout<=0 or args.max_native_runs<1 or args.max_jev_calls<1 or args.repetitions is not None and args.repetitions<1:raise ValueError('Limits must be positive')
    file=args.env_file.expanduser() if args.env_file.expanduser().exists() else None
    values=load_env(file)
    source=(args.sut or (Path(values['VERIFY_SUT_PATH']) if values.get('VERIFY_SUT_PATH') else None))
    if not source:raise ValueError('Supply --sut /path/to/Jev_Orchestration or run --configure once.')
    source=source.expanduser().resolve()
    if source==ROOT or source in ROOT.parents or ROOT in source.parents:raise ValueError('Verifier and SUT must be separate, non-nested directories.')
    if args.registry:args.registry=args.registry.expanduser().resolve()
    tasks=validate_suite(read_json(args.task_suite.resolve())) if args.task_suite else TASKS
    runtimes=['claude','codex'] if args.runtimes=='both' else [args.runtimes]
    selected=tasks if args.preset=='full' else tasks[:2];reps=args.repetitions or (3 if args.preset=='full' else 1)
    planned_benchmark=len(selected)*reps*sum(5 if rt=='claude' else 4 for rt in runtimes)
    plan={'suite':args.suite,'preset':args.preset,'source':str(source),'runtimes':runtimes,
          'benchmark_sessions_planned':planned_benchmark if args.suite in ('all','benchmark') else 0,
          'benchmark_session_cap':args.max_native_runs,'forced_native_probe_sessions':len(runtimes) if args.suite in ('all','native') else 0,
          'jev_forwarded_request_cap':args.max_jev_calls,'cost_notice':'Real Jev/native calls may consume paid quota. No total Codex dollar cap is claimed.',
          'hook_trust_notice':'--approve-test-hooks uses Codex one-shot hook trust only, in disposable HOME. Sandbox stays workspace-write.',
          'sut_source_write_policy':'No deliberate source writes; exact source hash checked before/after.'}
    print(json.dumps(plan,ensure_ascii=False,indent=2),flush=True)
    if args.plan:return 0
    live=args.suite!='offline'
    if live and not args.accept_costs:
        if not sys.stdin.isatty():raise ValueError('Paid stages require --accept-costs. Offline: --suite offline.')
        if input('실제 API/CLI 호출 비용에 동의하면 YES 입력: ').strip()!='YES':return 2
        args.accept_costs=True
    if live and 'codex' in runtimes and not args.approve_test_hooks and sys.stdin.isatty():
        args.approve_test_hooks=input('생성된 격리 테스트 훅을 이번 Codex 실행에서만 신뢰하려면 TRUST 입력 (권한/샌드박스 우회 아님): ').strip()=='TRUST'
    out=(args.out or ROOT/'results'/(datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:6])).expanduser().resolve()
    if out==source or source in out.parents or out==ROOT:raise ValueError('Results must be outside SUT and must not replace verifier root')
    if out.exists() and any(out.iterdir()):raise ValueError('Output directory must be empty; prior evidence is not overwritten')
    report=Report(out,secrets_from(values));original=None;node=values.get('VERIFY_NODE_BIN',shutil.which('node') or 'node')
    try:
        original=tree_manifest(source)
        report.meta.update(plan=plan,source_sha256=sha(canonical(original)),source_files=original,
            verifier_sha256=sha(canonical(tree_manifest(ROOT,ignore=('.git','node_modules','__pycache__','results')))),
            task_suite_sha256=sha(canonical(tasks)),routing_case_sha256=sha((ROOT/'cases/routing.json').read_bytes()),
            api_keys_saved=False,authentication_policy='Explicit API env or opt-in temporary file-login copy; never global settings copy.',
            independent_boundaries='No SUT imports, unit tests, mocks, optimizer scores, or PASS claims are used as verdicts.')
        write_json(out/'plan.json',plan)
        bins=preflight(report,source,node,values,runtimes if args.suite in ('all','native','benchmark') else [])
        report.meta['native_versions']={rt:b['version'] for rt,b in bins.items()}
        if args.suite in ('offline','all'):offline_checks(report,source,node,values,args.registry)
        if live:
            if direct_jev_checks(report,values,args.max_jev_calls):
                with Gateway(synthetic=False,endpoint=values.get('TYPESAFE_BASE_URL','https://api.typesafe.ai'),
                    key=values.get('TYPESAFE_API_KEY',''),max_requests=args.max_jev_calls,
                    artifact=out/'artifacts/real-jev-http.json') as gateway:
                    if args.suite in ('jev','all'):live_router_checks(report,source,node,values,gateway,args.registry)
                    if args.suite in ('native','all'):native_smoke(report,source,node,values,gateway,bins,runtimes,args)
                    if args.suite in ('benchmark','all'):benchmark(report,source,node,values,gateway,bins,runtimes,args,tasks)
            else:
                for stage in ('jev-router','native','benchmark'):
                    if args.suite=='all' or args.suite==stage or args.suite=='jev' and stage=='jev-router':report.add(stage,'not_started','BLOCKED','Actual Jev API prerequisite failed. No simulated replacement used.')
        if args.suite=='offline':report.add('scope','live_stages','NOT_RUN','Explicit offline selection; no real API/native claim.')
    except KeyboardInterrupt:report.add('runner','interrupted','BLOCKED','User interrupted. Completed evidence retained; partial results cannot establish superiority.')
    except Blocked as e:report.add('runner','prerequisite','BLOCKED',str(e))
    except Exception as e:report.add('runner','unexpected_error','FAIL',f'{type(e).__name__}: {e}')
    finally:
        if original is not None:
            try:
                current=tree_manifest(source);changed=[k for k in set(original)|set(current) if original.get(k)!=current.get(k)]
                report.add('integrity','sut_source_unchanged','PASS' if not changed else 'FAIL',{'changed':changed})
            except Exception as e:report.add('integrity','sut_source_unchanged','FAIL',str(e))
        code=report.finish()
        print(f'\n보고서: {out}/report.html\nJSON: {out}/report.json\n종료 코드: {code}',flush=True)
    return code

if __name__=='__main__':
    try:sys.exit(main())
    except (ValueError,FileNotFoundError) as e:print('설정 오류: '+str(e),file=sys.stderr);sys.exit(2)
