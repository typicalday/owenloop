/** Regression coverage for collection-cap soundness of reported true deadlocks. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadDefFile, validateDef } from '../src/defs.ts';
import { applyOutcome, eligibleFirings, modelCheck, workflowDone } from '../src/model.ts';
import { arts, def, input, step } from './helpers.ts';

function fixture(name: string) {
  return loadDefFile(fileURLToPath(new URL(`./fixtures/${name}.yaml`, import.meta.url)));
}

const wedge = fixture('wedge');
const wedgeColl2 = fixture('wedge-coll2');
const maxStates = 2_000_000;

const futureIdleFixture = def(
  'future-idle-completion',
  [input('start', { seedOwed: false })],
  [
    step({ name: 'fanout', consumes: ['start'], produces: ['items[]'] }),
    step({ name: 'map', consumes: ['items[$i]'], produces: ['mapped[$i]'] }),
    step({ name: 'monitor', produces: ['wake'], on: ['idle'], idleAfterMs: 60_000 }),
    step({ name: 'finish', consumes: ['wake'], produces: ['result'], terminal: true }),
  ],
);

test('modelCheck: natural collection cap reports the promoted deadlock witnesses', () => {
  const control = modelCheck(wedge, { maxStates, assumeProvided: true });
  const collection = modelCheck(wedgeColl2, { maxStates, assumeProvided: true });

  assert.equal(control.deadlocks.length, 1);
  assert.equal(collection.deadlocks.length, 3);
  for (const report of [control, collection]) {
    assert.deepEqual(report.boundsHit, []);
    assert.equal(report.bounded, false);
    assert.equal(report.completable, false);
  }
});

test('modelCheck: non-collection deadlock control is cap-invariant', () => {
  const reports = [0, 1, 2, 3, 4].map((maxCollectionSize) =>
    modelCheck(wedge, { maxCollectionSize, maxStates, assumeProvided: true }),
  );
  const baseline = reports[0]!.deadlocks;

  for (const [index, report] of reports.entries()) {
    assert.deepEqual(report.boundsHit, [], `cap ${index} is admissible`);
    assert.equal(report.bounded, false, `cap ${index} is not bounded`);
    assert.equal(report.collectionCapApplied, false, `cap ${index} never expands a collection`);
    assert.equal(report.deadlocks.length, 1, `cap ${index} keeps the one deadlock`);
    assert.deepEqual(report.deadlocks, baseline, `cap ${index} preserves the complete deadlock output`);
  }
});

test('modelCheck: collection deadlock witness grows monotonically across admissible caps', () => {
  const reports = [0, 1, 2, 3, 4].map((maxCollectionSize) =>
    modelCheck(wedgeColl2, { maxCollectionSize, maxStates, assumeProvided: true }),
  );

  for (const [index, report] of reports.entries()) {
    assert.deepEqual(report.boundsHit, [], `cap ${index} is admissible`);
    assert.equal(report.bounded, false, `cap ${index} is not bounded`);
    assert.equal(report.collectionCapApplied, true, `cap ${index} expands a collection`);
    assert.equal(report.maxCollectionSize, index, `cap ${index} is preserved in the report`);
  }
  const counts = reports.map((report) => report.deadlocks.length);
  assert.deepEqual(counts, [1, 2, 3, 4, 5]);
  for (let index = 1; index < counts.length; index++) {
    assert.ok(counts[index]! >= counts[index - 1]!, `deadlocks do not shrink from cap ${index - 1} to ${index}`);
  }
});

test('modelCheck: a future idle evaluator prevents a bounded false deadlock', () => {
  assert.deepEqual(validateDef(futureIdleFixture), [], 'the timed completion path is a valid definition');

  const zeroMemberSuccessor = new Map(arts([
    { path: 'start', producer: 'human', acceptance: 'green', version: 1 },
    {
      path: 'items.sealed',
      producer: 'fanout',
      acceptance: 'green',
      version: 1,
      fingerprint: { start: 1 },
    },
    { path: 'wake', producer: 'monitor', acceptance: 'owed', version: 0 },
    { path: 'result', producer: 'finish', acceptance: 'owed', version: 0 },
  ]));
  const afterThreshold = {
    now: 60_000,
    lastProgressMs: 0,
    inFlight: false,
    alarms: new Map<string, number>(),
  };
  const monitor = eligibleFirings(futureIdleFixture, zeroMemberSuccessor, afterThreshold)
    .find((firing) => firing.step === 'monitor');
  assert.ok(monitor, 'the future idle threshold offers monitor from the zero-member successor');
  const afterMonitor = applyOutcome(futureIdleFixture, zeroMemberSuccessor, monitor, 'green', {
    maxCollectionSize: 1,
  })[0]!;
  const finish = eligibleFirings(futureIdleFixture, afterMonitor)
    .find((firing) => firing.step === 'finish');
  assert.ok(finish, 'monitor/green enables finish');
  const done = applyOutcome(futureIdleFixture, afterMonitor, finish, 'green', {
    maxCollectionSize: 1,
  })[0]!;
  assert.equal(workflowDone(futureIdleFixture, done), true, 'monitor/green then finish/green reaches done');

  const bounded = modelCheck(futureIdleFixture, {
    maxCollectionSize: 1,
    maxDepth: 1,
    assumeProvided: true,
  });
  assert.equal(bounded.bounded, true);
  assert.deepEqual(bounded.boundsHit, ['maxDepth']);
  assert.deepEqual(
    bounded.deadlocks,
    [],
    'the zero-member successor can wait for monitor/idle, then finish/green at runtime',
  );
});
