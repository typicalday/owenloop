import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attenuate,
  axisPermits,
  delegationPermits,
  ORG_ROOT_SCOPE,
  scopePermits,
} from '../src/crypto/scope.ts';
import type { GrantDelegation, GrantScope } from '../src/crypto/records.ts';

const denied: GrantDelegation = { allowed: false };
const allowed = (maxDepth: number | 'unbounded'): GrantDelegation => ({ allowed: true, maxDepth });
const scope = (overrides: Partial<GrantScope> = {}): GrantScope => ({
  pools: ['marketing'],
  labels: ['billing'],
  namespaces: ['default'],
  delegation: denied,
  ...overrides,
});

test('scope axes use subset arithmetic, including the distinct * and [] cases', () => {
  assert.equal(axisPermits('*', ['hr']), true);
  assert.equal(axisPermits('*', '*'), true);
  assert.equal(axisPermits(['marketing'], ['marketing']), true);
  assert.equal(axisPermits(['marketing', 'hr'], ['marketing']), true);
  assert.equal(axisPermits(['marketing'], ['hr']), false);
  assert.equal(axisPermits(['marketing'], '*'), false, 'an allow-list cannot widen to *');
  assert.equal(axisPermits([], []), true);
  assert.equal(axisPermits([], '*'), false);
  assert.equal(axisPermits('*', []), true);
});

test('attenuation rejects a marketing parent granting hr by arithmetic, not a name check', () => {
  const result = attenuate(
    scope({ pools: ['marketing'] }),
    scope({ pools: ['hr'] }),
  );
  assert.deepEqual(result, { ok: false, reason: 'pools scope widens from [marketing] to [hr]' });
});

test('attenuation rejects every axis widening and accepts the root identity scope', () => {
  for (const axis of ['pools', 'labels', 'namespaces'] as const) {
    const result = attenuate(scope({ [axis]: ['marketing'] }), scope({ [axis]: '*' }));
    assert.equal(result.ok, false, `${axis} must reject array-to-* widening`);
  }
  assert.deepEqual(attenuate(ORG_ROOT_SCOPE, scope({ pools: [] })), { ok: true });
});

test('delegation arithmetic covers denied, unbounded, zero, and finite depth rows', () => {
  assert.equal(delegationPermits(denied, denied).ok, false);
  assert.equal(delegationPermits(denied, allowed(0)).ok, false);

  assert.deepEqual(delegationPermits(allowed('unbounded'), denied), { ok: true });
  assert.deepEqual(delegationPermits(allowed('unbounded'), allowed(0)), { ok: true });
  assert.deepEqual(delegationPermits(allowed('unbounded'), allowed('unbounded')), { ok: true });

  assert.deepEqual(delegationPermits(allowed(0), denied), { ok: true });
  assert.equal(delegationPermits(allowed(0), allowed(0)).ok, false);
  assert.deepEqual(delegationPermits(allowed(2), denied), { ok: true });
  assert.deepEqual(delegationPermits(allowed(2), allowed(1)), { ok: true });
  assert.equal(delegationPermits(allowed(2), allowed(2)).ok, false);
  assert.equal(delegationPermits(allowed(2), allowed('unbounded')).ok, false);
});

test('scopePermits checks only demanded axes and reports the denied value', () => {
  assert.deepEqual(scopePermits(scope({ labels: '*' }), { pool: 'marketing', label: 'hr' }), { ok: true });
  assert.deepEqual(scopePermits(scope({ pools: [] }), { pool: 'marketing' }), {
    ok: false,
    reason: "pool 'marketing' is outside the granted scope",
  });
  assert.deepEqual(scopePermits(scope({ namespaces: ['default'] }), { namespace: 'other' }), {
    ok: false,
    reason: "namespace 'other' is outside the granted scope",
  });
});
