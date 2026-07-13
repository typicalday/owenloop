/**
 * `owenloop push` driven in-process through `mainAsync` with an injected
 * `fetch` mocking `GET /api/workflows` + `POST /api/create_workflow` (via
 * `makeFakeHub`, and the OAuth token endpoint for the refresh path).
 * Hermetic: `mkdtempSync` cwd + defs dir, fixture `$HOME`, fake keychain —
 * no real network, no ambient state, no client-side push ledger — every
 * diff is against the fake hub's own server-truth state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import { hubBindingPath, readHubBinding, writeHubBinding } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { makeFakeHub, makeIo, OAUTH_METADATA, routedFetch } from './hubkit.ts';
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
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
}

test('push: first push sends every def, all land as new on the fake hub, exits 0', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const result = JSON.parse(t.out.join('\n'));
  assert.deepEqual(result.pushed.sort(), ['bar', 'foo']);
  assert.deepEqual(result.noop, []);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 2);

  assert.equal(hub.state.get('foo')?.version, 1);
  assert.equal(hub.state.get('bar')?.version, 1);
});

test('push: a re-push with no changes is a no-op — zero create_workflow calls (local hash diff)', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);
  await mainAsync(['push'], t.io);

  t.out.length = 0;
  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 0);
  const result = JSON.parse(t.out.join('\n'));
  assert.deepEqual(result.unchanged, ['foo']);
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.noop, []);
  assert.match(t.err.join('\n'), /= foo \(unchanged\)/);
});

test('push: a changed def is re-pushed; unchanged siblings are skipped', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);
  await mainAsync(['push'], t.io);

  // Change foo (add a benign title so its hash differs), leave bar alone.
  writeFileSync(join(t.cwd, 'workflows', 'foo.yaml'), `title: hi\n${validDef('foo')}`);
  t.out.length = 0;
  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  assert.deepEqual(result.pushed, ['foo']);
  assert.deepEqual(result.unchanged, ['bar']);
  assert.equal(hub.state.get('foo')?.version, 2);
  assert.equal(hub.state.get('bar')?.version, 1);
});

test('push --force re-sends even unchanged defs; the server reports it back as a noop, not pushed', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);
  await mainAsync(['push'], t.io);

  const { fetch: secondFetch, calls } = routedFetch(hub.routes);
  t.io.fetch = secondFetch;
  t.out.length = 0;
  const code = await mainAsync(['push', '--force'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  // Content is byte-identical, so the server's own idempotent create_workflow
  // reports unchanged:true — --force still SENDS the request (one round-trip)
  // but the CLI reports it as a noop, not a pushed version bump.
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.noop, ['foo']);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 1);
  assert.equal(hub.state.get('foo')?.version, 1, 'no version bump — server-side no-op');
});

test('push --force on a genuinely different def still version-forwards and reports pushed', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);
  await mainAsync(['push'], t.io);

  writeFileSync(join(t.cwd, 'workflows', 'foo.yaml'), `title: hi\n${validDef('foo')}`);
  t.out.length = 0;
  const code = await mainAsync(['push', '--force'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.join('\n')).pushed, ['foo']);
  assert.equal(hub.state.get('foo')?.version, 2);
});

test('push --dry-run sends nothing — reports new/changed/unchanged from server truth', async () => {
  const hub = makeFakeHub([{ name: 'bar', yaml: validDef('bar') }]);
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);

  const code = await mainAsync(['push', '--dry-run'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.new, ['foo']);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.unchanged, ['bar']);
  assert.deepEqual(result.wouldPush, ['foo']);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 0, 'dry-run never posts');
  assert.equal(calls.filter((c) => c.pathname === '/api/workflows').length, 1, 'still reads server truth for the diff');
});

test('push <name>: positional narrowing pushes only the named def; unknown name errors', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);

  const code = await mainAsync(['push', 'foo'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.join('\n')).pushed, ['foo']);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 1);
  assert.equal(hub.state.has('bar'), false, 'bar never touched');

  t.out.length = 0;
  const bad = await mainAsync(['push', 'nope'], t.io);
  assert.equal(bad, 1);
  assert.match(t.err.join('\n'), /unknown workflow definition 'nope'/);
});

test('push: a def that fails validation aborts the whole push — nothing sent, not even the server diff fetch', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  const broken = ['name: broken', 'inputs:', '  - name: seed', 'steps:', '  - name: w', '    consumes: [ghost]', '    produces: [out]', '    terminal: true', ''].join('\n');
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'broken.yaml': broken });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /invalid workflow 'broken'/);
  assert.equal(calls.length, 0, 'nothing sent when validation fails — not even GET /api/workflows');
});

test('push: an include-using def is refused as not hub-pushable', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  const parent = ['name: parent', 'inputs:', '  - name: seed', '    seedOwed: true', 'steps:', '  - include: child', '    as: c', '    inputs:', '      seed: seed', ''].join('\n');
  writeDefs(t.cwd, { 'parent.yaml': parent });
  bind(t);

  const code = await mainAsync(['push', 'parent'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /uses include:, not hub-pushable/);
  assert.equal(calls.length, 0);
});

test('push: a def using bodyFile: is refused as not hub-pushable', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  const withBodyFile = ['name: withfile', 'steps:', '  - name: a', '    bodyFile: prompt.md', '    produces: [y]', ''].join('\n');
  writeDefs(t.cwd, { 'withfile.yaml': withBodyFile, 'prompt.md': 'hello' });
  bind(t);

  const code = await mainAsync(['push', 'withfile'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /uses bodyFile:, not hub-pushable/);
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
  const { fetch } = routedFetch({ 'GET /api/workflows': () => ({ status: 200, json: { workflows: [] } }), 'POST /api/create_workflow': create });
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
});

test('push: a 401 on an oauth credential refreshes once and retries', async () => {
  const create: RouteHandler = () => ({ status: 200, json: { ok: true, name: 'x', version: 1, hash: 'r' } });
  // create_workflow 401s for the old token, 200s for the refreshed one.
  const attempts: string[] = [];
  const routes: Record<string, RouteHandler> = {
    'GET /api/workflows': () => ({ status: 200, json: { workflows: [] } }),
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 200, json: { access_token: 'mcpat_new', expires_in: 3600 } }),
    // First call uses old token → 401; after refresh, second call → 200.
    'POST /api/create_workflow': (req) => (attempts.push('x') === 1 ? { status: 401, json: { error: 'expired' } } : create(req)),
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
  const { fetch } = routedFetch({
    'GET /api/workflows': () => ({ status: 200, json: { workflows: [] } }),
    'POST /api/create_workflow': () => ({ status: 401, json: { error: 'revoked' } }),
  });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t, { kind: 'agent', accessToken: 'olp_x' });

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /revoked or invalid/);
});

test('push: a 401 on the GET /api/workflows diff fetch is a hard error before any create_workflow call', async () => {
  const { fetch, calls } = routedFetch({
    'GET /api/workflows': () => ({ status: 401, json: { error: 'invalid' } }),
    'POST /api/create_workflow': () => ({ status: 200, json: { ok: true, name: 'foo', version: 1, hash: 'r' } }),
  });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t, { kind: 'agent', accessToken: 'olp_x' });

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /revoked or invalid/);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 0);
});

test('push: a malformed GET /api/workflows response is a clean CliError', async () => {
  const { fetch } = routedFetch({
    'GET /api/workflows': () => ({ status: 200, json: { notWorkflows: [] } }),
  });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /expected a `workflows` array/);
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
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
  // credential not seeded
  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /no stored credential/);
});

test('push --hub disagreeing with the project binding errors, names both origins, sends nothing', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t); // binds to ORIGIN = http://127.0.0.1:9

  const code = await mainAsync(['push', '--hub', 'http://127.0.0.1:10'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /bound to http:\/\/127\.0\.0\.1:9/);
  assert.match(t.err.join('\n'), /http:\/\/127\.0\.0\.1:10/);
  assert.match(t.err.join('\n'), /owenloop connect/);
  assert.equal(calls.length, 0, 'zero network calls on a binding mismatch');
});

// ---- boolean flag parsing (BOOLEAN_FLAGS) ------------------------------------

test('push --force foo does not swallow the positional — only foo is force-sent, bar is untouched', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);
  await mainAsync(['push'], t.io); // both already pushed once

  const { fetch: secondFetch, calls } = routedFetch(hub.routes);
  t.io.fetch = secondFetch;
  t.out.length = 0;
  const code = await mainAsync(['push', '--force', 'foo'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  // "foo" stayed a positional (narrowing the push to just foo) instead of being
  // swallowed as --force's value — the misparse this regresses against would
  // have force-sent EVERY def (both foo and bar) with two create_workflow calls.
  assert.deepEqual(result.unchanged, [], 'bar was excluded from selection entirely, not merely reported unchanged');
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 1, 'bar was NOT force-sent');
  // foo's content is byte-identical to what's already on the hub, so --force
  // still sends it but the server reports it back as a noop, not a pushed bump.
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.noop, ['foo']);
  assert.equal(hub.state.get('bar')?.version, 1, 'bar was never re-sent, still at its original version');
});

// ---- hash portability across checkouts (server-truth diff has no client state) --

test('push: identical content pushed from a second, differently-pathed checkout is all unchanged — zero network calls', async () => {
  const hub = makeFakeHub();
  const first = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(first.cwd, { 'foo.yaml': validDef('foo') });
  bind(first);
  const firstCode = await mainAsync(['push'], first.io);
  assert.equal(firstCode, 0, first.err.join('\n'));

  // A fresh checkout at a different absolute path, with the same def content
  // and the same (portable) hub.json copied verbatim — the diff is entirely
  // server-side, so a different checkout path is irrelevant.
  const second = makeIo();
  writeDefs(second.cwd, { 'foo.yaml': validDef('foo') });
  second.store.set(ORIGIN, JSON.stringify(OAUTH_CRED));
  writeHubBinding(hubBindingPath(second.cwd), { version: 1, hub: ORIGIN });
  assert.notEqual(first.cwd, second.cwd, 'sanity: genuinely different absolute paths');

  const { fetch: secondFetch, calls } = routedFetch(hub.routes);
  second.io.fetch = secondFetch;
  const code = await mainAsync(['push'], second.io);
  assert.equal(code, 0, second.err.join('\n'));
  const result = JSON.parse(second.out.join('\n'));
  assert.deepEqual(result.unchanged, ['foo']);
  assert.deepEqual(result.pushed, []);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 0, 'zero create_workflow calls');
});
