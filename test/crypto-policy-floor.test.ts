import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DSSE_SSH_NAMESPACE,
  encodeBase64,
  PAYLOAD_TYPE_ENROLLMENT_GRANT,
  PAYLOAD_TYPE_POLICY_FLOOR,
  PAYLOAD_TYPE_REVOCATION,
  preAuthEncode,
} from '../src/crypto/dsse.ts';
import { keyidFromBlob, publicKeyDescriptor } from '../src/crypto/keys.ts';
import {
  DEF_POLICY_RANK,
  POLICY_FLOOR_PRESETS,
  artifactPolicyMinimum,
  floorDefPolicyMinimum,
  mergePolicyFloorWithLocal,
  originRulesMinimum,
  policyFloorGaps,
  verifyPolicyFloorRecord,
} from '../src/crypto/policy-floor.ts';
import type {
  EnrollmentGrantRecord,
  GrantScope,
  PolicyFloor,
  PolicyFloorRecord,
  RevocationRecord,
} from '../src/crypto/records.ts';
import type { VerifyPolicyFloorInput, VerifyPolicyFloorOptions } from '../src/crypto/policy-floor.ts';

interface FixtureKey {
  keyid: string;
  publicKey: string;
}

function fixtureKey(name: string): FixtureKey {
  const blob = Buffer.from(`synthetic-policy-floor-${name}`);
  return {
    keyid: keyidFromBlob(blob),
    publicKey: `ssh-ed25519 ${blob.toString('base64')} ${name}`,
  };
}

const root = fixtureKey('root');
const floorSigner = fixtureKey('floor-signer');
const intermediate = fixtureKey('intermediate');

const adminScope: GrantScope = {
  pools: '*',
  labels: '*',
  namespaces: '*',
  delegation: { allowed: true, maxDepth: 'unbounded' },
};
const limitedScope: GrantScope = {
  pools: ['marketing'],
  labels: '*',
  namespaces: '*',
  delegation: { allowed: false },
};
const DEFAULT_FLOOR: PolicyFloor = {
  trustMode: 'strict',
  unsignedDefs: 'refuse',
  unsignedArtifacts: 'refuse',
  originRules: 'enforced',
};

function envelopeBytes(payloadType: string, payload: Buffer, signature = 'synthetic-signature'): Uint8Array {
  return Buffer.from(JSON.stringify({
    payloadType,
    payload: encodeBase64(payload),
    signatures: [{ sig: encodeBase64(Buffer.from(signature)) }],
  }));
}

function recordPayload(record: unknown): Buffer {
  return Buffer.from(JSON.stringify(record), 'utf8');
}

function floorRecord(floor: PolicyFloor = DEFAULT_FLOOR): PolicyFloorRecord {
  return {
    org: 'example-org',
    issuedAt: 100,
    signedBy: floorSigner.keyid,
    floor,
  };
}

function floorEnvelope(floor: PolicyFloor = DEFAULT_FLOOR): Uint8Array {
  return envelopeBytes(PAYLOAD_TYPE_POLICY_FLOOR, recordPayload(floorRecord(floor)), 'floor-signature');
}

function grant(
  key: FixtureKey,
  principal: { kind: 'human' | 'machine' | 'agent'; id: string },
  grantedBy: string,
  scope: GrantScope,
): Uint8Array {
  const record: EnrollmentGrantRecord = {
    newKey: {
      keyid: key.keyid,
      keyType: 'ssh-ed25519',
      openSshPublicKey: key.publicKey,
      comment: key.publicKey.split(' ')[2],
    },
    principal,
    scope,
    grantedBy,
    validFrom: 0,
  };
  return envelopeBytes(PAYLOAD_TYPE_ENROLLMENT_GRANT, recordPayload(record));
}

function revocation(record: RevocationRecord): Uint8Array {
  return envelopeBytes(PAYLOAD_TYPE_REVOCATION, recordPayload(record));
}

function validInput(
  floor: PolicyFloor = DEFAULT_FLOOR,
  overrides: Partial<VerifyPolicyFloorInput> = {},
): VerifyPolicyFloorInput {
  return {
    envelopeBytes: floorEnvelope(floor),
    orgRootPublicKey: root.publicKey,
    grants: [grant(floorSigner, { kind: 'machine', id: 'floor-signer' }, root.keyid, adminScope)],
    at: 100,
    ...overrides,
  };
}

interface SignerCall {
  principal: string;
  allowedSignersText: string;
  bytes: Buffer;
}

function signerFixture(reject = false): { options: VerifyPolicyFloorOptions; calls: SignerCall[] } {
  const calls: SignerCall[] = [];
  return {
    calls,
    options: {
      namespace: DSSE_SSH_NAMESPACE,
      signerForPrincipal: ({ principal, allowedSignersText }) => {
        const parts = allowedSignersText.trim().split(/\s+/);
        const publicKey = parts.slice(1).join(' ');
        const descriptor = publicKeyDescriptor(publicKey);
        return {
          verify: async (bytes: Buffer) => {
            calls.push({ principal, allowedSignersText, bytes });
            if (reject) return null;
            return { keyid: descriptor.keyid, principal, format: 'sshsig' as const };
          },
        };
      },
    },
  };
}

test('a valid signed floor more permissive than local policy does not lower it', async () => {
  const permissive: PolicyFloor = { ...DEFAULT_FLOOR, unsignedDefs: 'warn' };
  const signer = signerFixture();
  const verdict = await verifyPolicyFloorRecord(validInput(permissive), signer.options);
  assert.equal(verdict.kind, 'verified');
  if (verdict.kind !== 'verified') return;

  const merged = mergePolicyFloorWithLocal('enforce', verdict.record.floor);
  assert.equal(merged.effective, 'enforce');
  assert.equal(merged.local, 'enforce');
  assert.equal(merged.raised, false);
});

test('a verified refuse floor raises local warn to enforce', () => {
  const merged = mergePolicyFloorWithLocal('warn', DEFAULT_FLOOR);
  assert.equal(merged.effective, 'enforce');
  assert.equal(merged.raised, true);
});

test('local off cannot opt out of a verified floor', () => {
  assert.equal(mergePolicyFloorWithLocal('off', { ...DEFAULT_FLOOR, unsignedDefs: 'warn' }).effective, 'warn');
  assert.equal(mergePolicyFloorWithLocal('off', { ...DEFAULT_FLOOR, unsignedDefs: 'refuse' }).effective, 'enforce');
});

test('no floor value maps to off', () => {
  for (const unsignedDefs of ['warn', 'refuse'] as const) {
    assert.notEqual(floorDefPolicyMinimum({ ...DEFAULT_FLOOR, unsignedDefs }), 'off');
  }
  assert.deepEqual(DEF_POLICY_RANK, { off: 0, warn: 1, enforce: 2 });
});

test('failure modes never produce a floor or relax local policy', async () => {
  const malformedRecord = {
    ...floorRecord(),
    floor: { ...DEFAULT_FLOOR, trustMode: 'maximum' },
  };
  const revoked = revocation({
    revokedKey: floorSigner.keyid,
    principal: { kind: 'machine', id: 'floor-signer' },
    revokedBy: root.keyid,
    issuedAt: 100,
    effectiveFrom: 100,
    backdated: false,
  });

  const cases: Array<{
    name: string;
    input?: VerifyPolicyFloorInput;
    options?: VerifyPolicyFloorOptions;
  }> = [
    { name: 'absent' },
    { name: 'malformed envelope', input: validInput(DEFAULT_FLOOR, { envelopeBytes: Buffer.from('{') }) },
    { name: 'schema-invalid', input: validInput(DEFAULT_FLOOR, { envelopeBytes: envelopeBytes(PAYLOAD_TYPE_POLICY_FLOOR, recordPayload(malformedRecord)) }) },
    { name: 'bad signature', input: validInput(), options: signerFixture(true).options },
    {
      name: 'no chain to org root',
      input: validInput(DEFAULT_FLOOR, {
        grants: [grant(floorSigner, { kind: 'machine', id: 'floor-signer' }, intermediate.keyid, adminScope)],
      }),
    },
    {
      name: 'insufficient scope',
      input: validInput(DEFAULT_FLOOR, {
        grants: [grant(floorSigner, { kind: 'machine', id: 'floor-signer' }, root.keyid, limitedScope)],
      }),
    },
    { name: 'revoked signer', input: validInput(DEFAULT_FLOOR, { revocations: [revoked] }) },
    { name: 'no org-root anchor', input: validInput(DEFAULT_FLOOR, { orgRootPublicKey: '' }) },
  ];

  for (const row of cases) {
    let verdict: { kind: string } | undefined;
    if (row.input !== undefined) {
      verdict = await verifyPolicyFloorRecord(row.input, row.options ?? signerFixture().options);
      assert.notEqual(verdict.kind, 'verified', row.name);
    }
    for (const local of ['off', 'warn', 'enforce'] as const) {
      const merged = mergePolicyFloorWithLocal(local, undefined);
      assert.equal(merged.effective, local, `${row.name}: effective policy changed`);
      assert.equal(merged.raised, false, `${row.name}: policy was raised without a floor`);
    }
  }
});

test('an adversarial hub can replace, replay, or withhold a floor but cannot lower local policy', () => {
  const permissive: PolicyFloor = { ...DEFAULT_FLOOR, unsignedDefs: 'warn' };
  assert.equal(mergePolicyFloorWithLocal('warn', permissive).effective, 'warn', 'replacement cannot lower warn');
  assert.equal(mergePolicyFloorWithLocal('enforce', permissive).effective, 'enforce', 'replayed older floor cannot lower enforce');
  assert.equal(mergePolicyFloorWithLocal('enforce', undefined).effective, 'enforce', 'withholding cannot lower enforce');
});

test('artifact floor modes map warn to warn and refuse to enforce', () => {
  assert.equal(artifactPolicyMinimum(POLICY_FLOOR_PRESETS.L0), 'warn');
  assert.equal(artifactPolicyMinimum(POLICY_FLOOR_PRESETS.L1), 'enforce');
  assert.equal(artifactPolicyMinimum(POLICY_FLOOR_PRESETS.L2), 'enforce');
  assert.equal(mergePolicyFloorWithLocal('off', POLICY_FLOOR_PRESETS.L0, 'off', 'off').artifactPolicy, 'warn');
  assert.equal(mergePolicyFloorWithLocal('off', POLICY_FLOOR_PRESETS.L1, 'off', 'off').artifactPolicy, 'enforce');
  assert.equal(mergePolicyFloorWithLocal('warn', POLICY_FLOOR_PRESETS.L2, 'off', 'warn').artifactPolicy, 'enforce');
});

test('origin floor modes map advisory to warn and enforced to enforce', () => {
  assert.equal(originRulesMinimum(POLICY_FLOOR_PRESETS.L0), 'warn');
  assert.equal(originRulesMinimum(POLICY_FLOOR_PRESETS.L1), 'warn');
  assert.equal(originRulesMinimum(POLICY_FLOOR_PRESETS.L2), 'enforce');
  assert.equal(mergePolicyFloorWithLocal('off', POLICY_FLOOR_PRESETS.L0).originPolicy, 'warn');
  assert.equal(mergePolicyFloorWithLocal('off', POLICY_FLOOR_PRESETS.L1).originPolicy, 'warn');
  assert.equal(mergePolicyFloorWithLocal('off', POLICY_FLOOR_PRESETS.L2).originPolicy, 'enforce');
  assert.equal(mergePolicyFloorWithLocal('enforce', POLICY_FLOOR_PRESETS.L0, 'enforce').originPolicy, 'enforce');
});

test('presets match the documented bundles and report every unenforced axis', () => {
  assert.deepEqual(POLICY_FLOOR_PRESETS.L0, {
    trustMode: 'seamless', unsignedDefs: 'warn', unsignedArtifacts: 'warn', originRules: 'advisory',
  });
  assert.deepEqual(POLICY_FLOOR_PRESETS.L1, {
    trustMode: 'seamless', unsignedDefs: 'refuse', unsignedArtifacts: 'refuse', originRules: 'advisory',
  });
  assert.deepEqual(POLICY_FLOOR_PRESETS.L2, {
    trustMode: 'strict', unsignedDefs: 'refuse', unsignedArtifacts: 'refuse', originRules: 'enforced',
  });
  for (const floor of Object.values(POLICY_FLOOR_PRESETS)) {
    assert.deepEqual(policyFloorGaps(floor).map((gap) => gap.axis), [
      'trustMode',
    ]);
  }
});

test('verification consumes the stored envelope payload bytes without reserializing them', async () => {
  const payloadText = `{"floor":{"originRules":"advisory","unsignedArtifacts":"warn","unsignedDefs":"refuse","trustMode":"strict"},"signedBy":"${floorSigner.keyid}","issuedAt":100,"org":"example-org"}`;
  const payloadBytes = Buffer.from(payloadText, 'utf8');
  const signer = signerFixture();
  const verdict = await verifyPolicyFloorRecord(
    validInput(DEFAULT_FLOOR, {
      envelopeBytes: envelopeBytes(PAYLOAD_TYPE_POLICY_FLOOR, payloadBytes, 'floor-signature'),
    }),
    signer.options,
  );
  assert.equal(verdict.kind, 'verified');
  const floorCall = signer.calls.find((call) => call.principal === 'machine:floor-signer');
  assert.ok(floorCall);
  assert.deepEqual(floorCall.bytes, preAuthEncode(PAYLOAD_TYPE_POLICY_FLOOR, payloadBytes));
});
