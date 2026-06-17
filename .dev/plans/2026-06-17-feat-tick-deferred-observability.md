# Build Plan: tick observability — `deferred` channel on `TickResult`

## 1. Goal

Extend `Engine.tick()` to return a `deferred: DeferredFiring[]` field alongside the existing `orders` and `reaped` fields. Each `DeferredFiring` is an eligible firing that did not become an order this tick, tagged with one of four machine-readable reasons: `'in-flight'`, `'cadence'`, `'daily-budget'`, or `'parallel-cap'`. No logic that selects or claims firings changes; only instrumentation is added. The `deferred` field is always present (empty array when idle or on a normal order-emitting tick), so downstream consumers can rely on the field existing unconditionally.

## 2. Files to Touch

- `src/engine.ts` — New `DeferredFiring` interface + `DeferredReason` union; `TickResult` extended with `deferred`; `applySchedule` returns `{ selected, deferred }`; `claim` returns `Order | 'in-flight' | null`; `tick` assembles the final `deferred` array.
- `src/index.ts` — Re-export `DeferredFiring` (and `DeferredReason`).
- `test/engine.test.ts` — New tests for in-flight (required), cadence, daily-budget, parallel-cap; confirm `deferred` is `[]` on normal and idle ticks.

`src/model.ts`, `src/cli.ts`, `src/store.ts` untouched.

## 3. Approach — Precise Signature Changes

### 3a. New type `DeferredFiring` (in `src/engine.ts`, exported), placed right after the `Order` interface, before `TickResult`:

```ts
export type DeferredReason = 'in-flight' | 'cadence' | 'daily-budget' | 'parallel-cap';

export interface DeferredFiring {
  loop: string;
  key: string;
  index?: number;
  inputs: string[];
  outputs: string[];
  reason: DeferredReason;
}
```

Reuses exactly the `Firing` fields (model.ts) plus `reason`.

### 3b. Extended `TickResult`:

```ts
export interface TickResult {
  workflow: string;
  orders: Order[];
  reaped: number;
  deferred: DeferredFiring[];
}
```

### 3c. `applySchedule` return type: `Firing[]` → `{ selected: Firing[]; deferred: DeferredFiring[] }`. Nothing else calls it.

### 3d. `claim` return type: `Order | null` → `Order | 'in-flight' | null`. Replace `return null; // genuinely in flight` (current line 303) with `return 'in-flight';`. That is the ONLY null return in claim today (see §5).

### 3e. `tick` body:

```ts
return this.store.tx(() => {
  this.settle(workflow, def);
  const reaped = this.reap(workflow, now);

  const arts = this.artMap(workflow);
  const firings = eligibleFirings(def, arts);
  const { selected, deferred } = this.applySchedule(workflow, def, firings, now);

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
  return { workflow, orders, reaped, deferred: allDeferred };
});
```

## 4. Exact Reason-Mapping Logic in `applySchedule`

Transcribe the existing loop body verbatim, inserting deferred bookkeeping at each drop point:

```ts
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

    // cadence: a prior run is newer than cadenceSecs → ALL firings for this loop deferred
    const latest = this.store.latestRun(workflow, loop.name);
    if (latest && now - latest.createdAt < loop.cadenceSecs * 1000) {
      for (const f of loopFirings) defer(f, 'cadence');
      continue;
    }

    const used = this.store.countRuns(workflow, loop.name, midnight);
    const budget = Math.max(0, loop.maxRunsPerDay - used);
    const slots = Math.min(loop.parallel, budget);

    // binding constraint for beyond-slots firings:
    //   budget < parallel  → budget is tighter (incl. budget === 0) → daily-budget
    //   budget >= parallel → parallel is the cap → parallel-cap
    const beyondReason: DeferredReason = budget < loop.parallel ? 'daily-budget' : 'parallel-cap';

    for (const f of loopFirings.slice(0, slots)) selected.push(f);
    for (const f of loopFirings.slice(slots)) defer(f, beyondReason);
  }

  return { selected, deferred };
}
```

Audit: budget=0 → daily-budget (slots=0, all deferred). parallel=2,budget=10 → parallel-cap. parallel=2,budget=1 → daily-budget. parallel=1,budget=1,slots=1 → first selected, none deferred.

## 5. Edge Cases

**claim() returns null ONLY for in-flight:** the only `return null` is the fresh in-flight guard (line 303). The non-fresh claimed path falls through to insertRun/putTask/buildOrder (returns an Order). Because `reap()` runs at the top of `tick` and flips stale claimed tasks back to idle, a `claimed` task seen inside `claim` is always a fresh still-open run. So replacing `return null` with `return 'in-flight'` accounts for every null case; after the change claim never returns null in practice (keep `| null` defensively).

**A `selected` firing whose claim returns in-flight:** happens across sequential ticks in one process — tick 1 opens a run (not closed), tick 2 sees the firing eligible (output still owed) and applySchedule selects it, but claim sees the fresh open run → in-flight. This is exactly the case the channel surfaces. Within one `store.tx` (BEGIN IMMEDIATE write lock) no CAS race.

**cadence** short-circuits the whole loop → all loopFirings tagged cadence. **budget=0** → all daily-budget. **deferred always present** — `allDeferred` initialized `[]`, always returned.

**No CLI change:** `cli.ts:249` `print(io, engine.tick(...))` serializes the whole result; `deferred` appears in JSON automatically. Confirm but do not edit.

## 6. Test Plan (test/engine.test.ts — match existing helpers/style)

Use the test file's actual helpers (read the top of test/engine.test.ts for the real `makeEngine`/def/loop/fire/close/complete helper names and signatures — the snippets below are illustrative and must be adapted to what exists).

1. **deferred always present** — normal tick: one order, `deferred === []`; drive pipeline to done; idle tick: `orders === []` and `deferred === []`.
2. **in-flight (REQUIRED)** — tick once to open a planner run, do NOT close it; tick again: `orders === []`, `deferred.length === 1`, entry `{ reason: 'in-flight', loop: 'planner', key: '', inputs: ['proposal'], outputs: ['plan'], index: undefined }`. Assert full firing identity, not just count.
3. **cadence** — loop with `cadenceSecs: 60`; fire+close one run at t=10s; tick at t=40s → `deferred[0].reason === 'cadence'`.
4. **daily-budget** — loop with `cadenceSecs: 0, maxRunsPerDay: 1`; use the one run; next tick → `deferred[0].reason === 'daily-budget'`.
5. **parallel-cap** — map loop `parallel: 2` with 4 eligible elements → 2 orders, 2 deferred all `reason === 'parallel-cap'`. Can extend the existing parallel-cap test scenario.

Do not weaken existing tests (the existing cadence/budget and parallel-cap tests must still pass unchanged — the new tests are additive and isolate the reason tag).

## 7. Verification

- `npm run check` (typecheck + lint + full suite) exits zero. `deferred` is additive so existing `TickResult` destructurers (e.g. e2e.test.ts `t.orders`) are unaffected.
- Manual CLI spot-check: `create delivery --provide 'proposal={"text":"x"}'`; `tick` (opens run, deferred `[]`); `tick` again (run still open) → `deferred: [{ loop:'planner', key:'', inputs:['proposal'], outputs:['plan'], reason:'in-flight' }]`.
