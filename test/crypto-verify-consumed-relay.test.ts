import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encodeBase64, PAYLOAD_TYPE_ENROLLMENT_GRANT, PAYLOAD_TYPE_SUBMISSION } from '../src/crypto/dsse.ts';
import { keyidFromBlob, publicKeyDescriptor } from '../src/crypto/keys.ts';
import { valueDigestHex } from '../src/crypto/canonical.ts';
import type { EnrollmentGrantRecord, GrantScope } from '../src/crypto/records.ts';
import {
  verifyConsumed,
  type ConsumedVerdict,
  type VerifyConsumedInput,
  type VerifyConsumedOptions,
} from '../src/crypto/verify-consumed.ts';

// Calls boundary. The parent path `u1` was produced by a `calls:` step, so the
// only signed record that exists is the CHILD's, covering its own outcome
// `result` under the child's definition digest. The `relay` expectation is
// what the consumer read from its verified parent definition.

interface FixtureKey {
  keyid: string;
  publicKey: string;
}

function fixtureKey(name: string): FixtureKey {
  const blob = Buffer.from(`synthetic-relay-${name}`);
  return {
    keyid: keyidFromBlob(blob),
    publicKey: `ssh-ed25519 ${blob.toString('base64')} ${name}`,
  };
}

const root = fixtureKey('root');
const childProducer = fixtureKey('child-producer');
const PARENT_PATH = 'u1';
const CHILD_OUTCOME = 'result';
const CHILD_DIGEST = 'c'.repeat(64);
const OTHER_DIGEST = 'd'.repeat(64);
const CHILD_VERSION = 2;
const unrestrictedScope: GrantScope = {
  pools: '*',
  labels: '*',
  namespaces: '*',
  delegation: { allowed: false },
};

function envelopeBytes(payloadType: string, payload: unknown): Uint8Array {
  return Buffer.from(JSON.stringify({
    payloadType,
    payload: encodeBase64(Buffer.from(JSON.stringify(payload), 'utf8')),
    signatures: [{ sig: encodeBase64(Buffer.from('synthetic-signature', 'utf8')) }],
  }));
}

function childSubmission(
  value: unknown,
  overrides: Partial<{ defDigest: string; artifact: string; version: number; producerKeyId: string }> = {},
): Record<string, unknown> {
  return {
    run: 'run-child',
    workflow: 'wf-child',
    defDigest: overrides.defDigest ?? CHILD_DIGEST,
    step: 'change',
    key: 'change',
    produced: [{
      artifact: overrides.artifact ?? CHILD_OUTCOME,
      version: overrides.version ?? CHILD_VERSION,
      valueDigest: valueDigestHex(value),
    }],
    consumedFingerprint: {},
    producerKeyId: overrides.producerKeyId ?? childProducer.keyid,
    timestamp: 10,
  };
}

function childProofFor(value: unknown, overrides: Parameters<typeof childSubmission>[1] = {}): string {
  return Buffer.from(envelopeBytes(PAYLOAD_TYPE_SUBMISSION, childSubmission(value, overrides))).toString('utf8');
}

function grantBytes(key: FixtureKey): Uint8Array {
  const record: EnrollmentGrantRecord = {
    newKey: {
      keyid: key.keyid,
      keyType: 'ssh-ed25519',
      openSshPublicKey: key.publicKey,
      comment: key.publicKey.split(' ')[2],
    },
    principal: { kind: 'machine', id: 'child-producer' },
    scope: unrestrictedScope,
    grantedBy: root.keyid,
    validFrom: 0,
  };
  return envelopeBytes(PAYLOAD_TYPE_ENROLLMENT_GRANT, record);
}

const options: VerifyConsumedOptions = {
  signerForPrincipal: ({ allowedSignersText }) => {
    const publicKey = allowedSignersText.trim().split(/\s+/).slice(1).join(' ');
    const selected = publicKeyDescriptor(publicKey);
    return {
      verify: async () => ({ keyid: selected.keyid, principal: 'synthetic-signer', format: 'sshsig' as const }),
    };
  },
};

function input(overrides: Partial<VerifyConsumedInput> = {}): VerifyConsumedInput {
  const value = overrides.value ?? { unit: 'one' };
  return {
    path: PARENT_PATH,
    value,
    proof: overrides.proof ?? childProofFor(value),
    expectedVersion: CHILD_VERSION,
    relay: { childDefDigest: CHILD_DIGEST, childOutcome: CHILD_OUTCOME },
    orgRootPublicKey: root.publicKey,
    grants: [grantBytes(childProducer)],
    at: 50,
    demand: {},
    ...overrides,
  };
}

function assertFailure(
  verdict: ConsumedVerdict,
  kind: 'invalid' | 'unverifiable',
): asserts verdict is Extract<ConsumedVerdict, { kind: 'invalid' | 'unverifiable' }> {
  assert.equal(verdict.kind, kind, JSON.stringify(verdict));
}

test('calls relay: the child record verifies for the parent path with the child producer key and pinned version', async () => {
  const verdict = await verifyConsumed(input(), options);
  assert.equal(verdict.kind, 'verified', JSON.stringify(verdict));
  if (verdict.kind !== 'verified') return;
  assert.equal(verdict.producerKeyId, childProducer.keyid);
  assert.equal(verdict.version, CHILD_VERSION);
  assert.deepEqual(verdict.principal, { kind: 'machine', id: 'child-producer' });
});

test('calls relay: a root-key child producer verifies without an enrollment roster', async () => {
  const value = 'root-produced-unit';
  const verdict = await verifyConsumed(input({
    value,
    proof: childProofFor(value, { producerKeyId: root.keyid }),
    grants: [],
  }), options);
  assert.equal(verdict.kind, 'verified', JSON.stringify(verdict));
});

test('calls relay: the same child record is invalid for the parent path without the relay expectation', async () => {
  const { relay: _relay, ...plain } = input();
  const verdict = await verifyConsumed(plain, options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /^signature: signed submission record does not cover artifact 'u1'/);
});

test('calls relay: a record signed for a different definition than the pinned child is invalid', async () => {
  const value = { unit: 'one' };
  const verdict = await verifyConsumed(input({ value, proof: childProofFor(value, { defDigest: OTHER_DIGEST }) }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /^calls: relayed submission record for artifact 'u1' was signed for definition digest 'd{64}', but the verified parent definition pins its calls child at 'c{64}'/);
});

test('calls relay: an expectation naming a different child digest than the record is invalid', async () => {
  const verdict = await verifyConsumed(input({ relay: { childDefDigest: OTHER_DIGEST, childOutcome: CHILD_OUTCOME } }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /^calls: .*pins its calls child at 'd{64}'/);
});

test('calls relay: a record that does not cover the child outcome stem is invalid', async () => {
  const value = { unit: 'one' };
  const verdict = await verifyConsumed(input({ value, proof: childProofFor(value, { artifact: 'other' }) }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /^calls: relayed submission record does not cover child outcome 'result', which the calls boundary folds into artifact 'u1'/);
});

test('calls relay: a tampered consumed value is invalid and names the calls boundary', async () => {
  const verdict = await verifyConsumed(input({ value: { unit: 'tampered' }, proof: childProofFor({ unit: 'one' }) }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /^value-digest: delivered artifact 'u1'/);
  assert.match(verdict.reason, /relayed across the calls boundary from child outcome 'result' of definition 'c{64}'/);
});

test('calls relay: a pinned child version the record does not carry is invalid', async () => {
  const verdict = await verifyConsumed(input({ expectedVersion: CHILD_VERSION + 1 }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /^version: artifact 'u1' has signed version 2, expected version 3/);
  assert.match(verdict.reason, /calls boundary/);
});

test('calls relay: a missing child version pin leaves a valid record unverifiable', async () => {
  const { expectedVersion: _pin, ...unpinned } = input();
  const verdict = await verifyConsumed(unpinned, options);
  assertFailure(verdict, 'unverifiable');
  assert.match(verdict.reason, /^version: artifact 'u1' has a valid historical proof/);
  assert.match(verdict.reason, /calls boundary/);
});

test('calls relay: no proof stays absent whether or not an expectation is present', async () => {
  const { proof: _proof, ...withoutProof } = input();
  assert.deepEqual(await verifyConsumed(withoutProof, options), { kind: 'absent' });
});
