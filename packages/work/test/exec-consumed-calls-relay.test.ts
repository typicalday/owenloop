import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { encodeBase64, PAYLOAD_TYPE_SUBMISSION } from '../../../src/crypto/dsse.ts';
import { keyidFromBlob, publicKeyDescriptor } from '../../../src/crypto/keys.ts';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import {
  createBundleIngestor,
  readWorkflowStoreIndex,
  storeIndexPath,
  writeWorkflowStoreIndex,
} from '../../../src/store/index.ts';
import { installBundleFixture, tempDir, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import { createConsumedVerifier } from '../src/consumed-verifier.ts';
import { createStoreInstructionResolver } from '../src/exec/instructions.ts';
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
  overrides: Partial<{ defDigest: string; artifact: string; version: number }> = {},
): string {
  return envelope({
    run: 'run-change-unit',
    workflow: 'wf-change-unit',
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

test('calls relay e2e: no record for the calls-produced path is still absent and refused (agent-produced child, old hub)', async () => {
  const fixtureData = await fixture('qualified');
  const { consumesProofRelay: _relay, ...noRelay } = order(fixtureData);
  const reason = await refusalReason(fixtureData, {
    ...noRelay,
    consumesProof: JSON.stringify({ plan: planProof(PLAN_VALUE, fixtureData.parentDigest) }),
  });
  assert.match(reason, /consumed artifact refusal \(no-proof\) .* artifact 'u1'/);
});

test('calls relay e2e: relay hints without a record prove nothing', async () => {
  const fixtureData = await fixture('qualified');
  const reason = await refusalReason(fixtureData, order(fixtureData, {
    consumesProof: JSON.stringify({ plan: planProof(PLAN_VALUE, fixtureData.parentDigest) }),
  }));
  assert.match(reason, /\(no-proof\) .* artifact 'u1'/);
});

test('calls relay e2e: the child record without the relay is refused as a record for the wrong artifact', async () => {
  const fixtureData = await fixture('qualified');
  const { consumesProofRelay: _relay, ...noRelay } = order(fixtureData);
  const reason = await refusalReason(fixtureData, noRelay);
  assert.match(reason, /\(signature\) .* artifact 'u1': signed submission record does not cover artifact 'u1'/);
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
