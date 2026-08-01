import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Exercise the real binary end to end (build runs via pretest). This pins the
// "role dispatch demonstrable" verify criterion against the shipped shim.
const BIN = fileURLToPath(new URL('../../../bin/owenloop.mjs', import.meta.url));

// When `env` is given it REPLACES the ambient environment (only PATH is carried
// through so node itself resolves) — a clean slate so a developer's real token
// or configured origin can never leak into a case that asserts a usage error.
function runCli(args: string[], env?: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const options = { encoding: 'utf8' as const, ...(env !== undefined ? { env: { PATH: process.env['PATH'] ?? '', ...env } } : {}) };
  const res = spawnSync(process.execPath, [BIN, 'work', ...args], options);
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

test('--help exits 0 and lists every role on stdout', () => {
  const { status, stdout } = runCli(['--help']);
  assert.equal(status, 0);
  for (const role of ['proxy', 'hold', 'exec', 'prepare', 'lint', 'settings', 'release', 'join']) {
    assert.match(stdout, new RegExp(`\\b${role}\\b`), `help should mention ${role}`);
  }
});

test('no args prints usage and exits 0', () => {
  const { status, stdout } = runCli([]);
  assert.equal(status, 0);
  assert.match(stdout, /Usage:/);
});

test('--version prints a version and exits 0', () => {
  const { status, stdout } = runCli(['--version']);
  assert.equal(status, 0);
  assert.match(stdout, /^\d+\.\d+\.\d+/);
});

test('unknown role exits 2 with usage on stderr', () => {
  const { status, stderr, stdout } = runCli(['bogus']);
  assert.equal(status, 2);
  assert.match(stderr, /unknown command 'bogus'/);
  assert.match(stderr, /Usage:/);
  assert.equal(stdout, '');
});

test('hold without --order exits 2 with usage on stderr', () => {
  const { status, stderr } = runCli(['hold']);
  assert.equal(status, 2);
  assert.match(stderr, /missing required --order/);
});

test('exec without an order-id exits 2', () => {
  const { status, stderr } = runCli(['exec']);
  assert.equal(status, 2);
  assert.match(stderr, /missing required <order-id>/);
});

// C5 landed exec: with a valid order-id but no origin/token it exits 2 (a usage
// error) rather than exiting 3 as a stub — no role is a stub anymore. Full
// behavior is pinned in the exec-role / exec-loop / exec-runner tests. Run in an
// env with no hub origin configured.
test('exec with a valid order-id but no origin configured exits 2', () => {
  const { status, stderr } = runCli(['exec', 'wf1/run1'], {
    HOME: mkdtempSync(join(tmpdir(), 'owenwork-dispatch-')),
  });
  assert.equal(status, 2);
  assert.match(stderr, /no hub origin|no token/);
});

// C4 landed hold: with a valid target but no origin/token it exits 2 (a usage
// error) rather than exiting 3 as a stub. Full behavior is pinned in the
// hold-loop / hold-role tests. Run in an env with no hub origin configured.
test('hold with valid args but no origin configured exits 2', () => {
  const { status, stderr } = runCli(['hold', '--order', 'wf1/run1'], {
    HOME: mkdtempSync(join(tmpdir(), 'owenwork-dispatch-')),
  });
  assert.equal(status, 2);
  assert.match(stderr, /no hub origin|no token/);
});

// C3 landed proxy: it now resolves config and exits 2 on a missing origin/token
// (a usage error) rather than exiting 3 as a stub. Full behavior is pinned in
// the proxy-loop / proxy-* tests. Run in an env with no hub origin configured.
test('proxy with no origin configured exits 2 with usage on stderr', () => {
  const { status, stderr } = runCli(['proxy'], { HOME: mkdtempSync(join(tmpdir(), 'owenwork-dispatch-')) });
  assert.equal(status, 2);
  assert.match(stderr, /no hub origin|no token/);
});

// C2 landed prepare/lint: they now validate args (exit 2 on a missing arg)
// rather than exiting 3 as stubs. Full behavior is pinned in prepare/lint tests.
test('prepare without a workflow exits 2 with usage on stderr', () => {
  const { status, stderr } = runCli(['prepare']);
  assert.equal(status, 2);
  assert.match(stderr, /missing required <workflow>/);
});

test('lint without a target exits 2 with usage on stderr', () => {
  const { status, stderr } = runCli(['lint']);
  assert.equal(status, 2);
  assert.match(stderr, /missing required <workflow-name \| path>/);
});

// C6 landed release: with no session id resolvable it exits 2 (usage error).
// Full behavior is pinned in release-role tests. Run in a clean env so a
// developer's OWENWORK_SESSION cannot leak in.
test('release without a session id exits 2 with usage on stderr', () => {
  const { status, stderr } = runCli(['release'], {
    HOME: mkdtempSync(join(tmpdir(), 'owenwork-dispatch-')),
  });
  assert.equal(status, 2);
  assert.match(stderr, /no session id/);
});

// C6 landed settings: it prints the resolved file against a temp HOME (exit 0),
// even when no file exists. Full behavior is pinned in settings-role tests.
test('settings prints the resolved file and exits 0', () => {
  const { status, stdout } = runCli(['settings'], {
    HOME: mkdtempSync(join(tmpdir(), 'owenwork-dispatch-')),
  });
  assert.equal(status, 0);
  assert.match(stdout, /settings file:/);
  assert.match(stdout, /exists: no/);
});

// settings takes no options in v1 — a stray arg is a usage error (exit 2).
test('settings with a stray arg exits 2', () => {
  const { status, stderr } = runCli(['settings', 'nope'], {
    HOME: mkdtempSync(join(tmpdir(), 'owenwork-dispatch-')),
  });
  assert.equal(status, 2);
  assert.match(stderr, /unexpected argument 'nope'/);
});

// W1 landed join: with no <code> at all it exits 2 on the arg-parse error
// before any origin/network resolution happens.
test('join without a <code> exits 2', () => {
  const { status, stderr } = runCli(['join']);
  assert.equal(status, 2);
  assert.match(stderr, /missing required <code>/);
});

// With a code but no resolvable origin (no --hub, clean HOME) it exits 2 —
// end-to-end wiring proof through the real binary. The temp HOME replaces
// ambient env, so no real settings can leak in.
test('join with a code but no hub origin configured exits 2', () => {
  const { status, stderr } = runCli(['join', 'ojc_x_y'], {
    HOME: mkdtempSync(join(tmpdir(), 'owenwork-dispatch-')),
  });
  assert.equal(status, 2);
  assert.match(stderr, /no hub origin/);
});
