/**
 * DSSE (Dead Simple Signing Envelope) — cryptographic framing for owenloop's
 * signed records.
 *
 * Implements the DSSEv1 protocol (https://github.com/secure-systems-lab/dsse):
 * a `{ payloadType, payload, signatures }` envelope where each signature covers
 * the Pre-Authentication Encoding (PAE) of payload type + payload bytes. PAE
 * binds the payload type INTO the signed data, so a payload signed under one
 * record class can never verify as another — the record-class wrappers below
 * enforce that on top of the generic verify.
 *
 * Scope is deliberately cryptographic framing ONLY: payloads are opaque bytes
 * here — this module never parses or re-serializes them, and owns none of the
 * grant/revocation/submission/policy-floor/origin JSON schemas (that is the
 * WP-A1/WP-A3/WP-B1 surface). Signing and verification run through the
 * `Signer` interface, so the envelope code is format-neutral: today the SSH
 * signer implements it; a future Sigstore signer can implement the same
 * contract without touching this file.
 *
 * Base64 discipline: `payload`/`sig` fields are STANDARD RFC 4648 on the wire
 * (what `dsseSignEnvelope` emits), but verification accepts standard OR
 * URL-safe input (the protocol requires accepting both). Decoding is STRICT —
 * Node's `Buffer.from(.., 'base64')` is permissive (it drops unknown
 * characters and ignores bad padding), so `decodeBase64` validates the
 * alphabet and padding explicitly and rejects malformed encodings rather than
 * silently truncating them into a different payload.
 *
 * `keyid` discipline: `keyid` is optional and UNAUTHENTICATED in DSSE. This
 * module treats it as a candidate-selection hint only — never as identity or
 * authorization. Absent and empty-string `keyid` are treated identically.
 */

import type { DetachedSignature, Signer, VerifiedSignature } from './ssh.ts';

/**
 * The DSSE protocol version string and PAE prefix. PAE is defined as
 * `"DSSEv1" SP len(payloadType) SP payloadType SP len(payload) SP payload`
 * with ASCII-decimal lengths (no leading zeroes) over the UTF-8 byte length of
 * the type and the raw byte length of the payload.
 */
export const DSSE_VERSION = 'DSSEv1';

/** One signature entry inside a DSSE envelope. `keyid` is optional and unauthenticated. */
export interface DsseSignature {
  /** Optional candidate-selection hint. NEVER trusted as identity. */
  keyid?: string;
  /** Base64 (standard or URL-safe) of the signature bytes. */
  sig: string;
  /** Unknown fields are tolerated by the decoder. */
  [field: string]: unknown;
}

/**
 * A DSSE envelope as it travels on the wire. `payload` and `sig` fields are
 * Base64 text; everything else the decoder needs is typed here, and unknown
 * fields pass through untouched.
 */
export interface DsseEnvelope {
  /** Base64 (standard or URL-safe) of the raw payload bytes. */
  payload: string;
  /** The payload's media type, e.g. `application/vnd.owenloop.origin.v1+json`. */
  payloadType: string;
  /** One or more signatures (verification threshold configurable). */
  signatures: DsseSignature[];
  /** Unknown fields are tolerated by the decoder. */
  [field: string]: unknown;
}

/**
 * A malformed envelope — wrong shape, bad Base64, missing required fields.
 * Distinct from a CRYPTOGRAPHIC miss (wrong key / tampered bytes), which is
 * reported as `signatures: []` with `ok: false`.
 */
export class DsseEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DsseEnvelopeError';
  }
}

/**
 * The five launch signed-record payload types. These strings are signed wire
 * identifiers — versioned, stable, and consumed by later trust work, so a
 * change here is a new `v2` constant, never an edit.
 */
export const PAYLOAD_TYPE_ENROLLMENT_GRANT = 'application/vnd.owenloop.enrollment-grant.v1+json';
export const PAYLOAD_TYPE_REVOCATION = 'application/vnd.owenloop.revocation.v1+json';
export const PAYLOAD_TYPE_SUBMISSION = 'application/vnd.owenloop.submission.v1+json';
export const PAYLOAD_TYPE_POLICY_FLOOR = 'application/vnd.owenloop.policy-floor.v1+json';
export const PAYLOAD_TYPE_ORIGIN = 'application/vnd.owenloop.origin.v1+json';

/** The DSSE SSHSIG namespace used for all owenloop DSSE envelopes. */
export const DSSE_SSH_NAMESPACE = 'owenloop-dsse-v1';

/**
 * The Pre-Authentication Encoding of one (payloadType, payload) pair:
 * `DSSEv1 SP len(typeBytes) SP typeBytes SP len(payloadBytes) SP payloadBytes`.
 * Lengths are ASCII decimal (no leading zeroes) byte counts; the payload type
 * is measured in UTF-8 bytes. The result is the exact byte string every DSSE
 * signature covers.
 */
export function preAuthEncode(payloadType: string, payload: Buffer): Buffer {
  const typeBytes = Buffer.from(payloadType, 'utf8');
  const head = `${DSSE_VERSION} ${typeBytes.length} `;
  const mid = Buffer.concat([Buffer.from(head, 'utf8'), typeBytes]);
  return Buffer.concat([mid, Buffer.from(` ${payload.length} `, 'utf8'), payload]);
}

/** The strict Base64 alphabet check shared by both alphabets. */
function base64CharsOk(s: string, alphabet: RegExp): boolean {
  return s.length > 0 && alphabet.test(s);
}

/**
 * Decode a STRICT Base64 string (standard `+/` or URL-safe `-_` alphabet,
 * optional `=` padding). Throws `DsseEnvelopeError` on any malformed input:
 * out-of-alphabet characters, wrong length modulo 4, or a trailing single
 * padding character (three encoded characters never encode a whole byte
 * count). Node's permissive decoder is never used on untrusted wire input —
 * it would silently drop illegal characters and accept missing padding,
 * decoding two different strings to the same bytes.
 */
export function decodeBase64Strict(s: string): Buffer {
  if (typeof s !== 'string') throw new DsseEnvelopeError('base64 field is not a string');
  const cleaned = s.replace(/[\r\n\t ]/g, '');
  const std = /^[A-Za-z0-9+/]*$/;
  const url = /^[A-Za-z0-9_-]*$/;
  const body = cleaned.replace(/=+$/, '');
  const hadPadding = cleaned.length > body.length;
  if (cleaned.length === 0) throw new DsseEnvelopeError('base64 field is empty');
  if (hadPadding) {
    // With explicit padding the total must be a multiple of 4 and the padding
    // at most two characters.
    if (cleaned.length % 4 !== 0 || cleaned.length - body.length > 2) {
      throw new DsseEnvelopeError('malformed base64: bad padding');
    }
    if (!base64CharsOk(body, std) && !base64CharsOk(body, url)) {
      throw new DsseEnvelopeError('malformed base64: character outside both alphabets');
    }
  } else {
    if (!base64CharsOk(cleaned, std) && !base64CharsOk(cleaned, url)) {
      throw new DsseEnvelopeError('malformed base64: character outside both alphabets');
    }
    const rem = cleaned.length % 4;
    if (rem === 1) throw new DsseEnvelopeError('malformed base64: length % 4 == 1');
  }
  // Re-encode through the standard alphabet for the decoder (URL-safe chars
  // mapped to standard; padding restored).
  const standard = body.replace(/-/g, '+').replace(/_/g, '/');
  const pad = standard.length % 4 === 0 ? '' : '='.repeat(4 - (standard.length % 4));
  return Buffer.from(standard + pad, 'base64');
}

/** Encode bytes as STANDARD (RFC 4648 §4) Base64 with padding. */
export function encodeBase64(b: Buffer): string {
  return b.toString('base64');
}

/** Result of a DSSE verification. */
export interface DsseVerifyResult {
  /** The EXACT verified payload bytes — never re-parsed or re-serialized. */
  payloadBytes: Buffer;
  /** Descriptors of every signature that verified (deduplicated by the signer). */
  signers: VerifiedSignature[];
}

/**
 * Verify one signature entry's bytes against the signer. Returns the verified
 * descriptor or `null`. Malformed Base64 in `sig` is a hard envelope error
 * (the envelope itself is broken), not a miss.
 */
function decodeSigEntry(entry: DsseSignature, index: number): Buffer {
  if (typeof entry.sig !== 'string' || entry.sig === '') {
    throw new DsseEnvelopeError(`signatures[${index}]: missing 'sig' field`);
  }
  try {
    return decodeBase64Strict(entry.sig);
  } catch (e) {
    throw new DsseEnvelopeError(`signatures[${index}]: ${(e as Error).message}`);
  }
}

/**
 * Verify a DSSE envelope with a format-neutral `Signer`.
 *
 * Verification order (fixed):
 *   1. Decode — the envelope object shape, payload Base64, and each `sig`.
 *   2. Reconstruct the PAE from the envelope's EXACT payload type and payload
 *      bytes.
 *   3. Verify signatures through the signer; require at least `threshold`
 *      DISTINCT verified signers (the signer deduplicates: a trusted key
 *      counts once even when duplicate signature entries validate).
 *   4. Require `payloadType === expectedPayloadType` — a valid envelope for
 *      another record class is rejected here.
 *
 * Returns the exact verified payload bytes plus the verified signer
 * descriptors. Throws `DsseEnvelopeError` on malformed input; a payload-type
 * mismatch after cryptographic success is also a `DsseEnvelopeError` (the
 * envelope cannot be consumed as this record class). `keyid` plays no role in
 * authorization.
 */
export async function dsseVerifyEnvelope(
  envelope: unknown,
  expectedPayloadType: string,
  signer: Pick<Signer, 'verify'>,
  opts?: { threshold?: number },
): Promise<DsseVerifyResult> {
  const threshold = opts?.threshold ?? 1;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new DsseEnvelopeError('threshold must be an integer >= 1');
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new DsseEnvelopeError('envelope is not an object');
  }
  const env = envelope as DsseEnvelope;
  if (typeof env.payload !== 'string') throw new DsseEnvelopeError("missing 'payload' field");
  if (typeof env.payloadType !== 'string' || env.payloadType === '') {
    throw new DsseEnvelopeError("missing 'payloadType' field");
  }
  if (!Array.isArray(env.signatures) || env.signatures.length === 0) {
    throw new DsseEnvelopeError('envelope must carry at least one signature');
  }
  const payloadBytes = (() => {
    try {
      return decodeBase64Strict(env.payload);
    } catch (e) {
      throw new DsseEnvelopeError(`payload: ${(e as Error).message}`);
    }
  })();
  const pae = preAuthEncode(env.payloadType, payloadBytes);
  const sigBytes = env.signatures.map((entry, i) => decodeSigEntry(entry as DsseSignature, i));

  const verified: VerifiedSignature[] = [];
  const seen = new Set<string>();
  for (const sig of sigBytes) {
    const res = await signer.verify(pae, sig);
    if (res === null) continue;
    // A trusted key counts at most once, even when duplicate entries validate.
    if (seen.has(res.keyid)) continue;
    seen.add(res.keyid);
    verified.push(res);
  }
  if (verified.length < threshold) {
    return { payloadBytes: Buffer.alloc(0), signers: [] };
  }
  if (env.payloadType !== expectedPayloadType) {
    throw new DsseEnvelopeError(
      `payload type mismatch: envelope carries '${env.payloadType}', caller expects '${expectedPayloadType}'`,
    );
  }
  return { payloadBytes, signers: verified };
}

/**
 * Sign exact payload bytes into a DSSE envelope using `signer`. The payload is
 * authenticated as EXACT bytes — callers own serialization. Returns the
 * envelope (standard Base64 payload/sig) alongside the signer's detached
 * signature. Never parses `payloadBytes`.
 */
export async function dsseSignEnvelope(
  payloadType: string,
  payloadBytes: Buffer,
  signer: Pick<Signer, 'sign'>,
): Promise<{ envelope: DsseEnvelope; signature: DetachedSignature }> {
  const pae = preAuthEncode(payloadType, payloadBytes);
  const signature = await signer.sign(pae);
  const envelope: DsseEnvelope = {
    payload: encodeBase64(payloadBytes),
    payloadType,
    signatures: [
      {
        ...(signature.keyid !== '' ? { keyid: signature.keyid } : {}),
        sig: encodeBase64(signature.sig),
      },
    ],
  };
  return { envelope, signature };
}

/**
 * A record-class wrapper: sign `payloadBytes` under one fixed payload type.
 * Thin by design — the wrappers exist so call sites name the record class and
 * cannot drift onto the wrong type string.
 */
export async function dsseSignRecord(
  payloadType: string,
  payloadBytes: Buffer,
  signer: Pick<Signer, 'sign'>,
): Promise<{ envelope: DsseEnvelope; signature: DetachedSignature }> {
  return dsseSignEnvelope(payloadType, payloadBytes, signer);
}

/**
 * A record-class wrapper: verify `envelope` as EXACTLY one record class.
 * Rejects (throws) when the envelope's payload type is any other class, so a
 * valid envelope can never be consumed as a different record type. Returns the
 * exact verified payload bytes — parsing them into a business record is the
 * caller's job, not this module's.
 */
export async function dsseVerifyRecord(
  envelope: unknown,
  expectedPayloadType: string,
  signer: Pick<Signer, 'verify'>,
  opts?: { threshold?: number },
): Promise<DsseVerifyResult> {
  return dsseVerifyEnvelope(envelope, expectedPayloadType, signer, opts);
}
