import os from 'node:os';import path from 'node:path';
import { options } from '../src/util.mjs';import { uninstall } from '../src/install.mjs';
try{const a=options(process.argv.slice(2));console.log(JSON.stringify(await uninstall(path.resolve(a.home||os.homedir()),a.yes===true),null,2));}
catch(e){console.error(e.code||e.message);process.exitCode=1;}
