/** Regression coverage for owenloop#236 collection model-check behavior. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDef } from '../src/defs.ts';
import { modelCheck } from '../src/model.ts';
import { def, input, step } from './helpers.ts';

const reduceOnlyFixture = def(
  'owenloop-236-reduce-only',
  [input('question', { seedOwed: false })],
  [
    step({ name: 'gather', consumes: ['question'], produces: ['gather.source[]'], maxAttempts: 2 }),
    step({
      name: 'synth',
      consumes: ['gather.source[*]'],
      produces: ['draft'],
      terminal: true,
      maxAttempts: 2,
    }),
  ],
);

function memberReduceFixture(maxAttempts: number, maxSchemaFailures: number) {
  return def(
    `owenloop-236-member-reduce-${maxAttempts}-${maxSchemaFailures}`,
    [input('question', { seedOwed: false })],
    [
      step({
	name: 'gather',
	consumes: ['question'],
	produces: ['gather.source[]'],
	maxAttempts,
	maxSchemaFailures,
      }),
      step({
	name: 'check',
	consumes: ['gather.source[$i]'],
	produces: ['gather.source[$i].verdict'],
	maxAttempts,
	maxSchemaFailures,
      }),
      step({
	name: 'synth',
	consumes: ['gather.source[*].verdict'],
	produces: ['draft'],
	terminal: true,
	maxAttempts,
	maxSchemaFailures,
      }),
    ],
  );
}

test('owenloop#236: a produce-only collection is clean', () => {
  const fixture = def(
    'owenloop-236-produce-only',
    [input('question', { seedOwed: false })],
    [
      step({
	name: 'gather',
	consumes: ['question'],
	produces: ['gather.source[]'],
	terminal: true,
      }),
    ],
  );
  const report = modelCheck(fixture, { maxStates: 5_000, maxCollectionSize: 2, assumeProvided: true });

  assert.equal(report.bounded, false);
  assert.deepEqual(report.boundsHit, []);
  assert.deepEqual(report.deadlocks, []);
  assert.deepEqual(report.stuck, []);
  assert.deepEqual(report.structurallyDeadSteps, []);
  assert.deepEqual(report.unreachedSteps, []);
  assert.deepEqual(report.invariantViolations, []);
});

test('owenloop#229: a bare reduce exhausts without recoverable collection states reported as stuck', () => {
  const report = modelCheck(reduceOnlyFixture, { maxStates: 5_000, maxCollectionSize: 2, assumeProvided: true });

  assert.equal(report.bounded, false);
  assert.deepEqual(report.boundsHit, []);
  assert.deepEqual(report.stuck, []);
});

test('owenloop#236: map with a member reduce hits maxStates', () => {
  const fixture = def(
    'owenloop-236-member-reduce',
    [input('question', { seedOwed: false })],
    [
      step({ name: 'gather', consumes: ['question'], produces: ['gather.source[]'], maxAttempts: 2 }),
      step({
	name: 'check',
	consumes: ['gather.source[$i]'],
	produces: ['gather.source[$i].verdict'],
	maxAttempts: 2,
      }),
      step({
	name: 'synth',
	consumes: ['gather.source[*]'],
	produces: ['draft'],
	terminal: true,
	maxAttempts: 2,
      }),
    ],
  );
  const report = modelCheck(fixture, { maxStates: 5_000, maxCollectionSize: 2, assumeProvided: true });

  assert.equal(report.completable, true);
  assert.equal(report.bounded, true);
  assert.ok(report.boundsHit.includes('maxStates'));
});

test('owenloop#229: minimal-budget map then suffix reduce is exhaustively clean', () => {
  const report = modelCheck(memberReduceFixture(1, 0), {
    maxStates: 10_000,
    maxCollectionSize: 2,
    assumeProvided: true,
  });

  assert.equal(report.completable, true);
  assert.equal(report.bounded, false);
  assert.deepEqual(report.boundsHit, []);
  assert.deepEqual(report.deadlocks, []);
  assert.deepEqual(report.stuck, []);
  assert.deepEqual(report.structurallyDeadSteps, []);
  assert.deepEqual(report.unreachedSteps, []);
  assert.deepEqual(report.invariantViolations, []);
});

test('owenloop#236: reject-budget profiles control collection tractability', () => {
  const options = { maxStates: 5_000, maxCollectionSize: 3, assumeProvided: true };
  const oneZero = modelCheck(memberReduceFixture(1, 0), options);
  const twoZero = modelCheck(memberReduceFixture(2, 0), options);
  const oneFive = modelCheck(memberReduceFixture(1, 5), options);
  const twoFive = modelCheck(memberReduceFixture(2, 5), options);

  assert.equal(oneZero.bounded, false);
  assert.deepEqual(oneZero.boundsHit, []);

  // The middle profiles are measured current behavior, not a designed API contract.
  // 1/0 versus 2/5 changes a pair of parameters; these profiles separate their contributions.
  assert.equal(twoZero.bounded, true);
  assert.ok(twoZero.boundsHit.includes('maxStates'));
  assert.equal(oneFive.bounded, true);
  assert.ok(oneFive.boundsHit.includes('maxStates'));

  assert.equal(twoFive.bounded, true);
  assert.ok(twoFive.boundsHit.includes('maxStates'));
});

test('owenloop#229: archive-gate conditions are clean after collection recovery classification', () => {
  const report = modelCheck(reduceOnlyFixture, { maxStates: 5_000, maxCollectionSize: 2, assumeProvided: true });

  assert.equal(report.completable, true);
  assert.equal(report.bounded, false);
  assert.deepEqual(report.boundsHit, []);
  assert.deepEqual(report.deadlocks, []);
  assert.deepEqual(report.stuck, []);
  assert.deepEqual(report.structurallyDeadSteps, []);
  assert.deepEqual(report.unreachedSteps, []);
  assert.deepEqual(report.invariantViolations, []);
});

test('owenloop#229: a loader-faithful mixed singleton and generated collection reaches its second step', () => {
  const fixture = buildDef({
    name: 'owenloop-229-mixed-producer',
    outputs: ['report', 'q'],
    inputs: [{ name: 'request', seedOwed: false }],
    steps: [
      {
	name: 'p-first',
	consumes: ['request'],
	produces: ['note'],
	generates: ['q[]'],
	body: 'write both independent outputs',
      },
      {
	name: 'p-second',
	consumes: ['note'],
	produces: ['report'],
	terminal: true,
	body: 'use the singleton output',
      },
    ],
  });
  const report = modelCheck(fixture, { maxStates: 5_000, maxCollectionSize: 2, assumeProvided: true });

  assert.equal(report.completable, true);
  assert.deepEqual(report.deadlocks, []);
  assert.deepEqual(report.stuck, []);
  assert.deepEqual(report.structurallyDeadSteps, []);
  assert.deepEqual(report.unreachedSteps, []);
  assert.deepEqual(report.invariantViolations, []);
});

test('owenloop#229: scalar parallel branches remain a genuine stuck control', () => {
  const fixture = def(
    'owenloop-229-scalar-stuck-control',
    [input('request', { seedOwed: false })],
    [
      step({ name: 'logger', consumes: ['request'], produces: ['note'] }),
      step({ name: 'worker', consumes: ['request'], produces: ['report'], terminal: true }),
    ],
  );
  const report = modelCheck(fixture, { maxStates: 5_000, assumeProvided: true });

  assert.equal(report.completable, true);
  assert.ok(report.stuck.length > 0);
});
