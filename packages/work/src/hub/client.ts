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
 * `putFileArtifact` is the single exception to the JSON rule: its body is the
 * asset's raw bytes under the asset's own content type. Base64 in a JSON field
 * would inflate every upload by a third and force a multi-megabyte file through
 * a JavaScript string, so the bytes travel as bytes.
 *
 * PRESENCE (B4) + WAKE (B5): the C1 client deliberately omitted these because
 * their hub surface did not exist yet. Both are merged now, so C3 adds
 * `presencePing` (POST `/api/presence_ping`) and `wake` (GET `/api/wake`,
 * cursor in the query string) matching the hub-edge shapes.
 *
 * No retries/backoff and no token refresh in C1 — the roles own their retry
 * policy later, and oauth-kind token refresh stays inside owenloop.
 */
import { Readable } from 'node:stream';
import { HubError } from './types.ts';
import type {
  AnswerApprovalRequest,
  AnswerApprovalResponse,
  AskRequest,
  AskResponse,
  ConditionalSubmitRequest,
  ConditionalSubmitResponse,
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
  PutFileArtifactRequest,
  PutFileArtifactResponse,
  FileArtifactPointer,
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
  RoutingScope,
  RoutingSessionOpenResponse,
  RoutingSessionRenewResponse,
  RoutingOfferRequest,
  RoutingOfferSubmission,
  RoutingOfferResponse,
  RoutingClaimReadResponse,
  InvocationBindingReadRequest,
  InvocationBindingReadResponse,
  LaunchReportV1,
  LaunchReportResponse,
  LaunchReservationRequestV1,
  LaunchReservationResponse,
  LocalModelRequest,
  LocalModelResponse,
} from './types.ts';

export interface HubClientOptions {
  /** Hub origin, e.g. `https://hub.owenloop.dev` (no trailing slash needed). */
  origin: string;
  /** Resolves the bearer token per call — the CredentialReader seam. */
  getToken: () => Promise<string>;
  /** Override the transport in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Trusted per-client closure; the capability never enters a request body. */
  routingSession?: {
    allowedOrigin: string;
    get: () => RoutingSessionOpenResponse | undefined;
    now?: () => number;
    /** Shared monotonic Retry-After fence, checked immediately before transport. */
    beforeRequest?: () => void;
    /** Observe a routed 429 as soon as its response arrives. */
    onRateLimit?: (error: HubError) => void;
  };
}

export interface HubClient {
  /**
   * `signal` on this and the other poll-loop verbs (`wake`, `presencePing`)
   * is the shift loop's per-call deadline (issue #300): a hub call that never
   * settles used to hang the poll loop forever while the control socket kept
   * answering. Optional and trailing so every existing fake keeps compiling;
   * a fake that ignores it simply cannot be cut short.
   */
  whatsNext(req: WhatsNextRequest, signal?: AbortSignal): Promise<WhatsNextResponse>;
  getOrder(req: GetOrderRequest, signal?: AbortSignal): Promise<GetOrderResponse>;
  /** Opt-in trusted reference protocol. An older Service returns 404; no legacy retry. */
  getReferenceOrder?(req: GetOrderRequest): Promise<unknown>;
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  release(req: ReleaseRequest): Promise<ReleaseResponse>;
  submit(req: SubmitRequest): Promise<SubmitResponse>;
  /** Versioned route only; callers must never fall back to legacy submit. */
  submitConditional?(req: ConditionalSubmitRequest): Promise<ConditionalSubmitResponse>;
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
  /** Ask the authorized routing service for one local-model advisory. */
  assessLocalModel?(req: LocalModelRequest, signal?: AbortSignal): Promise<LocalModelResponse>;
  /** B5 cheap wake pre-check; `cursor` rides the query string only when set. */
  wake(cursor?: number, signal?: AbortSignal): Promise<WakeResponse>;
  /** B4 Shift presence register/refresh. */
  presencePing(req: PresencePingRequest, signal?: AbortSignal): Promise<PresencePingResponse>;
  /**
   * Store opaque bytes as a file artifact and return the envelope naming them.
   *
   * The only byte-bodied call on this client. Everything else sends JSON, so
   * this one bypasses `post` rather than teaching `post` a second body mode:
   * one call site with an explicit content type is easier to audit than a
   * shared helper that silently means two different things.
   */
  putFileArtifact(req: PutFileArtifactRequest): Promise<PutFileArtifactResponse>;
}

export interface RoutingHubClient extends HubClient {
  assessLocalModel(req: LocalModelRequest, signal?: AbortSignal): Promise<LocalModelResponse>;
  /** Explicit session-scoped lifecycle. Legacy HubClient verbs remain fenced. */
  routingHeartbeat(req: HeartbeatRequest, signal?: AbortSignal): Promise<HeartbeatResponse>;
  routingSubmit(req: SubmitRequest, signal?: AbortSignal): Promise<SubmitResponse>;
  routingRelease(req: { workflow: string; run: string; reason?: string }, signal?: AbortSignal): Promise<ReleaseResponse>;
  routingAsk(req: AskRequest, signal?: AbortSignal): Promise<AskResponse>;
  routingReject(req: RejectRequest, signal?: AbortSignal): Promise<RejectResponse>;
  routingRequestApproval(req: RequestApprovalRequest, signal?: AbortSignal): Promise<RequestApprovalResponse>;
  routingPutFileArtifact(req: { workflow: string; run: string; body: Readable; size: number;
    contentType: string; filename?: string }, signal?: AbortSignal): Promise<PutFileArtifactResponse>;
  routingGetFileArtifact(req: { workflow: string; run: string; key: string;
    pointer: FileArtifactPointer }, signal?: AbortSignal): Promise<{ body: Readable; size: number; contentType: string }>;
  openRoutingSession(req: { scope?: RoutingScope }, signal?: AbortSignal): Promise<RoutingSessionOpenResponse>;
  renewRoutingSession(signal?: AbortSignal): Promise<RoutingSessionRenewResponse>;
  closeRoutingSession(signal?: AbortSignal): Promise<{ closed: true }>;
  routingOfferContext(req: RoutingOfferRequest, signal?: AbortSignal): Promise<RoutingOfferResponse>;
  putShiftOffer(req: RoutingOfferRequest & { submission: RoutingOfferSubmission }, signal?: AbortSignal): Promise<RoutingOfferResponse>;
  readRoutingClaim(req: { workflow: string; run: string }, signal?: AbortSignal): Promise<RoutingClaimReadResponse>;
  readInvocationBinding(req: InvocationBindingReadRequest, signal?: AbortSignal): Promise<InvocationBindingReadResponse>;
  reportLaunch(req: { workflow: string; report: LaunchReportV1 }, signal?: AbortSignal): Promise<LaunchReportResponse>;
  reserveLaunch(req: { workflow: string; request: LaunchReservationRequestV1 }, signal?: AbortSignal): Promise<LaunchReservationResponse>;
}

export function createHubClient(opts: HubClientOptions): RoutingHubClient {
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

  async function post<T>(verb: string, body: unknown, signal?: AbortSignal): Promise<T> {
    // A routing claim has additional authority and launch fences. Legacy
    // lifecycle verbs cannot settle it through bearer-only routes.
    if (opts.routingSession) throw new Error('routing session legacy POST refused');
    const res = await fetchImpl(`${base}/api/${verb}`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    return parse<T>(res);
  }

  async function scopedPost<T>(verb: string, body: unknown, signal?: AbortSignal, opening = false): Promise<T> {
    // Validate before resolving either credential. URL normalization must not
    // quietly bless a path, userinfo, another origin, or an HTTP endpoint.
    const routing = opts.routingSession;
    let origin: URL;
    try { origin = new URL(opts.origin); } catch { throw new Error('routing origin refused'); }
    if (!routing || origin.protocol !== 'https:' || origin.origin !== routing.allowedOrigin
      || base !== origin.origin || origin.username || origin.password) throw new Error('routing origin refused');
    const session = opening ? undefined : routing.get();
    if (!opening && (!session || !Number.isFinite(session.expiresAt)
      || session.expiresAt <= (routing.now?.() ?? Date.now()) || !session.credential)) throw new Error('routing session unavailable');
    try {
      const headers = await authHeaders();
      if (session) headers['X-Owenloop-Routing-Session'] = session.credential;
      routing.beforeRequest?.();
      const res = await fetchImpl(`${base}/api/${verb}`, {
	method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
	...(signal === undefined ? {} : { signal }),
      });
      // Response bodies and fetch errors can echo credentials. Keep them out
      // of persisted worker diagnostics while retaining status/backoff metadata.
      if (!res.ok) {
	const error = new HubError(res.status, 'routing request refused', undefined, retryAfterMs(res));
	if (error.status === 429) routing.onRateLimit?.(error);
	throw error;
      }
      return await res.json() as T;
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new Error('routing request failed');
    }
  }

  async function scopedFileArtifact(req: { workflow: string; run: string; body: Readable; size: number;
    contentType: string; filename?: string }, signal?: AbortSignal): Promise<PutFileArtifactResponse> {
    const routing = opts.routingSession;
    let origin: URL;
    try { origin = new URL(opts.origin); } catch { throw new Error('routing origin refused'); }
    if (!routing || origin.protocol !== 'https:' || origin.origin !== routing.allowedOrigin
      || base !== origin.origin || origin.username || origin.password
      || !Number.isSafeInteger(req.size) || req.size <= 0 || req.size > 500_000_000)
      throw new Error('routing file artifact refused');
    const session = routing.get();
    if (!session || !Number.isFinite(session.expiresAt)
      || session.expiresAt <= (routing.now?.() ?? Date.now()) || !session.credential)
      throw new Error('routing session unavailable');
    try {
      const headers = await authHeaders();
      headers['X-Owenloop-Routing-Session'] = session.credential;
      headers['content-type'] = req.contentType;
      headers['content-length'] = String(req.size);
      if (req.filename !== undefined) headers['x-file-name'] = req.filename;
      routing.beforeRequest?.();
      const url = `${base}/api/routing_file_artifacts/v1?workflow=${encodeURIComponent(req.workflow)}&run=${encodeURIComponent(req.run)}`;
      const res = await fetchImpl(url, {
	method: 'POST', headers, body: req.body as unknown as RequestInit['body'],
	duplex: 'half', redirect: 'error',
	...(signal === undefined ? {} : { signal }),
      } as RequestInit & { duplex: 'half' });
      if (!res.ok) {
	const error = new HubError(res.status, 'routing request refused', undefined, retryAfterMs(res));
	if (error.status === 429) routing.onRateLimit?.(error);
	throw error;
      }
      return await res.json() as PutFileArtifactResponse;
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new Error('routing request failed');
    }
  }

  async function scopedFileArtifactRead(req: { workflow: string; run: string; key: string;
    pointer: FileArtifactPointer }, signal?: AbortSignal): Promise<{ body: Readable; size: number; contentType: string }> {
    const routing = opts.routingSession;
    let origin: URL;
    try { origin = new URL(opts.origin); } catch { throw new Error('routing origin refused'); }
    if (!routing || origin.protocol !== 'https:' || origin.origin !== routing.allowedOrigin
      || base !== origin.origin || origin.username || origin.password
      || !req.workflow || !req.run || !req.key || req.pointer.__file !== req.key
      || !Number.isSafeInteger(req.pointer.size) || req.pointer.size <= 0 || req.pointer.size > 500_000_000
      || !/^[a-f0-9]{64}$/.test(req.pointer.hash)) throw new Error('routing file artifact refused');
    const session = routing.get();
    if (!session || !Number.isFinite(session.expiresAt)
      || session.expiresAt <= (routing.now?.() ?? Date.now()) || !session.credential)
      throw new Error('routing session unavailable');
    try {
      const headers = await authHeaders();
      headers['X-Owenloop-Routing-Session'] = session.credential;
      routing.beforeRequest?.();
      const url = `${base}/api/routing_file_artifacts/v1?workflow=${encodeURIComponent(req.workflow)}`
        + `&run=${encodeURIComponent(req.run)}&key=${encodeURIComponent(req.key)}`;
      const res = await fetchImpl(url, { method: 'GET', headers, redirect: 'error',
        ...(signal === undefined ? {} : { signal }) });
      if (!res.ok) {
        const error = new HubError(res.status, 'routing request refused', undefined, retryAfterMs(res));
        if (error.status === 429) routing.onRateLimit?.(error);
        throw error;
      }
      const size = Number(res.headers.get('Content-Length'));
      const contentType = res.headers.get('Content-Type');
      const hash = res.headers.get('X-File-Hash');
      if (!res.body || !Number.isSafeInteger(size) || size !== req.pointer.size
        || contentType !== req.pointer.contentType || hash !== req.pointer.hash) {
        void res.body?.cancel().catch(() => {});
        throw new Error('routing file artifact response refused');
      }
      return { body: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), size, contentType };
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new Error('routing request failed');
    }
  }

  async function get<T>(verb: string, query?: string, signal?: AbortSignal): Promise<T> {
    if (opts.routingSession) {
      let origin: URL;
      try { origin = new URL(opts.origin); } catch { throw new Error('routing origin refused'); }
      if (origin.protocol !== 'https:' || base !== origin.origin || origin.origin !== opts.routingSession.allowedOrigin
	|| origin.username || origin.password) throw new Error('routing origin refused');
    }
    const url = query !== undefined && query !== '' ? `${base}/api/${verb}?${query}` : `${base}/api/${verb}`;
    try {
      const headers = await authHeaders();
      opts.routingSession?.beforeRequest?.();
      const res = await fetchImpl(url, {
	method: 'GET', headers,
	...(opts.routingSession ? { redirect: 'error' as const } : {}),
	...(signal === undefined ? {} : { signal }),
      });
      if (opts.routingSession && !res.ok) {
	const error = new HubError(res.status, 'routing request refused', undefined, retryAfterMs(res));
	if (error.status === 429) opts.routingSession.onRateLimit?.(error);
	throw error;
      }
      return await parse<T>(res);
    } catch (error) {
      if (opts.routingSession && !(error instanceof HubError)) throw new Error('routing request failed');
      throw error;
    }
  }

  async function postBytes<T>(path: string, req: PutFileArtifactRequest): Promise<T> {
    if (opts.routingSession) throw new Error('routing session legacy POST refused');
    const token = await opts.getToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      'content-type': req.contentType,
    };
    // The name rides a header rather than the body because the body IS the
    // bytes. It is a display label only; the hub never resolves it as a path.
    if (req.filename !== undefined) headers['x-file-name'] = req.filename;
    const res = await fetchImpl(`${base}${path}?workflow=${encodeURIComponent(req.workflow)}`, {
      method: 'POST',
      headers,
      body: req.bytes,
    });
    return parse<T>(res);
  }

  return {
    whatsNext: (req, signal) => opts.routingSession !== undefined || req.routing !== undefined
      ? scopedPost<WhatsNextResponse>('whats_next', req, signal)
      : post<WhatsNextResponse>('whats_next', req, signal),
    getOrder: (req, signal) => opts.routingSession !== undefined
      ? scopedPost<GetOrderResponse>('get_order', req, signal)
      : post<GetOrderResponse>('get_order', req, signal),
    openRoutingSession: (req, signal) => scopedPost('routing_session_open', req, signal, true),
    renewRoutingSession: (signal) => scopedPost('routing_session_renew', {}, signal),
    closeRoutingSession: (signal) => scopedPost('routing_session_close', {}, signal),
    routingOfferContext: (req, signal) => scopedPost('routing_offer_context', req, signal),
    putShiftOffer: (req, signal) => scopedPost('put_shift_offer', req, signal),
    readRoutingClaim: (req, signal) => scopedPost('read_routing_claim', req, signal),
    readInvocationBinding: (req, signal) => scopedPost('read_invocation_binding', req, signal),
    reportLaunch: (req, signal) => scopedPost('report_launch', req, signal),
    reserveLaunch: (req, signal) => scopedPost('reserve_launch', req, signal),
    routingHeartbeat: (req, signal) => scopedPost('heartbeat', req, signal),
    routingSubmit: (req, signal) => scopedPost('submit', req, signal),
    routingRelease: (req, signal) => scopedPost('release', req, signal),
    routingAsk: (req, signal) => scopedPost('routing_ask/v1', req, signal),
    routingReject: (req, signal) => scopedPost('routing_reject/v1', req, signal),
    routingRequestApproval: (req, signal) => scopedPost('routing_request_approval/v1', req, signal),
    routingPutFileArtifact: (req, signal) => scopedFileArtifact(req, signal),
    routingGetFileArtifact: (req, signal) => scopedFileArtifactRead(req, signal),
    assessLocalModel: (req, signal) => scopedPost<LocalModelResponse>('assess_local_model', req, signal),
    // Hosted-holder preflight only. Routing orders return routing-unsupported;
    // get_order plus read_routing_claim supply Jev authority instead.
    getReferenceOrder: (req) => opts.routingSession !== undefined
      ? scopedPost<unknown>('reference_order/v1', req)
      : post<unknown>('reference_order/v1', req),
    heartbeat: (req) => post<HeartbeatResponse>('heartbeat', req),
    release: (req) => post<ReleaseResponse>('release', req),
    submit: (req) => post<SubmitResponse>('submit', req),
    submitConditional: (req) => post<ConditionalSubmitResponse>('submit/conditional-v1', req),
    reject: (req) => post<RejectResponse>('reject', req),
    ask: (req) => post<AskResponse>('ask', req),
    retryArtifact: (req) => post<RetryArtifactResponse>('retry_artifact', req),
    requestApproval: (req) => post<RequestApprovalResponse>('request_approval', req),
    answerApproval: (req) => post<AnswerApprovalResponse>('answer_approval', req),
    listPendingApprovals: () => post<ListPendingApprovalsResponse>('list_pending_approvals', {}),
    reportResolution: (req) => post<ReportResolutionResponse>('report_resolution', req),
    // Bearer-only identity bootstrap. Routed clients still pin HTTPS origin
    // and disallow redirects, but send no routing-session capability here.
    whoami: (signal) => get<WhoamiResponse>('whoami', undefined, signal),
    getRosters: (signal) => get<GetRostersResponse>('rosters', undefined, signal),
    listHarnessModels: () => get<ListHarnessModelsResponse>('harness_models'),
    // Cursor is an opaque non-negative integer; omit it entirely to bootstrap
    // (the hub treats missing/invalid as a `changed: true` first sweep).
    wake: (cursor, signal) =>
      get<WakeResponse>('wake', typeof cursor === 'number' ? `cursor=${encodeURIComponent(String(cursor))}` : undefined, signal),
    presencePing: (req, signal) => post<PresencePingResponse>('presence_ping', req, signal),
    putFileArtifact: (req) => postBytes<PutFileArtifactResponse>('/api/file-artifacts', req),
  };
}
