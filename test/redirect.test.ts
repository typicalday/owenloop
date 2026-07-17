/**
 * Proves `hubFetch`'s `redirect: 'error'` policy (SEC-4 redirect gap): a
 * validated hub endpoint that answers a 3xx must FAIL loudly, and the POST body
 * (refresh token, auth code + PKCE verifier, workflow YAML) must NEVER reach the
 * redirect target. `resolveEndpoint` only validates the INITIAL URL's origin;
 * without this, a 307/308 would re-send the body cross-origin (undici strips the
 * Authorization header on a cross-origin redirect but RESENDS the body).
 *
 * These are BEHAVIORAL tests: they use a real `node:http` loopback server
 * (`realHttpServer`) and the platform's real global fetch (opts.fetch unset), so
 * they exercise undici's actual redirect handling — the in-memory `routedFetch`
 * fake cannot prove redirect behavior because it ignores `init.redirect`. Each
 * path iterates every redirect status; the foreign server's `calls` array is the
 * leak detector — ANY entry is a failure. A final flag-coverage test pins that
 * EVERY hub/auth fetch (including the endpoints without a behavioral matrix) sets
 * `redirect: 'error'`, via `routedFetch`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import { credentialFilePath, hubBindingPath, readCredentialFile, writeHubBinding } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { makeIo, OAUTH_METADATA, realHttpServer, routedFetch, WHOAMI_BODY } from './hubkit.ts';
import type { HubIo, RouteHandler } from './hubkit.ts';

const REDIRECT_STATUSES = [301, 302, 303, 307, 308] as const;

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

/** Bind the cwd + a stored credential to a REAL hub origin (inline of push.test's `bind`). */
function bindReal(t: HubIo, origin: string, cred: Credential): void {
  t.store.set(origin, JSON.stringify(cred));
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: origin });
}

/** A redirect RouteResult pointing at a foreign origin's path. */
function redirectTo(status: number, location: string): RouteHandler {
  return () => ({ status, headers: { Location: location } });
}

// ---- refresh path (token refresh re-sends the refresh-token form body) -------

test('refresh: a redirect on POST /mcp/token fails loudly; the refresh-token body never leaves the hub origin', async () => {
  for (const status of REDIRECT_STATUSES) {
    const foreign = await realHttpServer({});
    const hub = await realHttpServer({
      'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
      'POST /mcp/token': redirectTo(status, `${foreign.origin}/mcp/token`),
    });
    try {
      // opts.fetch unset → hubFetch uses the REAL global fetch (real undici).
      const t = makeIo({});
      writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
      // An already-expired oauth credential forces a refresh up front.
      const expired: Credential = {
        kind: 'oauth',
        accessToken: 'mcpat_old',
        refreshToken: 'rt-secret',
        expiresAt: Date.now() - 1000,
        clientId: 'c',
      };
      bindReal(t, hub.origin, expired);

      const code = await mainAsync(['push'], t.io);
      assert.equal(code, 1, `status ${status}: expected non-zero exit`);
      // The specific hubFetch redirect wording, not the softer "refresh failed".
      assert.match(t.err.join('\n'), /refusing to follow it/, `status ${status}: redirect wording`);
      assert.equal(foreign.calls.length, 0, `status ${status}: refresh-token body leaked to foreign origin`);
      // The stored credential is untouched (refresh threw before persisting).
      assert.equal(t.store.get(hub.origin), JSON.stringify(expired), `status ${status}: credential mutated`);
    } finally {
      await hub.close();
      await foreign.close();
    }
  }
});

// ---- code-exchange path (auth code + PKCE verifier) --------------------------

/** An openUrl that drives the CLI's REAL loopback callback (copied from login.test.ts). */
function driveCallback(mutate?: (u: { code: string; state: string }) => Record<string, string>) {
  return (authUrl: string) => {
    const u = new URL(authUrl);
    const redirectUri = u.searchParams.get('redirect_uri')!;
    const state = u.searchParams.get('state')!;
    const params = mutate ? mutate({ code: 'auth-code-1', state }) : { code: 'auth-code-1', state };
    const cb = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) cb.searchParams.set(k, v);
    void fetch(cb.toString()).catch(() => {});
  };
}

test('login: a redirect on POST /mcp/token fails loudly; the auth code + PKCE verifier never leave, nothing is stored', async () => {
  for (const status of REDIRECT_STATUSES) {
    const foreign = await realHttpServer({});
    const hub = await realHttpServer({
      'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
      'POST /mcp/register': () => ({ status: 200, json: { client_id: 'client-abc' } }),
      'POST /mcp/token': redirectTo(status, `${foreign.origin}/mcp/token`),
    });
    try {
      const t = makeIo({ onOpenUrl: driveCallback() });

      const code = await mainAsync(['login', '--hub', hub.origin], t.io);
      assert.equal(code, 1, `status ${status}: expected non-zero exit`);
      assert.equal(foreign.calls.length, 0, `status ${status}: auth code + PKCE verifier leaked to foreign origin`);
      assert.equal(t.store.size, 0, `status ${status}: credential stored in keychain`);
      const file = readCredentialFile(credentialFilePath(t.io.env));
      assert.deepEqual(file.hubs, {}, `status ${status}: credential written to disk`);
    } finally {
      await hub.close();
      await foreign.close();
    }
  }
});

// ---- push path (raw workflow YAML) -------------------------------------------

test('push: a redirect on POST /api/create_workflow fails loudly; the workflow YAML is never re-sent', async () => {
  for (const status of REDIRECT_STATUSES) {
    const foreign = await realHttpServer({});
    const hub = await realHttpServer({
      'GET /api/workflows': () => ({ status: 200, json: { text: '', workflows: [] } }),
      'POST /api/create_workflow': redirectTo(status, `${foreign.origin}/api/create_workflow`),
    });
    try {
      const t = makeIo({});
      writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
      bindReal(t, hub.origin, {
        kind: 'oauth',
        accessToken: 'mcpat_fresh',
        refreshToken: 'rt',
        expiresAt: Date.now() + 3_600_000,
        clientId: 'c',
      });

      const code = await mainAsync(['push'], t.io);
      assert.equal(code, 1, `status ${status}: expected non-zero exit`);
      const result = JSON.parse(t.out.join('\n'));
      assert.equal(result.ok, false, `status ${status}: push reported ok`);
      assert.match(result.failed[0].error, /refusing to follow it/, `status ${status}: redirect wording`);
      assert.equal(foreign.calls.length, 0, `status ${status}: workflow YAML leaked to foreign origin`);
    } finally {
      await hub.close();
      await foreign.close();
    }
  }
});

// ---- flag coverage (every hub/auth fetch sets redirect: 'error') -------------

test('every hub/auth fetch on the login happy path passes redirect: "error" (discovery, DCR, token, whoami)', async () => {
  // Run one full happy-path flow through routedFetch — the fake records
  // init.redirect. login touches discovery + DCR + token + whoami, the endpoints
  // that don't get a behavioral matrix above. With hubFetch the single choke
  // point, this pins "EVERY hub/auth fetch" and catches a later bypass.
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/register': () => ({ status: 200, json: { client_id: 'client-abc' } }),
    'POST /mcp/token': () => ({
      status: 200,
      json: { access_token: 'mcpat_access', refresh_token: 'rt_refresh', expires_in: 3600, token_type: 'Bearer' },
    }),
    'GET /api/whoami': () => ({ status: 200, json: WHOAMI_BODY }),
  });
  const t = makeIo({ fetch, onOpenUrl: driveCallback() });

  const code = await mainAsync(['login', '--hub', 'http://127.0.0.1:9'], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.ok(calls.length >= 4, `expected discovery+DCR+token+whoami, saw ${calls.length}`);
  for (const c of calls) {
    assert.equal(c.redirect, 'error', `${c.method} ${c.pathname} did not set redirect: 'error'`);
  }
});
