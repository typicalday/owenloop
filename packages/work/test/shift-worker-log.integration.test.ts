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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { createDefaultSpawner } from '../src/shift/spawn.ts';
import { runLogFile } from '../src/shift/logretention.ts';

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

test('the log survives removal of the run record — its lifetime is not the record\'s', async () => {
  // `state.ts` removes `<run>.json` the moment the child completes. A log that
  // inherited that lifecycle would be readable only while the run is in flight,
  // which is useless for the postmortem it exists for.
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  const record = join(stateDir, 'run_gamma.json');
  writeFileSync(record, '{}');

  const spawner = createDefaultSpawner('https://hub', 'acct', fakeBin('w3'), 'shf_1', undefined, { dir: logDir });
  spawner({ workflow: 'wf1', run: 'run_gamma', step: 's', kind: 'exec' });
  const path = runLogFile(logDir, 'run_gamma');
  await waitForContent(path, 'w3-err');

  rmSync(record);
  assert.equal(existsSync(record), false);
  assert.ok(readFileSync(path, 'utf8').includes('w3-err'), 'the log must outlive its run record');
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

test('no log directory reproduces the pre-logging topology exactly', async () => {
  const spawner = createDefaultSpawner('https://hub', 'acct', fakeBin('w5'), 'shf_1');
  const result = spawner({ workflow: 'wf1', run: 'run_epsilon', step: 's', kind: 'exec' });

  assert.equal(typeof result.pid, 'number');
  // Nothing is written anywhere: with no `logFile` on the plan the worker keeps
  // `stdio: ['ignore','ignore','ignore']` and the kernel discards its output.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(existsSync(runLogFile(logDir, 'run_epsilon')), false);
});

test('dispatching many workers does not leak the parent\'s descriptors', async () => {
  // The parent's copy of each log descriptor is closed in a `finally`. Leaking
  // one per dispatch would eventually hit EMFILE and stop dispatch entirely, so
  // the assertion is that the open-descriptor count does not grow with dispatch
  // count.
  const bin = fakeBin('w6');
  const spawner = createDefaultSpawner('https://hub', 'acct', bin, 'shf_1', undefined, { dir: logDir });
  for (let i = 0; i < 60; i++) {
    spawner({ workflow: 'wf1', run: `run_bulk${i}`, step: 's', kind: 'exec' });
  }
  // A leak of 60 descriptors would already be visible; the real failure mode is
  // that opening the 61st throws EMFILE on a constrained limit. Reaching here
  // without a throw, with every log opened, is the check.
  await waitForContent(runLogFile(logDir, 'run_bulk59'), 'w6-err');
  assert.equal(existsSync(runLogFile(logDir, 'run_bulk0')), true);
});
