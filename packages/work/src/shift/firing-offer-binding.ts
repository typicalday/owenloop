import { isDeepStrictEqual } from 'node:util';
import type { FiringOfferBindingV2, RoutingOfferCandidate, ShiftOfferV2 } from '../hub/types.ts';

const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown, empty = false): value is string =>
  typeof value === 'string' && value.length <= 512 && (empty || value.length > 0);

/** Do not coerce a missing/legacy generation into native generation zero. */
export function isFiringOfferBinding(value: unknown): value is FiringOfferBindingV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!exactKeys(row, ['version','workflow','frameId','step','key','evidenceGeneration',
    'nativeClaimGeneration','consentSequence','executorKind','laneId'])
    || row.version !== 'firing-offer-binding-v2' || row.executorKind !== 'agent'
    || !['workflow','frameId','step','laneId'].every(key => text(row[key])) || !text(row.key, true)
    || !text(row.evidenceGeneration) || !Number.isSafeInteger(row.consentSequence)
    || (row.consentSequence as number) < 0) return false;
  const native = row.nativeClaimGeneration;
  if (!native || typeof native !== 'object' || Array.isArray(native)) return false;
  const epoch = native as Record<string, unknown>;
  return exactKeys(epoch, ['protocol','frameIncarnation','generation'])
    && epoch.protocol === 'native-claim-generation-v1'
    && typeof epoch.frameIncarnation === 'string' && /^fi_[0-9a-f]{24}$/.test(epoch.frameIncarnation)
    && Number.isSafeInteger(epoch.generation) && (epoch.generation as number) >= 0
    && (epoch.generation as number) < Number.MAX_SAFE_INTEGER;
}

export function candidateFiringBinding(candidate: RoutingOfferCandidate, workflow: string): FiringOfferBindingV2 | undefined {
  const binding = candidate.context?.firingBinding;
  return isFiringOfferBinding(binding) && binding.workflow === workflow
    && binding.frameId === candidate.frameId && binding.step === candidate.step && binding.key === candidate.key
    && binding.evidenceGeneration === candidate.evidenceGeneration ? binding : undefined;
}

/** This key excludes broad candidate digest churn but includes server consent. */
export function firingOfferCacheKey(binding: FiringOfferBindingV2, sessionId: string): string {
  if (!isFiringOfferBinding(binding) || !text(sessionId)) throw new Error('firing offer binding refused');
  return JSON.stringify([binding.version,binding.workflow,binding.frameId,binding.step,binding.key,
    binding.evidenceGeneration,binding.nativeClaimGeneration.protocol,binding.nativeClaimGeneration.frameIncarnation,
    binding.nativeClaimGeneration.generation,binding.consentSequence,binding.executorKind,binding.laneId,sessionId]);
}

/** Refresh only the authenticated descriptor, preserving immutable offer bytes. */
export function canRefreshOfferDescriptor(previous: RoutingOfferCandidate, current: RoutingOfferCandidate,
  offer: ShiftOfferV2, rosterSnapshot: string, currentRosterSnapshot: string): boolean {
  const binding = candidateFiringBinding(current, offer.firingBinding.workflow);
  return !!binding && isDeepStrictEqual(binding, offer.firingBinding)
    && rosterSnapshot === currentRosterSnapshot
    && previous.role === current.role && previous.localModelProtocol === current.localModelProtocol
    && isDeepStrictEqual(previous.rolePolicy, current.rolePolicy)
    && offer.orgId === current.context.orgId && offer.principalId === current.context.principalId
    && offer.sessionId === current.context.sessionId && offer.shiftId === current.context.shiftId
    && offer.rosterRevision === current.context.rosterRevision
    && offer.rolePolicyRevision === current.context.rolePolicyRevision
    && offer.willingness.runIds.length === 1 && offer.willingness.runIds[0] === current.context.runId
    && offer.willingness.crewIds.length === 1 && offer.willingness.crewIds[0] === current.context.crewId
    && offer.willingness.capabilities.length === 1 && offer.willingness.capabilities[0] === current.context.capability
    && offer.tuples.every(tuple => current.tuples.some(row => isDeepStrictEqual(row, tuple)));
}

/** Only a fresh authenticated context can retire local historical willingness.
 * This neither consumes the old offer nor alters its durable tombstone. */
export function supersedesLocalOffer(current: RoutingOfferCandidate, offer: ShiftOfferV2): boolean {
  const next=candidateFiringBinding(current,offer.firingBinding.workflow);
  const old=offer.firingBinding;
  return !!next && current.context.orgId===offer.orgId && current.context.principalId===offer.principalId
    && current.context.sessionId===offer.sessionId && current.context.shiftId===offer.shiftId
    && next.workflow===old.workflow && next.frameId===old.frameId && next.step===old.step && next.key===old.key
    && (next.evidenceGeneration!==old.evidenceGeneration
      || next.nativeClaimGeneration.frameIncarnation!==old.nativeClaimGeneration.frameIncarnation
      || next.nativeClaimGeneration.generation>old.nativeClaimGeneration.generation
      || (next.nativeClaimGeneration.generation===old.nativeClaimGeneration.generation
      && next.consentSequence>old.consentSequence));
}
