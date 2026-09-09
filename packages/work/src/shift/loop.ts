/**
 * The self-driven shift loop core (D2 dispatch split).
 *
 * `createShiftLoop` is a standing Shift loop with every side-effecting
 * dependency injected (hub client, spawner, sleep/clock, output streams, dirs),
 * so the same core can run behind the local shift daemon. Per iteration it: pings
 * presence when due → reconciles local children → dispatches any already-claimed
 * orders waiting for local capacity → checks `wake(cursor)` → sweeps `whats_next`
 * when the hub changed or a prior sweep was skipped/failed → classifies/meters
 * new orders → reaps work dirs → adopts the cursor → sleeps the poll interval.
 *
 * DISPATCH SPLIT (D2 decision 3 — the D12 routing contract). BOTH kinds spawn a
 * detached child; there is exactly ONE way each kind runs, and no flag selects
 * between paths:
 *  - COMMAND orders spawn a detached `owenloop work exec <wf>/<run> --origin <url>`
 *    child that self-leases (unchanged from C3).
 *  - AGENT orders spawn a detached `owenloop work agent-run <wf>/<run>` child that
 *    hosts the step agent itself through a harness adapter. The child resolves the
 *    order-pinned instruction digest and selects the verified step and harness;
 *    Shift never substitutes definition-name cache metadata for modern orders.
 *  - The shift makes NO first-contact `get_order` for any kind. It holds no
 *    leases; the spawned child makes first contact and closes the B2 pickup
 *    window. A failed hand-off lapses back via that window instead of sitting
 *    claimed.
 *
 * METERING (decision 3): free capacity `k = cap − liveInFlight`, where
 * liveInFlight counts every live child record, each one pid-probed (see
 * state.ts). When `k <= 0` the loop skips `whats_next` but remembers that the
 * adopted wake still needs a sweep. Orders already returned by `whats_next`
 * are already claimed. Orders this shift cannot dispatch are released back to
 * the hub immediately, so another daemon can take them; `localQueueHoldMs`
 * optionally retains them locally for a bounded window instead. The agent lane
 * is additionally bounded by `cap − execReserve`, preserving room for an exec
 * order while agents are saturated.
 *
 * RESILIENCE: presence/wake/whats_next failures are logged and never kill the
 * loop. `stop()` flips a flag checked between awaits; the in-flight sweep
 * finishes, `run()` resolves 0, and no hub call is made afterward. Detached
 * children are never killed on shutdown — that is the drain semantic.
 *
 * LEGACY PINNED-HASH DISPATCH (E, DD-4): the old wire shape omits both `worker`
 * and `defDigest` and serves only a def NAME. Only that explicitly legacy shape
 * uses `readDispatchBundle(cacheDir, defName)`: 0 pins → latest; exactly 1 pinned
 * hash → that frozen version; >1 conflicting pins → refuse and leave the orders
 * for the pickup window. Modern orders route from authoritative `worker` plus
 * exact `defDigest`; modern command metadata is verified through
 * `resolveOrderStep`, and modern agent metadata is resolved by `agent-run`.
 *
 * LIVE SHIFT IDENTITY: `name`/`serveCrews` on `ShiftLoopOptions` are INITIAL
 * values only. The loop holds them as live closure state (`getShift`/`setShift`
 * on `ShiftLoop`) so the shift socket's `clock_in` operation can change what a
 * shift is called and which crews it serves without rebuilding the loop —
 * `setShift` also resets the presence timer so the new identity reaches the hub
 * on the very next `iterate()`.
 */
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  acquireFileLockSync,
  FileLockTimeoutError,
  releaseFileLock,
  type AcquireFileLockOpts,
} from '../../../../src/lock.ts';
import { readDispatchBundle } from '../bundle/cache.ts';
import type { HubClient } from '../hub/client.ts';
import { HubError, type InboxInstance, type WorkOrder } from '../hub/types.ts';
import type { FetchedStep } from '../bundle/types.ts';
import { isCommandStep, resolveCommandRouting } from './routing.ts';
import {
  cancelReservedChild,
  finalizeChildReservation,
  reconcileInFlight,
  reserveChild,
  startReservedChild,
  removeChildRecord,
  settleChildGate,
  ensureStateDir,
  type ChildRecord,
  type ChildReservation,
  type ReconcileOptions,
  type ReservedChild,
  type Liveness,
} from './state.ts';
import { DEFAULT_WORK_DIR_TTL_MS, sweepWorkDirs as sweepWorkDirsImpl } from '../agent/workdir.ts';
import { withHubRosterSyncTimeout } from '../settings/hub-roster-cache.ts';
import { withHubCallTimeout } from '../hub/deadline.ts';
import { sessionsPath } from '../harness/session-store.ts';
import { checkHost, type HostFault } from './host-preflight.ts';
import { formatBytes, type DiskSpace } from './disk-floor.ts';
import type { Spawner, WorkerFailure } from './spawn.ts';
import {
  stampShiftEvent,
  type OrderDroppedEvent,
  type ShiftEvent,
  type ShiftEventBody,
} from './protocol.ts';

export interface ShiftLoopOptions {
  hub: HubClient;
  spawner: Spawner;
  /** Injected sleep — tests pass an instant/scriptable stub (no real timers). */
  sleep: (ms: number) => Promise<void>;
  /** Injected wall clock for persisted and externally meaningful timestamps. */
  now: () => number;
  /** Injected monotonic clock for elapsed-time decisions. Default `performance.now`. */
  monotonicNow?: () => number;
  /** stdout sink (one line per call; newline appended). */
  out: (line: string) => void;
  /** stderr sink (one line per call; newline appended). */
  err: (line: string) => void;
  /** Local dispatch/reap observations consumed by the shift socket wrapper. */
  onEvent?: (event: ShiftEvent) => void;
  cacheDir: string;
  stateDir: string;
  /** Max concurrent in-flight orders (exec + agent-run children), including
   *  any slots reserved from the agent lane for exec work. */
  cap: number;
  /** Serve crews this shift accepts (sent to presence + whats_next). INITIAL
   *  value only — live-mutable via the `ShiftLoop.setShift` (MCP `clock_in`). */
  serveCrews: string[];
  /** Shift name for presence. INITIAL value only — live-mutable via
   *  `ShiftLoop.setShift` (MCP `clock_in`). */
  name: string;
  /** Stable owner key for session records; unlike `name`, it is not clocked in. */
  shiftOwner?: string;
  /**
   * W7: this Shift process incarnation's self-declared id (`shf_<uuid>`)
   * and process start time — carried on presence pings (attribution/
   * observability only, D8/INV-82) and carried into dispatched holders/orders
   * so submissions can be traced back to the Shift that produced them.
   * Regenerated every restart, never persisted (D1).
   */
  shiftId?: string;
  startedAt?: number;
  /** When set, poll only this instance; else inbox-mode across all servable. */
  workflow?: string;
  /** Machine-level command routing (raw — validated in routing.ts). */
  commandRouting?: unknown;
  /** Resolve exact order-pinned step metadata by `defDigest`; modern command orders fail closed without it. */
  resolveOrderStep?: (order: WorkOrder) => Promise<FetchedStep | undefined>;
  pollIntervalMs: number;
  presenceIntervalMs: number;
  /** Weak hub-roster cache refresh cadence; undefined disables refresh. */
  rosterSyncIntervalMs?: number;
  /** Upper bound for one low-priority refresh attempt. */
  rosterSyncTimeoutMs?: number;
  /** Daemon-owned cache write, injected so failure cannot kill the loop. */
  syncRosters?: (signal: AbortSignal) => Promise<void>;
  /**
   * Deadline for each poll-loop hub call (`wake`, `presence_ping`, both
   * `whats_next` forms). Default `DEFAULT_HUB_CALL_TIMEOUT_MS`. Issue #300:
   * without one, a call that never settles hangs the loop forever with no
   * error, no log line and no hub traffic. A call that hits it fails on the
   * same terms as a connection reset: logged, and recorded as `hub-error`
   * where the call already reports one. Only a `wake` failure advances
   * `hubFailureStreak`, exactly as before this change.
   */
  hubCallTimeoutMs?: number;
  /**
   * WATCHDOG threshold: how long since the loop last made PROGRESS — a hub
   * call settled, or a cycle completed — before the shift reports itself
   * `stalled`. Default `3 * pollIntervalMs + hubCallTimeoutMs` — three missed
   * ticks plus the longest a single call may legitimately take. Every settled
   * call moves the reference, so a long cycle of many slow-but-answered calls
   * never trips it; only one call that never settles can.
   */
  stallThresholdMs?: number;
  /**
   * Cadence of the file-only `heartbeat` record. Default
   * `DEFAULT_HEARTBEAT_INTERVAL_MS` (5 minutes); `0` disables it.
   */
  heartbeatIntervalMs?: number;
  /**
   * Repeating-timer seam for the watchdog and heartbeat, so tests can fire
   * them by hand. Returns the cancel function. Defaults to an UNREF'd
   * `setInterval`: neither timer may keep the process alive on its own.
   */
  schedule?: (fn: () => void, everyMs: number) => () => void;
  /**
   * Compute the serving set for the live serve crews. Kept injectable so the
   * loop does no filesystem work; absent means the legitimate empty set.
   */
  computeServeCapabilities?: (crews: readonly string[]) => string[];
  /**
   * Max concurrent `agent-run` children (default 4). A SECOND budget, applied
   * INSIDE `cap` — never a replacement for it. The effective budget also
   * accounts for `execReserve`. An agent turn is long and memory-heavy where
   * a command is short, so the two cannot share one number.
   */
  maxConcurrentAgents?: number;
  /**
   * Slots INSIDE `cap` that `agent-run` children may never occupy, so an
   * exec/command order always has somewhere to land (default 1).
   *
   * A scheduling control, not a capacity one: it never raises the total child
   * ceiling. Clamped to `cap - 1` so it cannot consume the whole cap.
   */
  execReserve?: number;
  /**
   * How long to retain a claim this shift cannot dispatch before returning it
   * to the hub. Defaults to 0: do not queue locally.
   */
  localQueueHoldMs?: number;
  /**
   * PHASE 4 — the root under which per-RUN agent work directories live
   * (`<workRoot>/<workflow>/<run>/`). ABSENT DISABLES THE REAPER entirely: with
   * no root there is no set of directories this shift can claim to own, and a
   * remover with no ownership claim is exactly what must not exist.
   */
  workRoot?: string;
  /** PHASE 4 — when set, work dirs are git worktrees of this repo and are
   *  removed with `git worktree remove` rather than a plain `rm -rf`. */
  workRepo?: string;
  /** PHASE 4 — grace window before an idle work dir may be removed. Default
   *  `DEFAULT_WORK_DIR_TTL_MS` (1h), owned by `src/agent/workdir.ts`. */
  workDirTtlMs?: number;
  /** Bootstrap wake + exactly one sweep, then return (the e2e/demo hook). */
  once?: boolean;
  /** Injectable liveness probe (tests). */
  isAlive?: Liveness;
  /** Test seam for deterministic races at the shared dispatch lock. */
  dispatchLockOptions?: Pick<AcquireFileLockOpts, 'beforeOpen'>;
  /** PHASE 4 — injected in tests so the reaper can be exercised without a
   *  filesystem. Defaults to `sweepWorkDirs` from `src/agent/workdir.ts`. */
  sweepWorkDirs?: typeof sweepWorkDirsImpl;
  /**
   * Does this machine still have the directories the shift needs? Injected in
   * tests so a vanished temp directory can be presented without one, and so the
   * check itself can be made to throw. Defaults to `checkHost`, which is
   * `stat`-only and issues no hub traffic. An empty array means "no LOCAL
   * fault", never "healthy" — see `host-preflight.ts`.
   */
  hostPreflight?: () => HostFault[];
  /**
   * Is there room on this disk to start another order? Injected in tests so a
   * full volume can be presented without filling one. Defaults to a real
   * `statfs` of `workRoot` (or its nearest existing ancestor) against the
   * resolved floor. `unknown` means "could not measure, or switched off" and is
   * treated as permission to dispatch — see `disk-floor.ts`.
   */
  diskSpace?: () => DiskSpace;
}

export interface LockedRemovalOptions {
  dispatchLockOptions?: Pick<AcquireFileLockOpts, 'beforeOpen'>;
  waitMs?: number;
  label?: string;
}

/** Run a state mutation while holding the lock that serializes dispatch state. */
export function withDispatchLock<T>(
  stateDir: string,
  options: LockedRemovalOptions = {},
  fn: () => T,
): T {
  const dispatchLock = acquireFileLockSync(join(stateDir, '.dispatch.lock'), {
    ...options.dispatchLockOptions,
    waitMs: options.waitMs ?? 30_000,
    label: options.label ?? 'owenloop Shift dispatch-state removal',
  });
  try {
    return fn();
  } finally {
    releaseFileLock(dispatchLock);
  }
}

/**
 * Remove one child record while holding the same lock that serializes durable
 * reservation creation. The record is deliberately re-read by
 * `removeChildRecord` only after acquisition, so a stale observer cannot erase
 * a newer dispatch for the same run.
 */
export function removeChildRecordUnderDispatchLock(
  stateDir: string,
  run: string,
  recordOptions?: { pid?: number },
  options: LockedRemovalOptions = {},
): boolean {
  return withDispatchLock(stateDir, options, () => removeChildRecord(stateDir, run, recordOptions));
}

/**
 * Reconciliation callbacks for every unlocked Shift daemon path. Keep these
 * together with the lock-held removal primitive so startup and the poll loop
 * cannot silently diverge.
 */
export function createLockedRemovalCallbacks(
  stateDir: string,
  options: LockedRemovalOptions = {},
): Pick<ReconcileOptions, 'removeAbandonedReservation' | 'removeDeadChild' | 'settleLiveChild'> {
  return {
    removeAbandonedReservation: (reservation) =>
      withDispatchLock(stateDir, options, () => cancelReservedChild(stateDir, reservation)),
    removeDeadChild: (record) =>
      withDispatchLock(stateDir, options, () => removeChildRecord(stateDir, record.run, { pid: record.pid })),
    settleLiveChild: (record) =>
      withDispatchLock(stateDir, options, () => settleChildGate(stateDir, record)),
  };
}

/** What one `sweep()` produced. `polled`/`openRuns` exist for the Phase 4
 *  work-dir reaper and are read nowhere else. */
interface SweepResult {
  /** How many children this sweep actually spawned (exec + agent-run). */
  dispatched: number;
  /** Workflows whose `whats_next` call SUCCEEDED this sweep. */
  polled: Set<string>;
  /** Runs those calls reported an open order for. */
  openRuns: Set<string>;
  /** False when inbox or any per-workflow `whats_next` call failed. */
  complete: boolean;
  /**
   * True when this sweep handed a claim back because the shift was FULL — the
   * `dispatch-cap-full` and `agent-cap-full` releases, and nothing else.
   *
   * It exists because a capacity release is the one refusal that leaves REAL,
   * READY work unclaimed with no event to bring it back. The hub does not
   * re-offer on a local child's exit (that is not a hub event), and with
   * `localQueueHoldMs() === 0` the order is not retained in
   * `pendingCandidates` either, so the next sweep only happens if the cursor
   * happens to change. On a single-server-capability topology nothing else is
   * moving, the cursor does not change, and the order starves indefinitely.
   *
   * `agent-lane-closed` is deliberately NOT counted. A shift with an agent
   * ceiling of 0 will never dispatch that order no matter how much capacity
   * frees, so re-arming the sweep for it would poll the hub every tick forever
   * and never make progress.
   */
  releasedForCapacity: boolean;
}

export interface ShiftLoop {
  run(): Promise<number>;
  stop(): void;
  /**
   * Run exactly one park iteration (presence → reconcile/queued dispatch → wake
   * → required sweep → reap) and return how many children it spawned. The shift daemon
   * uses this seam for its loop core; the standing `run()` loop ignores the
   * count. Cursor/presence state is held in the closure and persists across calls.
   */
  iterate(): Promise<number>;
  /** Free capacity right now (cap − live in-flight). ≤ 0 ⇒ at capacity. */
  freeCapacity(): number;
  /** Live dispatch-cap used by status and next responses. */
  getCap(): number;
  /** Live agent-lane ceiling after the exec reserve is applied. */
  agentCeiling(): number;
  /** Adjust the live dispatch cap for internal callers and tests. */
  setCap(cap: number): void;
  /** The shift's live identity: the presence name and the crew scope (`serve_crews`)
   *  the next ping and the next sweep will carry. Empty `serveCrews` means ALL of
   *  this identity's crews, never none. */
  getShift(): { name: string; serveCrews: string[] };
  /** The derived serving set currently advertised to the hub. */
  getServeCapabilities(): string[];
  /** Set the live shift identity (the socket `clock_in` operation). A field left ABSENT is
   *  left unchanged; `serveCrews: []` explicitly means "all crews". Also makes the
   *  next presence ping due immediately, so the new identity reaches the hub on the
   *  next iterate() rather than up to presenceIntervalMs later. Returns the result. */
  setShift(next: { name?: string; serveCrews?: string[] }): { name: string; serveCrews: string[] };
  /** Record local client attendance and make the next presence ping due. */
  noteAttended(at: number): void;
  /** Return the last accepted attendance timestamp, if any. */
  getAttendedAt(): number | undefined;
  /**
   * Run-ended reap (metering condition (a)): drop the in-flight record for
   * `run` NOW, so its slot frees immediately instead of waiting for the next
   * reconcile to notice the child exited.
   *
   * NOTHING IN `src/` CALLS THIS. It is reachable only from tests. The intended
   * caller was a submit path that told the shift the hub had closed a run, and
   * that wiring was never made, so the slot is always freed the slower way
   * instead: the child exits, and the next reconcile's pid probe frees it.
   *
   * Stated plainly because the gap is invisible from the type — this is on the
   * `ShiftLoop` interface, so it reads as live. Do not reason from its
   * existence about when `runBrakeKey` entries are cleared; in production the
   * per-sweep prune is the only clearer. Wire it or delete it, but do not build
   * a guard on top of it.
   */
  noteRunEnded(run: string): void;
  /**
   * A dispatched worker process ENDED. Frees the dispatch slot it held on every
   * terminal outcome, including a mid-turn completion that exits 0. This is the
   * primary release path; reconciliation remains the crash/restart backstop.
   */
  noteChildExited(exit: {
    workflow: string;
    run: string;
    kind: 'exec' | 'agent-run';
    pid: number;
  }): void;
  /**
   * A dispatched child exited non-zero. Charges one failure against that run's
   * STEP and arms the brake window — see `STEP_BRAKE_DELAYS_MS`.
   *
   * The shift runtime already builds this exact failure record for its daemon
   * event and its stderr line; this is the third consumer. The loop cannot
   * observe child exits itself (children are detached with `stdio: ignore`),
   * so without this call the loop has no failure signal at all and re-dispatch
   * is bounded by nothing.
   *
   * A failure for a run this loop never dispatched (a foreign or already-reaped
   * run) is ignored rather than guessed at: the fan-out key is not on the
   * failure record, so there is no sound way to pick a brake key for it.
   *
   * ALSO HANDS THE CLAIM BACK, with the failure as the reason. A worker that
   * dies before it submits leaves its order INFLIGHT on the hub with a frozen
   * heartbeat: no alert, no re-offer, and no other shift able to take it,
   * because this shift still holds the claim. Measured once at 34 minutes,
   * indistinguishable from work in progress, until an operator released it by
   * hand. The failure is known here and already named precisely, so the name
   * travels with the release instead of dying in a local log line.
   *
   * The brake-key guard scopes the release to runs THIS shift dispatched and
   * has not yet pruned. It does NOT mean "the run is still open": the only
   * production clearer is the per-sweep prune below, and a child's exit event
   * always beats the next sweep. So this fires for ordinary worker failures
   * too, on top of the specific release the child's own final breath sends.
   *
   * That redundancy is deliberate and it is cheap, because the hub answers a
   * release on an unheld claim by returning BEFORE it normalizes the reason or
   * publishes anything (`verbs/release.ts`: "Only a currently held targeted
   * release gets a diagnostic side effect"). A worker whose own final breath
   * reached the hub therefore costs exactly one no-op request here — it cannot
   * overwrite the reason that worker already recorded.
   *
   * Covering the ordinary exit path is the point, not an accident. The
   * incident this exists for exited 1 with no signal, killed by ENOSPC inside
   * its own error logging, so a predicate keyed on "could not have released
   * for itself" — a signal death, or a spawn that never started — would have
   * missed it entirely. A supervisor cannot tell those apart from outside, so
   * it reports what it saw and lets the hub deduplicate.
   *
   * One narrow race remains, and it is worth taking. `finalBreath` gives up
   * after `RELEASE_CAP_MS` while its request is still in flight; if that
   * request is slow enough for this one to overtake it, the supervisor's
   * account is recorded and the worker's more specific one is dropped as
   * not-held. The reason string names its own provenance so that outcome still
   * reads honestly, and a slightly vaguer alert beats the alternative this
   * replaces, which was no alert at all for 34 minutes.
   */
  noteWorkerFailure(failure: WorkerFailure): void;
  /**
   * Issue #300 liveness facts for `shift status`. A cycle counts once
   * `iterate()` RETURNS, whichever entry point ran it; `getLastPollAt` is the
   * wall clock at that moment, or undefined before the first completes.
   */
  getCyclesCompleted(): number;
  getLastPollAt(): number | undefined;
}

/** A dispatch candidate carried through classify → spawn. */
interface Candidate {
  order: WorkOrder;
  workflow: string;
  step: FetchedStep | undefined;
  defName: string | undefined;
  defHash: string | undefined;
  kind: 'agent' | 'command';
  /** Local time immediately before the targeted `whats_next` request began. */
  requestStartedAt: number;
  /** True when this run already had a live record (handout lapsed → re-offer). */
  reoffer: boolean;
}

/** A workflow the fleet inbox asked this Shift to consider. */
interface PollCandidate {
  workflow: string;
  /** Present only for fleet inbox candidates; absent for explicit `opts.workflow`. */
  inbox?: InboxInstance;
}

/** The `maxConcurrentAgents` fallback when the option is absent. */
const DEFAULT_MAX_AGENTS = 4;
/** The `execReserve` fallback when the option is absent. */
const DEFAULT_EXEC_RESERVE = 1;
/** The `localQueueHoldMs` fallback when the option is absent. */
const DEFAULT_LOCAL_QUEUE_HOLD_MS = 0;
/** The hub reaps a never-contacted claim after this long. Every client-side
 * re-offer latency must stay strictly under it. */
export const HUB_PICKUP_WINDOW_MS = 120_000;
/** Headroom for a detached child to make first contact after dispatch. */
const CHILD_FIRST_CONTACT_MARGIN_MS = 30_000;
/**
 * The hub reaps a never-contacted claim after 120 seconds. Stop local queueing
 * after 90 seconds so a detached child retains 30 seconds to make first contact.
 */
export const MAX_PENDING_CANDIDATE_AGE_MS = HUB_PICKUP_WINDOW_MS - CHILD_FIRST_CONTACT_MARGIN_MS;

/**
 * A capacity-refused claim is returned to the hub immediately, so sibling
 * shifts can take it. This short, fixed monotonic window stops this shift from
 * claiming that same stable step again on every busy wake while its relevant
 * capacity is still unavailable.
 */
const CAPACITY_RELEASE_COOLDOWN_MS = 30_000;
type CapacityReleaseReason = 'dispatch-cap-full' | 'agent-cap-full';

/**
 * THE PER-STEP FAILURE BRAKE.
 *
 * Every in-flight guard in this file keys on the RUN id — `liveRuns`,
 * `workerRuns`, `claimed`, `pendingCandidates`. That is correct for the case
 * they were written for: one claim, one child. It is blind to the case where a
 * step fails the same way forever.
 *
 * Observed 2026-08-12: `local-check` of one instance was dispatched five-plus
 * times in seconds under a DIFFERENT run id each time
 * (run_fd94d88a…, run_5ec4d807…, run_d8cdf03f…, run_67c8e2db…, run_072755ba…).
 * The child refused its consumed artifact, exited non-zero WITHOUT submitting,
 * the hub released the claim, and the next poll handed the same step back under
 * a fresh run id. A fresh run id matches none of the run-keyed guards, so
 * nothing bounded the respawns.
 *
 * So the brake is keyed on the identity that actually repeats — the STEP, as
 * `(workflow, step, key)`. `key` is part of the identity because a fanned-out
 * step has one legitimately concurrent order per key, and those must not brake
 * each other.
 *
 * WHAT IS COUNTED, AND WHY IT IS NOT DISPATCHES. The event counted against that
 * key is a FAILED ATTEMPT TO RUN THE STEP, in either of the two shapes that
 * exist: a child that started and exited non-zero, reported into the loop
 * through `noteWorkerFailure`; or a dispatch that never produced a running
 * child at all, which throws out of `dispatchCandidate` and is charged there.
 * What is NOT counted is a dispatch that succeeds. Counting those would
 * conflate a storm with legitimate concurrency: the hub can offer several
 * DISTINCT runs of one step in a single sweep, and metering the second through
 * fifth of those would throttle healthy work. A failure is direct evidence that
 * running this step again right now is unlikely to help; a dispatch is evidence
 * of nothing.
 *
 * It is a rate limit, never a ban. A step that has not failed is dispatched
 * with zero delay, however many orders arrive for it at once.
 */
export const STEP_BRAKE_DELAYS_MS = [2_000, 8_000, 30_000, 60_000, 90_000] as const;

/**
 * Treat a failure this long after the previous one as the start of a NEW
 * streak, resetting the count to zero first. Comfortably longer than the
 * longest delay in the table (90s), so a step failing at maximum backoff never
 * decays out of it, while an isolated transient long after an old streak starts
 * again at the shortest delay instead of inheriting a stale penalty.
 */
export const STEP_BRAKE_DECAY_MS = 600_000;

/**
 * Forget a step's brake entry once this long has passed since its window
 * closed, so the map cannot grow for the life of the shift. Pure housekeeping —
 * `STEP_BRAKE_DECAY_MS` is what governs behaviour.
 */
const STEP_BRAKE_FORGET_MS = 1_800_000;

/**
 * Longest release reason this shift will put on the wire, in code points.
 *
 * Mirrors the hub's own `MAX_RELEASE_REASON_CODE_POINTS`, which trims, treats
 * blank as absent, and truncates without splitting a surrogate pair. Clamping
 * on this side too means the reason we send is the reason an operator reads,
 * with no silent server-side shortening in between.
 *
 * Exported so a test can assert the clamp against the constant rather than
 * against a copy of the number, which would drift the day the hub's limit moves.
 */
export const MAX_RELEASE_REASON_POINTS = 1024;

/**
 * How long to refuse the next dispatch of a step after `count` consecutive
 * worker failures. `count` is at least 1 at every call site (this is reached
 * only from the failure path), so the FIRST failure already costs 2s; past the
 * end of the table the last entry repeats, so a permanently-failing step
 * settles at one dispatch per 90 seconds instead of one per poll.
 */
function stepBrakeDelayMs(count: number): number {
  const index = Math.min(count, STEP_BRAKE_DELAYS_MS.length) - 1;
  return STEP_BRAKE_DELAYS_MS[index] ?? 0;
}

/** How many links of an error's `cause` chain `errMsg` renders. */
const MAX_CAUSE_DEPTH = 4;

/**
 * Consecutive failed hub polls before the shift asks whether the fault is local.
 *
 * NOT a timeout and not a health threshold — nothing is declared broken at this
 * number. Crossing it only makes the shift run `checkHost`, which is a handful
 * of `stat` calls and is free of hub traffic; if the host is fine the shift
 * keeps polling and the streak keeps climbing. So the number only has to be
 * large enough that a single transient failure does not pay for the check, and
 * small enough that an operator is not left guessing for long. At the shipped
 * 30s poll interval three failures is about a minute and a half.
 */
const HOST_PREFLIGHT_STREAK = 3;

/**
 * Default per-call deadline for the poll loop's hub verbs (issue #300).
 *
 * 30 seconds, because: (1) none of these verbs long-polls — `wake` is the
 * "cheap wake pre-check" the client documents, `presence_ping` and
 * `whats_next` are single Durable Object round trips, and the hub answers a
 * busy DO with an immediate "retry in 1s" error rather than by holding the
 * request; so a legitimate call finishes in well under a second and 30s is a
 * generous multiple of the slowest plausible one; (2) the failure this bounds
 * lasted HOURS with no traffic at all, so any finite value fixes the bug and
 * the question is only how much a tick may cost while it does — 30s is
 * six default poll intervals, cheap next to the alternative; (3) it is
 * deliberately longer than the 10s roster-sync deadline, which guards a
 * low-priority refresh that may simply be skipped; these calls are the
 * loop's whole purpose and deserve more patience before being counted as
 * failed. Trade-off accepted: a `whats_next` that the hub committed but this
 * side timed out leaves that claim to lapse through the hub's pickup window,
 * exactly as a dropped connection after commit would.
 */
export const DEFAULT_HUB_CALL_TIMEOUT_MS = 30_000;
/** Default cadence of the file-only `heartbeat` record: every five minutes. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60_000;
/** Floor for the watchdog's own check cadence. */
const MIN_WATCHDOG_CHECK_MS = 1_000;

/** The later of two optional monotonic timestamps; undefined only when both are. */
function latestDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/** Production `schedule`: an interval that never keeps the process alive. */
function scheduleWithInterval(fn: () => void, everyMs: number): () => void {
  const timer = setInterval(fn, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** The identity a storm repeats on. `key` is '' for an unfanned step. */
function stepBrakeKey(workflow: string, step: string, key: string | undefined): string {
  return `${workflow}\u0000${step}\u0000${key ?? ''}`;
}

/**
 * An error's message, with its cause chain appended.
 *
 * THE CHAIN IS THE POINT. Node's fetch reports every transport failure as the
 * bare string `fetch failed` and puts the real reason — `ENOENT`, `ECONNREFUSED`,
 * `EAI_AGAIN`, a TLS error — on `cause`. Dropping it makes a dead local host, an
 * unreachable hub and a DNS failure produce byte-identical records, which is
 * precisely how a wedged shift stayed unattributed for 42 minutes.
 *
 * Bounded by construction: the walk follows at most `MAX_CAUSE_DEPTH` links and
 * refuses to revisit a cause it has already rendered, so a self-referential or
 * mutually-referential chain terminates instead of hanging the emitter.
 */
function errMsg(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const parts = [e.message];
  const seen = new Set<unknown>([e]);
  let cause: unknown = (e as { cause?: unknown }).cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause !== undefined && cause !== null; depth += 1) {
    if (seen.has(cause)) break;
    seen.add(cause);
    const text = cause instanceof Error ? cause.message : String(cause);
    if (text !== '' && !parts.includes(text)) parts.push(text);
    cause = cause instanceof Error ? (cause as { cause?: unknown }).cause : undefined;
  }
  return parts.join(': ');
}

/** The explicit hub refusal produced when an inbox row becomes terminal after
 * the inbox snapshot but before its targeted serving call. This is a normal
 * stale-candidate race, not a Shift failure worth retrying forever. */
function isNonServableRace(e: unknown): boolean {
  return e instanceof HubError
    && e.status === 403
    && e.code === 'forbidden'
    && e.message.includes('non-running instance is not servable');
}

export function createShiftLoop(opts: ShiftLoopOptions): ShiftLoop {
  let stopped = false;
  let cap = opts.cap;

  /**
   * The agent lane's live budget. Recomputed per call because `setCap`
   * rewrites `cap` at runtime.
   */
  function agentLane(): { ceiling: number; requested: number; reserve: number } {
    const requested = opts.maxConcurrentAgents ?? DEFAULT_MAX_AGENTS;
    const reserve = Math.min(
      opts.execReserve ?? DEFAULT_EXEC_RESERVE,
      Math.max(0, cap - 1),
    );
    return {
      ceiling: Math.max(0, Math.min(requested, cap - reserve)),
      requested,
      reserve,
    };
  }

  /** Effective local hold, capped below the hub pickup window. */
  function localQueueHoldMs(): number {
    return Math.min(
      Math.max(0, opts.localQueueHoldMs ?? DEFAULT_LOCAL_QUEUE_HOLD_MS),
      MAX_PENDING_CANDIDATE_AGE_MS,
    );
  }

  const isAlive = opts.isAlive;
  const monotonicNow = opts.monotonicNow ?? performance.now.bind(performance);
  const hubCallTimeoutMs = opts.hubCallTimeoutMs ?? DEFAULT_HUB_CALL_TIMEOUT_MS;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const schedule = opts.schedule ?? scheduleWithInterval;
  // Issue #300 liveness. Two clocks on purpose: the wall clock is what
  // `shift status` and the records show, the monotonic one is what the
  // watchdog measures staleness with (a wall-clock jump must not fake a stall).
  let cyclesCompleted = 0;
  let lastPollAt: number | undefined;
  let lastCycleMono: number | undefined;
  /** Last settled hub call, success or failure: one cycle may serialise many. */
  let lastProgressMono: number | undefined;
  let runStartedMono: number | undefined;
  /** Edge trigger for `stalled`: one record per episode, re-armed by a completed cycle. */
  let stalledReported = false;
  let cancelWatchdog: (() => void) | undefined;
  let cancelHeartbeat: (() => void) | undefined;
  // Live shift identity (MCP `clock_in`, D3-D7 of the plan). Seeded from opts,
  // which are now INITIAL values only. Arrays are copied so neither the loop
  // nor a caller of getShift/setShift can mutate the other's state afterward.
  let shiftName = opts.name;
  let serveCrews = [...opts.serveCrews];
  let serveCapabilities: string[] = [];
  let initial = true;

  function refreshServeCapabilities(): void {
    if (opts.computeServeCapabilities === undefined) return;
    let next: string[];
    try {
      next = [...opts.computeServeCapabilities(serveCrews)];
    } catch {
      return; // Keep the last known-good advertisement on a transient failure.
    }
    const changed =
      next.length !== serveCapabilities.length ||
      next.some((capability, index) => capability !== serveCapabilities[index]);
    serveCapabilities = next;
    if (changed && !initial) opts.out(`serving ${next.length === 0 ? '(nothing)' : next.join(', ')}`);
  }

  refreshServeCapabilities();
  initial = false;

  // Park state persists across `iterate()` calls (the MCP park reuses it).
  let cursor: number | undefined;
  let lastPresence = Number.NEGATIVE_INFINITY;
  // Runtime performs the required shift-start refresh before creating this
  // loop. Start this cadence now so it is not immediately fetched twice.
  let lastRosterSync = monotonicNow();
  let attendedAt: number | undefined;
  /**
   * Orders returned by `whats_next` are already claimed. If the hub returns more
   * orders than this process can spawn, retain those claims locally until a child
   * exits and capacity opens. Waiting for another wake cannot work: no hub event
   * is required when a local child exits, and `tick` will not re-return a claim
   * that is already in flight.
   */
  const pendingCandidates = new Map<string, Candidate>();
  /** A changed wake whose sweep was skipped or failed must be retried after the
   * cursor is adopted; otherwise the next unchanged wake hides that work. */
  let sweepOwed = false;
  /** Earliest monotonic time at which a braked step becomes dispatchable again.
   * Drives a sweep without a hub cursor move, so a brake never waits forever. */
  let brakeSweepDueAt: number | undefined;
  /**
   * Recently capacity-released stable orders. This is deliberately separate
   * from `stepBrake`: a worker failure leaves its claim to lapse, while a
   * capacity refusal hands the claim back to the hub and needs a reason-aware
   * targeted-poll damper.
   */
  const capacityCooldown = new Map<string, {
    workflow: string;
    reason: CapacityReleaseReason;
    retryAt: number;
  }>();
  /** Earliest fixed cooldown deadline, used to re-admit an unchanged wake. */
  let capacityCooldownDueAt: number | undefined;
  /**
   * Has the current at-capacity EPISODE already produced a `capacity` event?
   *
   * Set when the event fires, cleared the moment a slot is free again, so one
   * unbroken stretch at capacity yields exactly one record no matter how many
   * ticks it spans. See the emit site for why the console line next to it is
   * deliberately NOT edge-triggered.
   */
  let atCapReported = false;
  /**
   * EDGE flag for the low-disk refusal, paired with `atCapReported` because the
   * two gates have the same shape: a condition that persists across many ticks
   * but is worth exactly one record per episode. Cleared the moment the disk
   * measures healthy again, so a machine that fills and drains twice writes two
   * records rather than one.
   */
  let lowDiskReported = false;
  /** Earliest server-approved time for the next polling iteration. */
  let backoffUntil = Number.NEGATIVE_INFINITY;
  /**
   * Consecutive hub polls that failed for a reason the hub did not sanction.
   *
   * RATE LIMITING IS EXCLUDED, and that exclusion is the whole design. A 429 is
   * the server saying "come back later", and a Cloudflare 1015 ban is the same
   * answer at the edge: both are recoverable degradation that clears on its own,
   * and a shift that killed itself over one would take the whole fleet down for
   * a condition the fleet itself caused. `noteServerBackoff` already returns
   * exactly that discrimination, so the streak counts only the failures nobody
   * promised would end.
   *
   * Reset by any SUCCESSFUL wake, which is the loop's one unconditional hub call
   * per unbackoffed tick and therefore the cheapest honest proof that the hub is
   * reachable and this host can reach it.
   */
  let hubFailureStreak = 0;
  /** Set once the shift has stopped for a named local fault, so `run` exits non-zero. */
  let wedged = false;
  /** Bumped whenever a ping starts or is forced due, so a ping that completes
   *  after a force does not stamp the cadence over that force. */
  let presenceGeneration = 0;

  function refreshCapacityCooldownDueAt(): void {
    let earliest: number | undefined;
    for (const entry of capacityCooldown.values()) {
      earliest = earliest === undefined ? entry.retryAt : Math.min(earliest, entry.retryAt);
    }
    capacityCooldownDueAt = earliest;
  }

  /** Remove all expired entries; a real post-expiry retry can arm a new window. */
  function pruneExpiredCapacityCooldown(now = monotonicNow()): void {
    let changed = false;
    for (const [key, entry] of capacityCooldown) {
      if (entry.retryAt <= now) {
	capacityCooldown.delete(key);
	changed = true;
      }
    }
    if (changed) refreshCapacityCooldownDueAt();
  }

  function armCapacityCooldown(
    workflow: string,
    order: WorkOrder,
    reason: CapacityReleaseReason,
  ): void {
    const now = monotonicNow();
    pruneExpiredCapacityCooldown(now);
    const key = stepBrakeKey(workflow, order.step, order.key);
    // Do not let cursor activity or duplicate observations slide an active
    // deadline. Only a genuine retry after expiry creates a fresh window.
    if (capacityCooldown.has(key)) return;
    capacityCooldown.set(key, { workflow, reason, retryAt: now + CAPACITY_RELEASE_COOLDOWN_MS });
    refreshCapacityCooldownDueAt();
  }

  /** Read-only admission signal from the freshly reconciled capacity snapshot. */
  function capacityCooldownReady(remaining: number, agentRoom: number, now = monotonicNow()): boolean {
    for (const entry of capacityCooldown.values()) {
      if (entry.retryAt <= now) continue;
      if (entry.reason === 'dispatch-cap-full' ? remaining > 0 : agentRoom > 0) return true;
    }
    return false;
  }

  /**
   * Remove entries for `workflow` whose own capacity class is now eligible and
   * report whether any active entry still suppresses its targeted request.
   * Expiry is global housekeeping so workflows which disappear from the inbox
   * cannot pin this private map forever.
   */
  function workflowCapacityCooldownActive(
    workflow: string,
    remaining: number,
    agentRoom: number,
  ): boolean {
    const now = monotonicNow();
    pruneExpiredCapacityCooldown(now);
    let changed = false;
    let active = false;
    for (const [key, entry] of capacityCooldown) {
      if (entry.workflow !== workflow) continue;
      const ready = entry.reason === 'dispatch-cap-full' ? remaining > 0 : agentRoom > 0;
      if (ready) {
	capacityCooldown.delete(key);
	changed = true;
      } else {
	active = true;
      }
    }
    if (changed) refreshCapacityCooldownDueAt();
    return active;
  }

  function noteServerBackoff(error: unknown): boolean {
    if (!(error instanceof HubError) || error.status !== 429) return false;
    const delay = error.retryAfterMs ?? opts.pollIntervalMs;
    backoffUntil = Math.max(backoffUntil, monotonicNow() + delay);
    return true;
  }

  /**
   * Ask whether a LOCAL fault is the reason this shift cannot work, and stop if
   * one is. Returns true when the shift has been wedged.
   *
   * STOPPING IS THE POINT, and it is the opposite of what every other failure
   * path here does. Everything else in this loop is built to survive: a failed
   * wake retries next tick, a failed roster sync degrades and continues, a
   * rate-limited poll backs off. All of that is correct for a REMOTE fault,
   * which ends without anyone doing anything. It is exactly wrong for a local
   * one, where continuing means an operator watching a live process that will
   * never dispatch again — the measured shape of this defect was a shift that
   * looked alive to `pgrep`, answered `shift end`, and did nothing for 42
   * minutes while attributing a vanished temp directory to `fetch failed`.
   *
   * A PRE-FLIGHT THAT ITSELF FAILS IS NOT A FAULT. If the probe throws, this
   * reports it and returns false, because "I could not determine whether the
   * host is broken" is not evidence that it is, and killing a working shift over
   * an unreadable `stat` would be a worse failure than the one being detected.
   */
  /**
   * Free space for the volume the shift's children will write into.
   *
   * Defaults to `unknown` — never a refusal — when no probe was injected and no
   * work root was resolved: the floor and the work root are both RUNTIME
   * configuration, and a loop constructed without them has no basis to decline
   * anything. `runtime.ts` supplies the real closure.
   */
  function diskSpace(): DiskSpace {
    if (opts.diskSpace !== undefined) return opts.diskSpace();
    return { state: 'unknown', path: opts.workRoot ?? '' };
  }

  function runHostPreflight(streak: number): boolean {
    let faults: HostFault[];
    try {
      faults = opts.hostPreflight !== undefined
        ? opts.hostPreflight()
        : checkHost({});
    } catch (e) {
      opts.err(`host pre-flight failed to run: ${errMsg(e)} (continuing)`);
      return false;
    }
    if (faults.length === 0) return false;
    for (const fault of faults) opts.err(`shift cannot continue: ${fault.message}`);
    wedged = true;
    stopped = true;
    emit({ type: 'wedged', faults, streak });
    return true;
  }

  /**
   * Fan one observation to every consumer, stamped.
   *
   * THE SINGLE ENVELOPE-STAMPING POINT for everything the loop observes. Call
   * sites build a `ShiftEventBody` — payload only — and this function adds the
   * timestamp and the shift identity, so no construction site can forget them
   * and no consumer can receive a half-stamped record. `shiftName` is read live
   * rather than captured, because `clock_in` can rename a shift mid-run and the
   * record should say what the shift was called when it was written.
   *
   * A THROWING CONSUMER MUST NOT KILL THE SHIFT. The report goes to `opts.err`
   * as free text and stays free text: it is the sink's own failure report, and
   * turning it into an event would write it to the sink that just failed.
   */
  /**
   * One poll-loop hub call under the per-call deadline (issue #300). Every
   * settlement — success, failure, or the deadline itself — is progress for
   * the watchdog: a cycle serialises roster sync, presence, wake, the inbox
   * and one targeted `whats_next` per workflow, so a slow-but-alive hub can
   * legitimately take longer than the stall threshold per cycle.
   */
  async function hubCall<T>(label: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      return await withHubCallTimeout(label, run, hubCallTimeoutMs);
    } finally {
      lastProgressMono = monotonicNow();
    }
  }

  /**
   * One poll cycle, accounted. Wraps `iteration()` so BOTH entry points — the
   * daemon's `run` and the exported `iterate` — feed the same liveness facts
   * and re-arm the watchdog. A cycle counts only when `iteration()` RETURNS:
   * one that never settles is exactly what the watchdog below is for.
   */
  async function cycle(): Promise<number> {
    const dispatched = await iteration();
    cyclesCompleted += 1;
    lastPollAt = opts.now();
    lastCycleMono = monotonicNow();
    stalledReported = false;
    return dispatched;
  }

  function stallThresholdMs(): number {
    return opts.stallThresholdMs ?? 3 * opts.pollIntervalMs + hubCallTimeoutMs;
  }

  /**
   * WATCHDOG (issue #300). Runs from its own timer, so it does not depend on
   * `iteration()` ever returning — that dependency is the whole bug: a loop
   * awaiting a call that never settles cannot report its own hang.
   *
   * Staleness is measured from the loop's last PROGRESS — the later of the
   * last settled hub call and the last completed cycle (or the start of
   * `run`, so a FIRST call that hangs is caught too). A cycle is many serial
   * calls, so measuring from the cycle alone would report a slow-but-alive
   * hub as a stall on every sweep. A Retry-After backoff parks the loop on
   * the hub's instruction, so the reference is the later of that and the
   * backoff's end: an honest, hub-instructed pause never reads as a stall.
   * Edge-triggered: one record per episode.
   */
  function checkStall(): void {
    if (stopped) return;
    const progressAt = latestDefined(lastProgressMono, lastCycleMono) ?? runStartedMono;
    if (progressAt === undefined) return;
    const threshold = stallThresholdMs();
    const now = monotonicNow();
    if (now - Math.max(progressAt, backoffUntil) < threshold) return;
    if (stalledReported) return;
    stalledReported = true;
    const sinceMs = Math.round(now - progressAt);
    const last = lastPollAt === undefined ? 'never' : new Date(lastPollAt).toISOString();
    opts.err(
      `poll loop stalled: no progress for ${sinceMs}ms (threshold ${threshold}ms; last completed cycle ${last})`,
    );
    emit({ type: 'stalled', lastPollAt: lastPollAt ?? null, sinceMs });
  }

  /** Periodic proof of life; file-only by the runtime's routing (issue #300). */
  function heartbeat(): void {
    if (stopped) return;
    emit({
      type: 'heartbeat',
      cyclesCompleted,
      lastPollAt: lastPollAt ?? null,
      hubFailureStreak,
      stalled: stalledReported,
    });
  }

  /** Daemon mode only: `once` runs one cycle and returns, so has nothing to watch. */
  function startTimers(): void {
    cancelWatchdog = schedule(checkStall, Math.max(MIN_WATCHDOG_CHECK_MS, opts.pollIntervalMs));
    if (heartbeatIntervalMs > 0) cancelHeartbeat = schedule(heartbeat, heartbeatIntervalMs);
  }

  function stopTimers(): void {
    cancelWatchdog?.();
    cancelWatchdog = undefined;
    cancelHeartbeat?.();
    cancelHeartbeat = undefined;
  }

  function emit(body: ShiftEventBody): void {
    if (opts.onEvent === undefined) return;
    try {
      opts.onEvent(stampShiftEvent(body, { name: shiftName, id: opts.shiftId ?? '' }, opts.now()));
    } catch (e) {
      opts.err(`shift event sink failed: ${errMsg(e)} (continuing)`);
    }
  }

  /**
   * Bound a release reason to what the hub will actually store.
   *
   * Applied to EVERY reason this supervisor sends, not only the ones that look
   * long. The two senders differ sharply in how bounded they are, which is
   * exactly why the clamp belongs in one shared place rather than at whichever
   * call site looked risky on the day:
   *
   * - `describeWorkerFailure` is provably short. Its longest constructible
   *   output is under 100 code points, because every part is generated here or
   *   is one of two literals in `spawn.ts`.
   * - The dispatch catch interpolates `errMsg(e)`, which is NOT bounded. A
   *   `FileLockTimeoutError` from `acquireDispatchLock` embeds a filesystem
   *   path, and a path is bounded only by PATH_MAX.
   *
   * Slices by code point, never by UTF-16 unit, so a clamp cannot halve a
   * surrogate pair and put a lone surrogate on the wire. The hub truncates at
   * `MAX_RELEASE_REASON_CODE_POINTS` too; clamping here as well means the
   * reason we send is the reason an operator reads, with no silent server-side
   * shortening in between.
   */
  const clampReason = (reason: string): string => {
    const points = Array.from(reason);
    return points.length > MAX_RELEASE_REASON_POINTS
      ? points.slice(0, MAX_RELEASE_REASON_POINTS).join('')
      : reason;
  };

  /**
   * The operator-facing account of a dead worker, for the release reason.
   *
   * It names the supervisor explicitly. A worker that fails through its own
   * error path already sends a precise reason of its own, and in a narrow race
   * this account can land first and take the slot the hub keeps for the first
   * observation. Saying who is speaking keeps that outcome readable instead of
   * looking like a worker's own vague self-report.
   *
   * `message` is the SPAWNER'S OWN bounded lifecycle string, never worker
   * output: agent-run stderr is untrusted and is deliberately never quoted back
   * (see `spawn.ts`), and the spawn error object is dropped there rather than
   * interpolated, so no local path reaches the wire.
   *
   * The exit status or signal is what tells an operator which failure this was:
   * a crash, an external kill, or a child that never launched at all. It is the
   * difference between "this step is broken" and "this host is broken", so it
   * travels with the message rather than staying in a local log line.
   */
  const describeWorkerFailure = (failure: WorkerFailure): string => {
    const cause = failure.signal !== null
      ? `signal ${failure.signal}`
      : failure.exitStatus !== null
	? `exitStatus ${failure.exitStatus}`
	: 'no exit status';
    return clampReason(`shift supervisor: ${failure.kind} ${failure.message} (${cause})`);
  };

  /**
   * Hand a claim back so another shift can be offered it immediately. This
   * deliberately stays off the dispatch critical path; a failed release falls
   * back to the existing pickup-window behavior and is observable.
   */
  function releaseClaim(workflow: string, run: string, reason?: string): void {
    void opts.hub.release({ workflow, run, ...(reason !== undefined ? { reason } : {}) }).catch((e) => {
      noteServerBackoff(e);
      const message = errMsg(e);
      opts.err(
		`[${workflow}/${run}] release failed: ${message} — leaving the hub pickup window to re-offer it`,
      );
      emit({ type: 'hub-error', op: 'release', workflow, message });
    });
  }

  const formatReleaseReason = (reason: OrderDroppedEvent['reason'], message: string): string => `${reason}: ${message}`;

  function acquireDispatchLock(waitMs: number, label: string) {
    return acquireFileLockSync(join(opts.stateDir, '.dispatch.lock'), {
      ...opts.dispatchLockOptions,
      waitMs,
      label,
    });
  }

  const lockedRemovalCallbacks = createLockedRemovalCallbacks(opts.stateDir, {
    dispatchLockOptions: opts.dispatchLockOptions,
  });

  function removeRecordUnderDispatchLock(
    run: string,
    recordOptions?: { pid?: number },
    waitMs = 30_000,
    label = 'owenloop Shift dispatch-state removal',
  ): boolean {
    return removeChildRecordUnderDispatchLock(opts.stateDir, run, recordOptions, {
      dispatchLockOptions: opts.dispatchLockOptions,
      waitMs,
      label,
    });
  }

  function reconcile() {
    const result = reconcileInFlight(opts.stateDir, {
      ...(isAlive !== undefined ? { isAlive } : {}),
      now: opts.now(),
      ...lockedRemovalCallbacks,
    });
    for (const rec of result.reaped) {
      emit({
        type: 'reaped',
        workflow: rec.workflow,
        run: rec.run,
        kind: rec.kind ?? 'exec',
        pid: rec.pid,
      });
    }
    for (const reservation of result.abandoned) {
      opts.err(
	`[${reservation.workflow}/${reservation.run}] abandoned ${reservation.childKind} dispatch reservation expired and was cancelled`,
      );
    }
    return result;
  }

  /**
   * Per-step failure history for the brake. Keyed by `(workflow, step, key)` —
   * see `stepBrakeKey`. `count` is the current consecutive-failure streak for
   * that step, `failedAt` the monotonic instant of the most recent failure (the
   * input to the `STEP_BRAKE_DECAY_MS` streak reset), and `nextAllowedAt` the
   * monotonic instant the next spawn of that step becomes permitted.
   */
  const stepBrake = new Map<string, { count: number; failedAt: number; nextAllowedAt: number }>();

  /**
   * Charge one failure against a step's brake, extending the current streak or
   * starting a new one.
   *
   * Shared by both places a dispatch can die: the worker failing after it
   * started (`noteWorkerFailure`) and the spawn itself failing before it ever
   * did (`dispatchCandidate`'s catch). Both now hand the claim back, and a
   * released claim is re-offered immediately instead of lapsing after the
   * 120s reap — so the brake, not the reap, is what throttles a step that
   * keeps dying. Charging from only one of the two paths would leave the other
   * free-running against the hub.
   */
  const chargeStepBrake = (brakeKey: string): void => {
    const at = monotonicNow();
    const prior = stepBrake.get(brakeKey);
    // A failure long after the previous one starts a NEW streak rather than
    // extending a stale one — see `STEP_BRAKE_DECAY_MS`.
    const priorCount = prior !== undefined && at - prior.failedAt < STEP_BRAKE_DECAY_MS
      ? prior.count
      : 0;
    const count = priorCount + 1;
    stepBrake.set(brakeKey, { count, failedAt: at, nextAllowedAt: at + stepBrakeDelayMs(count) });
  };

  /**
   * Brake key of the step each dispatched run belongs to.
   *
   * A `WorkerFailure` carries the run id and the step name but NOT the fan-out
   * key, and the brake identity includes the key — so the mapping is recorded
   * here at dispatch, when the whole order is in hand, rather than
   * reconstructed from the failure. Written synchronously in
   * `dispatchCandidate` immediately after the spawn returns, which always
   * precedes the child's `exit` event (that fires on a later tick), so a
   * failure can never arrive before its own entry exists.
   *
   * Entries are removed when the run's failure is noted and, in production,
   * for any run no longer live at sweep time — that prune is what bounds the
   * map. (`noteRunEnded` also clears one, but nothing in `src/` calls it; see
   * its declaration.) So an entry's presence means "this shift dispatched this
   * run and has not pruned it yet", NOT "the run is still open".
   */
  const runBrakeKey = new Map<string, string>();

  type DispatchResult =
    | 'dispatched'
    | 'duplicate'
    | 'total-capacity'
    | 'agent-capacity'
    | 'braked'
    | 'failed';

  /**
   * Recheck shared capacity and create the per-run reservation while holding one
   * state-directory-wide lock. The lock ends before spawn: the durable
   * reservation, not a long critical section, protects capacity during spawn.
   */
  function reserveCandidate(c: Candidate): ReservedChild | Exclude<DispatchResult, 'dispatched' | 'failed'> {
    const childKind = c.kind === 'command' ? 'exec' : 'agent-run';
    const dispatchLock = acquireDispatchLock(30_000, 'owenloop Shift dispatch');
    try {
      const fresh = reconcileInFlight(opts.stateDir, {
	...(isAlive === undefined ? {} : { isAlive }),
	now: opts.now(),
      });
      if (
	fresh.live.some((record) => record.run === c.order.run) ||
	fresh.reserved.some((record) => record.run === c.order.run)
      ) return 'duplicate';
      if (fresh.live.length + fresh.reserved.length >= cap) return 'total-capacity';
      if (childKind === 'agent-run') {
	const agents = fresh.live.filter((record) => record.kind === 'agent-run').length +
	  fresh.reserved.filter((record) => record.childKind === 'agent-run').length;
	if (agents >= agentLane().ceiling) return 'agent-capacity';
      }
      return reserveChild(opts.stateDir, {
	workflow: c.workflow,
	run: c.order.run,
	reservedAt: opts.now(),
	childKind,
	step: c.order.step,
      });
    } finally {
      releaseFileLock(dispatchLock);
    }
  }

  function dispatchCandidate(c: Candidate): DispatchResult {
    const childKind = c.kind === 'command' ? 'exec' : 'agent-run';
    // THE BRAKE. This function is the single choke point every spawn passes
    // through — both the sweep's dispatch loop and `drainPending` reach a child
    // only through here — so gating it here cannot be bypassed by either path.
    // Braking BEFORE `reserveCandidate` means no reservation, no state-dir
    // write and no lock contention for an order this shift will not run. The
    // claim already taken by `whats_next` is deliberately left to lapse: the
    // hub reaps a never-contacted claim after 120s, which throttles the
    // re-offer rate on the hub side too.
    const brakeKey = stepBrakeKey(c.workflow, c.order.step, c.order.key);
    const brake = stepBrake.get(brakeKey);
    if (brake !== undefined && monotonicNow() < brake.nextAllowedAt) {
      const waitMs = Math.round(brake.nextAllowedAt - monotonicNow());
      opts.err(
	`[${c.workflow}/${c.order.run}] step '${c.order.step}' has failed ` +
	`${brake.count} time(s) in a row — braking for ${waitMs}ms and ` +
	`leaving this claim to lapse`,
      );
      brakeSweepDueAt = brakeSweepDueAt === undefined
	? brake.nextAllowedAt
	: Math.min(brakeSweepDueAt, brake.nextAllowedAt);
      return 'braked';
    }
    let reservation: ChildReservation | undefined;
    let cancel: (() => void) | undefined;
    try {
      const reserved = reserveCandidate(c);
      if (typeof reserved === 'string') return reserved;
      reservation = reserved.reservation;
      const spawned = opts.spawner({
	workflow: c.workflow,
	run: c.order.run,
	step: c.order.step,
	...(childKind === 'agent-run' ? { kind: 'agent-run' as const } : {}),
	...(childKind === 'agent-run' ? { shiftName } : {}),
	...(childKind === 'agent-run' && opts.shiftOwner !== undefined ? { shiftOwner: opts.shiftOwner } : {}),
	startGate: reserved.gatePath,
      });
      cancel = spawned.cancel ?? spawned.terminate;
      const dispatchLock = acquireDispatchLock(30_000, 'owenloop Shift dispatch');
      let rec: ChildRecord;
      try {
	rec = finalizeChildReservation(opts.stateDir, reservation, {
	  pid: spawned.pid,
	  spawnedAt: opts.now(),
	  kind: childKind,
	  ...(childKind === 'agent-run' && c.defName !== undefined ? { def: c.defName } : {}),
	  ...(childKind === 'agent-run' && c.defHash !== undefined ? { hash: c.defHash } : {}),
	  ...(childKind === 'agent-run' ? { step: c.order.step } : {}),
	});
	startReservedChild(opts.stateDir, rec);
      } finally {
	releaseFileLock(dispatchLock);
      }
      // Remember which step this run belongs to, so a later worker failure —
      // which names the run but not the fan-out key — can be charged to the
      // right brake key. NOTHING is counted here: a dispatch is not evidence of
      // trouble, and counting it would meter the legitimately concurrent runs
      // of one step that a single sweep can offer.
      runBrakeKey.set(c.order.run, brakeKey);
      emit({
	type: 'dispatched',
	workflow: c.workflow,
	run: c.order.run,
	step: c.order.step,
	kind: childKind,
	pid: spawned.pid,
      });
      opts.out(
	`dispatched ${c.kind === 'command' ? 'command' : 'agent-run'} ${c.workflow}/${c.order.run} ` +
	`(step '${c.order.step}', pid ${spawned.pid})`,
      );
      return 'dispatched';
    } catch (e) {
      cancel?.();
      if (reservation !== undefined) {
	try {
	  const dispatchLock = acquireDispatchLock(30_000, 'owenloop Shift dispatch');
	  try {
	    cancelReservedChild(opts.stateDir, reservation);
	  } finally {
	    releaseFileLock(dispatchLock);
	  }
	} catch (cleanupError) {
	  opts.err(
	    `[${c.workflow}/${c.order.run}] failed to cancel dispatch reservation: ${errMsg(cleanupError)}`,
	  );
	}
      }
      const message = errMsg(e);
      emit({
	type: 'failed',
	workflow: c.workflow,
	run: c.order.run,
	step: c.order.step,
	kind: childKind,
	message,
      });
      const prefix = c.kind === 'command' ? 'spawn' : 'agent-run spawn';
      // Two different failures reach this one catch, and an operator reading the
      // release reason needs to know which. `cancel` is assigned only after
      // `opts.spawner` returns, so it is the exact witness: undefined means the
      // spawn itself threw and no child ever existed; defined means a child WAS
      // running and something after it threw — the reservation write, the
      // dispatch lock, or `opts.out` on a full disk — and `cancel()` above has
      // just killed it. Calling both "failed" told an operator to look for a
      // fork problem that never happened.
      const startedThenAborted = cancel !== undefined;
      opts.err(`${prefix} for ${c.workflow}/${c.order.run} failed: ${message}`);
      // Hand the claim back. `whats_next` took it before this function ran, and
      // reaching here means no worker exists to hand it back for itself — either
      // no child was ever started, or `cancel()` has just killed the one that
      // was. Without this the order sits INFLIGHT with a heartbeat that will
      // never tick again, which is the same invisible stall a dead worker
      // leaves.
      //
      // No `WorkerFailure` is ever reported for this path — the spawn never
      // returned, or the child was killed before it could report — so
      // `noteWorkerFailure` cannot cover it.
      //
      // Charge the brake from here too. A released claim is re-offered at once
      // rather than lapsing after the 120s reap, so on a host that cannot fork
      // at all the brake is now the only thing standing between this shift and
      // a claim-fail-release loop against the hub.
      //
      // Drop the run's brake-key mapping first. On the aborted-child arm
      // `runBrakeKey` may already be set, and leaving it would let a later
      // `noteWorkerFailure` for the same run release a second time and charge
      // the brake twice for one logical failure. Nothing depends on the entry
      // once the claim is released, so deleting it is unconditional.
      releaseClaim(
	c.workflow,
	c.order.run,
	clampReason(
	  `shift supervisor: ${prefix} ${startedThenAborted ? 'started then aborted' : 'failed'} — ${message}`,
	),
      );
      runBrakeKey.delete(c.order.run);
      chargeStepBrake(brakeKey);
      return 'failed';
    }
  }

  function discardExpiredCandidate(candidate: Candidate, queued: boolean): boolean {
    const holdMs = queued ? localQueueHoldMs() : MAX_PENDING_CANDIDATE_AGE_MS;
    if (monotonicNow() - candidate.requestStartedAt < holdMs) return false;
    const prefix = queued ? 'queued claim' : 'claim';
    const message = `${prefix} expired before local dispatch — handing the claim back to the hub`;
    opts.err(`[${candidate.workflow}/${candidate.order.run}] ${message}`);
    emit({
      type: 'order-dropped',
      workflow: candidate.workflow,
      run: candidate.order.run,
      step: candidate.order.step,
      reason: 'claim-expired',
      message,
    });
    releaseClaim(candidate.workflow, candidate.order.run, formatReleaseReason('claim-expired', message));
    return true;
  }

  /** Dispatch already-claimed orders when local child capacity becomes free. */
  function drainPending(live: ChildRecord[], reserved: ChildReservation[]): number {
    let remaining = cap - live.length - reserved.length;
    if (pendingCandidates.size === 0) return 0;

    const { ceiling } = agentLane();
    let agentRoom = ceiling -
      live.filter((r) => r.kind === 'agent-run').length -
      reserved.filter((r) => r.childKind === 'agent-run').length;
    const liveRuns = new Set([...live.map((r) => r.run), ...reserved.map((r) => r.run)]);
    let dispatched = 0;

    for (const [run, candidate] of pendingCandidates) {
      if (discardExpiredCandidate(candidate, true)) {
	pendingCandidates.delete(run);
	continue;
      }
      if (liveRuns.has(run)) {
	pendingCandidates.delete(run);
	continue;
      }
      // Even at full capacity, keep scanning so a configured local hold is a
      // real deadline rather than one deferred until another child exits.
      if (remaining <= 0) continue;
      // The agent lane's second budget can be full while the dispatch cap still
      // has room. Skip this entry and KEEP it queued (a command entry further
      // down the map is still dispatchable) — `continue`, never `break`, so one
      // blocked agent does not head-of-line-block the whole queue.
      if (candidate.kind === 'agent' && agentRoom <= 0) continue;

      const result = dispatchCandidate(candidate);
      if (result === 'total-capacity') {
	remaining = 0;
	continue;
      }
      if (result === 'agent-capacity') {
	agentRoom = 0;
	continue;
      }
      pendingCandidates.delete(run);
      if (result !== 'dispatched') continue;

      dispatched++;
      remaining--;
      liveRuns.add(run);
      if (candidate.kind === 'agent') agentRoom--;
    }

    return dispatched;
  }

  /**
   * One sweep. Collects dispatch candidates across the target instance(s)
   * within the free-capacity `budget`, then dispatches by kind: a command order
   * spawns a detached `owenloop work exec` child, an agent order a detached
   * `owenloop work agent-run` child. Returns how many children were spawned, plus the
   * polled/open-run sets the work-dir reaper needs.
   */
  async function sweep(
    budget: number,
    live: ChildRecord[],
    reserved: ChildReservation[],
  ): Promise<SweepResult> {
    let dispatched = 0;
    // Housekeeping for both brake maps, once per sweep rather than on write, so
    // neither can grow for the life of a long-lived shift.
    //
    // `stepBrake`: forget an entry whose window closed STEP_BRAKE_FORGET_MS
    // ago. Behaviour is already governed by STEP_BRAKE_DECAY_MS, which resets a
    // stale streak; this only reclaims the memory.
    //
    // `runBrakeKey`: drop every run that is no longer live. A run whose child
    // exited CLEANLY reports no failure, so nothing else would ever remove its
    // entry. A non-zero exit is charged by `noteWorkerFailure`, which the
    // child's own `exit` event drives on the next event-loop tick — always well
    // before the next sweep, which waits a whole poll interval.
    //
    // This prune is the only clearer for a run that exits CLEANLY, and is
    // therefore what bounds the map — a failing run is cleared by
    // `noteWorkerFailure`, and an aborted dispatch clears its own entry. That
    // makes the ordering matter more than it used to. `noteWorkerFailure` now also
    // releases the claim, so an inversion here no longer costs one uncharged
    // failure: it costs a claim nobody hands back, which is the stall this
    // release exists to end. `iteration()` closes the window — `reconcile()`
    // snapshots `live` and then awaits `hub.wake`, and a queued `exit` event is
    // delivered during that await, so a child that died before the snapshot has
    // already been charged and one that died after is still inside it.
    for (const [key, entry] of stepBrake) {
      if (monotonicNow() - entry.nextAllowedAt > STEP_BRAKE_FORGET_MS) stepBrake.delete(key);
    }
    const liveOrReserved = new Set([...live.map((r) => r.run), ...reserved.map((r) => r.run)]);
    for (const run of runBrakeKey.keys()) {
      if (!liveOrReserved.has(run)) runBrakeKey.delete(run);
    }
    pruneExpiredCapacityCooldown();
    /**
     * PHASE 4, for the work-dir reaper only. `polled` is the set of workflows
     * whose `whats_next` SUCCEEDED this sweep — a workflow whose call threw is
     * deliberately left out, because a failed call is not evidence that a run
     * has no open order, and the reaper must never treat silence as absence.
     * `openRuns` is every run those calls reported an order for, including ones
     * this shift declined to dispatch (capacity, routing, an in-flight worker):
     * an order the shift left alone is still an open order, and its run's work
     * directory must survive.
     */
    const polled = new Set<string>();
    const openRuns = new Set<string>();
    let complete = true;
    let releasedForCapacity = false;
    let remaining = budget;
    const liveRuns = new Set([...live.map((r) => r.run), ...reserved.map((r) => r.run)]);

    // The agent lane's SECOND budget (D7). Counted from live records and durable
    // reservations, so a crash between reservation and spawn cannot overbook it.
    // A child or reservation that is reaped frees the slot on the next reconcile.
    const { ceiling, requested, reserve } = agentLane();
    const agentCapLabel = reserve > 0 && ceiling < requested
      ? `${ceiling}, ${requested} requested minus a ${reserve}-slot exec reserve`
      : `${ceiling}`;
    let agentRoom = ceiling -
      live.filter((r) => r.kind === 'agent-run').length -
      reserved.filter((r) => r.childKind === 'agent-run').length;
    /**
     * Runs that ALREADY have a live `agent-run` child. An agent-run child is a
     * PROCESS: re-dispatching one would put a second harness session on a single
     * claim — two step agents briefed for the same order, racing to submit. So a
     * re-offer for a run a worker already holds is skipped outright, the way the
     * command lane does it.
     */
    const workerRuns = new Set([
      ...live.filter((r) => r.kind === 'agent-run').map((r) => r.run),
      ...reserved.filter((r) => r.childKind === 'agent-run').map((r) => r.run),
    ]);

    // Resolve which instances to poll. Fleet candidates retain their source
    // inbox row so only a proven zero may avoid a targeted observation. An
    // explicit workflow has no inbox row and must always receive one.
    let instances: PollCandidate[];
    if (opts.workflow !== undefined) {
      instances = [{ workflow: opts.workflow }];
    } else {
      try {
	const inbox = await hubCall('inbox whats_next', (signal) =>
	  opts.hub.whatsNext({ serve_capabilities: [...serveCapabilities] }, signal));
	instances = (inbox.instances ?? []).map((inbox) => ({ workflow: inbox.workflow, inbox }));
      } catch (e) {
	noteServerBackoff(e);
        opts.err(`inbox whats_next failed: ${errMsg(e)}`);
	// THE THIRD HUB-CALL FAILURE PATH, and the most consequential: this one
	// aborts the WHOLE sweep, because the shift never learned which
	// workflows to poll. The targeted `whats_next` below loses one workflow
	// and the `wake` above loses one tick; this loses everything. It is
	// recorded on the same terms as the other two, with `workflow` absent —
	// that omission is what distinguishes the untargeted inbox call from a
	// per-workflow one, since `HubErrorEvent.workflow` is optional.
	emit({ type: 'hub-error', op: 'whats_next', message: errMsg(e) });
	return { dispatched, polled, openRuns, complete: false, releasedForCapacity };
      }
    }

    // Collect candidates, metering NEW dispatches and deduping in-flight.
    const claimed = new Set<string>();
    const candidates: Candidate[] = [];

    /**
     * Refuse one order. Some reasons intentionally leave the claim for the hub
     * pickup window; capacity reasons use `releaseOrder` below instead.
     *
     * Every refusal below is a DROPPED UNIT OF WORK, not a debug aside: the
     * shift declines an order the hub already handed it, and until now the only
     * trace was a stderr line a dispatched shift discards. One helper, so the
     * console text and the record cannot drift apart, and so a future refusal
     * cannot be added as text-only by accident. `reason` is the stable machine
     * discriminator; `message` is the same human text as before, unchanged.
     */
    const dropOrder = (
      workflow: string,
      order: WorkOrder,
      reason: OrderDroppedEvent['reason'],
      message: string,
    ): void => {
      opts.err(`[${workflow}/${order.run}] ${message}`);
      emit({ type: 'order-dropped', workflow, run: order.run, step: order.step, reason, message });
      claimed.add(order.run);
    };
    /**
     * Refuse an order because this shift lacks capacity, then hand its claim
     * back so a sibling daemon may dispatch it immediately.
     */
    const releaseOrder = (
      workflow: string,
      order: WorkOrder,
      reason: OrderDroppedEvent['reason'],
      message: string,
    ): void => {
      dropOrder(workflow, order, reason, message);
      releaseClaim(workflow, order.run, formatReleaseReason(reason, message));
      // Re-arm the next sweep, but only for the two TRANSIENT reasons — see
      // `SweepResult.releasedForCapacity` for why `agent-lane-closed` is not
      // one of them. The independent cooldown prevents a busy cursor from
      // immediately re-claiming this stable step while the same capacity class
      // remains unavailable; it neither replaces server Retry-After backoff
      // nor the worker-failure brake.
      if (reason === 'dispatch-cap-full' || reason === 'agent-cap-full') {
	armCapacityCooldown(workflow, order, reason);
	releasedForCapacity = true;
      }
    };
    for (const candidate of instances) {
      const wf = candidate.workflow;
      // Skipping means no targeted hub observation happened: leave this
      // workflow out of `polled`/`openRuns` so the work-directory reaper never
      // mistakes damping for an empty response. The inbox call and other
      // workflows remain eligible.
      if (workflowCapacityCooldownActive(wf, remaining, agentRoom)) continue;
      // Only a numeric zero is authoritative enough to skip. Missing or
      // malformed wire data deliberately falls through to the targeted call.
      // This runs after the cooldown check so a newly ready cooldown is cleared.
      if (candidate.inbox?.eligible === 0) continue;
      let res;
      const requestStartedAt = monotonicNow();
      try {
	res = await hubCall(`whats_next ${wf}`, (signal) =>
	  opts.hub.whatsNext({
	    workflow: wf,
	    serve_crews: serveCrews,
	    serve_capabilities: [...serveCapabilities],
	  }, signal));
      } catch (e) {
	if (isNonServableRace(e)) {
	  // Treat the targeted call as a successful empty observation for the
	  // work-dir reaper and consume this wake. A later hub event may list
	  // new work, but this stale terminal row must not force every poll to
	  // repeat the same ForbiddenError.
	  polled.add(wf);
	  opts.out(`[${wf}] skipped stale terminal inbox candidate`);
	  continue;
	}
	const rateLimited = noteServerBackoff(e);
	complete = false;
        opts.err(`whats_next for ${wf} failed: ${errMsg(e)}`);
	emit({ type: 'hub-error', op: 'whats_next', workflow: wf, message: errMsg(e) });
	if (rateLimited) break;
        continue;
      }
      const orders = res.orders ?? [];
      polled.add(wf);
      for (const o of orders) openRuns.add(o.run);
      const defName = res.def;
      const legacyOrders = orders.filter((order) =>
	!Object.prototype.hasOwnProperty.call(order, 'worker') &&
	!Object.prototype.hasOwnProperty.call(order, 'defDigest'));
      // The definition-name cache exists only for the explicitly identified old
      // wire shape. Modern orders route from `worker` and exact `defDigest`.
      const dispatch = legacyOrders.length > 0 && defName !== undefined
	? readDispatchBundle(opts.cacheDir, defName)
	: { bundle: null };
      const bundle = dispatch.bundle;
      if (legacyOrders.length > 0 && dispatch.warning !== undefined) {
        opts.err(`[${wf}] ${dispatch.warning}`);
      } else if (legacyOrders.length > 0 && bundle === null && defName !== undefined) {
	opts.err(`no cached bundle for def '${defName}' — run \`owenloop work prepare ${defName}\` (legacy orders left for pickup)`);
	emit({ type: 'bundle-miss', workflow: wf, def: defName });
      }
      for (const order of orders) {
        if (claimed.has(order.run)) continue; // seen this sweep
	if (pendingCandidates.has(order.run)) continue; // already claimed and queued locally
        const reoffer = liveRuns.has(order.run);
	const workerPresent = Object.prototype.hasOwnProperty.call(order, 'worker');
	const digestPresent = Object.prototype.hasOwnProperty.call(order, 'defDigest');
	const legacy = !workerPresent && !digestPresent;
	let step: FetchedStep | undefined;
	let kind: Candidate['kind'];
	let candidateDefName: string | undefined;
	let candidateDefHash: string | undefined;

	if (legacy) {
	  step = bundle?.def.steps.find((candidate) => candidate.name === order.step);
	  if (step === undefined || bundle === null) continue;
	  kind = isCommandStep(step) ? 'command' : 'agent';
	  candidateDefName = defName;
	  candidateDefHash = bundle.def.hash;
	} else {
	  if (typeof order.defDigest !== 'string' || order.defDigest.trim() === '') {
	    dropOrder(
	      wf,
	      order,
	      'malformed-digest',
	      'malformed modern work order: non-empty defDigest is required whenever modern routing metadata is present — leaving for manual pickup',
	    );
	    continue;
	  }

	  // The deployed projection omits `worker` for the default executor. That
	  // shape is a modern AGENT order because `defDigest` pins the exact step;
	  // only an explicitly authored executor produces `worker` on the wire.
	  if (!workerPresent || order.worker === 'agent') {
	    kind = 'agent';
	  } else if (order.worker === 'command') {
	    kind = 'command';
	    try {
	      step = await opts.resolveOrderStep?.(order);
	    } catch (error) {
	      dropOrder(
		wf,
		order,
		'verification-failed',
		`exact command instructions for digest '${order.defDigest}' failed verification: ${errMsg(error)} — leaving for manual pickup`,
	      );
	      continue;
	    }
	    if (step === undefined) {
	      dropOrder(
		wf,
		order,
		'metadata-unavailable',
		`exact command routing metadata for digest '${order.defDigest}' is unavailable — leaving for manual pickup`,
	      );
	      continue;
	    }
	  } else if (typeof order.worker !== 'string' || order.worker.trim() === '') {
	    dropOrder(
	      wf,
	      order,
	      'malformed-worker',
	      "malformed modern work order: worker must be absent, 'agent', or 'command' — leaving for manual pickup",
	    );
	    continue;
	  } else {
	    dropOrder(
	      wf,
	      order,
	      'unsupported-worker',
	      `unsupported worker '${order.worker}' — leaving for manual pickup`,
	    );
	    continue;
	  }
	}

	if (kind === 'command') {
	  // A command already in flight (or durably reserved) is never respawned.
          if (reoffer) continue;
	  if (step === undefined) continue;
	  const routing = resolveCommandRouting(opts.commandRouting, step);
	  for (const warning of routing.warnings) opts.err(`[${wf}/${order.run}] ${warning}`);
	  if (!routing.autoDispatch) {
	    opts.out(`[${wf}/${order.run}] command step '${order.step}' routed to manual — leaving for pickup window`);
            continue;
          }
	  const candidate: Candidate = {
	    order,
	    workflow: wf,
	    step,
	    defName: candidateDefName,
	    defHash: candidateDefHash,
	    kind,
	    requestStartedAt,
	    reoffer,
	  };
	  if (discardExpiredCandidate(candidate, false)) {
	    claimed.add(order.run);
	    continue;
	  }
	  if (remaining <= 0) {
	    if (localQueueHoldMs() > 0) {
	      pendingCandidates.set(order.run, candidate);
	      opts.out(`[${wf}/${order.run}] at the dispatch cap (${cap}) — queued for local dispatch`);
	    } else {
	      releaseOrder(
		wf,
		order,
		'dispatch-cap-full',
		`at the dispatch cap (${cap}) — handing the claim back to the hub`,
	      );
	    }
	  } else {
	    remaining--;
	    candidates.push(candidate);
	  }
          claimed.add(order.run);
          continue;
        }

	// Agent wire routing is authoritative. The detached agent-run resolves its
	// own exact step and harness from the order digest, never from this cache.
	// A re-offer already has a live child record; never release it.
        if (workerRuns.has(order.run)) continue;
	const candidate: Candidate = {
	  order,
	  workflow: wf,
	  step: legacy ? step : undefined,
	  defName: candidateDefName,
	  defHash: candidateDefHash,
	  kind,
	  requestStartedAt,
	  reoffer,
	};
	if (discardExpiredCandidate(candidate, false)) {
	  claimed.add(order.run);
	  continue;
	}

	if (ceiling === 0) {
	  releaseOrder(
	    wf,
	    order,
	    'agent-lane-closed',
	    'this shift runs no agent-run children (agent ceiling 0) — handing the claim back to the hub',
	  );
	  continue;
	}
	if (!reoffer && remaining <= 0) {
	  if (localQueueHoldMs() > 0) {
	    pendingCandidates.set(order.run, candidate);
	    opts.out(`[${wf}/${order.run}] at the dispatch cap (${cap}) — queued for local dispatch`);
	  } else {
	    releaseOrder(
	      wf,
	      order,
	      'dispatch-cap-full',
	      `at the dispatch cap (${cap}) — handing the claim back to the hub`,
	    );
	  }
	} else if (!reoffer && agentRoom <= 0) {
	  if (localQueueHoldMs() > 0) {
	    pendingCandidates.set(order.run, candidate);
	    opts.out(`[${wf}/${order.run}] at the agent-run cap (${agentCapLabel}) — queued for local dispatch`);
	  } else {
	    releaseOrder(
	      wf,
	      order,
	      'agent-cap-full',
	      `at the agent-run cap (${agentCapLabel}) — handing the claim back to the hub`,
	    );
	  }
	} else {
	  if (!reoffer) {
	    remaining--;
	    agentRoom--;
          }
	  candidates.push(candidate);
        }
        claimed.add(order.run);
      }
    }

    // 'braked' and 'failed' are deliberately NOT queued into pendingCandidates:
    // both mean this shift is not going to run that order now, and re-queuing a
    // braked candidate would just re-dispatch it on the next drain, defeating
    // the brake.
    //
    // What happens to the claim differs between the two, and the difference is
    // the point of this change. A BRAKED candidate was never dispatched, so its
    // claim lapses through the hub's pickup window — the delay is deliberate,
    // and shedding it is what the brake is for. A FAILED one hands its claim
    // back explicitly in `dispatchCandidate`, so it is re-offered at once
    // instead of sitting INFLIGHT behind a heartbeat that will never tick.
    for (const candidate of candidates) {
      if (discardExpiredCandidate(candidate, false)) continue;
      const result = dispatchCandidate(candidate);
      if (result === 'dispatched') {
	dispatched++;
	continue;
      }
      if (result === 'total-capacity' || result === 'agent-capacity') {
	const limit = result === 'total-capacity'
	  ? `dispatch cap (${cap})`
	  : `agent-run cap (${agentCapLabel})`;
	if (localQueueHoldMs() > 0) {
	  pendingCandidates.set(candidate.order.run, candidate);
	  opts.out(
	    `[${candidate.workflow}/${candidate.order.run}] lost a shared-capacity race at the ${limit} — queued for local dispatch`,
	  );
	} else {
	  releaseOrder(
	    candidate.workflow,
	    candidate.order,
	    result === 'total-capacity' ? 'dispatch-cap-full' : 'agent-cap-full',
	    `lost a shared-capacity race at the ${limit} — handing the claim back to the hub`,
	  );
	}
      }
    }

    return { dispatched, polled, openRuns, complete, releasedForCapacity };
  }

  /**
   * PHASE 4 — remove the per-run work directories of runs that are over.
   *
   * The three inputs, and where each comes from:
   *  - `workflows` = `swept.polled`, the workflows whose `whats_next` succeeded.
   *  - `openRunIds` = `swept.openRuns`, every run those calls reported an order
   *    for, dispatched or not.
   *  - `liveRunIds` = the runs of live `agent-run` records, pid-probed by
   *    `reconcileInFlight`. Only `agent-run` records are counted: those are the
   *    only children that hold a work directory — an `exec` child works in the
   *    shift's own cwd.
   *
   * The fourth input is `sessionsFile`: `<cacheDir>/sessions.jsonl`, the same
   * path `owenloop work agent-run` writes its session records to (`src/roles/
   * agent-run.ts` builds it from the SAME `resolveCacheDir`). The sweep marks
   * every session of a reaped run `dead` there BEFORE removing its directory —
   * session lifetime equals cwd lifetime, and without that write the next firing
   * of the step would resume into a recreated, empty directory.
   *
   * Best effort throughout — a removal failure is reported and the sweep goes on.
   * Disabled entirely when `workRoot` is unset.
   */
  function reapWorkDirs(swept: SweepResult | undefined, liveAfter: ChildRecord[]): void {
    const workRoot = opts.workRoot;
    if (workRoot === undefined || workRoot === '' || swept === undefined) return;
    if (swept.polled.size === 0) return;
    const doSweep = opts.sweepWorkDirs ?? sweepWorkDirsImpl;
    const liveRunIds = new Set(liveAfter.filter((r) => r.kind === 'agent-run').map((r) => r.run));
    let removed: string[];
    try {
      removed = doSweep({
        workRoot,
        workflows: swept.polled,
        openRunIds: swept.openRuns,
        liveRunIds,
        now: opts.now(),
        ttlMs: opts.workDirTtlMs ?? DEFAULT_WORK_DIR_TTL_MS,
        sessionsFile: sessionsPath(opts.cacheDir),
        ...(opts.workRepo !== undefined ? { workRepo: opts.workRepo } : {}),
        err: opts.err,
      });
    } catch (e) {
      opts.err(`work-dir reaper failed: ${errMsg(e)} (ignored)`);
      return;
    }
    for (const dir of removed) opts.out(`reaped work directory ${dir}`);
  }

  async function iteration(): Promise<number> {
    const backoffActiveAtStart = monotonicNow() < backoffUntil;
    let rateLimitedThisIteration = false;

    // Hub roster cache refresh is low-priority operational work. Its absence is
    // always a degraded read for children, never a reason to stop dispatch.
    if (
      !backoffActiveAtStart &&
      opts.syncRosters !== undefined &&
      opts.rosterSyncIntervalMs !== undefined &&
      monotonicNow() - lastRosterSync >= opts.rosterSyncIntervalMs
    ) {
      try {
	await withHubRosterSyncTimeout((signal) => opts.syncRosters!(signal), opts.rosterSyncTimeoutMs);
      } catch (e) {
	rateLimitedThisIteration = noteServerBackoff(e);
	opts.err(`roster sync failed: ${errMsg(e)} (continuing)`);
	emit({ type: 'hub-error', op: 'roster_sync', message: `roster sync failed: ${errMsg(e)} (continuing)` });
      } finally {
	// This is a periodic attempt cadence, not a success-only retry loop. A
	// persistent non-429 failure must not make every 5s poll issue two more
	// hub calls and append another durable failure record.
	lastRosterSync = monotonicNow();
	refreshServeCapabilities();
      }
    }

    // Presence when due (starts immediately — this shift exists to conduct).
    // A server backoff suppresses every hub poll, including presence, while local
    // reconciliation and queued dispatch continue below.
    if (
      !backoffActiveAtStart &&
	!rateLimitedThisIteration &&
      monotonicNow() - lastPresence >= opts.presenceIntervalMs
    ) {
      // `setShift` and `noteAttended` force the next ping by setting
      // lastPresence to -Infinity. Either can land WHILE this ping is awaiting
      // the hub, so record the generation first: on completion, only stamp the
      // cadence if no force arrived in the meantime. Stamping unconditionally
      // would swallow that sentinel and defer the newly recorded attendance or
      // identity by a full presenceIntervalMs.
      const generation = ++presenceGeneration;
      try {
        await hubCall('presence ping', (signal) =>
          opts.hub.presencePing({
            name: shiftName,
            serve_crews: serveCrews,
            serve_capabilities: [...serveCapabilities],
            ...(opts.shiftId !== undefined ? { shift_id: opts.shiftId } : {}),
            ...(opts.startedAt !== undefined ? { started_at: opts.startedAt } : {}),
            ...(attendedAt !== undefined ? { attended_at: attendedAt } : {}),
          }, signal));
	if (generation === presenceGeneration) lastPresence = monotonicNow();
      } catch (e) {
	rateLimitedThisIteration = noteServerBackoff(e);
        opts.err(`presence ping failed: ${errMsg(e)} (continuing)`);
      }
    }

    // Reconcile in-flight first. A child exit is local state, not a hub event,
    // so use the freed slot to dispatch claims retained from an earlier sweep
    // before consulting the wake cursor.
    let inFlight = reconcile();
    let dispatched = drainPending(inFlight.live, inFlight.reserved);
    if (dispatched > 0) inFlight = reconcile();
    const live = inFlight.live;
    const reserved = inFlight.reserved;
    const occupied = live.length + reserved.length;
    const k = cap - occupied;
    const agentRoom = agentLane().ceiling -
      live.filter((record) => record.kind === 'agent-run').length -
      reserved.filter((record) => record.childKind === 'agent-run').length;
    // Re-arm the at-capacity report the instant a slot frees, independently of
    // whether this tick goes on to wake or sweep. The next stretch at capacity
    // is a NEW episode and gets its own record.
    if (k > 0) atCapReported = false;

    // Retry-After suppresses every remaining hub call in the iteration that
    // received it, and every hub call in later iterations before the deadline.
    // Local child reconciliation and queued-claim dispatch above still run.
    if (
      backoffActiveAtStart ||
      rateLimitedThisIteration ||
      monotonicNow() < backoffUntil
    ) {
      return dispatched;
    }

    // Cheap wake pre-check. A failed call also suppresses a forced retry for this
    // tick: a rate-limited wake should not immediately be followed by whats_next.
    let changed = false;
    let wakeSucceeded = false;
    try {
      // Under the per-call deadline: a timeout lands in the catch below on the
      // same terms as any other non-rate-limited failure (issue #300).
      const w = await hubCall('wake', (signal) => opts.hub.wake(cursor, signal));
      changed = w.changed;
      cursor = w.cursor;
      wakeSucceeded = true;
      // The loop's one unconditional hub call per unbackoffed tick, so its
      // success is the cheapest honest proof that this host can reach the hub.
      hubFailureStreak = 0;
    } catch (e) {
      const rateLimited = noteServerBackoff(e);
      opts.err(`wake failed: ${errMsg(e)} (retrying next tick)`);
      emit({ type: 'hub-error', op: 'wake', message: errMsg(e) });
      if (!rateLimited) {
        hubFailureStreak += 1;
        // Every HOST_PREFLIGHT_STREAK-th failure, not only the first crossing:
        // a work root can be unmounted at failure seven, and a shift that
        // checked once at failure three would never see it. The check is
        // `stat`-only and adds no hub traffic, so repeating it is nearly free.
        if (hubFailureStreak % HOST_PREFLIGHT_STREAK === 0 && runHostPreflight(hubFailureStreak)) {
          return dispatched;
        }
      }
    }

    // A changed cursor is not sufficient by itself: if the prior changed tick
    // had no local capacity, or its sweep failed, the adopted cursor will be
    // unchanged next time. `sweepOwed` preserves that unconsumed work signal.
    let swept: SweepResult | undefined;
    const brakeDue = brakeSweepDueAt !== undefined && monotonicNow() >= brakeSweepDueAt;
    // Keep a due cooldown armed while total capacity is zero: the outer gate
    // must still defer hub work, but an unchanged wake needs to retry as soon
    // as a total slot exists. `sweep()` removes expired entries only when it
    // can actually make the targeted decision.
    const capacityCooldownDue = capacityCooldownDueAt !== undefined && monotonicNow() >= capacityCooldownDueAt;
    const capacityBecameReady = capacityCooldownReady(k, agentRoom);
    const wantSweep =
      wakeSucceeded && (changed || sweepOwed || brakeDue || capacityCooldownDue || capacityBecameReady) && k > 0;
    /*
     * Measured ONLY when a sweep would otherwise happen, so a parked or
     * saturated shift pays no syscall for a question it is not about to act on.
     * That placement is also what makes recovery automatic: refusing sets
     * `sweepOwed`, `sweepOwed` makes the next tick want to sweep, and wanting to
     * sweep re-measures the disk. No timer and no separate recovery path.
     */
    const disk = wantSweep ? diskSpace() : undefined;
    if (wantSweep && disk?.state === 'low') {
      /*
       * REFUSE NEW WORK, DO NOT STOP. Unlike the vanished temp directory that
       * `runHostPreflight` exits for, a full disk clears on its own, so the
       * shift stays up and keeps polling. In-flight children are deliberately
       * left running: killing one frees little and destroys all of its work.
       */
      sweepOwed = true;
      opts.out(
        `low disk: ${formatBytes(disk.freeBytes)} free at ${disk.path}, below the ${formatBytes(disk.floorBytes)} floor — ` +
          `deferring whats_next until space is free`,
      );
      // EDGE-TRIGGERED, exactly as the at-capacity record below: one per
      // low-disk EPISODE. The console line above stays level-triggered because
      // a live tail is watched by someone who wants to see it is still stuck.
      if (!lowDiskReported) {
        lowDiskReported = true;
        emit({ type: 'low-disk', path: disk.path, freeBytes: disk.freeBytes, floorBytes: disk.floorBytes });
      }
    } else if (wantSweep) {
      if (lowDiskReported) {
        lowDiskReported = false;
        opts.out('disk space recovered — resuming dispatch');
      }
      // Clear before awaiting: a new brake armed during sweep must survive.
      if (brakeDue) brakeSweepDueAt = undefined;
      swept = await sweep(k, live, reserved);
      // A COMPLETE sweep that handed work back for capacity is still unfinished
      // business. Without this the assignment below would clear the very signal
      // the release just raised, and the released order would wait for a cursor
      // change that a single-capability topology never produces.
      sweepOwed = !swept.complete || swept.releasedForCapacity;
    } else if (changed && k <= 0) {
      sweepOwed = true;
      opts.out(`at capacity (${occupied}/${cap} in flight) — deferring whats_next until capacity is free`);
      // EDGE-TRIGGERED: at most one record per at-capacity EPISODE, not per
      // tick. At MOST, because this branch needs `changed` — an episode during
      // which no wake reports a changed cursor produces no record at all. The
      // absence of one therefore says nothing about occupancy; `dispatched` and
      // `reaped` are the unconditional pair a reader should count.
      //
      // This branch runs on every changed wake for as long as the shift stays
      // full, which on a busy hub is every poll interval. The console line above
      // is a live tail an operator is watching, and repeating it is how it says
      // "still stuck" — so it stays level-triggered and unchanged. The event has
      // one durable consumer that repetition actively harms: `shift.log`, which
      // this change does not rotate. Entering the state is the fact worth
      // recording; staying in it is recoverable from the next record's `ts`.
      //
      // The record's ROUTING is decided elsewhere, and the two are separate
      // concerns. `runtime.ts` withholds `capacity` from the socket entirely
      // (`FILE_ONLY_EVENTS`) because a parked `shift next` must not be woken by
      // news that nothing happened. Edge-triggering keeps the FILE readable;
      // that set is what keeps the SOCKET correct. Neither substitutes for the
      // other — the loop emits, `consumeEvent` decides who hears it.
      if (!atCapReported) {
        atCapReported = true;
        emit({ type: 'capacity', inFlight: occupied, cap });
      }
    }

    const liveAfter = reconcile().live;

    // PHASE 4 — the work-directory reaper.
    //
    // ONLY ON A TICK THAT ACTUALLY SWEPT. The gate's first condition is "the hub
    // reports no open order for this run", and the only thing that can support
    // that claim is a fresh `whats_next` order list. A tick that skipped the
    // sweep (nothing changed, or no free capacity) has no such list, and running
    // the gate against a stale or empty one would read "no orders" as "no open
    // orders" and delete live work. Skipping costs nothing: the next sweeping
    // tick reaps whatever is still reapable.
    reapWorkDirs(swept, liveAfter);

    dispatched += swept?.dispatched ?? 0;
    return dispatched;
  }

  async function run(): Promise<number> {
    ensureStateDir(opts.stateDir);

    // BEFORE THE FIRST HUB CALL. A shift started into a broken host — the usual
    // way being a supervisor that restarts it across a reboot with the old
    // environment — must say so at once. Making it wait for three failed polls
    // would buy nothing and spend the operator's attention on network theories.
    // `streak: 0` marks this record as the boot check rather than a poll one.
    if (runHostPreflight(0)) return 1;

    if (opts.once === true) {
      await cycle();
      return wedged ? 1 : 0;
    }

    // The watchdog and heartbeat live OUTSIDE this loop (issue #300): they must
    // keep firing when `cycle()` never returns, which is the case they exist
    // for. Cleared on every exit path, including a throw out of `cycle()`.
    runStartedMono = monotonicNow();
    startTimers();
    try {
      for (;;) {
        if (stopped) return wedged ? 1 : 0;
        await cycle();
        if (stopped) return wedged ? 1 : 0;
        const delay = Math.max(opts.pollIntervalMs, backoffUntil - monotonicNow());
        await opts.sleep(delay);
        // Re-check after the park so a stop during sleep makes no further hub call.
        if (stopped) return wedged ? 1 : 0;
      }
    } finally {
      stopTimers();
    }
  }

  function stop(): void {
    stopped = true;
    stopTimers();
  }

  return {
    run,
    stop,
    iterate: cycle,
    freeCapacity: () => {
      const current = reconcile();
      return cap - current.live.length - current.reserved.length;
    },
    getCap: () => cap,
    agentCeiling: () => agentLane().ceiling,
    setCap: (next: number) => {
      cap = next;
    },
    getShift: () => ({ name: shiftName, serveCrews: [...serveCrews] }),
    getServeCapabilities: () => [...serveCapabilities],
    setShift: (next: { name?: string; serveCrews?: string[] }) => {
      if (next.name !== undefined) shiftName = next.name;
      if (next.serveCrews !== undefined) {
	serveCrews = [...next.serveCrews];
	refreshServeCapabilities();
      }
      lastPresence = Number.NEGATIVE_INFINITY; // D6: next iterate() pings immediately
      presenceGeneration++; // survive an in-flight ping completing after this
      return { name: shiftName, serveCrews: [...serveCrews] };
    },
    noteAttended: (at: number) => {
      attendedAt = at;
      lastPresence = Number.NEGATIVE_INFINITY;
      presenceGeneration++; // survive an in-flight ping completing after this
    },
    getAttendedAt: () => attendedAt,
    getCyclesCompleted: () => cyclesCompleted,
    getLastPollAt: () => lastPollAt,
    noteRunEnded: (run: string) => {
      pendingCandidates.delete(run);
      // A run that ENDED is a run that progressed — the shift's MCP `submit`
      // tool calls this only when the hub reports the submit closed the run.
      // That clears the step's failure streak outright, so one green run wipes
      // out an earlier storm's penalty instead of leaving it to decay.
      const brakeKey = runBrakeKey.get(run);
      if (brakeKey !== undefined) {
	runBrakeKey.delete(run);
	stepBrake.delete(brakeKey);
      }
	// The hub's closed-run report is authoritative but carries no record identity.
	removeRecordUnderDispatchLock(run);
    },
    noteChildExited: (exit: { workflow: string; run: string; kind: 'exec' | 'agent-run'; pid: number }) => {
      pendingCandidates.delete(exit.run);
      let removed = false;
      try {
	removed = removeRecordUnderDispatchLock(
	  exit.run,
	  { pid: exit.pid },
	  1_000,
	  'owenloop Shift exit reaper',
	);
      } catch (e) {
	const retry = e instanceof FileLockTimeoutError
	  ? ' (the pid reconciliation will retry)'
	  : '';
	opts.err(
	  `[${exit.workflow}/${exit.run}] failed to free the dispatch slot after the worker exited: ${errMsg(e)}${retry}`,
	);
	return;
      }
      if (!removed) return;
      emit({
	type: 'reaped',
	workflow: exit.workflow,
	run: exit.run,
	kind: exit.kind,
	pid: exit.pid,
      });
    },
    noteWorkerFailure: (failure: WorkerFailure) => {
      const brakeKey = runBrakeKey.get(failure.run);
      if (brakeKey === undefined) return; // not a run this shift still tracks
      runBrakeKey.delete(failure.run);
      releaseClaim(failure.workflow, failure.run, describeWorkerFailure(failure));
      chargeStepBrake(brakeKey);
    },
  };
}
