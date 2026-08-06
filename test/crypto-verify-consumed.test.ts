import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  encodeBase64,
  PAYLOAD_TYPE_ENROLLMENT_GRANT,
  PAYLOAD_TYPE_REVOCATION,
  PAYLOAD_TYPE_SUBMISSION,
} from '../src/crypto/dsse.ts';
import { keyidFromBlob, publicKeyDescriptor } from '../src/crypto/keys.ts';
import { valueDigestHex } from '../src/crypto/canonical.ts';
import type { EnrollmentGrantRecord, GrantScope, RevocationRecord } from '../src/crypto/records.ts';
import {
  verifyConsumed,
  type ConsumedVerdict,
  type VerifyConsumedInput,
  type VerifyConsumedOptions,
} from '../src/crypto/verify-consumed.ts';

interface FixtureKey {
  keyid: string;
  publicKey: string;
}

function fixtureKey(name: string): FixtureKey {
  const blob = Buffer.from(`synthetic-consumed-${name}`);
  return {
    keyid: keyidFromBlob(blob),
    publicKey: `ssh-ed25519 ${blob.toString('base64')} ${name}`,
  };
}

const root = fixtureKey('root');
const producer = fixtureKey('producer');
const alternateProducer = fixtureKey('alternate-producer');
const unrestrictedScope: GrantScope = {
  pools: '*',
  labels: '*',
  namespaces: '*',
  delegation: { allowed: false },
};
const marketingScope: GrantScope = {
  pools: ['marketing'],
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

function submission(
  value: unknown,
  overrides: Partial<{
    artifact: string;
    version: number;
    producerKeyId: string;
    consumedFingerprint: Record<string, number>;
    timestamp: number;
  }> = {},
): Record<string, unknown> {
  const artifact = overrides.artifact ?? 'input';
  return {
    run: 'run-consumed',
    workflow: 'wf-consumed',
    defDigest: 'def-consumed',
    step: 'producer',
    key: 'producer-key',
    produced: [{
      artifact,
      version: overrides.version ?? 4,
      valueDigest: valueDigestHex(value),
    }],
    consumedFingerprint: overrides.consumedFingerprint ?? { upstream: 2 },
    producerKeyId: overrides.producerKeyId ?? producer.keyid,
    timestamp: overrides.timestamp ?? 10,
  };
}

function proofFor(value: unknown, overrides: Parameters<typeof submission>[1] = {}): string {
  return JSON.stringify(JSON.parse(Buffer.from(envelopeBytes(PAYLOAD_TYPE_SUBMISSION, submission(value, overrides))).toString('utf8')));
}

function grantBytes(key: FixtureKey, scope: GrantScope = unrestrictedScope): Uint8Array {
  const record: EnrollmentGrantRecord = {
    newKey: {
      keyid: key.keyid,
      keyType: 'ssh-ed25519',
      openSshPublicKey: key.publicKey,
      comment: key.publicKey.split(' ')[2],
    },
    principal: { kind: 'machine', id: key === producer ? 'producer' : 'alternate-producer' },
    scope,
    grantedBy: root.keyid,
    validFrom: 0,
  };
  return envelopeBytes(PAYLOAD_TYPE_ENROLLMENT_GRANT, record);
}

function revocationBytes(record: RevocationRecord): Uint8Array {
  return envelopeBytes(PAYLOAD_TYPE_REVOCATION, record);
}

function signerOptions(
  returnedKeyId?: string,
): VerifyConsumedOptions {
  return {
    signerForPrincipal: ({ allowedSignersText }) => {
      const publicKey = allowedSignersText.trim().split(/\s+/).slice(1).join(' ');
      const selected = publicKeyDescriptor(publicKey);
      return {
        verify: async () => ({
          keyid: returnedKeyId ?? selected.keyid,
          principal: 'synthetic-signer',
          format: 'sshsig' as const,
        }),
      };
    },
  };
}

function input(overrides: Partial<VerifyConsumedInput> = {}): VerifyConsumedInput {
  const value = overrides.value ?? { answer: 42 };
  return {
    path: 'input',
    value,
    proof: overrides.proof ?? proofFor(value),
    expectedVersion: 4,
    orgRootPublicKey: root.publicKey,
    grants: [grantBytes(producer)],
    at: 50,
    demand: {},
    ...overrides,
  };
}

const options = signerOptions();

function assertKind<T extends { kind: string }>(verdict: T, kind: T['kind']): void {
  assert.equal(verdict.kind, kind, JSON.stringify(verdict));
}

function assertFailure(
  verdict: ConsumedVerdict,
  kind: 'invalid' | 'unverifiable',
): asserts verdict is Extract<ConsumedVerdict, { kind: 'invalid' | 'unverifiable' }> {
  assert.equal(verdict.kind, kind, JSON.stringify(verdict));
}

// ---- happy path and each verification link ----------------------------------

test('valid submission proof and locally anchored enrollment chain verify', async () => {
  const verdict = await verifyConsumed(input(), options);
  assertKind(verdict, 'verified');
  if (verdict.kind !== 'verified') return;
  assert.equal(verdict.producerKeyId, producer.keyid);
  assert.equal(verdict.version, 4);
  assert.deepEqual(verdict.principal, { kind: 'machine', id: 'producer' });
});

test('a root-key producer verifies without an enrollment roster', async () => {
  const value = 'root-produced';
  const verdict = await verifyConsumed(input({
    value,
    proof: proofFor(value, { producerKeyId: root.keyid }),
    grants: [],
  }), signerOptions());
  assertKind(verdict, 'verified');
});

test('tampering with the delivered value fails the signed value-digest link', async () => {
  const original = { answer: 42 };
  const verdict = await verifyConsumed(input({ value: { answer: 43 }, proof: proofFor(original) }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /value-digest/);
});

test('a delivered value that cannot be canonicalized is an invalid value-digest link', async () => {
  const delivered = new Map([['answer', 42]]);
  const verdict = await verifyConsumed(input({ value: delivered, proof: proofFor({ answer: 42 }) }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /cannot be canonically represented/);
});

test('a verified signer that disagrees with producerKeyId fails the signer-record link', async () => {
  const verdict = await verifyConsumed(input(), signerOptions(alternateProducer.keyid));
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /does not match record producerKeyId/);
});

test('a proof for another artifact path fails the artifact-path link', async () => {
  const value = { answer: 42 };
  const verdict = await verifyConsumed(input({ proof: proofFor(value, { artifact: 'other' }) }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /does not cover artifact 'input'/);
});

test('a signed version that differs from the consumer fingerprint fails the version link', async () => {
  const value = { answer: 42 };
  const verdict = await verifyConsumed(input({ proof: proofFor(value, { version: 3 }) }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /expected version 4/);
});

test('a target key absent from an available local roster is an invalid chain link', async () => {
  const value = { answer: 42 };
  const verdict = await verifyConsumed(input({ proof: proofFor(value, { producerKeyId: alternateProducer.keyid }), grants: [grantBytes(producer)] }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /chain/);
  assert.match(verdict.reason, /not present in the local enrollment roster/);
});

test('an unavailable enrollment roster is an unverifiable prerequisite', async () => {
  const value = { answer: 42 };
  const verdict = await verifyConsumed(input({ proof: proofFor(value, { producerKeyId: alternateProducer.keyid }), grants: [] }), options);
  assertFailure(verdict, 'unverifiable');
  assert.match(verdict.reason, /enrollment roster/);
});

test('a revoked producer key is invalid at the consumer clock time', async () => {
  const verdict = await verifyConsumed(input({
    revocations: [revocationBytes({
      revokedKey: producer.keyid,
      principal: { kind: 'machine', id: 'producer' },
      revokedBy: root.keyid,
      issuedAt: 50,
      effectiveFrom: 50,
      backdated: false,
    })],
  }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /revoked key/);
});

test('the same producer proof verifies before the revocation takes effect', async () => {
  const verdict = await verifyConsumed(input({
    at: 49,
    revocations: [revocationBytes({
      revokedKey: producer.keyid,
      principal: { kind: 'machine', id: 'producer' },
      revokedBy: root.keyid,
      issuedAt: 50,
      effectiveFrom: 50,
      backdated: false,
    })],
  }), options);
  assertKind(verdict, 'verified');
});

test('a producer scope that does not permit the consuming demand is invalid', async () => {
  const value = { answer: 42 };
  const verdict = await verifyConsumed(input({
    grants: [grantBytes(producer, marketingScope)],
    demand: { pool: 'finance' },
    proof: proofFor(value),
    value,
  }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /scope|outside the effective scope/);
});

test('a missing org-root anchor is an unverifiable prerequisite', async () => {
  const verdict = await verifyConsumed(input({ orgRootPublicKey: '' }), options);
  assertFailure(verdict, 'unverifiable');
  assert.match(verdict.reason, /org-root/);
});

test('missing proof is absent rather than invalid', async () => {
  const verdict = await verifyConsumed(input({ proof: undefined }), options);
  assertKind(verdict, 'absent');
});

test('submission schema validation runs after DSSE verification', async () => {
  const badRecord = { producerKeyId: producer.keyid, produced: [] };
  const verdict = await verifyConsumed(input({ proof: JSON.stringify(JSON.parse(Buffer.from(envelopeBytes(PAYLOAD_TYPE_SUBMISSION, badRecord)).toString('utf8'))) }), options);
  assertFailure(verdict, 'invalid');
  assert.match(verdict.reason, /submission record does not match schema/);
});
