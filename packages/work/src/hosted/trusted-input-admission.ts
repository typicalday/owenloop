/** One worker's opt-in Service v2 observation, bound to its private held order
 * and the locally verified publication. No v1 fallback exists here. */
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';

import type { ConsumedVerifier } from '../consumed-verifier.ts';
import type { InstructionResolver, ResolvedHostedStep } from '../exec/instructions.ts';
import type { OrderPacket } from '../hub/types.ts';
import { bindTrustedReferenceV2 } from './trusted-input-binding.ts';
import type { TrustedInputWitness, TrustedReferenceV2Reader } from './trusted-reference-v2.ts';
import { parseRoutedClaimV2, parseRoutedReferenceV2, type RoutedClaimV2,
  type RoutedReferenceV2, type RoutedReferenceV2Reader } from './trusted-routed-reference-v2.ts';
import { parseRecordedClaimV2, parseRecordedReferenceV2, type RecordedClaimV2,
  type RecordedReferenceV2 } from './trusted-routed-recorded-v2.ts';

const MAX_OBSERVATION_MS = 5_000;
const CLAIM_FACING_FIELDS = ['capabilities', 'crews', 'reroutedFrom', 'modifier', 'escalated',
  'model', 'worker', 'judge', 'spec', 'x'] as const;
const equal = (left: unknown, right: unknown): boolean => {
  try { return valueDigestHex(left) === valueDigestHex(right); }
  catch { return false; }
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Ordinary get_order can carry advisory human provideProof. Only producer
 * proof entries are authority; Service v2 deliberately omits the advisory. */
function producerProofView(order: OrderPacket, declared: ReadonlySet<string>): unknown {
  let proofs: unknown = {};
  if (order.consumesProof !== undefined) {
    try { proofs = JSON.parse(order.consumesProof) as unknown; }
    catch { return undefined; }
  }
  if (!record(proofs)) return undefined;
  const relay = order.consumesProofRelay ?? {};
  if (!record(relay)) return undefined;
  return {
    proofs: Object.fromEntries(Object.entries(proofs).filter(([path]) => !declared.has(path))),
    relay: Object.fromEntries(Object.entries(relay).filter(([path]) => !declared.has(path))),
  };
}

export type TrustedInputAdmission = {
  ok: true;
  order: OrderPacket;
  step: ResolvedHostedStep;
  packetDigest: string;
  witnessDigest: string;
  observedAt: number;
  expiresAt: number;
  inputs: TrustedInputWitness[];
} | { ok: false; reason: string };

export function createTrustedInputV2Admission(args: {
  reader: TrustedReferenceV2Reader;
  instructions: InstructionResolver;
  consumedVerifier: ConsumedVerifier;
  expected: { workflow: string; run: string };
  now?: () => number;
  /** An elapsed clock; routed callers use monotonic time across remote awaits. */
  elapsedNow?: () => number;
}): { observe(privateOrder: OrderPacket): Promise<TrustedInputAdmission> } {
  const now = args.now ?? Date.now;
  const elapsedNow = args.elapsedNow ?? now;
  const refused = (reason: string): TrustedInputAdmission => ({ ok: false, reason });
  return { async observe(privateOrder) {
    const started = now();
    const startedElapsed = elapsedNow();
    if (!Number.isSafeInteger(started) || privateOrder.workflow !== args.expected.workflow
      || privateOrder.run !== args.expected.run) return refused('private-order-out-of-scope');
    let response: Awaited<ReturnType<TrustedReferenceV2Reader['read']>>;
    try { response = await args.reader.read(); }
    catch { return refused('reference-v2-unavailable'); }
    if (response.state !== 'available') return refused(`service-${response.state}`);
    const direct = response.order;
    const dynamic = (order: OrderPacket) => ({
      workflow: order.workflow, run: order.run, step: order.step, key: order.key,
      index: order.index ?? null, defDigest: order.defDigest,
      inputs: order.inputs, outputs: order.outputs, consumes: order.consumes,
      consumedFingerprint: order.consumedFingerprint ?? null, workdir: order.workdir ?? null,
      cause: order.cause ?? null,
      offer: Object.fromEntries(CLAIM_FACING_FIELDS.filter(field => Object.hasOwn(order, field))
	.map(field => [field, (order as unknown as Record<string, unknown>)[field]])),
      owes: order.owes.map(owed => ({ path: owed.path, version: owed.version ?? null })),
    });
    if (!equal(dynamic(privateOrder), dynamic(direct))
      || privateOrder.owes.some(owed => owed.reasons.length !== 0 || owed.judgmentRejects !== 0
	|| owed.schemaRejects !== 0 || owed.proof !== undefined || owed.previousValue !== undefined)) {
      return refused('private-order-v2-mismatch');
    }
    // Still refuse private fields outside the exact v2 projection. Routing is
    // separately fenced by Service v2 until its own signed protocol is ready.
    if (['routing'].some(field => Object.hasOwn(privateOrder, field))) {
      return refused('private-order-unwitnessed-field');
    }
    if (!args.instructions.resolveHostedStep) return refused('local-definition-verifier-unavailable');
    let step: Awaited<ReturnType<NonNullable<InstructionResolver['resolveHostedStep']>>>;
    try { step = await args.instructions.resolveHostedStep(direct); }
    catch { return refused('local-definition-verifier-unavailable'); }
    if (!step.ok) return refused(`local-definition-${step.kind}`);
    const local = step.step;
    if (!equal(privateOrder.model ?? null, local.model ?? null)
      || !equal(privateOrder.judge ?? null, local.judges ?? null)
      || !equal(privateOrder.spec ?? null, local.spec ?? null)
      || !equal(privateOrder.x ?? null, local.x ?? null)
      || (privateOrder.modifier !== undefined && !step.allowedModifiers?.includes(privateOrder.modifier))
      || (privateOrder.escalated === true && local.escalation?.modifier !== privateOrder.modifier)
      || ((local.capabilities?.length ?? 0) > 0 && (!privateOrder.capabilities?.length || !privateOrder.crews?.length))
      || ((local.capabilities?.length ?? 0) === 0 && (privateOrder.capabilities?.length ?? 0) > 0)) {
      return refused('local-offer-structure-mismatch');
    }
    const declared = new Set(step.declaredInputs.map(input => input.name));
    const privateProof = producerProofView(privateOrder, declared);
    const directProof = producerProofView(direct, declared);
    if (privateProof === undefined || directProof === undefined || !equal(privateProof, directProof)) {
      return refused('private-order-producer-proof-mismatch');
    }
    if ((step.step.executor === 'command' ? privateOrder.worker !== 'command'
      : privateOrder.worker !== undefined && privateOrder.worker !== 'agent')) {
      return refused('private-order-worker-mismatch');
    }
    const bound = await bindTrustedReferenceV2({ response,
      expected: { ...args.expected, defDigest: direct.defDigest, step: privateOrder.step, key: privateOrder.key },
      step: step.step, declaredInputs: step.declaredInputs,
      consumedVerifier: args.consumedVerifier, callsProducers: step.callsProducers });
    if (!bound.ok) return refused(bound.reason);
    const finished = now();
    const finishedElapsed = elapsedNow();
    const elapsed = finishedElapsed - startedElapsed;
    if (!Number.isSafeInteger(finished) || finished < started
      || !Number.isFinite(startedElapsed) || !Number.isFinite(finishedElapsed)
      || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= MAX_OBSERVATION_MS) {
      return refused('observation-expired');
    }
    return { ok: true, order: privateOrder, step,
      packetDigest: valueDigestHex(dynamic(direct)), witnessDigest: bound.witnessDigest,
      observedAt: started, expiresAt: started + MAX_OBSERVATION_MS,
      inputs: response.inputs };
  } };
}

/** Phase is chosen by the parent operation. It is never sent to Service or
 * accepted in a child/holder broker frame. Recorded does not authorize a
 * first external start even when an unknown report was accepted. */
export type RoutedInputPhase = 'prestart' | 'recorded-live';
export type RoutedInputPair =
  | { reference: RoutedReferenceV2; claim: RoutedClaimV2 }
  | { reference: RecordedReferenceV2; claim: RecordedClaimV2 };
export type RoutedInputAdmission = (Extract<TrustedInputAdmission, { ok: true }> & {
  phase: RoutedInputPhase; bindingDigest: string; occurrenceDigest?: string;
}) | Extract<TrustedInputAdmission, { ok: false }>;

/** Bind one exact private packet to a parent-observed Service pair and a
 * locally verified signed step. Both roles and Shift use this same gate. */
export async function bindTrustedRoutedInputV2(args: {
  phase: RoutedInputPhase; pair: RoutedInputPair; privateOrder: OrderPacket;
  instructions: InstructionResolver; consumedVerifier: ConsumedVerifier;
  expected: { workflow: string; run: string };
  now?: () => number; monotonicNow?: () => number;
  startedAt?: number; startedMonotonic?: number;
}): Promise<RoutedInputAdmission> {
  const now = args.now ?? Date.now;
  const monotonicNow = args.monotonicNow ?? (() => performance.now());
  const started = args.startedAt ?? now();
  const startedMonotonic = args.startedMonotonic ?? monotonicNow();
  const refused = (reason: string): RoutedInputAdmission => ({ ok: false, reason });
  const privateOrder = args.privateOrder;
  if (!Number.isSafeInteger(started) || !Number.isFinite(startedMonotonic)
    || privateOrder.run !== args.expected.run || !privateOrder.routing)
    return refused('routed-private-order-out-of-scope');
  let reference: RoutedReferenceV2 | RecordedReferenceV2;
  let claim: RoutedClaimV2 | RecordedClaimV2;
  try {
    reference = args.phase === 'prestart'
      ? parseRoutedReferenceV2(args.pair.reference, args.expected)
      : parseRecordedReferenceV2(args.pair.reference, args.expected);
    claim = args.phase === 'prestart'
      ? parseRoutedClaimV2(args.pair.claim, args.expected)
      : parseRecordedClaimV2(args.pair.claim, args.expected);
  } catch { return refused('routed-reference-v2-malformed'); }
  if (reference.state !== 'available') return refused(`service-${reference.state}`);
  if (claim.state !== 'available') return refused('routed-claim-unavailable');
  if (reference.order.workflow !== privateOrder.workflow
    || reference.binding.frameWorkflow !== privateOrder.workflow
    || !equal(reference.binding, claim.binding)
    || !equal(reference.order.routing, claim.routing)
    || !equal(privateOrder.routing, claim.routing)
    || (args.phase === 'prestart' && reference.binding.preferenceExpiresAt <= now())
    || (args.phase === 'recorded-live'
      && (!('recordedOccurrence' in reference.binding)
	|| !('recordedOccurrence' in claim.binding))))
    return refused('routed-binding-changed');
  // The ordinary signed gate proves optional/human presence and value,
  // producer chains, local offer fields and dotted input-derived workdir.
  // Remove only the separately bound routing field.
  const { routing: _privateRouting, ...privateUnrouted } = privateOrder;
  const { routing: _directRouting, ...directUnrouted } = reference.order;
  const frame = reference.binding.frameWorkflow;
  // The ordinary structural binder sees no routing field. Only its local
  // signed-definition verifier receives the already-bound Service routing,
  // which selects the exact member of a multi-definition bundle.
  const routedInstructions: InstructionResolver = {
    ...args.instructions,
    ...(args.instructions.resolveHostedStep ? { resolveHostedStep: (order: OrderPacket) =>
      args.instructions.resolveHostedStep!({ ...order, routing: reference.order.routing }) } : {}),
  };
  const ordinary = createTrustedInputV2Admission({
    reader: { read: async () => ({
      protocol: 'trusted-reference-read-v2', state: 'available', workflow: frame,
      run: args.expected.run, order: directUnrouted, inputs: reference.inputs,
      ...(reference.workdirInput === undefined ? {} : { workdirInput: reference.workdirInput }),
      lease: { claimed: true },
    }) },
    instructions: routedInstructions,
    consumedVerifier: (order, opts) => args.consumedVerifier({ ...order,
      routing: reference.order.routing }, opts),
    expected: { workflow: frame, run: args.expected.run }, now, elapsedNow: monotonicNow,
  });
  const local = await ordinary.observe(privateUnrouted);
  if (!local.ok) return local;
  const finished = now();
  const finishedMonotonic = monotonicNow();
  const elapsed = finishedMonotonic - startedMonotonic;
  if (!Number.isSafeInteger(finished) || finished < started
    || !Number.isFinite(finishedMonotonic) || !Number.isFinite(elapsed)
    || elapsed < 0 || elapsed >= MAX_OBSERVATION_MS
    || (args.phase === 'prestart' && reference.binding.preferenceExpiresAt <= finished))
    return refused('routed-observation-expired');
  const occurrenceDigest = 'recordedOccurrence' in reference.binding
    ? valueDigestHex(reference.binding.recordedOccurrence) : undefined;
  return { ...local, phase: args.phase, order: privateOrder, observedAt: started,
    expiresAt: args.phase === 'prestart'
      ? Math.min(started + MAX_OBSERVATION_MS, reference.binding.preferenceExpiresAt)
      : started + MAX_OBSERVATION_MS,
    bindingDigest: valueDigestHex(reference.binding),
    ...(occurrenceDigest ? { occurrenceDigest } : {}),
    packetDigest: valueDigestHex({ packet: local.packetDigest, binding: reference.binding,
      routing: reference.order.routing }),
  };
}

export function createTrustedRoutedInputV2Admission(args: {
  reader: Pick<RoutedReferenceV2Reader, 'read'>;
  instructions: InstructionResolver; consumedVerifier: ConsumedVerifier;
  expected: { workflow: string; run: string };
  now?: () => number; monotonicNow?: () => number;
}): { observe(privateOrder: OrderPacket): Promise<RoutedInputAdmission> } {
  const now = args.now ?? Date.now;
  const monotonicNow = args.monotonicNow ?? (() => performance.now());
  return { async observe(privateOrder) {
    const startedAt = now(), startedMonotonic = monotonicNow();
    let pair: Awaited<ReturnType<RoutedReferenceV2Reader['read']>>;
    try { pair = await args.reader.read(); }
    catch { return { ok: false, reason: 'routed-reference-v2-unavailable' }; }
    return bindTrustedRoutedInputV2({ ...args, phase: 'prestart', pair, privateOrder,
      startedAt, startedMonotonic });
  } };
}

export function createTrustedRecordedRoutedInputV2Admission(args: {
  reader: { read(): Promise<{ reference: RecordedReferenceV2; claim: RecordedClaimV2 }> };
  instructions: InstructionResolver; consumedVerifier: ConsumedVerifier;
  expected: { workflow: string; run: string };
  now?: () => number; monotonicNow?: () => number;
}): { observe(privateOrder: OrderPacket): Promise<RoutedInputAdmission> } {
  const now = args.now ?? Date.now;
  const monotonicNow = args.monotonicNow ?? (() => performance.now());
  return { async observe(privateOrder) {
    const startedAt = now(), startedMonotonic = monotonicNow();
    let pair: { reference: RecordedReferenceV2; claim: RecordedClaimV2 };
    try { pair = await args.reader.read(); }
    catch { return { ok: false, reason: 'routed-recorded-reference-unavailable' }; }
    return bindTrustedRoutedInputV2({ ...args, phase: 'recorded-live', pair, privateOrder,
      startedAt, startedMonotonic });
  } };
}
