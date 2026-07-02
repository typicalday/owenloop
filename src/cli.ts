/**
 * The owenloop CLI — a thin, scriptable surface over the engine.
 *
 * Every data command prints JSON to stdout, so a *wiring* (the worker/automation
 * that actually runs orders) can drive the engine programmatically: `tick` to
 * pull orders, run them, then `green` / `emit` / `seal` / `reject` / `close` to
 * report outcomes. The engine itself is domain-neutral; this binary just maps
 * argv to engine calls.
 *
 *   owenloop defs                       list available workflow definitions
 *   owenloop create <def> [--provide n=json] [--title t]   start an instance
 *   owenloop provide <wf> <name> [--value json]   supply an owed input
 *   owenloop tick <wf> [--now ms]       pull eligible orders
 *   owenloop reap <wf> [--now]          run the reaper; --now forces every claim stale (TTL 0)
 *   owenloop runs <wf> [--open]         list this instance's runs (+ claim state for open ones)
 *   owenloop status <wf>                derive debts / eligible / blocked
 *   owenloop status --all               every instance's status in one call (fleet read)
 *   owenloop wait <wf> --until eligible|done [--timeout <dur>]   block until engine state matches
 *   owenloop show <wf>                  dump raw artifacts (debugging)
 *   owenloop list                       list instances
 *   owenloop green <wf> <run> <path> [--value json] [--terminal]
 *   owenloop emit  <wf> <run> --items '[{...},{...}]'
 *   owenloop seal  <wf> <run> [--value json]
 *   owenloop reject  <wf> <path> --by <author> --text <msg>
 *   owenloop retract <wf> <path> --by <author> --text <msg>
 *   owenloop skip    <wf> <path> --by <author> --text <msg>
 *   owenloop retry   <wf> <path> [--by <author>] [--text <guidance>]   clear a stall
 *   owenloop close <wf> <run> [--outcome ok|no_work|failed|skipped] [--summary s]
 *   owenloop delete <wf> [--recursive]
 *
 * Global: --db <path> (env OWENLOOP_DB), --defs <dir> (env OWENLOOP_DEFS).
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Engine } from './engine.ts';
import { buildGraph, buildTrace, graphToDot, graphToMermaid, modelCheck } from './model.ts';
import { openStore } from './store.ts';
import type { ArtifactRow, Store, WorkflowRow } from './store.ts';
import { DefError, lintDef, loadDefs, loadDefsRaw, validateDef } from './defs.ts';
import type { WorkflowDef } from './types.ts';
import { detId, nowMs, parseDurationMs } from './util.ts';

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
  const dbPath = last(args, 'db') ?? io.env.OWENLOOP_DB ?? join(io.cwd, '.owenloop', 'state.db');
  const defsDir = last(args, 'defs') ?? io.env.OWENLOOP_DEFS ?? join(io.cwd, 'workflows');
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

/**
 * Synchronous blocking sleep. The whole codebase is sync end to end (no
 * async/Promise/setTimeout anywhere in src/*.ts), so `wait` needs a sync
 * sleep rather than turning `main`/`dispatch` async. `Atomics.wait` on a
 * value that never changes (compare 0 against 0) blocks for the full `ms`
 * every time — exactly the "just sleep" behavior wanted here.
 */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---- commands ----------------------------------------------------------------

const USAGE = `owenloop — a dataflow workflow engine

Usage: owenloop <command> [args] [--db <path>] [--defs <dir>]

Commands:
  defs                                   list available workflow definitions
  lint [<def-name>]                      check def(s) for wiring problems
  check <def> [--format text|json] [--max-depth N] [--max-states N] [--max-collection N]
                                         bounded reachability check (deadlocks, stuck, dead steps, declared invariants)
  create <def> [--title t] [--provide name=json ...] [--param k=v ...]
  provide <wf> <name> [--value json]     supply an owed (seedOwed) input
  adopt <wf>                             re-pin an instance to the current def (§28); settles new debts
  tick <wf> [--now <ms>]                 pull eligible orders
  reap <wf> [--now]                      run the reaper; --now forces every claim stale (TTL 0)
  runs <wf> [--open]                     list this instance's runs (+ claim state for open ones)
  status <wf>                            derive debts / eligible / blocked
  status --all                           every instance's status in one call (fleet read)
  wait <wf> --until eligible|done [--timeout <dur>]   block until engine state matches
  show <wf>                              dump raw artifacts
  trace <wf> [--format text]             causal timeline + artifact biographies
  graph <def-or-wf> [--format dot|mermaid|json]   wiring graph (+ live overlay if wf id)
  list                                   list workflow instances
  green <wf> <run> <path> [--value json] [--terminal]
  emit <wf> <run> --items '[{...}]'      accrete collection elements
  seal <wf> <run> [--value json]         signal a collection is complete
  reject <wf> <path> --by <author> --text <msg>
  retract <wf> <path> --by <author> --text <msg>
  skip <wf> <path> --by <author> --text <msg>
  retry <wf> <path> [--by <author>] [--text <guidance>]   clear a §6 stall
  heartbeat <wf> <run> [--now <ms>]    touch liveness timestamp on an open run
  close <wf> <run> [--outcome ok|no_work|failed|skipped] [--summary s]
  delete <wf> [--recursive]              refuse if children exist unless --recursive (cascades)

Environment: OWENLOOP_DB, OWENLOOP_DEFS`;

function dispatch(command: string, io: CliIO, args: Args): number {
  // help and lint need no store
  if (command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE);
    return 0;
  }

  if (command === 'lint') {
    const defsDir = last(args, 'defs') ?? io.env.OWENLOOP_DEFS ?? join(io.cwd, 'workflows');
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
    return 0;
  }

  if (command === 'check') {
    const defsDir = last(args, 'defs') ?? io.env.OWENLOOP_DEFS ?? join(io.cwd, 'workflows');
    const defs = existsSync(defsDir) ? loadDefsRaw(defsDir) : new Map<string, WorkflowDef>();
    const defName = need(args, 1, 'def');
    const def = defs.get(defName);
    if (!def) {
      throw new CliError(
        `unknown workflow definition '${defName}' (looked in ${defsDir}).\n` +
        `Known definitions: ${[...defs.keys()].sort().join(', ') || '(none)'}`,
      );
    }

    // loadDefsRaw uses buildDef (no semantic validation); run validateDef here so
    // invariant stem-reference / duplicate-name errors surface to the author.
    const defErrors = validateDef(def);
    if (defErrors.length > 0) {
      throw new CliError(`workflow '${def.name}' has validation errors:\n  - ${defErrors.join('\n  - ')}`);
    }

    const format = last(args, 'format') ?? 'text';
    const maxDepth = last(args, 'max-depth') !== undefined ? Number(last(args, 'max-depth')) : undefined;
    const maxStates = last(args, 'max-states') !== undefined ? Number(last(args, 'max-states')) : undefined;
    const maxCollection = last(args, 'max-collection') !== undefined ? Number(last(args, 'max-collection')) : undefined;

    const report = modelCheck(def, {
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(maxStates !== undefined ? { maxStates } : {}),
      ...(maxCollection !== undefined ? { maxCollectionSize: maxCollection } : {}),
    });

    if (format === 'json') {
      print(io, report);
    } else {
      // text format
      const clean = report.deadlocks.length === 0 && report.stuck.length === 0
        && report.invariantViolations.length === 0;
      const status = clean && report.completable ? 'OK' : clean ? 'INCOMPLETE' : 'DEFECTS FOUND';
      io.out(`=== owenloop check: ${def.name} ===`);
      io.out(`Status: ${status}`);
      io.out(`Completable: ${report.completable ? 'yes' : 'no'}`);
      io.out(`States explored: ${report.stats.statesExplored}, max depth: ${report.stats.depthReached}`);
      if (report.bounded) {
        io.out('');
        io.out(`SEARCH INCOMPLETE — bounds hit: ${report.boundsHit.join(', ')}`);
        io.out('Verdicts apply only within the explored region.');
      }
      if (report.deadlocks.length > 0) {
        io.out('');
        io.out(`Deadlocks (${report.deadlocks.length}):`);
        for (const d of report.deadlocks) {
          io.out(`  path: ${d.path.map((s) => `${s.step}/${s.outcome}`).join(' -> ') || '(initial state)'}`);
        }
      }
      if (report.stuck.length > 0) {
        io.out('');
        io.out(`Stuck states (${report.stuck.length}):`);
        for (const s of report.stuck) {
          io.out(`  path: ${s.path.map((p) => `${p.step}/${p.outcome}`).join(' -> ') || '(initial state)'}`);
        }
      }
      if (report.invariantViolations.length > 0) {
        io.out('');
        io.out(`Invariant violations (${report.invariantViolations.length}):`);
        for (const v of report.invariantViolations) {
          io.out(`  invariant: ${v.invariant}`);
          io.out(`  path: ${v.path.map((s) => `${s.step}/${s.outcome}`).join(' -> ') || '(initial state)'}`);
        }
      }
      if (report.deadSteps.length > 0) {
        io.out('');
        io.out(`Dead steps (never fire in explored space): ${report.deadSteps.join(', ')}`);
      }
      if (report.completePath) {
        io.out('');
        io.out(`Example completion path:`);
        io.out(`  ${report.completePath.map((s) => `${s.step}/${s.outcome}`).join(' -> ') || '(already done)'}`);
      }
    }

    // Exit codes:
    // - invariant violations → ALWAYS nonzero, regardless of bounded. A reported
    //   counterexample path was produced by real applyOutcome/settleInMemory
    //   transitions (pinned to the live Engine by the conformance test). The path
    //   is a genuine executable witness; bounds only cause MISSES, never
    //   fabrications. Contrast deadlocks/stuck, where the maxCollectionSize cap can
    //   manufacture a spurious "no moves" state — hence those require !bounded.
    //   Do NOT remove this asymmetry; it encodes a real soundness distinction.
    // - definite deadlock/stuck only when EXHAUSTIVE (!bounded) → nonzero
    // - truncated with no invariant violations → 0
    const hasDefiniteDefect =
      report.invariantViolations.length > 0 ||
      (!report.bounded && (report.deadlocks.length > 0 || report.stuck.length > 0));
    if (hasDefiniteDefect) {
      throw new CliError(
        `definite defects found (${report.invariantViolations.length} invariant violation(s), ` +
        `${report.deadlocks.length} deadlock(s), ${report.stuck.length} stuck state(s))`,
      );
    }
    return 0;
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
          steps: d.steps.map((l) => l.name),
        })));
        return 0;
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
        return 0;
      }
      case 'provide': {
        const wf = need(args, 1, 'workflow');
        const name = need(args, 2, 'name');
        engine.provideInput(wf, name, parseJson(last(args, 'value')));
        print(io, { ok: true, provided: name });
        return 0;
      }
      case 'adopt': {
        const wf = need(args, 1, 'workflow');
        const res = engine.adopt(wf);
        print(io, { ok: true, ...res });
        return 0;
      }
      case 'tick': {
        const wf = need(args, 1, 'workflow');
        const nowRaw = last(args, 'now');
        const tickOpts = nowRaw !== undefined ? { now: Number(nowRaw) } : {};
        print(io, engine.tick(wf, tickOpts));
        return 0;
      }
      case 'reap': {
        const wf = need(args, 1, 'workflow');
        const nowFlag = flag(args, 'now');
        const wfRow = store.getWorkflow(wf);
        if (!wfRow) throw new CliError(`workflow not found: ${wf}`);
        const def = ctx.defs.get(wfRow.def);
        if (!def) throw new CliError(`unknown workflow definition '${wfRow.def}' (looked in ${ctx.defsDir})`);
        const result = engine.reapWithDetails(wf, nowMs(), def, nowFlag ? { ttlOverride: 0 } : {});
        print(io, { reaped: result.count, details: result.details });
        return 0;
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
          return 0;
        }
        print(io, engine.status(need(args, 1, 'workflow')));
        return 0;
      }
      case 'wait': {
        // Blocking poll so an orchestrator/agent can wait for engine state
        // change without burning inference on a poll loop. Plain synchronous
        // poll of the local db (cheap — one process, no LLM calls). On
        // success, prints the exact `status()` shape (same as plain
        // `status <wf>`) so a caller sees WHY it returned and can pipe the
        // output the same way. On timeout, exits 1 with a JSON body (not
        // just a stderr string) naming what's still unmet.
        const wf = need(args, 1, 'workflow');
        const until = last(args, 'until');
        if (until !== 'eligible' && until !== 'done') {
          throw new CliError(`--until must be "eligible" or "done" (got: ${until ?? '(missing)'})`);
        }
        const timeoutSpec = last(args, 'timeout') ?? '10m';
        let timeoutMs: number;
        try {
          timeoutMs = parseDurationMs(timeoutSpec);
        } catch (e) {
          throw new CliError(`--timeout: ${(e as Error).message}`);
        }

        const pollMs = 250;
        const deadline = nowMs() + timeoutMs;
        for (;;) {
          // Unknown/unresolvable workflow throws here the same way plain
          // `status <wf>` does today — `wait` inherits that for free. A bad
          // workflow id is a hard error, not a wait condition.
          const st = engine.status(wf);
          const satisfied = until === 'done' ? st.done : st.eligible.length > 0;
          if (satisfied) {
            print(io, st);
            return 0;
          }
          const now = nowMs();
          if (now >= deadline) {
            print(io, {
              ok: false,
              error: 'timeout',
              until,
              timeout: timeoutSpec,
              status: st, // last-observed state, so the caller sees *why* it's still unmet
            });
            return 1;
          }
          // Clamped so the last iteration wakes right at the deadline
          // instead of sleeping past it.
          sleepMs(Math.min(pollMs, deadline - now));
        }
      }
      case 'show': {
        const wf = need(args, 1, 'workflow');
        print(io, store.listArtifacts(wf));
        return 0;
      }
      case 'trace': {
        const wf = need(args, 1, 'workflow');
        const format = last(args, 'format') ?? 'json';
        const artifacts = store.listArtifacts(wf);
        const runs = store.listRuns(wf);

        // Resolve the def — need the workflow row to get the definition name.
        const wfRow = store.getWorkflow(wf);
        if (!wfRow) throw new CliError(`workflow not found: ${wf}`);
        const def = ctx.defs.get(wfRow.def);
        if (!def) throw new CliError(`unknown workflow definition '${wfRow.def}' (looked in ${ctx.defsDir})`);

        const trace = buildTrace(def, artifacts, runs);

        if (format === 'text') {
          // --- compact human-readable rendering ---
          io.out('=== Timeline ===');
          for (const ev of trace.timeline) {
            const ts = new Date(ev.at).toISOString();
            const keyPart = ev.key ? `[${ev.key}]` : '';
            const consumed = ev.consumedInputs
              ? JSON.stringify(ev.consumedInputs)
              : '(no fingerprint)';
            const produced = ev.producedStems.join(', ') || '(none)';
            io.out(`#${ev.seq} ${ts} ${ev.step}${keyPart} ${ev.outcome ?? 'open'} — consumed ${consumed} produced [${produced}]`);
            if (ev.summary) io.out(`    summary: ${ev.summary}`);
          }
          io.out('');
          io.out('=== Artifacts ===');
          for (const art of trace.artifacts) {
            io.out(`${art.path}  (${art.acceptance}, v${art.version}, producer: ${art.producer})`);
            if (art.approvals && Object.keys(art.approvals).length > 0) {
              const ledger = Object.entries(art.approvals).map(([jn, v]) => `${jn}@v${v}`).join(', ');
              io.out(`  approvals: ${ledger}`);
            }
            if (art.events.length === 0) {
              io.out('  (no lifecycle events)');
            } else {
              for (const ev of art.events) {
                const ts = new Date(ev.at).toISOString();
                io.out(`  ${ts}  ${ev.action}  by:${ev.by}  "${ev.text}"`);
              }
            }
          }
          io.out('');
          io.out(`=== Summary: ${trace.summary.totalRuns} runs, done=${trace.summary.done} ===`);
        } else {
          // default: JSON
          print(io, trace);
        }
        return 0;
      }
      case 'runs': {
        const wf = need(args, 1, 'workflow');
        const openOnly = flag(args, 'open');
        const runs = store.listRuns(wf); // src/store.ts, already workflow-scoped
        const tasks = store.listTasks(wf); // for the claim join
        const now = nowMs();
        const taskByKey = new Map(tasks.map((t) => [detId('taskkey', t.step, t.key), t]));

        const rows = runs
          .filter((r) => !openOnly || r.outcome === undefined)
          .map((r) => {
            const base: Record<string, unknown> = {
              run: r.id,
              step: r.step,
              key: r.key,
              outcome: r.outcome ?? 'open',
              createdAt: r.createdAt,
              updatedAt: r.updatedAt,
            };
            if (r.outcome !== undefined) return base; // only join claim state for OPEN runs
            const task = taskByKey.get(detId('taskkey', r.step, r.key ?? ''));
            if (!task || task.run !== r.id) return base; // superseded/reaped — no live claim to join
            return {
              ...base,
              claimedAt: task.claimedAt,
              heartbeatAt: task.heartbeatAt,
              attempts: task.attempts,
              claimAgeMs: task.claimedAt !== undefined ? now - task.claimedAt : undefined,
              heartbeatAgeMs: task.heartbeatAt !== undefined ? now - task.heartbeatAt : undefined,
            };
          });
        print(io, rows);
        return 0;
      }
      case 'list': {
        print(io, store.listWorkflows().map((w) => {
          const s = safeStatus(engine, w.id);
          return { id: w.id, def: w.def, title: w.title ?? null, createdAt: w.createdAt, done: s };
        }));
        return 0;
      }
      case 'green': {
        const wf = need(args, 1, 'workflow');
        // §24: a human bypass (§4.11) passes 'human' in place of a run id — no
        // lease/CAS applies, see Engine.green's actor-discrimination doc comment.
        const run = need(args, 2, 'run');
        const path = need(args, 3, 'path');
        const value = parseJson(last(args, 'value'));
        const res = engine.green(wf, run, path, value, { terminal: flag(args, 'terminal') });
        print(io, res);
        // §24: 'submitted' (producer commit awaiting judges) and 'approved'
        // (one judge signed, others still pending) are successful outcomes,
        // not errors — only 'born-rejected', 'schema-rejected', and (§26)
        // 'group-rejected' are failures.
        if (res.outcome === 'born-rejected' || res.outcome === 'schema-rejected' || res.outcome === 'group-rejected') {
          io.err(`green ${path}: ${res.outcome}${res.reason ? ' — ' + res.reason : ''}`);
          return 1;
        }
        return 0;
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
        const emitRes = engine.emit(wf, run, items);
        print(io, emitRes);
        if (emitRes.outcome !== 'emitted') {
          io.err(`emit: ${emitRes.outcome}${emitRes.reason ? ' — ' + emitRes.reason : ''}`);
          return 1;
        }
        return 0;
      }
      case 'seal': {
        const wf = need(args, 1, 'workflow');
        const run = need(args, 2, 'run');
        const sealRes = engine.seal(wf, run, parseJson(last(args, 'value')));
        print(io, sealRes);
        if (sealRes.outcome !== 'green') {
          io.err(`seal ${sealRes.path}: ${sealRes.outcome}${sealRes.reason ? ' — ' + sealRes.reason : ''}`);
          return 1;
        }
        return 0;
      }
      case 'reject': {
        const wf = need(args, 1, 'workflow');
        const path = need(args, 2, 'path');
        const by = needOpt(args, 'by');
        const text = needOpt(args, 'text');
        const rejectRes = engine.reject(wf, path, by, text);
        print(io, { ok: true, action: 'reject', path, outcome: rejectRes.outcome });
        // §24.4/§4.6: a judge's reject can itself be born-rejected by the CAS
        // guard (stale verdict against a submission that already moved on) —
        // mirror the 'green' handler above: that is a failure, not a success,
        // and callers scripting against the CLI (e.g. judged-research.yaml)
        // must see it, not a silent { ok: true }.
        if (rejectRes.outcome === 'born-rejected') {
          io.err(`reject ${path}: ${rejectRes.outcome}${rejectRes.reason ? ' — ' + rejectRes.reason : ''}`);
          return 1;
        }
        return 0;
      }
      case 'retract':
      case 'skip': {
        const wf = need(args, 1, 'workflow');
        const path = need(args, 2, 'path');
        const by = needOpt(args, 'by');
        const text = needOpt(args, 'text');
        engine[command](wf, path, by, text);
        print(io, { ok: true, action: command, path });
        return 0;
      }
      case 'retry': {
        // text/by are optional: a retry can be a bare stall-clear or carry guidance
        const wf = need(args, 1, 'workflow');
        const path = need(args, 2, 'path');
        engine.retry(wf, path, last(args, 'by') ?? 'human', last(args, 'text') ?? 'retry: stall cleared');
        print(io, { ok: true, action: 'retry', path });
        return 0;
      }
      case 'close': {
        const wf = need(args, 1, 'workflow');
        const run = need(args, 2, 'run');
        const outcome = (last(args, 'outcome') ?? 'ok') as 'ok' | 'no_work' | 'failed' | 'skipped';
        // close has no outcome discriminator: engine throws on real errors, so {ok:true} is always accurate here.
        engine.close(wf, run, outcome, last(args, 'summary'));
        print(io, { ok: true, run, outcome });
        return 0;
      }
      case 'heartbeat': {
        const wf = need(args, 1, 'workflow');
        const run = need(args, 2, 'run');
        const nowRaw = last(args, 'now');
        engine.heartbeat(wf, run, nowRaw !== undefined ? Number(nowRaw) : undefined);
        print(io, { ok: true, workflow: wf, run });
        return 0;
      }
      case 'delete': {
        const wf = need(args, 1, 'workflow');
        const children = store.listChildrenByParent(wf);
        // Default is refuse-with-children, not silent cascade: an operator deleting one workflow
        // should not accidentally destroy an unbounded tree of spawned instances. --recursive opts in.
        if (children.length > 0 && !flag(args, 'recursive')) {
          throw new CliError(
            `workflow '${wf}' has ${children.length} child instance(s): ` +
              `${children.map((c) => `${c.id} (${c.def})`).join(', ')}. ` +
              `Refusing to delete without --recursive.`,
          );
        }
        if (flag(args, 'recursive')) {
          store.deleteWorkflowCascade(wf);
        } else {
          store.deleteWorkflow(wf);
        }
        print(io, { ok: true, deleted: wf, ...(children.length > 0 ? { cascaded: children.length } : {}) });
        return 0;
      }
      case 'graph': {
        const arg = need(args, 1, 'def-name or workflow-id');
        const format = last(args, 'format') ?? 'dot';

        let def: WorkflowDef;
        let artifacts: ArtifactRow[] | undefined;

        if (ctx.defs.has(arg)) {
          // static mode: arg is a def name
          def = ctx.defs.get(arg)!;
          artifacts = undefined;
        } else {
          // live mode: arg is a workflow instance id
          const wfRow = store.getWorkflow(arg);
          if (!wfRow) {
            throw new CliError(
              `'${arg}' is neither a known workflow definition nor a workflow instance id.\n` +
              `Known definitions: ${[...ctx.defs.keys()].sort().join(', ') || '(none)'}`,
            );
          }
          const defName = wfRow.def;
          const resolvedDef = ctx.defs.get(defName);
          if (!resolvedDef) {
            throw new CliError(
              `workflow instance '${arg}' uses definition '${defName}' which is not available (looked in ${ctx.defsDir})`,
            );
          }
          def = resolvedDef;
          artifacts = store.listArtifacts(arg);
        }

        const graph = buildGraph(def, artifacts);

        if (format === 'json') {
          print(io, graph);
        } else if (format === 'mermaid') {
          io.out(graphToMermaid(graph));
        } else {
          // default: dot
          io.out(graphToDot(graph));
        }
        return 0;
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
    return dispatch(command, io, args);
  } catch (e) {
    if (e instanceof CliError || e instanceof DefError) {
      io.err(`error: ${e.message}`);
    } else {
      io.err(`error: ${(e as Error).message}`);
    }
    return 1;
  }
}
