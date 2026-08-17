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
  AnswerApprovalRequest,
  AnswerApprovalResponse,
  AskRequest,
  AskResponse,
  GetRostersResponse,
  ListHarnessModelsResponse,
  ListPendingApprovalsResponse,
  RequestApprovalRequest,
  RequestApprovalResponse,
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
  RetryArtifactRequest,
  RetryArtifactResponse,
  ReportResolutionRequest,
  ReportResolutionResponse,
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
  /**
   * ESCALATION: the worker stops and asks a human about an artifact it OWES.
   * Distinct from `reject`, which is a verdict on somebody else's delivered
   * work. Holds the artifact (no counter moves) until a human answers with
   * `owenloop retry <workflow> <path> --text "<answer>"`, or with
   * `retryArtifact` on this client.
   */
  ask(req: AskRequest): Promise<AskResponse>;
  /**
   * The HUMAN half of the escalation channel and the answer to `ask` above:
   * re-arm a stalled or rejected artifact to `owed`, resetting its reject
   * counters. `text` rides to the next producer on the artifact's reason
   * thread. Omit `text` for a bare stall-clear — the engine supplies its own
   * default, so do NOT default it here. Human-only by hub RBAC; an agent
   * token is refused. Optional on this interface for the same reason
   * `getRosters` is: it was added after the existing HubClient fakes.
   */
  retryArtifact?(req: RetryArtifactRequest): Promise<RetryArtifactResponse>;
  /**
   * TOOL APPROVAL — raise AND poll, one idempotent call. The worker is mid-flight
   * and needs yes/no on ONE tool call; unlike `ask`, the session stays alive, the
   * run does not close, and the answer comes back to the very same blocked call.
   * Repeating the call with the same `tool_use_id` re-reads the existing row.
   */
  requestApproval(req: RequestApprovalRequest): Promise<RequestApprovalResponse>;
  /** The HUMAN half — the operator CLI, never a worker. An agent token is
   *  refused this verb by the hub's RBAC, deliberately. */
  answerApproval(req: AnswerApprovalRequest): Promise<AnswerApprovalResponse>;
  /** Every approval a worker is currently blocked on, org-wide. */
  listPendingApprovals(): Promise<ListPendingApprovalsResponse>;
  /**
   * Plan §6: record what this shift resolved the order's compound capability to,
   * BEFORE the harness launches. Idempotent on the hub by order id, so a
   * re-dispatch no-ops rather than overwriting the first (pre-spend) record.
   */
  reportResolution(req: ReportResolutionRequest): Promise<ReportResolutionResponse>;
  whoami(signal?: AbortSignal): Promise<WhoamiResponse>;
  /** Read the org's roster cascade using this caller's scoped identity. */
  getRosters?(signal?: AbortSignal): Promise<GetRostersResponse>;
  /** Read the hub's known harness/model registry. */
  listHarnessModels?(): Promise<ListHarnessModelsResponse>;
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

  async function get<T>(verb: string, query?: string, signal?: AbortSignal): Promise<T> {
    const url = query !== undefined && query !== '' ? `${base}/api/${verb}?${query}` : `${base}/api/${verb}`;
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: await authHeaders(),
      ...(signal === undefined ? {} : { signal }),
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
    ask: (req) => post<AskResponse>('ask', req),
    retryArtifact: (req) => post<RetryArtifactResponse>('retry_artifact', req),
    requestApproval: (req) => post<RequestApprovalResponse>('request_approval', req),
    answerApproval: (req) => post<AnswerApprovalResponse>('answer_approval', req),
    listPendingApprovals: () => post<ListPendingApprovalsResponse>('list_pending_approvals', {}),
    reportResolution: (req) => post<ReportResolutionResponse>('report_resolution', req),
    whoami: (signal) => get<WhoamiResponse>('whoami', undefined, signal),
    getRosters: (signal) => get<GetRostersResponse>('rosters', undefined, signal),
    listHarnessModels: () => get<ListHarnessModelsResponse>('harness_models'),
    // Cursor is an opaque non-negative integer; omit it entirely to bootstrap
    // (the hub treats missing/invalid as a `changed: true` first sweep).
    wake: (cursor) =>
      get<WakeResponse>('wake', typeof cursor === 'number' ? `cursor=${encodeURIComponent(String(cursor))}` : undefined),
    presencePing: (req) => post<PresencePingResponse>('presence_ping', req),
  };
}
