/**
 * execution settings file writer — the ONE place the root `owenloop` CLI writes
 * into the execution-side settings file.
 *
 * `owenloop work` reads its settings from `$OWENLOOP_CONFIG_DIR/settings.json`
 * (else `$XDG_CONFIG_HOME/owenloop/settings.json`, else
 * `$HOME/.config/owenloop/settings.json`) and, by design,
 * NEVER writes them — the root CLI's `setup` command is the writer, so a fresh
 * `owenloop setup` can point `owenloop work` at the hub it just authenticated
 * against.
 *
 * This module writes exactly ONE key — `hubOrigin` — and preserves every other
 * key byte-for-byte (forward-compat with the execution settings' `cacheDir`,
 * `agentsDir`, `stateDir`, `dispatchCap`, `commandRouting`, and any future or
 * unknown key). It never writes a secret: nothing secret is in scope here by
 * construction (the hub ORIGIN is public).
 *
 * Corrupt-file policy: a settings file that exists but does not parse as a JSON
 * OBJECT is a hard error naming the path — the writer refuses to CLOBBER a file
 * it cannot safely merge into. That mirrors the work settings validator's
 * wording family ("not an object").
 *
 * Imports only node builtins, `writeFileAtomic` from hub.ts, and `CliError` from
 * util.ts — no CLI/engine closure.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { owenloopConfigDir } from './config-dir.ts';
import { writeFileAtomic } from './hub.ts';
import { CliError } from './util.ts';

/**
 * The execution settings file path for this environment, through the one shared
 * ladder in `config-dir.ts`: `OWENLOOP_CONFIG_DIR` (absolute, used verbatim)
 * wins over `$XDG_CONFIG_HOME/owenloop`, which wins over
 * `$HOME/.config/owenloop`. Throws as a `CliError` when no rung yields a value,
 * so the CLI reports it as an operator error rather than a crash.
 */
export function owenloopSettingsPath(env: Record<string, string | undefined>): string {
  try {
    return join(owenloopConfigDir(env), 'settings.json');
  } catch (err) {
    throw new CliError(
      `cannot locate a config directory for execution settings: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read and parse the execution settings file at `path`.
 *
 * - Missing file → `null` (an absent settings file is not an error; the writer
 *   creates one).
 * - Present and parses to a JSON OBJECT → that object (a `Record`).
 * - Present but not valid JSON, or valid JSON that is NOT an object (an array,
 *   `null`, a number, a string) → a hard `CliError` naming the path. The writer
 *   must never clobber a file it cannot merge into.
 */
export function readOwenloopSettingsRaw(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CliError(`execution settings file at ${path} is not valid JSON — fix or remove it before running setup`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`execution settings file at ${path} is not a JSON object — fix or remove it before running setup`);
  }
  return parsed as Record<string, unknown>;
}

/** The outcome of a `writeOwenloopHubOrigin` call — the path written and the
 * previous `hubOrigin` value (`undefined` when the key was absent or the file
 * did not exist), so a caller can report an old→new transition. */
export interface OwenloopWriteResult {
  path: string;
  previous: string | undefined;
}

/**
 * Set ONLY the `hubOrigin` key in the execution settings file to `origin`,
 * preserving every other key. Read the existing file (a parse failure is a hard
 * `CliError` — never clobber), spread it, overwrite `hubOrigin`, `mkdir -p` the
 * directory, and write atomically (temp + rename via `writeFileAtomic`). The
 * file is pretty-printed with a trailing newline. Returns the path and the
 * previous `hubOrigin` (if any).
 */
export function writeOwenloopHubOrigin(env: Record<string, string | undefined>, origin: string): OwenloopWriteResult {
  const path = owenloopSettingsPath(env);
  const existing = readOwenloopSettingsRaw(path);
  const previous = existing !== undefined && existing !== null && typeof existing.hubOrigin === 'string' ? existing.hubOrigin : undefined;
  const merged = { ...(existing ?? {}), hubOrigin: origin };
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`);
  return { path, previous };
}
