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
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  DEFAULT_SHIFT_LOG_MAX_AGE_MS,
  SHIFT_LOG_NAME,
  isShiftLogReapable,
  isWorkerLogName,
  logOwnersDir,
  prepareShiftLogDir,
  readShiftLogOwners,
  registerShiftLogOwner,
  resolveShiftLogDir,
  resolveShiftLogMaxAgeMs,
  runLogFile,
  shiftLogFile,
  sweepShiftLogs,
} from '../src/shift/logretention.ts';
import { createShiftLogSink } from '../src/shift/logsink.ts';
import { reachesSocketConsumer } from '../src/shift/runtime.ts';
import { buildSpawnPlan } from '../src/shift/spawn.ts';
import {
  MAX_RESPONSE_LINE_BYTES,
  RESPONSE_TRUNCATION_MARKER,
  stampShiftEvent,
  type ShiftEvent,
  type ShiftEventBody,
} from '../src/shift/protocol.ts';
import { stripAmbientOwenloopEnv } from './helpers/ambient-env.ts';

let root: string;
let restoreEnv: () => void;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-shift-logs-'));
  // `buildSpawnPlan` builds the child environment as `{...process.env, ...}`, so
  // the plan this file asserts on is a function of the AMBIENT environment. Under
  // an owenloop shift the parent process already carries OWENLOOP_* variables the
  // operator never typed — OWENLOOP_ALLOWED_WORKDIR_ROOTS among them — and the
  // "sets NO variable" assertions below would read the operator's value and fail.
  // CI never sees that, because a clean runner has the namespace unset.
  restoreEnv = stripAmbientOwenloopEnv();
});
afterEach(() => {
  restoreEnv();
  rmSync(root, { recursive: true, force: true });
});

function ev(body: ShiftEventBody): ShiftEvent {
  return stampShiftEvent(body, { name: 'box', id: 'shf_test' }, 1_700_000_000_000);
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * An absolute path that is guaranteed not to exist, INSIDE this test's own temp
 * root.
 *
 * The tests below feed absolute paths to pure path math and to injected-seam
 * calls, then assert that nothing was created. Earlier revisions used the
 * literal `/logs` and `/nope` for that, which made two assumptions about the
 * HOST: that `/logs` does not exist (false on plenty of container images, which
 * would have failed the test for a reason unrelated to this code) and that a
 * real `readdirSync('/logs/.owners')` against the machine root is acceptable —
 * `sweepShiftLogs` calls `readShiftLogOwners` for real unless `stateDirs` is
 * injected.
 *
 * `root` is created fresh by `beforeEach` and removed by `afterEach`, so a path
 * under it is absolute, absent by construction, and absent because THIS TEST
 * says so rather than because the machine happened to agree.
 */
function absent(name: string): string {
  return join(root, 'absent', name);
}

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

test('resolveShiftLogDir returns an ABSOLUTE path at every precedence level', () => {
  // The log directory is the RENDEZVOUS between shift processes that may have
  // been started from different working directories, and `.owners` inside it is
  // read by whichever of them sweeps. Two spellings would be two rendezvous
  // points: a shift started with `--log-dir ./logs` would write its claim under
  // one and a shift started with the absolute path would sweep the other,
  // seeing no claim and unlinking the first shift's live worker logs.
  const cwd = process.cwd();
  assert.equal(resolveShiftLogDir('./logs', {}, undefined, '/state'), join(cwd, 'logs'));
  assert.equal(resolveShiftLogDir(undefined, { OWENLOOP_SHIFT_LOG_DIR: 'logs' }, undefined, '/state'), join(cwd, 'logs'));
  assert.equal(resolveShiftLogDir(undefined, {}, '../logs', '/state'), resolve(cwd, '../logs'));
  assert.equal(resolveShiftLogDir(undefined, {}, undefined, 'state'), join(cwd, 'state'));
  // Spelled as an invariant rather than four equalities: whatever comes back is
  // absolute, whichever level produced it.
  for (const produced of [
    resolveShiftLogDir('./logs', {}, undefined, '/state'),
    resolveShiftLogDir(undefined, { OWENLOOP_SHIFT_LOG_DIR: 'logs' }, undefined, '/state'),
    resolveShiftLogDir(undefined, {}, '../logs', '/state'),
    resolveShiftLogDir(undefined, {}, undefined, 'state'),
  ]) {
    assert.equal(isAbsolute(produced), true, `${produced} must be absolute`);
  }
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
  const logs = absent('logs');
  assert.equal(shiftLogFile(logs), join(logs, 'shift.log'));
  assert.equal(runLogFile(logs, 'run_abc'), join(logs, 'run_abc.log'));
  // The correlation key is the BASENAME. `<run>.log` and `<run>.json` are
  // sanitized by the same `safeRun`, so a traversal attempt cannot land the log
  // outside the log directory or break the pairing. `safeRun` keeps `.` and `-`
  // and replaces every other character, INCLUDING the separator — which is what
  // makes the result a single flat basename rather than a path.
  assert.equal(runLogFile(logs, '../../etc/passwd'), join(logs, '.._.._etc_passwd.log'));
  assert.equal(runLogFile(logs, '/abs/olute').includes('/abs/'), false);
  assert.equal(existsSync(logs), false, 'path math must create nothing');
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
  const dir = absent('logs');
  const removed = sweepShiftLogs({
    dir,
    stateDir: absent('state'),
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
  assert.deepEqual(removed, [join(dir, 'run_c.log')]);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((line) => line.includes('(ignored)')), errors.join('\n'));
});

// ── the sweep across shifts that share one log directory ───────────────────

test('a shift does not reap another shift\'s LIVE worker log from a shared log dir', () => {
  // REGRESSION GUARD. `OWENLOOP_SHIFT_LOG_DIR` is one global setting, so
  // centralizing two crews' logs into one directory while each crew keeps its
  // own state directory is the obvious way to use it. Before the owner registry,
  // crew B's sweep resolved the in-flight gate against only B's OWN state
  // directory: crew A's live `run_alive.log` had no `run_alive.json` anywhere B
  // could see, so B unlinked a log A's live worker still held a descriptor on —
  // the exact orphaned-inode data loss the gate exists to prevent.
  const shared = join(root, 'shared-logs');
  const stateA = join(root, 'state-a');
  const stateB = join(root, 'state-b');
  for (const dir of [shared, stateA, stateB]) mkdirSync(dir, { recursive: true });

  const now = 100 * DAY;
  // Crew A: one LIVE run (record present) and one FINISHED run (record gone).
  // Both logs are given the same age, so the ONLY thing separating their fates
  // is the in-flight record — which lives in crew A's state dir, not B's.
  for (const name of ['run_alive.log', 'run_done.log']) {
    const path = join(shared, name);
    writeFileSync(path, 'a');
    const seconds = (now - 1 * DAY) / 1000;
    utimesSync(path, seconds, seconds);
  }
  writeFileSync(join(stateA, 'run_alive.json'), '{}');
  registerShiftLogOwner(shared, stateA);
  // Crew B sweeps the shared directory with its own, empty state directory.
  registerShiftLogOwner(shared, stateB);

  // maxAge 0 is the aggressive setting `docs/shift-logs.md` calls a real choice
  // on a disk-constrained host, and the setting under which this fired against
  // EVERY live worker of the other shift.
  const removed = sweepShiftLogs({ dir: shared, stateDir: stateB, now, maxAgeMs: 0 });

  assert.equal(
    existsSync(join(shared, 'run_alive.log')),
    true,
    'crew A\'s live worker log must survive crew B\'s sweep',
  );
  // And retention is not merely disabled: the genuinely finished log still goes.
  assert.deepEqual(removed, [join(shared, 'run_done.log')]);
});

test('readShiftLogOwners returns every claimed state dir plus the caller\'s own', () => {
  const shared = join(root, 'owners-logs');
  const stateA = join(root, 'owners-a');
  const stateB = join(root, 'owners-b');
  mkdirSync(shared, { recursive: true });

  assert.deepEqual(
    readShiftLogOwners(shared, stateA),
    [stateA],
    'no registry yet ⇒ exactly the caller\'s own state dir, the pre-registry behaviour',
  );

  registerShiftLogOwner(shared, stateA);
  registerShiftLogOwner(shared, stateB);
  assert.deepEqual(readShiftLogOwners(shared, stateA).sort(), [stateA, stateB].sort());
  // Re-registering is idempotent: one claim per state dir, keyed by its hash.
  registerShiftLogOwner(shared, stateA);
  assert.equal(readShiftLogOwners(shared, stateA).length, 2);
});

test('a corrupt owner claim costs only that claimant, never the sweep', () => {
  const shared = join(root, 'corrupt-logs');
  const own = join(root, 'corrupt-own');
  const foreign = [join(root, 'corrupt-a'), join(root, 'corrupt-b'), join(root, 'corrupt-c')];
  mkdirSync(shared, { recursive: true });
  const claimPath = new Map(foreign.map((stateDir) => [stateDir, registerShiftLogOwner(shared, stateDir)]));

  // Corrupt EACH claim in turn, restoring the others first. Claim filenames are
  // hashes, so `readdirSync` order is not controllable — corrupting only one
  // would leave open the possibility that it happened to be listed last, where
  // an outer try/catch loses nothing. Sweeping the corruption across all three
  // guarantees the first-listed claim is corrupt in at least one round, which is
  // exactly the case an outer guard fails: it would abandon the loop there and
  // return the caller's own state dir alone.
  for (const broken of foreign) {
    for (const [stateDir, path] of claimPath) {
      writeFileSync(path, stateDir === broken ? 'not json{' : `${JSON.stringify({ stateDir })}\n`);
    }
    const intact = foreign.filter((stateDir) => stateDir !== broken);
    assert.deepEqual(
      readShiftLogOwners(shared, own).sort(),
      [own, ...intact].sort(),
      `corrupting ${broken} must cost that claimant only`,
    );
  }

  // A claim that parses but carries no usable `stateDir` is the same story: it
  // tells the sweep nothing, and it tells the sweep nothing about the others too.
  for (const [stateDir, path] of claimPath) writeFileSync(path, `${JSON.stringify({ stateDir })}\n`);
  for (const useless of ['{}', '{"stateDir":""}', '{"stateDir":"   "}', '{"stateDir":42}', '[]', 'null']) {
    writeFileSync(claimPath.get(foreign[0]!)!, useless);
    assert.deepEqual(
      readShiftLogOwners(shared, own).sort(),
      [own, foreign[1]!, foreign[2]!].sort(),
      `claim body ${useless} must be ignored without blinding the sweep`,
    );
  }
});

test('the owner registry round-trips ONE absolute claim per shift, however it was spelled', () => {
  const shared = join(root, 'abs-logs');
  mkdirSync(shared, { recursive: true });
  // A state dir named relative to THIS process's cwd. `resolve()` of it is the
  // same directory under a different spelling — the situation two shifts started
  // from different working directories land in.
  const relative = 'abs-state-rel';
  const absolute = resolve(relative);

  const first = registerShiftLogOwner(shared, relative);
  const second = registerShiftLogOwner(shared, absolute);
  assert.equal(first, second, 'one directory must hash to one claim filename, not one per spelling');
  assert.deepEqual(readdirSync(logOwnersDir(shared)), [basename(first)], 'exactly one claim file');

  // The bytes on disk are what a DIFFERENT process with a DIFFERENT cwd reads
  // and joins `<run>.json` onto, so `docs/shift-logs.md`'s published
  // `{"stateDir":"/abs/path"}` has to be literally true.
  const body: unknown = JSON.parse(readFileSync(first, 'utf8'));
  assert.deepEqual(body, { stateDir: absolute });
  assert.equal(isAbsolute((body as { stateDir: string }).stateDir), true);

  // Both ends resolve, so a claim written by a relative-spelling caller and a
  // reader asking with the relative spelling still agree on one path.
  assert.deepEqual(readShiftLogOwners(shared, relative), [absolute]);
  assert.deepEqual(readShiftLogOwners(shared, absolute), [absolute]);

  // And a claim FILE containing a relative path — written by an older shift, or
  // by hand — is resolved on the way out rather than handed to the sweep as-is.
  writeFileSync(first, `${JSON.stringify({ stateDir: relative })}\n`);
  const other = join(root, 'abs-other');
  assert.deepEqual(readShiftLogOwners(shared, other).sort(), [other, absolute].sort());
});

// ── startup preparation (what `runtime.ts` runs before the first dispatch) ──

/**
 * Write a worker log with a chosen age, so the sweep has something to decide
 * about. Shared by the `prepareShiftLogDir` branch tests.
 */
function agedLog(dir: string, name: string, now: number, ageMs: number): string {
  const path = join(dir, name);
  writeFileSync(path, 'x');
  const seconds = (now - ageMs) / 1000;
  utimesSync(path, seconds, seconds);
  return path;
}

test('prepareShiftLogDir creates, claims and sweeps, and reports what it reaped', () => {
  const dir = join(root, 'prep-logs');
  const stateDir = join(root, 'prep-state');
  mkdirSync(stateDir, { recursive: true });
  const now = 100 * DAY;
  const errors: string[] = [];

  // Two equally old worker logs; only one of them has an in-flight `<run>.json`
  // record in the state directory. That record is the whole gate.
  mkdirSync(dir, { recursive: true });
  const stale = agedLog(dir, 'run_stale.log', now, 30 * DAY);
  const live = agedLog(dir, 'run_live.log', now, 30 * DAY);
  writeFileSync(join(stateDir, 'run_live.json'), '{}');

  const prepared = prepareShiftLogDir({
    flagDir: dir, env: {}, stateDir, now, err: (line) => errors.push(line), label: 'owenloop shift',
  });

  assert.equal(prepared.ready, true);
  assert.equal(prepared.dir, dir);
  assert.equal(prepared.maxAgeMs, DEFAULT_SHIFT_LOG_MAX_AGE_MS);
  assert.deepEqual(prepared.reaped, [stale], 'the completed log aged out; the in-flight one did not');
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(live), true, "a live worker's log must survive its own shift's startup sweep");

  // The claim is written BEFORE the sweep, which is what lets this shift's own
  // records gate its own sweep on its very first startup.
  const claims = readdirSync(logOwnersDir(dir));
  assert.equal(claims.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(logOwnersDir(dir), claims[0]!), 'utf8')), { stateDir });

  assert.deepEqual(errors, [
    `owenloop shift: reaped 1 worker log(s) older than ${String(DEFAULT_SHIFT_LOG_MAX_AGE_MS)}ms from ${dir}`,
  ]);
});

test('prepareShiftLogDir reports and disables logging when the directory cannot be created', () => {
  // The PARENT of the log directory is a regular file, so `mkdirSync` fails
  // ENOTDIR. Chosen over a permission bit because it does not depend on the uid
  // the test runs as — root would sail through a 0o500 directory.
  const blocker = join(root, 'not-a-dir');
  writeFileSync(blocker, 'x');
  const dir = join(blocker, 'logs');
  const errors: string[] = [];

  const prepared = prepareShiftLogDir({
    flagDir: dir, env: {}, stateDir: join(root, 'prep-state-2'), now: 0,
    err: (line) => errors.push(line), label: 'owenloop shift',
  });

  assert.equal(prepared.ready, false, 'ready:false is what tells runtime.ts to build NO sink');
  assert.deepEqual(prepared.reaped, []);
  assert.equal(prepared.dir, dir, 'the resolved path is still reported, so the message can name it');
  assert.equal(prepared.maxAgeMs, DEFAULT_SHIFT_LOG_MAX_AGE_MS);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /^owenloop shift: cannot create shift log directory /);
  assert.match(errors[0]!, /continuing with logging disabled$/);
  // Nothing was created underneath the blocker, and the blocker is untouched.
  assert.equal(readFileSync(blocker, 'utf8'), 'x');
  // NOT `existsSync(logOwnersDir(dir))`. Any path UNDER a regular file is false
  // by construction — `stat()` returns ENOTDIR before it ever reaches the last
  // component — so that assertion is green no matter what `prepareShiftLogDir`
  // does, and it proves nothing. These two can actually fail: the blocker must
  // still be a regular FILE (production code must not unlink it and mkdir over
  // it), and `root` must hold NOTHING but the blocker (a failed create must not
  // silently fall back to some other directory).
  assert.equal(lstatSync(blocker).isFile(), true, 'the blocker must not be replaced by a directory');
  assert.deepEqual(readdirSync(root), ['not-a-dir'], 'a failed create must leave no directory anywhere');
});

test('prepareShiftLogDir keeps dispatching when the claim cannot be written', () => {
  const dir = join(root, 'prep-unclaimable');
  const stateDir = join(root, 'prep-state-3');
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  // `.owners` is a FILE, so `registerShiftLogOwner`'s mkdir fails — again a
  // uid-independent failure rather than a permission bit.
  writeFileSync(logOwnersDir(dir), 'x');
  const now = 100 * DAY;
  const stale = agedLog(dir, 'run_stale.log', now, 30 * DAY);
  const errors: string[] = [];

  const prepared = prepareShiftLogDir({
    flagDir: dir, env: {}, stateDir, now, err: (line) => errors.push(line), label: 'owenloop shift',
  });

  // ready:TRUE. An unclaimable registry costs retention SAFETY, not dispatch.
  assert.equal(prepared.ready, true);
  // And the sweep still ran afterwards — the claim failure did not abort the rest.
  assert.deepEqual(prepared.reaped, [stale]);
  assert.equal(existsSync(stale), false);
  assert.equal(errors.length, 2);
  assert.match(errors[0]!, /^owenloop shift: cannot record this shift's claim on /);
  assert.match(errors[0]!, /may reap this one's worker logs$/);
  assert.match(errors[1]!, /^owenloop shift: reaped 1 worker log\(s\) /);
});

test('prepareShiftLogDir stays silent when there is nothing to reap', () => {
  const dir = join(root, 'prep-quiet');
  const stateDir = join(root, 'prep-state-4');
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const now = 100 * DAY;
  agedLog(dir, 'run_fresh.log', now, 1 * DAY);
  const errors: string[] = [];

  const prepared = prepareShiftLogDir({
    flagDir: dir, env: {}, stateDir, now, err: (line) => errors.push(line), label: 'owenloop shift',
  });

  assert.equal(prepared.ready, true);
  assert.deepEqual(prepared.reaped, []);
  assert.deepEqual(errors, [], 'a normal startup must not narrate itself');
});

test('prepareShiftLogDir threads BOTH resolutions, and reports the age it actually used', () => {
  const stateDir = join(root, 'prep-state-5');
  mkdirSync(stateDir, { recursive: true });
  const flagDir = join(root, 'prep-flag');
  const envDir = join(root, 'prep-env');
  const settingsDir = join(root, 'prep-settings');
  const base = { stateDir, now: 100 * DAY, err: () => {}, label: 'owenloop shift' };

  // --log-dir wins, and its --log-max-age with it.
  const byFlag = prepareShiftLogDir({
    ...base, flagDir, flagMaxAgeMs: 7,
    env: { OWENLOOP_SHIFT_LOG_DIR: envDir, OWENLOOP_SHIFT_LOG_MAX_AGE_MS: '8' },
    settingsLogDir: settingsDir, settingsMaxAgeMs: 9,
  });
  assert.deepEqual([byFlag.dir, byFlag.maxAgeMs], [flagDir, 7]);

  const byEnv = prepareShiftLogDir({
    ...base, env: { OWENLOOP_SHIFT_LOG_DIR: envDir, OWENLOOP_SHIFT_LOG_MAX_AGE_MS: '8' },
    settingsLogDir: settingsDir, settingsMaxAgeMs: 9,
  });
  assert.deepEqual([byEnv.dir, byEnv.maxAgeMs], [envDir, 8]);

  const bySettings = prepareShiftLogDir({ ...base, env: {}, settingsLogDir: settingsDir, settingsMaxAgeMs: 9 });
  assert.deepEqual([bySettings.dir, bySettings.maxAgeMs], [settingsDir, 9]);

  // Nothing set at all ⇒ logs land in the state dir, beside the `<run>.json`
  // records they correlate to.
  const byDefault = prepareShiftLogDir({ ...base, env: {} });
  assert.deepEqual([byDefault.dir, byDefault.maxAgeMs], [stateDir, DEFAULT_SHIFT_LOG_MAX_AGE_MS]);

  // Each winning directory was actually created, not merely named.
  for (const created of [flagDir, envDir, settingsDir, stateDir]) {
    assert.equal(existsSync(created), true, `${created} must exist`);
  }

  // `maxAgeMs: 0` means "reap every completed log", and the report must quote
  // the number that was used rather than the default.
  const errors: string[] = [];
  const zeroDir = join(root, 'prep-zero');
  mkdirSync(zeroDir, { recursive: true });
  agedLog(zeroDir, 'run_new.log', 100 * DAY, 0);
  const zero = prepareShiftLogDir({
    ...base, flagDir: zeroDir, flagMaxAgeMs: 0, env: {}, err: (line) => errors.push(line),
  });
  assert.equal(zero.maxAgeMs, 0);
  assert.equal(zero.reaped.length, 1);
  assert.deepEqual(errors, [`owenloop shift: reaped 1 worker log(s) older than 0ms from ${zeroDir}`]);
});

test('a REAL sweep at zero retention eats the worker logs and spares the registry', () => {
  // `.owners` sits inside the log directory, which by default IS the state
  // directory, and a sweep that removed by age alone would eat it. The registry
  // is what tells the NEXT sweep which shifts' in-flight logs to spare, so
  // losing it silently converts every other shift's live log into a candidate.
  //
  // Asserted against a real directory and a real `sweepShiftLogs`, not against
  // `isWorkerLogName(LOG_OWNERS_DIR_NAME)`. That predicate returns false for
  // every string not ending in `.log`, so it holds for '.owners' the way it
  // holds for 'banana' — it cannot distinguish a sweep that protects the
  // registry from one that never looks at it. Only running the sweep can.
  const dir = join(root, 'spare-owners');
  const stateDir = join(root, 'spare-state');
  mkdirSync(dir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const now = 100 * DAY;

  // A claim written by ANOTHER shift, aged well past the retention window along
  // with everything else here — age is exactly what must not decide its fate.
  const otherStateDir = join(root, 'spare-other-state');
  mkdirSync(otherStateDir, { recursive: true });
  const claim = registerShiftLogOwner(dir, otherStateDir);
  const ownersPath = logOwnersDir(dir);
  const old = (now - 100 * DAY) / 1000;
  utimesSync(claim, old, old);
  utimesSync(ownersPath, old, old);

  const worker = agedLog(dir, 'run_done.log', now, 100 * DAY);
  const shiftLog = agedLog(dir, SHIFT_LOG_NAME, now, 100 * DAY);

  const errors: string[] = [];
  const removed = sweepShiftLogs({ dir, stateDir, now, maxAgeMs: 0, err: (line) => errors.push(line) });

  // EXACTLY the worker log, by name — not "at least one", which a sweep that
  // also removed the registry would satisfy.
  assert.deepEqual(removed, [worker]);
  // AND the sweep never so much as TRIED the registry. `remove` is
  // `rmSync(path, { force: true })`, which throws ERR_FS_EISDIR on a directory,
  // and the loop's per-entry catch turns that into a report here — so a sweep
  // that attempted `.owners` and failed would leave the directory on disk
  // (satisfying the survival assertions below) and leave a line here as the
  // evidence of the difference.
  //
  // BE HONEST ABOUT THE MUTATION THIS DOES AND DOES NOT CATCH. The name check
  // is deliberately doubled: the sweep loop skips a non-worker name up front,
  // and `isShiftLogReapable` re-tests the same predicate as its first line
  // (`isWorkerLogName` is exported precisely so the gate and the sweep cannot
  // disagree about what they own). Deleting EITHER guard alone therefore
  // changes nothing observable — the other still refuses `.owners`. It takes
  // deleting BOTH to reach `remove` on a directory, which is what this
  // assertion catches. That redundancy is a feature, not an oversight, and the
  // gate's own truth table above is what pins the single-guard behaviour.
  assert.deepEqual(errors, [], 'the registry must be skipped, not attempted-and-failed');
  assert.equal(existsSync(worker), false);
  assert.equal(existsSync(ownersPath), true, 'the registry directory must survive');
  assert.equal(existsSync(claim), true, "and so must another shift's claim inside it");
  assert.deepEqual(
    JSON.parse(readFileSync(claim, 'utf8')) as unknown,
    { stateDir: resolve(otherStateDir) },
    'the claim must be intact, not merely present',
  );
  assert.equal(existsSync(shiftLog), true, 'and the shift log the daemon is appending to right now');

  // The registry still answers correctly afterwards, which is the consequence
  // that actually matters: a NEXT sweep still knows to spare that shift's logs.
  assert.deepEqual(readShiftLogOwners(dir, stateDir).sort(), [resolve(stateDir), resolve(otherStateDir)].sort());
});

test('sweepShiftLogs reports an unreadable directory and returns empty', () => {
  const errors: string[] = [];
  const removed = sweepShiftLogs({
    dir: absent('nope'),
    stateDir: absent('state'),
    now: 0,
    maxAgeMs: 0,
    err: (line) => errors.push(line),
    list: () => { throw new Error('ENOENT'); },
  });
  assert.deepEqual(removed, []);
  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.includes('could not scan shift logs'), errors[0]);
});

// ── which events reach which consumer ──────────────────────────────────────

/**
 * Every variant of `ShiftEventBody['type']`, listed once so the routing test
 * below can be exhaustive rather than a sample.
 *
 * The two type-level guards underneath are the reason this list is worth
 * maintaining: adding a variant to `ShiftEventBody` without deciding here
 * whether it wakes a parked `owenloop shift next` fails `npm run typecheck`,
 * not some later acceptance test's timing.
 */
const ALL_EVENT_TYPES = [
  'parked', 'capacity', 'event-queue-overflow',
  'dispatched', 'reaped', 'failed', 'gate', 'ended',
  'hub-error', 'bundle-miss', 'order-dropped',
] as const;

/** Fails to compile if the list above names a type that is not a variant. */
const _noExtraEventTypes: readonly ShiftEventBody['type'][] = ALL_EVENT_TYPES;
/** Fails to compile if a variant exists that the list above does not name. */
const _noMissingEventTypes: [Exclude<ShiftEventBody['type'], (typeof ALL_EVENT_TYPES)[number]>] extends [never]
  ? true
  : false = true;

test('parked, capacity, hub-error and overflow are FILE-ONLY; every other event reaches the socket', () => {
  // Load-bearing and otherwise proven only indirectly, through a timing race in
  // `shift-blocking-acceptance.test.ts`. The rule: a parked `owenloop shift
  // next` BLOCKS on an idle shift, so a record that is NOT a unit of work
  // moving — it parked, it is at capacity, it could not reach the hub, its
  // queue overflowed — must not be what wakes the client. All four still reach
  // `shift.log`, which is the durable consumer they were promoted for.
  const fileOnly = ['parked', 'capacity', 'hub-error', 'event-queue-overflow'] as const;
  for (const type of fileOnly) {
    assert.equal(reachesSocketConsumer(type), false, `${type} must not wake a parked next`);
  }

  // Everything else is genuine work-shaped news a client asked to be woken for.
  // Derived from `ALL_EVENT_TYPES` rather than written out a second time, so a
  // new variant lands in exactly one of the two lists and never in neither.
  const socketBound = ALL_EVENT_TYPES.filter((type) => !(fileOnly as readonly string[]).includes(type));
  for (const type of socketBound) {
    assert.equal(reachesSocketConsumer(type), true, `${type} must reach a parked next`);
  }

  // `gate` is in that derived list and deserves a caveat, because a reader could
  // otherwise take this test as evidence about live behaviour it does not
  // provide: `GateEvent` is a RESERVED variant — nothing in `packages/work/src`
  // constructs one, on this branch or before it (idea olS9HGgh1V-u9Pzmkl4Z3).
  // The loop above therefore pins its routing DEFAULT, not any record an
  // operator will see: `reachesSocketConsumer` is `!FILE_ONLY_EVENTS.has(type)`,
  // so a type nobody left out of that set is socket-bound the moment a producer
  // appears. That is the whole point — the eventual producer inherits a decided
  // route rather than an accidental one. There is deliberately no separate
  // `socketBound.includes('gate')` assertion: it would compare one file-local
  // const against another, call no production code, and stay green even if
  // `gate` were added to `FILE_ONLY_EVENTS`.
});

test('hub-error is file-only, so a hub outage cannot flood the bounded socket FIFO', () => {
  // The regression this pins, precisely. `hub-error` is LEVEL-TRIGGERED: one
  // record per failed hub call, and `noteServerBackoff` only backs off on HTTP
  // 429, so an unreachable hub (ECONNREFUSED, DNS, timeout, 500) emits one per
  // poll tick with nothing slowing it down. If those reached the socket queue,
  // two contracts would break at once: `enqueue` answers a parked `shift next`
  // the instant ANY event lands, so `next` would stop blocking during an
  // outage; and the queue evicts the OLDEST at MAX_EVENT_QUEUE, so ~83 minutes
  // of outage at the 5s default would evict every `dispatched`/`failed`/
  // `reaped` record a client was actually waiting for.
  //
  // Asserted on its own rather than only inside the table test above, because
  // the two say different things: the table says "the split is total and every
  // variant is on exactly one side", this says "hub-error specifically is on
  // the file side, and here is what breaks if it moves".
  assert.equal(reachesSocketConsumer('hub-error'), false);

  // The contrast that makes it a claim about CATEGORY rather than about volume.
  // `order-dropped` is emitted from the same sweep, under the same hub trouble,
  // and it IS socket-bound — because a refused order is a unit of work that
  // moved (out of this shift's hands), which is exactly what a parked client
  // cannot learn any other way. A failed hub call moved nothing.
  assert.equal(reachesSocketConsumer('order-dropped'), true);
});

test('the published docs agree with FILE_ONLY_EVENTS about what a socket client can receive', () => {
  // ROUND-4 REGRESSION, and the reason a docs assertion earns its place in a
  // unit test file. When `hub-error` moved to the file-only side,
  // `docs/shift-logs.md` was updated and `docs/cli.md` was not, so the two
  // documents in one diff contradicted each other for a full round. `cli.md` is
  // the socket client's contract: a client built against its bullet list polls
  // forever for a record class that structurally cannot arrive. Nothing could
  // catch that, because both documents were only ever read by people.
  //
  // Scope, deliberately narrow: the MACHINE-CHECKABLE claims only — the bullet
  // list of deliverable types and the count word on the file-only sentence.
  // Both drifted this round. Everything else in those documents stays prose.
  const docUrl = (name: string): URL => new URL(`../../../docs/${name}`, import.meta.url);
  const cli = readFileSync(docUrl('cli.md'), 'utf8');
  const logs = readFileSync(docUrl('shift-logs.md'), 'utf8');
  const fileOnly = ALL_EVENT_TYPES.filter((type) => !reachesSocketConsumer(type));

  // Each bullet reads ``- `dispatched`: `{ "type": "dispatched", …``. The
  // back-reference is load-bearing: it also pins the label to the JSON `type`
  // beside it, so a bullet relabelled without its example is not a match.
  const documented = [...cli.matchAll(/^- `([a-z-]+)`: `\{ "type": "\1"/gmu)].map((match) => match[1]!);
  // WITHOUT THIS the whole test is vacuous: a reworded doc would match nothing
  // and every `for` below would pass over an empty list.
  assert.ok(documented.length >= 5, `docs/cli.md event bullets did not parse, got: ${JSON.stringify(documented)}`);

  for (const type of documented) {
    assert.equal(
      reachesSocketConsumer(type as ShiftEventBody['type']), true,
      `docs/cli.md lists '${type}' as deliverable to 'shift next', but FILE_ONLY_EVENTS keeps it off the socket`,
    );
  }
  for (const type of fileOnly) {
    assert.equal(
      documented.includes(type), false,
      `'${type}' is file-only in runtime.ts but docs/cli.md lists it as a 'shift next' record`,
    );
  }

  // The other direction: a NEW socket-bound variant must be documented for the
  // client that will receive it. `gate` is excluded by name because nothing in
  // `packages/work/src` constructs one — both documents describe it as reserved,
  // in prose, rather than as a record a client can expect today.
  for (const type of ALL_EVENT_TYPES) {
    if (type === 'gate' || fileOnly.includes(type)) continue;
    assert.ok(documented.includes(type), `'${type}' reaches the socket but docs/cli.md documents no bullet for it`);
  }

  // The count word, which is the exact token that said "Three" while the code
  // held four. Asserted in both documents because both state it independently.
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
  const expected = words[fileOnly.length]!;
  const cliCount = /\*\*(\w+) further record types exist in\s+`shift\.log` and are never delivered over the socket\*\*/u.exec(cli);
  assert.ok(cliCount !== null, 'docs/cli.md no longer states how many record types are file-only');
  assert.equal(cliCount[1]!.toLowerCase(), expected, `docs/cli.md says '${cliCount[1]!}' file-only types; runtime.ts has ${fileOnly.length}`);
  const logsCount = /\*\*(\w+) of these are file-only\.\*\*/u.exec(logs);
  assert.ok(logsCount !== null, 'docs/shift-logs.md no longer states how many record types are file-only');
  assert.equal(logsCount[1]!.toLowerCase(), expected, `docs/shift-logs.md says '${logsCount[1]!}' file-only types; runtime.ts has ${fileOnly.length}`);

  // And each file-only type is NAMED in both, so the count and the list cannot
  // drift apart from each other either.
  for (const type of fileOnly) {
    assert.ok(cli.includes(`\`${type}\``), `docs/cli.md never names the file-only type '${type}'`);
    assert.ok(logs.includes(`\`${type}\``), `docs/shift-logs.md never names the file-only type '${type}'`);
  }
});

// ── the spawn plan's log destination ───────────────────────────────────────

test('buildSpawnPlan stays pure and carries the log PATH, never a descriptor', () => {
  const spec = { workflow: 'wf1', run: 'run_1', step: 's', kind: 'exec' as const };
  const logs = absent('logs');
  const withLog = buildSpawnPlan(spec, 'https://hub', 'acct', '/bin/owenloop', '/usr/bin/node', 'shf_1', logs);

  assert.equal(withLog.logFile, join(logs, 'run_1.log'));
  // The PLAN is still the pre-logging shape. Opening the file is I/O, and this
  // function does none: `createDefaultSpawner` substitutes the descriptors.
  assert.deepEqual(withLog.options.stdio, ['ignore', 'ignore', 'ignore']);
  assert.equal(existsSync(logs), false, 'building a plan must create nothing');

  // No log dir ⇒ no `logFile` key at all, byte-identical to the old plan.
  const without = buildSpawnPlan(spec, 'https://hub', 'acct', '/bin/owenloop', '/usr/bin/node', 'shf_1');
  assert.equal('logFile' in without, false);
  assert.deepEqual(buildSpawnPlan(spec, 'https://hub', 'acct', '/bin/owenloop', '/usr/bin/node', 'shf_1', ''), without);
});

test('buildSpawnPlan carries the operator work roots in the child spawn ENV', () => {
  const spec = { workflow: 'wf1', run: 'run_1', step: 's', kind: 'exec' as const };
  const base = ['https://hub', 'acct', '/bin/owenloop', '/usr/bin/node', 'shf_1', undefined] as const;

  // `:`-separated, like PATH, and in the spawn env rather than argv — the same
  // contract as OWENLOOP_ACCOUNT, and for the same reason: neither `owenloop work
  // exec` nor `owenloop work agent-run` has an operator-facing flag for it.
  const withRoots = buildSpawnPlan(spec, ...base, ['/Users/me/code', '/srv/work']);
  assert.equal(withRoots.options.env?.['OWENLOOP_ALLOWED_WORKDIR_ROOTS'], '/Users/me/code:/srv/work');

  // Omitted or empty sets NO variable, so the child falls through to its own
  // settings-file resolution and the plan is byte-identical to the old shape.
  const without = buildSpawnPlan(spec, ...base);
  assert.equal('OWENLOOP_ALLOWED_WORKDIR_ROOTS' in (without.options.env ?? {}), false);
  assert.deepEqual(buildSpawnPlan(spec, ...base, []), without);
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
    path: join(absent('logs'), 'shift.log'),
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

test('a real unwritable log destination costs the log, not the process', () => {
  // The destination's PARENT is a regular file, so every `appendFileSync` fails
  // ENOTDIR. Chosen over `chmodSync(dir, 0o500)` because permission bits do not
  // deny root, and root is the default uid in most CI containers — under it the
  // append would SUCCEED and this test would fail for a reason that has nothing
  // to do with the code. ENOTDIR is uid-independent.
  const blocker = join(root, 'not-a-dir-sink');
  writeFileSync(blocker, 'x');
  const path = join(blocker, 'shift.log');
  const errors: string[] = [];
  const sink = createShiftLogSink({ path, err: (line) => errors.push(line) });

  // The assertion is the absence of a throw: a shift whose only defect is that
  // it cannot write a log must still dispatch work.
  sink.write(ev({ type: 'ended' }));

  assert.equal(errors.length, 1);
  assert.ok(errors[0]?.includes(`shift log sink write to ${path} failed`), errors[0]);
  assert.ok(errors[0]?.includes('continuing without it'), errors[0]);
  // `existsSync(path)` is omitted deliberately: `path` sits UNDER a regular
  // file, so `stat()` returns ENOTDIR and the answer is false however the sink
  // behaves. What can actually fail is that the blocker is still a regular file
  // of the original bytes, and that the sink invented no destination elsewhere.
  assert.equal(readFileSync(blocker, 'utf8'), 'x');
  assert.equal(lstatSync(blocker).isFile(), true, 'the blocker must not be replaced by a directory');
  assert.deepEqual(readdirSync(root), ['not-a-dir-sink'], 'a failed sink write must create nothing');

  // And the report is latched across further failing writes, exactly as the
  // injected-`append` test above establishes for a synthetic failure.
  sink.write(ev({ type: 'ended' }));
  sink.write(ev({ type: 'ended' }));
  assert.equal(errors.length, 1, errors.join('\n'));
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
