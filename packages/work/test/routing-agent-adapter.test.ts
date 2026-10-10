import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HarnessAdapter, HarnessSessionRef } from '../src/harness/contract.ts';
import { createRoutedAgentAdapterGate } from '../src/roles/routing-agent-adapter.ts';

const launch = { generation: 'one-use', onLaunch: () => {} };
const args = {} as Parameters<NonNullable<HarnessAdapter['startRouted']>>[0];
const base = (id: string, start: HarnessAdapter['start']): HarnessAdapter => ({
  id, resumeTier: 'native-token', preflight: () => [], start,
  deliver: async () => {}, stop: async () => {},
});

test('an adapter without retained routed custody is ineligible and never uses ordinary start', async () => {
  let ordinaryStarts = 0;
  const ordinary = base('ordinary', async () => {
    ordinaryStarts++;
    return { harness: 'ordinary', token: 'unexpected' };
  });
  const gate = createRoutedAgentAdapterGate(id => id === ordinary.id ? ordinary : undefined,
    () => [ordinary.id]);
  assert.equal(gate.harnessAvailable(ordinary.id), false);
  assert.equal(gate.resolveAdapter(ordinary.id, undefined).adapter, undefined);
  assert.throws(() => gate.start(args, () => {}, launch), /routed agent adapter refused/);
  assert.equal(ordinaryStarts, 0);
});

test('routed start uses the exact captured adapter and callable after registry replacement', async () => {
  const starts: string[] = [];
  const first: HarnessAdapter = { ...base('managed', async () => {
    throw new Error('ordinary start must not run');
  }), startRouted: async (_args: unknown, _event: unknown,
    request: { generation: string }) => {
    starts.push(`first:${request.generation}`);
    return { harness: 'managed', token: 'first' };
  } };
  const replacement: HarnessAdapter = { ...base('managed', async () => {
    throw new Error('ordinary start must not run');
  }), startRouted: async () => {
    starts.push('replacement');
    return { harness: 'managed', token: 'replacement' };
  } };
  const registry = new Map([[first.id, first]]);
  const gate = createRoutedAgentAdapterGate(id => registry.get(id), () => [...registry.keys()]);
  assert.equal(gate.harnessAvailable(first.id), true);
  assert.equal(gate.resolveAdapter(first.id, undefined).adapter, first);
  registry.set(first.id, replacement);
  const ref: HarnessSessionRef = await gate.start(args, () => {}, launch);
  assert.deepEqual(ref, { harness: 'managed', token: 'first' });
  assert.deepEqual(starts, ['first:one-use']);
  assert.equal(gate.resolveAdapter(first.id, undefined).adapter, undefined);
  first.startRouted = replacement.startRouted;
  assert.throws(() => gate.start(args, () => {}, launch), /routed agent adapter refused/);
  assert.deepEqual(starts, ['first:one-use']);
});
