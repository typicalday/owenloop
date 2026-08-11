/**
 * Typed hub client for the verb surface the roles call. Transport and auth
 * wiring are real; in tests the client is exercised only against a fake
 * `fetchImpl` or a throwaway `node:http` server (never a live hub).
 *
 * Every call sends `Authorization: Bearer <token>` (from the injected
 * `getToken` — the seam where a CredentialReader plugs in later) and
 * `content-type: application/json`, POSTs JSON to `<origin>/api/<verb>` (GET
 * for `whoami`), and parses the `{ text, ...data }` envelope. Non-2xx becomes a
 * `HubError`.
 *
 * PRESENCE (B4) + WAKE (B5): the C1 client deliberately omitted these because
 * their hub surface did not exist yet. Both are merged now, so C3 adds
 * `presencePing` (POST `/api/presence_ping`) and `wake` (GET `/api/wake`,
 * cursor in the query string) matching the hub-edge shapes.
 *
 * No retries/backoff and no token refresh in C1 — the roles own their retry
 * policy later, and oauth-kind token refresh stays inside owenloop.
 */
import { HubError } from './types.ts';
import type {
  GetOrderRequest,
  GetOrderResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  PresencePingRequest,
  PresencePingResponse,
  ReleaseRequest,
  ReleaseResponse,
  RejectRequest,
  RejectResponse,
  SubmitRequest,
  SubmitResponse,
  WakeResponse,
  WhatsNextRequest,
  WhatsNextResponse,
  WhoamiResponse,
} from './types.ts';

export interface HubClientOptions {
  /** Hub origin, e.g. `https://hub.owenloop.dev` (no trailing slash needed). */
  origin: string;
  /** Resolves the bearer token per call — the CredentialReader seam. */
  getToken: () => Promise<string>;
  /** Override the transport in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface HubClient {
  whatsNext(req?: WhatsNextRequest): Promise<WhatsNextResponse>;
  getOrder(req: GetOrderRequest): Promise<GetOrderResponse>;
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  release(req: ReleaseRequest): Promise<ReleaseResponse>;
  submit(req: SubmitRequest): Promise<SubmitResponse>;
  reject(req: RejectRequest): Promise<RejectResponse>;
  whoami(): Promise<WhoamiResponse>;
  /** B5 cheap wake pre-check; `cursor` rides the query string only when set. */
  wake(cursor?: number): Promise<WakeResponse>;
  /** B4 Shift presence register/refresh. */
  presencePing(req: PresencePingRequest): Promise<PresencePingResponse>;
}

export function createHubClient(opts: HubClientOptions): HubClient {
  const base = opts.origin.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  async function authHeaders(): Promise<Record<string, string>> {
    const token = await opts.getToken();
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
  }

  function retryAfterMs(res: Response): number | undefined {
    const raw = res.headers.get('retry-after')?.trim();
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) return undefined;
    return Math.max(0, at - Date.now());
  }

  async function parse<T>(res: Response): Promise<T> {
    const raw = await res.text();
    if (!res.ok) {
      let code: string | undefined;
      let message = raw;
      try {
        const body = JSON.parse(raw) as { error?: string; message?: string };
        if (body && typeof body === 'object') {
          code = body.error;
          message = body.message ?? raw;
        }
      } catch {
        // Not JSON — keep the raw text as the message.
      }
      throw new HubError(res.status, message, code, retryAfterMs(res));
    }
    return JSON.parse(raw) as T;
  }

  async function post<T>(verb: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`${base}/api/${verb}`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });
    return parse<T>(res);
  }

  async function get<T>(verb: string, query?: string): Promise<T> {
    const url = query !== undefined && query !== '' ? `${base}/api/${verb}?${query}` : `${base}/api/${verb}`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: await authHeaders(),
    });
    return parse<T>(res);
  }

  return {
    whatsNext: (req = {}) => post<WhatsNextResponse>('whats_next', req),
    getOrder: (req) => post<GetOrderResponse>('get_order', req),
    heartbeat: (req) => post<HeartbeatResponse>('heartbeat', req),
    release: (req) => post<ReleaseResponse>('release', req),
    submit: (req) => post<SubmitResponse>('submit', req),
    reject: (req) => post<RejectResponse>('reject', req),
    whoami: () => get<WhoamiResponse>('whoami'),
    // Cursor is an opaque non-negative integer; omit it entirely to bootstrap
    // (the hub treats missing/invalid as a `changed: true` first sweep).
    wake: (cursor) =>
      get<WakeResponse>('wake', typeof cursor === 'number' ? `cursor=${encodeURIComponent(String(cursor))}` : undefined),
    presencePing: (req) => post<PresencePingResponse>('presence_ping', req),
  };
}
