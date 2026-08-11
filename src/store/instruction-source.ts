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
} from './types.ts';
import type { DefDigest } from './types.ts';
import {
  projectStoreRoot,
  probeStoreRoot,
  resolveWorkflowDigest,
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
  /** Load and verify the bundle that corresponds to an order projection digest. */
  prime(defDigest: string): Promise<'resolved' | 'unknown-digest'>;
  /** Return a step only after `prime(defDigest)` has resolved that digest. */
  getVerifiedStep(defDigest: string, step: string): StepDef | undefined;
  /** Return the full verified definition cached by `prime`. */
  getVerifiedDefinition(defDigest: string): WorkflowDef | undefined;
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

function uniqueRoots(projectRoot: string | undefined, globalRoot: string): string[] {
  const roots = projectRoot === undefined ? [globalRoot] : [projectRoot, globalRoot];
  return [...new Set(roots.map((root) => projectStoreRoot(root)))];
}

function candidateDigests(projectRoot: string | undefined, globalRoot: string): DefDigest[] {
  const all = new Set<DefDigest>();
  for (const root of uniqueRoots(projectRoot, globalRoot)) {
    for (const digest of indexedBundleDigests(root)) all.add(digest);
  }
  return [...all].sort((a, b) => a.localeCompare(b));
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
  const cache = new Map<string, CachedDefinition>();
  const inFlight = new Map<string, Promise<'resolved' | 'unknown-digest'>>();

  const loadCandidate = async (requestedDigest: string, bundleDigest: DefDigest): Promise<boolean> => {
    const resolved = await resolveWorkflowDigest({
      digest: bundleDigest,
      projectRoot,
      globalRoot,
      verifier: args.verifier,
    });
    const manifestPath = join(resolved.objectPath, 'bundle.yaml');
    const manifest = parseManifestBytes(readFileSync(manifestPath));
    const loaded = new Map<string, WorkflowDef>();
    for (const [workflowName, workflowPath] of Object.entries(manifest.workflows)) {
      const def = loadDefFile(join(resolved.objectPath, workflowPath));
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
    for (const def of finalized.values()) {
      if (defInstructionDigest(def) === requestedDigest) {
        cache.set(requestedDigest, { def, bundleDigest, objectPath: resolved.objectPath });
        return true;
      }
    }
    return false;
  };

  const attemptCandidate = async (
    requestedDigest: string,
    bundleDigest: DefDigest,
  ): Promise<{ matched?: boolean; error?: unknown }> => {
    try {
      return { matched: await loadCandidate(requestedDigest, bundleDigest) };
    } catch (error) {
      return { error };
    }
  };

  const candidateFailureForRefusal = (error: unknown): unknown =>
    error instanceof StoreIntegrityError && error.code === 'object-missing' ? undefined : error;

  const evictObject = (bundleDigest: DefDigest, objectPath: string): void => {
    for (const [instructionDigest, cached] of cache) {
      if (cached.bundleDigest === bundleDigest && cached.objectPath === objectPath) {
        cache.delete(instructionDigest);
      }
    }
  };

  const verifyCached = async (requestedDigest: string): Promise<boolean> => {
    const cached = cache.get(requestedDigest);
    if (cached === undefined) return false;
    try {
      await args.verifier.verifyInstalledObject({
        objectDir: cached.objectPath,
        digest: cached.bundleDigest,
      });
      return true;
    } catch (error) {
      evictObject(cached.bundleDigest, cached.objectPath);
      throw error;
    }
  };

  const primeOnce = async (requestedDigest: string): Promise<'resolved' | 'unknown-digest'> => {
    if (await verifyCached(requestedDigest)) return 'resolved';

    // Indexes can retain stale or damaged sibling objects. A candidate failure
    // must not prevent a later, clean object from satisfying the requested
    // projection digest. Keep the first non-missing failure only for the case
    // where no candidate could be loaded cleanly; otherwise the requested
    // digest is genuinely unknown among the candidates we could inspect.
    let firstCandidateFailure: unknown;
    let inspectedCleanCandidate = false;
    for (const bundleDigest of candidateDigests(projectRoot, globalRoot)) {
      const outcome = await attemptCandidate(requestedDigest, bundleDigest);
      const candidateError = outcome.error;
      if (candidateError !== undefined) firstCandidateFailure ??= candidateFailureForRefusal(candidateError);
      inspectedCleanCandidate ||= candidateError === undefined;
      if (candidateError === undefined && outcome.matched === true) return 'resolved';
    }
    if (firstCandidateFailure !== undefined && !inspectedCleanCandidate) throw firstCandidateFailure;
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

  return {
    digestOf: (_def: WorkflowDef): string => {
      throw new StoreInstructionSourceError(
        'store-backed instruction source cannot emit a digest from an uninstalled definition; install and index the workflow bundle first',
      );
    },
    lookup: (ref: OrderInstructionRef): OrderInstructionLookup => {
      const cached = cache.get(ref.defDigest);
      if (cached === undefined) return { status: 'unknown-digest' };
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
      const cached = cache.get(requestedDigest);
      return cached?.def.steps.find((step) => step.name === stepName);
    },
    getVerifiedDefinition: (requestedDigest: string): WorkflowDef | undefined => cache.get(requestedDigest)?.def,
    getVerifiedObject: (requestedDigest: string): { bundleDigest: DefDigest; objectPath: string } | undefined => {
      const cached = cache.get(requestedDigest);
      return cached === undefined ? undefined : { bundleDigest: cached.bundleDigest, objectPath: cached.objectPath };
    },
  };
}

/** A small helper for callers that receive a raw order digest before priming. */
export function isResolvableOrderDigest(value: string): value is DefDigest {
  return asDefDigest(value) !== undefined;
}
