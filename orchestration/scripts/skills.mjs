// Inspection helper only: offline skill routing with the lexical resolver. No network, no worker start.
import path from 'node:path';
import { assert, options } from '../src/util.mjs';
import {
  DEFAULT_SKILLS_CONFIG, loadSkillCatalog, localSkillResolver, selectSkills, whyNot,
} from '../src/kernel/skills.mjs';

const JUDGE = 'local-lexical-uncalibrated';
const NOTE = 'Probabilities are a lexical BM25 heuristic, not calibrated judgments.';

try {
  const args = options(process.argv.slice(2));
  for (const key of Object.keys(args)) assert(['project', 'task', 'dirs', 'why-not', 'list'].includes(key), 'UNKNOWN_OPTION');
  assert(typeof args.project === 'string' && path.isAbsolute(args.project), 'PROJECT_NOT_ABSOLUTE');
  const dirs = typeof args.dirs === 'string' ? args.dirs.split(path.delimiter).filter(Boolean) : [];
  assert(args.dirs === undefined || dirs.length, 'INVALID_DIRS');
  assert(dirs.every(d => path.isAbsolute(d)), 'DIR_NOT_ABSOLUTE');
  const catalog = await loadSkillCatalog({ project: args.project, dirs });

  let out;
  if (args.list) {
    out = {
      fingerprint: catalog.fingerprint,
      skills: catalog.skills.map(s => ({ name: s.name, description: s.description.slice(0, 120), relPath: s.relPath, source: s.source })),
      skipped: catalog.skipped,
    };
  } else {
    assert(typeof args.task === 'string' && args.task.trim(), 'MISSING_TASK');
    assert(args['why-not'] === undefined || typeof args['why-not'] === 'string', 'MISSING_SKILL_NAME');
    const resolver = localSkillResolver();
    const judge = {
      evaluate: async (state, questions) => ({ response: { model: 'local-rules', answers: resolver(state, questions) }, cached: false, latencyMs: 0 }),
    };
    const result = await selectSkills({ task: args.task, catalog, judge, scope: 'cli', config: { ...DEFAULT_SKILLS_CONFIG } });
    out = args['why-not'] ? { judge: JUDGE, note: NOTE, whyNot: whyNot(result, args['why-not']) } : { judge: JUDGE, note: NOTE, ...result };
  }
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(e.code || e.message);
  process.exitCode = 1;
}
