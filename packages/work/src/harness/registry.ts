/**
 * Harness registry — a RUNTIME map from adapter id to `HarnessAdapter`.
 *
 * It is a RUNTIME registry because adapters self-register at import time and the
 * fake is registered/unregistered inside individual tests.
 *
 * STARTS EMPTY, ON PURPOSE. Importing an adapter module from here would be the
 * only way a harness vendor name could enter this file — which the isolation
 * rule forbids. WHO imports the real adapter modules so their `register(...)`
 * side effect fires is a COMPOSITION ROOT's job, not this module's. There are
 * two: `src/roles/agent-run.ts` and `src/roles/lint.ts`. Do not add a
 * barrel/index under `src/harness/` to do it: importers name the module.
 *
 * Failure stance: `register` THROWS on a duplicate id, because a duplicate is a
 * wiring bug at composition time, not a runtime condition a caller can recover
 * from. Every read is total (`undefined` / `[]`), never throws.
 */
import type { HarnessAdapter } from './contract.ts';

/** Module-level, process-wide. One registry per process is the intent. */
const ADAPTERS = new Map<string, HarnessAdapter>();

/**
 * Register an adapter under its own `id`. Throws when that id is already taken
 * — two adapters claiming one id is a wiring bug, and silently letting the
 * second win would route work to whichever module happened to import last.
 */
export function register(adapter: HarnessAdapter): void {
  const existing = ADAPTERS.get(adapter.id);
  if (existing !== undefined) {
    throw new Error(`harness adapter '${adapter.id}' is already registered`);
  }
  ADAPTERS.set(adapter.id, adapter);
}

/**
 * Remove an adapter by id; returns whether one was there. Exists so a test that
 * registers a fake can clean up in `afterEach` — production code has no reason
 * to unregister.
 */
export function unregister(id: string): boolean {
  return ADAPTERS.delete(id);
}

/** The adapter registered under `id`, or `undefined` when none is. */
export function adapterFor(id: string): HarnessAdapter | undefined {
  return ADAPTERS.get(id);
}

/** Every registered adapter id, in registration order. */
export function registeredHarnessIds(): string[] {
  return [...ADAPTERS.keys()];
}

/**
 * The built-in default harness id: the FIRST id in the registry, i.e. the first
 * adapter module a composition root imported.
 *
 * Deliberately not a hardcoded literal. A literal default would be a harness
 * VENDOR NAME in neutral code, which the isolation rule forbids outright — and
 * this file is under `src/harness/`, where the rule is enforced by grep. The
 * import-order rule gives the same behavior without the string.
 *
 * Returns `undefined` when nothing is registered; the caller then fails honestly
 * (`'no-harness'`) rather than guessing.
 */
export function defaultHarnessId(): string | undefined {
  return registeredHarnessIds()[0];
}
