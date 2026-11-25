import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { options, assert } from '../src/util.mjs';
import { loadConfig } from '../src/config.mjs';
import { importEvaluations, evidenceReport } from '../src/feedback.mjs';
try {
  const args=options(process.argv.slice(2));
  assert(args.file||args.report===true,'Use --file independent-evaluations.jsonl --accept-evidence [--config /absolute/config.json] | --report [--config /absolute/config.json]');
  const {config}=await loadConfig(path.resolve(args.config||path.join(os.homedir(),'.config','jev-hooks','config.json')));
  // Read-only: stored rows by profile and by how the effective model was accepted (exact | declared), current or stale.
  if(args.report===true){assert(!args.file,'REPORT_TAKES_NO_FILE');console.log(JSON.stringify(await evidenceReport(config),null,2));}
  else{
  const text=await fs.readFile(path.resolve(args.file),'utf8');assert(Buffer.byteLength(text)<=10000000,'EVIDENCE_INPUT_TOO_LARGE');
  const rows=text.trim().startsWith('[')?JSON.parse(text):text.trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
  console.log(JSON.stringify(await importEvaluations(config,rows,{acceptEvidence:args['accept-evidence']===true}),null,2));
  }
}catch(e){console.error(e.code||e.message);process.exitCode=1;}
