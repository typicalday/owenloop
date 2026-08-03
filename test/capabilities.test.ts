/**
 * A2 — capability claim filter tests.
 *
 * A tick caller may pass an optional `capabilities` filter; a step may declare its own
 * `capabilities`. A firing is claimable iff the caller passes no filter, OR the step
 * declares no capabilities, OR the two sets intersect. Disjoint → the firing is
 * deferred as `'capability-mismatch'` and left for a matching caller. The deep tick
 * threads the same filter into `calls:` children.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { StepDef, WorkflowDef } from '../src/types.ts';
import { def, input, step } from './helpers.ts';

function makeEngine(defs: WorkflowDef[]): { engine: Engine; store: Store } {
  const store = openStore(':memory:');
  const byName = new Map(defs.map((d) => [d.name, d]));
  const engine = new Engine(store, (name) => {
    const d = byName.get(name);
    if (!d) throw new Error(`no def: ${name}`);
    return d;
  });
  return { engine, store };
}

// A def with a capability-routed step, a differently-capability-routed step, and an without capabilities one —
// all three eligible off the same seeded input.
const mixedDef = def(
  'mixed',
  [input('proposal')],
  [
    step({ name: 'alpha', consumes: ['proposal'], produces: ['a'], capabilities: ['x'] }),
    step({ name: 'beta', consumes: ['proposal'], produces: ['b'], capabilities: ['y'] }),
    step({ name: 'gamma', consumes: ['proposal'], produces: ['c'] }),
  ],
);

// ---- Test 1: no filter claims everything (byte-for-byte today's behavior) ----

test('capabilities: no caller filter claims every eligible firing, labeled or not', () => {
  const { engine } = makeEngine([mixedDef]);
  const wf = engine.createInstance('mixed');

  const t = engine.tick(wf, { now: 0 });
  const steps = t.orders.map((o) => o.step).sort();
  assert.deepEqual(steps, ['alpha', 'beta', 'gamma'], 'no filter = claim all');
  assert.equal(t.deferred.filter((d) => d.reason === 'capability-mismatch').length, 0);
});

// ---- Test 2: filter claims intersecting + without capabilities, defers disjoint ----------

test('capabilities: filter claims matching + uncapability-routed steps, defers the disjoint one', () => {
  const { engine } = makeEngine([mixedDef]);
  const wf = engine.createInstance('mixed');

  const t = engine.tick(wf, { now: 0, capabilities: ['x'] });
  const claimed = t.orders.map((o) => o.step).sort();
  // alpha (capabilities ['x'] intersect) + gamma (no capabilities = universal); beta deferred.
  assert.deepEqual(claimed, ['alpha', 'gamma']);

  const mismatches = t.deferred.filter((d) => d.reason === 'capability-mismatch');
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.step, 'beta');
});

// ---- Test 3: any-overlap intersection claims (["a","b"] vs ["b","c"]) ---------

test('capabilities: partial overlap between filter and step capabilities claims', () => {
  const overlapDef = def(
    'overlap',
    [input('proposal')],
    [step({ name: 'runner', consumes: ['proposal'], produces: ['out'], capabilities: ['b', 'c'] })],
  );
  const { engine } = makeEngine([overlapDef]);
  const wf = engine.createInstance('overlap');

  const t = engine.tick(wf, { now: 0, capabilities: ['a', 'b'] });
  assert.equal(t.orders.length, 1);
  assert.equal(t.orders[0]!.step, 'runner');
});

// ---- Test 4: a disjoint firing is deferred, then claimed by a matching caller -

test('capabilities: disjoint firing defers, then a matching caller claims it', () => {
  const soloDef = def(
    'solo',
    [input('proposal')],
    [step({ name: 'beta', consumes: ['proposal'], produces: ['b'], capabilities: ['y'] })],
  );
  const { engine } = makeEngine([soloDef]);
  const wf = engine.createInstance('solo');

  // A caller/Shift serving only 'x' must not claim the 'y' step.
  const t1 = engine.tick(wf, { now: 0, capabilities: ['x'] });
  assert.equal(t1.orders.length, 0, 'disjoint caller claims nothing');
  const mismatch = t1.deferred.find((d) => d.reason === 'capability-mismatch');
  assert.ok(mismatch, 'the firing is reported as capability-mismatch, not silently dropped');
  assert.equal(mismatch!.step, 'beta');

  // A caller/Shift serving 'y' claims the same firing on a later tick.
  const t2 = engine.tick(wf, { now: 1, capabilities: ['y'] });
  assert.equal(t2.orders.length, 1);
  assert.equal(t2.orders[0]!.step, 'beta');
});

// ---- Test 5: empty caller filter behaves like no filter (claim-all) -----------

test('capabilities: an empty caller filter claims everything (same as absent)', () => {
  const { engine } = makeEngine([mixedDef]);
  const wf = engine.createInstance('mixed');

  const t = engine.tick(wf, { now: 0, capabilities: [] });
  assert.equal(t.orders.length, 3, 'empty filter = no filtering');
  assert.equal(t.deferred.filter((d) => d.reason === 'capability-mismatch').length, 0);
});

// ---- Test 6: deep tick threads the filter into a calls: child ----------------

// A labeled child step, and a parent that calls it with an empty gate (spawns on
// the first tick). The parent's own calls: step never emits a worker order.
const childLabeledDef: WorkflowDef = {
  ...def(
    'childLabeled',
    [],
    [step({ name: 'runner', produces: ['outcome'], capabilities: ['claude'] })],
  ),
  outputs: ['outcome'],
};

const parentCallsDef: WorkflowDef = def(
  'parentCalls',
  [],
  [
    {
      ...step({ name: 'deliver', produces: ['delivered'] }),
      calls: 'childLabeled',
      callsInputs: {},
      consumes: [],
    } as StepDef,
  ],
);

test('capabilities: deep tick threads the filter into a calls: child — no cross-claim', () => {
  const { engine, store } = makeEngine([childLabeledDef, parentCallsDef]);
  const parentWf = engine.createInstance('parentCalls');

  // A Shift serving only 'codex' ticks deep. The child spawns (machine-
  // handled, filter-independent) but its 'claude' runner must NOT be claimed.
  const t1 = engine.tick(parentWf, { now: 0, capabilities: ['codex'] });
  const child = store.findChildByParent(parentWf, 'delivered');
  assert.ok(child, 'child instance is spawned regardless of the capability filter');
  assert.ok(t1.orders.every((o) => o.step !== 'runner'), 'mismatched Shift does not cross-claim the child runner');
  const childMismatch = t1.deferred.find((d) => d.reason === 'capability-mismatch' && d.step === 'runner');
  assert.ok(childMismatch, 'the child runner is reported deferred');
  assert.equal(childMismatch!.workflow, child!.id, 'the deferral is stamped with the child workflow id');

  // A Shift serving 'claude' claims the child runner on a later deep tick.
  const t2 = engine.tick(parentWf, { now: 1, capabilities: ['claude'] });
  const runnerOrder = t2.orders.find((o) => o.step === 'runner');
  assert.ok(runnerOrder, 'matching Shift claims the child runner');
  assert.equal(runnerOrder!.workflow, child!.id);
});
