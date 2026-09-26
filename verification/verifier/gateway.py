"""A bounded loopback observer. Synthetic and real-upstream modes never share labels."""
from __future__ import annotations
import json, math, threading, time, secrets, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from .common import Blocked, canonical, write_json, redact

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url,code,'Redirect refused',headers,fp)


def validate_response(value: dict, questions: dict) -> None:
    assert isinstance(value,dict) and isinstance(value.get('model'),str) and value['model'], 'Missing response model'
    assert isinstance(value.get('answers'),dict), 'Missing answers'
    usage=value.get('usage')
    assert isinstance(usage,dict), 'Missing API usage (do not invent zero usage)'
    for key in ('input_tokens','output_tokens'):
        assert isinstance(usage.get(key),int) and not isinstance(usage[key],bool) and usage[key]>=0, f'Invalid {key}'
    unit=lambda n:isinstance(n,(int,float)) and not isinstance(n,bool) and math.isfinite(n) and 0<=n<=1
    for key,q in questions.items():
        a=value['answers'].get(key)
        assert isinstance(a,dict) and a.get('type')==q['type'], f'Answer type mismatch: {key}'
        if q['type']=='noul': assert unit(a.get('noul')),f'Invalid noul: {key}'; continue
        assert unit(a.get('confidence')),f'Invalid confidence: {key}'
        p=a.get('probabilities'); assert isinstance(p,dict) and p and all(unit(x) for x in p.values()),f'Invalid probabilities: {key}'
        assert abs(sum(p.values())-1)<.02,f'Probability sum: {key}'
        if q['type']=='choice':
            assert set(p)==set(q['criteria']),f'Choice options mismatch: {key}'
            assert a.get('choice') in p and p[a['choice']]>=max(p.values())-1e-8,f'Invalid chosen option: {key}'
        elif q['type']=='score':
            assert isinstance(a.get('legend'),dict),f'Missing legend: {key}'
            assert set(p)=={str(i) for i in range(len(q['criteria']))},f'Score options mismatch: {key}'
            score=a.get('score'); assert isinstance(score,(int,float)) and math.isfinite(score),f'Invalid score: {key}'
            assert abs(score-sum(int(i)*v for i,v in p.items()))<.03,f'Score distribution mismatch: {key}'
        else: raise AssertionError(f'Unknown primitive: {q["type"]}')


def api_call(endpoint: str, key: str, payload: dict, timeout: float=15) -> tuple[int,dict,float]:
    u=urlsplit(endpoint)
    if u.scheme!='https' or u.username or u.password or u.query or u.fragment:
        raise Blocked('Upstream endpoint must be HTTPS without credentials, query, or fragment.')
    if not key: raise Blocked('MISSING_TYPESAFE_API_KEY')
    req=urllib.request.Request(endpoint.rstrip('/')+'/v1/systemone',data=canonical(payload).encode(),
        headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'},method='POST')
    start=time.perf_counter()
    opener=urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(req,timeout=timeout) as response:
            status=response.status; data=response.read(524289)
    except urllib.error.HTTPError as e:
        status=e.code; data=e.read(524289)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise Blocked('JEV_NETWORK_OR_TLS_UNAVAILABLE: '+type(e).__name__) from e
    if len(data)>524288: raise ValueError('API_RESPONSE_SIZE_LIMIT')
    try: body=json.loads(data)
    except ValueError: body={'error':'NON_JSON_UPSTREAM_RESPONSE','preview':redact(data[:200].decode('utf-8','replace'),[key])}
    return status,body,(time.perf_counter()-start)*1000


class Gateway:
    def __init__(self, *, synthetic: bool, endpoint: str='https://api.typesafe.ai', key: str='',
                 max_requests: int=100, timeout: float=15, artifact: Path|None=None):
        self.access_token=secrets.token_urlsafe(32)
        self.synthetic=synthetic; self.endpoint=endpoint; self.key=key; self.max_requests=max_requests
        self.timeout=timeout; self.artifact=artifact; self.records=[]; self.lock=threading.Lock()
        self.choices={'role':'implement','complexity':'bounded','risk':'normal','reasoning':'routine',
                      'information':'sufficient','reading':'targeted','failure':'implementation','kind':'reference'}
        self.error_status=0; self.delay=0.; self.server=None; self.thread=None
    @property
    def url(self): return f'http://127.0.0.1:{self.server.server_port}'
    def respond(self,payload):
        answers={}
        for key,q in payload.get('questions',{}).items():
            if q['type']=='noul': answers[key]={'type':'noul','noul':.99}; continue
            if q['type']=='score':
                p={str(i):float(i==0) for i in range(len(q['criteria']))}
                answers[key]={'type':'score','score':0.,'confidence':1.,'probabilities':p,
                              'legend':{str(i):v for i,v in enumerate(q['criteria'])}}; continue
            options=list(q['criteria']); selected=self.choices.get(key)
            if key=='profile': selected=payload.get('state',{}).get('baseline')
            if selected not in options: selected=options[0]
            answers[key]={'type':'choice','choice':selected,'confidence':1.,'probabilities':{o:float(o==selected) for o in options}}
        return {'model':'SYNTHETIC_NOT_JEV','answers':answers,'usage':{'input_tokens':0,'output_tokens':0}}
    def __enter__(self):
        owner=self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                start=time.perf_counter(); status=500; body={'error':'gateway_error'}; payload={}
                try:
                    if self.headers.get('Authorization')!='Bearer '+owner.access_token:
                        self.send_error(401);return
                    length=int(self.headers.get('Content-Length','0'))
                    if self.path!='/v1/systemone' or not 0<length<=524288:
                        self.send_error(400); return
                    payload=json.loads(self.rfile.read(length))
                    with owner.lock:
                        number=len(owner.records)
                        owner.records.append({'index':number,'started_ns':time.time_ns(),'completed':False})
                    if number>=owner.max_requests: status=429; body={'error':'VERIFIER_REQUEST_CAP'}
                    elif owner.error_status: status=owner.error_status; body={'error':'SYNTHETIC_TRANSPORT_FAILURE'}
                    elif owner.synthetic:
                        if owner.delay: time.sleep(owner.delay)
                        status=200; body=owner.respond(payload)
                    else:
                        status,body,_=api_call(owner.endpoint,owner.key,payload,owner.timeout)
                    data=canonical(body).encode()
                    rec={'index':number,'started_ns':owner.records[number]['started_ns'],'completed':True,
                         'source':'SYNTHETIC' if owner.synthetic else 'REAL_UPSTREAM_HTTP',
                         'upstream':owner.endpoint if not owner.synthetic else None,'status':status,
                         'duration_ms':(time.perf_counter()-start)*1000,'request':payload,'response':body}
                    if status==200:
                        try: validate_response(body,payload['questions']);rec['schema_valid']=True
                        except Exception as e: rec['schema_valid']=False;rec['schema_error']=str(e)
                    with owner.lock: owner.records[number]=rec
                    self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
                except (BrokenPipeError,ConnectionResetError): pass
                except Exception as e:
                    if 'number' in locals():
                        with owner.lock: owner.records[number].update(completed=True,source='SYNTHETIC' if owner.synthetic else 'REAL_UPSTREAM_HTTP',status=599,error=type(e).__name__)
                    try:
                        self.send_response(502);self.end_headers();self.wfile.write(b'{"error":"UPSTREAM_UNAVAILABLE"}')
                    except OSError: pass
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler);self.server.daemon_threads=True
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();return self
    def __exit__(self,*args):
        self.server.shutdown();self.server.server_close();self.thread.join(timeout=3)
        if self.artifact: write_json(self.artifact,json.loads(redact(canonical(self.records),[self.key] if self.key else [])))
