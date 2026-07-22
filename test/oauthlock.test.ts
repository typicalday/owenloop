/**
 * Concurrency-safe OAuth refresh + the credential WRITE surface
 * (`src/credentials.ts`). Proves the lockfile protocol
 * (`~/.config/owenloop/credentials.lock`, via `src/lock.ts`) turns "two
 * refreshes race" into "the loser adopts the winner's rotated token" instead of
 * stranding a dead refresh token (the silent-logout bug the lock exists to
 * prevent), plus the store/delete write path and the barrel exports.
 *
 * Hermetic per project rule: every test builds its own `$HOME` fixture via
 * `makeIo` (mkdtemp HOME + injected fake keychain), injects a route-based
 * `routedFetch`, and drives all lock timings through the `OWENLOOP_CRED_LOCK_*`
 * env knobs — never the developer's real keychain, `~/.config`, or the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  deleteCredential,
  ensureFreshOAuth,
  refreshOAuth,
  storeCredential,
} from '../src/credentials.ts';
import { configDir } from '../src/hub.ts';
import type { Credential, CredentialSlotSelector } from '../src/hub.ts';
import { nowMs } from '../src/util.ts';
import { makeIo, routedFetch, OAUTH_METADATA, kcHuman } from './hubkit.ts';
import type { RouteHandler } from './hubkit.ts';
// Consumer-style barrel import, exactly as an external consumer resolves it.
import * as pub from '../src/index.ts';

const ORIGIN = 'https://hub.example.com';
const HUMAN: CredentialSlotSelector = { principal: 'human' };
const AGENT_CI: CredentialSlotSelector = { principal: 'agent', account: 'ci' };

/** A near-expiry oauth credential (10s left, below the 60s freshness window). */
function nearExpiryOauth(over: Partial<Extract<Credential, { kind: 'oauth' }>> = {}): Extract<Credential, { kind: 'oauth' }> {
  return { kind: 'oauth', accessToken: 'access_seed', refreshToken: 'refresh_seed', expiresAt: nowMs() + 10_000, clientId: 'client_1', ...over };
}

/**
 * Routes for OAuth discovery + a ROTATING token endpoint: each `POST /mcp/token`
 * mints `access_N` / `refresh_N` from a counter (so a second, redundant refresh
 * is detectable as `access_2`) and echoes `expires_in: 3600` (well past the 60s
 * window, so a freshly refreshed token reads as fresh/adoptable).
 */
function tokenRoutes(): Record<string, RouteHandler> {
  let n = 0;
  return {
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => {
      n += 1;
      return { status: 200, json: { access_token: `access_${n}`, refresh_token: `refresh_${n}`, expires_in: 3600 } };
    },
  };
}

/** Count of token-endpoint POSTs actually made — the "how many refreshes happened" probe. */
function tokenPosts(calls: { method: string; pathname: string }[]): number {
  return calls.filter((c) => c.method === 'POST' && c.pathname === '/mcp/token').length;
}

/** The credential lock path for a fixture env — sibling of `credentials.json`. */
function lockPathFor(env: Record<string, string | undefined>): string {
  return join(configDir(env), 'credentials.lock');
}

/** Read the persisted human-slot credential back out of the fake keychain map. */
function persistedHuman(store: Map<string, string>): Credential {
  const raw = store.get(kcHuman(ORIGIN));
  assert.ok(raw, 'expected a persisted human-slot credential');
  return JSON.parse(raw) as Credential;
}

// ---- 1. Concurrent refresh (the acceptance test) ----------------------------

test('concurrent refresh: only one HTTP refresh happens; the loser adopts the rotated token', async () => {
  const { fetch, calls } = routedFetch(tokenRoutes());
  const t = makeIo({ fetch, env: { OWENLOOP_CRED_LOCK_POLL_MS: '5' } });
  const seed = nearExpiryOauth();
  await storeCredential(t.io, ORIGIN, HUMAN, seed);

  const [a, b] = await Promise.all([
    ensureFreshOAuth(t.io, ORIGIN, HUMAN, seed),
    ensureFreshOAuth(t.io, ORIGIN, HUMAN, seed),
  ]);

  // Exactly ONE refresh over the wire — the second call adopted, no second POST.
  assert.equal(tokenPosts(calls), 1);
  // Both callers end on the SAME access token (the winner's), never divergent.
  assert.equal(a.accessToken, 'access_1');
  assert.equal(b.accessToken, 'access_1');
  // The persisted credential carries the winner's ROTATED refresh token, never
  // the seed's now-dead one (persisting the dead token is the silent-logout bug).
  const stored = persistedHuman(t.store);
  assert.equal(stored.kind, 'oauth');
  assert.equal((stored as Extract<Credential, { kind: 'oauth' }>).refreshToken, 'refresh_1');
  // The lock is released, not leaked.
  assert.equal(existsSync(lockPathFor(t.io.env)), false);
});

// ---- 2. Stale lock is reclaimed ---------------------------------------------

test('a stale (old-mtime, unparseable) lockfile is reclaimed, then released', async () => {
  const { fetch, calls } = routedFetch(tokenRoutes());
  const t = makeIo({ fetch, env: { OWENLOOP_CRED_LOCK_STALE_MS: '50', OWENLOOP_CRED_LOCK_POLL_MS: '5' } });
  const seed = nearExpiryOauth();
  await storeCredential(t.io, ORIGIN, HUMAN, seed);

  // Pre-plant a garbage (pid-less, unparseable) lockfile with a backdated mtime,
  // so age is the only abandonment signal and it is past the tiny stale TTL.
  const lockPath = lockPathFor(t.io.env);
  mkdirSync(configDir(t.io.env), { recursive: true });
  writeFileSync(lockPath, 'garbage-not-json');
  const old = (nowMs() - 10_000) / 1000; // seconds, 10s ago ≫ 50ms stale TTL
  utimesSync(lockPath, old, old);

  const out = await ensureFreshOAuth(t.io, ORIGIN, HUMAN, seed);

  assert.equal(out.accessToken, 'access_1'); // it refreshed (reclaimed the lock)
  assert.equal(tokenPosts(calls), 1);
  assert.equal(existsSync(lockPath), false); // reclaimed then released
});

// ---- 3. A live, held lock times out cleanly (no unlocked fallback) -----------

test('a live held lock times out as a CliError, with no unlocked refresh fallback', async () => {
  const { fetch, calls } = routedFetch(tokenRoutes());
  const t = makeIo({ fetch, env: { OWENLOOP_CRED_LOCK_WAIT_MS: '60', OWENLOOP_CRED_LOCK_POLL_MS: '10' } });
  const seed = nearExpiryOauth();
  await storeCredential(t.io, ORIGIN, HUMAN, seed);

  // A lock held by THIS process (alive pid, same host) — never stale, never
  // reclaimed; the acquire must wait out its deadline and fail.
  const lockPath = lockPathFor(t.io.env);
  mkdirSync(configDir(t.io.env), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: nowMs(), token: 'held' }));

  await assert.rejects(
    ensureFreshOAuth(t.io, ORIGIN, HUMAN, seed),
    (e: Error) => {
      assert.match(e.message, /using the credential store/);
      assert.match(e.message, /credentials\.lock/);
      assert.ok(!e.message.includes(seed.refreshToken), 'error must not carry any token value');
      return true;
    },
  );
  // The timeout must NEVER silently fall through to an unlocked refresh.
  assert.equal(tokenPosts(calls), 0);
});

// ---- 4. Adopt beats a redundant re-refresh ----------------------------------

test('adopt beats re-refresh: a second refresh with a stale cred adopts, zero extra POSTs', async () => {
  const { fetch, calls } = routedFetch(tokenRoutes());
  const t = makeIo({ fetch, env: { OWENLOOP_CRED_LOCK_POLL_MS: '5' } });
  const seed = nearExpiryOauth();
  await storeCredential(t.io, ORIGIN, HUMAN, seed);

  // First refresh runs to completion: stored is now the fresh access_1.
  const first = await refreshOAuth(t.io, ORIGIN, HUMAN, seed);
  assert.equal(first.accessToken, 'access_1');
  assert.equal(tokenPosts(calls), 1);

  // Second call with the ORIGINAL stale cred: the re-read sees a fresh, different
  // stored token and adopts it — no network, no write.
  const second = await ensureFreshOAuth(t.io, ORIGIN, HUMAN, seed);
  assert.equal(second.accessToken, 'access_1');
  assert.equal((second as Extract<Credential, { kind: 'oauth' }>).refreshToken, 'refresh_1');
  assert.equal(tokenPosts(calls), 1); // still ONE — the adopt path made no POST
});

// ---- 5. persist:false never locks, persists, or adopts ----------------------

test('persist:false performs the HTTP refresh but never touches the store or adopts', async () => {
  const { fetch, calls } = routedFetch(tokenRoutes());
  const t = makeIo({ fetch });
  // The store holds a FRESH credential under a DIFFERENT token than the one we
  // refresh — an adopt (if it wrongly happened) would return `access_stored`.
  const stored = nearExpiryOauth({ accessToken: 'access_stored', refreshToken: 'refresh_stored', expiresAt: nowMs() + 3_600_000 });
  await storeCredential(t.io, ORIGIN, HUMAN, stored);
  const before = t.store.get(kcHuman(ORIGIN));

  const other = nearExpiryOauth({ accessToken: 'access_other', refreshToken: 'refresh_other' });
  const out = await refreshOAuth(t.io, ORIGIN, HUMAN, other, false);

  assert.equal(out.accessToken, 'access_1'); // it refreshed `other`, did not adopt
  assert.equal(tokenPosts(calls), 1);
  // The store is byte-identical — persist:false wrote nothing.
  assert.equal(t.store.get(kcHuman(ORIGIN)), before);
  // And no lockfile was ever created (unlocked path).
  assert.equal(existsSync(lockPathFor(t.io.env)), false);
});

// ---- 6. storeCredential / deleteCredential: async, locked, slot-merging ------

test('storeCredential/deleteCredential are async, lock-and-release, and merge slots', async () => {
  const { fetch } = routedFetch(tokenRoutes());
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  const human: Credential = { kind: 'oauth-pasted', accessToken: 'mcpat_human' };
  const agent: Credential = { kind: 'agent', accessToken: 'olp_ci' };

  // The new public API is async — it returns a Promise.
  const p = storeCredential(t.io, ORIGIN, HUMAN, human);
  assert.ok(p instanceof Promise);
  assert.equal(await p, 'file');
  // Writing a second slot MERGES — it must not clobber the human slot.
  assert.equal(await storeCredential(t.io, ORIGIN, AGENT_CI, agent), 'file');
  assert.deepEqual(pub.readStoredCredential(ORIGIN, { ...HUMAN, env: t.io.env }), human);
  assert.deepEqual(pub.readStoredCredential(ORIGIN, { ...AGENT_CI, env: t.io.env }), agent);
  // The lock is released after each write, never leaked.
  assert.equal(existsSync(lockPathFor(t.io.env)), false);

  // Delete is async and locked too; only the named slot goes.
  const removed = await deleteCredential(t.io, ORIGIN, AGENT_CI);
  assert.equal(removed, true);
  assert.equal(pub.readStoredCredential(ORIGIN, { ...AGENT_CI, env: t.io.env }), null);
  assert.deepEqual(pub.readStoredCredential(ORIGIN, { ...HUMAN, env: t.io.env }), human); // sibling survives
  assert.equal(existsSync(lockPathFor(t.io.env)), false);
});

// ---- 7. Barrel resolution ----------------------------------------------------

test('public surface: the barrel re-exports the credential write API as functions', () => {
  assert.equal(typeof pub.storeCredential, 'function');
  assert.equal(typeof pub.deleteCredential, 'function');
  assert.equal(typeof pub.ensureFreshOAuth, 'function');
});
