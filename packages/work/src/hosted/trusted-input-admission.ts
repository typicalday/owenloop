/** One worker's opt-in Service v2 observation, bound to its private held order
 * and the locally verified publication. No v1 fallback exists here. */
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';

import type { ConsumedVerifier } from '../consumed-verifier.ts';
import type { InstructionResolver, ResolvedHostedStep } from '../exec/instructions.ts';
import type { OrderPacket } from '../hub/types.ts';
import { bindTrustedReferenceV2 } from './trusted-input-binding.ts';
import type { TrustedInputWitness, TrustedReferenceV2Reader } from './trusted-reference-v2.ts';

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
}): { observe(privateOrder: OrderPacket): Promise<TrustedInputAdmission> } {
  const now = args.now ?? Date.now;
  const refused = (reason: string): TrustedInputAdmission => ({ ok: false, reason });
  return { async observe(privateOrder) {
    const started = now();
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
    if (!Number.isSafeInteger(finished) || finished < started || finished - started >= MAX_OBSERVATION_MS) {
      return refused('observation-expired');
    }
    return { ok: true, order: privateOrder, step,
      packetDigest: valueDigestHex(dynamic(direct)), witnessDigest: bound.witnessDigest,
      observedAt: started, expiresAt: started + MAX_OBSERVATION_MS,
      inputs: response.inputs };
  } };
}
