/**
 * Shared hermetic test kit for the hub CLI verbs (login/connect/push/logout).
 * Not a `*.test.ts`, so it is imported, never run as a suite.
 *
 * Provides: an in-memory fake keychain, a route-based fake `fetch` that records
 * every call, and a `makeIo` that binds a CliIO to an `mkdtempSync` cwd + a
 * fixture `$HOME` — so no test reads the developer's real keychain, `~/.config`,
 * or the network (beyond the test-owned 127.0.0.1 loopback the login flow uses).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashDefForHub } from '../src/hub.ts';
import type { CliIO, Keychain } from '../src/cli.ts';

export interface RouteResult {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}
export type RouteHandler = (req: { url: URL; body: string | undefined; method: string }) => RouteResult;

export interface RecordedCall {
  method: string;
  url: string;
  pathname: string;
  body: string | undefined;
  authorization: string | null;
}

/** An in-memory keychain plus the backing map for assertions. */
export function fakeKeychain(): { keychain: Keychain; store: Map<string, string> } {
  const store = new Map<string, string>();
  const keychain: Keychain = {
    get: (account) => store.get(account) ?? null,
    set: (account, value) => void store.set(account, value),
    delete: (account) => void store.delete(account),
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
    calls.push({ method, url: urlStr, pathname: url.pathname, body, authorization });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`routedFetch: no route for ${method} ${url.pathname}`);
    const r = handler({ url, body, method });
    const headers = { 'Content-Type': 'application/json', ...(r.headers ?? {}) };
    const payload = r.json === undefined ? '' : JSON.stringify(r.json);
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
      base.calls.push({ method, url: urlStr, pathname: url.pathname, body, authorization });
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (!signal) return; // no signal threaded → hangs the test (the point)
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return base.fetch(input, init);
  }) as typeof globalThis.fetch;
  return { fetch: fetchFn, calls: base.calls };
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
