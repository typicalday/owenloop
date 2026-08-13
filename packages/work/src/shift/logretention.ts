/**
 * Where shift logs live, and the gate that removes worker logs.
 *
 * ── WHY THE LOG LIFETIME IS NOT THE RUN RECORD'S LIFETIME ──
 *
 * `state.ts` removes a run's `<run>.json` the moment its child completes. A log
 * that inherited that lifecycle would be readable only while the run is still in
 * flight — useless for the postmortem it exists for. So worker logs are swept by
 * AGE, independently, and the run record's disappearance is what makes a log
 * eligible rather than what deletes it.
 *
 * ── THE IN-FLIGHT GATE IS NOT TIDINESS ──
 *
 * A live worker holds an open descriptor on its log. On POSIX, unlinking that
 * file makes it invisible while the child keeps writing to the now-orphaned
 * inode: the bytes are produced, accounted against the filesystem, and lost.
 * Refusing to reap any log whose `<run>.json` still exists is what prevents
 * that.
 *
 * Shape mirrors `agent/workdir.ts`: a PURE truth-table gate (`isShiftLogReapable`)
 * a unit test can drive with no filesystem, plus a best-effort sweep
 * (`sweepShiftLogs`) that never throws, because a sweep must not die over one
 * file.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { safeRun } from './state.ts';

/** The shift's own structured JSON Lines log, inside the log directory. */
export const SHIFT_LOG_NAME = 'shift.log';

/**
 * `<log-dir>/shift.log` — the shift process's own structured log. Pure path
 * math; creates nothing.
 */
export function shiftLogFile(logDir: string): string {
  return join(logDir, SHIFT_LOG_NAME);
}

/**
 * `<log-dir>/<run>.log` — one worker's raw output. Pure path math; creates
 * nothing. Uses the SAME `safeRun` sanitizer `state.ts` uses for `<run>.json`,
 * which is what makes basename correlation hold.
 */
export function runLogFile(logDir: string, run: string): string {
  return join(logDir, `${safeRun(run)}.log`);
}

/**
 * Default retention for worker logs: 14 days.
 *
 * Long enough to read a postmortem the week after something went wrong, short
 * enough to bound disk on a machine that runs shifts continuously. Worker logs
 * are unbounded in SIZE by design — the tail you would have capped away is
 * exactly the pathological run you needed to read — so volume is bounded here,
 * by age, instead.
 */
export const DEFAULT_SHIFT_LOG_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Resolve the log directory: `--log-dir` > `OWENLOOP_SHIFT_LOG_DIR` >
 * `settings.shiftLogDir` > the already-resolved state dir. Same precedence shape
 * as `resolveWorkRoot` and `resolveStateDirOverride`, so there is one rule to
 * remember.
 *
 * DEFAULTING TO THE STATE DIR is what makes correlation free: `<run>.log` lands
 * beside the existing `<run>.json`, same basename. The correlation key is the
 * BASENAME, not the adjacency — an operator who points `--log-dir` elsewhere
 * moves the logs away from the records and basename correlation still holds.
 */
export function resolveShiftLogDir(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  settingsLogDir: string | undefined,
  stateDir: string,
): string {
  if (flag !== undefined && flag.trim() !== '') return flag;
  const override = env['OWENLOOP_SHIFT_LOG_DIR'];
  if (override !== undefined && override.trim() !== '') return override;
  if (settingsLogDir !== undefined && settingsLogDir.trim() !== '') return settingsLogDir;
  return stateDir;
}

/**
 * Resolve worker-log retention in milliseconds: `--log-max-age` >
 * `OWENLOOP_SHIFT_LOG_MAX_AGE_MS` > `settings.shiftLogMaxAgeMs` >
 * `DEFAULT_SHIFT_LOG_MAX_AGE_MS`. An unparseable or negative env value is
 * ignored rather than fatal — a typo in an environment variable must not stop a
 * shift from serving.
 */
export function resolveShiftLogMaxAgeMs(
  flag: number | undefined,
  env: Record<string, string | undefined>,
  settingsMaxAgeMs: number | undefined,
): number {
  if (flag !== undefined) return flag;
  const raw = env['OWENLOOP_SHIFT_LOG_MAX_AGE_MS'];
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  if (settingsMaxAgeMs !== undefined) return settingsMaxAgeMs;
  return DEFAULT_SHIFT_LOG_MAX_AGE_MS;
}

export interface ShiftLogReapGateInput {
  /** The log file's basename, e.g. `run_7b29d1845b2926eba5dbc574.log`. */
  name: string;
  /** The log file's own last-modification time, in ms. */
  mtimeMs: number;
  /** Does the matching `<run>.json` in-flight record still exist? */
  hasRunRecord: boolean;
  now: number;
  maxAgeMs: number;
}

/**
 * May this log file be removed?
 *
 * PURE — no filesystem, no clock. That is what lets the truth table below be a
 * unit test instead of an integration test.
 *
 * | `<run>.json` exists | older than maxAge | reap? |
 * |---|---|---|
 * | yes | any | NO — the run is still in flight (see the orphaned-inode note above) |
 * | no  | no  | NO — recent, still the postmortem you would want |
 * | no  | yes | YES |
 *
 * NEVER reapable regardless of age: `shift.log` (the shift's own structured log,
 * which this change does not rotate), anything not ending `.log`, and anything
 * whose basename is not a `run_…` id. The log directory defaults to the state
 * directory, which also holds `shift.sock`, `.dispatch.lock`, gate files and
 * atomic-write temporaries — a sweep that removed by age alone would eat them.
 *
 * Unlike `isWorkDirReapable`, whose `lastSeenAt` is a DIRECTORY mtime and
 * therefore a weak signal (a write deep inside a subtree does not update it),
 * this gate reads the log file's OWN mtime, which the worker's every write
 * updates. The signal is strong here, so the gate needs no grace window beyond
 * the retention age.
 */
export function isShiftLogReapable(g: ShiftLogReapGateInput): boolean {
  if (!isWorkerLogName(g.name)) return false;
  if (g.hasRunRecord) return false;
  return g.now - g.mtimeMs >= g.maxAgeMs;
}

/**
 * Is this basename a worker log this sweep owns?
 *
 * `<run>.log` where `<run>` is a run id as `state.ts` writes it — the same
 * `run_…` shape, sanitized the same way. Exported so the sweep and the gate
 * cannot disagree about what they own.
 */
export function isWorkerLogName(name: string): boolean {
  if (name === SHIFT_LOG_NAME) return false;
  if (!name.endsWith('.log')) return false;
  return /^run_[A-Za-z0-9_.-]+$/u.test(name.slice(0, -'.log'.length));
}

export interface SweepShiftLogsOptions {
  /** The resolved log directory. */
  dir: string;
  /** Where `<run>.json` in-flight records live — the state dir. */
  stateDir: string;
  now: number;
  maxAgeMs: number;
  /** Progress/warning sink. */
  err?: (line: string) => void;
  /** Injected for tests; defaults to `node:fs` `readdirSync`. */
  list?: (dir: string) => string[];
  /** Injected for tests; defaults to `node:fs` `statSync().mtimeMs`. */
  mtime?: (path: string) => number;
  /** Injected for tests; defaults to `node:fs` `existsSync`-style probe. */
  hasRecord?: (stateDir: string, name: string) => boolean;
  /** Injected for tests; defaults to `node:fs` `rmSync`. */
  remove?: (path: string) => void;
}

function defaultHasRecord(stateDir: string, logName: string): boolean {
  const record = join(stateDir, `${logName.slice(0, -'.log'.length)}.json`);
  try {
    statSync(record);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply `isShiftLogReapable` to every file in the log directory and remove the
 * ones that pass. Returns the paths actually removed, so a caller can log a
 * count.
 *
 * BEST EFFORT, NEVER THROWS. It runs at shift startup, before any work is
 * dispatched, and a shift that cannot tidy its logs must still serve. Every
 * per-file step is individually guarded: a locked, unreadable, or
 * concurrently-removed file costs that one entry, not the sweep.
 */
export function sweepShiftLogs(o: SweepShiftLogsOptions): string[] {
  const list = o.list ?? ((dir: string) => readdirSync(dir));
  const mtime = o.mtime ?? ((path: string) => statSync(path).mtimeMs);
  const hasRecord = o.hasRecord ?? defaultHasRecord;
  const remove = o.remove ?? ((path: string) => {
    rmSync(path, { force: true });
  });
  const removed: string[] = [];

  let names: string[];
  try {
    names = list(o.dir);
  } catch (e) {
    o.err?.(`owenloop shift: could not scan shift logs in ${o.dir}: ${errMsg(e)} (ignored)`);
    return removed;
  }

  for (const name of names) {
    const path = join(o.dir, name);
    try {
      if (!isWorkerLogName(name)) continue;
      if (
        !isShiftLogReapable({
          name,
          mtimeMs: mtime(path),
          hasRunRecord: hasRecord(o.stateDir, name),
          now: o.now,
          maxAgeMs: o.maxAgeMs,
        })
      ) continue;
      remove(path);
      removed.push(path);
    } catch (e) {
      o.err?.(`owenloop shift: could not reap shift log ${path}: ${errMsg(e)} (ignored)`);
    }
  }
  return removed;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
