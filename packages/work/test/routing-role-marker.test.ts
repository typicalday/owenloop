import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run as runAgent } from '../src/roles/agent-run.ts';
import { run as runExec } from '../src/roles/exec.ts';
import { exactRoutedRoleArgs, routingRoleMarker } from '../src/roles/routing-role-marker.ts';

test('only the exact Shift routed argv shape is admitted', () => {
  const target = { workflow: 'wf', run: 'run' };
  const exact = ['wf/run', '--origin', 'https://hub.example', '--shift', 'shf_one'];
  assert.equal(exactRoutedRoleArgs(exact, target, 'https://hub.example', 'shf_one'), true);
  for (const args of [
    [...exact, '--shift', 'shf_one'],
    ['wf/run', '--origin', 'https://hub.example', '--origin', 'https://hub.example', '--shift', 'shf_one'],
    ['wf/run', '--shift', 'shf_one', '--origin', 'https://hub.example'],
    ['wf/run', '--origin=https://hub.example', '--shift=shf_one'],
    ['run', '--workflow', 'wf', '--origin', 'https://hub.example', '--shift', 'shf_one'],
  ]) assert.equal(exactRoutedRoleArgs(args, target, 'https://hub.example', 'shf_one'), false);
});

test('only absent or literal disabled session in both sources is ordinary', () => {
  assert.equal(routingRoleMarker({}, {}), 'ordinary');
  assert.equal(routingRoleMarker({ OWENLOOP_ROUTING_SESSION: '0' }, {}), 'ordinary');
  assert.equal(routingRoleMarker({}, { OWENLOOP_ROUTING_SESSION: '0' }), 'ordinary');
  assert.equal(routingRoleMarker({ OWENLOOP_ROUTING_SESSION: '0' },
    { OWENLOOP_ROUTING_SESSION: '0' }), 'ordinary');
  assert.equal(routingRoleMarker({ OWENLOOP_ROUTING_SESSION: '0' },
    { OWENLOOP_ROUTING_SESSION: '1' }), 'routed');
  assert.equal(routingRoleMarker({ OWENLOOP_ROUTING_SESSION: '1' },
    { OWENLOOP_ROUTING_SESSION: '0' }), 'routed');
});

test('handoff and holder presence route even when the injected value is undefined', () => {
  for (const key of ['OWENLOOP_ROUTING_HANDOFF', 'OWENLOOP_ROUTING_HOLDER'] as const) {
    assert.equal(routingRoleMarker({ [key]: undefined }, {}), 'routed');
    assert.equal(routingRoleMarker({}, { [key]: '' }), 'routed');
  }
  assert.equal(routingRoleMarker({ OWENLOOP_ROUTING_HANDOFF: '/one' },
    { OWENLOOP_ROUTING_HANDOFF: '/two' }), 'invalid');
});

test('an empty or malformed session refuses before either role reads settings', async () => {
  for (const value of ['', 'maybe', ' 0 ', '2']) {
    assert.equal(routingRoleMarker({ OWENLOOP_ROUTING_SESSION: value }, {}), 'invalid');
    for (const role of [runAgent, runExec]) {
      const errors: string[] = [];
      const status = await role(['wf/run', '--origin', 'https://hub.example'], {
	env: { HOME: '', OWENLOOP_ROUTING_SESSION: value }, err: line => errors.push(line),
      });
      assert.equal(status, 1);
      assert.match(errors.at(-1)!, /routing handoff refused/);
      assert.doesNotMatch(errors.join('\n'), /settings|credential|Scoped Identity/);
    }
  }
  assert.equal(routingRoleMarker({ OWENLOOP_ROUTING_SESSION: '1' },
    { OWENLOOP_ROUTING_SESSION: '' }), 'invalid');
});

test('session-only routing and holder-only routing never fall through to a bearer', async () => {
  for (const env of [
    { OWENLOOP_ROUTING_SESSION: '1' },
    { OWENLOOP_ROUTING_HOLDER: '' },
    { OWENLOOP_ROUTING_HANDOFF: undefined },
  ]) {
    for (const role of [runAgent, runExec]) {
      const errors: string[] = [];
      const status = await role(['wf/run', '--origin', 'https://hub.example', '--shift', 'shf_test'], {
	env: { HOME: '', ...env }, err: line => errors.push(line),
      });
      assert.equal(status, 1);
      assert.match(errors.at(-1)!, /routing handoff refused/);
    }
  }
});

test('injected session zero cannot mask ambient session one in either role', async () => {
  const previous = process.env.OWENLOOP_ROUTING_SESSION;
  try {
    process.env.OWENLOOP_ROUTING_SESSION = '1';
    for (const role of [runAgent, runExec]) {
      const errors: string[] = [];
      const status = await role(['wf/run', '--origin', 'https://hub.example', '--shift', 'shf_test'], {
	env: { HOME: '', OWENLOOP_ROUTING_SESSION: '0' }, err: line => errors.push(line),
      });
      assert.equal(status, 1);
      assert.match(errors.at(-1)!, /routing handoff refused/);
    }
  } finally {
    if (previous === undefined) delete process.env.OWENLOOP_ROUTING_SESSION;
    else process.env.OWENLOOP_ROUTING_SESSION = previous;
  }
});
