/**
 * Persistence layer — a thin, typed wrapper over SQLite (better-sqlite3).
 *
 * The store knows nothing about eligibility, firing, or cascades; it is pure
 * data access. The engine performs read-modify-write *inside* `tx()`, which
 * runs the callback in a `BEGIN IMMEDIATE` transaction. Because better-sqlite3
 * is synchronous and single-connection-per-process, everything inside that
 * callback is atomic; across processes, `BEGIN IMMEDIATE` takes the write lock
 * up front so the commit-fingerprint CAS (design §12) is serialized — no torn
 * reads between a claim and its commit.
 *
 * JSON-shaped fields (value, fingerprint, reasons, params) are stored as TEXT
 * and (de)serialized at the boundary so callers always see real objects.
 */

import Database from 'better-sqlite3';
import { detId, nowMs } from './util.ts';
import type {
  Acceptance,
  ArtifactData,
  Fingerprint,
  ReasonEntry,
  RunData,
  TaskData,
  WorkflowData,
} from './types.ts';

type DB = Database.Database;

// ---- row-shaped records (data + identity + timestamps) ----------------------

export interface ArtifactRow extends ArtifactData {
  id: string;
  updatedAt: number;
}
export interface TaskRow extends TaskData {
  id: string;
  updatedAt: number;
}
export interface RunRow extends RunData {
  id: string;
  createdAt: number;
  updatedAt: number;
}
export interface WorkflowRow extends WorkflowData {
  id: string;
  createdAt: number;
}

// ---- deterministic ids -------------------------------------------------------

export function artifactId(workflow: string, path: string): string {
  return detId('art', workflow, path);
}
export function taskId(workflow: string, loop: string, key: string): string {
  return detId('task', workflow, loop, key);
}

// ---- schema ------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow (
  id          TEXT PRIMARY KEY,
  def         TEXT NOT NULL,
  title       TEXT,
  params      TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact (
  id               TEXT PRIMARY KEY,
  workflow         TEXT NOT NULL,
  path             TEXT NOT NULL,
  producer         TEXT NOT NULL,
  acceptance       TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 0,
  value            TEXT,
  fingerprint      TEXT,
  reasons          TEXT NOT NULL DEFAULT '[]',
  judgment_rejects INTEGER NOT NULL DEFAULT 0,
  schema_rejects   INTEGER NOT NULL DEFAULT 0,
  seal_of          TEXT,
  terminal         INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  UNIQUE (workflow, path)
);
CREATE INDEX IF NOT EXISTS artifact_wf ON artifact (workflow);
CREATE INDEX IF NOT EXISTS artifact_wf_accept ON artifact (workflow, acceptance);

CREATE TABLE IF NOT EXISTS task (
  id          TEXT PRIMARY KEY,
  workflow    TEXT NOT NULL,
  loop        TEXT NOT NULL,
  key         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'idle',
  run         TEXT,
  claimed_at  INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  alarm_at    INTEGER,
  updated_at  INTEGER NOT NULL,
  UNIQUE (workflow, loop, key)
);
CREATE INDEX IF NOT EXISTS task_wf ON task (workflow);
CREATE INDEX IF NOT EXISTS task_claimed ON task (status, claimed_at);

CREATE TABLE IF NOT EXISTS run (
  id          TEXT PRIMARY KEY,
  workflow    TEXT NOT NULL,
  loop        TEXT NOT NULL,
  key         TEXT NOT NULL DEFAULT '',
  outcome     TEXT,
  summary     TEXT,
  session_id  TEXT,
  fingerprint TEXT,
  cause       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS run_wf_loop ON run (workflow, loop, created_at);
-- recentFailedRuns filters by key too; this index lets it walk the trailing
-- runs of one loop+key in order without scanning the whole loop's history.
CREATE INDEX IF NOT EXISTS run_wf_loop_key ON run (workflow, loop, key, created_at);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

const SCHEMA_VERSION = '2';

// ---- (de)serialization helpers ----------------------------------------------

function toJson(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}
function fromJson<T>(s: unknown, fallback: T): T {
  if (s === null || s === undefined) return fallback;
  return JSON.parse(s as string) as T;
}

interface ArtifactRowRaw {
  id: string;
  workflow: string;
  path: string;
  producer: string;
  acceptance: string;
  version: number;
  value: string | null;
  fingerprint: string | null;
  reasons: string;
  judgment_rejects: number;
  schema_rejects: number;
  seal_of: string | null;
  terminal: number;
  updated_at: number;
}

function mapArtifact(r: ArtifactRowRaw): ArtifactRow {
  const out: ArtifactRow = {
    id: r.id,
    workflow: r.workflow,
    path: r.path,
    producer: r.producer,
    acceptance: r.acceptance as Acceptance,
    version: r.version,
    reasons: fromJson<ReasonEntry[]>(r.reasons, []),
    judgmentRejects: r.judgment_rejects,
    schemaRejects: r.schema_rejects,
    terminal: r.terminal === 1,
    updatedAt: r.updated_at,
  };
  const value = fromJson<Record<string, unknown> | undefined>(r.value, undefined);
  if (value !== undefined) out.value = value;
  const fp = fromJson<Fingerprint | undefined>(r.fingerprint, undefined);
  if (fp !== undefined) out.fingerprint = fp;
  if (r.seal_of !== null) out.sealOf = r.seal_of;
  return out;
}

interface TaskRowRaw {
  id: string;
  workflow: string;
  loop: string;
  key: string;
  status: string;
  run: string | null;
  claimed_at: number | null;
  attempts: number;
  alarm_at: number | null;
  updated_at: number;
}

function mapTask(r: TaskRowRaw): TaskRow {
  const out: TaskRow = {
    id: r.id,
    workflow: r.workflow,
    loop: r.loop,
    key: r.key,
    status: r.status as TaskData['status'],
    attempts: r.attempts,
    updatedAt: r.updated_at,
  };
  if (r.run !== null) out.run = r.run;
  if (r.claimed_at !== null) out.claimedAt = r.claimed_at;
  if (r.alarm_at !== null) out.alarmAt = r.alarm_at;
  return out;
}

interface RunRowRaw {
  id: string;
  workflow: string;
  loop: string;
  key: string;
  outcome: string | null;
  summary: string | null;
  session_id: string | null;
  fingerprint: string | null;
  cause: string | null;
  created_at: number;
  updated_at: number;
}

function mapRun(r: RunRowRaw): RunRow {
  const out: RunRow = {
    id: r.id,
    workflow: r.workflow,
    loop: r.loop,
    key: r.key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.outcome !== null) out.outcome = r.outcome as RunData['outcome'];
  if (r.summary !== null) out.summary = r.summary;
  if (r.session_id !== null) out.sessionId = r.session_id;
  const fp = fromJson<Fingerprint | undefined>(r.fingerprint, undefined);
  if (fp !== undefined) out.fingerprint = fp;
  if (r.cause !== null) out.cause = r.cause as RunData['cause'];
  return out;
}

interface WorkflowRowRaw {
  id: string;
  def: string;
  title: string | null;
  params: string;
  created_at: number;
}

function mapWorkflow(r: WorkflowRowRaw): WorkflowRow {
  const out: WorkflowRow = {
    id: r.id,
    def: r.def,
    params: fromJson<Record<string, string>>(r.params, {}),
    createdAt: r.created_at,
  };
  if (r.title !== null) out.title = r.title;
  return out;
}

// ---- the store ---------------------------------------------------------------

export class Store {
  readonly db: DB;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.migrate();
    const cur = this.getMeta('schema_version');
    if (cur !== SCHEMA_VERSION) this.setMeta('schema_version', SCHEMA_VERSION);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Bring an older on-disk schema forward in place. SQLite's `CREATE TABLE IF
   * NOT EXISTS` won't add a column to a pre-existing table, so a v1 database
   * (no `schema_rejects`) needs an explicit `ALTER TABLE`. Additive and
   * idempotent — safe to run on every open.
   */
  private migrate(): void {
    const artifactCols = this.db.prepare(`PRAGMA table_info(artifact)`).all() as Array<{ name: string }>;
    if (!artifactCols.some((c) => c.name === 'schema_rejects')) {
      this.db.exec(`ALTER TABLE artifact ADD COLUMN schema_rejects INTEGER NOT NULL DEFAULT 0`);
    }
    const runCols = this.db.prepare(`PRAGMA table_info(run)`).all() as Array<{ name: string }>;
    if (!runCols.some((c) => c.name === 'cause')) {
      this.db.exec(`ALTER TABLE run ADD COLUMN cause TEXT`);
    }
    const taskCols = this.db.prepare(`PRAGMA table_info(task)`).all() as Array<{ name: string }>;
    if (!taskCols.some((c) => c.name === 'alarm_at')) {
      this.db.exec(`ALTER TABLE task ADD COLUMN alarm_at INTEGER`);
    }
  }

  /**
   * Run `fn` in a `BEGIN IMMEDIATE` transaction (write lock acquired up front).
   * Returns fn's result; rolls back if it throws. This is the only correct way
   * to do the engine's read-modify-write so concurrent ticks serialize.
   */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  // -- meta --------------------------------------------------------------------

  getMeta(k: string): string | undefined {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as
      | { v: string }
      | undefined;
    return row?.v;
  }
  setMeta(k: string, v: string): void {
    this.db
      .prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, v);
  }

  // -- workflow ----------------------------------------------------------------

  insertWorkflow(id: string, data: WorkflowData): WorkflowRow {
    const at = nowMs();
    this.db
      .prepare('INSERT INTO workflow (id, def, title, params, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, data.def, data.title ?? null, JSON.stringify(data.params ?? {}), at);
    return this.getWorkflow(id) as WorkflowRow;
  }

  getWorkflow(id: string): WorkflowRow | undefined {
    const r = this.db.prepare('SELECT * FROM workflow WHERE id = ?').get(id) as
      | WorkflowRowRaw
      | undefined;
    return r ? mapWorkflow(r) : undefined;
  }

  listWorkflows(): WorkflowRow[] {
    const rows = this.db
      .prepare('SELECT * FROM workflow ORDER BY created_at')
      .all() as WorkflowRowRaw[];
    return rows.map(mapWorkflow);
  }

  deleteWorkflow(id: string): void {
    this.db.prepare('DELETE FROM artifact WHERE workflow = ?').run(id);
    this.db.prepare('DELETE FROM task WHERE workflow = ?').run(id);
    this.db.prepare('DELETE FROM run WHERE workflow = ?').run(id);
    this.db.prepare('DELETE FROM workflow WHERE id = ?').run(id);
  }

  // -- artifact ----------------------------------------------------------------

  getArtifact(workflow: string, path: string): ArtifactRow | undefined {
    return this.getArtifactById(artifactId(workflow, path));
  }

  getArtifactById(id: string): ArtifactRow | undefined {
    const r = this.db.prepare('SELECT * FROM artifact WHERE id = ?').get(id) as
      | ArtifactRowRaw
      | undefined;
    return r ? mapArtifact(r) : undefined;
  }

  listArtifacts(workflow: string): ArtifactRow[] {
    const rows = this.db
      .prepare('SELECT * FROM artifact WHERE workflow = ? ORDER BY path')
      .all(workflow) as ArtifactRowRaw[];
    return rows.map(mapArtifact);
  }

  /** Insert or fully replace the artifact at (workflow, path). */
  putArtifact(data: ArtifactData): ArtifactRow {
    const id = artifactId(data.workflow, data.path);
    const at = nowMs();
    this.db
      .prepare(
        `INSERT INTO artifact
           (id, workflow, path, producer, acceptance, version, value, fingerprint,
            reasons, judgment_rejects, schema_rejects, seal_of, terminal, updated_at)
         VALUES (@id, @workflow, @path, @producer, @acceptance, @version, @value, @fingerprint,
            @reasons, @judgment_rejects, @schema_rejects, @seal_of, @terminal, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           producer = excluded.producer,
           acceptance = excluded.acceptance,
           version = excluded.version,
           value = excluded.value,
           fingerprint = excluded.fingerprint,
           reasons = excluded.reasons,
           judgment_rejects = excluded.judgment_rejects,
           schema_rejects = excluded.schema_rejects,
           seal_of = excluded.seal_of,
           terminal = excluded.terminal,
           updated_at = excluded.updated_at`,
      )
      .run({
        id,
        workflow: data.workflow,
        path: data.path,
        producer: data.producer,
        acceptance: data.acceptance,
        version: data.version,
        value: toJson(data.value),
        fingerprint: toJson(data.fingerprint),
        reasons: JSON.stringify(data.reasons ?? []),
        judgment_rejects: data.judgmentRejects,
        schema_rejects: data.schemaRejects,
        seal_of: data.sealOf ?? null,
        terminal: data.terminal ? 1 : 0,
        updated_at: at,
      });
    return this.getArtifactById(id) as ArtifactRow;
  }

  deleteArtifact(workflow: string, path: string): void {
    this.db.prepare('DELETE FROM artifact WHERE id = ?').run(artifactId(workflow, path));
  }

  // -- task --------------------------------------------------------------------

  getTask(workflow: string, loop: string, key: string): TaskRow | undefined {
    const r = this.db.prepare('SELECT * FROM task WHERE id = ?').get(taskId(workflow, loop, key)) as
      | TaskRowRaw
      | undefined;
    return r ? mapTask(r) : undefined;
  }

  listTasks(workflow: string): TaskRow[] {
    const rows = this.db
      .prepare('SELECT * FROM task WHERE workflow = ? ORDER BY loop, key')
      .all(workflow) as TaskRowRaw[];
    return rows.map(mapTask);
  }

  listClaimedTasks(): TaskRow[] {
    const rows = this.db
      .prepare("SELECT * FROM task WHERE status = 'claimed' ORDER BY claimed_at")
      .all() as TaskRowRaw[];
    return rows.map(mapTask);
  }

  putTask(data: TaskData): TaskRow {
    const id = taskId(data.workflow, data.loop, data.key);
    const at = nowMs();
    this.db
      .prepare(
        `INSERT INTO task (id, workflow, loop, key, status, run, claimed_at, attempts, alarm_at, updated_at)
         VALUES (@id, @workflow, @loop, @key, @status, @run, @claimed_at, @attempts, @alarm_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           run = excluded.run,
           claimed_at = excluded.claimed_at,
           attempts = excluded.attempts,
           alarm_at = excluded.alarm_at,
           updated_at = excluded.updated_at`,
      )
      .run({
        id,
        workflow: data.workflow,
        loop: data.loop,
        key: data.key,
        status: data.status,
        run: data.run ?? null,
        claimed_at: data.claimedAt ?? null,
        attempts: data.attempts,
        alarm_at: data.alarmAt ?? null,
        updated_at: at,
      });
    return this.getTask(data.workflow, data.loop, data.key) as TaskRow;
  }

  /** Read the stored alarm_at for (workflow, loop), or undefined if not set. */
  getAlarm(workflow: string, loop: string): number | undefined {
    const t = this.getTask(workflow, loop, '');
    return t?.alarmAt;
  }

  /** Persist an absolute alarm time for an idle evaluator loop. */
  setAlarm(workflow: string, loop: string, at: number): void {
    const id = taskId(workflow, loop, '');
    const existing = this.getTask(workflow, loop, '');
    if (existing) {
      this.db.prepare('UPDATE task SET alarm_at = ?, updated_at = ? WHERE id = ?')
        .run(at, nowMs(), id);
    } else {
      // Rare: evaluator loop has never been ticked. Insert a minimal idle row.
      this.putTask({ workflow, loop, key: '', status: 'idle', attempts: 0, alarmAt: at });
    }
  }

  /** Clear the alarm (set alarm_at = NULL). */
  clearAlarm(workflow: string, loop: string): void {
    const id = taskId(workflow, loop, '');
    this.db.prepare('UPDATE task SET alarm_at = NULL, updated_at = ? WHERE id = ?')
      .run(nowMs(), id);
  }

  /**
   * Derive last_progress as MAX(artifact.updated_at) for the workflow.
   * Returns 0 if no artifacts exist yet.
   */
  lastProgressMs(workflow: string): number {
    const row = this.db
      .prepare('SELECT MAX(updated_at) AS t FROM artifact WHERE workflow = ?')
      .get(workflow) as { t: number | null };
    return row.t ?? 0;
  }

  // -- run ---------------------------------------------------------------------

  insertRun(id: string, data: RunData, at: number = nowMs()): RunRow {
    this.db
      .prepare(
        `INSERT INTO run (id, workflow, loop, key, outcome, summary, session_id, fingerprint, cause, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, data.workflow, data.loop, data.key ?? '', data.outcome ?? null, data.summary ?? null,
        data.sessionId ?? null, toJson(data.fingerprint), data.cause ?? null, at, at);
    return this.getRun(id) as RunRow;
  }

  updateRun(id: string, patch: Partial<RunData>): RunRow {
    const cur = this.getRun(id);
    if (!cur) throw new Error(`run not found: ${id}`);
    const merged: RunData = {
      workflow: cur.workflow,
      loop: cur.loop,
      key: patch.key ?? cur.key,
      outcome: patch.outcome ?? cur.outcome,
      summary: patch.summary ?? cur.summary,
      sessionId: patch.sessionId ?? cur.sessionId,
      fingerprint: patch.fingerprint ?? cur.fingerprint,
      cause: patch.cause ?? cur.cause,
    };
    this.db
      .prepare(
        'UPDATE run SET key = ?, outcome = ?, summary = ?, session_id = ?, fingerprint = ?, cause = ?, updated_at = ? WHERE id = ?',
      )
      .run(merged.key ?? '', merged.outcome ?? null, merged.summary ?? null, merged.sessionId ?? null,
        toJson(merged.fingerprint), merged.cause ?? null, nowMs(), id);
    return this.getRun(id) as RunRow;
  }

  getRun(id: string): RunRow | undefined {
    const r = this.db.prepare('SELECT * FROM run WHERE id = ?').get(id) as RunRowRaw | undefined;
    return r ? mapRun(r) : undefined;
  }

  /** How many runs of this loop since `sinceMs` (for the daily budget window). */
  countRuns(workflow: string, loop: string, sinceMs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM run WHERE workflow = ? AND loop = ? AND created_at >= ?')
      .get(workflow, loop, sinceMs) as { n: number };
    return row.n;
  }

  /** The most recent run of this loop, if any (for cadence gating). */
  latestRun(workflow: string, loop: string): RunRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM run WHERE workflow = ? AND loop = ? ORDER BY created_at DESC LIMIT 1')
      .get(workflow, loop) as RunRowRaw | undefined;
    return r ? mapRun(r) : undefined;
  }

  /**
   * Count of consecutive trailing `failed` runs for this loop+key — the
   * crash-loop signal. Any closed run that is NOT `failed` (ok/no_work/skipped)
   * breaks the streak; still-open runs (outcome NULL) are ignored.
   */
  recentFailedRuns(workflow: string, loop: string, key: string = ''): number {
    const rows = this.db
      .prepare(
        // rowid DESC is the tiebreaker: two runs closed in the same millisecond
        // (or a clock that didn't advance) must still order by insertion, or a
        // trailing failed→ok pair could read in the wrong order and miscount.
        'SELECT outcome FROM run WHERE workflow = ? AND loop = ? AND key = ? AND outcome IS NOT NULL ORDER BY created_at DESC, rowid DESC',
      )
      .all(workflow, loop, key) as Array<{ outcome: string }>;
    let n = 0;
    for (const r of rows) {
      if (r.outcome === 'failed') n++;
      else break;
    }
    return n;
  }

  /**
   * All runs for a workflow instance, ordered by created_at then rowid for a
   * stable insertion-order tiebreak (consistent with recentFailedRuns and the
   * run_wf_loop index). The rowid tiebreak matters in test environments where
   * nowMs() may not advance between successive insertions.
   */
  listRuns(workflow: string): RunRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM run WHERE workflow = ? ORDER BY created_at, rowid',
      )
      .all(workflow) as RunRowRaw[];
    return rows.map(mapRun);
  }
}

/** Open (creating if needed) a store at `path`. */
export function openStore(path: string): Store {
  return new Store(path);
}
