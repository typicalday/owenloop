/**
 * Pure, unit-testable helpers for the hub-onboarding CLI verbs (`owenloop
 * login` / `connect` / `push` / `logout`) — the client half of connecting the
 * open-source engine to the hosted control plane.
 *
 * Same split as `src/add.ts`: the network-free, filesystem-adjacent pieces live
 * here (origin normalization, PKCE, credential + project-binding (de)serialization
 * with strict file-mode enforcement, push-diff computation, API-response shape
 * guards); the async network + arg glue lives in `src/cli.ts` (`dispatchLogin`
 * etc.) so this module stays trivially testable and `cli.ts` doesn't widen its
 * export surface.
 *
 * Secret hygiene is a hard rule here: credentials never land in the repo or a
 * plaintext `.env`. The file fallback below is mode 0600 (dir 0700) and lives
 * under the user's config dir, never the project; all paths derive from the
 * caller-supplied `env` (HOME / XDG_CONFIG_HOME), never `process.env` directly,
 * so tests fixture `$HOME` and never touch ambient machine state.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---- origin normalization ----------------------------------------------------

/**
 * Normalize a hub URL to a bare origin (`scheme://host[:port]`), stripping any
 * path, query, trailing slash, and fragment. Requires an http(s) scheme. This
 * is the credential-store key and the project binding value, so it must be
 * canonical: `https://api.owenloop.com/` and `https://api.owenloop.com/foo`
 * both key to `https://api.owenloop.com`.
 */
export function normalizeOrigin(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('hub url is empty');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`invalid hub url '${input}' — expected an http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`invalid hub url '${input}' — must be http or https, got '${url.protocol}'`);
  }
  return url.origin;
}

/** Join an origin and an endpoint that may be absolute or a root-relative path. */
export function resolveEndpoint(origin: string, endpoint: string): string {
  return new URL(endpoint, `${origin}/`).toString();
}

// ---- PKCE (RFC 7636) + state -------------------------------------------------

/** URL-safe base64 with no padding (RFC 7636 §A). */
export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/**
 * Generate a PKCE verifier/challenge pair for the S256 method. The verifier is
 * 32 random bytes base64url-encoded (43 chars — within the RFC's 43..128 range
 * and drawn from the unreserved charset); the challenge is
 * base64url(sha256(verifier)).
 */
export function pkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** A random anti-CSRF `state` token for the authorization request. */
export function randomState(): string {
  return base64url(randomBytes(16));
}

// ---- credential storage ------------------------------------------------------

/**
 * Stored per hub origin. Never logged or echoed. `oauth` carries a refreshable
 * pair (loopback flow); `agent` is a pasted `olp_` token and `oauth-pasted` a
 * pasted `mcpat_` access token — neither refreshes.
 */
export type Credential =
  | { kind: 'oauth'; accessToken: string; refreshToken: string; expiresAt: number; clientId: string }
  | { kind: 'agent'; accessToken: string }
  | { kind: 'oauth-pasted'; accessToken: string };

export interface CredentialFile {
  version: 1;
  hubs: Record<string, Credential>;
}

/** The user-level config dir (never the project dir). Derives from the caller's env. */
export function configDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== '') return join(xdg, 'owenloop');
  const home = env.HOME;
  if (home && home.trim() !== '') return join(home, '.config', 'owenloop');
  throw new Error('cannot locate a config directory: set HOME or XDG_CONFIG_HOME');
}

export function credentialFilePath(env: Record<string, string | undefined>): string {
  return join(configDir(env), 'credentials.json');
}

/** Read the credential file; a missing file is an empty store, not an error. */
export function readCredentialFile(path: string): CredentialFile {
  if (!existsSync(path)) return { version: 1, hubs: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CredentialFile;
  if (!parsed || typeof parsed !== 'object' || typeof parsed.hubs !== 'object') {
    throw new Error(`malformed credential file at ${path}`);
  }
  return { version: 1, hubs: parsed.hubs };
}

/**
 * Write the credential file with strict permissions: dir 0700, file 0600,
 * re-`chmod`'d on every write (a prior lax umask must never leave the secret
 * world-readable).
 */
export function writeCredentialFile(path: string, file: CredentialFile): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// ---- project → hub binding (.owenloop/hub.json) ------------------------------

export interface PushedEntry {
  localHash: string;
  remoteVersion: number;
  remoteHash: string;
  pushedAt: number;
}

/**
 * `.owenloop/hub.json` — written by `connect`, updated by `push`. Safe to
 * commit: contains no secrets, only the bound hub origin and per-def push state
 * (the client-side idempotency ledger).
 */
export interface HubBinding {
  version: 1;
  hub: string;
  pushed: Record<string, PushedEntry>;
}

export function hubBindingPath(cwd: string): string {
  return join(cwd, '.owenloop', 'hub.json');
}

/** Read `.owenloop/hub.json`; a missing file is `null` (project not bound yet). */
export function readHubBinding(path: string): HubBinding | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as HubBinding;
  if (!parsed || typeof parsed.hub !== 'string') {
    throw new Error(`malformed hub binding at ${path}`);
  }
  return { version: 1, hub: parsed.hub, pushed: parsed.pushed ?? {} };
}

export function writeHubBinding(path: string, binding: HubBinding): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(binding, null, 2)}\n`);
}

// ---- push diff ---------------------------------------------------------------

/**
 * A local def selected for a push, with its content hash and raw source yaml.
 * `legacyHash` (optional) is the old checkout-specific `hashDef` value, kept
 * alongside the portable `hash` (`hashDefContent`) so `computePushDiff` can
 * recognize a def pushed under the pre-portability ledger format as unchanged
 * and migrate it in place, instead of forcing one spurious re-push per
 * checkout that happens to have a different absolute path.
 */
export interface DefPushCandidate {
  name: string;
  hash: string;
  legacyHash?: string;
  yaml: string;
}

export interface PushDiff<T extends { name: string; hash: string; legacyHash?: string }> {
  toPush: T[];
  unchanged: T[];
  /** Subset of `unchanged` matched only via `legacyHash` — the ledger entry for
   *  these needs its `localHash` rewritten to the portable hash (see
   *  `dispatchPush`'s migration write), even though no push is needed. */
  migrated: T[];
}

/**
 * Partition selected defs into those that need pushing vs. those already
 * up-to-date, purely from local state (`pushed`): a def whose current
 * `hashDef` equals its recorded `localHash` is unchanged (skip); a new or
 * changed hash is pushed. `force` pushes everything regardless.
 *
 * A def whose portable `hash` doesn't match the recorded `localHash` but whose
 * `legacyHash` (the old checkout-specific hash) does is ALSO unchanged — it's
 * the same content, just recorded under the pre-portability ledger format —
 * and is additionally reported in `migrated` so the caller can rewrite the
 * ledger entry to the portable hash without a network round-trip.
 *
 * This is the client-side idempotency the service can't give us: its
 * `create_workflow` always mints a new version even for byte-identical yaml, so
 * "re-push with no changes is a no-op" has to be decided here, before any
 * network write.
 */
export function computePushDiff<T extends { name: string; hash: string; legacyHash?: string }>(
  defs: T[],
  pushed: Record<string, PushedEntry>,
  force: boolean,
): PushDiff<T> {
  const toPush: T[] = [];
  const unchanged: T[] = [];
  const migrated: T[] = [];
  for (const d of defs) {
    const prior = pushed[d.name];
    if (!force && prior && prior.localHash === d.hash) {
      unchanged.push(d);
    } else if (!force && prior && d.legacyHash !== undefined && prior.localHash === d.legacyHash) {
      unchanged.push(d);
      migrated.push(d);
    } else {
      toPush.push(d);
    }
  }
  return { toPush, unchanged, migrated };
}

// ---- API response shape guards ----------------------------------------------

/** Success shape of `POST /api/create_workflow`. */
export interface CreateWorkflowOk {
  ok: true;
  name: string;
  version: number;
  hash: string;
}

/**
 * `POST /api/create_workflow` returns HTTP 200 with `{ok:false,error}` on a
 * def-parse failure (engine-version skew is the realistic cause) — so a 200 is
 * NOT sufficient; the body's `ok` must be inspected. Returns the parsed error
 * text (verbatim) when the reply is a failure, or `null` when it is a success.
 */
export function createWorkflowError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return 'unexpected response shape (not an object)';
  const b = body as Record<string, unknown>;
  if (b.ok === true) return null;
  const err = typeof b.error === 'string' ? b.error : 'unknown error';
  return err;
}

/** Narrow a create_workflow success body to its typed shape (after `createWorkflowError` returns null). */
export function asCreateWorkflowOk(body: unknown): CreateWorkflowOk {
  const b = body as Record<string, unknown>;
  return {
    ok: true,
    name: typeof b.name === 'string' ? b.name : '',
    version: typeof b.version === 'number' ? b.version : 0,
    hash: typeof b.hash === 'string' ? b.hash : '',
  };
}
