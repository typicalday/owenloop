/**
 * PHASE 6, ITEMS 3 + 5 — the `OWENLOOP_*` namespace allowlist for harness
 * children. Vendor-neutral by construction: this module names no harness and no
 * vendor, only owenloop's own environment variables.
 *
 * ── WHAT THE FILTER DOES, EXACTLY ────────────────────────────────────────────
 *
 * It applies to variables whose name begins with `OWENLOOP_`, and to NOTHING
 * else. Within that namespace only the names in `ADMITTED_OWENLOOP_KEYS` are
 * passed to a harness child; every other `OWENLOOP_*` name is removed. Every
 * variable OUTSIDE the namespace — `PATH`, `HOME`, `TMPDIR`, `LANG`,
 * `SSL_CERT_FILE`, corporate proxy variables, `NODE_OPTIONS`, each vendor's own
 * credential and configuration variables — passes through untouched.
 *
 * ── WHY THE SCOPE IS THE NAMESPACE AND NOT THE WHOLE ENVIRONMENT ─────────────
 *
 * Two requirements pull in opposite directions on one mechanism:
 *
 *   ITEM 5 wants owenloop's dev-only hub bearer override to stop reaching
 *   harness children. A harness child is an ordinary process that inherits its
 *   parent's environment, and at least one harness demonstrably persists its
 *   start parameters to disk, so credential material in that environment has a
 *   real path to a file on the operator's machine.
 *
 *   ITEM 3 wants a harness's own OAuth credential variable to KEEP reaching its
 *   child, because under launchd the Keychain read can fail and that variable is
 *   the fallback credential path. A stranded credential is a harness that cannot
 *   start at all.
 *
 * A conventional allowlist — "the child gets only the names on this list" —
 * satisfies both only if the list is exhaustive over everything every vendor
 * binary needs in order to start. That set is unknowable, and it grows with each
 * vendor release. Scoping the allowlist to owenloop's OWN namespace makes the
 * two requirements independent rather than opposed:
 *
 *  - owenloop knows every name in the `OWENLOOP_*` namespace and every consumer
 *    of every name. That is exactly the knowledge a precise allowlist needs, and
 *    exactly the knowledge owenloop does not have about `PATH` or about a
 *    vendor's variables.
 *  - No vendor credential variable is in the namespace, so no vendor credential
 *    can be stranded — not by oversight, not by a later edit. Structurally.
 *  - It is still deny-by-default WITHIN the namespace, so an `OWENLOOP_*`
 *    variable added by some future phase does not silently start flowing to
 *    harness children. Adding one to this set is a deliberate, reviewable act.
 *
 * ── HOW THE ADMITTED SET WAS DERIVED, AND HOW TO RE-DERIVE IT ────────────────
 *
 * The only owenloop process a harness child spawns is the work-holder MCP mount
 * (`owenloop work hold --mcp`), whose argv is built by `src/agent/brief.ts`. Walking
 * the import graph from `src/roles/hold.ts` and collecting every reachable
 * `OWENLOOP_*` read yields these holder inputs:
 *
 *   - `OWENLOOP_SHIFT_ID` and `OWENLOOP_SESSION` from `src/roles/hold.ts`;
 *   - `OWENLOOP_CREDENTIAL_COMMAND`, `OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS`,
 *     and `OWENLOOP_NO_KEYCHAIN` from `src/hub.ts:readStoredCredential()`;
 *   - `OWENLOOP_TOKEN` from `src/credentials/resolve.ts`, which is DENIED on
 *     purpose — see below.
 *
 * The three credential controls are admitted because the mounted holder uses
 * them to select and configure its credential backend before the MCP server
 * starts. `src/hub.ts:runCredentialCommand()` creates
 * `OWENLOOP_CREDENTIAL_ORIGIN` and `OWENLOOP_CREDENTIAL_SLOT` internally, so
 * those two helper-only names are not inherited from the harness parent.
 *
 * `OWENLOOP_CACHE_DIR` is admitted although it is NOT reachable from `hold`: it
 * is read by `resolveCacheDir` (`src/bundle/cache.ts`), which an agent reaches
 * when its own work runs an owenloop subcommand that touches the bundle cache.
 * It is a directory path, not credential material, and admitting it keeps the
 * worker and anything the agent runs pointed at the same cache.
 *
 * ── THE ONE DENIAL WITH A DELIBERATE CONSEQUENCE ─────────────────────────────
 *
 * `OWENLOOP_TOKEN` is denied, and it IS reachable from `hold`. Left alone that
 * would split the two sides apart: the worker would authenticate to the hub with
 * the override while the child fell back to its credential slot, and an empty
 * slot would surface mid-order as a confusing MCP handshake failure. So
 * `src/roles/agent-run.ts` also ignores `OWENLOOP_TOKEN` when resolving its own
 * bearer. Worker and child then agree, and the failure moves to startup, where
 * `resolveBearer` already refuses with exit code 2 and an actionable message.
 */

/**
 * The `OWENLOOP_*` names a harness child may see. Everything else in the
 * namespace is removed; everything outside the namespace is untouched.
 *
 * Each entry needs a named consumer that a harness child can actually reach. An
 * entry with no such consumer is a leak with a comment on it.
 */
export const ADMITTED_OWENLOOP_KEYS: ReadonlySet<string> = new Set([
  // `resolveCacheDir` — src/bundle/cache.ts. Keeps anything the agent runs on
  // the same bundle cache as the worker. A path, not a secret.
  'OWENLOOP_CACHE_DIR',
  // The step agent and anything it runs. Resolves bundle-shipped assets from
  // the verified installed object directory. A path, not credential material.
  'OWENLOOP_BUNDLE_DIR',
  // The step agent and anything it runs. Identifies the workflow instance.
  'OWENLOOP_WORKFLOW',
  // The step agent and anything it runs. Identifies the current run.
  'OWENLOOP_RUN',
  // `holdShiftId` — src/roles/hold.ts. The fallback when `--shift=` is
  // absent from the mount's argv.
  'OWENLOOP_SHIFT_ID',
  // `readStoredCredential` — src/hub.ts. Selects the holder's external
  // credential backend rather than falling through to keychain/file defaults.
  'OWENLOOP_CREDENTIAL_COMMAND',
  // `readStoredCredential` — src/hub.ts. Bounds the external credential helper.
  'OWENLOOP_CREDENTIAL_COMMAND_TIMEOUT_MS',
  // `readStoredCredential` — src/hub.ts. Forces the 0600 file backend on macOS.
  'OWENLOOP_NO_KEYCHAIN',
  // `holdSession` — src/roles/hold.ts. The fallback when `--session` is absent.
  'OWENLOOP_SESSION',
  // `owenloopConfigDir` — src/config-dir.ts. Scopes owenloop's OWN config
  // directory (`settings.json`, `credentials.json`, `allowed_signers`) without
  // touching `XDG_CONFIG_HOME`, which the rest of the operator's toolchain also
  // reads. A path, not credential material — but the credential FILE backend
  // resolves under it (`readStoredCredential` → `configDir` → src/hub.ts), so a
  // mount that does not see this variable falls back to `XDG_CONFIG_HOME` and
  // reads a DIFFERENT credential store than the shift that spawned it.
  'OWENLOOP_CONFIG_DIR',
]);

/** The namespace this filter governs. Nothing outside it is ever touched. */
const NAMESPACE = 'OWENLOOP_';

/**
 * A copy of `source` with every non-admitted `OWENLOOP_*` key removed.
 *
 * `source` is a parameter rather than a read of `process.env` so callers and
 * tests can inject a fixture; the input is never mutated. Keys are `delete`d
 * rather than set to `undefined`, because an own key holding `undefined` is not
 * obviously equivalent to an absent key once it crosses a spawn or
 * serialization boundary.
 */
export function filterOwenloopEnv(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = { ...source };
  for (const key of Object.keys(result)) {
    if (key.startsWith(NAMESPACE) && !ADMITTED_OWENLOOP_KEYS.has(key)) delete result[key];
  }
  return result;
}

/** Whether one variable name may reach a harness child. */
export function isAdmittedChildEnvKey(key: string): boolean {
  return !key.startsWith(NAMESPACE) || ADMITTED_OWENLOOP_KEYS.has(key);
}
