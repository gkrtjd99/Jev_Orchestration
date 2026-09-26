/** Model capabilities are explicit declarations, never inferred from marketing names. */
import { assert, object, hash } from './util.mjs';
export const SLOTS = ['micro', 'light', 'standard', 'strategic'];
export const ROLES = ['plan', 'research', 'documentation', 'implement', 'review'];
export const INTENTS = ['brief', 'balanced', 'deep', 'exhaustive'];
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const idPattern = /^[A-Za-z0-9_./:[\]-]{1,160}$/;
const roles = {micro:['research'], light:['research','documentation','implement'], standard:['research','documentation','implement','review'], strategic:['plan','implement','review']};

export function defaultRegistry() {
  const models = [];
  for (const runtime of ['claude','codex']) for (const slot of SLOTS) {
    if (runtime === 'codex' && slot === 'micro') continue; // No invented Haiku-equivalent.
    const model = runtime === 'claude'
      ? {micro:'haiku',light:'claude-sonnet-5',standard:'claude-opus-5-5',strategic:'claude-fable-5-1'}[slot]
      : {light:'gpt-6-luna',standard:'gpt-6-sol',strategic:'gpt-6-astra'}[slot];
    const effortByIntent = slot === 'micro' ? {brief:null}
      : slot === 'light' ? {brief:'high',balanced:'xhigh',deep:'xhigh',exhaustive:'max'}
      : slot === 'standard' ? {brief:'high',balanced:'high',deep:'xhigh',exhaustive:'max'}
      : {brief:'high',balanced:'high',deep:'xhigh',exhaustive:'xhigh'};
    models.push({id:`${runtime}-${slot}`,runtime,slot,model,backend:model,enabled:slot!=='micro',
      availability:'declared',capabilitySource:'quality-first-policy-2026-09-25',
      supportedEfforts:[...new Set(Object.values(effortByIntent))],effortByIntent,
      roles:roles[slot],contextTokens:null,price:null});
  }
  return {schema:1,revision:'quality-first-policy-2026-09-25',models};
}
export function validateRegistry(r) {
  assert(object(r) && r.schema===1 && typeof r.revision==='string','INVALID_REGISTRY');
  assert(Array.isArray(r.models)&&r.models.length>0&&r.models.length<=24,'INVALID_MODEL_CATALOG');
  const ids=new Set();
  for (const m of r.models) {
    assert(object(m)&&typeof m.id==='string'&&/^[a-z0-9-]{1,48}$/.test(m.id)&&!ids.has(m.id),'INVALID_OR_DUPLICATE_MODEL_ID'); ids.add(m.id);
    assert(['claude','codex'].includes(m.runtime)&&SLOTS.includes(m.slot),'INVALID_MODEL_SLOT');
    assert(typeof m.model==='string'&&typeof m.backend==='string'&&idPattern.test(m.model)&&idPattern.test(m.backend),'INVALID_MODEL_ID');
    assert(typeof m.enabled==='boolean'&&['declared','confirmed','unavailable'].includes(m.availability),'INVALID_AVAILABILITY');
    assert(typeof m.capabilitySource==='string'&&m.capabilitySource.length>0,'CAPABILITY_SOURCE_REQUIRED');
    assert(Array.isArray(m.supportedEfforts)&&m.supportedEfforts.length>0&&m.supportedEfforts.every(e=>e===null||EFFORTS.includes(e)),'INVALID_SUPPORTED_EFFORTS');
    assert(object(m.effortByIntent)&&Object.keys(m.effortByIntent).length>0,'INTENT_MAPPING_REQUIRED');
    for (const [intent,e] of Object.entries(m.effortByIntent)) {
      assert(INTENTS.includes(intent)&&m.supportedEfforts.includes(e),'UNSUPPORTED_EFFORT_MAPPING');
      if(m.runtime==='claude')assert(e===null||['low','medium','high','xhigh','max'].includes(e),'EFFORT_NOT_SUPPORTED_BY_CLAUDE_FRONTMATTER');
    }
    assert(Array.isArray(m.roles)&&m.roles.length>0&&m.roles.every(x=>ROLES.includes(x)),'INVALID_MODEL_ROLES');
    assert(m.contextTokens===null||(Number.isInteger(m.contextTokens)&&m.contextTokens>0),'INVALID_CONTEXT_LIMIT');
    assert(m.price===null||object(m.price),'INVALID_PRICE_METADATA');
    // Price records, if supplied, must have a provenance and are never fabricated by Jev.
    if(m.price!==null)assert(typeof m.price.source==='string'&&typeof m.price.checkedAt==='string','PRICE_PROVENANCE_REQUIRED');
  }
  return r;
}
export const registryFingerprint = r => hash(r);
export function profileCatalog(registry,runtime) {
  validateRegistry(registry);
  const profiles=[];
  for(const m of registry.models.filter(m=>m.runtime===runtime&&m.enabled&&m.availability!=='unavailable')) {
    for(const role of m.roles) {
      // Two intents may deliberately request the same setting. Keep one physical profile.
      const variants=new Map();
      for(const [intent,effort] of Object.entries(m.effortByIntent)) {
        const key=effort??'default';const old=variants.get(key)||{intents:[],effort};
        old.intents.push(intent);variants.set(key,old);
      }
      for(const {intents,effort} of variants.values()) {
        const signature=hash({runtime,model:m.model,backend:m.backend,role,effort}).slice(0,10);
        const profileId=`jev4_${role}_${m.slot}_${effort??'default'}_${signature}`;
        profiles.push({profileId,runtime,role,slot:m.slot,model:m.model,backend:m.backend,
          effort,intents,modelKey:m.id,availability:m.availability,
          capabilitySource:m.capabilitySource,contextTokens:m.contextTokens,
          readonly:['plan','research','review'].includes(role),
          fingerprint:hash({model:m,role,effort})});
      }
    }
  }
  assert(new Set(profiles.map(p=>p.profileId)).size===profiles.length,'DUPLICATE_EXECUTION_PROFILE');
  return profiles;
}
export function applyModelEnvironment(config,env) {
  for(const runtime of ['claude','codex']) for(const slot of SLOTS) {
    const prefix=`JEV_${runtime.toUpperCase()}_${slot.toUpperCase()}`;
    const requested=env[`${prefix}_MODEL`]?.trim();
    if(!requested)continue;
    let m=config.registry.models.find(x=>x.runtime===runtime&&x.slot===slot);
    assert(m,'MODEL_SLOT_REQUIRES_REGISTRY_ENTRY');
    if(requested!==m.model||env[`${prefix}_EFFORT_MAP`]||env[`${prefix}_BACKEND`]&&env[`${prefix}_BACKEND`]!==m.backend) {
      // An alias might point to a different provider. Require an explicit capability declaration.
      const mapping=env[`${prefix}_EFFORT_MAP`];
      assert(mapping,'MODEL_OVERRIDE_REQUIRES_EFFORT_MAP');
      const map=JSON.parse(mapping);assert(object(map),'INVALID_EFFORT_MAP');
      m.model=requested;m.backend=env[`${prefix}_BACKEND`]?.trim()||requested;
      m.effortByIntent=map;m.supportedEfforts=[...new Set(Object.values(map))];
      m.capabilitySource='explicit-user-environment';m.availability='declared';
    }
  }
  validateRegistry(config.registry);
}
