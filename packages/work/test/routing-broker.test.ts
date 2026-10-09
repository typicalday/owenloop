import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { valueDigestHex } from '../../../src/crypto/canonical.ts';
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';

import { createHubClient } from '../src/hub/client.ts';
import { createRoutingChildClient } from '../src/hub/routing-child-client.ts';
import { createRoutingHolderClient } from '../src/hub/routing-holder-client.ts';
import { parseRoutedReferenceV2, type RoutedClaimV2,
  type RoutedReferenceV2 } from '../src/hosted/trusted-routed-reference-v2.ts';
import { openRoutedFileSource } from '../src/hub/routed-file-source.ts';
import type { DecisionBindingV1, OrderPacket, ReferenceRouting } from '../src/hub/types.ts';
import { createRoutingBroker } from '../src/shift/routing-broker.ts';
import type { RoutingHandoffV1 } from '../src/shift/runtime.ts';
import type { ChildReservation } from '../src/shift/state.ts';

const origin = 'https://hub.example';
const sessionId = 'rs_12345678-1234-1234-1234-123456789abc';
const credential = `rs1.${sessionId}.${'x'.repeat(43)}`;
const identity = { orgId: 'org', principalId: 'agent', sessionId, shiftId: 'shf_service', expiresAt: 90_000 };
const binding: DecisionBindingV1 = {
  orgId: 'org', runId: 'wf', frameId: 'frame',
  def: { bundleDigest: 'sha256:bundle', workflowName: 'wf' }, subjectKey: 'subject',
  evidenceDigest: 'sha256:evidence', candidateDigest: 'sha256:candidates', policyDigest: 'sha256:policy',
  revisions: { definition: '1', candidates: '1', policy: '1', authority: '1', rolePolicy: '1',
	roster: '1', routes: '1', membership: '1', evidenceGeneration: '1' },
  issuedAt: 1_000, expiresAt: 80_000, authority: { principalId: 'agent', sessionId },
};
const reservation: ChildReservation = {
  recordType: 'reservation', workflow: 'wf', run: 'run', childKind: 'exec',
  reservedAt: 1_000, token: 'a'.repeat(32),
};
const child = { workflow: 'wf', run: 'run', kind: 'exec' as const, pid: 9001,
  spawnedAt: 1_000, gateToken: reservation.token };
const holder = { kind: 'exec' as const, id: `${hostname()}:9001`, shiftId: identity.shiftId };
const orderResponse = { text: 'ok', workflow: 'wf', run: 'run', lease: { claimed: true },
  order: { workflow: 'wf', run: 'run', outputs: ['out'], owes: [{ path: 'out' }] } };
const handoffFor = (broker: { socketPath: string; cap: string }, reserved = reservation): RoutingHandoffV1 => ({
  version: 'routing-handoff-v1', incarnation: 'inc_' + 'a'.repeat(32), nonce: 'b'.repeat(32),
  origin, orgId: identity.orgId, sessionId, shiftId: identity.shiftId,
  broker: { socketPath: broker.socketPath, cap: broker.cap }, reservation: reserved,
  createdAt: 1_000, expiresAt: 50_000, sessionExpiresAt: identity.expiresAt,
});
const routing = {
  claim: { state: 'claimed', claimId: 'run', decisionId: 'decision', binding,
    invocationId: null, orderId: 'run', attemptId: 'run', principalId: 'agent',
    sessionId, shiftId: 'shf_service' },
  decision: { decisionId: 'decision', binding, status: 'applied', applied: null, effect: null },
  preference: { offer: null, tuples: [], role: 'implementation', rolePolicy: null,
    rosterRevision: 'roster-v1', expiresAt: 70_000 },
} as ReferenceRouting;

const transportLaunchAuthority = { verifySelection: async () => {} };
const transportAuthority = { verifyOrder: async () => {}, canSubmit: () => true, sign: async () => 'parent-proof' };

function request(socketPath: string, value: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let raw = '';
    socket.once('connect', () => socket.write(JSON.stringify(value) + '\n'));
    socket.on('data', chunk => {
      raw += chunk.toString('utf8');
      if (!raw.includes('\n')) return;
      socket.destroy();
      try { resolve(JSON.parse(raw.slice(0, raw.indexOf('\n'))) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
    socket.once('error', reject);
  });
}

test('private routed broker binds one dispatch and proxies only scoped requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-routing-broker-'));
  const calls: Array<{ verb: string; init: RequestInit }> = [];
  let live = { ...identity };
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...live, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      const verb = String(url).split('/').at(-1)!;
      calls.push({ verb, init: init! });
      if (verb === 'reserve_launch') return Response.json({ reservationId: 'lr_one', orderId: 'run', expiresAt: 40_000 });
      if (verb === 'report_launch') return Response.json({ orderId: 'run', digest: valueDigestHex(JSON.parse(String(init!.body)).report), recordedAt: 2_000, provenance: 'authenticated-worker-report' });
      return Response.json(verb === 'get_order' ? orderResponse : { text: 'ok' });
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    assert.equal(statSync(broker.socketPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(broker.socketPath, '..')).mode & 0o777, 0o700);
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => live, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    const send = (method: string, body: unknown, cap = grant.cap) => request(grant.socketPath, { cap, method, body });
    assert.equal((await send('get_order', { holder })).ok, false, 'pending grant cannot reach Hub before start gate');
    assert.equal(calls.length, 0);
    grant.activate(child);
    assert.throws(() => grant.activate({ ...child, pid: 9002 }), /grant unavailable/);
    assert.equal((await send('get_order', { holder })).ok, true);
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { workflow: 'wf', run: 'run', holder });
    assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'), 'Bearer enrolled');
    assert.equal(new Headers(calls[0]!.init.headers).get('X-Owenloop-Routing-Session'), credential);
    assert.equal((await send('get_order', { workflow: 'other', holder })).ok, false);
    assert.equal((await send('get_order', { holder }, 'b'.repeat(64))).ok, false);
    assert.equal((await send('heartbeat', {})).ok, false);
    assert.deepEqual(calls.map(call => call.verb), ['get_order']);

    const report = { version: 'launch-v1', reservationId: 'lr_one', decisionId: 'decision',
      binding, claimId: 'run', orderId: 'run', attemptId: 'run',
      requested: null, selected: null, observation: { state: 'unknown' } };
    assert.equal((await send('report_launch', { report })).ok, false);
    const launch = { version: 'launch-reservation-v1', claimId: 'run', decisionId: 'decision',
      binding, orderId: 'run', attemptId: 'run', rosterRevision: 'roster-v1', candidateIds: [],
      assessmentId: null, requested: null, selected: null };
    assert.equal((await send('reserve_launch', { request: { ...launch, orderId: 'other' } })).ok, false);
    assert.equal((await send('reserve_launch', { request: launch })).ok, true);
    assert.equal((await send('report_launch', { report })).ok, true);
    assert.deepEqual(calls.map(call => call.verb), ['get_order', 'get_order', 'reserve_launch', 'get_order', 'report_launch']);
    grant.terminal();
    assert.equal((await send('get_order', { holder })).ok, false);
    assert.equal(calls.length, 5);
    live = { ...live, sessionId: 'rs_changed' };
    assert.throws(() => broker.issue({ reservation, routing, identity, currentIdentity: () => live, hub }),
      /grant refused/);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('role quiesce freezes holder and role writes, waits for a known ask ACK, and permits heartbeat', async () => {
  let beginAsk!: () => void;
  let completeAsk!: () => void;
  const askStarted = new Promise<void>(resolve => { beginAsk = resolve; });
  const askReply = new Promise<void>(resolve => { completeAsk = resolve; });
  const calls: string[] = [];
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url) => {
      const parts = String(url).split('/');
      const verb = parts.at(-1) === 'v1' ? parts.at(-2)! : parts.at(-1)!;
      calls.push(verb);
      if (verb === 'routing_ask') { beginAsk(); await askReply; return Response.json({ text: 'answer', ok: true }); }
      if (verb === 'get_order') return Response.json(orderResponse);
      if (verb === 'heartbeat') return Response.json({ text: 'ok', ok: true });
      throw new Error(`unexpected routed mutation ${verb}`);
    }) as typeof fetch });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation: { ...reservation, childKind: 'agent-run' },
      routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority });
    assert.equal((await request(grant.socketPath, { cap: grant.cap,
      method: 'quiesce', body: {} })).ok, false, 'pending cap cannot freeze an unstarted dispatch');
    grant.activate({ ...child, kind: 'agent-run' });
    const role = createRoutingChildClient(handoffFor(grant, { ...reservation, childKind: 'agent-run' }));
    const holderCap = grant.holder!.cap;
    assert.equal((await request(grant.socketPath, { cap: holderCap, method: 'quiesce', body: {} })).ok, false);
    assert.equal((await request(grant.socketPath, { cap: grant.cap,
      method: 'quiesce', body: { seal: true } })).ok, false);
    await role.getOrder({ workflow: 'wf', run: 'run', holder });
    const pendingAsk = role.ask({ workflow: 'wf', run: 'run', path: 'out', question: 'question' });
    await askStarted;
    const pendingFreeze = role.quiesce();
    const frozen = grant.quiesce();
    await assert.rejects(role.release({ workflow: 'wf', run: 'run' }), /routing broker unavailable/);
    assert.equal((await request(grant.socketPath, { cap: holderCap, method: 'ask',
      body: { path: 'out', question: 'later' } })).ok, false);
    assert.equal(calls.filter(verb => verb === 'routing_ask').length, 1);
    completeAsk();
    assert.equal((await pendingAsk).ok, true);
    assert.deepEqual(await frozen, { quiescing: true, effects: 'settled' });
    assert.deepEqual(await pendingFreeze, { quiescing: true, effects: 'settled' });
    assert.equal((await role.heartbeat({ workflow: 'wf', run: 'run', holder })).text, 'ok');
  } finally { await broker.close(); }
});

test('quiesce reports an uncertain already-dispatched ask when its ACK is lost', async () => {
  let beginAsk!: () => void;
  let loseAsk!: () => void;
  const askStarted = new Promise<void>(resolve => { beginAsk = resolve; });
  const lost = new Promise<void>(resolve => { loseAsk = resolve; });
  let writes = 0;
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url) => {
      const parts = String(url).split('/');
      const verb = parts.at(-1) === 'v1' ? parts.at(-2)! : parts.at(-1)!;
      if (verb === 'get_order') return Response.json(orderResponse);
      if (verb === 'routing_ask') { writes++; beginAsk(); await lost; throw new Error('lost ACK'); }
      throw new Error(`unexpected routed mutation ${verb}`);
    }) as typeof fetch });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity,
      hub, submissionAuthority: transportAuthority });
    grant.activate(child);
    const role = createRoutingChildClient(handoffFor(grant));
    await role.getOrder({ workflow: 'wf', run: 'run', holder });
    const pendingAsk = role.ask({ workflow: 'wf', run: 'run', path: 'out', question: 'question' });
    await askStarted;
    const freeze = grant.quiesce();
    loseAsk();
    await assert.rejects(pendingAsk, /routing broker unavailable/);
    assert.deepEqual(await freeze, { quiescing: true, effects: 'uncertain' });
    await assert.rejects(role.ask({ workflow: 'wf', run: 'run', path: 'out', question: 'retry' }),
      /routing broker unavailable/);
    assert.equal(writes, 1);
  } finally { await assert.rejects(broker.close(), /quarantined/); }
});

test('quiesce aborts an active holder upload and never calls it settled', async () => {
  let beginUpload!: () => void;
  const uploadStarted = new Promise<void>(resolve => { beginUpload = resolve; });
  const reserved = { ...reservation, childKind: 'agent-run' as const };
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      const route = String(url).split('/api/')[1]!;
      if (route === 'get_order') return Response.json(orderResponse);
      if (route.startsWith('routing_file_artifacts/v1?')) {
	beginUpload();
	return new Promise<Response>((_resolve, reject) => {
	  init!.signal!.addEventListener('abort', () => reject(new Error('upload aborted')), { once: true });
	});
      }
      throw new Error(`unexpected route ${route}`);
    }) as typeof fetch });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  const source = new PassThrough();
  try {
    const grant = broker.issue({ reservation: reserved, routing, identity,
      currentIdentity: () => identity, hub, submissionAuthority: transportAuthority });
    grant.activate({ ...child, kind: 'agent-run' });
    const owner = createRoutingChildClient(handoffFor(grant.holder!, reserved));
    await owner.getOrder({ workflow: 'wf', run: 'run', holder: {
      kind: 'session', id: sessionId, shiftId: identity.shiftId } });
    source.write(Buffer.from('a'));
    const pending = owner.putFileArtifactStream({ workflow: 'wf', size: 2,
      chunks: source, contentType: 'text/plain' });
    await uploadStarted;
    assert.deepEqual(await grant.quiesce(), { quiescing: true, effects: 'uncertain' });
    await assert.rejects(pending, /routing broker unavailable/);
  } finally { source.destroy(); await assert.rejects(broker.close(), /quarantined/); }
});

test('broker redacts upstream failures and rejects an expired incarnation before fetch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-routing-broker-'));
  let now = 2_000;
  let calls = 0;
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => now },
    fetchImpl: (async () => {
      calls++;
      return new Response('secret response and header text', { status: 429, headers: { 'Retry-After': '12' } });
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => now });
  try {
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    grant.activate(child);
    const response = await request(grant.socketPath, { cap: grant.cap, method: 'read_routing_claim', body: {} });
    assert.equal(response.ok, false);
    assert.equal(response.status, 429);
    assert.equal(response.retryAfterMs, 12_000);
    assert.equal(JSON.stringify(response).includes('secret'), false);
    now = 90_000;
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'get_order', body: { holder } })).ok, false);
    assert.equal(calls, 1);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('routed v2 broker verbs stay on the original grant and never use generic Hub fetch', async () => {
  let now = 2_000;
  let live = { ...identity };
  let genericCalls = 0;
  const observed: Array<{ kind: string; expected: { workflow: string; run: string } }> = [];
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...live, credential }), now: () => now },
    fetchImpl: (async () => { genericCalls++; throw new Error('generic Hub fetch forbidden'); }) as typeof fetch });
  const broker = await createRoutingBroker({ now: () => now });
  try {
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => live, hub,
      routedV2Read: async (kind, expected) => {
	observed.push({ kind, expected });
	return kind === 'reference'
	  ? { protocol: 'trusted-routed-reference-read-v2', state: 'unavailable', ...expected }
	  : { protocol: 'routing-claim-read-v2', state: 'unavailable', ...expected };
      } });
    const routed = createRoutingChildClient(handoffFor(grant));
    assert.equal((await request(grant.socketPath, { cap: grant.cap,
      method: 'read_routed_reference_v2', body: {} })).ok, false, 'pending grant has no read authority');
    grant.activate(child);
    assert.deepEqual(await routed.readRoutedReferenceV2({ workflow: 'wf', run: 'run' }),
      { protocol: 'trusted-routed-reference-read-v2', state: 'unavailable', workflow: 'wf', run: 'run' });
    assert.deepEqual(await routed.readRoutingClaimV2({ workflow: 'wf', run: 'run' }),
      { protocol: 'routing-claim-read-v2', state: 'unavailable', workflow: 'wf', run: 'run' });
    assert.deepEqual(observed, [{ kind: 'reference', expected: { workflow: 'wf', run: 'run' } },
      { kind: 'claim', expected: { workflow: 'wf', run: 'run' } }]);
    assert.throws(() => routed.readRoutedReferenceV2({ workflow: 'foreign', run: 'run' }), /binding refused/);
    assert.equal((await request(grant.socketPath, { cap: grant.cap,
      method: 'read_routed_reference_v2', body: { workflow: 'foreign' } })).ok, false);
    assert.equal((await request(grant.socketPath, { cap: 'f'.repeat(64),
      method: 'read_routed_reference_v2', body: {} })).ok, false);
    assert.equal(observed.length, 2);
    assert.equal(genericCalls, 0);
    now = 70_000;
    await assert.rejects(routed.readRoutingClaimV2({ workflow: 'wf', run: 'run' }), /routing broker unavailable/);
    assert.equal(observed.length, 2);
    now = 2_000;
    live = { ...live, sessionId: 'rs_revoked' };
    await assert.rejects(routed.readRoutedReferenceV2({ workflow: 'wf', run: 'run' }), /routing broker unavailable/);
    assert.equal(observed.length, 2);
  } finally { await broker.close(); }
});

test('routed v2 broker drops a reference that resolves after original grant revocation', async () => {
  let started!: () => void;
  let complete!: (value: { protocol: 'trusted-routed-reference-read-v2'; state: 'unavailable';
    workflow: string; run: string }) => void;
  const called = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<RoutedReferenceV2>(resolve => { complete = resolve; });
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async () => { throw new Error('generic Hub fetch forbidden'); }) as typeof fetch });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
      routedV2Read: async () => { started(); return pending; } });
    grant.activate(child);
    const client = createRoutingChildClient(handoffFor(grant));
    const read = client.readRoutedReferenceV2({ workflow: 'wf', run: 'run' });
    await called;
    grant.terminal();
    complete({ protocol: 'trusted-routed-reference-read-v2', state: 'unavailable', workflow: 'wf', run: 'run' });
    await assert.rejects(read, /routing broker unavailable/);
  } finally { await broker.close(); }
});

test('broker refuses overlong reservations and a response that finishes after grant revocation', async () => {
  let started!: () => void;
  let reply!: (response: Response) => void;
  const fetchStarted = new Promise<void>(resolve => { started = resolve; });
  const pendingResponse = new Promise<Response>(resolve => { reply = resolve; });
  let delayed = false;
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async () => {
      if (!delayed) return Response.json({ reservationId: 'lr_overlong', orderId: 'run', expiresAt: 80_000 });
      started();
      return pendingResponse;
    }) as typeof fetch,
  });
  const launch = { version: 'launch-reservation-v1', claimId: 'run', decisionId: 'decision',
    binding, orderId: 'run', attemptId: 'run', rosterRevision: 'roster-v1', candidateIds: [],
    assessmentId: null, requested: null, selected: null };
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const first = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    first.activate(child);
    assert.equal((await request(first.socketPath, { cap: first.cap, method: 'reserve_launch',
      body: { request: launch } })).ok, false, 'Service expiry may not widen the local claim bound');
    first.terminal();
    delayed = true;
    const second = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    second.activate(child);
    const result = request(second.socketPath, { cap: second.cap, method: 'reserve_launch', body: { request: launch } });
    await fetchStarted;
    second.terminal();
    reply(Response.json({ reservationId: 'lr_late', orderId: 'run', expiresAt: 40_000 }));
    assert.equal((await result).ok, false, 'revoked grant cannot deliver or cache an in-flight result');
  } finally { await broker.close(); }
});

test('broker survives bounded client resets during pending Hub replies', async () => {
  let defer = true;
  let started: (() => void) | undefined;
  const releases: Array<(response: Response) => void> = [];
  const signals: AbortSignal[] = [];
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (_url, init) => {
      if (!defer) return Response.json(orderResponse);
      signals.push(init!.signal!);
      return new Promise<Response>(resolve => { releases.push(resolve); started?.(); });
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    grant.activate(child);
    for (let index = 0; index < 16; index++) {
      const fetched = new Promise<void>(resolve => { started = resolve; });
      const socket = createConnection(grant.socketPath);
      socket.on('error', () => {});
      socket.once('connect', () => socket.write(JSON.stringify({
	cap: grant.cap, method: 'get_order', body: { holder },
      }) + '\n'));
      await fetched;
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
      socket.destroy(new Error('client reset'));
      await closed;
      const signal = signals.at(-1)!;
      if (!signal.aborted) {
	let timeout!: NodeJS.Timeout;
	await Promise.race([
	  new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
	  new Promise<void>(resolve => { timeout = setTimeout(resolve, 200); }),
	]);
	clearTimeout(timeout);
      }
      assert.equal(signal.aborted, true, 'disconnect aborts the scoped Hub request');
      releases.shift()!(Response.json(orderResponse));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    defer = false;
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'get_order', body: { holder } })).ok, true);
  } finally { await broker.close(); }
});

test('child transport keeps lifecycle bound to one live session after launch window expiry', async () => {
  let now = 2_000;
  let current = { ...identity };
  const calls: Array<{ verb: string; body: Record<string, unknown>; headers: Headers }> = [];
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...current, credential }), now: () => now },
    fetchImpl: (async (url, init) => {
      const verb = String(url).split('/api/')[1]!;
      calls.push({ verb, body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
      if (verb === 'get_order') return Response.json({ ...orderResponse, order: { ...orderResponse.order, routing, defDigest: 'a'.repeat(64), step: 'producer', key: '', inputs: [], consumes: {}, consumedFingerprint: {}, owes: [{ path: 'out', version: 1 }] } });
      if (verb === 'heartbeat') return Response.json({ text: 'ok', ok: true });
      if (verb === 'routing_submit_conditional/v1') return Response.json({ text: 'ok', outcome: 'submitted', closed: true, conditionApplied: 'routed-conditional-receipt-v1' });
      if (verb === 'routing_submit_conditional_receipt_revoke/v1') return Response.json({ revoked: true });
      if (verb === 'release') return Response.json({ text: 'ok', released: true });
      throw new Error('unexpected routed request');
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => now });
  try {
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => current, hub, submissionAuthority: { verifyOrder: async () => {}, canSubmit: () => true, sign: async () => 'parent-proof' } });
    grant.activate(child);
    const client = createRoutingChildClient(handoffFor(grant));
    assert.equal('getToken' in client, false);
    assert.throws(() => createRoutingChildClient({ ...handoffFor(grant), broker: undefined }), /broker unavailable/);
    const absent = createRoutingChildClient(handoffFor({ socketPath: join(tmpdir(), 'absent-routing-broker.sock'), cap: grant.cap }));
    await assert.rejects(absent.heartbeat({ workflow: 'wf', run: 'run', holder }), /broker unavailable/);
    assert.throws(() => client.getOrder({ workflow: 'other', run: 'run', holder }), /binding refused/);
    assert.equal((await client.getOrder({ workflow: 'wf', run: 'run', holder })).lease.claimed, true);
    await assert.rejects(client.submit({ workflow: 'wf', run: 'run', path: 'unowed', value: 'wrong', holder }),
      /routing broker unavailable/);
    await assert.rejects(client.heartbeat({ workflow: 'wf', run: 'run',
      holder: { ...holder, id: 'different-child' } }), /routing broker unavailable/);
    assert.deepEqual(calls.map(call => call.verb), ['get_order']);
    now = 75_000; // Original preference ended at 70_000; live lease continues.
    assert.equal((await client.heartbeat({ workflow: 'wf', run: 'run', holder })).text, 'ok');
    const receipt = { text: 'x'.repeat(128 * 1024) };
    assert.equal((await client.submit({ workflow: 'wf', run: 'run', path: 'out', value: receipt,
      holder })).closed, true);
    assert.deepEqual(calls.at(-1)?.body.value, receipt, 'submit receipts larger than the old 64 KiB socket limit');
    assert.equal((await client.release({ workflow: 'wf', run: 'run', reason: 'stop' })).released, true);
    await assert.rejects(client.reserveLaunch({ workflow: 'wf', request: {
      version: 'launch-reservation-v1', claimId: 'run', decisionId: 'decision', binding,
      orderId: 'run', attemptId: 'run', rosterRevision: 'roster-v1', candidateIds: [],
      assessmentId: null, requested: null, selected: null,
    } }), /routing broker unavailable/);
    assert.deepEqual(calls.map(call => call.verb), ['get_order', 'heartbeat', 'get_order', 'get_order', 'routing_submit_conditional/v1', 'release']);
    for (const call of calls) {
      assert.equal(call.headers.get('Authorization'), 'Bearer enrolled');
      assert.equal(call.headers.get('X-Owenloop-Routing-Session'), credential);
      assert.equal(call.body.workflow, 'wf');
      assert.equal(call.body.run, 'run');
    }
    await grant.terminal();
    await assert.rejects(client.heartbeat({ workflow: 'wf', run: 'run', holder }), /routing broker unavailable/);
    current = { ...identity, sessionId: 'rs_changed' };
    assert.equal(calls.length, 7);
  } finally { await broker.close(); }
});

test('agent-run session holder is pinned to the original routing session', async () => {
  const agentReservation: ChildReservation = { ...reservation, childKind: 'agent-run', token: 'b'.repeat(32) };
  const agentRecord = { ...child, kind: 'agent-run' as const, gateToken: agentReservation.token };
  const seen: unknown[] = [];
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      seen.push(JSON.parse(String(init?.body)));
      return Response.json(String(url).endsWith('/heartbeat') ? { text: 'ok', ok: true } : orderResponse);
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation: agentReservation, routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    assert.ok(grant.holder, 'agent-run receives a separate holder-only cap');
    assert.notEqual(grant.holder.cap, grant.cap);
    assert.equal((await request(grant.holder.socketPath, { cap: grant.holder.cap, method: 'get_order',
      body: { holder: { kind: 'session', id: sessionId, shiftId: identity.shiftId } } })).ok, false,
    'holder cap cannot act before the parent start gate');
    grant.activate(agentRecord);
    const client = createRoutingChildClient(handoffFor(grant, agentReservation));
    const sessionHolder = { kind: 'session' as const, id: sessionId, shiftId: identity.shiftId };
    await assert.rejects(client.getOrder({ workflow: 'wf', run: 'run',
      holder: { ...sessionHolder, id: 'arbitrary-mcp-session' } }), /routing broker unavailable/);
    assert.equal(seen.length, 0);
    await client.getOrder({ workflow: 'wf', run: 'run', holder: { ...holder, id: `${hostname()}:9001` } });
    assert.equal(seen.length, 1);
    assert.deepEqual((seen[0] as { holder: unknown }).holder, holder);
    const holderClient = createRoutingChildClient(handoffFor(grant.holder, agentReservation));
    assert.equal((await holderClient.getOrder({ workflow: 'wf', run: 'run', holder: sessionHolder })).lease.claimed, true);
    assert.deepEqual((seen[1] as { holder: unknown }).holder, sessionHolder);
    const mountHub = createRoutingHolderClient({ workflow: 'wf', run: 'run', broker: grant.holder });
    assert.equal((await mountHub.heartbeat({ workflow: 'wf', run: 'run', holder: sessionHolder })).text, 'ok');
    await assert.rejects(mountHub.release({ workflow: 'wf', run: 'run' }), /routed holder verb unavailable/);
    await assert.rejects(holderClient.getOrder({ workflow: 'wf', run: 'run', holder }), /broker unavailable/);
    await assert.rejects(client.getOrder({ workflow: 'wf', run: 'run', holder: sessionHolder }), /broker unavailable/);
    await assert.rejects(holderClient.release({ workflow: 'wf', run: 'run' }), /broker unavailable/);
    await assert.rejects(holderClient.readRoutingClaim({ workflow: 'wf', run: 'run' }), /broker unavailable/);
    await assert.rejects(holderClient.getLaunchOrder({ workflow: 'wf', run: 'run', holder: sessionHolder }), /broker unavailable/);
    assert.equal(seen.length, 3, 'holder cap cannot invoke role methods or spoof the exec holder');
    grant.terminal();
    await assert.rejects(holderClient.getOrder({ workflow: 'wf', run: 'run', holder: sessionHolder }), /broker unavailable/);
  } finally { await broker.close(); }
});

test('holder ask/reject/upload and role approval use only exact scoped routes', async () => {
  const agentReservation: ChildReservation = { ...reservation, childKind: 'agent-run', token: 'b'.repeat(32) };
  const agentRecord = { ...child, kind: 'agent-run' as const, gateToken: agentReservation.token };
  const calls: Array<{ route: string; body: unknown; headers: Headers }> = [];
  const bytes = new Uint8Array(32 * 1024 * 1024 + 1);
  bytes.fill(0x63);
  const fileRoot = mkdtempSync(join(tmpdir(), 'owenloop-routing-upload-'));
  const file = join(fileRoot, 'artifact.bin');
  writeFileSync(file, bytes);
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      const route = String(url).split('/api/')[1]!;
      const headers = new Headers(init?.headers);
      if (route.startsWith('routing_file_artifacts/v1?')) {
	let size = 0;
	for await (const part of init?.body as AsyncIterable<Uint8Array>) size += part.byteLength;
	calls.push({ route, body: { size }, headers });
      return Response.json({ text: 'stored', __file: 'orgs/org/artifacts/wf/files/routed/run/12345678-1234-4123-8123-123456789abc',
	  hash: 'a'.repeat(64), size, contentType: 'application/octet-stream',
	  ...(headers.get('x-file-name') === null ? {} : { filename: headers.get('x-file-name') }) });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ route, body, headers });
      if (route === 'get_order') return Response.json({ ...orderResponse,
	order: { ...orderResponse.order, consumes: { source: 'value' } } });
      if (route === 'routing_ask/v1' || route === 'routing_reject/v1')
	return Response.json({ text: 'done', ok: true, closed: true });
      if (route === 'routing_request_approval/v1')
	return Response.json({ text: 'pending', ok: true, approval: { state: 'pending' } });
      if (route === 'read_invocation_binding') return Response.json({
	protocol: 'owenloop-binding-v1', orgId: 'org', freshness: 'fresh-at-read', atomicLaunch: false,
	binding: { id: 'inv_1' }, bindingJson: '{}', bindingDigest: 'sha256:binding',
      });
      throw new Error('unexpected scoped route');
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation: agentReservation, routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    assert.ok(grant.holder);
    grant.activate(agentRecord);
    const role = createRoutingChildClient(handoffFor(grant, agentReservation));
    const holderClient = createRoutingHolderClient({ workflow: 'wf', run: 'run', broker: grant.holder }, {
      openRoot: workdir => open(workdir, 'r'),
    });
    const sessionHolder = { kind: 'session' as const, id: sessionId, shiftId: identity.shiftId };
    await holderClient.getOrder({ workflow: 'wf', run: 'run', holder: sessionHolder });
    assert.equal((await holderClient.ask({ workflow: 'wf', run: 'run', path: 'out', question: 'Need a value?' })).closed, true);
    assert.equal((await holderClient.reject({ workflow: 'wf', run: 'run', path: 'source', text: 'Invalid' })).ok, true);
    assert.equal((await role.requestApproval({ workflow: 'wf', run: 'run', tool_use_id: 'tool-1',
	tool_name: 'Bash', tool_input: { command: 'pwd' }, reason: 'needs approval' })).approval?.state, 'pending');
    const invocation = { workflow: 'wf', orderId: 'run', parentWorkflow: 'parent',
      parentDefRef: { bundleDigest: 'sha256:bundle', workflowName: 'parent' }, callPath: 'out' };
    assert.equal((await role.readInvocationBinding(invocation)).binding.id, 'inv_1');
    const pointer = await holderClient.putFileArtifact({ workflow: 'wf', bytes,
	contentType: 'application/octet-stream' });
    assert.equal(pointer.size, bytes.byteLength);
    assert.equal(typeof pointer.__file, 'string');
    const streamed = await holderClient.uploadFile({ workflow: 'wf', workdir: fileRoot, file: 'artifact.bin',
	contentType: 'application/octet-stream', filename: 'artifact.bin' });
    assert.equal(streamed.size, bytes.byteLength);
    await assert.rejects(holderClient.ask({ workflow: 'wf', run: 'run', path: 'other', question: 'No' }), /unavailable/);
    await assert.rejects(holderClient.reject({ workflow: 'wf', run: 'run', path: 'other', text: 'No' }), /unavailable/);
    const narrow = createRoutingChildClient(handoffFor(grant.holder, agentReservation));
    await assert.rejects(narrow.requestApproval({ workflow: 'wf', run: 'run', tool_use_id: 'other',
	tool_name: 'Bash', tool_input: {}, reason: 'no' }), /unavailable/);
    await assert.rejects(narrow.readInvocationBinding(invocation), /unavailable/);
    assert.deepEqual(calls.map(c => c.route), ['get_order', 'routing_ask/v1', 'routing_reject/v1',
      'routing_request_approval/v1', 'read_invocation_binding',
      'routing_file_artifacts/v1?workflow=wf&run=run',
      'routing_file_artifacts/v1?workflow=wf&run=run']);
    for (const call of calls) {
      assert.equal(call.headers.get('Authorization'), 'Bearer enrolled');
      assert.equal(call.headers.get('X-Owenloop-Routing-Session'), credential);
    }
    assert.equal(calls.at(-1)?.headers.get('content-length'), String(bytes.byteLength));
    grant.terminal();
  } finally { await broker.close(); rmSync(fileRoot, { recursive: true, force: true }); }
});

test('revoking a holder grant aborts an in-flight streamed upload', async () => {
  const agentReservation: ChildReservation = { ...reservation, childKind: 'agent-run', token: 'd'.repeat(32) };
  const agentRecord = { ...child, kind: 'agent-run' as const, gateToken: agentReservation.token };
  let uploadStarted!: () => void;
  const started = new Promise<void>(resolve => { uploadStarted = resolve; });
  let aborted = false;
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      if (String(url).endsWith('/get_order')) return Response.json(orderResponse);
      if (String(url).includes('routing_file_artifacts')) {
	uploadStarted();
	return new Promise<Response>((_resolve, reject) => {
	  init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
	});
      }
      throw new Error('unexpected request');
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation: agentReservation, routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    assert.ok(grant.holder);
    grant.activate(agentRecord);
    const client = createRoutingChildClient(handoffFor(grant.holder, agentReservation));
    await client.getOrder({ workflow: 'wf', run: 'run',
      holder: { kind: 'session', id: sessionId, shiftId: identity.shiftId } });
    let sent = false;
    const source = new Readable({ read() {
      if (!sent) { sent = true; this.push(Buffer.alloc(64 * 1024)); }
    } });
    const pending = client.putFileArtifactStream({ workflow: 'wf', size: 1024 * 1024,
      chunks: source, contentType: 'application/octet-stream' });
    await started;
    grant.terminal();
    await assert.rejects(pending, /routing broker unavailable|routing request refused/);
    assert.equal(aborted, true);
    assert.equal(source.destroyed, true, 'client stops reading the local file source');
  } finally { await assert.rejects(broker.close(), /quarantined/); }
});

test('holder upload waits for a delayed helper exit after broker acknowledges exact bytes', async () => {
  const fileRoot = mkdtempSync(join(tmpdir(), 'owenloop-routing-helper-root-'));
  const helperRoot = mkdtempSync(join(tmpdir(), 'owenloop-routing-helper-bin-'));
  const executable = join(helperRoot, 'delayed-helper');
  writeFileSync(executable,
    '#!/bin/sh\nprintf "OK 6\\n" >&4\nprintf inside\n/bin/sleep 0.25\nexit 0\n', { mode: 0o755 });
  const reserved = { ...reservation, childKind: 'agent-run' as const, token: 'e'.repeat(32) };
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      if (String(url).endsWith('/get_order')) return Response.json(orderResponse);
      if (String(url).includes('routing_file_artifacts')) {
	let size = 0;
	for await (const part of init?.body as AsyncIterable<Uint8Array>) size += part.byteLength;
	assert.equal(size, 6);
	return Response.json({ text: 'stored',
	  __file: 'orgs/org/artifacts/wf/files/routed/run/12345678-1234-4123-8123-123456789abc',
	  hash: 'a'.repeat(64), size, contentType: 'text/plain' });
      }
      throw new Error('unexpected request');
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation: reserved, routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    assert.ok(grant.holder);
    grant.activate({ ...child, kind: 'agent-run', gateToken: reserved.token });
    const client = createRoutingHolderClient({ workflow: 'wf', run: 'run', broker: grant.holder }, {
      helperPath: executable, openRoot: workdir => open(workdir, 'r'),
    });
    await client.getOrder({ workflow: 'wf', run: 'run',
      holder: { kind: 'session', id: sessionId, shiftId: identity.shiftId } });
    const started = Date.now();
    const pointer = await client.uploadFile({ workflow: 'wf', workdir: fileRoot,
      file: 'artifact', contentType: 'text/plain' });
    assert.equal(pointer.size, 6);
    assert.ok(Date.now() - started >= 160, 'the accepted broker reply waits for helper EOF');
    grant.terminal();
  } finally {
    await broker.close();
    rmSync(fileRoot, { recursive: true, force: true });
    rmSync(helperRoot, { recursive: true, force: true });
  }
});

test('routed holder refuses a file when an ancestor changes after open', async () => {
  const base = mkdtempSync(join(tmpdir(), 'owenloop-routing-swap-'));
  const root = join(base, 'root'), safe = join(root, 'safe'), outside = join(base, 'outside');
  mkdirSync(safe, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(safe, 'artifact.bin'), 'inside');
  writeFileSync(join(outside, 'artifact.bin'), 'outside');
  let uploadCalls = 0;
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async url => {
      if (String(url).endsWith('/get_order')) return Response.json(orderResponse);
      uploadCalls++;
      return Response.json({ text: 'unexpected' });
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const reserved = { ...reservation, childKind: 'agent-run' as const, token: 'e'.repeat(32) };
    const grant = broker.issue({ reservation: reserved, routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    assert.ok(grant.holder);
    grant.activate({ ...child, kind: 'agent-run', gateToken: reserved.token });
    const client = createRoutingHolderClient({ workflow: 'wf', run: 'run', broker: grant.holder }, {
      openRoot: workdir => open(workdir, 'r'),
      afterRootOpen() {
	renameSync(safe, join(root, 'moved'));
	symlinkSync(outside, safe, 'dir');
      },
    });
    await client.getOrder({ workflow: 'wf', run: 'run',
      holder: { kind: 'session', id: sessionId, shiftId: identity.shiftId } });
    await assert.rejects(client.uploadFile({ workflow: 'wf', workdir: root,
      file: 'safe/artifact.bin', contentType: 'application/octet-stream' }), /file-artifact-outside-workdir/);
    assert.equal(uploadCalls, 0);
    grant.terminal();
  } finally { await broker.close(); rmSync(base, { recursive: true, force: true }); }
});

test('routed helper opens the final file under the held root after a same-path replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-routing-inode-'));
  const file = join(root, 'artifact.bin');
  writeFileSync(file, 'original');
  try {
    const source = await openRoutedFileSource({ workdir: root, file: 'artifact.bin' }, {
      openRoot: workdir => open(workdir, 'r'),
      afterRootOpen() {
	renameSync(file, join(root, 'old.bin'));
	writeFileSync(file, 'replacement');
      },
    });
    const parts: Buffer[] = [];
    for await (const part of source.chunks) parts.push(Buffer.from(part));
    await source.complete();
    source.close();
    assert.equal(Buffer.concat(parts).toString(), 'replacement');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('broker rejects malformed upload pointers and a role-cap upload', async () => {
  const reserved = { ...reservation, childKind: 'agent-run' as const, token: 'f'.repeat(32) };
  const good = { text: 'stored', __file: 'orgs/org/artifacts/wf/files/routed/run/12345678-1234-4123-8123-123456789abc',
    hash: 'a'.repeat(64), size: 1, contentType: 'text/plain' };
  let response: Record<string, unknown> = good;
  let uploadCalls = 0;
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      if (String(url).endsWith('/get_order')) return Response.json(orderResponse);
      uploadCalls++;
      for await (const _part of init?.body as AsyncIterable<Uint8Array>) { /* drain */ }
      return Response.json(response);
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation: reserved, routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    assert.ok(grant.holder);
    grant.activate({ ...child, kind: 'agent-run', gateToken: reserved.token });
    const holderClient = createRoutingChildClient(handoffFor(grant.holder, reserved));
    await holderClient.getOrder({ workflow: 'wf', run: 'run',
      holder: { kind: 'session', id: sessionId, shiftId: identity.shiftId } });
    for (const bad of [
      { ...good, __file: 'orgs/other/artifacts/wf/files/routed/run/12345678-1234-4123-8123-123456789abc' },
      { ...good, __file: 'orgs/org/artifacts/wf/files/routed/run/not-a-uuid' },
      { ...good, filename: 'wrong.txt' },
    ]) {
      response = bad;
      await assert.rejects(holderClient.putFileArtifact({ workflow: 'wf', bytes: Uint8Array.of(1),
	contentType: 'text/plain' }), /routing broker unavailable/);
    }
    const role = createRoutingChildClient(handoffFor(grant, reserved));
    await assert.rejects(role.putFileArtifact({ workflow: 'wf', bytes: Uint8Array.of(1),
      contentType: 'text/plain' }), /routing broker unavailable/);
    assert.equal(uploadCalls, 3, 'role cap never reaches the scoped upload route');
    grant.terminal();
  } finally { await assert.rejects(broker.close(), /quarantined/); }
});

test('broker upload absolute deadline aborts the parent request and child stream', async () => {
  const reserved = { ...reservation, childKind: 'agent-run' as const, token: '1'.repeat(32) };
  let aborted = false;
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      if (String(url).endsWith('/get_order')) return Response.json(orderResponse);
      return new Promise<Response>((_resolve, reject) => {
	init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
      });
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000,
    uploadTimeouts: { idleMs: 80, absoluteMs: 100 } });
  try {
    const grant = broker.issue({ reservation: reserved, routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    assert.ok(grant.holder);
    grant.activate({ ...child, kind: 'agent-run', gateToken: reserved.token });
    const client = createRoutingChildClient(handoffFor(grant.holder, reserved));
    await client.getOrder({ workflow: 'wf', run: 'run',
      holder: { kind: 'session', id: sessionId, shiftId: identity.shiftId } });
    async function* slowBytes(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 8; i++) {
	yield Uint8Array.of(i);
	await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
    await assert.rejects(client.putFileArtifactStream({ workflow: 'wf', size: 8,
      chunks: slowBytes(), contentType: 'application/octet-stream' }), /routing broker unavailable/);
    assert.equal(aborted, true);
    grant.terminal();
  } finally { await assert.rejects(broker.close(), /quarantined/); }
});

test('malformed lifecycle replies and rotated sessions refuse through the child transport', async () => {
  let current = { ...identity };
  let calls = 0;
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...current, credential }), now: () => 2_000 },
    fetchImpl: (async (url) => {
      calls++;
      if (String(url).endsWith('/get_order')) return Response.json(orderResponse);
      return Response.json({ text: 'malformed heartbeat without ok' });
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => current, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    grant.activate(child);
    const client = createRoutingChildClient(handoffFor(grant));
    await assert.rejects(client.heartbeat({ workflow: 'wf', run: 'run', holder }), /broker unavailable/);
    assert.equal(calls, 1);
    current = { ...identity, sessionId: 'rs_rotated' };
    await assert.rejects(client.getOrder({ workflow: 'wf', run: 'run', holder }), /broker unavailable/);
    assert.equal(calls, 1, 'rotated child cannot reach new or retired session');
  } finally { await broker.close(); }
});

test('in-flight lifecycle result is discarded when the dispatch grant is revoked', async () => {
  let started!: () => void;
  let reply!: (value: Response) => void;
  const fetched = new Promise<void>(resolve => { started = resolve; });
  const response = new Promise<Response>(resolve => { reply = resolve; });
  const hub = createHubClient({ origin, getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async () => { started(); return response; }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub, submissionAuthority: transportAuthority, launchAuthority: transportLaunchAuthority });
    grant.activate(child);
    const client = createRoutingChildClient(handoffFor(grant));
    const pending = client.heartbeat({ workflow: 'wf', run: 'run', holder });
    await fetched;
    grant.terminal();
    reply(Response.json({ text: 'late', ok: true }));
    await assert.rejects(pending, /broker unavailable/);
  } finally { await broker.close(); }
});

test('child transport refuses malformed and absent success values on a socket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'owenloop-routing-child-'));
  const socketPath = join(directory, 'broker.sock');
  const frames = ['{"ok":true}\n', '{"ok":true,"value":null}\n', '{"ok":true,"value":"wrong"}\n'];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('data', () => socket.end(frames.shift()!));
  });
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    const client = createRoutingChildClient(handoffFor({ socketPath, cap: 'c'.repeat(64) }));
    for (let index = 0; index < 3; index++) {
      await assert.rejects(client.heartbeat({ workflow: 'wf', run: 'run', holder }), /broker unavailable/);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

function parentOrder(version = 1) {
  return { ...orderResponse, order: { ...orderResponse.order, routing,
    defDigest: 'a'.repeat(64), step: 'producer', key: '', inputs: [], consumes: {},
    consumedFingerprint: {}, owes: [{ path: 'out', version }] } };
}

function parentCollectionOrder(version = 1) {
  const base = parentOrder(version);
  return { ...base, order: { ...base.order, outputs: ['items.sealed'],
    owes: [{ path: 'items.sealed', version }] } };
}

test('parent collection issue, explicit member proof and separate seal survive terminal before ACK', async () => {
  const calls: Array<{ route: string; body: Record<string, unknown>; headers: Headers }> = [];
  const signed: Array<{ path: string; version?: number; value: unknown }> = [];
  let grant: ReturnType<Awaited<ReturnType<typeof createRoutingBroker>>['issue']> | undefined;
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      const route = String(url).split('/api/')[1]!;
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      calls.push({ route, body, headers: new Headers(init!.headers) });
      if (route === 'get_order') return Response.json(parentCollectionOrder());
      if (route === 'routing_collection_member_issue/v1') return Response.json({
	emissionId: body.emissionId, sealPath: 'items.sealed', sealTargetVersion: 1,
	memberPath: 'items[0]', memberVersion: 1, valueDigest: body.valueDigest,
	conditionApplied: 'routed-collection-member-v1',
      });
      if (route === 'routing_collection_member_emit/v1') return Response.json({
	outcome: 'emitted', closed: false, emitted: ['items[0]'],
	conditionApplied: 'routed-collection-member-v1',
      });
      if (route === 'routing_collection_seal/v1') {
	grant?.terminal('normal-close');
	return Response.json({ outcome: 'green', closed: true, sealed: 'items.sealed',
	  conditionApplied: 'routed-collection-seal-v1' });
      }
      throw new Error(`unexpected route ${route}`);
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
      submissionAuthority: { verifyOrder: async () => {}, canSubmit: () => false,
	canCollect: (_order, path) => path === 'items.sealed',
	sign: async (_order, path, value, version) => {
	  signed.push({ path, value, ...(version === undefined ? {} : { version }) });
	  return `parent-proof-${path}`;
	} },
    });
    grant.activate(child);
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'get_order',
      body: { holder } })).ok, true);
    const body = { sealPath: 'items.sealed', emissionId: 'a'.repeat(32),
      value: { id: 1 }, done: true, holder };
    const first = await request(grant.socketPath, { cap: grant.cap, method: 'emit_member', body });
    assert.equal(first.ok, true);
    assert.deepEqual(signed, [{ path: 'items[0]', value: { id: 1 }, version: 1 },
      { path: 'items.sealed', value: {}, version: 1 }]);
    assert.equal(calls.filter(call => call.route === 'routing_collection_member_emit/v1').length, 1);
    assert.equal(calls.filter(call => call.route === 'routing_collection_seal/v1').length, 1);
    // Shift may observe the role exit after the normal run-close event. It
    // must keep this receipt-only tombstone instead of revoking it.
    grant.terminal('normal-close');
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'heartbeat',
      body: { holder } })).ok, false);
    const same = await request(grant.socketPath, { cap: grant.cap, method: 'emit_member', body });
    assert.deepEqual(same, first);
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'emit_member',
      body: { ...body, value: { id: 2 } } })).ok, false);
    for (const call of calls) {
      assert.equal(call.headers.get('authorization'), 'Bearer parent-bearer');
      assert.equal(call.headers.get('x-owenloop-routing-session'), credential);
    }
  } finally { await broker.close(); }
});

test('child exit after lost seal ACK reconciles exact receipt without a run-close callback', async () => {
  const routes: string[] = [];
  let grant: ReturnType<Awaited<ReturnType<typeof createRoutingBroker>>['issue']> | undefined;
  let sealRequest: Record<string, unknown> | undefined;
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      const route = String(url).split('/api/')[1]!;
      routes.push(route);
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      if (route === 'get_order') return Response.json(parentCollectionOrder());
      if (route === 'routing_collection_seal/v1') {
	sealRequest = body;
	grant?.terminal('child-exit');
	throw new Error('ACK lost after Service commit');
      }
      if (route === 'routing_collection_receipt/v1') {
	assert.equal(body.kind, 'seal');
	assert.equal(body.id, sealRequest?.sealId);
	assert.equal(body.requestDigest, valueDigestHex(sealRequest));
	return Response.json({ state: 'sealed', result: { outcome: 'green', closed: true,
	  sealed: 'items.sealed', conditionApplied: 'routed-collection-seal-v1' } });
      }
      throw new Error(`unexpected route ${route}`);
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
      submissionAuthority: { verifyOrder: async () => {}, canSubmit: () => false,
	canCollect: () => true, sign: async () => 'parent-seal-proof' } });
    grant.activate(child);
    await request(grant.socketPath, { cap: grant.cap, method: 'get_order', body: { holder } });
    const body = { sealPath: 'items.sealed', sealId: 'b'.repeat(32), holder };
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'seal_collection', body })).ok, false);
    const recovered = await request(grant.socketPath, { cap: grant.cap, method: 'seal_collection', body });
    assert.equal(recovered.ok, true);
    assert.equal((recovered.value as { outcome: string }).outcome, 'green');
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'seal_collection',
      body: { ...body, sealId: 'c'.repeat(32) } })).ok, false);
    assert.equal(routes.filter(route => route === 'routing_collection_seal/v1').length, 1);
    assert.equal(routes.filter(route => route === 'routing_collection_receipt/v1').length, 1);
  } finally { await broker.close(); }
});

test('explicit collection revocation clears cap and failed Service revoke quarantines broker close', async () => {
  let revokes = 0;
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      const route = String(url).split('/api/')[1]!;
      if (route === 'get_order') return Response.json(parentCollectionOrder());
      if (route === 'routing_collection_member_issue/v1') {
	const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
	return Response.json({ emissionId: body.emissionId, sealPath: 'items.sealed',
	  sealTargetVersion: 1, memberPath: 'items[0]', memberVersion: 1,
	  valueDigest: body.valueDigest, conditionApplied: 'routed-collection-member-v1' });
      }
      if (route === 'routing_collection_receipt_revoke/v1') {
	revokes++;
	return new Response('unavailable', { status: 503 });
      }
      throw new Error(`unexpected route ${route}`);
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
    submissionAuthority: { verifyOrder: async () => {}, canSubmit: () => false,
      canCollect: () => true, sign: async () => 'proof' } });
  grant.activate(child);
  await request(grant.socketPath, { cap: grant.cap, method: 'get_order', body: { holder } });
  // A pre-emit issue is enough to create exact collection custody.
  await request(grant.socketPath, { cap: grant.cap, method: 'emit_member', body: {
    sealPath: 'items.sealed', emissionId: 'd'.repeat(32), value: { id: 1 }, done: false, holder,
  } });
  grant.terminal('revoked');
  assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'get_order',
    body: { holder } })).ok, false);
  await assert.rejects(broker.close(), /quarantined/);
  await assert.rejects(broker.close(), /quarantined/, 'a second close cannot report false success');
  assert.equal(revokes, 1);
});

test('session rotation revokes locally during an in-flight member write and quarantines its outcome', async () => {
  let emitStarted!: () => void;
  const started = new Promise<void>(resolve => { emitStarted = resolve; });
  let finishEmit!: (response: Response) => void;
  const heldEmit = new Promise<Response>(resolve => { finishEmit = resolve; });
  let revokes = 0;
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      const route = String(url).split('/api/')[1]!;
      if (route === 'get_order') return Response.json(parentCollectionOrder());
      if (route === 'routing_collection_member_issue/v1') {
	const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
	return Response.json({ emissionId: body.emissionId, sealPath: 'items.sealed',
	  sealTargetVersion: 1, memberPath: 'items[0]', memberVersion: 1,
	  valueDigest: body.valueDigest, conditionApplied: 'routed-collection-member-v1' });
      }
      if (route === 'routing_collection_member_emit/v1') { emitStarted(); return heldEmit; }
      if (route === 'routing_collection_receipt_revoke/v1') {
	revokes++;
	return Response.json({ revoked: true });
      }
      throw new Error(`unexpected route ${route}`);
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
    submissionAuthority: { verifyOrder: async () => {}, canSubmit: () => false,
      canCollect: () => true, sign: async () => 'parent-member-proof' } });
  grant.activate(child);
  try {
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'get_order',
      body: { holder } })).ok, true);
    const pending = request(grant.socketPath, { cap: grant.cap, method: 'emit_member',
      body: { sealPath: 'items.sealed', emissionId: 'd'.repeat(32), value: { id: 1 },
	done: false, holder } });
    await started;
    const frozen = grant.quiesce();
    const revoked = broker.revokeSession(sessionId);
    const revokedAssertion = assert.rejects(revoked, /quarantined/);
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'heartbeat',
      body: { holder } })).ok, false);
    finishEmit(Response.json({ outcome: 'emitted', closed: false,
      conditionApplied: 'routed-collection-member-v1' }));
    assert.deepEqual(await frozen, { quiescing: true, effects: 'uncertain' });
    await revokedAssertion;
    assert.equal((await pending).ok, false);
    assert.equal(revokes, 1);
    await assert.rejects(broker.close(), /quarantined/);
  } finally { await broker.close().catch(() => {}); }
});

test('Shift stop revokes a pending seal before ACK and cannot report a clean broker drain', async () => {
  let sealStarted!: () => void;
  const started = new Promise<void>(resolve => { sealStarted = resolve; });
  let finishSeal!: (response: Response) => void;
  const heldSeal = new Promise<Response>(resolve => { finishSeal = resolve; });
  let revokes = 0;
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async url => {
      const route = String(url).split('/api/')[1]!;
      if (route === 'get_order') return Response.json(parentCollectionOrder());
      if (route === 'routing_collection_seal/v1') { sealStarted(); return heldSeal; }
      if (route === 'routing_collection_receipt_revoke/v1') {
	revokes++;
	return Response.json({ revoked: true });
      }
      throw new Error(`unexpected route ${route}`);
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
    submissionAuthority: { verifyOrder: async () => {}, canSubmit: () => false,
      canCollect: () => true, sign: async () => 'parent-seal-proof' } });
  grant.activate(child);
  try {
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'get_order',
      body: { holder } })).ok, true);
    const pending = request(grant.socketPath, { cap: grant.cap, method: 'seal_collection',
      body: { sealPath: 'items.sealed', sealId: 'e'.repeat(32), holder } });
    await started;
    const closing = broker.close({ revokeNormalReceipts: true });
    const refused = assert.rejects(closing, /quarantined/);
    finishSeal(Response.json({ outcome: 'green', closed: true,
      conditionApplied: 'routed-collection-seal-v1' }));
    await refused;
    assert.equal((await pending).ok, false);
    assert.equal(revokes, 1);
  } finally { await broker.close().catch(() => {}); }
});

test('routed submit rejects child proofs and signs normalized exact current metadata in parent', async () => {
  const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  const signed: unknown[] = [];
  let verified = 0;
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      const route = String(url).split('/api/')[1]!;
      calls.push({ route, body: JSON.parse(String(init!.body)) as Record<string, unknown> });
      if (route === 'get_order') return Response.json(parentOrder());
      if (route === 'routing_submit_conditional_receipt_revoke/v1') return Response.json({ revoked: true });
      assert.equal(route, 'routing_submit_conditional/v1');
      return Response.json({ text: 'ok', outcome: 'submitted', closed: false, conditionApplied: 'routed-conditional-receipt-v1' });
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
      submissionAuthority: { verifyOrder: async () => { verified++; }, canSubmit: () => true,
	sign: async (order, path, value) => { signed.push({ order, path, value }); return 'parent-only-proof'; } } });
    grant.activate(child);
    const send = (body: unknown) => request(grant.socketPath, { cap: grant.cap, method: 'submit', body });
    await request(grant.socketPath, { cap: grant.cap, method: 'get_order', body: { holder } });
    const before = calls.length;
    assert.equal((await send({ path: 'out', value: { ok: true }, holder, proof: 'child-proof' })).ok, false);
    assert.equal(calls.length, before, 'child proof refuses before fresh contact or signer');
    assert.equal((await send({ path: 'out', value: '{"ok":true}', holder })).ok, true);
    assert.equal(verified, 3);
    assert.equal(signed.length, 1);
    assert.deepEqual((signed[0] as { value: unknown }).value, { ok: true });
    assert.deepEqual(calls.at(-1)!.body, { workflow: 'wf', run: 'run', path: 'out',
      value: { ok: true }, holder, proof: 'parent-only-proof', expectedVersion: 1, done: true });
  } finally { await broker.close(); }
});

test('parent signing rechecks changed targets and revoked grants without sending a write', async () => {
  for (const mode of ['target', 'revoke', 'trust', 'missing-version', 'missing-authority'] as const) {
    let version = 1, writes = 0, verifies = 0;
    let live = { ...identity };
    const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
      routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
      fetchImpl: (async (url) => {
	if (String(url).endsWith('/get_order')) return Response.json(parentOrder(mode === 'missing-version' ? 0 : version));
	writes++;
	return Response.json({ text: 'ok', outcome: 'submitted', conditionApplied: 'expected-version-v1' });
      }) as typeof fetch,
    });
    const broker = await createRoutingBroker({ now: () => 2_000 });
    try {
      const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => live, hub,
	...(mode === 'missing-authority' ? {} : { submissionAuthority: {
	  canSubmit: () => true, verifyOrder: async () => { verifies++; if (mode === 'trust' && verifies === 3) throw new Error('revoked signer'); },
	  sign: async () => { if (mode === 'target') version++; if (mode === 'revoke') live = { ...live, sessionId: 'rotated' }; return 'proof'; },
	} }) });
      grant.activate(child);
      await request(grant.socketPath, { cap: grant.cap, method: 'get_order', body: { holder } });
      assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'submit',
	body: { path: 'out', value: { ok: true }, holder } })).ok, false, mode);
      assert.equal(writes, 0, mode);
    } finally { await broker.close(); }
  }
});

test('uncertain singleton retry preserves exact parent signature and refuses changed payload', async () => {
  for (const mode of ['retry', 'no-replay', 'pending'] as const) {
    const canReplay = mode === 'retry';
    const writes: string[] = [];
    let retryIssues = 0;
    let signatures = 0;
    const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
      routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
      fetchImpl: (async (url, init) => {
	const route = String(url).split('/api/')[1]!;
	if (route === 'get_order') return Response.json(parentOrder());
	if (route === 'routing_submit_conditional_receipt/v1')
	  return Response.json({ state: mode === 'pending' ? 'pending' : 'unavailable' });
	if (route === 'routing_submit_conditional_receipt_revoke/v1') return Response.json({ revoked: true });
	if (route === 'routing_submit_conditional_retry_issue/v1') { retryIssues++; return Response.json({
	  generation: 1, generationToken: 'e'.repeat(64), expiresAt: 80_000,
	  requestDigest: (JSON.parse(String(init!.body)) as { requestDigest: string }).requestDigest,
	}); }
	assert.equal(route, 'routing_submit_conditional/v1');
	writes.push(String(init!.body));
	if (writes.length === 1) throw new Error('response lost');
	assert.equal(new Headers(init!.headers).get('X-Owenloop-Routing-Generation'), 'e'.repeat(64));
	return Response.json({ text: 'ok', outcome: 'submitted', closed: false,
	  conditionApplied: 'routed-conditional-receipt-v1' });
      }) as typeof fetch,
    });
    const broker = await createRoutingBroker({ now: () => 2_000 });
    try {
      const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
	submissionAuthority: { verifyOrder: async () => {}, canSubmit: () => true, canReplay: () => canReplay,
	  sign: async () => 'parent-proof-' + ++signatures } });
      grant.activate(child);
      const send = (value: unknown) => request(grant.socketPath, { cap: grant.cap, method: 'submit',
	body: { path: 'out', value, holder } });
      await request(grant.socketPath, { cap: grant.cap, method: 'get_order', body: { holder } });
      assert.equal((await send({ ok: true })).ok, false);
      assert.equal((await send({ ok: false })).ok, false, 'uncertain write cannot become a different write');
      assert.equal((await send({ ok: true })).ok, canReplay);
      assert.equal(signatures, 1);
      assert.equal(retryIssues, mode === 'pending' ? 0 : 1,
	'pending original generation does not grant a second write');
      assert.equal(writes.length, canReplay ? 2 : 1);
      if (canReplay) assert.equal(writes[0], writes[1], 'signature, target and value bytes identical');
    } finally {
      if (canReplay) await broker.close();
      else await assert.rejects(broker.close(), /quarantined/);
    }
  }
});

test('natural child exit after a lost terminal submit ACK keeps exact receipt-only custody', async () => {
  const routes: string[] = [];
  let grant: ReturnType<Awaited<ReturnType<typeof createRoutingBroker>>['issue']> | undefined;
  let intentId = '';
  let digest = '';
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url, init) => {
      const route = String(url).split('/api/')[1]!;
      routes.push(route);
      if (route === 'get_order') return Response.json(parentOrder());
      if (route === 'routing_submit_conditional/v1') {
	intentId = new Headers(init!.headers).get('X-Owenloop-Routing-Intent')!;
	digest = createHash('sha256').update(String(init!.body)).digest('hex');
	grant?.terminal('child-exit');
	throw new Error('terminal ACK lost');
      }
      if (route === 'routing_submit_conditional_receipt/v1') {
	const query = JSON.parse(String(init!.body)) as { intentId: string; requestDigest: string };
	assert.equal(query.intentId, intentId);
	assert.equal(query.requestDigest, digest);
	return Response.json({ state: 'committed', result: { text: 'accepted', outcome: 'submitted',
	  closed: true, conditionApplied: 'routed-conditional-receipt-v1' } });
      }
      throw new Error(`unexpected routed request ${route}`);
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
      submissionAuthority: { verifyOrder: async () => {}, canSubmit: () => true,
	sign: async () => 'parent-proof' } });
    grant.activate(child);
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'get_order',
      body: { holder } })).ok, true);
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'submit',
      body: { path: 'out', value: { completed: true }, holder } })).ok, false);
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'submit',
      body: { path: 'out', value: { completed: true }, holder } })).ok, false);
    await broker.close();
    assert.equal(routes.filter(route => route === 'routing_submit_conditional/v1').length, 1);
    assert.ok(routes.includes('routing_submit_conditional_receipt/v1'));
    assert.equal(routes.includes('routing_submit_conditional_receipt_revoke/v1'), false);
  } finally { await broker.close().catch(() => {}); }
});

test('a valid issued seal target still cannot sign or send a dynamic collection member', async () => {
  let signatures = 0, writes = 0;
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url) => {
      if (String(url).endsWith('/get_order')) return Response.json(parentOrder());
      writes++;
      throw new Error('collection member must not reach Service without an issued member proof');
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
      submissionAuthority: { verifyOrder: async () => {}, canSubmit: () => false,
	sign: async () => { signatures++; return 'seal-proof-would-be-dropped'; } } });
    grant.activate(child);
    await request(grant.socketPath, { cap: grant.cap, method: 'get_order', body: { holder } });
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'submit',
      body: { path: 'out', value: { member: 1 }, holder } })).ok, false);
    assert.equal(signatures, 0);
    assert.equal(writes, 0);
  } finally { await broker.close(); }
});

test('routed get_order requires current parent trust before delivering any order packet', async () => {
  let contacts = 0;
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async () => { contacts++; return Response.json(parentOrder()); }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const missing = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub });
    missing.activate(child);
    assert.equal((await request(missing.socketPath, { cap: missing.cap, method: 'get_order', body: { holder } })).ok, false);
    assert.equal(contacts, 0, 'no parent validator means no lifecycle contact');
    missing.terminal();
    const revoked = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
      submissionAuthority: { canSubmit: () => true, sign: async () => 'proof',
	verifyOrder: async () => { throw new Error('current operator trust revoked'); } } });
    revoked.activate(child);
    const result = await request(revoked.socketPath, { cap: revoked.cap, method: 'get_order', body: { holder } });
    assert.equal(result.ok, false);
    assert.equal('order' in result, false);
    assert.equal(contacts, 1);
  } finally { await broker.close(); }
});

test('malformed routed value never signs or writes and a corrected object remains usable', async () => {
  let signatures = 0, writes = 0;
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
    fetchImpl: (async (url) => {
      if (String(url).endsWith('/get_order')) return Response.json(parentOrder());
      if (String(url).endsWith('/routing_submit_conditional_receipt_revoke/v1'))
	return Response.json({ revoked: true });
      writes++;
      return Response.json({ text: 'ok', outcome: 'submitted', closed: false,
	conditionApplied: 'routed-conditional-receipt-v1' });
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
      submissionAuthority: { verifyOrder: async () => {}, canSubmit: () => true,
	sign: async () => { signatures++; return 'parent-proof'; } } });
    grant.activate(child);
    const send = (value: unknown) => request(grant.socketPath, { cap: grant.cap, method: 'submit',
      body: { path: 'out', value, holder } });
    await request(grant.socketPath, { cap: grant.cap, method: 'get_order', body: { holder } });
    for (const value of ['not-json', [], 1, null]) assert.equal((await send(value)).ok, false);
    assert.equal(signatures, 0);
    assert.equal(writes, 0);
    assert.equal((await send({ corrected: true })).ok, true);
    assert.equal(signatures, 1);
    assert.equal(writes, 1);
  } finally { await broker.close(); }
});

test('parent live selection gate refuses missing authority, local roster drift and expiry before launch writes', async () => {
  const launch = { version: 'launch-reservation-v1', claimId: 'run', decisionId: 'decision',
    binding, orderId: 'run', attemptId: 'run', rosterRevision: 'roster-v1', candidateIds: [],
    assessmentId: null, requested: null, selected: null };
  for (const mode of ['missing', 'drift', 'expiry']) {
    let now = 2_000, writes = 0;
    const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
      routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => now },
      fetchImpl: (async (url) => {
	if (String(url).endsWith('/get_order')) return Response.json(parentOrder());
	writes++;
	return Response.json({ reservationId: 'lr', orderId: 'run', expiresAt: 40_000 });
      }) as typeof fetch,
    });
    const broker = await createRoutingBroker({ now: () => now });
    try {
      const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
	submissionAuthority: transportAuthority,
	...(mode === 'missing' ? {} : { launchAuthority: { verifySelection: async () => {
	  if (mode === 'drift') throw new Error('current machine roster changed');
	  now = 75_000;
	} } }) });
      grant.activate(child);
      assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'reserve_launch',
	body: { request: launch } })).ok, false, mode);
      assert.equal(writes, 0, mode);
    } finally { await broker.close(); }
  }
});

test('prestart report rechecks parent selection and exact acknowledgement after reservation', async () => {
  const launch = { version: 'launch-reservation-v1', claimId: 'run', decisionId: 'decision',
    binding, orderId: 'run', attemptId: 'run', rosterRevision: 'roster-v1', candidateIds: [],
    assessmentId: null, requested: null, selected: null };
  const report = { version: 'launch-v1', reservationId: 'lr', decisionId: 'decision',
    binding, claimId: 'run', orderId: 'run', attemptId: 'run', requested: null,
    selected: null, observation: { state: 'unknown' } };
  for (const mode of ['drift', 'bad-ack']) {
    let drift = false, reports = 0, selections = 0;
    const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
      routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => 2_000 },
      fetchImpl: (async (url) => {
	if (String(url).endsWith('/get_order')) return Response.json(parentOrder());
	if (String(url).endsWith('/reserve_launch')) return Response.json({ reservationId: 'lr', orderId: 'run', expiresAt: 40_000 });
	reports++;
	return Response.json({ orderId: 'run', digest: 'wrong-digest', recordedAt: 2_000, provenance: 'authenticated-worker-report' });
      }) as typeof fetch,
    });
    const broker = await createRoutingBroker({ now: () => 2_000 });
    try {
      const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub,
	submissionAuthority: transportAuthority, launchAuthority: { verifySelection: async (_order, request) => {
	  selections++;
	  assert.deepEqual(request, launch);
	  if (drift) throw new Error('adapter unavailable');
	} } });
      grant.activate(child);
      const send = (method: string, body: unknown) => request(grant.socketPath, { cap: grant.cap, method, body });
      assert.equal((await send('reserve_launch', { request: launch })).ok, true);
      drift = mode === 'drift';
      assert.equal((await send('report_launch', { report })).ok, false);
      assert.equal((await send('get_launch_order', { holder })).ok, false);
      assert.equal(selections, 2);
      assert.equal(reports, mode === 'drift' ? 0 : 1);
    } finally {
      if (mode === 'bad-ack') await assert.rejects(broker.close(), /quarantined/);
      else await broker.close();
    }
  }
});

test('final role launch read checks accepted report and current selection without expiring ordinary holder reads', async () => {
  let now = 2_000, drift = false, expireDuringSelection = false, selections = 0;
  const pinned = { ...routing, claim: { ...routing.claim, attemptId: 'attempt_distinct' } };
  const launch = { version: 'launch-reservation-v1' as const, claimId: 'run', decisionId: 'decision',
    binding, orderId: 'run', attemptId: 'attempt_distinct', rosterRevision: 'roster-v1', candidateIds: [],
    assessmentId: null, requested: null, selected: null };
  const calls: string[] = [];
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => now },
    fetchImpl: (async (url, init) => {
      const verb = String(url).split('/').at(-1)!;
      calls.push(verb);
      if (verb === 'get_order') {
	const current = parentOrder();
	current.order.routing = pinned;
	return Response.json(current);
      }
      if (verb === 'reserve_launch') return Response.json({ reservationId: 'lr_distinct', orderId: 'run', expiresAt: 40_000 });
      const report = JSON.parse(String(init!.body)).report;
      return Response.json({ orderId: 'run', digest: valueDigestHex(report), recordedAt: now,
	provenance: 'authenticated-worker-report' });
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => now });
  try {
    const grant = broker.issue({ reservation, routing: pinned, identity, currentIdentity: () => identity, hub,
      submissionAuthority: transportAuthority, launchAuthority: { verifySelection: async (_order, selected) => {
	selections++;
	assert.deepEqual(selected, launch);
	if (drift) throw new Error('current parent roster changed');
	if (expireDuringSelection) now = 45_000;
      } } });
    grant.activate(child);
    const client = createRoutingChildClient({ broker: grant, reservation });
    const read = { workflow: 'wf', run: 'run', holder };
    await assert.rejects(client.getLaunchOrder(read), /routing broker unavailable/);
    assert.equal(calls.length, 0, 'no final launch read without an accepted reservation/report');
    await client.reserveLaunch({ workflow: 'wf', request: launch });
    await assert.rejects(client.getLaunchOrder(read));
    const report = { version: 'launch-v1' as const, reservationId: 'lr_distinct', decisionId: 'decision',
      binding, claimId: 'run', orderId: 'run', attemptId: 'attempt_distinct', requested: null,
      selected: null, observation: { state: 'unknown' as const } };
    await client.reportLaunch({ workflow: 'wf', report });
    assert.equal((await client.getLaunchOrder(read)).order?.run, 'run');
    assert.equal(selections, 3, 'reserve, report, and final read each verify current parent selection');
    const prior = calls.length;
    await assert.rejects(client.reserveLaunch({ workflow: 'wf', request: { ...launch, attemptId: 'invented' } }));
    assert.equal(calls.length, prior, 'opaque attempt must still match the pinned Service claim');
    drift = true;
    await assert.rejects(client.getLaunchOrder(read));
    assert.equal((await client.getOrder(read)).order?.run, 'run', 'ordinary scoped reads do not grant a new start');
    drift = false;
    expireDuringSelection = true;
    await assert.rejects(client.getLaunchOrder(read), /routing broker unavailable/);
    expireDuringSelection = false;
    now = 45_000;
    await assert.rejects(client.getLaunchOrder(read), /routing broker unavailable/);
    now = 75_000;
    assert.equal((await client.getOrder(read)).order?.run, 'run', 'launch window is not the live claim lifetime');
  } finally { await broker.close(); }
});

test('parent input gate binds the Service root to a nested frame and permits prestart heartbeat only with current witness', async () => {
  let now = 2_000;
  let witnessChanged = false;
  const routes: string[] = [];
  const framed = { ...routing, preference: { ...routing.preference,
    rosterRevision: 'a'.repeat(64) } };
  const packet = { ...parentOrder().order, workflow: 'frame', routing: framed,
    owes: [{ path: 'out', version: 1, judgmentRejects: 0, schemaRejects: 0,
      reasons: [] }] };
  const current = { ...parentOrder(), workflow: 'frame', order: packet };
  const referenceBinding = { rootWorkflow: 'wf', frameWorkflow: 'frame', run: 'run',
    claimId: 'run', decisionId: 'decision', sessionId, shiftId: identity.shiftId,
    orderDigest: 'b'.repeat(64), authorityRevision: 'c'.repeat(64),
    rosterRevision: framed.preference.rosterRevision, routingDigest: valueDigestHex(framed),
    preferenceExpiresAt: framed.preference.expiresAt };
  const pair = (): { reference: RoutedReferenceV2; claim: RoutedClaimV2 } => {
    const binding = { ...referenceBinding,
      orderDigest: witnessChanged ? 'd'.repeat(64) : referenceBinding.orderDigest };
    return { reference: { protocol: 'trusted-routed-reference-read-v2', state: 'available',
      workflow: 'wf', run: 'run', order: { ...packet,
	owes: [{ path: 'out', version: 1 }] } as unknown as OrderPacket,
      inputs: [], lease: { claimed: true }, binding },
    claim: { protocol: 'routing-claim-read-v2', state: 'available', workflow: 'wf', run: 'run',
      routing: framed, binding } };
  };
  const phases: string[] = [];
  assert.equal(parseRoutedReferenceV2(pair().reference,
    { workflow: 'wf', run: 'run' }).state, 'available');
  let delayed: Promise<ReturnType<typeof pair>> | undefined;
  let observing!: () => void;
  const observed = new Promise<void>(resolve => { observing = resolve; });
  let finish!: (value: ReturnType<typeof pair>) => void;
  const hub = createHubClient({ origin, getToken: async () => 'parent-bearer',
    routingSession: { allowedOrigin: origin, get: () => ({ ...identity, credential }), now: () => now },
    fetchImpl: (async url => {
      const route = String(url).split('/api/')[1]!;
      routes.push(route);
      return Response.json(route === 'get_order' ? current : { ok: true, text: 'ok' });
    }) as typeof fetch });
  const broker = await createRoutingBroker({ now: () => now });
  try {
    const grant = broker.issue({ reservation, routing: framed, identity,
      currentIdentity: () => identity, hub, submissionAuthority: transportAuthority,
      inputAuthority: { observe: async (response, phase) => {
	assert.equal(response.workflow, 'frame');
	phases.push(phase);
	if (delayed) { observing(); return delayed; }
	return pair();
      } } });
    grant.activate(child);
    const send = (method: string, body: unknown) => request(grant.socketPath,
      { cap: grant.cap, method, body });
    assert.equal((await send('get_order', { holder })).ok, true);
    assert.equal((await send('heartbeat', { holder })).ok, true);
    assert.deepEqual(phases, ['prestart', 'prestart']);
    assert.deepEqual(routes, ['get_order', 'get_order', 'heartbeat']);
    witnessChanged = true;
    assert.equal((await send('heartbeat', { holder })).ok, false);
    assert.equal(routes.at(-1), 'get_order', 'changed witness cannot issue a heartbeat');
    now = 75_000;
    assert.equal((await send('heartbeat', { holder })).ok, false,
      'startup preference does not become a fresh launch after expiry');
    now = 2_000;
    witnessChanged = false;
    delayed = new Promise(resolve => { finish = resolve; });
    const pending = send('get_order', { holder });
    await observed;
    grant.terminal();
    finish(pair());
    assert.equal((await pending).ok, false,
      'a completed witness after grant revocation cannot return a packet');
  } finally { await broker.close(); }
});
