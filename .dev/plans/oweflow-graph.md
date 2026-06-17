# Build Plan: `oweflow graph <def-or-wf>` — DOT/Mermaid wiring renderer + live-state overlay

## Goal

Add a pure graph builder (`buildGraph`) and two string renderers (`graphToDot`, `graphToMermaid`) that turn a `WorkflowDef` (plus optional live artifacts) into a deterministic, pipe-ready graph text. Wire them into a new `graph` CLI command and re-export from `src/index.ts`. Zero new dependencies — hand-emit DOT and Mermaid strings.

---

## Verified Surfaces (worktree: /Users/alexrojas/code/oweflow-build/flow-5cd56f92)

- **`src/types.ts`**: `WorkflowDef`, `LoopDef`, `InputDef`, `ConsumePattern` (`mode: plain|map|reduce`, `stem`, `binder`, `suffix`), `ProducePattern` (`kind: singleton|collection|map`, `stem`, `binder`, `suffix`), `Acceptance`, `ArtifactData`. No graph types yet — add them here.
- **`src/paths.ts`**: `parseConsume`, `parseProduce`. Already-parsed patterns on `LoopDef.consumes`/`.produces` — do NOT re-parse strings; consume the structs.
- **`src/defs.ts`**: `validateDef` builds `producerOf: Map<stem, loopName>` at lines 238–268 (inputs → `'human'`; each `singleton`/`collection` produce → its loop name; `map` produces are NOT registered in this map). `detectCycles` and `reachabilityErrors` both use this map for edge derivation — the graph builder MUST replicate the same logic, not import or call these private functions.
- **`src/model.ts`**: `plainConsumes`, `mapConsume`, `reduceConsume`, `collectionStem`, `loopMode`, `isStalled`, `isSchemaStalled`, `workflowStatus`. `buildTrace` is the canonical pure-builder pattern: function at bottom of model.ts, no IO, no DB. Renderer for `buildTrace` text output lives **inline in `cli.ts`** (in the `trace` case block). **Therefore: graph renderers also live inline in `cli.ts`** (called from the `graph` case). The pure builder and types live in `model.ts`/`types.ts` respectively; the rendering strings are assembled in `cli.ts` at dispatch time.
- **`src/store.ts`**: `store.listArtifacts(wf): ArtifactRow[]`, `store.getWorkflow(wf): WorkflowRow | undefined` (fields: `.def: string`). `ArtifactRow extends ArtifactData` adding `id` and `updatedAt`.
- **`src/cli.ts`**: `dispatch` switch; `openCtx` returns `{ store, engine, defs, defsDir, dbPath }`; `print(io, v)` emits JSON; raw text via `io.out(line)` directly (like the `trace` text path); `CliError` for user-facing errors. `lint` uses `loadDefsRaw` (pre-`openCtx`) and resolves def name directly from `ctx.defs`; `trace` resolves def via `store.getWorkflow(wf).def` then `ctx.defs.get(defName)` — same pattern for `graph`.
- **`src/index.ts`**: exports surface; `buildTrace` and related model functions exported here. Add `buildGraph`, `graphToDot`, `graphToMermaid`, and the three graph types.
- **Test harness**: `node:test`, `node:assert/strict`. `helpers.ts` provides `def`, `loop`, `input`, `arts`. Tests drive `Engine` in-process for integration cases. CLI tests use `makeCli()` pattern. New test files: `test/graph.test.ts` and additions to `test/cli.test.ts`.

---

## Files to Touch

| File | Change |
|------|--------|
| `src/types.ts` | Add `WorkflowGraph`, `GraphNode`, `GraphEdge` type declarations |
| `src/model.ts` | Add `buildGraph(def, artifacts?)` pure function |
| `src/cli.ts` | Add `graph` case to dispatch switch + inline renderers `graphToDot` / `graphToMermaid` + USAGE update |
| `src/index.ts` | Re-export `buildGraph`, `graphToDot`, `graphToMermaid`, `WorkflowGraph`, `GraphNode`, `GraphEdge` |
| `test/graph.test.ts` | New: `buildGraph` unit tests + overlay tests + renderer tests |
| `test/cli.test.ts` | Append: `graph` command CLI tests |

**DO NOT touch**: `src/defs.ts`, `src/paths.ts`, `src/store.ts`, `src/engine.ts`, any example YAML.

---

## Step 1 — New Types in `src/types.ts`

Append to the end of the file (after the `WorkflowTrace` block):

```typescript
// ---- graph types (§spatial view: wiring + live-state overlay) ----------------

/** The "color" of a node in a live-overlay graph. Derived from artifact acceptance + stall state. */
export type GraphNodeState =
  | 'green'      // all outputs are green
  | 'owed'       // at least one output is owed (in-flight or unbuilt)
  | 'rejected'   // at least one rejected, none stalled
  | 'stalled'    // at least one rejected AND past its producer cap
  | 'skipped'    // all outputs are skipped (dead branch)
  | 'retracted'  // all outputs are retracted
  | 'none';      // no artifact data (static view or no artifacts yet)

/** One node in the wiring graph: either a loop or an external input. */
export interface GraphNode {
  id: string;              // stable identifier: loop name or input name
  kind: 'loop' | 'input';
  label: string;           // display label (same as id for now)
  terminal?: boolean;      // loops only: declared terminal
  parallel?: number;       // loops only: parallelism setting
  model?: string;          // loops only: model hint
  /** Overlay: present only when artifacts were supplied to buildGraph */
  state?: GraphNodeState;
  /** Overlay: true when any output artifact is stalled */
  stalled?: boolean;
}

/** One directed edge: producer → consumer. */
export interface GraphEdge {
  from: string;            // node id (loop name or input name)
  to: string;              // loop node id
  stem: string;            // the artifact stem crossing this edge
  mode: 'plain' | 'map' | 'reduce'; // consume mode at the to-node
  /** For map: the binder name (e.g. "i") — used for label generation */
  binder?: string;
}

/** The complete wiring graph for one workflow definition. */
export interface WorkflowGraph {
  def: string;             // workflow definition name
  nodes: GraphNode[];      // sorted by id for determinism
  edges: GraphEdge[];      // sorted by (from, to, stem) for determinism
  /** true when artifacts were provided (overlay mode) */
  hasOverlay: boolean;
}
```

---

## Step 2 — Pure Builder in `src/model.ts`

Add at the end of `model.ts` (after `buildTrace`). Import the new graph types at the top of the file alongside the existing type imports.

### Import addition (top of model.ts)
Add to the existing type import from `'./types.ts'`:
```typescript
  GraphEdge,
  GraphNode,
  GraphNodeState,
  WorkflowGraph,
```

### Function: `buildGraph`

```typescript
/**
 * Build a structural wiring graph for a workflow definition.
 * When `artifacts` are provided, annotate each node with the live acceptance
 * state derived from the artifact set (overlay mode).
 *
 * Pure — no IO, no clock, no DB. Same purity contract as buildTrace.
 *
 * Edge derivation replicates validateDef's producerOf map exactly:
 *   inputs → 'human' (an input-kind node with that name)
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
  const producerOf = new Map<string, string>(); // stem → node id ('human' for inputs)
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
      // Resolve producer: for plain, look up c.stem; for map/reduce, look up c.stem (collection)
      const producerNode = producerOf.get(c.stem)
        ?? (collectionStems.has(c.stem) ? producerOf.get(c.stem) : undefined)
        ?? `__dangling__${c.stem}`;

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

    // Group artifacts by their producer (loop or input name)
    const byProducer = new Map<string, ArtifactData[]>();
    for (const a of artifacts) {
      const existing = byProducer.get(a.producer) ?? [];
      existing.push(a);
      byProducer.set(a.producer, existing);
    }

    for (const node of nodes) {
      const nodeArts = byProducer.get(node.id) ?? [];
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
```

**Key design decisions in `buildGraph`:**
- `producerOf` entries use **node id** (input name or loop name), not the string `'human'`. This avoids a special case in edge rendering — the "human" input node id IS the input name (e.g. `proposal`), which matches exactly what the edge's `from` field needs.
- `collectionStems`: map/reduce consumes resolve via `producerOf.get(c.stem)` — the collection stem IS registered for `collection` produces (same as `validateDef` does).
- Dangling consumes (invalid defs that lint already reports) produce a synthetic from-id `__dangling__<stem>` and still render — they just appear as unconnected edges from a phantom node, which makes the bad wiring visible in the graph.
- Self-edges are silently dropped (can't occur in a valid def, but defensive).
- Worst-state priority: stalled > rejected > owed > skipped/retracted > green. A node with mixed outputs (e.g. one green, one owed) shows the worst.
- `hasOverlay` is false when no artifacts are passed, OR when the artifacts array is empty (e.g. a just-created instance that has not yet materialized any artifact rows).

---

## Step 3 — Renderers and CLI Command in `src/cli.ts`

The `buildTrace` text renderer lives inline in `cli.ts` inside the `trace` case. Follow the same pattern: `graphToDot` and `graphToMermaid` are plain functions **defined at module scope inside `cli.ts`** (not exported — only the CLI uses them; `index.ts` re-exports them from model.ts). Wait — the brief says to re-export them from `index.ts`. So they must be exported from somewhere importable. Since `cli.ts` is not in the public API surface (`index.ts` does not import from `cli.ts`), the renderers must live in `model.ts` (or a new file), NOT inline in `cli.ts`.

**Decision**: Put `graphToDot` and `graphToMermaid` at the bottom of `src/model.ts` alongside `buildGraph`, so `index.ts` can re-export them from `'./model.ts'`. Call them from `cli.ts` after importing. This is analogous to how `buildTrace` is in `model.ts` and called in `cli.ts`.

### 3a. Add renderers to `src/model.ts`

Import `WorkflowGraph`, `GraphNode`, `GraphEdge` (already imported via the types import above).

#### `graphToDot(g: WorkflowGraph): string`

```
digraph "<def-name>" {
  rankdir=LR;
  node [fontname="Helvetica"];

  // nodes — sorted (already sorted on g.nodes)
  "<id>" [label="<label>", shape=<shape>, <style attrs>];
  ...

  // edges — sorted (already sorted on g.edges)
  "<from>" -> "<to>" [label="<edge-label>", style=<edge-style>];
  ...
}
```

**Node shapes:**
- `kind === 'input'`: `shape=ellipse`
- `kind === 'loop'` and `terminal === true`: `shape=doublecircle`
- `kind === 'loop'` otherwise: `shape=box`

**Overlay fill colors** (when `g.hasOverlay` and `node.state !== 'none'`):
- `green`: `fillcolor="#c8e6c9"` (light green)
- `owed`: `fillcolor="#e0e0e0"` (light grey)
- `rejected`: `fillcolor="#ffcc80"` (orange)
- `stalled`: `fillcolor="#ef9a9a"` (red/pink)
- `skipped`: `fillcolor="#f5f5f5"` (near-white, dashed border)
- `retracted`: `fillcolor="#eeeeee"` (grey, dashed border)
- `none`: no fillcolor (transparent)

When overlay present: add `style=filled` for states green/owed/rejected/stalled; add `style="filled,dashed"` for skipped/retracted.

When no overlay: no fill attributes.

**Edge labels and styles by mode:**
- `plain`: no label, `style=solid`
- `map`: label = `"map [$binder]"` (e.g. `"map [$i]"`), `style=dashed`
- `reduce`: label = `"reduce [*]"`, `style=bold`

**Label escaping**: replace `"` with `\"` in all string values embedded in the DOT output. Node ids and labels that may contain dots, brackets, or special chars must be quoted (always quote with `"`).

**Dangling nodes**: if an edge has `from` starting with `__dangling__`, emit a corresponding node `"__dangling__<stem>"` with `[label="(missing: <stem>)", shape=plaintext, color=red]`. Collect these from edges before emitting nodes.

**Determinism**: nodes already sorted; edges already sorted. Emit in that order.

#### `graphToMermaid(g: WorkflowGraph): string`

```
flowchart LR
  %% nodes
  nodeId["label"]
  ...

  %% classDefs for overlay
  classDef green fill:#c8e6c9,stroke:#333;
  classDef owed fill:#e0e0e0,stroke:#333;
  classDef rejected fill:#ffcc80,stroke:#333;
  classDef stalled fill:#ef9a9a,stroke:#333;
  classDef skipped fill:#f5f5f5,stroke:#333,stroke-dasharray:5;
  classDef retracted fill:#eeeeee,stroke:#333,stroke-dasharray:5;

  %% edges
  fromId -->|"edge label"| toId
  fromId --> toId  (no label for plain)
  ...

  %% class assignments (only when overlay present)
  class nodeId green
  ...
```

**Mermaid node shapes:**
- `kind === 'input'`: `nodeId(("label"))` — circle/ellipse
- `kind === 'loop'` and `terminal === true`: `nodeId(["label"])` — stadium/rounded
- `kind === 'loop'` otherwise: `nodeId["label"]` — rectangle

**Mermaid ids**: Mermaid node ids must be alphanumeric + underscore. Convert the node id by replacing `.`, `[`, `]`, `-` and other non-alphanum chars with `_`. Example: `gather.source` → `gather_source`. Keep a mapping from original id to mermaid id for edge emission. Input node ids like `proposal` are already clean.

**Edge labels:**
- `plain`: no label — `from --> to`
- `map`: `from -->|"map [$binder]"| to`
- `reduce`: `from -->|"reduce [*]"| to`

**Overlay**: emit `classDef` block at top (after nodes), then emit `class <id> <state>` lines at end only when `g.hasOverlay` is true. If `node.state === 'none'`, skip the class assignment.

**Dangling**: emit a node `dangling_<stem>` with label `(missing: <stem>)` for any `__dangling__` edge from-id. Style with `style dangling_<stem> stroke:red`.

**Determinism**: emit in sorted node/edge order (already sorted).

### 3b. Imports to add in `src/cli.ts`

```typescript
import { buildGraph, buildTrace, graphToDot, graphToMermaid } from './model.ts';
```
(Replace the existing `import { buildTrace } from './model.ts'`.)

Also add the new type import:
```typescript
import type { WorkflowDef, WorkflowGraph } from './types.ts';
```
(The existing `import type { WorkflowDef }` becomes `import type { WorkflowDef, WorkflowGraph }`.)

Actually `WorkflowGraph` may only be needed as a type for `print(io, g)` — verify at build time whether this import is required or inferred.

### 3c. `graph` case in `dispatch` switch

Insert before the `default:` case, inside the `try` block (after `store` is opened via `openCtx`):

```typescript
case 'graph': {
  const arg = need(args, 1, 'def-name or workflow-id');
  const format = last(args, 'format') ?? 'dot';

  let def: WorkflowDef;
  let artifacts: ArtifactRow[] | undefined;

  if (ctx.defs.has(arg)) {
    // static mode: arg is a def name
    def = ctx.defs.get(arg)!;
    artifacts = undefined;
  } else {
    // live mode: arg is a workflow instance id
    const wfRow = store.getWorkflow(arg);
    if (!wfRow) {
      throw new CliError(
        `'${arg}' is neither a known workflow definition nor a workflow instance id.\n` +
        `Known definitions: ${[...ctx.defs.keys()].sort().join(', ') || '(none)'}`
      );
    }
    const defName = wfRow.def;
    const resolvedDef = ctx.defs.get(defName);
    if (!resolvedDef) {
      throw new CliError(
        `workflow instance '${arg}' uses definition '${defName}' which is not available (looked in ${ctx.defsDir})`
      );
    }
    def = resolvedDef;
    artifacts = store.listArtifacts(arg);
  }

  const graph = buildGraph(def, artifacts);

  if (format === 'json') {
    print(io, graph);
  } else if (format === 'mermaid') {
    io.out(graphToMermaid(graph));
  } else {
    // default: dot
    io.out(graphToDot(graph));
  }
  return;
}
```

### 3d. Update USAGE string

Add the following line to the `Commands:` block (after the `trace` line):
```
  graph <def-or-wf> [--format dot|mermaid|json]   wiring graph (+ live overlay if wf id)
```

---

## Step 4 — Re-exports in `src/index.ts`

Add to the `export { ... } from './model.ts'` block:
```typescript
  buildGraph,
  graphToDot,
  graphToMermaid,
```

Add to the `export type { ... } from './model.ts'` block:
```typescript
  WorkflowGraph,
```

Wait — `WorkflowGraph`, `GraphNode`, `GraphEdge`, `GraphNodeState` live in `types.ts`, not `model.ts`. So they must be added to the `export type { ... } from './types.ts'` block:
```typescript
  GraphEdge,
  GraphNode,
  GraphNodeState,
  WorkflowGraph,
```

And `buildGraph`, `graphToDot`, `graphToMermaid` are added to `export { ... } from './model.ts'`.

---

## Step 5 — Tests

### `test/graph.test.ts` (new file)

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { buildGraph, graphToDot, graphToMermaid } from '../src/model.ts';
import { def, input, loop } from './helpers.ts';
```

#### Fixture def (reuse delivery + research shapes)
```typescript
// delivery: linear chain
const delivery = def('delivery', [input('proposal')], [
  loop({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
  loop({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
  loop({ name: 'reviewer', consumes: ['pr'], produces: ['verdict'] }),
  loop({ name: 'merger', consumes: ['verdict'], produces: ['merge'], terminal: true }),
]);

// research: collection + map + reduce
const research = def('research', [input('question')], [
  loop({ name: 'gather', consumes: ['question'], produces: ['gather.source[]'] }),
  loop({ name: 'formatcheck', consumes: ['gather.source[$i]'], produces: ['gather.source[$i].formatcheck'] }),
  loop({ name: 'synthesize', consumes: ['gather.source[*]'], produces: ['draft'] }),
]);
```

#### Test 1: node set (delivery)
```
test('buildGraph: nodes = loops + inputs, all present', () => {
  const g = buildGraph(delivery);
  const ids = g.nodes.map(n => n.id).sort();
  assert.deepEqual(ids, ['builder', 'merger', 'planner', 'proposal', 'reviewer']);
  assert.equal(g.nodes.find(n => n.id === 'proposal')!.kind, 'input');
  assert.equal(g.nodes.find(n => n.id === 'merger')!.terminal, true);
  assert.equal(g.nodes.find(n => n.id === 'planner')!.kind, 'loop');
  assert.equal(g.hasOverlay, false);
});
```

#### Test 2: edge set and direction (delivery)
```
test('buildGraph: edges reflect producer→consumer direction', () => {
  const g = buildGraph(delivery);
  // proposal -> planner (plain, stem=proposal)
  const e1 = g.edges.find(e => e.from === 'proposal' && e.to === 'planner');
  assert.ok(e1);
  assert.equal(e1!.mode, 'plain');
  assert.equal(e1!.stem, 'proposal');
  // planner -> builder (plan), builder -> reviewer (pr), reviewer -> merger (verdict)
  assert.ok(g.edges.find(e => e.from === 'planner' && e.to === 'builder'));
  assert.ok(g.edges.find(e => e.from === 'builder' && e.to === 'reviewer'));
  assert.ok(g.edges.find(e => e.from === 'reviewer' && e.to === 'merger'));
  assert.equal(g.edges.length, 4);
});
```

#### Test 3: map/reduce edge modes (research)
```
test('buildGraph: map consume produces map-mode edge, reduce produces reduce-mode edge', () => {
  const g = buildGraph(research);
  // gather → formatcheck: map mode (gather.source[$i])
  const mapEdge = g.edges.find(e => e.from === 'gather' && e.to === 'formatcheck');
  assert.ok(mapEdge, 'map edge exists');
  assert.equal(mapEdge!.mode, 'map');
  assert.equal(mapEdge!.stem, 'gather.source');
  assert.equal(mapEdge!.binder, 'i');
  // gather → synthesize: reduce mode (gather.source[*])
  const reduceEdge = g.edges.find(e => e.from === 'gather' && e.to === 'synthesize');
  assert.ok(reduceEdge, 'reduce edge exists');
  assert.equal(reduceEdge!.mode, 'reduce');
  assert.equal(reduceEdge!.stem, 'gather.source');
});
```

#### Test 4: terminal loop flagged
```
test('buildGraph: terminal loop is flagged on the node', () => {
  const g = buildGraph(delivery);
  assert.equal(g.nodes.find(n => n.id === 'merger')!.terminal, true);
  assert.equal(g.nodes.find(n => n.id === 'planner')!.terminal, undefined);
});
```

#### Test 5: dangling consume renders, does not crash
```
test('buildGraph: dangling consume renders without crashing', () => {
  // Build a def that has a loop consuming a stem with no producer
  // (normally lint would error on this, but graph must not crash)
  const d = def('broken', [input('seed')], [
    loop({ name: 'a', consumes: ['seed'], produces: ['mid'] }),
    loop({ name: 'b', consumes: ['ghost'], produces: ['out'] }), // ghost has no producer
  ]);
  const g = buildGraph(d);
  // There should be a dangling edge for ghost
  const danglingEdge = g.edges.find(e => e.to === 'b' && e.stem === 'ghost');
  assert.ok(danglingEdge, 'dangling edge exists');
  assert.ok(danglingEdge!.from.startsWith('__dangling__'), 'dangling from-id has sentinel prefix');
  // And the DOT renderer should not throw
  assert.doesNotThrow(() => graphToDot(g));
  assert.doesNotThrow(() => graphToMermaid(g));
});
```

#### Test 6: overlay — drive engine to mixed state
```
test('buildGraph overlay: mixed artifact state annotates nodes correctly', () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, () => delivery);

  const wf = engine.createInstance('delivery', { provide: { proposal: { text: 'x' } } });

  // Green planner's output (plan)
  const tick1 = engine.tick(wf);
  const plannerOrder = tick1.orders[0]!;
  engine.green(wf, plannerOrder.run, 'plan', { plan: 'v1' });
  engine.close(wf, plannerOrder.run, 'ok');

  // Do NOT advance further — builder's 'pr' is still owed
  const artifacts = store.listArtifacts(wf);
  const g = buildGraph(delivery, artifacts);

  assert.equal(g.hasOverlay, true);

  // proposal input was provided at create: should be green
  const proposalNode = g.nodes.find(n => n.id === 'proposal');
  assert.ok(proposalNode, 'proposal node exists');
  assert.equal(proposalNode!.state, 'green');

  // planner produced plan (green)
  const plannerNode = g.nodes.find(n => n.id === 'planner');
  assert.equal(plannerNode!.state, 'green');

  // builder's pr is owed
  const builderNode = g.nodes.find(n => n.id === 'builder');
  assert.equal(builderNode!.state, 'owed');

  store.close();
});
```

#### Test 7: stall annotation
```
test('buildGraph overlay: stalled artifact sets node.stalled = true and state = stalled', () => {
  const store = new Store(':memory:');
  // Use maxAttempts=1 so one reject immediately stalls
  const d = def('small', [input('seed')], [
    loop({ name: 'worker', consumes: ['seed'], produces: ['out'], maxAttempts: 1 }),
  ]);
  const engine = new Engine(store, () => d);
  const wf = engine.createInstance('small', { provide: { seed: {} } });

  // Worker fires, produces out, gets judged rejected → stall immediately
  const tick = engine.tick(wf);
  const order = tick.orders[0]!;
  engine.green(wf, order.run, 'out', { v: 1 });
  engine.close(wf, order.run, 'ok');
  engine.reject(wf, 'out', 'reviewer', 'bad');

  const artifacts = store.listArtifacts(wf);
  const g = buildGraph(d, artifacts);

  const workerNode = g.nodes.find(n => n.id === 'worker');
  assert.equal(workerNode!.state, 'stalled');
  assert.equal(workerNode!.stalled, true);

  store.close();
});
```

#### Test 8: determinism
```
test('buildGraph + renderers are deterministic (calling twice yields identical output)', () => {
  const g1 = buildGraph(research);
  const g2 = buildGraph(research);
  assert.deepEqual(g1.nodes, g2.nodes);
  assert.deepEqual(g1.edges, g2.edges);

  const dot1 = graphToDot(g1);
  const dot2 = graphToDot(g2);
  assert.equal(dot1, dot2, 'DOT output is identical across calls');

  const mmd1 = graphToMermaid(g1);
  const mmd2 = graphToMermaid(g2);
  assert.equal(mmd1, mmd2, 'Mermaid output is identical across calls');
});
```

#### Test 9: DOT renderer content assertions
```
test('graphToDot: contains digraph, node ids, and -> edges', () => {
  const g = buildGraph(delivery);
  const dot = graphToDot(g);
  assert.match(dot, /digraph/, 'contains digraph keyword');
  assert.match(dot, /"planner"/, 'planner node present');
  assert.match(dot, /"proposal"/, 'proposal node present');
  assert.match(dot, /->/, 'has at least one edge');
  // ellipse for input node
  assert.match(dot, /shape=ellipse/, 'input node has ellipse shape');
  // doublecircle for terminal
  assert.match(dot, /shape=doublecircle/, 'terminal loop has doublecircle shape');
});
```

#### Test 10: Mermaid renderer content assertions
```
test('graphToMermaid: contains flowchart and edge arrow', () => {
  const g = buildGraph(delivery);
  const mmd = graphToMermaid(g);
  assert.match(mmd, /flowchart/, 'starts with flowchart keyword');
  assert.match(mmd, /-->/, 'has at least one edge arrow');
});
```

#### Test 11: overlay colors appear in DOT output
```
test('graphToDot: overlay fill colors appear in output when artifacts are supplied', () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, () => delivery);
  const wf = engine.createInstance('delivery', { provide: { proposal: { text: 'x' } } });
  const tick = engine.tick(wf);
  const order = tick.orders[0]!;
  engine.green(wf, order.run, 'plan', { plan: 'v1' });
  engine.close(wf, order.run, 'ok');

  const artifacts = store.listArtifacts(wf);
  const g = buildGraph(delivery, artifacts);
  const dot = graphToDot(g);
  assert.match(dot, /fillcolor/, 'overlay colors present in DOT');
  assert.match(dot, /style=filled/, 'style=filled present for colored nodes');
  store.close();
});
```

#### Test 12: overlay colors appear in Mermaid output
```
test('graphToMermaid: classDef and class assignments appear when overlay present', () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, () => delivery);
  const wf = engine.createInstance('delivery', { provide: { proposal: { text: 'x' } } });
  const tick = engine.tick(wf);
  const order = tick.orders[0]!;
  engine.green(wf, order.run, 'plan', { plan: 'v1' });
  engine.close(wf, order.run, 'ok');

  const artifacts = store.listArtifacts(wf);
  const g = buildGraph(delivery, artifacts);
  const mmd = graphToMermaid(g);
  assert.match(mmd, /classDef/, 'Mermaid classDef present');
  assert.match(mmd, /class /, 'class assignment present');
  store.close();
});
```

#### Test 13: no-artifacts static mode
```
test('buildGraph with no artifacts: hasOverlay=false, no node.state fields', () => {
  const g = buildGraph(delivery);
  assert.equal(g.hasOverlay, false);
  for (const n of g.nodes) {
    assert.equal(n.state, undefined, `${n.id} should have no state in static mode`);
  }
});
```

### Additions to `test/cli.test.ts`

Append these tests at the end of the file:

```typescript
// ---- graph command ----------------------------------------------------------

test('graph <def-name> emits DOT containing digraph and node ids', () => {
  const { run } = makeCli();
  const r = run('graph', 'delivery');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /digraph/);
  assert.match(r.out, /planner/);
  assert.match(r.out, /proposal/);
});

test('graph --format mermaid emits flowchart', () => {
  const { run } = makeCli();
  const r = run('graph', 'delivery', '--format', 'mermaid');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /flowchart/);
  assert.match(r.out, /-->/);
});

test('graph <wf-id> emits overlay-colored DOT', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  // Drive planner to green so at least one node is colored
  const order = run('tick', wf).json().orders[0];
  run('green', wf, order.run, 'plan', '--value', J({ plan: 'v1' }));
  run('close', wf, order.run);

  const r = run('graph', wf);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /digraph/);
  assert.match(r.out, /fillcolor/, 'overlay colors present');
});

test('graph --format json emits the structured WorkflowGraph', () => {
  const { run } = makeCli();
  const r = run('graph', 'delivery', '--format', 'json');
  assert.equal(r.code, 0, r.err);
  const g = r.json();
  assert.equal(g.def, 'delivery');
  assert.ok(Array.isArray(g.nodes), 'has nodes array');
  assert.ok(Array.isArray(g.edges), 'has edges array');
  assert.equal(typeof g.hasOverlay, 'boolean');
});

test('graph with an unknown arg exits 1 with a helpful message listing known defs', () => {
  const { run } = makeCli();
  const r = run('graph', 'no-such-thing');
  assert.equal(r.code, 1);
  assert.match(r.err, /neither a known workflow definition/);
  assert.match(r.err, /delivery/, 'error lists known def names');
});

test('graph missing arg exits 1 with labelled error', () => {
  const { run } = makeCli();
  const r = run('graph');
  assert.equal(r.code, 1);
  assert.match(r.err, /missing required argument/);
});
```

---

## Detailed Renderer Pseudocode

### `graphToDot(g: WorkflowGraph): string`

```
function graphToDot(g):
  lines = []
  lines.push(`digraph "${dotEscape(g.def)}" {`)
  lines.push('  rankdir=LR;')
  lines.push('  node [fontname="Helvetica"];')
  lines.push('')

  // Collect dangling node ids from edges
  danglingIds = new Set(
    g.edges
      .filter(e => e.from.startsWith('__dangling__'))
      .map(e => e.from)
  )

  // Emit dangling phantom nodes (before real nodes)
  for id of [...danglingIds].sort():
    stem = id.slice('__dangling__'.length)
    lines.push(`  "${dotEscape(id)}" [label="(missing: ${dotEscape(stem)})", shape=plaintext, color=red];`)

  // Emit real nodes
  for node of g.nodes:
    shape = node.kind === 'input' ? 'ellipse'
            : node.terminal ? 'doublecircle'
            : 'box'
    attrs = [`shape=${shape}`]
    attrs.push(`label="${dotEscape(node.label)}"`)
    if g.hasOverlay and node.state and node.state !== 'none':
      fillcolor = STATE_FILL_COLORS[node.state]
      style = (node.state === 'skipped' or node.state === 'retracted') ? '"filled,dashed"' : 'filled'
      attrs.push(`style=${style}`)
      attrs.push(`fillcolor="${fillcolor}"`)
    lines.push(`  "${dotEscape(node.id)}" [${attrs.join(', ')}];`)

  lines.push('')

  // Emit edges
  for edge of g.edges:
    edgeAttrs = []
    if edge.mode === 'map':
      edgeAttrs.push(`label="map [${dotEscape(edge.binder ?? '$i')}]"`)
      edgeAttrs.push('style=dashed')
    elif edge.mode === 'reduce':
      edgeAttrs.push('label="reduce [*]"')
      edgeAttrs.push('style=bold')
    else:
      edgeAttrs.push('style=solid')
    attrStr = edgeAttrs.length ? ` [${edgeAttrs.join(', ')}]` : ''
    lines.push(`  "${dotEscape(edge.from)}" -> "${dotEscape(edge.to)}"${attrStr};`)

  lines.push('}')
  return lines.join('\n')

function dotEscape(s):
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
```

STATE_FILL_COLORS:
```
green:     '#c8e6c9'
owed:      '#e0e0e0'
rejected:  '#ffcc80'
stalled:   '#ef9a9a'
skipped:   '#f5f5f5'
retracted: '#eeeeee'
```

### `graphToMermaid(g: WorkflowGraph): string`

```
function graphToMermaid(g):
  // Build a safe mermaid id for each node id
  function mmdId(id):
    // Replace chars that Mermaid reserves: . [ ] - space → _
    // Also handle __dangling__ prefix
    if id.startsWith('__dangling__'):
      return 'dangling_' + id.slice('__dangling__'.length).replace(/[^a-zA-Z0-9]/g, '_')
    return id.replace(/[^a-zA-Z0-9_]/g, '_')

  lines = []
  lines.push('flowchart LR')

  // Collect dangling ids
  danglingIds = new Set(g.edges.filter(e => e.from.startsWith('__dangling__')).map(e => e.from))

  // Emit dangling phantom nodes
  for id of [...danglingIds].sort():
    stem = id.slice('__dangling__'.length)
    mid = mmdId(id)
    lines.push(`  ${mid}["(missing: ${mmdEscape(stem)})"]`)
    lines.push(`  style ${mid} stroke:red`)

  // Emit real nodes
  for node of g.nodes:
    mid = mmdId(node.id)
    lbl = mmdEscape(node.label)
    if node.kind === 'input':
      lines.push(`  ${mid}(("${lbl}"))`)
    elif node.terminal:
      lines.push(`  ${mid}(["${lbl}"])`)  // stadium shape
    else:
      lines.push(`  ${mid}["${lbl}"]`)

  lines.push('')

  // Emit classDefs (always, so overlay class assignments work; harmless if unused)
  if g.hasOverlay:
    lines.push('  classDef green fill:#c8e6c9,stroke:#333;')
    lines.push('  classDef owed fill:#e0e0e0,stroke:#333;')
    lines.push('  classDef rejected fill:#ffcc80,stroke:#333;')
    lines.push('  classDef stalled fill:#ef9a9a,stroke:#333;')
    lines.push('  classDef skipped fill:#f5f5f5,stroke:#333,stroke-dasharray:5 5;')
    lines.push('  classDef retracted fill:#eeeeee,stroke:#333,stroke-dasharray:5 5;')
    lines.push('')

  // Emit edges
  for edge of g.edges:
    from = mmdId(edge.from)
    to = mmdId(edge.to)
    if edge.mode === 'map':
      lines.push(`  ${from} -->|"map [${mmdEscape(edge.binder ?? '$i')}]"| ${to}`)
    elif edge.mode === 'reduce':
      lines.push(`  ${from} -->|"reduce [*]"| ${to}`)
    else:
      lines.push(`  ${from} --> ${to}`)

  lines.push('')

  // Emit class assignments
  if g.hasOverlay:
    for node of g.nodes:
      if node.state and node.state !== 'none':
        lines.push(`  class ${mmdId(node.id)} ${node.state}`)

  return lines.join('\n')

function mmdEscape(s):
  // Mermaid uses " for label delimiters; escape any " inside
  return s.replace(/"/g, '#quot;')
```

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Dangling consume (lint errors, but graph called on invalid def) | Edge emitted from `__dangling__<stem>` phantom node; rendered as a red plaintext/red-border phantom — never crashes |
| Terminal loop | `shape=doublecircle` in DOT; stadium shape `([...])` in Mermaid |
| Map loop | Edge `mode=map`, `binder` carried; label "map [$i]" / `style=dashed` |
| Reduce loop | Edge `mode=reduce`; label "reduce [*]" / `style=bold` |
| No artifacts (static mode) | `hasOverlay=false`; no fill attrs; no classDef in Mermaid; no `node.state` fields |
| Empty artifacts array | Same as no artifacts — `hasOverlay=false` |
| Mixed node states | Worst-state wins per node (stalled > rejected > owed > skipped/retracted > green) |
| A node's artifacts are all `none` (no entries for that producer) | `state='none'`, no overlay color |
| Unknown workflow arg | `CliError` with message listing all known def names |
| `--format` absent | Defaults to `dot` |
| `--format json` | `print(io, graph)` — structured JSON via the existing print() helper |
| Def with a single loop and no inputs | Renders correctly — no input nodes; self-edge guard fires if a loop were to consume its own output (can't happen in a valid def) |
| Mermaid id collision from normalization | Two stems `a.b` and `a_b` would both normalize to `a_b`. In practice this can't happen in a valid def (stems are unique). Guard if desired by appending a numeric suffix, but omit for now (not required by brief) |
| Multiple produces from one loop (e.g. gather produces `gather.source[]`) | The collection stem `gather.source` is in `producerOf`; map produces `gather.source[$i].formatcheck` are NOT — they don't generate extra nodes or edges, as per the brief's "keep it loop+input centric" design |
| `--format mermaid` on a workflow with overlay | `classDef` and `class` lines emitted |

---

## Verify

Run: `npm run check` — this runs `tsc --noEmit` (full TypeScript check with no emitted files) followed by the full node:test suite. All existing tests must continue to pass. The new tests must also pass.

Zero new dependencies. All graph text is hand-emitted. No changes to `src/defs.ts`, `src/paths.ts`, `src/store.ts`, `src/engine.ts`.

---

## Summary of Key Design Decisions

1. **Renderers location**: `graphToDot` and `graphToMermaid` live in `src/model.ts` (not inline in `cli.ts`) because `src/index.ts` must re-export them and `index.ts` does not import from `cli.ts`. This mirrors where `buildGraph` lives. The rendering calls in `cli.ts` import from `'./model.ts'`.

2. **`producerOf` uses node ids, not `'human'`**: Input names are both the `InputDef.name` AND the node id in the graph, so `producerOf.set(inp.name, inp.name)` directly gives the correct edge from-id without any special-casing of `'human'` strings.

3. **Map produces NOT registered in `producerOf`**: Exactly as `validateDef` does — map per-element outputs (`gather.source[$i].formatcheck`) are per-element children and are not top-level stems with their own producer entries. Only `singleton` and `collection` kinds register.

4. **Collection stem resolution for map/reduce edges**: A map consume like `gather.source[$i]` has `c.stem = 'gather.source'`. That stem is registered in `producerOf` by the `collection` produce from `gather`. The same `producerOf.get(c.stem)` lookup resolves it — no special path needed.

5. **Overlay worst-state priority**: stalled (either kind) > rejected (non-stalled) > owed > skipped/retracted (all) > green. A node with a mix of green and owed outputs shows `owed`. A node where all outputs are skipped shows `skipped`, but one green + one skipped shows `green`.

6. **`hasOverlay` semantics**: `true` only when `artifacts` array is provided AND non-empty. An empty artifact array (e.g. a just-created instance) falls back to static mode visually, which is more useful than showing every node as `none`.

7. **Mermaid id safety**: All non-`[a-zA-Z0-9_]` chars replaced with `_`. The `__dangling__` prefix is mapped to `dangling_`. In practice valid def node ids are loop names and input names (alphanumeric + `-` + `_` from YAML parsing constraints), so the replacement mainly handles `-`.

8. **Determinism**: `nodes` and `edges` sorted in `buildGraph` before return. Both renderers iterate in received order. Since the graph struct is sorted, renderer output is stable.
