import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCommandPlan, createDefaultRunner } from '../src/exec/runner.ts';
import { PAYLOAD_MARKER, PAYLOAD_MAX_BYTES } from '../src/exec/payload.ts';

// The default runner is the ONE place a real child is spawned. Every command
// here is a harmless POSIX-shell fixture in a test-created temp cwd — no network,
// no repo mutation.

const CWD = mkdtempSync(join(tmpdir(), 'owenloop-exec-runner-'));
const sha256 = (s: string): string => `sha256:${createHash('sha256').update(s).digest('hex')}`;

test('buildCommandPlan omits env when no environment is supplied', () => {
  const plan = buildCommandPlan('echo hi', '/some/cwd');
  assert.equal(plan.command, '/bin/sh');
  assert.deepEqual(plan.args, ['-c', 'echo hi']);
  assert.deepEqual(plan.options, { cwd: '/some/cwd', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal('env' in plan.options, false);
});

test('buildCommandPlan includes the supplied full child environment', () => {
  const env = { PATH: '/fixture/bin', OWENLOOP_BUNDLE_DIR: '/fixture/bundle' };
  const plan = buildCommandPlan('echo hi', '/some/cwd', env);
  assert.deepEqual(plan.options.env, env);
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

test('payload markers are recognized across stdout chunks and the last matching line wins', async () => {
  const runner = createDefaultRunner();
  const command = `printf '%s' '${PAYLOAD_MARKER.slice(0, 12)}'; sleep 0.01; printf '%s\\n' '${PAYLOAD_MARKER.slice(12)}{"n":1}'; printf '%s{"n":2}\\n' '${PAYLOAD_MARKER}'`;
  const r = await runner.start(command, { cwd: CWD }).done;
  assert.equal(r.payloadLine, '{"n":2}');
  assert.equal(r.payloadOverCap, undefined);
});

test('payload markers in the middle of a line or on stderr are ignored', async () => {
  const runner = createDefaultRunner();
  const command = `printf 'prefix %s{"bad":1}\\n' '${PAYLOAD_MARKER}'; printf '%s{"bad":2}\\n' '${PAYLOAD_MARKER}' 1>&2`;
  const r = await runner.start(command, { cwd: CWD }).done;
  assert.equal(r.payloadLine, undefined);
  assert.equal(r.payloadOverCap, undefined);
});

test('an oversized final payload marker is reported without retaining the whole line', async () => {
  const runner = createDefaultRunner();
  const command = `printf '%s' '${PAYLOAD_MARKER}'; head -c ${PAYLOAD_MAX_BYTES + 1} /dev/zero`;
  const r = await runner.start(command, { cwd: CWD }).done;
  assert.equal(r.payloadLine, undefined);
  assert.equal(r.payloadOverCap, true);
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
