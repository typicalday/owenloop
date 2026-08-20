/**
 * Reachability-based garbage collection for the content-addressed workflow
 * store. Planning is synchronous and side-effect free. Applying recomputes the
 * plan under the store's existing writer lock, commits the pruned index first,
 * then parks and removes unreferenced immutable objects.
 */

import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseManifestBytes } from '../bundle/manifest.ts';
import { loadDefFile } from '../defs.ts';
import {
  acquireInstallLock,
  ensureDirectoryPathNoSymlink,
  guardStateFile,
  probeDirectoryPath,
  recoverInterruptedInstall,
  releaseInstallLock,
  rmRecursiveForce,
  STAGING_DIRNAME,
} from '../install.ts';
import type { LedgerLookup } from '../install.ts';
import type { InstallLockHandle } from '../install.ts';
import type { RuntimeSnapshotBundlePins } from '../store.ts';
import { randId } from '../util.ts';
import { loadCasDefs } from './def-source.ts';
import { readWorkflowStoreIndex, serializeWorkflowStoreIndex, writeWorkflowStoreIndex } from './index-file.ts';
import { verifyWorkflowObjectSync } from './ingestor.ts';
import { workflowStoreReplacementRecovery } from './install.ts';
import {
  fsyncWorkflowStoreFileAndParent,
  parkWorkflowStoreGcObject,
  recoverInterruptedWorkflowStoreGc,
  workflowStoreGcJournalPath,
} from './gc-recovery.ts';
import {
  compareStoreText,
  defDigest,
  objectDirForDigest,
  selectLatestVersion,
} from './types.ts';
import type {
  DefDigest,
  StoreLevel,
  WorkflowStoreIndex,
} from './types.ts';
import {
  probeStoreRoot,
  projectStoreRoot,
  storeIndexPath,
  workflowStoreStatePaths,
} from './resolve.ts';

export interface WorkflowStoreGcObject {
  digest: string;
  bytes: number;
  coordinates: string[];
}

export interface WorkflowStoreGcReport {
  ok: true;
  dryRun: boolean;
  level: StoreLevel;
  root: string;
  keep: number;
  /** Number of unique object directories selected for removal. */
  count: number;
  /** Sum of regular-file logical sizes in selected object directories. */
  bytes: number;
  /** Target-index coordinates selected for removal. */
  coordinates: string[];
  objects: WorkflowStoreGcObject[];
}

export interface PlanWorkflowStoreGcArgs {
  projectRoot: string;
  globalRoot: string;
  level: StoreLevel;
  keep: number;
  snapshotPins: readonly RuntimeSnapshotBundlePins[];
}

export interface WorkflowStoreGcPlan {
  report: WorkflowStoreGcReport;
  /** Canonical target index to commit before deleting objects. */
  nextIndex: WorkflowStoreIndex;
}

export interface CollectWorkflowStoreGcArgs {
  projectRoot: string;
  globalRoot: string;
  level: StoreLevel;
  keep: number;
  yes: boolean;
  /** Re-run inside the writer lock when `yes` is true. */
  readSnapshotPins: () => readonly RuntimeSnapshotBundlePins[];
  /** Project mode supplies the same legacy installed-ledger reader as bundle installation. */
  readLedger?: () => LedgerLookup;
  recoveryMarkerDir?: string;
  /** Narrow failure-injection seams for commit-order regression tests. */
  hooks?: {
    afterSnapshotPinsRead?: () => void;
    afterIndexWrite?: () => void;
    /** Process-interruption seam after durable evidence and the temporary live chmod. */
    afterLiveObjectMadeWritable?: (path: string) => void;
    /** Process-interruption seam after the object rename and parent fsyncs. */
    afterObjectParked?: (path: string) => void;
    removeParkedObject?: (path: string) => void;
  };
}

interface BundleObjectMetadata {
  digest: DefDigest;
  root: string;
  packageName: string;
  version: string;
  qualifiedWorkflows: string[];
  dependencies: Array<{ coordinate: string; digest: DefDigest }>;
  bytes: number;
}

function assertKeep(keep: number): void {
  if (!Number.isSafeInteger(keep) || keep <= 0) {
    throw new Error(`invalid workflow-store GC keep count ${JSON.stringify(keep)}: expected a positive integer`);
  }
}

function emptyIndex(): WorkflowStoreIndex {
  return { version: 1, entries: {} };
}

function readIndexAtRoot(root: string): WorkflowStoreIndex {
  return probeStoreRoot(root) === 'absent'
    ? emptyIndex()
    : readWorkflowStoreIndex(storeIndexPath(root));
}

/** Size one already-validated object without following links or special files. */
function regularTreeBytes(path: string): number {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (st === undefined) throw new Error(`workflow-store object path '${path}' disappeared while sizing`);
  if (st.isSymbolicLink()) throw new Error(`refusing workflow-store GC candidate '${path}': it is a symlink`);
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) {
    throw new Error(`refusing workflow-store GC candidate '${path}': it is a special filesystem node`);
  }
  let bytes = 0;
  for (const entry of readdirSync(path).sort(compareStoreText)) {
    bytes += regularTreeBytes(join(path, entry));
  }
  return bytes;
}

function readObjectMetadata(root: string, digest: DefDigest): BundleObjectMetadata {
  const objectDir = objectDirForDigest(root, digest);
  verifyWorkflowObjectSync(objectDir, digest, { coordinateRepair: false });
  const manifest = parseManifestBytes(readFileSync(join(objectDir, 'bundle.yaml')));
  const qualifiedWorkflows: string[] = [];
  for (const [workflowName, workflowPath] of Object.entries(manifest.workflows).sort(([a], [b]) => compareStoreText(a, b))) {
    const def = loadDefFile(join(objectDir, workflowPath));
    if (def.name !== workflowName) {
      throw new Error(
		`workflow-store object ${digest}: workflow '${workflowPath}' has definition name ` +
		  `'${def.name}', expected '${workflowName}'`,
      );
    }
    qualifiedWorkflows.push(`${manifest.package.name}/${workflowName}`);
  }
  return {
    digest,
    root,
    packageName: manifest.package.name,
    version: manifest.package.version,
    qualifiedWorkflows,
    dependencies: Object.entries(manifest.lock)
      .map(([coordinate, value]) => ({ coordinate, digest: defDigest(value) }))
      .sort((a, b) => compareStoreText(a.coordinate, b.coordinate) || compareStoreText(a.digest, b.digest)),
    bytes: regularTreeBytes(objectDir),
  };
}

/** Inventory every immutable object at one root, including index orphans. */
function scanObjects(root: string): Map<DefDigest, BundleObjectMetadata> {
  const objects = new Map<DefDigest, BundleObjectMetadata>();
  if (probeStoreRoot(root) === 'absent') return objects;
  const objectsRoot = join(root, 'objects');
  if (probeDirectoryPath(objectsRoot, 'workflow objects directory', root) === 'absent') return objects;
  const digestRoot = join(objectsRoot, 'sha256');
  if (probeDirectoryPath(digestRoot, 'workflow sha256 objects directory', root) === 'absent') return objects;
  for (const entry of readdirSync(digestRoot).sort(compareStoreText)) {
    const digest = defDigest(entry);
    const objectDir = objectDirForDigest(root, digest);
    const st = lstatSync(objectDir, { throwIfNoEntry: false });
    if (st === undefined) throw new Error(`workflow-store object '${objectDir}' disappeared during inventory`);
    if (st.isSymbolicLink()) throw new Error(`refusing workflow-store object '${objectDir}': it is a symlink`);
    if (!st.isDirectory()) throw new Error(`refusing workflow-store object '${objectDir}': it is not a directory`);
    objects.set(digest, readObjectMetadata(root, digest));
  }
  return objects;
}

function sameObjectMetadata(a: BundleObjectMetadata, b: BundleObjectMetadata): boolean {
  return a.packageName === b.packageName
    && a.version === b.version
    && JSON.stringify(a.qualifiedWorkflows) === JSON.stringify(b.qualifiedWorkflows)
    && JSON.stringify(a.dependencies) === JSON.stringify(b.dependencies);
}

function combineMetadata(
  first: ReadonlyMap<DefDigest, BundleObjectMetadata>,
  second: ReadonlyMap<DefDigest, BundleObjectMetadata>,
): Map<DefDigest, BundleObjectMetadata> {
  const combined = new Map(first);
  for (const [digest, metadata] of second) {
    const existing = combined.get(digest);
    if (existing !== undefined && !sameObjectMetadata(existing, metadata)) {
      throw new Error(
		`workflow-store digest ${digest} has inconsistent verified metadata at ` +
		  `'${existing.root}' and '${metadata.root}'`,
      );
    }
    if (existing === undefined) combined.set(digest, metadata);
  }
  return combined;
}

function emptyReport(level: StoreLevel, root: string, keep: number, dryRun: boolean): WorkflowStoreGcReport {
  return {
    ok: true,
    dryRun,
    level,
    root,
    keep,
    count: 0,
    bytes: 0,
    coordinates: [],
    objects: [],
  };
}

/**
 * Compute one deterministic, fail-closed GC plan without creating any path.
 * `keep=2` at the CLI means the current version plus one immediate rollback
 * version: bounded history without giving up the cheapest recovery option.
 */
export function planWorkflowStoreGc(args: PlanWorkflowStoreGcArgs): WorkflowStoreGcPlan {
  assertKeep(args.keep);
  const projectRoot = projectStoreRoot(args.projectRoot);
  const globalRoot = projectStoreRoot(args.globalRoot);
  const targetRoot = args.level === 'project' ? projectRoot : globalRoot;
  if (probeStoreRoot(targetRoot) === 'absent') {
    return { report: emptyReport(args.level, targetRoot, args.keep, true), nextIndex: emptyIndex() };
  }

  const sameRoot = projectRoot === globalRoot;
  const projectIndex = readIndexAtRoot(projectRoot);
  const globalIndex = sameRoot ? projectIndex : readIndexAtRoot(globalRoot);
  const targetIndex = args.level === 'project' ? projectIndex : globalIndex;

  // The strict loader proves every indexed coordinate/object/manifest/definition
  // relationship before any index entry can become a deletion candidate.
  const registrations = loadCasDefs({
    ...(sameRoot ? {} : { projectRoot }),
    globalRoot,
    warn: () => {},
  });

  const projectObjects = scanObjects(projectRoot);
  const globalObjects = sameRoot ? projectObjects : scanObjects(globalRoot);
  const installed = combineMetadata(projectObjects, globalObjects);
  for (const [coordinate, entry] of [
    ...Object.entries(projectIndex.entries),
    ...Object.entries(globalIndex.entries),
  ]) {
    if (!installed.has(defDigest(entry.digest))) {
      throw new Error(
		`workflow-store coordinate '${coordinate}' references digest ${entry.digest}, ` +
		  `but no verified object is installed at either store root`,
      );
    }
  }

  const targetObjects = args.level === 'project' ? projectObjects : globalObjects;
  const nonTargetIndex = args.level === 'project' ? globalIndex : projectIndex;
  const requiredTargetDigests = new Set<DefDigest>();
  const protectedTargetObjects = new Set<DefDigest>();
  const dependencyQueue: DefDigest[] = [];
  const queuedDependencies = new Set<DefDigest>();

  const queueDependencies = (digest: DefDigest): void => {
    if (queuedDependencies.has(digest)) return;
    queuedDependencies.add(digest);
    dependencyQueue.push(digest);
  };
  const targetCoordinatesForDigest = (digest: DefDigest): string[] => Object.entries(targetIndex.entries)
    .filter(([, entry]) => entry.digest === digest)
    .map(([coordinate]) => coordinate)
    .sort(compareStoreText);
  const requireTargetDigest = (digest: DefDigest, reason: string): void => {
    if (requiredTargetDigests.has(digest)) return;
    if (targetCoordinatesForDigest(digest).length === 0) {
      throw new Error(
	`workflow-store GC cannot preserve ${reason}: target ${args.level} index has no coordinate for digest ${digest}`,
      );
    }
    requiredTargetDigests.add(digest);
    queueDependencies(digest);
  };

  // Every retained non-target coordinate remains exactly callable after this
  // target-only mutation. Its own copy can satisfy that requirement without
  // retaining a redundant target copy, but all of its lock edges are roots.
  if (!sameRoot) {
    for (const entry of Object.values(nonTargetIndex.entries)) {
      queueDependencies(defDigest(entry.digest));
    }
  }

  // Cross-root selected winners hold their ordinary qualified names. A target
  // winner is also covered by keep>=1; this explicit root documents and guards
  // that invariant if selection policy changes independently.
  for (const registration of registrations) {
    if (registration.kind !== 'workflow' || registration.key !== registration.qualified) continue;
    if (targetCoordinatesForDigest(registration.bundleDigest).length > 0) {
      requireTargetDigest(registration.bundleDigest, `selected workflow '${registration.qualified}'`);
    } else {
      queueDependencies(registration.bundleDigest);
    }
  }

  // Keep the best N target-level objects for every exported qualified workflow.
  const targetDigests = [...new Set(
    Object.values(targetIndex.entries).map((entry) => defDigest(entry.digest)),
  )].sort(compareStoreText);
  const candidatesByWorkflow = new Map<string, Array<{ digest: DefDigest; version: string; level: StoreLevel }>>();
  for (const digest of targetDigests) {
    const metadata = installed.get(digest) as BundleObjectMetadata;
    for (const qualified of metadata.qualifiedWorkflows) {
      const candidates = candidatesByWorkflow.get(qualified) ?? [];
      candidates.push({ digest, version: metadata.version, level: args.level });
      candidatesByWorkflow.set(qualified, candidates);
    }
  }
  for (const qualified of [...candidatesByWorkflow.keys()].sort(compareStoreText)) {
    const selection = selectLatestVersion(candidatesByWorkflow.get(qualified) as Array<{
      digest: DefDigest;
      version: string;
      level: StoreLevel;
    }>);
    if (selection.kind === 'unorderable') {
      for (const candidate of selection.shadowed) {
		requireTargetDigest(candidate.digest, `unorderable workflow '${qualified}'`);
      }
      continue;
    }
    for (const candidate of [selection.winner, ...selection.shadowed].slice(0, args.keep)) {
      requireTargetDigest(candidate.digest, `keep window for workflow '${qualified}'`);
    }
  }

  // Explicit index pins are stronger than retention policy.
  for (const entry of Object.values(targetIndex.entries)) {
    if (entry.pinned) requireTargetDigest(defDigest(entry.digest), 'an explicit index pin');
  }

  // Every retained workflow row remains replay/adopt/debug state until delete.
  for (const snapshot of args.snapshotPins) {
    const digests = [
      ...(snapshot.bundleDigest === undefined ? [] : [defDigest(snapshot.bundleDigest)]),
      ...snapshot.bundleLock.map((digest) => defDigest(digest)),
    ];
    for (const digest of digests) {
      if (targetCoordinatesForDigest(digest).length > 0) {
		requireTargetDigest(digest, 'a retained runtime snapshot');
      } else if (targetObjects.has(digest)) {
		// A pin can name an orphan object. Preserve the bytes even though there
		// is no coordinate to retain or print.
		protectedTargetObjects.add(digest);
		queueDependencies(digest);
      } else {
		queueDependencies(digest);
      }
    }
  }

  // A project index may deliberately borrow its bytes from a globally indexed
  // copy. Global GC must retain the target coordinate/object pair that makes
  // each such non-target coordinate loadable.
  if (args.level === 'global' && !sameRoot) {
    for (const entry of Object.values(projectIndex.entries)) {
      const digest = defDigest(entry.digest);
      if (!projectObjects.has(digest)) {
		requireTargetDigest(digest, 'project exact-digest fallback');
      }
    }
  }

  const entryMatches = (index: WorkflowStoreIndex, coordinate: string, digest: DefDigest): boolean =>
    index.entries[coordinate]?.digest === digest;
  const indexNamesDigest = (index: WorkflowStoreIndex, digest: DefDigest): boolean =>
    Object.values(index.entries).some((entry) => entry.digest === digest);

  /** Retain target state only when the non-target root cannot satisfy an exact lock edge itself. */
  const preserveDependency = (parent: DefDigest, coordinate: string, digest: DefDigest): void => {
    const nonTargetSelfSufficient = args.level === 'project'
      ? entryMatches(globalIndex, coordinate, digest) && globalObjects.has(digest)
      : entryMatches(projectIndex, coordinate, digest) && projectObjects.has(digest);
    if (nonTargetSelfSufficient) {
      queueDependencies(digest);
      return;
    }

    const targetCanSatisfy = args.level === 'project'
      ? entryMatches(projectIndex, coordinate, digest) && (
		projectObjects.has(digest)
		|| (indexNamesDigest(globalIndex, digest) && globalObjects.has(digest))
      )
      : globalObjects.has(digest) && (
		entryMatches(globalIndex, coordinate, digest)
		|| (entryMatches(projectIndex, coordinate, digest) && !projectObjects.has(digest))
      );
    if (!targetCanSatisfy) {
      throw new Error(
	`workflow-store bundle ${parent} locks '${coordinate}' to ${digest}, ` +
		  'but no exact callable coordinate with verified bytes is installed',
      );
    }
    requireTargetDigest(digest, `bundle ${parent} lock '${coordinate}'`);
  };

  // Follow exact coordinate+digest locks to a fixed point. Digest alone is not
  // enough: runtime resolution needs the digest-scoped alias for that exact
  // coordinate, and project-to-global fallback is intentionally asymmetric.
  for (let cursor = 0; cursor < dependencyQueue.length; cursor += 1) {
    const digest = dependencyQueue[cursor] as DefDigest;
    const metadata = installed.get(digest);
    if (metadata === undefined) continue;
    for (const dependency of metadata.dependencies) {
      preserveDependency(digest, dependency.coordinate, dependency.digest);
    }
  }

  const nextEntries: WorkflowStoreIndex['entries'] = {};
  const removedCoordinatesByDigest = new Map<DefDigest, string[]>();
  for (const coordinate of Object.keys(targetIndex.entries).sort(compareStoreText)) {
    const entry = targetIndex.entries[coordinate] as WorkflowStoreIndex['entries'][string];
    const digest = defDigest(entry.digest);
    if (requiredTargetDigests.has(digest)) {
      nextEntries[coordinate] = entry;
      continue;
    }
    const coordinates = removedCoordinatesByDigest.get(digest) ?? [];
    coordinates.push(coordinate);
    removedCoordinatesByDigest.set(digest, coordinates);
  }
  const nextIndex: WorkflowStoreIndex = { version: 1, entries: nextEntries };
  const nextDigests = new Set(Object.values(nextEntries).map((entry) => defDigest(entry.digest)));
  const objects: WorkflowStoreGcObject[] = [];
  for (const digest of [...targetObjects.keys()].sort(compareStoreText)) {
    if (protectedTargetObjects.has(digest) || nextDigests.has(digest)) continue;
    const metadata = targetObjects.get(digest) as BundleObjectMetadata;
    objects.push({
      digest,
      bytes: metadata.bytes,
      coordinates: [...(removedCoordinatesByDigest.get(digest) ?? [])].sort(compareStoreText),
    });
  }
  const coordinates = [...removedCoordinatesByDigest.values()].flat().sort(compareStoreText);
  return {
    report: {
      ok: true,
      dryRun: true,
      level: args.level,
      root: targetRoot,
      keep: args.keep,
      count: objects.length,
      bytes: objects.reduce((sum, object) => sum + object.bytes, 0),
      coordinates,
      objects,
    },
    nextIndex,
  };
}

async function acquireGcLocks(roots: readonly string[]): Promise<InstallLockHandle[]> {
  const statesByLock = new Map(
    [...new Set(roots.map((root) => projectStoreRoot(root)))]
      .map((root) => workflowStoreStatePaths(root))
      .map((state) => [state.lockPath, state] as const),
  );
  const locks: InstallLockHandle[] = [];
  try {
    for (const lockPath of [...statesByLock.keys()].sort(compareStoreText)) {
      const state = statesByLock.get(lockPath)!;
      ensureDirectoryPathNoSymlink(state.stateDir, 'workflow store state directory');
      guardStateFile(state.lockPath, 'install lock');
      locks.push(await acquireInstallLock(state.lockPath));
    }
    return locks;
  } catch (error) {
    for (const lock of locks.reverse()) releaseInstallLock(lock);
    throw error;
  }
}

/** Plan, or recompute under both store writer locks and apply, one target-root GC. */
export async function collectWorkflowStoreGarbage(
  args: CollectWorkflowStoreGcArgs,
): Promise<WorkflowStoreGcReport> {
  assertKeep(args.keep);
  const projectRoot = projectStoreRoot(args.projectRoot);
  const globalRoot = projectStoreRoot(args.globalRoot);
  const targetRoot = args.level === 'project' ? projectRoot : globalRoot;
  if (probeStoreRoot(targetRoot) === 'absent') {
    return emptyReport(args.level, targetRoot, args.keep, !args.yes);
  }
  if (!args.yes) {
    return planWorkflowStoreGc({
      projectRoot,
      globalRoot,
      level: args.level,
      keep: args.keep,
      snapshotPins: args.readSnapshotPins(),
    }).report;
  }

  const state = workflowStoreStatePaths(targetRoot);
  // A destructive plan observes both independently written indexes. Acquire
  // both roots in canonical order so no install or snapshot writer can commit
  // into either side of the scan-to-delete window. This may create coordination
  // state at a known-but-missing counterpart root; dry-run remains side-effect
  // free and only the target index/object tree is changed.
  const locks = await acquireGcLocks([projectRoot, globalRoot]);
  try {
    guardStateFile(state.journalPath, 'crash-recovery journal');
    guardStateFile(workflowStoreGcJournalPath(state.stateDir), 'workflow-store GC journal');
    const stagingRoot = join(targetRoot, STAGING_DIRNAME);
    recoverInterruptedWorkflowStoreGc({ root: targetRoot, stateDir: state.stateDir });
    recoverInterruptedInstall({
      defsDir: targetRoot,
      journalPath: state.journalPath,
      lockfilePath: storeIndexPath(targetRoot),
      ...(args.recoveryMarkerDir === undefined ? {} : { recoveryMarkerDir: args.recoveryMarkerDir }),
      ...(args.readLedger === undefined ? {} : { readLedger: args.readLedger }),
      v2Replacement: workflowStoreReplacementRecovery,
    });

    // Recovery owns any transaction debris. Once it reports a stable store, an
    // old GC parked copy is safe to retry before computing fresh reachability.
    if (probeDirectoryPath(stagingRoot, 'workflow store staging directory', targetRoot) === 'dir') {
      rmRecursiveForce(stagingRoot);
    }

    const snapshotPins = args.readSnapshotPins();
    args.hooks?.afterSnapshotPinsRead?.();
    const plan = planWorkflowStoreGc({
      projectRoot,
      globalRoot,
      level: args.level,
      keep: args.keep,
      snapshotPins,
    });
    const currentIndex = readWorkflowStoreIndex(storeIndexPath(targetRoot));
    if (serializeWorkflowStoreIndex(currentIndex) !== serializeWorkflowStoreIndex(plan.nextIndex)) {
      const indexPath = storeIndexPath(targetRoot);
      writeWorkflowStoreIndex(indexPath, plan.nextIndex);
      // The pruned index is the durable commit point. Persist both its bytes and
      // containing directory entry before any object can leave the CAS path.
      fsyncWorkflowStoreFileAndParent(indexPath);
    }
    args.hooks?.afterIndexWrite?.();

    if (plan.report.objects.length > 0) {
      ensureDirectoryPathNoSymlink(stagingRoot, 'workflow store staging directory');
    }
    for (const object of plan.report.objects) {
      const digest = defDigest(object.digest);
      const parkedName = `gc-${digest}-${randId('park')}`;
      const parked = parkWorkflowStoreGcObject({
		root: targetRoot,
		stateDir: state.stateDir,
		digest,
		parkedName,
		...(args.hooks?.afterLiveObjectMadeWritable === undefined
			? {}
			: { afterLiveObjectMadeWritable: args.hooks.afterLiveObjectMadeWritable }),
		...(args.hooks?.afterObjectParked === undefined
			? {}
			: { afterObjectParked: args.hooks.afterObjectParked }),
      });
      (args.hooks?.removeParkedObject ?? rmRecursiveForce)(parked);
    }
    if (probeDirectoryPath(stagingRoot, 'workflow store staging directory', targetRoot) === 'dir') {
      rmRecursiveForce(stagingRoot);
    }
    return { ...plan.report, dryRun: false };
  } finally {
    for (const lock of locks.reverse()) releaseInstallLock(lock);
  }
}
