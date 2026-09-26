import fs from 'node:fs/promises';
import path from 'node:path';
import { within, hash } from './util.mjs';
const extensions=/\.(md|mdx|rst|txt|adoc|pdf|ya?ml|json)$/i;
export const sensitive=p=>/(^|[\\/])(?:\.env(?:\..*)?|credentials[^/]*|secrets?[^/]*|id_rsa|id_ed25519)(?:$|[\\/])|\.(?:pem|key|p12|pfx)$/i.test(p);
export async function metadata(root,relative,required=false){
  if(sensitive(relative))return null;
  const target=path.resolve(root,relative);if(!within(root,target))return null;
  try{
    const stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink())return null;
    const real=await fs.realpath(target);if(!within(root,real))return null;
    return {path:path.relative(root,real).replaceAll(path.sep,'/'),bytes:stat.size,mtimeMs:stat.mtimeMs,required};
  }catch{return null;}
}
export async function inventory(root,cfg){
  const requiredPaths=[...new Set(['AGENTS.md','CLAUDE.md','.claude/CLAUDE.md',...cfg.requiredDocuments])];
  const docs=[];
  for(const p of requiredPaths){const m=await metadata(root,p,true);if(m)docs.push(m);else if(cfg.requiredDocuments.includes(p))throw Object.assign(new Error('REQUIRED_DOCUMENT_MISSING_OR_UNSAFE'),{code:'REQUIRED_DOCUMENT_MISSING_OR_UNSAFE'});}
  // Only a bounded document inventory is disclosed. No source-file contents or transcript reads.
  const entries=[];
  async function walk(dir,depth){
    if(depth>2||entries.length>=160)return;
    let items;try{items=await fs.readdir(path.join(root,dir),{withFileTypes:true});}catch{return;}
    for(const x of items.sort((a,b)=>a.name.localeCompare(b.name))){
      if(entries.length>=160)break;
      if(x.name.startsWith('.')||x.isSymbolicLink()||sensitive(x.name))continue;
      const p=path.posix.join(dir,x.name);
      if(x.isFile()&&extensions.test(x.name)&&!/(lock|package-lock)\.(json|yaml)$/i.test(x.name))entries.push(p);
      if(x.isDirectory()&&(['docs','doc','specs','spec','adr','design','architecture'].includes(x.name)||dir))await walk(p,depth+1);
    }
  }
  await walk('',0);
  for(const p of entries){if(docs.length>=cfg.maxDocuments)break;if(docs.some(d=>d.path===p))continue;const m=await metadata(root,p);if(m)docs.push(m);}
  return docs;
}
export async function revisionFingerprint(root,docs){
  // Content hashes stay local. Bounded scan detects dirty/untracked edits, not only HEAD.
  // Unknown or too-large snapshots abstain; they never receive a fabricated stable digest.
  const skip=new Set(['.git','.jev','.claude','.codex','.venv','venv','node_modules','__pycache__',
    '.pytest_cache','.next','.nuxt','dist','build','coverage','.cache','.turbo','target']);
  const binary=/\.(?:png|jpe?g|gif|webp|ico|mp[34]|wav|ogg|pdf|zip|gz|tar|woff2?|ttf|otf|exe|dll|so|dylib|pyc)$/i;
  const rows=[];let bytes=0,count=0;
  async function walk(dir){
    const entries=(await fs.readdir(path.join(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
    for(const item of entries){
      if(skip.has(item.name)||sensitive(item.name))continue;
      const relative=path.posix.join(dir,item.name),file=path.join(root,relative);
      if(++count>2500)throw Object.assign(new Error('WORKSPACE_SNAPSHOT_LIMIT'),{code:'WORKSPACE_SNAPSHOT_LIMIT'});
      if(item.isSymbolicLink())throw Object.assign(new Error('WORKSPACE_SYMLINK_REQUIRES_REVIEW'),{code:'WORKSPACE_SYMLINK_REQUIRES_REVIEW'});
      if(item.isDirectory()){await walk(relative);continue;}
      if(!item.isFile())continue;
      const before=await fs.stat(file);
      // Binary assets affect revision through metadata; their bytes are never sent to Jev.
      if(binary.test(item.name)){rows.push([relative,'asset',before.size,before.mtimeMs]);continue;}
      bytes+=before.size;
      if(bytes>16*1024*1024||before.size>2*1024*1024)throw Object.assign(new Error('WORKSPACE_SNAPSHOT_LIMIT'),{code:'WORKSPACE_SNAPSHOT_LIMIT'});
      const content=await fs.readFile(file);const after=await fs.stat(file);
      if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Object.assign(new Error('WORKSPACE_CHANGED_DURING_SNAPSHOT'),{code:'WORKSPACE_CHANGED_DURING_SNAPSHOT'});
      rows.push([relative,hash(content)]);
    }
  }
  await walk('');return hash({files:rows,docs});
}
export async function readDocumentMetadata(root,input){
  const file=input?.file_path ?? input?.path;
  if(typeof file!=='string'||!extensions.test(file)||sensitive(file))return null;
  return metadata(root,path.relative(root,path.resolve(root,file)));
}
