// Generic cross-process lock with a one-way mixed-version boundary.
//
// New clients hold a SQLite `BEGIN IMMEDIATE` transaction on the versioned
// database at `<lockPath>.sqlite-v2`. The logical legacy pathname remains a
// parseable JSON guard. Its deliberately impossible hostname makes pre-SQLite
// clients treat the guard as foreign-host-owned and therefore never reclaim it.
// Once a new client installs that guard, old clients fail closed and must be
// upgraded; new clients continue to serialize through SQLite.
//
// The guard is permanent. Release and crash cleanup affect only the SQLite
// transaction, so no compare/read/delete pathname race exists. A pre-existing
// old JSON owner is allowed to release normally before the guard is installed.
// A corrupt file or a pre-boundary SQLite database at the legacy pathname is
// never removed automatically: the operator must first verify that no old or
// pre-boundary process owns it, then remove that legacy pathname manually.

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 100;
const LOCK_SYNC_SLEEP = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const COMPATIBILITY_GUARD_FORMAT = 'owenloop-sqlite-lock-v2';
// A slash cannot occur in an operating-system hostname. Old clients compare
// this field before probing the pid and therefore hold the guard forever.
const COMPATIBILITY_GUARD_HOST = 'owenloop/sqlite-lock/v2';

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
  format?: string;
}

export interface AcquireFileLockOpts {
  /** Max time to wait for the SQLite writer lock or legacy owner. */
  waitMs?: number;
  /** Retained for source compatibility. New clients never age-reclaim pathnames. */
  staleMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
  /** Retained for source compatibility. New clients never reclaim by pid. */
  isPidAlive?: (pid: number) => boolean;
  /** Wall clock used only for diagnostic timestamps. */
  now?: () => number;
  /** Current hostname used in diagnostic metadata. */
  hostname?: () => string;
  /** Names the holder in timeout text. */
  label?: string;
  /** Test barrier immediately before opening the versioned SQLite database. */
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

function databasePath(lockPath: string): string {
  return `${lockPath}.sqlite-v2`;
}

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
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as LockHolder
      : null;
  } catch {
    return null;
  }
}

function isCompatibilityGuard(raw: string | null): boolean {
  const holder = parseHolder(raw);
  return holder?.format === COMPATIBILITY_GUARD_FORMAT && holder.host === COMPATIBILITY_GUARD_HOST;
}

function readDiagnosticHolder(lockPath: string): LockHolder | null {
  return parseHolder(readRaw(ownerPath(lockPath)));
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

/**
 * Install the permanent old-client guard with one exclusive create. A crash or
 * write failure may leave a partial guard, which is intentionally fail-closed
 * and requires verified manual cleanup; this function never unlinks a pathname.
 */
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dirname(path), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureCompatibilityGuard(lockPath: string, now: () => number): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return isCompatibilityGuard(readRaw(lockPath));
  }

  let failure: unknown;
  try {
    writeFileSync(fd, JSON.stringify({
      format: COMPATIBILITY_GUARD_FORMAT,
      host: COMPATIBILITY_GUARD_HOST,
      startedAt: now(),
    }));
    fsyncSync(fd);
  } catch (error) {
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;
  syncDirectory(lockPath);
  return true;
}

function openLockDatabase(lockPath: string): DatabaseSync {
  const db = new DatabaseSync(databasePath(lockPath));
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
    ? '; found an old, corrupt, or pre-boundary lock pathname that Owenloop will not delete automatically — verify that no old process owns it, then remove it manually'
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
    let db: DatabaseSync | undefined;
    try {
      opts.beforeOpen?.();
      db = openLockDatabase(lockPath);
      beginLock(db);
      if (!ensureCompatibilityGuard(lockPath, now)) {
	closeAfterFailure(db);
	db = undefined;
	const holder = legacyHolder(lockPath);
	if (performance.now() >= deadline) throw timeoutError(lockPath, holder, waitMs, label, true);
	await sleep(pollMs);
	continue;
      }
      return makeHandle(lockPath, db, now, currentHost);
    } catch (error) {
      closeAfterFailure(db);
      if (error instanceof FileLockTimeoutError) throw error;
      if (!isBusy(error)) throw error;
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
    let db: DatabaseSync | undefined;
    try {
      opts.beforeOpen?.();
      db = openLockDatabase(lockPath);
      beginLock(db);
      if (!ensureCompatibilityGuard(lockPath, now)) {
	closeAfterFailure(db);
	db = undefined;
	const holder = legacyHolder(lockPath);
	if (performance.now() >= deadline) throw timeoutError(lockPath, holder, waitMs, label, true);
	Atomics.wait(LOCK_SYNC_SLEEP, 0, 0, pollMs);
	continue;
      }
      return makeHandle(lockPath, db, now, currentHost);
    } catch (error) {
      closeAfterFailure(db);
      if (error instanceof FileLockTimeoutError) throw error;
      if (!isBusy(error)) throw error;
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
 * Release only the versioned SQLite transaction. The permanent compatibility
 * guard is never deleted, renamed, or replaced.
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
