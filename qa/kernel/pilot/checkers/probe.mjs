#!/usr/bin/env node
// Child process entry: node probe.mjs <taskId> <projectDir> <templateDir>. Prints one JSON object.
// Console output of the project's own code is swallowed so that stdout stays parseable.
import { PROBES } from './probes.mjs';

const [taskId, project, template] = process.argv.slice(2);
const out = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
process.stderr.write = () => true;
let result;
try {
  if (!PROBES[taskId]) throw new Error(`unknown task ${taskId}`);
  result = await PROBES[taskId](project, template);
} catch (error) {
  result = { done: false, convention: null, details: [{ check: 'probe.crashed', ok: false, note: String(error?.message ?? error).slice(0, 200) }], crashed: true };
}
out(JSON.stringify(result) + '\n', () => process.exit(0));
