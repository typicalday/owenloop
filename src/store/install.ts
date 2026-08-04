/**
 * Workflow-bundle installation into the content-addressed store — its trust
 * boundary. This module OWNS the install orchestration (staging → engine
 * validation → pre-commit verification → hardening → atomic swap → atomic
 * index commit → finalize), but deliberately does NOT own bundle
 * parsing/digest (the `BundleIngestor` port) or pre-commit verification (the
 * `PreCommitVerifier` port). Neither port has a permissive fallback: with
 * either adapter missing, installation fails closed BEFORE any
 * object/index/journal commit — there is no default accepting parser, digest
 * algorithm, or no-op verifier.
 *
 * The transaction rides the host-neutral machinery in `src/install.ts`
 * (staging, swap+retained backup, journal, lock, recovery). CAS specifics:
 * metadata = `index.json` at the store root; destination = the validated
 * three-segment object path `objects/sha256/<digest>`; journal = v2 (identity
 * is a metadata-hash match, no route-specific fields); lock/staging/journal
 * live PER ROOT (project installs share the project add lock path; global
 * installs keep equivalent state below the global root).
 *
 * Engine core: this module imports Node builtins, defs/model validation
 * helpers, and the generic transaction — never `cli.ts`, `add.ts`, `untar.ts`,
 * or a hub module.
 */

import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randId } from '../util.ts';
import { DefError, lintDef, loadDefs, loadDefsRaw, validateDef } from '../defs.ts';
import type { DefLoadFailure } from '../defs.ts';
import { hasDefiniteCheckDefect, modelCheck } from '../model.ts';
import {
  acquireInstallLock,
  canonicalJsonBytes,
  commitInstall,
  createRecoveryMarker,
  ensureDirectoryPathNoSymlink,
  finalizeInstallCommit,
  guardStateFile,
  multiSegmentPathViolation,
  probeDirectoryPath,
  recoverInterruptedInstall,
  releaseInstallLock,
  removeAddJournal,
  removeRecoveryMarker,
  rmRecursiveForce,
  RollbackFailedError,
  rollbackInstallCommit,
  sha256Hex,
  writeAddJournal,
} from '../install.ts';
import type { InstallCommitHandle, LedgerLookup, RecoveryOutcome } from '../install.ts';
import {
  BundleIngestorUnavailableError,
  PreCommitVerifierUnavailableError,
  StoreConflictError,
  StoreIntegrityError,
  StorePathError,
} from './types.ts';
import type {
  DefDigest,
  StoreLevel,
  WorkflowCoordinate,
  WorkflowStoreIndex,
} from './types.ts';
import { readWorkflowStoreIndex, writeWorkflowStoreIndex } from './index-file.ts';
import { storeIndexPath } from './resolve.ts';

// ---- A1/A2 ports ---------------------------------------------------------------

/**
 * Where a bundle came from — origin DATA only (diagnostics, error messages,
 * and the A1/A2 adapter call sites). NEVER identity: identity is the A1
 * manifest's coordinate + canonical digest, and a source string is never
 * joined into a filesystem path or hashed as identity.
 */
export type BundleSource =
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string };

/**
 * The bundle-ingestion port: bundle unpacking, canonical digest computation,
 * manifest integrity, safe extraction, and the full `namespace/name@version`
 * coordinate. The concrete implementation lands with the bundle-format
 * module; until then callers MUST inject an implementation — this module
 * fails closed ({@link BundleIngestorUnavailableError}) without one.
 *
 * `ingest` unpacks `bytes` into the supplied `stagingDir` and returns ONLY
 * after bundle manifest, per-file integrity, canonical digest, and coordinate
 * checks pass. `verifyInstalledObject` re-checks an already-installed object
 * directory against its expected digest — called on every dedupe and on every
 * successful resolution before executable content is returned.
 */
export interface BundleIngestor {
  ingest(input: {
    source: BundleSource;
    bytes: Uint8Array;
    stagingDir: string;
  }): Promise<{ coordinate: WorkflowCoordinate; digest: DefDigest }>;
  verifyInstalledObject(input: { objectDir: string; digest: DefDigest }): Promise<void>;
}

/**
 * The pre-commit verification port, called after content/engine validation
 * and BEFORE any destination swap or index write. A rejection removes
 * staging and leaves objects/index/journal unchanged. The concrete
 * implementation is a separate module; without one this module fails closed
 * ({@link PreCommitVerifierUnavailableError}) — there is NO default
 * accepting verifier.
 */
export interface PreCommitVerifier {
  verify(input: {
    source: BundleSource;
    coordinate: WorkflowCoordinate;
    digest: DefDigest;
    objectDir: string;
  }): Promise<void>;
}

// ---- result / args --------------------------------------------------------------

/** What a successful bundle install reports. No signature contents or keys — ever. */
export interface BundleInstallResult {
  source: BundleSource;
  level: StoreLevel;
  coordinate: WorkflowCoordinate;
  digest: DefDigest;
  objectPath: string;
  /** True when the object was newly installed; false when deduplicated against an existing verified object. */
  installed: boolean;
}

export interface InstallWorkflowBundleArgs {
  /** The raw bundle bytes (already fetched/read by the caller). */
  bytes: Uint8Array;
  /** Origin data for diagnostics and the adapter call sites — never identity. */
  source: BundleSource;
  /** The store root to install into (project: the resolved defs dir; global: `~/.owenloop/workflows`). */
  root: string;
  /** Which level `root` is (result metadata only). */
  level: StoreLevel;
  /** Path of the per-root install lock (project installs share the project add lock). */
  lockPath: string;
  /** Path of the per-root crash-recovery journal. */
  journalPath: string;
  /** External marker directory for corroborating a fresh swap with no backup. */
  recoveryMarkerDir?: string;
  /** Bundle-ingest adapter — REQUIRED (fail-closed without it). */
  ingestor: BundleIngestor;
  /** Pre-commit verifier — REQUIRED (fail-closed without it). */
  verifier: PreCommitVerifier;
  /**
   * Project-level installs ONLY: the installed.json ledger lookup so the
   * inline recovery can roll back/forward a legacy v1 (GitHub-route) journal
   * left at the shared project journal path — project bundle installs share
   * the existing project add lock/recovery ordering. A v2 journal never needs
   * this; without it a leftover v1 journal is refused (fail-closed), exactly
   * as the generic recovery documents. Global installs pass nothing (v1 is
   * never legal under the global root — there is no ledger there to vouch).
   */
  readLedger?: () => LedgerLookup;
}

/**
 * The CAS destination relative path for a validated digest: the single
 * relative path `objects/sha256/<digest>`, re-validated as a safe
 * multi-segment path before any join/rename (reject-don't-normalize, same as
 * every other destination path in the transaction).
 */
export function objectDestRelPath(digest: DefDigest): string {
  const rel = `objects/sha256/${digest}`;
  const violation = multiSegmentPathViolation(rel);
  if (violation) {
    // Unreachable for a validated digest — kept so the mutation site never
    // trusts its inputs even if a caller bypassed the brand.
    throw new StorePathError(`refusing unsafe object destination '${rel}': ${violation}`);
  }
  return rel;
}

// ---- permission hardening --------------------------------------------------------

/**
 * Set regular files read-only (0o444) and directories non-writable (0o555)
 * under `dir`, recursively, INCLUDING `dir` itself. Defense in depth only —
 * permissions are NOT the integrity proof (verification is). Any chmod
 * failure propagates: an object that cannot be hardened is not committed
 * (the caller rolls staging back), so a partially-hardened object never
 * lands in the store. A symlink anywhere in the object is refused outright —
 * an extracted object must never contain links.
 */
export function hardenObjectModes(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) {
    throw new StorePathError(`refusing to harden '${dir}': it is a symlink`);
  }
  if (!st.isDirectory()) {
    throw new StorePathError(`refusing to harden '${dir}': it is not a directory`);
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const entrySt = lstatSync(full);
    if (entrySt.isSymbolicLink()) {
      throw new StorePathError(`refusing to harden '${full}': object contains a symlink`);
    }
    if (entrySt.isDirectory()) {
      hardenObjectModes(full);
    } else if (entrySt.isFile()) {
      chmodSync(full, 0o444);
    } else {
      throw new StorePathError(`refusing to harden '${full}': unexpected file type`);
    }
  }
  chmodSync(dir, 0o555);
}

// ---- the install transaction -----------------------------------------------------

/**
 * Install one `.wnlp` bundle into a store root as one recoverable operation.
 *
 * Fixed commit order:
 *   1. acquire the root's install lock;
 *   2. recover a prior interrupted install (before stale-stage cleanup — the
 *      backups a rollback needs live under the staging root);
 *   3. clear stale staging debris;
 *   4. reread + validate the index INSIDE the lock (ownership/conflict
 *      decisions must see the post-lock state — TOCTOU);
 *   5. stage via the A1 ingestor (unpack + manifest + digest + coordinate);
 *   6. validate the staged tree with the engine's strict pass (loadDefsRaw +
 *      lint + validate + bounded modelCheck(assumeProvided) + strict loadDefs);
 *   7. run the A2 pre-commit verifier (after content validation, before ANY
 *      destination swap or index write);
 *   8. write the `applying` journal (v2, with the post-install metadata hash);
 *   9. atomically install/deduplicate the object — a fresh install swaps the
 *      staging dir into place (retaining any displaced content on the handle),
 *      THEN hardens file/dir modes AT the committed location (hardening is
 *      defense in depth; verification is the integrity proof); a dedupe
 *      verifies the existing object and commits no rewrite;
 *  10. atomically write the index — the DURABLE COMMIT POINT;
 *  11. write the `finalizing` journal;
 *  12. discard the retained backup + staging;
 *  13. remove the journal; release the lock.
 *
 * Fetching/reading the source bytes may happen before the lock (the caller's
 * job); index ownership/conflict decisions happen inside it.
 *
 * Failure semantics: any rejection before the swap (A1 tamper refusal, A2
 * refusal, engine validation, digest mismatch) leaves objects/index/journal
 * untouched and staging is cleared by the `finally`. A swap failure, a
 * post-swap hardening failure, or an index-write failure rolls the directory
 * state back in-process so the previous object + index are left exactly as
 * they were. A crash anywhere leaves the journal behind for the next recovery.
 *
 * Conflict semantics: an existing coordinate at a DIFFERENT digest is a
 * {@link StoreConflictError} (no implicit retarget); an existing coordinate
 * at the SAME digest deduplicates (verify the existing object, then commit an
 * index-only change — no object rewrite). A corrupt existing object is a hard
 * {@link StoreIntegrityError} — never replaced, never fallen through.
 */
export async function installWorkflowBundle(args: InstallWorkflowBundleArgs): Promise<BundleInstallResult> {
  const { bytes, source, root, level, lockPath, journalPath, recoveryMarkerDir, ingestor, verifier, readLedger } = args;
  if (ingestor === undefined || ingestor === null) throw new BundleIngestorUnavailableError();
  if (verifier === undefined || verifier === null) throw new PreCommitVerifierUnavailableError();

  const indexPath = storeIndexPath(root);
  const stagingRoot = join(root, '.owenloop-staging');
  const stagingId = randId('stg');
  const stagingDir = join(stagingRoot, stagingId);

  ensureDirectoryPathNoSymlink(root, 'workflow store root');
  ensureDirectoryPathNoSymlink(dirname(lockPath), 'install state directory');
  ensureDirectoryPathNoSymlink(dirname(journalPath), 'install state directory');
  guardStateFile(lockPath, 'install lock');
  guardStateFile(journalPath, 'crash-recovery journal');
  const lock = await acquireInstallLock(lockPath);
  // Set true only when the ONLY copy of some content sits under the staging
  // root (a rollback double-fault) — then the `finally` must NOT clear it.
  let preserveStagingRoot = false;
  try {
    // Recover a prior interrupted install FIRST — before the stale-staging
    // clear, since the backups a rollback needs live under the staging root.
    // A v1 (GitHub) journal at a shared project journal path needs the
    // project ledger to vouch (supplied via `readLedger` — project bundle
    // installs share the project add lock/recovery ordering); without a
    // ledger a leftover v1 journal is refused. Any refusal preserves the
    // staging root + journal as evidence.
    try {
      recoverInterruptedInstall({
	defsDir: root,
	journalPath,
	lockfilePath: indexPath,
	readLedger,
	recoveryMarkerDir,
      });
    } catch (e) {
      preserveStagingRoot = true;
      throw e;
    }

    // The lock holder is the only legitimate writer under the staging root —
    // anything already there is debris from a crashed/killed prior run.
    rmRecursiveForce(stagingRoot);

    // Reread + validate the index INSIDE the lock (fail-closed; a corrupt
    // index is a hard error, never a silent reset).
    const index = readWorkflowStoreIndex(indexPath);

    // Stage via A1: unpack, manifest integrity, canonical digest, coordinate.
    // A refusal here (tamper, bad manifest, oversized archive) leaves staging
    // debris only — no object, no index, no journal touched.
    const { coordinate, digest } = await ingestor.ingest({ source, bytes, stagingDir });

    // Ownership/conflict decisions, inside the lock:
    const existing = index.entries[coordinate];
    const destRelPath = objectDestRelPath(digest);
    const objectDir = join(root, destRelPath);
    if (existing !== undefined && existing.digest !== digest) {
      throw new StoreConflictError(coordinate, existing.digest);
    }
    let objectAlreadyPresent: boolean;
    try {
      objectAlreadyPresent = probeDirectoryPath(objectDir, 'workflow object', root) === 'dir';
    } catch (e) {
      throw new StoreIntegrityError('object-corrupt', digest, (e as Error).message);
    }

    // Validate the staged tree with the engine's strict pass — the exact
    // bytes that will be committed, with no re-write after validation.
    const reasons: string[] = [];
    const failures: DefLoadFailure[] = [];
    const staged = loadDefsRaw(stagingDir, failures);
    reasons.push(...failures.map((f) => `${f.file}: ${f.error}`));
    for (const stagedDef of staged.values()) {
      const lintResult = lintDef(stagedDef);
      reasons.push(...lintResult.errors.map((err) => `${stagedDef.name}: ${err}`));
      reasons.push(...validateDef(stagedDef).map((err) => `${stagedDef.name}: ${err}`));
      const report = modelCheck(stagedDef, { assumeProvided: true });
      if (hasDefiniteCheckDefect(report)) {
        reasons.push(
          `${stagedDef.name}: definite defects found (${report.invariantViolations.length} invariant violation(s), ` +
            `${report.structurallyDeadSteps.length} structurally dead step(s), ` +
            `${report.deadlocks.length} true deadlock(s))`,
        );
      }
    }
    if (reasons.length === 0) {
      try {
        loadDefs(stagingDir);
      } catch (e) {
        if (e instanceof DefError) {
          reasons.push(`cross-definition validation failed: ${e.message}`);
        } else {
          throw e;
        }
      }
    }
    if (reasons.length > 0) {
      throw new Error(
        `refusing to install bundle '${coordinate}' — ${reasons.length} problem(s) found; nothing written:\n  - ${reasons.join('\n  - ')}`,
      );
    }

    // A2 pre-commit verification: after content/engine validation, before ANY
    // destination swap or index write. A rejection commits nothing.
    await verifier.verify({ source, coordinate, digest, objectDir: stagingDir });

    // The post-install index, computed BEFORE the commit point so its exact
    // canonical bytes are what the journal's metadataHash commits to.
    const nextIndex: WorkflowStoreIndex = {
      version: 1,
      entries: { ...index.entries, [coordinate]: { digest, pinned: existing?.pinned ?? false } },
    };
    const metadataHash = sha256Hex(canonicalJsonBytes(nextIndex));

    // A fresh swap needs an external corroboration marker because the staging
    // and backup directories can both be absent after a crash. Dedupe has no
    // destructive object swap and therefore needs no marker.
    const recoveryMarker = objectAlreadyPresent
      ? undefined
      : createRecoveryMarker({
	  root,
	  destSegments: ['objects', 'sha256', digest],
	  stagingId,
	  markerDir: recoveryMarkerDir,
	});

    // Journal (v2, phase `applying`) BEFORE the first destructive step.
    const journalBase = {
      version: 2 as const,
      phase: 'applying' as const,
      destSegments: ['objects', 'sha256', digest],
      stagingId,
      hadDest: objectAlreadyPresent,
      root,
      metadataHash,
      label: coordinate,
      recoveryMarkerId: recoveryMarker?.id,
    };
    try {
      writeAddJournal(journalPath, journalBase);
    } catch (e) {
      if (recoveryMarker !== undefined) removeRecoveryMarker(recoveryMarker);
      throw e;
    }

    let handle: InstallCommitHandle | undefined;
    if (objectAlreadyPresent) {
      // Dedupe: the object exists — verify it through A1 BEFORE trusting it,
      // then commit an index-only change (no object rewrite). A corrupt
      // existing object is a hard refusal (never replaced, never fallen
      // through). Nothing destructive has happened yet, so a refusal only
      // drops the journal.
      try {
        await ingestor.verifyInstalledObject({ objectDir, digest });
      } catch (e) {
        removeAddJournal(journalPath);
	if (recoveryMarker !== undefined) removeRecoveryMarker(recoveryMarker);
        throw new StoreIntegrityError(
          'object-corrupt',
          digest,
          `existing object failed verification before dedupe: ${(e as Error).message}`,
        );
      }
    } else {
      // Fresh install: atomically swap the staged object into place FIRST and
      // harden it AT its committed location. The order is forced by POSIX:
      // rename(2) updates the renamed directory's `..` entry and therefore
      // needs the directory's OWN write bit — a pre-hardened 0o555 staging
      // dir can never be swapped. A hardening failure rolls the swap back
      // in-process (the index commit has not happened), so a partially
      // hardened object can never be committed either.
      try {
        handle = commitInstall(root, destRelPath, stagingDir);
      } catch (e) {
        if (e instanceof RollbackFailedError) preserveStagingRoot = true;
        throw e;
      }
      try {
        hardenObjectModes(handle.dest);
      } catch (e) {
        rollbackInstallCommit(handle);
        removeAddJournal(journalPath);
	if (recoveryMarker !== undefined) removeRecoveryMarker(recoveryMarker);
        throw new Error(
          `refusing to install bundle '${coordinate}': object hardening failed ` +
            `(${(e as Error).message}) — install rolled back, previous state restored`,
        );
      }
    }

    // Atomic index write — the DURABLE COMMIT POINT. Past here a crash rolls
    // forward. On failure, roll the directory state back (a fresh install
    // only — a dedupe has no swap to undo), drop the journal, and leave the
    // previous object + index exactly as they were.
    try {
      writeWorkflowStoreIndex(indexPath, nextIndex);
    } catch (e) {
      if (handle !== undefined) {
        try {
          rollbackInstallCommit(handle);
        } catch (rollbackErr) {
          // Double fault: preserve the parked content and LEAVE the journal
          // (phase `applying`, index not committed) so the next recovery
          // restores the previous state before anything clears staging.
          preserveStagingRoot = true;
          throw new StoreIntegrityError(
            'object-corrupt',
            digest,
            `index write failed (${(e as Error).message}) and rolling the object back failed too ` +
              `(${(rollbackErr as Error).message}) — the journal remains for the next recovery`,
          );
        }
      }
      removeAddJournal(journalPath);
      if (recoveryMarker !== undefined) removeRecoveryMarker(recoveryMarker);
      throw new Error(
        `could not record install of '${coordinate}' in ${indexPath}: ${(e as Error).message} — ` +
          `install rolled back, previous state restored`,
      );
    }

    // The index write is the durable commit point: past here a crash rolls
    // FORWARD. Record that in the journal, then finalize (discard any
    // retained backup), clear staging, and drop the journal.
    writeAddJournal(journalPath, { ...journalBase, phase: 'finalizing' });
    if (handle !== undefined) finalizeInstallCommit(handle);
    rmRecursiveForce(stagingRoot);
    removeAddJournal(journalPath);
    if (recoveryMarker !== undefined) removeRecoveryMarker(recoveryMarker);

    return {
      source,
      level,
      coordinate,
      digest,
      objectPath: objectDir,
      installed: !objectAlreadyPresent,
    };
  } finally {
    if (!preserveStagingRoot) rmRecursiveForce(stagingRoot);
    releaseInstallLock(lock);
  }
}

// ---- offline recovery -------------------------------------------------------------

export interface RecoverWorkflowStoreArgs {
  /** The store root to recover (global: `~/.owenloop/workflows`; project: the defs dir). */
  root: string;
  /** Path of the root's install lock. */
  lockPath: string;
  /** Path of the root's crash-recovery journal. */
  journalPath: string;
  /** External marker directory for fresh-install recovery corroboration. */
  recoveryMarkerDir?: string;
}

/**
 * Offline crash recovery for a workflow-store root — the `add --recover`
 * counterpart for bundle installs. Acquires the root lock, runs the generic
 * two-version recovery (v2 metadata-hash commit point), releases. No network,
 * no store open. A v2 journal recovers forward or back exactly as the inline
 * path would; a v1 journal is refused (the GitHub route owns v1 recovery).
 * Refusals throw and leave the journal, staging, and objects untouched.
 */
export async function recoverWorkflowStore(args: RecoverWorkflowStoreArgs): Promise<RecoveryOutcome> {
  ensureDirectoryPathNoSymlink(args.root, 'workflow store root');
  ensureDirectoryPathNoSymlink(dirname(args.lockPath), 'install state directory');
  ensureDirectoryPathNoSymlink(dirname(args.journalPath), 'install state directory');
  guardStateFile(args.lockPath, 'install lock');
  guardStateFile(args.journalPath, 'crash-recovery journal');
  const lock = await acquireInstallLock(args.lockPath);
  try {
    return recoverInterruptedInstall({
      defsDir: args.root,
      journalPath: args.journalPath,
      lockfilePath: storeIndexPath(args.root),
      recoveryMarkerDir: args.recoveryMarkerDir,
    });
  } finally {
    releaseInstallLock(lock);
  }
}
