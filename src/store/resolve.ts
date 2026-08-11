/**
 * Two-level store roots and fail-closed resolution.
 *
 * Two SEPARATE resolution APIs, so execution code cannot accidentally call
 * human-name resolution:
 *
 *   - {@link resolveWorkflowDigest} — execution path: digest only, no index,
 *     no workflow name. Project first, fall-through to global when the
 *     project object is ABSENT; a corrupt/invalid project hit is a hard error
 *     (never masked by falling back to a valid global copy).
 *
 *   - {@link resolveWorkflowCoordinate} — human/CLI path: reads BOTH indexes.
 *     One entry resolves; same digest at both levels deduplicates to one
 *     result; different digests at the two levels throw a structured
 *     ambiguity error (never silently project-first).
 *
 * Every successful resolution verifies the object it returns through the
 * ingest adapter's `verifyInstalledObject` before handing back a path — the
 * permissions/object shape on disk are defense in depth, not an integrity
 * proof. There is no bare-name resolution anywhere in this module.
 */

import { lstatSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  StoreAmbiguityError,
  StoreIndexError,
  StoreIntegrityError,
  StoreNotFoundError,
  StorePathError,
  objectDirForDigest,
  WORKFLOW_STORE_INDEX_FILENAME,
} from './types.ts';
import type { DefDigest, ResolutionLevel, WorkflowCoordinate } from './types.ts';
import { readWorkflowStoreIndex } from './index-file.ts';
import { probeDirectoryPath, readAddJournal } from '../install.ts';
import type { BundleIngestor } from './install.ts';

/**
 * The PROJECT store root: the resolved defs directory itself — project pins
 * stay reviewable in git, and the nested `objects/sha256/<digest>/` path
 * stays below the def loader's scan depth.
 */
export function projectStoreRoot(defsDir: string): string {
  return resolvePath(defsDir);
}

/**
 * The GLOBAL store root: `<home>/.owenloop/workflows`. `home` is required so
 * library callers and tests must pin a fixture HOME from the first write and
 * never fall back to the ambient process home.
 */
export function globalStoreRoot(home: string): string {
  if (home.trim() === '') throw new StorePathError('cannot derive global workflow store root from an empty home');
  return join(home, '.owenloop', 'workflows');
}

/** The index file path at a store root. */
export function storeIndexPath(root: string): string {
  return join(root, WORKFLOW_STORE_INDEX_FILENAME);
}

/** Canonical state paths for one workflow store root. */
export interface WorkflowStoreStatePaths {
  stateDir: string;
  lockPath: string;
  journalPath: string;
}

export function workflowStoreStatePaths(root: string): WorkflowStoreStatePaths {
  const stateDir = join(root, '.owenloop');
  return {
    stateDir,
    lockPath: join(stateDir, 'add.lock'),
    journalPath: join(stateDir, 'add.journal'),
  };
}

export interface DigestRepairWaitOptions {
  /** Total bounded wait. A stale/crashed transaction fails closed after this. */
  timeoutMs?: number;
  /** Poll interval while the journal is in a replacement phase. */
  retryMs?: number;
}

const DEFAULT_REPAIR_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_REPAIR_RETRY_MS = 10;
const syncSleepWord = new Int32Array(new SharedArrayBuffer(4));

function isMissingDuringJournalRead(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * True only while the matching digest is inside the non-stable part of a v2
 * same-digest replacement. `finalizing` is stable after replacement commit;
 * `rollback-prior-restored` and `rollback-complete` are stable after the exact
 * prior directory is back. Cleanup after any stable phase never renames the
 * digest path again. An old v2 `applying` journal without
 * `operation` waits conservatively whenever `hadDest` is true: before the first
 * rename, a repair and a dedupe are indistinguishable, and probing for the backup
 * would leave a race between that probe and destination → backup.
 */
function digestRepairNeedsWait(root: string, digest: DefDigest): boolean {
  let journal: ReturnType<typeof readAddJournal>;
  try {
    journal = readAddJournal(workflowStoreStatePaths(root).journalPath);
  } catch (error) {
    // Atomic journal removal can race the lstat/read pair. Absence means the
    // transaction reached a stable state; malformed or hostile journals remain
    // fail-closed integrity errors.
    if (isMissingDuringJournalRead(error)) return false;
    throw new StoreIntegrityError(
      'object-corrupt',
      digest,
      `could not inspect active replacement transaction: ${(error as Error).message}`,
    );
  }
  if (journal === null || journal.version !== 2) return false;
  if (
    journal.destSegments.length !== 3 ||
    journal.destSegments[0] !== 'objects' ||
    journal.destSegments[1] !== 'sha256' ||
    journal.destSegments[2] !== digest
  ) {
    return false;
  }
  if (journal.phase === 'finalizing') return false;
  if (journal.phase === 'rollback-prior-restored' || journal.phase === 'rollback-complete') {
    const stagingDir = join(root, '.owenloop-staging', journal.stagingId);
    const destination = join(root, ...journal.destSegments);
    try {
      const destinationStable = probeDirectoryPath(destination, 'workflow object', root) === 'dir';
      const stagingAbsent = probeDirectoryPath(stagingDir, 'repair staging directory', root) === 'absent';
      const backupAbsent = probeDirectoryPath(`${stagingDir}-old`, 'repair backup directory', root) === 'absent';
      const undoAbsent = probeDirectoryPath(`${stagingDir}-undo`, 'repair undo directory', root) === 'absent';
      if (journal.phase === 'rollback-prior-restored') {
	return !(destinationStable && stagingAbsent && backupAbsent);
      }
      return !(destinationStable && stagingAbsent && backupAbsent && undoAbsent);
    } catch (error) {
      throw new StoreIntegrityError(
	'object-corrupt',
	digest,
	`could not validate stable repair rollback state: ${(error as Error).message}`,
      );
    }
  }
  if (journal.operation === 'repair') return true;
  if (journal.operation === 'install' || journal.operation === 'dedupe') return false;
  if (journal.phase !== 'applying') return true;

  // Backward compatibility for journals written before `operation` existed.
  // Waiting on every had-destination transaction is conservative for old dedupe
  // journals, but it closes the destination-probe → backup-rename race for old
  // repair journals. The timeout handles a stale journal fail-closed.
  return journal.hadDest;
}

function repairWaitError(digest: DefDigest, timeoutMs: number): StoreIntegrityError {
  return new StoreIntegrityError(
    'object-corrupt',
    digest,
    `matching replacement transaction did not reach a stable state within ${timeoutMs}ms; ` +
      `the transaction may have crashed and must be recovered before this object can be read`,
  );
}

async function waitForDigestRepairUntil(
  root: string,
  digest: DefDigest,
  deadline: number,
  timeoutMs: number,
  retryMs: number,
): Promise<void> {
  while (digestRepairNeedsWait(root, digest)) {
    if (Date.now() >= deadline) throw repairWaitError(digest, timeoutMs);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, retryMs));
  }
}

function waitForDigestRepairUntilSync(
  root: string,
  digest: DefDigest,
  deadline: number,
  timeoutMs: number,
  retryMs: number,
): void {
  while (digestRepairNeedsWait(root, digest)) {
    if (Date.now() >= deadline) throw repairWaitError(digest, timeoutMs);
    Atomics.wait(syncSleepWord, 0, 0, retryMs);
  }
}

/** Bounded asynchronous coordination for digest-backed async readers. */
export async function waitForDigestRepair(
  root: string,
  digest: DefDigest,
  options: DigestRepairWaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPAIR_WAIT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_REPAIR_RETRY_MS;
  await waitForDigestRepairUntil(root, digest, Date.now() + timeoutMs, timeoutMs, retryMs);
}

/** Bounded synchronous coordination for `openCtx`/definition discovery readers. */
export function waitForDigestRepairSync(
  root: string,
  digest: DefDigest,
  options: DigestRepairWaitOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPAIR_WAIT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_REPAIR_RETRY_MS;
  waitForDigestRepairUntilSync(root, digest, Date.now() + timeoutMs, timeoutMs, retryMs);
}

/**
 * Run one asynchronous digest-backed read outside every active replacement
 * phase. A replacement can start after the initial journal check, so a failed
 * read checks the journal again and retries after the transaction stabilizes.
 * One immediate retry is also allowed when the transaction completed quickly
 * enough for both journal checks to observe absence; a genuinely missing or
 * corrupt object therefore keeps its normal error after two immediate reads,
 * rather than waiting for the full timeout.
 */
export async function coordinateDigestRead<T>(
  root: string,
  digest: DefDigest,
  read: () => Promise<T> | T,
  options: DigestRepairWaitOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPAIR_WAIT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_REPAIR_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  let retriedWithoutObservedJournal = false;

  for (;;) {
    await waitForDigestRepairUntil(root, digest, deadline, timeoutMs, retryMs);
    try {
      return await read();
    } catch (error) {
      if (digestRepairNeedsWait(root, digest)) continue;
      if (retriedWithoutObservedJournal) throw error;
      retriedWithoutObservedJournal = true;
    }
  }
}

/** Synchronous counterpart of {@link coordinateDigestRead}. */
export function coordinateDigestReadSync<T>(
  root: string,
  digest: DefDigest,
  read: () => T,
  options: DigestRepairWaitOptions = {},
): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPAIR_WAIT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_REPAIR_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  let retriedWithoutObservedJournal = false;

  for (;;) {
    waitForDigestRepairUntilSync(root, digest, deadline, timeoutMs, retryMs);
    try {
      return read();
    } catch (error) {
      if (digestRepairNeedsWait(root, digest)) continue;
      if (retriedWithoutObservedJournal) throw error;
      retriedWithoutObservedJournal = true;
    }
  }
}

/**
 * Probe a store root: `'absent'` (nothing installed here — NOT an error), or
 * a real directory. A symlink or non-directory squatting at the root is a
 * hard {@link StorePathError}: resolution must never read through a link that
 * redirects it outside the intended tree (SEC-3). `lstat`, never `stat`.
 */
export function probeStoreRoot(root: string): 'dir' | 'absent' {
  const st = lstatSync(root, { throwIfNoEntry: false });
  if (st === undefined) return 'absent';
  if (st.isSymbolicLink()) {
    throw new StorePathError(`refusing workflow store root '${root}': it is a symlink`);
  }
  if (!st.isDirectory()) {
    throw new StorePathError(`refusing workflow store root '${root}': it is not a directory`);
  }
  return 'dir';
}

/**
 * Probe an object directory (`objects/sha256/<digest>`): `'dir'` or
 * `'absent'`. Anything else — a symlink, a regular file, any non-directory —
 * is a hard {@link StoreIntegrityError} naming the digest and level: a
 * wrong-typed or linked object must never be returned, and (at project level)
 * must never be papered over by a global fall-through.
 */
export function probeObjectDir(objectDir: string, digest: DefDigest, level: ResolutionLevel): 'dir' | 'absent' {
  try {
    const root = dirname(dirname(dirname(objectDir)));
    return probeDirectoryPath(objectDir, `${level}-level workflow object`, root);
  } catch (e) {
    const leaf = lstatSync(objectDir, { throwIfNoEntry: false });
    const detail = leaf?.isSymbolicLink()
      ? `${level}-level object dir is a symlink — refusing (no fallback)`
      : leaf !== undefined && !leaf.isDirectory()
	? `${level}-level object dir is not a directory — refusing (no fallback)`
	: `${(e as Error).message} — refusing (no fallback)`;
    throw new StoreIntegrityError('object-corrupt', digest, detail);
  }
}

class ObjectAbsentDuringCoordinatedRead extends Error {}

async function probeObjectDirCoordinated(
  root: string,
  objectDir: string,
  digest: DefDigest,
  level: ResolutionLevel,
): Promise<boolean> {
  try {
    return await coordinateDigestRead(root, digest, () => {
      if (probeObjectDir(objectDir, digest, level) !== 'dir') {
	throw new ObjectAbsentDuringCoordinatedRead();
      }
      return true;
    });
  } catch (error) {
    if (error instanceof ObjectAbsentDuringCoordinatedRead) return false;
    throw error;
  }
}

/** One resolution result: where the object lives and which levels hold it. */
export interface ResolvedWorkflowObject {
  digest: DefDigest;
  /** The object directory to read executable content from (verified). */
  objectPath: string;
  /** The level whose objectPath is returned (project wins a same-digest pair). */
  level: ResolutionLevel;
  /** Presence metadata: which levels hold this digest's object directory. */
  presentAt: { project: boolean; global: boolean };
}

/** Verify `objectDir` through the A1 adapter, wrapping failures as integrity errors. */
async function verifyObjectAt(
  verifier: BundleIngestor,
  root: string,
  objectDir: string,
  digest: DefDigest,
  level: ResolutionLevel,
): Promise<void> {
  try {
    await coordinateDigestRead(root, digest, async () => {
      const verify = verifier.verifyInstalledObjectAfterCoordination ?? verifier.verifyInstalledObject;
      await verify.call(verifier, { objectDir, digest });
    });
  } catch (e) {
    throw new StoreIntegrityError(
      'object-corrupt',
      digest,
      `${level}-level object failed verification: ${(e as Error).message}`,
    );
  }
}

export interface ResolveWorkflowDigestArgs {
  /** The digest to resolve (execution identity — no index, no name). */
  digest: DefDigest;
  /** The project store root; ABSENT (undefined) means global-only resolution. */
  projectRoot?: string;
  /** The global store root (always consulted). */
  globalRoot: string;
  /** The ingest adapter that verifies installed object bytes. */
  verifier: BundleIngestor;
}

/**
 * Digest-only resolution for EXECUTION. Tests the project object path first
 * when a project root exists, then the global path. An ABSENT project object
 * may fall through to global; a PRESENT project object that fails type
 * probing or verification is a hard integrity error — project tampering is
 * never hidden by falling back to a valid global copy. When both levels hold
 * the same digest, ONE logical result is returned (level `project`, with
 * presence metadata), not two candidates. No index and no workflow name
 * participate. Throws {@link StoreIntegrityError} (`object-missing`) when the
 * digest is present nowhere, or (`object-corrupt`) on any invalid hit.
 */
export async function resolveWorkflowDigest(args: ResolveWorkflowDigestArgs): Promise<ResolvedWorkflowObject> {
  const { digest, projectRoot, globalRoot, verifier } = args;

  let projectPresent = false;
  if (projectRoot !== undefined) {
    if (probeStoreRoot(projectRoot) === 'dir') {
      const projectObjectDir = objectDirForDigest(projectRoot, digest);
      projectPresent = await probeObjectDirCoordinated(projectRoot, projectObjectDir, digest, 'project');
    }
  }
  if (probeStoreRoot(globalRoot) !== 'dir') {
    // An absent/never-initialized global root cannot hold the object.
    if (!projectPresent) {
      throw new StoreIntegrityError(
        'object-missing',
        digest,
        'digest not present in the project or global workflow store',
      );
    }
    // Project present, global root absent: resolve from the project alone.
    const root = projectRoot as string;
    const objectPath = objectDirForDigest(root, digest);
    await verifyObjectAt(verifier, root, objectPath, digest, 'project');
    return { digest, objectPath, level: 'project', presentAt: { project: true, global: false } };
  }

  const globalObjectDir = objectDirForDigest(globalRoot, digest);
  const globalPresent = await probeObjectDirCoordinated(globalRoot, globalObjectDir, digest, 'global');

  if (projectPresent) {
    // Project wins; verify the object actually returned. The global presence
    // bit is metadata only (same digest by construction — the digest IS the
    // identity), so its copy is not verified here.
    const root = projectRoot as string;
    const objectPath = objectDirForDigest(root, digest);
    await verifyObjectAt(verifier, root, objectPath, digest, 'project');
    return { digest, objectPath, level: 'project', presentAt: { project: true, global: globalPresent } };
  }
  if (!globalPresent) {
    throw new StoreIntegrityError(
      'object-missing',
      digest,
      'digest not present in the project or global workflow store',
    );
  }
  await verifyObjectAt(verifier, globalRoot, globalObjectDir, digest, 'global');
  return { digest, objectPath: globalObjectDir, level: 'global', presentAt: { project: false, global: true } };
}

export interface ResolveWorkflowCoordinateArgs {
  /** The full `namespace/name@version` coordinate (human identity). */
  coordinate: WorkflowCoordinate;
  /** The project store root; ABSENT (undefined) means global-only resolution. */
  projectRoot?: string;
  /** The global store root (always consulted). */
  globalRoot: string;
  /** The ingest adapter that verifies installed object bytes. */
  verifier: BundleIngestor;
}

/**
 * Human/CLI coordinate resolution. Reads BOTH indexes (fail-closed — a
 * corrupt index is a {@link StoreIndexError}, never silently empty). No
 * entries for the coordinate ⇒ {@link StoreNotFoundError}. One entry resolves
 * and verifies its referenced object. Two entries with the SAME digest
 * deduplicate to one result (project path wins). Two entries with DIFFERENT
 * digests throw {@link StoreAmbiguityError} carrying the coordinate and both
 * digests — resolution never silently chooses project. An index entry whose
 * object is missing or corrupt is a {@link StoreIntegrityError}, never a
 * returned path. This API is for humans/CLI only — execution resolves
 * digests via {@link resolveWorkflowDigest}.
 */
export async function resolveWorkflowCoordinate(args: ResolveWorkflowCoordinateArgs): Promise<ResolvedWorkflowObject> {
  const { coordinate, projectRoot, globalRoot, verifier } = args;

  let projectDigest: string | undefined;
  if (projectRoot !== undefined && probeStoreRoot(projectRoot) === 'dir') {
    projectDigest = readWorkflowStoreIndex(storeIndexPath(projectRoot)).entries[coordinate]?.digest;
  }
  let globalDigest: string | undefined;
  if (probeStoreRoot(globalRoot) === 'dir') {
    globalDigest = readWorkflowStoreIndex(storeIndexPath(globalRoot)).entries[coordinate]?.digest;
  }

  if (projectDigest === undefined && globalDigest === undefined) {
    throw new StoreNotFoundError(coordinate);
  }
  if (projectDigest !== undefined && globalDigest !== undefined && projectDigest !== globalDigest) {
    throw new StoreAmbiguityError(coordinate, projectDigest, globalDigest);
  }

  // One digest now describes the coordinate at every level that holds it.
  const digest = (projectDigest ?? globalDigest) as DefDigest;
  const level: ResolutionLevel = projectDigest !== undefined ? 'project' : 'global';
  const root = level === 'project' ? (projectRoot as string) : globalRoot;
  const objectDir = objectDirForDigest(root, digest);
  if (!await probeObjectDirCoordinated(root, objectDir, digest, level)) {
    throw new StoreIntegrityError(
      'object-missing',
      digest,
      `${level} index references a missing object for '${coordinate}'`,
    );
  }
  await verifyObjectAt(verifier, root, objectDir, digest, level);

  return {
    digest,
    objectPath: objectDir,
    level,
    presentAt: {
      project: projectDigest !== undefined,
      global: globalDigest !== undefined,
    },
  };
}
