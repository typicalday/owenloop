import assert from 'node:assert/strict';
import test from 'node:test';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import type { VerifiedDefinitionSelection } from '../../../src/store/instruction-source.ts';
import type { ReferenceRouting, OrderPacket } from '../src/hub/types.ts';
import type { RoutedClaimV2, RoutedReferenceV2 } from '../src/hosted/trusted-routed-reference-v2.ts';
import { createParentRoutedInvocationSource } from '../src/shift/routing-invocation-source.ts';

const expected = { workflow: 'wf_root', run: 'run_1' };
const parentDefRef = { bundleDigest: 'a'.repeat(64), workflowName: 'routing/parent' };
const childDefRef = { bundleDigest: 'b'.repeat(64), workflowName: 'routing/child' };
const key = { parentWorkflow: 'wf_frame', parentDefRef, callPath: 'child', parentArtifactVersion: 3 };
const receipt = { receipt: { invocationId: 'inv', parentDefRef, callPath: 'child',
  evidenceDigest: 'c'.repeat(64), parentArtifactVersion: 3, childWorkflow: 'wf_child',
  childDefRef, childOutcome: 'ok', childOutcomeVersion: 1 }, receiptDigest: 'd'.repeat(64) };

function pair(expiryOffset = 0) {
  const routing = { claim: { claimId: expected.run, sessionId: 'session', shiftId: 'shift' },
    decision: { decisionId: 'decision' }, preference: { rosterRevision: 'e'.repeat(64),
      expiresAt: 1_800_000_000_000 + expiryOffset } } as unknown as ReferenceRouting;
  const binding = { rootWorkflow: expected.workflow, frameWorkflow: key.parentWorkflow,
    run: expected.run, claimId: expected.run, decisionId: 'decision', sessionId: 'session',
    shiftId: 'shift', orderDigest: 'f'.repeat(64), authorityRevision: '1'.repeat(64),
    rosterRevision: routing.preference.rosterRevision, routingDigest: valueDigestHex(routing),
    preferenceExpiresAt: routing.preference.expiresAt };
  const order = { workflow: key.parentWorkflow, run: expected.run, step: 'consume', key: '',
    defDigest: parentDefRef.bundleDigest, inputs: ['child'], outputs: ['result'],
    consumes: { child: { ok: true } }, consumedFingerprint: { child: 3 },
    owes: [{ path: 'result', version: 1 }], routing } as unknown as OrderPacket;
  const reference: RoutedReferenceV2 = { protocol: 'trusted-routed-reference-read-v2',
    state: 'available', ...expected, order, binding, lease: { claimed: true },
    inputs: [{ path: 'child', version: 3, present: true, value: { ok: true } }] };
  const claim: RoutedClaimV2 = { protocol: 'routing-claim-read-v2', state: 'available',
    ...expected, routing, binding };
  return { reference, claim };
}
const selected = { bundleDigest: parentDefRef.bundleDigest,
  definition: { name: parentDefRef.workflowName, steps: [{ callsInterface: { selection: 'invocation' },
    produces: [{ stem: 'child' }] }] } } as unknown as VerifiedDefinitionSelection;

test('parent dynamic source prebinds signed path/version and rechecks pair after selected child', async () => {
  const original = pair();
  const order = (original.reference as Extract<RoutedReferenceV2, { state: 'available' }>).order;
  let reads = 0, verifications = 0, changed = false;
  const source = createParentRoutedInvocationSource({ expected, order, selected,
    pair: original, phase: 'prestart', stillAuthorized: () => true,
    readDirect: async () => { reads++; return receipt; },
    verifyChild: async child => { verifications++; assert.deepEqual(child, childDefRef); },
    readCurrentPair: async () => changed ? pair(1) : original });
  assert.deepEqual(await source.read(key), receipt);
  assert.equal(reads, 1);
  assert.equal(verifications, 1);
  for (const wrong of [{ ...key, callPath: 'sibling' }, { ...key, parentArtifactVersion: 4 },
    { ...key, parentDefRef: { ...key.parentDefRef, workflowName: 'routing/sibling' } }])
    await assert.rejects(async () => source.read(wrong), /refused/);
  assert.equal(reads, 1, 'wrong selected key makes no direct Service relay read');
  changed = true;
  await assert.rejects(async () => source.read(key), /refused/);
  assert.equal(reads, 2, 'a changed current pair after the relay cannot be accepted');
});
