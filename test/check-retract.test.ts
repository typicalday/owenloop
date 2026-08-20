/** Regression coverage for model-only collection-member retractions. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDefFile } from '../src/defs.ts';
import {
  applyOutcome,
  canonicalKey,
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

const canonicalFixture = def(
  'member-retract-canonical',
  [input('seed', { seedOwed: false })],
  [
    step({ name: 'fanout', consumes: ['seed'], produces: ['items[]'] }),
    step({ name: 'mapper', consumes: ['items[$i]'], produces: ['items[$i].checked'] }),
    step({ name: 'reviewer', consumes: ['items[$i].checked'], produces: ['items[$i].checked.review'] }),
  ],
);

function replaceArtifact(
  state: Map<string, ReturnType<typeof arts> extends ReadonlyMap<string, infer Art> ? Art : never>,
  path: string,
  changes: Record<string, unknown>,
) {
  const next = new Map(state);
  next.set(path, { ...next.get(path)!, ...changes });
  return next;
}

test('canonicalKey: quotients only terminal retracted collection-member families', () => {
  const first = new Map(
    arts([
      { path: 'seed', acceptance: 'green', version: 1 },
      { path: 'items.sealed', producer: 'fanout', acceptance: 'green', version: 1 },
      { path: 'items[0]', producer: 'fanout', acceptance: 'retracted', version: 9, judgmentRejects: 2 },
      { path: 'items[0].checked', producer: 'mapper', acceptance: 'retracted', version: 8, schemaRejects: 4 },
      { path: 'items[0].checked.review', producer: 'reviewer', acceptance: 'retracted', version: 7 },
      { path: 'draft', acceptance: 'skipped', version: 0, fingerprint: { 'items[0].checked': 1 } },
      { path: 'items[1]', producer: 'fanout', acceptance: 'green', version: 1 },
      {
	path: 'items[1].checked',
	producer: 'mapper',
	acceptance: 'skipped',
	version: 1,
	fingerprint: { 'items[1]': 1 },
      },
    ]),
  );
  const isomorphic = new Map(
    arts([
      { path: 'seed', acceptance: 'green', version: 1 },
      { path: 'items.sealed', producer: 'fanout', acceptance: 'green', version: 1 },
      { path: 'items[3]', producer: 'fanout', acceptance: 'retracted', version: 2, judgmentRejects: 0 },
      { path: 'items[3].checked', producer: 'mapper', acceptance: 'retracted', version: 1, schemaRejects: 0 },
      { path: 'items[3].checked.review', producer: 'reviewer', acceptance: 'retracted', version: 1 },
      { path: 'draft', acceptance: 'skipped', version: 0, fingerprint: { 'items[3].checked': 1 } },
      { path: 'items[4]', producer: 'fanout', acceptance: 'green', version: 1 },
      {
	path: 'items[4].checked',
	producer: 'mapper',
	acceptance: 'skipped',
	version: 1,
	fingerprint: { 'items[4]': 1 },
      },
    ]),
  );

  const firstKey = canonicalKey(canonicalFixture, first);
  assert.equal(
    firstKey,
    canonicalKey(canonicalFixture, isomorphic),
    'terminal bare/member/map/review families and their historical indices are quotient-equivalent',
  );
  assert.notEqual(
    firstKey,
    canonicalKey(canonicalFixture, replaceArtifact(first, 'items[1]', { acceptance: 'rejected' })),
    'a rejected surviving member remains distinct',
  );
  assert.notEqual(
    firstKey,
    canonicalKey(
      canonicalFixture,
      replaceArtifact(first, 'items[1]', { acceptance: 'skipped', fingerprint: { seed: 1 } }),
    ),
    'a skipped surviving member remains distinct',
  );
  assert.notEqual(
    firstKey,
    canonicalKey(canonicalFixture, replaceArtifact(first, 'items[0].checked', { acceptance: 'green', version: 1 })),
    'a nonterminal descendant of a retracted member stays visible',
  );
  assert.notEqual(
    firstKey,
    canonicalKey(
      canonicalFixture,
      replaceArtifact(first, 'items[1].checked', { fingerprint: { 'items[1]': 0 } }),
    ),
    'fingerprint references are remapped but their version rank remains distinct',
  );
});

test('memberRetractFirings: every non-retracted member retracts through every authorized non-judge consumer', () => {
  let state = settleInMemory(
    memberRetractFixture,
    new Map(arts([{ path: 'question', acceptance: 'green', version: 1 }])),
  );

  const gather = eligibleFirings(memberRetractFixture, state).find((f) => f.step === 'gather');
  assert.ok(gather, 'collection producer must be eligible');
  state = applyOutcome(memberRetractFixture, state, gather, 'emit-seal', { maxCollectionSize: 1 })[1]!;
  const expectedActors = ['check', 'synth', 'plain-consumer'];
  assert.deepEqual(
    memberRetractFirings(memberRetractFixture, state).map((f) => f.step),
    expectedActors,
    'a green bare member remains model-retractable to every authorized non-judge consumer',
  );
  for (const acceptance of ['owed', 'skipped'] as const) {
    const variant = new Map(state);
    const member = variant.get('gather.source[0]');
    assert.ok(member, 'setup must contain the emitted bare member');
    variant.set('gather.source[0]', { ...member, acceptance });
    assert.deepEqual(
      memberRetractFirings(memberRetractFixture, variant).map((f) => f.step),
      expectedActors,
      `a ${acceptance} bare member remains model-retractable to every authorized non-judge consumer`,
    );
  }

  const check = eligibleFirings(memberRetractFixture, state).find((f) => f.step === 'check');
  assert.ok(check, 'map consumer must be eligible for the emitted member');
  state = applyOutcome(memberRetractFixture, state, check, 'judgment-reject', { maxCollectionSize: 1 })[0]!;
  assert.equal(state.get('gather.source[0]')?.acceptance, 'rejected', 'setup must reject the bare member');

  const offered = memberRetractFirings(memberRetractFixture, state);
  assert.deepEqual(
    offered.map((f) => f.step),
    expectedActors,
    'a rejected member retains one retract transition for every map/reduce/plain consumer',
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

test('modelCheck: shipped research has no collection-member deadlocks within the reported bound', () => {
  const shippedResearch = loadDefFile(new URL('../examples/workflows/research.yaml', import.meta.url));
  const report = modelCheck(shippedResearch, { maxStates: 50_000, assumeProvided: true });

  assert.deepEqual(report.deadlocks, []);
  assert.deepEqual(report.structurallyDeadSteps, []);
  assert.deepEqual(report.invariantViolations, []);
  assert.equal(report.completable, true);
  assert.ok(report.stats.statesExplored > 0, 'the shipped fixture should produce a concrete bound report');
});
