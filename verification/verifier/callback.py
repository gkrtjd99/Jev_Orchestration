#!/usr/bin/env python3
"""Native hook observer. Executes the unmodified SUT callback as a subprocess."""
from __future__ import annotations
import json, os, subprocess, sys, time, uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from verifier.common import read_json, write_json, write_private, sha, redact, load_env, secrets_from


def main():
    spec=read_json(Path(sys.argv[sys.argv.index('--spec')+1]))
    raw=sys.stdin.buffer.read(1_048_577)
    if len(raw)>1_048_576: raise ValueError('HOOK_INPUT_LIMIT')
    event=json.loads(raw); started=time.perf_counter(); output={}; code=0; invoked=False;timed_out=False
    secrets=secrets_from(load_env(Path(spec['env_file']))) if spec.get('env_file') else []
    selected=sys.argv[sys.argv.index('--event')+1] if '--event' in sys.argv else None
    if selected and selected!=event.get('hook_event_name'):raise ValueError('HOOK_EVENT_MISMATCH')
    rule=spec.get('sut_rules',{}).get(selected) if selected else None
    stdout=b'{}\n';stderr=b''
    if rule:
        # The host already applied the original matcher. Forward the exact SUT bytes and exit code.
        invoked=True
        try:
            p=subprocess.run(rule['argv'],cwd=Path(event.get('cwd',spec['project'])),env=dict(os.environ),
                             input=raw,capture_output=True,timeout=rule['timeout'])
            stdout=p.stdout;stderr=p.stderr;code=p.returncode
        except subprocess.TimeoutExpired as exc:
            stdout=exc.stdout or b'';stderr=exc.stderr or b'';code=124;timed_out=True
        try:
            parsed=json.loads(stdout)
            if isinstance(parsed,dict):output=parsed
        except (ValueError,UnicodeDecodeError):pass
    evidence=Path(spec['evidence_dir']);identifier=str(time.time_ns())+'-'+uuid.uuid4().hex
    rec={'origin':'NATIVE_CALLBACK_OBSERVER','nonce':spec['nonce'],'time_ns':time.time_ns(),
         'event':event,'sut_invoked':invoked,'sut_returncode':code,'sut_stdout_valid':bool(output) or stdout.strip()==b'{}',
         'sut_timed_out':timed_out,'output':output,'duration_ms':(time.perf_counter()-started)*1000}
    write_private(evidence/'hooks'/(identifier+'.json'),redact(json.dumps(rec,ensure_ascii=False),secrets))
    # Copy only a child transcript explicitly referenced by the runtime, under this test HOME.
    child=event.get('agent_transcript_path')
    if child:
        try:
            p=Path(child).resolve();p.relative_to(Path(spec['home']).resolve())
            if p.is_file() and not p.is_symlink() and p.stat().st_size<16_000_000:
                write_private(evidence/'transcripts'/(identifier+'.jsonl'),redact(p.read_text(encoding='utf-8'),secrets))
                write_json(evidence/'transcripts'/(identifier+'.meta.json'),{
                    'agent_id':event.get('agent_id'),'source_path':str(p),'source':'native_agent_transcript_path','sha256':sha(p.read_bytes())})
        except (ValueError,OSError): pass
    sys.stdout.buffer.write(stdout);sys.stderr.buffer.write(stderr)
    return code
if __name__=='__main__':
    try:sys.exit(main())
    except Exception as e:
        sys.stderr.write('Verifier observer error: '+type(e).__name__+'\n');sys.exit(1)
