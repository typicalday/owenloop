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
  const signed = { runId: expected.workflow, frameId: key.parentWorkflow,
    def: { bundleDigest: `sha256:${parentDefRef.bundleDigest}`,
      workflowName: parentDefRef.workflowName } };
  const routing = { claim: { claimId: expected.run, sessionId: 'session', shiftId: 'shift',
    binding: signed },
    decision: { decisionId: 'decision', binding: signed }, preference: { rosterRevision: 'e'.repeat(64),
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
function nativeOrder(original = pair()): OrderPacket {
  const reduced = (original.reference as Extract<RoutedReferenceV2, { state: 'available' }>).order;
  return { ...reduced, owes: [{ path: 'result', version: 1, judgmentRejects: 2,
    schemaRejects: 1, reasons: [{ at: 1, action: 'reject', kind: 'human', by: 'reviewer', text: 'rework' }] }],
    consumesProof: 'advisory human proof', advisory: { model: 'not an authority' } } as OrderPacket;
}
const selected = { bundleDigest: parentDefRef.bundleDigest,
  definition: { name: parentDefRef.workflowName, steps: [{ callsInterface: { selection: 'invocation' },
    produces: [{ stem: 'child' }] }] } } as unknown as VerifiedDefinitionSelection;

test('parent dynamic source prebinds signed path/version and rechecks pair after selected child', async () => {
  const original = pair();
  const order = nativeOrder(original);
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

test('parent dynamic source refuses changed native identity, selected definition and consumed version before relay', async () => {
  const original = pair();
  const order = nativeOrder(original);
  const badOrders: OrderPacket[] = [
    { ...order, workflow: 'wf_sibling' }, { ...order, run: 'run_sibling' },
    { ...order, step: 'other' }, { ...order, key: 'other' },
    { ...order, index: 1 }, { ...order, defDigest: 'b'.repeat(64) },
    { ...order, workdir: '/other' },
    { ...order, consumedFingerprint: { child: 4 } },
    { ...order, consumes: { child: { ok: false } } },
    { ...order, routing: { ...order.routing!, claim: { ...order.routing!.claim,
      binding: { ...order.routing!.claim.binding, def: { ...order.routing!.claim.binding.def,
	workflowName: 'routing/sibling' } } } } },
  ];
  for (const changed of badOrders) {
    let reads = 0;
    try {
      const source = createParentRoutedInvocationSource({ expected, order: changed, selected,
	pair: original, phase: 'prestart', stillAuthorized: () => true,
	readDirect: async () => { reads++; return receipt; },
	verifyChild: async () => {}, readCurrentPair: async () => original });
      await assert.rejects(async () => source.read(key), /refused/);
    } catch (error) {
      assert.match(String(error), /refused/);
    }
    assert.equal(reads, 0, 'changed authority cannot cause a direct relay read');
  }
});

test('parent dynamic source refuses changed authenticated value, version and signed selection before relay', async () => {
  const original = pair();
  const order = nativeOrder(original);
  const changedValue = structuredClone(original);
  (changedValue.reference as Extract<RoutedReferenceV2, { state: 'available' }>).inputs[0]!.value = { ok: false };
  const changedVersion = structuredClone(original);
  const versionReference = changedVersion.reference as Extract<RoutedReferenceV2, { state: 'available' }>;
  versionReference.inputs[0]!.version = 4;
  versionReference.order.consumedFingerprint = { child: 4 };
  const wrongSelection = { ...selected,
    definition: { ...selected.definition, name: 'routing/sibling' } } as VerifiedDefinitionSelection;
  for (const [observed, choice] of [[changedValue, selected], [changedVersion, selected],
    [original, wrongSelection]] as const) {
    let reads = 0;
    await assert.rejects(async () => {
      const source = createParentRoutedInvocationSource({ expected, order, selected: choice,
	pair: observed, phase: 'prestart', stillAuthorized: () => true,
	readDirect: async () => { reads++; return receipt; },
	verifyChild: async () => {}, readCurrentPair: async () => observed });
      await source.read(key);
    }, /refused|mismatch|malformed/);
    assert.equal(reads, 0);
  }
});
