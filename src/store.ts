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
import { lstatSync } from 'node:fs';
import { detId, nowMs } from './util.ts';
import { compareStoreText, defDigest, isDefDigest, parseWorkflowCoordinate } from './store/types.ts';
import { withWorkflowSnapshotStoreGuard } from './store/snapshot-guard.ts';
import type {
  Acceptance,
  ArtifactData,
  ArtifactEvent,
  ArtifactHistory,
  ArtifactVersion,
  Author,
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

/** The bundle identities retained by one persisted workflow definition snapshot. */
export interface RuntimeSnapshotBundlePins {
  /** The snapshot's own containing bundle, when it came from the CAS store. */
  bundleDigest?: string;
  /** Exact cross-bundle dependencies copied from the snapshot's bundle lock. */
  bundleLock: string[];
  /** Exact versioned calls not already covered by this snapshot's bundle lock. */
  exactCalls?: string[];
}

function exactCallsFromSnapshot(record: Record<string, unknown>, workflow: string): string[] {
	const rawSteps = record.steps;
	if (rawSteps === undefined) return [];
	if (!Array.isArray(rawSteps)) {
		throw new Error(`workflow '${workflow}' has malformed def_snapshot.steps: expected an array`);
	}
	const exactCalls = new Set<string>();
	for (const [index, rawStep] of rawSteps.entries()) {
		if (typeof rawStep !== 'object' || rawStep === null || Array.isArray(rawStep)) {
			throw new Error(`workflow '${workflow}' has malformed def_snapshot.steps[${index}]: expected an object`);
		}
		const calls = (rawStep as Record<string, unknown>).calls;
		if (calls === undefined) continue;
		if (typeof calls !== 'string') {
			throw new Error(`workflow '${workflow}' has malformed def_snapshot.steps[${index}].calls: expected a string`);
		}
		if (!calls.includes('@')) continue;
		try {
			parseWorkflowCoordinate(calls);
		} catch (error) {
			throw new Error(
				`workflow '${workflow}' has malformed exact def_snapshot calls target ${JSON.stringify(calls)}: ` +
					(error as Error).message,
			);
		}
		const rawLock = record.bundleLock;
		if (
			typeof rawLock === 'object'
			&& rawLock !== null
			&& !Array.isArray(rawLock)
			&& Object.prototype.hasOwnProperty.call(rawLock, calls)
		) continue;
		exactCalls.add(calls);
	}
	return [...exactCalls].sort(compareStoreText);
}

/**
 * Read bundle pins from an EXISTING runtime database without migrating or
 * otherwise writing it. GC deliberately cannot use {@link openStore}: opening
 * the normal store enables write-oriented pragmas and schema migration, while
 * a dry run must remain observational. Legacy databases without the workflow
 * table or def_snapshot column simply predate snapshot pinning and contribute
 * no pins.
 */
export function readRuntimeSnapshotBundlePins(path: string): RuntimeSnapshotBundlePins[] {
	if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return [];

	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const hasMeta = db
			.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
			.get() !== undefined;
		if (hasMeta) {
			const row = db.prepare(`SELECT v FROM meta WHERE k = 'schema_version'`).get() as
				| { v: string }
				| undefined;
			const current = row?.v;
			if (current !== undefined && parseInt(current, 10) > parseInt(SCHEMA_VERSION, 10)) {
				throw new StoreVersionError(
					`database schema_version ${current} is newer than this owenloop's schema_version ${SCHEMA_VERSION}; ` +
						'upgrade your owenloop install to open this database',
				);
			}
		}

		const hasWorkflow = db
			.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflow'`)
			.get() !== undefined;
		if (!hasWorkflow) return [];
		const columns = db.prepare('PRAGMA table_info(workflow)').all() as Array<{ name: string }>;
		if (!columns.some((column) => column.name === 'def_snapshot')) return [];

		const rows = db
			.prepare('SELECT id, def_snapshot FROM workflow WHERE def_snapshot IS NOT NULL ORDER BY created_at, id')
			.all() as unknown as Array<{ id: string; def_snapshot: string }>;
		return rows.map((row) => {
			let snapshot: unknown;
			try {
				snapshot = JSON.parse(row.def_snapshot);
			} catch (error) {
				throw new Error(
					`workflow '${row.id}' has malformed def_snapshot JSON: ${(error as Error).message}`,
				);
			}
			if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
				throw new Error(`workflow '${row.id}' has malformed def_snapshot: expected an object`);
			}
			const record = snapshot as Record<string, unknown>;
			const rawDigest = record.bundleDigest;
			let bundleDigest: string | undefined;
			if (rawDigest !== undefined && rawDigest !== '') {
				if (typeof rawDigest !== 'string' || !isDefDigest(rawDigest)) {
					throw new Error(
						`workflow '${row.id}' has noncanonical def_snapshot.bundleDigest ${JSON.stringify(rawDigest)}`,
					);
				}
				bundleDigest = rawDigest;
			}

			const rawLock = record.bundleLock;
			if (rawLock !== undefined && (
				typeof rawLock !== 'object' || rawLock === null || Array.isArray(rawLock)
			)) {
				throw new Error(`workflow '${row.id}' has malformed def_snapshot.bundleLock: expected an object`);
			}
			const bundleLock = Object.entries((rawLock ?? {}) as Record<string, unknown>).map(([target, digest]) => {
				if (typeof digest !== 'string' || !isDefDigest(digest)) {
					throw new Error(
						`workflow '${row.id}' has noncanonical def_snapshot.bundleLock[${JSON.stringify(target)}] ` +
							`${JSON.stringify(digest)}`,
					);
				}
				return digest;
			});

			const exactCalls = exactCallsFromSnapshot(record, row.id);
			return {
				...(bundleDigest === undefined ? {} : { bundleDigest }),
				bundleLock: [...new Set(bundleLock)].sort(compareStoreText),
				...(exactCalls.length === 0 ? {} : { exactCalls }),
			};
		});
	} finally {
		db.close();
	}
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
  modifier    TEXT,
  meta        TEXT,
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
 *
 * Bumped to '10' for the routing modifier: the `workflow` table gains a
 * nullable `modifier` column (see `migrate()`). Additive and un-backfilled —
 * NULL on every existing row means "unmodified run", which is the correct
 * reading of an instance created before modifiers existed.
 *
 * Bumped to '11' for bound artifacts: the `workflow` table gains nullable
 * JSON `meta` for non-routing `meta.<key>` artifact binds.
 */
const SCHEMA_VERSION = '11';

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
  modifier: string | null;
  meta: string | null;
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
  // NULL (a pre-modifier row, or a run started without one) maps to absent,
  // never to an empty string — 'unmodified run' and 'modifier ""' must not
  // become the same thing downstream, where '' would compose 'build:'.
  if (r.modifier !== null) out.modifier = r.modifier;
  const meta = fromJson<Record<string, unknown> | undefined>(r.meta, undefined, {
    table: 'workflow',
    id: r.id,
    column: 'meta',
  });
  if (meta !== undefined) out.meta = meta;
  return out;
}

// ---- the store ---------------------------------------------------------------

export class Store {
  readonly db: DatabaseSync;
  private readonly activeSnapshotDigests = new Set<string>();

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
    // Routing modifier: the ONE modifier this instance carries. The starter
    // supplies its initial value; a def-declared artifact bind may later update
    // it through the engine's routing writer. NULL on every pre-existing row,
    // which is exactly right — an instance created before modifiers existed is
    // an unmodified run and every step is offered on bare capabilities. No
    // backfill: there is no value to invent.
    if (!wfCols.some((c) => c.name === 'modifier')) {
      this.db.exec(`ALTER TABLE workflow ADD COLUMN modifier TEXT`);
    }
    if (!wfCols.some((c) => c.name === 'meta')) {
      this.db.exec(`ALTER TABLE workflow ADD COLUMN meta TEXT`);
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

  /**
   * Persist one or more CAS-backed definition snapshots under the same
   * workflow-store lock used by install and GC. Reachability is revalidated
   * before `BEGIN IMMEDIATE`; the guarded digest set then authorizes only the
   * low-level snapshot writes performed by this transaction.
   */
  txWithWorkflowSnapshots<T>(snapshots: WorkflowDef | readonly WorkflowDef[], fn: () => T): T {
    const defs = Array.isArray(snapshots) ? snapshots : [snapshots];
    return withWorkflowSnapshotStoreGuard(defs, (guardedDigests) => {
      for (const digest of guardedDigests) this.activeSnapshotDigests.add(digest);
      try {
				return this.tx(fn);
      } finally {
				for (const digest of guardedDigests) this.activeSnapshotDigests.delete(digest);
      }
    });
  }

  private assertWorkflowSnapshotGuard(snapshot: WorkflowDef | undefined): void {
    if (snapshot?.bundleDigest === undefined || (snapshot.bundleStoreRoots?.length ?? 0) === 0) return;
    const digest = defDigest(snapshot.bundleDigest);
    if (!this.activeSnapshotDigests.has(digest)) {
      throw new Error(
				`refusing uncoordinated workflow snapshot write for bundle ${digest}: ` +
					'use txWithWorkflowSnapshots so bundle GC cannot race the commit',
      );
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
    this.assertWorkflowSnapshotGuard(data.defSnapshot);
    const at = nowMs();
    this.db
      .prepare(
        `INSERT INTO workflow
					 (id, def, title, params, produced_by_wf, produced_by_path, def_snapshot, def_hash, modifier, meta, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        data.modifier ?? null,
				toJson(data.meta),
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
    this.assertWorkflowSnapshotGuard(snapshot);
    this.db
      .prepare('UPDATE workflow SET def_snapshot = ?, def_hash = ? WHERE id = ?')
      .run(JSON.stringify(snapshot), hash, id);
  }

  /** Apply an engine-authored routing patch without rewriting authored params. */
  setWorkflowRouting(id: string, patch: { modifier?: string; meta?: Record<string, unknown> }): void {
    const assignments: string[] = [];
    const values: string[] = [];
    if (patch.modifier !== undefined) {
      assignments.push('modifier = ?');
      values.push(patch.modifier);
    }
    if (patch.meta !== undefined) {
      const current = this.getWorkflow(id);
      if (current === undefined) throw new Error(`cannot update routing for unknown workflow '${id}'`);
      assignments.push('meta = ?');
      values.push(JSON.stringify({ ...(current.meta ?? {}), ...patch.meta }));
    }
    if (assignments.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE workflow SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
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

  /**
   * Append one engine-authored history record for an artifact, WITHOUT touching
   * the artifact row.
   *
   * `putArtifact` already writes an event per lifecycle change, but only when
   * the artifact's own data changed. Some engine decisions are about an
   * artifact without changing it — the escalation transition is the first: the
   * routing of the next offer changes, the artifact does not. Those need a
   * record too, and this is the only way to write one.
   *
   * **Idempotent by construction.** The row id is derived from
   * `(workflow, path, version, dedupe)` and the insert is
   * `ON CONFLICT(id) DO NOTHING`, so a caller that recomputes the same decision
   * on every tick — as the escalation rule does, since it is derived state and
   * not a stored flag — writes exactly one row. The caller owns `dedupe`: make
   * it identify the EPISODE, not the moment.
   *
   * Pass `version: 0` for a record that belongs to the artifact as a whole
   * rather than to one produced version; `getArtifactHistory` surfaces those in
   * its artifact-level `events` bucket. Detail goes in `metadata`.
   */
  recordArtifactEvent(event: {
    workflow: string;
    path: string;
    version: number;
    action: string;
    actor: Author;
    dedupe: string;
    timestamp: number;
    reason?: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.insertArtifactEvent({
      workflow: event.workflow,
      path: event.path,
      version: event.version,
      action: event.action,
      actor: event.actor,
      timestamp: event.timestamp,
      key: event.dedupe,
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
      ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
    });
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
    // no close/outcome/summary write can ever clobber the order packet, and
    // omitting the column makes that structural rather than a convention.
    // `restampOrderTarget` below is the ONE writer of order_json after claim,
    // and it rewrites a single `owes[].version` and nothing else.
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

  /**
   * Re-stamp ONE owed version target on a run's persisted order packet.
   *
   * The order is frozen at claim with exactly one exception, and this is it.
   * When a reject re-arms a still-open claim, the artifact has already been
   * bumped by the commit that preceded the reject, so the target the claim
   * froze at issue names a version the next commit will overshoot — and the
   * producer would sign that stale number into its submission proof while the
   * hub keys the stored proof row by the version actually committed. Everything
   * else about the packet stays frozen, and `updateRun` still cannot touch it
   * at all.
   *
   * No-ops when the run has no persisted order (pre-schema-v7 rows), when the
   * order does not owe `path`, or when the target already is `version` — so
   * callers can call it unconditionally, and re-stamping is idempotent.
   */
  restampOrderTarget(id: string, path: string, version: number): void {
    const cur = this.getRun(id);
    if (!cur?.order) return;
    const owed = cur.order.owes.find((o) => o.path === path);
    if (owed === undefined || owed.version === version) return;
    // Rebuilt immutably (map, not in-place mutation) so no caller is left
    // holding a half-mutated Order read before this write.
    const next: Order = {
      ...cur.order,
      owes: cur.order.owes.map((o) => (o.path === path ? { ...o, version } : o)),
    };
    this.db
      .prepare('UPDATE run SET order_json = ?, updated_at = ? WHERE id = ?')
      .run(toJson(next), nowMs(), id);
  }

  getRun(id: string): RunRow | undefined {
    const r = this.db.prepare('SELECT * FROM run WHERE id = ?').get(id) as RunRowRaw | undefined;
    return r ? mapRun(r) : undefined;
  }

  /**
   * How many runs of this step since `sinceMs` (for the daily budget window).
   *
   * `released` RUNS ARE EXCLUDED — a lease returned unused is not a firing. See
   * `RunData.outcome` for why this is not the same as `no_work`, which stays
   * counted because the step did run.
   */
  countRuns(workflow: string, step: string, sinceMs: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM run WHERE workflow = ? AND step = ? AND created_at >= ?'
          + " AND (outcome IS NULL OR outcome != 'released')",
      )
      .get(workflow, step, sinceMs) as { n: number };
    return row.n;
  }

  /**
   * The most recent run of this step, if any (for cadence gating).
   *
   * `released` runs are excluded for the same reason `countRuns` excludes them:
   * a lease handed straight back did not fire the step, so it must not restart
   * the cadence clock. Without this a server that claims and releases on every
   * sweep holds a throttled step off indefinitely — each handback pushes the
   * next eligible time further out than the sweep interval that produced it.
   */
  latestRun(workflow: string, step: string): RunRow | undefined {
    const r = this.db
      .prepare(
        "SELECT * FROM run WHERE workflow = ? AND step = ? AND (outcome IS NULL OR outcome != 'released')"
          + ' ORDER BY created_at DESC LIMIT 1',
      )
      .get(workflow, step) as RunRowRaw | undefined;
    return r ? mapRun(r) : undefined;
  }

  /**
   * Count of consecutive trailing `failed` runs for this step+key — the
   * crash-step signal. Any closed run that is NOT `failed`
   * (ok/no_work/released/skipped) breaks the streak; still-open runs (outcome
   * NULL) are ignored. `released` breaks it exactly as `no_work` did before the
   * two were split, so the crash-step signal is unchanged by that split.
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
