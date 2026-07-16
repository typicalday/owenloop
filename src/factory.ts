/**
 * `createEngine` — the one-call convenience factory for embedding owenloop in a
 * host process.
 *
 * The `Engine` class is the real public API; this just bundles the wiring an
 * embedder would otherwise hand-roll: open the SQLite store, resolve workflow
 * definitions (from a directory or an in-memory set), and hand the engine a
 * resolver. It mirrors what the CLI does in `src/cli.ts` (`openCtx`), so an
 * in-process host and the `owenloop` binary drive the *same* engine the same way
 * — one returns typed objects, the other prints them as JSON.
 *
 * Lifecycle: the returned `engine`/`store` are meant to be long-lived (one per
 * database). Call `store.close()` on shutdown. Concurrency is the store's:
 * node:sqlite (DatabaseSync) is synchronous and single-writer-per-process; cross-process
 * advancement is made safe by the commit-fingerprint CAS (see `src/store.ts`).
 *
 * A host that wants to react to engine changes without polling can pass
 * `onEvent` (and optionally `onListenerError`) here — the same registration as
 * `engine.subscribe`, wired at construction. See `docs/embedding.md`.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Engine } from './engine.ts';
import type { DefResolver, EngineEvent, EngineListener } from './engine.ts';
import { openStore } from './store.ts';
import type { Store } from './store.ts';
import { finalizeDefs, loadDefs } from './defs.ts';
import type { WorkflowDef } from './types.ts';

export interface CreateEngineOpts {
  /**
   * SQLite database path. Use `':memory:'` for an ephemeral instance (handy in
   * tests). Defaults to `.owenloop/state.db` (matching the CLI). Parent
   * directories are created for a file path.
   */
  db?: string;
  /**
   * Workflow definitions to register in-memory, as a `name → def` map or an
   * array of defs (de-duplicated by name, last wins). Takes precedence over
   * `defsDir` when both are given.
   */
  defs?: Map<string, WorkflowDef> | WorkflowDef[];
  /**
   * Directory of `*.yaml` workflow definitions to load via `loadDefs`. Used
   * when `defs` is not supplied. A non-existent directory yields no defs (the
   * same lenient behavior as the CLI), not an error.
   */
  defsDir?: string;
  /** Forwarded to the `Engine` — the stranded-lease reap TTL in milliseconds. */
  reapTtlMs?: number;
  /** Forwarded to the `Engine` — the default max total lease lifetime in
   *  milliseconds (A3). Per-step `maxLease` overrides it. */
  maxLeaseMs?: number;
  /**
   * Forwarded to the `Engine` — the hard cap on `calls:` composition depth
   * (REL-4 defense in depth). Construction-time validation already rejects
   * `calls:` cycles in the resolved def set, so this only matters for a host
   * that wires an `Engine` with a custom `DefResolver` construction validation
   * cannot inspect. Defaults to the engine's `DEFAULT_MAX_CALL_DEPTH` (64).
   */
  maxCallDepth?: number;
  /**
   * A push-style observer registered up front, equivalent to calling
   * `engine.subscribe` immediately after construction. Fires synchronously
   * after each committed mutation. See {@link Engine.subscribe}.
   */
  onEvent?: EngineListener;
  /** Where a throwing `onEvent`/subscriber's error goes (default: swallowed). */
  onListenerError?: (err: unknown, event: EngineEvent) => void;
}

export interface CreatedEngine {
  engine: Engine;
  store: Store;
  /** The resolved definition set, so a host can introspect what was registered. */
  defs: Map<string, WorkflowDef>;
}

/**
 * Open a store, resolve definitions, and return a wired `Engine` ready to
 * `createInstance` / `tick` / `green` / … . See `docs/embedding.md`.
 *
 * REL-4: an in-memory `defs` set is now validated as a whole (calls targets
 * exist, `callsInputs` keys valid, exactly-one child output, per-def validation,
 * and calls-cycle detection) exactly like the filesystem `defsDir` loader — so
 * `createEngine({ defs })` THROWS `DefError` on an invalid set instead of
 * silently registering it. The returned `defs` is the validated copy the
 * resolver closes over.
 */
export function createEngine(opts: CreateEngineOpts = {}): CreatedEngine {
  const db = opts.db ?? join('.owenloop', 'state.db');

  // Resolve (and validate) the def set BEFORE opening the store: a validation
  // throw here must not leak an open SQLite handle (the `defsDir` branch also
  // validated inside `loadDefs`, but used to do so after `openStore` — that
  // reorder is safe, its only observable effect is the leak we're closing).
  let defs: Map<string, WorkflowDef>;
  if (opts.defs !== undefined) {
    // REL-4: validate the ENTIRE in-memory set exactly like the filesystem
    // loader — calls targets exist, callsInputs keys valid, exactly-one-output,
    // per-def validateDef, and cross-def calls-cycle detection. Reuses the
    // loader's own Phase-2/3 validator (`finalizeDefs`); no second validator.
    // The resolver below closes over this FINALIZED copy, so mutating the
    // caller's original Map/array after construction no longer silently changes
    // resolution — that hole was part of REL-4's surface.
    const raw = Array.isArray(opts.defs) ? new Map(opts.defs.map((d) => [d.name, d])) : opts.defs;
    defs = finalizeDefs(raw);
  } else if (opts.defsDir !== undefined) {
    defs = existsSync(opts.defsDir) ? loadDefs(opts.defsDir) : new Map<string, WorkflowDef>();
  } else {
    defs = new Map<string, WorkflowDef>();
  }

  if (db !== ':memory:') mkdirSync(dirname(db), { recursive: true });
  const store = openStore(db);

  const resolveDef: DefResolver = (name) => {
    const d = defs.get(name);
    if (!d) throw new Error(`unknown workflow definition '${name}'`);
    return d;
  };

  const engineOpts: {
    reapTtlMs?: number;
    maxLeaseMs?: number;
    maxCallDepth?: number;
    onEvent?: EngineListener;
    onListenerError?: (err: unknown, event: EngineEvent) => void;
  } = {};
  if (opts.reapTtlMs !== undefined) engineOpts.reapTtlMs = opts.reapTtlMs;
  if (opts.maxLeaseMs !== undefined) engineOpts.maxLeaseMs = opts.maxLeaseMs;
  if (opts.maxCallDepth !== undefined) engineOpts.maxCallDepth = opts.maxCallDepth;
  if (opts.onEvent !== undefined) engineOpts.onEvent = opts.onEvent;
  if (opts.onListenerError !== undefined) engineOpts.onListenerError = opts.onListenerError;

  const engine = new Engine(store, resolveDef, engineOpts);
  return { engine, store, defs };
}
