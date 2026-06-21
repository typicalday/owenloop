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
  isGreen,
  maintainDecisions,
  pendingOwed,
  plainConsumes,
  requiredInputs,
  workflowStatus,
} from './model.ts';
import type { ArtifactMap, CascadeOp, Firing, TimeFacts, WorkflowStatus } from './model.ts';
import { summarizeIssues, validateValue } from './schema.ts';
import type { SchemaIssue } from './schema.ts';
import { localMidnightMs, nowMs, randId } from './util.ts';
import type { Store } from './store.ts';
import type {
  ArtifactData,
  Author,
  JsonSchema,
  LoopDef,
  FiringTrigger,
  ReasonEntry,
  RejectKind,
  ReasonAction,
  WorkflowDef,
} from './types.ts';

const DEFAULT_REAP_TTL_MS = 2 * 60 * 60 * 1000; // 2h

/** A self-contained unit of work emitted by a tick. */
export interface Order {
  run: string;
  workflow: string;
  loop: string;
  key: string;
  index?: number;
  inputs: string[];
  outputs: string[];
  workdir: string;
  model?: string;
  prompt: string;
  /** captured handles of the green inputs this run builds on */
  consumes: Record<string, unknown>;
  /** the owed outputs and their accumulated reason threads (the feedback channel) */
  owes: Array<{
    path: string;
    acceptance: string;
    judgmentRejects: number;
    schemaRejects: number;
    reasons: ReasonEntry[];
  }>;
  /** The trigger that woke this firing (§21). Absent = 'inputsGreen'. */
  cause?: FiringTrigger;
}

/**
 * §tick-deferred: an eligible firing the tick did NOT promote to an order, tagged
 * with why. `'in-flight'` — the loop's task is already claimed by an open run;
 * `'cadence'` — the loop's inter-run gap has not elapsed; `'daily-budget'` — the
 * loop's daily run allowance is exhausted (binding over parallel); `'parallel-cap'`
 * — the loop's concurrency cap is the binding constraint. Always emitted by
 * `applySchedule` or `tick`; never alters which firings are selected or claimed.
 */
export type DeferredReason = 'in-flight' | 'cadence' | 'daily-budget' | 'parallel-cap';

export interface DeferredFiring {
  loop: string;
  key: string;
  index?: number;
  inputs: string[];
  outputs: string[];
  reason: DeferredReason;
}

export interface TickResult {
  workflow: string;
  orders: Order[];
  reaped: number;
  deferred: DeferredFiring[];
  /**
   * The earliest pending time-trigger (ms epoch) among idle evaluators, if any.
   * Absent when the workflow has no idle loops. An external scheduler uses this
   * to decide when to next wake the instance.
   */
  dueAt?: number;
}

export interface CommitResult {
  path: string;
  outcome: 'green' | 'born-rejected' | 'schema-rejected';
  reason?: string;
  /** the schema violations, when `outcome` is `schema-rejected` (§18) */
  issues?: SchemaIssue[];
}

/** The outcome of an `emit` (collection accretion) — possibly schema-refused. */
export interface EmitResult {
  outcome: 'emitted' | 'born-rejected' | 'schema-rejected';
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
  /** Mode 2 foundation: parent-coordinate link for a child instance spawned by a calls: loop. Persisted to store; no other behavior in PR5a. */
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

export class Engine {
  readonly store: Store;
  private readonly resolveDef: DefResolver;
  private readonly reapTtlMs: number;
  private readonly listeners = new Set<EngineListener>();
  private readonly onListenerError?: (err: unknown, event: EngineEvent) => void;
  /** M2B: recursion guard — set of parentWf ids currently inside maintainCalls. */
  private readonly _inMaintainCalls = new Set<string>();

  constructor(
    store: Store,
    resolveDef: DefResolver,
    opts: {
      reapTtlMs?: number;
      /** A listener registered up front, equivalent to a `subscribe` call. */
      onEvent?: EngineListener;
      /** Where a throwing listener's error goes (default: swallowed). */
      onListenerError?: (err: unknown, event: EngineEvent) => void;
    } = {},
  ) {
    this.store = store;
    this.resolveDef = resolveDef;
    this.reapTtlMs = opts.reapTtlMs ?? DEFAULT_REAP_TTL_MS;
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
    this.store.tx(() => {
      const wfData: { def: string; title?: string; params?: Record<string, string> } = { def: defName };
      if (opts.title !== undefined) wfData.title = opts.title;
      if (opts.params !== undefined) wfData.params = opts.params;
      this.store.insertWorkflow(id, wfData, opts.producedBy);

      for (const input of def.inputs) {
        const provided = opts.provide?.[input.name];
        if (provided !== undefined && input.schema !== undefined) {
          const check = validateValue(input.schema, provided);
          if (!check.valid) {
            throw new Error(`input '${input.name}' failed schema: ${summarizeIssues(check.issues)}`);
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
      return id;
    });
    this.fire({ type: 'instance', workflow: id, def: defName });
    this.fireSettled(id);
    return id;
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
          throw new Error(`input '${name}' failed schema: ${summarizeIssues(check.issues)}`);
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
  }

  // ---- Mode 2 calls: child-instance management --------------------------------

  /**
   * M2B: Maintain all `calls:` loops for a parent workflow.
   * Called at the top of tick (outside any tx) and as cascade-up prompt.
   * For each calls: loop: spawn the child if gate is ready and no child exists;
   * re-attach if it exists; re-provide if parent inputs moved; machine-green
   * the parent artifact when the child's declared output is green.
   */
  private maintainCalls(parentWf: string, def: WorkflowDef, now?: number): void {
    if (this._inMaintainCalls.has(parentWf)) return;
    this._inMaintainCalls.add(parentWf);
    try {
      for (const loop of def.loops) {
        if (!loop.calls) continue;

        // STEP 1 — Gather gate stems and check gate readiness.
        const callsStem = loop.produces[0]!.stem; // single produced artifact name
        const callsPath = callsStem;
        const gateStems = Object.values(loop.callsInputs ?? {});
        const parentArts = this.artMap(parentWf);
        const gateReady = gateStems.length === 0 || gateStems.every((s) => isGreen(parentArts.get(s)));
        if (!gateReady) continue;

        // STEP 2 — Look up any existing child via reverse index.
        let existingChild = this.store.findChildByParent(parentWf, callsPath);

        // STEP 3 — SPAWN or RE-ATTACH.
        if (!existingChild) {
          // SPAWN: gate is ready and no child exists yet.
          const seedProvide: Record<string, Record<string, unknown>> = {};
          for (const [childInputName, parentArtifactName] of Object.entries(loop.callsInputs ?? {})) {
            const parentArt = parentArts.get(parentArtifactName);
            if (parentArt?.value !== undefined) seedProvide[childInputName] = parentArt.value;
          }
          const childId = this.createInstance(loop.calls, {
            producedBy: { parentWf, parentPath: callsPath },
            provide: seedProvide,
          });
          existingChild = this.store.getWorkflow(childId);
        }
        // else: RE-ATTACH — existingChild is the already-spawned child; no new spawn.

        if (!existingChild) continue; // defensive: createInstance returned but getWorkflow failed

        // STEP 4 — Read child's declared outcome artifact.
        const childDef = this.resolveDef(existingChild.def);
        const childOutcomeStem = childDef.outputs![0]!; // validated by Phase-2 check
        let childArts = this.artMap(existingChild.id);
        let childOutcomeArt = childArts.get(childOutcomeStem);

        // STEP 5 — RE-PROVIDE if parent gate source moved (M2B-REPROVIDE).
        for (const [childInputName, parentArtifactName] of Object.entries(loop.callsInputs ?? {})) {
          const parentArtNow = parentArts.get(parentArtifactName);
          const childInputArt = childArts.get(childInputName);
          if (parentArtNow?.value !== undefined && !deepEqual(parentArtNow.value, childInputArt?.value)) {
            this.provideInput(existingChild.id, childInputName, parentArtNow.value as Record<string, unknown>);
          }
        }

        // STEP 6 — MACHINE-GREEN or STAY OWED (M2B-CASCADEUP).
        // Re-read after potential re-provide.
        childArts = this.artMap(existingChild.id);
        childOutcomeArt = childArts.get(childOutcomeStem);
        const parentCallsArt = this.store.getArtifact(parentWf, callsStem);

        if (isGreen(childOutcomeArt) && childOutcomeArt?.value !== undefined) {
          const alreadyGreen = isGreen(parentCallsArt);
          const sameValue = alreadyGreen && deepEqual(childOutcomeArt.value, parentCallsArt?.value);
          if (!alreadyGreen || !sameValue) {
            if (!parentCallsArt) continue; // not yet materialized by pendingOwed — skip
            const gateArts = this.artMap(parentWf);
            const fp = computeFingerprint(gateArts, gateStems);
            const next: ArtifactData = {
              ...parentCallsArt,
              acceptance: 'green',
              version: parentCallsArt.version + 1,
              value: childOutcomeArt.value,
              fingerprint: fp,
            };
            // Do NOT set terminal: calls: artifact must be re-armable if gate inputs move.
            this.store.tx(() => {
              this.store.putArtifact({ ...next, workflow: parentWf });
              this.settle(parentWf, def, now);
            });
            this.fire({ type: 'commit', workflow: parentWf, path: callsStem, action: 'provide' });
            this.fireSettled(parentWf);
          }
        } else if (!isGreen(childOutcomeArt) && isGreen(parentCallsArt) && parentCallsArt) {
          // M2B-REARM: child's outcome is no longer green (e.g. re-provide re-armed it)
          // but the parent calls: artifact is still green. Re-arm it to owed so downstream
          // re-runs when the child completes again. This handles gate re-arm (test f):
          // the cascade can't detect this because deliver loop has consumes: [].
          this.store.tx(() => {
            const artNow = this.store.getArtifact(parentWf, callsStem);
            if (!artNow || !isGreen(artNow)) return; // already re-armed or gone
            this.store.putArtifact({
              ...artNow,
              acceptance: 'owed',
              reasons: [...artNow.reasons, {
                at: Date.now(),
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
    const parentDef = this.resolveDef(parentWfRow.def);
    this.maintainCalls(parentWf, parentDef);
    this.fireSettled(parentWf);
  }

  // ---- the tick (maintain → reap → eligible → cadence/budget → claim) --------

  tick(workflow: string, opts: { now?: number } = {}): TickResult {
    const def = this.defFor(workflow);
    const now = opts.now ?? nowMs();
    // M2B: maintain calls: child instances before the normal tick/reap/claim cycle.
    this.maintainCalls(workflow, def, now);
    return this.store.tx(() => {
      this.settle(workflow, def, now);
      const reaped = this.reap(workflow, now);

      const arts = this.artMap(workflow);

      // Compute time facts for idle eligibility (clock-read boundary).
      const timeFacts = this.computeTimeFacts(def, workflow, arts, now);

      const firings = eligibleFirings(def, arts, timeFacts);
      const { selected, deferred } = this.applySchedule(workflow, def, firings, now);

      // Clear alarm_at for any idle firing that was selected (consume the alarm).
      for (const f of selected) {
        if (f.cause === 'idle') {
          this.store.clearAlarm(workflow, f.loop);
        }
      }

      const orders: Order[] = [];
      const allDeferred: DeferredFiring[] = [...deferred];
      for (const f of selected) {
        const result = this.claim(workflow, def, f, arts, now);
        if (result === 'in-flight') {
          const d: DeferredFiring = { loop: f.loop, key: f.key, inputs: f.inputs, outputs: f.outputs, reason: 'in-flight' };
          if (f.index !== undefined) d.index = f.index;
          allDeferred.push(d);
        } else if (result) {
          orders.push(result);
        }
      }

      // E-DUE: compute earliest pending time-trigger for the result.
      const dueAt = this.computeDueAt(def, workflow, now);

      const result: TickResult = { workflow, orders, reaped, deferred: allDeferred };
      if (dueAt !== null) result.dueAt = dueAt;
      return result;
    });
  }

  /** Per-loop cadence + daily budget + parallel cap over the eligible firings. */
  private applySchedule(
    workflow: string,
    def: WorkflowDef,
    firings: Firing[],
    now: number,
  ): { selected: Firing[]; deferred: DeferredFiring[] } {
    const midnight = localMidnightMs(now);
    const selected: Firing[] = [];
    const deferred: DeferredFiring[] = [];

    const defer = (f: Firing, reason: DeferredReason): void => {
      const d: DeferredFiring = { loop: f.loop, key: f.key, inputs: f.inputs, outputs: f.outputs, reason };
      if (f.index !== undefined) d.index = f.index;
      deferred.push(d);
    };

    for (const loop of def.loops) {
      const loopFirings = firings.filter((f) => f.loop === loop.name);
      if (loopFirings.length === 0) continue;

      const latest = this.store.latestRun(workflow, loop.name);
      if (latest && now - latest.createdAt < loop.cadenceSecs * 1000) {
        for (const f of loopFirings) defer(f, 'cadence');
        continue;
      }

      const used = this.store.countRuns(workflow, loop.name, midnight);
      const budget = Math.max(0, loop.maxRunsPerDay - used);
      const slots = Math.min(loop.parallel, budget);

      // binding constraint for firings beyond the slots: budget is tighter (incl.
      // budget === 0) → daily-budget; otherwise the concurrency cap → parallel-cap.
      const beyondReason: DeferredReason = budget < loop.parallel ? 'daily-budget' : 'parallel-cap';

      for (const f of loopFirings.slice(0, slots)) selected.push(f);
      for (const f of loopFirings.slice(slots)) defer(f, beyondReason);
    }

    return { selected, deferred };
  }

  /** Claim a firing's lease via CAS, snapshot the fingerprint, open a run. */
  private claim(
    workflow: string,
    def: WorkflowDef,
    f: Firing,
    arts: ArtifactMap,
    now: number,
  ): Order | 'in-flight' | null {
    const existing = this.store.getTask(workflow, f.loop, f.key);
    if (existing && existing.status === 'claimed') {
      const run = existing.run ? this.store.getRun(existing.run) : undefined;
      const fresh =
        !!run &&
        run.outcome === undefined &&
        (existing.claimedAt === undefined || now - existing.claimedAt <= this.reapTtlMs);
      if (fresh) return 'in-flight'; // genuinely in flight — don't double-claim
    }

    const runId = randId('run');
    const fp = computeFingerprint(arts, f.inputs);
    // Stamp the run with the tick's clock so cadence/budget compare on one clock.
    this.store.insertRun(runId, { workflow, loop: f.loop, key: f.key, fingerprint: fp, ...(f.cause ? { cause: f.cause } : {}) }, now);
    this.store.putTask({
      workflow,
      loop: f.loop,
      key: f.key,
      status: 'claimed',
      run: runId,
      claimedAt: now,
      attempts: existing?.attempts ?? 0,
    });
    return this.buildOrder(def, workflow, runId, f, arts);
  }

  private buildOrder(
    def: WorkflowDef,
    workflow: string,
    runId: string,
    f: Firing,
    arts: ArtifactMap,
  ): Order {
    const loop = this.loop(def, f.loop);
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
      loop: f.loop,
      key: f.key,
      inputs: f.inputs,
      outputs: f.outputs,
      workdir: loop.workdir,
      prompt: substitute(loop.body, {
        WORKFLOW: workflow,
        RUN: runId,
        LOOP: f.loop,
        KEY: f.key,
        INDEX: f.index === undefined ? '' : String(f.index),
        MAX_ATTEMPTS: String(loop.maxAttempts),
      }),
      consumes,
      owes,
    };
    if (f.index !== undefined) order.index = f.index;
    if (loop.model !== undefined) order.model = loop.model;
    if (f.cause !== undefined) order.cause = f.cause;
    return order;
  }

  // ---- producer commits ------------------------------------------------------

  /** Commit a singleton/map output green — or born-reject it if an input moved. */
  green(
    workflow: string,
    run: string,
    path: string,
    value: Record<string, unknown>,
    opts: { terminal?: boolean } = {},
  ): CommitResult {
    const def = this.defFor(workflow);
    const result = this.store.tx((): CommitResult => {
      const r = this.openRun(workflow, run);
      const arts = this.artMap(workflow);
      const art = arts.get(path);
      if (!art) throw new Error(`cannot green unknown artifact: ${path}`);

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

      const next: ArtifactData = {
        ...art,
        acceptance: 'green',
        version: art.version + 1,
        value,
        fingerprint: computeFingerprint(arts, req),
      };
      // A destructive completion (e.g. a merge) is terminal: once green it can
      // never be re-armed by the forward cascade (§15.2). A loop may declare its
      // output terminal in its definition, or the caller may force it per-commit.
      const producer = def.loops.find((l) => l.name === art.producer);
      if (opts.terminal || producer?.terminal) next.terminal = true;
      this.store.putArtifact(next);
      this.settle(workflow, def);
      return { path, outcome: 'green' };
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
      const loop = this.loop(def, r.loop);
      const s = collectionStem(loop);
      if (!s) throw new Error(`loop ${r.loop} does not produce a collection`);
      stem = s;
      const arts = this.artMap(workflow);

      const req = plainConsumes(loop).map((c) => c.stem);
      const cas = this.casCheck(arts, req, r.fingerprint ?? {});
      if (cas.moved) {
        const seal = arts.get(sealPath(stem));
        if (seal) this.bornReject(seal, cas.moved);
        this.releaseLeaseOnBornReject(workflow, run);
        this.settle(workflow, def);
        return { outcome: 'born-rejected', created: [], reason: cas.reason };
      }

      // §18: every emitted element must satisfy the collection's declared schema.
      // The check is atomic — one bad item accretes nothing and bumps the seal's
      // schema-stall counter — so a producer can't half-fill a collection with
      // malformed members and the run can correct and re-emit on the same lease.
      const schema = loop.produces.find((p) => p.kind === 'collection' && p.stem === stem)?.schema;
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
          producer: r.loop,
          acceptance: 'green',
          version: 1,
          value: item.value,
          fingerprint: fp,
          reasons: [],
          judgmentRejects: 0,
          schemaRejects: 0,
        });
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
      const loop = this.loop(def, r.loop);
      const stem = collectionStem(loop);
      if (!stem) throw new Error(`loop ${r.loop} does not produce a collection`);
      const arts = this.artMap(workflow);
      const sealP = sealPath(stem);
      const sealArt = arts.get(sealP);
      if (!sealArt) throw new Error(`no seal artifact for ${stem}`);

      const req = plainConsumes(loop).map((c) => c.stem);
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
      });
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

  /** Judgment reject (§4): a consumer says "fix it". Re-arms the producer. */
  reject(workflow: string, path: string, by: Author, text: string): void {
    const def = this.defFor(workflow);
    this.assertAuthority(def, by, path, 'reject');
    this.store.tx(() => {
      const art = this.store.getArtifact(workflow, path);
      if (!art) throw new Error(`cannot reject unknown artifact: ${path}`);
      this.store.putArtifact({
        ...art,
        acceptance: 'rejected',
        judgmentRejects: art.judgmentRejects + 1,
        reasons: [...art.reasons, reason('reject', 'judgment', by, text, art.version)],
      });
      this.settle(workflow, def);
    });
    this.fire({ type: 'commit', workflow, path, action: 'reject' });
    this.fireSettled(workflow);
  }

  /** Retract a collection member (§11.3): drop it, terminally; abandon the index. */
  retract(workflow: string, path: string, by: Author, text: string): void {
    const def = this.defFor(workflow);
    const el = parseElement(path);
    if (!el || el.suffix !== '') throw new Error(`retract is only valid on a collection member: ${path}`);
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
      this.store.putArtifact({
        ...art,
        acceptance: 'skipped',
        fingerprint: computeFingerprint(arts, req),
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
    this.store.tx(() => {
      const art = this.store.getArtifact(workflow, path);
      if (!art) throw new Error(`cannot retry unknown artifact: ${path}`);
      this.store.putArtifact({
        ...art,
        acceptance: 'owed',
        judgmentRejects: 0,
        schemaRejects: 0,
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
      const task = this.store.getTask(workflow, r.loop, r.key ?? '');
      if (task && task.status === 'claimed' && task.run === run) {
        this.store.putTask({ workflow, loop: r.loop, key: r.key ?? '', status: 'idle', attempts: task.attempts });
      }
    });
    // Closing releases a lease; it touches no artifact state, so there is no
    // forward cascade and no `settled` to derive — just the lifecycle signal.
    this.fire({ type: 'closed', workflow, run, outcome });
    // M2B cascade-up prompt: closing a run may advance the child's artifact state.
    this.triggerParentIfChild(workflow);
  }

  /** Release stranded leases (claimed by a dead/closed run, or past the TTL). */
  reap(workflow: string, now = nowMs()): number {
    let n = 0;
    for (const task of this.store.listTasks(workflow)) {
      if (task.status !== 'claimed') continue;
      const run = task.run ? this.store.getRun(task.run) : undefined;
      const stale = task.claimedAt !== undefined && now - task.claimedAt > this.reapTtlMs;
      const stranded = !run || run.outcome !== undefined || stale;
      if (stranded) {
        this.store.putTask({
          workflow,
          loop: task.loop,
          key: task.key,
          status: 'idle',
          attempts: task.attempts + 1,
        });
        n++;
      }
    }
    return n;
  }

  // ---- observability ---------------------------------------------------------

  status(workflow: string): WorkflowStatus {
    const def = this.defFor(workflow);
    const arts = this.artMap(workflow);
    const st = workflowStatus(def, arts);
    // Enrich each debt with its producer's crash-loop signal (the run log; the
    // pure layer has no store). A map-loop producer fires once per element, its
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
    }
    return st;
  }

  // ---- alarm API (E-SETALARM / E-DUE) ----------------------------------------

  /** Set a persistent alarm for an idle evaluator loop. Survives restart. */
  setAlarm(workflow: string, loop: string, at: number): void {
    this.store.setAlarm(workflow, loop, at);
  }

  /** Clear the alarm for an idle evaluator loop. */
  clearAlarm(workflow: string, loop: string): void {
    this.store.clearAlarm(workflow, loop);
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

    for (const loop of def.loops) {
      if (!loop.on?.includes('idle')) continue;
      const alarmAt = this.store.getAlarm(workflow, loop.name);
      const threshold = alarmAt ?? (lastProgressMs + (loop.idleAfterMs ?? 0));
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
   * not mutate the loop. A throwing listener is isolated — its error is routed
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
   * Emit the post-commit `settled` event — `done` plus the eligible loop names,
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
    this.fire({ type: 'settled', workflow, done: st.done, eligible: st.eligible.map((e) => e.loop) });
  }

  /** Compute the TimeFacts bag for idle eligibility from the current store state. */
  private computeTimeFacts(
    def: WorkflowDef,
    workflow: string,
    arts: ArtifactMap,
    now: number,
  ): TimeFacts {
    const lastProgressMs = this.store.lastProgressMs(workflow);
    const inFlight = this.isInFlight(workflow, now);
    const alarms = new Map<string, number>();
    for (const loop of def.loops) {
      if (!loop.on?.includes('idle')) continue;
      const alarmAt = this.store.getAlarm(workflow, loop.name);
      if (alarmAt !== undefined) alarms.set(loop.name, alarmAt);
    }
    void arts; // arts not needed here but passed for consistency
    return { now, lastProgressMs, inFlight, alarms };
  }

  /** Returns true if any fresh claimed task exists for this workflow. */
  private isInFlight(workflow: string, now: number): boolean {
    for (const task of this.store.listTasks(workflow)) {
      if (task.status !== 'claimed') continue;
      const run = task.run ? this.store.getRun(task.run) : undefined;
      const fresh =
        !!run &&
        run.outcome === undefined &&
        (task.claimedAt === undefined || now - task.claimedAt <= this.reapTtlMs);
      if (fresh) return true;
    }
    return false;
  }

  /** Compute the earliest pending idle time-trigger (ms epoch), or null. */
  private computeDueAt(def: WorkflowDef, workflow: string, now: number): number | null {
    const lastProgressMs = this.store.lastProgressMs(workflow);
    let earliest: number | null = null;
    for (const loop of def.loops) {
      if (!loop.on?.includes('idle')) continue;
      const alarmAt = this.store.getAlarm(workflow, loop.name);
      const threshold = alarmAt ?? (lastProgressMs + (loop.idleAfterMs ?? 0));
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
      for (const a of owed) this.store.putArtifact({ ...a, workflow });
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
      const handlerLoop = def.loops.find((l) => l.name === op.handlerLoop);
      if (!handlerLoop) return;
      // Singleton outputs
      for (const p of handlerLoop.produces.filter((pp) => pp.kind === 'singleton')) {
        const existing = arts.get(p.stem);
        if (!existing) {
          this.store.putArtifact({
            workflow,
            path: p.stem,
            producer: handlerLoop.name,
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
      for (const p of handlerLoop.produces.filter((pp) => pp.kind === 'collection')) {
        const sealKey = p.stem + '.sealed';
        const existing = arts.get(sealKey);
        if (!existing) {
          this.store.putArtifact({
            workflow,
            path: sealKey,
            producer: handlerLoop.name,
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
      this.store.putArtifact({
        ...art,
        acceptance: 'skipped',
        fingerprint: computeFingerprint(arts, requiredInputs(def, arts, art)),
        reasons: [...art.reasons, reason('skip', 'structural', 'engine', op.reason, art.version)],
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
    this.store.putArtifact({
      ...art,
      acceptance,
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
    const task = this.store.getTask(workflow, r.loop, r.key ?? '');
    if (task && task.status === 'claimed' && task.run === run) {
      this.store.putTask({ workflow, loop: r.loop, key: r.key ?? '', status: 'idle', attempts: task.attempts });
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

  private artMap(workflow: string): Map<string, ArtifactData> {
    const m = new Map<string, ArtifactData>();
    for (const a of this.store.listArtifacts(workflow)) m.set(a.path, a);
    return m;
  }

  private defFor(workflow: string): WorkflowDef {
    const wf = this.store.getWorkflow(workflow);
    if (!wf) throw new Error(`no such workflow instance: ${workflow}`);
    return this.resolveDef(wf.def);
  }

  private loop(def: WorkflowDef, name: string): LoopDef {
    const l = def.loops.find((x) => x.name === name);
    if (!l) throw new Error(`no such loop in ${def.name}: ${name}`);
    return l;
  }

  /**
   * The JSON Schema (if any) declared for the artifact `art` greened by `green()`
   * — a map child binds to its loop's per-element produce, everything else to a
   * singleton produce. Seals/collection elements go through `seal`/`emit` and are
   * not handled here. Returns undefined when no schema is declared (the default).
   */
  private produceSchema(def: WorkflowDef, art: ArtifactData): JsonSchema | undefined {
    const loop = def.loops.find((l) => l.name === art.producer);
    if (!loop) return undefined;
    const el = parseElement(art.path);
    if (el && el.suffix !== '') {
      const mp = loop.produces.find(
        (p) => p.kind === 'map' && p.stem === el.stem && p.suffix === el.suffix,
      );
      return mp?.schema;
    }
    const sp = loop.produces.find((p) => p.kind === 'singleton' && p.stem === art.path);
    return sp?.schema;
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
    const task = this.store.getTask(workflow, r.loop, r.key ?? '');
    if (!task || task.run !== run) {
      throw new Error(`run ${run} no longer holds its lease (reaped or superseded)`);
    }
    return r;
  }

  /**
   * Authority (§4.1): only a loop that consumes `path`'s stem (or a human/engine)
   * may judgment-reject it. Consuming is dual-purpose — it is also how a loop is
   * granted the right to invalidate an artifact (so a step that must send an
   * artifact back, even one it only judges, must declare it in `consumes`).
   */
  private assertAuthority(def: WorkflowDef, by: Author, path: string, _action: string): void {
    if (by === 'human' || by === 'engine') return;
    const el = parseElement(path);
    const stem = el ? el.stem : path.replace(/\.sealed$/, '');
    const loop = def.loops.find((l) => l.name === by);
    if (!loop) throw new Error(`unknown actor: ${by}`);
    const consumesIt = loop.consumes.some((c) => c.stem === stem || c.stem === path);
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

/** M2B: deep-equal via JSON serialization (plain JSON objects only — no undefined/functions). */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
