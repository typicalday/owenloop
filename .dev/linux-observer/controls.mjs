import assert from 'node:assert/strict';
import { validateObservation, inertCode } from './observer.mjs';
const cases=[];
const run=(name,call)=>{call();cases.push(name);};
const good=()=>({count:2,twoPasses:true,allStatesLive:true,sameTaskDescriptors:true,sameProcessIdentity:true,completeEOF:true,cleanupKnown:true});
run('two-thread-endpoint-shape',()=>assert.deepEqual(validateObservation(good()),good()));
run('largest-admitted-count',()=>assert.equal(validateObservation({...good(),count:127}).count,127));
for(const [name,value] of [['zero',0],['single',1],['cap',128],['fraction',2.5],['string','2'],['nan',NaN]])
 run(`reject-count-${name}`,()=>assert.throws(()=>validateObservation({...good(),count:value})));
for(const key of ['twoPasses','allStatesLive','sameTaskDescriptors','sameProcessIdentity','completeEOF','cleanupKnown'])
 run(`reject-${key}`,()=>assert.throws(()=>validateObservation({...good(),[key]:false})));
run('reject-extra-private-key',()=>assert.throws(()=>validateObservation({...good(),pid:123})));
run('reject-symbol-key',()=>assert.throws(()=>validateObservation({...good(),[Symbol('private')]:true})));
run('reject-missing-field',()=>{const x=good();delete x.completeEOF;assert.throws(()=>validateObservation(x));});
run('getter-not-called',()=>{let calls=0;const x=good();Object.defineProperty(x,'count',{get(){calls++;return 2;}});assert.throws(()=>validateObservation(x));assert.equal(calls,0);});
run('proxy-descriptor-failure',()=>assert.throws(()=>validateObservation(new Proxy({},{ownKeys(){throw 0;}}))));
run('known-code',()=>assert.equal(inertCode({code:'ACCESS'}),'ACCESS'));
run('unknown-code-not-retained',()=>assert.equal(inertCode({code:'private arbitrary value'}),'UNKNOWN'));
run('error-code-getter-not-called',()=>{let calls=0;const x={};Object.defineProperty(x,'code',{get(){calls++;return 'ACCESS';}});assert.equal(inertCode(x),'UNKNOWN');assert.equal(calls,0);});
run('error-proxy-fallback',()=>assert.equal(inertCode(new Proxy({},{ownKeys(){throw new Error('private');}})),'UNKNOWN'));
process.stdout.write(JSON.stringify({protocol:'jev-linux-procfs-pure-controls-v1',passed:true,cases,backendInvoked:false})+'\n');
