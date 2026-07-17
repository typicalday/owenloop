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
 *   owenloop add <owner>/<repo>[@ref]   fetch, validate, and install a repo's workflow defs (public repos)
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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseYaml } from 'yaml';
import { Engine } from './engine.ts';
import { buildGraph, buildTrace, graphToDot, graphToMermaid, modelCheck } from './model.ts';
import { openStore } from './store.ts';
import type { ArtifactRow, Store, WorkflowRow } from './store.ts';
import { buildDef, DefError, lintDef, loadDefs, loadDefsRaw, validateDef } from './defs.ts';
import type { DefLoadFailure } from './defs.ts';
import type { WorkflowDef } from './types.ts';
import { dbPathRefusingSymlink, detId, mkdirRefusingSymlink, nowMs, parseDurationMs, randId } from './util.ts';
import { extractTarGz } from './untar.ts';
import {
  acquireInstallLock,
  archivePathViolation,
  commitInstall,
  finalizeInstallCommit,
  githubShaUrl,
  githubTarballUrl,
  installFolder,
  parkOldNameDir,
  parseRepoSpec,
  readLockfile,
  releaseInstallLock,
  rollbackInstallCommit,
  RollbackFailedError,
  stageFiles,
  STAGING_DIRNAME,
  writeLockfile,
} from './add.ts';
import type { InstalledEntry, InstallCommitHandle } from './add.ts';
import {
  asCreateWorkflowOk,
  asWhoami,
  computeServerDiff,
  createWorkflowError,
  credentialFilePath,
  hashDefForHub,
  hubBindingPath,
  normalizeOrigin,
  parseWorkflowList,
  pkcePair,
  randomState,
  readCredentialFile,
  readHubBinding,
  resolveEndpoint,
  writeCredentialFile,
  writeHubBinding,
} from './hub.ts';
import type { Credential, DefPushCandidate, HubBinding, WhoamiIdentity } from './hub.ts';

/** An OS keychain backend, keyed by hub origin (the `account`). */
export interface Keychain {
  get(account: string): string | null;
  set(account: string, value: string): void;
  delete(account: string): void;
}

export interface CliIO {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Injectable for hermetic tests — the network-touching verbs (`add`, hub commands) use this. */
  fetch?: typeof globalThis.fetch;
  /** Open a URL in the user's browser (login). Default: fire-and-forget `open`/`xdg-open`/`start`. */
  openUrl?: (url: string) => void;
  /**
   * OS keychain backend for credential storage. The backend is chosen ONCE per
   * process (see `credentialBackend`), then used for read/write/delete
   * consistently: a `security`-backed keychain on macOS, else the 0600 file
   * store. `undefined` here — non-mac, or `OWENLOOP_NO_KEYCHAIN=1` — selects
   * the file backend. A keychain write failure is a hard error, never a silent
   * file fallback (REL-6).
   */
  keychain?: Keychain;
  /** Read a secret from stdin (`login --with-token`). Default: drain `process.stdin`. */
  readStdin?: () => Promise<string>;
}

function defaultIO(): CliIO {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    fetch: globalThis.fetch,
    openUrl: defaultOpenUrl,
    readStdin: defaultReadStdin,
  };
}

/** Fire-and-forget browser open — never blocks the login flow on the child. */
function defaultOpenUrl(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Non-fatal: the URL is also printed to stderr for the user to open manually.
  }
}

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The default macOS keychain backend (generic passwords under service
 * `owenloop-hub`). The secret is fed through the `security -i` command stream on
 * stdin, never as a `-w` argv value, so it never appears in `ps`/shell history.
 * Returns `undefined` off macOS or when `OWENLOOP_NO_KEYCHAIN=1`, so callers
 * fall back to the 0600 credential file.
 */
const KEYCHAIN_SERVICE = 'owenloop-hub';

function defaultKeychain(env: Record<string, string | undefined>): Keychain | undefined {
  if (env.OWENLOOP_NO_KEYCHAIN === '1') return undefined;
  if (process.platform !== 'darwin') return undefined;
  return {
    get(account: string): string | null {
      try {
        const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.replace(/\n$/, '');
      } catch {
        return null; // not found (errSecItemNotFound) — treated as "no credential"
      }
    },
    set(account: string, value: string): void {
      // `security -i` reads newline-terminated commands from stdin; the secret
      // rides in that stdin stream (single-quoted), never on this process's argv.
      const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
      const cmd = `add-generic-password -U -s ${sq(KEYCHAIN_SERVICE)} -a ${sq(account)} -w ${sq(value)}\n`;
      execFileSync('security', ['-i'], { input: cmd, stdio: ['pipe', 'ignore', 'ignore'] });
    },
    delete(account: string): void {
      try {
        execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account], {
          stdio: 'ignore',
        });
      } catch {
        // Not found — already absent; a no-op delete is success.
      }
    },
  };
}

// ---- arg parsing -------------------------------------------------------------

interface Args {
  positionals: string[];
  options: Map<string, string[]>;
}

/**
 * Flags that are always boolean and must never consume the following token as
 * a value — `owenloop push --force foo` must force-push only `foo`, not treat
 * `foo` as `--force`'s value and swallow it from the positionals. Audited
 * against every `flag(args, ...)` call site in this file. `now` is dual-mode:
 * a bare boolean for `reap`, but `tick` reads it as `--now=<ms>` (the `=` form
 * bypasses this set entirely, handled by the `eq >= 0` branch below); the
 * space-separated `--now 123` form intentionally no longer binds `123` as
 * `now`'s value — docs/cli.md documents only `--now=<ms>`.
 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'assume-provided',
  'shallow',
  'now',
  'all',
  'open',
  'terminal',
  'recursive',
  'with-token',
  'dry-run',
  'force',
]);

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
      } else if (BOOLEAN_FLAGS.has(key)) {
        val = 'true'; // never consume the next token for a known-boolean flag
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

/**
 * A 429 from the hub during a push batch (REL-10). Thrown from the batch loop
 * and handled by an explicit `instanceof` branch that halts the rest of the
 * batch and surfaces `Retry-After` — NOT folded into the generic per-def
 * failure path or matched by message regex. Keeping it a distinct class is the
 * fix for the shared-catch gotcha (knowledge node "CLI: split a shared
 * switch-case when one verb's return type changes"): branch on the type, never
 * on the message text.
 */
class RateLimitError extends CliError {}

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

/** Read an optional numeric flag; throw a CliError (never NaN) on a non-finite value. */
function numOpt(args: Args, key: string): number | undefined {
  const raw = last(args, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new CliError(`invalid value for --${key}: expected --${key}=<number> (got "${raw}")`);
  }
  return n;
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
  const dbOverride = last(args, 'db') ?? io.env.OWENLOOP_DB;
  const dbPath = dbOverride ?? join(io.cwd, '.owenloop', 'state.db');
  const defsDir = last(args, 'defs') ?? io.env.OWENLOOP_DEFS ?? join(io.cwd, 'workflows');
  // Guard the built-in default (`cwd/.owenloop/state.db`) against a symlinked
  // `.owenloop` from a hostile checkout (SEC-3). Directory guard first, then the
  // file-level guard on `state.db` and its SQLite sidecars — a symlinked db file
  // inside a REAL `.owenloop` would otherwise redirect writes SQLite follows. An
  // explicit `--db`/`OWENLOOP_DB` comes from the operator, not the repo —
  // deliberately pointing state through a symlink is intent, so keep today's
  // behavior for overrides.
  if (dbOverride === undefined) {
    mkdirRefusingSymlink(dirname(dbPath));
    dbPathRefusingSymlink(dbPath);
  } else mkdirSync(dirname(dbPath), { recursive: true });
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
  add <owner>/<repo>[@ref]               fetch, validate, and install a repo's workflow defs (public repos)
  login [--hub <url>] [--with-token]     authenticate the CLI against a hub, verified via whoami (loopback OAuth, or --with-token from stdin)
  logout [--hub <url>]                   delete the stored credential for a hub
  connect [--hub <url>]                  bind this project to a hub and verify the stored credential (whoami)
  push [<defName>...] [--force] [--dry-run]   publish local workflow defs to the bound hub (server-diffed, idempotent)
  lint [<def-name>]                      check def(s) for wiring problems
  check <def> [--format text|json] [--max-depth N] [--max-states N] [--max-collection N] [--assume-provided]
                                         bounded reachability check (deadlocks, stuck, dead steps, declared invariants)
  create <def> [--title t] [--provide name=json ...] [--param k=v ...]
  provide <wf> <name> [--value json]     supply an owed (seedOwed) input
  adopt <wf>                             re-pin an instance to the current def (§28); settles new debts
  tick <wf> [--now <ms>] [--shallow] [--label <l>]...  pull eligible orders (deep: also from calls: children; --shallow for this instance only; --label filters to matching-label steps)
  reap <wf> [--now]                      run the reaper; --now forces every claim stale (TTL 0)
  runs <wf> [--open]                     list this instance's runs (+ claim state for open ones)
  order <wf> <run>                        print the order packet issued at claim time (persisted in the claim txn)
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

/** Append parse failures to a "definition not found" error — the def the user asked for may be in one of the broken files. */
function failureNote(failures: DefLoadFailure[]): string {
  if (failures.length === 0) return '';
  return `\n${failures.length} file(s) failed to load:\n  - ${failures.map((f) => `${f.file}: ${f.error}`).join('\n  - ')}`;
}

function dispatch(command: string, io: CliIO, args: Args): number {
  // help and lint need no store
  if (command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE);
    return 0;
  }

  if (command === 'lint') {
    const defsDir = last(args, 'defs') ?? io.env.OWENLOOP_DEFS ?? join(io.cwd, 'workflows');
    const failures: DefLoadFailure[] = [];
    const defs = existsSync(defsDir) ? loadDefsRaw(defsDir, failures) : new Map<string, WorkflowDef>();
    const defName = args.positionals[1];
    let hasErrors = false;

    if (defName !== undefined) {
      const def = defs.get(defName);
      if (!def) throw new CliError(`unknown workflow definition '${defName}' (looked in ${defsDir})${failureNote(failures)}`);
      const result = lintDef(def);
      if (result.errors.length) hasErrors = true;
      print(io, { def: def.name, errors: result.errors, warnings: result.warnings });
    } else {
      const results: { def?: string; file?: string; errors: string[]; warnings: string[] }[] =
        [...defs.values()].map((def) => {
          const result = lintDef(def);
          if (result.errors.length) hasErrors = true;
          return { def: def.name, errors: result.errors, warnings: result.warnings };
        });
      // Files that never became defs (malformed YAML / bad shape) are lint errors
      // too — omitting them makes `lint` claim a dir is clean when `create` would die.
      for (const f of failures) {
        hasErrors = true;
        results.push({ file: f.file, errors: [f.error], warnings: [] });
      }
      print(io, results);
    }

    if (hasErrors) throw new CliError('one or more definitions have errors (see above)');
    return 0;
  }

  if (command === 'check') {
    const defsDir = last(args, 'defs') ?? io.env.OWENLOOP_DEFS ?? join(io.cwd, 'workflows');
    const failures: DefLoadFailure[] = [];
    const defs = existsSync(defsDir) ? loadDefsRaw(defsDir, failures) : new Map<string, WorkflowDef>();
    const defName = need(args, 1, 'def');
    const def = defs.get(defName);
    if (!def) {
      throw new CliError(
        `unknown workflow definition '${defName}' (looked in ${defsDir}).\n` +
        `Known definitions: ${[...defs.keys()].sort().join(', ') || '(none)'}${failureNote(failures)}`,
      );
    }

    // loadDefsRaw uses buildDef (no semantic validation); run validateDef here so
    // invariant stem-reference / duplicate-name errors surface to the author.
    const defErrors = validateDef(def);
    if (defErrors.length > 0) {
      throw new CliError(`workflow '${def.name}' has validation errors:\n  - ${defErrors.join('\n  - ')}`);
    }

    const format = last(args, 'format') ?? 'text';
    const maxDepth = numOpt(args, 'max-depth');
    const maxStates = numOpt(args, 'max-states');
    const maxCollection = numOpt(args, 'max-collection');

    const report = modelCheck(def, {
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(maxStates !== undefined ? { maxStates } : {}),
      ...(maxCollection !== undefined ? { maxCollectionSize: maxCollection } : {}),
      ...(flag(args, 'assume-provided') ? { assumeProvided: true } : {}),
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
        const now = numOpt(args, 'now');
        // §23.6.8: tick is deep by default (descends into calls: children and
        // returns their orders too); --shallow restores single-instance ticking.
        const tickOpts: { now?: number; deep?: boolean; labels?: string[] } = {};
        if (now !== undefined) tickOpts.now = now;
        if (flag(args, 'shallow')) tickOpts.deep = false;
        // A2: repeatable --label narrows the claim to steps whose labels
        // intersect the caller's; absent = claim everything (today's behavior).
        const labels = all(args, 'label');
        if (labels.length > 0) tickOpts.labels = labels;
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
          //   `status wf --all` / `status --all wf` → the wf lands in positionals[1]
          //     (`all` is a boolean flag and never consumes the next token)
          //   `status --all=wf` → the `=` form binds wf as `--all`'s value
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
      case 'order': {
        const wf = need(args, 1, 'workflow');
        const run = need(args, 2, 'run');
        const r = store.getRun(run);
        if (!r) throw new CliError(`run not found: ${run}`);
        if (r.workflow !== wf) throw new CliError(`run ${run} belongs to workflow ${r.workflow}, not ${wf}`);
        if (r.order === undefined) throw new CliError(`run ${run} has no persisted order (created before order persistence, schema v7)`);
        print(io, r.order);
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
        engine.heartbeat(wf, run, numOpt(args, 'now'));
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

/**
 * `owenloop add <owner>/<repo>[@ref]` — the one network-touching CLI verb
 * (workflow-distribution Stage 1). Fetches a public GitHub repo's tarball,
 * validates its `workflows/**` defs with the same lint/check machinery
 * `owenloop lint`/`owenloop check` use, and — only if everything passes —
 * installs them under `<defsDir>/<installFolder(owner,repo)>/` and records
 * provenance in `.owenloop/installed.json`. A partial install is never left
 * behind: any refusal (parse/lint/validate/check failure) writes nothing, and
 * even a failure of the lockfile write after the directory swap rolls the
 * directory state back — the commit point is the durable lockfile write.
 *
 * Kept inside cli.ts (rather than add.ts) so it can reuse `Args`/`need`/
 * `last`/`CliError`/`parseJson`/`print`/`failureNote` without exporting them
 * from this module — the pure, unit-tested logic (spec parsing, lockfile
 * I/O, file install) lives in `src/add.ts`; this function is just the async
 * network + arg glue.
 */
// Request deadlines for the two `add` fetches. A small JSON/text sha lookup
// should be quick; the whole-repo tarball may be large on a slow link, so it
// gets a much longer budget. Constants only — no env knob (a follow-up can add
// one if ever needed).
const ADD_SHA_TIMEOUT_MS = 30_000;
const ADD_TARBALL_TIMEOUT_MS = 300_000;

/**
 * `owenloop add <owner>/<repo>[@ref]` — fetch a repo's `workflows/**`, validate
 * it, and install it under `<defsDir>/<installFolder(owner,repo)>`.
 *
 * The network fetch/extract/path-filter runs FIRST, unlocked (a tarball can
 * take minutes and holding a lock that long would needlessly serialize
 * unrelated adds). Everything that touches project state then runs under the
 * per-project `.owenloop/add.lock`: stale-staging cleanup → lockfile read →
 * ownership check → stage → strict validation → atomic commit (backups
 * retained) → lockfile write → finalize (backups discarded). Deciding ownership
 * and reading the lockfile INSIDE the lock is deliberate (TOCTOU discipline —
 * see the store-migration knowledge node). The install is staged on the
 * destination filesystem and swapped in with an atomic rename, but the displaced
 * previous install and any old-name dir are kept until the lockfile write
 * succeeds — the directory commit and the ledger write are one recoverable
 * operation. Any failure before the lockfile is durably written rolls the
 * directory state back and leaves the previous install and lockfile exactly as
 * they were, with no staging debris.
 */
async function dispatchAdd(io: CliIO, args: Args): Promise<number> {
  const spec = need(args, 1, 'owner/repo[@ref]');
  const { owner, repo, ref } = parseRepoSpec(spec);
  const source = `${owner}/${repo}`;
  const defsDir = last(args, 'defs') ?? io.env.OWENLOOP_DEFS ?? join(io.cwd, 'workflows');
  const lockfilePath = join(io.cwd, '.owenloop', 'installed.json');
  const installLockPath = join(io.cwd, '.owenloop', 'add.lock');
  const fetchFn = io.fetch ?? globalThis.fetch;

  // 1. Resolve the ref to a pinned commit sha.
  let shaRes: Response;
  try {
    shaRes = await fetchFn(githubShaUrl(owner, repo, ref), {
      headers: { Accept: 'application/vnd.github.sha', 'User-Agent': 'owenloop' },
      signal: AbortSignal.timeout(ADD_SHA_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new CliError(`timed out after ${ADD_SHA_TIMEOUT_MS / 1000}s resolving ${source}@${ref}`);
    }
    throw e;
  }
  if (!shaRes.ok) {
    const notFoundNote = shaRes.status === 404 ? ' (repo or ref not found)' : '';
    throw new CliError(`could not resolve ${source}@${ref}: GitHub returned ${shaRes.status}${notFoundNote}`);
  }
  const shaBody = (await shaRes.text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(shaBody)) {
    throw new CliError(`unexpected response resolving ${source}@${ref}: expected a 40-char commit sha, got "${shaBody}"`);
  }
  const sha = shaBody;

  // 2. Fetch the tarball for that pinned sha. The timeout must cover the body
  //    read too — undici ties the abort signal to the body stream — so the
  //    fetch AND arrayBuffer() live in the same try.
  let bytes: Uint8Array;
  try {
    const tarRes = await fetchFn(githubTarballUrl(owner, repo, sha), {
      headers: { 'User-Agent': 'owenloop' },
      signal: AbortSignal.timeout(ADD_TARBALL_TIMEOUT_MS),
    });
    if (!tarRes.ok) {
      throw new CliError(`could not fetch tarball for ${source}@${sha}: GitHub returned ${tarRes.status}`);
    }
    bytes = new Uint8Array(await tarRes.arrayBuffer());
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new CliError(`timed out after ${ADD_TARBALL_TIMEOUT_MS / 1000}s downloading tarball for ${source}@${sha}`);
    }
    throw e;
  }

  // 3. Extract, strip the single leading '<owner>-<repo>-<sha>/' root-dir
  //    component GitHub tarballs always have, and keep only workflows/**
  //    (re-keyed relative to that dir).
  let rawFiles: Map<string, Uint8Array>;
  try {
    rawFiles = extractTarGz(bytes);
  } catch (e) {
    throw new CliError(`could not extract tarball for ${source}@${sha}: ${(e as Error).message}`);
  }
  const files = new Map<string, Uint8Array>();
  const pathViolations: string[] = [];
  for (const [rawPath, data] of rawFiles) {
    const firstSlash = rawPath.indexOf('/');
    const rest = firstSlash >= 0 ? rawPath.slice(firstSlash + 1) : '';
    if (rest.startsWith('workflows/')) {
      const relPath = rest.slice('workflows/'.length);
      if (relPath) {
        // Reject any entry that would escape the staging/install dir BEFORE it
        // is ever joined and written (SEC-1). Collect every offender so the
        // refusal names them all.
        const violation = archivePathViolation(relPath);
        if (violation) {
          pathViolations.push(`${rawPath}: ${violation}`);
          continue;
        }
        files.set(relPath, data);
      }
    }
  }
  if (pathViolations.length > 0) {
    throw new CliError(
      `refusing to install ${source}@${sha} — ${pathViolations.length} unsafe archive path(s) found; nothing written:\n  - ${pathViolations.join('\n  - ')}`,
    );
  }
  // Note: git (and so GitHub's tarball export) never tracks a truly empty
  // directory, so "no workflows/ dir at all" and "workflows/ dir exists but
  // is untracked-empty" are indistinguishable from the archive's contents —
  // both land here as files.size === 0. A `workflows/` dir that is tracked
  // but genuinely has zero yaml defs in it (e.g. holds only a .gitkeep)
  // takes the success/`installed: 0` path below instead, since it has at
  // least one file under the prefix.
  if (files.size === 0) {
    throw new CliError(`no workflows/ directory found in ${source}@${ref}`);
  }

  // 4. Everything that touches project state runs under the per-project install
  //    lock: concurrent `add` runs serialize instead of interleaving. The lock
  //    is acquired only now — AFTER the (potentially slow) network fetch — so a
  //    tarball download never blocks an unrelated add.
  const folder = installFolder(owner, repo);
  const stagingRoot = join(defsDir, STAGING_DIRNAME);
  const stagingDir = join(stagingRoot, randId('stg'));
  const lock = await acquireInstallLock(installLockPath);
  // Set true only on a rollback double-fault, where the ONLY copy of the
  // previous content ends up parked under the staging root — then the `finally`
  // must NOT delete it (the error message tells the user to recover it).
  let preserveStagingRoot = false;
  try {
    // The lock holder is the only legitimate writer under the staging root, so
    // anything already there is debris from a crashed/killed prior run — clear
    // it. Keeps "no staging debris" true even across a Ctrl-C.
    rmSync(stagingRoot, { recursive: true, force: true });

    // Read the lockfile and decide ownership INSIDE the lock (TOCTOU: a pre-lock
    // read could be stale by the time we act on it). A corrupt lockfile is a
    // hard error (readLockfile), never a silent reset.
    const lf = readLockfile(lockfilePath);
    const dest = join(defsDir, folder);
    const existing = lf.installed[source];
    // Use-site exact-match (Layer 2): the entry being installed may only record
    // the currently computed folder OR the exact legacy `<owner>-<repo>` name
    // (the only pre-hash scheme this tool ever wrote). `readLockfile` has
    // already refused any structurally unsafe `path`; this additionally refuses
    // a structurally-valid-but-WRONG segment (e.g. 'not-the-right-folder')
    // before any staging/commit mutation, so the later `existing.path !== folder`
    // migration branch is guaranteed to see only the exact legacy name.
    const legacyFolder = `${owner}-${repo}`;
    if (existing && existing.path !== folder && existing.path !== legacyFolder) {
      throw new CliError(
        `refusing to install ${source}: lockfile records install path '${existing.path}', ` +
          `which is neither the expected '${folder}' nor the legacy '${legacyFolder}' — fix ${lockfilePath} manually`,
      );
    }
    if (existsSync(dest) && !(existing && existing.path === folder)) {
      throw new CliError(
        `refusing to install ${source}: destination '${folder}' already exists and is not owned by ${source} — ` +
          `remove it manually or fix ${lockfilePath}`,
      );
    }

    // Stage the incoming files onto the DESTINATION filesystem (under defsDir),
    // so the commit is an atomic same-fs rename. Two-level layout keeps the
    // staged content invisible to loadDefs(defsDir).
    const written = stageFiles(stagingDir, files);

    // 5. Validate the STAGED tree — the exact bytes that will be renamed into
    //    place, with no re-write after validation.
    const failures: DefLoadFailure[] = [];
    const staged = loadDefsRaw(stagingDir, failures);
    const reasons: string[] = failures.map((f) => `${f.file}: ${f.error}`);

    for (const stagedDef of staged.values()) {
      const lintResult = lintDef(stagedDef);
      reasons.push(...lintResult.errors.map((e) => `${stagedDef.name}: ${e}`));
      const validationErrors = validateDef(stagedDef);
      reasons.push(...validationErrors.map((e) => `${stagedDef.name}: ${e}`));

      // Mirror the `check` command's exact "definite defect" predicate — but,
      // deliberately, WITH `assumeProvided: true`. Without it, a def with any
      // `seedOwed` input (the norm — see e.g. `proposal` in delivery.yaml)
      // deadlocks in the very first state, because the checker models "no
      // `provide` has happened yet" by default (see `seedArts` in
      // src/model.ts). `owenloop check <def>` behaves the same way absent
      // `--assume-provided`; verified every def under examples/workflows/
      // fails plain `check` for exactly this reason. Since `add` validates a
      // def that a real user will `provide` into after install (that's the
      // whole point of a seedOwed input), refusing every seedOwed def here
      // would make `add` unable to install almost any real workflow,
      // including this project's own examples — so this checks "is it
      // completable once its owed inputs are supplied," the same bar a
      // careful author would clear with `check --assume-provided` before
      // publishing.
      const report = modelCheck(stagedDef, { assumeProvided: true });
      const hasDefiniteDefect =
        report.invariantViolations.length > 0 ||
        (!report.bounded && (report.deadlocks.length > 0 || report.stuck.length > 0));
      if (hasDefiniteDefect) {
        reasons.push(
          `${stagedDef.name}: definite defects found (${report.invariantViolations.length} invariant violation(s), ` +
            `${report.deadlocks.length} deadlock(s), ${report.stuck.length} stuck state(s))`,
        );
      }
    }

    // Strict backstop: only if the aggregate pass found nothing, run the FULL
    // loadDefs on the staged tree. `loadDefsRaw` is best-effort — it swallows
    // include-expansion failures and cross-def `calls:` errors that strict
    // `loadDefs` (via finalizeDefs) throws on. Every later command loads the
    // installed dir with strict `loadDefs`, so this guarantees whatever we
    // commit cannot make a subsequent `loadDefs` of that dir throw.
    if (reasons.length === 0) {
      try {
        loadDefs(stagingDir);
      } catch (e) {
        if (e instanceof DefError) {
          reasons.push(`cross-definition validation failed: ${e.message}`);
        } else {
          throw e;
        }
      }
    }

    if (reasons.length > 0) {
      throw new CliError(
        `refusing to install ${source}@${sha} — ${reasons.length} problem(s) found; nothing written:\n  - ${reasons.join('\n  - ')}`,
      );
    }

    // 6. Commit as one recoverable operation: atomically swap the validated
    //    staging dir into place (backups RETAINED, not dropped), park any
    //    old-naming dir this source used to occupy, write the lockfile, and only
    //    then finalize (discard the retained backups). If the lockfile write
    //    fails after the swap, roll the directory state back so the previous
    //    install and lockfile are left exactly as they were.
    let handle: InstallCommitHandle;
    try {
      handle = commitInstall(defsDir, folder, stagingDir);
    } catch (e) {
      // commitInstall's own swap-then-rollback double-fault left the only copy
      // of previous content under the staging root — keep it (see the `finally`).
      if (e instanceof RollbackFailedError) preserveStagingRoot = true;
      throw e;
    }
    if (existing && existing.path !== folder) {
      // Migrating off the old `<owner>-<repo>` scheme: park (not delete) the old
      // dir so a failure below can restore it. Finalized away on success. This
      // park now sits INSIDE the recoverable region — a park failure must roll
      // the committed swap back too, exactly like the lockfile-write failure
      // below (a bare park could otherwise strand the swap and leave the next
      // `add` refusing on an ownership mismatch).
      try {
        parkOldNameDir(handle, defsDir, existing.path);
      } catch (e) {
        try {
          rollbackInstallCommit(handle);
        } catch (rollbackErr) {
          // Double fault: parking the old dir failed AND restoring the directory
          // state failed. The previous content is now parked under the staging
          // root — preserve it past the `finally` and tell the user how to
          // recover, mirroring the lockfile-write double fault below.
          preserveStagingRoot = true;
          throw new CliError(
            `could not migrate ${source} off old-name directory '${existing.path}' (${(e as Error).message}) ` +
              `and rolling the install back failed too (${(rollbackErr as Error).message}); ` +
              `previous content preserved under ${stagingRoot} — recover it before running add again ` +
              `(the next add clears that directory as debris)`,
          );
        }
        throw new CliError(
          `could not migrate ${source} off old-name directory '${existing.path}': ${(e as Error).message} — ` +
            `install rolled back, previous state restored`,
        );
      }
    }

    const entry: InstalledEntry = { source, ref, sha, installedAt: nowMs(), path: folder, files: written };
    lf.installed[source] = entry;
    try {
      writeLockfile(lockfilePath, lf);
    } catch (e) {
      try {
        rollbackInstallCommit(handle);
      } catch (rollbackErr) {
        // Double fault: the ledger write failed AND restoring the directory
        // failed. The previous content is now parked under the staging root —
        // preserve it past the `finally` and tell the user how to recover.
        preserveStagingRoot = true;
        throw new CliError(
          `could not record install of ${source} in ${lockfilePath} (${(e as Error).message}) ` +
            `and rolling the install back failed too (${(rollbackErr as Error).message}); ` +
            `previous content preserved under ${stagingRoot} — recover it before running add again ` +
            `(the next add clears that directory as debris)`,
        );
      }
      throw new CliError(
        `could not record install of ${source} in ${lockfilePath}: ${(e as Error).message} — ` +
          `install rolled back, previous state restored`,
      );
    }
    finalizeInstallCommit(handle);

    // 7. Report.
    print(io, {
      ok: true,
      source,
      ref,
      sha,
      path: folder,
      installed: written.length,
      defs: [...staged.values()].map((d) => d.name).sort(),
    });
    return 0;
  } finally {
    // On success the staging dir was renamed away and its retained backups
    // finalized; on failure this clears whatever staging debris is left. The one
    // exception is a rollback double-fault (`preserveStagingRoot`), where the
    // only surviving copy of the previous content is parked here — leave it for
    // the user to recover (the next add clears it as debris). Then release the lock.
    if (!preserveStagingRoot) rmSync(stagingRoot, { recursive: true, force: true });
    releaseInstallLock(lock);
  }
}

// ---- hub onboarding: login / logout / connect / push -------------------------

/**
 * Resolve the target hub origin: `--hub` > `OWENLOOP_HUB` env > the default
 * production hub. Normalized (scheme required, trailing slash/path stripped) so
 * it can serve as a stable credential-store key and project binding value.
 */
const DEFAULT_HUB = 'https://api.owenloop.com';

function resolveHub(io: CliIO, args: Args): string {
  const raw = last(args, 'hub') ?? io.env.OWENLOOP_HUB ?? DEFAULT_HUB;
  try {
    return normalizeOrigin(raw);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
}

function resolveKeychain(io: CliIO): Keychain | undefined {
  if (io.env.OWENLOOP_NO_KEYCHAIN === '1') return undefined;
  return io.keychain ?? defaultKeychain(io.env);
}

/**
 * The credential backend, decided ONCE from env/config (`resolveKeychain`) and
 * then used consistently for read and write. Deciding once — rather than
 * per-operation — is the REL-6 fix: the old error-driven fallback let a write
 * land in the file while a later read hit the (absent/stale) keychain, so a
 * credential could shadow itself across backends.
 */
type CredentialBackend = { kind: 'keychain'; kc: Keychain } | { kind: 'file' };

function credentialBackend(io: CliIO): CredentialBackend {
  const kc = resolveKeychain(io);
  return kc ? { kind: 'keychain', kc } : { kind: 'file' };
}

/**
 * Read the stored credential for `origin` from the chosen backend ONLY. A
 * keychain-backed read NEVER falls through to the file (that fallback was the
 * REL-6 shadowing bug), and a corrupt keychain entry reads as absent (`null`)
 * — login overwrites it, logout clears it — never as a reason to consult the
 * file.
 */
function readCredential(io: CliIO, origin: string): Credential | null {
  const backend = credentialBackend(io);
  if (backend.kind === 'keychain') {
    const raw = backend.kc.get(origin);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Credential;
    } catch {
      return null; // corrupt entry — treat as absent; do NOT consult the file
    }
  }
  const file = readCredentialFile(credentialFilePath(io.env));
  return file.hubs[origin] ?? null;
}

/**
 * Store a credential for `origin` in the chosen backend ONLY; returns which
 * one. A failed keychain write is a hard error (REL-6), never a silent
 * fall-through to the file — the escape hatch is to choose the file backend up
 * front with `OWENLOOP_NO_KEYCHAIN=1`.
 */
function storeCredential(io: CliIO, origin: string, cred: Credential): 'keychain' | 'file' {
  const backend = credentialBackend(io);
  if (backend.kind === 'keychain') {
    try {
      backend.kc.set(origin, JSON.stringify(cred));
    } catch (e) {
      throw new CliError(
        `could not write the credential to the OS keychain: ${(e as Error).message}. ` +
          'Fix the keychain, or set OWENLOOP_NO_KEYCHAIN=1 to use the 0600 file store',
      );
    }
    return 'keychain';
  }
  const path = credentialFilePath(io.env);
  const file = readCredentialFile(path);
  file.hubs[origin] = cred;
  writeCredentialFile(path, file);
  return 'file';
}

/**
 * Delete any stored credential for `origin` from BOTH backends. Deliberately
 * not routed through `credentialBackend`: logout is a defensive dual-clear
 * (the proposal explicitly blesses it), so a live refresh token can never be
 * stranded in the store that wasn't the currently-chosen one. Returns whether
 * anything was removed.
 */
function deleteCredential(io: CliIO, origin: string): boolean {
  let removed = false;
  const kc = resolveKeychain(io);
  if (kc && kc.get(origin) !== null) {
    kc.delete(origin);
    removed = true;
  }
  const path = credentialFilePath(io.env);
  const file = readCredentialFile(path);
  if (file.hubs[origin] !== undefined) {
    delete file.hubs[origin];
    writeCredentialFile(path, file);
    removed = true;
  }
  return removed;
}

/** The Bearer value for an authenticated request. Never logged. */
function authHeader(cred: Credential): string {
  return `Bearer ${cred.accessToken}`;
}

// Request deadline for EVERY hub/auth call — OAuth discovery, DCR, code
// exchange, token refresh, whoami, workflow list, and push (REL-7). These are
// all small JSON round-trips, so one budget fits them all;
// OWENLOOP_HUB_TIMEOUT_MS overrides it (a test knob, consistent with
// OWENLOOP_LOGIN_TIMEOUT_MS and the project's other OWENLOOP_* test-only knobs).
const HUB_TIMEOUT_MS = 30_000;

function hubTimeoutMs(io: CliIO): number {
  const override = Number(io.env.OWENLOOP_HUB_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : HUB_TIMEOUT_MS;
}

/**
 * `fetch` wrapper putting a deadline on every hub/auth call (REL-7). The abort
 * signal is threaded into `fetch` AND the body is fully buffered inside the
 * same try, so the deadline covers a stalled BODY read too — the exact undici
 * behavior the two `add` fetches document (`AbortSignal.timeout` ties the
 * signal to the body stream). The returned `Response` re-exposes the buffered
 * body, so every call site's `res.json()` / `res.status` /
 * `res.headers.get(...)` usage is byte-for-byte unchanged. A
 * `TimeoutError`/`AbortError` becomes a clear `CliError` (naming the request,
 * which is origin+path only — never a token); anything else is rethrown
 * untouched.
 */
async function hubFetch(io: CliIO, url: string, init?: RequestInit): Promise<Response> {
  const fetchFn = io.fetch ?? globalThis.fetch;
  const ms = hubTimeoutMs(io);
  const method = (init?.method ?? 'GET').toUpperCase();
  try {
    const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(ms) });
    // 204/304 carry no body — reading one would be a spec violation.
    if (res.status === 204 || res.status === 304) {
      return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    const body = await res.arrayBuffer();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new CliError(`hub did not respond within ${ms / 1000}s (${method} ${url})`);
    }
    throw e;
  }
}

/**
 * Ensure an `oauth` credential's access token is fresh: if it expires within
 * 60s, refresh once (grant_type=refresh_token) and persist the new token. No-op
 * for `agent`/`oauth-pasted` credentials (they don't refresh). Returns the
 * possibly-updated credential.
 */
async function ensureFreshOAuth(io: CliIO, origin: string, cred: Credential, persist = true): Promise<Credential> {
  if (cred.kind !== 'oauth') return cred;
  if (cred.expiresAt - nowMs() > 60_000) return cred;
  return refreshOAuth(io, origin, cred, persist);
}

/**
 * `persist` defaults to true — the normal case is refreshing an ALREADY
 * stored, trusted credential (push/connect), where persisting immediately
 * matters because refresh tokens can be single-use/rotating: losing the new
 * one to a later crash would strand the user. `verifyCredential`'s login-time
 * use passes `persist: false` — a not-yet-stored credential must never be
 * written to disk/keychain before it is proven to work end to end (a 401 on
 * the retry after this refresh still fails the overall login), matching the
 * "never store an unverified token" rule enforced at every login call site.
 */
async function refreshOAuth(
  io: CliIO,
  origin: string,
  cred: Extract<Credential, { kind: 'oauth' }>,
  persist = true,
): Promise<Credential> {
  const tokenEndpoint = await discoverTokenEndpoint(io, origin);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: cred.refreshToken,
    client_id: cred.clientId,
  });
  const res = await hubFetch(io, tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new CliError('credential expired and refresh failed — run `owenloop login`');
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (typeof json.access_token !== 'string') {
    throw new CliError('credential expired and refresh returned no access token — run `owenloop login`');
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  const refreshed: Credential = {
    kind: 'oauth',
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : cred.refreshToken,
    expiresAt: nowMs() + expiresIn * 1000,
    clientId: cred.clientId,
  };
  if (persist) storeCredential(io, origin, refreshed);
  return refreshed;
}

interface AsMetadata {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
}

async function discoverMetadata(io: CliIO, origin: string): Promise<AsMetadata> {
  const res = await hubFetch(io, resolveEndpoint(origin, '/.well-known/oauth-authorization-server'), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new CliError(`could not read OAuth metadata from ${origin} (HTTP ${res.status})`);
  }
  return (await res.json()) as AsMetadata;
}

async function discoverTokenEndpoint(io: CliIO, origin: string): Promise<string> {
  const meta = await discoverMetadata(io, origin);
  if (!meta.token_endpoint) throw new CliError(`hub ${origin} advertises no token_endpoint`);
  return resolveEndpoint(origin, meta.token_endpoint);
}

/**
 * GET `path` on `origin` with a bearer credential, refreshing an expiring
 * oauth token first and retrying exactly once after a 401→refresh for oauth.
 * Returns the raw response plus the credential actually used (possibly
 * refreshed), so the caller can both persist it and apply its own hard-error
 * semantics on the final status (a 401 after the retry, a non-2xx, etc. —
 * left to the caller since the wording differs slightly by context).
 */
async function authedGet(
  io: CliIO,
  origin: string,
  cred: Credential,
  path: string,
  persist = true,
): Promise<{ res: Response; cred: Credential }> {
  let current = await ensureFreshOAuth(io, origin, cred, persist);
  let res = await hubFetch(io, resolveEndpoint(origin, path), {
    headers: { Authorization: authHeader(current), Accept: 'application/json' },
  });
  if (res.status === 401 && current.kind === 'oauth') {
    current = await refreshOAuth(io, origin, current as Extract<Credential, { kind: 'oauth' }>, persist);
    res = await hubFetch(io, resolveEndpoint(origin, path), {
      headers: { Authorization: authHeader(current), Accept: 'application/json' },
    });
  }
  return { res, cred: current };
}

/**
 * A 401 on an agent token is a hard "revoked/invalid" error; a 401 on any
 * other credential kind (after `authedGet`'s one refresh-and-retry) is a hard
 * "credential rejected" error; any other non-2xx is a generic hub-rejected
 * error naming the status. Shared by `verifyCredential` and `dispatchPush`'s
 * server-list fetch so both surfaces the same wording for the same failure.
 */
function assertAuthOk(res: Response, cred: Credential, origin: string): void {
  if (res.status === 401) {
    if (cred.kind === 'agent') {
      throw new CliError('token revoked or invalid — re-mint it in the console or run `owenloop login`');
    }
    throw new CliError('credential rejected by the hub — run `owenloop login`');
  }
  if (!res.ok) {
    throw new CliError(`hub ${origin} rejected the credential (HTTP ${res.status})`);
  }
}

/**
 * Verify a credential works against the hub's `GET /api/whoami` (any 2xx =
 * authenticated) and return the identity it names. Whoami carries no RBAC
 * verb, so this proves *authentication*, not any particular scope (e.g.
 * `list`) — a token lacking a scope `push` later needs still fails there,
 * with the hub's own 401/403, which is acceptable and honest. Refreshes an
 * expiring oauth token first, and retries exactly once after a 401→refresh
 * for oauth; a 401 on an agent token is a hard "revoked/invalid" error.
 * Returns the credential actually used (possibly refreshed), so the caller
 * can persist it, alongside the parsed identity.
 *
 * `persist` (default true) controls whether an in-flight refresh writes its
 * new token to storage immediately (see `refreshOAuth`'s doc comment) —
 * `dispatchLogin`'s OAuth branch passes `false` because the credential being
 * verified here hasn't been stored yet at all; a refresh mid-verify must not
 * sneak a not-yet-proven credential onto disk ahead of the pass/fail verdict.
 */
async function verifyCredential(
  io: CliIO,
  origin: string,
  cred: Credential,
  persist = true,
): Promise<{ cred: Credential; identity: WhoamiIdentity }> {
  const { res, cred: current } = await authedGet(io, origin, cred, '/api/whoami', persist);
  assertAuthOk(res, current, origin);
  const body: unknown = await res.json();
  return { cred: current, identity: asWhoami(body) };
}

/**
 * `owenloop login` — authenticate the CLI against a hub. Primary flow is a
 * loopback OAuth auth-code + PKCE(S256) exchange; `--with-token` reads an
 * `olp_`/`mcpat_` token from stdin instead (never argv). Either way the
 * credential is verified before it is stored, and stored in the OS keychain or
 * a 0600 file — never plaintext in the repo or `.env`.
 */
async function dispatchLogin(io: CliIO, args: Args): Promise<number> {
  const origin = resolveHub(io, args);
  const existed = readCredential(io, origin) !== null;

  if (flag(args, 'with-token')) {
    const readStdin = io.readStdin ?? defaultReadStdin;
    const token = (await readStdin()).trim();
    if (token === '') throw new CliError('no token on stdin (pipe the token in, e.g. `pbpaste | owenloop login --with-token`)');
    let cred: Credential;
    if (token.startsWith('olp_')) cred = { kind: 'agent', accessToken: token };
    else if (token.startsWith('mcpat_')) cred = { kind: 'oauth-pasted', accessToken: token };
    else throw new CliError('unrecognized token — expected an `olp_` agent token or an `mcpat_` access token');
    const { identity } = await verifyCredential(io, origin, cred); // never store an unverified token
    const storage = storeCredential(io, origin, cred);
    print(io, {
      ok: true,
      hub: origin,
      kind: cred.kind,
      storage,
      replaced: existed,
      org: identity.orgName,
      orgId: identity.orgId,
      identity: identity.actor,
      ...(identity.email ? { email: identity.email } : {}),
    });
    return 0;
  }

  // Loopback OAuth: bind the port FIRST (the service matches redirect URIs by
  // exact string — no RFC 8252 variable-port allowance — so the DCR must carry
  // the concrete 127.0.0.1:<port> callback).
  const { verifier, challenge } = pkcePair();
  const state = randomState();
  const timeoutOverride = Number(io.env.OWENLOOP_LOGIN_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : undefined;
  const { server, port, waitForCallback, close } = await startLoopbackServer(state, timeoutMs);
  try {
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const meta = await discoverMetadata(io, origin);
    if (!meta.authorization_endpoint || !meta.token_endpoint || !meta.registration_endpoint) {
      throw new CliError(`hub ${origin} does not advertise the OAuth endpoints login needs`);
    }
    const clientId = await registerClient(io, origin, meta.registration_endpoint, redirectUri);

    const authUrl = new URL(resolveEndpoint(origin, meta.authorization_endpoint));
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);

    io.err(`Opening your browser to sign in. If it does not open, visit:\n  ${authUrl.toString()}`);
    (io.openUrl ?? defaultOpenUrl)(authUrl.toString());

    const { code } = await waitForCallback;

    const exchanged = await exchangeCode(io, origin, meta.token_endpoint, {
      code,
      clientId,
      redirectUri,
      verifier,
    });
    const { cred, identity } = await verifyCredential(io, origin, exchanged, false); // never store an unverified token
    const storage = storeCredential(io, origin, cred);
    print(io, {
      ok: true,
      hub: origin,
      kind: cred.kind,
      storage,
      replaced: existed,
      org: identity.orgName,
      orgId: identity.orgId,
      identity: identity.actor,
      ...(identity.email ? { email: identity.email } : {}),
    });
    return 0;
  } finally {
    void server;
    close();
  }
}

interface LoopbackServer {
  server: ReturnType<typeof createServer>;
  port: number;
  waitForCallback: Promise<{ code: string }>;
  close: () => void;
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Bind a single-use loopback catcher on 127.0.0.1:0 that resolves on the OAuth
 * callback. `timeoutMs` overrides the 5-minute default (test knob, threaded
 * from `OWENLOOP_LOGIN_TIMEOUT_MS` by `dispatchLogin`, consistent with the
 * project's other `OWENLOOP_*` test-only env knobs).
 */
async function startLoopbackServer(expectedState: string, timeoutMs: number = LOGIN_TIMEOUT_MS): Promise<LoopbackServer> {
  const loginHtml = (msg: string): string =>
    `<!doctype html><meta charset="utf-8"><title>owenloop</title><body style="font-family:system-ui;padding:2rem"><p>${msg}</p></body>`;

  let resolveCb!: (v: { code: string }) => void;
  let rejectCb!: (e: Error) => void;
  const waitForCallback = new Promise<{ code: string }>((res, rej) => {
    resolveCb = res;
    rejectCb = rej;
  });
  // The timeout timer (below) can fire — and reject waitForCallback — before
  // dispatchLogin reaches its `await waitForCallback` (it awaits
  // discoverMetadata/registerClient first), which would otherwise surface as
  // an unhandled rejection and crash the process. This no-op .catch marks the
  // rejection handled without consuming it; the later real `await
  // waitForCallback` in dispatchLogin still sees and throws the same error.
  waitForCallback.catch(() => {});

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback') {
      res.writeHead(404);
      res.end();
      return;
    }
    const error = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    const gotState = u.searchParams.get('state');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(loginHtml('Login failed. You can close this tab.'));
      rejectCb(new CliError(`login denied by the hub: ${error}`));
      return;
    }
    if (gotState !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(loginHtml('State mismatch. You can close this tab.'));
      rejectCb(new CliError('state mismatch on the OAuth callback — possible CSRF; aborting login'));
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(loginHtml('Missing authorization code. You can close this tab.'));
      rejectCb(new CliError('OAuth callback carried no authorization code'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(loginHtml('Login complete — return to your terminal.'));
    resolveCb({ code });
  });

  const timer = setTimeout(() => {
    const human = timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000} minutes` : `${timeoutMs}ms`;
    rejectCb(new CliError(`login timed out after ${human} waiting for the browser callback`));
  }, timeoutMs);
  timer.unref?.();

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    waitForCallback,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}

/** DCR a public client (no client secret) with the exact loopback redirect URI. */
async function registerClient(io: CliIO, origin: string, registrationEndpoint: string, redirectUri: string): Promise<string> {
  const res = await hubFetch(io, resolveEndpoint(origin, registrationEndpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'owenloop CLI',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  if (!res.ok) {
    throw new CliError(`dynamic client registration failed at ${origin} (HTTP ${res.status})`);
  }
  const json = (await res.json()) as { client_id?: string };
  if (typeof json.client_id !== 'string') {
    throw new CliError('dynamic client registration returned no client_id');
  }
  return json.client_id;
}

/** Exchange an auth code for tokens (form-encoded, with the PKCE verifier). */
async function exchangeCode(
  io: CliIO,
  origin: string,
  tokenEndpoint: string,
  p: { code: string; clientId: string; redirectUri: string; verifier: string },
): Promise<Credential> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  });
  const res = await hubFetch(io, resolveEndpoint(origin, tokenEndpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new CliError(`token exchange failed at ${origin} (HTTP ${res.status})`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (typeof json.access_token !== 'string' || typeof json.refresh_token !== 'string') {
    throw new CliError('token exchange returned an incomplete token set');
  }
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  return {
    kind: 'oauth',
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: nowMs() + expiresIn * 1000,
    clientId: p.clientId,
  };
}

/**
 * `owenloop logout` — delete the stored credential for a hub from both the
 * keychain and the file store. Cheap; completes the credential lifecycle.
 */
async function dispatchLogout(io: CliIO, args: Args): Promise<number> {
  const origin = resolveHub(io, args);
  const removed = deleteCredential(io, origin);
  print(io, { ok: true, hub: origin, removed });
  return 0;
}

/**
 * `owenloop connect` — bind the current project to a hub (writes
 * `.owenloop/hub.json`) and verify the stored credential works. Requires a
 * prior `owenloop login` for the resolved origin. `.owenloop/hub.json` is a
 * pure binding — there's no push state to preserve or reset across a rebind
 * (see `HubBinding`); `switchedFrom` is still reported when the origin
 * changes so the caller notices the rebind.
 */
async function dispatchConnect(io: CliIO, args: Args): Promise<number> {
  const origin = resolveHub(io, args);
  const cred = readCredential(io, origin);
  if (!cred) throw new CliError(`no stored credential for ${origin} — run \`owenloop login\` first`);

  const { identity } = await verifyCredential(io, origin, cred);

  const path = hubBindingPath(io.cwd);
  const existing = readHubBinding(path);
  const switched = existing !== null && existing.hub !== origin;
  const binding: HubBinding = { version: 1, hub: origin };
  writeHubBinding(path, binding);

  print(io, {
    ok: true,
    hub: origin,
    ...(switched ? { switchedFrom: existing!.hub } : {}),
    org: identity.orgName,
    orgId: identity.orgId,
    identity: identity.actor,
    ...(identity.email ? { email: identity.email } : {}),
  });
  return 0;
}

/**
 * `owenloop push [<defName>...] [--force] [--dry-run]` — publish local workflow
 * defs to the bound hub, diffed against the hub's own def `hash`
 * (`GET /api/workflows` — see `computeServerDiff`), never a client-side
 * ledger. Mirrors `add`'s all-or-nothing client-side validation gate before
 * any network write; server-side failures mid-batch record what landed and
 * exit 1. `POST /api/create_workflow` is itself idempotent, so even a wrong
 * "changed" verdict (e.g. from engine-version drift between this CLI and the
 * hub) is harmless — it just costs one extra round-trip that the server
 * reports back as a no-op.
 */
async function dispatchPush(io: CliIO, args: Args): Promise<number> {
  const defsDir = last(args, 'defs') ?? io.env.OWENLOOP_DEFS ?? join(io.cwd, 'workflows');
  const dryRun = flag(args, 'dry-run');
  const force = flag(args, 'force');

  // Require a project binding.
  const bindingPath = hubBindingPath(io.cwd);
  const binding = readHubBinding(bindingPath);
  if (!binding) throw new CliError('this project is not bound to a hub — run `owenloop connect` first');
  // Defense in depth (SEC-2): a hub.json written by an older CLI could carry a
  // remote-http origin that predates the transport policy, and dispatchPush uses
  // it verbatim as the request origin. Validate the persisted binding at USE
  // time — normalizeOrigin enforces https-except-loopback. This check lives
  // here, NOT inside readHubBinding: dispatchConnect reads the existing binding
  // only to report switchedFrom, and a read-time throw would deadlock rebinding
  // AWAY from a bad origin. Leave readHubBinding shape-validation-only.
  let origin: string;
  try {
    origin = normalizeOrigin(binding.hub);
  } catch (e) {
    throw new CliError(`${(e as Error).message} — re-run \`owenloop connect\` to rebind`);
  }
  // A --hub that disagrees with the binding is a mistake, not a silent override.
  const hubArg = last(args, 'hub');
  if (hubArg !== undefined) {
    const requested = normalizeOrigin(hubArg);
    if (requested !== origin) {
      throw new CliError(`this project is bound to ${origin}, not ${requested} — re-run \`owenloop connect\` to rebind`);
    }
  }

  let cred = readCredential(io, origin);
  if (!cred) throw new CliError(`no stored credential for ${origin} — run \`owenloop login\``);

  // Load defs (same machinery as lint/add).
  if (!existsSync(defsDir)) throw new CliError(`defs directory not found: ${defsDir}`);
  const failures: DefLoadFailure[] = [];
  const allDefs = loadDefsRaw(defsDir, failures);

  // Narrow to positional names, if any (error on an unknown name).
  const requested = args.positionals.slice(1);
  let selected: WorkflowDef[];
  if (requested.length > 0) {
    selected = [];
    for (const name of requested) {
      const def = allDefs.get(name);
      if (!def) {
        throw new CliError(`unknown workflow definition '${name}' (looked in ${defsDir})${failureNote(failures)}`);
      }
      selected.push(def);
    }
  } else {
    selected = [...allDefs.values()];
  }
  if (selected.length === 0) {
    throw new CliError(`nothing to push — no workflow definitions found in ${defsDir}`);
  }

  // Client-side validation gate — all-or-nothing, mirroring dispatchAdd exactly.
  // Any failure aborts the entire push; nothing is sent.
  const reasons: string[] = failures.map((f) => `${f.file}: ${f.error}`);
  for (const def of selected) {
    const lintResult = lintDef(def);
    reasons.push(...lintResult.errors.map((e) => `${def.name}: ${e}`));
    reasons.push(...validateDef(def).map((e) => `${def.name}: ${e}`));
    const report = modelCheck(def, { assumeProvided: true });
    const hasDefiniteDefect =
      report.invariantViolations.length > 0 ||
      (!report.bounded && (report.deadlocks.length > 0 || report.stuck.length > 0));
    if (hasDefiniteDefect) {
      reasons.push(
        `${def.name}: definite defects found (${report.invariantViolations.length} invariant violation(s), ` +
          `${report.deadlocks.length} deadlock(s), ${report.stuck.length} stuck state(s))`,
      );
    }
  }

  // Assemble the push candidates: verbatim source yaml + the server-canonical
  // content hash (hashDefForHub). Defs whose file uses include: are not
  // hub-pushable (the service's create_workflow parses without include
  // expansion, and a re-serialized expanded def is not round-trippable) —
  // refuse them with a clear per-def reason. Same for bodyFile: — hashDefForHub
  // parses with no baseDir (matching the server's own computation), which
  // throws a DefError naming bodyFile for such a def; catch that specific
  // failure and refuse the def pre-push rather than letting it read as a
  // generic error (the server would reject the raw-YAML push anyway).
  const candidates: DefPushCandidate[] = [];
  for (const def of selected) {
    if (!def.dir) {
      reasons.push(`${def.name}: has no source file on disk to push`);
      continue;
    }
    const yaml = readFileSync(def.dir, 'utf8');
    let usesInclude = false;
    try {
      const rawDef = buildDef(parseYaml(yaml), basename(def.dir), dirname(def.dir));
      usesInclude = (rawDef._includes?.length ?? 0) > 0;
    } catch {
      // A shape error here would already have surfaced via the validation gate;
      // treat an unexpected re-parse failure conservatively as pushable-as-is.
    }
    if (usesInclude) {
      reasons.push(`${def.name}: uses include:, not hub-pushable yet`);
      continue;
    }
    let hash: string;
    try {
      hash = hashDefForHub(yaml);
    } catch (e) {
      if (e instanceof DefError && /bodyFile/.test(e.message)) {
        reasons.push(`${def.name}: uses bodyFile:, not hub-pushable`);
        continue;
      }
      throw e;
    }
    candidates.push({ name: def.name, hash, yaml });
  }

  if (reasons.length > 0) {
    throw new CliError(
      `refusing to push — ${reasons.length} problem(s) found; nothing sent:\n  - ${reasons.join('\n  - ')}`,
    );
  }

  // Fetch the server's own list once — the diff source of truth. Always
  // fetched, even under --force, so the new/changed labels stay accurate.
  const { res: listRes, cred: listCred } = await authedGet(io, origin, cred, '/api/workflows');
  assertAuthOk(listRes, listCred, origin);
  cred = listCred;
  let serverMap: Map<string, ReturnType<typeof parseWorkflowList> extends Map<string, infer V> ? V : never>;
  try {
    serverMap = parseWorkflowList(await listRes.json());
  } catch (e) {
    throw new CliError((e as Error).message);
  }

  const { toPush, unchanged } = computeServerDiff(candidates, serverMap, force);

  // Diff-style human lines go to stderr so stdout stays machine-parseable JSON.
  for (const c of unchanged) io.err(`= ${c.name} (unchanged)`);

  if (dryRun) {
    for (const c of toPush) {
      io.err(c.status === 'new' ? `+ ${c.name} (new)` : `~ ${c.name} (changed)`);
    }
    print(io, {
      ok: true,
      dryRun: true,
      hub: origin,
      new: toPush.filter((c) => c.status === 'new').map((c) => c.name),
      changed: toPush.filter((c) => c.status === 'changed').map((c) => c.name),
      unchanged: unchanged.map((c) => c.name),
      wouldPush: toPush.map((c) => c.name),
    });
    return 0;
  }

  // Refresh an expiring oauth token once up front (per-request 401 refresh below covers mid-batch expiry).
  cred = await ensureFreshOAuth(io, origin, cred);

  const pushedNames: string[] = [];
  const noopNames: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const skipped: string[] = [];

  for (let i = 0; i < toPush.length; i++) {
    const c = toPush[i]!;
    const label = c.status === 'new' ? '+' : '~';
    try {
      let res = await createWorkflowRequest(io, origin, cred, c.yaml);
      if (res.status === 401 && cred.kind === 'oauth') {
        cred = await refreshOAuth(io, origin, cred as Extract<Credential, { kind: 'oauth' }>);
        res = await createWorkflowRequest(io, origin, cred, c.yaml);
      }
      if (res.status === 401) {
        if (cred.kind === 'agent') {
          throw new CliError('token revoked or invalid — re-mint it in the console or run `owenloop login`');
        }
        throw new CliError('credential rejected by the hub — run `owenloop login`');
      }
      if (res.status === 413) throw new CliError('workflow yaml exceeds the hub 32MB request cap');
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        throw new RateLimitError(`rate limited by the hub${retryAfter ? ` (retry after ${retryAfter})` : ''}`);
      }
      if (!res.ok) throw new CliError(`hub returned HTTP ${res.status}`);

      const bodyJson: unknown = await res.json();
      const errText = createWorkflowError(bodyJson);
      if (errText !== null) throw new CliError(`hub rejected the def: ${errText}`);

      const okBody = asCreateWorkflowOk(bodyJson, c.name);
      if (okBody.unchanged) {
        noopNames.push(c.name);
        io.err(`= ${c.name} (server: unchanged, v${okBody.version})`);
      } else {
        pushedNames.push(c.name);
        io.err(`${label} ${c.name} (→ v${okBody.version})`);
      }
    } catch (e) {
      // A 429 halts the whole batch immediately (REL-10): record this def as
      // failed, then stop — the not-yet-attempted remainder is reported as
      // `skipped`, not silently hammered against a rate-limited server.
      // Handled before the generic path because RateLimitError extends CliError.
      if (e instanceof RateLimitError) {
        const msg = e.message;
        failed.push({ name: c.name, error: msg });
        io.err(`! ${c.name} (failed: ${msg})`);
        const remainder = toPush.slice(i + 1).map((r) => r.name);
        skipped.push(...remainder);
        if (remainder.length > 0) {
          io.err(`stopping — rate limited by the hub; ${remainder.length} def(s) not attempted`);
        }
        break;
      }
      // A hard auth error aborts the whole run (re-throw); a per-def server
      // failure is recorded and the batch continues (already-pushed defs stand).
      if (e instanceof CliError && /run `owenloop login`|re-mint it/.test(e.message)) {
        throw e;
      }
      const msg = (e as Error).message;
      failed.push({ name: c.name, error: msg });
      io.err(`! ${c.name} (failed: ${msg})`);
    }
  }

  print(io, {
    ok: failed.length === 0,
    hub: origin,
    pushed: pushedNames,
    noop: noopNames,
    unchanged: unchanged.map((c) => c.name),
    skipped,
    failed,
  });
  return failed.length === 0 ? 0 : 1;
}

function createWorkflowRequest(
  io: CliIO,
  origin: string,
  cred: Credential,
  yaml: string,
): Promise<Response> {
  return hubFetch(io, resolveEndpoint(origin, '/api/create_workflow'), {
    method: 'POST',
    headers: {
      Authorization: authHeader(cred),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ yaml }),
  });
}

/**
 * Async entry point that adds network I/O for `add` and the hub commands on top
 * of the otherwise fully-synchronous engine/CLI (see the doc comment on
 * `sleepMs` above and README "sync end to end"). `main`/`dispatch` stay sync and
 * unchanged — this wraps them, routing only the network-touching verbs through
 * the async path, so every existing command and test keeps working exactly as
 * before.
 */
const ASYNC_COMMANDS = new Set(['add', 'login', 'logout', 'connect', 'push']);

export async function mainAsync(argv: string[], io: CliIO = defaultIO()): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positionals[0];
  if (command === undefined || !ASYNC_COMMANDS.has(command)) {
    return main(argv, io);
  }
  try {
    switch (command) {
      case 'add':
        return await dispatchAdd(io, args);
      case 'login':
        return await dispatchLogin(io, args);
      case 'logout':
        return await dispatchLogout(io, args);
      case 'connect':
        return await dispatchConnect(io, args);
      case 'push':
        return await dispatchPush(io, args);
      default:
        return main(argv, io); // unreachable — ASYNC_COMMANDS guards the switch
    }
  } catch (e) {
    if (e instanceof CliError || e instanceof DefError) {
      io.err(`error: ${e.message}`);
    } else {
      io.err(`error: ${(e as Error).message}`);
    }
    return 1;
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
