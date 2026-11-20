import { loadQ2,fixtureReady,fixedCode,requireBound } from './q2-facade.mjs';
let api,stage='LOAD',status='SUPPORTED',code='NOT_APPLICABLE',cleanup=true;
const cases=[],receipts=[],observations=[],originals=[],pairs=[],channels=[],chains=[];
function need(v){if(!v)throw Object.assign(new Error('FIXTURE'),{code:'FIXTURE'});}
function record(v){return {terminal:v.terminal,nodeCloseObserved:v.nodeCloseObserved,code:v.code,signal:v.signal,ownedPipeEOF:v.ownedPipeEOF,pipePolicyValid:v.pipePolicyValid,cleanupKnown:true};}
function projection(v){need(v&&Reflect.ownKeys(v).length===7&&Number.isInteger(v.count)&&v.count>=2&&v.count<128);for(const k of ['twoPasses','allStatesLive','sameTaskDescriptors','sameProcessIdentity','completeEOF','cleanupKnown'])need(v[k]===true);}
const expected={MISSING_RIGHTS:['CHANNEL','MISSING_RIGHTS','MISSING_RIGHTS_REFUSED'],DUPLICATE_RIGHTS:['PAIR','DUPLICATE_PAIR','DUPLICATE_RIGHTS_REFUSED'],REORDERED_RIGHTS:['PAIR','REVERSED_PARENT_CHAIN','REORDERED_RIGHTS_REFUSED'],TWO_PACKETS:['CHANNEL','SECOND_RIGHTS_PACKET','DUPLICATE_PACKET_REFUSED']};
try {
  api=loadQ2(process.env.JEV_RELAY_ARTIFACT,process.env.JEV_RELAY_SHA);
  for(const mode of ['MISSING_RIGHTS','DUPLICATE_RIGHTS','REORDERED_RIGHTS','TWO_PACKETS','VALID']){
    stage=mode;const output=api.channel();channels.push(output);
    const bound=api.spawnRole(output,mode);originals.push(bound.original);
    if(bound.capability)pairs.push(bound.capability);requireBound(bound);
    await fixtureReady(bound.original,'ROLE_READY\n');
    let observedCode='NOT_APPLICABLE',detail='NOT_APPLICABLE';
    if(mode!=='VALID'){
      try{const v=api.receiveChain(output,bound.capability);chains.push(v);}catch(e){if(fixedCode(e)==='CLEANUP')throw e;observedCode=fixedCode(e);}
      detail=api.detail(output);need(observedCode===expected[mode][0]&&detail===expected[mode][1]);cases.push(expected[mode][2]);
    }else{
      const chain=api.receiveChain(output,bound.capability);chains.push(chain);projection(api.sample(chain));
      let refused=false;
      try{const v=api.receiveChain(output,bound.capability);chains.push(v);}catch(e){if(fixedCode(e)==='CLEANUP')throw e;refused=fixedCode(e)==='OWNERSHIP';}
      need(refused);
      /* Only caller-local pair closes. Chain owns independent checked aliases. */
      api.closePair(bound.capability);projection(api.sample(chain));
    }
    const ended=await api.settle(bound.original);
    need(ended.code===0&&ended.signal==='NONE'&&ended.ownedPipeEOF&&ended.pipePolicyValid&&ended.nested.length===2);
    for(const v of ended.nested)need(v.code===0&&v.signal==='NONE'&&v.ownedPipeEOF&&v.pipePolicyValid&&v.cleanupKnown);
    need(ended.sendEvidence&&ended.sendEvidence.mode===mode);
    if(mode==='VALID'){
      need(ended.tests.length===1&&ended.tests[0]==='CONSUMED_ENVELOPE_SECOND_SEND_REFUSED');
      cases.push('CONSUMED_ENVELOPE_SECOND_SEND_REFUSED','CONSUMED_CHANNEL_SECOND_RECEIVE_REFUSED','LOCAL_PAIR_ALIAS_INDEPENDENCE');
    }else need(ended.tests.length===0);
    receipts.push(record(ended),...ended.nested);
    observations.push({mode,receivedRefusal:observedCode,receivedDetail:detail,sent:ended.sendEvidence});
    if(mode==='VALID')api.closeChain(chains[chains.length-1]);
    try{api.closePair(bound.capability);}catch(e){if(fixedCode(e)!=='CLOSED')throw e;}
    api.closeChannel(output);
  }
}catch(e){status='UNSUPPORTED';code=fixedCode(e);if(code==='CLEANUP')cleanup=false;process.exitCode=2;}
finally {
  for(const original of originals)try{const v=await api.settle(original);if(v.code!==0||v.signal!=='NONE'||!v.ownedPipeEOF||!v.pipePolicyValid)cleanup=false;}catch{cleanup=false;}
  for(const chain of chains)try{api.closeChain(chain);}catch{cleanup=false;}
  for(const pair of pairs)try{api.closePair(pair);}catch(e){if(fixedCode(e)!=='CLOSED')cleanup=false;}
  for(const channel of channels)try{api.closeChannel(channel);}catch{cleanup=false;}
}
if(!cleanup){status='UNSUPPORTED';stage='CLEANUP';code='CLEANUP';process.exitCode=2;}
process.stdout.write(JSON.stringify({protocol:'jev-private-one-relay-q2-fixture-v1',status,stage,code,cases,receipts,observations,cleanupKnown:cleanup,sequentialEndpointOnly:true,nativeRecoveryAccepted:false})+'\n');
