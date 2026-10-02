import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVerifiedHostedHoldMcp } from '../src/hosted/verified-hold-mcp.ts';
import { hostedPacketDigest, type HostedOrderResult } from '../src/hosted/order-adapter.ts';
import { HubError, type ConditionalSubmitRequest, type ConditionalSubmitResponse, type OrderPacket } from '../src/hub/types.ts';
import { textResult, type ToolCallContext, type ToolRegistration } from '../src/mcp/server.ts';
import { createHoldMcp, type HoldMcpMount } from '../src/hold/mcp.ts';
import type { HubClient } from '../src/hub/client.ts';

const context: ToolCallContext = { cancelled: false, onCancel: () => {}, sendProgress: () => {} };
const rawOrder: OrderPacket = {
  workflow: 'wf', run: 'run', step: 'make', defDigest: 'a'.repeat(64),
  key: '', inputs: [], outputs: ['out'], consumes: {},
  owes: [{ path: 'out', version: 1, judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
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
    consumes: [], outputs: [{ path: 'out', version: packet.owes[0]!.version!, versionTrust: 'trusted-service-observation' }],
  };
}

function fixture(enableSubmit = false) {
  const calls: string[] = [];
  const submits: ConditionalSubmitRequest[] = [];
  const stops: Array<{ reason: string | undefined; release?: boolean }> = [];
  let observation: HostedOrderResult = ready();
  let verifiedPacket: OrderPacket = rawOrder;
  let collectionOutputs: string[] = [];
  let proof: string | undefined = 'SIGNED PROOF';
  let submitResponse: ConditionalSubmitResponse = {
    text: 'RAW HUB SUBMIT TEXT', outcome: 'green', closed: true, conditionApplied: 'expected-version-v1',
  };
  let submitError: unknown;
  let held = true;
  let onVerify: (() => void) | undefined;
  let onSign: (() => void) | undefined;
  let now = 2;
  const unsafeAction: ToolRegistration = {
    name: 'submit', description: 'unsafe', inputSchema: { type: 'object' },
    handler: async () => { calls.push('submit'); return textResult({ outcome: 'green' }); },
  };
  const mount: HoldMcpMount = {
    loop: { run: async () => 'completed', stop: (reason, options) => {
      stops.push({ reason, ...(options?.release === undefined ? {} : { release: options.release }) });
    } },
    tools: [
      { name: 'get_order', description: 'raw', inputSchema: { type: 'object' }, handler: async () => {
        calls.push('raw-get');
        return textResult({ workflow: 'wf', run: 'run', order: rawOrder, text: 'RAW HUB TEXT' });
      } },
      unsafeAction,
    ],
    readGatedOrder: () => held
      ? ({ text: '', workflow: 'wf', run: 'run', order: rawOrder, lease: { claimed: true } })
      : undefined,
  };
  const wrapped = createVerifiedHostedHoldMcp(mount, {
    open: async (ref, _index, onVerified) => {
      calls.push('verify');
      onVerify?.();
      assert.deepEqual(ref, {
        protocol: 'client-preflight-v1', verification: 'not-performed',
        order: { state: 'available', workflow: 'wf', run: 'run', defDigest: rawOrder.defDigest },
      });
      if (observation.state === 'ready') onVerified?.({ order: verifiedPacket, collectionOutputs });
      return observation;
    },
    submitConditional: async (req) => {
      calls.push('conditional-submit');
      submits.push(req);
      if (submitError !== undefined) throw submitError;
      return submitResponse;
    },
  }, { workflow: 'wf', run: 'run' }, enableSubmit ? {
    enableSubmit: true,
    now: () => now,
    signProof: async (order, path, value, version) => {
      calls.push('sign');
      onSign?.();
      assert.equal(order, verifiedPacket);
      assert.equal(path, 'out');
      assert.deepEqual(value, { n: 1 });
      assert.equal(version, verifiedPacket.owes[0]!.version);
      return proof;
    },
  } : {});
  const call = () => wrapped.tools[0]!.handler({}, context);
  const submit = (args: Record<string, unknown>) => wrapped.tools[1]!.handler(args, context);
  return {
    wrapped, call, submit, calls, submits, stops,
    setObservation: (next: HostedOrderResult) => { observation = next; },
    setPacket: (next: OrderPacket) => { verifiedPacket = next; observation = ready(next); },
    setCollectionOutputs: (next: string[]) => { collectionOutputs = next; },
    setProof: (next: string | undefined) => { proof = next; },
    setSubmitResponse: (next: ConditionalSubmitResponse) => { submitResponse = next; },
    setSubmitError: (next: unknown) => { submitError = next; },
    setHeld: (next: boolean) => { held = next; },
    setOnVerify: (next: () => void) => { onVerify = next; },
    setOnSign: (next: () => void) => { onSign = next; },
    setNow: (next: number) => { now = next; },
  };
}

test('real hold mount compares its full gated packet while showing a reduced order to the model', async () => {
  const full: OrderPacket = {
    ...rawOrder,
    spec: { privateInstruction: 'HUB-SPEC' },
    x: { privateInstruction: 'HUB-X' },
    owes: [{ ...rawOrder.owes[0]!, schema: { privateInstruction: 'HUB-SCHEMA' } }],
  };
  const response = { text: 'HUB-TEXT', workflow: 'wf', run: 'run', order: full, lease: { claimed: true } };
  const hub = { getOrder: async () => response } as unknown as HubClient;
  const mount = createHoldMcp({
    hub, workflow: 'wf', run: 'run', workdir: process.cwd(), tools: ['get_order'],
    sleep: async () => {}, now: () => 0, err: () => {},
  });
  const raw = await mount.tools[0]!.handler({}, context);
  assert.equal(raw.isError, undefined);
  assert.doesNotMatch(raw.content[0]!.text, /HUB-SPEC|HUB-X|HUB-SCHEMA|HUB-TEXT/);
  assert.equal(hostedPacketDigest(mount.readGatedOrder()?.order), hostedPacketDigest(full));

  let direct: OrderPacket = full;
  const wrapped = createVerifiedHostedHoldMcp(mount, {
    open: async (_ref, _index, onVerified) => {
      onVerified?.({ order: direct, collectionOutputs: [] });
      return ready(direct);
    },
  }, { workflow: 'wf', run: 'run' });
  const accepted = await wrapped.tools[0]!.handler({}, context);
  assert.equal(accepted.isError, undefined);
  assert.match(accepted.content[0]!.text, /VERIFIED INSTRUCTION/);
  assert.doesNotMatch(accepted.content[0]!.text, /HUB-SPEC|HUB-X|HUB-SCHEMA|HUB-TEXT/);

  // The full snapshot, including a field omitted from the model view, fences
  // a changed direct service order before any verified projection is shown.
  const freshMount = createHoldMcp({
    hub, workflow: 'wf', run: 'run', workdir: process.cwd(), tools: ['get_order'],
    sleep: async () => {}, now: () => 0, err: () => {},
  });
  direct = { ...full, spec: { privateInstruction: 'CHANGED' } };
  const fenced = createVerifiedHostedHoldMcp(freshMount, {
    open: async (_ref, _index, onVerified) => {
      onVerified?.({ order: direct, collectionOutputs: [] });
      return ready(direct);
    },
  }, { workflow: 'wf', run: 'run' });
  const changed = await fenced.tools[0]!.handler({}, context);
  assert.equal(changed.isError, true);
  assert.match(changed.content[0]!.text, /holder-order-changed/);
});

test('verified holder exposes only the verified projection and no mutation tools', async () => {
  const f = fixture();
  assert.deepEqual(f.wrapped.tools.map((tool) => tool.name), ['get_order']);
  const shown = await f.call();
  assert.equal(shown.isError, undefined);
  assert.match(shown.content[0]!.text, /VERIFIED INSTRUCTION/);
  assert.doesNotMatch(shown.content[0]!.text, /RAW UNVERIFIED|RAW HUB TEXT/);
  assert.deepEqual(f.calls, ['raw-get', 'verify']);
});

test('verified holder refuses cached reads and submits after its local hold ends', async () => {
  const f = fixture(true);
  const first = await f.call();
  assert.equal(first.isError, undefined);
  f.setHeld(false);
  const callsBefore = [...f.calls];
  const read = await f.call();
  const submit = await f.submit({ path: 'out', value: { n: 1 } });
  assert.equal(read.isError, true);
  assert.equal(submit.isError, true);
  assert.deepEqual(f.calls, callsBefore);
  assert.deepEqual(f.submits, []);
});

test('verified holder refuses a hold lost during verification or signing', async () => {
  const duringVerify = fixture(true);
  duringVerify.setOnVerify(() => duringVerify.setHeld(false));
  const read = await duringVerify.call();
  assert.equal(read.isError, true);
  assert.deepEqual(duringVerify.calls, ['raw-get', 'verify']);

  const duringSign = fixture(true);
  duringSign.setOnSign(() => duringSign.setHeld(false));
  const submit = await duringSign.submit({ path: 'out', value: { n: 1 } });
  assert.equal(submit.isError, true);
  assert.deepEqual(duringSign.calls, ['raw-get', 'verify', 'sign']);
  assert.deepEqual(duringSign.submits, []);
});

test('verified submit refuses when signing outlives the claim observation', async () => {
  const f = fixture(true);
  f.setOnSign(() => f.setNow(5));
  const result = await f.submit({ path: 'out', value: { n: 1 } });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /claim-observation-expired/);
  assert.deepEqual(f.calls, ['raw-get', 'verify', 'sign']);
  assert.deepEqual(f.submits, []);
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

test('opt-in verified submit signs the privately verified packet and returns only bounded status', async () => {
  const f = fixture(true);
  assert.deepEqual(f.wrapped.tools.map((tool) => tool.name), ['get_order', 'submit']);
  const result = await f.submit({ path: 'out', value: { n: 1 }, done: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(f.submits, [{
    workflow: 'wf', run: 'run', path: 'out', value: { n: 1 }, done: true,
    expectedVersion: 1, proof: 'SIGNED PROOF',
  }]);
  assert.deepEqual(f.calls, ['raw-get', 'verify', 'sign', 'conditional-submit']);
  assert.deepEqual(f.stops, [{ reason: 'submitted', release: false }]);
  assert.match(result.content[0]!.text, /local-hosted-submit-v1/);
  assert.doesNotMatch(result.content[0]!.text, /RAW|SIGNED PROOF|defDigest|lease/i);
});

test('verified submit refuses unlisted, collection, and unsigned values before transport', async () => {
  const unlisted = fixture(true);
  const wrong = await unlisted.submit({ path: 'other', value: { n: 1 } });
  assert.equal(wrong.isError, true);
  assert.match(wrong.content[0]!.text, /submit-path-not-verified/);
  assert.deepEqual(unlisted.submits, []);

  const collection = fixture(true);
  collection.setCollectionOutputs(['out']);
  const unsupported = await collection.submit({ path: 'out', value: { n: 1 } });
  assert.equal(unsupported.isError, true);
  assert.match(unsupported.content[0]!.text, /collection-submit-unsupported/);
  assert.deepEqual(collection.submits, []);

  const unsigned = fixture(true);
  unsigned.setProof(undefined);
  const refused = await unsigned.submit({ path: 'out', value: { n: 1 } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /submit-proof-unavailable/);
  assert.deepEqual(unsigned.submits, []);

  const feedback = fixture(true);
  feedback.setObservation({ protocol: 'local-hosted-order-v1', state: 'refused', code: 'unsupported-feedback' });
  const rework = await feedback.submit({ path: 'out', value: { n: 1 } });
  assert.equal(rework.isError, true);
  assert.match(rework.content[0]!.text, /unsupported-feedback/);
  assert.deepEqual(feedback.submits, []);
  assert.equal(feedback.calls.includes('sign'), false);
});

test('partial verified submit refreshes the direct order rather than the holder cached packet', async () => {
  const f = fixture(true);
  f.setSubmitResponse({ text: 'RAW', outcome: 'emitted', closed: false, conditionApplied: 'expected-version-v1' });
  const first = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.equal(first.isError, undefined);
  f.setPacket({ ...rawOrder, owes: [{ ...rawOrder.owes[0]!, version: 2 }] });
  const second = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.equal(second.isError, undefined);
  assert.deepEqual(f.submits.map((req) => req.expectedVersion), [1, 2]);
  assert.deepEqual(f.calls, [
    'raw-get', 'verify', 'sign', 'conditional-submit', 'verify', 'sign', 'conditional-submit',
  ]);
  assert.deepEqual(f.stops, []);
});

test('stale, absent route, and missing acknowledgement do not leak service text or retry legacy submit', async () => {
  const stale = fixture(true);
  stale.setSubmitError(new HubError(409, 'RAW HOSTILE STALE TEXT', 'stale_submit_condition'));
  const staleResult = await stale.submit({ path: 'out', value: { n: 1 } });
  assert.equal(staleResult.isError, true);
  assert.match(staleResult.content[0]!.text, /stale-submit-condition/);
  assert.doesNotMatch(staleResult.content[0]!.text, /RAW HOSTILE/);
  assert.equal(stale.submits.length, 1);

  const oldService = fixture(true);
  oldService.setSubmitError(new HubError(404, 'RAW OLD SERVICE ERROR', 'not_found'));
  const absent = await oldService.submit({ path: 'out', value: { n: 1 } });
  assert.equal(absent.isError, true);
  assert.match(absent.content[0]!.text, /conditional-submit-unavailable/);
  assert.equal(oldService.submits.length, 1);

  const noAck = fixture(true);
  noAck.setSubmitResponse({ text: 'RAW SUCCESS', outcome: 'green', closed: true } as ConditionalSubmitResponse);
  const ambiguous = await noAck.submit({ path: 'out', value: { n: 1 } });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0]!.text, /condition-ack-missing/);
  assert.doesNotMatch(ambiguous.content[0]!.text, /RAW SUCCESS/);
  assert.deepEqual(noAck.stops, [{ reason: 'submitted', release: false }]);

  const born = fixture(true);
  born.setSubmitResponse({ text: 'RAW BORN ERROR', outcome: 'born-rejected', closed: true, conditionApplied: 'expected-version-v1' });
  const bornResult = await born.submit({ path: 'out', value: { n: 1 } });
  assert.equal(bornResult.isError, true);
  assert.match(bornResult.content[0]!.text, /submit-not-accepted/);
  assert.doesNotMatch(bornResult.content[0]!.text, /RAW BORN/);
  assert.deepEqual(born.stops, [{ reason: 'submitted', release: false }]);

  const closed = fixture(true);
  closed.setSubmitError(new HubError(409, 'RAW CLOSED ERROR', 'run_closed'));
  const closedResult = await closed.submit({ path: 'out', value: { n: 1 } });
  assert.equal(closedResult.isError, true);
  assert.match(closedResult.content[0]!.text, /run-closed/);
  assert.deepEqual(closed.stops, [{ reason: 'submitted', release: false }]);
});
