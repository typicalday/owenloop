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
  base64url,
  computePushDiff,
  configDir,
  createWorkflowError,
  credentialFilePath,
  hubBindingPath,
  normalizeOrigin,
  pkcePair,
  randomState,
  readCredentialFile,
  readHubBinding,
  writeCredentialFile,
  writeHubBinding,
} from '../src/hub.ts';
import type { Credential, HubBinding, PushedEntry } from '../src/hub.ts';

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

// ---- hub binding round-trip + pushed-state preservation/reset ----------------

test('hub binding round-trips; missing file is null', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-bind-'));
  const path = hubBindingPath(cwd);
  assert.equal(readHubBinding(path), null);

  const pushed: Record<string, PushedEntry> = {
    alpha: { localHash: 'h1', remoteVersion: 3, remoteHash: 'rh1', pushedAt: 10 },
  };
  const binding: HubBinding = { version: 1, hub: 'https://api.owenloop.com', pushed };
  writeHubBinding(path, binding);
  assert.deepEqual(readHubBinding(path), binding);
});

// ---- push diff ---------------------------------------------------------------

test('computePushDiff: unchanged when hash matches prior localHash, else pushes', () => {
  const pushed: Record<string, PushedEntry> = {
    same: { localHash: 'H', remoteVersion: 1, remoteHash: 'r', pushedAt: 1 },
    drifted: { localHash: 'OLD', remoteVersion: 1, remoteHash: 'r', pushedAt: 1 },
  };
  const defs = [
    { name: 'same', hash: 'H' },
    { name: 'drifted', hash: 'NEW' },
    { name: 'brandnew', hash: 'X' },
  ];
  const { toPush, unchanged } = computePushDiff(defs, pushed, false);
  assert.deepEqual(unchanged.map((d) => d.name), ['same']);
  assert.deepEqual(toPush.map((d) => d.name).sort(), ['brandnew', 'drifted']);
});

test('computePushDiff: --force pushes everything, even unchanged', () => {
  const pushed: Record<string, PushedEntry> = {
    same: { localHash: 'H', remoteVersion: 1, remoteHash: 'r', pushedAt: 1 },
  };
  const { toPush, unchanged } = computePushDiff([{ name: 'same', hash: 'H' }], pushed, true);
  assert.equal(unchanged.length, 0);
  assert.deepEqual(toPush.map((d) => d.name), ['same']);
});

// ---- create_workflow response guard ------------------------------------------

test('createWorkflowError: ok:true is null, ok:false surfaces the error verbatim', () => {
  assert.equal(createWorkflowError({ ok: true, name: 'x', version: 2, hash: 'h' }), null);
  assert.equal(createWorkflowError({ ok: false, error: 'engine version 2 unsupported' }), 'engine version 2 unsupported');
  assert.match(createWorkflowError('nope') ?? '', /unexpected response shape/);
});
