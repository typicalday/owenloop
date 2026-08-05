/**
 * Publication-sidecar verification for workflow definitions.
 *
 * This module returns four deliberately distinct states. `unsigned` means no
 * publication sidecar was supplied. `unverifiable` means the local trust
 * machinery cannot perform verification. `invalid` means a sidecar was present
 * but the signed statement or its binding to the bundle failed. Only
 * `verified` is a successful signature decision.
 */

import { keyidFromBlob } from './keys.ts';
import {
  decodeBase64Strict,
  DSSE_SSH_NAMESPACE,
  dsseVerifyPublication,
  DsseEnvelopeError,
} from './dsse.ts';
import { parseAllowedSigners } from './allowed-signers.ts';
import { createSshSigner, SshSignerError } from './ssh.ts';
import type { Signer } from './ssh.ts';
import type { PublicationRecord } from './records.ts';
import { publicationSchema } from '../schemas/index.ts';
import { validateValue, summarizeIssues } from '../schema.ts';

/** The local driver policy vocabulary. */
export type DefPolicy = 'enforce' | 'warn' | 'off';

export function isDefPolicy(value: unknown): value is DefPolicy {
  return value === 'enforce' || value === 'warn' || value === 'off';
}

export type DefVerdict =
  | { kind: 'verified'; publisherKeyId: string; principal: string }
  | { kind: 'unsigned' }
  | { kind: 'unverifiable'; reason: string }
  | { kind: 'invalid'; reason: string };

export interface VerifyPublicationInput {
  /** Digest computed by bundle ingestion for the bytes being installed. */
  bundleDigest: string;
  /** The raw `.dsse` sidecar bytes. Omit for an unsigned bundle. */
  dsseBytes?: Uint8Array;
  /** Resolved local allowed_signers text. */
  allowedSignersText?: string;
}

export interface VerifyPublicationOptions {
  /**
   * Test seam and future signer seam. The default constructs an SSHSIG signer
   * for the candidate principal and keeps OpenSSH as the authorization
   * authority.
   */
  signerForPrincipal?: (args: {
    principal: string;
    allowedSignersText: string;
  }) => Pick<Signer, 'verify'> & { dispose?: () => void };
  namespace?: string;
}

function invalid(reason: string): DefVerdict {
  return { kind: 'invalid', reason };
}

function unverifiable(reason: string): DefVerdict {
  return { kind: 'unverifiable', reason };
}

function asRecord(value: unknown): value is PublicationRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decode the untrusted publication payload for candidate selection and checks. */
function decodePublicationRecord(envelope: unknown): { record: PublicationRecord; payloadBytes: Buffer } | DefVerdict {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    return invalid('publication sidecar is not a JSON object');
  }
  const payload = (envelope as Record<string, unknown>)['payload'];
  if (typeof payload !== 'string') return invalid("publication sidecar is missing a string 'payload'");
  let payloadBytes: Buffer;
  try {
    payloadBytes = decodeBase64Strict(payload, { allowEmpty: true });
  } catch (error) {
    return invalid(`publication payload is not valid Base64: ${(error as Error).message}`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadBytes.toString('utf8')) as unknown;
  } catch {
    return invalid('publication payload is not valid JSON');
  }
  if (!asRecord(decoded)) return invalid('publication payload is not a JSON object');
  const shape = validateValue(publicationSchema, decoded);
  if (!shape.valid) return invalid(`publication record does not match schema: ${summarizeIssues(shape.issues)}`);
  return { record: decoded, payloadBytes };
}

/**
 * Verify one publication sidecar using the key-id index principal resolution
 * strategy. The record's publisherKeyId selects the allowed_signers key, then
 * each principal attached to that key is tried until OpenSSH accepts one.
 *
 * The key-id lookup is only a candidate-selection optimization: the returned
 * signer descriptor is still checked against the signed record after DSSE
 * verification. The record's unauthenticated contents never authorize a key.
 */
export async function verifyPublication(
  input: VerifyPublicationInput,
  options: VerifyPublicationOptions = {},
): Promise<DefVerdict> {
  if (input.dsseBytes === undefined) return { kind: 'unsigned' };
  if (input.allowedSignersText === undefined) {
    return unverifiable('no allowed_signers trust root was resolved');
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(input.dsseBytes).toString('utf8')) as unknown;
  } catch {
    return invalid('publication sidecar is not valid JSON');
  }

  const decoded = decodePublicationRecord(envelope);
  if ('kind' in decoded) return decoded;
  const { record } = decoded;

  const parsed = parseAllowedSigners(input.allowedSignersText);
  if (parsed.errors.length > 0) {
    return unverifiable(
      `allowed_signers policy is malformed: ${parsed.errors.map((error) => `line ${error.line}: ${error.message}`).join('; ')}`,
    );
  }
  if (parsed.entries.length === 0) return unverifiable('allowed_signers policy has no signer entries');

  // Option (b): publisherKeyId and allowed_signers key fingerprints share the
  // keyidFromBlob SHA256:<unpadded-base64> convention. This keeps verification
  // to one OpenSSH attempt for the normal one-principal case.
  const candidates = parsed.entries.filter((entry) => keyidFromBlob(entry.keyBlob) === record.publisherKeyId);
  if (candidates.length === 0) {
    return invalid(`publication signer key '${record.publisherKeyId}' is not present in allowed_signers`);
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
        return unverifiable(`publication verification setup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const result = await dsseVerifyPublication(envelope, signer, { threshold: 1 });
        const verified = result.signers[0];
        if (verified === undefined) return invalid('publication signature produced no verified signer');
        if (verified.keyid !== record.publisherKeyId) {
          return invalid(
            `publication signer key '${verified.keyid}' does not match record publisherKeyId '${record.publisherKeyId}'`,
          );
        }
        if (record.digest !== input.bundleDigest) {
          return invalid(
            `publication digest '${record.digest}' does not match bundle digest '${input.bundleDigest}'`,
          );
        }
        return { kind: 'verified', publisherKeyId: verified.keyid, principal: verified.principal };
      } catch (error) {
        if (error instanceof SshSignerError) return unverifiable(error.message);
        if (error instanceof DsseEnvelopeError) {
          // A malformed envelope is an invalid present signature. Only the
          // explicit threshold miss is the cryptographic-miss form that can be
          // retried with another principal attached to the same key.
          if (error.message.startsWith('DSSE verification failed:')) {
            sawCryptographicMiss = true;
            continue;
          }
          return invalid(`publication verification failed: ${error.message}`);
        }
        return invalid(`publication verification failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        signer.dispose?.();
      }
    }
  }

  if (sawCryptographicMiss) return invalid('publication signature could not be verified by an allowed signer');
  return invalid('publication signature did not verify');
}

/** Alias naming the sidecar explicitly for callers at filesystem boundaries. */
export const verifyPublicationSidecar = verifyPublication;
