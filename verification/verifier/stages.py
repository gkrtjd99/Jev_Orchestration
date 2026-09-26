from __future__ import annotations
import json, os, random, re, shutil, tempfile, time, uuid
from pathlib import Path
from .common import Blocked, Inconclusive, Report, read_json, write_json, write_private, sha, canonical, tree_manifest, run_process, clean_env, redact
from .gateway import Gateway, api_call, validate_response
from .target import Target
from .tasks import TASKS, create_workspace, judge
from .native import one_trial
from .statistics import compare
ROOT=Path(__file__).resolve().parent.parent


def preflight(report,source,node,values,runtimes):
    report.meta['system']={'platform':os.sys.platform,'python':os.sys.version.split()[0]}
    if os.name!='posix':raise Blocked('Use Linux, macOS, or WSL. The target installer uses POSIX command quoting.')
    with tempfile.TemporaryDirectory(prefix='jev-verifier-preflight-') as td:
        home=Path(td);env=clean_env(home)
        def node_check():
            r=run_process([node,'--version'],cwd=home,env=env)
            assert r.returncode==0 and int(r.stdout.strip().lstrip('v').split('.')[0])>=22,'Node.js 22+ required'
            return r.stdout.strip()
        report.check('preflight','node22',node_check)
        def git_check():
            p=run_process(['git','--version'],cwd=home,env=env)
            assert p.returncode==0,'Git version check failed'
            return p.stdout.strip()
        report.check('preflight','git',git_check)
        binaries={}
        for rt in runtimes:
            binary=values.get('VERIFY_'+rt.upper()+'_BIN',rt)
            def inspect(rt=rt,binary=binary):
                version=run_process([binary,'--version'],cwd=home,env=env,timeout=15)
                help_=run_process([binary,'--help'],cwd=home,env=env,timeout=15)
                if version.returncode or help_.returncode:raise Blocked('Native CLI --version/--help failed')
                text=help_.stdout+help_.stderr
                if rt=='codex':
                    extra=run_process([binary,'exec','--help'],cwd=home,env=env,timeout=15)
                    text+='\n'+extra.stdout+extra.stderr
                binaries[rt]={'binary':shutil.which(binary) or binary,'version':version.stdout.strip(),'help':text}
                write_private(report.out/'artifacts/preflight'/(rt+'-help.txt'),text)
                return {'version':version.stdout.strip(),'binary':binary}
            report.check('preflight',rt,inspect)
        return binaries


def offline_checks(report,source,node,values,registry=None):
    with tempfile.TemporaryDirectory(prefix='jev-verifier-offline-') as td, Gateway(synthetic=True,max_requests=200,artifact=report.out/'artifacts/offline/synthetic-http.json') as gateway:
        target=Target(source,Path(td),node,{},report.out/'artifacts/offline',registry=None)
        installed=report.check('offline','public_installer_in_disposable_home',lambda:target.install(gateway=gateway,placeholder_key=True))
        if installed['status']!='PASS':return
        write_private(target.project/'README.md','Run: npm run dev\n');write_private(target.project/'AGENTS.md','Keep acceptance constraints exact.\n')
        for rt in ('claude','codex'):
            def routes(rt=rt):
                e=target.event(rt,task='Fix a small well-specified parser bug in src/main.mjs.')
                out,p=target.invoke(e,rt,'route-'+rt);assert p.returncode==0
                selected=target.selected_profile(out,rt)
                allowed=[m for m in target.config['registry']['models'] if m['runtime']==rt and m['enabled']]
                assert any(m['model']==selected['requested_model'] and selected['requested_effort'] in m['supportedEfforts'] for m in allowed),'Unsupported model/effort emitted'
                if rt=='claude':assert 'effort' not in selected['input'],'Invented Agent effort input'
                return {k:v for k,v in selected.items() if k!='input'}
            report.check('offline','contract_route_'+rt,routes)
            def idempotence(rt=rt):
                e=target.event(rt);first,_=target.invoke(e,rt,'idempotent-1-'+rt);n=len(gateway.records)
                second,_=target.invoke(e,rt,'idempotent-2-'+rt)
                assert first==second and len(gateway.records)==n,'Duplicate route made a new HTTP call or changed output'
                return {'extra_http_calls':len(gateway.records)-n}
            report.check('offline','idempotent_'+rt,idempotence)
            def preserve(rt=rt):
                e=target.event(rt);key='subagent_type' if rt=='claude' else 'agent_type';e['tool_input'][key]='owner-specialist'
                n=len(gateway.records);out,_=target.invoke(e,rt,'custom-'+rt)
                assert not out.get('hookSpecificOutput',{}).get('updatedInput') and len(gateway.records)==n
                return 'Custom agent unchanged; no Jev call'
            report.check('offline','custom_agent_preserved_'+rt,preserve)
            def out_of_scope(rt=rt):
                e=target.event(rt,cwd=str(Path(td)/'outside'));Path(e['cwd']).mkdir(exist_ok=True)
                n=len(gateway.records);out,_=target.invoke(e,rt,'outside-'+rt)
                assert out=={} and len(gateway.records)==n
            report.check('offline','project_boundary_'+rt,out_of_scope)
        if 'safety' in target.config:
            # Independent literal requirements, not the SUT's own test results or score.
            for rt in ('claude','codex'):
                def explicit_preserved(rt=rt):
                    e=target.event(rt);e['tool_input']['model']='explicit-user-model'
                    before=len(gateway.records);out,_=target.invoke(e,rt,'explicit-'+rt)
                    assert 'updatedInput' not in out.get('hookSpecificOutput',{})
                    assert len(gateway.records)==before,'Explicit settings still caused a routing request'
                report.check('offline','explicit_model_preserved_'+rt,explicit_preserved)
            def egress_guard():
                old=json.loads(json.dumps(target.config['safety']))
                try:
                    target.patch_test_config(safety=old|{'allowEgress':False})
                    before=len(gateway.records);out,_=target.invoke(target.event(),name='egress-disabled')
                    assert len(gateway.records)==before,'Unapproved network request'
                    assert 'updatedInput' not in out.get('hookSpecificOutput',{})
                finally:target.patch_test_config(safety=old)
            report.check('offline','egress_consent_is_separate',egress_guard)
            def codex_approval_guard():
                old=json.loads(json.dumps(target.config['safety']))
                try:
                    target.patch_test_config(safety=old|{'codexRewriteApproved':False})
                    out,_=target.invoke(target.event('codex'),'codex','codex-approval-disabled')
                    h=out.get('hookSpecificOutput',{})
                    assert 'updatedInput' not in h and 'permissionDecision' not in h,'Routing must not silently grant allow'
                finally:target.patch_test_config(safety=old)
            report.check('offline','codex_approval_consent_is_separate',codex_approval_guard)
            def changed_revision():
                e=target.event();first,_=target.invoke(e,name='revision-first')
                assert first.get('hookSpecificOutput',{}).get('updatedInput')
                write_private(target.project/'changed.mjs','export const changed=true;')
                second,_=target.invoke(e,name='revision-replay')
                assert 'updatedInput' not in second.get('hookSpecificOutput',{}),'Stale route replayed after source edit'
            report.check('offline','dirty_source_invalidates_pending_route',changed_revision)
            def substantive_effort():
                for rt in ('claude','codex'):
                    e=target.event(rt,task='Implement bounded edge case handling against the existing contract.')
                    out,_=target.invoke(e,rt,'quality-floor-'+rt);p=target.selected_profile(out,rt)
                    assert p['requested_effort'] in ('high','xhigh','max'),'Below the explicit quality floor'
                    if '_light_' in p['profile']:assert p['requested_effort'] in ('xhigh','max'),'Light substantive worker below deep-effort floor'
                return {'scope':'Literal policy/application contract, NOT model performance'}
            report.check('offline','substantive_work_uses_quality_effort_floor',substantive_effort)
        for mode in ('off','shadow'):
            def no_rewrite(mode=mode):
                target.patch_test_config(mode=mode);write_private(target.config_file.parent/'.env','TYPESAFE_API_KEY='+gateway.access_token+'\nJEV_MODE='+mode+'\n')
                e=target.event();out,_=target.invoke(e,name='mode-'+mode)
                assert not out.get('hookSpecificOutput',{}).get('updatedInput')
            report.check('offline',mode+'_does_not_rewrite',no_rewrite)
        target.patch_test_config(mode='active');write_private(target.config_file.parent/'.env','TYPESAFE_API_KEY='+gateway.access_token+'\nJEV_MODE=active\n')
        gateway.error_status=401
        for policy in ('native','block'):
            def failure(policy=policy):
                target.patch_test_config(failureMode=policy)
                out,_=target.invoke(target.event(task='Transport failure case '+uuid.uuid4().hex),name='401-'+policy)
                h=out.get('hookSpecificOutput',{})
                assert 'updatedInput' not in h
                if policy=='block':assert h.get('permissionDecision')=='deny','Strict policy did not deny'
                else:assert h.get('permissionDecision')!='allow','Failure silently approved a native tool'
                return {'synthetic_status':401,'fallback_policy':policy}
            report.check('offline','http_failure_'+policy,failure)
        report.add('offline','scope','PASS',{'means':'Black-box protocol behavior with a synthetic server only. No Jev judgment or native application is claimed.'})
    # An unchanged stub must fail every independent grader; this checks the verifier, not the SUT.
    for task in TASKS:
        def rejects(task=task):
            with tempfile.TemporaryDirectory() as td:
                work=Path(td);project=work/'project';project.mkdir();write_private(project/'src/main.mjs',task['initial'])
                g=judge(task,project,work/'judge',node,report.out/'artifacts/grader-canaries'/task['id'])
                assert not g['passed'],'Broken fixture passed independent tests'
                assert not g['timeout'],'Broken fixture hung instead of a controlled failure'
                return {'rejects_unfixed_stub':True}
        report.check('offline','grader_rejects_'+task['id'],rejects)


def direct_jev_checks(report,values,request_budget):
    key=values.get('TYPESAFE_API_KEY','');endpoint=values.get('TYPESAFE_BASE_URL','https://api.typesafe.ai')
    if not key:report.add('jev','real_api','BLOCKED','MISSING_TYPESAFE_API_KEY');return False
    # Deterministic state keeps connectivity/primitive checks separate from routing quality.
    payload={'model':values.get('JEV_MODEL','jev-latest'),'state':{'shape':'circle','count':3},'questions':{
        'shape':{'type':'choice','instructions':'Select the exact value of state.shape.','criteria':{'circle':'state.shape is circle','square':'state.shape is square'}},
        'count':{'type':'noul','instructions':'Is state.count exactly 3?'},
        'size':{'type':'score','instructions':'Classify state.count: zero, one to four, or five and above.','criteria':['Zero','One to four','Five and above']}}}
    def actual():
        if request_budget<1:raise Blocked('JEV_REQUEST_BUDGET_EXHAUSTED')
        status,body,ms=api_call(endpoint,key,payload,timeout=15)
        write_json(report.out/'artifacts/jev/direct-api.json',{'request':payload,'response':json.loads(redact(canonical(body),[key])),'status':status,'latency_ms':ms,'source':'REAL_UPSTREAM_HTTP'})
        if status in (401,403):raise Blocked('JEV_AUTH_REJECTED_'+str(status))
        if status in (429,529):raise Blocked('JEV_RATE_OR_CAPACITY_'+str(status))
        assert status==200,f'Jev HTTP {status}'
        validate_response(body,payload['questions'])
        assert body['answers']['shape']['choice']=='circle','Deterministic choice failed'
        assert body['answers']['count']['noul']>.5,'Deterministic noul failed'
        assert abs(body['answers']['size']['score']-1)<.35,'Deterministic score failed'
        return {'status':status,'response_model':body['model'],'latency_ms':ms,'usage':body['usage'],
                'scope':'Live API and primitive response contract only; not model routing quality'}
    result=report.check('jev','real_api',actual)
    return result['status']=='PASS'


def live_router_checks(report,source,node,values,gateway,registry=None):
    cases=read_json(ROOT/'cases/routing.json')
    with tempfile.TemporaryDirectory(prefix='jev-real-router-') as td:
        target=Target(source,Path(td),node,values,report.out/'artifacts/jev-router',registry)
        ins=report.check('jev-router','install',lambda:target.install(gateway=gateway))
        if ins['status']!='PASS':return
        write_private(target.project/'README.md','Run command: npm run dev\n')
        for case in cases:
            def run(case=case):
                before=len(gateway.records)
                out,p=target.invoke(target.event(case['runtime'],task=case['prompt']),case['runtime'],case['id'])
                assert p.returncode==0,'Hook process failed'
                selected=target.selected_profile(out,case['runtime'])
                calls=gateway.records[before:]
                assert calls and any(c.get('source')=='REAL_UPSTREAM_HTTP' and c.get('status')==200 and c.get('schema_valid') for c in calls),'No valid real Jev response observed'
                if any(c.get('status')!=200 or c.get('schema_valid') is not True for c in calls):raise AssertionError('Some actual routing/selector requests failed; incumbent fallback is not a complete live pass')
                name=selected['profile'];assert any(name.startswith('jev4_'+role+'_') for role in case['roles']),'Independent role constraint failed'
                assert any('_'+slot+'_' in name for slot in case['slots']),'Independent tier constraint failed'
                assert selected['requested_effort'] in case['efforts'],'Independent effort constraint failed'
                return {k:v for k,v in selected.items() if k!='input'}|{'real_calls':len(calls),'scope':'Rubric sanity, not optimality and not native execution'}
            report.check('jev-router',case['id'],run)


def native_smoke(report,source,node,values,gateway,binaries,runtimes,args):
    for rt in runtimes:
        if rt not in binaries:report.add('native',rt,'BLOCKED','NATIVE_CLI_UNAVAILABLE');continue
        art=report.out/'artifacts/native'/rt
        result=None
        def run():
            nonlocal result
            result=one_trial(source=source,node=node,binary=binaries[rt]['binary'],help_text=binaries[rt]['help'],runtime=rt,
                arm='active',task=TASKS[0],repeat=0,values=values,gateway=gateway,artifacts=art,registry=args.registry,
                approve_hooks=args.approve_test_hooks,reuse_login=args.reuse_cli_login,timeout=args.timeout,smoke=True)
            report.trials.append(result)
            if not result['observer_seen']:raise Blocked('NATIVE_HOOK_NOT_OBSERVED: check hook support/trust and artifacts/native')
            assert result['passed'],'Independent output checks or native process failed'
            if any(r['application_status'].startswith('INCONCLUSIVE') for r in result['routing']['routes']):
                raise Inconclusive('Ambiguous route-to-child correlation; no child is assigned by profile name alone.')
            assert result['active_route_observed'],'Native child using the selected profile not observed'
            return {'artifacts':str(art),'native_child_profile_applied':True,'independent_checks_passed':True}
        report.check('native',rt+'_native_route_and_grade',run)
        if result:
            for field in ('model_status','effort_status'):
                statuses=[r[field] for r in result['routing']['routes']]
                if not statuses:report.add('native',rt+'_'+field,'INCONCLUSIVE','No applied routes');continue
                if 'FAIL' in statuses:report.add('native',rt+'_'+field,'FAIL',result['routing']['routes'])
                elif all(s in ('PASS','NOT_APPLICABLE') for s in statuses):report.add('native',rt+'_'+field,'PASS',result['routing']['routes'])
                else:report.add('native',rt+'_'+field,'INCONCLUSIVE',{'reason':'Missing typed native child metadata; requested profile values were NOT substituted. Use exact model IDs or explicit alias map if needed.','routes':result['routing']['routes']})


def benchmark(report,source,node,values,gateway,binaries,runtimes,args,tasks):
    selected=tasks if args.preset=='full' else tasks[:2]
    repeats=args.repetitions or (3 if args.preset=='full' else 1)
    arms={rt:['native','off','shadow','active']+(['ultracode'] if rt=='claude' else []) for rt in runtimes}
    schedule=[];rng=random.Random(args.seed)
    for task in selected:
        for rep in range(repeats):
            block=[(rt,a,task,rep) for rt in runtimes for a in arms[rt]];rng.shuffle(block);schedule+=block
    write_json(report.out/'schedule.json',[{'runtime':rt,'arm':arm,'task_id':t['id'],'repeat':rep} for rt,arm,t,rep in schedule])
    rows=[];attempted=0;blocked_rt=set()
    for rt,arm,task,rep in schedule:
        if rt not in binaries or rt in blocked_rt:continue
        if attempted>=args.max_native_runs:report.add('benchmark','native_run_cap','BLOCKED',{'cap':args.max_native_runs,'planned':len(schedule)});break
        attempted+=1;print(f'[RUN] {rt}/{arm}/{task["id"]}/{rep+1}',flush=True)
        art=report.out/'artifacts/benchmark'/rt/arm/task['id']/str(rep)
        try:
            row=one_trial(source=source,node=node,binary=binaries[rt]['binary'],help_text=binaries[rt]['help'],runtime=rt,arm=arm,
                task=task,repeat=rep,values=values,gateway=gateway,artifacts=art,registry=args.registry,
                approve_hooks=args.approve_test_hooks,reuse_login=args.reuse_cli_login,timeout=args.timeout)
            rows.append(row);report.trials.append(row)
            # Preserve partial progress after each trial.
            write_json(report.out/'benchmark-progress.json',rows)
        except Blocked as e:
            report.add('benchmark',rt+'_'+arm,'BLOCKED',str(e))
            if 'AUTH_REQUIRED' in str(e) or 'HOOK_APPROVAL_REQUIRED' in str(e):blocked_rt.add(rt)
        except Exception as e:
            report.add('benchmark',rt+'_'+arm+'_'+task['id'],'FAIL',f'{type(e).__name__}: {e}')
    for rt in runtimes:
        for base in [a for a in arms[rt] if a!='active']:
            c=compare(rows,rt,base,seed=args.seed,family_size=len(arms[rt])-1)
            if c['paired_runs']!=len(selected)*repeats:c.update(verdict='INCONCLUSIVE',reason='MISSING_PLANNED_PAIRED_RUNS')
            report.comparisons.append(c)
            status='FAIL' if c['verdict']=='REGRESSION_OBSERVED' else 'PASS' if c['verdict']=='LATENCY_IMPROVEMENT_ON_THIS_SUITE' else 'INCONCLUSIVE'
            report.add('comparison',rt+'_active_vs_'+base,status,c)
    report.add('comparison','overall_efficiency','INCONCLUSIVE',
        'A functional pass or latency change does not prove total efficiency. Complete native+Jev cost and representative independent workloads are required. Tiny built-in tasks are not a SWE-bench equivalent.')
