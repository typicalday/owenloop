import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { encodeBase64, PAYLOAD_TYPE_SUBMISSION } from '../../../src/crypto/dsse.ts';
import { keyidFromBlob, publicKeyDescriptor } from '../../../src/crypto/keys.ts';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import {
  createBundleIngestor,
  createStoreInstructionSource,
  readWorkflowStoreIndex,
  storeIndexPath,
  writeWorkflowStoreIndex,
} from '../../../src/store/index.ts';
import type { StoreInstructionSource } from '../../../src/store/index.ts';
import { installBundleFixture, tempDir, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import { createConsumedVerifier } from '../src/consumed-verifier.ts';
import { createDefaultStoreInstructionResolver, createStoreInstructionResolver } from '../src/exec/instructions.ts';
import type { OrderPacket } from '../src/hub/types.ts';

// Calls boundary, end to end through the command resolver. The parent's
// `unit1` step is `calls: change-unit` and produces `u1`; `integrate` is a
// command step consuming `u1`. No submission record can exist for `u1`: the
// engine folds the child's `result` into it without a submit. The hub relays
// the child's record under `u1` with hints; the worker admits it only after
// corroborating the hints against the verified parent and its verified child.

const rootBlob = Buffer.from('synthetic-exec-calls-relay-root');
const ROOT_PUBLIC_KEY = `ssh-ed25519 ${rootBlob.toString('base64')} calls-relay-root`;
const ROOT_KEY_ID = keyidFromBlob(rootBlob);
const OTHER_DIGEST = 'd'.repeat(64);
const PLAN_VALUE = { plan: 'integrate the units' };
const U1_VALUE = { unit: 'one', changed: ['a.ts'] };
const CHILD_VERSION = 2;

const CHILD = `name: change-unit
inputs:
  - name: data
    seedOwed: true
steps:
  - name: change
    consumes: [data]
    produces: [result]
    terminal: true
    executor: command
    command: 'printf "change-unit-ran\\n"'
    body: ""
outputs: [result]
`;

function parentYaml(name: string, target: string): string {
  return `name: ${name}
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: planner
    consumes: [seed]
    produces: [plan]
    executor: command
    command: 'printf "planner-ran\\n"'
    body: ""
  - name: unit1
    calls: ${target}
    inputs:
      data: seed
    produces: [u1]
  - name: integrate
    consumes: [plan, u1]
    produces: [out]
    terminal: true
    executor: command
    command: 'printf "integrate-ran\\n"'
    body: ""
outputs: [out]
`;
}

interface Fixture {
  projectRoot: string;
  parentDigest: string;
  childDigest: string;
  env: Record<string, string | undefined>;
}

function trustEnv(): Record<string, string | undefined> {
  const config = mkdtempSync(join(tmpdir(), 'owenloop-exec-calls-relay-trust-'));
  mkdirSync(join(config, '.owenloop'), { recursive: true });
  writeFileSync(join(config, '.owenloop', 'org-root.pub'), ROOT_PUBLIC_KEY);
  return { HOME: config };
}

function addIndexEntry(root: string, coordinate: string, digest: string): void {
  const index = readWorkflowStoreIndex(storeIndexPath(root));
  index.entries[coordinate] = { digest, pinned: false };
  writeWorkflowStoreIndex(storeIndexPath(root), index);
}

async function fixture(shape: 'qualified' | 'bare'): Promise<Fixture> {
  const projectRoot = join(tempDir('owenloop-exec-calls-relay-project-'), 'workflows');
  if (shape === 'qualified') {
    const target = 'dep/change-unit@1.0.0';
    const child = await installBundleFixture({
      root: projectRoot,
      sourceDir: writeBundleSource({ name: 'change-unit', workflow: CHILD }),
    });
    addIndexEntry(projectRoot, target, child.result.digest);
    const parent = await installBundleFixture({
      root: projectRoot,
      sourceDir: writeBundleSource({
        name: 'calls-relay-parent',
        workflow: parentYaml('calls-relay-parent', target),
        lock: { [target]: child.result.digest },
      }),
    });
    return { projectRoot, parentDigest: parent.result.digest, childDigest: child.result.digest, env: trustEnv() };
  }
  const parent = await installBundleFixture({
    root: projectRoot,
    sourceDir: writeBundleSource({
      name: 'calls-relay-sibling-parent',
      workflow: parentYaml('calls-relay-sibling-parent', 'change-unit'),
      workflows: { 'change-unit': CHILD },
      defaultWorkflow: 'calls-relay-sibling-parent',
    }),
  });
  // A bare sibling target lives inside the parent's own bundle, so the child
  // definition digest the parent pins IS the parent's bundle digest.
  return { projectRoot, parentDigest: parent.result.digest, childDigest: parent.result.digest, env: trustEnv() };
}

function envelope(record: Record<string, unknown>): string {
  return JSON.stringify({
    payloadType: PAYLOAD_TYPE_SUBMISSION,
    payload: encodeBase64(Buffer.from(JSON.stringify(record), 'utf8')),
    signatures: [{ sig: encodeBase64(Buffer.from('synthetic-signature', 'utf8')) }],
  });
}

/** The child's own signed record: its run, its definition digest, its outcome stem. */
function childProof(
  value: unknown,
  childDigest: string,
  overrides: Partial<{ workflow: string; defDigest: string; artifact: string; version: number }> = {},
): string {
  return envelope({
    run: 'run-change-unit',
    workflow: overrides.workflow ?? 'wf-change-unit',
    defDigest: overrides.defDigest ?? childDigest,
    step: 'change',
    key: 'change',
    produced: [{ artifact: overrides.artifact ?? 'result', version: overrides.version ?? CHILD_VERSION, valueDigest: valueDigestHex(value) }],
    consumedFingerprint: {},
    producerKeyId: ROOT_KEY_ID,
    timestamp: 10,
  });
}

/** An ordinary parent-path record for `plan`, produced by the parent's own command step. */
function planProof(value: unknown, parentDigest: string): string {
  return envelope({
    run: 'run-calls-relay',
    workflow: 'wf-calls-relay',
    defDigest: parentDigest,
    step: 'planner',
    key: 'planner',
    produced: [{ artifact: 'plan', version: 1, valueDigest: valueDigestHex(value) }],
    consumedFingerprint: {},
    producerKeyId: ROOT_KEY_ID,
    timestamp: 10,
  });
}

function order(fixtureData: Fixture, overrides: Partial<OrderPacket> = {}): OrderPacket {
  return {
    run: 'run-calls-relay',
    workflow: 'wf-calls-relay',
    step: 'integrate',
    key: 'integrate',
    inputs: ['plan', 'u1'],
    outputs: ['out'],
    worker: 'command',
    defDigest: fixtureData.parentDigest,
    consumes: { plan: PLAN_VALUE, u1: U1_VALUE },
    // The parent artifact's own counter: deliberately NOT the child version.
    consumedFingerprint: { plan: 1, u1: 1 },
    consumesProof: JSON.stringify({
      plan: planProof(PLAN_VALUE, fixtureData.parentDigest),
      u1: childProof(U1_VALUE, fixtureData.childDigest),
    }),
    consumesProofRelay: { u1: { childDefDigest: fixtureData.childDigest, childVersion: CHILD_VERSION, childOutcome: 'result' } },
    owes: [{ path: 'out', version: 0, judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
    ...overrides,
  };
}

function signerForPrincipal({ allowedSignersText }: { allowedSignersText: string }) {
  const publicKey = allowedSignersText.trim().split(/\s+/).slice(1).join(' ');
  const selected = publicKeyDescriptor(publicKey);
  return {
    verify: async () => ({ keyid: selected.keyid, principal: 'synthetic-signer', format: 'sshsig' as const }),
  };
}

function verifierFor(fixtureData: Fixture, artifactPolicy: 'off' | 'warn' | 'enforce') {
  return createConsumedVerifier({ env: fixtureData.env, artifactPolicy, now: () => 100, signerForPrincipal });
}

function resolverFor(fixtureData: Fixture, artifactPolicy: 'off' | 'warn' | 'enforce' = 'off') {
  return createStoreInstructionResolver({
    projectRoot: fixtureData.projectRoot,
    globalRoot: tempDir('owenloop-exec-calls-relay-global-'),
    verifier: createBundleIngestor(),
    definitionVerifier: () => ({ kind: 'verified', publisherKeyId: '', principal: '' }),
    consumedVerifier: verifierFor(fixtureData, artifactPolicy),
    env: fixtureData.env,
  });
}

async function refusalReason(fixtureData: Fixture, packet: OrderPacket): Promise<string> {
  const result = await resolverFor(fixtureData).resolveCommand(packet);
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error('unreachable');
  assert.equal(result.kind, 'unverified-consumed');
  return result.reason;
}

test('calls relay e2e: a relayed child record admits a calls-produced consumed artifact (locked qualified target)', async () => {
  const fixtureData = await fixture('qualified');
  const result = await resolverFor(fixtureData).resolveCommand(order(fixtureData));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.match(result.command, /integrate-ran/);
});

test('calls relay e2e: a relayed child record admits a calls-produced consumed artifact (bare sibling target)', async () => {
  const fixtureData = await fixture('bare');
  const result = await resolverFor(fixtureData).resolveCommand(order(fixtureData));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.match(result.command, /integrate-ran/);
});

test('selected native concrete child binds the signed relay to that exact workflow', async () => {
  const fixtureData = await fixture('qualified');
  const packet = order(fixtureData);
  const binding = { runId: 'wf_root', frameId: packet.workflow,
    def: { bundleDigest: `sha256:${fixtureData.parentDigest}`,
      workflowName: 'calls-relay-parent' } };
  packet.routing = { claim: { claimId: packet.run, orderId: packet.run, binding },
    decision: { binding } } as OrderPacket['routing'];
  const makeResolver = (selectedWorkflow: string) => {
    const base = createStoreInstructionSource({ projectRoot: fixtureData.projectRoot,
      globalRoot: tempDir('owenloop-selected-concrete-global-'),
      verifier: createBundleIngestor() });
    const source: StoreInstructionSource = { ...base,
      selectVerifiedDefinition: (digest, name, step) => {
	const chosen = base.selectVerifiedDefinition(digest, name, step);
	return chosen && { ...chosen, callsChild: callsStep => {
	  const child = chosen.callsChild(callsStep);
	  return child && { ...child, selectedConcreteCall: {
	    kind: 'selected-native-concrete-child', parentWorkflow: packet.workflow,
	    childWorkflow: selectedWorkflow,
	    childDefRef: { bundleDigest: fixtureData.childDigest,
	      workflowName: child.definition.name }, receiptDigest: 'a'.repeat(64),
	  } };
	} };
      } };
    const proof = (JSON.parse(packet.consumesProof!) as Record<string, string>).u1!;
    const receipt = { kind: 'concrete-call' as const, parentWorkflow: packet.workflow,
      parentDefRef: { bundleDigest: fixtureData.parentDigest,
	workflowName: 'calls-relay-parent' }, callStep: 'unit1', callPath: 'u1',
      parentArtifactVersion: 1, childWorkflow: selectedWorkflow,
      childDefRef: { bundleDigest: fixtureData.childDigest, workflowName: 'change-unit' },
      childOutcome: 'result', childOutcomeVersion: CHILD_VERSION,
      foldedValueDigest: valueDigestHex(U1_VALUE) };
    return createStoreInstructionResolver({ source,
      globalRoot: tempDir('owenloop-selected-concrete-global-'),
      verifier: createBundleIngestor(),
      routedSelection: { rootWorkflow: 'wf_root', frameWorkflow: packet.workflow,
	definitionName: 'calls-relay-parent', defDigest: fixtureData.parentDigest,
	run: packet.run },
      definitionVerifier: () => ({ kind: 'verified', publisherKeyId: '', principal: '' }),
      consumedVerifier: verifierFor(fixtureData, 'enforce'), env: fixtureData.env,
      concreteCallBindingSource: { read: async () => ({ receipt,
	receiptDigest: valueDigestHex(receipt), proof }) },
    });
  };
  const accepted = await makeResolver('wf-change-unit').resolveRoutedCommandDefinition!(packet);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const otherNative = await makeResolver('wf-other-native').resolveRoutedCommandDefinition!(packet);
  assert.equal(otherNative.ok, false, 'a same-definition proof from another native child must refuse');
  if (!otherNative.ok) assert.equal(otherNative.kind, 'unverified-consumed');
});

const NO_RELAY_REASON = /\(calls\) .* artifact 'u1': artifact 'u1' is produced by calls: step 'unit1' \(dep\/change-unit@1\.0\.0\), so only a relayed child proof can prove it, but the order carries no consumesProofRelay entry for it/;

test('calls relay e2e: a calls-produced path with neither record nor relay is refused at the calls boundary (agent-produced child, old hub)', async () => {
  const fixtureData = await fixture('qualified');
  const { consumesProofRelay: _relay, ...noRelay } = order(fixtureData);
  const reason = await refusalReason(fixtureData, {
    ...noRelay,
    consumesProof: JSON.stringify({ plan: planProof(PLAN_VALUE, fixtureData.parentDigest) }),
  });
  assert.match(reason, NO_RELAY_REASON);
});

test('calls relay e2e: relay hints without a record prove nothing', async () => {
  const fixtureData = await fixture('qualified');
  const reason = await refusalReason(fixtureData, order(fixtureData, {
    consumesProof: JSON.stringify({ plan: planProof(PLAN_VALUE, fixtureData.parentDigest) }),
  }));
  assert.match(reason, /\(no-proof\) .* artifact 'u1'/);
});

test('calls relay e2e: the child record without the relay is refused at the calls boundary, not by ordinary verification', async () => {
  const fixtureData = await fixture('qualified');
  const { consumesProofRelay: _relay, ...noRelay } = order(fixtureData);
  const reason = await refusalReason(fixtureData, noRelay);
  assert.match(reason, NO_RELAY_REASON);
  assert.doesNotMatch(reason, /\(signature\)/);
});

/**
 * The record a hostile hub would replay: validly signed by a trusted producer,
 * covering the PARENT path `u1` itself with the consumed value's digest and the
 * parent's own workflow/fingerprint version, but signed for an unrelated definition.
 * Ordinary verification never looks at `defDigest`, so it would admit this.
 */
function replayedParentPathProof(fixtureData: Fixture): string {
  return childProof(U1_VALUE, fixtureData.childDigest, { workflow: 'wf-calls-relay', defDigest: OTHER_DIGEST, artifact: 'u1', version: 1 });
}

test('calls relay e2e: a trusted record covering the parent path under an unrelated definition is refused without a relay', async () => {
  const fixtureData = await fixture('qualified');
  const { consumesProofRelay: _relay, ...noRelay } = order(fixtureData);
  const packet: OrderPacket = {
    ...noRelay,
    consumesProof: JSON.stringify({
      plan: planProof(PLAN_VALUE, fixtureData.parentDigest),
      u1: replayedParentPathProof(fixtureData),
    }),
  };

  // Control: with no verified definition in hand (no callsProducers), the
  // very same record passes ordinary verification under the hard rule. That
  // is the hole the boundary closes for a consumer that DOES hold the def.
  const ordinary = await verifierFor(fixtureData, 'enforce')(packet, { hardRule: true });
  assert.equal(ordinary.ok, true, JSON.stringify(ordinary));

  const reason = await refusalReason(fixtureData, packet);
  assert.match(reason, NO_RELAY_REASON);
  assert.doesNotMatch(reason, /\(signature\)|\(value-digest\)|\(version\)|\(no-proof\)/);
});

test('calls relay e2e: a trusted record covering the parent path under an unrelated definition is refused when the relay names the pinned child', async () => {
  const fixtureData = await fixture('qualified');
  const reason = await refusalReason(fixtureData, order(fixtureData, {
    consumesProof: JSON.stringify({
      plan: planProof(PLAN_VALUE, fixtureData.parentDigest),
      u1: replayedParentPathProof(fixtureData),
    }),
    // The hint corroborates against the verified parent; the record does not.
    consumesProofRelay: { u1: { childDefDigest: fixtureData.childDigest, childVersion: 1, childOutcome: 'result' } },
  }));
  assert.match(reason, /\(calls\) .* artifact 'u1': relayed submission record for artifact 'u1' was signed for definition digest 'd{64}', but the verified parent definition pins its calls child at '/);
});

test('calls relay e2e: a relay on a non-calls path is refused before the record shortcut, even with no record for that path', async () => {
  const fixtureData = await fixture('qualified');
  const reason = await refusalReason(fixtureData, order(fixtureData, {
    // No record for `plan` at all: without the boundary rule this would be
    // the `absent` shortcut, not a named calls refusal.
    consumesProof: JSON.stringify({ u1: childProof(U1_VALUE, fixtureData.childDigest) }),
    consumesProofRelay: {
      plan: { childDefDigest: fixtureData.childDigest, childVersion: 1, childOutcome: 'result' },
      u1: { childDefDigest: fixtureData.childDigest, childVersion: CHILD_VERSION, childOutcome: 'result' },
    },
  }));
  assert.match(reason, /\(calls\) .* artifact 'plan': artifact 'plan' carries a calls-boundary relay, but the verified definition does not produce it through a calls: step/);
  assert.doesNotMatch(reason, /\(no-proof\)/);
});

test('calls relay e2e: a relay naming a child digest the verified parent does not pin is refused at the calls boundary', async () => {
  const fixtureData = await fixture('qualified');
  const reason = await refusalReason(fixtureData, order(fixtureData, {
    consumesProofRelay: { u1: { childDefDigest: OTHER_DIGEST, childVersion: CHILD_VERSION, childOutcome: 'result' } },
  }));
  assert.match(reason, /\(calls\) .* artifact 'u1': relay for artifact 'u1' names child definition digest 'd{64}', but the verified definition pins calls: step 'unit1' \(dep\/change-unit@1\.0\.0\) at '/);
});

test('calls relay e2e: a child record signed for a different definition than the pinned child is refused', async () => {
  const fixtureData = await fixture('qualified');
  const reason = await refusalReason(fixtureData, order(fixtureData, {
    consumesProof: JSON.stringify({
      plan: planProof(PLAN_VALUE, fixtureData.parentDigest),
      u1: childProof(U1_VALUE, fixtureData.childDigest, { defDigest: OTHER_DIGEST }),
    }),
  }));
  assert.match(reason, /\(calls\) .* was signed for definition digest 'd{64}', but the verified parent definition pins its calls child at '/);
});

test('calls relay e2e: a relay naming an outcome the verified child does not declare is refused', async () => {
  const fixtureData = await fixture('qualified');
  const reason = await refusalReason(fixtureData, order(fixtureData, {
    consumesProofRelay: { u1: { childDefDigest: fixtureData.childDigest, childVersion: CHILD_VERSION, childOutcome: 'other' } },
  }));
  assert.match(reason, /\(calls\) .* names child outcome 'other', but the verified child definition for calls: step 'unit1' declares outcome 'result'/);
});

test('calls relay e2e: a tampered calls-produced value is refused on its digest and names the calls boundary', async () => {
  const fixtureData = await fixture('qualified');
  const reason = await refusalReason(fixtureData, order(fixtureData, {
    consumes: { plan: PLAN_VALUE, u1: { unit: 'one', changed: ['tampered.ts'] } },
  }));
  assert.match(reason, /\(value-digest\) .* artifact 'u1'/);
  assert.match(reason, /relayed across the calls boundary from child outcome 'result'/);
});

test('calls relay e2e: a pinned child version the record does not carry is refused', async () => {
  const fixtureData = await fixture('qualified');
  const reason = await refusalReason(fixtureData, order(fixtureData, {
    consumesProofRelay: { u1: { childDefDigest: fixtureData.childDigest, childVersion: CHILD_VERSION + 1, childOutcome: 'result' } },
  }));
  assert.match(reason, /\(version\) .* artifact 'u1': artifact 'u1' has signed version 2, expected version 3/);
});

test('calls relay e2e: a relay on a path the verified definition does not produce through calls: is refused', async () => {
  const fixtureData = await fixture('qualified');
  const reason = await refusalReason(fixtureData, order(fixtureData, {
    consumesProofRelay: {
      plan: { childDefDigest: fixtureData.childDigest, childVersion: 1, childOutcome: 'plan' },
      u1: { childDefDigest: fixtureData.childDigest, childVersion: CHILD_VERSION, childOutcome: 'result' },
    },
  }));
  assert.match(reason, /\(calls\) .* artifact 'plan': artifact 'plan' carries a calls-boundary relay, but the verified definition does not produce it through a calls: step/);
});

test('calls relay e2e: a malformed relay map is a prerequisite failure, refused under the hard rule', async () => {
  const fixtureData = await fixture('qualified');
  const reason = await refusalReason(fixtureData, order(fixtureData, {
    consumesProofRelay: { u1: { childDefDigest: fixtureData.childDigest, childVersion: '2', childOutcome: 'result' } } as unknown as OrderPacket['consumesProofRelay'],
  }));
  assert.match(reason, /\(prerequisite\) .* has no non-negative integer 'childVersion'/);
});

test('calls relay: a consumer without a verified definition in hand cannot corroborate a relay (agent-side verdict)', async () => {
  const fixtureData = await fixture('qualified');
  const packet = order(fixtureData);

  const warned = await verifierFor(fixtureData, 'warn')(packet, { hardRule: false });
  assert.equal(warned.ok, true, JSON.stringify(warned));
  if (warned.ok) {
    assert.equal(warned.warnings.length, 1);
    assert.match(warned.warnings[0]!, /\(prerequisite\) .* artifact 'u1' carries a calls-boundary relay, but this consumer holds no verified definition/);
  }

  const enforced = await verifierFor(fixtureData, 'enforce')(packet, { hardRule: false });
  assert.equal(enforced.ok, false);
  if (!enforced.ok) assert.match(enforced.reason, /\(prerequisite\) .* calls-boundary relay/);
});

import { runtimeFixture, ready } from '../../../test/helpers/runtime-selection.ts';
import type { InvocationBindingSource } from '../../../src/types.ts';

import { createEngine } from '../../../src/factory.ts';
import { loadCasDefs } from '../../../src/store/def-source.ts';

for (const crossStore of [false, true]) {
for (const factory of ['store', 'default'] as const) {
test(`invocation relay (${factory} factory, cross-store=${crossStore}): trusted SQLite/CAS receipt corroborates signed workflow, digest, outcome, version and value`, async () => {
  const cwd = tempDir('owenloop-default-relay-');
  const env = trustEnv();
  const globalRoot = crossStore ? join(env.HOME!, '.owenloop', 'workflows') : join(cwd, 'workflows');
  const f = await runtimeFixture(':memory:', globalRoot);
  const projectRoot = crossStore ? join(cwd, 'workflows') : f.root;
  if (crossStore) {
    const yaml = readFileSync(f.defs.get('parent/parent@1.0.0')!.dir!, 'utf8')
      .replace('name: parent', 'name: hybrid')
      .replace('steps:\n', 'steps:\n  - name: concrete\n    calls: left/left@1.0.0\n    inputs: {data: seed}\n    produces: [concrete]\n');
    await installBundleFixture({ root: projectRoot, projectRoot, globalRoot,
      sourceDir: writeBundleSource({ name: 'hybrid', workflow: yaml,
      lock: { 'left/left@1.0.0': f.candidates[0]!.DefRef.bundleDigest } }) });
    f.store.close();
    Object.assign(f, createEngine({ db: ':memory:', defs: new Map(
      loadCasDefs({ projectRoot, globalRoot, warn: () => {} }).map(r => [r.key, r.def])) }));
  }
  const workflow = f.engine.createInstance(crossStore ? 'hybrid/hybrid@1.0.0' : 'parent/parent@1.0.0', { provide: { seed: { n: 1 } } });
  for (const [i, path] of ['one', 'two'].entries()) f.engine.applyChoice(ready(f.engine, workflow, path, f.candidates), f.candidates[i]!);
  const children = f.engine.tick(workflow, { deep: true }).orders;
  for (const o of children) {
    f.engine.green(o.workflow, o.run, 'result', U1_VALUE);
    f.engine.close(o.workflow, o.run);
  }
  const finish = f.engine.tick(workflow, { deep: true }).orders[0]!;
  const parentDigest = f.store.getWorkflow(workflow)!.defSnapshot!.bundleDigest!;
  const proofs: Record<string, string> = {}, relays: NonNullable<OrderPacket['consumesProofRelay']> = {};
  for (const path of ['one', 'two']) {
    const b = f.store.listInvocations(workflow).find(b => b.key.callPath === path)!;
    const child = f.store.findChildByInvocation(b.id)!;
    const a = f.store.getArtifact(child.id, 'result')!;
    proofs[path] = envelope({ run: children.find(o => o.workflow === child.id)!.run, workflow: child.id,
      defDigest: b.selected.DefRef.bundleDigest, step: 'work', key: '',
      produced: [{ artifact: 'result', version: a.version, valueDigest: valueDigestHex(U1_VALUE) }],
      consumedFingerprint: {}, producerKeyId: ROOT_KEY_ID, timestamp: 10 });
    relays[path] = { childDefDigest: b.selected.DefRef.bundleDigest, childOutcome: 'result', childVersion: a.version };
  }
  const fixtureData: Fixture = { projectRoot, parentDigest, childDigest: f.candidates[0]!.DefRef.bundleDigest, env };
  const packet: OrderPacket = { ...order(fixtureData), workflow, run: finish.run, step: 'finish', key: '',
    inputs: ['one', 'two'], consumes: finish.consumes, consumedFingerprint: finish.consumedFingerprint,
    consumesProof: JSON.stringify(proofs), consumesProofRelay: relays };
  const source = f.engine.invocationBindingSource();
  const resolver = (invocationBindingSource?: InvocationBindingSource) => {
    const options = {
      verifier: createBundleIngestor(),
      definitionVerifier: () => ({ kind: 'verified' as const, publisherKeyId: '', principal: '' }),
      consumedVerifier: verifierFor(fixtureData, 'enforce'), invocationBindingSource,
    };
    return factory === 'default'
      ? createDefaultStoreInstructionResolver({ ...options, cwd, env: fixtureData.env })
      : createStoreInstructionResolver({ ...options, projectRoot, globalRoot });
  };
  const reads: Parameters<InvocationBindingSource['read']>[0][] = [];
  const passed = await resolver({ read: key => { reads.push(key); return source.read(key); } }).resolveCommand(packet);
  assert.equal(passed.ok, true, JSON.stringify(passed));
  assert.deepEqual(reads.map(key => key.callPath), ['one', 'two']);
  assert.equal(typeof passed.revalidate, 'function');
  assert.equal(await passed.revalidate!(), undefined);
  assert.deepEqual(reads.slice(2), reads.slice(0, 2), 'final revalidation rereads both trusted receipts');
  if (!crossStore && factory === 'store') {
    const definitionName = 'parent';
    const binding = { runId: 'wf-root', frameId: workflow,
      def: { bundleDigest: `sha256:${parentDigest}`, workflowName: definitionName } };
    const routedPacket: OrderPacket = { ...packet, routing: {
      claim: { claimId: finish.run, orderId: finish.run, binding },
      decision: { binding },
    } as OrderPacket['routing'] };
    let directReads = 0;
    let allowDirect = true;
    const routed = createStoreInstructionResolver({ projectRoot, globalRoot,
      verifier: createBundleIngestor(),
      definitionVerifier: () => ({ kind: 'verified', publisherKeyId: '', principal: '' }),
      consumedVerifier: verifierFor(fixtureData, 'enforce'), env: fixtureData.env,
      routedSelection: { rootWorkflow: 'wf-root', frameWorkflow: workflow,
	definitionName, defDigest: parentDigest, run: finish.run },
      invocationBindingSource: { read: key => {
	directReads++;
	if (!allowDirect) throw new Error('postfreeze invocation read is forbidden');
	return source.read(key);
      } },
    });
    const signed = await routed.resolveRoutedCommandDefinition!(routedPacket);
    assert.equal(signed.ok, true, JSON.stringify(signed));
    if (signed.ok) {
      assert.equal(directReads, 2, 'prestart resolves both actual invocation receipts');
      allowDirect = false;
      assert.equal(await signed.revalidateLocalAfterRun?.(), undefined);
      assert.equal(directReads, 2, 'local postrun checks source but makes no frozen role relay read');
      const full = await signed.revalidateAfterRun?.();
      assert.equal(full?.ok, false, 'generic full postrun still requires invocation receipts');
      if (full) assert.equal(full.code, 'invocation-read-failed');
      assert.equal(directReads, 3);
    }
  }
  const refused = async (p: OrderPacket, src: InvocationBindingSource | undefined = source) => {
    const r = await resolver(src).resolveCommand(p);
    assert.equal(r.ok, false, JSON.stringify(r));
    return r.ok ? '' : r.reason;
  };
  const signedRecord = JSON.parse(Buffer.from(JSON.parse(proofs.one!).payload, 'base64').toString('utf8'));
  for (const change of [ { workflow: 'different-child' }, { defDigest: OTHER_DIGEST },
    { produced: [{ artifact: 'other', version: 1, valueDigest: valueDigestHex(U1_VALUE) }] },
    { produced: [{ artifact: 'result', version: 999, valueDigest: valueDigestHex(U1_VALUE) }] },
    { produced: [{ artifact: 'result', version: 1, valueDigest: valueDigestHex({ wrong: true }) }] } ]) {
    await refused({ ...packet, consumesProof: JSON.stringify({ ...proofs, one: envelope({ ...signedRecord, ...change }) }) });
  }
  await refused({ ...packet, consumesProofRelay: { ...relays, one: { ...relays.one!, childVersion: 999 } } });
  await refused({ ...packet, consumedFingerprint: { ...packet.consumedFingerprint, one: 999 } });
  const absent = await resolver().resolveCommand(packet);
  assert.equal(absent.ok, false);
  if (!absent.ok) {
    assert.match(absent.reason, /InvocationBindingSource/);
    assert.equal(absent.code, 'invocation-source-absent');
  }
  const noVersion = await resolver(source).resolveCommand({ ...packet,
    consumedFingerprint: { two: packet.consumedFingerprint!.two! } });
  assert.equal(noVersion.ok, false);
  if (!noVersion.ok) assert.equal(noVersion.code, 'invocation-version-missing');
  const missingReceipt = await resolver({ read: () => undefined }).resolveCommand(packet);
  assert.equal(missingReceipt.ok, false);
  if (!missingReceipt.ok) assert.equal(missingReceipt.code, 'invocation-receipt-moved');
  const failedRead = await resolver({ read: () => { throw new Error('private relay failure'); } }).resolveCommand(packet);
  assert.equal(failedRead.ok, false);
  if (!failedRead.ok) assert.equal(failedRead.code, 'invocation-read-failed');
  await refused(packet, { read: () => undefined });
  await refused(packet, { read: () => { throw new Error('unavailable'); } });
  f.engine.cancelRun(workflow);
  assert.equal((await passed.revalidate!())?.ok, false);
  f.store.close();
});
}

}
