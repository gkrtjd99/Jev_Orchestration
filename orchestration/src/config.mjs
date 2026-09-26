import fs from 'node:fs/promises';
import {safetyDefaults,applySafetyEnvironment,validateSafety,readPrivateEnv} from './safety.mjs';
import path from 'node:path';
import { assert, object, within, readJSON } from './util.mjs';
import { defaultRegistry, validateRegistry, applyModelEnvironment } from './catalog.mjs';
export function defaults(home) {
  return {
    schema: 4, mode: 'shadow', safety:safetyDefaults(), enabledRuntimes: ['claude','codex'],
    allowedProjects: [], stateDir: path.join(home,'.local','state','jev-hooks'),
    endpoint: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs:1200, cacheTtlMs:120000,
    failureMode:'native', minimumConfidence:0.55, readAdvice:false, classifyFailures:true,
    requiredDocuments:[], maxDocuments:20, maxTaskChars:6000, maxContextChars:3500,
    nativeProfiles:true, customAgents:'preserve',
    registry:defaultRegistry(), installedProfiles:{claude:{},codex:{}},
    optimization:{objective:'balanced',jevSelectProfile:true,maxCandidates:8,selectionConfidence:.65,selectionMargin:.15,
      routeDeadlineMs:3000,maxRetryEscalations:2,minimumSamples:30,qualityFloor:.85,nonInferiorityTolerance:.02,objectiveSlack:.08,
      evidenceTtlDays:30,requiredContextTokens:null,evaluationContext:'native-default-unvalidated',requireConfirmedAvailability:true},
    circuit:{failureThreshold:3,cooldownMs:60000,maxRequestsPerSession:100},
  };
}
export function parseEnv(text) {
  const out={};
  for (const raw of text.split(/\r?\n/)) {
    const line=raw.trim(); if (!line || line.startsWith('#')) continue;
    const m=line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); assert(m,'INVALID_ENV_LINE');
    let v=m[2].trim();
    if (v.startsWith('"') || v.startsWith("'")) { assert(v.endsWith(v[0]) && v.length>=2,'INVALID_ENV_QUOTE'); v=v.slice(1,-1); }
    assert(!/[\x00\r\n]/.test(v),'INVALID_ENV_VALUE');
    assert(!Object.hasOwn(out,m[1]),'DUPLICATE_ENV_KEY');
    assert(!v.includes('$(')&&!v.includes('${')&&!v.includes('`'),'SHELL_EXPANSION_NOT_SUPPORTED');out[m[1]]=v;
  }
  return out;
}
export function validateConfig(c) {
  assert(c.schema===4,'CONFIG_SCHEMA_UNSUPPORTED');
  assert(['active','advisory','shadow','off','controller'].includes(c.mode),'INVALID_MODE');
  assert(['native','block'].includes(c.failureMode),'INVALID_FAILURE_MODE');
  assert(c.customAgents==='preserve','CUSTOM_AGENT_OVERRIDE_NOT_SUPPORTED');
  assert(Array.isArray(c.enabledRuntimes) && c.enabledRuntimes.length && c.enabledRuntimes.every(x=>['claude','codex'].includes(x)),'INVALID_RUNTIMES');
  assert(Array.isArray(c.allowedProjects)&&c.allowedProjects.every(x=>typeof x==='string'&&path.isAbsolute(x)),'ABSOLUTE_PROJECTS_REQUIRED');
  assert(typeof c.stateDir==='string'&&path.isAbsolute(c.stateDir),'ABSOLUTE_STATE_REQUIRED');
  for (const [key,min,max] of [['timeoutMs',50,5000],['cacheTtlMs',0,600000],['maxDocuments',1,32],['maxTaskChars',100,10000],['maxContextChars',300,6000]])
    assert(Number.isInteger(c[key])&&c[key]>=min&&c[key]<=max,`INVALID_${key}`);
  assert(typeof c.minimumConfidence==='number'&&c.minimumConfidence>=0&&c.minimumConfidence<=1,'INVALID_CONFIDENCE');
  for(const k of ['readAdvice','classifyFailures','nativeProfiles']) assert(typeof c[k]==='boolean',`INVALID_${k}`);
  assert(Array.isArray(c.requiredDocuments)&&c.requiredDocuments.length<=8&&c.requiredDocuments.every(x=>typeof x==='string'&&!path.isAbsolute(x)&&!x.split(/[\\/]/).includes('..')),'INVALID_REQUIRED_DOCUMENTS');
  const u=new URL(c.endpoint);
  assert(u.protocol==='https:' || (c.allowLoopback===true&&u.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(u.hostname)), 'HTTPS_ENDPOINT_REQUIRED');
  assert(!u.username&&!u.password&&!u.search&&!u.hash,'INVALID_ENDPOINT');
  assert(typeof c.model==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(c.model),'INVALID_JEV_MODEL');
  validateRegistry(c.registry);validateSafety(c);
  const o=c.optimization;
  assert(object(o),'INVALID_OPTIMIZATION');
  assert(o.requiredContextTokens===null||(Number.isInteger(o.requiredContextTokens)&&o.requiredContextTokens>0),'INVALID_CONTEXT_REQUIREMENT');
  assert(object(o)&&['cost','latency','balanced'].includes(o.objective),'INVALID_OPTIMIZATION_OBJECTIVE');
  for(const [k,min,max] of [['maxRetryEscalations',0,3],['maxCandidates',1,16],['minimumSamples',5,10000],['routeDeadlineMs',200,5500],['evidenceTtlDays',1,365]])
    assert(Number.isInteger(o[k])&&o[k]>=min&&o[k]<=max,`INVALID_OPTIMIZATION_${k}`);
  for(const k of ['selectionConfidence','selectionMargin','qualityFloor','nonInferiorityTolerance','objectiveSlack'])
    assert(typeof o[k]==='number'&&Number.isFinite(o[k])&&o[k]>=0&&o[k]<=1,`INVALID_OPTIMIZATION_${k}`);
  assert(typeof o.jevSelectProfile==='boolean'&&typeof o.requireConfirmedAvailability==='boolean','INVALID_OPTIMIZATION_SWITCH');
  assert(typeof o.evaluationContext==='string'&&o.evaluationContext.length>0&&o.evaluationContext.length<=200,'INVALID_EVALUATION_CONTEXT');
  assert(object(c.installedProfiles),'INSTALLED_PROFILE_REGISTRY_REQUIRED');
  assert(object(c.circuit)&&Number.isInteger(c.circuit.failureThreshold)&&c.circuit.failureThreshold>=1&&c.circuit.failureThreshold<=10,'INVALID_CIRCUIT');
  assert(Number.isInteger(c.circuit.cooldownMs)&&c.circuit.cooldownMs>=1000&&c.circuit.cooldownMs<=3600000,'INVALID_CIRCUIT_COOLDOWN');
  assert(Number.isInteger(c.circuit.maxRequestsPerSession)&&c.circuit.maxRequestsPerSession>=1&&c.circuit.maxRequestsPerSession<=10000,'INVALID_REQUEST_CAP');
  return c;
}
export async function loadConfig(file, env=process.env) {
  assert(typeof file==='string'&&path.isAbsolute(file),'ABSOLUTE_CONFIG_REQUIRED');
  const c=await readJSON(file); assert(object(c),'INVALID_CONFIG');c.safety={...safetyDefaults(),...c.safety};
  const envPath=path.join(path.dirname(file),'.env');
  let disk={};
  try { assert(!(await fs.lstat(envPath)).isSymbolicLink(),'ENV_SYMLINK'); disk=parseEnv(await readPrivateEnv(envPath)); }
  catch(e){if(e.code!=='ENOENT')throw e;}
  const get=k=>env[k]?.trim()||disk[k]?.trim();
  applySafetyEnvironment(c,get);
  if(get('JEV_MODE'))c.mode=get('JEV_MODE');
  if(get('JEV_MODEL'))c.model=get('JEV_MODEL');
  if(get('JEV_TIMEOUT_MS'))c.timeoutMs=Number(get('JEV_TIMEOUT_MS'));
  if(get('TYPESAFE_BASE_URL'))c.endpoint=get('TYPESAFE_BASE_URL');
  if(get('JEV_READ_ADVICE')) {assert(['true','false'].includes(get('JEV_READ_ADVICE')),'INVALID_READ_ADVICE');c.readAdvice=get('JEV_READ_ADVICE')==='true';}
  applyModelEnvironment(c,new Proxy({}, {get:(_,key)=>get(key)}));
  if(get('JEV_OBJECTIVE'))c.optimization.objective=get('JEV_OBJECTIVE');
  if(get('JEV_EVALUATION_CONTEXT'))c.optimization.evaluationContext=get('JEV_EVALUATION_CONTEXT');
  validateConfig(c);
  const runtimeEnv={...env};
  for(const key of ['JEV_CONTROLLER_CRITIQUE','JEV_OTEL_ENABLED','JEV_OTEL_ENDPOINT','JEV_OTEL_PROJECT_ID','JEV_OTEL_INGEST_TOKEN',
    'OTEL_RESOURCE_ATTRIBUTES','OTEL_EXPORTER_OTLP_HEADERS'])if(get(key))runtimeEnv[key]=get(key);
  return {config:c,apiKey:get('TYPESAFE_API_KEY')||'',runtimeEnv};
}
export async function projectFor(config,cwd) {
  if(typeof cwd!=='string'||!path.isAbsolute(cwd))return null;
  let real;try{real=await fs.realpath(cwd);}catch{return null;}
  const roots=[];
  for(const p of config.allowedProjects){try{const root=await fs.realpath(p);if(within(root,real))roots.push(root);}catch{}}
  return roots.sort((a,b)=>b.length-a.length)[0]||null;
}
