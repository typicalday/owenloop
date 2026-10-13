import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const CODES=Object.freeze(['ARGUMENT','CLOSED','UID','ACCESS','FILESYSTEM','ALLOCATION','NAPI','DEADLINE','SHAPE','CAP','COUNT','STATE','DUPLICATE','IDENTITY','SET_CHANGED','CLEANUP']);
const need=x=>{if(!x)throw new Error('OBSERVER_REFUSED');};
const shape=s=>['dev','ino','uid','gid','mode','size','nlink','mtimeNs','ctimeNs'].map(k=>s[k].toString()).join(':');
export function inertCode(error) {
  try {const d=Object.getOwnPropertyDescriptors(error);return d.code&&Object.hasOwn(d.code,'value')&&CODES.includes(d.code.value)?d.code.value:'UNKNOWN';}
  catch {return 'UNKNOWN';}
}
export function validateObservation(value) {
  need(value!==null&&typeof value==='object'&&!Array.isArray(value));
  const d=Object.getOwnPropertyDescriptors(value), keys=['count','twoPasses','allStatesLive','sameTaskDescriptors','sameProcessIdentity','completeEOF','cleanupKnown'];
  need(Reflect.ownKeys(d).every(k=>typeof k==='string')&&Reflect.ownKeys(d).sort().join(',')===keys.slice().sort().join(','));
  for(const k of keys)need(Object.hasOwn(d[k],'value'));
  need(Number.isSafeInteger(d.count.value)&&d.count.value>=2&&d.count.value<128);
  for(const k of keys.slice(1))need(d[k].value===true);
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
function checked(path, expected, cap=65536) {
  const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const a=fs.fstatSync(fd,{bigint:true});need(a.isFile()&&a.size<=BigInt(cap));
    const hash=crypto.createHash('sha256'),chunks=[];let total=0;
    for(;;){const b=Buffer.alloc(65536),n=fs.readSync(fd,b);if(!n)break;total+=n;need(total<=cap);hash.update(b.subarray(0,n));if(cap===65536)chunks.push(b.subarray(0,n));}
    need(shape(a)===shape(fs.fstatSync(fd,{bigint:true}))&&shape(a)===shape(fs.lstatSync(path,{bigint:true})));
    const digest=hash.digest('hex');need(digest===expected);
    return {fd,stat:a,pin:{sha256:digest,bytes:total},source:cap===65536?new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)):undefined};
  } catch(error){fs.closeSync(fd);throw error;}
}
function still(row,path) {need(shape(row.stat)===shape(fs.fstatSync(row.fd,{bigint:true}))&&shape(row.stat)===shape(fs.lstatSync(path,{bigint:true})));}
function ownInput(path) {
 const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes=Buffer.alloc(0);
 try {for(;;){const b=Buffer.alloc(8192),n=fs.readSync(fd,b);if(!n)break;bytes=Buffer.concat([bytes,b.subarray(0,n)]);need(bytes.length<=65536);}return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
 finally {fs.closeSync(fd);}
}
async function main() {
 need(process.platform==='linux'&&process.version==='v22.23.0'&&process.versions.napi==='10'&&process.arch==='x64');
 const e=process.env;need(e.JEV_JOB==='linux-procfs-observer'&&/^[1-9][0-9]{0,19}$/.test(e.JEV_RUN_ID||'')&&/^[1-9][0-9]{0,5}$/.test(e.JEV_RUN_ATTEMPT||''));
 need(/^[1-9][0-9]{0,9}$/.test(e.JEV_TARGET_PID||''));const pid=Number(e.JEV_TARGET_PID);need(pid<=2147483647);
 const metadataPath=fileURLToPath(new URL('../linux-metadata/metadata.mjs',import.meta.url));
 const addonPath=process.argv[2];let dep,artifact,handle,backend,result,closed=false,hooks,frame,stage='METADATA_BINDING';
 try {
  dep=checked(metadataPath,e.JEV_METADATA_DEP_SHA);stage='ARTIFACT_BINDING';artifact=checked(addonPath,e.JEV_ADDON_SHA,8388608);
  const metadataURL=pathToFileURL(metadataPath).href;
  stage='METADATA_LOAD';hooks=registerHooks({load(url,context,nextLoad){
   if(url===metadataURL)return {format:'module',source:dep.source,shortCircuit:true};
   need(url.startsWith('node:'));return nextLoad(url,context);
  }});
  // Exact hash-verified FD bytes, with the reviewed file URL/import.meta guard.
  const metadata=await import(metadataURL);hooks.deregister();hooks=undefined;still(dep,metadataPath);
  stage='OWN_METADATA';need(fs.statfsSync('/proc/self',{bigint:true}).type===0x9fa0n);
  const own={kernel:metadata.kernelProjection(os.release()),credentials:metadata.statusProjection(ownInput('/proc/self/status')),
    procfs:metadata.mountProjection(ownInput('/proc/self/mountinfo')),
    namespaces:['pid','mnt','user'].map(k=>metadata.namespaceProjection(k,fs.readlinkSync(`/proc/self/ns/${k}`),fs.readlinkSync(`/proc/self/ns/${k}`)))};
  need(own.credentials.uid.fourEqual&&own.credentials.uid.allNonzero&&own.credentials.gid.fourEqual&&own.credentials.gid.allNonzero);
  stage='ARTIFACT_LOAD';still(artifact,addonPath);const module={exports:{}};need(Number.isInteger(os.constants.dlopen.RTLD_NOW));
  process.dlopen(module,`/proc/self/fd/${artifact.fd}`,os.constants.dlopen.RTLD_NOW);backend=module.exports;still(artifact,addonPath);
  need(Object.getOwnPropertyNames(backend).sort().join(',')==='acquire,close,sample');
  stage='API_NEGATIVE';const rejected=[];
  for(const [name,call,code] of [['zero',()=>backend.acquire(0),'ARGUMENT'],['null',()=>backend.acquire(null),'ARGUMENT'],['forged-handle',()=>backend.sample({}),'CLOSED']]){
   let seen=false;try {call();}catch(error){need(inertCode(error)===code);seen=true;}need(seen);rejected.push(name);}
  stage='NATIVE_ACQUIRE';handle=backend.acquire(pid);stage='NATIVE_SAMPLE';result=validateObservation(backend.sample(handle));stage='NATIVE_CLOSE';need(backend.close(handle)===true);closed=true;
  stage='CLOSED_HANDLE_CHECK';let refused=false;try {backend.sample(handle);}catch(error){need(inertCode(error)==='CLOSED');refused=true;}need(refused);rejected.push('closed-handle');
  stage='SOURCE_RECHECK';still(artifact,addonPath);still(dep,metadataPath);
  frame={protocol:'jev-linux-procfs-observer-result-v2',status:'SUPPORTED_ENDPOINT_OBSERVATION',
   job:'linux-procfs-observer',runId:e.JEV_RUN_ID,runAttempt:e.JEV_RUN_ATTEMPT,
   node:{version:'22.23.0',napi:10,architecture:'X86_64',provenance:'OBSERVED_EXECUTABLE_UNVERIFIED_DISTRIBUTION'},
   own,observation:result,negativeControls:rejected,artifact:artifact.pin,
   originalAuthority:'LIVE_UNREAPED_ORIGINAL_OWNER_REQUIRED',continuousCoverage:false,atomicCoverage:false,
   darwinEquivalence:false,providerAccessQualified:false,recoveryAccepted:false};
 } catch(error) {
  // No raw errors, status rows, identifiers or paths reach the fixed channel.
  const code=inertCode(error);frame={protocol:'jev-linux-procfs-observer-result-v2',status:'UNSUPPORTED',refusal:code,stage,recoveryAccepted:false};process.exitCode=2;
 } finally {
  let cleanupFailed=false;
  if(hooks){try {hooks.deregister();}catch {cleanupFailed=true;process.exitCode=2;}}
  if(handle&&!closed){try {need(backend.close(handle)===true);}catch {cleanupFailed=true;process.exitCode=2;}}
  for(const row of [artifact,dep])if(row){try {fs.closeSync(row.fd);}catch {cleanupFailed=true;process.exitCode=2;}}
  if(cleanupFailed)frame={protocol:'jev-linux-procfs-observer-result-v2',status:'UNSUPPORTED',refusal:'CLEANUP',stage:'CLEANUP',recoveryAccepted:false};
 }
 stage='RESULT_EMIT';process.stdout.write(JSON.stringify(frame)+'\n');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try {await main();}catch {process.stderr.write('LINUX_OBSERVER_REFUSED\n');process.exitCode=2;}
}
