/**
 * The self-driven shift loop core (D2 dispatch split).
 *
 * `createShiftLoop` is a standing Shift loop with every side-effecting
 * dependency injected (hub client, spawner, sleep/clock, output streams, dirs),
 * so the same core can run behind the local shift daemon. Per iteration it: pings
 * presence when due → cheap `wake(cursor)` pre-check → only when something
 * changed AND there is free capacity, sweeps `whats_next`, classifies/meters
 * orders, and DISPATCHES BY KIND → reaps work dirs → adopts the cursor → sleeps
 * the poll interval.
 *
 * DISPATCH SPLIT (D2 decision 3 — the D12 routing contract). BOTH kinds spawn a
 * detached child; there is exactly ONE way each kind runs, and no flag selects
 * between paths:
 *  - COMMAND orders spawn a detached `owenloop work exec <wf>/<run> --origin <url>`
 *    child that self-leases (unchanged from C3).
 *  - AGENT orders spawn a detached `owenloop work agent-run <wf>/<run>` child that
 *    hosts the step agent itself through a harness adapter. It reads the step's
 *    normalized spec straight out of the bundle cache and renders the brief in
 *    process.
 *  - The shift makes NO first-contact `get_order` for any kind. It holds no
 *    leases; the spawned child makes first contact and closes the B2 pickup
 *    window. A failed hand-off lapses back via that window instead of sitting
 *    claimed.
 *
 * METERING (decision 3): free capacity `k = cap − liveInFlight`, where
 * liveInFlight counts every live child record, each one pid-probed (see
 * state.ts). When `k <= 0` the loop skips `whats_next` ENTIRELY (keeps wake +
 * presence). Metering is efficiency-only (engine race-safety + the hub's
 * pickup/lease TTLs are the correctness backstop), so this approximation is
 * acceptable.
 *
 * RESILIENCE: presence/wake/whats_next failures are logged and never kill the
 * loop. `stop()` flips a flag checked between awaits; the in-flight sweep
 * finishes, `run()` resolves 0, and no hub call is made afterward. Detached
 * children are never killed on shutdown — that is the drain semantic.
 *
 * PINNED-HASH DISPATCH (E, DD-4): `whats_next` serves only a def NAME (no hash,
 * no parent linkage), so the sweep resolves which cached bundle to serve via
 * `readDispatchBundle(cacheDir, defName)` instead of a bare latest read: 0 pins
 * → latest (unchanged); exactly 1 pinned hash → that frozen version (even when a
 * newer unpinned hash is cached); >1 conflicting pins across different cached
 * parents → refuse (no bundle + a warning), leave orders for the pickup window.
 * Everything downstream keys records by `bundle.def.hash`, so a pinned bundle
 * flows through `ChildRecord.hash` untouched.
 *
 * LIVE SHIFT IDENTITY: `name`/`serveCrews` on `ShiftLoopOptions` are INITIAL
 * values only. The loop holds them as live closure state (`getShift`/`setShift`
 * on `ShiftLoop`) so the shift socket's `clock_in` operation can change what a
 * shift is called and which crews it serves without rebuilding the loop —
 * `setShift` also resets the presence timer so the new identity reaches the hub
 * on the very next `iterate()`.
 */
import { readDispatchBundle } from '../bundle/cache.ts';
import type { HubClient } from '../hub/client.ts';
import type { WorkOrder } from '../hub/types.ts';
import type { FetchedStep } from '../bundle/types.ts';
import { isCommandStep, resolveCommandRouting } from './routing.ts';
import {
  reconcileInFlight,
  writeChildRecord,
  removeChildRecord,
  ensureStateDir,
  type ChildRecord,
  type Liveness,
} from './state.ts';
import { DEFAULT_WORK_DIR_TTL_MS, sweepWorkDirs as sweepWorkDirsImpl } from '../agent/workdir.ts';
import { sessionsPath } from '../harness/session-store.ts';
import type { Spawner } from './spawn.ts';
import type { ShiftEvent } from './protocol.ts';

export interface ShiftLoopOptions {
  hub: HubClient;
  spawner: Spawner;
  /** Injected sleep — tests pass an instant/scriptable stub (no real timers). */
  sleep: (ms: number) => Promise<void>;
  /** Injected clock. */
  now: () => number;
  /** stdout sink (one line per call; newline appended). */
  out: (line: string) => void;
  /** stderr sink (one line per call; newline appended). */
  err: (line: string) => void;
  /** Local dispatch/reap observations consumed by the shift socket wrapper. */
  onEvent?: (event: ShiftEvent) => void;
  cacheDir: string;
  stateDir: string;
  /** Max concurrent in-flight orders (exec + agent-run children). */
  cap: number;
  /** Serve crews this shift accepts (sent to presence + whats_next). INITIAL
   *  value only — live-mutable via the `ShiftLoop.setShift` (MCP `clock_in`). */
  serveCrews: string[];
  /** Shift name for presence. INITIAL value only — live-mutable via
   *  `ShiftLoop.setShift` (MCP `clock_in`). */
  name: string;
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
  pollIntervalMs: number;
  presenceIntervalMs: number;
  /**
   * Max concurrent `agent-run` children (default 4). A SECOND budget, applied
   * ON TOP OF `cap` — never a replacement for it. An agent turn is long and
   * memory-heavy where a command is short, so the two cannot share one number.
   */
  maxConcurrentAgents?: number;
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
  /** PHASE 4 — injected in tests so the reaper can be exercised without a
   *  filesystem. Defaults to `sweepWorkDirs` from `src/agent/workdir.ts`. */
  sweepWorkDirs?: typeof sweepWorkDirsImpl;
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
}

export interface ShiftLoop {
  run(): Promise<number>;
  stop(): void;
  /**
   * Run exactly one park iteration (presence → wake → sweep-if-changed →
   * dispatch → reap) and return how many children it spawned. The shift daemon
   * uses this seam for its loop core; the standing `run()` loop ignores the
   * count. Cursor/presence state is held in the closure and persists across calls.
   */
  iterate(): Promise<number>;
  /** Free capacity right now (cap − live in-flight). ≤ 0 ⇒ at capacity. */
  freeCapacity(): number;
  /** Live dispatch-cap used by status and next responses. */
  getCap(): number;
  /** Adjust the live dispatch cap for internal callers and tests. */
  setCap(cap: number): void;
  /** The shift's live identity: the presence name and the crew scope (`serve_crews`)
   *  the next ping and the next sweep will carry. Empty `serveCrews` means ALL of
   *  this identity's crews, never none. */
  getShift(): { name: string; serveCrews: string[] };
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
   * reconcile to notice the child exited. The shift's MCP `submit` tool calls
   * an internal caller may use this when the hub reports a submit CLOSED the
   * run — the one in-process end-of-run signal the shift sees. A run whose closing submit went through
   * the child's own mount instead is not a problem: that child exits, and the
   * next reconcile's pid probe frees the slot anyway.
   */
  noteRunEnded(run: string): void;
}

/** A dispatch candidate carried through classify → spawn. */
interface Candidate {
  order: WorkOrder;
  workflow: string;
  step: FetchedStep | undefined;
  defName: string | undefined;
  defHash: string | undefined;
  kind: 'agent' | 'command';
  /** True when this run already had a live record (handout lapsed → re-offer). */
  reoffer: boolean;
}

/** The `maxConcurrentAgents` fallback when the option is absent. */
const DEFAULT_MAX_AGENTS = 4;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createShiftLoop(opts: ShiftLoopOptions): ShiftLoop {
  let stopped = false;
  let cap = opts.cap;
  const isAlive = opts.isAlive;
  // Live shift identity (MCP `clock_in`, D3-D7 of the plan). Seeded from opts,
  // which are now INITIAL values only. Arrays are copied so neither the loop
  // nor a caller of getShift/setShift can mutate the other's state afterward.
  let shiftName = opts.name;
  let serveCrews = [...opts.serveCrews];

  // Park state persists across `iterate()` calls (the MCP park reuses it).
  let cursor: number | undefined;
  let lastPresence = Number.NEGATIVE_INFINITY;
  let attendedAt: number | undefined;

  function emit(event: ShiftEvent): void {
    if (opts.onEvent === undefined) return;
    try {
      opts.onEvent(event);
    } catch (e) {
      opts.err(`shift event sink failed: ${errMsg(e)} (continuing)`);
    }
  }

  function reconcile() {
    // No clock is passed: reconciliation is purely pid-probed, so there is no
    // time-dependent decision for `opts.now` to influence.
    const result = reconcileInFlight(opts.stateDir, { ...(isAlive !== undefined ? { isAlive } : {}) });
    for (const rec of result.reaped) {
      emit({
        type: 'reaped',
        workflow: rec.workflow,
        run: rec.run,
        kind: rec.kind ?? 'exec',
        pid: rec.pid,
      });
    }
    return result;
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
  ): Promise<SweepResult> {
    let dispatched = 0;
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
    let remaining = budget;
    const liveRuns = new Set(live.map((r) => r.run));

    // The agent lane's SECOND budget (D7). Counted from the live records, so an
    // agent-run child that died frees its slot on the next reconcile exactly like
    // an exec child does.
    const maxAgents = opts.maxConcurrentAgents ?? DEFAULT_MAX_AGENTS;
    let agentRoom = maxAgents - live.filter((r) => r.kind === 'agent-run').length;
    /**
     * Runs that ALREADY have a live `agent-run` child. An agent-run child is a
     * PROCESS: re-dispatching one would put a second harness session on a single
     * claim — two step agents briefed for the same order, racing to submit. So a
     * re-offer for a run a worker already holds is skipped outright, the way the
     * command lane does it.
     */
    const workerRuns = new Set(live.filter((r) => r.kind === 'agent-run').map((r) => r.run));

    // Resolve which instances to poll.
    let instances: string[];
    if (opts.workflow !== undefined) {
      instances = [opts.workflow];
    } else {
      try {
        const inbox = await opts.hub.whatsNext();
        instances = (inbox.instances ?? []).map((i) => i.workflow);
      } catch (e) {
        opts.err(`inbox whats_next failed: ${errMsg(e)}`);
        return { dispatched, polled, openRuns };
      }
    }

    // Collect candidates, metering NEW dispatches and deduping in-flight.
    const claimed = new Set<string>();
    const candidates: Candidate[] = [];
    for (const wf of instances) {
      let res;
      try {
        res = await opts.hub.whatsNext({ workflow: wf, serve_crews: serveCrews });
      } catch (e) {
        opts.err(`whats_next for ${wf} failed: ${errMsg(e)}`);
        continue;
      }
      const orders = res.orders ?? [];
      polled.add(wf);
      for (const o of orders) openRuns.add(o.run);
      const defName = res.def;
      // Dispatch selection (DD-4): honor a UNIQUE pinned hash for this def name;
      // 0 pins → latest (unchanged); conflicting pins → refuse (null + warning).
      const dispatch = defName !== undefined ? readDispatchBundle(opts.cacheDir, defName) : { bundle: null };
      const bundle = dispatch.bundle;
      if (orders.length > 0 && dispatch.warning !== undefined) {
        opts.err(`[${wf}] ${dispatch.warning}`);
      } else if (orders.length > 0 && bundle === null && defName !== undefined) {
        opts.err(`no cached bundle for def '${defName}' — run \`owenloop work prepare ${defName}\` (agent orders left for pickup)`);
      }
      for (const order of orders) {
        if (claimed.has(order.run)) continue; // seen this sweep
        const step = bundle?.def.steps.find((s) => s.name === order.step);
        const isCmd = step !== undefined && isCommandStep(step);
        const reoffer = liveRuns.has(order.run);

        if (isCmd) {
          // A command already in flight (its exec child lives) is never respawned.
          if (reoffer) continue;
          const r = resolveCommandRouting(opts.commandRouting, step);
          for (const w of r.warnings) opts.err(`[${wf}/${order.run}] ${w}`);
          if (!r.autoDispatch) {
            opts.out(`[${wf}/${order.run}] command step '${order.step}' routed to Shift — leaving for pickup window`);
            continue;
          }
          if (remaining <= 0) continue; // out of free capacity for new work
          remaining--;
          candidates.push({ order, workflow: wf, step, defName, defHash: bundle?.def.hash, kind: 'command', reoffer });
          claimed.add(order.run);
          continue;
        }

        // Agent order. An order a live worker already holds is never re-dispatched
        // (see `workerRuns`) — that would double-brief one claim.
        if (workerRuns.has(order.run)) continue;

        // No resolved bundle ⇒ no dispatch. Two distinct causes, one outcome:
        //   - nothing cached for this def name (the operator never ran
        //     `owenloop work prepare`), so there is no def+hash for the `agent-run`
        //     child to read `steps/<step>.json` from; and
        //   - conflicting pins across cached parents (DD-4), where refusing is
        //     the point — spawning a child that picks its own bundle would make
        //     the very version guess DD-4 forbids.
        // Either way the order is LEFT for the hub's pickup window. The one
        // warning per sweep was already written above.
        if (bundle === null) continue;

        // A re-offer replaces its (stale) record without consuming a new slot;
        // a genuinely new agent order needs free capacity.
        if (!reoffer) {
          if (remaining <= 0) continue;
          // The agent budget applies IN ADDITION to the global one. Skipped
          // candidates are simply left alone — the hub re-offers them on a later
          // sweep once a worker child exits.
          if (agentRoom <= 0) {
            opts.out(`[${wf}/${order.run}] at the agent-run cap (${maxAgents}) — leaving for a later sweep`);
            continue;
          }
          remaining--;
          agentRoom--;
        }
        candidates.push({ order, workflow: wf, step, defName, defHash: bundle?.def.hash, kind: 'agent', reoffer });
        claimed.add(order.run);
      }
    }

    if (candidates.length === 0) return { dispatched, polled, openRuns };

    // Dispatch by kind.
    for (const c of candidates) {
      if (c.kind === 'command') {
        try {
          const { pid } = opts.spawner({ workflow: c.workflow, run: c.order.run });
          const rec: ChildRecord = { workflow: c.workflow, run: c.order.run, pid, spawnedAt: opts.now(), kind: 'exec' };
          writeChildRecord(opts.stateDir, rec);
          dispatched++;
          emit({
            type: 'dispatched',
            workflow: c.workflow,
            run: c.order.run,
            step: c.order.step,
            kind: 'exec',
            pid,
          });
          opts.out(`dispatched command ${c.workflow}/${c.order.run} (step '${c.order.step}', pid ${pid})`);
        } catch (e) {
          const message = errMsg(e);
          emit({
            type: 'failed',
            workflow: c.workflow,
            run: c.order.run,
            step: c.order.step,
            kind: 'exec',
            message,
          });
          opts.err(`spawn for ${c.workflow}/${c.order.run} failed: ${message}`);
        }
        continue;
      }
      // Agent: spawn a detached `agent-run` child that hosts the step agent.
      // This is the ONLY agent path — no flag, no alternative.
      try {
        const { pid } = opts.spawner({
          workflow: c.workflow,
          run: c.order.run,
          kind: 'agent-run',
          ...(c.step?.harness !== undefined && c.step.harness !== '' ? { harness: c.step.harness } : {}),
        });
        const rec: ChildRecord = {
          workflow: c.workflow,
          run: c.order.run,
          pid,
          spawnedAt: opts.now(),
          kind: 'agent-run',
          ...(c.defName !== undefined ? { def: c.defName } : {}),
          ...(c.defHash !== undefined ? { hash: c.defHash } : {}),
          step: c.order.step,
        };
        writeChildRecord(opts.stateDir, rec);
        dispatched++;
        emit({
          type: 'dispatched',
          workflow: c.workflow,
          run: c.order.run,
          step: c.order.step,
          kind: 'agent-run',
          pid,
        });
        opts.out(`dispatched agent-run ${c.workflow}/${c.order.run} (step '${c.order.step}', pid ${pid})`);
      } catch (e) {
        const message = errMsg(e);
        emit({
          type: 'failed',
          workflow: c.workflow,
          run: c.order.run,
          step: c.order.step,
          kind: 'agent-run',
          message,
        });
        opts.err(`agent-run spawn for ${c.workflow}/${c.order.run} failed: ${message}`);
      }
    }

    return { dispatched, polled, openRuns };
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
    // Presence when due (starts immediately — this shift exists to conduct).
    if (opts.now() - lastPresence >= opts.presenceIntervalMs) {
      try {
        await opts.hub.presencePing({
          name: shiftName,
          serve_crews: serveCrews,
          ...(opts.shiftId !== undefined ? { shift_id: opts.shiftId } : {}),
          ...(opts.startedAt !== undefined ? { started_at: opts.startedAt } : {}),
          ...(attendedAt !== undefined ? { attended_at: attendedAt } : {}),
        });
        lastPresence = opts.now();
      } catch (e) {
        opts.err(`presence ping failed: ${errMsg(e)} (continuing)`);
      }
    }

    // Reconcile in-flight (startup recovery + per-sweep reap).
    const { live } = reconcile();
    const k = cap - live.length;

    // Cheap wake pre-check. On failure, stay put this tick (don't sweep).
    let changed = false;
    try {
      const w = await opts.hub.wake(cursor);
      changed = w.changed;
      cursor = w.cursor;
    } catch (e) {
      opts.err(`wake failed: ${errMsg(e)} (retrying next tick)`);
    }

    // Sweep only when something changed AND there is free capacity.
    let swept: SweepResult | undefined;
    if (changed && k > 0) {
      swept = await sweep(k, live);
    } else if (changed) {
      opts.out(`at capacity (${live.length}/${cap} in flight) — skipping whats_next this tick`);
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

    return swept?.dispatched ?? 0;
  }

  async function run(): Promise<number> {
    ensureStateDir(opts.stateDir);

    if (opts.once === true) {
      await iteration();
      return 0;
    }

    for (;;) {
      if (stopped) return 0;
      await iteration();
      if (stopped) return 0;
      await opts.sleep(opts.pollIntervalMs);
      // Re-check after the park so a stop during sleep makes no further hub call.
      if (stopped) return 0;
    }
  }

  function stop(): void {
    stopped = true;
  }

  return {
    run,
    stop,
    iterate: iteration,
    freeCapacity: () => cap - reconcile().live.length,
    getCap: () => cap,
    setCap: (next: number) => {
      cap = next;
    },
    getShift: () => ({ name: shiftName, serveCrews: [...serveCrews] }),
    setShift: (next: { name?: string; serveCrews?: string[] }) => {
      if (next.name !== undefined) shiftName = next.name;
      if (next.serveCrews !== undefined) serveCrews = [...next.serveCrews];
      lastPresence = Number.NEGATIVE_INFINITY; // D6: next iterate() pings immediately
      return { name: shiftName, serveCrews: [...serveCrews] };
    },
    noteAttended: (at: number) => {
      attendedAt = at;
      lastPresence = Number.NEGATIVE_INFINITY;
    },
    getAttendedAt: () => attendedAt,
    noteRunEnded: (run: string) => {
      removeChildRecord(opts.stateDir, run);
    },
  };
}
