/**
 * Store-backed reference instruction resolution.
 *
 * The engine's `OrderInstructionSource.lookup` seam is synchronous because the
 * engine performs lookup inside the same SQLite transaction that claims an
 * order. A store lookup is filesystem I/O, so callers must first `prime` the
 * requested order digest. `lookup` then reads only the verified definition held
 * in the in-memory cache populated by that prime.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { isVersionedReference, parseManifestBytes } from '../bundle/manifest.ts';
import type { BundleManifest } from '../bundle/types.ts';
import { defInstructionDigest } from '../order-resolver.ts';
import type {
  OrderInstructionLookup,
  OrderInstructionRef,
  OrderInstructionSource,
} from '../order-resolver.ts';
import { digestScopedCallsTargetKey, finalizeDefs, loadDefFile } from '../defs.ts';
import type { StepDef, WorkflowDef } from '../types.ts';
import { readWorkflowStoreIndex } from './index-file.ts';
import {
  StoreIntegrityError,
  compareStoreText,
  defDigest,
  objectDirForDigest,
  parseWorkflowCoordinate,
} from './types.ts';
import type { DefDigest, ResolutionLevel } from './types.ts';
import {
  coordinateDigestRead,
  projectStoreRoot,
  probeObjectDir,
  probeStoreRoot,
  storeIndexPath,
} from './resolve.ts';
import type { BundleIngestor } from './install.ts';

/** Optional recovery hook for a digest that is not indexed locally. */
export interface MissingObjectHandler {
  onMissing(defDigest: string): Promise<'retry' | 'refuse'>;
}

export interface StoreInstructionSourceArgs {
  /** The project workflow store root, normally `<cwd>/workflows`. */
  projectRoot?: string;
  /** The global workflow store root, derived from injected environment state. */
  globalRoot: string;
  /** The adapter that verifies every object before its workflow is loaded. */
  verifier: BundleIngestor;
  /** Optional one-shot recovery hook for an unknown order digest. */
  onMissing?: MissingObjectHandler;
}

export class StoreInstructionSourceError extends Error {
  override readonly name = 'StoreInstructionSourceError';
  readonly code: 'digest-of-unavailable';

  constructor(message: string) {
    super(message);
    this.code = 'digest-of-unavailable';
  }
}

interface CachedDefinition {
  def: WorkflowDef;
  bundleDigest: DefDigest;
  objectPath: string;
  /** Every object whose verified bytes supported this parent definition. */
  support: readonly SupportingObject[];
}

interface SupportingObject {
  bundleDigest: DefDigest;
  objectPath: string;
  root: string;
  level: ResolutionLevel;
}

interface LoadedObject extends SupportingObject {
  manifest: BundleManifest;
  defs: Map<string, WorkflowDef>;
}

/** A synchronous lookup source backed by verified local workflow-store objects. */
export interface StoreInstructionSource extends OrderInstructionSource {
  /** Load and verify the bundle that corresponds to an order or bundle digest. */
  prime(defDigest: string): Promise<'resolved' | 'unknown-digest'>;
  /** Return a step only after `prime(defDigest)` has resolved that digest. */
  getVerifiedStep(defDigest: string, step: string): StepDef | undefined;
  /** Return the full verified definition cached by `prime`, narrowed by step when a bundle contains several workflows. */
  getVerifiedDefinition(defDigest: string, step?: string): WorkflowDef | undefined;
  /** Return the installed bundle identity and object path cached by `prime`. */
  getVerifiedObject(defDigest: string): { bundleDigest: DefDigest; objectPath: string } | undefined;
}

function indexedBundleDigests(root: string): DefDigest[] {
  if (probeStoreRoot(root) !== 'dir') return [];
  const index = readWorkflowStoreIndex(storeIndexPath(root));
  // Enumeration order only — every candidate is tried and matched by exact
  // digest, so this never selects a version. It is sorted, and sorted without
  // `localeCompare`, so the order candidates are inspected (and therefore which
  // integrity failure is reported first) is identical on every host.
  return Object.values(index.entries)
    .map((entry) => defDigest(entry.digest))
    .sort(compareStoreText);
}

async function verifiedCandidateObject(
  root: string,
  bundleDigest: DefDigest,
  level: ResolutionLevel,
  verifier: BundleIngestor,
): Promise<string> {
  if (probeStoreRoot(root) !== 'dir') {
    throw new StoreIntegrityError(
      'object-missing',
      bundleDigest,
      `${level}-level workflow store is absent`,
    );
  }

  const objectPath = objectDirForDigest(root, bundleDigest);
  if (probeObjectDir(objectPath, bundleDigest, level) !== 'dir') {
    throw new StoreIntegrityError(
      'object-missing',
      bundleDigest,
      `${level}-level index references a missing workflow object`,
    );
  }
  try {
    const verify = verifier.verifyInstalledObjectAfterCoordination ?? verifier.verifyInstalledObject;
    await verify.call(verifier, { objectDir: objectPath, digest: bundleDigest });
  } catch (error) {
    throw new StoreIntegrityError(
      'object-corrupt',
      bundleDigest,
      `${level}-level object failed verification: ${(error as Error).message}`,
    );
  }
  return objectPath;
}

function asDefDigest(raw: string): DefDigest | undefined {
  try {
    return defDigest(raw);
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read every workflow from one exact, already-addressed object. This is shared
 * by a requested parent and its lock-pinned dependencies so child bytes get
 * precisely the same installed-object verification before they are parsed.
 */
async function loadVerifiedObject(
  root: string,
  bundleDigest: DefDigest,
  level: ResolutionLevel,
  verifier: BundleIngestor,
): Promise<LoadedObject> {
  return coordinateDigestRead(root, bundleDigest, async () => {
    const objectPath = await verifiedCandidateObject(root, bundleDigest, level, verifier);
    try {
      const manifest = parseManifestBytes(readFileSync(join(objectPath, 'bundle.yaml')));
      const defs = new Map<string, WorkflowDef>();
      for (const [workflowName, workflowPath] of Object.entries(manifest.workflows)) {
	const def = loadDefFile(join(objectPath, workflowPath));
	if (def.name !== workflowName) {
	  throw new StoreIntegrityError(
	    'object-corrupt',
	    bundleDigest,
	    `workflow '${workflowPath}' has definition name '${def.name}', expected '${workflowName}'`,
	  );
	}
	// CAS provenance is part of calls: resolution, not the instruction
	// projection. defInstructionDigest deliberately excludes it.
	def.bundlePackage = manifest.package.name;
	def.bundleDigest = bundleDigest;
	def.bundleLock = { ...manifest.lock };
	defs.set(def.name, def);
      }
      return { bundleDigest, objectPath, root, level, manifest, defs };
    } catch (error) {
      if (error instanceof StoreIntegrityError) throw error;
      throw new StoreIntegrityError('object-corrupt', bundleDigest, errorText(error));
    }
  });
}

export function createStoreInstructionSource(args: StoreInstructionSourceArgs): StoreInstructionSource {
  const projectRoot = args.projectRoot === undefined ? undefined : projectStoreRoot(args.projectRoot);
  const globalRoot = projectStoreRoot(args.globalRoot);
  const cache = new Map<string, CachedDefinition[]>();
  const inFlight = new Map<string, Promise<'resolved' | 'unknown-digest'>>();

  const configuredRoots = (): Array<{ root: string; level: ResolutionLevel }> => {
    const roots: Array<{ root: string; level: ResolutionLevel }> = [];
    if (projectRoot !== undefined) roots.push({ root: projectRoot, level: 'project' });
    roots.push({ root: globalRoot, level: 'global' });
    return roots.filter((candidate, index) =>
      roots.findIndex((other) => other.root === candidate.root) === index,
    );
  };

  /**
   * Build the private, verified closure required to validate exact locked
   * calls. It intentionally walks only digests named by the parent chain, not
   * the whole store: unrelated indexed corruption must not poison this order.
   */
  const loadCandidate = async (
    requestedDigest: string,
    bundleDigest: DefDigest,
    root: string,
    level: ResolutionLevel,
  ): Promise<boolean> => {
    const parent = await loadVerifiedObject(root, bundleDigest, level, args.verifier);
    const validation = new Map<string, WorkflowDef>(parent.defs);
    const support = new Map<string, SupportingObject>();
    const loadedByRootAndDigest = new Map<string, LoadedObject>();
    const registeredDependencies = new Set<string>();
    const walked = new Set<string>();
    const keyFor = (object: SupportingObject): string => `${object.root}:${object.bundleDigest}`;
    const remember = (object: SupportingObject): void => {
      support.set(keyFor(object), object);
    };
    const registerDependencyDefinitions = (object: LoadedObject): void => {
      const key = keyFor(object);
      if (registeredDependencies.has(key)) return;
      registeredDependencies.add(key);
      for (const [workflowName, def] of object.defs) {
	validation.set(digestScopedCallsTargetKey(object.bundleDigest, workflowName), def);
      }
    };
    remember(parent);
    loadedByRootAndDigest.set(keyFor(parent), parent);

    const dependencyRoots = (from: LoadedObject): Array<{ root: string; level: ResolutionLevel }> => {
      const roots = [{ root: from.root, level: from.level }, ...configuredRoots()];
      return roots.filter((candidate, index) =>
	roots.findIndex((other) => other.root === candidate.root) === index,
      );
    };

    const loadAt = async (
      childDigest: DefDigest,
      candidate: { root: string; level: ResolutionLevel },
    ): Promise<LoadedObject> => {
      const key = `${candidate.root}:${childDigest}`;
      const existing = loadedByRootAndDigest.get(key);
      if (existing !== undefined) return existing;
      const loaded = await loadVerifiedObject(
	candidate.root,
	childDigest,
	candidate.level,
	args.verifier,
      );
      loadedByRootAndDigest.set(key, loaded);
      remember(loaded);
      return loaded;
    };

    const selectLockedTarget = (
      target: string,
      childDigest: DefDigest,
      child: LoadedObject,
    ): WorkflowDef => {
      let coordinate: ReturnType<typeof parseWorkflowCoordinate>;
      try {
	coordinate = parseWorkflowCoordinate(target);
      } catch (error) {
	throw new StoreIntegrityError(
	  'object-corrupt',
	  childDigest,
	  `locked calls target '${target}' has an invalid coordinate: ${errorText(error)}`,
	);
      }
      if (
	coordinate.name !== child.manifest.package.name
	|| coordinate.version !== child.manifest.package.version
      ) {
	throw new StoreIntegrityError(
	  'object-corrupt',
	  childDigest,
	  `locked calls target '${target}' does not match child manifest package '${child.manifest.package.name}@${child.manifest.package.version}'`,
	);
      }
      const workflowName = child.manifest.default
	?? (child.defs.size === 1 ? child.defs.keys().next().value as string | undefined : undefined);
      if (workflowName === undefined) {
	throw new StoreIntegrityError(
	  'object-corrupt',
	  childDigest,
	  `locked calls target '${target}' digest ${childDigest} exports multiple workflows and has no default`,
	);
      }
      const selected = child.defs.get(workflowName);
      if (selected === undefined) {
	throw new StoreIntegrityError(
	  'object-corrupt',
	  childDigest,
	  `locked calls target '${target}' selects missing child workflow '${workflowName}'`,
	);
      }
      return selected;
    };

    const walkObject = async (object: LoadedObject): Promise<void> => {
      const objectKey = keyFor(object);
      if (walked.has(objectKey)) return;
      walked.add(objectKey);
      for (const def of object.defs.values()) {
	for (const step of def.steps) {
	  if (step.calls === undefined || !isVersionedReference(step.calls)) continue;
	  const target = step.calls;
	  if (!Object.prototype.hasOwnProperty.call(object.manifest.lock, target)) {
	    throw new StoreIntegrityError(
	      'object-corrupt',
	      object.bundleDigest,
	      `locked calls target '${target}' has no entry in parent bundle ${object.bundleDigest} manifest lock`,
	    );
	  }
	  const childDigest = defDigest(object.manifest.lock[target]!);
	  let child: LoadedObject | undefined;
	  for (const candidate of dependencyRoots(object)) {
	    try {
	      child = await loadAt(childDigest, candidate);
	      break;
	    } catch (error) {
	      if (error instanceof StoreIntegrityError && error.code === 'object-missing') continue;
	      const verified = error instanceof StoreIntegrityError
		&& error.message.includes('object failed verification');
	      throw new StoreIntegrityError(
		'object-corrupt',
		childDigest,
		`locked calls target '${target}' digest ${childDigest} at ${candidate.level}-level root '${candidate.root}' ` +
		  `${verified ? 'failed installed-object verification' : 'could not load verified child'}: ${errorText(error)}`,
	      );
	    }
	  }
	  if (child === undefined) {
	    throw new StoreIntegrityError(
	      'object-corrupt',
	      childDigest,
	      `locked calls target '${target}' digest ${childDigest} is absent from every configured workflow store root`,
	    );
	  }
	  const selected = selectLockedTarget(target, childDigest, child);
	  // An alias is the only qualified path a parent calls: edge may take.
	  // All child workflows also retain an internal digest-scoped key so their
	  // bare sibling calls validate in the bundle that authored them.
	  if (child !== parent) registerDependencyDefinitions(child);
	  validation.set(digestScopedCallsTargetKey(childDigest, target), selected);
	  await walkObject(child);
	}
      }
    };

    await walkObject(parent);
    const finalized = finalizeDefs(validation);
    const parentDefinitions = [...parent.defs.keys()].map((name) => finalized.get(name)!);
    const cachedSupport = [...support.values()];

    // Hub-backed orders use the immutable bundle digest as their execution
    // identity. Dependencies are validation-only: never cache or publish them
    // under the parent digest, even when a child step name is globally unique.
    if (requestedDigest === bundleDigest) {
      cache.set(requestedDigest, parentDefinitions.map((def) => ({
	def,
	bundleDigest,
	objectPath: parent.objectPath,
	support: cachedSupport,
      })));
      return true;
    }

    // Plain-YAML/local-engine orders retain the per-definition projection
    // digest path for backwards compatibility.
    for (const def of parentDefinitions) {
      if (defInstructionDigest(def) === requestedDigest) {
	cache.set(requestedDigest, [{
	  def,
	  bundleDigest,
	  objectPath: parent.objectPath,
	  support: cachedSupport,
	}]);
	return true;
      }
    }
    return false;
  };

  const candidateFailureForRefusal = (error: unknown): unknown =>
    error instanceof StoreIntegrityError && error.code === 'object-missing' ? undefined : error;

  const scanTier = async (
    requestedDigest: string,
    bundleDigests: DefDigest[],
    root: string,
    level: ResolutionLevel,
  ): Promise<{ matched: boolean; firstFailure: unknown; inspectedCleanCandidate: boolean }> => {
    let firstFailure: unknown;
    let inspectedCleanCandidate = false;
    for (const bundleDigest of bundleDigests) {
      try {
	if (await loadCandidate(requestedDigest, bundleDigest, root, level)) {
	  return { matched: true, firstFailure, inspectedCleanCandidate: true };
	}
	inspectedCleanCandidate = true;
      } catch (error) {
	firstFailure ??= candidateFailureForRefusal(error);
      }
    }
    return { matched: false, firstFailure, inspectedCleanCandidate };
  };

  const evictObject = (bundleDigest: DefDigest, objectPath: string): void => {
    for (const [instructionDigest, cached] of cache) {
      // A cached entry is valid only while EVERY object that supported its
      // locked-edge closure is valid. Never leave a parent usable after a
      // supporting child changes or disappears.
      if (cached.some((candidate) => candidate.support.some(
	(support) => support.bundleDigest === bundleDigest && support.objectPath === objectPath,
      ))) {
	cache.delete(instructionDigest);
      }
    }
  };

  const verifyCached = async (requestedDigest: string): Promise<boolean> => {
    const cached = cache.get(requestedDigest);
    if (cached === undefined) return false;
    const verified = new Set<string>();
    for (const candidate of cached) {
      for (const support of candidate.support) {
	const key = `${support.root}:${support.bundleDigest}`;
	if (verified.has(key)) continue;
	verified.add(key);
	try {
	  await coordinateDigestRead(support.root, support.bundleDigest, async () => {
	    const verify = args.verifier.verifyInstalledObjectAfterCoordination ?? args.verifier.verifyInstalledObject;
	    await verify.call(args.verifier, {
	      objectDir: support.objectPath,
	      digest: support.bundleDigest,
	    });
	  });
	} catch (error) {
	  evictObject(support.bundleDigest, support.objectPath);
	  throw error;
	}
      }
    }
    return true;
  };

  const primeOnce = async (requestedDigest: string): Promise<'resolved' | 'unknown-digest'> => {
    if (await verifyCached(requestedDigest)) return 'resolved';

    /**
     * A bundle identity is already content-addressed: only an index row carrying
     * that exact digest is a candidate. Missing exact objects are stale rows and
     * may fall through; corrupt exact objects remain hard integrity refusals.
     */
    const loadExactIndexed = async (
      bundleDigests: DefDigest[],
      root: string,
      level: ResolutionLevel,
    ): Promise<boolean> => {
      const exact = asDefDigest(requestedDigest);
      if (exact === undefined || !bundleDigests.includes(exact)) return false;
      try {
	return await loadCandidate(requestedDigest, exact, root, level);
      } catch (error) {
	if (error instanceof StoreIntegrityError && error.code === 'object-missing') return false;
	throw error;
      }
    };

    const projectDigests = projectRoot === undefined
      ? undefined
      : indexedBundleDigests(projectRoot);
    if (
      projectRoot !== undefined &&
      projectDigests !== undefined &&
      await loadExactIndexed(projectDigests, projectRoot, 'project')
    ) {
      return 'resolved';
    }

    if (projectRoot === globalRoot && projectDigests !== undefined) {
      const projectOutcome = await scanTier(
	requestedDigest,
	projectDigests,
	projectRoot,
	'project',
      );
      if (projectOutcome.matched) return 'resolved';
      if (projectOutcome.firstFailure !== undefined && !projectOutcome.inspectedCleanCandidate) {
	throw projectOutcome.firstFailure;
      }
      return 'unknown-digest';
    }

    // Probe an exact global identity before scanning unrelated project bundles.
    // A corrupt global index is deferred until after the project projection scan,
    // so a clean project projection still resolves without global availability.
    let globalDigests: DefDigest[] | undefined;
    let globalIndexFailure: unknown;
    try {
      globalDigests = indexedBundleDigests(globalRoot);
    } catch (error) {
      globalIndexFailure = error;
    }
    if (
      globalDigests !== undefined &&
      await loadExactIndexed(globalDigests, globalRoot, 'global')
    ) {
      return 'resolved';
    }

    // Projection digests predate bundle identities, so every indexed bundle is a
    // candidate. Preserve project-first precedence and integrity behavior for
    // this legacy path after exact identities have been ruled out.
    if (projectRoot !== undefined && projectDigests !== undefined) {
      const projectOutcome = await scanTier(
	requestedDigest,
	projectDigests,
	projectRoot,
	'project',
      );
      if (projectOutcome.matched) return 'resolved';
      if (projectOutcome.firstFailure !== undefined) throw projectOutcome.firstFailure;
    }

    if (globalIndexFailure !== undefined) throw globalIndexFailure;
    const globalOutcome = await scanTier(
      requestedDigest,
      globalDigests ?? [],
      globalRoot,
      'global',
    );
    if (globalOutcome.matched) return 'resolved';
    if (globalOutcome.firstFailure !== undefined && !globalOutcome.inspectedCleanCandidate) {
      throw globalOutcome.firstFailure;
    }
    return 'unknown-digest';
  };

  const prime = (requestedDigest: string): Promise<'resolved' | 'unknown-digest'> => {
    const existing = inFlight.get(requestedDigest);
    if (existing !== undefined) return existing;

    const operation = (async (): Promise<'resolved' | 'unknown-digest'> => {
      let result = await primeOnce(requestedDigest);
      if (result === 'unknown-digest' && args.onMissing !== undefined) {
	const action = await args.onMissing.onMissing(requestedDigest);
	if (action === 'retry') result = await primeOnce(requestedDigest);
      }
      return result;
    })();
    inFlight.set(requestedDigest, operation);
    // Do not use a detached `finally()` here: a rejected finally-chain promise
    // would become an unhandled rejection while the caller is already handling
    // the original integrity refusal.
    void operation.then(
      () => inFlight.delete(requestedDigest),
      () => inFlight.delete(requestedDigest),
    );
    return operation;
  };

  const definitionsForStep = (requestedDigest: string, stepName: string): CachedDefinition[] =>
    cache.get(requestedDigest)?.filter(
      (candidate) => candidate.def.steps.some((step) => step.name === stepName),
    ) ?? [];

  const definitionForStep = (requestedDigest: string, stepName: string): CachedDefinition | undefined => {
    const matches = definitionsForStep(requestedDigest, stepName);
    return matches.length === 1 ? matches[0] : undefined;
  };

  return {
    digestOf: (_def: WorkflowDef): string => {
      throw new StoreInstructionSourceError(
	'store-backed instruction source cannot emit a digest from an uninstalled definition; install and index the workflow bundle first',
      );
    },
    lookup: (ref: OrderInstructionRef): OrderInstructionLookup => {
      if (!cache.has(ref.defDigest)) return { status: 'unknown-digest' };
      const matches = definitionsForStep(ref.defDigest, ref.step);
      if (matches.length === 0) return { status: 'unknown-step' };
      if (matches.length > 1) return { status: 'ambiguous-step' };
      const cached = matches[0]!;
      const step = cached.def.steps.find((candidate) => candidate.name === ref.step);
      if (step === undefined) return { status: 'unknown-step' };
      return {
	status: 'resolved',
	instructions: {
	  prompt: step.body,
	  ...(step.command !== undefined ? { command: step.command } : {}),
	  maxAttempts: step.maxAttempts,
	},
      };
    },
    prime,
    getVerifiedStep: (requestedDigest: string, stepName: string): StepDef | undefined => {
      const cached = definitionForStep(requestedDigest, stepName);
      return cached?.def.steps.find((step) => step.name === stepName);
    },
    getVerifiedDefinition: (requestedDigest: string, stepName?: string): WorkflowDef | undefined => {
      const cached = stepName === undefined
	? cache.get(requestedDigest)
	: [definitionForStep(requestedDigest, stepName)].filter(
	  (candidate): candidate is CachedDefinition => candidate !== undefined,
	);
      return cached?.length === 1 ? cached[0]!.def : undefined;
    },
    getVerifiedObject: (requestedDigest: string): { bundleDigest: DefDigest; objectPath: string } | undefined => {
      const cached = cache.get(requestedDigest)?.[0];
      return cached === undefined ? undefined : { bundleDigest: cached.bundleDigest, objectPath: cached.objectPath };
    },
  };
}

/** A small helper for callers that receive a raw order digest before priming. */
export function isResolvableOrderDigest(value: string): value is DefDigest {
  return asDefDigest(value) !== undefined;
}
