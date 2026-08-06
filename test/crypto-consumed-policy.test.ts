import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  encodeBase64,
  PAYLOAD_TYPE_ENROLLMENT_GRANT,
  PAYLOAD_TYPE_REVOCATION,
  PAYLOAD_TYPE_SUBMISSION,
} from '../src/crypto/dsse.ts';
import { keyidFromBlob, publicKeyDescriptor } from '../src/crypto/keys.ts';
import { valueDigestHex } from '../src/crypto/canonical.ts';
import type { EnrollmentGrantRecord, GrantScope, RevocationRecord } from '../src/crypto/records.ts';
import { createConsumedVerifier, resetConsumedVerifierWarningsForTests } from '../packages/work/src/consumed-verifier.ts';
import type { OrderPacket } from '../packages/work/src/hub/types.ts';

interface FixtureKey {
  keyid: string;
  publicKey: string;
}

function fixtureKey(name: string): FixtureKey {
  const blob = Buffer.from(`synthetic-consumed-policy-${name}`);
  return {
    keyid: keyidFromBlob(blob),
    publicKey: `ssh-ed25519 ${blob.toString('base64')} ${name}`,
  };
}

const root = fixtureKey('root');
const producer = fixtureKey('producer');
const unrestrictedScope: GrantScope = {
  pools: '*',
  labels: '*',
  namespaces: '*',
  delegation: { allowed: false },
};

function envelope(payloadType: string, payload: unknown): string {
  return JSON.stringify({
    payloadType,
    payload: encodeBase64(Buffer.from(JSON.stringify(payload), 'utf8')),
    signatures: [{ sig: encodeBase64(Buffer.from('synthetic-signature', 'utf8')) }],
  });
}

function submission(artifact: string, value: unknown, version = 4, producerKeyId = root.keyid): Record<string, unknown> {
  return {
    run: 'run-policy',
    workflow: 'wf-policy',
    defDigest: 'def-policy',
    step: 'producer',
    key: 'producer-key',
    produced: [{ artifact, version, valueDigest: valueDigestHex(value) }],
    consumedFingerprint: { upstream: 2 },
    producerKeyId,
    timestamp: 10,
  };
}

function proof(artifact: string, value: unknown, version = 4, producerKeyId = root.keyid): string {
  return envelope(PAYLOAD_TYPE_SUBMISSION, submission(artifact, value, version, producerKeyId));
}

function rootOrder(overrides: Partial<OrderPacket> = {}): OrderPacket {
  const value = { answer: 42 };
  return {
    run: 'run-policy',
    workflow: 'wf-policy',
    step: 'consumer',
    key: 'consumer-key',
    defDigest: 'def-policy',
    inputs: ['input'],
    outputs: ['output'],
    consumes: { input: value },
    consumedFingerprint: { input: 4 },
    consumesProof: JSON.stringify({ input: proof('input', value) }),
    owes: [],
    ...overrides,
  };
}

function trustRootEnv(): Record<string, string | undefined> {
  const config = mkdtempSync(join(tmpdir(), 'owenloop-consumed-policy-'));
  mkdirSync(join(config, 'owenloop'), { recursive: true });
  writeFileSync(join(config, 'owenloop', 'org-root.pub'), root.publicKey);
  return { XDG_CONFIG_HOME: config };
}

function signerForPrincipal({ allowedSignersText }: { allowedSignersText: string }) {
  const publicKey = allowedSignersText.trim().split(/\s+/).slice(1).join(' ');
  const selected = publicKeyDescriptor(publicKey);
  return {
    verify: async () => ({
      keyid: selected.keyid,
      principal: 'synthetic-signer',
      format: 'sshsig' as const,
    }),
  };
}

function grantBytes(): Uint8Array {
  const record: EnrollmentGrantRecord = {
    newKey: {
      keyid: producer.keyid,
      keyType: 'ssh-ed25519',
      openSshPublicKey: producer.publicKey,
      comment: 'producer',
    },
    principal: { kind: 'machine', id: 'producer' },
    scope: unrestrictedScope,
    grantedBy: root.keyid,
    validFrom: 0,
  };
  return Buffer.from(envelope(PAYLOAD_TYPE_ENROLLMENT_GRANT, record));
}

function revocationBytes(effectiveFrom: number): Uint8Array {
  const record: RevocationRecord = {
    revokedKey: producer.keyid,
    principal: { kind: 'machine', id: 'producer' },
    revokedBy: root.keyid,
    issuedAt: effectiveFrom,
    effectiveFrom,
    backdated: false,
  };
  return Buffer.from(envelope(PAYLOAD_TYPE_REVOCATION, record));
}

function producerOrder(): OrderPacket {
  const first = 'first';
  const second = { second: true };
  return {
    run: 'run-policy-producer',
    workflow: 'wf-policy',
    step: 'consumer',
    key: 'consumer-key',
    defDigest: 'def-policy',
    inputs: ['first', 'second'],
    outputs: ['output'],
    consumes: { first, second },
    consumedFingerprint: { first: 4, second: 4 },
    consumesProof: JSON.stringify({
      first: proof('first', first, 4, producer.keyid),
      second: proof('second', second, 4, producer.keyid),
    }),
    owes: [],
  };
}

afterEach(() => {
  resetConsumedVerifierWarningsForTests();
});

test('verified consumed evidence passes at every artifact-policy level', async () => {
  for (const artifactPolicy of ['off', 'warn', 'enforce'] as const) {
    const env = trustRootEnv();
    const verifier = createConsumedVerifier({
      env,
      artifactPolicy,
      now: () => 100,
      signerForPrincipal,
    });
    const result = await verifier(rootOrder(), { hardRule: false });
    assert.equal(result.ok, true, artifactPolicy);
    if (result.ok) assert.deepEqual(result.warnings, [], artifactPolicy);
  }
});

test('absent proof follows the artifact-policy matrix', async () => {
  for (const [artifactPolicy, expected] of [
    ['off', 'pass'],
    ['warn', 'warn'],
    ['enforce', 'refuse'],
  ] as const) {
    const env = trustRootEnv();
    const verifier = createConsumedVerifier({
      env,
      artifactPolicy,
      now: () => 100,
      signerForPrincipal,
    });
    const result = await verifier(rootOrder({ consumesProof: undefined }), { hardRule: false });
    if (expected === 'refuse') {
      assert.equal(result.ok, false, artifactPolicy);
      if (!result.ok) assert.match(result.reason, /no-proof/);
    } else {
      assert.equal(result.ok, true, artifactPolicy);
      if (result.ok) {
        assert.equal(result.warnings.length, expected === 'warn' ? 1 : 0, artifactPolicy);
        if (expected === 'warn') assert.match(result.warnings[0]!, /no-proof/);
      }
    }
  }
});

test('invalid evidence refuses even when artifact policy is off', async () => {
  const env = trustRootEnv();
  const value = { answer: 42 };
  const verifier = createConsumedVerifier({
    env,
    artifactPolicy: 'off',
    now: () => 100,
    signerForPrincipal,
  });
  const result = await verifier(rootOrder({
    consumes: { input: { answer: 43 } },
    consumesProof: JSON.stringify({ input: proof('input', value) }),
  }), { hardRule: false });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /value-digest/);
    assert.match(result.reason, /artifact 'input'/);
  }
});

test('hard-rule consumers refuse absent evidence even when artifact policy is off', async () => {
  const env = trustRootEnv();
  const verifier = createConsumedVerifier({
    env,
    artifactPolicy: 'off',
    now: () => 100,
    signerForPrincipal,
  });
  const result = await verifier(rootOrder({ consumesProof: undefined }), { hardRule: true });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /no-proof/);
});

test('one fixed consumer-clock sample governs every consumed path', async () => {
  const env = trustRootEnv();
  const order = producerOrder();
  const grants = [grantBytes()];
  mkdirSync(join(env.XDG_CONFIG_HOME!, 'owenloop', 'roster'), { recursive: true });
  writeFileSync(join(env.XDG_CONFIG_HOME!, 'owenloop', 'roster', 'producer.grant.dsse'), grants[0]!);
  mkdirSync(join(env.XDG_CONFIG_HOME!, 'owenloop', 'revocations'), { recursive: true });
  writeFileSync(join(env.XDG_CONFIG_HOME!, 'owenloop', 'revocations', 'producer.revocation.dsse'), revocationBytes(101));

  let nowCalls = 0;
  const verifier = createConsumedVerifier({
    env,
    artifactPolicy: 'enforce',
    now: () => {
      nowCalls += 1;
      return 100;
    },
    signerForPrincipal,
  });
  const result = await verifier(order, { hardRule: false });
  assert.equal(result.ok, true);
  assert.equal(nowCalls, 1);
});

test('chain validation is memoized per producer key and fixed clock within one gate call', async () => {
  const env = trustRootEnv();
  mkdirSync(join(env.XDG_CONFIG_HOME!, 'owenloop', 'roster'), { recursive: true });
  writeFileSync(join(env.XDG_CONFIG_HOME!, 'owenloop', 'roster', 'producer.grant.dsse'), grantBytes());
  let verificationCalls = 0;
  const countingSigner = ({ allowedSignersText }: { allowedSignersText: string }) => {
    const publicKey = allowedSignersText.trim().split(/\s+/).slice(1).join(' ');
    const selected = publicKeyDescriptor(publicKey);
    return {
      verify: async () => {
        verificationCalls += 1;
        return { keyid: selected.keyid, principal: 'synthetic-signer', format: 'sshsig' as const };
      },
    };
  };
  const verifier = createConsumedVerifier({
    env,
    artifactPolicy: 'enforce',
    now: () => 100,
    signerForPrincipal: countingSigner,
  });
  const result = await verifier(producerOrder(), { hardRule: false });
  assert.equal(result.ok, true);
  // Two submission signatures plus one shared enrollment-grant signature.
  assert.equal(verificationCalls, 3);
});

test('missing-org-root warnings are latched once per order and resettable', async () => {
  const env = { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'owenloop-consumed-no-root-')) };
  const value = 'value';
  const order = rootOrder({
    run: 'run-warning',
    consumes: { first: value, second: value },
    consumedFingerprint: { first: 4, second: 4 },
    consumesProof: JSON.stringify({ first: proof('first', value), second: proof('second', value) }),
  });
  const verifier = createConsumedVerifier({
    env,
    artifactPolicy: 'warn',
    now: () => 100,
    signerForPrincipal,
  });
  const first = await verifier(order, { hardRule: false });
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.warnings.length, 1);

  const second = await verifier(order, { hardRule: false });
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.warnings.length, 0);

  resetConsumedVerifierWarningsForTests();
  const third = await verifier(order, { hardRule: false });
  assert.equal(third.ok, true);
  if (third.ok) assert.equal(third.warnings.length, 1);
});

test('other unverifiable prerequisites warn for each affected artifact', async () => {
  const verifier = createConsumedVerifier({
    env: trustRootEnv(),
    artifactPolicy: 'warn',
    now: () => 100,
    signerForPrincipal,
  });
  const result = await verifier(rootOrder({
    consumes: { first: 'first', second: 'second' },
    consumesProof: '{malformed-json',
  }), { hardRule: false });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0]!, /artifact 'first'/);
    assert.match(result.warnings[1]!, /artifact 'second'/);
  }
});

// Keep the revocation payload type imported in the test's fixture helper even
// when the fixed-clock test is compiled with isolated module analysis.
void PAYLOAD_TYPE_REVOCATION;
