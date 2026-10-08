import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createHubClient } from '../src/hub/client.ts';
import { createRoutingChildClient } from '../src/hub/routing-child-client.ts';
import { createRoutingHolderClient } from '../src/hub/routing-holder-client.ts';
import type { DecisionBindingV1, ReferenceRouting } from '../src/hub/types.ts';
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
      return Response.json(verb === 'get_order' ? orderResponse : { text: 'ok' });
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    assert.equal(statSync(broker.socketPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(broker.socketPath, '..')).mode & 0o777, 0o700);
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => live, hub });
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
    assert.deepEqual(calls.map(call => call.verb), ['get_order', 'reserve_launch', 'report_launch']);
    grant.terminal();
    assert.equal((await send('get_order', { holder })).ok, false);
    assert.equal(calls.length, 3);
    live = { ...live, sessionId: 'rs_changed' };
    assert.throws(() => broker.issue({ reservation, routing, identity, currentIdentity: () => live, hub }),
      /grant refused/);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
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
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub });
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
    const first = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub });
    first.activate(child);
    assert.equal((await request(first.socketPath, { cap: first.cap, method: 'reserve_launch',
      body: { request: launch } })).ok, false, 'Service expiry may not widen the local claim bound');
    first.terminal();
    delayed = true;
    const second = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub });
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
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub });
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
      const verb = String(url).split('/').at(-1)!;
      calls.push({ verb, body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
      if (verb === 'get_order') return Response.json(orderResponse);
      if (verb === 'heartbeat') return Response.json({ text: 'ok', ok: true });
      if (verb === 'submit') return Response.json({ text: 'ok', outcome: 'submitted', closed: true });
      if (verb === 'release') return Response.json({ text: 'ok', released: true });
      throw new Error('unexpected routed request');
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => now });
  try {
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => current, hub });
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
    assert.deepEqual(calls.map(call => call.verb), ['get_order', 'heartbeat', 'submit', 'release']);
    for (const call of calls) {
      assert.equal(call.headers.get('Authorization'), 'Bearer enrolled');
      assert.equal(call.headers.get('X-Owenloop-Routing-Session'), credential);
      assert.equal(call.body.workflow, 'wf');
      assert.equal(call.body.run, 'run');
    }
    grant.terminal();
    await assert.rejects(client.heartbeat({ workflow: 'wf', run: 'run', holder }), /routing broker unavailable/);
    current = { ...identity, sessionId: 'rs_changed' };
    assert.equal(calls.length, 4);
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
    const grant = broker.issue({ reservation: agentReservation, routing, identity, currentIdentity: () => identity, hub });
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
    await assert.rejects(mountHub.reject({ workflow: 'wf', run: 'run', path: 'out', text: 'no' }),
      /routed holder verb unavailable/);
    await assert.rejects(mountHub.release({ workflow: 'wf', run: 'run' }), /routed holder verb unavailable/);
    await assert.rejects(holderClient.getOrder({ workflow: 'wf', run: 'run', holder }), /broker unavailable/);
    await assert.rejects(client.getOrder({ workflow: 'wf', run: 'run', holder: sessionHolder }), /broker unavailable/);
    await assert.rejects(holderClient.release({ workflow: 'wf', run: 'run' }), /broker unavailable/);
    await assert.rejects(holderClient.readRoutingClaim({ workflow: 'wf', run: 'run' }), /broker unavailable/);
    assert.equal(seen.length, 3, 'holder cap cannot invoke role methods or spoof the exec holder');
    grant.terminal();
    await assert.rejects(holderClient.getOrder({ workflow: 'wf', run: 'run', holder: sessionHolder }), /broker unavailable/);
  } finally { await broker.close(); }
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
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => current, hub });
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
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub });
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
