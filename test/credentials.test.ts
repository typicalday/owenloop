/**
 * `readStoredCredential` — the public, read-only credential surface exported
 * from the package root. Exercises both backends (injected fake keychain and
 * the 0600 file store under a fixture `$HOME`), the REL-6 no-fallback rule,
 * backend precedence, origin normalization, and that the export + its types
 * resolve from the barrel (`src/index.ts`).
 *
 * Hermetic per project rule: every test materializes its own `$HOME` fixture
 * (mkdtemp) and either injects the fake keychain or forces the file backend
 * with `OWENLOOP_NO_KEYCHAIN=1` — never the developer's real keychain, never
 * their real `~/.config`, and never platform-dependent (`defaultKeychain` is
 * `undefined` off macOS, so backend choice here is always forced by injection
 * or the env flag, not by the runner's OS).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialFilePath, normalizeOrigin, readStoredCredential, writeCredentialFile } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { fakeKeychain } from './hubkit.ts';
// Consumer-style import of the package root, exactly as an external consumer resolves it.
import * as pub from '../src/index.ts';
// Type-level proof that the barrel re-exports `Credential` (typecheck fails if not).
import type { Credential as BarrelCredential } from '../src/index.ts';

const ORIGIN = 'https://hub.example.com';
const KEY = normalizeOrigin(ORIGIN);
const CRED: Credential = { kind: 'agent', accessToken: 'olp_x' };

/** A fixture env with an isolated `$HOME`; opts merge on top (e.g. the NO_KEYCHAIN flag). */
function fixtureEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-cred-home-'));
  return { HOME: home, ...extra };
}

test('keychain backend, hit: returns the parsed credential', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain();
  keychain.set(KEY, JSON.stringify(CRED));
  assert.deepEqual(readStoredCredential(ORIGIN, { env, keychain }), CRED);
});

test('keychain backend, miss: returns null', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain();
  assert.equal(readStoredCredential(ORIGIN, { env, keychain }), null);
});

test('REL-6: empty keychain never falls through to a populated file', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain(); // keychain EMPTY
  writeCredentialFile(credentialFilePath(env), { version: 1, hubs: { [KEY]: CRED } });
  assert.equal(readStoredCredential(ORIGIN, { env, keychain }), null);
});

test('REL-6: corrupt keychain entry reads as absent, not a file fallthrough', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain();
  keychain.set(KEY, 'not-json-{'); // corrupt
  writeCredentialFile(credentialFilePath(env), { version: 1, hubs: { [KEY]: CRED } });
  assert.equal(readStoredCredential(ORIGIN, { env, keychain }), null);
});

test('backend precedence: OWENLOOP_NO_KEYCHAIN=1 forces the file backend even when a keychain is injected', () => {
  const env = fixtureEnv({ OWENLOOP_NO_KEYCHAIN: '1' });
  const { keychain } = fakeKeychain();
  const kcCred: Credential = { kind: 'agent', accessToken: 'olp_from_keychain' };
  keychain.set(KEY, JSON.stringify(kcCred)); // should be IGNORED
  const fileCred: Credential = { kind: 'agent', accessToken: 'olp_from_file' };
  writeCredentialFile(credentialFilePath(env), { version: 1, hubs: { [KEY]: fileCred } });
  assert.deepEqual(readStoredCredential(ORIGIN, { env, keychain }), fileCred);
});

test('file backend: reads a written store; empty store returns null', () => {
  const env = fixtureEnv({ OWENLOOP_NO_KEYCHAIN: '1' }); // no keychain injected → file backend, platform-independent
  assert.equal(readStoredCredential(ORIGIN, { env }), null);
  writeCredentialFile(credentialFilePath(env), { version: 1, hubs: { [KEY]: CRED } });
  assert.deepEqual(readStoredCredential(ORIGIN, { env }), CRED);
});

test('origin is normalized before the account lookup; an invalid remote origin throws', () => {
  const env = fixtureEnv();
  const { keychain } = fakeKeychain();
  keychain.set(KEY, JSON.stringify(CRED)); // stored under the normalized origin
  // A path-bearing, trailing-slash variant normalizes to the same key.
  assert.deepEqual(readStoredCredential('https://hub.example.com/some/path/', { env, keychain }), CRED);
  // A plaintext remote origin is rejected at normalization (SEC-2), exactly as the CLI would.
  assert.throws(() => readStoredCredential('http://remote.example.com', { env, keychain }), /http is only allowed for loopback/);
});

test('public surface: the barrel re-exports the read function, the normalizer, and the Credential type', () => {
  assert.equal(typeof pub.readStoredCredential, 'function');
  assert.equal(typeof pub.normalizeOrigin, 'function');
  // Type-level use of the barrel's Credential type — compiles only if it resolves from the barrel.
  const typed: BarrelCredential = { kind: 'oauth-pasted', accessToken: 'mcpat_x' };
  assert.equal(typed.kind, 'oauth-pasted');
});
