import { install,binding,jsonFixed,readFixed,fixed,uninstall,measureOwn } from './loader.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
install();
await measureOwn();
const b=binding();
const {createRoutedOwnerOuterObserver,outerOwnerObserverStatus}=await import('./dist/packages/work/src/harness/routed-owner-observer.js');
const {createDefaultSpawner,sampleRetainedChildOwner,retainedChildOwnerObserverStatus,closeRetainedChildOwnerObserver}=await import('./dist/packages/work/src/shift/spawn.js');
const cases=[],roles=[];let interrupted=false;process.on('SIGTERM',()=>{interrupted=true;});process.on('SIGINT',()=>{interrupted=true;});let stage='LOAD',code='NOT_APPLICABLE',cleanup=true,sample=null,positive=null,parse=null,notification=null;
function need(v){if(!v)throw Object.assign(new Error('FIXTURE'),{code:'FIXTURE'});}
const deadline=b.fixtureDeadlineUnixMs;
function left(){need(!interrupted&&Number.isSafeInteger(deadline)&&Date.now()<deadline);return deadline-Date.now();}
async function terminal(ended){const remaining=left();let t;try{return await Promise.race([ended,new Promise((_,reject)=>{t=setTimeout(()=>reject(Object.assign(new Error('DEADLINE'),{code:'DEADLINE'})),remaining);})]);}finally{if(t!==undefined)clearTimeout(t);}}
async function record(relative){for(;;){left();try{return jsonFixed(relative);}catch(e){if(e?.code!=='ENOENT')throw e;}await sleep(Math.min(10,left()));}}
function gate(which){const token=crypto.randomBytes(16).toString('hex');const p=path.join(b.gateDirectory,'.'+token+'.gate');fs.writeFileSync(p,'closed',{flag:'wx',mode:0o600});return {token,path:p,handoff:path.join(b.gateDirectory,which+'.handoff')};}
async function runRole(observer,which){
 const g=gate(which);let exitResolve,terminal=false;
 const ended=new Promise(r=>{exitResolve=r;});let entered=false;
 const spawn=createDefaultSpawner('https://invalid.invalid','harmless',which==='positive'?b.roleEntry:b.privateEntry,undefined,()=>{},undefined,undefined,r=>{terminal=true;exitResolve({code:r.exitStatus,signal:r.signal===null?'NONE':'SIGNAL'});},observer);
 const r=spawn({workflow:which==='positive'?'harmless':'',run:which,kind:'agent-run',startGate:g.path,routingHandoff:g.handoff,dispatchToken:g.token,onGateEntered(){entered=true;},canAllowGateEntry:()=>!terminal,onTerminal(){}});
 need(r.custody&&r.armGateEntry);roles.push({observer,custody:r.custody,ended,cancel:r.cancel,terminal:()=>terminal});
 r.armGateEntry();fs.writeFileSync(g.path,'start',{flag:'w',mode:0o600});return {r,ended,entered:()=>entered};
}
try{
 need(b.protocol==='jev-production-binding-v1'&&b.enabled===true&&process.versions.node==='22.23.0');
 stage='POSITIVE';const outer=createRoutedOwnerOuterObserver(b.artifact,b.artifactSha256),role=await runRole(outer,'positive');
 const note=await record('entry-results/ready.json');notification=note;need(Object.keys(note).sort().join(',')==='afterManagedReady,protocol,sourceOwned,workIssued'&&note.protocol==='jev-production-role-notification-v1'&&note.sourceOwned===true&&note.afterManagedReady===true&&note.workIssued===true&&role.entered());
 left(); // Exactly one collection attempt. No terminal PID or sample retry.
 sample=sampleRetainedChildOwner(outer,role.r.custody);
 const d=Object.getOwnPropertyDescriptors(sample),k=Reflect.ownKeys(d);need(k.length===7&&k.every(x=>typeof x==='string')&&k.sort().join(',')==='allStatesLive,cleanupKnown,completeEOF,count,sameProcessIdentity,sameTaskDescriptors,twoPasses');
 for(const key of k)need(Object.hasOwn(d[key],'value'));
 need(Number.isInteger(d.count.value)&&d.count.value>=2&&d.count.value<128);
 for(const key of k.filter(x=>x!=='count'))need(d[key].value===true);
 sample={count:d.count.value,twoPasses:true,allStatesLive:true,sameTaskDescriptors:true,sameProcessIdentity:true,completeEOF:true,cleanupKnown:true};
 positive=await record('entry-results/positive.json');if(positive.code==='CLEANUP')throw Object.assign(new Error('CLEANUP'),{code:'CLEANUP'});
 need(positive.protocol==='jev-production-role-terminal-v1'&&positive.status==='SUPPORTED'&&positive.fd4Adopted===true&&positive.workComplete===true&&positive.cleanupKnown===true&&positive.normalRecoveryAccepted===false);
 need(positive.settlement?.scope==='original-posix-group'&&positive.settlement.state==='empty'&&positive.settlement.reason==='normal-exit:group-absent');
 const exited=await terminal(role.ended);need(exited.code===0&&exited.signal==='NONE');
 closeRetainedChildOwnerObserver(outer,role.r.custody);need(retainedChildOwnerObserverStatus(outer,role.r.custody).refusal===null&&outerOwnerObserverStatus(outer).refusal===null);
 cases.push('CURRENT_PRODUCTION_MANAGED_OWNER_SEAM');
 stage='PRIVATE_PARSE';const parseOuter=createRoutedOwnerOuterObserver(b.artifact,b.artifactSha256),pr=await runRole(parseOuter,'parse');
 parse=await record('entry-results/parse.json');if(parse.refusal==='CLEANUP')throw Object.assign(new Error('CLEANUP'),{code:'CLEANUP'});need(Object.keys(parse).sort().join(',')==='cleanupKnown,fd4Adopted,normalRecoveryAccepted,protocol,providerStarted,refusal,returnedCode'&&parse.protocol==='jev-private-entry-parse-result-v1'&&parse.returnedCode===2&&parse.fd4Adopted===true&&parse.cleanupKnown===true&&parse.refusal===null&&parse.providerStarted===false&&parse.normalRecoveryAccepted===false);
 const pe=await terminal(pr.ended);need(pr.entered()&&pe.code===2&&pe.signal==='NONE');
 closeRetainedChildOwnerObserver(parseOuter,pr.r.custody);need(outerOwnerObserverStatus(parseOuter).refusal===null);cases.push('PRIVATE_AGENT_ENTRY_PARSE_REFUSAL_CLEANUP');
}catch(error){code=fixed(error);if(code==='CLEANUP')cleanup=false;process.exitCode=2;}
finally{
 for(const r of roles){
  if(!r.terminal()){cleanup=false;try{r.cancel();}catch{cleanup=false;}}
  let timer;let settled=false;try{settled=await Promise.race([r.ended.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),10000);})]);}finally{if(timer!==undefined)clearTimeout(timer);}
  if(!settled){
   // Original owner authority remains in this live fixture; no PID rebuild or restart.
   // Passive diagnostics cannot escape live original-custody retention.
   let stderrHandled=false;
   try{process.stderr.on('error',()=>{});stderrHandled=true;}catch{}
   if(stderrHandled)try{process.stderr.write('JEV_PRODUCTION_FIXTURE_UNKNOWN_HOLD\n',()=>{});}catch{}
   await new Promise(()=>{setInterval(()=>{},1000);});
  }
  try{closeRetainedChildOwnerObserver(r.observer,r.custody);if(outerOwnerObserverStatus(r.observer).refusal==='CLEANUP')cleanup=false;}catch{cleanup=false;}
 }
 try{uninstall();}catch{cleanup=false;}
}
if(interrupted)process.exitCode=2;
if(!cleanup){stage='CLEANUP';code='CLEANUP';process.exitCode=2;}
process.stdout.write(JSON.stringify({protocol:'jev-current-production-owner-fixture-v1',status:process.exitCode||interrupted?'REFUSED':'SUPPORTED',stage,code,cases,notification,sample,positive,parse,cleanupKnown:cleanup,roleTerminalObserved:roles.length===2&&roles.every(r=>r.terminal()),roleStdio:'IGNORED',supervisorProviderEOF:'UNPROVED',normalRecoveryAccepted:false})+'\n');
