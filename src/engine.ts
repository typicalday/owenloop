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
import type { ArtifactMap, CascadeOp, Firing, WorkflowStatus } from './model.ts';
import { summarizeIssues, validateValue } from './schema.ts';
import type { SchemaIssue } from './schema.ts';
import { localMidnightMs, nowMs, randId } from './util.ts';
import type { Store } from './store.ts';
import type {
  ArtifactData,
  Author,
  JsonSchema,
  LoopDef,
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
}

export interface TickResult {
  workflow: string;
  orders: Order[];
  reaped: number;
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
}

export type DefResolver = (defName: string) => WorkflowDef;

export class Engine {
  readonly store: Store;
  private readonly resolveDef: DefResolver;
  private readonly reapTtlMs: number;

  constructor(store: Store, resolveDef: DefResolver, opts: { reapTtlMs?: number } = {}) {
    this.store = store;
    this.resolveDef = resolveDef;
    this.reapTtlMs = opts.reapTtlMs ?? DEFAULT_REAP_TTL_MS;
  }

  // ---- instance lifecycle ----------------------------------------------------

  /** Start a workflow instance: persist it, seed its declared inputs, settle. */
  createInstance(defName: string, opts: CreateOpts = {}): string {
    const def = this.resolveDef(defName);
    const id = randId('wf');
    return this.store.tx(() => {
      const wfData: { def: string; title?: string; params?: Record<string, string> } = { def: defName };
      if (opts.title !== undefined) wfData.title = opts.title;
      if (opts.params !== undefined) wfData.params = opts.params;
      this.store.insertWorkflow(id, wfData);

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
  }

  // ---- the tick (maintain → reap → eligible → cadence/budget → claim) --------

  tick(workflow: string, opts: { now?: number } = {}): TickResult {
    const def = this.defFor(workflow);
    const now = opts.now ?? nowMs();
    return this.store.tx(() => {
      this.settle(workflow, def);
      const reaped = this.reap(workflow, now);

      const arts = this.artMap(workflow);
      const firings = eligibleFirings(def, arts);
      const selected = this.applySchedule(workflow, def, firings, now);

      const orders: Order[] = [];
      for (const f of selected) {
        const order = this.claim(workflow, def, f, arts, now);
        if (order) orders.push(order);
      }
      return { workflow, orders, reaped };
    });
  }

  /** Per-loop cadence + daily budget + parallel cap over the eligible firings. */
  private applySchedule(
    workflow: string,
    def: WorkflowDef,
    firings: Firing[],
    now: number,
  ): Firing[] {
    const midnight = localMidnightMs(now);
    const selected: Firing[] = [];
    for (const loop of def.loops) {
      const loopFirings = firings.filter((f) => f.loop === loop.name);
      if (loopFirings.length === 0) continue;

      const latest = this.store.latestRun(workflow, loop.name);
      if (latest && now - latest.createdAt < loop.cadenceSecs * 1000) continue; // not due

      const used = this.store.countRuns(workflow, loop.name, midnight);
      const budget = Math.max(0, loop.maxRunsPerDay - used);
      const slots = Math.min(loop.parallel, budget);
      for (const f of loopFirings.slice(0, slots)) selected.push(f);
    }
    return selected;
  }

  /** Claim a firing's lease via CAS, snapshot the fingerprint, open a run. */
  private claim(
    workflow: string,
    def: WorkflowDef,
    f: Firing,
    arts: ArtifactMap,
    now: number,
  ): Order | null {
    const existing = this.store.getTask(workflow, f.loop, f.key);
    if (existing && existing.status === 'claimed') {
      const run = existing.run ? this.store.getRun(existing.run) : undefined;
      const fresh =
        !!run &&
        run.outcome === undefined &&
        (existing.claimedAt === undefined || now - existing.claimedAt <= this.reapTtlMs);
      if (fresh) return null; // genuinely in flight — don't double-claim
    }

    const runId = randId('run');
    const fp = computeFingerprint(arts, f.inputs);
    // Stamp the run with the tick's clock so cadence/budget compare on one clock.
    this.store.insertRun(runId, { workflow, loop: f.loop, key: f.key, fingerprint: fp }, now);
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
    return this.store.tx(() => {
      const r = this.openRun(workflow, run);
      const arts = this.artMap(workflow);
      const art = arts.get(path);
      if (!art) throw new Error(`cannot green unknown artifact: ${path}`);

      const req = requiredInputs(def, arts, art);
      const cas = this.casCheck(arts, req, r.fingerprint ?? {});
      if (cas.moved) {
        this.bornReject(art, cas.moved);
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
  }

  /**
   * A collection producer emits elements, accreting after the highest existing
   * index. CAS'd against the producer's plain inputs; a moved input born-rejects
   * the seal instead of emitting.
   */
  emit(workflow: string, run: string, items: Array<{ value: Record<string, unknown> }>): EmitResult {
    const def = this.defFor(workflow);
    return this.store.tx(() => {
      const r = this.openRun(workflow, run);
      const loop = this.loop(def, r.loop);
      const stem = collectionStem(loop);
      if (!stem) throw new Error(`loop ${r.loop} does not produce a collection`);
      const arts = this.artMap(workflow);

      const req = plainConsumes(loop).map((c) => c.stem);
      const cas = this.casCheck(arts, req, r.fingerprint ?? {});
      if (cas.moved) {
        const seal = arts.get(sealPath(stem));
        if (seal) this.bornReject(seal, cas.moved);
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
  }

  /** Green a collection's seal — the producer's "I am done emitting" signal. */
  seal(workflow: string, run: string, value: Record<string, unknown> = {}): CommitResult {
    const def = this.defFor(workflow);
    return this.store.tx(() => {
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
    // Enrich each debt with its producer's crash-loop signal (run log; the pure
    // layer has no store). Plain-loop key is '' — exact for linear workflows.
    for (const d of st.debts) {
      const a = arts.get(d.path);
      if (!a) continue;
      const fr = this.store.recentFailedRuns(workflow, a.producer);
      if (fr > 0) d.failedRuns = fr;
    }
    return st;
  }

  // ---- internals -------------------------------------------------------------

  /** Materialize owed outputs + run the cascade to a fixpoint (inside a tx). */
  private settle(workflow: string, def: WorkflowDef): void {
    const limit = 1000;
    for (let i = 0; i < limit; i++) {
      let arts = this.artMap(workflow);
      const owed = pendingOwed(def, arts);
      for (const a of owed) this.store.putArtifact({ ...a, workflow });
      if (owed.length) arts = this.artMap(workflow);

      const ops = maintainDecisions(def, arts);
      for (const op of ops) this.applyOp(workflow, def, arts, op);

      if (owed.length === 0 && ops.length === 0) return;
    }
    throw new Error(`settle did not converge for ${workflow} (possible cascade cycle)`);
  }

  private applyOp(workflow: string, def: WorkflowDef, arts: ArtifactMap, op: CascadeOp): void {
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
    const acceptance = op.kind === 'reject' ? 'rejected' : 'retracted';
    const action: ReasonAction = op.kind === 'reject' ? 'reject' : 'retract';
    this.store.putArtifact({
      ...art,
      acceptance,
      reasons: [...art.reasons, reason(action, 'structural', 'engine', op.reason, art.version)],
    });
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

  /** Authority (§4): only a loop that consumes `path`'s stem (or a human) may judgment-reject it. */
  private assertAuthority(def: WorkflowDef, by: Author, path: string, _action: string): void {
    if (by === 'human' || by === 'engine') return;
    const el = parseElement(path);
    const stem = el ? el.stem : path.replace(/\.sealed$/, '');
    const loop = def.loops.find((l) => l.name === by);
    if (!loop) throw new Error(`unknown actor: ${by}`);
    const consumesIt = loop.consumes.some((c) => c.stem === stem || c.stem === path);
    if (!consumesIt) {
      throw new Error(`${by} has no authority to invalidate ${path} (it does not consume it)`);
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
