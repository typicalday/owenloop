/**
 * PHASE 6, ITEM 6 — `owenloop work sessions`.
 *
 * WHAT IS ACTUALLY AT RISK HERE. The subcommand is a listing, so the interesting
 * failures are not "does it print rows" — they are:
 *
 *   1. LAYERING. The resume command must come from the adapter contract, not
 *      from a `switch (rec.harness)` in the role. `test/vendor-gate.test.ts`
 *      enforces the absence of the vendor literal; the test here enforces the
 *      PRESENCE of the behavior it was traded for, so the two together cannot be
 *      satisfied by simply deleting the feature.
 *   2. ROBUSTNESS OF A DIAGNOSTIC. This is the tool an operator reaches for when
 *      something already went wrong. A record naming an unregistered harness, or
 *      an adapter that throws, must degrade to a dash — a listing that crashes on
 *      one row is worse than a row with no command.
 *   3. THE `dead` DEFAULT. `src/agent/loop.ts` refuses to resume a `dead`
 *      session, and the store is append-only, so dead rows accumulate forever.
 *      They are hidden unless asked for.
 *   4. AN EMPTY STORE IS NOT AN ERROR. A box that has run no agent orders must
 *      exit 0.
 *
 * Hermetic: the CLI cases run the shipped binary with a REPLACED environment
 * (only `PATH` carries through) against a `mkdtempSync` cache dir, so no
 * developer's real `sessions.jsonl`, settings file, or `$HOME` can reach them.
 * The unit cases drive the exported pure functions against a fake adapter that
 * is registered and unregistered inside the test.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { formatAge, newestPerKey, renderTable, resumeCommandFor } from '../src/roles/sessions.ts';
import { orderId, sessionsPath, type SessionRecord, type SessionStatus } from '../src/harness/session-store.ts';
import { register, unregister } from '../src/harness/registry.ts';
import type { HarnessAdapter, HarnessSessionRef } from '../src/harness/contract.ts';

const BIN = fileURLToPath(new URL('../../../bin/owenloop.mjs', import.meta.url));

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const NOW = 1_700_000_500_000;

function rec(
  over: Partial<SessionRecord> & { run: string; step: string; status: SessionStatus },
): SessionRecord {
  const workflow = over.workflow ?? 'wf1';
  return {
    order: orderId(workflow, over.run),
    attempt: 1,
    harness: 'fake',
    token: `tok-${over.run}-${over.step}`,
    cwd: '/work',
    createdAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...over,
    workflow,
  };
}

/** Seed a cache dir with `records`, oldest first. Returns the cache dir. */
function seedCache(records: SessionRecord[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-sessions-'));
  tmpDirs.push(dir);
  writeFileSync(sessionsPath(dir), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return dir;
}

function runSessions(args: string[], cacheDir?: string): { status: number; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-sessions-home-'));
  tmpDirs.push(home);
  const res = spawnSync(process.execPath, [BIN, 'work', 'sessions', ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      OWENLOOP_CACHE_DIR: cacheDir ?? join(home, 'cache'),
    },
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** A registered adapter whose only real method is `resumeCommand`. */
function fakeAdapter(id: string, over: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    id,
    resumeTier: 'native-token',
    start: () => Promise.reject(new Error('not used')),
    deliver: () => Promise.reject(new Error('not used')),
    stop: () => Promise.resolve(),
    resumeCommand: (ref: HarnessSessionRef) => ({ command: 'fakebin', args: ['--resume', ref.token] }),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 1. The CLI surface
// ---------------------------------------------------------------------------

test('an empty store exits 0 and says so — a box that ran no agent orders is not broken', () => {
  const { status, stdout, stderr } = runSessions([]);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /no sessions recorded/);
});

test('the table lists live sessions and hides dead ones until --all', () => {
  const cache = seedCache([
    rec({ run: 'run-a', step: 'builder', status: 'submitted', harness: 'claude-code' }),
    rec({ run: 'run-b', step: 'reviewer', status: 'dead', harness: 'codex' }),
  ]);

  const plain = runSessions([], cache);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /wf1\/run-a\s+builder/);
  assert.doesNotMatch(plain.stdout, /run-b/, 'a dead session is not actionable — hidden by default');

  const all = runSessions(['--all'], cache);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /run-b\s+reviewer/);
});

test('a store whose every row is dead still exits 0, and says why the table is empty', () => {
  const cache = seedCache([rec({ run: 'run-b', step: 'reviewer', status: 'dead' })]);
  const { status, stdout } = runSessions([], cache);
  assert.equal(status, 0);
  assert.match(stdout, /no live sessions/);
  assert.match(stdout, /--all/, 'the message must name the flag that would show them');
});

test('--json prints the RAW newest-per-step records', () => {
  const cache = seedCache([
    rec({ run: 'run-a', step: 'builder', status: 'active' }),
    rec({ run: 'run-a', step: 'builder', status: 'submitted', updatedAt: NOW }),
  ]);
  const { status, stdout } = runSessions(['--json'], cache);
  assert.equal(status, 0);
  const rows = JSON.parse(stdout) as SessionRecord[];
  assert.equal(rows.length, 1, 'last-wins: one row per (workflow, run, step)');
  assert.equal(rows[0]?.status, 'submitted');
  assert.equal(rows[0]?.token, 'tok-run-a-builder', 'the token is machine-local data the operator owns');
});

test('the real adapters supply a resume command through the contract, not a switch in the role', () => {
  // The counterweight to `test/vendor-gate.test.ts`: that test forbids the
  // vendor literal in `src/roles/sessions.ts`, this one forbids satisfying it by
  // dropping the feature. The binary override is honoured because an operator
  // who set it did so because the plain name does not run on their machine.
  const cache = seedCache([
    rec({ run: 'run-a', step: 'builder', status: 'submitted', harness: 'claude-code', token: 'sess-abc' }),
  ]);
  const home = mkdtempSync(join(tmpdir(), 'owenloop-sessions-home-'));
  tmpDirs.push(home);
  const res = spawnSync(process.execPath, [BIN, 'work', 'sessions'], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      OWENLOOP_CACHE_DIR: cache,
      OWENLOOP_CLAUDE_BIN: '/opt/custom/cli-binary',
    },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\/opt\/custom\/cli-binary .*sess-abc/);
});

test('an unknown option is a usage error, not a silent listing', () => {
  const { status, stderr } = runSessions(['--nope']);
  assert.equal(status, 2);
  assert.match(stderr, /unknown option '--nope'/);
  assert.match(stderr, /usage: owenloop work sessions/);
});

test("sessions is reachable from the CLI's own help", () => {
  const res = spawnSync(process.execPath, [BIN, 'work', '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /owenloop work sessions/);
});

// ---------------------------------------------------------------------------
// 2. The pure pieces — the degradation cases the CLI cannot easily stage
// ---------------------------------------------------------------------------

test('a record naming an unregistered harness renders a dash instead of throwing', () => {
  const row = rec({ run: 'run-a', step: 'builder', status: 'submitted', harness: 'harness-that-was-removed' });
  assert.equal(resumeCommandFor(row), undefined);
  const table = renderTable([row], NOW);
  assert.match(table, /—/, 'no command is a dash, never an exception');
  assert.match(table, /harness-that-was-removed/, 'the row itself still prints');
});

test('an adapter with no resumeCommand renders a dash; one that throws does too', () => {
  const silent = fakeAdapter('fake-silent', { resumeCommand: undefined });
  const thrower = fakeAdapter('fake-thrower', {
    resumeCommand: () => {
      throw new Error('boom');
    },
  });
  register(silent);
  register(thrower);
  try {
    assert.equal(resumeCommandFor(rec({ run: 'r', step: 's', status: 'active', harness: 'fake-silent' })), undefined);
    // A listing must survive one bad adapter: the throw is caught, not propagated.
    assert.equal(resumeCommandFor(rec({ run: 'r', step: 's', status: 'active', harness: 'fake-thrower' })), undefined);
  } finally {
    unregister('fake-silent');
    unregister('fake-thrower');
  }
});

test('the resume command is shell-quoted so an operator can paste it', () => {
  const spaced = fakeAdapter('fake-spaced', {
    resumeCommand: (ref: HarnessSessionRef) => ({
      command: '/Applications/My Tool/bin/cli',
      args: ['resume', ref.token],
    }),
  });
  register(spaced);
  try {
    const out = resumeCommandFor(rec({ run: 'r', step: 's', status: 'active', harness: 'fake-spaced' }));
    assert.equal(out, "'/Applications/My Tool/bin/cli' resume tok-r-s");
  } finally {
    unregister('fake-spaced');
  }
});

test('newestPerKey keeps the last row per (workflow, run, step) and nothing else', () => {
  const rows = newestPerKey([
    rec({ run: 'run-a', step: 'builder', status: 'active' }),
    rec({ run: 'run-a', step: 'builder', status: 'dead' }),
    rec({ workflow: 'wf2', run: 'run-a', step: 'builder', status: 'active' }),
  ]);
  assert.equal(rows.length, 2, 'the same run id under a different workflow is a DIFFERENT session');
  assert.equal(rows[0]?.status, 'dead');
});

test('formatAge is coarse on purpose, and never renders a negative or NaN age', () => {
  assert.equal(formatAge(5_000), '5s');
  assert.equal(formatAge(90_000), '1m');
  assert.equal(formatAge(3 * 3_600_000), '3h');
  assert.equal(formatAge(50 * 3_600_000), '2d');
  // A clock that went backwards between the write and the read must not print
  // something like `-3s`; the row is still worth showing.
  assert.equal(formatAge(-1), '?');
  assert.equal(formatAge(Number.NaN), '?');
});
