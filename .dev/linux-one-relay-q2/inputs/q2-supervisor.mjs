import { loadQ2,fixtureReady,fixedCode,requireBound } from './q2-facade.mjs';
const end=new Promise(resolve=>{process.stdin.once('end',resolve);process.stdin.resume();});
let api,output,bound,bad=false,cleanup=true,receipt;
try {
  api=loadQ2(process.env.JEV_RELAY_ARTIFACT,process.env.JEV_RELAY_SHA);
  output=api.inherited();bound=api.spawnTarget();
  requireBound(bound);
  await fixtureReady(bound.original,'READY\n'); // harmless fixture readiness only
  api.sendDirect(output,bound.capability);
  process.stdout.write('SUPERVISOR_READY\n');
  await end;
} catch(e) {bad=true;if(fixedCode(e)==='CLEANUP')cleanup=false;} finally {
  if(bound?.original)try {
    const v=await api.settle(bound.original);
    receipt={terminal:v.terminal,nodeCloseObserved:v.nodeCloseObserved,code:v.code,signal:v.signal,ownedPipeEOF:v.ownedPipeEOF,pipePolicyValid:v.pipePolicyValid,cleanupKnown:true};
    if(v.code!==0||v.signal!=='NONE'||!v.ownedPipeEOF||!v.pipePolicyValid)bad=true;
  } catch {bad=true;cleanup=false;}
  if(bound?.capability)try{api.closePair(bound.capability);}catch(e){if(fixedCode(e)!=='CLOSED'){bad=true;cleanup=false;}}
  if(output)try{api.closeChannel(output);}catch{bad=true;cleanup=false;}
}
if(receipt)receipt.cleanupKnown=cleanup;
process.stdout.write('CHILD_RESULT '+JSON.stringify({receipts:receipt?[receipt]:[],tests:[]})+'\n');
if(bad||!cleanup)process.exitCode=2;
