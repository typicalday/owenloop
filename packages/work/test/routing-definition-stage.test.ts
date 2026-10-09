import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRoutedDefinitionMaintenance, stageRoutedDefinition } from '../src/shift/routing-definition-stage.ts';
import { RoutedInputWitnessRefusal } from '../src/shift/routing-input-refusal.ts';
import { bindTrustedRoutedInputV2 } from '../src/hosted/trusted-input-admission.ts';
import { createConsumedVerifier } from '../src/consumed-verifier.ts';
import { createStoreInstructionResolver } from '../src/exec/instructions.ts';
import { openRoutingRoleStage } from '../src/roles/routing-role-stage.ts';
import { routedProducerVerifier } from '../src/roles/routing-producer-verifier.ts';
import type { RoutingHandoffV1 } from '../src/shift/runtime.ts';
import { HubError, type GetOrderResponse, type WorkOrder } from '../src/hub/types.ts';
import { packBundle } from '../../../src/bundle/index.ts';
import { canonicalJsonBytes } from '../../../src/install.ts';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import type { RoutedClaimV2, RoutedReferenceV2 } from '../src/hosted/trusted-routed-reference-v2.ts';
import type { OrderPacket, ReferenceRouting } from '../src/hub/types.ts';
import { DSSE_SSH_NAMESPACE, dsseSignPublication, dsseSignSubmission } from '../../../src/crypto/dsse.ts';
import { createSshSigner } from '../../../src/crypto/ssh.ts';
import { publicKeyDescriptor } from '../../../src/crypto/keys.ts';
import { writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import { createBundleIngestor, createStoreInstructionSource,
  globalStoreRoot } from '../../../src/store/index.ts';

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const workflow = 'name: recovered\ninputs: []\nsteps:\n  - name: command\n    consumes: []\n    produces: [out]\n    terminal: true\n    command: echo recovered\n';

async function fixture(workflowSource = workflow, bundleSource?: string) {
  const home = temp('routing-stage-home-');
  const stateDir = temp('routing-stage-state-');
  const workRoot = temp('routing-stage-work-');
  const packed = packBundle(bundleSource ?? writeBundleSource({ name: 'recovered', workflow: workflowSource }));
  const keyPath = join(home, 'publisher');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], { stdio: 'ignore' });
  const publicKey = publicKeyDescriptor(readFileSync(`${keyPath}.pub`, 'utf8'));
  const config = join(home, '.owenloop');
  mkdirSync(config, { mode: 0o700 });
  writeFileSync(join(config, 'allowed_signers'), `publisher ${publicKey.openSshPublicKey}\n`, { mode: 0o600 });
  writeFileSync(join(config, 'credentials.json'), 'private-credential-marker', { mode: 0o600 });
  const signer = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath: keyPath });
  const signed = await dsseSignPublication(Buffer.from(canonicalJsonBytes({
    digest: packed.digest, name: packed.manifest.package.name,
    version: packed.manifest.package.version, publisherKeyId: publicKey.keyid, timestamp: Date.now(),
  })), signer);
  const publication = canonicalJsonBytes(signed.envelope);
  const order: WorkOrder = { workflow: 'wf', run: 'run', step: 'command', worker: 'command',
    defDigest: packed.digest, consumes: {}, expected_outputs: [], feedback: [], advisory: {}, submit_hint: '' };
  const seen: string[] = [];
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    if (path === `/api/bundles/${packed.digest}`) return new Response(packed.bytes, { status: 200 });
    if (path === `/api/publications/${packed.digest}`) return new Response(publication, { status: 200,
      headers: { 'x-owenloop-publication-state': 'signed' } });
    if (path === `/api/origins/${packed.digest}`) return new Response(null, { status: 404 });
    throw new Error('unexpected request');
  };
  const args = { order, rootWorkflow: 'wf', origin: 'https://hub.example', token: 'secret-marker', stateDir, workRoot,
    sourceEnv: { HOME: home }, beforeRequest: () => {}, onRateLimit: (_error: HubError) => {},
    stillAuthorized: () => true, fetchImpl };
  return { args, config, home, stateDir, seen, packed, keyPath, publicKey };
}

function mixedNamespaceSource(): string {
  const root = temp('routing-mixed-namespace-');
  writeFileSync(join(root, 'bundle.yaml'), [
    'formatVersion: 2', 'package:', '  name: routing', '  version: 1.0.0',
    'workflows:', '  "routing/parent": "parent.yaml"', '  "other/child": "child.yaml"',
    'default: "routing/parent"', 'platforms: []', 'integrity:',
    '  algorithm: sha256', '  files: {}', 'capabilities: {}', 'lock: {}', '',
  ].join('\n'));
  writeFileSync(join(root, 'parent.yaml'), 'name: routing/parent\ninputs: []\nsteps:\n' +
    '  - name: command\n    consumes: []\n    produces: [out]\n' +
    '    terminal: true\n    command: echo parent\n');
  writeFileSync(join(root, 'child.yaml'), 'name: other/child\ninputs: []\nsteps:\n' +
    '  - name: child\n    consumes: []\n    produces: [other]\n' +
    '    terminal: true\n    command: echo child\n');
  return root;
}

function duplicateStepSource(): string {
  const root = temp('routing-duplicate-step-');
  writeFileSync(join(root, 'bundle.yaml'), [
    'formatVersion: 2', 'package:', '  name: routing', '  version: 1.0.0',
    'workflows:', '  "routing/parent": parent.yaml', '  "routing/child": child.yaml',
    'default: "routing/parent"', 'platforms: []', 'integrity:',
    '  algorithm: sha256', '  files: {}', 'capabilities: {}', 'lock: {}', '',
  ].join('\n'));
  writeFileSync(join(root, 'parent.yaml'), 'name: routing/parent\ninputs: []\nsteps:\n' +
    '  - name: build\n    executor: command\n    consumes: []\n' +
    '    produces: [parent-out]\n    terminal: true\n    command: echo parent\n' +
    'outputs: [parent-out]\n');
  writeFileSync(join(root, 'child.yaml'), 'name: routing/child\ninputs: []\nsteps:\n' +
    '  - name: build\n    executor: command\n    consumes: []\n' +
    '    produces: [child-out]\n    terminal: true\n    command: echo child\n' +
    'outputs: [child-out]\n');
  return root;
}

test('routed signed selector chooses exact child among same-step siblings', async () => {
  const f = await fixture(workflow, duplicateStepSource());
  const binding = { runId: 'wf_root', frameId: 'wf_child_instance',
    def: { bundleDigest: `sha256:${f.packed.digest}`, workflowName: 'routing/child' } };
  const routing = { claim: { claimId: 'run', orderId: 'run', binding },
    decision: { binding } } as unknown as ReferenceRouting;
  const original = { ...f.args.order, workflow: 'wf_child_instance', step: 'build', routing };
  const stage = await stageRoutedDefinition({ ...f.args, rootWorkflow: 'wf_root', order: original });
  try {
    const packet: OrderPacket = { workflow: 'wf_child_instance', run: 'run', step: 'build',
      key: '', defDigest: f.packed.digest, worker: 'command', inputs: [], outputs: ['child-out'],
      consumes: {}, owes: [{ path: 'child-out', judgmentRejects: 0,
	schemaRejects: 0, reasons: [] }], routing };
    assert.equal(await stage.commandFor!(packet), 'echo child');
    assert.equal(stage.canSubmit(packet, 'child-out'), true);
    assert.equal(stage.canSubmit(packet, 'parent-out'), false);
    const parentClaim = structuredClone(routing);
    parentClaim.claim.binding.def.workflowName = 'routing/parent';
    parentClaim.decision.binding.def.workflowName = 'routing/parent';
    const wrongSibling = { ...packet, outputs: ['parent-out'],
      owes: [{ path: 'parent-out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
      routing: parentClaim };
    assert.equal(stage.canSubmit(wrongSibling, 'parent-out'), false);
    await assert.rejects(stage.commandFor!(wrongSibling), /routed command definition refused/);
    await assert.rejects(stage.commandFor!({ ...packet, run: 'other_run' }),
      /routed command definition refused/);
    const response: GetOrderResponse = { text: '', workflow: 'wf_child_instance', run: 'run',
      lease: { claimed: true }, order: packet };
    await stage.verifyOrder(response);
    await assert.rejects(stage.verifyOrder({ ...response, order: wrongSibling }),
      /routed order changed/);
    writeFileSync(join(f.config, 'allowed_signers'), '', { mode: 0o600 });
    await assert.rejects(stage.verifyOrder(response), /routed definition trust changed/);
    const handoff = { definitionStage: { path: stage.path, digest: stage.digest },
      reservation: { workflow: 'wf_root', run: 'run' } } as RoutingHandoffV1;
    const opened = openRoutingRoleStage(handoff);
    assert.equal(opened.definitionName, 'routing/child');
    const command = await opened.instructions.resolveCommand(packet);
    assert.equal(command.ok, true);
    if (command.ok) assert.equal(command.command, 'echo child');
    const ordinary = createStoreInstructionSource({ globalRoot: globalStoreRoot(opened.publicEnv.HOME!),
      verifier: createBundleIngestor() });
    assert.equal(await ordinary.prime(f.packed.digest), 'resolved');
    assert.equal(ordinary.lookup({ defDigest: f.packed.digest, step: 'build', key: '' }).status,
      'ambiguous-step');
  } finally { stage.cleanup(); }
});

test('parent current stage refuses changed signed command bytes before a postrun consequence', async () => {
  const f = await fixture();
  const binding = { runId: 'wf_root', frameId: 'wf_child',
    def: { bundleDigest: `sha256:${f.packed.digest}`, workflowName: 'recovered' } };
  const routing = { claim: { claimId: 'run', orderId: 'run', binding },
    decision: { binding } } as unknown as ReferenceRouting;
  const stage = await stageRoutedDefinition({ ...f.args, rootWorkflow: 'wf_root',
    order: { ...f.args.order, workflow: 'wf_child', routing } });
  try {
    const packet: OrderPacket = { workflow: 'wf_child', run: 'run', step: 'command', key: '',
      defDigest: f.packed.digest, worker: 'command', inputs: [], outputs: ['out'], consumes: {},
      owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }], routing };
    const response: GetOrderResponse = { text: '', workflow: 'wf_child', run: 'run',
      lease: { claimed: true }, order: packet };
    await stage.verifyOrder(response);
    const object = join(globalStoreRoot(join(stage.path, 'home')), 'objects', 'sha256',
      f.packed.digest, 'workflow.yaml');
    chmodSync(object, 0o600);
    writeFileSync(object, workflow.replace('echo recovered', 'echo changed'));
    await assert.rejects(stage.verifyOrder(response),
      /routed definition object changed|routed signed selection changed/);
    assert.equal(await stage.commandFor!(packet), 'echo recovered',
      'captured command alone cannot authorize a parent postrun');
  } finally { stage.cleanup(); }
});

test('parent final signed selection refuses a source move during awaited dynamic relay', async () => {
  const parent = `name: routing/parent
inputs: [{name: data, seedOwed: true}]
steps:
  - name: delegate
    callsInterface:
      name: report
      version: '1'
      selection: invocation
      signature:
${'        inputs: [{name: data, schema: true}]'}
${'        outputs: [{name: result, schema: true}]'}
      policy: {name: deterministic, version: '1', config: {}}
    inputs: {data: data}
    produces: [child]
  - name: command
    executor: command
    consumes: [child]
    produces: [out]
    terminal: true
    command: echo original
outputs: [out]
`;
  const child = `name: routing/child
x:
  implements: [{name: report, version: '1'}]
inputs: [{name: data, schema: true}]
steps:
  - name: work
    consumes: [data]
    produces: [{name: result, schema: true}]
    terminal: true
outputs: [result]
`;
  const bundle = temp('routing-dynamic-selection-');
  writeFileSync(join(bundle, 'bundle.yaml'), [
    'formatVersion: 2', 'package:', '  name: routing', '  version: 1.0.0',
    'workflows:', '  "routing/parent": parent.yaml', '  "routing/child": child.yaml',
    'default: "routing/parent"', 'platforms: []', 'integrity:',
    '  algorithm: sha256', '  files: {}', 'capabilities: {}', 'lock: {}', '',
  ].join('\n'));
  writeFileSync(join(bundle, 'parent.yaml'), parent);
  writeFileSync(join(bundle, 'child.yaml'), child);
  const f = await fixture(parent, bundle);
  writeFileSync(join(f.config, 'org-root.pub'), readFileSync(`${f.keyPath}.pub`), { mode: 0o600 });
  const value = { result: 'signed-child' };
  const signer = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath: f.keyPath });
  const signedProof = await dsseSignSubmission(Buffer.from(JSON.stringify({
    run: 'child-run', workflow: 'wf_nested', defDigest: f.packed.digest,
    step: 'work', key: '', produced: [{ artifact: 'result', version: 1,
      valueDigest: valueDigestHex(value) }], consumedFingerprint: {},
    producerKeyId: f.publicKey.keyid, timestamp: 10,
  })), signer);
  signer.dispose();
  const binding = { runId: 'wf_root', frameId: 'wf_frame',
    def: { bundleDigest: `sha256:${f.packed.digest}`, workflowName: 'routing/parent' } };
  const routing = { claim: { claimId: 'run', orderId: 'run', decisionId: 'decision',
    sessionId: 'rs_12345678-1234-1234-1234-123456789abc', shiftId: 'shf_service',
    attemptId: 'attempt', binding }, decision: { decisionId: 'decision', binding },
    preference: { rosterRevision: 'a'.repeat(64), expiresAt: Date.now() + 60_000 },
  } as unknown as ReferenceRouting;
  const packet: OrderPacket = { workflow: 'wf_frame', run: 'run', step: 'command', key: '',
    defDigest: f.packed.digest, worker: 'command', inputs: ['child'], outputs: ['out'],
    consumes: { child: value }, consumedFingerprint: { child: 1 },
    consumesProof: JSON.stringify({ child: JSON.stringify(signedProof.envelope) }),
    consumesProofRelay: { child: { childDefDigest: f.packed.digest, childVersion: 1,
      childOutcome: 'result' } },
    owes: [{ path: 'out', version: 1, judgmentRejects: 0, schemaRejects: 0,
      reasons: [] }], routing };
  const referenceBinding = { rootWorkflow: 'wf_root', frameWorkflow: 'wf_frame', run: 'run',
    claimId: 'run', decisionId: 'decision', sessionId: routing.claim.sessionId,
    shiftId: routing.claim.shiftId, orderDigest: 'b'.repeat(64),
    authorityRevision: 'c'.repeat(64), rosterRevision: routing.preference.rosterRevision,
    routingDigest: valueDigestHex(routing), preferenceExpiresAt: routing.preference.expiresAt };
  const pair: { reference: RoutedReferenceV2; claim: RoutedClaimV2 } = {
    reference: { protocol: 'trusted-routed-reference-read-v2', state: 'available',
      workflow: 'wf_root', run: 'run', order: { ...packet, owes: [{ path: 'out', version: 1 }] },
      inputs: [{ path: 'child', version: 1, present: true, value }],
      lease: { claimed: true }, binding: referenceBinding },
    claim: { protocol: 'routing-claim-read-v2', state: 'available',
      workflow: 'wf_root', run: 'run', routing, binding: referenceBinding },
  };
  const relayReceipt = { invocationId: 'inv',
    parentDefRef: { bundleDigest: f.packed.digest, workflowName: 'routing/parent' },
    callPath: 'child', evidenceDigest: 'd'.repeat(64), parentArtifactVersion: 1,
    childWorkflow: 'wf_nested', childDefRef: { bundleDigest: f.packed.digest,
      workflowName: 'routing/child' }, childOutcome: 'result', childOutcomeVersion: 1 };
  const relay = { receipt: relayReceipt, receiptDigest: valueDigestHex(relayReceipt) };
  let pause = false;
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const stage = await stageRoutedDefinition({ ...f.args, rootWorkflow: 'wf_root',
    order: { ...f.args.order, workflow: 'wf_frame', step: 'command',
      consumes: { child: value }, consumedFingerprint: { child: 1 }, routing },
    readCurrentPair: async () => pair,
    readInvocationBinding: async () => {
      if (pause) { entered(); await resume; }
      return relay;
    } });
  try {
    const response: GetOrderResponse = { text: '', workflow: 'wf_frame', run: 'run',
      lease: { claimed: true }, order: packet };
    await stage.verifyRoutedInput!(response, pair, 'prestart');
    pause = true;
    const pending = stage.verifyRoutedInput!(response, pair, 'prestart');
    try {
      const enteredBeforeReturn = await Promise.race([
	waiting.then(() => true), pending.then(() => false, () => false),
      ]);
      assert.equal(enteredBeforeReturn, true, 'the current check awaits the direct relay');
      const object = join(globalStoreRoot(join(stage.path, 'home')), 'objects', 'sha256',
	f.packed.digest, 'parent.yaml');
      chmodSync(object, 0o600);
      writeFileSync(object, parent.replace('echo original', 'echo moved'));
    } finally { release(); }
    await assert.rejects(pending, /routed signed selection changed|routed definition object changed|routed input witness refused/);
    assert.equal(await stage.commandFor!(packet), 'echo original',
      'captured command is data; refused parent verification cannot authorize signing');
  } finally { stage.cleanup(); }
});

test('signed routed command definition admits human seed only through the current v2 witness', async () => {
  const f = await fixture('name: recovered\ninputs:\n  - name: seed\n    seedOwed: true\n' +
    'steps:\n  - name: command\n    executor: command\n    consumes: [seed]\n' +
    '    produces: [out]\n    terminal: true\n    command: echo recovered\n');
  const binding = { runId: 'wf_root', frameId: 'wf_child',
    def: { bundleDigest: `sha256:${f.packed.digest}`, workflowName: 'recovered' } };
  const routing = { claim: { claimId: 'run', orderId: 'run', binding,
    sessionId: 'rs_12345678-1234-1234-1234-123456789abc', shiftId: 'shf_service' },
    decision: { decisionId: 'decision', binding },
    preference: { rosterRevision: 'a'.repeat(64), expiresAt: Date.now() + 60_000 },
  } as unknown as ReferenceRouting;
  const stage = await stageRoutedDefinition({ ...f.args, rootWorkflow: 'wf_root',
    order: { ...f.args.order, workflow: 'wf_child', routing } });
  try {
    const packet: OrderPacket = { workflow: 'wf_child', run: 'run', step: 'command', key: '',
      defDigest: f.packed.digest, worker: 'command', inputs: ['seed'], outputs: ['out'],
      consumes: { seed: 'human-value' }, consumedFingerprint: { seed: 1 },
      owes: [{ path: 'out', version: 1, judgmentRejects: 0, schemaRejects: 0,
	reasons: [] }], routing };
    const handoff = { definitionStage: { path: stage.path, digest: stage.digest },
      reservation: { workflow: 'wf_root', run: 'run' } } as RoutingHandoffV1;
    const opened = openRoutingRoleStage(handoff);
    const unselected = createStoreInstructionResolver({
      globalRoot: globalStoreRoot(opened.publicEnv.HOME!), verifier: createBundleIngestor(),
    });
    const withoutParentSelection = await unselected.resolveRoutedCommandDefinition!(packet);
    assert.equal(withoutParentSelection.ok, false);
    if (!withoutParentSelection.ok) assert.equal(withoutParentSelection.kind, 'integrity');
    const legacy = await opened.instructions.resolveCommand(packet);
    assert.equal(legacy.ok, false);
    if (!legacy.ok) assert.equal(legacy.kind, 'unverified-consumed');
    const signed = await opened.instructions.resolveRoutedCommandDefinition!(packet);
    assert.equal(signed.ok, true, JSON.stringify(signed));
    if (signed.ok) {
      assert.equal(signed.command, 'echo recovered');
      assert.equal(signed.inputWitnessRequired, true);
      assert.equal(await signed.revalidate?.(), undefined);
      assert.equal(await signed.revalidateAfterRun?.(), undefined);
    }
    const referenceBinding = { rootWorkflow: 'wf_root', frameWorkflow: 'wf_child', run: 'run',
      claimId: 'run', decisionId: 'decision', sessionId: routing.claim.sessionId,
      shiftId: routing.claim.shiftId, orderDigest: 'b'.repeat(64),
      authorityRevision: 'c'.repeat(64), rosterRevision: routing.preference.rosterRevision,
      routingDigest: valueDigestHex(routing), preferenceExpiresAt: routing.preference.expiresAt };
    const pair: { reference: RoutedReferenceV2; claim: RoutedClaimV2 } = {
      reference: { protocol: 'trusted-routed-reference-read-v2', state: 'available',
	workflow: 'wf_root', run: 'run', order: { ...packet,
	  owes: [{ path: 'out', version: 1 }] } as unknown as OrderPacket,
	inputs: [{ path: 'seed', version: 1, present: true, value: 'human-value' }],
	lease: { claimed: true }, binding: referenceBinding },
      claim: { protocol: 'routing-claim-read-v2', state: 'available',
	workflow: 'wf_root', run: 'run', routing, binding: referenceBinding },
    };
    const admitted = await bindTrustedRoutedInputV2({ phase: 'prestart', pair,
      privateOrder: packet, instructions: opened.instructions,
      consumedVerifier: createConsumedVerifier({ env: opened.publicEnv,
	now: Date.now, artifactPolicy: 'enforce' }),
      expected: { workflow: 'wf_root', run: 'run' } });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    const forgedProducer = await bindTrustedRoutedInputV2({ phase: 'prestart', pair,
      privateOrder: { ...packet, consumesProof: '{"producer":"forged"}' },
      instructions: opened.instructions,
      consumedVerifier: createConsumedVerifier({ env: opened.publicEnv,
	now: Date.now, artifactPolicy: 'enforce' }),
      expected: { workflow: 'wf_root', run: 'run' } });
    assert.equal(forgedProducer.ok, false);
    const moved = structuredClone(pair);
    if (moved.reference.state !== 'available') assert.fail('missing reference');
    moved.reference.inputs[0]!.value = 'changed';
    const refused = await bindTrustedRoutedInputV2({ phase: 'prestart', pair: moved,
      privateOrder: packet, instructions: opened.instructions,
      consumedVerifier: createConsumedVerifier({ env: opened.publicEnv,
	now: Date.now, artifactPolicy: 'enforce' }),
      expected: { workflow: 'wf_root', run: 'run' } });
    assert.equal(refused.ok, false);
    if (signed.ok) {
      writeFileSync(join(stage.path, 'public', 'allowed_signers'), '', { mode: 0o600 });
      const postrun = await signed.revalidateAfterRun?.();
      assert.equal(postrun?.ok, false);
      if (postrun) assert.equal(postrun.kind, 'unverified-def');
    }
  } finally { stage.cleanup(); }
});

for (const worker of ['command', 'agent'] as const) {
  test(`routed ${worker} v2 admits a human-consumed dotted cwd before producer filtering`, async () => {
    const source = 'name: recovered\ninputs:\n  - name: seed\n    seedOwed: true\n' +
      'steps:\n  - name: build\n    consumes: [seed]\n    produces: [out]\n' +
      '    terminal: true\n    workdirFrom: seed.payload.path\n' +
      (worker === 'command' ? '    executor: command\n    command: echo routed\n'
	: '    body: "Continue routed work"\n');
    const f = await fixture(source);
    const binding = { runId: 'wf_root', frameId: 'wf_child',
      def: { bundleDigest: `sha256:${f.packed.digest}`, workflowName: 'recovered' } };
    const routing = { claim: { claimId: 'run', orderId: 'run', decisionId: 'decision',
      sessionId: 'rs_12345678-1234-1234-1234-123456789abc', shiftId: 'shf_service',
      attemptId: 'attempt', binding }, decision: { decisionId: 'decision', binding },
      preference: { rosterRevision: 'a'.repeat(64), expiresAt: Date.now() + 60_000 },
    } as unknown as ReferenceRouting;
    const native = { ...f.args.order, workflow: 'wf_child', step: 'build', worker, routing };
    const stage = await stageRoutedDefinition({ ...f.args, rootWorkflow: 'wf_root', order: native });
    try {
      const seed = { payload: { path: f.args.workRoot } };
      const packet: OrderPacket = { workflow: 'wf_child', run: 'run', step: 'build', key: '',
	defDigest: f.packed.digest, worker, workdir: f.args.workRoot,
	inputs: ['seed'], outputs: ['out'], consumes: { seed }, consumedFingerprint: { seed: 1 },
	owes: [{ path: 'out', version: 1, judgmentRejects: 0, schemaRejects: 0, reasons: [] }], routing };
      const opened = openRoutingRoleStage({ definitionStage: { path: stage.path, digest: stage.digest },
	reservation: { workflow: 'wf_root', run: 'run' } } as RoutingHandoffV1);
      const full = await opened.instructions.resolveHostedStep!(packet);
      assert.equal(full.ok, true, JSON.stringify(full));
      const filtered = { ...packet, consumes: {}, consumedFingerprint: {} };
      const oldReresolution = await opened.instructions.resolveHostedStep!(filtered);
      assert.equal(oldReresolution.ok, false, 'old wrapper re-resolves a producer-only packet');
      const referenceBinding = { rootWorkflow: 'wf_root', frameWorkflow: 'wf_child', run: 'run',
	claimId: 'run', decisionId: 'decision', sessionId: routing.claim.sessionId,
	shiftId: routing.claim.shiftId, orderDigest: 'b'.repeat(64),
	authorityRevision: 'c'.repeat(64), rosterRevision: routing.preference.rosterRevision,
	routingDigest: valueDigestHex(routing), preferenceExpiresAt: routing.preference.expiresAt };
      const pair: { reference: RoutedReferenceV2; claim: RoutedClaimV2 } = {
	reference: { protocol: 'trusted-routed-reference-read-v2', state: 'available',
	  workflow: 'wf_root', run: 'run', order: { ...packet,
	    owes: [{ path: 'out', version: 1 }] } as unknown as OrderPacket,
	  inputs: [{ path: 'seed', version: 1, present: true, value: seed }],
	  lease: { claimed: true }, binding: referenceBinding },
	claim: { protocol: 'routing-claim-read-v2', state: 'available',
	  workflow: 'wf_root', run: 'run', routing, binding: referenceBinding },
      };
      const consumed = routedProducerVerifier(createConsumedVerifier({
	env: opened.publicEnv, now: Date.now, artifactPolicy: 'enforce' }));
      const admitted = await bindTrustedRoutedInputV2({ phase: 'prestart', pair,
	privateOrder: packet, instructions: opened.instructions, consumedVerifier: consumed,
	expected: { workflow: 'wf_root', run: 'run' } });
      assert.equal(admitted.ok, true, JSON.stringify(admitted));
      const moved = structuredClone(pair);
      if (moved.reference.state !== 'available') assert.fail('missing reference');
      moved.reference.inputs[0]!.value = { payload: { path: f.args.stateDir } };
      const refused = await bindTrustedRoutedInputV2({ phase: 'prestart', pair: moved,
	privateOrder: packet, instructions: opened.instructions, consumedVerifier: consumed,
	expected: { workflow: 'wf_root', run: 'run' } });
      assert.equal(refused.ok, false);
    } finally { stage.cleanup(); }
  });
}

test('mixed authored namespace origin rule applies at staging and fresh verifyOrder', async () => {
  const f = await fixture(workflow, mixedNamespaceSource());
  writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ originRules: { routing: 'any', other: 'git' } }));
  await assert.rejects(stageRoutedDefinition(f.args), /routed definition staging refused/);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);

  writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ originRules: { routing: 'any', other: 'any' } }));
  const stage = await stageRoutedDefinition(f.args);
  const response: GetOrderResponse = { text: '', workflow: 'wf', run: 'run', lease: { claimed: true },
    order: { workflow: 'wf', run: 'run', step: 'command', key: '', defDigest: f.packed.digest,
      worker: 'command', inputs: [], outputs: ['out'], consumes: {},
      owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }] } };
  await stage.verifyOrder(response);
  writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ originRules: { routing: 'any', other: 'git' } }));
  await assert.rejects(stage.verifyOrder(response), /routed definition origin changed/);
  stage.cleanup();
});

test('routed staging keeps signed exact bytes and public trust private without mutating ordinary store', async () => {
  const f = await fixture();
  const stage = await stageRoutedDefinition(f.args);
  assert.equal(stage.digest, f.packed.digest);
  assert.deepEqual(f.seen, [
    `/api/bundles/${f.packed.digest}`, `/api/publications/${f.packed.digest}`, `/api/origins/${f.packed.digest}`,
  ]);
  assert.equal(existsSync(join(stage.path, 'public', 'allowed_signers')), true);
  assert.equal(existsSync(join(stage.path, 'public', 'credentials.json')), false);
  assert.equal(existsSync(join(f.home, '.owenloop', 'store')), false);
  const descriptor = JSON.parse(readFileSync(join(stage.path, 'stage.json'), 'utf8'));
  assert.equal(descriptor.digest, f.packed.digest);
  assert.equal(JSON.stringify(descriptor).includes('secret-marker'), false);
  stage.cleanup();
  assert.equal(existsSync(stage.path), false);
});

test('parent full-order gate rechecks current publication trust and actual workdir', async () => {
  const f = await fixture();
  let prestartAuthorized = true;
  const stage = await stageRoutedDefinition({ ...f.args, stillAuthorized: () => prestartAuthorized });
  const response: GetOrderResponse = { text: '', workflow: 'wf', run: 'run', lease: { claimed: true },
    order: { workflow: 'wf', run: 'run', step: 'command', key: '', defDigest: f.packed.digest,
      worker: 'command', inputs: [], outputs: ['out'], consumes: {},
      owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }] } };
  await stage.verifyOrder(response);
  prestartAuthorized = false;
  await stage.verifyOrder(response); // Broker, not pre-start preference, gates the live original session.
  assert.equal(stage.canReplay(response.order!, 'out'), true);
  await assert.rejects(stage.verifyOrder({ ...response, order: { ...response.order!, workdir: stage.path } }),
    /routed workdir overlaps definition trust/);
  writeFileSync(join(f.config, 'allowed_signers'), '', { mode: 0o600 });
  await assert.rejects(stage.verifyOrder(response), /routed definition trust changed|routed command definition refused/);
  stage.cleanup();
});

test('parent full-order gate refuses input-derived workdir without an authenticated input witness', async () => {
  const f = await fixture('name: recovered\ninputs:\n  - name: target\nsteps:\n  - name: command\n' +
    '    consumes: []\n    produces: [out]\n    terminal: true\n' +
    '    workdirFrom: target.path\n    command: echo recovered\n');
  const stage = await stageRoutedDefinition(f.args);
  const response: GetOrderResponse = { text: '', workflow: 'wf', run: 'run', lease: { claimed: true },
    order: { workflow: 'wf', run: 'run', step: 'command', key: '', defDigest: f.packed.digest,
      worker: 'command', workdir: f.args.workRoot, inputs: [], outputs: ['out'], consumes: {},
      owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }] } };
  await assert.rejects(stage.verifyOrder(response), /routed workdir witness unavailable/);
  stage.cleanup();
});

test('parent signed stage admits an exact Service input-derived cwd witness and refuses changed values', async () => {
  const f = await fixture('name: recovered\ninputs:\n  - name: target\nsteps:\n  - name: command\n' +
    '    executor: command\n    consumes: []\n    produces: [out]\n    terminal: true\n' +
    '    workdirFrom: target.path\n    command: echo recovered\n');
  const signedBinding = { runId: 'wf', frameId: 'wf_child_instance',
    def: { bundleDigest: `sha256:${f.packed.digest}`, workflowName: 'recovered' } };
  const routing = { claim: { claimId: 'run', orderId: 'run', decisionId: 'decision',
    sessionId: 'rs_12345678-1234-1234-1234-123456789abc', shiftId: 'shf_service',
    attemptId: 'attempt', binding: signedBinding },
  decision: { decisionId: 'decision', binding: signedBinding },
  preference: { rosterRevision: 'a'.repeat(64), expiresAt: Date.now() + 60_000 },
  } as unknown as ReferenceRouting;
  const stagedOrder = { ...f.args.order, workflow: 'wf_child_instance', routing };
  await assert.rejects(stageRoutedDefinition({ ...f.args, order: stagedOrder,
    rootWorkflow: 'other_root' }), /routed definition staging refused/);
  const wrongDefinition = structuredClone(routing);
  wrongDefinition.claim.binding.def.workflowName = 'other/child';
  wrongDefinition.decision.binding.def.workflowName = 'other/child';
  await assert.rejects(stageRoutedDefinition({ ...f.args,
    order: { ...stagedOrder, routing: wrongDefinition } }), /routed definition staging refused/);
  const stage = await stageRoutedDefinition({ ...f.args, order: stagedOrder });
  try {
    const packet: OrderPacket = { workflow: 'wf_child_instance', run: 'run', step: 'command', key: '',
      defDigest: f.packed.digest, worker: 'command', workdir: f.args.workRoot,
      inputs: [], outputs: ['out'], consumes: {}, consumedFingerprint: {},
      owes: [{ path: 'out', version: 1, judgmentRejects: 0, schemaRejects: 0, reasons: [] }], routing };
    const response: GetOrderResponse = { text: '', workflow: 'wf_child_instance', run: 'run',
      lease: { claimed: true }, order: packet };
    assert.equal(await stage.commandFor!(packet), 'echo recovered');
    await assert.rejects(stage.commandFor!({ ...packet, workflow: 'wf_sibling_instance' }),
      /routed command definition refused/);
    await assert.rejects(stage.verifyOrder({ ...response, workflow: 'wf' }), /routed order changed/);
    await assert.rejects(stage.verifyOrder({ ...response,
      order: { ...packet, workflow: 'wf_sibling_instance' } }), /routed order changed/);
    const binding = { rootWorkflow: 'wf', frameWorkflow: 'wf_child_instance', run: 'run',
      claimId: 'run', decisionId: 'decision', sessionId: routing.claim.sessionId,
      shiftId: routing.claim.shiftId, orderDigest: 'b'.repeat(64),
      authorityRevision: 'c'.repeat(64), rosterRevision: routing.preference.rosterRevision,
      routingDigest: valueDigestHex(routing), preferenceExpiresAt: routing.preference.expiresAt };
    const pair: { reference: RoutedReferenceV2; claim: RoutedClaimV2 } = {
      reference: { protocol: 'trusted-routed-reference-read-v2', state: 'available',
	workflow: 'wf', run: 'run', order: { ...packet,
	  owes: [{ path: 'out', version: 1 }] } as unknown as OrderPacket,
	inputs: [],
	workdirInput: { stem: 'target', version: 1,
	  value: { path: f.args.workRoot } }, lease: { claimed: true }, binding },
      claim: { protocol: 'routing-claim-read-v2', state: 'available',
	workflow: 'wf', run: 'run', routing, binding },
    };
    await assert.rejects(stage.verifyOrder(response), /routed order fields changed|routed workdir witness unavailable/);
    const opened = openRoutingRoleStage({ definitionStage: { path: stage.path, digest: stage.digest },
      reservation: { workflow: 'wf', run: 'run' } } as RoutingHandoffV1);
    assert.equal(opened.frameWorkflow, 'wf_child_instance');
    assert.equal(opened.definitionName, 'recovered');
    const direct = await bindTrustedRoutedInputV2({ phase: 'prestart', pair, privateOrder: packet,
      instructions: opened.instructions, consumedVerifier: createConsumedVerifier({
	env: opened.publicEnv, now: Date.now, artifactPolicy: 'enforce' }),
      expected: { workflow: 'wf', run: 'run' } });
    assert.equal(direct.ok, true, JSON.stringify(direct));
    await stage.verifyRoutedInput!(response, pair, 'prestart');
    const changed = structuredClone(pair);
    if (changed.reference.state !== 'available') assert.fail('missing witness');
    changed.reference.workdirInput!.value = { path: f.stateDir };
    await assert.rejects(stage.verifyRoutedInput!(response, changed, 'prestart'), error => {
      assert.ok(error instanceof RoutedInputWitnessRefusal);
      assert.equal(error.message, 'routed input witness refused');
      assert.equal(error.code, 'workdir-value-mismatch');
      assert.ok(!JSON.stringify(error).includes(f.stateDir));
      return true;
    });
  } finally { stage.cleanup(); }
});

test('routed witness diagnostic maps arbitrary verifier text to a closed code', () => {
  const refusal = new RoutedInputWitnessRefusal('token=/private/input/value');
  assert.equal(refusal.message, 'routed input witness refused');
  assert.equal(refusal.code, 'unclassified');
  assert.ok(!String(refusal.stack).includes('/private/input/value'));
  assert.ok(!JSON.stringify(refusal).includes('/private/input/value'));
});

test('routed role opens only the staged public definition store', async () => {
  const f = await fixture();
  const binding = { runId: 'wf', frameId: 'wf',
    def: { bundleDigest: `sha256:${f.packed.digest}`, workflowName: 'recovered' } };
  const routing = { claim: { claimId: 'run', orderId: 'run', binding },
    decision: { binding } } as unknown as ReferenceRouting;
  const stage = await stageRoutedDefinition({ ...f.args,
    order: { ...f.args.order, routing } });
  const handoff = { definitionStage: { path: stage.path, digest: stage.digest },
    reservation: { workflow: 'wf', run: 'run' } } as RoutingHandoffV1;
  const opened = openRoutingRoleStage(handoff);
  assert.throws(() => openRoutingRoleStage({ ...handoff,
    reservation: { ...handoff.reservation, workflow: 'other_root' } }),
  /routing definition stage refused/);
  assert.equal(opened.publicEnv.OWENLOOP_CONFIG_DIR, join(stage.path, 'public'));
  assert.equal(opened.publicEnv.HOME, join(stage.path, 'home'));
  assert.equal(JSON.stringify(opened.publicEnv).includes('secret-marker'), false);
  const command = await opened.instructions.resolveCommand({ workflow: 'wf', run: 'run', step: 'command',
    key: '', defDigest: f.packed.digest, worker: 'command', inputs: [], outputs: ['out'], consumes: {},
    owes: [{ path: 'out', judgmentRejects: 0, schemaRejects: 0, reasons: [] }], routing });
  assert.equal(command.ok, true);
  stage.cleanup();
  assert.throws(() => openRoutingRoleStage(handoff), /routing definition stage refused/);
});

test('routed staging applies matched origin rules but permits namespaces without a rule', async () => {
  const f = await fixture();
  writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ originRules: { '*': 'git' } }));
  await assert.rejects(stageRoutedDefinition(f.args), /routed definition staging refused/);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);
});

test('routed staging propagates sanitized 429 and refuses further bundle requests', async () => {
  const f = await fixture();
  const observed: HubError[] = [];
  const fetchImpl: typeof fetch = async input => {
    f.seen.push(new URL(String(input)).pathname);
    return new Response('secret-marker', { status: 429, headers: { 'retry-after': '7' } });
  };
  await assert.rejects(stageRoutedDefinition({ ...f.args, fetchImpl, onRateLimit: error => observed.push(error) }),
    (error: unknown) => error instanceof HubError && error.status === 429 && error.retryAfterMs === 7_000
      && !error.message.includes('secret-marker'));
  assert.equal(f.seen.length, 1);
  assert.equal(observed.length, 1);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);
});

test('routed staging rejects a lost local claim before recovery fetch', async () => {
  const f = await fixture();
  await assert.rejects(stageRoutedDefinition({ ...f.args, stillAuthorized: () => false }),
    /routed definition staging refused/);
  assert.equal(f.seen.length, 0);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);
});

test('routed staging refuses a state root within the worker root before any fetch', async () => {
  const f = await fixture();
  await assert.rejects(stageRoutedDefinition({ ...f.args, workRoot: f.stateDir }),
    /routed definition staging refused/);
  assert.equal(f.seen.length, 0);
  assert.equal(readdirSync(f.stateDir).length, 0);
});

test('routed staging rejects signer trust revoked after private install', async () => {
  const f = await fixture();
  let checks = 0;
  await assert.rejects(stageRoutedDefinition({ ...f.args, stillAuthorized: () => {
    checks++;
    if (checks === 4) writeFileSync(join(f.config, 'allowed_signers'), '', { mode: 0o600 });
    return true;
  } }), /routed definition staging refused/);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);
  assert.equal(existsSync(join(f.home, '.owenloop', 'store')), false);
});

test('routed staging applies a newly configured origin rule before returning the snapshot', async () => {
  const f = await fixture();
  let checks = 0;
  await assert.rejects(stageRoutedDefinition({ ...f.args, stillAuthorized: () => {
    checks++;
    if (checks === 4) writeFileSync(join(f.config, 'settings.json'),
      JSON.stringify({ originRules: { '*': 'git' } }));
    return true;
  } }), /routed definition staging refused/);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);
});

test('bounded stage maintenance removes an old crash orphan but preserves a fresh snapshot', async () => {
  const f = await fixture();
  const old = await stageRoutedDefinition(f.args);
  const fresh = await stageRoutedDefinition(f.args);
  const age = new Date(Date.now() - 25 * 60 * 60_000);
  utimesSync(old.path, age, age);
  const maintenance = createRoutedDefinitionMaintenance({ stateDir: f.stateDir, workRoot: f.args.workRoot });
  maintenance.sweep();
  maintenance.close();
  assert.equal(existsSync(old.path), false);
  assert.equal(existsSync(fresh.path), true);
  fresh.cleanup();
});

test('activated stage survives terminal cleanup, 24-hour age and maintenance restart until explicit owner cleanup', async () => {
  const f = await fixture();
  const stage = await stageRoutedDefinition(f.args);
  const owner = { workflow: 'wf', run: 'run', pid: 92345, spawnedAt: 1_000 };
  stage.activate(owner);
  stage.markGateMayOpen(owner);
  assert.deepEqual(JSON.parse(readFileSync(join(stage.path, 'owner.json'), 'utf8')), owner);
  stage.cleanup();
  assert.equal(existsSync(stage.path), true);
  const age = new Date(Date.now() - 25 * 60 * 60_000);
  utimesSync(stage.path, age, age);
  for (let restart = 0; restart < 2; restart++) {
    const maintenance = createRoutedDefinitionMaintenance({ stateDir: f.stateDir,
      workRoot: f.args.workRoot });
    maintenance.sweep(); maintenance.close();
    assert.equal(existsSync(stage.path), true);
  }
  stage.cleanupAfterExit({ ...owner, spawnedAt: 999 });
  assert.equal(existsSync(stage.path), true);
  stage.cleanupAfterExit(owner);
  assert.equal(existsSync(stage.path), false);
});

test('restart reaps an activated child that died before its start gate opened', async () => {
  const f = await fixture();
  const stage = await stageRoutedDefinition(f.args);
  const owner = { workflow: 'wf', run: 'run', pid: 92346, spawnedAt: 1_000 };
  stage.activate(owner);
  const maintenance = createRoutedDefinitionMaintenance({ stateDir: f.stateDir,
    workRoot: f.args.workRoot, isAlive: () => false });
  maintenance.sweep(); maintenance.close();
  assert.equal(existsSync(stage.path), false);
});

test('routed staging fetches the signed locked child and refuses child-only unsigned evidence', async () => {
  const f = await fixture();
  const child = packBundle(writeBundleSource({ name: 'child', workflow: `name: child
inputs:
  - name: data
    seedOwed: true
steps:
  - name: child-runner
    consumes: [data]
    produces: [delivered]
    terminal: true
    command: echo child
outputs: [delivered]
` }));
  const target = 'child/child@1.0.0';
  const childKeyPath = join(f.home, 'child-publisher');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', childKeyPath], { stdio: 'ignore' });
  const childKey = publicKeyDescriptor(readFileSync(`${childKeyPath}.pub`, 'utf8'));
  const parentSignerLine = `publisher ${f.publicKey.openSshPublicKey}\n`;
  writeFileSync(join(f.config, 'allowed_signers'),
    parentSignerLine + `child-publisher ${childKey.openSshPublicKey}\n`, { mode: 0o600 });
  const parent = packBundle(writeBundleSource({ name: 'parent', lock: { [target]: child.digest }, workflow: `name: parent
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: ordinary
    consumes: [seed]
    produces: [ordinary-out]
    command: echo parent
  - name: invoke-child
    calls: ${target}
    inputs:
      data: seed
    produces: [delivered]
  - name: finish
    consumes: [ordinary-out, delivered]
    produces: [out]
    terminal: true
    body: ""
outputs: [out]
` }));
  const publication = async (packed: typeof child, signKeyPath: string, publisherKeyId: string) => {
    const signer = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath });
    const signed = await dsseSignPublication(Buffer.from(canonicalJsonBytes({
      digest: packed.digest, name: packed.manifest.package.name,
      version: packed.manifest.package.version, publisherKeyId, timestamp: Date.now(),
    })), signer);
    return canonicalJsonBytes(signed.envelope);
  };
  const evidence = new Map([[child.digest, await publication(child, childKeyPath, childKey.keyid)],
    [parent.digest, await publication(parent, f.keyPath, f.publicKey.keyid)]]);
  const bundles = new Map([[child.digest, child.bytes], [parent.digest, parent.bytes]]);
  let unsignedChild = false;
  const fetchImpl: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    f.seen.push(path);
    const [, , resource, digest] = path.split('/');
    if (resource === 'bundles') return new Response(bundles.get(digest!) ?? null, { status: bundles.has(digest!) ? 200 : 404 });
    if (resource === 'publications') return unsignedChild && digest === child.digest
      ? new Response('unsigned', { status: 200, headers: { 'x-owenloop-publication-state': 'unsigned' } })
      : new Response(evidence.get(digest!) ?? null, { status: evidence.has(digest!) ? 200 : 404,
	headers: { 'x-owenloop-publication-state': 'signed' } });
    if (resource === 'origins') return new Response(null, { status: 404 });
    throw new Error('unexpected request');
  };
  const args = { ...f.args, order: { ...f.args.order, step: 'ordinary', defDigest: parent.digest }, fetchImpl };
  const stage = await stageRoutedDefinition(args);
  assert.ok(f.seen.includes(`/api/bundles/${child.digest}`));
  assert.ok(f.seen.includes(`/api/publications/${child.digest}`));
  stage.cleanup();
  let checks = 0;
  await assert.rejects(stageRoutedDefinition({ ...args, stillAuthorized: () => {
    checks++;
    if (checks === 7) {
      const root = join(f.stateDir, '.routing-definitions');
      const current = readdirSync(root).find(name => name.startsWith('.routing-def-'))!;
      writeFileSync(join(root, current, 'public', 'allowed_signers'), parentSignerLine);
    }
    return true;
  } }), /routed definition staging refused/);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0,
    'child-only trust loss after download invalidates the complete calls closure');
  unsignedChild = true;
  f.seen.length = 0;
  await assert.rejects(stageRoutedDefinition(args), /routed definition staging refused/);
  assert.equal(readdirSync(join(f.stateDir, '.routing-definitions')).length, 0);
});
