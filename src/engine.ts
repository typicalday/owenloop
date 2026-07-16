/**
 * The engine — the stateful layer that turns model decisions (model.ts) into
 * writes, under the store's `BEGIN IMMEDIATE` transactions.
 *
 * Invariant upheld here: **every mutation ends with `settle()`** — materialize
 * any newly-owed outputs and run the level-triggered cascade (§11.8/§12.3) to a
 * fixpoint. So the store always reflects the maintained state, and `status` is a
 * pure read. The commit-time CAS (§12.2) compares each run's claim fingerprint
 * (snapshotted on the run) against current input versions; a moved input
 * born-rejects the output instead of greening it.
 */

import {
  elementPath,
  parseElement,
  sealPath,
} from './paths.ts';
import {
  collectionStem,
  computeFingerprint,
  eligibleFirings,
  fingerprintMatches,
  groupBlockingWinner,
  isGreen,
  judgeNameOf,
  maintainDecisions,
  pendingOwed,
  plainConsumes,
  requiredInputs,
  workflowStatus,
} from './model.ts';
import type { ArtifactMap, CascadeOp, ChildStatusSummary, Firing, TimeFacts, WorkflowStatus } from './model.ts';
import { summarizeIssues, validateValue } from './schema.ts';
import type { SchemaIssue } from './schema.ts';
import { hashDef } from './defs.ts';
import { localMidnightMs, nowMs, randId } from './util.ts';
import type { Store, WorkflowRow } from './store.ts';
import type {
  ArtifactData,
  Author,
  JsonSchema,
  Order,
  StepDef,
  ReasonEntry,
  RejectKind,
  ReasonAction,
  WorkflowDef,
} from './types.ts';

export type { Order } from './types.ts';

const DEFAULT_REAP_TTL_MS = 2 * 60 * 60 * 1000; // 2h
/**
 * REL-4: hard cap on `calls:` composition depth (root instance = depth 0), a
 * defense-in-depth bound independent of construction-time cycle validation.
 * Generous — real compositions in this repo are depth 2–3; the bound only trips
 * on a pathological chain (typically a `calls:` cycle that bypassed load-time
 * validation via a hand-wired `Engine` + custom `DefResolver`). See
 * `maintainCalls` (spawn-time refusal) and `tickInternal` (descent guard).
 */
const DEFAULT_MAX_CALL_DEPTH = 64;

/**
 * F2: a typed refusal for a produced-value/input-value schema mismatch, thrown
 * by `createInstance` (seed provide) and `provideInput`. Distinct from a bare
 * `Error` so callers that need to distinguish "this value doesn't fit the
 * schema" from a genuine bug (e.g. `maintainCalls`'s STEP 3/STEP 5, which must
 * turn a CHILD's schema refusal into a debt on the parent rather than crash
 * the parent's tick) can catch narrowly instead of blanket-catching.
 */
export class SchemaRefusalError extends Error {
  readonly inputName: string;
  readonly issues: SchemaIssue[];

  constructor(inputName: string, issues: SchemaIssue[]) {
    super(`input '${inputName}' failed schema: ${summarizeIssues(issues)}`);
    this.name = 'SchemaRefusalError';
    this.inputName = inputName;
    this.issues = issues;
  }
}

/**
 * §tick-deferred: an eligible firing the tick did NOT promote to an order, tagged
 * with why. `'in-flight'` — the step's task is already claimed by an open run;
 * `'cadence'` — the step's inter-run gap has not elapsed; `'daily-budget'` — the
 * step's daily run allowance is exhausted (binding over parallel); `'parallel-cap'`
 * — the step's concurrency cap is the binding constraint. Always emitted by
 * `applySchedule` or `tick`; never alters which firings are selected or claimed.
 * `'label-mismatch'` (A2) — the tick caller passed a label filter that does not
 * intersect the step's declared labels, so a peer orchestrator serving other
 * labels leaves it for the matching caller.
 */
export type DeferredReason = 'in-flight' | 'cadence' | 'daily-budget' | 'parallel-cap' | 'label-mismatch';

export interface DeferredFiring {
  step: string;
  key: string;
  index?: number;
  inputs: string[];
  outputs: string[];
  reason: DeferredReason;
  /**
   * §23.6.8 deep tick: which instance this deferred firing belongs to.
   * Convention — **absent = the ticked ROOT instance; present = the named
   * descendant.** A deep `tick(root)` folds each live `calls:` child's own
   * `TickResult` up: a child-originated entry is stamped with the child's
   * workflow id (a grandchild's already-stamped id is preserved), while the
   * root frame's own deferrals stay unstamped. Lets a driver tell whose
   * `in-flight`/`cadence`/… deferral it is reading without ambiguity.
   */
  workflow?: string;
}

/**
 * The result of a `tick`. §23.6.8: a deep `tick(root)` (the default) descends
 * into every live `calls:` child and folds the whole subtree's work into this
 * one result — `orders` are flattened (each `Order` carries its own
 * `workflow`, so a driver dispatches/commits by `order.workflow`), `reaped` is
 * summed across the tree, `dueAt` is the min across the tree, and `deferred`
 * entries are stamped with their originating instance (absent = this root; see
 * `DeferredFiring.workflow`). `workflow` below always stays the ROOT (ticked)
 * id — child results are folded, never returned as the root. `tick(wf,
 * { deep: false })` (CLI `--shallow`) restores the pre-deep behavior: only this
 * instance's own orders/reaps/deferrals.
 */
export interface TickResult {
  workflow: string;
  orders: Order[];
  reaped: number;
  deferred: DeferredFiring[];
  /**
   * The earliest pending time-trigger (ms epoch) among idle evaluators, if any.
   * Absent when the workflow has no idle steps. An external scheduler uses this
   * to decide when to next wake the instance.
   */
  dueAt?: number;
}

/**
 * §28: `status()`'s return shape — the pure `WorkflowStatus` plus an
 * engine-level enrichment that needs both the pinned snapshot (from the
 * store row) and the currently-loaded live def (from the resolver), which is
 * why it lives here rather than in the pure `model.ts`.
 */
export interface EngineWorkflowStatus extends WorkflowStatus {
  /** §28: true when the def currently loaded for this workflow's name differs
   *  (by content hash) from the snapshot this instance is pinned to. Present
   *  (true/false) whenever the instance has a pinned snapshot; absent for a
   *  legacy un-pinned instance (nothing to compare) or when the live def
   *  can't currently be resolved at all (can't determine drift, not "no
   *  drift"). Informational — the engine keeps operating from the pinned
   *  snapshot regardless; clear the drift by running `owenloop adopt <wf>`. */
  defDrift?: boolean;
}

export interface CommitResult {
  path: string;
  outcome:
    | 'green' | 'born-rejected' | 'schema-rejected'
    // §24: a producer's `green()` call against a produce with `judges:`
    // declared lands `submitted`, not `green` — the value is committed and the
    // version bumped, but the artifact awaits sign-off (§4.4).
    | 'submitted'
    // §24: a judge-step actor's `green()` call against a `submitted` stem
    // records its ledger slot but doesn't necessarily flip the artifact green
    // yet (other judges may still be pending) — 'approved' distinguishes that
    // from 'green' (every declared judge has now signed the current version).
    | 'approved'
    // §26: refused because this commit would violate its produce-group's
    // exactlyOne/atMostOne exclusivity contract — a sibling already won. Like
    // schema-rejected, the value is NOT committed, no counters are bumped, and
    // the run/lease is left open for the caller to close as it sees fit.
    | 'group-rejected';
  reason?: string;
  /** the schema violations, when `outcome` is `schema-rejected` (§18) */
  issues?: SchemaIssue[];
}

/** The outcome of an `emit` (collection accretion) — possibly schema-refused. */
export interface EmitResult {
  outcome: 'emitted' | 'born-rejected' | 'schema-rejected' | 'sealed-rejected';
  /** the element paths created (empty unless `emitted`) */
  created: string[];
  reason?: string;
  issues?: SchemaIssue[];
}

export interface CreateOpts {
  title?: string;
  params?: Record<string, string>;
  /** values for inputs provided at start (keyed by input name) */
  provide?: Record<string, Record<string, unknown>>;
  /** Mode 2: parent-coordinate link for a child instance spawned by a calls: step. Persisted to store; used only to cascade the child's outcome back up. */
  producedBy?: { parentWf: string; parentPath: string };
}

export type DefResolver = (defName: string) => WorkflowDef;

/**
 * A push notification of a committed engine change, delivered to observers
 * registered via {@link Engine.subscribe}. Lets an in-process host react the
 * instant the graph advances instead of polling `tick`/`status`.
 *
 * - `instance`  — a new workflow was created (and its inputs seeded).
 * - `commit`    — a state-changing verb landed on `path` (`outcome` is present
 *                 for the producer verbs green/emit/seal, including a refusal).
 * - `closed`    — a run's lease was released.
 * - `settled`   — the derived view AFTER the cascade: a host re-`tick`s only
 *                 when `eligible` is non-empty, and learns completion via `done`.
 *   A state-changing verb fires its specific event followed by a `settled`.
 */
export type EngineEvent =
  | { type: 'instance'; workflow: string; def: string }
  | {
      type: 'commit';
      workflow: string;
      run?: string;
      path: string;
      action: 'green' | 'emit' | 'seal' | 'reject' | 'retract' | 'skip' | 'retry' | 'provide';
      outcome?: CommitResult['outcome'] | EmitResult['outcome'];
    }
  | { type: 'closed'; workflow: string; run: string; outcome: 'ok' | 'no_work' | 'failed' | 'skipped' }
  | { type: 'settled'; workflow: string; done: boolean; eligible: string[] };

/** A synchronous observer of {@link EngineEvent}s. */
export type EngineListener = (event: EngineEvent) => void;

/**
 * Why the reaper cleared a stranded lease, surfaced per entry in
 * {@link Engine.reapWithDetails} `details` (and printed by the CLI `reap`
 * command). Distinguishes the liveness failures from the bookkeeping ones:
 * - `heartbeat-lost` — no beat within the effective reap TTL (the anchor rule
 *   `max(claimedAt, heartbeatAt) + ttl` lapsed): the job went silent.
 * - `max-lease-exceeded` — a *configured* max-lease cap expired the lease even
 *   though it was still beating (total lifetime since `claimedAt` passed the
 *   cap). Only possible when `maxLeaseMs`/per-step `maxLease` is set.
 * - `run-missing` — the task was claimed but has no run row.
 * - `run-closed` — the owning run already closed (its outcome is set).
 * - `forced` — an admin `reap --now` (`ttlOverride: 0`) cleared a lease that
 *   was still fresh under the real TTL rules; reported instead of a misleading
 *   liveness reason so the output does not look like the job failed.
 */
export type ReapReason =
  | 'heartbeat-lost'
  | 'max-lease-exceeded'
  | 'run-missing'
  | 'run-closed'
  | 'forced';

/** One cleared-lease entry from {@link Engine.reapWithDetails}. */
export interface ReapDetail {
  step: string;
  key: string;
  run?: string;
  reason: ReapReason;
}

export class Engine {
  readonly store: Store;
  private readonly resolveDef: DefResolver;
  private readonly reapTtlMs: number;
  private readonly maxLeaseMs: number | undefined;
  private readonly maxCallDepth: number;
  private readonly listeners = new Set<EngineListener>();
  private readonly onListenerError?: (err: unknown, event: EngineEvent) => void;
  /** M2B: recursion guard — set of parentWf ids currently inside maintainCalls. */
  private readonly _inMaintainCalls = new Set<string>();

  constructor(
    store: Store,
    resolveDef: DefResolver,
    opts: {
      reapTtlMs?: number;
      /** A3 (REL-8): OPT-IN hard cap on total lease lifetime (claimedAt +
       *  maxLease), enforced regardless of heartbeats. Unset (the default) means
       *  NO cap — a correctly heartbeating job runs as long as it needs, and the
       *  anchor rule (reap TTL vs. last beat) is the only liveness bound. Set it
       *  only as a runaway backstop; a per-step `maxLeaseMs` overrides it. */
      maxLeaseMs?: number;
      /** REL-4: hard cap on `calls:` composition depth (root = 0). Falls back to
       *  DEFAULT_MAX_CALL_DEPTH (64). Defense in depth against a calls: cycle
       *  that bypassed load-time validation (e.g. a hand-wired custom resolver). */
      maxCallDepth?: number;
      /** A listener registered up front, equivalent to a `subscribe` call. */
      onEvent?: EngineListener;
      /** Where a throwing listener's error goes (default: swallowed). */
      onListenerError?: (err: unknown, event: EngineEvent) => void;
    } = {},
  ) {
    this.store = store;
    this.resolveDef = resolveDef;
    this.reapTtlMs = opts.reapTtlMs ?? DEFAULT_REAP_TTL_MS;
    this.maxLeaseMs = opts.maxLeaseMs;
    this.maxCallDepth = opts.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH;
    if (opts.onEvent) this.listeners.add(opts.onEvent);
    this.onListenerError = opts.onListenerError;
  }

  /**
   * Register a synchronous observer of engine changes; returns an idempotent
   * unsubscribe. Listeners fire AFTER a mutation's transaction commits, so they
   * observe fully-committed, settled state. A throwing listener is isolated
   * (routed to `onListenerError`) and never rolls back the commit or starves
   * its siblings. See {@link EngineEvent}.
   */
  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- instance lifecycle ----------------------------------------------------

  /** Start a workflow instance: persist it, seed its declared inputs, settle. */
  createInstance(defName: string, opts: CreateOpts = {}): string {
    const def = this.resolveDef(defName);
    const id = randId('wf');
    this.store.tx(() => this.createInstanceInTx(defName, def, id, opts));
    this.fire({ type: 'instance', workflow: id, def: defName });
    this.fireSettled(id);
    return id;
  }

  /**
   * The transactional body of instance creation: persist the workflow row, seed
   * its declared inputs (validating any provided values), and settle. MUST run
   * inside a `store.tx()` — callers own the tx and the post-commit event firing.
   * Extracted from {@link createInstance} so the atomic child-spawn path
   * ({@link spawnChildIfAbsent}) can insert-or-read a child under a single
   * `BEGIN IMMEDIATE` without nesting transactions.
   */
  private createInstanceInTx(defName: string, def: WorkflowDef, id: string, opts: CreateOpts): void {
    // §28: pin this instance to the def it was created against — a snapshot
    // of the fully-expanded compiled def plus its content hash. Every new
    // instance is stamped; "no snapshot" is strictly a legacy-row
    // compatibility case (see defFor), never a choice made here.
    const wfData: {
      def: string; title?: string; params?: Record<string, string>;
      defSnapshot: WorkflowDef; defHash: string;
    } = { def: defName, defSnapshot: def, defHash: hashDef(def) };
    if (opts.title !== undefined) wfData.title = opts.title;
    if (opts.params !== undefined) wfData.params = opts.params;
    this.store.insertWorkflow(id, wfData, opts.producedBy);

    for (const input of def.inputs) {
      const provided = opts.provide?.[input.name];
      if (provided !== undefined && input.schema !== undefined) {
        const check = validateValue(input.schema, provided);
        if (!check.valid) {
          throw new SchemaRefusalError(input.name, check.issues);
        }
      }
      const seedGreen = !input.seedOwed || provided !== undefined;
      const a: ArtifactData = {
        workflow: id,
        path: input.name,
        producer: input.producer,
        acceptance: seedGreen ? 'green' : 'owed',
        version: seedGreen ? 1 : 0,
        reasons: [],
        judgmentRejects: 0,
        schemaRejects: 0,
      };
      if (provided !== undefined) a.value = provided;
      this.store.putArtifact(a);
    }
    this.settle(id, def);
  }

  /**
   * REL-5: atomically attach-or-create the child instance for a `calls:` step.
   * The check-then-insert runs inside ONE `BEGIN IMMEDIATE` transaction, so two
   * concurrent driver ticks (even in separate processes) serialize on the write
   * lock: the first inserts the child, the second observes it and re-attaches —
   * never two children for the same parent coordinate. The v8 partial unique
   * index (`workflow_produced_by_unique`) is the physical backstop.
   *
   * Returns the child id and whether THIS call created it. Events (`instance`,
   * `settled`) are the caller's responsibility and must fire only when
   * `created` is true — a re-attach (or a lost race) must be silent, matching
   * the pre-REL-5 re-attach behavior.
   *
   * A `SchemaRefusalError` (a provided parent value illegal per the child's
   * input schema) propagates out with the tx rolled back — no orphan child row
   * — preserving the F2 contract in `maintainCalls`.
   */
  private spawnChildIfAbsent(
    defName: string,
    parentWf: string,
    callsPath: string,
    seedProvide: Record<string, Record<string, unknown>>,
  ): { id: string; created: boolean } {
    const def = this.resolveDef(defName);
    const run = (): { id: string; created: boolean } =>
      this.store.tx(() => {
        const existing = this.store.findChildByParent(parentWf, callsPath);
        if (existing) return { id: existing.id, created: false };
        const id = randId('wf');
        this.createInstanceInTx(defName, def, id, {
          producedBy: { parentWf, parentPath: callsPath },
          provide: seedProvide,
        });
        return { id, created: true };
      });
    try {
      return run();
    } catch (err) {
      // Constraint backstop for any future concurrent writer that isn't
      // serialized by BEGIN IMMEDIATE: if the insert lost a race on the unique
      // index, the winner's row is already committed — read and re-attach to it.
      // Unreachable under node:sqlite's synchronous, write-lock-serialized
      // connections, but cheap and correct defense.
      if (
        err instanceof Error &&
        /UNIQUE constraint failed: workflow\.produced_by_wf/.test(err.message)
      ) {
        const winner = this.store.findChildByParent(parentWf, callsPath);
        if (winner) return { id: winner.id, created: false };
      }
      throw err;
    }
  }

  /** A human/external producer supplies (greens) an owed input. */
  provideInput(workflow: string, name: string, value: Record<string, unknown>): void {
    const def = this.defFor(workflow);
    const inputDef = def.inputs.find((i) => i.name === name);
    this.store.tx(() => {
      const art = this.store.getArtifact(workflow, name);
      if (!art) throw new Error(`no such input artifact: ${name}`);
      // §18: validate inside the tx (as `createInstance` does) so the value is
      // checked against — and committed atomically with — the state the write
      // sees, with no window where a concurrent mutation could intervene.
      if (inputDef?.schema !== undefined) {
        const check = validateValue(inputDef.schema, value);
        if (!check.valid) {
          throw new SchemaRefusalError(name, check.issues);
        }
      }
      this.store.putArtifact({
        ...art,
        acceptance: 'green',
        version: art.version + 1,
        value,
      });
      this.settle(workflow, def);
    });
    this.fire({ type: 'commit', workflow, path: name, action: 'provide' });
    this.fireSettled(workflow);
    // M2B cascade-up: re-run calls: child maintenance so a newly-provided input
    // is immediately re-provided to any child that maps from it (no extra tick needed).
    // Outside the tx — same contract as tick's maintainCalls call at line 417.
    this.maintainCalls(workflow, def);
  }

  /**
   * §28: re-pin `workflow` to the CURRENTLY-LOADED def for its name — re-
   * snapshot + re-hash, overwriting the stored pin — then settle() so any new
   * debts introduced by the updated shape (e.g. a newly added required input,
   * a renamed producer) materialize immediately as a deliberate act, not a
   * surprise on the next unrelated verb call. This is the explicit opt-in to
   * re-wire an in-flight instance onto new def content; contrast defFor's
   * silent, unconditional pin-preservation.
   */
  adopt(workflow: string): { workflow: string; defHash: string; previousHash?: string } {
    const wf = this.store.getWorkflow(workflow);
    if (!wf) throw new Error(`no such workflow instance: ${workflow}`);
    // Intentional and correct: adopt is precisely the one place that MUST
    // read the live current def, bypassing the pin, because re-pinning IS
    // the point. If wf.def no longer resolves, let resolveDef throw
    // naturally — adopting onto a def that's gone is a genuine error, unlike
    // status's drift check which tolerates it.
    const freshDef = this.resolveDef(wf.def);
    const newHash = hashDef(freshDef);
    const previousHash = wf.defHash;
    this.store.tx(() => {
      this.store.repinWorkflowDef(workflow, freshDef, newHash);
      this.settle(workflow, freshDef);
    });
    this.fireSettled(workflow);
    return previousHash !== undefined
      ? { workflow, defHash: newHash, previousHash }
      : { workflow, defHash: newHash };
  }

  // ---- Mode 2 calls: child-instance management --------------------------------

  /**
   * F4: the synthetic fingerprint key a `calls:` artifact uses to pin its
   * fingerprint to the child outcome's version. A calls: step declares
   * `consumes: []` (§ M2B), so its produce's fingerprint would otherwise never
   * see the child outcome (which lives in another instance entirely) — this
   * key is how that pin rides inside the same `Fingerprint` map alongside the
   * gate stems, without colliding with any real parent artifact path (gate
   * stems are bare names; this key is namespaced and reserved).
   */
  private static readonly CHILD_OUTCOME_PIN_KEY = '__child_outcome_version__';

  /**
   * F4: the single place that computes "what child-outcome version is this
   * calls: artifact currently resting on" — used both when machine-greening
   * (STEP 6) and when stamping the pin at verdict time (reject propagation,
   * human skip). Returns undefined if no child has ever been spawned (nothing
   * to pin to).
   */
  private childOutcomePin(parentWf: string, callsPath: string): number | undefined {
    const child = this.store.findChildByParent(parentWf, callsPath);
    if (!child) return undefined;
    const childDef = this.defFor(child.id);
    const childOutcomeStem = childDef.outputs![0]!;
    const childArts = this.artMap(child.id);
    const childOutcomeArt = childArts.get(childOutcomeStem);
    return childOutcomeArt?.version ?? -1;
  }

  /**
   * F2: record a child input-schema refusal (from STEP 3 spawn or STEP 5
   * re-provide) as a debt on the PARENT calls artifact — same shape as
   * green()'s schema-reject branch (acceptance: 'rejected', schemaRejects+1,
   * a 'validation' reasons entry naming the child input and the schema
   * issues) — so the tick can proceed instead of throwing, and the parent
   * calls artifact surfaces as a stallable debt (maxSchemaFailures/retry).
   * Stamps the current gate fingerprint on the rejected artifact so the
   * STEP-2 guard can tell "gate unmoved, don't re-attempt" from "gate moved,
   * worth retrying" on the next tick.
   */
  private recordCallsSchemaReject(
    parentWf: string,
    def: WorkflowDef,
    callsStem: string,
    gateStems: string[],
    err: SchemaRefusalError,
    now?: number,
  ): void {
    const text = `child input '${err.inputName}' failed schema: ${summarizeIssues(err.issues)}`;
    this.store.tx(() => {
      const art = this.store.getArtifact(parentWf, callsStem);
      if (!art) return; // not yet materialized by pendingOwed — nothing to stamp
      const gateArts = this.artMap(parentWf);
      const fp = computeFingerprint(gateArts, gateStems);
      this.store.putArtifact({
        ...art,
        acceptance: 'rejected',
        schemaRejects: art.schemaRejects + 1,
        fingerprint: fp,
        reasons: [...art.reasons, reason('schema-reject', 'validation', 'engine', text, art.version)],
      });
      this.settle(parentWf, def, now);
    });
    this.fire({ type: 'commit', workflow: parentWf, path: callsStem, action: 'reject', outcome: 'schema-rejected' });
    this.fireSettled(parentWf);
  }

  /**
   * REL-4: the `calls:` ancestry depth of an instance — how many `producedBy`
   * parent links separate it from the root of its composed tree. A root
   * instance (no `producedBy`) is depth 0; a child spawned by the root is
   * depth 1; and so on. O(depth) — walks the parent chain, which is exactly the
   * tree the spawn bound is protecting, so it only runs on an actual spawn.
   */
  private callsAncestryDepth(workflow: string): number {
    let depth = 0;
    let cur = this.store.getWorkflow(workflow);
    while (cur?.producedBy) {
      depth++;
      cur = this.store.getWorkflow(cur.producedBy.parentWf);
    }
    return depth;
  }

  /**
   * REL-4: record a `calls:` depth-limit refusal as a debt on the PARENT calls
   * artifact — same clean-stop mechanism as `recordCallsSchemaReject` (mark it
   * `rejected`, stamp the current gate fingerprint so the STEP-2 F2 guard skips
   * re-attempts on later ticks), but the reason is a plain structural rejection,
   * NOT a schema failure: it does not touch `schemaRejects` (that counter gates
   * `maxSchemaFailures` and means something specific). The message is actionable
   * — a depth-limit trip almost always means a `calls:` cycle in the def set
   * bypassed load-time validation (a hand-wired resolver construction validation
   * cannot see); raising `maxCallDepth` is only correct when the depth is truly
   * intentional. Stopping here — instead of spawning — is what prevents the
   * unbounded row creation + stack overflow REL-4 describes.
   */
  private recordCallsDepthReject(
    parentWf: string,
    def: WorkflowDef,
    callsStem: string,
    gateStems: string[],
    childDefName: string,
    now?: number,
  ): void {
    const text = `calls depth limit reached (maxCallDepth=${this.maxCallDepth}) spawning '${childDefName}': `
      + `this usually means a calls: cycle in the definition set bypassed load-time validation; `
      + `raise maxCallDepth via Engine opts only if this depth is intentional`;
    this.store.tx(() => {
      const art = this.store.getArtifact(parentWf, callsStem);
      if (!art) return; // not yet materialized by pendingOwed — nothing to stamp
      const gateArts = this.artMap(parentWf);
      const fp = computeFingerprint(gateArts, gateStems);
      this.store.putArtifact({
        ...art,
        acceptance: 'rejected',
        fingerprint: fp,
        reasons: [...art.reasons, reason('reject', 'structural', 'engine', text, art.version)],
      });
      this.settle(parentWf, def, now);
    });
    this.fire({ type: 'commit', workflow: parentWf, path: callsStem, action: 'reject' });
    this.fireSettled(parentWf);
  }

  /**
   * M2B: Maintain all `calls:` steps for a parent workflow.
   * Called at the top of tick (outside any tx) and as cascade-up prompt.
   * For each calls: step: spawn the child if gate is ready and no child exists;
   * re-attach if it exists; re-provide if parent inputs moved; machine-green
   * the parent artifact when the child's declared output is green.
   */
  private maintainCalls(parentWf: string, def: WorkflowDef, now?: number): void {
    if (this._inMaintainCalls.has(parentWf)) return;
    this._inMaintainCalls.add(parentWf);
    try {
      for (const step of def.steps) {
        if (!step.calls) continue;

        // STEP 1 — Gather gate stems and check gate readiness.
        const callsStem = step.produces[0]!.stem; // single produced artifact name
        const callsPath = callsStem;
        const gateStems = Object.values(step.callsInputs ?? {});
        const parentArts = this.artMap(parentWf);
        if (!this.callsGateReady(parentArts, step)) continue;

        // STEP 2 — Look up any existing child via reverse index.
        let existingChild = this.store.findChildByParent(parentWf, callsPath);

        // F2: if the parent calls artifact is already `rejected` on a schema
        // refusal (see STEP 3/5 below) and the gate stems haven't moved since
        // that refusal was recorded, don't re-attempt — the same value would
        // just refuse again. The gate fingerprint on the rejected artifact is
        // the guard; a moved gate (fingerprint mismatch) means the parent
        // value may have been fixed, so fall through and retry.
        const parentCallsArtPre = this.store.getArtifact(parentWf, callsStem);
        if (!existingChild && parentCallsArtPre?.acceptance === 'rejected') {
          const gateArtsPre = this.artMap(parentWf);
          const currentGateFp = computeFingerprint(gateArtsPre, gateStems);
          if (deepEqual(currentGateFp, parentCallsArtPre.fingerprint ?? {})) continue;
        }

        // STEP 3 — SPAWN or RE-ATTACH.
        if (!existingChild) {
          // REL-4 spawn-time bound (the guard that prevents row bloat). Refuse to
          // spawn once this parent's own calls: ancestry has reached maxCallDepth:
          // a self- or cross-calling def whose cycle slipped past load-time
          // validation would otherwise mint a fresh child instance (a new DB row)
          // at every recursion level until the process stack overflows. Record a
          // rejection on the parent calls artifact (clean stop; the STEP-2 F2
          // fingerprint guard then skips re-attempts) instead of throwing.
          if (this.callsAncestryDepth(parentWf) >= this.maxCallDepth) {
            this.recordCallsDepthReject(parentWf, def, callsStem, gateStems, step.calls, now);
            continue;
          }
          // SPAWN: gate is ready and no child exists yet.
          const seedProvide: Record<string, Record<string, unknown>> = {};
          for (const [childInputName, parentArtifactName] of Object.entries(step.callsInputs ?? {})) {
            const parentArt = parentArts.get(parentArtifactName);
            if (parentArt?.value !== undefined) seedProvide[childInputName] = parentArt.value;
          }
          // F2: a child input-schema refusal here is not a bug — a parent
          // value can be legal per the parent's own schema (looser, or absent)
          // yet illegal per the child's declared input schema. Catch narrowly
          // (SchemaRefusalError only; anything else is a genuine bug and must
          // still throw) and record it as a debt on the PARENT calls artifact,
          // mirroring green()'s schema-reject branch, so the tick proceeds
          // instead of crash-looping every subsequent tick(parent).
          let spawn: { id: string; created: boolean };
          try {
            // REL-5: atomic insert-or-read inside BEGIN IMMEDIATE — a concurrent
            // tick that already spawned the child is re-attached here rather
            // than duplicated. Events fire only when THIS call created it.
            spawn = this.spawnChildIfAbsent(step.calls, parentWf, callsPath, seedProvide);
          } catch (err) {
            if (err instanceof SchemaRefusalError) {
              this.recordCallsSchemaReject(parentWf, def, callsStem, gateStems, err, now);
              continue;
            }
            throw err;
          }
          if (spawn.created) {
            this.fire({ type: 'instance', workflow: spawn.id, def: step.calls });
            this.fireSettled(spawn.id);
          }
          existingChild = this.store.getWorkflow(spawn.id);
        }
        // else: RE-ATTACH — existingChild is the already-spawned child; no new spawn.

        if (!existingChild) continue; // defensive: createInstance returned but getWorkflow failed

        // STEP 4 — Read child's declared outcome artifact.
        // §28: go through defFor so a pinned child instance is read per its own
        // pinned snapshot, not whatever def currently loads under its name.
        const childDef = this.defFor(existingChild.id);
        const childOutcomeStem = childDef.outputs![0]!; // validated by Phase-2 check
        let childArts = this.artMap(existingChild.id);
        let childOutcomeArt = childArts.get(childOutcomeStem);

        // STEP 5 — RE-PROVIDE if parent gate source moved (M2B-REPROVIDE).
        // F2: same typed-refusal handling as STEP 3 — a re-provided parent
        // value illegal per the child's input schema becomes a debt on the
        // parent calls artifact instead of throwing out of provideInput's
        // cascade-up. The human's own provide of the PARENT input still
        // commits (that validation happens against the PARENT's schema,
        // inside provideInput's own tx, before this cascade ever runs).
        for (const [childInputName, parentArtifactName] of Object.entries(step.callsInputs ?? {})) {
          const parentArtNow = parentArts.get(parentArtifactName);
          const childInputArt = childArts.get(childInputName);
          if (parentArtNow?.value !== undefined && !deepEqual(parentArtNow.value, childInputArt?.value)) {
            try {
              this.provideInput(existingChild.id, childInputName, parentArtNow.value as Record<string, unknown>);
            } catch (err) {
              if (err instanceof SchemaRefusalError) {
                this.recordCallsSchemaReject(parentWf, def, callsStem, gateStems, err, now);
                continue;
              }
              throw err;
            }
          }
        }

        // STEP 6 — MACHINE-GREEN or STAY OWED (M2B-CASCADEUP).
        // Re-read after potential re-provide.
        childArts = this.artMap(existingChild.id);
        childOutcomeArt = childArts.get(childOutcomeStem);
        const parentCallsArt = this.store.getArtifact(parentWf, callsStem);

        // F2: don't machine-green over a schema-rejected debt — it needs a
        // human `retry` (or a moved gate, handled by the guard above) before
        // this step revisits it.
        if (parentCallsArt?.acceptance === 'rejected') continue;

        if (isGreen(childOutcomeArt) && childOutcomeArt?.value !== undefined) {
          const alreadyGreen = isGreen(parentCallsArt);
          const sameValue = alreadyGreen && deepEqual(childOutcomeArt.value, parentCallsArt?.value);
          // F4: version-pinning. Only machine-green when the child outcome's
          // version has moved past whatever version is currently pinned on
          // the parent artifact — this is what lets a consumer's reject
          // (propagated down, parent reopened to owed pinned to the rejected
          // child version) or a human skip (pinned at skip time) stand until
          // the child actually rebuilds past that pin, instead of being
          // silently overridden on the very next tick.
          const pinnedVersion = parentCallsArt?.fingerprint?.[Engine.CHILD_OUTCOME_PIN_KEY];
          const pastPin = pinnedVersion === undefined || childOutcomeArt.version > pinnedVersion;
          if ((!alreadyGreen || !sameValue) && pastPin) {
            if (!parentCallsArt) continue; // not yet materialized by pendingOwed — skip
            const gateArts = this.artMap(parentWf);
            const fp = computeFingerprint(gateArts, gateStems);
            fp[Engine.CHILD_OUTCOME_PIN_KEY] = childOutcomeArt.version;
            const next: ArtifactData = {
              ...parentCallsArt,
              acceptance: 'green',
              version: parentCallsArt.version + 1,
              value: childOutcomeArt.value,
              fingerprint: fp,
            };
            // Do NOT set terminal: calls: artifact must be re-armable if gate inputs move.
            this.store.tx(() => {
	      this.store.putArtifact({ ...next, workflow: parentWf }, {
		action: 'provided', actor: 'engine', reason: 'child outcome provided',
	      });
              this.settle(parentWf, def, now);
            });
            this.fire({ type: 'commit', workflow: parentWf, path: callsStem, action: 'provide' });
            this.fireSettled(parentWf);
          }
        } else if (!isGreen(childOutcomeArt) && isGreen(parentCallsArt) && parentCallsArt) {
          // M2B-REARM: child's outcome is no longer green (e.g. re-provide re-armed it)
          // but the parent calls: artifact is still green. Re-arm it to owed so downstream
          // re-runs when the child completes again. This handles gate re-arm (test f):
          // the cascade can't detect this because deliver step has consumes: [].
          this.store.tx(() => {
            const artNow = this.store.getArtifact(parentWf, callsStem);
            if (!artNow || !isGreen(artNow)) return; // already re-armed or gone
            this.store.putArtifact({
              ...artNow,
              acceptance: 'owed',
              reasons: [...artNow.reasons, {
                at: nowMs(),
                action: 'reopen' as const,
                kind: 'structural' as const,
                by: 'engine' as const,
                text: 'gate input moved: child re-running',
                fromVersion: artNow.version,
              }],
            });
            this.settle(parentWf, def, now);
          });
          this.fire({ type: 'commit', workflow: parentWf, path: callsStem, action: 'retry' });
          this.fireSettled(parentWf);
        }
      }
    } finally {
      this._inMaintainCalls.delete(parentWf);
    }
  }

  /**
   * M2B cascade-up prompt: if `workflow` has a producedBy link, trigger
   * maintainCalls on its parent so the parent reflects the child's progress promptly.
   * Called after child commits (green, close) — outside any open tx.
   */
  private triggerParentIfChild(workflow: string): void {
    const wfRow = this.store.getWorkflow(workflow);
    if (!wfRow?.producedBy) return;
    const { parentWf } = wfRow.producedBy;
    if (this._inMaintainCalls.has(parentWf)) return;
    const parentWfRow = this.store.getWorkflow(parentWf);
    if (!parentWfRow) return;
    // §28: go through defFor so a pinned parent instance is maintained per its
    // own pinned snapshot, not whatever def currently loads under its name.
    const parentDef = this.defFor(parentWf);
    this.maintainCalls(parentWf, parentDef);
    this.fireSettled(parentWf);
  }

  // ---- the tick (maintain → reap → eligible → cadence/budget → claim) --------

  /**
   * Pull eligible orders for `workflow`. §23.6.8: **deep by default** — after
   * maintaining and ticking this instance, descend into every live `calls:`
   * child (recursively, grandchildren too) and fold their orders / reaps /
   * deferrals / `dueAt` into the returned result so a driver that ticks only
   * the root drives the whole composed tree (a shallow tick would deadlock a
   * `calls:` workflow — the child's eligible steps would never be claimed).
   * Pass `{ deep: false }` (CLI `--shallow`) to restore the pre-deep behavior:
   * only this instance's own orders. See `TickResult` for the fold semantics.
   */
  tick(workflow: string, opts: { now?: number; deep?: boolean; labels?: string[] } = {}): TickResult {
    return this.tickInternal(workflow, opts.now ?? nowMs(), opts.deep ?? true, opts.labels ?? [], new Set(), 0);
  }

  /**
   * The recursive tick worker. Runs this instance's own maintain → reap →
   * eligible → claim cycle (its body is byte-for-byte the pre-deep `tick`,
   * kept inside its own `store.tx`), then — when `deep` — descends into each
   * live `calls:` child by calling itself again. The descent MUST run OUTSIDE
   * this frame's `store.tx`: `store.tx` forbids re-entrancy, and every child
   * frame opens its own tx (via its own `maintainCalls` + tick body), so a
   * child is driven by a full nested `tickInternal`, never a child tx opened
   * inside the parent's.
   *
   * REL-4: `visited` (a set of workflow INSTANCE ids) is NOT a sufficient guard
   * against a `calls:` cycle. Each descent level's `maintainCalls` SPAWNS a
   * brand-new child instance, so a self-calling def produces a fresh id at every
   * level — `visited` never trips, and recursion would run unbounded (one DB row
   * per level) until the stack overflows. The real guard is the `maxCallDepth`
   * bound: `maintainCalls` refuses to spawn past it (so a newly-created tree can
   * never get here too deep), and the `depth` check below is the belt-and-braces
   * backstop for a PRE-EXISTING deep tree (e.g. a DB written by an older build
   * before the spawn bound existed) — it throws rather than overflow the stack.
   * `visited` still earns its keep as a re-entrancy guard for a genuinely
   * re-encountered instance within one tick.
   */
  private tickInternal(workflow: string, now: number, deep: boolean, labels: string[], visited: Set<string>, depth: number): TickResult {
    if (depth > this.maxCallDepth) {
      throw new Error(
        `calls depth limit exceeded (maxCallDepth=${this.maxCallDepth}) ticking '${workflow}': `
        + `a calls: composition is deeper than the bound, which usually means a calls: cycle `
        + `in the definition set; raise maxCallDepth via Engine opts only if this depth is intentional`,
      );
    }
    if (visited.has(workflow)) return { workflow, orders: [], reaped: 0, deferred: [] };
    visited.add(workflow);
    const def = this.defFor(workflow);
    // M2B: maintain calls: child instances before the normal tick/reap/claim cycle.
    this.maintainCalls(workflow, def, now);
    const result = this.store.tx(() => {
      this.settle(workflow, def, now);
      const reaped = this.reap(workflow, now, def);

      const arts = this.artMap(workflow);

      // Compute time facts for idle eligibility (clock-read boundary).
      const timeFacts = this.computeTimeFacts(def, workflow, arts, now);

      const firings = eligibleFirings(def, arts, timeFacts);
      const { selected, deferred } = this.applySchedule(workflow, def, firings, now, labels);

      // Clear alarm_at for any idle firing that was selected (consume the alarm).
      for (const f of selected) {
        if (f.cause === 'idle') {
          this.store.clearAlarm(workflow, f.step);
        }
      }

      const orders: Order[] = [];
      const allDeferred: DeferredFiring[] = [...deferred];
      for (const f of selected) {
        const claimed = this.claim(workflow, def, f, arts, now);
        if (claimed === 'in-flight') {
          const d: DeferredFiring = { step: f.step, key: f.key, inputs: f.inputs, outputs: f.outputs, reason: 'in-flight' };
          if (f.index !== undefined) d.index = f.index;
          allDeferred.push(d);
        } else if (claimed) {
          orders.push(claimed);
        }
      }

      // E-DUE: compute earliest pending time-trigger for the result.
      const dueAt = this.computeDueAt(def, workflow, now);

      const r: TickResult = { workflow, orders, reaped, deferred: allDeferred };
      if (dueAt !== null) r.dueAt = dueAt;
      return r;
    });

    // §23.6.8 DESCENT — outside this frame's tx (see method doc). Drive each
    // live calls: child with its own full tickInternal and fold its result up.
    if (deep) {
      for (const { child } of this.callsDescendTargets(workflow, def)) {
        const cr = this.tickInternal(child.id, now, deep, labels, visited, depth + 1);
        // orders: flatten; each Order already carries its own `workflow`.
        result.orders.push(...cr.orders);
        // deferred: stamp child-originated entries with the child id, preserving
        // a grandchild's already-stamped id (absent = ticked root, see type doc).
        for (const d of cr.deferred) {
          result.deferred.push({ ...d, workflow: d.workflow ?? cr.workflow });
        }
        // reaped: sum across the tree (also reaps dead child leases that would
        // otherwise sit until someone ticked the child directly).
        result.reaped += cr.reaped;
        // dueAt: min across the tree; stays absent when neither side has one.
        if (cr.dueAt !== undefined) {
          result.dueAt = result.dueAt === undefined ? cr.dueAt : Math.min(result.dueAt, cr.dueAt);
        }
      }
    }
    return result;
  }

  /**
   * §23.6.8: is a `calls:` step's gate ready — i.e. every parent artifact wired
   * into `callsInputs` is green? Shared by `maintainCalls` STEP 1 and
   * `callsDescendTargets` so the descend condition can never drift from the
   * spawn/re-provide condition. Empty gate (`callsInputs: {}`) is always ready.
   */
  private callsGateReady(parentArts: ArtifactMap, step: StepDef): boolean {
    const gateStems = Object.values(step.callsInputs ?? {});
    return gateStems.length === 0 || gateStems.every((s) => isGreen(parentArts.get(s)));
  }

  /**
   * §23.6.8: the live `calls:` children a deep tick should descend into, one
   * per calls: step whose (1) gate is green, (2) child instance exists, and
   * (3) debt is unpaid (the parent calls artifact is not green). Read AFTER
   * `maintainCalls` has run this frame, so a just-spawned child is visible and
   * a just-machine-greened debt is correctly skipped. Consequences that fall
   * out for free: gate re-armed after spawn → not ready → no descend
   * (consistent with maintainCalls bailing at STEP 1, never driving work on
   * disputed inputs); debt already paid → skip.
   */
  private callsDescendTargets(parentWf: string, def: WorkflowDef): Array<{ step: StepDef; child: WorkflowRow }> {
    const arts = this.artMap(parentWf);
    const out: Array<{ step: StepDef; child: WorkflowRow }> = [];
    for (const step of def.steps) {
      if (!step.calls) continue;
      const stem = step.produces[0]!.stem;
      if (!this.callsGateReady(arts, step)) continue; // 1. gate green
      const child = this.store.findChildByParent(parentWf, stem);
      if (!child) continue; // 2. child exists
      if (isGreen(arts.get(stem))) continue; // 3. debt unpaid
      out.push({ step, child });
    }
    return out;
  }

  /**
   * Per-step cadence + daily budget + parallel cap over the eligible firings.
   * A2: `labels` is the tick caller's optional claim filter — when non-empty, a
   * step whose own `labels` are also non-empty is only schedulable when the two
   * intersect; a disjoint step's firings are deferred as `'label-mismatch'`.
   * Filtering here (before cadence/budget) means a mismatched firing never
   * consumes the caller's slots and never perturbs cadence math.
   */
  private applySchedule(
    workflow: string,
    def: WorkflowDef,
    firings: Firing[],
    now: number,
    labels: string[],
  ): { selected: Firing[]; deferred: DeferredFiring[] } {
    const midnight = localMidnightMs(now);
    const selected: Firing[] = [];
    const deferred: DeferredFiring[] = [];

    const defer = (f: Firing, reason: DeferredReason): void => {
      const d: DeferredFiring = { step: f.step, key: f.key, inputs: f.inputs, outputs: f.outputs, reason };
      if (f.index !== undefined) d.index = f.index;
      deferred.push(d);
    };

    for (const step of def.steps) {
      const stepFirings = firings.filter((f) => f.step === step.name);
      if (stepFirings.length === 0) continue;

      // A2: caller label filter vs. step labels. Both non-empty and disjoint →
      // this caller must not claim the step; defer every firing and skip it
      // before it touches cadence/budget/slot math.
      if (labels.length > 0 && step.labels && step.labels.length > 0 &&
          !step.labels.some((l) => labels.includes(l))) {
        for (const f of stepFirings) defer(f, 'label-mismatch');
        continue;
      }

      const latest = this.store.latestRun(workflow, step.name);
      if (latest && now - latest.createdAt < step.cadenceSecs * 1000) {
        for (const f of stepFirings) defer(f, 'cadence');
        continue;
      }

      const used = this.store.countRuns(workflow, step.name, midnight);
      const budget = Math.max(0, step.maxRunsPerDay - used);
      const slots = Math.min(step.parallel, budget);

      // binding constraint for firings beyond the slots: budget is tighter (incl.
      // budget === 0) → daily-budget; otherwise the concurrency cap → parallel-cap.
      const beyondReason: DeferredReason = budget < step.parallel ? 'daily-budget' : 'parallel-cap';

      for (const f of stepFirings.slice(0, slots)) selected.push(f);
      for (const f of stepFirings.slice(slots)) defer(f, beyondReason);
    }

    return { selected, deferred };
  }

  /** Return the effective reap TTL for a step — per-step override or engine default. */
  private effectiveTtl(step?: StepDef): number {
    return step?.reapTtlMs ?? this.reapTtlMs;
  }

  /**
   * A3 (REL-8): return the effective max total lease lifetime for a step, or
   * `undefined` when no cap is configured. Per-step `maxLease` overrides the
   * engine option; when both are unset there is no cap (heartbeats extend the
   * lease indefinitely). Uses `??` (not `||`) so an explicit `0` stays a cap.
   */
  private effectiveMaxLease(step?: StepDef): number | undefined {
    return step?.maxLeaseMs ?? this.maxLeaseMs;
  }

  /**
   * Classify a claimed task's liveness against the two independent bounds, so a
   * reap can report WHY a lease was cleared:
   * - `heartbeat-lost` — the anchor rule lapsed: `now - max(claimedAt,
   *   heartbeatAt) > ttl`. The job went silent (or never beat).
   * - `max-lease-exceeded` — the anchor rule still holds (a live, beating job)
   *   but a CONFIGURED `maxLease` cap has been exceeded: `now - claimedAt >
   *   maxLease`. Only reachable when `maxLease !== undefined`.
   * - `fresh` — neither bound violated.
   *
   * Precedence: `heartbeat-lost` wins when both bounds lapse — if the job was
   * not alive under the anchor rule, reporting `max-lease-exceeded` would wrongly
   * suggest the cap killed a healthy job. The cap reason is reported only for a
   * still-beating lease. The clamp is measured off the ORIGINAL `claimedAt` of
   * the current claim; after a reap + re-claim it re-anchors to the new claim.
   */
  private staleness(
    task: { claimedAt?: number; heartbeatAt?: number },
    now: number,
    ttl: number,
    maxLease: number | undefined,
  ): 'fresh' | 'heartbeat-lost' | 'max-lease-exceeded' {
    const anchor = task.heartbeatAt !== undefined && task.heartbeatAt > (task.claimedAt ?? 0)
      ? task.heartbeatAt
      : (task.claimedAt ?? 0);
    if (now - anchor > ttl) return 'heartbeat-lost';
    // A3 clamp: total lifetime since the original claim may not exceed a
    // CONFIGURED maxLease. Unset (undefined) = no cap. `0` is a real (if silly)
    // cap, so test `!== undefined`, not truthiness.
    if (maxLease !== undefined && task.claimedAt !== undefined && now - task.claimedAt > maxLease) {
      return 'max-lease-exceeded';
    }
    return 'fresh';
  }

  /**
   * Unified liveness predicate: returns true if the task's claim is still fresh.
   * Thin wrapper over {@link staleness} — see it for the anchor rule and the
   * opt-in max-lease clamp. A heartbeating run is never falsely reaped after the
   * global TTL (anchor rule), and only a configured `maxLease` can reap a
   * still-beating lease.
   */
  private isClaimFresh(
    task: { claimedAt?: number; heartbeatAt?: number },
    now: number,
    ttl: number,
    maxLease: number | undefined,
  ): boolean {
    return this.staleness(task, now, ttl, maxLease) === 'fresh';
  }

  /** Claim a firing's lease via CAS, snapshot the fingerprint, open a run. */
  private claim(
    workflow: string,
    def: WorkflowDef,
    f: Firing,
    arts: ArtifactMap,
    now: number,
  ): Order | 'in-flight' | null {
    const existing = this.store.getTask(workflow, f.step, f.key);
    if (existing && existing.status === 'claimed') {
      const run = existing.run ? this.store.getRun(existing.run) : undefined;
      const stepDef = def.steps.find((l) => l.name === f.step);
      const ttl = this.effectiveTtl(stepDef);
      const maxLease = this.effectiveMaxLease(stepDef);
      const fresh =
        !!run &&
        run.outcome === undefined &&
        (existing.claimedAt === undefined || this.isClaimFresh(existing, now, ttl, maxLease));
      if (fresh) return 'in-flight'; // genuinely in flight — don't double-claim
    }

    const runId = randId('run');
    const fp = computeFingerprint(arts, f.inputs);
    // Build the order BEFORE inserting the run so the flattened packet lands in
    // the SAME INSERT that creates the run row (§8 / Gap 1). buildOrder is
    // store-pure — it reads `def`, the in-memory `arts` map, and the firing, and
    // writes nothing — so reordering it ahead of insertRun changes no semantics.
    // Artifacts are overwritten in place (UNIQUE(workflow,path), putArtifact ON
    // CONFLICT DO UPDATE, no history table), so the issued order is unrecoverable
    // later unless captured here; this persisted packet is the replay/eval/paper
    // trail record (buildOrder is deterministic modulo run id).
    const order = this.buildOrder(def, workflow, runId, f, arts);
    // Stamp the run with the tick's clock so cadence/budget compare on one clock.
    this.store.insertRun(runId, { workflow, step: f.step, key: f.key, fingerprint: fp, order, ...(f.cause ? { cause: f.cause } : {}) }, now);
    this.store.putTask({
      workflow,
      step: f.step,
      key: f.key,
      status: 'claimed',
      run: runId,
      claimedAt: now,
      attempts: existing?.attempts ?? 0,
    });
    return order;
  }

  private buildOrder(
    def: WorkflowDef,
    workflow: string,
    runId: string,
    f: Firing,
    arts: ArtifactMap,
  ): Order {
    const step = this.step(def, f.step);
    const consumes: Record<string, unknown> = {};
    for (const p of f.inputs) {
      const a = arts.get(p);
      if (a?.value !== undefined) consumes[p] = a.value;
    }
    const owes = f.outputs.map((p) => {
      const a = arts.get(p);
      return {
        path: p,
        acceptance: a?.acceptance ?? 'owed',
        judgmentRejects: a?.judgmentRejects ?? 0,
        schemaRejects: a?.schemaRejects ?? 0,
        reasons: a?.reasons ?? [],
      };
    });
    const order: Order = {
      run: runId,
      workflow,
      step: f.step,
      key: f.key,
      inputs: f.inputs,
      outputs: f.outputs,
      prompt: substitute(step.body, {
        WORKFLOW: workflow,
        RUN: runId,
        STEP: f.step,
        KEY: f.key,
        INDEX: f.index === undefined ? '' : String(f.index),
        // Intentionally step-generic: a single firing can discharge multiple
        // outputs (f.outputs) at once, so there is no single produce to
        // resolve a per-produce maxAttempts override against here. This
        // always reflects the step default even when individual produces
        // override it (see model.ts effectiveMaxAttempts()).
        MAX_ATTEMPTS: String(step.maxAttempts),
      }),
      consumes,
      owes,
    };
    if (f.index !== undefined) order.index = f.index;
    if (step.workdir !== undefined) order.workdir = step.workdir;
    if (step.model !== undefined) order.model = step.model;
    if (step.worker !== undefined) order.worker = step.worker;
    if (step.command !== undefined) order.command = step.command;
    if (step.spec !== undefined) order.spec = step.spec;
    if (step.x !== undefined) order.x = step.x;
    if (f.cause !== undefined) order.cause = f.cause;
    return order;
  }

  // ---- producer commits ------------------------------------------------------

  /**
   * Commit a singleton/map output green — or born-reject it if an input moved.
   *
   * §24 actor discrimination, by `run`:
   *   - `run === 'human'` — the §4.11 override. No lease, no CAS: a human
   *     `green` on any artifact (in particular a `submitted` one) is a full
   *     bypass of the sign-off ledger, `submitted → green` immediately, and
   *     in-flight judge orders for that submission die on their own §4.6 CAS
   *     check the next time they try to verdict (the stem is no longer
   *     `submitted` at their fingerprinted version).
   *   - a real run whose step is a synthesized judge step (`step.judges`) —
   *     this is a judge verdict against the *judged* stem (`step.judges`),
   *     not a produce of the judge step's own (it has none). Judge-variant CAS
   *     (§4.6): the judged stem must still be `submitted` at the version this
   *     judge's run fingerprinted at claim time. Records the ledger slot; only
   *     flips `submitted → green` once every declared judge has signed the
   *     current version. Terminal is applied here (§4.8), not at producer
   *     commit, when the produce has judges.
   *   - a real run whose step is the artifact's actual producer — today's
   *     path, with one addition: if the produce declares `judges:`, the
   *     commit lands `submitted` (not `green`), clears any stale `approvals`
   *     ledger from a prior submission (§4.4), and defers `terminal` to
   *     judge-approve time instead of applying it here.
   */
  green(
    workflow: string,
    run: string,
    path: string,
    value: Record<string, unknown>,
    opts: { terminal?: boolean } = {},
  ): CommitResult {
    const def = this.defFor(workflow);
    if (run === 'human') {
      const result = this.store.tx((): CommitResult => {
        const arts = this.artMap(workflow);
        const art = arts.get(path);
        if (!art) throw new Error(`cannot green unknown artifact: ${path}`);
        // §26: a human bypass is still subject to group exclusivity — it must
        // not be able to land a second winner alongside an already-green sibling.
        const groupCas = this.groupCasCheck(def, arts, art);
        if (groupCas.rejected) {
          this.settle(workflow, def);
          return { path, outcome: 'group-rejected', reason: groupCas.reason };
        }
        // §18: a human bypass still lands a value downstream consumers assume
        // is schema-valid (and which can later crash e.g. maintainCalls child
        // seeding), so enforce the same produce schema the producer-commit path
        // enforces (below). Unlike that path, there is no lease/retry loop to
        // protect here — a schema-invalid human green is a hard refusal (thrown
        // Error), not a schemaRejects-bumping soft one: no version bump, artifact
        // left untouched. The judge bypass (§24.6) is untouched by this check.
        const humanSchema = this.produceSchema(def, art);
        if (humanSchema !== undefined) {
          const check = validateValue(humanSchema, value);
          if (!check.valid) {
            throw new Error(`human green for '${path}' failed schema: ${summarizeIssues(check.issues)}`);
          }
        }
        const req = requiredInputs(def, arts, art);
        const next: ArtifactData = {
          ...art,
          acceptance: 'green',
          version: art.version + 1,
          value,
          fingerprint: computeFingerprint(arts, req),
          approvals: undefined,
        };
        const producer = def.steps.find((l) => l.name === art.producer);
        if (opts.terminal || producer?.terminal) next.terminal = true;
	this.store.putArtifact(next, { action: 'green', actor: 'human', reason: 'human green' });
        this.settle(workflow, def);
        return { path, outcome: 'green' };
      });
      this.fire({ type: 'commit', workflow, run, path: result.path, action: 'green', outcome: result.outcome });
      this.fireSettled(workflow);
      this.triggerParentIfChild(workflow);
      return result;
    }

    const result = this.store.tx((): CommitResult => {
      const r = this.openRun(workflow, run);
      const runStep = def.steps.find((l) => l.name === r.step);
      const arts = this.artMap(workflow);

      // §24: a judge-step actor's `green` targets the judged stem, not an
      // output of its own (judge steps declare `produces: []`).
      if (runStep?.judges) {
        const judgedStem = runStep.judges;
        const judged = arts.get(judgedStem);
        const cas = this.judgeCasCheck(judged, judgedStem, r.fingerprint ?? {});
        if (cas.moved) {
          this.releaseLeaseOnBornReject(workflow, run);
          this.settle(workflow, def);
          return { path: judgedStem, outcome: 'born-rejected', reason: cas.reason };
        }
        const art = judged as ArtifactData; // judgeCasCheck guarantees submitted (non-null)
        const jName = judgeNameOf(runStep);
        const approvals = { ...(art.approvals ?? {}), [jName]: art.version };
        const judgeNames = this.declaredJudgeNames(def, art);
        const allApproved = judgeNames.every((jn) => approvals[jn] === art.version);
        if (allApproved) {
          // §26: the last judge's approve is the moment this stem would go
          // green — gate it on group exclusivity exactly like a plain commit.
          const groupCas = this.groupCasCheck(def, arts, art);
          if (groupCas.rejected) {
            this.settle(workflow, def);
            return { path: judgedStem, outcome: 'group-rejected', reason: groupCas.reason };
          }
          const producer = def.steps.find((l) => l.name === art.producer);
          const next: ArtifactData = { ...art, acceptance: 'green', approvals };
          if (producer?.terminal) next.terminal = true;
	  this.store.putArtifact(next, { action: 'judge-approved', actor: jName, reason: 'all judges approved' });
          this.settle(workflow, def);
          return { path: judgedStem, outcome: 'green' };
        }
	this.store.putArtifact({ ...art, approvals }, { action: 'judge-approved', actor: jName, reason: 'judge approved' });
        this.settle(workflow, def);
        return { path: judgedStem, outcome: 'approved' };
      }

      const art = arts.get(path);
      if (!art) throw new Error(`cannot green unknown artifact: ${path}`);

      // §26: a producer commit that would land green (no judges gating it) is
      // subject to group exclusivity — a judged produce defers this check to
      // the judge-approve branch above, since that's the actual green moment.
      // This runs before CAS/schema (same "check first, don't mutate on
      // refusal" ordering as the other structural refusal checks, and as the
      // human-bypass/judge-approve branches above): a losing sibling must be
      // refused as 'group-rejected' without bumping the schema-stall counter,
      // even when its value also happens to be schema-invalid.
      const judgeNames = this.declaredJudgeNames(def, art);
      const hasJudges = judgeNames.length > 0;
      if (!hasJudges) {
        const groupCas = this.groupCasCheck(def, arts, art);
        if (groupCas.rejected) {
          this.settle(workflow, def);
          return { path, outcome: 'group-rejected', reason: groupCas.reason };
        }
      }

      const req = requiredInputs(def, arts, art);
      const cas = this.casCheck(arts, req, r.fingerprint ?? {});
      if (cas.moved) {
        this.bornReject(art, cas.moved);
        this.releaseLeaseOnBornReject(workflow, run);
        this.settle(workflow, def);
        return { path, outcome: 'born-rejected', reason: cas.reason };
      }

      // §18: enforce the declared output schema *before* greening. A malformed
      // value is refused (not greened) and bumps the schema-stall counter. The
      // run/lease is left open, so the worker can correct and re-`green` on the
      // same run; the per-artifact counter is the real (unbypassable) bound.
      const schema = this.produceSchema(def, art);
      if (schema !== undefined) {
        const check = validateValue(schema, value);
        if (!check.valid) {
          const text = `schema validation failed: ${summarizeIssues(check.issues)}`;
          this.store.putArtifact({
            ...art,
            acceptance: 'rejected',
            schemaRejects: art.schemaRejects + 1,
            reasons: [...art.reasons, reason('schema-reject', 'validation', 'engine', text, art.version)],
          });
          this.settle(workflow, def);
          return { path, outcome: 'schema-rejected', reason: text, issues: check.issues };
        }
      }

      // §24 §4.4/§4.8: when this produce declares judges, the commit lands
      // `submitted` (not `green`) and the version bumps here — CAS re-arms on
      // resubmission, not on judge-approve. `approvals` resets so a prior
      // submission's sign-offs never leak onto a fresh version. Terminal is
      // deferred to judge-approve time (handled in the runStep?.judges branch
      // above), so it is deliberately NOT applied here when judges are declared.
      const next: ArtifactData = {
        ...art,
        acceptance: hasJudges ? 'submitted' : 'green',
        version: art.version + 1,
        value,
        fingerprint: computeFingerprint(arts, req),
        approvals: undefined,
      };
      // A destructive completion (e.g. a merge) is terminal: once green it can
      // never be re-armed by the forward cascade (§15.2). A step may declare its
      // output terminal in its definition, or the caller may force it per-commit.
      const producer = def.steps.find((l) => l.name === art.producer);
      if (!hasJudges && (opts.terminal || producer?.terminal)) next.terminal = true;
      this.store.putArtifact(next, {
	action: hasJudges ? 'submitted' : 'produced',
	actor: r.step,
	reason: hasJudges ? 'submitted for judgment' : 'producer green',
      });
      this.settle(workflow, def);
      return { path, outcome: hasJudges ? 'submitted' : 'green' };
    });
    this.fire({ type: 'commit', workflow, run, path: result.path, action: 'green', outcome: result.outcome });
    if (result.outcome === 'born-rejected') {
      this.fire({ type: 'closed', workflow, run, outcome: 'no_work' });
    }
    this.fireSettled(workflow);
    // M2B cascade-up prompt: if this workflow has a producedBy link, trigger parent maintainCalls.
    this.triggerParentIfChild(workflow);
    return result;
  }

  /**
   * A collection producer emits elements, accreting after the highest existing
   * index. CAS'd against the producer's plain inputs; a moved input born-rejects
   * the seal instead of emitting.
   */
  emit(workflow: string, run: string, items: Array<{ value: Record<string, unknown> }>): EmitResult {
    const def = this.defFor(workflow);
    let stem = '';
    const result = this.store.tx((): EmitResult => {
      const r = this.openRun(workflow, run);
      const step = this.step(def, r.step);
      const s = collectionStem(step);
      if (!s) throw new Error(`step ${r.step} does not produce a collection`);
      stem = s;
      const arts = this.artMap(workflow);

      const req = plainConsumes(step).map((c) => c.stem);
      const cas = this.casCheck(arts, req, r.fingerprint ?? {});
      if (cas.moved) {
        const seal = arts.get(sealPath(stem));
        if (seal) this.bornReject(seal, cas.moved);
        this.releaseLeaseOnBornReject(workflow, run);
        this.settle(workflow, def);
        return { outcome: 'born-rejected', created: [], reason: cas.reason };
      }

      // §11.1: once the seal is green the collection is complete — the offer
      // side never offers collection work again, so a late `emit` on a still
      // -open lease is refused rather than silently growing a "complete" set.
      // Check first, don't mutate on refusal (mirrors green()'s group check):
      // no counters bumped, no artifacts touched, lease stays open so the run
      // can still close.
      const sealForGreenCheck = arts.get(sealPath(stem));
      if (sealForGreenCheck && isGreen(sealForGreenCheck)) {
        return {
          outcome: 'sealed-rejected',
          created: [],
          reason: `collection ${stem} is sealed: seal green = set complete (§11.1)`,
        };
      }

      // §18: every emitted element must satisfy the collection's declared schema.
      // The check is atomic — one bad item accretes nothing and bumps the seal's
      // schema-stall counter — so a producer can't half-fill a collection with
      // malformed members and the run can correct and re-emit on the same lease.
      const schema = step.produces.find((p) => p.kind === 'collection' && p.stem === stem)?.schema;
      if (schema !== undefined) {
        for (let i = 0; i < items.length; i++) {
          const check = validateValue(schema, items[i]!.value);
          if (!check.valid) {
            // The seal is materialized for every collection producer (pendingOwed),
            // so an open `emit` run always has one; its absence is a broken
            // invariant, not a soft path — surface it rather than silently
            // dropping the schema-stall bump and corrupting liveness.
            const seal = arts.get(sealPath(stem));
            if (!seal) throw new Error(`collection seal missing for ${stem}`);
            const text = `schema validation failed (item ${i}): ${summarizeIssues(check.issues)}`;
            this.store.putArtifact({
              ...seal,
              acceptance: 'rejected',
              schemaRejects: seal.schemaRejects + 1,
              reasons: [...seal.reasons, reason('schema-reject', 'validation', 'engine', text, seal.version)],
            });
            this.settle(workflow, def);
            return { outcome: 'schema-rejected', created: [], reason: text, issues: check.issues };
          }
        }
      }

      let next = nextIndex(arts, stem);
      const fp = computeFingerprint(arts, req);
      const created: string[] = [];
      for (const item of items) {
        const p = elementPath(stem, next++);
        this.store.putArtifact({
          workflow,
          path: p,
          producer: r.step,
          acceptance: 'green',
          version: 1,
          value: item.value,
          fingerprint: fp,
          reasons: [],
          judgmentRejects: 0,
          schemaRejects: 0,
	}, { action: 'produced', actor: r.step, reason: 'collection item emitted' });
        created.push(p);
      }
      this.settle(workflow, def);
      return { outcome: 'emitted', created };
    });
    this.fire({ type: 'commit', workflow, run, path: stem, action: 'emit', outcome: result.outcome });
    if (result.outcome === 'born-rejected') {
      this.fire({ type: 'closed', workflow, run, outcome: 'no_work' });
    }
    this.fireSettled(workflow);
    return result;
  }

  /** Green a collection's seal — the producer's "I am done emitting" signal. */
  seal(workflow: string, run: string, value: Record<string, unknown> = {}): CommitResult {
    const def = this.defFor(workflow);
    const result = this.store.tx((): CommitResult => {
      const r = this.openRun(workflow, run);
      const step = this.step(def, r.step);
      const stem = collectionStem(step);
      if (!stem) throw new Error(`step ${r.step} does not produce a collection`);
      const arts = this.artMap(workflow);
      const sealP = sealPath(stem);
      const sealArt = arts.get(sealP);
      if (!sealArt) throw new Error(`no seal artifact for ${stem}`);

      const req = plainConsumes(step).map((c) => c.stem);
      const cas = this.casCheck(arts, req, r.fingerprint ?? {});
      if (cas.moved) {
        this.bornReject(sealArt, cas.moved);
        this.releaseLeaseOnBornReject(workflow, run);
        this.settle(workflow, def);
        return { path: sealP, outcome: 'born-rejected', reason: cas.reason };
      }
      this.store.putArtifact({
        ...sealArt,
        acceptance: 'green',
        version: sealArt.version + 1,
        value,
        fingerprint: computeFingerprint(arts, req),
      }, { action: 'sealed', actor: r.step, reason: 'collection sealed' });
      this.settle(workflow, def);
      return { path: sealP, outcome: 'green' };
    });
    this.fire({ type: 'commit', workflow, run, path: result.path, action: 'seal', outcome: result.outcome });
    if (result.outcome === 'born-rejected') {
      this.fire({ type: 'closed', workflow, run, outcome: 'no_work' });
    }
    this.fireSettled(workflow);
    return result;
  }

  // ---- consumer invalidation -------------------------------------------------

  /**
   * Judgment reject (§4): a consumer says "fix it". Re-arms the producer.
   *
   * §24 §4.6: when `by` names a judge step, this is a judge *verdict*, not an
   * ordinary consumer invalidation — it must pass through the same
   * `judgeCasCheck` staleness guard as a judge's `green()` approve (§24.4).
   * Without it, a judge order that outlives a sibling judge's reject, a
   * human bypass, or a producer resubmit could land its stale reject on an
   * unrelated newer submission: double-bumping `judgmentRejects` and wiping
   * that newer submission's in-progress approval ledger. `reject()` has no
   * `run` parameter (unlike `green`) — it is step-scoped, not run-scoped, by
   * design (§4.1: authority follows the consume edge, keyed by actor name) —
   * so the fingerprint to CAS against is looked up via the task table's
   * *currently claimed* run for the judge step (`by`), the same lease record
   * `openRun` consults. This catches every case in §4.6 (producer resubmit, a
   * sibling judge's reject, a human bypass) because each moves the judged
   * stem off `submitted`. It does not (and structurally cannot, without a
   * `run` id on this verb) distinguish two *different* runs of the *same*
   * judge step racing on the *same* still-submitted version — e.g. a reaped
   * order's late reject arriving after its own task was re-claimed by a
   * fresh run. That narrower race predates this fix and is out of scope here.
   * See `docs/design.md` §24.9 for the full writeup and operator mitigations
   * (`parallel: 1`, a generous `reapTtl:` on slow judge steps).
   */
  reject(workflow: string, path: string, by: Author, text: string): { outcome: 'rejected' | 'born-rejected'; reason?: string } {
    const def = this.defFor(workflow);
    this.assertAuthority(def, by, path, 'reject');

    // F4: a reject on an artifact produced by a `calls:` step is a verdict on
    // the CHILD's work, not the parent's own — forward it. Detection: the
    // producing step declares `calls:`. The child is resolved via the
    // parent→child reverse index (store.findChildByParent); if no child was
    // ever spawned there is nothing to judge, so refuse (consistent with the
    // verb-guard rule below that a verdict needs a built version).
    const producingStep = def.steps.find((s) => s.produces.some((p) => p.stem === path));
    if (producingStep?.calls) {
      return this.rejectCallsArtifact(workflow, def, producingStep, path, by, text);
    }

    const judgeStep = def.steps.find((s) => s.name === by);
    const judgedStem = judgeStep?.judges;
    let releasedRun: string | undefined;

    const result = this.store.tx((): { outcome: 'rejected' | 'born-rejected'; reason?: string } => {
      const art = this.store.getArtifact(workflow, path);
      if (!art) throw new Error(`cannot reject unknown artifact: ${path}`);

      if (judgedStem !== undefined) {
        // A judge's reject targets the judged stem, mirroring green()'s
        // judge-approve branch (§24.4): CAS-guard against a stale verdict
        // before applying it.
        const task = this.store.getTask(workflow, by, '');
        const run = task?.run ? this.store.getRun(task.run) : undefined;
        const cas = this.judgeCasCheck(art, judgedStem, run?.fingerprint ?? {});
        if (cas.moved) {
          if (task?.run) {
            this.releaseLeaseOnBornReject(workflow, task.run);
            releasedRun = task.run;
          }
          this.settle(workflow, def);
          return { outcome: 'born-rejected', reason: cas.reason };
        }
      }

      // §6: a judgment verdict is about a *produced* version (design §6) — refuse
      // a reject on anything that isn't currently a build (`green`) or awaiting
      // verdict (`submitted`). Two concrete wedges this closes: rejecting a
      // never-built `owed` artifact would burn a judgmentRejects toward the §6
      // stall cap with zero build attempts (a silent freeze — the producer side
      // never re-offers past the cap); rejecting a terminal `retracted` collection
      // member would flip a dead member back to a live `rejected` debt, but no
      // firing shape can ever rebuild a bare collection element (§11.3: retracted
      // is terminal, out of the live set), so the instance wedges permanently.
      // The judge-CAS branch above already guarantees `submitted` for judge
      // verdicts that reach here (a stale one already returned born-rejected),
      // so this only bites the plain/human reject path in practice.
      if (art.acceptance !== 'green' && art.acceptance !== 'submitted') {
        throw new Error(
          `cannot reject '${path}' in state '${art.acceptance}': a verdict requires a built version (green|submitted)`,
        );
      }

      // §24 §3.1/§4.4: a judge reject (or a human reject on a `submitted`
      // artifact) is a quality verdict, not a cascade invalidation — it wins
      // immediately regardless of any other judge's already-recorded approval,
      // bumps `judgmentRejects` exactly once for this submission (this call IS
      // that one verdict — the artifact leaves `submitted` right after, so no
      // other judge's reject can double-count it), and clears the now-moot
      // sign-off ledger so a rebuilt/resubmitted artifact is judged fresh.
      this.store.putArtifact({
        ...art,
        acceptance: 'rejected',
        judgmentRejects: art.judgmentRejects + 1,
        approvals: undefined,
        reasons: [...art.reasons, reason('reject', 'judgment', by, text, art.version)],
      });
      this.settle(workflow, def);
      return { outcome: 'rejected' };
    });
    this.fire({
      type: 'commit',
      workflow,
      path,
      action: 'reject',
      ...(result.outcome === 'born-rejected' ? { outcome: 'born-rejected' as const } : {}),
    });
    if (result.outcome === 'born-rejected' && releasedRun !== undefined) {
      this.fire({ type: 'closed', workflow, run: releasedRun, outcome: 'no_work' });
    }
    this.fireSettled(workflow);
    return result;
  }

  /**
   * F4: forward a reject on a `calls:`-produced artifact to the CHILD's
   * outcome artifact, then reopen the parent calls artifact to `owed` pinned
   * (via `childOutcomePin`) to the just-rejected child outcome version, so
   * STEP 6's mirror only fires again once the child has actually rebuilt past
   * this verdict (§ F4 settled design).
   *
   * The forward is engine-internal: authority was already checked against the
   * PARENT def by `assertAuthority` in `reject()` above, so the child's own
   * `assertAuthority` is not consulted — the author recorded on the child's
   * reasons entry is `parent:<by>` to make the indirection visible in its
   * audit thread.
   */
  private rejectCallsArtifact(
    parentWf: string,
    def: WorkflowDef,
    producingStep: StepDef,
    callsStem: string,
    by: Author,
    text: string,
  ): { outcome: 'rejected' | 'born-rejected'; reason?: string } {
    const child = this.store.findChildByParent(parentWf, callsStem);
    if (!child) {
      throw new Error(
        `cannot reject '${callsStem}': no child instance has been spawned yet (a verdict requires a built version)`,
      );
    }
    const childDef = this.defFor(child.id);
    const childOutcomeStem = childDef.outputs![0]!;

    this.store.tx(() => {
      const parentArt = this.store.getArtifact(parentWf, callsStem);
      if (!parentArt) throw new Error(`cannot reject unknown artifact: ${callsStem}`);
      if (parentArt.acceptance !== 'green' && parentArt.acceptance !== 'submitted') {
        throw new Error(
          `cannot reject '${callsStem}' in state '${parentArt.acceptance}': a verdict requires a built version (green|submitted)`,
        );
      }

      const childArt = this.store.getArtifact(child.id, childOutcomeStem);
      if (!childArt) throw new Error(`cannot reject '${callsStem}': child outcome artifact missing`);

      // Child outcome → rejected, judgmentRejects+1, author `parent:<by>`.
      this.store.putArtifact({
        ...childArt,
        acceptance: 'rejected',
        judgmentRejects: childArt.judgmentRejects + 1,
        approvals: undefined,
        reasons: [...childArt.reasons, reason('reject', 'judgment', `parent:${by}` as Author, text, childArt.version)],
      });
      this.settle(child.id, childDef);

      // Parent calls artifact → reopened to owed (not left rejected), pinned
      // to the just-rejected child outcome version.
      this.store.putArtifact({
        ...parentArt,
        acceptance: 'owed',
        fingerprint: { ...(parentArt.fingerprint ?? {}), [Engine.CHILD_OUTCOME_PIN_KEY]: childArt.version },
        reasons: [
          ...parentArt.reasons,
          {
            at: nowMs(),
            action: 'reopen' as const,
            kind: 'structural' as const,
            by: 'engine' as const,
            text: `reject forwarded to child outcome '${childOutcomeStem}': ${text}`,
            fromVersion: parentArt.version,
          },
        ],
      });
      this.settle(parentWf, def);
    });
    this.fire({ type: 'commit', workflow: parentWf, path: callsStem, action: 'reject' });
    this.fireSettled(parentWf);
    // The child's own firings (re-arming its producer with the feedback on
    // its owes thread) need tick(child) — not driven from here; see docs/design.md
    // M2/M2B "sweeping" note. Prompt maintainCalls now so the parent's own
    // state (owed/pin) is visible immediately, mirroring provideInput's cascade.
    this.maintainCalls(parentWf, def);
    return { outcome: 'rejected' };
  }

  /** Retract a collection member (§11.3): drop it, terminally; abandon the index. */
  retract(workflow: string, path: string, by: Author, text: string): void {
    const def = this.defFor(workflow);
    const el = parseElement(path);
    if (!el || el.suffix !== '') throw new Error(`retract is only valid on a collection member: ${path}`);
    // §4.1/§11.3: same authority rule as reject — only a consumer of the member's
    // stem (or human/engine) may drop it. Without this, any string actor name
    // (even one not in the def) could terminally retract a green member of a
    // sealed collection. assertAuthority resolves an element path to its stem
    // via parseElement internally, so `path` (not `el.stem`) is passed straight
    // through, same as reject().
    this.assertAuthority(def, by, path, 'retract');
    this.store.tx(() => {
      const art = this.store.getArtifact(workflow, path);
      if (!art) throw new Error(`cannot retract unknown artifact: ${path}`);
      this.store.putArtifact({
        ...art,
        acceptance: 'retracted',
        reasons: [...art.reasons, reason('retract', 'judgment', by, text, art.version)],
      });
      this.settle(workflow, def);
    });
    this.fire({ type: 'commit', workflow, path, action: 'retract' });
    this.fireSettled(workflow);
  }

  /** A producer skips its own owed output on a dead branch (§16.1 routing). */
  skip(workflow: string, path: string, by: Author, text: string): void {
    const def = this.defFor(workflow);
    this.store.tx(() => {
      const arts = this.artMap(workflow);
      const art = arts.get(path);
      if (!art) throw new Error(`cannot skip unknown artifact: ${path}`);
      if (by !== 'human' && by !== art.producer) {
        throw new Error(`only the producer (${art.producer}) may skip ${path}, not ${by}`);
      }
      // Fingerprint the inputs this skip rests on, so the level-trigger only
      // re-arms the branch when those inputs *move* (§16.1), not merely stay green.
      const req = requiredInputs(def, arts, art);
      const fp = computeFingerprint(arts, req);
      // F4: a calls: step declares `consumes: []`, so `req` above never sees
      // its real input — the child outcome, which lives in another instance.
      // Capture the same version pin `childOutcomePin` uses elsewhere, so a
      // skip made on evidence from child version N survives arbitrary ticks
      // (order A) until the child actually rebuilds past N (order B).
      const producingStep = def.steps.find((s) => s.name === art.producer);
      if (producingStep?.calls) {
        const pin = this.childOutcomePin(workflow, path);
        if (pin !== undefined) fp[Engine.CHILD_OUTCOME_PIN_KEY] = pin;
      }
      this.store.putArtifact({
        ...art,
        acceptance: 'skipped',
        fingerprint: fp,
        reasons: [...art.reasons, reason('skip', 'structural', by, text, art.version)],
      });
      this.settle(workflow, def);
    });
    this.fire({ type: 'commit', workflow, path, action: 'skip' });
    this.fireSettled(workflow);
  }

  /**
   * Human stall-clearing lever (§6): reset an artifact's judgment-reject count
   * and re-arm it to `owed`, optionally appending a line of guiding context that
   * rides to the next producer on the order's `owes` thread. This is how a
   * stalled (capped-out) artifact gets unstuck and steered, rather than thrashing
   * forever or being abandoned. For a stuck collection member, `retract` instead.
   */
  retry(workflow: string, path: string, by: Author = 'human', text = 'retry: stall cleared'): void {
    const def = this.defFor(workflow);
    // §4.1: same authority rule as reject/retract — only a consumer of the
    // stem (or human/engine) may re-arm it.
    this.assertAuthority(def, by, path, 'retry');
    this.store.tx(() => {
      const art = this.store.getArtifact(workflow, path);
      if (!art) throw new Error(`cannot retry unknown artifact: ${path}`);
      // §11.3: retry re-arms to `owed`, but a bare collection element that has
      // been retracted has no producer firing that can ever rebuild it — retry
      // would resurrect a terminally-dropped member into a guaranteed wedge.
      // `retract` is final by design; every other state (rejected, stalled,
      // skipped, green) stays a legal retry target.
      if (art.acceptance === 'retracted') {
        throw new Error(`cannot retry '${path}': it was retracted, which is terminal (use a fresh collection element instead)`);
      }
      this.store.putArtifact({
        ...art,
        acceptance: 'owed',
        judgmentRejects: 0,
        schemaRejects: 0,
        // §24 §4.11: a retry after a judge-reject stall clears the sign-off
        // ledger along with the counters, so the rebuilt artifact is judged
        // fresh rather than inheriting stale approvals from the stalled round.
        approvals: undefined,
        reasons: [...art.reasons, reason('retry', 'structural', by, text, art.version)],
      });
      this.settle(workflow, def);
    });
    this.fire({ type: 'commit', workflow, path, action: 'retry' });
    this.fireSettled(workflow);
  }

  // ---- run lifecycle ---------------------------------------------------------

  /** Close a run (audit/budget) and release its lease so the task can re-arm. */
  close(workflow: string, run: string, outcome: 'ok' | 'no_work' | 'failed' | 'skipped' = 'ok', summary?: string): void {
    this.store.tx(() => {
      const r = this.store.getRun(run);
      if (!r) throw new Error(`no such run: ${run}`);
      const patch: { outcome: 'ok' | 'no_work' | 'failed' | 'skipped'; summary?: string } = { outcome };
      if (summary !== undefined) patch.summary = summary;
      this.store.updateRun(run, patch);
      const task = this.store.getTask(workflow, r.step, r.key ?? '');
      if (task && task.status === 'claimed' && task.run === run) {
        this.store.putTask({
          workflow,
          step: r.step,
          key: r.key ?? '',
          status: 'idle',
          attempts: task.attempts,
          ...(task.alarmAt !== undefined ? { alarmAt: task.alarmAt } : {}),
        });
      }
    });
    // Closing releases a lease; it touches no artifact state, so there is no
    // forward cascade and no `settled` to derive — just the lifecycle signal.
    this.fire({ type: 'closed', workflow, run, outcome });
    // M2B cascade-up prompt: closing a run may advance the child's artifact state.
    this.triggerParentIfChild(workflow);
  }

  /**
   * Touch the liveness timestamp on an open run's task. A run that periodically
   * calls heartbeat() will never be falsely reaped as long as beats arrive within
   * the effective TTL — EXCEPT (A3) when a max-lease cap is CONFIGURED and total
   * lifetime since the original claim exceeds it: past `claimedAt + maxLease` the
   * read-side freshness predicate (`isClaimFresh`) reports the lease stale no
   * matter how recent the beat, so a wedged-but-beating run is reaped and
   * re-claimable. With no cap configured (the default) beats extend the lease
   * indefinitely. This write stays dumb — it only records `heartbeatAt`; the
   * clamp is judged on read. Throws (via openRun) if the run no longer holds its
   * lease.
   */
  heartbeat(workflow: string, run: string, now?: number): void {
    const ts = now ?? nowMs();
    this.store.tx(() => {
      // openRun enforces: exists, not closed, task.run === run
      const r = this.openRun(workflow, run);
      this.store.touchHeartbeat(workflow, r.step, r.key ?? '', ts);
    });
  }

  /** Release stranded leases (claimed by a dead/closed run, or past the TTL). */
  reap(workflow: string, now = nowMs(), def?: WorkflowDef): number {
    return this.reapDetailed(workflow, now, def).count;
  }

  /**
   * Same lease-cleanup loop `reap()` runs, but reports what it reaped and
   * accepts a `ttlOverride` so `reap --now` (admin stand-down) can force every
   * claim stale without perturbing the `now` clock (which would also skew any
   * future cadence/budget math sharing this helper).
   */
  private reapDetailed(
    workflow: string,
    now: number,
    def?: WorkflowDef,
    opts: { ttlOverride?: number } = {},
  ): { count: number; details: ReapDetail[] } {
    const resolvedDef = def ?? this.defFor(workflow);
    let n = 0;
    const details: ReapDetail[] = [];
    for (const task of this.store.listTasks(workflow)) {
      if (task.status !== 'claimed') continue;
      const run = task.run ? this.store.getRun(task.run) : undefined;
      const stepDef = resolvedDef.steps.find((l) => l.name === task.step);
      const realTtl = this.effectiveTtl(stepDef);
      const maxLease = this.effectiveMaxLease(stepDef);
      // Classify why (if at all) this claim is stranded, in the same precedence
      // order the disjunction has always evaluated: run-missing, then run-closed,
      // then a liveness failure. The stranding DECISION honors ttlOverride (so
      // `reap --now` forces even a fresh claim stale), but the reported REASON is
      // computed under the REAL ttl — a lease that was fresh under real rules and
      // only cleared by the override reports `forced`, not a misleading liveness
      // reason (§ CLI reap --now).
      let reason: ReapReason | undefined;
      if (!run) {
        reason = 'run-missing';
      } else if (run.outcome !== undefined) {
        reason = 'run-closed';
      } else if (task.claimedAt !== undefined) {
        const effTtl = opts.ttlOverride ?? realTtl;
        if (this.staleness(task, now, effTtl, maxLease) !== 'fresh') {
          const realReason = this.staleness(task, now, realTtl, maxLease);
          reason = realReason === 'fresh' ? 'forced' : realReason;
        }
      }
      if (reason !== undefined) {
        this.store.putTask({
          workflow,
          step: task.step,
          key: task.key,
          status: 'idle',
          attempts: task.attempts + 1,
          ...(task.alarmAt !== undefined ? { alarmAt: task.alarmAt } : {}),
        });
        n++;
        const detail: ReapDetail = { step: task.step, key: task.key, reason };
        if (task.run !== undefined) detail.run = task.run;
        details.push(detail);
      }
    }
    return { count: n, details };
  }

  /**
   * Deliberately run the reaper outside a full `tick` (no maintain/eligibility/
   * claim cycle — `calls:` child maintenance is intentionally untouched here,
   * keeping this scoped to lease cleanup only). `opts.ttlOverride: 0` is the
   * admin stand-down: it forces every claim stale regardless of its real TTL,
   * for clearing a dead worker's lease by hand. Runs inside a transaction like
   * every other mutating engine method, since it writes task rows.
   */
  reapWithDetails(
    workflow: string,
    now = nowMs(),
    def?: WorkflowDef,
    opts: { ttlOverride?: number } = {},
  ): { count: number; details: ReapDetail[] } {
    return this.store.tx(() => this.reapDetailed(workflow, now, def, opts));
  }

  // ---- observability ---------------------------------------------------------

  status(workflow: string): EngineWorkflowStatus {
    const wf = this.store.getWorkflow(workflow);
    if (!wf) throw new Error(`no such workflow instance: ${workflow}`);
    const def = this.defFor(workflow);
    const arts = this.artMap(workflow);
    const st: EngineWorkflowStatus = workflowStatus(def, arts);
    // Enrich each debt with its producer's crash-step signal (the run log; the
    // pure layer has no store). A map-step producer fires once per element, its
    // run keyed by the consumed element path (e.g. "gather.source[0]"); a
    // plain/reduce producer fires with key "". Recover that firing key from the
    // debt's path so the streak is counted per element, not collapsed to "".
    for (const d of st.debts) {
      const a = arts.get(d.path);
      if (!a) continue;
      const el = parseElement(a.path);
      const key = el ? elementPath(el.stem, el.index) : '';
      const fr = this.store.recentFailedRuns(workflow, a.producer, key);
      if (fr > 0) d.failedRuns = fr;
      // NEW: surface per-step attempts (lease-churn count)
      const task = this.store.getTask(workflow, a.producer, key);
      if (task && task.attempts > 0) d.attempts = task.attempts;
    }
    // §23.6.8: surface a `calls:` child on each unpaid calls debt so a stalled
    // descendant is visible from the root. Walk the debts again: a debt whose
    // path is a calls: step's produced stem, with a spawned child, gets a
    // recursive child summary (all instance-crossing logic stays here, in the
    // engine — the pure workflowStatus never touches another instance).
    for (const d of st.debts) {
      const callsStep = def.steps.find((s) => s.calls && s.produces[0]!.stem === d.path);
      if (!callsStep) continue;
      const child = this.store.findChildByParent(workflow, d.path);
      if (!child) continue;
      const summary = this.childStatusSummary(child.id, new Set());
      if (summary !== undefined) d.child = summary;
    }
    // §28: informational drift flag — compare the currently-loaded live def
    // for this instance's def NAME against the pinned snapshot's hash. Only
    // meaningful when a pin exists; only computable when the live def still
    // resolves (it may have been deleted/renamed since the instance was
    // pinned — that must not make `status` throw for a pinned instance that
    // no longer needs the live def to keep running).
    if (wf.defSnapshot !== undefined) {
      let live: WorkflowDef | undefined;
      try {
        live = this.resolveDef(wf.def);
      } catch {
        live = undefined;
      }
      if (live !== undefined) {
        const pinnedHash = wf.defHash ?? hashDef(wf.defSnapshot);
        st.defDrift = hashDef(live) !== pinnedHash;
      }
    }
    // NEW: surface in-flight (claimed) tasks — same enrichment pattern as the
    // debts loop above, since this needs the task table and the pure
    // workflowStatus() has no store access.
    const now = nowMs();
    for (const task of this.store.listTasks(workflow)) {
      if (task.status !== 'claimed') continue;
      const entry: WorkflowStatus['inFlight'][number] = { step: task.step, key: task.key, attempts: task.attempts };
      if (task.run !== undefined) entry.run = task.run;
      if (task.claimedAt !== undefined) entry.claimedAt = task.claimedAt;
      if (task.heartbeatAt !== undefined) entry.heartbeatAt = task.heartbeatAt;
      if (task.claimedAt !== undefined) entry.claimAgeMs = now - task.claimedAt;
      if (task.heartbeatAt !== undefined) entry.heartbeatAgeMs = now - task.heartbeatAt;
      st.inFlight.push(entry);
    }
    return st;
  }

  // ---- alarm API (E-SETALARM / E-DUE) ----------------------------------------

  /** Set a persistent alarm for an idle evaluator step. Survives restart. */
  setAlarm(workflow: string, step: string, at: number): void {
    this.store.setAlarm(workflow, step, at);
  }

  /** Clear the alarm for an idle evaluator step. */
  clearAlarm(workflow: string, step: string): void {
    this.store.clearAlarm(workflow, step);
  }

  /**
   * Returns the earliest pending time-trigger among idle evaluators for this workflow,
   * and whether it is due at `now`. Used by an external scheduler to decide when to
   * wake this instance.
   */
  nextAlarm(workflow: string, opts: { now?: number } = {}): { dueAt: number | null; isDue: boolean } {
    const now = opts.now ?? nowMs();
    const def = this.defFor(workflow);
    const lastProgressMs = this.store.lastProgressMs(workflow);
    let earliest: number | null = null;

    for (const step of def.steps) {
      if (!step.on?.includes('idle')) continue;
      const alarmAt = this.store.getAlarm(workflow, step.name);
      const threshold = alarmAt ?? (lastProgressMs + (step.idleAfterMs ?? 0));
      if (earliest === null || threshold < earliest) earliest = threshold;
    }

    return {
      dueAt: earliest,
      isDue: earliest !== null && now >= earliest,
    };
  }

  // ---- internals -------------------------------------------------------------

  /**
   * Deliver `event` to every subscriber synchronously, in registration order.
   * The set is snapshotted so a listener that (un)subscribes mid-dispatch does
   * not mutate the step. A throwing listener is isolated — its error is routed
   * to `onListenerError` (default: swallowed) and never rethrown — so one bad
   * subscriber can neither roll back the already-committed write nor starve its
   * siblings. A no-subscriber engine short-circuits to zero cost.
   */
  private fire(event: EngineEvent): void {
    if (this.listeners.size === 0) return;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        this.onListenerError?.(err, event);
      }
    }
  }

  /**
   * Emit the post-commit `settled` event — `done` plus the eligible step names,
   * the no-poll signal a host watches to decide whether to re-`tick`. Guarded on
   * having a listener: deriving it runs a full `workflowStatus` artifact scan, so
   * a subscriber-free engine (the CLI and every non-observing caller) must pay
   * nothing — the hook stays strictly additive. Called only after a verb's tx has
   * committed (and thus already settled), so the read reflects the fixpoint.
   */
  private fireSettled(workflow: string): void {
    if (this.listeners.size === 0) return;
    const def = this.defFor(workflow);
    const arts = this.artMap(workflow);
    const st = workflowStatus(def, arts);
    this.fire({ type: 'settled', workflow, done: st.done, eligible: st.eligible.map((e) => e.step) });
  }

  /** Compute the TimeFacts bag for idle eligibility from the current store state. */
  private computeTimeFacts(
    def: WorkflowDef,
    workflow: string,
    arts: ArtifactMap,
    now: number,
  ): TimeFacts {
    const lastProgressMs = this.store.lastProgressMs(workflow);
    const inFlight = this.isInFlight(workflow, now, def);
    const alarms = new Map<string, number>();
    for (const step of def.steps) {
      if (!step.on?.includes('idle')) continue;
      const alarmAt = this.store.getAlarm(workflow, step.name);
      if (alarmAt !== undefined) alarms.set(step.name, alarmAt);
    }
    void arts; // arts not needed here but passed for consistency
    return { now, lastProgressMs, inFlight, alarms };
  }

  /** Returns true if any fresh claimed task exists for this workflow. */
  private isInFlight(workflow: string, now: number, def: WorkflowDef): boolean {
    for (const task of this.store.listTasks(workflow)) {
      if (task.status !== 'claimed') continue;
      const run = task.run ? this.store.getRun(task.run) : undefined;
      const stepDef = def.steps.find((l) => l.name === task.step);
      const ttl = this.effectiveTtl(stepDef);
      const maxLease = this.effectiveMaxLease(stepDef);
      const fresh =
        !!run &&
        run.outcome === undefined &&
        (task.claimedAt === undefined || this.isClaimFresh(task, now, ttl, maxLease));
      if (fresh) return true;
    }
    return false;
  }

  /** Compute the earliest pending idle time-trigger (ms epoch), or null. */
  private computeDueAt(def: WorkflowDef, workflow: string, now: number): number | null {
    const lastProgressMs = this.store.lastProgressMs(workflow);
    let earliest: number | null = null;
    for (const step of def.steps) {
      if (!step.on?.includes('idle')) continue;
      const alarmAt = this.store.getAlarm(workflow, step.name);
      const threshold = alarmAt ?? (lastProgressMs + (step.idleAfterMs ?? 0));
      if (earliest === null || threshold < earliest) earliest = threshold;
    }
    void now; // for future use (filtering due vs pending)
    return earliest;
  }

  /** Materialize owed outputs + run the cascade to a fixpoint (inside a tx). */
  private settle(workflow: string, def: WorkflowDef, now?: number): void {
    const limit = 1000;
    for (let i = 0; i < limit; i++) {
      let arts = this.artMap(workflow);
      const owed = pendingOwed(def, arts);
      for (const a of owed) this.store.putArtifact({ ...a, workflow }, {
	action: 'owed', actor: 'engine', reason: 'artifact became owed',
      });
      if (owed.length) arts = this.artMap(workflow);

      // Only pass TimeFacts when we have a clock reading (tick path).
      // Non-tick settles (green, reject, etc.) never trigger idle re-arm.
      let timeFacts: TimeFacts | undefined;
      if (now !== undefined) {
        timeFacts = this.computeTimeFacts(def, workflow, arts, now);
      }

      const ops = maintainDecisions(def, arts, timeFacts);
      for (const op of ops) this.applyOp(workflow, def, arts, op);

      if (owed.length === 0 && ops.length === 0) return;
    }
    throw new Error(`settle did not converge for ${workflow} (possible cascade cycle)`);
  }

  private applyOp(workflow: string, def: WorkflowDef, arts: ArtifactMap, op: CascadeOp): void {
    if (op.kind === 'arm') {
      const handlerStep = def.steps.find((l) => l.name === op.handlerStep);
      if (!handlerStep) return;
      // Singleton outputs
      for (const p of handlerStep.produces.filter((pp) => pp.kind === 'singleton')) {
        const existing = arts.get(p.stem);
        if (!existing) {
          this.store.putArtifact({
            workflow,
            path: p.stem,
            producer: handlerStep.name,
            acceptance: 'owed',
            version: 0,
            reasons: [reason('reopen', 'structural', 'engine', op.reason, 0)],
            judgmentRejects: 0,
            schemaRejects: 0,
          });
        } else if (existing.acceptance === 'green') {
          // Re-arm: H fired before; re-invalidation re-arms it.
          this.store.putArtifact({
            ...existing,
            acceptance: 'owed',
            reasons: [...existing.reasons, reason('reopen', 'structural', 'engine', op.reason, existing.version)],
          });
        }
        // owed/rejected: already a debt, no change.
      }
      // Collection seals
      for (const p of handlerStep.produces.filter((pp) => pp.kind === 'collection')) {
        const sealKey = p.stem + '.sealed';
        const existing = arts.get(sealKey);
        if (!existing) {
          this.store.putArtifact({
            workflow,
            path: sealKey,
            producer: handlerStep.name,
            acceptance: 'owed',
            version: 0,
            reasons: [reason('reopen', 'structural', 'engine', op.reason, 0)],
            judgmentRejects: 0,
            schemaRejects: 0,
            sealOf: p.stem,
          });
        } else if (existing.acceptance === 'green') {
          this.store.putArtifact({
            ...existing,
            acceptance: 'owed',
            reasons: [...existing.reasons, reason('reopen', 'structural', 'engine', op.reason, existing.version)],
          });
        }
      }
      return;
    }
    const art = arts.get(op.path);
    if (!art) return;
    if (op.kind === 'rearm') {
      this.store.putArtifact({
        ...art,
        acceptance: 'owed',
        reasons: [...art.reasons, reason('reopen', 'structural', 'engine', op.reason, art.version)],
      });
      return;
    }
    if (op.kind === 'skip') {
      // A cascade-skip down a dead subtree carries a fingerprint too, so it
      // re-arms when the upstream branch revives (mirrors a producer skip).
      // §26: an auto-skip of a losing group sibling tags rejectKind 'exclusive'
      // instead of the default 'structural' (op.rejectKind carries this).
      // §26.2: if the skipped sibling was `submitted` (awaiting judgment), it
      // may be carrying a partial approvals sign-off — clear it the same way
      // a cascade reject does (§24 §4.3), so a stale sign-off never leaks onto
      // a later resubmission if the winner is un-greened and the branch revives.
      const clearApprovals = art.acceptance === 'submitted' && art.approvals !== undefined;
      this.store.putArtifact({
        ...art,
        acceptance: 'skipped',
        ...(clearApprovals ? { approvals: undefined } : {}),
        fingerprint: computeFingerprint(arts, requiredInputs(def, arts, art)),
        reasons: [...art.reasons, reason('skip', op.rejectKind ?? 'structural', 'engine', op.reason, art.version)],
      });
      return;
    }
    if (op.kind === 'pin') {
      // Pin: artifact stays green; fingerprint re-pointed to current input versions.
      // Does NOT change acceptance, does NOT bump version, does NOT reset stall counters.
      const req = requiredInputs(def, arts, art);
      this.store.putArtifact({
        ...art,
        fingerprint: computeFingerprint(arts, req),
        reasons: [...art.reasons, reason('pinned', 'structural', 'engine', op.reason, art.version)],
      });
      return;
    }
    const acceptance = op.kind === 'reject' ? 'rejected' : 'retracted';
    const action: ReasonAction = op.kind === 'reject' ? 'reject' : 'retract';
    // For held rejects (effect.onInvalidate=escalate), use 'invalidated-irreversible' kind
    // so isHeld() can detect them and suppress auto-re-eligibility.
    const rejectKind = op.kind === 'reject' && op.held ? 'invalidated-irreversible' : 'structural';
    // §24 §4.3: a cascade reject discards any pending/completed judge verdict on
    // the now-stale value — clear the sign-off ledger (the version-keyed check in
    // eligibleFirings would ignore stale entries anyway; clearing keeps state honest).
    const clearApprovals = art.acceptance === 'submitted' && art.approvals !== undefined;
    this.store.putArtifact({
      ...art,
      acceptance,
      ...(clearApprovals ? { approvals: undefined } : {}),
      reasons: [...art.reasons, reason(action, rejectKind, 'engine', op.reason, art.version)],
    });
  }

  /**
   * §12.2 born-reject lease release: close the run (`no_work`) and re-arm its
   * task to `idle` so the firing is immediately re-claimable next tick. Runs
   * inside the caller's open tx (plain store write, no nested tx). Unlike reap()
   * it does NOT bump attempts — a CAS-stale born-reject is not lease churn. The
   * `closed` event is fired by the caller AFTER the tx commits (post-commit
   * ordering), matching public close().
   */
  private releaseLeaseOnBornReject(workflow: string, run: string): void {
    this.store.updateRun(run, { outcome: 'no_work' });
    const r = this.store.getRun(run);
    if (!r) return;
    const task = this.store.getTask(workflow, r.step, r.key ?? '');
    if (task && task.status === 'claimed' && task.run === run) {
      this.store.putTask({
        workflow,
        step: r.step,
        key: r.key ?? '',
        status: 'idle',
        attempts: task.attempts,
        ...(task.alarmAt !== undefined ? { alarmAt: task.alarmAt } : {}),
      });
    }
  }

  private bornReject(art: ArtifactData, movedPath: string): void {
    this.store.putArtifact({
      ...art,
      acceptance: 'rejected',
      reasons: [
        ...art.reasons,
        reason('born-rejected', 'structural', 'engine', `born-rejected: ${movedPath} moved during this run`, art.version),
      ],
    });
  }

  /** Returns the path of a moved/non-green input, or {moved: undefined} if the CAS holds. */
  private casCheck(
    arts: ArtifactMap,
    req: string[],
    fp: Record<string, number>,
  ): { moved?: string; reason?: string } {
    for (const p of req) {
      if (!isGreen(arts.get(p))) return { moved: p, reason: `${p} is not green at commit` };
    }
    if (!fingerprintMatches(arts, req, fp)) {
      const moved = req.find((p) => (arts.get(p)?.version ?? -1) !== fp[p]) ?? req[0] ?? 'inputs';
      return { moved, reason: `${moved} moved version during this run` };
    }
    return {};
  }

  /**
   * §24/§4.6: the judge-commit variant of `casCheck`. A judge doesn't gate on
   * its *inputs* being green (it consumes the judged stem while that stem is
   * `submitted`, not green) — it gates on the judged stem still being
   * `submitted` **at the version the judge's run fingerprinted at claim time**.
   * If the producer resubmitted (new version) or a human/other judge already
   * settled it (moved off `submitted`) while this judge's order was in flight,
   * the stale verdict is refused — the judge simply re-fires on the fresh state.
   */
  private judgeCasCheck(
    judged: ArtifactData | undefined,
    judgedStem: string,
    fp: Record<string, number>,
  ): { moved?: string; reason?: string } {
    if (!judged || judged.acceptance !== 'submitted') {
      return { moved: judgedStem, reason: `${judgedStem} is not submitted at commit` };
    }
    const fpVersion = fp[judgedStem];
    if (fpVersion !== undefined && judged.version !== fpVersion) {
      return { moved: judgedStem, reason: `${judgedStem} moved version during this run` };
    }
    return {};
  }

  /**
   * §26: refuse a commit that would violate its produce-group's exclusivity
   * contract. Only `exactlyOne`/`atMostOne` groups gate at commit time (an
   * `atLeastOne` group never refuses — any number of members may be green).
   * Looks up the group by scanning the artifact's producer step's `groups:`
   * for one whose `of:` contains this stem; refuses iff a *different* sibling
   * in that group is already `green`. A sibling that is merely owed/rejected
   * is not a conflict — this artifact would simply become the group's winner.
   */
  private groupCasCheck(
    def: WorkflowDef,
    arts: ArtifactMap,
    art: ArtifactData,
  ): { rejected: boolean; reason?: string } {
    const winner = groupBlockingWinner(def, arts, art.path);
    if (winner === undefined) return { rejected: false };
    const producer = def.steps.find((l) => l.name === art.producer);
    const group = producer?.groups?.find((g) => g.of.includes(art.path))!; // safe: winner defined implies group found
    return {
      rejected: true,
      reason: `group '${group.group}' (${group.mode}) already has a winner: '${winner}' is green`,
    };
  }

  private artMap(workflow: string): Map<string, ArtifactData> {
    const m = new Map<string, ArtifactData>();
    for (const a of this.store.listArtifacts(workflow)) m.set(a.path, a);
    return m;
  }

  /**
   * §23.6.8: a compact summary of a `calls:` child for parent-status enrichment.
   * Uses the pure `workflowStatus` for the child's own debts (lighter than a
   * full recursive `Engine.status` — the `stalled` flag is already set by the
   * pure layer). `stalled` propagates recursively along the child's OWN unpaid
   * `calls:` path so a grandchild stall shows as `stalled: true` here. `debts`
   * is a COUNT — the `workflow` id is the human's inspection handle. `visited`
   * guards against any accidental instance cycle.
   *
   * Returns `undefined` when the child's def is unresolvable (an unpinned row
   * whose def was deleted/renamed) — practically unreachable since `calls:`
   * spawns pin (§28), but a summary is enrichment, and enrichment must not
   * make `status(parent)` throw (same stance as the §28 drift flag).
   */
  private childStatusSummary(childWf: string, visited: Set<string>): ChildStatusSummary | undefined {
    visited.add(childWf);
    let childDef: WorkflowDef;
    try {
      childDef = this.defFor(childWf);
    } catch {
      return undefined;
    }
    const childArts = this.artMap(childWf);
    const cs = workflowStatus(childDef, childArts);
    let stalled = cs.debts.some((d) => d.stalled);
    if (!stalled) {
      for (const d of cs.debts) {
        const callsStep = childDef.steps.find((s) => s.calls && s.produces[0]!.stem === d.path);
        if (!callsStep) continue;
        const grandchild = this.store.findChildByParent(childWf, d.path);
        if (!grandchild || visited.has(grandchild.id)) continue;
        if (this.childStatusSummary(grandchild.id, visited)?.stalled) {
          stalled = true;
          break;
        }
      }
    }
    return { workflow: childWf, def: childDef.name, done: cs.done, stalled, debts: cs.debts.length };
  }

  private defFor(workflow: string): WorkflowDef {
    const wf = this.store.getWorkflow(workflow);
    if (!wf) throw new Error(`no such workflow instance: ${workflow}`);
    // §28: prefer the pinned snapshot taken at create time (or last `adopt`).
    // Rows created before this feature shipped have no snapshot — fall back
    // to today's name-resolution, unchanged. This is the compatibility path,
    // not an error: an un-pinned instance behaves exactly as it always has.
    if (wf.defSnapshot !== undefined) return wf.defSnapshot;
    return this.resolveDef(wf.def);
  }

  private step(def: WorkflowDef, name: string): StepDef {
    const l = def.steps.find((x) => x.name === name);
    if (!l) throw new Error(`no such step in ${def.name}: ${name}`);
    return l;
  }

  /**
   * The JSON Schema (if any) declared for the artifact `art` greened by `green()`
   * — a map child binds to its step's per-element produce, everything else to a
   * singleton produce. Seals/collection elements go through `seal`/`emit` and are
   * not handled here. Returns undefined when no schema is declared (the default).
   */
  private produceSchema(def: WorkflowDef, art: ArtifactData): JsonSchema | undefined {
    const step = def.steps.find((l) => l.name === art.producer);
    if (!step) return undefined;
    const el = parseElement(art.path);
    if (el && el.suffix !== '') {
      const mp = step.produces.find(
        (p) => p.kind === 'map' && p.stem === el.stem && p.suffix === el.suffix,
      );
      return mp?.schema;
    }
    const sp = step.produces.find((p) => p.kind === 'singleton' && p.stem === art.path);
    return sp?.schema;
  }

  /**
   * §24: the declared judge names for `art`'s produce entry, or `[]` if none —
   * `judges:` is only ever valid on a singleton produce (Q3, enforced at parse
   * time), so unlike `produceSchema` there is no map-element case to handle.
   */
  private declaredJudgeNames(def: WorkflowDef, art: ArtifactData): string[] {
    const step = def.steps.find((l) => l.name === art.producer);
    if (!step) return [];
    const sp = step.produces.find((p) => p.kind === 'singleton' && p.stem === art.path);
    return sp?.judges?.map((j) => j.name) ?? [];
  }

  /**
   * Open a run for commit: it must exist, be unclosed, and still hold its lease.
   * The lease check rejects a zombie commit — a run that was reaped (its task
   * re-armed and possibly re-claimed by a newer run) must not green anything.
   */
  private openRun(workflow: string, run: string): ReturnType<Store['getRun']> & object {
    const r = this.store.getRun(run);
    if (!r) throw new Error(`no such run: ${run}`);
    if (r.outcome !== undefined) throw new Error(`run already closed: ${run}`);
    const task = this.store.getTask(workflow, r.step, r.key ?? '');
    if (!task || task.run !== run) {
      throw new Error(`run ${run} no longer holds its lease (reaped or superseded)`);
    }
    return r;
  }

  /**
   * Authority (§4.1): only a step that consumes `path`'s stem (or a human/engine)
   * may judgment-reject it. Consuming is dual-purpose — it is also how a step is
   * granted the right to invalidate an artifact (so a step that must send an
   * artifact back, even one it only judges, must declare it in `consumes`).
   */
  private assertAuthority(def: WorkflowDef, by: Author, path: string, _action: string): void {
    if (by === 'human' || by === 'engine') return;
    const el = parseElement(path);
    const stem = el ? el.stem : path.replace(/\.sealed$/, '');
    const step = def.steps.find((l) => l.name === by);
    if (!step) throw new Error(`unknown actor: ${by}`);

    if (step.judges !== undefined) {
      // §24: a judge may only invalidate the exact stem named in its own
      // `judges:` marker — never a stem it merely consumes for context via
      // `inputs: true` (defs.ts synthesizeJudgeSteps splices the producer's
      // own input stems into a judge's `consumes` for read-only context;
      // that consume edge must grant NO reject authority over those stems).
      if (step.judges !== stem && step.judges !== path) {
        throw new Error(
          `${by} has no authority to invalidate ${path} (it judges \`${step.judges}\`, not \`${stem}\`). ` +
            `A judge may only reject the stem named in its own \`judges:\` marker.`,
        );
      }
      return;
    }

    const consumesIt = step.consumes.some((c) => c.stem === stem || c.stem === path);
    if (!consumesIt) {
      throw new Error(
        `${by} has no authority to invalidate ${path} (it does not consume it). ` +
          `Authority follows the consume edge (§4.1): add \`${stem}\` to ${by}'s \`consumes\` to grant it.`,
      );
    }
  }
}

// ---- helpers -----------------------------------------------------------------

function reason(
  action: ReasonAction,
  kind: RejectKind,
  by: Author,
  text: string,
  fromVersion: number,
): ReasonEntry {
  return { at: nowMs(), action, kind, by, text, fromVersion };
}

function nextIndex(arts: ArtifactMap, stem: string): number {
  let max = -1;
  for (const a of arts.values()) {
    const el = parseElement(a.path);
    if (el && el.stem === stem && el.suffix === '') max = Math.max(max, el.index);
  }
  return max + 1;
}

function substitute(body: string, vars: Record<string, string>): string {
  return body.replace(/\$\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] ?? '' : m));
}

/** M2B: structural deep-equal, order-insensitive on object keys (artifact values are always JSON-shaped). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bObj, k) && deepEqual(aObj[k], bObj[k]));
}
