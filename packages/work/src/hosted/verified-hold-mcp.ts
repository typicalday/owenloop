/**
 * Opt-in boundary for a workflow/run-bound hosted MCP mount. The service
 * observation establishes an active claim, not this process's holder identity.
 * Submit is separately opted into and uses only the versioned conditional
 * service route; other mutations are never advertised here.
 */
import { randomUUID } from 'node:crypto';

import { textResult, type ToolCallContext, type ToolRegistration, type ToolResult } from '../mcp/server.ts';
import type { HoldMcpMount } from '../hold/mcp.ts';
import { HubError, type ConditionalSubmitRequest, type ConditionalSubmitResponse, type ContactHolder, type GetOrderResponse, type OrderPacket } from '../hub/types.ts';
import { hostedPacketDigest, hostedReferencePacketDigest, hostedReferenceStableDigest, hostedReferenceV2Digest, type HostedOrderProjection, type HostedOrderResult, type HostedVerifiedPacket } from './order-adapter.ts';

type Adapter = {
  readonly referenceProtocol?: 'trusted-reference-read-v2';
  open(preflight: unknown, index?: number, onVerified?: (packet: HostedVerifiedPacket) => void): Promise<HostedOrderResult>;
  submitConditional?: (req: ConditionalSubmitRequest) => Promise<ConditionalSubmitResponse>;
};
type BoundOrder = { workflow: string; run: string };
type SignProof = (order: OrderPacket, path: string, value: Record<string, unknown>, version: number, signal?: AbortSignal) => Promise<string | undefined>;
type SubmitOptions = { enableSubmit?: boolean; signProof?: SignProof; holder?: ContactHolder; now?: () => number; monotonicNow?: () => number };
const RAW_ORDER_FIELDS = new Set([
  'workflow', 'run', 'step', 'key', 'index', 'defDigest', 'inputs', 'outputs',
  'consumes', 'consumedFingerprint', 'consumesProof', 'consumesProofRelay', 'owes',
  'spec', 'x', 'worker', 'workdir', 'capabilities', 'crews', 'modifier',
  'reroutedFrom', 'escalated', 'model', 'judge', 'cause', 'routing',
]);
const RAW_OWED_FIELDS = new Set([
  'path', 'version', 'judgmentRejects', 'schemaRejects', 'reasons',
  'previousValue', 'schema', 'schemaAppliesTo', 'proof',
]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function refusal(code: string): ToolResult {
  return textResult({ protocol: 'local-hosted-order-v1', state: 'refused', code }, true);
}

function privatePreflight(result: ToolResult, gated: GetOrderResponse | undefined, bound: BoundOrder, v2: boolean): { ref: unknown; fullDigest: string; stableFullDigest: string; referenceDigest: string; stableDigest: string; order: OrderPacket } | undefined {
  if (result.isError || result.content.length !== 1) return undefined;
  let view: unknown;
  try {
    view = JSON.parse(result.content[0]!.text);
  } catch {
    return undefined;
  }
  const packet = record(view);
  const visible = record(packet?.order);
  const order = record(gated?.order);
  // A parent-bound private read may resolve to a canonical child. Only the
  // independent v2 observation can authorize it; the hint never retargets the
  // adapter's root/run-bound service requests.
  const canonicalWorkflow = v2 ? gated?.workflow : bound.workflow;
  if (typeof canonicalWorkflow !== 'string' || canonicalWorkflow.length === 0
    || packet?.workflow !== canonicalWorkflow || packet?.run !== bound.run
    || visible?.workflow !== canonicalWorkflow || visible?.run !== bound.run
    || gated?.workflow !== canonicalWorkflow || gated.run !== bound.run
    || order?.workflow !== canonicalWorkflow || order?.run !== bound.run
    || visible.step !== order.step || visible.key !== order.key || visible.defDigest !== order.defDigest
    || typeof order.defDigest !== 'string') return undefined;
  if (Object.keys(order).some((field) => !RAW_ORDER_FIELDS.has(field))
    || !Array.isArray(order.owes)
    || order.owes.some((entry: unknown) => {
      const owed = record(entry);
      return !owed || Object.keys(owed).some((field) => !RAW_OWED_FIELDS.has(field));
    })) return undefined;
  // v1 does not attest these execution fields. v2's exact independent read
  // binds them too; routing and unsupported feedback still refuse in both.
  if ((!v2 && (Object.hasOwn(order, 'modifier') || Object.hasOwn(order, 'cause')
    || Object.hasOwn(order, 'routing') || Object.hasOwn(order, 'workdir')
    || Object.hasOwn(order, 'capabilities') || Object.hasOwn(order, 'crews')
    || Object.hasOwn(order, 'reroutedFrom') || Object.hasOwn(order, 'escalated')
    || Object.hasOwn(order, 'model') || Object.hasOwn(order, 'judge')))
    || Object.hasOwn(order, 'routing')
    || (Object.hasOwn(order, 'worker') && order.worker !== 'agent')
    || order.owes.some((entry: unknown) => {
      const owed = record(entry);
      return !owed || !Array.isArray(owed.reasons) || owed.reasons.length !== 0
	|| owed.judgmentRejects !== 0 || owed.schemaRejects !== 0
	|| Object.hasOwn(owed, 'previousValue') || Object.hasOwn(owed, 'proof');
    })) return undefined;
  const fullDigest = hostedPacketDigest(order);
  const stableFullDigest = hostedPacketDigest({ ...order,
    owes: order.owes.map((owed: Record<string, unknown>) => Object.fromEntries(Object.entries(owed).filter(([field]) => field !== 'version'))) });
  const referenceDigest = hostedReferencePacketDigest(order);
  const stableDigest = hostedReferenceStableDigest(order);
  if (fullDigest === undefined || stableFullDigest === undefined || referenceDigest === undefined || stableDigest === undefined) return undefined;
  return { fullDigest, stableFullDigest, referenceDigest, stableDigest, order: order as unknown as OrderPacket, ref: {
    protocol: 'client-preflight-v1', verification: 'not-performed',
    order: { state: 'available', workflow: bound.workflow, run: bound.run, defDigest: order.defDigest },
  } };
}

export function createVerifiedHostedHoldMcp(
  mount: HoldMcpMount,
  adapter: Adapter,
  bound: BoundOrder,
  options: SubmitOptions = {},
): HoldMcpMount {
  const rawGet = mount.tools.find((tool) => tool.name === 'get_order');
  if (rawGet === undefined) throw new Error('verified hosted holder requires get_order in its private tool set');
  if (options.enableSubmit && (adapter.submitConditional === undefined || options.signProof === undefined)) {
    throw new Error('verified hosted submit requires a conditional transport and proof signer');
  }
  let anchoredRef: unknown;
  let anchoredHoldDigest: string | undefined;
  let anchoredWitnessDigest: string | undefined;
  const v2 = adapter.referenceProtocol === 'trusted-reference-read-v2';
  // A lost response may hide a committed partial submit. Internal verification
  // cannot tell the model that its last value may already have been accepted.
  let reconciliationRequired = false;
  let reconciliationEpoch = 0;
  let reconciliationToken: string | undefined;
  let reconciliationDigest: string | undefined;
  let submitInFlight = false;
  // A later failed independent observation fences requests still awaiting an
  // older observation or signature. Cancellation remains request-scoped.
  let observationRevision = 0;
  function observationGuard(revision: number, ctx: Parameters<ToolRegistration['handler']>[1]): ToolResult | undefined {
    if (ctx.cancelled) return refusal('call-cancelled');
    return revision === observationRevision ? undefined : refusal('observation-superseded');
  }
  function invalidateObservation(revision: number): void {
    if (revision === observationRevision) observationRevision++;
  }
  function refuseObservation(code: string, revision: number): ToolResult {
    invalidateObservation(revision);
    return refusal(code);
  }
  function requireReconciliation(): void {
    reconciliationRequired = true;
    reconciliationEpoch++;
    reconciliationToken = undefined;
    reconciliationDigest = undefined;
  }
  async function livePrivateOrder(ctx: Parameters<ToolRegistration['handler']>[1]): Promise<ReturnType<typeof privatePreflight>> {
    try {
      if (!v2 && anchoredRef !== undefined && mount.readGatedOrder() === undefined) return undefined;
      const result = await rawGet!.handler({}, ctx);
      return privatePreflight(result, mount.readGatedResult ? mount.readGatedResult(result) : mount.readGatedOrder(), bound, v2);
    } catch {
      return undefined;
    }
  }
  function observationCurrent(projection: HostedOrderProjection, startedAt: number): ToolResult | undefined {
    let sampledAt: number;
    let elapsed: number;
    try {
      sampledAt = (options.now ?? Date.now)();
      elapsed = (options.monotonicNow ?? (() => performance.now()))() - startedAt;
    } catch {
      return refusal('clock-unavailable');
    }
    const { observedAt, expiresAt } = projection.serviceObservation;
    if (!Number.isFinite(elapsed) || elapsed < 0) return refusal('clock-unavailable');
    if (!Number.isSafeInteger(sampledAt) || sampledAt < observedAt || sampledAt >= expiresAt
      || elapsed >= expiresAt - observedAt) {
      return refusal('claim-observation-expired');
    }
    return undefined;
  }
  async function observeVerified(revision: number, ctx: Parameters<ToolRegistration['handler']>[1]): Promise<
    | { ok: true; projection: HostedOrderProjection; fullDigest: string; startedAt: number; packet?: HostedVerifiedPacket }
    | { ok: false; result: ToolResult }
  > {
    const initialGuard = observationGuard(revision, ctx);
    if (initialGuard !== undefined) return { ok: false, result: initialGuard };
    let ref = anchoredRef;
    const firstObservation = ref === undefined;
    let initialFullDigest: string;
    let initialStableFullDigest: string;
    let initialReferenceDigest: string;
    let initialStableDigest: string;
    let initialOrder: OrderPacket;
    if (ref === undefined) {
      const privateOrder = await livePrivateOrder(ctx);
      const afterPrivate = observationGuard(revision, ctx);
      if (afterPrivate !== undefined) return { ok: false, result: afterPrivate };
      if (privateOrder === undefined) return { ok: false, result: refusal('holder-order-unavailable') };
      ref = privateOrder.ref;
      initialFullDigest = privateOrder.fullDigest;
      initialStableFullDigest = privateOrder.stableFullDigest;
      initialReferenceDigest = privateOrder.referenceDigest;
      initialStableDigest = privateOrder.stableDigest;
      initialOrder = privateOrder.order;
    } else {
      const privateOrder = await livePrivateOrder(ctx);
      const afterPrivate = observationGuard(revision, ctx);
      if (afterPrivate !== undefined) return { ok: false, result: afterPrivate };
      if (privateOrder === undefined) return { ok: false, result: refusal('holder-order-unavailable') };
      if ((v2 ? privateOrder.stableFullDigest : privateOrder.fullDigest) !== anchoredHoldDigest) return { ok: false, result: refusal('holder-order-changed') };
      initialFullDigest = privateOrder.fullDigest;
      initialStableFullDigest = privateOrder.stableFullDigest;
      initialReferenceDigest = privateOrder.referenceDigest;
      initialStableDigest = privateOrder.stableDigest;
      initialOrder = privateOrder.order;
    }
    let startedAt: number;
    try {
      startedAt = (options.monotonicNow ?? (() => performance.now()))();
    } catch {
      return { ok: false, result: refusal('clock-unavailable') };
    }
    if (!Number.isFinite(startedAt)) return { ok: false, result: refusal('clock-unavailable') };
    let verified: HostedOrderResult;
    let verifiedPacket: HostedVerifiedPacket | undefined;
    try {
      verified = await adapter.open(ref, 0, (packet) => { verifiedPacket = packet; });
    } catch {
      return { ok: false, result: refusal('verification-unavailable') };
    }
    const afterVerification = observationGuard(revision, ctx);
    if (afterVerification !== undefined) return { ok: false, result: afterVerification };
    if (verified.state !== 'ready') {
      return { ok: false, result: refusal(verified.state === 'refused' ? verified.code : 'order-unavailable') };
    }
    if (verifiedPacket === undefined) return { ok: false, result: refusal('verified-packet-unavailable') };
    const declared = verifiedPacket.declaredInputPaths;
    if (v2 && (verified.serviceObservation.referenceProtocol !== 'trusted-reference-read-v2'
      || declared === undefined || typeof verified.serviceObservation.inputWitnessDigest !== 'string')) {
      return { ok: false, result: refusal('reference-v2-required') };
    }
    if (firstObservation && verified.serviceObservation.packetDigest !== (v2
      ? hostedReferenceV2Digest(initialOrder, declared!) : initialReferenceDigest)) {
      return { ok: false, result: refusal('holder-order-changed') };
    }
    if ((v2 ? hostedReferenceV2Digest(verifiedPacket.order, declared!) : hostedReferencePacketDigest(verifiedPacket.order)) !== verified.serviceObservation.packetDigest) {
      return { ok: false, result: refusal('verified-packet-mismatch') };
    }
    if ((v2 ? hostedReferenceV2Digest(verifiedPacket.order, declared!, true) : hostedReferenceStableDigest(verifiedPacket.order)) !== (v2
      ? hostedReferenceV2Digest(initialOrder, declared!, true) : initialStableDigest)) {
      return { ok: false, result: refusal('holder-order-changed') };
    }
    if (v2 && anchoredWitnessDigest !== undefined && anchoredWitnessDigest !== verified.serviceObservation.inputWitnessDigest) {
      return { ok: false, result: refusal('holder-order-changed') };
    }
    // A direct service observation cannot attest that this local process kept
    // the hold while verification was pending. The raw mount must still gate it.
    const current = await livePrivateOrder(ctx);
    const afterCurrent = observationGuard(revision, ctx);
    if (afterCurrent !== undefined) return { ok: false, result: afterCurrent };
    if (current === undefined) return { ok: false, result: refusal('holder-order-unavailable') };
    if (current.fullDigest !== initialFullDigest || current.referenceDigest !== initialReferenceDigest
      || current.stableDigest !== initialStableDigest) {
      return { ok: false, result: refusal('holder-order-changed') };
    }
    const stale = observationCurrent(verified, startedAt);
    if (stale !== undefined) return { ok: false, result: stale };
    anchoredRef = ref;
    anchoredHoldDigest = v2 ? initialStableFullDigest : initialFullDigest;
    if (v2) anchoredWitnessDigest = verified.serviceObservation.inputWitnessDigest;
    return { ok: true, projection: verified, fullDigest: initialFullDigest, startedAt,
      ...(verifiedPacket === undefined ? {} : { packet: verifiedPacket }) };
  }
  async function readWithDeadline<T extends { ok: boolean }>(
    revision: number,
    ctx: ToolCallContext,
    read: (scopedContext: ToolCallContext) => Promise<T>,
  ): Promise<T | { ok: false; result: ToolResult }> {
    const initial = observationGuard(revision, ctx);
    if (initial !== undefined) return { ok: false, result: initial };
    // Apply the same observation budget to complete verification and the last
    // pre-write private read. Late results see cancellation before they can
    // pin, expose an order, or authorize a conditional write.
    let wallStartedAt: number;
    let monotonicStartedAt: number;
    try {
      wallStartedAt = (options.now ?? Date.now)();
      monotonicStartedAt = (options.monotonicNow ?? (() => performance.now()))();
    } catch {
      return { ok: false, result: refuseObservation('clock-unavailable', revision) };
    }
    if (!Number.isSafeInteger(wallStartedAt) || wallStartedAt < 0 || !Number.isFinite(monotonicStartedAt)) {
      return { ok: false, result: refuseObservation('clock-unavailable', revision) };
    }
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const localCancellations = new Set<() => void>();
    const scopedContext = { ...ctx,
      get cancelled() { return expired || ctx.cancelled; },
      onCancel(callback: () => void) {
	if (expired) callback();
	else {
	  localCancellations.add(callback);
	  ctx.onCancel(callback);
	}
      },
    };
    const deadline = new Promise<{ ok: false; result: ToolResult }>((resolve) => {
      timer = setTimeout(() => {
	expired = true;
	for (const cancel of localCancellations) { try { cancel(); } catch { /* Cancellation cannot prevent refusal. */ } }
	if (!ctx.cancelled) invalidateObservation(revision);
	resolve({ ok: false, result: refusal(ctx.cancelled ? 'call-cancelled' : 'claim-observation-expired') });
      }, 5_000);
    });
    try {
      const checked = await Promise.race([read(scopedContext), deadline]);
      if (expired) return checked;
      const stale = observationGuard(revision, ctx);
      if (stale !== undefined) return { ok: false, result: stale };
      // Timer callbacks can run late if synchronous local work blocked the
      // event loop. Include the initial private read in both elapsed budgets.
      let wallElapsed: number;
      let monotonicElapsed: number;
      try {
	wallElapsed = (options.now ?? Date.now)() - wallStartedAt;
	monotonicElapsed = (options.monotonicNow ?? (() => performance.now()))() - monotonicStartedAt;
      } catch {
	return { ok: false, result: refuseObservation('clock-unavailable', revision) };
      }
      if (!Number.isSafeInteger(wallElapsed) || wallElapsed < 0
	|| !Number.isFinite(monotonicElapsed) || monotonicElapsed < 0) {
	return { ok: false, result: refuseObservation('clock-unavailable', revision) };
      }
      if (wallElapsed >= 5_000 || monotonicElapsed >= 5_000) {
	return { ok: false, result: refuseObservation('claim-observation-expired', revision) };
      }
      if (!checked.ok) invalidateObservation(revision);
      return checked;
    } finally {
      clearTimeout(timer);
      localCancellations.clear();
    }
  }
  async function readVerified(revision: number, ctx: ToolCallContext): ReturnType<typeof observeVerified> {
    return readWithDeadline(revision, ctx, scopedContext => observeVerified(revision, scopedContext));
  }
  const orderTool: ToolRegistration = {
    name: 'get_order',
    description: 'Return the locally verified hosted order projection for this bound workflow/run.',
    inputSchema: rawGet.inputSchema,
    handler: async (_args, ctx) => {
      const revision = observationRevision;
      const reconciling = reconciliationRequired;
      const startedEpoch = reconciliationEpoch;
      const checked = await readVerified(revision, ctx);
      if (!checked.ok) return checked.result;
      const beforeExposure = observationGuard(revision, ctx);
      if (beforeExposure !== undefined) return beforeExposure;
      if (reconciliationRequired && (!reconciling || startedEpoch !== reconciliationEpoch)) {
	return refusal('reconciliation-superseded');
      }
      if (!reconciling) return textResult(checked.projection);
      if (!reconciliationRequired) return refusal('reconciliation-superseded');
      // The token must be copied from this model-facing result into the next
      // submit. A lost get_order response cannot silently clear the latch.
      let token: string;
      try {
	token = randomUUID();
      } catch {
	return refusal('reconciliation-unavailable');
      }
      const result = textResult({ ...checked.projection, reconciliation: { submitToken: token } });
      reconciliationToken = token;
      reconciliationDigest = checked.projection.serviceObservation.packetDigest;
      return result;
    },
  };
  if (!options.enableSubmit) return { loop: mount.loop, tools: [orderTool], readGatedOrder: mount.readGatedOrder };
  const submitTool: ToolRegistration = {
    name: 'submit',
    description: 'Submit one object receipt for a currently verified owed path using the service conditional-v1 protocol. Re-verifies the order before every submit.',
    inputSchema: {
      type: 'object', required: ['path', 'value'], additionalProperties: false,
      properties: {
	path: { type: 'string' }, value: { type: 'object' }, done: { type: 'boolean' },
	reconciliationToken: { type: 'string' },
      },
    },
    handler: async (args, ctx) => {
      const revision = observationRevision;
      const initialGuard = observationGuard(revision, ctx);
      if (initialGuard !== undefined) return initialGuard;
      const path = args['path'];
      const value = args['value'];
      const done = args['done'];
      const suppliedToken = args['reconciliationToken'];
      if (typeof path !== 'string' || path === '' || record(value) === undefined
	|| (done !== undefined && typeof done !== 'boolean')
	|| (suppliedToken !== undefined && typeof suppliedToken !== 'string')) return refusal('submit-input-invalid');
      if (reconciliationRequired && (reconciliationToken === undefined || suppliedToken !== reconciliationToken)) {
	return refusal('submit-reconciliation-required');
      }
      if (submitInFlight) return refusal('submit-in-progress');
      const reconciling = reconciliationRequired;
      const submitEpoch = reconciliationEpoch;
      const submittedToken = reconciliationToken;
      const visibleDigest = reconciliationDigest;
      submitInFlight = true;
      try {
	const checked = await readVerified(revision, ctx);
	if (!checked.ok) return checked.result;
	const beforeSigning = observationGuard(revision, ctx);
	if (beforeSigning !== undefined) return beforeSigning;
	if (reconciling && (reconciliationEpoch !== submitEpoch || reconciliationToken !== submittedToken)) {
	  return refusal('submit-reconciliation-required');
	}
	if (reconciling && checked.projection.serviceObservation.packetDigest !== visibleDigest) {
	  requireReconciliation();
	  return refusal('submit-reconciliation-stale');
	}
	if (checked.packet === undefined) return refusal('verified-packet-unavailable');
	const output = checked.projection.outputs.find((candidate) => candidate.path === path);
	if (output === undefined) return refusal('submit-path-not-verified');
	if (checked.packet.collectionOutputs.includes(path)) return refusal('collection-submit-unsupported');
	let proof: string | undefined;
	const signing = new AbortController();
	let signingActive = true;
	ctx.onCancel(() => { if (signingActive) signing.abort(); });
	try {
	  if (ctx.cancelled) return refusal('call-cancelled');
	  proof = await options.signProof!(checked.packet.order, path, value as Record<string, unknown>, output.version, signing.signal);
	} catch {
	  return refusal(ctx.cancelled ? 'call-cancelled' : 'submit-proof-unavailable');
	} finally {
	  signingActive = false;
	}
	if (ctx.cancelled) return refusal('call-cancelled');
	if (typeof proof !== 'string' || proof.length === 0) return refusal('submit-proof-unavailable');
	const beforeCurrent = observationGuard(revision, ctx);
	if (beforeCurrent !== undefined) return beforeCurrent;
	if (v2) {
	  // Signing is asynchronous. Re-read the independent witness after it;
	  // expected output version alone cannot attest unchanged input authority.
	  const final = await readVerified(revision, ctx);
	  if (!final.ok) return final.result;
	  if (final.projection.serviceObservation.packetDigest !== checked.projection.serviceObservation.packetDigest
	    || final.projection.serviceObservation.inputWitnessDigest !== checked.projection.serviceObservation.inputWitnessDigest) {
	    return refuseObservation('holder-order-changed', revision);
	  }
	}
	const finalPrivate = await readWithDeadline(revision, ctx, async scopedContext => ({
	  ok: true as const, current: await livePrivateOrder(scopedContext),
	}));
	if (!finalPrivate.ok) return finalPrivate.result;
	const current = finalPrivate.current;
	const beforeSubmit = observationGuard(revision, ctx);
	if (beforeSubmit !== undefined) return beforeSubmit;
	if (current === undefined) return refuseObservation('holder-order-unavailable', revision);
	if (current.fullDigest !== checked.fullDigest) return refuseObservation('holder-order-changed', revision);
	const stale = observationCurrent(checked.projection, checked.startedAt);
	if (stale !== undefined) { invalidateObservation(revision); return stale; }
	if (reconciling && (reconciliationEpoch !== submitEpoch || reconciliationToken !== submittedToken
	  || reconciliationDigest !== visibleDigest)) return refusal('submit-reconciliation-required');
      let response: ConditionalSubmitResponse;
      try {
	response = await adapter.submitConditional!({
	  workflow: bound.workflow, run: bound.run, path, value,
	  expectedVersion: output.version, proof,
	  ...(done === undefined ? {} : { done }),
	  ...(options.holder === undefined ? {} : { holder: options.holder }),
	});
      } catch (error) {
	if (error instanceof HubError && error.status === 404) return refusal('conditional-submit-unavailable');
	if (error instanceof HubError && error.status === 409 && error.code === 'stale_submit_condition') {
	  if (reconciling) requireReconciliation();
	  return refusal('stale-submit-condition');
	}
	if (error instanceof HubError && error.status === 409 && error.code === 'run_closed') {
	  mount.loop.stop('submitted', { release: false });
	  return refusal('run-closed');
	}
	requireReconciliation();
	return refusal('submit-result-unknown');
      }
      if (!record(response)) {
	requireReconciliation();
	return refusal('condition-ack-missing');
      }
      // Even an unsuccessful submit may close the run (for example the engine
      // can born-reject it). Stop the lease before interpreting the outcome.
      if (response.closed === true) mount.loop.stop('submitted', { release: false });
      if (response.conditionApplied !== 'expected-version-v1') {
	requireReconciliation();
	return refusal('condition-ack-missing');
      }
      const outcome = response.outcome;
      if (outcome !== 'green' && outcome !== 'submitted' && outcome !== 'emitted') {
	requireReconciliation();
	return refusal('submit-not-accepted');
      }
      reconciliationRequired = false;
      reconciliationToken = undefined;
      reconciliationDigest = undefined;
      return textResult({
	protocol: 'local-hosted-submit-v1', state: 'accepted', outcome, closed: response.closed === true,
      });
      } finally {
	submitInFlight = false;
      }
    },
  };
  return { loop: mount.loop, tools: [orderTool, submitTool], readGatedOrder: mount.readGatedOrder };
}
