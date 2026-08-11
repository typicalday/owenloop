/**
 * Consume-side verification for dynamic artifact values.
 *
 * A consuming driver receives values and signed submission envelopes from an
 * untrusted transport. This module verifies the envelope first, then checks the
 * signed submission record, the delivered value digest, the expected version,
 * and the producer's locally anchored enrollment chain and scope. Every trust
 * input is explicit; this module performs no filesystem, network, or clock I/O.
 */

import { decodeBase64Strict, DSSE_SSH_NAMESPACE, dsseVerifySubmission, DsseEnvelopeError } from './dsse.ts';
import { publicKeyDescriptor } from './keys.ts';
import { createSshSigner, SshSignerError } from './ssh.ts';
import type { Signer } from './ssh.ts';
import type { PrincipalReference, SubmissionRecord } from './records.ts';
import { enrollmentGrantSchema, submissionSchema } from '../schemas/index.ts';
import { summarizeIssues, validateValue } from '../schema.ts';
import { valueDigestHex } from './canonical.ts';
import { validateProducer, type ChainInput, type ChainOptions, type ChainVerdict } from './chain.ts';

export type ConsumedVerdict =
  | { kind: 'verified'; producerKeyId: string; principal: PrincipalReference; version: number }
  | { kind: 'absent' }
  | { kind: 'unverifiable'; reason: string }
  | { kind: 'invalid'; reason: string };

export interface VerifyConsumedInput {
  /** Artifact path being consumed. */
  path: string;
  /** Exact dynamic value delivered by the transport. */
  value: unknown;
  /** Serialized DSSE submission envelope for this artifact. */
  proof?: string;
  /** Consumer claim-time version, when available. */
  expectedVersion?: number;
  /** Local organization-root public key anchor. */
  orgRootPublicKey: string;
  /** Raw enrollment-grant envelope bytes. */
  grants: Uint8Array[];
  /** Raw revocation envelope bytes. */
  revocations?: Uint8Array[];
  /** Consumer-owned validation instant. */
  at: number;
  /** Scope demanded by the consuming step. */
  demand: { pool?: string; label?: string; namespace?: string };
}

export interface VerifyConsumedOptions {
  /** Inject a signer for hermetic verification tests. */
  signerForPrincipal?: ChainOptions['signerForPrincipal'];
  /** SSHSIG namespace used by the DSSE envelope. */
  namespace?: string;
  /** Maximum enrollment-chain depth. */
  maxChainDepth?: number;
  /** Diagnostic sink for producer-claimed timestamps ahead of the consumer clock. */
  warn?: (line: string) => void;
  /** Optional chain-validation seam; drivers use this for per-invocation memoization. */
  chainValidator?: (
    input: ChainInput & { demand: VerifyConsumedInput['demand'] },
    options: ChainOptions,
  ) => Promise<ChainVerdict> | ChainVerdict;
}

type SignerCandidate = { keyid: string; principal: string; publicKey: string };

function invalid(reason: string): ConsumedVerdict {
  return { kind: 'invalid', reason };
}

function unverifiable(reason: string): ConsumedVerdict {
  return { kind: 'unverifiable', reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function principalText(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string' || typeof value.id !== 'string') return undefined;
  return `${value.kind}:${value.id}`;
}

function parseEnvelope(raw: string): { envelope: Record<string, unknown>; recordHint: Record<string, unknown> } | ConsumedVerdict {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw) as unknown;
  } catch {
    return invalid('signature: submission proof is not valid JSON');
  }
  if (!isRecord(envelope)) return invalid('signature: submission proof is not a JSON object');
  if (typeof envelope.payload !== 'string') return invalid("signature: submission proof is missing a string 'payload'");

  let payload: Buffer;
  try {
    payload = decodeBase64Strict(envelope.payload, { allowEmpty: true });
  } catch (error) {
    return invalid(`signature: submission proof payload is not valid Base64: ${(error as Error).message}`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString('utf8')) as unknown;
  } catch {
    return invalid('signature: submission proof payload is not valid JSON');
  }
  if (!isRecord(decoded)) return invalid('signature: submission proof payload is not a JSON object');
  if (typeof decoded.producerKeyId !== 'string' || decoded.producerKeyId === '') {
    return invalid("signature: submission record is missing a string 'producerKeyId'");
  }
  return { envelope, recordHint: decoded };
}

function candidateFromGrant(raw: Uint8Array, targetKeyId: string): SignerCandidate | { kind: 'skip' } | ConsumedVerdict {
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
  } catch {
    return { kind: 'skip' };
  }
  if (!isRecord(envelope) || typeof envelope.payload !== 'string') return { kind: 'skip' };
  let payload: Buffer;
  try {
    payload = decodeBase64Strict(envelope.payload, { allowEmpty: true });
  } catch {
    return { kind: 'skip' };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString('utf8')) as unknown;
  } catch {
    return { kind: 'skip' };
  }
  if (!isRecord(decoded)) return { kind: 'skip' };
  const shape = validateValue(enrollmentGrantSchema, decoded);
  if (!shape.valid) {
    const newKey = decoded.newKey;
    if (!isRecord(newKey) || newKey.keyid !== targetKeyId) return { kind: 'skip' };
    return invalid(`chain: producer grant for '${targetKeyId}' does not match schema: ${summarizeIssues(shape.issues)}`);
  }
  const grant = decoded as {
    newKey: { keyid: string; openSshPublicKey: string };
    principal: { kind: string; id: string };
  };
  if (grant.newKey.keyid !== targetKeyId) return { kind: 'skip' };
  const principal = principalText(grant.principal);
  if (principal === undefined) return invalid(`chain: producer grant for '${targetKeyId}' has an invalid principal`);
  try {
    const descriptor = publicKeyDescriptor(grant.newKey.openSshPublicKey);
    if (descriptor.keyid !== targetKeyId) {
      return invalid(`chain: producer grant for '${targetKeyId}' carries public key '${descriptor.keyid}'`);
    }
    return { keyid: descriptor.keyid, principal, publicKey: descriptor.openSshPublicKey };
  } catch (error) {
    return invalid(`chain: producer grant for '${targetKeyId}' has an invalid public key: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function deriveCandidate(input: VerifyConsumedInput, targetKeyId: string): SignerCandidate | ConsumedVerdict {
  if (input.orgRootPublicKey.trim() === '') return unverifiable('prerequisite: no org-root anchor is configured');

  let root: ReturnType<typeof publicKeyDescriptor>;
  try {
    root = publicKeyDescriptor(input.orgRootPublicKey);
    if (root.keyid === targetKeyId) return { keyid: root.keyid, principal: 'org-root', publicKey: root.openSshPublicKey };
  } catch {
    // validateProducer returns the complete, named root failure after the
    // signature candidate has been attempted; retain a prerequisite verdict.
    return unverifiable('prerequisite: the org-root anchor is not a valid public key');
  }

  if (!Array.isArray(input.grants) || input.grants.length === 0) {
    return unverifiable('prerequisite: no enrollment roster is configured');
  }

  const matches: SignerCandidate[] = [];
  for (const grant of input.grants) {
    const candidate = candidateFromGrant(grant, targetKeyId);
    if ('kind' in candidate) {
      if (candidate.kind === 'skip') continue;
      return candidate;
    }
    matches.push(candidate);
  }
  if (matches.length > 1) return invalid(`chain: enrollment roster contains more than one producer grant for '${targetKeyId}'`);
  const candidate = matches[0];
  return candidate === undefined
    ? invalid(`chain: producer key '${targetKeyId}' is not present in the local enrollment roster`)
    : candidate;
}

function makeSigner(options: VerifyConsumedOptions, candidate: SignerCandidate): Pick<Signer, 'verify'> & { dispose?: () => void } | ConsumedVerdict {
  const factory = options.signerForPrincipal ?? ((args: { principal: string; allowedSignersText: string }) => createSshSigner({
    namespace: options.namespace ?? DSSE_SSH_NAMESPACE,
    verify: args,
  }));
  try {
    return factory({ principal: candidate.principal, allowedSignersText: `${candidate.principal} ${candidate.publicKey}\n` });
  } catch (error) {
    if (error instanceof SshSignerError) return unverifiable(`prerequisite: submission verification setup failed: ${error.message}`);
    return unverifiable(`prerequisite: submission verification setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function chainOptions(options: VerifyConsumedOptions): ChainOptions {
  return {
    ...(options.signerForPrincipal === undefined ? {} : { signerForPrincipal: options.signerForPrincipal }),
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    ...(options.maxChainDepth === undefined ? {} : { maxChainDepth: options.maxChainDepth }),
  };
}

/** Verify one consumed value and its producer's enrollment/scope evidence. */
export async function verifyConsumed(
  input: VerifyConsumedInput,
  options: VerifyConsumedOptions = {},
): Promise<ConsumedVerdict> {
  if (input.proof === undefined) return { kind: 'absent' };
  if (!Number.isInteger(input.at) || input.at < 0) return invalid(`prerequisite: validation instant '${String(input.at)}' is not a non-negative integer`);

  const parsed = parseEnvelope(input.proof);
  if ('kind' in parsed) return parsed;
  const targetKeyId = parsed.recordHint.producerKeyId as string;
  const candidate = deriveCandidate(input, targetKeyId);
  if ('kind' in candidate) return candidate;
  const signer = makeSigner(options, candidate);
  if ('kind' in signer) return signer;

  let record: SubmissionRecord;
  let verifiedKeyId: string;
  try {
    const result = await dsseVerifySubmission(parsed.envelope, signer, { threshold: 1 });
    const verified = result.signers[0];
    if (verified === undefined) return invalid('signature: submission signature produced no verified signer');
    verifiedKeyId = verified.keyid;
    const decoded = JSON.parse(result.payloadBytes.toString('utf8')) as unknown;
    const shape = validateValue(submissionSchema, decoded);
    if (!shape.valid) return invalid(`signature: submission record does not match schema: ${summarizeIssues(shape.issues)}`);
    record = decoded as SubmissionRecord;
    if (verified.keyid !== record.producerKeyId) {
      return invalid(`signature: verified producer key '${verified.keyid}' does not match record producerKeyId '${record.producerKeyId}'`);
    }
  } catch (error) {
    if (error instanceof SshSignerError) return unverifiable(`prerequisite: ${error.message}`);
    if (error instanceof DsseEnvelopeError) return invalid(`signature: submission signature verification failed: ${error.message}`);
    return invalid(`signature: submission signature verification failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    signer.dispose?.();
  }

  const produced = record.produced.find((entry) => entry.artifact === input.path);
  if (produced === undefined) return invalid(`signature: signed submission record does not cover artifact '${input.path}'`);

  let deliveredDigest: string;
  try {
    deliveredDigest = valueDigestHex(input.value);
  } catch (error) {
    return invalid(`value-digest: delivered artifact '${input.path}' cannot be canonically represented: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (deliveredDigest !== produced.valueDigest) {
    return invalid(`value-digest: delivered artifact '${input.path}' has digest '${deliveredDigest}', signed digest is '${produced.valueDigest}'`);
  }
  if (input.expectedVersion !== undefined && produced.version !== input.expectedVersion) {
    return invalid(`version: artifact '${input.path}' has signed version ${produced.version}, expected version ${input.expectedVersion}`);
  }
  if (record.timestamp > input.at) {
    options.warn?.(`producer-claimed timestamp for artifact '${input.path}' is ${record.timestamp - input.at} ms ahead of local clock; timestamp is not used for revocation`);
  }

  let chain: ChainVerdict;
  try {
    const chainInput = {
      targetKeyId: record.producerKeyId,
      orgRootPublicKey: input.orgRootPublicKey,
      grants: input.grants,
      ...(input.revocations === undefined ? {} : { revocations: input.revocations }),
      at: input.at,
      demand: input.demand,
    };
    const chainValidate = options.chainValidator ?? validateProducer;
    chain = await chainValidate(chainInput, chainOptions(options));
  } catch (error) {
    return unverifiable(`prerequisite: producer enrollment-chain validation could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (chain.kind === 'unverifiable') return { kind: 'unverifiable', reason: `chain: ${chain.reason}` };
  if (chain.kind === 'invalid') {
    const link = chain.reason.includes('outside the effective scope') ? 'scope' : 'chain';
    return invalid(`${link}: ${chain.reason}`);
  }
  if (input.expectedVersion === undefined) {
    return unverifiable(
      `version: artifact '${input.path}' has a valid historical proof, but the claim omitted its authoritative expected version`,
    );
  }
  return { kind: 'verified', producerKeyId: verifiedKeyId, principal: chain.principal, version: produced.version };
}

/** Alias matching the other record verifier names. */
export const verifyConsumedArtifact = verifyConsumed;
