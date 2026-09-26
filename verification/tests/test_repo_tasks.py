from __future__ import annotations
import shutil, subprocess, tempfile, unittest
from pathlib import Path
from verifier.common import Blocked
from verifier.repo_tasks import TASKS, grade, prepare, snapshot

ROOT=Path(__file__).resolve().parents[2]


class RepositoryTaskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node=shutil.which('node')
        if cls.node and '/.asdf/shims/' in cls.node:
            result=subprocess.run(['asdf','which','node'],capture_output=True,text=True)
            if result.returncode==0:cls.node=result.stdout.strip()
        if not cls.node:raise unittest.SkipTest('Node executable not available')
        cls.source_dir=tempfile.TemporaryDirectory(prefix='jev-repo-test-source-')
        cls.repository=Path(cls.source_dir.name)/'source'
        subprocess.run(['git','clone','-q','--no-hardlinks',str(ROOT),str(cls.repository)],check=True)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls,'source_dir'):cls.source_dir.cleanup()

    def test_seed_fails_and_reference_passes_outside_worker_tree(self):
        with tempfile.TemporaryDirectory(prefix='jev-repo-task-test-') as td:
            base=Path(td)
            for task in TASKS:
                with self.subTest(task=task['id']):
                    project=base/task['id'];project.mkdir()
                    prepared=prepare(self.repository,project,task)
                    self.assertEqual(len(prepared['commit']),40)
                    self.assertFalse((project/'verification/verifier/repo_tasks.py').exists())
                    self.assertFalse(grade(self.repository,project,task,self.node,base/'baseline'/task['id'])['passed'])
                    # Worker-supplied tests are not the tests the judge runs.
                    (project/task['test']).write_text('throw new Error("worker-owned test");\n')
                    self.assertFalse(grade(self.repository,project,task,self.node,base/'tampered-seed'/task['id'])['passed'])
                    candidate=project/task['file']
                    candidate.write_text(candidate.read_text().replace(task['seed'],task['fixed']))
                    self.assertTrue(grade(self.repository,project,task,self.node,base/'reference'/task['id'])['passed'])

    def test_candidate_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='jev-repo-symlink-test-') as td:
            base=Path(td);project=base/'worker';project.mkdir()
            task=TASKS[0];prepare(self.repository,project,task)
            candidate=project/task['file'];candidate.unlink()
            candidate.symlink_to(self.repository/task['file'])
            result=grade(self.repository,project,task,self.node,base/'logs')
            self.assertEqual(result['reason'],'UNSAFE_CANDIDATE')

    def test_dirty_tracked_source_cannot_be_archived(self):
        with tempfile.TemporaryDirectory(prefix='jev-repo-dirty-test-') as td:
            base=Path(td);root=base/'root';root.mkdir()
            subprocess.run(['git','init','-q',str(root)],check=True)
            file=root/'source.txt';file.write_text('fixed')
            subprocess.run(['git','-C',str(root),'add','source.txt'],check=True)
            subprocess.run(['git','-C',str(root),'-c','user.name=Test','-c','user.email=test@localhost',
                            'commit','-qm','Baseline'],check=True)
            file.write_text('dirty')
            with self.assertRaises(Blocked):snapshot(root,base/'project')


if __name__=='__main__':unittest.main()
