/**
 * The shared M4-drill credential-store fixture (WO-6.1).
 *
 * The M4 single-principal failure drills MUST authenticate through owenloop's
 * REAL stored-credential path — NOT the `OWENWORK_TOKEN` dev override. That is
 * the distinguishing requirement of M4: M3 already proved the roles scripted
 * with `OWENWORK_TOKEN`; M4 proves owenwork survives the failure modes while
 * reading its bearer from owenloop's on-disk store the way production does.
 *
 * In CI there is no macOS Keychain, so we point owenloop's file backend at a
 * hermetic temp HOME we control and seed a throwaway agent credential into it.
 * Two facts make the loopback http mock hub work with the real store (both
 * grounded from owenloop's own code, node_modules/owenloop/dist/hub.js):
 *
 *  1. owenloop's SEC-2 https-only rule EXEMPTS loopback hosts (localhost,
 *     127.0.0.1, [::1]) — so `http://127.0.0.1:<port>` resolves a stored agent
 *     token instead of throwing. The mock hub binds 127.0.0.1, so it qualifies.
 *  2. Credentials key on the EXACT origin string. `http://127.0.0.1:5599`
 *     resolves; `http://localhost:5599` returns null for the same store. The
 *     mock hub's port is dynamic, so every drill seeds the store AFTER
 *     `startMockHub` returns its `origin`, keyed to that exact origin.
 *
 * `resolveBearer` maps account `default` → the store slot key `agent:default`
 * (see src/credentials/resolve.ts + test/credentials-resolve.test.ts). The
 * fixture writes that slot.
 *
 * Lives under `test/helpers/` so the `test/*.test.ts` glob never runs it as a
 * suite of its own.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The throwaway agent token every drill seeds and then asserts on the wire. */
export const DRILL_TOKEN = 'drill_agent_tok';

/** The Authorization header a store-resolved drill request must carry. */
export const DRILL_AUTH = `Bearer ${DRILL_TOKEN}`;

/**
 * Two-conductor constants for the pool-isolation drill (drill 6, WO-6.2).
 *
 * Drill 6 spawns two concurrent proxy conductors on ONE mock hub, each on a
 * different serve pool AND a different stored-credential account, to prove
 * neither reaches across pools. Each conductor authenticates from its OWN
 * `agent:<account>` slot (accounts `a`/`b` via `--as`), so the recorded wire
 * bearers must be distinct — that distinctness is what lets the drill bind
 * bearer↔pool and audit for cross-pool reaches. The tokens are throwaway
 * literals, never real keys; no secret is committed.
 */
export const POOL_A_ACCOUNT = 'a';
export const POOL_B_ACCOUNT = 'b';
export const POOL_A_TOKEN = 'drill_pool_a_tok';
export const POOL_B_TOKEN = 'drill_pool_b_tok';
export const POOL_A_AUTH = `Bearer ${POOL_A_TOKEN}`;
export const POOL_B_AUTH = `Bearer ${POOL_B_TOKEN}`;

/**
 * Seed owenloop's v2 file backend under `<home>/owenloop/credentials.json` with
 * an `agent:<account>` slot for `origin`. Keyed to the EXACT origin (dynamic
 * port), so call this AFTER `startMockHub`. `token` is a throwaway literal —
 * never a real key; no secret is committed.
 *
 * `account` (default `'default'`) selects the store slot key `agent:<account>`,
 * matching how `resolveBearer` addresses the `--as <account>` surface. Drills
 * 1–5 call this 2/3-arg and land in `agent:default`, unchanged; drill 6 passes
 * a distinct `account` per conductor so each has its own credential.
 */
export function seedCredentialStore(
  home: string,
  origin: string,
  token: string = DRILL_TOKEN,
  account: string = 'default',
): void {
  const dir = join(home, 'owenloop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'credentials.json'),
    JSON.stringify({ version: 2, hubs: { [origin]: { [`agent:${account}`]: { kind: 'agent', accessToken: token } } } }),
  );
}

/**
 * The hermetic env every drill child runs under. Points owenloop's file store
 * (and owenwork's settings) at the temp `home`, forces the file backend (no
 * Keychain in CI), and — CRITICALLY — STRIPS `OWENWORK_TOKEN`.
 *
 * `spawnMcp` spreads `process.env` into the child, so a stray ambient dev token
 * would otherwise leak in and take the override branch of `resolveBearer`,
 * silently defeating the whole point of an M4 drill. Setting it to `undefined`
 * makes Node drop the key entirely from the child env, guaranteeing the store
 * path. `OWENWORK_SESSION` is cleared so no ambient session-holder tag rides
 * along (drills that want one pass it explicitly). `OWENWORK_ACCOUNT` is dropped
 * for the same reason: a dev machine that exports it (e.g. a conductor's
 * `OWENWORK_ACCOUNT=<name>`) would otherwise make the child resolve
 * `agent:<name>` instead of the `agent:default` slot the fixture seeds, so the
 * store lookup misses and the child exits 2 before any hub contact. Drills that
 * need a non-default account seed that slot and pass `--as`/`OWENWORK_ACCOUNT`
 * explicitly via `extra`.
 */
export function fixtureEnv(home: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: home,
    OWENLOOP_NO_KEYCHAIN: '1',
    OWENWORK_TOKEN: undefined, // WO-6.1: never the override — the store path IS the drill
    OWENWORK_SESSION: '',
    OWENWORK_ACCOUNT: undefined, // hermeticity: never inherit an ambient account (would miss the seeded agent:default slot)
    ...extra,
  };
}
