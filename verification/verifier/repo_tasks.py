"""Fixed maintenance tasks seeded from the real repository; grader sources stay outside worker projects."""
from __future__ import annotations
import io, os, re, subprocess, sys, tarfile, tempfile
from pathlib import Path
from .common import Blocked, clean_env, run_process, sha, tree_manifest, write_private

LIFECYCLE_FILE='orchestration/src/controller-status.mjs'
EVIDENCE_FILE='verification/verifier/evidence.py'
# The pilot's answer keys and driver never enter a worker or judge snapshot.
GRADER_ONLY_PATHS=frozenset(('verification/verifier/repo_tasks.py','verification/repo_compare.py',
                            'verification/tests/test_repo_tasks.py','verification/tests/test_repo_compare.py'))
LIFECYCLE_FIXED="""    const response=events.find(e=>route&&e.time>=route.time&&e.type==='spawn_observed'&&
      e.taskId===item.toolUseId&&e.agentId===item.agentId&&!e.failed);
    const started=events.find(e=>route&&e.time>=route.time&&e.type==='agent_started'&&e.agentId===item.agentId);
    const stopped=events.find(e=>started&&e.time>=started.time&&e.type==='agent_stopped'&&e.agentId===item.agentId);
    // Synchronous native Agent emits SubagentStop before PostToolUse; response links its agentId to this route.
    assert(route&&response&&started&&stopped,'ACCEPTANCE_WORKER_NOT_OBSERVED');"""
LIFECYCLE_SEED="""    const spawn=events.find(e=>route&&e.time>=route.time&&e.type==='spawn_observed'&&
      e.taskId===item.toolUseId&&e.agentId===item.agentId&&!e.failed);
    const stopped=events.find(e=>spawn&&e.time>=spawn.time&&e.type==='agent_stopped'&&e.agentId===item.agentId);
    assert(route&&spawn&&stopped,'ACCEPTANCE_WORKER_NOT_OBSERVED');"""
EVIDENCE_FIXED="""            # Claude child transcript fields are typed top-level metadata, not prose.
            if row.get('effort') in valid_efforts:efforts.add(row['effort'])
            if isinstance(row.get('agentId'),str) and row['agentId']:agent_ids.add(row['agentId'])"""
EVIDENCE_SEED="""            # A child can report its own effort in prose, but that is not typed runtime evidence."""
TASKS=(
    {'id':'controller-lifecycle','file':LIFECYCLE_FILE,'fixed':LIFECYCLE_FIXED,'seed':LIFECYCLE_SEED,
     'test':'orchestration/test/controller.test.mjs','runtime':'node',
     'goal':'Repair the controller dependency acceptance in this repository. Real synchronous Claude Agent events can arrive as PreToolUse, SubagentStart, SubagentStop, then PostToolUse with agentId. A valid completed worker must be linked to its own route and a successful PostToolUse without requiring PostToolUse before SubagentStop. Do not accept a stop before the route or before a matching start, a failed tool response, or an unlinked agent. Add or preserve meaningful regression tests. Complete the task using normal repository tools; report checks and unresolved limits.'},
    {'id':'child-effort-evidence','file':EVIDENCE_FILE,'fixed':EVIDENCE_FIXED,'seed':EVIDENCE_SEED,
     'test':'verification/tests/test_verifier.py','runtime':'python',
     'goal':'Repair child model/effort evidence extraction in this repository. Claude child JSONL uses typed top-level assistant.effort, assistant.agentId and message.model; worker prose and requested profile values are not observed settings. Preserve Codex typed context behavior and avoid assigning metadata from a different agent. Add or preserve meaningful regression tests. Complete the task using normal repository tools; report checks and unresolved limits.'}
)


def snapshot(root:Path,project:Path):
    """Copy only committed files, not raw logs, untracked secrets or user credentials."""
    root=root.resolve()
    status=subprocess.run(['git','-C',str(root),'status','--porcelain','--untracked-files=no'],capture_output=True,text=True,check=True)
    if status.stdout:raise Blocked('REPOSITORY_DIRTY: commit the audited source before comparing')
    archive=subprocess.run(['git','-C',str(root),'archive','--format=tar','HEAD'],capture_output=True,check=True)
    with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as tar:
        for member in tar:
            if member.name in GRADER_ONLY_PATHS:continue
            destination=project/member.name
            if not destination.resolve().is_relative_to(project.resolve()):raise Blocked('UNSAFE_ARCHIVE_PATH')
            if member.isdir():destination.mkdir(parents=True,exist_ok=True);continue
            if not member.isfile() or member.size>1_000_000:raise Blocked('UNSAFE_ARCHIVE_ENTRY')
            data=tar.extractfile(member).read()
            write_private(destination,data)
            if member.mode&0o111:destination.chmod(0o700)
    commit=subprocess.run(['git','-C',str(root),'rev-parse','HEAD'],capture_output=True,text=True,check=True).stdout.strip()
    return commit


def prepare(root:Path,project:Path,task:dict):
    commit=snapshot(root,project)
    file=project/task['file'];text=file.read_text(encoding='utf-8')
    if text.count(task['fixed'])!=1:raise Blocked('SEED_SOURCE_CHANGED: task is not pinned to this repository revision')
    write_private(file,text.replace(task['fixed'],task['seed']))
    env=clean_env(project/'empty-home')
    for cmd in (['git','init','-q'],['git','add','-A','--','.'],
                ['git','-c','user.name=Verifier','-c','user.email=verifier@localhost','commit','-qm','Seeded maintenance task']):
        p=run_process(cmd,cwd=project,env=env,timeout=15)
        if p.returncode:raise Blocked('FIXTURE_GIT_SETUP_FAILED')
    return {'commit':commit,'goal_sha256':sha(task['goal']),'seed_sha256':sha(file.read_bytes()),
            'trusted_test_sha256':sha((root/task['test']).read_bytes()),'baseline':tree_manifest(project)}


def grade(root:Path,project:Path,task:dict,node:str,artifacts:Path):
    candidate=project/task['file']
    if (not candidate.resolve().is_relative_to(project.resolve()) or candidate.is_symlink()
            or not candidate.is_file() or candidate.stat().st_size>1_000_000):
        return {'passed':False,'reason':'UNSAFE_CANDIDATE'}
    with tempfile.TemporaryDirectory(prefix='jev-repo-grade-') as td:
        judge=Path(td);snapshot(root,judge)
        write_private(judge/task['file'],candidate.read_bytes())
        env=clean_env(judge/'empty-home')
        env['PATH']=str(Path(node).resolve().parent)+os.pathsep+env.get('PATH','')
        if task['runtime']=='node':
            cmd=[node,'--test',str(Path(task['test']).relative_to('orchestration'))];cwd=judge/'orchestration'
        else:
            cmd=[sys.executable,'-m','unittest','discover','-s','tests','-p','test_verifier.py','-v'];cwd=judge/'verification'
        result=run_process([str(x) for x in cmd],cwd=cwd,env=env,timeout=90,
                           log_prefix=artifacts/'grade',max_output=1_000_000)
        tests_ran=(re.search(r'(?m)^Ran ([1-9][0-9]*) tests? in ',result.stderr)
                   if task['runtime']=='python' else re.search(r'(?m)^[#ℹ] tests ([1-9][0-9]*)$',result.stdout))
        return {'passed':result.returncode==0 and not result.timed_out and bool(tests_ran),
                'reported_test_count':int(tests_ran.group(1)) if tests_ran else 0,
                'returncode':result.returncode,'timeout':result.timed_out,'duration_ms':result.duration_ms,
                'test_sha256':sha((root/task['test']).read_bytes()),'source':'TRUSTED_REPOSITORY_TESTS_OUTSIDE_WORKER_PROJECT',
                'not_a_malicious_code_sandbox':True}
