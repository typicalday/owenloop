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

function fixture(options: {
  open?: (ref: unknown) => Promise<HostedOrderResult>;
  onRawGet?: (count: number) => Promise<void>;
  now?: () => number;
} = {}) {
  const calls: string[] = [];
  let observation: HostedOrderResult = ready();
  let holding = true;
  let rawGets = 0;
  const unsafeAction: ToolRegistration = {
    name: 'submit', description: 'unsafe', inputSchema: { type: 'object' },
    handler: async () => { calls.push('submit'); return textResult({ outcome: 'green' }); },
  };
  const mount: HoldMcpMount = {
    loop: { run: async () => 'completed', stop: () => { holding = false; } },
    tools: [
      { name: 'get_order', description: 'raw', inputSchema: { type: 'object' }, handler: async () => {
        calls.push('raw-get');
        rawGets++;
        await options.onRawGet?.(rawGets);
        if (!holding) return textResult({ error: 'order no longer held' }, true);
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
      return options.open === undefined ? observation : options.open(ref);
    },
  }, { workflow: 'wf', run: 'run' }, { now: options.now ?? (() => 2) });
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
  assert.deepEqual(f.calls, ['raw-get', 'verify', 'raw-get']);
});

test('verification that outlives the local hold cannot expose a ready order', async () => {
  let resolve!: (value: HostedOrderResult) => void;
  let started!: () => void;
  const pending = new Promise<HostedOrderResult>((done) => { resolve = done; });
  const verificationStarted = new Promise<void>((done) => { started = done; });
  const f = fixture({ open: async () => { started(); return pending; } });
  const call = f.call();
  await verificationStarted;
  f.wrapped.loop.stop('signal');
  resolve(ready());
  const result = await call;
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /holder-order-unavailable/);
  assert.deepEqual(f.calls, ['raw-get', 'verify', 'raw-get']);
});

test('a delayed holder recheck cannot expose an expired ready observation', async () => {
  let resume!: () => void;
  let started!: () => void;
  let current = 2;
  const pending = new Promise<void>((done) => { resume = done; });
  const secondReadStarted = new Promise<void>((done) => { started = done; });
  const f = fixture({
    onRawGet: async (count) => {
      if (count === 2) { started(); await pending; }
    },
    now: () => current,
  });
  const call = f.call();
  await secondReadStarted;
  current = 5;
  resume();
  const result = await call;
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /claim-observation-expired/);
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
