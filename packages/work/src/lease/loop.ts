/**
 * The lease-loop core — keeps ONE order's lease alive by heartbeating the hub
 * on a safe cadence, and performs a bounded final-breath release on shutdown.
 *
 * Extracted from C4's `hold` loop (C5, plan decision 4) so the two self-leasing
 * roles share ONE implementation of cadence/backoff/clock-jump/classification/
 * final-breath rather than duplicating it:
 *  - `hold` (`src/hold/loop.ts`) wraps this with `role: 'hold'` — its observable
 *    behavior (outcomes, exit codes, every emitted message string) is unchanged;
 *    the hold tests pass unedited.
 *  - `exec` (`src/exec/loop.ts`) wraps this with `role: 'exec'` and an `onOrder`
 *    callback so it can read the first-contact order packet and run the command
 *    while this loop keeps the lease warm underneath it.
 *
 * Like C3's shift loop, every side effect is injected (hub client, sleep/clock,
 * jitter, output sinks) so every test drives it with a fake hub, a scriptable
 * clock, and no real timers.
 *
 * LIFECYCLE
 *  - First contact: `get_order({workflow, run, holder})`. This beats the lease,
 *    closes the B2 pickup window, tags the holder, and validates the
 *    (workflow, run) pairing. On a claimed lease it fires `onOrder(res)` (so the
 *    caller can read the packet from the SAME response — no second fetch) and
 *    returns `holding`. `lease.claimed:false` with an `outcome` ⇒ the order
 *    already finished (`completed`); with no outcome ⇒ nothing to hold
 *    (`lease-lost`). A 403 ⇒ `ownership-error`; other throws retry under the
 *    backoff policy before giving up `hub-unreachable`.
 *  - Tick: abortable `sleep(heartbeatIntervalMs)` → clock-jump check (a wall gap
 *    beyond interval + tolerance, e.g. a laptop sleeping, triggers a `get_order`
 *    lease check BEFORE the next beat so we fail fast on a dead lease) →
 *    `heartbeat({workflow, run, holder})`.
 *  - Heartbeat failure: 403 ⇒ `ownership-error` immediately; any other error
 *    (the engine's lease-gone 500 included) is classified via `get_order`
 *    (`outcome` ⇒ `completed`, unclaimed ⇒ `lease-lost`, still claimed / classify
 *    failed ⇒ transient). Transient failures back off (exponential + jitter,
 *    base 1s ×2 cap 30s) without ever sleeping past the failure window; once
 *    consecutive failures span `failureWindowMs`, one last classify then
 *    `hub-unreachable`.
 *  - `stop(reason, {release?})` flips a flag checked between awaits AND aborts
 *    the in-flight interval sleep (final breath fires ~immediately, not up to a
 *    full interval late), then — unless the order already `completed` or the
 *    caller passed `release:false` — a targeted `release` bounded at
 *    RELEASE_CAP_MS. `release:false` is exec's "the run just closed via submit,
 *    don't release" path (a release then would be a confusing no-op). Release is
 *    idempotent hub-side (`not-held` is a no-op, never a throw), so a normal
 *    completion or a reaper race both land as `released`; a throw/timeout is
 *    `release-failed`.
 *
 * OUTCOME → the role maps each to an exit code in one place (see the roles).
 */
import { HubError, type ContactHolder, type GetOrderResponse } from '../hub/types.ts';
import type { HubClient } from '../hub/client.ts';

/** Discriminated result of a lease run; the role maps these to exit codes. */
export type LeaseOutcome =
  | 'completed' // the order finished elsewhere (observed via lease.outcome)
  | 'released' // final-breath handoff delivered (released, or already not-held)
  | 'release-failed' // the final-breath release threw or timed out
  | 'ownership-error' // 403 — the run is not ours to hold
  | 'lease-lost' // the claim is gone (unclaimed, no outcome) — nothing to hold
  | 'hub-unreachable' // transient failures spanned the failure window
  | 'stopped'; // stop() arrived before we ever established a hold (or with release:false)

/** Options handed to `stop()`. */
export interface StopOptions {
  /** Skip the final-breath release (default true = release). exec passes false
   *  after a successful submit — the run already closed, so releasing would be a
   *  confusing no-op in the logs. */
  release?: boolean;
}

export interface LeaseLoopOptions {
  hub: HubClient;
  workflow: string;
  run: string;
  /** Message prefix `owenloop work ${role}: …`. hold passes `'hold'`, exec `'exec'`. */
  role: string;
  /** `{kind, id}` when the holder identity is known; else omitted. */
  holder?: ContactHolder;
  /** Fired once on a successful first contact, with the same get_order response
   *  that established the hold — the caller reads the order packet from it. */
  onOrder?: (res: GetOrderResponse) => void;
  /** Injected sleep — tests pass a scriptable stub (no real timers). */
  sleep: (ms: number) => Promise<void>;
  /** Injected clock. */
  now: () => number;
  /** Jitter seam (default `Math.random`). */
  random?: () => number;
  /** stdout sink (one line per call; newline appended by the caller). */
  out: (line: string) => void;
  /** stderr sink. */
  err: (line: string) => void;
  /** Heartbeat cadence (default 60_000). */
  heartbeatIntervalMs?: number;
  /** Wall-gap slack before a tick is treated as a clock jump (default 30_000). */
  jumpToleranceMs?: number;
  /** Consecutive-failure give-up horizon (default 180_000). */
  failureWindowMs?: number;
}

export interface LeaseLoop {
  run(): Promise<LeaseOutcome>;
  stop(reason?: string, opts?: StopOptions): void;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_JUMP_TOLERANCE_MS = 30_000;
const DEFAULT_FAILURE_WINDOW_MS = 180_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const BACKOFF_JITTER = 0.2;
const RELEASE_CAP_MS = 5_000;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isForbidden(e: unknown): boolean {
  return e instanceof HubError && e.status === 403;
}

/** Classification of a get_order lease probe (first contact / jump / classify). */
type Probe = 'holding' | 'completed' | 'lease-lost' | 'transient';

export function createLeaseLoop(opts: LeaseLoopOptions): LeaseLoop {
  const interval = opts.heartbeatIntervalMs ?? DEFAULT_INTERVAL_MS;
  const jumpTolerance = opts.jumpToleranceMs ?? DEFAULT_JUMP_TOLERANCE_MS;
  const failureWindow = opts.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;
  const random = opts.random ?? Math.random;
  const { workflow, role } = opts;
  const runId = opts.run;
  const req = { workflow, run: runId, ...(opts.holder !== undefined ? { holder: opts.holder } : {}) };

  let stopped = false;
  let stopReason = '';
  let releaseOnStop = true;
  // A single stop promise, resolved once, so any in-flight (or later) abortable
  // sleep returns immediately after stop().
  let resolveStop!: () => void;
  const stopPromise = new Promise<void>((r) => {
    resolveStop = r;
  });

  // Shared consecutive-failure tracker (first contact + heartbeat both feed it).
  let firstFailureAt: number | undefined;
  let attempt = 0;

  function recordFailure(): void {
    if (firstFailureAt === undefined) firstFailureAt = opts.now();
    attempt++;
  }
  function resetFailures(): void {
    firstFailureAt = undefined;
    attempt = 0;
  }
  function failureWindowExceeded(): boolean {
    return firstFailureAt !== undefined && opts.now() - firstFailureAt >= failureWindow;
  }

  /** Sleep that resolves early when stop() fires. */
  async function abortableSleep(ms: number): Promise<void> {
    if (stopped) return;
    await Promise.race([opts.sleep(ms), stopPromise]);
  }

  /** Backoff delay for the current `attempt`, jittered and window-bounded. */
  function backoffDelay(): number {
    const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
    const jittered = raw * (1 + (random() * 2 - 1) * BACKOFF_JITTER);
    let delay = Math.max(0, Math.round(jittered));
    // Never sleep past the failure window — leave room for the final classify.
    if (firstFailureAt !== undefined) {
      const remaining = failureWindow - (opts.now() - firstFailureAt);
      if (remaining > 0) delay = Math.min(delay, remaining);
    }
    return delay;
  }

  /**
   * A get_order lease probe used for the clock-jump check and for classifying a
   * heartbeat failure. Any throw (including a 403, which on this path means the
   * hub is being flaky rather than a fresh ownership loss the beat already
   * surfaced) is reported as `transient` so the caller's backoff owns it.
   */
  async function probe(): Promise<Probe> {
    try {
      const res = await opts.hub.getOrder(req);
      if (res.lease.claimed) return 'holding';
      return res.lease.outcome !== undefined ? 'completed' : 'lease-lost';
    } catch {
      return 'transient';
    }
  }

  /**
   * Establish the hold. Returns `holding` once the lease is confirmed (after
   * firing `onOrder`), a terminal outcome, or `stopped` if stop() arrived before
   * we established it.
   */
  async function firstContact(): Promise<LeaseOutcome | 'holding'> {
    for (;;) {
      if (stopped) return 'stopped';
      try {
        const res = await opts.hub.getOrder(req);
        resetFailures();
        if (res.lease.claimed) {
          opts.onOrder?.(res);
          return 'holding';
        }
        return res.lease.outcome !== undefined ? 'completed' : 'lease-lost';
      } catch (e) {
        if (isForbidden(e)) {
          opts.err(`owenloop work ${role}: ${workflow}/${runId} is not yours to hold (forbidden)`);
          return 'ownership-error';
        }
        recordFailure();
        opts.err(`owenloop work ${role}: first contact failed: ${errMsg(e)} (retrying)`);
        if (failureWindowExceeded()) return 'hub-unreachable';
        await abortableSleep(backoffDelay());
      }
    }
  }

  /** One heartbeat tick. Returns a terminal outcome, or `undefined` to continue. */
  async function tick(): Promise<LeaseOutcome | undefined> {
    const before = opts.now();
    await abortableSleep(interval);
    if (stopped) return undefined; // final breath handled by the caller

    // Clock-jump guard: a wall gap well beyond the interval (laptop sleep) means
    // the lease may have lapsed while we were suspended — check before beating.
    const gap = opts.now() - before;
    if (gap > interval + jumpTolerance) {
      opts.err(`owenloop work ${role}: clock jump detected (${gap}ms gap) — verifying lease before beat`);
      const p = await probe();
      if (p === 'completed') return 'completed';
      if (p === 'lease-lost') return 'lease-lost';
      // 'holding' → carry on and beat; 'transient' → fall through, the beat's
      // own failure handling will pick up the unreachable hub.
    }

    try {
      await opts.hub.heartbeat(req);
      resetFailures();
      return undefined;
    } catch (e) {
      if (isForbidden(e)) {
        opts.err(`owenloop work ${role}: heartbeat forbidden — the claim is no longer yours`);
        return 'ownership-error';
      }
      // Classify the failure: did the order finish, or was the lease lost?
      const p = await probe();
      if (p === 'completed') return 'completed';
      if (p === 'lease-lost') return 'lease-lost';
      // Transient (still claimed, or the classify call itself failed): back off.
      recordFailure();
      opts.err(`owenloop work ${role}: heartbeat failed: ${errMsg(e)} (attempt ${attempt}, backing off)`);
      if (failureWindowExceeded()) {
        const last = await probe();
        if (last === 'completed') return 'completed';
        if (last === 'lease-lost') return 'lease-lost';
        opts.err(`owenloop work ${role}: hub unreachable for ${failureWindow}ms — giving up`);
        return 'hub-unreachable';
      }
      await abortableSleep(backoffDelay());
      return undefined;
    }
  }

  /**
   * The final breath: a targeted release, bounded at RELEASE_CAP_MS. Skipped
   * when the order already completed (a completed order has no claim to hand
   * back) or when stop() asked for `release:false`. Idempotent hub-side, so
   * `not-held` is success.
   */
  async function finalBreath(alreadyCompleted: boolean): Promise<LeaseOutcome> {
    if (alreadyCompleted) return 'completed';
    if (!releaseOnStop) return 'stopped';
    opts.out(`owenloop work ${role}: final breath (${stopReason || 'stop'}) — releasing ${workflow}/${runId}`);
    try {
      const raced = await Promise.race([
        opts.hub.release({ workflow, run: runId }).then(() => 'ok' as const),
        opts.sleep(RELEASE_CAP_MS).then(() => 'timeout' as const),
      ]);
      if (raced === 'timeout') {
        opts.err(`owenloop work ${role}: release timed out after ${RELEASE_CAP_MS}ms — order strands until its lease TTL`);
        return 'release-failed';
      }
      opts.out(`owenloop work ${role}: released ${workflow}/${runId} — the order re-offers on the next tick`);
      return 'released';
    } catch (e) {
      opts.err(`owenloop work ${role}: release failed: ${errMsg(e)} — order strands until its lease TTL`);
      return 'release-failed';
    }
  }

  async function run(): Promise<LeaseOutcome> {
    const fc = await firstContact();
    if (fc === 'stopped') return 'stopped';
    if (fc !== 'holding') return fc;
    opts.out(
      `owenloop work ${role}: holding ${workflow}/${runId}` +
        (opts.holder !== undefined ? ` as ${opts.holder.kind} ${opts.holder.id}` : '') +
        ` (heartbeat every ${interval}ms)`,
    );

    for (;;) {
      if (stopped) break;
      const outcome = await tick();
      if (outcome === 'completed') return 'completed';
      if (outcome !== undefined) return outcome;
      if (stopped) break;
    }

    // Stopped while holding → hand off.
    return finalBreath(false);
  }

  function stop(reason?: string, stopOpts?: StopOptions): void {
    if (stopped) return;
    stopped = true;
    stopReason = reason ?? '';
    if (stopOpts?.release === false) releaseOnStop = false;
    resolveStop();
  }

  return { run, stop };
}
