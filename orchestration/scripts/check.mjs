import fs from 'node:fs/promises';import path from 'node:path';import {spawnSync} from 'node:child_process';
let count=0;
for(const dir of ['src','bin','scripts','test'])for(const name of (await fs.readdir(dir,{recursive:true})).sort()){
  if(!name.endsWith('.mjs'))continue;
  const r=spawnSync(process.execPath,['--check',path.join(dir,name)],{encoding:'utf8'});
  if(r.status!==0){process.stderr.write(r.stderr);process.exit(1);}count++;
}
console.log(JSON.stringify({syntaxModules:count,status:'passed'}));
