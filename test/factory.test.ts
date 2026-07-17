/**
 * Unit coverage for `createEngine` — the embedding convenience factory.
 * Confirms the wiring (store + def resolution) an in-process host relies on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/factory.ts';
import { DefError } from '../src/defs.ts';
import type { WorkflowDef } from '../src/types.ts';
import { def, input, step } from './helpers.ts';

const EXAMPLES = join(import.meta.dirname, '..', 'examples', 'workflows');

const tiny = def('tiny', [input('seed', { seedOwed: false })], [
  step({ name: 'step', consumes: ['seed'], produces: ['out'] }),
]);

test('createEngine: drives an instance from in-memory defs (array)', () => {
  const { engine, store, defs } = createEngine({ db: ':memory:', defs: [tiny] });
  assert.ok(defs.has('tiny'));

  const wf = engine.createInstance('tiny');
  const { orders } = engine.tick(wf);
  assert.equal(orders.length, 1);
  assert.equal(orders[0]?.step, 'step');
  assert.deepEqual(orders[0]?.owes.map((o) => o.path), ['out']);

  const res = engine.green(wf, orders[0]!.run, 'out', { ok: true });
  assert.equal(res.outcome, 'green');
  store.close();
});

test('createEngine: accepts a defs Map as well as an array (returns a validated copy)', () => {
  const byName = new Map([[tiny.name, tiny]]);
  const { engine, store, defs } = createEngine({ db: ':memory:', defs: byName });
  // REL-4: the returned map is a validated copy, NOT the caller's Map object.
  // The resolver closes over this copy, so mutating `byName` after construction
  // can no longer silently change resolution — that hole was part of REL-4.
  assert.notEqual(defs, byName);
  assert.deepEqual([...defs.keys()], ['tiny']);
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
  const base = mkdtempSync(join(tmpdir(), 'owenloop-factory-'));
  const dbPath = join(base, 'nested', 'deep', 'state.db');
  const { engine, store } = createEngine({ db: dbPath, defs: [tiny] });
  assert.ok(existsSync(dbPath), 'db file (and its parent dirs) were created');
  // and it is a working engine
  const wf = engine.createInstance('tiny');
  assert.ok(wf.startsWith('wf_'));
  store.close();
});

test('SEC-3: createEngine with the default db path refuses a symlinked `.owenloop`; explicit db opens fine', () => {
  // Default path is relative `.owenloop/state.db`, resolved against cwd — so a
  // hostile checkout's symlinked `.owenloop` would redirect the store file.
  const hostile = mkdtempSync(join(tmpdir(), 'owenloop-factory-hostile-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'owenloop-factory-elsewhere-'));
  symlinkSync(elsewhere, join(hostile, '.owenloop'));

  const prevCwd = process.cwd();
  process.chdir(hostile);
  try {
    assert.throws(
      () => createEngine({ defs: [tiny] }), // no db opt → built-in default
      /refusing to write under .*symbolic link/,
    );
    assert.deepEqual(readdirSync(elsewhere), [], 'the symlink target gained no state.db');
  } finally {
    process.chdir(prevCwd);
  }

  // The same symlink layout is irrelevant when the caller supplies an explicit
  // db under a plain dir — the guard is default-path only, so it opens normally.
  const realDb = join(mkdtempSync(join(tmpdir(), 'owenloop-factory-real-')), 'state.db');
  const { store } = createEngine({ db: realDb, defs: [tiny] });
  assert.ok(existsSync(realDb), 'explicit db path opened normally despite a hostile-looking cwd elsewhere');
  store.close();
});

test('SEC-3: createEngine with the default db path refuses a symlinked `state.db` inside a real `.owenloop`; target untouched', () => {
  // A REAL `.owenloop/` directory (so the parent-dir guard passes) but the
  // db FILE is a symlink to a file elsewhere — opening it would follow the link.
  const hostile = mkdtempSync(join(tmpdir(), 'owenloop-factory-dbsym-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'owenloop-factory-dbtarget-'));
  const target = join(elsewhere, 'evil.db');
  writeFileSync(target, 'original');
  mkdirSync(join(hostile, '.owenloop'));
  symlinkSync(target, join(hostile, '.owenloop', 'state.db'));

  const prevCwd = process.cwd();
  process.chdir(hostile);
  try {
    assert.throws(
      () => createEngine({ defs: [tiny] }),
      /refusing to write to .*state\.db: it is a symbolic link/,
    );
    assert.equal(readFileSync(target, 'utf8'), 'original', 'the symlink target was not written through');
  } finally {
    process.chdir(prevCwd);
  }
});

test('SEC-3: createEngine refuses a DANGLING `state.db` symlink and does not create the target', () => {
  const hostile = mkdtempSync(join(tmpdir(), 'owenloop-factory-dangling-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'owenloop-factory-danglingtgt-'));
  const target = join(elsewhere, 'not-yet.db'); // does not exist
  mkdirSync(join(hostile, '.owenloop'));
  symlinkSync(target, join(hostile, '.owenloop', 'state.db'));

  const prevCwd = process.cwd();
  process.chdir(hostile);
  try {
    assert.throws(
      () => createEngine({ defs: [tiny] }),
      /refusing to write to .*state\.db: it is a symbolic link/,
    );
    assert.equal(existsSync(target), false, 'the dangling symlink target was not created');
  } finally {
    process.chdir(prevCwd);
  }
});

test('SEC-3: createEngine refuses a symlinked WAL sidecar even when `state.db` is absent', () => {
  // WAL/journal sidecars follow file symlinks too (node:sqlite passes no
  // SQLITE_OPEN_NOFOLLOW), so a symlinked `state.db-wal` redirects writes.
  const hostile = mkdtempSync(join(tmpdir(), 'owenloop-factory-wal-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'owenloop-factory-waltgt-'));
  const target = join(elsewhere, 'evil.db-wal');
  writeFileSync(target, 'original-wal');
  mkdirSync(join(hostile, '.owenloop'));
  symlinkSync(target, join(hostile, '.owenloop', 'state.db-wal'));

  const prevCwd = process.cwd();
  process.chdir(hostile);
  try {
    assert.throws(
      () => createEngine({ defs: [tiny] }),
      /refusing to write to .*state\.db-wal: it is a symbolic link/,
    );
    assert.equal(readFileSync(target, 'utf8'), 'original-wal', 'the WAL symlink target was not written through');
  } finally {
    process.chdir(prevCwd);
  }
});

test('SEC-3: createEngine opens normally in a real `.owenloop` with no pre-existing db (happy path intact)', () => {
  const clean = mkdtempSync(join(tmpdir(), 'owenloop-factory-clean-'));
  mkdirSync(join(clean, '.owenloop'));

  const prevCwd = process.cwd();
  process.chdir(clean);
  try {
    const { engine, store } = createEngine({ defs: [tiny] });
    assert.ok(existsSync(join(clean, '.owenloop', 'state.db')), 'default db created on the happy path');
    const wf = engine.createInstance('tiny');
    assert.ok(wf.startsWith('wf_'));
    store.close();
  } finally {
    process.chdir(prevCwd);
  }
});

test('SEC-3: an explicit db pointing AT a symlink still opens (override keeps current behavior)', () => {
  // Operator intent: an explicit `db` bypasses the file guard, same carve-out
  // the directory guard already makes for explicit paths.
  const elsewhere = mkdtempSync(join(tmpdir(), 'owenloop-factory-exptgt-'));
  const realDb = join(elsewhere, 'real.db');
  const linkDir = mkdtempSync(join(tmpdir(), 'owenloop-factory-explink-'));
  const linkDb = join(linkDir, 'state.db');
  symlinkSync(realDb, linkDb);

  const { store } = createEngine({ db: linkDb, defs: [tiny] });
  assert.ok(existsSync(realDb), 'explicit db symlink was followed (override behavior preserved)');
  store.close();
});

// ---- REL-4: createEngine validates the WHOLE in-memory def set --------------
//
// createEngine({ defs }) used to register caller-built defs with NO cross-def
// validation — the filesystem loader's calls-cycle / calls-target checks were
// bypassed, so a self- or cross-calling def could be registered and then blow
// the deep-tick recursion. These tests assert the factory now runs the same
// `finalizeDefs` validation the loader does, on every in-memory construction.

/** A def with a single `calls: target` step producing (and outputting) `out`. */
function caller(name: string, target: string): WorkflowDef {
  return {
    ...def(name, [], [
      { ...step({ name: 'call', produces: ['out'] }), calls: target, callsInputs: {}, consumes: [] },
    ]),
    outputs: ['out'],
  };
}

test('createEngine: REL-4 in-memory self-calling def is rejected at construction', () => {
  assert.throws(
    () => createEngine({ db: ':memory:', defs: [caller('loopy', 'loopy')] }),
    (err: unknown) => {
      assert.ok(err instanceof DefError, `expected DefError, got ${String(err)}`);
      assert.match(err.message, /calls cycle: loopy -> loopy/);
      return true;
    },
  );
});

test('createEngine: REL-4 in-memory cross-def calls cycle is rejected at construction', () => {
  assert.throws(
    () => createEngine({ db: ':memory:', defs: [caller('a', 'b'), caller('b', 'a')] }),
    (err: unknown) => {
      assert.ok(err instanceof DefError, `expected DefError, got ${String(err)}`);
      assert.match(err.message, /calls cycle:/);
      return true;
    },
  );
});

test('createEngine: REL-4 in-memory calls target that does not exist is rejected at construction', () => {
  assert.throws(
    () => createEngine({ db: ':memory:', defs: [caller('a', 'ghost')] }),
    (err: unknown) => {
      assert.ok(err instanceof DefError, `expected DefError, got ${String(err)}`);
      assert.match(err.message, /calls names workflow 'ghost' which does not exist/);
      return true;
    },
  );
});

test('createEngine: REL-4 a valid composed in-memory set still constructs and drives (no regression)', () => {
  const child: WorkflowDef = {
    ...def('childOk', [input('data', { seedOwed: true })], [
      step({ name: 'worker', consumes: ['data'], produces: ['result'] }),
    ]),
    outputs: ['result'],
  };
  const parent: WorkflowDef = def('parentOk', [input('proposal', { seedOwed: true })], [
    step({ name: 'provision', consumes: ['proposal'], produces: ['sandbox'] }),
    { ...step({ name: 'deliver', produces: ['delivered'] }), calls: 'childOk', callsInputs: { data: 'sandbox' }, consumes: [] },
    step({ name: 'teardown', consumes: ['delivered'], produces: ['done'], terminal: true }),
  ]);

  const { engine, store } = createEngine({ db: ':memory:', defs: [child, parent] });
  const wf = engine.createInstance('parentOk', { provide: { proposal: { text: 'x' } } });

  // provision fires, and greening its output lets maintainCalls spawn the child.
  const t1 = engine.tick(wf);
  const prov = t1.orders.find((o) => o.step === 'provision');
  assert.ok(prov, 'provision order emitted');
  engine.green(wf, prov!.run, 'sandbox', { env: 'e' });
  engine.close(wf, prov!.run);

  engine.tick(wf); // deep tick — maintainCalls spawns the childOk instance
  assert.ok(store.findChildByParent(wf, 'delivered'), 'composed child was spawned — composition intact');
  store.close();
});
