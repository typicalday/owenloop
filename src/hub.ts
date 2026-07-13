/**
 * Pure, unit-testable helpers for the hub-onboarding CLI verbs (`owenloop
 * login` / `connect` / `push` / `logout`) — the client half of connecting the
 * open-source engine to the hosted control plane.
 *
 * Same split as `src/add.ts`: the network-free, filesystem-adjacent pieces live
 * here (origin normalization, PKCE, credential + project-binding (de)serialization
 * with strict file-mode enforcement, server-diff computation, API-response shape
 * guards); the async network + arg glue lives in `src/cli.ts` (`dispatchLogin`
 * etc.) so this module stays trivially testable and `cli.ts` doesn't widen its
 * export surface.
 *
 * `.owenloop/hub.json` is a pure binding (which hub this project publishes to)
 * — there is no client-side push ledger. `push` diffs local defs against the
 * server's own `hash` (`GET /api/workflows`, see `computeServerDiff`), and
 * `POST /api/create_workflow` is idempotent, so the server is always the
 * source of truth for "did this change" — a client-side cache would just be a
 * second copy of that truth that can go stale.
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

/**
 * `.owenloop/hub.json` — written by `connect`. Safe to commit: contains no
 * secrets, only the bound hub origin. Purely a binding — `push` diffs against
 * server truth (`GET /api/workflows`), so there is no client-side ledger to
 * carry here.
 */
export interface HubBinding {
  version: 1;
  hub: string;
}

export function hubBindingPath(cwd: string): string {
  return join(cwd, '.owenloop', 'hub.json');
}

/**
 * Read `.owenloop/hub.json`; a missing file is `null` (project not bound
 * yet). A file written by a pre-server-diff CLI may still carry a `pushed`
 * key (the old push ledger) — it parses fine and the key is silently
 * ignored; the next `connect` rewrite drops it.
 */
export function readHubBinding(path: string): HubBinding | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as HubBinding;
  if (!parsed || typeof parsed.hub !== 'string') {
    throw new Error(`malformed hub binding at ${path}`);
  }
  return { version: 1, hub: parsed.hub };
}

export function writeHubBinding(path: string, binding: HubBinding): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(binding, null, 2)}\n`);
}

// ---- push candidates + server diff --------------------------------------------

/** A local def selected for a push, with its server-canonical content hash and raw source yaml. */
export interface DefPushCandidate {
  name: string;
  hash: string;
  yaml: string;
}

/** One entry from `GET /api/workflows`'s `workflows` array. */
export interface WorkflowSummary {
  name: string;
  hash: string;
  version?: number;
}

export interface ServerDiff<T extends { name: string; hash: string }> {
  toPush: (T & { status: 'new' | 'changed' })[];
  unchanged: T[];
}

/**
 * Partition selected defs into those that need pushing vs. those already
 * up-to-date, purely from the server's own `hash` for each name (from
 * `GET /api/workflows`, via `parseWorkflowList`): a name absent from the
 * server is `new`; present with a different (or missing) hash is `changed`;
 * present with an equal hash is `unchanged` (skipped — no request sent).
 *
 * `force` pushes every candidate regardless of hash — labeled `new` when the
 * server has no entry for it, `changed` otherwise (even when the hash is
 * equal: force means "send it", and the label should still read true).
 *
 * Server names with no local counterpart are ignored (this is a push, not a
 * sync — the CLI never deletes or reports on hub-only defs).
 */
export function computeServerDiff<T extends { name: string; hash: string }>(
  candidates: T[],
  server: Map<string, WorkflowSummary>,
  force: boolean,
): ServerDiff<T> {
  const toPush: (T & { status: 'new' | 'changed' })[] = [];
  const unchanged: T[] = [];
  for (const c of candidates) {
    const remote = server.get(c.name);
    const status: 'new' | 'changed' = remote === undefined ? 'new' : 'changed';
    if (force) {
      toPush.push({ ...c, status });
    } else if (remote === undefined) {
      toPush.push({ ...c, status: 'new' });
    } else if (remote.hash !== c.hash) {
      toPush.push({ ...c, status: 'changed' });
    } else {
      unchanged.push(c);
    }
  }
  return { toPush, unchanged };
}

// ---- API response shape guards ----------------------------------------------

/** Success shape of `POST /api/create_workflow`. */
export interface CreateWorkflowOk {
  ok: true;
  name: string;
  version: number;
  hash: string;
  /** `true` when the posted content's hash equals the latest stored version
   *  (server-side idempotent no-op) — no new version was minted. */
  unchanged?: boolean;
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
  const out: CreateWorkflowOk = {
    ok: true,
    name: typeof b.name === 'string' ? b.name : '',
    version: typeof b.version === 'number' ? b.version : 0,
    hash: typeof b.hash === 'string' ? b.hash : '',
  };
  if (b.unchanged === true) out.unchanged = true;
  return out;
}

/**
 * Identity returned by `GET /api/whoami` (bearer auth, no RBAC verb — a 200
 * proves the credential authenticates, not that it carries any particular
 * scope; `tokenStatus` is always `'active'` over the wire because a
 * revoked/unknown/disabled credential 401s in auth middleware before the
 * handler runs, so it is deliberately not carried here — branch on the HTTP
 * status, never on a `tokenStatus` field).
 */
export interface WhoamiIdentity {
  orgId: string;
  orgName: string;
  actor: { id: string; kind: string; role: string };
  authMethod: string;
  email?: string;
}

/** Narrow a `GET /api/whoami` 200 body to its typed shape. Throws on a malformed body. */
export function asWhoami(body: unknown): WhoamiIdentity {
  if (typeof body !== 'object' || body === null) throw new Error('whoami: unexpected response shape (not an object)');
  const b = body as Record<string, unknown>;
  if (typeof b.orgId !== 'string') throw new Error('whoami: response missing string orgId');
  const rawActor = (typeof b.actor === 'object' && b.actor !== null ? b.actor : {}) as Record<string, unknown>;
  const identity: WhoamiIdentity = {
    orgId: b.orgId,
    orgName: typeof b.orgName === 'string' ? b.orgName : '',
    actor: {
      id: typeof rawActor.id === 'string' ? rawActor.id : '',
      kind: typeof rawActor.kind === 'string' ? rawActor.kind : '',
      role: typeof rawActor.role === 'string' ? rawActor.role : '',
    },
    authMethod: typeof b.authMethod === 'string' ? b.authMethod : '',
  };
  if (typeof b.email === 'string') identity.email = b.email;
  return identity;
}

/**
 * Parse `GET /api/workflows`'s body into a `name -> WorkflowSummary` map for
 * `computeServerDiff`. Throws a descriptive error (the caller wraps it in a
 * `CliError`) on a missing/malformed `workflows` array.
 */
export function parseWorkflowList(body: unknown): Map<string, WorkflowSummary> {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as Record<string, unknown>).workflows)) {
    throw new Error('malformed response from the hub: expected a `workflows` array');
  }
  const list = (body as Record<string, unknown>).workflows as unknown[];
  const out = new Map<string, WorkflowSummary>();
  list.forEach((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`malformed response from the hub: workflows[${i}] is not an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string') {
      throw new Error(`malformed response from the hub: workflows[${i}] missing string name`);
    }
    const summary: WorkflowSummary = {
      name: e.name,
      hash: typeof e.hash === 'string' ? e.hash : '',
    };
    if (typeof e.version === 'number') summary.version = e.version;
    out.set(e.name, summary);
  });
  return out;
}
