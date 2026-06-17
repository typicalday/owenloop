/**
 * The oweflow CLI — a thin, scriptable surface over the engine.
 *
 * Every data command prints JSON to stdout, so a *wiring* (the worker/automation
 * that actually runs orders) can drive the engine programmatically: `tick` to
 * pull orders, run them, then `green` / `emit` / `seal` / `reject` / `close` to
 * report outcomes. The engine itself is domain-neutral; this binary just maps
 * argv to engine calls.
 *
 *   oweflow defs                       list available workflow definitions
 *   oweflow create <def> [--provide n=json] [--title t]   start an instance
 *   oweflow provide <wf> <name> [--value json]   supply an owed input
 *   oweflow tick <wf> [--now ms]       pull eligible orders
 *   oweflow status <wf>                derive debts / eligible / blocked
 *   oweflow status --all               every instance's status in one call (fleet read)
 *   oweflow show <wf>                  dump raw artifacts (debugging)
 *   oweflow list                       list instances
 *   oweflow green <wf> <run> <path> [--value json] [--terminal]
 *   oweflow emit  <wf> <run> --items '[{...},{...}]'
 *   oweflow seal  <wf> <run> [--value json]
 *   oweflow reject  <wf> <path> --by <author> --text <msg>
 *   oweflow retract <wf> <path> --by <author> --text <msg>
 *   oweflow skip    <wf> <path> --by <author> --text <msg>
 *   oweflow retry   <wf> <path> [--by <author>] [--text <guidance>]   clear a stall
 *   oweflow close <wf> <run> [--outcome ok|no_work|failed|skipped] [--summary s]
 *   oweflow delete <wf>
 *
 * Global: --db <path> (env OWEFLOW_DB), --defs <dir> (env OWEFLOW_DEFS).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Engine } from './engine.ts';
import { openStore } from './store.ts';
import type { Store, WorkflowRow } from './store.ts';
import { DefError, lintDef, loadDefs, loadDefsRaw } from './defs.ts';
import type { WorkflowDef } from './types.ts';

export interface CliIO {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
}

function defaultIO(): CliIO {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  };
}

// ---- arg parsing -------------------------------------------------------------

interface Args {
  positionals: string[];
  options: Map<string, string[]>;
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let val: string;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (i + 1 < argv.length && !(argv[i + 1] as string).startsWith('--')) {
        val = argv[++i] as string;
      } else {
        val = 'true'; // boolean flag
      }
      const arr = options.get(key) ?? [];
      arr.push(val);
      options.set(key, arr);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, options };
}

const last = (args: Args, key: string): string | undefined => {
  const arr = args.options.get(key);
  return arr ? arr[arr.length - 1] : undefined;
};
const all = (args: Args, key: string): string[] => args.options.get(key) ?? [];
const flag = (args: Args, key: string): boolean => {
  const v = last(args, key);
  return v === 'true' || v === '' || (v !== undefined && v !== 'false');
};

class CliError extends Error {}

function need(args: Args, idx: number, label: string): string {
  const v = args.positionals[idx];
  if (v === undefined) throw new CliError(`missing required argument: ${label}`);
  return v;
}

function needOpt(args: Args, key: string): string {
  const v = last(args, key);
  if (v === undefined) throw new CliError(`missing required option: --${key}`);
  return v;
}

function parseJson(s: string | undefined, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (s === undefined) return fallback;
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    throw new CliError(`invalid JSON: ${s}`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new CliError(`expected a JSON object, got: ${s}`);
  }
  return v as Record<string, unknown>;
}

/** Parse repeated `name=jsonvalue` pairs (for --provide / --param). */
function parsePairs(entries: string[], jsonValue: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const e of entries) {
    const eq = e.indexOf('=');
    if (eq < 0) throw new CliError(`expected name=value, got: ${e}`);
    const name = e.slice(0, eq);
    const raw = e.slice(eq + 1);
    if (jsonValue) {
      try {
        out[name] = JSON.parse(raw);
      } catch {
        throw new CliError(`invalid JSON for '${name}': ${raw}`);
      }
    } else {
      out[name] = raw;
    }
  }
  return out;
}

// ---- engine wiring -----------------------------------------------------------

interface Ctx {
  store: Store;
  engine: Engine;
  defs: Map<string, WorkflowDef>;
  defsDir: string;
  dbPath: string;
}

function openCtx(io: CliIO, args: Args): Ctx {
  const dbPath = last(args, 'db') ?? io.env.OWEFLOW_DB ?? join(io.cwd, '.oweflow', 'state.db');
  const defsDir = last(args, 'defs') ?? io.env.OWEFLOW_DEFS ?? join(io.cwd, 'workflows');
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = openStore(dbPath);
  const defs = existsSync(defsDir) ? loadDefs(defsDir) : new Map<string, WorkflowDef>();
  const engine = new Engine(store, (name) => {
    const d = defs.get(name);
    if (!d) throw new CliError(`unknown workflow definition '${name}' (looked in ${defsDir})`);
    return d;
  });
  return { store, engine, defs, defsDir, dbPath };
}

function print(io: CliIO, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

// ---- commands ----------------------------------------------------------------

const USAGE = `oweflow — a dataflow workflow engine

Usage: oweflow <command> [args] [--db <path>] [--defs <dir>]

Commands:
  defs                                   list available workflow definitions
  lint [<def-name>]                      check def(s) for wiring problems
  create <def> [--title t] [--provide name=json ...] [--param k=v ...]
  provide <wf> <name> [--value json]     supply an owed (seedOwed) input
  tick <wf> [--now <ms>]                 pull eligible orders
  status <wf>                            derive debts / eligible / blocked
  status --all                           every instance's status in one call (fleet read)
  show <wf>                              dump raw artifacts
  list                                   list workflow instances
  green <wf> <run> <path> [--value json] [--terminal]
  emit <wf> <run> --items '[{...}]'      accrete collection elements
  seal <wf> <run> [--value json]         signal a collection is complete
  reject <wf> <path> --by <author> --text <msg>
  retract <wf> <path> --by <author> --text <msg>
  skip <wf> <path> --by <author> --text <msg>
  retry <wf> <path> [--by <author>] [--text <guidance>]   clear a §6 stall
  close <wf> <run> [--outcome ok|no_work|failed|skipped] [--summary s]
  delete <wf>

Environment: OWEFLOW_DB, OWEFLOW_DEFS`;

function dispatch(command: string, io: CliIO, args: Args): void {
  // help and lint need no store
  if (command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE);
    return;
  }

  if (command === 'lint') {
    const defsDir = last(args, 'defs') ?? io.env.OWEFLOW_DEFS ?? join(io.cwd, 'workflows');
    const defs = existsSync(defsDir) ? loadDefsRaw(defsDir) : new Map<string, WorkflowDef>();
    const defName = args.positionals[1];
    let hasErrors = false;

    if (defName !== undefined) {
      const def = defs.get(defName);
      if (!def) throw new CliError(`unknown workflow definition '${defName}' (looked in ${defsDir})`);
      const result = lintDef(def);
      if (result.errors.length) hasErrors = true;
      print(io, { def: def.name, errors: result.errors, warnings: result.warnings });
    } else {
      const results = [...defs.values()].map((def) => {
        const result = lintDef(def);
        if (result.errors.length) hasErrors = true;
        return { def: def.name, errors: result.errors, warnings: result.warnings };
      });
      print(io, results);
    }

    if (hasErrors) throw new CliError('one or more definitions have errors (see above)');
    return;
  }

  const ctx = openCtx(io, args);
  const { engine, store } = ctx;
  try {
    switch (command) {
      case 'defs': {
        print(io, [...ctx.defs.values()].map((d) => ({
          name: d.name,
          title: d.title ?? null,
          inputs: d.inputs.map((i) => i.name),
          loops: d.loops.map((l) => l.name),
        })));
        return;
      }
      case 'create': {
        const defName = need(args, 1, 'def');
        const opts: Parameters<Engine['createInstance']>[1] = {};
        const title = last(args, 'title');
        if (title !== undefined) opts.title = title;
        const provide = parsePairs(all(args, 'provide'), true);
        if (Object.keys(provide).length) {
          opts.provide = provide as Record<string, Record<string, unknown>>;
        }
        const params = parsePairs(all(args, 'param'), false);
        if (Object.keys(params).length) opts.params = params as Record<string, string>;
        const id = engine.createInstance(defName, opts);
        print(io, { workflow: id });
        return;
      }
      case 'provide': {
        const wf = need(args, 1, 'workflow');
        const name = need(args, 2, 'name');
        engine.provideInput(wf, name, parseJson(last(args, 'value')));
        print(io, { ok: true, provided: name });
        return;
      }
      case 'tick': {
        const wf = need(args, 1, 'workflow');
        const nowRaw = last(args, 'now');
        const tickOpts = nowRaw !== undefined ? { now: Number(nowRaw) } : {};
        print(io, engine.tick(wf, tickOpts));
        return;
      }
      case 'status': {
        // `--all` is the fleet read: one call returns every instance's full
        // status plus its identity and `task` join key, so a supervisor (dev)
        // sees the whole project in a single invocation instead of N ticks. A
        // single instance whose def is unresolvable degrades to an `error`
        // field rather than aborting the sweep.
        if (flag(args, 'all')) {
          // `--all` is the whole-fleet read; a workflow argument is
          // contradictory (one or all?). Reject it in both orderings rather
          // than silently ignoring the caller's intent:
          //   `status wf --all`  → the wf lands in positionals[1]
          //   `status --all wf`  → the parser binds wf as `--all`'s value
          const v = last(args, 'all');
          const stray = args.positionals[1] ?? (v !== 'true' && v !== '' ? v : undefined);
          if (stray !== undefined) {
            throw new CliError(`status --all takes no workflow argument (got "${stray}")`);
          }
          print(io, store.listWorkflows().map((w) => statusEntry(engine, w)));
          return;
        }
        print(io, engine.status(need(args, 1, 'workflow')));
        return;
      }
      case 'show': {
        const wf = need(args, 1, 'workflow');
        print(io, store.listArtifacts(wf));
        return;
      }
      case 'list': {
        print(io, store.listWorkflows().map((w) => {
          const s = safeStatus(engine, w.id);
          return { id: w.id, def: w.def, title: w.title ?? null, createdAt: w.createdAt, done: s };
        }));
        return;
      }
      case 'green': {
        const wf = need(args, 1, 'workflow');
        const run = need(args, 2, 'run');
        const path = need(args, 3, 'path');
        const value = parseJson(last(args, 'value'));
        const res = engine.green(wf, run, path, value, { terminal: flag(args, 'terminal') });
        print(io, res);
        return;
      }
      case 'emit': {
        const wf = need(args, 1, 'workflow');
        const run = need(args, 2, 'run');
        const itemsRaw = needOpt(args, 'items');
        let parsed: unknown;
        try {
          parsed = JSON.parse(itemsRaw);
        } catch {
          throw new CliError(`--items must be a JSON array: ${itemsRaw}`);
        }
        if (!Array.isArray(parsed)) throw new CliError('--items must be a JSON array');
        const items = parsed.map((v) => ({ value: v as Record<string, unknown> }));
        print(io, engine.emit(wf, run, items));
        return;
      }
      case 'seal': {
        const wf = need(args, 1, 'workflow');
        const run = need(args, 2, 'run');
        print(io, engine.seal(wf, run, parseJson(last(args, 'value'))));
        return;
      }
      case 'reject':
      case 'retract':
      case 'skip': {
        const wf = need(args, 1, 'workflow');
        const path = need(args, 2, 'path');
        const by = needOpt(args, 'by');
        const text = needOpt(args, 'text');
        engine[command](wf, path, by, text);
        print(io, { ok: true, action: command, path });
        return;
      }
      case 'retry': {
        // text/by are optional: a retry can be a bare stall-clear or carry guidance
        const wf = need(args, 1, 'workflow');
        const path = need(args, 2, 'path');
        engine.retry(wf, path, last(args, 'by') ?? 'human', last(args, 'text') ?? 'retry: stall cleared');
        print(io, { ok: true, action: 'retry', path });
        return;
      }
      case 'close': {
        const wf = need(args, 1, 'workflow');
        const run = need(args, 2, 'run');
        const outcome = (last(args, 'outcome') ?? 'ok') as 'ok' | 'no_work' | 'failed' | 'skipped';
        engine.close(wf, run, outcome, last(args, 'summary'));
        print(io, { ok: true, run, outcome });
        return;
      }
      case 'delete': {
        const wf = need(args, 1, 'workflow');
        store.deleteWorkflow(wf);
        print(io, { ok: true, deleted: wf });
        return;
      }
      default:
        throw new CliError(`unknown command: ${command}\n\n${USAGE}`);
    }
  } finally {
    store.close();
  }
}

function safeStatus(engine: Engine, wf: string): boolean | null {
  try {
    return engine.status(wf).done;
  } catch {
    return null;
  }
}

/** One row of the `status --all` fleet read: instance identity + join key,
 *  merged with its derived status (or an `error` if the def can't resolve). */
function statusEntry(engine: Engine, w: WorkflowRow): Record<string, unknown> {
  const base = {
    workflow: w.id,
    def: w.def,
    title: w.title ?? null,
    task: w.params?.task ?? null,
    createdAt: w.createdAt,
  };
  try {
    return { ...base, ...engine.status(w.id) };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

/** Run the CLI. Returns a process exit code. */
export function main(argv: string[], io: CliIO = defaultIO()): number {
  const args = parseArgs(argv);
  const command = args.positionals[0];
  if (command === undefined) {
    io.out(USAGE);
    return 0;
  }
  try {
    dispatch(command, io, args);
    return 0;
  } catch (e) {
    if (e instanceof CliError || e instanceof DefError) {
      io.err(`error: ${e.message}`);
    } else {
      io.err(`error: ${(e as Error).message}`);
    }
    return 1;
  }
}
