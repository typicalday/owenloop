/**
 * Enrollment-grant construction and client-side roster verification.
 *
 * D1 deliberately stops at a narrow chain-validation seam. A signed grant is
 * unforgeable by a hub that only relays records, but a signature alone does not
 * prove that the grantor is enrolled in the organization. Until a
 * `EnrollmentChainValidator` is installed, verification therefore refuses with
 * `unverifiable` rather than accepting the record. The explicit early return in
 * `verifyRosterEntry` is the §8.1 fail-closed gate.
 */

import { keyidFromBlob } from './keys.ts';
import {
  decodeBase64Strict,
  DSSE_SSH_NAMESPACE,
  dsseVerifyEnrollmentGrant,
  DsseEnvelopeError,
} from './dsse.ts';
import { parseAllowedSigners } from './allowed-signers.ts';
import { createSshSigner, SshSignerError } from './ssh.ts';
import type { Signer } from './ssh.ts';
import type {
  EnrollmentGrantRecord,
  GrantScope,
  PrincipalReference,
} from './records.ts';
import type { PublicKeyDescriptor } from './keys.ts';
import { enrollmentGrantSchema } from '../schemas/index.ts';
import { validateValue, summarizeIssues } from '../schema.ts';

/** The narrow D1/D4 boundary for proving that one grant reaches the org root. */
export interface EnrollmentChainValidator {
  /** Resolve whether `grant` chains to the org root. */
  validate(
    grant: EnrollmentGrantRecord,
    verifiedSignerKeyId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** The least privilege scope carried by a self-vouched machine grant. */
export const DEFAULT_MACHINE_SCOPE: GrantScope = Object.freeze({
  pools: '*',
  labels: '*',
  namespaces: Object.freeze([]) as unknown as string[],
  delegation: Object.freeze({ allowed: false }),
}) as GrantScope;

/** Inputs for the pure enrollment-grant builder. */
export interface BuildEnrollmentGrantArgs {
  newKey: PublicKeyDescriptor;
  principal: PrincipalReference;
  grantedBy: string;
  validFrom: number;
  scope: GrantScope;
}

/** Build one complete, immutable enrollment grant without performing I/O. */
export function buildEnrollmentGrant(args: BuildEnrollmentGrantArgs): EnrollmentGrantRecord {
  const scope = Object.freeze({
    pools: Array.isArray(args.scope.pools) ? Object.freeze([...args.scope.pools]) : args.scope.pools,
    labels: Array.isArray(args.scope.labels) ? Object.freeze([...args.scope.labels]) : args.scope.labels,
    namespaces: Array.isArray(args.scope.namespaces) ? Object.freeze([...args.scope.namespaces]) : args.scope.namespaces,
    delegation: args.scope.delegation.allowed
      ? Object.freeze({ allowed: true as const, maxDepth: args.scope.delegation.maxDepth })
      : Object.freeze({ allowed: false as const }),
  }) as unknown as GrantScope;

  const newKey = Object.freeze({
    keyid: args.newKey.keyid,
    keyType: args.newKey.keyType,
    openSshPublicKey: args.newKey.openSshPublicKey,
    ...(args.newKey.comment !== undefined ? { comment: args.newKey.comment } : {}),
  });
  const principal = Object.freeze({ kind: args.principal.kind, id: args.principal.id });

  return Object.freeze({
    newKey,
    principal,
    scope,
    grantedBy: args.grantedBy,
    validFrom: args.validFrom,
  }) as EnrollmentGrantRecord;
}

/** The four states a client can distinguish when reading a relayed roster. */
export type RosterVerdict =
  | { kind: 'enrolled'; keyid: string; principal: string }
  | { kind: 'unenrolled' }
  | { kind: 'unverifiable'; reason: string }
  | { kind: 'invalid'; reason: string };

/** One relayed DSSE envelope plus the local allowed_signers text. */
export interface VerifyRosterEntryInput {
  /** A decoded DSSE envelope, or JSON/UTF-8 bytes carrying one. */
  envelope?: unknown;
  /** Alias for callers that already have a sidecar-like byte buffer. */
  dsseBytes?: Uint8Array;
  /** Resolved local `allowed_signers` text. */
  allowedSignersText?: string;
}

/** Test and signer-tool seams for roster verification. */
export interface VerifyRosterEntryOptions {
  /** D4's chain-validation seam. Omission is deliberately fail-closed. */
  chainValidator?: EnrollmentChainValidator;
  /** Inject a signer for hermetic verification tests. */
  signerForPrincipal?: (args: {
    principal: string;
    allowedSignersText: string;
  }) => Pick<Signer, 'verify'> & { dispose?: () => void };
  /** SSHSIG namespace override for a caller with a different record domain. */
  namespace?: string;
}

interface DecodedEnrollment {
  envelope: unknown;
  record: EnrollmentGrantRecord;
}

function invalid(reason: string): RosterVerdict {
  return { kind: 'invalid', reason };
}

function unverifiable(reason: string): RosterVerdict {
  return { kind: 'unverifiable', reason };
}

function asJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode only the unauthenticated payload needed for candidate selection. The
 * record is still checked again by the DSSE verifier and by the signer-key
 * cross-check below; no field decoded here authorizes a key.
 */
function decodeEnrollment(input: VerifyRosterEntryInput): DecodedEnrollment | RosterVerdict {
  const raw = input.envelope !== undefined ? input.envelope : input.dsseBytes;
  if (raw === undefined) return { kind: 'unenrolled' };

  let envelope: unknown = raw;
  if (typeof raw === 'string' || raw instanceof Uint8Array) {
    try {
      envelope = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
    } catch {
      return invalid('enrollment envelope is not valid JSON');
    }
  }
  if (!asJsonObject(envelope)) return invalid('enrollment envelope is not a JSON object');

  const payload = envelope.payload;
  if (typeof payload !== 'string') return invalid("enrollment envelope is missing a string 'payload'");

  let payloadBytes: Buffer;
  try {
    payloadBytes = decodeBase64Strict(payload, { allowEmpty: true });
  } catch (error) {
    return invalid(`enrollment payload is not valid Base64: ${(error as Error).message}`);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadBytes.toString('utf8')) as unknown;
  } catch {
    return invalid('enrollment payload is not valid JSON');
  }
  if (!asJsonObject(decoded)) return invalid('enrollment payload is not a JSON object');

  const shape = validateValue(enrollmentGrantSchema, decoded);
  if (!shape.valid) {
    return invalid(`enrollment grant does not match schema: ${summarizeIssues(shape.issues)}`);
  }
  return { envelope, record: decoded as unknown as EnrollmentGrantRecord };
}

/**
 * Verify one relayed enrollment record. The operation is ordered so malformed
 * input, missing trust roots, signer authorization, and missing chain support
 * remain distinct verdicts instead of collapsing into a boolean.
 */
export async function verifyRosterEntry(
  input: VerifyRosterEntryInput,
  options: VerifyRosterEntryOptions = {},
): Promise<RosterVerdict> {
  const decoded = decodeEnrollment(input);
  if ('kind' in decoded) return decoded;
  const { envelope, record } = decoded;

  if (input.allowedSignersText === undefined) {
    return unverifiable('no allowed_signers trust root was resolved');
  }

  const parsed = parseAllowedSigners(input.allowedSignersText);
  if (parsed.errors.length > 0) {
    return unverifiable(
      `allowed_signers policy is malformed: ${parsed.errors.map((error) => `line ${error.line}: ${error.message}`).join('; ')}`,
    );
  }
  if (parsed.entries.length === 0) return unverifiable('allowed_signers policy has no signer entries');

  const candidates = parsed.entries.filter((entry) => keyidFromBlob(entry.keyBlob) === record.grantedBy);
  if (candidates.length === 0) {
    return invalid(`enrollment grantor key '${record.grantedBy}' is not present in allowed_signers`);
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
        return unverifiable(`enrollment verification setup failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        const result = await dsseVerifyEnrollmentGrant(envelope, signer, { threshold: 1 });
        const verified = result.signers[0];
        if (verified === undefined) return invalid('enrollment signature produced no verified signer');
        if (verified.keyid !== record.grantedBy) {
          return invalid(
            `enrollment signer key '${verified.keyid}' does not match record grantedBy '${record.grantedBy}'`,
          );
        }

        // §8.1: a signature proves who signed, not that the signer is enrolled.
        // Refuse until WP-D4 installs the chain validator; never fail open.
        if (options.chainValidator === undefined) {
          return unverifiable('no enrollment chain validator is installed');
        }

        let chain: { ok: true } | { ok: false; reason: string };
        try {
          chain = await options.chainValidator.validate(record, verified.keyid);
        } catch (error) {
          return unverifiable(
            `enrollment chain validation could not run: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (!chain.ok) return invalid(chain.reason);
        return { kind: 'enrolled', keyid: record.newKey.keyid, principal: verified.principal };
      } catch (error) {
        if (error instanceof SshSignerError) return unverifiable(error.message);
        if (error instanceof DsseEnvelopeError) {
          if (error.message.startsWith('DSSE verification failed:')) {
            sawCryptographicMiss = true;
            continue;
          }
          return invalid(`enrollment verification failed: ${error.message}`);
        }
        return invalid(`enrollment verification failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        signer.dispose?.();
      }
    }
  }

  if (sawCryptographicMiss) return invalid('enrollment signature could not be verified by an allowed signer');
  return invalid('enrollment signature did not verify');
}
