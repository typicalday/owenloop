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
import { loadDefFile } from '../defs.ts';
import type { WorkflowDef } from '../types.ts';
import { readWorkflowStoreIndex } from './index-file.ts';
import { verifyWorkflowObjectSync } from './ingestor.ts';
import { probeObjectDir, probeStoreRoot, projectStoreRoot, storeIndexPath } from './resolve.ts';
import {
	defDigest,
	objectDirForDigest,
	parseWorkflowCoordinate,
	StoreIntegrityError,
} from './types.ts';
import type {
	DefDigest,
	ResolutionLevel,
	WorkflowCoordinate,
	WorkflowStoreIndexEntry,
} from './types.ts';

/** One workflow or coordinate alias from one verified CAS bundle. */
export interface CasDefRegistration {
	/** Flat-map key: package/workflow, digest/workflow, or namespace/name@version. */
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
}

/** Explicitly partial result for read-only inspection. */
export interface CasDefInspectionResult {
	registrations: CasDefRegistration[];
	/** False when any store root, index, object, or coordinate was skipped. */
	complete: boolean;
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
}

interface ReadIndexResult {
	entries: IndexedCoordinate[];
	complete: boolean;
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
			.sort(([a], [b]) => a.localeCompare(b))
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
	objectDir: string,
	bundleDigest: DefDigest,
	level: ResolutionLevel,
): LoadedObject {
	try {
		verifyWorkflowObjectSync(objectDir, bundleDigest);
		const manifest = parseManifestBytes(readFileSync(join(objectDir, 'bundle.yaml')));
		const defs = new Map<string, WorkflowDef>();
		for (const [workflowName, workflowPath] of Object.entries(manifest.workflows)) {
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
		return { bundleDigest, manifest, defs, level };
	} catch (error) {
		if (error instanceof StoreIntegrityError) throw error;
		throw new StoreIntegrityError('object-corrupt', bundleDigest, failureMessage(error));
	}
}

function resolveObject(
	indexed: IndexedCoordinate,
	globalRoot: string,
	globalDigests: ReadonlySet<DefDigest>,
): LoadedObject {
	const digest = defDigest(indexed.entry.digest);
	const primaryDir = objectDirForDigest(indexed.root, digest);
	let primaryProbe: 'dir' | 'absent';
	try {
		primaryProbe = probeObjectDir(primaryDir, digest, indexed.level);
	} catch (error) {
		throw new StoreIntegrityError('object-corrupt', digest, failureMessage(error));
	}
	if (primaryProbe === 'dir') return loadObjectDefs(primaryDir, digest, indexed.level);

	// An indexed project object may fall through only to the exact same digest,
	// and only when that digest is also indexed globally. A different global
	// digest for the coordinate is never considered.
	if (indexed.level === 'project' && globalDigests.has(digest)) {
		const fallbackDir = objectDirForDigest(globalRoot, digest);
		let fallbackProbe: 'dir' | 'absent';
		try {
			fallbackProbe = probeObjectDir(fallbackDir, digest, 'global');
		} catch (error) {
			throw new StoreIntegrityError('object-corrupt', digest, failureMessage(error));
		}
		if (fallbackProbe === 'dir') return loadObjectDefs(fallbackDir, digest, 'global');
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
		// A shadowed global coordinate never receives the full-coordinate alias, but
		// its workflows remain digest-scoped for already-running pinned instances.
		...global.entries
			.filter((item) => projectCoordinates.has(item.coordinate))
			.map((item) => ({ ...item, registerAlias: false })),
	];
	const globalDigests = new Set<DefDigest>();
	for (const item of global.entries) globalDigests.add(defDigest(item.entry.digest));

	const registrations: CasDefRegistration[] = [];
	const loadedByDigest = new Map<DefDigest, LoadedObject>();
	const registeredDigests = new Set<DefDigest>();
	const byQualified = new Map<string, CasDefRegistration>();

	const registerObjectWorkflows = (loaded: LoadedObject): void => {
		if (registeredDigests.has(loaded.bundleDigest)) return;
		registeredDigests.add(loaded.bundleDigest);
		for (const def of loaded.defs.values()) {
			const qualified = `${loaded.manifest.package.name}/${def.name}`;
			const winner = byQualified.get(qualified);
			const key = winner === undefined ? qualified : `${loaded.bundleDigest}/${def.name}`;
			if (winner !== undefined) {
				args.warn(
					`warning: workflow '${qualified}' from ${loaded.level} bundle ${loaded.bundleDigest} ` +
						`does not hold that name — ${winner.level} bundle ${winner.bundleDigest} claimed it first; ` +
						`this copy stays reachable as '${key}'`,
				);
			}
			const registration: CasDefRegistration = {
				key,
				qualified,
				bare: def.name,
				def,
				bundleDigest: loaded.bundleDigest,
				bundlePackage: loaded.manifest.package.name,
				level: loaded.level,
				kind: 'workflow',
			};
			if (winner === undefined) byQualified.set(qualified, registration);
			registrations.push(registration);
		}
	};

	for (const indexed of selected) {
		try {
			const digest = defDigest(indexed.entry.digest);
			let loaded = loadedByDigest.get(digest);
			if (loaded === undefined) {
				loaded = resolveObject(indexed, globalRoot, globalDigests);
				loadedByDigest.set(digest, loaded);
			}
			const target = coordinateTarget(indexed, loaded);
			registerObjectWorkflows(loaded);
			if (indexed.registerAlias && target === undefined) {
				args.warn(
					`warning: coordinate '${indexed.coordinate}' is not callable because the bundle exports ` +
						`multiple workflows and has no default; use an explicit package/workflow target`,
				);
				continue;
			}
			if (indexed.registerAlias && target !== undefined) {
				registrations.push({
					key: indexed.coordinate,
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
			if (!tolerant) throw error;
			complete = false;
			args.warn(
				`warning: incomplete ${indexed.level} workflow coordinate '${indexed.coordinate}': ${failureMessage(error)}`,
			);
		}
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
