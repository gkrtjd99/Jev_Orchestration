"""Versioned black-box adapter: execute the public installer and stdin hook only."""
from __future__ import annotations
import json, os, re, shutil, tomllib, uuid
from pathlib import Path
from .common import Blocked, clean_env, read_json, run_process, write_private, write_json, sha

class Target:
    def __init__(self, source: Path, work: Path, node: str, values: dict[str,str], artifacts: Path,
                 registry: Path|None=None):
        self.source=source.resolve();self.work=work;self.node=node;self.values=values;self.artifacts=artifacts;self.registry=registry
        self.home=work/'home';self.project=work/'project';self.home.mkdir(parents=True);self.project.mkdir(parents=True)
        self.config_file=self.home/'.config/jev-hooks/config.json'
        self.env=clean_env(self.home)
    def install(self,mode='active', *, gateway=None, placeholder_key=False):
        entry=self.source/'scripts/install.mjs'
        if not entry.is_file(): raise Blocked('UNSUPPORTED_SUT: scripts/install.mjs missing')
        allow={k:v for k,v in self.values.items() if k.startswith('JEV_') or k in ('TYPESAFE_API_KEY','TYPESAFE_BASE_URL')}
        allow['JEV_MODE']=mode
        if placeholder_key: allow['TYPESAFE_API_KEY']='synthetic-key-not-a-credential'
        if gateway: allow['TYPESAFE_API_KEY']=gateway.access_token
        envfile=self.work/'input.env'
        # Values containing a newline cannot be represented by this SUT env parser.
        if any('\n' in v or '\r' in v for v in allow.values()): raise ValueError('Newline in env value')
        write_private(envfile,'\n'.join(k+'='+v for k,v in allow.items())+'\n')
        argv=[self.node,str(entry),'--home',str(self.home),'--project',str(self.project),'--runtime','both','--mode',mode,'--env-file',str(envfile),'--yes']
        if self.registry: argv+=['--registry',str(self.registry)]
        proc=run_process(argv,cwd=self.source,env=self.env,timeout=30,log_prefix=self.artifacts/'installer',
                         secrets=[v for k,v in allow.items() if 'KEY' in k])
        if proc.returncode!=0: raise AssertionError('Installer failed: '+proc.stderr[:300])
        config=read_json(self.config_file)
        if config.get('schema')!=4: raise Blocked('UNSUPPORTED_SUT_SCHEMA: this adapter supports schema 4')
        self.installed_entry=self.home/'.local/share/jev-hooks'/read_json(self.home/'.config/jev-hooks/installation.json')['version']/'bin/jev-hook.mjs'
        self.base_config=json.loads(json.dumps(config))
        if gateway:
            config['endpoint']=gateway.url;config['allowLoopback']=True
            # Installed test-copy override only; source and target timeout policy stay unchanged.
            write_json(self.config_file,config)
            write_private(self.config_file.parent/'.env','TYPESAFE_API_KEY='+allow.get('TYPESAFE_API_KEY','')+'\nJEV_MODE='+mode+'\n')
            write_json(self.artifacts/'instrumentation.json',{
                'kind':'loopback-forwarding-observer','production_source_modified':False,
                'installed_test_config_overrides':['endpoint','allowLoopback'],'preserves_target_timeouts':True,
                'upstream_kind':'SYNTHETIC' if gateway.synthetic else 'REAL_UPSTREAM_HTTP'})
        # v1 safety policy is enabled ONLY inside disposable synthetic fixtures.
        # Live runs must bring an operator-confirmed registry and explicit egress/approval.
        if 'safety' in config and gateway and gateway.synthetic:
            config['safety']['allowEgress']=True
            config['safety']['codexRewriteApproved']=True
            for model in config['registry']['models']:
                model['availability']='confirmed'
                model['capabilitySource']='SYNTHETIC_TEST_FIXTURE_NOT_ACCOUNT_ACCESS'
            # Regenerate profile fingerprints through the public installer, not private SUT imports.
            registry_file=self.work/'synthetic-registry.json';write_json(registry_file,config['registry'])
            argv2=argv+['--registry',str(registry_file)] if not self.registry else argv
            proc2=run_process(argv2,cwd=self.source,env=self.env,timeout=30,log_prefix=self.artifacts/'synthetic-profiles')
            if proc2.returncode:raise AssertionError('Synthetic capability installation failed: '+proc2.stderr[:200])
            regenerated=read_json(self.config_file)
            regenerated['endpoint']=gateway.url;regenerated['allowLoopback']=True
            regenerated['safety']['allowEgress']=True;regenerated['safety']['codexRewriteApproved']=True
            write_json(self.config_file,regenerated)
            write_private(self.config_file.parent/'.env','TYPESAFE_API_KEY='+allow.get('TYPESAFE_API_KEY','')+'\nJEV_MODE='+mode+'\n')
            write_json(self.artifacts/'instrumentation.json',{
                'kind':'synthetic-black-box-fixture','production_source_modified':False,
                'installed_test_config_overrides':['endpoint','allowLoopback','allowEgress','codexRewriteApproved','registry'],
                'capabilities_are_synthetic':True,'upstream_kind':'SYNTHETIC'})
        self.config=read_json(self.config_file)
        return {'schema':config['schema'],'version':read_json(self.source/'package.json')['version'],
                'profiles':{rt:len(config['installedProfiles'].get(rt,{})) for rt in ('claude','codex')},
                'installation_scope':'disposable HOME only'}
    def patch_test_config(self,**fields):
        self.config.update(fields);write_json(self.config_file,self.config)
    def event(self,runtime='claude',kind='PreToolUse',task='Fix the bounded implementation.',**extra):
        base={'session_id':str(uuid.uuid4()),'cwd':str(self.project),'hook_event_name':kind,
              'tool_use_id':'tool-'+uuid.uuid4().hex,'tool_name':'Agent' if runtime=='claude' else 'spawn_agent',
              'tool_input':{'prompt':task,'subagent_type':'general-purpose'} if runtime=='claude' else {'message':task,'agent_type':'default','task_name':'verify_task'}}
        base.update(extra);return base
    def invoke(self,event,runtime='claude',name='hook'):
        write_json(self.artifacts/(name+'.input.json'),event)
        proc=run_process([self.node,str(self.installed_entry),'--runtime',runtime,'--config',str(self.config_file)],
            cwd=self.project,env=self.env,stdin=json.dumps(event),timeout=10,log_prefix=self.artifacts/name,
            secrets=[self.values.get('TYPESAFE_API_KEY','')] if self.values.get('TYPESAFE_API_KEY') else [])
        try:output=json.loads(proc.stdout)
        except ValueError as e:raise AssertionError('Hook stdout is not one JSON object') from e
        if not isinstance(output,dict): raise AssertionError('Invalid hook JSON')
        return output,proc
    def selected_profile(self,output,runtime):
        u=output.get('hookSpecificOutput',{}).get('updatedInput')
        if not isinstance(u,dict): raise AssertionError('NO_ROUTE_APPLIED: '+json.dumps(output)[:280])
        name=u.get('subagent_type') if runtime=='claude' else u.get('agent_type')
        rec=self.config['installedProfiles'].get(runtime,{}).get(name)
        if not rec: raise AssertionError('Selected profile is not in the installed manifest')
        text=Path(rec['path']).read_text()
        if sha(text)!=rec['sha256']: raise AssertionError('Profile changed')
        if runtime=='claude':
            def field(k):
                m=re.search(r'^'+re.escape(k)+r':\s*(.+)$',text,re.M)
                if not m:return None
                try:return json.loads(m[1])
                except ValueError:return m[1].strip()
            model,effort=field('model'),field('effort')
        else:
            parsed=tomllib.loads(text)
            if 'model' in parsed or 'model_reasoning_effort' in parsed: raise AssertionError('Codex profile shadows spawn settings')
            model,effort=u.get('model'),u.get('reasoning_effort')
        return {'profile':name,'requested_model':model,'requested_effort':effort,'runtime':runtime,
                'proof':'REQUEST_ONLY_NOT_EFFECTIVE','input':u}
