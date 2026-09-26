#!/usr/bin/env python3
"""Synthetic native driver for VERIFIER SELF-TEST ONLY. Never used for live verdicts."""
import json,os,re,shlex,subprocess,sys,uuid
from pathlib import Path
args=sys.argv[1:]
if '--version' in args: print('SYNTHETIC-CLI-ONLY 0.0.0');sys.exit(0)
if '--help' in args:
    print('--output-format --settings --model --max-budget-usd --include-hook-events --forward-subagent-text --dangerously-bypass-hook-trust --effort ultracode');sys.exit(0)
prompt=sys.stdin.read();home=Path(os.environ['HOME']);project=Path.cwd();rt='codex' if 'exec' in args else 'claude'
config=json.loads((home/('.claude/settings.json' if rt=='claude' else '.codex/hooks.json')).read_text())
sid='synthetic-parent';aid='synthetic-child';tool='Agent' if rt=='claude' else 'spawn_agent';tid='synthetic-tool'
def hook(event,**kwargs):
    inp={'session_id':sid,'cwd':str(project),'hook_event_name':event,**kwargs}
    group=config['hooks'].get(event)
    if not group:return {}
    command=shlex.split(group[0]['hooks'][0]['command'])
    p=subprocess.run(command,input=json.dumps(inp),text=True,capture_output=True,env=os.environ)
    if p.returncode: print(p.stderr,file=sys.stderr);sys.exit(2)
    return json.loads(p.stdout)
hook('SessionStart',source='startup')
original={'prompt':prompt,'subagent_type':'general-purpose'} if rt=='claude' else {'message':prompt,'agent_type':'default','task_name':'fixture_task'}
o=hook('PreToolUse',tool_name=tool,tool_use_id=tid,tool_input=original)
i=o.get('hookSpecificOutput',{}).get('updatedInput',original)
name=i.get('subagent_type') if rt=='claude' else i.get('agent_type')
model=i.get('model');effort=i.get('reasoning_effort')
if rt=='claude':
    f=home/'.claude/agents'/(name+'.md')
    if f.exists():
        text=f.read_text();model=json.loads(re.search(r'^model:\s*(.+)$',text,re.M)[1]);m=re.search(r'^effort:\s*(.+)$',text,re.M);effort=m[1] if m else None
    else:model='opus'
hook('SubagentStart',agent_id=aid,agent_type=name)
solution="export function mergeIntervals(a){if(!Array.isArray(a)||a.some(x=>!Array.isArray(x)||x.length!==2||!x.every(Number.isFinite)||x[0]>x[1]))throw new TypeError();const b=a.map(x=>[...x]).sort((x,y)=>x[0]-y[0]);const o=[];for(const x of b){const p=o.at(-1);if(p&&x[0]<=p[1])p[1]=Math.max(p[1],x[1]);else o.push(x);}return o;}"
(project/'src/main.mjs').write_text(solution)
trans=home/('.claude/projects' if rt=='claude' else '.codex/sessions')/'synthetic-child.jsonl';trans.parent.mkdir(parents=True,exist_ok=True)
rows=[{'type':'session_meta','payload':{'id':aid}},{'type':'turn_context','payload':{'model':model,'effort':effort}}]
trans.write_text('\n'.join(json.dumps(x) for x in rows)+'\n')
hook('SubagentStop',agent_id=aid,agent_type=name,agent_transcript_path=str(trans))
hook('PostToolUse',tool_name=tool,tool_use_id=tid,tool_input=i,tool_response={'agent_id':aid})
hook('Stop')
if rt=='claude':print(json.dumps({'type':'result','subtype':'success','is_error':False,'total_cost_usd':0,'usage':{'input_tokens':0,'output_tokens':0}}))
else:print(json.dumps({'type':'turn.completed','usage':{'input_tokens':0,'output_tokens':0}}))
