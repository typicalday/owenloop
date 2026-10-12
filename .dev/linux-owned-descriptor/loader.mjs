import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const expected={"fixture.mjs":"e716596073a884c8f74c5329767fe0f4b2c8219626db228f6844407db1b64dff","facade.mjs":"cc5f99facf421991448ad4ec2a78154b806529d1a34ec832bcd9796984848d91","target.mjs":"f0f7e6793b7bd3af72e65f9a3d4047775401f52f6f99c72aaa5f6dc44c69910a","nested-owner.mjs":"c4729ad7e3bb62fc2139a8816fc3a9d92d8acdd00d175fe1af77833b1ae6e77f","metadata.mjs":"e1c31a4c7f6fa05b58d08f5c5d18109397a48ea079a39dce7bb4667cca966a8b"};
const roles=['fixture.mjs','target.mjs','nested-owner.mjs'];
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
  const entry=fileURLToPath(entryURL),directory=path.dirname(entry),role=path.basename(entry);
  need(roles.includes(role)&&directory===path.dirname(fileURLToPath(import.meta.url)));
  const held=[],mapping=new Map();let hook;let failed=false;
  try{
    for(const [name,sha] of Object.entries(expected)){
      const input=path.join(directory,'verified',name),h=acquire(input,sha,65536);held.push(h);
      const url=pathToFileURL(path.join(directory,name)).href;
      if(roles.includes(name))mapping.set(url+'?jevExactV3=1',h.bytes);
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
      writeOwn(process.env.JEV_OWN_METADATA_PATH,process.env.JEV_DESCRIPTOR_ARTIFACT,{
        protocol:'jev-owned-pair-own-metadata-v1',platform:'LINUX',architecture:process.arch==='x64'?'X86_64':'ARM64',
        kernel:m.kernelProjection(os.release()),credentials,procfs,namespaces,
        node:{version:'22.23.0',napi:10,sha256:digest(image.bytes),bytes:image.bytes.length,provenance:'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'},
        priorJobPermissionTransferred:false,continuousCoverage:false,providerAccessQualified:false,recoveryAccepted:false
      });
    }
    await import(pathToFileURL(entry).href+'?jevExactV3=1');
    for(const h of held)need(same(h.initial,fs.fstatSync(h.fd,{bigint:true}))&&same(h.initial,fs.lstatSync(h.path,{bigint:true})));
  }catch(error){failed=true;throw error;}
  finally{
    let cleanup=true;
    if(hook)try{hook.deregister();}catch{cleanup=false;}
    for(const h of held)try{fs.closeSync(h.fd);}catch{cleanup=false;}
    if(!cleanup&&!failed)throw new Error('ENTRY_REFUSED');
  }
}
