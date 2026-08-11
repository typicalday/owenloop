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
import { join } from 'node:path';

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

export function resolveStateDir(env: Record<string, string | undefined>, override?: string): string {
  if (override !== undefined && override.trim() !== '') return override;
  const xdg = env['XDG_STATE_HOME'];
  if (xdg !== undefined && xdg.trim() !== '') return join(xdg, 'owenloop', 'exec');
  const home = env['HOME'];
  if (home !== undefined && home.trim() !== '') return join(home, '.local', 'state', 'owenloop', 'exec');
  throw new Error('cannot locate a state directory: set OWENLOOP_STATE_DIR, XDG_STATE_HOME, or HOME');
}

function safeRun(run: string): string {
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

function readOneStateRecord(path: string): StateRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    if (typeof parsed['workflow'] !== 'string' || typeof parsed['run'] !== 'string') return undefined;
    if (parsed['recordType'] === 'reservation') {
      if (
	typeof parsed['reservedAt'] !== 'number' ||
	typeof parsed['token'] !== 'string' ||
	(parsed['childKind'] !== 'exec' && parsed['childKind'] !== 'agent-run')
      ) return undefined;
      return parsed as unknown as ChildReservation;
    }
    if (typeof parsed['pid'] !== 'number' || typeof parsed['spawnedAt'] !== 'number') return undefined;
    return parsed as unknown as ChildRecord;
  } catch {
    return undefined;
  }
}

function readStateRecords(stateDir: string): StateRecord[] {
  let names: string[];
  try {
    names = readdirSync(stateDir).filter((name) => name.endsWith('.json'));
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
export function cancelReservedChild(stateDir: string, reservation: ChildReservation): void {
  const path = gateFile(stateDir, reservation.token);
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
    if (matchesReservation || matchesFinalized) durableRemove(recordFile(stateDir, reservation.run));
  }
}

/**
 * Delete one run's in-flight state. A still-gated reservation or finalized child
 * is cancelled first so an external run-ended signal cannot leave a worker gate
 * behind that later opens without a capacity record.
 */
export function removeChildRecord(stateDir: string, run: string): void {
  const path = recordFile(stateDir, run);
  const current = readOneStateRecord(path);
  if (current !== undefined && isReservation(current)) {
    cancelReservedChild(stateDir, current);
    return;
  }
  if (current?.gateToken !== undefined) {
    const gatePath = gateFile(stateDir, current.gateToken);
    try {
      signalGate(gatePath, 'cancel', true);
    } finally {
      durableRemove(gatePath);
    }
  }
  durableRemove(path);
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
      if (now - record.reservedAt < maxAge) {
	reserved.push(record);
	continue;
      }
      cancelReservedChild(stateDir, record);
      abandoned.push(record);
      continue;
    }

    if (!isAlive(record.pid)) {
      removeChildRecord(stateDir, record.run);
      reaped.push(record);
      continue;
    }

    if (record.gateToken !== undefined) {
      // A restart after PID persistence but before the parent opened the gate can
      // safely finish the handoff: the durable PID record is the prerequisite.
      signalGate(gateFile(stateDir, record.gateToken), 'start', true);
      const settled = { ...record };
      delete settled.gateToken;
      writeStateRecord(stateDir, settled);
      live.push(settled);
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
