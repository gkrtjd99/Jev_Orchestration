import { randomBytes } from 'node:crypto';
import { hash } from './util.mjs';
import { secretLike } from './safety.mjs';

const names=new Set(['session_started','route_selected','route_deferred','delegation_observed','worker_started','worker_stopped','main_direct_work_denied','workflow_denied']);
const keys=new Set(['phase','role','slot','model','effort','reason','result','plan_version','task_hash','delegation_hash','agent_hash']);
const safeValue=/^[A-Za-z0-9_.:/-]{1,100}$/;
const reasons=new Set(['evidence_collection','contract_interpretation','strategic_planning','approved_contract_implementation',
  'bounded_causal_analysis','independent_test_design','run_actual_checks','independent_patch_review','cross_patch_integration',
  'strategic_boundary_or_loss','sensitive_evidence_collection','sensitive_quality_floor','gather_missing_evidence',
  'destructive_work_requires_human_approval','confirmed_profile_unavailable',
  'uncertain_evidence_collection','uncertain_quality_floor']);
const results=new Set(['spawn_failed','spawn_observed']);
const varint=n=>{let v=BigInt(n);const b=[];do{let x=Number(v&127n);v>>=7n;if(v)x|=128;b.push(x);}while(v);return Buffer.from(b);};
const field=(id,wire,value)=>Buffer.concat([varint((id<<3)|wire),wire===2?varint(value.length):Buffer.alloc(0),value]);
const str=(id,s)=>field(id,2,Buffer.from(s));
const msg=(id,parts)=>field(id,2,Buffer.concat(parts));
const bytes=(id,b)=>field(id,2,b);
function fixed64(id,value){const b=Buffer.alloc(8);b.writeBigUInt64LE(value);return field(id,1,b);}
function attribute(key,value,id=1){
  const val=typeof value==='number'?field(3,0,varint(value)):
    typeof value==='boolean'?field(2,0,varint(value?1:0)):str(1,String(value));
  return msg(id,[str(1,key),msg(2,[val])]);
}
function protobufFields(data,visit){
  let i=0;
  const read=()=>{
    let value=0,shift=0;
    while(i<data.length){
      const b=data[i++];value+=(b&127)*2**shift;
      if(!Number.isSafeInteger(value))throw Error('INVALID_VARINT');
      if(!(b&128))return value;
      shift+=7;if(shift>49)throw Error('INVALID_VARINT');
    }
    throw Error('TRUNCATED');
  };
  while(i<data.length){
    const tag=read(),wire=tag%8,id=Math.floor(tag/8);
    if(!id)throw Error('INVALID_FIELD');
    if(wire===0){visit(id,wire,read());continue;}
    if(wire===1||wire===5){i+=wire===1?8:4;if(i>data.length)throw Error('TRUNCATED');continue;}
    if(wire!==2)throw Error('INVALID_WIRE');
    const len=read(),end=i+len;if(end>data.length)throw Error('TRUNCATED');
    visit(id,wire,data.subarray(i,end));i=end;
  }
}
function accepted(body){
  // OTLP response field 1 is partial_success; its field 1 is rejected_spans.
  if(!body.length)return true;
  try{
    let rejected=false;
    protobufFields(body,(id,wire,value)=>{
      if(id!==1)return;
      if(wire!==2)throw Error('INVALID_PARTIAL_SUCCESS');
      protobufFields(value,(partialId,partialWire,count)=>{
        if(partialId!==1)return;
        if(partialWire!==0)throw Error('INVALID_REJECTED_SPANS');
        if(count>0)rejected=true;
      });
    });
    return !rejected;
  }catch{return false;}
}

export async function emitTelemetry(runtimeEnv,project,session,name,fields={},fetchImpl=fetch){
  if(runtimeEnv.JEV_OTEL_ENABLED!=='true')return {sent:false,reason:'disabled'};
  if(!names.has(name))return {sent:false,reason:'unrecognized_event'};
  let url;
  try{url=new URL(runtimeEnv.JEV_OTEL_ENDPOINT||'http://127.0.0.1:4318');}catch{return {sent:false,reason:'invalid_endpoint'};}
  if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='4318'||
      url.username||url.password||url.search||url.hash||(url.pathname!=='/'&&url.pathname!==''))
    return {sent:false,reason:'endpoint_not_loopback_gateway'};
  const otelProject=(runtimeEnv.OTEL_RESOURCE_ATTRIBUTES||'').split(',').find(x=>x.startsWith('agentotel.project.id='))?.slice('agentotel.project.id='.length)||'';
  const projectId=runtimeEnv.JEV_OTEL_PROJECT_ID||otelProject;
  if(runtimeEnv.JEV_OTEL_PROJECT_ID&&otelProject&&runtimeEnv.JEV_OTEL_PROJECT_ID!==otelProject)
    return {sent:false,reason:'project_id_conflict'};
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId))
    return {sent:false,reason:'project_id_missing'};
  const otelToken=(runtimeEnv.OTEL_EXPORTER_OTLP_HEADERS||'').match(/^Authorization=Bearer%20([A-Za-z0-9._~-]+)$/)?.[1]||'';
  const token=runtimeEnv.JEV_OTEL_INGEST_TOKEN||otelToken;
  if(runtimeEnv.JEV_OTEL_INGEST_TOKEN&&otelToken&&runtimeEnv.JEV_OTEL_INGEST_TOKEN!==otelToken)
    return {sent:false,reason:'ingest_token_conflict'};
  if(!token||token.length>512||/[\r\n]/.test(token))return {sent:false,reason:'ingest_token_missing'};
  const attributes=[];
  for(const [key,value] of Object.entries(fields||{})){
    if(!keys.has(key))continue;
    if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)attributes.push(attribute('jev.'+key,value,9));
    else if(typeof value==='boolean')attributes.push(attribute('jev.'+key,value,9));
    else if(typeof value==='string'&&safeValue.test(value)&&!secretLike(value,token)&&
      (key!=='reason'||reasons.has(value))&&(key!=='result'||results.has(value)))
      attributes.push(attribute('jev.'+key,value,9));
  }
  // Resource attributes cannot read global state or include source text.
  const body=(()=>{
    const scope=hash([project,session]),now=BigInt(Date.now())*1000000n,root=Buffer.from(scope.slice(32,48),'hex');
    const span=[bytes(1,Buffer.from(scope.slice(0,32),'hex')),bytes(2,name==='session_started'?root:randomBytes(8))];
    if(name!=='session_started')span.push(bytes(4,root));
    span.push(str(5,'jev.'+name),fixed64(7,now),fixed64(8,now+1000000n),...attributes);
    if(name==='delegation_observed'&&fields?.result==='spawn_failed')
      span.push(attribute('error',true,9),msg(15,[field(2,0,varint(2))]));
    return msg(1,[msg(1,[attribute('service.name','jev-controller'),attribute('agentotel.project.id',projectId)]),
      msg(2,[msg(1,[str(1,'jev-controller')]),msg(2,span)])]);
  })();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),400);
  try{
    const response=await fetchImpl(new URL('/v1/traces',url),{method:'POST',redirect:'error',signal:controller.signal,
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/x-protobuf'},body});
    if(!response.ok){try{await response.body?.cancel();}catch{}return {sent:false,reason:'http_error'};}
    if(!response.body)return {sent:true,reason:'gateway_acknowledged'};
    const reader=response.body.getReader();let size=0;const chunks=[];
    try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>4096)return {sent:false,reason:'response_too_large'};chunks.push(Buffer.from(part.value));}}
    finally{try{await reader.cancel();}catch{}}
    return accepted(Buffer.concat(chunks))?{sent:true,reason:'gateway_acknowledged'}:{sent:false,reason:'spans_rejected_or_invalid_response'};
  }catch{return {sent:false,reason:'transport_error'};}
  finally{clearTimeout(timer);}
}
