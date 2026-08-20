/**
 * Crash recovery for GC object parking.
 *
 * APFS refuses to rename a hardened 0555 directory, so GC must briefly add
 * owner-write to the object root before moving it out of the canonical CAS
 * path. The journal below makes that otherwise-dangerous interval recoverable
 * by every writer that shares the workflow-store lock. The pruned index is the
 * durable commit point: recovery restores a parked object when the current
 * index still names it, and treats it as staging debris only when the current
 * index corroborates that the digest is no longer reachable by coordinate.
 */

import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	fsyncSync,
	lstatSync,
	openSync,
	rmSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	guardStateFile,
	lockfilePathViolation,
	probeDirectoryPath,
	readRegularFileNoFollow,
	renameDirRestoringWrite,
	rmRecursiveForce,
	STAGING_DIRNAME,
	writeJsonAtomic,
} from '../install.ts';
import { readWorkflowStoreIndex } from './index-file.ts';
import { verifyWorkflowObjectSync } from './ingestor.ts';
import { storeIndexPath } from './resolve.ts';
import { compareStoreText, defDigest, objectDirForDigest } from './types.ts';
import type { DefDigest } from './types.ts';

export const WORKFLOW_STORE_GC_JOURNAL_FILENAME = 'gc.journal';

interface WorkflowStoreGcJournal {
	version: 1;
	digest: DefDigest;
	parkedName: string;
	originalMode: number;
}

export interface WorkflowStoreGcRecoveryArgs {
	root: string;
	stateDir: string;
}

export interface ParkWorkflowStoreGcObjectArgs extends WorkflowStoreGcRecoveryArgs {
	digest: DefDigest;
	parkedName: string;
	afterLiveObjectMadeWritable?: (path: string) => void;
	afterObjectParked?: (path: string) => void;
}

export interface RemoveParkedWorkflowStoreGcObjectArgs extends WorkflowStoreGcRecoveryArgs {
	parked: string;
	remove?: (path: string) => void;
}

export function workflowStoreGcJournalPath(stateDir: string): string {
	return join(stateDir, WORKFLOW_STORE_GC_JOURNAL_FILENAME);
}

function fsyncPath(path: string): void {
	const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Persist a directory-entry transition, not merely the moved directory inode. */
export function fsyncWorkflowStoreDirectory(path: string): void {
	const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** Make an atomic metadata write durable before a destructive follow-on step. */
export function fsyncWorkflowStoreFileAndParent(path: string): void {
	fsyncPath(path);
	fsyncWorkflowStoreDirectory(dirname(path));
}

function corruptGcJournal(path: string, detail: string): Error {
	return new Error(
		`invalid workflow-store GC journal at ${path}: ${detail} — ` +
			'inspect the target store and remove the journal manually before retrying',
	);
}

function readGcJournal(path: string): WorkflowStoreGcJournal | undefined {
	const bytes = readRegularFileNoFollow(path, 'workflow-store GC journal');
	if (bytes === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
	} catch (error) {
		throw corruptGcJournal(path, `invalid JSON: ${(error as Error).message}`);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw corruptGcJournal(path, 'expected an object');
	}
	const raw = parsed as Record<string, unknown>;
	const keys = Object.keys(raw).sort(compareStoreText);
	const expectedKeys = ['digest', 'originalMode', 'parkedName', 'version'];
	if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
		throw corruptGcJournal(path, `unexpected fields ${JSON.stringify(keys)}`);
	}
	if (raw.version !== 1) throw corruptGcJournal(path, `unsupported version ${JSON.stringify(raw.version)}`);
	if (typeof raw.digest !== 'string') throw corruptGcJournal(path, 'digest must be a string');
	let digest: DefDigest;
	try {
		digest = defDigest(raw.digest);
	} catch (error) {
		throw corruptGcJournal(path, (error as Error).message);
	}
	if (typeof raw.parkedName !== 'string' || lockfilePathViolation(raw.parkedName) !== undefined) {
		throw corruptGcJournal(path, 'parkedName is not a safe path segment');
	}
	if (!new RegExp(`^gc-${digest}-park_[0-9a-f]{24}$`, 'u').test(raw.parkedName)) {
		throw corruptGcJournal(path, 'parkedName does not match the recorded digest and GC transaction shape');
	}
	if (raw.originalMode !== 0o555) {
		throw corruptGcJournal(path, `originalMode must be the hardened object mode 0555, got ${String(raw.originalMode)}`);
	}
	return { version: 1, digest, parkedName: raw.parkedName, originalMode: raw.originalMode };
}

function writeGcJournal(path: string, journal: WorkflowStoreGcJournal): void {
	guardStateFile(path, 'workflow-store GC journal');
	writeJsonAtomic(path, journal);
	// Stable evidence must precede the temporary live-object chmod.
	fsyncWorkflowStoreFileAndParent(path);
}

function removeGcJournal(path: string, stateDir: string): void {
	guardStateFile(path, 'workflow-store GC journal');
	rmSync(path, { force: true });
	// Persist the unlink before staging cleanup. A crash can then only leak safe,
	// unindexed staging debris; it cannot resurrect evidence for missing bytes.
	fsyncWorkflowStoreDirectory(stateDir);
}

function transactionPaths(root: string, journal: WorkflowStoreGcJournal): {
	live: string;
	parked: string;
	stagingRoot: string;
} {
	const stagingRoot = join(root, STAGING_DIRNAME);
	return {
		live: objectDirForDigest(root, journal.digest),
		parked: join(stagingRoot, journal.parkedName),
		stagingRoot,
	};
}

function realDirectoryState(path: string, label: string, boundary: string): Stats | undefined {
	const state = probeDirectoryPath(path, label, boundary);
	if (state === 'absent') return undefined;
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`${label} '${path}' is not a real directory`);
	}
	return stat;
}

function restoreAndVerify(path: string, journal: WorkflowStoreGcJournal): void {
	const mode = lstatSync(path).mode & 0o7777;
	const temporaryMode = journal.originalMode | 0o200;
	if (mode !== journal.originalMode && mode !== temporaryMode) {
		throw new Error(
			`transaction object '${path}' has contradictory mode ${mode.toString(8)} ` +
				`(expected ${journal.originalMode.toString(8)} or ${temporaryMode.toString(8)})`,
		);
	}
	if (mode !== journal.originalMode) chmodSync(path, journal.originalMode);
	fsyncPath(path);
	verifyWorkflowObjectSync(path, journal.digest, { coordinateRepair: false });
}

/**
 * Recover one interrupted GC park while the caller holds this root's add lock.
 * Returns true when journal evidence was present.
 */
export function recoverInterruptedWorkflowStoreGc(args: WorkflowStoreGcRecoveryArgs): boolean {
	const journalPath = workflowStoreGcJournalPath(args.stateDir);
	const journal = readGcJournal(journalPath);
	if (journal === undefined) return false;
	const { live, parked, stagingRoot } = transactionPaths(args.root, journal);
	const liveState = realDirectoryState(live, 'workflow-store GC live object', args.root);
	const stagingState = probeDirectoryPath(stagingRoot, 'workflow store staging directory', args.root);
	const parkedState = stagingState === 'dir'
		? realDirectoryState(parked, 'workflow-store GC parked object', stagingRoot)
		: undefined;
	const index = readWorkflowStoreIndex(storeIndexPath(args.root));
	const indexed = Object.values(index.entries).some((entry) => entry.digest === journal.digest);
	if (liveState !== undefined && parkedState !== undefined) {
		throw corruptGcJournal(journalPath, 'both the live and parked object paths exist');
	}
	if (liveState === undefined && parkedState === undefined) {
		if (indexed) {
			throw corruptGcJournal(journalPath, 'neither the live nor parked object path exists for an indexed digest');
		}
		// Deletion and its staging-directory fsync completed, but the process
		// stopped before unlinking the journal. The index corroborates that no
		// live bytes are owed, so finish the durable cleanup.
		fsyncWorkflowStoreDirectory(stagingState === 'dir' ? stagingRoot : args.root);
		removeGcJournal(journalPath, args.stateDir);
		return true;
	}
	if (liveState !== undefined) {
		// The interruption preceded (or the filesystem rolled back) the rename.
		// Whether indexed or orphaned, the canonical path must not remain writable.
		restoreAndVerify(live, journal);
		fsyncWorkflowStoreDirectory(dirname(live));
		removeGcJournal(journalPath, args.stateDir);
		return true;
	}

	if (indexed) {
		// The index is authoritative: parked bytes are still live state, so restore
		// them before any shared-staging cleanup can discard them.
		restoreAndVerify(parked, journal);
		renameDirRestoringWrite(parked, live, journal.originalMode);
		fsyncPath(live);
		fsyncWorkflowStoreDirectory(stagingRoot);
		fsyncWorkflowStoreDirectory(dirname(live));
		verifyWorkflowObjectSync(live, journal.digest, { coordinateRepair: false });
	} else {
		// The journal authenticates this contained parked path, and the committed
		// index proves it is doomed. A prior deletion attempt may already have
		// removed files or made directories writable, so never require the debris
		// to remain a complete, hardened bundle before retrying its removal.
		rmRecursiveForce(parked);
		fsyncWorkflowStoreDirectory(stagingRoot);
	}
	removeGcJournal(journalPath, args.stateDir);
	return true;
}

/**
 * Park one already-unindexed object under durable recovery evidence. The
 * caller holds the root lock and must pass the returned path to
 * removeParkedWorkflowStoreGcObject(). The journal remains durable until that
 * path and its staging-directory entry have been removed successfully.
 */
export function parkWorkflowStoreGcObject(args: ParkWorkflowStoreGcObjectArgs): string {
	if (lockfilePathViolation(args.parkedName) !== undefined) {
		throw new Error(`refusing unsafe workflow-store GC parked name '${args.parkedName}'`);
	}
	const journal: WorkflowStoreGcJournal = {
		version: 1,
		digest: args.digest,
		parkedName: args.parkedName,
		originalMode: 0o555,
	};
	if (!new RegExp(`^gc-${args.digest}-park_[0-9a-f]{24}$`, 'u').test(args.parkedName)) {
		throw new Error(`refusing malformed workflow-store GC parked name '${args.parkedName}'`);
	}
	const { live, parked, stagingRoot } = transactionPaths(args.root, journal);
	const liveState = realDirectoryState(live, 'workflow-store GC live object', args.root);
	if (liveState === undefined) {
		throw new Error(`refusing to park workflow-store object '${live}': it disappeared`);
	}
	const originalMode = liveState.mode & 0o7777;
	if (originalMode !== journal.originalMode) {
		throw new Error(`refusing to park workflow-store object '${live}': expected hardened mode 0555`);
	}
	if (lstatSync(parked, { throwIfNoEntry: false }) !== undefined) {
		throw new Error(`refusing to park workflow-store object: destination '${parked}' already exists`);
	}
	verifyWorkflowObjectSync(live, args.digest, { coordinateRepair: false });

	const journalPath = workflowStoreGcJournalPath(args.stateDir);
	writeGcJournal(journalPath, journal);
	chmodSync(live, originalMode | 0o200);
	args.afterLiveObjectMadeWritable?.(live);
	renameDirRestoringWrite(live, parked, originalMode);
	fsyncPath(parked);
	// The rename is not durable until BOTH directory entries are stable. Keep the
	// journal until source disappearance and destination appearance are fsynced.
	fsyncWorkflowStoreDirectory(dirname(live));
	fsyncWorkflowStoreDirectory(stagingRoot);
	args.afterObjectParked?.(parked);
	return parked;
}

/** Remove one journal-authenticated parked object and only then clear evidence. */
export function removeParkedWorkflowStoreGcObject(
	args: RemoveParkedWorkflowStoreGcObjectArgs,
): void {
	const journalPath = workflowStoreGcJournalPath(args.stateDir);
	const journal = readGcJournal(journalPath);
	if (journal === undefined) {
		throw new Error(`refusing workflow-store GC parked cleanup '${args.parked}': journal is missing`);
	}
	const { parked, stagingRoot } = transactionPaths(args.root, journal);
	if (args.parked !== parked) {
		throw new Error(
			`refusing workflow-store GC parked cleanup '${args.parked}': journal authenticates '${parked}'`,
		);
	}
	(args.remove ?? rmRecursiveForce)(parked);
	if (lstatSync(parked, { throwIfNoEntry: false }) !== undefined) {
		throw new Error(`workflow-store GC parked cleanup '${parked}' returned without removing the path`);
	}
	fsyncWorkflowStoreDirectory(stagingRoot);
	removeGcJournal(journalPath, args.stateDir);
}
