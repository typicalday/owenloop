import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isCommandStep, resolveCommandRouting } from '../src/proxy/routing.ts';
import type { FetchedStep } from '../src/bundle/types.ts';

function step(over: Partial<FetchedStep> = {}): FetchedStep {
  return { name: 'deprovisioner', worker: 'command', ...over };
}

test('isCommandStep is true only for worker:command', () => {
  assert.equal(isCommandStep(step()), true);
  assert.equal(isCommandStep({ name: 'builder' }), false);
  assert.equal(isCommandStep({ name: 'builder', worker: 'claude' }), false);
});

test('default (no setting, no override) resolves to proxy — auto-dispatch', () => {
  const r = resolveCommandRouting(undefined, step());
  assert.equal(r.routing, 'proxy');
  assert.equal(r.autoDispatch, true);
  assert.deepEqual(r.warnings, []);
});

test('machine setting conductor wins over an absent override', () => {
  const r = resolveCommandRouting('conductor', step());
  assert.equal(r.routing, 'conductor');
  assert.equal(r.autoDispatch, false);
  assert.deepEqual(r.warnings, []);
});

test('x.owenwork.routing conductor wins over a proxy machine setting', () => {
  const r = resolveCommandRouting('proxy', step({ x: { owenwork: { routing: 'conductor' } } }));
  assert.equal(r.routing, 'conductor');
  assert.equal(r.autoDispatch, false);
});

test('both proxy resolves to proxy', () => {
  const r = resolveCommandRouting('proxy', step({ x: { owenwork: { routing: 'proxy' } } }));
  assert.equal(r.routing, 'proxy');
  assert.equal(r.autoDispatch, true);
});

test('an invalid machine value fails closed to conductor with a warning', () => {
  const r = resolveCommandRouting('sometimes', step());
  assert.equal(r.routing, 'conductor');
  assert.equal(r.autoDispatch, false);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /invalid commandRouting/);
});

test('an invalid override value fails closed to conductor with a warning', () => {
  const r = resolveCommandRouting('proxy', step({ x: { owenwork: { routing: 42 } } }));
  assert.equal(r.routing, 'conductor');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /x\.owenwork\.routing/);
});

test('a malformed x.owenwork bag fails closed to conductor with a warning', () => {
  const r = resolveCommandRouting('proxy', step({ x: { owenwork: 'nope' } }));
  assert.equal(r.routing, 'conductor');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /malformed x\.owenwork bag/);
});

test('an absent x.owenwork bag leaves the machine setting in control', () => {
  assert.equal(resolveCommandRouting('proxy', step({ x: { 'claude-code': {} } })).routing, 'proxy');
  assert.equal(resolveCommandRouting('conductor', step({ x: {} })).routing, 'conductor');
});
