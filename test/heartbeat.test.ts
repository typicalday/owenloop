/**
 * Heartbeat liveness tests — covering Engine.heartbeat(), unified isClaimFresh,
 * per-step TTL override, and status() attempts enrichment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { WorkflowDef } from '../src/types.ts';
// REL-8: the reap-observability types must reach embedders through the public
// barrel (the package's only export path), not just from src/engine.ts. Import
// them from '../src/index.ts' here so typecheck fails if either is dropped from
// the barrel re-export (see the regression test at the bottom of this file).
import type { ReapDetail as PublicReapDetail, ReapReason as PublicReapReason } from '../src/index.ts';
import { def, input, step } from './helpers.ts';

// ---- harness ------------------------------------------------------------------

/**
 * Create an engine over an in-memory store.
 * The proposal input seeds as green automatically (seedOwed defaults to false).
 */
function makeEngine(d: WorkflowDef, opts: { reapTtlMs?: number; maxLeaseMs?: number } = {}): {
  engine: Engine;
  store: Store;
  wf: string;
} {
  const store = openStore(':memory:');
  const engine = new Engine(store, () => d, opts);
  const wf = engine.createInstance(d.name);
  return { engine, store, wf };
}

// Delivery def: proposal → planner → plan
const deliveryDef = def(
  'delivery',
  [input('proposal')],
  [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
  ],
);

// ---- Test 1: beating run survives past global TTL ----------------------------

test('heartbeat: beating run is not reaped past global TTL', () => {
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 1000 });

  // Tick at t=0 — claim planner as R1
  const t0 = engine.tick(wf, { now: 0 });
  assert.equal(t0.orders.length, 1);
  const R1 = t0.orders[0]!.run;

  // Heartbeat at t=500 (within TTL)
  engine.heartbeat(wf, R1, 500);
  // Heartbeat at t=1200 (500ms after previous beat, within TTL from last beat)
  engine.heartbeat(wf, R1, 1200);

  // Tick at t=2000 — 2000ms total runtime >> global TTL 1000ms,
  // but last beat was at 1200, only 800ms ago (< 1000ms TTL)
  const t2000 = engine.tick(wf, { now: 2000 });
  assert.equal(t2000.reaped, 0, 'run should not be reaped while beating within TTL');
});

// ---- Test 2: beat from reaped run throws ------------------------------------

test('heartbeat: beat from reaped run throws', () => {
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 100 });

  const t0 = engine.tick(wf, { now: 0 });
  const R1 = t0.orders[0]!.run;

  // Tick at t=200 — past TTL 100ms — run is reaped
  const t200 = engine.tick(wf, { now: 200 });
  assert.equal(t200.reaped, 1, 'run should be reaped after TTL');

  // Heartbeat from now-reaped run should throw
  assert.throws(
    () => engine.heartbeat(wf, R1, 201),
    /no longer holds its lease|reaped or superseded/,
  );
});

// ---- Test 3: beat from superseded run throws ---------------------------------

test('heartbeat: beat from superseded run throws', () => {
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 1000 });

  // t=0: R1 claimed
  const t0 = engine.tick(wf, { now: 0 });
  const R1 = t0.orders[0]!.run;

  // Close R1 (releases lease)
  engine.close(wf, R1, 'ok');

  // Green the output so planner becomes re-eligible only if needed — but actually
  // after ok close without greening, the task goes idle and the step can re-fire.
  // R2 claimed on next tick
  const t100 = engine.tick(wf, { now: 100 });
  assert.equal(t100.orders.length, 1, 'should have a new run R2');
  const R2 = t100.orders[0]!.run;
  assert.notEqual(R2, R1);

  // Heartbeat from R1 (closed or superseded by R2) should throw
  assert.throws(
    () => engine.heartbeat(wf, R1, 200),
    /no longer holds its lease|reaped or superseded|already closed/,
  );
});

// ---- Test 4: non-beating run past TTL is reaped -----------------------------

test('heartbeat: non-beating run past TTL is reaped', () => {
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 100 });

  const t0 = engine.tick(wf, { now: 0 });
  assert.equal(t0.orders.length, 1);

  // No heartbeats — tick at t=200 (past TTL 100ms)
  const t200 = engine.tick(wf, { now: 200 });
  assert.equal(t200.reaped, 1, 'run should be reaped after TTL without heartbeats');
});

// ---- Test 5: per-step TTL override shorter than engine default ---------------

test('heartbeat: per-step TTL shorter than engine default — reaped at step TTL', () => {
  const shortTtlDef = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'], reapTtlMs: 500 }),
    ],
  );
  const store = openStore(':memory:');
  const engine = new Engine(store, () => shortTtlDef, { reapTtlMs: 2000 });
  const wf = engine.createInstance(shortTtlDef.name);

  const t0 = engine.tick(wf, { now: 0 });
  assert.equal(t0.orders.length, 1);

  // t=800: past step TTL (500ms) but before engine TTL (2000ms)
  const t800 = engine.tick(wf, { now: 800 });
  assert.equal(t800.reaped, 1, 'run should be reaped at step TTL (500ms), not engine TTL (2000ms)');
});

// ---- Test 6: per-step TTL override longer than engine default ----------------

test('heartbeat: per-step TTL longer than engine default — not reaped before step TTL', () => {
  const longTtlDef = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'], reapTtlMs: 2000 }),
    ],
  );
  const store = openStore(':memory:');
  const engine = new Engine(store, () => longTtlDef, { reapTtlMs: 500 });
  const wf = engine.createInstance(longTtlDef.name);

  const t0 = engine.tick(wf, { now: 0 });
  assert.equal(t0.orders.length, 1);

  // t=800: past engine TTL (500ms) but before step TTL (2000ms)
  const t800 = engine.tick(wf, { now: 800 });
  assert.equal(t800.reaped, 0, 'run should NOT be reaped at engine TTL (500ms) when step TTL is 2000ms');
});

// ---- Test 7: status() exposes attempts and increments after each reap --------

test('heartbeat: status() exposes attempts incremented after each reap', () => {
  // Engine with reapTtlMs=100; reap and re-claim happen in the same tick.
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 100 });

  // Tick t=0 → R1 claimed for planner
  const t0 = engine.tick(wf, { now: 0 });
  assert.equal(t0.orders.length, 1);

  // Tick t=200 → R1 reaped (attempts→1), R2 immediately re-claimed in same tick
  const t200 = engine.tick(wf, { now: 200 });
  assert.equal(t200.reaped, 1);

  // After the t=200 tick: task has attempts=1 (set by reap), then R2 is claimed
  // with attempts=1 preserved. status() debt for plan should expose attempts=1.
  const st1 = engine.status(wf);
  const planDebt1 = st1.debts.find((d) => d.path === 'plan');
  assert.ok(planDebt1, 'plan should be a debt');
  assert.equal(planDebt1.attempts, 1, 'attempts should be 1 after first reap');

  // Tick t=400 (200ms after R2 was claimed at t=200, past TTL 100ms)
  // → R2 reaped (attempts→2), R3 immediately re-claimed
  const t400 = engine.tick(wf, { now: 400 });
  assert.equal(t400.reaped, 1);

  const st2 = engine.status(wf);
  const planDebt2 = st2.debts.find((d) => d.path === 'plan');
  assert.ok(planDebt2, 'plan should still be a debt');
  assert.equal(planDebt2.attempts, 2, 'attempts should be 2 after second reap');
});

// ---- Test 8: status().inFlight reports claimed tasks, then clears on close ----

test('status(): inFlight lists a claimed task with all fields, then empties after close', () => {
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 1000 });

  const t0 = engine.tick(wf, { now: 0 });
  assert.equal(t0.orders.length, 1);
  const R1 = t0.orders[0]!.run;

  const before = engine.status(wf);
  assert.equal(before.inFlight.length, 1);
  const entry = before.inFlight[0]!;
  assert.equal(entry.step, 'planner');
  assert.equal(entry.key, '');
  assert.equal(entry.run, R1);
  assert.equal(typeof entry.claimedAt, 'number');
  assert.equal(entry.attempts, 0);
  assert.ok((entry.claimAgeMs ?? -1) >= 0);
  assert.equal(entry.heartbeatAt, undefined, 'no heartbeat sent yet');
  assert.equal(entry.heartbeatAgeMs, undefined);

  engine.heartbeat(wf, R1, 10);
  const afterBeat = engine.status(wf).inFlight[0]!;
  assert.equal(afterBeat.heartbeatAt, 10);
  assert.ok((afterBeat.heartbeatAgeMs ?? -1) >= 0);

  engine.close(wf, R1, 'ok');
  const after = engine.status(wf);
  assert.equal(after.inFlight.length, 0, 'closing the run releases the lease — no longer in flight');
});

// ---- Test 9: reapWithDetails reports what it reaped; ttlOverride:0 forces stale --

test('engine.reapWithDetails: reports reaped step/key/run, and ttlOverride:0 forces a fresh claim stale', () => {
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 999_999 });

  const t0 = engine.tick(wf, { now: 0 });
  const R1 = t0.orders[0]!.run;

  // Normal TTL rules (no override): the claim is fresh, nothing reaped.
  const plain = engine.reapWithDetails(wf, 100);
  assert.equal(plain.count, 0);
  assert.deepEqual(plain.details, []);

  // ttlOverride: 0 forces every claim stale, regardless of the real TTL.
  const forced = engine.reapWithDetails(wf, 100, undefined, { ttlOverride: 0 });
  assert.equal(forced.count, 1);
  assert.equal(forced.details.length, 1);
  assert.equal(forced.details[0]!.step, 'planner');
  assert.equal(forced.details[0]!.key, '');
  assert.equal(forced.details[0]!.run, R1);
  // REL-8: a lease that was fresh under the real TTL and only cleared by the
  // --now override reports `forced`, not a misleading liveness reason.
  assert.equal(forced.details[0]!.reason, 'forced');

  // The reaped run no longer holds its lease.
  assert.throws(
    () => engine.green(wf, R1, 'plan', { v: 1 }),
    /no longer holds its lease|reaped or superseded/,
  );
});

// ---- REL-8: reap-observability types are on the public export surface ---------

// The behavioral fix widened reapWithDetails() to return ReapReason/ReapDetail.
// Those types are only useful to embedders if they are importable from the
// package barrel. The PublicReapReason/PublicReapDetail imports at the top of
// this file are type-only re-exports from '../src/index.ts'; this test uses them
// so the assertion is also exercised at runtime. Without the barrel re-export
// the file fails to typecheck (npm run check), which is the regression guard.
test('REL-8: ReapReason and ReapDetail are re-exported from the public barrel', () => {
  const reason: PublicReapReason = 'max-lease-exceeded';
  const detail: PublicReapDetail = { step: 'planner', key: '', reason };
  assert.equal(detail.reason, 'max-lease-exceeded');
  assert.equal(detail.step, 'planner');
});

// ---- A3: max-lease clamp ------------------------------------------------------

// A3-1: a beat just inside claimedAt + maxLease keeps the lease fresh.
test('maxLease: beat just inside claimedAt + maxLease is still fresh', () => {
  // TTL huge so the anchor rule never bites; maxLease is the only bound.
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 1_000_000, maxLeaseMs: 1000 });

  const t0 = engine.tick(wf, { now: 0 });
  assert.equal(t0.orders.length, 1);
  const R1 = t0.orders[0]!.run;

  engine.heartbeat(wf, R1, 900);
  // t=950: 950ms since claim < 1000 maxLease → still fresh.
  const t950 = engine.tick(wf, { now: 950 });
  assert.equal(t950.reaped, 0, 'lease inside claimedAt + maxLease must stay fresh');
});

// A3-2: a recent beat cannot save a lease past claimedAt + maxLease; it is
// reaped and re-claimable by a fresh run.
test('maxLease: recent beat past claimedAt + maxLease is reaped and re-claimable', () => {
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 1_000_000, maxLeaseMs: 1000 });

  const t0 = engine.tick(wf, { now: 0 });
  const R1 = t0.orders[0]!.run;

  // Beat at t=1100 — the write still succeeds (lease not yet reaped), but it
  // cannot push total lifetime back under maxLease.
  engine.heartbeat(wf, R1, 1100);

  // t=1200: anchor-rule fresh (100ms since beat << TTL) but 1200ms since claim
  // > 1000 maxLease → stale → reaped, and re-claimed in the same tick.
  const t1200 = engine.tick(wf, { now: 1200 });
  assert.equal(t1200.reaped, 1, 'lease past claimedAt + maxLease is stale despite a recent beat');
  assert.equal(t1200.orders.length, 1, 'the step is re-claimable by a new run');
  const R2 = t1200.orders[0]!.run;
  assert.notEqual(R2, R1);

  // The old run no longer holds its lease.
  assert.throws(
    () => engine.heartbeat(wf, R1, 1300),
    /no longer holds its lease|reaped or superseded/,
  );
});

// A3-3: per-step maxLeaseMs override SHORTER than the engine default wins.
test('maxLease: per-step override shorter than engine default — reaped at step maxLease', () => {
  const shortDef = def(
    'delivery',
    [input('proposal')],
    [step({ name: 'planner', consumes: ['proposal'], produces: ['plan'], maxLeaseMs: 1000 })],
  );
  const { engine, wf } = makeEngine(shortDef, { reapTtlMs: 1_000_000, maxLeaseMs: 5000 });

  const t0 = engine.tick(wf, { now: 0 });
  assert.equal(t0.orders.length, 1);

  // t=1200: past step maxLease (1000) but before engine maxLease (5000).
  const t1200 = engine.tick(wf, { now: 1200 });
  assert.equal(t1200.reaped, 1, 'reaped at step maxLease (1000), not engine maxLease (5000)');
});

// A3-4: per-step maxLeaseMs override LONGER than a short engine default wins.
test('maxLease: per-step override longer than engine default — not reaped before step maxLease', () => {
  const longDef = def(
    'delivery',
    [input('proposal')],
    [step({ name: 'planner', consumes: ['proposal'], produces: ['plan'], maxLeaseMs: 2000 })],
  );
  const { engine, wf } = makeEngine(longDef, { reapTtlMs: 1_000_000, maxLeaseMs: 500 });

  const t0 = engine.tick(wf, { now: 0 });
  assert.equal(t0.orders.length, 1);

  // t=800: past engine maxLease (500) but before step maxLease (2000).
  const t800 = engine.tick(wf, { now: 800 });
  assert.equal(t800.reaped, 0, 'not reaped at engine maxLease (500) when step maxLease is 2000');
});

// A3-5: after a reap + re-claim, the clamp re-anchors to the NEW claimedAt.
test('maxLease: clamp re-anchors to the new claim after reap + re-claim', () => {
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 1_000_000, maxLeaseMs: 1000 });

  const t0 = engine.tick(wf, { now: 0 });
  const R1 = t0.orders[0]!.run;

  // t=1200: R1 past maxLease → reaped, R2 claimed at claimedAt=1200.
  const t1200 = engine.tick(wf, { now: 1200 });
  assert.equal(t1200.reaped, 1);
  const R2 = t1200.orders[0]!.run;
  assert.notEqual(R2, R1);

  // t=1900: only 700ms since R2's claim (< 1000 maxLease) → fresh, not reaped.
  const t1900 = engine.tick(wf, { now: 1900 });
  assert.equal(t1900.reaped, 0, 'clamp re-anchored to R2 claimedAt=1200, so R2 is fresh at t=1900');

  // t=2300: 1100ms since R2's claim (> 1000 maxLease) → stale again.
  const t2300 = engine.tick(wf, { now: 2300 });
  assert.equal(t2300.reaped, 1, 'R2 crosses its own claimedAt + maxLease');
});

// A3-6 (REL-8): with NO cap configured (the default), there is no max-lease
// ceiling — heartbeats extend a lease indefinitely. This replaces the old
// "defaults to ~1h" spec, which asserted exactly the behavior REL-8 reverses:
// removing the silent 1h default is the whole point of the fix.
test('maxLease: unset means no cap — a beating lease survives far past the old 1h default', () => {
  const hourMs = 60 * 60 * 1000;

  // (a) No cap, no beat: a lease sitting past the old 1h default is still fresh
  // under the default 2h reap TTL — the anchor rule is now the only bound.
  // The old 1h default cap would have reaped this.
  const noBeat = makeEngine(deliveryDef);
  noBeat.engine.tick(noBeat.wf, { now: 0 });
  const past1h = noBeat.engine.tick(noBeat.wf, { now: hourMs + 1000 });
  assert.equal(past1h.reaped, 0, 'no default cap: a lease past 1h is not reaped under the 2h TTL');

  // (b) No cap, beating every 30 simulated minutes: survives well past 1h and
  // past the 2h TTL — walk it out to 24h — and the original run can still commit.
  const beating = makeEngine(deliveryDef);
  const t0 = beating.engine.tick(beating.wf, { now: 0 });
  const R1 = t0.orders[0]!.run;
  const halfHour = 30 * 60 * 1000;
  for (let t = halfHour; t <= 24 * hourMs; t += halfHour) {
    beating.engine.heartbeat(beating.wf, R1, t);
    const tick = beating.engine.tick(beating.wf, { now: t });
    assert.equal(tick.reaped, 0, `beating lease still fresh at t=${t}ms (far past old 1h cap)`);
  }
  // Still holds its lease: the original run commits without a stale-lease throw.
  assert.doesNotThrow(() => beating.engine.green(beating.wf, R1, 'plan', { v: 1 }));
});

// ---- REL-8: reap reasons distinguish liveness failures from the opt-in cap ----

// A configured cap that expires a still-beating lease reports 'max-lease-exceeded'.
test('reap reason: configured cap on a beating lease reports max-lease-exceeded', () => {
  // Huge TTL so the anchor rule never bites; the 1000ms cap is the only bound.
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 1_000_000, maxLeaseMs: 1000 });
  const t0 = engine.tick(wf, { now: 0 });
  const R1 = t0.orders[0]!.run;
  // Beat at t=900 — anchor-rule fresh — but total lifetime at t=1200 exceeds the cap.
  engine.heartbeat(wf, R1, 900);
  const reaped = engine.reapWithDetails(wf, 1200);
  assert.equal(reaped.count, 1);
  assert.equal(reaped.details[0]!.reason, 'max-lease-exceeded');
  assert.equal(reaped.details[0]!.run, R1);
});

// Heartbeat loss with no cap configured reports 'heartbeat-lost' (unchanged behavior).
test('reap reason: silent lease past TTL with no cap reports heartbeat-lost', () => {
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 100 });
  engine.tick(wf, { now: 0 });
  // No beats, well past the 100ms TTL, no cap configured.
  const reaped = engine.reapWithDetails(wf, 500);
  assert.equal(reaped.count, 1);
  assert.equal(reaped.details[0]!.reason, 'heartbeat-lost');
});

// Precedence: when BOTH bounds lapse, heartbeat-lost wins — a job that was not
// alive under the anchor rule must not be reported as cap-killed.
test('reap reason: both bounds lapsed reports heartbeat-lost, not max-lease-exceeded', () => {
  const { engine, wf } = makeEngine(deliveryDef, { reapTtlMs: 100, maxLeaseMs: 1000 });
  engine.tick(wf, { now: 0 });
  // No beats: at t=1200 the anchor rule (100ms TTL) has lapsed AND the 1000ms
  // cap is exceeded — heartbeat-lost takes precedence.
  const reaped = engine.reapWithDetails(wf, 1200);
  assert.equal(reaped.count, 1);
  assert.equal(reaped.details[0]!.reason, 'heartbeat-lost');
});

// run-closed: a claimed task whose run has already closed reports 'run-closed'.
test('reap reason: claimed task with a closed run reports run-closed', () => {
  const { engine, store, wf } = makeEngine(deliveryDef, { reapTtlMs: 1_000_000 });
  const t0 = engine.tick(wf, { now: 0 });
  const R1 = t0.orders[0]!.run;
  // Set the run's outcome directly, leaving the task 'claimed' — close() would
  // also idle the task; this reconstructs the stranded state a reap must clear.
  store.updateRun(R1, { outcome: 'ok' });
  const reaped = engine.reapWithDetails(wf, 100);
  assert.equal(reaped.count, 1);
  assert.equal(reaped.details[0]!.reason, 'run-closed');
});

// run-missing: a claimed task whose run row is absent reports 'run-missing'.
test('reap reason: claimed task with no run row reports run-missing', () => {
  const { engine, store, wf } = makeEngine(deliveryDef, { reapTtlMs: 1_000_000 });
  // A claimed task pointing at a run id that does not exist.
  store.putTask({
    workflow: wf,
    step: 'planner',
    key: '',
    status: 'claimed',
    attempts: 0,
    claimedAt: 0,
    run: 'run_ghost',
  });
  const reaped = engine.reapWithDetails(wf, 100);
  const detail = reaped.details.find((d) => d.step === 'planner');
  assert.ok(detail, 'the ghost-run task is reaped');
  assert.equal(detail!.reason, 'run-missing');
});
