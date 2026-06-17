# PR4 Plan: `oweflow check <def>` — Bounded Model Checker

## Goal

Add a bounded reachability / liveness checker that explores the full (or
depth/state-bounded) state space of a workflow definition to find:

- **deadlocks**: reachable states that are not done, have no eligible firings,
  and have no further moves
- **stuck states**: reachable states with a stalled debt
- **completability**: whether any reachable state is `done` (with an example path)
- **dead loops**: loops whose name never appears in any explored firing transition

The checker is PURE — no store, no engine, no IO. A differential conformance
test pins the in-memory transition logic to the real `Engine` so checker verdicts
are trustworthy.

---

## Files to Touch

| File | Change |
|---|---|
| `src/types.ts` | Add `CheckOptions`, `CheckStep`, `CheckReport` types |
| `src/model.ts` | Add `settleInMemory`, `applyOutcome`, `modelCheck` |
| `src/cli.ts` | Add `check` command to `dispatch` and update `USAGE` |
| `src/index.ts` | Re-export the three new model functions and new types |
| `test/check.test.ts` | New: conformance + unit + CLI smoke tests |

**Do NOT touch**: `engine.ts`, `store.ts`, `defs.ts`, `paths.ts`, `schema.ts`,
`util.ts`, `factory.ts`. Do not add any npm dependencies.

---

## Types to Add in `src/types.ts`

Append after the existing `WorkflowGraph` block:

```ts
// ---- model-checker types (§check) -------------------------------------------

/** One step on a BFS path: a loop fired, on which key, with which outcome. */
export interface CheckStep {
  loop: string;
  key: string;      // "" for plain/reduce; element path for map
  outcome: 'green' | 'judgment-reject' | 'schema-reject' | 'skip' | 'retract' | 'emit-seal';
}

/** A finding with its shortest witness path from the initial state. */
export interface CheckFinding {
  path: CheckStep[];
}

/** Options for modelCheck — all optional; sane defaults apply. */
export interface CheckOptions {
  maxDepth?: number;         // default 50
  maxStates?: number;        // default 5000
  maxCollectionSize?: number; // default 2 — max members when fan-out from an emit
}

/** The structured report produced by modelCheck. */
export interface CheckReport {
  def: string;
  /** True when any BFS bound was hit — verdicts are "within bounds", not global. */
  bounded: boolean;
  /** Which bounds were hit, for honest reporting. */
  boundsHit: ('maxDepth' | 'maxStates')[];
  /** Reachable states where done=false and eligibleFirings=[]: a genuine deadlock. */
  deadlocks: CheckFinding[];
  /** Reachable states that have a stalled debt (judgmentRejects >= cap). */
  stuck: CheckFinding[];
  /** Whether any explored state is done, and (when true) one example path to it. */
  completable: boolean;
  completePath?: CheckStep[];
  /**
   * Loop names that never appear as the firing loop in any explored transition
   * (dynamically dead within the bounded search).
   */
  deadLoops: string[];
  /** Metadata about the search. */
  stats: {
    statesExplored: number;
    depthReached: number;
  };
}
```

---

## New Functions in `src/model.ts`

All functions are added at the bottom of `src/model.ts`, AFTER the existing graph
builders. No new imports are needed — all helpers (`pendingOwed`,
`maintainDecisions`, `eligibleFirings`, `workflowStatus`, `computeFingerprint`,
`requiredInputs`, `isStalled`, `isSchemaStalled`, `members`, `loopMode`,
`collectionStem`, `singletonProduces`, `parseElement`, `elementPath`, `sealPath`,
`bindProduce`, `mapConsume`, `mapProduce`) are already in scope or imported.

Add these type imports at the top of `model.ts` (the existing import block):
```ts
// add to the existing 'from ./types.ts' import:
import type { CheckOptions, CheckReport, CheckStep } from './types.ts';
```

### 1. `settleInMemory`

```ts
/**
 * Pure in-memory fixpoint: mirror Engine.settle() without any store or IO.
 * Clones `arts`, materializes pendingOwed, applies every maintainDecisions op,
 * repeats until no more changes. Throws on non-convergence (>1000 iterations),
 * matching the engine's guard. The conformance test pins this to the real Engine.
 */
export function settleInMemory(
  def: WorkflowDef,
  arts: Map<string, ArtifactData>,
): Map<string, ArtifactData> {
  const limit = 1000;
  for (let i = 0; i < limit; i++) {
    const owed = pendingOwed(def, arts);
    for (const a of owed) arts.set(a.path, a);
    if (owed.length > 0) {
      // re-read after materializing owed
    }
    const ops = maintainDecisions(def, arts);
    if (owed.length === 0 && ops.length === 0) return arts;
    for (const op of ops) {
      applyOpInMemory(arts, def, op);
    }
  }
  throw new Error(`settleInMemory did not converge (possible cascade cycle)`);
}
```

**Internal helper `applyOpInMemory`** (not exported) mirrors `Engine.applyOp`
field-spread EXACTLY:

```ts
function applyOpInMemory(
  arts: Map<string, ArtifactData>,
  def: WorkflowDef,
  op: CascadeOp,
): void {
  const art = arts.get(op.path);
  if (!art) return;
  if (op.kind === 'rearm') {
    // mirrors Engine.applyOp rearm branch: acceptance → 'owed'
    arts.set(op.path, { ...art, acceptance: 'owed' });
    return;
  }
  if (op.kind === 'skip') {
    // mirrors Engine.applyOp skip branch: acceptance → 'skipped' + fingerprint
    arts.set(op.path, {
      ...art,
      acceptance: 'skipped',
      fingerprint: computeFingerprint(arts, requiredInputs(def, arts, art)),
    });
    return;
  }
  // reject and retract
  const acceptance: Acceptance = op.kind === 'reject' ? 'rejected' : 'retracted';
  arts.set(op.path, { ...art, acceptance });
}
```

Key fidelity notes vs `Engine.applyOp`:
- `rearm`: sets `acceptance: 'owed'` — matches the engine's spread (the `reasons`
  thread is not tracked in the checker, so we skip it, but acceptance and all
  counters are preserved from the existing art via `...art`).
- `skip`: sets `acceptance: 'skipped'` and captures `fingerprint` via
  `computeFingerprint(arts, requiredInputs(def, arts, art))` — exactly what the
  engine does; this fingerprint is what `maintainDecisions` later compares to
  decide whether to rearm.
- `reject`: sets `acceptance: 'rejected'` — does NOT bump `judgmentRejects`
  because this is a structural cascade reject (same as engine: `bornReject` and
  `applyOp` reject do NOT bump `judgmentRejects`; only the human `engine.reject()`
  verb does that).
- `retract`: sets `acceptance: 'retracted'`.

The conformance test must verify these mappings hold.

### 2. `applyOutcome`

```ts
/**
 * Given a firing and a nondeterministic outcome, produce the post-commit
 * in-memory state (cloned from arts) then run settleInMemory.
 *
 * Outcomes modeled (single-threaded; born-rejected CAS races omitted):
 *   'green'           — singleton/map output: acceptance green, version+1,
 *                       fingerprint = computeFingerprint(arts, firing.inputs)
 *   'judgment-reject' — acceptance rejected, judgmentRejects+1
 *   'schema-reject'   — acceptance rejected, schemaRejects+1
 *   'skip'            — acceptance skipped + fingerprint of requiredInputs
 *   'retract'         — acceptance retracted (collection member only)
 *   'emit-seal'       — collection producer: emit 1..maxCollectionSize green elements,
 *                       then seal; forks into (maxCollectionSize+1) successor states
 *
 * Returns an array of successor states (>1 only for emit-seal). Each successor
 * is already settled. 'green' is the only outcome that sets terminal when the
 * producer loop declares terminal:true.
 */
export function applyOutcome(
  def: WorkflowDef,
  arts: Map<string, ArtifactData>,
  firing: Firing,
  outcome: CheckStep['outcome'],
  opts: { maxCollectionSize: number },
): Array<Map<string, ArtifactData>> {
  // emit-seal branches: return one map per element count 0..maxCollectionSize
  if (outcome === 'emit-seal') {
    return applyEmitSeal(def, arts, firing, opts.maxCollectionSize);
  }

  // all other outcomes: single successor
  const next = new Map(arts);
  // a firing targets its outputs; we mutate one output path per call
  // (for plain/reduce, outputs is usually one element; for map it is one element too)
  const outPath = firing.outputs[0];
  if (!outPath) return [settleInMemory(def, next)];
  const art = next.get(outPath);
  if (!art) return [settleInMemory(def, next)];

  const loop = def.loops.find((l) => l.name === firing.loop);

  if (outcome === 'green') {
    const fp = computeFingerprint(arts, firing.inputs);
    const updated: ArtifactData = {
      ...art,
      acceptance: 'green',
      version: art.version + 1,
      fingerprint: fp,
    };
    if (loop?.terminal) updated.terminal = true;
    next.set(outPath, updated);
  } else if (outcome === 'judgment-reject') {
    next.set(outPath, {
      ...art,
      acceptance: 'rejected',
      judgmentRejects: art.judgmentRejects + 1,
    });
  } else if (outcome === 'schema-reject') {
    next.set(outPath, {
      ...art,
      acceptance: 'rejected',
      schemaRejects: art.schemaRejects + 1,
    });
  } else if (outcome === 'skip') {
    next.set(outPath, {
      ...art,
      acceptance: 'skipped',
      fingerprint: computeFingerprint(arts, requiredInputs(def, arts, art)),
    });
  } else if (outcome === 'retract') {
    next.set(outPath, { ...art, acceptance: 'retracted' });
  }

  return [settleInMemory(def, next)];
}
```

**`applyEmitSeal` helper** (not exported):

```ts
function applyEmitSeal(
  def: WorkflowDef,
  arts: Map<string, ArtifactData>,
  firing: Firing,
  maxCollectionSize: number,
): Array<Map<string, ArtifactData>> {
  // The seal artifact is in firing.outputs[0] (a collection producer's plainOutputs
  // includes the sealPath). Find the collection stem from the loop.
  const loop = def.loops.find((l) => l.name === firing.loop);
  if (!loop) return [];
  const stem = collectionStem(loop);
  if (!stem) return [];
  const sealP = sealPath(stem);
  const sealArt = arts.get(sealP);
  if (!sealArt) return [];

  const fp = computeFingerprint(arts, firing.inputs);
  const results: Array<Map<string, ArtifactData>> = [];

  for (let count = 0; count <= maxCollectionSize; count++) {
    const next = new Map(arts);
    // determine starting index from existing members
    let nextIdx = 0;
    for (const a of arts.values()) {
      const el = parseElement(a.path);
      if (el && el.stem === stem && el.suffix === '') nextIdx = Math.max(nextIdx, el.index + 1);
    }
    for (let j = 0; j < count; j++) {
      const p = elementPath(stem, nextIdx + j);
      next.set(p, {
        workflow: '',
        path: p,
        producer: firing.loop,
        acceptance: 'green',
        version: 1,
        fingerprint: fp,
        reasons: [],
        judgmentRejects: 0,
        schemaRejects: 0,
      });
    }
    // seal it
    next.set(sealP, {
      ...sealArt,
      acceptance: 'green',
      version: sealArt.version + 1,
      fingerprint: fp,
    });
    results.push(settleInMemory(def, next));
  }
  return results;
}
```

**Outcome applicability per firing**: `eligibleOutcomes(def, firing)` (not
exported) returns the `CheckStep['outcome'][]` that are valid for this firing:

```ts
function eligibleOutcomes(def: WorkflowDef, firing: Firing): CheckStep['outcome'][] {
  const loop = def.loops.find((l) => l.name === firing.loop);
  if (!loop) return ['green'];
  const mode = loopMode(loop);
  const stem = collectionStem(loop);
  const outPath = firing.outputs[0] ?? '';
  const el = parseElement(outPath);
  const isMember = !!el && el.suffix === '';

  const outcomes: CheckStep['outcome'][] = [];
  if (stem && !el) {
    // collection producer (plain loop with collection output) — emit-seal path
    outcomes.push('emit-seal');
    return outcomes; // the only structural choice; green applies to the seal via emit-seal
  }
  outcomes.push('green');
  // judgment-reject is available unless frozen by maxAttempts already
  // (we only add it if adding 1 more reject is still < maxAttempts, to avoid unreachable states)
  // In practice: always add it — the frozen check in eligibleFirings already excludes
  // stalled artifacts from being returned, so any firing returned has headroom to reject at least once.
  outcomes.push('judgment-reject');
  outcomes.push('schema-reject');
  // skip is valid for any non-retracted output (producer can route dead branch)
  outcomes.push('skip');
  // retract only for bare collection members
  if (isMember) outcomes.push('retract');
  return outcomes;
}
```

### 3. `seedArts` helper (not exported)

Mirrors `Engine.createInstance`'s seeding loop exactly:

```ts
function seedArts(def: WorkflowDef): Map<string, ArtifactData> {
  const arts = new Map<string, ArtifactData>();
  for (const input of def.inputs) {
    // seedOwed=false → seed green (version 1); seedOwed=true → seed owed (version 0)
    // The checker has no runtime `provide` values, so seedOwed inputs start owed.
    const seedGreen = !input.seedOwed;
    arts.set(input.name, {
      workflow: '',
      path: input.name,
      producer: input.producer,
      acceptance: seedGreen ? 'green' : 'owed',
      version: seedGreen ? 1 : 0,
      reasons: [],
      judgmentRejects: 0,
      schemaRejects: 0,
    });
  }
  return settleInMemory(def, arts);
}
```

Key: `input.seedOwed === false` means "provided at start" and seeds GREEN
(version 1), matching the engine's `const seedGreen = !input.seedOwed || provided !== undefined`.
Since the checker has no runtime values, `provided` is always undefined, so
`seedOwed=true` → owed, `seedOwed=false` → green. This is exactly what the
engine does absent a `provide` option.

### 4. State canonicalization

```ts
/**
 * Canonical key for a state map — used by the BFS visited-set.
 *
 * Normalization rules (so equivalent states deduplicate):
 *   acceptance: stored as-is (5 values)
 *   version: NORMALIZED to rank:
 *     0 = never-green (version 0, acceptance != green)
 *     1 = currently green (version >= 1, acceptance == green)
 *     2 = was-green-now-moved (version >= 1, acceptance != green)
 *   judgmentRejects: BUCKETED to min(count, maxAttempts) so that e.g. 0, 1, 2
 *     are distinct but anything >= cap is the same (frozen state)
 *   schemaRejects: BUCKETED to min(count, maxSchemaFailures) similarly
 *
 * Sorting by path ensures key is order-independent. Only the fields that
 * affect future transitions are included — value/reasons/fingerprint content
 * are not (the fingerprint object shape matters for rearm detection, but only
 * indirectly: what matters for reachability is whether acceptance is skipped
 * plus whether requiredInputs are green-and-moved, which is captured by
 * acceptance+versionRank combinations).
 *
 * SPECIAL: for 'skipped' artifacts, the fingerprint DOES affect rearm eligibility
 * (maintainDecisions compares fingerprint to current versions). We must encode
 * the fingerprint keys and their version-rank to capture this. We encode it as
 * a sorted list of "inputPath:versionRank" pairs in the key.
 */
function canonicalKey(def: WorkflowDef, arts: Map<string, ArtifactData>): string {
  const parts: string[] = [];
  const loopMap = new Map(def.loops.map((l) => [l.name, l]));

  for (const [path, art] of [...arts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const loop = loopMap.get(art.producer);
    const maxAttempts = loop?.maxAttempts ?? 3;
    const maxSchema = loop?.maxSchemaFailures ?? 5;

    const vRank = art.version === 0 ? 0 : art.acceptance === 'green' ? 1 : 2;
    const jBucket = Math.min(art.judgmentRejects, maxAttempts);
    const sBucket = Math.min(art.schemaRejects, maxSchema);

    let entry = `${path}:${art.acceptance}:${vRank}:${jBucket}:${sBucket}`;

    // For skipped: encode fingerprint as sorted "fPath:fRank" pairs
    if (art.acceptance === 'skipped' && art.fingerprint) {
      const fpParts = Object.entries(art.fingerprint)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => {
          const dep = arts.get(k);
          const depRank = v === 0 ? 0 : dep?.acceptance === 'green' ? 1 : 2;
          return `${k}@${depRank}`;
        })
        .join(',');
      entry += `|fp:${fpParts}`;
    }
    parts.push(entry);
  }
  return parts.join(';');
}
```

### 5. `modelCheck`

```ts
export function modelCheck(def: WorkflowDef, opts: CheckOptions = {}): CheckReport {
  const maxDepth = opts.maxDepth ?? 50;
  const maxStates = opts.maxStates ?? 5000;
  const maxCollectionSize = opts.maxCollectionSize ?? 2;

  const initial = seedArts(def);
  const initialKey = canonicalKey(def, initial);

  // BFS
  type StateNode = {
    arts: Map<string, ArtifactData>;
    path: CheckStep[];
    depth: number;
  };

  const visited = new Map<string, CheckStep[]>(); // key → path to reach it
  visited.set(initialKey, []);
  const queue: StateNode[] = [{ arts: initial, path: [], depth: 0 }];

  const report: CheckReport = {
    def: def.name,
    bounded: false,
    boundsHit: [],
    deadlocks: [],
    stuck: [],
    completable: false,
    completePath: undefined,
    deadLoops: [],
    stats: { statesExplored: 0, depthReached: 0 },
  };

  const firedLoops = new Set<string>();
  let depthReached = 0;
  const boundsHit = new Set<'maxDepth' | 'maxStates'>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    report.stats.statesExplored++;
    if (node.depth > depthReached) depthReached = node.depth;

    const status = workflowStatus(def, node.arts);

    // Check done
    if (status.done) {
      if (!report.completable) {
        report.completable = true;
        report.completePath = node.path;
      }
      continue; // done states have no successors
    }

    // Check stuck (any debt.stalled)
    if (status.debts.some((d) => d.stalled)) {
      report.stuck.push({ path: node.path });
      // continue exploring (there may be other paths; also the non-stuck parts)
    }

    const firings = status.eligible;

    // Check deadlock: non-done, no eligible firings, no further moves
    if (firings.length === 0 && !status.done) {
      // A stuck state with zero eligible firings is BOTH stuck and deadlocked —
      // record it in both categories (caller can de-dup if desired).
      report.deadlocks.push({ path: node.path });
      continue;
    }

    // Respect maxDepth
    if (node.depth >= maxDepth) {
      boundsHit.add('maxDepth');
      continue;
    }

    // Expand successors
    for (const firing of firings) {
      firedLoops.add(firing.loop);
      const outcomes = eligibleOutcomes(def, firing);

      for (const outcome of outcomes) {
        // Check state count before expanding
        if (visited.size >= maxStates) {
          boundsHit.add('maxStates');
          break;
        }

        const step: CheckStep = { loop: firing.loop, key: firing.key, outcome };
        const successors = applyOutcome(def, node.arts, firing, outcome, { maxCollectionSize });

        for (const suc of successors) {
          const key = canonicalKey(def, suc);
          if (!visited.has(key)) {
            const newPath = [...node.path, step];
            visited.set(key, newPath);
            queue.push({ arts: suc, path: newPath, depth: node.depth + 1 });
          }
        }
      }
      if (boundsHit.has('maxStates')) break;
    }
    if (boundsHit.has('maxStates')) break;
  }

  report.stats.depthReached = depthReached;
  report.boundsHit = [...boundsHit];
  report.bounded = boundsHit.size > 0;

  // Dead loops: loops in the def that never appeared as a firing.loop
  report.deadLoops = def.loops
    .filter((l) => !firedLoops.has(l.name))
    .map((l) => l.name);

  return report;
}
```

**Important design decisions:**

1. BFS (breadth-first) is chosen so paths to deadlocks/done are the SHORTEST
   witness paths, not arbitrary DFS paths.
2. The visited-set uses canonical keys (not object identity) to deduplicate
   equivalent states.
3. `maxStates` is the total state count in `visited`, not the queue length. When
   hit, we break out of the current expansion but do not discard already-queued
   nodes. The `bounded` flag is set.
4. `maxDepth` is per node.depth, not total steps. When a node's depth reaches
   `maxDepth`, its successors are not expanded (but the node itself is classified).
5. `emit-seal` with count=0 is valid (an empty collection; the seal greens with
   no members — reduce immediately eligible if it has no non-retracted members).

---

## `src/cli.ts` Changes

### 1. Import `modelCheck` at the top

Add to the existing import from `'./model.ts'`:
```ts
import { buildGraph, buildTrace, graphToDot, graphToMermaid, modelCheck } from './model.ts';
```

### 2. Update USAGE string

Add the `check` line after `lint`:
```
  check <def> [--format text|json] [--max-depth N] [--max-states N] [--max-collection N]
                                   bounded reachability check (deadlocks, stuck, dead loops)
```

### 3. Add `check` to `dispatch`, BEFORE the `openCtx` call (alongside `lint`)

```ts
if (command === 'check') {
  const defsDir = last(args, 'defs') ?? io.env.OWEFLOW_DEFS ?? join(io.cwd, 'workflows');
  const defs = existsSync(defsDir) ? loadDefsRaw(defsDir) : new Map<string, WorkflowDef>();
  const defName = need(args, 1, 'def');
  const def = defs.get(defName);
  if (!def) {
    throw new CliError(
      `unknown workflow definition '${defName}' (looked in ${defsDir}).\n` +
      `Known definitions: ${[...defs.keys()].sort().join(', ') || '(none)'}`,
    );
  }

  const format = last(args, 'format') ?? 'text';
  const maxDepth = last(args, 'max-depth') !== undefined ? Number(last(args, 'max-depth')) : undefined;
  const maxStates = last(args, 'max-states') !== undefined ? Number(last(args, 'max-states')) : undefined;
  const maxCollection = last(args, 'max-collection') !== undefined ? Number(last(args, 'max-collection')) : undefined;

  const report = modelCheck(def, {
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(maxStates !== undefined ? { maxStates } : {}),
    ...(maxCollection !== undefined ? { maxCollectionSize: maxCollection } : {}),
  });

  if (format === 'json') {
    print(io, report);
  } else {
    // text format
    const clean = report.deadlocks.length === 0 && report.stuck.length === 0;
    const status = clean && report.completable ? 'OK' : clean ? 'INCOMPLETE' : 'DEFECTS FOUND';
    io.out(`=== oweflow check: ${def.name} ===`);
    io.out(`Status: ${status}`);
    io.out(`Completable: ${report.completable ? 'yes' : 'no'}`);
    io.out(`States explored: ${report.stats.statesExplored}, max depth: ${report.stats.depthReached}`);
    if (report.bounded) {
      io.out('');
      io.out(`SEARCH INCOMPLETE — bounds hit: ${report.boundsHit.join(', ')}`);
      io.out('Verdicts apply only within the explored region.');
    }
    if (report.deadlocks.length > 0) {
      io.out('');
      io.out(`Deadlocks (${report.deadlocks.length}):`);
      for (const d of report.deadlocks) {
        io.out(`  path: ${d.path.map((s) => `${s.loop}/${s.outcome}`).join(' -> ') || '(initial state)'}`);
      }
    }
    if (report.stuck.length > 0) {
      io.out('');
      io.out(`Stuck states (${report.stuck.length}):`);
      for (const s of report.stuck) {
        io.out(`  path: ${s.path.map((p) => `${p.loop}/${p.outcome}`).join(' -> ') || '(initial state)'}`);
      }
    }
    if (report.deadLoops.length > 0) {
      io.out('');
      io.out(`Dead loops (never fire in explored space): ${report.deadLoops.join(', ')}`);
    }
    if (report.completePath) {
      io.out('');
      io.out(`Example completion path:`);
      io.out(`  ${report.completePath.map((s) => `${s.loop}/${s.outcome}`).join(' -> ') || '(already done)'}`);
    }
  }

  // Exit codes:
  // - definite defect (deadlock or stuck and search was EXHAUSTIVE, i.e. !bounded) → nonzero
  // - truncated (bounded=true) regardless of findings → 0 (truncation is not a defect)
  // - clean exhaustive search → 0
  const hasDefiniteDefect = !report.bounded && (report.deadlocks.length > 0 || report.stuck.length > 0);
  if (hasDefiniteDefect) {
    throw new CliError(`definite defects found (${report.deadlocks.length} deadlock(s), ${report.stuck.length} stuck state(s))`);
  }
  return;
}
```

**Exit code rationale** (as per brief):
- `!bounded && (deadlocks || stuck)` → exit 1 (definite defect, exhaustive proof)
- `bounded && anything` → exit 0 (search incomplete; may have missed things)
- `!bounded && clean` → exit 0

---

## `src/index.ts` Changes

Add to the model.ts export block:
```ts
// add to model.ts exports:
  modelCheck,
  settleInMemory,
  applyOutcome,
// add to model.ts type exports:
export type { ..., CheckOptions, CheckReport, CheckStep } from './types.ts';
```

(Follow the existing export style — add `modelCheck`, `settleInMemory`,
`applyOutcome` to the named-function exports from `'./model.ts'`, and add
`CheckOptions`, `CheckReport`, `CheckStep` to the types re-exported from
`'./types.ts'`.)

---

## Test Plan: `test/check.test.ts`

This is a NEW file. Use `node:test` style, matching the project's test style
(see `test/model.test.ts`, `test/engine.test.ts`, `test/cli.test.ts`).

### Part 1: CONFORMANCE / Differential Test (most important)

**Setup**: import both the in-memory twins and the real Engine on
`openStore(':memory:')`. Drive the SAME sequence of mutations through both and
assert per-artifact field equality for `acceptance`, `version`, `judgmentRejects`,
`schemaRejects`, and `fingerprint`.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { openStore } from '../src/store.ts';
import { settleInMemory, applyOutcome } from '../src/model.ts';
import type { ArtifactData } from '../src/types.ts';
import { def, input, loop, arts as mkArts } from './helpers.ts';
```

**Helper `artFields`**: extract just the fields we assert:
```ts
function artFields(art: ArtifactData) {
  return {
    acceptance: art.acceptance,
    version: art.version,
    judgmentRejects: art.judgmentRejects,
    schemaRejects: art.schemaRejects,
    fingerprint: art.fingerprint,
  };
}
```

**Helper `engineArts`**: extract artMap from a real engine instance:
```ts
function engineArts(engine: Engine, wf: string): Map<string, ReturnType<typeof artFields>> {
  // We have access to the engine's store via engine.store (it's public)
  const raw = engine.store.listArtifacts(wf);
  return new Map(raw.map((a) => [a.path, artFields(a)]));
}
```

**Helper `inMemArts`**: extract field subset from in-memory map:
```ts
function inMemArts(arts: Map<string, ArtifactData>): Map<string, ReturnType<typeof artFields>> {
  return new Map([...arts.entries()].map(([k, v]) => [k, artFields(v)]));
}
```

**Helper `makeEngine`** (local copy following engine.test.ts):
```ts
function makeEngineLocal(defs: WorkflowDef[]) {
  const store = openStore(':memory:');
  const byName = new Map(defs.map((d) => [d.name, d]));
  const engine = new Engine(store, (name) => {
    const d = byName.get(name);
    if (!d) throw new Error(`no def: ${name}`);
    return d;
  });
  return { engine, store };
}
```

**Scenario 1: delivery happy path**

```
delivery def: proposal(seedOwed=false) → planner → builder → reviewer → merger(terminal)
```

Drive through Engine:
1. `createInstance('delivery', { provide: { proposal: { text: 'x' } } })` → wf
2. tick → planner order → `green(wf, run, 'plan', {})` + `close`
3. tick → builder order → `green(wf, run, 'pr', {})` + `close`
4. tick → reviewer order → `green(wf, run, 'verdict', {})` + `close`
5. tick → merger order → `green(wf, run, 'merge', {}, { terminal: true })` + `close`

Drive through in-memory (starting from the SAME initial state, seeded by seedArts):
```
// initial: proposal seedOwed=false → green version 1
let memArts = settleInMemory(delivery, seedArts(delivery))

// step 1: fire planner → green
memArts = applyOutcome(delivery, memArts, plannerFiring, 'green', { maxCollectionSize: 2 })[0]
// step 2: fire builder → green
// step 3: fire reviewer → green
// step 4: fire merger → green
```

Assert for every path in ['proposal', 'plan', 'pr', 'verdict', 'merge']:
```ts
assert.deepEqual(inMemArts(memArts).get(path), engineArts(engine, wf).get(path), path);
```

Note: for this comparison to be fully valid, we must drive the in-memory
starting from the same seed as the engine used. The `delivery` def has
`proposal.seedOwed=false`, so the engine seeds it as green(version=1) and the
in-memory `seedArts` also seeds it green(version=1). The `provided` value
goes into engine's `value` field (we don't check value, only the fields above).

**Scenario 2: reject + retry cycle**

Drive through Engine:
1. createInstance delivery (proposal provided)
2. planner → green plan
3. builder → green pr
4. reviewer fires, `engine.reject(wf, 'pr', 'reviewer', 'tests fail')` (judgment reject)
5. builder → green pr again (second version)
6. reviewer → green verdict
7. merger → green merge

Drive through in-memory in parallel:
1. seed
2. apply 'green' for plan
3. apply 'green' for pr
4. apply 'judgment-reject' for pr (reviewer fires, outcome=judgment-reject; note: the in-memory firing should be for the reviewer — but actually the reject is a CONSUMER action in the engine, not a producer action. See fidelity note below.)

**FIDELITY NOTE on judgment-reject**: In the engine, `engine.reject()` is called
by a CONSUMER (reviewer), not by a producer commit. But `applyOutcome` models a
firing's outcome. The correct model for "reviewer runs and rejects pr" is:
- The reviewer's FIRING outcome is modeled as: reviewer's eligible firing has
  `outputs: ['verdict']` (the verdict is owed/rejected), and the reviewer
  performing a reject of `pr` is a SIDE EFFECT of the reviewer firing with outcome
  `judgment-reject` on the artifact `pr` that it CONSUMES.

This is a subtle design point: the proposal is that `applyOutcome` takes
`firing` and `outcome` — but the `firing.outputs` is `['verdict']` (the owed
artifact), while the judgment-reject applies to `'pr'` (a consumed artifact).

**Resolution**: `judgment-reject` as an outcome of `firing` means:
- The loop ran, decided NOT to green its owed output, and instead judgment-rejected
  one of its inputs.
- In `applyOutcome`, for outcome `judgment-reject`, we apply the reject to
  `firing.inputs` that are green (the consumed artifact that the loop is
  invalidating), NOT to `firing.outputs`.

But which input? The loop can only reject inputs it has authority over (those it
consumes). In practice for the checker, we model "reviewer judgment-rejects its
primary consumed input" as the generic action. Since a loop's `firing.inputs`
is exactly the consumed green inputs, the reject applies to the FIRST non-plain-gate
input (or all of them — but realistically a reviewer rejects `pr`, not all inputs).

**Simpler approach for the checker**: model `judgment-reject` as: bump
`judgmentRejects` on each of `firing.outputs` (the owed artifacts) — NOT on inputs.
This matches how the engine works from the perspective of re-arming: when a
judgment-reject re-arms an artifact, it's the PRODUCED artifact that was previously
green (the producer greened it, then the consumer called `engine.reject` on it,
which bumps `judgmentRejects` on the produced path `pr`). The produced artifact
was previously green (version N), now becomes `rejected` with `judgmentRejects+1`.

So the model is:
- When reviewer fires and judgment-rejects: the `pr` artifact (which was green,
  owned by builder) gets bumped. But `pr` is NOT in reviewer's `firing.outputs`
  (reviewer produces `verdict`). The reviewer runs but the consumed artifact `pr`
  is rejected.

**Correction**: `judgment-reject` is a CONSUMER action on a CONSUMED artifact, not
a producer action on an output. In the engine, `engine.reject(wf, 'pr', 'reviewer',
'...')` is called directly, separate from any `green`/`skip`. The reviewer's run
can: (a) green verdict, OR (b) reject pr (and close the run with no_work).

For the checker, we model the reviewer's firing options as:
- `green` → green `verdict` (the normal path)
- `judgment-reject` → reject the CONSUMED input `pr` (the reviewer's primary
  consumed artifact), leaving `verdict` still owed

So in `applyOutcome` for `judgment-reject`:
- Find the artifact consumed by this firing that is currently green and can be
  judgment-rejected (i.e., from `firing.inputs`, the one that is this loop's
  non-plain consume or the singular consumed input).
- Actually: use the FIRST input in `firing.inputs` that has a producer that IS a
  loop (not 'human'), since inputs from human-producers are external and can't
  be judgment-rejected by a downstream loop.

**Practical simplification**: for `judgment-reject`, the target is the artifact
in `firing.inputs` whose producer is the immediately upstream loop — i.e., the
primary consumed artifact that the current firing loop has authority to invalidate.
In the delivery example: reviewer's `firing.inputs = ['pr']`, so the reject target
is `pr`.

For the conformance test this means:
- Engine path: tick reviewer order, reject('pr'), close run
- In-memory path: `applyOutcome(def, arts, reviewerFiring, 'judgment-reject', ...)`
  applies `judgmentRejects+1, acceptance: 'rejected'` to `pr`, then settles.

The `applyOutcome` implementation for `judgment-reject` therefore must find the
RIGHT target. The builder has authority to modify its outputs; the reviewer has
authority to judgment-reject its consumed inputs. We need:

```ts
// for judgment-reject: the target is the 'primary' consumed artifact
// (first firing.input that is not from 'human' producer, or all firing.inputs)
// Since eligibleFirings captures exactly the inputs the firing rests on,
// we apply judgment-reject to the first input that a downstream loop can invalidate.
// For simplicity: apply to ALL of firing.inputs that have a loop producer.
// This is fine because in practice a firing has one primary consumed input.
```

Actually, re-reading the engine code, `engine.reject(wf, 'pr', 'reviewer', text)`
modifies `pr`'s `judgmentRejects` and sets `pr.acceptance = 'rejected'`. The
field update is on the ARTIFACT `pr` (the produced artifact of the UPSTREAM loop,
builder). This is NOT a field on the firing.outputs.

So `applyOutcome` for `judgment-reject` must be:
```ts
// Identify the "reject target" — the primary consumed artifact that this
// firing loop can invalidate. This is typically firing.inputs[0] (for map
// it's the bound element's path). In delivery, reviewer.firing.inputs = ['pr'].
const rejectTarget = firing.inputs.find((p) => {
  const a = next.get(p);
  // only reject artifacts with a loop producer (not human-provided inputs)
  return a && a.producer !== 'human' && a.acceptance === 'green';
}) ?? firing.inputs[0];
```

Then bump `judgmentRejects+1` on the `rejectTarget`, set `acceptance: 'rejected'`,
and settle.

For the CONFORMANCE TEST, scenario 2 then maps to:
- Engine: reviewer fires, calls `engine.reject(wf, 'pr', 'reviewer', 'fail')`,
  close. Then builder re-fires, greens pr again.
- In-memory: `applyOutcome(def, arts, reviewerFiring, 'judgment-reject', ...)` →
  bumps `pr.judgmentRejects` to 1, `pr.acceptance = 'rejected'`, settles (builder
  gets re-armed), then `applyOutcome(def, arts2, builderFiring, 'green', ...)`.

Assert after each step that the engine and in-memory states agree on acceptance,
version, judgmentRejects, schemaRejects, fingerprint for all paths.

**Scenario 3 (collections): research, if included in v1**

V1 scope decision: **include a collection conformance case** since `applyEmitSeal`
covers it and it's part of the test requirement. The scenario:

- `gather` fires → `emit-seal` with 2 elements (count=2):
  Creates `gather.source[0]`, `gather.source[1]` both green (version 1), then
  seals `gather.source.sealed` (green, version 1). Settle materializes
  `gather.source[0].verdict` and `gather.source[1].verdict` (for formatcheck/check loop)
  and `draft` (for synthesize, but not yet eligible since seal not green yet... wait,
  after emit-seal, seal IS green).

Trace the research def carefully:
- gather produces `gather.source[]` (collection)
- check/formatcheck consumes `gather.source[$i]` (map) and produces
  `gather.source[$i].verdict` or `.formatcheck`
- synthesize consumes `gather.source[*]` (reduce) and produces `draft`

Engine scenario:
1. createInstance research, provide question
2. tick → gather order
3. emit 2 items → creates `gather.source[0]`, `gather.source[1]` as green
4. seal gather → `gather.source.sealed` green
5. settle: produces `gather.source[0].formatcheck` owed, `gather.source[1].formatcheck` owed
6. tick → check firing for [0], check firing for [1]
7. check green `gather.source[0].formatcheck`
8. check green `gather.source[1].formatcheck`
9. synthesize fires (all members green, seal green) → green draft

In-memory:
1. seedArts research (question seedOwed=false → green)
2. applyOutcome(def, arts, gatherFiring, 'emit-seal', { maxCollectionSize: 2 })[2]
   — index 2 means count=2 (the 3rd element of the array returned for count=0,1,2)
3. settle happens inside emit-seal
4. find checkFirings for [0] and [1], apply 'green'
5. find synthFiring, apply 'green'

Assert agreement on all paths.

**Important for conformance**: The engine uses `computeFingerprint(arts, req)` on
the fingerprint for a green artifact. The in-memory must do the same. Check that
`fingerprint` keys and values match exactly (values are version numbers).

### Part 2: `modelCheck` Unit Tests

**Test A: healthy linear def → completable, no deadlocks, no dead loops**

Use the `delivery` def. With a small maxStates (500 is enough for delivery).
Assert:
- `report.completable === true`
- `report.deadlocks.length === 0`
- `report.stuck.length === 0`
- `report.deadLoops.length === 0`
- `report.bounded === false` (delivery is simple enough to exhaust)

**Test B: deadlocking def**

Construct a def where ALL paths lead to a deadlock:

```ts
const deadlockDef = def('deadlocker', [input('start')], [
  loop({ name: 'a', consumes: ['start'], produces: ['x'], maxAttempts: 1 }),
  loop({ name: 'b', consumes: ['x'], produces: ['y'] }),
]);
// With maxAttempts=1 on loop 'a': after one judgment-reject, x is stalled.
// In the checker with outcome judgment-reject: after 1 reject, a is stalled.
// eligibleFirings freezes it. b never fires.
```

Wait — the checker explores paths, so it should find a path: start green → a fires
→ judgment-reject x (now x.judgmentRejects=1, which >= maxAttempts=1, so frozen).
Now no eligible firings, not done → deadlock AND stuck.

Assert:
- `report.deadlocks.length > 0` with a non-empty witness path
- `report.stuck.length > 0`
- `report.bounded === false` (small def, exhausted)
- exit code is nonzero when `!bounded && deadlocks`

**Test C: dead loop**

```ts
const withDeadLoop = def('withDead', [input('proposal')], [
  loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
  loop({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
  // reviewer consumes 'pr' but pr NEVER exists in this wiring
  // Actually this would be caught by lint. Instead: a loop with a seedOwed input
  // that never gets provided.
  loop({ name: 'ghost', consumes: ['missing_thing'], produces: ['ghost_out'] }),
]);
```

Hmm — `missing_thing` would be a dangling consume, which `lint` catches. We need
a def where a loop is structurally valid but NEVER fires dynamically.

Better: a def with a conditional skip path where one branch always skips:

```ts
// A loop 'router' produces 'route'. Loop 'brancha' consumes 'route' and produces 'done'.
// Loop 'ghostloop' consumes 'route' AND 'never_green' (another seeded input that starts owed).
// 'never_green' starts owed and nothing produces it — so ghostloop is always blocked.
// But 'never_green' must have a producer... 
```

Actually the cleanest dead-loop scenario: a def where a loop is permanently blocked
because its consumed input can never be satisfied (because the only producer of
that input always skips it):

```ts
const deadLoopDef = def('deadloop', [input('proposal')], [
  loop({ name: 'router', consumes: ['proposal'], produces: ['signal'] }),
  // 'sidetrack' depends on 'signal' AND 'extra'; 'extra' is produced by 'extramaker'
  // but 'extramaker' consumes 'magic' which is never provided.
  // This requires dangling wiring = lint error.
```

Simplest valid approach: use the skip mechanic. Router always skips 'alt_signal'.
A downstream loop consuming 'alt_signal' never fires.

```ts
const deadLoopDef = def('deadloop', [input('proposal')], [
  loop({ name: 'main', consumes: ['proposal'], produces: ['result'] }),
  // 'sideloop' produces 'side_result' which consumes 'proposal' too,
  // but the checker models 'skip' as an outcome for 'sideloop'.
  // After skip, sideloop never fires again (unless inputs move).
  // But in the checker we DO explore skip, so sideloop DOES fire (just with skip outcome).
  // So we need something that NEVER gets a firing in the explored space.
]);
```

Honest approach: a loop that only fires after a specific chain that never happens
within the explored depth. Use `maxDepth` to create a scenario where a long chain
is never reached.

**Alternative clean dead-loop test**: use `maxDepth: 1` on a 3-step linear chain.
The third step (`merger`) never fires within depth 1. It appears in `deadLoops`.

```ts
const report = modelCheck(delivery, { maxDepth: 1, maxStates: 100 });
assert.ok(report.deadLoops.includes('merger'), 'merger never fires within depth 1');
assert.ok(report.bounded, 'search was truncated');
```

**Test D: `bounded` flag and exit-code semantics**

```ts
const report = modelCheck(delivery, { maxStates: 1, maxDepth: 1 });
assert.ok(report.bounded, 'should be bounded at maxStates=1');
assert.ok(report.boundsHit.length > 0);
// and verify exit code in CLI test:
// when bounded, exit 0 even if deadlocks array has entries
```

### Part 3: CLI `check` Tests

Add to `test/cli.test.ts` (or include in `test/check.test.ts` — either is fine;
prefer `check.test.ts` to keep it self-contained):

**Test E: text format on a healthy def**

```ts
const r = run('check', 'delivery');
assert.equal(r.code, 0);
assert.match(r.out, /oweflow check: delivery/);
assert.match(r.out, /Completable: yes/);
```

**Test F: json format**

```ts
const r = run('check', 'delivery', '--format', 'json');
assert.equal(r.code, 0);
const report = JSON.parse(r.out);
assert.ok('completable' in report);
assert.ok('deadlocks' in report);
assert.ok('deadLoops' in report);
assert.ok('bounded' in report);
```

**Test G: bounded search shows INCOMPLETE banner**

```ts
const r = run('check', 'delivery', '--max-states', '2', '--format', 'text');
assert.equal(r.code, 0, 'truncated search is not a defect → exit 0');
assert.match(r.out, /SEARCH INCOMPLETE/);
```

**Test H: unknown def exits 1 with known-names list**

```ts
const r = run('check', 'nonexistent');
assert.equal(r.code, 1);
assert.match(r.err, /unknown workflow definition/);
assert.match(r.err, /Known definitions:/);
```

**Test I: a def that has a definite deadlock → exit 1 when exhaustive**

Build a small deadlocking def (as in Test B above) in the defs dir:
```yaml
name: deadlocker
inputs:
  - name: start
loops:
  - name: a
    consumes: [start]
    produces: [x]
    maxAttempts: 1
    body: run a
  - name: b
    consumes: [x]
    produces: [y]
    body: run b
```
Write this to a temp defs dir, run check:
```ts
const r = run('check', 'deadlocker');  // with the deadlocker defs dir
assert.equal(r.code, 1, 'definite deadlock in exhaustive search → exit 1');
assert.match(r.err, /definite defects found/);
```

---

## V1 Collection Scope Decision

V1 **DOES include** collection modeling via `emit-seal`. The `applyEmitSeal`
helper branches on count 0..`maxCollectionSize` (default 2). This is explicitly
capped so fan-out stays bounded. The `bounded` flag is NOT set for collection
fan-out itself (we enumerate all sizes up to the cap); `bounded` is only set when
`maxDepth` or `maxStates` is hit.

However, if during BFS a collection producer emits N > `maxCollectionSize`
elements and then the state space explodes: the `maxStates` bound will catch it
and set `bounded`. The report will note which bounds were hit.

**Map loops**: map loops are modeled with `applyOutcome` on per-element firings —
`eligibleFirings` returns one firing per green element, and the checker explores
`green`/`judgment-reject`/`skip`/`retract` for each. This is already correct.

**Reduce loops**: reduce loops fire once the seal is green and all live members
are green. They are modeled as plain singleton firings in the checker (reduce
consumes produce `draft` etc.; the checker explores `green`/`judgment-reject`
outcomes).

---

## Edge Cases and Guards

1. **Convergence guard**: `settleInMemory` throws after 1000 iterations. This
   matches the engine's guard and will bubble as an uncaught error in `modelCheck`
   (which is a programming error, not a user error).

2. **Empty def / no loops**: `modelCheck` returns `completable: true` immediately
   (no debts in initial state means done=true).

3. **Inputs that are owed (seedOwed=true)**: the initial state has them owed.
   Since nothing can satisfy them (no loop produces input artifacts), and
   `eligibleFirings` only fires loops whose inputs are satisfied, the checker
   will report a deadlock at depth 0 (no eligible firings, not done). This is
   correct: a workflow created without providing a required input is stuck.
   In practice, the CLI should note this in the text output.

4. **Terminal artifacts**: once an artifact is green AND terminal, it cannot be
   re-armed by `maintainDecisions` (the `art.acceptance === 'green' && !art.terminal`
   check in `maintainDecisions`). The checker respects this because `applyOpInMemory`
   spreads `...art` which preserves `terminal: true`, and `maintainDecisions` skips
   re-cascade for terminal greens. But `applyOutcome` for `judgment-reject` on a
   terminal green artifact: the checker would still model it (but in practice a
   terminal green can't be judgment-rejected — it's irreversible). Guard: do not
   add `judgment-reject` to `eligibleOutcomes` if `firing.outputs[0]`'s artifact
   has `terminal: true`.

5. **Non-deterministic ordering**: BFS explores states in order; the shortest
   path to a deadlock is guaranteed to be reported first because BFS dequeues
   by distance.

6. **`reasons` field**: the in-memory twin does NOT maintain the reasons thread
   (no timestamps, no ReasonEntry objects). This is intentional — `reasons` is
   irrelevant to reachability. The conformance test does NOT compare `reasons`.

7. **`value` field**: also not maintained in the checker. The conformance test
   does NOT compare `value`.

8. **Born-rejected**: NOT modeled (per brief: single-threaded BFS, no CAS races).
   Add a comment in the code: `// born-rejected (CAS race) omitted — single-threaded exploration`.

---

## Import Addition for `model.ts`

At the top of model.ts, add to the existing `from './paths.ts'` import:
```ts
import { elementPath } from './paths.ts';
// (elementPath is likely already imported; verify — if not, add it)
```

And to the types import from `./types.ts`:
```ts
import type { ..., CheckOptions, CheckReport, CheckStep } from './types.ts';
```

---

## Verify

Run `npm run check` (= `tsc --noEmit && npm run test:quiet`) from the repo root.

The full suite must pass with ZERO new test failures. The new test file
`test/check.test.ts` is picked up automatically by `node --test test/*.test.ts`.

TypeScript must accept all new code with `strict` mode. Key things to check:
- `settleInMemory` parameter is `Map<string, ArtifactData>` (mutable) not
  `ReadonlyMap` — callers who start from a readonly source must clone first.
- `applyOutcome` returns `Array<Map<string, ArtifactData>>` — never undefined.
- `CheckOptions`, `CheckStep`, `CheckReport` are in `types.ts`, not `model.ts`,
  to avoid circular imports (model.ts already imports from types.ts, not vice versa).
- `modelCheck` must NOT import Engine, Store, or any IO module — confirmed by
  the purity constraint.

---

## Summary of Key Design Decisions

### How `settleInMemory` mirrors the engine

`Engine.settle()` (engine.ts:742) runs a loop:
1. Calls `pendingOwed(def, arts)` → materializes missing owed artifacts
2. Calls `maintainDecisions(def, arts)` → gets cascade ops
3. Calls `applyOp()` for each op, which does a `store.putArtifact(...)` with exact
   field spreads per op.kind.
4. Repeats until both lists are empty.

`settleInMemory` replicates this exactly, with `arts.set()` replacing
`store.putArtifact()`. The `applyOpInMemory` function mirrors `Engine.applyOp`
field-by-field:
- `rearm`: `{ ...art, acceptance: 'owed' }`
- `skip`: `{ ...art, acceptance: 'skipped', fingerprint: computeFingerprint(arts, requiredInputs(def, arts, art)) }`
- `reject`: `{ ...art, acceptance: 'rejected' }`
- `retract`: `{ ...art, acceptance: 'retracted' }`

The `reasons` field is preserved via `...art` (it's not modified) rather than
appended-to. This is intentional: the checker does not track the reasons thread.

### How the conformance test pins it

For each scenario, we:
1. Drive the REAL `Engine` on `openStore(':memory:')` through a concrete firing
   sequence.
2. Drive the SAME sequence through `applyOutcome`/`settleInMemory` starting from
   `seedArts(def)` (which exactly mirrors `Engine.createInstance` seeding).
3. Assert `deepEqual` on `{ acceptance, version, judgmentRejects, schemaRejects,
   fingerprint }` for every artifact path.

This pins the in-memory twin to the engine at the field level, not just at the
"status says done" level. If `applyOpInMemory` misses a field spread (e.g., forgets
to copy the fingerprint on skip), the conformance test will catch it.

### Canonicalization

States are deduped by a string key encoding sorted `path:acceptance:versionRank:jBucket:sBucket`
tuples plus skipped-fingerprint. Version rank (0/1/2) collapses the raw version
number so that "artifact greened 3 times and rejected" and "artifact greened 1 time
and rejected" deduplicate if their other fields match — reducing the state space
significantly for cyclic workflows. Reject counters are bucketed at their caps to
avoid infinite loops from incrementing.

### V1 Collection Scope

V1 includes collection fan-out via `applyEmitSeal` with `maxCollectionSize=2`
(default). Unbounded map fan-out is naturally bounded by `maxStates` and `maxDepth`.
The `bounded` flag is set if any BFS bound is hit. This is honest: "no deadlock
found within 5000 states" is clearly distinguished from "no deadlock exists".
