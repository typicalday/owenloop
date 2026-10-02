/**
 * Opt-in read boundary for a workflow/run-bound hosted MCP mount. The service
 * observation establishes an active claim, not this process's holder identity.
 * Mutations need a
 * service-side conditional claim transaction; this mount advertises only
 * get_order until that protocol exists.
 */
import { textResult, type ToolRegistration, type ToolResult } from '../mcp/server.ts';
import type { HoldMcpMount } from '../hold/mcp.ts';
import { hostedPacketDigest, type HostedOrderResult } from './order-adapter.ts';

type Adapter = { open(preflight: unknown): Promise<HostedOrderResult> };
type BoundOrder = { workflow: string; run: string };
type ReadOptions = { now?: () => number };

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
  options: ReadOptions = {},
): HoldMcpMount {
  const rawGet = mount.tools.find((tool) => tool.name === 'get_order');
  if (rawGet === undefined) throw new Error('verified hosted holder requires get_order in its private tool set');
  const tool: ToolRegistration = {
    name: 'get_order',
    description: 'Return the locally verified hosted order projection for this bound workflow/run.',
    inputSchema: rawGet.inputSchema,
    handler: async (_args, ctx) => {
      if (ctx.cancelled) return refusal('call-cancelled');
      let raw: ToolResult;
      try {
        raw = await rawGet.handler({}, ctx);
      } catch {
        return refusal('holder-order-unavailable');
      }
      const privateOrder = privatePreflight(raw, bound);
      if (privateOrder === undefined) return refusal('holder-order-unavailable');
      let verified: HostedOrderResult;
      try {
        verified = await adapter.open(privateOrder.ref);
      } catch {
        return refusal('verification-unavailable');
      }
      if (ctx.cancelled) return refusal('call-cancelled');
      if (verified.state !== 'ready') {
        return refusal(verified.state === 'refused' ? verified.code : 'order-unavailable');
      }
      if (verified.serviceObservation.packetDigest !== privateOrder.digest) return refusal('holder-order-changed');
      // The service observation cannot prove that this local holder still has
      // its lease. Re-read the private mount after verification, which may
      // have outlived a stop, and require the same gated packet.
      let current: ToolResult;
      try {
        current = await rawGet.handler({}, ctx);
      } catch {
        return refusal('holder-order-unavailable');
      }
      const liveOrder = privatePreflight(current, bound);
      if (liveOrder === undefined) return refusal('holder-order-unavailable');
      if (liveOrder.digest !== privateOrder.digest) return refusal('holder-order-changed');
      if (ctx.cancelled) return refusal('call-cancelled');
      let shownAt: number;
      try {
        shownAt = (options.now ?? Date.now)();
      } catch {
        return refusal('clock-unavailable');
      }
      const { observedAt, expiresAt } = verified.serviceObservation;
      if (!Number.isSafeInteger(shownAt) || shownAt < observedAt || shownAt >= expiresAt) {
        return refusal('claim-observation-expired');
      }
      return textResult(verified);
    },
  };
  return { loop: mount.loop, tools: [tool] };
}
