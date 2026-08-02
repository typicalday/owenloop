/**
 * Typed request/response shapes for the hub verb surface owenloop's roles call.
 *
 * These mirror `apps/hub-edge/src/api/routes.ts` on owenloop-service `origin/main`
 * (B3 lifecycle verbs are merged). Every REST verb returns `{ text, ...data }`
 * where `data` is always an object, so each response extends `HubResponse`.
 *
 * Response payloads are typed LOOSELY on purpose: the roles that consume the
 * data fields (whats_next orders, get_order body, …) land in C3–C5. Honest-loose
 * (`unknown[]` + a TODO) beats invented-precise shapes no consumer reads yet.
 */

/** Common envelope: every verb returns a human-readable `text` plus verb data. */
export interface HubResponse {
  text: string;
}

// ---- whats_next -------------------------------------------------------------

export interface WhatsNextRequest {
  workflow?: string;
  /** Server-side filter for which serve pools this caller will accept. */
  serve_pools?: string[];
}

/**
 * One work order from a per-workflow `whats_next` sweep. Mirrors hub-core
 * `verbs/whats-next.ts` `WorkOrder` exactly. `run` IS the order id used by
 * every other hub verb; `step` is the def step name (matched against the
 * cached bundle to classify command vs agent). Fields the proxy does not
 * read yet (consumes/expected_outputs/feedback/advisory/submit_hint) are
 * mirrored for completeness — C4/C5 consume them.
 */
export interface WorkOrder {
  workflow: string;
  run: string;
  step: string;
  prompt: string;
  consumes: Record<string, unknown>;
  expected_outputs: Array<{ path: string; schema?: unknown }>;
  feedback: string[];
  advisory: { model?: string; tools?: string[] };
  submit_hint: string;
}

/** One instance row from an inbox-mode (`workflow` omitted) `whats_next`. */
export interface InboxInstance {
  workflow: string;
  def: string;
  done: boolean;
  eligible: number;
  blocked: number;
  owedSeededInputs: string[];
}

/**
 * The `{ text, ...data }` envelope of a `whats_next` response, flattened as
 * the REST layer serves it (`c.json({ text, ...data })`). Per-workflow mode
 * carries `workflow`/`def`/`orders`; inbox mode carries `instances`. Both are
 * optional because a single type covers both modes.
 */
export interface WhatsNextResponse extends HubResponse {
  /** Per-workflow mode: the instance id echoed back. */
  workflow?: string;
  /** Per-workflow mode: the def name (used to locate the cached bundle). */
  def?: string;
  /** Per-workflow mode: the served work orders (empty when nothing eligible). */
  orders?: WorkOrder[];
  /** Inbox mode (no `workflow`): the caller's servable instances. */
  instances?: InboxInstance[];
}

// ---- wake -------------------------------------------------------------------

/**
 * B5 `GET /api/wake?cursor=<n>` response. The cursor is the org's current max
 * `events.seq` (monotonic, never reused). `changed` is true when a servable
 * event exists strictly after the client's cursor; a missing/invalid cursor
 * bootstraps to `changed: true` with the real max seq. Always adopt the
 * returned cursor — it is monotonic by construction (source: hub-core
 * `verbs/wake.ts`).
 */
export interface WakeResponse extends HubResponse {
  cursor: number;
  changed: boolean;
}

// ---- presence_ping ----------------------------------------------------------

/**
 * B4 `POST /api/presence_ping` body. `name` is non-empty, ≤200 chars.
 * `serve_pools` omitted means OVERWRITE-to-empty hub-side (a ping is the full
 * current truth about a Conductor), so always send the pools this proxy
 * serves (source: hub-core `verbs/presence-ping.ts`).
 *
 * `conductor_id`/`started_at` are W7's self-declared attribution fields — the
 * Conductor process incarnation id (`cnd_<uuid>`, regenerated every restart,
 * never persisted) and its process start time. Advisory only (D8/INV-82):
 * never used for authorization, routing, dispatch, or claim correctness.
 *
 * WIRE CONVENTION (deliberate, do not "normalize"): these two top-level fields
 * are snake_case even in TS, mirroring the hub's wire body verbatim — unlike
 * `ContactHolder.conductorId` below, whose nested object keys are camelCase on
 * the wire. Both conventions are correct for where they live.
 */
export interface PresencePingRequest {
  name: string;
  serve_pools?: string[];
  conductor_id?: string;
  started_at?: number;
  /** Epoch-millisecond timestamp of the last accepted local shift attendance. */
  attended_at?: number;
}

/** B4 `presence_ping` response envelope (flattened `{ text, ...data }`). */
export interface PresencePingResponse extends HubResponse {
  ok: true;
  name: string;
  lastSeen: number;
}

// ---- holder tag -------------------------------------------------------------

/**
 * The holder identity a contacting process (`get_order`/`heartbeat`) tags its
 * claim with. Mirrors hub-core `claim-holders-table.ts` `ContactHolder`
 * exactly — the wire shape is an OBJECT, not a string (hub-edge passes
 * `body.holder` through verbatim). `kind` selects the drain policy (`exec` is
 * exempt from release-by-session, C6); `id` is the session id or exec process
 * identity. C4's `hold` always presents `{ kind: 'session', id }` (D5: `id`
 * falls back to `anon:<hostname>:<pid>` when no session id is configured — a
 * holder is now ALWAYS sent, never omitted).
 *
 * `conductorId` (W7) is the self-declared Conductor process incarnation id
 * (`cnd_<uuid>`) that dispatched this holder, when known — advisory only
 * (D8/INV-82), never used for authorization/routing/dispatch/claim decisions.
 * Nested-object convention: camelCase on the wire (unlike `PresencePingRequest`'s
 * top-level snake_case fields above) — this asymmetry is deliberate.
 */
export interface ContactHolder {
  kind: 'session' | 'exec';
  id: string;
  conductorId?: string;
}

// ---- get_order --------------------------------------------------------------

export interface GetOrderRequest {
  workflow: string;
  run: string;
  /** B3 holder tag distinguishing a session-hold from an exec run. */
  holder?: ContactHolder;
}

/**
 * Live lease state for a run, mirroring hub-core `get-order.ts`'s `lease`:
 * `claimed` is whether THIS run still holds its task's claim (with no terminal
 * `outcome`); `outcome` is set once the run has closed. hold reads these two to
 * classify a heartbeat failure — `outcome` set ⇒ the order finished (benign);
 * `claimed: false` with no outcome ⇒ the lease was lost.
 */
export interface Lease {
  claimed: boolean;
  claimedAt?: number;
  heartbeatAt?: number;
  outcome?: string;
}

/**
 * The persisted A1 order packet get_order re-serves, mirroring owenloop engine
 * `Order` (verified against owenloop-service `packages/engine-do/dist/vendor/
 * engine/engine.d.ts` on 2026-07-17). exec reads `command`/`worker`/`workdir`
 * to run the order and `owes` to know which output paths to submit the receipt
 * to; every other field is carried for completeness. `command` is opaque — the
 * engine never parses it; exec is the one process that shells it out.
 */
export interface OrderPacket {
  run: string;
  workflow: string;
  step: string;
  key: string;
  index?: number;
  inputs: string[];
  outputs: string[];
  /** Opaque location hint — exec's command cwd when set. */
  workdir?: string;
  model?: string;
  /** Executor kind; `'command'` for a command order, absent = `'agent'`. */
  worker?: string;
  /** The command string for a `worker: command` order (opaque). */
  command?: string;
  spec?: Record<string, unknown>;
  x?: Record<string, unknown>;
  prompt: string;
  consumes: Record<string, unknown>;
  /** The owed outputs + their reason threads — exec submits the receipt to each. */
  owes: Array<{
    path: string;
    acceptance: string;
    judgmentRejects: number;
    schemaRejects: number;
    reasons: ReasonEntry[];
  }>;
  cause?: string;
}

/** One entry in an artifact's append-only reason thread (loose mirror). */
export interface ReasonEntry {
  at: number;
  action: string;
  kind: string;
  by: string;
  text: string;
  fromVersion?: number;
}

export interface GetOrderResponse extends HubResponse {
  workflow: string;
  run: string;
  /** The persisted order packet, or `null` for a pre-v7 run. */
  order: OrderPacket | null;
  lease: Lease;
}

// ---- heartbeat --------------------------------------------------------------

// Heartbeat IS the lease renewal — there is no separate "renew" verb.
export interface HeartbeatRequest {
  workflow: string;
  run: string;
  holder?: ContactHolder;
}

export type HeartbeatResponse = HubResponse;

// ---- release ----------------------------------------------------------------

// Exactly one form, mirroring the server's XOR: drain a whole session, OR
// release one targeted (workflow, run).
export type ReleaseRequest = { session: string } | { workflow: string; run: string };

/**
 * Response shapes mirror hub-core `verbs/release.ts` (verified 2026-07-18):
 *  - by-session: `{ released: Array<{workflow, run}> }` — the agent-held claims
 *    that were re-offered (empty when nothing was held). Exec-held claims are
 *    excluded server-side (SQL `holder_kind = 'exec'` is not in the session
 *    set); the hub does NOT enumerate them, so the client can only NOTE the
 *    drain-exempt-ion, never list which claims were exempt.
 *  - targeted: `{ released: boolean, reason?, workflow?, run? }` — idempotent
 *    (a not-held target is `released: false`, not an error).
 *
 * The by-session form's `released` array is REQUIRED (the drain role reads it);
 * the targeted form's fields are all optional so callers that only do a
 * fire-and-forget targeted release (hold/exec's final breath) need not model
 * the payload — they ignore the response entirely.
 */
export interface ReleaseSessionResponse extends HubResponse {
  released: Array<{ workflow: string; run: string }>;
}

export interface ReleaseTargetedResponse extends HubResponse {
  released?: boolean;
  reason?: string;
  workflow?: string;
  run?: string;
}

export type ReleaseResponse = ReleaseSessionResponse | ReleaseTargetedResponse;

// ---- submit -----------------------------------------------------------------

export interface SubmitRequest {
  workflow: string;
  run: string;
  path: string;
  value: unknown;
  done?: boolean;
  /** W7: who produced this submission (D4) — carried on all three submit paths. */
  holder?: ContactHolder;
}

/**
 * submit's flattened `{ text, ...data }` envelope (verified against hub-core
 * `verbs/submit.ts` + hub-edge `routes.ts` on 2026-07-17). `outcome` is the
 * commit verdict: `green`/`submitted` are success (the value landed);
 * `schema-rejected`/`born-rejected`/`artifact-too-large`/
 * `artifact-normalization-failed` are failures. `closed` reports whether that
 * submit closed the run (only present on a `green`/`submitted` outcome). exec
 * treats any non-green/submitted outcome as a failed submit (exit 1).
 */
export interface SubmitResponse extends HubResponse {
  outcome?: string;
  closed?: boolean;
}

// ---- whoami -----------------------------------------------------------------

export interface WhoamiResponse extends HubResponse {
  orgId: string;
  orgName: string;
  actor: {
    id: string;
    kind: 'member' | 'agent';
    role: 'admin' | 'author' | 'operator' | 'agent';
    scopes: string[];
  };
  tokenStatus: 'active';
  authMethod: 'token' | 'oauth' | 'session' | 'debug';
  email?: string;
}

// ---- errors -----------------------------------------------------------------

/**
 * Thrown for any non-2xx hub response. `code` is the hub's `error` slug
 * (e.g. `bad_request`) when the body parsed as the hub's `{ error, message }`
 * JSON; otherwise `message` carries the raw response text.
 */
export class HubError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    if (code !== undefined) this.code = code;
  }
}
