import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { createRoutingHolderHandoff, consumeRoutingHolderHandoff } from '../src/roles/routing-holder-handoff.ts';
import type { RoutingHandoffV1 } from '../src/shift/runtime.ts';

const origin = 'https://hub.example';
const sessionId = 'rs_12345678-1234-1234-1234-123456789abc';
const handoff: RoutingHandoffV1 = {
  version: 'routing-handoff-v1', incarnation: 'inc_' + 'a'.repeat(32), nonce: 'b'.repeat(32),
  origin, orgId: 'org', sessionId, shiftId: 'shf_original',
  broker: { socketPath: '/tmp/ol-rb-ABC123/broker.sock', cap: 'a'.repeat(64) },
  holderBroker: { socketPath: '/tmp/ol-rb-ABC123/broker.sock', cap: 'b'.repeat(64) },
  reservation: { recordType: 'reservation', workflow: 'wf', run: 'run', childKind: 'agent-run',
    reservedAt: 1_000, token: 'c'.repeat(32) },
  createdAt: 1_000, expiresAt: 10_000, sessionExpiresAt: 500_000,
};

test('nested holder consumes a private one-use broker handoff bound to its run', () => {
  const created = createRoutingHolderHandoff(handoff, 2_000);
  try {
    assert.equal(statSync(dirname(created.path)).mode & 0o777, 0o700);
    assert.equal(statSync(created.path).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(created.path, 'utf8'), /credential|Bearer|enrolled/);
    const binding = consumeRoutingHolderHandoff({ path: created.path, origin,
      workflow: 'wf', run: 'run', now: () => 2_001 });
    assert.equal(binding.sessionId, sessionId);
    assert.equal(binding.broker.cap, 'b'.repeat(64));
    assert.equal(existsSync(created.path), false);
    assert.throws(() => consumeRoutingHolderHandoff({ path: created.path, origin,
      workflow: 'wf', run: 'run', now: () => 2_002 }), /handoff refused/);
  } finally { created.cleanup(); }
});

test('nested holder refuses wrong target or expired private handoff', () => {
  const wrong = createRoutingHolderHandoff(handoff, 2_000);
  assert.throws(() => consumeRoutingHolderHandoff({ path: wrong.path, origin,
    workflow: 'wf', run: 'other', now: () => 2_001 }), /handoff refused/);
  wrong.cleanup();
  const stale = createRoutingHolderHandoff(handoff, 2_000);
  assert.throws(() => consumeRoutingHolderHandoff({ path: stale.path, origin,
    workflow: 'wf', run: 'run', now: () => 122_001 }), /handoff refused/);
  stale.cleanup();
});
