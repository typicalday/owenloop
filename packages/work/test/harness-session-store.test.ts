import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  appendSession,
  compact,
  latestFor,
  latestForTask,
  markRunSessionsDead,
  orderId,
  readSessions,
  reconcileActiveSessions,
  sessionsPath,
  shouldRetireSession,
  type SessionRecord,
} from '../src/harness/session-store.ts';
import {
  acquireFileLockSync,
  FileLockTimeoutError,
} from '../../../src/lock.ts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owenloop-sessions-'));
  file = sessionsPath(dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => {
  const workflow = over.workflow ?? 'wf_1';
  const run = over.run ?? 'run_1';
  return {
    workflow,
    run,
    step: 'builder',
    order: orderId(workflow, run),
    attempt: 1,
    harness: 'fake',
    token: 'tok-1',
    cwd: '/tmp/wt',
    status: 'active',
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
};

const lines = (f: string): string[] => readFileSync(f, 'utf8').split('\n').filter((l) => l !== '');

function runAppendWorker(target: string, workerId: number, count: number): Promise<void> {
  const script = fileURLToPath(new URL('./fixtures/session-append-worker.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', script, target, String(workerId), String(count)],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`session append worker ${workerId} exited ${code}: ${stderr}`));
    });
  });
}

function startBarrierAppendWorker(target: string, record: SessionRecord): {
  waitUntilAppendAttempted: () => void;
  done: Promise<void>;
} {
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const state = new Int32Array(barrier);
  const worker = new Worker(new URL('./fixtures/session-barrier-worker.ts', import.meta.url), {
    workerData: { target, record, barrier },
  });
  const done = new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`session barrier worker exited ${code}`));
    });
  });
  return {
    waitUntilAppendAttempted: () => {
      Atomics.store(state, 0, 1);
      Atomics.notify(state, 0);
      const result = Atomics.wait(state, 1, 0, 5_000);
      assert.notEqual(result, 'timed-out', 'append worker reached the held writer lock');
    },
    done,
  };
}

function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  assert.ok(pid !== undefined, 'the dead-pid fixture must have a PID');
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve(pid));
  });
}

test('sessionsPath and orderId build the two derived strings', () => {
  assert.equal(sessionsPath('/c'), join('/c', 'sessions.jsonl'));
  assert.equal(orderId('wf_1', 'run_2'), 'wf_1/run_2');
});

test('append then latestFor round-trips a record', () => {
  const r = rec({ token: 'tok-abc' });
  appendSession(file, r);
  assert.deepEqual(latestFor(file, 'wf_1', 'run_1', 'builder'), r);
});

test('active rows fsync the log and a newly created log directory entry before returning', () => {
  const synced: Array<'file' | 'directory'> = [];
  appendSession(file, rec(), {
    sync: (fd) => {
      synced.push(fstatSync(fd).isDirectory() ? 'directory' : 'file');
    },
  });

  assert.deepEqual(
    synced,
    process.platform === 'win32' ? ['file'] : ['file', 'directory'],
  );
  assert.equal(latestFor(file, 'wf_1', 'run_1', 'builder')?.status, 'active');
});

test('later lifecycle rows retain ordinary append durability without fsync', () => {
  let syncCalls = 0;
  appendSession(file, rec({ status: 'turn-ended' }), {
    sync: () => {
      syncCalls += 1;
    },
  });

  assert.equal(syncCalls, 0);
  assert.equal(latestFor(file, 'wf_1', 'run_1', 'builder')?.status, 'turn-ended');
});

test('an active-row fsync failure propagates to the provider-work gate', () => {
  assert.throws(
    () => appendSession(file, rec(), {
      sync: () => {
	throw new Error('injected active fsync failure');
      },
    }),
    /injected active fsync failure/u,
  );
});

test('a restart appends a new durable active row after an unterminated active tail', () => {
  const abandoned = rec({ token: 'abandoned-active', updatedAt: 900 });
  const next = rec({ attempt: 2, token: 'next-active', updatedAt: 1_100 });
  writeFileSync(file, JSON.stringify(abandoned));
  let syncCalls = 0;

  appendSession(file, next, {
    sync: () => {
      syncCalls += 1;
    },
  });

  assert.ok(syncCalls >= 1);
  assert.equal(latestFor(file, 'wf_1', 'run_1', 'builder')?.token, 'next-active');
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
});

test('compaction fsyncs its replacement and preserves the latest durable active row', () => {
  const synced: Array<'file' | 'directory'> = [];
  appendSession(file, rec({ token: 'active-through-compaction' }), {
    maxBytes: 1,
    sync: (fd) => {
      synced.push(fstatSync(fd).isDirectory() ? 'directory' : 'file');
    },
  });

  assert.equal(latestFor(file, 'wf_1', 'run_1', 'builder')?.token, 'active-through-compaction');
  assert.ok(synced.filter((kind) => kind === 'file').length >= 2, 'the append and compacted replacement are fsynced');
  if (process.platform !== 'win32') {
    assert.ok(synced.filter((kind) => kind === 'directory').length >= 2, 'creation and replacement directory entries are fsynced');
  }
});

test('latestFor is last-wins per (workflow, run, step), and a different step does not interfere', () => {
  appendSession(file, rec({ attempt: 1, token: 'tok-1', updatedAt: 1000 }));
  // A different step for the same run, appended in between.
  appendSession(file, rec({ step: 'reviewer', attempt: 1, token: 'tok-rev', updatedAt: 1100 }));
  appendSession(file, rec({ attempt: 2, token: 'tok-2', updatedAt: 2000 }));
  appendSession(file, rec({ attempt: 3, token: 'tok-3', updatedAt: 3000, status: 'submitted' }));

  const got = latestFor(file, 'wf_1', 'run_1', 'builder');
  assert.equal(got?.token, 'tok-3');
  assert.equal(got?.attempt, 3);
  assert.equal(got?.status, 'submitted');
  // The interleaved step keeps its own answer.
  assert.equal(latestFor(file, 'wf_1', 'run_1', 'reviewer')?.token, 'tok-rev');
});

test('latestFor returns null for a missing file and for an unknown key', () => {
  assert.equal(latestFor(join(dir, 'nope.jsonl'), 'wf_1', 'run_1', 'builder'), null);
  appendSession(file, rec());
  assert.equal(latestFor(file, 'wf_1', 'run_1', 'documenter'), null);
  assert.equal(latestFor(file, 'wf_9', 'run_1', 'builder'), null);
});

test('latestForTask finds the previous firing, which latestFor structurally cannot', () => {
  // The hub mints a fresh run id every time it claims a step, so these two rows
  // are the SAME step of the SAME workflow at the SAME fan-out key, offered
  // twice. This is the exact shape every re-offer on this machine has.
  appendSession(file, rec({ run: 'run_1', key: '', token: 'tok-first', updatedAt: 1000 }));
  appendSession(file, rec({ run: 'run_2', key: '', token: 'tok-second', updatedAt: 2000 }));

  const task = { workflow: 'wf_1', step: 'builder', key: '' };
  assert.equal(latestForTask(file, task)?.token, 'tok-second', 'last-wins across firings');
  assert.equal(latestForTask(file, task)?.run, 'run_2');

  // And the contrast that is the whole point of keeping both functions: asked
  // about the SECOND firing's run id, the per-firing lookup sees only the second
  // firing's own row. It can never reach back to the first.
  assert.equal(latestFor(file, 'wf_1', 'run_2', 'builder')?.token, 'tok-second');
  assert.equal(latestFor(file, 'wf_1', 'run_1', 'builder')?.token, 'tok-first');
});

test('latestForTask separates two fan-out keys of the same step', () => {
  // Same workflow, same step, two shards. Attributing one shard's session to the
  // other would hand a worker a session that was working on different material.
  appendSession(file, rec({ run: 'run_1', key: 'shard-a', token: 'tok-a', updatedAt: 1000 }));
  appendSession(file, rec({ run: 'run_2', key: 'shard-b', token: 'tok-b', updatedAt: 2000 }));

  assert.equal(latestForTask(file, { workflow: 'wf_1', step: 'builder', key: 'shard-a' })?.token, 'tok-a');
  assert.equal(latestForTask(file, { workflow: 'wf_1', step: 'builder', key: 'shard-b' })?.token, 'tok-b');
  // The unfanned key is a third, distinct task — not a wildcard over the others.
  assert.equal(latestForTask(file, { workflow: 'wf_1', step: 'builder', key: '' }), null);
});

test('latestForTask never matches a row written before `key` existed', () => {
  // No `key` at all: this row cannot be attributed to any task, so it must not be
  // attributed to the unfanned one. Guessing here would resume a worker into a
  // session belonging to some other shard of the same step.
  const old = rec({ run: 'run_1', token: 'tok-old' });
  delete (old as Partial<SessionRecord>).key;
  appendSession(file, old);

  assert.equal(latestForTask(file, { workflow: 'wf_1', step: 'builder', key: '' }), null);
  // The row is still perfectly readable — it is only unattributable.
  assert.equal(readSessions(file).length, 1);
  assert.equal(latestFor(file, 'wf_1', 'run_1', 'builder')?.token, 'tok-old');
});

test('latestForTask returns null for a missing file and for an unknown task', () => {
  assert.equal(latestForTask(join(dir, 'nope.jsonl'), { workflow: 'wf_1', step: 'builder', key: '' }), null);
  appendSession(file, rec({ key: '' }));
  assert.equal(latestForTask(file, { workflow: 'wf_1', step: 'documenter', key: '' }), null);
  assert.equal(latestForTask(file, { workflow: 'wf_9', step: 'builder', key: '' }), null);
});

test('a `key` that is present but not a string is rejected, and reported as `key`', () => {
  // Absent is legal (a pre-`key` row). Present-and-wrong-type is a row nobody
  // wrote, and admitting it would let `latestForTask` mis-key it.
  for (const bad of [42, null, {}] as const) {
    const record = { ...rec(), key: bad } as unknown as SessionRecord;
    writeFileSync(file, `${JSON.stringify(record)}\n`);
    const { warnings, opts } = capture();
    assert.deepEqual(readSessions(file, opts), [], `key ${String(bad)} is rejected`);
    assert.equal(
      warnings[0],
      `owenloop work sessions: skipping invalid record at ${file}:1: field "key" failed schema check`,
    );
  }
});

test('an EMPTY key is valid — it is what an unfanned step carries', () => {
  const unfanned = rec({ key: '' });
  writeFileSync(file, `${JSON.stringify(unfanned)}\n`);
  const { warnings, opts } = capture();
  assert.deepEqual(readSessions(file, opts), [unfanned]);
  assert.deepEqual(warnings, [], "'' is a real key, not a missing one");
});

test('readSessions on a missing file is [] (fail-open)', () => {
  assert.deepEqual(readSessions(join(dir, 'nope.jsonl')), []);
});

test('appendSession compacts past maxBytes: one line per key, first-seen key order, answers unchanged', () => {
  // maxBytes: 1 trips compaction after every append.
  const opts = { maxBytes: 1 };
  appendSession(file, rec({ step: 'builder', attempt: 1, token: 'b1' }), opts);
  appendSession(file, rec({ step: 'reviewer', attempt: 1, token: 'r1' }), opts);
  appendSession(file, rec({ step: 'builder', attempt: 2, token: 'b2' }), opts);
  appendSession(file, rec({ step: 'builder', attempt: 3, token: 'b3' }), opts);

  const onDisk = lines(file);
  assert.equal(onDisk.length, 2, 'exactly one line per distinct key survives');
  const parsed = onDisk.map((l) => JSON.parse(l) as SessionRecord);
  assert.deepEqual(parsed.map((p) => p.step), ['builder', 'reviewer'], 'first-seen key order preserved');
  assert.deepEqual(parsed.map((p) => p.token), ['b3', 'r1']);

  assert.equal(latestFor(file, 'wf_1', 'run_1', 'builder')?.token, 'b3');
  assert.equal(latestFor(file, 'wf_1', 'run_1', 'reviewer')?.token, 'r1');
});

test('concurrent append and compaction preserve every successful multiprocess append', async () => {
  const workerCount = 6;
  const recordsPerWorker = 30;
  await Promise.all(
    Array.from({ length: workerCount }, (_, workerId) =>
      runAppendWorker(file, workerId, recordsPerWorker)),
  );

  const records = readSessions(file, { warn: () => {} });
  const expected = workerCount * recordsPerWorker;
  assert.equal(records.length, expected);
  assert.equal(new Set(records.map((record) => record.token)).size, expected);
  assert.equal(existsSync(`${file}.lock`), true, 'the permanent old-client compatibility guard remains after release');
  assert.equal(existsSync(`${file}.lock.sqlite-v2`), true, 'the SQLite lock database remains after release');
});

test('the synchronous lock conservatively refuses a dead-owner pre-boundary pathname', () => {
  const lockPath = `${file}.lock`;
  const original = JSON.stringify({ pid: 2_147_483_647, startedAt: 1, token: 'dead' });
  writeFileSync(lockPath, original);

  assert.throws(
    () => acquireFileLockSync(lockPath, { waitMs: 5, pollMs: 1, label: 'test session-store writer' }),
    (error: unknown) =>
      error instanceof FileLockTimeoutError &&
      error.legacy &&
      error.holderPid === 2_147_483_647 &&
      /will not delete automatically/u.test(error.message) &&
      /remove it manually/u.test(error.message),
  );
  assert.equal(readFileSync(lockPath, 'utf8'), original);
});

test('the synchronous lock never reclaims a live owner because of age', () => {
  const lockPath = `${file}.lock`;
  const original = JSON.stringify({
    pid: process.pid,
    startedAt: 1,
    token: 'live-owner',
  });
  writeFileSync(lockPath, original);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);

  assert.throws(
    () => acquireFileLockSync(lockPath, {
      waitMs: 5,
      pollMs: 1,
      staleMs: 0,
      isPidAlive: (pid) => pid === process.pid,
      label: 'test session-store writer',
    }),
    (error: unknown) =>
      error instanceof FileLockTimeoutError &&
      error.holderPid === process.pid,
  );
  assert.equal(readFileSync(lockPath, 'utf8'), original);
});

test('a post-append compaction failure keeps the appended record and releases the lock', () => {
  writeFileSync(file, 'corrupt complete line\n');

  appendSession(file, rec({ token: 'durable-after-compaction-failure' }), {
    maxBytes: 1,
    warn: () => {
      throw new Error('force compact read failure');
    },
  });

  assert.equal(
    readSessions(file, { warn: () => {} }).at(-1)?.token,
    'durable-after-compaction-failure',
  );
  assert.equal(existsSync(`${file}.lock`), true, 'the released compatibility guard persists');
});

test('a propagating write failure still releases the session writer lock', () => {
  const directoryTarget = join(dir, 'directory-target');
  mkdirSync(directoryTarget);

  assert.throws(() => appendSession(directoryTarget, rec()));
  assert.equal(existsSync(`${directoryTarget}.lock`), true, 'the released compatibility guard persists');
});

test('compact on a file that has never been written is a no-op, not a throw', () => {
  compact(join(dir, 'nope.jsonl'));
  assert.deepEqual(readSessions(join(dir, 'nope.jsonl')), []);
});

test('corrupt lines are skipped and warned about, never thrown', () => {
  const good1 = rec({ step: 'builder', token: 'ok-1' });
  const good2 = rec({ step: 'reviewer', token: 'ok-2' });
  writeFileSync(
    file,
    [
      JSON.stringify(good1), // 1 valid
      'not json', // 2 unparseable
      '[]', // 3 parses, but not an object
      '{"workflow":"w"}', // 4 missing run/step/harness/token
      JSON.stringify({ ...rec(), status: 'bogus' }), // 5 status outside the four literals
      '', // 6 blank — skipped SILENTLY, not a warning
      JSON.stringify(good2), // 7 valid
    ].join('\n') + '\n',
  );

  const warnings: string[] = [];
  const got = readSessions(file, { warn: (l) => warnings.push(l) });

  assert.deepEqual(got.map((r) => r.token), ['ok-1', 'ok-2']);
  assert.equal(warnings.length, 4, 'one warning per corrupt line, none for the blank line');
  assert.ok(
    warnings.some((w) => w.includes(`${file}:2`)),
    `a warning names the offending line number: ${JSON.stringify(warnings)}`,
  );
  assert.ok(warnings.some((w) => w.includes(`${file}:5`)));
});

test('a concurrent partial final append is ignored until its newline commits it', () => {
  const first = rec({ step: 'builder', token: 'ok-1' });
  const second = rec({ step: 'reviewer', token: 'ok-2' });
  const encoded = JSON.stringify(second);
  const cut = Math.floor(encoded.length / 2);
  writeFileSync(file, `${JSON.stringify(first)}\n${encoded.slice(0, cut)}`);

  const warnings: string[] = [];
  assert.deepEqual(
    readSessions(file, { warn: (line) => warnings.push(line) }).map((record) => record.token),
    ['ok-1'],
  );
  assert.equal(warnings.length, 0, 'an unterminated final tail is not committed corruption');

  appendFileSync(file, `${encoded.slice(cut)}\n`);
  assert.deepEqual(
    readSessions(file, { warn: (line) => warnings.push(line) }).map((record) => record.token),
    ['ok-1', 'ok-2'],
  );
  assert.equal(warnings.length, 0);
});

test('appendSession quarantines an abandoned unterminated tail before the new record', () => {
  const first = rec({ step: 'builder', token: 'ok-1' });
  const next = rec({ step: 'reviewer', token: 'ok-2' });
  writeFileSync(file, `${JSON.stringify(first)}\n{"workflow":"abandoned"`);
  const old = new Date(Date.now() - 10_000);
  utimesSync(file, old, old);

  appendSession(file, next);

  const warnings: string[] = [];
  assert.deepEqual(
    readSessions(file, { warn: (line) => warnings.push(line) }).map((record) => record.token),
    ['ok-1', 'ok-2'],
  );
  assert.equal(warnings.length, 1, 'only the abandoned fragment is corrupt');
  assert.match(warnings[0]!, /skipping corrupt record/);
});

test('an unchanged unterminated tail warns once after grace and a changed tail starts a new grace', () => {
  const first = rec({ step: 'builder', token: 'ok-1' });
  writeFileSync(file, `${JSON.stringify(first)}\nnot json`);
  let now = 0;
  const warnings: string[] = [];
  const opts = {
    warn: (line: string) => warnings.push(line),
    now: () => now,
    unterminatedTailGraceMs: 100,
  };

  assert.deepEqual(readSessions(file, opts).map((record) => record.token), ['ok-1']);
  assert.deepEqual(warnings, [], 'the first observation remains silent for a concurrent writer');

  now = 100;
  readSessions(file, opts);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, new RegExp(`persistent unterminated record at ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:2`));

  now = 200;
  readSessions(file, opts);
  assert.equal(warnings.length, 1, 'repeated reads do not spam the same abandoned tail');

  writeFileSync(file, `${JSON.stringify(first)}\nstill partial`);
  readSessions(file, opts);
  assert.equal(warnings.length, 1, 'changing the tail restarts the grace period');

  now = 300;
  readSessions(file, opts);
  assert.equal(warnings.length, 2);

  writeFileSync(file, `${JSON.stringify(first)}\n`);
  readSessions(file, opts);
  assert.equal(warnings.length, 2, 'committing or removing the tail clears the observation');
});

test('an already-old unterminated tail warns on its first read in a fresh observation', () => {
  const oldFile = join(dir, 'old-tail.jsonl');
  const first = rec({ step: 'builder', token: 'ok-1' });
  const now = Date.now();
  writeFileSync(oldFile, `${JSON.stringify(first)}\nnot json`);
  const old = new Date(now - 10_000);
  utimesSync(oldFile, old, old);
  const warnings: string[] = [];

  assert.deepEqual(
    readSessions(oldFile, {
      warn: (line) => warnings.push(line),
      now: () => now,
      unterminatedTailGraceMs: 5_000,
    }).map((record) => record.token),
    ['ok-1'],
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /persistent unterminated record/);
});

test('a freshly modified unterminated tail remains silent on its first read', () => {
  const freshFile = join(dir, 'fresh-tail.jsonl');
  const now = Date.now();
  writeFileSync(freshFile, 'partial append');
  const fresh = new Date(now);
  utimesSync(freshFile, fresh, fresh);
  const warnings: string[] = [];

  assert.deepEqual(readSessions(freshFile, {
    warn: (line) => warnings.push(line),
    now: () => now + 100,
    unterminatedTailGraceMs: 5_000,
  }), []);
  assert.deepEqual(warnings, []);
});

test('latestFor over a corrupt file still answers, warning through the default stderr sink', () => {
  writeFileSync(
    file,
    ['not json', JSON.stringify(rec({ token: 'ok-1' }))].join('\n') + '\n',
  );

  // latestFor takes no options by design (it must stay side-effect-free and
  // total), so the DEFAULT warn runs here — capture stderr to assert it.
  const captured: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(latestFor(file, 'wf_1', 'run_1', 'builder')?.token, 'ok-1');
  } finally {
    process.stderr.write = original;
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0], `owenloop work sessions: skipping corrupt record at ${file}:1\n`);
});

test('compact drops corrupt lines along with superseded ones', () => {
  writeFileSync(
    file,
    [JSON.stringify(rec({ token: 'v1' })), 'not json', JSON.stringify(rec({ token: 'v2' }))].join('\n') + '\n',
  );
  compact(file, { warn: () => {} });
  const onDisk = lines(file);
  assert.equal(onDisk.length, 1);
  assert.equal((JSON.parse(onDisk[0]!) as SessionRecord).token, 'v2');
});

// ---------------------------------------------------------------------------
// The two skip paths report DIFFERENTLY.
//
// Both once emitted the identical "skipping corrupt record" string. An incident
// followed: 36 records that were perfectly valid JSON, rejected only because
// their `token` was the empty string, were every one of them reported as if the
// file were corrupt — sending debugging after a file-integrity problem that did
// not exist. The tests below pin BOTH messages so a future edit cannot quietly
// collapse them back into one string.
// ---------------------------------------------------------------------------

const capture = (): { warnings: string[]; opts: { warn: (line: string) => void } } => {
  const warnings: string[] = [];
  return { warnings, opts: { warn: (line) => warnings.push(line) } };
};

test('a line that will not parse is reported as corrupt', () => {
  writeFileSync(file, 'not json\n');
  const { warnings, opts } = capture();

  assert.deepEqual(readSessions(file, opts), []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], `owenloop work sessions: skipping corrupt record at ${file}:1`);
});

test('a parsed record that fails the schema names the field, not "corrupt"', () => {
  // Valid JSON, and a `token` that is not a string at all. NOT an EMPTY token —
  // that is a valid record now, and the test below this one is why.
  writeFileSync(file, `${JSON.stringify(rec({ token: 42 as unknown as string }))}\n`);
  const { warnings, opts } = capture();

  assert.deepEqual(readSessions(file, opts), [], 'a non-string token is rejected');
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0],
    `owenloop work sessions: skipping invalid record at ${file}:1: field "token" failed schema check`,
  );
});

test('an EMPTY token is a valid record, because the writer means it', () => {
  // `agent/loop.ts` appends a record before the harness emits `started`, so a
  // harness that dies on launch still leaves proof the attempt existed. Rejecting
  // these threw that proof away AND printed ~94 warning lines per reading process
  // — roughly 280 per boot across three shifts — about records behaving exactly
  // as designed. The resume path guards `prev.token !== ''` separately, which is
  // dead code unless these can be read back.
  const empty = rec({ token: '' });
  writeFileSync(file, `${JSON.stringify(empty)}\n`);
  const { warnings, opts } = capture();

  assert.deepEqual(readSessions(file, opts), [empty]);
  assert.deepEqual(warnings, [], 'a record the writer intended must not be reported as invalid');
});

test('the two skip messages cannot be confused for each other', () => {
  writeFileSync(
    file,
    ['not json', JSON.stringify(rec({ token: 42 as unknown as string }))].join('\n') + '\n',
  );
  const { warnings, opts } = capture();

  assert.deepEqual(readSessions(file, opts), []);
  assert.equal(warnings.length, 2);
  const [parseMsg, schemaMsg] = warnings as [string, string];

  // If you are here because you want to merge these strings: read the comment
  // block above this test first. They are separate on purpose.
  assert.notEqual(parseMsg, schemaMsg);
  assert.ok(parseMsg.includes('corrupt'), 'the parse path is the only one saying "corrupt"');
  assert.ok(!parseMsg.includes('field "'), 'the parse path never names a field');
  assert.ok(schemaMsg.includes('invalid'), 'the schema path says "invalid"');
  assert.ok(!schemaMsg.includes('corrupt'), 'the schema path never says "corrupt"');
});

test('the schema message reports the field name and never the field value', () => {
  // `token` is credential-shaped, so a distinctive sentinel gives this teeth:
  // the record fails on `status`, but its token must not reach the log either.
  const sentinel = 'SENTINEL-TOKEN-MUST-NOT-BE-LOGGED';
  writeFileSync(file, `${JSON.stringify({ ...rec({ token: sentinel }), status: 'bogus' })}\n`);
  const { warnings, opts } = capture();

  assert.deepEqual(readSessions(file, opts), []);
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0],
    `owenloop work sessions: skipping invalid record at ${file}:1: field "status" failed schema check`,
  );
  assert.ok(!warnings[0]!.includes(sentinel), 'a record value must never reach the log');
});

test('valid JSON that is not an object reports <root> rather than throwing', () => {
  writeFileSync(file, ['[]', '3', 'null'].join('\n') + '\n');
  const { warnings, opts } = capture();

  assert.deepEqual(readSessions(file, opts), []);
  assert.deepEqual(warnings, [1, 2, 3].map((n) =>
    `owenloop work sessions: skipping invalid record at ${file}:${n}: field "<root>" failed schema check`,
  ));
});

test('a record failing several checks reports the first field in declaration order', () => {
  // `run` and `harness` are both empty; `run` is checked first, so the message
  // is deterministic and this test cannot flake on property iteration order.
  writeFileSync(file, `${JSON.stringify(rec({ run: '', harness: '' }))}\n`);
  const { warnings, opts } = capture();

  assert.deepEqual(readSessions(file, opts), []);
  assert.equal(
    warnings[0],
    `owenloop work sessions: skipping invalid record at ${file}:1: field "run" failed schema check`,
  );
});

test('every field the schema requires is reported by its own name', () => {
  // `token` is NOT in this list: it must be a string, but it may be empty, so an
  // empty one is not a failure to report. Its wrong-type case is covered below.
  for (const field of ['workflow', 'run', 'step', 'harness'] as const) {
    writeFileSync(file, `${JSON.stringify(rec({ [field]: '' }))}\n`);
    const { warnings, opts } = capture();

    assert.deepEqual(readSessions(file, opts), [], `an empty ${field} is rejected`);
    assert.equal(
      warnings[0],
      `owenloop work sessions: skipping invalid record at ${file}:1: field "${field}" failed schema check`,
    );
  }
});

test('a token that is not a string at all is still reported as `token`', () => {
  // The check moved, so this pins that it did not move OUT: a missing token, or
  // one of the wrong type, must still be caught and still be named `token` —
  // only the empty-string case became legal.
  for (const bad of [undefined, null, 42, {}] as const) {
    const record = { ...rec(), token: bad } as unknown as Parameters<typeof appendSession>[1];
    writeFileSync(file, `${JSON.stringify(record)}\n`);
    const { warnings, opts } = capture();

    assert.deepEqual(readSessions(file, opts), [], `token ${String(bad)} is rejected`);
    assert.equal(
      warnings[0],
      `owenloop work sessions: skipping invalid record at ${file}:1: field "token" failed schema check`,
    );
  }
});

test('a valid record still reads back cleanly and silently', () => {
  writeFileSync(file, `${JSON.stringify(rec({ token: 'ok-1' }))}\n`);
  const { warnings, opts } = capture();

  assert.deepEqual(readSessions(file, opts).map((r) => r.token), ['ok-1']);
  assert.deepEqual(warnings, [], 'the refactor must not make valid records warn');
});

test('appendSession creates the parent directory and propagates a real write failure', () => {
  const nested = join(dir, 'deep', 'sessions.jsonl');
  appendSession(nested, rec({ token: 'nested' }));
  assert.equal(latestFor(nested, 'wf_1', 'run_1', 'builder')?.token, 'nested');

  // A path whose parent cannot be created (a FILE stands where a dir must go)
  // must surface to the caller, not be swallowed: a lost token silently
  // degrades a resume into a cold replay.
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'i am a file');
  assert.throws(() => appendSession(join(blocker, 'sessions.jsonl'), rec()));
});

// ---- markRunSessionsDead — the teardown gate's session half -------------------
//
// The work directory is per RUN, so removing it kills EVERY step's session that
// lived in it. These cases pin the scope (this run, every step), the shadowing
// (a new `dead` row, not a rewrite), the idempotence, and the failure stance.

test('markRunSessionsDead retires every STEP of the run, and latestFor then reads dead', () => {
  appendSession(file, rec({ step: 'builder', token: 'tok-b', status: 'submitted' }));
  appendSession(file, rec({ step: 'reviewer', token: 'tok-r', status: 'turn-ended' }));

  const marked = markRunSessionsDead(file, 'wf_1', 'run_1', 5000);

  assert.deepEqual(marked.sort(), ['builder', 'reviewer']);
  for (const step of ['builder', 'reviewer']) {
    const latest = latestFor(file, 'wf_1', 'run_1', step);
    assert.equal(latest?.status, 'dead', `${step} must not be resumable after its work dir is removed`);
    assert.equal(latest?.updatedAt, 5000, 'the retirement is stamped with the reap clock');
  }
  // Appended, never rewritten: the live rows are still on disk, just shadowed.
  assert.equal(lines(file).length, 4);
  assert.equal(readSessions(file)[0]?.status, 'submitted');
});

test('markRunSessionsDead carries the rest of the record verbatim — only status and updatedAt move', () => {
  const live = rec({ status: 'submitted', token: 'tok-keep', deliveredReasonAt: 900, attempt: 3, createdAt: 111 });
  appendSession(file, live);

  markRunSessionsDead(file, 'wf_1', 'run_1', 5000);

  assert.deepEqual(latestFor(file, 'wf_1', 'run_1', 'builder'), {
    ...live,
    status: 'dead',
    updatedAt: 5000,
  });
});

test('markRunSessionsDead touches only the named run, and only its newest row per step', () => {
  appendSession(file, rec({ run: 'run_1', order: orderId('wf_1', 'run_1'), status: 'submitted' }));
  appendSession(file, rec({ run: 'run_2', order: orderId('wf_1', 'run_2'), status: 'submitted' }));
  appendSession(file, rec({ workflow: 'wf_2', order: orderId('wf_2', 'run_1'), status: 'submitted' }));

  assert.deepEqual(markRunSessionsDead(file, 'wf_1', 'run_1', 5000), ['builder']);

  assert.equal(latestFor(file, 'wf_1', 'run_1', 'builder')?.status, 'dead');
  assert.equal(latestFor(file, 'wf_1', 'run_2', 'builder')?.status, 'submitted', "another run's dir was not reaped");
  assert.equal(latestFor(file, 'wf_2', 'run_1', 'builder')?.status, 'submitted', 'and neither was another workflow');
});

test('markRunSessionsDead is idempotent — a second sweep over the same run appends nothing', () => {
  appendSession(file, rec({ status: 'submitted' }));
  assert.deepEqual(markRunSessionsDead(file, 'wf_1', 'run_1', 5000), ['builder']);
  const after = lines(file).length;

  assert.deepEqual(markRunSessionsDead(file, 'wf_1', 'run_1', 6000), [], 'already dead — nothing to retire');
  assert.equal(lines(file).length, after);
});

test('markRunSessionsDead on a store that does not exist is [] — a run that never had a session', () => {
  assert.deepEqual(markRunSessionsDead(join(dir, 'nope.jsonl'), 'wf_1', 'run_1', 5000), []);
});

test('markRunSessionsDead cannot shadow a completed append that reaches the held writer lock', async () => {
  appendSession(file, rec({ status: 'active', token: 'active-before-reap' }));
  const completed = rec({ status: 'submitted', token: 'submitted-during-reap', updatedAt: 6000 });
  const worker = startBarrierAppendWorker(file, completed);

  const marked = markRunSessionsDead(file, 'wf_1', 'run_1', 5000, {
    afterWriterSnapshot: worker.waitUntilAppendAttempted,
  });
  await worker.done;

  assert.deepEqual(marked, ['builder']);
  assert.deepEqual(latestFor(file, 'wf_1', 'run_1', 'builder'), completed);
});

test('reconcileActiveSessions retires only newest orphaned active rows', () => {
  appendSession(file, rec({ run: 'orphan', order: orderId('wf_1', 'orphan'), status: 'active', shiftName: 'A', pid: 101 }));
  appendSession(file, rec({ run: 'complete', order: orderId('wf_1', 'complete'), status: 'submitted' }));
  appendSession(file, rec({ run: 'live', order: orderId('wf_1', 'live'), status: 'active', shiftName: 'A', pid: 202 }));

  const retired = reconcileActiveSessions(file, {
    shiftName: 'A',
    harness: 'fake',
    isAlive: (pid) => pid === 202,
  }, 5000);

  assert.deepEqual(retired.map((record) => record.run), ['orphan']);
  assert.equal(latestFor(file, 'wf_1', 'orphan', 'builder')?.status, 'dead');
  assert.equal(latestFor(file, 'wf_1', 'complete', 'builder')?.status, 'submitted');
  assert.equal(latestFor(file, 'wf_1', 'live', 'builder')?.status, 'active');
});

test('reconcileActiveSessions cannot shadow a submitted append from its retirement snapshot', async () => {
  appendSession(file, rec({ status: 'active', token: 'active-before-reconcile', shiftName: 'A', pid: 101 }));
  const completed = rec({ status: 'turn-ended', token: 'completed-during-reconcile', updatedAt: 6000 });
  const worker = startBarrierAppendWorker(file, completed);

  const retired = reconcileActiveSessions(file, {
    shiftName: 'A',
    harness: 'fake',
    isAlive: () => false,
  }, 5000, {
    afterWriterSnapshot: worker.waitUntilAppendAttempted,
  });
  await worker.done;

  assert.deepEqual(retired.map((record) => record.token), ['active-before-reconcile']);
  assert.deepEqual(latestFor(file, 'wf_1', 'run_1', 'builder'), completed);
});

test('shouldRetireSession fails safe for foreign, live, incomplete, and mismatched rows', () => {
  const base = rec({ shiftName: 'A', pid: 4242, harness: 'fake' });
  const dead = { isAlive: () => false };
  const live = { isAlive: () => true };

  assert.equal(shouldRetireSession(base, { shiftName: 'B', harness: 'codex', ...dead }).retire, false);
  assert.equal(shouldRetireSession({ ...base, shiftName: undefined }, { shiftName: 'A', harness: 'fake', ...dead }).retire, false);
  assert.equal(shouldRetireSession({ ...base, pid: undefined }, { shiftName: 'A', harness: 'fake', ...dead }).retire, false);
  assert.equal(shouldRetireSession(base, { shiftName: 'A', harness: 'fake', ...live }).retire, false);
  assert.equal(shouldRetireSession(base, { shiftName: 'A', harness: 'codex', ...dead }).retire, false);
  assert.equal(shouldRetireSession({ ...base, shiftId: 'shf_previous-incarnation' }, { shiftName: 'A', harness: 'fake', ...dead }).retire, true);
});

test('a booting sibling leaves a live session untouched and emits no retire warning', () => {
  const original = rec({
    status: 'active',
    shiftName: 'A',
    shiftId: 'shf_a',
    pid: process.pid,
    harness: 'fake',
  });
  appendSession(file, original);
  const warnings: string[] = [];

  const retired = reconcileActiveSessions(file, {
    shiftName: 'B',
    harness: 'codex',
  }, 5000, {
    warn: (line) => warnings.push(line),
  });

  assert.deepEqual(retired, []);
  assert.deepEqual(latestFor(file, original.workflow, original.run, original.step), original);
  assert.deepEqual(warnings, [], 'a foreign live record must not produce a retire warning');
});

test('an owned dead session is retired, while a dead harness mismatch warns and survives', async () => {
  const pid = await exitedPid();
  const original = rec({
    status: 'active',
    shiftName: 'A',
    shiftId: 'shf_previous-incarnation',
    pid,
    harness: 'fake',
  });
  appendSession(file, original);
  const retired = reconcileActiveSessions(file, { shiftName: 'A', harness: 'fake' }, 5000);

  assert.deepEqual(retired, [original]);
  assert.deepEqual(latestFor(file, original.workflow, original.run, original.step), {
    ...original,
    status: 'dead',
    updatedAt: 5000,
  });

  const mismatchFile = join(dir, 'mismatch.jsonl');
  const mismatch = { ...original, run: 'run_mismatch', order: orderId(original.workflow, 'run_mismatch') };
  appendSession(mismatchFile, mismatch);
  const warnings: string[] = [];
  const mismatchRetired = reconcileActiveSessions(mismatchFile, { shiftName: 'A', harness: 'codex' }, 5000, {
    warn: (line) => warnings.push(line),
  });

  assert.deepEqual(mismatchRetired, []);
  assert.deepEqual(latestFor(mismatchFile, mismatch.workflow, mismatch.run, mismatch.step), mismatch);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /harness mismatch/u);
});
