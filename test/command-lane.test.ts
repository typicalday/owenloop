import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Engine } from '../src/engine.ts';
import { createDefInstructionSource } from '../src/order-resolver.ts';
import { openStore } from '../src/store.ts';
import type { WorkflowDef } from '../src/types.ts';
import { assertReferenceContract, def, step } from './helpers.ts';

function fixture(defs?: WorkflowDef[]) {
  const mixed = def('command-lane', [], [
    step({ name: 'command', executor: 'command', command: 'printf test', capabilities: ['build'], produces: ['command-result'] }),
    step({ name: 'agent', capabilities: ['wise'], produces: ['agent-result'], body: 'Agent fixture' }),
  ], ['standard', 'deep']);
  const all = defs ?? [mixed];
  const byName = new Map(all.map(d => [d.name, d]));
  const store = openStore(':memory:');
  const engine = new Engine(store, name => {
    const d = byName.get(name);
    if (!d) throw new Error('unknown fixture');
    return d;
  }, { instructionSource: createDefInstructionSource(all) });
  return { engine, store, mixed, byName };
}

test('explicit command lane selects only its command while an unrelated agent capability remains refused', () => {
  const { engine, store } = fixture();
  try {
    const wf = engine.createInstance('command-lane', { modifier: 'deep' });
    const observed: string[] = [];
    const result = engine.tick(wf, { capabilities: ['unbound'], commandClaims: (workflow, name) => {
      observed.push(`${workflow}/${name}`); return workflow === wf && name === 'command';
    } });
    assert.deepEqual(result.orders.map(o => o.step), ['command']);
    assert.deepEqual(observed, [`${wf}/command`]);
    assert.equal(result.orders[0]!.worker, 'command');
    assertReferenceContract(result.orders[0]!);
    assert.deepEqual(result.orders[0]!.capabilities, ['build:deep']);
    assert.ok(result.deferred.some(d => d.step === 'agent' && d.reason === 'capability-mismatch'));
  } finally { store.close(); }
});

test('absent opt-in offers no new lane and explicit refusal does not fall back to a matching class crew', () => {
  const { engine, store } = fixture();
  try {
    const wf = engine.createInstance('command-lane');
    assert.equal(engine.tick(wf, { capabilities: ['unbound'] }).orders.length, 0);
    assert.equal(engine.tick(wf, { capabilities: ['build'], commandClaims: () => false }).orders.length, 0);
    // Existing class-crew command routing remains supported when the new lane
    // is omitted; production Delivery keeps that route until joined acceptance.
    assert.deepEqual(engine.tick(wf, { capabilities: ['build'] }).orders.map(o => o.step), ['command']);
  } finally { store.close(); }
});

test('agent modifier matching is unchanged and never calls the command predicate', () => {
  for (const advertised of ['wise:standard', 'wise:deep']) {
    const { engine, store } = fixture();
    try {
      const wf = engine.createInstance('command-lane', { modifier: 'deep' });
      const names: string[] = [];
      const result = engine.tick(wf, { capabilities: [advertised], matchModes: { 'wise:deep': 'exact' }, commandClaims: (_workflow, name) => {
        names.push(name); return false;
      } });
      assert.deepEqual(names, ['command']);
      assert.deepEqual(result.orders.map(o => o.step), advertised === 'wise:deep' ? ['agent'] : []);
      if (result.orders.length) assert.deepEqual(result.orders[0]!.capabilities, ['wise:deep']);
    } finally { store.close(); }
  }
});

test('deep ticks apply the command lane at the exact child frame without granting its neighboring agent', () => {
  const child: WorkflowDef = { ...def('command-child', [], [
    step({ name: 'command', executor: 'command', command: 'printf child', capabilities: ['build'], produces: ['out'] }),
    step({ name: 'agent', capabilities: ['wise'], produces: ['agent-out'] }),
  ]), outputs: ['out'] };
  const parent = def('command-parent', [], [
    { ...step({ name: 'delegate', produces: ['delivered'] }), calls: child.name, callsInputs: {} },
  ]);
  const { engine, store } = fixture([parent, child]);
  try {
    const wf = engine.createInstance(parent.name);
    const seen: string[] = [];
    const result = engine.tick(wf, { capabilities: ['unbound'], commandClaims: (frame, name) => {
      seen.push(frame); return frame !== wf && name === 'command';
    } });
    const childRow = store.findChildByParent(wf, 'delivered')!;
    assert.deepEqual(result.orders.map(o => [o.workflow, o.step]), [[childRow.id, 'command']]);
    assert.deepEqual(seen, [childRow.id]);
  } finally { store.close(); }
});

test('a nonboolean or asynchronous command predicate cannot create a claim', () => {
  for (const predicate of [() => 'yes', async () => true]) {
    const { engine, store } = fixture();
    try {
      const wf = engine.createInstance('command-lane');
      assert.throws(() => engine.tick(wf, { capabilities: ['unbound'],
        commandClaims: predicate as unknown as (workflow: string, step: string) => boolean }), /synchronous boolean/);
      assert.equal(store.listRuns(wf).length, 0);
      assert.deepEqual(engine.tick(wf, { capabilities: ['unbound'], commandClaims: () => true }).orders.map(o => o.step), ['command']);
    } finally { store.close(); }
  }
});
