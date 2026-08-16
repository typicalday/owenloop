/**
 * Hermeticity against the OPERATOR'S `OWENLOOP_*` environment.
 *
 * ## The problem this exists to close
 *
 * A fixture makes itself hermetic by pointing owenloop at a temp `HOME` /
 * `XDG_CONFIG_HOME` and then neutralizing the handful of `OWENLOOP_*` variables
 * it happens to know about. That is an ALLOWLIST OF THINGS TO REMOVE, and it is
 * wrong by construction: it is complete only for the variables that existed when
 * the fixture was written, and only for the ones its author thought of.
 *
 * Every miss is invisible in CI and fatal on a developer machine. CI runs on a
 * clean ubuntu-latest runner with the whole namespace unset, so a fixture that
 * forgets a variable is green there forever. An owenloop shift, by contrast,
 * exports a large slice of the namespace into every process it dispatches — so
 * the same suite is red for an agent-driven build and nobody can reproduce it
 * from CI.
 *
 * Three separate variables have already bitten in exactly this way:
 *
 *   - `OWENLOOP_CONFIG_DIR` outranks `XDG_CONFIG_HOME` in the config-dir ladder
 *     (`configDir`, src/hub.ts), so credential and settings lookups read the
 *     operator's REAL config dir instead of the fixture's temp one.
 *   - `OWENLOOP_HARNESS` outranks the step def's harness (`agent-run.ts`), so a
 *     dispatched worker runs an adapter the test never asked for.
 *   - `OWENLOOP_ALLOWED_WORKDIR_ROOTS` arrives through `buildSpawnPlan`'s
 *     `{...process.env}` spread, so a test asserting that the plan sets NO such
 *     variable sees the operator's value and fails.
 *
 * ## The rule, and why it is a denylist of the namespace instead
 *
 * Deny the whole `OWENLOOP_*` namespace, then let the fixture set back exactly
 * what it wants. A variable added by a future phase is then hermetic on the day
 * it is introduced rather than on the day someone debugs it. This is the same
 * discipline `src/harness/child-env.ts` already applies to harness children —
 * "deny-by-default WITHIN the namespace" — pointed at test fixtures instead.
 *
 * Nothing OUTSIDE the namespace is touched. `HOME`, `XDG_CONFIG_HOME`,
 * `PATH`, `NODE_*` and the rest are the fixture's business, not this module's.
 *
 * ## Ordering is load-bearing
 *
 * Strip FIRST, then apply the fixture's own values. Both helpers are written so
 * the natural spelling has that order: `{...strippedOwenloopEnv(), OWENLOOP_NO_KEYCHAIN: '1'}`
 * keeps the explicit value, and the reverse spelling would silently discard it.
 */

/** The namespace these helpers govern. Nothing outside it is ever touched. */
const NAMESPACE = 'OWENLOOP_';

/**
 * Every `OWENLOOP_*` key present in `source`, mapped to `undefined`.
 *
 * For CHILD-SPAWNING fixtures. `spawn`/`spawnSync` helpers in this suite build a
 * child environment as `{...process.env, ...fixtureEnv}`, so an ambient variable
 * survives unless the fixture explicitly overrides it. Node drops a key whose
 * value is `undefined` from the child environment entirely, so spreading this
 * object removes the namespace rather than passing empty strings through.
 *
 * Spread it FIRST in the literal, so the fixture's own `OWENLOOP_*` values (a
 * seeded `OWENLOOP_TOKEN`, `OWENLOOP_NO_KEYCHAIN: '1'`) are applied after it and
 * win.
 */
export function strippedOwenloopEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, undefined> {
  const stripped: Record<string, undefined> = {};
  for (const key of Object.keys(source)) {
    if (key.startsWith(NAMESPACE)) stripped[key] = undefined;
  }
  return stripped;
}

/**
 * Delete every `OWENLOOP_*` key from `process.env`, and return a function that
 * restores the namespace to its exact pre-strip state.
 *
 * For IN-PROCESS fixtures — suites that drive a role's `run()` directly in the
 * test process and set up their environment by mutating `process.env` in a
 * `beforeEach`. Call it FIRST in the `beforeEach`, then set the fixture's own
 * values; call the returned restore in the `afterEach`.
 *
 * The restore is a full round-trip on the namespace, in two steps and in this
 * order:
 *
 *   1. delete every `OWENLOOP_*` key present at restore time — which drops the
 *      values the FIXTURE set after the strip (its `OWENLOOP_NO_KEYCHAIN='1'`,
 *      a per-test `OWENLOOP_TOKEN`), so nothing the fixture wrote outlives the
 *      test that wrote it;
 *   2. put back every key the strip removed, with its original value.
 *
 * So a key that was absent before the strip is absent after the restore, a key
 * that held a value gets that exact value back (the empty string included — a
 * present-but-empty variable is a different input to owenloop's env readers than
 * an absent one), and a key that only the fixture ever set is gone.
 *
 * A suite whose `afterEach` already assigns a whole saved `process.env` snapshot
 * gets the same end state either way, so calling the restore there is harmless.
 */
export function stripAmbientOwenloopEnv(): () => void {
  const removed = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(NAMESPACE) || value === undefined) continue;
    removed.set(key, value);
    delete process.env[key];
  }
  return () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(NAMESPACE)) delete process.env[key];
    }
    for (const [key, value] of removed) process.env[key] = value;
  };
}
