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
import { valueDigestHex } from '../crypto/canonical.ts';
import { isVersionedReference, parseManifestBytes, parseVersionedCallTarget } from '../bundle/manifest.ts';
import type { BundleManifest } from '../bundle/types.ts';
import { defInstructionDigest } from '../order-resolver.ts';
import type {
  OrderInstructionLookup,
  OrderInstructionRef,
  OrderInstructionSource,
} from '../order-resolver.ts';
import { DefError, callsEdgeKey, digestScopedCallsTargetKey, expandIncludes, finalizeDefs,
  validateDef,
  resolveCallsStep, resolveCallsTarget } from '../defs.ts';
import { bundleDialectForManifest, loadBundleDefFile } from '../bundle/workflow-def.ts';
import { isBundleWorkflowName } from '../bundle/call-target.ts';
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
  /** Parent-owned native selection for one routed occurrence. Absent on every
   * ordinary instruction source. The callback must authenticate its Service
   * read; the store independently verifies the selected signed child bytes. */
  routedConcreteCalls?: RoutedConcreteCallSelection;
  /** Internal, throwaway data-only selected-member verification. It never
   * publishes an executable instruction cache or accepts a routed call grant. */
  integrityOnlyHubLive?: { workflowName: string;
    accept(selection: VerifiedWorkflowSelection): void };
}

export interface RoutedConcreteCallEdge {
  parentDefRef: { bundleDigest: string; workflowName: string };
  callStep: string;
  callPath: string;
  target: string;
  childDefRef: { bundleDigest: string; workflowName: string };
  /** Private provenance derived during the signed graph walk. This field is
   * never sent as a Service selection hint; Service derives the same class
   * from the authored call and its verified dialect/lock. */
  selectionSource: 'service-observed' | 'signed-static';
  /** Present on a Service-observed slash edge; static signed edges need no
   * structural receipt but remain in the ancestry checked by Service. */
  receiptDigest?: string;
}

export interface RoutedConcreteCallRequest {
  rootWorkflow: string;
  run: string;
  frameWorkflow: string;
  frameDefRef: { bundleDigest: string; workflowName: string };
  /** Present only when the parent is a persisted native workflow. */
  parentWorkflow?: string;
  ancestry: readonly RoutedConcreteCallEdge[];
  edge: Omit<RoutedConcreteCallEdge, 'childDefRef' | 'receiptDigest' | 'selectionSource'>;
}

export type RoutedConcreteCallObservation =
  | { kind: 'selected-native-concrete-child'; childDefRef: RoutedConcreteCallEdge['childDefRef'];
      parentWorkflow: string; childWorkflow: string; receiptDigest: string }
  | { kind: 'prestart-live-concrete-child'; parentWorkflow: string;
      childDefRef: RoutedConcreteCallEdge['childDefRef']; observedLiveVersion: number;
      receiptDigest: string }
  | { kind: 'virtual-live-concrete-child';
      childDefRef: RoutedConcreteCallEdge['childDefRef']; observedLiveVersion: number;
      receiptDigest: string };

export interface RoutedConcreteCallSelection {
  rootWorkflow: string;
  run: string;
  frameWorkflow: string;
  frameDefRef: { bundleDigest: string; workflowName: string };
  /** Every callback result is scoped to the current original-session claim.
   * A structural observation alone never authorizes consumed producer proof. */
  observe(request: RoutedConcreteCallRequest): Promise<RoutedConcreteCallObservation>;
  stillAuthorized(): boolean;
  maxDepth?: number;
  maxReads?: number;
}

export class StoreInstructionSourceError extends Error {
  override readonly name = 'StoreInstructionSourceError';
  readonly code: 'digest-of-unavailable';

  constructor(message: string) {
    super(message);
    this.code = 'digest-of-unavailable';
  }
}

/** A verified `calls:` child: the finalized child definition and the exact
 *  bundle digest the parent's verified bytes pin it at. Validation context
 *  only — a child is never an instruction lookup target of its own. */
export interface VerifiedCallsChild {
  definition: WorkflowDef;
  bundleDigest: DefDigest;
  /** The `calls:` target as authored on the parent step. */
  target: string;
  /** Exact parent-observed structural child; producer admission still needs
   * a separately verified folded receipt and stored child proof. */
  selectedConcreteCall?: RoutedConcreteCallObservation;
}

interface CachedDefinition {
  def: WorkflowDef;
  bundleDigest: DefDigest;
  objectPath: string;
  /** Every object whose verified bytes supported this parent definition. */
  support: readonly SupportingObject[];
  /** The verified `calls:` child each `calls:` step of `def` invokes, keyed by step name. */
  callsChildren: ReadonlyMap<string, VerifiedCallsChild>;
  routedSelections?: readonly { request: RoutedConcreteCallRequest;
    observation: RoutedConcreteCallObservation }[];
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

/** One exact member of a primed, verified signed bundle and its own closure. */
export interface VerifiedDefinitionSelection {
  definition: WorkflowDef;
  step: StepDef;
  bundleDigest: DefDigest;
  objectPath: string;
  support: readonly { bundleDigest: DefDigest; objectPath: string }[];
  callsChild(callsStep: string): VerifiedCallsChild | undefined;
}

/** Exact signed manifest member without choosing a step from a child bundle. */
export interface VerifiedWorkflowSelection {
  definition: WorkflowDef;
  bundleDigest: DefDigest;
  objectPath: string;
  support: readonly { bundleDigest: DefDigest; objectPath: string }[];
}

/** A synchronous lookup source backed by verified local workflow-store objects. */
export interface StoreInstructionSource extends OrderInstructionSource {
  /** Load and verify the bundle that corresponds to an order or bundle digest. */
  prime(defDigest: string): Promise<'resolved' | 'unknown-digest'>;
  /** Select an exact signed manifest member; never fall back to a sibling or alias. */
  selectVerifiedDefinition(defDigest: string, workflowName: string, step: string): VerifiedDefinitionSelection | undefined;
  selectVerifiedWorkflow(defDigest: string, workflowName: string): VerifiedWorkflowSelection | undefined;
  /** Return a step only after `prime(defDigest)` has resolved that digest. */
  getVerifiedStep(defDigest: string, step: string): StepDef | undefined;
  /** Return the full verified definition cached by `prime`, narrowed by step when a bundle contains several workflows. */
  getVerifiedDefinition(defDigest: string, step?: string): WorkflowDef | undefined;
  /** Return the installed bundle identity and object path cached by `prime`. */
  getVerifiedObject(defDigest: string): { bundleDigest: DefDigest; objectPath: string } | undefined;
  /** Exact objects whose verified bytes support the primed definition, including locked calls children. */
  getVerifiedSupport?(defDigest: string, step: string): readonly { bundleDigest: DefDigest; objectPath: string }[] | undefined;
  /** Return the verified `calls:` child that step `callsStep` of the definition
   *  serving `step` invokes, resolved in the same finalized closure the
   *  definition was verified in. Optional so a source without a dependency
   *  closure still type-checks; a consumer treats its absence as "no
   *  calls-boundary context", never as permission. */
  getVerifiedCallsChild?(defDigest: string, step: string, callsStep: string): VerifiedCallsChild | undefined;
  /** Data-only selected-edge handoff for this exact primed frame member. */
  getRoutedSelections?(defDigest: string, workflowName: string): readonly {
    request: RoutedConcreteCallRequest; observation: RoutedConcreteCallObservation }[] | undefined;
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
      const dialect = bundleDialectForManifest(manifest);
      const defs = new Map<string, WorkflowDef>();
      for (const [workflowName, workflowPath] of Object.entries(manifest.workflows)) {
	const def = loadBundleDefFile(join(objectPath, workflowPath), dialect);
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

/** Verify one exact signed child member without constructing an executable
 * calls graph or adding it to a routed order's instruction cache. This is
 * used for an invocation-selected child whose bytes are independently bound
 * by the parent receipt; it grants no instruction lookup for that digest. */
export async function verifyInstalledWorkflowMember(args: {
  globalRoot: string;
  verifier: BundleIngestor;
  bundleDigest: string;
  workflowName: string;
  /** Initial staging may recover this exact signed digest once. Current
   * consequence rechecks omit the hook and therefore never download. */
  onMissing?: MissingObjectHandler;
}): Promise<VerifiedWorkflowSelection> {
  const digest = defDigest(args.bundleDigest);
  let selected: VerifiedWorkflowSelection | undefined;
  // This source is data-only. It verifies every signed member and exact
  // locked/static dependency, but leaves a Hub live slash edge to the child's
  // own later original-session native occurrence. No executable cache entry
  // is constructed or returned to the parent.
  const isolated = createStoreInstructionSource({ globalRoot: args.globalRoot,
    verifier: args.verifier,
    integrityOnlyHubLive: { workflowName: args.workflowName,
      accept: value => { selected = value; } },
    ...(args.onMissing === undefined ? {} : { onMissing: args.onMissing }) });
  if (await isolated.prime(digest) !== 'resolved')
    throw new DefError('selected signed child digest unavailable');
  if (!selected || selected.bundleDigest !== digest
    || selected.definition.name !== args.workflowName)
    throw new DefError('selected signed child member unavailable');
  return selected;
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
    // Include lookup is archive-local. Expand the parent's members before
    // digest-scoped dependency aliases share this validation map.
    const validation = new Map<string, WorkflowDef>([...parent.defs].map(([name, def]) =>
      [name, expandIncludes(def, member => parent.defs.get(member))] as const));
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
	// A dependency's include names are local to its own signed archive.
	// Resolve them before adding digest-scoped aliases to the shared map,
	// where a bare name may belong to the parent archive instead.
	validation.set(digestScopedCallsTargetKey(object.bundleDigest, workflowName),
	  expandIncludes(def, member => object.defs.get(member)));
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
      let namedWorkflow: string | undefined;
      try {
	const parsed = parseVersionedCallTarget(target);
	coordinate = parseWorkflowCoordinate(parsed.coordinate);
	namedWorkflow = parsed.workflow;
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
      const workflowName = namedWorkflow ?? child.manifest.default
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
      for (const raw of object.defs.values()) {
	// An include contributes authored executable steps to this same signed
	// object. Traverse its exact locked calls before finalizing the closure.
	const def = expandIncludes(raw, member => object.defs.get(member));
	for (const step of def.steps) {
	  if (step.calls === undefined || !isVersionedReference(step.calls)) continue;
	  const target = step.calls;
	  const lockKey = parseVersionedCallTarget(target).coordinate;
	  if (!Object.prototype.hasOwnProperty.call(object.manifest.lock, lockKey)) {
	    throw new StoreIntegrityError(
	      'object-corrupt',
	      object.bundleDigest,
	      `locked calls target '${target}' has no entry in parent bundle ${object.bundleDigest} manifest lock`,
	    );
	  }
	  const childDigest = defDigest(object.manifest.lock[lockKey]!);
	  let child: LoadedObject | undefined;
	  for (const candidate of dependencyRoots(object)) {
	    try {
	      child = await loadAt(childDigest, candidate);
	      break;
	    } catch (error) {
	      if (error instanceof StoreIntegrityError && error.code === 'object-missing') continue;
	      // A child whose own lock target is missing names THAT digest; keep it.
	      if (error instanceof StoreIntegrityError && error.code === 'dependency-missing') throw error;
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
	    // Not corruption: the parent verified, it merely pins a child this
	    // store never received. `prime` hands the CHILD digest to recovery.
	    throw new StoreIntegrityError(
	      'dependency-missing',
	      childDigest,
	      `locked calls target '${target}' digest ${childDigest} pinned by parent bundle ${object.bundleDigest} ` +
		'is absent from every configured workflow store root',
	    );
	  }
	  const selected = selectLockedTarget(target, childDigest, child);
	  // An alias is the only qualified path a parent calls: edge may take.
	  // All child workflows also retain an internal digest-scoped key so their
	  // bare sibling calls validate in the bundle that authored them.
	  if (child !== parent) registerDependencyDefinitions(child);
	  validation.set(digestScopedCallsTargetKey(childDigest, target),
	    expandIncludes(selected, member => child.defs.get(member)));
	  await walkObject(child);
	}
      }
    };

    await walkObject(parent);
    if (args.integrityOnlyHubLive !== undefined) {
      if (requestedDigest !== bundleDigest) return false;
      const deferred = new Set<string>();
	for (const [nodeKey, raw] of validation) {
	const def = expandIncludes(raw, member => validation.get(member));
	if (def.bundleDialect !== 'hub-qualified') continue;
	for (const step of def.steps) {
	  const target = step.calls;
	  if (target !== undefined && target.includes('/')
	    && isBundleWorkflowName(target)
	    && !isVersionedReference(target)
	    && def.bundleLock?.[target] === undefined)
	    deferred.add(callsEdgeKey(nodeKey, step));
	}
      }
      // This finalization validates all archive members and every static,
      // plain and locked cross-definition edge/cycle. Its sole deferred edges
      // are exact signed Hub live slash calls, which cannot authorize this
      // parent's executable graph without the child's own native occurrence.
      const finalized = finalizeDefs(validation, { deferredHubLiveCalls: deferred });
      const workflowName = args.integrityOnlyHubLive.workflowName;
      const selected = finalized.get(workflowName);
      if (!parent.defs.has(workflowName) || !selected
	|| selected.bundleDigest !== bundleDigest)
	throw new DefError('selected signed child member unavailable');
      args.integrityOnlyHubLive.accept({ definition: selected, bundleDigest,
	objectPath: parent.objectPath,
	support: [...support.values()].map(({ bundleDigest: digest, objectPath }) =>
	  ({ bundleDigest: digest, objectPath })) });
      return true;
    }
    const validateAllSignedMembers = (object: LoadedObject): void => {
      for (const [name, raw] of object.defs) {
	const expanded = expandIncludes(raw, member => object.defs.get(member));
	const errors = validateDef(expanded);
	if (errors.length) throw new DefError(`invalid signed workflow '${name}': ${errors[0]}`);
      }
    };
    const routed = args.routedConcreteCalls;
    const selectedCalls = new Map<string, RoutedConcreteCallObservation>();
    const routedSelections: Array<{ request: RoutedConcreteCallRequest;
      observation: RoutedConcreteCallObservation }> = [];
    let routedCalls: Map<string, string> | undefined;
    let executable: Map<string, WorkflowDef> = validation;
    if (routed !== undefined && requestedDigest === routed.frameDefRef.bundleDigest) {
      if (bundleDigest !== routed.frameDefRef.bundleDigest || !routed.rootWorkflow
	|| !routed.run || !routed.frameWorkflow || !routed.stillAuthorized())
	throw new DefError('routed concrete call occurrence unavailable');
      const entry = parent.defs.get(routed.frameDefRef.workflowName);
      if (!entry) throw new DefError('routed signed frame member unavailable');
      // The entire archive is still parsed, hashed and checked for authored
      // DSL errors. Only cross-definition execution is occurrence-dependent.
      for (const object of loadedByRootAndDigest.values()) validateAllSignedMembers(object);
      const reachable = new Map<string, WorkflowDef>();
      routedCalls = new Map();
      let observations = 0;
      const maxDepth = Math.min(routed.maxDepth ?? 64, 64);
      const maxReads = Math.min(routed.maxReads ?? 64, 64);
      if (!Number.isSafeInteger(maxDepth) || maxDepth < 1
	|| !Number.isSafeInteger(maxReads) || maxReads < 1)
	throw new DefError('routed concrete call limits unavailable');
      const objectFor = (def: WorkflowDef): LoadedObject | undefined => {
	if (def.bundleDigest === parent.bundleDigest && parent.defs.has(def.name)) return parent;
	for (const object of loadedByRootAndDigest.values())
	  if (object.bundleDigest === def.bundleDigest && object.defs.has(def.name)) return object;
	return undefined;
      };
      const objectForDigest = async (digest: DefDigest, from: LoadedObject): Promise<LoadedObject> => {
	for (const candidate of dependencyRoots(from)) {
	  try { return await loadAt(digest, candidate); }
	  catch (error) {
	    if (error instanceof StoreIntegrityError && error.code === 'object-missing') continue;
	    throw error;
	  }
	}
	throw new StoreIntegrityError('dependency-missing', digest,
	  `routed selected child digest ${digest} is absent from every configured workflow store root`);
      };
      const visit = async (
	def: WorkflowDef, object: LoadedObject, ancestry: readonly RoutedConcreteCallEdge[],
	parentWorkflow: string | undefined, depth: number, key: string,
	chain: ReadonlySet<string>,
      ): Promise<void> => {
	if (depth > maxDepth || !routed.stillAuthorized())
	  throw new DefError('routed concrete call closure unavailable');
	const signedIdentity = `${object.bundleDigest}\0${def.name}`;
	if (chain.has(signedIdentity)) throw new DefError('routed concrete call cycle');
	const nextChain = new Set(chain).add(signedIdentity);
	const expanded = expandIncludes(def, member => object.defs.get(member));
	reachable.set(key, expanded);
	for (const step of expanded.steps) {
	  if (step.calls === undefined) continue;
	  const callPath = step.produces[0]?.stem;
	  if (!callPath) throw new DefError('routed concrete call path unavailable');
	  const edge = { parentDefRef: { bundleDigest: object.bundleDigest,
	    workflowName: expanded.name }, callStep: step.name, callPath, target: step.calls };
	  const unversionedSlash = step.calls.includes('/') && !isVersionedReference(step.calls);
	  if (unversionedSlash && expanded.bundleLock?.[step.calls] === undefined) {
	    // Service's verified Hub dialect selects this spelling from the
	    // current live publication even when a same-bundle sibling exists.
	    // A plain ambient alias has no matching signed producer authority.
	    if (expanded.bundleDialect !== 'hub-qualified')
	      throw new DefError('routed plain live calls target has no signed selection');
	    if (++observations > maxReads || !routed.stillAuthorized())
	      throw new DefError('routed concrete call read budget exhausted');
	    const request: RoutedConcreteCallRequest = { rootWorkflow: routed.rootWorkflow,
	      run: routed.run, frameWorkflow: routed.frameWorkflow,
	      frameDefRef: routed.frameDefRef,
	      ...(parentWorkflow === undefined ? {} : { parentWorkflow }),
	      ancestry, edge };
	    const selected = await routed.observe(request);
	    if (!routed.stillAuthorized() || !selected
	      || !/^[0-9a-f]{64}$/.test(selected.receiptDigest)
	      || !/^[0-9a-f]{64}$/.test(selected.childDefRef.bundleDigest)
	      || !selected.childDefRef.workflowName
	      || (selected.kind === 'selected-native-concrete-child'
		&& (!selected.parentWorkflow || !selected.childWorkflow))
	      || (selected.kind === 'prestart-live-concrete-child'
		&& !selected.parentWorkflow)
	      || (parentWorkflow !== undefined && selected.kind === 'virtual-live-concrete-child')
	      || (parentWorkflow !== undefined && selected.kind !== 'virtual-live-concrete-child'
		&& selected.parentWorkflow !== parentWorkflow)
	      || (selected.kind === 'selected-native-concrete-child'
		? false
		: !Number.isSafeInteger(selected.observedLiveVersion)
		  || selected.observedLiveVersion < 1))
	      throw new DefError('routed concrete call selection refused');
	    const digest = defDigest(selected.childDefRef.bundleDigest);
	    const childObject = await objectForDigest(digest, object);
	    validateAllSignedMembers(childObject);
	    const child = childObject.defs.get(selected.childDefRef.workflowName);
	    if (!routed.stillAuthorized() || !child || child.bundleDigest !== digest)
	      throw new DefError('routed concrete call signed child unavailable');
	    registerDependencyDefinitions(childObject);
	    await walkObject(childObject);
	    const childKey = `routed:${valueDigestHex([routed.rootWorkflow, routed.run,
	      key, step.name, callPath, selected.childDefRef,
	      selected.kind === 'selected-native-concrete-child' ? selected.childWorkflow : 'virtual'])}`;
	    routedCalls!.set(callsEdgeKey(key, step), childKey);
	    selectedCalls.set(callsEdgeKey(key, step), selected);
	    routedSelections.push({ request, observation: selected });
	    const nextEdge = { ...edge, childDefRef: selected.childDefRef,
	      selectionSource: 'service-observed' as const,
	      receiptDigest: selected.receiptDigest };
	    await visit(child, childObject, [...ancestry, nextEdge],
	      selected.kind === 'selected-native-concrete-child' ? selected.childWorkflow : undefined,
	      depth + 1, childKey, nextChain);
	    continue;
	  }
	  const child = resolveCallsTarget(validation, step.calls, expanded);
	  if (!child) throw new DefError(`routed calls child '${step.calls}' unavailable`);
	  const childObject = objectFor(child);
	  if (!childObject || !child.bundleDigest)
	    throw new DefError('routed signed calls child unavailable');
	  const childKey = `routed:${valueDigestHex([routed.rootWorkflow, routed.run,
	    key, step.name, callPath, child.bundleDigest, child.name, 'signed-static'])}`;
	  routedCalls!.set(callsEdgeKey(key, step), childKey);
	  await visit(child, childObject,
	    [...ancestry, { ...edge, childDefRef: { bundleDigest: child.bundleDigest,
	      workflowName: child.name }, selectionSource: 'signed-static' }],
	    undefined, depth + 1, childKey, nextChain);
	}
      };
      await visit(entry, parent, [], routed.frameWorkflow, 0, entry.name, new Set());
      executable = reachable;
    }
    const finalized = finalizeDefs(executable,
      routedCalls === undefined ? {} : { routedCalls });
    const parentDefinitions = routed !== undefined && requestedDigest === routed.frameDefRef.bundleDigest
      ? [finalized.get(routed.frameDefRef.workflowName)!]
      : [...parent.defs.keys()].map((name) => finalized.get(name)!);
    const cachedSupport = [...support.values()];
    // The same scope-aware rule finalizeDefs validated and the engine runs:
    // a qualified target resolves through the parent's lock, a bare one to
    // the sibling inside the parent's own bundle. Recorded per calls step so
    // a consumer can corroborate a relayed child proof from verified bytes.
    const callsChildrenOf = (def: WorkflowDef, nodeKey = def.name): ReadonlyMap<string, VerifiedCallsChild> => {
      const children = new Map<string, VerifiedCallsChild>();
      for (const step of def.steps) {
	if (step.calls === undefined) continue;
	const child = resolveCallsStep(finalized, def, step, routedCalls, nodeKey);
	const rawDigest = child?.bundleDigest;
	if (child === undefined || rawDigest === undefined) continue;
	const childDigest = asDefDigest(rawDigest);
	if (childDigest === undefined) continue;
	children.set(step.name, { definition: child, bundleDigest: childDigest, target: step.calls,
	  ...(selectedCalls.get(callsEdgeKey(nodeKey, step)) === undefined ? {}
	    : { selectedConcreteCall: selectedCalls.get(callsEdgeKey(nodeKey, step))! }) });
      }
      return children;
    };

    // Hub-backed orders use the immutable bundle digest as their execution
    // identity. Dependencies are validation-only: never cache or publish them
    // under the parent digest, even when a child step name is globally unique.
    if (requestedDigest === bundleDigest) {
      cache.set(requestedDigest, parentDefinitions.map((def) => ({
	def,
	bundleDigest,
	objectPath: parent.objectPath,
	support: cachedSupport,
	callsChildren: callsChildrenOf(def),
	...(routed !== undefined && requestedDigest === routed.frameDefRef.bundleDigest
	  ? { routedSelections } : {}),
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
	  callsChildren: callsChildrenOf(def),
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
    // A native selected call belongs to one original occurrence. Local byte
    // verification alone cannot refresh that selection after an await.
    if (args.routedConcreteCalls === undefined && await verifyCached(requestedDigest)) return 'resolved';
    if (args.routedConcreteCalls !== undefined) cache.delete(requestedDigest);

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

  /**
   * Prime one digest, recovering a lock-pinned child that the verified
   * closure needs but no configured store root holds. A worker that pulled
   * the parent alone has exactly this shape, so recovery is asked for the
   * CHILD digest (never the requested one) and the parent is re-resolved once
   * the pull supplies it. Each missing child is requested at most once per
   * prime; a child recovery cannot supply surfaces as the named
   * `dependency-missing` error, not as `unknown-digest` (that would re-offer
   * the order forever) and not as corruption.
   */
  const primeRecoveringDependencies = async (
    requestedDigest: string,
  ): Promise<'resolved' | 'unknown-digest'> => {
    const requestedChildren = new Set<string>();
    for (;;) {
      try {
	return await primeOnce(requestedDigest);
      } catch (error) {
	if (!(error instanceof StoreIntegrityError) || error.code !== 'dependency-missing') throw error;
	if (args.onMissing === undefined || requestedChildren.has(error.digest)) throw error;
	requestedChildren.add(error.digest);
	const action = await args.onMissing.onMissing(error.digest);
	if (action !== 'retry') throw error;
      }
    }
  };

  const prime = (requestedDigest: string): Promise<'resolved' | 'unknown-digest'> => {
    if (args.routedConcreteCalls !== undefined
      && requestedDigest !== args.routedConcreteCalls.frameDefRef.bundleDigest)
      return Promise.reject(new DefError('routed instruction source cannot prime another occurrence'));
    const existing = inFlight.get(requestedDigest);
    if (existing !== undefined) return existing;

    const operation = (async (): Promise<'resolved' | 'unknown-digest'> => {
      let result = await primeRecoveringDependencies(requestedDigest);
      if (result === 'unknown-digest' && args.onMissing !== undefined) {
	const action = await args.onMissing.onMissing(requestedDigest);
	if (action === 'retry') result = await primeRecoveringDependencies(requestedDigest);
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
    selectVerifiedDefinition: (requestedDigest: string, workflowName: string,
      stepName: string): VerifiedDefinitionSelection | undefined => {
      const matches = cache.get(requestedDigest)?.filter((entry) =>
	entry.def.name === workflowName && entry.def.steps.some((step) => step.name === stepName)) ?? [];
      if (matches.length !== 1) return undefined;
      const selected = matches[0]!;
      const step = selected.def.steps.find((entry) => entry.name === stepName);
      if (step === undefined) return undefined;
      return { definition: selected.def, step, bundleDigest: selected.bundleDigest,
	objectPath: selected.objectPath,
	support: selected.support.map(({ bundleDigest, objectPath }) => ({ bundleDigest, objectPath })),
	callsChild: callsStep => selected.callsChildren.get(callsStep) };
    },
    selectVerifiedWorkflow: (requestedDigest: string, workflowName: string): VerifiedWorkflowSelection | undefined => {
      const matches = cache.get(requestedDigest)?.filter(entry => entry.def.name === workflowName) ?? [];
      if (matches.length !== 1) return undefined;
      const selected = matches[0]!;
      return { definition: selected.def, bundleDigest: selected.bundleDigest,
	objectPath: selected.objectPath,
	support: selected.support.map(({ bundleDigest, objectPath }) => ({ bundleDigest, objectPath })) };
    },
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
    getVerifiedSupport: (requestedDigest: string, stepName: string) =>
      definitionForStep(requestedDigest, stepName)?.support.map(({ bundleDigest, objectPath }) => ({ bundleDigest, objectPath })),
    getVerifiedCallsChild: (requestedDigest: string, stepName: string, callsStep: string): VerifiedCallsChild | undefined => {
      const cached = cache.get(requestedDigest)?.filter((entry) => entry.def.steps.some((step) => step.name === stepName));
      return cached?.length === 1 ? cached[0]!.callsChildren.get(callsStep) : undefined;
    },
    getRoutedSelections: (requestedDigest: string, workflowName: string) => {
      if (args.routedConcreteCalls === undefined
	|| requestedDigest !== args.routedConcreteCalls.frameDefRef.bundleDigest
	|| workflowName !== args.routedConcreteCalls.frameDefRef.workflowName) return undefined;
      const cached = cache.get(requestedDigest);
      return cached?.length === 1 && cached[0]?.def.name === workflowName
	? cached[0].routedSelections : undefined;
    },
  };
}

/** A small helper for callers that receive a raw order digest before priming. */
export function isResolvableOrderDigest(value: string): value is DefDigest {
  return asDefDigest(value) !== undefined;
}
