import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  defaultIsAlive,
  readChildRecords,
  reconcileInFlight,
  removeChildRecord,
  resolveStateDir,
  writeChildRecord,
  type ChildRecord,
} from '../src/proxy/state.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owenwork-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rec = (over: Partial<ChildRecord> = {}): ChildRecord => ({
  workflow: 'wf1',
  run: 'run_11111111',
  pid: 4242,
  spawnedAt: 1000,
  ...over,
});

test('resolveStateDir: override → XDG_STATE_HOME → HOME, else throws', () => {
  assert.equal(resolveStateDir({ HOME: '/h' }, '/explicit'), '/explicit');
  assert.equal(resolveStateDir({ XDG_STATE_HOME: '/xs', HOME: '/h' }), join('/xs', 'owenwork', 'exec'));
  assert.equal(resolveStateDir({ HOME: '/h' }), join('/h', '.local', 'state', 'owenwork', 'exec'));
  assert.throws(() => resolveStateDir({}), /cannot locate a state directory/);
});

test('write then read round-trips a child record', () => {
  writeChildRecord(dir, rec({ def: 'demo', hash: 'abc123', step: 'builder' }));
  const got = readChildRecords(dir);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], rec({ def: 'demo', hash: 'abc123', step: 'builder' }));
});

test('removeChildRecord deletes just that run', () => {
  writeChildRecord(dir, rec({ run: 'run_11111111' }));
  writeChildRecord(dir, rec({ run: 'run_22222222' }));
  removeChildRecord(dir, 'run_11111111');
  assert.deepEqual(readChildRecords(dir).map((r) => r.run).sort(), ['run_22222222']);
});

test('reconcileInFlight keeps live records and reaps dead ones', () => {
  writeChildRecord(dir, rec({ run: 'run_alive000', pid: 1 }));
  writeChildRecord(dir, rec({ run: 'run_dead0000', pid: 2 }));
  const isAlive = (pid: number) => pid === 1;
  const { live, reaped } = reconcileInFlight(dir, isAlive);
  assert.deepEqual(live.map((r) => r.run), ['run_alive000']);
  assert.deepEqual(reaped.map((r) => r.run), ['run_dead0000']);
  // the dead record's file is gone
  assert.deepEqual(readChildRecords(dir).map((r) => r.run), ['run_alive000']);
});

test('reconcileInFlight dedupes by run id (never double-counts capacity)', () => {
  // Two files that both decode to the same run would be pathological; simulate a
  // stray extra file for the same run and assert only one live record returns.
  writeChildRecord(dir, rec({ run: 'run_dup00000', pid: 7 }));
  writeFileSync(join(dir, 'stray.json'), JSON.stringify(rec({ run: 'run_dup00000', pid: 7 })));
  const { live } = reconcileInFlight(dir, () => true);
  assert.equal(live.filter((r) => r.run === 'run_dup00000').length, 1);
});

test('a corrupt record file is skipped, not fatal', () => {
  writeChildRecord(dir, rec({ run: 'run_ok000000' }));
  writeFileSync(join(dir, 'broken.json'), '{ not json');
  assert.deepEqual(readChildRecords(dir).map((r) => r.run), ['run_ok000000']);
});

test('reads of a missing state dir are empty, not an error', () => {
  const missing = join(dir, 'does-not-exist');
  assert.deepEqual(readChildRecords(missing), []);
  assert.deepEqual(reconcileInFlight(missing, () => true), { live: [], reaped: [] });
});

test('defaultIsAlive: this very process is alive; a pathological pid is not', () => {
  assert.equal(defaultIsAlive(process.pid), true);
  assert.equal(defaultIsAlive(-1), false);
  assert.equal(defaultIsAlive(0), false);
});

test('writeChildRecord sanitizes an unsafe run id into a safe filename', () => {
  writeChildRecord(dir, rec({ run: '../escape' }));
  // the path separator is neutralized so the file lands inside dir, not one
  // level up; dots are kept (a dotted basename never traverses on its own).
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^\.\._escape\.json$/);
  assert.doesNotMatch(files[0]!, /\//); // no separator survived
  // and it still round-trips by its real run id
  assert.equal(readChildRecords(dir)[0]!.run, '../escape');
  removeChildRecord(dir, '../escape');
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.json')), []);
});
