/**
 * Credential WRITE + OAuth refresh library surface.
 *
 * Extracted from `src/cli.ts` (where these were module-private) so external
 * consumers — a future `owenloop mcp` stdio server, an `owenwork join` command —
 * can store credentials and keep an OAuth access token fresh without depending
 * on the CLI module. The exported `storeCredential` / `deleteCredential` /
 * `ensureFreshOAuth` are re-imported by `cli.ts`, so every existing subcommand
 * keeps its exact behavior.
 *
 * **Concurrency safety (the reason this module exists):** the refresh-and-persist
 * critical section is serialized by a lockfile next to the store
 * (`~/.config/owenloop/credentials.lock`, via `src/lock.ts`). Multiple long-lived
 * processes sharing one slot (the `mcp` server case) would otherwise race a
 * refresh — both read the old refresh token, both rotate it server-side, and the
 * loser persists a now-dead token, causing a silent logout an hour later. The
 * lock turns "two refreshes race" into "the second process adopts the first's
 * result": acquire → re-read the slot → adopt-or-refresh → persist → release.
 *
 * This module imports ONLY `hub.ts` (store internals), `util.ts` (`CliError`,
 * `nowMs`), and `lock.ts` (node-builtin-only) — never `cli.ts`. That keeps the
 * package barrel (`src/index.ts`) free of the CLI/add/untar runtime closure and
 * avoids an import cycle.
 */

import { join } from 'node:path';
import {
  asMintAgentTokenOk,
  asRekeyAgentTokenOk,
  configDir,
  credentialBackend,
  credentialFilePath,
  credentialSlot,
  externalCredentialCommand,
  keychainServiceFor,
  readCredentialFile,
  readStoredCredential,
  resolveEndpoint,
  resolveKeychain,
  writeCredentialFile,
} from './hub.ts';
import type { Credential, CredentialSlotSelector, Keychain } from './hub.ts';
import { CliError, nowMs } from './util.ts';
import { acquireFileLock, FileLockTimeoutError, releaseFileLock } from './lock.ts';
import type { AcquireFileLockOpts, FileLockHandle } from './lock.ts';

/**
 * The dependencies the credential surface needs — a strict subset of the CLI's
 * `CliIO`, which structurally satisfies this interface, so every `cli.ts` call
 * site keeps passing its `io` unchanged. A library consumer constructs just
 * `{ env: process.env }` (plus an optional keychain/fetch) without faking the
 * CLI's `out`/`err`/`cwd`.
 */
export interface CredentialIO {
  env: Record<string, string | undefined>;
  /**
   * OS keychain backend for credential storage. `undefined` — non-mac, or
   * `OWENLOOP_NO_KEYCHAIN=1` — selects the file backend. A keychain write
   * failure is a hard error, never a silent file fallback (REL-6).
   */
  keychain?: Keychain;
  /** Injectable for hermetic tests — the OAuth-refresh network calls use this. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Freshness window shared by `ensureFreshOAuth`'s cheap pre-lock check and the
 * adopt decision under the lock: a stored token more than this far from expiry
 * is treated as fresh (either "no refresh needed" or "another process already
 * refreshed — adopt it").
 */
const FRESH_WINDOW_MS = 60_000;

// ---- the refresh/store lockfile --------------------------------------------

/** The credential lock path — sibling of `credentials.json` in the config dir. */
function credLockPath(env: Record<string, string | undefined>): string {
  return join(configDir(env), 'credentials.lock');
}

/** A positive-number env override, else the default (test knobs, same pattern as `OWENLOOP_HUB_TIMEOUT_MS`). */
function envNum(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Lock timings for the credential lock. Defaults 45s wait / 30s stale / 100ms
 * poll; each overridable via `OWENLOOP_CRED_LOCK_{WAIT,STALE,POLL}_MS`. The 30s
 * TTL is safe even against a slow live holder (a worst-case refresh — discovery
 * + token POST, each budgeted `HUB_TIMEOUT_MS` = 30s — can exceed it) because
 * `lockIsStale` never age-reclaims a lock whose recorded pid is alive; age only
 * governs an abandoned/unparseable lockfile.
 */
function credLockOpts(env: Record<string, string | undefined>): AcquireFileLockOpts {
  return {
    waitMs: envNum(env, 'OWENLOOP_CRED_LOCK_WAIT_MS', 45_000),
    staleMs: envNum(env, 'OWENLOOP_CRED_LOCK_STALE_MS', 30_000),
    pollMs: envNum(env, 'OWENLOOP_CRED_LOCK_POLL_MS', 100),
    label: 'owenloop credential operation',
  };
}

/**
 * Acquire the credential lock, mapping a clean acquire timeout to a loud
 * `CliError` — never falling through to an unlocked refresh (that would silently
 * reintroduce the double-refresh race). A real filesystem error from the
 * exclusive create (EACCES/EROFS) is NOT a timeout and propagates untouched. No
 * token value ever appears in the message (the lock payload is pid/host/
 * startedAt/token-only, and this message names neither the credential nor a
 * token).
 */
async function acquireCredLock(io: CredentialIO): Promise<FileLockHandle> {
  try {
    return await acquireFileLock(credLockPath(io.env), credLockOpts(io.env));
  } catch (e) {
    if (e instanceof FileLockTimeoutError) {
      const who = e.holderPid !== undefined ? `pid ${e.holderPid}` : 'another process';
      throw new CliError(
        `another owenloop process is using the credential store (${who}) — holds ${e.lockPath}; ` +
          `timed out waiting after ${Math.round(e.waitMs / 1000)}s`,
      );
    }
    throw e;
  }
}

// ---- credential store writes -----------------------------------------------

/**
 * Store body WITHOUT the lock — the caller holds it. Private on purpose: the
 * exported `storeCredential` wraps this in the lock, and `refreshOAuth`'s locked
 * section calls this directly (calling the exported wrapper from inside the lock
 * would deadlock — it would poll against its own held lock until `waitMs`).
 *
 * Stores in the chosen backend ONLY; returns which one. A failed keychain write
 * is a hard error (REL-6), never a silent fall-through to the file — the escape
 * hatch is `OWENLOOP_NO_KEYCHAIN=1`. The file backend MERGES into the origin's
 * slot map: writing `agent:ci` must leave a `human` credential for the same
 * origin intact. The external-command backstop throw stays here even though the
 * exported wrapper checks it before locking — an unreachable-but-honest guard.
 */
function storeCredentialUnlocked(
  io: CredentialIO,
  origin: string,
  slot: CredentialSlotSelector,
  cred: Credential,
): 'keychain' | 'file' {
  const account = credentialSlot(slot);
  const backend = credentialBackend(io.env, io.keychain);
  if (backend.kind === 'external') {
    // Writing to a store that reads will never consult is exactly the
    // "half-working setup hands back a stale key" failure the external command
    // exists to prevent, so refuse loudly instead.
    throw new CliError(
      'an external credential command is configured (OWENLOOP_CREDENTIAL_COMMAND), so it — not the ' +
        'local store — supplies credentials for this hub; unset it to use `owenloop login`',
    );
  }
  if (backend.kind === 'keychain') {
    try {
      backend.kc.set(keychainServiceFor(origin), account, JSON.stringify(cred));
    } catch (e) {
      throw new CliError(
        `could not write the credential to the OS keychain: ${(e as Error).message}. ` +
          'Fix the keychain, or set OWENLOOP_NO_KEYCHAIN=1 to use the 0600 file store',
      );
    }
    return 'keychain';
  }
  const path = credentialFilePath(io.env);
  const file = readCredentialFile(path);
  file.hubs[origin] = { ...file.hubs[origin], [account]: cred };
  writeCredentialFile(path, file);
  return 'file';
}

/**
 * Store a credential for `origin` in `slot`, in the chosen backend ONLY;
 * returns which one. Serialized by the credential lock so a plain write from
 * `login` / `agent new` can never interleave with a refresh-and-persist.
 *
 * The external-command refusal runs BEFORE acquiring the lock: in that mode the
 * command (not the local store) is authoritative, so a write is refused with no
 * lockfile/config-dir side effect at all.
 *
 * Async because gaining the lock made it so — acceptable because this function
 * was module-private before this change; the NEW public API is born async.
 */
export async function storeCredential(
  io: CredentialIO,
  origin: string,
  slot: CredentialSlotSelector,
  cred: Credential,
): Promise<'keychain' | 'file'> {
  if (externalCredentialCommand(io.env) !== undefined) {
    throw new CliError(
      'an external credential command is configured (OWENLOOP_CREDENTIAL_COMMAND), so it — not the ' +
        'local store — supplies credentials for this hub; unset it to use `owenloop login`',
    );
  }
  const handle = await acquireCredLock(io);
  try {
    return storeCredentialUnlocked(io, origin, slot, cred);
  } finally {
    releaseFileLock(handle);
  }
}

/**
 * Delete body WITHOUT the lock — the caller holds it. Deletes the stored
 * credential for `(origin, slot)` from BOTH backends (a defensive dual-clear, so
 * a live refresh token can never be stranded in the store that wasn't the
 * currently-chosen one). Returns whether anything was removed. Only the NAMED
 * slot is removed.
 */
function deleteCredentialUnlocked(io: CredentialIO, origin: string, slot: CredentialSlotSelector): boolean {
  const account = credentialSlot(slot);
  let removed = false;
  const kc = resolveKeychain(io.env, io.keychain);
  const service = keychainServiceFor(origin);
  if (kc && kc.get(service, account) !== null) {
    kc.delete(service, account);
    removed = true;
  }
  const path = credentialFilePath(io.env);
  const file = readCredentialFile(path);
  const slots = file.hubs[origin];
  if (slots !== undefined && slots[account] !== undefined) {
    delete slots[account];
    // Drop the origin key once its last slot is gone, so the file never keeps
    // an empty husk that a later read would have to special-case.
    if (Object.keys(slots).length === 0) delete file.hubs[origin];
    writeCredentialFile(path, file);
    removed = true;
  }
  return removed;
}

/**
 * Delete the stored credential for `(origin, slot)` from BOTH backends, under
 * the credential lock so a logout can never interleave with a concurrent
 * refresh-and-persist. Returns whether anything was removed. Async for the same
 * born-with-the-lock reason as `storeCredential`.
 */
export async function deleteCredential(
  io: CredentialIO,
  origin: string,
  slot: CredentialSlotSelector,
): Promise<boolean> {
  const handle = await acquireCredLock(io);
  try {
    return deleteCredentialUnlocked(io, origin, slot);
  } finally {
    releaseFileLock(handle);
  }
}

// ---- HTTP helpers (hub/auth calls) -----------------------------------------

/** The Bearer value for an authenticated request. Never logged. */
export function authHeader(cred: Credential): string {
  return `Bearer ${cred.accessToken}`;
}

// Request deadline for EVERY hub/auth call — OAuth discovery, DCR, code
// exchange, token refresh, whoami, workflow list, and push (REL-7). These are
// all small JSON round-trips, so one budget fits them all;
// OWENLOOP_HUB_TIMEOUT_MS overrides it (a test knob, consistent with
// OWENLOOP_LOGIN_TIMEOUT_MS and the project's other OWENLOOP_* test-only knobs).
const HUB_TIMEOUT_MS = 30_000;

function hubTimeoutMs(io: CredentialIO): number {
  const override = Number(io.env.OWENLOOP_HUB_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : HUB_TIMEOUT_MS;
}

// Cap on any hub/auth JSON RESPONSE body (OAuth discovery, DCR, code exchange,
// token refresh, whoami, the workflow list, create_workflow). Hub responses are
// small round-trips — the largest realistic body is a workflows summary list,
// far below 8 MiB. This is a RESPONSE cap; the hub's 32MB figure (the 413 path)
// is a REQUEST cap and responses never echo YAML. OWENLOOP_HUB_MAX_RESPONSE_BYTES
// overrides it (a test-only knob, consistent with OWENLOOP_HUB_TIMEOUT_MS).
const HUB_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function hubMaxResponseBytes(io: CredentialIO): number {
  const override = Number(io.env.OWENLOOP_HUB_MAX_RESPONSE_BYTES);
  return Number.isFinite(override) && override > 0 ? override : HUB_MAX_RESPONSE_BYTES;
}

/**
 * Read a `Response` body into memory with a hard byte cap, streaming so an
 * oversized body is rejected without first buffering the whole thing. Also used
 * by the `add` tarball/sha fetches in `cli.ts` (which import it back), hence the
 * `export`. `label` names the request in the error and is origin+path or
 * `owner/repo@sha` only — never a token. Counting post-decode bytes (what lands
 * in memory) is deliberate: the cap protects memory, not wire bytes.
 *
 * `res.body === null` (empty/no-body response) yields empty bytes, so callers
 * behave exactly as they did under `arrayBuffer()`. An absent, malformed, or
 * multi-valued `Content-Length` skips the header check — the counting path is
 * the real guard (GitHub codeload tarballs are typically chunked, no header). A
 * `TimeoutError`/`AbortError` from `read()` (the abort signal fired mid-body)
 * propagates untouched, so each call site's existing timeout mapping still
 * fires exactly as it did for `arrayBuffer()` rejections. `cancel()` may reject
 * on an already-errored stream — swallowed; the cap `CliError` is the story.
 */
export async function readBodyBounded(res: Response, cap: number, label: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    throw new CliError(
      `response body for ${label} exceeds the ${cap}-byte cap (declared Content-Length ${declared})`,
    );
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    chunks.push(value);
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new CliError(`response body for ${label} exceeds the ${cap}-byte cap`);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * `fetch` wrapper putting a deadline on every hub/auth call (REL-7). The abort
 * signal is threaded into `fetch` AND the body is read (via `readBodyBounded`,
 * which caps the response size — see HUB_MAX_RESPONSE_BYTES) inside the same
 * try, so the deadline covers a stalled BODY read too — the exact undici
 * behavior the two `add` fetches document (`AbortSignal.timeout` ties the
 * signal to the body stream). The returned `Response` re-exposes the read
 * body, so every call site's `res.json()` / `res.status` /
 * `res.headers.get(...)` usage is byte-for-byte unchanged. A
 * `TimeoutError`/`AbortError` becomes a clear `CliError` (naming the request,
 * which is origin+path only — never a token); anything else is rethrown
 * untouched.
 *
 * `redirect: 'error'` is forced on every call — after the `...init` spread, so
 * no caller can override it — to close the redirect gap `resolveEndpoint`
 * (SEC-4) cannot see: same-origin validation covers only the INITIAL URL, but a
 * validated endpoint answering 307/308 would re-send the POST body (refresh
 * token, PKCE verifier, auth code, workflow YAML) to a foreign origin — undici
 * strips the Authorization header on a cross-origin redirect but RESENDS the
 * body. The hub protocol has no redirects, so any 3xx is a hard, loud failure
 * mapped to a `CliError` (again naming origin+path only, never a token).
 */
export async function hubFetch(io: CredentialIO, url: string, init?: RequestInit): Promise<Response> {
  const fetchFn = io.fetch ?? globalThis.fetch;
  const ms = hubTimeoutMs(io);
  const method = (init?.method ?? 'GET').toUpperCase();
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(ms), redirect: 'error' });
    // 204/304 carry no body — reading one would be a spec violation.
    if (res.status === 204 || res.status === 304) {
      return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    const body = await readBodyBounded(res, hubMaxResponseBytes(io), `${method} ${url}`);
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new CliError(`hub did not respond within ${ms / 1000}s (${method} ${url})`);
    }
    // `redirect: 'error'` makes undici reject a 3xx with a TypeError whose
    // cause message is 'unexpected redirect' (verified on Node 22.22.3 and 26).
    // Substring-match for slack against undici wording drift — if it ever stops
    // matching, the raw TypeError still surfaces (fail-closed, just less pretty).
    const cause = String((err as { cause?: { message?: string } }).cause?.message ?? '');
    if (err.name === 'TypeError' && cause.includes('unexpected redirect')) {
      throw new CliError(
        `hub responded with a redirect — refusing to follow it (${method} ${url}); redirects are not part of the hub protocol`,
      );
    }
    throw e;
  }
}

interface AsMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
}

export async function discoverMetadata(io: CredentialIO, origin: string): Promise<AsMetadata> {
  const res = await hubFetch(io, resolveEndpoint(origin, '/.well-known/oauth-authorization-server'), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new CliError(`could not read OAuth metadata from ${origin} (HTTP ${res.status})`);
  }
  return (await res.json()) as AsMetadata;
}

export async function discoverTokenEndpoint(io: CredentialIO, origin: string): Promise<string> {
  const meta = await discoverMetadata(io, origin);
  if (!meta.token_endpoint) throw new CliError(`hub ${origin} advertises no token_endpoint`);
  return resolveEndpoint(origin, meta.token_endpoint);
}

// ---- OAuth refresh ---------------------------------------------------------

/**
 * Ensure an `oauth` credential's access token is fresh: if it expires within
 * 60s, refresh once (grant_type=refresh_token) and persist the new token. No-op
 * for `agent`/`oauth-pasted` credentials (they don't refresh). Returns the
 * possibly-updated credential.
 *
 * The `expiresAt - nowMs() > FRESH_WINDOW_MS` fast path is the cheap first check
 * of a double-checked pattern: it returns WITHOUT locking; the re-read under the
 * lock inside `refreshOAuth` is the second check.
 *
 * `slot` is the slot the credential was READ from — a refreshed token must be
 * written back to that same slot, never to a default one.
 */
export async function ensureFreshOAuth(
  io: CredentialIO,
  origin: string,
  slot: CredentialSlotSelector,
  cred: Credential,
  persist = true,
): Promise<Credential> {
  if (cred.kind !== 'oauth') return cred;
  if (cred.expiresAt - nowMs() > FRESH_WINDOW_MS) return cred;
  return refreshOAuth(io, origin, slot, cred, persist);
}

/**
 * Perform ONE HTTP refresh (grant_type=refresh_token) using `input` and return
 * the freshly minted oauth credential. Does NOT touch the store or the lock —
 * the caller decides whether/where to persist. A rotating refresh token echoes
 * the new one; a server that omits it keeps `input.refreshToken`.
 */
async function performRefresh(
  io: CredentialIO,
  origin: string,
  input: Extract<Credential, { kind: 'oauth' }>,
): Promise<Extract<Credential, { kind: 'oauth' }>> {
  const tokenEndpoint = await discoverTokenEndpoint(io, origin);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  });
  const res = await hubFetch(io, tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new CliError('credential expired and refresh failed — run `owenloop login`');
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (typeof json.access_token !== 'string') {
    throw new CliError('credential expired and refresh returned no access token — run `owenloop login`');
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  return {
    kind: 'oauth',
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : input.refreshToken,
    expiresAt: nowMs() + expiresIn * 1000,
    clientId: input.clientId,
  };
}

/**
 * Refresh an `oauth` credential's access token.
 *
 * `persist` defaults to true — the normal case is refreshing an ALREADY stored,
 * trusted credential (push/connect), where persisting immediately matters
 * because refresh tokens can be single-use/rotating: losing the new one to a
 * later crash would strand the user. `verifyCredential`'s login-time use passes
 * `persist: false` — a not-yet-stored credential must never be written to
 * disk/keychain before it is proven to work end to end.
 *
 * Two paths:
 *
 * - **Unlocked** (`persist: false`, i.e. login-time verify; OR an external
 *   credential command is configured): byte-for-byte the pre-lock behavior —
 *   refresh over HTTP, do NOT touch the store, do NOT lock, do NOT adopt.
 *   `persist: false` must never adopt a stored credential: the caller is
 *   verifying a specific not-yet-stored token, and handing back some other slot
 *   occupant would verify the WRONG credential. In external-command mode
 *   owenloop owns none of the credential lifecycle, so it neither locks nor
 *   persists (matching the old `persist && externalCredentialCommand ===
 *   undefined` gate).
 *
 * - **Locked** (`persist: true` and no external command): acquire the credential
 *   lock, RE-READ the slot, then decide:
 *     * stored is oauth AND its accessToken differs from ours AND it is fresh
 *       (> `FRESH_WINDOW_MS` from expiry) → another process already refreshed;
 *       adopt its credential with ZERO network calls and ZERO writes.
 *     * stored is oauth AND differs from ours but is NOT fresh → refresh using
 *       STORED as input (its refreshToken is the newest link in the rotation
 *       chain; ours is provably older), persist, return.
 *     * otherwise (stored same token, absent, or non-oauth) → refresh using
 *       `cred`, persist, return.
 *   Release the lock in `finally`.
 *
 * The `accessToken !== cred.accessToken` guard (not freshness alone) exists
 * because `authedGet` calls this on a 401 with a token that may not be near
 * expiry: freshness-only adoption would hand the caller back its own
 * just-rejected token and turn a recoverable 401 into a hard failure.
 * Token-differs ⇒ someone else moved the chain; token-same ⇒ we are first,
 * refresh for real. The locked-section persist calls `storeCredentialUnlocked`
 * (not the exported wrapper) — it already holds the lock.
 */
export async function refreshOAuth(
  io: CredentialIO,
  origin: string,
  slot: CredentialSlotSelector,
  cred: Extract<Credential, { kind: 'oauth' }>,
  persist = true,
): Promise<Credential> {
  // Unlocked path: never touch the store, never lock, never adopt.
  if (!persist || externalCredentialCommand(io.env) !== undefined) {
    return performRefresh(io, origin, cred);
  }
  // Locked path: acquire → re-read → adopt-or-refresh → persist → release.
  const handle = await acquireCredLock(io);
  try {
    const stored = readStoredCredential(origin, { ...slot, env: io.env, keychain: io.keychain });
    if (stored && stored.kind === 'oauth' && stored.accessToken !== cred.accessToken) {
      // Another process moved the rotation chain since we read `cred`.
      if (stored.expiresAt - nowMs() > FRESH_WINDOW_MS) {
        // Already fresh — adopt it. Return the STORED object (its rotated
        // refreshToken included) with zero network and zero writes.
        return stored;
      }
      // Differs but not fresh — refresh using STORED (the newer refresh token).
      const refreshed = await performRefresh(io, origin, stored);
      storeCredentialUnlocked(io, origin, slot, refreshed);
      return refreshed;
    }
    // Stored same token, absent, or non-oauth → we are first: refresh using ours.
    const refreshed = await performRefresh(io, origin, cred);
    storeCredentialUnlocked(io, origin, slot, refreshed);
    return refreshed;
  } finally {
    releaseFileLock(handle);
  }
}

// ---- agent minting ---------------------------------------------------------

/**
 * The result of `mintAgentCredential`. Deliberately carries NO token field —
 * only non-secret handles the caller may print. The minted `olp_` plaintext is
 * written to the credential store inside `mintAgentCredential` and never leaves
 * it, so no caller can leak what it never received (§6 "rule of gates").
 */
export interface MintAgentResult {
  /** Token id — a non-secret revocation handle. */
  id: string;
  /** The minted agent's id — a non-secret handle. */
  agentId: string;
  /** Resolved pool NAMES from the server. */
  pools: string[];
  /** Which local backend the token landed in. */
  storage: 'keychain' | 'file';
}

/**
 * Mint a new agent identity on `origin` as the human `cred` and persist the
 * returned `olp_` token to slot `agent:<name>`. CLI-free (no `Args`, no exit
 * codes — the caller maps failures to exit codes) so both `owenloop agent new`
 * (O3) and `owenloop mcp`'s `create_agent` (O2) can reuse it.
 *
 * **The token NEVER leaves this function.** It flows exactly one hop —
 * `asMintAgentTokenOk(body).token` → `storeCredential` — and is never returned,
 * thrown, logged, or embedded in any message (identity model §6). The returned
 * `MintAgentResult` structurally omits it. The hub's 4xx `message` (e.g. H1's
 * `agent name already taken: "…"`) is surfaced verbatim via `CliError`; a
 * malformed 2xx names the offending FIELD only, never a value.
 *
 * Order is load-bearing (PR #69 lesson): the client-side name check and the
 * external-command refusal both run BEFORE any network call. Refusing only at
 * `storeCredential` time would mint a server-side token that can never be stored
 * locally — permanently burning the agent name (re-running refuses "taken").
 *
 * @param humanSlot the slot `cred` was read from (always `{principal:'human'}`
 *   today; explicit for symmetry with the store/refresh signatures).
 * @param params.scopes defaults to `['work']` — the H3 route REQUIRES a
 *   non-empty `scopes`; an empty list is server-refused.
 * @param params.pools omitted when absent so the server defaults to the minter's
 *   personal pool (`pools: []` is server-refused with `pool_invalid`).
 */
export async function mintAgentCredential(
  io: CredentialIO,
  origin: string,
  humanSlot: CredentialSlotSelector,
  cred: Credential,
  params: { name: string; pools?: string[]; scopes?: string[] },
): Promise<MintAgentResult> {
  // 1. Validate the agent name before any I/O. The client regex is byte-identical
  //    to the server's, so this can never mask a server-side "invalid name" —
  //    only "taken" is left to the server. Throws on an invalid name.
  credentialSlot({ principal: 'agent', account: params.name });

  // 2. Refuse an external-command setup BEFORE the network call. In that mode the
  //    command — not the local store — is authoritative, so a minted token could
  //    never be stored; minting first would burn the name. Same wording as
  //    `storeCredential`'s refusal.
  if (externalCredentialCommand(io.env) !== undefined) {
    throw new CliError(
      'an external credential command is configured (OWENLOOP_CREDENTIAL_COMMAND), so it — not the ' +
        'local store — supplies credentials for this hub; unset it to use `owenloop login`',
    );
  }

  // 3. Freshen the human oauth bearer (persist=true: a rotated refresh token must
  //    land in the store). No-op for oauth-pasted / agent kinds.
  let current = await ensureFreshOAuth(io, origin, humanSlot, cred);

  const scopes = params.scopes ?? ['work'];
  const doPost = (bearer: Credential): Promise<Response> =>
    hubFetch(io, resolveEndpoint(origin, '/api/mint_agent_token'), {
      method: 'POST',
      headers: {
        Authorization: authHeader(bearer),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      // `pools` omitted entirely when absent (server default = personal pool);
      // never sent as `[]` (server-refused).
      body: JSON.stringify({
        name: params.name,
        scopes,
        ...(params.pools !== undefined ? { pools: params.pools } : {}),
      }),
    });

  // 4 + 5. POST; on a 401 with an oauth credential, refresh once and retry once —
  //         the exact `authedGet`/`dispatchPush` pattern.
  let res = await doPost(current);
  if (res.status === 401 && current.kind === 'oauth') {
    current = await refreshOAuth(io, origin, humanSlot, current as Extract<Credential, { kind: 'oauth' }>);
    res = await doPost(current);
  }
  if (res.status === 401) {
    // A second 401 (or a non-oauth credential the hub rejected) is a hard
    // "credential rejected" — the human slot never holds an agent kind, so the
    // agent-token wording cannot apply here.
    throw new CliError('credential rejected by the hub — run `owenloop login`');
  }

  // 6. Any other non-2xx: surface the hub's typed `message` VERBATIM (this is how
  //    H1's `agent name already taken: "…"`, `pool_invalid`, `bad_request`, and
  //    `forbidden` all surface uniformly). Never include raw body text.
  if (!res.ok) {
    let message: string | undefined;
    try {
      const errBody = (await res.json()) as unknown;
      if (typeof errBody === 'object' && errBody !== null) {
        const m = (errBody as Record<string, unknown>).message;
        if (typeof m === 'string' && m !== '') message = m;
      }
    } catch {
      // Non-JSON body — fall through to the generic status message.
    }
    throw new CliError(message ?? `hub ${origin} rejected the mint (HTTP ${res.status})`);
  }

  // 7. Narrow the 2xx body through the whitelisting guard. A malformed body could
  //    still carry the plaintext in `text`, so the guard's message names the
  //    FIELD only — rewrapped as a CliError to carry it verbatim.
  //    `res.json()` itself is wrapped too: on a 200 whose body is NOT valid JSON,
  //    V8's SyntaxError message embeds a verbatim snippet of the raw body — which
  //    on THIS endpoint is the plaintext token. The thrown CliError message is a
  //    FIXED string (never the parse-error message) so no body text can leak (§6).
  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    throw new CliError('mint_agent_token: malformed success response — body is not valid JSON');
  }
  let ok;
  try {
    ok = asMintAgentTokenOk(body);
  } catch (e) {
    throw new CliError((e as Error).message);
  }

  // 8. Store the token — its only hop out of this function. On a keychain write
  //    failure the token was ALREADY minted server-side and is now unrecoverable
  //    locally; report that honestly. NEVER print the token as a fallback (§6).
  let storage: 'keychain' | 'file';
  try {
    storage = await storeCredential(
      io,
      origin,
      { principal: 'agent', account: params.name },
      { kind: 'agent', accessToken: ok.token },
    );
  } catch (e) {
    throw new CliError(
      `the agent token was minted but could not be stored locally: ${(e as Error).message}. ` +
        `The agent '${params.name}' now exists on the hub — recover via the console (Reconnect/re-key) ` +
        `once storage works; re-running \`agent new ${params.name}\` will refuse the taken name`,
    );
  }

  // 9. Return non-secret handles only — no token field exists to leak.
  return { id: ok.id, agentId: ok.agentId, pools: ok.pools, storage };
}

/**
 * The result of `rekeyAgentCredential`. Like `MintAgentResult`, carries NO token
 * field — only non-secret handles the caller may print. The new `olp_` plaintext
 * is written to the store inside `rekeyAgentCredential` and never leaves it.
 *
 * `revokedTokenIds` are the ids the rekey invalidated server-side — the OLD
 * installation's credential(s). Their presence is the honest signal that any
 * still-running copy of this agent elsewhere is now disconnected. No `pools`
 * field: rekey changes no pool membership.
 */
export interface RekeyAgentResult {
  /** New token id — a non-secret revocation handle. */
  id: string;
  /** The rekeyed agent's id — a non-secret handle. */
  agentId: string;
  /** Ids of the tokens this rekey revoked (the old installation's). */
  revokedTokenIds: string[];
  /** The new token's scopes. */
  scopes: string[];
  /** Which local backend the new token landed in. */
  storage: 'keychain' | 'file';
}

/**
 * Re-key an EXISTING agent identity on `origin` as the human `cred`: the hub
 * mints a fresh `olp_` token for `agentId`, REVOKES the identity's current
 * token(s), and this function persists the new token into the SAME
 * `agent:<name>` slot — overwriting the old one. Sibling of
 * `mintAgentCredential` with the identical §6 discipline; the only shape
 * differences are the endpoint (`/api/rekey_agent_token`), the request body
 * (`{agentId}` — no name/scopes/pools; rekey preserves pools), and the response
 * guard (`asRekeyAgentTokenOk` — no `pools` field).
 *
 * **The token NEVER leaves this function.** It flows exactly one hop —
 * `asRekeyAgentTokenOk(body).token` → `storeCredential` — and is never returned,
 * thrown, logged, or embedded in any message. The returned `RekeyAgentResult`
 * structurally omits it.
 *
 * **Irreversibility (why the caller must gate this behind a hard auth step):**
 * a successful rekey has ALREADY revoked the old token server-side by the time
 * this function returns. If the local `storeCredential` then fails, the old
 * installation is disconnected AND the new token is unrecoverable locally — the
 * error says exactly that and points at console Reconnect; it never prints the
 * token as a fallback.
 *
 * @param humanSlot the slot `cred` was read from (always `{principal:'human'}`).
 * @param params.agentId the identity to rekey (resolved by the caller from the
 *   `agent_identities` listing by NAME — names are org-unique).
 * @param params.name the agent account name — the local slot `agent:<name>` the
 *   new token is written to. Validated before any I/O.
 */
export async function rekeyAgentCredential(
  io: CredentialIO,
  origin: string,
  humanSlot: CredentialSlotSelector,
  cred: Credential,
  params: { agentId: string; name: string },
): Promise<RekeyAgentResult> {
  // 1. Validate the agent name (the local slot target) before any I/O — same
  //    byte-identical client regex as mint.
  credentialSlot({ principal: 'agent', account: params.name });

  // 2. Refuse an external-command setup BEFORE the network call — same reason as
  //    mint: the rekey would revoke the old token server-side, but the new one
  //    could never be stored, stranding the install.
  if (externalCredentialCommand(io.env) !== undefined) {
    throw new CliError(
      'an external credential command is configured (OWENLOOP_CREDENTIAL_COMMAND), so it — not the ' +
        'local store — supplies credentials for this hub; unset it to use `owenloop login`',
    );
  }

  // 3. Freshen the human oauth bearer (persist=true). No-op for non-oauth kinds.
  let current = await ensureFreshOAuth(io, origin, humanSlot, cred);

  const doPost = (bearer: Credential): Promise<Response> =>
    hubFetch(io, resolveEndpoint(origin, '/api/rekey_agent_token'), {
      method: 'POST',
      headers: {
        Authorization: authHeader(bearer),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ agentId: params.agentId }),
    });

  // 4 + 5. POST; on a 401 with an oauth credential, refresh once and retry once.
  let res = await doPost(current);
  if (res.status === 401 && current.kind === 'oauth') {
    current = await refreshOAuth(io, origin, humanSlot, current as Extract<Credential, { kind: 'oauth' }>);
    res = await doPost(current);
  }
  if (res.status === 401) {
    throw new CliError('credential rejected by the hub — run `owenloop login`');
  }

  // 6. Any other non-2xx: surface the hub's typed `message` VERBATIM (e.g. an
  //    unknown agentId, or a `forbidden` for a non-admin human). Never raw body.
  if (!res.ok) {
    let message: string | undefined;
    try {
      const errBody = (await res.json()) as unknown;
      if (typeof errBody === 'object' && errBody !== null) {
        const m = (errBody as Record<string, unknown>).message;
        if (typeof m === 'string' && m !== '') message = m;
      }
    } catch {
      // Non-JSON body — fall through to the generic status message.
    }
    throw new CliError(message ?? `hub ${origin} rejected the rekey (HTTP ${res.status})`);
  }

  // 7. Narrow the 2xx body. Same double-wrap as mint: the raw body carries the
  //    plaintext in `text`, and V8's SyntaxError embeds body snippets, so BOTH
  //    the JSON-parse failure and the guard failure throw FIXED/field-only
  //    strings — never body text.
  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    throw new CliError('rekey_agent_token: malformed success response — body is not valid JSON');
  }
  let ok;
  try {
    ok = asRekeyAgentTokenOk(body);
  } catch (e) {
    throw new CliError((e as Error).message);
  }

  // 8. Store the new token — its only hop. On a store failure the old token is
  //    ALREADY revoked server-side (the previous installation is disconnected)
  //    and the new one is now unrecoverable locally; say so honestly and point
  //    at console Reconnect. NEVER print the token as a fallback (§6).
  let storage: 'keychain' | 'file';
  try {
    storage = await storeCredential(
      io,
      origin,
      { principal: 'agent', account: params.name },
      { kind: 'agent', accessToken: ok.token },
    );
  } catch (e) {
    throw new CliError(
      `the agent token was re-keyed but the new token could not be stored locally: ${(e as Error).message}. ` +
        `The old token for '${params.name}' is already revoked (any other running copy is now disconnected); ` +
        `recover via the console (Reconnect) — the new token cannot be recovered from here`,
    );
  }

  // 9. Return non-secret handles only — no token field exists to leak.
  return { id: ok.id, agentId: ok.agentId, revokedTokenIds: ok.revokedTokenIds, scopes: ok.scopes, storage };
}
