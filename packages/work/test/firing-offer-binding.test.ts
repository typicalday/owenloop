import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateFiringBinding, canRefreshOfferDescriptor, firingOfferCacheKey,
  isFiringOfferBinding, supersedesLocalOffer } from '../src/shift/firing-offer-binding.ts';
import type { FiringOfferBindingV2, RoutingOfferCandidate, ShiftOfferV2 } from '../src/hub/types.ts';

const binding: FiringOfferBindingV2 = { version:'firing-offer-binding-v2',workflow:'wf',frameId:'frame',
  step:'build',key:'',evidenceGeneration:'inputs-one',nativeClaimGeneration:{
    protocol:'native-claim-generation-v1',frameIncarnation:`fi_${'a'.repeat(24)}`,generation:0},
  consentSequence:0,executorKind:'agent',laneId:'agent-lane'};
const tuples = [{eligible:true,available:true,tuple:{id:'tuple',harness:'codex',model:'model',effort:'high' as const}}];
const candidate: RoutingOfferCandidate = {candidateId:'old-state',frameId:'frame',step:'build',key:'',
  evidenceGeneration:'inputs-one',context:{firingBinding:binding,now:1000,maxTtlMs:120000,orgId:'org',principalId:'machine',
    sessionId:'session',shiftId:'shift',rosterRevision:'roster',rolePolicyRevision:'policy',runId:'wf',crewId:'crew',capability:'build'},
  role:'implementation',rolePolicy:{revision:'policy',unknownRole:'refuse',rules:[{model:'model',roles:['implementation']}]},tuples};
const offer: ShiftOfferV2 = {version:'shift-offer-v2',firingBinding:binding,offerId:'offer',orgId:'org',principalId:'machine',
  sessionId:'session',shiftId:'shift',willingness:{runIds:['wf'],crewIds:['crew'],capabilities:['build']},
  rosterRevision:'roster',rolePolicyRevision:'policy',tuples,issuedAt:1000,expiresAt:10000};

test('unrelated descriptor churn refreshes same consent with unchanged ID/bytes/deadline', () => {
  const before=JSON.stringify(offer);
  const current={...candidate,candidateId:'new-state',context:{...candidate.context,now:2000}};
  assert.equal(canRefreshOfferDescriptor(candidate,current,offer,'same-roster','same-roster'),true);
  assert.equal(firingOfferCacheKey(binding,'session'),firingOfferCacheKey(current.context.firingBinding!,'session'));
  assert.equal(JSON.stringify(offer),before);
});

test('next native attempt or authenticated next consent gets a distinct key, never aliases old consent', () => {
  for (const next of [{...binding,nativeClaimGeneration:{...binding.nativeClaimGeneration,generation:1}},
    {...binding,consentSequence:1},{...binding,nativeClaimGeneration:{...binding.nativeClaimGeneration,frameIncarnation:`fi_${'b'.repeat(24)}`}}]) {
    assert.notEqual(firingOfferCacheKey(next,'session'),firingOfferCacheKey(binding,'session'));
    assert.equal(canRefreshOfferDescriptor(candidate,{...candidate,context:{...candidate.context,firingBinding:next}},offer,'r','r'),false);
  }
});

test('old authority ABA cannot refresh consent after server sequence changed', () => {
  const current={...candidate,context:{...candidate.context,firingBinding:{...binding,consentSequence:1}}};
  assert.equal(canRefreshOfferDescriptor(candidate,current,offer,'r','r'),false);
  assert.equal(canRefreshOfferDescriptor(candidate,{...candidate,context:{...candidate.context,rosterRevision:'other'}},offer,'r','r'),false);
  assert.equal(canRefreshOfferDescriptor(candidate,candidate,offer,'old','changed'),false);
});

test('legacy/malformed/caller-extra binding cannot be silently treated as generation zero', () => {
  for(const value of [undefined,{...binding,consentSequence:-1},{...binding,extra:true},
    {...binding,nativeClaimGeneration:{...binding.nativeClaimGeneration,generation:'0'}},
    {...binding,nativeClaimGeneration:{...binding.nativeClaimGeneration,frameIncarnation:'fi_old'}}])
    assert.equal(isFiringOfferBinding(value),false);
  assert.equal(candidateFiringBinding({...candidate,evidenceGeneration:'changed'},'wf'),undefined);
});

test('current task head retires only the same authenticated principal/session/task', () => {
  const next={...candidate,context:{...candidate.context,firingBinding:{...binding,consentSequence:1}}};
  assert.equal(supersedesLocalOffer(next,offer),true);
  const oldBytes=JSON.stringify(offer);
  assert.equal(JSON.stringify(offer),oldBytes);
  assert.equal(supersedesLocalOffer({...next,context:{...next.context,principalId:'another'}},offer),false);
  assert.equal(supersedesLocalOffer({...next,evidenceGeneration:'different',context:{...next.context,
    firingBinding:{...next.context.firingBinding,evidenceGeneration:'different'}}},offer),true);
  assert.equal(supersedesLocalOffer(candidate,offer),false);
});
