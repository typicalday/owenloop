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
 * "Still exists" means in ANY state directory that writes logs here, not just
 * the sweeping shift's own — several shifts may share one log directory while
 * keeping separate per-crew state directories. `LOG_OWNERS_DIR_NAME` below is
 * how a sweeping shift learns where the other shifts' records live.
 *
 * Shape mirrors `agent/workdir.ts`: a PURE truth-table gate (`isShiftLogReapable`)
 * a unit test can drive with no filesystem, plus a best-effort sweep
 * (`sweepShiftLogs`) that never throws, because a sweep must not die over one
 * file.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  /**
   * Does the matching `<run>.json` in-flight record still exist in ANY state
   * directory that logs into this directory? See `LOG_OWNERS_DIR_NAME`.
   */
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

/**
 * Sub-directory of the log directory in which each shift declares WHICH state
 * directory holds its in-flight `<run>.json` records.
 *
 * ── WHY A REGISTRY EXISTS AT ALL ──
 *
 * The in-flight gate asks "does `<run>.json` still exist?", and a shift can only
 * answer that for the state directory it owns. `--log-dir` /
 * `OWENLOOP_SHIFT_LOG_DIR` is a single global setting, so centralizing several
 * crews' logs into ONE directory while each crew keeps its own per-crew state
 * directory is the obvious way to use it. In that layout a sweeping shift sees
 * another shift's `<run>.log` with no `<run>.json` anywhere IT can see, decides
 * the run is finished, and unlinks a log a LIVE worker still holds a descriptor
 * on — the exact orphaned-inode data loss the gate exists to prevent. At the
 * 14-day default that needs a worker quiet for 14 days; at a reduced
 * `--log-max-age` it fires against every live worker of every other shift.
 *
 * So each shift writes one claim naming its state directory, and the sweep
 * treats a run as in flight if ANY claimed state directory still holds its
 * record. One file per shift, named by a hash of the state directory it names,
 * so two shifts starting at once each write their OWN file and no
 * read-modify-write can lose a claim.
 *
 * A stale claim (a retired crew) is harmless: its state directory either no
 * longer exists or holds no records, so it contributes no `true` and merely
 * costs one `stat`. Erring toward keeping a log costs disk; erring the other way
 * costs an operator the evidence they went looking for.
 */
export const LOG_OWNERS_DIR_NAME = '.owners';

/** `<log-dir>/.owners` — pure path math; creates nothing. */
export function logOwnersDir(logDir: string): string {
  return join(logDir, LOG_OWNERS_DIR_NAME);
}

/**
 * The claim filename for one state directory. A hash, not the path itself:
 * a state directory path is not a safe filename, and the hash makes each shift's
 * write land on its own name so concurrent claims cannot clobber each other.
 */
function ownerClaimName(stateDir: string): string {
  return `${createHash('sha256').update(stateDir).digest('hex').slice(0, 16)}.json`;
}

/**
 * Declare that `stateDir` holds the in-flight records for the workers logging
 * into `logDir`. Idempotent — re-run at every shift startup, rewriting the same
 * path with the same bytes.
 *
 * THROWS on failure, deliberately: the caller decides what a shift that cannot
 * claim its logs should do (see `runtime.ts`, which reports once and keeps
 * dispatching, because an observability defect must not become an outage).
 */
export function registerShiftLogOwner(logDir: string, stateDir: string): string {
  const dir = logOwnersDir(logDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ownerClaimName(stateDir));
  writeFileSync(path, `${JSON.stringify({ stateDir })}\n`);
  return path;
}

/**
 * Every state directory that has claimed `logDir`, plus `ownStateDir` — which is
 * included unconditionally so a sweep is never LESS informed than it was before
 * the registry existed, even if the claim write failed or the directory is
 * unreadable.
 *
 * Never throws. An absent registry (the default single-shift layout, where no
 * claim has been written yet) and one unparseable claim both degrade to "that
 * claim tells me nothing", not to a failed sweep.
 */
export function readShiftLogOwners(logDir: string, ownStateDir: string): string[] {
  const owners = new Set<string>([ownStateDir]);
  const dir = logOwnersDir(logDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [...owners];
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const claimed = (parsed as { stateDir?: unknown }).stateDir;
      if (typeof claimed === 'string' && claimed.trim() !== '') owners.add(claimed);
    } catch {
      // One corrupt claim must not blind the sweep to the others. It can only
      // cost the claimant's own logs, and only if that shift never rewrites it.
    }
  }
  return [...owners];
}

export interface SweepShiftLogsOptions {
  /** The resolved log directory. */
  dir: string;
  /** Where THIS shift's `<run>.json` in-flight records live. */
  stateDir: string;
  /**
   * Every state directory whose records gate this sweep. Defaults to
   * `readShiftLogOwners(dir, stateDir)` — this shift's own, plus every other
   * shift that has claimed the log directory. Injected for tests.
   */
  stateDirs?: string[];
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
  // A run is in flight if ANY shift that logs here still holds its record — not
  // just this one. See `LOG_OWNERS_DIR_NAME` for why a single-state-dir probe
  // silently reaps other shifts' live logs.
  const stateDirs = o.stateDirs ?? readShiftLogOwners(o.dir, o.stateDir);
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
          hasRunRecord: stateDirs.some((stateDir) => hasRecord(stateDir, name)),
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
