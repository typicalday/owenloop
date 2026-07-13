/**
 * Pure hub helpers (src/hub.ts): origin normalization, PKCE, credential + hub
 * binding round-trips with strict file-mode assertions, and push-diff logic.
 * Fully hermetic — every path is under an `mkdtempSync` fixture; nothing reads
 * the developer's real `~/.config` or keychain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asCreateWorkflowOk,
  asWhoami,
  base64url,
  computeServerDiff,
  configDir,
  createWorkflowError,
  credentialFilePath,
  hubBindingPath,
  normalizeOrigin,
  parseWorkflowList,
  pkcePair,
  randomState,
  readCredentialFile,
  readHubBinding,
  writeCredentialFile,
  writeHubBinding,
} from '../src/hub.ts';
import type { Credential, HubBinding, WorkflowSummary } from '../src/hub.ts';

// ---- origin normalization ----------------------------------------------------

test('normalizeOrigin strips path/query/trailing slash and keeps scheme+host+port', () => {
  assert.equal(normalizeOrigin('https://api.owenloop.com/'), 'https://api.owenloop.com');
  assert.equal(normalizeOrigin('https://api.owenloop.com/foo/bar?x=1'), 'https://api.owenloop.com');
  assert.equal(normalizeOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(normalizeOrigin('  https://api.stg.owenloop.com  '), 'https://api.stg.owenloop.com');
});

test('normalizeOrigin rejects non-http(s) and empty input', () => {
  assert.throws(() => normalizeOrigin(''), /empty/);
  assert.throws(() => normalizeOrigin('ftp://example.com'), /http or https/);
  assert.throws(() => normalizeOrigin('not a url'), /invalid hub url/);
});

// ---- PKCE --------------------------------------------------------------------

test('pkcePair: verifier is unreserved-charset and challenge is S256 of the verifier', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9\-_]+$/, 'verifier is base64url (unreserved)');
  assert.ok(verifier.length >= 43 && verifier.length <= 128, `verifier length ${verifier.length} in RFC range`);
  const expected = base64url(createHash('sha256').update(verifier).digest());
  assert.equal(challenge, expected);
  assert.doesNotMatch(challenge, /[+/=]/, 'challenge has no non-url-safe base64 chars');
});

test('base64url matches the RFC 7636 Appendix B S256 vector', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('randomState yields distinct url-safe tokens', () => {
  const a = randomState();
  const b = randomState();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9\-_]+$/);
});

// ---- config dir derives from env, never process.env --------------------------

test('configDir prefers XDG_CONFIG_HOME, falls back to HOME/.config, else throws', () => {
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x' }), join('/x', 'owenloop'));
  assert.equal(configDir({ HOME: '/home/me' }), join('/home/me', '.config', 'owenloop'));
  assert.throws(() => configDir({}), /set HOME or XDG_CONFIG_HOME/);
});

// ---- credential file round-trip + strict modes -------------------------------

test('writeCredentialFile round-trips and enforces 0600 file / 0700 dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-cred-'));
  const env = { HOME: home };
  const path = credentialFilePath(env);

  const cred: Credential = {
    kind: 'oauth',
    accessToken: 'mcpat_secret',
    refreshToken: 'refresh_secret',
    expiresAt: 123,
    clientId: 'client-1',
  };
  writeCredentialFile(path, { version: 1, hubs: { 'https://api.owenloop.com': cred } });

  const readBack = readCredentialFile(path);
  assert.deepEqual(readBack.hubs['https://api.owenloop.com'], cred);

  assert.equal(statSync(path).mode & 0o777, 0o600, 'credential file is 0600');
  assert.equal(statSync(join(home, '.config', 'owenloop')).mode & 0o777, 0o700, 'config dir is 0700');
});

test('readCredentialFile: a missing file is an empty store', () => {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-cred-'));
  const store = readCredentialFile(credentialFilePath({ HOME: home }));
  assert.deepEqual(store, { version: 1, hubs: {} });
});

// ---- hub binding round-trip ----------------------------------------------

test('hub binding round-trips; missing file is null', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-bind-'));
  const path = hubBindingPath(cwd);
  assert.equal(readHubBinding(path), null);

  const binding: HubBinding = { version: 1, hub: 'https://api.owenloop.com' };
  writeHubBinding(path, binding);
  assert.deepEqual(readHubBinding(path), binding);
});

test('readHubBinding: a file with a leftover legacy `pushed` key still parses, key ignored', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-bind-'));
  const path = hubBindingPath(cwd);
  writeHubBinding(path, {
    version: 1,
    hub: 'https://api.owenloop.com',
    // @ts-expect-error -- simulating a pre-server-diff CLI's binding file
    pushed: { alpha: { localHash: 'h1', remoteVersion: 3, remoteHash: 'rh1', pushedAt: 10 } },
  });
  assert.deepEqual(readHubBinding(path), { version: 1, hub: 'https://api.owenloop.com' });
});

// ---- server diff ---------------------------------------------------------------

test('computeServerDiff: new when absent from server, changed when hash differs, unchanged when equal', () => {
  const server = new Map<string, WorkflowSummary>([
    ['same', { name: 'same', hash: 'H' }],
    ['drifted', { name: 'drifted', hash: 'OLD' }],
  ]);
  const defs = [
    { name: 'same', hash: 'H' },
    { name: 'drifted', hash: 'NEW' },
    { name: 'brandnew', hash: 'X' },
  ];
  const { toPush, unchanged } = computeServerDiff(defs, server, false);
  assert.deepEqual(unchanged.map((d) => d.name), ['same']);
  assert.deepEqual(
    toPush.map((d) => ({ name: d.name, status: d.status })).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'brandnew', status: 'new' },
      { name: 'drifted', status: 'changed' },
    ],
  );
});

test('computeServerDiff: --force pushes everything, even unchanged, still labeled by presence', () => {
  const server = new Map<string, WorkflowSummary>([
    ['same', { name: 'same', hash: 'H' }],
  ]);
  const { toPush, unchanged } = computeServerDiff(
    [{ name: 'same', hash: 'H' }, { name: 'brandnew', hash: 'X' }],
    server,
    true,
  );
  assert.equal(unchanged.length, 0);
  assert.deepEqual(
    toPush.map((d) => ({ name: d.name, status: d.status })).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'brandnew', status: 'new' },
      { name: 'same', status: 'changed' },
    ],
  );
});

test('computeServerDiff: a name absent from the server-vs-local diff on the server side is ignored', () => {
  const server = new Map<string, WorkflowSummary>([
    ['hubonly', { name: 'hubonly', hash: 'H' }],
  ]);
  const { toPush, unchanged } = computeServerDiff([{ name: 'local', hash: 'X' }], server, false);
  assert.deepEqual(toPush.map((d) => d.name), ['local']);
  assert.equal(unchanged.length, 0);
});

// ---- create_workflow response guard ------------------------------------------

test('createWorkflowError: ok:true is null, ok:false surfaces the error verbatim', () => {
  assert.equal(createWorkflowError({ ok: true, name: 'x', version: 2, hash: 'h' }), null);
  assert.equal(createWorkflowError({ ok: false, error: 'engine version 2 unsupported' }), 'engine version 2 unsupported');
  assert.match(createWorkflowError('nope') ?? '', /unexpected response shape/);
});

test('asCreateWorkflowOk: carries unchanged:true through when the server reports a no-op', () => {
  const ok = asCreateWorkflowOk({ ok: true, name: 'x', version: 2, hash: 'h', unchanged: true });
  assert.equal(ok.unchanged, true);
  const fresh = asCreateWorkflowOk({ ok: true, name: 'x', version: 3, hash: 'h2' });
  assert.equal(fresh.unchanged, undefined);
});

// ---- whoami response guard -----------------------------------------------

test('asWhoami: narrows a well-formed body, defaults missing optional fields', () => {
  const identity = asWhoami({
    orgId: 'org_1',
    orgName: 'Acme',
    actor: { id: 'user_1', kind: 'user', role: 'admin' },
    authMethod: 'oauth',
    email: 'a@example.com',
  });
  assert.deepEqual(identity, {
    orgId: 'org_1',
    orgName: 'Acme',
    actor: { id: 'user_1', kind: 'user', role: 'admin' },
    authMethod: 'oauth',
    email: 'a@example.com',
  });
});

test('asWhoami: throws on a missing orgId or non-object body', () => {
  assert.throws(() => asWhoami({}), /missing string orgId/);
  assert.throws(() => asWhoami('nope'), /unexpected response shape/);
});

// ---- workflow list response guard -----------------------------------------

test('parseWorkflowList: builds a name -> summary map, keeps optional version', () => {
  const map = parseWorkflowList({
    text: '',
    workflows: [
      { name: 'a', hash: 'ha', version: 3, steps: [] },
      { name: 'b', hash: 'hb', steps: [] },
    ],
  });
  assert.deepEqual(map.get('a'), { name: 'a', hash: 'ha', version: 3 });
  assert.deepEqual(map.get('b'), { name: 'b', hash: 'hb' });
  assert.equal(map.size, 2);
});

test('parseWorkflowList: throws on a missing/malformed workflows array or entry', () => {
  assert.throws(() => parseWorkflowList({}), /expected a `workflows` array/);
  assert.throws(() => parseWorkflowList({ workflows: ['nope'] }), /workflows\[0\] is not an object/);
  assert.throws(() => parseWorkflowList({ workflows: [{}] }), /workflows\[0\] missing string name/);
});
