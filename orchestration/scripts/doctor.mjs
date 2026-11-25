// Read-only probes. A version or HTTP response is NOT a native routing end-to-end test.
import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {options,readJSON} from '../src/util.mjs';import {loadConfig} from '../src/config.mjs';import {JevClient} from '../src/jev.mjs';
import {profileCatalog} from '../src/catalog.mjs';import {evidenceReadiness} from '../src/feedback.mjs';import {assertInstalledProfile} from '../src/profiles.mjs';
const args=options(process.argv.slice(2));const home=path.resolve(args.home||os.homedir());
const result={native:{},config:null,profiles:{},jev:'not_tested',nativeEndToEnd:'not_tested',effectiveModelAndEffort:'not_observed',performanceSuperiority:'not_established'};
let runtimes=['claude','codex'];
try{
 const file=path.resolve(args.config||path.join(home,'.config','jev-hooks','config.json'));
 const {config,apiKey}=await loadConfig(file);runtimes=config.enabledRuntimes;
 result.config={valid:true,mode:config.mode,hasKey:!!apiKey,allowedProjects:config.allowedProjects,evaluationContext:config.optimization.evaluationContext};
 // Per enabled registry entry: the declared resolved ids and whether evaluation evidence could be imported for it.
 result.evidence=evidenceReadiness(config);
 const manifest=await readJSON(path.join(home,'.config','jev-hooks','installation.json'),null);result.registeredRuntimes=manifest?.runtimes||[];
 for(const rt of runtimes){
  const ps=profileCatalog(config.registry,rt);let checked=0;const errors=[];
  for(const p of ps){for(const project of config.allowedProjects){try{await assertInstalledProfile(config,p,project);checked++;}catch(e){errors.push({profile:p.profileId,project,error:e.code||e.message});}}}
  result.profiles[rt]={declared:ps.length,definitionsChecked:checked,errors,accountAvailability:'not_probed'};
 }
 if(args.live){
  if(!args.yes)throw Object.assign(new Error(),{code:'LIVE_REQUIRES_YES_API_COST'});
  config.safety.allowEgress=true;
  const client=new JevClient(config,apiKey);
  const response=await client.request({text:'A small documentation spelling correction.'},{kind:{type:'choice',instructions:'Choose the category for `text`.',criteria:{documentation:'Documentation edits.',other:'Anything else.'}}});
  result.jev={status:'passed',model:response.model,usage:response.usage||null};
 }
}catch(e){result.error=e.code||'CONFIG_OR_CONNECTION_FAILED';}
for(const cmd of runtimes){
 const p=spawnSync(cmd,['--version'],{encoding:'utf8',timeout:5000});
 result.native[cmd]={installed:!p.error&&p.status===0,version:p.status===0?p.stdout.trim():null,error:p.error?.code||null};
}
console.log(JSON.stringify(result,null,2));
if(result.error||Object.values(result.native).some(x=>!x.installed)||Object.values(result.profiles).some(x=>x.errors.length))process.exitCode=1;
