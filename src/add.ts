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
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
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

/**
 * Returns `undefined` if `relPath` is a safe SINGLE-SEGMENT lockfile install
 * path, else a human-readable reason it must be rejected. Stricter than
 * {@link archivePathViolation}: a lockfile entry's `path` is one on-disk path
 * segment by construction — both the current `<owner>-<repo>-<hash>` scheme and
 * the only legacy scheme this tool ever wrote (`<owner>-<repo>`, see
 * {@link installFolder}) — so ANY separator is refused outright. That single
 * rule makes `..` traversal, `.owenloop/../../x`, and nested escape shapes
 * unrepresentable before any `join`/`rename` ever touches the path. Like
 * `archivePathViolation` this is reject-don't-normalize: a bad path is refused,
 * never canonicalized into a "safe" one.
 */
export function lockfilePathViolation(relPath: string): string | undefined {
  // Reuse the shared checks (empty, NUL, absolute, '.'/'..' segments, length).
  const base = archivePathViolation(relPath);
  if (base) return base;
  // A lockfile install path additionally must be a single segment: no
  // separators at all, so a multi-segment on-disk path like 'legacy/olddir'
  // (which passes archivePathViolation) is still refused here.
  if (/[\\/]/.test(relPath)) return 'contains a path separator';
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

/**
 * One installed-package record. `path` is a single on-disk folder segment (see
 * {@link lockfilePathViolation}); `sha` is a 40-char hex commit sha; `source`
 * equals the record's key in {@link Lockfile.installed}. These invariants are
 * NOT trusted from disk — {@link validateLockfile} enforces every one on read,
 * fail-closed, before any consumer acts on an entry.
 */
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

/** A 40-char hex commit sha (case-insensitive), as GitHub returns. */
const SHA_HEX_RE = /^[0-9a-f]{40}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structurally validate a parsed `installed.json`, fail-closed. A
 * parseable-but-schema-invalid lockfile is a hard error naming the offending
 * entry+field — never silently reset to `{}` (which would erase ownership
 * records and re-enable the clobbering {@link installFolder} was hardened
 * against) and never normalized. This is the trust boundary for the lockfile:
 * downstream code (`dispatchAdd`, `parkOldNameDir`) may only act on entries
 * that have passed through here. Critically, EVERY entry is validated, not just
 * the one being installed — `dispatchAdd` re-serializes the whole lockfile on
 * success, so acting while carrying a poisoned sibling entry would re-persist
 * it. Unknown extra keys (on the lockfile or an entry) are tolerated for
 * forward compatibility; required shape is enforced, additions are not
 * forbidden. Returns the value narrowed to {@link Lockfile}. `path` appears
 * only in error messages.
 */
export function validateLockfile(parsed: unknown, path: string): Lockfile {
  const fail = (detail: string): never => {
    throw new Error(`invalid lockfile at ${path}: ${detail} — fix or remove it manually`);
  };
  if (!isPlainObject(parsed)) return fail('top-level value is not an object');
  if (parsed.version !== 1) {
    return fail(`unsupported lockfile version ${JSON.stringify(parsed.version)} (expected 1)`);
  }
  if (!isPlainObject(parsed.installed)) return fail("'installed' is not an object");
  for (const [key, entry] of Object.entries(parsed.installed)) {
    const at = (field: string): string => `installed[${JSON.stringify(key)}].${field}`;
    if (!isPlainObject(entry)) return fail(`installed[${JSON.stringify(key)}] is not an object`);
    if (typeof entry.source !== 'string' || entry.source === '') {
      return fail(`${at('source')} is not a non-empty string`);
    }
    if (entry.source !== key) {
      return fail(`${at('source')} '${entry.source}' does not match its key '${key}'`);
    }
    if (typeof entry.ref !== 'string' || entry.ref === '') {
      return fail(`${at('ref')} is not a non-empty string`);
    }
    if (typeof entry.sha !== 'string' || !SHA_HEX_RE.test(entry.sha)) {
      return fail(`${at('sha')} is not a 40-char hex commit sha`);
    }
    if (typeof entry.installedAt !== 'number' || !Number.isFinite(entry.installedAt)) {
      return fail(`${at('installedAt')} is not a finite number`);
    }
    if (typeof entry.path !== 'string') return fail(`${at('path')} is not a string`);
    const pathViolation = lockfilePathViolation(entry.path);
    if (pathViolation) return fail(`${at('path')} ${pathViolation}`);
    if (!Array.isArray(entry.files)) return fail(`${at('files')} is not an array`);
    entry.files.forEach((file, i) => {
      if (typeof file !== 'string') return fail(`${at(`files[${i}]`)} is not a string`);
      const fileViolation = archivePathViolation(file);
      if (fileViolation) return fail(`${at(`files[${i}]`)} ${fileViolation}`);
    });
  }
  return parsed as unknown as Lockfile;
}

/**
 * Read `.owenloop/installed.json`; a missing file is an empty lockfile, not an
 * error. A file that exists but does not parse is a hard error naming the path
 * — never silently reset to `{}`, which would erase ownership records and
 * re-enable the clobbering `installFolder` was hardened against. A file that
 * parses but is structurally invalid (bad version, malformed entry, a `path`
 * that is not a safe single segment, a bad `sha`/`files`) is likewise a
 * fail-closed hard error — see {@link validateLockfile}. The lockfile is never
 * trusted for filesystem paths.
 */
export function readLockfile(path: string): Lockfile {
  if (!existsSync(path)) return { version: 1, installed: {} };
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`corrupt lockfile at ${path}: ${(e as Error).message} — fix or remove it manually`);
  }
  return validateLockfile(parsed, path);
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
 *
 * Defense-in-depth (Layer 3): even though `readLockfile`/`validateLockfile` and
 * the use-site in `dispatchAdd` already constrain `oldRelPath` to a safe single
 * segment, the authoritative containment check is re-asserted HERE, at the
 * mutation site, before any rename — a poisoned `existing.path` must never move
 * a directory outside `defsDir` (which `finalizeInstallCommit` would then
 * recursively delete). Following this project's TOCTOU discipline, the check
 * that matters is the one at the filesystem operation, not only up front:
 * `oldRelPath` must be a single segment AND resolve under `defsDir`, and the
 * target must be a real directory — a symlink at the legacy path is refused (a
 * symlinked segment must never be parked/finalized, since finalize deletes it).
 * Deliberate behavior change vs. the old `existsSync` probe: a DANGLING symlink
 * at the old path was previously silently ignored (existsSync follows links);
 * it is now refused, which is fail-closed and correct.
 */
export function parkOldNameDir(handle: InstallCommitHandle, defsDir: string, oldRelPath: string): void {
  const violation = lockfilePathViolation(oldRelPath);
  if (violation) {
    throw new Error(`refusing old-name migration path '${oldRelPath}': ${violation}`);
  }
  const originalPath = join(defsDir, oldRelPath);
  // Resolved-path containment: '..'-free by the single-segment rule above, but
  // recompute at the rename site so no path outside defsDir can ever be moved.
  if (!resolve(originalPath).startsWith(resolve(defsDir) + sep)) {
    throw new Error(`refusing old-name migration path '${oldRelPath}': escapes the defs directory`);
  }
  let st;
  try {
    st = lstatSync(originalPath); // lstat, not stat: never follow a symlink here.
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // already gone — nothing to park
    throw e;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`refusing old-name migration: '${originalPath}' is a symlink`);
  }
  if (!st.isDirectory()) {
    throw new Error(`refusing old-name migration: '${originalPath}' is not a directory`);
  }
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
  /** Per-acquisition ownership token — present when `acquired`; proof of ownership for release. */
  token?: string;
}

/** Parsed shape of a lock-file payload. Every field is optional so a legacy or partial payload still parses. */
interface LockHolder {
  pid?: number;
  startedAt?: number;
  token?: string;
  host?: string;
}

export interface AcquireLockOpts {
  /** Max time to wait for a live lock before failing cleanly (default 10s). */
  waitMs?: number;
  /**
   * Age (by mtime) past which an *unparseable/abandoned* lock may be reclaimed
   * (default 10m). Age NEVER reclaims a lock whose recorded pid is alive on
   * this host — it only governs the fail-closed fallback for a lock we cannot
   * attribute to a live owner (unparseable payload, or one without a pid).
   */
  staleMs?: number;
  /** Poll interval while waiting on a live lock (default 100ms). */
  pollMs?: number;
  /** Liveness probe for the holder pid — injectable so tests are deterministic. */
  isPidAlive?: (pid: number) => boolean;
  /** Clock — injectable so tests are deterministic. */
  now?: () => number;
  /** Current hostname — injectable so cross-host tests are deterministic (default `os.hostname`). */
  hostname?: () => string;
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

/** Read the lock file's raw bytes, or `null` if it is gone/unreadable. */
function readLockRaw(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
}

/** Parse raw lock bytes into a holder, or `null` if absent/unparseable. */
function parseLockHolder(raw: string | null): LockHolder | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as LockHolder;
  } catch {
    return null;
  }
}

/** Read + parse the lock file in one step (fresh read). Used off the hot loop. */
function readLockHolder(lockPath: string): LockHolder | null {
  return parseLockHolder(readLockRaw(lockPath));
}

/**
 * Decide whether the lock described by `holder` (parsed from a raw read) may be
 * reclaimed, given the current host. Liveness-aware, not age-based:
 *
 *   1. `statSync` fails — the lock vanished mid-judgment → treat as reclaimable
 *      (the acquire loop re-verifies and simply retries the exclusive create).
 *   2. Holder records a `host` that differs from ours → NOT stale, ever. A
 *      foreign PID space means `process.kill(pid, 0)` proves nothing; a shared
 *      filesystem could be locked by another machine. Held; caller refuses.
 *   3. Holder has a numeric `pid` and either matches our host or omits `host`
 *      (a legacy same-machine payload) → stale iff that pid is dead. Age never
 *      reclaims a live-pid lock — this is the core safety policy.
 *   4. Unparseable, or parses without a numeric pid → fail closed: held until
 *      `now() - mtimeMs > staleMs` (age is the only abandonment signal left).
 */
function lockIsStale(
  lockPath: string,
  holder: LockHolder | null,
  staleMs: number,
  isPidAlive: (pid: number) => boolean,
  now: () => number,
  currentHost: string,
): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    // Vanished between the EEXIST and here — someone else reclaimed it; retry.
    return true;
  }
  // Case 2: recorded on a different host — its pid tells us nothing. Held.
  if (holder && typeof holder.host === 'string' && holder.host !== currentHost) {
    return false;
  }
  // Case 3: same host (or legacy no-host payload) with a numeric pid — liveness decides.
  if (holder && typeof holder.pid === 'number') {
    return !isPidAlive(holder.pid);
  }
  // Case 4: no attributable live owner — age is the only abandonment signal.
  return now() - mtimeMs > staleMs;
}

/**
 * Acquire the per-project install lock at `lockPath` (an exclusive-create of the
 * file, `openSync(..,'wx')` — the O_EXCL create is the real serialization point).
 * The payload carries an ownership token, the owner pid, a start timestamp, and
 * the host. If another process holds it: reclaim it only when liveness-aware
 * staleness says its owner is gone (see `lockIsStale`), otherwise poll until it
 * frees, and if it does not free within `waitMs` fail cleanly with a clear
 * in-progress message. Always pair with `releaseInstallLock` in a `finally`.
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
  const host = (opts.hostname ?? hostname)();

  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      const token = randomBytes(16).toString('hex');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now(), token, host }));
      } finally {
        closeSync(fd);
      }
      return { lockPath, acquired: true, token };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    // Judge staleness from a single captured raw read...
    const raw = readLockRaw(lockPath);
    const holder = parseLockHolder(raw);
    if (lockIsStale(lockPath, holder, staleMs, isPidAlive, now, host)) {
      // ...then re-verify the bytes are unchanged immediately before deleting.
      // Between judging stale and rmSync a third process could reclaim and
      // re-create the lock; deleting then would destroy a *fresh* owner's lock.
      // Residual window is a few syscalls (read-compare-delete) rather than the
      // poll interval — and the `wx` create below is the true arbiter: if two
      // reclaimers race, one wins the create and the other loops on EEXIST. A
      // rename-based reclaim was rejected: POSIX rename clobbers its target, so
      // any "rename back on mismatch" arm can itself destroy a newer lock.
      const raw2 = readLockRaw(lockPath);
      if (raw2 !== null && raw2 === raw) {
        rmSync(lockPath, { force: true });
        continue; // reclaimed — retry the exclusive create
      }
      // Bytes changed under us, or the lock is stat-able but unreadable (a
      // root-owned 0600 lock: statSync needs only dir perms, readFileSync
      // EACCES → raw/raw2 null). Do NOT delete — fall through to the deadline
      // check and poll sleep below. Never `continue` here: with an unreadable,
      // backdated lock this branch would otherwise spin sleeplessly, starving
      // the event loop and never enforcing `waitMs`.
    }
    if (now() >= deadline) {
      throw new Error(inProgressMessage(lockPath, holder, waitMs));
    }
    await sleep(pollMs);
  }
}

/** Build the clear "another add is in progress" timeout error, with graceful fallbacks. */
function inProgressMessage(lockPath: string, holder: LockHolder | null, waitMs: number): string {
  const who = typeof holder?.pid === 'number' ? `pid ${holder.pid}` : 'another process';
  // Lock content is untrusted input: a finite `startedAt` outside the ECMAScript
  // Date range (|t| > 8.64e15 ms) makes `new Date(t).toISOString()` throw
  // RangeError. Only render held-since when the value is a valid time value;
  // otherwise omit it (same graceful fallback as an absent startedAt).
  const heldSince =
    typeof holder?.startedAt === 'number' &&
    Number.isFinite(holder.startedAt) &&
    Math.abs(holder.startedAt) <= 8.64e15
      ? `, held since ${new Date(holder.startedAt).toISOString()}`
      : '';
  const s = Math.round(waitMs / 1000);
  return `another owenloop add is in progress (${who}${heldSince}) — holds ${lockPath}; timed out waiting after ${s}s`;
}

/**
 * Release a lock acquired by `acquireInstallLock`. Token-checked and
 * best-effort: a no-op if not acquired, if the lock is already gone/unparseable,
 * or if its token no longer matches this handle (someone else legitimately
 * re-acquired it — deleting would steal *their* lock). Never throws; it runs in
 * `dispatchAdd`'s `finally` and must not mask the real error.
 */
export function releaseInstallLock(handle: InstallLockHandle): void {
  if (!handle.acquired) return;
  try {
    const holder = readLockHolder(handle.lockPath);
    if (!holder || holder.token !== handle.token) return;
    rmSync(handle.lockPath, { force: true });
  } catch {
    // Already reclaimed/replaced, or an unexpected fs error — swallow.
  }
}
