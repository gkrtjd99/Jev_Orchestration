// This measures only the real local hook path. The Jev endpoint below is a declared test double.
import fs from 'node:fs/promises';import path from 'node:path';import {performance} from 'node:perf_hooks';
import {fixture,event,server,answer,child} from '../test/helpers.mjs';
import {writeJSON,sleep} from '../src/util.mjs';
const f=await fixture();const s=await server(null,async(req,res,body)=>{await sleep(5);res.end(JSON.stringify(answer(body.questions,body.state.task?.includes('MECHANICAL_FIXTURE')?{role:'research',complexity:'small',reasoning:'mechanical'}:{})));});
const results=[];const N=40;const entry=path.resolve('bin/jev-hook.mjs');
const cfg={...f.config,endpoint:s.endpoint,allowLoopback:true,timeoutMs:1000,cacheTtlMs:120000,circuit:{...f.config.circuit,maxRequestsPerSession:500}};
const active=path.join(f.home,'active.json'),off=path.join(f.home,'off.json');await writeJSON(active,cfg);await writeJSON(off,{...cfg,mode:'off'});
const invoke=async(e,file=active)=>{
 const start=performance.now();const r=await child(process.execPath,[entry,'--runtime','claude','--config',file],{input:JSON.stringify(e),env:{...process.env,TYPESAFE_API_KEY:'benchmark-fixture-key'}});
 if(r.code!==0)throw new Error('Hook failed: '+r.stderr);
 return {elapsedMs:performance.now()-start,output:JSON.parse(r.stdout)};
};
try{
 const seed=event(f.project,'claude',{tool_use_id:'cached-seed'});await invoke(seed);
 const cases=['off','unsupported-tool-pass-through','cold-route-http-fixture','cached-route','replayed-tool-id','session-restore','mechanical-one-stage'];
 // Alternate order each round to reduce systematic warm-up/order bias.
 for(let i=0;i<N;i++)for(const name of i%2?[...cases].reverse():cases){
  let e=event(f.project,'claude',{tool_use_id:name+'-'+i}),file=active;
  if(name==='off')file=off;
  if(name==='unsupported-tool-pass-through')e.tool_name='Grep';
  if(name==='cold-route-http-fixture')e.tool_input.prompt+=' Unique task '+i;
  if(name==='mechanical-one-stage')e.tool_input.prompt='MECHANICAL_FIXTURE: find one declared symbol '+i;
  if(name==='replayed-tool-id')e=seed;
  if(name==='session-restore'){e.hook_event_name='SessionStart';e.source='compact';}
  const requestsBefore=s.requests.length;const r=await invoke(e,file);
  const modified=!!r.output.hookSpecificOutput?.updatedInput;
  if(['cold-route-http-fixture','cached-route','replayed-tool-id','mechanical-one-stage'].includes(name)&&!modified)throw new Error('Expected route not applied: '+name);
  if(['off','unsupported-tool-pass-through'].includes(name)&&Object.keys(r.output).length)throw new Error('Baseline unexpectedly changed');
  results.push({case:name,iteration:i,elapsedMs:r.elapsedMs,httpRequests:s.requests.length-requestsBefore,modified});
 }
 const quantile=(xs,p)=>{const x=[...xs].sort((a,b)=>a-b);return x[Math.min(x.length-1,Math.floor((x.length-1)*p))];};
 const summary=Object.fromEntries(cases.map(c=>{const xs=results.filter(r=>r.case===c);return [c,{n:xs.length,p50Ms:quantile(xs.map(x=>x.elapsedMs),.5),p95Ms:quantile(xs.map(x=>x.elapsedMs),.95),httpRequests:xs.reduce((s,x)=>s+x.httpRequests,0)}];}));
 const report={schema:1,kind:'local-hook-process-benchmark',node:process.version,platform:process.platform,
  nativeAgentsExecuted:false,realJevExecuted:false,jevFixtureDelayMs:5,measures:'real Node process startup + stdin JSON + hooks + filesystem + loopback HTTP when applicable',
  notMeasured:['Claude/Codex native runtime integration','actual Jev latency or accuracy','code generation quality','billable model cost','native ultracode/Codex comparative superiority'],
  sampleCount:results.length,summary,results,publicationVerdict:'HOLD_NATIVE_COMPARISON_NOT_RUN'};
 await fs.mkdir('benchmarks/results',{recursive:true});await writeJSON('benchmarks/results/hooks-local.json',report);
 console.log(JSON.stringify({...report,results:undefined},null,2));
}finally{await s.close();await fs.rm(f.root,{recursive:true,force:true});}
