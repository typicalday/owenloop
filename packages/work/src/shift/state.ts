/**
 * Durable Shift dispatch state.
 *
 * Every dispatch is reserved before spawn. A reservation counts against capacity
 * and same-run deduplication, and carries a start-gate token. The child waits on
 * that gate before entering the CLI. The Shift replaces the reservation with a
 * PID-bearing child record, then opens the gate. A crash before PID persistence
 * leaves a gated child that exits when the abandoned reservation is reaped; a
 * crash after PID persistence leaves enough state for restart reconciliation to
 * open the gate safely.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join, resolve } from 'node:path';

export const DEFAULT_RESERVATION_MAX_AGE_MS = 2 * 60_000;

export interface ChildRecord {
  workflow: string;
  run: string;
  pid: number;
  spawnedAt: number;
  /** Dispatch kind; absent = `'exec'` for backward compatibility. */
  kind?: 'exec' | 'agent-run';
  def?: string;
  hash?: string;
  step?: string;
  /** Present only between PID persistence and opening the child's start gate. */
  gateToken?: string;
}

export interface ChildReservation {
  recordType: 'reservation';
  workflow: string;
  run: string;
  reservedAt: number;
  token: string;
  childKind: 'exec' | 'agent-run';
  step?: string;
}

type StateRecord = ChildRecord | ChildReservation;

export interface ReservationRequest {
  workflow: string;
  run: string;
  reservedAt: number;
  childKind: 'exec' | 'agent-run';
  step?: string;
}

export interface ReservedChild {
  reservation: ChildReservation;
  gatePath: string;
}

/**
 * Where this shift's `<run>.json` in-flight records live.
 *
 * ALWAYS ABSOLUTE. `--state-dir ./state` is a legal thing for an operator to
 * type, and while only this process joined paths onto it the relative spelling
 * was harmless. It stopped being harmless when the log-owner registry
 * (`logretention.ts`) began WRITING this string into a file that a DIFFERENT
 * shift process, with a DIFFERENT working directory, reads back and probes for
 * `<run>.json`: `./state` resolved against the wrong cwd finds no record, the
 * in-flight gate concludes the run finished, and a live worker's log is
 * unlinked out from under it. `resolve()` here is what makes the writer, the
 * reader and the probe agree on ONE spelling, and it is also what keeps
 * `ownerClaimName`'s hash stable so one shift writes one claim file rather than
 * one per cwd it was ever started from.
 */
export function resolveStateDir(env: Record<string, string | undefined>, override?: string): string {
  if (override !== undefined && override.trim() !== '') return resolve(override);
  const xdg = env['XDG_STATE_HOME'];
  if (xdg !== undefined && xdg.trim() !== '') return resolve(xdg, 'owenloop', 'exec');
  const home = env['HOME'];
  if (home !== undefined && home.trim() !== '') return resolve(home, '.local', 'state', 'owenloop', 'exec');
  throw new Error('cannot locate a state directory: set OWENLOOP_STATE_DIR, XDG_STATE_HOME, or HOME');
}

/**
 * The run id as it appears in a filename, with every character a path could
 * misread replaced.
 *
 * EXPORTED because the worker log `<run>.log` correlates to the in-flight
 * record `<run>.json` BY BASENAME. Two sanitizers would be two basenames, and
 * the correlation an operator and a future uploader both rely on would silently
 * stop holding for any run id containing an unusual character.
 */
export function safeRun(run: string): string {
  return run.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function recordFile(stateDir: string, run: string): string {
  return join(stateDir, `${safeRun(run)}.json`);
}

function gateFile(stateDir: string, token: string): string {
  if (!/^[a-f0-9]{32}$/u.test(token)) throw new Error('invalid child start-gate token');
  return join(stateDir, `.${token}.gate`);
}

function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function durableExclusiveWrite(path: string, value: string): void {
  const fd = openSync(path, 'wx');
  let failure: unknown;
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } catch (error) {
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Preserve the original write or close failure.
    }
    throw failure;
  }
  syncDirectory(join(path, '..'));
}

function durableRemove(path: string): void {
  rmSync(path, { force: true });
  syncDirectory(join(path, '..'));
}

function atomicWrite(path: string, value: string): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomBytes(8).toString('hex')}-${process.pid}-${Date.now()}.tmp`);
  durableExclusiveWrite(tmp, value);
  try {
    renameSync(tmp, path);
    syncDirectory(dir);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function writeStateRecord(stateDir: string, record: StateRecord): void {
  atomicWrite(recordFile(stateDir, record.run), JSON.stringify(record));
}

/** Persist a child record atomically. State persistence is correctness-sensitive and throws on failure. */
export function writeChildRecord(stateDir: string, record: ChildRecord): void {
  writeStateRecord(stateDir, record);
}

/** Create the durable capacity reservation and closed start gate before spawn. */
export function reserveChild(stateDir: string, request: ReservationRequest): ReservedChild {
  ensureStateDir(stateDir);
  const token = randomBytes(16).toString('hex');
  const gatePath = gateFile(stateDir, token);
  const reservation: ChildReservation = {
    recordType: 'reservation',
    workflow: request.workflow,
    run: request.run,
    reservedAt: request.reservedAt,
    token,
    childKind: request.childKind,
    ...(request.step !== undefined ? { step: request.step } : {}),
  };

  durableExclusiveWrite(gatePath, 'wait\n');
  try {
    // Exclusive create is the same-run reservation point. A stale, live, or even
    // corrupt existing record blocks dispatch rather than being overwritten.
    durableExclusiveWrite(recordFile(stateDir, reservation.run), JSON.stringify(reservation));
  } catch (error) {
    try {
      durableRemove(gatePath);
    } catch {
      // Preserve the reservation write failure.
    }
    throw error;
  }
  return { reservation, gatePath };
}

function isReservation(record: StateRecord): record is ChildReservation {
  return (record as Partial<ChildReservation>).recordType === 'reservation';
}

export class ShiftStateRecordError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(
      `cannot reconcile Shift state record '${path}': ${detail}; ` +
      'dispatch is disabled until the record is repaired or removed after verifying that no child still owns the slot',
    );
    this.name = 'ShiftStateRecordError';
    this.path = path;
  }
}

function readOneStateRecord(path: string): StateRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    const code = (error as NodeJS.ErrnoException).code;
    throw new ShiftStateRecordError(path, `the canonical record is unreadable${code === undefined ? '' : ` (${code})`}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ShiftStateRecordError(path, 'the canonical record is truncated or is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ShiftStateRecordError(path, 'the canonical record is not a JSON object');
  }
  if (
    typeof parsed['workflow'] !== 'string' || parsed['workflow'] === '' ||
    typeof parsed['run'] !== 'string' || parsed['run'] === ''
  ) {
    throw new ShiftStateRecordError(path, 'the canonical record is missing workflow or run identity');
  }
  if (basename(path) !== `${safeRun(parsed['run'])}.json`) {
    throw new ShiftStateRecordError(path, 'the canonical record pathname does not match its run identity');
  }
  if (parsed['recordType'] === 'reservation') {
    if (
      typeof parsed['reservedAt'] !== 'number' ||
      !Number.isInteger(parsed['reservedAt']) ||
      parsed['reservedAt'] < 0 ||
      typeof parsed['token'] !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(parsed['token']) ||
      (parsed['childKind'] !== 'exec' && parsed['childKind'] !== 'agent-run') ||
      (parsed['step'] !== undefined && typeof parsed['step'] !== 'string')
    ) {
      throw new ShiftStateRecordError(path, 'the canonical reservation fields are malformed');
    }
    return parsed as unknown as ChildReservation;
  }
  if (
    parsed['recordType'] !== undefined ||
    typeof parsed['pid'] !== 'number' ||
    !Number.isInteger(parsed['pid']) ||
    parsed['pid'] <= 0 ||
    typeof parsed['spawnedAt'] !== 'number' ||
    !Number.isInteger(parsed['spawnedAt']) ||
    parsed['spawnedAt'] < 0 ||
    (parsed['kind'] !== undefined && parsed['kind'] !== 'exec' && parsed['kind'] !== 'agent-run') ||
    (parsed['def'] !== undefined && typeof parsed['def'] !== 'string') ||
    (parsed['hash'] !== undefined && typeof parsed['hash'] !== 'string') ||
    (parsed['step'] !== undefined && typeof parsed['step'] !== 'string') ||
    (parsed['gateToken'] !== undefined && (
      typeof parsed['gateToken'] !== 'string' ||
      !/^[a-f0-9]{32}$/u.test(parsed['gateToken'])
    ))
  ) {
    throw new ShiftStateRecordError(path, 'the canonical child fields are malformed');
  }
  return parsed as unknown as ChildRecord;
}

function readStateRecords(stateDir: string): StateRecord[] {
  let names: string[];
  try {
    names = readdirSync(stateDir)
      .filter((name) => name.endsWith('.json') && name !== '.dispatch.lock.owner.json')
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .map((name) => readOneStateRecord(join(stateDir, name)))
    .filter((record): record is StateRecord => record !== undefined);
}

/** Read only PID-bearing records for status and compatibility callers. */
export function readChildRecords(stateDir: string): ChildRecord[] {
  return readStateRecords(stateDir).filter(
    (record): record is ChildRecord => !(isReservation(record)),
  );
}

export function readChildReservations(stateDir: string): ChildReservation[] {
  return readStateRecords(stateDir).filter(
    (record): record is ChildReservation => isReservation(record),
  );
}

/** Replace the matching reservation with a PID-bearing record before work starts. */
export function finalizeChildReservation(
  stateDir: string,
  reservation: ChildReservation,
  child: Omit<ChildRecord, 'workflow' | 'run' | 'gateToken'>,
): ChildRecord {
  const current = readOneStateRecord(recordFile(stateDir, reservation.run));
  if (
    current === undefined ||
    !isReservation(current) ||
    current.token !== reservation.token
  ) {
    throw new Error(`child reservation for ${reservation.workflow}/${reservation.run} is missing or was replaced`);
  }
  const record: ChildRecord = {
    workflow: reservation.workflow,
    run: reservation.run,
    ...child,
    gateToken: reservation.token,
  };
  writeStateRecord(stateDir, record);
  return record;
}

function signalGate(path: string, signal: 'start' | 'cancel', allowMissing: boolean): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r+');
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    ftruncateSync(fd, 0);
    writeFileSync(fd, `${signal}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Open a child's gate only after the PID-bearing record is durable. */
export function startReservedChild(stateDir: string, record: ChildRecord): void {
  if (record.gateToken === undefined) return;
  signalGate(gateFile(stateDir, record.gateToken), 'start', false);
}

/** Cancel a gated child and remove the matching reservation/record. */
export function cancelReservedChild(stateDir: string, reservation: ChildReservation): boolean {
  const path = gateFile(stateDir, reservation.token);
  let removed = false;
  try {
    signalGate(path, 'cancel', true);
  } finally {
    durableRemove(path);
    const current = readOneStateRecord(recordFile(stateDir, reservation.run));
    const matchesReservation = current !== undefined &&
      isReservation(current) &&
      current.token === reservation.token;
    const matchesFinalized = current !== undefined &&
      !isReservation(current) &&
      current.gateToken === reservation.token;
    if (matchesReservation || matchesFinalized) {
      durableRemove(recordFile(stateDir, reservation.run));
      removed = true;
    }
  }
  return removed;
}

/**
 * Delete one run's in-flight state. A still-gated reservation or finalized child
 * is cancelled first so an external run-ended signal cannot leave a worker gate
 * behind that later opens without a capacity record.
 */
export function removeChildRecord(
  stateDir: string,
  run: string,
  options?: { pid?: number },
): boolean {
  const path = recordFile(stateDir, run);
  const current = readOneStateRecord(path);
  if (current === undefined) return false;
  // A late exit report must never remove a record written by a re-dispatch of
  // the same run. Reservations have no pid, so they are likewise newer owners.
  if (options?.pid !== undefined && (isReservation(current) || current.pid !== options.pid)) return false;
  if (current !== undefined && isReservation(current)) return cancelReservedChild(stateDir, current);
  if (current?.gateToken !== undefined) {
    const gatePath = gateFile(stateDir, current.gateToken);
    try {
      signalGate(gatePath, 'cancel', true);
    } finally {
      durableRemove(gatePath);
    }
  }
  durableRemove(path);
  return true;
}

export type Liveness = (pid: number) => boolean;

export const defaultIsAlive: Liveness = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

export interface Reconciliation {
  live: ChildRecord[];
  reserved: ChildReservation[];
  reaped: ChildRecord[];
  abandoned: ChildReservation[];
}

export interface ReconcileOptions {
  isAlive?: Liveness;
  now?: number;
  reservationMaxAgeMs?: number;
  /**
   * Called before a stale reservation is removed. The Shift loop uses this to
   * share its dispatch lock with reservation creation; standalone state callers
   * intentionally retain the direct removal default.
   */
  removeAbandonedReservation?: (reservation: ChildReservation) => boolean;
  /**
   * Called before a dead child record is removed. The Shift loop uses this to
   * serialize the read/guard/unlink sequence with a later re-dispatch.
   */
  removeDeadChild?: (record: ChildRecord) => boolean;
  /**
   * Finish a persisted PID record's start-gate handoff. The Shift daemon uses
   * this to serialize the re-read/identity-check/write sequence with a later
   * re-dispatch; standalone state callers intentionally retain the direct
   * settlement default.
   */
  settleLiveChild?: (record: ChildRecord) => ChildRecord | undefined;
}

/**
 * Open and clear a persisted child's start gate only if the record is still
 * the same PID and gate-token pair the reconciler observed. A re-dispatch can
 * replace either identity between an unlocked observation and this settlement;
 * in that case it owns the record and nothing is changed.
 */
export function settleChildGate(stateDir: string, record: ChildRecord): ChildRecord | undefined {
  if (record.gateToken === undefined) return record;
  const current = readOneStateRecord(recordFile(stateDir, record.run));
  if (
    current === undefined ||
    isReservation(current) ||
    current.pid !== record.pid ||
    current.gateToken !== record.gateToken
  ) return undefined;

  signalGate(gateFile(stateDir, current.gateToken), 'start', true);
  const settled = { ...current };
  delete settled.gateToken;
  writeStateRecord(stateDir, settled);
  return settled;
}

/**
 * Reconcile live children and durable reservations. Fresh reservations count as
 * occupied capacity. An expired reservation is cancelled before its record is
 * removed, so a child that was spawned but never finalized cannot begin work.
 */
export function reconcileInFlight(stateDir: string, arg?: Liveness | ReconcileOptions): Reconciliation {
  const options: ReconcileOptions = typeof arg === 'function' ? { isAlive: arg } : (arg ?? {});
  const isAlive = options.isAlive ?? defaultIsAlive;
  const now = options.now ?? Date.now();
  const maxAge = options.reservationMaxAgeMs ?? DEFAULT_RESERVATION_MAX_AGE_MS;

  const byRun = new Map<string, StateRecord>();
  for (const record of readStateRecords(stateDir)) byRun.set(record.run, record);

  const live: ChildRecord[] = [];
  const reserved: ChildReservation[] = [];
  const reaped: ChildRecord[] = [];
  const abandoned: ChildReservation[] = [];

  for (const record of byRun.values()) {
    if (isReservation(record)) {
      // The worker removes its gate when its monotonic wait expires. A missing
      // gate therefore proves that this reservation cannot start work, even if
      // wall-clock rollback makes its persisted age look fresh.
      const gateExists = existsSync(gateFile(stateDir, record.token));
      // A persisted wall-clock timestamp from the future cannot be aged safely
      // after a clock rollback. Cancel the reservation instead of letting a
      // negative elapsed interval occupy capacity indefinitely.
      if (gateExists && record.reservedAt <= now && now - record.reservedAt < maxAge) {
	reserved.push(record);
	continue;
      }
      const removed = options.removeAbandonedReservation?.(record) ?? cancelReservedChild(stateDir, record);
      if (removed) abandoned.push(record);
      continue;
    }

    if (!isAlive(record.pid)) {
      const removed = options.removeDeadChild?.(record) ?? removeChildRecord(stateDir, record.run, { pid: record.pid });
      if (removed) reaped.push(record);
      continue;
    }

    if (record.gateToken !== undefined) {
      // A restart after PID persistence but before the parent opened the gate can
      // safely finish the handoff: the durable PID record is the prerequisite.
      const settled = options.settleLiveChild === undefined ? settleChildGate(stateDir, record) : options.settleLiveChild(record);
      if (settled !== undefined) live.push(settled);
    } else {
      live.push(record);
    }
  }

  return { live, reserved, reaped, abandoned };
}

/** Ensure the state directory exists and is readable. Failure is fatal to dispatch safety. */
export function ensureStateDir(stateDir: string): void {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  readdirSync(stateDir);
}
