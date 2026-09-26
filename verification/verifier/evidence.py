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
    return sorted(result,key=lambda r:r.get('time_ns',0))


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


def delegation_observations(hooks: list[dict]) -> dict:
    """Link native callbacks by tool ID and agent ID; synchronous stops can precede responses."""
    ordered=sorted(hooks,key=lambda row:row.get('time_ns',0))
    attempts=[(i,row) for i,row in enumerate(ordered) if row['event'].get('hook_event_name')=='PreToolUse'
              and row['event'].get('tool_name') in ('Agent','Task','spawn_agent')
              and not row['event'].get('agent_id')]
    starts=[(i,row) for i,row in enumerate(ordered) if row['event'].get('hook_event_name')=='SubagentStart']
    stops=[(i,row) for i,row in enumerate(ordered) if row['event'].get('hook_event_name')=='SubagentStop']
    responses=[(i,row) for i,row in enumerate(ordered) if row['event'].get('hook_event_name') in ('PostToolUse','PostToolUseFailure')]
    links={}
    for position,row in attempts:
        event=row['event'];tid=event.get('tool_use_id');matches=[]
        for response_position,response in responses:
            outcome=response['event'];body=outcome.get('tool_response') or {}
            if (response_position<=position or not tid or outcome.get('tool_use_id')!=tid or
                    outcome.get('tool_name') not in (None,event.get('tool_name')) or
                    (event.get('session_id') and outcome.get('session_id')!=event['session_id']) or
                    outcome.get('hook_event_name')!='PostToolUse' or not isinstance(body,dict) or
                    body.get('is_error') is True or body.get('success') is False):continue
            aid=body.get('agent_id') or body.get('agentId')
            if not isinstance(aid,str) or not aid:continue
            began=[i for i,started in starts if position<i and started['event'].get('agent_id')==aid]
            ended=[i for i,stopped in stops if began and began[0]<i and stopped['event'].get('agent_id')==aid]
            if len(began)==1 and len(ended)==1:matches.append((aid,began[0],ended[0]))
        links[tid]=matches if tid and tid not in links else []
    return {'attempts':attempts,'starts':starts,'links':links}


def assess_routing(hooks: list[dict], runtime: str, target, root: Path, aliases: dict) -> dict:
    observations=delegation_observations(hooks);routes=[];meta=child_metadata(root,hooks)
    for _,row in observations['attempts']:
        if not row.get('sut_invoked') or row.get('sut_returncode',0)!=0:continue
        out=row.get('output',{});u=out.get('hookSpecificOutput',{}).get('updatedInput')
        if not isinstance(u,dict):continue
        name=u.get('subagent_type') if runtime=='claude' else u.get('agent_type')
        if not isinstance(name,str) or not name.startswith('jev4_'):continue
        selected=target.selected_profile(out,runtime)
        tid=row['event'].get('tool_use_id');links=observations['links'].get(tid,[])
        matched=[aid for aid,began,_ in links if any(i==began and start['event'].get('agent_type')==name
                 for i,start in observations['starts'])]
        ambiguous=len(links)!=1 or len(matched)!=1
        # A profile name alone cannot identify a worker; require a successful native response and stop.
        observed=meta.get(matched[0]) if not ambiguous else None
        models=set(observed['models']) if observed else set();efforts=set(observed['efforts']) if observed else set()
        requested=selected['requested_model'];accepted=aliases.get(requested,[requested])
        if isinstance(accepted,str):accepted=[accepted]
        if not models:model_status='INCONCLUSIVE'
        elif models.issubset(set(accepted)):model_status='PASS'
        elif requested in ('haiku','sonnet','opus','fable') and requested not in aliases:model_status='INCONCLUSIVE_ALIAS_UNRESOLVED'
        else:model_status='FAIL'
        effort=selected['requested_effort']
        effort_status='NOT_APPLICABLE' if effort is None else 'INCONCLUSIVE' if not efforts else 'PASS' if efforts=={effort} else 'FAIL'
        routes.append({k:v for k,v in selected.items() if k!='input'}|{
            'tool_use_id':tid,'matched_child_ids':matched if not ambiguous else [],
            'correlation_ambiguous':ambiguous,'observed_models':sorted(models),'observed_efforts':sorted(efforts),
            'model_status':model_status,'effort_status':effort_status,
            'application_status':'PASS' if not ambiguous else 'INCONCLUSIVE_UNLINKED_WORKER'})
    return {'observer_seen':bool(hooks),'native_delegations_seen':len(observations['starts']),
            'delegation_attempts':len(observations['attempts']),'routes':routes,
            'warning':'Runtime metadata confirms runtime settings only, not hidden provider compute. Missing effort is not inferred from model names or profile files.'}
