/**
 * PR5b — Mode 2 `calls:` runtime integration tests.
 *
 * Six engine integration tests (a–f) covering: happy-path end-to-end, re-attach
 * no-duplicate, re-provide on input move, failure branch, child outcome re-green,
 * and gate re-arm. Plus three defs validation tests for the outputs: check.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.ts';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { ArtifactData, StepDef, WorkflowDef } from '../src/types.ts';
import { DefError, loadDefs } from '../src/defs.ts';
import { def, input, step } from './helpers.ts';

// ---- fixture defs ------------------------------------------------------------

/**
 * childDef: a simple workflow with outputs: [result], one seedOwed input `data`,
 * one step `worker` that produces `result`.
 */
const childDef: WorkflowDef = {
  ...def(
    'childDef',
    [input('data', { seedOwed: true })],
    [step({ name: 'worker', consumes: ['data'], produces: ['result'] })],
  ),
  outputs: ['result'],
};

/**
 * parentDef: has inputs: [proposal] (seedOwed), steps:
 *   provision (consumes proposal, produces sandbox)
 *   deliver (calls: childDef, inputs: {data: sandbox}, produces: delivered)
 *   teardown (consumes delivered, produces done)
 */
const deliverStep: StepDef = {
  ...step({ name: 'deliver', produces: ['delivered'] }),
  calls: 'childDef',
  callsInputs: { data: 'sandbox' },
  consumes: [],
};

const parentDef: WorkflowDef = def(
  'parentDef',
  [input('proposal', { seedOwed: true })],
  [
    step({ name: 'provision', consumes: ['proposal'], produces: ['sandbox'] }),
    deliverStep,
    step({ name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true }),
  ],
);

/**
 * failingChildDef: a workflow with outputs: [outcome], one step `evaluator`
 * that produces `outcome` (carries {status: 'failed'}).
 */
const failingChildDef: WorkflowDef = {
  ...def(
    'failingChildDef',
    [],
    [step({ name: 'evaluator', produces: ['outcome'] })],
  ),
  outputs: ['outcome'],
};

/**
 * parentFailDef: like parentDef but calls: failingChildDef with no input wiring.
 * teardown consumes delivered.
 */
const failDeliverStep: StepDef = {
  ...step({ name: 'deliver', produces: ['delivered'] }),
  calls: 'failingChildDef',
  callsInputs: {},
  consumes: [],
};

const parentFailDef: WorkflowDef = def(
  'parentFailDef',
  [],
  [
    failDeliverStep,
    step({ name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true }),
  ],
);

// ---- harness ----------------------------------------------------------------

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

function getArt(store: Store, wf: string, path: string): ArtifactData | undefined {
  return store.getArtifact(wf, path);
}

// ---- test (a): happy path end-to-end ----------------------------------------

test('calls: (a) happy path end-to-end — full loop driven ONLY by tick(parent) (deep)', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  // Create parent instance with proposal provided
  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });

  // Tick 1 → provision order
  const tick1 = engine.tick(parentWf);
  assert.equal(tick1.orders.length, 1);
  assert.equal(tick1.orders[0]!.step, 'provision');
  const provRun = tick1.orders[0]!.run;

  // No child should exist yet (sandbox not green)
  assert.equal(store.findChildByParent(parentWf, 'delivered'), undefined);

  // Green sandbox
  engine.green(parentWf, provRun, 'sandbox', { env: 'test-env' });
  engine.close(parentWf, provRun);

  // Tick 2 (DEEP, default) → maintainCalls spawns the child AND the descent
  // claims the child's worker order in the same parent tick. `deliver` itself
  // is a calls: step and never emits a worker order.
  const tick2 = engine.tick(parentWf);
  assert.ok(tick2.orders.every((o) => o.step !== 'deliver'), 'deliver must not produce worker orders');

  // Child should exist now
  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined, 'child should be spawned after sandbox is green');

  // Child's data input should be green with sandbox value
  const childDataArt = getArt(store, childRow!.id, 'data');
  assert.equal(childDataArt?.acceptance, 'green');
  assert.deepEqual(childDataArt?.value, { env: 'test-env' });

  // Deep tick: the child's worker order is emitted from the PARENT tick,
  // stamped with the child's workflow id — no explicit tick(child) needed.
  const workerOrder = tick2.orders.find((o) => o.step === 'worker');
  assert.ok(workerOrder !== undefined, 'parent tick must emit the child worker order (deep tick)');
  assert.equal(workerOrder!.workflow, childRow!.id, 'child order carries the child workflow id');

  // Commit via the parent-emitted order.
  engine.green(childRow!.id, workerOrder!.run, 'result', { value: 'done' });
  engine.close(childRow!.id, workerOrder!.run);

  // Tick parent → maintainCalls machine-greens delivered, teardown becomes eligible
  const tick3 = engine.tick(parentWf);
  const deliveredArt = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredArt?.acceptance, 'green');
  assert.deepEqual(deliveredArt?.value, { value: 'done' });
  // Teardown should be eligible in this same tick (cascade fired before firings check)
  const teardownOrder = tick3.orders.find((o) => o.step === 'teardown');
  assert.ok(teardownOrder !== undefined, 'teardown should be eligible after delivered is green');

  // Complete teardown → parent done
  engine.green(parentWf, teardownOrder!.run, 'done', { status: 'ok' });
  engine.close(parentWf, teardownOrder!.run);

  const doneArt = getArt(store, parentWf, 'done');
  assert.equal(doneArt?.acceptance, 'green');
});

// ---- test (b): re-attach — no duplicate child --------------------------------

test('calls: (b) re-attach — maintainCalls twice does not duplicate child', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });

  // Green sandbox first
  const tick1 = engine.tick(parentWf, { deep: false });
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);

  // Call tick twice (maintainCalls runs each time)
  engine.tick(parentWf, { deep: false });
  engine.tick(parentWf, { deep: false });

  // Exactly one child should exist
  const children = store.listChildrenByParent(parentWf);
  assert.equal(children.length, 1, 'exactly one child should exist after multiple ticks');

  // Simulate "lost prompt" — drive child without prompt, then tick parent
  const childId = children[0]!.id;
  const childTick = engine.tick(childId);
  const workerRun = childTick.orders[0]!.run;
  engine.green(childId, workerRun, 'result', { value: 'result-v1' });
  engine.close(childId, workerRun);

  // Now tick parent (durability: parent reads child outcome on tick, no prompt needed)
  engine.tick(parentWf, { deep: false });
  const deliveredArt = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredArt?.acceptance, 'green');
  assert.deepEqual(deliveredArt?.value, { value: 'result-v1' });

  // Still exactly one child
  assert.equal(store.listChildrenByParent(parentWf).length, 1);
});

// ---- test (c): re-provide on parent input move -------------------------------

test('calls: (c) re-provide — parent input moves, child input updated, no second child', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });

  // Green sandbox v1
  const tick1 = engine.tick(parentWf, { deep: false });
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);

  // Tick → child spawned with data={env:'v1'}
  engine.tick(parentWf, { deep: false });
  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);
  assert.deepEqual(getArt(store, childRow!.id, 'data')?.value, { env: 'v1' });

  // Directly update sandbox artifact to simulate re-provision (bump version + value)
  const sandboxArt = getArt(store, parentWf, 'sandbox');
  assert.ok(sandboxArt !== undefined);
  store.putArtifact({
    ...sandboxArt!,
    version: sandboxArt!.version + 1,
    value: { env: 'v2' },
  });

  // Tick parent → maintainCalls detects value mismatch → re-provides data to child
  engine.tick(parentWf, { deep: false });

  // Child's data should now be {env:'v2'}
  const childDataArt = getArt(store, childRow!.id, 'data');
  assert.deepEqual(childDataArt?.value, { env: 'v2' });

  // Still only one child
  assert.equal(store.listChildrenByParent(parentWf).length, 1);
});

// ---- test (d): failure branch -----------------------------------------------

test('calls: (d) failure branch — status-bearing outcome propagates, teardown runs', () => {
  const { engine, store } = makeEngine([failingChildDef, parentFailDef]);

  // parentFailDef has no inputs and deliver has no gate (callsInputs = {})
  const parentWf = engine.createInstance('parentFailDef');

  // Tick parent → maintainCalls spawns child (no gate needed, empty callsInputs)
  engine.tick(parentWf, { deep: false });
  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined, 'child should be spawned immediately with empty callsInputs');

  // Drive child evaluator to green 'outcome' with {status:'failed'}
  const childTick = engine.tick(childRow!.id);
  assert.equal(childTick.orders.length, 1);
  const evalRun = childTick.orders[0]!.run;
  engine.green(childRow!.id, evalRun, 'outcome', { status: 'failed' });
  engine.close(childRow!.id, evalRun);

  // Tick parent → maintainCalls reads child outcome → machine-greens 'delivered' with {status:'failed'}
  // Teardown also becomes eligible in the same tick (settle fires inside maintainCalls, then again in tick)
  const tick3 = engine.tick(parentWf, { deep: false });
  const deliveredArt = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredArt?.acceptance, 'green');
  assert.deepEqual(deliveredArt?.value, { status: 'failed' });

  // Teardown becomes eligible (consumes 'delivered' which is now green)
  const teardownOrder = tick3.orders.find((o) => o.step === 'teardown');
  assert.ok(teardownOrder !== undefined, 'teardown should fire even on failure branch');

  // Complete teardown → parent done
  engine.green(parentWf, teardownOrder!.run, 'done', { status: 'ok' });
  engine.close(parentWf, teardownOrder!.run);
  assert.equal(getArt(store, parentWf, 'done')?.acceptance, 'green');
});

// ---- test (e): child outcome re-green ----------------------------------------

test('calls: (e) child outcome re-green — parent delivered updates with new value', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });

  // Green sandbox, tick → child spawned
  const tick1 = engine.tick(parentWf, { deep: false });
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'test' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf, { deep: false });

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);

  // Drive child to green result with {value:'v1'}
  const childTick1 = engine.tick(childRow!.id);
  const run1 = childTick1.orders[0]!.run;
  engine.green(childRow!.id, run1, 'result', { value: 'v1' });
  engine.close(childRow!.id, run1);

  // Tick parent → delivered greens with {value:'v1'}
  engine.tick(parentWf, { deep: false });
  assert.deepEqual(getArt(store, parentWf, 'delivered')?.value, { value: 'v1' });

  // Re-arm child's result via retry so it goes back to owed
  engine.retry(childRow!.id, 'result');

  // Drive child again with {value:'v2'}
  const childTick2 = engine.tick(childRow!.id);
  assert.ok(childTick2.orders.length > 0, 'child should have a new worker order after retry');
  const run2 = childTick2.orders[0]!.run;
  engine.green(childRow!.id, run2, 'result', { value: 'v2' });
  engine.close(childRow!.id, run2);

  // Tick parent → maintainCalls detects value changed → re-greens delivered with {value:'v2'}
  engine.tick(parentWf, { deep: false });
  const deliveredArt = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredArt?.acceptance, 'green');
  assert.deepEqual(deliveredArt?.value, { value: 'v2' });
});

// ---- test (f): gate re-arm ---------------------------------------------------

test('calls: (f) gate re-arm — cascade re-arms delivered, maintainCalls re-provides and re-greens', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });

  // Green sandbox v1, tick → child spawned
  const tick1 = engine.tick(parentWf, { deep: false });
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf, { deep: false });

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);

  // Drive child to green result, cascade-up greens parent 'delivered'
  const childTick1 = engine.tick(childRow!.id);
  const workerRun = childTick1.orders[0]!.run;
  engine.green(childRow!.id, workerRun, 'result', { value: 'done-v1' });
  engine.close(childRow!.id, workerRun);
  engine.tick(parentWf, { deep: false });

  const deliveredV1 = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredV1?.acceptance, 'green');
  assert.deepEqual(deliveredV1?.value, { value: 'done-v1' });

  // Update sandbox to a new version (simulate re-provision) — this should re-arm 'delivered'
  // via the existing cascade (fingerprintMatches detects sandbox version changed).
  const sandboxArt = getArt(store, parentWf, 'sandbox');
  assert.ok(sandboxArt !== undefined);
  store.putArtifact({
    ...sandboxArt!,
    version: sandboxArt!.version + 1,
    value: { env: 'v2' },
  });

  // Tick parent → the cascade in settle() re-arms 'delivered' to owed (fingerprint mismatch)
  engine.tick(parentWf, { deep: false });
  const deliveredAfterMove = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredAfterMove?.acceptance, 'owed', 'delivered should be re-armed to owed after sandbox moved');

  // Tick parent again → maintainCalls runs → detects data mismatch → re-provides to child
  engine.tick(parentWf, { deep: false });
  assert.deepEqual(getArt(store, childRow!.id, 'data')?.value, { env: 'v2' });

  // Drive child to re-green its result
  engine.retry(childRow!.id, 'result');
  const childTick2 = engine.tick(childRow!.id);
  assert.ok(childTick2.orders.length > 0);
  const run2 = childTick2.orders[0]!.run;
  engine.green(childRow!.id, run2, 'result', { value: 'done-v2' });
  engine.close(childRow!.id, run2);

  // Tick parent → maintainCalls re-greens 'delivered'
  engine.tick(parentWf, { deep: false });
  const deliveredV2 = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredV2?.acceptance, 'green');
  assert.deepEqual(deliveredV2?.value, { value: 'done-v2' });
});

// ---- test (g): provideInput cascades to calls: child without extra tick -------

/**
 * parentProvideDef: input(data2 seedOwed) feeds directly into the deliver step's
 * callsInputs so that engine.provideInput(parentWf, 'data2', ...) must cascade
 * immediately to the child's 'data' artifact — no extra tick required.
 */
const parentProvideStep: StepDef = {
  ...step({ name: 'deliver', produces: ['delivered'] }),
  calls: 'childDef',
  callsInputs: { data: 'data2' },
  consumes: [],
};
const parentProvideDef: WorkflowDef = def(
  'parentProvideDef',
  [input('data2', { seedOwed: true })],
  [parentProvideStep],
);

test('calls: (g) provideInput cascades to calls: child without extra tick', () => {
  const { engine, store } = makeEngine([childDef, parentProvideDef]);

  // Create parent with data2=v1 provided
  const parentWf = engine.createInstance('parentProvideDef', { provide: { data2: { env: 'v1' } } });

  // Tick parent → maintainCalls spawns child immediately (gate input data2 is green)
  engine.tick(parentWf, { deep: false });
  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined, 'child should be spawned after tick with data2 green');
  assert.deepEqual(getArt(store, childRow!.id, 'data')?.value, { env: 'v1' });

  // Re-provide data2 via provideInput (human/external update) — no extra tick
  engine.provideInput(parentWf, 'data2', { env: 'v2' });

  // Without any extra tick, child data must already be updated to v2
  assert.deepEqual(
    getArt(store, childRow!.id, 'data')?.value,
    { env: 'v2' },
    'child input must be updated immediately by provideInput cascade, no extra tick required',
  );
});

// ---- defs validation tests (outputs: check) ----------------------------------

test('loadDefs: calls target with no outputs: throws DefError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-calls-test-'));
  try {
    writeFileSync(
      join(dir, 'child.yaml'),
      [
        'name: child',
        'steps:',
        '  - name: worker',
        '    produces: [result]',
        '    body: do work',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'parent.yaml'),
      [
        'name: parent',
        'outputs: [delivered]',
        'steps:',
        '  - name: deliver',
        '    calls: child',
        '    produces: [delivered]',
      ].join('\n'),
    );
    assert.throws(
      () => loadDefs(dir),
      (err: unknown) => {
        assert.ok(err instanceof DefError, `expected DefError, got ${String(err)}`);
        assert.ok(
          /calls names workflow 'child' which declares no outputs:/.test(err.message),
          `expected no-outputs error; got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDefs: calls target with 2 outputs: throws DefError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-calls-test-'));
  try {
    writeFileSync(
      join(dir, 'child.yaml'),
      [
        'name: child',
        'outputs: [result, report]',
        'steps:',
        '  - name: worker',
        '    produces: [result]',
        '    body: do work',
        '  - name: reporter',
        '    consumes: [result]',
        '    produces: [report]',
        '    body: do report',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'parent.yaml'),
      [
        'name: parent',
        'outputs: [delivered]',
        'steps:',
        '  - name: deliver',
        '    calls: child',
        '    produces: [delivered]',
      ].join('\n'),
    );
    assert.throws(
      () => loadDefs(dir),
      (err: unknown) => {
        assert.ok(err instanceof DefError, `expected DefError, got ${String(err)}`);
        assert.ok(
          /calls names workflow 'child' which declares 2 outputs:, calls: v1 requires exactly one/.test(err.message),
          `expected too-many-outputs error; got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDefs: calls target with exactly 1 output is valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-calls-test-'));
  try {
    writeFileSync(
      join(dir, 'child.yaml'),
      [
        'name: child',
        'outputs: [result]',
        'steps:',
        '  - name: worker',
        '    produces: [result]',
        '    body: do work',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'parent.yaml'),
      [
        'name: parent',
        'outputs: [delivered]',
        'steps:',
        '  - name: deliver',
        '    calls: child',
        '    produces: [delivered]',
        '  - name: teardown',
        '    consumes: [delivered]',
        '    produces: [done]',
        '    terminal: true',
        '    body: done',
      ].join('\n'),
    );
    assert.doesNotThrow(() => loadDefs(dir), 'calls target with 1 output must not throw');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- F2: child input-schema refusal becomes a debt, not a thrown tick -------

/**
 * strictChildDef: like childDef, but its `data` input declares a strict
 * schema (`env` must be a string) — a value legal for the PARENT's own
 * (schema-less) `sandbox`/`data2` artifact can still be illegal here.
 */
const strictChildDef: WorkflowDef = {
  ...def(
    'strictChildDef',
    [{ ...input('data', { seedOwed: true }), schema: { type: 'object', properties: { env: { type: 'string' } }, required: ['env'] } }],
    [step({ name: 'worker', consumes: ['data'], produces: ['result'] })],
  ),
  outputs: ['result'],
};

const strictDeliverStep: StepDef = {
  ...step({ name: 'deliver', produces: ['delivered'] }),
  calls: 'strictChildDef',
  callsInputs: { data: 'sandbox' },
  consumes: [],
};

const strictParentDef: WorkflowDef = def(
  'strictParentDef',
  [input('proposal', { seedOwed: true })],
  [
    step({ name: 'provision', consumes: ['proposal'], produces: ['sandbox'] }),
    strictDeliverStep,
    step({ name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true }),
  ],
);

test('calls: F2 — spawn-time child schema refusal is a debt, tick does not throw', () => {
  const { engine, store } = makeEngine([strictChildDef, strictParentDef]);

  const parentWf = engine.createInstance('strictParentDef', { provide: { proposal: { text: 'hello' } } });

  const tick1 = engine.tick(parentWf, { deep: false });
  const provRun = tick1.orders[0]!.run;
  // sandbox is schema-less at the parent, so a number for `env` greens fine here...
  engine.green(parentWf, provRun, 'sandbox', { env: 42 });
  engine.close(parentWf, provRun);

  // ...but the child's `data` input requires env: string — tick must NOT throw.
  assert.doesNotThrow(() => engine.tick(parentWf, { deep: false }));

  const delivered = getArt(store, parentWf, 'delivered');
  assert.equal(delivered?.acceptance, 'rejected');
  assert.equal(delivered?.schemaRejects, 1);
  const lastReason = delivered!.reasons[delivered!.reasons.length - 1]!;
  assert.equal(lastReason.kind, 'validation');
  assert.match(lastReason.text, /data/);

  // No child should have been spawned — the schema refusal happened inside createInstance.
  assert.equal(store.findChildByParent(parentWf, 'delivered'), undefined);

  // Subsequent ticks with the gate unmoved must not re-throw or double-bump schemaRejects.
  engine.tick(parentWf, { deep: false });
  engine.tick(parentWf, { deep: false });
  const deliveredAfter = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredAfter?.schemaRejects, 1, 'schemaRejects must not double-bump while gate is unmoved');
  assert.equal(store.findChildByParent(parentWf, 'delivered'), undefined, 'no spawn attempt while rejected+unmoved gate');

  // Fix the parent value (re-green gate) — retry then clears the path: spawn succeeds.
  const sandboxArt = getArt(store, parentWf, 'sandbox');
  store.putArtifact({ ...sandboxArt!, version: sandboxArt!.version + 1, value: { env: 'ok-now' } });
  engine.retry(parentWf, 'delivered');
  engine.tick(parentWf, { deep: false });

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined, 'spawn should succeed once the gate value is fixed');
  assert.deepEqual(getArt(store, childRow!.id, 'data')?.value, { env: 'ok-now' });
});

test('calls: F2 — re-provide-time child schema refusal is a debt, human provide of PARENT input still commits', () => {
  const { engine, store } = makeEngine([strictChildDef, strictParentDef]);

  const parentWf = engine.createInstance('strictParentDef', { provide: { proposal: { text: 'hello' } } });

  // Healthy spawn: sandbox greens with a legal value.
  const tick1 = engine.tick(parentWf, { deep: false });
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf, { deep: false });

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined, 'child should spawn on a legal value');
  assert.deepEqual(getArt(store, childRow!.id, 'data')?.value, { env: 'v1' });

  // Parent value moves to a child-illegal value (schema-less at the parent, so this
  // update itself is not refused at the parent level) — simulate a re-provision.
  const sandboxArt = getArt(store, parentWf, 'sandbox');
  store.putArtifact({ ...sandboxArt!, version: sandboxArt!.version + 1, value: { env: 7 } });

  // tick's maintainCalls cascade-up must not throw out of provideInput.
  assert.doesNotThrow(() => engine.tick(parentWf, { deep: false }));

  const delivered = getArt(store, parentWf, 'delivered');
  assert.equal(delivered?.acceptance, 'rejected');
  assert.equal(delivered?.schemaRejects, 1);

  // The child's data input must be unchanged (the re-provide never committed).
  assert.deepEqual(getArt(store, childRow!.id, 'data')?.value, { env: 'v1' });
});

// ---- F4: reject on a calls artifact propagates to the child -----------------

test('calls: F4 — reject on calls artifact with no spawned child is refused', () => {
  const { engine } = makeEngine([childDef, parentDef]);
  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });
  // No tick yet — 'delivered' is owed and no child has ever been spawned.
  assert.throws(() => engine.reject(parentWf, 'delivered', 'human', 'no'), /no child instance has been spawned/);
});

test('calls: F4 — reject propagates to child outcome, parent reopens to owed, re-arm re-mirrors', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });
  const tick1 = engine.tick(parentWf, { deep: false });
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf, { deep: false });

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);
  const childTick1 = engine.tick(childRow!.id);
  const workerRun = childTick1.orders[0]!.run;
  engine.green(childRow!.id, workerRun, 'result', { value: 'v1' });
  engine.close(childRow!.id, workerRun);
  engine.tick(parentWf, { deep: false });

  const deliveredGreen = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredGreen?.acceptance, 'green');
  assert.deepEqual(deliveredGreen?.value, { value: 'v1' });

  const childOutcomeGreenVersion = getArt(store, childRow!.id, 'result')!.version;

  // Consumer rejects the parent calls artifact.
  const rejectResult = engine.reject(parentWf, 'delivered', 'teardown', 'not good enough');
  assert.equal(rejectResult.outcome, 'rejected');

  // Child outcome → rejected, judgmentRejects+1, author `parent:teardown`.
  const childOutcomeAfterReject = getArt(store, childRow!.id, 'result');
  assert.equal(childOutcomeAfterReject?.acceptance, 'rejected');
  assert.equal(childOutcomeAfterReject?.judgmentRejects, 1);
  const childLastReason = childOutcomeAfterReject!.reasons[childOutcomeAfterReject!.reasons.length - 1]!;
  assert.equal(childLastReason.by, 'parent:teardown');
  assert.equal(childLastReason.text, 'not good enough');

  // Parent reopened to owed (not left rejected).
  const deliveredAfterReject = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredAfterReject?.acceptance, 'owed');

  // F4 livelock gone: a tick does NOT re-green the parent from the unchanged child value.
  engine.tick(parentWf, { deep: false });
  const deliveredStillOwed = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredStillOwed?.acceptance, 'owed', 'must not re-green from the unchanged (rejected) child value');

  // Child producer re-fires with the feedback on its owes thread — the normal knock-back loop.
  const childTick2 = engine.tick(childRow!.id);
  assert.ok(childTick2.orders.length > 0, 'child worker should re-fire after the rejected result re-arms it');
  const owesEntry = childTick2.orders[0]!.owes.find((o) => o.path === 'result');
  assert.ok(owesEntry !== undefined);
  assert.ok(
    owesEntry!.reasons.some((r) => r.text === 'not good enough' && r.by === 'parent:teardown'),
    'the feedback must ride the child producer\'s owes thread',
  );

  // Child re-greens with a new value/version.
  const run2 = childTick2.orders[0]!.run;
  engine.green(childRow!.id, run2, 'result', { value: 'v2' });
  engine.close(childRow!.id, run2);
  assert.ok(getArt(store, childRow!.id, 'result')!.version > childOutcomeGreenVersion);

  // Parent mirrors the new value.
  engine.tick(parentWf, { deep: false });
  const deliveredV2 = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredV2?.acceptance, 'green');
  assert.deepEqual(deliveredV2?.value, { value: 'v2' });
});

// ---- F4: ordering A/B — skip pin vs. child re-run ----------------------------

test('calls: F4 ordering A — human skip on green calls artifact survives arbitrary ticks (child unchanged)', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });
  const tick1 = engine.tick(parentWf, { deep: false });
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf, { deep: false });

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);
  const childTick1 = engine.tick(childRow!.id);
  const workerRun = childTick1.orders[0]!.run;
  engine.green(childRow!.id, workerRun, 'result', { value: 'v3' });
  engine.close(childRow!.id, workerRun);
  engine.tick(parentWf, { deep: false });

  assert.equal(getArt(store, parentWf, 'delivered')?.acceptance, 'green');

  // Human skips the green calls artifact after seeing child result v3; child stays at v3.
  engine.skip(parentWf, 'delivered', 'human', 'skipping this branch');
  assert.equal(getArt(store, parentWf, 'delivered')?.acceptance, 'skipped');

  // The machine never overrides a decision made on current evidence — arbitrary ticks
  // must not re-green 'delivered' back from 'skipped' while the child is unchanged.
  for (let i = 0; i < 5; i++) engine.tick(parentWf, { deep: false });
  assert.equal(getArt(store, parentWf, 'delivered')?.acceptance, 'skipped', 'skip must survive arbitrary ticks');
});

test('calls: F4 ordering B — skip pinned to stale child version; gate moves, child re-runs, parent re-arms and mirrors', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });
  const tick1 = engine.tick(parentWf, { deep: false });
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf, { deep: false });

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);
  const childTick1 = engine.tick(childRow!.id);
  const workerRun = childTick1.orders[0]!.run;
  engine.green(childRow!.id, workerRun, 'result', { value: 'v3' });
  engine.close(childRow!.id, workerRun);
  engine.tick(parentWf, { deep: false });

  // Skip pinned to the v3 child outcome version.
  engine.skip(parentWf, 'delivered', 'human', 'skipping for now');
  assert.equal(getArt(store, parentWf, 'delivered')?.acceptance, 'skipped');

  // Gate moves: sandbox re-provisioned to v2.
  const sandboxArt = getArt(store, parentWf, 'sandbox');
  store.putArtifact({ ...sandboxArt!, version: sandboxArt!.version + 1, value: { env: 'v2' } });
  engine.tick(parentWf, { deep: false }); // re-provides child's data input

  assert.deepEqual(getArt(store, childRow!.id, 'data')?.value, { env: 'v2' });

  // Child re-runs and lands a new outcome version.
  engine.retry(childRow!.id, 'result');
  const childTick2 = engine.tick(childRow!.id);
  assert.ok(childTick2.orders.length > 0);
  const run2 = childTick2.orders[0]!.run;
  engine.green(childRow!.id, run2, 'result', { value: 'v4' });
  engine.close(childRow!.id, run2);

  // A months-old skip cannot permanently gag a fresh child result: parent re-arms and mirrors.
  engine.tick(parentWf, { deep: false });
  const deliveredAfter = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredAfter?.acceptance, 'green', 'stale pin must not block a fresh child result from mirroring');
  assert.deepEqual(deliveredAfter?.value, { value: 'v4' });
});

// ---- F4 sweeping note: propagated reject surfaces in the CHILD's status.debts ----

test('calls: F4 — a propagated reject surfaces in the CHILD workflow\'s status.debts (visible to sweeps)', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });
  const tick1 = engine.tick(parentWf, { deep: false });
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf, { deep: false });

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);
  const childTick1 = engine.tick(childRow!.id);
  const workerRun = childTick1.orders[0]!.run;
  engine.green(childRow!.id, workerRun, 'result', { value: 'v1' });
  engine.close(childRow!.id, workerRun);
  engine.tick(parentWf, { deep: false });

  engine.reject(parentWf, 'delivered', 'teardown', 'needs rework');

  // The rejected child outcome must be visible via the CHILD's own status,
  // without any extra prompting — a driver that only sweeps children by
  // status (not by following producedBy links) still sees the debt.
  const childStatus = engine.status(childRow!.id);
  const resultDebt = childStatus.debts.find((d) => d.path === 'result');
  assert.ok(resultDebt !== undefined, 'the rejected child outcome must appear in the child\'s status.debts');
  assert.equal(resultDebt!.acceptance, 'rejected');
});

// ============================================================================
// §23.6.8 DEEP TICK — descend into calls: children from the parent tick, and
// surface child stalls on parent status. (Change 1 + Change 2.)
// ============================================================================

// ---- 3-level nesting fixtures (leaf = childDef) -----------------------------

/** midDef: calls childDef (leaf); its own output is the leaf mirror. */
const midDeliverStep: StepDef = {
  ...step({ name: 'middeliver', produces: ['leaf_mirror'] }),
  calls: 'childDef',
  callsInputs: { data: 'mid_in' },
  consumes: [],
};
const midDef: WorkflowDef = {
  ...def('midDef', [input('mid_in', { seedOwed: true })], [midDeliverStep]),
  outputs: ['leaf_mirror'],
};

/** topDef: calls midDef; its own output is the mid mirror. */
const topDeliverStep: StepDef = {
  ...step({ name: 'topdeliver', produces: ['mid_mirror'] }),
  calls: 'midDef',
  callsInputs: { mid_in: 'top_in' },
  consumes: [],
};
const topDef: WorkflowDef = {
  ...def('topDef', [input('top_in', { seedOwed: true })], [topDeliverStep]),
  outputs: ['mid_mirror'],
};

// ---- stall fixtures (a child whose result can be rejected to the cap) --------

/**
 * stallChildDef: `worker` produces `result` (its declared output); `checker`
 * consumes `result` and so has authority to `reject` it. worker.maxAttempts=2,
 * so two rejects drive `result` past the §6 stall cap → `stalled`.
 */
const stallChildDef: WorkflowDef = {
  ...def(
    'stallChildDef',
    [input('data', { seedOwed: true })],
    [
      step({ name: 'worker', consumes: ['data'], produces: ['result'], maxAttempts: 2 }),
      step({ name: 'checker', consumes: ['result'], produces: ['verdict'] }),
    ],
  ),
  outputs: ['result'],
};

const stallDeliverStep: StepDef = {
  ...step({ name: 'deliver', produces: ['delivered'] }),
  calls: 'stallChildDef',
  callsInputs: { data: 'sandbox' },
  consumes: [],
};
const stallParentDef: WorkflowDef = def(
  'stallParentDef',
  [input('proposal', { seedOwed: true })],
  [
    step({ name: 'provision', consumes: ['proposal'], produces: ['sandbox'] }),
    stallDeliverStep,
    step({ name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true }),
  ],
);

/** stallMidDef: calls stallChildDef (a stall-capable leaf). */
const stallMidDeliverStep: StepDef = {
  ...step({ name: 'middeliver', produces: ['leaf_mirror'] }),
  calls: 'stallChildDef',
  callsInputs: { data: 'mid_in' },
  consumes: [],
};
const stallMidDef: WorkflowDef = {
  ...def('stallMidDef', [input('mid_in', { seedOwed: true })], [stallMidDeliverStep]),
  outputs: ['leaf_mirror'],
};

/** stallTopDef: calls stallMidDef → a 3-level tree whose leaf can stall. */
const stallTopDeliverStep: StepDef = {
  ...step({ name: 'topdeliver', produces: ['mid_mirror'] }),
  calls: 'stallMidDef',
  callsInputs: { mid_in: 'top_in' },
  consumes: [],
};
const stallTopDef: WorkflowDef = {
  ...def('stallTopDef', [input('top_in', { seedOwed: true })], [stallTopDeliverStep]),
  outputs: ['mid_mirror'],
};

// ---- helpers ----------------------------------------------------------------

/** Drive a parentDef instance until the child is spawned (shallow, no descent). */
function spawnChild(engine: Engine, store: Store, parentWf: string): string {
  const t1 = engine.tick(parentWf, { deep: false });
  const provRun = t1.orders.find((o) => o.step === 'provision')!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf, { deep: false }); // maintainCalls spawns child, no descent
  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined, 'child should be spawned');
  return childRow!.id;
}

/** Reject a stallChildDef's `result` to its stall cap (2). */
function stallResult(engine: Engine, childWf: string): void {
  for (let i = 0; i < 2; i++) {
    const ct = engine.tick(childWf, { deep: false });
    const wo = ct.orders.find((o) => o.step === 'worker');
    assert.ok(wo !== undefined, `worker should re-fire (attempt ${i})`);
    engine.green(childWf, wo!.run, 'result', { n: i });
    engine.close(childWf, wo!.run);
    engine.reject(childWf, 'result', 'checker', 'nope');
  }
}

// ---- (2) three-level nesting ------------------------------------------------

test('calls: deep tick (2) three-level nesting — tick(root) surfaces the grandchild order', () => {
  const { engine, store } = makeEngine([childDef, midDef, topDef]);
  const root = engine.createInstance('topDef', { provide: { top_in: { env: 'g' } } });

  // One deep tick spawns mid, provides its input, descends → spawns leaf,
  // provides its input, descends → claims the leaf's worker order.
  const t = engine.tick(root);

  const midRow = store.findChildByParent(root, 'mid_mirror');
  assert.ok(midRow !== undefined, 'mid child spawned');
  const leafRow = store.findChildByParent(midRow!.id, 'leaf_mirror');
  assert.ok(leafRow !== undefined, 'leaf grandchild spawned');

  const workerOrder = t.orders.find((o) => o.step === 'worker');
  assert.ok(workerOrder !== undefined, 'root tick surfaces the grandchild worker order');
  assert.equal(workerOrder!.workflow, leafRow!.id, 'grandchild order carries the grandchild workflow id');
});

// ---- (3) gate not green → no descend ----------------------------------------

test('calls: deep tick (3) gate re-armed → no descend that round', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);
  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'x' } } });
  const childWf = spawnChild(engine, store, parentWf);

  // Re-arm the gate input (sandbox) to non-green — the child is mid-work.
  const sb = getArt(store, parentWf, 'sandbox')!;
  store.putArtifact({ ...sb, acceptance: 'owed' });

  const t = engine.tick(parentWf); // deep, but gate not ready → descent skipped
  assert.ok(t.orders.every((o) => o.workflow !== childWf), 'no child orders while gate re-armed');
  assert.ok(t.deferred.every((d) => d.workflow !== childWf), 'no child deferrals — descent skipped entirely');
});

// ---- (4) debt paid → no descend ---------------------------------------------

test('calls: deep tick (4) calls artifact green → no descend', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);
  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'x' } } });
  const childWf = spawnChild(engine, store, parentWf);

  // Drive the child to green its result, then tick parent to machine-green delivered.
  const ct = engine.tick(childWf, { deep: false });
  const wo = ct.orders.find((o) => o.step === 'worker')!;
  engine.green(childWf, wo.run, 'result', { value: 'ok' });
  engine.close(childWf, wo.run);
  engine.tick(parentWf, { deep: false });
  assert.equal(getArt(store, parentWf, 'delivered')?.acceptance, 'green', 'delivered debt is paid');

  // Deep tick with the debt paid → descent is skipped (no child orders).
  const t = engine.tick(parentWf);
  assert.ok(t.orders.every((o) => o.workflow !== childWf), 'no child orders once the calls debt is green');
  assert.equal(getArt(store, parentWf, 'delivered')?.acceptance, 'green');
});

// ---- (5) deep:false / --shallow restores today's behavior -------------------

test('calls: deep tick (5) { deep: false } returns only this instance\'s orders', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);
  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'x' } } });
  const childWf = spawnChild(engine, store, parentWf);

  // Shallow parent tick emits no child order...
  const shallow = engine.tick(parentWf, { deep: false });
  assert.ok(shallow.orders.every((o) => o.workflow !== childWf), 'shallow tick returns no child orders');

  // ...the explicit child tick is still required to get the worker order.
  const ct = engine.tick(childWf, { deep: false });
  assert.ok(ct.orders.find((o) => o.step === 'worker') !== undefined, 'child worker via explicit child tick');
});

// ---- (6) in-flight dedup ----------------------------------------------------

test('calls: deep tick (6) second tick(parent) → in-flight deferral stamped with child id, no duplicate', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);
  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'x' } } });

  const p1 = engine.tick(parentWf);
  engine.green(parentWf, p1.orders[0]!.run, 'sandbox', { env: 'v1' });
  engine.close(parentWf, p1.orders[0]!.run);

  // First deep tick: spawn child + claim its worker order.
  const t = engine.tick(parentWf);
  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);
  const wo = t.orders.find((o) => o.step === 'worker' && o.workflow === childRow!.id);
  assert.ok(wo !== undefined, 'first parent tick claims the child worker');

  // Second deep tick: the child worker is already in-flight → deferred, not duplicated.
  const t2 = engine.tick(parentWf);
  assert.equal(
    t2.orders.find((o) => o.step === 'worker' && o.workflow === childRow!.id),
    undefined,
    'no duplicate child order',
  );
  const dfr = t2.deferred.find((d) => d.reason === 'in-flight' && d.workflow === childRow!.id);
  assert.ok(dfr !== undefined, 'in-flight deferral is stamped with the child workflow id');
});

// ---- (7) stalled child → parent status --------------------------------------

test('calls: deep tick (7) stalled child surfaces child.stalled on the parent debt', () => {
  const { engine, store } = makeEngine([stallChildDef, stallParentDef]);
  const parentWf = engine.createInstance('stallParentDef', { provide: { proposal: { text: 'x' } } });
  const childWf = spawnChild(engine, store, parentWf);

  stallResult(engine, childWf);
  // Reconcile parent: the now-non-green child outcome re-arms delivered to owed.
  engine.tick(parentWf, { deep: false });

  const st = engine.status(parentWf);
  const deliveredDebt = st.debts.find((d) => d.path === 'delivered');
  assert.ok(deliveredDebt !== undefined, 'delivered is an unpaid debt while the child is stalled');
  assert.ok(deliveredDebt!.child !== undefined, 'a child summary is attached to the calls debt');
  assert.equal(deliveredDebt!.child!.workflow, childWf, 'child summary carries the child id to inspect');
  assert.equal(deliveredDebt!.child!.def, 'stallChildDef');
  assert.equal(deliveredDebt!.child!.stalled, true, 'a stalled child is visible from the parent');
});

test('calls: deep tick (7b) grandchild stall propagates to the root debt', () => {
  const { engine, store } = makeEngine([stallChildDef, stallMidDef, stallTopDef]);
  const root = engine.createInstance('stallTopDef', { provide: { top_in: { env: 'g' } } });

  // Spawn the tree shallowly, level by level.
  engine.tick(root, { deep: false }); // spawn mid, provide mid_in
  const midRow = store.findChildByParent(root, 'mid_mirror');
  assert.ok(midRow !== undefined, 'mid child spawned');
  engine.tick(midRow!.id, { deep: false }); // spawn leaf, provide data
  const leafRow = store.findChildByParent(midRow!.id, 'leaf_mirror');
  assert.ok(leafRow !== undefined, 'leaf grandchild spawned');

  // Stall the leaf, then reconcile the mirrors back up to owed.
  stallResult(engine, leafRow!.id);
  engine.tick(midRow!.id, { deep: false }); // mid re-arms leaf_mirror to owed
  engine.tick(root, { deep: false }); // root re-arms mid_mirror to owed

  const st = engine.status(root);
  const debt = st.debts.find((d) => d.path === 'mid_mirror');
  assert.ok(debt !== undefined, 'mid_mirror is an unpaid debt at the root');
  assert.ok(debt!.child !== undefined, 'mid child summary attached');
  assert.equal(debt!.child!.workflow, midRow!.id);
  assert.equal(debt!.child!.stalled, true, 'a grandchild stall propagates up to the root debt via the mid child');
});

// ---- (8) reap across the tree -----------------------------------------------

test('calls: deep tick (8) tick(parent) reaps a child\'s stale lease and re-emits the order', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);
  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'x' } } });

  const T0 = 1_000_000;
  const p1 = engine.tick(parentWf, { now: T0 });
  engine.green(parentWf, p1.orders[0]!.run, 'sandbox', { env: 'v1' });
  engine.close(parentWf, p1.orders[0]!.run);

  // Deep tick claims the child worker at T0.
  const t = engine.tick(parentWf, { now: T0 });
  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);
  assert.ok(
    t.orders.find((o) => o.step === 'worker' && o.workflow === childRow!.id) !== undefined,
    'child worker claimed at T0',
  );

  // Advance past the default 2h reap TTL — the parent deep tick reaps the
  // child's stale lease (reaped count includes it) and re-emits the order.
  const t2 = engine.tick(parentWf, { now: T0 + 3 * 60 * 60 * 1000 });
  assert.ok(t2.reaped >= 1, 'the child\'s stale lease is reaped through the parent deep tick');
  assert.ok(
    t2.orders.find((o) => o.step === 'worker' && o.workflow === childRow!.id) !== undefined,
    'the child worker order is re-emitted after the reap',
  );
});

// ---- (9) dueAt min-fold across the tree --------------------------------------

/** idleChildDef: childDef plus an idle step, so the child frame has a dueAt. */
const idleChildDef: WorkflowDef = {
  ...def(
    'idleChildDef',
    [input('data', { seedOwed: true })],
    [
      step({ name: 'worker', consumes: ['data'], produces: ['result'] }),
      step({ name: 'cnudge', consumes: [], produces: ['cnote'], on: ['idle'], idleAfterMs: 500_000 }),
    ],
  ),
  outputs: ['result'],
};

/** idleParentDef: parentDef plus an idle step, calling idleChildDef. */
const idleDeliverStep: StepDef = {
  ...step({ name: 'deliver', produces: ['delivered'] }),
  calls: 'idleChildDef',
  callsInputs: { data: 'sandbox' },
  consumes: [],
};
const idleParentDef: WorkflowDef = def(
  'idleParentDef',
  [input('proposal', { seedOwed: true })],
  [
    step({ name: 'provision', consumes: ['proposal'], produces: ['sandbox'] }),
    idleDeliverStep,
    step({ name: 'pnudge', consumes: [], produces: ['pnote'], on: ['idle'], idleAfterMs: 900_000 }),
    step({ name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true }),
  ],
);

test('calls: deep tick (9) dueAt is the min across parent and descended child', () => {
  const { engine, store } = makeEngine([idleChildDef, idleParentDef]);
  const parentWf = engine.createInstance('idleParentDef', { provide: { proposal: { text: 'x' } } });
  const childWf = spawnChild(engine, store, parentWf);

  // Pin each frame's idle threshold with an explicit alarm (E-SETALARM makes
  // computeDueAt deterministic: alarmAt wins over lastProgress + idleAfterMs).
  // Both alarms sit in the future so neither idle step actually fires.
  const NOW = Date.now();
  const childDue = NOW + 60_000;
  const parentDue = NOW + 120_000;
  engine.setAlarm(childWf, 'cnudge', childDue);
  engine.setAlarm(parentWf, 'pnudge', parentDue);

  // Child due first → the fold picks the child's dueAt.
  const t1 = engine.tick(parentWf);
  assert.equal(t1.dueAt, childDue, 'dueAt is the child\'s earlier alarm, folded up through the descent');

  // Flip the order: parent due first → the fold keeps the parent's own dueAt.
  engine.setAlarm(childWf, 'cnudge', NOW + 300_000);
  const t2 = engine.tick(parentWf);
  assert.equal(t2.dueAt, parentDue, 'dueAt stays the parent\'s alarm when it is the earlier of the two');
});

// ---- (10) unresolvable child def → status degrades, never throws --------------

test('calls: status with an unresolvable child def skips the child summary instead of throwing', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);
  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'x' } } });
  const childWf = spawnChild(engine, store, parentWf);

  // Simulate a pre-§28 (unpinned) child row whose def has since been removed:
  // replace the spawned child with a row that has no snapshot and a def name
  // the resolver does not know. defFor(child) now throws.
  store.deleteWorkflow(childWf);
  store.insertWorkflow('wf_ghost_child', { def: 'no-such-def' }, { parentWf, parentPath: 'delivered' });
  assert.throws(() => engine.status('wf_ghost_child'), /no def/, 'the child itself is genuinely unresolvable');

  // status(parent) must not throw — the calls debt survives, just without the
  // child summary (enrichment degrades, the parent stays inspectable).
  const st = engine.status(parentWf);
  const debt = st.debts.find((d) => d.path === 'delivered');
  assert.ok(debt !== undefined, 'the calls debt is still reported');
  assert.equal(debt!.child, undefined, 'the child summary is skipped, not fabricated');
});

// ---- (REL-4) runtime maxCallDepth bound ---------------------------------------
//
// Construction-time validation (createEngine → finalizeDefs) rejects calls:
// cycles, but a host can wire an Engine DIRECTLY with a custom DefResolver that
// construction validation cannot inspect. These tests exercise that path: a
// self-calling def reached through a bare resolver. Without the bound, deep tick
// spawns a fresh child instance at every level (a new DB row each) until the
// process stack overflows. With it, the engine stops cleanly at maxCallDepth.

/** A self-calling def: one step `again` that calls itself and outputs `out`. */
const recurDef: WorkflowDef = {
  ...def('recur', [], [
    { ...step({ name: 'again', produces: ['out'] }), calls: 'recur', callsInputs: {}, consumes: [] },
  ]),
  outputs: ['out'],
};

/** Engine wired with a bare resolver (no createEngine validation) + small bound. */
function makeRecurEngine(maxCallDepth: number): { engine: Engine; store: Store } {
  const store = openStore(':memory:');
  const engine = new Engine(store, (name) => {
    if (name === 'recur') return recurDef;
    throw new Error(`no def: ${name}`);
  }, { maxCallDepth });
  return { engine, store };
}

test('calls: (REL-4) maxCallDepth stops a self-calling def cleanly — no overflow, bounded rows', () => {
  const { engine, store } = makeRecurEngine(5);
  const root = engine.createInstance('recur');

  // (a) a deep tick returns normally — no throw, no stack overflow.
  assert.doesNotThrow(() => engine.tick(root));

  // (c) it leaves at most maxCallDepth + 1 instances (root + one per allowed
  //     spawn level), NOT the thousands the unbounded recursion produced.
  const rowsAfter1 = store.listWorkflows().length;
  assert.equal(rowsAfter1, 6, 'root + 5 spawned children = maxCallDepth + 1');

  // (b) the deepest instance's calls artifact is rejected with the depth reason.
  const rejected = store.listWorkflows()
    .map((w) => store.getArtifact(w.id, 'out'))
    .find((a) => a?.acceptance === 'rejected');
  assert.ok(rejected, 'the deepest parent calls artifact was rejected');
  const last = rejected!.reasons.at(-1);
  assert.match(last!.text, /calls depth limit reached \(maxCallDepth=5\)/);
  assert.equal(rejected!.schemaRejects, 0, 'a depth refusal is structural, not a schema failure');

  // (d) a SECOND tick creates no additional rows — the F2 fingerprint guard on
  //     the rejected artifact stops the engine re-attempting the refused spawn.
  assert.doesNotThrow(() => engine.tick(root));
  assert.equal(store.listWorkflows().length, rowsAfter1, 'no new instances on re-tick');
  store.close();
});

test('calls: (REL-4) an unset maxCallDepth leaves a modest real composition unaffected', () => {
  // A genuine (acyclic) parent→child composition still drives end-to-end under
  // the default bound (64) — the bound only trips a pathological chain.
  const { engine, store } = makeEngine([childDef, parentDef]);
  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });

  const t1 = engine.tick(parentWf);
  const prov = t1.orders.find((o) => o.step === 'provision');
  assert.ok(prov, 'provision fired');
  engine.green(parentWf, prov!.run, 'sandbox', { env: 'test-env' });
  engine.close(parentWf, prov!.run);

  engine.tick(parentWf); // spawns the child, no depth refusal
  const child = store.findChildByParent(parentWf, 'delivered');
  assert.ok(child, 'child spawned under the default bound');
  assert.equal(store.getArtifact(child!.id, 'result')?.acceptance !== 'rejected', true);
  store.close();
});

// ---- (11) REL-5: two engines on the same DB converge on exactly one child ----

test('calls: REL-5 — two engines over one DB file spawn exactly one child (atomic re-attach)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-rel5-'));
  const dbPath = join(dir, 'concurrent.db');
  try {
    const byName = new Map([childDef, parentDef].map((d) => [d.name, d]));
    const resolver = (name: string): WorkflowDef => {
      const d = byName.get(name);
      if (!d) throw new Error(`no def: ${name}`);
      return d;
    };
    // Two independent engines/connections over the SAME database file — the
    // cross-process shape REL-5 guards against.
    const store1 = openStore(dbPath);
    const store2 = openStore(dbPath);
    const engine1 = new Engine(store1, resolver);
    const engine2 = new Engine(store2, resolver);

    // Count child-spawn 'instance' events observed by each engine.
    let e1Instances = 0;
    let e2Instances = 0;
    engine1.subscribe((e) => { if (e.type === 'instance') e1Instances++; });
    engine2.subscribe((e) => { if (e.type === 'instance') e2Instances++; });

    // Create the parent and green its gate (sandbox) via engine1.
    const parentWf = engine1.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });
    const tick1 = engine1.tick(parentWf, { deep: false });
    const provRun = tick1.orders.find((o) => o.step === 'provision')!.run;
    engine1.green(parentWf, provRun, 'sandbox', { env: 'v1' });
    engine1.close(parentWf, provRun);

    // Both connections see no child yet (the pre-spawn stale-read both drivers
    // would observe under a real race).
    assert.equal(store1.findChildByParent(parentWf, 'delivered'), undefined);
    assert.equal(store2.findChildByParent(parentWf, 'delivered'), undefined);

    // Ignore the parent-creation instance event; measure only the child spawn.
    e1Instances = 0;
    e2Instances = 0;

    // Both engines maintain the same parent's calls: step. The first spawns the
    // child atomically; the second observes the committed child and re-attaches.
    engine1.tick(parentWf, { deep: false });
    engine2.tick(parentWf, { deep: false });

    // Exactly one child, seen identically by both connections.
    const children1 = store1.listChildrenByParent(parentWf);
    const children2 = store2.listChildrenByParent(parentWf);
    assert.equal(children1.length, 1, 'exactly one child despite two engines ticking the same parent');
    assert.equal(children2.length, 1, 'the second connection sees the same single child');
    assert.equal(children1[0]!.id, children2[0]!.id, 'both engines converge on the same child id');

    // Only the engine that actually created the child fires an 'instance' event;
    // the re-attaching engine is silent (matches pre-REL-5 re-attach semantics).
    assert.equal(e1Instances, 1, 'the spawning engine fires exactly one instance event');
    assert.equal(e2Instances, 0, 're-attaching engine fires no instance event');

    store1.close();
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (12) REL-5: the loser's spawn path re-attaches (created: false) ---------
//
// Test (11) drives the loser via engine2.tick, whose STEP 2 read sees the
// already-committed child and takes the RE-ATTACH branch — so it never enters
// spawnChildIfAbsent at all. That leaves the primary REL-5 race eliminator —
// spawnChildIfAbsent's in-tx re-check (`if (existing) return { created: false }`)
// and its `created: false` return — unexercised: a regression that hoisted the
// re-check out of the tx or broke the created flag would keep the suite green.
// Here we drive the loser's spawn path DIRECTLY against a committed child and
// assert it re-attaches to the winner without creating a second row or firing.
test('calls: REL-5 — losing spawnChildIfAbsent re-attaches to the winner (created: false, no event)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-rel5-loser-'));
  const dbPath = join(dir, 'concurrent.db');
  try {
    const byName = new Map([childDef, parentDef].map((d) => [d.name, d]));
    const resolver = (name: string): WorkflowDef => {
      const d = byName.get(name);
      if (!d) throw new Error(`no def: ${name}`);
      return d;
    };
    const store1 = openStore(dbPath);
    const store2 = openStore(dbPath);
    const engine1 = new Engine(store1, resolver);
    const engine2 = new Engine(store2, resolver);

    let e2Instances = 0;
    engine2.subscribe((e) => { if (e.type === 'instance') e2Instances++; });

    // engine1 creates the parent, greens the gate, and spawns the child (winner).
    const parentWf = engine1.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });
    const tick1 = engine1.tick(parentWf, { deep: false });
    const provRun = tick1.orders.find((o) => o.step === 'provision')!.run;
    engine1.green(parentWf, provRun, 'sandbox', { env: 'v1' });
    engine1.close(parentWf, provRun);
    engine1.tick(parentWf, { deep: false }); // spawns the child

    const winner = store1.findChildByParent(parentWf, 'delivered');
    assert.ok(winner, 'engine1 spawned the winning child');
    e2Instances = 0; // ignore any earlier engine2-observed events

    // Drive engine2's spawn path directly with the SAME coordinates a losing
    // driver's maintainCalls STEP 3 would use (callsInputs { data: sandbox },
    // sandbox = { env: 'v1' }). It must re-attach to the winner, not create a
    // second child, and — since it did not create — fire no instance event.
    const spawn = (
      engine2 as unknown as {
        spawnChildIfAbsent(
          defName: string,
          parentWf: string,
          callsPath: string,
          seedProvide: Record<string, Record<string, unknown>>,
        ): { id: string; created: boolean };
      }
    ).spawnChildIfAbsent('childDef', parentWf, 'delivered', { data: { env: 'v1' } });

    assert.deepEqual(spawn, { id: winner!.id, created: false }, 'loser re-attaches to the winner with created: false');
    assert.equal(store2.listChildrenByParent(parentWf).length, 1, 'no second child row was created');
    assert.equal(e2Instances, 0, 'a re-attaching (created: false) spawn fires no instance event');

    store1.close();
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (13) REL-5: atomic snapshot-and-commit — the deep-tick stale-publish race
//
// The re-audit's cross-connection interleave: connection X's maintainCalls reads
// the child outcome as green (v1) in its optimistic STEP-6 pre-read; connection Y
// then advances the parent gate (sandbox → v2) and re-provides, which re-arms the
// child outcome to owed; X must NOT go on to publish the parent `delivered`
// artifact with the stale v1 child value under a fingerprint claiming the v2 gate,
// and must NOT issue downstream (teardown) work off it. With the atomic
// snapshot-and-commit fix, X's in-tx re-read sees the child re-armed and aborts the
// publish, deferring to the next tick.
//
// Staging: `delivered` is kept OWED (never published) at interleave time — the
// clean first-publish case where the F4 pin is undefined, so the optimistic gate
// unconditionally attempts a publish. We reach "child result green, delivered
// owed" by writing the child `result` green DIRECTLY via the store (as tests c/f
// stage sandbox moves), bypassing engine.green so triggerParentIfChild does not
// publish `delivered` for us.
//
// Interleave injection: X's optimistic STEP-6 pre-read calls
// store.getArtifact(parentWf, 'delivered'). That path is read exactly twice per
// maintainCalls pass before the write — once at STEP 2 (the F2 fingerprint guard)
// and once at STEP 6 (the optimistic gate). We monkey-patch store1.getArtifact and
// fire Y's mutations on the SECOND such read (the STEP-6 gate, after X has already
// captured the child outcome as green v1) — a point where X holds NO transaction,
// so Y's own BEGIN IMMEDIATE commits rather than blocking on busy_timeout.
//
// The re-arm branch's mirror (child goes green during X's re-arm pre-read window →
// parent must not be re-armed) is verified by inspection of rearmCallsGreen's in-tx
// isGreen re-check plus the existing test (f); staging it deterministically is
// awkward, so it is intentionally not reproduced here.
test('calls: REL-5 — atomic snapshot-and-commit defers a stale cross-connection publish', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-rel5-snapshot-'));
  const dbPath = join(dir, 'concurrent.db');
  try {
    const byName = new Map([childDef, parentDef].map((d) => [d.name, d]));
    const resolver = (name: string): WorkflowDef => {
      const d = byName.get(name);
      if (!d) throw new Error(`no def: ${name}`);
      return d;
    };
    const store1 = openStore(dbPath);
    const store2 = openStore(dbPath);
    const engine1 = new Engine(store1, resolver); // X — the connection under test
    const engine2 = new Engine(store2, resolver); // Y — the interleaving connection

    // Parent + gate green (sandbox v1) via X.
    const parentWf = engine1.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });
    const t1 = engine1.tick(parentWf, { deep: false });
    const provRun = t1.orders.find((o) => o.step === 'provision')!.run;
    engine1.green(parentWf, provRun, 'sandbox', { env: 'v1' });
    engine1.close(parentWf, provRun);

    // Spawn the child; `delivered` is now materialized but still owed.
    engine1.tick(parentWf, { deep: false });
    const childRow = store1.findChildByParent(parentWf, 'delivered');
    assert.ok(childRow, 'child spawned');
    assert.equal(getArt(store1, parentWf, 'delivered')?.acceptance, 'owed', 'delivered starts owed');

    // Stage the child result green v1 WITHOUT engine.green, so triggerParentIfChild
    // does not publish `delivered`. Fingerprint references the current `data`
    // version so Y's re-provide (which bumps `data`) auto-invalidates it.
    const dataArt = store1.getArtifact(childRow!.id, 'data')!;
    const resultOwed = store1.getArtifact(childRow!.id, 'result')!;
    store1.putArtifact({
      ...resultOwed,
      acceptance: 'green',
      version: resultOwed.version + 1,
      value: { value: 'v1' },
      fingerprint: { data: dataArt.version },
    });
    assert.equal(getArt(store1, childRow!.id, 'result')?.acceptance, 'green', 'child result staged green v1');
    assert.equal(getArt(store1, parentWf, 'delivered')?.acceptance, 'owed', 'delivered still owed pre-interleave');

    // Count `delivered`-provide commit events X emits during the interleaved tick.
    let e1DeliveredProvides = 0;
    const unsub = engine1.subscribe((e) => {
      if (e.type === 'commit' && e.path === 'delivered' && e.action === 'provide') e1DeliveredProvides++;
    });

    // Inject Y on X's SECOND getArtifact(parentWf,'delivered') — the STEP-6 gate.
    let deliveredReads = 0;
    let injected = false;
    const origGetArtifact = store1.getArtifact.bind(store1);
    (store1 as unknown as { getArtifact: Store['getArtifact'] }).getArtifact = ((wf: string, path: string) => {
      if (!injected && wf === parentWf && path === 'delivered') {
        deliveredReads++;
        if (deliveredReads === 2) {
          injected = true;
          // Y advances the gate to v2 and re-provides — re-arming the child result
          // to owed — while X holds no transaction.
          const sandbox = store2.getArtifact(parentWf, 'sandbox')!;
          store2.putArtifact({ ...sandbox, version: sandbox.version + 1, value: { env: 'v2' } });
          engine2.tick(parentWf, { deep: false });
        }
      }
      return origGetArtifact(wf, path);
    }) as Store['getArtifact'];

    // The interleaved pass. X's optimistic read saw the child green v1; its in-tx
    // re-verify must catch the re-armed child and abort the publish.
    const interleaved = engine1.tick(parentWf, { deep: false });
    (store1 as unknown as { getArtifact: Store['getArtifact'] }).getArtifact = origGetArtifact;
    unsub();

    assert.ok(injected, 'the interleave actually fired on the STEP-6 read');
    assert.notEqual(
      getArt(store1, childRow!.id, 'result')?.acceptance, 'green',
      'sanity: Y re-armed the child result to owed',
    );

    // (1) No stale publish: delivered must not be green with the v1 value under a v2
    //     fingerprint — with the fix it simply stays not-green (deferred).
    const deliveredAfter = getArt(store1, parentWf, 'delivered');
    assert.notEqual(deliveredAfter?.acceptance, 'green',
      'must not publish stale child value under a newer gate fingerprint');
    // Belt-and-braces invariant form: IF it were green, value+fingerprint must be
    // mutually consistent with the current child/gate — never stale-vs-newer.
    if (deliveredAfter?.acceptance === 'green') {
      const curResult = getArt(store1, childRow!.id, 'result');
      const curSandbox = getArt(store1, parentWf, 'sandbox');
      assert.deepEqual(deliveredAfter.value, curResult?.value, 'green delivered must carry the current child value');
      assert.equal(deliveredAfter.fingerprint?.sandbox, curSandbox?.version, 'and a fingerprint claiming the current gate');
    }

    // (2) No downstream work off the stale result.
    assert.equal(interleaved.orders.find((o) => o.step === 'teardown'), undefined,
      'no teardown order issued off the stale result');

    // (4) Event hygiene: X emitted no delivered-provide commit during the aborted pass.
    assert.equal(e1DeliveredProvides, 0, 'X fires no commit/provide for delivered on the aborted pass');

    // (3) Deferral, not deadlock: drive the child to green its result with v2 content;
    //     the parent then publishes the FRESH result and downstream fires.
    const childTick = engine1.tick(childRow!.id, { deep: false });
    const workerRun = childTick.orders.find((o) => o.step === 'worker')!.run;
    engine1.green(childRow!.id, workerRun, 'result', { value: 'v2' });
    engine1.close(childRow!.id, workerRun);
    const finalTick = engine1.tick(parentWf, { deep: false });

    const deliveredFinal = getArt(store1, parentWf, 'delivered');
    assert.equal(deliveredFinal?.acceptance, 'green', 'delivered publishes once the fresh result lands');
    assert.deepEqual(deliveredFinal?.value, { value: 'v2' }, 'with the v2 child value');
    const sandboxFinal = getArt(store1, parentWf, 'sandbox');
    assert.equal(deliveredFinal?.fingerprint?.sandbox, sandboxFinal?.version,
      'fingerprint claims the current (v2) gate version');
    assert.ok(finalTick.orders.find((o) => o.step === 'teardown'), 'teardown fires off the fresh result');

    store1.close();
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
