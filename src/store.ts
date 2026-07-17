/**
 * Persistence layer — a thin, typed wrapper over SQLite (node:sqlite).
 *
 * The store knows nothing about eligibility, firing, or cascades; it is pure
 * data access. The engine performs read-modify-write *inside* `tx()`, which
 * runs the callback in a `BEGIN IMMEDIATE` transaction. Because node:sqlite
 * (DatabaseSync) is synchronous and single-connection-per-process, everything
 * inside that callback is atomic; across processes, `BEGIN IMMEDIATE` takes the
 * write lock up front so the commit-fingerprint CAS (design §12) is serialized
 * — no torn reads between a claim and its commit.
 *
 * JSON-shaped fields (value, fingerprint, reasons, params) are stored as TEXT
 * and (de)serialized at the boundary so callers always see real objects.
 */

import { DatabaseSync } from 'node:sqlite';
import { detId, nowMs } from './util.ts';
import type {
  Acceptance,
  ArtifactData,
  ArtifactEvent,
  ArtifactHistory,
  ArtifactVersion,
  Fingerprint,
  Order,
  ReasonEntry,
  RunData,
  TaskData,
  WorkflowData,
  WorkflowDef,
} from './types.ts';

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
  /** Mode 2 foundation: parent workflow coordinate for a child instance spawned by a calls: step. */
  producedBy?: { parentWf: string; parentPath: string };
}

// ---- deterministic ids -------------------------------------------------------

export function artifactId(workflow: string, path: string): string {
  return detId('art', workflow, path);
}
export function taskId(workflow: string, step: string, key: string): string {
  return detId('task', workflow, step, key);
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
  approvals        TEXT,
  updated_at       INTEGER NOT NULL,
  UNIQUE (workflow, path)
);
CREATE INDEX IF NOT EXISTS artifact_wf ON artifact (workflow);
CREATE INDEX IF NOT EXISTS artifact_wf_accept ON artifact (workflow, acceptance);

-- Immutable audit history.  artifact remains the small current-state projection.
CREATE TABLE IF NOT EXISTS artifact_version (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  producer TEXT NOT NULL,
  value TEXT,
  fingerprint TEXT,
  initial_acceptance TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workflow, path, version)
);
CREATE INDEX IF NOT EXISTS artifact_version_wf_path ON artifact_version (workflow, path, version);

CREATE TABLE IF NOT EXISTS artifact_event (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  kind TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifact_event_wf_path_version_at ON artifact_event (workflow, path, version, created_at, id);

CREATE TABLE IF NOT EXISTS task (
  id          TEXT PRIMARY KEY,
  workflow    TEXT NOT NULL,
  step        TEXT NOT NULL,
  key         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'idle',
  run         TEXT,
  claimed_at  INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  alarm_at    INTEGER,
  heartbeat_at INTEGER,
  updated_at  INTEGER NOT NULL,
  UNIQUE (workflow, step, key)
);
CREATE INDEX IF NOT EXISTS task_wf ON task (workflow);
CREATE INDEX IF NOT EXISTS task_claimed ON task (status, claimed_at);

CREATE TABLE IF NOT EXISTS run (
  id          TEXT PRIMARY KEY,
  workflow    TEXT NOT NULL,
  step        TEXT NOT NULL,
  key         TEXT NOT NULL DEFAULT '',
  outcome     TEXT,
  summary     TEXT,
  session_id  TEXT,
  fingerprint TEXT,
  cause       TEXT,
  -- The flattened order packet issued at claim time (§8 / Gap 1), JSON in TEXT
  -- (precedent: fingerprint, def_snapshot). Named order_json, NOT order — ORDER
  -- is a reserved SQL keyword. Nullable: absent on runs created before v7.
  order_json  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS run_wf_step ON run (workflow, step, created_at);
-- recentFailedRuns filters by key too; this index lets it walk the trailing
-- runs of one step+key in order without scanning the whole step's history.
CREATE INDEX IF NOT EXISTS run_wf_step_key ON run (workflow, step, key, created_at);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

/**
 * The schema version this binary understands. Bump when `migrate()` gains a
 * new additive step. Invariant: `schema_version` in the `meta` table must
 * never be written downward — the `Store` constructor refuses to open
 * (throwing `StoreVersionError`) a database whose stored schema_version is
 * numerically greater than this binary's, rather than silently stamping it
 * back down and running with a stale, incomplete understanding of a newer
 * on-disk schema.
 *
 * Bumped to '6' for instance-to-definition pinning (§28): the `workflow`
 * table gains `def_snapshot`/`def_hash` columns (see `migrate()`).
 *
 * Bumped to '7' for claim-time order-packet persistence (§8 / Gap 1): the `run`
 * table gains `order_json` (see `migrate()`).
 * Bumped to '8' for REL-5: a partial UNIQUE index on the child-instance
 * parent-coordinates (`produced_by_wf`, `produced_by_path`) so two concurrent
 * driver ticks cannot each insert a child for the same `calls:` step.
 *
 * Bumped to '9' for immutable artifact payload/version and lifecycle-event history.
 */
const SCHEMA_VERSION = '9';

/** Thrown by the `Store` constructor when the on-disk `schema_version` is
 *  newer than this binary's `SCHEMA_VERSION` — the operator needs to
 *  upgrade their owenloop install to open this database. */
export class StoreVersionError extends Error {}

// ---- (de)serialization helpers ----------------------------------------------

function toJson(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

/**
 * Key-order-independent canonical serialization of a JSON-shaped value.
 * Plain objects are rebuilt with their keys sorted and `undefined`-valued
 * properties dropped (mirroring `JSON.stringify`, so `{ x: undefined }` and
 * `{}` canonicalize the same). Array order is preserved — `reasons` is an
 * append-only thread whose order is significant. Values passed here already
 * round-trip through JSON columns, so no Date/Map/cycle handling is needed.
 * Used by `putArtifact` to decide "changed vs no-op" without being fooled by
 * property insertion order (which would append a false `artifact_event`).
 */
function canonicalJson(v: unknown): string {
  return JSON.stringify(canonicalize(v));
}
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v !== null && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] !== undefined) out[k] = canonicalize(src[k]);
    }
    return out;
  }
  return v;
}

/**
 * The semantic fields of an artifact that define "has this changed?" — an
 * explicit projection so identity/timestamp columns (`id`, `updatedAt`) and
 * insertion order never influence the decision. `terminal` is normalized to a
 * boolean because `mapArtifact` always materializes it while callers may omit
 * it; without this, every repeat write that omits `terminal` would read as
 * changed and append a false event.
 */
function artifactSemantics(x: ArtifactData): unknown {
  return {
    workflow: x.workflow,
    path: x.path,
    producer: x.producer,
    acceptance: x.acceptance,
    version: x.version,
    value: x.value,
    fingerprint: x.fingerprint,
    reasons: x.reasons,
    judgmentRejects: x.judgmentRejects,
    schemaRejects: x.schemaRejects,
    sealOf: x.sealOf,
    terminal: x.terminal ?? false,
    approvals: x.approvals,
  };
}
function fromJson<T>(s: unknown, fallback: T, ctx: { table: string; id: string; column: string }): T {
  if (s === null || s === undefined) return fallback;
  try {
    return JSON.parse(s as string) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Corrupt JSON in ${ctx.table}.${ctx.column} for row ${ctx.id}: ${msg}`);
  }
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
  approvals: string | null;
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
    reasons: fromJson<ReasonEntry[]>(r.reasons, [], { table: 'artifact', id: r.id, column: 'reasons' }),
    judgmentRejects: r.judgment_rejects,
    schemaRejects: r.schema_rejects,
    terminal: r.terminal === 1,
    updatedAt: r.updated_at,
  };
  const value = fromJson<Record<string, unknown> | undefined>(r.value, undefined, {
    table: 'artifact',
    id: r.id,
    column: 'value',
  });
  if (value !== undefined) out.value = value;
  const fp = fromJson<Fingerprint | undefined>(r.fingerprint, undefined, {
    table: 'artifact',
    id: r.id,
    column: 'fingerprint',
  });
  if (fp !== undefined) out.fingerprint = fp;
  if (r.seal_of !== null) out.sealOf = r.seal_of;
  const approvals = fromJson<Record<string, number> | undefined>(r.approvals, undefined, {
    table: 'artifact',
    id: r.id,
    column: 'approvals',
  });
  if (approvals !== undefined) out.approvals = approvals;
  return out;
}

interface ArtifactVersionRaw {
  id: string; workflow: string; path: string; version: number; producer: string;
  value: string | null; fingerprint: string | null; initial_acceptance: string; created_at: number;
}
interface ArtifactEventRaw {
  id: string; workflow: string; path: string; version: number; action: string; actor: string;
  reason: string | null; kind: string | null; metadata: string | null; created_at: number;
}
function mapArtifactVersion(r: ArtifactVersionRaw): ArtifactVersion {
  const out: ArtifactVersion = {
    id: r.id, workflow: r.workflow, path: r.path, version: r.version, producer: r.producer,
    initialAcceptance: r.initial_acceptance as Acceptance, createdAt: r.created_at,
  };
  const value = fromJson<Record<string, unknown> | undefined>(r.value, undefined, { table: 'artifact_version', id: r.id, column: 'value' });
  const fingerprint = fromJson<Fingerprint | undefined>(r.fingerprint, undefined, { table: 'artifact_version', id: r.id, column: 'fingerprint' });
  if (value !== undefined) out.value = value;
  if (fingerprint !== undefined) out.fingerprint = fingerprint;
  return out;
}
function mapArtifactEvent(r: ArtifactEventRaw): ArtifactEvent {
  const out: ArtifactEvent = {
    id: r.id, workflow: r.workflow, path: r.path, version: r.version, action: r.action,
    actor: r.actor, timestamp: r.created_at,
  };
  if (r.reason !== null) out.reason = r.reason;
  if (r.kind !== null) out.kind = r.kind as ArtifactEvent['kind'];
  const metadata = fromJson<Record<string, unknown> | undefined>(r.metadata, undefined, { table: 'artifact_event', id: r.id, column: 'metadata' });
  if (metadata !== undefined) out.metadata = metadata;
  return out;
}

interface TaskRowRaw {
  id: string;
  workflow: string;
  step: string;
  key: string;
  status: string;
  run: string | null;
  claimed_at: number | null;
  attempts: number;
  alarm_at: number | null;
  heartbeat_at: number | null;
  updated_at: number;
}

function mapTask(r: TaskRowRaw): TaskRow {
  const out: TaskRow = {
    id: r.id,
    workflow: r.workflow,
    step: r.step,
    key: r.key,
    status: r.status as TaskData['status'],
    attempts: r.attempts,
    updatedAt: r.updated_at,
  };
  if (r.run !== null) out.run = r.run;
  if (r.claimed_at !== null) out.claimedAt = r.claimed_at;
  if (r.alarm_at !== null) out.alarmAt = r.alarm_at;
  if (r.heartbeat_at !== null) out.heartbeatAt = r.heartbeat_at;
  return out;
}

interface RunRowRaw {
  id: string;
  workflow: string;
  step: string;
  key: string;
  outcome: string | null;
  summary: string | null;
  session_id: string | null;
  fingerprint: string | null;
  cause: string | null;
  order_json: string | null;
  created_at: number;
  updated_at: number;
}

function mapRun(r: RunRowRaw): RunRow {
  const out: RunRow = {
    id: r.id,
    workflow: r.workflow,
    step: r.step,
    key: r.key,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.outcome !== null) out.outcome = r.outcome as RunData['outcome'];
  if (r.summary !== null) out.summary = r.summary;
  if (r.session_id !== null) out.sessionId = r.session_id;
  const fp = fromJson<Fingerprint | undefined>(r.fingerprint, undefined, {
    table: 'run',
    id: r.id,
    column: 'fingerprint',
  });
  if (fp !== undefined) out.fingerprint = fp;
  if (r.cause !== null) out.cause = r.cause as RunData['cause'];
  const order = fromJson<Order | undefined>(r.order_json, undefined, {
    table: 'run',
    id: r.id,
    column: 'order_json',
  });
  if (order !== undefined) out.order = order;
  return out;
}

interface WorkflowRowRaw {
  id: string;
  def: string;
  title: string | null;
  params: string;
  produced_by_wf: string | null;
  produced_by_path: string | null;
  def_snapshot: string | null;
  def_hash: string | null;
  created_at: number;
}

function mapWorkflow(r: WorkflowRowRaw): WorkflowRow {
  const out: WorkflowRow = {
    id: r.id,
    def: r.def,
    params: fromJson<Record<string, string>>(r.params, {}, { table: 'workflow', id: r.id, column: 'params' }),
    createdAt: r.created_at,
  };
  if (r.title !== null) out.title = r.title;
  if (r.produced_by_wf !== null && r.produced_by_path !== null) {
    out.producedBy = { parentWf: r.produced_by_wf, parentPath: r.produced_by_path };
  }
  const defSnapshot = fromJson<WorkflowDef | undefined>(r.def_snapshot, undefined, {
    table: 'workflow',
    id: r.id,
    column: 'def_snapshot',
  });
  if (defSnapshot !== undefined) out.defSnapshot = defSnapshot;
  if (r.def_hash !== null) out.defHash = r.def_hash;
  return out;
}

// ---- the store ---------------------------------------------------------------

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // Connection-scoped only — no file mutation, safe before the version check.
    this.db.exec('PRAGMA busy_timeout = 5000');

    // Refuse an on-disk schema newer than this binary before any file-mutating
    // pragma or DDL. Re-check again under the migration write lock below.
    try {
      this.refuseIfNewer();
    } catch (err) {
      this.db.close();
      throw err;
    }

    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA synchronous = NORMAL');

    try {
      this.tx(() => {
		const cur = this.refuseIfNewer();
		this.premigrate();
		this.db.exec(SCHEMA);
		// Version 9 introduces immutable history. Earlier databases have no
		// retained historical payloads, but their lifecycle reasons can be
		// copied into append-only events exactly once.
		const backfillLegacyEvents = cur !== undefined && parseInt(cur, 10) < 9;
		this.migrate(backfillLegacyEvents);
		if (cur !== SCHEMA_VERSION) this.setMeta('schema_version', SCHEMA_VERSION);
      });
    } catch (err) {
      if (err instanceof StoreVersionError) this.db.close();
      throw err;
    }
  }

  /** Read the stored schema version without writing, refusing newer databases. */
  private refuseIfNewer(): string | undefined {
    const metaExists =
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get() !== undefined;
    if (!metaExists) return undefined;
    const cur = this.getMeta('schema_version');
    if (cur !== undefined && parseInt(cur, 10) > parseInt(SCHEMA_VERSION, 10)) {
      throw new StoreVersionError(
		`database schema_version ${cur} is newer than this owenloop's schema_version ${SCHEMA_VERSION}; ` +
		`upgrade your owenloop install to open this database`,
      );
    }
    return cur;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Pre-schema migration: rename the legacy `loop` column to `step` on an
   * existing database BEFORE `exec(SCHEMA)` runs, because the schema's
   * `run_wf_step` index references the renamed column and would fail against an
   * old table still spelling it `loop`. SQLite's `RENAME COLUMN` also rewrites
   * the table's own `UNIQUE (workflow, loop, key)` constraint to reference
   * `step`. No-op on a fresh database (the tables don't exist yet) and
   * idempotent on an already-migrated one. Terminology: a workflow node is a
   * "step", not a "loop".
   */
  private premigrate(): void {
    const tableExists = (name: string): boolean =>
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
    const columns = (table: string): string[] =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

    if (tableExists('task')) {
      const cols = columns('task');
      if (cols.includes('loop') && !cols.includes('step')) {
        this.db.exec(`ALTER TABLE task RENAME COLUMN loop TO step`);
      }
    }
    if (tableExists('run')) {
      const cols = columns('run');
      if (cols.includes('loop') && !cols.includes('step')) {
        this.db.exec(`ALTER TABLE run RENAME COLUMN loop TO step`);
      }
      // Legacy-named indexes; the schema recreates them as run_wf_step / run_wf_step_key.
      this.db.exec(`DROP INDEX IF EXISTS run_wf_loop`);
      this.db.exec(`DROP INDEX IF EXISTS run_wf_loop_key`);
    }
  }

  /**
   * Bring an older on-disk schema forward in place. SQLite's `CREATE TABLE IF
   * NOT EXISTS` won't add a column to a pre-existing table, so a v1 database
   * (no `schema_rejects`) needs an explicit `ALTER TABLE`. Additive and
   * idempotent — safe to run on every open.
   */
  private migrate(backfillLegacyEvents: boolean): void {
    const artifactCols = this.db.prepare(`PRAGMA table_info(artifact)`).all() as Array<{ name: string }>;
    if (!artifactCols.some((c) => c.name === 'schema_rejects')) {
      this.db.exec(`ALTER TABLE artifact ADD COLUMN schema_rejects INTEGER NOT NULL DEFAULT 0`);
    }
    const runCols = this.db.prepare(`PRAGMA table_info(run)`).all() as Array<{ name: string }>;
    if (!runCols.some((c) => c.name === 'cause')) {
      this.db.exec(`ALTER TABLE run ADD COLUMN cause TEXT`);
    }
    // §8 / Gap 1: claim-time order-packet persistence (schema v7).
    if (!runCols.some((c) => c.name === 'order_json')) {
      this.db.exec(`ALTER TABLE run ADD COLUMN order_json TEXT`);
    }
    const taskCols = this.db.prepare(`PRAGMA table_info(task)`).all() as Array<{ name: string }>;
    if (!taskCols.some((c) => c.name === 'alarm_at')) {
      this.db.exec(`ALTER TABLE task ADD COLUMN alarm_at INTEGER`);
    }
    if (!taskCols.some((c) => c.name === 'heartbeat_at')) {
      this.db.exec(`ALTER TABLE task ADD COLUMN heartbeat_at INTEGER`);
    }
    // M2-LINK (§4.2, R11): nullable parent-coordinate columns for calls: child instances.
    const wfCols = this.db.prepare(`PRAGMA table_info(workflow)`).all() as Array<{ name: string }>;
    if (!wfCols.some((c) => c.name === 'produced_by_wf')) {
      this.db.exec(`ALTER TABLE workflow ADD COLUMN produced_by_wf TEXT`);
    }
    if (!wfCols.some((c) => c.name === 'produced_by_path')) {
      this.db.exec(`ALTER TABLE workflow ADD COLUMN produced_by_path TEXT`);
    }
    // Reverse-lookup index (CREATE INDEX IF NOT EXISTS is idempotent).
    this.db.exec(`CREATE INDEX IF NOT EXISTS workflow_produced_by ON workflow(produced_by_wf, produced_by_path)`);
    // REL-5 (schema v8): make duplicate calls: children physically impossible
    // for future writers. Legacy duplicates are tolerated until cleaned up.
    const dupe = this.db
      .prepare(
        `SELECT 1 FROM workflow
           WHERE produced_by_wf IS NOT NULL AND produced_by_path IS NOT NULL
           GROUP BY produced_by_wf, produced_by_path
           HAVING COUNT(*) > 1
           LIMIT 1`,
      )
      .get();
    if (dupe === undefined) {
      this.db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS workflow_produced_by_unique
           ON workflow(produced_by_wf, produced_by_path)
           WHERE produced_by_wf IS NOT NULL AND produced_by_path IS NOT NULL`,
      );
    }
    // §24: judges — the per-version sign-off ledger (judge name -> approved version).
    if (!artifactCols.some((c) => c.name === 'approvals')) {
      this.db.exec(`ALTER TABLE artifact ADD COLUMN approvals TEXT`);
    }
    // Instance-to-definition pinning (§28): snapshot the compiled def + a
    // content hash at create time so a running instance is not silently
    // rewired when the source YAML changes underneath it.
    if (!wfCols.some((c) => c.name === 'def_snapshot')) {
      this.db.exec(`ALTER TABLE workflow ADD COLUMN def_snapshot TEXT`);
    }
    if (!wfCols.some((c) => c.name === 'def_hash')) {
      this.db.exec(`ALTER TABLE workflow ADD COLUMN def_hash TEXT`);
    }

    // Only a genuine pre-v8 -> v8 upgrade may backfill the current projection's
    // reason thread. Re-opening an already-v8 database must not manufacture a
    // second copy of its lifecycle events (even though the legacy keys differ
    // from regular reason-event keys). Historical payloads overwritten before
    // v8 remain unrecoverable by design.
    if (backfillLegacyEvents) {
	const legacy = this.db.prepare('SELECT * FROM artifact').all() as unknown as ArtifactRowRaw[];
	for (const raw of legacy) {
	  const art = mapArtifact(raw);
	  for (let i = 0; i < art.reasons.length; i++) {
	    const reason = art.reasons[i]!;
	    this.insertArtifactEvent({
	      workflow: art.workflow, path: art.path,
	      version: reason.fromVersion ?? art.version,
	      action: reason.action, actor: reason.by, reason: reason.text,
	      timestamp: reason.at, kind: reason.kind,
	      key: `legacy:${i}:${reason.at}:${reason.action}:${reason.by}:${reason.text}`,
	    });
	  }
	}
    }
  }

  /**
   * Run `fn` in a `BEGIN IMMEDIATE` transaction (write lock acquired up front).
   * Returns fn's result; rolls back and rethrows if fn throws.
   * This is the only correct way to do the engine's read-modify-write so
   * concurrent ticks serialize. Never call tx() re-entrantly — node:sqlite
   * does not support nested transactions.
   */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

  insertWorkflow(id: string, data: WorkflowData, producedBy?: { parentWf: string; parentPath: string }): WorkflowRow {
    const at = nowMs();
    this.db
      .prepare(
        `INSERT INTO workflow
           (id, def, title, params, produced_by_wf, produced_by_path, def_snapshot, def_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.def,
        data.title ?? null,
        JSON.stringify(data.params ?? {}),
        producedBy?.parentWf ?? null,
        producedBy?.parentPath ?? null,
        toJson(data.defSnapshot),
        data.defHash ?? null,
        at,
      );
    return this.getWorkflow(id) as WorkflowRow;
  }

  /**
   * §28: re-pin `id` to a freshly-resolved def — overwrite its stored
   * snapshot/hash. Pure data access: the store does not compute hashes or
   * decide what "drift" means, it just persists what the engine computed.
   */
  repinWorkflowDef(id: string, snapshot: WorkflowDef, hash: string): void {
    this.db
      .prepare('UPDATE workflow SET def_snapshot = ?, def_hash = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), hash, id);
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
      .all() as unknown as WorkflowRowRaw[];
    return rows.map(mapWorkflow);
  }

  /** Deletes only this workflow's own rows (artifact/task/run/workflow). Does NOT
   * cascade to children spawned via calls: — see deleteWorkflowCascade for that. */
  deleteWorkflow(id: string): void {
    this.db.prepare('DELETE FROM artifact_event WHERE workflow = ?').run(id);
    this.db.prepare('DELETE FROM artifact_version WHERE workflow = ?').run(id);
    this.db.prepare('DELETE FROM artifact WHERE workflow = ?').run(id);
    this.db.prepare('DELETE FROM task WHERE workflow = ?').run(id);
    this.db.prepare('DELETE FROM run WHERE workflow = ?').run(id);
    this.db.prepare('DELETE FROM workflow WHERE id = ?').run(id);
  }

  /**
   * Recursively delete a workflow and all of its descendant instances (spawned
   * via calls:, see listChildrenByParent). Deletes children's children first,
   * then each child, then the workflow itself — full recursive cascade.
   */
  deleteWorkflowCascade(id: string): void {
    for (const child of this.listChildrenByParent(id)) {
      this.deleteWorkflowCascade(child.id);
    }
    this.deleteWorkflow(id);
  }

  /**
   * M2-LINK reverse-lookup: find the child workflow instance spawned by a calls: step.
   * Used by the calls: re-attach guard (never-duplicate). Returns undefined when no match.
   */
  findChildByParent(parentWf: string, parentPath: string): WorkflowRow | undefined {
    const r = this.db
      .prepare(
        'SELECT * FROM workflow WHERE produced_by_wf = ? AND produced_by_path = ? ORDER BY created_at, id LIMIT 1',
      )
      .get(parentWf, parentPath) as WorkflowRowRaw | undefined;
    return r ? mapWorkflow(r) : undefined;
  }

  /**
   * M2-LINK reverse-lookup: list all child workflow instances produced by a given parent workflow.
   */
  listChildrenByParent(parentWf: string): WorkflowRow[] {
    const rows = this.db
      .prepare('SELECT * FROM workflow WHERE produced_by_wf = ? ORDER BY created_at')
      .all(parentWf) as unknown as WorkflowRowRaw[];
    return rows.map(mapWorkflow);
  }

  // -- artifact ----------------------------------------------------------------

  getArtifact(workflow: string, path: string): ArtifactRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM artifact WHERE workflow = ? AND path = ?')
      .get(workflow, path) as ArtifactRowRaw | undefined;
    return r ? mapArtifact(r) : undefined;
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
      .all(workflow) as unknown as ArtifactRowRaw[];
    return rows.map(mapArtifact);
  }

  /** Insert or fully replace the artifact at (workflow, path). */
  putArtifact(data: ArtifactData, provenance?: { action?: string; actor?: string; reason?: string; kind?: string; timestamp?: number; key?: string }): ArtifactRow {
    const previous = this.getArtifact(data.workflow, data.path);
    const id = artifactId(data.workflow, data.path);
    const at = provenance?.timestamp ?? nowMs();
    this.db
      .prepare(
        `INSERT INTO artifact
           (id, workflow, path, producer, acceptance, version, value, fingerprint,
            reasons, judgment_rejects, schema_rejects, seal_of, terminal, approvals, updated_at)
         VALUES (@id, @workflow, @path, @producer, @acceptance, @version, @value, @fingerprint,
            @reasons, @judgment_rejects, @schema_rejects, @seal_of, @terminal, @approvals, @updated_at)
         ON CONFLICT(workflow, path) DO UPDATE SET
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
           approvals = excluded.approvals,
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
        approvals: toJson(data.approvals),
        updated_at: at,
      });
    const changed = !previous || canonicalJson(artifactSemantics(previous)) !== canonicalJson(artifactSemantics(data));
    if (changed) {
      if (data.version > 0 && (!previous || data.version > previous.version)) {
        this.db.prepare(
          `INSERT INTO artifact_version (id, workflow, path, version, producer, value, fingerprint, initial_acceptance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workflow, path, version) DO NOTHING`,
        ).run(detId('artver', data.workflow, data.path, String(data.version)), data.workflow, data.path, data.version,
          data.producer, toJson(data.value), toJson(data.fingerprint), data.acceptance, at);
      }
      const appended = previous ? data.reasons.slice(previous.reasons.length) : data.reasons;
      if (appended.length) {
        for (let i = 0; i < appended.length; i++) {
          const r = appended[i]!;
          this.insertArtifactEvent({ workflow: data.workflow, path: data.path, version: r.fromVersion ?? data.version,
            action: r.action, actor: r.by, reason: r.text, timestamp: r.at, kind: r.kind,
            key: `reason:${previous?.reasons.length ?? 0}:${i}:${r.at}:${r.action}:${r.by}:${r.text}` });
        }
      } else {
        const action = provenance?.action ?? (data.version > (previous?.version ?? 0)
          ? (data.acceptance === 'submitted' ? 'submitted' : 'produced')
          : data.acceptance !== previous?.acceptance ? data.acceptance : 'updated');
        this.insertArtifactEvent({ workflow: data.workflow, path: data.path, version: data.version, action,
          actor: provenance?.actor ?? (data.producer || 'engine'), reason: provenance?.reason,
          timestamp: at, kind: provenance?.kind, key: provenance?.key });
      }
    }
    return this.getArtifact(data.workflow, data.path) as ArtifactRow;
  }

  private insertArtifactEvent(event: { workflow: string; path: string; version: number; action: string; actor: string; reason?: string; timestamp: number; kind?: string; metadata?: Record<string, unknown>; key?: string }): void {
    const identity = event.key ?? `${event.action}:${event.actor}:${event.reason ?? ''}:${event.timestamp}:${event.kind ?? ''}`;
    const id = detId('artevt', event.workflow, event.path, String(event.version), identity);
    this.db.prepare(
      `INSERT INTO artifact_event (id, workflow, path, version, action, actor, reason, kind, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    ).run(id, event.workflow, event.path, event.version, event.action, event.actor, event.reason ?? null,
      event.kind ?? null, toJson(event.metadata), event.timestamp);
  }

  /** Returns history for exactly one artifact; list/status reads stay projection-only. */
  getArtifactHistory(workflow: string, path: string): ArtifactHistory | undefined {
    const current = this.getArtifact(workflow, path);
    if (!current) return undefined;
    const versions = (this.db.prepare(
      'SELECT * FROM artifact_version WHERE workflow = ? AND path = ? ORDER BY version, created_at, id',
    ).all(workflow, path) as unknown as ArtifactVersionRaw[]).map(mapArtifactVersion);
    const events = (this.db.prepare(
      'SELECT * FROM artifact_event WHERE workflow = ? AND path = ? ORDER BY created_at, id',
    ).all(workflow, path) as unknown as ArtifactEventRaw[]).map(mapArtifactEvent);
    const versioned = new Set(versions.map((v) => v.version));
    return {
      current,
      versions: versions.map((v) => ({ ...v, events: events.filter((e) => e.version === v.version) })),
      // A pre-v8 reason can point at an overwritten version whose payload
      // cannot be reconstructed. Keep that event visible at the artifact
      // level rather than silently dropping it from history.
      events: events.filter((e) => !versioned.has(e.version)),
    };
  }

  deleteArtifact(workflow: string, path: string): void {
    this.db.prepare('DELETE FROM artifact_event WHERE workflow = ? AND path = ?').run(workflow, path);
    this.db.prepare('DELETE FROM artifact_version WHERE workflow = ? AND path = ?').run(workflow, path);
    this.db.prepare('DELETE FROM artifact WHERE workflow = ? AND path = ?').run(workflow, path);
  }

  // -- task --------------------------------------------------------------------

  getTask(workflow: string, step: string, key: string): TaskRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM task WHERE workflow = ? AND step = ? AND key = ?')
      .get(workflow, step, key) as TaskRowRaw | undefined;
    return r ? mapTask(r) : undefined;
  }

  listTasks(workflow: string): TaskRow[] {
    const rows = this.db
      .prepare('SELECT * FROM task WHERE workflow = ? ORDER BY step, key')
      .all(workflow) as unknown as TaskRowRaw[];
    return rows.map(mapTask);
  }

  listClaimedTasks(): TaskRow[] {
    const rows = this.db
      .prepare("SELECT * FROM task WHERE status = 'claimed' ORDER BY claimed_at")
      .all() as unknown as TaskRowRaw[];
    return rows.map(mapTask);
  }

  putTask(data: TaskData): TaskRow {
    const id = taskId(data.workflow, data.step, data.key);
    const at = nowMs();
    this.db
      .prepare(
        `INSERT INTO task (id, workflow, step, key, status, run, claimed_at, attempts, alarm_at, heartbeat_at, updated_at)
         VALUES (@id, @workflow, @step, @key, @status, @run, @claimed_at, @attempts, @alarm_at, @heartbeat_at, @updated_at)
         ON CONFLICT(workflow, step, key) DO UPDATE SET
           status = excluded.status,
           run = excluded.run,
           claimed_at = excluded.claimed_at,
           attempts = excluded.attempts,
           alarm_at = excluded.alarm_at,
           heartbeat_at = excluded.heartbeat_at,
           updated_at = excluded.updated_at`,
      )
      .run({
        id,
        workflow: data.workflow,
        step: data.step,
        key: data.key,
        status: data.status,
        run: data.run ?? null,
        claimed_at: data.claimedAt ?? null,
        attempts: data.attempts,
        alarm_at: data.alarmAt ?? null,
        heartbeat_at: data.heartbeatAt ?? null,
        updated_at: at,
      });
    return this.getTask(data.workflow, data.step, data.key) as TaskRow;
  }

  /** Read the stored alarm_at for (workflow, step), or undefined if not set. */
  getAlarm(workflow: string, step: string): number | undefined {
    const t = this.getTask(workflow, step, '');
    return t?.alarmAt;
  }

  /** Persist an absolute alarm time for an idle evaluator step. */
  setAlarm(workflow: string, step: string, at: number): void {
    const existing = this.getTask(workflow, step, '');
    if (existing) {
      this.db.prepare('UPDATE task SET alarm_at = ?, updated_at = ? WHERE workflow = ? AND step = ? AND key = ?')
        .run(at, nowMs(), workflow, step, '');
    } else {
      // Rare: evaluator step has never been ticked. Insert a minimal idle row.
      this.putTask({ workflow, step, key: '', status: 'idle', attempts: 0, alarmAt: at });
    }
  }

  /** Clear the alarm (set alarm_at = NULL). */
  clearAlarm(workflow: string, step: string): void {
    this.db.prepare('UPDATE task SET alarm_at = NULL, updated_at = ? WHERE workflow = ? AND step = ? AND key = ?')
      .run(nowMs(), workflow, step, '');
  }

  /** Update only heartbeat_at on the task row — targeted write, no read-modify-write. */
  touchHeartbeat(workflow: string, step: string, key: string, now: number): void {
    this.db.prepare(
      'UPDATE task SET heartbeat_at = ?, updated_at = ? WHERE workflow = ? AND step = ? AND key = ?'
    ).run(now, nowMs(), workflow, step, key);
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
        `INSERT INTO run (id, workflow, step, key, outcome, summary, session_id, fingerprint, cause, order_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, data.workflow, data.step, data.key ?? '', data.outcome ?? null, data.summary ?? null,
        data.sessionId ?? null, toJson(data.fingerprint), data.cause ?? null, toJson(data.order), at, at);
    return this.getRun(id) as RunRow;
  }

  updateRun(id: string, patch: Partial<RunData>): RunRow {
    const cur = this.getRun(id);
    if (!cur) throw new Error(`run not found: ${id}`);
    // order_json is DELIBERATELY excluded from `merged` and the UPDATE below:
    // the order packet is immutable after claim (§8 / Gap 1). Omitting it makes
    // that structural — no close/outcome/summary write can ever clobber it.
    const merged: RunData = {
      workflow: cur.workflow,
      step: cur.step,
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

  /** How many runs of this step since `sinceMs` (for the daily budget window). */
  countRuns(workflow: string, step: string, sinceMs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM run WHERE workflow = ? AND step = ? AND created_at >= ?')
      .get(workflow, step, sinceMs) as { n: number };
    return row.n;
  }

  /** The most recent run of this step, if any (for cadence gating). */
  latestRun(workflow: string, step: string): RunRow | undefined {
    const r = this.db
      .prepare('SELECT * FROM run WHERE workflow = ? AND step = ? ORDER BY created_at DESC LIMIT 1')
      .get(workflow, step) as RunRowRaw | undefined;
    return r ? mapRun(r) : undefined;
  }

  /**
   * Count of consecutive trailing `failed` runs for this step+key — the
   * crash-step signal. Any closed run that is NOT `failed` (ok/no_work/skipped)
   * breaks the streak; still-open runs (outcome NULL) are ignored.
   */
  recentFailedRuns(workflow: string, step: string, key: string = ''): number {
    const rows = this.db
      .prepare(
        // rowid DESC is the tiebreaker: two runs closed in the same millisecond
        // (or a clock that didn't advance) must still order by insertion, or a
        // trailing failed→ok pair could read in the wrong order and miscount.
        'SELECT outcome FROM run WHERE workflow = ? AND step = ? AND key = ? AND outcome IS NOT NULL ORDER BY created_at DESC, rowid DESC',
      )
      .all(workflow, step, key) as Array<{ outcome: string }>;
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
   * run_wf_step index). The rowid tiebreak matters in test environments where
   * nowMs() may not advance between successive insertions.
   */
  listRuns(workflow: string): RunRow[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM run WHERE workflow = ? ORDER BY created_at, rowid',
      )
      .all(workflow) as unknown as RunRowRaw[];
    return rows.map(mapRun);
  }
}

/** Open (creating if needed) a store at `path`. */
export function openStore(path: string): Store {
  return new Store(path);
}
