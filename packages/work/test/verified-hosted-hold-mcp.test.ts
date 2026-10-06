import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVerifiedHostedHoldMcp } from '../src/hosted/verified-hold-mcp.ts';
import { createHoldMcp, type HoldMcpMount } from '../src/hold/mcp.ts';
import { hostedPacketDigest, type HostedOrderResult } from '../src/hosted/order-adapter.ts';
import type { HubClient } from '../src/hub/client.ts';
import { HubError, type ConditionalSubmitRequest, type ConditionalSubmitResponse, type GetOrderResponse, type OrderPacket } from '../src/hub/types.ts';
import { textResult, type ToolCallContext, type ToolRegistration } from '../src/mcp/server.ts';

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

function fixture(enableSubmit = false, settings: {
  open?: () => Promise<HostedOrderResult>;
  onRawGet?: (count: number) => Promise<void>;
  sign?: () => Promise<string | undefined>;
  context?: ToolCallContext;
  monotonicNow?: () => number;
  onConditionalSubmit?: (req: ConditionalSubmitRequest) => Promise<void> | void;
} = {}) {
  const calls: string[] = [];
  const submits: ConditionalSubmitRequest[] = [];
  const stops: Array<{ reason: string | undefined; release?: boolean }> = [];
  let observation: HostedOrderResult = ready();
  let holding = true;
  let rawGets = 0;
  let currentTime = 2;
  let currentMonotonicTime = 0;
  const heldOrder: OrderPacket = structuredClone(rawOrder);
  let verifiedPacket: OrderPacket = rawOrder;
  let collectionOutputs: string[] = [];
  let proof: string | undefined = 'SIGNED PROOF';
  let submitResponse: ConditionalSubmitResponse = {
    text: 'RAW HUB SUBMIT TEXT', outcome: 'green', closed: true, conditionApplied: 'expected-version-v1',
  };
  let submitError: unknown;
  const unsafeAction: ToolRegistration = {
    name: 'submit', description: 'unsafe', inputSchema: { type: 'object' },
    handler: async () => { calls.push('submit'); return textResult({ outcome: 'green' }); },
  };
  const mount: HoldMcpMount = {
    loop: { run: async () => 'completed', stop: (reason, options) => {
      holding = false;
      stops.push({ reason, ...(options?.release === undefined ? {} : { release: options.release }) });
    } },
    tools: [
      { name: 'get_order', description: 'raw', inputSchema: { type: 'object' }, handler: async () => {
	calls.push('raw-get');
	rawGets++;
	await settings.onRawGet?.(rawGets);
	if (!holding) return textResult({ error: 'order no longer held' }, true);
	return textResult({ workflow: 'wf', run: 'run', order: rawOrder, text: 'RAW HUB TEXT' });
      } },
      unsafeAction,
    ],
    readGatedOrder: () => holding ? {
      workflow: 'wf', run: 'run', order: heldOrder, text: 'PRIVATE HUB TEXT', lease: { claimed: true },
    } as GetOrderResponse : undefined,
  };
  const wrapped = createVerifiedHostedHoldMcp(mount, {
    open: async (ref, _index, onVerified) => {
      calls.push('verify');
      assert.deepEqual(ref, {
	protocol: 'client-preflight-v1', verification: 'not-performed',
	order: { state: 'available', workflow: 'wf', run: 'run', defDigest: rawOrder.defDigest },
      });
      if (observation.state === 'ready') onVerified?.({ order: verifiedPacket, collectionOutputs });
      return settings.open === undefined ? observation : settings.open();
    },
    submitConditional: async (req) => {
      calls.push('conditional-submit');
      submits.push(req);
      await settings.onConditionalSubmit?.(req);
      if (submitError !== undefined) throw submitError;
      return submitResponse;
    },
  }, { workflow: 'wf', run: 'run' }, enableSubmit ? {
    enableSubmit: true,
    signProof: async (order, path, value, version) => {
      calls.push('sign');
      assert.equal(order, verifiedPacket);
      assert.equal(path, 'out');
      assert.deepEqual(value, { n: 1 });
      assert.equal(version, verifiedPacket.owes[0]!.version);
      return settings.sign === undefined ? proof : settings.sign();
    },
    now: () => currentTime,
    monotonicNow: settings.monotonicNow ?? (() => currentMonotonicTime),
  } : { now: () => currentTime, monotonicNow: settings.monotonicNow ?? (() => currentMonotonicTime) });
  const call = () => wrapped.tools[0]!.handler({}, settings.context ?? context);
  const submit = (args: Record<string, unknown>) => wrapped.tools[1]!.handler(args, settings.context ?? context);
  return {
    wrapped, call, submit, calls, submits, stops,
    setObservation: (next: HostedOrderResult) => { observation = next; },
    setPacket: (next: OrderPacket) => { verifiedPacket = next; observation = ready(next); },
    setCollectionOutputs: (next: string[]) => { collectionOutputs = next; },
    setProof: (next: string | undefined) => { proof = next; },
    setTime: (next: number) => { currentTime = next; },
    setMonotonicTime: (next: number) => { currentMonotonicTime = next; },
    mutateHeldOrder: (mutate: (order: OrderPacket) => void) => { mutate(heldOrder); },
    setSubmitResponse: (next: ConditionalSubmitResponse) => { submitResponse = next; },
    setSubmitError: (next: unknown) => { submitError = next; },
  };
}

test('real hold keeps hidden authored fields private and fences full-packet drift', async () => {
  const full: OrderPacket = {
    ...structuredClone(rawOrder), spec: { privateInstruction: 'HUB-SPEC' },
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
  assert.match(raw.content[0]!.text, /HUB-SPEC|HUB-X|HUB-SCHEMA|HUB-TEXT/);
  assert.equal(hostedPacketDigest(mount.readGatedOrder()?.order), hostedPacketDigest(full));

  const wrapped = createVerifiedHostedHoldMcp(mount, {
    open: async (_ref, _index, onVerified) => {
      onVerified?.({ order: full, collectionOutputs: [] });
      return ready(full);
    },
  }, { workflow: 'wf', run: 'run' }, { now: () => 2, monotonicNow: () => 0 });
  const accepted = await wrapped.tools[0]!.handler({}, context);
  assert.equal(accepted.isError, undefined, accepted.content[0]?.text);
  assert.doesNotMatch(accepted.content[0]!.text, /HUB-SPEC|HUB-X|HUB-SCHEMA|HUB-TEXT/);
  assert.equal(hostedPacketDigest(wrapped.readGatedOrder()?.order), hostedPacketDigest(full));

  full.spec = { privateInstruction: 'CHANGED' };
  const changed = await wrapped.tools[0]!.handler({}, context);
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
  assert.deepEqual(f.calls, ['raw-get', 'verify', 'raw-get']);
});

test('a cached anchor cannot read or submit after the local hold stops', async () => {
  const f = fixture(true);
  const first = await f.call();
  assert.equal(first.isError, undefined);
  const verifiedBeforeStop = f.calls.filter((entry) => entry === 'verify').length;
  f.wrapped.loop.stop('signal');
  const later = await f.call();
  assert.equal(later.isError, true);
  assert.match(later.content[0]!.text, /holder-order-unavailable/);
  const submitted = await f.submit({ path: 'out', value: { n: 1 } });
  assert.equal(submitted.isError, true);
  assert.match(submitted.content[0]!.text, /holder-order-unavailable/);
  assert.equal(f.calls.filter((entry) => entry === 'verify').length, verifiedBeforeStop);
  assert.deepEqual(f.submits, []);
});

test('verification that outlives the local hold cannot show a ready order', async () => {
  let resolve!: (value: HostedOrderResult) => void;
  let started!: () => void;
  const pending = new Promise<HostedOrderResult>((done) => { resolve = done; });
  const verificationStarted = new Promise<void>((done) => { started = done; });
  const f = fixture(false, { open: async () => { started(); return pending; } });
  const call = f.call();
  await verificationStarted;
  f.wrapped.loop.stop('signal');
  resolve(ready());
  const result = await call;
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /holder-order-unavailable/);
});

test('a delayed holder recheck cannot show an expired ready observation', async () => {
  let resume!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((done) => { resume = done; });
  const secondReadStarted = new Promise<void>((done) => { started = done; });
  const f = fixture(false, {
    onRawGet: async (count) => { if (count === 2) { started(); await pending; } },
  });
  const call = f.call();
  await secondReadStarted;
  f.setTime(5);
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

test('opt-in verified submit signs the privately verified packet and returns only bounded status', async () => {
  const f = fixture(true);
  assert.deepEqual(f.wrapped.tools.map((tool) => tool.name), ['get_order', 'submit']);
  const result = await f.submit({ path: 'out', value: { n: 1 }, done: true });
  assert.equal(result.isError, undefined);
  assert.deepEqual(f.submits, [{
    workflow: 'wf', run: 'run', path: 'out', value: { n: 1 }, done: true,
    expectedVersion: 1, proof: 'SIGNED PROOF',
  }]);
  assert.deepEqual(f.calls, ['raw-get', 'verify', 'raw-get', 'sign', 'raw-get', 'conditional-submit']);
  assert.deepEqual(f.stops, [{ reason: 'submitted', release: false }]);
  assert.match(result.content[0]!.text, /local-hosted-submit-v1/);
  assert.doesNotMatch(result.content[0]!.text, /RAW|SIGNED PROOF|defDigest|lease/i);
});

test('a stop during proof signing prevents conditional submit', async () => {
  let resolve!: (value: string) => void;
  let started!: () => void;
  const pending = new Promise<string>((done) => { resolve = done; });
  const signingStarted = new Promise<void>((done) => { started = done; });
  const f = fixture(true, { sign: async () => { started(); return pending; } });
  const call = f.submit({ path: 'out', value: { n: 1 } });
  await signingStarted;
  f.wrapped.loop.stop('signal');
  resolve('SIGNED PROOF');
  const result = await call;
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /holder-order-unavailable/);
  assert.deepEqual(f.submits, []);
});

test('a hidden private field change during signing prevents conditional submit', async () => {
  let resolve!: (value: string) => void;
  let started!: () => void;
  const pending = new Promise<string>((done) => { resolve = done; });
  const signingStarted = new Promise<void>((done) => { started = done; });
  const f = fixture(true, { sign: async () => { started(); return pending; } });
  const call = f.submit({ path: 'out', value: { n: 1 } });
  await signingStarted;
  f.mutateHeldOrder((order) => { order.spec = { hidden: 'changed' }; });
  resolve('SIGNED PROOF');
  const result = await call;
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /holder-order-changed/);
  assert.deepEqual(f.submits, []);
});

test('monotonic elapsed time fences a wall-clock rollback during signing', async () => {
  let resolve!: (value: string) => void;
  let started!: () => void;
  const pending = new Promise<string>((done) => { resolve = done; });
  const signingStarted = new Promise<void>((done) => { started = done; });
  const f = fixture(true, { sign: async () => { started(); return pending; } });
  const call = f.submit({ path: 'out', value: { n: 1 } });
  await signingStarted;
  f.setTime(2);
  f.setMonotonicTime(4);
  resolve('SIGNED PROOF');
  const result = await call;
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /claim-observation-expired/);
  assert.deepEqual(f.submits, []);
});

test('an observation that expires during signing prevents conditional submit', async () => {
  let resolve!: (value: string) => void;
  let started!: () => void;
  const pending = new Promise<string>((done) => { resolve = done; });
  const signingStarted = new Promise<void>((done) => { started = done; });
  const f = fixture(true, { sign: async () => { started(); return pending; } });
  const call = f.submit({ path: 'out', value: { n: 1 } });
  await signingStarted;
  f.setTime(5);
  resolve('SIGNED PROOF');
  const result = await call;
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /claim-observation-expired/);
  assert.deepEqual(f.submits, []);
});

test('cancellation during the final holder check prevents conditional submit', async () => {
  let resume!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((done) => { resume = done; });
  const finalReadStarted = new Promise<void>((done) => { started = done; });
  let cancelled = false;
  const callContext: ToolCallContext = { get cancelled() { return cancelled; }, onCancel: () => {}, sendProgress: () => {} };
  const f = fixture(true, {
    context: callContext,
    onRawGet: async (count) => { if (count === 3) { started(); await pending; } },
  });
  const call = f.submit({ path: 'out', value: { n: 1 } });
  await finalReadStarted;
  cancelled = true;
  resume();
  const result = await call;
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /call-cancelled/);
  assert.deepEqual(f.submits, []);
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
    'raw-get', 'verify', 'raw-get', 'sign', 'raw-get', 'conditional-submit',
    'raw-get', 'verify', 'raw-get', 'sign', 'raw-get', 'conditional-submit',
  ]);
  assert.deepEqual(f.stops, []);
});

test('lost open partial-submit acknowledgement requires visible order reconciliation before another submit', async () => {
  let committed = false;
  let f: ReturnType<typeof fixture>;
  f = fixture(true, { onConditionalSubmit: () => {
    if (committed) return;
    committed = true;
    // The Service commits version 1 and advances the owed target, but its
    // response is lost after the commit.
    f.setPacket({ ...rawOrder, owes: [{ ...rawOrder.owes[0]!, version: 2 }] });
    throw new Error('transport lost after commit');
  } });
  f.setSubmitResponse({ text: 'RAW', outcome: 'emitted', closed: false, conditionApplied: 'expected-version-v1' });
  const first = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.equal(first.isError, true);
  assert.match(first.content[0]!.text, /submit-result-unknown/);
  assert.deepEqual(f.submits.map((req) => req.expectedVersion), [1]);

  const before = f.calls.length;
  const directRetry = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.equal(directRetry.isError, true);
  assert.match(directRetry.content[0]!.text, /submit-reconciliation-required/);
  assert.equal(f.calls.length, before, 'an internal reverify cannot silently retry the committed partial submit');
  assert.deepEqual(f.submits.map((req) => req.expectedVersion), [1]);

  f.setObservation({ protocol: 'local-hosted-order-v1', state: 'refused', code: 'order-unavailable' });
  const unavailable = await f.call();
  assert.equal(unavailable.isError, true);
  const stillBlocked = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.match(stillBlocked.content[0]!.text, /submit-reconciliation-required/);

  f.setPacket({ ...rawOrder, owes: [{ ...rawOrder.owes[0]!, version: 2 }] });
  const visible = await f.call();
  assert.equal(visible.isError, undefined);
  const visibleOrder = JSON.parse(visible.content[0]!.text) as {
    outputs: Array<{ version: number }>;
    reconciliation: { submitToken: string };
  };
  assert.equal(visibleOrder.outputs[0]!.version, 2);
  assert.equal(typeof visibleOrder.reconciliation.submitToken, 'string');
  const unseenRetry = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.match(unseenRetry.content[0]!.text, /submit-reconciliation-required/);
  const afterVisibleRead = await f.submit({
    path: 'out', value: { n: 1 }, done: false, reconciliationToken: visibleOrder.reconciliation.submitToken,
  });
  assert.equal(afterVisibleRead.isError, undefined);
  assert.deepEqual(f.submits.map((req) => req.expectedVersion), [1, 2]);
});

test('an older concurrent order read cannot reconcile a newer ambiguous submit', async () => {
  let finishG1!: (result: HostedOrderResult) => void;
  let finishG2!: (result: HostedOrderResult) => void;
  let bothStarted!: () => void;
  const g1Pending = new Promise<HostedOrderResult>((resolve) => { finishG1 = resolve; });
  const g2Pending = new Promise<HostedOrderResult>((resolve) => { finishG2 = resolve; });
  const readsStarted = new Promise<void>((resolve) => { bothStarted = resolve; });
  let opens = 0;
  let committed = 0;
  let currentPacket = rawOrder;
  let f: ReturnType<typeof fixture>;
  f = fixture(true, {
    open: async () => {
      opens++;
      if (opens === 2) return g1Pending;
      if (opens === 3) { bothStarted(); return g2Pending; }
      return ready(currentPacket);
    },
    onConditionalSubmit: () => {
      if (committed >= 2) return;
      committed++;
      currentPacket = { ...rawOrder, owes: [{ ...rawOrder.owes[0]!, version: committed + 1 }] };
      f.setPacket(currentPacket);
      throw new Error('transport lost after commit');
    },
  });
  f.setSubmitResponse({ text: 'RAW', outcome: 'emitted', closed: false, conditionApplied: 'expected-version-v1' });

  const first = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.match(first.content[0]!.text, /submit-result-unknown/);
  assert.deepEqual(f.submits.map((req) => req.expectedVersion), [1]);

  const g1 = f.call();
  const g2 = f.call();
  await readsStarted;
  finishG1(ready(currentPacket));
  const visibleG1 = await g1;
  assert.equal(visibleG1.isError, undefined, visibleG1.content[0]?.text);
  const oldToken = (JSON.parse(visibleG1.content[0]!.text) as {
    reconciliation: { submitToken: string };
  }).reconciliation.submitToken;

  const second = await f.submit({
    path: 'out', value: { n: 1 }, done: false, reconciliationToken: oldToken,
  });
  assert.match(second.content[0]!.text, /submit-result-unknown/);
  assert.deepEqual(f.submits.map((req) => req.expectedVersion), [1, 2]);

  // G2 began before the second uncertainty. Its old observation cannot mint
  // a token for the new reconciliation epoch after it completes.
  finishG2(ready({ ...rawOrder, owes: [{ ...rawOrder.owes[0]!, version: 2 }] }));
  const superseded = await g2;
  assert.equal(superseded.isError, true);
  assert.match(superseded.content[0]!.text, /reconciliation-superseded/);
  const staleRetry = await f.submit({
    path: 'out', value: { n: 1 }, done: false, reconciliationToken: oldToken,
  });
  assert.match(staleRetry.content[0]!.text, /submit-reconciliation-required/);
  assert.deepEqual(f.submits.map((req) => req.expectedVersion), [1, 2]);

  const visibleG3 = await f.call();
  assert.equal(visibleG3.isError, undefined, visibleG3.content[0]?.text);
  const fresh = JSON.parse(visibleG3.content[0]!.text) as {
    outputs: Array<{ version: number }>;
    reconciliation: { submitToken: string };
  };
  assert.equal(fresh.outputs[0]!.version, 3);
  assert.notEqual(fresh.reconciliation.submitToken, oldToken);
  const third = await f.submit({
    path: 'out', value: { n: 1 }, done: false, reconciliationToken: fresh.reconciliation.submitToken,
  });
  assert.equal(third.isError, undefined, third.content[0]?.text);
  assert.deepEqual(f.submits.map((req) => req.expectedVersion), [1, 2, 3]);
});

test('a concurrent submit cannot bypass an in-flight ambiguous conditional mutation', async () => {
  let reject!: (reason: Error) => void;
  let started!: () => void;
  const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  const submitting = new Promise<void>((done) => { started = done; });
  const f = fixture(true, { onConditionalSubmit: async () => { started(); await pending; } });
  f.setSubmitResponse({ text: 'RAW', outcome: 'emitted', closed: false, conditionApplied: 'expected-version-v1' });
  const firstCall = f.submit({ path: 'out', value: { n: 1 }, done: false });
  await submitting;
  const concurrent = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.equal(concurrent.isError, true);
  assert.match(concurrent.content[0]!.text, /submit-in-progress/);
  assert.equal(f.submits.length, 1);
  reject(new Error('transport lost after commit'));
  const ambiguous = await firstCall;
  assert.match(ambiguous.content[0]!.text, /submit-result-unknown/);
  const later = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.match(later.content[0]!.text, /submit-reconciliation-required/);
  assert.equal(f.submits.length, 1);
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
