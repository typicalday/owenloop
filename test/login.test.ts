/**
 * `owenloop login` / `logout` driven in-process through `mainAsync`. The OAuth
 * AS (metadata / DCR / token) is a canned `routedFetch`; the browser step is an
 * injected `openUrl` that drives the REAL loopback server the login flow binds
 * (loopback-only, still hermetic). Credentials land in an injected fake keychain
 * or, with OWENLOOP_NO_KEYCHAIN=1, the 0600 file under a fixture `$HOME`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import { credentialFilePath, readCredentialFile } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { makeIo, OAUTH_METADATA, routedFetch, WHOAMI_BODY } from './hubkit.ts';
import type { RouteHandler } from './hubkit.ts';

const HUB = 'http://127.0.0.1:9';
const ORIGIN = 'http://127.0.0.1:9';

/** Routes for a successful OAuth loopback exchange. */
function loginRoutes(overrides: Record<string, RouteHandler> = {}) {
  return routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/register': () => ({ status: 200, json: { client_id: 'client-abc' } }),
    'POST /mcp/token': () => ({
      status: 200,
      json: { access_token: 'mcpat_access', refresh_token: 'rt_refresh', expires_in: 3600, token_type: 'Bearer' },
    }),
    'GET /api/whoami': () => ({ status: 200, json: WHOAMI_BODY }),
    ...overrides,
  });
}

/** An openUrl that plays the browser+consent: drives the loopback callback with the given code/state override. */
function driveCallback(mutate?: (u: { code: string; state: string }) => Record<string, string>) {
  return (authUrl: string) => {
    const u = new URL(authUrl);
    const redirectUri = u.searchParams.get('redirect_uri')!;
    const state = u.searchParams.get('state')!;
    const params = mutate ? mutate({ code: 'auth-code-1', state }) : { code: 'auth-code-1', state };
    const cb = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) cb.searchParams.set(k, v);
    // Real loopback fetch (not the injected fake) — fire-and-forget after login awaits.
    void fetch(cb.toString()).catch(() => {});
  };
}

test('login: loopback OAuth stores an oauth credential in the keychain', async () => {
  const { fetch, calls } = loginRoutes();
  const t = makeIo({ fetch, onOpenUrl: driveCallback() });

  const code = await mainAsync(['login', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'oauth');
  assert.equal(result.storage, 'keychain');
  assert.equal(result.hub, ORIGIN);
  assert.equal(result.org, WHOAMI_BODY.orgName);
  assert.equal(result.orgId, WHOAMI_BODY.orgId);
  assert.deepEqual(result.identity, WHOAMI_BODY.actor);

  const stored = JSON.parse(t.store.get(ORIGIN)!) as Credential;
  assert.equal(stored.kind, 'oauth');
  assert.equal(stored.accessToken, 'mcpat_access');

  // Verified against GET /api/whoami with the exchanged token before storing.
  const verify = calls.find((c) => c.pathname === '/api/whoami')!;
  assert.equal(verify.authorization, 'Bearer mcpat_access');

  // DCR carried the exact loopback redirect URI, token_endpoint_auth_method:none.
  const dcr = calls.find((c) => c.pathname === '/mcp/register')!;
  const dcrBody = JSON.parse(dcr.body!);
  assert.equal(dcrBody.token_endpoint_auth_method, 'none');
  assert.match(dcrBody.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

  // No token value leaks to stdout/stderr.
  const combined = t.out.join('\n') + t.err.join('\n');
  assert.doesNotMatch(combined, /mcpat_access|rt_refresh/);
});

test('login: OWENLOOP_NO_KEYCHAIN forces the 0600 file fallback', async () => {
  const { fetch } = loginRoutes();
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' }, onOpenUrl: driveCallback() });

  const code = await mainAsync(['login', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(JSON.parse(t.out.join('\n')).storage, 'file');

  const path = credentialFilePath(t.io.env);
  const file = readCredentialFile(path);
  assert.equal((file.hubs[ORIGIN] as Credential).accessToken, 'mcpat_access');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(t.store.size, 0, 'nothing written to the keychain when NO_KEYCHAIN=1');
});

test('login: a state mismatch on the callback aborts, storing nothing', async () => {
  const { fetch } = loginRoutes();
  const t = makeIo({ fetch, onOpenUrl: driveCallback(() => ({ code: 'auth-code-1', state: 'WRONG' })) });

  const code = await mainAsync(['login', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /state mismatch/);
  assert.equal(t.store.size, 0);
});

test('login: a token-exchange failure aborts, storing nothing', async () => {
  const { fetch } = loginRoutes({ 'POST /mcp/token': () => ({ status: 400, json: { error: 'invalid_grant' } }) });
  const t = makeIo({ fetch, onOpenUrl: driveCallback() });

  const code = await mainAsync(['login', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /token exchange failed/);
  assert.equal(t.store.size, 0);
});

test('login: consent denied (error=access_denied) aborts', async () => {
  const { fetch } = loginRoutes();
  const t = makeIo({ fetch, onOpenUrl: driveCallback(() => ({ error: 'access_denied' })) });

  const code = await mainAsync(['login', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /login denied/);
  assert.equal(t.store.size, 0);
});

test('login --with-token: reads an olp_ agent token from stdin, verifies, and stores it', async () => {
  const { fetch, calls } = routedFetch({
    'GET /api/whoami': () => ({ status: 200, json: WHOAMI_BODY }),
  });
  const t = makeIo({ fetch, stdin: '  olp_org_secret\n' });

  const code = await mainAsync(['login', '--hub', HUB, '--with-token'], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.kind, 'agent');
  assert.equal(result.org, WHOAMI_BODY.orgName);
  assert.equal(result.orgId, WHOAMI_BODY.orgId);
  const stored = JSON.parse(t.store.get(ORIGIN)!) as Credential;
  assert.equal(stored.accessToken, 'olp_org_secret');

  // Verified via GET /api/whoami before storing, with the bearer token.
  const verify = calls.find((c) => c.pathname === '/api/whoami')!;
  assert.equal(verify.authorization, 'Bearer olp_org_secret');
  assert.doesNotMatch(t.out.join('\n') + t.err.join('\n'), /olp_org_secret/);
});

test('login --with-token: an unverifiable token (401) is not stored', async () => {
  const { fetch } = routedFetch({
    'GET /api/whoami': () => ({ status: 401, json: { error: 'invalid' } }),
  });
  const t = makeIo({ fetch, stdin: 'olp_bad' });

  const code = await mainAsync(['login', '--hub', HUB, '--with-token'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /revoked or invalid/);
  assert.equal(t.store.size, 0);
});

test('login: a cross-origin token_endpoint from discovery metadata is rejected — no foreign request (SEC-4)', async () => {
  // A discovered token_endpoint on a different origin must never receive the
  // code exchange (which carries the PKCE verifier and mints refresh tokens).
  const { fetch, calls } = loginRoutes({
    'GET /.well-known/oauth-authorization-server': () => ({
      status: 200,
      json: { ...OAUTH_METADATA, token_endpoint: 'https://evil.example/token' },
    }),
  });
  const t = makeIo({ fetch, onOpenUrl: driveCallback() });

  const code = await mainAsync(['login', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /not the hub origin/);
  assert.equal(t.store.size, 0, 'nothing stored when a metadata endpoint is cross-origin');
  assert.ok(!calls.some((c) => c.url.includes('evil.example')), 'no request is ever made to the foreign origin');
});

test('login: an absolute but same-origin token_endpoint from metadata is accepted (SEC-4)', async () => {
  const { fetch, calls } = loginRoutes({
    'GET /.well-known/oauth-authorization-server': () => ({
      status: 200,
      json: { ...OAUTH_METADATA, token_endpoint: `${HUB}/mcp/token` },
    }),
  });
  const t = makeIo({ fetch, onOpenUrl: driveCallback() });

  const code = await mainAsync(['login', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(JSON.parse(t.out.join('\n')).kind, 'oauth');
  assert.ok(calls.some((c) => c.pathname === '/mcp/token'), 'the same-origin absolute token endpoint was used');
});

test('login: OAuth loopback exchange succeeds but whoami 401s — credential is not stored', async () => {
  const { fetch } = loginRoutes({ 'GET /api/whoami': () => ({ status: 401, json: { error: 'invalid' } }) });
  const t = makeIo({ fetch, onOpenUrl: driveCallback() });

  const code = await mainAsync(['login', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /credential rejected/);
  assert.equal(t.store.size, 0, 'never store an unverified oauth token');
});

test('login --with-token: an unrecognized token prefix is rejected before any network call', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch, stdin: 'garbage-token' });

  const code = await mainAsync(['login', '--hub', HUB, '--with-token'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /unrecognized token/);
  assert.equal(calls.length, 0);
});

test('logout: deletes the credential from the keychain', async () => {
  const { fetch } = routedFetch({
    'GET /api/whoami': () => ({ status: 200, json: WHOAMI_BODY }),
  });
  const t = makeIo({ fetch, stdin: 'olp_tok' });
  await mainAsync(['login', '--hub', HUB, '--with-token'], t.io);
  assert.ok(t.store.has(ORIGIN));

  t.out.length = 0; // drop the login output so we parse only logout's JSON
  const code = await mainAsync(['logout', '--hub', HUB], t.io);
  assert.equal(code, 0);
  assert.equal(JSON.parse(t.out.join('\n')).removed, true);
  assert.ok(!t.store.has(ORIGIN), 'credential removed from the keychain');
});

test('logout: also deletes the FILE-side credential (OWENLOOP_NO_KEYCHAIN)', async () => {
  const { fetch } = routedFetch({
    'GET /api/whoami': () => ({ status: 200, json: WHOAMI_BODY }),
  });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' }, stdin: 'olp_tok' });
  await mainAsync(['login', '--hub', HUB, '--with-token'], t.io);
  const path = credentialFilePath(t.io.env);
  assert.ok(readCredentialFile(path).hubs[ORIGIN], 'credential landed in the file store, not the keychain');

  t.out.length = 0;
  const code = await mainAsync(['logout', '--hub', HUB], t.io);
  assert.equal(code, 0);
  assert.equal(JSON.parse(t.out.join('\n')).removed, true);
  assert.equal(readCredentialFile(path).hubs[ORIGIN], undefined, 'credential removed from the file store too');
});

// ---- login timeout must not crash the process (unhandled rejection) ---------

/** Wraps `inner` so the given pathname's response resolves only after `delayMs`. */
function delayedFetch(inner: typeof globalThis.fetch, pathname: string, delayMs: number): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    if (new URL(urlStr).pathname === pathname) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return inner(input, init);
  }) as typeof globalThis.fetch;
}

test('login: a timeout firing mid-metadata-fetch surfaces a clean CliError, never an unhandledRejection', async () => {
  const { fetch } = loginRoutes();
  // The timer (30ms, via the test-only env knob) fires while the metadata GET
  // is still in flight (resolves after ~120ms) — dispatchLogin hasn't reached
  // its `await waitForCallback` yet, so without the no-op .catch this would be
  // an unhandled rejection that crashes the process.
  const slowFetch = delayedFetch(fetch, '/.well-known/oauth-authorization-server', 120);
  const t = makeIo({ fetch: slowFetch, env: { OWENLOOP_LOGIN_TIMEOUT_MS: '30' }, onOpenUrl: driveCallback() });

  let unhandled: unknown;
  const onUnhandled = (reason: unknown): void => {
    unhandled = reason;
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const code = await mainAsync(['login', '--hub', HUB], t.io);
    assert.equal(code, 1);
    assert.match(
      t.err.join('\n'),
      /login timed out after 30ms waiting for the browser callback/,
      'message derives from the actual (overridden) timeout, not a hardcoded "5 minutes"',
    );
    assert.equal(t.store.size, 0, 'nothing stored after a timeout');

    // Give any (incorrectly) unhandled rejection a tick to surface.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(unhandled, undefined, 'the timeout rejection must never surface as an unhandledRejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
