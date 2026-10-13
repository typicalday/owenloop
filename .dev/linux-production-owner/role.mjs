#!/usr/bin/env node
// Thin shim: all real logic lives in src/cli.ts (so it stays testable) and is
// shipped compiled to dist/src/cli.js. Node cannot type-strip files under
// node_modules, so the published package runs plain JS, not TypeScript source.
import { readFile, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const START_GATE_TIMEOUT_MS = 2 * 60_000;

/**
 * A Shift-spawned worker cannot import or execute the CLI until the parent has
 * durably replaced its reservation with a PID-bearing record. Missing,
 * cancelled, or expired gates fail closed before any role can contact the hub.
 */
async function waitForStartGate(path) {
  const deadline = performance.now() + START_GATE_TIMEOUT_MS;
  for (;;) {
    let signal;
    try {
      signal = (await readFile(path, 'utf8')).trim();
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (signal === 'start') {
      await rm(path, { force: true });
      return true;
    }
    if (signal === 'cancel') {
      await rm(path, { force: true });
      return false;
    }
    if (performance.now() >= deadline) {
      await rm(path, { force: true });
      return false;
    }
    await sleep(25);
  }
}

/** The direct routed child must receive Shift's allow before importing CLI code. */
async function acknowledgeRoutedGate(gatePath, handoffPath) {
  const match = /^\.([a-f0-9]{32})\.gate$/.exec(basename(gatePath));
  if (!match || !handoffPath || typeof process.send !== 'function' || !process.connected) return false;
  return new Promise(resolve => {
    let settled = false;
    let parentAllowed = false;
    const finish = allowed => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      if (!allowed) {
	try { if (process.connected) process.disconnect(); } catch { /* Parent already closed. */ }
      }
      resolve(allowed);
    };
    const onMessage = message => {
      if (!(message && typeof message === 'object'
	&& Object.keys(message).sort().join(',') === 'dispatchToken,type'
	&& message.type === 'routing-gate-entry-allowed' && message.dispatchToken === match[1])) {
	finish(false);
	return;
      }
      parentAllowed = true;
    };
    const onDisconnect = () => finish(parentAllowed);
    const timer = setTimeout(() => finish(false), 5_000);
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
    try {
      process.send({ type: 'routing-gate-entered', dispatchToken: match[1],
	routingHandoff: handoffPath }, error => { if (error) finish(false); });
    } catch { finish(false); }
  });
}

const gatePath = process.env.OWENLOOP_START_GATE;
const routingHandoff = process.env.OWENLOOP_ROUTING_HANDOFF;
if (routingHandoff && !gatePath) process.exit(75);
if (gatePath !== undefined && gatePath !== '') {
  let allowed = false;
  try {
    allowed = await waitForStartGate(gatePath);
  } catch (error) {
    process.stderr.write(`owenloop: start gate failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (!allowed) process.exit(75);
  if (routingHandoff && !(await acknowledgeRoutedGate(gatePath, routingHandoff))) process.exit(75);
  delete process.env.OWENLOOP_START_GATE;
}

function handleStreamError(error) {
  if (error?.code === 'EPIPE') return;
  throw error;
}

function drain(stream) {
  return new Promise((resolve) => stream.write('', resolve));
}

process.stdout.on('error', handleStreamError);
process.stderr.on('error', handleStreamError);


// Private harmless entry; gate/IPC3 prefix above is unchanged.
import { install,binding,writeFixed,fixed,uninstall,privateNodeOptions,declareSupervisor } from '../loader.mjs';
install('positiveRole');
let observer,ownerModule,client,stage='ENTRY',code='NOT_APPLICABLE',cleanup=true,settlement=null,workComplete=false;
let raw4=true,fd4Adopted=false,interrupted=false;process.on('SIGTERM',()=>{interrupted=true;});process.on('SIGINT',()=>{interrupted=true;});
try{
 if(!gatePath||!routingHandoff)throw new Error('ENTRY_REFUSED');
 const b=binding();if(b.protocol!=='jev-production-binding-v1'||b.enabled!==true)throw new Error('BINDING_REFUSED');
 ownerModule=await import('../dist/packages/work/src/harness/routed-owner-observer.js');
 raw4=false;observer=ownerModule.createRoutedOwnerRoleObserver(b.artifact,b.artifactSha256);fd4Adopted=true;
 const {startManagedStdioRpc}=await import('../dist/packages/work/src/harness/jsonrpc-stdio.js');
 const {ROUTED_OBSERVED_STDIO_SUPERVISOR}=await import('../dist/packages/work/src/harness/routed-stdio-supervisor.js');
 declareSupervisor(ROUTED_OBSERVED_STDIO_SUPERVISOR);
 stage='MANAGED_START';
 client=startManagedStdioRpc({command:process.execPath,args:[b.provider],env:{NODE_OPTIONS:privateNodeOptions('supervisor')},ownerObserver:observer,requestTimeoutMs:10000,onNotification(){},onServerRequest:async()=>null,onStderr(){},onExit(){}});
 await client.ready;
 // No sample count barrier. Ordinary fixture RPC lifetime is independent.
 const work=client.request('bounded-work',{},10000);
 writeFixed('entry-results/ready.json',{protocol:'jev-production-role-notification-v1',sourceOwned:true,afterManagedReady:true,workIssued:true});
 stage='WORK';workComplete=await work==='WORK_COMPLETE';
 if(!workComplete||interrupted)throw new Error('WORK_REFUSED');
}catch(error){code=fixed(error);if(code==='CLEANUP')cleanup=false;process.exitCode=2;}
finally{
 if(client)try{const s=await client.settleEffects({reason:'normal-exit',deadlineAt:performance.now()+5000});
  const allowed=['normal-exit:group-absent','deadline-expired','settlement-timeout','group-probe-uncertain','group-still-present-or-reused','supervisor-error','invalid-ready','unsafe-group','signal-error','provider-error','invalid-provider-exit-watermark'];
  settlement={scope:s.scope,state:s.state,reason:allowed.includes(s.evidence.reason)?s.evidence.reason:'UNKNOWN'};
  if(s.scope!=='original-posix-group'||s.state!=='empty'||s.evidence.reason!=='normal-exit:group-absent')process.exitCode=2;
 }catch{cleanup=false;process.exitCode=2;}
 if(observer){try{ownerModule.closeRoutedOwnerRoleObserver(observer);const s=ownerModule.roleOwnerObserverStatus(observer);if(s.refusal!==null){code=s.refusal;process.exitCode=2;if(code==='CLEANUP')cleanup=false;}}catch(error){code=fixed(error);cleanup=false;}}
 else if(!raw4){
  // Transfer was attempted but no token returned: cleanup is unproved.
  cleanup=false;code='CLEANUP';process.exitCode=2;
 }
 else if(raw4){raw4=false;try{const {closeSync}=await import('node:fs');closeSync(4);}catch{code='CLEANUP';cleanup=false;}}
 try{uninstall();}catch{cleanup=false;}
 if(!cleanup){stage='CLEANUP';code='CLEANUP';process.exitCode=2;}
 try{writeFixed('entry-results/positive.json',{protocol:'jev-production-role-terminal-v1',status:process.exitCode?'REFUSED':'SUPPORTED',stage,code,fd4Adopted,workComplete,cleanupKnown:cleanup,settlement,supervisorTerminalEOF:'UNPROVED',providerTerminalEOF:'UNPROVED',normalRecoveryAccepted:false});}catch{process.exitCode=2;}
}

