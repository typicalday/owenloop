/**
 * WS-6: the content-addressed workflow store → `WorkflowDef` bridge.
 *
 * Executable discovery is strict: an indexed coordinate is an integrity
 * boundary, so a corrupt index or object aborts discovery rather than
 * disappearing and allowing another store level to win. A valid multi-workflow
 * bundle without a default remains explicit-workflow-only and gets no coordinate
 * alias. Read-only callers that deliberately accept partial data must use
 * {@link inspectCasDefs}; its result carries `complete: false` whenever data was
 * skipped and must never be used to build an executable `DefResolver`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifestBytes } from '../bundle/manifest.ts';
import type { BundleManifest } from '../bundle/types.ts';
import { digestScopedCallsTargetKey, loadDefFile } from '../defs.ts';
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
import {
	compareStoreText,
	defDigest,
	objectDirForDigest,
	parseWorkflowCoordinate,
	selectLatestVersion,
	StoreIntegrityError,
} from './types.ts';
import type {
	DefDigest,
	ResolutionLevel,
	VersionSelectionCandidate,
	WorkflowCoordinate,
	WorkflowStoreIndexEntry,
} from './types.ts';

/** One workflow or coordinate alias from one verified CAS bundle. */
export interface CasDefRegistration {
	/** Flat-map key: package/workflow, digest/workflow, coordinate, or digest/coordinate. */
	key: string;
	/** Human-facing package/workflow key for the selected definition. */
	qualified: string;
	/** Bare workflow name, used only for same-bundle sibling resolution. */
	bare: string;
	/** Loaded, unfinalized definition carrying bundle provenance. */
	def: WorkflowDef;
	/** Verified bundle object digest. */
	bundleDigest: DefDigest;
	/** Manifest package name. */
	bundlePackage: string;
	/** Store level that supplied the verified object bytes. */
	level: ResolutionLevel;
	/** Registration purpose. Coordinate aliases are exact versioned call targets. */
	kind: 'workflow' | 'coordinate';
	/** Present only for a full versioned coordinate alias. */
	coordinate?: WorkflowCoordinate;
}

export interface LoadCasDefsArgs {
	/** Project store root (the resolved defs directory); undefined = global-only. */
	projectRoot?: string;
	/** Global store root, normally `<home>/.owenloop/workflows`. */
	globalRoot: string;
	/** Warning sink used only by tolerant inspection and collision notices. */
	warn: (line: string) => void;
	/** Emit the full per-candidate superseded-version notices. */
	verbose?: boolean;
}

/** Explicitly partial result for read-only inspection. */
export interface CasDefInspectionResult {
	registrations: CasDefRegistration[];
	/** False when any store root, index, object, or coordinate was skipped. */
	complete: boolean;
}

class CasObjectAbsentDuringCoordinatedRead extends Error {}

/** Runtime incompatibility is a listing warning, unlike store corruption. */
class CasRuntimeIncompatibleError extends Error {}

function isRuntimeIncompatible(error: unknown): boolean {
	return error instanceof Error
		&& error.message.includes('incompatible with this Owenloop runtime');
}

interface IndexedCoordinate {
	coordinate: WorkflowCoordinate;
	entry: WorkflowStoreIndexEntry;
	root: string;
	level: ResolutionLevel;
}

interface LoadedObject {
	bundleDigest: DefDigest;
	manifest: BundleManifest;
	defs: Map<string, WorkflowDef>;
	level: ResolutionLevel;
	objectRoot: string;
}

interface ReadIndexResult {
	entries: IndexedCoordinate[];
	complete: boolean;
}

function setBundleStoreRoots(def: WorkflowDef, roots: string[]): void {
	// This is live loader provenance, not definition content. Keep it available
	// to snapshot writers without changing hashDef or the persisted snapshot.
	Object.defineProperty(def, 'bundleStoreRoots', {
		value: roots,
		writable: true,
		configurable: true,
		enumerable: false,
	});
}

function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read one root's coordinate-preserving index. */
function readIndexedCoordinates(
	root: string,
	level: ResolutionLevel,
	tolerant: boolean,
	warn: (line: string) => void,
): ReadIndexResult {
	try {
		if (probeStoreRoot(root) !== 'dir') return { entries: [], complete: true };
		const index = readWorkflowStoreIndex(storeIndexPath(root));
		const entries = Object.entries(index.entries)
			.sort(([a], [b]) => compareStoreText(a, b))
			.map(([coordinate, entry]) => ({
				coordinate: coordinate as WorkflowCoordinate,
				entry,
				root,
				level,
			}));
		return { entries, complete: true };
	} catch (error) {
		if (!tolerant) throw error;
		warn(`warning: incomplete ${level} workflow store at ${root}: ${failureMessage(error)}`);
		return { entries: [], complete: false };
	}
}

/** Load and verify every definition in one immutable object. */
function loadObjectDefs(
	root: string,
	objectDir: string,
	bundleDigest: DefDigest,
	level: ResolutionLevel,
): LoadedObject {
	try {
		verifyWorkflowObjectSync(objectDir, bundleDigest, { coordinateRepair: false });
		const manifest = parseManifestBytes(readFileSync(join(objectDir, 'bundle.yaml')));
		const defs = new Map<string, WorkflowDef>();
		// Sorted, not YAML key order. `defs` is handed to callers as a Map, whose
		// iteration order is this insertion order; nothing downstream currently
		// depends on it (`selectWorkflowRegistrations` re-sorts by qualified name,
		// and `coordinateTarget` reads `keys()` only when there is exactly one), so
		// this is defensive: it keeps a public iteration order from tracking how the
		// manifest author happened to write the file.
		const manifestWorkflows = Object.entries(manifest.workflows)
			.sort(([a], [b]) => compareStoreText(a, b));
		for (const [workflowName, workflowPath] of manifestWorkflows) {
			const def = loadDefFile(join(objectDir, workflowPath));
			if (def.name !== workflowName) {
				throw new Error(
					`workflow '${workflowPath}' has definition name '${def.name}', expected '${workflowName}'`,
				);
			}
			def.bundlePackage = manifest.package.name;
			def.bundleDigest = bundleDigest;
			def.bundleLock = { ...manifest.lock };
			defs.set(def.name, def);
		}
		return { bundleDigest, manifest, defs, level, objectRoot: root };
	} catch (error) {
		if (isRuntimeIncompatible(error)) {
			throw new CasRuntimeIncompatibleError(failureMessage(error));
		}
		if (error instanceof StoreIntegrityError) throw error;
		throw new StoreIntegrityError('object-corrupt', bundleDigest, failureMessage(error));
	}
}

function loadObjectIfPresent(
	root: string,
	digest: DefDigest,
	level: ResolutionLevel,
): LoadedObject | undefined {
	const objectDir = objectDirForDigest(root, digest);
	try {
		return coordinateDigestReadSync(root, digest, () => {
			if (probeObjectDir(objectDir, digest, level) !== 'dir') {
				throw new CasObjectAbsentDuringCoordinatedRead();
			}
			return loadObjectDefs(root, objectDir, digest, level);
		});
	} catch (error) {
		if (error instanceof CasObjectAbsentDuringCoordinatedRead) return undefined;
		if (error instanceof CasRuntimeIncompatibleError || error instanceof StoreIntegrityError) throw error;
		throw new StoreIntegrityError('object-corrupt', digest, failureMessage(error));
	}
}

function resolveObject(
	indexed: IndexedCoordinate,
	globalRoot: string,
	globalDigests: ReadonlySet<DefDigest>,
): LoadedObject {
	const digest = defDigest(indexed.entry.digest);
	const primary = loadObjectIfPresent(indexed.root, digest, indexed.level);
	if (primary !== undefined) return primary;

	// An indexed project object may fall through only to the exact same digest,
	// and only when that digest is also indexed globally. A different global
	// digest for the coordinate is never considered.
	if (indexed.level === 'project' && globalDigests.has(digest)) {
		const fallback = loadObjectIfPresent(globalRoot, digest, 'global');
		if (fallback !== undefined) return fallback;
	}

	throw new StoreIntegrityError(
		'object-missing',
		digest,
		`indexed by ${indexed.level} coordinate '${indexed.coordinate}', but no verified object directory exists`,
	);
}

/** Verify coordinate identity and select the one workflow the coordinate calls. */
function coordinateTarget(indexed: IndexedCoordinate, loaded: LoadedObject): WorkflowDef | undefined {
	const parsed = parseWorkflowCoordinate(indexed.coordinate);
	if (
		parsed.name !== loaded.manifest.package.name
		|| parsed.version !== loaded.manifest.package.version
	) {
		throw new StoreIntegrityError(
			'object-corrupt',
			loaded.bundleDigest,
			`coordinate '${indexed.coordinate}' does not match manifest package ` +
				`'${loaded.manifest.package.name}@${loaded.manifest.package.version}'`,
		);
	}

	const workflowName = loaded.manifest.default
		?? (loaded.defs.size === 1 ? loaded.defs.keys().next().value as string | undefined : undefined);
	if (workflowName === undefined) return undefined;
	const target = loaded.defs.get(workflowName);
	if (target === undefined) {
		throw new StoreIntegrityError(
			'object-corrupt',
			loaded.bundleDigest,
			`coordinate '${indexed.coordinate}' selects missing workflow '${workflowName}'`,
		);
	}
	return target;
}

/**
 * One verified object's offer of one workflow under one `package/workflow` name.
 *
 * The inherited `level` is the level of the INDEX that named this object, which
 * is what decides precedence. `byteLevel` is the separate question of which
 * store the verified bytes were actually read from. The two differ in exactly
 * one supported case: a project-indexed coordinate whose object directory is
 * missing locally falls through to the SAME digest in the global store
 * (`resolveObject`). Such an object is still a project pin — the project index
 * is what names it — so it must compete as `level: 'project'`, while the
 * registration keeps reporting `byteLevel: 'global'` for provenance.
 */
interface WorkflowCandidate extends VersionSelectionCandidate {
	qualified: string;
	def: WorkflowDef;
	packageName: string;
	byteLevel: ResolutionLevel;
}

function candidateRegistration(candidate: WorkflowCandidate, key: string): CasDefRegistration {
	return {
		key,
		qualified: candidate.qualified,
		bare: candidate.def.name,
		def: candidate.def,
		bundleDigest: candidate.digest as DefDigest,
		bundlePackage: candidate.packageName,
		level: candidate.byteLevel,
		kind: 'workflow',
	};
}

/**
 * A verified object that reached registration, paired with the level of the
 * index that named it. One object can be named by several coordinates and by
 * both indexes; `project` always wins that merge, because a project index entry
 * is the operator's pin regardless of what the global index also says.
 */
interface RegisteredObject {
	loaded: LoadedObject;
	indexedLevel: ResolutionLevel;
}

/** `<digest>/<workflow>` — where a version that did not win its name stays reachable. */
function shadowedWorkflowKey(candidate: WorkflowCandidate): string {
	return `${candidate.digest}/${candidate.def.name}`;
}

/**
 * Register every workflow of every verified object, choosing ONE holder per
 * unqualified `package/workflow` name with {@link selectLatestVersion}.
 *
 * This runs AFTER the coordinate walk, not inside it, precisely so the choice
 * cannot depend on which coordinate the walk reached first. Two versions of the
 * same package are competitors to be ranked, never a first-claim and a
 * latecomer.
 *
 * Exact coordinate aliases and digest-scoped aliases are registered by the walk
 * itself and are deliberately NOT affected by anything decided here: a pinned
 * parent and an explicit `pkg/name@version` call keep resolving to their own
 * object whichever version currently holds the unqualified name.
 *
 * Precedence runs on `indexedLevel` — which index named the object — so a
 * project pin still outranks a higher global version even when the project's
 * own object bytes were missing and had to be read from the global store.
 */
function selectWorkflowRegistrations(
	objects: readonly RegisteredObject[],
	warn: (line: string) => void,
	verbose: boolean,
): { registrations: CasDefRegistration[]; suppressedDigests: Set<DefDigest> } {
	const byQualified = new Map<string, WorkflowCandidate[]>();
	const ordered = [...objects].sort(
		(a, b) => compareStoreText(a.loaded.bundleDigest, b.loaded.bundleDigest),
	);
	for (const { loaded, indexedLevel } of ordered) {
		for (const def of loaded.defs.values()) {
			const qualified = `${loaded.manifest.package.name}/${def.name}`;
			const candidate: WorkflowCandidate = {
				qualified,
				def,
				packageName: loaded.manifest.package.name,
				version: loaded.manifest.package.version,
				level: indexedLevel,
				byteLevel: loaded.level,
				digest: loaded.bundleDigest,
			};
			const existing = byQualified.get(qualified);
			if (existing === undefined) byQualified.set(qualified, [candidate]);
			else existing.push(candidate);
		}
	}

	const registrations: CasDefRegistration[] = [];
	const suppressedDigests = new Set<DefDigest>();
	for (const qualified of [...byQualified.keys()].sort(compareStoreText)) {
		const candidates = byQualified.get(qualified) as WorkflowCandidate[];
		const selection = selectLatestVersion(candidates);

		if (selection.kind === 'unorderable') {
			// ONLY the competing versions may be described as non-SemVer. Anything
			// else in `shadowed` lost on level and was never judged on its version —
			// saying otherwise sends the operator to inspect a version string that is
			// perfectly valid.
			const versions = selection.competing.map((candidate) => candidate.version).join(', ');
			const outrankedCount = selection.shadowed.length - selection.competing.length;
			const outrankedNote = outrankedCount === 0
				? ''
				: ` (${outrankedCount} further global-indexed version${outrankedCount === 1 ? '' : 's'} ` +
					`never competed, because a project-indexed version takes precedence)`;
			warn(
				`warning: workflow '${qualified}' has no selectable version — none of the competing ` +
					`versions (${versions}) is canonical SemVer, so the unqualified name is refused rather ` +
					`than resolved by install order${outrankedNote}; call an exact ` +
					`'namespace/name@version' coordinate instead`,
			);
			for (const candidate of selection.shadowed) {
				registrations.push(candidateRegistration(candidate, shadowedWorkflowKey(candidate)));
			}
			continue;
		}

		registrations.push(candidateRegistration(selection.winner, qualified));
		for (const candidate of selection.shadowed) {
			const key = shadowedWorkflowKey(candidate);
			// `-indexed`, because this sentence is about PRECEDENCE, which keys on the
			// index that named the object. The registration's own `level` field
			// reports the different question of which store the bytes came from, and
			// the two legitimately disagree under exact-digest fallback.
			const message =
				`warning: workflow '${qualified}' from ${candidate.level}-indexed bundle ${candidate.digest} ` +
					`(version ${candidate.version}) does not hold that name — ${selection.winner.level}-indexed ` +
					`bundle ${selection.winner.digest} (version ${selection.winner.version}) is the selected ` +
					`version; this copy stays reachable as '${key}'`;
			if (verbose) warn(message);
			else suppressedDigests.add(candidate.digest as DefDigest);
			registrations.push(candidateRegistration(candidate, key));
		}
	}
	return { registrations, suppressedDigests };
}

function discoverCasDefs(args: LoadCasDefsArgs, tolerant: boolean): CasDefInspectionResult {
	const projectRoot = args.projectRoot === undefined ? undefined : projectStoreRoot(args.projectRoot);
	const globalRoot = projectStoreRoot(args.globalRoot);
	const sameRoot = projectRoot === undefined || projectRoot === globalRoot;

	const project = sameRoot
		? { entries: [] as IndexedCoordinate[], complete: true }
		: readIndexedCoordinates(projectRoot, 'project', tolerant, args.warn);
	const global = readIndexedCoordinates(globalRoot, 'global', tolerant, args.warn);
	let complete = project.complete && global.complete;

	const projectCoordinates = new Set(project.entries.map((item) => item.coordinate));
	const selected: Array<IndexedCoordinate & { registerAlias: boolean }> = [
		...project.entries.map((item) => ({ ...item, registerAlias: true })),
		...global.entries
			.filter((item) => !projectCoordinates.has(item.coordinate))
			.map((item) => ({ ...item, registerAlias: true })),
		// A shadowed global coordinate never receives the direct precedence alias, but
		// its workflows and callable coordinate remain digest-scoped for pinned runs.
		...global.entries
			.filter((item) => projectCoordinates.has(item.coordinate))
			.map((item) => ({ ...item, registerAlias: false })),
	];
	const globalDigests = new Set<DefDigest>();
	for (const item of global.entries) globalDigests.add(defDigest(item.entry.digest));

	const registrations: CasDefRegistration[] = [];
	const loadedByDigest = new Map<DefDigest, LoadedObject>();
	const registeredObjects = new Map<DefDigest, RegisteredObject>();
	const registeredCoordinateKeys = new Set<string>();

	for (const indexed of selected) {
		try {
			const digest = defDigest(indexed.entry.digest);
			let loaded = loadedByDigest.get(digest);
			if (loaded === undefined) {
				loaded = resolveObject(indexed, globalRoot, globalDigests);
				loadedByDigest.set(digest, loaded);
			}
			const target = coordinateTarget(indexed, loaded);
			// `indexed.level`, not `loaded.level`: the index that NAMED the object
			// decides precedence, while `loaded.level` only records which store the
			// verified bytes came from. Project wins the merge when both indexes
			// name the same object.
			const alreadyRegistered = registeredObjects.get(loaded.bundleDigest);
			if (alreadyRegistered?.indexedLevel !== 'project') {
				registeredObjects.set(loaded.bundleDigest, { loaded, indexedLevel: indexed.level });
			}
			// Snapshot writers must coordinate with every store root that can affect
			// this digest's discoverability. This includes the index that named it
			// and, for project exact-digest fallback, the global root that supplied
			// its verified bytes.
			for (const def of loaded.defs.values()) {
				setBundleStoreRoots(def, [...new Set([
					...(def.bundleStoreRoots ?? []),
					indexed.root,
					loaded.objectRoot,
				])].sort(compareStoreText));
			}
			if (target === undefined) {
				if (indexed.registerAlias) {
					args.warn(
						`warning: coordinate '${indexed.coordinate}' is not callable because the bundle exports ` +
							`multiple workflows and has no default; use an explicit package/workflow target`,
					);
				}
				continue;
			}

			// Every callable coordinate gets a digest-scoped alias, including a
			// shadowed global coordinate. A running parent can therefore follow its
			// lock digest without changing the direct project's precedence alias.
			const coordinateKeys = [
				digestScopedCallsTargetKey(digest, indexed.coordinate),
				...(indexed.registerAlias ? [indexed.coordinate] : []),
			];
			for (const key of coordinateKeys) {
				if (registeredCoordinateKeys.has(key)) continue;
				registeredCoordinateKeys.add(key);
				registrations.push({
					key,
					qualified: `${loaded.manifest.package.name}/${target.name}`,
					bare: target.name,
					def: target,
					bundleDigest: digest,
					bundlePackage: loaded.manifest.package.name,
					level: loaded.level,
					kind: 'coordinate',
					coordinate: indexed.coordinate,
				});
			}
		} catch (error) {
			if (error instanceof CasRuntimeIncompatibleError) {
				complete = false;
				args.warn(`warning: skipping ${indexed.level} workflow object ${indexed.entry.digest}: ${error.message}`);
				continue;
			}
			if (!tolerant) throw error;
			complete = false;
			args.warn(
				`warning: incomplete ${indexed.level} workflow coordinate '${indexed.coordinate}': ${failureMessage(error)}`,
			);
		}
	}

	const selectedWorkflows = selectWorkflowRegistrations(
		[...registeredObjects.values()],
		args.warn,
		args.verbose === true,
	);
	registrations.push(...selectedWorkflows.registrations);
	if (args.verbose !== true && selectedWorkflows.suppressedDigests.size > 0) {
		const count = selectedWorkflows.suppressedDigests.size;
		args.warn(`note: ${count} superseded bundle ${count === 1 ? 'version' : 'versions'} hidden; --verbose to list them`);
	}
	return { registrations, complete };
}

/** Strict executable discovery. Any indexed integrity failure aborts. */
export function loadCasDefs(args: LoadCasDefsArgs): CasDefRegistration[] {
	return discoverCasDefs(args, false).registrations;
}

/** Tolerant read-only inspection. Never use this result for execution. */
export function inspectCasDefs(args: LoadCasDefsArgs): CasDefInspectionResult {
	return discoverCasDefs(args, true);
}
