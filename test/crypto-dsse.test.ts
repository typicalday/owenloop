/**
 * DSSE envelope framing — pure-logic tests (no child processes, no ambient
 * state). Covers: the PAE byte layout against the protocol's public
 * "hello world" vector; strict Base64 decode (standard AND URL-safe in,
 * malformed rejected — Node's permissive decoder is never trusted); the fixed
 * verification order (decode → PAE → signatures → type check); threshold and
 * same-key dedup; and the record wrappers that pin one payload type per class.
 *
 * The signature side is a scripted fake `Signer` (DSSE is format-neutral by
 * contract); the REAL signer is exercised against stock `ssh-keygen` in
 * `crypto-ssh.test.ts`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DSSE_SSH_NAMESPACE,
  DSSE_VERSION,
  DsseEnvelopeError,
  PAYLOAD_TYPE_ENROLLMENT_GRANT,
  PAYLOAD_TYPE_ORIGIN,
  PAYLOAD_TYPE_POLICY_FLOOR,
  PAYLOAD_TYPE_REVOCATION,
  PAYLOAD_TYPE_SUBMISSION,
  decodeBase64Strict,
  dsseSignEnrollmentGrant,
  dsseSignEnvelope,
  dsseSignOrigin,
  dsseSignPolicyFloor,
  dsseSignRecord,
  dsseSignRevocation,
  dsseSignSubmission,
  dsseVerifyEnrollmentGrant,
  dsseVerifyEnvelope,
  dsseVerifyOrigin,
  dsseVerifyPolicyFloor,
  dsseVerifyRecord,
  dsseVerifyRevocation,
  dsseVerifySubmission,
  encodeBase64,
  preAuthEncode,
} from '../src/crypto/dsse.ts';
import type { VerifiedSignature } from '../src/crypto/ssh.ts';

const HELLO_TYPE = 'http://example.com/HelloWorld';
const HELLO_PAYLOAD_B64 = 'aGVsbG8gd29ybGQ=';
/** The protocol document's public PAE example — no private scalar involved. */
const HELLO_PAE = 'DSSEv1 29 http://example.com/HelloWorld 11 hello world';

/** A scripted fake signer: every verify returns `result` and records the call. */
function fakeSigner(result: VerifiedSignature | null): {
  verify: (bytes: Buffer, sig: Buffer) => Promise<VerifiedSignature | null>;
  calls: { bytes: Buffer; sig: Buffer }[];
} {
  const calls: { bytes: Buffer; sig: Buffer }[] = [];
  return {
    async verify(bytes: Buffer, sig: Buffer) {
      calls.push({ bytes, sig });
      return result;
    },
    calls,
  };
}

/** A verify callback that accepts ONLY the exact signature bytes given. */
function strictVerifier(expectedSig: Buffer): {
  verify: (bytes: Buffer, sig: Buffer) => Promise<VerifiedSignature | null>;
  calls: { bytes: Buffer; sig: Buffer }[];
} {
  const calls: { bytes: Buffer; sig: Buffer }[] = [];
  return {
    async verify(bytes: Buffer, sig: Buffer) {
      calls.push({ bytes, sig });
      return sig.equals(expectedSig) ? { keyid: 'SHA256:fake', principal: 'p', format: 'sshsig' } : null;
    },
    calls,
  };
}

test('payload type constants are the five signed record classes, versioned', () => {
  assert.equal(PAYLOAD_TYPE_ENROLLMENT_GRANT, 'application/vnd.owenloop.enrollment-grant.v1+json');
  assert.equal(PAYLOAD_TYPE_REVOCATION, 'application/vnd.owenloop.revocation.v1+json');
  assert.equal(PAYLOAD_TYPE_SUBMISSION, 'application/vnd.owenloop.submission.v1+json');
  assert.equal(PAYLOAD_TYPE_POLICY_FLOOR, 'application/vnd.owenloop.policy-floor.v1+json');
  assert.equal(PAYLOAD_TYPE_ORIGIN, 'application/vnd.owenloop.origin.v1+json');
  assert.equal(DSSE_VERSION, 'DSSEv1');
  assert.equal(DSSE_SSH_NAMESPACE, 'owenloop-dsse-v1');
});

// ---- PAE --------------------------------------------------------------------

test('preAuthEncode matches the protocol public vector byte-for-byte', () => {
  const pae = preAuthEncode(HELLO_TYPE, Buffer.from('hello world', 'utf8'));
  assert.equal(pae.toString('utf8'), HELLO_PAE);
});

test('preAuthEncode: type length is UTF-8 BYTES and decimal with no leading zeroes', () => {
  // 'é' is 2 UTF-8 bytes; the type "tép" is 4 bytes.
  const pae = preAuthEncode('tép', Buffer.from('x', 'utf8'));
  assert.equal(pae.toString('utf8'), 'DSSEv1 4 tép 1 x');
  // 10-char type exercises two-digit decimal (no zero padding).
  const ten = 'abcdefghij';
  const pae2 = preAuthEncode(ten, Buffer.alloc(0));
  assert.equal(pae2.toString('utf8'), `DSSEv1 10 ${ten} 0 `);
});

test('preAuthEncode: empty payload still carries the length field', () => {
  assert.equal(preAuthEncode('t', Buffer.alloc(0)).toString('utf8'), 'DSSEv1 1 t 0 ');
});

// ---- strict Base64 ------------------------------------------------------------

test('decodeBase64Strict: standard and URL-safe alphabets both decode', () => {
  const bytes = Buffer.from([0xfb, 0xef, 0xbf]); // base64: +++/ vs ---_ shape
  assert.deepEqual(decodeBase64Strict('+++/'), bytes);
  assert.deepEqual(decodeBase64Strict('---_'), bytes);
  assert.deepEqual(decodeBase64Strict('aGVsbG8gd29ybGQ='), Buffer.from('hello world'));
  assert.deepEqual(decodeBase64Strict('aGVsbG8gd29ybGQ'), Buffer.from('hello world'), 'padding optional');
  assert.deepEqual(decodeBase64Strict('aaa='), Buffer.from([0x69, 0xa6]), 'a single = pad is legal');
  assert.throws(() => decodeBase64Strict('  aGVs\r\nbG8=  '), DsseEnvelopeError, 'whitespace is rejected');
});

test('decodeBase64Strict: malformed inputs throw DsseEnvelopeError (Node decoder is permissive)', () => {
  const bad = ['', 'a', 'a====', 'ab=cd', 'a!b', 'abcde', 'ab=c'];
  for (const s of bad) {
    assert.throws(() => decodeBase64Strict(s), DsseEnvelopeError, `rejects ${JSON.stringify(s)}`);
  }
  // The permissive Node decoder would happily return bytes for an out-of-alphabet
  // character instead of failing — which is exactly why wire input never uses it.
  assert.equal(Buffer.from('a!b', 'base64').length > 0, true, 'sanity: Node would not reject');
});

test('encodeBase64 emits standard RFC4648 with padding', () => {
  assert.equal(encodeBase64(Buffer.from('hello world')), HELLO_PAYLOAD_B64);
});

// ---- verify: fixed order ------------------------------------------------------

test('dsseVerifyEnvelope: decode → PAE → signatures → type check, returns EXACT bytes', async () => {
  const sig = Buffer.from('signature-bytes');
  const env = {
    payload: encodeBase64(Buffer.from('the exact payload')),
    payloadType: PAYLOAD_TYPE_ORIGIN,
    signatures: [{ keyid: 'SHA256:fake', sig: encodeBase64(sig) }],
  };
  const verifier = strictVerifier(sig);
  const res = await dsseVerifyEnvelope(env, PAYLOAD_TYPE_ORIGIN, verifier);
  assert.equal(res.payloadBytes.toString('utf8'), 'the exact payload');
  assert.equal(res.signers.length, 1);
  // The signer received the PAE over the envelope's exact fields, and the
  // exact decoded signature bytes — never re-encoded or mutated.
  assert.equal(verifier.calls.length, 1);
  assert.equal(verifier.calls[0]!.bytes.toString('utf8'), preAuthEncode(PAYLOAD_TYPE_ORIGIN, Buffer.from('the exact payload')).toString('utf8'));
  assert.ok(verifier.calls[0]!.sig.equals(sig));
});

test('dsseVerifyEnvelope: an empty payload Base64 field is valid when its signature verifies', async () => {
  const sig = Buffer.from('empty-payload-signature');
  const env = {
    payload: '',
    payloadType: PAYLOAD_TYPE_ORIGIN,
    signatures: [{ sig: encodeBase64(sig) }],
  };
  const res = await dsseVerifyEnvelope(env, PAYLOAD_TYPE_ORIGIN, strictVerifier(sig));
  assert.equal(res.payloadBytes.length, 0);
});

test('dsseVerifyEnvelope: payload bytes come back EXACTLY for binary payloads', async () => {
  const sig = Buffer.from('s');
  const payload = Buffer.from([0, 1, 2, 255, 254]); // binary payload
  const env = {
    payload: encodeBase64(payload),
    payloadType: PAYLOAD_TYPE_SUBMISSION,
    signatures: [{ sig: encodeBase64(sig) }],
  };
  const res = await dsseVerifyEnvelope(env, PAYLOAD_TYPE_SUBMISSION, strictVerifier(sig));
  assert.ok(res.payloadBytes.equals(payload), 'binary payload survives the round trip byte-exact');
});

test('dsseVerifyEnvelope: a valid envelope for ANOTHER record class throws (order: type check after crypto)', async () => {
  const sig = Buffer.from('s');
  const env = {
    payload: encodeBase64(Buffer.from('x')),
    payloadType: PAYLOAD_TYPE_REVOCATION,
    signatures: [{ sig: encodeBase64(sig) }],
  };
  await assert.rejects(
    dsseVerifyEnvelope(env, PAYLOAD_TYPE_ENROLLMENT_GRANT, strictVerifier(sig)),
    (e: Error) => {
      assert.ok(e instanceof DsseEnvelopeError);
      assert.match(e.message, /payload type mismatch/);
      assert.match(e.message, /revocation/);
      assert.match(e.message, /enrollment-grant/);
      return true;
    },
  );
});

test('dsseVerifyEnvelope: cryptographic miss is an unambiguous verification failure', async () => {
  const env = {
    payload: encodeBase64(Buffer.from('x')),
    payloadType: PAYLOAD_TYPE_ORIGIN,
    signatures: [{ sig: encodeBase64(Buffer.from('not-expected')) }],
  };
  await assert.rejects(
    dsseVerifyEnvelope(env, PAYLOAD_TYPE_ORIGIN, strictVerifier(Buffer.from('expected'))),
    (e: Error) => {
      assert.ok(e instanceof DsseEnvelopeError);
      assert.match(e.message, /DSSE verification failed/);
      return true;
    },
  );
});

test('dsseVerifyEnvelope: a forged empty-payload envelope cannot look like a verified empty payload', async () => {
  const env = {
    payload: '',
    payloadType: PAYLOAD_TYPE_ORIGIN,
    signatures: [{ sig: encodeBase64(Buffer.from('forged')) }],
  };
  await assert.rejects(
    dsseVerifyEnvelope(env, PAYLOAD_TYPE_ORIGIN, strictVerifier(Buffer.from('real-empty-payload-signature'))),
    /DSSE verification failed/,
  );
});

test('dsseVerifyEnvelope: absent and empty keyid are identical (both unauthenticated hints)', async () => {
  const sig = Buffer.from('s');
  const mk = (keyid?: string) => ({
    payload: encodeBase64(Buffer.from('x')),
    payloadType: PAYLOAD_TYPE_ORIGIN,
    signatures: [keyid === undefined ? { sig: encodeBase64(sig) } : { keyid, sig: encodeBase64(sig) }],
  });
  const absent = await dsseVerifyEnvelope(mk(), PAYLOAD_TYPE_ORIGIN, strictVerifier(sig));
  const empty = await dsseVerifyEnvelope(mk(''), PAYLOAD_TYPE_ORIGIN, strictVerifier(sig));
  assert.equal(absent.signers.length, 1);
  assert.equal(empty.signers.length, 1);
});

test('dsseVerifyEnvelope: unknown fields pass through and do not break verification', async () => {
  const sig = Buffer.from('s');
  const env = {
    payload: encodeBase64(Buffer.from('x')),
    payloadType: PAYLOAD_TYPE_ORIGIN,
    signatures: [{ sig: encodeBase64(sig), keyid: 'k', someFutureField: { nested: true } }],
    extraTopLevel: 'ignored',
  };
  const res = await dsseVerifyEnvelope(env, PAYLOAD_TYPE_ORIGIN, strictVerifier(sig));
  assert.equal(res.signers.length, 1);
});

test('dsseVerifyEnvelope: duplicate signatures from the SAME trusted key count once', async () => {
  const sig = Buffer.from('s');
  const env = {
    payload: encodeBase64(Buffer.from('x')),
    payloadType: PAYLOAD_TYPE_ORIGIN,
    signatures: [
      { keyid: 'SHA256:same', sig: encodeBase64(sig) },
      { keyid: 'SHA256:same', sig: encodeBase64(sig) },
    ],
  };
  await assert.rejects(
    dsseVerifyEnvelope(env, PAYLOAD_TYPE_ORIGIN, strictVerifier(sig), { threshold: 2 }),
    /DSSE verification failed/,
  );
  const ok = await dsseVerifyEnvelope(env, PAYLOAD_TYPE_ORIGIN, strictVerifier(sig), { threshold: 1 });
  assert.equal(ok.signers.length, 1, 'deduped to one verified signer');
});

test('dsseVerifyEnvelope: two DISTINCT keys can meet a threshold of 2', async () => {
  const sigA = Buffer.from('sig-a');
  const sigB = Buffer.from('sig-b');
  let n = 0;
  const twoKeys = {
    async verify(_bytes: Buffer, sig: Buffer): Promise<VerifiedSignature | null> {
      if (sig.equals(sigA)) return { keyid: 'SHA256:a', principal: 'a', format: 'sshsig' };
      if (sig.equals(sigB)) return { keyid: 'SHA256:b', principal: 'b', format: 'sshsig' };
      return null;
    },
  };
  const env = {
    payload: encodeBase64(Buffer.from('x')),
    payloadType: PAYLOAD_TYPE_ORIGIN,
    signatures: [
      { sig: encodeBase64(sigA) },
      { sig: encodeBase64(Buffer.from('junk')) },
      { sig: encodeBase64(sigB) },
    ],
  };
  const res = await dsseVerifyEnvelope(env, PAYLOAD_TYPE_ORIGIN, twoKeys, { threshold: 2 });
  assert.deepEqual(res.signers.map((s) => s.keyid), ['SHA256:a', 'SHA256:b']);
  void n;
});

test('dsseVerifyEnvelope: malformed shapes throw DsseEnvelopeError', async () => {
  const ok = fakeSigner(null);
  const cases: unknown[] = [
    null,
    [],
    'nope',
    { payloadType: PAYLOAD_TYPE_ORIGIN, signatures: [{ sig: 'AAAA' }] }, // missing payload
    { payload: encodeBase64(Buffer.from('x')), signatures: [{ sig: 'AAAA' }] }, // missing type
    { payload: encodeBase64(Buffer.from('x')), payloadType: '', signatures: [{ sig: 'AAAA' }] }, // empty type
    { payload: encodeBase64(Buffer.from('x')), payloadType: PAYLOAD_TYPE_ORIGIN, signatures: [] }, // no sigs
    { payload: '!!!', payloadType: PAYLOAD_TYPE_ORIGIN, signatures: [{ sig: encodeBase64(Buffer.from('s')) }] }, // bad payload b64
    { payload: encodeBase64(Buffer.from('x')), payloadType: PAYLOAD_TYPE_ORIGIN, signatures: [{ sig: '!!' }] }, // bad sig b64
    { payload: encodeBase64(Buffer.from('x')), payloadType: PAYLOAD_TYPE_ORIGIN, signatures: [{}] }, // missing sig field
    { payload: encodeBase64(Buffer.from('x')), payloadType: PAYLOAD_TYPE_ORIGIN, signatures: [null] }, // null signature entry
  ];
  for (const env of cases) {
    await assert.rejects(dsseVerifyEnvelope(env, PAYLOAD_TYPE_ORIGIN, ok), DsseEnvelopeError);
  }
  await assert.rejects(
    dsseVerifyEnvelope(
      { payload: encodeBase64(Buffer.from('x')), payloadType: PAYLOAD_TYPE_ORIGIN, signatures: [{ sig: encodeBase64(Buffer.from('s')) }] },
      PAYLOAD_TYPE_ORIGIN,
      ok,
      { threshold: 0 },
    ),
    /threshold must be an integer >= 1/,
  );
});

// ---- sign ----------------------------------------------------------------------

test('dsseSignEnvelope: signs the PAE of exact payload bytes; envelope carries standard Base64', async () => {
  const payload = Buffer.from('record payload');
  const recorded: Buffer[] = [];
  const signer = {
    async sign(exactBytes: Buffer) {
      recorded.push(exactBytes);
      return { keyid: 'SHA256:signer', sig: Buffer.from('the-armored-sig') };
    },
  };
  const { envelope, signature } = await dsseSignEnvelope(PAYLOAD_TYPE_POLICY_FLOOR, payload, signer);
  assert.equal(envelope.payloadType, PAYLOAD_TYPE_POLICY_FLOOR);
  assert.equal(envelope.payload, encodeBase64(payload));
  assert.equal(envelope.signatures.length, 1);
  assert.equal(envelope.signatures[0]!.keyid, 'SHA256:signer');
  assert.equal(envelope.signatures[0]!.sig, encodeBase64(Buffer.from('the-armored-sig')));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.toString('utf8'), preAuthEncode(PAYLOAD_TYPE_POLICY_FLOOR, payload).toString('utf8'));
  assert.equal(signature.keyid, 'SHA256:signer');
});

test('dsseSignEnvelope: empty keyid is omitted from the envelope', async () => {
  const { envelope } = await dsseSignEnvelope(PAYLOAD_TYPE_ORIGIN, Buffer.from('x'), {
    async sign() {
      return { keyid: '', sig: Buffer.from('s') };
    },
  });
  assert.ok(!('keyid' in envelope.signatures[0]!), 'no keyid field when the signer has none');
});

// ---- record wrappers ------------------------------------------------------------

test('record wrappers pin the payload type: sign under one class, verify as another throws', async () => {
  const sig = Buffer.from('s');
  const signer = {
    async sign() {
      return { keyid: 'SHA256:k', sig };
    },
    async verify(_b: Buffer, s: Buffer) {
      return s.equals(sig) ? { keyid: 'SHA256:k', principal: 'p', format: 'sshsig' as const } : null;
    },
  };
  const { envelope } = await dsseSignRecord(PAYLOAD_TYPE_SUBMISSION, Buffer.from('submission'), signer);
  const res = await dsseVerifyRecord(envelope, PAYLOAD_TYPE_SUBMISSION, signer);
  assert.equal(res.payloadBytes.toString('utf8'), 'submission');
  await assert.rejects(dsseVerifyRecord(envelope, PAYLOAD_TYPE_POLICY_FLOOR, signer), /payload type mismatch/);
});

test('explicit record-class wrappers bind all five fixed payload types', async () => {
  const signer = {
    async sign() {
      return { keyid: 'SHA256:k', sig: Buffer.from('s') };
    },
    async verify(_bytes: Buffer, _sig: Buffer) {
      return { keyid: 'SHA256:k', principal: 'p', format: 'sshsig' as const };
    },
  };
  const cases = [
    [dsseSignEnrollmentGrant, dsseVerifyEnrollmentGrant, PAYLOAD_TYPE_ENROLLMENT_GRANT],
    [dsseSignRevocation, dsseVerifyRevocation, PAYLOAD_TYPE_REVOCATION],
    [dsseSignSubmission, dsseVerifySubmission, PAYLOAD_TYPE_SUBMISSION],
    [dsseSignPolicyFloor, dsseVerifyPolicyFloor, PAYLOAD_TYPE_POLICY_FLOOR],
    [dsseSignOrigin, dsseVerifyOrigin, PAYLOAD_TYPE_ORIGIN],
  ] as const;
  for (const [sign, verify, expected] of cases) {
    const { envelope } = await sign(Buffer.from(expected), signer);
    assert.equal(envelope.payloadType, expected);
    const result = await verify(envelope, signer);
    assert.deepEqual(result.payloadBytes, Buffer.from(expected));
  }
});
