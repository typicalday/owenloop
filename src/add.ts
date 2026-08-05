/**
 * The GitHub route for `owenloop add <owner>/<repo>[@ref]`: spec parsing, URL
 * building, the `installed.json` ledger, old-name migration parking, and the
 * v1 crash-recovery adapter. The host-neutral filesystem transaction this
 * route rides on — safe staging, the atomic swap with a retained backup,
 * finalize/rollback, the atomic metadata write, the install lock, and the
 * two-phase journal + recovery — lives in `src/install.ts` (engine core);
 * this module keeps only what is GitHub-specific and re-exports the shared
 * names callers and tests have always imported from here.
 *
 * The network fetch and arg glue live in `src/cli.ts` (`dispatchAdd`) so this
 * module stays trivially unit-testable.
 */

import { existsSync, lstatSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  commitInstall as commitInstallGeneric,
  finalizeInstallCommit as finalizeInstallCommitGeneric,
  acquireInstallLock as acquireInstallLockGeneric,
  lockfilePathViolation,
  archivePathViolation,
  recoverInterruptedInstall as recoverInterruptedInstallGeneric,
  rollbackInstallCommit as rollbackInstallCommitGeneric,
  writeJsonAtomic,
} from './install.ts';
import type {
  InstallCommitHandle as GenericInstallCommitHandle,
  InstallLockHandle,
  AcquireLockOpts,
  RecoveryOutcome,
} from './install.ts';

// Re-export the shared transaction surface under the names callers/tests have
// always imported from this module (the move to src/install.ts was
// logic-preserving). `finalizeInstallCommit` and `rollbackInstallCommit` are
// NOT re-exported: this module defines the GitHub-aware versions — they also
// handle the parked old-name dir, which the generic ones do not know about —
// and they shadow the generic versions.
export {
  archivePathViolation,
  lockfilePathViolation,
  stageFiles,
  rmRecursiveForce,
  RollbackFailedError,
  STAGING_DIRNAME,
  ADD_JOURNAL_FILENAME,
  releaseInstallLock,
  validateAddJournal,
  readAddJournal,
  writeAddJournal,
  removeAddJournal,
} from './install.ts';
export type { AddJournal, AddJournalPhase, RecoveryOutcome, InstallLockHandle, AcquireLockOpts } from './install.ts';

export interface RepoSpec {
  owner: string;
  repo: string;
  ref: string;
}

/** GitHub-legal (superset) charset for an owner/repo name — see `parseRepoSpec`. */
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

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
 * `lockfilePathViolation`); `sha` is a 40-char hex commit sha; `source` equals
 * the record's key in `Lockfile.installed`. These invariants are NOT trusted
 * from disk — `validateLockfile` enforces every one on read, fail-closed,
 * before any consumer acts on an entry.
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
 * records and re-enable the clobbering `installFolder` was hardened against)
 * and never normalized. This is the trust boundary for the lockfile:
 * downstream code (`dispatchAdd`, `parkOldNameDir`) may only act on entries
 * that have passed through here. Critically, EVERY entry is validated, not just
 * the one being installed — `dispatchAdd` re-serializes the whole lockfile on
 * success, so acting while carrying a poisoned sibling entry would re-persist
 * it. Unknown extra keys (on the lockfile or an entry) are tolerated for
 * forward compatibility; required shape is enforced, additions are not
 * forbidden. Returns the value narrowed to `Lockfile`. `path` appears only in
 * error messages.
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
 * fail-closed hard error — see `validateLockfile`. The lockfile is never
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

export interface WriteLockfileOpts {
  /**
   * Removal op used to clean up the temp sibling when the atomic rename fails.
   * Defaults to `rmSync`; injectable so a test can force the cleanup itself to
   * throw and prove the ORIGINAL rename error still surfaces.
   */
  rm?: (path: string, opts: { force: true }) => void;
}

/**
 * Write the lockfile atomically: serialize into a sibling temp file, then
 * rename over the destination — the shared atomic tmp+rename discipline from
 * `src/install.ts`. A crash or a concurrent reader never sees a half-written
 * `installed.json`, and two racing writers can only ever leave a fully-formed
 * file. On a failed rename the temp sibling is removed best-effort and the
 * ORIGINAL rename error is surfaced unchanged.
 */
export function writeLockfile(path: string, lf: Lockfile, opts: WriteLockfileOpts = {}): void {
  writeJsonAtomic(path, lf, opts);
}

// ---- staging commit (GitHub handle) -------------------------------------------

/**
 * A handle to a committed-but-not-yet-finalized GitHub install — the generic
 * transaction handle plus the old-name migration record `parkOldNameDir` sets.
 * The caller MUST eventually either `finalizeInstallCommit` (discard the
 * retained dirs) or `rollbackInstallCommit` (restore the previous state).
 */
export interface InstallCommitHandle extends GenericInstallCommitHandle {
  /** Set by `parkOldNameDir` when an old-naming dir was migrated off. */
  oldName?: { originalPath: string; parkedAt: string };
}

/**
 * Atomically swap a validated `stagingDir` into place at `defsDir/folder`,
 * retaining the displaced previous install on the returned handle (see
 * `src/install.ts:commitInstall` for the full two-phase semantics). This is a
 * typed pass-through: `folder` is a SINGLE on-disk segment, and the returned
 * handle carries the GitHub-only `oldName` migration field once
 * `parkOldNameDir` runs.
 */
export function commitInstall(defsDir: string, folder: string, stagingDir: string): InstallCommitHandle {
  return commitInstallGeneric(defsDir, folder, stagingDir);
}

/**
 * Migrate a source off its old `<owner>-<repo>` install directory by PARKING it
 * (rename → `<stagingDir>-undo-oldname`) instead of deleting it, so a later
 * rollback can put it back where the (still-unchanged) lockfile expects it.
 * Records the move on `handle.oldName`. If the old dir does not exist on disk
 * (the lockfile names a path that is already gone), records nothing — matching
 * the previous tolerance of absence.
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
 * Deliberate behavior change vs. a bare `existsSync` probe: a DANGLING symlink
 * at the old path is refused, which is fail-closed and correct.
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
 * Make the commit permanent: discard the retained previous install AND any
 * parked old-name dir (the GitHub-only half the generic finalizer does not
 * know about). Call ONLY after the follow-on lockfile write has durably
 * succeeded — this is the point of no return.
 */
export function finalizeInstallCommit(handle: InstallCommitHandle): void {
  finalizeInstallCommitGeneric(handle);
  if (handle.oldName) rmSync(handle.oldName.parkedAt, { recursive: true, force: true });
}

/**
 * Restore the previous directory state after a failed commit: the GitHub-only
 * counterpart of `finalizeInstallCommit`. Restores the swapped-out destination
 * exactly as the generic rollback does, THEN renames the parked old-name dir
 * back to its original name — the same order as before the transaction was
 * generalized. Call ONLY before the follow-on lockfile write has succeeded.
 */
export function rollbackInstallCommit(handle: InstallCommitHandle): void {
  rollbackInstallCommitGeneric(handle);
  if (handle.oldName) renameSync(handle.oldName.parkedAt, handle.oldName.originalPath);
}

// ---- per-project install lock --------------------------------------------------

/**
 * Acquire the per-project install lock at `lockPath`. A 1-line adapter over the
 * generic `acquireFileLock`, pinning `label` so the timeout message reads
 * "another owenloop add is in progress …" byte-for-byte as before. Always pair
 * with `releaseInstallLock` in a `finally`.
 */
export function acquireInstallLock(
  lockPath: string,
  opts: AcquireLockOpts = {},
): Promise<InstallLockHandle> {
  return acquireInstallLockGeneric(lockPath, opts);
}

// ---- v1 crash-recovery adapter -------------------------------------------------
//
// The generic two-version recovery lives in `src/install.ts`; the GitHub route
// wraps it with its v1 specifics: the `installed.json` ledger read (fail-closed
// validation), the source+sha+path commit-point match, and the old-name
// migration corroboration for case (c). New CAS installs write v2 journals and
// use the metadata-hash commit-point test instead — neither route trusts the
// other's schema.

export interface RecoverInterruptedInstallArgs {
  /** The CURRENT run's resolved defs dir — every mutation path derives from it. */
  defsDir: string;
  /** Path to `.owenloop/add.journal`. */
  journalPath: string;
  /** Path to `.owenloop/installed.json` — read to decide the commit-point boundary. */
  lockfilePath: string;
  /** External marker directory for fresh v2 recovery corroboration. */
  recoveryMarkerDir?: string;
}

/**
 * Bring an interrupted GitHub-route install back to a consistent (defs ⇔
 * lockfile) state, then remove the journal. Called by `dispatchAdd` under the
 * per-project install lock, BEFORE the stale-staging cleanup. Also recovers a
 * v2 (workflow-store) journal found at the same location — the generic
 * recovery dispatches on journal version. See `src/install.ts`
 * `recoverInterruptedInstall` for the full roll-forward/roll-back decision
 * table and crash-safety argument. Refusals throw without mutating anything
 * and leave the journal in place.
 */
export function recoverInterruptedInstall(args: RecoverInterruptedInstallArgs): RecoveryOutcome {
  return recoverInterruptedInstallGeneric({
    defsDir: args.defsDir,
    journalPath: args.journalPath,
    lockfilePath: args.lockfilePath,
    recoveryMarkerDir: args.recoveryMarkerDir,
    readLedger: () => {
      // readLockfile validates fail-closed; a corrupt lockfile aborts the add
      // exactly as it does on the normal path.
      const lf = readLockfile(args.lockfilePath);
      return (source: string) => {
        const entry = lf.installed[source];
        if (entry === undefined) return undefined;
        return { sha: entry.sha, path: entry.path };
      };
    },
  });
}
