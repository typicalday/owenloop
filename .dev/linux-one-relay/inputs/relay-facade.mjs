import { spawn, ChildProcess } from 'node:child_process';
import { openSync, closeSync, readFileSync, fstatSync, lstatSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fixedCode } from './direct/facade.mjs';
export { fixedCode };
export function requireBound(bound) {
  if(bound.refusal)throw Object.assign(new Error('BOUND_REFUSED'),{code:bound.refusal});
  need(bound.capability);
}
function need(v) { if (!v) throw Object.assign(new Error('FIXTURE'), { code: 'FIXTURE' }); }
function same(a,b) { return ['dev','ino','uid','gid','mode','size','nlink','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]); }
export function loadRelay(artifact, sha) {
  need(process.platform==='linux' && process.versions.node==='22.23.0' && /^[a-f0-9]{64}$/.test(sha));
  let fd,initiatingCode='NOT_APPLICABLE';
  try {
    fd=openSync(artifact,constants.O_RDONLY|constants.O_NOFOLLOW);
    const a=fstatSync(fd,{bigint:true});
    need(a.isFile() && a.nlink===1n && a.size>0n && a.size<=8388608n);
    const bytes=readFileSync(fd);
    need(createHash('sha256').update(bytes).digest('hex')===sha && same(a,fstatSync(fd,{bigint:true})) && same(a,lstatSync(artifact,{bigint:true})));
    const module={exports:{}};process.dlopen(module,`/proc/self/fd/${fd}`);
    need(same(a,fstatSync(fd,{bigint:true})) && same(a,lstatSync(artifact,{bigint:true})));
    return facade(module.exports,artifact,sha);
  } catch(error) {initiatingCode=fixedCode(error);throw error;}
  finally {
    if(fd!==undefined)try{closeSync(fd);}catch{
      /* Uncertain close cannot leave cleanupKnown true or return success.
         Preserve only the fixed initiating category, never the raw error. */
      throw Object.assign(new Error('CLEANUP'),{code:'CLEANUP',initiatingCode});
    }
  }
}
function facade(native,artifact,sha) {
  const pairs=new WeakMap(),channels=new WeakMap(),imports=new WeakMap(),chains=new WeakMap();
  const retainedOriginals=new Set();
  function token(map,v) { const t=Object.freeze({});map.set(t,v);return t; }
  function get(map,t) { need(map.has(t));return map.get(t); }
  function original(kind,output,mode='POSITIVE') {
    let child;
    try {
      const result=native.spawnAndBind(()=>{
        const entry=kind==='TARGET'?'direct/target.mjs':kind==='ROLE'?'role.mjs':'supervisor.mjs';
        const stdio=kind==='TARGET'?['pipe','pipe','pipe']:['pipe','pipe','pipe','ignore',native.senderFD(get(channels,output))];
        child=spawn(process.execPath,[fileURLToPath(new URL(entry,import.meta.url))],{
          detached:false,env:kind==='TARGET'?{}:{JEV_RELAY_ARTIFACT:artifact,JEV_RELAY_SHA:sha,JEV_RELAY_MODE:mode},stdio,
        });
        /* Genuine same-stack spawn only. No arbitrary getter/caller callback
           becomes original authority; native API remains a trusted-source port. */
        retainedOriginals.add(child);monitor(child,stdio.slice(0,3));
        need(Object.getPrototypeOf(child)===ChildProcess.prototype);
        const d=Object.getOwnPropertyDescriptors(child);
        need(Number.isSafeInteger(d.pid?.value) && d.pid.value>0 && d.exitCode?.value===null && d.signalCode?.value===null);
        return child;
      });
      need(result.child===child);
      const capability=token(pairs,result.handle);
      if(kind!=='TARGET') {
        try { native.attributeOwner(get(channels,output),get(pairs,capability)); }
        catch(error) { return Object.freeze({original:child,capability,refusal:fixedCode(error)}); }
      }
      return Object.freeze({original:child,capability});
    } catch(error) {
      /* Preserve already-created child even when pipes/spawn/acquisition fail.
         No cleanup signal or lost original; fixture owner performs normal EOF. */
      if(child)return Object.freeze({original:child,capability:null,refusal:fixedCode(error)});
      throw error;
    }
  }
  return Object.freeze({
    channel:()=>token(channels,native.createChannel()),
    inherited:()=>token(channels,native.inheritedSender()),
    spawnRole:(c,mode)=>{need(['POSITIVE','MALFORMED_FRAME','EXTRA_RIGHTS','TRUNCATED_RIGHTS'].includes(mode));return original('ROLE',c,mode);},spawnSupervisor:c=>original('SUPERVISOR',c),spawnTarget:()=>original('TARGET'),
    sendDirect:(c,p)=>native.sendPair(get(channels,c),get(pairs,p)),
    receiveImported:(c,p)=>token(imports,native.receiveImportedPair(get(channels,c),get(pairs,p))),
    negativeDetail:c=>{const detail=native.chainNegativeDetail(get(channels,c));need(['MALFORMED_FRAME','EXTRA_RIGHTS','CONTROL_TRUNCATED','UNKNOWN'].includes(detail));return detail;},
    sendNegative:(c,p,mode)=>{need(['MALFORMED_FRAME','EXTRA_RIGHTS','TRUNCATED_RIGHTS'].includes(mode));return native.sendNegativeChain(get(channels,c),get(imports,p),mode);},
    sendChain:(c,p)=>native.sendBoundOwnerChain(get(channels,c),get(imports,p)),
    receiveChain:(c,p)=>token(chains,native.receiveBoundOwnerChain(get(channels,c),get(pairs,p))),
    sample:c=>native.sampleBoundOwnerChain(get(chains,c)),
    /* Closed finite negative: ordinary local pair must not be imported. */
    rejectOrdinary:(c,p)=>native.sendBoundOwnerChain(get(channels,c),get(pairs,p)),
    closePair:p=>native.close(get(pairs,p)),closeChannel:c=>native.closeChannel(get(channels,c)),
    closeImported:p=>native.closeRelay(get(imports,p)),closeChain:c=>native.closeRelay(get(chains,c)),
    settle:async child=>{need(retainedOriginals.has(child));return settle(child);},
  });
}
const records=new WeakMap();
function monitor(child,policy) {
  if(records.has(child))return records.get(child);
  let resolve;
  const r={terminal:false,closed:false,bad:false,text:'',bytes:0,waiters:new Set(),pipe:[],eof:[],close:new Promise(v=>{resolve=v;})};
  records.set(child,r);
  const wake=()=>{for(const fn of [...r.waiters])fn();};
  child.on('error',()=>{r.bad=true;wake();});
  child.once('exit',()=>{r.terminal=true;wake();});
  child.once('close',(code,signal)=>{r.terminal=true;r.closed=true;r.code=code;r.signal=signal;wake();resolve();});
  for(let i=0;i<3;i++) {
    const stream=child[['stdin','stdout','stderr'][i]];
    r.pipe[i]=policy[i]==='pipe';r.eof[i]=false;
    if(!r.pipe[i])continue; // intentional ignore/file/inherit requires no invented EOF
    if(!stream){r.bad=true;continue;}
    stream.on('error',()=>{r.bad=true;wake();});
    if(i===0)continue;
    stream.once('end',()=>{r.eof[i]=true;wake();});
    stream.once('close',()=>{if(!r.eof[i])r.bad=true;wake();});
    stream.on('data',b=>{
      r.bytes=Math.min(8193,r.bytes+b.length);
      if(i===2||r.bytes>8192||b.some(v=>v>127))r.bad=true;
      else r.text+=b.toString('ascii');wake();
    });
  }
  return r;
}
export async function fixtureReady(child,word) {
  need(['READY\n','SUPERVISOR_READY\n','ROLE_READY\n'].includes(word));
  const r=records.get(child);need(r && r.pipe[1] && r.waiters.size===0);
  r.readyWord=word;
  let check;
  try {
    await new Promise((resolve,reject)=>{
      check=()=>{
        if(r.bad||r.closed||r.terminal||r.eof[1]||!word.startsWith(r.text))reject(Object.assign(new Error('FIXTURE'),{code:'FIXTURE'}));
        else if(r.text===word)resolve();
      };r.waiters.add(check);check();
    });
  } finally {if(check)r.waiters.delete(check);}
}
async function settle(child) {
  const r=records.get(child);need(r);
  if(!r.closed&&r.pipe[0])try{child.stdin?.end();}catch{r.bad=true;}
  await r.close;
  let nested=[],tests=[];
  const marker='CHILD_RESULT ';
  const at=r.text.indexOf(marker);
  if(at>=0) {
    const raw=r.text.slice(at+marker.length);
    try {
      const value=JSON.parse(raw);
      need(raw===JSON.stringify(value)+'\n' && value && Reflect.ownKeys(value).length===2 && Array.isArray(value.receipts) && value.receipts.length<=3 && Array.isArray(value.tests) && value.tests.length<=1);
      need(r.text.slice(0,at)===r.readyWord);
      for(const t of value.tests)need(t==='LOCAL_SUPERVISOR_MISMATCH_REFUSED');
      for(const v of value.receipts) {
        need(v && Object.getPrototypeOf(v)===Object.prototype && Reflect.ownKeys(v).length===7);
        for(const key of ['terminal','nodeCloseObserved','ownedPipeEOF','pipePolicyValid','cleanupKnown'])need(typeof v[key]==='boolean');
        need(v.terminal && v.nodeCloseObserved && [0,2].includes(v.code) && ['NONE','SIGNAL'].includes(v.signal));
      }
      nested=value.receipts;tests=value.tests;
    } catch {r.bad=true;}
  }
  if(at<0 && r.text!==r.readyWord)r.bad=true;
  return Object.freeze({terminal:r.terminal,nodeCloseObserved:r.closed,code:r.code,signal:r.signal===null?'NONE':'SIGNAL',
    ownedPipeEOF:(!r.pipe[1]||r.eof[1])&&(!r.pipe[2]||r.eof[2]),pipePolicyValid:!r.bad,nested,tests});
}
