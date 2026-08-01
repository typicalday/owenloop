/**
 * Phase 4 — per-RUN agent working directories, and the gate that removes them.
 *
 * ── WHAT A WORK DIRECTORY IS ──
 *
 * One directory per RUN, at `<workRoot>/<workflow>/<run>/`. Every step of a run
 * shares it. That is deliberate and load-bearing twice over:
 *
 *  1. A downstream step can read what an upstream step wrote, which per-STEP
 *     directories would make impossible without copying.
 *  2. The removal question collapses from "does any pending downstream step
 *     consume this output?" (a `consumes` / `expected_outputs` walk, with a false
 *     negative for any step the hub has not offered yet) into "does this run
 *     still have an open order?" — one set membership test.
 *
 * ── THE THREE-STEP CWD PRECEDENCE ──
 *
 *  1. `OrderPacket.workdir`, when the hub set it. The hub always wins.
 *  2. Otherwise `<workRoot>/<workflow>/<run>/`, created on first use.
 *  3. Otherwise (no `workRoot` resolvable) the dispatching process's own cwd,
 *     which is the pre-Phase-4 behaviour.
 *
 * A directory reached by rule 1 is the HUB's, not owenwork's, and `reapWorkDir`
 * refuses to touch it — see `isUnderWorkRoot`.
 *
 * ── PLAIN DIR VS GIT WORKTREE ──
 *
 * `workRepo` (a settings key, machine-local) decides. Unset ⇒ `mkdir -p`. Set ⇒
 * `git worktree add`. It is machine-local rather than workflow-declared because
 * nothing in `src/bundle/types.ts` or `src/hub/types.ts` lets a workflow declare
 * a repo, and adding a field there would be a hub protocol change — an explicit
 * effort non-goal.
 *
 * Failure stance: provisioning propagates its failure (a runner with no place to
 * work should say so); REMOVAL is best-effort and never throws, because it runs
 * inside the proxy sweep and a sweep must not die over a directory.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { markRunSessionsDead } from '../harness/session-store.ts';

/**
 * `<workRoot>/<workflow>/<run>` — the one place the layout is spelled out.
 * Pure: no I/O, so callers can compute a path without creating anything.
 */
export function runWorkDir(workRoot: string, workflow: string, run: string): string {
  return join(workRoot, workflow, run);
}

/**
 * Resolve the work root: `OWENWORK_WORK_ROOT` > `settings.workRoot` >
 * `<cacheDir>/work`. Mirrors `resolveCacheDir`'s precedence shape exactly, so
 * there is one rule to remember for both.
 */
export function resolveWorkRoot(
  env: Record<string, string | undefined>,
  settingsWorkRoot: string | undefined,
  cacheDir: string,
): string {
  const override = env['OWENWORK_WORK_ROOT'];
  if (override !== undefined && override.trim() !== '') return override;
  if (settingsWorkRoot !== undefined && settingsWorkRoot.trim() !== '') return settingsWorkRoot;
  return join(cacheDir, 'work');
}

/** `OWENWORK_WORK_REPO` > `settings.workRepo` > none. */
export function resolveWorkRepo(
  env: Record<string, string | undefined>,
  settingsWorkRepo: string | undefined,
): string | undefined {
  const override = env['OWENWORK_WORK_REPO'];
  if (override !== undefined && override.trim() !== '') return override;
  if (settingsWorkRepo !== undefined && settingsWorkRepo.trim() !== '') return settingsWorkRepo;
  return undefined;
}

/**
 * Is `dir` inside `root`? The guard that keeps removal to directories owenwork
 * created.
 *
 * Both paths are resolved to absolutes first, so a relative `workRoot` or a
 * `..`-bearing directory cannot smuggle a path outside the root past the check.
 * `dir === root` returns FALSE on purpose: the root itself holds every other
 * run's directory and must never be removed.
 */
export function isUnderWorkRoot(dir: string, workRoot: string): boolean {
  const rel = relative(resolve(workRoot), resolve(dir));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface EnsureWorkDirOptions {
  workRoot: string;
  workflow: string;
  run: string;
  /** When set, provision as a git worktree of this repo instead of a plain dir. */
  workRepo?: string;
  /** Branch name for the worktree. Default `owenwork/<workflow>/<run>`. */
  branch?: string;
  /** Progress/warning sink. */
  err?: (line: string) => void;
  /** Injected for tests. Defaults to `node:child_process` `spawnSync`. */
  runGit?: (args: string[], cwd: string) => { status: number | null; output: string };
}

function defaultRunGit(args: string[], cwd: string): { status: number | null; output: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/**
 * Create (or adopt) the per-run work directory and return its absolute path.
 *
 * IDEMPOTENT. Every step of a run calls this, and the second and later calls
 * must be no-ops that hand back the same directory — that is the whole point of
 * a per-run directory. An existing directory is therefore adopted, never
 * recreated and never cleaned.
 *
 * WORKTREE MODE. `git worktree add -b <branch> <dir>` against `workRepo`. A
 * failure DEGRADES to a plain directory rather than failing the order: the agent
 * can still work, it just does not get git isolation, and the reason is reported.
 * The alternative — refusing the order — would turn a misconfigured `workRepo`
 * into a stuck run, which is strictly worse than a degraded one.
 */
export function ensureWorkDir(o: EnsureWorkDirOptions): string {
  const dir = runWorkDir(o.workRoot, o.workflow, o.run);
  if (existsSync(dir)) return dir;

  if (o.workRepo !== undefined && o.workRepo !== '') {
    mkdirSync(join(dir, '..'), { recursive: true });
    const branch = o.branch ?? `owenwork/${o.workflow}/${o.run}`;
    const git = o.runGit ?? defaultRunGit;
    const added = git(['worktree', 'add', '-b', branch, dir], o.workRepo);
    if (added.status === 0) return dir;
    // A re-run against an existing branch is the common second failure; try once
    // without `-b` before giving up on worktree mode.
    const reused = git(['worktree', 'add', dir, branch], o.workRepo);
    if (reused.status === 0) return dir;
    o.err?.(
      `owenloop work: git worktree add for ${o.workflow}/${o.run} failed (${added.output || 'no output'}) — using a plain directory instead`,
    );
  }

  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---- the removal gate -------------------------------------------------------

/**
 * Default grace window before an idle work directory may be reaped: 1 hour.
 *
 * A run momentarily between orders (delivered, waiting on the next step) still
 * owns its directory, so the sweep must not remove it the instant the child
 * exits. One hour is deliberately coarse — the cost of keeping a stale directory
 * an hour longer is disk, while the cost of removing a live one is a lost
 * working tree.
 */
export const DEFAULT_WORK_DIR_TTL_MS = 60 * 60 * 1000;

export interface ReapGateInput {
  /** The run whose work directory is a candidate. */
  runId: string;
  /** Runs the hub currently reports an OPEN order for. */
  openRunIds: ReadonlySet<string>;
  /** Runs a LIVE `agent-run` child is holding — liveness by `kill(pid,0)`. */
  liveRunIds: ReadonlySet<string>;
  /** When the directory was last observed in use (mtime, or the in-flight record). */
  lastSeenAt: number;
  now: number;
  /** Grace window. A run momentarily between orders must not be reaped. */
  ttlMs: number;
}

/**
 * May this run's work directory be removed?
 *
 * PURE — no filesystem, no hub, no clock. That is what lets the truth table be a
 * unit test instead of an integration test.
 *
 * True only when ALL THREE hold:
 *  - the hub reports NO open order for the run (`!openRunIds.has(runId)`), and
 *  - no live `agent-run` child holds it (`!liveRunIds.has(runId)`), and
 *  - the grace window has elapsed (`now - lastSeenAt >= ttlMs`).
 *
 * WHY THE GRACE WINDOW. At the instant a step submits, its downstream orders
 * usually are not open yet. A gate with no TTL would see "no open orders, no live
 * child" in exactly that gap and delete the directory a moment before the next
 * step needs it.
 *
 * WHY THIS RUNS IN THE PROXY SWEEP AND NOT IN THE RUNNER AT EXIT: same reason,
 * from the other side. A runner asking "is anything still open?" as it exits is
 * asking during that gap, every time.
 */
export function isWorkDirReapable(g: ReapGateInput): boolean {
  if (g.openRunIds.has(g.runId)) return false;
  if (g.liveRunIds.has(g.runId)) return false;
  return g.now - g.lastSeenAt >= g.ttlMs;
}

export interface ReapWorkDirOptions {
  dir: string;
  workRoot: string;
  workRepo?: string;
  err?: (line: string) => void;
  runGit?: (args: string[], cwd: string) => { status: number | null; output: string };
}

/** What `reapWorkDir` did, so a sweep can count and log without re-deriving it. */
export type ReapResult = 'removed' | 'absent' | 'refused' | 'failed';

/**
 * Remove one per-run work directory. BEST EFFORT — never throws, so a sweep can
 * call it in a loop without a try/catch per entry.
 *
 *  - `'refused'`: the path is not under `workRoot`. This is the guard that keeps
 *    a hub-supplied `OrderPacket.workdir` — someone else's directory, which
 *    owenwork did not create — out of reach no matter what the gate said.
 *  - `'absent'`: nothing there; already gone.
 *  - `'removed'` / `'failed'`: the removal ran and did or did not succeed.
 *
 * Worktree mode removes with `git worktree remove --force`; if git refuses (a
 * dirty tree it will not discard, a repo that has forgotten the worktree), it
 * falls back to `git worktree prune` plus `rm -rf`, so the directory goes away
 * and the repo's worktree list does not keep a dangling entry.
 */
export function reapWorkDir(o: ReapWorkDirOptions): ReapResult {
  if (!isUnderWorkRoot(o.dir, o.workRoot)) return 'refused';
  if (!existsSync(o.dir)) return 'absent';

  if (o.workRepo !== undefined && o.workRepo !== '') {
    const git = o.runGit ?? defaultRunGit;
    try {
      const removed = git(['worktree', 'remove', '--force', o.dir], o.workRepo);
      if (removed.status === 0) return 'removed';
      git(['worktree', 'prune'], o.workRepo);
    } catch (e) {
      o.err?.(`owenloop work: git worktree remove ${o.dir} failed (${String(e)}) — falling back to rm`);
    }
  }

  try {
    rmSync(o.dir, { recursive: true, force: true });
    return 'removed';
  } catch (e) {
    o.err?.(`owenloop work: could not remove work directory ${o.dir}: ${String(e)} (ignored)`);
    return 'failed';
  }
}

// ---- the sweep --------------------------------------------------------------

/** One candidate directory the sweep found on disk. */
export interface WorkDirEntry {
  workflow: string;
  runId: string;
  dir: string;
  /** Last modification time of the run directory itself, in ms. */
  lastSeenAt: number;
}

/**
 * Every `<workRoot>/<workflow>/<run>` directory for the given workflows.
 *
 * SCOPED TO `workflows` ON PURPOSE, not a blind walk of `workRoot`. A proxy
 * started with `--workflow wf1` only ever learns which of wf1's orders are open;
 * it knows nothing about wf2's. Letting it consider wf2's directories would mean
 * judging them against an order list that structurally cannot mention them —
 * every one would look abandoned. So the sweep sees only what the caller has
 * evidence about.
 *
 * Unreadable directories are skipped rather than thrown over; the sweep is
 * best-effort throughout.
 */
export function listWorkDirs(workRoot: string, workflows: ReadonlySet<string>): WorkDirEntry[] {
  const out: WorkDirEntry[] = [];
  for (const workflow of workflows) {
    const wfDir = join(workRoot, workflow);
    let runs: string[];
    try {
      runs = readdirSync(wfDir);
    } catch {
      continue; // no directory for this workflow yet
    }
    for (const runId of runs) {
      const dir = join(wfDir, runId);
      try {
        const st = statSync(dir);
        if (!st.isDirectory()) continue;
        out.push({ workflow, runId, dir, lastSeenAt: st.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  return out;
}

export interface SweepWorkDirsOptions {
  workRoot: string;
  /** Workflows the caller has a current order list for. */
  workflows: ReadonlySet<string>;
  /** Runs the hub reports an open order for, across those workflows. */
  openRunIds: ReadonlySet<string>;
  /** Runs a live `agent-run` child holds. */
  liveRunIds: ReadonlySet<string>;
  now: number;
  ttlMs: number;
  workRepo?: string;
  err?: (line: string) => void;
  /**
   * `<cacheDir>/sessions.jsonl` (`sessionsPath`). PRESENT IN PRODUCTION, and the
   * thing that makes the teardown gate a gate: before a directory is removed,
   * every session of that run is marked `dead` in this file, so the next firing
   * cannot resume into the recreated (empty) directory.
   *
   * Optional only so the pure truth-table tests can drive the gate with no store
   * on disk. Omitting it in production would reopen exactly the hole this field
   * closes.
   */
  sessionsFile?: string;
  /** Injected for tests, so the truth table needs no filesystem. */
  list?: (workRoot: string, workflows: ReadonlySet<string>) => WorkDirEntry[];
  /** Injected for tests. */
  remove?: (o: ReapWorkDirOptions) => ReapResult;
  /** Injected for tests. Defaults to `markRunSessionsDead` from the session store. */
  retire?: typeof markRunSessionsDead;
}

/**
 * Apply `isWorkDirReapable` to every candidate, RETIRE that run's sessions, and
 * remove the ones that pass. Returns the directories actually removed, so a
 * caller can log a count.
 *
 * ── SESSION LIFETIME = CWD LIFETIME (the teardown gate) ──
 *
 * Removing the directory is only half the gate. A session record for the same
 * `(workflow, run, step)` outlives the directory in `sessions.jsonl`, and the
 * next firing of that step RECREATES the directory at the same path
 * (`ensureWorkDir` is idempotent by design), which defeats the runner's
 * `dirExists(prev.cwd)` and `prev.cwd === recordCwd` guards on its own. So every
 * session of the run is marked `dead` here — `src/agent/loop.ts` refuses to
 * resume a `dead` record, which is what makes resume impossible past this point
 * BY CONSTRUCTION rather than by a liveness check that can be raced.
 *
 * ORDER IS FAIL-SAFE, RETIRE FIRST: if the retire write fails, the directory is
 * LEFT IN PLACE and the entry is skipped for this sweep, so the invariant "a
 * removed work directory has no live session record" cannot be broken by a
 * crash between the two writes. The opposite order (remove, then retire) has a
 * window in which the invariant is already false. A retire that succeeds and a
 * removal that then fails costs only a cold replay next firing — the safe
 * direction to be wrong.
 *
 * KNOWN LIMITATION, stated rather than hidden: `lastSeenAt` is the run
 * directory's own mtime, which a write deep inside a subdirectory does not
 * update. It is therefore a weak "last touched" signal, and it is deliberately
 * only the THIRD condition — a run with an open order or a live child is already
 * protected by the first two regardless of how stale its mtime looks.
 */
export function sweepWorkDirs(o: SweepWorkDirsOptions): string[] {
  const list = o.list ?? listWorkDirs;
  const remove = o.remove ?? reapWorkDir;
  const retire = o.retire ?? markRunSessionsDead;
  const removed: string[] = [];
  let entries: WorkDirEntry[];
  try {
    entries = list(o.workRoot, o.workflows);
  } catch (e) {
    o.err?.(`owenloop work: could not scan work directories under ${o.workRoot}: ${String(e)} (ignored)`);
    return removed;
  }
  for (const e of entries) {
    const reapable = isWorkDirReapable({
      runId: e.runId,
      openRunIds: o.openRunIds,
      liveRunIds: o.liveRunIds,
      lastSeenAt: e.lastSeenAt,
      now: o.now,
      ttlMs: o.ttlMs,
    });
    if (!reapable) continue;

    if (o.sessionsFile !== undefined && o.sessionsFile !== '') {
      try {
        const steps = retire(o.sessionsFile, e.workflow, e.runId, o.now, {
          ...(o.err !== undefined ? { warn: o.err } : {}),
        });
        if (steps.length > 0) {
          o.err?.(
            `owenloop work: retired ${String(steps.length)} session record${steps.length === 1 ? '' : 's'} for ${e.workflow}/${e.runId} (${steps.join(', ')}) — its work directory is being removed`,
          );
        }
      } catch (err) {
        o.err?.(
          `owenloop work: could not retire the sessions for ${e.workflow}/${e.runId}: ${String(err)} — leaving ${e.dir} in place this sweep`,
        );
        continue; // fail-safe: never remove a directory whose sessions still read live
      }
    }

    const result = remove({
      dir: e.dir,
      workRoot: o.workRoot,
      ...(o.workRepo !== undefined ? { workRepo: o.workRepo } : {}),
      ...(o.err !== undefined ? { err: o.err } : {}),
    });
    if (result === 'removed') removed.push(e.dir);
  }
  return removed;
}
