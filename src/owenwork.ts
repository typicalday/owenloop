/**
 * owenwork settings file writer — the ONE place the owenloop CLI writes into a
 * sibling tool's config.
 *
 * `owenwork` (the wiring that runs orders) reads its settings from
 * `$XDG_CONFIG_HOME/owenwork/settings.json` (else `$HOME/.config/owenwork/
 * settings.json`) and, by design, NEVER writes them — the owenloop CLI's `setup`
 * command is the writer, so a fresh `owenloop setup` can point owenwork at the
 * hub it just authenticated against.
 *
 * This module writes exactly ONE key — `hubOrigin` — and preserves every other
 * key byte-for-byte (forward-compat with owenwork's own `cacheDir`, `agentsDir`,
 * `stateDir`, `dispatchCap`, `commandRouting`, and any future/unknown key). It
 * never writes a secret: nothing secret is in scope here by construction (the
 * hub ORIGIN is public).
 *
 * Corrupt-file policy: a settings file that exists but does not parse as a JSON
 * OBJECT is a hard error naming the path — the writer refuses to CLOBBER a file
 * it cannot safely merge into. That mirrors owenwork's own validator wording
 * family ("not an object").
 *
 * Imports only node builtins, `writeFileAtomic` from hub.ts, and `CliError` from
 * util.ts — no CLI/engine closure.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './hub.ts';
import { CliError } from './util.ts';

/**
 * The owenwork settings file path for this environment. `XDG_CONFIG_HOME` (when
 * set and non-blank) wins over `HOME`, matching owenwork's own resolution and
 * the owenloop credential store's `configDir`. Throws when neither is set.
 */
export function owenworkSettingsPath(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== '') return join(xdg, 'owenwork', 'settings.json');
  const home = env.HOME;
  if (home && home.trim() !== '') return join(home, '.config', 'owenwork', 'settings.json');
  throw new CliError('cannot locate a config directory for owenwork settings: set HOME or XDG_CONFIG_HOME');
}

/**
 * Read and parse the owenwork settings file at `path`.
 *
 * - Missing file → `null` (an absent settings file is not an error; the writer
 *   creates one).
 * - Present and parses to a JSON OBJECT → that object (a `Record`).
 * - Present but not valid JSON, or valid JSON that is NOT an object (an array,
 *   `null`, a number, a string) → a hard `CliError` naming the path. The writer
 *   must never clobber a file it cannot merge into.
 */
export function readOwenworkSettingsRaw(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CliError(`owenwork settings file at ${path} is not valid JSON — fix or remove it before running setup`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`owenwork settings file at ${path} is not a JSON object — fix or remove it before running setup`);
  }
  return parsed as Record<string, unknown>;
}

/** The outcome of a `writeOwenworkHubOrigin` call — the path written and the
 * previous `hubOrigin` value (`undefined` when the key was absent or the file
 * did not exist), so a caller can report an old→new transition. */
export interface OwenworkWriteResult {
  path: string;
  previous: string | undefined;
}

/**
 * Set ONLY the `hubOrigin` key in the owenwork settings file to `origin`,
 * preserving every other key. Read the existing file (a parse failure is a hard
 * `CliError` — never clobber), spread it, overwrite `hubOrigin`, `mkdir -p` the
 * directory, and write atomically (temp + rename via `writeFileAtomic`). The
 * file is pretty-printed with a trailing newline. Returns the path and the
 * previous `hubOrigin` (if any).
 */
export function writeOwenworkHubOrigin(env: Record<string, string | undefined>, origin: string): OwenworkWriteResult {
  const path = owenworkSettingsPath(env);
  const existing = readOwenworkSettingsRaw(path);
  const previous = existing !== undefined && existing !== null && typeof existing.hubOrigin === 'string' ? existing.hubOrigin : undefined;
  const merged = { ...(existing ?? {}), hubOrigin: origin };
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`);
  return { path, previous };
}
