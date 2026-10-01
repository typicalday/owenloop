/**
 * Opt-in boundary for a workflow/run-bound hosted MCP mount. The service
 * observation establishes an active claim, not this process's holder identity.
 * Submit is separately opted into and uses only the versioned conditional
 * service route; other mutations are never advertised here.
 */
import { textResult, type ToolRegistration, type ToolResult } from '../mcp/server.ts';
import type { HoldMcpMount } from '../hold/mcp.ts';
import { HubError, type ConditionalSubmitRequest, type ConditionalSubmitResponse, type ContactHolder, type OrderPacket } from '../hub/types.ts';
import { hostedPacketDigest, type HostedOrderProjection, type HostedOrderResult, type HostedVerifiedPacket } from './order-adapter.ts';

type Adapter = {
  open(preflight: unknown, index?: number, onVerified?: (packet: HostedVerifiedPacket) => void): Promise<HostedOrderResult>;
  submitConditional?: (req: ConditionalSubmitRequest) => Promise<ConditionalSubmitResponse>;
};
type BoundOrder = { workflow: string; run: string };
type SignProof = (order: OrderPacket, path: string, value: Record<string, unknown>, version: number) => Promise<string | undefined>;
type SubmitOptions = { enableSubmit?: boolean; signProof?: SignProof; holder?: ContactHolder };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function refusal(code: string): ToolResult {
  return textResult({ protocol: 'local-hosted-order-v1', state: 'refused', code }, true);
}

function privatePreflight(result: ToolResult, bound: BoundOrder): { ref: unknown; digest: string } | undefined {
  if (result.isError || result.content.length !== 1) return undefined;
  let view: unknown;
  try {
    view = JSON.parse(result.content[0]!.text);
  } catch {
    return undefined;
  }
  const packet = record(view);
  const order = record(packet?.order);
  if (packet?.workflow !== bound.workflow || packet?.run !== bound.run
    || order?.workflow !== bound.workflow || order?.run !== bound.run
    || typeof order.defDigest !== 'string') return undefined;
  const digest = hostedPacketDigest(order);
  if (digest === undefined) return undefined;
  return { digest, ref: {
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
  async function readVerified(ctx: Parameters<ToolRegistration['handler']>[1]): Promise<
    | { ok: true; projection: HostedOrderProjection; packet?: HostedVerifiedPacket }
    | { ok: false; result: ToolResult }
  > {
    if (ctx.cancelled) return { ok: false, result: refusal('call-cancelled') };
    let ref = anchoredRef;
    let initialDigest: string | undefined;
    if (ref === undefined) {
      let raw: ToolResult;
      try {
        raw = await rawGet!.handler({}, ctx);
      } catch {
        return { ok: false, result: refusal('holder-order-unavailable') };
      }
      const privateOrder = privatePreflight(raw, bound);
      if (privateOrder === undefined) return { ok: false, result: refusal('holder-order-unavailable') };
      ref = privateOrder.ref;
      initialDigest = privateOrder.digest;
    }
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
    if (initialDigest !== undefined && verified.serviceObservation.packetDigest !== initialDigest) {
      return { ok: false, result: refusal('holder-order-changed') };
    }
    if (verifiedPacket === undefined && options.enableSubmit) return { ok: false, result: refusal('verified-packet-unavailable') };
    if (verifiedPacket !== undefined
      && hostedPacketDigest(verifiedPacket.order) !== verified.serviceObservation.packetDigest) {
      return { ok: false, result: refusal('verified-packet-mismatch') };
    }
    anchoredRef = ref;
    return { ok: true, projection: verified, ...(verifiedPacket === undefined ? {} : { packet: verifiedPacket }) };
  }
  const orderTool: ToolRegistration = {
    name: 'get_order',
    description: 'Return the locally verified hosted order projection for this bound workflow/run.',
    inputSchema: rawGet.inputSchema,
    handler: async (_args, ctx) => {
      const checked = await readVerified(ctx);
      return checked.ok ? textResult(checked.projection) : checked.result;
    },
  };
  if (!options.enableSubmit) return { loop: mount.loop, tools: [orderTool] };
  const submitTool: ToolRegistration = {
    name: 'submit',
    description: 'Submit one object receipt for a currently verified owed path using the service conditional-v1 protocol. Re-verifies the order before every submit.',
    inputSchema: {
      type: 'object', required: ['path', 'value'], additionalProperties: false,
      properties: {
        path: { type: 'string' }, value: { type: 'object' }, done: { type: 'boolean' },
      },
    },
    handler: async (args, ctx) => {
      const path = args['path'];
      const value = args['value'];
      const done = args['done'];
      if (typeof path !== 'string' || path === '' || record(value) === undefined
        || (done !== undefined && typeof done !== 'boolean')) return refusal('submit-input-invalid');
      const checked = await readVerified(ctx);
      if (!checked.ok) return checked.result;
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
          return refusal('stale-submit-condition');
        }
        if (error instanceof HubError && error.status === 409 && error.code === 'run_closed') {
          mount.loop.stop('submitted', { release: false });
          return refusal('run-closed');
        }
        return refusal('submit-result-unknown');
      }
      if (!record(response)) return refusal('condition-ack-missing');
      // Even an unsuccessful submit may close the run (for example the engine
      // can born-reject it). Stop the lease before interpreting the outcome.
      if (response.closed === true) mount.loop.stop('submitted', { release: false });
      if (response.conditionApplied !== 'expected-version-v1') return refusal('condition-ack-missing');
      const outcome = response.outcome;
      if (outcome !== 'green' && outcome !== 'submitted' && outcome !== 'emitted') {
        return refusal('submit-not-accepted');
      }
      return textResult({
        protocol: 'local-hosted-submit-v1', state: 'accepted', outcome, closed: response.closed === true,
      });
    },
  };
  return { loop: mount.loop, tools: [orderTool, submitTool] };
}
