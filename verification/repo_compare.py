#!/usr/bin/env python3
"""Paired real-repository Claude runs. Paid calls require explicit operator opt-in."""
from __future__ import annotations
import argparse, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
from verifier.common import Blocked, Report, canonical, clean_env, load_env, parse_jsonl, read_json, run_process, secrets_from, sha, tree_manifest, write_json, write_private
from verifier.evidence import assess_routing, child_metadata, load_hook_records, terminal_result
from verifier.gateway import Gateway
from verifier.native import cli_argv, collect_native_transcripts, create_observer, native_auth, remove_credentials
from verifier.repo_tasks import TASKS, grade, prepare, snapshot
from verifier.target import Target

ROOT=Path(__file__).resolve().parent.parent
ARMS=('native','active','controller')


def parser():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--registry',type=Path,required=True,help='Operator-confirmed Claude model/effort registry outside the repository')
    p.add_argument('--env-file',type=Path,required=True,help='Private CLI and TypeSafe credentials and JEV_ALLOW_EGRESS=true')
    p.add_argument('--out',type=Path,required=True,help='New private results directory outside the repository')
    p.add_argument('--task',choices=['both']+[t['id'] for t in TASKS],default='both')
    p.add_argument('--repetitions',type=int,default=1)
    p.add_argument('--timeout',type=int,default=600,help='Per-session wall-time limit in seconds, not a billing cap')
    p.add_argument('--max-turns',type=int,default=32,help='Per-session CLI limit; truncation is not task completion')
    p.add_argument('--max-budget-usd',type=float,default=3,help='Requested CLI per-session limit, NOT a native+Jev total cap')
    p.add_argument('--max-jev-requests',type=int,default=24)
    p.add_argument('--accept-costs',action='store_true',help='Explicitly permit actual paid native and Jev calls')
    p.add_argument('--reuse-cli-login',action='store_true',help='Opt in to copying a file-based CLI login into the disposable HOME')
    p.add_argument('--plan',action='store_true',help='Show schedule and declared registry without starting CLI processes')
    return p


def confirmed_models(registry):
    value=read_json(registry)
    if not isinstance(value,dict) or not isinstance(value.get('models'),list):raise Blocked('INVALID_REGISTRY')
    entries=[m for m in value['models'] if isinstance(m,dict) and m.get('runtime')=='claude' and m.get('enabled') is True]
    if len({m.get('slot') for m in entries})!=len(entries):raise Blocked('DUPLICATE_ENABLED_CLAUDE_SLOT')
    models={m['slot']:m for m in entries}
    for slot,needed,roles in [('light',{'high'},{'research'}),
                              ('standard',{'high','xhigh'},{'implement','review'}),
                              ('strategic',{'xhigh'},{'plan','implement'})]:
        m=models.get(slot)
        efforts=m.get('supportedEfforts') if m else None
        assigned=m.get('roles') if m else None
        if (not m or m.get('availability')!='confirmed' or not isinstance(m.get('model'),str) or not m['model']
                or not isinstance(efforts,list) or not needed.issubset(set(x for x in efforts if isinstance(x,str)))
                or not isinstance(assigned,list) or not roles.issubset(set(x for x in assigned if isinstance(x,str)))):
            raise Blocked('CONFIRMED_CLAUDE_PROFILE_REQUIRED: '+slot)
    return {slot:models[slot]['model'] for slot in ('light','standard','strategic')}


def runtime_info(node,binary):
    with tempfile.TemporaryDirectory(prefix='jev-repo-preflight-') as td:
        work=Path(td);env=clean_env(work/'home')
        checks={name:run_process(args,cwd=work,env=env,timeout=15) for name,args in {
            'node':[node,'--version'],'claude':[binary,'--version'],'help':[binary,'--help']}.items()}
    if any(p.returncode or p.timed_out for p in checks.values()):raise Blocked('CLI_PREFLIGHT_FAILED')
    if int(checks['node'].stdout.strip().lstrip('v').split('.')[0])<22:raise Blocked('NODE_22_REQUIRED')
    text=checks['help'].stdout+checks['help'].stderr
    for flag in ('--output-format','--settings','--model','--setting-sources','--max-budget-usd','--allowedTools'):
        if flag not in text:raise Blocked('UNSUPPORTED_CLAUDE_CLI_FLAG: '+flag)
    return {'node':checks['node'].stdout.strip(),'claude':checks['claude'].stdout.strip(),'help':text}


def prompt_for(task,arm):
    common=(task['goal']+'\nUse one or more native Agent delegations for repository work. Main coordinates; workers implement and run checks. '
            'Do not specify a child model or effort manually. Do not start another CLI process, install dependencies, change authentication or use Workflow. '
            'Limit source edits to '+task['file']+' and regression tests in '+task['test']+'. Do not change tests just to make a check pass. '
            'Report actual evidence and remaining failures. The independent judge uses its own unmodified tests.')
    if arm!='controller':return common
    return (common+'\nController protocol: the first delegation must be native Agent with description JEV:bootstrap:plan for Astra planning. '
            'Ask the planner to propose a schema-2 controller plan with the goalHash from UserPromptSubmit, version=1, summary, '
            'and tasks. Each task has id, phase, summary, acceptance, dependencies, readPaths, writePaths, risk, complexity, reasoning, '
            'uncertain, interfacesChanging, highLoss, information. Use meaningful bounded tasks and confirmed profiles; no unknown fields. '
            'A private .jev directory is already prepared. Main records the plan at .jev/controller-plan.json, then delegates each task '
            'with description JEV:<task-id>. For dependencies, accept only observed completed child work and record controller-status.json '
            'with goalHash, exact plan file SHA-256 as planRevision and accepted taskId/toolUseId/agentId/evidenceHash. '
            'If tool identifiers or worker identity cannot be observed, report the blockage rather than inventing them.')


def require_commit(root,expected):
    current=subprocess.run(['git','-C',str(root),'rev-parse','HEAD'],capture_output=True,text=True,check=True).stdout.strip()
    if current!=expected:raise Blocked('SOURCE_COMMIT_CHANGED_DURING_COMPARISON')


def trial(root,install_source,expected_commit,task,arm,repeat,node,binary,info,models,values,registry,gateway,artifacts,args):
    artifacts.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='jev-repo-trial-') as td:
        target=Target(install_source,Path(td),node,values,artifacts,registry)
        require_commit(root,expected_commit)
        prepared=prepare(root,target.project,task)
        if prepared['commit']!=expected_commit:raise Blocked('SOURCE_COMMIT_CHANGED_DURING_COMPARISON')
        private=target.project/'.jev';private.mkdir(mode=0o700)
        before=tree_manifest(target.project)
        first_call=len(gateway.records)
        try:
            target.install('active' if arm=='active' else 'controller' if arm=='controller' else 'off',
                           runtime='claude',gateway=gateway if arm=='active' else None)
            env=native_auth('claude',target.home,values,args.reuse_cli_login)
            env['PATH']=str(Path(node).resolve().parent)+os.pathsep+str(Path(sys.executable).resolve().parent)+os.pathsep+env.get('PATH','')
            nonce=create_observer(target,'claude',arm,artifacts)
            prompt=prompt_for(task,arm)
            write_private(artifacts/'prompt.txt',prompt)
            params=values|{'VERIFY_CLAUDE_MAIN_MODEL':models['standard'],'VERIFY_CLAUDE_MAX_TURNS':str(args.max_turns),
                           'VERIFY_CLAUDE_MAX_BUDGET_USD':str(args.max_budget_usd)}
            command=cli_argv('claude',binary,info['help'],target,params,arm,False,args.timeout)
            if '--max-turns' not in info['help']:
                turn_flag=command.index('--max-turns');del command[turn_flag:turn_flag+2]
            command[command.index('--allowedTools')+1]+=',Bash'
            proc=run_process(command,cwd=target.project,env=env,timeout=args.timeout,stdin=prompt,
                             log_prefix=artifacts/'native',secrets=secrets_from(values))
            collect_native_transcripts(target.home,artifacts,secrets_from(values))
            events,malformed=parse_jsonl(proc.stdout);terminal=terminal_result('claude',events)
            hooks=load_hook_records(artifacts,nonce)
            routes=assess_routing(hooks,'claude',target,artifacts,{})
            children=child_metadata(artifacts,hooks)
            changed=tree_manifest(target.project)
            edits=sorted(k for k in set(before)|set(changed) if before.get(k)!=changed.get(k))
            allowed={task['file'],task['test']}
            if arm=='controller':allowed.update(('.jev/controller-plan.json','.jev/controller-status.json'))
            outside=[k for k in edits if k not in allowed]
            require_commit(root,expected_commit)
            graded=grade(root,target.project,task,node,artifacts)
            require_commit(root,expected_commit)
            for file in (task['file'],task['test']):
                path=target.project/file
                if path.is_file() and not path.is_symlink() and path.stat().st_size<1_000_000:
                    write_private(artifacts/'solution'/file,path.read_bytes())
            calls=gateway.records[first_call:]
            usage=[c.get('response',{}).get('usage') for c in calls]
            real_jev=all(c.get('source')=='REAL_UPSTREAM_HTTP' and c.get('status')==200 and c.get('schema_valid') is True for c in calls)
            applied=bool(routes['routes']) and not any(r['correlation_ambiguous'] or r['application_status']!='PASS' for r in routes['routes'])
            implementation=any(r['profile'].startswith('jev4_implement_') for r in routes['routes']) if arm=='controller' else None
            row={'task_id':task['id'],'arm':arm,'repeat':repeat,'source_commit':prepared['commit'],
                 'goal_sha256':prepared['goal_sha256'],'prompt_sha256':sha(prompt),'seed_sha256':prepared['seed_sha256'],
                 'trusted_test_sha256':graded.get('test_sha256'),'duration_ms':proc.duration_ms,
                 'grade_duration_ms':graded.get('duration_ms'),'exit_code':proc.returncode,'timed_out':proc.timed_out,
                 'output_limit':proc.output_limit,'malformed_stdout_lines':malformed,'terminal':terminal,
                 'observed_hooks':bool(hooks),'observed_delegations':routes['native_delegations_seen'],
                 'route_count':len(routes['routes']),'route_linked':applied,
                 'controller_implementation_route_observed':implementation,'routes':routes['routes'],
                 'typed_child_metadata':{k:{'models':v['models'],'efforts':v['efforts']} for k,v in children.items()},
                 'jev_requests':len(calls),'jev_upstream_valid':real_jev and bool(calls) if arm=='active' else None,
                 'jev_tokens':{'input_tokens':sum(u['input_tokens'] for u in usage),
                               'output_tokens':sum(u['output_tokens'] for u in usage)} if usage and all(isinstance(u,dict) and
                               all(isinstance(u.get(k),int) for k in ('input_tokens','output_tokens')) for u in usage) else None,
                 'total_billed_cost_usd':None,'total_cost_reason':'CLI cost is reported, not an invoice; Jev price/total is unmetered.',
                 'grade':graded,'edited_files':edits,'outside_allowed_source':outside,
                 'quality_passed':bool(graded['passed'] and not outside),'artifacts':str(artifacts)}
            write_json(artifacts/'trial.json',row)
            return row
        finally:remove_credentials(target.home)


def comparisons(rows,tasks,repetitions):
    result=[]
    for task in tasks:
        for repeat in range(repetitions):
            matched={r['arm']:r for r in rows if r['task_id']==task['id'] and r['repeat']==repeat}
            if set(matched)!=set(ARMS):
                result.append({'task':task['id'],'repeat':repeat,'verdict':'INCONCLUSIVE','reason':'MISSING_PAIRED_RUN'});continue
            active=matched['active'];controller=matched['controller'];native=matched['native']
            valid=(all(r['exit_code']==0 and not r['timed_out'] and r['terminal']['completed'] and r['observed_hooks'] and r['observed_delegations'] for r in matched.values())
                   and active['route_linked'] and active['jev_upstream_valid'] and controller['route_linked']
                   and controller['controller_implementation_route_observed']
                   and all(all(route['model_status']=='PASS' and route['effort_status'] in ('PASS','NOT_APPLICABLE')
                               for route in matched[arm]['routes']) for arm in ('active','controller')))
            result.append({'task':task['id'],'repeat':repeat,'verdict':'DESCRIPTIVE_ONLY' if valid else 'INCONCLUSIVE',
                           'reason':'Single paired maintenance task cannot establish a general quality/cost advantage.' if valid else 'Execution, Jev route, or native worker linkage unobserved.',
                           'quality_passed':{a:matched[a]['quality_passed'] for a in ARMS},
                           'duration_ms':{a:matched[a]['duration_ms'] for a in ARMS},
                           'cli_reported_cost_usd':{a:matched[a]['terminal']['cli_reported_cost_usd'] for a in ARMS},
                           'total_billed_cost_usd':None})
    return result


def main():
    args=parser().parse_args()
    if sys.version_info<(3,11):raise Blocked('PYTHON_3_11_REQUIRED')
    if args.repetitions<1 or args.timeout<1 or args.max_turns<1 or args.max_budget_usd<=0 or args.max_jev_requests<1:
        raise Blocked('POSITIVE_LIMITS_REQUIRED')
    tasks=TASKS if args.task=='both' else tuple(t for t in TASKS if t['id']==args.task)
    registry=args.registry.expanduser().resolve();envfile=args.env_file.expanduser().resolve()
    if not registry.is_file() or registry.is_symlink() or not envfile.is_file() or envfile.is_symlink():raise Blocked('PRIVATE_INPUTS_REQUIRED')
    if registry.is_relative_to(ROOT) or envfile.is_relative_to(ROOT):raise Blocked('PRIVATE_INPUTS_MUST_BE_OUTSIDE_REPOSITORY')
    out=args.out.expanduser().resolve()
    if out==ROOT or out.is_relative_to(ROOT) or ROOT.is_relative_to(out):raise Blocked('PRIVATE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY')
    if out.exists() and any(out.iterdir()):raise Blocked('OUTPUT_DIRECTORY_NOT_EMPTY')
    values=load_env(envfile);models=confirmed_models(registry)
    override_keys=[k for k in values if k.startswith(('ANTHROPIC_DEFAULT_','JEV_CLAUDE_')) or
                   k in ('CLAUDE_CODE_SUBAGENT_MODEL','CLAUDE_CODE_EFFORT_LEVEL')]
    if override_keys:raise Blocked('FORCED_MODEL_OR_EFFORT_OVERRIDES_REQUIRE_REMOVAL: '+','.join(sorted(override_keys)))
    if values.get('JEV_CONTROLLER_CRITIQUE')=='true':raise Blocked('DISABLE_OPTIONAL_CONTROLLER_CRITIQUE_FOR_THIS_PILOT')
    schedule=[(task,rep,ARMS[(i+rep+index)%3]) for i,task in enumerate(tasks) for rep in range(args.repetitions) for index in range(3)]
    plan={'tasks':[t['id'] for t in tasks],'repetitions':args.repetitions,'sessions':len(schedule),
          'sequence':[{'task':t['id'],'repeat':rep,'arm':arm} for t,rep,arm in schedule],
          'source_commit_only':True,'registry_sha256':sha(registry.read_bytes()),
          'models':models,'cost':'Paid native and TypeSafe calls; per-session requested CLI budget is not an aggregate billing cap.',
          'max_budget_usd_per_native_session':args.max_budget_usd,'max_jev_requests':args.max_jev_requests,
          'time_limit_seconds_per_session':args.timeout,'main_turn_limit':args.max_turns,'total_billed_cost_usd':None}
    print(json.dumps(plan,ensure_ascii=False,indent=2),flush=True)
    if args.plan:return 0
    if not args.accept_costs:raise Blocked('PAID_RUN_REQUIRES_EXPLICIT_--accept-costs')
    if not values.get('ANTHROPIC_API_KEY') and not values.get('CLAUDE_CODE_OAUTH_TOKEN') and not args.reuse_cli_login:
        raise Blocked('CLAUDE_AUTH_REQUIRED')
    if not values.get('TYPESAFE_API_KEY') or values.get('JEV_ALLOW_EGRESS')!='true':
        raise Blocked('ACTIVE_REQUIRES_REAL_TYPESAFE_KEY_AND_EGRESS_CONSENT')
    node=values.get('VERIFY_NODE_BIN') or shutil.which('node') or 'node'
    if '/.asdf/shims/' in node:
        try:r=subprocess.run(['asdf','which','node'],cwd=ROOT,capture_output=True,text=True,timeout=15)
        except (FileNotFoundError,subprocess.TimeoutExpired) as e:raise Blocked('RESOLVED_NODE_REQUIRED') from e
        if r.returncode:raise Blocked('RESOLVED_NODE_REQUIRED')
        node=r.stdout.strip()
    node=str(Path(node).resolve())
    binary=str(Path(values.get('VERIFY_CLAUDE_BIN') or shutil.which('claude') or 'claude').resolve())
    if not Path(node).is_file() or not Path(binary).is_file():raise Blocked('DIRECT_NODE_AND_CLAUDE_EXECUTABLES_REQUIRED')
    info=runtime_info(node,binary)
    if not (ROOT/'.git').is_dir():raise Blocked('SOURCE_MUST_BE_COMMITTED_GIT_REPOSITORY')
    # Preflight before the first paid call, including a canary for every seeded task.
    with tempfile.TemporaryDirectory(prefix='jev-repo-canaries-') as td:
        for task in tasks:
            project=Path(td)/task['id'];project.mkdir();prepare(ROOT,project,task)
            if grade(ROOT,project,task,node,Path(td)/('seed-'+task['id']))['passed']:
                raise Blocked('SEED_WAS_NOT_REJECTED: '+task['id'])
            source=project/task['file'];source.write_text(source.read_text().replace(task['seed'],task['fixed']))
            if not grade(ROOT,project,task,node,Path(td)/('reference-'+task['id']))['passed']:
                raise Blocked('REFERENCE_DID_NOT_PASS: '+task['id'])
    report=Report(out,secrets_from(values))
    report.meta['plan']=plan
    report.meta['native_versions']={'claude':info['claude'],'node':info['node']}
    report.meta['turn_limit_enforced']='--max-turns' in info['help']
    report.add('preflight','canaries','PASS',{'seed_rejected_and_reference_accepted':[t['id'] for t in tasks]})
    frozen_registry=out/'inputs/registry.json'
    write_private(frozen_registry,registry.read_bytes())
    rows=[]
    try:
        with tempfile.TemporaryDirectory(prefix='jev-repo-reference-') as ref, Gateway(
                synthetic=False,endpoint=values.get('TYPESAFE_BASE_URL','https://api.typesafe.ai'),
                key=values['TYPESAFE_API_KEY'],max_requests=args.max_jev_requests,
                artifact=out/'artifacts/real-jev-http.json') as gateway:
            expected_commit=snapshot(ROOT,Path(ref))
            reference_hash=sha(canonical(tree_manifest(Path(ref))))
            report.meta['source_commit']=expected_commit
            report.meta['reference_snapshot_sha256']=reference_hash
            for task,repeat,arm in schedule:
                print(f'[RUN] {task["id"]}/{repeat+1}/{arm}',flush=True)
                artifacts=out/'artifacts'/task['id']/str(repeat)/arm
                try:
                    row=trial(ROOT,Path(ref)/'orchestration',expected_commit,task,arm,repeat,node,binary,info,
                              models,values,frozen_registry,gateway,artifacts,args)
                    rows.append(row);report.trials.append(row)
                    instrumented=(row['observed_hooks'] and row['observed_delegations']>0 and
                                  (arm=='native' or row['route_linked']) and
                                  (arm!='active' or row['jev_upstream_valid']) and
                                  (arm!='controller' or row['controller_implementation_route_observed']))
                    status=('FAIL' if row['exit_code']!=0 or row['timed_out'] else
                            'INCONCLUSIVE' if not instrumented or not row['terminal']['completed'] else
                            'PASS' if row['quality_passed'] else 'FAIL')
                    report.add('trial',f'{task["id"]}-{repeat}-{arm}',status,{
                        'grade_passed':row['grade']['passed'],'observed_hooks':row['observed_hooks'],
                        'route_linked':row['route_linked'],'duration_ms':row['duration_ms']})
                    write_json(out/'progress.json',rows)
                except Blocked as e:
                    report.add('trial',f'{task["id"]}-{repeat}-{arm}','BLOCKED',str(e))
                except Exception as e:
                    report.add('trial',f'{task["id"]}-{repeat}-{arm}','FAIL',f'{type(e).__name__}: {e}')
                if (sha(canonical(tree_manifest(Path(ref))))!=reference_hash or
                        sha(frozen_registry.read_bytes())!=plan['registry_sha256']):
                    report.add('integrity','reference_and_registry','FAIL','Frozen input changed; remaining arms not comparable.')
                    break
    except KeyboardInterrupt:
        report.add('runner','interrupt','BLOCKED','Interrupted; partial results retained and cannot establish superiority.')
    except Blocked as e:
        report.add('runner','prerequisite','BLOCKED',str(e))
    except Exception as e:
        report.add('runner','unexpected_error','FAIL',f'{type(e).__name__}: {e}')
    for row in comparisons(rows,tasks,args.repetitions):
        report.comparisons.append(row)
        report.add('comparison',f'{row["task"]}-{row["repeat"]}','INCONCLUSIVE',row)
    result=report.finish()
    print(f'Private report: {out}/report.json (no public upload); exit {result}',flush=True)
    return result


if __name__=='__main__':
    try:sys.exit(main())
    except (Blocked,ValueError,OSError) as e:
        print('BLOCKED: '+str(e),file=sys.stderr);sys.exit(2)
