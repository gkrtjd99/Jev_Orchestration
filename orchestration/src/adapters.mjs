import { assert, object } from './util.mjs';
export const SUPPORTED_EVENTS=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','SubagentStart','SubagentStop','PreCompact','SessionEnd'];
export function eventInput(raw,runtime){
  assert(['claude','codex'].includes(runtime),'INVALID_RUNTIME');
  assert(object(raw)&&typeof raw.hook_event_name==='string','INVALID_EVENT');
  assert(typeof raw.session_id==='string'&&raw.session_id.length>0&&raw.session_id.length<=256,'INVALID_SESSION_ID');
  assert(typeof raw.cwd==='string','INVALID_CWD');
  return {...raw,runtime,event:raw.hook_event_name,input:raw.tool_input};
}
export function isDelegation(e){
  return e.runtime==='claude' ? ['Agent','Task'].includes(e.tool_name) : ['spawn_agent','agents.spawn_agent','multi_agent.spawn_agent','collaborationspawn_agent'].includes(e.tool_name);
}
export const isRead=e=>e.runtime==='claude'&&e.tool_name==='Read';
export function delegation(e){
  if(!isDelegation(e)||!object(e.input))return null;
  const key=e.runtime==='claude'?'prompt':'message';
  // Preserve rich items and unfamiliar protocols instead of rewriting an unknown contract.
  if(typeof e.input[key]!=='string'||!e.input[key].trim())return null;
  if(e.runtime==='codex'&&e.input.items!==undefined)return null;
  const kind=e.runtime==='claude'?(e.input.subagent_type||'general-purpose'):(e.input.agent_type||'default');
  const known=e.runtime==='claude'?['general-purpose','Explore','Plan']:['default','worker','explorer'];
  const managed=/^jev4_(plan|research|documentation|implement|review)_[a-z0-9_]+$/.test(kind)||/^jev_(planner|reader|writer|reviewer|worker_(light|standard|strategic))$/.test(kind);
  return {key,text:e.input[key],kind,custom:!known.includes(kind)&&!managed,managed};
}
export function fixedRole(d){
  const managed=d.kind?.match(/^jev4_(plan|research|documentation|implement|review)_/);if(managed)return managed[1];
  if(d.kind==='Plan'||d.kind==='jev_planner')return 'plan';
  if(['Explore','explorer','jev_reader'].includes(d.kind))return 'research';
  if(d.kind==='jev_reviewer')return 'review';
  if(d.kind==='jev_writer')return 'documentation';
  return null;
}
export function contextOutput(event,text){
  return text?{hookSpecificOutput:{hookEventName:event,additionalContext:text}}:{};
}
export function denyOutput(reason){return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}};}
export function rewrite(e,d,route,text,cfg,alreadyRewritten=false){
  assert(!d.custom,'CUSTOM_AGENT_PRESERVED');
  const input=structuredClone(e.input);
  if(!alreadyRewritten)input[d.key]=d.text+'\n\n'+text;
  if(e.runtime==='claude'){
    // The supported effort surface is the installed subagent frontmatter, not an invented Agent argument.
    delete input.model;
    input.subagent_type=route.profile;
    // Do not return allow: it would approve a call rather than only changing arguments.
    return {hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:input,additionalContext:`Jev route: ${route.role} / ${route.tier} / effort=${route.effort??'not requested'}; native execution remains in this session.`}};
  }
  // Both current native spawn protocols accept model. Preserve task_name, fork settings, effort, and permissions.
  assert(cfg.safety?.codexRewriteApproved===true,'CODEX_REWRITE_REQUIRES_EXPLICIT_APPROVAL');
  if(e.tool_name==='collaborationspawn_agent')assert(cfg.safety?.codexCollaborationRewriteApproved===true,'COLLABORATION_REWRITE_REQUIRES_EXPLICIT_APPROVAL');
  input.model=route.model;
  if(route.effort!==null&&route.effort!==undefined)input.reasoning_effort=route.effort;
  else delete input.reasoning_effort;
  input.agent_type=route.profile;
  return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:input,additionalContext:`Jev route: ${route.role} / ${route.tier} / effort=${route.effort??'not requested'}; only this native delegation was rewritten.`}};
}
export function hookMatchers(runtime,readAdvice=false,controller=false){
  const native=runtime==='claude'?'Agent|Task|Workflow':'Agent|spawn_agent|agents\\.spawn_agent|multi_agent\\.spawn_agent|collaborationspawn_agent';
  if(controller&&runtime==='claude')return '^.*$'; // Include MCP and future tool names, not only known code tools.
  return '^('+native+(runtime==='claude'&&readAdvice?'|Read':'')+')$';
}
