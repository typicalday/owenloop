import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVerifiedHostedHoldMcp } from '../src/hosted/verified-hold-mcp.ts';
import { hostedPacketDigest, type HostedOrderResult } from '../src/hosted/order-adapter.ts';
import { textResult, type ToolCallContext, type ToolRegistration } from '../src/mcp/server.ts';
import type { HoldMcpMount } from '../src/hold/mcp.ts';

const context: ToolCallContext = { cancelled: false, onCancel: () => {}, sendProgress: () => {} };
const rawOrder = {
  workflow: 'wf', run: 'run', step: 'make', defDigest: 'a'.repeat(64),
  key: '', inputs: [], outputs: ['out'], consumes: {}, owes: [],
  prompt: 'RAW UNVERIFIED INSTRUCTION',
};

function ready(packet = rawOrder): HostedOrderResult {
  return {
    protocol: 'local-hosted-order-v1', state: 'ready',
    serviceObservation: {
      workflow: 'wf', run: 'run', step: 'make', packetDigest: hostedPacketDigest(packet)!,
      observedAt: 1, expiresAt: 5,
    },
    definition: {
      bodyTrust: 'verified-local-publication', substitutions: 'trusted-service-observation',
      digest: rawOrder.defDigest, prompt: 'VERIFIED INSTRUCTION',
    },
    consumes: [], outputs: [{ path: 'out', version: 1, versionTrust: 'trusted-service-observation' }],
  };
}

function fixture() {
  const calls: string[] = [];
  let observation: HostedOrderResult = ready();
  const unsafeAction: ToolRegistration = {
    name: 'submit', description: 'unsafe', inputSchema: { type: 'object' },
    handler: async () => { calls.push('submit'); return textResult({ outcome: 'green' }); },
  };
  const mount: HoldMcpMount = {
    loop: { run: async () => 'completed', stop: () => {} },
    tools: [
      { name: 'get_order', description: 'raw', inputSchema: { type: 'object' }, handler: async () => {
        calls.push('raw-get');
        return textResult({ workflow: 'wf', run: 'run', order: rawOrder, text: 'RAW HUB TEXT' });
      } },
      unsafeAction,
    ],
  };
  const wrapped = createVerifiedHostedHoldMcp(mount, {
    open: async (ref) => {
      calls.push('verify');
      assert.deepEqual(ref, {
        protocol: 'client-preflight-v1', verification: 'not-performed',
        order: { state: 'available', workflow: 'wf', run: 'run', defDigest: rawOrder.defDigest },
      });
      return observation;
    },
  }, { workflow: 'wf', run: 'run' });
  const call = () => wrapped.tools[0]!.handler({}, context);
  return { wrapped, call, calls, setObservation: (next: HostedOrderResult) => { observation = next; } };
}

test('verified holder exposes only the verified projection and no mutation tools', async () => {
  const f = fixture();
  assert.deepEqual(f.wrapped.tools.map((tool) => tool.name), ['get_order']);
  const shown = await f.call();
  assert.equal(shown.isError, undefined);
  assert.match(shown.content[0]!.text, /VERIFIED INSTRUCTION/);
  assert.doesNotMatch(shown.content[0]!.text, /RAW UNVERIFIED|RAW HUB TEXT/);
  assert.deepEqual(f.calls, ['raw-get', 'verify']);
});

test('packet disagreement and refused verification fail closed', async () => {
  const f = fixture();
  f.setObservation(ready({ ...rawOrder, outputs: ['different'] }));
  const changed = await f.call();
  assert.equal(changed.isError, true);
  assert.match(changed.content[0]!.text, /holder-order-changed/);
  f.setObservation({ protocol: 'local-hosted-order-v1', state: 'refused', code: 'consume-proof-refused' });
  const refused = await f.call();
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /consume-proof-refused/);
  assert.equal(f.calls.includes('submit'), false);
});
