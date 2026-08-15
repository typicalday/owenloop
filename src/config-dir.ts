/**
 * The ONE resolver for owenloop's own user-level config directory — the
 * directory that directly holds `settings.json`, `credentials.json`,
 * `allowed_signers`, `org-root.pub`, `roster/`, and `revocations/`.
 *
 * WHY THIS MODULE EXISTS. Until now four call sites each re-derived the same
 * ladder — `$XDG_CONFIG_HOME/owenloop` else `$HOME/.config/owenloop` — and
 * `XDG_CONFIG_HOME` was therefore the ONLY lever an operator had for pointing
 * one owenloop process at a different settings file than another. That lever is
 * not owenloop's to take. `XDG_CONFIG_HOME` is a machine-wide contract that
 * `gh`, `git`, `gcloud`, `npm`, and most of the rest of a developer's toolchain
 * also read, and `owenloop shift start` spreads its whole environment into
 * every worker it dispatches (`shift/spawn.ts`), which in turn passes it to
 * every command step's child process (`exec/` sets exactly three variables of
 * its own on top). So an operator running two shifts with different
 * `capabilityModels` had to set `XDG_CONFIG_HOME` per shift, and that silently
 * relocated the config of every other tool the workflow's scripts shell out to.
 *
 * MEASURED, not theorized. On run `wf_8b2abe6b` the delivery line's `merge-gate`
 * and `merger` steps both failed inside their `gh` probes, because `gh` looked
 * for `hosts.yml` under the shift profile's `XDG_CONFIG_HOME` and found no
 * credential there. `merge-gate` burned its full 40-minute wall clock deferring
 * on a fail-open CI verdict; `merger` then failed four times running with
 * `could not resolve a pull request handle for the branch`. Both probes returned
 * the correct answer the instant they were run with the operator's real
 * `XDG_CONFIG_HOME`. Nothing was wrong with either script.
 *
 * THE FIX IS AN OWENLOOP-SPECIFIC VARIABLE. `OWENLOOP_CONFIG_DIR` names the
 * owenloop config directory ITSELF — no `owenloop` path segment is appended to
 * it — so an operator can scope owenloop's config per process while leaving
 * `XDG_CONFIG_HOME` alone for everything else:
 *
 *     OWENLOOP_CONFIG_DIR=~/.config/owenloop-shifts/utility/owenloop \
 *       owenloop shift start utility …
 *
 * PRECEDENCE, highest first:
 *   1. `OWENLOOP_CONFIG_DIR`  → used verbatim
 *   2. `XDG_CONFIG_HOME`      → `<xdg>/owenloop`
 *   3. `HOME`                 → `<home>/.config/owenloop`
 * Blank or whitespace-only values are treated as unset at every rung, matching
 * the behaviour the four previous copies already had for `XDG_CONFIG_HOME`.
 *
 * ABSOLUTE PATHS ONLY. A relative `OWENLOOP_CONFIG_DIR` would resolve against
 * whatever the current working directory happens to be, and a worker's cwd
 * changes per step (`workdirFrom` points each step at its own worktree). That
 * is the same class of ambient-state bug this module exists to remove, so a
 * relative value is a hard error naming the variable rather than a path that
 * silently means something different in every step.
 *
 * Imports node builtins only. Both closures — the root CLI under `src/` and the
 * execution engine under `packages/work/src/` — import this module directly, so
 * the ladder cannot drift between them again.
 */

import { isAbsolute, join } from 'node:path';

/** Read an env var, treating blank and whitespace-only as unset. */
function present(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === '' ? undefined : value;
}

/**
 * Resolve owenloop's user-level config directory from caller-supplied env.
 *
 * Throws when no rung of the ladder yields a value, rather than guessing a home
 * directory from the ambient process.
 */
export function owenloopConfigDir(env: Record<string, string | undefined>): string {
  const explicit = present(env.OWENLOOP_CONFIG_DIR);
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) {
      throw new Error(
        `OWENLOOP_CONFIG_DIR must be an absolute path, received ${JSON.stringify(explicit)} — ` +
          'a relative config dir resolves against each step\'s own working directory',
      );
    }
    return explicit;
  }
  const xdg = present(env.XDG_CONFIG_HOME);
  if (xdg !== undefined) return join(xdg, 'owenloop');
  const home = present(env.HOME);
  if (home !== undefined) return join(home, '.config', 'owenloop');
  throw new Error('cannot locate a config directory: set OWENLOOP_CONFIG_DIR, XDG_CONFIG_HOME, or HOME');
}

/** A file inside owenloop's config directory. */
export function owenloopConfigFile(env: Record<string, string | undefined>, ...segments: string[]): string {
  return join(owenloopConfigDir(env), ...segments);
}
