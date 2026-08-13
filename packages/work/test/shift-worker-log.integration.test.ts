/**
 * The end-to-end claim this whole change exists to make true: bytes a detached
 * worker writes to fd 1 and fd 2 are ON DISK, under the run id they belong to,
 * and they outlive both the worker and the shift that dispatched it.
 *
 * These tests spawn REAL child processes through `createDefaultSpawner` — the
 * production path, not a stub. A unit test on `buildSpawnPlan` can only prove
 * the plan carries a path; only a real spawn proves the kernel wrote the bytes.
 *
 * `binPath` is a throwaway script rather than the packaged bin because the
 * subject under test is the STDIO TOPOLOGY, not what `owenloop work exec` does
 * with it. The script writes a known marker to each stream and exits.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { createDefaultSpawner } from '../src/shift/spawn.ts';
import { runLogFile, sweepShiftLogs } from '../src/shift/logretention.ts';

let root: string;
let logDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-worker-log-'));
  logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * A stand-in for the packaged bin: writes `<tag>-out` to stdout and `<tag>-err`
 * to stderr, then exits 0. The spawner always runs `process.execPath` with this
 * path as the first argv entry, exactly as it runs the real bin.
 */
function fakeBin(tag: string): string {
  const path = join(root, `bin-${tag}.mjs`);
  writeFileSync(
    path,
    [
      `process.stdout.write(${JSON.stringify(`${tag}-out\n`)});`,
      `process.stderr.write(${JSON.stringify(`${tag}-err\n`)});`,
      // Flushing synchronously before exit keeps the test deterministic; a real
      // worker's ordering between the two streams is not what is under test.
      'process.exit(0);',
    ].join('\n'),
  );
  return path;
}

/**
 * Block until every pid has exited, or give up after the deadline.
 *
 * `process.kill(pid, 0)` sends no signal; it only asks whether the process is
 * still addressable, throwing ESRCH once it is gone. Workers are spawned
 * DETACHED, so this test process is not their parent in any way that would
 * reap them — polling is how it learns they are done. Giving up quietly rather
 * than failing is deliberate: a straggler is a teardown concern, not the
 * property under test, and turning it into an assertion would make a slow
 * machine look like a broken invariant.
 */
async function waitForExit(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (Date.now() < deadline && pids.some(alive)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForContent(path: string, needle: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      if (text.includes(needle)) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`'${needle}' never appeared in ${path}: ${existsSync(path) ? readFileSync(path, 'utf8') : '(no file)'}`);
}

test("a dispatched worker's stdout AND stderr both land in <run>.log", async () => {
  const spawner = createDefaultSpawner('https://hub', 'acct', fakeBin('w1'), 'shf_1', undefined, { dir: logDir });
  spawner({ workflow: 'wf1', run: 'run_alpha', step: 's', kind: 'exec' });

  const path = runLogFile(logDir, 'run_alpha');
  const text = await waitForContent(path, 'w1-err');

  // ONE file holds both streams — the spawner opens the log once and hands the
  // SAME descriptor to slots 1 and 2, which is exactly shell `2>&1`.
  assert.ok(text.includes('w1-out'), text);
  assert.ok(text.includes('w1-err'), text);

  // AND IT IS OWNER-ONLY. Before this feature a worker's stdout and stderr went
  // to /dev/null; this is the change that makes them persist, and a worker runs
  // authored workflow content, so a step that echoes a token puts that token in
  // this file. `exec/loop.ts` already writes its agent-produced artifact JSON
  // with `mode: 0o600` for the same reason. Without the explicit mode argument
  // `openSync` creates 0666 & ~umask — 0644 under the usual 022, readable by
  // every local account. Masked with 0o777 because the high bits of `st_mode`
  // are the file type, not permissions.
  assert.equal(
    (statSync(path).mode & 0o777).toString(8),
    '600',
    'a worker log holds attacker-influenceable output and must not be world-readable',
  );
});

test('a re-armed run APPENDS instead of truncating the earlier attempt', async () => {
  // A retried or re-armed run reuses its run id. The prior attempt's output is
  // precisely the evidence a postmortem needs, so the log must open with 'a'.
  const path = runLogFile(logDir, 'run_beta');

  const first = createDefaultSpawner('https://hub', 'acct', fakeBin('try1'), 'shf_1', undefined, { dir: logDir });
  first({ workflow: 'wf1', run: 'run_beta', step: 's', kind: 'exec' });
  await waitForContent(path, 'try1-err');

  const second = createDefaultSpawner('https://hub', 'acct', fakeBin('try2'), 'shf_1', undefined, { dir: logDir });
  second({ workflow: 'wf1', run: 'run_beta', step: 's', kind: 'exec' });
  const text = await waitForContent(path, 'try2-err');

  assert.ok(text.includes('try1-out'), `the first attempt was lost: ${text}`);
  assert.ok(text.includes('try2-out'), text);
});

/** One block of the interleaving probe. Big enough that a truncated or
 *  overwritten file is unmistakable, small enough to stay one `write()`. */
const BLOCK = 64;

/**
 * A bin that writes four fixed-size blocks, ALTERNATING between fd 1 and fd 2,
 * with `writeSync` so the order is the program's and not the runtime's.
 *
 * The exact expected file is `A×64 B×64 C×64 D×64` — 256 bytes, in that order.
 */
function interleaveBin(): string {
  const path = join(root, 'bin-interleave.mjs');
  writeFileSync(
    path,
    [
      "import { writeSync } from 'node:fs';",
      `writeSync(1, ${JSON.stringify('A'.repeat(BLOCK))});`,
      `writeSync(2, ${JSON.stringify('B'.repeat(BLOCK))});`,
      `writeSync(1, ${JSON.stringify('C'.repeat(BLOCK))});`,
      `writeSync(2, ${JSON.stringify('D'.repeat(BLOCK))});`,
      'process.exit(0);',
    ].join('\n'),
  );
  return path;
}

test('fds 1 and 2 share ONE append stream: nothing is overwritten and nothing is lost', async () => {
  // WHAT THIS PINS THAT `dev:ino` EQUALITY CANNOT. The fd-probe test below
  // asserts that slots 1 and 2 resolve to the same FILE, which two separate
  // opens of the same path also satisfy — `fstat` describes the file, not the
  // descriptor. This test asserts the observable CONSEQUENCE instead: four
  // alternating writes across the two slots produce all four blocks, in program
  // order, at exactly the summed length.
  //
  // THE MUTATION IT CATCHES. Replace `stdio: ['ignore', logFd, logFd]` with two
  // descriptors that do not share an append offset — the plain-open case, i.e.
  // `openSync(path, 'w')` or `openSync(path, 'r+')` twice — and each descriptor
  // starts at offset 0 and walks forward independently: fd 2's B lands on top of
  // fd 1's A, fd 2's D lands on top of fd 1's C, and the file is `B×64 D×64`,
  // 128 bytes. Both the length assertion and the order assertion go red.
  //
  // THE MUTATION IT DOES NOT CATCH, stated so nobody reads more into it. Two
  // SEPARATE `openSync(path, 'a')` calls would still produce the correct bytes,
  // because O_APPEND makes every individual write seek to end atomically no
  // matter which description issues it. That variant is wasteful rather than
  // wrong, and its one real cost — a second descriptor the `finally` does not
  // close — is what the descriptor-count test at the bottom of this file
  // catches. Between the two, the pair "open once, close once" is held.
  const spawner = createDefaultSpawner('https://hub', 'acct', interleaveBin(), 'shf_1', undefined, { dir: logDir });
  spawner({ workflow: 'wf1', run: 'run_weave', step: 's', kind: 'exec' });

  const path = runLogFile(logDir, 'run_weave');
  const text = await waitForContent(path, 'D'.repeat(BLOCK));

  const expected = 'A'.repeat(BLOCK) + 'B'.repeat(BLOCK) + 'C'.repeat(BLOCK) + 'D'.repeat(BLOCK);
  // Length first, because it names the failure: a short file means a write
  // landed on top of another rather than after it.
  assert.equal(
    Buffer.byteLength(text, 'utf8'),
    4 * BLOCK,
    `expected ${String(4 * BLOCK)} bytes across four alternating writes, got ${String(Buffer.byteLength(text, 'utf8'))}`,
  );
  // Then the exact bytes, which also pins the ORDER: an implementation that
  // kept every byte but let the two slots race would fail here and pass above.
  assert.equal(text, expected, 'the four blocks must appear in write order, whole');
});

test('the run record, not the age, decides when a REAL worker\'s log becomes reapable', async () => {
  // The record and the log are two files in two different directories, and the
  // only thing that couples them is `sweepShiftLogs` — specifically its default
  // `hasRecord`, which stats `<state-dir>/<run>.json` for each `<run>.log` it
  // considers. So the sweep is what this test runs. Creating a record, deleting
  // it, and re-reading the log proves nothing on its own: `createDefaultSpawner`
  // never opens the state directory, so no implementation could have coupled
  // them and the log would survive either way.
  //
  // Run at `maxAgeMs: 0`, where EVERY log is old enough. What survives the first
  // sweep survives because the run is in flight, and nothing else — which is the
  // orphaned-inode case the gate exists for: unlinking a log a live worker still
  // holds an fd on makes the bytes unreadable while the filesystem keeps
  // charging for them.
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  const record = join(stateDir, 'run_gamma.json');
  writeFileSync(record, '{}');

  const spawner = createDefaultSpawner('https://hub', 'acct', fakeBin('w3'), 'shf_1', undefined, { dir: logDir });
  spawner({ workflow: 'wf1', run: 'run_gamma', step: 's', kind: 'exec' });
  const path = runLogFile(logDir, 'run_gamma');
  await waitForContent(path, 'w3-err');

  // ── IN FLIGHT: spared, at zero retention, with real bytes on disk ──
  const spared = sweepShiftLogs({ dir: logDir, stateDir, now: Date.now(), maxAgeMs: 0 });
  assert.deepEqual(spared, [], 'a run with a live record must not be reaped at any age');
  assert.ok(readFileSync(path, 'utf8').includes('w3-err'), 'and its bytes must be untouched');

  // ── RECORD GONE: the same file, the same age, now reapable ──
  rmSync(record);
  const reaped = sweepShiftLogs({ dir: logDir, stateDir, now: Date.now(), maxAgeMs: 0 });
  assert.deepEqual(reaped, [path], 'removing the record is the ONLY change between the two sweeps');
  assert.equal(existsSync(path), false);
});

test('an unopenable log costs the output, never the dispatch', async () => {
  // A log directory that is actually a FILE makes every open fail. The worker
  // must still launch: logging is observability, and losing it is not a reason
  // to refuse work.
  const notADir = join(root, 'not-a-dir');
  writeFileSync(notADir, 'x');
  const errors: string[] = [];
  const spawner = createDefaultSpawner('https://hub', 'acct', fakeBin('w4'), 'shf_1', undefined, {
    dir: notADir,
    err: (line) => errors.push(line),
  });

  const result = spawner({ workflow: 'wf1', run: 'run_delta', step: 's', kind: 'exec' });

  assert.equal(typeof result.pid, 'number', 'the worker must still have been spawned');
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.ok(errors[0]?.includes('could not open worker log'), errors[0]);
  assert.ok(errors[0]?.includes('discarded'), errors[0]);

  // REPORT ONCE PER SHIFT, NOT ONCE PER DISPATCH. The condition that makes the
  // open fail — here a log "directory" that is really a file, in production a
  // full disk or a directory deleted underneath a running shift — persists, so
  // an unlatched report writes one stderr line for every dispatch the shift ever
  // makes. Three more dispatches, all failing the same way, must add no lines.
  for (const run of ['run_delta2', 'run_delta3', 'run_delta4']) {
    const again = spawner({ workflow: 'wf1', run, step: 's', kind: 'exec' });
    assert.equal(typeof again.pid, 'number', `${run} must still have been spawned`);
  }
  assert.equal(errors.length, 1, `the failure report must be latched: ${errors.join('\n')}`);
});

test('the log-open failure latch is per shift, so a new spawner reports again', async () => {
  // The latch lives on the spawner, whose lifetime is the shift's. A DIFFERENT
  // shift starting against the same broken destination is a new operator-facing
  // event and must not be silenced by the previous shift's latch.
  const notADir = join(root, 'not-a-dir-2');
  writeFileSync(notADir, 'x');
  const first: string[] = [];
  const second: string[] = [];

  createDefaultSpawner('https://hub', 'acct', fakeBin('w4b'), 'shf_1', undefined, {
    dir: notADir,
    err: (line) => first.push(line),
  })({ workflow: 'wf1', run: 'run_zeta', step: 's', kind: 'exec' });
  createDefaultSpawner('https://hub', 'acct', fakeBin('w4c'), 'shf_2', undefined, {
    dir: notADir,
    err: (line) => second.push(line),
  })({ workflow: 'wf1', run: 'run_eta', step: 's', kind: 'exec' });

  assert.equal(first.length, 1, first.join('\n'));
  assert.equal(second.length, 1, second.join('\n'));
});

/**
 * A stand-in bin that reports its OWN stdio topology, as the KERNEL sees it,
 * into a side-channel file the test names.
 *
 * `fstat` on fd 1 and fd 2 is the only way to observe what the spawner actually
 * handed the child. Reading `<run>.log` afterwards cannot distinguish "both
 * slots hold one descriptor onto this file" from "two descriptors onto the same
 * path", and it cannot observe the no-logging case at all, because there the
 * whole claim is that nothing was written anywhere.
 *
 * The report goes to a side channel rather than to stdout because stdout is the
 * subject under test — writing the answer through the thing being measured is
 * exactly what the no-logging case would discard.
 */
function probeBin(tag: string, reportPath: string): string {
  const path = join(root, `probe-${tag}.mjs`);
  writeFileSync(
    path,
    [
      "import { fstatSync, writeFileSync } from 'node:fs';",
      'const describe = (fd) => {',
      '  const s = fstatSync(fd);',
      // dev+ino as strings: the pair identifies a file on a filesystem, and JSON
      // has no integer type wide enough to be trusted with a raw inode number.
      '  return { file: s.isFile(), charDev: s.isCharacterDevice(), id: `${s.dev}:${s.ino}` };',
      '};',
      `writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ out: describe(1), err: describe(2) }));`,
      'process.exit(0);',
    ].join('\n'),
  );
  return path;
}

interface FdReport {
  out: { file: boolean; charDev: boolean; id: string };
  err: { file: boolean; charDev: boolean; id: string };
}

test('with a log directory the child gets ONE descriptor on fds 1 and 2; without one it gets /dev/null', async () => {
  // THE CONTRAST IS THE TEST. Both halves spawn the same probe the same way and
  // differ in exactly one argument — the `logging` option — so every difference
  // below is attributable to it. Asserting only the second half ("no file
  // appeared") proves nothing: with no `logging` argument the spawner is never
  // told where `logDir` is, so no implementation could have written there.

  // ── WITH LOGGING ──
  const onReport = join(root, 'fd-report-on.json');
  createDefaultSpawner('https://hub', 'acct', probeBin('on', onReport), 'shf_1', undefined, { dir: logDir })(
    { workflow: 'wf1', run: 'run_probe_on', step: 's', kind: 'exec' },
  );
  const on = JSON.parse(await waitForContent(onReport, '"out"')) as FdReport;

  assert.equal(on.out.file, true, 'fd 1 must be a regular file');
  assert.equal(on.err.file, true, 'fd 2 must be a regular file');
  // THE `2>&1` EFFECT: both slots resolve to one file, so a reader of
  // `<run>.log` gets the worker's diagnostics and its output interleaved in
  // write order rather than split across two destinations.
  //
  // What this pair does NOT prove is that ONE descriptor fills both slots —
  // `fstat` reports the FILE, so two separate opens of the same path would
  // report the same `dev:ino` too. Two other tests carry that weight, and
  // between them they cover both halves of "open once, close once": the
  // interleaving test above ('fds 1 and 2 share ONE append stream') fails if the
  // two slots do not share an append offset, and the descriptor-count test at
  // the bottom of this file fails if the parent's copy is not closed.
  assert.equal(on.out.id, on.err.id, 'fds 1 and 2 must resolve to the same file');
  // And that one file is `<log-dir>/<run>.log` — not some other file that merely
  // happens to be regular.
  const logStat = statSync(runLogFile(logDir, 'run_probe_on'));
  assert.equal(on.out.id, `${String(logStat.dev)}:${String(logStat.ino)}`);

  // ── WITHOUT LOGGING: the pre-logging topology, unchanged ──
  const before = readdirSync(logDir).sort();
  const offReport = join(root, 'fd-report-off.json');
  const result = createDefaultSpawner('https://hub', 'acct', probeBin('off', offReport), 'shf_1')(
    { workflow: 'wf1', run: 'run_epsilon', step: 's', kind: 'exec' },
  );
  assert.equal(typeof result.pid, 'number', 'the worker must still be spawned');
  const off = JSON.parse(await waitForContent(offReport, '"out"')) as FdReport;

  // `stdio: 'ignore'` is /dev/null on POSIX, which is a CHARACTER DEVICE. This
  // is the assertion that can fail: it is false the moment a descriptor onto a
  // real file reaches a worker that was never given a log directory.
  assert.equal(off.out.file, false, 'fd 1 must not be a file when logging is off');
  assert.equal(off.out.charDev, true, `fd 1 must be /dev/null, got ${JSON.stringify(off.out)}`);
  assert.equal(off.err.charDev, true, `fd 2 must be /dev/null, got ${JSON.stringify(off.err)}`);
  // Nothing new anywhere in the log directory, by full listing rather than by
  // guessing one filename the implementation might have chosen.
  assert.deepEqual(readdirSync(logDir).sort(), before);
});

/**
 * How many file descriptors THIS process currently holds open.
 *
 * `/dev/fd` lists the descriptors of the process that reads it — on Linux it is
 * a symlink to `/proc/self/fd`, on macOS it is served directly. Those are the
 * two platforms this project's CI runs, and reading it is the only way to
 * observe `createDefaultSpawner`'s `finally { closeSync(logFd) }` from outside:
 * the descriptor that block closes is the PARENT's copy, and nothing about the
 * child or the file on disk reveals whether it was closed.
 */
function openDescriptorCount(): number {
  return readdirSync('/dev/fd').length;
}

test('dispatching many workers does not leak the parent\'s descriptors', async () => {
  // `createDefaultSpawner` opens each worker log in the PARENT with `openSync`,
  // hands that one descriptor to the child's stdio slots 1 and 2, and closes the
  // parent's copy in a `finally`. Without that `finally` a long-lived shift
  // leaks one descriptor per dispatch and eventually cannot dispatch at all —
  // `openSync` throws EMFILE once the process hits its limit, which on a default
  // macOS shell is 256.
  //
  // Counting descriptors is what makes this test able to fail. Asserting that
  // the log files exist cannot: they exist whether or not the parent closed
  // anything.
  const bin = fakeBin('w6');
  const spawner = createDefaultSpawner('https://hub', 'acct', bin, 'shf_1', undefined, { dir: logDir });

  // One warm-up dispatch first, so the baseline is taken after `child_process`
  // has opened whatever it opens once rather than per spawn.
  spawner({ workflow: 'wf1', run: 'run_warmup', step: 's', kind: 'exec' });
  const before = openDescriptorCount();

  const DISPATCHES = 60;
  const pids: number[] = [];
  for (let i = 0; i < DISPATCHES; i++) {
    const { pid } = spawner({ workflow: 'wf1', run: `run_bulk${i}`, step: 's', kind: 'exec' });
    if (typeof pid === 'number') pids.push(pid);
  }
  const after = openDescriptorCount();

  // Let the 60 detached children finish before this test returns. They are
  // detached, so nothing reaps them automatically, and `afterEach` removes
  // `root` — including the bin they were launched from — the moment it does.
  // Waiting here is what keeps that teardown from racing a child that has not
  // finished starting, which would show up as unrelated noise on a loaded box
  // rather than as a real failure.
  await waitForExit(pids);

  // Every one of the 60 logs really was opened — `openSync` runs synchronously
  // in the parent, so the file exists the instant `spawner()` returns, with no
  // waiting on any child. This is what makes the count below mean something:
  // 60 descriptors were genuinely opened, so 60 were genuinely closed.
  for (let i = 0; i < DISPATCHES; i++) {
    assert.equal(existsSync(runLogFile(logDir, `run_bulk${i}`)), true, `run_bulk${i}.log must have been opened`);
  }

  // The budget is deliberately far below `DISPATCHES`: a missing `finally` grows
  // the count by exactly 60, while the ordinary churn of spawning (a transient
  // descriptor or two the runtime has not yet reclaimed) is single digits.
  const grew = after - before;
  assert.ok(
    grew < 10,
    `the parent leaked descriptors: ${String(before)} → ${String(after)} (+${String(grew)}) across ${String(DISPATCHES)} dispatches`,
  );
});
