import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCommandPlan, createDefaultRunner } from '../src/exec/runner.ts';

// The default runner is the ONE place a real child is spawned. Every command
// here is a harmless POSIX-shell fixture in a test-created temp cwd — no network,
// no repo mutation.

const CWD = mkdtempSync(join(tmpdir(), 'owenwork-exec-runner-'));
const sha256 = (s: string): string => `sha256:${createHash('sha256').update(s).digest('hex')}`;

test('buildCommandPlan is a pure detached `/bin/sh -c` plan', () => {
  const plan = buildCommandPlan('echo hi', '/some/cwd');
  assert.equal(plan.command, '/bin/sh');
  assert.deepEqual(plan.args, ['-c', 'echo hi']);
  assert.deepEqual(plan.options, { cwd: '/some/cwd', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
});

test('a zero-exit command captures exit 0, byte counts, the stdout hash and tail', async () => {
  const runner = createDefaultRunner();
  const r = await runner.start('echo hi', { cwd: CWD }).done;
  assert.equal(r.exitCode, 0);
  assert.equal(r.signal, undefined);
  assert.equal(r.error, undefined);
  assert.equal(r.stdoutBytes, 3); // "hi\n"
  assert.equal(r.stderrBytes, 0);
  assert.equal(r.outputHash, sha256('hi\n'));
  assert.equal(r.outputTail, 'hi\n');
  assert.ok(r.finishedAt >= r.startedAt);
  assert.equal(r.durationMs, r.finishedAt - r.startedAt);
});

test('a non-zero exit is captured verbatim (the receipt carries the truth)', async () => {
  const runner = createDefaultRunner();
  const r = await runner.start('exit 3', { cwd: CWD }).done;
  assert.equal(r.exitCode, 3);
  assert.equal(r.error, undefined);
});

test('stdout then stderr are hashed in order and both feed the tail', async () => {
  const runner = createDefaultRunner();
  const r = await runner.start('echo out; echo err 1>&2', { cwd: CWD }).done;
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdoutBytes, 4); // "out\n"
  assert.equal(r.stderrBytes, 4); // "err\n"
  // Hash is over the FULL stdout bytes then the FULL stderr bytes, in that order.
  assert.equal(r.outputHash, sha256('out\nerr\n'));
  // Tail is combined stdout-then-stderr.
  assert.equal(r.outputTail, 'out\nerr\n');
});

test('out-of-order stderr past the 1 MiB cap degrades to the bounded two-part hash', async () => {
  // 2 MiB of stderr while stdout is still open (stdout only ends at process
  // exit) — without the cap this buffers the whole stream in memory. With it,
  // capture degrades to `sha256:<sha256(stdout)>+<sha256(stderr)>`: both
  // streams still fully hashed, memory bounded.
  const runner = createDefaultRunner();
  const size = 2 * 1024 * 1024;
  const r = await runner.start(`head -c ${size} /dev/zero 1>&2; printf hi`, { cwd: CWD }).done;
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdoutBytes, 2); // "hi"
  assert.equal(r.stderrBytes, size);
  const stdoutHex = createHash('sha256').update('hi').digest('hex');
  const stderrHex = createHash('sha256').update(Buffer.alloc(size)).digest('hex');
  assert.equal(r.outputHash, `sha256:${stdoutHex}+${stderrHex}`);
});

test('a machinery failure (missing cwd) resolves exitCode null + error, never rejects', async () => {
  const runner = createDefaultRunner();
  const r = await runner.start('echo hi', { cwd: join(CWD, 'does', 'not', 'exist') }).done;
  assert.equal(r.exitCode, null);
  assert.ok(typeof r.error === 'string' && r.error.length > 0, `expected an error string, got ${String(r.error)}`);
});

test('kill() takes down the process group — a long command settles by signal', async () => {
  const runner = createDefaultRunner({ graceMs: 2_000 });
  const running = runner.start('sleep 30', { cwd: CWD });
  await running.kill();
  const r = await running.done;
  assert.equal(r.exitCode, null);
  assert.ok(r.signal !== undefined, `expected a terminating signal, got ${JSON.stringify(r)}`);
});

test('kill() is idempotent and safe to call after the command already settled', async () => {
  const runner = createDefaultRunner();
  const running = runner.start('echo done', { cwd: CWD });
  await running.done;
  await running.kill(); // must not throw
  await running.kill();
});
