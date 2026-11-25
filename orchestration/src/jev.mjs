import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { assert, hash, readJSON, writeJSON, withLock, networkFailure } from './util.mjs';
import { validateSafety, secretLike } from './safety.mjs';
import { QUESTION_VERSION } from './questions.mjs';
import { validateAnswers } from './kernel/answers.mjs';
// Re-exported so existing importers of jev.mjs keep working.
export { validateAnswers };
// Opt-in points outside the routing path. They count against their own request cap and circuit,
// so a shadow or advisory point can never exhaust the budget that routing depends on.
const AUXILIARY_POINTS=new Set(['delegation.skills','supervisor.outcome']);
export class JevClient{
  constructor(config,apiKey,{fetchImpl=fetch}={}){this.config=config;this.key=apiKey;this.fetch=fetchImpl;}
  /** Code used when limits.deadlineAt has passed before a request was counted. Only subclasses set a deadline. */
  get deadlineCode(){return 'JEV_TIMEOUT';}
  async request(state,questions,{timeoutMs=this.config.timeoutMs}={}){
    assert(this.config.safety?.allowEgress===true,'EGRESS_NOT_APPROVED');validateSafety(this.config);
    assert(this.key,'MISSING_TYPESAFE_API_KEY');
    assert(!secretLike(JSON.stringify(state),this.key),'SECRET_GUARD');
    const c=this.config;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.min(c.timeoutMs,timeoutMs));
    try{
      const base=c.endpoint.replace(/\/$/,'');
      const payload=JSON.stringify({model:c.model,state,questions});assert(Buffer.byteLength(payload)<=524288,'JEV_REQUEST_TOO_LARGE');
      const response=await this.fetch(base+'/v1/systemone',{method:'POST',redirect:'error',signal:controller.signal,
        headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},body:payload});
      assert(response.ok,`JEV_HTTP_${response.status}`);
      const reader=response.body.getReader();let bytes=0;const chunks=[];
      try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;assert(bytes<=262144,'JEV_RESPONSE_TOO_LARGE');chunks.push(Buffer.from(r.value));}}
      finally{try{await reader.cancel();}catch{}}
      return validateAnswers(JSON.parse(Buffer.concat(chunks).toString('utf8')),questions);
    }catch(e){
      if(controller.signal.aborted){const x=new Error('JEV_TIMEOUT');x.code='JEV_TIMEOUT';throw x;}
      // Typed so Main and the decision log can tell "could not connect" from an untyped failure. Only the code is kept.
      if(networkFailure(e)){const x=new Error('JEV_NETWORK_ERROR');x.code='JEV_NETWORK_ERROR';throw x;}
      throw e;
    }
    finally{clearTimeout(timer);}
  }
  async evaluate(state,questions,scope,limits={}){
    const c=this.config;const start=performance.now();
    const key=hash({scope,account:hash(this.key),endpoint:c.endpoint,model:c.model,questions,state,version:QUESTION_VERSION});
    const file=path.join(c.stateDir,'cache',key+'.json');
    const get=async()=>{const a=await readJSON(file,null);return a?.expires>Date.now()?validateAnswers(a.response,questions):null;};
    const cache=await get();if(cache)return {response:cache,cached:true,latencyMs:performance.now()-start};
    // limits.deadlineAt (performance.now() clock) is optional and absent for Jev: then nothing below changes.
    // With it, the lock waits before the request never run past the deadline, and a call whose deadline
    // has already passed is neither counted against the request cap nor recorded as a circuit failure.
    const left=()=>Number.isFinite(limits.deadlineAt)?limits.deadlineAt-performance.now():Infinity;
    const wait=ms=>Math.max(0,Math.min(ms,left()));
    return withLock(file+'.lock',async()=>{
      const again=await get();if(again)return {response:again,cached:true,latencyMs:performance.now()-start};
      const controlFile=path.join(c.stateDir,'request-control',hash({scope,endpoint:c.endpoint,account:hash(this.key),
        ...(AUXILIARY_POINTS.has(limits.pointId)?{bucket:'auxiliary'}:{})})+'.json');
      await withLock(controlFile+'.lock',async()=>{
        const info=await readJSON(controlFile,{requests:0,failures:0,openUntil:0});
        assert(info.openUntil<=Date.now(),'JEV_CIRCUIT_OPEN');
        assert(info.requests<c.circuit.maxRequestsPerSession,'JEV_REQUEST_CAP');
        assert(left()>=1,this.deadlineCode);
        if(info.openUntil){info.failures=0;info.openUntil=0;}
        info.requests++;await writeJSON(controlFile,info);
      },wait(1500));
      let response;
      try {
        response=await this.request(state,questions,limits);
        await withLock(controlFile+'.lock',async()=>{const info=await readJSON(controlFile);info.failures=0;await writeJSON(controlFile,info);});
      } catch(error) {
        await withLock(controlFile+'.lock',async()=>{const info=await readJSON(controlFile);info.failures++;if(info.failures>=c.circuit.failureThreshold)info.openUntil=Date.now()+c.circuit.cooldownMs;await writeJSON(controlFile,info);});
        throw error;
      }
      await writeJSON(file,{expires:Date.now()+c.cacheTtlMs,response});
      return {response,cached:false,latencyMs:performance.now()-start};
    },wait(Math.min(c.timeoutMs,1500)));
  }
}
