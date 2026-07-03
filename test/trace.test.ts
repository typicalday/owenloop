/**
 * Integration test for buildTrace: drives real history through the Engine
 * so the trace is validated against data the engine actually writes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine.ts';
import { buildTrace } from '../src/model.ts';
import { def, input, step } from './helpers.ts';

// The software-delivery wiring (§9), matching model.test.ts exactly.
const delivery = def(
  'delivery',
  [input('proposal')],
  [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
    step({ name: 'reviewer', consumes: ['pr'], produces: ['verdict'] }),
    step({ name: 'merger', consumes: ['verdict'], produces: ['merge'] }),
  ],
);

test('buildTrace: timeline order, consumedInputs, producedStems, and biography events', () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, () => delivery);

  const wf = engine.createInstance('delivery', {
    provide: { proposal: { text: 'test proposal' } },
  });

  // 1. Planner fires successfully
  const tick1 = engine.tick(wf);
  assert.equal(tick1.orders.length, 1);
  const plannerOrder = tick1.orders[0]!;
  assert.equal(plannerOrder.step, 'planner');
  engine.green(wf, plannerOrder.run, 'plan', { plan: 'v1' });
  engine.close(wf, plannerOrder.run, 'ok');

  // 2. Builder fires, produces pr
  const tick2 = engine.tick(wf);
  const builderOrder1 = tick2.orders.find((o) => o.step === 'builder')!;
  assert.ok(builderOrder1, 'builder has an order');
  engine.green(wf, builderOrder1.run, 'pr', { pr: '#1' });
  engine.close(wf, builderOrder1.run, 'ok');

  // Reject the pr artifact (simulating reviewer verdict)
  engine.reject(wf, 'pr', 'reviewer', 'needs changes');

  // Builder fires again (retry)
  const tick3 = engine.tick(wf);
  const builderOrder2 = tick3.orders.find((o) => o.step === 'builder')!;
  assert.ok(builderOrder2, 'builder has a second order after reject');
  engine.green(wf, builderOrder2.run, 'pr', { pr: '#2' });
  engine.close(wf, builderOrder2.run, 'ok');

  // 3. Build the trace
  const artifacts = store.listArtifacts(wf);
  const runs = store.listRuns(wf);
  const trace = buildTrace(delivery, artifacts, runs);

  // --- timeline assertions ---
  assert.ok(trace.timeline.length >= 3, 'at least 3 firings: planner, builder x2');
  // Seq numbers are 1-based and monotone
  for (let i = 0; i < trace.timeline.length; i++) {
    assert.equal(trace.timeline[i]!.seq, i + 1);
  }
  // Ordered by createdAt
  for (let i = 1; i < trace.timeline.length; i++) {
    assert.ok(trace.timeline[i]!.at >= trace.timeline[i - 1]!.at, 'timeline is chronological');
  }
  // The planner event has consumedInputs with proposal version
  const plannerEv = trace.timeline.find((e) => e.step === 'planner')!;
  assert.ok(plannerEv, 'planner event exists');
  assert.ok(plannerEv.consumedInputs !== undefined, 'planner has a fingerprint');
  assert.ok('proposal' in (plannerEv.consumedInputs!), 'planner consumed proposal');
  // The planner's producedStems comes from the def
  assert.deepEqual(plannerEv.producedStems, ['plan'], 'planner produces plan');

  // Builder's producedStems
  const builderEvs = trace.timeline.filter((e) => e.step === 'builder');
  assert.ok(builderEvs.length >= 2, 'two builder firings');
  for (const ev of builderEvs) {
    assert.deepEqual(ev.producedStems, ['pr'], 'builder produces pr');
  }

  // --- artifact biography assertions ---
  const prBio = trace.artifacts.find((a) => a.path === 'pr')!;
  assert.ok(prBio, 'pr biography exists');
  // pr was rejected once then retried — should have at least a 'reject' event
  const rejectEvents = prBio.events.filter((e) => e.action === 'reject');
  assert.ok(rejectEvents.length >= 1, 'pr has at least one reject event');
  assert.ok(prBio.events.length >= 1, 'pr biography has events');

  // --- summary assertions ---
  assert.ok(trace.summary.totalRuns >= 3);
  assert.ok(trace.summary.totalRejects >= 1, 'at least one reject counted');
  assert.equal(typeof trace.summary.done, 'boolean');

  // --- inferenceNote is present and non-empty ---
  assert.ok(typeof trace.inferenceNote === 'string' && trace.inferenceNote.length > 0);

  store.close();
});

test('buildTrace: empty history — no runs, no artifacts returns valid empty trace', () => {
  const store = new Store(':memory:');
  const engine = new Engine(store, () => delivery);

  // Create a workflow that provides the input so artifacts are seeded but never tick
  const wf = engine.createInstance('delivery', {
    provide: { proposal: { text: 'test' } },
  });

  const artifacts = store.listArtifacts(wf);
  const runs = store.listRuns(wf);
  const trace = buildTrace(delivery, artifacts, runs);

  assert.deepEqual(trace.timeline, [], 'no runs means empty timeline');
  assert.ok(Array.isArray(trace.artifacts), 'artifacts still present');
  assert.equal(trace.summary.totalRuns, 0);
  assert.equal(trace.summary.totalRejects, 0);
  assert.equal(trace.summary.totalRetries, 0);
  assert.deepEqual(trace.summary.stalledArtifacts, []);
  assert.equal(typeof trace.summary.done, 'boolean');
  assert.ok(trace.inferenceNote.length > 0);

  store.close();
});
