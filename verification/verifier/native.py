"""Native CLI driver belongs to the verifier, not to the orchestration product."""
from __future__ import annotations
import json, os, re, shlex, shutil, sys, tempfile, time, uuid
from pathlib import Path
from .common import Blocked, Inconclusive, clean_env, read_json, write_json, write_private, run_process, tree_manifest, sha, parse_jsonl, redact, secrets_from
from .target import Target
from .tasks import create_workspace, judge
from .evidence import terminal_result, load_hook_records, assess_routing, metadata_from_transcript

ROOT=Path(__file__).resolve().parent.parent


def native_auth(runtime,home,values,reuse_login=False):
    env=clean_env(home)
    if runtime=='claude':
        for k,v in values.items():
            if v and (k in ('ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN') or k.startswith('ANTHROPIC_DEFAULT_')):env[k]=v
        if not (env.get('ANTHROPIC_API_KEY') or env.get('CLAUDE_CODE_OAUTH_TOKEN')):
            source=Path(os.environ.get('CLAUDE_CONFIG_DIR',str(Path.home()/'.claude')))/'.credentials.json'
            if not reuse_login or not source.is_file():raise Blocked('CLAUDE_AUTH_REQUIRED: set API key/OAuth token, or --reuse-cli-login for a file-based login. OS keychain-only login is not copied.')
            write_private(home/'.claude/.credentials.json',source.read_bytes())
    else:
        if values.get('CODEX_API_KEY'):env['CODEX_API_KEY']=values['CODEX_API_KEY']
        else:
            source=Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex')))/'auth.json'
            if not reuse_login or not source.is_file():raise Blocked('CODEX_AUTH_REQUIRED: set CODEX_API_KEY or explicitly use --reuse-cli-login.')
            write_private(home/'.codex/auth.json',source.read_bytes())
    return env


def remove_credentials(home:Path):
    for p in [home/'.claude/.credentials.json',home/'.codex/auth.json',home/'.config/jev-hooks/.env',home.parent/'input.env']:
        try:p.unlink(missing_ok=True)
        except OSError:pass


def create_observer(target:Target,runtime:str,arm:str,artifacts:Path):
    nativefile=target.home/('.claude/settings.json' if runtime=='claude' else '.codex/hooks.json')
    original=read_json(nativefile);sut_rules={}
    if arm not in ('native','ultracode'):
        for event,groups in original.get('hooks',{}).items():
            if len(groups)>1:raise Blocked('Multiple hook groups require a different adapter; not silently merged.')
            for group in groups:
                if len(group['hooks'])!=1:raise Blocked('Multiple SUT hook handlers unsupported')
                cmd=group['hooks'][0]
                if cmd.get('type')!='command':raise Blocked('This SUT adapter expects command hooks')
                argv=shlex.split(cmd['command'])
                if len(argv)!=6 or Path(argv[1]).resolve()!=target.installed_entry.resolve() or argv[2:4]!=['--runtime',runtime] or argv[4]!='--config' or Path(argv[5]).resolve()!=target.config_file.resolve():
                    raise Blocked('Unexpected installer hook command; review before execution')
                sut_rules.setdefault(event,[]).append({'matcher':group.get('matcher'),'argv':argv})
    nonce=uuid.uuid4().hex
    spec={'nonce':nonce,'home':str(target.home),'project':str(target.project),'evidence_dir':str(artifacts),
          'sut_rules':sut_rules,'env_file':str(target.config_file.parent/'.env')}
    specfile=target.work/'observer.json';write_json(specfile,spec)
    command=shlex.join([sys.executable,str(ROOT/'verifier/callback.py'),'--spec',str(specfile)])
    events=['SessionStart','PreToolUse','PostToolUse','SubagentStart','SubagentStop','UserPromptSubmit','Stop','SessionEnd']
    if runtime=='claude':events+=['PostToolUseFailure']
    hooks={event:[{'hooks':[{'type':'command','command':command,'timeout':12}]}] for event in events}
    # Keep profiles absent from a native baseline, not just unused.
    if arm in ('native','ultracode'):
        shutil.rmtree(target.home/('.claude' if runtime=='claude' else '.codex')/'agents',ignore_errors=True)
    if runtime=='claude':
        write_json(nativefile,{'hooks':hooks})
    else:
        write_json(nativefile,{'hooks':hooks})
        write_private(target.home/'.codex/config.toml',
            'approval_policy = "never"\nsandbox_mode = "workspace-write"\n[agents]\nenabled = true\n')
    # Human-readable, exact hook definition approval material. No auth files are included.
    write_json(artifacts/'review-hooks.json',{'native_configuration':read_json(nativefile),
        'observer_spec':{k:v for k,v in spec.items() if k!='env_file'},
        'observer_sha256':sha((ROOT/'verifier/callback.py').read_bytes()),
        'sut_callback_sha256':sha(target.installed_entry.read_bytes())})
    return nonce


def collect_native_transcripts(home:Path,artifacts:Path,secrets:list[str]):
    # Capture only this disposable native HOME. Never scan the user's global history.
    seen=0
    for native_dir in (home/'.codex/sessions',home/'.claude/projects'):
        if not native_dir.exists():continue
        for f in native_dir.rglob('*.jsonl'):
            if f.is_symlink() or f.stat().st_size>16_000_000:continue
            seen+=1
            if seen>256:break
            text=redact(f.read_text(encoding='utf-8'),secrets);rows,_=parse_jsonl(text)
            meta=metadata_from_transcript(rows)
            ident=sha(str(f))[:24]
            write_private(artifacts/'transcripts'/(ident+'.jsonl'),text)
            write_json(artifacts/'transcripts'/(ident+'.meta.json'),{'source':'isolated_native_HOME','source_path':str(f),
                'agent_id':meta['agent_ids'][0] if len(meta['agent_ids'])==1 else meta.get('session_id'),
                'sha256':sha(f.read_bytes())})


def cli_argv(runtime,binary,help_text,target,values,arm,approve_hooks,timeout):
    if runtime=='claude':
        required=['--output-format','--settings','--model']
        if not all(x in help_text for x in required):raise Blocked('UNSUPPORTED_CLAUDE_CLI_FLAGS')
        args=[binary,'-p','--output-format','stream-json','--verbose',
              '--settings',str(target.home/'.claude/settings.json'),'--setting-sources','user',
              '--model',values.get('VERIFY_CLAUDE_MAIN_MODEL','opus'),
              '--permission-mode','acceptEdits','--max-turns',values.get('VERIFY_CLAUDE_MAX_TURNS','20')]
        args+=['--allowedTools','Read,Edit,Write,Glob,Grep,Agent,Task,Workflow,SubagentHandback']
        if '--max-budget-usd' in help_text:args+=['--max-budget-usd',values.get('VERIFY_CLAUDE_MAX_BUDGET_USD','3')]
        if '--include-hook-events' in help_text:args+=['--include-hook-events']
        if '--forward-subagent-text' in help_text:args+=['--forward-subagent-text']
        if '--debug-file' in help_text:args+=['--debug-file',str(target.work/'claude-debug.log')]
        if arm=='ultracode':
            if '--effort' not in help_text or 'ultracode' not in help_text:raise Blocked('ULTRACODE_NOT_ADVERTISED_BY_INSTALLED_CLI')
            args+=['--effort','ultracode']
        elif values.get('VERIFY_CLAUDE_MAIN_EFFORT'):args+=['--effort',values['VERIFY_CLAUDE_MAIN_EFFORT']]
        return args
    if not approve_hooks:
        raise Blocked('CODEX_HOOK_APPROVAL_REQUIRED: --approve-test-hooks authorizes only the generated isolated test hook set; no approval/sandbox bypass.')
    if '--dangerously-bypass-hook-trust' not in help_text:
        raise Blocked('INSTALLED_CODEX_HAS_NO_ONE_SHOT_HOOK_TRUST_FLAG; update or use manual native hook trust outside this automated adapter.')
    args=[binary,'--dangerously-bypass-hook-trust','-c','approval_policy="never"','exec','--json','--sandbox','workspace-write',
          '--model',values.get('VERIFY_CODEX_MAIN_MODEL','gpt-6-sol')]
    if values.get('VERIFY_CODEX_MAIN_EFFORT'):args+=['-c','model_reasoning_effort='+json.dumps(values['VERIFY_CODEX_MAIN_EFFORT'])]
    if values.get('VERIFY_CODEX_BASE_URL'):args+=['-c','openai_base_url='+json.dumps(values['VERIFY_CODEX_BASE_URL'])]
    return args


def one_trial(*,source,node,binary,help_text,runtime,arm,task,repeat,values,gateway,artifacts,
              registry=None,approve_hooks=False,reuse_login=False,timeout=240,smoke=False):
    artifacts.mkdir(parents=True,exist_ok=True)
    start_record=len(gateway.records)
    with tempfile.TemporaryDirectory(prefix='jev-native-verifier-') as td:
        work=Path(td);target=Target(source,work,node,values,artifacts,registry)
        try:
            mode='active' if arm=='active' else 'shadow' if arm=='shadow' else 'off'
            target.install(mode,gateway=gateway)
            native_env=native_auth(runtime,target.home,values,reuse_login)
            before=create_workspace(task,target.project,node,target.env,artifacts)
            nonce=create_observer(target,runtime,arm,artifacts)
            native_config=target.home/('.claude/settings.json' if runtime=='claude' else '.codex/hooks.json')
            settings_hash=sha(native_config.read_bytes())
            profile_before=tree_manifest(target.home/('.claude' if runtime=='claude' else '.codex')/'agents') if arm not in ('native','ultracode') else {}
            prompt=task['spec']+'\nWork only in src/*.mjs in this fixture. Do not change configuration or install packages. Implement and finish; independent checks will run afterwards. Use your native tools as needed.'
            if smoke:
                prompt+='\nIntegration probe: delegate exactly one bounded part through the native Agent/spawn_agent tool using the built-in general-purpose/default worker, do not specify a model or effort yourself. Wait for the native child and integrate its result. Do not start another Claude/Codex CLI process.'
            write_private(artifacts/'prompt.txt',prompt)
            args=cli_argv(runtime,binary,help_text,target,values,arm,approve_hooks,timeout)
            p=run_process(args,cwd=target.project,env=native_env,timeout=timeout,stdin=prompt,log_prefix=artifacts/'native',secrets=secrets_from(values))
            collect_native_transcripts(target.home,artifacts,secrets_from(values))
            if (target.work/'claude-debug.log').exists():
                write_private(artifacts/'native-debug.log',redact((target.work/'claude-debug.log').read_text(errors='replace')[:20_000_000],secrets_from(values)))
            events,malformed=parse_jsonl(p.stdout);term=terminal_result(runtime,events)
            hooks=load_hook_records(artifacts,nonce)
            routing=assess_routing(hooks,runtime,target,artifacts,json.loads(values.get('VERIFY_MODEL_ALIASES_JSON','{}')))
            after=tree_manifest(target.project)
            changed=[f for f in set(before)|set(after) if before.get(f)!=after.get(f)]
            outside=[f for f in changed if not f.startswith('src/')]
            grade=judge(task,target.project,work/'judge',node,artifacts)
            profile_after=tree_manifest(target.home/('.claude' if runtime=='claude' else '.codex')/'agents') if arm not in ('native','ultracode') else {}
            contaminated=bool(outside) or sha(native_config.read_bytes())!=settings_hash or profile_before!=profile_after
            # Only typed runtime init can establish ultracode; keyword mentions cannot.
            ultra=any(e.get('type')=='system' and e.get('subtype')=='init' and (e.get('ultracode') is True or isinstance(e.get('settings'),dict) and e['settings'].get('ultracode') is True) for e in events)
            write_json(artifacts/'routing-observations.json',routing)
            write_json(artifacts/'independent-grade.json',grade|{'changed_files':changed,'outside_allowed_scope':outside})
            # Keep a solution snapshot for inspection, without native auth or key files.
            for f in (target.project/'src').rglob('*'):
                if f.is_file() and not f.is_symlink():write_private(artifacts/'solution/src'/f.relative_to(target.project/'src'),f.read_bytes())
            jev=gateway.records[start_record:]
            tokens={'input_tokens':0,'output_tokens':0};complete_usage=True
            for call in jev:
                u=call.get('response',{}).get('usage')
                if not isinstance(u,dict):complete_usage=False;continue
                for k in tokens:tokens[k]+=u.get(k,0)
            result={'task_id':task['id'],'repeat':repeat,'runtime':runtime,'arm':arm,
              'evidence_source':'SYNTHETIC_TEST_DRIVER' if values.get('VERIFY_SELF_TEST_DRIVER')=='1' else 'REAL_NATIVE_PROCESS',
              'passed':bool(grade['passed'] and term['completed'] and p.returncode==0 and not p.timed_out and not contaminated),
              'duration_ms':p.duration_ms,'timeout':p.timed_out,'returncode':p.returncode,'terminal':term,
              'malformed_stdout_lines':malformed,'contaminated':contaminated,'outside_allowed_scope':outside,
              'observer_seen':routing['observer_seen'],'routing':routing,
              'active_route_observed':bool(routing['routes']) and all(r['application_status']=='PASS' for r in routing['routes']),
              'model_effort_observed':bool(routing['routes']) and all(r['model_status']=='PASS' and r['effort_status'] in ('PASS','NOT_APPLICABLE') for r in routing['routes']),
              'ultracode_requested':arm=='ultracode','ultracode_observed':ultra,
              'jev_requests':len(jev),'jev_usage':tokens if complete_usage else None,'total_cost_usd':None,
              'total_cost_reason':'No complete independently metered native+Jev cost; never assume zero.',
              'grade':grade,'artifacts':str(artifacts)}
            write_json(artifacts/'trial.json',result)
            return result
        finally:remove_credentials(target.home)
