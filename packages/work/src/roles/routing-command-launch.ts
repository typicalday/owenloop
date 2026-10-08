/** Exact command launch authorization. An unknown pre-start report records the
 * worker's selected null tuple, never a claim that a shell already ran. */
import { isDeepStrictEqual } from 'node:util';
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import type { RoutingChildClient } from '../hub/routing-child-client.ts';
import { materializeRoutedCommandFiles } from '../hub/routed-command-files.ts';
import type { ContactHolder, OrderPacket } from '../hub/types.ts';

const refused = (): Error => new Error('routed command launch refused');

export function createRoutedCommandPrestart(args: {
  child: RoutingChildClient; holder: ContactHolder;
  workflow: string; run: string; now?: () => number;
  /** Shift-owned private stage parent; consumed files never enter the author workdir. */
  privateBase?: string;
  prepareFiles?: (order: OrderPacket, signal?: AbortSignal) => Promise<{ envValue: string; cleanup(): Promise<void> }>;
}): (order: OrderPacket, signal?: AbortSignal) => Promise<{ consumedFilePathsJson: string; cleanup(): Promise<void> } | void> {
  let used = false;
  const now = args.now ?? Date.now;
  return async (order, signal) => {
    if (used || signal?.aborted || order.workflow !== args.workflow || order.run !== args.run
      || order.worker !== 'command' || !order.routing) throw refused();
    // A timed-out/ambiguous reservation must never authorize a second start.
    used = true;
    const routing = order.routing;
    const claim = routing.claim;
    const deadline = Math.min(routing.preference.expiresAt, claim.binding.expiresAt);
    if (now() >= deadline || claim.orderId !== args.run
      || claim.sessionId !== claim.binding.authority.sessionId
      || claim.principalId !== claim.binding.authority.principalId
      || args.holder.shiftId !== claim.shiftId) throw refused();
    const fresh = await args.child.readRoutingClaim({ workflow: args.workflow, run: args.run });
    if (signal?.aborted || fresh.freshness !== 'fresh-at-read' || fresh.atomicLaunch !== false
      || !isDeepStrictEqual(fresh.routing, routing) || now() >= deadline) throw refused();
    const prepare = args.prepareFiles ?? (args.privateBase === undefined ? undefined
      : (current: OrderPacket, active?: AbortSignal) => materializeRoutedCommandFiles({ order: current,
	holder: args.holder, child: args.child, privateBase: args.privateBase!, signal: active }));
    if (!prepare) throw refused();
    const prepared = await prepare(order, signal);
    try {
      if (signal?.aborted || now() >= deadline) throw refused();
      const request = { version: 'launch-reservation-v1' as const,
      claimId: claim.claimId, decisionId: claim.decisionId, binding: claim.binding,
      orderId: claim.orderId, attemptId: claim.attemptId,
      rosterRevision: routing.preference.rosterRevision,
      candidateIds: [], assessmentId: null, requested: null, selected: null };
      const reservation = await args.child.reserveLaunch({ workflow: args.workflow, request });
      if (signal?.aborted || reservation.orderId !== args.run || !reservation.reservationId
      || !Number.isSafeInteger(reservation.expiresAt) || reservation.expiresAt <= now()
      || reservation.expiresAt > deadline) throw refused();
      const report = { version: 'launch-v1' as const,
      reservationId: reservation.reservationId,
      decisionId: claim.decisionId, binding: claim.binding, claimId: claim.claimId,
      orderId: claim.orderId, attemptId: claim.attemptId,
      requested: null, selected: null, observation: { state: 'unknown' as const } };
      const accepted = await args.child.reportLaunch({ workflow: args.workflow, report });
      if (signal?.aborted || accepted.orderId !== args.run || accepted.provenance !== 'authenticated-worker-report'
      || accepted.digest !== valueDigestHex(report)
      || !Number.isSafeInteger(accepted.recordedAt) || now() >= reservation.expiresAt)
      throw refused();
      // Every asynchronous boundary can move claim/session/roster authority.
      // The broker itself revalidates parent signed source on this final GET.
      const final = await args.child.getLaunchOrder({ workflow: args.workflow, run: args.run,
      holder: args.holder });
      if (signal?.aborted || !final.lease.claimed || !final.order
      || !isDeepStrictEqual(final.order, order) || now() >= reservation.expiresAt)
      throw refused();
      return { consumedFilePathsJson: prepared.envValue, cleanup: prepared.cleanup };
    } catch (error) {
      await prepared.cleanup().catch(() => {});
      throw error;
    }
  };
}
