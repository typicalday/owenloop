import assert from 'node:assert/strict';
import test from 'node:test';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import { parseRoutedInvocationBinding } from '../src/hosted/trusted-routed-invocation.ts';
import type { RecordedBindingV2 } from '../src/hosted/trusted-routed-recorded-v2.ts';

const parentDefRef = { bundleDigest: 'a'.repeat(64), workflowName: 'routing/parent' };
const childDefRef = { bundleDigest: 'b'.repeat(64), workflowName: 'routing/child' };
const key = { parentWorkflow: 'wf_frame', parentDefRef, callPath: 'child', parentArtifactVersion: 3 };
const complete = {
  id: 'inv_1', key: { parentWorkflow: key.parentWorkflow, parentDefRef,
    callPath: key.callPath, evidenceDigest: 'c'.repeat(64) },
  admission: { rootWorkflow: 'wf_root', epoch: 1 },
  selected: { target: 'routing/child@1.0.0', DefRef: childDefRef,
    signature: { inputs: [], outputs: [] } },
  policyDigest: 'd'.repeat(64), candidateSetDigest: 'e'.repeat(64),
};
const receipt = { invocationId: complete.id, parentDefRef, callPath: key.callPath,
  evidenceDigest: complete.key.evidenceDigest, parentArtifactVersion: 3,
  childWorkflow: 'wf_child', childDefRef, childOutcome: 'ok', childOutcomeVersion: 1 };
const prestart = () => ({ protocol: 'owenloop-binding-v1', origin: 'https://service.example', orgId: 'org',
  binding: { id: complete.id, key: complete.key, admission: complete.admission,
    selected: { target: complete.selected.target, DefRef: childDefRef },
    policyDigest: complete.policyDigest, candidateSetDigest: complete.candidateSetDigest },
  bindingJson: JSON.stringify(complete), bindingDigest: valueDigestHex(complete),
  parentDefRef, childDefRef, relay: { receipt, receiptDigest: valueDigestHex(receipt) },
  freshness: 'fresh-at-read', atomicLaunch: false });
const expected = { workflow: 'wf_root', run: 'run_1', origin: 'https://service.example', orgId: 'org' };

test('direct invocation parser accepts exact Service prestart relay and refuses mixed binding or receipt', () => {
  const wire = prestart();
  assert.deepEqual(parseRoutedInvocationBinding(wire, { phase: 'prestart', key, expected }), wire.relay);
  assert.throws(() => parseRoutedInvocationBinding({ ...wire,
    binding: { ...wire.binding, id: 'inv_other' } }, { phase: 'prestart', key, expected }), /refused/);
  const movedReceipt = { ...receipt, evidenceDigest: 'f'.repeat(64) };
  assert.throws(() => parseRoutedInvocationBinding({ ...wire,
    relay: { receipt: movedReceipt, receiptDigest: valueDigestHex(movedReceipt) } },
  { phase: 'prestart', key, expected }), /refused/);
  assert.throws(() => parseRoutedInvocationBinding(wire, { phase: 'prestart',
    key: { ...key, parentArtifactVersion: 4 }, expected }), /refused/);
});

test('recorded invocation parser requires exact occurrence binding and closed response', () => {
  const binding: RecordedBindingV2 = { rootWorkflow: 'wf_root', frameWorkflow: 'wf_frame',
    run: expected.run, claimId: expected.run, decisionId: 'decision', sessionId: 'session',
    shiftId: 'shift', orderDigest: '1'.repeat(64), authorityRevision: '2'.repeat(64),
    rosterRevision: '3'.repeat(64), routingDigest: '4'.repeat(64), preferenceExpiresAt: 100,
    recordedOccurrence: {
    reservationId: 'reservation', reportDigest: 'f'.repeat(64), recordedAt: 2,
    attemptId: 'attempt' } };
  const { binding: invocation, ...rest } = prestart();
  const wire = { ...rest, protocol: 'owenloop-binding-recorded-v2', state: 'available',
    workflow: expected.workflow, run: expected.run, binding, invocation };
  assert.deepEqual(parseRoutedInvocationBinding(wire, { phase: 'recorded-live', key,
    expected: { ...expected, binding } }), wire.relay);
  assert.throws(() => parseRoutedInvocationBinding({ ...wire,
    binding: { ...binding, recordedOccurrence: { ...binding.recordedOccurrence, attemptId: 'other' } } },
  { phase: 'recorded-live', key, expected: { ...expected, binding } }), /refused/);
  assert.equal(parseRoutedInvocationBinding({ protocol: 'owenloop-binding-recorded-v2',
    state: 'unavailable', workflow: expected.workflow, run: expected.run },
  { phase: 'recorded-live', key, expected }), undefined);
  assert.throws(() => parseRoutedInvocationBinding({ protocol: 'owenloop-binding-recorded-v2',
    state: 'unavailable', workflow: expected.workflow, run: expected.run, relay: wire.relay },
  { phase: 'recorded-live', key, expected }), /refused/);
});
