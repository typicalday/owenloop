/**
 * `createEngine` — the one-call convenience factory for embedding oweflow in a
 * host process.
 *
 * The `Engine` class is the real public API; this just bundles the wiring an
 * embedder would otherwise hand-roll: open the SQLite store, resolve workflow
 * definitions (from a directory or an in-memory set), and hand the engine a
 * resolver. It mirrors what the CLI does in `src/cli.ts` (`openCtx`), so an
 * in-process host and the `oweflow` binary drive the *same* engine the same way
 * — one returns typed objects, the other prints them as JSON.
 *
 * Lifecycle: the returned `engine`/`store` are meant to be long-lived (one per
 * database). Call `store.close()` on shutdown. Concurrency is the store's:
 * better-sqlite3 is synchronous and single-writer-per-process; cross-process
 * advancement is made safe by the commit-fingerprint CAS (see `src/store.ts`).
 *
 * This is evaluation option **A** (a blessed, documented in-process API with no
 * packaging change). Publishing a built package (B) and push/event hooks (C)
 * are deliberately out of scope here.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Engine } from './engine.ts';
import type { DefResolver } from './engine.ts';
import { openStore } from './store.ts';
import type { Store } from './store.ts';
import { loadDefs } from './defs.ts';
import type { WorkflowDef } from './types.ts';

export interface CreateEngineOpts {
  /**
   * SQLite database path. Use `':memory:'` for an ephemeral instance (handy in
   * tests). Defaults to `.oweflow/state.db` (matching the CLI). Parent
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
 */
export function createEngine(opts: CreateEngineOpts = {}): CreatedEngine {
  const db = opts.db ?? join('.oweflow', 'state.db');
  if (db !== ':memory:') mkdirSync(dirname(db), { recursive: true });
  const store = openStore(db);

  let defs: Map<string, WorkflowDef>;
  if (opts.defs !== undefined) {
    defs = Array.isArray(opts.defs) ? new Map(opts.defs.map((d) => [d.name, d])) : opts.defs;
  } else if (opts.defsDir !== undefined) {
    defs = existsSync(opts.defsDir) ? loadDefs(opts.defsDir) : new Map<string, WorkflowDef>();
  } else {
    defs = new Map<string, WorkflowDef>();
  }

  const resolveDef: DefResolver = (name) => {
    const d = defs.get(name);
    if (!d) throw new Error(`unknown workflow definition '${name}'`);
    return d;
  };

  const engine = new Engine(
    store,
    resolveDef,
    opts.reapTtlMs !== undefined ? { reapTtlMs: opts.reapTtlMs } : {},
  );
  return { engine, store, defs };
}
