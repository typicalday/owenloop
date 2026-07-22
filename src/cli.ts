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
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseYaml } from 'yaml';
import { Engine } from './engine.ts';
import { buildGraph, buildTrace, graphToDot, graphToMermaid, modelCheck } from './model.ts';
import { openStore } from './store.ts';
import type { ArtifactRow, Store, WorkflowRow } from './store.ts';
import {
  buildDef,
  DefError,
  finalizeDefs,
  lintDef,
  loadDefs,
  loadDefsRaw,
  loadDefsUnfinalized,
  validateDef,
} from './defs.ts';
import type { DefLoadFailure } from './defs.ts';
import type { WorkflowDef } from './types.ts';
import { CliError, dbPathRefusingSymlink, detId, mkdirRefusingSymlink, nowMs, parseDurationMs, randId } from './util.ts';
import {
  authHeader,
  deleteCredential,
  discoverMetadata,
  ensureFreshOAuth,
  hubFetch,
  hubMaxResponseBytes,
  mintAgentCredential,
  readBodyBounded,
  refreshOAuth,
  storeCredential,
} from './credentials.ts';
import { runMcpCommand } from './mcp/serve.ts';
import type { LineStream } from './mcp/server.ts';
import { DEFAULT_TAR_LIMITS, extractTarGz } from './untar.ts';
import {
  acquireInstallLock,
  ADD_JOURNAL_FILENAME,
  archivePathViolation,
  commitInstall,
  finalizeInstallCommit,
  githubShaUrl,
  githubTarballUrl,
  installFolder,
  parkOldNameDir,
  parseRepoSpec,
  readLockfile,
  recoverInterruptedInstall,
  type RecoveryOutcome,
  releaseInstallLock,
  removeAddJournal,
  rollbackInstallCommit,
  RollbackFailedError,
  stageFiles,
  STAGING_DIRNAME,
  writeAddJournal,
  writeLockfile,
} from './add.ts';
import type { AddJournal, InstalledEntry, InstallCommitHandle, Lockfile } from './add.ts';
import {
  asCreateWorkflowOk,
  asWhoami,
  computeServerDiff,
  credentialBackend,
  createWorkflowError,
  credentialFilePath,
  credentialSlot,
  externalCredentialCommand,
  hashDefForHub,
  hubBindingPath,
  keychainServiceFor,
  listStoredHubOrigins,
  normalizeOrigin,
  parseWorkflowList,
  pkcePair,
  randomState,
  readCredentialFile,
  readHubBinding,
  readStoredCredential,
  resolveEndpoint,
  resolveKeychain,
  writeCredentialFile,
  writeHubBinding,
} from './hub.ts';
import type {
  Credential,
  CredentialSlotSelector,
  DefPushCandidate,
  HubBinding,
  Keychain,
  WhoamiIdentity,
} from './hub.ts';

// Re-export the keychain backend type so existing test imports of `Keychain`
// from `../src/cli.ts` (test/hubkit.ts, test/login.test.ts) keep resolving —
// the type is now homed in hub.ts (cli → hub is boundary-legal).
export type { Keychain } from './hub.ts';

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
  /**
   * The newline-delimited transport `owenloop mcp` pumps JSON-RPC frames from.
   * Injectable for hermetic tests (a `PassThrough`); `undefined` here so the
   * command falls back to `process.stdin`. Only the `mcp` verb reads it.
   */
  stdinStream?: LineStream;
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
  // `add --recover` takes NO value: `add --recover acme/widgets` must keep
  // `acme/widgets` as a positional so the recover branch can refuse it, rather
  // than binding it as `--recover`'s value and silently dropping it.
  'recover',
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

/**
 * Load the DEFAULT def set, folding in the defs `owenloop add` installed under
 * ledger-recorded subfolders of `defsDir` so `defs`/`create`/`tick`/etc. see
 * them by name with NO `--defs` flag. Called ONLY when the operator did not
 * override the defs dir (see {@link openCtx}) — an explicit `--defs`/`OWENLOOP_DEFS`
 * targets a specific literal dir and keeps today's pure-scan behavior, including
 * `--defs workflows/<owner>-<repo>-<hash>` pointed straight at an install folder.
 *
 * The composition is ledger-DRIVEN and BOUNDED: it only folds in folders named
 * by fail-closed-validated `installed.json` entries (never a raw tree recurse),
 * and it stays in the CLI layer (where both cwd and defsDir are known) so
 * `loadDefs`/`loadDefsUnfinalized` in defs.ts hold no ledger knowledge.
 *
 * Two-phase discipline: it merges the RAW (unfinalized) maps of the base dir and
 * each install folder, then runs ONE `finalizeDefs` over the union. That single
 * finalize is what lets a project-local def `calls:` an installed def across the
 * boundary — finalizing each dir independently would throw "does not exist"
 * before the merge. When the ledger is empty/missing the result is exactly
 * `finalizeDefs(loadDefsUnfinalized(defsDir))` === today's `loadDefs(defsDir)`:
 * zero behavior drift on the no-installs path.
 *
 * Precedence: project-local (base) defs WIN over installed defs; among installed
 * entries, ledger sources are iterated in sorted order and the FIRST-loaded def
 * with a given name wins. Every shadowed def is surfaced as a warning on stderr,
 * never a silent clobber. Note the outer base scan ALREADY loads an install
 * folder's `workflow.yaml` via its immediate-subdir rule, while the fold-in
 * loads that folder's top-level `*.yaml` (excluding `workflow.yaml`) — the two
 * scans are disjoint per file, so no file is ever loaded twice and any name
 * collision is a genuine two-file collision.
 *
 * Fail-OPEN: the fold-in never breaks base loading. A corrupt/invalid ledger, a
 * missing install folder, or an install folder that fails to load each emits a
 * warning on stderr and is skipped; base defs still load. (The add-time
 * fail-closed validation in add.ts is untouched — we consume `readLockfile`,
 * discovery merely refuses to act on a bad ledger rather than crashing.)
 */
function loadDefsWithInstalled(io: CliIO, defsDir: string): Map<string, WorkflowDef> {
  const merged = existsSync(defsDir) ? loadDefsUnfinalized(defsDir) : new Map<string, WorkflowDef>();

  let lf: Lockfile;
  try {
    lf = readLockfile(join(io.cwd, '.owenloop', 'installed.json'));
  } catch (e) {
    io.err(`warning: skipping installed workflow defs: ${(e as Error).message}`);
    return finalizeDefs(merged);
  }

  for (const source of Object.keys(lf.installed).sort()) {
    const entry = lf.installed[source];
    if (entry === undefined) continue; // unreachable — keys come from lf.installed
    const entryDir = join(defsDir, entry.path);
    if (!existsSync(entryDir)) {
      io.err(`warning: installed defs folder missing for ${source}: ${entry.path}`);
      continue;
    }
    let entryRaw: Map<string, WorkflowDef>;
    try {
      entryRaw = loadDefsUnfinalized(entryDir);
    } catch (e) {
      io.err(`warning: failed to load installed defs for ${source} (${entry.path}): ${(e as Error).message}`);
      continue;
    }
    for (const [name, def] of entryRaw) {
      const winner = merged.get(name);
      if (winner !== undefined) {
        io.err(
          `warning: workflow '${name}' from ${def.dir ?? entryDir} is shadowed by ${winner.dir ?? 'project defs'} (project defs take precedence over installed defs)`,
        );
        continue;
      }
      merged.set(name, def);
    }
  }

  return finalizeDefs(merged);
}

function openCtx(io: CliIO, args: Args): Ctx {
  const dbOverride = last(args, 'db') ?? io.env.OWENLOOP_DB;
  const dbPath = dbOverride ?? join(io.cwd, '.owenloop', 'state.db');
  // An explicit `--defs`/`OWENLOOP_DEFS` is the operator targeting a literal dir
  // (keep pure-scan behavior, no ledger fold-in); its ABSENCE means the default
  // dir, where `add` installs and the ledger's folders live — fold installed
  // defs in there. The rule is "was an override given", not path equality: even
  // `OWENLOOP_DEFS=<cwd>/workflows` counts as an override and stays literal.
  const defsOverride = last(args, 'defs') ?? io.env.OWENLOOP_DEFS;
  const defsDir = defsOverride ?? join(io.cwd, 'workflows');
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
  const defs =
    defsOverride !== undefined
      ? existsSync(defsDir)
        ? loadDefs(defsDir)
        : new Map<string, WorkflowDef>()
      : loadDefsWithInstalled(io, defsDir);
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

export const USAGE = `owenloop — a dataflow workflow engine

Usage: owenloop <command> [args] [--db <path>] [--defs <dir>]

Commands:
  defs                                   list available workflow definitions
  add <owner>/<repo>[@ref]               fetch, validate, and install a repo's workflow defs (public repos)
  add --recover                          finish or undo a crash-interrupted install (offline; no network)
  login [--hub <url>] [--with-token] [--as <slot>]   authenticate the CLI against a hub, verified via whoami (loopback OAuth, or --with-token from stdin)
  logout [--hub <url>] [--as <slot>]     delete the stored credential for a hub in one slot
  connect [--hub <url>] [--as <slot>]    bind this project to a hub and verify the stored credential (whoami)
  push [<defName>...] [--force] [--dry-run] [--as <slot>]   publish local workflow defs to the bound hub (server-diffed, idempotent)
                                         --as names the credential slot: human (default), agent, or agent:<account>
  agent new <name> [--pools <a,b>] [--hub <url>]   mint a new agent identity on the hub and store its token in slot agent:<name> (the token is never printed)
  mcp [--hub <url>]                       serve the hub control plane over stdio MCP (spawned by MCP hosts, not run by humans)
  lint [<def-name>]                      check def(s) for wiring problems
  check <def> [--format text|json] [--max-depth N] [--max-states N] [--max-collection N] [--assume-provided]
                                         bounded reachability check (stall states, true deadlocks, stuck, dead steps, declared invariants)
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

/**
 * Options accepted on EVERY command. docs/cli.md documents `--db`/`--defs` as
 * global ("pass both on every command"), so they are allowlisted everywhere —
 * even on commands that ignore them — to avoid rejecting a documented
 * invocation.
 */
const GLOBAL_OPTIONS = ['db', 'defs'] as const;

/** Build a command's option allowlist: the two globals plus its own long-form flags. */
const cmdOpts = (...extra: string[]): ReadonlySet<string> => new Set<string>([...GLOBAL_OPTIONS, ...extra]);

/**
 * Single source of truth for the `--options` each command accepts, consulted by
 * `preflight` before any side effect. Unknown-OPTION rejection AND
 * unknown-COMMAND detection both derive from this table: a developer who adds a
 * new `dispatch`/`ASYNC_COMMANDS` case without a matching entry here gets
 * `unknown command` on the very first invocation, so the command cannot run
 * until its flags are declared. That is the forcing function that stops the
 * silently-dropped-flag hole (a misspelled `push --dryrn` doing a real push)
 * from reappearing — keep this table in lockstep with the dispatch verbs and
 * the USAGE string. All names are long-form: this CLI has no short options
 * (`-h` reaches dispatch as a positional). Values are audited against every
 * `last/all/flag/needOpt/numOpt` call site.
 */
export const COMMAND_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ['help', cmdOpts()],
  ['defs', cmdOpts()],
  ['add', cmdOpts('recover')],
  ['login', cmdOpts('hub', 'with-token', 'as')],
  ['logout', cmdOpts('hub', 'as')],
  ['connect', cmdOpts('hub', 'as')],
  ['push', cmdOpts('dry-run', 'force', 'hub', 'as')],
  ['agent', cmdOpts('pools', 'hub')],
  ['mcp', cmdOpts('hub')],
  ['lint', cmdOpts()],
  ['check', cmdOpts('format', 'max-depth', 'max-states', 'max-collection', 'assume-provided')],
  ['create', cmdOpts('title', 'provide', 'param')],
  ['provide', cmdOpts('value')],
  ['adopt', cmdOpts()],
  ['tick', cmdOpts('now', 'shallow', 'label')],
  ['reap', cmdOpts('now')],
  ['status', cmdOpts('all')],
  ['wait', cmdOpts('until', 'timeout')],
  ['show', cmdOpts()],
  ['trace', cmdOpts('format')],
  ['runs', cmdOpts('open')],
  ['order', cmdOpts()],
  ['list', cmdOpts()],
  ['green', cmdOpts('value', 'terminal')],
  ['emit', cmdOpts('items')],
  ['seal', cmdOpts('value')],
  ['reject', cmdOpts('by', 'text')],
  ['retract', cmdOpts('by', 'text')],
  ['skip', cmdOpts('by', 'text')],
  ['retry', cmdOpts('by', 'text')],
  ['close', cmdOpts('outcome', 'summary')],
  ['heartbeat', cmdOpts('now')],
  ['delete', cmdOpts('recursive')],
  ['graph', cmdOpts('format')],
]);

/** Levenshtein edit distance (small DP, no deps) — used only for "did you mean" hints. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (prev[j] as number) + 1;
      const ins = (curr[j - 1] as number) + 1;
      const sub = (prev[j - 1] as number) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] as number;
}

/**
 * Reject any `--option` the target command does not declare in
 * `COMMAND_OPTIONS`. Names each offender with its `--` prefix, suggests the
 * nearest valid option (edit distance ≤ 2), and lists the command's valid
 * options. Throws `CliError` (exit 1 via the entry-point catch). Runs BEFORE
 * any side effect — see `preflight`.
 */
function assertKnownOptions(command: string, args: Args): void {
  const allowed = COMMAND_OPTIONS.get(command);
  if (!allowed) return; // unknown command is handled separately (in preflight)
  const unknown = [...args.options.keys()].filter((k) => !allowed.has(k));
  if (unknown.length === 0) return;
  const lines = unknown.map((k) => {
    const base = `unknown option --${k} for '${command}'`;
    const near =
      k.length > 0
        ? [...allowed]
            .map((o) => ({ o, d: editDistance(k, o) }))
            .filter((c) => c.d <= 2)
            .sort((a, b) => a.d - b.d)[0]
        : undefined;
    return near ? `${base} (did you mean --${near.o}?)` : base;
  });
  const validSorted = [...allowed].map((o) => `--${o}`).sort();
  throw new CliError(`${lines.join('\n')}\nvalid options for '${command}': ${validSorted.join(', ')}`);
}

/**
 * Pre-dispatch guard shared by both entry points (`main` and `mainAsync`) so
 * the sync and async paths cannot drift. In order: the help escape hatch
 * (`help`/`--help`/`-h`, or `--help` given anywhere e.g. `push --help`) prints
 * usage and short-circuits with exit 0; an unrecognized command throws the same
 * `unknown command` error dispatch's `default:` produces (but now before
 * `openCtx`, so it no longer creates `.owenloop/state.db`); then unknown
 * options are rejected. All of this runs ahead of any filesystem, keychain, or
 * network I/O. Returns an exit code to short-circuit on, or `undefined` to
 * proceed to dispatch. `command` is always defined here — callers own the
 * no-command usage branch.
 */
function preflight(command: string, args: Args, io: CliIO): number | undefined {
  if (command === 'help' || command === '--help' || command === '-h' || args.options.has('help')) {
    io.out(USAGE);
    return 0;
  }
  if (!COMMAND_OPTIONS.has(command)) {
    throw new CliError(`unknown command: ${command}\n\n${USAGE}`);
  }
  assertKnownOptions(command, args);
  return undefined;
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
      const clean = report.deadlocks.length === 0
        && report.invariantViolations.length === 0 && report.structurallyDeadSteps.length === 0;
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
      if (report.stallStates.length > 0) {
        io.out('');
        io.out(`Stall states (expected — maxAttempts / human-escalation brakes) (${report.stallStates.length}):`);
        for (const s of report.stallStates) {
          io.out(`  path: ${s.path.map((p) => `${p.step}/${p.outcome}`).join(' -> ') || '(initial state)'}`);
        }
      }
      if (report.deadlocks.length > 0) {
        io.out('');
        io.out(`True deadlocks (no path to completion at unlimited attempts) (${report.deadlocks.length}):`);
        for (const d of report.deadlocks) {
          io.out(`  path: ${d.path.map((s) => `${s.step}/${s.outcome}`).join(' -> ') || '(initial state)'}`);
        }
      }
      if (report.stuck.length > 0) {
        io.out('');
        io.out(`Stuck states (brake tripped; other branches still moving — informational) (${report.stuck.length}):`);
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
      if (report.structurallyDeadSteps.length > 0) {
        io.out('');
        io.out(`Structurally dead steps (can never fire — wiring defect): ${report.structurallyDeadSteps.join(', ')}`);
      }
      if (report.unreachedSteps.length > 0) {
        io.out('');
        io.out(`Unreached within bounds (raise --max-states/--max-depth): ${report.unreachedSteps.join(', ')}`);
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
    //   fabrications. Contrast true deadlocks, where the maxCollectionSize cap can
    //   manufacture a spurious "no moves" state — hence that requires !bounded.
    //   Do NOT remove this asymmetry; it encodes a real soundness distinction.
    // - structurally-dead steps → ALWAYS nonzero, regardless of bounded. Unlike
    //   true deadlocks (found by the bounded BFS, so a tighter maxCollectionSize
    //   can manufacture a spurious one), structurally-dead is a STATIC canEverFire
    //   finding that needs no search bounds at all — it is sound and bounds-
    //   independent by construction (model.ts's canEverFire only ever returns
    //   false when certain), so it belongs with invariant violations, not with
    //   true deadlocks. unreachedSteps (the other dead-step bucket) must NEVER
    //   affect the exit code — it is purely a bounds artifact.
    // - definite (true) deadlock only when EXHAUSTIVE (!bounded) → nonzero
    // - stall states and stuck states are by-design brakes and NEVER affect the
    //   exit code — a stall state (report.stallStates) is EXPECTED (a human-
    //   escalation brake whose freeze, once lifted, re-arms a producer), and a
    //   stuck state (report.stuck) is purely informational (a brake tripped on
    //   one branch while the line still moves on another). Neither is a defect.
    // - truncated with no invariant violations / structurally-dead steps / true
    //   deadlocks → 0
    const hasDefiniteDefect =
      report.invariantViolations.length > 0 ||
      report.structurallyDeadSteps.length > 0 ||
      (!report.bounded && report.deadlocks.length > 0);
    if (hasDefiniteDefect) {
      throw new CliError(
        `definite defects found (${report.invariantViolations.length} invariant violation(s), ` +
        `${report.structurallyDeadSteps.length} structurally dead step(s), ` +
        `${report.deadlocks.length} true deadlock(s))`,
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
 * Cap on the `add` tarball download body, enforced DURING the stream by
 * `readBodyBounded` — defense in depth with `extractTarGz`'s own post-hoc
 * `maxCompressedBytes` check (kept intact). `OWENLOOP_TARBALL_MAX_BYTES`
 * overrides it (a test-only knob, validated `Number.isFinite && > 0`,
 * consistent with the project's other `OWENLOOP_*` knobs) so a mid-stream test
 * need not buffer the real 256 MiB cap in CI.
 */
function tarballMaxBytes(io: CliIO): number {
  const override = Number(io.env.OWENLOOP_TARBALL_MAX_BYTES);
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_TAR_LIMITS.maxCompressedBytes;
}

/**
 * `owenloop add <owner>/<repo>[@ref]` — fetch a repo's `workflows/**`, validate
 * it, and install it under `<defsDir>/<installFolder(owner,repo)>`.
 *
 * The network fetch/extract/path-filter runs FIRST, unlocked (a tarball can
 * take minutes and holding a lock that long would needlessly serialize
 * unrelated adds). Everything that touches project state then runs under the
 * per-project `.owenloop/add.lock`: crash-recovery pass → stale-staging cleanup
 * → lockfile read → ownership check → stage → strict validation → atomic commit
 * (backups retained) → journal write → lockfile write → journal advance →
 * finalize (backups discarded) → journal remove. Deciding ownership and reading
 * the lockfile INSIDE the lock is deliberate (TOCTOU discipline — see the
 * store-migration knowledge node). The install is staged on the destination
 * filesystem and swapped in with an atomic rename, but the displaced previous
 * install and any old-name dir are kept until the lockfile write succeeds — the
 * directory commit and the ledger write are one recoverable operation. Any
 * failure before the lockfile is durably written rolls the directory state back
 * and leaves the previous install and lockfile exactly as they were, with no
 * staging debris.
 *
 * A `.owenloop/add.journal` intent record closes the crash-recovery gap the
 * in-process rollback arms can't: it is written (phase `applying`) right before
 * the destructive `commitInstall`, advanced (phase `finalizing`) right after the
 * durable ledger write, and removed on clean completion. A process killed
 * mid-install leaves the journal behind; the NEXT add runs
 * `recoverInterruptedInstall` FIRST inside the lock — before the stale-staging
 * clear, since the backups a rollback needs live under the staging root — to
 * roll the interrupted install forward (past the commit point) or back (before
 * it) to a consistent (defs ⇔ ledger) state. The journal is attacker-
 * influenceable input, validated fail-closed with the same A1 discipline as the
 * lockfile; a bad/mismatched/contradictory journal REFUSES with no fs mutation
 * (and, via `preserveStagingRoot`, without the `finally` clearing the evidence).
 */
async function dispatchAdd(io: CliIO, args: Args): Promise<number> {
  // Offline crash-recovery branch. This sits at the VERY TOP — before `need`/
  // `parseRepoSpec` and before either network fetch — so `--recover` is
  // structurally incapable of reaching the SHA/tarball fetches. A machine that
  // crashed mid-install and is now offline can finish or undo the interrupted
  // install with no network (recovery is purely local filesystem work).
  if (flag(args, 'recover')) return dispatchAddRecover(io, args);
  const spec = need(args, 1, 'owner/repo[@ref]');
  const { owner, repo, ref } = parseRepoSpec(spec);
  const source = `${owner}/${repo}`;
  const defsOverride = last(args, 'defs') ?? io.env.OWENLOOP_DEFS;
  const defsDir = defsOverride ?? join(io.cwd, 'workflows');
  const lockfilePath = join(io.cwd, '.owenloop', 'installed.json');
  const installLockPath = join(io.cwd, '.owenloop', 'add.lock');
  const journalPath = join(io.cwd, '.owenloop', ADD_JOURNAL_FILENAME);
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
  const shaBytes = await readBodyBounded(shaRes, hubMaxResponseBytes(io), `sha resolution for ${source}@${ref}`);
  const shaBody = new TextDecoder().decode(shaBytes).trim();
  if (!/^[0-9a-f]{40}$/i.test(shaBody)) {
    throw new CliError(`unexpected response resolving ${source}@${ref}: expected a 40-char commit sha, got "${shaBody}"`);
  }
  const sha = shaBody;

  // 2. Fetch the tarball for that pinned sha. The timeout must cover the body
  //    read too — undici ties the abort signal to the body stream — so the
  //    fetch AND the bounded read live in the same try. readBodyBounded caps the
  //    download DURING the stream (cancelling at the cap), so an oversized
  //    tarball is never fully allocated; extractTarGz still re-checks the size
  //    post-hoc (defense in depth).
  let bytes: Uint8Array;
  try {
    const tarRes = await fetchFn(githubTarballUrl(owner, repo, sha), {
      headers: { 'User-Agent': 'owenloop' },
      signal: AbortSignal.timeout(ADD_TARBALL_TIMEOUT_MS),
    });
    if (!tarRes.ok) {
      throw new CliError(`could not fetch tarball for ${source}@${sha}: GitHub returned ${tarRes.status}`);
    }
    bytes = await readBodyBounded(tarRes, tarballMaxBytes(io), `tarball for ${source}@${sha}`);
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
  const stagingId = randId('stg');
  const stagingDir = join(stagingRoot, stagingId);
  // SEC-3, add's half: refuse a symlinked project `.owenloop` (the parent of
  // add.lock and installed.json — always cwd-derived in add, no override
  // exists) and a symlinked DEFAULT defs dir before any state write. Both must
  // precede acquireInstallLock: `.owenloop` is written by the lock acquire and
  // the ledger; defsDir is DELETED-through by the stale-staging rmSync below and
  // then written by staging/commit. An explicit --defs/OWENLOOP_DEFS is operator
  // intent, not repo content — deliberately installing through a symlink keeps
  // today's behavior, matching the --db/OWENLOOP_DB rule.
  mkdirRefusingSymlink(join(io.cwd, '.owenloop'));
  if (defsOverride === undefined) mkdirRefusingSymlink(defsDir);
  const lock = await acquireInstallLock(installLockPath);
  // Set true only on a rollback double-fault, where the ONLY copy of the
  // previous content ends up parked under the staging root — then the `finally`
  // must NOT delete it (the error message tells the user to recover it).
  let preserveStagingRoot = false;
  try {
    // Recover a crash-interrupted prior install FIRST — before the stale-staging
    // clear, since the backups/parked dirs a rollback needs live UNDER the
    // staging root, so clearing it first would destroy them. Any refusal (bad or
    // mismatched or contradictory journal) must preserve the staging root and the
    // journal as evidence: without this, the `finally` below would rmSync the
    // staging root and take the backups a later recovery needs with it.
    try {
      recoverInterruptedInstall({ defsDir, journalPath, lockfilePath });
    } catch (e) {
      preserveStagingRoot = true;
      throw e;
    }

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
        (!report.bounded && report.deadlocks.length > 0);
      if (hasDefiniteDefect) {
        reasons.push(
          `${stagedDef.name}: definite defects found (${report.invariantViolations.length} invariant violation(s), ` +
            `${report.deadlocks.length} true deadlock(s))`,
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
    //
    // Write the crash-recovery journal (phase `applying`) BEFORE the first
    // destructive step. `hadDest` is captured here, under the lock, right before
    // commitInstall reads the same fact — so recovery knows whether a backup dir
    // will exist. A migration off the old `<owner>-<repo>` name records that
    // path so recovery can restore the parked old-name dir. If the process is
    // killed anywhere past this point, the next add's recovery pass uses this
    // record to roll forward or back.
    const migratingOldName = existing !== undefined && existing.path !== folder;
    const journalBase: AddJournal = {
      version: 1,
      phase: 'applying',
      source,
      sha,
      folder,
      stagingId,
      hadDest: existsSync(dest),
      ...(migratingOldName ? { oldNamePath: existing.path } : {}),
      defsDir: resolve(defsDir),
      ref,
      startedAt: nowMs(),
    };
    writeAddJournal(journalPath, journalBase);

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
          // Double fault: parking the old dir failed AND rolling the committed
          // swap back failed. Nothing of value sits under the staging root here —
          // the staging dir was consumed by the swap, and this migration branch
          // never has a backup (`dest` cannot pre-exist; see the ownership refusal
          // above). The old-name dir was never moved (the park is a single atomic
          // rename recorded only on success) so it stays intact at its original
          // path, and the stranded item is the NEW content still at `dest`. LEAVE
          // the journal (phase `applying`) so the next add's recovery rolls the
          // swap back (case (c): discards `dest`) before anything clears the
          // staging root, mirroring the lockfile-write double fault below.
          preserveStagingRoot = true;
          throw new CliError(
            `could not migrate ${source} off old-name directory '${existing.path}' (${(e as Error).message}) ` +
              `and rolling the install back failed too (${(rollbackErr as Error).message}); ` +
              `the old-name directory was never moved and is intact at ${join(defsDir, existing.path)}, ` +
              `and the newly installed content is stranded at ${dest} — ` +
              `the next owenloop add will recover automatically (discarding the stranded content and leaving the previous install in place)`,
          );
        }
        // Directory state restored in-process — nothing left to recover, so drop
        // the journal before surfacing the (single-fault) failure.
        removeAddJournal(journalPath);
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
        // preserve it past the `finally` and LEAVE the journal (phase
        // `applying`, ledger not committed) so the next add's recovery restores
        // the previous state before anything clears the staging root.
        preserveStagingRoot = true;
        throw new CliError(
          `could not record install of ${source} in ${lockfilePath} (${(e as Error).message}) ` +
            `and rolling the install back failed too (${(rollbackErr as Error).message}); ` +
            `previous content preserved under ${stagingRoot} — recover it before running add again ` +
            `(the next owenloop add will attempt recovery automatically; leaving it, that dir is cleared as debris)`,
        );
      }
      // Directory state restored in-process — drop the journal before surfacing
      // the (single-fault) failure.
      removeAddJournal(journalPath);
      throw new CliError(
        `could not record install of ${source} in ${lockfilePath}: ${(e as Error).message} — ` +
          `install rolled back, previous state restored`,
      );
    }
    // The ledger write is the durable commit point: past here a crash rolls
    // FORWARD. Record that in the journal (phase `finalizing`) so recovery
    // finishes the install rather than tearing it down, then finalize and drop
    // the journal now that there is nothing left to recover.
    writeAddJournal(journalPath, { ...journalBase, phase: 'finalizing' });
    finalizeInstallCommit(handle);
    removeAddJournal(journalPath);

    // 7. Report.
    print(io, {
      ok: true,
      source,
      ref,
      sha,
      path: folder,
      installed: written.length,
      defs: [...staged.values()].map((d) => d.name).sort(),
      hint: `installed workflows are now discoverable by default — run e.g. \`owenloop create ${
        [...staged.values()].map((d) => d.name).sort()[0] ?? '<def-name>'
      }\` with no --defs flag; for an explicit --defs, point it at ${folder}`,
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

/**
 * `owenloop add --recover`: an OFFLINE, network-free entry point to the same
 * `recoverInterruptedInstall` the normal add path runs inline. `dispatchAdd`
 * branches here at its very top, before `parseRepoSpec` and before the SHA and
 * tarball fetches — so this path can never touch the network. The normal add
 * path already runs recovery inline (belt-and-suspenders); this exists only so a
 * machine that crashed mid-install and is now offline can finish/undo the
 * interrupted install without waiting for the network to return.
 *
 * The lock scope here is recovery-ONLY: acquire `.owenloop/add.lock`, run
 * recovery, release. There is no fetch to keep outside the lock (the reason the
 * normal path acquires the lock only after the download), so the whole
 * short local operation runs under it. No `--db`/store open — recovery never
 * reads the store. Refusals (bad/mismatched/contradictory journal) throw and
 * propagate to `mainAsync`'s catch as `error: ...`, exit 1, mutating nothing —
 * and unlike the inline path there is no `preserveStagingRoot` dance, because
 * this path never rmSyncs the staging root itself, so a refusal naturally leaves
 * the journal, staging root, and dest untouched as evidence.
 */
async function dispatchAddRecover(io: CliIO, args: Args): Promise<number> {
  // With --recover the owner/repo positional is optional; a supplied spec is
  // ambiguous ("recover then install"?), so refuse rather than guess — the
  // normal add path runs recovery inline anyway, so "recover then install" is
  // just `owenloop add owner/repo`.
  if (args.positionals[1] !== undefined) {
    throw new CliError('--recover takes no repository argument — run recovery alone, then re-run add');
  }

  // Resolve paths EXACTLY as dispatchAdd does — same defsDir/lock/journal
  // derivation — so recovery acts on the same tree a real add would. No fetch
  // reference, no store open.
  const defsOverride = last(args, 'defs') ?? io.env.OWENLOOP_DEFS;
  const defsDir = defsOverride ?? join(io.cwd, 'workflows');
  const lockfilePath = join(io.cwd, '.owenloop', 'installed.json');
  const installLockPath = join(io.cwd, '.owenloop', 'add.lock');
  const journalPath = join(io.cwd, '.owenloop', ADD_JOURNAL_FILENAME);

  // Mirror the SEC-3 symlink guards from the normal path (same order, same
  // rationale): `.owenloop` is written by the lock acquire; the default defsDir
  // is mutated-through by recovery. An explicit --defs/OWENLOOP_DEFS is operator
  // intent, not repo content, so it is not symlink-guarded (matching dispatchAdd).
  mkdirRefusingSymlink(join(io.cwd, '.owenloop'));
  if (defsOverride === undefined) mkdirRefusingSymlink(defsDir);

  const lock = await acquireInstallLock(installLockPath);
  let outcome: RecoveryOutcome;
  try {
    outcome = recoverInterruptedInstall({ defsDir, journalPath, lockfilePath });
  } finally {
    releaseInstallLock(lock);
  }

  switch (outcome) {
    case 'no-journal':
      print(io, { ok: true, recovered: false, message: 'nothing to recover — no interrupted install found' });
      return 0;
    case 'rolled-forward':
      print(io, {
        ok: true,
        recovered: true,
        outcome: 'rolled-forward',
        message: 'interrupted install completed (rolled forward)',
      });
      return 0;
    case 'rolled-back':
      print(io, {
        ok: true,
        recovered: true,
        outcome: 'rolled-back',
        message: 'interrupted install undone — previous state restored (or already consistent)',
      });
      return 0;
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

/**
 * Parse `--as <human | agent | agent:NAME>` into a `CredentialSlotSelector`.
 * Absent `--as` means the **human** slot — the everyday interactive case.
 * A malformed value (or an invalid account name, validated by `credentialSlot`)
 * is a usage error, never a silent coercion to some other slot.
 */
function resolveSlot(args: Args): CredentialSlotSelector {
  const raw = last(args, 'as');
  const sel = parseSlotArg(raw);
  // Validate eagerly so a bad account name fails before any network or store
  // access, with the same wording every later call site would produce.
  try {
    credentialSlot(sel);
  } catch (e) {
    throw new CliError(`--as: ${(e as Error).message}`);
  }
  return sel;
}

function parseSlotArg(raw: string | undefined): CredentialSlotSelector {
  if (raw === undefined) return { principal: 'human' };
  if (raw === 'human') return { principal: 'human' };
  if (raw === 'agent') return { principal: 'agent' };
  if (raw.startsWith('agent:')) return { principal: 'agent', account: raw.slice('agent:'.length) };
  throw new CliError(`--as: unrecognized slot '${raw}' — expected 'human', 'agent', or 'agent:<account>'`);
}

/**
 * The "nothing stored here" message for a read that missed. It names the SLOT,
 * not just the origin — a credential may well exist for this hub under another
 * principal, and the fix is `--as`, not another `login`.
 */
function emptySlotMessage(origin: string, slot: CredentialSlotSelector): string {
  const name = credentialSlot(slot);
  return `no stored credential for ${origin} in slot \`${name}\` — run \`owenloop login\` (or pass --as agent:<name>)`;
}

/**
 * Read the stored credential for `origin` in `slot`. Thin wrapper over the
 * shared `readStoredCredential` in `hub.ts` (the same implementation the public
 * package export uses), threading the CLI's injected `env`/`keychain`. Callers
 * pass a pre-normalized origin (`resolveHub` output); the wrapper's
 * normalization is idempotent, so CLI behavior is unchanged. REL-6 no-fallback
 * and corrupt-entry-as-absent semantics live in `hub.ts`.
 */
function readCredential(io: CliIO, origin: string, slot: CredentialSlotSelector): Credential | null {
  return readStoredCredential(origin, { ...slot, env: io.env, keychain: io.keychain });
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
  slot: CredentialSlotSelector,
  cred: Credential,
  path: string,
  persist = true,
): Promise<{ res: Response; cred: Credential }> {
  let current = await ensureFreshOAuth(io, origin, slot, cred, persist);
  let res = await hubFetch(io, resolveEndpoint(origin, path), {
    headers: { Authorization: authHeader(current), Accept: 'application/json' },
  });
  if (res.status === 401 && current.kind === 'oauth') {
    current = await refreshOAuth(io, origin, slot, current as Extract<Credential, { kind: 'oauth' }>, persist);
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
  slot: CredentialSlotSelector,
  cred: Credential,
  persist = true,
): Promise<{ cred: Credential; identity: WhoamiIdentity }> {
  const { res, cred: current } = await authedGet(io, origin, slot, cred, '/api/whoami', persist);
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
 *
 * The SLOT the credential lands in follows the credential KIND, with `--as`
 * naming the agent account: a human credential (loopback `oauth`, or a pasted
 * `mcpat_`) writes `human`; a pasted `olp_` agent token writes
 * `agent:<account>` (`default` unless `--as agent:NAME`). A `--as` that
 * contradicts the credential kind is a usage error, not a silent coercion —
 * that is what keeps the agent slot holding agent keys.
 *
 * Refused outright while an external credential command is configured: that
 * command, not the local store, is what every read consults, so there is nothing
 * for `login` to usefully write. The check is here — before the "did a
 * credential already exist?" probe, which would otherwise RUN the command and
 * report its failure instead of this far more actionable reason — with
 * `storeCredential`'s own throw kept as the invariant backstop for any other
 * write path.
 */
async function dispatchLogin(io: CliIO, args: Args): Promise<number> {
  const origin = resolveHub(io, args);
  const asked = resolveSlot(args);
  const asGiven = last(args, 'as') !== undefined;

  if (externalCredentialCommand(io.env) !== undefined) {
    throw new CliError(
      'an external credential command is configured (OWENLOOP_CREDENTIAL_COMMAND), so it — not the ' +
        'local store — supplies credentials for this hub; unset it to use `owenloop login`',
    );
  }

  if (flag(args, 'with-token')) {
    const readStdin = io.readStdin ?? defaultReadStdin;
    const token = (await readStdin()).trim();
    if (token === '') throw new CliError('no token on stdin (pipe the token in, e.g. `pbpaste | owenloop login --with-token`)');
    let cred: Credential;
    if (token.startsWith('olp_')) cred = { kind: 'agent', accessToken: token };
    else if (token.startsWith('mcpat_')) cred = { kind: 'oauth-pasted', accessToken: token };
    else throw new CliError('unrecognized token — expected an `olp_` agent token or an `mcpat_` access token');
    // Contradictions are usage errors, refused BEFORE any network call so
    // nothing is verified or stored under a slot the token does not belong in.
    if (cred.kind === 'agent' && asGiven && asked.principal === 'human') {
      throw new CliError(
        'an `olp_` agent token cannot be stored in the `human` slot — drop `--as human`, or pass `--as agent[:<account>]`',
      );
    }
    if (cred.kind !== 'agent' && asked.principal === 'agent') {
      throw new CliError(
        `a ${cred.kind} credential is a human credential and cannot be stored in the \`${credentialSlot(asked)}\` slot — drop \`--as\`, or paste an \`olp_\` agent token`,
      );
    }
    const slot: CredentialSlotSelector = cred.kind === 'agent' ? { principal: 'agent', ...(asked.principal === 'agent' && asked.account !== undefined ? { account: asked.account } : {}) } : { principal: 'human' };
    const existed = readCredential(io, origin, slot) !== null;
    const { identity } = await verifyCredential(io, origin, slot, cred); // never store an unverified token
    const storage = await storeCredential(io, origin, slot, cred);
    print(io, {
      ok: true,
      hub: origin,
      kind: cred.kind,
      slot: credentialSlot(slot),
      storage,
      replaced: existed,
      org: identity.orgName,
      orgId: identity.orgId,
      identity: identity.actor,
      ...(identity.email ? { email: identity.email } : {}),
    });
    return 0;
  }

  // Loopback OAuth always yields a HUMAN credential — `--as agent*` on this
  // flow is a contradiction, refused before the browser is opened.
  if (asked.principal === 'agent') {
    throw new CliError(
      `the loopback OAuth login produces a human credential and cannot be stored in the \`${credentialSlot(asked)}\` slot — drop \`--as\`, or use \`login --with-token\` with an \`olp_\` agent token`,
    );
  }
  const slot: CredentialSlotSelector = { principal: 'human' };
  const existed = readCredential(io, origin, slot) !== null;

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
    const { cred, identity } = await verifyCredential(io, origin, slot, exchanged, false); // never store an unverified token
    const storage = await storeCredential(io, origin, slot, cred);
    print(io, {
      ok: true,
      hub: origin,
      kind: cred.kind,
      slot: credentialSlot(slot),
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
 * `owenloop logout` — delete the stored credential for a hub, in ONE slot
 * (`--as`, default `human`), from both the keychain and the file store. Cheap;
 * completes the credential lifecycle. Other slots for the same origin are left
 * alone: the keychain cannot enumerate its accounts, so a blanket
 * clear-everything is not implementable and is not faked.
 */
async function dispatchLogout(io: CliIO, args: Args): Promise<number> {
  const origin = resolveHub(io, args);
  const slot = resolveSlot(args);
  const removed = await deleteCredential(io, origin, slot);
  const slotName = credentialSlot(slot);
  if (!removed) {
    io.err(`no stored credential for ${origin} in slot \`${slotName}\` — another slot may hold one (see --as)`);
  }
  print(io, { ok: true, hub: origin, slot: slotName, removed });
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
  const slot = resolveSlot(args);
  const cred = readCredential(io, origin, slot);
  if (!cred) throw new CliError(emptySlotMessage(origin, slot));

  const { identity } = await verifyCredential(io, origin, slot, cred);

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
  const slot = resolveSlot(args);

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

  let cred = readCredential(io, origin, slot);
  if (!cred) throw new CliError(emptySlotMessage(origin, slot));

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
      (!report.bounded && report.deadlocks.length > 0);
    if (hasDefiniteDefect) {
      reasons.push(
        `${def.name}: definite defects found (${report.invariantViolations.length} invariant violation(s), ` +
          `${report.deadlocks.length} true deadlock(s))`,
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
  const { res: listRes, cred: listCred } = await authedGet(io, origin, slot, cred, '/api/workflows');
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
  cred = await ensureFreshOAuth(io, origin, slot, cred);

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
        cred = await refreshOAuth(io, origin, slot, cred as Extract<Credential, { kind: 'oauth' }>);
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

/**
 * `owenloop mcp` — serve the human control plane to a local MCP host over stdio.
 * A thin adapter: read the optional `--hub <url>` flag and hand `io` (which
 * satisfies the module's `McpIo`) to `runMcpCommand`, which resolves the origin,
 * builds the tool list, and pumps stdin until EOF. All the logic lives in
 * `src/mcp/serve.ts`; this stays a two-line dispatch like every other verb.
 */
async function dispatchMcp(io: CliIO, args: Args): Promise<number> {
  return runMcpCommand(io, { hubFlag: last(args, 'hub') });
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
 * Resolve the hub `agent new` mints on: `--hub <origin>` (normalized via
 * `normalizeOrigin`) → else the ONE hub the credential FILE knows → else a
 * `CliError` with `exitCode: 2` naming both remedies.
 *
 * Deliberately NOT `resolveHub` (`--hub → OWENLOOP_HUB → DEFAULT_HUB`): silently
 * defaulting a MINT to the production hub while the user is logged into a dev hub
 * would mint on the wrong org, and a mint is not undone by a retry. `OWENLOOP_HUB`
 * is intentionally excluded so this stays in parity with O2's `owenloop mcp`.
 *
 * `listStoredHubOrigins` is backend-aware (shared with O2's `owenloop mcp`): only
 * the FILE backend can enumerate, so it returns `null` on a keychain- or
 * external-command-backed machine — those must pass `--hub`. A file-backed store
 * returns the origins with a valid `human` slot: `[]` (log in first), exactly one
 * (used automatically), or more than one (the non-secret origin keys are listed
 * back so the user can pick).
 */
function resolveAgentHub(io: CliIO, args: Args): string {
  const flagVal = last(args, 'hub');
  if (flagVal !== undefined) {
    try {
      return normalizeOrigin(flagVal);
    } catch (e) {
      throw new CliError((e as Error).message);
    }
  }
  const origins = listStoredHubOrigins(io.env, io.keychain);
  if (origins === null) {
    const backend = credentialBackend(io.env, io.keychain);
    const which = backend.kind === 'external' ? 'external-command' : 'keychain';
    throw new CliError(
      `cannot determine which hub to mint on — the ${which} credential store cannot be enumerated; ` +
        'pass --hub <origin>',
      { exitCode: 2 },
    );
  }
  if (origins.length === 1) return origins[0]!;
  throw new CliError(
    'cannot determine which hub to mint on — pass --hub <origin>, or log in to exactly one hub first ' +
      '(owenloop login --hub <origin>)' +
      (origins.length > 1 ? `; stored hubs: ${origins.join(', ')}` : ''),
    { exitCode: 2 },
  );
}

/**
 * `owenloop agent new <name>` — mint a new agent identity on the hub and store
 * its `olp_` token in slot `agent:<name>`.
 *
 * **Secret hygiene (identity model §6, "rule of gates"):** the minted token goes
 * process→store ONLY — it never appears on stdout, stderr, in an error, or in a
 * log. `mintAgentCredential` (credentials.ts) owns the token end to end and
 * returns none of it; the confirmation printed here is built from an explicit
 * WHITELIST of non-secret fields (name, pools, storage backend, revocation ids).
 *
 * Ordering is load-bearing (PR #69 lesson, carried by `mintAgentCredential`): the
 * client-side name validation and the external-command refusal both run BEFORE
 * any network call, so a refusal that would make the credential unstorable never
 * mints a server-side token first — minting then failing to store would burn the
 * agent name permanently.
 *
 * Exit codes: 0 ok; 1 generic failure (invalid name, name taken, pool/shape
 * rejection, network timeout, minted-but-unstored); 2 the hub is unresolvable;
 * 3 the human credential is absent or irrecoverable (remedy names
 * `owenloop login --hub <origin>`).
 *
 * A subcommand switch (`new` only today) leaves room for `agent list`/etc. later.
 */
async function dispatchAgent(io: CliIO, args: Args): Promise<number> {
  const sub = args.positionals[1];
  if (sub !== 'new') {
    throw new CliError(`unknown agent subcommand '${sub ?? ''}' — expected: agent new <name>`);
  }
  const name = args.positionals[2];
  if (name === undefined) {
    throw new CliError(
      'missing required argument: <name> (usage: owenloop agent new <name> [--pools a,b] [--hub <url>])',
    );
  }
  // Validate the agent name eagerly — before any I/O — with the store's own
  // wording, so a bad name never reaches the network or the store.
  try {
    credentialSlot({ principal: 'agent', account: name });
  } catch (e) {
    throw new CliError(`agent new: invalid agent name — ${(e as Error).message}`);
  }

  // --pools: split on `,`, trim, drop empties. Absent → undefined (key omitted
  // from the request; the server then defaults to the minter's personal pool).
  // Present but empty (`--pools ""` / `--pools ,`) → usage error, before any I/O.
  // No client-side pool-name validation — the server is the enforcement of record.
  const poolsRaw = last(args, 'pools');
  let pools: string[] | undefined;
  if (poolsRaw !== undefined) {
    pools = poolsRaw
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    if (pools.length === 0) {
      throw new CliError('--pools requires at least one pool name');
    }
  }

  // Refuse an external-command setup at the TOP of the dispatcher — before the
  // human-credential read (which would otherwise RUN the command) and before any
  // network call (PR #69 lesson; `mintAgentCredential` carries the same guard as
  // a library backstop). Refusing only at store time would mint a server-side
  // token we could never store locally, permanently burning the agent name.
  if (externalCredentialCommand(io.env) !== undefined) {
    throw new CliError(
      'an external credential command is configured (OWENLOOP_CREDENTIAL_COMMAND), so it — not the ' +
        'local store — supplies credentials for this hub; unset it to use `owenloop login`',
    );
  }

  const origin = resolveAgentHub(io, args);

  // The human bearer for the resolved origin. Absent → exit 3 with the verbatim
  // remedy the brief mandates.
  const cred = readCredential(io, origin, { principal: 'human' });
  if (cred === null) {
    throw new CliError(`no human credential for ${origin} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
  }

  let result;
  try {
    result = await mintAgentCredential(io, origin, { principal: 'human' }, cred, { name, pools });
  } catch (e) {
    // A refresh-failure-family error (the human oauth is irrecoverable, or a 401
    // survived the refresh-and-retry) is exit 3 with the login remedy; every
    // other CliError propagates as-is — a network timeout stays exit 1, because a
    // flaky network is not an irrecoverable credential.
    if (e instanceof CliError && /run `owenloop login`/.test(e.message)) {
      throw new CliError(`${e.message} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
    }
    throw e;
  }

  // Confirmation: whitelisted, non-secret fields ONLY. `text`/`token` are
  // structurally absent from `result`, so there is nothing here to leak.
  print(io, {
    ok: true,
    hub: origin,
    name,
    slot: `agent:${name}`,
    pools: result.pools,
    scopes: ['work'],
    storage: result.storage,
    agentId: result.agentId,
    tokenId: result.id,
  });
  return 0;
}

/**
 * Async entry point that adds network I/O for `add` and the hub commands on top
 * of the otherwise fully-synchronous engine/CLI (see the doc comment on
 * `sleepMs` above and README "sync end to end"). `main`/`dispatch` stay sync and
 * unchanged — this wraps them, routing only the network-touching verbs through
 * the async path, so every existing command and test keeps working exactly as
 * before.
 */
export const ASYNC_COMMANDS = new Set(['add', 'login', 'logout', 'connect', 'push', 'agent', 'mcp']);

export async function mainAsync(argv: string[], io: CliIO = defaultIO()): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positionals[0];
  if (command === undefined || !ASYNC_COMMANDS.has(command)) {
    return main(argv, io);
  }
  try {
    const short = preflight(command, args, io);
    if (short !== undefined) return short;
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
      case 'agent':
        return await dispatchAgent(io, args);
      case 'mcp':
        return await dispatchMcp(io, args);
      default:
        return main(argv, io); // unreachable — ASYNC_COMMANDS guards the switch
    }
  } catch (e) {
    if (e instanceof CliError || e instanceof DefError) {
      io.err(`error: ${e.message}`);
    } else {
      io.err(`error: ${(e as Error).message}`);
    }
    // A CliError carries its own exit code (default 1); everything else is 1.
    return e instanceof CliError ? e.exitCode : 1;
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
    const short = preflight(command, args, io);
    if (short !== undefined) return short;
    return dispatch(command, io, args);
  } catch (e) {
    if (e instanceof CliError || e instanceof DefError) {
      io.err(`error: ${e.message}`);
    } else {
      io.err(`error: ${(e as Error).message}`);
    }
    // A CliError carries its own exit code (default 1); everything else is 1.
    return e instanceof CliError ? e.exitCode : 1;
  }
}
