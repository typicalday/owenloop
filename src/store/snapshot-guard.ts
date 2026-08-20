/**
 * Cross-resource guard for persisting CAS-backed runtime definition snapshots.
 *
 * The workflow-store index/object tree and the runtime SQLite database cannot
 * share one atomic transaction. Instead, every destructive store writer and
 * every CAS snapshot writer share the store's existing `add.lock`. A snapshot
 * writer acquires all provenance roots, revalidates that its digest is still
 * indexed with verified bytes, and only then begins its SQLite transaction.
 * GC either observes that committed row, or wins the lock and makes a stale
 * writer fail validation after collection; a stranded snapshot cannot commit.
 */

import { lstatSync } from 'node:fs';
import { ensureDirectoryPathNoSymlink, guardStateFile } from '../install.ts';
import { acquireFileLockSync, releaseFileLock } from '../lock.ts';
import type { FileLockHandle } from '../lock.ts';
import type { WorkflowDef } from '../types.ts';
import { readWorkflowStoreIndex } from './index-file.ts';
import { verifyWorkflowObjectSync } from './ingestor.ts';
import { projectStoreRoot, probeStoreRoot, storeIndexPath, workflowStoreStatePaths } from './resolve.ts';
import { compareStoreText, defDigest, objectDirForDigest } from './types.ts';
import type { DefDigest } from './types.ts';

interface GuardedBundle {
  digest: DefDigest;
  roots: string[];
}

function guardedBundles(defs: readonly WorkflowDef[]): GuardedBundle[] {
  const rootsByDigest = new Map<DefDigest, Set<string>>();
  for (const def of defs) {
    if (def.bundleDigest === undefined || (def.bundleStoreRoots?.length ?? 0) === 0) continue;
    const digest = defDigest(def.bundleDigest);
    const roots = rootsByDigest.get(digest) ?? new Set<string>();
    for (const rawRoot of def.bundleStoreRoots ?? []) {
      if (typeof rawRoot !== 'string' || rawRoot.trim() === '') {
        throw new Error(`bundle ${digest} has malformed workflow-store snapshot provenance`);
      }
      roots.add(projectStoreRoot(rawRoot));
    }
    rootsByDigest.set(digest, roots);
  }
  return [...rootsByDigest]
    .map(([digest, roots]) => ({ digest, roots: [...roots].sort(compareStoreText) }))
    .sort((a, b) => compareStoreText(a.digest, b.digest));
}

function digestIsReachable(bundle: GuardedBundle): boolean {
  for (const root of bundle.roots) {
    if (probeStoreRoot(root) === 'absent') continue;
    const index = readWorkflowStoreIndex(storeIndexPath(root));
    const indexed = Object.values(index.entries).some((entry) => entry.digest === bundle.digest);
    if (!indexed) continue;
    const objectDir = objectDirForDigest(root, bundle.digest);
    const st = lstatSync(objectDir, { throwIfNoEntry: false });
    if (st === undefined) continue;
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`bundle ${bundle.digest} has unsafe object path '${objectDir}'`);
    }
    verifyWorkflowObjectSync(objectDir, bundle.digest, { coordinateRepair: false });
    return true;
  }
  return false;
}

/**
 * Run `fn` while every CAS provenance root is locked and revalidated.
 * Non-CAS definitions carry no roots and preserve the zero-lock path.
 */
export function withWorkflowSnapshotStoreGuard<T>(
  defs: readonly WorkflowDef[],
  fn: (guardedDigests: ReadonlySet<DefDigest>) => T,
): T {
  const bundles = guardedBundles(defs);
  if (bundles.length === 0) return fn(new Set());

  const rootAndStateByLockPath = new Map(
    bundles.flatMap((bundle) => bundle.roots)
      .map((root) => ({ root, state: workflowStoreStatePaths(root) }))
      .map((item) => [item.state.lockPath, item] as const),
  );
  const lockPaths = [...rootAndStateByLockPath.keys()].sort(compareStoreText);
  const locks: FileLockHandle[] = [];
  try {
    for (const lockPath of lockPaths) {
      const { root, state } = rootAndStateByLockPath.get(lockPath)!;
      // Guard the store root before creating `<root>/.owenloop`. In particular,
      // a global root reached through a symlinked `$HOME/.owenloop` must not
      // redirect snapshot-lock state outside the intended home.
      ensureDirectoryPathNoSymlink(root, 'workflow store root');
      ensureDirectoryPathNoSymlink(state.stateDir, 'workflow store state directory');
      guardStateFile(lockPath, 'install lock');
      locks.push(acquireFileLockSync(lockPath, { label: 'workflow-store snapshot writer' }));
    }
    for (const bundle of bundles) {
      if (!digestIsReachable(bundle)) {
        throw new Error(
          `refusing to persist workflow snapshot for bundle ${bundle.digest}: ` +
            'the bundle is no longer indexed with verified object bytes; reload definitions and retry',
        );
      }
    }
    return fn(new Set(bundles.map((bundle) => bundle.digest)));
  } finally {
    for (const lock of locks.reverse()) releaseFileLock(lock);
  }
}
