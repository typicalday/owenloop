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
import { parseManifestBytes } from '../bundle/manifest.ts';
import { defInstructionDigest } from '../order-resolver.ts';
import type {
  OrderInstructionLookup,
  OrderInstructionRef,
  OrderInstructionSource,
} from '../order-resolver.ts';
import { finalizeDefs, loadDefFile } from '../defs.ts';
import type { StepDef, WorkflowDef } from '../types.ts';
import { readWorkflowStoreIndex } from './index-file.ts';
import {
  StoreIntegrityError,
  defDigest,
	objectDirForDigest,
} from './types.ts';
import type { DefDigest, ResolutionLevel } from './types.ts';
import {
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
  return Object.values(index.entries)
    .map((entry) => defDigest(entry.digest))
    .sort((a, b) => a.localeCompare(b));
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
		await verifier.verifyInstalledObject({ objectDir: objectPath, digest: bundleDigest });
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

export function createStoreInstructionSource(args: StoreInstructionSourceArgs): StoreInstructionSource {
  const projectRoot = args.projectRoot === undefined ? undefined : projectStoreRoot(args.projectRoot);
  const globalRoot = projectStoreRoot(args.globalRoot);
  const cache = new Map<string, CachedDefinition[]>();
  const inFlight = new Map<string, Promise<'resolved' | 'unknown-digest'>>();

	const loadCandidate = async (
		requestedDigest: string,
		bundleDigest: DefDigest,
		root: string,
		level: ResolutionLevel,
	): Promise<boolean> => {
		const objectPath = await verifiedCandidateObject(root, bundleDigest, level, args.verifier);
		const manifestPath = join(objectPath, 'bundle.yaml');
    const manifest = parseManifestBytes(readFileSync(manifestPath));
    const loaded = new Map<string, WorkflowDef>();
    for (const [workflowName, workflowPath] of Object.entries(manifest.workflows)) {
			const def = loadDefFile(join(objectPath, workflowPath));
      if (def.name !== workflowName) {
        throw new StoreIntegrityError(
          'object-corrupt',
          bundleDigest,
          `workflow '${workflowPath}' has definition name '${def.name}', expected '${workflowName}'`,
        );
      }
      loaded.set(def.name, def);
    }
    const finalized = finalizeDefs(loaded);

    // Hub-backed orders use the immutable bundle digest as their execution
    // identity. Keep every workflow from that exact verified object in the
    // cache; the later step lookup selects a unique definition and refuses an
    // ambiguous step name instead of choosing one by manifest order.
    if (requestedDigest === bundleDigest) {
      cache.set(requestedDigest, [...finalized.values()].map((def) => ({
        def,
        bundleDigest,
				objectPath,
      })));
      return true;
    }

    // Plain-YAML/local-engine orders retain the per-definition projection
    // digest path for backwards compatibility.
    for (const def of finalized.values()) {
      if (defInstructionDigest(def) === requestedDigest) {
				cache.set(requestedDigest, [{ def, bundleDigest, objectPath }]);
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

  const primeOnce = async (requestedDigest: string): Promise<'resolved' | 'unknown-digest'> => {
    if (cache.has(requestedDigest)) return 'resolved';

		// Projection digests predate bundle identities, so every indexed bundle is a
		// candidate. Keep the store boundary explicit: finish the project scan before
		// opening the global index, and verify each row only against the tier that
		// supplied that row. A missing project object is stale index state and may
		// fall through; any other project integrity failure blocks the global tier.
		if (projectRoot !== undefined) {
			const projectOutcome = await scanTier(
				requestedDigest,
				indexedBundleDigests(projectRoot),
				projectRoot,
				'project',
			);
			if (projectOutcome.matched) return 'resolved';

			if (projectRoot === globalRoot) {
				if (projectOutcome.firstFailure !== undefined && !projectOutcome.inspectedCleanCandidate) {
					throw projectOutcome.firstFailure;
				}
				return 'unknown-digest';
      }
			if (projectOutcome.firstFailure !== undefined) throw projectOutcome.firstFailure;
		}

		const globalOutcome = await scanTier(
			requestedDigest,
			indexedBundleDigests(globalRoot),
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
    const cached = cache.get(requestedDigest);
    if (cached !== undefined) return Promise.resolve('resolved');
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
