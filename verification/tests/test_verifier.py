from __future__ import annotations
import json,math,os,shutil,subprocess,sys,tempfile,unittest,urllib.request
from pathlib import Path
from verifier.common import *
from verifier.gateway import Gateway,validate_response
from verifier.evidence import terminal_result,metadata_from_transcript,assess_routing,child_metadata
from verifier.statistics import wilson,compare
from verifier.tasks import TASKS,judge,validate_suite
ROOT=Path(__file__).resolve().parent.parent

class UtilityTests(unittest.TestCase):
    def test_redaction(self):self.assertNotIn('secret-value',redact('hello secret-value',['secret-value']))
    def test_redaction_oauth_json(self):self.assertNotIn('do-not-show',redact('{"refresh_token":"do-not-show"}'))
    def test_redaction_bearer(self):self.assertNotIn('abc123456789',redact('Bearer abc123456789'))
    def test_parse_env(self):
        with tempfile.TemporaryDirectory() as t:
            f=Path(t)/'e';f.write_text('A="hello world"\nB=foo\n#comment\n')
            d=load_env(f);self.assertEqual(d['A'],'hello world');self.assertEqual(d['B'],'foo')
    def test_blank_env_preserves_defaults(self):
        with tempfile.TemporaryDirectory() as t:
            f=Path(t)/'e';f.write_text('VERIFY_NODE_BIN=\nJEV_TIMEOUT_MS=\n')
            d=load_env(f);self.assertNotIn('VERIFY_NODE_BIN',d);self.assertNotIn('JEV_TIMEOUT_MS',d)
    def test_env_not_shell(self):
        with tempfile.TemporaryDirectory() as t:
            f=Path(t)/'e';f.write_text('A=$(touch owned)\n');self.assertEqual(load_env(f)['A'],'$(touch owned)');self.assertFalse((Path(t)/'owned').exists())
    def test_no_env_symlink(self):
        with tempfile.TemporaryDirectory() as t:
            f=Path(t)/'a';f.write_text('A=B');s=Path(t)/'s';s.symlink_to(f)
            with self.assertRaises(ValueError):load_env(s)
    def test_clean_env_no_api_key(self):
        with tempfile.TemporaryDirectory() as t:
            os.environ['UNRELATED_API_KEY']='do-not-inherit'
            self.assertNotIn('UNRELATED_API_KEY',clean_env(Path(t)))
    def test_process_timeout(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t);r=run_process([__import__('sys').executable,'-c','import time; time.sleep(5)'],cwd=p,env=clean_env(p),timeout=.1)
            self.assertTrue(r.timed_out);self.assertNotEqual(r.returncode,0)
    def test_manifest_change(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t);(p/'x').write_text('a');a=tree_manifest(p);(p/'x').write_text('b');self.assertNotEqual(a,tree_manifest(p))
    def test_jsonl_invalid(self):self.assertEqual(parse_jsonl('{}\nwrong\n')[1],1)
    def test_html_escaped(self):
        with tempfile.TemporaryDirectory() as t:
            r=Report(Path(t));r.add('test','test','BLOCKED','<script>alert(1)</script>');self.assertEqual(r.finish(),2)
            self.assertNotIn('<script>',(Path(t)/'report.html').read_text())

class SchemaTests(unittest.TestCase):
    q={'x':{'type':'choice','criteria':{'a':'A','b':'B'}}}
    def valid(self):return {'model':'jev','answers':{'x':{'type':'choice','choice':'a','confidence':1.,'probabilities':{'a':1.,'b':0.}}},'usage':{'input_tokens':1,'output_tokens':1}}
    def test_valid(self):validate_response(self.valid(),self.q)
    def test_missing_usage(self):
        v=self.valid();del v['usage']
        with self.assertRaises(AssertionError):validate_response(v,self.q)
    def test_nan_probability(self):
        v=self.valid();v['answers']['x']['probabilities']['a']=math.nan
        with self.assertRaises(AssertionError):validate_response(v,self.q)
    def test_missing_option(self):
        v=self.valid();del v['answers']['x']['probabilities']['b']
        with self.assertRaises(AssertionError):validate_response(v,self.q)
    def test_unknown_choice(self):
        v=self.valid();v['answers']['x']['choice']='z'
        with self.assertRaises(AssertionError):validate_response(v,self.q)
    def test_score(self):
        v={'model':'x','answers':{'s':{'type':'score','score':1,'legend':{'0':'low','1':'high'},'confidence':1,'probabilities':{'0':0,'1':1}}},'usage':{'input_tokens':0,'output_tokens':0}}
        validate_response(v,{'s':{'type':'score','criteria':['low','high']}})
    def test_gateway_no_auth(self):
        with Gateway(synthetic=True) as g:
            req=urllib.request.Request(g.url+'/v1/systemone',data=b'{}',method='POST')
            with self.assertRaises(urllib.error.HTTPError) as e:urllib.request.urlopen(req)
            self.assertEqual(e.exception.code,401)
    def test_gateway_cap(self):
        with Gateway(synthetic=True,max_requests=1) as g:
            payload={'questions':self.q,'state':{},'model':'jev-latest'}
            def call():return urllib.request.urlopen(urllib.request.Request(g.url+'/v1/systemone',data=canonical(payload).encode(),headers={'Authorization':'Bearer '+g.access_token,'Content-Type':'application/json'},method='POST'))
            with call() as r:self.assertEqual(json.loads(r.read())['model'],'SYNTHETIC_NOT_JEV')
            with self.assertRaises(urllib.error.HTTPError) as e:call()
            self.assertEqual(e.exception.code,429)
            self.assertEqual(g.records[0]['source'],'SYNTHETIC')

class EvidenceTests(unittest.TestCase):
    def test_prose_cannot_be_metadata(self):
        m=metadata_from_transcript([{'type':'assistant','message':{'content':'{"effort":"high","model":"opus"}'}}]);self.assertEqual(m['efforts'],[]);self.assertEqual(m['models'],[])
    def test_runtime_context(self):
        m=metadata_from_transcript([{'type':'turn_context','payload':{'model':'gpt-6-sol','effort':'medium'}}]);self.assertEqual(m['models'],['gpt-6-sol']);self.assertEqual(m['efforts'],['medium'])
    def test_claude_child_typed_effort_and_id(self):
        m=metadata_from_transcript([{'type':'assistant','agentId':'agent-7','message':{'model':'gpt-6-sol','content':'I used max effort'},'effort':'high'}])
        self.assertEqual(m['models'],['gpt-6-sol']);self.assertEqual(m['efforts'],['high']);self.assertEqual(m['agent_ids'],['agent-7'])
    def test_claude_mixed_typed_effort_is_not_silently_collapsed(self):
        rows=[{'type':'assistant','message':{'model':'gpt-6-sol'},'effort':e} for e in ('high','xhigh')]
        self.assertEqual(metadata_from_transcript(rows)['efforts'],['high','xhigh'])
    def test_child_transcript_id_must_match_observed_hook_id(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);f=root/'transcripts/child.jsonl';write_private(f,json.dumps({'type':'assistant','agentId':'agent-7','effort':'high','message':{'model':'gpt-6-sol'}})+'\n')
            self.assertEqual(child_metadata(root,[])['agent-7']['efforts'],['high'])
            write_json(f.with_suffix('.meta.json'),{'agent_id':'agent-8'})
            self.assertEqual(child_metadata(root,[]),{})
    def test_claude_error(self):self.assertFalse(terminal_result('claude',[{'type':'result','is_error':True}])['completed'])
    def test_claude_multiple_results_use_segment_tokens_and_last_monotone_cost(self):
        events=[{'type':'result','session_id':'same','is_error':False,'subtype':'success',
                 'total_cost_usd':1.4,'usage':{'input_tokens':54,'cache_creation_input_tokens':0,
                                               'cache_read_input_tokens':210,'output_tokens':7}},
                {'type':'result','session_id':'same','is_error':False,'subtype':'success',
                 'total_cost_usd':1.5,'usage':{'input_tokens':2,'cache_creation_input_tokens':0,
                                               'cache_read_input_tokens':8,'output_tokens':1}}]
        result=terminal_result('claude',events)
        self.assertTrue(result['completed']);self.assertEqual(result['terminal_events'],2)
        self.assertEqual(result['usage']['input_tokens'],56)
        self.assertEqual(result['usage']['cache_read_input_tokens'],218)
        self.assertEqual(result['usage']['output_tokens'],8)
        self.assertEqual(result['cli_reported_cost_usd'],1.5)
        self.assertIn('assuming_disjoint_turns',result['usage_scope'])
        other=terminal_result('claude',events[:1]+[events[1]|{'session_id':'other'}])
        self.assertIsNone(other['usage']);self.assertIsNone(other['cli_reported_cost_usd'])
        decreasing=terminal_result('claude',events[:1]+[events[1]|{'total_cost_usd':1.2}])
        self.assertIsNone(decreasing['cli_reported_cost_usd'])
        failed=terminal_result('claude',[events[0]|{'is_error':True},events[1]])
        self.assertFalse(failed['completed'])
    def test_codex_aggregate(self):
        r=terminal_result('codex',[{'type':'turn.completed','usage':{'input_tokens':3}},{'type':'turn.completed','usage':{'input_tokens':4}}]);self.assertEqual(r['usage']['input_tokens'],7);self.assertIsNone(r['cli_reported_cost_usd'])
    def test_codex_no_terminal(self):self.assertFalse(terminal_result('codex',[{'type':'item.completed'}])['completed'])
    def test_codex_failure(self):self.assertFalse(terminal_result('codex',[{'type':'turn.completed','usage':{}},{'type':'error'}])['completed'])

    def test_ambiguous_profile_never_applied(self):
        class FakeTarget:
            def selected_profile(self,output,runtime):return {'profile':'jev4_implement_light_medium_x','requested_model':'sonnet','requested_effort':'medium','input':{}}
        hooks=[{'event':{'hook_event_name':'SubagentStart','agent_type':'jev4_implement_light_medium_x','agent_id':'a'}},
               {'event':{'hook_event_name':'SubagentStart','agent_type':'jev4_implement_light_medium_x','agent_id':'b'}}]
        for ident in ('call1','call2'):
            hooks.append({'event':{'hook_event_name':'PreToolUse','tool_name':'Agent','tool_use_id':ident},'sut_invoked':True,'sut_returncode':0,'output':{'hookSpecificOutput':{'updatedInput':{'subagent_type':'jev4_implement_light_medium_x'}}}})
        with tempfile.TemporaryDirectory() as t:
            result=assess_routing(hooks,'claude',FakeTarget(),Path(t),{})
        self.assertTrue(all(r['application_status']=='INCONCLUSIVE_UNLINKED_WORKER' and not r['matched_child_ids'] for r in result['routes']))
    def test_typed_child_without_linked_successful_response_cannot_pass(self):
        name='jev4_implement_standard_high_x'
        class FakeTarget:
            def selected_profile(self,output,runtime):
                return {'profile':name,'requested_model':'gpt-6-sol','requested_effort':'high','input':{}}
        route={'event':{'hook_event_name':'PreToolUse','tool_name':'Agent','tool_use_id':'t1'},
               'sut_invoked':True,'sut_returncode':0,
               'output':{'hookSpecificOutput':{'updatedInput':{'subagent_type':name}}}}
        start={'event':{'hook_event_name':'SubagentStart','agent_type':name,'agent_id':'a'}}
        stop={'event':{'hook_event_name':'SubagentStop','agent_type':name,'agent_id':'a'}}
        response={'event':{'hook_event_name':'PostToolUse','tool_name':'Agent','tool_use_id':'t1',
                           'tool_response':{'agentId':'a'}}}
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);write_private(root/'transcripts/a.jsonl',json.dumps({
                'type':'assistant','agentId':'a','effort':'high','message':{'model':'gpt-6-sol'}})+'\n')
            for events in ([route,start,stop],[route,start,stop,
                            {'event':response['event']|{'tool_response':{'agentId':'a','is_error':True}}}],
                           [route,stop,response],[route,start,response]):
                result=assess_routing(events,'claude',FakeTarget(),root,{})['routes'][0]
                self.assertNotEqual(result['application_status'],'PASS')
                self.assertEqual(result['model_status'],'INCONCLUSIVE')
                self.assertEqual(result['effort_status'],'INCONCLUSIVE')
            linked=assess_routing([route,start,stop,response],'claude',FakeTarget(),root,{})['routes'][0]
            self.assertEqual((linked['application_status'],linked['model_status'],linked['effort_status']),
                             ('PASS','PASS','PASS'))
            # A second same-profile child is identified by the native response ID, not the shared profile name.
            another={'event':{'hook_event_name':'SubagentStart','agent_type':name,'agent_id':'b'}}
            self.assertEqual(assess_routing([route,start,another,stop,response],
                                            'claude',FakeTarget(),root,{})['routes'][0]['matched_child_ids'],['a'])
            launched=response|{'event':response['event']|{'tool_response':{'agentId':'a','status':'async_launched','isAsync':True}}}
            resumed=[route,launched,start,stop,start,stop]
            repeated=assess_routing(resumed,'claude',FakeTarget(),root,{})
            self.assertEqual(repeated['native_delegations_seen'],1)
            self.assertEqual(repeated['native_start_events'],2)
            self.assertEqual(repeated['routes'][0]['application_status'],'PASS')
            self.assertEqual(repeated['routes'][0]['observed_efforts'],['high'])
            # An async acknowledgement and a previous stop do not complete a subsequent resume.
            self.assertNotEqual(assess_routing(resumed[:-1],'claude',FakeTarget(),root,{})
                                ['routes'][0]['application_status'],'PASS')
            refused=response|{'event':response['event']|{'tool_response':{'agentId':'a','status':'error'}}}
            self.assertNotEqual(assess_routing([route,start,stop,refused],
                                            'claude',FakeTarget(),root,{})['routes'][0]['application_status'],'PASS')

    def test_failed_callback_never_applied(self):
        hooks=[{'event':{'hook_event_name':'PreToolUse'},'sut_invoked':True,'sut_returncode':1,'output':{'hookSpecificOutput':{'updatedInput':{'subagent_type':'jev4_bad'}}}}]
        with tempfile.TemporaryDirectory() as t:self.assertEqual(assess_routing(hooks,'claude',None,Path(t),{})['routes'],[])

class ObserverTests(unittest.TestCase):
    def test_callback_forwards_exact_stdout_stderr_and_exit(self):
        callback=ROOT/'verifier/callback.py'
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);sut=root/'sut.py';sut.write_text('import sys\nsys.stdout.buffer.write(b\' {"ok": true}\\n\')\nsys.stderr.buffer.write(b\'sut warning\\n\')\nsys.exit(7)\n')
            spec=root/'spec.json';write_json(spec,{'nonce':'test','home':str(root),'project':str(root),
                'evidence_dir':str(root/'evidence'),'sut_rules':{'PreToolUse':{'argv':[sys.executable,str(sut)],'timeout':3}}})
            event=json.dumps({'hook_event_name':'PreToolUse','cwd':str(root),'tool_name':'Agent'}).encode()
            p=subprocess.run([sys.executable,str(callback),'--spec',str(spec),'--event','PreToolUse'],input=event,capture_output=True)
            self.assertEqual(p.returncode,7);self.assertEqual(p.stdout,b' {"ok": true}\n');self.assertEqual(p.stderr,b'sut warning\n')
            record=read_json(next((root/'evidence/hooks').glob('*.json')))
            self.assertTrue(record['sut_invoked']);self.assertEqual(record['sut_returncode'],7)
            self.assertEqual(record['output'],{'ok':True})
    def test_callback_does_not_invent_success_for_malformed_sut_output(self):
        callback=ROOT/'verifier/callback.py'
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);sut=root/'sut.py';sut.write_text('import sys\nsys.stdout.buffer.write(b\'not-json\\n\')\n')
            spec=root/'spec.json';write_json(spec,{'nonce':'test','home':str(root),'project':str(root),
                'evidence_dir':str(root/'evidence'),'sut_rules':{'PreToolUse':{'argv':[sys.executable,str(sut)],'timeout':3}}})
            event=json.dumps({'hook_event_name':'PreToolUse','cwd':str(root)}).encode()
            p=subprocess.run([sys.executable,str(callback),'--spec',str(spec),'--event','PreToolUse'],input=event,capture_output=True)
            self.assertEqual(p.returncode,0);self.assertEqual(p.stdout,b'not-json\n')
            record=read_json(next((root/'evidence/hooks').glob('*.json')))
            self.assertFalse(record['sut_stdout_valid']);self.assertEqual(record['output'],{})

class StatisticalTests(unittest.TestCase):
    def rows(self,n=10,synthetic=False):
        return [dict(task_id=str(i),repeat=0,runtime='claude',arm=a,evidence_source='SYNTHETIC_TEST_DRIVER' if synthetic else 'REAL_NATIVE_PROCESS',passed=True,duration_ms=100 if a=='native' else 50,contaminated=False,active_route_observed=True,model_effort_observed=True) for i in range(n) for a in ('native','active')]
    def test_wilson_bounds(self):
        low,high=wilson(8,8);self.assertLess(low,.8);self.assertAlmostEqual(high,1)
    def test_synthetic_never_superior(self):self.assertEqual(compare(self.rows(synthetic=True),'claude','native')['reason'],'NON_LIVE_EVIDENCE')
    def test_small_all_success_not_proof(self):self.assertEqual(compare(self.rows(),'claude','native')['reason'],'QUALITY_NONINFERIORITY_NOT_ESTABLISHED')
    def test_new_failure(self):
        rows=self.rows();rows[-1]['passed']=False;self.assertEqual(compare(rows,'claude','native')['verdict'],'REGRESSION_OBSERVED')
    def test_no_effort_no_certification(self):
        rows=self.rows();rows[-1]['model_effort_observed']=False;self.assertEqual(compare(rows,'claude','native')['reason'],'MODEL_EFFORT_APPLICATION_NOT_OBSERVED')
    def test_no_data(self):self.assertEqual(compare([],'claude','native')['reason'],'NO_PAIRED_LIVE_RUNS')
    def test_cluster_repeats_not_independent(self):
        rows=[]
        for rep in range(30):
            for row in self.rows(1):rows.append(row|{'repeat':rep})
        self.assertEqual(compare(rows,'claude','native')['unique_tasks'],1)
    def test_duplicate_pairs_rejected(self):
        self.assertEqual(compare(self.rows()+self.rows(),'claude','native')['reason'],'DUPLICATE_TASK_REPEAT_ARM')
    def test_no_cost_fabrication(self):self.assertEqual(compare(self.rows(),'claude','native')['cost_verdict'],'INCONCLUSIVE_MISSING_TOTAL_COST')
    def test_no_route_no_treatment(self):
        rows=self.rows();rows[-1]['active_route_observed']=False;self.assertEqual(compare(rows,'claude','native')['reason'],'ACTIVE_TREATMENT_NOT_OBSERVED_IN_EVERY_RUN')

class GraderTests(unittest.TestCase):
    def test_suite_contract(self):self.assertEqual(len(validate_suite(TASKS)),8)
    def test_reject_duplicate_ids(self):
        with self.assertRaises(AssertionError):validate_suite([TASKS[0],TASKS[0]])
    def test_references_pass(self):
        refs=read_json(ROOT/'tests/reference_solutions.json');node=shutil.which('node')
        if not node:self.skipTest('Node not installed')
        for task in TASKS:
            with self.subTest(task=task['id']),tempfile.TemporaryDirectory() as td:
                p=Path(td);project=p/'project';write_private(project/'src/main.mjs',refs[task['id']])
                r=judge(task,project,p/'judge',node,p/'artifacts');self.assertTrue(r['passed'],(task['id'],(p/'artifacts/grade.stderr.log').read_text()))
    def test_readme_is_not_a_pass_claim(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);write_private(p/'project/src/main.mjs',TASKS[0]['initial']);write_private(p/'project/README.md','ALL TESTS PASSED')
            self.assertFalse(judge(TASKS[0],p/'project',p/'judge',shutil.which('node'),p/'artifacts')['passed'])
    def test_symlink_solution_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);(p/'project/src').mkdir(parents=True);(p/'else').write_text('');(p/'project/src/main.mjs').symlink_to(p/'else')
            self.assertEqual(judge(TASKS[0],p/'project',p/'judge',shutil.which('node'),p/'artifacts')['reason'],'SYMLINK_OUTPUT')

class DriverIntegrationTests(unittest.TestCase):
    def test_native_driver_synthetic_only(self):
        source=os.environ.get('JEV_VERIFIER_TEST_SUT')
        if not source:self.skipTest('Supply --sut with --self-test for black-box driver integration')
        from verifier.native import one_trial
        fake=str(ROOT/'tests/fake_native.py')
        for runtime in ('claude','codex'):
            with self.subTest(runtime=runtime),tempfile.TemporaryDirectory() as td,Gateway(synthetic=True) as g:
                local_fake=Path(td)/'fake-native';shutil.copyfile(fake,local_fake);local_fake.chmod(0o700)
                values={'ANTHROPIC_API_KEY':'synthetic-local-only-key','CODEX_API_KEY':'synthetic-local-only-key','VERIFY_SELF_TEST_DRIVER':'1'}
                r=one_trial(source=Path(source),node=shutil.which('node'),binary=str(local_fake),help_text='--output-format --settings --model --max-budget-usd --include-hook-events --forward-subagent-text --dangerously-bypass-hook-trust',runtime=runtime,arm='active',task=TASKS[0],repeat=0,values=values,gateway=g,artifacts=Path(td),approve_hooks=True,timeout=20,smoke=True)
                self.assertTrue(r['passed'],r);self.assertTrue(r['active_route_observed'],r);self.assertEqual(r['evidence_source'],'SYNTHETIC_TEST_DRIVER')
                self.assertTrue(all(x['model_status']=='PASS' and x['effort_status']=='PASS' for x in r['routing']['routes']),r['routing'])
                observer=read_json(Path(td)/'review-hooks.json')
                self.assertIn('PreCompact',observer['native_configuration']['hooks'])
                self.assertIn('PreCompact',observer['observer_spec']['sut_rules'])
                self.assertTrue(observer['native_configuration']['hooks']['PreToolUse'][0]['matcher'])
                self.assertEqual(observer['observer_spec']['sut_rules']['PreToolUse']['timeout'],8)

class HardenedGraderTests(unittest.TestCase):
    def grade_source(self, text):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);project=p/'project';write_private(project/'src/main.mjs',text)
            return judge(TASKS[0],project,p/'judge',shutil.which('node'),p/'artifacts')
    def test_constant_success_marker_and_early_exit_cannot_pass(self):
        result=self.grade_source("console.log('INDEPENDENT_CHECKS_PASSED');process.exit(0);\n"+TASKS[0]['initial'])
        self.assertFalse(result['passed']);self.assertFalse(result['completion_proof_observed'])
    def test_stdin_descriptor_cannot_be_rewound_to_steal_nonce(self):
        source="import fs from 'node:fs';const b=Buffer.alloc(64000);const n=fs.readSync(0,b,0,b.length,0);const m=b.toString('utf8',0,n).match(/INDEPENDENT_CHECKS_PASSED:[a-f0-9]{64}/);if(m)console.log(m[0]);process.exit(0);\n"+TASKS[0]['initial']
        self.assertFalse(self.grade_source(source)['passed'])
    def test_silent_early_success_exit_cannot_pass(self):
        self.assertFalse(self.grade_source('process.exit(0);\n'+TASKS[0]['initial'])['passed'])
    def test_grader_source_cannot_be_read_through_fs(self):
        source="import fs from 'node:fs';console.log(fs.readFileSync('../checks.mjs','utf8'));\n"+TASKS[0]['initial']
        self.assertFalse(self.grade_source(source)['passed'])
    def test_shared_assert_module_cannot_be_overwritten_before_checks(self):
        source="import assert from 'node:assert/strict';assert.deepEqual=()=>{};assert.throws=()=>{};\n"+TASKS[0]['initial']
        self.assertFalse(self.grade_source(source)['passed'])
    def test_source_root_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td);write_private(p/'elsewhere/main.mjs',TASKS[0]['initial']);(p/'project').mkdir();(p/'project/src').symlink_to(p/'elsewhere',target_is_directory=True)
            self.assertEqual(judge(TASKS[0],p/'project',p/'judge',shutil.which('node'),p/'artifacts')['reason'],'SYMLINK_OUTPUT')

class MatchedCohortTests(unittest.TestCase):
    rows=StatisticalTests.rows
    # Reuse rows fixture, not the inherited test cases (removed below to avoid duplicated counts).
    def test_incomplete_pairs_are_not_silently_dropped(self):
        self.assertEqual(compare(self.rows()[:-1],'claude','native')['reason'],'INCOMPLETE_PAIRED_COHORT')
    def test_invalid_duration_cannot_support_speed_claim(self):
        for x in (0,-1,math.nan,math.inf,True,'20'):
            rows=self.rows();rows[0]['duration_ms']=x
            self.assertEqual(compare(rows,'claude','native')['reason'],'INVALID_DURATION')
    def test_invalid_cost_cannot_support_cost_claim(self):
        for x in (-1,math.nan,math.inf,True,'20'):
            rows=self.rows();rows[0]['total_cost_usd']=x
            self.assertEqual(compare(rows,'claude','native')['reason'],'INVALID_COST')
    def test_non_boolean_pass_flag_is_not_truthy_success(self):
        rows=self.rows();rows[0]['passed']='yes'
        self.assertEqual(compare(rows,'claude','native')['reason'],'INVALID_PASS_OBSERVATION')
