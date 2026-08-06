import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeBase64Strict,
  dsseSignEnrollmentGrant,
  encodeBase64,
  PAYLOAD_TYPE_ENROLLMENT_GRANT,
} from '../src/crypto/dsse.ts';
import { keyidFromBlob } from '../src/crypto/keys.ts';
import {
  buildEnrollmentGrant,
  DEFAULT_MACHINE_SCOPE,
  verifyRosterEntry,
  type EnrollmentChainValidator,
} from '../src/crypto/enrollment.ts';
import type { EnrollmentGrantRecord } from '../src/crypto/records.ts';

const GRANTOR_BLOB = Buffer.from('synthetic-human-ed25519-key-blob');
const GRANTOR_KEY_ID = keyidFromBlob(GRANTOR_BLOB);
const ALLOWED_SIGNERS = `human ssh-ed25519 ${GRANTOR_BLOB.toString('base64')} fixture\n`;
const MACHINE_KEY_ID = `SHA256:${'A'.repeat(43)}`;

function grant(overrides: { grantedBy?: string; newKey?: EnrollmentGrantRecord['newKey'] } = {}): EnrollmentGrantRecord {
  return buildEnrollmentGrant({
    newKey: overrides.newKey === undefined
      ? {
          keyid: MACHINE_KEY_ID,
          keyType: 'ssh-ed25519',
          openSshPublicKey: 'ssh-ed25519 AAAAB3NzaC1lZDI1NTE5 synthetic-machine',
          comment: 'synthetic-machine',
        }
      : { ...overrides.newKey, comment: overrides.newKey.comment ?? '' },
    principal: { kind: 'machine', id: 'local' },
    scope: DEFAULT_MACHINE_SCOPE,
    grantedBy: overrides.grantedBy ?? GRANTOR_KEY_ID,
    validFrom: 0,
  });
}

async function makeSigned(record: EnrollmentGrantRecord = grant()) {
  let signedBytes = Buffer.alloc(0);
  const signed = await dsseSignEnrollmentGrant(Buffer.from(JSON.stringify(record), 'utf8'), {
    sign: async (bytes: Buffer) => {
      signedBytes = Buffer.from(bytes);
      return { keyid: GRANTOR_KEY_ID, sig: Buffer.from('synthetic-signature') };
    },
  });
  return { envelope: signed.envelope, signedBytes };
}

function verifier(expectedBytes: Buffer, resultKeyId = GRANTOR_KEY_ID) {
  return {
    verify: async (bytes: Buffer, _signature: Buffer) => {
      if (!bytes.equals(expectedBytes)) return null;
      return { keyid: resultKeyId, principal: 'human', format: 'sshsig' as const };
    },
  };
}

async function verify(
  envelope: unknown,
  signedBytes: Buffer,
  options: { chainValidator?: EnrollmentChainValidator } = {},
) {
  return verifyRosterEntry(
    { envelope, allowedSignersText: ALLOWED_SIGNERS },
    {
      ...options,
      signerForPrincipal: ({ principal, allowedSignersText }) => {
        assert.equal(principal, 'human');
        assert.equal(allowedSignersText, ALLOWED_SIGNERS);
        return verifier(signedBytes);
      },
    },
  );
}

test('enrollment grant builder freezes the complete least-privilege machine shape', () => {
  const record = grant();
  assert.deepEqual(record.scope, {
    pools: '*',
    labels: '*',
    namespaces: [],
    delegation: { allowed: false },
  });
  assert.equal(record.principal.kind, 'machine');
  assert.equal(record.principal.id, 'local');
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.scope));
  assert.ok(Object.isFrozen(record.scope.namespaces));
});

test('roster verification fails closed when no enrollment chain validator is installed', async () => {
  const { envelope, signedBytes } = await makeSigned();
  assert.deepEqual(await verify(envelope, signedBytes), {
    kind: 'unverifiable',
    reason: 'no enrollment chain validator is installed',
  });
});

test('roster verification accepts only after the chain validator approves', async () => {
  const { envelope, signedBytes } = await makeSigned();
  const chainValidator: EnrollmentChainValidator = {
    validate: async (record, verifiedSignerKeyId) => {
      assert.equal(record.newKey.keyid, MACHINE_KEY_ID);
      assert.equal(verifiedSignerKeyId, GRANTOR_KEY_ID);
      return { ok: true };
    },
  };
  assert.deepEqual(await verify(envelope, signedBytes, { chainValidator }), {
    kind: 'enrolled',
    keyid: MACHINE_KEY_ID,
    principal: 'human',
  });
});

test('hub-fabricated grant signed by a key outside allowed_signers is invalid', async () => {
  const hubBlob = Buffer.from('synthetic-hub-key-blob');
  const hubKeyId = keyidFromBlob(hubBlob);
  const { envelope, signedBytes } = await makeSigned(grant({ grantedBy: hubKeyId }));
  const result = await verifyRosterEntry(
    { envelope, allowedSignersText: ALLOWED_SIGNERS },
    { signerForPrincipal: () => verifier(signedBytes) },
  );
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /not present in allowed_signers/);
});

test('swapping a valid envelope payload makes the roster entry invalid', async () => {
  const { envelope, signedBytes } = await makeSigned();
  const swapped = { ...envelope as Record<string, unknown>, payload: encodeBase64(Buffer.from(JSON.stringify(grant({ newKey: {
    keyid: `SHA256:${'B'.repeat(43)}`,
    keyType: 'ssh-ed25519',
    openSshPublicKey: 'ssh-ed25519 AAAAB3NzaC1lZDI1NTE5 swapped',
    comment: 'swapped',
  } })), 'utf8')) };
  const result = await verify(swapped, signedBytes);
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /could not be verified/);
});

test('an absent envelope is unenrolled without consulting trust roots', async () => {
  assert.deepEqual(await verifyRosterEntry({}), { kind: 'unenrolled' });
});

test('malformed envelope payload is invalid', async () => {
  const result = await verifyRosterEntry({
    dsseBytes: Buffer.from(JSON.stringify({
      payloadType: PAYLOAD_TYPE_ENROLLMENT_GRANT,
      payload: decodeBase64Strict('e30=', { allowEmpty: true }).toString('base64'),
      signatures: [{ sig: encodeBase64(Buffer.from('x')) }],
    })),
    allowedSignersText: ALLOWED_SIGNERS,
  });
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /does not match schema/);
});
