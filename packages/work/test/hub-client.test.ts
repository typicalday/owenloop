import { createServer } from 'node:http';
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
  response: { status?: number; body: unknown },
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
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function client(fetchImpl: typeof fetch, getToken = async () => 'tok-123') {
  return createHubClient({ origin: 'https://hub.example/', getToken, fetchImpl });
}

test('whatsNext POSTs to /api/whats_next with bearer header and JSON body', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'ok', orders: [] } }));
  const res = await c.whatsNext({ workflow: 'wf1', serve_pools: ['a'] });

  const req = captured[0]!;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://hub.example/api/whats_next');
  assert.equal(req.headers['authorization'], 'Bearer tok-123');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.deepEqual(req.body, { workflow: 'wf1', serve_pools: ['a'] });
  assert.equal(res.text, 'ok');
  assert.deepEqual(res.orders, []);
});

test('whatsNext defaults to an empty body when called with no args', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'ok' } }));
  await c.whatsNext();
  assert.deepEqual(captured[0]!.body, {});
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

  assert.deepEqual(captured[0]!.body, { session: 's1' });
  assert.deepEqual(captured[1]!.body, { workflow: 'wf1', run: 'r1' });
});

test('submit sends its full body including done', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'ok' } }));
  await c.submit({ workflow: 'wf1', run: 'r1', path: 'pr', value: { n: 1 }, done: true });
  assert.deepEqual(captured[0]!.body, { workflow: 'wf1', run: 'r1', path: 'pr', value: { n: 1 }, done: true });
});

test('whoami GETs /api/whoami', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'ok', orgId: 'o1', orgName: 'Org', actor: { id: 'a', kind: 'agent', role: 'agent', scopes: [] }, tokenStatus: 'active', authMethod: 'token' } }));
  const res = await c.whoami();
  assert.equal(captured[0]!.method, 'GET');
  assert.equal(captured[0]!.url, 'https://hub.example/api/whoami');
  assert.equal(res.orgId, 'o1');
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

test('presencePing POSTs /api/presence_ping with name and serve_pools', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'presence recorded for box', ok: true, name: 'box', lastSeen: 123 } }));
  const res = await c.presencePing({ name: 'box', serve_pools: ['a', 'b'] });

  assert.equal(captured[0]!.method, 'POST');
  assert.equal(captured[0]!.url, 'https://hub.example/api/presence_ping');
  assert.deepEqual(captured[0]!.body, { name: 'box', serve_pools: ['a', 'b'] });
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
    const res = (await c.whatsNext({ workflow: 'wf1' })) as { text: string; echoAuth: string; echoBody: unknown };
    assert.equal(res.text, 'live');
    assert.equal(res.echoAuth, 'Bearer live-tok');
    assert.deepEqual(res.echoBody, { workflow: 'wf1' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('presencePing forwards attended_at using the exact snake_case wire field', async () => {
  const captured: Captured[] = [];
  const c = client(fakeFetch(captured, { body: { text: 'presence recorded', ok: true, name: 'box', lastSeen: 123 } }));
  await c.presencePing({ name: 'box', serve_pools: [], attended_at: 456789 });
  assert.deepEqual(captured[0]!.body, { name: 'box', serve_pools: [], attended_at: 456789 });
  assert.equal((captured[0]!.body as Record<string, unknown>)['attendedAt'], undefined);
});
