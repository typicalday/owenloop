import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHubClient } from '../src/hub/client.ts';
import { HubError } from '../src/hub/types.ts';
import type { LaunchReservationRequestV1 } from '../src/hub/types.ts';
import { createRoutingBackoff } from '../src/shift/runtime.ts';

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Build a fake `fetch` that records the request and returns a canned response. */
function fakeFetch(
  captured: Captured[],
  response: { status?: number; body: unknown; headers?: Record<string, string> },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    captured.push({
      method: init?.method ?? 'GET',
      url,
      headers,
      body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
    });
    const status = response.status ?? 200;
    return new Response(JSON.stringify(response.body), {
      status,
      headers: { 'content-type': 'application/json', ...response.headers },
    });
  }) as typeof fetch;
}

function client(fetchImpl: typeof fetch, getToken = async () => 'tok-123') {
  return createHubClient({ origin: 'https://hub.example/', getToken, fetchImpl });
}

test('whatsNext POSTs to /api/whats_next with bearer header and JSON body', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'ok', orders: [] } }));
  const res = await c.whatsNext({ workflow: 'wf1', serve_crews: ['a'], serve_capabilities: ['build', 'build:deep'] });

  const req = captured[0]!;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://hub.example/api/whats_next');
  assert.equal(req.headers['authorization'], 'Bearer tok-123');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.deepEqual(req.body, { workflow: 'wf1', serve_crews: ['a'], serve_capabilities: ['build', 'build:deep'] });
  assert.equal(res.text, 'ok');
  assert.deepEqual(res.orders, []);
});

test('whatsNext preserves modern defDigest routing with explicit or default worker projection', async () => {
  const captured: Captured[] = [];
  const explicitAgent = {
    workflow: 'wf1',
    run: 'run_explicit',
    step: 'builder',
    worker: 'agent',
    defDigest: 'sha256:explicit-agent',
    consumes: {},
    expected_outputs: [],
    feedback: [],
    advisory: {},
    submit_hint: '',
  };
  const defaultAgent = {
    ...explicitAgent,
    run: 'run_default',
    defDigest: 'sha256:default-agent',
  };
  delete (defaultAgent as { worker?: string }).worker;
  const c = client(fakeFetch(captured, {
    body: { text: 'ok', workflow: 'wf1', orders: [explicitAgent, defaultAgent] },
  }));

  const response = await c.whatsNext({ workflow: 'wf1', serve_capabilities: [] });

  assert.deepEqual(response.orders?.[0], explicitAgent);
  assert.equal(response.orders?.[1]?.defDigest, 'sha256:default-agent');
  assert.equal(Object.prototype.hasOwnProperty.call(response.orders?.[1], 'worker'), false);
  assert.deepEqual(response.orders?.[1], defaultAgent);
});

test('whatsNext sends the required empty serving-set advertisement', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'ok' } }));
  await c.whatsNext({ serve_capabilities: [] });
  assert.deepEqual(captured[0]!.body, { serve_capabilities: [] });
});

test('getOrder and heartbeat pass the holder tag through', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'ok' } }));
  await c.getOrder({ workflow: 'wf1', run: 'r1', holder: { kind: 'session', id: 's1' } });
  await c.heartbeat({ workflow: 'wf1', run: 'r1', holder: { kind: 'exec', id: 'e1' } });

  assert.equal(captured[0]!.url, 'https://hub.example/api/get_order');
  assert.deepEqual(captured[0]!.body, { workflow: 'wf1', run: 'r1', holder: { kind: 'session', id: 's1' } });
  assert.equal(captured[1]!.url, 'https://hub.example/api/heartbeat');
  assert.deepEqual(captured[1]!.body, { workflow: 'wf1', run: 'r1', holder: { kind: 'exec', id: 'e1' } });
});

test('release carries either XOR form unchanged', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'ok' } }));
  await c.release({ session: 's1' });
  await c.release({ workflow: 'wf1', run: 'r1' });
  await c.release({ workflow: 'wf1', run: 'r1', reason: 'no-template' });

  assert.deepEqual(captured[0]!.body, { session: 's1' });
  assert.deepEqual(captured[1]!.body, { workflow: 'wf1', run: 'r1' });
  assert.deepEqual(captured[2]!.body, { workflow: 'wf1', run: 'r1', reason: 'no-template' });
});

test('submit sends its full body including done', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'ok' } }));
  await c.submit({ workflow: 'wf1', run: 'r1', path: 'pr', value: { n: 1 }, done: true });
  assert.deepEqual(captured[0]!.body, { workflow: 'wf1', run: 'r1', path: 'pr', value: { n: 1 }, done: true });
});

test('conditional submit uses only the versioned route with the observed version', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, {
    body: { text: 'accepted', outcome: 'green', closed: true, conditionApplied: 'expected-version-v1' },
  }));
  const req = { workflow: 'wf1', run: 'r1', path: 'pr', value: { n: 1 }, done: true, expectedVersion: 3 };
  const result = await c.submitConditional!(req);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.url, 'https://hub.example/api/submit/conditional-v1');
  assert.deepEqual(captured[0]!.body, req);
  assert.equal(result.conditionApplied, 'expected-version-v1');
});

test('conditional submit does not fall back to legacy submit when the route is absent', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { status: 404, body: { error: 'not_found', message: 'route unavailable' } }));
  await assert.rejects(() => c.submitConditional!({
    workflow: 'wf1', run: 'r1', path: 'pr', value: { n: 1 }, expectedVersion: 3,
  }), (error: unknown) => error instanceof HubError && error.status === 404);
  assert.deepEqual(captured.map((request) => request.url), ['https://hub.example/api/submit/conditional-v1']);
});

test('routed conditional transport preserves frozen body and exact original-session receipt routes', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const c = createHubClient({ origin: 'https://hub.example', getToken: async () => 'server-bearer',
    routingSession: { allowedOrigin: 'https://hub.example', get: () => ({
      sessionId: 'rs', shiftId: 'shf', credential: 'private-session', expiresAt: 2000,
    }), now: () => 1000 },
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return Response.json(requests.length === 1
	? { text: 'accepted', outcome: 'green', closed: true,
	  conditionApplied: 'routed-conditional-receipt-v1' }
	: { state: 'committed', result: { text: 'accepted', outcome: 'green', closed: true,
	  conditionApplied: 'routed-conditional-receipt-v1' } });
    }) as typeof fetch,
  });
  const rawBody = String.raw`{"workflow":"wf","run":"run","value":{"n":1},"proof":"p"}`;
  const intentId = 'a'.repeat(32);
  const mutation = await c.routingConditionalMutation({ intentId, rawBody });
  assert.equal(mutation.conditionApplied, 'routed-conditional-receipt-v1');
  const holder = { kind: 'exec' as const, id: 'host:123', shiftId: 'shf' };
  const receipt = await c.routingConditionalReceipt({ workflow: 'wf', run: 'run', intentId,
    requestDigest: 'b'.repeat(64), holder });
  assert.equal(receipt.state, 'committed');
  assert.deepEqual(requests.map(row => row.url), [
    'https://hub.example/api/routing_submit_conditional/v1',
    'https://hub.example/api/routing_submit_conditional_receipt/v1',
  ]);
  assert.equal(requests[0]!.init.body, rawBody, 'mutation sends byte-identical frozen JSON text');
  assert.equal(new Headers(requests[0]!.init.headers).get('x-owenloop-routing-intent'), intentId);
  for (const row of requests) {
    assert.equal(row.init.redirect, 'error');
    assert.equal(new Headers(row.init.headers).get('authorization'), 'Bearer server-bearer');
    assert.equal(new Headers(row.init.headers).get('x-owenloop-routing-session'), 'private-session');
    assert.equal(String(row.init.body).includes('private-session'), false);
  }
});

test('reject POSTs /api/reject without a client-supplied by field', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'rejected', ok: true, closed: false } }));
  const res = await c.reject({ workflow: 'wf1', run: 'r1', path: 'input', text: 'bad value' });
  assert.equal(captured[0]!.method, 'POST');
  assert.equal(captured[0]!.url, 'https://hub.example/api/reject');
  assert.deepEqual(captured[0]!.body, { workflow: 'wf1', run: 'r1', path: 'input', text: 'bad value' });
  assert.equal((captured[0]!.body as Record<string, unknown>)['by'], undefined);
  assert.equal(res.ok, true);
  assert.equal(res.closed, false);
});

test('retryArtifact POSTs the human stall-clear body without run or by', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'retried', ok: true, closed: false } }));
  const res = await c.retryArtifact!({ workflow: 'wf1', path: 'pr', text: 'use the fixture' });
  assert.equal(captured[0]!.method, 'POST');
  assert.equal(captured[0]!.url, 'https://hub.example/api/retry_artifact');
  assert.deepEqual(captured[0]!.body, { workflow: 'wf1', path: 'pr', text: 'use the fixture' });
  assert.equal((captured[0]!.body as Record<string, unknown>)['run'], undefined);
  assert.equal((captured[0]!.body as Record<string, unknown>)['by'], undefined);
  assert.equal(res.ok, true);
  assert.equal(res.closed, false);
});

test('whoami GETs /api/whoami', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'ok', orgId: 'o1', orgName: 'Org', actor: { id: 'a', kind: 'agent', role: 'agent', scopes: [] }, tokenStatus: 'active', authMethod: 'token' } }));
  const res = await c.whoami();
  assert.equal(captured[0]!.method, 'GET');
  assert.equal(captured[0]!.url, 'https://hub.example/api/whoami');
  assert.equal(res.orgId, 'o1');
});

test('getRosters and listHarnessModels map to their GET endpoints', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'ok', global: {}, crews: [] } }));
  const rosters = await c.getRosters!();
  await c.listHarnessModels!();
  assert.equal(captured[0]!.method, 'GET');
  assert.equal(captured[0]!.url, 'https://hub.example/api/rosters');
  assert.equal(captured[1]!.method, 'GET');
  assert.equal(captured[1]!.url, 'https://hub.example/api/harness_models');
  assert.deepEqual(rosters.global, {});
});

test('wake GETs /api/wake with the cursor in the query string when set', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'cursor=7 changed=true', cursor: 7, changed: true } }));
  const res = await c.wake(3);

  assert.equal(captured[0]!.method, 'GET');
  assert.equal(captured[0]!.url, 'https://hub.example/api/wake?cursor=3');
  assert.equal(captured[0]!.headers['authorization'], 'Bearer tok-123');
  assert.equal(captured[0]!.body, undefined);
  assert.equal(res.cursor, 7);
  assert.equal(res.changed, true);
});

test('wake omits the query string entirely when cursor is undefined (bootstrap)', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'cursor=9 changed=true', cursor: 9, changed: true } }));
  await c.wake();
  assert.equal(captured[0]!.url, 'https://hub.example/api/wake');
});

test('presencePing POSTs /api/presence_ping with name and serve_crews', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'presence recorded for box', ok: true, name: 'box', lastSeen: 123 } }));
  const res = await c.presencePing({ name: 'box', serve_crews: ['a', 'b'], serve_capabilities: ['build'] });

  assert.equal(captured[0]!.method, 'POST');
  assert.equal(captured[0]!.url, 'https://hub.example/api/presence_ping');
  assert.deepEqual(captured[0]!.body, { name: 'box', serve_crews: ['a', 'b'], serve_capabilities: ['build'] });
  assert.equal(res.ok, true);
  assert.equal(res.name, 'box');
  assert.equal(res.lastSeen, 123);
});

test('wake surfaces a non-2xx as a HubError like every other verb', async () => {
  const c = client(fakeFetch([], { status: 403, body: { error: 'forbidden', message: 'no' } }));
  await assert.rejects(() => c.wake(1), (err: unknown) => {
    assert.ok(err instanceof HubError);
    assert.equal(err.status, 403);
    return true;
  });
});

test('non-2xx with {error,message} JSON becomes a HubError carrying status and code', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { status: 400, body: { error: 'bad_request', message: 'nope' } }));
  await assert.rejects(
    () => c.submit({ workflow: 'wf1', run: 'r1', path: 'pr', value: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof HubError);
      assert.equal(err.status, 400);
      assert.equal(err.code, 'bad_request');
      assert.equal(err.message, 'nope');
      return true;
    },
  );
});

test('429 Retry-After metadata is normalized onto HubError', async () => {
  const c = client(fakeFetch([], {
    status: 429,
    body: { error: 'rate_limited', message: 'slow down' },
    headers: { 'retry-after': '17' },
  }));
  await assert.rejects(() => c.wake(1), (err: unknown) => {
    assert.ok(err instanceof HubError);
    assert.equal(err.status, 429);
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.retryAfterMs, 17_000);
    return true;
  });
});

test('non-2xx non-JSON keeps the raw text as the message', async () => {
  const badFetch = (async () =>
    new Response('gateway boom', { status: 502 })) as typeof fetch;
  const c = client(badFetch);
  await assert.rejects(
    () => c.whoami(),
    (err: unknown) => {
      assert.ok(err instanceof HubError);
      assert.equal(err.status, 502);
      assert.equal(err.message, 'gateway boom');
      assert.equal(err.code, undefined);
      return true;
    },
  );
});

test('default fetch path works end to end against a real node:http server', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: 'live', echoAuth: req.headers['authorization'], echoBody: JSON.parse(body || '{}') }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const c = createHubClient({ origin: `http://127.0.0.1:${port}`, getToken: async () => 'live-tok' });
    const res = (await c.whatsNext({ workflow: 'wf1', serve_capabilities: [] })) as { text: string; echoAuth: string; echoBody: unknown };
    assert.equal(res.text, 'live');
    assert.equal(res.echoAuth, 'Bearer live-tok');
    assert.deepEqual(res.echoBody, { workflow: 'wf1', serve_capabilities: [] });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('presencePing forwards attended_at using the exact snake_case wire field', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'presence recorded', ok: true, name: 'box', lastSeen: 123 } }));
  await c.presencePing({ name: 'box', serve_crews: [], serve_capabilities: [], attended_at: 456789 });
  assert.deepEqual(captured[0]!.body, { name: 'box', serve_crews: [], serve_capabilities: [], attended_at: 456789 });
  assert.equal((captured[0]!.body as Record<string, unknown>)['attendedAt'], undefined);
});

// Frozen REST contract: reviewed service ab73dce, not a model-facing secret channel.
test('command grants and model routing cannot share a poll or credential', async () => {
  const sent: Captured[] = [];
  const request = { workflow: 'wf', serve_capabilities: [], serve_commands: true };
  const scoped = createHubClient({ origin: 'https://hub.example', getToken: async () => 'enrolled',
    fetchImpl: fakeFetch(sent, { body: {} }), routingSession: { allowedOrigin: 'https://hub.example',
      get: () => undefined } });
  await assert.rejects(scoped.whatsNext(request), /command-only polls cannot select model routing/);
  await assert.rejects(client(fakeFetch(sent, { body: {} })).whatsNext({ ...request,
    routing: { kind: 'ready_firing' } }), /command-only polls cannot select model routing/);
  assert.deepEqual(sent, []);
});

test('a cancelled scoped holder read never sends after credential resolution', async () => {
  const cancelled = new AbortController();
  const sent: Captured[] = [];
  const scoped = createHubClient({ origin: 'https://hub.example',
    getToken: async () => { cancelled.abort(); return 'fixture'; },
    routingSession: { allowedOrigin: 'https://hub.example',
      get: () => ({ sessionId: 's1', shiftId: 'shift', credential: 'fixture', expiresAt: 10 }), now: () => 1 },
    fetchImpl: fakeFetch(sent, { body: {} }) });
  await assert.rejects(scoped.getOrder({ workflow: 'wf', run: 'run' }, cancelled.signal));
  assert.deepEqual(sent, []);
});

test('routing session transport pins HTTPS origin, keeps capability in headers and preserves native evidence', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const authority = { sessionId: 'rs_session', shiftId: 'shf_service', credential: 'private-capability', expiresAt: 2000 };
  const evidence = { text: 'order', order: { routing: { claim: { orderId: 'run' } }, consumesProof: 'signed', consumesProofRelay: { child: { childDefDigest: 'digest', childVersion: 2, childOutcome: 'done' } } } };
  const c = createHubClient({ origin: 'https://hub.example', getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: 'https://hub.example', get: () => authority, now: () => 1000 },
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return Response.json(evidence);
    }) as typeof fetch,
  });
  const scope = { workflows: ['wf'], crews: ['crew'], capabilities: ['build'] };
  await c.openRoutingSession({ scope });
  await c.renewRoutingSession();
  await c.routingOfferContext({ workflow: 'wf', serve_capabilities: ['build'], serve_crews: ['crew'], frameId: 'frame' });
  const submission = { candidateId: 'candidate', crewId: 'crew-id', capability: 'build', offer: { offerId: 'offer' } };
  await c.putShiftOffer({ workflow: 'wf', serve_capabilities: ['build'], submission: submission as never });
  await c.whatsNext({ workflow: 'wf', serve_capabilities: ['build'], routing: { kind: 'shift', frameId: 'frame' } });
  assert.deepEqual(await c.getOrder({ workflow: 'wf', run: 'run' }), evidence);
  await c.readRoutingClaim({ workflow: 'wf', run: 'run' });
  const binding = { workflow: 'wf', orderId: 'run', parentWorkflow: 'parent', parentDefRef: { bundleDigest: 'a'.repeat(64), workflowName: 'parent' }, callPath: 'child', parentArtifactVersion: 2 };
  await c.readInvocationBinding(binding);
  await c.reportLaunch({ workflow: 'wf', report: { version: 'launch-v1' } as never });
  await c.closeRoutingSession();
  assert.deepEqual(requests.map(r => r.url.split('/').at(-1)), ['routing_session_open', 'routing_session_renew', 'routing_offer_context', 'put_shift_offer', 'whats_next', 'get_order', 'read_routing_claim', 'read_invocation_binding', 'report_launch', 'routing_session_close']);
  for (const [index, r] of requests.entries()) {
    const headers = new Headers(r.init.headers);
    assert.equal(r.init.redirect, 'error');
    assert.equal(headers.get('authorization'), 'Bearer enrolled');
    assert.equal(headers.get('x-owenloop-routing-session'), index === 0 ? null : authority.credential);
    assert.equal(String(r.init.body).includes(authority.credential), false);
  }
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { scope });
  assert.deepEqual(JSON.parse(String(requests[3]!.init.body)).submission, submission);
  assert.deepEqual(JSON.parse(String(requests[7]!.init.body)), binding);
});

test('reserve_launch carries the exact session-scoped pre-start request with no bearer-only fallback', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const request: LaunchReservationRequestV1 = {
    version: 'launch-reservation-v1', claimId: 'claim', decisionId: 'decision',
    binding: {
      orgId: 'org', runId: 'run', frameId: 'frame',
      def: { bundleDigest: 'sha256:bundle', workflowName: 'wf' }, subjectKey: 'subject',
      evidenceDigest: 'sha256:evidence', candidateDigest: 'sha256:candidates', policyDigest: 'sha256:policy',
      revisions: { definition: '1', candidates: '1', policy: '1', authority: '1', rolePolicy: '1',
		roster: '1', routes: '1', membership: '1', evidenceGeneration: '1' },
      issuedAt: 1_000, expiresAt: 2_000,
      authority: { principalId: 'agent', sessionId: 'rs_session' },
    },
    orderId: 'run', attemptId: 'attempt', rosterRevision: 'roster-v1',
    candidateIds: ['tuple-first', 'tuple-second'], assessmentId: 'assessment',
    requested: { id: 'tuple-first', harness: 'codex', model: 'model-a', effort: 'high' },
    selected: { id: 'tuple-second', harness: 'codex', model: 'model-b', effort: 'high' },
  };
  const c = createHubClient({ origin: 'https://hub.example', getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: 'https://hub.example', get: () => ({
      sessionId: 'rs_session', shiftId: 'shf_service', credential: 'private-capability', expiresAt: 2_000,
    }), now: () => 1_000 },
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ reservationId: 'lr-reservation', orderId: 'run', expiresAt: 1_500 });
    }) as typeof fetch,
  });
  assert.deepEqual(await c.reserveLaunch({ workflow: 'wf', request }),
    { reservationId: 'lr-reservation', orderId: 'run', expiresAt: 1_500 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://hub.example/api/reserve_launch');
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.equal(new Headers(calls[0]!.init.headers).get('X-Owenloop-Routing-Session'), 'private-capability');
  assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'), 'Bearer enrolled');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { workflow: 'wf', request });
  const bare = createHubClient({ origin: 'https://hub.example', getToken: async () => 'enrolled',
    fetchImpl: (async () => { assert.fail('bearer-only reserve_launch reached transport'); }) as typeof fetch });
  await assert.rejects(bare.reserveLaunch({ workflow: 'wf', request }), /routing origin refused/);
});

test('explicit routed lifecycle uses session headers and shared sanitized Retry-After without legacy fallback', async () => {
  let monotonic = 0;
  const backoff = createRoutingBackoff(() => monotonic);
  const calls: Array<{ verb: string; init: RequestInit }> = [];
  const holder = { kind: 'exec' as const, id: 'host:123', shiftId: 'shf_service' };
  const c = createHubClient({ origin: 'https://hub.example', getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: 'https://hub.example',
      get: () => ({ sessionId: 'rs_session', shiftId: 'shf_service', credential: 'private-session', expiresAt: 100_000 }),
      now: () => 1_000, beforeRequest: backoff.beforeRequest, onRateLimit: backoff.onRateLimit },
    fetchImpl: (async (url, init) => {
      const verb = String(url).split('/').at(-1)!;
      calls.push({ verb, init: init! });
      if (verb === 'heartbeat') return new Response('secret upstream body and bearer',
	{ status: 429, headers: { 'Retry-After': '30' } });
      if (verb === 'submit') return Response.json({ text: 'ok', outcome: 'submitted', closed: true });
      if (verb === 'release') return Response.json({ text: 'ok', released: true });
      throw new Error('unexpected verb');
    }) as typeof fetch,
  });
  await assert.rejects(c.routingHeartbeat({ workflow: 'wf', run: 'run', holder }), error =>
    error instanceof HubError && error.status === 429 && error.retryAfterMs === 30_000
      && !error.message.includes('secret'));
  await assert.rejects(c.routingSubmit({ workflow: 'wf', run: 'run', path: 'out', value: {}, holder }),
    error => error instanceof HubError && error.status === 429);
  assert.deepEqual(calls.map(call => call.verb), ['heartbeat']);
  monotonic = 30_000;
  assert.equal((await c.routingSubmit({ workflow: 'wf', run: 'run', path: 'out', value: {}, holder })).closed, true);
  assert.equal((await c.routingRelease({ workflow: 'wf', run: 'run', reason: 'stop' })).released, true);
  assert.deepEqual(calls.map(call => call.verb), ['heartbeat', 'submit', 'release']);
  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer enrolled');
    assert.equal(headers.get('X-Owenloop-Routing-Session'), 'private-session');
    assert.equal(call.init.redirect, 'error');
  }
  await assert.rejects(c.heartbeat({ workflow: 'wf', run: 'run', holder }), /legacy POST refused/);
  const bare = createHubClient({ origin: 'https://hub.example', getToken: async () => 'enrolled',
    fetchImpl: (async () => { assert.fail('bare routed lifecycle reached fetch'); }) as typeof fetch });
  await assert.rejects(bare.routingHeartbeat({ workflow: 'wf', run: 'run', holder }), /routing origin refused/);
  await assert.rejects(bare.routingSubmit({ workflow: 'wf', run: 'run', path: 'out', value: {}, holder }),
    /routing origin refused/);
  await assert.rejects(bare.routingRelease({ workflow: 'wf', run: 'run' }), /routing origin refused/);
});

test('scoped file upload 429 redacts upstream body and blocks later routed verbs', async () => {
  let monotonic = 0;
  const backoff = createRoutingBackoff(() => monotonic);
  const requests: Array<{ url: string; headers: Headers }> = [];
  const c = createHubClient({ origin: 'https://hub.example', getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: 'https://hub.example',
      get: () => ({ sessionId: 'rs', shiftId: 'shf', credential: 'private-session', expiresAt: 100_000 }),
      now: () => 1_000, beforeRequest: backoff.beforeRequest, onRateLimit: backoff.onRateLimit },
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      if (String(url).includes('routing_file_artifacts')) return new Response('private-session secret',
	{ status: 429, headers: { 'Retry-After': '2' } });
      return Response.json({ text: 'ok', ok: true });
    }) as typeof fetch,
  });
  await assert.rejects(c.routingPutFileArtifact({ workflow: 'wf', run: 'run',
    body: Readable.from([Buffer.from('file')]), size: 4, contentType: 'text/plain' }),
  error => error instanceof HubError && error.status === 429 && error.retryAfterMs === 2_000
    && !error.message.includes('private-session'));
  await assert.rejects(c.routingAsk({ workflow: 'wf', run: 'run', path: 'out', question: 'help' }),
    error => error instanceof HubError && error.status === 429);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, 'https://hub.example/api/routing_file_artifacts/v1?workflow=wf&run=run');
  assert.equal(requests[0]?.headers.get('X-Owenloop-Routing-Session'), 'private-session');
  monotonic = 2_000;
  assert.equal((await c.routingAsk({ workflow: 'wf', run: 'run', path: 'out', question: 'help' })).ok, true);
  assert.equal(requests[1]?.url, 'https://hub.example/api/routing_ask/v1');
});

test('assessLocalModel uses the scoped service verb with exactly the reviewed body', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const c = createHubClient({ origin: 'https://hub.example', getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: 'https://hub.example', get: () => ({
      sessionId: 'rs_session', shiftId: 'shf_service', credential: 'private-capability', expiresAt: 2000,
    }), now: () => 1000 },
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return Response.json({ status: 'fallback', reason: 'provider unavailable', assessment: null });
    }) as typeof fetch,
  });

  await c.assessLocalModel!({ workflow: 'wf', run: 'run', candidateIds: ['tuple-a', 'tuple-b'] });

  assert.equal(requests[0]!.url, 'https://hub.example/api/assess_local_model');
  assert.equal(requests[0]!.init.method, 'POST');
  assert.equal(requests[0]!.init.redirect, 'error');
  const headers = new Headers(requests[0]!.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer enrolled');
  assert.equal(headers.get('x-owenloop-routing-session'), 'private-capability');
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), {
    workflow: 'wf', run: 'run', candidateIds: ['tuple-a', 'tuple-b'],
  });
  assert.equal(String(requests[0]!.init.body).includes('private-capability'), false);
});

test('a configured routing session binds ordinary polling and reference reads', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const c = createHubClient({ origin: 'https://hub.example', getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: 'https://hub.example', get: () => ({
      sessionId: 'rs', shiftId: 'shf', credential: 'rs1.rs.secret', expiresAt: 2000,
    }), now: () => 1000 },
    fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return Response.json({ text: 'ok', order: null });
    }) as typeof fetch,
  });
  await c.whatsNext({ workflow: 'wf', serve_capabilities: [] });
  await c.getReferenceOrder!({ workflow: 'wf', run: 'run' });
  assert.deepEqual(requests.map(r => r.url), [
    'https://hub.example/api/whats_next', 'https://hub.example/api/reference_order/v1',
  ]);
  for (const request of requests) {
    assert.equal(request.init.redirect, 'error');
    assert.equal(new Headers(request.init.headers).get('x-owenloop-routing-session'), 'rs1.rs.secret');
    assert.equal(String(request.init.body).includes('rs1.rs.secret'), false);
  }

  const legacy: Array<{ url: string; init: RequestInit }> = [];
  const ordinary = createHubClient({ origin: 'https://hub.example', getToken: async () => 'enrolled',
    fetchImpl: (async (url, init) => {
      legacy.push({ url: String(url), init: init! });
      return Response.json({ text: 'ok', order: null });
    }) as typeof fetch,
  });
  await ordinary.whatsNext({ workflow: 'wf', serve_capabilities: [] });
  await ordinary.getReferenceOrder!({ workflow: 'wf', run: 'run' });
  assert.equal(legacy.every(r => !new Headers(r.init.headers).has('x-owenloop-routing-session')), true);
  assert.equal(legacy.every(r => r.init.redirect === 'error'), true);
});

test('a routing client refuses legacy lifecycle writes before reading credentials or fetching', async () => {
  let tokenReads = 0;
  let sessionReads = 0;
  let fetches = 0;
  const c = createHubClient({ origin: 'https://hub.example',
    getToken: async () => { tokenReads++; return 'enrolled-secret'; },
    routingSession: { allowedOrigin: 'https://hub.example',
      get: () => { sessionReads++; return { sessionId: 'rs', shiftId: 'shf', credential: 'session-secret', expiresAt: 2000 }; },
      now: () => 1000 },
    fetchImpl: (async () => { fetches++; return Response.json({ text: 'unexpected' }); }) as typeof fetch,
  });
  for (const write of [
    () => c.heartbeat({} as never),
    () => c.release({ workflow: 'wf', run: 'run' }),
    () => c.submit({} as never),
    () => c.submitConditional!({} as never),
    () => c.reject({} as never),
    () => c.reportResolution({} as never),
    () => c.putFileArtifact({} as never),
  ]) {
    await assert.rejects(write, error => error instanceof Error
      && /routing session legacy POST refused/u.test(error.message)
      && !error.message.includes('secret'));
  }
  assert.deepEqual([tokenReads, sessionReads, fetches], [0, 0, 0]);
});

// Credential-free final-head service exchange. This is transport evidence only,
// not a live Jev result or a complete ReferenceRouting anchor.
// Source: model-routing-integration-preparation/worker-binding-preparation/
// settled-executed-http-fixture.json (SHA256 429274df2a4136317423856c424f2b82347ad706668eaf4657ff7217a9fe5a8a).
const SETTLED_EXECUTED_RESPONSE = String.raw`{"status":"advisory","reason":"supported_preference","assessment":{"advised":{"effort":"medium","harness":"codex","id":"b9045f516a08b3387d2e3f35fea63cade722e5f1810ad6a563bae7ddf8e2083c","model":"economical"},"anchorDigest":"sha256:d8a56ea7d40886fc173555b7279e5fccbf18b3e7814bb4e77f9a97115b041f03","assessmentId":"lma-1712b3cc-5b0d-46b1-a9e4-60358ac519ab","attemptId":"run_20ad2ca32adb87bfddbf362a","candidateDigest":"sha256:bdfb1a168ff3989628a07c03bc8b26991d9e7303b37af6df1f9586efbbd677bc","candidateIds":["7c773969c7ac4e35e0bcab090069e8d392a37541ed86e1ff4d3a878524d0b138","b9045f516a08b3387d2e3f35fea63cade722e5f1810ad6a563bae7ddf8e2083c"],"claimId":"run_20ad2ca32adb87bfddbf362a","createdAt":1790800211367,"decisionId":"routing-12da6b42-f121-42f5-8ac4-c77869d9bf9e","definition":{"bundleDigest":"sha256:620aed37bef6cb3b9a875d6c991b63bf5b3b25173b26c67a204615e36746dcd7","workflowName":"routing/local-model"},"expiresAt":1790800241329,"frameId":"wf_3f2869ff717fb20ff9693ec5","orderId":"run_20ad2ca32adb87bfddbf362a","policy":{"digest":"sha256:8afc3795bebadab8d9be2bc8e9f7d3166f49eca86c47647ec1ad6384b90b8dbf","id":"jev-routing-default","onFailure":"fallback","revision":"1"},"provider":{"cost":null,"model":"jev-1.13.0","usage":{"input_tokens":1,"output_tokens":1}},"reason":"supported_preference","status":"advisory","version":"local-model-assessment-v1","workflow":"wf_3f2869ff717fb20ff9693ec5"}}`;

test('assessLocalModel preserves the credential-free settled service response bytes', async () => {
  const body = { workflow: 'wf_3f2869ff717fb20ff9693ec5', run: 'run_20ad2ca32adb87bfddbf362a', candidateIds: [
    '7c773969c7ac4e35e0bcab090069e8d392a37541ed86e1ff4d3a878524d0b138',
    'b9045f516a08b3387d2e3f35fea63cade722e5f1810ad6a563bae7ddf8e2083c',
  ] };
  const c = createHubClient({ origin: 'https://hub.example', getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: 'https://hub.example', get: () => ({ sessionId: 'rs', shiftId: 'shf', credential: 'capability', expiresAt: 2000 }), now: () => 1000 },
    fetchImpl: (async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), body);
      return new Response(SETTLED_EXECUTED_RESPONSE, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  const response = await c.assessLocalModel!(body);
  assert.equal(JSON.stringify(response), SETTLED_EXECUTED_RESPONSE);
  assert.equal(response.status, 'advisory');
  assert.equal(response.assessment?.advised?.id, body.candidateIds[1]);
});

test('routing credentials never travel to mismatched or non-HTTPS origins, expired sessions or redirected endpoints', async () => {
  let fetched = 0;
  let tokenReads = 0;
  const make = (origin: string, allowedOrigin = 'https://hub.example', expiresAt = 2000) => createHubClient({ origin,
    getToken: async () => { tokenReads++; return 'base-secret'; },
    routingSession: { allowedOrigin, now: () => 1000, get: () => ({ sessionId: 'rs', shiftId: 'shf', credential: 'cap-secret', expiresAt }) },
    fetchImpl: (async () => { fetched++; return new Response('cap-secret', { status: 403 }); }) as typeof fetch,
  });
  for (const origin of ['http://hub.example', 'https://evil.example', 'https://user:pass@hub.example', 'https://hub.example/path']) {
    await assert.rejects(make(origin).readRoutingClaim({ workflow: 'wf', run: 'r' }), /routing/);
  }
  await assert.rejects(make('https://hub.example', undefined, 1000).readRoutingClaim({ workflow: 'wf', run: 'r' }), /routing/);
  assert.equal(fetched, 0);
  assert.equal(tokenReads, 0);
  await assert.rejects(make('https://hub.example').readRoutingClaim({ workflow: 'wf', run: 'r' }), e => e instanceof HubError && e.status === 403 && !e.message.includes('cap-secret'));
  assert.equal(fetched, 1); // no hidden retry or legacy downgrade
  const legacy = client(fakeFetch([], { body: { text: 'legacy' } }));
  await assert.rejects(legacy.readRoutingClaim({ workflow: 'wf', run: 'r' }), /routing/);
});

test('session bootstrap identity refuses redirects and mismatched origins before bearer lookup', async () => {
  let reads = 0;
  let request: RequestInit | undefined;
  const create = (origin: string) => createHubClient({ origin, getToken: async () => { reads++; return 'enrolled'; },
    routingSession: { allowedOrigin: 'https://hub.example', get: () => undefined },
    fetchImpl: (async (_url, init) => { request = init; return Response.json({ text: 'identity' }); }) as typeof fetch,
  });
  await assert.rejects(create('https://other.example').whoami(), /routing/);
  assert.equal(reads, 0);
  await create('https://hub.example').whoami();
  assert.equal(request?.redirect, 'error');
  assert.equal(new Headers(request?.headers).has('X-Owenloop-Routing-Session'), false);
});

test('routed GET failures never reveal transport or response text', async () => {
  const create = (fetchImpl: typeof fetch) => createHubClient({ origin: 'https://hub.example',
    getToken: async () => 'cap-secret',
    routingSession: { allowedOrigin: 'https://hub.example', get: () => undefined }, fetchImpl });
  for (const fetchImpl of [
    (async () => { throw new Error('transport echoed cap-secret'); }) as typeof fetch,
    (async () => new Response('malformed cap-secret', { status: 200 })) as typeof fetch,
    (async () => new Response('error echoed cap-secret', { status: 503 })) as typeof fetch,
  ]) {
    await assert.rejects(create(fetchImpl).whoami(), error =>
      error instanceof Error && !error.message.includes('cap-secret') && error.message.startsWith('routing request'));
  }
});

test('collection transport is versioned and bound to the original routing session', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const c = createHubClient({ origin: 'https://hub.example', getToken: async () => 'enrolled',
    routingSession: { allowedOrigin: 'https://hub.example', get: () => ({
      sessionId: 'rs', shiftId: 'shf', credential: 'session-secret', expiresAt: 2_000,
    }), now: () => 1_000 },
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({ outcome: 'emitted', closed: false });
    }) as typeof fetch,
  });
  const holder = { kind: 'exec' as const, id: 'host:42', shiftId: 'shf' };
  await c.routingCollectionIssue({ workflow: 'wf', run: 'run', sealPath: 'items.sealed',
    emissionId: 'a'.repeat(32), valueDigest: 'b'.repeat(64), holder });
  await c.routingCollectionEmit({ workflow: 'wf', run: 'run', emissionId: 'a'.repeat(32),
    memberPath: 'items[0]', memberVersion: 1, value: { answer: 1 }, proof: 'proof', holder });
  await c.routingCollectionSeal({ workflow: 'wf', run: 'run', sealPath: 'items.sealed',
    sealTargetVersion: 1, sealId: 'c'.repeat(32), proof: 'seal-proof', holder });
  await c.routingCollectionReceipt({ workflow: 'wf', run: 'run', kind: 'seal', id: 'c'.repeat(32),
    sealPath: 'items.sealed', sealTargetVersion: 1, requestDigest: 'd'.repeat(64), holder });
  await c.routingCollectionRevoke({ workflow: 'wf', run: 'run' });
  assert.deepEqual(calls.map(call => call.url.slice('https://hub.example/api/'.length)), [
    'routing_collection_member_issue/v1', 'routing_collection_member_emit/v1',
    'routing_collection_seal/v1', 'routing_collection_receipt/v1',
    'routing_collection_receipt_revoke/v1',
  ]);
  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('authorization'), 'Bearer enrolled');
    assert.equal(headers.get('x-owenloop-routing-session'), 'session-secret');
    assert.equal(call.init.redirect, 'error');
    assert.equal(String(call.init.body).includes('session-secret'), false);
  }
});

test('command-only transport carries opt-in and refuses a legacy or mixed response', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: '', command_lane: 'grant-v1', orders: [], instances: [] } }));
  await c.whatsNext({ serve_capabilities: [], serve_commands: true });
  await c.wake(3, undefined, true);
  assert.equal(captured[0]!.url, 'https://hub.example/api/command_lane/v1/whats_next');
  assert.deepEqual(captured[0]!.body, { serve_capabilities: [], serve_commands: true });
  assert.equal(captured[1]!.url, 'https://hub.example/api/wake?cursor=3&serve_commands=true');
  for (const body of [{ text: '', orders: [] }, { text: '', command_lane: 'grant-v1', orders: [{ worker: 'agent' }] }]) {
    const old = client(fakeFetch([], { body }));
    await assert.rejects(old.whatsNext({ serve_capabilities: [], serve_commands: true }), /command-only grant lane/);
  }
});

for (const verb of ['get', 'conditional', 'bytes'] as const) {
  for (const status of [200, 307, 308]) {
    test(`Hub redirect origin binding: ${verb} HTTP ${status}`, async () => {
      const body = verb === 'get' ? { text: 'own', orgId: 'own' }
	: verb === 'conditional' ? { text: 'accepted', outcome: 'green', closed: true, conditionApplied: 'expected-version-v1' }
	  : { text: 'stored', __file: 'own-TEST-key', hash: createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex'), size: 3, contentType: 'application/octet-stream', filename: 'isolated-TEST-file' };
      let targetRequests = 0;
      let originRequests = 0;
      const target = createServer(async (req, res) => {
	targetRequests++;
	for await (const _chunk of req) { /* Drain isolated fixture bytes only. */ }
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(body));
      });
      await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
      const targetOrigin = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
      const origin = createServer(async (req, res) => {
	originRequests++;
	for await (const _chunk of req) { /* Drain isolated fixture bytes only. */ }
	res.statusCode = status;
	if (status !== 200) res.setHeader('location', `${targetOrigin}/substituted`);
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(body));
      });
      await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
      try {
	const c = createHubClient({ origin: `http://127.0.0.1:${(origin.address() as AddressInfo).port}`, getToken: async () => 'isolated-TEST-token' });
	const call = () => verb === 'get' ? c.whoami()
	  : verb === 'conditional' ? c.submitConditional!({ workflow: 'wf-test', run: 'run-test', path: 'out', value: { private: 'isolated-TEST-value' }, expectedVersion: 3 })
	    : c.putFileArtifact({ workflow: 'wf-test', bytes: new Uint8Array([1, 2, 3]), contentType: 'application/octet-stream', filename: 'isolated-TEST-file' });
	let accepted = false;
	try { await call(); accepted = true; } catch (error) { assert.ok(error instanceof Error); }
	assert.equal(targetRequests, 0, 'another origin must receive no read or private write request');
	assert.equal(originRequests, 1, 'no automatic retry at configured origin');
	assert.equal(accepted, status === 200, 'only configured-origin response may be accepted');
      } finally {
	origin.closeAllConnections(); target.closeAllConnections();
	await Promise.all([new Promise<void>(resolve => origin.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
      }
    });
  }
}

for (const status of [200, 307, 308]) {
  test(`Hub redirect origin binding: real child HTTPS conditional ${status}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-redirect-tls-'));
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    const tls = { key: readFileSync(key), cert: readFileSync(cert) };
    const payload = { workflow: 'wf-test', run: 'run-test', path: 'out', value: { private: 'isolated-TEST-value' }, expectedVersion: 3 };
    const ack = { text: 'accepted', outcome: 'green', closed: true, conditionApplied: 'expected-version-v1' };
    let targetRequests = 0;
    let targetBodyMatched = false;
    let targetAuthorizationPresent = false;
    let originRequests = 0;
    const target = createHttpsServer(tls, async (req, res) => {
      targetRequests++;
      let body = '';
      for await (const chunk of req) body += chunk;
      targetBodyMatched = JSON.stringify(JSON.parse(body)) === JSON.stringify(payload);
      targetAuthorizationPresent = req.headers.authorization !== undefined;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(ack));
    });
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    const origin = createHttpsServer(tls, async (req, res) => {
      originRequests++;
      for await (const _chunk of req) { /* Drain only isolated TEST fixture data. */ }
      res.statusCode = status;
      if (status !== 200) res.setHeader('location', `https://localhost:${(target.address() as AddressInfo).port}/substituted`);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(ack));
    });
    await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
    try {
      const source = `import { createHubClient } from ${JSON.stringify(new URL('../src/hub/client.ts', import.meta.url).href)};
	const c = createHubClient({ origin: ${JSON.stringify(`https://localhost:${(origin.address() as AddressInfo).port}`)}, getToken: async () => 'isolated-TEST-token' });
	try { const r = await c.submitConditional(${JSON.stringify(payload)}); console.log(JSON.stringify({ accepted: r.closed === true && r.conditionApplied === 'expected-version-v1' })); }
	catch { console.log(JSON.stringify({ accepted: false })); }`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(exit, 0, stderr);
      const result = JSON.parse(stdout) as { accepted: boolean };
      t.diagnostic(JSON.stringify({ status, targetRequests, targetBodyMatched, targetAuthorizationPresent, accepted: result.accepted }));
      assert.equal(originRequests, 1);
      assert.equal(targetRequests, 0, 'redirect target must not receive conditional-submit payload');
      assert.equal(result.accepted, status === 200, 'a substituted ACK must not be consumed');
    } finally {
      origin.closeAllConnections(); target.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => origin.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const fault of ['empty', 'array', 'null', 'key', 'empty-key', 'hash', 'size', 'content-type', 'filename', 'missing-filename'] as const) {
  test(`file acknowledgement refuses ${fault} without retry`, async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const good = { __file: 'opaque-TEST-key', hash: createHash('sha256').update(bytes).digest('hex'), size: 3, contentType: 'application/octet-stream', filename: 'own.txt' };
    let body: unknown = good;
    switch (fault) {
      case 'empty': body = {}; break;
      case 'array': body = []; break;
      case 'null': body = null; break;
      case 'key': body = { ...good, __file: true }; break;
      case 'empty-key': body = { ...good, __file: '' }; break;
      case 'hash': body = { ...good, hash: '0'.repeat(64) }; break;
      case 'size': body = { ...good, size: 4 }; break;
      case 'content-type': body = { ...good, contentType: 'text/plain' }; break;
      case 'filename': body = { ...good, filename: 'other.txt' }; break;
      case 'missing-filename': { const { filename: _filename, ...without } = good; body = without; break; }
    }
    let sends = 0;
    const c = client((async () => { sends++; return new Response(JSON.stringify(body)); }) as typeof fetch);
    await assert.rejects(c.putFileArtifact({ workflow: 'wf1', bytes, contentType: good.contentType, filename: good.filename }), /file-artifact-ack-invalid/);
    assert.equal(sends, 1);
  });
}

test('file acknowledgement accepts absent filename and normalized request headers', async () => {
  const bytes = new Uint8Array([1]);
  const c = client((async () => new Response(JSON.stringify({ __file: 'opaque-TEST-key', hash: createHash('sha256').update(bytes).digest('hex'), size: 1, contentType: 'text/plain' }))) as typeof fetch);
  const result = await c.putFileArtifact({ workflow: 'wf1', bytes, contentType: ' text/plain ', filename: ' ' });
  assert.equal(result.__file, 'opaque-TEST-key');
  assert.equal(result.filename, undefined);
});

test('file acknowledgement accepts the filename normalization actually sent by Headers', async () => {
  const bytes = new Uint8Array([1]);
  const c = client((async () => new Response(JSON.stringify({ __file: 'opaque-TEST-key', hash: createHash('sha256').update(bytes).digest('hex'), size: 1, contentType: 'text/plain', filename: 'own.txt' }))) as typeof fetch);
  assert.equal((await c.putFileArtifact({ workflow: 'wf1', bytes, contentType: ' text/plain ', filename: ' own.txt ' })).filename, 'own.txt');
});

test('file acknowledgement uses sent bytes even if the caller changes its buffer while waiting', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3]));
    bytes.fill(9);
    res.end(JSON.stringify({ __file: 'opaque-TEST-key', hash, size: 3, contentType: 'application/octet-stream' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const c = createHubClient({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, getToken: async () => 'own-TEST-token' });
    assert.equal((await c.putFileArtifact({ workflow: 'wf1', bytes, contentType: 'application/octet-stream' })).hash, hash);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
