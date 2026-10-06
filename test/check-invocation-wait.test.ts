import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDef } from '../src/defs.ts';
import { hasDefiniteCheckDefect, modelCheck } from '../src/model.ts';
import type { StepDef, WorkflowDef } from '../src/types.ts';
import { def, input, step } from './helpers.ts';

function invocation(name: string, gate: string): StepDef {
  return {
    ...step({ name, produces: ['choice'] }),
    callsInterface: {
      name: 'report', version: '1', selection: 'invocation',
      signature: { inputs: [{ name: 'data', schema: true }], outputs: [{ name: 'result', schema: true }] },
      policy: { name: 'local', version: '1', config: {} },
    },
    callsInputs: { data: gate },
  };
}

function fixture(withInvocation: boolean): WorkflowDef {
  return def('unrelated-owed-input', [
    input('ready', { seedOwed: false }), input('blocked', { seedOwed: true }),
  ], [
    step({ name: 'worker', consumes: ['blocked'], produces: ['done'] }),
    ...(withInvocation ? [invocation('choose', 'ready')] : []),
  ]);
}

test('invocation wait cannot mask an unrelated strict-input deadlock', () => {
  const baseline = fixture(false);
  const withInvocation = fixture(true);
  assert.deepEqual(validateDef(baseline), []);
  assert.deepEqual(validateDef(withInvocation), []);
  const without = modelCheck(baseline, { assumeProvided: false });
  assert.deepEqual(without.deadlocks.map((finding) => finding.path), [[]]);
  const report = modelCheck(withInvocation, { assumeProvided: false });
  assert.deepEqual(report.externalSelectionWait?.map((finding) => finding.path), [[]]);
  assert.deepEqual(report.deadlocks.map((finding) => finding.path), [[]],
    'the owed root input is a deadlock in the actual initial state');
  assert.equal(report.completable, false);
  assert.equal(hasDefiniteCheckDefect(report), true);
});

test('healthy invocation wait stays nondeadlocked without claiming completion', () => {
  const definition = def('healthy-invocation', [input('ready')], [
    invocation('choose', 'ready'),
    step({ name: 'finish', consumes: ['choice'], produces: ['done'] }),
  ]);
  assert.deepEqual(validateDef(definition), []);
  const report = modelCheck(definition);
  assert.deepEqual(report.deadlocks, []);
  assert.ok(report.externalSelectionWait?.length);
  assert.equal(report.completable, false,
    'waiting for external selection does not prove completion');
  assert.equal(hasDefiniteCheckDefect(report), false);
});
