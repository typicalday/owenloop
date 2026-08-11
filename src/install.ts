/**
 * The host-neutral install transaction shared by every route that swaps a
 * validated staging tree into place atomically: safe staging, the atomic
 * destination→backup / staging→destination swap with a retained backup,
 * finalize/rollback, the atomic metadata write, the per-root install lock, the
 * base applying/finalizing crash-journal phases, the v2 repair substates, and
 * recovery driven by durable phase, metadata, and actual filesystem state.
 *
 * Two consumers share it today:
 *   - `src/add.ts` (the GitHub `owenloop add` route): metadata = `installed.json`,
 *     destination segment = a single folder directly under the defs dir, v1
 *     journal schema (a 40-char GitHub sha + source/ref ledger corroboration).
 *   - `src/store/install.ts` (the content-addressed workflow store): metadata =
 *     `index.json`, destination segment = a three-segment object path
 *     (`objects/sha256/<digest>`), v2 journal schema (identity = a
 *     metadata-hash match, no route-specific fields).
 *
 * For v1, fresh v2 installs, and v2 dedupe, the durable COMMIT POINT is the
 * atomic METADATA write. Same-digest v2 repair is different: the metadata may
 * already contain the target digest before replacement starts, so a matching
 * metadata hash is never enough to accept the replacement. Repair recovery
 * restores the prior backup or resumes recursive hardening plus exact content
 * and mode verification; only `finalizing` makes the prior backup disposable.
 * The journal is removed LAST so recovery stays idempotent (running it again
 * changes nothing).
 *
 * The journal is attacker-influenceable input (it may sit in a repo checkout):
 * every path field is validated fail-closed as a safe single segment, and every
 * mutation path is re-derived from the CURRENT run's resolved root plus those
 * validated segments — never from a recorded absolute path. A bad shape,
 * unknown phase, root mismatch, or contradictory disk state REFUSES with no
 * filesystem mutation and leaves the journal in place as evidence.
 *
 * Engine core: this module imports Node builtins and core helpers only — it
 * never imports `cli.ts`, `add.ts`, `untar.ts`, or a hub module.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireFileLock, releaseFileLock } from './lock.ts';
import type { AcquireFileLockOpts, FileLockHandle } from './lock.ts';
import { archivePathViolation } from './archive.ts';
import { mkdirRefusingSymlink } from './util.ts';

// ---- safe paths --------------------------------------------------------------

// Re-export the neutral archive policy so add callers retain their historical
// import path while add, untar, and bundle all use the same function identity.
export { archivePathViolation } from './archive.ts';

/**
 * Returns `undefined` if `relPath` is a safe SINGLE-SEGMENT path, else a
 * human-readable reason it must be rejected. Stricter than
 * {@link archivePathViolation}: ANY separator is refused outright. That one
 * rule makes `..` traversal and nested escape shapes unrepresentable before
 * any `join`/`rename` ever touches the path. Used for the GitHub route's
 * top-level destination segment and every journal path segment field.
 * Reject-don't-normalize, like {@link archivePathViolation}.
 */
export function lockfilePathViolation(relPath: string): string | undefined {
  const base = archivePathViolation(relPath);
  if (base) return base;
  if (/[\\/]/.test(relPath)) return 'contains a path separator';
  return undefined;
}

/**
 * Returns `undefined` if `relPath` is a safe MULTI-SEGMENT path under a store
 * root (the CAS object path `objects/sha256/<digest>` is three segments), else
 * a human-readable reason it must be rejected. Applies
 * {@link archivePathViolation} to the whole path and to EVERY segment — the
 * CAS destination segment set is never trusted from disk; it is validated
 * fail-closed before any join or rename.
 */
export function multiSegmentPathViolation(relPath: string): string | undefined {
  const whole = archivePathViolation(relPath);
  if (whole) return whole;
  const segments = relPath.split(/[\\/]+/);
  if (segments.length === 0) return 'empty path';
  for (const segment of segments) {
    const violation = lockfilePathViolation(segment);
    if (violation) return `segment '${segment}' ${violation}`;
  }
  return undefined;
}

/**
 * Ensure a state directory is real before a caller creates or writes below it.
 * The final directory and its immediate parent are checked with `lstat`; the
 * caller's existing filesystem root may contain an operator/system symlink
 * (for example macOS's `/var`), which is outside the state directory boundary.
 * Missing directories are created recursively and the final leaf is checked
 * again before the caller proceeds.
 */
export function ensureDirectoryPathNoSymlink(dir: string, label = 'directory'): void {
  const absolute = resolve(dir);
  const parent = dirname(absolute);
  const parentSt = lstatSync(parent, { throwIfNoEntry: false });
  if (parentSt?.isSymbolicLink()) {
    throw new Error(`refusing to use ${label} '${absolute}': its parent '${parent}' is a symbolic link`);
  }
  if (parentSt && !parentSt.isDirectory()) {
    throw new Error(`refusing to use ${label} '${absolute}': its parent '${parent}' is not a directory`);
  }
  let st = lstatSync(absolute, { throwIfNoEntry: false });
  if (st === undefined) {
    mkdirSync(absolute, { recursive: true });
    st = lstatSync(absolute, { throwIfNoEntry: false });
  }
  if (st === undefined) {
    throw new Error(`refusing to use ${label} '${absolute}': it disappeared during creation`);
  }
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to use ${label} '${absolute}': it is a symlink`);
  }
  if (!st.isDirectory()) {
    throw new Error(`refusing to use ${label} '${absolute}': it is not a directory`);
  }
}

/** Refuse a symlink or non-regular-file state leaf; an absent leaf is allowed. */
export function guardStateFile(path: string, label = 'state file'): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined) return;
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to use ${label} '${path}': it is a symlink`);
  }
  if (!st.isFile()) {
    throw new Error(`refusing to use ${label} '${path}': it is not a regular file`);
  }
}

/**
 * Read one regular file without following a symlink during the open. The
 * initial `lstat` rejects a planted link or non-file, and `O_NOFOLLOW` closes
 * the replace-between-check-and-open window. An absent file returns undefined
 * so callers can distinguish an empty file (which still needs parsing) from a
 * never-created metadata file.
 */
export function readRegularFileNoFollow(path: string, label = 'file'): Uint8Array | undefined {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined) return undefined;
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to read ${label} '${path}': it is a symlink`);
  }
  if (!st.isFile()) {
    throw new Error(`refusing to read ${label} '${path}': it is not a regular file`);
  }

  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP') {
      throw new Error(`refusing to read ${label} '${path}': it is a symlink`);
    }
    throw e;
  }
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Probe a directory path without following symlinks through any component.
 * Missing components mean the path is absent; an existing symlink or non-dir
 * component is an integrity failure. This is used for CAS object ownership and
 * recovery probes, where `existsSync` would incorrectly follow links.
 */
export function probeDirectoryPath(path: string, label = 'directory', trustedBoundary?: string): 'dir' | 'absent' {
  const absolute = resolve(path);
  const start = trustedBoundary === undefined ? parse(absolute).root : resolve(trustedBoundary);
  const remainder = relative(start, absolute);
  if (remainder === '' || (!trustedBoundary && remainder.startsWith('..'))) return 'dir';
  if (trustedBoundary && (remainder === '..' || remainder.startsWith(`..${sep}`))) {
    throw new Error(`refusing to use ${label} '${absolute}': it escapes trusted boundary '${start}'`);
  }
  let current = start;
  for (const segment of remainder.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (st === undefined) return 'absent';
    if (st.isSymbolicLink()) {
      throw new Error(`refusing to use ${label} '${current}': it is a symlink`);
    }
    if (!st.isDirectory()) {
      throw new Error(`refusing to use ${label} '${current}': it is not a directory`);
    }
  }
  return 'dir';
}

// ---- atomic metadata write ----------------------------------------------------

export interface AtomicJsonWriteOpts {
  /**
   * Removal op used to clean up the temp sibling when the atomic rename fails.
   * Defaults to `rmSync`; injectable so a test can force the cleanup itself to
   * throw and prove the ORIGINAL rename error still surfaces.
   */
  rm?: (path: string, opts: { force: true }) => void;
}

/**
 * Serialize `value` as pretty JSON into a sibling temp file, then `renameSync`
 * over `path` — one atomic tmp+rename discipline shared by the lockfile, the
 * crash-recovery journal, and the workflow-store index. A crash or a
 * concurrent reader never sees a half-written file (rename is atomic within a
 * directory).
 *
 * If the final `renameSync` throws (EACCES, EISDIR on `path`, a full disk),
 * the temp sibling is removed on a best-effort basis before the error
 * propagates so a failed write cannot leak a `<path>.tmp.<pid>` file. The
 * original rename error is surfaced unchanged — never swallowed, and never
 * masked by a failure of that cleanup removal (if the removal itself throws,
 * that error is swallowed and the tmp sibling may remain in that double fault).
 */
export function writeJsonAtomic(path: string, value: unknown, opts: AtomicJsonWriteOpts = {}): void {
  const rm = opts.rm ?? ((p: string, o: { force: true }) => rmSync(p, o));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      rm(tmp, { force: true });
    } catch {
      // ignore — surfacing the original rename error matters more than cleanup.
    }
    throw e;
  }
}

// ---- staging + atomic commit --------------------------------------------------

/** The staging root under a root dir where installs are assembled + validated. */
export const STAGING_DIRNAME = '.owenloop-staging';

/**
 * Recursively remove `dir` WITHOUT requiring write permission inside it.
 * Content-addressed objects are committed read-only + non-writable (files
 * 0o444, dirs 0o555) — hardening is defense in depth, and it means a plain
 * `rmSync` (which unlinks each entry through its PARENT dir's write mode)
 * dies with EACCES as soon as a swapped-out backup or staging debris holds a
 * hardened object. Each directory restores its own write+search modes BEFORE
 * its entries are unlinked, so no level ever removes through a 0o555 dir —
 * and a STORED object is never made transiently writable, only its doomed
 * staging/undo/backup copy. Absent ⇒ no-op (idempotent). Every throw
 * propagates: a half-removed staging root is the caller's error, never a
 * silent leak.
 */
export function rmRecursiveForce(dir: string): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    rmSync(dir, { force: true });
    return;
  }
  chmodSync(dir, 0o755); // writable/searchable BEFORE any of its entries leave
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const entrySt = lstatSync(full);
    if (entrySt.isDirectory()) {
      rmRecursiveForce(full);
    } else {
      rmSync(full, { force: true });
    }
  }
  rmdirSync(dir); // empty now — rmSync refuses directories outright
}

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
 * displaced previous install is RETAINED under the staging root — not yet
 * discarded — so the caller can still roll the directory state back if a later
 * step (the metadata write) fails. The caller MUST eventually either
 * `finalizeInstallCommit` (discard the retained dirs) or `rollbackInstallCommit`
 * (restore the previous state). All retained/undo paths derive from
 * `stagingDir`, so they live under `<root>/.owenloop-staging/` — same
 * filesystem (renames stay atomic), and the staging-root cleanup covers them.
 */
export interface InstallCommitHandle {
  /** `root/<destRelPath>` — now holding the NEW content. */
  dest: string;
  /** The destination's path relative to the root (for diagnostics/journals). */
  destRelPath: string;
  /** `${stagingDir}-old` — the displaced previous dest, if one existed. */
  backupDir?: string;
  /** `${stagingDir}-undo` — where a rollback parks the new content before restoring. */
  undoDir: string;
}

/** Deterministic synchronization hook for transaction crash/concurrency tests. */
export interface CommitInstallOptions {
  /** Runs after destination → backup and before staging → destination. */
  afterBackupRename?: () => void;
}

/**
 * Atomically swap a validated `stagingDir` into place at `root/<destRelPath>`.
 * Both live on the same filesystem by construction (staging is under `root`),
 * so the renames are atomic and `EXDEV` is impossible. `destRelPath` is a
 * MULTI-SEGMENT path (a top-level folder for the GitHub route,
 * `objects/sha256/<digest>` for the CAS route) and is re-validated HERE, at
 * the mutation site — defense-in-depth alongside the callers' checks.
 *
 * Two-phase commit: unlike a one-shot swap, this does NOT delete the displaced
 * previous install on success — it returns an {@link InstallCommitHandle} whose
 * `backupDir` still holds it. The caller must then either
 * {@link finalizeInstallCommit} (discard the backup, making the swap permanent)
 * once its follow-on work — the metadata write — has durably succeeded, or
 * {@link rollbackInstallCommit} to restore the previous directory state if that
 * work fails. This is what lets "commit the directory + write the metadata" be
 * one recoverable operation.
 *
 * Sequence: back up any existing install (rename dest → `<stagingDir>-old`) —
 * if that fails nothing has changed; rename staging → dest; on failure rename
 * the backup back (throwing {@link RollbackFailedError} if even that fails, so
 * the caller can preserve the named copy).
 */
export function commitInstall(
  root: string,
  destRelPath: string,
  stagingDir: string,
  options: CommitInstallOptions = {},
): InstallCommitHandle {
  const violation = multiSegmentPathViolation(destRelPath);
  if (violation) {
    throw new Error(`refusing to install unsafe destination path '${destRelPath}': ${violation}`);
  }
  // Permissive on `root`: whether a symlinked root is operator intent
  // (the GitHub route's explicit --defs) or a refusal (the CAS route) is the
  // CALLER's decision — this mutation site does not second-guess it.
  mkdirSync(root, { recursive: true });
  const dest = join(root, destRelPath);
  // The CAS destination is MULTI-SEGMENT (`objects/sha256/<digest>`): its
  // intermediate parents may not exist yet, and `renameSync` does not create
  // them (ENOENT). Each MISSING intermediate is created symlink-guarded
  // (SEC-3), and an EXISTING intermediate that is a symlink or non-directory
  // is refused fail-closed — a hostile `objects/sha256 -> /elsewhere` would
  // otherwise redirect the swap. The GitHub route's single-segment dest has no
  // intermediates, so this loop is a no-op there and the operator-intent
  // symlinked root above stays honored.
  const segments = destRelPath.split('/');
  let parent = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (seg === undefined) {
      // Unreachable — the loop bound guarantees `i < segments.length - 1`.
      throw new Error('internal error: missing path segment during install commit');
    }
    parent = join(parent, seg);
    const st = lstatSync(parent, { throwIfNoEntry: false });
    if (st === undefined) {
      mkdirRefusingSymlink(parent);
    } else if (st.isSymbolicLink()) {
      throw new Error(`refusing to install below '${parent}': an intermediate destination parent is a symlink`);
    } else if (!st.isDirectory()) {
      throw new Error(`refusing to install below '${parent}': an intermediate destination parent is not a directory`);
    }
  }
  const backupDir = `${stagingDir}-old`;
  const undoDir = `${stagingDir}-undo`;
  let backedUp = false;
  try {
    if (probeDirectoryPath(dest, 'install destination', root) === 'dir') {
      // Ownership is verified by the caller before we get here. If this rename
      // throws, nothing has changed — dest is still the previous install. The
      // rename restores write modes first: the displaced dir may hold a hardened
      // CAS object (an index-less object dir being overwritten is rare, but the
      // move must work when it happens).
      renameDirRestoringWrite(dest, backupDir);
      backedUp = true;
      options.afterBackupRename?.();
    }
    renameSync(stagingDir, dest);
  } catch (e) {
    if (backedUp) {
      try {
	renameDirRestoringWrite(backupDir, dest);
      } catch (rollbackErr) {
        // Near-impossible (same fs), but if even the rollback fails, name the
        // backup so the previous version is recoverable by hand — and signal
        // (via the type) that the caller must preserve it.
        throw new RollbackFailedError(
          `install of '${destRelPath}' failed and rollback failed too; ` +
            `previous version preserved at ${backupDir}: ${(rollbackErr as Error).message}`,
          backupDir,
        );
      }
    }
    throw e;
  }
  return { dest, destRelPath, backupDir: backedUp ? backupDir : undefined, undoDir };
}

/**
 * Make the commit permanent: discard the retained previous install. Call ONLY
 * after the follow-on metadata write has durably succeeded — this is the point
 * of no return.
 */
export function finalizeInstallCommit(handle: InstallCommitHandle): void {
  // The backup may hold a hardened CAS object (0o444/0o555) — force-remove it
  // without requiring write permission inside it (see `rmRecursiveForce`).
  if (handle.backupDir) rmRecursiveForce(handle.backupDir);
}

/**
 * Rename a directory without changing its durable mode. Hardened object roots
 * are 0o555; some filesystems or test doubles require owner-write permission
 * while moving them. Record the exact source mode, add only owner-write for the
 * rename, then restore the recorded mode at the destination. A failed rename
 * restores the recorded mode at the source before the original error escapes.
 */
export function renameDirRestoringWrite(src: string, dst: string): void {
  const sourceStat = lstatSync(src);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`refusing to rename '${src}': source is not a real directory`);
  }
  const originalMode = sourceStat.mode & 0o7777;
  const temporaryMode = originalMode | 0o200;
  if (temporaryMode !== originalMode) chmodSync(src, temporaryMode);
  try {
    renameSync(src, dst);
  } catch (renameError) {
    if (temporaryMode !== originalMode) {
      try {
	chmodSync(src, originalMode);
      } catch (restoreError) {
	throw new AggregateError(
	  [renameError, restoreError],
	  `rename of '${src}' to '${dst}' failed and restoring source mode ${originalMode.toString(8)} failed`,
	);
      }
    }
    throw renameError;
  }

  if (temporaryMode !== originalMode) {
    try {
      chmodSync(dst, originalMode);
    } catch (restoreError) {
      // Do not leave a moved object writable. Best-effort move it back and
      // restore the source mode; if either recovery step fails, report every
      // fault so the caller preserves the transaction journal and backup.
      try {
	renameSync(dst, src);
	chmodSync(src, originalMode);
      } catch (rollbackError) {
	throw new AggregateError(
	  [restoreError, rollbackError],
	  `renamed '${src}' to '${dst}' but could not restore mode ${originalMode.toString(8)} or move it back`,
	);
      }
      throw restoreError;
    }
  }
}

/**
 * Undo a `commitInstall`, restoring the pre-commit directory state. Order
 * matters: (1) park the new content out of `dest` (rename dest → undoDir) —
 * for a fresh install, this alone restores "nothing installed"; (2) if a
 * previous install was displaced, rename its backup back over `dest`. The
 * parked new content under `undoDir` is left for the caller's staging-root
 * cleanup to dispose of. Renames go through {@link renameDirRestoringWrite}:
 * the CAS route hardens objects at their committed location, so `dest` may
 * already be non-writable when a late rollback (the index write failing) runs.
 * Any throw propagates to the caller.
 */
export function rollbackInstallCommit(handle: InstallCommitHandle): void {
  renameDirRestoringWrite(handle.dest, handle.undoDir);
  if (handle.backupDir) renameDirRestoringWrite(handle.backupDir, handle.dest);
}

// ---- per-root install lock -----------------------------------------------------
//
// Thin adapters over the generic file lock (`src/lock.ts`) that keep the old
// public names, types, and the "owenloop add" timeout wording `src/add.ts` and
// its callers/tests depend on. Different roots lock independently: the project
// GitHub route and the project CAS route share ONE project lock (both mutate
// the same tree), while the global CAS root holds its own lock below itself.

/** The install lock handle — the generic `FileLockHandle` from `lock.ts`. */
export type InstallLockHandle = FileLockHandle;
/** The install lock acquire options — the generic `AcquireFileLockOpts` from `lock.ts`. */
export type AcquireLockOpts = AcquireFileLockOpts;

/**
 * Acquire the install lock at `lockPath`. A 1-line adapter over the generic
 * `acquireFileLock`, pinning `label` so the timeout message reads "another
 * owenloop add is in progress …" byte-for-byte as before. Always pair with
 * `releaseInstallLock` in a `finally`.
 */
export function acquireInstallLock(
  lockPath: string,
  opts: AcquireLockOpts = {},
): Promise<InstallLockHandle> {
  mkdirRefusingSymlink(dirname(lockPath));
  guardStateFile(lockPath, 'install lock');
  return acquireFileLock(lockPath, { label: 'owenloop add', ...opts });
}

/** Release a lock acquired by `acquireInstallLock` — the generic `releaseFileLock`. */
export const releaseInstallLock = releaseFileLock;

// ---- crash-recovery journal ------------------------------------------------
//
// A process that dies (crash, SIGKILL) partway through the destructive part of
// an install — the commit swap or the metadata write — must leave the root
// recoverable to a consistent (tree ⇔ metadata) state by the NEXT install,
// never a half-applied tree. The journal is written before the first
// destructive step, advanced/removed as the install progresses, and the next
// install runs `recoverInterruptedInstall` under the same lock BEFORE the
// stale-staging cleanup (the backups a rollback needs live under the staging
// root).
//
// Two journal versions:
//   - v1 (the GitHub route): `sha` is a 40-char GitHub commit sha and
//     commit-point detection matches the `installed.json` ledger on
//     source+sha+path (with old-name migration corroboration).
//   - v2 (the CAS route and any future route): identity-free except for the
//     destination segment set; ordinary commit-point detection hashes the
//     CURRENT metadata bytes against the journal's `metadataHash`. Same-digest
//     repair instead uses explicit replacement phases because the index hash may
//     match before the replacement starts. No route-specific schema (no 40-char
//     sha) is baked into the generic transaction.
//
// `recoverInterruptedInstall` reads BOTH versions and dispatches on `version`,
// so `owenloop add --recover` recovers a journal written by an older release
// (v1) or by the CAS route (v2) identically.

/** The crash-recovery journal filename (a sibling of the lock + metadata file). */
export const ADD_JOURNAL_FILENAME = 'add.journal';

/**
 * The two base durable phases shared by v1 and ordinary v2 transactions. Absent
 * (no file) is the third, happy state. V2 same-digest repair extends these phases
 * with the substates in {@link InstallJournalV2Phase}; ordinary transactions stay
 * deliberately coarse because directory existence recovers their progress.
 *
 * - `applying`: written after staging+validation succeed, immediately before
 *   `commitInstall`. The metadata write (the durable commit point) has NOT yet
 *   happened, so recovery rolls BACK — unless the metadata turns out to already
 *   match (a crash in the tiny write→rewrite window), in which case it rolls
 *   forward.
 * - `finalizing`: written immediately after the metadata write succeeds, before
 *   `finalizeInstallCommit`. The commit point has passed, so recovery rolls
 *   FORWARD (finishes discarding the retained backup).
 */
export type AddJournalPhase = 'applying' | 'finalizing';

/**
 * Durable v2 repair phases. Each phase is written only after the named step has
 * completed, so recovery never infers repair completion from unchanged index
 * bytes. Readers wait while any replacement phase is active and resume only at
 * `finalizing`, after hardening, canonical verification, hardened-mode
 * verification, and the metadata commit point have all completed.
 */
export type InstallJournalV2Phase =
  | AddJournalPhase
  | 'replacement-swapped'
  | 'replacement-hardened'
  | 'replacement-verified';

/** The v2 transaction kind; recorded so same-digest repair is never mistaken for dedupe. */
export type InstallJournalV2Operation = 'install' | 'dedupe' | 'repair';

/**
 * One v1 (GitHub-route) crash-recovery journal record. `folder`, `stagingId`,
 * and `oldNamePath` are single on-disk path segments (each
 * {@link lockfilePathViolation}-checked on read); `defsDir` is compared for
 * equality ONLY and is never joined into a mutation path; `ref`/`startedAt`
 * are diagnostics. These invariants are NOT trusted from disk —
 * {@link validateAddJournal} enforces every one, fail-closed.
 */
export interface AddJournal {
  version: 1;
  phase: AddJournalPhase;
  /** Ledger key of the source being installed — for the ledger-match check. */
  source: string;
  /** 40-char hex commit sha being installed — for the ledger-match check. */
  sha: string;
  /** Install folder segment (`dest = join(defsDir, folder)`). Single segment. */
  folder: string;
  /** Basename of this run's staging dir (`stg_<hex>`). Single segment. */
  stagingId: string;
  /** Did `dest` exist when the journal was written (⇒ a backup dir will exist)? */
  hadDest: boolean;
  /** Set only for an old-name (`<owner>-<repo>`) migration. Single segment. */
  oldNamePath?: string;
  /** Resolved defs dir at journal-write time — equality-checked, never joined. */
  defsDir: string;
  /** The `@ref` this install pinned — diagnostics only. */
  ref: string;
  /** Journal-write epoch ms — diagnostics only. */
  startedAt: number;
}

/**
 * One v2 (route-neutral) crash-recovery journal record. The destination is a
 * validated segment list under the root (a single segment for a top-level
 * folder, three for `objects/sha256/<digest>`); `metadataHash` is the SHA-256
 * of the exact post-install metadata bytes, and the commit-point decision is
 * `hash(current metadata bytes) === metadataHash` — recovery never assumes a
 * route-specific metadata schema. `root` is equality-checked only, never
 * joined. `label`/`startedAt` are diagnostics. Validated fail-closed by
 * {@link validateInstallJournalV2}; never trusted from disk.
 */
export interface InstallJournalV2 {
  version: 2;
  phase: InstallJournalV2Phase;
  /** Explicitly separates a same-digest repair from a no-swap dedupe. */
  operation?: InstallJournalV2Operation;
  /** Destination path segments relative to the root (validated, never joined raw). */
  destSegments: string[];
  /** Basename of this run's staging dir (`stg_<hex>`). Single segment. */
  stagingId: string;
  /** Did `dest` exist when the journal was written (⇒ a backup dir will exist)? */
  hadDest: boolean;
  /** Resolved root at journal-write time — equality-checked, never joined. */
  root: string;
  /** SHA-256 hex of the exact post-install metadata bytes (the commit-point test). */
  metadataHash: string;
  /** Free-form route label (e.g. the CAS coordinate) — diagnostics only. */
  label?: string;
  /** Journal-write epoch ms — diagnostics only. */
  startedAt?: number;
  /** External transaction marker for a fresh-install swap with no backup. */
  recoveryMarkerId?: string;
}

/** A journal of either version, as read from disk. */
export type AnyInstallJournal = AddJournal | InstallJournalV2;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A 40-char hex commit sha (case-insensitive), as GitHub returns. */
const SHA_HEX_RE = /^[0-9a-f]{40}$/i;

/** A lowercase 64-char SHA-256 hex digest — v2 metadata hashes and CAS digests. */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** The shared "fix it by hand" journal error. `path` appears only in the message. */
function journalValidationError(path: string, detail: string): Error {
  return new Error(
    `invalid crash-recovery journal at ${path}: ${detail} — ` +
      `inspect and remove it manually, then re-run add`,
  );
}

/**
 * Structurally validate a parsed v1 `add.journal`, fail-closed — the trust
 * boundary for v1 journals, mirroring the lockfile's validator. A
 * parseable-but-invalid journal is a hard error naming the file and the manual
 * remedy; recovery NEVER acts on a field that has not passed through here.
 * Every path field must be a safe single segment so a crafted journal cannot
 * represent traversal before any `join`/`rename`. Unknown extra keys are
 * tolerated (forward compatibility, same as the lockfile). `ref`/`startedAt`
 * are diagnostics: validated for type when present, but not required. `path`
 * appears only in error messages.
 */
export function validateAddJournal(parsed: unknown, path: string): AddJournal {
  const fail = (detail: string): never => {
    throw journalValidationError(path, detail);
  };
  if (!isPlainObject(parsed)) return fail('top-level value is not an object');
  if (parsed.version !== 1) {
    return fail(`unsupported journal version ${JSON.stringify(parsed.version)} (expected 1)`);
  }
  if (parsed.phase !== 'applying' && parsed.phase !== 'finalizing') {
    return fail(`unknown phase ${JSON.stringify(parsed.phase)} (expected 'applying' or 'finalizing')`);
  }
  if (typeof parsed.source !== 'string' || parsed.source === '') {
    return fail("'source' is not a non-empty string");
  }
  if (typeof parsed.sha !== 'string' || !SHA_HEX_RE.test(parsed.sha)) {
    return fail("'sha' is not a 40-char hex commit sha");
  }
  const segment = (field: string, value: unknown): void => {
    if (typeof value !== 'string') fail(`'${field}' is not a string`);
    const violation = lockfilePathViolation(value as string);
    if (violation) fail(`'${field}' ${violation}`);
  };
  segment('folder', parsed.folder);
  segment('stagingId', parsed.stagingId);
  if (parsed.oldNamePath !== undefined) segment('oldNamePath', parsed.oldNamePath);
  if (typeof parsed.hadDest !== 'boolean') return fail("'hadDest' is not a boolean");
  if (typeof parsed.defsDir !== 'string' || parsed.defsDir === '') {
    return fail("'defsDir' is not a non-empty string");
  }
  if (parsed.ref !== undefined && typeof parsed.ref !== 'string') return fail("'ref' is not a string");
  if (parsed.startedAt !== undefined && typeof parsed.startedAt !== 'number') {
    return fail("'startedAt' is not a number");
  }
  return parsed as unknown as AddJournal;
}

/**
 * Structurally validate a parsed v2 journal, fail-closed — the trust boundary
 * for route-neutral journals, same discipline as {@link validateAddJournal}:
 * hard error naming the file on any bad shape, unknown extra keys tolerated,
 * path fields validated as safe single segments, `root` equality-only,
 * `metadataHash` a strict lowercase 64-hex value (never normalized).
 */
export function validateInstallJournalV2(parsed: unknown, path: string): InstallJournalV2 {
  const fail = (detail: string): never => {
    throw journalValidationError(path, detail);
  };
  if (!isPlainObject(parsed)) return fail('top-level value is not an object');
  if (parsed.version !== 2) {
    return fail(`unsupported journal version ${JSON.stringify(parsed.version)} (expected 2)`);
  }
  if (
    parsed.phase !== 'applying' &&
    parsed.phase !== 'replacement-swapped' &&
    parsed.phase !== 'replacement-hardened' &&
    parsed.phase !== 'replacement-verified' &&
    parsed.phase !== 'finalizing'
  ) {
    return fail(
      `unknown phase ${JSON.stringify(parsed.phase)} ` +
	`(expected 'applying', 'replacement-swapped', 'replacement-hardened', ` +
	`'replacement-verified', or 'finalizing')`,
    );
  }
  if (
    parsed.operation !== undefined &&
    parsed.operation !== 'install' &&
    parsed.operation !== 'dedupe' &&
    parsed.operation !== 'repair'
  ) {
    return fail("'operation' is not 'install', 'dedupe', or 'repair'");
  }
  if (typeof parsed.phase === 'string' && parsed.phase.startsWith('replacement-') && parsed.operation !== 'repair') {
    return fail(`phase '${parsed.phase}' requires operation 'repair'`);
  }
  if (parsed.operation === 'repair' && parsed.hadDest !== true) {
    return fail("operation 'repair' requires 'hadDest' true");
  }
  if (parsed.operation === 'dedupe' && parsed.hadDest !== true) {
    return fail("operation 'dedupe' requires 'hadDest' true");
  }
  if (parsed.operation === 'install' && parsed.hadDest !== false) {
    return fail("operation 'install' requires 'hadDest' false");
  }
  if (!Array.isArray(parsed.destSegments) || parsed.destSegments.length === 0) {
    return fail("'destSegments' is not a non-empty array");
  }
  parsed.destSegments.forEach((segmentValue, i) => {
    if (typeof segmentValue !== 'string') fail(`'destSegments[${i}]' is not a string`);
    const violation = lockfilePathViolation(segmentValue as string);
    if (violation) fail(`'destSegments[${i}]' ${violation}`);
  });
  if (typeof parsed.stagingId !== 'string') return fail("'stagingId' is not a string");
  const stagingViolation = lockfilePathViolation(parsed.stagingId);
  if (stagingViolation) return fail(`'stagingId' ${stagingViolation}`);
  if (typeof parsed.hadDest !== 'boolean') return fail("'hadDest' is not a boolean");
  if (typeof parsed.root !== 'string' || parsed.root === '') {
    return fail("'root' is not a non-empty string");
  }
  if (typeof parsed.metadataHash !== 'string' || !SHA256_HEX_RE.test(parsed.metadataHash)) {
    return fail("'metadataHash' is not a lowercase 64-char sha256 hex digest");
  }
  if (parsed.label !== undefined && typeof parsed.label !== 'string') {
    return fail("'label' is not a string");
  }
  if (parsed.startedAt !== undefined && typeof parsed.startedAt !== 'number') {
    return fail("'startedAt' is not a number");
  }
  if (parsed.recoveryMarkerId !== undefined) {
    if (typeof parsed.recoveryMarkerId !== 'string') return fail("'recoveryMarkerId' is not a string");
    const markerViolation = lockfilePathViolation(parsed.recoveryMarkerId);
    if (markerViolation) return fail(`'recoveryMarkerId' ${markerViolation}`);
  }
  return parsed as unknown as InstallJournalV2;
}

/**
 * Validate a parsed journal of EITHER version (fail-closed, per-version).
 * `readAddJournal` dispatches here on the raw `version` field, so a v2 journal
 * is validated by the v2 rules and a v1 journal by the v1 rules — an older
 * release's journal and a CAS route's journal both recover.
 */
export function validateAnyInstallJournal(parsed: unknown, path: string): AnyInstallJournal {
  const version = isPlainObject(parsed) ? parsed.version : undefined;
  if (version === 1) return validateAddJournal(parsed, path);
  if (version === 2) return validateInstallJournalV2(parsed, path);
  throw journalValidationError(
    path,
    `unsupported journal version ${JSON.stringify(version)} (expected 1 or 2)`,
  );
}

// ---- external fresh-install corroboration -----------------------------------
//
// A v2 fresh install can crash after staging has been renamed to its final
// object path but before the index commit. At that point the journal, index,
// destination name, and absence of staging/backup are all repository-controlled
// or ambiguous. The marker below is created with O_EXCL in a directory outside
// the store root and records the exact transaction identity. Recovery will
// discard a destination in that otherwise ambiguous state only when the marker
// matches every journal field exactly.

export interface RecoveryMarkerRecord {
  version: 1;
  root: string;
  destSegments: string[];
  stagingId: string;
  hadDest: false;
}

export interface RecoveryMarkerHandle {
  id: string;
  path: string;
  markerDir: string;
  record: RecoveryMarkerRecord;
}

/** Derive the external marker directory from the caller's injected home. */
export function defaultRecoveryMarkerDir(home: string): string {
  if (home.trim() === '') throw new Error('cannot derive recovery marker directory from an empty home');
  return join(home, '.owenloop', 'recovery-markers');
}

function markerFilePath(markerDir: string, id: string): string {
  const violation = lockfilePathViolation(id);
  if (violation) throw new Error(`invalid recovery marker id '${id}': ${violation}`);
  return join(markerDir, `${id}.json`);
}

function validateRecoveryMarker(parsed: unknown, path: string): RecoveryMarkerRecord {
  const fail = (detail: string): never => {
    throw new Error(`invalid recovery marker at ${path}: ${detail}`);
  };
  if (!isPlainObject(parsed)) return fail('top-level value is not an object');
  if (parsed.version !== 1) return fail('unsupported marker version');
  if (typeof parsed.root !== 'string' || parsed.root === '') return fail("'root' is not a non-empty string");
  if (!Array.isArray(parsed.destSegments) || parsed.destSegments.length === 0) {
    return fail("'destSegments' is not a non-empty array");
  }
  for (const [i, value] of parsed.destSegments.entries()) {
    if (typeof value !== 'string') return fail(`'destSegments[${i}]' is not a string`);
    const violation = lockfilePathViolation(value);
    if (violation) return fail(`'destSegments[${i}]' ${violation}`);
  }
  if (typeof parsed.stagingId !== 'string') return fail("'stagingId' is not a string");
  const stagingViolation = lockfilePathViolation(parsed.stagingId);
  if (stagingViolation) return fail(`'stagingId' ${stagingViolation}`);
  if (parsed.hadDest !== false) return fail("'hadDest' must be false");
  return parsed as unknown as RecoveryMarkerRecord;
}

export function createRecoveryMarker(input: {
  root: string;
  destSegments: string[];
  stagingId: string;
  markerDir: string;
}): RecoveryMarkerHandle {
  const markerDir = input.markerDir;
  ensureDirectoryPathNoSymlink(markerDir, 'recovery marker directory');
  const record: RecoveryMarkerRecord = {
    version: 1,
    root: resolve(input.root),
    destSegments: [...input.destSegments],
    stagingId: input.stagingId,
    hadDest: false,
  };
  const id = `mkr_${randomUUID().replaceAll('-', '')}`;
  const path = markerFilePath(markerDir, id);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { id, path, markerDir, record };
}

export function readRecoveryMarker(id: string, markerDir: string): RecoveryMarkerRecord | null {
  // The marker directory is an operator-selected external path. Check the
  // directory leaf and immediate parent, while allowing platform-managed
  // aliases such as macOS /var → /private/var above that boundary.
  if (probeDirectoryPath(markerDir, 'recovery marker directory', dirname(markerDir)) === 'absent') return null;
  const path = markerFilePath(markerDir, id);
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined) return null;
  guardStateFile(path, 'recovery marker');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`corrupt recovery marker at ${path}: ${(e as Error).message}`);
  }
  return validateRecoveryMarker(parsed, path);
}

export function removeRecoveryMarker(handle: RecoveryMarkerHandle | { id: string; markerDir: string }): void {
  const markerDir = handle.markerDir;
  if (probeDirectoryPath(markerDir, 'recovery marker directory', dirname(markerDir)) === 'absent') return;
  const path = markerFilePath(markerDir, handle.id);
  guardStateFile(path, 'recovery marker');
  rmSync(path, { force: true });
}

/**
 * Read the crash-recovery journal (either version). Absent ⇒ `null` (the happy
 * path — no interrupted install to recover). Present-but-unparseable ⇒ a hard
 * error; present-but-schema-invalid ⇒ a hard error via
 * {@link validateAnyInstallJournal}. Never silently ignores a malformed journal
 * (that would let a crafted file quietly disable recovery) and never trusts it
 * for filesystem paths.
 */
export function readAddJournal(path: string): AnyInstallJournal | null {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined) return null;
  guardStateFile(path, 'crash-recovery journal');
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `corrupt crash-recovery journal at ${path}: ${(e as Error).message} — ` +
        `inspect and remove it manually, then re-run add`,
    );
  }
  return validateAnyInstallJournal(parsed, path);
}

/** Write a journal record atomically (tmp+rename), same discipline as the metadata file. */
export function writeAddJournal(
  path: string,
  journal: AnyInstallJournal,
  opts: AtomicJsonWriteOpts = {},
): void {
  guardStateFile(path, 'crash-recovery journal');
  writeJsonAtomic(path, journal, opts);
}

/** Remove the journal (force: absence is not an error — clean-completion / idempotent). */
export function removeAddJournal(path: string): void {
  guardStateFile(path, 'crash-recovery journal');
  rmSync(path, { force: true });
}

/** SHA-256 hex of raw bytes — the v2 journal's commit-point test primitive. */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Serialize metadata canonically before hashing/writing (same bytes both times). */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

// ---- recovery ------------------------------------------------------------------

/** Build a fail-closed recovery-refusal error naming the journal + manual remedy. */
function recoveryRefusal(journalPath: string, detail: string): Error {
  return new Error(
    `refusing crash-recovery: ${detail} — inspect ${journalPath} and the defs dir, ` +
      `resolve the state by hand, then re-run add`,
  );
}

/**
 * `lstat`-probe a recovery path: `'dir'` if it is a real directory, `'absent'`
 * if it does not exist. Fail-closed on anything else — a symlink (SEC-3: a
 * symlinked segment must never be renamed/rm'd, since finalize/rollback would
 * act through it) or a non-directory file is refused. `lstat`, never `stat`,
 * so a symlink is seen as a symlink, not followed to its target.
 *
 * The PARENT is checked too, not just the leaf: `lstat` on the leaf sees a
 * symlinked leaf, but a symlinked *parent* directory would be silently followed
 * by the `rename`/`rm` that acts on the leaf, redirecting the whole mutation
 * outside the root (a hostile checkout planting `.owenloop-staging` as a
 * symlink is exactly this). Refuse a symlinked immediate parent before trusting
 * the leaf probe. (Absent parent ⇒ the leaf is absent too; nothing to refuse.)
 */
function probeRecoveryDir(
  p: string,
  journalPath: string,
  label: string,
  trustedBoundary?: string,
): 'dir' | 'absent' {
  try {
    return probeDirectoryPath(p, label, trustedBoundary);
  } catch (e) {
    throw recoveryRefusal(journalPath, (e as Error).message);
  }
}

/** Re-assert resolved-path containment at a mutation target (belt-and-braces). */
function assertUnderRoot(p: string, root: string, journalPath: string): void {
  if (!resolve(p).startsWith(resolve(root) + sep)) {
    throw recoveryRefusal(journalPath, `path '${p}' escapes the install root`);
  }
}

/**
 * v1-only: read + validate the current ledger (fail-closed) and return a
 * lookup over its entries. Required whenever a v1 journal may exist (the
 * GitHub route always supplies it). A v2-only caller may omit it — recovery
 * then refuses a v1 journal instead of guessing. The lookup feeds both the
 * v1 commit-point test and the case-(c) old-name migration corroboration.
 */
export type LedgerLookup = (source: string) => { sha: string; path: string } | undefined;

export interface V2ReplacementRecoveryActions {
  /** Idempotently harden the replacement object recursively. */
  harden(objectDir: string): void;
  /** Verify canonical identity and exact hardened store modes. */
  verify(objectDir: string, digest: string): void;
}

export interface RecoverInterruptedInstallArgs {
  /** The CURRENT run's resolved root — every mutation path derives from it. */
  defsDir: string;
  /** Path to the crash-recovery journal. */
  journalPath: string;
  /** Metadata path (v1 `installed.json`, v2 `index.json`) used by ordinary commit-point checks. */
  lockfilePath: string;
  /** Directory holding external fresh-install corroboration markers. */
  recoveryMarkerDir?: string;
  /** CAS repair actions required to resume a swapped v2 replacement safely. */
  v2Replacement?: V2ReplacementRecoveryActions;
  /** See {@link LedgerLookup}. */
  readLedger?: () => LedgerLookup;
}

/**
 * What `recoverInterruptedInstall` DID, for callers (the offline `add --recover`
 * entry point) that report the result to the user. A refusal is NOT an outcome —
 * it throws. `'rolled-back'` collapses the roll-back table's terminal arms,
 * including the touch-nothing / already-consistent ones (distinguishing
 * "restored" from "was already consistent" per arm would thread state through
 * the decision table for message cosmetics only).
 */
export type RecoveryOutcome = 'no-journal' | 'rolled-forward' | 'rolled-back';

/**
 * Bring an interrupted install back to a consistent (tree ⇔ metadata) state,
 * then remove the journal. Called by install dispatchers under the root's
 * install lock, BEFORE the stale-staging cleanup (the backups a rollback needs
 * live under the staging root). No journal ⇒ returns immediately (happy path
 * unchanged). Reads BOTH journal versions and dispatches on `version`.
 *
 * Ordinary v1/v2 transactions use the durable metadata write as the commit
 * point. Same-digest v2 repair cannot: the index may already match before the
 * replacement starts, so explicit replacement phases control recovery.
 * Concretely:
 *
 *  1. `finalizing` ⇒ roll forward. V2 first re-verifies the exact destination's
 *     canonical bytes and hardened modes; only then may recovery discard the
 *     retained backup and staging root. V1 has no CAS verifier and performs the
 *     original cleanup behavior.
 *  2. V2 repair in `applying`, `replacement-swapped`,
 *     `replacement-hardened`, or `replacement-verified` ⇒ inspect disk state.
 *     If the swap did not complete, fall through to the rollback table and
 *     restore the prior backup. If the replacement occupies the destination and
 *     the prior backup is retained, resume hardening when needed, re-run content
 *     and exact-mode verification regardless of the recorded verified phase,
 *     advance to `finalizing`, and only then discard the backup. A matching index
 *     hash never accepts a repair by itself.
 *  3. Ordinary `applying` + the commit-point test passes (v1: ledger records
 *     this exact source@sha/path; v2: `hash(current metadata bytes) ===
 *     metadataHash`) ⇒ the commit MAY have landed, but the test alone does not
 *     prove it. Destination present means the swap completed and recovery rolls
 *     forward. Destination absent means recovery is inside the destination →
 *     backup / staging → destination window, so recovery restores the backup
 *     instead of deleting the only copy.
 *  4. Ordinary `applying`, commit point not reached ⇒ roll back through the
 *     guarded, idempotent decision table below (mirroring
 *     `rollbackInstallCommit`'s order) — EXCEPT the v1 case-(c) fresh-install
 *     discard, which acts on the journal alone and therefore requires ledger
 *     corroboration of an interrupted old-name migration. V2 has no
 *     journal-alone destructive arm, so a forged v2 journal cannot delete an
 *     unrelated destination.
 *
 * Crash-safety of recovery itself: the journal is removed LAST, after all
 * restore/discard renames, and every step is a single atomic rename guarded by
 * existence probes — so a crash mid-recovery leaves the journal intact and a
 * strict subset of the work done; the next attempt re-derives state from disk
 * and continues. Running it twice is a no-op the second time.
 *
 * Any refusal (invalid journal, root mismatch, symlink where a directory is
 * expected, contradictory disk state) throws WITHOUT mutating anything and
 * leaves the journal in place; callers must preserve the staging root on
 * refusal so the `finally` cannot destroy the backups a later attempt needs.
 */
export function recoverInterruptedInstall(args: RecoverInterruptedInstallArgs): RecoveryOutcome {
  const { defsDir, journalPath, lockfilePath } = args;
  const journal = readAddJournal(journalPath);
  if (journal === null) return 'no-journal'; // no interrupted install — happy path, unchanged.

  // An interrupted install in a DIFFERENT root: recovering "here" would act on
  // paths this invocation was never pointed at, and trusting the recorded
  // absolute path would let a crafted journal point mutations anywhere. Fail
  // closed — the operator must re-run with the same --defs/OWENLOOP_DEFS (v1)
  // or the same store root (v2).
  if (journal.version === 1) {
    if (resolve(journal.defsDir) !== resolve(defsDir)) {
      throw recoveryRefusal(
        journalPath,
        `journal records defs dir '${journal.defsDir}', but this add resolved '${resolve(defsDir)}' ` +
          `(re-run add with the same --defs/OWENLOOP_DEFS)`,
      );
    }
  } else if (resolve(journal.root) !== resolve(defsDir)) {
    throw recoveryRefusal(
      journalPath,
      `journal records store root '${journal.root}', but this run resolved '${resolve(defsDir)}' ` +
        `(re-run against the same store root)`,
    );
  }

  // Every mutation path is derived HERE from the current root + the validated
  // segments — never from the recorded absolute root.
  const destSegments = journal.version === 1 ? [journal.folder] : journal.destSegments;
  const stagingRoot = join(defsDir, STAGING_DIRNAME);
  const stagingDir = join(stagingRoot, journal.stagingId);
  const backupDir = `${stagingDir}-old`;
  const undoDir = `${stagingDir}-undo`;
  const dest = join(defsDir, ...destSegments);
  // v1-only extra paths.
  const parkedOldName = journal.version === 1 && journal.oldNamePath !== undefined
    ? `${undoDir}-oldname`
    : undefined;
  const oldNameOriginal = journal.version === 1 && journal.oldNamePath !== undefined
    ? join(defsDir, journal.oldNamePath)
    : undefined;

  // Symlink-guard the staging ROOT itself before deriving any mutation from it.
  // A hostile checkout that ships `.owenloop-staging` as a symlink would make
  // every rename/rm below act through it, moving/deleting dirs OUTSIDE the
  // root. `lstat` (never `stat`) so the link is seen as a link; a non-dir
  // squatting there is refused too; absent is fine (a fresh recovery mkdirs
  // it). This runs BEFORE any fs mutation, and recovery precedes the caller's
  // staging-root clear, so nothing else clears it first.
  const stagingRootSt = lstatSync(stagingRoot, { throwIfNoEntry: false });
  if (stagingRootSt?.isSymbolicLink()) {
    throw recoveryRefusal(journalPath, `staging root '${stagingRoot}' is a symlink`);
  }
  if (stagingRootSt && !stagingRootSt.isDirectory()) {
    throw recoveryRefusal(journalPath, `staging root '${stagingRoot}' is not a directory`);
  }

  // Belt-and-braces containment: re-assert that EVERY rename/rm source and
  // target resolves under the root — not just dest, but every staging-derived
  // path too (a crafted journal + a symlinked staging root must not drive a
  // mutation outside the tree). Validated segments already make lexical
  // traversal unrepresentable; this is the extra guard on the derived paths.
  for (const p of [stagingRoot, stagingDir, backupDir, undoDir, dest]) {
    assertUnderRoot(p, defsDir, journalPath);
  }
  if (parkedOldName !== undefined) assertUnderRoot(parkedOldName, defsDir, journalPath);
  if (oldNameOriginal !== undefined) assertUnderRoot(oldNameOriginal, defsDir, journalPath);

  const removeRecoveryMarkerAfterJournal = (): void => {
    if (journal.version === 2 && journal.recoveryMarkerId !== undefined) {
      if (args.recoveryMarkerDir === undefined) {
		throw recoveryRefusal(journalPath, 'external recovery marker directory was not supplied');
      }
      removeRecoveryMarker({ id: journal.recoveryMarkerId, markerDir: args.recoveryMarkerDir });
    }
  };

  // Roll forward: the metadata is durably new; discard the retained backup (+
  // parked old-name dir, v1) and clear the staging root, then drop the journal.
  // Symlink-guarded before each rm; both dirs live under the staging root, so
  // the final clear is the real cleanup — the explicit rms honor "refuse a
  // symlink" first.
  const rollForward = (): void => {
    if (probeRecoveryDir(backupDir, journalPath, 'backup dir', defsDir) === 'dir') {
      rmRecursiveForce(backupDir);
    }
    if (parkedOldName !== undefined) {
      if (probeRecoveryDir(parkedOldName, journalPath, 'parked old-name dir', defsDir) === 'dir') {
        rmRecursiveForce(parkedOldName);
      }
    }
    rmRecursiveForce(stagingRoot);
    removeAddJournal(journalPath);
    removeRecoveryMarkerAfterJournal();
  };

  const requireV2ReplacementActions = (): V2ReplacementRecoveryActions => {
    if (args.v2Replacement === undefined) {
      throw recoveryRefusal(
	journalPath,
	'a v2 content-addressed replacement requires canonical and hardened-mode recovery verification',
      );
    }
    return args.v2Replacement;
  };

  const verifyV2Destination = (): void => {
    if (journal.version !== 2) return;
    const digest = journal.destSegments.at(-1);
    if (digest === undefined) {
      throw recoveryRefusal(journalPath, 'v2 destination has no digest segment');
    }
    try {
      requireV2ReplacementActions().verify(dest, digest);
    } catch (e) {
      throw recoveryRefusal(
	journalPath,
	`replacement at '${dest}' failed canonical or hardened-mode verification: ${(e as Error).message}`,
      );
    }
  };

  const resumeV2Repair = (): RecoveryOutcome => {
    if (journal.version !== 2) {
      throw recoveryRefusal(journalPath, 'internal recovery error: attempted v2 repair recovery for a v1 journal');
    }
    const stagingState = probeRecoveryDir(stagingDir, journalPath, 'staging dir', defsDir);
    const backupState = probeRecoveryDir(backupDir, journalPath, 'backup dir', defsDir);
    const destState = probeRecoveryDir(dest, journalPath, 'destination', defsDir);

    // A swap that never completed, or a rollback that was interrupted between
    // its two renames, must restore the retained prior object instead of trying
    // to commit an absent/partial replacement.
    if (stagingState === 'dir' || destState === 'absent') {
      return 'rolled-back';
    }
    if (backupState !== 'dir') {
      throw recoveryRefusal(
	journalPath,
	`repair phase '${journal.phase}' has no retained prior-object backup at '${backupDir}'`,
      );
    }

    const actions = requireV2ReplacementActions();
    const digest = journal.destSegments.at(-1);
    if (digest === undefined) {
      throw recoveryRefusal(journalPath, 'v2 destination has no digest segment');
    }
    if (journal.phase === 'applying' || journal.phase === 'replacement-swapped') {
      try {
	actions.harden(dest);
      } catch (e) {
	throw recoveryRefusal(journalPath, `could not finish replacement hardening: ${(e as Error).message}`);
      }
      writeAddJournal(journalPath, { ...journal, phase: 'replacement-hardened', operation: 'repair' });
    }

    // Re-run verification even when the durable phase already says verified.
    // The journal proves ordering, not that the object was not modified after a
    // crash. No backup is discarded until both invariants pass again now.
    try {
      actions.verify(dest, digest);
    } catch (e) {
      throw recoveryRefusal(
	journalPath,
	`replacement at '${dest}' failed canonical or hardened-mode verification: ${(e as Error).message}`,
      );
    }
    writeAddJournal(journalPath, { ...journal, phase: 'replacement-verified', operation: 'repair' });
    writeAddJournal(journalPath, { ...journal, phase: 'finalizing', operation: 'repair' });
    rollForward();
    return 'rolled-forward';
  };

  if (journal.phase === 'finalizing') {
    // A v2 finalizing journal may be left after the index commit but before the
    // backup was deleted. Re-verify the exact destination, including immutable
    // store modes, before accepting it and deleting the retained prior object.
    verifyV2Destination();
    rollForward();
    return 'rolled-forward';
  }

  if (journal.version === 2 && journal.phase !== 'applying') {
    const outcome = resumeV2Repair();
    if (outcome === 'rolled-forward') return outcome;
    // A swapped-state journal with staging still present or destination absent
    // falls through to the ordinary rollback table below.
  }

  // phase === 'applying': the metadata write may or may not have landed. The
  // commit-point test is version-specific: v1 matches the ledger on
  // source+sha+path; v2 hashes the CURRENT metadata bytes against the
  // journal's metadataHash. A corrupt metadata file aborts exactly as the
  // route's own read would (fail-closed).
  let commitPointReached = false;
  let v1Lookup: LedgerLookup | undefined;
  if (journal.version === 2) {
    let metaBytes: Uint8Array | undefined;
    try {
      metaBytes = readRegularFileNoFollow(lockfilePath, 'install metadata');
    } catch (e) {
      throw recoveryRefusal(journalPath, (e as Error).message);
    }
    commitPointReached = sha256Hex(metaBytes ?? new Uint8Array()) === journal.metadataHash;
  } else {
    if (args.readLedger === undefined) {
      throw recoveryRefusal(
        journalPath,
        'a v1 (GitHub-route) journal requires the GitHub recovery entry point (owenloop add --recover)',
      );
    }
    v1Lookup = args.readLedger();
    const installed = v1Lookup(journal.source);
    commitPointReached =
      installed !== undefined && installed.sha === journal.sha && installed.path === journal.folder;
  }

  const applyingRepair =
    journal.version === 2 &&
    journal.hadDest &&
    (
      journal.operation === 'repair' ||
      (
	journal.operation === undefined &&
	commitPointReached &&
	probeRecoveryDir(backupDir, journalPath, 'backup dir', defsDir) === 'dir'
      )
    );
  if (applyingRepair) {
    const outcome = resumeV2Repair();
    if (outcome === 'rolled-forward') return outcome;
    // The swap did not complete. Unchanged same-digest metadata is not a commit
    // signal for repair; force the guarded rollback table below.
    commitPointReached = false;
  }

  if (commitPointReached) {
    // The metadata records this exact install — but the test ALONE does NOT
    // prove the commit swap landed. Branch on ACTUAL disk state:
    //  - dest PRESENT ⇒ the swap completed (a crash in the metadata-write→
    //    phase-rewrite window, or a same-content re-install already past the
    //    swap): dest holds that content, so (tree ⇔ metadata) is consistent ⇒
    //    roll forward (discard the now-stale backup).
    //  - dest ABSENT ⇒ we are inside commitInstall's backup→swap window of a
    //    SAME-content re-install (dest was renamed to backupDir, and the
    //    staging→dest swap never ran). backupDir now holds the ONLY copy of
    //    the content. Rolling forward would `rmSync` it — silent data loss,
    //    leaving the metadata claiming an install that is gone from disk. Fall
    //    THROUGH to the roll-back table, which restores backupDir → dest; the
    //    metadata already records this content, so the restored state is
    //    consistent. The two cases are distinguishable by disk, so branch on
    //    it rather than trusting the commit-point test alone.
    if (probeRecoveryDir(dest, journalPath, 'destination', defsDir) === 'dir') {
      rollForward();
      return 'rolled-forward';
    }
  }

  // ROLL BACK — restore the pre-commit directory state. Guarded idempotent
  // renames mirroring rollbackInstallCommit's order; a symlinked source is
  // refused fail-closed at each probe.
  mkdirSync(stagingRoot, { recursive: true }); // ensure undo/backup renames have a home
  const stagingState = probeRecoveryDir(stagingDir, journalPath, 'staging dir', defsDir);
  const backupState = probeRecoveryDir(backupDir, journalPath, 'backup dir', defsDir);

  // Every rename here moves a directory that may hold a hardened CAS object
  // (the backup of a previous install, or the swapped-in new content) — they
  // go through renameDirRestoringWrite so a 0o555 dir can still be moved.
  if (stagingState === 'dir') {
    // (a) Swap 4b (staging → dest) never happened.
    if (backupState === 'dir') {
      // Crash between 4a (dest → backup) and 4b: dest is necessarily absent.
      // Restore the backup. Fail closed if dest unexpectedly exists too.
      if (probeRecoveryDir(dest, journalPath, 'destination', defsDir) === 'dir') {
        throw recoveryRefusal(journalPath, `both the backup dir and destination '${dest}' exist`);
      }
      renameDirRestoringWrite(backupDir, dest);
    }
    // else backup absent: dest still holds the original (upgrade, pre-backup) or
    // is absent (fresh install, pre-swap) — already consistent, nothing to move.
  } else if (backupState === 'dir') {
    // (b) Staging gone, backup present — an upgrade crashed AFTER the swap.
    if (probeRecoveryDir(dest, journalPath, 'destination', defsDir) === 'dir') {
      // Park the new content aside, then restore the backup over dest.
      if (probeRecoveryDir(undoDir, journalPath, 'undo dir', defsDir) === 'dir') {
        throw recoveryRefusal(journalPath, `undo dir '${undoDir}' already exists`);
      }
      renameDirRestoringWrite(dest, undoDir);
      renameDirRestoringWrite(backupDir, dest);
    } else {
      // dest absent: a prior rollback/recovery died between its two renames (the
      // new content is already parked under undoDir) — just restore the backup.
      renameDirRestoringWrite(backupDir, dest);
    }
  } else {
    // (c) Staging gone, backup gone.
    if (!journal.hadDest && journal.version === 1) {
      // Fresh install: the swap may have put new content at dest. Discarding it
      // (rename → undoDir, then rm with the staging root at step (e)) is the ONLY
      // destructive arm that acts on the word of the journal alone — staging and
      // backup are both absent by definition of case (c), so the journal is the
      // only thing asserting this dir is a crash orphan. But the journal lives in
      // repository-controlled content (the journal is committable), so a hostile
      // checkout can forge a schema-VALID `applying`/`hadDest:false` journal
      // naming an existing UNRELATED workflow dir and drive its deletion. Fail
      // closed: only delete when the LEDGER corroborates that this dest is a
      // fresh hashed dir left by an interrupted OLD-NAME MIGRATION — i.e. the
      // ledger still records `journal.source` at the migration's old-name path.
      // That is exactly the state of the corroborated old-name-migration crash;
      // the parked old-name dir is NOT required as evidence (a crash in the
      // swap→park window legitimately has no parked dir yet). Anything else — no
      // ledger entry, or an entry at some other path (including `journal.folder`
      // itself, which contradicts `hadDest:false`) — is uncorroborated: refuse,
      // mutate nothing, leave the journal AND dest in place as evidence.
      //
      // Deliberate, documented regression: the genuine fresh-install crash between
      // the swap and the metadata write (dest present, no ledger, no staging, no
      // backup) is on-disk INDISTINGUISHABLE from the forgery — every
      // distinguishing artifact is itself repo-committable and therefore forgeable
      // — so it now fails closed here instead of auto-discarding. The error names
      // the manual remedy.
      if (probeRecoveryDir(dest, journalPath, 'destination', defsDir) === 'dir') {
        const installedAtSource = v1Lookup?.(journal.source);
        const migrationCorroborated =
          journal.oldNamePath !== undefined &&
          installedAtSource !== undefined &&
          installedAtSource.path === journal.oldNamePath;
        if (!migrationCorroborated) {
          throw recoveryRefusal(
            journalPath,
            `journal claims an interrupted fresh install of '${journal.folder}', but nothing ` +
              `corroborates it (no ledger entry for this source at the journal's old-name path, ` +
              `no staging dir, no backup) while '${dest}' exists — refusing to discard that ` +
              `directory. If you did not run an interrupted add in this checkout, remove the ` +
              `journal; if a fresh install really was interrupted, remove '${dest}' as well`,
          );
        }
	if (probeRecoveryDir(undoDir, journalPath, 'undo dir', defsDir) === 'dir') {
          throw recoveryRefusal(journalPath, `undo dir '${undoDir}' already exists`);
        }
        renameDirRestoringWrite(dest, undoDir);
      }
    }
    // v2 case (c): staging gone, backup gone. A fresh v2 install (hadDest
    // false) may have completed the swap immediately before the process died.
    // The external marker is the only corroboration trusted for discarding the
    // orphaned destination; a journal without an exact marker match remains a
    // forged-journal refusal and is never allowed to delete an unrelated dir.
    if (!journal.hadDest && journal.version === 2) {
      if (probeRecoveryDir(dest, journalPath, 'destination', defsDir) === 'dir') {
	let marker: RecoveryMarkerRecord | null = null;
	if (journal.recoveryMarkerId !== undefined) {
	  if (args.recoveryMarkerDir === undefined) {
	    throw recoveryRefusal(journalPath, 'external recovery marker directory was not supplied');
	  }
	  try {
	    marker = readRecoveryMarker(journal.recoveryMarkerId, args.recoveryMarkerDir);
	  } catch (e) {
	    throw recoveryRefusal(journalPath, `external recovery marker could not be read: ${(e as Error).message}`);
	  }
	}
	const markerMatches =
	  marker !== null &&
	  resolve(marker.root) === resolve(defsDir) &&
	  marker.stagingId === journal.stagingId &&
	  marker.hadDest === false &&
	  marker.destSegments.length === journal.destSegments.length &&
	  marker.destSegments.every((segment, i) => segment === journal.destSegments[i]);
	if (!markerMatches) {
	  throw recoveryRefusal(
	    journalPath,
	    `journal claims an interrupted fresh install of '${journal.destSegments.join('/')}', but no ` +
	      `matching external recovery marker corroborates it (no staging dir, no backup, and the ` +
	      `metadata does not match this journal) while '${dest}' exists — refusing to discard that ` +
	      `directory. If you did not run an interrupted install in this store, remove the journal; if ` +
	      `an install really was interrupted, remove '${dest}' as well`,
	  );
	}
	if (probeRecoveryDir(undoDir, journalPath, 'undo dir', defsDir) === 'dir') {
	  throw recoveryRefusal(journalPath, `undo dir '${undoDir}' already exists`);
	}
	renameDirRestoringWrite(dest, undoDir);
      }
    }
    // v1/v2 hadDest === true: the backup was already restored (a completed
    // in-process rollback whose journal-remove failed, or a prior recovery
    // attempt) — dirs are consistent; touch nothing.
  }

  // (d) Restore a parked old-name dir to where the (unchanged) ledger expects
  // it (v1 only — v2 journals never migrate an old name).
  if (parkedOldName !== undefined && oldNameOriginal !== undefined) {
    if (probeRecoveryDir(parkedOldName, journalPath, 'parked old-name dir', defsDir) === 'dir') {
      if (probeRecoveryDir(oldNameOriginal, journalPath, 'old-name original', defsDir) === 'dir') {
        // Both present is contradictory — unreachable under the single-writer
        // lock, so don't guess which to keep.
        throw recoveryRefusal(
          journalPath,
          `both the parked old-name dir and its original '${oldNameOriginal}' exist`,
        );
      }
      renameDirRestoringWrite(parkedOldName, oldNameOriginal);
    }
    // parked absent ⇒ already restored (idempotent re-run) — skip.
  }

  // (e) The undo/backup leftovers are debris now; clear the staging root and
  // remove the journal LAST so a crash before this leaves everything replayable.
  rmRecursiveForce(stagingRoot);
  removeAddJournal(journalPath);
  removeRecoveryMarkerAfterJournal();
  return 'rolled-back';
}
