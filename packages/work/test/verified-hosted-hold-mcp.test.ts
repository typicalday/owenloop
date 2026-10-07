import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVerifiedHostedHoldMcp } from '../src/hosted/verified-hold-mcp.ts';
import { createHostedOrderAdapter, hostedPacketDigest, hostedReferencePacketDigest, type HostedOrderResult } from '../src/hosted/order-adapter.ts';
import { HubError, type ConditionalSubmitRequest, type ConditionalSubmitResponse, type OrderPacket } from '../src/hub/types.ts';
import { textResult, type ToolCallContext, type ToolRegistration } from '../src/mcp/server.ts';
import { createHoldMcp, type HoldMcpMount } from '../src/hold/mcp.ts';
import type { HubClient } from '../src/hub/client.ts';
import { createBundleIngestor } from '../../../src/store/index.ts';

const context: ToolCallContext = { cancelled: false, onCancel: () => {}, sendProgress: () => {} };
const rawOrder: OrderPacket = {
  workflow: 'wf', run: 'run', step: 'make', defDigest: 'a'.repeat(64),
  key: '', inputs: [], outputs: ['out'], consumes: {}, consumedFingerprint: {},
  owes: [{ path: 'out', version: 1, judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
};

function ready(packet = rawOrder): HostedOrderResult {
  return {
    protocol: 'local-hosted-order-v1', state: 'ready',
    serviceObservation: {
      workflow: 'wf', run: 'run', step: 'make', packetDigest: hostedReferencePacketDigest(packet)!,
      observedAt: 1, expiresAt: 5,
    },
    definition: {
      bodyTrust: 'verified-local-publication', substitutions: 'trusted-service-observation',
      digest: rawOrder.defDigest, prompt: 'VERIFIED INSTRUCTION',
    },
    consumes: [], outputs: [{ path: 'out', version: packet.owes[0]!.version!, versionTrust: 'trusted-service-observation' }],
  };
}

function reducedOrder(order: OrderPacket) {
  return { workflow: order.workflow, run: order.run, step: order.step, key: order.key,
    defDigest: order.defDigest, inputs: order.inputs, outputs: order.outputs,
    consumes: order.consumes, owes: order.owes.map((owed) => ({ path: owed.path,
      ...(owed.version === undefined ? {} : { version: owed.version }),
      judgmentRejects: owed.judgmentRejects, schemaRejects: owed.schemaRejects, reasons: owed.reasons })) };
}

function fixture(enableSubmit = false, settings: {
  open?: () => Promise<HostedOrderResult>;
  onRawGet?: (count: number, order: OrderPacket) => Promise<void>;
  sign?: () => Promise<string | undefined>;
  onConditionalSubmit?: (req: ConditionalSubmitRequest) => Promise<void> | void;
  context?: ToolCallContext;
} = {}) {
  const calls: string[] = [];
  const submits: ConditionalSubmitRequest[] = [];
  const stops: Array<{ reason: string | undefined; release?: boolean }> = [];
  let observation: HostedOrderResult = ready();
  let holding = true;
  let rawGets = 0;
  const heldOrder: OrderPacket = structuredClone(rawOrder);
  let currentTime = 2;
  let monotonicTime = 0;
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
	await settings.onRawGet?.(rawGets, heldOrder);
	if (!holding) return textResult({ error: 'order no longer held' }, true);
	return textResult({ workflow: 'wf', run: 'run', order: reducedOrder(heldOrder) });
      } },
      unsafeAction,
    ],
    readGatedOrder: () => holding
      ? { text: 'RAW HUB TEXT', workflow: 'wf', run: 'run', order: heldOrder, lease: { claimed: true } }
      : undefined,
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
    monotonicNow: () => monotonicTime,
  } : { now: () => currentTime, monotonicNow: () => monotonicTime });
  const call = () => wrapped.tools[0]!.handler({}, settings.context ?? context);
  const submit = (args: Record<string, unknown>) => wrapped.tools[1]!.handler(args, settings.context ?? context);
  return {
    wrapped, call, submit, calls, submits, stops,
    setObservation: (next: HostedOrderResult) => { observation = next; },
    setPacket: (next: OrderPacket) => { verifiedPacket = next; observation = ready(next); },
    setCollectionOutputs: (next: string[]) => { collectionOutputs = next; },
    setProof: (next: string | undefined) => { proof = next; },
    setTime: (next: number) => { currentTime = next; },
    setMonotonicTime: (next: number) => { monotonicTime = next; },
    setSubmitResponse: (next: ConditionalSubmitResponse) => { submitResponse = next; },
    setSubmitError: (next: unknown) => { submitError = next; },
    mutateHeldOrder: (mutate: (order: OrderPacket) => void) => { mutate(heldOrder); },
  };
}

test('real hold keeps authored fields private and fences a changed gated full order', async () => {
  const full: OrderPacket = {
    ...structuredClone(rawOrder), spec: { privateInstruction: 'HUB-SPEC' },
    x: { privateInstruction: 'HUB-X' },
    owes: [{ ...rawOrder.owes[0]!, schema: { privateInstruction: 'HUB-SCHEMA' } }],
  };
  const response = { text: 'HUB-TEXT', workflow: 'wf', run: 'run', order: full, lease: { claimed: true } };
  const hub = { getOrder: async () => response } as unknown as HubClient;
  const mount = createHoldMcp({
    hub, workflow: 'wf', run: 'run', workdir: process.cwd(), tools: ['get_order'],
    modelOrderVerifier: async () => ({ ok: true }),
    sleep: async () => {}, now: () => 0, err: () => {},
  });
  const raw = await mount.tools[0]!.handler({}, context);
  assert.equal(raw.isError, undefined);
  assert.doesNotMatch(raw.content[0]!.text, /HUB-SPEC|HUB-X|HUB-SCHEMA|HUB-TEXT/);
  assert.equal(hostedPacketDigest(mount.readGatedOrder()?.order), hostedPacketDigest(full));

  const wrapped = createVerifiedHostedHoldMcp(mount, {
    open: async (_ref, _index, onVerified) => {
      onVerified?.({ order: rawOrder, collectionOutputs: [] });
      return ready(rawOrder);
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

test('real reduced hold cannot fall back when Service lacks the versioned reference acknowledgement', async () => {
  const hub = { getOrder: async () => ({ text: 'RAW HUB TEXT', workflow: 'wf', run: 'run',
    order: rawOrder, lease: { claimed: true } }) } as unknown as HubClient;
  const mount = createHoldMcp({
    hub, workflow: 'wf', run: 'run', workdir: process.cwd(), tools: ['get_order'],
    modelOrderVerifier: async () => ({ ok: true }),
    sleep: async () => {}, now: () => 0, err: () => {},
  });
  let reads = 0;
  const adapter = createHostedOrderAdapter({
    hub: { origin: 'https://trusted.example', getToken: async () => 'local-secret',
      fetchImpl: async (input) => {
	reads++;
	assert.equal(String(input), 'https://trusted.example/api/reference_order/v1');
	return new Response(JSON.stringify({ error: 'not_found', text: 'RAW OLD SERVICE' }), { status: 404 });
      } },
    expected: { workflowId: 'wf', runId: 'run' },
    instructionSource: { globalRoot: '/unused', verifier: createBundleIngestor() },
    consumeTrust: { env: {} }, now: () => 2,
  });
  const wrapped = createVerifiedHostedHoldMcp(mount, adapter, { workflow: 'wf', run: 'run' }, { now: () => 2 });
  const result = await wrapped.tools[0]!.handler({}, context);
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /reference-read-unavailable/);
  assert.doesNotMatch(result.content[0]!.text, /RAW OLD SERVICE|RAW HUB TEXT/);
  assert.equal(reads, 1);
});

test('verified holder exposes only the verified projection and no mutation tools', async () => {
  const f = fixture();
  assert.deepEqual(f.wrapped.tools.map((tool) => tool.name), ['get_order']);
  const shown = await f.call();
  assert.equal(shown.isError, undefined, shown.content[0]?.text);
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

test('private modifier, cause, and feedback shapes absent from Service v1 refuse before a wire read', async () => {
  for (const mutate of [
    (order: OrderPacket) => { order.modifier = 'deep'; },
    (order: OrderPacket) => { order.cause = 'rework'; },
    (order: OrderPacket) => { order.owes[0]!.reasons = [{ at: 1, action: 'reject', kind: 'human', by: 'human', text: 'hidden' }]; },
  ]) {
    const f = fixture();
    f.mutateHeldOrder(mutate);
    const result = await f.call();
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /holder-order-unavailable/);
    assert.deepEqual(f.calls, ['raw-get']);
    assert.doesNotMatch(result.content[0]!.text, /deep|rework|hidden/);
  }
});

test('private execution and routing stamps omitted by Service v1 refuse before a wire read', async () => {
  const unsupported: Array<(order: OrderPacket) => void> = [
    (order) => { order.worker = 'command'; },
    (order) => { order.workdir = '/private/host'; },
    (order) => { order.capabilities = []; },
    (order) => { order.crews = ['review']; },
    (order) => { (order as OrderPacket & { reroutedFrom: string }).reroutedFrom = 'base'; },
    (order) => { order.escalated = false; },
    (order) => { order.model = 'hidden'; },
    (order) => { order.judge = 'out'; },
  ];
  for (const mutate of unsupported) {
    const f = fixture();
    f.mutateHeldOrder(mutate);
    const result = await f.call();
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /holder-order-unavailable/);
    assert.deepEqual(f.calls, ['raw-get']);
    assert.doesNotMatch(result.content[0]!.text, /command|private|review|hidden|base/);
  }
  const explicitDefault = fixture();
  explicitDefault.mutateHeldOrder((order) => { order.worker = 'agent'; });
  const accepted = await explicitDefault.call();
  assert.equal(accepted.isError, undefined, accepted.content[0]?.text);
});

test('unreviewed raw order and owed fields refuse before a v1 read while known authored fields remain local', async () => {
  for (const mutate of [
    (order: OrderPacket) => { (order as OrderPacket & { futureRouting: string }).futureRouting = 'HOSTILE NEW ROUTE'; },
    (order: OrderPacket) => { (order.owes[0] as OrderPacket['owes'][number] & { futureFeedback: string }).futureFeedback = 'HOSTILE NEW FEEDBACK'; },
  ]) {
    const f = fixture();
    f.mutateHeldOrder(mutate);
    const result = await f.call();
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /holder-order-unavailable/);
    assert.deepEqual(f.calls, ['raw-get']);
    assert.doesNotMatch(result.content[0]!.text, /HOSTILE/);
  }
  const authored = fixture();
  authored.mutateHeldOrder((order) => {
    order.spec = { signed: true };
    order.x = { policy: 'local' };
    order.owes[0]!.schema = { type: 'object' };
    order.owes[0]!.schemaAppliesTo = 'value';
  });
  const accepted = await authored.call();
  assert.equal(accepted.isError, undefined, accepted.content[0]?.text);
});

test('a hidden raw field mutation during verification is fenced by the full hold digest', async () => {
  const f = fixture(false, {
    onRawGet: async (count, order) => { if (count === 2) order.spec = { hidden: 'changed' }; },
  });
  const result = await f.call();
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /holder-order-changed/);
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

test('a hidden raw field mutation during proof signing prevents conditional submit', async () => {
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

test('monotonic elapsed time fences a wall-clock rollback during signing on v1', async () => {
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

test('lost partial v1 acknowledgement requires visible token reconciliation', async () => {
  let committed = false;
  let f: ReturnType<typeof fixture>;
  f = fixture(true, { onConditionalSubmit: () => {
    if (committed) return;
    committed = true;
    f.setPacket({ ...rawOrder, owes: [{ ...rawOrder.owes[0]!, version: 2 }] });
    throw new Error('transport lost after commit');
  } });
  f.setSubmitResponse({ text: 'RAW', outcome: 'emitted', closed: false, conditionApplied: 'expected-version-v1' });
  const first = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.match(first.content[0]!.text, /submit-result-unknown/);
  assert.deepEqual(f.submits.map((req) => req.expectedVersion), [1]);
  const before = f.calls.length;
  const retry = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.match(retry.content[0]!.text, /submit-reconciliation-required/);
  assert.equal(f.calls.length, before);
  const visible = await f.call();
  assert.equal(visible.isError, undefined, visible.content[0]?.text);
  const state = JSON.parse(visible.content[0]!.text) as {
    outputs: Array<{ version: number }>;
    reconciliation: { submitToken: string };
  };
  assert.equal(state.outputs[0]!.version, 2);
  assert.equal(typeof state.reconciliation.submitToken, 'string');
  const unseen = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.match(unseen.content[0]!.text, /submit-reconciliation-required/);
  const second = await f.submit({
    path: 'out', value: { n: 1 }, done: false, reconciliationToken: state.reconciliation.submitToken,
  });
  assert.equal(second.isError, undefined, second.content[0]?.text);
  assert.deepEqual(f.submits.map((req) => req.expectedVersion), [1, 2]);
});

test('a concurrent submit cannot bypass an in-flight ambiguous v1 mutation', async () => {
  let reject!: (reason: Error) => void;
  let started!: () => void;
  const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  const submitting = new Promise<void>((done) => { started = done; });
  const f = fixture(true, { onConditionalSubmit: async () => { started(); await pending; } });
  f.setSubmitResponse({ text: 'RAW', outcome: 'emitted', closed: false, conditionApplied: 'expected-version-v1' });
  const firstCall = f.submit({ path: 'out', value: { n: 1 }, done: false });
  await submitting;
  const concurrent = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.match(concurrent.content[0]!.text, /submit-in-progress/);
  assert.equal(f.submits.length, 1);
  reject(new Error('transport lost after commit'));
  const ambiguous = await firstCall;
  assert.match(ambiguous.content[0]!.text, /submit-result-unknown/);
  const later = await f.submit({ path: 'out', value: { n: 1 }, done: false });
  assert.match(later.content[0]!.text, /submit-reconciliation-required/);
  assert.equal(f.submits.length, 1);
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

test('later Service reads cannot change stable claim identity, consumes, proof, or owed path', async () => {
  const variants: OrderPacket[] = [
    { ...rawOrder, step: 'other' },
    { ...rawOrder, key: 'other-key' },
    { ...rawOrder, consumes: { in: { hostile: true } } },
    { ...rawOrder, consumesProof: 'other-proof' },
    { ...rawOrder, owes: [{ ...rawOrder.owes[0]!, path: 'other-path' }] },
  ];
  for (const changed of variants) {
    const f = fixture();
    const first = await f.call();
    assert.equal(first.isError, undefined);
    f.setPacket(changed);
    const later = await f.call();
    assert.equal(later.isError, true);
    assert.match(later.content[0]!.text, /holder-order-changed/);
  }
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

test('an older v1 read cannot reconcile a newer ambiguous submit', async () => {
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
