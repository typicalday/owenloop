/** Regression coverage for idle waits in exhaustive model-check classification. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasDefiniteCheckDefect } from '../src/cli.ts';
import { modelCheck } from '../src/model.ts';
import { def, input, step } from './helpers.ts';

const futureIdleCompletion = def(
  'future-idle-completion',
  [input('start', { seedOwed: false })],
  [
    step({ name: 'fanout', consumes: ['start'], produces: ['items[]'] }),
    step({ name: 'map', consumes: ['items[$i]'], produces: ['mapped[$i]'] }),
    step({ name: 'monitor', produces: ['wake'], on: ['idle'], idleAfterMs: 60_000 }),
    step({ name: 'finish', consumes: ['wake'], produces: ['result'], terminal: true }),
  ],
);

for (const maxCollectionSize of [1, 2]) {
  test(`modelCheck: future idle wait is not a deadlock at collection cap ${maxCollectionSize}`, () => {
    const report = modelCheck(futureIdleCompletion, { maxCollectionSize, maxStates: 10_000, assumeProvided: true });

    assert.deepEqual(report.boundsHit, []);
    assert.equal(report.bounded, false);
    assert.equal(report.deadlocks.length, 0);
    assert.ok(report.stallStates.length > 0);
    assert.equal(hasDefiniteCheckDefect(report), false);
    // Eventual time classifies the wait but does not add time to BFS expansion.
    assert.equal(report.completable, false);
    assert.deepEqual(report.unreachedSteps, ['monitor', 'finish']);
  });
}
