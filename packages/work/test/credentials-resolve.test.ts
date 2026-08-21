/**
 * Unit: resolveBearer + slotArg — the ONE place bearer precedence lives, shared
 * by the agent roles: dev-override (OWENLOOP_TOKEN) → agent-slot store →
 * refuse. Human-only callers instead read the exact human slot.
 *
 * Store-backed cases run through the REAL owenloop file backend, seeded into a
 * hermetic temp HOME with OWENLOOP_NO_KEYCHAIN=1 (forces the file store, no
 * keychain shell-out). The override case must NOT consult the store at all — it
 * is proven by pointing at an EMPTY store yet still resolving a token.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { resolveBearer, slotArg } from '../src/credentials/resolve.ts';
import type { Credential } from '../../../src/hub.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'owenloop-resolve-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Seed agent:<account> slots and, optionally, the human slot for `origin`. */
function seed(origin: string, slots: Record<string, string>, human?: Credential): void {
  const dir = join(home, '.owenloop');
  mkdirSync(dir, { recursive: true });
  const hubs: Record<string, Record<string, unknown>> = { [origin]: {} };
  for (const [account, token] of Object.entries(slots)) {
    hubs[origin]![`agent:${account}`] = { kind: 'agent', accessToken: token };
  }
  if (human !== undefined) hubs[origin]!.human = human;
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ version: 2, hubs }));
}

/** A hermetic env pointing owenloop's file store at our temp HOME. */
function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { HOME: home, OWENLOOP_NO_KEYCHAIN: '1', ...extra };
}

const ORIGIN = 'https://hub.example';

function oauth(over: Partial<Extract<Credential, { kind: 'oauth' }>> = {}): Extract<Credential, { kind: 'oauth' }> {
  return {
    kind: 'oauth',
    accessToken: 'access_fixture',
    refreshToken: 'refresh_fixture',
    expiresAt: Date.now() + 3_600_000,
    clientId: 'work-cli',
    ...over,
  };
}

function refreshFetch(tokenStatus = 200): { fetch: typeof globalThis.fetch; tokenPosts: () => number } {
  let posts = 0;
  const fetch: typeof globalThis.fetch = (async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${ORIGIN}/.well-known/oauth-authorization-server`) {
      return new Response(JSON.stringify({ token_endpoint: '/mcp/token' }), { status: 200 });
    }
    if (url === `${ORIGIN}/mcp/token`) {
      posts += 1;
      const body = tokenStatus === 200 ? { access_token: 'access_rotated', refresh_token: 'refresh_rotated', expires_in: 3600 } : { error: 'invalid_grant' };
      return new Response(JSON.stringify(body), { status: tokenStatus });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, tokenPosts: () => posts };
}

// ---- slotArg ----------------------------------------------------------------

test('slotArg maps default → agent, else agent:<account>', () => {
  assert.equal(slotArg('default'), 'agent');
  assert.equal(slotArg('ci'), 'agent:ci');
});

// ---- override (dev-only) ----------------------------------------------------

test('OWENLOOP_TOKEN wins and does NOT consult the store', async () => {
  // Empty store; the override alone must resolve.
  const r = await resolveBearer({ origin: ORIGIN, account: 'default', env: env({ OWENLOOP_TOKEN: 'dev_override' }) });
  assert.deepEqual(r, { ok: true, token: 'dev_override' });
});

test('a whitespace-only OWENLOOP_TOKEN is ignored (falls through to the store)', async () => {
  seed(ORIGIN, { default: 'store_tok' });
  const r = await resolveBearer({ origin: ORIGIN, account: 'default', env: env({ OWENLOOP_TOKEN: '   ' }) });
  assert.deepEqual(r, { ok: true, token: 'store_tok' });
});

// ---- store-backed success ---------------------------------------------------

test('no override + a stored agent:default key → that token', async () => {
  seed(ORIGIN, { default: 'olp_from_store' });
  const r = await resolveBearer({ origin: ORIGIN, account: 'default', env: env() });
  assert.deepEqual(r, { ok: true, token: 'olp_from_store' });
});

test('the account selects its own agent slot (ci, not default)', async () => {
  seed(ORIGIN, { default: 'tok_default', ci: 'tok_ci' });
  const r = await resolveBearer({ origin: ORIGIN, account: 'ci', env: env() });
  assert.deepEqual(r, { ok: true, token: 'tok_ci' });
});

// ---- refuse (code 2) --------------------------------------------------------

test('no override + no stored key → refuse (code 2) naming a runnable connect command', async () => {
  const r = await resolveBearer({ origin: ORIGIN, account: 'default', env: env() });
  assert.equal(r.ok, false);
  assert.equal((r as { code: number }).code, 2);
  assert.match(
    (r as { message: string }).message,
    /no Scoped Identity key for https:\/\/hub\.example \(account "default"\) — run: owenloop login --hub https:\/\/hub\.example --as agent/,
  );
});

test('a non-default account refuse names the agent:<account> slot in the hint', async () => {
  const r = await resolveBearer({ origin: ORIGIN, account: 'ci', env: env() });
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /account "ci"\) — run: owenloop login --hub https:\/\/hub\.example --as agent:ci/);
});

// ---- human slot -------------------------------------------------------------

test('a human-only store satisfies human resolution', async () => {
  seed(ORIGIN, {}, oauth());
  const r = await resolveBearer({ origin: ORIGIN, principal: 'human', env: env() });
  assert.equal(r.ok, true);
});

test('near-expiry human oauth refreshes once and persists its rotation before resolution', async () => {
  seed(ORIGIN, {}, oauth({ expiresAt: Date.now() - 1_000 }));
  const credentialPath = join(home, '.owenloop', 'credentials.json');
  const before = readFileSync(credentialPath, 'utf8');
  const refresh = refreshFetch();

  const r = await resolveBearer({
    origin: ORIGIN,
    principal: 'human',
    env: env(),
    credentialIo: { fetch: refresh.fetch },
  });
  assert.equal(r.ok, true);
  assert.equal(refresh.tokenPosts(), 1);
  const after = readFileSync(credentialPath, 'utf8');
  assert.notEqual(after, before, 'the refreshed credential must be persisted');
  const stored = JSON.parse(after) as { hubs: Record<string, { human: { kind: string; expiresAt: number } }> };
  assert.equal(stored.hubs[ORIGIN]!.human.kind, 'oauth');
  assert.ok(stored.hubs[ORIGIN]!.human.expiresAt > Date.now() + 60_000);
});

test('a human oauth-pasted credential resolves without an OAuth refresh', async () => {
  seed(ORIGIN, {}, { kind: 'oauth-pasted', accessToken: 'pasted_fixture' });
  const r = await resolveBearer({ origin: ORIGIN, principal: 'human', env: env() });
  assert.equal(r.ok, true);
});

test('an agent-only store does not satisfy human resolution', async () => {
  seed(ORIGIN, { default: 'agent_only' });
  const r = await resolveBearer({ origin: ORIGIN, principal: 'human', env: env() });
  assert.equal(r.ok, false);
  assert.equal((r as { code: number }).code, 2);
  assert.match(
    (r as { message: string }).message,
    /no human credential for https:\/\/hub\.example — run: owenloop login --hub https:\/\/hub\.example --as human/,
  );
});

test('OWENLOOP_TOKEN cannot satisfy human resolution without a stored human credential', async () => {
  const r = await resolveBearer({
    origin: ORIGIN,
    principal: 'human',
    env: env({ OWENLOOP_TOKEN: 'dev_override' }),
  });
  assert.equal(r.ok, false);
  assert.equal((r as { code: number }).code, 2);
  assert.match((r as { message: string }).message, /--as human/);
});

// ---- error (code 1) ---------------------------------------------------------

test('a read failure (remote plaintext origin, SEC-2 throw) → error (code 1) with the message', async () => {
  const r = await resolveBearer({ origin: 'http://hub.example', account: 'default', env: env() });
  assert.equal(r.ok, false);
  assert.equal((r as { code: number }).code, 1);
  assert.match((r as { message: string }).message, /credential read failed for http:\/\/hub\.example \(account "default"\):/);
});

test('a human credential read failure is exit 1 with a human-specific message', async () => {
  const r = await resolveBearer({ origin: 'http://hub.example', principal: 'human', env: env() });
  assert.equal(r.ok, false);
  assert.equal((r as { code: number }).code, 1);
  assert.match((r as { message: string }).message, /human credential read failed for http:\/\/hub\.example:/);
});

test('a human OAuth refresh failure is secret-free and exits 1', async () => {
  seed(ORIGIN, {}, oauth({ expiresAt: Date.now() - 1_000 }));
  const refresh = refreshFetch(400);
  const r = await resolveBearer({
    origin: ORIGIN,
    principal: 'human',
    env: env(),
    credentialIo: { fetch: refresh.fetch },
  });
  assert.equal(r.ok, false);
  assert.equal((r as { code: number }).code, 1);
  const message = (r as { message: string }).message;
  assert.match(message, /human credential refresh failed for https:\/\/hub\.example/);
  assert.equal(message.includes('access_fixture'), false);
  assert.equal(message.includes('refresh_fixture'), false);
});
