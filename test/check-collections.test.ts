/** Regression coverage for owenloop#236 collection model-check behavior. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDef } from '../src/defs.ts';
import { eligibleOutcomes, modelCheck } from '../src/model.ts';
import { arts, def, input, step } from './helpers.ts';

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

test('owenloop#236: map with a member reduce can exhaust the finite width-two model', () => {
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
  assert.equal(report.bounded, false);
  assert.deepEqual(report.boundsHit, []);
  assert.deepEqual(report.coverageIncomplete, ['collection-width-cap'],
    'finite-model exhaustion does not certify wider runtime collections');
});

test('owenloop#229: minimal-budget map/reduce has only recoverable finite-model stalls', () => {
  const report = modelCheck(memberReduceFixture(1, 0), {
    maxStates: 10_000,
    maxCollectionSize: 2,
    assumeProvided: true,
  });

  assert.equal(report.completable, true);
  assert.equal(report.bounded, false);
  assert.deepEqual(report.boundsHit, []);
  assert.deepEqual(report.deadlocks, []);
  assert.ok(report.stuck.length > 0, 'new pre-seal and same-run paths expose real stalled branches');
  assert.ok(report.stuck.every((finding) =>
    finding.path.some((move) => move.outcome === 'collection-close')),
  'a schema-free stalled branch appears only after its producer closes the open run');
  assert.deepEqual(report.coverageIncomplete, ['collection-width-cap']);
  assert.deepEqual(report.structurallyDeadSteps, []);
  assert.deepEqual(report.unreachedSteps, []);
  assert.deepEqual(report.invariantViolations, []);
});

test('owenloop#236: schema-free retry profiles avoid impossible schema-reject branches', () => {
  const options = { maxStates: 5_000, maxCollectionSize: 3, assumeProvided: true };
  const oneZero = modelCheck(memberReduceFixture(1, 0), options);
  const twoZero = modelCheck(memberReduceFixture(2, 0), options);
  const oneFive = modelCheck(memberReduceFixture(1, 5), options);
  const twoFive = modelCheck(memberReduceFixture(2, 5), options);

  assert.ok(oneZero.coverageIncomplete.includes('collection-width-cap'));

  // No produce declares a schema or bind, so changing maxSchemaFailures alone
  // must not add transitions. Only the judgment-reject attempt budget matters.
  assert.equal(oneFive.bounded, oneZero.bounded);
  assert.equal(oneFive.stats.statesExplored, oneZero.stats.statesExplored);
  assert.equal(twoFive.bounded, twoZero.bounded);
  assert.equal(twoFive.stats.statesExplored, twoZero.stats.statesExplored);
  assert.equal(twoZero.bounded, true);
  assert.ok(twoZero.boundsHit.includes('maxStates'));
  assert.equal(twoFive.bounded, true);
  assert.ok(twoFive.boundsHit.includes('maxStates'));
  assert.ok(oneZero.stuck.every((finding) =>
    !finding.path.some((move) => move.outcome === 'collection-schema-reject')),
  'schema-free producers cannot take a collection schema-refusal transition');
});

test('owenloop#236: no schema or bind cannot schema-reject, while either guard can', () => {
  const fixture = () => def('owenloop-236-schema-gate', [input('start', { seedOwed: false })], [
    step({ name: 'worker', consumes: ['start'], produces: ['result'], terminal: true, maxSchemaFailures: 1 }),
  ]);
  const options = { maxStates: 100, assumeProvided: true };

  const plain = modelCheck(fixture(), options);
  assert.equal(plain.bounded, false);
  assert.equal(plain.stats.statesExplored, 3);
  assert.deepEqual(plain.stallStates, []);

  const withSchema = fixture();
  withSchema.steps[0]!.produces[0]!.schema = { type: 'string' };
  const schemaReport = modelCheck(withSchema, options);
  assert.ok(schemaReport.stallStates.some((finding) =>
    finding.path.some((move) => move.outcome === 'schema-reject')));

  const withBind = fixture();
  withBind.steps[0]!.produces[0]!.bind = { to: 'modifier', from: 'choice' };
  withBind.modifiers = ['fast'];
  const bindReport = modelCheck(withBind, options);
  assert.ok(bindReport.stallStates.some((finding) =>
    finding.path.some((move) => move.outcome === 'schema-reject')));
});

test('owenloop#236: schema rejection follows the exact singleton or map produce', () => {
  const fixture = def('owenloop-236-output-ownership', [input('start', { seedOwed: false })], [
    step({ name: 'mixed', consumes: ['start'], produces: ['free', 'guarded'] }),
    step({ name: 'map', consumes: ['source[$i]'], produces: ['source[$i].verdict'] }),
  ]);
  const mixed = fixture.steps[0]!;
  const map = fixture.steps[1]!;
  const state = new Map(arts([]));
  const outcomes = (stepName: string, output: string) => eligibleOutcomes(
    fixture, state, { step: stepName, key: '', inputs: [], outputs: [output] },
  );

  assert.ok(!outcomes('mixed', 'free').includes('schema-reject'));
  assert.ok(!outcomes('mixed', 'guarded').includes('schema-reject'));
  assert.ok(!outcomes('map', 'source[0].verdict').includes('schema-reject'));

  mixed.produces.find((p) => p.stem === 'guarded')!.schema = { type: 'string' };
  map.produces[0]!.schema = { type: 'string' };
  assert.ok(outcomes('mixed', 'guarded').includes('schema-reject'));
  assert.ok(outcomes('map', 'source[0].verdict').includes('schema-reject'));
  assert.ok(!outcomes('mixed', 'free').includes('schema-reject'), 'another output schema must not contaminate a free output');

  mixed.produces.find((p) => p.stem === 'guarded')!.schema = undefined;
  map.produces[0]!.schema = undefined;
  mixed.produces.find((p) => p.stem === 'guarded')!.bind = { to: 'meta.route', from: 'route' };
  map.produces[0]!.bind = { to: 'meta.verdict', from: 'verdict' };
  assert.ok(outcomes('mixed', 'guarded').includes('schema-reject'));
  assert.ok(outcomes('map', 'source[0].verdict').includes('schema-reject'));
  assert.ok(!outcomes('mixed', 'free').includes('schema-reject'), 'another output bind must not contaminate a free output');
});

test('owenloop#236: a plain losing group sibling cannot schema-reject before group refusal', () => {
  const fixture = def('owenloop-236-group-order', [input('ticket', { seedOwed: false })], [
    step({ name: 'triage', consumes: ['ticket'], produces: ['simple', 'urgent'],
      groups: [{ group: 'route', mode: 'exactlyOne', of: ['simple', 'urgent'] }] }),
  ]);
  const urgent = fixture.steps[0]!.produces.find((p) => p.stem === 'urgent')!;
  urgent.schema = { type: 'string' };
  urgent.bind = { to: 'meta.route', from: 'route' };
  const state = new Map(arts([
    { path: 'ticket', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'simple', producer: 'triage' },
    { path: 'urgent', producer: 'triage' },
  ]));
  const firing = { step: 'triage', key: '', inputs: ['ticket'], outputs: ['urgent'] };
  assert.ok(eligibleOutcomes(fixture, state, firing).includes('schema-reject'), 'before a winner, validation may fail');
  const simple = state.get('simple')!;
  state.set('simple', { ...simple, acceptance: 'green', version: 1 });
  const refused = eligibleOutcomes(fixture, state, firing);
  assert.ok(refused.includes('group-reject'));
  assert.ok(!refused.includes('schema-reject'));
  assert.ok(!refused.includes('green'));
});

test('owenloop#236: schema-free width-two map/reduce exhausts BFS but remains width-incomplete', () => {
  const report = modelCheck(memberReduceFixture(2, 5), {
    maxStates: 100_000,
    maxDepth: 50,
    maxCollectionSize: 2,
    assumeProvided: true,
  });
  assert.equal(report.bounded, false);
  assert.deepEqual(report.boundsHit, []);
  assert.deepEqual(report.coverageIncomplete, ['collection-width-cap']);
  assert.equal(report.completable, true);
  assert.deepEqual(report.deadlocks, []);
  assert.deepEqual(report.invariantViolations, []);
  assert.deepEqual(report.unreachedSteps, []);
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
  // A declared schema makes logger's validation refusal a real frozen debt
  // while worker can still progress on the independent branch.
  fixture.steps[0]!.produces[0]!.schema = { type: 'string' };
  fixture.steps[0]!.maxSchemaFailures = 1;
  const report = modelCheck(fixture, { maxStates: 5_000, assumeProvided: true });

  assert.equal(report.completable, true);
  assert.ok(report.stuck.length > 0);
});
