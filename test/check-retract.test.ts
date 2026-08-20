/** Regression coverage for model-only collection-member retractions. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDefFile } from '../src/defs.ts';
import {
  applyOutcome,
  eligibleFirings,
  memberRetractFirings,
  modelCheck,
  settleInMemory,
} from '../src/model.ts';
import { arts, def, input, step } from './helpers.ts';

const memberRetractFixture = def(
  'member-retract-fixture',
  [input('question', { seedOwed: false })],
  [
    step({ name: 'gather', consumes: ['question'], produces: ['gather.source[]'] }),
    step({ name: 'check', consumes: ['gather.source[$i]'], produces: ['gather.source[$i].verdict'] }),
    step({ name: 'synth', consumes: ['gather.source[*].verdict'], produces: ['draft'] }),
    // Repeating the edge proves an authorized pair appears only once.
    step({ name: 'plain-consumer', consumes: ['gather.source', 'gather.source'], produces: ['plain-result'] }),
    step({ name: 'not-a-consumer', consumes: ['question'], produces: ['other-result'] }),
    // Mirrors a synthesized judge with a collection member in read-only context.
    {
      ...step({ name: 'publisher.report.judges.policy', consumes: ['gather.source'], produces: [] }),
      judges: 'report',
    },
  ],
);

test('memberRetractFirings: rejected member retracts through every authorized non-judge consumer', () => {
  let state = settleInMemory(
    memberRetractFixture,
    new Map(arts([{ path: 'question', acceptance: 'green', version: 1 }])),
  );

  const gather = eligibleFirings(memberRetractFixture, state).find((f) => f.step === 'gather');
  assert.ok(gather, 'collection producer must be eligible');
  state = applyOutcome(memberRetractFixture, state, gather, 'emit-seal', { maxCollectionSize: 1 })[1]!;

  const check = eligibleFirings(memberRetractFixture, state).find((f) => f.step === 'check');
  assert.ok(check, 'map consumer must be eligible for the emitted member');
  state = applyOutcome(memberRetractFixture, state, check, 'judgment-reject', { maxCollectionSize: 1 })[0]!;
  assert.equal(state.get('gather.source[0]')?.acceptance, 'rejected', 'setup must reject the bare member');

  const offered = memberRetractFirings(memberRetractFixture, state);
  assert.deepEqual(
    offered.map((f) => f.step),
    ['check', 'synth', 'plain-consumer'],
    'every map/reduce/plain consumer gets exactly one authorized member retract',
  );
  assert.ok(
    offered.every(
      (f) =>
        f.modelTransition === 'member-retract' &&
        f.key === 'gather.source[0]' &&
        f.index === 0 &&
        f.inputs.length === 0 &&
        f.outputs.length === 1 &&
        f.outputs[0] === 'gather.source[0]',
    ),
    'each transition is tagged, has no claim-fingerprint inputs, and targets only the bare member',
  );
  assert.ok(!offered.some((f) => f.step === 'not-a-consumer'), 'non-consumers receive no retract authority');
  assert.ok(
    !offered.some((f) => f.step === 'publisher.report.judges.policy'),
    'synthesized judges receive no retract authority through context consumes',
  );

  const checkRetract = offered.find((f) => f.step === 'check');
  assert.ok(checkRetract, 'the rejected map consumer must retain its runtime retract action');
  state = applyOutcome(memberRetractFixture, state, checkRetract, 'retract', { maxCollectionSize: 1 })[0]!;

  assert.equal(state.get('gather.source[0]')?.acceptance, 'retracted');
  assert.equal(
    state.get('gather.source[0].verdict')?.acceptance,
    'retracted',
    'settleInMemory cascades the bare-member retract to its suffixed map child',
  );
  assert.ok(
    eligibleFirings(memberRetractFixture, state).some((f) => f.step === 'synth'),
    'the suffixed reduce is eligible over the empty surviving-member set',
  );
  assert.equal(
    memberRetractFirings(memberRetractFixture, state).filter((f) => f.key === 'gather.source[0]').length,
    0,
    'an already retracted member receives no additional retract transition',
  );
});

test('modelCheck: shipped research exhaustively reaches no collection-member deadlocks', () => {
  const shippedResearch = loadDefFile(new URL('../examples/workflows/research.yaml', import.meta.url));
  const report = modelCheck(shippedResearch, { maxStates: 50_000, assumeProvided: true });

  assert.equal(report.bounded, false);
  assert.deepEqual(report.boundsHit, []);
  assert.deepEqual(report.deadlocks, []);
  assert.deepEqual(report.structurallyDeadSteps, []);
  assert.deepEqual(report.invariantViolations, []);
  assert.equal(report.completable, true);
});
