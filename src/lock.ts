/**
 * Generic cross-process file lock.
 *
 * The lock is a SQLite `BEGIN IMMEDIATE` transaction held on `lockPath`. SQLite
 * owns the operating-system file lock and ties that lock to the open
 * `DatabaseSync` connection. Closing the connection, normal process exit, or a
 * process crash releases the lock without deleting or replacing the path.
 *
 * The previous exclusive-create lockfile design had no atomic compare-and-unlink
 * operation: a stale reclaimer or releaser could inspect one pathname object and
 * then delete a fresh replacement. This implementation never unlinks the lock
 * database. A small `.owner.json` sidecar is diagnostics only and is never an
 * ownership primitive.
 *
 * Compatibility tradeoff: a non-empty pre-SQLite lockfile is treated as a
 * conservative legacy lock and is never automatically deleted. The holder may
 * still be live, and the available portable path APIs cannot prove and remove
 * that exact object atomically. Wait for the old process to release it, or remove
 * the legacy file manually after verifying that no old Owenloop process owns it.
 * Once a lock has been acquired by this implementation, crash cleanup is again
 * automatic because SQLite releases the kernel lock with the connection.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 100;
const LOCK_SYNC_SLEEP = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8');

export interface FileLockHandle {
  lockPath: string;
  acquired: boolean;
  /** Per-acquisition diagnostic identity. SQLite, not this token, owns exclusion. */
  token?: string;
}

interface LockHolder {
  pid?: number;
  startedAt?: number;
  token?: string;
  host?: string;
  active?: boolean;
  releasedAt?: number;
}

export interface AcquireFileLockOpts {
  /** Max time to wait for the SQLite writer lock before failing cleanly. */
  waitMs?: number;
  /** Retained for source compatibility. SQLite crash release needs no stale age. */
  staleMs?: number;
  /** Poll interval while waiting on the writer lock. */
  pollMs?: number;
  /** Retained for source compatibility with legacy-lock diagnostics. */
  isPidAlive?: (pid: number) => boolean;
  /** Wall clock used only for diagnostic timestamps. */
  now?: () => number;
  /** Current hostname used in diagnostic metadata. */
  hostname?: () => string;
  /** Names the holder in timeout text. */
  label?: string;
  /** Test barrier after candidate inspection and before opening the database. */
  beforeOpen?: () => void;
}

export class FileLockTimeoutError extends Error {
  readonly lockPath: string;
  readonly holderPid: number | undefined;
  readonly waitMs: number;
  readonly legacy: boolean;
  constructor(
    message: string,
    lockPath: string,
    holderPid: number | undefined,
    waitMs: number,
    legacy = false,
  ) {
    super(message);
    this.name = 'FileLockTimeoutError';
    this.lockPath = lockPath;
    this.holderPid = holderPid;
    this.waitMs = waitMs;
    this.legacy = legacy;
  }
}

/** Connections are deliberately private so callers cannot commit the lock transaction. */
const heldConnections = new WeakMap<FileLockHandle, DatabaseSync>();

function ownerPath(lockPath: string): string {
  return `${lockPath}.owner.json`;
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseHolder(raw: string | null): LockHolder | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as LockHolder;
  } catch {
    return null;
  }
}

function readDiagnosticHolder(lockPath: string): LockHolder | null {
  return parseHolder(readRaw(ownerPath(lockPath)));
}

/**
 * Missing and empty paths are valid SQLite candidates. A zero-byte database is
 * what remains when a first owner crashes before the initial transaction commits.
 */
function isSqliteCandidate(lockPath: string): boolean {
  let size: number;
  try {
    size = statSync(lockPath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (size === 0) return true;
  let fd: number;
  try {
    fd = openSync(lockPath, 'r');
  } catch (error) {
    // A legacy exclusive-create owner can unlink its path between the stat and
    // open. Treat that disappearance like the missing-path case and let SQLite
    // perform the atomic open/lock attempt; other filesystem refusals stay loud.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    return bytesRead === SQLITE_HEADER.length && header.equals(SQLITE_HEADER);
  } finally {
    closeSync(fd);
  }
}

function legacyHolder(lockPath: string): LockHolder | null {
  return parseHolder(readRaw(lockPath));
}

function writeDiagnosticHolder(lockPath: string, holder: LockHolder): void {
  const path = ownerPath(lockPath);
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(holder));
  renameSync(tmp, path);
}

function openLockDatabase(lockPath: string): DatabaseSync {
  const db = new DatabaseSync(lockPath);
  db.exec('PRAGMA busy_timeout = 0');
  return db;
}

function isBusy(error: unknown): boolean {
  const candidate = error as { errcode?: number; message?: string };
  return candidate.errcode === 5 || /database is (?:locked|busy)/iu.test(candidate.message ?? '');
}

function beginLock(db: DatabaseSync): void {
  db.exec(
    'BEGIN IMMEDIATE;\n' +
    'CREATE TABLE IF NOT EXISTS __owenloop_lock_format (id INTEGER PRIMARY KEY CHECK (id = 1));\n' +
    'INSERT OR IGNORE INTO __owenloop_lock_format (id) VALUES (1);',
  );
}

function closeAfterFailure(db: DatabaseSync | undefined): void {
  if (db === undefined) return;
  try {
    db.exec('ROLLBACK');
  } catch {
    // No transaction began, or SQLite already rolled it back.
  }
  try {
    db.close();
  } catch {
    // Preserve the acquisition error.
  }
}

function makeHandle(
  lockPath: string,
  db: DatabaseSync,
  now: () => number,
  currentHost: string,
): FileLockHandle {
  const token = randomBytes(16).toString('hex');
  const holder: LockHolder = {
    pid: process.pid,
    startedAt: now(),
    token,
    host: currentHost,
    active: true,
  };
  try {
    writeDiagnosticHolder(lockPath, holder);
  } catch (error) {
    closeAfterFailure(db);
    throw error;
  }
  const handle: FileLockHandle = { lockPath, acquired: true, token };
  heldConnections.set(handle, db);
  return handle;
}

function timeoutError(
  lockPath: string,
  holder: LockHolder | null,
  waitMs: number,
  label: string,
  legacy: boolean,
): FileLockTimeoutError {
  const suffix = legacy
    ? '; found a legacy lockfile that Owenloop will not delete automatically — verify that no old process owns it, then remove it manually'
    : '';
  return new FileLockTimeoutError(
    `${inProgressMessage(lockPath, holder, waitMs, label)}${suffix}`,
    lockPath,
    typeof holder?.pid === 'number' ? holder.pid : undefined,
    waitMs,
    legacy,
  );
}

export async function acquireFileLock(
  lockPath: string,
  opts: AcquireFileLockOpts = {},
): Promise<FileLockHandle> {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const pollMs = opts.pollMs ?? LOCK_POLL_MS;
  const now = opts.now ?? Date.now;
  const currentHost = (opts.hostname ?? hostname)();
  const label = opts.label ?? 'owenloop process';
  const deadline = performance.now() + waitMs;

  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    if (!isSqliteCandidate(lockPath)) {
      const holder = legacyHolder(lockPath);
      if (performance.now() >= deadline) throw timeoutError(lockPath, holder, waitMs, label, true);
      await sleep(pollMs);
      continue;
    }

    let db: DatabaseSync | undefined;
    try {
      opts.beforeOpen?.();
      db = openLockDatabase(lockPath);
      beginLock(db);
      return makeHandle(lockPath, db, now, currentHost);
    } catch (error) {
      closeAfterFailure(db);
      if (!isBusy(error)) {
	// A pathname replacement can turn a previously valid candidate into a
	// legacy object. Refuse conservatively instead of deleting either object.
	if (!isSqliteCandidate(lockPath)) {
	  const holder = legacyHolder(lockPath);
	  if (performance.now() >= deadline) throw timeoutError(lockPath, holder, waitMs, label, true);
	  await sleep(pollMs);
	  continue;
	}
	throw error;
      }
    }

    const holder = readDiagnosticHolder(lockPath);
    if (performance.now() >= deadline) throw timeoutError(lockPath, holder, waitMs, label, false);
    await sleep(pollMs);
  }
}

export function acquireFileLockSync(
  lockPath: string,
  opts: AcquireFileLockOpts = {},
): FileLockHandle {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const pollMs = opts.pollMs ?? LOCK_POLL_MS;
  const now = opts.now ?? Date.now;
  const currentHost = (opts.hostname ?? hostname)();
  const label = opts.label ?? 'owenloop process';
  const deadline = performance.now() + waitMs;

  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    if (!isSqliteCandidate(lockPath)) {
      const holder = legacyHolder(lockPath);
      if (performance.now() >= deadline) throw timeoutError(lockPath, holder, waitMs, label, true);
      Atomics.wait(LOCK_SYNC_SLEEP, 0, 0, pollMs);
      continue;
    }

    let db: DatabaseSync | undefined;
    try {
      opts.beforeOpen?.();
      db = openLockDatabase(lockPath);
      beginLock(db);
      return makeHandle(lockPath, db, now, currentHost);
    } catch (error) {
      closeAfterFailure(db);
      if (!isBusy(error)) {
	if (!isSqliteCandidate(lockPath)) {
	  const holder = legacyHolder(lockPath);
	  if (performance.now() >= deadline) throw timeoutError(lockPath, holder, waitMs, label, true);
	  Atomics.wait(LOCK_SYNC_SLEEP, 0, 0, pollMs);
	  continue;
	}
	throw error;
      }
    }

    const holder = readDiagnosticHolder(lockPath);
    if (performance.now() >= deadline) throw timeoutError(lockPath, holder, waitMs, label, false);
    Atomics.wait(LOCK_SYNC_SLEEP, 0, 0, pollMs);
  }
}

function inProgressMessage(lockPath: string, holder: LockHolder | null, waitMs: number, label: string): string {
  const who = typeof holder?.pid === 'number' ? `pid ${holder.pid}` : 'another process';
  const heldSince =
    typeof holder?.startedAt === 'number' &&
    Number.isFinite(holder.startedAt) &&
    Math.abs(holder.startedAt) <= 8.64e15
      ? `, held since ${new Date(holder.startedAt).toISOString()}`
      : '';
  const seconds = Math.round(waitMs / 1000);
  return `another ${label} is in progress (${who}${heldSince}) — holds ${lockPath}; timed out waiting after ${seconds}s`;
}

/**
 * Release exactly the SQLite transaction held by this handle. No pathname is
 * deleted, renamed, or replaced, so release cannot remove a later owner.
 */
export function releaseFileLock(handle: FileLockHandle): void {
  if (!handle.acquired) return;
  const db = heldConnections.get(handle);
  if (db === undefined) return;

  try {
    try {
      writeDiagnosticHolder(handle.lockPath, {
	pid: process.pid,
	token: handle.token,
	host: hostname(),
	active: false,
	releasedAt: Date.now(),
      });
    } catch {
      // Diagnostics never outrank releasing the kernel lock.
    }
    try {
      db.exec('COMMIT');
    } catch {
      try {
	db.exec('ROLLBACK');
      } catch {
	// Closing the connection still releases the operating-system lock.
      }
    }
  } finally {
    heldConnections.delete(handle);
    try {
      db.close();
    } catch {
      // Release is called from finally blocks and must not mask the real error.
    }
  }
}
