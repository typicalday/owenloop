/**
 * Driver-side binding for consume-side artifact verification.
 *
 * This module resolves local trust material from injected environment state and
 * gates a complete order before the order reaches an agent prompt or command
 * execution. A failed path refuses the whole order; the gate never removes only
 * the offending value and continues with a partial packet.
 */

import type { DefPolicy } from '../../../src/crypto/verify-publication.ts';
import {
  mergePolicyFloorWithLocal,
} from '../../../src/crypto/policy-floor.ts';
import type { PolicyFloor } from '../../../src/crypto/records.ts';
import {
  resolveArtifactPolicy,
} from '../../../src/store/pre-commit-verifier.ts';
import {
  loadRevocations,
  loadGrants,
  resolveOrgRoot,
} from '../../../src/crypto/org-root.ts';
import {
  verifyConsumed,
  type ConsumedVerdict,
  type VerifyConsumedOptions,
} from '../../../src/crypto/verify-consumed.ts';
import type { OrderPacket } from './hub/types.ts';
import { validateProducer, type ChainInput, type ChainOptions, type ChainVerdict } from '../../../src/crypto/chain.ts';

/** Missing-org-root warnings are intentionally latched once per order process-wide. */
const warnedMissingOrgRootOrders = new Set<string>();

export interface ConsumedGateResult {
  ok: true;
  order: OrderPacket;
  warnings: string[];
}

export interface ConsumedGateRefusal {
  ok: false;
  reason: string;
}

export interface CreateConsumedVerifierArgs {
  env: Record<string, string | undefined>;
  now: () => number;
  artifactPolicy?: DefPolicy;
  policyFloor?: PolicyFloor;
  /** Explicit producer scope demand; the default is no additional demand. */
  demand?: { pool?: string; label?: string; namespace?: string };
  /** Cryptographic seam for hermetic tests and alternate signer backends. */
  signerForPrincipal?: VerifyConsumedOptions['signerForPrincipal'];
  namespace?: string;
  maxChainDepth?: number;
  /** Optional warning sink; the returned warnings remain authoritative for callers. */
  warn?: (line: string) => void;
}

/** The calls-boundary facts for one consumed path, read by the caller from
 *  its VERIFIED local definition bytes: the parent's `calls:` step that
 *  produces the path, the exact child definition digest the parent pins, and
 *  the child's outcome stem. Never derived from the order. */
export interface VerifiedCallsProducer {
  /** The parent step whose `calls:` produces the consumed path. */
  step: string;
  /** The `calls:` target as authored on that step. */
  target: string;
  /** Exact definition digest the verified parent pins the child at. */
  childDefDigest: string;
  /** The verified child definition's single outcome stem (`outputs[0]`). */
  childOutcome: string;
}

export interface ConsumedVerifierOptions {
  hardRule: boolean;
  /** Calls-boundary context keyed by consumed path. Present only when the
   *  caller holds the verified definition (the command resolver). Without it
   *  a relayed record is `unverifiable`, never admitted: the hub's hints alone
   *  cannot say which child a parent pins. */
  callsProducers?: Readonly<Record<string, VerifiedCallsProducer>>;
}

export type ConsumedVerifier = (
  order: OrderPacket,
  opts: ConsumedVerifierOptions,
) => Promise<ConsumedGateResult | ConsumedGateRefusal>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function linkFor(verdict: Exclude<ConsumedVerdict, { kind: 'verified' | 'absent' }>): string {
  const match = verdict.reason.match(/^(no-proof|signature|value-digest|version|chain|scope|prerequisite|calls):/);
  if (match !== null) return match[1]!;
  return verdict.kind === 'invalid' ? 'signature' : 'prerequisite';
}

function detailFor(verdict: ConsumedVerdict): string {
  if (verdict.kind === 'verified') return 'verified';
  if (verdict.kind === 'absent') return 'no proof was supplied';
  const colon = verdict.reason.indexOf(':');
  return colon === -1 ? verdict.reason : verdict.reason.slice(colon + 1).trim();
}

function refusal(order: OrderPacket, link: string, path: string, detail: string): ConsumedGateRefusal {
  return {
    ok: false,
    reason: `consumed artifact refusal (${link}) for ${order.workflow}/${order.run} step '${order.step}' artifact '${path}': ${detail}`,
  };
}

function policyOutcome(
  order: OrderPacket,
  hardRule: boolean,
  policy: DefPolicy,
  path: string,
  verdict: ConsumedVerdict,
  warnings: string[],
): ConsumedGateResult | ConsumedGateRefusal | undefined {
  if (verdict.kind === 'verified') return undefined;
  const link = verdict.kind === 'absent' ? 'no-proof' : linkFor(verdict);
  const detail = detailFor(verdict);
  const mustRefuse = verdict.kind === 'invalid' || hardRule || policy === 'enforce';
  if (mustRefuse) return refusal(order, link, path, detail);
  if (policy === 'warn') {
    const missingOrgRoot = verdict.kind === 'unverifiable'
      && verdict.reason === 'prerequisite: no org-root anchor is configured';
    const orderKey = `${order.workflow}/${order.run}`;
    if (!missingOrgRoot || !warnedMissingOrgRootOrders.has(orderKey)) {
      warnings.push(`consumed artifact warning (${link}) for ${order.workflow}/${order.run} step '${order.step}' artifact '${path}': ${detail}`);
      if (missingOrgRoot) warnedMissingOrgRootOrders.add(orderKey);
    }
  }
  return undefined;
}

function parseProofMap(order: OrderPacket):
  | { kind: 'ok'; proofs: Record<string, string> }
  | { kind: 'unverifiable'; reason: string } {
  if (order.consumesProof === undefined) return { kind: 'ok', proofs: {} };
  if (typeof order.consumesProof !== 'string') {
    return { kind: 'unverifiable', reason: 'prerequisite: consumesProof is not a JSON string' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(order.consumesProof) as unknown;
  } catch {
    return { kind: 'unverifiable', reason: 'prerequisite: consumesProof is not valid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unverifiable', reason: 'prerequisite: consumesProof is not a JSON object' };
  }
  const proofs: Record<string, string> = {};
  for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value === '') {
      return { kind: 'unverifiable', reason: `prerequisite: consumesProof entry for artifact '${path}' is not a non-empty string` };
    }
    proofs[path] = value;
  }
  return { kind: 'ok', proofs };
}

interface RelayHint {
  childDefDigest: string;
  childVersion: number;
  childOutcome: string;
}

function parseRelayMap(order: OrderPacket):
  | { kind: 'ok'; relays: Record<string, RelayHint> }
  | { kind: 'unverifiable'; reason: string } {
  const raw: unknown = order.consumesProofRelay;
  if (raw === undefined) return { kind: 'ok', relays: {} };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'unverifiable', reason: 'prerequisite: consumesProofRelay is not a JSON object' };
  }
  const relays: Record<string, RelayHint> = {};
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { kind: 'unverifiable', reason: `prerequisite: consumesProofRelay entry for artifact '${path}' is not an object` };
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.childDefDigest !== 'string' || entry.childDefDigest === '') {
      return { kind: 'unverifiable', reason: `prerequisite: consumesProofRelay entry for artifact '${path}' has no non-empty string 'childDefDigest'` };
    }
    if (typeof entry.childVersion !== 'number' || !Number.isInteger(entry.childVersion) || entry.childVersion < 0) {
      return { kind: 'unverifiable', reason: `prerequisite: consumesProofRelay entry for artifact '${path}' has no non-negative integer 'childVersion'` };
    }
    if (typeof entry.childOutcome !== 'string' || entry.childOutcome === '') {
      return { kind: 'unverifiable', reason: `prerequisite: consumesProofRelay entry for artifact '${path}' has no non-empty string 'childOutcome'` };
    }
    relays[path] = { childDefDigest: entry.childDefDigest, childVersion: entry.childVersion, childOutcome: entry.childOutcome };
  }
  return { kind: 'ok', relays };
}

/**
 * Calls boundary. A path a `calls:` step produced has no submission record of
 * its own: the engine folds the child's outcome into it without a `submit`.
 * The hub may relay the CHILD's record under the parent path together with
 * hints naming the child. Every hint is corroborated against the caller's
 * verified definition bytes before the record is examined; the record itself
 * must have been signed for exactly the pinned child definition and cover the
 * child's outcome stem. Nothing here admits a path that carries no record.
 *
 * The boundary is exclusive in both directions. A path the verified
 * definition produces through a `calls:` step accepts ONLY the relay contract:
 * ordinary verification never compares a record's signed definition digest
 * with anything, so letting a calls-produced path fall through to it would let
 * any trusted record covering the parent path with a matching value and
 * version stand in for the child's outcome. And a relay offered for a path the
 * verified definition does not produce through a `calls:` step is refused
 * outright, with or without a record.
 */
type CallsBoundary =
  | { kind: 'ordinary' }
  | { kind: 'relay'; relay: RelayHint; producer: VerifiedCallsProducer }
  | { kind: 'uncorroborated'; verdict: ConsumedVerdict }
  | { kind: 'refused'; verdict: ConsumedVerdict };

function callsBoundary(
  path: string,
  relay: RelayHint | undefined,
  producers: ConsumedVerifierOptions['callsProducers'],
): CallsBoundary {
  if (producers === undefined) {
    // A consumer with no verified definition (an agent worker) can neither
    // confirm nor deny that the path is calls-produced: without a relay the
    // path is an ordinary one to it, and with one it cannot corroborate.
    if (relay === undefined) return { kind: 'ordinary' };
    return {
      kind: 'uncorroborated',
      verdict: {
        kind: 'unverifiable',
        reason: `prerequisite: artifact '${path}' carries a calls-boundary relay, but this consumer holds no verified definition to corroborate the calls child against`,
      },
    };
  }
  const producer = producers[path];
  if (producer === undefined) {
    if (relay === undefined) return { kind: 'ordinary' };
    return {
      kind: 'refused',
      verdict: {
        kind: 'invalid',
        reason: `calls: artifact '${path}' carries a calls-boundary relay, but the verified definition does not produce it through a calls: step`,
      },
    };
  }
  if (relay === undefined) {
    return {
      kind: 'refused',
      verdict: {
        kind: 'invalid',
        reason: `calls: artifact '${path}' is produced by calls: step '${producer.step}' (${producer.target}), so only a relayed child proof can prove it, but the order carries no consumesProofRelay entry for it`,
      },
    };
  }
  if (relay.childDefDigest !== producer.childDefDigest) {
    return {
      kind: 'refused',
      verdict: {
        kind: 'invalid',
        reason: `calls: relay for artifact '${path}' names child definition digest '${relay.childDefDigest}', but the verified definition pins calls: step '${producer.step}' (${producer.target}) at '${producer.childDefDigest}'`,
      },
    };
  }
  if (relay.childOutcome !== producer.childOutcome) {
    return {
      kind: 'refused',
      verdict: {
        kind: 'invalid',
        reason: `calls: relay for artifact '${path}' names child outcome '${relay.childOutcome}', but the verified child definition for calls: step '${producer.step}' declares outcome '${producer.childOutcome}'`,
      },
    };
  }
  return { kind: 'relay', relay, producer };
}

/** Create a verifier bound to one injected local environment and clock. */
export function createConsumedVerifier(args: CreateConsumedVerifierArgs): ConsumedVerifier {
  const policy = mergePolicyFloorWithLocal(
    'off',
    args.policyFloor,
    'off',
    resolveArtifactPolicy(args.env, args.artifactPolicy),
  ).artifactPolicy;

  return async (order: OrderPacket, opts: ConsumedVerifierOptions): Promise<ConsumedGateResult | ConsumedGateRefusal> => {
    if (Object.keys(order.consumes).length === 0 && order.owes.every((owed) => owed.reasons.length === 0 && owed.proof === undefined)) {
      return { ok: true, order, warnings: [] };
    }

    // One consumer-owned clock sample governs every path in this gate call.
    // Revocation is evaluated at consume time; a later per-path sample would
    // make one order internally inconsistent and defeat the cache key below.
    const at = args.now();

    let root: ReturnType<typeof resolveOrgRoot>;
    let grants: Uint8Array[];
    let revocations: Uint8Array[];
    try {
      root = resolveOrgRoot(args.env);
      grants = loadGrants(args.env);
      revocations = loadRevocations(args.env);
    } catch (error) {
      return {
        ok: false,
        reason: `consumed artifact gate refusal for ${order.workflow}/${order.run} step '${order.step}': local producer trust material could not be loaded: ${errorText(error)}`,
      };
    }

    const prerequisite = root.kind === 'absent'
      ? 'prerequisite: no org-root anchor is configured'
      : undefined;
    const rootPublicKey = root.kind === 'present' ? root.publicKey : '';
    const proofs = parseProofMap(order);
    const relays = parseRelayMap(order);
    const warnings: string[] = [];
    const chainCache = new Map<string, Promise<ChainVerdict>>();
    const chainValidator = (
      input: ChainInput & { demand: { pool?: string; label?: string; namespace?: string } },
      options: ChainOptions,
    ): Promise<ChainVerdict> => {
      const cacheKey = JSON.stringify([input.targetKeyId, input.at]);
      const cached = chainCache.get(cacheKey);
      if (cached !== undefined) return cached;
      const pending = validateProducer(input, options);
      chainCache.set(cacheKey, pending);
      return pending;
    };
    const verifierOptions: VerifyConsumedOptions = {
      ...(args.signerForPrincipal === undefined ? {} : { signerForPrincipal: args.signerForPrincipal }),
      ...(args.namespace === undefined ? {} : { namespace: args.namespace }),
      ...(args.maxChainDepth === undefined ? {} : { maxChainDepth: args.maxChainDepth }),
      chainValidator,
      warn: (line) => {
        warnings.push(line);
      },
    };

    for (const [path, value] of Object.entries(order.consumes)) {
      let verdict: ConsumedVerdict;
      if (prerequisite !== undefined) {
        verdict = { kind: 'unverifiable', reason: prerequisite };
      } else if (proofs.kind === 'unverifiable') {
        verdict = { kind: 'unverifiable', reason: proofs.reason };
      } else if (relays.kind === 'unverifiable') {
        verdict = { kind: 'unverifiable', reason: relays.reason };
      } else {
        // The calls boundary is settled before any record is consulted: a
        // calls-produced path without a relay, or a relay on a non-calls
        // path, is refused here and never reaches ordinary verification.
        const boundary = callsBoundary(path, relays.relays[path], opts.callsProducers);
        if (boundary.kind === 'refused') {
          verdict = boundary.verdict;
        } else if (boundary.kind !== 'ordinary' && proofs.proofs[path] === undefined) {
          // Hints without a record prove nothing: the path stays unproven.
          verdict = { kind: 'absent' };
        } else if (boundary.kind === 'uncorroborated') {
          verdict = boundary.verdict;
        } else if (boundary.kind === 'relay') {
          verdict = await verifyConsumed({
            path,
            value,
            proof: proofs.proofs[path]!,
            // The pinned CHILD outcome version. The parent's
            // consumedFingerprint[path] counts the parent artifact and is a
            // different number; a coincidental match must never be relied on.
            expectedVersion: boundary.relay.childVersion,
            relay: { childDefDigest: boundary.producer.childDefDigest, childOutcome: boundary.producer.childOutcome },
            orgRootPublicKey: rootPublicKey,
            grants,
            revocations,
            at,
            demand: args.demand ?? {},
          }, verifierOptions);
        } else {
          verdict = await verifyConsumed({
            path,
            value,
            ...(proofs.proofs[path] === undefined ? {} : { proof: proofs.proofs[path] }),
            ...(order.consumedFingerprint?.[path] === undefined ? {} : { expectedVersion: order.consumedFingerprint[path] }),
            orgRootPublicKey: rootPublicKey,
            grants,
            revocations,
            at,
            demand: args.demand ?? {},
          }, verifierOptions);
        }
      }
      const result = policyOutcome(order, opts.hardRule, policy, path, verdict, warnings);
      if (result !== undefined) return result;
    }

    for (const owed of order.owes) {
      if (owed.reasons.length === 0 && owed.proof === undefined) continue;
      let verdict: ConsumedVerdict;
      if (prerequisite !== undefined) {
        verdict = { kind: 'unverifiable', reason: prerequisite };
      } else if (proofs.kind === 'unverifiable') {
        verdict = { kind: 'unverifiable', reason: proofs.reason };
      } else {
        verdict = await verifyConsumed({
          path: owed.path,
          value: owed.reasons,
          ...(owed.proof === undefined ? {} : { proof: owed.proof }),
	  ...(owed.version === undefined ? {} : { expectedVersion: owed.version }),
          orgRootPublicKey: rootPublicKey,
          grants,
          revocations,
          at,
          demand: args.demand ?? {},
        }, verifierOptions);
      }
      const result = policyOutcome(order, opts.hardRule, policy, owed.path, verdict, warnings);
      if (result !== undefined) return result;
    }

    const deduped = [...new Set(warnings)];
    for (const warning of deduped) args.warn?.(warning);
    return { ok: true, order, warnings: deduped };
  };
}

export function resetConsumedVerifierWarningsForTests(): void {
  warnedMissingOrgRootOrders.clear();
}
