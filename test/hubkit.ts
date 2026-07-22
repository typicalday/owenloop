/**
 * Shared hermetic test kit for the hub CLI verbs (login/connect/push/logout).
 * Not a `*.test.ts`, so it is imported, never run as a suite.
 *
 * Provides: an in-memory fake keychain, a route-based fake `fetch` that records
 * every call, and a `makeIo` that binds a CliIO to an `mkdtempSync` cwd + a
 * fixture `$HOME` — so no test reads the developer's real keychain, `~/.config`,
 * or the network (beyond the test-owned 127.0.0.1 loopback the login flow uses).
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialSlot, hashDefForHub, keychainServiceFor } from '../src/hub.ts';
import type { CredentialSlotSelector } from '../src/hub.ts';
import type { CliIO, Keychain } from '../src/cli.ts';

export interface RouteResult {
  status: number;
  json?: unknown;
  /**
   * Raw, un-serialized response body. When set it is written verbatim, bypassing
   * `JSON.stringify` — the only way to model a response whose body is NOT valid
   * JSON (e.g. a 200 that dumps a plaintext token instead of the expected object).
   * Takes precedence over `json`.
   */
  raw?: string;
  headers?: Record<string, string>;
  /**
   * Escape hatch for streaming/oversized-body tests (realHttpServer only): when
   * set, the server writes the head (status + `headers`) and hands the raw
   * `ServerResponse` to this handler, which writes chunks, ends, or deliberately
   * leaves the stream open — bypassing the JSON serialization path. `routedFetch`
   * (in-memory, no real stream) throws if such a route is hit.
   */
  stream?: (res: ServerResponse) => void;
}
export type RouteHandler = (req: {
  url: URL;
  body: string | undefined;
  method: string;
  /** The request's `Authorization` header value (e.g. `Bearer <token>`), or `null`. Lets a
   *  stateful fake branch on the human vs agent bearer — most handlers ignore it. */
  authorization: string | null;
}) => RouteResult;

export interface RecordedCall {
  method: string;
  url: string;
  pathname: string;
  body: string | undefined;
  authorization: string | null;
  /** The `init.redirect` mode the caller passed — lets a test assert every
   *  hub/auth fetch sets `redirect: 'error'` (the fake ignores it otherwise). */
  redirect: RequestInit['redirect'];
}

/**
 * The composite key the fake keychain stores under, given a hub origin and a
 * credential slot. Tests assert on `t.store` through this helper rather than
 * hand-writing the composite format, so the format lives in exactly one place.
 */
export function kcKey(origin: string, slot: CredentialSlotSelector | string): string {
  const account = typeof slot === 'string' ? slot : credentialSlot(slot);
  return `${keychainServiceFor(origin)}\u0000${account}`;
}

/** The `human` slot key for `origin` — the default slot, used by most tests. */
export function kcHuman(origin: string): string {
  return kcKey(origin, { principal: 'human' });
}

/**
 * An in-memory keychain plus the backing map for assertions. Keyed by
 * `(service, account)` like the real backend; the map's key is the `kcKey`
 * composite.
 */
export function fakeKeychain(): { keychain: Keychain; store: Map<string, string> } {
  const store = new Map<string, string>();
  const composite = (service: string, account: string): string => `${service}\u0000${account}`;
  const keychain: Keychain = {
    get: (service, account) => store.get(composite(service, account)) ?? null,
    set: (service, account, value) => void store.set(composite(service, account), value),
    delete: (service, account) => void store.delete(composite(service, account)),
  };
  return { keychain, store };
}

/** Build a fake `fetch` from a `${METHOD} ${pathname}` route map, recording every call. */
export function routedFetch(routes: Record<string, RouteHandler>): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    const url = new URL(urlStr);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const authorization = new Headers(init?.headers).get('authorization');
    calls.push({ method, url: urlStr, pathname: url.pathname, body, authorization, redirect: init?.redirect });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`routedFetch: no route for ${method} ${url.pathname}`);
    const r = handler({ url, body, method, authorization });
    if (r.stream) throw new Error(`routedFetch: stream routes require realHttpServer (${method} ${url.pathname})`);
    const headers = { 'Content-Type': 'application/json', ...(r.headers ?? {}) };
    const payload = r.raw !== undefined ? r.raw : r.json === undefined ? '' : JSON.stringify(r.json);
    return new Response(payload, { status: r.status, headers });
  }) as typeof globalThis.fetch;
  return { fetch: fetchFn, calls };
}

/**
 * Like `routedFetch`, but for the listed `"METHOD /path"` keys the fetch never
 * resolves on its own — it rejects only when the caller's `AbortSignal` fires,
 * with that signal's `reason`. Because `AbortSignal.timeout`'s reason is a
 * `TimeoutError` DOMException, a call that HANGS (rather than rejecting fast)
 * proves the production code never threaded the signal into `fetch` — so this
 * only "passes" when the deadline is really wired. Every other route falls
 * through to the normal `routedFetch` behavior, sharing its `calls` log.
 */
export function stallingFetch(
  routes: Record<string, RouteHandler>,
  stallKeys: string[],
): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
  const stalls = new Set(stallKeys);
  const base = routedFetch(routes);
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    const url = new URL(urlStr);
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = `${method} ${url.pathname}`;
    if (stalls.has(key)) {
      const body = typeof init?.body === 'string' ? init.body : undefined;
      const authorization = new Headers(init?.headers).get('authorization');
      base.calls.push({ method, url: urlStr, pathname: url.pathname, body, authorization, redirect: init?.redirect });
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) return; // no signal threaded → hangs the test (the point)
        // Mirror a real in-flight socket: hold a ref'd timer so the event loop
        // stays alive while we wait for the abort. `AbortSignal.timeout`'s
        // internal timer is unref'd, so on Node 22 — where nothing else keeps
        // the loop alive during this fake stall — the loop drains before the
        // timeout ever fires and the fetch is left pending forever ("Promise
        // resolution is still pending but the event loop has already
        // resolved"). In production the open socket keeps the loop alive; this
        // keep-alive stands in for it. Cleared on abort so it never outlives
        // the request. (Node 24+ kept the loop alive here on its own, which is
        // why this only bit on Node 22.)
        const keepAlive = setInterval(() => {}, 1_000);
        const fail = (reason: unknown): void => {
          clearInterval(keepAlive);
          reject(reason);
        };
        if (signal.aborted) fail(signal.reason);
        else signal.addEventListener('abort', () => fail(signal.reason), { once: true });
      });
    }
    return base.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { fetch: fetchFn, calls: base.calls };
}

/**
 * A REAL `node:http` loopback server speaking the same `RouteHandler` shape as
 * `routedFetch`, so route tables read identically. Unlike `routedFetch` (an
 * in-memory fake that bypasses undici and ignores `init.redirect`), this drives
 * the platform's real fetch — the only way to prove actual redirect BEHAVIOR
 * (`redirect: 'error'` refusing a 3xx before the second request leaves). Bind a
 * redirect route with `{ status: 307, headers: { Location: `${foreign.origin}/x` } }`.
 * Hermetic: loopback only, test-owned, no ambient state, no TLS. Always
 * `close()` it (e.g. in a `finally` / `t.after`). `calls` records every request
 * the server actually RECEIVED — a foreign target's `calls` staying empty is
 * the leak detector. (`redirect` on those records is always `undefined`: a
 * server cannot observe the client's `init.redirect`; assert that flag via
 * `routedFetch` instead.)
 */
export async function realHttpServer(routes: Record<string, RouteHandler>): Promise<{
  origin: string;
  calls: RecordedCall[];
  close(): Promise<void>;
}> {
  const calls: RecordedCall[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => void chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
      const method = (req.method ?? 'GET').toUpperCase();
      const host = req.headers.host ?? '127.0.0.1';
      const url = new URL(req.url ?? '/', `http://${host}`);
      const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;
      calls.push({ method, url: url.toString(), pathname: url.pathname, body, authorization, redirect: undefined });
      const handler = routes[`${method} ${url.pathname}`];
      if (!handler) {
        // Must answer — a thrown handler error inside a real server would hang the client.
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `realHttpServer: no route for ${method} ${url.pathname}` }));
        return;
      }
      const r = handler({ url, body, method, authorization });
      if (r.stream) {
        // Streaming route: write the head, then let the handler own the body
        // (write chunks, end, or leave it open to exercise a client cancel).
        res.writeHead(r.status, r.headers ?? {});
        r.stream(res);
        return;
      }
      const headers = { 'Content-Type': 'application/json', ...(r.headers ?? {}) };
      const payload = r.raw !== undefined ? r.raw : r.json === undefined ? '' : JSON.stringify(r.json);
      res.writeHead(r.status, headers);
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('realHttpServer: no port assigned');
  const origin = `http://127.0.0.1:${addr.port}`;
  return {
    origin,
    calls,
    // Drop any socket the client cancelled mid-stream before close() waits on
    // it (Node ≥ 18.2; we run 22) — otherwise a lingering half-open connection
    // can hang teardown of a streaming test.
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}

export interface HubIo {
  io: CliIO;
  cwd: string;
  home: string;
  out: string[];
  err: string[];
  openedUrls: string[];
  store: Map<string, string>;
}

export interface MakeIoOpts {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  keychain?: Keychain;
  store?: Map<string, string>;
  stdin?: string;
  /** Called with the authorize URL; use it to drive the loopback in login tests. */
  onOpenUrl?: (url: string) => void;
  /** Injected interactive-prompt seam for `setup` (the succession / name prompts).
   *  The default `makeIo` leaves it undefined so a scripted test that supplies no
   *  prompt exercises the non-interactive guard. */
  prompt?: (question: string) => Promise<string>;
  /** Injected exec seam for the plugin probe (`claude plugin list`). Undefined by
   *  default, so the plugin check just doesn't find the binary unless the test PATH
   *  provides one AND a runCommand is supplied. */
  runCommand?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
}

export function makeIo(opts: MakeIoOpts = {}): HubIo {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-hub-cwd-'));
  const home = mkdtempSync(join(tmpdir(), 'owenloop-hub-home-'));
  const out: string[] = [];
  const err: string[] = [];
  const openedUrls: string[] = [];
  const kc = opts.keychain ? { keychain: opts.keychain, store: opts.store ?? new Map<string, string>() } : fakeKeychain();

  const io: CliIO = {
    cwd,
    env: { HOME: home, ...opts.env },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    fetch: opts.fetch,
    openUrl: (url) => {
      openedUrls.push(url);
      opts.onOpenUrl?.(url);
    },
    keychain: opts.keychain ?? kc.keychain,
    readStdin: async () => opts.stdin ?? '',
    prompt: opts.prompt,
    runCommand: opts.runCommand,
  };
  return { io, cwd, home, out, err, openedUrls, store: opts.store ?? kc.store };
}

/** Canonical OAuth AS metadata (relative endpoints, to exercise resolveEndpoint). */
export const OAUTH_METADATA = {
  authorization_endpoint: '/mcp/authorize',
  token_endpoint: '/mcp/token',
  registration_endpoint: '/mcp/register',
  grant_types: ['authorization_code', 'refresh_token'],
  code_challenge_methods: ['S256'],
};

/** Canonical `GET /api/whoami` 200 body, reused across login/connect/push tests. */
export const WHOAMI_BODY = {
  orgId: 'org_test123',
  orgName: 'Test Org',
  actor: { id: 'user_abc', kind: 'user', role: 'member' },
  authMethod: 'oauth',
};

/** Build a `GET /api/workflows` route handler from a list of server-side def summaries. */
export function workflowsRoute(
  items: { name: string; hash: string; version?: number; title?: string; steps?: unknown }[],
): RouteHandler {
  return () => ({
    status: 200,
    json: {
      text: '',
      workflows: items.map((it) => ({ steps: [], ...it })),
    },
  });
}

/**
 * A minimal in-memory stand-in for the hub's `GET /api/workflows` +
 * `POST /api/create_workflow` pair, reproducing exactly the contract `push`
 * depends on: a name absent from the store is a fresh create (version 1); a
 * present name whose `hashDefForHub` matches the incoming yaml is an
 * idempotent no-op (`{ok:true, unchanged:true, version:<unchanged>}`, no
 * version bump); a mismatched hash version-forwards. Uses the real
 * `hashDefForHub` (not a stand-in) so `computeServerDiff`'s LOCAL diff
 * against `GET /api/workflows`'s `hash` field is exercised exactly as it
 * would be against the real hub — a genuinely-unchanged push resolves with
 * zero `create_workflow` calls, not merely a server-side no-op.
 */
export function makeFakeHub(seed: { name: string; yaml: string; version?: number }[] = []): {
  routes: Record<string, RouteHandler>;
  state: Map<string, { yaml: string; version: number }>;
} {
  const state = new Map<string, { yaml: string; version: number }>(
    seed.map((w) => [w.name, { yaml: w.yaml, version: w.version ?? 1 }]),
  );
  const routes: Record<string, RouteHandler> = {
    'GET /api/workflows': () => ({
      status: 200,
      json: {
        text: '',
        workflows: [...state.entries()].map(([name, w]) => ({
          name,
          hash: hashDefForHub(w.yaml),
          version: w.version,
          steps: [],
        })),
      },
    }),
    'POST /api/create_workflow': (req) => {
      const body = JSON.parse(req.body ?? '{}') as { yaml?: string };
      const yaml = typeof body.yaml === 'string' ? body.yaml : '';
      const hash = hashDefForHub(yaml);
      const nameMatch = /^name:\s*(\S+)/m.exec(yaml);
      const name = nameMatch ? nameMatch[1]! : '';
      const existing = state.get(name);
      if (existing && hashDefForHub(existing.yaml) === hash) {
        return { status: 200, json: { ok: true, name, version: existing.version, hash, unchanged: true } };
      }
      const version = existing ? existing.version + 1 : 1;
      state.set(name, { yaml, version });
      return { status: 200, json: { ok: true, name, version, hash } };
    },
  };
  return { routes, state };
}

// ---- makeIdentityHub: the stateful fake for setup/doctor -------------------

/** One agent identity in the fake hub's state. `lastContactAt` is identity-level;
 *  the reported `lastUsedAt` is COMPUTED (max over the identity's tokens, incl. revoked). */
export interface IdentityRow {
  id: string;
  name: string;
  createdAt: number;
  lastContactAt: number | null;
  pools: string[];
  disabled: boolean;
}

/** One issued agent token. `plaintext` is the `olp_` secret a `whoami` bearer presents. */
export interface TokenRow {
  id: string;
  plaintext: string;
  agentId: string;
  revoked: boolean;
  lastUsedAt: number | null;
}

/** The mutable state a `makeIdentityHub` closes over — tests seed/inspect it directly. */
export interface IdentityHubState {
  identities: Map<string, IdentityRow>;
  tokens: Map<string, TokenRow>;
  /** When true, `GET /api/agent_identities` returns 403 even for a human bearer (non-admin human). */
  adminForbidden: boolean;
  /** HTTP status the `refresh_token` grant returns (200 ok; set 400 for the dead-refresh test). */
  refreshGrantStatus: number;
  counter: { n: number };
}

/** A seed identity (with an optional live token) for `makeIdentityHub`. */
export interface SeedIdentity {
  id?: string;
  name: string;
  pools?: string[];
  lastContactAt?: number | null;
  lastUsedAt?: number | null;
  disabled?: boolean;
  /** Seed a token for this identity so its computed `lastUsedAt` is set and its `olp_` verifies. */
  token?: { plaintext: string; revoked?: boolean };
}

const IDENTITY_ORG = { orgId: 'org_test123', orgName: 'Test Org' };

/** The bearer (minus `Bearer `) from an Authorization header value. */
function bearerOf(authorization: string | null): string {
  return (authorization ?? '').replace(/^Bearer\s+/i, '');
}

/**
 * A stateful fake hub for `setup`/`doctor`, composable with `routedFetch`.
 * Models the OAuth AS (metadata / DCR / token, both grants), `whoami` (branching
 * on the human `mcpat*` bearer vs a live `olp_` agent token), `agent_identities`
 * (human-only; computes `lastUsedAt` as the max over an identity's tokens
 * INCLUDING revoked ones — deliberately rekey-surviving), `mint_agent_token`
 * (name-taken 400 branch; the `text` field carries the plaintext), and
 * `rekey_agent_token` (revokes the identity's live tokens, mints a new `olp_`).
 *
 * Returns `{ routes, state }`; wrap `routes` with `routedFetch` (a fresh wrap
 * over the SAME `routes` reuses the same mutable `state` — the second-run no-op
 * test relies on this). Seed identities/tokens via `seed` or by mutating `state`.
 */
export function makeIdentityHub(seed: { identities?: SeedIdentity[] } = {}): {
  routes: Record<string, RouteHandler>;
  state: IdentityHubState;
} {
  const state: IdentityHubState = {
    identities: new Map(),
    tokens: new Map(),
    adminForbidden: false,
    refreshGrantStatus: 200,
    counter: { n: 0 },
  };

  (seed.identities ?? []).forEach((s, i) => {
    const id = s.id ?? `agent_seed_${i + 1}`;
    state.identities.set(id, {
      id,
      name: s.name,
      createdAt: Date.now(),
      lastContactAt: s.lastContactAt ?? null,
      pools: s.pools ?? [],
      disabled: s.disabled ?? false,
    });
    if (s.token) {
      const tid = `tok_seed_${i + 1}`;
      state.tokens.set(tid, {
        id: tid,
        plaintext: s.token.plaintext,
        agentId: id,
        revoked: s.token.revoked ?? false,
        lastUsedAt: s.lastUsedAt ?? null,
      });
    }
  });

  const computedLastUsedAt = (agentId: string): number | null =>
    [...state.tokens.values()]
      .filter((t) => t.agentId === agentId)
      .reduce<number | null>((m, t) => (t.lastUsedAt !== null && (m === null || t.lastUsedAt > m) ? t.lastUsedAt : m), null);

  const requireHuman = (authorization: string | null): boolean => bearerOf(authorization).startsWith('mcpat');

  const routes: Record<string, RouteHandler> = {
    // --- OAuth AS ---
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/register': () => ({ status: 200, json: { client_id: 'client-abc' } }),
    'POST /mcp/token': (req) => {
      const grant = new URLSearchParams(req.body ?? '').get('grant_type');
      if (grant === 'refresh_token') {
        if (state.refreshGrantStatus !== 200) return { status: state.refreshGrantStatus, json: { error: 'invalid_grant' } };
        return { status: 200, json: { access_token: 'mcpat_refreshed', refresh_token: 'rt_refresh2', expires_in: 3600, token_type: 'Bearer' } };
      }
      return { status: 200, json: { access_token: 'mcpat_access', refresh_token: 'rt_refresh', expires_in: 3600, token_type: 'Bearer' } };
    },

    // --- identity plane ---
    'GET /api/whoami': (req) => {
      const bearer = bearerOf(req.authorization);
      if (bearer.startsWith('mcpat')) {
        return { status: 200, json: { ...IDENTITY_ORG, actor: { id: 'user_abc', kind: 'user', role: 'admin' }, authMethod: 'oauth', email: 'alex@typical.day' } };
      }
      const tok = [...state.tokens.values()].find((t) => t.plaintext === bearer && !t.revoked);
      if (tok) {
        return { status: 200, json: { ...IDENTITY_ORG, actor: { id: tok.agentId, kind: 'agent', role: 'agent' }, authMethod: 'agent_token' } };
      }
      return { status: 401, json: { message: 'unauthorized' } };
    },
    'GET /api/agent_identities': (req) => {
      if (!requireHuman(req.authorization)) return { status: 403, json: { message: 'forbidden' } };
      if (state.adminForbidden) return { status: 403, json: { message: 'forbidden: manage_tokens requires an admin credential' } };
      const identities = [...state.identities.values()].map((id) => ({
        id: id.id,
        name: id.name,
        role: 'agent',
        createdBy: 'user_abc',
        createdAt: id.createdAt,
        disabled: id.disabled,
        firstContactAt: null,
        lastContactAt: id.lastContactAt,
        lastUsedAt: computedLastUsedAt(id.id),
        pools: id.pools,
      }));
      return { status: 200, json: { identities } };
    },

    // --- token verbs ---
    'POST /api/mint_agent_token': (req) => {
      if (!requireHuman(req.authorization)) return { status: 403, json: { message: 'forbidden' } };
      const body = JSON.parse(req.body ?? '{}') as { name?: string; scopes?: string[]; pools?: string[] };
      const name = body.name ?? '';
      if ([...state.identities.values()].some((i) => i.name === name)) {
        return { status: 400, json: { message: `agent name already taken: "${name}"` } };
      }
      const n = ++state.counter.n;
      const agentId = `agent_${n}`;
      const tokenId = `tok_${n}`;
      const plaintext = `olp_minted_${n}_secretpart`;
      const pools = body.pools ?? ['personal-alex'];
      state.identities.set(agentId, { id: agentId, name, createdAt: Date.now(), lastContactAt: null, pools, disabled: false });
      state.tokens.set(tokenId, { id: tokenId, plaintext, agentId, revoked: false, lastUsedAt: null });
      return {
        status: 200,
        json: { text: `Agent token minted (id ${tokenId}). Store this secret now — it will not be shown again:\n${plaintext}`, id: tokenId, token: plaintext, agentId, pools },
      };
    },
    'POST /api/rekey_agent_token': (req) => {
      if (!requireHuman(req.authorization)) return { status: 403, json: { message: 'forbidden' } };
      const body = JSON.parse(req.body ?? '{}') as { agentId?: string };
      const agentId = body.agentId ?? '';
      if (!state.identities.has(agentId)) return { status: 400, json: { message: `unknown agent: ${agentId}` } };
      const revokedTokenIds: string[] = [];
      for (const t of state.tokens.values()) {
        if (t.agentId === agentId && !t.revoked) {
          t.revoked = true;
          revokedTokenIds.push(t.id);
        }
      }
      const n = ++state.counter.n;
      const tokenId = `tok_${n}`;
      const plaintext = `olp_rekeyed_${n}_secretpart`;
      state.tokens.set(tokenId, { id: tokenId, plaintext, agentId, revoked: false, lastUsedAt: null });
      return {
        status: 200,
        json: { text: `Agent token re-keyed. Store this secret now:\n${plaintext}`, id: tokenId, token: plaintext, agentId, revokedTokenIds, scopes: ['work'] },
      };
    },
    'POST /api/revoke_token': (req) => {
      const body = JSON.parse(req.body ?? '{}') as { tokenId?: string };
      const t = state.tokens.get(body.tokenId ?? '');
      if (t) t.revoked = true;
      return { status: 200, json: { ok: true } };
    },
  };

  return { routes, state };
}

/**
 * THE leak assertion, run at the end of EVERY setup/doctor test: no `olp_`
 * substring may appear on stdout or stderr. The fake mint/rekey tokens all start
 * `olp_` and are carried in the `text` field, so this has teeth.
 */
export function assertNoOlp(t: HubIo): void {
  const combined = [...t.out, ...t.err].join('\n');
  assert.ok(!/olp_/.test(combined), `no olp_ token may appear on stdout/stderr; got:\n${combined}`);
}
