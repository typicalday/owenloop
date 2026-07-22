/** Small dependency-light helpers. */

import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';

/**
 * A user-facing CLI/library error whose `message` is printed as-is (no stack
 * trace) — the "expected, explained" failure class, distinct from a programming
 * bug. Homed here in `util.ts` (which has no project-internal imports) so it can
 * be shared by `cli.ts` (where `RateLimitError extends CliError`) and
 * `credentials.ts` (which must throw it without importing `cli.ts`, avoiding a
 * cycle and keeping the library barrel from ever loading `cli.ts`). Deliberately
 * NOT re-exported from the package barrel (`src/index.ts`): it was module-private
 * before, and the credential-write PR does not widen the public API beyond the
 * functions the proposal names.
 */
export class CliError extends Error {}

/**
 * `mkdir -p` for a project-state directory (e.g. `.owenloop`), refusing to
 * create it through a symlinked component (SEC-3, parent-directory half).
 *
 * The destination-FILE symlink defense lives in `hub.ts`'s `writeFileAtomic`;
 * this closes the sibling hole where the PARENT directory itself is a symlink.
 * If `.owenloop` is a symlink to a directory elsewhere, `mkdirSync(dir, {
 * recursive: true })` silently succeeds (the target already exists) and every
 * subsequent write lands beneath the link target, outside the project checkout
 * — a hostile checkout can ship `.owenloop -> /somewhere/else` to redirect
 * writes that way.
 *
 * Lives in `util.ts` (engine core) rather than `hub.ts` so the core store
 * factory (`factory.ts`) can share the one helper without core depending on a
 * hub/CLI module (the `boundaries.test.ts` core→hub import boundary).
 *
 * Behavior:
 * 1. `lstat` the dir. If it is a symbolic link (to a directory, to a file, or
 *    dangling), throw a clear error naming the path. A dangling symlink matters
 *    too: recursive `mkdir` would otherwise CREATE the link target.
 * 2. If it exists and is not a directory (a plain file), throw a clear
 *    "not a directory" error rather than letting `mkdirSync` surface a raw
 *    EEXIST/ENOTDIR — mirroring `writeFileAtomic`'s directory-refusal courtesy.
 * 3. Otherwise `mkdirSync(dir, { recursive: true })` — creates it fresh when
 *    missing, no-op when a real directory already exists.
 *
 * TOCTOU stance matches `writeFileAtomic`: the `lstat` immediately before the
 * `mkdir` defends the STATIC hostile-checkout threat (the attacker controls
 * repo contents at clone time). Unlike `rename`, `mkdir` does not neutralize a
 * symlink raced into place between the `lstat` and the `mkdir` — a live local
 * attacker racing the process is outside this threat model, the same caveat
 * framing `writeFileAtomic` carries.
 */
export function mkdirRefusingSymlink(dir: string): void {
  const existing = lstatSync(dir, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    throw new Error(`refusing to write under ${dir}: it is a symbolic link`);
  }
  if (existing && !existing.isDirectory()) {
    throw new Error(`refusing to write under ${dir}: it is not a directory`);
  }
  mkdirSync(dir, { recursive: true });
}

/**
 * File-level half of SEC-3: refuse to open the DEFAULT `state.db` (and its
 * SQLite sidecars) through a symlink. PR #47 / `mkdirRefusingSymlink` closed
 * the PARENT-directory hole; this closes the sibling one where `.owenloop` is a
 * REAL directory but `state.db` (or a sidecar) is a symlink to a file
 * elsewhere. Opening the database follows that file symlink, redirecting every
 * write outside the project checkout — a hostile checkout can ship
 * `.owenloop/state.db -> /elsewhere` to do exactly that.
 *
 * Sidecars are guarded, not just the main file: `store.ts` runs
 * `PRAGMA journal_mode = WAL`, so writes flow through `state.db-wal` and
 * coordinate via the mmap'd `state.db-shm`. SQLite's unix VFS opens both with
 * plain `open(2)`, which follows file symlinks unless `SQLITE_OPEN_NOFOLLOW` is
 * passed — and `node:sqlite`'s `DatabaseSync` does not pass it. So a regular
 * (or absent) `state.db` with `state.db-wal -> /elsewhere` still redirects
 * writes; WAL mode does not make the sidecars moot. `state.db-journal` only
 * matters in rollback-journal modes, but a pre-existing hostile db opens in its
 * on-disk journal mode until the WAL switch runs, so its journal can be touched
 * transiently during open — one more loop iteration guards it too.
 *
 * Lives in `util.ts` (engine core) alongside `mkdirRefusingSymlink` so both
 * `factory.ts` (core) and `cli.ts` share the one helper without core depending
 * on a hub/CLI module (the `boundaries.test.ts` core→hub import boundary).
 *
 * Behavior, for each of `<dbPath>`, `-wal`, `-shm`, `-journal`:
 * 1. `lstat` it. Missing → fine (a fresh create).
 * 2. A symbolic link (to a file, a directory, or dangling — `lstat` reports the
 *    link itself either way) → throw a clear error naming the path. A dangling
 *    link matters too: opening it would otherwise CREATE the link target.
 * 3. Exists but is not a regular file (a directory, FIFO, …) → throw a clear
 *    "not a regular file" error rather than letting SQLite surface a rawer one
 *    — a symmetry courtesy mirroring `mkdirRefusingSymlink`'s "not a directory"
 *    branch.
 * 4. A regular file → fine (a normal reopen).
 *
 * TOCTOU stance matches `writeFileAtomic`/`mkdirRefusingSymlink`: the `lstat`
 * defends the STATIC hostile-checkout threat (the attacker controls repo
 * contents at clone time). A live local attacker racing a symlink into place
 * between the `lstat` and SQLite's open is outside this threat model, the same
 * caveat those siblings carry.
 */
export function dbPathRefusingSymlink(dbPath: string): void {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
    const existing = lstatSync(p, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) {
      throw new Error(`refusing to write to ${p}: it is a symbolic link`);
    }
    if (existing && !existing.isFile()) {
      throw new Error(`refusing to write to ${p}: it is not a regular file`);
    }
  }
}

/** Deterministic id from parts — same parts always yield the same id. */
export function detId(prefix: string, ...parts: string[]): string {
  const h = createHash('sha1').update(parts.join(' ')).digest('hex');
  return `${prefix}_${h.slice(0, 24)}`;
}

/** Random unique id — for instances (workflow/run) that must not collide. */
export function randId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

const DUR_RE = /^(\d+)([hms]?)$/;
const UNIT_MS: Record<string, number> = { h: 3600000, m: 60000, s: 1000, '': 1000 };

/** "30m" → 1800000 ms, "2h" → 7200000, "45s"/"45" → 45000. */
export function parseDurationMs(spec: string): number {
  const m = DUR_RE.exec(String(spec).trim());
  if (!m) throw new Error(`bad duration: ${spec} (use 90m, 2h, or seconds)`);
  return Number(m[1]) * (UNIT_MS[m[2] as string] as number);
}

/** "30m" → 1800 seconds. */
export function parseDurationSecs(spec: string): number {
  return Math.round(parseDurationMs(spec) / 1000);
}

/**
 * Local-midnight epoch ms (for daily budget windows), using the HOST's
 * local timezone (Date#setHours operates in local time).
 *
 * Caveats:
 * - DST transitions: the "day" containing a spring-forward or fall-back
 *   transition is 23h or 25h long, not 24h, so a maxRunsPerDay budget can
 *   reset slightly early or late around DST changes. This is a standard
 *   property of any local-calendar-day window and self-corrects the next
 *   day.
 * - Multi-host deployments: if multiple hosts in different timezones
 *   drive the same store, they will disagree about what "today" is and
 *   can therefore disagree on maxRunsPerDay accounting for the same step.
 *   This is a known limitation, not a bug — there is no currently
 *   documented multi-timezone deployment scenario for this engine (see
 *   docs/design.md); if one is adopted later, switch this window to UTC
 *   midnight and update call sites accordingly.
 */
export function localMidnightMs(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function nowMs(): number {
  return Date.now();
}
