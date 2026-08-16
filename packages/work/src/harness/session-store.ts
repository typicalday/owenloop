/**
 * Session store — the append-only JSONL record of which harness session belongs
 * to which step attempt, so a rejected step can be RESUMED instead of restarted.
 *
 * Layout: one JSON object per line at `<cacheDir>/sessions.jsonl`
 * (`sessionsPath`). The cache dir comes from the EXISTING `resolveCacheDir`
 * (`src/bundle/cache.ts`); this phase adds NO new settings key.
 *
 * MACHINE-LOCAL BY DESIGN. A provider session token has no meaning off the
 * machine that created it, so these records are NEVER sent to the hub —
 * structurally guaranteed here by the absence of any `src/hub/` import, and
 * socially by this comment. Nothing in this file talks to a network.
 *
 * LAST-WINS per `(workflow, run, step)`: a later line beats an earlier one.
 * `attempt` is CARRIED BY the record and is deliberately NOT part of the key —
 * a re-attempt appends a new record with the same key and a higher `attempt`,
 * which correctly shadows the old one.
 *
 * FAILURE STANCE, three different answers on purpose:
 *  - READ is fail-open: a missing file reads as `[]` (mirrors `readChildRecords`
 *    in `src/shift/state.ts`), and an unusable line — corrupt bytes that will
 *    not parse, or a parsed object that fails the schema — is skipped and
 *    reported through the injectable `warn` callback, never thrown. A store that
 *    cannot be parsed must degrade a resume into a replay, not break the worker.
 *  - APPEND PROPAGATES. Unlike the shift's advisory metering records, a lost
 *    session token silently degrades a Phase 4 resume into a cold replay — real
 *    work thrown away — so the caller must see the failure.
 *  - `active` is the safety-critical boundary. Its complete JSONL row is fsynced
 *    before provider work may proceed. Other lifecycle rows retain ordinary
 *    append durability; losing one degrades to conservative retirement/replay.
 *  - COMPACTION is best-effort after a committed append, but a successful
 *    compaction fsyncs its replacement before rename so it cannot erase a
 *    previously durable `active` row across a host crash.
 *
 * DEVIATION FROM PLAN §3, stated deliberately: plan §3 says "compact on load if
 * > 2 MB". This module compacts on the WRITE path instead — `appendSession`
 * appends, stats the file, and compacts past `maxBytes`. Reasons: `latestFor`
 * stays side-effect-free (a read never becomes a writer, and never fails on a
 * read-only filesystem), and a small `maxBytes` lets tests exercise compaction
 * without writing 2 MB. The 2 MB default is unchanged.
 *
 * WRITER SERIALIZATION: every append, retirement, and compaction takes one
 * cross-process writer lock for its complete read/append/size-check/rename
 * transaction. A completed append can therefore never be replaced or shadowed
 * by another process's stale snapshot. The shared SQLite lock database persists;
 * process exit or crash releases its kernel lock without pathname deletion.
 *
 * Logging follows the house rule (there are zero `console.*` calls anywhere in
 * `src/`): the library takes an injectable callback and the default writes to
 * stderr, so tests stay silent and assertable.
 */
import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireFileLockSync, releaseFileLock } from '../../../../src/lock.ts';
import { defaultIsAlive, type Liveness } from '../shift/state.ts';

/** Where a step attempt is in its life. */
export type SessionStatus = 'active' | 'turn-ended' | 'submitted' | 'dead';

const STATUSES = new Set<string>(['active', 'turn-ended', 'submitted', 'dead']);

/** One line of `sessions.jsonl`. */
export interface SessionRecord {
  workflow: string;
  run: string;
  step: string;
  /** The composite `<workflow>/<run>` order id — the same string `hold --order`
   *  takes. Redundant with `workflow` + `run` by construction; kept because the
   *  contract lists it and Phase 6's `owenloop work sessions` display prints it.
   *  ALWAYS build it with `orderId()` so the two can never drift. */
  order: string;
  /**
   * `OrderPacket.key` — the fan-out key of the engine task this firing served.
   *
   * WHY IT IS HERE, AND WHY IT IS OPTIONAL. `run` identifies ONE FIRING and is
   * minted fresh every time the engine claims the step, so `(workflow, run,
   * step)` can never name the same work twice. `(workflow, step, key)` is the
   * engine's own task identity — the `UNIQUE (workflow, step, key)` on its
   * `task` table — and is the only triple here that survives a re-offer. See
   * `latestForTask`.
   *
   * OPTIONAL because every row written before this field existed lacks it. Such
   * a row is never attributed to a task (`latestForTask` skips it) rather than
   * being guessed at. `''` is a REAL key — an unfanned step — so the absence
   * must be tested as `undefined`, never as falsy.
   */
  key?: string;
  attempt: number;
  /** Adapter id (`HarnessSessionRef.harness`). */
  harness: string;
  /** PID of the agent-run worker that owns the active session, when recorded. */
  pid?: number;
  /** Stable shift name in force when the worker was dispatched, when recorded. */
  shiftName?: string;
  /** Stable owner key; explicit shift names use the name, unnamed shifts use stateDir. */
  shiftOwner?: string;
  /** Per-boot shift incarnation that dispatched the worker, for diagnostics. */
  shiftId?: string;
  /** Provider-native session token (`HarnessSessionRef.token`). Machine-local. */
  token: string;
  cwd: string;
  status: SessionStatus;
  createdAt: number;
  /**
   * PHASE 4 — the reason watermark: the `at` of the NEWEST `ReasonEntry` already
   * delivered into this session, by either a resume or a cold replay.
   *
   * The next re-offer filters `OrderPacket.owes[].reasons` to `at > this` and
   * delivers only what is left, which is what makes a rejection cost a short
   * delta instead of a whole brief.
   *
   * BACKWARD-COMPATIBLE BY CONSTRUCTION, no version bump and no migration:
   * `isSessionRecord` validates only `workflow/run/step/harness/token/status` and
   * carries every other field verbatim, so a record written before Phase 4 simply
   * has no watermark. Absent reads as "nothing delivered yet", which makes the
   * first resume after an upgrade deliver every reason — the safe direction to be
   * wrong, since the alternative would silently swallow feedback.
   *
   * NOT part of the record key. The key stays `(workflow, run, step)` and
   * `attempt` stays outside it, per Phase 1.
   */
  deliveredReasonAt?: number;
  updatedAt: number;
}

export interface SessionStoreOptions {
  /** Called once per skipped line — either corrupt bytes that would not parse
   *  ("skipping corrupt record") or a parsed object that failed the schema
   *  ("skipping invalid record"). Default writes to stderr. */
  warn?: (line: string) => void;
  /** Optional debug sink for conservative reconciliation skips. */
  debug?: (line: string) => void;
  /** Test barrier invoked under the writer lock after a retirement snapshot. */
  afterWriterSnapshot?: () => void;
  /** Compaction threshold in bytes, checked after each append. Default 2 MB. */
  maxBytes?: number;
  /** Clock used to detect an abandoned unterminated tail. Default `Date.now`. */
  now?: () => number;
  /** Unchanged-tail grace before one warning is emitted. Default 5 seconds. */
  unterminatedTailGraceMs?: number;
  /** Injectable durability primitive for focused tests. Default `fsyncSync`. */
  sync?: (fd: number) => void;
}

/** Default compaction threshold — plan §3's 2 MB. */
export const DEFAULT_MAX_BYTES = 2_000_000;
/** Grace for a concurrent writer to finish an unterminated JSONL append. */
export const DEFAULT_UNTERMINATED_TAIL_GRACE_MS = 5_000;

interface TailObservation {
  /** Stable identity of the open file whose bytes were inspected. */
  identity: string;
  /** Metadata that changes when a writer extends or replaces the observed tail. */
  size: number;
  mtimeMs: number;
  tail: string;
  firstSeenAt: number;
  warned: boolean;
}

/** Process-local observations; session files remain the only persisted state. */
const tailObservations = new Map<string, TailObservation>();

/** `<cacheDir>/sessions.jsonl`. */
export function sessionsPath(cacheDir: string): string {
  return join(cacheDir, 'sessions.jsonl');
}

/** The composite order id `<workflow>/<run>` — the one place it is built. */
export function orderId(workflow: string, run: string): string {
  return `${workflow}/${run}`;
}

function defaultWarn(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Identity of a step attempt slot. `attempt` is intentionally not in the key.
 *  JSON-encoded rather than joined on a separator character so no combination of
 *  workflow/run/step values can collide into one key. */
function keyOf(workflow: string, run: string, step: string): string {
  return JSON.stringify([workflow, run, step]);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

/**
 * The non-empty-string fields `isSessionRecord` requires, in the order it checks
 * them. Declared once and kept stable so a record failing several checks always
 * reports the SAME field, which keeps the skip message deterministic.
 *
 * `token` is NOT here — see `firstInvalidSessionRecordField`. `status` is not
 * here either: its check is a membership test, not a string test, and is applied
 * after these, preserving the original check order.
 */
const SESSION_RECORD_STRING_FIELDS = ['workflow', 'run', 'step', 'harness'] as const;

/**
 * Name of the first field of `v` that fails the `SessionRecord` schema, or
 * `null` when the record is valid. `'<root>'` means `v` is not a plain object at
 * all, so no field could be read from it.
 *
 * THE SINGLE SOURCE OF TRUTH for record validity: `isSessionRecord` is defined
 * in terms of this function, so the accept/reject decision and the reported
 * field name can never drift apart.
 *
 * Checks exactly the fields whose absence would make the record unusable: the
 * three key fields, the harness that says which vendor the row belongs to, a
 * `token` that is a string, and a `status` inside the four literals. Everything
 * else is carried verbatim.
 *
 * ── WHY AN EMPTY `token` IS VALID, THOUGH IT ONCE WAS NOT ────────────────────
 *
 * `token` must be a STRING, but it may be EMPTY. The writer produces an empty
 * one deliberately: `agent/loop.ts` appends a record before the harness emits
 * its `started` event, so that a harness which dies on launch still leaves proof
 * the attempt existed and died. Its own comment says so. Requiring the token to
 * be non-empty here threw exactly those records away — the reader discarded the
 * evidence the writer went out of its way to leave.
 *
 * The cost was not only the lost rows. Every such line was reported on stdout as
 * `field "token" failed schema check`, once per reading process. On this machine
 * that was ~94 lines printed by each of three shifts on every boot: ~280 warning
 * lines about records that were behaving exactly as designed, drowning the
 * warnings that meant something.
 *
 * Nothing downstream is harmed by admitting them, because every consumer already
 * expected the empty case and guarded for it BEFORE this change:
 *   - `agent/loop.ts` requires `prev.token !== ''` to resume, with a comment
 *     naming this exact case ("the record predates its `started` event").
 *   - `roles/sessions.ts` renders no resume command for one.
 *   - `shouldRetireSession` reads `pid`/owner/`status` and never the token.
 *
 * The guard in the loop is in fact PROOF of the intent: it is unreachable code
 * unless records with an empty token can be read back.
 *
 * ── WHY `key` IS CHECKED ONLY WHEN PRESENT ───────────────────────────────────
 *
 * `key` was added after rows already existed, so ABSENT is legal and means "this
 * row predates the field". PRESENT-BUT-NOT-A-STRING is not legal: it would be a
 * row nobody wrote, and `latestForTask` would silently mis-key it. `''` is a
 * perfectly good key — it is what an unfanned step carries — so emptiness is
 * never the test here.
 */
function firstInvalidSessionRecordField(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return '<root>';
  const r = v as Record<string, unknown>;
  for (const field of SESSION_RECORD_STRING_FIELDS) {
    if (!isNonEmptyString(r[field])) return field;
  }
  // Checked after `harness` and before `status`, which is where it sat when it
  // was a non-empty check, so a record failing several fields still reports the
  // same one it always did.
  if (typeof r['token'] !== 'string') return 'token';
  if (r['key'] !== undefined && typeof r['key'] !== 'string') return 'key';
  if (typeof r['status'] !== 'string' || !STATUSES.has(r['status'])) return 'status';
  return null;
}

/**
 * Validate one parsed line. A type predicate, so a `true` return narrows `v` to
 * `SessionRecord` at the call site.
 */
function isSessionRecord(v: unknown): v is SessionRecord {
  return firstInvalidSessionRecordField(v) === null;
}

/** Flush a directory entry update where the platform exposes directory fsync. */
function syncDirectory(dir: string, sync: (fd: number) => void = fsyncSync): void {
  if (process.platform === 'win32') return;
  const fd = openSync(dir, 'r');
  try {
    sync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Atomic durable write used by compaction. The replacement bytes are fsynced
 * before rename, then the directory entry is fsynced. Fs errors propagate to
 * the caller; `compactIfNeededUnlocked` decides whether best-effort compaction
 * may swallow them. */
function atomicWrite(filePath: string, content: string, opts: SessionStoreOptions): void {
  const dir = join(filePath, '..');
  const sync = opts.sync ?? fsyncSync;
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${Math.random().toString(36).slice(2)}-${process.pid}-${Date.now()}.tmp`);
  const fd = openSync(tmp, 'wx');
  let failure: unknown;
  try {
    writeFileSync(fd, content);
    sync(fd);
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
      unlinkSync(tmp);
    } catch {
      // Preserve the original write or close failure.
    }
    throw failure;
  }
  try {
    renameSync(tmp, filePath);
    syncDirectory(dir, sync);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/**
 * Every valid record in `file`, oldest first. A missing/unreadable file reads as
 * `[]`. A trailing newline is the record-commit marker: an unterminated final
 * tail may be a concurrent writer still appending. File modification time starts
 * the grace, so a recently modified tail is ignored silently while an already-old
 * tail warns on the first read even in a fresh process. File identity, size, tail,
 * or modification changes restart the observation; a newline clears it. Blank lines are
 * skipped silently; every other unusable COMPLETE line is skipped and reported
 * through `warn` with its 1-indexed line number. Never throws.
 */
export function readSessions(file: string, opts: SessionStoreOptions = {}): SessionRecord[] {
  const warn = opts.warn ?? defaultWarn;
  let raw: string;
  let metadata: { identity: string; size: number; mtimeMs: number };
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    raw = readFileSync(fd, 'utf8');
    const stat = fstatSync(fd);
    metadata = {
      identity: `${stat.dev}:${stat.ino}`,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    tailObservations.delete(file);
    return []; // fail-open: no store yet is the normal first-run case
  } finally {
    if (fd !== undefined) {
      try {
	closeSync(fd);
      } catch {
	// The bytes and metadata were already captured; a close failure cannot
	// make a resumable record safer, so preserve the read path's fail-open stance.
      }
    }
  }
  const out: SessionRecord[] = [];
  const lines = raw.split('\n');
  const hasUncommittedTail = raw !== '' && !raw.endsWith('\n');
  if (!hasUncommittedTail) {
    tailObservations.delete(file);
  } else {
    const tail = lines.at(-1) ?? '';
    if (tail.trim() === '') {
      tailObservations.delete(file);
    } else {
      const now = (opts.now ?? Date.now)();
      const graceMs = opts.unterminatedTailGraceMs ?? DEFAULT_UNTERMINATED_TAIL_GRACE_MS;
      const observed = tailObservations.get(file);
      const sameObservation = observed !== undefined
	&& observed.identity === metadata.identity
	&& observed.size === metadata.size
	&& observed.mtimeMs === metadata.mtimeMs
	&& observed.tail === tail;
      if (!sameObservation) {
	// mtime is persisted by the filesystem, so an abandoned tail can be
	// recognized on the first read of a fresh one-shot process. Clamp a
	// future timestamp to `now` for clock skew and injected test clocks.
	const firstSeenAt = Math.min(now, metadata.mtimeMs);
	const next: TailObservation = {
	  ...metadata,
	  tail,
	  firstSeenAt,
	  warned: false,
	};
	tailObservations.set(file, next);
	if (now - firstSeenAt >= graceMs) {
	  warn(`owenloop work sessions: persistent unterminated record at ${file}:${lines.length}`);
	  next.warned = true;
	}
      } else if (observed !== undefined && !observed.warned && now - observed.firstSeenAt >= graceMs) {
	warn(`owenloop work sessions: persistent unterminated record at ${file}:${lines.length}`);
	observed.warned = true;
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue; // noUncheckedIndexedAccess
    if (hasUncommittedTail && i === lines.length - 1) continue;
    if (line.trim() === '') continue; // blank lines are not corruption
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warn(`owenloop work sessions: skipping corrupt record at ${file}:${i + 1}`);
      continue;
    }
    if (!isSessionRecord(parsed)) {
      // DISTINCT WORDING ON PURPOSE — "invalid", not "corrupt". These bytes
      // parsed fine; they just failed the schema. 36 records once whose only
      // fault was an empty `token` were all reported as "corrupt", which sent
      // debugging after a file-integrity problem that did not exist. The second
      // pass runs only on this failure branch, so valid records pay nothing.
      // The field NAME only, never its value — `token` is credential-shaped.
      //
      // Those empty-`token` records are no longer invalid at all — the schema
      // admits them now (see `firstInvalidSessionRecordField`). Reaching this
      // branch therefore means something genuinely wrong with the record, which
      // is what makes the line worth printing.
      const badField = firstInvalidSessionRecordField(parsed) ?? '<unknown>';
      warn(
        `owenloop work sessions: skipping invalid record at ${file}:${i + 1}: field "${badField}" failed schema check`,
      );
      continue;
    }
    out.push(parsed);
  }
  return out;
}

/**
 * The newest record for `(workflow, run, step)` — that is, for ONE FIRING of one
 * step — or `null` when the file is missing or holds no match. Scans forward and
 * keeps the LAST match (last-wins). Side-effect-free: it never writes, never
 * compacts, and never throws.
 *
 * ── THIS IS THE PER-FIRING LOOKUP. IT CANNOT FIND A PREVIOUS FIRING. ─────────
 *
 * The hub mints a fresh `run` id every time it claims a step. Two firings of the
 * same step therefore NEVER share a `run`, so this function can only ever return
 * a record written during the very firing that is asking. Use it for questions
 * that really are about one firing — "did THIS firing already take a work dir?",
 * "which sessions belong to the run I am tearing down?" — and never to ask "has
 * this step run before?". That second question is `latestForTask`.
 */
export function latestFor(
  file: string,
  workflow: string,
  run: string,
  step: string,
): SessionRecord | null {
  const want = keyOf(workflow, run, step);
  let best: SessionRecord | null = null;
  for (const rec of readSessions(file)) {
    if (keyOf(rec.workflow, rec.run, rec.step) === want) best = rec;
  }
  return best;
}

/**
 * The engine's own identity for a unit of work: one STEP of one WORKFLOW at one
 * fan-out KEY. The hub enforces `UNIQUE (workflow, step, key)` on its task table,
 * which is what makes this triple stable across re-offers where `run` is not.
 */
export interface SessionTaskRef {
  workflow: string;
  step: string;
  /** `OrderPacket.key`. `''` for a step that does not fan out — a real value,
   *  not a missing one. */
  key: string;
}

/** Identity of an engine TASK. Same JSON-array encoding as `keyOf`, and for the
 *  same reason: no combination of field values can collide into one key. */
function taskKeyOf(task: SessionTaskRef): string {
  return JSON.stringify([task.workflow, task.step, task.key]);
}

/**
 * The newest record for an engine TASK — the last session recorded for this
 * step at this key, no matter which firing wrote it — or `null` when there is
 * none. Last-wins, side-effect-free, same as `latestFor`.
 *
 * ── WHY THIS EXISTS ALONGSIDE `latestFor` ────────────────────────────────────
 *
 * `latestFor` keys on `run`, which the hub re-mints per firing, so it answers
 * "what happened during THIS firing?". Resume needs the opposite question: "did
 * a previous firing of this same step leave a session I can re-enter?" Only
 * `(workflow, step, key)` survives long enough to answer that.
 *
 * ── WHY A ROW WITHOUT `key` NEVER MATCHES ────────────────────────────────────
 *
 * Rows written before `key` existed carry no task identity at all. Guessing one
 * — treating absent as `''`, say — would attribute an unfanned row and a fanned
 * row to the same task and hand a worker someone else's session. Skipping them
 * costs only a cold start on the first firing after upgrade, which is the safe
 * direction to be wrong in. The test is `=== undefined`, because `''` is a real
 * key that must match.
 */
export function latestForTask(file: string, task: SessionTaskRef): SessionRecord | null {
  const want = taskKeyOf(task);
  let best: SessionRecord | null = null;
  for (const rec of readSessions(file)) {
    if (rec.key === undefined) continue;
    if (taskKeyOf({ workflow: rec.workflow, step: rec.step, key: rec.key }) === want) best = rec;
  }
  return best;
}

/** The lock shared by append and compaction for one session log. */
function writerLockPath(file: string): string {
  return `${file}.lock`;
}

/** Run one complete writer transaction under the cross-process session lock. */
function withWriterLock<T>(file: string, operation: () => T): T {
  const lock = acquireFileLockSync(writerLockPath(file), {
    waitMs: 30_000,
    label: 'owenloop session-store write',
  });
  try {
    return operation();
  } finally {
    releaseFileLock(lock);
  }
}

/** True when an existing nonempty log does not end at a JSONL commit marker. */
function needsRecordSeparator(file: string): boolean {
  const stat = statSync(file, { throwIfNoEntry: false });
  if (stat === undefined || stat.size === 0) return false;
  const fd = openSync(file, 'r');
  try {
    const last = Buffer.allocUnsafe(1);
    const read = readSync(fd, last, 0, 1, stat.size - 1);
    return read !== 1 || last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Lock must already be held by the caller. */
function compactUnlocked(file: string, opts: SessionStoreOptions): void {
  const records = readSessions(file, opts);
  if (records.length === 0) return;
  const byKey = new Map<string, SessionRecord>();
  for (const rec of records) {
    // Map preserves first-insertion order across re-set, which is exactly the
    // first-seen key order we want to keep.
    byKey.set(keyOf(rec.workflow, rec.run, rec.step), rec);
  }
  const body = [...byKey.values()].map((r) => JSON.stringify(r)).join('\n');
  atomicWrite(file, `${body}\n`, opts);
}

/** Lock must already be held. Append exactly one committed JSONL row.
 * `active` is fsynced before returning because provider work is gated on this
 * call. Later statuses use ordinary close-to-flush durability. */
function appendSessionUnlocked(
  file: string,
  rec: SessionRecord,
  opts: SessionStoreOptions,
): void {
  const separator = needsRecordSeparator(file) ? '\n' : '';
  const existed = statSync(file, { throwIfNoEntry: false }) !== undefined;
  const fd = openSync(file, 'a');
  let failure: unknown;
  try {
    writeFileSync(fd, `${separator}${JSON.stringify(rec)}\n`);
    if (rec.status === 'active') {
      const sync = opts.sync ?? fsyncSync;
      sync(fd);
      if (!existed) syncDirectory(join(file, '..'), sync);
    }
  } catch (error) {
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    if (failure === undefined) failure = error;
  }
  if (failure !== undefined) throw failure;
}

/** Lock must already be held. Compaction remains best-effort after committed JSONL appends. */
function compactIfNeededUnlocked(file: string, opts: SessionStoreOptions): void {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  try {
    if (statSync(file).size > maxBytes) compactUnlocked(file, opts);
  } catch {
    // An un-compacted (or unstatable) file still contains the committed rows.
  }
}

/**
 * Rewrite `file` with only the last record per `(workflow, run, step)`,
 * preserving FIRST-SEEN key order, via temp file + rename. Corrupt lines are
 * dropped in the process (they were already unreadable). A missing file is a
 * no-op. The complete read/rewrite/rename transaction shares the same lock as
 * append, so a successful append cannot be replaced by this snapshot.
 */
export function compact(file: string, opts: SessionStoreOptions = {}): void {
  withWriterLock(file, () => compactUnlocked(file, opts));
}

/**
 * PHASE 4 — retire every session of one RUN by appending a `dead` row per step.
 *
 * THE INVARIANT IT ENFORCES: session lifetime equals cwd lifetime. When the
 * per-run work directory is removed, the work those sessions were revising is
 * gone, so resuming into a freshly recreated (and empty) directory at the same
 * path would hand the agent a conversation about files that no longer exist. The
 * `prev.status !== 'dead'` precondition in `src/agent/loop.ts` is what refuses
 * the resume; this function is what makes the status say `dead`.
 *
 * WHY A NEW ROW RATHER THAN A REWRITE: the store is append-only and last-wins per
 * `(workflow, run, step)`, so appending a copy with `status: 'dead'` shadows the
 * live row without rewriting history. The shared writer lock serializes each
 * appended retirement with append/compaction transactions from other processes.
 *
 * IDEMPOTENT: a key whose newest row is already `dead` is skipped, so a sweep
 * that reaps the same run twice appends nothing the second time.
 *
 * SCOPE: the newest row per `(workflow, run, step)` for the given run, across
 * EVERY step of that run — the work directory is per-run, so every step's session
 * lived in it.
 *
 * FAILURE STANCE: `appendSession` PROPAGATES (see the header), and so does this.
 * The caller — the work-directory reaper — must be able to see the failure,
 * because retiring the sessions is a precondition of removing the directory, not
 * a side note.
 *
 * Returns the step names actually marked, so a sweep can log a count.
 */
export function markRunSessionsDead(
  file: string,
  workflow: string,
  run: string,
  now: number,
  opts: SessionStoreOptions = {},
): string[] {
  mkdirSync(join(file, '..'), { recursive: true });
  return withWriterLock(file, () => {
    const newest = new Map<string, SessionRecord>();
    for (const rec of readSessions(file, opts)) {
      if (rec.workflow !== workflow || rec.run !== run) continue;
      newest.set(keyOf(rec.workflow, rec.run, rec.step), rec);
    }
    opts.afterWriterSnapshot?.();
    const marked: string[] = [];
    for (const rec of newest.values()) {
      if (rec.status === 'dead') continue; // already retired — nothing to append
      appendSessionUnlocked(file, { ...rec, status: 'dead', updatedAt: now }, opts);
      marked.push(rec.step);
    }
    if (marked.length > 0) compactIfNeededUnlocked(file, opts);
    return marked;
  });
}

/**
 * PHASE 6, ITEM 4 — retire the `active` sessions of runs that are no longer
 * running, so a crash or a reboot does not leave the store claiming a turn is in
 * flight when no process exists.
 *
 * WHAT IS BROKEN WITHOUT THIS. `src/agent/loop.ts` writes `status: 'active'` when
 * a turn starts and rewrites it at turn end. A worker killed mid-turn — SIGKILL,
 * a panic, a reboot — never reaches the rewrite, so the newest row for that step
 * says `active` forever. Nothing else ever corrects it.
 *
 * ── WHY THIS IS NOT `markRunSessionsDead` ────────────────────────────────────
 *
 * `markRunSessionsDead` retires EVERY non-`dead` newest row of a run. Reusing it
 * here would destroy exactly the capability this phase has to keep working:
 * `src/agent/loop.ts` refuses to resume a session whose previous status is
 * `dead`, and a `turn-ended` or `submitted` row is a COMPLETED turn whose
 * provider-side session is intact. A reboot does not invalidate one. Leaving
 * those rows alone is precisely what "resume still works after a reboot" means.
 *
 * So ONLY `active` rows are eligible, and each candidate is checked against its
 * recorded owner and worker PID before any retirement row is appended.
 *
 * ── WHY RETIRING AN ORPHANED `active` ROW IS THE RIGHT DIRECTION TO BE WRONG ──
 *
 * An interrupted turn is the state you least want to resume into: the harness may
 * have half-applied tool calls the worker has no record of, so a resumed session
 * would carry a model that believes work happened which did not. The cost of
 * retiring it is one cold replay. The cost of resuming it is silent divergence.
 *
 * ── WHY THE RUN-ID SET THIS REPLACED WAS UNSAFE ──────────────────────────────
 *
 * This used to take `liveRunIds` — the run ids with a live `agent-run` child in
 * the BOOTING shift's state dir — and retire every `active` row outside it. That
 * is correct only on a machine running exactly one shift. It does not: the
 * sessions store is per-CACHE-DIR and therefore machine-wide, while a state dir
 * is per-shift. So shift A booting saw shift B's currently-running workers as
 * orphans and killed their resumable sessions out from under them, mid-turn.
 * A prior version of this comment told the next reader NOT to put a pid on
 * `SessionRecord`, on the grounds that the shift state dir was already the
 * system of record for liveness. That was the mistaken premise: one shift's
 * state dir is evidence about ONE shift, and this file is read by all of them.
 *
 * ── FAIL-SAFE OWNERSHIP AND LIVENESS ─────────────────────────────────────────
 *
 * Boot-time reconciliation is allowed to retire an `active` row only when the
 * row names this shift, carries a valid worker PID, and that PID is provably
 * gone. Missing or foreign ownership, an unknown PID, a live PID, and any
 * liveness ambiguity all leave the row untouched. A stale row is cheaper than
 * destroying a live resumable session, so the predicate intentionally errs in
 * that direction.
 *
 * A CONSEQUENCE WORTH KNOWING: every row written before this landed has no
 * `pid` and no owner, so none of them is ever retired. That is the fail-safe
 * direction and it costs nothing — an un-retired stale row is one failed resume
 * that falls back to a cold replay, which is what retiring it would have caused
 * anyway.
 *
 * IDEMPOTENT: the rows it appends are `dead`, so a second call finds nothing
 * `active` left and appends nothing.
 *
 * FAILURE STANCE: `appendSession` propagates, and so does this — same as
 * `markRunSessionsDead`.
 *
 * @param context the booting shift's ownership and harness identity plus the
 *   injectable PID liveness probe.
 * @returns the records that were retired, as they were BEFORE retirement, so the
 *   caller can log what it took away.
 */
export interface SessionReconcileContext {
  /** Public shift name in force when this shift booted. */
  shiftName: string;
  /** Stable owner key; falls back to `shiftName` for older callers/records. */
  shiftOwner?: string;
  /** Configured harness guard, when this shift has one. */
  harness?: string;
  /** PID probe; defaults to the existing shift-state probe. */
  isAlive?: Liveness;
}

export interface RetireDecision {
  retire: boolean;
  reason: string;
}

/**
 * Decide whether one active session row is safe to retire.
 *
 * The function is deliberately independent of the JSONL writer. Callers can
 * exercise the safety predicate with a deterministic PID probe, while the
 * production path uses `process.kill(pid, 0)` through `defaultIsAlive`.
 */
export function shouldRetireSession(
  record: SessionRecord,
  context: SessionReconcileContext,
): RetireDecision {
  const recordOwner = record.shiftOwner ?? record.shiftName;
  const contextOwner = context.shiftOwner ?? context.shiftName;
  if (typeof recordOwner !== 'string' || recordOwner.trim() === '') {
    return { retire: false, reason: 'session has no owning shift name' };
  }
  if (typeof contextOwner !== 'string' || contextOwner.trim() === '') {
    return { retire: false, reason: 'booting shift has no stable owner key' };
  }
  if (recordOwner !== contextOwner) {
    return {
      retire: false,
      reason: `session belongs to shift '${recordOwner}', not '${contextOwner}'`,
    };
  }
  const pid = record.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { retire: false, reason: 'session has no valid worker pid' };
  }

  const isAlive = context.isAlive ?? defaultIsAlive;
  let alive: boolean;
  try {
    alive = isAlive(pid);
  } catch {
    return { retire: false, reason: `worker pid ${String(pid)} liveness is unknown` };
  }
  if (alive) {
    return { retire: false, reason: `worker pid ${String(pid)} is alive` };
  }

  if (context.harness !== undefined && context.harness !== '' && record.harness !== context.harness) {
    return {
      retire: false,
      reason: `harness mismatch: session uses '${record.harness}', shift uses '${context.harness}'`,
    };
  }

  return { retire: true, reason: `worker pid ${String(pid)} is confirmed dead` };
}

export function reconcileActiveSessions(
  file: string,
  context: SessionReconcileContext,
  now: number,
  opts: SessionStoreOptions = {},
): SessionRecord[] {
  mkdirSync(join(file, '..'), { recursive: true });
  return withWriterLock(file, () => {
    const newest = new Map<string, SessionRecord>();
    for (const rec of readSessions(file, opts)) {
      newest.set(keyOf(rec.workflow, rec.run, rec.step), rec);
    }
    opts.afterWriterSnapshot?.();
    const retired: SessionRecord[] = [];
    for (const rec of newest.values()) {
      if (rec.status !== 'active') continue; // a completed turn is still resumable
      const decision = shouldRetireSession(rec, context);
      if (!decision.retire) {
        opts.debug?.(
          `owenloop work sessions: skipped orphan reconciliation for ${rec.workflow}/${rec.run} ` +
            `step '${rec.step}': ${decision.reason}`,
        );
        if (decision.reason.startsWith('harness mismatch:')) {
          (opts.warn ?? defaultWarn)(
            `owenloop work sessions: refusing to retire ${rec.workflow}/${rec.run} step '${rec.step}': ${decision.reason}`,
          );
        }
        continue;
      }
      appendSessionUnlocked(file, { ...rec, status: 'dead', updatedAt: now }, opts);
      retired.push(rec);
    }
    if (retired.length > 0) compactIfNeededUnlocked(file, opts);
    return retired;
  });
}

/**
 * Append one record, then compact when the file has grown past `maxBytes`.
 *
 * The cross-process writer lock covers the WHOLE transaction: abandoned-tail
 * quarantine, append, size check, and optional compaction rename. If a crashed
 * writer left bytes without the JSONL commit newline, a leading newline commits
 * only that fragment as corrupt before the new complete record. Append and lock
 * failures PROPAGATE; post-append compaction remains best-effort because the
 * appended line is already committed by its trailing JSONL newline in the original log.
 */
export function appendSession(file: string, rec: SessionRecord, opts: SessionStoreOptions = {}): void {
  mkdirSync(join(file, '..'), { recursive: true });
  withWriterLock(file, () => {
    appendSessionUnlocked(file, rec, opts);
    compactIfNeededUnlocked(file, opts);
  });
}
