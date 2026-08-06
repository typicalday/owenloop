/**
 * Enrollment-chain verification for locally anchored principal keys.
 *
 * The validator consumes raw DSSE envelopes and an explicit validation instant.
 * Each grant link is verified with a signer whose allowed-signers text contains
 * exactly that link's parent key, so a remote roster assertion cannot substitute
 * for the local org-root anchor. Scope attenuation and revocation authority are
 * checked after schema decoding and cryptographic verification. This module is
 * deliberately pure: it performs no filesystem or network I/O; org-root.ts
 * supplies the optional on-disk loader for callers that need one.
 */

import { decodeBase64Strict, DSSE_SSH_NAMESPACE, dsseVerifyEnrollmentGrant, dsseVerifyRevocation, DsseEnvelopeError } from './dsse.ts';
import { publicKeyDescriptor } from './keys.ts';
import { assertEd25519PubText, SshSignerError, createSshSigner } from './ssh.ts';
import type { Signer } from './ssh.ts';
import type {
  EnrollmentGrantRecord,
  GrantScope,
  PrincipalReference,
  RevocationRecord,
} from './records.ts';
import { enrollmentGrantSchema, revocationSchema } from '../schemas/index.ts';
import { summarizeIssues, validateValue } from '../schema.ts';
import { attenuate, ORG_ROOT_SCOPE, scopePermits } from './scope.ts';

/** Inputs to the pure enrollment-chain validator. */
export interface ChainInput {
  targetKeyId: string;
  orgRootPublicKey: string;
  grants: Uint8Array[];
  revocations?: Uint8Array[];
  at: number;
}

/** Injectable cryptographic and policy options for chain verification. */
export interface ChainOptions {
  signerForPrincipal?: (args: {
    principal: string;
    allowedSignersText: string;
  }) => Pick<Signer, 'verify'> & { dispose?: () => void };
  /** SSHSIG namespace used by the DSSE envelopes. */
  namespace?: string;
  /** Maximum number of grant links before the walk is refused. */
  maxChainDepth?: number;
  /** Sink for the conspicuous, non-secret accepted-backdating note. */
  onBackdatedRevocation?: (note: string) => void;
}

/** The three possible chain-validation decisions. */
export type ChainVerdict =
  | { kind: 'verified'; keyid: string; principal: PrincipalReference; effectiveScope: GrantScope; depth: number }
  | { kind: 'unverifiable'; reason: string }
  | { kind: 'invalid'; reason: string };

type ParsedGrant = { envelope: unknown; record: EnrollmentGrantRecord };
type ParsedRevocation = { envelope: unknown; record: RevocationRecord };
type ParseFailure = { kind: 'invalid'; reason: string };
type KeyInfo = {
  keyid: string;
  publicKey: string;
  principal: string;
  scope: GrantScope;
};

function invalid(reason: string): ParseFailure {
  return { kind: 'invalid', reason };
}

function unverifiable(reason: string): ChainVerdict {
  return { kind: 'unverifiable', reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decode and schema-check one signed record without invoking any signer. */
function decodeRecord<T>(
  bytes: Uint8Array,
  label: string,
  schema: Parameters<typeof validateValue>[0],
): { envelope: unknown; record: T } | ParseFailure {
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    return invalid(`${label} envelope is not valid JSON`);
  }
  if (!isRecord(envelope)) return invalid(`${label} envelope is not a JSON object`);
  const payload = envelope.payload;
  if (typeof payload !== 'string') return invalid(`${label} envelope is missing a string 'payload'`);

  let payloadBytes: Buffer;
  try {
    payloadBytes = decodeBase64Strict(payload, { allowEmpty: true });
  } catch (error) {
    return invalid(`${label} payload is not valid Base64: ${(error as Error).message}`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadBytes.toString('utf8')) as unknown;
  } catch {
    return invalid(`${label} payload is not valid JSON`);
  }
  if (!isRecord(decoded)) return invalid(`${label} payload is not a JSON object`);
  const shape = validateValue(schema, decoded);
  if (!shape.valid) {
    return invalid(`${label} record does not match schema: ${summarizeIssues(shape.issues)}`);
  }
  return { envelope, record: decoded as T };
}

function parseGrants(bytes: Uint8Array[]): Map<string, ParsedGrant> | ParseFailure {
  const grants = new Map<string, ParsedGrant>();
  for (const raw of bytes) {
    const parsed = decodeRecord<EnrollmentGrantRecord>(raw, 'enrollment grant', enrollmentGrantSchema);
    if ('kind' in parsed) return parsed;
    const keyid = parsed.record.newKey.keyid;
    if (grants.has(keyid)) {
      return invalid(`roster contains more than one enrollment grant for '${keyid}'`);
    }
    grants.set(keyid, parsed);
  }
  return grants;
}

function parseRevocations(bytes: Uint8Array[]): ParsedRevocation[] | ParseFailure {
  const revocations: ParsedRevocation[] = [];
  for (const raw of bytes) {
    const parsed = decodeRecord<RevocationRecord>(raw, 'revocation', revocationSchema);
    if ('kind' in parsed) return parsed;
    revocations.push(parsed);
  }
  return revocations;
}

function principalText(principal: PrincipalReference): string {
  return `${principal.kind}:${principal.id}`;
}

function describePublicKey(publicKey: string, label: string): { info: { keyid: string; publicKey: string } } | ParseFailure {
  try {
    assertEd25519PubText(publicKey, label);
    const descriptor = publicKeyDescriptor(publicKey);
    return { info: { keyid: descriptor.keyid, publicKey: descriptor.openSshPublicKey } };
  } catch (error) {
    return invalid(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function signerText(info: { principal: string; publicKey: string }): string {
  // The descriptor contains one canonical OpenSSH key line. No second roster
  // key is ever concatenated here: OpenSSH must authorize this parent only.
  return `${info.principal} ${info.publicKey}\n`;
}

function makeSigner(options: ChainOptions, parent: { principal: string; publicKey: string }) {
  const factory = options.signerForPrincipal ?? ((args: { principal: string; allowedSignersText: string }) => createSshSigner({
    namespace: options.namespace ?? DSSE_SSH_NAMESPACE,
    verify: args,
  }));
  return factory({ principal: parent.principal, allowedSignersText: signerText(parent) });
}

async function verifyGrant(
  parsed: ParsedGrant,
  childKeyId: string,
  parent: { keyid: string; principal: string; publicKey: string },
  options: ChainOptions,
): Promise<ChainVerdict | { kind: 'ok' }> {
  let signer: Pick<Signer, 'verify'> & { dispose?: () => void };
  try {
    signer = makeSigner(options, parent);
  } catch (error) {
    if (error instanceof SshSignerError) return unverifiable(error.message);
    return unverifiable(`enrollment grant verification setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const result = await dsseVerifyEnrollmentGrant(parsed.envelope, signer, { threshold: 1 });
    const verified = result.signers[0];
    if (verified === undefined) return invalid(`enrollment grant for '${childKeyId}' produced no verified signer`);
    if (verified.keyid !== parent.keyid) {
      return invalid(
        `enrollment grant for '${childKeyId}' was verified by '${verified.keyid}', expected parent '${parent.keyid}'`,
      );
    }
    return { kind: 'ok' };
  } catch (error) {
    if (error instanceof SshSignerError) return unverifiable(error.message);
    if (error instanceof DsseEnvelopeError) {
      return invalid(`enrollment grant for '${childKeyId}' signature verification failed: ${error.message}`);
    }
    return invalid(
      `enrollment grant for '${childKeyId}' signature verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    signer.dispose?.();
  }
}

async function verifyRevocation(
  parsed: ParsedRevocation,
  authority: { keyid: string; principal: string; publicKey: string },
  options: ChainOptions,
): Promise<ChainVerdict | { kind: 'ok' }> {
  let signer: Pick<Signer, 'verify'> & { dispose?: () => void };
  try {
    signer = makeSigner(options, authority);
  } catch (error) {
    if (error instanceof SshSignerError) return unverifiable(error.message);
    return unverifiable(`revocation verification setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const result = await dsseVerifyRevocation(parsed.envelope, signer, { threshold: 1 });
    const verified = result.signers[0];
    if (verified === undefined) return invalid(`revocation for '${parsed.record.revokedKey}' produced no verified signer`);
    if (verified.keyid !== authority.keyid) {
      return invalid(
        `revocation for '${parsed.record.revokedKey}' was verified by '${verified.keyid}', expected signer '${authority.keyid}'`,
      );
    }
    return { kind: 'ok' };
  } catch (error) {
    if (error instanceof SshSignerError) return unverifiable(error.message);
    if (error instanceof DsseEnvelopeError) {
      return invalid(`revocation for '${parsed.record.revokedKey}' signature verification failed: ${error.message}`);
    }
    return invalid(
      `revocation for '${parsed.record.revokedKey}' signature verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    signer.dispose?.();
  }
}

/** The canonical cross-field revocation timestamp rule. */
export function revocationTemporalConsistency(record: RevocationRecord): boolean {
  return record.backdated === (record.effectiveFrom < record.issuedAt);
}

function isAncestor(
  revokedKey: string,
  possibleAncestor: string,
  parentOf: Map<string, string>,
  rootKeyId: string,
): boolean {
  let current = revokedKey;
  const seen = new Set<string>();
  while (current !== rootKeyId) {
    if (seen.has(current)) return false;
    seen.add(current);
    const parent = parentOf.get(current);
    if (parent === undefined) return false;
    if (parent === possibleAncestor) return true;
    current = parent;
  }
  return possibleAncestor === rootKeyId;
}

/**
 * Validate that `targetKeyId` is rooted at the supplied org anchor, with all
 * grant links attenuating scope and all effective revocations applied at `at`.
 */
export async function validateEnrollmentChain(
  input: ChainInput,
  options: ChainOptions = {},
): Promise<ChainVerdict> {
  if (!Number.isInteger(input.at) || input.at < 0) {
    return invalid(`validation instant '${String(input.at)}' is not a non-negative integer`);
  }
  const maxDepth = options.maxChainDepth ?? 32;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    return invalid(`maxChainDepth '${String(maxDepth)}' is not a non-negative integer`);
  }

  const rawRevocations = input.revocations ?? [];
  const parsedRevocations = parseRevocations(rawRevocations);
  if ('kind' in parsedRevocations) return parsedRevocations;

  const anchor = describePublicKey(input.orgRootPublicKey, 'org root public key');
  if ('kind' in anchor) return unverifiable(`cannot use org root public key: ${anchor.reason}`);
  const rootKeyId = anchor.info.keyid;

  // The anchor has no grant record. A self-revocation is always refused rather
  // than silently making every otherwise-valid chain unverifiable.
  if (parsedRevocations.some((entry) => entry.record.revokedKey === rootKeyId)) {
    return invalid(`revocation of the org root '${rootKeyId}' is not permitted`);
  }
  if (input.targetKeyId === rootKeyId) {
    return {
      kind: 'verified',
      keyid: rootKeyId,
      principal: { kind: 'human', id: 'org-root' },
      effectiveScope: ORG_ROOT_SCOPE,
      depth: 0,
    };
  }

  if (!Array.isArray(input.grants)) return invalid('enrollment roster is not an array');
  const grants = parseGrants(input.grants);
  if ('kind' in grants) return grants;

  const rootInfo: KeyInfo = {
    keyid: rootKeyId,
    publicKey: anchor.info.publicKey,
    principal: 'org-root',
    scope: ORG_ROOT_SCOPE,
  };
  const chainKeys = new Map<string, KeyInfo>([[rootKeyId, rootInfo]]);
  const parentOf = new Map<string, string>();
  const visited = new Set<string>();
  let current = input.targetKeyId;
  let depth = 0;
  let effectiveScope: GrantScope | undefined;
  let targetPrincipal: PrincipalReference | undefined;

  while (current !== rootKeyId) {
    if (visited.has(current)) {
      return invalid(`enrollment chain for '${input.targetKeyId}' contains a cycle at '${current}'`);
    }
    visited.add(current);
    if (depth >= maxDepth) {
      return invalid(`enrollment chain for '${input.targetKeyId}' exceeds maxChainDepth ${maxDepth} at '${current}'`);
    }

    const parsed = grants.get(current);
    if (parsed === undefined) {
      return invalid(`enrollment chain for '${input.targetKeyId}' does not terminate at the org root: no grant for '${current}'`);
    }
    const grant = parsed.record;
    if (grant.validFrom > input.at) {
      return invalid(`enrollment grant for '${current}' is not valid until ${grant.validFrom}`);
    }

    const childPublic = describePublicKey(grant.newKey.openSshPublicKey, `enrollment grant for '${current}'`);
    if ('kind' in childPublic) return childPublic;
    if (childPublic.info.keyid !== current) {
      return invalid(
        `enrollment grant for '${current}' carries public key '${childPublic.info.keyid}' in newKey, not '${current}'`,
      );
    }
    if (grant.newKey.keyType !== 'ssh-ed25519') {
      return invalid(`enrollment grant for '${current}' declares non-Ed25519 key type '${grant.newKey.keyType}'`);
    }

    const parentId = grant.grantedBy;
    const parentGrant = parentId === rootKeyId ? undefined : grants.get(parentId);
    if (parentId !== rootKeyId && parentGrant === undefined) {
      return invalid(`enrollment chain for '${input.targetKeyId}' does not terminate at the org root: parent '${parentId}' has no grant`);
    }
    if (parentId === current) {
      return invalid(`enrollment chain for '${input.targetKeyId}' contains a cycle at '${current}'`);
    }

    let parentInfo: KeyInfo;
    if (parentId === rootKeyId) {
      parentInfo = rootInfo;
    } else {
      const parentRecord = parentGrant!.record;
      const parentPublic = describePublicKey(parentRecord.newKey.openSshPublicKey, `enrollment grant for '${parentId}'`);
      if ('kind' in parentPublic) return parentPublic;
      if (parentPublic.info.keyid !== parentId) {
        return invalid(
          `enrollment grant for '${parentId}' carries public key '${parentPublic.info.keyid}' in newKey, not '${parentId}'`,
        );
      }
      if (parentRecord.newKey.keyType !== 'ssh-ed25519') {
        return invalid(`enrollment grant for '${parentId}' declares non-Ed25519 key type '${parentRecord.newKey.keyType}'`);
      }
      parentInfo = {
        keyid: parentId,
        publicKey: parentPublic.info.publicKey,
        principal: principalText(parentRecord.principal),
        scope: parentRecord.scope,
      };
    }

    const attenuation = attenuate(parentInfo.scope, grant.scope);
    if (!attenuation.ok) {
      return invalid(`enrollment grant for '${current}' widens its parent scope: ${attenuation.reason}`);
    }

    const verified = await verifyGrant(
      parsed,
      current,
      { keyid: parentInfo.keyid, principal: parentInfo.principal, publicKey: parentInfo.publicKey },
      options,
    );
    if (verified.kind !== 'ok') return verified;

    chainKeys.set(current, {
      keyid: current,
      publicKey: childPublic.info.publicKey,
      principal: principalText(grant.principal),
      scope: grant.scope,
    });
    parentOf.set(current, parentId);
    if (effectiveScope === undefined) {
      effectiveScope = grant.scope;
      targetPrincipal = grant.principal;
    }
    current = parentId;
    depth += 1;
  }

  const finalScope = effectiveScope;
  const finalPrincipal = targetPrincipal;
  if (finalScope === undefined || finalPrincipal === undefined) {
    return invalid(`enrollment chain for '${input.targetKeyId}' contains no grant`);
  }

  for (const parsed of parsedRevocations) {
    const record = parsed.record;
    if (!chainKeys.has(record.revokedKey)) continue;
    if (record.revokedKey === rootKeyId) {
      return invalid(`revocation of the org root '${rootKeyId}' is not permitted`);
    }
    if (!revocationTemporalConsistency(record)) {
      return invalid(
        `revocation for '${record.revokedKey}' has inconsistent backdated flag for issuedAt ${record.issuedAt} and effectiveFrom ${record.effectiveFrom}`,
      );
    }

    const authority = chainKeys.get(record.revokedBy);
    if (authority === undefined || !isAncestor(record.revokedKey, record.revokedBy, parentOf, rootKeyId)) {
      return invalid(
        `revocation for '${record.revokedKey}' is signed by non-ancestor '${record.revokedBy}'`,
      );
    }
    if (record.revokedBy !== rootKeyId && !authority.scope.delegation.allowed) {
      return invalid(
        `revocation for '${record.revokedKey}' is signed by '${record.revokedBy}', whose delegation scope does not permit revocation`,
      );
    }
    if (record.backdated && record.revokedBy !== rootKeyId) {
      return invalid(`backdated revocation for '${record.revokedKey}' must be signed by the org root`);
    }

    const verified = await verifyRevocation(
      parsed,
      { keyid: authority.keyid, principal: authority.principal, publicKey: authority.publicKey },
      options,
    );
    if (verified.kind !== 'ok') return verified;

    if (record.backdated && record.revokedBy === rootKeyId) {
      (options.onBackdatedRevocation ?? (() => undefined))(
        `accepted backdated revocation for '${record.revokedKey}' effective from ${record.effectiveFrom}`,
      );
    }
    if (record.effectiveFrom <= input.at) {
      return invalid(
        `enrollment chain for '${input.targetKeyId}' contains revoked key '${record.revokedKey}' effective from ${record.effectiveFrom}`,
      );
    }
  }

  return {
    kind: 'verified',
    keyid: input.targetKeyId,
    principal: finalPrincipal,
    effectiveScope: finalScope,
    depth,
  };
}

/** Validate a chain first, then apply the requested producer scope demand. */
export async function validateProducer(
  input: ChainInput & { demand: { pool?: string; label?: string; namespace?: string } },
  options: ChainOptions = {},
): Promise<ChainVerdict> {
  const chain = await validateEnrollmentChain(input, options);
  if (chain.kind !== 'verified') return chain;
  const permitted = scopePermits(chain.effectiveScope, input.demand);
  if (!permitted.ok) {
    return invalid(`producer demand is outside the effective scope for '${chain.keyid}': ${permitted.reason}`);
  }
  return chain;
}
