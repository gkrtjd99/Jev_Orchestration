// A deterministic policy/optimizer simulation, NOT a native-agent benchmark.
import assert from 'node:assert/strict';
import {defaults} from '../src/config.mjs';
import {eligibleProfiles,summarizeEvidence,optimizeCandidates,taskClass} from '../src/optimizer.mjs';
import {hash,writeJSON} from '../src/util.mjs';
const config=defaults('/tmp/jev-offline-policy-eval');
for(const m of config.registry.models){m.availability='confirmed';m.capabilitySource='SYNTHETIC_FIXTURE_NOT_ACCOUNT_ACCESS';}
config.optimization.evaluationContext='SIMULATED-provider-tools-validator-v1';
const rows=[],cases=[];
const scenarios=[
 {id:'lookup-ko',text:'설정 키가 정의된 위치만 찾아 주세요.',role:'research',complexity:'small',reasoning:'mechanical',risk:'normal'},
 {id:'lookup-en',text:'Locate the definition of the settings key.',role:'research',complexity:'small',reasoning:'mechanical',risk:'normal'},
 {id:'reader-ko',text:'API 문서에서 제한 조건과 근거를 추출하세요.',role:'research',complexity:'bounded',reasoning:'routine',risk:'normal'},
 {id:'docs-en',text:'Write a usage guide from the approved specification.',role:'documentation',complexity:'small',reasoning:'routine',risk:'normal'},
 {id:'bounded-code-ko',text:'기존 계약에 따라 알림 토글을 구현하세요.',role:'implement',complexity:'bounded',reasoning:'routine',risk:'normal'},
 {id:'bounded-code-en',text:'Implement the notification toggle against the existing contract.',role:'implement',complexity:'bounded',reasoning:'routine',risk:'normal'},
 {id:'logic-ko',text:'서로 다른 모듈에서 발생하는 동시성 오류를 추적하세요.',role:'implement',complexity:'broad',reasoning:'deep',risk:'normal'},
 {id:'security-en',text:'Independently review the authorization boundary.',role:'review',complexity:'bounded',reasoning:'deep',risk:'sensitive'},
 {id:'schema-ko',text:'데이터 마이그레이션의 무결성을 검토하세요.',role:'review',complexity:'broad',reasoning:'deep',risk:'sensitive'},
 {id:'planner-en',text:'Resolve architecture tradeoffs before any implementation.',role:'plan',complexity:'broad',reasoning:'novel',risk:'normal'},
 {id:'sensitive-one-line',text:'Change one line in the billing authorization check.',role:'implement',complexity:'small',reasoning:'routine',risk:'sensitive'},
 {id:'uncertain',text:'Change the behavior; the affected modules are unclear.',role:'implement',complexity:'bounded',reasoning:'routine',risk:'normal',uncertain:true}
];
for(const runtime of ['claude','codex'])for(const scenario of scenarios){
 const features={...scenario,information:'sufficient',reading:'targeted',uncertain:scenario.uncertain||false};
 const {candidates}=eligibleProfiles(config.registry,runtime,features,config);
 const cold=optimizeCandidates(candidates,{},config.optimization);
 assert.ok(cold.baseline);assert.equal(cold.basis,'policy_prior_not_measured');
 // Construct known fixtures to check feedback handling. No price or time below describes an actual model.
 const toyBest=candidates.find(p=>p.slot==='light'&&p.effort==='high')||candidates[0];
 const train=[];
 for(const p of candidates)for(let i=0;i<60;i++){
  const best=p.profileId===toyBest.profileId;
  train.push({taskId:`TRAIN-${scenario.id}-${i}`,taskClass:taskClass(features),context:config.optimization.evaluationContext,
   projectHash:hash('SIMULATION'),profileId:p.profileId,profileFingerprint:p.fingerprint,createdAt:Date.now()-1000,
   verification:{source:'independent-validator',passed:best||i<54},effective:{confirmed:true,model:p.backend,effort:p.effort},
   durationMs:best?100:300,costUsd:best ? 0.01 : 0.04});
 }
 const stats=summarizeEvidence(train,candidates,{context:config.optimization.evaluationContext,projectHash:hash('SIMULATION'),classKey:taskClass(features)});
 const calibrated=optimizeCandidates(candidates,stats,config.optimization);
 assert.equal(calibrated.baseline.profileId,toyBest.profileId);
 // Distinct held-out task IDs. These are fixture outcomes, not generated implementations.
 for(let i=0;i<10;i++)rows.push({taskId:`TEST-${scenario.id}-${i}`,runtime,fixture:true,selected:calibrated.baseline.profileId,
   compatibilityPassed:calibrated.pool.every(p=>candidates.some(c=>c.profileId===p.profileId)),qualityGatePassed:calibrated.pool.every(p=>stats[p.profileId].successLower>=config.optimization.qualityFloor)});
 cases.push({runtime,scenario:scenario.id,language:scenario.id.includes('-ko')?'ko':'en',
  baseline: cold.baseline.profileId,calibrated:calibrated.baseline.profileId,knownFixtureOptimum:toyBest.profileId,
  matchesFixtureOptimum:calibrated.baseline.profileId===toyBest.profileId});
}
const report={schema:1,kind:'explicitly-synthetic-optimizer-regression',scenarioCount:cases.length,heldOutFixtureRows:rows.length,
 actualJevCalled:false,nativeAgentsExecuted:false,modelAccuracyMeasured:false,modelPricesMeasured:false,
 disclaimer:'Synthetic profiles, labels, success outcomes, costs, and delays test code branches only. This does not establish real development performance or routing accuracy.',
 constraintFailures:rows.filter(x=>!x.compatibilityPassed||!x.qualityGatePassed).length,
 fixtureOptimumMatches:cases.filter(x=>x.matchesFixtureOptimum).length,cases,rows,publicationVerdict:'HOLD_NO_NATIVE_COMPARISON'};
await writeJSON('benchmarks/results/router-simulation.json',report);
console.log(JSON.stringify({...report,cases:undefined,rows:undefined},null,2));
