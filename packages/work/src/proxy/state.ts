/**
 * In-flight tracking for detached exec children (plan decision 7).
 *
 * The proxy spawns `owenloop work exec <run>` DETACHED — the child survives a proxy
 * restart (kernel reparenting, SP5-verified). So the proxy cannot trust its own
 * memory to know what is in flight across a restart; it reconstructs that from
 * durable local records instead. A state dir holds one JSON record per spawned
 * child — `{ workflow, run, pid, spawnedAt, def?, hash?, step? }` — and on every
 * sweep (and startup) we scan the records, probe each pid with `kill(pid, 0)`,
 * count the live ones as in-flight, and reap the dead ones.
 *
 * The design docs disdain PID files for broker/discovery plumbing of
 * harness-managed processes; these are proxy-spawned children, so local
 * bookkeeping is the legitimate mechanism, not that anti-pattern. Metering off
 * this count is an EFFICIENCY mechanism only — engine race-safety plus the
 * pickup/lease TTLs are the correctness backstop — so a rare pid-reuse miscount
 * is acceptable and never a bug to chase.
 *
 * Every fs op is FAIL-OPEN: a broken state dir degrades metering (the proxy may
 * over- or under-count in flight), it never kills the loop.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One dispatched order the proxy meters against capacity.
 *
 *  Two kinds, and BOTH are real local processes tracked by a live pid:
 *   - `exec` (default; absent `kind` for legacy records) — a detached
 *     `owenloop work exec` command child, tracked by `kill(pid, 0)`.
 *   - `agent-run` — a detached `owenloop work agent-run` child hosting the step
 *     agent itself, tracked exactly the same way.
 *
 *  There is no pid-less kind any more. The removed `'agent'` kind recorded a
 *  stamped Step Agent file handed to an out-of-process Conductor: no local
 *  child, a `0` sentinel pid, and a coarse TTL standing in for liveness. With
 *  the stamp path gone nothing produces such a record, so a leftover one on disk
 *  fails the pid probe and is reaped on the next reconcile — which is correct.
 *
 *  `def/hash/step` are dispatch provenance (which cached def revision and step
 *  this child was dispatched for); they are absent for command orders. */
export interface ChildRecord {
  workflow: string;
  run: string;
  /** The child's live pid. */
  pid: number;
  spawnedAt: number;
  /** Dispatch kind; absent = `'exec'` (back-compat with pre-split records). */
  kind?: 'exec' | 'agent-run';
  def?: string;
  hash?: string;
  step?: string;
}

/**
 * Resolve the state dir: `override` → `$XDG_STATE_HOME/owenloop/exec` →
 * `$HOME/.local/state/owenloop/exec`. Throws when none is available (same
 * stance as the cache/settings resolvers — never guess a home dir). Tests pass
 * an explicit `override` pointing at a temp dir.
 */
export function resolveStateDir(env: Record<string, string | undefined>, override?: string): string {
  if (override !== undefined && override.trim() !== '') return override;
  const xdg = env['XDG_STATE_HOME'];
  if (xdg !== undefined && xdg.trim() !== '') return join(xdg, 'owenloop', 'exec');
  const home = env['HOME'];
  if (home !== undefined && home.trim() !== '') return join(home, '.local', 'state', 'owenloop', 'exec');
  throw new Error('cannot locate a state directory: set OWENLOOP_STATE_DIR, XDG_STATE_HOME, or HOME');
}

/** Map a run id onto a safe record filename (hub run ids are already safe; this
 *  is defense in depth against a `/`, `\`, or `..` sneaking in). */
function recordFile(stateDir: string, run: string): string {
  const safe = run.replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(stateDir, `${safe}.json`);
}

/** Persist a child record (atomic temp+rename). Fail-open. */
export function writeChildRecord(stateDir: string, rec: ChildRecord): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const file = recordFile(stateDir, rec.run);
    const tmp = join(stateDir, `.${Math.random().toString(36).slice(2)}-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify(rec));
    try {
      renameSync(tmp, file);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort cleanup
      }
      throw err;
    }
  } catch {
    // fail-open: a lost record degrades metering, never kills the loop.
  }
}

/** Read every child record in the state dir. Corrupt files are skipped, a
 *  missing dir reads as empty. Fail-open. */
export function readChildRecords(stateDir: string): ChildRecord[] {
  let names: string[];
  try {
    names = readdirSync(stateDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const records: ChildRecord[] = [];
  for (const name of names) {
    try {
      const rec = JSON.parse(readFileSync(join(stateDir, name), 'utf8')) as ChildRecord;
      if (rec && typeof rec.run === 'string' && typeof rec.pid === 'number' && typeof rec.workflow === 'string') {
        records.push(rec);
      }
    } catch {
      // skip corrupt record
    }
  }
  return records;
}

/** Delete a child record by run id. Fail-open. */
export function removeChildRecord(stateDir: string, run: string): void {
  try {
    rmSync(recordFile(stateDir, run), { force: true });
  } catch {
    // best-effort
  }
}

/** A liveness probe over a pid. Injectable so tests never touch real pids. */
export type Liveness = (pid: number) => boolean;

/**
 * Default liveness probe: `process.kill(pid, 0)` sends no signal, only checks
 * existence/permissions. `ESRCH` ⇒ the process is gone (dead). `EPERM` ⇒ it
 * exists but is owned by another user (count as alive — pid reuse aside, a live
 * foreign process at that pid is not ours to reap). Any other error ⇒ alive
 * (conservative: don't reap on an ambiguous signal).
 */
export const defaultIsAlive: Liveness = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

export interface Reconciliation {
  /** Records whose child is still alive — these count as in-flight. */
  live: ChildRecord[];
  /** Records whose child is gone — reaped (record deleted) this pass. */
  reaped: ChildRecord[];
}

/** Injectable knobs for `reconcileInFlight` (all optional; real defaults). */
export interface ReconcileOptions {
  /** pid liveness probe (default `defaultIsAlive`). */
  isAlive?: Liveness;
}

/**
 * Scan the state dir, decide each record's liveness, delete the dead ones, and
 * return the live/reaped split. Deduped by run id (last record for a run wins)
 * so a stray double-write can never double-count capacity.
 *
 * Liveness is UNIFORM: every record names a real local child, so every record
 * is live exactly while `kill(pid, 0)` says its pid is.
 *
 * Back-compat: the second positional arg still accepts a bare `Liveness`
 * (pre-split callers passed `reconcileInFlight(dir, isAlive)`).
 */
export function reconcileInFlight(stateDir: string, arg?: Liveness | ReconcileOptions): Reconciliation {
  const opts: ReconcileOptions = typeof arg === 'function' ? { isAlive: arg } : (arg ?? {});
  const isAlive = opts.isAlive ?? defaultIsAlive;

  const byRun = new Map<string, ChildRecord>();
  for (const rec of readChildRecords(stateDir)) byRun.set(rec.run, rec);

  const live: ChildRecord[] = [];
  const reaped: ChildRecord[] = [];
  for (const rec of byRun.values()) {
    const alive = isAlive(rec.pid);
    if (alive) {
      live.push(rec);
    } else {
      removeChildRecord(stateDir, rec.run);
      reaped.push(rec);
    }
  }
  return { live, reaped };
}

/** Ensure the state dir exists so the first read doesn't churn. Fail-open. */
export function ensureStateDir(stateDir: string): void {
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  } catch {
    // fail-open
  }
}
