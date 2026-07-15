/**
 * A2 — worker-label claim filter tests.
 *
 * A tick caller may pass an optional `labels` filter; a step may declare its own
 * `labels`. A firing is claimable iff the caller passes no filter, OR the step
 * declares no labels, OR the two sets intersect. Disjoint → the firing is
 * deferred as `'label-mismatch'` and left for a matching caller. The deep tick
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

// A def with a labeled step, a differently-labeled step, and an unlabeled one —
// all three eligible off the same seeded input.
const mixedDef = def(
  'mixed',
  [input('proposal')],
  [
    step({ name: 'alpha', consumes: ['proposal'], produces: ['a'], labels: ['x'] }),
    step({ name: 'beta', consumes: ['proposal'], produces: ['b'], labels: ['y'] }),
    step({ name: 'gamma', consumes: ['proposal'], produces: ['c'] }),
  ],
);

// ---- Test 1: no filter claims everything (byte-for-byte today's behavior) ----

test('labels: no caller filter claims every eligible firing, labeled or not', () => {
  const { engine } = makeEngine([mixedDef]);
  const wf = engine.createInstance('mixed');

  const t = engine.tick(wf, { now: 0 });
  const steps = t.orders.map((o) => o.step).sort();
  assert.deepEqual(steps, ['alpha', 'beta', 'gamma'], 'no filter = claim all');
  assert.equal(t.deferred.filter((d) => d.reason === 'label-mismatch').length, 0);
});

// ---- Test 2: filter claims intersecting + unlabeled, defers disjoint ----------

test('labels: filter claims matching + unlabeled steps, defers the disjoint one', () => {
  const { engine } = makeEngine([mixedDef]);
  const wf = engine.createInstance('mixed');

  const t = engine.tick(wf, { now: 0, labels: ['x'] });
  const claimed = t.orders.map((o) => o.step).sort();
  // alpha (labels ['x'] intersect) + gamma (no labels = universal); beta deferred.
  assert.deepEqual(claimed, ['alpha', 'gamma']);

  const mismatches = t.deferred.filter((d) => d.reason === 'label-mismatch');
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.step, 'beta');
});

// ---- Test 3: any-overlap intersection claims (["a","b"] vs ["b","c"]) ---------

test('labels: partial overlap between filter and step labels claims', () => {
  const overlapDef = def(
    'overlap',
    [input('proposal')],
    [step({ name: 'runner', consumes: ['proposal'], produces: ['out'], labels: ['b', 'c'] })],
  );
  const { engine } = makeEngine([overlapDef]);
  const wf = engine.createInstance('overlap');

  const t = engine.tick(wf, { now: 0, labels: ['a', 'b'] });
  assert.equal(t.orders.length, 1);
  assert.equal(t.orders[0]!.step, 'runner');
});

// ---- Test 4: a disjoint firing is deferred, then claimed by a matching caller -

test('labels: disjoint firing defers, then a matching caller claims it', () => {
  const soloDef = def(
    'solo',
    [input('proposal')],
    [step({ name: 'beta', consumes: ['proposal'], produces: ['b'], labels: ['y'] })],
  );
  const { engine } = makeEngine([soloDef]);
  const wf = engine.createInstance('solo');

  // A caller serving only 'x' must not claim the 'y' step.
  const t1 = engine.tick(wf, { now: 0, labels: ['x'] });
  assert.equal(t1.orders.length, 0, 'disjoint caller claims nothing');
  const mismatch = t1.deferred.find((d) => d.reason === 'label-mismatch');
  assert.ok(mismatch, 'the firing is reported as label-mismatch, not silently dropped');
  assert.equal(mismatch!.step, 'beta');

  // A caller serving 'y' claims the same firing on a later tick.
  const t2 = engine.tick(wf, { now: 1, labels: ['y'] });
  assert.equal(t2.orders.length, 1);
  assert.equal(t2.orders[0]!.step, 'beta');
});

// ---- Test 5: empty caller filter behaves like no filter (claim-all) -----------

test('labels: an empty caller filter claims everything (same as absent)', () => {
  const { engine } = makeEngine([mixedDef]);
  const wf = engine.createInstance('mixed');

  const t = engine.tick(wf, { now: 0, labels: [] });
  assert.equal(t.orders.length, 3, 'empty filter = no filtering');
  assert.equal(t.deferred.filter((d) => d.reason === 'label-mismatch').length, 0);
});

// ---- Test 6: deep tick threads the filter into a calls: child ----------------

// A labeled child step, and a parent that calls it with an empty gate (spawns on
// the first tick). The parent's own calls: step never emits a worker order.
const childLabeledDef: WorkflowDef = {
  ...def(
    'childLabeled',
    [],
    [step({ name: 'runner', produces: ['outcome'], labels: ['claude'] })],
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

test('labels: deep tick threads the filter into a calls: child — no cross-claim', () => {
  const { engine, store } = makeEngine([childLabeledDef, parentCallsDef]);
  const parentWf = engine.createInstance('parentCalls');

  // A conductor serving only 'codex' ticks deep. The child spawns (machine-
  // handled, filter-independent) but its 'claude' runner must NOT be claimed.
  const t1 = engine.tick(parentWf, { now: 0, labels: ['codex'] });
  const child = store.findChildByParent(parentWf, 'delivered');
  assert.ok(child, 'child instance is spawned regardless of the label filter');
  assert.ok(t1.orders.every((o) => o.step !== 'runner'), 'mismatched conductor does not cross-claim the child runner');
  const childMismatch = t1.deferred.find((d) => d.reason === 'label-mismatch' && d.step === 'runner');
  assert.ok(childMismatch, 'the child runner is reported deferred');
  assert.equal(childMismatch!.workflow, child!.id, 'the deferral is stamped with the child workflow id');

  // A conductor serving 'claude' claims the child runner on a later deep tick.
  const t2 = engine.tick(parentWf, { now: 1, labels: ['claude'] });
  const runnerOrder = t2.orders.find((o) => o.step === 'runner');
  assert.ok(runnerOrder, 'matching conductor claims the child runner');
  assert.equal(runnerOrder!.workflow, child!.id);
});
