/**
 * Unit: resolveBearer + slotArg — the ONE place bearer precedence lives, shared
 * by all five roles: dev-override (OWENLOOP_TOKEN) → agent-slot store → refuse.
 *
 * Store-backed cases run through the REAL owenloop file backend, seeded into a
 * hermetic temp HOME with OWENLOOP_NO_KEYCHAIN=1 (forces the file store, no
 * keychain shell-out). The override case must NOT consult the store at all — it
 * is proven by pointing at an EMPTY store yet still resolving a token.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { resolveBearer, slotArg } from '../src/credentials/resolve.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'owenloop-resolve-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Seed the agent:<account> slots for `origin` into the hermetic file store. */
function seed(origin: string, slots: Record<string, string>): void {
  const dir = join(home, 'owenloop');
  mkdirSync(dir, { recursive: true });
  const hubs: Record<string, Record<string, unknown>> = { [origin]: {} };
  for (const [account, token] of Object.entries(slots)) {
    hubs[origin]![`agent:${account}`] = { kind: 'agent', accessToken: token };
  }
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ version: 2, hubs }));
}

/** A hermetic env pointing owenloop's file store at our temp HOME. */
function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { HOME: home, XDG_CONFIG_HOME: home, OWENLOOP_NO_KEYCHAIN: '1', ...extra };
}

const ORIGIN = 'https://hub.example';

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

// ---- error (code 1) ---------------------------------------------------------

test('a read failure (remote plaintext origin, SEC-2 throw) → error (code 1) with the message', async () => {
  const r = await resolveBearer({ origin: 'http://hub.example', account: 'default', env: env() });
  assert.equal(r.ok, false);
  assert.equal((r as { code: number }).code, 1);
  assert.match((r as { message: string }).message, /credential read failed for http:\/\/hub\.example \(account "default"\):/);
});
