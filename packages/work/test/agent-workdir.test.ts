/**
 * `src/agent/workdir.ts` — per-RUN work directories and the gate that removes them.
 *
 * The centrepiece is the `isWorkDirReapable` TRUTH TABLE. That function is pure
 * on purpose (no fs, no hub, no clock) precisely so the dangerous question —
 * "may I delete this directory?" — is decided by a table a human can read, and
 * so a wrong answer shows up here rather than as a run whose files vanished.
 *
 * The three conditions, all of which must clear before a removal is allowed:
 *   1. the hub reports no OPEN order for the run
 *   2. no LIVE `agent-run` child holds the run
 *   3. the grace window has elapsed (`now - lastSeenAt >= ttlMs`)
 *
 * The filesystem-touching functions (`ensureWorkDir`, `reapWorkDir`,
 * `listWorkDirs`) get their own sections against a real temp directory; `git` is
 * injected in worktree mode so no repository is needed.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  ensureWorkDir,
  isUnderWorkRoot,
  isWorkdirAllowed,
  isWorkDirReapable,
  listWorkDirs,
  reapWorkDir,
  resolveAllowedWorkdirRoots,
  resolveWorkRepo,
  resolveWorkRoot,
  runWorkDir,
  sweepWorkDirs,
  type ReapGateInput,
  type ReapWorkDirOptions,
  type WorkDirEntry,
} from '../src/agent/workdir.ts';
import {
  appendSession,
  latestFor,
  orderId,
  sessionsPath,
  type SessionRecord,
} from '../src/harness/session-store.ts';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-workroot-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const set = (...ids: string[]): ReadonlySet<string> => new Set(ids);

// ---- the reap gate: the truth table -----------------------------------------

/** The baseline is REAPABLE. Each row below breaks exactly one condition, so a
 *  failure names the condition rather than "reaping broke". */
const REAPABLE: ReapGateInput = {
  runId: 'run1',
  openRunIds: set(),
  liveRunIds: set(),
  lastSeenAt: 1_000,
  now: 1_000 + 60_000,
  ttlMs: 60_000,
};

interface GateRow {
  name: string;
  over: Partial<ReapGateInput>;
  want: boolean;
  /** Why this row exists — the failure it prevents. */
  because: string;
}

const GATE_ROWS: GateRow[] = [
  {
    name: 'all three conditions clear',
    over: {},
    want: true,
    because: 'nothing is using it and the grace window has passed, so it is garbage',
  },
  {
    name: 'the hub reports an OPEN order for the run',
    over: { openRunIds: set('run1') },
    want: false,
    because: 'a step that has not run yet still needs what upstream steps wrote here',
  },
  {
    name: 'a LIVE agent-run child holds the run',
    over: { liveRunIds: set('run1') },
    want: false,
    because: 'deleting the cwd out from under a running agent is the worst failure this gate can cause',
  },
  {
    name: 'both an open order AND a live child',
    over: { openRunIds: set('run1'), liveRunIds: set('run1') },
    want: false,
    because: 'the conditions are ANDed, not voted on',
  },
  {
    name: 'inside the TTL grace window',
    over: { now: 1_000 + 59_999 },
    want: false,
    because:
      'at the instant a step submits, its downstream orders are not open yet — with no grace window the gate deletes the directory in exactly that gap',
  },
  {
    name: 'exactly at the TTL boundary',
    over: { now: 1_000 + 60_000 },
    want: true,
    because: 'the comparison is `>=`, so the boundary itself is reapable — stated so a later `>` is a test failure',
  },
  {
    name: 'a DIFFERENT run is open and live',
    over: { openRunIds: set('run2'), liveRunIds: set('run2') },
    want: true,
    because: 'the membership tests are keyed by runId — another run\'s activity must not pin this directory forever',
  },
  {
    name: 'ttlMs is 0 and the directory was just touched',
    over: { ttlMs: 0, now: 1_000 },
    want: true,
    because: 'a zero TTL disables the grace window; `0 >= 0` holds',
  },
  {
    name: 'the clock ran backwards',
    over: { now: 500 },
    want: false,
    because: 'a negative elapsed time is never >= a positive ttl, so a clock jump errs toward KEEPING the directory',
  },
];

for (const row of GATE_ROWS) {
  test(`reap gate: ${row.name} ⇒ ${String(row.want)} (${row.because})`, () => {
    assert.equal(isWorkDirReapable({ ...REAPABLE, ...row.over }), row.want);
  });
}

test('the reap gate is pure — the same input twice gives the same answer and mutates nothing', () => {
  const open = set('run2');
  const live = set('run3');
  const input: ReapGateInput = { ...REAPABLE, openRunIds: open, liveRunIds: live };
  assert.equal(isWorkDirReapable(input), true);
  assert.equal(isWorkDirReapable(input), true);
  assert.deepEqual([...open], ['run2']);
  assert.deepEqual([...live], ['run3']);
});

// ---- path resolution ---------------------------------------------------------

test('runWorkDir is <workRoot>/<workflow>/<run> and touches nothing', () => {
  assert.equal(runWorkDir('/w', 'wf1', 'run1'), join('/w', 'wf1', 'run1'));
  assert.ok(!existsSync(join('/w', 'wf1', 'run1')));
});

test('resolveWorkRoot: env > settings > <cacheDir>/work', () => {
  assert.equal(resolveWorkRoot({ OWENLOOP_WORK_ROOT: '/from/env' }, '/from/settings', '/cache'), '/from/env');
  assert.equal(resolveWorkRoot({}, '/from/settings', '/cache'), '/from/settings');
  assert.equal(resolveWorkRoot({}, undefined, '/cache'), join('/cache', 'work'));
  // Blank is not a value at either rank — otherwise an empty env var would
  // silently disable the settings key.
  assert.equal(resolveWorkRoot({ OWENLOOP_WORK_ROOT: '  ' }, '/from/settings', '/cache'), '/from/settings');
  assert.equal(resolveWorkRoot({ OWENLOOP_WORK_ROOT: '  ' }, '   ', '/cache'), join('/cache', 'work'));
});

test('resolveWorkRepo: env > settings > undefined (no default repo)', () => {
  assert.equal(resolveWorkRepo({ OWENLOOP_WORK_REPO: '/from/env' }, '/from/settings'), '/from/env');
  assert.equal(resolveWorkRepo({}, '/from/settings'), '/from/settings');
  assert.equal(resolveWorkRepo({}, undefined), undefined);
  assert.equal(resolveWorkRepo({ OWENLOOP_WORK_REPO: '' }, ''), undefined);
});

test('isUnderWorkRoot admits descendants, and rejects the root itself, siblings, and escapes', () => {
  assert.equal(isUnderWorkRoot('/w/wf1/run1', '/w'), true);
  assert.equal(isUnderWorkRoot('/w/wf1', '/w'), true);

  // The root holds every OTHER run's directory. Removing it would take them all.
  assert.equal(isUnderWorkRoot('/w', '/w'), false);
  assert.equal(isUnderWorkRoot('/w/', '/w'), false);

  assert.equal(isUnderWorkRoot('/other/wf1/run1', '/w'), false);
  assert.equal(isUnderWorkRoot('/', '/w'), false);
  // A `..` cannot smuggle a path back out past the check, because both sides are
  // resolved to absolutes first.
  assert.equal(isUnderWorkRoot('/w/wf1/../../etc', '/w'), false);
  // ...and a prefix match is not a containment match: `/workshop` is not in `/w`.
  assert.equal(isUnderWorkRoot('/workshop/run1', '/w'), false);
});

// ---- operator-declared work roots -------------------------------------------
//
// A DIFFERENT question from `workRoot`, and the two are deliberately not
// related: `workRoot` is the ONE directory owenloop creates run directories
// under; `allowedWorkdirRoots` is the SET of directories an ORDER is allowed to
// name as its working directory. Nothing derives one from the other.

test('resolveAllowedWorkdirRoots: env REPLACES settings, and every root comes back absolute', () => {
  // The env var is `:`-separated, like PATH, because that is the shape
  // `owenloop shift start` can hand a detached child through the spawn env.
  assert.deepEqual(
    resolveAllowedWorkdirRoots({ OWENLOOP_ALLOWED_WORKDIR_ROOTS: '/a:/b' }, ['/from/settings'], '/cwd'),
    ['/a', '/b'],
  );
  assert.deepEqual(resolveAllowedWorkdirRoots({}, ['/from/settings'], '/cwd'), ['/from/settings']);

  // Empty entries and surrounding whitespace are dropped, not turned into '/'.
  assert.deepEqual(
    resolveAllowedWorkdirRoots({ OWENLOOP_ALLOWED_WORKDIR_ROOTS: ' /a : : /b ' }, undefined, '/cwd'),
    ['/a', '/b'],
  );

  // A relative root resolves against the SUPPLIED cwd, never process.cwd().
  assert.deepEqual(
    resolveAllowedWorkdirRoots({ OWENLOOP_ALLOWED_WORKDIR_ROOTS: 'code' }, undefined, '/home/me'),
    ['/home/me/code'],
  );

  // An unset or blank env var falls THROUGH to settings rather than clearing it.
  assert.deepEqual(resolveAllowedWorkdirRoots({ OWENLOOP_ALLOWED_WORKDIR_ROOTS: '  ' }, ['/s'], '/cwd'), ['/s']);
  assert.deepEqual(resolveAllowedWorkdirRoots({}, undefined, '/cwd'), []);
});

test('isWorkdirAllowed: no roots means NO restriction, and the root itself counts as inside', () => {
  // DEFAULT-OPEN. Every shift running today declared nothing, and default-closed
  // would silently stop all of them.
  assert.equal(isWorkdirAllowed('/anywhere/at/all', []), true);

  // INCLUSIVE OF THE ROOT — the opposite of `isUnderWorkRoot`, which excludes
  // the root because it guards a DELETION. This guards permission to WORK in a
  // directory, and an operator who names `/code` means `/code` too.
  assert.equal(isWorkdirAllowed('/code', ['/code']), true);
  assert.equal(isWorkdirAllowed('/code/proj/wt/x', ['/code']), true);

  assert.equal(isWorkdirAllowed('/elsewhere', ['/code']), false);
  // A prefix match is not a containment match.
  assert.equal(isWorkdirAllowed('/codex/proj', ['/code']), false);
  // `..` cannot smuggle a path out: both sides are resolved first.
  assert.equal(isWorkdirAllowed('/code/../etc', ['/code']), false);
  // ANY root admitting it is enough.
  assert.equal(isWorkdirAllowed('/srv/app', ['/code', '/srv']), true);
});

// ---- ensureWorkDir -----------------------------------------------------------

test('ensureWorkDir creates <workRoot>/<workflow>/<run> and is idempotent', () => {
  const dir = ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run1' });
  assert.equal(dir, join(root, 'wf1', 'run1'));
  assert.ok(existsSync(dir));

  // EVERY STEP OF A RUN CALLS THIS. The second call must adopt, never recreate —
  // recreating would delete what the upstream step just wrote.
  writeFileSync(join(dir, 'upstream-output.txt'), 'kept');
  const again = ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run1' });
  assert.equal(again, dir);
  assert.ok(existsSync(join(dir, 'upstream-output.txt')));
});

test('ensureWorkDir in worktree mode runs `git worktree add -b <branch>` in the repo', () => {
  const seen: Array<{ args: string[]; cwd: string }> = [];
  const dir = ensureWorkDir({
    workRoot: root,
    workflow: 'wf1',
    run: 'run1',
    workRepo: '/repo',
    runGit: (args, cwd) => {
      seen.push({ args, cwd });
      return { status: 0, output: '' };
    },
  });

  assert.equal(dir, join(root, 'wf1', 'run1'));
  assert.equal(seen.length, 1, 'the first form succeeded, so there is no second attempt');
  assert.deepEqual(seen[0]!.args, ['worktree', 'add', '-b', `owenloop/wf1/run1`, dir]);
  assert.equal(seen[0]!.cwd, '/repo', 'git runs in the REPO, not in the work dir being created');
  // The parent exists (git makes the leaf), but git was the one that made the leaf.
  assert.ok(existsSync(join(root, 'wf1')));
});

test('a caller-supplied branch overrides the default owenloop/<workflow>/<run>', () => {
  const seen: string[][] = [];
  ensureWorkDir({
    workRoot: root,
    workflow: 'wf1',
    run: 'run1',
    workRepo: '/repo',
    branch: 'my-branch',
    runGit: (args) => {
      seen.push(args);
      return { status: 0, output: '' };
    },
  });
  assert.deepEqual(seen[0], ['worktree', 'add', '-b', 'my-branch', join(root, 'wf1', 'run1')]);
});

test('a branch that already exists retries `git worktree add <dir> <branch>` without -b', () => {
  const seen: string[][] = [];
  ensureWorkDir({
    workRoot: root,
    workflow: 'wf1',
    run: 'run1',
    workRepo: '/repo',
    runGit: (args) => {
      seen.push(args);
      return { status: args.includes('-b') ? 128 : 0, output: 'fatal: branch already exists' };
    },
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], ['worktree', 'add', join(root, 'wf1', 'run1'), 'owenloop/wf1/run1']);
});

test('worktree mode DEGRADES to a plain directory rather than failing the order', () => {
  const errs: string[] = [];
  const dir = ensureWorkDir({
    workRoot: root,
    workflow: 'wf1',
    run: 'run1',
    workRepo: '/repo',
    err: (l) => errs.push(l),
    runGit: () => ({ status: 128, output: 'fatal: not a git repository' }),
  });

  // A misconfigured `workRepo` must not turn into a stuck run: the agent still
  // gets somewhere to work, and the reason is REPORTED rather than swallowed.
  assert.ok(existsSync(dir));
  assert.equal(errs.length, 1);
  assert.match(errs[0]!, /git worktree add for wf1\/run1 failed \(fatal: not a git repository\)/);
  assert.match(errs[0]!, /using a plain directory instead/);
});

// ---- reapWorkDir -------------------------------------------------------------

test("reapWorkDir REFUSES a directory outside workRoot — the hub's own workdir is untouchable", () => {
  const outside = mkdtempSync(join(tmpdir(), 'owenloop-not-ours-'));
  try {
    assert.equal(reapWorkDir({ dir: outside, workRoot: root }), 'refused');
    assert.ok(existsSync(outside), 'refused means UNTOUCHED, not "tried and failed"');
    // The root itself is outside by the same rule.
    assert.equal(reapWorkDir({ dir: root, workRoot: root }), 'refused');
    assert.ok(existsSync(root));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('reapWorkDir removes a real directory and reports absent for one already gone', () => {
  const dir = ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run1' });
  writeFileSync(join(dir, 'f.txt'), 'x');
  mkdirSync(join(dir, 'nested', 'deep'), { recursive: true });

  assert.equal(reapWorkDir({ dir, workRoot: root }), 'removed');
  assert.ok(!existsSync(dir));
  assert.equal(reapWorkDir({ dir, workRoot: root }), 'absent');
  // The workflow directory and the root survive — only the run directory goes.
  assert.ok(existsSync(join(root, 'wf1')));
});

test('worktree mode removes via git, and does not fall through to rm when git succeeds', () => {
  const dir = ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run1' });
  const seen: string[][] = [];
  const result = reapWorkDir({
    dir,
    workRoot: root,
    workRepo: '/repo',
    runGit: (args) => {
      seen.push(args);
      return { status: 0, output: '' };
    },
  });
  assert.equal(result, 'removed');
  assert.deepEqual(seen, [['worktree', 'remove', '--force', dir]]);
  // git was faked, so the directory is still there — which is precisely how we
  // know `rmSync` did NOT also run.
  assert.ok(existsSync(dir));
});

test('when git refuses the worktree, the fallback prunes and removes the directory anyway', () => {
  const dir = ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run1' });
  const seen: string[][] = [];
  const result = reapWorkDir({
    dir,
    workRoot: root,
    workRepo: '/repo',
    runGit: (args) => {
      seen.push(args);
      return { status: 1, output: 'fatal: contains modified or untracked files' };
    },
  });

  assert.equal(result, 'removed');
  // The prune matters as much as the rm: without it the repo keeps a dangling
  // worktree entry pointing at a directory that no longer exists.
  assert.deepEqual(seen, [['worktree', 'remove', '--force', dir], ['worktree', 'prune']]);
  assert.ok(!existsSync(dir));
});

test('a throwing git is reported and still falls back to rm — removal never throws', () => {
  const dir = ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run1' });
  const errs: string[] = [];
  const result = reapWorkDir({
    dir,
    workRoot: root,
    workRepo: '/repo',
    err: (l) => errs.push(l),
    runGit: () => {
      throw new Error('git is not installed');
    },
  });
  assert.equal(result, 'removed');
  assert.ok(!existsSync(dir));
  assert.equal(errs.length, 1);
  assert.match(errs[0]!, /git worktree remove .* failed .*git is not installed.* falling back to rm/);
});

// ---- listWorkDirs ------------------------------------------------------------

test('listWorkDirs reports one entry per run directory, with the directory mtime as lastSeenAt', () => {
  ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run1' });
  ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run2' });
  const stamped = ensureWorkDir({ workRoot: root, workflow: 'wf2', run: 'run3' });
  utimesSync(stamped, new Date(1_000_000), new Date(1_000_000));

  const all = listWorkDirs(root, set('wf1', 'wf2'));
  assert.deepEqual(
    all.map((e) => `${e.workflow}/${e.runId}`).sort(),
    ['wf1/run1', 'wf1/run2', 'wf2/run3'],
  );
  const one = all.find((e) => e.runId === 'run3')!;
  assert.equal(one.dir, join(root, 'wf2', 'run3'));
  assert.equal(Math.round(one.lastSeenAt), 1_000_000);
});

test('listWorkDirs is SCOPED to the given workflows, and skips files and missing directories', () => {
  ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run1' });
  ensureWorkDir({ workRoot: root, workflow: 'wf2', run: 'run2' });
  writeFileSync(join(root, 'wf1', 'stray-file'), 'not a run');

  // A shift started with `--workflow wf1` only ever learns which of wf1's orders
  // are open. Judging wf2's directories against that list would make every one of
  // them look abandoned, so they are never even listed.
  const only = listWorkDirs(root, set('wf1'));
  assert.deepEqual(only.map((e) => e.runId), ['run1']);

  // A workflow with no directory yet is not an error.
  assert.deepEqual(listWorkDirs(root, set('wf-never-run')), []);
});

// ---- sweepWorkDirs -----------------------------------------------------------

const entry = (runId: string, lastSeenAt: number): WorkDirEntry => ({
  workflow: 'wf1',
  runId,
  dir: join('/w', 'wf1', runId),
  lastSeenAt,
});

test('the sweep applies the gate per entry and removes only the ones that pass', () => {
  const asked: string[] = [];
  const removed = sweepWorkDirs({
    workRoot: '/w',
    workflows: set('wf1'),
    openRunIds: set('run-open'),
    liveRunIds: set('run-live'),
    now: 100_000,
    ttlMs: 60_000,
    list: () => [
      entry('run-open', 0), // pinned by an open order
      entry('run-live', 0), // pinned by a live child
      entry('run-fresh', 99_000), // inside the grace window
      entry('run-cold', 0), // reapable
    ],
    remove: (o: ReapWorkDirOptions) => {
      asked.push(o.dir);
      return 'removed';
    },
  });

  assert.deepEqual(asked, [join('/w', 'wf1', 'run-cold')], 'the pinned entries are never even offered for removal');
  assert.deepEqual(removed, [join('/w', 'wf1', 'run-cold')]);
});

test('the sweep counts only removals — refused, absent and failed do not appear in the result', () => {
  const removed = sweepWorkDirs({
    workRoot: '/w',
    workflows: set('wf1'),
    openRunIds: set(),
    liveRunIds: set(),
    now: 100_000,
    ttlMs: 0,
    list: () => [entry('a', 0), entry('b', 0), entry('c', 0), entry('d', 0)],
    remove: (o: ReapWorkDirOptions) => {
      if (o.dir.endsWith('a')) return 'removed';
      if (o.dir.endsWith('b')) return 'absent';
      if (o.dir.endsWith('c')) return 'refused';
      return 'failed';
    },
  });
  assert.deepEqual(removed, [join('/w', 'wf1', 'a')]);
});

test('the sweep passes workRepo and err through, so worktree removal works in production', () => {
  const seen: ReapWorkDirOptions[] = [];
  sweepWorkDirs({
    workRoot: '/w',
    workflows: set('wf1'),
    openRunIds: set(),
    liveRunIds: set(),
    now: 1,
    ttlMs: 0,
    workRepo: '/repo',
    err: () => undefined,
    list: () => [entry('a', 0)],
    remove: (o) => {
      seen.push(o);
      return 'removed';
    },
  });
  assert.equal(seen[0]!.workRoot, '/w');
  assert.equal(seen[0]!.workRepo, '/repo');
  assert.notEqual(seen[0]!.err, undefined);
});

test('a scan that throws is reported and yields an empty sweep — a sweep must not die over a directory', () => {
  const errs: string[] = [];
  const removed = sweepWorkDirs({
    workRoot: '/w',
    workflows: set('wf1'),
    openRunIds: set(),
    liveRunIds: set(),
    now: 1,
    ttlMs: 0,
    err: (l) => errs.push(l),
    list: () => {
      throw new Error('EACCES');
    },
    remove: () => 'removed',
  });
  assert.deepEqual(removed, []);
  assert.equal(errs.length, 1);
  assert.match(errs[0]!, /could not scan work directories under \/w: .*EACCES.*\(ignored\)/);
});

test('END TO END on a real filesystem: the sweep removes the cold run and keeps the pinned ones', () => {
  const open = ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run-open' });
  const live = ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run-live' });
  const cold = ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run-cold' });
  writeFileSync(join(cold, 'garbage.txt'), 'x');
  for (const d of [open, live, cold]) utimesSync(d, new Date(0), new Date(0));

  const removed = sweepWorkDirs({
    workRoot: root,
    workflows: set('wf1'),
    openRunIds: set('run-open'),
    liveRunIds: set('run-live'),
    now: Date.now(),
    ttlMs: 60_000,
  });

  assert.deepEqual(removed, [cold]);
  assert.ok(!existsSync(cold));
  assert.ok(existsSync(open));
  assert.ok(existsSync(live));
  assert.ok(existsSync(resolve(root)), 'the work root itself is never a candidate');
});

// ---- the teardown gate: session lifetime = cwd lifetime ----------------------
//
// Removing the directory is only half of it. The session record for the same
// `(workflow, run, step)` outlives the directory, and the next firing RECREATES
// the directory at the same path (`ensureWorkDir` is idempotent by design), so
// the runner's `dirExists(prev.cwd)` and `prev.cwd === recordCwd` guards both
// pass again and a stale session resumes into an empty tree. The sweep therefore
// marks the run's sessions `dead` BEFORE it removes anything.

const sessionRec = (over: Partial<SessionRecord> = {}): SessionRecord => {
  const workflow = over.workflow ?? 'wf1';
  const run = over.run ?? 'run-cold';
  return {
    workflow,
    run,
    step: 'builder',
    order: orderId(workflow, run),
    attempt: 1,
    harness: 'fake',
    token: 'tok-1',
    cwd: join('/w', workflow, run),
    status: 'submitted',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
};

test('the sweep RETIRES the reaped run\'s sessions, and only the reaped run\'s', () => {
  const file = sessionsPath(root);
  appendSession(file, sessionRec({ run: 'run-cold', step: 'builder' }));
  appendSession(file, sessionRec({ run: 'run-cold', step: 'reviewer' }));
  appendSession(file, sessionRec({ run: 'run-open', step: 'builder' }));

  sweepWorkDirs({
    workRoot: '/w',
    workflows: set('wf1'),
    openRunIds: set('run-open'),
    liveRunIds: set(),
    now: 100_000,
    ttlMs: 0,
    sessionsFile: file,
    list: () => [entry('run-open', 0), entry('run-cold', 0)],
    remove: () => 'removed',
  });

  assert.equal(latestFor(file, 'wf1', 'run-cold', 'builder')?.status, 'dead');
  assert.equal(
    latestFor(file, 'wf1', 'run-cold', 'reviewer')?.status,
    'dead',
    'the work dir is per RUN, so every step that lived in it dies with it',
  );
  assert.equal(
    latestFor(file, 'wf1', 'run-open', 'builder')?.status,
    'submitted',
    'a run the gate refused is not touched at all',
  );
});

test('retire runs BEFORE the removal — the invariant can never be observed broken', () => {
  const order: string[] = [];
  sweepWorkDirs({
    workRoot: '/w',
    workflows: set('wf1'),
    openRunIds: set(),
    liveRunIds: set(),
    now: 100_000,
    ttlMs: 0,
    sessionsFile: join(root, 'sessions.jsonl'),
    list: () => [entry('run-cold', 0)],
    retire: () => {
      order.push('retire');
      return ['builder'];
    },
    remove: () => {
      order.push('remove');
      return 'removed';
    },
  });
  assert.deepEqual(order, ['retire', 'remove']);
});

test('a retire that FAILS leaves the directory in place — fail-safe, not best-effort', () => {
  const errs: string[] = [];
  const asked: string[] = [];
  const removed = sweepWorkDirs({
    workRoot: '/w',
    workflows: set('wf1'),
    openRunIds: set(),
    liveRunIds: set(),
    now: 100_000,
    ttlMs: 0,
    sessionsFile: join(root, 'sessions.jsonl'),
    err: (l) => errs.push(l),
    list: () => [entry('run-cold', 0), entry('run-other', 0)],
    retire: (_f, _wf, run) => {
      if (run === 'run-cold') throw new Error('EROFS');
      return [];
    },
    remove: (o) => {
      asked.push(o.dir);
      return 'removed';
    },
  });

  assert.deepEqual(
    asked,
    [join('/w', 'wf1', 'run-other')],
    'the run whose sessions could not be retired is never offered for removal',
  );
  assert.deepEqual(removed, [join('/w', 'wf1', 'run-other')], 'and the sweep goes on with the rest');
  assert.match(errs.join('\n'), /could not retire the sessions for wf1\/run-cold: .*EROFS.* leaving .* in place/);
});

test('no sessionsFile ⇒ no retirement (the pure truth-table callers), and the sweep still removes', () => {
  const removed = sweepWorkDirs({
    workRoot: '/w',
    workflows: set('wf1'),
    openRunIds: set(),
    liveRunIds: set(),
    now: 100_000,
    ttlMs: 0,
    list: () => [entry('run-cold', 0)],
    retire: () => {
      throw new Error('must not be called without a sessions file');
    },
    remove: () => 'removed',
  });
  assert.deepEqual(removed, [join('/w', 'wf1', 'run-cold')]);
});

test('END TO END on a real filesystem: the reaped run\'s session reads dead, so a resume is impossible', () => {
  const cold = ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run-cold' });
  writeFileSync(join(cold, 'work.txt'), 'the agent\'s output');
  utimesSync(cold, new Date(0), new Date(0));

  const file = sessionsPath(join(root, 'cache'));
  appendSession(file, sessionRec({ run: 'run-cold', cwd: cold, status: 'submitted', deliveredReasonAt: 900 }));

  const removed = sweepWorkDirs({
    workRoot: root,
    workflows: set('wf1'),
    openRunIds: set(),
    liveRunIds: set(),
    now: Date.now(),
    ttlMs: 60_000,
    sessionsFile: file,
  });

  assert.deepEqual(removed, [cold]);
  assert.ok(!existsSync(cold), 'the work is gone');

  const latest = latestFor(file, 'wf1', 'run-cold', 'builder');
  assert.equal(latest?.status, 'dead', 'session lifetime = cwd lifetime');
  assert.equal(latest?.token, 'tok-1', 'the token is still recorded — it is the STATUS that bars the resume');
  assert.equal(latest?.deliveredReasonAt, 900, 'and the watermark still says what that session had heard');

  // The next firing recreates the SAME path — which is exactly why the status,
  // not the directory's existence, has to be the thing that refuses the resume.
  const again = ensureWorkDir({ workRoot: root, workflow: 'wf1', run: 'run-cold' });
  assert.equal(again, cold);
  assert.ok(!existsSync(join(again, 'work.txt')), 'recreated empty — resuming into it would revise files that are gone');
  assert.equal(latestFor(file, 'wf1', 'run-cold', 'builder')?.status, 'dead');
});
