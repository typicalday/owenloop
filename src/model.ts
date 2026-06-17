/**
 * The pure dataflow model — eligibility, fingerprints, and cascade decisions.
 *
 * Everything here is a pure function of (workflow definition, current artifact
 * set). No IO, no clock, no store — so the firing rule (§3), the collection
 * eligibility (§11.4), the forward cascade (§11.8), and the level-triggered
 * re-derivation (§12.3) can all be unit-tested in isolation. The engine
 * (engine.ts) is the only thing that turns these decisions into writes.
 *
 * The artifact set for one workflow instance is passed as a `Map<path, data>`.
 */

import {
  bindProduce,
  elementPath,
  isMemberOf,
  parseElement,
  sealPath,
} from './paths.ts';
import { DEBT_STATES, SETTLED_STATES } from './types.ts';
import type {
  Acceptance,
  ArtifactBiography,
  ArtifactData,
  ConsumePattern,
  Fingerprint,
  GraphEdge,
  GraphNode,
  GraphNodeState,
  LoopDef,
  ProducePattern,
  RunData,
  TimelineEvent,
  WorkflowDef,
  WorkflowGraph,
  WorkflowTrace,
} from './types.ts';

export type ArtifactMap = ReadonlyMap<string, ArtifactData>;

/** A candidate run: a loop bound to a particular key, with its concrete edges. */
export interface Firing {
  loop: string;
  key: string; // "" for plain/reduce, the element path for a map element
  index?: number; // the bound element index, for map firings
  inputs: string[]; // concrete consumed input paths (all green) — the claim fingerprint domain
  outputs: string[]; // concrete owed/rejected output paths this firing discharges
}

/** A structural maintenance op the engine should apply (level-triggered). */
export type CascadeOp =
  | { kind: 'reject'; path: string; reason: string } // green→rejected, value kept
  | { kind: 'retract'; path: string; reason: string } // tombstone a map child of a retracted element
  | { kind: 'skip'; path: string; reason: string } // cascade skip down a dead branch
  | { kind: 'rearm'; path: string; reason: string }; // skipped→owed when the branch revives

// ---- loop shape classification ----------------------------------------------

export function mapConsume(loop: LoopDef): ConsumePattern | undefined {
  return loop.consumes.find((c) => c.mode === 'map');
}
export function reduceConsume(loop: LoopDef): ConsumePattern | undefined {
  return loop.consumes.find((c) => c.mode === 'reduce');
}
export function plainConsumes(loop: LoopDef): ConsumePattern[] {
  return loop.consumes.filter((c) => c.mode === 'plain');
}

export type LoopMode = 'plain' | 'map' | 'reduce';
export function loopMode(loop: LoopDef): LoopMode {
  if (mapConsume(loop)) return 'map';
  if (reduceConsume(loop)) return 'reduce';
  return 'plain';
}

export function mapProduce(loop: LoopDef): ProducePattern | undefined {
  return loop.produces.find((p) => p.kind === 'map');
}
/** The collection stem a loop produces (`gather.source` for `gather.source[]`), if any. */
export function collectionStem(loop: LoopDef): string | undefined {
  return loop.produces.find((p) => p.kind === 'collection')?.stem;
}
export function singletonProduces(loop: LoopDef): ProducePattern[] {
  return loop.produces.filter((p) => p.kind === 'singleton');
}
export function collectionProduces(loop: LoopDef): ProducePattern[] {
  return loop.produces.filter((p) => p.kind === 'collection');
}

// ---- small predicates --------------------------------------------------------

export function isDebt(a: ArtifactData | undefined): boolean {
  return !!a && DEBT_STATES.has(a.acceptance);
}
export function isGreen(a: ArtifactData | undefined): boolean {
  return !!a && a.acceptance === 'green';
}
/**
 * §6 liveness: a judgment-rejected artifact that has been knocked back `cap`
 * times has *stalled*. It stays a debt (so it surfaces as stuck), but the engine
 * stops re-arming it — no firing is eligible to rebuild it until a human clears
 * the stall (`retry` resets the count, or `retract` drops a collection member).
 * Only *judgment* rejects count toward `judgmentRejects` (structural cascade /
 * born-rejected / level-trigger churn never bump it), so this bounds genuine
 * verdict-thrash without tripping on bookkeeping (§11.9).
 */
export function isStalled(a: ArtifactData | undefined, cap: number): boolean {
  return !!a && a.acceptance === 'rejected' && a.judgmentRejects >= cap;
}
/**
 * §18 liveness: an output that has failed its declared JSON Schema `cap` times
 * has stalled the same way (it stays a debt but stops re-arming). Tracked on a
 * *separate* counter from judgment rejects — a schema failure is the engine
 * refusing a malformed value, not a consumer's verdict — so the two stalls are
 * tuned independently (`maxSchemaFailures` vs `maxAttempts`) and a `retry`
 * clears both. A `cap` of 0 disables the schema stall (unbounded retries).
 */
export function isSchemaStalled(a: ArtifactData | undefined, cap: number): boolean {
  return !!a && cap > 0 && a.acceptance === 'rejected' && a.schemaRejects >= cap;
}
/** An artifact is frozen (no firing re-arms it) when either stall trips. */
function frozen(a: ArtifactData | undefined, loop: LoopDef): boolean {
  return isStalled(a, loop.maxAttempts) || isSchemaStalled(a, loop.maxSchemaFailures);
}
function isSettledOut(a: ArtifactData): boolean {
  // retracted/skipped members drop out of a set; they don't block a reduce.
  return a.acceptance === 'retracted' || a.acceptance === 'skipped';
}

/** Bare elements (no further suffix) of a collection stem, in index order. */
export function members(arts: ArtifactMap, stem: string): ArtifactData[] {
  const out: ArtifactData[] = [];
  for (const a of arts.values()) if (isMemberOf(stem, a.path)) out.push(a);
  out.sort((x, y) => (parseElement(x.path)?.index ?? 0) - (parseElement(y.path)?.index ?? 0));
  return out;
}

function loopByName(def: WorkflowDef, name: string): LoopDef | undefined {
  return def.loops.find((l) => l.name === name);
}

// ---- required inputs & fingerprints -----------------------------------------

/**
 * The concrete artifact paths `art` must rest on (all green) to legitimately be
 * green. This is the domain of its build fingerprint and the level-trigger's
 * standing check (§12.3). It is derived from the producer loop's consume
 * patterns and the artifact's own role (seal / element / map child / singleton).
 */
export function requiredInputs(def: WorkflowDef, arts: ArtifactMap, art: ArtifactData): string[] {
  const loop = loopByName(def, art.producer);
  if (!loop) return [];
  const plain = plainConsumes(loop).map((c) => c.stem);

  // a seal or a bare collection element rests only on the producer's plain inputs
  if (art.sealOf) return plain;
  const el = parseElement(art.path);
  if (el && el.suffix === '') return plain;

  // a map child (src[i].suffix) rests on its bound element + plain gates
  if (el && el.suffix !== '') {
    const mc = mapConsume(loop);
    const stem = mc ? mc.stem : el.stem;
    return [elementPath(stem, el.index), ...plain];
  }

  // a singleton: a reduce output rests on the whole live set + seal; a plain
  // output rests only on its plain inputs
  const rc = reduceConsume(loop);
  if (rc) {
    const live = members(arts, rc.stem).filter((m) => !isSettledOut(m));
    return [...live.map((m) => m.path), sealPath(rc.stem), ...plain];
  }
  return plain;
}

/** The {path → version} snapshot over a set of input paths. */
export function computeFingerprint(arts: ArtifactMap, paths: readonly string[]): Fingerprint {
  const fp: Fingerprint = {};
  for (const p of paths) fp[p] = arts.get(p)?.version ?? -1;
  return fp;
}

/** Does `fp` exactly match the current versions of `paths` (same keys, same versions)? */
export function fingerprintMatches(
  arts: ArtifactMap,
  paths: readonly string[],
  fp: Fingerprint,
): boolean {
  const keys = Object.keys(fp);
  if (keys.length !== paths.length) return false;
  for (const p of paths) {
    if (!(p in fp)) return false;
    if ((arts.get(p)?.version ?? -1) !== fp[p]) return false;
  }
  return true;
}

// ---- materialization: which owed outputs must exist -------------------------

/**
 * The owed output artifacts that should exist but don't yet. Singletons and
 * collection seals are owed from instance start; a map child becomes owed the
 * moment its bound element greens (dynamic cardinality, §11.1).
 */
export function pendingOwed(def: WorkflowDef, arts: ArtifactMap): ArtifactData[] {
  const out: ArtifactData[] = [];
  const ensure = (path: string, producer: string, sealOf?: string): void => {
    if (arts.has(path)) return;
    if (out.some((o) => o.path === path)) return;
    const a: ArtifactData = {
      workflow: '',
      path,
      producer,
      acceptance: 'owed',
      version: 0,
      reasons: [],
      judgmentRejects: 0,
      schemaRejects: 0,
    };
    if (sealOf) a.sealOf = sealOf;
    out.push(a);
  };

  for (const loop of def.loops) {
    const mode = loopMode(loop);
    if (mode === 'map') {
      const mc = mapConsume(loop);
      const mp = mapProduce(loop);
      if (!mc || !mp) continue;
      for (const m of members(arts, mc.stem)) {
        if (!isGreen(m)) continue;
        const el = parseElement(m.path);
        if (!el) continue;
        ensure(bindProduce(mp, el.index), loop.name);
      }
    } else {
      for (const p of singletonProduces(loop)) ensure(p.stem, loop.name);
      for (const p of collectionProduces(loop)) ensure(sealPath(p.stem), loop.name, p.stem);
    }
  }
  return out;
}

// ---- eligibility (§3 / §11.4) ------------------------------------------------

/**
 * Every firing eligible *right now* — inputs satisfied AND an owed/rejected
 * output to discharge. This is the scheduling gate (§11.4): necessary, not
 * sufficient; the commit fingerprint (§12.2) is the correctness boundary.
 * Assumes `pendingOwed` has already been materialized into `arts`.
 */
export function eligibleFirings(def: WorkflowDef, arts: ArtifactMap): Firing[] {
  const firings: Firing[] = [];

  for (const loop of def.loops) {
    const mode = loopMode(loop);
    const plain = plainConsumes(loop);
    const plainPaths = plain.map((c) => c.stem);
    const plainSatisfied = plainPaths.every((p) => isGreen(arts.get(p)));

    if (mode === 'plain') {
      if (!plainSatisfied) continue;
      const outs = plainOutputs(loop).filter((p) => {
        const a = arts.get(p);
        return isDebt(a) && !frozen(a, loop);
      });
      if (outs.length) {
        firings.push({ loop: loop.name, key: '', inputs: plainPaths, outputs: outs });
      }
      continue;
    }

    if (mode === 'map') {
      if (!plainSatisfied) continue;
      const mc = mapConsume(loop);
      const mp = mapProduce(loop);
      if (!mc || !mp) continue;
      for (const m of members(arts, mc.stem)) {
        if (!isGreen(m)) continue;
        const el = parseElement(m.path);
        if (!el) continue;
        const outPath = bindProduce(mp, el.index);
        const outArt = arts.get(outPath);
        if (!isDebt(outArt) || frozen(outArt, loop)) continue;
        firings.push({
          loop: loop.name,
          key: m.path,
          index: el.index,
          inputs: [m.path, ...plainPaths],
          outputs: [outPath],
        });
      }
      continue;
    }

    // reduce
    const rc = reduceConsume(loop);
    if (!rc) continue;
    if (!plainSatisfied) continue;
    const seal = arts.get(sealPath(rc.stem));
    if (!isGreen(seal)) continue;
    const mem = members(arts, rc.stem);
    const live = mem.filter((m) => !isSettledOut(m));
    if (live.some((m) => !isGreen(m))) continue; // a rejected/owed member blocks the reduce
    const outs = singletonProduces(loop)
      .map((p) => p.stem)
      .filter((p) => {
        const a = arts.get(p);
        return isDebt(a) && !frozen(a, loop);
      });
    if (outs.length) {
      firings.push({
        loop: loop.name,
        key: '',
        inputs: [...live.map((m) => m.path), sealPath(rc.stem), ...plainPaths],
        outputs: outs,
      });
    }
  }

  return firings;
}

/** The concrete output paths a plain loop drives eligibility from (singletons + seals). */
function plainOutputs(loop: LoopDef): string[] {
  const out: string[] = [];
  for (const p of singletonProduces(loop)) out.push(p.stem);
  for (const p of collectionProduces(loop)) out.push(sealPath(p.stem));
  return out;
}

// ---- level-triggered maintenance (§11.8, §12.3) -----------------------------

/**
 * The standing guard: re-derive the invariant "an artifact is green only while
 * every artifact it directly consumed is green and unmoved" and report the
 * structural ops needed to restore it. Pure — the engine applies the ops and
 * re-runs to a fixpoint. Covers the forward reject cascade, retract/skip
 * tombstoning of map children, skip-propagation down dead branches, and the
 * re-arm of a skipped subtree when its branch revives.
 */
export function maintainDecisions(def: WorkflowDef, arts: ArtifactMap): CascadeOp[] {
  const ops: CascadeOp[] = [];

  for (const art of arts.values()) {
    if (art.acceptance === 'retracted') continue; // terminal — nothing to maintain

    const el = parseElement(art.path);
    const isMapChild = !!el && el.suffix !== '';

    // A skipped artifact is settled-but-re-armable. It stays skipped while the
    // routing decision that produced it still holds — i.e. while its inputs are
    // unmoved from the fingerprint captured at skip time. It re-arms only when
    // those inputs come back green *and have moved* (the branch was re-decided).
    // Re-arming on "inputs are green" alone would thrash, since the skip itself
    // was made on green inputs (§16.1).
    if (art.acceptance === 'skipped') {
      const req = requiredInputs(def, arts, art);
      const allGreen = req.length > 0 && req.every((p) => isGreen(arts.get(p)));
      const moved = !fingerprintMatches(arts, req, art.fingerprint ?? {});
      if (allGreen && moved) {
        ops.push({ kind: 'rearm', path: art.path, reason: 'branch revived: inputs moved since skip' });
      }
      continue;
    }

    const req = requiredInputs(def, arts, art);
    if (req.length === 0) continue; // a seeded input with no producer-inputs: nothing to rest on

    // the first input that is not green (settled-dead or merely in-flight)
    let offender: ArtifactData | undefined;
    let offenderPath: string | undefined;
    for (const p of req) {
      const dep = arts.get(p);
      if (!isGreen(dep)) {
        offender = dep;
        offenderPath = p;
        break;
      }
    }

    // A non-terminal green is subject to the forward reject cascade: it may only
    // stay green while every input is green *and unmoved* from its build (§11.8).
    if (art.acceptance === 'green' && !art.terminal) {
      const versionsOk = fingerprintMatches(arts, req, art.fingerprint ?? {});
      if (!offender && versionsOk) continue; // invariant holds
      if (offender && offenderPath) {
        ops.push(cascadeFromDeadInput(art.path, offender, offenderPath, isMapChild));
        continue;
      }
      const moved = req.find((p) => (arts.get(p)?.version ?? -1) !== (art.fingerprint ?? {})[p]);
      ops.push({ kind: 'reject', path: art.path, reason: `auto-invalidated: ${moved ?? 'an input'} moved version` });
      continue;
    }

    // A debt (owed/rejected) resting on a *settled-dead* input can never be
    // discharged — no producer firing is eligible while the input is non-green,
    // and a retracted/skipped input will not green on its own. Settle it the same
    // way (retract a dead map child terminally; skip a dead-branch dependent,
    // which re-arms if the branch later revives). A debt on a merely in-flight
    // input (owed/rejected) is just blocked, not dead — leave it.
    if (isDebt(art) && offender && offenderPath && isSettledOut(offender)) {
      ops.push(cascadeFromDeadInput(art.path, offender, offenderPath, isMapChild));
    }
  }

  return ops;
}

/** Classify the cascade op for an artifact whose input `offender` is non-green. */
function cascadeFromDeadInput(
  path: string,
  offender: ArtifactData,
  offenderPath: string,
  isMapChild: boolean,
): CascadeOp {
  if (offender.acceptance === 'retracted' && isMapChild) {
    return { kind: 'retract', path, reason: `auto-retracted: ${offenderPath} was retracted` };
  }
  if (offender.acceptance === 'skipped') {
    return { kind: 'skip', path, reason: `skipped: ${offenderPath} not taken` };
  }
  return { kind: 'reject', path, reason: `auto-invalidated: ${offenderPath} changed` };
}

// ---- observability (§17) -----------------------------------------------------

export interface Blocker {
  loop: string;
  blockedOn: string[]; // non-green inputs holding the loop back
}

export interface WorkflowStatus {
  done: boolean;
  debts: Array<{
    path: string;
    acceptance: Acceptance;
    kind: 'judgment' | 'structural' | 'validation' | 'unbuilt';
    /** §6/§18: rejected past its producer's cap — the engine won't re-arm it */
    stalled: boolean;
    reason?: string;
    /**
     * Consecutive trailing `failed` runs for this debt's producer (crash-loop
     * signal). Enriched by `engine.status()` from the run log — `workflowStatus`
     * is pure and never sets it. Absent when zero or unknown.
     */
    failedRuns?: number;
  }>;
  eligible: Firing[];
  blocked: Blocker[];
}

/** Derive the operator view purely from artifact state (§17) — never stored. */
export function workflowStatus(def: WorkflowDef, arts: ArtifactMap): WorkflowStatus {
  const debts: WorkflowStatus['debts'] = [];
  for (const a of arts.values()) {
    if (!DEBT_STATES.has(a.acceptance)) continue;
    const last = a.reasons[a.reasons.length - 1];
    const kind: 'judgment' | 'structural' | 'validation' | 'unbuilt' = last
      ? last.kind === 'judgment'
        ? 'judgment'
        : last.kind === 'validation'
          ? 'validation'
          : 'structural'
      : 'unbuilt';
    const prod = loopByName(def, a.producer);
    const stalled =
      !!prod && (isStalled(a, prod.maxAttempts) || isSchemaStalled(a, prod.maxSchemaFailures));
    const entry: WorkflowStatus['debts'][number] = { path: a.path, acceptance: a.acceptance, kind, stalled };
    if (last) entry.reason = last.text;
    debts.push(entry);
  }
  debts.sort((x, y) => x.path.localeCompare(y.path));

  const eligible = eligibleFirings(def, arts);
  const eligibleLoops = new Set(eligible.map((f) => f.loop));

  const blocked: Blocker[] = [];
  for (const loop of def.loops) {
    if (eligibleLoops.has(loop.name)) continue;
    if (!loopOwesSomething(def, loop, arts)) continue; // owes nothing → done, not blocked
    const blockedOn = blockingInputs(def, loop, arts);
    if (blockedOn.length) blocked.push({ loop: loop.name, blockedOn });
  }

  const done = ![...arts.values()].some((a) => DEBT_STATES.has(a.acceptance));
  return { done, debts, eligible, blocked };
}

function loopOwesSomething(def: WorkflowDef, loop: LoopDef, arts: ArtifactMap): boolean {
  const mode = loopMode(loop);
  if (mode === 'map') {
    const mc = mapConsume(loop);
    const mp = mapProduce(loop);
    if (!mc || !mp) return false;
    return members(arts, mc.stem).some((m) => {
      const el = parseElement(m.path);
      return el ? isDebt(arts.get(bindProduce(mp, el.index))) : false;
    });
  }
  return plainOutputs(loop).some((p) => isDebt(arts.get(p)));
}

function blockingInputs(def: WorkflowDef, loop: LoopDef, arts: ArtifactMap): string[] {
  const out: string[] = [];
  for (const c of plainConsumes(loop)) if (!isGreen(arts.get(c.stem))) out.push(c.stem);
  const rc = reduceConsume(loop);
  if (rc) {
    const seal = sealPath(rc.stem);
    if (!isGreen(arts.get(seal))) out.push(seal);
    for (const m of members(arts, rc.stem)) {
      if (!isSettledOut(m) && !isGreen(m)) out.push(m.path);
    }
  }
  return out;
}

export { SETTLED_STATES };

// ---- trace builder (§17 derived temporal view) --------------------------------

/**
 * Build a causal timeline and per-artifact biographies for one workflow
 * instance. Pure — no DB, no clock, no IO. Same purity contract as
 * workflowStatus.
 *
 * Causality gap: a successful run does not append a ReasonEntry and there is
 * no stored FK from an artifact version back to its producing run. The
 * produced→consumed edges are therefore inferred (see WorkflowTrace.inferenceNote),
 * not stored facts. We represent this honestly: producedStems is derived from
 * the def (structural, not temporal) and consumedInputs is from the run
 * fingerprint (a stored fact at claim time).
 */
export function buildTrace(
  def: WorkflowDef,
  artifacts: ReadonlyArray<ArtifactData & { updatedAt?: number }>,
  runs: ReadonlyArray<RunData & { id: string; createdAt: number; updatedAt: number }>,
): WorkflowTrace {
  // --- step 1: build an ArtifactMap for workflowStatus reuse ---
  const artMap: ArtifactMap = new Map(artifacts.map((a) => [a.path, a]));

  // --- step 2: build the loop → producedStems map from the def ---
  // For map loops: the raw produce pattern string (e.g. "gather.source[$i].formatcheck")
  // For collection producers: the collection stem (e.g. "gather.source")
  // For singletons: the stem name (e.g. "plan", "pr")
  const loopProducedStems = new Map<string, string[]>();
  for (const loop of def.loops) {
    const stems: string[] = [];
    for (const p of singletonProduces(loop)) stems.push(p.stem);
    for (const p of collectionProduces(loop)) stems.push(p.stem);
    const mp = mapProduce(loop);
    if (mp) stems.push(mp.raw); // use the raw pattern (e.g. "gather.source[$i].check")
    loopProducedStems.set(loop.name, stems);
  }

  // --- step 3: build the timeline ---
  // Runs are already ordered by (created_at, rowid) from store.listRuns.
  // We re-sort here defensively in case caller passes unsorted input.
  const sortedRuns = [...runs].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // id tiebreak (lexicographic, stable)
  });

  const timeline: TimelineEvent[] = sortedRuns.map((run, idx) => ({
    seq: idx + 1,
    at: run.createdAt,
    endedAt: run.updatedAt,
    loop: run.loop,
    key: run.key ?? '',
    outcome: run.outcome,
    summary: run.summary,
    sessionId: run.sessionId,
    consumedInputs: run.fingerprint,
    producedStems: loopProducedStems.get(run.loop) ?? [],
  }));

  // --- step 4: build artifact biographies ---
  // Count actions across all artifact reason threads for the summary.
  let totalRejects = 0;
  let totalRetries = 0;
  const stalledArtifacts: string[] = [];

  const biographies: ArtifactBiography[] = [...artifacts]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((art) => {
      for (const e of art.reasons) {
        if (e.action === 'reject' || e.action === 'born-rejected' || e.action === 'schema-reject') {
          totalRejects++;
        }
        if (e.action === 'retry') totalRetries++;
      }

      // Check stall: need the producer loop's caps
      const producerLoop = def.loops.find((l) => l.name === art.producer);
      if (producerLoop) {
        const stallJ = isStalled(art, producerLoop.maxAttempts);
        const stallS = isSchemaStalled(art, producerLoop.maxSchemaFailures);
        if (stallJ || stallS) stalledArtifacts.push(art.path);
      }

      return {
        path: art.path,
        producer: art.producer,
        terminal: art.terminal ?? false,
        acceptance: art.acceptance,
        version: art.version,
        judgmentRejects: art.judgmentRejects,
        schemaRejects: art.schemaRejects,
        events: art.reasons, // already chronological (append-only thread)
      };
    });

  // --- step 5: summary ---
  const byOutcome: Record<string, number> = {};
  for (const run of sortedRuns) {
    const k = run.outcome ?? 'open';
    byOutcome[k] = (byOutcome[k] ?? 0) + 1;
  }

  const status = workflowStatus(def, artMap);

  return {
    workflow: artifacts[0]?.workflow ?? '',
    timeline,
    artifacts: biographies,
    summary: {
      totalRuns: sortedRuns.length,
      byOutcome,
      totalRejects,
      totalRetries,
      stalledArtifacts,
      done: status.done,
    },
    inferenceNote:
      'producedStems is derived from the workflow definition (structural) and ' +
      'identifies which stems a loop is responsible for, not which version it ' +
      'produced in a specific run. consumedInputs is the run fingerprint (a ' +
      'stored fact at claim time). The causal edge run→artifact-version is an ' +
      'inference: the Nth ok run of loop L corresponds to version N of its ' +
      "output stems. This is a heuristic — no stored FK exists (by design, " +
      "to avoid schema changes).",
  };
}

// ---- graph builder (§spatial view: wiring + live-state overlay) ---------------

/**
 * Build a structural wiring graph for a workflow definition.
 * When `artifacts` are provided, annotate each node with the live acceptance
 * state derived from the artifact set (overlay mode).
 *
 * Pure — no IO, no clock, no DB. Same purity contract as buildTrace.
 *
 * Edge derivation replicates validateDef's producerOf map exactly:
 *   inputs → input node id (= input name)
 *   singleton/collection produces → the loop that produces them
 *   map produces (per-element) are NOT registered in producerOf —
 *     they live under the collection they annotate
 *
 * A dangling consume (nothing produces the stem) yields an edge with
 * from = '__dangling__' + stem — it renders visually (shows the missing
 * wiring) and never crashes. This can only occur on an invalid def that
 * lint already errors on; graph never validates.
 */
export function buildGraph(
  def: WorkflowDef,
  artifacts?: ReadonlyArray<ArtifactData>,
): WorkflowGraph {
  // --- 1. Build producerOf exactly as validateDef does ---
  const producerOf = new Map<string, string>(); // stem → node id (input name or loop name)
  const collectionStems = new Set<string>();

  for (const inp of def.inputs) {
    producerOf.set(inp.name, inp.name); // input node id = input name
  }
  for (const l of def.loops) {
    for (const p of l.produces) {
      if (p.kind === 'collection') {
        collectionStems.add(p.stem);
        if (!producerOf.has(p.stem)) producerOf.set(p.stem, l.name);
      } else if (p.kind === 'singleton') {
        if (!producerOf.has(p.stem)) producerOf.set(p.stem, l.name);
      }
      // map produces (p.kind === 'map') are per-element children; not registered
    }
  }

  // --- 2. Build nodes ---
  const nodes: GraphNode[] = [];

  // Input nodes
  for (const inp of def.inputs) {
    nodes.push({ id: inp.name, kind: 'input', label: inp.name });
  }

  // Loop nodes — overlay state computed below
  for (const l of def.loops) {
    const node: GraphNode = {
      id: l.name,
      kind: 'loop',
      label: l.name,
    };
    if (l.terminal) node.terminal = true;
    if (l.parallel !== undefined) node.parallel = l.parallel;
    if (l.model !== undefined) node.model = l.model;
    nodes.push(node);
  }

  // --- 3. Build edges ---
  const edges: GraphEdge[] = [];

  for (const l of def.loops) {
    for (const c of l.consumes) {
      // Resolve producer: look up c.stem in producerOf
      const producerNode = producerOf.get(c.stem) ?? `__dangling__${c.stem}`;

      // Skip self-edges (should never occur in a valid def, but guard gracefully)
      if (producerNode === l.name) continue;

      const edge: GraphEdge = {
        from: producerNode,
        to: l.name,
        stem: c.stem,
        mode: c.mode,
      };
      if (c.binder !== undefined) edge.binder = c.binder;
      edges.push(edge);
    }
  }

  // --- 4. Overlay: annotate nodes with live artifact state ---
  const hasOverlay = artifacts !== undefined && artifacts.length > 0;
  if (artifacts && artifacts.length > 0) {
    // Build a loop name → LoopDef map for cap lookup
    const loopMap = new Map<string, LoopDef>(def.loops.map((l) => [l.name, l]));
    // Build a set of input names for membership test
    const inputNames = new Set<string>(def.inputs.map((i) => i.name));

    // Group artifacts for node lookup:
    //   - loop nodes:  match by a.producer (= loop name)
    //   - input nodes: match by a.path (= input name), since inputs have producer = 'human'
    const byProducer = new Map<string, ArtifactData[]>();
    const byPath = new Map<string, ArtifactData>();
    for (const a of artifacts) {
      const existing = byProducer.get(a.producer) ?? [];
      existing.push(a);
      byProducer.set(a.producer, existing);
      byPath.set(a.path, a);
    }

    for (const node of nodes) {
      // For input nodes, look up by path; for loop nodes, look up by producer name.
      const nodeArts: ArtifactData[] =
        node.kind === 'input'
          ? (inputNames.has(node.id) && byPath.has(node.id) ? [byPath.get(node.id)!] : [])
          : (byProducer.get(node.id) ?? []);
      if (nodeArts.length === 0) {
        node.state = 'none';
        continue;
      }

      const loop = loopMap.get(node.id);
      const maxAttempts = loop?.maxAttempts ?? 3;
      const maxSchema = loop?.maxSchemaFailures ?? 5;

      // Determine worst-state using priority: stalled > rejected > owed > skipped/retracted > green
      let worstState: GraphNodeState = 'green';
      let anyStalled = false;

      for (const a of nodeArts) {
        const stallJ = isStalled(a, maxAttempts);
        const stallS = isSchemaStalled(a, maxSchema);
        if (stallJ || stallS) {
          anyStalled = true;
          worstState = 'stalled';
          break; // stalled is the worst; short-circuit
        }
      }

      if (!anyStalled) {
        for (const a of nodeArts) {
          if (a.acceptance === 'rejected') {
            worstState = 'rejected';
            break;
          }
        }
        if (worstState !== 'rejected') {
          for (const a of nodeArts) {
            if (a.acceptance === 'owed') {
              worstState = 'owed';
              break;
            }
          }
          if (worstState !== 'owed') {
            const allSkipped = nodeArts.every((a) => a.acceptance === 'skipped');
            const allRetracted = nodeArts.every((a) => a.acceptance === 'retracted');
            if (allSkipped) worstState = 'skipped';
            else if (allRetracted) worstState = 'retracted';
            // else: all green
          }
        }
      }

      node.state = worstState;
      if (anyStalled) node.stalled = true;
    }
  }

  // --- 5. Sort for determinism ---
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => {
    const f = a.from.localeCompare(b.from);
    if (f !== 0) return f;
    const t = a.to.localeCompare(b.to);
    if (t !== 0) return t;
    return a.stem.localeCompare(b.stem);
  });

  return { def: def.name, nodes, edges, hasOverlay };
}

// ---- graph renderers ----------------------------------------------------------

const STATE_FILL_COLORS: Record<string, string> = {
  green: '#c8e6c9',
  owed: '#e0e0e0',
  rejected: '#ffcc80',
  stalled: '#ef9a9a',
  skipped: '#f5f5f5',
  retracted: '#eeeeee',
};

function dotEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Render a WorkflowGraph as a Graphviz DOT string.
 * Pure — no IO, no side effects. Deterministic (nodes/edges already sorted).
 */
export function graphToDot(g: WorkflowGraph): string {
  const lines: string[] = [];
  lines.push(`digraph "${dotEscape(g.def)}" {`);
  lines.push('  rankdir=LR;');
  lines.push('  node [fontname="Helvetica"];');
  lines.push('');

  // Collect dangling node ids from edges
  const danglingIds = new Set(
    g.edges
      .filter((e) => e.from.startsWith('__dangling__'))
      .map((e) => e.from),
  );

  // Emit dangling phantom nodes (before real nodes)
  for (const id of [...danglingIds].sort()) {
    const stem = id.slice('__dangling__'.length);
    lines.push(`  "${dotEscape(id)}" [label="(missing: ${dotEscape(stem)})", shape=plaintext, color=red];`);
  }

  // Emit real nodes
  for (const node of g.nodes) {
    const shape =
      node.kind === 'input' ? 'ellipse' : node.terminal ? 'doublecircle' : 'box';
    const attrs: string[] = [`shape=${shape}`, `label="${dotEscape(node.label)}"`];
    if (g.hasOverlay && node.state && node.state !== 'none') {
      const fillcolor = STATE_FILL_COLORS[node.state];
      const style =
        node.state === 'skipped' || node.state === 'retracted'
          ? '"filled,dashed"'
          : 'filled';
      attrs.push(`style=${style}`);
      if (fillcolor) attrs.push(`fillcolor="${fillcolor}"`);
    }
    lines.push(`  "${dotEscape(node.id)}" [${attrs.join(', ')}];`);
  }

  lines.push('');

  // Emit edges
  for (const edge of g.edges) {
    const edgeAttrs: string[] = [];
    if (edge.mode === 'map') {
      edgeAttrs.push(`label="map [${dotEscape(edge.binder ?? '$i')}]"`);
      edgeAttrs.push('style=dashed');
    } else if (edge.mode === 'reduce') {
      edgeAttrs.push('label="reduce [*]"');
      edgeAttrs.push('style=bold');
    } else {
      edgeAttrs.push('style=solid');
    }
    const attrStr = edgeAttrs.length ? ` [${edgeAttrs.join(', ')}]` : '';
    lines.push(`  "${dotEscape(edge.from)}" -> "${dotEscape(edge.to)}"${attrStr};`);
  }

  lines.push('}');
  return lines.join('\n');
}

function mmdSafeId(id: string): string {
  if (id.startsWith('__dangling__')) {
    return 'dangling_' + id.slice('__dangling__'.length).replace(/[^a-zA-Z0-9]/g, '_');
  }
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function mmdEscape(s: string): string {
  return s.replace(/"/g, '#quot;');
}

/**
 * Render a WorkflowGraph as a Mermaid flowchart string.
 * Pure — no IO, no side effects. Deterministic (nodes/edges already sorted).
 */
export function graphToMermaid(g: WorkflowGraph): string {
  const lines: string[] = [];
  lines.push('flowchart LR');

  // Collect dangling ids
  const danglingIds = new Set(
    g.edges.filter((e) => e.from.startsWith('__dangling__')).map((e) => e.from),
  );

  // Emit dangling phantom nodes
  for (const id of [...danglingIds].sort()) {
    const stem = id.slice('__dangling__'.length);
    const mid = mmdSafeId(id);
    lines.push(`  ${mid}["(missing: ${mmdEscape(stem)})"]`);
    lines.push(`  style ${mid} stroke:red`);
  }

  // Emit real nodes
  for (const node of g.nodes) {
    const mid = mmdSafeId(node.id);
    const lbl = mmdEscape(node.label);
    if (node.kind === 'input') {
      lines.push(`  ${mid}(("${lbl}"))`);
    } else if (node.terminal) {
      lines.push(`  ${mid}(["${lbl}"])`);
    } else {
      lines.push(`  ${mid}["${lbl}"]`);
    }
  }

  lines.push('');

  // Emit classDefs (only when overlay present)
  if (g.hasOverlay) {
    lines.push('  classDef green fill:#c8e6c9,stroke:#333;');
    lines.push('  classDef owed fill:#e0e0e0,stroke:#333;');
    lines.push('  classDef rejected fill:#ffcc80,stroke:#333;');
    lines.push('  classDef stalled fill:#ef9a9a,stroke:#333;');
    lines.push('  classDef skipped fill:#f5f5f5,stroke:#333,stroke-dasharray:5 5;');
    lines.push('  classDef retracted fill:#eeeeee,stroke:#333,stroke-dasharray:5 5;');
    lines.push('');
  }

  // Emit edges
  for (const edge of g.edges) {
    const from = mmdSafeId(edge.from);
    const to = mmdSafeId(edge.to);
    if (edge.mode === 'map') {
      lines.push(`  ${from} -->|"map [${mmdEscape(edge.binder ?? '$i')}]"| ${to}`);
    } else if (edge.mode === 'reduce') {
      lines.push(`  ${from} -->|"reduce [*]"| ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  lines.push('');

  // Emit class assignments
  if (g.hasOverlay) {
    for (const node of g.nodes) {
      if (node.state && node.state !== 'none') {
        lines.push(`  class ${mmdSafeId(node.id)} ${node.state}`);
      }
    }
  }

  return lines.join('\n');
}
