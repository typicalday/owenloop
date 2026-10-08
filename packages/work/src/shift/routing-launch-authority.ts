/** Parent-only current machine selection check at reserve and report. */
import { isDeepStrictEqual } from 'node:util';
import type { LaunchReservationRequestV1, LocalTupleEligibility, OrderPacket,
  RoutingOfferCandidate, ShiftOffer, WorkOrder } from '../hub/types.ts';
import type { RoutedLaunchAuthority } from './routing-broker.ts';

const refused = (): Error => new Error('routed launch selection refused');

export function createRoutedLaunchAuthority(args: {
  offered: WorkOrder;
  offer?: { candidate: RoutingOfferCandidate; offer: ShiftOffer; rosterSnapshot: string };
  currentTuples: (candidate: RoutingOfferCandidate) => readonly LocalTupleEligibility[];
  currentRosterSnapshot: (candidate: RoutingOfferCandidate) => string | undefined;
}): RoutedLaunchAuthority {
  return { async verifySelection(order: OrderPacket, request: LaunchReservationRequestV1) {
    const routing = args.offered.routing;
    if (!routing || order.workflow !== args.offered.workflow || order.run !== args.offered.run
      || order.step !== args.offered.step || order.defDigest !== args.offered.defDigest
      || !isDeepStrictEqual(order.routing, routing)
      || request.orderId !== order.run || request.claimId !== routing.claim.claimId
      || request.attemptId !== routing.claim.attemptId
      || request.rosterRevision !== routing.preference.rosterRevision)
      throw refused();
    if (order.worker === 'command') {
      if (args.offer || routing.preference.offer !== null || request.candidateIds.length !== 0
	|| request.assessmentId !== null || request.requested !== null || request.selected !== null)
	throw refused();
      return;
    }
    if ((order.worker ?? 'agent') !== 'agent') throw refused();
    const offer = args.offer;
    const served = routing.preference.offer;
    if (!offer || !served || !isDeepStrictEqual(served, offer.offer)
      || offer.rosterSnapshot !== args.currentRosterSnapshot(offer.candidate)
      || served.willingness.crewIds.length !== 1
      || served.willingness.crewIds[0] !== offer.candidate.context.crewId
      || served.willingness.capabilities.length !== 1
      || served.willingness.capabilities[0] !== offer.candidate.context.capability
      || routing.preference.role !== offer.candidate.role
      || !isDeepStrictEqual(routing.preference.rolePolicy, offer.candidate.rolePolicy))
      throw refused();
    const fresh = args.currentTuples(offer.candidate);
    if (!isDeepStrictEqual(fresh, served.tuples)
      || !routing.preference.tuples.every(row => fresh.some(current => isDeepStrictEqual(current, row))))
      throw refused();
    const ids = routing.preference.tuples.filter(row => row.eligible && row.available)
      .map(row => row.tuple.id);
    if (!isDeepStrictEqual(request.candidateIds, ids) || ids.length === 0
      || request.selected === null
      || !routing.preference.tuples.some(row => row.tuple.id === request.selected!.id
	&& isDeepStrictEqual(row.tuple, request.selected))) throw refused();
  } };
}
