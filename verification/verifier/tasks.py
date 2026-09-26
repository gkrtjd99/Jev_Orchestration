"""Independent, fixed acceptance tasks. Tests are never placed in the agent workspace."""
from __future__ import annotations
import json, shutil, re, secrets
from pathlib import Path
from .common import clean_env, run_process, write_private, write_json, tree_manifest, sha

TASKS = [
 dict(id='interval-union', spec='Implement export function mergeIntervals(items) in src/main.mjs. Each item is [start,end] with finite numbers and start<=end. Return sorted disjoint intervals. Merge touching intervals. Never mutate inputs. Empty input gives []. Throw TypeError for malformed input, NaN, Infinity, reversed bounds, or a non-array.',
      initial='export function mergeIntervals(items) { return items; }\n',
      tests="""import {mergeIntervals as f} from './solution/src/main.mjs';
assert.deepEqual(f([]),[]);assert.deepEqual(f([[5,7],[1,3],[3,6],[9,9]]),[[1,7],[9,9]]);
const x=[[3,4],[1,2]];const copy=JSON.stringify(x);f(x);assert.equal(JSON.stringify(x),copy);
for(const v of [null,{},[[3,2]],[[0,Infinity]],[[NaN,2]],[[1]],[[1,2,3]],['x']])assert.throws(()=>f(v),TypeError);
for(let n=1;n<40;n++){const a=Array.from({length:n},(_,i)=>[i*2,i*2+2]);assert.deepEqual(f(a.reverse()),[[0,n*2]]);}
"""),
 dict(id='json-pointer',spec='Implement export function getPointer(value, pointer) in src/main.mjs. RFC6901-style lookup: empty pointer returns value; otherwise starts with /. Decode ~1 as / and ~0 as ~, in one pass; any other ~ escape throws SyntaxError. Traverse own object keys only, no prototype inheritance. Arrays accept 0 or a nonzero decimal with no leading zeros, and in-range indices only. Missing keys, invalid array indices, traversal through scalar return undefined. A non-string pointer or nonempty pointer without / throws TypeError.',
      initial='export function getPointer(value,pointer) { return value[pointer]; }\n',
      tests="""import {getPointer as f} from './solution/src/main.mjs';
const x={'a/b':{'~key':[0,false,null]},'':7,'~1':9};assert.equal(f(x,''),x);assert.equal(f(x,'/'),7);
assert.equal(f(x,'/a~1b/~0key/1'),false);assert.equal(f(x,'/a~1b/~0key/2'),null);assert.equal(f(x,'/~01'),9);
for(const p of ['/a~1b/~0key/01','/a~1b/~0key/-','/a~1b/~0key/3','/a~1b/~0key/-1','/missing'])assert.equal(f(x,p),undefined);
assert.equal(f(Object.create({a:1}),'/a'),undefined);assert.equal(f({},'/toString'),undefined);
assert.throws(()=>f(x,'/~2'),SyntaxError);assert.throws(()=>f(x,'/~'),SyntaxError);
assert.throws(()=>f(x,3),TypeError);assert.throws(()=>f(x,'foo'),TypeError);assert.equal(f(null,'/x'),undefined);
"""),
 dict(id='dependency-order',spec='Implement export function topoOrder(nodes, edges) in src/main.mjs. nodes is an array of unique strings; edges is an array of [before,after] names from nodes. Return a valid topological ordering. At each step choose the lexicographically smallest available node using JS default string ordering. Duplicate edges count once. A cycle throws Error. Invalid input, duplicate nodes, unknown edge endpoints, or non-string nodes throw TypeError. Do not mutate inputs.',
      initial='export function topoOrder(nodes,edges) { return [...nodes].sort(); }\n',
      tests="""import {topoOrder as f} from './solution/src/main.mjs';
assert.deepEqual(f([],[]),[]);assert.deepEqual(f(['c','b','a'],[['c','a']]),['b','c','a']);
assert.deepEqual(f(['a','b'],[['a','b'],['a','b']]),['a','b']);
assert.throws(()=>f(['a','b'],[['a','b'],['b','a']]));assert.throws(()=>f(['a'],[['a','a']]));
for(const args of [[[1],[]],[['a','a'],[]],[['a'],[['a','b']]],[['a'],[['a']]],[null,[]]])assert.throws(()=>f(...args),TypeError);
const n=['c','a','b'],e=[['c','a']];const old=JSON.stringify([n,e]);f(n,e);assert.equal(JSON.stringify([n,e]),old);
"""),
 dict(id='async-pool',spec='Implement export async function mapLimit(items, limit, mapper) in src/main.mjs. Validate an array, a positive integer limit, and a function mapper; otherwise reject with TypeError. Start no more than limit mapper calls concurrently. Call mapper(value,index); preserve output order. On the first observed mapper failure stop scheduling new items; wait for already-started work to settle, then reject with that same error. Empty items returns []. Synchronous mapper throws count as failures. Do not mutate input.',
      initial='export async function mapLimit(items,limit,mapper) { return Promise.all(items.map(mapper)); }\n',
      tests="""import {mapLimit as f} from './solution/src/main.mjs';
let live=0,max=0;const x=[3,1,2,4];const r=await f(x,2,async(v,i)=>{live++;max=Math.max(max,live);await new Promise(r=>setTimeout(r,v*4));live--;return [v*2,i];});
assert.deepEqual(r,[[6,0],[2,1],[4,2],[8,3]]);assert.ok(max<=2);assert.deepEqual(x,[3,1,2,4]);assert.deepEqual(await f([],2,()=>1),[]);
for(const limit of [0,-1,1.5,NaN,Infinity])await assert.rejects(f([1],limit,x=>x),TypeError);
await assert.rejects(f(null,1,x=>x),TypeError);await assert.rejects(f([],1,null),TypeError);
const err=new Error('boom');let started=[],done=false;
await assert.rejects(f([0,1,2,3],2,async(v)=>{started.push(v);if(v===0){await new Promise(r=>setTimeout(r,2));throw err;}await new Promise(r=>setTimeout(r,20));done=true;return v;}),e=>e===err);
assert.deepEqual(started,[0,1]);assert.equal(done,true);
"""),
 dict(id='csv-state-machine',spec='Implement export function parseCSV(text) in src/main.mjs. Parse comma-separated fields, quoted fields, doubled quotes inside quotes, LF and CRLF record separators, and embedded newlines inside quoted fields. Empty text returns []; one final record separator does not add an extra row; interior blank records produce [""]. Preserve whitespace. Quotes may open only at field start; after a closing quote only delimiter, record separator or EOF is allowed. Unterminated quotes, stray quotes, or bare CR outside quotes throw SyntaxError. Non-string input throws TypeError.',
      initial='export function parseCSV(text) { return text.split("\\n").map(r=>r.split(",")); }\n',
      tests="""import {parseCSV as f} from './solution/src/main.mjs';
assert.deepEqual(f(''),[]);assert.deepEqual(f('a,b\\r\\nc,d\\r\\n'),[['a','b'],['c','d']]);
assert.deepEqual(f('"a,b","x""y"\\n"a\\nb",z'),[['a,b','x"y'],['a\\nb','z']]);
assert.deepEqual(f('a,,'),[['a','','']]);assert.deepEqual(f('\\n'),[['']]);assert.deepEqual(f('a\\n\\nb\\n'),[['a'],[''],['b']]);
assert.deepEqual(f(' "x'), (()=>{return 'unreachable'})());
""".replace("assert.deepEqual(f(' \"x'), (()=>{return 'unreachable'})());", "for(const t of [' \\\"x','a\\\"b','\\\"x','\\\"x\\\"z','a\\rb'])assert.throws(()=>f(t),SyntaxError);assert.throws(()=>f(null),TypeError);")),
 dict(id='retry-delays',spec='Implement export function retryDelays(options) in src/main.mjs. options={attempts,baseMs,capMs,jitter,random}. Return attempts delay values for retries i=0..attempts-1, nominal=min(capMs,baseMs*2**i). jitter="none" returns nominal without calling random; jitter="full" returns floor(random()*nominal), calls random once per retry, and requires finite 0<=value<1. attempts integer 0..1000, baseMs and capMs finite nonnegative, jitter only none/full. random defaults to Math.random, must be a function when full. Invalid input throws TypeError. Avoid overflow when baseMs is zero. Do not mutate options.',
      initial='export function retryDelays(o) { return Array(o.attempts).fill(o.baseMs); }\n',
      tests="""import {retryDelays as f} from './solution/src/main.mjs';
assert.deepEqual(f({attempts:5,baseMs:100,capMs:250,jitter:'none'}),[100,200,250,250,250]);
assert.deepEqual(f({attempts:3,baseMs:10,capMs:20,jitter:'full',random:()=>.5}),[5,10,10]);
assert.deepEqual(f({attempts:0,baseMs:1,capMs:9,jitter:'none'}),[]);
assert.equal(f({attempts:1000,baseMs:0,capMs:20,jitter:'none'}).every(v=>v===0),true);
assert.deepEqual(f({attempts:2,baseMs:9,capMs:0,jitter:'none',random:()=>{throw Error('called');}}),[0,0]);
for(const o of [null,{attempts:-1,baseMs:1,capMs:4,jitter:'none'},{attempts:1.5,baseMs:1,capMs:4,jitter:'none'},{attempts:1,baseMs:Infinity,capMs:4,jitter:'none'},{attempts:1,baseMs:1,capMs:4,jitter:'bad'},{attempts:1,baseMs:1,capMs:4,jitter:'full',random:()=>1}])assert.throws(()=>f(o),TypeError);
"""),
 dict(id='cache-expiry',spec='Implement export function createCache(now) in src/main.mjs. now is a supplied function returning milliseconds. Return {set(key,value,ttlMs),get(key),has(key),delete(key),size()}. ttlMs finite nonnegative; expires at now()+ttlMs and is unavailable when now()>=expiry. Zero TTL is immediately expired. Store undefined values distinctly from missing keys using has(). size() removes expired entries before counting. delete() returns true only if a live entry existed. Keys are arbitrary JS Map keys. Invalid clock or TTL throws TypeError. Each operation may call now once; never use Date.now when clock supplied.',
      initial='export function createCache(now) { const m=new Map();return {set:(k,v,t)=>m.set(k,v),get:k=>m.get(k),has:k=>m.has(k),delete:k=>m.delete(k),size:()=>m.size}; }\n',
      tests="""import {createCache as f} from './solution/src/main.mjs';
let t=10;const c=f(()=>t);const obj={};c.set('x',undefined,5);c.set(obj,0,20);assert.equal(c.has('x'),true);assert.equal(c.get('x'),undefined);assert.equal(c.size(),2);
t=15;assert.equal(c.has('x'),false);assert.equal(c.delete('x'),false);assert.equal(c.size(),1);assert.equal(c.get(obj),0);
c.set('z',4,0);assert.equal(c.has('z'),false);assert.equal(c.delete(obj),true);assert.equal(c.delete(obj),false);
c.set('a',1,2);c.set('a',2,20);t=18;assert.equal(c.get('a'),2);t=35;assert.equal(c.size(),0);
assert.throws(()=>f(null),TypeError);for(const n of [-1,NaN,Infinity,'1'])assert.throws(()=>c.set('a',1,n),TypeError);
"""),
 dict(id='stable-pagination',spec='Implement export function paginate(rows, options) in src/main.mjs. rows is an array of objects {id:string,score:finite number}. Sort descending by score and break ties ascending by id using JS default string ordering, without mutating rows or row objects. Reject duplicate ids and malformed rows with TypeError. options={offset,limit}; both nonnegative integers, limit 0..100. Return {items,total,hasMore}; offset beyond end yields empty, total always input count; hasMore=(offset+items.length<total), including zero limit. Invalid options throw TypeError.',
      initial='export function paginate(rows,o) { return {items:rows.slice(o.offset,o.offset+o.limit),total:rows.length,hasMore:false}; }\n',
      tests="""import {paginate as f} from './solution/src/main.mjs';
const a=[{id:'b',score:2},{id:'c',score:3},{id:'a',score:2}];const old=JSON.stringify(a);
assert.deepEqual(f(a,{offset:1,limit:1}),{items:[{id:'a',score:2}],total:3,hasMore:true});assert.equal(JSON.stringify(a),old);
assert.deepEqual(f(a,{offset:4,limit:1}),{items:[],total:3,hasMore:false});assert.equal(f(a,{offset:0,limit:0}).hasMore,true);
for(const opts of [null,{offset:-1,limit:1},{offset:0,limit:101},{offset:1.5,limit:3}])assert.throws(()=>f(a,opts),TypeError);
for(const rows of [null,[{id:'a',score:1},{id:'a',score:2}],[{id:'b',score:NaN}],[{id:4,score:0}]])assert.throws(()=>f(rows,{offset:0,limit:1}),TypeError);
""")
]


def task_by_id(identifier): return next(t for t in TASKS if t['id']==identifier)


def create_workspace(task: dict, project: Path, node: str, env: dict, artifacts: Path):
    write_private(project/'src/main.mjs',task['initial'])
    write_private(project/'README.md','# Acceptance task\n\n'+task['spec']+'\n\nEdit src/*.mjs only. No packages or network required.\n')
    write_private(project/'.gitignore','node_modules/\n')
    for args in [['git','init','-q'],['git','add','.'],['git','-c','user.name=Verifier','-c','user.email=verifier@localhost','commit','-qm','Independent fixture']]:
        p=run_process(args,cwd=project,env=env,timeout=10)
        if p.returncode: raise AssertionError('Fixture git setup failed: '+p.stderr)
    return tree_manifest(project)


def judge(task: dict, project: Path, judge_root: Path, node: str, artifacts: Path):
    judge_root.mkdir(parents=True,exist_ok=True)
    source=project/'src'
    if source.is_symlink(): return {'passed':False,'reason':'SYMLINK_OUTPUT'}
    if not source.is_dir(): return {'passed':False,'reason':'MISSING_SOURCE'}
    solution=judge_root/'solution'
    if solution.exists(): shutil.rmtree(solution)
    for p in source.rglob('*'):
        if p.is_symlink(): return {'passed':False,'reason':'SYMLINK_OUTPUT'}
        if p.is_file():
            if p.stat().st_size>1_000_000:return {'passed':False,'reason':'OVERSIZED_OUTPUT'}
            write_private(judge_root/'solution/src'/p.relative_to(source),p.read_bytes())
    # A constant stdout marker can be forged by the candidate before process.exit(0).
    # Keep the fresh nonce and trusted writer in the harness, loaded BEFORE the solution.
    # Node permissions are an accident barrier, NOT an adversarial-code sandbox.
    nonce=secrets.token_hex(32)
    marker='INDEPENDENT_CHECKS_PASSED:'+nonce
    tests=task['tests']
    def dynamic_import(match):
        names=re.sub(r'\bas\b',':',match.group(1))
        url=(judge_root/match.group(2)).resolve().as_uri()
        return 'const {'+names+'}=await import('+json.dumps(url)+');'
    tests,count=re.subn(r"import\s*\{([^}]+)\}\s*from\s*['\"](\./solution/[^'\"]+)['\"]\s*;?",dynamic_import,tests)
    if not count:return {'passed':False,'reason':'UNSUPPORTED_TEST_IMPORT','details':'Use named imports from ./solution/'}
    test=("import assert from 'node:assert/strict';\n"
          "const trustedWrite=process.stdout.write.bind(process.stdout);\n"
          "Object.freeze(assert);\n"+tests+
          "\ntrustedWrite("+json.dumps('\n'+marker+'\n')+");\n")
    # The harness arrives on stdin, not in argv, env, or an agent-readable source file.
    # Even the report copy omits the nonce. Never expose grading credentials.
    write_private(judge_root/'checks.mjs',task['tests'])
    env=clean_env(judge_root/'empty-home')
    p=run_process([node,'--permission','--allow-fs-read='+str((judge_root/'solution').resolve()),
                   '--input-type=module'],cwd=judge_root,env=env,stdin=test,timeout=15,
                  log_prefix=artifacts/'grade',max_output=1_000_000,pipe_stdin=True)
    proof=p.stdout.splitlines().count(marker)==1
    return {'passed':p.returncode==0 and not p.timed_out and proof,
            'reason':'CHECKS_COMPLETED' if p.returncode==0 and not p.timed_out and proof else 'CHECKS_FAILED_OR_PROOF_MISSING',
            'returncode':p.returncode,'timeout':p.timed_out,'duration_ms':p.duration_ms,
            'completion_proof_observed':proof,'test_sha256':sha(task['tests']),
            'source':'VERIFIER_OWNED_EXTERNAL_TESTS','not_an_llm_judge':True,
            'isolation':'Node resource permissions and separate HOME; not a hostile-code sandbox'}


def validate_suite(tasks):
    assert isinstance(tasks,list) and tasks,'Suite needs tasks'
    seen=set()
    for t in tasks:
        assert set(t)=={'id','spec','initial','tests'},'Task must contain exactly id/spec/initial/tests'
        assert re.fullmatch('[a-z0-9-]{1,64}',t['id']) and t['id'] not in seen,'Invalid/duplicate task id';seen.add(t['id'])
        for key in ('spec','initial','tests'): assert isinstance(t[key],str) and 0<len(t[key])<200000,'Invalid task field'
    return tasks
