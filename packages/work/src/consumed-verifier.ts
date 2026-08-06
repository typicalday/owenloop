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
  loadRoster,
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

export type ConsumedVerifier = (
  order: OrderPacket,
  opts: { hardRule: boolean },
) => Promise<ConsumedGateResult | ConsumedGateRefusal>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function linkFor(verdict: Exclude<ConsumedVerdict, { kind: 'verified' | 'absent' }>): string {
  const match = verdict.reason.match(/^(no-proof|signature|value-digest|version|chain|scope|prerequisite):/);
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

/** Create a verifier bound to one injected local environment and clock. */
export function createConsumedVerifier(args: CreateConsumedVerifierArgs): ConsumedVerifier {
  const policy = mergePolicyFloorWithLocal(
    'off',
    args.policyFloor,
    'off',
    resolveArtifactPolicy(args.env, args.artifactPolicy),
  ).artifactPolicy;

  return async (order: OrderPacket, opts: { hardRule: boolean }): Promise<ConsumedGateResult | ConsumedGateRefusal> => {
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
      grants = loadRoster(args.env);
      revocations = loadRevocations(args.env);
    } catch (error) {
      const reason = `prerequisite: local producer trust material could not be loaded: ${errorText(error)}`;
      const warnings: string[] = [];
      for (const path of Object.keys(order.consumes)) {
        const result = policyOutcome(order, opts.hardRule, policy, path, { kind: 'unverifiable', reason }, warnings);
        if (result !== undefined) return result;
      }
      for (const owed of order.owes) {
        if (owed.reasons.length === 0 && owed.proof === undefined) continue;
        const result = policyOutcome(order, opts.hardRule, policy, owed.path, { kind: 'unverifiable', reason }, warnings);
        if (result !== undefined) return result;
      }
      return { ok: true, order, warnings };
    }

    const prerequisite = root.kind === 'absent'
      ? 'prerequisite: no org-root anchor is configured'
      : undefined;
    const rootPublicKey = root.kind === 'present' ? root.publicKey : '';
    const proofs = parseProofMap(order);
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
