/**
 * `owenloop push` driven in-process through `mainAsync` with an injected
 * `fetch` mocking `POST /api/create_workflow` (and the OAuth token endpoint for
 * the refresh path). Hermetic: `mkdtempSync` cwd + defs dir, fixture `$HOME`,
 * fake keychain — no real network, no ambient state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import { hubBindingPath, readHubBinding, writeHubBinding } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { makeIo, OAUTH_METADATA, routedFetch } from './hubkit.ts';
import type { HubIo, RouteHandler } from './hubkit.ts';

const ORIGIN = 'http://127.0.0.1:9';

function validDef(name: string): string {
  return [
    `name: ${name}`,
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: worker',
    '    consumes: [seed]',
    '    produces: [out]',
    '    terminal: true',
    '    maxSchemaFailures: 0',
    '',
  ].join('\n');
}

function writeDefs(cwd: string, defs: Record<string, string>): void {
  const dir = join(cwd, 'workflows');
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(defs)) writeFileSync(join(dir, file), body);
}

const OAUTH_CRED: Credential = {
  kind: 'oauth',
  accessToken: 'mcpat_a',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  clientId: 'c',
};

/** Seed a bound project + stored credential into a HubIo. */
function bind(t: HubIo, cred: Credential = OAUTH_CRED): void {
  t.store.set(ORIGIN, JSON.stringify(cred));
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN, pushed: {} });
}

/** A create_workflow route that always succeeds, echoing the requested name. */
const createOk: RouteHandler = ({ body }) => {
  void body;
  return { status: 200, json: { ok: true, name: 'x', version: 1, hash: 'remote-hash' } };
};

test('push: first push sends every def, updates hub.json, exits 0', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_workflow': createOk });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const result = JSON.parse(t.out.join('\n'));
  assert.deepEqual(result.pushed.sort(), ['bar', 'foo']);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 2);

  const binding = readHubBinding(hubBindingPath(t.cwd))!;
  assert.ok(binding.pushed.foo && binding.pushed.bar, 'both recorded in hub.json');
  assert.equal(binding.pushed.foo!.remoteVersion, 1);
});

test('push: a re-push with no changes is a no-op — zero create_workflow calls', async () => {
  const t = makeIo({ fetch: routedFetch({ 'POST /api/create_workflow': createOk }).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);
  await mainAsync(['push'], t.io);

  const second = routedFetch({ 'POST /api/create_workflow': createOk });
  t.io.fetch = second.fetch;
  t.out.length = 0;
  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 0);
  const result = JSON.parse(t.out.join('\n'));
  assert.deepEqual(result.unchanged, ['foo']);
  assert.deepEqual(result.pushed, []);
  assert.equal(second.calls.filter((c) => c.pathname === '/api/create_workflow').length, 0, 'nothing sent');
  assert.match(t.err.join('\n'), /= foo \(unchanged\)/);
});

test('push: a changed def is re-pushed; unchanged siblings are skipped', async () => {
  const t = makeIo({ fetch: routedFetch({ 'POST /api/create_workflow': createOk }).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);
  await mainAsync(['push'], t.io);

  // Change foo (add a benign title so its hashDef differs), leave bar alone.
  writeFileSync(join(t.cwd, 'workflows', 'foo.yaml'), `title: hi\n${validDef('foo')}`);
  const second = routedFetch({ 'POST /api/create_workflow': createOk });
  t.io.fetch = second.fetch;
  t.out.length = 0;
  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  assert.deepEqual(result.pushed, ['foo']);
  assert.deepEqual(result.unchanged, ['bar']);
  assert.equal(second.calls.filter((c) => c.pathname === '/api/create_workflow').length, 1);
});

test('push --force re-pushes even unchanged defs', async () => {
  const t = makeIo({ fetch: routedFetch({ 'POST /api/create_workflow': createOk }).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);
  await mainAsync(['push'], t.io);

  const second = routedFetch({ 'POST /api/create_workflow': createOk });
  t.io.fetch = second.fetch;
  t.out.length = 0;
  const code = await mainAsync(['push', '--force'], t.io);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(t.out.join('\n')).pushed, ['foo']);
  assert.equal(second.calls.filter((c) => c.pathname === '/api/create_workflow').length, 1);
});

test('push --dry-run sends nothing and writes no state', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_workflow': createOk });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);

  const code = await mainAsync(['push', '--dry-run'], t.io);
  assert.equal(code, 0);
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.wouldPush, ['foo']);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 0);
  assert.deepEqual(readHubBinding(hubBindingPath(t.cwd))!.pushed, {}, 'no state written on dry-run');
});

test('push <name>: positional narrowing pushes only the named def; unknown name errors', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_workflow': createOk });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);

  const code = await mainAsync(['push', 'foo'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.join('\n')).pushed, ['foo']);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 1);

  t.out.length = 0;
  const bad = await mainAsync(['push', 'nope'], t.io);
  assert.equal(bad, 1);
  assert.match(t.err.join('\n'), /unknown workflow definition 'nope'/);
});

test('push: a def that fails validation aborts the whole push — nothing sent', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_workflow': createOk });
  const t = makeIo({ fetch });
  const broken = ['name: broken', 'inputs:', '  - name: seed', 'steps:', '  - name: w', '    consumes: [ghost]', '    produces: [out]', '    terminal: true', ''].join('\n');
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'broken.yaml': broken });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /refusing to push/);
  assert.equal(calls.length, 0, 'nothing sent when validation fails');
});

test('push: an include-using def is refused as not hub-pushable', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_workflow': createOk });
  const t = makeIo({ fetch });
  const parent = ['name: parent', 'inputs:', '  - name: seed', '    seedOwed: true', 'steps:', '  - include: child', '    as: c', '    inputs:', '      seed: seed', ''].join('\n');
  writeDefs(t.cwd, { 'parent.yaml': parent });
  bind(t);

  const code = await mainAsync(['push', 'parent'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /uses include:, not hub-pushable/);
  assert.equal(calls.length, 0);
});

test('push: a server {ok:false} mid-batch records successes, still exits 1', async () => {
  let n = 0;
  const create: RouteHandler = () => {
    n += 1;
    return n === 1
      ? { status: 200, json: { ok: true, name: 'x', version: 1, hash: 'r' } }
      : { status: 200, json: { ok: false, error: 'engine version 2 unsupported' } };
  };
  const { fetch } = routedFetch({ 'POST /api/create_workflow': create });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'aaa.yaml': validDef('aaa'), 'zzz.yaml': validDef('zzz') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.ok, false);
  assert.equal(result.pushed.length, 1);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /engine version 2 unsupported/);
  // The successful one is recorded in hub.json; the failed one is not.
  const binding = readHubBinding(hubBindingPath(t.cwd))!;
  assert.equal(Object.keys(binding.pushed).length, 1);
});

test('push: a 401 on an oauth credential refreshes once and retries', async () => {
  const create: RouteHandler = ({ url }) => {
    void url;
    return { status: 200, json: { ok: true, name: 'x', version: 1, hash: 'r' } };
  };
  // create_workflow 401s for the old token, 200s for the refreshed one.
  const attempts: string[] = [];
  const routes: Record<string, RouteHandler> = {
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 200, json: { access_token: 'mcpat_new', expires_in: 3600 } }),
    // First call uses old token → 401; after refresh, second call → 200.
    'POST /api/create_workflow': (req) =>
      attempts.push('x') === 1 ? { status: 401, json: { error: 'expired' } } : create(req),
  };
  const { fetch, calls: recorded } = routedFetch(routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t, { kind: 'oauth', accessToken: 'mcpat_old', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, clientId: 'c' });

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.join('\n')).pushed, ['foo']);
  assert.ok(recorded.some((c) => c.pathname === '/mcp/token'), 'refresh happened');
  // The stored credential was updated to the refreshed access token.
  assert.equal((JSON.parse(t.store.get(ORIGIN)!) as Credential).accessToken, 'mcpat_new');
});

test('push: a 401 on an agent token is a hard error (no refresh path)', async () => {
  const { fetch } = routedFetch({ 'POST /api/create_workflow': () => ({ status: 401, json: { error: 'revoked' } }) });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t, { kind: 'agent', accessToken: 'olp_x' });

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /revoked or invalid/);
});

test('push: missing hub.json errors with a connect hint', async () => {
  const { fetch } = routedFetch({});
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  // no bind()
  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /not bound to a hub/);
});

test('push: bound but no stored credential errors with a login hint', async () => {
  const { fetch } = routedFetch({});
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN, pushed: {} });
  // credential not seeded
  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /no stored credential/);
});
