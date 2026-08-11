import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  defaultIsAlive,
  finalizeChildReservation,
  readChildRecords,
  readChildReservations,
  reconcileInFlight,
  removeChildRecord,
  reserveChild,
  resolveStateDir,
  startReservedChild,
  ShiftStateRecordError,
  writeChildRecord,
  type ChildRecord,
} from '../src/shift/state.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owenloop-state-'));
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
  assert.equal(resolveStateDir({ XDG_STATE_HOME: '/xs', HOME: '/h' }), join('/xs', 'owenloop', 'exec'));
  assert.equal(resolveStateDir({ HOME: '/h' }), join('/h', '.local', 'state', 'owenloop', 'exec'));
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

test('removeChildRecord cancels and removes a still-gated reservation', () => {
  const reserved = reserveChild(dir, {
    workflow: 'wf1',
    run: 'run_ended_while_reserved',
    reservedAt: 1000,
    childKind: 'agent-run',
    step: 'builder',
  });

  removeChildRecord(dir, reserved.reservation.run);

  assert.equal(existsSync(reserved.gatePath), false);
  assert.deepEqual(readChildReservations(dir), []);
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

test('a canonical pathname that does not match the record run fails closed', () => {
  const broken = join(dir, 'stray.json');
  writeChildRecord(dir, rec({ run: 'run_dup00000', pid: 7 }));
  writeFileSync(broken, JSON.stringify(rec({ run: 'run_dup00000', pid: 7 })));

  assert.throws(
    () => reconcileInFlight(dir, () => true),
    (error: unknown) =>
      error instanceof ShiftStateRecordError
      && error.path === broken
      && error.message.includes('pathname does not match its run identity')
      && error.message.includes('dispatch is disabled')
      && error.message.includes('verifying that no child still owns the slot'),
  );
});

test('malformed child kind and optional fields fail closed instead of weakening capacity accounting', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['kind', { kind: 'other' }],
    ['def', { def: 7 }],
    ['hash', { hash: false }],
    ['step', { step: ['builder'] }],
    ['spawned-at', { spawnedAt: -1 }],
  ];

  for (const [suffix, fields] of cases) {
    const run = `run_bad_${suffix}`;
    const broken = join(dir, `${run}.json`);
    writeFileSync(broken, JSON.stringify({ ...rec({ run }), ...fields }));
    assert.throws(
      () => reconcileInFlight(dir, () => true),
      (error: unknown) =>
	      error instanceof ShiftStateRecordError
	      && error.path === broken
	      && error.message.includes('canonical child fields are malformed')
	      && error.message.includes('dispatch is disabled'),
    );
    rmSync(broken);
  }
});

test('a malformed child start-gate token fails closed at the canonical record', () => {
  const run = 'run_bad_gate';
  const broken = join(dir, `${run}.json`);
  writeFileSync(broken, JSON.stringify({ ...rec({ run }), gateToken: 'not-a-token' }));

  assert.throws(
    () => reconcileInFlight(dir, () => true),
    (error: unknown) =>
      error instanceof ShiftStateRecordError
      && error.path === broken
      && error.message.includes('canonical child fields are malformed')
      && error.message.includes('dispatch is disabled'),
  );
});

test('an unknown state record type fails closed instead of being treated as a child', () => {
  const run = 'run_bad_type';
  const broken = join(dir, `${run}.json`);
  writeFileSync(broken, JSON.stringify({ ...rec({ run }), recordType: 'other' }));

  assert.throws(
    () => reconcileInFlight(dir, () => true),
    (error: unknown) =>
      error instanceof ShiftStateRecordError
      && error.path === broken
      && error.message.includes('canonical child fields are malformed')
      && error.message.includes('dispatch is disabled'),
  );
});

test('malformed reservation fields fail closed at the canonical record', () => {
  for (const [suffix, fields] of [
    ['step', { step: 7 }],
    ['reserved-at', { reservedAt: -1 }],
  ] as const) {
    const run = `run_bad_reservation_${suffix}`;
    const broken = join(dir, `${run}.json`);
    writeFileSync(broken, JSON.stringify({
      recordType: 'reservation',
      workflow: 'wf1',
      run,
      reservedAt: 1000,
      token: 'a'.repeat(32),
      childKind: 'exec',
      ...fields,
    }));

    assert.throws(
      () => reconcileInFlight(dir, () => true),
      (error: unknown) =>
	      error instanceof ShiftStateRecordError
	      && error.path === broken
	      && error.message.includes('canonical reservation fields are malformed')
	      && error.message.includes('dispatch is disabled'),
    );
    rmSync(broken);
  }
});

test('empty workflow or run identity fails closed', () => {
  const cases: Array<[string, ChildRecord]> = [
    ['empty-workflow.json', rec({ workflow: '', run: 'empty-workflow' })],
    ['.json', rec({ run: '' })],
  ];

  for (const [name, record] of cases) {
    const broken = join(dir, name);
    writeFileSync(broken, JSON.stringify(record));
    assert.throws(
      () => reconcileInFlight(dir, () => true),
      (error: unknown) =>
	      error instanceof ShiftStateRecordError
	      && error.path === broken
	      && error.message.includes('missing workflow or run identity')
	      && error.message.includes('dispatch is disabled'),
    );
    rmSync(broken);
  }
});

test('a truncated canonical record fails closed with its exact repair path', () => {
  const broken = join(dir, 'broken.json');
  writeChildRecord(dir, rec({ run: 'run_ok000000' }));
  writeFileSync(broken, '{ not json');

  assert.throws(
    () => readChildRecords(dir),
    (error: unknown) =>
      error instanceof ShiftStateRecordError
      && error.path === broken
      && error.message.includes('truncated or is not valid JSON')
      && error.message.includes('dispatch is disabled')
      && error.message.includes('verifying that no child still owns the slot'),
  );
});

test('an unreadable canonical record fails closed with its exact repair path', () => {
  const broken = join(dir, 'broken.json');
  mkdirSync(broken);

  assert.throws(
    () => reconcileInFlight(dir, () => true),
    (error: unknown) =>
      error instanceof ShiftStateRecordError
      && error.path === broken
      && error.message.includes('canonical record is unreadable')
      && error.message.includes('dispatch is disabled')
      && error.message.includes('repaired or removed'),
  );
});

test('reads of a missing state dir are empty, not an error', () => {
  const missing = join(dir, 'does-not-exist');
  assert.deepEqual(readChildRecords(missing), []);
  assert.deepEqual(reconcileInFlight(missing, () => true), {
    live: [],
    reserved: [],
    reaped: [],
    abandoned: [],
  });
});

test('reserveChild creates a closed gate and a capacity-bearing reservation before spawn', () => {
  const reserved = reserveChild(dir, {
    workflow: 'wf1',
    run: 'run_reserved',
    reservedAt: 1000,
    childKind: 'agent-run',
    step: 'builder',
  });

  assert.equal(readFileSync(reserved.gatePath, 'utf8'), 'wait\n');
  assert.deepEqual(readChildReservations(dir), [reserved.reservation]);
  assert.deepEqual(readChildRecords(dir), []);
});

test('reserveChild exclusively deduplicates the same run and removes the losing gate', () => {
  reserveChild(dir, {
    workflow: 'wf1',
    run: 'run_same',
    reservedAt: 1000,
    childKind: 'exec',
  });

  assert.throws(() => reserveChild(dir, {
    workflow: 'wf1',
    run: 'run_same',
    reservedAt: 1001,
    childKind: 'exec',
  }), /EEXIST/u);
  assert.equal(readdirSync(dir).filter((name) => name.endsWith('.gate')).length, 1);
  assert.equal(readChildReservations(dir).length, 1);
});

test('a restart finishes a PID-persisted start-gate handoff and settles the child record', () => {
  const reserved = reserveChild(dir, {
    workflow: 'wf1',
    run: 'run_handoff',
    reservedAt: 1000,
    childKind: 'agent-run',
    step: 'builder',
  });
  const child = finalizeChildReservation(dir, reserved.reservation, {
    pid: 4242,
    spawnedAt: 1100,
    kind: 'agent-run',
    step: 'builder',
  });

  assert.equal(readChildRecords(dir)[0]?.gateToken, reserved.reservation.token);
  startReservedChild(dir, child);
  assert.equal(readFileSync(reserved.gatePath, 'utf8'), 'start\n');

  const reconciled = reconcileInFlight(dir, { isAlive: () => true, now: 1200 });
  assert.equal(reconciled.live.length, 1);
  assert.equal(reconciled.live[0]?.gateToken, undefined);
  assert.equal(readChildRecords(dir)[0]?.gateToken, undefined);
});

test('fresh reservations survive restart and expired reservations are cancelled with diagnostics data', () => {
  const fresh = reserveChild(dir, {
    workflow: 'wf1',
    run: 'run_fresh',
    reservedAt: 1000,
    childKind: 'exec',
  });
  const expired = reserveChild(dir, {
    workflow: 'wf1',
    run: 'run_expired',
    reservedAt: 0,
    childKind: 'agent-run',
  });

  const reconciled = reconcileInFlight(dir, {
    isAlive: () => true,
    now: 1050,
    reservationMaxAgeMs: 100,
  });

  assert.deepEqual(reconciled.reserved.map((reservation) => reservation.run), ['run_fresh']);
  assert.deepEqual(reconciled.abandoned.map((reservation) => reservation.run), ['run_expired']);
  assert.equal(existsSync(fresh.gatePath), true);
  assert.equal(existsSync(expired.gatePath), false);
  assert.deepEqual(readChildReservations(dir).map((reservation) => reservation.run), ['run_fresh']);
});

test('a reservation whose worker removed the timed-out gate is cancelled despite a fresh wall-clock age', () => {
  const timedOut = reserveChild(dir, {
    workflow: 'wf1',
    run: 'run_gate_timed_out',
    reservedAt: 1_000,
    childKind: 'exec',
  });
  rmSync(timedOut.gatePath);

  const reconciled = reconcileInFlight(dir, {
    isAlive: () => true,
    now: 1_050,
    reservationMaxAgeMs: 10_000,
  });

  assert.deepEqual(reconciled.reserved, []);
  assert.deepEqual(reconciled.abandoned.map((reservation) => reservation.run), ['run_gate_timed_out']);
  assert.deepEqual(readChildReservations(dir), []);
});

test('a future reservation timestamp after wall-clock rollback is cancelled instead of extending capacity', () => {
  const future = reserveChild(dir, {
    workflow: 'wf1',
    run: 'run_future',
    reservedAt: 2_000,
    childKind: 'exec',
  });

  const reconciled = reconcileInFlight(dir, {
    isAlive: () => true,
    now: 1_000,
    reservationMaxAgeMs: 10_000,
  });

  assert.deepEqual(reconciled.reserved, []);
  assert.deepEqual(reconciled.abandoned.map((reservation) => reservation.run), ['run_future']);
  assert.equal(existsSync(future.gatePath), false);
  assert.deepEqual(readChildReservations(dir), []);
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
