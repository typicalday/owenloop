/** One-use, pre-provider authorization for a Service-ordered agent tuple. */
import { isDeepStrictEqual } from 'node:util';
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import type { RoutingChildClient } from '../hub/routing-child-client.ts';
import type { ContactHolder, LocalModelTuple, OrderPacket } from '../hub/types.ts';

const refused = (): Error => new Error('routed agent launch refused');

export interface RoutedAgentLaunch {
  selected: LocalModelTuple;
  reservationId: string;
  expiresAt: number;
}
export interface RoutedAgentSelection {
  selected: LocalModelTuple;
  /** Called only after the adapter's local policy and consumed inputs pass. */
  authorize(signal?: AbortSignal): Promise<RoutedAgentLaunch>;
}

type Args = {
  child: Pick<RoutingChildClient, 'readRoutingClaim' | 'assessLocalModel' | 'reserveLaunch'
    | 'reportLaunch' | 'getLaunchOrder'>;
  holder: ContactHolder; workflow: string; run: string; now?: () => number;
  /** Optional local effects such as git worktree provisioning. Only after the
   * authenticated report ACK; the final live order read follows the effect. */
  beforeFinalCheck?: (order: OrderPacket, signal?: AbortSignal) => Promise<void> | void;
};

/**
 * The broker independently verifies current parent trust and roster state at
 * reserve/report. This child gate accepts only that pinned grant's ordered
 * candidates, then awaits an unknown-observation receipt before any caller
 * may start or deliver provider work. A lost acknowledgement consumes the
 * one-use latch and cannot silently authorize another cold start.
 */
export function createRoutedAgentSelection(args: Args):
  (order: OrderPacket, signal?: AbortSignal) => Promise<RoutedAgentSelection> {
  const now = args.now ?? Date.now;
  let used = false;
  return async (order, signal) => {
    if (used || signal?.aborted || order.workflow !== args.workflow || order.run !== args.run
      || (order.worker !== undefined && order.worker !== 'agent')
      || !order.routing || args.holder.kind !== 'session') throw refused();
    used = true;
    // Pin the full order before any asynchronous assessment or local checks.
    const pinned = structuredClone(order);
    const routing = pinned.routing!;
    const { claim, preference } = routing;
    const deadline = Math.min(preference.expiresAt, claim.binding.expiresAt);
    const live = (later?: AbortSignal) => !signal?.aborted && !later?.aborted && now() < deadline;
    if (!live() || claim.orderId !== args.run || typeof claim.attemptId !== 'string'
      || !claim.attemptId
      || claim.sessionId !== claim.binding.authority.sessionId
      || claim.principalId !== claim.binding.authority.principalId
      || args.holder.id !== claim.sessionId || args.holder.shiftId !== claim.shiftId) throw refused();
    const fresh = await args.child.readRoutingClaim({ workflow: args.workflow, run: args.run });
    if (!live() || fresh.freshness !== 'fresh-at-read' || fresh.atomicLaunch !== false
      || !isDeepStrictEqual(fresh.routing, routing)) throw refused();
    const candidates = preference.tuples.filter(row => row.eligible && row.available).map(row => row.tuple);
    if (candidates.length === 0 || candidates.length > 32
      || new Set(candidates.map(row => row.id)).size !== candidates.length) throw refused();
    const candidateIds = candidates.map(row => row.id);
    let requested: LocalModelTuple | null = null;
    let selected = candidates[0]!;
    let assessmentId: string | null = null;
    if (preference.localModel) {
      const result = await args.child.assessLocalModel({ workflow: args.workflow, run: args.run, candidateIds });
      const assessment = result.assessment;
      if (!live() || !assessment || !Number.isSafeInteger(assessment.expiresAt)
	|| assessment.expiresAt <= now() || !isDeepStrictEqual(assessment.candidateIds, candidateIds)
	|| assessment.workflow !== args.workflow || assessment.orderId !== claim.orderId
	|| assessment.attemptId !== claim.attemptId || assessment.claimId !== claim.claimId
	|| assessment.decisionId !== claim.decisionId
	|| assessment.policy.onFailure !== preference.localModel.onFailure
	|| !assessment.assessmentId) throw refused();
      if (result.status === 'advisory' && assessment.status === 'advisory') {
	const advised = candidates.find(row => isDeepStrictEqual(row, assessment.advised));
	if (!advised) throw refused();
	requested = advised;
	selected = advised;
      } else if (result.status !== 'fallback' || assessment.status !== 'fallback'
	|| preference.localModel.onFailure !== 'fallback' || assessment.advised !== null) throw refused();
      assessmentId = assessment.assessmentId;
    }
    if (!live()) throw refused();
    let authorized = false;
    return { selected: structuredClone(selected), authorize: async (later?: AbortSignal) => {
      if (authorized || !live(later)) throw refused();
      authorized = true;
      const request = { version: 'launch-reservation-v1' as const,
      claimId: claim.claimId, decisionId: claim.decisionId, binding: claim.binding,
      orderId: claim.orderId, attemptId: claim.attemptId,
      rosterRevision: preference.rosterRevision, candidateIds, assessmentId, requested, selected };
      const reservation = await args.child.reserveLaunch({ workflow: args.workflow, request });
      if (!live(later) || reservation.orderId !== args.run || !reservation.reservationId
      || !Number.isSafeInteger(reservation.expiresAt) || reservation.expiresAt <= now()
      || reservation.expiresAt > deadline) throw refused();
      const report = { version: 'launch-v1' as const, reservationId: reservation.reservationId,
      decisionId: claim.decisionId, binding: claim.binding, claimId: claim.claimId,
      orderId: claim.orderId, attemptId: claim.attemptId, requested, selected,
      observation: { state: 'unknown' as const } };
      const accepted = await args.child.reportLaunch({ workflow: args.workflow, report });
      if (!live(later) || accepted.orderId !== args.run || accepted.provenance !== 'authenticated-worker-report'
      || accepted.digest !== valueDigestHex(report) || !Number.isSafeInteger(accepted.recordedAt)
      || now() >= reservation.expiresAt) throw refused();
      if (args.beforeFinalCheck) {
	await args.beforeFinalCheck(pinned, later ?? signal);
	if (!live(later) || now() >= reservation.expiresAt) throw refused();
      }
      const final = await args.child.getLaunchOrder({ workflow: args.workflow, run: args.run,
      holder: args.holder });
      if (!live(later) || now() >= reservation.expiresAt || !final.lease.claimed || !final.order
	|| !isDeepStrictEqual(final.order, pinned)) throw refused();
      return { selected: structuredClone(selected), reservationId: reservation.reservationId,
	expiresAt: reservation.expiresAt };
    } };
  };
}

/** Convenience for callers whose adapter policy is already preflighted. */
export function createRoutedAgentPrestart(args: Args):
  (order: OrderPacket, signal?: AbortSignal) => Promise<RoutedAgentLaunch> {
  const select = createRoutedAgentSelection(args);
  return async (order, signal) => (await select(order, signal)).authorize(signal);
}
