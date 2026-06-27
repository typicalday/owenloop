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
import { def, input, step } from './helpers.ts';

// ---- harness ------------------------------------------------------------------

/**
 * Create an engine over an in-memory store.
 * The proposal input seeds as green automatically (seedOwed defaults to false).
 */
function makeEngine(d: WorkflowDef, opts: { reapTtlMs?: number } = {}): {
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
