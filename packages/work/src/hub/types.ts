/**
 * Typed request/response shapes for the remote coordinator's transport surface.
 * Every response carries human-readable `text` plus the verb-specific data.
 * Payloads stay loose where callers do not consume a field directly.
 */

/** Common envelope: every verb returns a human-readable `text` plus verb data. */
export interface HubResponse {
  text: string;
}

// ---- whats_next -------------------------------------------------------------

export interface WhatsNextRequest {
  routing?: { kind: 'ready_firing' | 'child' | 'crew' | 'shift'; frameId?: string; callPath?: string };
  workflow?: string;
  /** Server-side filter for which serve crews this caller will accept. */
  serve_crews?: string[];
  /**
   * Capability keys in this shift's effective merged rosters. Keys are raw:
   * bare names and exact compounds may be mixed; the hub applies bare-name
   * matching. An empty array legitimately means the shift serves nothing.
   */
  serve_capabilities: string[];
}

/**
 * One work order from a per-workflow `whats_next` sweep. `run` is the order
 * identifier used by the other transport verbs. The work order is routing and
 * dynamic input data; authored instruction text is resolved from the local
 * workflow store by the worker.
 */
export interface WorkOrder {
  routing?: ReferenceRouting;
  workflow: string;
  run: string;
  step: string;
  /** Target reference-order fields; optional because the deployed hub may omit them. */
  key?: string;
  index?: number;
  defDigest?: string;
  /** The composed capabilities the hub offered this order under. */
  capabilities?: string[];
  /**
   * THE CREWS THE HUB MATCHED for this order's capabilities, in match order.
   * Hub → worker; this is not `serve_crews`, which travels worker → hub to
   * narrow the orders a shift wants.
   */
  crews?: string[];
  /** Authoritative worker lane on modern whats_next responses. */
  worker?: string;
  consumedFingerprint?: Record<string, number>;
  owes?: Array<{
    path: string;
    /**
     * The TARGET version for this owed output when a version-aware hub
     * projects it: the version the next successful producer commit lands
     * (claim-time committed version + 1), NOT the currently-committed one.
     * It is what a producer signs in its submission proof and what a
     * downstream consumer checks that proof against.
     */
    version?: number;
    judgmentRejects: number;
    schemaRejects: number;
    reasons: ReasonEntry[];
    proof?: string;
  }>;
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
 * `serve_crews` omitted means OVERWRITE-to-empty hub-side (a ping is the full
 * current truth about a Shift), so always send the crews this shift
 * serves (source: hub-core `verbs/presence-ping.ts`).
 *
 * `shift_id`/`started_at` are W7's self-declared attribution fields — the
 * Shift process incarnation id (`shf_<uuid>`, regenerated every restart,
 * never persisted) and its process start time. Advisory only (D8/INV-82):
 * never used for authorization, routing, dispatch, or claim correctness.
 *
 * WIRE CONVENTION (deliberate, do not "normalize"): these two top-level fields
 * are snake_case even in TS, mirroring the hub's wire body verbatim — unlike
 * `ContactHolder.shiftId` below, whose nested object keys are camelCase on
 * the wire. Both conventions are correct for where they live.
 */
export interface PresencePingRequest {
  name: string;
  serve_crews?: string[];
  /**
   * Capability keys in this shift's effective merged rosters. Keys are raw:
   * bare names and exact compounds may be mixed; the hub applies bare-name
   * matching. An empty array legitimately means the shift serves nothing.
   */
  serve_capabilities: string[];
  shift_id?: string;
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
 * `shiftId` (W7) is the self-declared Shift process incarnation id
 * (`shf_<uuid>`) that dispatched this holder, when known — advisory only
 * (D8/INV-82), never used for authorization/routing/dispatch/claim decisions.
 * Nested-object convention: camelCase on the wire (unlike `PresencePingRequest`'s
 * top-level snake_case fields above) — this asymmetry is deliberate.
 */
export interface ContactHolder {
  kind: 'session' | 'exec';
  id: string;
  shiftId?: string;
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
 * The persisted order packet re-served by the transport. The packet carries
 * the definition projection digest and dynamic routing/state fields only.
 * Workers must resolve authored command or prompt text from the local store.
 * Proof/version fields describe the target protocol and remain optional because
 * the deployed hub can omit them; optionality does not imply end-to-end support.
 */
export interface OrderPacket {
  routing?: ReferenceRouting;
  run: string;
  workflow: string;
  step: string;
  key: string;
  index?: number;
  /** Projection digest identifying the installed definition snapshot. */
  defDigest: string;
  inputs: string[];
  outputs: string[];
  /** Opaque location hint — the worker's cwd when set. */
  workdir?: string;
  /**
   * THE COMPOSED CAPABILITIES this order was offered under, in the step's
   * authored order — `['build:deep']` for a `build` step on a `deep` run. This
   * is the key into the shift's merged crew roster (see
   * `src/agent/capability-model.ts`), and therefore what decides which
   * harness, model, and effort run. Absent from a pre-modifier hub, which is why the worker treats
   * an empty list as "nothing to resolve against" and refuses rather than
   * guessing.
   */
  capabilities?: string[];
  /**
   * THE CREWS THE HUB MATCHED for this order's capabilities, in match order.
   *
   * Hub → worker. This is the hub's answer to "whose roster decides the model
   * for this order", computed at offer time from `capability_routes`. The
   * worker resolves each named crew's merged roster IN THIS ORDER and takes the
   * first crew that carries a row for one of `capabilities`.
   *
   * NOT `serve_crews`. `serve_crews` travels the other way — worker → hub,
   * on `whats_next`/`presence_ping` — and narrows WHICH ORDERS THIS SHIFT
   * WANTS. This field narrows WHICH ROSTER DECIDES an order the shift already
   * has.
   *
   * Optional on the wire because a hub that predates the stamp sends nothing.
   * It is NOT optional in effect: a worker built from this commit REFUSES every
   * capability-bearing order that arrives without it. There is no fallback.
   */
  crews?: string[];
  /** The run's routing modifier (`deep`), as the caller asked for at start_run. */
  modifier?: string;
  /**
   * `true` when the engine re-offered this step at its escalation target instead
   * of the run's own modifier. The worker does not act on it; it goes in the
   * brief so the agent knows it is on the recovery path.
   */
  escalated?: boolean;
  /**
   * DEPRECATED, and no longer read by the agent loop. The def's authored tier
   * name (`strong`) from the pre-modifier scheme. The hub still projects it for
   * older workers; this one resolves from `capabilities` alone.
   */
  model?: string;
  /** Worker kind; `'command'` for command orders, absent means agent. */
  worker?: string;
  /** Artifact stem this order's judge step must verdict, when present. */
  judge?: string;
  spec?: Record<string, unknown>;
  x?: Record<string, unknown>;
  consumes: Record<string, unknown>;
  /** Claim-time consumed versions when a compatible hub preserves the map. */
  consumedFingerprint?: Record<string, number>;
  /** Serialized submission proof for the consumed values, projected by a
   *  proof-aware hub. Absent from any hub that does not store submit proofs;
   *  consume-side verification then reports the artifact as unproven. */
  consumesProof?: string;
  /** Calls-boundary relay hints, keyed by the PARENT artifact path. When a
   *  consumed path was produced by a `calls:` step, no submission record can
   *  exist for the parent path: the engine folds the child's outcome into it
   *  without a `submit`. A relay-aware hub places the CHILD's own signed
   *  submission record under the parent path in `consumesProof` and names
   *  here the child it came from: the child definition digest the parent pins,
   *  the pinned child outcome version, and the child outcome stem. A worker
   *  corroborates every hint against its verified local definition bytes
   *  before trusting the record; the hints never admit a proof-less path. */
  consumesProofRelay?: Record<string, { childDefDigest: string; childVersion: number; childOutcome: string }>;
  /** The owed outputs and their reason threads. */
  owes: Array<{
    path: string;
    /** Target version for this output's next successful commit (claim-time
     *  committed version + 1), issued by a version-aware hub inside the claim
     *  transaction. This is what a producer signs in its submission proof.
     *  Absent from a hub that is not version-aware, which leaves the producer
     *  submit unsigned. */
    version?: number;
    judgmentRejects: number;
    schemaRejects: number;
    reasons: ReasonEntry[];
    /**
     * The value this path already holds, projected by a hub new enough to send
     * it and ONLY on a re-offer whose reason thread is non-empty. Absent on a
     * first offer, absent from an older hub, and absent when the refusal never
     * committed a value.
     *
     * It is the REFUSED value only after a judgment or human reject, which
     * follow a commit. A schema reject refuses the write, so after one this
     * carries the last value that did commit, or nothing. Read `reasons` when
     * the distinction matters; the engine's contract is on `Order.owes[]` in
     * `src/types.ts`.
     *
     * Transport-only until the value and its version have independent
     * provenance. A reason-thread proof does not authenticate this adjacent
     * value, so native get_order and cold replay do not display it.
     */
    previousValue?: unknown;
    /**
     * The JSON Schema the engine will enforce on this output at commit time,
     * projected off the owning produce entry by a schema-aware hub. Absent
     * when the produce declares none (the common case — any JSON is accepted),
     * and absent from every hub too old to project the field at all. Those two
     * cases are indistinguishable on the wire. The native brief derives its
     * shape from the locally verified definition instead of this field.
     */
    schema?: unknown;
    /**
     * What `schema` governs — `'value'` for the submitted value itself
     * (singleton produce, or one element of a map produce), `'member'` for
     * each member emitted into a collection rather than the seal value the
     * path names. Projected together with `schema` and meaningless without it.
     */
    schemaAppliesTo?: 'value' | 'member';
    /** Target-protocol reason-thread proof; the deployed hub may omit it. */
    proof?: string;
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
  requested?: string;
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

// ---- report_resolution ------------------------------------------------------

/**
 * Which settings row served the order, mirroring hub-core's `ResolutionMatch`.
 * `refused` is a real, reportable outcome: the shift found no row and will not
 * launch anything, and that is exactly the fact worth recording.
 */
export type ResolutionMatch = 'exact' | 'bare' | 'refused';

export interface ResolutionPayload {
  /** The settings key that matched (`build:deep`, or `build` on a bare match). */
  capability: string;
  match: ResolutionMatch;
  /** Absent on `refused`, and on a command order, which selects no model. */
  model?: string;
  effort?: string;
  harness?: string;
}

export interface ReportResolutionRequest {
  workflow: string;
  run: string;
  resolution: ResolutionPayload;
}

/**
 * The hub is idempotent by order id: `recorded: false` means a report for this
 * run already stood and was left unchanged. `claimed` is the live lease state,
 * disclosed and never enforced — a `false` here means the order is no longer
 * this worker's to run.
 */
export interface ReportResolutionResponse extends HubResponse {
  workflow: string;
  run: string;
  step: string;
  recorded: boolean;
  claimed: boolean;
}

// ---- release ----------------------------------------------------------------

// Exactly one form, mirroring the server's XOR: drain a whole session, OR
// release one targeted (workflow, run, optional reason).
export type ReleaseRequest = { session: string } | { workflow: string; run: string; reason?: string };

/**
 * Response shapes mirror hub-core `verbs/release.ts` (verified 2026-07-18):
 *  - by-session: `{ released: Array<{workflow, run}> }` — the agent-held claims
 *    that were re-offered (empty when nothing was held). Exec-held claims are
 *    excluded server-side (SQL `holder_kind = 'exec'` is not in the session
 *    set); the hub does NOT enumerate them, so the client can only NOTE the
 *    drain-exempt-ion, never list which claims were exempt.
 *  - targeted: `{ released: boolean, reason?, workflow?, run? }` — idempotent
 *    (a not-held target is `released: false`, not an error).
 *    Targeted requests may carry an optional `reason`; the hub trims it,
 *    treats blank text as absent, truncates it to 1024 Unicode code points
 *    without splitting surrogate pairs, and records whether truncation
 *    occurred. It retains only the first observation for a workflow/step.
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
  /** Target-protocol DSSE envelope; production submit transport currently drops it. */
  proof?: string;
  /** W7: who produced this submission (D4) — carried on all three submit paths. */
  holder?: ContactHolder;
}

/** This request must use the versioned route; older hubs have no such route. */
export interface ConditionalSubmitRequest extends SubmitRequest {
  expectedVersion: number;
}

/**
 * submit's flattened `{ text, ...data }` envelope (verified against hub-core
 * `verbs/submit.ts` + hub-edge `routes.ts` on 2026-07-17). `outcome` is the
 * commit verdict: `green`/`submitted` are success (the value landed);
 * `schema-rejected`/`born-rejected`/`artifact-too-large`/
 * `artifact-normalization-failed` are failures. `closed` reports whether that
 * submit closed the run (only present on a `green`/`submitted` outcome). The
 * deployed response does not return the committed version, the next target
 * version, proof acceptance, or an idempotency result. exec treats any
 * non-green/submitted outcome as a failed submit (exit 1).
 */
export interface SubmitResponse extends HubResponse {
  outcome?: string;
  closed?: boolean;
}

export interface ConditionalSubmitResponse extends SubmitResponse {
  conditionApplied: 'expected-version-v1';
}

/** Parent-owned exact-byte routed conditional submit. No child chooses these
 * fields; the broker freezes them before the first network dispatch. */
export interface RoutedConditionalMutationRequest {
  intentId: string;
  rawBody: string;
  generationToken?: string;
}
export interface RoutedConditionalMutationResponse extends SubmitResponse {
  conditionApplied: 'routed-conditional-receipt-v1';
}
export interface RoutedConditionalReceiptRequest {
  workflow: string; run: string; intentId: string; requestDigest: string;
  holder: RoutedCollectionHolder;
}
export type RoutedConditionalReceiptResponse =
  | { state: 'pending' | 'unavailable' }
  | { state: 'committed'; result: RoutedConditionalMutationResponse };
export interface RoutedConditionalRetryIssueResponse {
  generation: number; generationToken: string; requestDigest: string; expiresAt: number;
}

/** Versioned, session-scoped collection protocol. The child never supplies a
 * member path or proof to Shift; these wire requests are parent-owned. */
export interface RoutedCollectionHolder extends ContactHolder { shiftId: string }
export interface RoutedMemberIssueRequest {
  workflow: string; run: string; sealPath: string; emissionId: string;
  valueDigest: string; holder: RoutedCollectionHolder;
}
export interface RoutedMemberIssueResponse {
  emissionId: string; sealPath: string; sealTargetVersion: number;
  memberPath: string; memberVersion: 1; valueDigest: string;
  conditionApplied: 'routed-collection-member-v1';
}
export interface RoutedMemberEmitRequest {
  workflow: string; run: string; emissionId: string; memberPath: string;
  memberVersion: 1; value: Record<string, unknown>; proof: string;
  holder: RoutedCollectionHolder;
}
export interface RoutedMemberCancelRequest {
  workflow: string; run: string; emissionId: string; requestDigest: string;
  holder: RoutedCollectionHolder;
}
export interface RoutedCollectionSealRequest {
  workflow: string; run: string; sealPath: string; sealTargetVersion: number;
  sealId: string; proof: string; holder: RoutedCollectionHolder;
}
export interface RoutedCollectionReceiptRequest {
  workflow: string; run: string; kind: 'member' | 'seal'; id: string;
  sealPath: string; sealTargetVersion: number; requestDigest: string;
  holder: RoutedCollectionHolder; proofDigest?: string;
}
export interface RoutedCollectionWriteResponse {
  outcome: string; closed: boolean; emitted?: string[]; sealed?: string;
  issues?: unknown; conditionApplied: 'routed-collection-member-v1' | 'routed-collection-seal-v1';
}
export interface RoutedCollectionReceiptResponse {
  state: 'pending' | 'emitted' | 'rejected' | 'sealed';
  result?: RoutedCollectionWriteResponse;
}

// ---- file artifacts ---------------------------------------------------------

/**
 * Upload opaque bytes and get back the small JSON envelope that names them.
 *
 * This is the one hub call that does NOT send JSON. The bytes go up as the raw
 * request body with their own content type, because a base64 round-trip would
 * inflate a large asset by a third and force the whole file through a string.
 */
export interface PutFileArtifactRequest {
  /** Workflow the blob belongs to — it scopes the R2 key and its retention. */
  workflow: string;
  bytes: Uint8Array;
  /** MIME type recorded in the envelope and served back on download. */
  contentType: string;
  /** Optional display name; the hub records it verbatim and never trusts it as a path. */
  filename?: string;
}

/**
 * The envelope, which IS the artifact value. `__file` is the discriminator the
 * hub's pointer walk looks for; `hash` identifies the uploaded bytes, while
 * the key is unique to this routed upload attempt. `size` and `contentType` describe bytes a def can
 * constrain with ordinary JSON Schema even though it can never see them.
 */
export interface FileArtifactPointer {
  /** Opaque R2 object key returned by Service, never a boolean marker. */
  __file: string;
  hash: string;
  size: number;
  contentType: string;
  filename?: string;
}

export interface PutFileArtifactResponse extends HubResponse, FileArtifactPointer {}

// ---- reject -----------------------------------------------------------------

/**
 * Invalidate an artifact through the claiming worker's consume-edge authority.
 * `by` is deliberately absent: the hub derives the actor from the claiming
 * run's step, so a worker cannot impersonate another step.
 */
export interface RejectRequest {
  workflow: string;
  run: string;
  path: string;
  text: string;
  /** Optional declared modifier requested from the input artifact's producer. */
  requested?: string;
}

/** The reject verb's flattened response envelope. */
export interface RejectResponse extends HubResponse {
  ok: boolean;
  closed?: boolean;
}

// ---- retry artifact ---------------------------------------------------------

/**
 * The HUMAN stall-clearing lever and answer path for ask. Re-arms a stalled or
 * rejected artifact to owed, resetting its reject counters. text rides to the
 * next producer on the artifact's reason thread; omit it for a bare
 * stall-clear so the engine supplies its own default.
 */
export interface RetryArtifactRequest {
  workflow: string;
  path: string;
  text?: string;
}

/** The retry-artifact verb's flattened response envelope. */
export interface RetryArtifactResponse extends HubResponse {
  ok: boolean;
  closed?: boolean;
}

// ---- ask --------------------------------------------------------------------

/**
 * ESCALATION: the claiming worker cannot honestly build what it owes and stops
 * to ask a person. `path` is one of the order's OWED paths — unlike `reject`,
 * whose `path` is somebody else's delivered work, this is the worker's own debt.
 *
 * `by` is absent for the same reason it is absent on `reject`: the hub derives
 * the actor from the claiming run's step, so a worker cannot ask on another
 * step's behalf. `question` is what the human is being asked; `context` is
 * optional supporting detail (what the worker already tried, which files it
 * read) that rides the same reason-thread entry so the answering human does not
 * have to reconstruct it from logs.
 */
export interface AskRequest {
  workflow: string;
  run: string;
  path: string;
  question: string;
  context?: string;
}

/**
 * The ask verb's flattened envelope. `closed` reports whether the escalation
 * closed the worker's run — it does, always: a worker that has asked has
 * nothing further to do on this order, and holding the lease open would only
 * let it expire into a reap.
 */
export interface AskResponse extends HubResponse {
  ok: boolean;
  closed?: boolean;
}

// ---- tool approvals ---------------------------------------------------------

/**
 * The DETERMINISTIC TOOL-APPROVAL gate — the fine-grained sibling of `ask`, and
 * deliberately not the same mechanism.
 *
 * `ask` is a worker declaring it cannot honestly build what it OWES: it freezes
 * the artifact, CLOSES the run, and its answer reaches a FRESH worker. This is a
 * worker mid-flight needing yes/no on ONE tool call: the session is alive and
 * stays alive, the run does not close, no attempt is burnt, and the answer comes
 * back to the very same blocked call.
 *
 * ONE VERB SERVES BOTH RAISE AND POLL. `toolUseId` is the harness's own id for
 * the blocked call, so a repeat of this request is unambiguously the same
 * question rather than a new one — the hub re-reads the existing row instead of
 * opening a second. A worker therefore raises and polls with identical calls and
 * never has to track whether it already asked.
 *
 * `step` is ABSENT for the same reason it is absent on `ask` and `reject`: the
 * hub derives it from the claiming run's row, so a worker cannot raise an
 * approval stamped to another step.
 */
export interface RequestApprovalRequest {
  workflow: string;
  run: string;
  /** The harness's id for the blocked call. The approval's identity, with `run`. */
  tool_use_id: string;
  /** The tool the harness was about to invoke, e.g. `Bash`. */
  tool_name: string;
  /** The call's arguments. A non-string is JSON-stringified by the hub edge. */
  tool_input: unknown;
  /** Why the gatekeeper would not allow this on its own — written for a person. */
  reason: string;
  /** The harness's own one-line rendering of the prompt, when it supplies one. */
  title?: string;
}

/** `pending` is the only state a worker waits on. An unrecognized stored state
 *  reads as `expired` hub-side, never `pending`. */
export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired';

/** One approval as the hub reports it. */
export interface ApprovalView {
  workflow: string;
  run: string;
  toolUseId: string;
  /** Derived hub-side from the claiming run — never what the caller said. */
  step: string;
  toolName: string;
  reason: string;
  title: string;
  state: ApprovalState;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  note: string | null;
}

/**
 * `ok: false` with `reason: 'not-held'` means the claim this approval belonged
 * to is gone — the worker's lease ended while it waited. That is a REFUSAL, not
 * a denial: nothing was written, and there is no longer anyone the answer could
 * come back to.
 */
export interface RequestApprovalResponse extends HubResponse {
  ok: boolean;
  reason?: string;
  approval?: ApprovalView;
}

/** The human half. Not called by a worker — an agent token is deliberately
 *  refused this verb, because an agent that could answer its own approval could
 *  approve every call it was just refused. */
export interface AnswerApprovalRequest {
  workflow: string;
  run: string;
  tool_use_id: string;
  decision: 'approve' | 'deny';
  note?: string;
}

export interface AnswerApprovalResponse extends HubResponse {
  ok: boolean;
  reason?: string;
  approval?: ApprovalView;
}

/** Only approvals whose worker is STILL holding its lease — a question nobody
 *  is waiting on is not shown, because answering it would do nothing. */
export interface ListPendingApprovalsResponse extends HubResponse {
  approvals: ApprovalView[];
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

// ---- org rosters ------------------------------------------------------------

/** One model choice in an org-owned roster row. */
export interface RosterCandidateWire {
  harness: string;
  model: string;
  effort: string;
}

/** The agent-readable org roster cascade. */
export interface GetRostersResponse extends HubResponse {
  global: Record<string, RosterCandidateWire[]>;
  crews: Array<{
    crewId: string;
    crewName: string | null;
    roster: Record<string, RosterCandidateWire[]>;
  }>;
}

/** The hub's current harness/model registry, for roster administration. */
export interface ListHarnessModelsResponse extends HubResponse {
  harnesses: Array<{ harness: string; displayName: string }>;
  models: Array<{ harness: string; model: string; efforts: string[]; updatedAt: number; updatedBy: string }>;
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
  /** Server-requested delay before retrying, normalized from Retry-After. */
  readonly retryAfterMs?: number;

  constructor(status: number, message: string, code?: string, retryAfterMs?: number) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    if (code !== undefined) this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

// ---- Authenticated routing: service ab73dce frozen REST DTOs -----------------
export type Sha256Digest = `sha256:${string}`;
export interface RoutingDefRef { bundleDigest: Sha256Digest; workflowName: string }
export interface MeaningRef { def: RoutingDefRef; step: string; tag: string; meaningDigest: Sha256Digest }
export interface RevisionVector {
  definition: string;
  candidates: string;
  policy: string;
  authority: string;
  rolePolicy: string;
  roster: string;
  routes: string;
  membership: string;
  evidenceGeneration: string;
}
export interface DecisionBindingV1 {
  orgId: string;
  runId: string;
  frameId: string;
  def: RoutingDefRef;
  subjectKey: string;
  evidenceDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
  policyDigest: Sha256Digest;
  revisions: RevisionVector;
  issuedAt: number;
  expiresAt: number;
  authority: { principalId: string; sessionId: string };
}
export type TaskRole = 'research' | 'implementation' | 'review' | 'judge';
export interface LocalModelTuple {
  id: string;
  harness: string;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}
export interface LocalTupleEligibility {
  tuple: LocalModelTuple;
  eligible: boolean;
  available: boolean;
}
/** Trusted user/authored policy, independent of any probabilistic ranking. */
export interface RoleModelPolicy {
  revision: string;
  unknownRole: 'refuse';
  rules: readonly { model: string; roles: readonly TaskRole[] }[];
}
export interface ShiftOffer {
  version: 'shift-offer-v1';
  /** Exact service protocol required by this offer, when local-model advice is opted in. */
  localModelProtocol?: 'local-model-assessment-v1';
  offerId: string;
  orgId: string;
  principalId: string;
  sessionId: string;
  shiftId: string;
  willingness: { runIds: readonly string[]; crewIds: readonly string[]; capabilities: readonly string[] };
  rosterRevision: string;
  rolePolicyRevision: string;
  tuples: readonly LocalTupleEligibility[];
  issuedAt: number;
  expiresAt: number;
}
export interface ShiftOfferContext {
  now: number;
  maxTtlMs: number;
  orgId: string;
  principalId: string;
  sessionId: string;
  shiftId: string;
  rosterRevision: string;
  rolePolicyRevision: string;
  runId: string;
  crewId: string;
  capability: string;
}
export type DecisionSelectionV1 =
  | { kind: 'workflow'; target: { candidateId: string; def: RoutingDefRef } }
  | { kind: 'child'; target: { candidateId: string; invocationKey: string; def: RoutingDefRef; meaning: MeaningRef } }
  | { kind: 'ready_firing'; target: { candidateId: string; firingId: string; step: string; key: string } }
  | { kind: 'crew'; target: { candidateId: string; crewId: string } }
  | { kind: 'shift'; target: { candidateId: string; shiftId: string; offerId: string } }
  | { kind: 'local_model'; target: { candidateId: string; tuple: LocalModelTuple } }
  | { kind: 'judge'; target: { candidateId: string; judgeId: string; tuple: LocalModelTuple } };
export type CapabilityMappingSelectionV1 = {
  kind: 'capability_mapping'; target: { candidateId: string; meaning: MeaningRef; capability: string };
};
export interface ArtifactRef { path: string; digest: Sha256Digest }
export interface SourceRef { commit: string; sourceDigest: Sha256Digest }
export type DecisionEffectRef =
  | { kind: 'workflow'; runId: string }
  | { kind: 'child'; invocationId: string; childRunId: string }
  | { kind: 'ready_firing'; firingId: string }
  | { kind: 'crew'; crewId: string }
  | { kind: 'shift'; claimId: string; orderId: string; attemptId: string }
  | { kind: 'local_model'; orderId: string; attemptId: string }
  | { kind: 'judge'; judgmentId: string }
  | { kind: 'capability_mapping'; mappingId: string };
export interface ClaimProofV1 {
  state: 'claimed';
  claimId: string;
  decisionId: string;
  binding: DecisionBindingV1;
  invocationId: string | null;
  orderId: string;
  attemptId: string;
  principalId: string;
  sessionId: string;
  shiftId: string;
}
export type LaunchObservationV1 =
  | { state: 'unknown' }
  | { state: 'reported'; tuple: LocalModelTuple }
  | { state: 'observed'; tuple: LocalModelTuple; pid: number; argv: readonly string[]; evidence: ArtifactRef };
export interface LaunchReportV1 {
  version: 'launch-v1';
  /** Required by live Service ingestion after reserve_launch. */
  reservationId?: string;
  decisionId: string;
  binding: DecisionBindingV1;
  claimId: string;
  orderId: string;
  attemptId: string;
  requested: LocalModelTuple | null;
  selected: LocalModelTuple | null;
  observation: LaunchObservationV1;
}
export interface LaunchReservationRequestV1 {
  version: 'launch-reservation-v1';
  claimId: string;
  decisionId: string;
  binding: DecisionBindingV1;
  orderId: string;
  attemptId: string;
  rosterRevision: string;
  /** Exact ordered local candidates submitted for assessment and launch. */
  candidateIds: string[];
  assessmentId: string | null;
  requested: LocalModelTuple | null;
  selected: LocalModelTuple | null;
}
export interface LaunchReservationResponse {
  reservationId: string;
  orderId: string;
  expiresAt: number;
}

export interface RoutingScope { workflows?: string[]; crews?: string[]; capabilities?: string[] }
export interface RoutingSessionOpenResponse {
  sessionId: string; shiftId: string; credential: string; expiresAt: number;
}
export type RoutingSessionRenewResponse = Omit<RoutingSessionOpenResponse, 'credential'>;
export interface RoutingOfferRequest {
  workflow: string; serve_capabilities: string[]; serve_crews?: string[]; frameId?: string;
}
export interface RoutingOfferSubmission { candidateId: string; crewId: string; capability: string; offer: ShiftOffer }
export interface RoutingOfferCandidate {
  candidateId: string; frameId: string; step: string; key: string; evidenceGeneration: string;
  context: ShiftOfferContext; role: string; rolePolicy: RoleModelPolicy; tuples: LocalTupleEligibility[];
  /** Present only when the candidate is authorized for local-model assessment. */
  localModelProtocol?: 'local-model-assessment-v1';
}
export interface RoutingOfferResponse { contexts: RoutingOfferCandidate[] }
export interface LocalModelPolicy {
  version: 'local-model-policy-v1';
  onFailure: 'fallback' | 'refuse';
}
export interface LocalModelRequest {
  workflow: string;
  run: string;
  candidateIds: string[];
}
export interface LocalModelAssessment {
  version: 'local-model-assessment-v1';
  assessmentId: string;
  workflow: string;
  frameId: string;
  definition: RoutingDefRef;
  decisionId: string;
  claimId: string;
  orderId: string;
  attemptId: string;
  anchorDigest: Sha256Digest;
  candidateIds: string[];
  candidateDigest: Sha256Digest;
  policy: {
    id: string;
    revision: string;
    digest: Sha256Digest;
    onFailure: 'fallback' | 'refuse';
  };
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'advisory' | 'fallback' | 'refused' | 'stale';
  reason: string;
  advised: LocalModelTuple | null;
  provider: {
    model: string;
    usage: { input_tokens: number; output_tokens: number };
    cost: null;
  } | null;
}
export interface LocalModelResponse {
  status: 'pending' | 'advisory' | 'fallback' | 'refused' | 'stale';
  reason: string;
  assessment: LocalModelAssessment | null;
}
export interface ReferenceRouting {
  claim: ClaimProofV1;
  decision: {
    decisionId: string; binding: DecisionBindingV1;
    status: 'applied' | 'advisory' | 'abstained' | 'no_fit' | 'stale' | 'unavailable' | 'fallback' | 'refused';
    applied: DecisionSelectionV1 | CapabilityMappingSelectionV1 | null; effect: DecisionEffectRef | null;
  };
  preference: { offer: ShiftOffer | null; tuples: readonly LocalTupleEligibility[]; role: string;
    rolePolicy: RoleModelPolicy | null; rosterRevision: string; expiresAt: number;
    localModel?: LocalModelPolicy };
}
export interface RoutingClaimReadResponse { routing: ReferenceRouting; freshness: 'fresh-at-read'; atomicLaunch: false }
export interface BindingDelegationV1 {
  version: 'binding-delegation-v1'; protocol: 'owenloop-binding-v1'; origin: string; orgId: string;
  scope: { workflowName: string; callPaths: string[] };
}
export interface InvocationBindingReadRequest {
  workflow: string; orderId: string; parentWorkflow: string;
  parentDefRef: import('../../../../src/types.ts').DefRef; callPath: string; parentArtifactVersion?: number;
}
export interface InvocationBindingReadResponse {
  protocol: 'owenloop-binding-v1'; origin: string; orgId: string;
  // Summary is deliberately NOT the complete native InvocationBinding.
  binding: Pick<import('../../../../src/types.ts').InvocationBinding, 'id' | 'key' | 'admission' | 'policyDigest' | 'candidateSetDigest'> & {
    selected: import('../../../../src/types.ts').InvocationCandidate;
  };
  bindingJson: string; bindingDigest: string;
  parentDefRef: import('../../../../src/types.ts').DefRef; childDefRef: import('../../../../src/types.ts').DefRef;
  relay: import('../../../../src/types.ts').VerifiedInvocationReceipt | null;
  freshness: 'fresh-at-read'; atomicLaunch: false;
}
export interface LaunchReportResponse {
  orderId: string; digest: string; recordedAt: number; provenance: 'authenticated-worker-report';
}
