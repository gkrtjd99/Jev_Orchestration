"""Parse only typed native metadata, never model prose or SUT success claims."""
from __future__ import annotations
import json, math
from pathlib import Path
from .common import parse_jsonl, read_json, Inconclusive


def terminal_result(runtime: str, events: list[dict]) -> dict:
    if runtime=='claude':
        results=[e for e in events if e.get('type')=='result']
        last=results[-1] if results else {}
        ok=bool(last) and last.get('is_error') is False and last.get('subtype') in ('success',None)
        dollars=last.get('total_cost_usd')
        if not isinstance(dollars,(int,float)) or not math.isfinite(dollars) or dollars<0:dollars=None
        return {'completed':ok,'cli_reported_cost_usd':dollars,'cost_kind':'CLI_REPORTED_NOT_INVOICE',
                'usage':last.get('usage'),'cost_scope':'native_session_reported','terminal_events':len(results)}
    turns=[e for e in events if e.get('type')=='turn.completed']
    errors=[e for e in events if e.get('type') in ('turn.failed','error')]
    usage={}; missing=False
    for e in turns:
        u=e.get('usage')
        if not isinstance(u,dict):missing=True;continue
        for k,v in u.items():
            if isinstance(v,int) and not isinstance(v,bool) and v>=0:usage[k]=usage.get(k,0)+v
    return {'completed':bool(turns) and not errors,'usage':None if missing else usage or None,
            'cli_reported_cost_usd':None,'cost_scope':'main_or_unspecified_not_total','terminal_events':len(turns)}


def load_hook_records(root: Path,nonce: str) -> list[dict]:
    result=[]
    for p in sorted((root/'hooks').glob('*.json')):
        row=read_json(p)
        if row.get('origin')=='NATIVE_CALLBACK_OBSERVER' and row.get('nonce')==nonce:result.append(row)
    return result


def metadata_from_transcript(rows: list[dict]) -> dict:
    """Versioned conservative parser. No recursive search through arbitrary 'content' strings."""
    models=set();efforts=set();agent_ids=set();session_id=None
    valid_efforts=('none','minimal','low','medium','high','xhigh','max')
    for row in rows:
        typ=row.get('type');p=row.get('payload')
        if typ=='session_meta' and isinstance(p,dict):session_id=p.get('id')
        if typ=='turn_context' and isinstance(p,dict):
            if isinstance(p.get('model'),str):models.add(p['model'])
            # Codex rollout contexts. Unknown schemas remain unknown.
            e=p.get('effort',p.get('reasoning_effort'))
            if e in valid_efforts:efforts.add(e)
        if typ=='assistant' and isinstance(row.get('message'),dict):
            m=row['message'].get('model')
            if isinstance(m,str) and m and not m.startswith('<'):models.add(m)
            # Claude child transcript fields are typed top-level metadata, not prose.
            if row.get('effort') in valid_efforts:efforts.add(row['effort'])
            if isinstance(row.get('agentId'),str) and row['agentId']:agent_ids.add(row['agentId'])
        if typ=='system' and row.get('subtype')=='init':
            if isinstance(row.get('model'),str):models.add(row['model'])
            if row.get('effortLevel') in valid_efforts:efforts.add(row['effortLevel'])
    return {'models':sorted(models),'efforts':sorted(efforts),'session_id':session_id,'agent_ids':sorted(agent_ids)}


def child_metadata(root: Path, hooks: list[dict]) -> dict[str,dict]:
    out={}
    for f in (root/'transcripts').glob('*.jsonl'):
        meta=read_json(f.with_suffix('.meta.json')) if f.with_suffix('.meta.json').exists() else {}
        rows,_=parse_jsonl(f.read_text(encoding='utf-8')); native=metadata_from_transcript(rows)
        typed=native['agent_ids'];claimed=meta.get('agent_id')
        if len(typed)>1 or claimed and typed and typed!=[claimed]:continue
        aid=claimed or (typed[0] if typed else native.get('session_id'))
        if aid:out[aid]=native|{'source':'NATIVE_CHILD_TRANSCRIPT','file':f.name}
    return out


def assess_routing(hooks: list[dict], runtime: str, target, root: Path, aliases: dict) -> dict:
    starts=[r['event'] for r in hooks if r['event'].get('hook_event_name')=='SubagentStart']
    routes=[]
    for r in hooks:
        if r['event'].get('hook_event_name')!='PreToolUse' or not r.get('sut_invoked') or r.get('sut_returncode',0)!=0:continue
        out=r.get('output',{});u=out.get('hookSpecificOutput',{}).get('updatedInput')
        if not isinstance(u,dict):continue
        name=u.get('subagent_type') if runtime=='claude' else u.get('agent_type')
        if not isinstance(name,str) or not name.startswith('jev4_'):continue
        selected=target.selected_profile(out,runtime)
        matches=[s for s in starts if s.get('agent_type')==name]
        routes.append(selected|{'tool_use_id':r['event'].get('tool_use_id'),'matched_child_ids':[s.get('agent_id') for s in matches]})
    meta=child_metadata(root,hooks)
    profile_counts={}
    for route in routes:profile_counts[route['profile']]=profile_counts.get(route['profile'],0)+1
    for route in routes:
        route['correlation_ambiguous']=profile_counts[route['profile']]>1 or len(route['matched_child_ids'])>1
        if route['correlation_ambiguous']:
            # A profile name is not a unique tool-call identifier. Never assign another child's result.
            route['matched_child_ids']=[]
        observed=[meta[x] for x in route['matched_child_ids'] if x in meta]
        models={m for item in observed for m in item['models']};efforts={m for item in observed for m in item['efforts']}
        route['observed_models']=sorted(models);route['observed_efforts']=sorted(efforts)
        requested=route['requested_model'];accepted=aliases.get(requested,[requested])
        if isinstance(accepted,str):accepted=[accepted]
        if not models: route['model_status']='INCONCLUSIVE'
        elif models.issubset(set(accepted)):route['model_status']='PASS'
        elif requested in ('haiku','sonnet','opus','fable') and requested not in aliases:route['model_status']='INCONCLUSIVE_ALIAS_UNRESOLVED'
        else:route['model_status']='FAIL'
        effort=route['requested_effort']
        route['effort_status']='NOT_APPLICABLE' if effort is None else 'INCONCLUSIVE' if not efforts else 'PASS' if efforts=={effort} else 'FAIL'
        route['application_status']='INCONCLUSIVE_AMBIGUOUS_CORRELATION' if route['correlation_ambiguous'] else 'PASS' if route['matched_child_ids'] else 'FAIL'
        route.pop('input',None)
    return {'observer_seen':bool(hooks),'native_delegations_seen':len(starts),'routes':routes,
            'warning':'Runtime metadata confirms runtime settings only, not hidden provider compute. Missing effort is not inferred from model names or profile files.'}
