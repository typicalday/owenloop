/**
 * `owenloop work settings` — print the resolved settings file: its path, whether it
 * exists, each known knob with its value and provenance, and any unrecognized
 * keys (likely typos). Read-only; there is no write/edit form in v1.
 *
 * This reflects what the FILE supplies — the lowest-precedence tier. It does
 * NOT resolve CLI flags or env vars (those belong to the individual roles at
 * run time); a knob absent from the file prints its built-in default (where one
 * exists) or `unset`.
 *
 * Exit codes: 0 when the settings are valid (including no file at all) · 1 when
 * the file is malformed JSON or a known key has the wrong type · 2 on stray
 * args (there are no options in v1).
 */
import { inspectSettings, KNOWN_SETTINGS_KEYS } from '../settings/settings.ts';

/** Built-in defaults shown for knobs absent from the file (else `unset`). */
const DEFAULT_NOTE: Partial<Record<(typeof KNOWN_SETTINGS_KEYS)[number], string>> = {
  dispatchCap: '3',
  commandRouting: 'shift',
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface RunDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  env?: Record<string, string | undefined>;
}

export async function run(args: string[], deps: RunDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const env = deps.env ?? process.env;

  if (args.length > 0) {
    err(`owenloop work settings: unexpected argument '${args[0]}'`);
    err('usage: owenloop work settings');
    return 2;
  }

  let inspection;
  try {
    inspection = inspectSettings(env);
  } catch (e) {
    err(`owenloop work settings: ${errMsg(e)}`);
    return 1;
  }

  const { path, exists, settings, unrecognized } = inspection;
  out(`settings file: ${path}`);
  out(`exists: ${exists ? 'yes' : 'no'}`);
  out('');
  for (const key of KNOWN_SETTINGS_KEYS) {
    const value = (settings as Record<string, unknown>)[key];
    if (value !== undefined) {
      out(`  ${key} = ${formatValue(value)}  (settings)`);
    } else if (DEFAULT_NOTE[key] !== undefined) {
      out(`  ${key} = ${DEFAULT_NOTE[key]}  (default)`);
    } else {
      out(`  ${key} = (unset)`);
    }
  }
  if (unrecognized.length > 0) {
    out('');
    out(`unrecognized keys (ignored — likely typos): ${unrecognized.join(', ')}`);
  }
  return 0;
}

/** Render a settings value for display: strings bare, everything else JSON. */
function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
