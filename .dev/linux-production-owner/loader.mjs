// This loader is a separately pinned first-entry platform trust boundary.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
function need(v){if(!v)throw Object.assign(new Error('SOURCE_REFUSED'),{code:'SHAPE'});}
function same(a,b){return ['dev','ino','uid','gid','mode','size','nlink','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);}
export function readFixed(relative,cap=65536){
 need(typeof relative==='string'&&!path.isAbsolute(relative)&&!relative.split('/').includes('..'));
 const p=path.join(root,relative);let fd,failed=false,value;
 try{
  fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const a=fs.fstatSync(fd,{bigint:true});need(a.isFile()&&a.nlink===1n&&a.uid===BigInt(process.getuid())&&a.size>=0n&&a.size<=BigInt(cap));
  const b=Buffer.alloc(Number(a.size)+1);let n=0;
  while(n<b.length){const k=fs.readSync(fd,b,n,b.length-n,null);if(!k)break;n+=k;}
  need(n===Number(a.size)&&same(a,fs.fstatSync(fd,{bigint:true}))&&same(a,fs.lstatSync(p,{bigint:true})));
  value=b.subarray(0,n);
 }catch(e){failed=true;value=e;}
 if(fd!==undefined)try{fs.closeSync(fd);}catch{throw Object.assign(new Error('SOURCE_CLEANUP'),{code:'CLEANUP'});}
 if(failed)throw value;return value;
}
export function jsonFixed(relative){
 const raw=readFixed(relative,1048576),v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
 need(Buffer.from(JSON.stringify(v)+'\n').equals(raw));return v;
}
export function writeFixed(relative,value){
 need(['entry-results/ready.json','entry-results/positive.json','entry-results/parse.json','own-metadata.json'].includes(relative));
 const raw=Buffer.from(JSON.stringify(value)+'\n');need(raw.length<=65536);
 const fd=fs.openSync(path.join(root,relative),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 let failed=false;
 try{let n=0;while(n<raw.length){const k=fs.writeSync(fd,raw,n,raw.length-n);need(k>0);n+=k;}fs.fsyncSync(fd);}catch(e){failed=e;}
 try{fs.closeSync(fd);}catch{throw Object.assign(new Error('SOURCE_CLEANUP'),{code:'CLEANUP'});}
 if(failed)throw failed;
}
let hook;
export function install(){
 need(process.platform==='linux'&&process.versions.node==='22.23.0'&&typeof registerHooks==='function'&&!hook);
 const closure=jsonFixed('runtime-closure.json');need(closure.protocol==='jev-production-runtime-closure-v1'&&closure.files.length<=16384);
 const rows=new Map();for(const r of closure.files){need(Object.keys(r).sort().join(',')==='bytes,format,relative,sha256');need(typeof r.relative==='string'&&!r.relative.startsWith('/')&&!r.relative.split('/').includes('..')&&!rows.has(r.relative));need(/^[a-f0-9]{64}$/.test(r.sha256)&&Number.isSafeInteger(r.bytes)&&r.bytes>=0&&r.bytes<=536870912&&['module','commonjs','json'].includes(r.format));rows.set(r.relative,r);}
 let loadedBytes=0;
 hook=registerHooks({load(url,ctx,next){
  if(url.startsWith('node:'))return next(url,ctx);
  const parsed=new URL(url);need(parsed.protocol==='file:'&&!parsed.search&&!parsed.hash);
  const absolute=fileURLToPath(parsed),rel=path.relative(root,absolute).split(path.sep).join('/');need(absolute===path.join(root,rel));
  const r=rows.get(rel);need(r);const raw=readFixed(rel,16777216);loadedBytes+=raw.length;need(loadedBytes<=33554432);
  need(raw.length===r.bytes&&crypto.createHash('sha256').update(raw).digest('hex')===r.sha256);
  return {format:r.format,source:raw,shortCircuit:true};
 }});
}
export function uninstall(){if(hook){hook.deregister();hook=undefined;}}
export function binding(){return jsonFixed('binding.json');}
export function fixed(error){try{const d=Object.getOwnPropertyDescriptor(error,'code');if(d&&Object.hasOwn(d,'value')&&typeof d.value==='string'&&['ACCESS','ALLOCATION','ARGUMENT','CAP','CHANNEL','CLEANUP','CLOSED','COUNT','DEADLINE','DUPLICATE','FILESYSTEM','IDENTITY','NAPI','OWNERSHIP','PAIR','SET_CHANGED','SHAPE','STATE','UID','UNSUPPORTED','UNKNOWN','FIXTURE'].includes(d.value))return d.value;}catch{}return 'UNKNOWN';}

export async function measureOwn(){
 const m=await import('./metadata.mjs');
 function ownRead(p){let fd,result,failed=false;try{fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const chunks=[];let n=0;for(;;){const b=Buffer.alloc(8192),k=fs.readSync(fd,b);if(!k)break;n+=k;need(n<=65536);chunks.push(b.subarray(0,k));}result=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch(e){failed=e;}if(fd!==undefined)try{fs.closeSync(fd);}catch{throw Object.assign(new Error('OWN_CLEANUP'),{code:'CLEANUP'});}if(failed)throw failed;return result;}
 const credentials=m.statusProjection(ownRead('/proc/self/status'));need(credentials.uid.fourEqual&&credentials.gid.fourEqual&&credentials.uid.allNonzero&&credentials.gid.allNonzero);
 const procfs=m.mountProjection(ownRead('/proc/self/mountinfo'));need(fs.statfsSync('/proc/self',{bigint:true}).type===0x9fa0n);
 const namespaces=['pid','mnt','user'].map(k=>m.namespaceProjection(k,fs.readlinkSync('/proc/self/ns/'+k),fs.readlinkSync('/proc/self/ns/'+k)));
 const image=readFixed('node',536870912),b=binding();need(crypto.createHash('sha256').update(image).digest('hex')===b.nodeSha256);
 const os=await import('node:os');
 writeFixed('own-metadata.json',{protocol:'jev-production-owner-own-metadata-v1',platform:'LINUX',architecture:process.arch==='x64'?'X86_64':'ARM64',kernel:m.kernelProjection(os.release()),credentials,procfs,namespaces,node:{version:'22.23.0',napi:10,sha256:b.nodeSha256,bytes:image.length,provenance:'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'},priorJobPermissionTransferred:false,continuousCoverage:false,providerAccessQualified:false,recoveryAccepted:false});
}
