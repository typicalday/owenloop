import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const expected={"fixture.mjs":"c1d889469c4349183e4920f42e02846d8ba86315b7695d1ed6b444acfd49da05","role.mjs":"643835d2d5533f8aa127df7f250bfa27e7dda25de900985b23a1d4f4ecbc585c","supervisor.mjs":"599a4e90d65faa2a3881ab5cddc7e0b112a963c725375244127efe55200ca10b","relay-facade.mjs":"110de79bbaf86a3bf5b674056571147bed0c81bef0d5c9032ee3b03625806bba","direct/facade.mjs":"bc091781b1744524cdef7d17441cf9c34fa88c6eb5f045fe80ebaf8fa6f94e69","direct/target.mjs":"f0f7e6793b7bd3af72e65f9a3d4047775401f52f6f99c72aaa5f6dc44c69910a","metadata.mjs":"e1c31a4c7f6fa05b58d08f5c5d18109397a48ea079a39dce7bb4667cca966a8b"};
const roles=['fixture.mjs','role.mjs','supervisor.mjs','direct/target.mjs'];
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function need(v){if(!v)throw new Error('ENTRY_REFUSED');}
function same(a,b){return ['dev','ino','uid','gid','mode','size','nlink','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);}
function acquire(p,sha,cap){
  let fd;
  try{
    fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const a=fs.fstatSync(fd,{bigint:true});need(a.isFile()&&a.nlink===1n&&a.size>0n&&a.size<=BigInt(cap));
    const chunks=[];let n=0;
    while(true){const b=Buffer.alloc(8192),k=fs.readSync(fd,b);if(!k)break;n+=k;need(n<=cap);chunks.push(b.subarray(0,k));}
    const bytes=Buffer.concat(chunks);need(digest(bytes)===sha&&same(a,fs.fstatSync(fd,{bigint:true}))&&same(a,fs.lstatSync(p,{bigint:true})));
    return {fd,bytes,initial:a,path:p};
  }catch(error){if(fd!==undefined)try{fs.closeSync(fd);}catch{}throw error;}
}
function ownRead(p){
  const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const chunks=[];let n=0;
    while(true){const b=Buffer.alloc(8192),k=fs.readSync(fd,b);if(!k)break;n+=k;need(n<=65536);chunks.push(b.subarray(0,k));}
    return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  }finally{fs.closeSync(fd);}
}
function writeOwn(meta,artifact,value){
  need(typeof meta==='string'&&path.isAbsolute(meta)&&path.basename(meta)==='own-metadata.json');
  need(path.dirname(meta)===path.dirname(path.dirname(artifact)));
  const raw=Buffer.from(JSON.stringify(value)+'\n');need(raw.length<=65536);
  const fd=fs.openSync(meta,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{let at=0;while(at<raw.length){const n=fs.writeSync(fd,raw,at,raw.length-at);need(n>0);at+=n;}fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
}
export async function runVerified(entryURL){
  need(process.platform==='linux'&&process.versions.node==='22.23.0'&&process.versions.napi==='10');
  need(typeof registerHooks==='function'&&['x64','arm64'].includes(process.arch));
  const entry=fileURLToPath(entryURL),directory=path.dirname(fileURLToPath(import.meta.url)),role=path.relative(directory,entry).split(path.sep).join('/');
  need(roles.includes(role)&&entry===path.join(directory,role));
  const held=[],mapping=new Map();let hook;let failed=false;
  try{
    for(const [name,sha] of Object.entries(expected)){
      const input=path.join(directory,'verified',name),h=acquire(input,sha,65536);held.push(h);
      const url=pathToFileURL(path.join(directory,name)).href;
      if(roles.includes(name))mapping.set(url+'?jevExactOneRelayV1=1',h.bytes);
      else mapping.set(url,h.bytes);
    }
    hook=registerHooks({load(url,context,nextLoad){
      if(mapping.has(url))return {format:'module',source:mapping.get(url),shortCircuit:true};
      need(url.startsWith('node:'));return nextLoad(url,context);
    }});
    if(role==='fixture.mjs'){
      const m=await import(pathToFileURL(path.join(directory,'metadata.mjs')).href);
      const credentials=m.statusProjection(ownRead('/proc/self/status'));
      need(credentials.uid.fourEqual&&credentials.gid.fourEqual&&credentials.uid.allNonzero&&credentials.gid.allNonzero);
      const procfs=m.mountProjection(ownRead('/proc/self/mountinfo'));
      need(fs.statfsSync('/proc/self',{bigint:true}).type===0x9fa0n);
      const namespaces=['pid','mnt','user'].map(kind=>m.namespaceProjection(kind,fs.readlinkSync(`/proc/self/ns/${kind}`),fs.readlinkSync(`/proc/self/ns/${kind}`)));
      const image=acquire(process.execPath,process.env.JEV_NODE_IMAGE_SHA,512*1024*1024);held.push(image);
      writeOwn(process.env.JEV_OWN_METADATA_PATH,process.env.JEV_RELAY_ARTIFACT,{
        protocol:'jev-one-relay-own-metadata-v1',platform:'LINUX',architecture:process.arch==='x64'?'X86_64':'ARM64',
        kernel:m.kernelProjection(os.release()),credentials,procfs,namespaces,
        node:{version:'22.23.0',napi:10,sha256:digest(image.bytes),bytes:image.bytes.length,provenance:'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'},
        priorJobPermissionTransferred:false,continuousCoverage:false,providerAccessQualified:false,recoveryAccepted:false
      });
    }
    await import(pathToFileURL(entry).href+'?jevExactOneRelayV1=1');
    for(const h of held)need(same(h.initial,fs.fstatSync(h.fd,{bigint:true}))&&same(h.initial,fs.lstatSync(h.path,{bigint:true})));
  }catch(error){failed=true;throw error;}
  finally{
    let cleanup=true;
    if(hook)try{hook.deregister();}catch{cleanup=false;}
    for(const h of held)try{fs.closeSync(h.fd);}catch{cleanup=false;}
    if(!cleanup&&!failed)throw new Error('ENTRY_REFUSED');
  }
}
