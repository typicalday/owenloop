/**
 * Unit coverage for `createEngine` — the embedding convenience factory.
 * Confirms the wiring (store + def resolution) an in-process host relies on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/factory.ts';
import { def, input, loop } from './helpers.ts';

const EXAMPLES = join(import.meta.dirname, '..', 'examples', 'workflows');

const tiny = def('tiny', [input('seed', { seedOwed: false })], [
  loop({ name: 'step', consumes: ['seed'], produces: ['out'] }),
]);

test('createEngine: drives an instance from in-memory defs (array)', () => {
  const { engine, store, defs } = createEngine({ db: ':memory:', defs: [tiny] });
  assert.ok(defs.has('tiny'));

  const wf = engine.createInstance('tiny');
  const { orders } = engine.tick(wf);
  assert.equal(orders.length, 1);
  assert.equal(orders[0]?.loop, 'step');
  assert.deepEqual(orders[0]?.owes.map((o) => o.path), ['out']);

  const res = engine.green(wf, orders[0]!.run, 'out', { ok: true });
  assert.equal(res.outcome, 'green');
  store.close();
});

test('createEngine: accepts a defs Map as well as an array', () => {
  const byName = new Map([[tiny.name, tiny]]);
  const { engine, store, defs } = createEngine({ db: ':memory:', defs: byName });
  assert.equal(defs, byName); // a Map is used as-is
  assert.doesNotThrow(() => engine.createInstance('tiny'));
  store.close();
});

test('createEngine: loads defs from a directory', () => {
  const { engine, store, defs } = createEngine({ db: ':memory:', defsDir: EXAMPLES });
  assert.ok(defs.has('delivery'), 'delivery def loaded from examples/workflows');
  assert.doesNotThrow(() =>
    engine.createInstance('delivery', { provide: { proposal: { text: 'x' } } }),
  );
  store.close();
});

test('createEngine: unknown def throws the documented message', () => {
  const { engine, store } = createEngine({ db: ':memory:', defs: [tiny] });
  assert.throws(() => engine.createInstance('nope'), /unknown workflow definition/);
  store.close();
});

test('createEngine: a missing defsDir yields no defs (lenient, like the CLI)', () => {
  const { defs, store } = createEngine({ db: ':memory:', defsDir: '/no/such/dir/here' });
  assert.equal(defs.size, 0);
  store.close();
});

test('createEngine: a file db path creates parent directories', () => {
  const base = mkdtempSync(join(tmpdir(), 'oweflow-factory-'));
  const dbPath = join(base, 'nested', 'deep', 'state.db');
  const { engine, store } = createEngine({ db: dbPath, defs: [tiny] });
  assert.ok(existsSync(dbPath), 'db file (and its parent dirs) were created');
  // and it is a working engine
  const wf = engine.createInstance('tiny');
  assert.ok(wf.startsWith('wf_'));
  store.close();
});
