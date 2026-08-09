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
 *   - {@link resolveWorkflowCoordinate} — human/CLI path: reads the project
 *     index first and uses the global index only as a fallback. When both
 *     levels name the coordinate, the project definition wins deterministically.
 *
 * Every successful resolution verifies the object it returns through the
 * ingest adapter's `verifyInstalledObject` before handing back a path — the
 * permissions/object shape on disk are defense in depth, not an integrity
 * proof. There is no bare-name resolution anywhere in this module.
 */

import { lstatSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  StoreIndexError,
  StoreIntegrityError,
  StoreNotFoundError,
  StorePathError,
  objectDirForDigest,
  WORKFLOW_STORE_INDEX_FILENAME,
} from './types.ts';
import type { DefDigest, ResolutionLevel, WorkflowCoordinate } from './types.ts';
import { readWorkflowStoreIndex } from './index-file.ts';
import { probeDirectoryPath } from '../install.ts';
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
  objectDir: string,
  digest: DefDigest,
  level: ResolutionLevel,
): Promise<void> {
  try {
    await verifier.verifyInstalledObject({ objectDir, digest });
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
      projectPresent = probeObjectDir(projectObjectDir, digest, 'project') === 'dir';
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
    const objectPath = objectDirForDigest(projectRoot as string, digest);
    await verifyObjectAt(verifier, objectPath, digest, 'project');
    return { digest, objectPath, level: 'project', presentAt: { project: true, global: false } };
  }

  const globalObjectDir = objectDirForDigest(globalRoot, digest);
  const globalPresent = probeObjectDir(globalObjectDir, digest, 'global') === 'dir';

  if (projectPresent) {
    // Project wins; verify the object actually returned. The global presence
    // bit is metadata only (same digest by construction — the digest IS the
    // identity), so its copy is not verified here.
    const objectPath = objectDirForDigest(projectRoot as string, digest);
    await verifyObjectAt(verifier, objectPath, digest, 'project');
    return { digest, objectPath, level: 'project', presentAt: { project: true, global: globalPresent } };
  }
  if (!globalPresent) {
    throw new StoreIntegrityError(
      'object-missing',
      digest,
      'digest not present in the project or global workflow store',
    );
  }
  await verifyObjectAt(verifier, globalObjectDir, digest, 'global');
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
 * entries for the coordinate ⇒ {@link StoreNotFoundError}. A project entry is
 * authoritative when present, even when the global index maps the same
 * coordinate to a different digest; the global entry is the fallback only
 * when the project has no match. The selected object's presence metadata is
 * still reported at both levels. An index entry whose selected object is
 * missing or corrupt is a {@link StoreIntegrityError}, never a returned path.
 * This API is for humans/CLI only — execution resolves digests via
 * {@link resolveWorkflowDigest}.
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
  // Project is the deterministic override. Global participates only when the
  // project index has no matching coordinate.
  const digest = (projectDigest ?? globalDigest) as DefDigest;
  const level: ResolutionLevel = projectDigest !== undefined ? 'project' : 'global';
  const root = level === 'project' ? (projectRoot as string) : globalRoot;
  const objectDir = objectDirForDigest(root, digest);
  if (probeObjectDir(objectDir, digest, level) !== 'dir') {
    throw new StoreIntegrityError(
      'object-missing',
      digest,
      `${level} index references a missing object for '${coordinate}'`,
    );
  }
  await verifyObjectAt(verifier, objectDir, digest, level);

  return {
    digest,
    objectPath: objectDir,
    level,
    presentAt: {
      project: projectDigest !== undefined,
      // A different global digest is a shadowed definition, not another copy
      // of the selected project object.
      global: globalDigest === digest,
    },
  };
}
