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
  renameDirRestoringWrite,
  releaseInstallLock,
  rmRecursiveForce,
  STAGING_DIRNAME,
} from '../install.ts';
import type { LedgerLookup } from '../install.ts';
import type { RuntimeSnapshotBundlePins } from '../store.ts';
import { randId } from '../util.ts';
import { loadCasDefs } from './def-source.ts';
import { readWorkflowStoreIndex, serializeWorkflowStoreIndex, writeWorkflowStoreIndex } from './index-file.ts';
import { verifyWorkflowObjectSync } from './ingestor.ts';
import { workflowStoreReplacementRecovery } from './install.ts';
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
    afterIndexWrite?: () => void;
    removeParkedObject?: (path: string) => void;
  };
}

interface BundleObjectMetadata {
  digest: DefDigest;
  root: string;
  packageName: string;
  version: string;
  qualifiedWorkflows: string[];
  dependencies: DefDigest[];
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
    dependencies: [...new Set(Object.values(manifest.lock).map((value) => defDigest(value)))]
      .sort(compareStoreText),
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

  const protectedDigests = new Set<DefDigest>();

  // Cross-root selected winners hold their ordinary qualified names.
  for (const registration of registrations) {
    if (registration.kind === 'workflow' && registration.key === registration.qualified) {
      protectedDigests.add(registration.bundleDigest);
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
      for (const candidate of selection.shadowed) protectedDigests.add(candidate.digest);
      continue;
    }
    for (const candidate of [selection.winner, ...selection.shadowed].slice(0, args.keep)) {
      protectedDigests.add(candidate.digest);
    }
  }

  // Explicit index pins are stronger than retention policy.
  for (const entry of Object.values(targetIndex.entries)) {
    if (entry.pinned) protectedDigests.add(defDigest(entry.digest));
  }

  // Every retained workflow row remains replay/adopt/debug state until delete.
  for (const snapshot of args.snapshotPins) {
    if (snapshot.bundleDigest !== undefined) protectedDigests.add(defDigest(snapshot.bundleDigest));
    for (const digest of snapshot.bundleLock) protectedDigests.add(defDigest(digest));
  }

  // A project index can intentionally use exact-digest fallback into global.
  if (args.level === 'global' && !sameRoot) {
    for (const entry of Object.values(projectIndex.entries)) {
      protectedDigests.add(defDigest(entry.digest));
    }
  }

  // Follow exact bundle locks to a fixed point. A retained parent can depend on
  // an older child than the ordinary keep window would preserve.
  let changed = true;
  while (changed) {
    changed = false;
    for (const digest of [...protectedDigests]) {
      const metadata = installed.get(digest);
      if (metadata === undefined) continue;
      for (const dependency of metadata.dependencies) {
		if (protectedDigests.has(dependency)) continue;
		protectedDigests.add(dependency);
		changed = true;
      }
    }
  }

  const nextEntries: WorkflowStoreIndex['entries'] = {};
  const removedCoordinatesByDigest = new Map<DefDigest, string[]>();
  for (const coordinate of Object.keys(targetIndex.entries).sort(compareStoreText)) {
    const entry = targetIndex.entries[coordinate] as WorkflowStoreIndex['entries'][string];
    const digest = defDigest(entry.digest);
    if (protectedDigests.has(digest)) {
      nextEntries[coordinate] = entry;
      continue;
    }
    const coordinates = removedCoordinatesByDigest.get(digest) ?? [];
    coordinates.push(coordinate);
    removedCoordinatesByDigest.set(digest, coordinates);
  }
  const nextIndex: WorkflowStoreIndex = { version: 1, entries: nextEntries };
  const nextDigests = new Set(Object.values(nextEntries).map((entry) => defDigest(entry.digest)));
  const targetObjects = args.level === 'project' ? projectObjects : globalObjects;
  const objects: WorkflowStoreGcObject[] = [];
  for (const digest of [...targetObjects.keys()].sort(compareStoreText)) {
    if (protectedDigests.has(digest) || nextDigests.has(digest)) continue;
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

/** Plan, or recompute under the writer lock and apply, one target-root GC. */
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
  ensureDirectoryPathNoSymlink(state.stateDir, 'workflow store state directory');
  guardStateFile(state.lockPath, 'install lock');
  guardStateFile(state.journalPath, 'crash-recovery journal');
  const lock = await acquireInstallLock(state.lockPath);
  try {
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
    const stagingRoot = join(targetRoot, STAGING_DIRNAME);
    if (probeDirectoryPath(stagingRoot, 'workflow store staging directory', targetRoot) === 'dir') {
      rmRecursiveForce(stagingRoot);
    }

    const plan = planWorkflowStoreGc({
      projectRoot,
      globalRoot,
      level: args.level,
      keep: args.keep,
      snapshotPins: args.readSnapshotPins(),
    });
    const currentIndex = readWorkflowStoreIndex(storeIndexPath(targetRoot));
    if (serializeWorkflowStoreIndex(currentIndex) !== serializeWorkflowStoreIndex(plan.nextIndex)) {
      writeWorkflowStoreIndex(storeIndexPath(targetRoot), plan.nextIndex);
    }
    args.hooks?.afterIndexWrite?.();

    if (plan.report.objects.length > 0) {
      ensureDirectoryPathNoSymlink(stagingRoot, 'workflow store staging directory');
    }
    for (const object of plan.report.objects) {
      const digest = defDigest(object.digest);
      const live = objectDirForDigest(targetRoot, digest);
      const liveState = lstatSync(live, { throwIfNoEntry: false });
      if (liveState === undefined || liveState.isSymbolicLink() || !liveState.isDirectory()) {
		throw new Error(`refusing to remove workflow-store object '${live}': it is no longer a real directory`);
      }
      verifyWorkflowObjectSync(live, digest, { coordinateRepair: false });
      const parked = join(stagingRoot, `gc-${digest}-${randId('park')}`);
      if (lstatSync(parked, { throwIfNoEntry: false }) !== undefined) {
		throw new Error(`refusing to park workflow-store object: destination '${parked}' already exists`);
      }
			// The index commit above made this object unreachable before any mode
			// transition. macOS refuses to rename a 0555 directory, so use the shared
			// mode-preserving rename helper only after that commit; the parked copy is
			// restored to 0555 before cleanup and no indexed/live object is chmodded.
			renameDirRestoringWrite(live, parked);
      (args.hooks?.removeParkedObject ?? rmRecursiveForce)(parked);
    }
    if (probeDirectoryPath(stagingRoot, 'workflow store staging directory', targetRoot) === 'dir') {
      rmRecursiveForce(stagingRoot);
    }
    return { ...plan.report, dryRun: false };
  } finally {
    releaseInstallLock(lock);
  }
}
