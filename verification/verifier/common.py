"""Independent verifier utilities. No imports from the system under test."""
from __future__ import annotations
import dataclasses, hashlib, html, json, math, os, re, signal, subprocess, tempfile, time, threading
from pathlib import Path
from typing import Any

VERSION = '1.1.0'
STATUSES = {'PASS', 'FAIL', 'BLOCKED', 'INCONCLUSIVE', 'NOT_RUN'}
class Blocked(RuntimeError): pass
class Inconclusive(RuntimeError): pass


def sha(data: bytes | str) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def canonical(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def read_json(file: Path) -> Any:
    return json.loads(file.read_text(encoding='utf-8'))


def write_private(file: Path, text: str | bytes) -> None:
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if file.is_symlink(): raise ValueError(f'Refusing symlink: {file.name}')
    fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(text.encode('utf-8') if isinstance(text, str) else text)
    os.chmod(file, 0o600)


def write_json(file: Path, value: Any) -> None:
    write_private(file, json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+'\n')


def load_env(file: Path | None, *, inherit: bool = True) -> dict[str, str]:
    values: dict[str, str] = {}
    if file:
        if file.is_symlink(): raise ValueError('An env file must not be a symlink.')
        for n, raw in enumerate(file.read_text(encoding='utf-8').splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith('#'): continue
            match = re.fullmatch(r'(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)', line)
            if not match: raise ValueError(f'Invalid env line {n}; shell expressions are not supported.')
            key, value = match.groups(); value = value.strip()
            if value.startswith(('"', "'")):
                if len(value) < 2 or value[-1] != value[0]: raise ValueError(f'Invalid quote on line {n}')
                value = value[1:-1]
            if '\x00' in value: raise ValueError('NUL in env value')
            if value: values[key] = value
    # Most verifier commands retain shell overrides; paid repository trials freeze env-file inputs.
    if inherit:
        for key, value in os.environ.items():
            if value and key.startswith(('JEV_', 'VERIFY_', 'ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'TYPESAFE_')):
                values[key] = value
    return values


def secrets_from(env: dict[str, str]) -> list[str]:
    return [v for k,v in env.items() if v and len(v) >= 6 and any(x in k for x in ('KEY','TOKEN','PASSWORD','SECRET'))]


def redact(text: str, secrets: list[str] | tuple[str, ...] = ()) -> str:
    for value in sorted(secrets, key=len, reverse=True): text = text.replace(value, '[REDACTED]')
    text = re.sub(r'(?i)(Bearer\s+)[A-Za-z0-9_.+\-/=]{8,}', r'\1[REDACTED]', text)
    text = re.sub(r'\bsk-[A-Za-z0-9_-]{12,}', '[REDACTED]', text)
    text = re.sub(r'(?i)("(?:access_token|refresh_token|id_token|api_key|client_secret)"\s*:\s*")[^"]+(")', r'\1[REDACTED]\2', text)
    return text


def tree_manifest(root: Path, *, ignore: tuple[str, ...] = ('.git','node_modules','__pycache__')) -> dict[str, str]:
    result: dict[str, str] = {}
    if not root.is_dir(): raise ValueError('SUT must be an extracted directory.')
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in ignore)
        for d in dirs:
            p = Path(base)/d
            if p.is_symlink(): raise ValueError(f'Symlink directory not accepted: {p.relative_to(root)}')
        for f in sorted(files):
            p = Path(base)/f
            if p.is_symlink(): raise ValueError(f'Symlink not accepted: {p.relative_to(root)}')
            result[p.relative_to(root).as_posix()] = sha(p.read_bytes())
    return result


def clean_env(home: Path) -> dict[str, str]:
    allowed = ('PATH','SYSTEMROOT','COMSPEC','LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR',
               'HTTPS_PROXY','HTTP_PROXY','NO_PROXY','https_proxy','http_proxy','no_proxy')
    env = {k:os.environ[k] for k in allowed if k in os.environ}
    env.update(HOME=str(home), USERPROFILE=str(home), TMPDIR=str(home/'tmp'),
               XDG_CONFIG_HOME=str(home/'.config'), XDG_STATE_HOME=str(home/'.local/state'),
               CLAUDE_CONFIG_DIR=str(home/'.claude'), CODEX_HOME=str(home/'.codex'),
               PYTHONDONTWRITEBYTECODE='1', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
               GIT_TERMINAL_PROMPT='0', NO_COLOR='1')
    (home/'tmp').mkdir(parents=True, exist_ok=True)
    return env


@dataclasses.dataclass
class ProcessResult:
    argv: list[str]
    returncode: int
    stdout: str
    stderr: str
    duration_ms: float
    timed_out: bool = False
    output_limit: bool = False


def run_process(argv: list[str], *, cwd: Path, env: dict[str,str], timeout: float=30,
                stdin: str='', log_prefix: Path|None=None, secrets: list[str]=(), max_output: int=24_000_000, pipe_stdin: bool=False) -> ProcessResult:
    if not argv or not all(isinstance(x,str) for x in argv): raise ValueError('argv must be a string array')
    start=time.perf_counter(); timed=False; limit=False
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err, tempfile.TemporaryFile() as inp:
        inp.write(stdin.encode()); inp.seek(0)
        try:
            p=subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE if pipe_stdin else inp, stdout=out, stderr=err,
                               start_new_session=(os.name=='posix'))
        except FileNotFoundError as e:
            raise Blocked(f'EXECUTABLE_NOT_FOUND: {argv[0]}') from e
        feeder=None
        if pipe_stdin:
            def feed():
                try:p.stdin.write(stdin.encode());p.stdin.close()
                except (BrokenPipeError,OSError):pass
            feeder=threading.Thread(target=feed,daemon=True);feeder.start()
        try:
            while p.poll() is None:
                timed=time.perf_counter()-start>timeout
                limit=os.fstat(out.fileno()).st_size+os.fstat(err.fileno()).st_size>max_output
                if timed or limit:
                    if os.name=='posix': os.killpg(p.pid, signal.SIGTERM)
                    else: p.terminate()
                    try: p.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        if os.name=='posix': os.killpg(p.pid,signal.SIGKILL)
                        else: p.kill()
                        p.wait(timeout=5)
                    break
                time.sleep(.015)
        except BaseException:
            if p.poll() is None:
                if os.name=='posix': os.killpg(p.pid,signal.SIGKILL)
                else: p.kill()
                p.wait()
            raise
        if feeder:feeder.join(timeout=1)
        out.seek(0); err.seek(0)
        stdout=redact(out.read(max_output).decode('utf-8','replace'),secrets)
        stderr=redact(err.read(max_output).decode('utf-8','replace'),secrets)
    result=ProcessResult(argv, p.returncode, stdout, stderr,(time.perf_counter()-start)*1000,timed,limit)
    if log_prefix:
        write_private(log_prefix.with_suffix('.stdout.log'),stdout)
        write_private(log_prefix.with_suffix('.stderr.log'),stderr)
        write_json(log_prefix.with_suffix('.process.json'),{
            'argv': [redact(x,secrets) for x in argv], 'returncode':result.returncode,
            'duration_ms':result.duration_ms,'timed_out':timed,'output_limit':limit})
    return result


def parse_jsonl(text: str) -> tuple[list[dict], int]:
    rows=[]; malformed=0
    for line in text.splitlines():
        if not line.strip(): continue
        try:
            row=json.loads(line)
            if isinstance(row,dict): rows.append(row)
            else: malformed+=1
        except (ValueError,TypeError): malformed+=1
    return rows,malformed


class Report:
    def __init__(self, out: Path, secrets: list[str]=()):
        self.out=out; self.secrets=secrets; self.checks=[]; self.meta={}; self.trials=[]; self.comparisons=[]
        self.started=time.time(); out.mkdir(parents=True,exist_ok=True,mode=0o700)
    def add(self, stage: str, name: str, status: str, detail: Any=None):
        if status not in STATUSES: raise ValueError(status)
        safe=json.loads(redact(json.dumps(detail,ensure_ascii=False,default=str),self.secrets)) if detail is not None else None
        row={'stage':stage,'name':name,'status':status,'detail':safe}
        self.checks.append(row)
        print(f'[{status}] {stage}/{name}',flush=True)
        return row
    def check(self, stage: str, name: str, fn):
        try:
            value=fn(); return self.add(stage,name,'PASS',value)
        except Blocked as e: return self.add(stage,name,'BLOCKED',str(e))
        except Inconclusive as e: return self.add(stage,name,'INCONCLUSIVE',str(e))
        except Exception as e: return self.add(stage,name,'FAIL',f'{type(e).__name__}: {e}')
    def finish(self):
        statuses={r['status'] for r in self.checks}
        overall='FAIL' if 'FAIL' in statuses else 'BLOCKED' if 'BLOCKED' in statuses else 'INCONCLUSIVE' if 'INCONCLUSIVE' in statuses else 'PASS'
        data={'verifier_version':VERSION,'started_at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(self.started)),
              'elapsed_seconds':round(time.time()-self.started,3),'overall':overall,
              'meaning':'PASS applies only to the requested checks; never implies global performance superiority.',
              'meta':self.meta,'checks':self.checks,'trials':self.trials,'comparisons':self.comparisons}
        text=redact(json.dumps(data,ensure_ascii=False,indent=2,allow_nan=False),self.secrets)
        write_private(self.out/'report.json',text+'\n')
        lines=['# Jev 독립 검증 결과', '', f'**판정: {overall}**', '',
               'PASS는 요청한 검사 범위의 결과입니다. 미실행·미관측·표본 부족을 성공으로 간주하지 않습니다.', '',
               '| 단계 | 검사 | 판정 |','|---|---|---|']
        lines += [f"| {r['stage']} | {r['name']} | {r['status']} |" for r in self.checks]
        lines+=['','## 세부 결과','']
        for r in self.checks:
            detail=json.dumps(r['detail'],ensure_ascii=False,indent=2)
            lines += [f"### {r['stage']} / {r['name']}: {r['status']}",'','```json',detail,'```','']
        lines += ['## 비교 결과','','```json',json.dumps(self.comparisons,ensure_ascii=False,indent=2),'```','',
                  '세부 명령·출력·관측 자료는 artifacts/에 있습니다. report.json은 기계 판독용 원본입니다.']
        write_private(self.out/'report.ko.md',redact('\n'.join(lines)+'\n',self.secrets))
        # HTML contains escaped text only. No external scripts or assets.
        write_private(self.out/'report.html','<!doctype html><html lang="ko"><meta charset="utf-8"><title>Jev verification</title>'
                      '<style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>'
                      '<h1>Jev 독립 검증</h1><pre>'+html.escape(redact('\n'.join(lines),self.secrets))+'</pre></html>')
        return {'PASS':0,'FAIL':1,'BLOCKED':2,'INCONCLUSIVE':3}[overall]
