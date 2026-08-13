/**
 * Unit coverage for the shift's on-disk logging: the retention gate, the sweep,
 * the JSON Lines sink, and the spawn plan's log destination.
 *
 * The gate (`isShiftLogReapable`) and the resolvers are PURE, so they are driven
 * as truth tables with no filesystem. The sweep and the sink are exercised both
 * with injected seams (deterministic, including failure paths a real filesystem
 * will not reproduce on demand) and against a real temp directory, because the
 * whole point of this feature is bytes that survive on a real disk.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  DEFAULT_SHIFT_LOG_MAX_AGE_MS,
  SHIFT_LOG_NAME,
  isShiftLogReapable,
  isWorkerLogName,
  resolveShiftLogDir,
  resolveShiftLogMaxAgeMs,
  runLogFile,
  shiftLogFile,
  sweepShiftLogs,
} from '../src/shift/logretention.ts';
import { createShiftLogSink } from '../src/shift/logsink.ts';
import { buildSpawnPlan } from '../src/shift/spawn.ts';
import {
  MAX_RESPONSE_LINE_BYTES,
  RESPONSE_TRUNCATION_MARKER,
  stampShiftEvent,
  type ShiftEvent,
  type ShiftEventBody,
} from '../src/shift/protocol.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-shift-logs-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function ev(body: ShiftEventBody): ShiftEvent {
  return stampShiftEvent(body, { name: 'box', id: 'shf_test' }, 1_700_000_000_000);
}

const DAY = 24 * 60 * 60 * 1000;

// ── the pure gate ──────────────────────────────────────────────────────────

test('isShiftLogReapable is the documented truth table', () => {
  const base = { name: 'run_abc.log', now: 100 * DAY, maxAgeMs: 14 * DAY };

  // in flight → never, at any age. This is the orphaned-inode case: a live
  // worker holds a descriptor, and unlinking would keep costing disk for bytes
  // nobody can read.
  assert.equal(isShiftLogReapable({ ...base, mtimeMs: 0, hasRunRecord: true }), false);
  assert.equal(isShiftLogReapable({ ...base, mtimeMs: base.now, hasRunRecord: true }), false);

  // completed but recent → keep; this is the postmortem someone will want.
  assert.equal(isShiftLogReapable({ ...base, mtimeMs: base.now - 1, hasRunRecord: false }), false);
  assert.equal(
    isShiftLogReapable({ ...base, mtimeMs: base.now - 14 * DAY + 1, hasRunRecord: false }),
    false,
  );

  // completed and at/over the age → reap. The boundary is inclusive (`>=`).
  assert.equal(isShiftLogReapable({ ...base, mtimeMs: base.now - 14 * DAY, hasRunRecord: false }), true);
  assert.equal(isShiftLogReapable({ ...base, mtimeMs: 0, hasRunRecord: false }), true);
});

test('isShiftLogReapable never reaps a file the sweep does not own', () => {
  const old = { mtimeMs: 0, hasRunRecord: false, now: 100 * DAY, maxAgeMs: 0 };
  // maxAgeMs 0 + mtime 0 means "as reapable as a file can be"; only the NAME
  // saves each of these. The log dir defaults to the state dir, which holds all
  // of them.
  for (const name of [
    SHIFT_LOG_NAME,
    'shift.sock',
    '.dispatch.lock',
    'run_abc.json',
    'run_abc.log.tmp',
    'notes.log',
    'run_.log',
    'RUN_abc.log',
    'run_abc/../../etc/passwd.log',
  ]) {
    assert.equal(isShiftLogReapable({ ...old, name }), false, `must not reap ${name}`);
  }
  assert.equal(isShiftLogReapable({ ...old, name: 'run_abc.log' }), true);
});

test('isWorkerLogName accepts exactly the names state.ts can produce', () => {
  assert.equal(isWorkerLogName('run_7b29d1845b2926eba5dbc574.log'), true);
  assert.equal(isWorkerLogName('run_a-b_c.1.log'), true);
  assert.equal(isWorkerLogName(SHIFT_LOG_NAME), false);
  assert.equal(isWorkerLogName('run_abc.json'), false);
  assert.equal(isWorkerLogName('run_abc'), false);
  assert.equal(isWorkerLogName('.log'), false);
});

// ── resolution precedence ──────────────────────────────────────────────────

test('resolveShiftLogDir is --log-dir > env > settings > stateDir', () => {
  const env = { OWENLOOP_SHIFT_LOG_DIR: '/env' };
  assert.equal(resolveShiftLogDir('/flag', env, '/settings', '/state'), '/flag');
  assert.equal(resolveShiftLogDir(undefined, env, '/settings', '/state'), '/env');
  assert.equal(resolveShiftLogDir(undefined, {}, '/settings', '/state'), '/settings');
  assert.equal(resolveShiftLogDir(undefined, {}, undefined, '/state'), '/state');
  // A blank at any level is not a choice, so the next level down still applies.
  assert.equal(resolveShiftLogDir('  ', { OWENLOOP_SHIFT_LOG_DIR: ' ' }, '', '/state'), '/state');
});

test('resolveShiftLogMaxAgeMs is --log-max-age > env > settings > 14 days', () => {
  const env = { OWENLOOP_SHIFT_LOG_MAX_AGE_MS: '5000' };
  assert.equal(resolveShiftLogMaxAgeMs(1, env, 2), 1);
  assert.equal(resolveShiftLogMaxAgeMs(undefined, env, 2), 5000);
  assert.equal(resolveShiftLogMaxAgeMs(undefined, {}, 2), 2);
  assert.equal(resolveShiftLogMaxAgeMs(undefined, {}, undefined), DEFAULT_SHIFT_LOG_MAX_AGE_MS);
  // Zero is a real choice at every level, not an absent one.
  assert.equal(resolveShiftLogMaxAgeMs(0, env, 2), 0);
  assert.equal(resolveShiftLogMaxAgeMs(undefined, { OWENLOOP_SHIFT_LOG_MAX_AGE_MS: '0' }, 2), 0);
});

test('an unparseable OWENLOOP_SHIFT_LOG_MAX_AGE_MS falls through instead of failing', () => {
  // A typo in an environment variable must never stop a shift from serving, so
  // each bad value is IGNORED and the next precedence level applies.
  for (const raw of ['abc', '', '  ', '-1', '1.5', 'Infinity', 'NaN']) {
    assert.equal(
      resolveShiftLogMaxAgeMs(undefined, { OWENLOOP_SHIFT_LOG_MAX_AGE_MS: raw }, 77),
      77,
      `'${raw}' must be ignored`,
    );
  }
});

test('shiftLogFile and runLogFile are pure path math over the same sanitizer', () => {
  assert.equal(shiftLogFile('/logs'), join('/logs', 'shift.log'));
  assert.equal(runLogFile('/logs', 'run_abc'), join('/logs', 'run_abc.log'));
  // The correlation key is the BASENAME. `<run>.log` and `<run>.json` are
  // sanitized by the same `safeRun`, so a traversal attempt cannot land the log
  // outside the log directory or break the pairing. `safeRun` keeps `.` and `-`
  // and replaces every other character, INCLUDING the separator — which is what
  // makes the result a single flat basename rather than a path.
  assert.equal(runLogFile('/logs', '../../etc/passwd'), join('/logs', '.._.._etc_passwd.log'));
  assert.equal(runLogFile('/logs', '/abs/olute').includes('/abs/'), false);
  assert.equal(existsSync('/logs'), false, 'path math must create nothing');
});

// ── the sweep ──────────────────────────────────────────────────────────────

test('sweepShiftLogs removes only completed worker logs past the age', () => {
  const dir = join(root, 'logs');
  const stateDir = join(root, 'state');
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const now = 100 * DAY;
  const write = (name: string, ageMs: number): string => {
    const path = join(dir, name);
    writeFileSync(path, 'x');
    const seconds = (now - ageMs) / 1000;
    utimesSync(path, seconds, seconds);
    return path;
  };

  const oldDone = write('run_old.log', 30 * DAY);
  const freshDone = write('run_fresh.log', 1 * DAY);
  const oldLive = write('run_live.log', 30 * DAY);
  const shiftLog = write(SHIFT_LOG_NAME, 365 * DAY);
  const stranger = write('operator-notes.log', 365 * DAY);
  writeFileSync(join(stateDir, 'run_live.json'), '{}');

  const removed = sweepShiftLogs({ dir, stateDir, now, maxAgeMs: 14 * DAY });

  assert.deepEqual(removed, [oldDone]);
  assert.equal(existsSync(oldDone), false);
  for (const kept of [freshDone, oldLive, shiftLog, stranger]) {
    assert.equal(existsSync(kept), true, `must keep ${kept}`);
  }
});

test('sweepShiftLogs never throws and costs at most the one file that failed', () => {
  const errors: string[] = [];
  const removed = sweepShiftLogs({
    dir: '/logs',
    stateDir: '/state',
    now: 100 * DAY,
    maxAgeMs: 0,
    err: (line) => errors.push(line),
    list: () => ['run_a.log', 'run_b.log', 'run_c.log'],
    mtime: (path) => {
      if (path.endsWith('run_a.log')) throw new Error('stat exploded');
      return 0;
    },
    hasRecord: () => false,
    remove: (path) => {
      if (path.endsWith('run_b.log')) throw new Error('unlink exploded');
    },
  });

  // `run_a` died in stat and `run_b` died in unlink; `run_c` still went.
  assert.deepEqual(removed, [join('/logs', 'run_c.log')]);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((line) => line.includes('(ignored)')), errors.join('\n'));
});

test('sweepShiftLogs reports an unreadable directory and returns empty', () => {
  const errors: string[] = [];
  const removed = sweepShiftLogs({
    dir: '/nope',
    stateDir: '/state',
    now: 0,
    maxAgeMs: 0,
    err: (line) => errors.push(line),
    list: () => { throw new Error('ENOENT'); },
  });
  assert.deepEqual(removed, []);
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.includes('could not scan shift logs'), errors[0]);
});

// ── the spawn plan's log destination ───────────────────────────────────────

test('buildSpawnPlan stays pure and carries the log PATH, never a descriptor', () => {
  const spec = { workflow: 'wf1', run: 'run_1', step: 's', kind: 'exec' as const };
  const withLog = buildSpawnPlan(spec, 'https://hub', 'acct', '/bin/owenloop', '/usr/bin/node', 'shf_1', '/logs');

  assert.equal(withLog.logFile, join('/logs', 'run_1.log'));
  // The PLAN is still the pre-logging shape. Opening the file is I/O, and this
  // function does none: `createDefaultSpawner` substitutes the descriptors.
  assert.deepEqual(withLog.options.stdio, ['ignore', 'ignore', 'ignore']);
  assert.equal(existsSync('/logs'), false, 'building a plan must create nothing');

  // No log dir ⇒ no `logFile` key at all, byte-identical to the old plan.
  const without = buildSpawnPlan(spec, 'https://hub', 'acct', '/bin/owenloop', '/usr/bin/node', 'shf_1');
  assert.equal('logFile' in without, false);
  assert.deepEqual(buildSpawnPlan(spec, 'https://hub', 'acct', '/bin/owenloop', '/usr/bin/node', 'shf_1', ''), without);
});

// ── the JSON Lines sink ────────────────────────────────────────────────────

test('the sink writes one parseable JSON Lines record per event, in order', () => {
  const path = join(root, 'shift.log');
  const sink = createShiftLogSink({ path, err: () => assert.fail('must not report') });

  sink.write(ev({ type: 'parked', origin: 'https://hub', cap: 3, serveCrews: ['alpha'], hostname: 'box', cwd: '/w' }));
  sink.write(ev({ type: 'dispatched', workflow: 'wf1', run: 'run_1', step: 's', kind: 'exec', pid: 42 }));

  const lines = readFileSync(path, 'utf8').split('\n');
  assert.equal(lines.at(-1), '', 'every record must end with its own newline');
  const records = lines.slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.type, 'parked');
  assert.equal(records[1]?.type, 'dispatched');
  // The envelope rides every record, which is what lets a reader with only this
  // file say which shift produced which line and when.
  for (const record of records) {
    assert.equal(record.shift, 'box');
    assert.equal(record.shiftId, 'shf_test');
    assert.equal(record.ts, new Date(1_700_000_000_000).toISOString());
  }
});

test('the sink APPENDS — a second shift reusing the path keeps the first one\'s records', () => {
  const path = join(root, 'shift.log');
  appendFileSync(path, '{"type":"pre-existing"}\n');
  createShiftLogSink({ path, err: () => {} }).write(ev({ type: 'ended' }));
  // A separate sink over the same path is the "restarted shift" case.
  createShiftLogSink({ path, err: () => {} }).write(ev({ type: 'ended' }));

  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal((JSON.parse(lines[0]!) as { type: string }).type, 'pre-existing');
});

test('the sink bounds a record by the same ceiling the socket applies', () => {
  const path = join(root, 'shift.log');
  createShiftLogSink({ path, err: () => assert.fail('must not report') }).write(
    ev({ type: 'failed', workflow: 'wf', run: 'r', step: 's', kind: 'exec', message: '💥'.repeat(200_000) }),
  );

  const raw = readFileSync(path, 'utf8');
  assert.ok(Buffer.byteLength(raw, 'utf8') <= MAX_RESPONSE_LINE_BYTES, `line was ${raw.length} chars`);
  const record = JSON.parse(raw.trimEnd()) as { message: string; type: string; shiftId: string };
  assert.equal(record.type, 'failed', 'the discriminant is protected from truncation');
  assert.equal(record.shiftId, 'shf_test', 'the correlation id is protected from truncation');
  assert.equal(record.message.endsWith(RESPONSE_TRUNCATION_MARKER), true);
});

test('a write failure is reported ONCE and never throws, and writing keeps being attempted', () => {
  const errors: string[] = [];
  let attempts = 0;
  let broken = true;
  const sink = createShiftLogSink({
    path: '/logs/shift.log',
    err: (line) => errors.push(line),
    append: () => {
      attempts += 1;
      if (broken) throw new Error('ENOSPC');
    },
  });

  for (let i = 0; i < 5; i++) sink.write(ev({ type: 'ended' }));
  assert.equal(errors.length, 1, 'a broken sink must not spam one line per event');
  assert.ok(errors[0]?.includes('ENOSPC'), errors[0]);
  assert.equal(attempts, 5, 'the REPORT is latched, not the writing');

  // A transient failure self-heals: the sink was still trying, so it recovers
  // with no restart and no reset call.
  broken = false;
  sink.write(ev({ type: 'ended' }));
  assert.equal(attempts, 6);
  assert.equal(errors.length, 1);
});

test('a real unwritable log directory costs the log, not the process', () => {
  const dir = join(root, 'readonly');
  mkdirSync(dir);
  chmodSync(dir, 0o500);
  const errors: string[] = [];
  const sink = createShiftLogSink({ path: join(dir, 'shift.log'), err: (line) => errors.push(line) });

  // The assertion is the absence of a throw: a shift whose only defect is that
  // it cannot write a log must still dispatch work.
  sink.write(ev({ type: 'ended' }));
  chmodSync(dir, 0o700);

  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.includes('failed'), errors[0]);
  assert.equal(existsSync(join(dir, 'shift.log')), false);
});

test('an unserializable event costs that record only', () => {
  const path = join(root, 'shift.log');
  const errors: string[] = [];
  const sink = createShiftLogSink({ path, err: (line) => errors.push(line) });

  const cyclic = ev({ type: 'ended' }) as unknown as Record<string, unknown>;
  cyclic.self = cyclic;
  sink.write(cyclic as unknown as ShiftEvent);
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.includes('could not serialize'), errors[0]);
  assert.equal(existsSync(path), false, 'a failed serialize must write no partial line');

  sink.write(ev({ type: 'ended' }));
  assert.equal(statSync(path).size > 0, true, 'the next healthy event still lands');
});
