/**
 * Generic advisory FILE LOCK — an exclusive-create lockfile with liveness-aware
 * staleness, used to serialize a filesystem critical section across owenloop
 * processes.
 *
 * Extracted verbatim (logic-identical) from `src/add.ts`'s per-project install
 * lock: `add.ts` now consumes it through thin `acquireInstallLock` /
 * `releaseInstallLock` wrappers that preserve the old names, types, and the
 * "owenloop add" timeout wording; `src/credentials.ts` uses it to serialize the
 * OAuth refresh-and-persist critical section (`credentials.lock`). The only
 * behavioral addition during the move is the optional `label` (used in the
 * timeout message) so each caller names itself.
 *
 * Depends only on node builtins so the library barrel (`src/index.ts` →
 * `credentials.ts` → here) never drags the `add`/`untar` graph into its runtime
 * closure.
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

/** Default wait/stale/poll timings for a file lock (overridable per acquire). */
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 10 * 60_000;
const LOCK_POLL_MS = 100;

export interface FileLockHandle {
  lockPath: string;
  acquired: boolean;
  /** Per-acquisition ownership token — present when `acquired`; proof of ownership for release. */
  token?: string;
}

/** Parsed shape of a lock-file payload. Every field is optional so a legacy or partial payload still parses. */
interface LockHolder {
  pid?: number;
  startedAt?: number;
  token?: string;
  host?: string;
}

export interface AcquireFileLockOpts {
  /** Max time to wait for a live lock before failing cleanly (default 10s). */
  waitMs?: number;
  /**
   * Age (by mtime) past which an *unparseable/abandoned* lock may be reclaimed
   * (default 10m). Age NEVER reclaims a lock whose recorded pid is alive on
   * this host — it only governs the fail-closed fallback for a lock we cannot
   * attribute to a live owner (unparseable payload, or one without a pid).
   */
  staleMs?: number;
  /** Poll interval while waiting on a live lock (default 100ms). */
  pollMs?: number;
  /** Liveness probe for the holder pid — injectable so tests are deterministic. */
  isPidAlive?: (pid: number) => boolean;
  /** Clock — injectable so tests are deterministic. */
  now?: () => number;
  /** Current hostname — injectable so cross-host tests are deterministic (default `os.hostname`). */
  hostname?: () => string;
  /**
   * Names the holder in the timeout message ("another ${label} is in
   * progress …"). Defaults to a generic phrase; `add` passes "owenloop add" so
   * its existing wording is byte-identical.
   */
  label?: string;
}

/**
 * Thrown by `acquireFileLock` when it gives up after `waitMs` on a lock a live
 * owner still holds. A subclass of `Error` (not a plain `Error`) so a caller can
 * `instanceof`-distinguish a clean timeout from a real filesystem failure (an
 * EACCES/EROFS from the exclusive create) and map only the timeout to its own
 * domain error — while `.message` stays byte-identical to the pre-extraction
 * plain-`Error` message the `add` tests assert on.
 */
export class FileLockTimeoutError extends Error {
  readonly lockPath: string;
  readonly holderPid: number | undefined;
  readonly waitMs: number;
  constructor(message: string, lockPath: string, holderPid: number | undefined, waitMs: number) {
    super(message);
    this.name = 'FileLockTimeoutError';
    this.lockPath = lockPath;
    this.holderPid = holderPid;
    this.waitMs = waitMs;
  }
}

/** `true` if a process with `pid` exists (signal 0 probes without delivering). */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but we may not signal it — treat as alive.
    // ESRCH (and anything else): no such process — dead.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read the lock file's raw bytes, or `null` if it is gone/unreadable. */
function readLockRaw(lockPath: string): string | null {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
}

/** Parse raw lock bytes into a holder, or `null` if absent/unparseable. */
function parseLockHolder(raw: string | null): LockHolder | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as LockHolder;
  } catch {
    return null;
  }
}

/** Read + parse the lock file in one step (fresh read). Used off the hot loop. */
function readLockHolder(lockPath: string): LockHolder | null {
  return parseLockHolder(readLockRaw(lockPath));
}

/**
 * Decide whether the lock described by `holder` (parsed from a raw read) may be
 * reclaimed, given the current host. Liveness-aware, not age-based:
 *
 *   1. `statSync` fails — the lock vanished mid-judgment → treat as reclaimable
 *      (the acquire loop re-verifies and simply retries the exclusive create).
 *   2. Holder records a `host` that differs from ours → NOT stale, ever. A
 *      foreign PID space means `process.kill(pid, 0)` proves nothing; a shared
 *      filesystem could be locked by another machine. Held; caller refuses.
 *   3. Holder has a numeric `pid` and either matches our host or omits `host`
 *      (a legacy same-machine payload) → stale iff that pid is dead. Age never
 *      reclaims a live-pid lock — this is the core safety policy.
 *   4. Unparseable, or parses without a numeric pid → fail closed: held until
 *      `now() - mtimeMs > staleMs` (age is the only abandonment signal left).
 */
function lockIsStale(
  lockPath: string,
  holder: LockHolder | null,
  staleMs: number,
  isPidAlive: (pid: number) => boolean,
  now: () => number,
  currentHost: string,
): boolean {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    // Vanished between the EEXIST and here — someone else reclaimed it; retry.
    return true;
  }
  // Case 2: recorded on a different host — its pid tells us nothing. Held.
  if (holder && typeof holder.host === 'string' && holder.host !== currentHost) {
    return false;
  }
  // Case 3: same host (or legacy no-host payload) with a numeric pid — liveness decides.
  if (holder && typeof holder.pid === 'number') {
    return !isPidAlive(holder.pid);
  }
  // Case 4: no attributable live owner — age is the only abandonment signal.
  return now() - mtimeMs > staleMs;
}

/**
 * Acquire the file lock at `lockPath` (an exclusive-create of the file,
 * `openSync(..,'wx')` — the O_EXCL create is the real serialization point). The
 * payload carries an ownership token, the owner pid, a start timestamp, and the
 * host. If another process holds it: reclaim it only when liveness-aware
 * staleness says its owner is gone (see `lockIsStale`), otherwise poll until it
 * frees, and if it does not free within `waitMs` throw a `FileLockTimeoutError`.
 * Always pair with `releaseFileLock` in a `finally`.
 */
export async function acquireFileLock(
  lockPath: string,
  opts: AcquireFileLockOpts = {},
): Promise<FileLockHandle> {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const pollMs = opts.pollMs ?? LOCK_POLL_MS;
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const now = opts.now ?? Date.now;
  const host = (opts.hostname ?? hostname)();
  const label = opts.label ?? 'owenloop process';

  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      const token = randomBytes(16).toString('hex');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now(), token, host }));
      } finally {
        closeSync(fd);
      }
      return { lockPath, acquired: true, token };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    // Judge staleness from a single captured raw read...
    const raw = readLockRaw(lockPath);
    const holder = parseLockHolder(raw);
    if (lockIsStale(lockPath, holder, staleMs, isPidAlive, now, host)) {
      // ...then re-verify the bytes are unchanged immediately before deleting.
      // Between judging stale and rmSync a third process could reclaim and
      // re-create the lock; deleting then would destroy a *fresh* owner's lock.
      // Residual window is a few syscalls (read-compare-delete) rather than the
      // poll interval — and the `wx` create below is the true arbiter: if two
      // reclaimers race, one wins the create and the other loops on EEXIST. A
      // rename-based reclaim was rejected: POSIX rename clobbers its target, so
      // any "rename back on mismatch" arm can itself destroy a newer lock.
      const raw2 = readLockRaw(lockPath);
      if (raw2 !== null && raw2 === raw) {
        rmSync(lockPath, { force: true });
        continue; // reclaimed — retry the exclusive create
      }
      // Bytes changed under us, or the lock is stat-able but unreadable (a
      // root-owned 0600 lock: statSync needs only dir perms, readFileSync
      // EACCES → raw/raw2 null). Do NOT delete — fall through to the deadline
      // check and poll sleep below. Never `continue` here: with an unreadable,
      // backdated lock this branch would otherwise spin sleeplessly, starving
      // the event loop and never enforcing `waitMs`.
    }
    if (now() >= deadline) {
      throw new FileLockTimeoutError(
        inProgressMessage(lockPath, holder, waitMs, label),
        lockPath,
        typeof holder?.pid === 'number' ? holder.pid : undefined,
        waitMs,
      );
    }
    await sleep(pollMs);
  }
}

/** Build the clear "another … is in progress" timeout error text, with graceful fallbacks. */
function inProgressMessage(lockPath: string, holder: LockHolder | null, waitMs: number, label: string): string {
  const who = typeof holder?.pid === 'number' ? `pid ${holder.pid}` : 'another process';
  // Lock content is untrusted input: a finite `startedAt` outside the ECMAScript
  // Date range (|t| > 8.64e15 ms) makes `new Date(t).toISOString()` throw
  // RangeError. Only render held-since when the value is a valid time value;
  // otherwise omit it (same graceful fallback as an absent startedAt).
  const heldSince =
    typeof holder?.startedAt === 'number' &&
    Number.isFinite(holder.startedAt) &&
    Math.abs(holder.startedAt) <= 8.64e15
      ? `, held since ${new Date(holder.startedAt).toISOString()}`
      : '';
  const s = Math.round(waitMs / 1000);
  return `another ${label} is in progress (${who}${heldSince}) — holds ${lockPath}; timed out waiting after ${s}s`;
}

/**
 * Release a lock acquired by `acquireFileLock`. Token-checked and best-effort: a
 * no-op if not acquired, if the lock is already gone/unparseable, or if its
 * token no longer matches this handle (someone else legitimately re-acquired it
 * — deleting would steal *their* lock). Never throws; it runs in a `finally` and
 * must not mask the real error.
 */
export function releaseFileLock(handle: FileLockHandle): void {
  if (!handle.acquired) return;
  try {
    const holder = readLockHolder(handle.lockPath);
    if (!holder || holder.token !== handle.token) return;
    rmSync(handle.lockPath, { force: true });
  } catch {
    // Already reclaimed/replaced, or an unexpected fs error — swallow.
  }
}
