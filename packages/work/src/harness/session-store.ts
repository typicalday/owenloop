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
 *    in `src/shift/state.ts`), and a corrupt line is skipped and reported
 *    through the injectable `warn` callback, never thrown. A store that cannot
 *    be parsed must degrade a resume into a replay, not break the worker.
 *  - APPEND PROPAGATES. Unlike the shift's advisory metering records, a lost
 *    session token silently degrades a Phase 4 resume into a cold replay — real
 *    work thrown away — so the caller must see the failure.
 *  - COMPACTION is best-effort (swallowed): the un-compacted file is still
 *    correct, just larger.
 *
 * DEVIATION FROM PLAN §3, stated deliberately: plan §3 says "compact on load if
 * > 2 MB". This module compacts on the WRITE path instead — `appendSession`
 * appends, stats the file, and compacts past `maxBytes`. Reasons: `latestFor`
 * stays side-effect-free (a read never becomes a writer, and never fails on a
 * read-only filesystem), and a small `maxBytes` lets tests exercise compaction
 * without writing 2 MB. The 2 MB default is unchanged.
 *
 * ACCEPTED RACE: `compact` reads, rewrites, and renames, so lines appended by
 * another process in that window are lost. No locking is built. Session records
 * are advisory — a lost token degrades that one step to the designed replay
 * fallback — and compaction only runs past `maxBytes`.
 *
 * Logging follows the house rule (there are zero `console.*` calls anywhere in
 * `src/`): the library takes an injectable callback and the default writes to
 * stderr, so tests stay silent and assertable.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  attempt: number;
  /** Adapter id (`HarnessSessionRef.harness`). */
  harness: string;
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
  /** Called once per skipped corrupt line. Default writes to stderr. */
  warn?: (line: string) => void;
  /** Compaction threshold in bytes, checked after each append. Default 2 MB. */
  maxBytes?: number;
}

/** Default compaction threshold — plan §3's 2 MB. */
export const DEFAULT_MAX_BYTES = 2_000_000;

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
 * Validate one parsed line. Checks exactly the fields whose absence would make
 * the record unusable for a resume: the three key fields plus the harness and
 * token it exists to carry, and a `status` inside the four literals. Everything
 * else is carried verbatim.
 */
function isSessionRecord(v: unknown): v is SessionRecord {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (!isNonEmptyString(r['workflow'])) return false;
  if (!isNonEmptyString(r['run'])) return false;
  if (!isNonEmptyString(r['step'])) return false;
  if (!isNonEmptyString(r['harness'])) return false;
  if (!isNonEmptyString(r['token'])) return false;
  if (typeof r['status'] !== 'string' || !STATUSES.has(r['status'])) return false;
  return true;
}

/** Atomic write: temp file + rename into place. Fs errors propagate to the
 *  caller (the one caller, `compact`, is the one that swallows them). Mirrors
 *  the private helper in `src/bundle/cache.ts` — copied on purpose rather than
 *  exported from there, so the cache module's surface stays about bundles. */
function atomicWrite(filePath: string, content: string): void {
  const dir = join(filePath, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${Math.random().toString(36).slice(2)}-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, filePath);
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
 * `[]`. Blank lines are skipped silently; every other unusable line is skipped
 * and reported through `warn` with its 1-indexed line number. Never throws.
 */
export function readSessions(file: string, opts: SessionStoreOptions = {}): SessionRecord[] {
  const warn = opts.warn ?? defaultWarn;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return []; // fail-open: no store yet is the normal first-run case
  }
  const out: SessionRecord[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue; // noUncheckedIndexedAccess
    if (line.trim() === '') continue; // blank lines are not corruption
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warn(`owenloop work sessions: skipping corrupt record at ${file}:${i + 1}`);
      continue;
    }
    if (!isSessionRecord(parsed)) {
      warn(`owenloop work sessions: skipping corrupt record at ${file}:${i + 1}`);
      continue;
    }
    out.push(parsed);
  }
  return out;
}

/**
 * The newest record for `(workflow, run, step)`, or `null` when the file is
 * missing or holds no match. Scans forward and keeps the LAST match (last-wins).
 * Side-effect-free — it never writes, never compacts, and never throws.
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
 * Rewrite `file` with only the last record per `(workflow, run, step)`,
 * preserving FIRST-SEEN key order, via temp file + rename. Corrupt lines are
 * dropped in the process (they were already unreadable). A missing file is a
 * no-op. Fs failures propagate here; `appendSession` is what swallows them.
 */
export function compact(file: string, opts: SessionStoreOptions = {}): void {
  const records = readSessions(file, opts);
  if (records.length === 0) return;
  const byKey = new Map<string, SessionRecord>();
  for (const rec of records) {
    // Map preserves first-insertion order across re-set, which is exactly the
    // first-seen key order we want to keep.
    byKey.set(keyOf(rec.workflow, rec.run, rec.step), rec);
  }
  const body = [...byKey.values()].map((r) => JSON.stringify(r)).join('\n');
  atomicWrite(file, `${body}\n`);
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
 * live row without rewriting history — and it keeps the ACCEPTED RACE in this
 * module's header (compaction losing concurrent appends) as the only writer race.
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
  const newest = new Map<string, SessionRecord>();
  for (const rec of readSessions(file, opts)) {
    if (rec.workflow !== workflow || rec.run !== run) continue;
    newest.set(keyOf(rec.workflow, rec.run, rec.step), rec);
  }
  const marked: string[] = [];
  for (const rec of newest.values()) {
    if (rec.status === 'dead') continue; // already retired — nothing to append
    appendSession(file, { ...rec, status: 'dead', updatedAt: now }, opts);
    marked.push(rec.step);
  }
  return marked;
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
 * So ONLY `active` rows are eligible, and only for runs absent from
 * `liveRunIds`.
 *
 * ── WHY RETIRING AN ORPHANED `active` ROW IS THE RIGHT DIRECTION TO BE WRONG ──
 *
 * An interrupted turn is the state you least want to resume into: the harness may
 * have half-applied tool calls the worker has no record of, so a resumed session
 * would carry a model that believes work happened which did not. The cost of
 * retiring it is one cold replay. The cost of resuming it is silent divergence.
 *
 * ── KNOWN FALSE POSITIVE, STATED RATHER THAN ENGINEERED AROUND ───────────────
 *
 * An `owenloop work agent-run` started BY HAND, outside the shift, has no child record
 * in the shift state dir, so a shift booting at that moment sees its `active` row
 * as orphaned and retires it. The cost is one cold replay on a hand-run debugging
 * session. Two things keep it small: the caller invokes this at BOOT only, which
 * narrows the window to an instant, and every retirement is returned so the
 * caller can log it with its `(workflow, run, step)`. Do NOT add a pid field to
 * `SessionRecord` to close this — the record is deliberately machine-portable
 * metadata, and the shift state dir is already the system of record for liveness.
 *
 * IDEMPOTENT: the rows it appends are `dead`, so a second call finds nothing
 * `active` left and appends nothing.
 *
 * FAILURE STANCE: `appendSession` propagates, and so does this — same as
 * `markRunSessionsDead`.
 *
 * @param liveRunIds run ids with a live `agent-run` child RIGHT NOW. A run in
 *   this set is skipped whatever its status.
 * @returns the records that were retired, as they were BEFORE retirement, so the
 *   caller can log what it took away.
 */
export function reconcileActiveSessions(
  file: string,
  liveRunIds: ReadonlySet<string>,
  now: number,
  opts: SessionStoreOptions = {},
): SessionRecord[] {
  const newest = new Map<string, SessionRecord>();
  for (const rec of readSessions(file, opts)) {
    newest.set(keyOf(rec.workflow, rec.run, rec.step), rec);
  }
  const retired: SessionRecord[] = [];
  for (const rec of newest.values()) {
    if (rec.status !== 'active') continue; // a completed turn is still resumable
    if (liveRunIds.has(rec.run)) continue; // its worker is alive; the row is true
    appendSession(file, { ...rec, status: 'dead', updatedAt: now }, opts);
    retired.push(rec);
  }
  return retired;
}

/**
 * Append one record, then compact when the file has grown past `maxBytes`.
 *
 * The whole line is written in ONE `appendFileSync` call (with its trailing
 * newline) so concurrent workers' O_APPEND writes interleave line-atomically on
 * local filesystems. Append failures PROPAGATE — see this module's failure
 * stance. The post-append compaction is best-effort and swallowed.
 */
export function appendSession(file: string, rec: SessionRecord, opts: SessionStoreOptions = {}): void {
  mkdirSync(join(file, '..'), { recursive: true });
  appendFileSync(file, `${JSON.stringify(rec)}\n`);

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  try {
    if (statSync(file).size > maxBytes) compact(file, opts);
  } catch {
    // best-effort: an un-compacted (or unstatable) file is still correct.
  }
}
