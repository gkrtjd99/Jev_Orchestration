import os from 'node:os';import path from 'node:path';
import {options,assert} from '../src/util.mjs';import {loadConfig,projectFor} from '../src/config.mjs';import {SessionStore} from '../src/state.mjs';
try{
 const a=options(process.argv.slice(2));assert(typeof a.session==='string'&&typeof a.project==='string','SESSION_AND_PROJECT_REQUIRED');assert(['claude','codex'].includes(a.runtime),'RUNTIME_REQUIRED');
 const {config}=await loadConfig(path.resolve(a.config||path.join(os.homedir(),'.config','jev-hooks','config.json')));
 const project=await projectFor(config,path.resolve(a.project));assert(project,'PROJECT_NOT_ENABLED');
 const store=new SessionStore(config,project,a.runtime,a.session);
 console.log(JSON.stringify(a.task?await store.getTask(a.task):await store.snapshot(),null,2));
}catch(e){console.error(e.code||e.message);process.exitCode=1;}
