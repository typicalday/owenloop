import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDef } from '../src/defs.ts';
import { applyOutcome, canonicalKey, settleInMemory, workflowStatus } from '../src/model.ts';
import { def, input, step } from './helpers.ts';

test('checker key treats approvals for the current version equally after a rebuild', () => {
  const a = step({ name: 'a', consumes: ['q'], produces: ['a'], maxSchemaFailures: 0 });
  const b = step({ name: 'b', consumes: ['a'], produces: ['b'], maxSchemaFailures: 0 });
  b.produces[0]!.judges = [{ name: 'j', body: 'judge' }, { name: 'k', body: 'judge' }];
  const judge = step({ name: 'b.b.judges.j', consumes: ['b'] });
  judge.judges = 'b';
  const secondJudge = step({ name: 'b.b.judges.k', consumes: ['b'] });
  secondJudge.judges = 'b';
  const c = step({ name: 'c', consumes: ['a'], produces: ['c'], maxSchemaFailures: 0 });
  const definition = def('checker-approval-key', [input('q')], [a, b, judge, secondJudge, c]);
  assert.deepEqual(validateDef(definition), []);

  type Outcome = 'green' | 'judgment-reject' | 'judge-approve';
  const run = (path: [string, Outcome][]) => {
    let arts = settleInMemory(definition, new Map([['q', {
      workflow: '', path: 'q', producer: 'human' as const, acceptance: 'green' as const,
      version: 1, reasons: [], judgmentRejects: 0, schemaRejects: 0,
    }]]));
    for (const [name, outcome] of path) {
      const firing = workflowStatus(definition, arts).eligible.find((candidate) => candidate.step === name);
      assert.ok(firing, `${name} must be eligible`);
      arts = applyOutcome(definition, arts, firing, outcome, { maxCollectionSize: 0 })[0]!;
    }
    return arts;
  };

  // Both are reachable and submitted with the same visible lifecycle state.
  // In the second route b was rejected by c's rejection of a, then rebuilt.
  const first = run([['a', 'green'], ['c', 'judgment-reject'], ['a', 'green'], ['b', 'green']]);
  const rebuilt = run([['a', 'green'], ['b', 'green'], ['c', 'judgment-reject'], ['a', 'green'], ['b', 'green']]);
  assert.equal(first.get('b')?.version, 1);
  assert.equal(rebuilt.get('b')?.version, 2);
  assert.equal(canonicalKey(definition, first), canonicalKey(definition, rebuilt));

  const approve = (arts: typeof first, judgeName: string) => {
    const firing = workflowStatus(definition, arts).eligible.find((candidate) => candidate.step === judgeName);
    assert.ok(firing);
    return applyOutcome(definition, arts, firing, 'judge-approve', { maxCollectionSize: 0 })[0]!;
  };
  const partialFirst = approve(first, judge.name);
  const partialRebuilt = approve(rebuilt, judge.name);
  assert.equal(partialFirst.get('b')?.acceptance, 'submitted');
  assert.equal(partialRebuilt.get('b')?.acceptance, 'submitted');
  assert.notEqual(canonicalKey(definition, first), canonicalKey(definition, partialFirst));
  assert.equal(canonicalKey(definition, partialFirst), canonicalKey(definition, partialRebuilt));
  const approvedFirst = approve(partialFirst, secondJudge.name);
  const approvedRebuilt = approve(partialRebuilt, secondJudge.name);
  assert.equal(approvedFirst.get('b')?.acceptance, 'green');
  assert.equal(approvedRebuilt.get('b')?.acceptance, 'green');
  assert.equal(canonicalKey(definition, approvedFirst), canonicalKey(definition, approvedRebuilt));
});
