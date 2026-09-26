from __future__ import annotations
import json, os, shutil, tempfile, unittest
from unittest.mock import patch
from pathlib import Path
from repo_compare import TASKS, confirmed_models, comparisons, installation_values, main, prompt_for
from verifier.common import load_env
from verifier.target import Target
from verifier.common import Blocked


class RepositoryComparisonTests(unittest.TestCase):
    def test_nonfinite_budget_is_rejected_before_any_input_or_call(self):
        for budget in ('nan','inf','-inf'):
            with self.subTest(budget=budget),patch('sys.argv',['repo_compare.py','--registry','missing',
                    '--env-file','missing','--out','missing','--max-budget-usd='+budget,'--accept-costs']):
                with self.assertRaises(Blocked):main()

    def test_declared_registry_is_not_confirmed_access(self):
        with tempfile.TemporaryDirectory() as td:
            file=Path(td)/'registry.json'
            models=[{'runtime':'claude','slot':slot,'model':'model-'+slot,'enabled':True,
                     'availability':'declared','supportedEfforts':efforts,'roles':roles,
                     'effortByIntent':{str(i):effort for i,effort in enumerate(efforts)}}
                    for slot,efforts,roles in [('light',['high'],['research']),
                                               ('standard',['high','xhigh'],['implement','review']),
                                               ('strategic',['xhigh'],['plan','implement'])]]
            file.write_text(json.dumps({'models':models}))
            with self.assertRaises(Blocked):confirmed_models(file)
            for model in models:model['availability']='confirmed'
            file.write_text(json.dumps({'models':models}))
            self.assertEqual(confirmed_models(file)['standard'],'model-standard')
            models[2]['effortByIntent']={'brief':'high'};file.write_text(json.dumps({'models':models}))
            with self.assertRaises(Blocked):confirmed_models(file)
            models[2]['supportedEfforts']=['high'];file.write_text(json.dumps({'models':models}))
            with self.assertRaises(Blocked):confirmed_models(file)

    def test_env_file_cannot_be_overridden_by_ambient_egress_or_account(self):
        with tempfile.TemporaryDirectory() as td:
            file=Path(td)/'env';file.write_text('ANTHROPIC_API_KEY=from-file\nJEV_ALLOW_EGRESS=false\n')
            previous={k:os.environ.get(k) for k in ('ANTHROPIC_API_KEY','JEV_ALLOW_EGRESS')}
            try:
                os.environ.update(ANTHROPIC_API_KEY='ambient',JEV_ALLOW_EGRESS='true')
                result=load_env(file,inherit=False)
                self.assertEqual(result['ANTHROPIC_API_KEY'],'from-file')
                self.assertEqual(result['JEV_ALLOW_EGRESS'],'false')
            finally:
                for key,value in previous.items():
                    if value is None:os.environ.pop(key,None)
                    else:os.environ[key]=value

    def test_off_and_controller_never_install_unused_typesafe_key(self):
        node=shutil.which('node')
        if node and '/.asdf/shims/' in node:
            import subprocess
            result=subprocess.run(['asdf','which','node'],capture_output=True,text=True)
            if result.returncode==0:node=result.stdout.strip()
        if not node:self.skipTest('Node not available')
        source=Path(__file__).resolve().parents[2]/'orchestration'
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);secret='synthetic-test-token-not-a-real-key'
            values={'TYPESAFE_API_KEY':secret,'JEV_ALLOW_EGRESS':'true'}
            for arm in ('native','controller'):
                target=Target(source,root/arm,node,installation_values(values,arm),root/'logs'/arm)
                target.install('off' if arm=='native' else 'controller',runtime='claude')
                self.assertNotIn(secret,(target.home/'.config/jev-hooks/.env').read_text())
                self.assertNotIn(secret,(target.work/'input.env').read_text())
                self.assertNotIn('JEV_ALLOW_EGRESS=true',(target.work/'input.env').read_text())

    def test_same_goal_but_controller_requires_explicit_protocol(self):
        task=TASKS[0]
        prompts=[prompt_for(task,arm) for arm in ('native','active','controller')]
        self.assertEqual(prompts[0],prompts[1])
        self.assertTrue(all(task['goal'] in text for text in prompts))
        self.assertIn('JEV:bootstrap:plan',prompts[2])
        self.assertNotIn('JEV:bootstrap:plan',prompts[0])

    def test_missing_or_unobserved_arm_cannot_establish_advantage(self):
        self.assertEqual(comparisons([],TASKS[:1],1)[0]['verdict'],'INCONCLUSIVE')
        row={'task_id':TASKS[0]['id'],'repeat':0,'exit_code':0,'timed_out':False,
             'terminal':{'completed':True,'cli_reported_cost_usd':1,'usage':None},'observed_hooks':False,
             'jev_tokens':None,'observed_delegations':0,'route_linked':False,'jev_upstream_valid':False,
             'routes':[],'quality_passed':True,'duration_ms':100}
        rows=[row|{'arm':arm} for arm in ('native','active','controller')]
        self.assertEqual(comparisons(rows,TASKS[:1],1)[0]['verdict'],'INCONCLUSIVE')
        observed=row|{'observed_hooks':True,'observed_delegations':1,'route_linked':True,
                      'jev_upstream_valid':True,'controller_implementation_route_observed':False,
                      'routes':[{'model_status':'PASS','effort_status':'PASS'}]}
        rows=[observed|{'arm':arm} for arm in ('native','active','controller')]
        self.assertEqual(comparisons(rows,TASKS[:1],1)[0]['verdict'],'INCONCLUSIVE')


if __name__=='__main__':unittest.main()
