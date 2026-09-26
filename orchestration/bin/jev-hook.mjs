#!/usr/bin/env node
// Lifecycle entrypoint only. It NEVER starts a Claude/Codex worker or a main-agent loop.
import { options } from '../src/util.mjs';
import { loadConfig } from '../src/config.mjs';
import { handleHook } from '../src/hooks.mjs';
const watchdog=setTimeout(()=>{process.stderr.write('jev-hooks: HOOK_DEADLINE; native runtime owns timeout policy\n');process.exit(1);},7000);
try{
  const args=options(process.argv.slice(2));
  let bytes=0;const chunks=[];
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>1048576)throw Object.assign(new Error(),{code:'HOOK_INPUT_TOO_LARGE'});chunks.push(chunk);}
  const event=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const deps=await loadConfig(args.config);
  const output=await handleHook(event,args.runtime,deps);
  process.stdout.write(JSON.stringify(output)+'\n');
}catch(e){
  const code=/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'HOOK_INPUT_OR_CONFIG_ERROR';
  process.stderr.write(`jev-hooks: ${code}; no native worker executed by extension\n`);
  process.stdout.write('{}\n');
  process.exitCode=1;
}finally{clearTimeout(watchdog);}
