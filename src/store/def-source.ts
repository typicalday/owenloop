/**
 * WS-6: the CAS → `WorkflowDef` bridge.
 *
 * Two DIFFERENT install systems put workflows on disk, and before this module
 * only one of them was reachable from a `calls:` edge:
 *
 *   - `owenloop add` (GitHub route) writes a ledger (`.owenloop/installed.json`)
 *     naming subfolders of the defs dir. `loadDefsWithInstalled` (cli.ts) folds
 *     those defs into the SAME flat map the engine's `DefResolver` reads, so a
 *     project-local def can already `calls:` an `add`-installed def by name.
 *
 *   - `owenloop bundle add` (CAS route) writes an immutable object under
 *     `objects/sha256/<bundle-digest>/` plus an `index.json` entry. Until this
 *     module, those defs were read ONLY by `createStoreInstructionSource` — an
 *     `OrderInstructionSource`, which maps a digest to a step body. Nothing ever
 *     handed them to a `DefResolver`, so a `calls:` edge could not reach them.
 *
 * This module closes that second gap: it walks both store roots' indexes, loads
 * every workflow out of every indexed bundle object, and returns registrations
 * carrying enough provenance for the resolver to place them precisely.
 *
 * TWO KEYS PER WORKFLOW, DELIBERATELY ASYMMETRIC:
 *
 *   - `qualified` (`<package>/<workflow>`) IS registered in the flat def map.
 *     It is unforgeable as a project-local name because a def name must match
 *     `/^[a-z0-9][a-z0-9_-]*$/i` (defs.ts), which excludes `/`. So a CAS entry
 *     can never collide with, or shadow, a filesystem def.
 *
 *   - `bare` (the plain workflow name) is NEVER registered in the flat map. A
 *     bare `calls:` reaches it only from a def in the SAME bundle, matched on
 *     `bundleDigest` equality by the scope-aware resolver in defs.ts. This is
 *     what keeps `calls: build` inside bundle A from silently binding to an
 *     unrelated `build` inside bundle B.
 *
 * FAIL-OPEN, matching `loadDefsWithInstalled`: a corrupt index, an unreadable
 * object, or a bundle whose workflows do not validate emits a warning through
 * the caller's `warn` sink and is SKIPPED. A bad CAS object must never break
 * `owenloop status`. (The install-time path in install.ts stays fail-closed —
 * this is read-side discovery refusing to act on bad data, not acceptance.)
 *
 * SYNCHRONOUS by construction. `openCtx` and `dispatch` in cli.ts are both
 * synchronous, so this loader cannot use the `Promise`-returning
 * `resolveWorkflowDigest` / `BundleIngestor.verifyInstalledObject` path that
 * `createStoreInstructionSource` uses. It performs the same probes and the same
 * integrity verification through `verifyWorkflowObjectSync`, whose body is
 * already entirely `*Sync` filesystem calls.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifestBytes } from '../bundle/manifest.ts';
import { loadDefFile } from '../defs.ts';
import type { WorkflowDef } from '../types.ts';
import { readWorkflowStoreIndex } from './index-file.ts';
import { verifyWorkflowObjectSync } from './ingestor.ts';
import {
  coordinateDigestReadSync,
  probeObjectDir,
  probeStoreRoot,
  projectStoreRoot,
  storeIndexPath,
} from './resolve.ts';
import { defDigest, objectDirForDigest } from './types.ts';
import type { DefDigest, ResolutionLevel } from './types.ts';

/** One workflow from one installed CAS bundle, with the provenance the resolver needs. */
export interface CasDefRegistration {
  /**
   * The flat-map key this def is registered under. Normally the QUALIFIED key
   * `<package>/<workflow>`. When two DIFFERENT bundle digests both export that
   * same qualified key — the same package installed at two versions — the first
   * one registered keeps it and every later one is registered under the
   * DIGEST-SCOPED key `<bundleDigest>/<workflow>` instead.
   *
   * The loser is deliberately kept reachable rather than dropped: a parent
   * instance pinned (§28) to the older bundle must still be able to resolve its
   * own sibling, or installing a newer version would retroactively break a
   * running parent — exactly the failure this workstream exists to prevent.
   *
   * Either form contains `/`, which a def name may not
   * (`/^[a-z0-9][a-z0-9_-]*$/i`), so neither can shadow a filesystem def.
   */
  key: string;
  /**
   * Qualified key `<package>/<workflow>` — the human-facing name. Equal to
   * {@link key} unless another bundle digest already claimed it.
   */
  qualified: string;
  /**
   * The bare workflow name. Resolvable ONLY from a def whose `bundleDigest`
   * equals this registration's; never a flat-map key.
   */
  bare: string;
  /** The loaded (not yet finalized) definition, already carrying provenance. */
  def: WorkflowDef;
  /** The canonical bundle digest of the store object this def came from. */
  bundleDigest: DefDigest;
  /** The installed bundle's `package.name`. */
  bundlePackage: string;
  /** Which store root supplied the object (`project` wins a same-digest pair). */
  level: ResolutionLevel;
}

export interface LoadCasDefsArgs {
  /** The project store root (the resolved defs dir); `undefined` = global-only. */
  projectRoot?: string;
  /** The global store root, normally `<home>/.owenloop/workflows`. */
  globalRoot: string;
  /** Warning sink — one line per skipped index/object. Never throws. */
  warn: (line: string) => void;
}

/** Read one root's index, returning its digests; fail-open on a bad index. */
function indexedDigests(root: string, level: ResolutionLevel, warn: (line: string) => void): DefDigest[] {
  let probe: 'dir' | 'absent';
  try {
    probe = probeStoreRoot(root);
  } catch (e) {
    warn(`warning: skipping ${level} workflow store at ${root}: ${(e as Error).message}`);
    return [];
  }
  if (probe !== 'dir') return [];
  try {
    const index = readWorkflowStoreIndex(storeIndexPath(root));
    const out: DefDigest[] = [];
    for (const entry of Object.values(index.entries)) {
      try {
        out.push(defDigest(entry.digest));
      } catch (e) {
        warn(`warning: skipping ${level} workflow store entry: ${(e as Error).message}`);
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  } catch (e) {
    warn(`warning: skipping ${level} workflow store index at ${root}: ${(e as Error).message}`);
    return [];
  }
}

class CasObjectAbsentDuringCoordinatedRead extends Error {}

/**
 * Load every workflow from ONE verified bundle object.
 *
 * Throws on any problem — the caller converts that into a warning and skips the
 * whole bundle, so a half-loaded bundle is never registered.
 */
function loadObjectDefs(
  objectDir: string,
  bundleDigest: DefDigest,
): { bundlePackage: string; defs: Map<string, WorkflowDef> } {
  verifyWorkflowObjectSync(objectDir, bundleDigest, { coordinateRepair: false });
  const manifest = parseManifestBytes(readFileSync(join(objectDir, 'bundle.yaml')));
  const defs = new Map<string, WorkflowDef>();
  for (const [workflowName, workflowPath] of Object.entries(manifest.workflows)) {
    const def = loadDefFile(join(objectDir, workflowPath));
    if (def.name !== workflowName) {
      throw new Error(
        `workflow '${workflowPath}' has definition name '${def.name}', expected '${workflowName}'`,
      );
    }
    // Provenance is stamped here, on the ONE object that owns it. Both fields
    // are optional on WorkflowDef and are excluded from `defInstructionDigest`'s
    // projection (order-resolver.ts), so an installed def's instruction identity
    // is byte-identical whether it is read through this loader or through
    // `createStoreInstructionSource`.
    def.bundlePackage = manifest.package.name;
    def.bundleDigest = bundleDigest;
    // Copy (not alias) the manifest lock so the engine's spawn-time pin check is
    // pure in-memory work inside the child-creating transaction.
    def.bundleLock = { ...manifest.lock };
    defs.set(def.name, def);
  }
  return { bundlePackage: manifest.package.name, defs };
}

/**
 * Discover every `calls:`-reachable definition installed in the content-
 * addressed workflow store.
 *
 * Resolution order mirrors `resolveWorkflowDigest`: the project root is walked
 * first, so when the SAME bundle digest is installed at both levels the project
 * copy is the one registered and the global copy is skipped (identical bytes by
 * construction — the digest IS the identity — so this is deduplication, not a
 * precedence choice).
 *
 * Two DIFFERENT digests exporting the same `<package>/<workflow>` — the same
 * package installed at two versions — is NOT a conflict to drop one side of.
 * The first registration (project root first, then index order) keeps the plain
 * qualified key; every later one is registered under `<bundleDigest>/<workflow>`
 * and reported through `warn`. Both stay reachable, because a parent instance
 * pinned to the older bundle must keep resolving its own siblings after a newer
 * version is installed.
 *
 * Never throws. Every failure path warns and continues.
 */
export function loadCasDefs(args: LoadCasDefsArgs): CasDefRegistration[] {
  const { warn } = args;
  const projectRoot = args.projectRoot === undefined ? undefined : projectStoreRoot(args.projectRoot);
  const globalRoot = projectStoreRoot(args.globalRoot);

  const roots: Array<{ root: string; level: ResolutionLevel }> =
    projectRoot === undefined || projectRoot === globalRoot
      ? [{ root: globalRoot, level: 'global' }]
      : [
          { root: projectRoot, level: 'project' },
          { root: globalRoot, level: 'global' },
        ];

  const out: CasDefRegistration[] = [];
  const byQualified = new Map<string, CasDefRegistration>();
  const seenDigests = new Set<DefDigest>();

  for (const { root, level } of roots) {
    for (const bundleDigest of indexedDigests(root, level, warn)) {
      // Same digest at both levels is the same bytes: register once, project first.
      if (seenDigests.has(bundleDigest)) continue;

      const objectDir = objectDirForDigest(root, bundleDigest);
      let loaded: { bundlePackage: string; defs: Map<string, WorkflowDef> };
      try {
	loaded = coordinateDigestReadSync(root, bundleDigest, () => {
	  if (probeObjectDir(objectDir, bundleDigest, level) !== 'dir') {
	    throw new CasObjectAbsentDuringCoordinatedRead();
	  }
	  return loadObjectDefs(objectDir, bundleDigest);
	});
      } catch (e) {
	// An absent object is not an error — the other root may hold the digest.
	if (e instanceof CasObjectAbsentDuringCoordinatedRead) continue;
        warn(`warning: skipping ${level} workflow object ${bundleDigest}: ${(e as Error).message}`);
        continue;
      }
      seenDigests.add(bundleDigest);

      for (const def of loaded.defs.values()) {
        const qualified = `${loaded.bundlePackage}/${def.name}`;
        const winner = byQualified.get(qualified);
        // A second bundle digest claiming the same qualified key keeps its own
        // digest-scoped key rather than being dropped — see `CasDefRegistration.key`.
        const key = winner === undefined ? qualified : `${bundleDigest}/${def.name}`;
        if (winner !== undefined) {
          warn(
            `warning: workflow '${qualified}' from ${level} bundle ${bundleDigest} does not hold that name — ` +
              `${winner.level} bundle ${winner.bundleDigest} claimed it first; ` +
              `this copy stays reachable as '${key}' (bare calls: inside its own bundle are unaffected)`,
          );
        }
        const registration: CasDefRegistration = {
          key,
          qualified,
          bare: def.name,
          def,
          bundleDigest,
          bundlePackage: loaded.bundlePackage,
          level,
        };
        if (winner === undefined) byQualified.set(qualified, registration);
        out.push(registration);
      }
    }
  }

  return out;
}
