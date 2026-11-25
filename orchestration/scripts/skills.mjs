// Inspection helper only; it never starts a worker.
// Default (--judge local): offline lexical resolver, no network. It abstains (status 'unavailable',
// code LOCAL_ABSTAIN) when the task shares too few tokens with the catalog to say anything.
// --retrieval lexical|adaptive|full overrides which skills reach the judge (see kernel.skills.retrieval).
// --judge config --config <abs path>: the configured 'delegation.skills' judge chain and decision log,
// which may call a network judge only when that config has consented to it.
import path from 'node:path';
import { assert, options } from '../src/util.mjs';
import {
  DEFAULT_SKILLS_CONFIG, RETRIEVAL_MODES, SKILLS_POINT, loadSkillCatalog, localSkillResolver, selectSkills, whyNot,
} from '../src/kernel/skills.mjs';
import { LocalJudge } from '../src/kernel/judges.mjs';
import { loadConfig } from '../src/config.mjs';
import { createKernel } from '../src/kernel/kernel.mjs';
import { DecisionLog, decisionLogDir } from '../src/kernel/log.mjs';

const JUDGE = 'local-lexical-uncalibrated';
const NOTE = 'Probabilities are a lexical BM25 heuristic, not calibrated judgments.';

try {
  const args = options(process.argv.slice(2));
  for (const key of Object.keys(args)) assert(['project', 'task', 'dirs', 'why-not', 'list', 'judge', 'config', 'retrieval'].includes(key), 'UNKNOWN_OPTION');
  const judgeMode = args.judge ?? 'local';
  assert(judgeMode === 'local' || judgeMode === 'config', 'INVALID_JUDGE');
  assert(args.retrieval === undefined || RETRIEVAL_MODES.includes(args.retrieval), 'INVALID_RETRIEVAL');
  const override = args.retrieval === undefined ? {} : { retrieval: args.retrieval };
  assert(judgeMode === 'config' ? typeof args.config === 'string' && path.isAbsolute(args.config) : args.config === undefined, 'CONFIG_NOT_ABSOLUTE');
  // The configured chain is built once; a bad config fails here before any catalog work.
  let configured = null;
  if (judgeMode === 'config') {
    const { config, apiKey, runtimeEnv } = await loadConfig(args.config);
    const kernel = createKernel(config, {
      apiKey, runtimeEnv, log: new DecisionLog(decisionLogDir(config)),
      localResolvers: { [SKILLS_POINT]: localSkillResolver() },
    });
    configured = { kernel, point: kernel.point(SKILLS_POINT), settings: kernel.kernel.skills };
  }
  assert(typeof args.project === 'string' && path.isAbsolute(args.project), 'PROJECT_NOT_ABSOLUTE');
  const dirs = typeof args.dirs === 'string' ? args.dirs.split(path.delimiter).filter(Boolean) : configured ? [...configured.settings.dirs] : [];
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
    let result, head;
    if (configured) {
      const { kernel, point, settings } = configured;
      // A point that is off yields status 'unavailable' with code KERNEL_POINT_OFF: nothing is judged.
      result = await selectSkills({ task: args.task, catalog, judge: kernel.forPoint(SKILLS_POINT), scope: 'cli', config: { ...settings, ...override } });
      head = { judge: 'config', point: SKILLS_POINT, mode: point.mode, judges: [...point.judges] };
      if (point.judges.includes('local')) head.note = 'Answers from the local judge are a lexical BM25 heuristic, not calibrated judgments.';
    } else {
      const judge = new LocalJudge({ [SKILLS_POINT]: localSkillResolver() });
      result = await selectSkills({ task: args.task, catalog, judge, scope: 'cli', config: { ...DEFAULT_SKILLS_CONFIG, ...override } });
      head = { judge: JUDGE, note: NOTE };
    }
    out = args['why-not'] ? { ...head, whyNot: whyNot(result, args['why-not']) } : { ...head, ...result };
  }
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(e.code || e.message);
  process.exitCode = 1;
}
