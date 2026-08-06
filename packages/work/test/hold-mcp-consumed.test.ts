import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHoldMcp } from '../src/hold/mcp.ts';
import type { ConsumedVerifier } from '../src/consumed-verifier.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { GetOrderResponse, OrderPacket } from '../src/hub/types.ts';
import type { ToolCallContext, ToolRegistration } from '../src/mcp/server.ts';

const ctx: ToolCallContext = { cancelled: false, onCancel: () => {}, sendProgress: () => {} };

function dynamicOrder(): OrderPacket {
  return {
    run: 'run-mcp-consumed',
    workflow: 'wf-mcp-consumed',
    step: 'consumer',
    key: 'consumer-key',
    defDigest: 'def-mcp-consumed',
    inputs: ['input'],
    outputs: ['output'],
    consumes: { input: 'tampered-secret' },
    owes: [],
  };
}

function response(): GetOrderResponse {
  return {
    text: 'here',
    workflow: 'wf-mcp-consumed',
    run: 'run-mcp-consumed',
    order: dynamicOrder(),
    lease: { claimed: true },
  };
}

function tool(tools: ToolRegistration[], name: string): ToolRegistration {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found, `tool ${name} exists`);
  return found!;
}

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function hubFor(calls: string[]): HubClient {
  return {
    async getOrder() {
      calls.push('get_order');
      return response();
    },
    async submit() {
      calls.push('submit');
      return { text: 'submitted', outcome: 'accepted', closed: false };
    },
    async heartbeat() {
      calls.push('heartbeat');
      return { text: 'heartbeat' };
    },
    async release() {
      calls.push('release');
      return { text: 'released' };
    },
  } as unknown as HubClient;
}

function refusedVerifier(seen: OrderPacket[]): ConsumedVerifier {
  return async (order) => {
    seen.push(order);
    return {
      ok: false,
      reason: `consumed artifact refusal (value-digest) for ${order.workflow}/${order.run} step '${order.step}' artifact 'input': delivered value does not match signed value`,
    };
  };
}

test('get_order refuses tampered dynamic values and never returns the value', async () => {
  const calls: string[] = [];
  const seen: OrderPacket[] = [];
  const mount = createHoldMcp({
    hub: hubFor(calls),
    workflow: 'wf-mcp-consumed',
    run: 'run-mcp-consumed',
    sleep: async () => {},
    now: () => 0,
    err: () => {},
    consumedVerifier: refusedVerifier(seen),
  });

  const result = await tool(mount.tools, 'get_order').handler({}, ctx);
  const body = parse(result);
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(String(body.error), /value-digest/);
  assert.equal(JSON.stringify(body).includes('tampered-secret'), false);
  assert.equal(seen.length, 1);
  assert.deepEqual(calls, ['get_order']);
});

test('a direct submit cannot bypass consume-side verification when no verifier is configured', async () => {
  const calls: string[] = [];
  const mount = createHoldMcp({
    hub: hubFor(calls),
    workflow: 'wf-mcp-consumed',
    run: 'run-mcp-consumed',
    sleep: async () => {},
    now: () => 0,
    err: () => {},
  });

  const result = await tool(mount.tools, 'submit').handler({ path: 'output', value: 'new-value' }, ctx);
  const body = parse(result);
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(String(body.error), /not configured/);
  assert.equal(JSON.stringify(body).includes('tampered-secret'), false);
  assert.deepEqual(calls, ['get_order']);
});

test('a submit-fetched packet is not cached or submitted before consumed verification', async () => {
  const calls: string[] = [];
  const seen: OrderPacket[] = [];
  const mount = createHoldMcp({
    hub: hubFor(calls),
    workflow: 'wf-mcp-consumed',
    run: 'run-mcp-consumed',
    origin: 'https://hub.example.test',
    sleep: async () => {},
    now: () => 0,
    err: () => {},
    consumedVerifier: refusedVerifier(seen),
  });

  const result = await tool(mount.tools, 'submit').handler({ path: 'output', value: 'new-value' }, ctx);
  const body = parse(result);
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(String(body.error), /value-digest/);
  assert.equal(JSON.stringify(body).includes('tampered-secret'), false);
  assert.equal(seen.length, 1);
  assert.deepEqual(calls, ['get_order']);

  // A later get_order must fetch and gate again; the refused response never
  // entered the verified cache.
  const second = await tool(mount.tools, 'get_order').handler({}, ctx);
  assert.equal((second as { isError?: boolean }).isError, true);
  assert.equal(seen.length, 2);
  assert.deepEqual(calls, ['get_order', 'get_order']);
});
