import os from 'node:os';
import path from 'node:path';
import { options } from '../src/util.mjs';
import { install } from '../src/install.mjs';
try{
  const args=options(process.argv.slice(2));
  if(!args.project)throw new Error('Use --project /absolute/project --runtime both [--env-file /absolute/.env] [--yes]');
  const result=await install({home:path.resolve(args.home||os.homedir()),project:path.resolve(args.project),runtime:args.runtime||'both',yes:args.yes===true,envFile:args['env-file']?path.resolve(args['env-file']):null,mode:args.mode||null,registryFile:args.registry?path.resolve(args.registry):null});
  console.log(JSON.stringify(result,null,2));
  console.log('Restart the existing Claude/Codex session. Inspect /hooks and review/trust the hooks. No trust bypass was installed.');
  console.log('Main model and existing native authentication were NOT changed. Verify role model availability in your account.');
}catch(e){console.error(e.code||e.message);process.exitCode=1;}
