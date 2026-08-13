/**
 * Settings locate, load, and validate. This is the machine-level config
 * surface for owenloop's roles, mirroring owenloop's convention (D12): a
 * single JSON file at an XDG/HOME path supplying the fallback values every
 * role resolves (CLI flag > env var > settings file > built-in default).
 *
 * C1 pinned where the file lives and how it loads; C2 added the first two
 * fields; C6 fills in the full surface (dispatch cap + agents/state dirs),
 * adds type validation with actionable errors, and surfaces unrecognized keys
 * so typos are visible via `owenloop work settings`.
 *
 * HARD RULE: NO secrets ever live in this file. Credentials stay in owenloop's
 * own store (the CredentialReader seam) — there is deliberately no token knob.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateTierProfiles, type TierProfiles } from '../agent/model-policy.ts';

/**
 * The settings surface — every knob optional, a missing file loading as `{}`.
 * Each field is the lowest-precedence fallback for a role option (a CLI flag
 * or env var always wins over it):
 *   - `hubOrigin`      — default hub origin when `--origin` is omitted
 *     (prepare, shift, hold, exec, release).
 *   - `cacheDir`       — bundle cache root; overrides the XDG default
 *     (see bundle/cache.ts).
 *   - `stateDir`       — shift in-flight state dir; overrides the XDG default
 *     (below `OWENLOOP_STATE_DIR`).
 *   - `dispatchCap`    — shift max in-flight exec children; below `--cap`,
 *     above the built-in default of 3. A positive integer.
 *   - `shiftLogDir`    — where `shift.log` and `<run>.log` are written; below
 *     `--log-dir` and `OWENLOOP_SHIFT_LOG_DIR`, above the state dir.
 *   - `shiftLogMaxAgeMs` — worker-log retention in ms; below `--log-max-age`
 *     and `OWENLOOP_SHIFT_LOG_MAX_AGE_MS`, above the 14-day default.
 *   - `commandRouting` — who runs `executor: 'command'` steps this machine sees.
 *   - `defPolicy`      — local publication trust policy (`warn` by default).
 */
export interface Settings {
  /** Default hub origin when `--origin` is omitted. */
  hubOrigin?: string;
  /** Bundle cache root; overrides the XDG default (see bundle/cache.ts). */
  cacheDir?: string;
  /** Shift in-flight state dir; fallback below `--state-dir`/env. */
  stateDir?: string;
  /** Shift dispatch cap (positive integer); fallback below `--cap`, default 3. */
  dispatchCap?: number;
  /**
   * Directory holding the shift's own `shift.log` and each worker's `<run>.log`.
   * Fallback below `--log-dir` and `OWENLOOP_SHIFT_LOG_DIR`; defaults to the
   * resolved `stateDir`, which puts `<run>.log` beside its `<run>.json`.
   */
  shiftLogDir?: string;
  /**
   * How long a worker's `<run>.log` is kept, in milliseconds. Fallback below
   * `--log-max-age` and `OWENLOOP_SHIFT_LOG_MAX_AGE_MS`; defaults to 14 days.
   *
   * A NON-NEGATIVE integer, unlike `dispatchCap`, which must be positive: `0`
   * is meaningful here and means "reap every worker log whose run has
   * completed, at the next shift startup".
   *
   * Applies ONLY to per-worker `<run>.log` files. `shift.log` is never reaped
   * and never rotated — see `docs/shift-logs.md`.
   */
  shiftLogMaxAgeMs?: number;
  /**
   * Who runs `executor: 'command'` steps this machine sees: `'shift'` (default)
   * lets the shift auto-dispatch them; `'manual'` leaves them for a human/
   * session to pick up via the pickup window. The C3 shift is the only reader.
   * A per-step `x.owenloop.routing` override can tighten (never loosen) this —
   * most restrictive wins (see src/shift/routing.ts).
   */
  commandRouting?: 'shift' | 'manual';
  /**
   * Publication trust policy for installed workflow definitions. `warn` is the
   * built-in default; `enforce` refuses unsigned/unverifiable definitions and
   * `off` suppresses those warnings for agent orders only. Command workers
   * always require a verified definition regardless of this value.
   */
  defPolicy?: 'enforce' | 'warn' | 'off';
  /** Policy for signed consumed artifact values; defaults to `warn`. */
  artifactPolicy?: 'enforce' | 'warn' | 'off';
  /**
   * Max in-flight `agent-run` children (positive integer, default 4 —
   * `DEFAULT_MAX_AGENTS` in `src/roles/shift.ts`). A SEPARATE
   * budget from `dispatchCap`, which meters `exec` children — an agent turn is
   * long and memory-heavy where a command is short, so one number cannot serve
   * both. Fallback below `--max-agents`.
   */
  maxConcurrentAgents?: number;
  /**
   * Phase 4 — the root under which per-RUN agent working directories live.
   *
   * An `agent-run` child works in `<workRoot>/<workflow>/<run>/`, created on
   * first use. PER RUN, not per step: every step of a run shares one directory,
   * which is what lets a downstream step read what an upstream step wrote, and
   * what makes the removal gate a single question ("does this run still have an
   * open order?") instead of a `consumes` walk.
   *
   * Default when unset: `<cacheDir>/work`. Overridden per order by
   * `OrderPacket.workdir` — the hub always wins, and a hub-supplied workdir is
   * NEVER removed by the reaper, which only ever removes what it created under
   * `workRoot`.
   *
   * Pulled forward from Phase 5, which `docs/agent-runner.md` originally
   * deferred it to: worktree lifetime is not implementable without a work root.
   */
  workRoot?: string;
  /**
   * Phase 4 — an optional local git repo. When set, a per-run work directory is
   * created as `git worktree add` against this repo instead of a plain `mkdir`,
   * and removed with `git worktree remove` instead of a plain `rm -rf`.
   *
   * LOCALLY OPT-IN, deliberately. Nothing in `src/bundle/types.ts` or
   * `src/hub/types.ts` lets a workflow declare a repo, and adding one would be a
   * hub protocol change — an explicit non-goal. So worktree mode is a property
   * of the MACHINE running the shift, not of the workflow.
   */
  workRepo?: string;
  /** Quality-tier to concrete model mapping; merged over the built-in map. */
  tierMap?: Record<string, string>;
  /**
   * Quality-tier to `{ model, efforts, defaultEffort }`. When present this
   * REPLACES `tierMap` for every tier-named step model — it is not merged with
   * the built-in map and not merged with `tierMap`, so it must define all four
   * tiers or the load fails. That is the whole point: `tierMap` merges, which
   * means a file naming three tiers silently inherits a default for the fourth.
   */
  tierProfiles?: Record<string, { model: string; efforts: string[]; defaultEffort: string }>;
  /** Reject count at which the default retry policy escalates. */
  escalateAt?: number;
  /** Extension namespace containing an authored escalation object. */
  escalationExtensionKey?: string;
}

/** The known settings keys, in the order `owenloop work settings` prints them. */
export const KNOWN_SETTINGS_KEYS = [
  'hubOrigin',
  'cacheDir',
  'stateDir',
  'dispatchCap',
  'shiftLogDir',
  'shiftLogMaxAgeMs',
  'commandRouting',
  'defPolicy',
  'artifactPolicy',
  'maxConcurrentAgents',
  'workRoot',
  'workRepo',
  'tierMap',
  'tierProfiles',
  'escalateAt',
  'escalationExtensionKey',
] as const;

/**
 * A validated load: the typed `settings` (unknown keys retained for forward
 * compatibility — consumers ignore them), plus the list of keys that are NOT
 * recognized so `owenloop work settings` can flag likely typos.
 */
export interface ValidatedSettings {
  settings: Settings;
  /** Keys present in the file that owenloop does not recognize. */
  unrecognized: string[];
}

/** The result of inspecting the settings file: where it is, whether it exists, and its validated contents. */
export interface SettingsInspection extends ValidatedSettings {
  path: string;
  exists: boolean;
}

/**
 * Resolve the settings file path from the caller's env:
 * `$XDG_CONFIG_HOME/owenloop/settings.json` when `XDG_CONFIG_HOME` is set and
 * non-empty, else `$HOME/.config/owenloop/settings.json`. Throws when neither
 * is available rather than guessing a home directory.
 */
export function settingsPath(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.trim() !== '') return join(xdg, 'owenloop', 'settings.json');
  const home = env.HOME;
  if (home !== undefined && home.trim() !== '') return join(home, '.config', 'owenloop', 'settings.json');
  throw new Error('cannot locate a settings directory: set HOME or XDG_CONFIG_HOME');
}

/**
 * Validate a parsed settings object. Checks the TYPE of every known key
 * (throwing an actionable error naming the key, expected type, received value,
 * and file path on a mismatch) and collects any unrecognized keys. Unknown
 * keys are retained on the returned `settings` (forward compatible) — only
 * their names are reported, never fatal.
 *
 * `dispatchCap` must be a positive integer; `commandRouting` must be one of the
 * two literals. Any other type on a known key is a hard error.
 */
export function validateSettings(raw: unknown, path: string): ValidatedSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const got = Array.isArray(raw) ? 'array' : raw === null ? 'null' : typeof raw;
    throw new Error(`invalid settings file at ${path}: expected a JSON object, got ${got}`);
  }
  const obj = raw as Record<string, unknown>;
  const bad = (key: string, expected: string, value: unknown): Error =>
    new Error(
      `invalid settings file at ${path}: '${key}' must be ${expected}, got ${JSON.stringify(value)}`,
    );

  for (const key of ['hubOrigin', 'cacheDir', 'stateDir', 'shiftLogDir', 'workRoot', 'workRepo'] as const) {
    if (key in obj && typeof obj[key] !== 'string') throw bad(key, 'a string', obj[key]);
  }
  if ('shiftLogMaxAgeMs' in obj) {
    // NON-NEGATIVE, not positive: 0 means "reap every completed run's log at the
    // next startup", which is a legitimate setting on a disk-constrained host.
    const v = obj['shiftLogMaxAgeMs'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw bad('shiftLogMaxAgeMs', 'a non-negative integer', v);
    }
  }
  if ('dispatchCap' in obj) {
    const v = obj['dispatchCap'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw bad('dispatchCap', 'a positive integer', v);
    }
  }
  if ('maxConcurrentAgents' in obj) {
    const v = obj['maxConcurrentAgents'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw bad('maxConcurrentAgents', 'a positive integer', v);
    }
  }
  if ('tierMap' in obj) {
    const v = obj['tierMap'];
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw bad('tierMap', 'an object whose values are non-empty strings', v);
    }
    for (const value of Object.values(v as Record<string, unknown>)) {
      if (typeof value !== 'string' || value.trim() === '') throw bad('tierMap', 'an object whose values are non-empty strings', v);
    }
  }
  if ('tierProfiles' in obj) {
    const v = obj['tierProfiles'];
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw bad('tierProfiles', 'an object of { model, efforts, defaultEffort } per tier', v);
    }
    for (const [tier, profile] of Object.entries(v as Record<string, unknown>)) {
      if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
        throw bad(`tierProfiles.${tier}`, 'an object with model, efforts and defaultEffort', profile);
      }
    }
    // Shape is right; now the SEMANTIC rules — completeness, known effort
    // rungs, defaultEffort actually offered. Deliberately at load time: a crew
    // whose profiles are wrong should fail when the shift starts, not on the
    // first order that happens to land on the broken tier, hours later.
    try {
      validateTierProfiles(v as TierProfiles);
    } catch (e) {
      throw new Error(`invalid settings: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if ('escalateAt' in obj) {
    const v = obj['escalateAt'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw bad('escalateAt', 'a positive integer', v);
    }
  }
  if ('escalationExtensionKey' in obj) {
    const v = obj['escalationExtensionKey'];
    if (typeof v !== 'string' || v.trim() === '') {
      throw bad('escalationExtensionKey', 'a non-empty string', v);
    }
  }
  if ('commandRouting' in obj) {
    const v = obj['commandRouting'];
    if (v !== 'shift' && v !== 'manual') throw bad('commandRouting', "'shift' or 'manual'", v);
  }
  if ('defPolicy' in obj) {
    const v = obj['defPolicy'];
    if (v !== 'enforce' && v !== 'warn' && v !== 'off') {
      throw bad('defPolicy', "'enforce', 'warn', or 'off'", v);
    }
  }
  if ('artifactPolicy' in obj) {
    const v = obj['artifactPolicy'];
    if (v !== 'enforce' && v !== 'warn' && v !== 'off') {
      throw bad('artifactPolicy', "'enforce', 'warn', or 'off'", v);
    }
  }

  const known = new Set<string>(KNOWN_SETTINGS_KEYS);
  const unrecognized = Object.keys(obj).filter((k) => !known.has(k));
  return { settings: obj as Settings, unrecognized };
}

/**
 * Inspect the settings file: resolve its path, whether it exists, and its
 * validated contents. A missing file is not an error (`exists: false`,
 * settings `{}`). Malformed JSON or an invalid known-key type throws a clear,
 * path-named error. This is the single read+validate path that `loadSettings`
 * and the `settings` print role share.
 */
export function inspectSettings(env: Record<string, string | undefined>): SettingsInspection {
  const path = settingsPath(env);
  if (!existsSync(path)) return { path, exists: false, settings: {}, unrecognized: [] };
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`malformed settings file at ${path}: ${reason}`);
  }
  return { path, exists: true, ...validateSettings(parsed, path) };
}

/**
 * Load, parse, and validate the settings file. A missing file yields `{}` (not
 * an error). Malformed JSON or an invalid known-key type throws a clear error
 * rather than silently defaulting — a silent default would mask config bugs.
 * Every consumer that calls `loadSettings` gets known-key type validation for
 * free; unknown keys pass through untouched.
 */
export function loadSettings(env: Record<string, string | undefined>): Settings {
  return inspectSettings(env).settings;
}
