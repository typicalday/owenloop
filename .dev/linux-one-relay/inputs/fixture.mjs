import { loadRelay,fixtureReady,fixedCode,requireBound } from './relay-facade.mjs';
let api,stage='LOAD',code='NOT_APPLICABLE',status='SUPPORTED',cleanup=true;
const cases=[],receipts=[],originals=[],channels=[],pairs=[],chains=[];
function need(v){if(!v)throw Object.assign(new Error('FIXTURE'),{code:'FIXTURE'});}
function record(v){return {terminal:v.terminal,nodeCloseObserved:v.nodeCloseObserved,code:v.code,signal:v.signal,ownedPipeEOF:v.ownedPipeEOF,pipePolicyValid:v.pipePolicyValid,cleanupKnown:true};}
function settled(v,n){need(v.code===0&&v.signal==='NONE'&&v.ownedPipeEOF&&v.pipePolicyValid&&v.nested.length===n);for(const r of v.nested)need(r.code===0&&r.signal==='NONE'&&r.ownedPipeEOF&&r.pipePolicyValid&&r.cleanupKnown);}
try {
  api=loadRelay(process.env.JEV_RELAY_ARTIFACT,process.env.JEV_RELAY_SHA);
  for(const mode of ['POSITIVE','MALFORMED_FRAME','EXTRA_RIGHTS','TRUNCATED_RIGHTS']) {
    stage=mode;const output=api.channel();channels.push(output);
    const bound=api.spawnRole(output,mode);originals.push(bound.original);
    if(bound.capability)pairs.push(bound.capability);requireBound(bound);
    await fixtureReady(bound.original,'ROLE_READY\n');
    if(mode==='POSITIVE') {
      const chain=api.receiveChain(output,bound.capability);chains.push(chain);
      const v=api.sample(chain);
      need(Reflect.ownKeys(v).length===7&&Number.isInteger(v.count)&&v.count>=2&&v.count<128);
      for(const key of ['twoPasses','allStatesLive','sameTaskDescriptors','sameProcessIdentity','completeEOF','cleanupKnown'])need(v[key]===true);
      cases.push('GENUINE_THREE_EDGE_ONE_RELAY_ENDPOINT');
      stage='ORDINARY_PAIR';const unused=api.channel();channels.push(unused);let refused=false;
      try{api.rejectOrdinary(unused,bound.capability);}catch(e){if(fixedCode(e)==='CLEANUP')throw e;refused=fixedCode(e)==='ARGUMENT';}
      need(refused);cases.push('ORDINARY_PAIR_NOT_FORWARDABLE');api.closeChannel(unused);
      stage='ROLE_SETTLEMENT';const ended=await api.settle(bound.original);settled(ended,3);
      receipts.push(record(ended),...ended.nested);
      need(ended.tests.length===1&&ended.tests[0]==='LOCAL_SUPERVISOR_MISMATCH_REFUSED');
      cases.push('LOCAL_SUPERVISOR_MISMATCH_REFUSED');
      stage='EXITED_ANCESTOR';refused=false;
      try{api.sample(chain);}catch(e){if(fixedCode(e)==='CLEANUP')throw e;refused=fixedCode(e)==='OWNERSHIP';}
      need(refused);cases.push('EXITED_REAPED_ANCESTOR_REFUSED');
      stage='CLOSED_CHAIN';api.closeChain(chain);refused=false;
      try{api.sample(chain);}catch(e){if(fixedCode(e)==='CLEANUP')throw e;refused=fixedCode(e)==='OWNERSHIP';}
      need(refused);cases.push('CLOSED_CHAIN_REFUSED');
    } else {
      let refused=false;
      try{const unexpected=api.receiveChain(output,bound.capability);chains.push(unexpected);}catch(e){if(fixedCode(e)==='CLEANUP')throw e;refused=fixedCode(e)==='CHANNEL';}
      const detail=mode==='TRUNCATED_RIGHTS'?'CONTROL_TRUNCATED':mode;
      need(refused&&api.negativeDetail(output)===detail);
      const ended=await api.settle(bound.original);settled(ended,2);need(ended.tests.length===0);
      receipts.push(record(ended),...ended.nested);cases.push(mode+'_CHAIN_REFUSED');
    }
  }
} catch(e) {status='UNSUPPORTED';code=fixedCode(e);if(code==='CLEANUP')cleanup=false;process.exitCode=2;}
finally {
  for(const original of originals)try{const v=await api.settle(original);if(v.code!==0||v.signal!=='NONE'||!v.ownedPipeEOF||!v.pipePolicyValid)cleanup=false;}catch{cleanup=false;}
  for(const chain of chains)try{api.closeChain(chain);}catch{cleanup=false;}
  for(const pair of pairs)try{api.closePair(pair);}catch(e){if(fixedCode(e)!=='CLOSED')cleanup=false;}
  for(const output of channels)try{api.closeChannel(output);}catch{cleanup=false;}
}
if(!cleanup){status='UNSUPPORTED';stage='CLEANUP';code='CLEANUP';process.exitCode=2;}
process.stdout.write(JSON.stringify({protocol:'jev-private-one-relay-fixture-v1',status,stage,code,cases,receipts,cleanupKnown:cleanup,sequentialEndpointOnly:true,nativeRecoveryAccepted:false})+'\n');
