/**
 * `owenloop connect` driven in-process through `mainAsync`, modeled on
 * push.test.ts. Hermetic: `mkdtempSync` cwd, fixture `$HOME`, fake keychain,
 * injected `fetch` for `verifyCredential`'s `GET /api/whoami` probe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hubBindingPath, readHubBinding, writeHubBinding } from '../src/hub.ts';
import type { Credential, HubBinding } from '../src/hub.ts';
import { mainAsync } from '../src/cli.ts';
import { makeIo, routedFetch, WHOAMI_BODY } from './hubkit.ts';
import type { RouteHandler } from './hubkit.ts';

const ORIGIN = 'http://127.0.0.1:9';
const OTHER_ORIGIN = 'http://127.0.0.1:10';

const OAUTH_CRED: Credential = {
  kind: 'oauth',
  accessToken: 'mcpat_a',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  clientId: 'c',
};

/** `GET /api/whoami` route that always verifies the credential (200). */
const verifyOk: RouteHandler = () => ({ status: 200, json: WHOAMI_BODY });

test('connect: happy path — writes hub.json bound to the origin, reports org identity, ok:true', async () => {
  const { fetch } = routedFetch({ 'GET /api/whoami': verifyOk });
  const t = makeIo({ fetch });
  t.store.set(ORIGIN, JSON.stringify(OAUTH_CRED));

  const code = await mainAsync(['connect', '--hub', ORIGIN], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.ok, true);
  assert.equal(result.hub, ORIGIN);
  assert.equal(result.switchedFrom, undefined);
  assert.equal(result.org, WHOAMI_BODY.orgName);
  assert.equal(result.orgId, WHOAMI_BODY.orgId);
  assert.deepEqual(result.identity, WHOAMI_BODY.actor);

  const binding = readHubBinding(hubBindingPath(t.cwd));
  assert.deepEqual(binding, { version: 1, hub: ORIGIN });
});

test('connect: re-connecting the SAME origin reports no switchedFrom', async () => {
  const { fetch } = routedFetch({ 'GET /api/whoami': verifyOk });
  const t = makeIo({ fetch });
  t.store.set(ORIGIN, JSON.stringify(OAUTH_CRED));
  const seeded: HubBinding = { version: 1, hub: ORIGIN };
  writeHubBinding(hubBindingPath(t.cwd), seeded);

  const code = await mainAsync(['connect', '--hub', ORIGIN], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.switchedFrom, undefined);

  const binding = readHubBinding(hubBindingPath(t.cwd))!;
  assert.deepEqual(binding, seeded);
});

test('connect: switching to a DIFFERENT origin reports switchedFrom and rebinds', async () => {
  const { fetch } = routedFetch({ 'GET /api/whoami': verifyOk });
  const t = makeIo({ fetch });
  t.store.set(ORIGIN, JSON.stringify(OAUTH_CRED));
  t.store.set(OTHER_ORIGIN, JSON.stringify(OAUTH_CRED));
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });

  const code = await mainAsync(['connect', '--hub', OTHER_ORIGIN], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.switchedFrom, ORIGIN);

  const binding = readHubBinding(hubBindingPath(t.cwd))!;
  assert.equal(binding.hub, OTHER_ORIGIN);
});

test('connect: no stored credential errors, mentions `owenloop login`, writes no hub.json', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/whoami': verifyOk });
  const t = makeIo({ fetch });
  // credential not seeded

  const code = await mainAsync(['connect', '--hub', ORIGIN], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /owenloop login/);
  assert.equal(calls.length, 0, 'never probes the hub without a credential');
  assert.equal(readHubBinding(hubBindingPath(t.cwd)), null, 'no hub.json written');
});

test('connect: a legacy hub.json with a leftover `pushed` ledger key still parses and connect rewrites it to the slim {version, hub} shape', async () => {
  const { fetch } = routedFetch({ 'GET /api/whoami': verifyOk });
  const t = makeIo({ fetch });
  t.store.set(ORIGIN, JSON.stringify(OAUTH_CRED));
  // Simulate a hub.json written by a pre-server-diff CLI: still has the old
  // client-side push ledger under `pushed`, which the current binding type
  // no longer has a field for.
  writeHubBinding(hubBindingPath(t.cwd), {
    version: 1,
    hub: ORIGIN,
    // @ts-expect-error -- simulating a pre-server-diff CLI's binding file
    pushed: { alpha: { localHash: 'h1', remoteVersion: 3, remoteHash: 'rh1', pushedAt: 10 } },
  });

  const code = await mainAsync(['connect', '--hub', ORIGIN], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.ok, true);
  assert.equal(result.switchedFrom, undefined, 'same origin — not a rebind, just a rewrite');

  const raw = readFileSync(hubBindingPath(t.cwd), 'utf8');
  assert.deepEqual(
    JSON.parse(raw),
    { version: 1, hub: ORIGIN },
    'connect rewrites the file to the slim shape, dropping the legacy pushed key',
  );
  assert.deepEqual(readHubBinding(hubBindingPath(t.cwd)), { version: 1, hub: ORIGIN });
});

test('connect: a 401 from whoami errors cleanly and writes no hub.json', async () => {
  const { fetch } = routedFetch({ 'GET /api/whoami': () => ({ status: 401, json: { error: 'invalid' } }) });
  const t = makeIo({ fetch });
  t.store.set(ORIGIN, JSON.stringify(OAUTH_CRED));

  const code = await mainAsync(['connect', '--hub', ORIGIN], t.io);
  assert.equal(code, 1);
  assert.equal(readHubBinding(hubBindingPath(t.cwd)), null, 'no hub.json written on a failed verify');
});
