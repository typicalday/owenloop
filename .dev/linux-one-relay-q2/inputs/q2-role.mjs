import { loadQ2,fixtureReady,fixedCode,requireBound } from './q2-facade.mjs';
const end=new Promise(resolve=>{process.stdin.once('end',resolve);process.stdin.resume();});
let api,output,input,bound,imported,sent=null,bad=false,cleanup=true;
const receipts=[],tests=[];
function need(v){if(!v)throw Object.assign(new Error('FIXTURE'),{code:'FIXTURE'});}
function record(v){return {terminal:v.terminal,nodeCloseObserved:v.nodeCloseObserved,code:v.code,signal:v.signal,ownedPipeEOF:v.ownedPipeEOF,pipePolicyValid:v.pipePolicyValid,cleanupKnown:true};}
try {
  api=loadQ2(process.env.JEV_RELAY_ARTIFACT,process.env.JEV_RELAY_SHA);
  output=api.inherited();input=api.channel();bound=api.spawnSupervisor(input);requireBound(bound);
  await fixtureReady(bound.original,'SUPERVISOR_READY\n');
  imported=api.receiveImported(input,bound.capability);
  const mode=process.env.JEV_RELAY_MODE;
  sent=api.sendQ2(output,imported,mode);
  if(mode==='VALID'){
    let refused=false;
    try{api.sendQ2(output,imported,mode);}catch(e){if(fixedCode(e)==='CLEANUP')throw e;refused=fixedCode(e)==='OWNERSHIP';}
    need(refused);tests.push('CONSUMED_ENVELOPE_SECOND_SEND_REFUSED');
  }
  process.stdout.write('ROLE_READY\n');await end;
} catch(e){bad=true;if(fixedCode(e)==='CLEANUP')cleanup=false;}
finally {
  if(bound?.original)try{
    const v=await api.settle(bound.original);receipts.push(record(v),...v.nested);
    if(v.code!==0||v.signal!=='NONE'||!v.ownedPipeEOF||!v.pipePolicyValid||v.nested.length!==1)bad=true;
  }catch{bad=true;cleanup=false;}
  if(imported)try{api.closeImported(imported);}catch{bad=true;cleanup=false;}
  if(bound?.capability)try{api.closePair(bound.capability);}catch(e){if(fixedCode(e)!=='CLOSED'){bad=true;cleanup=false;}}
  for(const c of [input,output])if(c)try{api.closeChannel(c);}catch{bad=true;cleanup=false;}
}
if(!cleanup)for(const v of receipts)v.cleanupKnown=false;
process.stdout.write('CHILD_RESULT '+JSON.stringify({receipts,tests,sent})+'\n');
if(bad||!cleanup)process.exitCode=2;
