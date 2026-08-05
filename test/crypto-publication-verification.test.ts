import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  encodeBase64,
  PAYLOAD_TYPE_PUBLICATION,
} from '../src/crypto/dsse.ts';
import { keyidFromBlob } from '../src/crypto/keys.ts';
import {
  verifyPublication,
  type DefVerdict,
} from '../src/crypto/verify-publication.ts';

const BUNDLE_DIGEST = 'a'.repeat(64);
const KEY_BLOB = Buffer.from('synthetic-ed25519-key-blob');
const KEY_ID = keyidFromBlob(KEY_BLOB);
const ALLOWED_SIGNERS = `publisher ssh-ed25519 ${KEY_BLOB.toString('base64')} fixture\n`;

function sidecar(record: Record<string, unknown>, overrides: Record<string, unknown> = {}): Uint8Array {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  return Buffer.from(JSON.stringify({
    payloadType: PAYLOAD_TYPE_PUBLICATION,
    payload: encodeBase64(payload),
    signatures: [{ sig: encodeBase64(Buffer.from('synthetic-signature')), ...overrides }],
  }));
}

function record(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    digest: BUNDLE_DIGEST,
    name: 'fixture',
    version: '1.0.0',
    publisherKeyId: KEY_ID,
    timestamp: 0,
    ...overrides,
  };
}

function fakeSigner(result: { keyid: string; principal: string } | null, calls: string[] = []) {
  return {
    verify: async (_bytes: Buffer, _sig: Buffer) => {
      calls.push('verify');
      return result === null ? null : { ...result, format: 'sshsig' as const };
    },
  };
}

async function verify(
  input: Parameters<typeof verifyPublication>[0],
  result: { keyid: string; principal: string } | null = { keyid: KEY_ID, principal: 'publisher' },
): Promise<DefVerdict> {
  return verifyPublication(input, {
    signerForPrincipal: ({ principal, allowedSignersText }) => {
      assert.equal(principal, 'publisher');
      assert.equal(allowedSignersText, ALLOWED_SIGNERS);
      return fakeSigner(result);
    },
  });
}

test('publication verification distinguishes an absent sidecar as unsigned', async () => {
  assert.deepEqual(await verifyPublication({ bundleDigest: BUNDLE_DIGEST }), { kind: 'unsigned' });
});

test('publication verification distinguishes missing trust roots as unverifiable', async () => {
  assert.deepEqual(await verifyPublication({ bundleDigest: BUNDLE_DIGEST, dsseBytes: sidecar(record()) }), {
    kind: 'unverifiable',
    reason: 'no allowed_signers trust root was resolved',
  });
});

test('publication verification maps malformed allowed_signers to unverifiable', async () => {
  const result = await verifyPublication(
    { bundleDigest: BUNDLE_DIGEST, dsseBytes: sidecar(record()), allowedSignersText: 'not-an-entry\n' },
    { signerForPrincipal: () => { throw new Error('must not construct a signer'); } },
  );
  assert.equal(result.kind, 'unverifiable');
  assert.match(result.reason, /allowed_signers policy is malformed/);
});

test('publication verification maps malformed DSSE JSON to invalid', async () => {
  const result = await verify({
    bundleDigest: BUNDLE_DIGEST,
    dsseBytes: Buffer.from('{'),
    allowedSignersText: ALLOWED_SIGNERS,
  });
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /not valid JSON/);
});

test('publication verification maps a valid signature over another digest to invalid', async () => {
  const result = await verify({
    bundleDigest: BUNDLE_DIGEST,
    dsseBytes: sidecar(record({ digest: 'b'.repeat(64) })),
    allowedSignersText: ALLOWED_SIGNERS,
  });
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /does not match bundle digest/);
});

test('publication verification maps a cryptographic miss to invalid', async () => {
  const result = await verify(
    { bundleDigest: BUNDLE_DIGEST, dsseBytes: sidecar(record()), allowedSignersText: ALLOWED_SIGNERS },
    null,
  );
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /could not be verified/);
});

test('publication verification maps a returned signer key-id mismatch to invalid', async () => {
  const otherKeyId = `SHA256:${createHash('sha256').update('other').digest('base64').replace(/=+$/, '')}`;
  const result = await verify(
    { bundleDigest: BUNDLE_DIGEST, dsseBytes: sidecar(record()), allowedSignersText: ALLOWED_SIGNERS },
    { keyid: otherKeyId, principal: 'publisher' },
  );
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /does not match record publisherKeyId/);
});

test('publication verification returns verified with the matching key-id and principal', async () => {
  const result = await verify({
    bundleDigest: BUNDLE_DIGEST,
    dsseBytes: sidecar(record()),
    allowedSignersText: ALLOWED_SIGNERS,
  });
  assert.deepEqual(result, {
    kind: 'verified',
    publisherKeyId: KEY_ID,
    principal: 'publisher',
  });
});

test('publication verification rejects a publisher key-id absent from allowed_signers', async () => {
  const result = await verifyPublication({
    bundleDigest: BUNDLE_DIGEST,
    dsseBytes: sidecar(record({ publisherKeyId: `SHA256:${'A'.repeat(43)}` })),
    allowedSignersText: ALLOWED_SIGNERS,
  });
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /not present in allowed_signers/);
});

test('publication verification rejects malformed signature fields as invalid', async () => {
  const result = await verifyPublication({
    bundleDigest: BUNDLE_DIGEST,
    dsseBytes: sidecar(record(), { sig: '!' }),
    allowedSignersText: ALLOWED_SIGNERS,
  }, {
    signerForPrincipal: () => fakeSigner({ keyid: KEY_ID, principal: 'publisher' }),
  });
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /signatures\[0\]/);
});
