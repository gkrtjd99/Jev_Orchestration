from __future__ import annotations
import json, tempfile, unittest
from pathlib import Path
from repo_compare import TASKS, confirmed_models, comparisons, prompt_for
from verifier.common import Blocked


class RepositoryComparisonTests(unittest.TestCase):
    def test_declared_registry_is_not_confirmed_access(self):
        with tempfile.TemporaryDirectory() as td:
            file=Path(td)/'registry.json'
            models=[{'runtime':'claude','slot':slot,'model':'model-'+slot,'enabled':True,
                     'availability':'declared','supportedEfforts':efforts,'roles':roles}
                    for slot,efforts,roles in [('light',['high'],['research']),
                                               ('standard',['high','xhigh'],['implement','review']),
                                               ('strategic',['xhigh'],['plan','implement'])]]
            file.write_text(json.dumps({'models':models}))
            with self.assertRaises(Blocked):confirmed_models(file)
            for model in models:model['availability']='confirmed'
            file.write_text(json.dumps({'models':models}))
            self.assertEqual(confirmed_models(file)['standard'],'model-standard')
            models[2]['supportedEfforts']=['high'];file.write_text(json.dumps({'models':models}))
            with self.assertRaises(Blocked):confirmed_models(file)

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
             'terminal':{'completed':True,'cli_reported_cost_usd':1},'observed_hooks':False,
             'observed_delegations':0,'route_linked':False,'jev_upstream_valid':False,
             'routes':[],'quality_passed':True,'duration_ms':100}
        rows=[row|{'arm':arm} for arm in ('native','active','controller')]
        self.assertEqual(comparisons(rows,TASKS[:1],1)[0]['verdict'],'INCONCLUSIVE')
        observed=row|{'observed_hooks':True,'observed_delegations':1,'route_linked':True,
                      'jev_upstream_valid':True,'controller_implementation_route_observed':False,
                      'routes':[{'model_status':'PASS','effort_status':'PASS'}]}
        rows=[observed|{'arm':arm} for arm in ('native','active','controller')]
        self.assertEqual(comparisons(rows,TASKS[:1],1)[0]['verdict'],'INCONCLUSIVE')


if __name__=='__main__':unittest.main()
