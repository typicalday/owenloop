import { createServer } from 'node:http';
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


test('command-only transport carries opt-in and refuses a legacy or mixed response', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: '', command_lane: 'grant-v1', orders: [], instances: [] } }));
  await c.whatsNext({ serve_capabilities: [], serve_commands: true });
  await c.wake(3, undefined, true);
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
	  : { text: 'stored', __file: true, hash: 'test-hash', size: 3, contentType: 'application/octet-stream' };
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
