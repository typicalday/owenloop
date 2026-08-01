/**
 * The `hold` loop (C4) — keeps one order's lease alive on behalf of an
 * interactive session, and performs the final-breath handoff on shutdown.
 *
 * The cadence/backoff/clock-jump/final-breath CORE moved to `src/lease/loop.ts`
 * in C5 (plan decision 4) so `hold` and the self-leasing `exec` share ONE
 * implementation. This module is now a thin adapter: it fixes the role prefix to
 * `'hold'` (so every emitted message string is byte-identical to C4) and
 * re-exports the loop's public surface under the hold names its callers and
 * tests already import. `hold` never reads the order packet, so it omits
 * `onOrder`; its `stop(reason?)` always releases (the session died — hand the
 * order back).
 *
 * See `src/lease/loop.ts` for the full lifecycle documentation.
 */
import { createLeaseLoop, type LeaseLoopOptions, type LeaseOutcome, type LeaseLoop, type StopOptions } from '../lease/loop.ts';

/** The hold run's outcome — the lease outcome under the hold name. */
export type HoldOutcome = LeaseOutcome;

/**
 * hold's options are the lease options minus the one internal it fixes (`role`).
 * `onOrder` stays available: the CLI `hold` never wires it (it doesn't read the
 * packet), but the D2 `hold --mcp` mount does — its `get_order` tool returns the
 * order packet the loop's first contact already fetched.
 */
export type HoldLoopOptions = Omit<LeaseLoopOptions, 'role'>;

export interface HoldLoop {
  run(): Promise<HoldOutcome>;
  /**
   * Stop the loop. `stopOpts.release:false` skips the final-breath release — the
   * `hold --mcp` submit tool passes it once a submit CLOSES the run (the claim is
   * already gone, so releasing would be a confusing no-op). The CLI hold's signal
   * path passes no opts, so it still releases (the session died — hand it back).
   */
  stop(reason?: string, stopOpts?: StopOptions): void;
}

export function createHoldLoop(opts: HoldLoopOptions): HoldLoop {
  const loop: LeaseLoop = createLeaseLoop({ ...opts, role: 'hold' });
  return {
    run: () => loop.run(),
    stop: (reason?: string, stopOpts?: StopOptions) => loop.stop(reason, stopOpts),
  };
}
