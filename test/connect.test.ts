/**
 * `owenloop connect` driven in-process through `mainAsync`, modeled on
 * push.test.ts. Hermetic: `mkdtempSync` cwd, fixture `$HOME`, fake keychain,
 * injected `fetch` for `verifyCredential`'s `GET /api/workflows` probe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubBindingPath, readHubBinding, writeHubBinding } from '../src/hub.ts';
import type { Credential, HubBinding } from '../src/hub.ts';
import { mainAsync } from '../src/cli.ts';
import { makeIo, routedFetch } from './hubkit.ts';
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

/** `GET /api/workflows` route that always verifies the credential (200). */
const verifyOk: RouteHandler = () => ({ status: 200, json: { workflows: [] } });

test('connect: happy path — writes hub.json bound to the origin, empty pushed, ok:true', async () => {
  const { fetch } = routedFetch({ 'GET /api/workflows': verifyOk });
  const t = makeIo({ fetch });
  t.store.set(ORIGIN, JSON.stringify(OAUTH_CRED));

  const code = await mainAsync(['connect', '--hub', ORIGIN], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.ok, true);
  assert.equal(result.hub, ORIGIN);
  assert.equal(result.switchedFrom, undefined);

  const binding = readHubBinding(hubBindingPath(t.cwd));
  assert.deepEqual(binding, { version: 1, hub: ORIGIN, pushed: {} });
});

test('connect: re-connecting the SAME origin with non-empty pushed state preserves it, no switchedFrom', async () => {
  const { fetch } = routedFetch({ 'GET /api/workflows': verifyOk });
  const t = makeIo({ fetch });
  t.store.set(ORIGIN, JSON.stringify(OAUTH_CRED));
  const seeded: HubBinding = {
    version: 1,
    hub: ORIGIN,
    pushed: { foo: { localHash: 'H', remoteVersion: 1, remoteHash: 'r', pushedAt: 1 } },
  };
  writeHubBinding(hubBindingPath(t.cwd), seeded);

  const code = await mainAsync(['connect', '--hub', ORIGIN], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.switchedFrom, undefined);
  assert.equal(result.pushStateReset, undefined);

  const binding = readHubBinding(hubBindingPath(t.cwd))!;
  assert.deepEqual(binding.pushed, seeded.pushed, 'pushed state survives a same-origin re-connect');
});

test('connect: switching to a DIFFERENT origin resets pushed state and reports switchedFrom', async () => {
  const { fetch } = routedFetch({ 'GET /api/workflows': verifyOk });
  const t = makeIo({ fetch });
  t.store.set(ORIGIN, JSON.stringify(OAUTH_CRED));
  t.store.set(OTHER_ORIGIN, JSON.stringify(OAUTH_CRED));
  writeHubBinding(hubBindingPath(t.cwd), {
    version: 1,
    hub: ORIGIN,
    pushed: { foo: { localHash: 'H', remoteVersion: 1, remoteHash: 'r', pushedAt: 1 } },
  });

  const code = await mainAsync(['connect', '--hub', OTHER_ORIGIN], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.switchedFrom, ORIGIN);
  assert.equal(result.pushStateReset, true);

  const binding = readHubBinding(hubBindingPath(t.cwd))!;
  assert.equal(binding.hub, OTHER_ORIGIN);
  assert.deepEqual(binding.pushed, {}, 'pushed state reset on an origin switch');
});

test('connect: no stored credential errors, mentions `owenloop login`, writes no hub.json', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/workflows': verifyOk });
  const t = makeIo({ fetch });
  // credential not seeded

  const code = await mainAsync(['connect', '--hub', ORIGIN], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /owenloop login/);
  assert.equal(calls.length, 0, 'never probes the hub without a credential');
  assert.equal(readHubBinding(hubBindingPath(t.cwd)), null, 'no hub.json written');
});
