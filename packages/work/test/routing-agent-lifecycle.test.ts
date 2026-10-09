import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoutedAgentLifecycle } from '../src/roles/routing-agent-lifecycle.ts';
import type { RoutingChildClient } from '../src/hub/routing-child-client.ts';
import type { RoutedCodexLaunchRequest } from '../src/harness/codex.ts';

const group = { scope: 'original-posix-group' as const, state: 'empty' as const };
const fakeArgs = {} as Parameters<ReturnType<typeof createRoutedAgentLifecycle>['start']>[0];

function fixture(opts: { freeze?: 'settled' | 'uncertain'; claim?: 'closed' | 'held' | 'uncertain';
  groupState?: 'empty' | 'uncertain'; startThrows?: boolean } = {}) {
  const calls: string[] = [];
  let releaseFreeze!: (value: { quiescing: true; effects: 'settled' | 'uncertain' }) => void;
  let holdFreeze = false;
  const pendingFreeze = new Promise<{ quiescing: true; effects: 'settled' | 'uncertain' }>(resolve => {
    releaseFreeze = resolve;
  });
  const child = {
    quiesce: () => { calls.push('freeze'); return holdFreeze ? pendingFreeze
      : Promise.resolve({ quiescing: true as const, effects: opts.freeze ?? 'settled' }); },
    agentOutcome: async (req: unknown) => { calls.push('outcome'); assert.deepEqual(req, { group });
      return { claim: opts.claim ?? 'closed' }; },
    agentFinish: async (req: unknown) => { calls.push('finish');
      assert.deepEqual(req, opts.startThrows ? { observation: 'not-started' } :
	calls.includes('group') ? { group } : { observation: 'not-started' });
      return { state: 'released' }; },
  } as unknown as Pick<RoutingChildClient, 'quiesce' | 'agentOutcome' | 'agentFinish'>;
  const start = ((_args: unknown, _event: unknown, launch: RoutedCodexLaunchRequest) => {
    calls.push('start');
    if (opts.startThrows) throw new Error('spawn ambiguous');
    launch.onLaunch({ generation: launch.generation, transport: {
      settleEffects: async () => { calls.push('group'); return { scope: 'original-posix-group',
	state: opts.groupState ?? 'empty', evidence: {} }; },
    } as never });
    return Promise.resolve({ harness: 'codex', token: 'thread' });
  }) as never;
  const lifecycle = createRoutedAgentLifecycle({ child, generation: 'one-use', start });
  return { lifecycle, calls, hold: () => { holdFreeze = true; },
    release: () => releaseFreeze({ quiescing: true, effects: opts.freeze ?? 'settled' }) };
}

test('routed no-start freeze releases only by parent finish', async () => {
  const f = fixture();
  assert.equal(await f.lifecycle.complete('prestart'), 'released');
  assert.deepEqual(f.calls, ['freeze', 'finish']);
});

test('routed turn end settles retained group and accepts only parent closed ACK', async () => {
  const f = fixture({ freeze: 'uncertain', claim: 'closed' });
  await f.lifecycle.start(fakeArgs, () => {});
  assert.equal(await f.lifecycle.complete('turn-ended'), 'submitted');
  assert.deepEqual(f.calls, ['start', 'freeze', 'group', 'outcome']);
  assert.equal(await f.lifecycle.complete('turn-ended'), 'submitted');
  assert.equal(f.calls.filter(call => call === 'outcome').length, 1);
});

test('held turn releases only after group empty and parent outcome', async () => {
  const f = fixture({ claim: 'held' });
  await f.lifecycle.start(fakeArgs, () => {});
  assert.equal(await f.lifecycle.complete('turn-ended'), 'released');
  assert.deepEqual(f.calls, ['start', 'freeze', 'group', 'outcome', 'finish']);
});

test('stop begins retained group settlement even while broker freeze ACK is stalled', async () => {
  const f = fixture();
  await f.lifecycle.start(fakeArgs, () => {});
  f.hold();
  f.lifecycle.requestStop();
  assert.deepEqual(f.calls, ['start', 'freeze', 'group']);
  const result = f.lifecycle.complete('stop');
  f.release();
  assert.equal(await result, 'submitted');
});

test('ambiguous synchronous spawn failure never asserts not-started or releases', async () => {
  const f = fixture({ startThrows: true });
  assert.throws(() => f.lifecycle.start(fakeArgs, () => {}), /spawn ambiguous/);
  assert.equal(await f.lifecycle.complete('prestart'), 'uncertain');
  assert.deepEqual(f.calls, ['start', 'freeze']);
});

test('uncertain original group cannot reach parent outcome or release', async () => {
  const f = fixture({ groupState: 'uncertain' });
  await f.lifecycle.start(fakeArgs, () => {});
  assert.equal(await f.lifecycle.complete('turn-ended'), 'uncertain');
  assert.deepEqual(f.calls, ['start', 'freeze', 'group']);
});

test('stop observes a rejected freeze without abandoning retained group teardown', async () => {
  const calls: string[] = [];
  const lifecycle = createRoutedAgentLifecycle({ generation: 'rejected-freeze',
    child: { quiesce: () => { calls.push('freeze'); return Promise.reject(new Error('lost ACK')); },
      agentOutcome: async () => { calls.push('outcome'); return { claim: 'closed' }; },
      agentFinish: async () => { calls.push('finish'); return { state: 'released' }; } } as never,
    start: ((_args: unknown, _event: unknown, launch: RoutedCodexLaunchRequest) => {
      launch.onLaunch({ generation: launch.generation, transport: {
	settleEffects: async () => { calls.push('group'); return {
	  scope: 'original-posix-group', state: 'empty', evidence: {} }; },
      } as never });
      return Promise.resolve({ harness: 'codex', token: 'thread' });
    }) as never });
  await lifecycle.start(fakeArgs, () => {});
  lifecycle.requestStop();
  assert.equal(await lifecycle.complete('stop'), 'uncertain');
  assert.deepEqual(calls, ['freeze', 'group']);
});

test('a timed-out finish aborts its socket before a late release can dispatch', async () => {
  let aborted = false;
  let released = 0;
  const lifecycle = createRoutedAgentLifecycle({ generation: 'finish-deadline', terminalMs: 5,
    child: { quiesce: async () => ({ quiescing: true, effects: 'settled' }),
      agentOutcome: async () => ({ claim: 'uncertain' }),
      agentFinish: async (_req: unknown, signal?: AbortSignal) => {
	await new Promise<void>(resolve => setTimeout(resolve, 25));
	aborted = signal?.aborted === true;
	if (!aborted) released++;
	return { state: 'released' };
      } } as never });
  assert.equal(await lifecycle.complete('prestart'), 'uncertain');
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  assert.equal(aborted, true);
  assert.equal(released, 0);
});
