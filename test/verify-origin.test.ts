import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { encodeBase64, PAYLOAD_TYPE_ORIGIN } from '../src/crypto/dsse.ts';
import { keyidFromBlob } from '../src/crypto/keys.ts';
import { verifyOrigin, type OriginVerdict } from '../src/crypto/verify-origin.ts';

const BUNDLE_DIGEST = 'a'.repeat(64);
const KEY_BLOB = Buffer.from('synthetic-ed25519-key-blob');
const KEY_ID = keyidFromBlob(KEY_BLOB);
const ALLOWED_SIGNERS = `publisher ssh-ed25519 ${KEY_BLOB.toString('base64')} fixture\n`;

function sidecar(record: Record<string, unknown>, overrides: Record<string, unknown> = {}): Uint8Array {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  return Buffer.from(JSON.stringify({
    payloadType: PAYLOAD_TYPE_ORIGIN,
    payload: encodeBase64(payload),
    signatures: [{ sig: encodeBase64(Buffer.from('synthetic-signature')), ...overrides }],
  }));
}

function record(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    digest: BUNDLE_DIGEST,
    name: 'fixture',
    version: '1.0.0',
    source: {
      kind: 'git',
      repo: 'https://github.com/example/workflow',
      commit: '0123456789abcdef0123456789abcdef01234567',
    },
    attesterKeyId: KEY_ID,
    timestamp: 0,
    ...overrides,
  };
}

function fakeSigner(result: { keyid: string; principal: string } | null) {
  return {
    verify: async (_bytes: Buffer, _sig: Buffer) =>
      result === null ? null : { ...result, format: 'sshsig' as const },
  };
}

async function verify(
  input: Parameters<typeof verifyOrigin>[0],
  result: { keyid: string; principal: string } | null = { keyid: KEY_ID, principal: 'publisher' },
): Promise<OriginVerdict> {
  return verifyOrigin(input, {
    signerForPrincipal: ({ principal, allowedSignersText }) => {
      assert.equal(principal, 'publisher');
      assert.equal(allowedSignersText, ALLOWED_SIGNERS);
      return fakeSigner(result);
    },
  });
}

test('origin verification distinguishes an absent sidecar', async () => {
  assert.deepEqual(await verifyOrigin({ bundleDigest: BUNDLE_DIGEST }), { kind: 'absent' });
});

test('origin verification distinguishes missing trust roots as unverifiable', async () => {
  assert.deepEqual(await verifyOrigin({ bundleDigest: BUNDLE_DIGEST, dsseBytes: sidecar(record()) }), {
    kind: 'unverifiable',
    reason: 'no allowed_signers trust root was resolved',
  });
});

test('origin verification maps malformed and empty allowed_signers to unverifiable', async () => {
  const malformed = await verifyOrigin(
    { bundleDigest: BUNDLE_DIGEST, dsseBytes: sidecar(record()), allowedSignersText: 'not-an-entry\n' },
    { signerForPrincipal: () => { throw new Error('must not construct a signer'); } },
  );
  assert.equal(malformed.kind, 'unverifiable');
  assert.match(malformed.reason, /allowed_signers policy is malformed/);

  const empty = await verifyOrigin(
    { bundleDigest: BUNDLE_DIGEST, dsseBytes: sidecar(record()), allowedSignersText: '\n# comment\n' },
    { signerForPrincipal: () => { throw new Error('must not construct a signer'); } },
  );
  assert.deepEqual(empty, { kind: 'unverifiable', reason: 'allowed_signers policy has no signer entries' });
});

test('origin verification maps malformed DSSE JSON to invalid', async () => {
  const result = await verify({
    bundleDigest: BUNDLE_DIGEST,
    dsseBytes: Buffer.from('{'),
    allowedSignersText: ALLOWED_SIGNERS,
  });
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /not valid JSON/);
});

test('origin verification rejects an attester key-id absent from allowed_signers', async () => {
  const result = await verifyOrigin({
    bundleDigest: BUNDLE_DIGEST,
    dsseBytes: sidecar(record({ attesterKeyId: `SHA256:${'A'.repeat(43)}` })),
    allowedSignersText: ALLOWED_SIGNERS,
  });
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /not present in allowed_signers/);
});

test('origin verification maps a valid signature over another digest to invalid', async () => {
  const result = await verify({
    bundleDigest: BUNDLE_DIGEST,
    dsseBytes: sidecar(record({ digest: 'b'.repeat(64) })),
    allowedSignersText: ALLOWED_SIGNERS,
  });
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /does not match bundle digest/);
});

test('origin verification maps a cryptographic miss to invalid', async () => {
  const result = await verify(
    { bundleDigest: BUNDLE_DIGEST, dsseBytes: sidecar(record()), allowedSignersText: ALLOWED_SIGNERS },
    null,
  );
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /could not be verified/);
});

test('origin verification cross-checks the returned signer key-id', async () => {
  const otherKeyId = `SHA256:${createHash('sha256').update('other').digest('base64').replace(/=+$/, '')}`;
  const result = await verify(
    { bundleDigest: BUNDLE_DIGEST, dsseBytes: sidecar(record()), allowedSignersText: ALLOWED_SIGNERS },
    { keyid: otherKeyId, principal: 'publisher' },
  );
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /does not match record attesterKeyId/);
});

test('origin verification rejects an unknown source kind after signature verification', async () => {
  const result = await verify({
    bundleDigest: BUNDLE_DIGEST,
    dsseBytes: sidecar(record({ source: { kind: 'future', value: 'not-supported' } })),
    allowedSignersText: ALLOWED_SIGNERS,
  });
  assert.equal(result.kind, 'invalid');
  assert.match(result.reason, /does not match schema/);
});

test('origin verification returns the signed source, key-id, and principal', async () => {
  const result = await verify({
    bundleDigest: BUNDLE_DIGEST,
    dsseBytes: sidecar(record()),
    allowedSignersText: ALLOWED_SIGNERS,
  });
  assert.deepEqual(result, {
    kind: 'verified',
    source: {
      kind: 'git',
      repo: 'https://github.com/example/workflow',
      commit: '0123456789abcdef0123456789abcdef01234567',
    },
    attesterKeyId: KEY_ID,
    principal: 'publisher',
  });
});

test('origin verification retries another principal attached to the same key', async () => {
  const policy = `publisher,backup ssh-ed25519 ${KEY_BLOB.toString('base64')} fixture\n`;
  const attempts: string[] = [];
  const result = await verifyOrigin(
    {
      bundleDigest: BUNDLE_DIGEST,
      dsseBytes: sidecar(record()),
      allowedSignersText: policy,
    },
    {
      signerForPrincipal: ({ principal }) => {
        attempts.push(principal);
        return fakeSigner(principal === 'publisher' ? null : { keyid: KEY_ID, principal });
      },
    },
  );
  assert.deepEqual(result, {
    kind: 'verified',
    source: {
      kind: 'git',
      repo: 'https://github.com/example/workflow',
      commit: '0123456789abcdef0123456789abcdef01234567',
    },
    attesterKeyId: KEY_ID,
    principal: 'backup',
  });
  assert.deepEqual(attempts, ['publisher', 'backup']);
});
