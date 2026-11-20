import { loadRelay,fixtureReady,fixedCode,requireBound } from './relay-facade.mjs';
const end=new Promise(resolve=>{process.stdin.once('end',resolve);process.stdin.resume();});
let api,output,input,bound,imported,other,bad=false,cleanup=true;
const receipts=[],tests=[];
function need(v){if(!v)throw Object.assign(new Error('FIXTURE'),{code:'FIXTURE'});}
function record(v){return {terminal:v.terminal,nodeCloseObserved:v.nodeCloseObserved,code:v.code,signal:v.signal,ownedPipeEOF:v.ownedPipeEOF,pipePolicyValid:v.pipePolicyValid,cleanupKnown:true};}
try {
  api=loadRelay(process.env.JEV_RELAY_ARTIFACT,process.env.JEV_RELAY_SHA);
  output=api.inherited();input=api.channel();bound=api.spawnSupervisor(input);
  requireBound(bound);
  await fixtureReady(bound.original,'SUPERVISOR_READY\n');
  if(process.env.JEV_RELAY_MODE==='POSITIVE') {
    other=api.spawnTarget();requireBound(other);
    await fixtureReady(other.original,'READY\n');
    let refused=false;
    try{api.receiveImported(input,other.capability);}catch(e){if(fixedCode(e)==='CLEANUP')throw e;refused=fixedCode(e)==='OWNERSHIP';}
    need(refused);tests.push('LOCAL_SUPERVISOR_MISMATCH_REFUSED');
    const v=await api.settle(other.original);receipts.push(record(v));
    need(v.code===0&&v.signal==='NONE'&&v.ownedPipeEOF&&v.pipePolicyValid);
  }
  imported=api.receiveImported(input,bound.capability);
  if(process.env.JEV_RELAY_MODE==='POSITIVE')api.sendChain(output,imported);
  else api.sendNegative(output,imported,process.env.JEV_RELAY_MODE);
  process.stdout.write('ROLE_READY\n');
  await end;
} catch(e) {bad=true;if(fixedCode(e)==='CLEANUP')cleanup=false;} finally {
  if(other?.original)try{await api.settle(other.original);}catch{bad=true;cleanup=false;}
  if(other?.capability)try{api.closePair(other.capability);}catch(e){if(fixedCode(e)!=='CLOSED'){bad=true;cleanup=false;}}
  if(bound?.original)try {
    const v=await api.settle(bound.original);receipts.push(record(v),...v.nested);
    if(v.code!==0||v.signal!=='NONE'||!v.ownedPipeEOF||!v.pipePolicyValid||v.nested.length!==1)bad=true;
  } catch {bad=true;cleanup=false;}
  if(imported)try{api.closeImported(imported);}catch{bad=true;cleanup=false;}
  if(bound?.capability)try{api.closePair(bound.capability);}catch(e){if(fixedCode(e)!=='CLOSED'){bad=true;cleanup=false;}}
  for(const c of [input,output])if(c)try{api.closeChannel(c);}catch{bad=true;cleanup=false;}
}
if(!cleanup)for(const v of receipts)v.cleanupKnown=false;
process.stdout.write('CHILD_RESULT '+JSON.stringify({receipts,tests})+'\n');
if(bad||!cleanup)process.exitCode=2;
