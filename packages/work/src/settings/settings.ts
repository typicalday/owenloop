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
import { isAbsolute, join } from 'node:path';
import { owenloopConfigDir } from '../../../../src/config-dir.ts';
import { type Roster, validateRoster } from '../agent/capability-model.ts';

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
 *   - `execReserve`    — slots within dispatch cap reserved from agent work.
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
   * Slots inside `dispatchCap` that `agent-run` children may not occupy, so
   * an exec/command order always has room. A non-negative integer: `0`
   * disables the reserve and restores the pre-reserve behavior. Fallback below
   * `--exec-reserve`; default 1.
   */
  execReserve?: number;
  /**
   * How long a shift may retain an undispatchable claim locally before
   * returning it to the hub. Default 0: never retain it locally.
   */
  localQueueHoldMs?: number;
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
  /**
   * The directories a shift on THIS machine may accept as an order's working
   * directory. Absolute paths; a directory permits itself and everything under
   * it.
   *
   * NOT `workRoot` (above) UNDER A DIFFERENT NAME. `workRoot` is a directory
   * owenloop writes per-run subdirectories INTO. This is a list of directories
   * a HUB-SUPPLIED `OrderPacket.workdir` is allowed to name. See
   * `src/agent/workdir.ts` for the side-by-side table and the full rationale.
   *
   * UNSET OR EMPTY MEANS NO RESTRICTION, which is what every shift running
   * today does. Default-closed would refuse work on upgrade, silently, on
   * machines whose operator never asked for a boundary.
   *
   * Overridden by `OWENLOOP_ALLOWED_WORKDIR_ROOTS` (PATH-style, `:`-separated)
   * and by `owenloop shift start --work-root <dir>` (repeatable). The override
   * REPLACES this list; it does not extend it.
   */
  allowedWorkdirRoots?: string[];
  /**
   * Machine-global crew roster: each capability maps to an ordered list of
   * `{harness, model, effort}` candidates. A crew-specific roster file can
   * replace individual capability rows above this layer.
   */
  roster?: Roster;
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
  'execReserve',
  'localQueueHoldMs',
  'workRoot',
  'workRepo',
  'allowedWorkdirRoots',
  'roster',
] as const;

/**
 * Keys owenloop still RECOGNIZES but no longer acts on. Each one produces a
 * warning naming what replaced it, and is excluded from `unrecognized` so the
 * same key is not also reported as a likely typo.
 *
 * Distinct from unrecognized keys, which are surfaced as likely typos. These
 * are recognized legacy settings whose removal leaves current shift behavior
 * unchanged, so they remain a warning rather than a load failure.
 */
export const RETIRED_IGNORED_KEYS = ['escalateAt', 'escalationExtensionKey'] as const;

/**
 * A validated load: the typed `settings` (unknown keys retained for forward
 * compatibility — consumers ignore them), plus the list of keys that are NOT
 * recognized so `owenloop work settings` can flag likely typos.
 */
export interface ValidatedSettings {
  settings: Settings;
  /** Keys present in the file that owenloop does not recognize. */
  unrecognized: string[];
  /**
   * Non-fatal findings from validation, in the order they were noticed.
   *
   * A SEPARATE CHANNEL FROM `unrecognized` because it answers a different
   * question. `unrecognized` says "owenloop does not know this key at all,
   * probably a typo"; a warning says "the key is known, but something about it
   * is worth your attention" — today, only `RETIRED_IGNORED_KEYS`: a key
   * owenloop still recognizes and no longer acts on.
   *
   * Callers decide what to do with these. `owenloop work settings` prints them;
   * the shift prints them once at startup. Nothing here ever blocks a load —
   * anything that should block throws instead.
   */
  warnings: string[];
}

/** The result of inspecting the settings file: where it is, whether it exists, and its validated contents. */
export interface SettingsInspection extends ValidatedSettings {
  path: string;
  exists: boolean;
}

/**
 * Resolve the settings file path from the caller's env, through the one shared
 * ladder in `src/config-dir.ts`: `$OWENLOOP_CONFIG_DIR/settings.json` when
 * `OWENLOOP_CONFIG_DIR` is set and non-blank (it must be absolute), else
 * `$HOME/.owenloop/settings.json`. Throws when no rung yields a value rather
 * than guessing a home directory. `OWENLOOP_CONFIG_DIR` remains for tests and
 * throwaway isolation, not normal operator configuration.
 */
export function settingsPath(env: Record<string, string | undefined>): string {
  return join(owenloopConfigDir(env), 'settings.json');
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
  const warnings: string[] = [];
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
  if ('execReserve' in obj) {
    const v = obj['execReserve'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw bad('execReserve', 'a non-negative integer', v);
    }
  }
  if ('localQueueHoldMs' in obj) {
    const v = obj['localQueueHoldMs'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw bad('localQueueHoldMs', 'a non-negative integer', v);
    }
  }
  if ('allowedWorkdirRoots' in obj) {
    // ABSOLUTE PATHS ONLY, and that is the one rule worth a hard error rather
    // than a warning. A relative entry would resolve against whatever directory
    // the shift process happened to start in — the very "wherever the shift was
    // launched" assumption this key exists to remove — so a boundary written
    // relatively would move with the launch directory and permit a different
    // set of paths on every start.
    const v = obj['allowedWorkdirRoots'];
    if (!Array.isArray(v) || v.some((entry) => typeof entry !== 'string')) {
      throw bad('allowedWorkdirRoots', 'an array of absolute directory paths', v);
    }
    for (const entry of v as string[]) {
      if (entry.trim() === '') {
        throw bad('allowedWorkdirRoots', 'an array of NON-EMPTY absolute directory paths', v);
      }
      if (!isAbsolute(entry)) {
        throw new Error(
          `invalid settings file at ${path}: 'allowedWorkdirRoots' entry ${JSON.stringify(entry)} must be an ` +
            `absolute path — a relative root would resolve against whatever directory the shift was launched in`,
        );
      }
    }
  }
  if ('capabilityModels' in obj) {
    throw new Error(
      `invalid settings file at ${path}: 'capabilityModels' was replaced by 'roster'. ` +
        `Use {"roster":{"wise":[{"harness":"<harness-id>","model":"<model-id>","effort":"high"}]}}.`,
    );
  }
  if ('roster' in obj) {
    const v = obj['roster'];
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw bad('roster', 'a JSON object mapping capabilities to candidate arrays', v);
    }
    try {
      validateRoster(v as Record<string, unknown>, 'roster');
    } catch (e) {
      throw new Error(`invalid settings file at ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // RETIRED, BUT ONLY A WARNING. The difference is what happens if the key is
  // silently ignored.
  //
  // These two configured the WORKER-LOCAL escalation that bumped an order's
  // model after N judgment rejections. Escalation is now entirely the engine's:
  // it re-offers the step composed with the def's `escalation.modifier`, and the
  // shift resolves that new compound like any other. So a file still carrying
  // these describes a mechanism that no longer runs — but escalation itself
  // still happens, correctly, without them. Ignoring them changes no behavior;
  // it only leaves the operator believing a knob does something. A warning says
  // exactly that, and does not stop a shift from starting.
  for (const retired of RETIRED_IGNORED_KEYS) {
    if (retired in obj) {
      warnings.push(
        `'${retired}' no longer does anything and is ignored — retry escalation moved into the engine, ` +
          `which re-offers a rejected step at the def's 'escalation.modifier'. Remove the key.`,
      );
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

  // The retired-but-warned keys count as KNOWN for this purpose. They are not
  // typos — owenloop recognizes them perfectly well and has already said, in a
  // warning, that they no longer take effect. Listing them again under
  // "unrecognized keys (ignored — likely typos)" would contradict that.
  const known = new Set<string>([...KNOWN_SETTINGS_KEYS, ...RETIRED_IGNORED_KEYS]);
  const unrecognized = Object.keys(obj).filter((k) => !known.has(k));
  return { settings: obj as Settings, unrecognized, warnings };
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
  if (!existsSync(path)) return { path, exists: false, settings: {}, unrecognized: [], warnings: [] };
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
