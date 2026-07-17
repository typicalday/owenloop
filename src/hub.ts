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
 * The keychain backend selection and the read side of credential storage also
 * live here (`defaultKeychain` / `resolveKeychain` / `credentialBackend` /
 * `readStoredCredential`): the `security` shell-out is synchronous and
 * injectable, so it stays consistent with this module's network-free, testable
 * charter, and it lets the public barrel (`src/index.ts`) export a supported
 * read-only `readStoredCredential` without pulling in `cli.ts` (which the
 * core/hub boundary lint forbids). `cli.ts` keeps thin wrappers so there is one
 * implementation of backend selection, not two.
 *
 * `.owenloop/hub.json` is a pure binding (which hub this project publishes to)
 * — there is no client-side push ledger. `push` diffs local defs against the
 * server's own `hash` (`GET /api/workflows`, see `computeServerDiff`), and
 * `POST /api/create_workflow` is idempotent, so the server is always the
 * source of truth for "did this change" — a client-side cache would just be a
 * second copy of that truth that can go stale.
 *
 * Secret hygiene is a hard rule here: credentials never land in the repo or a
 * plaintext `.env`. The 0600 file backend below (dir 0700) lives under the
 * user's config dir, never the project; all paths derive from the
 * caller-supplied `env` (HOME / XDG_CONFIG_HOME), never `process.env` directly,
 * so tests fixture `$HOME` and never touch ambient machine state. Both this
 * file and `.owenloop/hub.json` are written via `writeFileAtomic` — temp file
 * in the same dir + rename, refusing a symlinked destination (SEC-3). The
 * parent-directory half of that guard is `mkdirRefusingSymlink` (in `util.ts`,
 * so the core store factory can share it without core depending on this hub
 * module): before creating the project `.owenloop` dir we refuse a symlinked
 * `.owenloop` component, so a hostile checkout shipping `.owenloop -> /elsewhere`
 * cannot redirect the write outside the project even though the final file
 * itself is not (yet) a symlink.
 *
 * The server-parity def content hash (`hashDefForHub`) also lives here: it is a
 * hub-facing concern (reproducing owenloop-service's canonicalization for the
 * `push` diff), so keeping it in this module — not in engine core — is what
 * lets `defs.ts` stay host/hub-agnostic.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { hashDef, parseDef } from './defs.ts';
import { mkdirRefusingSymlink } from './util.ts';

// ---- server-parity def content hash ------------------------------------------

/**
 * Reproduce the hub service's def content hash for the CLI `push` diff
 * (`owenloop-service` `apps/hub-edge/README.md`, "Hub API parity for CLI"):
 * `sha256(JSON.stringify(parseDef(YAML.parse(yaml))))` sliced to 16 hex
 * chars, computed with **no `baseDir`** — the compiled def (defaults filled),
 * exactly as the server computes it when it has no stored `defs` row. Taking
 * no `baseDir` is deliberate, not an oversight: it means `parseDef` throws a
 * `DefError` on any def using `bodyFile:` ("bodyFile requires a workflow
 * loaded from disk"), which is exactly the server's own limitation — such a
 * def can't be pushed as raw YAML anyway, so the caller should catch that and
 * refuse the push with a clear reason, the same way it already refuses an
 * `include:` def.
 *
 * Stable only per pinned engine version: the service pins its `parseDef`/
 * `hashDef` lineage to a specific commit (`VENDORED_SHA`). As of writing that
 * commit is an ancestor of this repo's `HEAD` with no changes to
 * `parseDef`/`buildDef`/`hashDef` in between, so a locally computed hash
 * currently matches the server's — but a future engine default change could
 * make them drift. A drifted hash reads as `changed`, not an error: pushing
 * converges state, because the server's own idempotent `create_workflow`
 * still recognizes byte-identical content and replies `unchanged: true`.
 */
export function hashDefForHub(yaml: string): string {
  return hashDef(parseDef(parseYaml(yaml)));
}

// ---- origin normalization ----------------------------------------------------

/**
 * Loopback hosts allowed to use plaintext `http` for local development. Exact
 * hostname match: WHATWG `URL` already lowercases hostnames (`HTTP://LOCALHOST`
 * → `localhost`), canonicalizes IPv4 shorthand (`http://127.1` → `127.0.0.1`),
 * and keeps the brackets on IPv6 (`http://[::1]` → `[::1]`), so a bare set
 * membership on `url.hostname` is correct and needs no range parsing.
 *
 * Deliberately NOT the whole `127.0.0.0/8` range nor `*.localhost` subdomains —
 * the exact enumeration the transport policy names (SEC-2). `http://127.0.0.2`
 * and `http://192.168.x.x` are remote for this purpose and rejected. Conservative
 * and cheap to widen later (a two-way door).
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Normalize a hub URL to a bare origin (`scheme://host[:port]`), stripping any
 * path, query, trailing slash, and fragment. Requires an http(s) scheme. This
 * is the credential-store key and the project binding value, so it must be
 * canonical: `https://api.owenloop.com/` and `https://api.owenloop.com/foo`
 * both key to `https://api.owenloop.com`.
 *
 * Transport policy (SEC-2): `https` is required for every hub origin EXCEPT the
 * loopback hosts (`127.0.0.1`, `::1`, `localhost`), which may use `http` for
 * local development. Remote `http` is rejected here, at normalization time, so a
 * plaintext origin that would leak bearer/refresh tokens, auth codes, and
 * workflow YAML to an on-path attacker can never be persisted into a credential
 * key or a project binding.
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
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `invalid hub url '${input}' — http is only allowed for loopback hosts (127.0.0.1, ::1, localhost); use https`,
    );
  }
  return url.origin;
}

/**
 * Join an origin and an endpoint that may be absolute or a root-relative path,
 * enforcing the same-origin policy for OAuth discovery metadata (SEC-4).
 *
 * This is the trust boundary for every endpoint consumed from OAuth metadata —
 * authorization, token, and registration endpoints all flow through here, as do
 * the CLI's own literal root-relative API paths. A metadata-derived absolute
 * endpoint is allowed, but must resolve to the SAME origin as the hub; a
 * cross-origin (or protocol-relative `//host`) endpoint is rejected so a
 * discovered `token_endpoint` on a foreign origin can never receive a refresh
 * token. Path and query are preserved — only `.origin` is compared. The
 * https-except-loopback rule holds for free: `origin` here is already a
 * `normalizeOrigin` output at every call site, so same-origin implies the
 * transport policy.
 */
export function resolveEndpoint(origin: string, endpoint: string): string {
  const resolved = new URL(endpoint, `${origin}/`);
  if (resolved.origin !== origin) {
    throw new Error(
      `refusing endpoint '${endpoint}' — it resolves to origin ${resolved.origin}, not the hub origin ${origin}`,
    );
  }
  return resolved.toString();
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
 * Write `data` to `path` atomically, refusing a symlinked (or directory)
 * destination (SEC-3).
 *
 * 1. `lstat` the destination: if it already exists AND is a symlink, throw a
 *    clear error naming the path rather than clobbering the arbitrary,
 *    possibly-privileged file the link points at. A pre-existing directory is
 *    likewise refused with a named error (instead of a raw ENOTDIR from
 *    rename).
 * 2. Write to a temp file in the SAME directory (same-dir is required — a
 *    cross-filesystem rename is not atomic), then `chmod` the temp to `mode`
 *    BEFORE the rename so the final file never momentarily exists with a lax,
 *    umask-widened mode (preserving the old "re-chmod on every write"
 *    guarantee, now applied to the temp).
 * 3. `rename(tmp, path)` — an atomic replace. On any failure after the temp
 *    exists, best-effort unlink the temp and rethrow.
 *
 * The `lstat` check is a courtesy clear-error, not the security boundary:
 * `rename` replaces the destination inode rather than following it, so even a
 * symlink raced into place between the `lstat` and the `rename` is replaced,
 * never followed — the write can never escape to the link target.
 */
export function writeFileAtomic(path: string, data: string, opts?: { mode?: number }): void {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    throw new Error(`refusing to write ${path}: it is a symbolic link`);
  }
  if (existing?.isDirectory()) {
    throw new Error(`refusing to write ${path}: it is a directory`);
  }
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, data, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
    if (opts?.mode !== undefined) chmodSync(tmp, opts.mode);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Write the credential file with strict permissions: dir 0700, file 0600.
 * The file itself is written atomically via `writeFileAtomic` (temp + rename),
 * which also chmods the temp to 0600 before the rename — so the secret is
 * never visible under a laxer mode, even briefly, and a symlinked destination
 * is refused (SEC-3).
 */
export function writeCredentialFile(path: string, file: CredentialFile): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

// ---- keychain backend + credential read --------------------------------------

/**
 * An OS keychain backend, keyed by hub origin (the `account`). The default
 * implementation (macOS `security` generic passwords) is `defaultKeychain`;
 * tests and embedding hosts inject their own. Never logs or echoes the secret.
 */
export interface Keychain {
  get(account: string): string | null;
  set(account: string, value: string): void;
  delete(account: string): void;
}

const KEYCHAIN_SERVICE = 'owenloop-hub';

/**
 * The default macOS keychain backend (generic passwords under service
 * `owenloop-hub`). The secret is fed through the `security -i` command stream on
 * stdin, never as a `-w` argv value, so it never appears in `ps`/shell history.
 * Returns `undefined` off macOS or when `OWENLOOP_NO_KEYCHAIN=1`, so callers
 * fall back to the 0600 credential file.
 */
export function defaultKeychain(env: Record<string, string | undefined>): Keychain | undefined {
  if (env.OWENLOOP_NO_KEYCHAIN === '1') return undefined;
  if (process.platform !== 'darwin') return undefined;
  return {
    get(account: string): string | null {
      try {
        const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.replace(/\n$/, '');
      } catch {
        return null; // not found (errSecItemNotFound) — treated as "no credential"
      }
    },
    set(account: string, value: string): void {
      // `security -i` reads newline-terminated commands from stdin; the secret
      // rides in that stdin stream (single-quoted), never on this process's argv.
      const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
      const cmd = `add-generic-password -U -s ${sq(KEYCHAIN_SERVICE)} -a ${sq(account)} -w ${sq(value)}\n`;
      execFileSync('security', ['-i'], { input: cmd, stdio: ['pipe', 'ignore', 'ignore'] });
    },
    delete(account: string): void {
      try {
        execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], {
          stdio: 'ignore',
        });
      } catch {
        // Not found — already absent; a no-op delete is success.
      }
    },
  };
}

/**
 * Resolve the keychain backend for this env, honoring the hard override:
 * `OWENLOOP_NO_KEYCHAIN=1` forces the file backend (`undefined`) EVEN when a
 * keychain is injected; otherwise the injected backend wins, else the platform
 * default.
 */
export function resolveKeychain(
  env: Record<string, string | undefined>,
  injected?: Keychain,
): Keychain | undefined {
  if (env.OWENLOOP_NO_KEYCHAIN === '1') return undefined;
  return injected ?? defaultKeychain(env);
}

/**
 * The credential backend, decided ONCE from env/config (`resolveKeychain`) and
 * then used consistently for read and write. Deciding once — rather than
 * per-operation — is the REL-6 fix: the old error-driven fallback let a write
 * land in the file while a later read hit the (absent/stale) keychain, so a
 * credential could shadow itself across backends.
 */
export type CredentialBackend = { kind: 'keychain'; kc: Keychain } | { kind: 'file' };

export function credentialBackend(
  env: Record<string, string | undefined>,
  injected?: Keychain,
): CredentialBackend {
  const kc = resolveKeychain(env, injected);
  return kc ? { kind: 'keychain', kc } : { kind: 'file' };
}

/** Options for `readStoredCredential`. */
export interface ReadStoredCredentialOpts {
  /** Environment to consult (OWENLOOP_NO_KEYCHAIN, HOME/XDG_CONFIG_HOME). Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable keychain backend (tests / embedding hosts). Ignored when OWENLOOP_NO_KEYCHAIN=1. */
  keychain?: Keychain;
}

/**
 * Read the stored hub credential for `origin` from the chosen backend ONLY —
 * the supported, read-only programmatic surface (owenwork's CredentialReader
 * seam wires to this once released). Secret hygiene is unchanged: this function
 * never logs or echoes the returned credential, and there is deliberately no
 * write/delete companion on the public surface.
 *
 * `origin` is normalized (idempotent on already-normalized input, so the CLI's
 * pre-normalized callers are unaffected) so the account key matches what
 * `login`/`connect` persisted; an invalid or plaintext-remote origin throws at
 * normalization (SEC-2), exactly as the CLI would.
 *
 * Backend is selected once (`credentialBackend`). A keychain-backed read NEVER
 * falls through to the file (that fallback was the REL-6 shadowing bug), and a
 * corrupt keychain entry reads as absent (`null`) — never as a reason to
 * consult the file. The file backend derives its path from the supplied `env`
 * (HOME / XDG_CONFIG_HOME), never `process.env` directly, so a caller passing
 * `opts.env` stays hermetic; only the top-level default falls back to
 * `process.env`.
 */
export function readStoredCredential(origin: string, opts?: ReadStoredCredentialOpts): Credential | null {
  const env = opts?.env ?? process.env;
  const key = normalizeOrigin(origin);
  const backend = credentialBackend(env, opts?.keychain);
  if (backend.kind === 'keychain') {
    const raw = backend.kc.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Credential;
    } catch {
      return null; // corrupt entry — treat as absent; do NOT consult the file
    }
  }
  const file = readCredentialFile(credentialFilePath(env));
  return file.hubs[key] ?? null;
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
  // Refuse a symlinked `.owenloop` parent (SEC-3, parent-directory half): a
  // hostile checkout can ship `.owenloop -> /elsewhere` to redirect this write
  // outside the project. Unconditional — this function only ever writes the
  // project binding, so there is no operator-supplied override to honor.
  mkdirRefusingSymlink(dirname(path));
  // Atomic + symlink-refusing on the FILE (SEC-3). Default mode — hub.json
  // carries no secrets and is deliberately committable.
  writeFileAtomic(path, `${JSON.stringify(binding, null, 2)}\n`);
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

/**
 * Narrow a create_workflow success body to its typed shape (after
 * `createWorkflowError` returns null), validating STRICTLY (REL-9): a 2xx with
 * `ok:true` is not enough — the identity fields must be present, well-typed, and
 * consistent with the def that was pushed, or the "success" is a malformed
 * response and must be treated as a failure, not silently coerced to defaults.
 *
 * - `name` must be a string equal to `expectedName` (the pushed def's name) —
 *   a mismatch means the server acknowledged the wrong workflow.
 * - `version` must be a positive integer (the server mints versions from 1).
 * - `hash` must be a non-empty string. Presence and type only: it is NOT
 *   required to equal the locally computed `hashDefForHub`, because engine
 *   drift between CLI and hub legitimately produces differing hashes (see
 *   `hashDefForHub`'s doc comment).
 * - `unchanged: true` passes through as an idempotent no-op, validated by the
 *   same field rules.
 *
 * Throws a descriptive `Error` (mirroring `asWhoami`'s throw-on-malformed style)
 * on any violation; the caller records it as a per-def failure.
 */
export function asCreateWorkflowOk(body: unknown, expectedName: string): CreateWorkflowOk {
  if (typeof body !== 'object' || body === null) {
    throw new Error('create_workflow: malformed success response — not an object');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.name !== 'string') {
    throw new Error('create_workflow: malformed success response — missing string name');
  }
  if (b.name !== expectedName) {
    throw new Error(
      `create_workflow: malformed success response — name '${b.name}' does not match pushed def '${expectedName}'`,
    );
  }
  if (typeof b.version !== 'number' || !Number.isInteger(b.version) || b.version < 1) {
    throw new Error('create_workflow: malformed success response — version must be a positive integer');
  }
  if (typeof b.hash !== 'string' || b.hash === '') {
    throw new Error('create_workflow: malformed success response — missing non-empty hash');
  }
  const out: CreateWorkflowOk = { ok: true, name: b.name, version: b.version, hash: b.hash };
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
