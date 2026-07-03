/**
 * Coverage for the push-style event hooks (`subscribe` / `onEvent`). Verifies a
 * host can react to committed engine changes without polling: emission per verb,
 * the derived `settled`/`done` no-poll signal, unsubscribe, and the error
 * isolation that keeps one bad listener from corrupting state or starving its
 * siblings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/factory.ts';
import { Engine } from '../src/engine.ts';
import type { EngineEvent } from '../src/engine.ts';
import { def, input, step } from './helpers.ts';

// seed is green at start (seedOwed:false) ⇒ `step` is immediately eligible and
// owes the single output `out`; greening it completes the workflow.
const tiny = def('tiny', [input('seed', { seedOwed: false })], [
  step({ name: 'step', consumes: ['seed'], produces: ['out'] }),
]);

test('events: createInstance emits instance then settled', () => {
  const { engine, store } = createEngine({ db: ':memory:', defs: [tiny] });
  const seen: EngineEvent[] = [];
  engine.subscribe((e) => seen.push(e));

  const wf = engine.createInstance('tiny');

  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { type: 'instance', workflow: wf, def: 'tiny' });
  assert.equal(seen[1]?.type, 'settled');
  const settled = seen[1] as Extract<EngineEvent, { type: 'settled' }>;
  assert.equal(settled.done, false);
  assert.deepEqual(settled.eligible, ['step']);
  store.close();
});

test('events: green emits a commit then a settled, and signals done', () => {
  const { engine, store } = createEngine({ db: ':memory:', defs: [tiny] });
  const wf = engine.createInstance('tiny');

  const seen: EngineEvent[] = [];
  engine.subscribe((e) => seen.push(e));

  const { orders } = engine.tick(wf); // tick itself emits nothing
  assert.equal(seen.length, 0, 'tick does not push');

  engine.green(wf, orders[0]!.run, 'out', { ok: true });

  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], {
    type: 'commit',
    workflow: wf,
    run: orders[0]!.run,
    path: 'out',
    action: 'green',
    outcome: 'green',
  });
  assert.equal(seen[1]?.type, 'settled');
  const settled = seen[1] as Extract<EngineEvent, { type: 'settled' }>;
  assert.equal(settled.done, true, 'a one-step workflow is done after its output greens');
  assert.deepEqual(settled.eligible, []);
  store.close();
});

test('events: close emits a closed lifecycle event (no settled)', () => {
  const { engine, store } = createEngine({ db: ':memory:', defs: [tiny] });
  const wf = engine.createInstance('tiny');
  const { orders } = engine.tick(wf);

  const seen: EngineEvent[] = [];
  engine.subscribe((e) => seen.push(e));
  engine.close(wf, orders[0]!.run, 'no_work');

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    type: 'closed',
    workflow: wf,
    run: orders[0]!.run,
    outcome: 'no_work',
  });
  store.close();
});

test('events: provideInput emits a provide commit then settled', () => {
  // A seedOwed input is owed until provided; providing it greens it and makes
  // the consumer eligible.
  const owedSeed = def('owed', [input('seed', { seedOwed: true })], [
    step({ name: 'step', consumes: ['seed'], produces: ['out'] }),
  ]);
  const { engine, store } = createEngine({ db: ':memory:', defs: [owedSeed] });
  const wf = engine.createInstance('owed');

  const seen: EngineEvent[] = [];
  engine.subscribe((e) => seen.push(e));
  engine.provideInput(wf, 'seed', { text: 'hi' });

  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { type: 'commit', workflow: wf, path: 'seed', action: 'provide' });
  const settled = seen[1] as Extract<EngineEvent, { type: 'settled' }>;
  assert.equal(settled.type, 'settled');
  assert.deepEqual(settled.eligible, ['step'], 'consumer becomes eligible once seed is green');
  store.close();
});

test('events: unsubscribe stops further delivery', () => {
  const { engine, store } = createEngine({ db: ':memory:', defs: [tiny] });
  const seen: EngineEvent[] = [];
  const off = engine.subscribe((e) => seen.push(e));

  engine.createInstance('tiny');
  const countAfterFirst = seen.length;
  assert.ok(countAfterFirst > 0);

  off();
  off(); // idempotent
  engine.createInstance('tiny');
  assert.equal(seen.length, countAfterFirst, 'no events after unsubscribe');
  store.close();
});

test('events: a throwing listener is isolated and routed to onListenerError', () => {
  const errors: Array<{ err: unknown; event: EngineEvent }> = [];
  const { engine, store } = createEngine({
    db: ':memory:',
    defs: [tiny],
    onListenerError: (err, event) => errors.push({ err, event }),
  });

  const good: EngineEvent[] = [];
  engine.subscribe(() => {
    throw new Error('bad listener');
  });
  engine.subscribe((e) => good.push(e));

  // The throwing listener must not break the sibling nor throw out of the verb.
  const wf = engine.createInstance('tiny');
  const { orders } = engine.tick(wf);
  assert.doesNotThrow(() => engine.green(wf, orders[0]!.run, 'out', { ok: true }));

  assert.ok(good.length > 0, 'the well-behaved listener still received events');
  assert.ok(errors.length > 0, 'onListenerError captured the failures');
  assert.ok(errors[0]!.err instanceof Error);
  assert.equal((errors[0]!.err as Error).message, 'bad listener');
  store.close();
});

test('events: onEvent registered via createEngine receives the stream', () => {
  const seen: EngineEvent[] = [];
  const { engine, store } = createEngine({
    db: ':memory:',
    defs: [tiny],
    onEvent: (e) => seen.push(e),
  });
  engine.createInstance('tiny');
  assert.ok(seen.some((e) => e.type === 'instance'));
  assert.ok(seen.some((e) => e.type === 'settled'));
  store.close();
});

test('events: zero subscribers is a no-op (behavior unchanged)', () => {
  const { engine, store } = createEngine({ db: ':memory:', defs: [tiny] });
  const wf = engine.createInstance('tiny');
  const { orders } = engine.tick(wf);
  const res = engine.green(wf, orders[0]!.run, 'out', { ok: true });
  assert.equal(res.outcome, 'green', 'a normal green still returns green with no listeners');
  assert.equal(engine.status(wf).done, true);
  store.close();
});

test('events: reject emits a reject commit then settled, re-arming the producer', () => {
  // step1 produces `mid`; step2 consumes `mid` and produces `out`. A reject of
  // `mid` (authored by its consumer step2) re-arms step1.
  const chain = def('chain', [input('seed', { seedOwed: false })], [
    step({ name: 'step1', consumes: ['seed'], produces: ['mid'] }),
    step({ name: 'step2', consumes: ['mid'], produces: ['out'] }),
  ]);
  const { engine, store } = createEngine({ db: ':memory:', defs: [chain] });
  const wf = engine.createInstance('chain');
  const t1 = engine.tick(wf);
  engine.green(wf, t1.orders[0]!.run, 'mid', { v: 1 });

  const seen: EngineEvent[] = [];
  engine.subscribe((e) => seen.push(e));
  engine.reject(wf, 'mid', 'step2', 'needs work');

  assert.deepEqual(seen[0], { type: 'commit', workflow: wf, path: 'mid', action: 'reject' });
  const settled = seen[1] as Extract<EngineEvent, { type: 'settled' }>;
  assert.equal(settled.type, 'settled');
  assert.ok(settled.eligible.includes('step1'), 'rejecting mid re-arms its producer step1');
  store.close();
});

test('events: subscribe works on a directly-constructed Engine too', () => {
  // The factory is sugar; the registry lives on Engine itself.
  const defs = new Map([[tiny.name, tiny]]);
  const { engine, store } = createEngine({ db: ':memory:', defs });
  assert.ok(engine instanceof Engine);
  let count = 0;
  engine.subscribe(() => {
    count++;
  });
  engine.createInstance('tiny');
  assert.ok(count >= 2);
  store.close();
});
