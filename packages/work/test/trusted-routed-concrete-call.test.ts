import assert from 'node:assert/strict';
import { test } from 'node:test';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import { parseRoutedConcreteCallStructure } from '../src/hosted/trusted-routed-concrete-call.ts';
import { parseRoutedConcreteCallBinding } from '../src/hosted/trusted-routed-concrete-binding.ts';

const frameDefRef = { bundleDigest: 'a'.repeat(64), workflowName: 'routing/parent' };
const childDefRef = { bundleDigest: 'b'.repeat(64), workflowName: 'routing/child' };
const binding = { exactSession: 'private' };
const expected = { workflow: 'wf_root', run: 'run_one', origin: 'https://hub.example',
  orgId: 'org_one', binding };
const request = { rootWorkflow: 'wf_root', run: 'run_one', frameWorkflow: 'wf_frame',
  frameDefRef, parentWorkflow: 'wf_frame', ancestry: [],
  edge: { parentDefRef: frameDefRef, callStep: 'delegate', callPath: 'child',
    target: 'routing/child' } };

test('concrete structural reader binds exact native child and rejects a mixed authored edge', () => {
  const receipt = { kind: 'root-bound-concrete-structure', rootWorkflow: 'wf_root',
    frameWorkflow: 'wf_frame', frameDefRef, ancestry: [],
    edge: { ...request.edge, childDefRef, kind: 'selected-native-concrete-child',
      parentWorkflow: 'wf_frame', childWorkflow: 'wf_child' } };
  const wire = { protocol: 'owenloop-concrete-call-structure-v1', state: 'available',
    workflow: expected.workflow, run: expected.run, origin: expected.origin,
    orgId: expected.orgId, binding, selected: { receipt,
      receiptDigest: valueDigestHex(receipt) }, freshness: 'fresh-at-read', atomicLaunch: false };
  assert.deepEqual(parseRoutedConcreteCallStructure(wire, { request, phase: 'prestart', expected }),
    { kind: 'selected-native-concrete-child', childDefRef,
      parentWorkflow: 'wf_frame', childWorkflow: 'wf_child',
      receiptDigest: valueDigestHex(receipt) });
  const wrong = structuredClone(wire);
  wrong.selected.receipt.edge.callPath = 'other';
  wrong.selected.receiptDigest = valueDigestHex(wrong.selected.receipt);
  assert.throws(() => parseRoutedConcreteCallStructure(wrong,
    { request, phase: 'prestart', expected }), /refused/);
  const wrongBinding = { ...wire, binding: { exactSession: 'rotated' } };
  assert.throws(() => parseRoutedConcreteCallStructure(wrongBinding,
    { request, phase: 'prestart', expected }), /refused/);
});

test('folded concrete reader accepts one selected proof and refuses altered version or proof envelope', () => {
  const key = { parentWorkflow: 'wf_frame', parentDefRef: frameDefRef,
    callPath: 'child', parentArtifactVersion: 3 };
  const receipt = { kind: 'concrete-call', ...key, callStep: 'delegate',
    childWorkflow: 'wf_child', childDefRef, childOutcome: 'result',
    childOutcomeVersion: 1, foldedValueDigest: 'c'.repeat(64) };
  const wire = { protocol: 'owenloop-concrete-call-v1', state: 'available',
    workflow: expected.workflow, run: expected.run, origin: expected.origin,
    orgId: expected.orgId, binding, selected: { receipt,
      receiptDigest: valueDigestHex(receipt), proof: '{"signed":"child"}' },
    freshness: 'fresh-at-read', atomicLaunch: false };
  assert.deepEqual(parseRoutedConcreteCallBinding(wire,
    { key, phase: 'prestart', expected }), wire.selected);
  const moved = { ...receipt, parentArtifactVersion: 4 };
  assert.throws(() => parseRoutedConcreteCallBinding({ ...wire,
    selected: { ...wire.selected, receipt: moved, receiptDigest: valueDigestHex(moved) } },
  { key, phase: 'prestart', expected }), /refused/);
  assert.throws(() => parseRoutedConcreteCallBinding({ ...wire,
    selected: { ...wire.selected, extra: 'untrusted' } },
  { key, phase: 'prestart', expected }), /refused/);
});

test('nested concrete reader binds the prior observed edge digest, not only its signed child', () => {
  const observedPrior = { parentDefRef: frameDefRef, callStep: 'outer', callPath: 'outer',
    target: 'routing/child', childDefRef, kind: 'selected-native-concrete-child',
    parentWorkflow: 'wf_frame', childWorkflow: 'wf_child' };
  const priorReceipt = { kind: 'root-bound-concrete-structure', rootWorkflow: 'wf_root',
    frameWorkflow: 'wf_frame', frameDefRef, ancestry: [], edge: observedPrior };
  const prior = { parentDefRef: frameDefRef, callStep: 'outer', callPath: 'outer',
    target: 'routing/child', childDefRef, selectionSource: 'service-observed' as const,
    receiptDigest: valueDigestHex(priorReceipt) };
  const nested = { ...request, ancestry: [prior], parentWorkflow: 'wf_child' };
  const receipt = { kind: 'root-bound-concrete-structure', rootWorkflow: 'wf_root',
    frameWorkflow: 'wf_frame', frameDefRef,
    ancestry: [observedPrior],
    edge: { ...request.edge, childDefRef, kind: 'selected-native-concrete-child',
      parentWorkflow: 'wf_child', childWorkflow: 'wf_grandchild' } };
  const wire = { protocol: 'owenloop-concrete-call-structure-v1', state: 'available',
    workflow: expected.workflow, run: expected.run, origin: expected.origin,
    orgId: expected.orgId, binding, selected: { receipt,
      receiptDigest: valueDigestHex(receipt) }, freshness: 'fresh-at-read', atomicLaunch: false };
  assert.equal(parseRoutedConcreteCallStructure(wire,
    { request: nested, phase: 'prestart', expected }).kind, 'selected-native-concrete-child');
  assert.throws(() => parseRoutedConcreteCallStructure(wire,
    { request: { ...nested, ancestry: [{ ...prior, receiptDigest: undefined }] },
      phase: 'prestart', expected }), /refused/);
  const moved = structuredClone(wire);
  moved.selected.receipt.ancestry[0]!.childWorkflow = 'wf_other_native_child';
  moved.selected.receiptDigest = valueDigestHex(moved.selected.receipt);
  assert.throws(() => parseRoutedConcreteCallStructure(moved,
    { request: nested, phase: 'prestart', expected }), /refused/);
});

test('static signed ancestry needs no prior structural receipt', () => {
  const prior = { parentDefRef: frameDefRef, callStep: 'locked', callPath: 'locked',
    target: 'pkg@1#child', childDefRef, selectionSource: 'signed-static' as const };
  const nested = { ...request, ancestry: [prior], parentWorkflow: 'wf_child' };
  const receipt = { kind: 'root-bound-concrete-structure', rootWorkflow: 'wf_root',
    frameWorkflow: 'wf_frame', frameDefRef,
    ancestry: [{ parentDefRef: prior.parentDefRef, callStep: prior.callStep,
      callPath: prior.callPath, target: prior.target, childDefRef: prior.childDefRef,
      kind: 'selected-native-concrete-child', parentWorkflow: 'wf_frame',
      childWorkflow: 'wf_child' }],
    edge: { ...request.edge, childDefRef, kind: 'selected-native-concrete-child',
      parentWorkflow: 'wf_child', childWorkflow: 'wf_grandchild' } };
  const wire = { protocol: 'owenloop-concrete-call-structure-v1', state: 'available',
    workflow: expected.workflow, run: expected.run, origin: expected.origin,
    orgId: expected.orgId, binding, selected: { receipt,
      receiptDigest: valueDigestHex(receipt) }, freshness: 'fresh-at-read', atomicLaunch: false };
  assert.equal(parseRoutedConcreteCallStructure(wire,
    { request: nested, phase: 'prestart', expected }).kind, 'selected-native-concrete-child');
});
