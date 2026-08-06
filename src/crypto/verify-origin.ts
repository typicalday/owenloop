/**
 * Origin-sidecar verification for workflow definitions.
 *
 * An origin sidecar is optional, so absence is distinct from an unsigned
 * publication. A present sidecar is either a verified signed statement or a
 * hard failure: the hub or another relay cannot turn an unrecognized origin
 * shape into a successful result.
 */

import { keyidFromBlob } from './keys.ts';
import {
  decodeBase64Strict,
  DSSE_SSH_NAMESPACE,
  dsseVerifyOrigin,
  DsseEnvelopeError,
} from './dsse.ts';
import { parseAllowedSigners } from './allowed-signers.ts';
import { createSshSigner, SshSignerError } from './ssh.ts';
import type { Signer } from './ssh.ts';
import type { OriginRecord, OriginSource } from './records.ts';
import { originSchema } from '../schemas/index.ts';
import { validateValue, summarizeIssues } from '../schema.ts';

export type OriginVerdict =
  | { kind: 'verified'; source: OriginSource; attesterKeyId: string; principal: string }
  | { kind: 'absent' }
  | { kind: 'unverifiable'; reason: string }
  | { kind: 'invalid'; reason: string };

export interface VerifyOriginInput {
  /** Digest computed by bundle ingestion for the bytes being installed. */
  bundleDigest: string;
  /** The raw `.origin.dsse` sidecar bytes. Omit when no origin is supplied. */
  dsseBytes?: Uint8Array;
  /** Resolved local allowed_signers text. */
  allowedSignersText?: string;
}

export interface VerifyOriginOptions {
  /** Test seam and future signer seam for candidate-principal verification. */
  signerForPrincipal?: (args: {
    principal: string;
    allowedSignersText: string;
  }) => Pick<Signer, 'verify'> & { dispose?: () => void };
  namespace?: string;
}

function invalid(reason: string): OriginVerdict {
  return { kind: 'invalid', reason };
}

function unverifiable(reason: string): OriginVerdict {
  return { kind: 'unverifiable', reason };
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode only what candidate selection needs. The record is still
 * unauthenticated here; the complete schema check happens after DSSE
 * verification, so an untrusted source branch cannot authorize a signer.
 */
function decodeOriginRecord(
  envelope: unknown,
): { record: Record<string, unknown>; payloadBytes: Buffer } | OriginVerdict {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    return invalid('origin sidecar is not a JSON object');
  }
  const payload = (envelope as Record<string, unknown>)['payload'];
  if (typeof payload !== 'string') return invalid("origin sidecar is missing a string 'payload'");

  let payloadBytes: Buffer;
  try {
    payloadBytes = decodeBase64Strict(payload, { allowEmpty: true });
  } catch (error) {
    return invalid(`origin payload is not valid Base64: ${(error as Error).message}`);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadBytes.toString('utf8')) as unknown;
  } catch {
    return invalid('origin payload is not valid JSON');
  }
  if (!asRecord(decoded)) return invalid('origin payload is not a JSON object');
  if (typeof decoded.attesterKeyId !== 'string') {
    return invalid("origin record is missing a string 'attesterKeyId'");
  }
  return { record: decoded, payloadBytes };
}

/**
 * Verify one origin sidecar using the record's attester key-id only as a
 * candidate-selection hint. The verified signer descriptor remains the
 * authority, and the digest is checked against the bundle after verification.
 */
export async function verifyOrigin(
  input: VerifyOriginInput,
  options: VerifyOriginOptions = {},
): Promise<OriginVerdict> {
  if (input.dsseBytes === undefined) return { kind: 'absent' };
  if (input.allowedSignersText === undefined) {
    return unverifiable('no allowed_signers trust root was resolved');
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(input.dsseBytes).toString('utf8')) as unknown;
  } catch {
    return invalid('origin sidecar is not valid JSON');
  }

  const decoded = decodeOriginRecord(envelope);
  if ('kind' in decoded) return decoded;
  const { record } = decoded;
  const attesterKeyId = record.attesterKeyId as string;

  const parsed = parseAllowedSigners(input.allowedSignersText);
  if (parsed.errors.length > 0) {
    return unverifiable(
      `allowed_signers policy is malformed: ${parsed.errors.map((error) => `line ${error.line}: ${error.message}`).join('; ')}`,
    );
  }
  if (parsed.entries.length === 0) return unverifiable('allowed_signers policy has no signer entries');

  const candidates = parsed.entries.filter((entry) => keyidFromBlob(entry.keyBlob) === attesterKeyId);
  if (candidates.length === 0) {
    return invalid(`origin signer key '${attesterKeyId}' is not present in allowed_signers`);
  }

  const makeSigner = options.signerForPrincipal ?? ((args: {
    principal: string;
    allowedSignersText: string;
  }) => createSshSigner({
    namespace: options.namespace ?? DSSE_SSH_NAMESPACE,
    verify: args,
  }));

  let sawCryptographicMiss = false;
  for (const candidate of candidates) {
    for (const principal of candidate.principals) {
      let signer: Pick<Signer, 'verify'> & { dispose?: () => void };
      try {
        signer = makeSigner({ principal, allowedSignersText: input.allowedSignersText });
      } catch (error) {
        if (error instanceof SshSignerError) return unverifiable(error.message);
        return unverifiable(`origin verification setup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const result = await dsseVerifyOrigin(envelope, signer, { threshold: 1 });
        const verified = result.signers[0];
        if (verified === undefined) return invalid('origin signature produced no verified signer');

        const shape = validateValue(originSchema, record);
        if (!shape.valid) {
          return invalid(`origin record does not match schema: ${summarizeIssues(shape.issues)}`);
        }
        const originRecord = record as unknown as OriginRecord;

        if (verified.keyid !== originRecord.attesterKeyId) {
          return invalid(
            `origin signer key '${verified.keyid}' does not match record attesterKeyId '${originRecord.attesterKeyId}'`,
          );
        }
        if (originRecord.digest !== input.bundleDigest) {
          return invalid(
            `origin digest '${originRecord.digest}' does not match bundle digest '${input.bundleDigest}'`,
          );
        }
        return {
          kind: 'verified',
          source: originRecord.source,
          attesterKeyId: verified.keyid,
          principal: verified.principal,
        };
      } catch (error) {
        if (error instanceof SshSignerError) return unverifiable(error.message);
        if (error instanceof DsseEnvelopeError) {
          if (error.message.startsWith('DSSE verification failed:')) {
            sawCryptographicMiss = true;
            continue;
          }
          return invalid(`origin verification failed: ${error.message}`);
        }
        return invalid(`origin verification failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        signer.dispose?.();
      }
    }
  }

  if (sawCryptographicMiss) return invalid('origin signature could not be verified by an allowed signer');
  return invalid('origin signature did not verify');
}

/** Alias naming the sidecar explicitly for callers at filesystem boundaries. */
export const verifyOriginSidecar = verifyOrigin;
