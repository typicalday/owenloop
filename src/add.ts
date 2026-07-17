/**
 * Pure helpers for the `owenloop add <owner>/<repo>[@ref]` CLI verb (workflow
 * distribution Stage 1 — see the design doc this implements,
 * `docs/workflow-distribution.md` §3 in the companion hub repo).
 *
 * These are the network-free, filesystem-adjacent pieces: spec parsing, URL
 * building, lockfile read/write, and file installation. The network fetch and
 * arg glue live in `src/cli.ts` (`dispatchAdd`) so this module stays trivially
 * unit-testable and `cli.ts` doesn't widen its export surface just to reuse
 * `Args`/`CliError`/etc.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

/** Max length for an in-archive relative path we are willing to join and write. */
const MAX_ARCHIVE_PATH_LENGTH = 1024;

/**
 * Returns `undefined` if `relPath` is safe to `join()` under a destination
 * directory, else a human-readable reason it must be rejected. This is
 * reject-don't-normalize: a synthetic archive entry like
 * `workflows/../../victim` is refused outright, never canonicalized into a
 * "safe" path. Part of SEC-1 — an unnormalized entry name must never escape
 * the staging or install directory.
 */
export function archivePathViolation(relPath: string): string | undefined {
  if (relPath === '') return 'empty path';
  if (relPath.includes('\0')) return 'contains a NUL byte';
  if (isAbsolute(relPath) || /^[\\/]/.test(relPath) || /^[A-Za-z]:/.test(relPath)) {
    return 'is an absolute path';
  }
  // Split on both separators so '..\\' tricks and doubled separators can't
  // smuggle a traversal segment past the check.
  const segments = relPath.split(/[\\/]+/);
  if (segments.some((s) => s === '.' || s === '..')) {
    return "contains a '.' or '..' segment";
  }
  if (relPath.length > MAX_ARCHIVE_PATH_LENGTH) {
    return `exceeds ${MAX_ARCHIVE_PATH_LENGTH}-char path length limit`;
  }
  return undefined;
}

export interface RepoSpec {
  owner: string;
  repo: string;
  ref: string;
}

/** Parse `owner/repo` or `owner/repo@ref` into its parts; `ref` defaults to `'HEAD'`. */
export function parseRepoSpec(spec: string): RepoSpec {
  const atIdx = spec.lastIndexOf('@');
  const ownerRepo = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
  const ref = atIdx >= 0 ? spec.slice(atIdx + 1) : 'HEAD';
  const slashIdx = ownerRepo.indexOf('/');
  if (slashIdx < 0) {
    throw new Error(`malformed repo spec '${spec}' — expected owner/repo[@ref]`);
  }
  const owner = ownerRepo.slice(0, slashIdx);
  const repo = ownerRepo.slice(slashIdx + 1);
  if (!owner || !repo) {
    throw new Error(`malformed repo spec '${spec}' — expected owner/repo[@ref]`);
  }
  if (repo.includes('/')) {
    throw new Error(`malformed repo spec '${spec}' — expected owner/repo[@ref]`);
  }
  if (!ref) {
    throw new Error(`malformed repo spec '${spec}' — empty ref after '@'`);
  }
  // Owner and repo become a single on-disk path segment (see `installFolder`),
  // so restrict them to the GitHub-legal charset (a superset — letters, digits,
  // '.', '_', '-'). This guarantees no '/', '\\', or NUL can reach the folder
  // name on any platform — defense-in-depth alongside `archivePathViolation`.
  if (!REPO_NAME_RE.test(owner) || !REPO_NAME_RE.test(repo)) {
    throw new Error(
      `malformed repo spec '${spec}' — owner and repo may only contain letters, digits, '.', '_', '-'`,
    );
  }
  return { owner, repo, ref };
}

/** GitHub-legal (superset) charset for an owner/repo name — see `parseRepoSpec`. */
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * The single-path-segment install folder for a package, derived from its
 * `owner/repo` identity: `<owner>-<repo>-<sha256(owner/repo)[:8]>`. The 8-hex
 * suffix makes the (owner,repo)→folder mapping injective in practice — the old
 * `<owner>-<repo>` scheme collided (`a-b/c` and `a/b-c` both mapped to
 * `a-b-c`, and the second install clobbered the first). Keying on the source
 * (matching the lockfile key) keeps the folder STABLE across versions, so a
 * user's documented `--defs workflows/<folder>` pointer survives upgrades.
 */
export function installFolder(owner: string, repo: string): string {
  const hash = createHash('sha256').update(`${owner}/${repo}`).digest('hex').slice(0, 8);
  return `${owner}-${repo}-${hash}`;
}

export function githubShaUrl(owner: string, repo: string, ref: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/commits/${ref}`;
}

export function githubTarballUrl(owner: string, repo: string, sha: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`;
}

// ---- lockfile ------------------------------------------------------------

export interface InstalledEntry {
  source: string;
  ref: string;
  sha: string;
  installedAt: number;
  path: string;
  files: string[];
}

export interface Lockfile {
  version: 1;
  installed: Record<string, InstalledEntry>;
}

/**
 * Read `.owenloop/installed.json`; a missing file is an empty lockfile, not an
 * error. A file that exists but does not parse is a hard error naming the path
 * — never silently reset to `{}`, which would erase ownership records and
 * re-enable the clobbering `installFolder` was hardened against.
 */
export function readLockfile(path: string): Lockfile {
  if (!existsSync(path)) return { version: 1, installed: {} };
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw) as Lockfile;
  } catch (e) {
    throw new Error(`corrupt lockfile at ${path}: ${(e as Error).message} — fix or remove it manually`);
  }
}

/**
 * Write the lockfile atomically: serialize into a sibling temp file, then
 * `renameSync` over the destination. A crash or a concurrent reader never sees
 * a half-written `installed.json` (rename is atomic within a directory), and
 * two racing writers can only ever leave a fully-formed file.
 *
 * If the final `renameSync` throws (EACCES, EISDIR on `path`, a full disk),
 * the temp sibling is removed on a best-effort basis before the error
 * propagates so a failed write cannot leak an `installed.json.tmp.<pid>` file.
 * The original rename error is surfaced unchanged — never swallowed, and never
 * masked by a failure of that cleanup removal (if the removal itself throws,
 * that error is swallowed and the tmp sibling may remain in that double fault).
 */
export interface WriteLockfileOpts {
  /**
   * Removal op used to clean up the temp sibling when the atomic rename fails.
   * Defaults to `rmSync`; injectable so a test can force the cleanup itself to
   * throw and prove the ORIGINAL rename error still surfaces — the same
   * test-determinism seam as `AcquireLockOpts` in this file.
   */
  rm?: (path: string, opts: { force: true }) => void;
}

export function writeLockfile(path: string, lf: Lockfile, opts: WriteLockfileOpts = {}): void {
  const rm = opts.rm ?? ((p: string, o: { force: true }) => rmSync(p, o));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(lf, null, 2)}\n`);
  try {
    renameSync(tmp, path);
  } catch (e) {
    // Best-effort cleanup: the temp sibling should not leak on a failed write,
    // but if the removal ITSELF throws (e.g. unlink EACCES) we must not let that
    // replace the original rename error — swallow the cleanup error and rethrow
    // `e`. A tmp sibling may survive in that double fault.
    try {
      rm(tmp, { force: true });
    } catch {
      // ignore — surfacing the original rename error matters more than cleanup.
    }
    throw e;
  }
}

// ---- staging + atomic commit -----------------------------------------------

/** The staging root under a defs dir where installs are assembled + validated. */
export const STAGING_DIRNAME = '.owenloop-staging';

/**
 * Write `files` (relative path → bytes) into `targetDir` (a staging dir), NOT
 * the final install destination. Unlike a direct install, this never clears a
 * live folder: the caller stages here, validates, then `commitInstall`s with an
 * atomic rename, so a failure mid-write can only ever corrupt throwaway staging
 * content. Returns the sorted list of relative paths written.
 */
export function stageFiles(targetDir: string, files: Map<string, Uint8Array>): string[] {
  const written: string[] = [];
  for (const [relPath, bytes] of files) {
    // Defense-in-depth: this function is exported and writes whole directory
    // trees, so it must not trust its caller to have validated keys.
    const violation = archivePathViolation(relPath);
    if (violation) {
      throw new Error(`refusing to write unsafe archive path '${relPath}': ${violation}`);
    }
    const full = join(targetDir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    written.push(relPath);
  }
  return written.sort();
}

/**
 * Thrown by `commitInstall` when the atomic swap fails AND the rollback of it
 * fails too — a near-impossible same-filesystem double-fault. Carries the path
 * where the previous version was left so the caller can preserve it (its
 * `preservedAt` sits under the staging root, which the caller would otherwise
 * clean up as debris). A distinguishable type so the caller can tell this
 * "must-preserve" double-fault apart from an ordinary swap failure.
 */
export class RollbackFailedError extends Error {
  readonly preservedAt: string;
  constructor(message: string, preservedAt: string) {
    super(message);
    this.name = 'RollbackFailedError';
    this.preservedAt = preservedAt;
  }
}

/**
 * A handle to a committed-but-not-yet-finalized install, returned by
 * `commitInstall`. The install directory already holds the NEW content, but the
 * displaced previous install (and any migrated old-name dir) are RETAINED under
 * the staging root — not yet discarded — so the caller can still roll the
 * directory state back if a later step (the lockfile write) fails. The caller
 * MUST eventually either `finalizeInstallCommit` (discard the retained dirs) or
 * `rollbackInstallCommit` (restore the previous state). All retained/undo paths
 * derive from `stagingDir`, so they live under `<defsDir>/.owenloop-staging/` —
 * same filesystem (renames stay atomic), and the staging-root cleanup covers
 * them.
 */
export interface InstallCommitHandle {
  /** `defsDir/folder` — now holding the NEW content. */
  dest: string;
  /** `${stagingDir}-old` — the displaced previous dest, if one existed. */
  backupDir?: string;
  /** `${stagingDir}-undo` — where a rollback parks the new content before restoring. */
  undoDir: string;
  /** Set by `parkOldNameDir` when an old-naming dir was migrated off. */
  oldName?: { originalPath: string; parkedAt: string };
}

/**
 * Atomically swap a validated `stagingDir` into place at `defsDir/folder`,
 * rolling back to the previous install if the swap itself fails. Both dirs live
 * on the same filesystem by construction (staging is under `defsDir`), so the
 * renames are atomic and `EXDEV` is impossible.
 *
 * Two-phase commit: unlike a one-shot swap, this does NOT delete the displaced
 * previous install on success — it returns an {@link InstallCommitHandle} whose
 * `backupDir` still holds it. The caller must then either
 * {@link finalizeInstallCommit} (discard the backup, making the swap permanent)
 * once its follow-on work — the lockfile write — has durably succeeded, or
 * {@link rollbackInstallCommit} to restore the previous directory state if that
 * work fails. This is what lets "commit the directory + write the lockfile" be
 * one recoverable operation.
 *
 * Sequence: back up any existing install (rename dest → `<stagingDir>-old`) — if
 * that fails nothing has changed; rename staging → dest; on failure rename the
 * backup back (throwing {@link RollbackFailedError} if even that fails, so the
 * caller can preserve the named copy).
 */
export function commitInstall(defsDir: string, folder: string, stagingDir: string): InstallCommitHandle {
  mkdirSync(defsDir, { recursive: true });
  const dest = join(defsDir, folder);
  const backupDir = `${stagingDir}-old`;
  const undoDir = `${stagingDir}-undo`;
  let backedUp = false;
  if (existsSync(dest)) {
    // Ownership is verified by the caller before we get here. If this rename
    // throws, nothing has changed — dest is still the previous install.
    renameSync(dest, backupDir);
    backedUp = true;
  }
  try {
    renameSync(stagingDir, dest);
  } catch (e) {
    if (backedUp) {
      try {
        renameSync(backupDir, dest);
      } catch (rollbackErr) {
        // Near-impossible (same dir, same fs), but if even the rollback fails,
        // name the backup so the previous version is recoverable by hand — and
        // signal (via the type) that the caller must preserve it.
        throw new RollbackFailedError(
          `install of '${folder}' failed and rollback failed too; ` +
            `previous version preserved at ${backupDir}: ${(rollbackErr as Error).message}`,
          backupDir,
        );
      }
    }
    throw e;
  }
  return { dest, backupDir: backedUp ? backupDir : undefined, undoDir };
}

/**
 * Migrate a source off its old `<owner>-<repo>` install directory by PARKING it
 * (rename → `<stagingDir>-undo-oldname`) instead of deleting it, so a later
 * rollback can put it back where the (still-unchanged) lockfile expects it.
 * Records the move on `handle.oldName`. If the old dir does not exist on disk
 * (the lockfile names a path that is already gone), records nothing — matching
 * the previous `rmSync(..., { force: true })` tolerance of absence.
 */
export function parkOldNameDir(handle: InstallCommitHandle, defsDir: string, oldRelPath: string): void {
  const originalPath = join(defsDir, oldRelPath);
  if (!existsSync(originalPath)) return;
  const parkedAt = `${handle.undoDir}-oldname`;
  renameSync(originalPath, parkedAt);
  handle.oldName = { originalPath, parkedAt };
}

/**
 * Make the commit permanent: discard the retained previous install and any
 * parked old-name dir. Call ONLY after the follow-on lockfile write has durably
 * succeeded — this is the point of no return.
 */
export function finalizeInstallCommit(handle: InstallCommitHandle): void {
  if (handle.backupDir) rmSync(handle.backupDir, { recursive: true, force: true });
  if (handle.oldName) rmSync(handle.oldName.parkedAt, { recursive: true, force: true });
}

/**
 * Undo a `commitInstall` (plus any `parkOldNameDir`), restoring the pre-commit
 * directory state. Order matters:
 *   1. park the new content out of `dest` (rename dest → undoDir) — for a fresh
 *      install, this alone restores "nothing installed";
 *   2. if a previous install was displaced, rename its backup back over `dest`;
 *   3. if an old-name dir was parked, rename it back to where the lockfile says.
 * The parked new content under `undoDir` is left for the caller's staging-root
 * cleanup to dispose of. Any throw propagates to the caller.
 *
 * Safe to call from a FAILED `parkOldNameDir`: that helper records
 * `handle.oldName` only after its single rename succeeds, so a park failure
 * leaves `oldName` unset and step 3 self-skips — there is no "park partially
 * happened" state to reconcile (the park is one atomic rename).
 */
export function rollbackInstallCommit(handle: InstallCommitHandle): void {
  renameSync(handle.dest, handle.undoDir);
  if (handle.backupDir) renameSync(handle.backupDir, handle.dest);
  if (handle.oldName) renameSync(handle.oldName.parkedAt, handle.oldName.originalPath);
}

// ---- per-project install lock ----------------------------------------------

/** Default wait/stale/poll timings for the install lock (overridable in tests). */
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 100;

export interface InstallLockHandle {
  lockPath: string;
  acquired: boolean;
}

export interface AcquireLockOpts {
  /** Max time to wait for a live lock before failing cleanly (default 10s). */
  waitMs?: number;
  /** A lock older than this (by mtime) is reclaimed even if its pid looks live (default 10m). */
  staleMs?: number;
  /** Poll interval while waiting on a live lock (default 100ms). */
  pollMs?: number;
  /** Liveness probe for the holder pid — injectable so tests are deterministic. */
  isPidAlive?: (pid: number) => boolean;
  /** Clock — injectable so tests are deterministic. */
  now?: () => number;
}

/** `true` if a process with `pid` exists (signal 0 probes without delivering). */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but we may not signal it — treat as alive.
    // ESRCH (and anything else): no such process — dead.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockHolder(lockPath: string): { pid?: number; startedAt?: number } | null {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * A held lock is stale (safe to reclaim) if: its holder pid is dead; OR its
 * file mtime is past the stale window; OR its contents are unparseable AND it
 * is past the stale window. A parseable, live, recent lock is NOT stale.
 */
function lockIsStale(
  lockPath: string,
  staleMs: number,
  isPidAlive: (pid: number) => boolean,
  now: () => number,
): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    // Vanished between the EEXIST and here — someone else reclaimed it; retry.
    return true;
  }
  const holder = readLockHolder(lockPath);
  const past = now() - mtimeMs > staleMs;
  if (holder && typeof holder.pid === 'number') {
    return !isPidAlive(holder.pid) || past;
  }
  return past;
}

/**
 * Acquire the per-project install lock at `lockPath` (an exclusive-create of the
 * file). If another process holds it: reclaim it if stale, otherwise poll until
 * it frees, and if it does not free within `waitMs` fail cleanly with a clear
 * message. Always pair with `releaseInstallLock` in a `finally`.
 */
export async function acquireInstallLock(
  lockPath: string,
  opts: AcquireLockOpts = {},
): Promise<InstallLockHandle> {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const pollMs = opts.pollMs ?? LOCK_POLL_MS;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const now = opts.now ?? Date.now;

  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now() }));
      } finally {
        closeSync(fd);
      }
      return { lockPath, acquired: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (lockIsStale(lockPath, staleMs, isPidAlive, now)) {
      rmSync(lockPath, { force: true });
      continue; // reclaimed — retry the exclusive create
    }
    if (now() >= deadline) {
      const holder = readLockHolder(lockPath);
      const who = typeof holder?.pid === 'number' ? `pid ${holder.pid}` : 'another process';
      throw new Error(
        `another owenloop add (${who}) holds ${lockPath}; timed out waiting after ${Math.round(waitMs / 1000)}s`,
      );
    }
    await sleep(pollMs);
  }
}

/** Release a lock acquired by `acquireInstallLock`. A no-op if not acquired. */
export function releaseInstallLock(handle: InstallLockHandle): void {
  if (!handle.acquired) return;
  rmSync(handle.lockPath, { force: true });
}
