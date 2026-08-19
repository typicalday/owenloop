/**
 * Local JSON-lines protocol for the foreground shift daemon.
 *
 * The protocol is deliberately small: one request per Unix-socket connection,
 * one response line, then the connection closes. The hub remains the owner of
 * workflow state; this protocol only carries local dispatch observations and
 * attendance commands between the CLI and one daemon process.
 */

export const SHIFT_SOCKET_NAME = 'shift.sock';
export const DEFAULT_NEXT_WAIT_MS = 90_000;
export const MAX_REQUEST_LINE_BYTES = 64 * 1024;
/**
 * The server measures each response's serialized UTF-8 byte length against this
 * ceiling and retains FIFO events that do not fit. A single event whose fields
 * exceed the ceiling is rendered with an explicit truncation marker.
 */
export const MAX_RESPONSE_LINE_BYTES = 512 * 1024;
export const RESPONSE_TRUNCATION_MARKER = '[truncated]';
export const MAX_EVENT_QUEUE = 1_000;
export const OVERLAP_ERROR = 'whats_next is already parked — one park at a time (cancel it or wait for it to return)';
export const NO_DAEMON_SUFFIX = ' — start one with: owenloop shift start <crew…>';

export type ShiftRequest =
  | { op: 'next'; wait_ms: number }
  | { op: 'status' }
  | { op: 'clock_in'; serve_crews: string[]; name: string }
  | { op: 'end' };

export interface DispatchedEvent {
  type: 'dispatched';
  workflow: string;
  run: string;
  step: string;
  kind: 'exec' | 'agent-run';
  pid: number;
}

export interface ReapedEvent {
  type: 'reaped';
  workflow: string;
  run: string;
  kind: 'exec' | 'agent-run';
  pid: number;
}

export interface FailedEvent {
  type: 'failed';
  workflow: string;
  run: string;
  step: string;
  kind: 'exec' | 'agent-run';
  harness?: string;
  executable?: string;
  exitStatus?: number | null;
  signal?: NodeJS.Signals | null;
  message: string;
}

/** Reserved for a future local representation of a pending hub gate. */
export interface GateEvent {
  type: 'gate';
  workflow?: string;
  run?: string;
  name?: string;
  question?: string;
}

export interface EndedEvent {
  type: 'ended';
}

/**
 * The shift announced its identity and started serving. The FIRST record a
 * shift writes, so a reader can place every later record on the same machine
 * without external context. `shift` and `shiftId` are not repeated here: they
 * are on the envelope of this and every other record.
 *
 * FILE-ONLY. Written to `shift.log` and never delivered over the socket. An
 * idle `owenloop shift next` must BLOCK until there is work to report, and a
 * startup record sitting in the FIFO would satisfy the first `next` after every
 * start. A socket client needs none of this — it knows which shift it reached
 * because it connected to that shift's socket, and `op: 'status'` answers name,
 * crews, and cap on demand.
 */
export interface ParkedEvent {
  type: 'parked';
  origin: string;
  cap: number;
  serveCrews: string[];
  hostname: string;
  cwd: string;
}

/**
 * No local capacity, so the `whats_next` SWEEP was deferred. Explains a shift
 * that is running nothing new while work remains outstanding.
 *
 * NOT "the hub was not polled" — `opts.hub.wake(cursor)` runs every tick
 * regardless of local capacity. Only the follow-up sweep is skipped, so this
 * record means "there was news and I had nowhere to put it".
 *
 * EDGE-TRIGGERED: AT MOST one record per unbroken stretch at capacity, emitted
 * when the shift ENTERS that state, not once per tick while it stays there. How
 * long the stretch lasted is recoverable from the next record's `ts`.
 *
 * At most, not exactly: the emit sits inside `loop.ts`'s `changed && k <= 0`
 * branch, so it needs a wake that reports a CHANGED cursor. A shift that fills
 * up and stays full while the hub reports nothing new produces no record at all,
 * and the absence of one is not evidence the shift had free slots.
 *
 * FILE-ONLY, for the same reason as `ParkedEvent`. On the socket it is both
 * redundant and harmful: every `ShiftCapacity` response already carries live
 * `cap`, `free`, and `running`, so this record restates on the wire what the
 * response states anyway — and queueing it satisfies a parked `next` with news
 * that nothing happened. In the file, which has no response envelope, it is the
 * only thing distinguishing a saturated shift from an idle one.
 */
export interface CapacityEvent {
  type: 'capacity';
  inFlight: number;
  cap: number;
}

/** A hub call failed. `workflow` is present only for per-workflow whats_next calls. */
export interface HubErrorEvent {
  type: 'hub-error';
  op: 'wake' | 'whats_next' | 'roster_sync' | 'release';
  workflow?: string;
  message: string;
}

/** A legacy order named a def with no cached bundle, so it was left for pickup. */
export interface BundleMissEvent {
  type: 'bundle-miss';
  workflow: string;
  def: string;
}

/**
 * The shift refused one order. Capacity and expiry reasons hand its claim back
 * to the hub; malformed and unsupported reasons leave it for the pickup
 * window. A dropped unit of work is a record, not a debug aside. `reason` is
 * the stable machine discriminator; `message` is the human text.
 */
export interface OrderDroppedEvent {
  type: 'order-dropped';
  workflow: string;
  run: string;
  step: string;
  reason:
    | 'malformed-digest'
    | 'malformed-worker'
    | 'unsupported-worker'
    | 'verification-failed'
    | 'metadata-unavailable'
    | 'agent-lane-closed'
    | 'dispatch-cap-full'
    | 'agent-cap-full'
    | 'claim-expired';
  message: string;
}

/**
 * The socket event FIFO overflowed and discarded its oldest event. Written
 * STRAIGHT to the file sink, never through the loop's `emit()` — `emit()` feeds
 * the very queue that overflowed, so routing this through it would recurse
 * under exactly the load that produced it. `dropped` is cumulative for the
 * shift process, so each record states the running total lost so far.
 */
export interface EventQueueOverflowEvent {
  type: 'event-queue-overflow';
  dropped: number;
}

/**
 * What a construction site builds: the event's own payload, with no identity
 * and no timestamp. Every consumer receives the stamped `ShiftEvent` instead.
 */
export type ShiftEventBody =
  | DispatchedEvent
  | ReapedEvent
  | FailedEvent
  | GateEvent
  | EndedEvent
  | ParkedEvent
  | CapacityEvent
  | HubErrorEvent
  | BundleMissEvent
  | OrderDroppedEvent
  | EventQueueOverflowEvent;

/**
 * The identity every event carries, added once on a shared envelope rather than
 * per variant.
 *
 * This is what makes one record SELF-DESCRIBING: a consumer holding a single
 * line from an unknown machine can place it in time (`ts`) and attribute it to
 * one shift process (`shiftId`) with no external context. That property is what
 * lets the on-disk log, the socket, and a future uploader be three consumers of
 * ONE contract instead of three shapes.
 */
export interface ShiftEventEnvelope {
  /** ISO-8601 UTC with milliseconds, e.g. `2026-08-13T18:04:11.412Z`. */
  ts: string;
  /** The shift's human name — live-mutable via `clock_in`, so it can change between records. */
  shift: string;
  /** The shift process incarnation's id (`shf_<uuid>`); `''` when undeclared. Stable for the process. */
  shiftId: string;
}

/** A body plus its envelope: what every consumer actually receives. */
export type ShiftEvent = ShiftEventBody & ShiftEventEnvelope;

/** Who emitted an event. `id` is `''` when the emitter declared no shift id. */
export interface ShiftIdentity {
  name: string;
  id: string;
}

/**
 * Stamp a body with its envelope. The ONE place the envelope is constructed —
 * every emitter (the loop's `emit()`, the daemon's `ended`, the runtime's worker
 * failures and startup record) routes through here so no consumer can receive a
 * half-stamped record.
 */
export function stampShiftEvent(
  body: ShiftEventBody,
  identity: ShiftIdentity,
  now: number,
): ShiftEvent {
  return {
    ...body,
    ts: new Date(now).toISOString(),
    shift: identity.name,
    shiftId: identity.id,
  };
}

export interface ShiftCapacity {
  cap: number;
  free: number;
  running: number;
  events: ShiftEvent[];
}

export interface ShiftStatus {
  name: string;
  serve_crews: string[];
  cap: number;
  free: number;
  running: number;
  agent_ceiling: number;
  attended_at: number | null;
  started_at: number;
}

export interface ShiftError {
  error: string;
}

export type ShiftResponse = ShiftCapacity | ShiftStatus | ShiftError | { ok: true; ended: true };

export function isShiftError(value: unknown): value is ShiftError {
  return typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string';
}
