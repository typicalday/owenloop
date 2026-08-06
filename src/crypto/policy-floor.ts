/**
 * Verification and monotone evaluation of admin-signed organization policy floors.
 *
 * This module consumes the exact DSSE envelope bytes supplied by a caller, verifies
 * the frozen policy-floor record, and validates the signer's enrollment chain and
 * organization-wide scope. It performs no filesystem or network I/O, and a hub or
 * other relaying transport never authors, derives, or defaults a floor here.
 *
 * A floor is a minimum, never a replacement: effective definition policy is the
 * stricter of local policy and the verified floor. Every absent or failed floor
 * returns no floor to the merge function, so untrusted input can stall evaluation
 * but can never weaken the driver's local policy.
 */

import {
  decodeBase64Strict,
  DSSE_SSH_NAMESPACE,
  dsseVerifyPolicyFloor,
  DsseEnvelopeError,
} from './dsse.ts';
import { publicKeyDescriptor } from './keys.ts';
import {
  createSshSigner,
  SshSignerError,
} from './ssh.ts';
import type { Signer } from './ssh.ts';
import type {
  EnrollmentGrantRecord,
  GrantScope,
  PolicyFloor,
  PolicyFloorRecord,
} from './records.ts';
import {
  enrollmentGrantSchema,
  policyFloorSchema,
} from '../schemas/index.ts';
import { summarizeIssues, validateValue } from '../schema.ts';
import {
  validateEnrollmentChain,
  type ChainOptions,
} from './chain.ts';
import { axisPermits } from './scope.ts';
import type { DefPolicy } from './verify-publication.ts';

/** The outcome of verifying one policy-floor envelope. */
export type PolicyFloorVerdict =
  | { kind: 'verified'; record: PolicyFloorRecord; keyid: string; signerScope: GrantScope }
  | { kind: 'unverifiable'; reason: string }
  | { kind: 'invalid'; reason: string };

/** Pure verification inputs; callers provide all trust material explicitly. */
export interface VerifyPolicyFloorInput {
  /** Exact bytes of the stored or received DSSE envelope. */
  envelopeBytes: Uint8Array;
  /** Local organization-root public key anchor. */
  orgRootPublicKey: string;
  /** Raw enrollment-grant envelope bytes used by WP-D4 chain validation. */
  grants: Uint8Array[];
  /** Raw revocation envelope bytes used by WP-D4 chain validation. */
  revocations?: Uint8Array[];
  /** Explicit validation instant used for grant validity and revocation cuts. */
  at: number;
}

/** Cryptographic seams used by verification and by hermetic tests. */
export interface VerifyPolicyFloorOptions {
  /** Inject a signer for the candidate principal and one-key allowed-signers text. */
  signerForPrincipal?: ChainOptions['signerForPrincipal'];
  /** SSHSIG namespace used by the DSSE envelope. */
  namespace?: string;
  /** Maximum number of enrollment links accepted by WP-D4. */
  maxChainDepth?: number;
}

/** Strictness ordering for the existing C2 definition-policy vocabulary. */
export const DEF_POLICY_RANK: Readonly<Record<DefPolicy, number>> = Object.freeze({
  off: 0,
  warn: 1,
  enforce: 2,
});

/** Convert the frozen floor's unsigned-definition axis to C2's minimum policy. */
export function floorDefPolicyMinimum(floor: PolicyFloor): DefPolicy {
  return floor.unsignedDefs === 'refuse' ? 'enforce' : 'warn';
}

/** Convert the frozen floor's origin axis to the parallel local policy. */
export function originRulesMinimum(floor: PolicyFloor): DefPolicy {
  return floor.originRules === 'enforced' ? 'enforce' : 'warn';
}

/** Convert the frozen floor's unsigned-artifact axis to consume policy. */
export function artifactPolicyMinimum(floor: PolicyFloor): DefPolicy {
  return floor.unsignedArtifacts === 'refuse' ? 'enforce' : 'warn';
}

/** Return the stricter policy without assigning one policy over the other. */
export function stricterDefPolicy(a: DefPolicy, b: DefPolicy): DefPolicy {
  return DEF_POLICY_RANK[a] >= DEF_POLICY_RANK[b] ? a : b;
}

/** One floor axis carried for diagnostics instead of silently dropped. */
export interface PolicyFloorGap {
  axis: 'trustMode';
  value: string;
  reason: string;
}

/** The result of merging one optional verified floor into local policy. */
export interface PolicyFloorMergeResult {
  effective: DefPolicy;
  local: DefPolicy;
  raised: boolean;
  /** Effective local origin policy after applying the verified floor. */
  originPolicy: DefPolicy;
  /** Effective local artifact policy after applying the verified floor. */
  artifactPolicy: DefPolicy;
  gaps: PolicyFloorGap[];
}

/**
 * Presets are concrete wire values, not a second policy-level primitive. The
 * trustMode axis remains informational here; policyFloorGaps reports that
 * unevaluated control rather than pretending this package implements it.
 */
export const POLICY_FLOOR_PRESETS: Readonly<Record<'L0' | 'L1' | 'L2', PolicyFloor>> = Object.freeze({
  L0: Object.freeze({
    trustMode: 'seamless',
    unsignedDefs: 'warn',
    unsignedArtifacts: 'warn',
    originRules: 'advisory',
  }),
  L1: Object.freeze({
    trustMode: 'seamless',
    unsignedDefs: 'refuse',
    unsignedArtifacts: 'refuse',
    originRules: 'advisory',
  }),
  L2: Object.freeze({
    trustMode: 'strict',
    unsignedDefs: 'refuse',
    unsignedArtifacts: 'refuse',
    originRules: 'enforced',
  }),
});

/** Report every frozen axis that this engine does not evaluate yet. */
export function policyFloorGaps(floor: PolicyFloor): PolicyFloorGap[] {
  return [
    {
      axis: 'trustMode',
      value: floor.trustMode,
      reason: 'trustMode is carried but not evaluated by this engine; L2 git-pinned roster and sandbox authorship are not delivered here',
    },
  ];
}

/**
 * Merge a verified floor as a strictness minimum on both policy axes. The
 * optional origin and artifact arguments preserve the existing positional API;
 * callers that do not resolve either policy receive the neutral local value `off`.
 */
export function mergePolicyFloorWithLocal(
  local: DefPolicy,
  floor?: PolicyFloor,
  localOriginPolicy: DefPolicy = 'off',
  localArtifactPolicy: DefPolicy = 'off',
): PolicyFloorMergeResult {
  if (floor === undefined) {
    return {
      effective: local,
      local,
      raised: false,
      originPolicy: localOriginPolicy,
      artifactPolicy: localArtifactPolicy,
      gaps: [],
    };
  }
  const floorMinimum = floorDefPolicyMinimum(floor);
  const effective = stricterDefPolicy(local, floorMinimum);
  const originPolicy = stricterDefPolicy(localOriginPolicy, originRulesMinimum(floor));
  const artifactPolicy = stricterDefPolicy(localArtifactPolicy, artifactPolicyMinimum(floor));
  return {
    effective,
    local,
    raised: effective !== local,
    originPolicy,
    artifactPolicy,
    gaps: policyFloorGaps(floor),
  };
}

interface DecodedPolicyFloor {
  envelope: Record<string, unknown>;
  record: PolicyFloorRecord;
}

interface SignerCandidate {
  keyid: string;
  principal: string;
  publicKey: string;
}

type GrantCandidateResult =
  | { kind: 'skip' }
  | { kind: 'match'; candidate: SignerCandidate }
  | { kind: 'invalid'; reason: string };

function invalid(reason: string): PolicyFloorVerdict {
  return { kind: 'invalid', reason };
}

function unverifiable(reason: string): PolicyFloorVerdict {
  return { kind: 'unverifiable', reason };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodePolicyFloor(bytes: Uint8Array): DecodedPolicyFloor | PolicyFloorVerdict {
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    return invalid('policy floor envelope is not valid JSON');
  }
  if (!isJsonObject(envelope)) return invalid('policy floor envelope is not a JSON object');

  const payload = envelope.payload;
  if (typeof payload !== 'string') return invalid("policy floor envelope is missing a string 'payload'");

  let payloadBytes: Buffer;
  try {
    payloadBytes = decodeBase64Strict(payload, { allowEmpty: true });
  } catch (error) {
    return invalid(`policy floor payload is not valid Base64: ${(error as Error).message}`);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadBytes.toString('utf8')) as unknown;
  } catch {
    return invalid('policy floor payload is not valid JSON');
  }
  if (!isJsonObject(decoded)) return invalid('policy floor payload is not a JSON object');

  const shape = validateValue(policyFloorSchema, decoded);
  if (!shape.valid) {
    return invalid(`policy floor record does not match schema: ${summarizeIssues(shape.issues)}`);
  }
  return { envelope, record: decoded as unknown as PolicyFloorRecord };
}

function principalText(principal: unknown): string | undefined {
  if (!isJsonObject(principal)) return undefined;
  if (typeof principal.kind !== 'string' || typeof principal.id !== 'string') return undefined;
  return `${principal.kind}:${principal.id}`;
}

function parseGrantCandidate(raw: Uint8Array, targetKeyId: string): GrantCandidateResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(raw).toString('utf8')) as unknown;
  } catch {
    return { kind: 'skip' };
  }
  if (!isJsonObject(envelope) || typeof envelope.payload !== 'string') return { kind: 'skip' };

  let payloadBytes: Buffer;
  try {
    payloadBytes = decodeBase64Strict(envelope.payload, { allowEmpty: true });
  } catch {
    return { kind: 'skip' };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadBytes.toString('utf8')) as unknown;
  } catch {
    return { kind: 'skip' };
  }
  if (!isJsonObject(decoded)) return { kind: 'skip' };

  const shape = validateValue(enrollmentGrantSchema, decoded);
  if (!shape.valid) {
    const newKey = decoded.newKey;
    if (!isJsonObject(newKey) || newKey.keyid !== targetKeyId) return { kind: 'skip' };
    return { kind: 'invalid', reason: `policy floor signer grant does not match schema: ${summarizeIssues(shape.issues)}` };
  }

  const grant = decoded as unknown as EnrollmentGrantRecord;
  if (grant.newKey.keyid !== targetKeyId) return { kind: 'skip' };
  const principal = principalText(grant.principal);
  if (principal === undefined) return { kind: 'invalid', reason: `policy floor signer grant for '${targetKeyId}' has an invalid principal` };
  let descriptor: ReturnType<typeof publicKeyDescriptor>;
  try {
    descriptor = publicKeyDescriptor(grant.newKey.openSshPublicKey);
  } catch (error) {
    return { kind: 'invalid', reason: `policy floor signer grant for '${targetKeyId}' has an invalid public key: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (descriptor.keyid !== targetKeyId) {
    return {
      kind: 'invalid',
      reason: `policy floor signer grant for '${targetKeyId}' carries public key '${descriptor.keyid}'`,
    };
  }
  return {
    kind: 'match',
    candidate: {
      keyid: descriptor.keyid,
      principal,
      publicKey: descriptor.openSshPublicKey,
    },
  };
}

/**
 * Resolve the public key needed for the first DSSE check. The key is only a
 * candidate here; WP-D4 remains the authority that proves the candidate reaches
 * the local org-root anchor and retains the required scope.
 */
function deriveSignerCandidate(
  input: VerifyPolicyFloorInput,
  targetKeyId: string,
): SignerCandidate | PolicyFloorVerdict {
  let rootDescriptor: ReturnType<typeof publicKeyDescriptor> | undefined;
  let rootError: string | undefined;
  try {
    rootDescriptor = publicKeyDescriptor(input.orgRootPublicKey);
  } catch (error) {
    rootError = error instanceof Error ? error.message : String(error);
  }
  if (rootDescriptor?.keyid === targetKeyId) {
    return {
      keyid: rootDescriptor.keyid,
      principal: 'org-root',
      publicKey: rootDescriptor.openSshPublicKey,
    };
  }

  if (!Array.isArray(input.grants)) return invalid('enrollment roster is not an array');
  const matches: SignerCandidate[] = [];
  for (const raw of input.grants) {
    const result = parseGrantCandidate(raw, targetKeyId);
    if (result.kind === 'invalid') return invalid(result.reason);
    if (result.kind === 'match') matches.push(result.candidate);
  }
  if (matches.length > 1) return invalid(`enrollment roster contains more than one signer grant for '${targetKeyId}'`);
  const candidate = matches[0];
  if (candidate !== undefined) return candidate;
  if (rootError !== undefined) return unverifiable(`cannot use org root public key: ${rootError}`);
  return invalid(`policy floor signer key '${targetKeyId}' is not present in the local enrollment material`);
}

function makeSigner(
  options: VerifyPolicyFloorOptions,
  candidate: SignerCandidate,
): Pick<Signer, 'verify'> & { dispose?: () => void } | PolicyFloorVerdict {
  const factory = options.signerForPrincipal ?? ((args: { principal: string; allowedSignersText: string }) => createSshSigner({
    namespace: options.namespace ?? DSSE_SSH_NAMESPACE,
    verify: args,
  }));
  try {
    return factory({
      principal: candidate.principal,
      allowedSignersText: `${candidate.principal} ${candidate.publicKey}\n`,
    });
  } catch (error) {
    if (error instanceof SshSignerError) return unverifiable(error.message);
    return unverifiable(`policy floor verification setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function chainOptions(options: VerifyPolicyFloorOptions): ChainOptions {
  return {
    ...(options.signerForPrincipal === undefined ? {} : { signerForPrincipal: options.signerForPrincipal }),
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    ...(options.maxChainDepth === undefined ? {} : { maxChainDepth: options.maxChainDepth }),
  };
}

/** A floor signer is admin-level only when all three scope axes are unrestricted. */
function hasAdminScope(scope: GrantScope): boolean {
  return axisPermits(scope.pools, '*')
    && axisPermits(scope.labels, '*')
    && axisPermits(scope.namespaces, '*');
}

/**
 * Verify one exact policy-floor envelope, then validate its signer through WP-D4.
 * The record's unauthenticated fields select candidates only; the verified signer
 * key-id and the chain verdict authorize the floor.
 */
export async function verifyPolicyFloorRecord(
  input: VerifyPolicyFloorInput,
  options: VerifyPolicyFloorOptions = {},
): Promise<PolicyFloorVerdict> {
  const decoded = decodePolicyFloor(input.envelopeBytes);
  if ('kind' in decoded) return decoded;
  const { envelope, record } = decoded;

  const candidate = deriveSignerCandidate(input, record.signedBy);
  if ('kind' in candidate) return candidate;
  if (candidate.keyid !== record.signedBy) {
    return invalid(`policy floor signer candidate '${candidate.keyid}' does not match record signedBy '${record.signedBy}'`);
  }

  const signer = makeSigner(options, candidate);
  if ('kind' in signer) return signer;
  try {
    const result = await dsseVerifyPolicyFloor(envelope, signer, { threshold: 1 });
    const verified = result.signers[0];
    if (verified === undefined) return invalid('policy floor signature produced no verified signer');
    if (verified.keyid !== record.signedBy) {
      return invalid(`policy floor signer key '${verified.keyid}' does not match record signedBy '${record.signedBy}'`);
    }
  } catch (error) {
    if (error instanceof SshSignerError) return unverifiable(error.message);
    if (error instanceof DsseEnvelopeError) return invalid(`policy floor signature verification failed: ${error.message}`);
    return invalid(`policy floor signature verification failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    signer.dispose?.();
  }

  let chain;
  try {
    chain = await validateEnrollmentChain(
      {
        targetKeyId: record.signedBy,
        orgRootPublicKey: input.orgRootPublicKey,
        grants: input.grants,
        ...(input.revocations === undefined ? {} : { revocations: input.revocations }),
        at: input.at,
      },
      chainOptions(options),
    );
  } catch (error) {
    return unverifiable(`policy floor enrollment-chain validation could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (chain.kind === 'unverifiable') return chain;
  if (chain.kind === 'invalid') return chain;
  if (!hasAdminScope(chain.effectiveScope)) {
    return invalid(`policy floor signer '${chain.keyid}' lacks unrestricted admin scope on pools, labels, and namespaces`);
  }

  return {
    kind: 'verified',
    record,
    keyid: chain.keyid,
    signerScope: chain.effectiveScope,
  };
}

