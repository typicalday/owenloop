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
