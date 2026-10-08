import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createHubClient } from '../src/hub/client.ts';
import type { DecisionBindingV1, ReferenceRouting } from '../src/hub/types.ts';
import { createRoutingBroker } from '../src/shift/routing-broker.ts';
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
      return Response.json({ text: 'ok' });
    }) as typeof fetch,
  });
  const broker = await createRoutingBroker({ now: () => 2_000 });
  try {
    assert.equal(statSync(broker.socketPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(broker.socketPath, '..')).mode & 0o777, 0o700);
    const grant = broker.issue({ reservation, routing, identity, currentIdentity: () => live, hub });
    const send = (method: string, body: unknown, cap = grant.cap) => request(grant.socketPath, { cap, method, body });
    assert.equal((await send('get_order', {})).ok, true);
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { workflow: 'wf', run: 'run' });
    assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'), 'Bearer enrolled');
    assert.equal(new Headers(calls[0]!.init.headers).get('X-Owenloop-Routing-Session'), credential);
    assert.equal((await send('get_order', { workflow: 'other' })).ok, false);
    assert.equal((await send('get_order', {}, 'b'.repeat(64))).ok, false);
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
    assert.equal((await send('get_order', {})).ok, false);
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
    const response = await request(grant.socketPath, { cap: grant.cap, method: 'read_routing_claim', body: {} });
    assert.equal(response.ok, false);
    assert.equal(response.status, 429);
    assert.equal(response.retryAfterMs, 12_000);
    assert.equal(JSON.stringify(response).includes('secret'), false);
    now = 90_000;
    assert.equal((await request(grant.socketPath, { cap: grant.cap, method: 'get_order', body: {} })).ok, false);
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
    assert.equal((await request(first.socketPath, { cap: first.cap, method: 'reserve_launch',
      body: { request: launch } })).ok, false, 'Service expiry may not widen the local claim bound');
    first.terminal();
    delayed = true;
    const second = broker.issue({ reservation, routing, identity, currentIdentity: () => identity, hub });
    const result = request(second.socketPath, { cap: second.cap, method: 'reserve_launch', body: { request: launch } });
    await fetchStarted;
    second.terminal();
    reply(Response.json({ reservationId: 'lr_late', orderId: 'run', expiresAt: 40_000 }));
    assert.equal((await result).ok, false, 'revoked grant cannot deliver or cache an in-flight result');
  } finally { await broker.close(); }
});
