/**
 * Opt-in boundary for a workflow/run-bound hosted MCP mount. The service
 * observation establishes an active claim, not this process's holder identity.
 * Submit is separately opted into and uses only the versioned conditional
 * service route; other mutations are never advertised here.
 */
import { randomUUID } from 'node:crypto';

import { textResult, type ToolRegistration, type ToolResult } from '../mcp/server.ts';
import type { HoldMcpMount } from '../hold/mcp.ts';
import { HubError, type ConditionalSubmitRequest, type ConditionalSubmitResponse, type ContactHolder, type GetOrderResponse, type OrderPacket } from '../hub/types.ts';
import { hostedPacketDigest, type HostedOrderProjection, type HostedOrderResult, type HostedVerifiedPacket } from './order-adapter.ts';

type Adapter = {
  open(preflight: unknown, index?: number, onVerified?: (packet: HostedVerifiedPacket) => void): Promise<HostedOrderResult>;
  submitConditional?: (req: ConditionalSubmitRequest) => Promise<ConditionalSubmitResponse>;
};
type BoundOrder = { workflow: string; run: string };
type SignProof = (order: OrderPacket, path: string, value: Record<string, unknown>, version: number) => Promise<string | undefined>;
type SubmitOptions = { enableSubmit?: boolean; signProof?: SignProof; holder?: ContactHolder; now?: () => number; monotonicNow?: () => number };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function refusal(code: string): ToolResult {
  return textResult({ protocol: 'local-hosted-order-v1', state: 'refused', code }, true);
}

function stablePacketDigest(value: unknown): string | undefined {
  const order = record(value);
  if (order === undefined || !Array.isArray(order.owes)) return undefined;
  const owes = order.owes.map((entry: unknown) => {
    const owed = record(entry);
    if (owed === undefined) return undefined;
    const stable = { ...owed };
    delete stable.version;
    return stable;
  });
  if (owes.includes(undefined)) return undefined;
  return hostedPacketDigest({ ...order, owes });
}

function privatePreflight(result: ToolResult, gated: GetOrderResponse | undefined, bound: BoundOrder): { ref: unknown; fullDigest: string; stableDigest: string } | undefined {
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
  if (packet?.workflow !== bound.workflow || packet?.run !== bound.run
    || visible?.workflow !== bound.workflow || visible?.run !== bound.run
    || gated?.workflow !== bound.workflow || gated.run !== bound.run
    || order?.workflow !== bound.workflow || order?.run !== bound.run
    || visible.step !== order.step || visible.key !== order.key || visible.defDigest !== order.defDigest
    || typeof order.defDigest !== 'string') return undefined;
  const fullDigest = hostedPacketDigest(order);
  const stableDigest = stablePacketDigest(order);
  if (fullDigest === undefined || stableDigest === undefined) return undefined;
  return { fullDigest, stableDigest, ref: {
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
  let anchoredFullDigest: string | undefined;
  // A lost response may hide a committed partial submit. Internal verification
  // cannot tell the model that its last value may already have been accepted.
  let reconciliationRequired = false;
  let reconciliationEpoch = 0;
  let reconciliationToken: string | undefined;
  let reconciliationDigest: string | undefined;
  let submitInFlight = false;
  function requireReconciliation(): void {
    reconciliationRequired = true;
    reconciliationEpoch++;
    reconciliationToken = undefined;
    reconciliationDigest = undefined;
  }
  async function livePrivateOrder(ctx: Parameters<ToolRegistration['handler']>[1]): Promise<{ ref: unknown; fullDigest: string; stableDigest: string } | undefined> {
    try {
      if (anchoredRef !== undefined && mount.readGatedOrder() === undefined) return undefined;
      return privatePreflight(await rawGet!.handler({}, ctx), mount.readGatedOrder(), bound);
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
  async function readVerified(ctx: Parameters<ToolRegistration['handler']>[1]): Promise<
    | { ok: true; projection: HostedOrderProjection; fullDigest: string; startedAt: number; packet?: HostedVerifiedPacket }
    | { ok: false; result: ToolResult }
  > {
    if (ctx.cancelled) return { ok: false, result: refusal('call-cancelled') };
    let ref = anchoredRef;
    let initialFullDigest: string;
    let initialStableDigest: string;
    if (ref === undefined) {
      const privateOrder = await livePrivateOrder(ctx);
      if (privateOrder === undefined) return { ok: false, result: refusal('holder-order-unavailable') };
      ref = privateOrder.ref;
      initialFullDigest = privateOrder.fullDigest;
      initialStableDigest = privateOrder.stableDigest;
    } else {
      const privateOrder = await livePrivateOrder(ctx);
      if (privateOrder === undefined) return { ok: false, result: refusal('holder-order-unavailable') };
      if (privateOrder.fullDigest !== anchoredFullDigest) return { ok: false, result: refusal('holder-order-changed') };
      initialFullDigest = privateOrder.fullDigest;
      initialStableDigest = privateOrder.stableDigest;
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
    if (ctx.cancelled) return { ok: false, result: refusal('call-cancelled') };
    if (verified.state !== 'ready') {
      return { ok: false, result: refusal(verified.state === 'refused' ? verified.code : 'order-unavailable') };
    }
    if (anchoredRef === undefined && verified.serviceObservation.packetDigest !== initialFullDigest) {
      return { ok: false, result: refusal('holder-order-changed') };
    }
    if (verifiedPacket === undefined && options.enableSubmit) return { ok: false, result: refusal('verified-packet-unavailable') };
    if (verifiedPacket !== undefined
      && hostedPacketDigest(verifiedPacket.order) !== verified.serviceObservation.packetDigest) {
      return { ok: false, result: refusal('verified-packet-mismatch') };
    }
    if (verifiedPacket !== undefined && stablePacketDigest(verifiedPacket.order) !== initialStableDigest) {
      return { ok: false, result: refusal('holder-order-changed') };
    }
    if (verifiedPacket === undefined && verified.serviceObservation.packetDigest !== initialFullDigest) {
      return { ok: false, result: refusal('holder-order-changed') };
    }
    // A direct service observation cannot attest that this local process kept
    // the hold while verification was pending. The raw mount must still gate it.
    const current = await livePrivateOrder(ctx);
    if (current === undefined) return { ok: false, result: refusal('holder-order-unavailable') };
    if (current.fullDigest !== initialFullDigest) {
      return { ok: false, result: refusal('holder-order-changed') };
    }
    if (ctx.cancelled) return { ok: false, result: refusal('call-cancelled') };
    const stale = observationCurrent(verified, startedAt);
    if (stale !== undefined) return { ok: false, result: stale };
    anchoredRef = ref;
    anchoredFullDigest = initialFullDigest;
    return { ok: true, projection: verified, fullDigest: initialFullDigest, startedAt,
      ...(verifiedPacket === undefined ? {} : { packet: verifiedPacket }) };
  }
  const orderTool: ToolRegistration = {
    name: 'get_order',
    description: 'Return the locally verified hosted order projection for this bound workflow/run.',
    inputSchema: rawGet.inputSchema,
    handler: async (_args, ctx) => {
      const reconciling = reconciliationRequired;
      const startedEpoch = reconciliationEpoch;
      const checked = await readVerified(ctx);
      if (!checked.ok) return checked.result;
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
	const checked = await readVerified(ctx);
	if (!checked.ok) return checked.result;
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
	try {
	  proof = await options.signProof!(checked.packet.order, path, value as Record<string, unknown>, output.version);
	} catch {
	  return refusal('submit-proof-unavailable');
	}
	if (typeof proof !== 'string' || proof.length === 0) return refusal('submit-proof-unavailable');
	if (ctx.cancelled) return refusal('call-cancelled');
	const current = await livePrivateOrder(ctx);
	if (current === undefined) return refusal('holder-order-unavailable');
	if (current.fullDigest !== checked.fullDigest) return refusal('holder-order-changed');
	if (ctx.cancelled) return refusal('call-cancelled');
	const stale = observationCurrent(checked.projection, checked.startedAt);
	if (stale !== undefined) return stale;
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
