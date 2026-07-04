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

test('calls: (a) happy path end-to-end — spawn, cascade-up, teardown', () => {
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

  // Tick 2 → maintainCalls runs → child spawned (no worker order for deliver)
  const tick2 = engine.tick(parentWf);
  assert.ok(tick2.orders.every((o) => o.step !== 'deliver'), 'deliver must not produce worker orders');

  // Child should exist now
  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined, 'child should be spawned after sandbox is green');

  // Child's data input should be green with sandbox value
  const childDataArt = getArt(store, childRow!.id, 'data');
  assert.equal(childDataArt?.acceptance, 'green');
  assert.deepEqual(childDataArt?.value, { env: 'test-env' });

  // Drive the child: tick → worker order → green result → close
  const childTick1 = engine.tick(childRow!.id);
  assert.equal(childTick1.orders.length, 1);
  assert.equal(childTick1.orders[0]!.step, 'worker');
  const workerRun = childTick1.orders[0]!.run;
  engine.green(childRow!.id, workerRun, 'result', { value: 'done' });
  engine.close(childRow!.id, workerRun);

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
  const tick1 = engine.tick(parentWf);
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);

  // Call tick twice (maintainCalls runs each time)
  engine.tick(parentWf);
  engine.tick(parentWf);

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
  engine.tick(parentWf);
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
  const tick1 = engine.tick(parentWf);
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);

  // Tick → child spawned with data={env:'v1'}
  engine.tick(parentWf);
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
  engine.tick(parentWf);

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
  engine.tick(parentWf);
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
  const tick3 = engine.tick(parentWf);
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
  const tick1 = engine.tick(parentWf);
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'test' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf);

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);

  // Drive child to green result with {value:'v1'}
  const childTick1 = engine.tick(childRow!.id);
  const run1 = childTick1.orders[0]!.run;
  engine.green(childRow!.id, run1, 'result', { value: 'v1' });
  engine.close(childRow!.id, run1);

  // Tick parent → delivered greens with {value:'v1'}
  engine.tick(parentWf);
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
  engine.tick(parentWf);
  const deliveredArt = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredArt?.acceptance, 'green');
  assert.deepEqual(deliveredArt?.value, { value: 'v2' });
});

// ---- test (f): gate re-arm ---------------------------------------------------

test('calls: (f) gate re-arm — cascade re-arms delivered, maintainCalls re-provides and re-greens', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });

  // Green sandbox v1, tick → child spawned
  const tick1 = engine.tick(parentWf);
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf);

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);

  // Drive child to green result, cascade-up greens parent 'delivered'
  const childTick1 = engine.tick(childRow!.id);
  const workerRun = childTick1.orders[0]!.run;
  engine.green(childRow!.id, workerRun, 'result', { value: 'done-v1' });
  engine.close(childRow!.id, workerRun);
  engine.tick(parentWf);

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
  engine.tick(parentWf);
  const deliveredAfterMove = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredAfterMove?.acceptance, 'owed', 'delivered should be re-armed to owed after sandbox moved');

  // Tick parent again → maintainCalls runs → detects data mismatch → re-provides to child
  engine.tick(parentWf);
  assert.deepEqual(getArt(store, childRow!.id, 'data')?.value, { env: 'v2' });

  // Drive child to re-green its result
  engine.retry(childRow!.id, 'result');
  const childTick2 = engine.tick(childRow!.id);
  assert.ok(childTick2.orders.length > 0);
  const run2 = childTick2.orders[0]!.run;
  engine.green(childRow!.id, run2, 'result', { value: 'done-v2' });
  engine.close(childRow!.id, run2);

  // Tick parent → maintainCalls re-greens 'delivered'
  engine.tick(parentWf);
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
  engine.tick(parentWf);
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

  const tick1 = engine.tick(parentWf);
  const provRun = tick1.orders[0]!.run;
  // sandbox is schema-less at the parent, so a number for `env` greens fine here...
  engine.green(parentWf, provRun, 'sandbox', { env: 42 });
  engine.close(parentWf, provRun);

  // ...but the child's `data` input requires env: string — tick must NOT throw.
  assert.doesNotThrow(() => engine.tick(parentWf));

  const delivered = getArt(store, parentWf, 'delivered');
  assert.equal(delivered?.acceptance, 'rejected');
  assert.equal(delivered?.schemaRejects, 1);
  const lastReason = delivered!.reasons[delivered!.reasons.length - 1]!;
  assert.equal(lastReason.kind, 'validation');
  assert.match(lastReason.text, /data/);

  // No child should have been spawned — the schema refusal happened inside createInstance.
  assert.equal(store.findChildByParent(parentWf, 'delivered'), undefined);

  // Subsequent ticks with the gate unmoved must not re-throw or double-bump schemaRejects.
  engine.tick(parentWf);
  engine.tick(parentWf);
  const deliveredAfter = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredAfter?.schemaRejects, 1, 'schemaRejects must not double-bump while gate is unmoved');
  assert.equal(store.findChildByParent(parentWf, 'delivered'), undefined, 'no spawn attempt while rejected+unmoved gate');

  // Fix the parent value (re-green gate) — retry then clears the path: spawn succeeds.
  const sandboxArt = getArt(store, parentWf, 'sandbox');
  store.putArtifact({ ...sandboxArt!, version: sandboxArt!.version + 1, value: { env: 'ok-now' } });
  engine.retry(parentWf, 'delivered');
  engine.tick(parentWf);

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined, 'spawn should succeed once the gate value is fixed');
  assert.deepEqual(getArt(store, childRow!.id, 'data')?.value, { env: 'ok-now' });
});

test('calls: F2 — re-provide-time child schema refusal is a debt, human provide of PARENT input still commits', () => {
  const { engine, store } = makeEngine([strictChildDef, strictParentDef]);

  const parentWf = engine.createInstance('strictParentDef', { provide: { proposal: { text: 'hello' } } });

  // Healthy spawn: sandbox greens with a legal value.
  const tick1 = engine.tick(parentWf);
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf);

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined, 'child should spawn on a legal value');
  assert.deepEqual(getArt(store, childRow!.id, 'data')?.value, { env: 'v1' });

  // Parent value moves to a child-illegal value (schema-less at the parent, so this
  // update itself is not refused at the parent level) — simulate a re-provision.
  const sandboxArt = getArt(store, parentWf, 'sandbox');
  store.putArtifact({ ...sandboxArt!, version: sandboxArt!.version + 1, value: { env: 7 } });

  // tick's maintainCalls cascade-up must not throw out of provideInput.
  assert.doesNotThrow(() => engine.tick(parentWf));

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
  const tick1 = engine.tick(parentWf);
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf);

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);
  const childTick1 = engine.tick(childRow!.id);
  const workerRun = childTick1.orders[0]!.run;
  engine.green(childRow!.id, workerRun, 'result', { value: 'v1' });
  engine.close(childRow!.id, workerRun);
  engine.tick(parentWf);

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
  engine.tick(parentWf);
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
  engine.tick(parentWf);
  const deliveredV2 = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredV2?.acceptance, 'green');
  assert.deepEqual(deliveredV2?.value, { value: 'v2' });
});

// ---- F4: ordering A/B — skip pin vs. child re-run ----------------------------

test('calls: F4 ordering A — human skip on green calls artifact survives arbitrary ticks (child unchanged)', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });
  const tick1 = engine.tick(parentWf);
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf);

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);
  const childTick1 = engine.tick(childRow!.id);
  const workerRun = childTick1.orders[0]!.run;
  engine.green(childRow!.id, workerRun, 'result', { value: 'v3' });
  engine.close(childRow!.id, workerRun);
  engine.tick(parentWf);

  assert.equal(getArt(store, parentWf, 'delivered')?.acceptance, 'green');

  // Human skips the green calls artifact after seeing child result v3; child stays at v3.
  engine.skip(parentWf, 'delivered', 'human', 'skipping this branch');
  assert.equal(getArt(store, parentWf, 'delivered')?.acceptance, 'skipped');

  // The machine never overrides a decision made on current evidence — arbitrary ticks
  // must not re-green 'delivered' back from 'skipped' while the child is unchanged.
  for (let i = 0; i < 5; i++) engine.tick(parentWf);
  assert.equal(getArt(store, parentWf, 'delivered')?.acceptance, 'skipped', 'skip must survive arbitrary ticks');
});

test('calls: F4 ordering B — skip pinned to stale child version; gate moves, child re-runs, parent re-arms and mirrors', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });
  const tick1 = engine.tick(parentWf);
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf);

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);
  const childTick1 = engine.tick(childRow!.id);
  const workerRun = childTick1.orders[0]!.run;
  engine.green(childRow!.id, workerRun, 'result', { value: 'v3' });
  engine.close(childRow!.id, workerRun);
  engine.tick(parentWf);

  // Skip pinned to the v3 child outcome version.
  engine.skip(parentWf, 'delivered', 'human', 'skipping for now');
  assert.equal(getArt(store, parentWf, 'delivered')?.acceptance, 'skipped');

  // Gate moves: sandbox re-provisioned to v2.
  const sandboxArt = getArt(store, parentWf, 'sandbox');
  store.putArtifact({ ...sandboxArt!, version: sandboxArt!.version + 1, value: { env: 'v2' } });
  engine.tick(parentWf); // re-provides child's data input

  assert.deepEqual(getArt(store, childRow!.id, 'data')?.value, { env: 'v2' });

  // Child re-runs and lands a new outcome version.
  engine.retry(childRow!.id, 'result');
  const childTick2 = engine.tick(childRow!.id);
  assert.ok(childTick2.orders.length > 0);
  const run2 = childTick2.orders[0]!.run;
  engine.green(childRow!.id, run2, 'result', { value: 'v4' });
  engine.close(childRow!.id, run2);

  // A months-old skip cannot permanently gag a fresh child result: parent re-arms and mirrors.
  engine.tick(parentWf);
  const deliveredAfter = getArt(store, parentWf, 'delivered');
  assert.equal(deliveredAfter?.acceptance, 'green', 'stale pin must not block a fresh child result from mirroring');
  assert.deepEqual(deliveredAfter?.value, { value: 'v4' });
});

// ---- F4 sweeping note: propagated reject surfaces in the CHILD's status.debts ----

test('calls: F4 — a propagated reject surfaces in the CHILD workflow\'s status.debts (visible to sweeps)', () => {
  const { engine, store } = makeEngine([childDef, parentDef]);

  const parentWf = engine.createInstance('parentDef', { provide: { proposal: { text: 'hello' } } });
  const tick1 = engine.tick(parentWf);
  const provRun = tick1.orders[0]!.run;
  engine.green(parentWf, provRun, 'sandbox', { env: 'v1' });
  engine.close(parentWf, provRun);
  engine.tick(parentWf);

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined);
  const childTick1 = engine.tick(childRow!.id);
  const workerRun = childTick1.orders[0]!.run;
  engine.green(childRow!.id, workerRun, 'result', { value: 'v1' });
  engine.close(childRow!.id, workerRun);
  engine.tick(parentWf);

  engine.reject(parentWf, 'delivered', 'teardown', 'needs rework');

  // The rejected child outcome must be visible via the CHILD's own status,
  // without any extra prompting — a driver that only sweeps children by
  // status (not by following producedBy links) still sees the debt.
  const childStatus = engine.status(childRow!.id);
  const resultDebt = childStatus.debts.find((d) => d.path === 'result');
  assert.ok(resultDebt !== undefined, 'the rejected child outcome must appear in the child\'s status.debts');
  assert.equal(resultDebt!.acceptance, 'rejected');
});
