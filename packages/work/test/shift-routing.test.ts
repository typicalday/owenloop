import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isCommandStep, resolveCommandRouting } from '../src/shift/routing.ts';
import type { FetchedStep } from '../src/bundle/types.ts';

function step(over: Partial<FetchedStep> = {}): FetchedStep {
  return { name: 'deprovisioner', executor: 'command', ...over };
}

test('isCommandStep is true only for executor:command', () => {
  assert.equal(isCommandStep(step()), true);
  assert.equal(isCommandStep({ name: 'builder' }), false);
  assert.equal(isCommandStep({ name: 'builder', executor: 'claude' }), false);
});

test('default (no setting, no override) resolves to shift — auto-dispatch', () => {
  const r = resolveCommandRouting(undefined, step());
  assert.equal(r.routing, 'shift');
  assert.equal(r.autoDispatch, true);
  assert.deepEqual(r.warnings, []);
});

test('machine setting shift wins over an absent override', () => {
  const r = resolveCommandRouting('manual', step());
  assert.equal(r.routing, 'manual');
  assert.equal(r.autoDispatch, false);
  assert.deepEqual(r.warnings, []);
});

test('x.owenloop.routing shift wins over a shift machine setting', () => {
  const r = resolveCommandRouting('shift', step({ x: { owenloop: { routing: 'manual' } } }));
  assert.equal(r.routing, 'manual');
  assert.equal(r.autoDispatch, false);
});

test('both shift resolves to shift', () => {
  const r = resolveCommandRouting('shift', step({ x: { owenloop: { routing: 'shift' } } }));
  assert.equal(r.routing, 'shift');
  assert.equal(r.autoDispatch, true);
});

test('an invalid machine value fails closed to manual with a warning', () => {
  const r = resolveCommandRouting('sometimes', step());
  assert.equal(r.routing, 'manual');
  assert.equal(r.autoDispatch, false);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /invalid commandRouting/);
});

test('an invalid override value fails closed to manual with a warning', () => {
  const r = resolveCommandRouting('shift', step({ x: { owenloop: { routing: 42 } } }));
  assert.equal(r.routing, 'manual');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /x\.owenloop\.routing/);
});

test('a malformed x.owenloop bag fails closed to manual with a warning', () => {
  const r = resolveCommandRouting('shift', step({ x: { owenloop: 'nope' } }));
  assert.equal(r.routing, 'manual');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /malformed x\.owenloop bag/);
});

test('an absent x.owenloop bag leaves the machine setting in control', () => {
  assert.equal(resolveCommandRouting('shift', step({ x: { harness: { id: 'claude-code' } } })).routing, 'shift');
  assert.equal(resolveCommandRouting('manual', step({ x: {} })).routing, 'manual');
});
