/**
 * The owenloop CLI — a thin, scriptable surface over the engine.
 *
 * Every data command prints JSON to stdout, so a *wiring* (the Step Agent/automation
 * that actually runs orders) can drive the engine programmatically: `tick` to
 * pull orders, run them, then `green` / `emit` / `seal` / `reject` / `close` to
 * report outcomes. The engine itself is domain-neutral; this binary just maps
 * argv to engine calls.
 *
 *   owenloop defs                       list available workflow definitions
 *   owenloop add <owner>/<repo>[@ref]   fetch, validate, and install a repo's workflow defs (public repos)
 *   owenloop start <def> [--provide n=json] [--crew name]   start a published hub workflow
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
 *   owenloop close <wf> <run> [--outcome ok|no_work|released|failed|skipped] [--summary s]
 *   owenloop delete <wf> [--recursive]
 *
 * Global: --db <path> (env OWENLOOP_DB), --defs <dir> (env OWENLOOP_DEFS).
 */

import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { hostname, tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { Engine } from './engine.ts';
import { buildGraph, buildTrace, graphToDot, graphToMermaid, hasDefiniteCheckDefect, modelCheck } from './model.ts';
import { openStore } from './store.ts';
import type { ArtifactRow, Store, WorkflowRow } from './store.ts';
import {
  buildDef,
  DefError,
  finalizeDefs,
  lintDef,
  loadDefFile,
  loadDefs,
  loadDefsRaw,
  loadDefsUnfinalized,
  resolveCallsTarget,
  validateDef,
} from './defs.ts';
import type { DefLoadFailure } from './defs.ts';
import { createDefInstructionSource } from './order-resolver.ts';
import type { CheckReport, WorkflowDef } from './types.ts';
import { CliError, dbPathRefusingSymlink, detId, mkdirRefusingSymlink, nowMs, parseDurationMs, randId } from './util.ts';
import { packageVersion } from './package-version.ts';
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
  rekeyAgentCredential,
  storeCredential,
} from './credentials.ts';
import { PrincipalKeyManager } from './crypto/keys.ts';
import type { PrincipalKeyRef } from './crypto/keys.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  DSSE_SSH_NAMESPACE,
  decodeBase64Strict,
  dsseSignEnrollmentGrant,
  dsseSignOrigin,
  dsseSignPublication,
  dsseSignRevocation,
  PAYLOAD_TYPE_ORIGIN,
  PAYLOAD_TYPE_PUBLICATION,
} from './crypto/dsse.ts';
import { assertEd25519PubText, createSshSigner, SshSignerError } from './crypto/ssh.ts';
import { publicKeyDescriptor } from './crypto/keys.ts';
import { DEFAULT_MACHINE_SCOPE, buildEnrollmentGrant, verifyRosterEntry } from './crypto/enrollment.ts';
import type { RosterVerdict } from './crypto/enrollment.ts';
import { resolveAllowedSigners } from './crypto/trust-roots.ts';
import type {
  EnrollmentGrantRecord,
  OriginRecord,
  OriginSource,
  PrincipalReference,
  PublicationRecord,
  RevocationRecord,
} from './crypto/records.ts';
import {
  orgRootPrivateKeyPath,
  orgRootPublicKeyPath,
  resolveOrgRoot,
  revocationsDir,
  assertNoStrandedLegacyGrants,
  grantsDir,
} from './crypto/org-root.ts';
import { runMcpCommand } from './mcp/serve.ts';
import type { LineStream } from './mcp/server.ts';
import { DEFAULT_TAR_LIMITS, extractTarGz } from './untar.ts';
import { BundleError, digestBundle, inspectBundle, packBundle, unpackBundle } from './bundle/index.ts';
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
  rmRecursiveForce,
  rollbackInstallCommit,
  RollbackFailedError,
  stageFiles,
  STAGING_DIRNAME,
  writeAddJournal,
  writeLockfile,
} from './add.ts';
import type { AddJournal, InstalledEntry, InstallCommitHandle, InstallLockHandle, Lockfile } from './add.ts';
import {
  BundleIngestorUnavailableError,
  globalStoreRoot,
  installWorkflowBundle,
  inspectCasDefs,
  loadCasDefs,
  PreCommitVerifierUnavailableError,
  projectStoreRoot,
  createBundleIngestor,
  createPreCommitVerifier,
  recoverWorkflowStore,
  storeIndexPath,
  workflowStoreReplacementRecovery,
  workflowStoreStatePaths,
} from './store/index.ts';
import type { BundleIngestor, BundleSource, PreCommitVerifier } from './store/index.ts';
import {
  asAgentIdentities,
  asCreateWorkflowOk,
  capabilityPublishReportText,
  asCapabilityRerouteAdded,
  asCapabilityRerouteRemoved,
  asCapabilityReroutes,
  asCapabilityRouteAdded,
  asCapabilityRouteRemoved,
  asCapabilityRoutes,
  asCrewCreated,
  asCrewDeleted,
  asCrewMemberAdded,
  asCrewMemberRemoved,
  asCrews,
  asRoutingAlerts,
  asRunRouting,
  asWhoami,
  computeServerDiff,
  credentialBackend,
  createWorkflowError,
  credentialFilePath,
  credentialSlot,
  DEFAULT_HUB,
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
  AgentIdentitySummary,
  CapabilityPublishReportEntry,
  CapabilityRouteWire,
  Credential,
  CredentialSlotSelector,
  DefPushCandidate,
  HubBinding,
  Keychain,
  WhoamiIdentity,
} from './hub.ts';
import { fetchCapabilityMappings, recordCapabilityMappings } from './capability-mapping-client.ts';
import type { CapabilityMappingTransport } from './capability-mapping-client.ts';
import { MODIFIER_SEPARATOR } from './capabilities.ts';
import { loadSettings, settingsPath as executionSettingsPath } from '../packages/work/src/settings/settings.ts';
import { discoverCrewRosterFiles, crewRosterPath, effectiveRosterLayers, explainRosterShadows, mergeRosterLayers } from '../packages/work/src/settings/roster.ts';
import { readHubRosterCache, syncHubRosterCache } from '../packages/work/src/settings/hub-roster-cache.ts';
import type { HubClient } from '../packages/work/src/hub/client.ts';
import type { GetRostersResponse, WhoamiResponse } from '../packages/work/src/hub/types.ts';
import { adapterFor } from '../packages/work/src/harness/registry.ts';
import '../packages/work/src/harnesses.ts';
import { owenloopConfigDir } from './config-dir.ts';
import { owenloopSettingsPath, readOwenloopSettingsRaw, writeOwenloopHubOrigin } from './work-settings.ts';
import { globalConfigPath, writeGlobalConfig } from './global-config.ts';
import { canonicalJsonBytes, defaultRecoveryMarkerDir, ensureDirectoryPathNoSymlink, guardStateFile } from './install.ts';
import { summarizeIssues, validateValue } from './schema.ts';
import type { JsonSchema } from './types.ts';
import { originSchema } from './schemas/index.ts';

// Re-export the keychain backend type so existing test imports of `Keychain`
// from `../src/cli.ts` (test/hubkit.ts, test/login.test.ts) keep resolving —
// the type is now homed in hub.ts (cli → hub is boundary-legal).
export type { Keychain } from './hub.ts';

export type HarnessId = 'claude-code' | 'codex';

export interface CliIO {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Injectable for hermetic tests — the network-touching verbs (`add`, hub commands) use this. */
  fetch?: typeof globalThis.fetch;
  /**
   * The bundle adapter for the `.wnlp` install route (unpacking, manifest
   * integrity, canonical digest, coordinate). Injectable for tests and for
   * wiring layers that carry the bundle-format module. `add` with bundle
   * input FAILS CLOSED when this is absent — there is no default accepting
   * parser or digest algorithm. The GitHub repo route never uses it.
   */
  bundleIngestor?: BundleIngestor;
  /**
   * The pre-commit verifier for the `.wnlp` install route, called after
   * content/engine validation and before any object swap or index write.
   * Injectable for tests and for wiring layers that carry the verification
   * module. `add` with bundle input FAILS CLOSED when this is absent — there
   * is no default accepting verifier. The GitHub repo route never uses it.
   */
  preCommitVerifier?: PreCommitVerifier;
  /** Optional test/runtime override for the external install/repair transaction marker directory. */
  recoveryMarkerDir?: string;
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
  /**
   * Ask the user a question and read a line back. Used only by `setup`'s
   * interactive branches (name-this-agent, succession choice). Default: a
   * `node:readline/promises` interface over `process.stdin`/`process.stderr` —
   * the question and echo go to STDERR so stdout stays a clean machine-parseable
   * JSON document (the repo's diagnostics-to-stderr convention). Injectable so
   * tests script answers without a TTY.
   */
  prompt?: (question: string) => Promise<string>;
  /**
   * Run a local command and capture its result — used by `setup`/`doctor`'s
   * Claude Code and Codex plugin probes and convergers. Default: a `spawnSync`
   * wrapper with `shell: false` (never interpolates argv into a shell) that
   * never inherits stdio. Injectable so tests model plugin state and installs
   * without real harness binaries or configuration writes.
   */
  runCommand?: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
  /** Optional resolver override for hermetic tests of a missing bundled marketplace. */
  resolveBundledMarketplaceRoot?: (harness: HarnessId) => string | null;
  /**
   * The principal signing-key manager for `setup`'s `[4/8] signing keys` step.
   * Injectable so setup tests never reach the developer's real `ssh-keygen`,
   * Keychain, libsecret, SSH agent, or `$HOME` (`makeFakePrincipalKeys` in
   * test/hubkit.ts). Default: a real `PrincipalKeyManager` over `io.env`.
   * Structurally `Pick<PrincipalKeyManager, 'ensure' | 'inspect' | 'withSigningKey' |
   * 'resolveRef'>` — the narrow surface setup and publish use — so fakes stay
   * hermetic.
   */
  principalKeys?: Pick<PrincipalKeyManager, 'ensure' | 'inspect' | 'withSigningKey' | 'resolveRef'>;
}

export function defaultIO(): CliIO {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    fetch: globalThis.fetch,
    bundleIngestor: createBundleIngestor(),
    preCommitVerifier: createPreCommitVerifier({
      cwd: process.cwd(),
      env: process.env,
      warn: (line) => process.stderr.write(`${line}\n`),
    }),
    openUrl: defaultOpenUrl,
    readStdin: defaultReadStdin,
    prompt: defaultPrompt,
    runCommand: defaultRunCommand,
  };
}

/**
 * The default interactive prompt: a one-shot `node:readline/promises` question
 * whose text and echo go to STDERR (so stdout remains the parseable JSON
 * document). Closed immediately after the single read.
 */
async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * The default local-command runner: `spawnSync` with `shell: false` (argv is
 * passed as a vector, never interpolated into a shell) and captured, not
 * inherited, stdio. Plugin probes and convergers use it.
 */
function defaultRunCommand(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
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
  /** Non-boolean options written without `=<value>` or a following value token. */
  missingOptionValues: Set<string>;
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
  'strict-inputs',
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
  // `add --global` (and `add --global --recover`) is likewise value-less: the
  // bundle path/URL must stay a positional.
  'global',
  'unsigned',
]);

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const missingOptionValues = new Set<string>();
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
	val = 'true'; // legacy representation for a valueless non-boolean option
	missingOptionValues.add(key);
      }
      const arr = options.get(key) ?? [];
      arr.push(val);
      options.set(key, arr);
    } else {
      positionals.push(a);
    }
  }
  return { positionals, options, missingOptionValues };
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
  definitionDiscoveryComplete: boolean;
}

interface LoadedDefs {
  defs: Map<string, WorkflowDef>;
  definitionDiscoveryComplete: boolean;
}

function finalizeDiscoveredDefs(
  merged: Map<string, WorkflowDef>,
  tolerantCasInspection: boolean,
  definitionDiscoveryComplete: boolean,
): Map<string, WorkflowDef> {
  if (!tolerantCasInspection || definitionDiscoveryComplete) return finalizeDefs(merged);
  // Only `status` requests tolerant CAS inspection. Its partial map is read-only:
  // unresolved calls into skipped corrupt objects must not abort the fleet read.
  return finalizeDefs(merged, { allowUnresolvedCalls: true });
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
function loadDefsWithInstalled(
  io: CliIO,
  defsDir: string,
  tolerantCasInspection = false,
): LoadedDefs {
  const merged = existsSync(defsDir) ? loadDefsUnfinalized(defsDir) : new Map<string, WorkflowDef>();

  let lf: Lockfile;
  try {
    lf = readLockfile(join(io.cwd, '.owenloop', 'installed.json'));
  } catch (e) {
    io.err(`warning: skipping installed workflow defs: ${(e as Error).message}`);
    const definitionDiscoveryComplete = foldCasDefs(io, defsDir, merged, tolerantCasInspection);
    return {
      defs: finalizeDiscoveredDefs(merged, tolerantCasInspection, definitionDiscoveryComplete),
      definitionDiscoveryComplete,
    };
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

  const definitionDiscoveryComplete = foldCasDefs(io, defsDir, merged, tolerantCasInspection);

  return {
    defs: finalizeDiscoveredDefs(merged, tolerantCasInspection, definitionDiscoveryComplete),
    definitionDiscoveryComplete,
  };
}

/**
 * WS-6: fold the CONTENT-ADDRESSED store's defs into the same raw map, under
 * their QUALIFIED keys only.
 *
 * Precedence, level 3 of 4 (see `loadDefsWithInstalled` above for 1 and 2):
 * this runs LAST, after the base scan and after the `add`-ledger fold, so a
 * project-local def and an `add`-installed def both keep the precedence they
 * have today. Nothing here can shadow either of them regardless of ordering,
 * because the key a CAS def is registered under always contains `/` and a def
 * name may not (`/^[a-z0-9][a-z0-9_-]*$/i`) — a CAS registration is unforgeable
 * as a filesystem name.
 *
 * Precedence level 4 — a BARE `calls:` reaching a CAS workflow — is deliberately
 * NOT a map entry. Bare sibling resolution happens in `resolveCallsTarget`
 * (defs.ts), scoped by the calling def's own `bundleDigest`, so bundle A's
 * `calls: build` can never bind to bundle B's `build`.
 *
 * Executable discovery is fail-closed. Only the explicit status inspection path
 * uses `inspectCasDefs`, which warns, returns `complete: false`, and is never
 * reused by a mutating command's resolver.
 *
 * When no store exists (no `index.json` at either root) this is a no-op and the
 * merged map is byte-identical to what it was before WS-6.
 */
function foldCasDefs(
  io: CliIO,
  defsDir: string,
  merged: Map<string, WorkflowDef>,
  tolerantInspection = false,
): boolean {
  // Without HOME/USERPROFILE, retain project discovery and consult a guaranteed
  // absent synthetic global root instead of silently dropping the project store.
  let globalRoot: string;
  try {
    globalRoot = globalStoreRoot(workflowHome(io));
  } catch {
    globalRoot = join(defsDir, '.owenloop-global-store-unavailable');
  }
  const discoveryArgs = {
    projectRoot: projectStoreRoot(defsDir),
    globalRoot,
    warn: (line: string) => io.err(line),
  };
  const discovery = tolerantInspection
    ? inspectCasDefs(discoveryArgs)
    : { registrations: loadCasDefs(discoveryArgs), complete: true };
  const registrations = discovery.registrations;
  for (const registration of registrations) {
    const winner = merged.get(registration.key);
    if (winner !== undefined) {
      io.err(
        `warning: workflow '${registration.key}' from bundle ${registration.bundleDigest} is shadowed by ` +
          `${winner.dir ?? 'an already-registered definition'}`,
      );
      continue;
    }
    merged.set(registration.key, registration.def);
  }
  return discovery.complete;
}

function openCtx(io: CliIO, args: Args, tolerantCasInspection = false): Ctx {
  const dbOverride = last(args, 'db') ?? io.env.OWENLOOP_DB;
  const dbPath = dbOverride ?? join(io.cwd, '.owenloop', 'state.db');
  // An explicit `--defs`/`OWENLOOP_DEFS` is the operator targeting a literal dir
  // (keep pure-scan behavior, no ledger fold-in); its ABSENCE means the default
  // dir, where `add` installs and the ledger's folders live — fold installed
  // defs in there. The rule is "was an override given", not path equality: even
  // `OWENLOOP_DEFS=<cwd>/workflows` counts as an override and stays literal.
  const defsOverride = last(args, 'defs') ?? io.env.OWENLOOP_DEFS;
  const defsDir = defsOverride ?? join(io.cwd, 'workflows');
  // Discover and validate executable definitions before creating or opening the
  // runtime database. Corrupt workflow-store state therefore cannot mutate local
  // runtime state before the command fails closed.
  const loaded: LoadedDefs = defsOverride !== undefined
    ? {
	defs: existsSync(defsDir) ? loadDefs(defsDir) : new Map<string, WorkflowDef>(),
	definitionDiscoveryComplete: true,
      }
    : loadDefsWithInstalled(io, defsDir, tolerantCasInspection);
  const { defs, definitionDiscoveryComplete } = loaded;

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
  // WP-B1: the CLI ticks reference-mode orders exactly like the embedded
  // path — one loaded-definition resolver seeds the instruction boundary
  // (emission digests + instruction resolution), never a second local path.
  const instructionSource = createDefInstructionSource(defs.values());
  // WS-6: the resolver is SCOPE-AWARE. `from` is supplied only by the engine's
  // `calls:` spawn path; when it is present and carries CAS provenance, a bare
  // target resolves sibling-first inside that def's own bundle (the exact rule
  // `finalizeDefs` validated against at load time, so load-time and run-time
  // agree). With `from` absent — every other resolver caller — this is the plain
  // flat-map lookup it has always been.
  const engine = new Engine(store, (name, from) => {
    const d = from === undefined ? defs.get(name) : resolveCallsTarget(defs, name, from);
    if (!d) throw new CliError(`unknown workflow definition '${name}' (looked in ${defsDir})`);
    return d;
  }, { instructionSource });
  return { store, engine, defs, defsDir, dbPath, definitionDiscoveryComplete };
}

function print(io: CliIO, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

/** Validate the exact positional shape of one bundle subcommand. */
function assertBundlePositionals(args: Args, count: number, usage: string): void {
  if (args.positionals.length !== count) {
    throw new CliError(`invalid bundle arguments; usage: ${usage}`);
  }
}

/** `--output` requires a following value; parseArgs represents a bare flag as `true`. */
function bundleOutput(args: Args): string | undefined {
  const value = last(args, 'output');
  if (value === 'true') {
    throw new CliError('owenloop bundle pack: --output requires a path value');
  }
  return value;
}

function printBundlePackResult(io: CliIO, outputAbs: string, packed: ReturnType<typeof packBundle>): void {
  print(io, {
    path: outputAbs,
    digest: packed.digest,
    name: packed.manifest.package.name,
    version: packed.manifest.package.version,
    ...(packed.manifest.runtime === undefined ? {} : { runtime: packed.manifest.runtime }),
    files: packed.entries.length,
  });
}

function printBundleUnpackResult(io: CliIO, result: ReturnType<typeof unpackBundle>): void {
  print(io, {
    path: result.path,
    digest: result.digest,
    name: result.manifest.package.name,
    version: result.manifest.package.version,
    files: result.entries.length,
  });
}

function printBundleInspectResult(io: CliIO, result: ReturnType<typeof inspectBundle>): void {
  print(io, {
    digest: result.digest,
    manifest: result.manifest,
    entries: result.entries.map((e) => ({ path: e.path, size: e.size, executable: e.executable, sha256: e.sha256 })),
  });
}

/**
 * `owenloop bundle pack|unpack|inspect|digest` — the `.wnlp` package-format
 * verbs (WP-A1; format contract in `docs/bundles.md`). Purely filesystem
 * work on the bytes the user points at: these commands NEVER open the store
 * (dispatched before `openCtx`), NEVER touch the network, and NEVER write
 * `.owenloop/` state. Every `BundleError` carries a stable `code`, kept in
 * the stderr message so scripts can match on it.
 */
function dispatchBundle(io: CliIO, args: Args): number {
  const sub = need(args, 1, 'pack|unpack|inspect|digest');
  if (sub !== 'pack' && args.options.has('output')) {
    throw new CliError(`owenloop bundle ${sub}: --output is only valid for pack`);
  }

  switch (sub) {
    case 'pack': {
      assertBundlePositionals(args, 3, 'owenloop bundle pack <source-dir> [--output <bundle.wnlp>]');
      const outputOpt = bundleOutput(args);
      const source = need(args, 2, 'source-dir');
      const sourceAbs = resolve(io.cwd, source);
      // Check an explicit output before reading the source. The output cannot
      // become one of the source files during a pack operation.
      if (outputOpt !== undefined) assertOutputOutsideSource(resolve(io.cwd, outputOpt), sourceAbs);
      const packed = runBundle(() => packBundle(sourceAbs));
      const outputAbs = resolve(io.cwd, outputOpt ?? defaultPackOutput(sourceAbs, packed.manifest.package.name, packed.manifest.package.version));
      // The default output is derived from the manifest, so it is checked after
      // packing; an explicit output was checked before the source walk above.
      assertOutputOutsideSource(outputAbs, sourceAbs);
      // Reject an existing non-file output (a directory); replace a regular file.
      const existing = lstatSync(outputAbs, { throwIfNoEntry: false });
      if (existing && !existing.isFile()) throw new CliError(`owenloop bundle pack: output '${outputOpt ?? defaultPackOutput(sourceAbs, packed.manifest.package.name, packed.manifest.package.version)}' exists and is not a regular file`);
      writeBundleFileAtomic(outputAbs, packed.bytes);
      printBundlePackResult(io, outputAbs, packed);
      return 0;
    }
    case 'unpack': {
      assertBundlePositionals(args, 4, 'owenloop bundle unpack <bundle.wnlp> <destination-dir>');
      const bundlePath = need(args, 2, 'bundle.wnlp');
      const destination = need(args, 3, 'destination-dir');
      const bytes = readBundleCommandFile(io, bundlePath);
      const result = runBundle(() => unpackBundle(bytes, resolve(io.cwd, destination)));
      printBundleUnpackResult(io, result);
      return 0;
    }
    case 'inspect': {
      assertBundlePositionals(args, 3, 'owenloop bundle inspect <bundle.wnlp>');
      const bundlePath = need(args, 2, 'bundle.wnlp');
      const bytes = readBundleCommandFile(io, bundlePath);
      const result = runBundle(() => inspectBundle(bytes));
      printBundleInspectResult(io, result);
      return 0;
    }
    case 'digest': {
      assertBundlePositionals(args, 3, 'owenloop bundle digest <bundle.wnlp>');
      const bundlePath = need(args, 2, 'bundle.wnlp');
      const bytes = readBundleCommandFile(io, bundlePath);
      const result = runBundle(() => digestBundle(bytes));
      print(io, { digest: result.digest });
      return 0;
    }
    default:
      throw new CliError(`owenloop bundle: unknown subcommand '${sub}' (expected pack, unpack, inspect, or digest)`);
  }
}

/** `--output` requires a following value; a bare flag is not a default path. */
function publishOutput(args: Args): string | undefined {
  const value = last(args, 'output');
  if (value === 'true') throw new CliError('owenloop publish: --output requires a path value');
  return value;
}

/** Parse and validate the signer-supplied provenance object before key work. */
function publishSource(args: Args): OriginSource | undefined {
  const raw = last(args, 'source');
  if (raw === undefined) return undefined;
  const value = parseJson(raw);
  const properties = (originSchema as unknown as { properties?: Record<string, JsonSchema> }).properties;
  const sourceSchema = properties?.source;
  if (sourceSchema === undefined) throw new CliError('owenloop publish: origin schema has no source property');
  const shape = validateValue(sourceSchema, value);
  if (!shape.valid) {
    throw new CliError(`owenloop publish: --source does not match origin source schema: ${summarizeIssues(shape.issues)}`);
  }
  if (value.kind === 'console') {
    throw new CliError('owenloop publish: --source kind "console" requires a client-side signing ceremony');
  }
  return value as unknown as OriginSource;
}

/** Refuse an output or sidecar path that is not absent or a regular file. */
function assertPublishOutputPath(path: string, label: string): void {
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isFile()) {
    throw new CliError(`owenloop publish: ${label} '${path}' exists and is not a regular file`);
  }
}

/** Remove one regular publication sidecar after its replacement is durable. */
function removePublicationSidecar(path: string): void {
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return;
  try {
    unlinkSync(path);
  } catch (e) {
    throw new CliError(`owenloop publish: cannot remove stale sidecar '${path}': ${(e as Error).message}`);
  }
}

/**
 * `owenloop publish <source-dir>` — pack one canonical workflow bundle and
 * publish a signed DSSE statement beside it. Signed publication is the default;
 * `--unsigned` writes an unauthenticated intent marker instead. The signed path
 * resolves and probes the author key before `packBundle`, so key or signer
 * failures leave no bundle or sidecar behind. This command is deliberately
 * separate from `bundle pack` and `push`: it is asynchronous only because local
 * key material is materialized through the signing-key manager.
 */
async function dispatchPublish(io: CliIO, args: Args): Promise<number> {
  if (args.positionals.length !== 2) {
    throw new CliError(
      'invalid publish arguments; usage: owenloop publish <source-dir> [--output <bundle.wnlp>] [--source <json>] [--unsigned] [--hub <origin>]',
    );
  }
  const source = need(args, 1, 'source-dir');
  const sourceAbs = resolve(io.cwd, source);
  const outputOpt = publishOutput(args);
  if (outputOpt !== undefined) assertOutputOutsideSource(resolve(io.cwd, outputOpt), sourceAbs);
  const originSource = publishSource(args);
  const unsigned = flag(args, 'unsigned');
  if (originSource !== undefined && unsigned) {
    throw new CliError('owenloop publish: --source cannot be combined with --unsigned');
  }

  const { origin } = resolvePublishingHub(io, args, { principal: 'human' });

  const keys = io.principalKeys ?? new PrincipalKeyManager({ env: io.env });
  let packed: ReturnType<typeof packBundle>;
  let envelope: unknown;
  let originEnvelope: unknown;

  if (unsigned) {
    packed = runBundle(() => packBundle(sourceAbs));
  } else {
    const ref = keys.resolveRef(origin, 'human');
    if (ref === null) {
      throw new CliError(`no author signing key for ${origin} — run \`owenloop setup\` or pass --unsigned`);
    }
    // `inspect` is read-only: publish must confirm that setup already stored
    // this key, never create or repair one. `withSigningKey` remains the only
    // API that materializes private bytes.
    const inspected = await keys.inspect(ref);
    if (!inspected.exists || inspected.publicKey === undefined) {
      throw new CliError(`no author signing key for ${origin} — run \`owenloop setup\` or pass --unsigned`);
    }
    const publicKey = inspected.publicKey;
    const signed = await keys.withSigningKey(ref, async (keyPath) => {
      // Constructing the signer probes ssh-keygen -Y before packBundle runs.
      const signer = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath: keyPath });
      const nextPacked = runBundle(() => packBundle(sourceAbs));
      const timestamp = nowMs();
      const record: PublicationRecord = {
        digest: nextPacked.digest,
        name: nextPacked.manifest.package.name,
        version: nextPacked.manifest.package.version,
        publisherKeyId: publicKey.keyid,
        timestamp,
      };
      const payloadBytes = Buffer.from(canonicalJsonBytes(record));
      const result = await dsseSignPublication(payloadBytes, signer);
      let signedOrigin: unknown;
      if (originSource !== undefined) {
        const originRecord: OriginRecord = {
          digest: nextPacked.digest,
          name: nextPacked.manifest.package.name,
          version: nextPacked.manifest.package.version,
          source: originSource,
          attesterKeyId: publicKey.keyid,
          timestamp,
        };
        const originResult = await dsseSignOrigin(Buffer.from(canonicalJsonBytes(originRecord)), signer);
        signedOrigin = originResult.envelope;
      }
      return { envelope: result.envelope, originEnvelope: signedOrigin, packed: nextPacked };
    });
    packed = signed.packed;
    envelope = signed.envelope;
    originEnvelope = signed.originEnvelope;
  }

  const outputAbs = resolve(
    io.cwd,
    outputOpt ?? defaultPackOutput(sourceAbs, packed.manifest.package.name, packed.manifest.package.version),
  );
  assertOutputOutsideSource(outputAbs, sourceAbs);
  const envelopePath = `${outputAbs}.dsse`;
  const originPath = `${outputAbs}.origin.dsse`;
  const markerPath = `${outputAbs}.unsigned`;
  assertPublishOutputPath(outputAbs, 'output');
  assertPublishOutputPath(envelopePath, 'sidecar');
  assertPublishOutputPath(originPath, 'sidecar');
  assertPublishOutputPath(markerPath, 'sidecar');

  writeBundleFileAtomic(outputAbs, packed.bytes, 'owenloop publish');
  if (unsigned) {
    const marker = { formatVersion: 1, digest: packed.digest, signed: false };
    writeBundleFileAtomic(markerPath, canonicalJsonBytes(marker), 'owenloop publish');
    removePublicationSidecar(envelopePath);
    removePublicationSidecar(originPath);
    print(io, {
      ok: true,
      bundle: outputAbs,
      digest: packed.digest,
      name: packed.manifest.package.name,
      version: packed.manifest.package.version,
      signed: false,
      marker: markerPath,
    });
  } else {
    writeBundleFileAtomic(envelopePath, canonicalJsonBytes(envelope), 'owenloop publish');
    removePublicationSidecar(markerPath);
    if (originSource !== undefined && originEnvelope !== undefined) {
      writeBundleFileAtomic(originPath, canonicalJsonBytes(originEnvelope), 'owenloop publish');
    } else {
      removePublicationSidecar(originPath);
    }
    print(io, {
      ok: true,
      bundle: outputAbs,
      digest: packed.digest,
      name: packed.manifest.package.name,
      version: packed.manifest.package.version,
      signed: true,
      envelope: envelopePath,
      ...(originSource !== undefined ? { origin: originPath } : {}),
    });
  }
  return 0;
}

const TRUST_USAGE =
  'usage: owenloop trust init [--force] | ' +
  'owenloop trust grant --key <pubkey-path> --principal <human|machine|agent>:<id> ' +
  '[--pools a,b|*] [--labels a,b|*] [--namespaces a,b|*] [--delegate no|<n>|unbounded] ' +
  '[--signing-key <path>] [--output <file>] | ' +
  'owenloop trust revoke --key <SHA256:…> --principal <kind>:<id> ' +
  '[--reason <text>] [--effective-from <epochMs>] [--signing-key <path>] [--output <file>]';

function trustRequiredOption(args: Args, key: string): string {
  const value = last(args, key);
  if (value === undefined || value === '' || value === 'true') {
    throw new CliError(`missing required option: --${key} (${TRUST_USAGE})`);
  }
  return value;
}

function trustOptionalOption(args: Args, key: string): string | undefined {
  const value = last(args, key);
  if (value === 'true') throw new CliError(`--${key} requires a value (${TRUST_USAGE})`);
  return value;
}

function parseTrustPrincipal(raw: string): PrincipalReference {
  const match = /^(human|machine|agent):(.+)$/.exec(raw);
  const kind = match?.[1];
  const id = match?.[2];
  if (kind === undefined || id === undefined || id === '') {
    throw new CliError(`invalid --principal '${raw}': expected human|machine|agent:<id> (${TRUST_USAGE})`);
  }
  return { kind: kind as PrincipalReference['kind'], id };
}

function parseTrustAxis(args: Args, key: string): string[] | '*' {
  const raw = trustOptionalOption(args, key);
  if (raw === undefined) return [];
  if (raw === '*') return '*';
  const values = raw.split(',').map((value) => value.trim());
  if (values.length === 0 || values.some((value) => value === '')) {
    throw new CliError(`invalid --${key} '${raw}': expected a comma-separated list or * (${TRUST_USAGE})`);
  }
  return values;
}

function parseTrustDelegation(args: Args): { allowed: false } | { allowed: true; maxDepth: number | 'unbounded' } {
  const raw = trustOptionalOption(args, 'delegate') ?? 'no';
  if (raw === 'no') return { allowed: false };
  if (raw === 'unbounded') return { allowed: true, maxDepth: 'unbounded' };
  if (!/^\d+$/.test(raw)) {
    throw new CliError(`invalid --delegate '${raw}': expected no, a non-negative integer, or unbounded (${TRUST_USAGE})`);
  }
  const maxDepth = Number(raw);
  if (!Number.isSafeInteger(maxDepth)) {
    throw new CliError(`invalid --delegate '${raw}': integer is too large (${TRUST_USAGE})`);
  }
  return { allowed: true, maxDepth };
}

function parseTrustKeyId(raw: string): string {
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(raw)) {
    throw new CliError(`invalid --key '${raw}': expected SHA256:<base64 fingerprint> (${TRUST_USAGE})`);
  }
  return raw;
}

function trustKeyHash(keyid: string): string {
  return createHash('sha256').update(keyid).digest('hex');
}

function assertTrustPath(path: string, label: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new CliError(`owenloop trust: ${label} '${path}' is a symlink`);
  if (stat !== undefined && !stat.isFile()) {
    throw new CliError(`owenloop trust: ${label} '${path}' is not a regular file`);
  }
}

function writeTrustEnvelope(path: string, envelope: unknown): void {
  const parent = dirname(path);
  mkdirRefusingSymlink(parent);
  assertTrustPath(path, 'output');
  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(join(parent, '.owenloop-trust-'));
    chmodSync(tempDir, 0o700);
    const temp = join(tempDir, basename(path));
    writeFileSync(temp, canonicalJsonBytes(envelope), { mode: 0o644, flag: 'wx' });
    renameSync(temp, path);
  } catch (error) {
    throw new CliError(`owenloop trust: cannot write '${path}': ${(error as Error).message}`);
  } finally {
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  }
}

function publicKeyForSigningPath(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) throw new CliError(`owenloop trust: signing key '${path}' does not exist`);
  if (stat.isSymbolicLink()) throw new CliError(`owenloop trust: signing key '${path}' is a symlink`);
  if (!stat.isFile()) throw new CliError(`owenloop trust: signing key '${path}' is not a regular file`);

  try {
    const text = readFileSync(path, 'utf8');
    const first = text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
    if (/^(ssh-|ecdsa-|sk-)/.test(first)) return text;
  } catch {
    // ssh-keygen below supplies the stable failure classification.
  }
  const result = spawnSync('ssh-keygen', ['-y', '-f', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new CliError(`owenloop trust: cannot derive public key from signing key '${path}'`);
  }
  return result.stdout;
}

function signingKeyInfo(io: CliIO, explicitPath: string | undefined): { path: string; publicKey: string; keyid: string } {
  const path = explicitPath ?? orgRootPrivateKeyPath(io.env);
  let publicKey: string;
  if (explicitPath === undefined) {
    const root = resolveOrgRoot(io.env);
    if (root.kind === 'absent') {
      throw new CliError(`owenloop trust: org root is absent at '${root.path}' — run \`owenloop trust init\``);
    }
    publicKey = root.publicKey;
  } else {
    publicKey = publicKeyForSigningPath(path);
  }
  try {
    assertEd25519PubText(publicKey, 'signing key');
    const descriptor = publicKeyDescriptor(publicKey);
    return { path, publicKey: descriptor.openSshPublicKey, keyid: descriptor.keyid };
  } catch (error) {
    throw new CliError(`owenloop trust: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function trustEnvelopeOutput(args: Args, cwd: string, explicitDefault: string): string {
  const output = trustOptionalOption(args, 'output');
  return resolve(cwd, output ?? explicitDefault);
}

function ensureTrustRootDirectory(env: Record<string, string | undefined>): string {
  const privatePath = orgRootPrivateKeyPath(env);
  const directory = dirname(privatePath);
  mkdirRefusingSymlink(directory);
  chmodSync(directory, 0o700);
  return directory;
}

function generateTrustRoot(io: CliIO, force: boolean): number {
  const directory = ensureTrustRootDirectory(io.env);
  const privatePath = orgRootPrivateKeyPath(io.env);
  const publicPath = orgRootPublicKeyPath(io.env);
  const privateStat = lstatSync(privatePath, { throwIfNoEntry: false });
  const publicStat = lstatSync(publicPath, { throwIfNoEntry: false });
  if (!force && (privateStat !== undefined || publicStat !== undefined)) {
    throw new CliError(`owenloop trust init: org root already exists under '${directory}' — pass --force to replace it`);
  }
  for (const [path, label] of [[privatePath, 'private key'], [publicPath, 'public key']] as const) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new CliError(`owenloop trust init: existing ${label} '${path}' is a symlink`);
    }
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) unlinkSync(path);
  }
  const result = spawnSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-N', '', '-C', 'owenloop org root', '-f', privatePath],
    { stdio: 'ignore' },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new CliError('owenloop trust init: ssh-keygen could not create the Ed25519 org root');
  }
  chmodSync(privatePath, 0o600);
  chmodSync(publicPath, 0o644);
  print(io, { ok: true, privateKey: privatePath, publicKey: publicPath });
  return 0;
}

/** `owenloop trust init|grant|revoke` — offline enrollment-record minting. */
async function dispatchTrust(io: CliIO, args: Args): Promise<number> {
  const sub = args.positionals[1];
  if (sub !== 'init' && sub !== 'grant' && sub !== 'revoke') {
    throw new CliError(`unknown trust subcommand '${sub ?? ''}' — ${TRUST_USAGE}`);
  }
  if (sub === 'init') {
    if (args.positionals.length !== 2) throw new CliError(`invalid trust init arguments — ${TRUST_USAGE}`);
    return generateTrustRoot(io, flag(args, 'force'));
  }

  if (args.positionals.length !== 2) throw new CliError(`invalid trust ${sub} arguments — ${TRUST_USAGE}`);
  const keyOption = trustRequiredOption(args, 'key');
  const principal = parseTrustPrincipal(trustRequiredOption(args, 'principal'));
  const signingPath = trustOptionalOption(args, 'signing-key');

  if (sub === 'grant') {
    const pools = parseTrustAxis(args, 'pools');
    const labels = parseTrustAxis(args, 'labels');
    const namespaces = parseTrustAxis(args, 'namespaces');
    const delegation = parseTrustDelegation(args);
    const publicKeyPath = resolve(io.cwd, keyOption);
    assertTrustPath(publicKeyPath, 'enrollment key');
    const keyText = (() => {
      try {
        return readFileSync(publicKeyPath, 'utf8');
      } catch (error) {
        throw new CliError(`owenloop trust grant: cannot read --key '${keyOption}': ${(error as Error).message}`);
      }
    })();
    let newKey;
    try {
      assertEd25519PubText(keyText, 'enrollment key');
      newKey = publicKeyDescriptor(keyText);
    } catch (error) {
      throw new CliError(`owenloop trust grant: ${error instanceof Error ? error.message : String(error)}`);
    }
    const signer = signingKeyInfo(io, signingPath);
    try {
      assertNoStrandedLegacyGrants(io.env);
    } catch (error) {
      throw new CliError(`owenloop trust grant: ${error instanceof Error ? error.message : String(error)}`);
    }
    const record: EnrollmentGrantRecord = {
      newKey: {
        keyid: newKey.keyid,
        keyType: newKey.keyType,
        openSshPublicKey: newKey.openSshPublicKey,
        ...(newKey.comment !== '' ? { comment: newKey.comment } : {}),
      },
      principal,
      scope: { pools, labels, namespaces, delegation },
      grantedBy: signer.keyid,
      validFrom: nowMs(),
    };
    const sshSigner = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath: signer.path });
    try {
      const signed = await dsseSignEnrollmentGrant(Buffer.from(canonicalJsonBytes(record)), sshSigner);
      const output = trustEnvelopeOutput(args, io.cwd, join(grantsDir(io.env), `${trustKeyHash(newKey.keyid)}.grant.dsse`));
      writeTrustEnvelope(output, signed.envelope);
      print(io, { ok: true, path: output, keyid: newKey.keyid, grantedBy: signer.keyid, principal, validFrom: record.validFrom });
    } finally {
      sshSigner.dispose();
    }
    return 0;
  }

  const revokedKey = parseTrustKeyId(keyOption);
  const reason = trustOptionalOption(args, 'reason');
  const rawEffective = trustOptionalOption(args, 'effective-from');
  let effectiveFrom: number | undefined;
  if (rawEffective !== undefined) {
    if (!/^\d+$/.test(rawEffective)) {
      throw new CliError(`invalid --effective-from '${rawEffective}': expected a non-negative epoch millisecond (${TRUST_USAGE})`);
    }
    effectiveFrom = Number(rawEffective);
    if (!Number.isSafeInteger(effectiveFrom)) {
      throw new CliError(`invalid --effective-from '${rawEffective}': integer is too large (${TRUST_USAGE})`);
    }
  }
  const signer = signingKeyInfo(io, signingPath);
  const issuedAt = nowMs();
  const cut = effectiveFrom ?? issuedAt;
  const record: RevocationRecord = {
    revokedKey,
    principal,
    revokedBy: signer.keyid,
    issuedAt,
    effectiveFrom: cut,
    backdated: cut < issuedAt,
    ...(reason !== undefined ? { reason } : {}),
  };
  const sshSigner = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath: signer.path });
  try {
    const signed = await dsseSignRevocation(Buffer.from(canonicalJsonBytes(record)), sshSigner);
    const output = trustEnvelopeOutput(args, io.cwd, join(revocationsDir(io.env), `${trustKeyHash(revokedKey)}.revocation.dsse`));
    writeTrustEnvelope(output, signed.envelope);
    print(io, {
      ok: true,
      path: output,
      revokedKey,
      revokedBy: signer.keyid,
      principal,
      issuedAt,
      effectiveFrom: cut,
      backdated: record.backdated,
    });
  } finally {
    sshSigner.dispose();
  }
  return 0;
}

/** Default pack output: `<package-name>-<version>.wnlp` next to the source directory. */
function defaultPackOutput(sourceAbs: string, name: string, version: string): string {
  return join(dirname(sourceAbs), `${name}-${version}.wnlp`);
}

/** Refuse an output path located inside the source tree (or equal to it). */
function assertOutputOutsideSource(outputAbs: string, sourceAbs: string): void {
  const sourcePrefix = sourceAbs.endsWith(sep) ? sourceAbs : sourceAbs + sep;
  if (outputAbs === sourceAbs || outputAbs.startsWith(sourcePrefix)) {
    throw new CliError(`owenloop bundle pack: output '${outputAbs}' is inside the source directory '${sourceAbs}'`);
  }
}

/** Read a `.wnlp` file from disk, converting fs failures into CliErrors. */
function readBundleCommandFile(io: CliIO, bundlePath: string): Buffer {
  const abs = resolve(io.cwd, bundlePath);
  try {
    return readFileSync(abs);
  } catch (e) {
    throw new CliError(`owenloop bundle: cannot read '${bundlePath}': ${(e as Error).message}`);
  }
}

/** Run a bundle API call, converting a BundleError into a CliError that keeps the stable code. */
function runBundle<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof BundleError) {
      throw new CliError(`owenloop bundle [${e.code}]: ${e.message}`);
    }
    throw e;
  }
}

/**
 * Write `bytes` to `outputAbs` atomically: a collision-safe sibling temporary
 * directory, then rename the temporary file over the destination. Temporary
 * state is cleaned on every failure and after success.
 */
function writeBundleFileAtomic(outputAbs: string, bytes: Uint8Array, operation = 'owenloop bundle pack'): void {
  let tempDir: string | undefined;
  try {
    tempDir = mkdtempSync(join(dirname(outputAbs), '.owenloop-pack-'));
    const tmp = join(tempDir, basename(outputAbs));
    writeFileSync(tmp, bytes, { mode: 0o644, flag: 'wx' });
    renameSync(tmp, outputAbs);
  } catch (e) {
    throw new CliError(`${operation}: cannot write output: ${(e as Error).message}`);
  } finally {
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  }
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
  add <bundle.wnlp | https://url> [--global]
                                         install a workflow BUNDLE into the content-addressed store
                                         (default: project store under the defs dir; --global: ~/.owenloop/workflows)
  add --recover [--global]               finish or undo a crash-interrupted install (offline; no network)
  bundle pack <source-dir> [--output <bundle.wnlp>]   pack a source directory into a deterministic .wnlp bundle
  bundle unpack <bundle.wnlp> <destination-dir>       unpack a .wnlp bundle into a new directory
  bundle inspect <bundle.wnlp>           strictly validate a .wnlp bundle and print its manifest/entries
  bundle digest <bundle.wnlp>            print the bundle's def digest (SHA-256 of the canonical tar)
  publish <source-dir> [--output <bundle.wnlp>] [--source <json>] [--unsigned] [--hub <origin>]
                                         pack a bundle and sign its canonical digest (signed by default)
  trust init [--force]                  create the local Ed25519 enrollment root
  trust grant --key <pubkey-path> --principal <kind>:<id> [--pools a,b|*] [--labels a,b|*] [--namespaces a,b|*] [--delegate no|<n>|unbounded] [--signing-key <path>] [--output <file>]
                                         mint an offline signed enrollment grant
  trust revoke --key <SHA256:…> --principal <kind>:<id> [--reason <text>] [--effective-from <epochMs>] [--signing-key <path>] [--output <file>]
                                         mint an offline signed revocation
  login [--hub <url>] [--with-token] [--as <slot>]   authenticate the CLI against a hub, verified via whoami (loopback OAuth, or --with-token from stdin)
  logout [--hub <url>] [--as <slot>]     delete the stored credential for a hub in one slot
  connect [--hub <url>] [--as <slot>]    bind this project to a hub and verify the stored credential (whoami)
  push [<defName>...] [--bundle <bundle.wnlp>] [--force] [--dry-run] [--hub <origin>] [--as <slot>] [--map <authored>=<org>]
    publish local workflow defs, or exact bundle-backed defs, to the safely resolved hub (server-diffed, idempotent)
                                         --as names the credential slot: human (default), agent, or agent:<account>
                                         --map records one authored=org capability mapping (repeatable); without it push records none
  install <owner>/<repo>[@ref] [<defName>...] [--map <authored>=<org>] [--accept-defaults] [--dry-run] [--hub <origin>] [--as <slot>]
                                         publish an OUTSIDE repo's defs to your hub under SCOPED capabilities (<defName>.<capability> by default)
                                         records the capability mapping BEFORE it publishes; it never writes into local workflows/ (that is \`add\`)
  start <defName> [--provide name=json ...] [--crew <name>] [--title <text>] [--modifier <name>] [--scope <label>] [--priority <low|normal|high>] [--hub <url>]
${' '.repeat(41)}start a published workflow on the bound hub (human credential)
${' '.repeat(41)}--modifier names one value from the def's declared \`modifiers:\` set; every
${' '.repeat(41)}step's capability is then offered as \`<capability>:<modifier>\`. Omit it and
${' '.repeat(41)}the run carries no modifier and its steps are offered on BARE capabilities.
${' '.repeat(41)}--scope is a free routing label recorded on the run — no registry, no fixed set.
${' '.repeat(41)}Omit it and the run is routed by the org's routes alone.
${' '.repeat(41)}--priority is one of low, normal, high. Omit it and the hub applies normal.
  cancel <workflow> [--reason <text>] [--hub <url>]
${' '.repeat(41)}cancel a running instance on the bound hub (human credential; agents cannot cancel).
${' '.repeat(41)}Closes every open lease so the run stops being re-offered, and records the
${' '.repeat(41)}terminal status \`cancelled\`. Cancelling an already-terminal instance is a no-op.
  instance show <workflow> [--hub <url>]
${' '.repeat(41)}print one instance's live state on the bound hub: whether it is done, what it
${' '.repeat(41)}owes, which steps are eligible or blocked, which runs are in flight, and whether
${' '.repeat(41)}the loaded def has drifted from the version the instance is pinned to, and whether
${' '.repeat(41)}the instance has reached a terminal status.
  agent new <name> [--crews <a,b>] [--scopes <a,b>] [--shift] [--hub <url>]   mint a new Scoped Identity on the hub and store its token in slot agent:<name> (the token is never printed; --shift = --scopes work,run)
  capability bind <capability> <crew> [--hub <url>]   add a crew to a workflow capability on the hub org — a capability may bind many crews (admin; human credential)
  capability unbind <capability> <crew> [--hub <url>]  remove one (capability, crew) route
  capability list [--hub <url>]               list the hub org's capability routes
  routing alerts [--workflow <wf>] [--limit <n>] [--hub <url>]
${' '.repeat(41)}list the hub org's routing alerts — newest first org-wide; --workflow scopes to
${' '.repeat(41)}one run and flips to oldest first. A \`binding-gap\` alert means the hub HELD an
${' '.repeat(41)}offer because its compound capability had no live crew binding.
  routing show <workflow> [--hub <url>]
${' '.repeat(41)}print one HUB run's routing: modifier, wait policy, alerts, resolution reports
${' '.repeat(41)}and escalations. Unrelated to the local \`show\`, which reads a def from sqlite.
  routing rule list [--hub <url>]           list the org's capability reroute rules in the order the hub tries them
  routing rule add <capability> <target> [--position <n>] [--hub <url>]   add one reroute rule — offer <capability> as <target> when it has no live crew binding (admin; idempotent per pair; no --position appends)
  routing rule rm <capability> <target> [--hub <url>]   remove one reroute rule (admin; a rule that was never there is a no-op)
  crew list [--hub <url>]                  list the hub org's crews with their members (includes the orphan crew once one exists)
  crew new <name> --kind personal|shared [--owner <memberId>] [--hub <url>]   create a crew on the hub org (admin, or own personal crew; human credential)
  crew rm <crewId> [--hub <url>]           delete a crew; work stamped to it moves to the org's orphan crew
  crew member add <crewId> <principalKind> <principalId> [--hub <url>]   add a member or agent to a crew
  crew member rm <crewId> <principalId> [--hub <url>]   remove a principal from a crew
  setup [--hub <url>] [--new-agent <name> | --replace-agent <name>] [--crews <a,b>] [--scopes <a,b>] [--reuse-ssh-key <path>]   converge this machine's install: human login, agent credential, signing keys, owenloop settings, plugins (idempotent)
  doctor [--hub <url>]                    check this machine's owenloop install and report each piece (read-only)
  roster show [crew]                      print the offline four-layer roster cascade and provenance
    roster org [--hub <url>]              read the live hub org-global and per-crew rosters (human credential)
    roster org put <capability> --candidate <harness>:<model>:<effort> [--crew <name>] [--hub <url>]
${' '.repeat(41)}replace one hub roster row (human admin credential)
    roster org rm <capability> [--crew <name>] [--hub <url>]
${' '.repeat(41)}remove one hub roster row (human admin credential)
    roster registry [--hub <url>]         list hub harnesses, models, and supported efforts (human credential)
    roster registry put <harness> [--model <model>:<effort,effort…>]… [--display-name <text>] [--hub <url>]
${' '.repeat(41)}replace a harness's hub model snapshot (human admin credential)
    roster sync [--hub <url>] [--as agent|agent:<account>]
${' '.repeat(41)}refresh the local hub-rosters cache with an agent credential
  enrollments [--hub <url>]               list the hub's relayed machine enrollment grants (read-only)
  mcp [--hub <url>]                       serve the hub control plane over stdio MCP (spawned by MCP hosts, not run by humans)
  work <subcommand> [args]                run execution-side shift/hold/exec/agent-run/... commands
  shift start|next|status|end [args]      run and attend a local Unix-socket shift daemon
  lint [<def-name>]                      check def(s) for wiring problems
  check <def> [--format text|json] [--max-depth N] [--max-states N] [--max-collection N] [--assume-provided] [--strict-inputs]
                                         bounded reachability check (stall states, true deadlocks, stuck, dead steps, declared invariants)
  create <def> [--title t] [--provide name=json ...] [--param k=v ...]
  provide <wf> <name> [--value json] [--hub <url>]  supply an owed (seedOwed) input
  adopt <wf>                             re-pin an instance to the current def (§28); settles new debts
  tick <wf> [--now <ms>] [--shallow] [--capability <c>]...  pull eligible orders (deep: also from calls: children; --shallow for this instance only; --capability filters to matching-capability steps)
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
  reject <wf> <path> --by <author> --text <msg> [--requested <modifier>] [--hub <url>]
  retract <wf> <path> --by <author> --text <msg>
  skip <wf> <path> --by <author> --text <msg>
  retry <wf> <path> [--by <author>] [--text <guidance>] [--hub <url>]   clear a §6 stall, or ANSWER an ask
  ask <wf> <path> <question> [--by <author>]   hold an owed artifact on a question for a human
  inbox                                  every held question across all instances, with its answer command
  heartbeat <wf> <run> [--now <ms>]    touch liveness timestamp on an open run
  close <wf> <run> [--outcome ok|no_work|released|failed|skipped] [--summary s]
  delete <wf> [--recursive]              refuse if children exist unless --recursive (cascades)

Environment: OWENLOOP_DB, OWENLOOP_DEFS`;

/** Append parse failures to a "definition not found" error — the def the user asked for may be in one of the broken files. */
function failureNote(failures: DefLoadFailure[]): string {
  if (failures.length === 0) return '';
  return `\n${failures.length} file(s) failed to load:\n  - ${failures.map((f) => `${f.file}: ${f.error}`).join('\n  - ')}`;
}

// The shared definite-defect predicate now lives in the engine core (model.ts)
// so the workflow-store installer (src/store/install.ts — engine core, no CLI
// imports) can run the identical acceptance gate without coupling to this
// module. Re-exported here to keep the existing CLI/test import surface.
export { hasDefiniteCheckDefect };

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
  ['add', cmdOpts('recover', 'global')],
  ['bundle', cmdOpts('output')],
  ['login', cmdOpts('hub', 'with-token', 'as')],
  ['logout', cmdOpts('hub', 'as')],
  ['connect', cmdOpts('hub', 'as')],
  ['publish', cmdOpts('unsigned', 'output', 'source', 'hub')],
  ['trust', cmdOpts('force', 'key', 'principal', 'pools', 'labels', 'namespaces', 'delegate', 'signing-key', 'output', 'reason', 'effective-from')],
  ['push', cmdOpts('dry-run', 'force', 'hub', 'as', 'bundle', 'map')],
  ['install', cmdOpts('hub', 'as', 'map', 'accept-defaults', 'dry-run')],
  ['start', cmdOpts('hub', 'crew', 'title', 'provide', 'modifier', 'scope', 'priority')],
  ['cancel', cmdOpts('hub', 'reason')],
  ['instance', cmdOpts('hub')],
  ['agent', cmdOpts('crews', 'hub', 'scopes', 'shift')],
  ['capability', cmdOpts('hub')],
  // Per-TOP-LEVEL-command allowlist, not per-subcommand: `--position` on
  // `routing alerts` is meaningless but accepted and ignored, exactly as
  // `--kind` is on `crew list`. Policing flags per subcommand is deliberately
  // not built here.
  ['routing', cmdOpts('hub', 'workflow', 'limit', 'position')],
  ['crew', cmdOpts('hub', 'kind', 'owner')],
  ['setup', cmdOpts('hub', 'new-agent', 'replace-agent', 'crews', 'scopes', 'reuse-ssh-key')],
  ['doctor', cmdOpts('hub')],
  ['roster', cmdOpts('hub', 'crew', 'candidate', 'display-name', 'model', 'as')],
  ['enrollments', cmdOpts('hub')],
  ['mcp', cmdOpts('hub')],
  ['work', cmdOpts()],
  ['shift', cmdOpts('all', 'origin', 'as', 'name', 'cap', 'max-agents', 'poll-interval', 'once', 'cache-dir', 'state-dir', 'wait')],
  ['lint', cmdOpts()],
  ['check', cmdOpts('format', 'max-depth', 'max-states', 'max-collection', 'assume-provided', 'strict-inputs')],
  ['create', cmdOpts('title', 'provide', 'param')],
  ['provide', cmdOpts('value', 'hub')],
  ['adopt', cmdOpts()],
  ['tick', cmdOpts('now', 'shallow', 'capability')],
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
  ['reject', cmdOpts('by', 'text', 'requested', 'hub')],
  ['retract', cmdOpts('by', 'text')],
  ['skip', cmdOpts('by', 'text')],
  ['retry', cmdOpts('by', 'text', 'hub')],
  ['ask', cmdOpts('by', 'question')],
  ['inbox', cmdOpts()],
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

function rosterAge(fetchedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - fetchedAt) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

// Keep these wire checks aligned with hub-core's roster and harness verbs.
// This CLI is a separately deployable client, so it mirrors the public
// contract rather than importing the service implementation.
const MAX_ROSTER_IDENTIFIER_LENGTH = 200;
const MAX_ROSTER_CAPABILITY_LENGTH = 64;
const MAX_ROSTER_CANDIDATES = 32;
const MAX_HARNESS_MODELS = 256;
const ROSTER_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
/**
 * The run's rate-limit priority band. Fixed by the routing plan's §4.8 wire
 * contract, not by hub discretion, so an out-of-set value is a local usage
 * error rather than a forwarded request the hub has to refuse.
 */
const START_PRIORITIES: ReadonlySet<string> = new Set(['low', 'normal', 'high']);

function isRosterIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ROSTER_IDENTIFIER_LENGTH && value.trim() === value;
}

function parseRosterIdentifier(value: string, label: string): string {
  if (!isRosterIdentifier(value)) {
    throw new CliError(`${label} must be a trimmed, non-empty string of at most ${MAX_ROSTER_IDENTIFIER_LENGTH} characters`);
  }
  return value;
}

function parseRosterCapability(value: string): string {
  const capability = value.trim();
  if (capability === '') throw new CliError('capability must not be empty');
  if (capability.length > MAX_ROSTER_CAPABILITY_LENGTH) {
    throw new CliError(`capability must be at most ${MAX_ROSTER_CAPABILITY_LENGTH} characters`);
  }
  if (capability.startsWith('personal:')) throw new CliError("capability must not start with the reserved prefix 'personal:'");
  return capability;
}

function isRosterCapability(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length > 0 &&
    value.length <= MAX_ROSTER_CAPABILITY_LENGTH && !value.startsWith('personal:');
}

function isRosterCrewName(value: unknown): value is string {
  // `personal:<id>`, slash, backslash, and `..` are all valid hub names. Only
  // the service's ordinary non-empty, trimmed, 64-character crew invariant is
  // relevant at this transport boundary.
  return typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 64;
}

function isRosterEffort(value: unknown): value is string {
  return typeof value === 'string' && ROSTER_EFFORTS.has(value);
}

function parseRosterDisplayName(value: string): string {
  if (value.length > MAX_ROSTER_IDENTIFIER_LENGTH) {
    throw new CliError(`displayName must be a string of at most ${MAX_ROSTER_IDENTIFIER_LENGTH} characters`);
  }
  return value;
}

function parseRosterCandidate(value: string): { harness: string; model: string; effort: string } {
  const first = value.indexOf(':');
  const lastColon = value.lastIndexOf(':');
  if (first <= 0 || lastColon <= first || lastColon === value.length - 1) {
    throw new CliError(`invalid --candidate '${value}' — expected <harness>:<model>:<effort>`);
  }
  const harness = parseRosterIdentifier(value.slice(0, first), 'candidate harness');
  const model = parseRosterIdentifier(value.slice(first + 1, lastColon), 'candidate model');
  const effort = value.slice(lastColon + 1);
  if (!isRosterEffort(effort)) {
    throw new CliError(`invalid --candidate '${value}' — effort must be one of low, medium, high, xhigh, max`);
  }
  return { harness, model, effort };
}

function parseRegistryModel(value: string): { model: string; efforts: string[] } {
  const colon = value.lastIndexOf(':');
  if (colon <= 0) {
    throw new CliError(`invalid --model '${value}' — expected <model>:<effort,effort…>`);
  }
  const model = parseRosterIdentifier(value.slice(0, colon), 'model');
  const rawEfforts = value.slice(colon + 1);
  // The service permits an empty effort list. A malformed member (including
  // `high,`) still fails before hub/credential I/O, matching its `isEffort`.
  const efforts = rawEfforts === '' ? [] : rawEfforts.split(',');
  if (efforts.some((effort) => !isRosterEffort(effort))) {
    throw new CliError(`invalid --model '${value}' — efforts must be drawn from low, medium, high, xhigh, max`);
  }
  return { model, efforts };
}

type RosterMutationSuccess =
  | { crewId: string | null; crewName: string | null; capability: string; candidates: Array<{ harness: string; model: string; effort: string }>; warnings: string[] }
  | { crewId: string | null; capability: string; removed: boolean }
  | { harness: string; displayName: string; models: Array<{ model: string; efforts: string[]; updatedAt: number; updatedBy: string }> };

function nullableId(value: unknown, prefix: string, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value === '') throw new CliError(`${prefix} — ${field} must be a non-empty string or null`);
  return value;
}

/** Narrow each mutation response before stdout claims the write succeeded. */
function validateRosterMutationSuccess(endpoint: string, body: unknown): RosterMutationSuccess {
  const prefix = `${endpoint}: malformed success response`;
  const row = recordOf(body);
  if (row === null) throw new CliError(`${prefix} — not an object`);
  if (endpoint === 'put_roster') {
    const crewId = nullableId(row.crewId, prefix, 'crewId');
    const crewName = nullableId(row.crewName, prefix, 'crewName');
    if (!isRosterCapability(row.capability)) throw new CliError(`${prefix} — missing valid capability`);
    if (!Array.isArray(row.candidates)) throw new CliError(`${prefix} — missing array candidates`);
    const candidates = row.candidates.map((candidate, index) => {
      const value = recordOf(candidate);
      if (value === null) throw new CliError(`${prefix} — candidates[${index}] is not an object`);
      if (!isRosterIdentifier(value.harness) || !isRosterIdentifier(value.model) || !isRosterEffort(value.effort)) {
	throw new CliError(`${prefix} — candidates[${index}] has an invalid harness, model, or effort`);
      }
      return { harness: value.harness as string, model: value.model as string, effort: value.effort as string };
    });
    if (!Array.isArray(row.warnings) || row.warnings.some((warning) => typeof warning !== 'string')) {
      throw new CliError(`${prefix} — missing array warnings`);
    }
    return { crewId, crewName, capability: row.capability, candidates, warnings: row.warnings as string[] };
  }
  if (endpoint === 'delete_roster_row') {
    const crewId = nullableId(row.crewId, prefix, 'crewId');
    if (!isRosterCapability(row.capability)) throw new CliError(`${prefix} — missing valid capability`);
    if (typeof row.removed !== 'boolean') throw new CliError(`${prefix} — missing boolean removed`);
    return { crewId, capability: row.capability, removed: row.removed };
  }
  if (!isRosterIdentifier(row.harness)) throw new CliError(`${prefix} — missing valid harness`);
  if (typeof row.displayName !== 'string' || row.displayName.length > MAX_ROSTER_IDENTIFIER_LENGTH) {
    throw new CliError(`${prefix} — displayName must be a string of at most ${MAX_ROSTER_IDENTIFIER_LENGTH} characters`);
  }
  if (!Array.isArray(row.models)) throw new CliError(`${prefix} — missing array models`);
  const models = row.models.map((model, index) => {
    const value = recordOf(model);
    if (value === null) throw new CliError(`${prefix} — models[${index}] is not an object`);
    if (!isRosterIdentifier(value.model)) throw new CliError(`${prefix} — models[${index}] missing valid model`);
    if (!Array.isArray(value.efforts) || value.efforts.some((effort) => !isRosterEffort(effort))) {
      throw new CliError(`${prefix} — models[${index}] missing array efforts`);
    }
    if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) throw new CliError(`${prefix} — models[${index}] missing finite number updatedAt`);
    if (typeof value.updatedBy !== 'string' || value.updatedBy === '') throw new CliError(`${prefix} — models[${index}] missing non-empty string updatedBy`);
    return { model: value.model, efforts: value.efforts as string[], updatedAt: value.updatedAt, updatedBy: value.updatedBy };
  });
  return { harness: row.harness, displayName: row.displayName, models };
}

function validateRosterRows(value: unknown, prefix: string): Record<string, Array<{ harness: string; model: string; effort: string }>> {
  const row = recordOf(value);
  if (row === null) throw new CliError(`${prefix} — roster must be an object`);
  // Hub capability names may legally collide with Object.prototype (notably
  // `__proto__`). A normal object assignment would mutate/drop that row.
  const result = Object.create(null) as Record<string, Array<{ harness: string; model: string; effort: string }>>;
  for (const [capability, candidates] of Object.entries(row)) {
    if (!isRosterCapability(capability)) throw new CliError(`${prefix} — invalid capability ${JSON.stringify(capability)}`);
    if (!Array.isArray(candidates)) throw new CliError(`${prefix} — ${capability} must be an array`);
    result[capability] = candidates.map((candidate, index) => {
      const item = recordOf(candidate);
      if (item === null || !isRosterIdentifier(item.harness) || !isRosterIdentifier(item.model) || !isRosterEffort(item.effort)) {
	throw new CliError(`${prefix} — ${capability}[${index}] must contain valid harness, model, and effort`);
      }
      return { harness: item.harness as string, model: item.model as string, effort: item.effort as string };
    });
  }
  return result;
}

function validateGetRostersSuccess(body: unknown): { global: Record<string, Array<{ harness: string; model: string; effort: string }>>; crews: Array<{ crewId: string; crewName: string | null; roster: Record<string, Array<{ harness: string; model: string; effort: string }>> }> } {
  const prefix = 'rosters: malformed success response';
  const row = recordOf(body);
  if (row === null || !Array.isArray(row.crews)) throw new CliError(`${prefix} — expected global object and crews array`);
  return {
    global: validateRosterRows(row.global, prefix),
    crews: row.crews.map((crew, index) => {
      const item = recordOf(crew);
      if (item === null || typeof item.crewId !== 'string' || item.crewId === '' || !(isRosterCrewName(item.crewName) || item.crewName === null)) {
	throw new CliError(`${prefix} — crews[${index}] has an invalid identity`);
      }
      return { crewId: item.crewId, crewName: item.crewName, roster: validateRosterRows(item.roster, `${prefix} — crews[${index}].roster`) };
    }),
  };
}

function validateHarnessModelsSuccess(body: unknown): { harnesses: Array<{ harness: string; displayName: string }>; models: Array<{ harness: string; model: string; efforts: string[]; updatedAt: number; updatedBy: string }> } {
  const prefix = 'harness_models: malformed success response';
  const row = recordOf(body);
  if (row === null || !Array.isArray(row.harnesses) || !Array.isArray(row.models)) throw new CliError(`${prefix} — expected harnesses and models arrays`);
  return {
    harnesses: row.harnesses.map((harness, index) => {
      const item = recordOf(harness);
      if (item === null || !isRosterIdentifier(item.harness) || typeof item.displayName !== 'string' || item.displayName.length > MAX_ROSTER_IDENTIFIER_LENGTH) throw new CliError(`${prefix} — harnesses[${index}] is invalid`);
      return { harness: item.harness, displayName: item.displayName };
    }),
    models: row.models.map((model, index) => {
      const item = recordOf(model);
      if (item === null || !isRosterIdentifier(item.harness) || !isRosterIdentifier(item.model) || !Array.isArray(item.efforts) || item.efforts.some((effort) => !isRosterEffort(effort)) || typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt) || typeof item.updatedBy !== 'string' || item.updatedBy === '') throw new CliError(`${prefix} — models[${index}] is invalid`);
      return { harness: item.harness, model: item.model, efforts: item.efforts as string[], updatedAt: item.updatedAt, updatedBy: item.updatedBy };
    }),
  };
}

/** `roster` uses the same authenticated REST ladders as `routing`; show stays
 * fully offline so it reports exactly what an agent-run child would route. */
async function dispatchRoster(io: CliIO, args: Args): Promise<number> {
  const USAGE_FORMS =
    'usage: owenloop roster show [crew] | owenloop roster org [--hub <url>] | ' +
    'owenloop roster org put <capability> [--crew <name>] --candidate <harness>:<model>:<effort>… [--hub <url>] | ' +
    'owenloop roster org rm <capability> [--crew <name>] [--hub <url>] | ' +
    'owenloop roster registry [--hub <url>] | owenloop roster registry put <harness> [--display-name <text>] [--model <model>:<effort,effort…>]… [--hub <url>] | ' +
    'owenloop roster sync [--hub <url>] [--as agent|agent:<account>]';
  const sub = args.positionals[1];
  if (sub !== 'show' && sub !== 'org' && sub !== 'registry' && sub !== 'sync') {
    throw new CliError(`unknown roster subcommand '${sub ?? ''}' — ${USAGE_FORMS}`);
  }

  // `COMMAND_OPTIONS` admits the union of every roster flag. Narrow it again
  // by command form before even an offline read or credential lookup, so a
  // typo never looks like a successful command that silently ignored intent.
  const assertFormOptions = (allowed: readonly string[]): void => {
    // `--db` and `--defs` are global CLI options. They are admitted before
    // dispatch for every command and must remain accepted here too; this
    // narrower check is only for roster-form-specific flags.
    const allowedSet = new Set([...GLOBAL_OPTIONS, ...allowed]);
    const disallowed = [...args.options.keys()].filter((option) => !allowedSet.has(option));
    if (disallowed.length > 0) {
      throw new CliError(`${disallowed.map((option) => `--${option}`).join(', ')} ${disallowed.length === 1 ? 'is' : 'are'} not valid for this roster command (${USAGE_FORMS})`);
    }
  };

  if (sub === 'show') {
    assertFormOptions([]);
    if (args.positionals.length > 3) throw new CliError(USAGE_FORMS);
    const crew = args.positionals[2];
    const settings = loadSettings(io.env);
    const account = io.env.OWENLOOP_ACCOUNT ?? 'default';
    const layers = effectiveRosterLayers(io.env, crew, { origin: settings.hubOrigin, account });
    const merged = mergeRosterLayers(layers);
    const cache = settings.hubOrigin === undefined ? undefined : readHubRosterCache(io.env, settings.hubOrigin, account);
    if (Object.keys(merged).length === 0) io.out(crew === undefined ? 'no roster layers found' : `no roster rows found for crew ${crew}`);
    for (const capability of Object.keys(merged).sort()) {
      const entry = merged[capability]!;
      io.out(`${capability}:`);
      for (const [index, candidate] of entry.candidates.entries()) {
	io.out(`  [${index}] harness=${candidate.harness} model=${candidate.model} effort=${candidate.effort} from ${entry.source}`);
      }
    }
    io.out('layers inspected:');
    for (const layer of layers) {
      const age = layer.source.startsWith('hub ') && cache?.kind === 'hit' ? `; ${rosterAge(cache.data.fetchedAt)}` : '';
      io.out(`  ${layer.source}: ${layer.roster === undefined ? 'absent' : 'found'}${layer.path === undefined ? '' : ` (${layer.path})`}${age}`);
    }
    const shadows = explainRosterShadows(layers);
    const shadowed = Object.entries(shadows).filter(([, detail]) => detail.shadowed.length > 0).sort(([a], [b]) => a.localeCompare(b));
    if (shadowed.length > 0) {
      io.out('shadowed:');
      for (const [capability, detail] of shadowed) {
	io.out(`  ${capability}: ${detail.winner} wins; ${detail.shadowed.map((row) => `${row.source} (${row.candidateCount} candidate${row.candidateCount === 1 ? '' : 's'})`).join(', ')} shadowed`);
      }
    }
    return 0;
  }

  let orgSub: 'get' | 'put' | 'rm' | undefined;
  let registrySub: 'get' | 'put' | undefined;
  let capability = '';
  let harness = '';
  if (sub === 'org') {
    const nested = args.positionals[2];
    if (nested === undefined) orgSub = 'get';
    else if (nested === 'put' || nested === 'rm') orgSub = nested;
    else throw new CliError(`unknown roster org subcommand '${nested}' — ${USAGE_FORMS}`);
    if (orgSub === 'put' || orgSub === 'rm') {
      capability = parseRosterCapability(args.positionals[3] ?? '');
    }
    const maxPositionals = orgSub === 'get' ? 2 : 4;
    if (args.positionals.length > maxPositionals) throw new CliError(USAGE_FORMS);
    assertFormOptions(orgSub === 'get' ? ['hub'] : orgSub === 'put' ? ['hub', 'crew', 'candidate'] : ['hub', 'crew']);
    if (orgSub === 'put' && all(args, 'candidate').length === 0) throw new CliError(`missing required --candidate (${USAGE_FORMS})`);
  } else if (sub === 'registry') {
    const nested = args.positionals[2];
    if (nested === undefined) registrySub = 'get';
    else if (nested === 'put') registrySub = 'put';
    else throw new CliError(`unknown roster registry subcommand '${nested}' — ${USAGE_FORMS}`);
    if (registrySub === 'put') harness = parseRosterIdentifier(args.positionals[3] ?? '', 'harness');
    const maxPositionals = registrySub === 'get' ? 2 : 4;
    if (args.positionals.length > maxPositionals) throw new CliError(USAGE_FORMS);
    assertFormOptions(registrySub === 'get' ? ['hub'] : ['hub', 'display-name', 'model']);
  } else if (args.positionals.length > 2) {
    throw new CliError(USAGE_FORMS);
  } else {
    assertFormOptions(['hub', 'as']);
  }

  const crewOption = last(args, 'crew');
  if (crewOption !== undefined && (args.missingOptionValues.has('crew') || crewOption.trim() === '')) {
    throw new CliError(`--crew requires a non-empty crew name (${USAGE_FORMS})`);
  }
  if (crewOption !== undefined && !isRosterCrewName(crewOption)) {
    throw new CliError('--crew must be a trimmed, non-empty crew name of at most 64 characters');
  }

  // Finish every command-local parse before resolving a hub or consulting the
  // credential backend. An invalid payload is a usage error, not a reason to
  // run an external credential helper or mask it as a missing credential.
  let parsedCandidates: Array<{ harness: string; model: string; effort: string }> | undefined;
  let parsedModels: Array<{ model: string; efforts: string[] }> | undefined;
  let parsedDisplayName: string | undefined;
  if (sub === 'org' && orgSub === 'put') {
    const rawCandidates = all(args, 'candidate');
    if (rawCandidates.length > MAX_ROSTER_CANDIDATES) {
      throw new CliError(`--candidate may be supplied at most ${MAX_ROSTER_CANDIDATES} times`);
    }
    parsedCandidates = rawCandidates.map(parseRosterCandidate);
    const candidateKeys = new Set<string>();
    for (const candidate of parsedCandidates) {
      const key = JSON.stringify([candidate.harness, candidate.model, candidate.effort]);
      if (candidateKeys.has(key)) throw new CliError('duplicate --candidate harness, model, and effort triple');
      candidateKeys.add(key);
    }
  }
  if (sub === 'registry' && registrySub === 'put') {
    const displayNames = all(args, 'display-name');
    if (displayNames.length > 1) throw new CliError('--display-name may be supplied at most once');
    if (displayNames.length > 0 && args.missingOptionValues.has('display-name')) {
      throw new CliError('--display-name requires a value');
    }
    if (displayNames.length === 1) parsedDisplayName = parseRosterDisplayName(displayNames[0]!);
    const rawModels = all(args, 'model');
    if (rawModels.length > MAX_HARNESS_MODELS) throw new CliError(`--model may be supplied at most ${MAX_HARNESS_MODELS} times`);
    // A zero-model full snapshot is a supported way to clear the advisory
    // registry. An empty display label is likewise a deliberate service value.
    parsedModels = rawModels.map(parseRegistryModel);
    const modelNames = new Set<string>();
    for (const model of parsedModels) {
      if (modelNames.has(model.model)) throw new CliError(`duplicate --model '${model.model}'`);
      modelNames.add(model.model);
    }
  }

  // `roster sync` is an agent-owned cache refresh. Unlike the other roster
  // verbs, its omitted `--as` deliberately means the default agent slot.
  const slot: CredentialSlotSelector = sub === 'sync'
    ? (!args.options.has('as') ? { principal: 'agent' } : resolveSlot(args))
    : { principal: 'human' };
  if (sub === 'sync' && slot.principal !== 'agent') {
    throw new CliError(`roster sync requires an agent credential — pass --as agent or --as agent:<account> (${USAGE_FORMS})`);
  }

  const origin = resolveAgentHub(io, args, sub === 'sync' ? 'sync rosters from' : 'manage rosters on');
  const cred = readCredential(io, origin, slot);
  if (cred === null) throw new CliError(emptySlotMessage(origin, slot), { exitCode: 3 });

  const getJson = async (path: string, prefix: string): Promise<unknown> => {
    const { res, cred: used } = await authedGet(io, origin, slot, cred, path);
    if (res.status === 401) {
      throw new CliError(
	used.kind === 'agent'
	  ? 'token revoked or invalid — re-mint it in the console or run `owenloop login`'
	  : 'credential rejected by the hub — run `owenloop login`',
	{ exitCode: 3 },
      );
    }
    if (!res.ok) throw new CliError((await hubRequestMessage(res)) ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
    try {
      return await res.json() as unknown;
    } catch {
      throw new CliError(`${prefix}: malformed response — body is not valid JSON`);
    }
  };

  if (sub === 'sync') {
    const account = slot.principal === 'agent' ? slot.account ?? 'default' : 'default';
    // Use the same sync helper as shift start and periodic refresh. The local
    // adapter preserves the CLI's credential-refresh/error ladder rather than
    // bypassing it with a second raw-fetch implementation.
    const cacheClient = {
      whoami: async () => getJson('/api/whoami', 'whoami') as Promise<WhoamiResponse>,
      getRosters: async () => getJson('/api/rosters', 'rosters') as Promise<GetRostersResponse>,
    } as HubClient;
    await syncHubRosterCache({
      client: cacheClient,
      env: io.env,
      origin,
      account,
    });
    const cache = readHubRosterCache(io.env, origin, account);
    if (cache.kind !== 'hit') throw new CliError(`roster sync wrote no readable cache: ${cache.reason}`);
    print(io, { ok: true, hub: origin, cachePath: cache.path, fetchedAt: cache.data.fetchedAt });
    return 0;
  }

  if (sub === 'org' && orgSub === 'get') {
    print(io, { ok: true, hub: origin, rosters: validateGetRostersSuccess(await getJson('/api/rosters', 'rosters')) });
    return 0;
  }
  if (sub === 'registry' && registrySub === 'get') {
    print(io, { ok: true, hub: origin, registry: validateHarnessModelsSuccess(await getJson('/api/harness_models', 'harness_models')) });
    return 0;
  }

  let endpoint: string;
  let payload: Record<string, unknown>;
  if (sub === 'org' && orgSub === 'put') {
    endpoint = 'put_roster';
    payload = { capability, candidates: parsedCandidates!, ...(crewOption === undefined ? {} : { crew: crewOption }) };
  } else if (sub === 'org') {
    endpoint = 'delete_roster_row';
    payload = { capability, ...(crewOption === undefined ? {} : { crew: crewOption }) };
  } else {
    endpoint = 'put_harness_models';
    payload = { harness, models: parsedModels!, ...(parsedDisplayName === undefined ? {} : { displayName: parsedDisplayName }) };
  }
  const { res } = await authedPost(io, origin, slot, cred, `/api/${endpoint}`, payload);
  if (res.status === 401) throw new CliError('credential rejected by the hub — run `owenloop login`', { exitCode: 3 });
  if (!res.ok) throw new CliError((await hubRequestMessage(res)) ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
  let body: unknown;
  try {
    body = await res.json() as unknown;
  } catch {
    throw new CliError(`${endpoint}: malformed success response — body is not valid JSON`);
  }
  const result = validateRosterMutationSuccess(endpoint, body);
  print(io, { ok: true, hub: origin, result });
  return 0;
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
    // `--strict-inputs` restores the pre-existing seedOwed-starts-owed behavior;
    // it takes precedence over `--assume-provided` when both are passed (the
    // newer explicit opt-out wins; `--assume-provided` is otherwise redundant
    // with the new default and is kept only so it never errors as unknown).
    const strictInputs = flag(args, 'strict-inputs');

    const bounds = {
      ...(maxDepth !== undefined ? { maxDepth } : {}),
      ...(maxStates !== undefined ? { maxStates } : {}),
      ...(maxCollection !== undefined ? { maxCollectionSize: maxCollection } : {}),
    };

    const report = modelCheck(def, { ...bounds, assumeProvided: !strictInputs });

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
      if (strictInputs) {
        const seedOwedNames = def.inputs.filter((i) => i.seedOwed).map((i) => i.name);
        const initialDeadlock = report.deadlocks.some((d) => d.path.length === 0);
        if (seedOwedNames.length > 0 && initialDeadlock) {
          // precision: would treating seedOwed inputs as provided dissolve the
          // initial-state deadlock? If so, it's caused solely by unprovided
          // seedOwed inputs, not a structural defect — print a hint pointing at
          // the new default. This never fires for a deadlock that survives
          // providing the seeded inputs (a structural one).
          const probe = modelCheck(def, { ...bounds, assumeProvided: true });
          const clearedByProvide = !probe.deadlocks.some((d) => d.path.length === 0);
          if (clearedByProvide) {
            io.out('');
            io.out(`Hint: the initial-state deadlock is caused solely by unprovided seedOwed input(s): ${seedOwedNames.join(', ')}.`);
            io.out(`      Seeded inputs are assumed provided by default; this appears only because --strict-inputs was passed.`);
            io.out(`      Re-run 'owenloop check ${def.name}' without --strict-inputs to check the real reachable space.`);
          }
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
    const hasDefiniteDefect = hasDefiniteCheckDefect(report);
    if (hasDefiniteDefect) {
      throw new CliError(
        `definite defects found (${report.invariantViolations.length} invariant violation(s), ` +
        `${report.structurallyDeadSteps.length} structurally dead step(s), ` +
        `${report.deadlocks.length} true deadlock(s))`,
      );
    }
    return 0;
  }

  // The bundle namespace is pure filesystem work on the bytes the user
  // points at — dispatched BEFORE openCtx so pack/inspect/digest neither
  // open/create `.owenloop/state.db` nor touch a remote (same reasoning as
  // lint/check above; see docs/cli.md).
  if (command === 'bundle') {
    return dispatchBundle(io, args);
  }

  const ctx = openCtx(io, args, command === 'status');
  const { engine, store } = ctx;
  if (command === 'status' && !ctx.definitionDiscoveryComplete) {
    io.err('warning: status is incomplete because workflow definition discovery skipped corrupt store state');
  }
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
        const tickOpts: { now?: number; deep?: boolean; capabilities?: string[] } = {};
        if (now !== undefined) tickOpts.now = now;
        if (flag(args, 'shallow')) tickOpts.deep = false;
        // A2: repeatable --capability narrows the claim to steps the caller's
        // capabilities match. Absent = no filter presented, so a local operator
        // still claims everything — NOT the same as presenting an empty list,
        // which is a crew that serves nothing and matches only capability-silent
        // steps. Only set the key when the operator actually named capabilities.
        const capabilities = all(args, 'capability');
        if (capabilities.length > 0) tickOpts.capabilities = capabilities;
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
        // Blocking poll so an orchestrator (Prime Agent or Shift) can wait for engine state
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
				const requested = last(args, 'requested');
				const rejectRes = engine.reject(wf, path, by, text, requested);
				print(io, { ok: true, action: 'reject', path, outcome: rejectRes.outcome, ...(requested !== undefined ? { requested } : {}) });
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
      case 'ask': {
        // The escalation verb: the producing step stops and asks a human about
        // the artifact IT owes. The answer is a plain `retry --text "<answer>"`
        // — deliberately no `answer` verb, because `retry` already appends a
        // structural reason, which is exactly what clears the hold and delivers
        // the text to the next attempt.
        const wf = need(args, 1, 'workflow');
        const path = need(args, 2, 'path');
        const question = need(args, 3, 'question');
        engine.ask(wf, path, last(args, 'by') ?? 'human', question);
        print(io, { ok: true, action: 'ask', path, question });
        return 0;
      }
      case 'inbox': {
        // THE OPERATOR SURFACE for `ask`. Without it the channel is write-only:
        // a step can raise a question and nothing ever displays it, which is
        // the exact failure this whole change exists to end. Reads the LOCAL db
        // across every instance (no workflow argument) because a person asking
        // "is anything waiting on me?" does not know which instance to name.
        //
        // Each row carries the ready-to-paste release command, because the
        // answer path (`retry --text`) is not guessable from the question.
        const rows: Array<Record<string, unknown>> = [];
        for (const w of store.listWorkflows()) {
          let st: ReturnType<Engine['status']>;
          try {
            st = engine.status(w.id);
          } catch {
            // An instance whose def no longer resolves cannot be asked about;
            // skip it rather than aborting the sweep (same stance as `--all`).
            continue;
          }
          for (const d of st.debts) {
            if (d.question === undefined) continue;
            rows.push({
              workflow: w.id,
              def: w.def,
              title: w.title ?? null,
              path: d.path,
              question: d.question,
              answer: `owenloop retry ${w.id} ${d.path} --text "<your answer>"`,
            });
          }
        }
        print(io, rows);
        return 0;
      }
      case 'close': {
        const wf = need(args, 1, 'workflow');
        const run = need(args, 2, 'run');
        const outcome = (last(args, 'outcome') ?? 'ok') as 'ok' | 'no_work' | 'released' | 'failed' | 'skipped';
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

// ---- `add` source classification (GitHub repo vs `.wnlp` bundle) ------------------

/** The byte budget for a local `.wnlp` bundle file — same 256 MiB default as the GitHub tarball cap. */
function bundleFileMaxBytes(io: CliIO): number {
  return tarballMaxBytes(io);
}

/** The byte budget for a `.wnlp` bundle fetched over `http:`/`https:` — same cap as the GitHub tarball. */
function bundleUrlMaxBytes(io: CliIO): number {
  return tarballMaxBytes(io);
}

/** The `--global` + `--defs` refusal — the global store has a fixed home-directory location, so `--defs` would only create ambiguity. */
const GLOBAL_DEFS_CONFLICT_MSG =
  '--global cannot be combined with --defs: the global store lives in the home directory';

/**
 * The classification of a single `add` positional. Pure and independently
 * tested: no filesystem access, no network, no state.
 *
 *  - `github`: `owner/repo[@ref]` with no URL scheme and no `.wnlp` path —
 *    the byte-for-byte preserved GitHub route.
 *  - `file`: a local path ending in `.wnlp` — a bundle FILE (origin data only,
 *    never identity).
 *  - `url`: an `http:`/`https:` URL — a bundle URL; any other scheme is
 *    rejected, never a silent fallback.
 */
export type AddSource =
  | { kind: 'github'; spec: string }
  | { kind: 'file'; path: string }
  | { kind: 'url'; url: string };

/**
 * Classify one `add` positional WITHOUT changing GitHub behavior: the GitHub
 * shape (`owner/repo[@ref]`, no scheme, not a `.wnlp` path) returns
 * `{ kind: 'github' }` for exactly the same inputs `parseRepoSpec` accepts,
 * and the GitHub route keeps parsing it — so every error message for a
 * malformed repo spec is unchanged. `.wnlp` file paths and http/https URLs
 * take the bundle route; everything else is a specific usage refusal.
 *
 * The classifier never inspects the filesystem: a `.wnlp` path that does not
 * exist is still classified as a file (the reader refuses it afterward with
 * the reason), and a URL is classified by scheme alone.
 */
export function classifyAddSource(spec: string): AddSource {
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(spec);
  if (schemeMatch !== null) {
    if (spec.startsWith('http:') || spec.startsWith('https:')) {
      return { kind: 'url', url: spec };
    }
    throw new CliError(
      `unsupported source scheme '${spec.slice(0, schemeMatch[0].length)}' — supported sources: ` +
        `owner/repo[@ref] (GitHub), a local .wnlp file, or an http(s) URL`,
    );
  }
  if (spec.endsWith('.wnlp')) {
    return { kind: 'file', path: spec };
  }
  return { kind: 'github', spec };
}

/**
 * Read a local `.wnlp` bundle: it must be a BOUNDED REGULAR FILE. Refusals
 * name the user-supplied path exactly as given (origin data for messages only
 * — identity always comes from the bundle's manifest, never from the path).
 * The size cap is enforced BEFORE and AFTER the read so an oversized file is
 * never fully allocated.
 */
function readBundleFile(io: CliIO, path: string): Uint8Array {
  const filesystemPath = isAbsolute(path) ? path : join(io.cwd, path);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(filesystemPath);
  } catch {
    throw new CliError(`could not read bundle at ${path}: file not found`);
  }
  if (st.isSymbolicLink()) {
    throw new CliError(`refusing bundle at ${path}: it is a symlink`);
  }
  if (!st.isFile()) {
    throw new CliError(`refusing bundle at ${path}: not a regular file`);
  }
  const cap = bundleFileMaxBytes(io);
  if (st.size > cap) {
    throw new CliError(`refusing bundle at ${path}: file is ${st.size} bytes, over the ${cap}-byte cap`);
  }
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(filesystemPath);
  } catch (e) {
    throw new CliError(`could not read bundle at ${path}: ${(e as Error).message}`);
  }
  if (bytes.length > cap) {
    throw new CliError(`refusing bundle at ${path}: file grew to ${bytes.length} bytes while reading (cap ${cap})`);
  }
  return bytes;
}

/**
 * Fetch a `.wnlp` bundle over `http:`/`https:`. Mirrors the GitHub tarball
 * fetch discipline: the timeout covers the fetch AND the body read (undici
 * ties the abort signal to the stream), `readBodyBounded` cancels an
 * oversized body DURING the stream, and redirects are refused
 * (`redirect: 'error'`) rather than followed silently. The A1 adapter remains
 * the authority for bundle size/archive limits once bytes arrive.
 */
async function fetchBundleUrl(io: CliIO, url: string): Promise<Uint8Array> {
  const fetchFn = io.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { 'User-Agent': 'owenloop' },
      signal: AbortSignal.timeout(ADD_TARBALL_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new CliError(`timed out after ${ADD_TARBALL_TIMEOUT_MS / 1000}s downloading bundle from ${url}`);
    }
    throw new CliError(`could not fetch bundle from ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new CliError(`could not fetch bundle from ${url}: server returned ${res.status}`);
  }
  try {
    return await readBodyBounded(res, bundleUrlMaxBytes(io), `bundle from ${url}`);
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new CliError(`timed out after ${ADD_TARBALL_TIMEOUT_MS / 1000}s downloading bundle from ${url}`);
    }
    throw e;
  }
}

/** Return the caller-injected home, rejecting empty values instead of defaulting to process state. */
function workflowHome(io: CliIO): string {
  const home = [io.env.HOME, io.env.USERPROFILE].find((value) => value !== undefined && value.trim() !== '');
  if (home === undefined) throw new CliError('cannot locate the global workflow store: set HOME or USERPROFILE');
  return home;
}

/**
 * Resolve the external install/repair marker directory from injected CLI state.
 * A bundle install always needs a concrete directory; no marker API may consult
 * the ambient process home.
 */
function workflowRecoveryMarkerDir(io: CliIO): string {
  return io.recoveryMarkerDir ?? defaultRecoveryMarkerDir(workflowHome(io));
}

/** Recovery keeps the legacy GitHub path usable when no v2 marker is involved. */
function optionalWorkflowRecoveryMarkerDir(io: CliIO): string | undefined {
  if (io.recoveryMarkerDir !== undefined) return io.recoveryMarkerDir;
  const home = [io.env.HOME, io.env.USERPROFILE].find((value) => value !== undefined && value.trim() !== '');
  return home === undefined ? undefined : defaultRecoveryMarkerDir(home);
}

/**
 * The `.wnlp` bundle route of `owenloop add` — the content-addressed store
 * counterpart of the GitHub route. `dispatchAdd` classifies the positional
 * (pure {@link classifyAddSource}), reads/fetches the bytes unlocked (same as
 * the GitHub download — a slow fetch must not hold a lock), then hands
 * everything that touches store state to `installWorkflowBundle`: lock →
 * recovery → index reread → A1 stage → strict engine validation → A2 verify →
 * harden → journal → swap → atomic index commit → finalize → unlock.
 *
 * Fail-closed adapters: with no A1/A2 module bound to `io`, the installer
 * throws its named adapter-unavailable error BEFORE any journal/object/index
 * commit — there is no default accepting parser, digest algorithm, or
 * verifier. Recovery (`add --recover`) is unaffected by adapter availability:
 * it is pure local journal/object/index work.
 */
async function dispatchAddBundle(io: CliIO, args: Args, source: AddSource): Promise<number> {
  const globalFlag = flag(args, 'global');
  const defsOverride = last(args, 'defs') ?? io.env.OWENLOOP_DEFS;
  if (globalFlag && defsOverride !== undefined) {
    throw new CliError(GLOBAL_DEFS_CONFLICT_MSG);
  }
  // Store roots: the global store is `~/.owenloop/workflows` (HOME injected
  // via env so tests never touch the real one); the project store is the
  // resolved defs dir. Lock/journal paths live per root; the PROJECT route
  // shares the existing project add lock + journal (its recovery ordering).
  // A fresh bundle install also needs an external marker directory, so derive
  // that path from the same injected home and never from process state.
  const recoveryMarkerDir = workflowRecoveryMarkerDir(io);
  const root = globalFlag
    ? globalStoreRoot(workflowHome(io))
    : projectStoreRoot(defsOverride ?? join(io.cwd, 'workflows'));
  const statePaths = workflowStoreStatePaths(root);
  const lockPath = statePaths.lockPath;
  const journalPath = statePaths.journalPath;

  // Bytes first, lock later (same as the GitHub route). Origin data only —
  // the bundle's manifest is the identity authority.
  let bytes: Uint8Array;
  let bundleSource: BundleSource;
  if (source.kind === 'file') {
    bytes = readBundleFile(io, source.path);
    bundleSource = { kind: 'file', path: source.path };
  } else if (source.kind === 'url') {
    bytes = await fetchBundleUrl(io, source.url);
    bundleSource = { kind: 'url', url: source.url };
  } else {
    // Unreachable: `dispatchAdd` routes only file/url sources here.
    throw new CliError('internal error: a GitHub repo spec cannot reach the bundle route');
  }

  // Fail-closed adapter gate, explicit at the dispatch site: with no A1/A2
  // module bound to `io`, dispatch refuses with the named adapter-unavailable
  // error BEFORE any journal/object/index commit (the installer enforces the
  // same rule too — belt and suspenders).
  if (io.bundleIngestor === undefined) throw new BundleIngestorUnavailableError();
  if (io.preCommitVerifier === undefined) throw new PreCommitVerifierUnavailableError();

  // The project route shares the project add lock/recovery ordering — hand
  // the recovery pass the installed.json ledger lookup so a legacy v1
  // (GitHub) journal at the shared project journal path can still be
  // recovered. The global route has no ledger: v1 journals there are refused.
  const readLedger = globalFlag
    ? undefined
    : () => {
        const lf = readLockfile(join(io.cwd, '.owenloop', 'installed.json'));
        return (src: string) => {
          const entry = lf.installed[src];
          if (entry === undefined) return undefined;
          return { sha: entry.sha, path: entry.path };
        };
      };

  const result = await installWorkflowBundle({
    bytes,
    source: bundleSource,
    root,
    level: globalFlag ? 'global' : 'project',
    lockPath,
    journalPath,
    recoveryMarkerDir,
    ingestor: io.bundleIngestor,
    verifier: io.preCommitVerifier,
    readLedger,
  });

  print(io, {
    ok: true,
    source: bundleSource.kind === 'file' ? bundleSource.path : bundleSource.url,
    level: result.level,
    coordinate: result.coordinate,
    digest: result.digest,
    workflows: result.workflows,
    objectPath: result.objectPath,
    installed: result.installed,
  });
  return 0;
}

/**
 * `owenloop add --recover [--global]`: the global variant runs the store's
 * offline recovery on the global root; the plain variant keeps the current
 * project/GitHub recovery. Never touches the network, and adapter
 * availability is irrelevant — recovery is pure local journal/object/index
 * work.
 */
async function dispatchAddRecoverGlobal(io: CliIO): Promise<number> {
  const home = workflowHome(io);
  const root = globalStoreRoot(home);
  const lockPath = join(root, '.owenloop', 'add.lock');
  const journalPath = join(root, '.owenloop', ADD_JOURNAL_FILENAME);
  const recoveryMarkerDir = workflowRecoveryMarkerDir(io);

  const outcome = await recoverWorkflowStore({ root, lockPath, journalPath, recoveryMarkerDir });
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
  // Classify the source BEFORE the GitHub parse: `owner/repo[@ref]` keeps the
  // byte-for-byte preserved GitHub route (same inputs reach `parseRepoSpec`,
  // so every existing error is unchanged); `.wnlp` file paths and http(s)
  // URLs take the content-addressed bundle store route.
  const spec = need(args, 1, '<source>');
  const classified = classifyAddSource(spec);
  if (classified.kind !== 'github') return dispatchAddBundle(io, args, classified);
  if (flag(args, 'global')) {
    throw new CliError('--global is only supported for .wnlp bundle sources');
  }
  const { owner, repo, ref } = parseRepoSpec(spec);
  const source = `${owner}/${repo}`;
  const defsOverride = last(args, 'defs') ?? io.env.OWENLOOP_DEFS;
  const defsDir = defsOverride ?? join(io.cwd, 'workflows');
  const lockfilePath = join(io.cwd, '.owenloop', 'installed.json');
  const installLockPath = join(io.cwd, '.owenloop', 'add.lock');
  const journalPath = join(io.cwd, '.owenloop', ADD_JOURNAL_FILENAME);
  const canonicalState = workflowStoreStatePaths(projectStoreRoot(defsDir));
  const recoveryMarkerDir = optionalWorkflowRecoveryMarkerDir(io);
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
  guardStateFile(installLockPath, 'install lock');
  guardStateFile(journalPath, 'crash-recovery journal');
  guardStateFile(lockfilePath, 'installed ledger');
  if (defsOverride === undefined) mkdirRefusingSymlink(defsDir);
  mkdirRefusingSymlink(canonicalState.stateDir);
  guardStateFile(canonicalState.lockPath, 'canonical install lock');
  guardStateFile(canonicalState.journalPath, 'canonical crash-recovery journal');
  const lockPaths = [...new Set([installLockPath, canonicalState.lockPath])].sort();
  const locks: InstallLockHandle[] = [];
  try {
    for (const path of lockPaths) locks.push(await acquireInstallLock(path));
  } catch (e) {
    for (const handle of locks.reverse()) releaseInstallLock(handle);
    throw e;
  }
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
      recoverInterruptedInstall({
	defsDir,
	journalPath: canonicalState.journalPath,
	lockfilePath: storeIndexPath(defsDir),
	recoveryMarkerDir,
	v2Replacement: workflowStoreReplacementRecovery,
      });
      recoverInterruptedInstall({
	defsDir,
	journalPath,
	lockfilePath,
	recoveryMarkerDir,
	v2Replacement: workflowStoreReplacementRecovery,
      });
    } catch (e) {
      preserveStagingRoot = true;
      throw e;
    }

    // The lock holder is the only legitimate writer under the staging root, so
    // anything already there is debris from a crashed/killed prior run — clear
    // it. Keeps "no staging debris" true even across a Ctrl-C. The shared
    // project staging root may hold a hardened CAS object from a crashed
    // bundle install, so remove without requiring write permission inside it.
    rmRecursiveForce(stagingRoot);

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

      // The definite-defect verdict here is the shared `hasDefiniteCheckDefect(report)`
      // helper — identical to `check`. What is deliberately different is only the
      // seeding of THIS modelCheck call: `assumeProvided: true` (below). Without it,
      // a def with any `seedOwed` input (the norm — see e.g. `proposal` in
      // delivery.yaml) deadlocks in the very first state, because the checker models
      // "no `provide` has happened yet" by default (see `seedArts` in src/model.ts).
      // `owenloop check <def>` behaves the same way absent `--assume-provided`;
      // verified every def under examples/workflows/ fails plain `check` for exactly
      // this reason. Since `add` validates a def that a real user will `provide` into
      // after install (that's the whole point of a seedOwed input), refusing every
      // seedOwed def here would make `add` unable to install almost any real
      // workflow, including this project's own examples — so this checks "is it
      // completable once its owed inputs are supplied," the same bar a careful author
      // would clear with `check --assume-provided` before publishing.
      const report = modelCheck(stagedDef, { assumeProvided: true });
      const hasDefiniteDefect = hasDefiniteCheckDefect(report);
      if (hasDefiniteDefect) {
        reasons.push(
          `${stagedDef.name}: definite defects found (${report.invariantViolations.length} invariant violation(s), ` +
            `${report.structurallyDeadSteps.length} structurally dead step(s), ` +
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
    // the user to recover (the next add clears it as debris). Then release the
    // lock. rmRecursiveForce: the debris may hold a hardened CAS object.
    if (!preserveStagingRoot) rmRecursiveForce(stagingRoot);
    for (const handle of locks.reverse()) releaseInstallLock(handle);
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

  // --global selects the GLOBAL STORE's offline recovery; plain --recover
  // keeps this project/GitHub path exactly as before. The --defs conflict
  // applies here too (the global root never reads a defs override).
  if (flag(args, 'global')) {
    if (last(args, 'defs') !== undefined || io.env.OWENLOOP_DEFS !== undefined) {
      throw new CliError(GLOBAL_DEFS_CONFLICT_MSG);
    }
    return dispatchAddRecoverGlobal(io);
  }

  // Resolve paths EXACTLY as dispatchAdd does — same defsDir/lock/journal
  // derivation — so recovery acts on the same tree a real add would. No fetch
  // reference, no store open.
  const defsOverride = last(args, 'defs') ?? io.env.OWENLOOP_DEFS;
  const defsDir = defsOverride ?? join(io.cwd, 'workflows');
  const lockfilePath = join(io.cwd, '.owenloop', 'installed.json');
  const installLockPath = join(io.cwd, '.owenloop', 'add.lock');
  const journalPath = join(io.cwd, '.owenloop', ADD_JOURNAL_FILENAME);
  const canonicalState = workflowStoreStatePaths(projectStoreRoot(defsDir));
  const recoveryMarkerDir = optionalWorkflowRecoveryMarkerDir(io);

  // Mirror the SEC-3 symlink guards from the normal path (same order, same
  // rationale): `.owenloop` is written by the lock acquire; the default defsDir
  // is mutated-through by recovery. An explicit --defs/OWENLOOP_DEFS is operator
  // intent, not repo content, so it is not symlink-guarded (matching dispatchAdd).
  mkdirRefusingSymlink(join(io.cwd, '.owenloop'));
  guardStateFile(installLockPath, 'install lock');
  guardStateFile(journalPath, 'crash-recovery journal');
  guardStateFile(lockfilePath, 'installed ledger');
  if (defsOverride === undefined) mkdirRefusingSymlink(defsDir);
  const canonicalStateExists = lstatSync(canonicalState.stateDir, { throwIfNoEntry: false }) !== undefined;
  if (canonicalStateExists) {
    mkdirRefusingSymlink(canonicalState.stateDir);
    guardStateFile(canonicalState.lockPath, 'canonical install lock');
    guardStateFile(canonicalState.journalPath, 'canonical crash-recovery journal');
  }
  const lockPaths = [...new Set([installLockPath, ...(canonicalStateExists ? [canonicalState.lockPath] : [])])].sort();
  const locks: InstallLockHandle[] = [];
  try {
    for (const path of lockPaths) locks.push(await acquireInstallLock(path));
  } catch (e) {
    for (const handle of locks.reverse()) releaseInstallLock(handle);
    throw e;
  }
  let outcome: RecoveryOutcome = 'no-journal';
  try {
    const canonicalOutcome = recoverInterruptedInstall({
      defsDir,
      journalPath: canonicalState.journalPath,
      lockfilePath: storeIndexPath(defsDir),
      recoveryMarkerDir,
      v2Replacement: workflowStoreReplacementRecovery,
    });
    const legacyOutcome = recoverInterruptedInstall({
	defsDir,
	journalPath,
	lockfilePath,
	recoveryMarkerDir,
	v2Replacement: workflowStoreReplacementRecovery,
      });
    outcome = legacyOutcome !== 'no-journal' ? legacyOutcome : canonicalOutcome;
  } finally {
    for (const handle of locks.reverse()) releaseInstallLock(handle);
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
 * Resolve the target hub origin: `--hub` > `OWENLOOP_HUB` env > `DEFAULT_HUB`
 * (`src/hub.ts` — the production hub). Normalized (scheme required, trailing
 * slash/path stripped) so it can serve as a stable credential-store key and
 * project binding value.
 */
function resolveHub(io: CliIO, args: Args): string {
  const raw = last(args, 'hub') ?? io.env.OWENLOOP_HUB ?? DEFAULT_HUB;
  try {
    return normalizeOrigin(raw);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
}

type StoredHubDiscovery =
  | { kind: 'one'; origin: string }
  | { kind: 'multiple'; origins: string[] }
  | { kind: 'empty' }
  | { kind: 'non-enumerable'; backend: 'keychain' | 'external-command' };

/**
 * Inspect the active credential backend once and return only the facts every
 * hub-policy resolver needs. Policy stays with the caller: agent commands are
 * strict, setup may choose DEFAULT_HUB, and publishing commands may consult
 * execution settings only when the selected backend cannot enumerate.
 */
function discoverStoredHubs(io: CliIO): StoredHubDiscovery {
  const stored = listStoredHubOrigins(io.env, io.keychain);
  if (stored === null) {
    const backend = credentialBackend(io.env, io.keychain);
    return { kind: 'non-enumerable', backend: backend.kind === 'external' ? 'external-command' : 'keychain' };
  }

  let origins: string[];
  try {
    origins = stored.map((origin) => normalizeOrigin(origin));
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  if (origins.length === 0) return { kind: 'empty' };
  if (origins.length === 1) return { kind: 'one', origin: origins[0]! };
  return { kind: 'multiple', origins: [...origins].sort() };
}

type PublishingHubResolution = {
  origin: string;
  source: 'flag' | 'project' | 'stored' | 'settings';
  /** Present only for the non-enumerable settings rung, which must verify it. */
  credential?: Credential;
};

/**
 * Resolve the safe publication target shared by connect, push, and publish:
 * explicit flag > project override > unambiguous global state. OWENLOOP_HUB
 * and DEFAULT_HUB are intentionally absent from this ladder.
 */
function resolvePublishingHub(
  io: CliIO,
  args: Args,
  slot: CredentialSlotSelector,
): PublishingHubResolution {
  const flagValue = last(args, 'hub');
  if (flagValue !== undefined) {
    try {
      return { origin: normalizeOrigin(flagValue), source: 'flag' };
    } catch (e) {
      throw new CliError((e as Error).message);
    }
  }

  const binding = readHubBinding(hubBindingPath(io.cwd));
  if (binding !== null) {
    try {
      return { origin: normalizeOrigin(binding.hub), source: 'project' };
    } catch (e) {
      throw new CliError(`${(e as Error).message} — re-run \`owenloop connect --hub <origin>\` to rebind`);
    }
  }

  const discovered = discoverStoredHubs(io);
  if (discovered.kind === 'one') {
    return { origin: discovered.origin, source: 'stored' };
  }
  if (discovered.kind === 'multiple') {
    throw new CliError(
      'cannot determine which hub to use — more than one hub has a stored human credential; ' +
      `stored hubs: ${discovered.origins.join(', ')}; pass --hub <origin> or run ` +
      '`owenloop connect --hub <origin>`',
      { exitCode: 2 },
    );
  }
  if (discovered.kind === 'empty') {
    throw new CliError(
      'cannot determine which hub to use — no stored human hub credential was found; ' +
      'pass --hub <origin>, run `owenloop connect --hub <origin>`, or log in to exactly one hub first ' +
      '(`owenloop login --hub <origin>`)',
      { exitCode: 2 },
    );
  }

  const path = executionSettingsPath(io.env);
  const settings = loadSettings(io.env);
  const raw = settings.hubOrigin;
  if (raw === undefined || raw.trim() === '') {
    throw new CliError(
      `cannot determine which hub to use — the ${discovered.backend} credential store cannot be enumerated ` +
      `and ${path} has no non-empty hubOrigin; pass --hub <origin> or run ` +
      '`owenloop connect --hub <origin>` (owenloop setup populates hubOrigin)',
      { exitCode: 2 },
    );
  }

  let origin: string;
  try {
    origin = normalizeOrigin(raw);
  } catch (e) {
    throw new CliError(`invalid hubOrigin in ${path}: ${(e as Error).message}`);
  }
  const credential = readCredential(io, origin, slot);
  if (credential === null) throw new CliError(emptySlotMessage(origin, slot));
  return { origin, source: 'settings', credential };
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
 * pass a pre-normalized origin from the command's applicable resolver; the wrapper's
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
 * POST a JSON `body` to `path` on `origin` with a bearer credential — the
 * request-side sibling of `authedGet`, and the same chain `mintAgentCredential`
 * runs: refresh an expiring oauth token first (`persist` defaults to true, so a
 * rotated refresh token lands in the store), POST, and on a 401 with an oauth
 * credential refresh once and retry exactly once.
 *
 * Goes through `hubFetch`, never raw `fetch` — that is what supplies the 30s
 * deadline, the bounded body read, and `redirect: 'error'`.
 *
 * Returns the raw response plus the credential actually used, leaving ALL error
 * semantics (the final 401, a non-2xx, body parsing) to the caller, exactly like
 * `authedGet` — the wording differs by context.
 */
async function authedPost(
  io: CliIO,
  origin: string,
  slot: CredentialSlotSelector,
  cred: Credential,
  path: string,
  body: unknown,
  persist = true,
): Promise<{ res: Response; cred: Credential }> {
  let current = await ensureFreshOAuth(io, origin, slot, cred, persist);
  const doPost = (bearer: Credential): Promise<Response> =>
    hubFetch(io, resolveEndpoint(origin, path), {
      method: 'POST',
      headers: {
        Authorization: authHeader(bearer),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  let res = await doPost(current);
  if (res.status === 401 && current.kind === 'oauth') {
    current = await refreshOAuth(io, origin, slot, current as Extract<Credential, { kind: 'oauth' }>, persist);
    res = await doPost(current);
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
    try {
      writeGlobalConfig(globalConfigPath(workflowHome(io)), { version: 1, hub: origin });
    } catch (e) {
      io.err(`warning: could not write ~/.owenloop/config.json (${(e as Error).message}) — \`owenloop mcp\` will fall back to other origin sources`);
    }
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
  const r = await runLoopbackOAuth(io, origin);
  try {
    writeGlobalConfig(globalConfigPath(workflowHome(io)), { version: 1, hub: origin });
  } catch (e) {
    io.err(`warning: could not write ~/.owenloop/config.json (${(e as Error).message}) — \`owenloop mcp\` will fall back to other origin sources`);
  }
  print(io, {
    ok: true,
    hub: origin,
    kind: r.cred.kind,
    slot: credentialSlot({ principal: 'human' }),
    storage: r.storage,
    replaced: r.replaced,
    org: r.identity.orgName,
    orgId: r.identity.orgId,
    identity: r.identity.actor,
    ...(r.identity.email ? { email: r.identity.email } : {}),
  });
  return 0;
}

/**
 * The loopback OAuth auth-code + PKCE(S256) round-trip, extracted verbatim from
 * `dispatchLogin` so `setup`'s human-login gate (step 2) runs the exact same
 * flow — one implementation, one behavior. Always targets the **human** slot
 * (the only slot loopback OAuth can produce). Binds a single-use 127.0.0.1:0
 * catcher, discovers the hub's OAuth metadata, dynamically registers a client
 * for the concrete redirect URI, opens the browser, waits for the callback,
 * exchanges the code, verifies the resulting credential against `whoami`
 * (persist=false — an unverified token must never reach storage ahead of its
 * pass/fail verdict), then stores it. Returns whether a human credential was
 * already present (`replaced`), the stored credential, the verified identity,
 * and the storage backend actually used.
 */
async function runLoopbackOAuth(
  io: CliIO,
  origin: string,
): Promise<{ cred: Credential; identity: WhoamiIdentity; storage: 'keychain' | 'file'; replaced: boolean }> {
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
    return { cred, identity, storage, replaced: existed };
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
  const slot = resolveSlot(args);
  const resolved = resolvePublishingHub(io, args, slot);
  const { origin } = resolved;
  const cred = resolved.credential ?? readCredential(io, origin, slot);
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

interface PushBundleContext {
  bytes: Buffer;
  digest: string;
  manifest: ReturnType<typeof inspectBundle>['manifest'];
  publication: Buffer;
  publicationState: 'signed' | 'unsigned';
  origin?: Buffer;
  defsDir: string;
  cleanupRoot: string;
}

/** Read a publication/origin sidecar without following a symlink. */
function readPushSidecar(path: string, label: string): { bytes: Buffer; value: unknown } {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) throw new CliError(`owenloop push --bundle: missing ${label} '${path}'`);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CliError(`owenloop push --bundle: ${label} '${path}' must be a regular file, not a symlink`);
  }
  if (stat.size > 32 * 1024 * 1024) {
    throw new CliError(`owenloop push --bundle: ${label} '${path}' exceeds the hub 32MB request cap`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw new CliError(`owenloop push --bundle: cannot read ${label} '${path}': ${(e as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new CliError(`owenloop push --bundle: ${label} '${path}' is not valid JSON`);
  }
  return { bytes, value };
}

/**
 * Validate the relay-level DSSE shape and its digest/package binding locally.
 * Signature authorization remains the execution host's responsibility; this
 * mirrors the hub's transport boundary and prevents a mismatched sidecar from
 * landing after the content-addressed bundle upload.
 */
function assertPushDsse(
  value: unknown,
  expected: { digest: string; name: string; version: string },
  payloadType: string,
  label: string,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(`owenloop push --bundle: ${label} must be a DSSE JSON object`);
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.payloadType !== payloadType || typeof envelope.payload !== 'string') {
    throw new CliError(`owenloop push --bundle: ${label} has the wrong payload type or no string payload`);
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
    throw new CliError(`owenloop push --bundle: ${label} has no signatures`);
  }
  for (const signature of envelope.signatures) {
    if (
      typeof signature !== 'object' ||
      signature === null ||
      Array.isArray(signature) ||
      typeof (signature as Record<string, unknown>).keyid !== 'string' ||
      typeof (signature as Record<string, unknown>).sig !== 'string'
    ) {
      throw new CliError(`owenloop push --bundle: ${label} contains a malformed signature`);
    }
  }
  let record: unknown;
  try {
    record = JSON.parse(decodeBase64Strict(envelope.payload, { allowEmpty: false }).toString('utf8')) as unknown;
  } catch (e) {
    throw new CliError(`owenloop push --bundle: ${label} payload is invalid: ${(e as Error).message}`);
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new CliError(`owenloop push --bundle: ${label} payload is not a JSON object`);
  }
  const bound = record as Record<string, unknown>;
  if (bound.digest !== expected.digest || bound.name !== expected.name || bound.version !== expected.version) {
    throw new CliError(`owenloop push --bundle: ${label} does not bind the selected bundle digest and package identity`);
  }
}

/**
 * Inspect one exact archive, require exactly one adjacent publication sidecar,
 * and materialize its manifest-declared workflow files into a private temp
 * directory. The archive, not the caller's checkout, is the source of truth.
 */
function preparePushBundle(io: CliIO, bundleArg: string): PushBundleContext {
  if (bundleArg === '' || bundleArg === 'true') {
    throw new CliError('owenloop push: --bundle requires a .wnlp path value');
  }
  const bundlePath = resolve(io.cwd, bundleArg);
  const bytes = readBundleCommandFile(io, bundleArg);
  const inspected = runBundle(() => inspectBundle(bytes));
  const signedPath = `${bundlePath}.dsse`;
  const unsignedPath = `${bundlePath}.unsigned`;
  const originPath = `${bundlePath}.origin.dsse`;
  const hasSigned = lstatSync(signedPath, { throwIfNoEntry: false }) !== undefined;
  const hasUnsigned = lstatSync(unsignedPath, { throwIfNoEntry: false }) !== undefined;
  if (hasSigned === hasUnsigned) {
    throw new CliError(
      `owenloop push --bundle: expected exactly one publication sidecar: '${signedPath}' or '${unsignedPath}'`,
    );
  }

  const expected = {
    digest: inspected.digest,
    name: inspected.manifest.package.name,
    version: inspected.manifest.package.version,
  };
  let publication: Buffer;
  let publicationState: 'signed' | 'unsigned';
  if (hasSigned) {
    const sidecar = readPushSidecar(signedPath, 'signed publication sidecar');
    assertPushDsse(sidecar.value, expected, PAYLOAD_TYPE_PUBLICATION, 'signed publication sidecar');
    publication = sidecar.bytes;
    publicationState = 'signed';
  } else {
    const sidecar = readPushSidecar(unsignedPath, 'unsigned publication marker');
    const marker = sidecar.value;
    if (
      typeof marker !== 'object' ||
      marker === null ||
      Array.isArray(marker) ||
      (marker as Record<string, unknown>).formatVersion !== 1 ||
      (marker as Record<string, unknown>).digest !== inspected.digest ||
      (marker as Record<string, unknown>).signed !== false
    ) {
      throw new CliError('owenloop push --bundle: unsigned publication marker does not bind the selected bundle digest');
    }
    publication = sidecar.bytes;
    publicationState = 'unsigned';
  }

  let origin: Buffer | undefined;
  if (lstatSync(originPath, { throwIfNoEntry: false }) !== undefined) {
    const sidecar = readPushSidecar(originPath, 'origin sidecar');
    assertPushDsse(sidecar.value, expected, PAYLOAD_TYPE_ORIGIN, 'origin sidecar');
    origin = sidecar.bytes;
  }

  const cleanupRoot = mkdtempSync(join(tmpdir(), 'owenloop-push-'));
  const defsDir = join(cleanupRoot, 'bundle');
  try {
    runBundle(() => unpackBundle(bytes, defsDir));
  } catch (e) {
    rmSync(cleanupRoot, { recursive: true, force: true });
    throw e;
  }
  return { bytes, digest: inspected.digest, manifest: inspected.manifest, publication, publicationState, origin, defsDir, cleanupRoot };
}

/** Bundle-backed orders identify a step by bundle digest plus step name. */
function assertUniqueBundleStepNames(defs: ReadonlyMap<string, WorkflowDef>): void {
	const ownerByStep = new Map<string, string>();
	const orderedDefs = [...defs.entries()].sort(([left], [right]) => left.localeCompare(right));
	for (const [definitionName, def] of orderedDefs) {
		for (const step of def.steps) {
			const firstOwner = ownerByStep.get(step.name);
			if (firstOwner !== undefined && firstOwner !== definitionName) {
				throw new CliError(
					`owenloop push --bundle: duplicate step name '${step.name}' in workflow definitions ` +
						`'${firstOwner}' and '${definitionName}'; step names must be unique across the complete archive`,
				);
			}
			ownerByStep.set(step.name, definitionName);
		}
	}
}

/**
 * Order only the explicitly selected definitions by their selected local
 * `calls:` dependencies. A child is published before each selected parent.
 * `<currentPackage>/<workflow>` is local in bundle mode; excluded local and
 * external-package targets add no edge, so selection never pulls another
 * workflow into the push.
 */
function orderSelectedDefsByCalls(
  selected: WorkflowDef[],
  currentPackage?: string,
): { ordered: WorkflowDef[]; dependencies: Map<string, Set<string>> } {
  const selectedByName = new Map(selected.map((def) => [def.name, def]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const ordered: WorkflowDef[] = [];
  const dependencies = new Map<string, Set<string>>();
  const localPrefix = currentPackage === undefined ? undefined : `${currentPackage}/`;

  const localTarget = (target: string | undefined): string | undefined => {
    if (target === undefined) return undefined;
    if (!target.includes('/')) return selectedByName.has(target) ? target : undefined;
    if (localPrefix === undefined || !target.startsWith(localPrefix)) return undefined;
    const name = target.slice(localPrefix.length);
    return selectedByName.has(name) ? name : undefined;
  };

  const visit = (def: WorkflowDef): void => {
    const prior = state.get(def.name);
    if (prior === 'done') return;
    if (prior === 'visiting') {
      const cycleStart = stack.indexOf(def.name);
      const cycle = [...stack.slice(cycleStart), def.name];
      throw new CliError(`owenloop push: selected calls cycle: ${cycle.join(' -> ')}`);
    }

    state.set(def.name, 'visiting');
    stack.push(def.name);
    const targets = new Set(
      def.steps
	.map((step) => localTarget(step.calls))
	.filter((target): target is string => target !== undefined),
    );
    dependencies.set(def.name, targets);
    for (const target of targets) visit(selectedByName.get(target)!);
    stack.pop();
    state.set(def.name, 'done');
    ordered.push(def);
  };

  for (const def of selected) visit(def);
  return { ordered, dependencies };
}

/** What one batch of `POST /api/create_workflow` calls did, per def. */
interface PublishOutcome {
  pushed: string[];
  noop: string[];
  skipped: string[];
  failed: { name: string; error: string }[];
  /** The hub's capability publish report, per def that returned one. */
  capabilities: Record<string, CapabilityPublishReportEntry[]>;
}

/**
 * Publish an already-diffed, already-validated batch of defs — the shared
 * publish ladder behind BOTH `push` and `install`, so the two can never drift
 * apart in how they treat a 401, a 413, a 429, a `{ok:false}` 200, or a def
 * whose selected dependency failed.
 *
 * Behavior, unchanged from when this lived inline in `dispatchPush`:
 *  - A def whose selected `calls:` dependency failed or was skipped is SKIPPED,
 *    never published against a half-updated hub.
 *  - A 401 refreshes an oauth credential once and retries once; a 401 that
 *    survives that (or any 401 on an agent token) aborts the whole run by
 *    re-throwing — already-published defs stand.
 *  - A 429 halts the batch immediately (REL-10): this def is `failed`, the
 *    not-yet-attempted remainder is `skipped`, and nothing else is sent.
 *  - Any other per-def failure is recorded and the batch continues.
 *
 * `holder.cred` is read before every request and written back after a refresh,
 * so a mid-batch token rotation is not lost by the caller.
 */
async function publishCandidates(
  io: CliIO,
  origin: string,
  slot: CredentialSlotSelector,
  holder: { cred: Credential },
  toPush: (DefPushCandidate & { status: 'new' | 'changed' })[],
  dependencies: Map<string, Set<string>>,
  bundleDigest?: string,
): Promise<PublishOutcome> {
  const pushed: string[] = [];
  const noop: string[] = [];
  const failed: { name: string; error: string }[] = [];
  const skipped: string[] = [];
  const capabilities: Record<string, CapabilityPublishReportEntry[]> = {};
  const unsuccessful = new Set<string>();

  for (let i = 0; i < toPush.length; i++) {
    const c = toPush[i]!;
    const label = c.status === 'new' ? '+' : '~';
    const blockedBy = [...(dependencies.get(c.name) ?? [])]
      .filter((dependency) => unsuccessful.has(dependency))
      .sort();
    if (blockedBy.length > 0) {
      skipped.push(c.name);
      unsuccessful.add(c.name);
      io.err(`- ${c.name} (skipped: selected dependency ${blockedBy.map((name) => `'${name}'`).join(', ')} failed or was skipped)`);
      continue;
    }
    try {
      let res = await createWorkflowRequest(io, origin, holder.cred, c.yaml, bundleDigest);
      if (res.status === 401 && holder.cred.kind === 'oauth') {
        holder.cred = await refreshOAuth(io, origin, slot, holder.cred as Extract<Credential, { kind: 'oauth' }>);
        res = await createWorkflowRequest(io, origin, holder.cred, c.yaml, bundleDigest);
      }
      if (res.status === 401) {
        if (holder.cred.kind === 'agent') {
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
        noop.push(c.name);
        io.err(`= ${c.name} (server: unchanged, v${okBody.version})`);
      } else {
        pushed.push(c.name);
        io.err(`${label} ${c.name} (→ v${okBody.version})`);
      }
      // The hub sends the report on BOTH branches, `unchanged:true` included, so
      // an idempotent re-push still tells the pusher what the org vocabulary is.
      if (okBody.capabilityReport !== undefined) {
        capabilities[c.name] = okBody.capabilityReport;
        printCapabilityReport(io, c.name, okBody.capabilityReport);
      }
    } catch (e) {
      // A 429 halts the whole batch immediately (REL-10): record this def as
      // failed, then stop — the not-yet-attempted remainder is reported as
      // `skipped`, not silently hammered against a rate-limited server.
      // Handled before the generic path because RateLimitError extends CliError.
      if (e instanceof RateLimitError) {
        const msg = e.message;
        failed.push({ name: c.name, error: msg });
        unsuccessful.add(c.name);
        io.err(`! ${c.name} (failed: ${msg})`);
        const remainder = toPush.slice(i + 1).map((r) => r.name);
        skipped.push(...remainder);
        for (const name of remainder) unsuccessful.add(name);
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
      unsuccessful.add(c.name);
      io.err(`! ${c.name} (failed: ${msg})`);
    }
  }

  return { pushed, noop, skipped, failed, capabilities };
}

/**
 * `owenloop push [<defName>...] [--bundle <bundle.wnlp>] [--force]
 * [--dry-run] [--hub <origin>]` — publish local workflow defs, or exact
 * bundle-backed defs, to the safely resolved hub, diffed against the hub's own
 * def `hash` (`GET /api/workflows` — see `computeServerDiff`), never a
 * client-side ledger. Mirrors `add`'s all-or-nothing client-side validation
 * gate before any network write; server-side failures mid-batch record what
 * landed and exit 1. `POST /api/create_workflow` is itself idempotent, so even
 * a wrong "changed" verdict (e.g. from engine-version drift between this CLI
 * and the hub) is harmless — it just costs one extra round-trip that the
 * server reports back as a no-op.
 */
async function dispatchPush(io: CliIO, args: Args): Promise<number> {
  const configuredDefsDir = last(args, 'defs') ?? io.env.OWENLOOP_DEFS ?? join(io.cwd, 'workflows');
  const bundleArg = last(args, 'bundle');
  if (bundleArg !== undefined && args.options.has('defs')) {
    throw new CliError('owenloop push: --bundle cannot be combined with --defs; the archive is the definition source');
  }
  const dryRun = flag(args, 'dry-run');
  const force = flag(args, 'force');
  // `push` publishes defs the ORG authored, so their capabilities join the org's
  // SHARED vocabulary by default and NOTHING is recorded. `--map` is the only
  // way `push` writes a mapping at all — the deliberate asymmetry with
  // `install`, which scopes by default. See `dispatchInstall`.
  const requestedMap = parseCapabilityMapFlag(args);
  const slot = resolveSlot(args);

  const resolved = resolvePublishingHub(io, args, slot);
  const { origin } = resolved;
  let cred = resolved.credential ?? readCredential(io, origin, slot);
  if (!cred) throw new CliError(emptySlotMessage(origin, slot));

  let bundle: PushBundleContext | undefined;
  try {
    bundle = bundleArg === undefined ? undefined : preparePushBundle(io, bundleArg);
    const defsDir = bundle?.defsDir ?? configuredDefsDir;

    // Load defs (same machinery as lint/add). Bundle mode reads only the
    // manifest-declared workflow paths from the materialized exact archive;
    // bundle.yaml and unrelated YAML assets are never mistaken for defs.
    if (!existsSync(defsDir)) throw new CliError(`defs directory not found: ${defsDir}`);
    const failures: DefLoadFailure[] = [];
    let allDefs: Map<string, WorkflowDef>;
    if (bundle !== undefined) {
      allDefs = new Map<string, WorkflowDef>();
      for (const [name, workflowPath] of Object.entries(bundle.manifest.workflows)) {
	try {
	  const def = loadDefFile(join(defsDir, workflowPath));
	  if (def.name !== name) {
	    throw new CliError(`manifest workflow '${name}' loads as '${def.name}'`);
	  }
	  allDefs.set(name, def);
	} catch (e) {
	  throw new CliError(`owenloop push --bundle: cannot load workflow '${name}': ${(e as Error).message}`);
	}
      }
    } else {
      allDefs = loadDefsRaw(defsDir, failures);
    }
		if (bundle !== undefined) assertUniqueBundleStepNames(allDefs);

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
  const selectedOrder = orderSelectedDefsByCalls(selected, bundle?.manifest.package.name);
  selected = selectedOrder.ordered;
  const selectedDependencies = selectedOrder.dependencies;
  assertMapCoversSelection(requestedMap, selected);
  // Per def, only the entries that def actually authors, and only the
  // non-identity ones — the hub's resolver drops an identity row anyway, so
  // posting one would be a write that changes nothing.
  const mappingWrites = selected
    .map((def) => ({
      name: def.name,
      entries: Object.fromEntries(
        authoredCapabilitiesOf(def)
          .filter((cap) => requestedMap[cap] !== undefined && requestedMap[cap] !== cap)
          .map((cap) => [cap, requestedMap[cap]!]),
      ),
    }))
    .filter((w) => Object.keys(w.entries).length > 0);

  // Client-side validation gate — all-or-nothing, mirroring dispatchAdd exactly.
  // Any failure aborts the entire push; nothing is sent.
  const reasons: string[] = failures.map((f) => `${f.file}: ${f.error}`);
  for (const def of selected) {
    const lintResult = lintDef(def);
    reasons.push(...lintResult.errors.map((e) => `${def.name}: ${e}`));
    reasons.push(...validateDef(def).map((e) => `${def.name}: ${e}`));
    const report = modelCheck(def, { assumeProvided: true });
    const hasDefiniteDefect = hasDefiniteCheckDefect(report);
    if (hasDefiniteDefect) {
      reasons.push(
        `${def.name}: definite defects found (${report.invariantViolations.length} invariant violation(s), ` +
          `${report.structurallyDeadSteps.length} structurally dead step(s), ` +
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
  // fetched, even under --force, so the new/changed capabilities stay accurate.
  const { res: listRes, cred: listCred } = await authedGet(io, origin, slot, cred, '/api/workflows');
  assertAuthOk(listRes, listCred, origin);
  cred = listCred;
  let serverMap: Map<string, ReturnType<typeof parseWorkflowList> extends Map<string, infer V> ? V : never>;
  try {
    serverMap = parseWorkflowList(await listRes.json());
  } catch (e) {
    throw new CliError((e as Error).message);
  }

  // A bundle-backed push must always send create_workflow: GET /api/workflows
  // exposes the YAML hash but intentionally not the latest bundle identity.
  // The server's (yaml,bundleDigest) idempotency decides whether this is a new
  // version or an exact no-op.
  const { toPush, unchanged } = computeServerDiff(candidates, serverMap, force || bundle !== undefined);

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
      ...(bundle === undefined ? {} : { bundleDigest: bundle.digest, publication: bundle.publicationState }),
      new: toPush.filter((c) => c.status === 'new').map((c) => c.name),
      changed: toPush.filter((c) => c.status === 'changed').map((c) => c.name),
      unchanged: unchanged.map((c) => c.name),
      wouldPush: toPush.map((c) => c.name),
      wouldRecord: Object.fromEntries(mappingWrites.map((w) => [w.name, w.entries])),
    });
    return 0;
  }

  // `--map` records BEFORE anything is published, the same ordering `install`
  // uses and for the same reason: a hub that cannot record the mapping must
  // fail the command with nothing published, never leave the two halves apart.
  if (mappingWrites.length > 0) {
    const holder = { cred };
    const transport = capabilityMappingTransport(io, origin, slot, holder);
    for (const write of mappingWrites) {
      await recordCapabilityMappings(transport, write.name, write.entries, origin);
      for (const [authored, org] of Object.entries(write.entries)) {
        io.err(`  recorded ${write.name}: ${authored} → ${org}`);
      }
    }
    cred = holder.cred;
  }

  // Refresh an expiring oauth token once up front (per-request 401 refresh below covers mid-batch expiry).
  cred = await ensureFreshOAuth(io, origin, slot, cred);

  if (bundle !== undefined) {
    cred = await uploadPushBundle(io, origin, slot, cred, bundle);
  }

  const holder = { cred };
  const published = await publishCandidates(io, origin, slot, holder, toPush, selectedDependencies, bundle?.digest);

  print(io, {
    ok: published.failed.length === 0,
    hub: origin,
    ...(bundle === undefined ? {} : { bundleDigest: bundle.digest, publication: bundle.publicationState }),
    pushed: published.pushed,
    noop: published.noop,
    unchanged: unchanged.map((c) => c.name),
    skipped: published.skipped,
    failed: published.failed,
    capabilities: published.capabilities,
  });
  return published.failed.length === 0 ? 0 : 1;
  } finally {
    if (bundle !== undefined) rmSync(bundle.cleanupRoot, { recursive: true, force: true });
  }
}

// ---- capability mapping (shared by `push --map` and `install`) ---------------

/**
 * Every authored capability one def declares, deduped, in first-authored order.
 *
 * Judge steps are synthesized into `def.steps` by the def parser, so iterating
 * `steps` covers them — there is no second place capabilities can be written.
 * Order is the order an operator reads the YAML top-down, which is the order
 * the install prompt asks in.
 */
function authoredCapabilitiesOf(def: WorkflowDef): string[] {
  const names: string[] = [];
  for (const step of def.steps) {
    for (const cap of step.capabilities ?? []) {
      if (!names.includes(cap)) names.push(cap);
    }
  }
  return names;
}

/**
 * The org capability name an OUTSIDE def's capability takes by default:
 * `<defName>.<authored>`.
 *
 * This needs no new separator and invents no escaping. A def name matches
 * `/^[a-z0-9][a-z0-9_-]*$/i`, so it can never contain a dot, while the def
 * parser's capability rule reserves only `:` — dots are already legal inside a
 * capability. So the dot splits the two halves unambiguously in one direction
 * (the first dot ends the def name) and collides with nothing.
 */
function scopedCapabilityName(defName: string, authored: string): string {
  return `${defName}.${authored}`;
}

/**
 * The same rule the def parser's `assertAuthoredCapability` applies, restated
 * for an ORG-side name supplied on the command line or at the prompt:
 * non-empty, not whitespace, and no `MODIFIER_SEPARATOR`.
 *
 * The separator ban is the load-bearing half. `:` is the suffix position the
 * engine composes the run modifier into at offer time (`wise` + `deep` →
 * `wise:deep`), so an authored-side value carrying one would be a capability
 * that can never be composed. The def parser refuses it in YAML; this refuses
 * it on the mapping's target, which reaches exactly the same position.
 */
function assertMappingTarget(target: string, where: string): void {
  if (target.trim().length === 0) {
    throw new CliError(`${where}: an org capability name must not be empty or whitespace`);
  }
  if (target.includes(MODIFIER_SEPARATOR)) {
    throw new CliError(
      `${where}: capability '${target}' must not contain '${MODIFIER_SEPARATOR}' — ` +
        'the suffix position is reserved for the modifier the engine composes at offer time ' +
        "(a run carrying 'deep' turns the authored capability 'wise' into 'wise:deep')",
    );
  }
}

/**
 * Parse the repeatable `--map <authored>=<org>` flag shared by `push` and
 * `install`. `parsePairs` supplies the `expected name=value, got: …` refusal;
 * every target is then validated by `assertMappingTarget`.
 */
function parseCapabilityMapFlag(args: Args): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [authored, target] of Object.entries(parsePairs(all(args, 'map'), false))) {
    if (authored.trim().length === 0) {
      throw new CliError('--map: the authored capability name must not be empty or whitespace');
    }
    assertMappingTarget(target as string, `--map ${authored}`);
    out[authored] = target as string;
  }
  return out;
}

/**
 * Refuse a `--map` naming a capability none of the selected defs authors — it
 * would otherwise be a silent no-op, and a typo in an authored name is exactly
 * the case where silence is worst (the operator believes a link was made).
 */
function assertMapCoversSelection(map: Record<string, string>, selected: WorkflowDef[]): void {
  const authored = new Set(selected.flatMap((def) => authoredCapabilitiesOf(def)));
  const unknown = Object.keys(map)
    .filter((name) => !authored.has(name))
    .sort();
  if (unknown.length === 0) return;
  const known = [...authored].sort();
  throw new CliError(
    `--map names ${unknown.length} capability(ies) no selected def authors: ${unknown.join(', ')} — ` +
      (known.length === 0 ? 'the selected defs author no capabilities' : `authored: ${known.join(', ')}`),
  );
}

/**
 * Adapt `authedGet`/`authedPost` into the transport
 * `src/capability-mapping-client.ts` takes, threading the possibly-refreshed
 * credential back into `holder` so a mid-command oauth refresh is not lost.
 *
 * The client module cannot import these helpers directly — they are private to
 * `cli.ts`, and `cli.ts` imports the client, so a direct import would be a
 * cycle. Injecting the transport keeps the 30s deadline, the bounded body,
 * `redirect: 'error'` and the single 401-refresh-and-retry on the mapping calls
 * without one.
 */
function capabilityMappingTransport(
  io: CliIO,
  origin: string,
  slot: CredentialSlotSelector,
  holder: { cred: Credential },
): CapabilityMappingTransport {
  return {
    async get(path: string): Promise<Response> {
      const { res, cred } = await authedGet(io, origin, slot, holder.cred, path);
      holder.cred = cred;
      return res;
    },
    async post(path: string, body: unknown): Promise<Response> {
      const { res, cred } = await authedPost(io, origin, slot, holder.cred, path, body);
      holder.cred = cred;
      return res;
    },
  };
}

/**
 * The hub's capability publish report for one def, on STDERR — stdout stays
 * machine JSON. Silent for a hub that sent no report (older than the report) and
 * for a def that authors no capabilities, so neither case prints a dangling
 * header.
 */
function printCapabilityReport(io: CliIO, defName: string, report: CapabilityPublishReportEntry[] | undefined): void {
  if (report === undefined) return;
  const text = capabilityPublishReportText(report);
  if (text !== '') io.err(`${defName}: ${text}`);
}

/**
 * Render the org's live capability vocabulary from `GET /api/capability_routes`
 * as one line — `review (reviewers), builder (builders), triage (unbound)`.
 *
 * The endpoint returns ONE ROW PER `(capability, crew)` pair, so rows are
 * grouped by capability here. A row whose `crewName` is `null` is a DANGLING
 * route (the crew is gone) and shows as `unbound`, because that is what it means
 * for routing: the capability exists in the vocabulary but nothing serves it.
 */
function formatOrgVocabulary(routes: CapabilityRouteWire[]): string {
  const crewsByCapability = new Map<string, Set<string>>();
  for (const route of routes) {
    const crews = crewsByCapability.get(route.capability);
    const name = route.crewName;
    if (crews === undefined) crewsByCapability.set(route.capability, new Set(name === null ? [] : [name]));
    else if (name !== null) crews.add(name);
  }
  return [...crewsByCapability.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([capability, crews]) => `${capability} (${crews.size === 0 ? 'unbound' : [...crews].sort().join(', ')})`)
    .join(', ');
}

/** One def's decided `authored → org` vocabulary, and the subset that must be written. */
interface DefMappingPlan {
  def: WorkflowDef;
  /** Every authored capability, identity entries included — what the operator decided. */
  resolved: Record<string, string>;
  /** The subset the hub does not already hold: non-identity, and not carried forward unchanged. */
  toRecord: Record<string, string>;
}

/**
 * Fetch a public GitHub repo's `workflows/**` at a pinned commit sha, into an
 * in-memory file map.
 *
 * Deliberately its own sequence rather than a refactor of `dispatchAdd`'s: `add`
 * interleaves this with a project install lock, a crash journal and an atomic
 * swap that `install` has no business acquiring, and its refusal wording names
 * `add`'s local install. Only the PRIMITIVES are shared (`parseRepoSpec`,
 * `githubShaUrl`, `githubTarballUrl`, `readBodyBounded`, `extractTarGz`,
 * `archivePathViolation`), which is where the security-relevant behavior lives:
 * the ref is pinned to a 40-char sha before the tarball is fetched, the body is
 * capped DURING the stream, and every archive path is checked for escape before
 * it is ever joined (SEC-1).
 */
async function fetchGithubWorkflowFiles(
  io: CliIO,
  spec: string,
): Promise<{ source: string; ref: string; sha: string; files: Map<string, Uint8Array> }> {
  const { owner, repo, ref } = parseRepoSpec(spec);
  const source = `${owner}/${repo}`;
  const fetchFn = io.fetch ?? globalThis.fetch;

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
  const sha = new TextDecoder().decode(shaBytes).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new CliError(`unexpected response resolving ${source}@${ref}: expected a 40-char commit sha, got "${sha}"`);
  }

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
    if (!rest.startsWith('workflows/')) continue;
    const relPath = rest.slice('workflows/'.length);
    if (!relPath) continue;
    const violation = archivePathViolation(relPath);
    if (violation) {
      pathViolations.push(`${rawPath}: ${violation}`);
      continue;
    }
    files.set(relPath, data);
  }
  if (pathViolations.length > 0) {
    throw new CliError(
      `refusing to install ${source}@${sha} — ${pathViolations.length} unsafe archive path(s) found; nothing published:\n  - ${pathViolations.join('\n  - ')}`,
    );
  }
  if (files.size === 0) {
    throw new CliError(`no workflows/ directory found in ${source}@${ref}`);
  }
  return { source, ref, sha, files };
}

/**
 * Ask the operator, one authored capability at a time, what the org should call
 * it. Enter accepts the prefilled SCOPED default; typing a name links the
 * capability into the org's existing vocabulary instead.
 *
 * Prompt style matches `promptAgentName` / `promptSuccession`: prefilled
 * default, empty answer accepts it, one re-prompt on an invalid answer, then a
 * `CliError`. All prompt I/O is stderr, so `| jq` on stdout is unaffected.
 *
 * `prompt` is passed in ALREADY RESOLVED by `requirePrompt`, which the caller
 * ran before any hub I/O — a piped run must fail with the flag names, never
 * block here after half the work is done.
 */
async function promptCapabilityMapping(
  io: CliIO,
  prompt: (question: string) => Promise<string>,
  defName: string,
  authored: string,
): Promise<string> {
  const fallback = scopedCapabilityName(defName, authored);
  const question = `  ${authored}  [${fallback}]: `;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = (await prompt(question)).trim();
    if (raw === '') return fallback;
    try {
      assertMappingTarget(raw, `capability '${authored}'`);
      return raw;
    } catch (e) {
      io.err((e as Error).message);
    }
  }
  throw new CliError(`no valid org capability name provided for '${authored}'`);
}

/**
 * `owenloop install <owner>/<repo>[@ref] [<defName>...] [--map <authored>=<org>]
 * [--accept-defaults] [--dry-run] [--hub <origin>] [--as <slot>]` — publish defs
 * authored OUTSIDE your org to your hub, under capability names your org
 * chooses.
 *
 * **This is a PUBLISH verb, a sibling of `push` — not of `add`.** It never
 * writes into the local `workflows/` directory: `add` already owns local
 * installation, with its install lock, crash journal and atomic swap, and
 * duplicating that here would be a second implementation of the same
 * transaction. `install` fetches the outside def, decides the org-side
 * capability vocabulary for it, records that mapping, and publishes.
 *
 * **Why the mapping is scoped by default.** `push` publishes defs YOU authored,
 * so their capabilities join the org's SHARED vocabulary — two of your own defs
 * both authoring `review` deliberately mean the same `review`, served by the
 * same crews. A def from an unrelated author making the same claim is not the
 * same claim. So every capability an installed def authors becomes
 * `<defName>.<capability>` unless the installer says otherwise, once, at install
 * time. The def content itself is never edited: the mapping is org-side data.
 *
 * **Order of operations, and it is the point: record, THEN publish.** Publishing
 * first would put an unscoped third-party def into the org's vocabulary for the
 * window between the two calls — exactly the trust-boundary breach this verb
 * exists to prevent. So a hub that cannot record the mapping fails the command
 * BEFORE anything is published, and nothing is left half-applied.
 *
 * **A hub that cannot record mappings.** The hub's mapping READ is live, but no
 * shipped `owenloop-service` build has the BATCH write this command needs — it
 * ships a singular one-row-per-call verb instead, which cannot give the
 * record-then-publish order its all-or-nothing guarantee (see
 * `src/capability-mapping-client.ts` for why the plural is not sugar over N
 * singular calls). Until the batch verb ships, only the IDENTITY case completes
 * end to end: when every capability keeps its authored name there is nothing to
 * record — the hub's resolver drops identity rows anyway — so the write is
 * skipped and the publish proceeds. Every other case stops at the missing verb
 * with exit 2.
 *
 * Exit codes: 0 ok; 1 runtime/hub error (a validation-gate refusal, a per-def
 * hub rejection, a refused source kind, an invalid `--map`); 2 the hub is
 * unresolvable, or it does not implement the mapping write; 3 the credential for
 * the slot is absent or irrecoverable.
 */
async function dispatchInstall(io: CliIO, args: Args): Promise<number> {
  // 0. Argument-only work, before anything is fetched or resolved.
  const spec = need(args, 1, '<source>');
  const classified = classifyAddSource(spec);
  if (classified.kind !== 'github') {
    const what = classified.kind === 'file' ? 'a local .wnlp bundle' : 'an http(s) URL';
    throw new CliError(
      `owenloop install: ${what} is not an install source yet — only owner/repo[@ref] (GitHub) is. ` +
        `Run \`owenloop add ${spec}\` to install it into the local store, then ` +
        '`owenloop push --bundle <bundle.wnlp>` to publish it.',
    );
  }
  const dryRun = flag(args, 'dry-run');
  const acceptDefaults = flag(args, 'accept-defaults');
  const requestedMap = parseCapabilityMapFlag(args);
  const slot = resolveSlot(args);

  const resolvedHub = resolvePublishingHub(io, args, slot);
  const { origin } = resolvedHub;
  const startingCredential = resolvedHub.credential ?? readCredential(io, origin, slot);
  if (!startingCredential) {
    throw new CliError(`${emptySlotMessage(origin, slot)} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
  }
  // Threaded through every hub call so a mid-command oauth refresh is not lost.
  const holder = { cred: startingCredential };

  // 1. Fetch the outside repo and materialize its workflows/ into a temp dir.
  //    Nothing under the user's cwd is touched, at any point.
  const fetched = await fetchGithubWorkflowFiles(io, spec);
  const sourceRef = `${fetched.source}@${fetched.sha}`;
  const workRoot = mkdtempSync(join(tmpdir(), 'owenloop-install-'));
  try {
    for (const [relPath, data] of fetched.files) {
      const dest = join(workRoot, relPath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    }

    // 2. Load, narrow to positionals, and order by `calls:` — same machinery push uses.
    const failures: DefLoadFailure[] = [];
    const allDefs = loadDefsRaw(workRoot, failures);
    const requested = args.positionals.slice(2);
    let selected: WorkflowDef[];
    if (requested.length > 0) {
      selected = [];
      for (const name of requested) {
        const def = allDefs.get(name);
        if (!def) {
          throw new CliError(
            `unknown workflow definition '${name}' in ${sourceRef} (found: ${[...allDefs.keys()].sort().join(', ') || 'none'})${failureNote(failures)}`,
          );
        }
        selected.push(def);
      }
    } else {
      selected = [...allDefs.values()];
    }
    if (selected.length === 0) {
      throw new CliError(`nothing to install — no workflow definitions found in ${sourceRef}${failureNote(failures)}`);
    }
    const selectedOrder = orderSelectedDefsByCalls(selected);
    selected = selectedOrder.ordered;
    const selectedDependencies = selectedOrder.dependencies;
    assertMapCoversSelection(requestedMap, selected);

    // 3. Client-side validation gate — all-or-nothing, byte-for-byte push's.
    //    Any failure aborts everything: nothing is mapped and nothing is sent.
    const reasons: string[] = failures.map((f) => `${f.file}: ${f.error}`);
    for (const def of selected) {
      reasons.push(...lintDef(def).errors.map((e) => `${def.name}: ${e}`));
      reasons.push(...validateDef(def).map((e) => `${def.name}: ${e}`));
      const report = modelCheck(def, { assumeProvided: true });
      if (hasDefiniteCheckDefect(report)) {
        reasons.push(
          `${def.name}: definite defects found (${report.invariantViolations.length} invariant violation(s), ` +
            `${report.structurallyDeadSteps.length} structurally dead step(s), ` +
            `${report.deadlocks.length} true deadlock(s))`,
        );
      }
    }

    // 4. Push candidates: verbatim source yaml + the server-canonical hash.
    //    include:/bodyFile: defs are not hub-pushable, exactly as in `push`.
    const candidates: DefPushCandidate[] = [];
    for (const def of selected) {
      if (!def.dir) {
        reasons.push(`${def.name}: has no source file on disk to push`);
        continue;
      }
      const yaml = readFileSync(def.dir, 'utf8');
      let usesInclude = false;
      try {
        usesInclude = (buildDef(parseYaml(yaml), basename(def.dir), dirname(def.dir))._includes?.length ?? 0) > 0;
      } catch {
        // A shape error would already have surfaced via the gate above.
      }
      if (usesInclude) {
        reasons.push(`${def.name}: uses include:, not hub-pushable yet`);
        continue;
      }
      try {
        candidates.push({ name: def.name, hash: hashDefForHub(yaml), yaml });
      } catch (e) {
        if (e instanceof DefError && /bodyFile/.test(e.message)) {
          reasons.push(`${def.name}: uses bodyFile:, not hub-pushable`);
          continue;
        }
        throw e;
      }
    }
    if (reasons.length > 0) {
      throw new CliError(
        `refusing to install ${sourceRef} — ${reasons.length} problem(s) found; nothing mapped, nothing published:\n  - ${reasons.join('\n  - ')}`,
      );
    }

    // 5. THE NON-INTERACTIVE GUARD, before a single hub request.
    //    Resolved here rather than at the first question so a piped run fails
    //    with the flag names while the request log is still empty — never after
    //    a mapping read has already happened. If carry-forward later covers
    //    every capability, this prompt is simply never called.
    const uncovered = selected.some((def) =>
      authoredCapabilitiesOf(def).some((cap) => requestedMap[cap] === undefined),
    );
    const prompt =
      !uncovered || acceptDefaults
        ? undefined
        : requirePrompt(
            io,
            'owenloop install needs to ask what your org should call each capability this def authors, ' +
              'but stdin is not interactive — pass --map <authored>=<org> for each one, ' +
              'or --accept-defaults to take the scoped <defName>.<capability> name for all of them',
          );

    // 6. The org's existing vocabulary, so an operator choosing to LINK is
    //    choosing informed. Read-only; publishes nothing.
    const { res: routesRes, cred: routesCred } = await authedGet(
      io,
      origin,
      slot,
      holder.cred,
      '/api/capability_routes',
    );
    assertAuthOk(routesRes, routesCred, origin);
    holder.cred = routesCred;
    let vocabulary: CapabilityRouteWire[];
    try {
      vocabulary = asCapabilityRoutes(await routesRes.json());
    } catch (e) {
      throw new CliError((e as Error).message);
    }

    // 7. Decide the vocabulary for each def: --map wins, then carry-forward,
    //    then --accept-defaults, then the prompt.
    const transport = capabilityMappingTransport(io, origin, slot, holder);
    const plans: DefMappingPlan[] = [];
    for (const def of selected) {
      const authored = authoredCapabilitiesOf(def);
      const resolved: Record<string, string> = {};
      const toRecord: Record<string, string> = {};
      if (authored.length === 0) {
        plans.push({ def, resolved, toRecord });
        continue;
      }
      const existingOrUnsupported = await fetchCapabilityMappings(transport, def.name, origin);
      const existing = existingOrUnsupported === 'unsupported' ? {} : existingOrUnsupported;
      const unsupported = existingOrUnsupported === 'unsupported';
      const needsAsking = authored.filter(
        (cap) => requestedMap[cap] === undefined && (unsupported || existing[cap] === undefined),
      );
      if (needsAsking.length > 0 && !acceptDefaults) {
        if (unsupported) {
          // The risk the operator must see BEFORE the first question: pressing
          // Enter through the prompts overwrites a deliberate link this hub
          // cannot report.
          io.err(
            `${origin} cannot report capability mappings already recorded for ${def.name} — ` +
              'every capability will be asked about again, and the answers overwrite whatever is recorded.',
          );
        }
        io.err(
          `\n${def.name} authors ${authored.length} capability(ies). Enter = keep the scoped name; ` +
            'type an org capability to link it into your existing vocabulary.',
        );
        const vocab = formatOrgVocabulary(vocabulary);
        io.err(vocab === '' ? 'Your org routes no capabilities yet.' : `Your org already routes: ${vocab}`);
        io.err('');
      }
      for (const cap of authored) {
        const chosen =
          requestedMap[cap] ??
          (unsupported ? undefined : existing[cap]) ??
          (acceptDefaults || prompt === undefined
            ? scopedCapabilityName(def.name, cap)
            : await promptCapabilityMapping(io, prompt, def.name, cap));
        resolved[cap] = chosen;
        // Identity rows are dropped hub-side, and a carried-forward row the hub
        // already holds needs no rewrite — so neither is worth a write.
        if (chosen !== cap && existing[cap] !== chosen) toRecord[cap] = chosen;
      }
      plans.push({ def, resolved, toRecord });
    }
    const mapped = Object.fromEntries(plans.map((p) => [p.def.name, p.resolved]));
    const wouldRecord = plans.filter((p) => Object.keys(p.toRecord).length > 0);

    // 8. The server diff, the same source of truth `push` uses.
    const { res: listRes, cred: listCred } = await authedGet(io, origin, slot, holder.cred, '/api/workflows');
    assertAuthOk(listRes, listCred, origin);
    holder.cred = listCred;
    let serverMap: ReturnType<typeof parseWorkflowList>;
    try {
      serverMap = parseWorkflowList(await listRes.json());
    } catch (e) {
      throw new CliError((e as Error).message);
    }
    const { toPush, unchanged } = computeServerDiff(candidates, serverMap, false);
    for (const c of unchanged) io.err(`= ${c.name} (unchanged)`);

    if (dryRun) {
      for (const c of toPush) io.err(c.status === 'new' ? `+ ${c.name} (new)` : `~ ${c.name} (changed)`);
      for (const plan of wouldRecord) {
        for (const [authored, org] of Object.entries(plan.toRecord)) {
          io.err(`  would record ${plan.def.name}: ${authored} → ${org}`);
        }
      }
      print(io, {
        ok: true,
        dryRun: true,
        hub: origin,
        source: sourceRef,
        mapped,
        wouldRecord: Object.fromEntries(wouldRecord.map((p) => [p.def.name, p.toRecord])),
        new: toPush.filter((c) => c.status === 'new').map((c) => c.name),
        changed: toPush.filter((c) => c.status === 'changed').map((c) => c.name),
        unchanged: unchanged.map((c) => c.name),
        wouldPush: toPush.map((c) => c.name),
      });
      return 0;
    }

    // 9. RECORD, THEN PUBLISH. A hub with no mapping writer throws here — with
    //    zero create_workflow calls behind it.
    const recorded: string[] = [];
    for (const plan of wouldRecord) {
      await recordCapabilityMappings(transport, plan.def.name, plan.toRecord, origin);
      recorded.push(plan.def.name);
      for (const [authored, org] of Object.entries(plan.toRecord)) {
        io.err(`  recorded ${plan.def.name}: ${authored} → ${org}`);
      }
    }

    // 10. Publish, on push's ladder.
    holder.cred = await ensureFreshOAuth(io, origin, slot, holder.cred);
    const published = await publishCandidates(io, origin, slot, holder, toPush, selectedDependencies);
    print(io, {
      ok: published.failed.length === 0,
      hub: origin,
      source: sourceRef,
      mapped,
      recorded,
      pushed: published.pushed,
      noop: published.noop,
      unchanged: unchanged.map((c) => c.name),
      skipped: published.skipped,
      failed: published.failed,
      capabilities: published.capabilities,
    });
    return published.failed.length === 0 ? 0 : 1;
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

/**
 * Resolve the hub for the per-run commands (`start`, `cancel`) without ever
 * falling through to the production default or an ambient `OWENLOOP_HUB`. A
 * connected project supplies the durable default. `--hub` is allowed for an
 * unbound directory, but must agree with an existing binding so a copied
 * command cannot silently start — or cancel — a run on the wrong control plane.
 */
function resolveStartHub(io: CliIO, args: Args): string {
  const binding = readHubBinding(hubBindingPath(io.cwd));
  let bound: string | undefined;
  if (binding !== null) {
    try {
      bound = normalizeOrigin(binding.hub);
    } catch (e) {
      throw new CliError(`${(e as Error).message} — re-run \`owenloop connect\` to rebind`);
    }
  }

  const hubArg = last(args, 'hub');
  if (hubArg !== undefined) {
    let requested: string;
    try {
      requested = normalizeOrigin(hubArg);
    } catch (e) {
      throw new CliError((e as Error).message);
    }
    if (bound !== undefined && requested !== bound) {
      throw new CliError(`this project is bound to ${bound}, not ${requested} — re-run \`owenloop connect\` to rebind`);
    }
    return requested;
  }

  if (bound !== undefined) return bound;
  throw new CliError('this project is not bound to a hub — run `owenloop connect`, or pass --hub <url>');
}

/** Extract the stable hub message without ever echoing an untyped raw body. */
async function hubRequestMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as unknown;
    if (typeof body !== 'object' || body === null) return undefined;
    const message = (body as Record<string, unknown>).message;
    return typeof message === 'string' && message !== '' ? message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `owenloop start` — the small, public per-run control-plane command.
 * Durable setup (login/connect/push/prepare and a standing Shift) remains
 * separate; starting another instance is one authenticated POST using the
 * human credential and the same repeated `--provide name=json` grammar as the
 * local `create` command.
 */
async function dispatchStart(io: CliIO, args: Args): Promise<number> {
  const defName = need(args, 1, 'defName');
  const requiredTextOption = (key: 'crew' | 'title' | 'modifier' | 'scope' | 'priority', label: string): string | undefined => {
    if (args.missingOptionValues.has(key)) {
      throw new CliError(`missing value for --${key}: expected --${key} <${label}>`);
    }
    const value = last(args, key);
    if (value !== undefined && value.trim() === '') {
      throw new CliError(`invalid empty value for --${key}: expected --${key} <${label}>`);
    }
    return value;
  };
  // Validate request-only options before project binding, Keychain, or network access.
  const crew = requiredTextOption('crew', 'name');
  const title = requiredTextOption('title', 'text');
  // The run's ONE routing modifier. Validated by the hub against the def's
  // declared `modifiers:` set (a value outside it is a 400 `modifier_refused`),
  // so the CLI only enforces the shape every other text option enforces:
  // `--modifier` with no value, or with an empty one, is a usage error rather
  // than a silent unmodified run. Omitting the flag entirely IS the unmodified
  // run — that is the difference `requiredTextOption` preserves.
  const modifier = requiredTextOption('modifier', 'name');
  // Free routing label. No registry and no enumeration by design (§4.8), so the
  // only shape check is the one every text option gets: present-but-valueless and
  // explicitly-empty are usage errors; omitted is omitted.
  const scope = requiredTextOption('scope', 'label');
  const priority = requiredTextOption('priority', 'low|normal|high');
  if (priority !== undefined && !START_PRIORITIES.has(priority)) {
    throw new CliError(`invalid --priority '${priority}' — must be one of low, normal, high`);
  }
  const origin = resolveStartHub(io, args);
  const slot: CredentialSlotSelector = { principal: 'human' };
  const cred = readCredential(io, origin, slot);
  if (cred === null) {
    throw new CliError(`no human credential for ${origin} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
  }

  const provide = parsePairs(all(args, 'provide'), true);
  const request = {
    workflow_name: defName,
    ...(Object.keys(provide).length > 0 ? { provide } : {}),
    ...(crew !== undefined ? { default_crew: crew } : {}),
    ...(title !== undefined ? { title } : {}),
    // Spread-conditional, not `modifier` outright: the route reads `''` and
    // absent as the same thing, but sending an explicit `undefined` would put a
    // `modifier` key in the JSON body with a null value. Omitted means omitted.
    ...(modifier !== undefined ? { modifier } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };

  const { res, cred: used } = await authedPost(io, origin, slot, cred, '/api/start_run', request);
  if (res.status === 401) assertAuthOk(res, used, origin);
  if (!res.ok) {
    const message = await hubRequestMessage(res);
    throw new CliError(message ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
  }

  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    throw new CliError('start_run: malformed success response — body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null) {
    throw new CliError('start_run: malformed success response — body is not an object');
  }
  const wire = body as Record<string, unknown>;
  if (typeof wire.workflow !== 'string' || wire.workflow === '') {
    throw new CliError('start_run: malformed success response — missing workflow id');
  }
  if (wire.def !== defName) {
    throw new CliError('start_run: malformed success response — definition does not match the request');
  }
  if (typeof wire.status !== 'object' || wire.status === null || Array.isArray(wire.status)) {
    throw new CliError('start_run: malformed success response — missing status object');
  }

  print(io, {
    ok: true,
    hub: origin,
    workflow: wire.workflow,
    def: wire.def,
    status: wire.status,
    // Echoed from the REQUEST, not the response — `start_run` returns no
    // `modifier` field. That is not an assumption about what the hub stored: a
    // value outside the def's declared `modifiers:` set is refused with a 400
    // before any instance exists, so reaching this line at all proves the hub
    // accepted exactly this value. Printed only when the flag was passed, so an
    // unmodified run's output is byte-identical to what it was before.
    ...(modifier !== undefined ? { modifier } : {}),
    // Echoed from the request, like `modifier` above, and only when the flag
    // was passed. A run started without these flags prints exactly what it did
    // before, while a hub refusal prevents this success output entirely.
    ...(scope !== undefined ? { scope } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(Array.isArray(wire.stampedCrews) ? { stampedCrews: wire.stampedCrews } : {}),
    ...(Array.isArray(wire.validatedCrews) ? { validatedCrews: wire.validatedCrews } : {}),
  });
  return 0;
}

/**
 * `owenloop cancel` — stop a running instance from the terminal.
 *
 * The counterpart to `start`, and the only local way out of a run that can no
 * longer make progress: a step whose worktree was deleted, or an instance
 * pinned to a def version its shift can no longer satisfy. Without this, such a
 * run is re-offered forever and permanently occupies one of a shift's dispatch
 * slots, because nothing else on this machine can move it to a terminal state.
 *
 * Three properties of the hub verb this command deliberately surfaces rather
 * than hides (`hub-core/src/verbs/cancel-run.ts`):
 *
 *  - It is HUMAN-ROLE-ONLY. `cancel_run` has no agent-scope entry, so an agent
 *    credential is refused by the hub. This command therefore never consults
 *    `--as` and always reads the `human` slot — offering `--as` would only
 *    produce a 403 further down.
 *  - It is IDEMPOTENT. Cancelling an instance that already reached a terminal
 *    state returns `cancelled: false` plus that state, and writes nothing. That
 *    is a success, not an error, so it exits 0 — a retried cancel must not look
 *    like a failure.
 *  - Its receipt records `outcome: 'failed'`, because the receipt union is only
 *    `done|failed`. The true cancel fact lives in the instance's distinct
 *    `cancelled` status and an `action: 'cancel'` audit row. We print the
 *    status, not the receipt outcome, so the output does not imply the run
 *    failed on its own.
 */
async function dispatchCancel(io: CliIO, args: Args): Promise<number> {
  const workflow = need(args, 1, 'workflow');
  if (args.missingOptionValues.has('reason')) {
    throw new CliError('missing value for --reason: expected --reason <text>');
  }
  const reason = last(args, 'reason');
  if (reason !== undefined && reason.trim() === '') {
    throw new CliError('invalid empty value for --reason: expected --reason <text>');
  }

  const origin = resolveStartHub(io, args);
  const slot: CredentialSlotSelector = { principal: 'human' };
  const cred = readCredential(io, origin, slot);
  if (cred === null) {
    throw new CliError(`no human credential for ${origin} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
  }

  const request = {
    workflow,
    ...(reason !== undefined ? { reason } : {}),
  };

  const { res, cred: used } = await authedPost(io, origin, slot, cred, '/api/cancel_run', request);
  if (res.status === 401) assertAuthOk(res, used, origin);
  if (!res.ok) {
    const message = await hubRequestMessage(res);
    throw new CliError(message ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
  }

  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    throw new CliError('cancel_run: malformed success response — body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CliError('cancel_run: malformed success response — body is not an object');
  }
  const wire = body as Record<string, unknown>;
  if (typeof wire.cancelled !== 'boolean') {
    throw new CliError('cancel_run: malformed success response — missing cancelled flag');
  }

  print(io, {
    ok: true,
    hub: origin,
    workflow,
    cancelled: wire.cancelled,
    // Present only on the already-terminal path, where the hub reports the state
    // it found instead of the one it set. On the cancelling path the status is
    // `cancelled` by construction, so we state it rather than inventing a field
    // the hub did not send.
    status: typeof wire.status === 'string' ? wire.status : 'cancelled',
    // The runs whose leases were closed. Absent on the no-op path.
    ...(Array.isArray(wire.closedRuns) ? { closedRuns: wire.closedRuns } : {}),
    ...(reason !== undefined ? { reason } : {}),
  });
  return 0;
}

/**
 * `owenloop retry --hub` — the human stall-clear / answer path for a hub-hosted
 * run. Local retry remains synchronous in `main()`; this dispatch owns only
 * the network half so direct synchronous callers keep their existing contract.
 */
async function dispatchRetry(io: CliIO, args: Args): Promise<number> {
  const workflow = need(args, 1, 'workflow');
  const path = need(args, 2, 'path');
  if (args.options.has('by')) {
    throw new CliError('owenloop retry: --by cannot be combined with --hub — the hub attributes the retry to the authenticated human principal');
  }
  if (args.missingOptionValues.has('text')) {
    throw new CliError('missing value for --text: expected --text <guidance>');
  }
  const text = last(args, 'text');
  if (text !== undefined && text.trim() === '') {
    throw new CliError('invalid empty value for --text: expected --text <guidance>');
  }

  const origin = resolveStartHub(io, args);
  const slot: CredentialSlotSelector = { principal: 'human' };
  const cred = readCredential(io, origin, slot);
  if (cred === null) {
    throw new CliError(`no human credential for ${origin} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
  }

  const request = { workflow, path, ...(text !== undefined ? { text } : {}) };
  const { res, cred: used } = await authedPost(io, origin, slot, cred, '/api/retry_artifact', request);
  if (res.status === 401) assertAuthOk(res, used, origin);
  if (!res.ok) {
    const message = await hubRequestMessage(res);
    throw new CliError(message ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
  }

  // The hub owns the response body contract. Any successful response has
  // completed the state transition, so expose a stable CLI receipt instead of
  // assuming fields the server has not promised this client.
  print(io, { ok: true, action: 'retry', path, workflow, hub: origin });
  return 0;
}

/**
 * `owenloop reject --hub` — the human control-plane counterpart to local
 * `engine.reject()`. The hub owns attribution, so a remote request cannot
 * carry the local-only `--by` authority input.
 */
async function dispatchReject(io: CliIO, args: Args): Promise<number> {
  const workflow = need(args, 1, 'workflow');
  const path = need(args, 2, 'path');
  if (args.options.has('by')) {
    throw new CliError('owenloop reject: --by cannot be combined with --hub — the hub attributes the rejection to the authenticated human principal');
  }
  const text = last(args, 'text');
  if (args.missingOptionValues.has('text') || text === undefined) {
    throw new CliError('missing value for --text: expected --text <reason>');
  }
  if (text.trim() === '') {
    throw new CliError('invalid empty value for --text: expected --text <reason>');
  }
  if (args.missingOptionValues.has('requested')) {
    throw new CliError('missing value for --requested: expected --requested <modifier>');
  }
  const requested = last(args, 'requested');

  const origin = resolveStartHub(io, args);
  const slot: CredentialSlotSelector = { principal: 'human' };
  const cred = readCredential(io, origin, slot);
  if (cred === null) {
    throw new CliError(`no human credential for ${origin} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
  }

  const request = {
    workflow,
    path,
    reason: text,
    ...(requested !== undefined ? { requested } : {}),
  };
  const { res, cred: used } = await authedPost(io, origin, slot, cred, '/api/reject_artifact', request);
  if (res.status === 401) assertAuthOk(res, used, origin);
  if (!res.ok) {
    const message = await hubRequestMessage(res);
    throw new CliError(message ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
  }

  print(io, {
    ok: true,
    action: 'reject',
    path,
    workflow,
    hub: origin,
    ...(requested !== undefined ? { requested } : {}),
  });
  return 0;
}

/**
 * `owenloop provide --hub` — supply a hosted workflow input using the human
 * control plane. Local input provisioning remains in `main()`.
 */
async function dispatchProvide(io: CliIO, args: Args): Promise<number> {
  const workflow = need(args, 1, 'workflow');
  const name = need(args, 2, 'name');
  // Keep this ahead of binding, credentials, and fetch: malformed input has no
  // external effects, matching the local provide command's JSON contract.
  const value = parseJson(last(args, 'value'));

  const origin = resolveStartHub(io, args);
  const slot: CredentialSlotSelector = { principal: 'human' };
  const cred = readCredential(io, origin, slot);
  if (cred === null) {
    throw new CliError(`no human credential for ${origin} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
  }

  const { res, cred: used } = await authedPost(io, origin, slot, cred, '/api/provide_input', { workflow, name, value });
  if (res.status === 401) assertAuthOk(res, used, origin);
  if (!res.ok) {
    const message = await hubRequestMessage(res);
    throw new CliError(message ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
  }

  print(io, { ok: true, provided: name, workflow, hub: origin });
  return 0;
}

/**
 * `owenloop instance` — read a HUB instance's live state from the terminal.
 *
 * The read counterpart to `start` and `cancel`. Two naming constraints forced
 * this word, and both are collisions with commands that already exist:
 *
 *  - NOT `status`. `owenloop status` is the LOCAL engine's status and takes
 *    `--db`; it has no hub credential and rejects `--hub`.
 *  - NOT `runs`. `owenloop runs <workflow> [--open]` already lists runs out of
 *    the LOCAL sqlite store. Reusing it would have silently rerouted a local
 *    command to the network.
 *
 * `instance` is the hub's own term for a started workflow — `setInstanceStatus`,
 * `listInstancesWithStatus`, and `cancel_run`'s own "already-terminal instance"
 * all use it — so a hub instance and a local run stay distinct objects with
 * distinct commands rather than one command whose meaning flips on a flag.
 *
 * Only `show` exists today, and that is a hub limitation rather than a design
 * choice. `getStatus` is the one instance-read verb with a REST route
 * (`GET /api/status/:wf`). The verb that lists instances,
 * `listInstancesWithStatus`, and the two that carry receipt bodies —
 * `listReceipts` and `getReceiptDetail`, which is where a reviewer's reject
 * reason actually lives — are exposed only over tRPC for the console. Adding
 * `instance list`, or any command that can print WHY a step was rejected,
 * therefore requires new routes on `apps/hub-edge/src/api/routes.ts` and a hub
 * deploy; it is not something this CLI can reach today. The subcommand form
 * exists so those arrive as `instance list` without renaming anything.
 *
 * Like `cancel`, this reads the `human` slot and never consults `--as`, and it
 * resolves the hub through `resolveStartHub` so an ambient `OWENLOOP_HUB` can
 * never silently redirect the read to a different control plane than the one
 * the project is bound to.
 */
async function dispatchInstance(io: CliIO, args: Args): Promise<number> {
  const USAGE_FORMS = 'usage: owenloop instance show <workflow> [--hub <url>]';

  const sub = args.positionals[1];
  if (sub !== 'show') {
    throw new CliError(`unknown instance subcommand '${sub ?? ''}' — ${USAGE_FORMS}`);
  }
  const workflow = args.positionals[2];
  if (workflow === undefined || workflow === '') {
    throw new CliError(`missing required argument: workflow (${USAGE_FORMS})`);
  }

  const origin = resolveStartHub(io, args);
  const slot: CredentialSlotSelector = { principal: 'human' };
  const cred = readCredential(io, origin, slot);
  if (cred === null) {
    throw new CliError(`no human credential for ${origin} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
  }

  // The workflow id is a path segment, so it must be encoded — an id carrying a
  // slash would otherwise silently address a different route.
  const path = `/api/status/${encodeURIComponent(workflow)}`;
  const { res, cred: used } = await authedGet(io, origin, slot, cred, path);
  if (res.status === 401) assertAuthOk(res, used, origin);
  if (!res.ok) {
    const message = await hubRequestMessage(res);
    throw new CliError(message ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
  }

  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    throw new CliError('get_status: malformed success response — body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CliError('get_status: malformed success response — body is not an object');
  }
  const wire = body as Record<string, unknown>;
  // `done` is the one field every status carries and the one a script branches
  // on, so its absence means we are not looking at a status at all. Refuse
  // rather than print a shape that reads as "not done".
  if (typeof wire.done !== 'boolean') {
    throw new CliError('get_status: malformed success response — missing done flag');
  }

  const arrayOr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  // The hub's terminal INSTANCE STATUS verdict is optional on the wire: older
  // hubs predate these fields. Absent means absent — neither value is defaulted,
  // because `terminal: false` and `instanceStatus: 'unknown'` are real answers.
  // The status vocabulary belongs to the hub, so a future non-empty string is
  // forwarded verbatim instead of being rejected by a CLI-owned enum.
  const instanceStatus =
    typeof wire.instanceStatus === 'string' && wire.instanceStatus !== '' ? wire.instanceStatus : undefined;
  const terminal = typeof wire.terminal === 'boolean' ? wire.terminal : undefined;
  print(io, {
    ok: true,
    hub: origin,
    workflow,
    // These answer whether the instance is alive; `done` is the engine's
    // completion flag, and failed or cancelled instances are terminal without
    // being done.
    ...(instanceStatus === undefined ? {} : { instanceStatus }),
    ...(terminal === undefined ? {} : { terminal }),
    done: wire.done,
    // Owed inputs the instance is waiting on, each with its acceptance and
    // whether the engine considers it stalled.
    debts: arrayOr(wire.debts),
    // Steps that could be dispatched now, and steps whose preconditions are not
    // met yet. A run that is neither done nor eligible nor in flight is stuck.
    eligible: arrayOr(wire.eligible),
    blocked: arrayOr(wire.blocked),
    inFlight: arrayOr(wire.inFlight),
    // True when the def loaded on the hub has moved on from the snapshot this
    // instance is pinned to. A pinned instance never picks up the new version,
    // so this is the field that explains "I published a fix and the run still
    // does the old thing".
    defDrift: wire.defDrift === true,
    // Present only when a step's capability has no crew bound to it, which
    // looks identical to "nothing is picking this up" from the outside.
    ...(Array.isArray(wire.waitingOnCapabilities) ? { waitingOnCapabilities: wire.waitingOnCapabilities } : {}),
  });
  // The hub owns this mapping; do not derive terminality from its status label.
  // stderr preserves the JSON stdout contract while still reaching an operator
  // who is piping it to another command.
  if (terminal === true) {
    const terminalMessage =
      `instance ${workflow} is ${instanceStatus ?? 'in a terminal state'} — TERMINAL. ` +
      'The hub will dispatch nothing further for it; an empty `eligible` here is a finished run, not an idle shift.';
    io.err(terminalMessage);
  }
  return 0;
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

/** POST opaque bundle/sidecar bytes with the same one-refresh auth contract as JSON hub calls. */
async function authedPushBytes(
  io: CliIO,
  origin: string,
  slot: CredentialSlotSelector,
  cred: Credential,
  path: string,
  bytes: Uint8Array,
  headers: Record<string, string>,
): Promise<{ res: Response; cred: Credential }> {
  let current = await ensureFreshOAuth(io, origin, slot, cred);
  const send = (bearer: Credential): Promise<Response> =>
    hubFetch(io, resolveEndpoint(origin, path), {
      method: 'POST',
      headers: { Authorization: authHeader(bearer), Accept: 'application/json', ...headers },
      body: Buffer.from(bytes),
    });
  let res = await send(current);
  if (res.status === 401 && current.kind === 'oauth') {
    current = await refreshOAuth(io, origin, slot, current as Extract<Credential, { kind: 'oauth' }>);
    res = await send(current);
  }
  return { res, cred: current };
}

async function assertPushArtifactOk(res: Response, cred: Credential, origin: string, label: string): Promise<void> {
  if (res.status === 401) assertAuthOk(res, cred, origin);
  if (res.status === 413) throw new CliError(`${label} exceeds the hub request cap`);
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new CliError(`rate limited while uploading ${label}${retryAfter ? ` (retry after ${retryAfter})` : ''}`);
  }
  if (!res.ok) {
    const message = await hubRequestMessage(res);
    throw new CliError(message === undefined ? `hub returned HTTP ${res.status} while uploading ${label}` : `${label}: ${message}`);
  }
}

/** Upload the exact archive and adjacent publication/origin records before any definition version is created. */
async function uploadPushBundle(
  io: CliIO,
  origin: string,
  slot: CredentialSlotSelector,
  initial: Credential,
  bundle: PushBundleContext,
): Promise<Credential> {
  let cred = initial;
  let sent = await authedPushBytes(io, origin, slot, cred, '/api/bundles', bundle.bytes, {
    'Content-Type': 'application/gzip',
    'X-Bundle-Digest': bundle.digest,
  });
  cred = sent.cred;
  await assertPushArtifactOk(sent.res, cred, origin, 'bundle');

  sent = await authedPushBytes(
    io,
    origin,
    slot,
    cred,
    `/api/publications/${bundle.digest}?state=${bundle.publicationState}`,
    bundle.publication,
    { 'Content-Type': 'application/json' },
  );
  cred = sent.cred;
  await assertPushArtifactOk(sent.res, cred, origin, 'publication sidecar');

  if (bundle.origin !== undefined) {
    sent = await authedPushBytes(
      io,
      origin,
      slot,
      cred,
      `/api/origins/${bundle.digest}`,
      bundle.origin,
      { 'Content-Type': 'application/json' },
    );
    cred = sent.cred;
    await assertPushArtifactOk(sent.res, cred, origin, 'origin sidecar');
  }
  return cred;
}

function createWorkflowRequest(
  io: CliIO,
  origin: string,
  cred: Credential,
  yaml: string,
  bundleDigest?: string,
): Promise<Response> {
  return hubFetch(io, resolveEndpoint(origin, '/api/create_workflow'), {
    method: 'POST',
    headers: {
      Authorization: authHeader(cred),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ yaml, ...(bundleDigest === undefined ? {} : { bundle_digest: bundleDigest }) }),
  });
}

/**
 * Resolve the hub a mutating hub command acts on — shared by `agent new`,
 * `capability bind|unbind|list`, and `crew`'s five subcommands: `--hub <origin>`
 * (normalized via `normalizeOrigin`) → else the ONE hub the credential FILE
 * knows → else a `CliError` with `exitCode: 2` naming both remedies.
 *
 * `purpose` is the verb phrase spliced into both exit-2 messages ("cannot
 * determine which hub to <purpose> — …"). It defaults to `'mint on'` so
 * `dispatchAgent`'s two-argument call keeps `agent new`'s error strings
 * byte-identical; `dispatchCapability` passes `'manage capability routes on'`;
 * `dispatchCrew` passes `'manage crews on'`.
 *
 * Deliberately NOT `resolveHub` (`--hub → OWENLOOP_HUB → DEFAULT_HUB`): silently
 * defaulting a MINT to the production hub while the user is logged into a dev hub
 * would mint on the wrong org, and a mint is not undone by a retry. The same
 * reasoning covers a capability route — writing one against the wrong org is not
 * undone by a retry either, and under live resolution it also moves in-flight
 * work. `OWENLOOP_HUB` is intentionally excluded so this stays in parity with
 * O2's `owenloop mcp`.
 *
 * `listStoredHubOrigins` is backend-aware (shared with O2's `owenloop mcp`): only
 * the FILE backend can enumerate, so it returns `null` on a keychain- or
 * external-command-backed machine — those must pass `--hub`. A file-backed store
 * returns the origins with a valid `human` slot: `[]` (log in first), exactly one
 * (used automatically), or more than one (the non-secret origin keys are listed
 * back so the user can pick).
 */
function resolveAgentHub(io: CliIO, args: Args, purpose = 'mint on'): string {
  const flagVal = last(args, 'hub');
  if (flagVal !== undefined) {
    try {
      return normalizeOrigin(flagVal);
    } catch (e) {
      throw new CliError((e as Error).message);
    }
  }
  const discovered = discoverStoredHubs(io);
  if (discovered.kind === 'non-enumerable') {
    throw new CliError(
      `cannot determine which hub to ${purpose} — the ${discovered.backend} credential store cannot be enumerated; ` +
        'pass --hub <origin>',
      { exitCode: 2 },
    );
  }
  if (discovered.kind === 'one') return discovered.origin;
  throw new CliError(
    `cannot determine which hub to ${purpose} — pass --hub <origin>, or log in to exactly one hub first ` +
      '(owenloop login --hub <origin>)' +
      (discovered.kind === 'multiple' ? `; stored hubs: ${discovered.origins.join(', ')}` : ''),
    { exitCode: 2 },
  );
}

/**
 * `owenloop agent new <name>` — mint a new Scoped Identity on the hub and store
 * its `olp_` token in slot `agent:<name>`.
 *
 * **Secret hygiene (identity model §6, "rule of gates"):** the minted token goes
 * process→store ONLY — it never appears on stdout, stderr, in an error, or in a
 * log. `mintAgentCredential` (credentials.ts) owns the token end to end and
 * returns none of it; the confirmation printed here is built from an explicit
 * WHITELIST of non-secret fields (name, crews, scopes, storage backend,
 * revocation ids).
 *
 * Flags: `--crews a,b` (the Scoped Identity's crews; default = minter's personal crew);
 * `--scopes a,b` (the minted token's scopes; default `work`); `--shift`
 * (sugar for `--scopes work,run`; mutually exclusive with `--scopes`); `--hub`.
 * `--scopes` is passed to the hub verbatim — no client-side scope-name check.
 *
 * Ordering is load-bearing (PR #69 lesson, carried by `mintAgentCredential`): the
 * client-side name validation and the external-command refusal both run BEFORE
 * any network call, so a refusal that would make the credential unstorable never
 * mints a server-side token first — minting then failing to store would burn the
 * agent name permanently.
 *
 * Exit codes: 0 ok; 1 generic failure (invalid name, name taken, crew/shape
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
      'missing required argument: <name> (usage: owenloop agent new <name> [--crews a,b] [--scopes work,run | --shift] [--hub <url>])',
    );
  }
  // Validate the agent name eagerly — before any I/O — with the store's own
  // wording, so a bad name never reaches the network or the store.
  try {
    credentialSlot({ principal: 'agent', account: name });
  } catch (e) {
    throw new CliError(`agent new: invalid agent name — ${(e as Error).message}`);
  }

  // --crews: split on `,`, trim, drop empties. Absent → undefined (key omitted
  // from the request; the server then defaults to the minter's personal crew).
  // Present but empty (`--crews ""` / `--crews ,`) → usage error, before any I/O.
  // No client-side crew-name validation — the server is the enforcement of record.
  const crewsRaw = last(args, 'crews');
  let crews: string[] | undefined;
  if (crewsRaw !== undefined) {
    crews = crewsRaw
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    if (crews.length === 0) {
      throw new CliError('--crews requires at least one crew name');
    }
  }

  // --scopes: same split/trim/filter shape as --crews. Absent → undefined (the
  // key is omitted from the mint params, so mintAgentCredential applies its own
  // `?? ['work']` default). Present but empty (`--scopes ""` / `--scopes ,`) →
  // usage error, before any I/O. No client-side scope-NAME validation — the hub
  // is the enforcement of record (same stance as crews).
  const scopesRaw = last(args, 'scopes');
  let scopes: string[] | undefined;
  if (scopesRaw !== undefined) {
    scopes = scopesRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (scopes.length === 0) {
      throw new CliError('--scopes requires at least one scope name');
    }
  }
  // --shift is sugar for --scopes work,run. It takes no value. Combining it
  // with an explicit --scopes is a usage error (two ways to say the same thing,
  // possibly conflicting) — refused before any I/O.
  const shift = flag(args, 'shift');
  if (shift) {
    if (scopes !== undefined) {
      throw new CliError('pass at most one of --scopes or --shift, not both');
    }
    scopes = ['work', 'run'];
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
    result = await mintAgentCredential(io, origin, { principal: 'human' }, cred, { name, crews, scopes });
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
    crews: result.crews,
    scopes: result.scopes,
    storage: result.storage,
    agentId: result.agentId,
    tokenId: result.id,
  });
  return 0;
}

/**
 * `owenloop capability bind|unbind|list` — manage the hub org's **capability routes**, the
 * admin-owned table mapping a workflow-def `capabilities:` entry to a crew.
 *
 * A capability route is NOT the project↔hub route `owenloop connect` writes to
 * `.owenloop/hub.json` — different concept, same English word; every symbol in
 * this family is `CapabilityRoute`-prefixed to keep them apart.
 *
 * | subcommand | endpoint | auth principal |
 * |---|---|---|
 * | `capability bind <capability> <crew>` | `POST /api/add_capability_route` | human (admin role on the hub) |
 * | `capability unbind <capability> <crew>` | `POST /api/remove_capability_route` | human (admin role on the hub) |
 * | `capability list` | `GET /api/capability_routes` | human |
 *
 * **route is ADDITIVE, and idempotent per `(capability, crew)` PAIR.** A capability may
 * bind MANY crews. `capability bind` on an already-bound capability ADDS a crew; it never
 * displaces one already bound. Re-adding the same pair is a normal 200 no-op, so
 * there is no "already bound" rejection to handle and no client-side pre-check —
 * the response says which happened via `alreadyBound`, and `boundCrewCount`
 * reports how many LIVE crews the capability binds afterwards.
 *
 * **`capability unbind` removes ONE pair**, which is why `<crew>` is required. Removing
 * the LAST LIVE route PARKS the capability: its in-flight steps are offered to no
 * shift until it is bound again. The response's `remainingCrewIds` is the
 * signal (`[]` = parked), and that case gets a **stderr** warning; so does the
 * tolerant `removed: false` case. stdout stays one parseable JSON document.
 *
 * **Retargeting is now two separate operator acts** — add the new crew, then
 * remove the old one, each separately audited on the hub, with BOTH crews serving
 * in between. The CLI deliberately does NOT synthesize a retarget by chaining the
 * two calls, and there is no back-compat fallback to the old routes. Resolution
 * on the hub is live, so both acts take effect on in-flight runs at their next
 * poll — documented in `docs/cli.md`.
 *
 * What is deliberately NOT copied from `dispatchAgent`: its
 * `OWENLOOP_CREDENTIAL_COMMAND` refusal. That guard exists because `agent new`
 * must STORE a minted token and an external-command backend has nowhere to write
 * it. `capability` stores nothing locally, so an external-command machine must be
 * able to run all three subcommands. (`resolveAgentHub` still exits 2 on such a
 * machine when `--hub` is absent, because that store cannot be enumerated —
 * inherited unchanged, and correct.)
 *
 * No client-side charset validation of `capability` or `crew`: the hub is the
 * enforcement of record, the same stance `agent new` takes for `--crews`.
 *
 * Exit codes: 0 ok; 1 runtime/hub error (an unknown crew name — `capability bind`
 * ONLY, since `capability unbind` answers a tolerant `removed: false` instead of a
 * 400; a capability that fails the hub's name rules, a 403 for a non-admin, a
 * malformed 2xx, a network timeout); 2 the hub is unresolvable; 3 the human
 * credential is absent or irrecoverable (the error names
 * `owenloop login --hub <origin>`).
 */
async function dispatchCapability(io: CliIO, args: Args): Promise<number> {
  const USAGE_FORMS =
    'usage: owenloop capability bind <capability> <crew> [--hub <url>] | owenloop capability unbind <capability> <crew> [--hub <url>] | owenloop capability list [--hub <url>]';

  // --- validation: everything below runs BEFORE any I/O, so a usage error on a
  //     multi-hub machine reports the usage problem (exit 1), not exit 2.
  const sub = args.positionals[1];
  if (sub !== 'bind' && sub !== 'unbind' && sub !== 'list') {
    throw new CliError(`unknown capability subcommand '${sub ?? ''}' — ${USAGE_FORMS}`);
  }
  let capability = '';
  let crew = '';
  if (sub === 'bind' || sub === 'unbind') {
    // `<crew>` is required for BOTH now: one call adds or removes ONE
    // `(capability, crew)` pair, and a capability-only `unbind` would unbind more than
    // the operator named.
    const rawCapability = args.positionals[2];
    if (rawCapability === undefined || rawCapability === '') {
      throw new CliError(`missing required argument: <capability> (${USAGE_FORMS})`);
    }
    capability = rawCapability;
    const rawCrew = args.positionals[3];
    if (rawCrew === undefined || rawCrew === '') {
      throw new CliError(`missing required argument: <crew> (${USAGE_FORMS})`);
    }
    crew = rawCrew;
  }

  const origin = resolveAgentHub(io, args, 'manage capability routes on');
  const slot: CredentialSlotSelector = { principal: 'human' };

  // The human bearer for the resolved origin. Absent → exit 3 with the same
  // remedy wording `agent new` uses.
  const cred = readCredential(io, origin, slot);
  if (cred === null) {
    throw new CliError(`no human credential for ${origin} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
  }

  try {
    if (sub === 'list') {
      const { res, cred: used } = await authedGet(io, origin, slot, cred, '/api/capability_routes');
      // The GET deliberately uses `assertAuthOk` unchanged (frozen contract), so
      // a non-401 non-2xx surfaces its generic wording rather than the hub's
      // `message`. Message passthrough is a POST-path behavior below.
      assertAuthOk(res, used, origin);
      let body: unknown;
      try {
        body = (await res.json()) as unknown;
      } catch {
        throw new CliError('capability_routes: malformed response — body is not valid JSON');
      }
      let routes;
      try {
        routes = asCapabilityRoutes(body);
      } catch (e) {
        throw new CliError((e as Error).message);
      }
      // The guard's output — a whitelisted typed array — never the raw body.
      print(io, { ok: true, hub: origin, routes });
      return 0;
    }

    // `bind` and `unbind` share one POST ladder AND one request body — `{capability, crew}`,
    // because each call adds or removes exactly one `(capability, crew)` pair. Only the
    // path, the guard, and the printed shape differ.
    const endpoint = sub === 'bind' ? 'add_capability_route' : 'remove_capability_route';
    const { res } = await authedPost(io, origin, slot, cred, `/api/${endpoint}`, { capability, crew });

    if (res.status === 401) {
      // A 401 that survived `authedPost`'s one refresh-and-retry. The human slot
      // never holds an agent kind, so `assertAuthOk`'s non-agent wording applies;
      // the catch below upgrades this to exit 3.
      throw new CliError('credential rejected by the hub — run `owenloop login`');
    }
    if (!res.ok) {
      // Surface the hub's typed `message` VERBATIM (this is how an unknown crew
      // name, an invalid capability, and a non-admin 403 all surface uniformly).
      // Never include raw body text.
      let message: string | undefined;
      try {
        const errBody = (await res.json()) as unknown;
        if (typeof errBody === 'object' && errBody !== null) {
          const m = (errBody as Record<string, unknown>).message;
          if (typeof m === 'string' && m !== '') message = m;
        }
      } catch {
        // Non-JSON body — fall through to the generic status message.
      }
      throw new CliError(message ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
    }

    let body: unknown;
    try {
      body = (await res.json()) as unknown;
    } catch {
      // A FIXED string — never V8's SyntaxError message, which embeds a verbatim
      // snippet of the raw body.
      throw new CliError(`${endpoint}: malformed success response — body is not valid JSON`);
    }

    if (sub === 'bind') {
      let added;
      try {
        added = asCapabilityRouteAdded(body);
      } catch (e) {
        throw new CliError((e as Error).message);
      }
      // The server-echoed capability/crew, not argv: if the hub normalized either,
      // stdout tells the truth about what the hub stored (same precedent as
      // `agent new` printing the server-resolved crews). `alreadyBound` and
      // `boundCrewCount` carry the HUB's own field names verbatim, so an operator
      // correlating stdout against the hub's audit log never has to translate.
      // (They were `alreadyRouted`/`routedCrewCount` here, which the hub never
      // sends — the claim in this comment was the intent, not the behavior.)
      // `createdBy`/`createdAt` are validated but not printed — `capability list` is
      // where a row's provenance belongs.
      print(io, {
        ok: true,
        hub: origin,
        capability: added.binding.capability,
        crew: added.binding.crewName,
        alreadyBound: added.alreadyBound,
        boundCrewCount: added.boundCrewCount,
      });
      // No stderr line on `bind`: an add never displaces a crew and never parks a
      // capability, so there is no consequence to warn about.
      return 0;
    }

    // `unbind`: the guard proves the 2xx really was the remove verb's answer.
    // `removedWire` (not `removed`) so `removedWire.removed` reads unambiguously —
    // the same naming `dispatchCrew` uses for `deletedWire`/`removedWire`.
    let removedWire;
    try {
      removedWire = asCapabilityRouteRemoved(body);
    } catch (e) {
      throw new CliError((e as Error).message);
    }
    // `crewId` (not a crew name): `remove_capability_route` returns no `crewName`, so
    // printing one would be an invention. It is `null` on the tolerant path where
    // the argument matched no live crew name and no row of this capability's own.
    print(io, {
      ok: true,
      hub: origin,
      capability: removedWire.capability,
      crewId: removedWire.crewId,
      removed: removedWire.removed,
      remainingCrewIds: removedWire.remainingCrewIds,
    });
    // stderr only, so `| jq` on stdout is unaffected — mirroring `crew rm` /
    // `crew member rm`, which narrate their tolerant-false case and their
    // notable side effect the same way.
    if (!removedWire.removed) {
      io.err(`${removedWire.capability} was not bound to '${crew}' — nothing was removed`);
    } else if (removedWire.remainingCrewIds.length === 0) {
      io.err(
        `${removedWire.capability}: no live routes remain — runs waiting on this capability are parked until it is bound again`,
      );
    }
    return 0;
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
}

/**
 * `owenloop routing alerts|show|rule list|rule add|rule rm` — read the hub's LIVE
 * routing state, and administer the org's **capability reroute rules**.
 *
 * | subcommand | endpoint | auth principal |
 * |---|---|---|
 * | `routing alerts [--workflow <wf>] [--limit <n>]` | `GET /api/routing_alerts` | human (any role) |
 * | `routing show <workflow>` | `GET /api/run_routing/:wf` | human (any role) |
 * | `routing rule list` | `GET /api/capability_reroutes` | human (any role) |
 * | `routing rule add <capability> <target> [--position <n>]` | `POST /api/add_capability_reroute` | human (admin role) |
 * | `routing rule rm <capability> <target>` | `POST /api/remove_capability_reroute` | human (admin role) |
 *
 * **Three different objects share the word "routing" in this CLI. They are not
 * interchangeable, and only one of them grants anybody work:**
 *
 *  - A **capability route** (`owenloop capability bind`) is a `(capability, crew)`
 *    BINDING. It is the only one of the three that makes a crew eligible to claim
 *    work.
 *  - A **capability reroute rule** (`owenloop routing rule add`) is an ordered
 *    SUBSTITUTION — "when `<capability>` has no live crew binding, offer the work
 *    as `<target>` instead". It names no crew and grants nobody access; whether
 *    the target can actually be served is a `capability bind` question.
 *  - A **routing alert** (`owenloop routing alerts`) is an immutable EVENT row the
 *    hub wrote about one offer at one instant. `kind: 'binding-gap'` is the one to
 *    watch: a step's compound capability (e.g. `build:express`) had no live crew
 *    binding, so the hub HELD the offer rather than silently falling back to
 *    name matching. Holding is the intended behavior; the alert is how a human
 *    finds out it happened.
 *
 * **`routing show <workflow>` is NOT the local `show` command.** `owenloop show`
 * reads a workflow DEFINITION out of the local sqlite store and takes no `--hub`;
 * `routing show` reads one STARTED RUN's routing state off the hub. They share no
 * code path, and this deliberately did not arrive as a `--hub` flag on the local
 * command — the same separation `instance show` keeps.
 *
 * **Two orderings are SEMANTIC and are never re-sorted client-side.** `routing
 * alerts` unscoped returns the org's alerts NEWEST-FIRST (an inbox); adding
 * `--workflow` scopes to one run AND flips to OLDEST-FIRST (a timeline). `routing
 * rule list` returns rules in the order the hub TRIES them. Sorting any of these
 * for looks would misreport what the hub actually does.
 *
 * **`rule add` can fail where `rule rm` cannot** — the deliberate asymmetry
 * `capability bind`/`unbind` already has. `rule add` is idempotent per
 * `(capability, target)` pair (a repeat is a 200 no-op reporting
 * `alreadyPresent: true`), but the hub rejects a rule it considers invalid — a
 * capability rerouted to itself, a malformed name — with a 400 whose `message` is
 * surfaced verbatim, exit 1. `rule rm` answers a tolerant 200 `removed: false`
 * when there was no such rule, which is exit 0 plus a stderr line. None of the
 * hub's name rules are re-implemented here: the hub is the enforcement of record,
 * the same stance the capability family takes.
 *
 * `routing show` on a workflow id this org does not own does NOT come back with a
 * descriptive message: the hub verb throws an untyped error that its edge maps to
 * HTTP 500 `{"error":"internal_error","message":"internal server error"}`, and
 * that generic message is what this command prints (exit 1) — the same thing
 * `instance show` does with the same hub behavior. The ladder below surfaces
 * whatever `message` the hub sends, so a future typed 404 needs no change here.
 *
 * Exit codes: 0 ok — including `rule rm`'s tolerant `removed: false`; 1
 * runtime/hub error (a 400 on `rule add`, a 403 for a non-admin on `rule
 * add`/`rule rm`, an unknown workflow on `show`, a malformed 2xx, a network
 * timeout); 2 the hub is unresolvable; 3 the human credential is absent or
 * irrecoverable (the error names `owenloop login --hub <origin>`).
 */
async function dispatchRouting(io: CliIO, args: Args): Promise<number> {
  const USAGE_FORMS =
    'usage: owenloop routing alerts [--workflow <wf>] [--limit <n>] [--hub <url>]' +
    ' | owenloop routing show <workflow> [--hub <url>]' +
    ' | owenloop routing rule list [--hub <url>]' +
    ' | owenloop routing rule add <capability> <target> [--position <n>] [--hub <url>]' +
    ' | owenloop routing rule rm <capability> <target> [--hub <url>]';

  // --- validation: everything below runs BEFORE any I/O, so a usage error on a
  //     multi-hub machine reports the usage problem (exit 1), not exit 2.
  const sub = args.positionals[1];
  if (sub !== 'alerts' && sub !== 'show' && sub !== 'rule') {
    throw new CliError(`unknown routing subcommand '${sub ?? ''}' — ${USAGE_FORMS}`);
  }

  let workflow = ''; // `show` only
  let ruleSub: 'list' | 'add' | 'rm' | '' = ''; // `rule` only
  let capability = ''; // `rule add` / `rule rm`
  let target = ''; // `rule add` / `rule rm`
  let workflowFilter: string | undefined; // `alerts` only
  let limit: number | undefined; // `alerts` only
  let position: number | undefined; // `rule add` only

  if (sub === 'show') {
    const rawWorkflow = args.positionals[2];
    if (rawWorkflow === undefined || rawWorkflow === '') {
      throw new CliError(`missing required argument: <workflow> (${USAGE_FORMS})`);
    }
    workflow = rawWorkflow;
  } else if (sub === 'alerts') {
    // `--workflow` with no value, or with an empty one, is a usage error rather
    // than a silent org-wide listing. The hub treats `workflow=` as absent, so
    // accepting an empty value would print `"workflow": ""` over an UNSCOPED
    // result set — stdout claiming a filter that was never applied. OMITTING the
    // flag entirely is the org-wide listing; that difference is preserved.
    // (`dispatchStart`'s `requiredTextOption` makes the same distinction.)
    if (args.missingOptionValues.has('workflow')) {
      throw new CliError('missing value for --workflow: expected --workflow <wf>');
    }
    const rawFilter = last(args, 'workflow');
    if (rawFilter !== undefined && rawFilter.trim() === '') {
      throw new CliError('invalid empty value for --workflow: expected --workflow <wf>');
    }
    workflowFilter = rawFilter;
    // `numOpt` throws a CliError on a non-numeric value — including a bare
    // `--limit`, which the parser records as the string 'true'. This is flag
    // hygiene, not a copy of hub semantics: the hub silently DROPS a
    // non-positive-integer `limit` and applies its own default, which would
    // report a page size the operator never asked for.
    limit = numOpt(args, 'limit');
  } else {
    // Two-level subcommand, the `crew member add|rm` shape.
    const rawRuleSub = args.positionals[2];
    if (rawRuleSub !== 'list' && rawRuleSub !== 'add' && rawRuleSub !== 'rm') {
      throw new CliError(`unknown routing rule subcommand '${rawRuleSub ?? ''}' — ${USAGE_FORMS}`);
    }
    ruleSub = rawRuleSub;
    if (ruleSub === 'add' || ruleSub === 'rm') {
      // Both are required for BOTH verbs: one call writes or clears exactly ONE
      // `(capability, target)` rule, and a capability-only `rm` would drop every
      // substitution the operator ever wrote for that source.
      const rawCapability = args.positionals[3];
      if (rawCapability === undefined || rawCapability === '') {
        throw new CliError(`missing required argument: <capability> (${USAGE_FORMS})`);
      }
      capability = rawCapability;
      const rawTarget = args.positionals[4];
      if (rawTarget === undefined || rawTarget === '') {
        throw new CliError(`missing required argument: <target> (${USAGE_FORMS})`);
      }
      target = rawTarget;
      // Omitting `--position` APPENDS the rule; a non-numeric value is a
      // client-side CliError for the same reason `--limit` is.
      if (ruleSub === 'add') position = numOpt(args, 'position');
    }
    // No client-side charset validation of `capability` or `target` — the hub is
    // the enforcement of record, the same stance `capability bind` takes.
  }

  const origin = resolveAgentHub(io, args, 'manage routing on');
  const slot: CredentialSlotSelector = { principal: 'human' };

  // The human bearer for the resolved origin. Absent → exit 3 with the same
  // remedy wording `capability` uses.
  const cred = readCredential(io, origin, slot);
  if (cred === null) {
    throw new CliError(`no human credential for ${origin} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
  }

  try {
    /**
     * The ONE GET ladder all three reads share, so they can never drift apart in
     * what they accept. It is `dispatchInstance`'s ladder — a 401 through
     * `assertAuthOk`, then the hub's typed `message` surfaced VERBATIM for any
     * other non-2xx — deliberately NOT `capability list`'s bare `assertAuthOk`,
     * whose own comment freezes that generic wording to that command. `prefix` is
     * the endpoint-qualified lead-in the narrower for this endpoint also uses, so
     * a non-JSON body reports a FIXED string rather than V8's `SyntaxError`,
     * which embeds a verbatim snippet of the raw body.
     */
    const readJson = async (path: string, prefix: string): Promise<unknown> => {
      const { res, cred: used } = await authedGet(io, origin, slot, cred, path);
      if (res.status === 401) assertAuthOk(res, used, origin);
      if (!res.ok) {
        const message = await hubRequestMessage(res);
        throw new CliError(message ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
      }
      try {
        return (await res.json()) as unknown;
      } catch {
        throw new CliError(`${prefix} — body is not valid JSON`);
      }
    };

    if (sub === 'alerts') {
      // Both query params are optional and are sent ONLY when the operator asked
      // for them, so the default request carries no `?` at all and the hub
      // applies its own page size.
      const qs = new URLSearchParams();
      if (workflowFilter !== undefined) qs.set('workflow', workflowFilter);
      if (limit !== undefined) qs.set('limit', String(limit));
      const query = qs.toString();
      const body = await readJson(
        `/api/routing_alerts${query === '' ? '' : `?${query}`}`,
        'routing_alerts: malformed response',
      );
      let alerts;
      try {
        alerts = asRoutingAlerts(body);
      } catch (e) {
        throw new CliError((e as Error).message);
      }
      // The guard's output — a whitelisted typed array — never the raw body, and
      // in RECEIVED order (see the ordering paragraph above). The `workflow` key
      // is echoed back only when a filter was applied, so a script can tell an
      // oldest-first timeline from a newest-first inbox without re-reading argv.
      print(io, {
        ok: true,
        hub: origin,
        ...(workflowFilter === undefined ? {} : { workflow: workflowFilter }),
        alerts,
      });
      return 0;
    }

    if (sub === 'show') {
      // The workflow id is a path segment, so it must be encoded — an id carrying
      // a slash would otherwise silently address a different route
      // (`dispatchInstance`'s precedent).
      const body = await readJson(
        `/api/run_routing/${encodeURIComponent(workflow)}`,
        'run_routing: malformed success response',
      );
      let wire;
      try {
        wire = asRunRouting(body);
      } catch (e) {
        throw new CliError((e as Error).message);
      }
      print(io, {
        ok: true,
        hub: origin,
        // The SERVER-echoed id, not argv — the `capability bind` precedent.
        workflow: wire.workflow,
        defName: wire.defName,
        // OMITTED, never `null` or `''`: the absence of this key is how stdout
        // says "this run was started without a modifier". An empty string would
        // read as "a modifier named nothing", which is not a state that exists.
        ...(wire.modifier === undefined ? {} : { modifier: wire.modifier }),
        waitPolicy: wire.waitPolicy,
        alerts: wire.alerts,
        resolutionReports: wire.resolutionReports,
        escalations: wire.escalations,
      });
      return 0;
    }

    if (ruleSub === 'list') {
      const body = await readJson('/api/capability_reroutes', 'capability_reroutes: malformed response');
      let reroutes;
      try {
        reroutes = asCapabilityReroutes(body);
      } catch (e) {
        throw new CliError((e as Error).message);
      }
      // Printed in the hub's own try-order and never re-sorted: the array order
      // IS which substitution the hub attempts first. Each row also carries its
      // `position`, so a reader can check that ordering for themselves.
      print(io, { ok: true, hub: origin, reroutes });
      return 0;
    }

    // `rule add` and `rule rm` share one POST ladder. The bodies differ by exactly
    // one optional field — `position`, add-only — because each call writes or
    // clears exactly one `(capability, target)` rule. Only the path, the guard,
    // and the printed shape differ.
    const endpoint = ruleSub === 'add' ? 'add_capability_reroute' : 'remove_capability_reroute';
    // The `position` KEY is omitted entirely when the flag is absent — that is
    // what tells the hub to APPEND. Sending `null` or `0` would each mean
    // something else.
    const payload =
      ruleSub === 'add' && position !== undefined ? { capability, target, position } : { capability, target };
    const { res } = await authedPost(io, origin, slot, cred, `/api/${endpoint}`, payload);

    if (res.status === 401) {
      // A 401 that survived `authedPost`'s one refresh-and-retry. The human slot
      // never holds an agent kind, so `assertAuthOk`'s non-agent wording applies;
      // the catch below upgrades this to exit 3.
      throw new CliError('credential rejected by the hub — run `owenloop login`');
    }
    if (!res.ok) {
      // Surface the hub's typed `message` VERBATIM — this is how a rule the hub
      // refuses (400 `capability_reroute_invalid`) and a non-admin 403 both
      // surface uniformly. `hubRequestMessage` reads only the typed `message`
      // field, so raw body text is never included.
      const message = await hubRequestMessage(res);
      throw new CliError(message ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
    }

    let body: unknown;
    try {
      body = (await res.json()) as unknown;
    } catch {
      // A FIXED string — never V8's SyntaxError message, which embeds a verbatim
      // snippet of the raw body.
      throw new CliError(`${endpoint}: malformed success response — body is not valid JSON`);
    }

    if (ruleSub === 'add') {
      let added;
      try {
        added = asCapabilityRerouteAdded(body);
      } catch (e) {
        throw new CliError((e as Error).message);
      }
      // SERVER-echoed capability/target/position, not argv. `position` especially:
      // omitting `--position` appends, so the rank printed here is usually one the
      // operator never typed. `alreadyPresent` and `ruleCount` carry the HUB's own
      // field names verbatim, so an operator correlating stdout against the hub's
      // audit log never has to translate. `createdAt` is validated but not printed
      // — `routing rule list` is where a row's provenance belongs (the
      // `capability bind` precedent).
      print(io, {
        ok: true,
        hub: origin,
        capability: added.reroute.capability,
        target: added.reroute.target,
        position: added.reroute.position,
        alreadyPresent: added.alreadyPresent,
        ruleCount: added.ruleCount,
      });
      // No stderr line on `add`: the write is idempotent per pair, so
      // `alreadyPresent: true` is a normal no-op, and an add never removes a rule
      // or parks a capability. There is no consequence to warn about.
      return 0;
    }

    // `rule rm`: the guard proves the 2xx really was the remove verb's answer.
    // `removedWire` (not `removed`) so `removedWire.removed` reads unambiguously —
    // the naming `dispatchCapability` and `dispatchCrew` already use.
    let removedWire;
    try {
      removedWire = asCapabilityRerouteRemoved(body);
    } catch (e) {
      throw new CliError((e as Error).message);
    }
    print(io, {
      ok: true,
      hub: origin,
      capability: removedWire.capability,
      target: removedWire.target,
      removed: removedWire.removed,
      remainingTargets: removedWire.remainingTargets,
    });
    // stderr only, so `| jq` on stdout is unaffected — mirroring `capability
    // unbind`, which narrates its tolerant-false case and its notable side effect
    // the same way.
    if (!removedWire.removed) {
      io.err(`${removedWire.capability} had no reroute to '${removedWire.target}' — nothing was removed`);
    } else if (removedWire.remainingTargets.length === 0) {
      io.err(
        `${removedWire.capability}: no reroute rules remain — it now HOLDS whenever it has no live crew binding`,
      );
    }
    return 0;
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
}

/**
 * `owenloop crew list|new|rm|member add|member rm` — administer hub crews.
 * Modeled directly on `dispatchCapability`: same validate-before-I/O discipline,
 * same helpers (`resolveAgentHub`, `readCredential`, `authedGet`/`authedPost`,
 * `assertAuthOk`), same error-wording shapes, same exit-code ladder.
 *
 * | subcommand         | endpoint                      |
 * |--------------------|-------------------------------|
 * | `crew list`        | `GET /api/crews`              |
 * | `crew new`         | `POST /api/create_crew`       |
 * | `crew rm`          | `POST /api/delete_crew`       |
 * | `crew member add`  | `POST /api/add_crew_member`   |
 * | `crew member rm`   | `POST /api/remove_crew_member`|
 *
 * All five use the **human** credential slot — `manage_crews` is absent from
 * the hub's agent scope table, so an agent token is refused on every one of
 * these routes regardless of scope; the CLI does not carry an agent-token path
 * for this family, unlike `binding`'s sibling commands.
 *
 * **The tolerant / absent-field semantics — the heart of this command.**
 * `delete_crew` on an unknown crew id, and `remove_crew_member` on a principal
 * that was never a member, are both ordinary 200 successes (`deleted: false` /
 * `removed: false`), never 404s — printed and echoed to stderr honestly rather
 * than invented as an error. `delete_crew`'s optional transfer fields
 * (`membersRemoved`, `orphanCrewId`, `orphanCrewName`, `stampsTransferred`,
 * `runsTransferred`, `runningRunsTransferred`) are on stdout IF AND ONLY IF the
 * wire carried them — never defaulted to `0`/`null`/`[]`, because their
 * absence is the hub's way of saying nothing moved. When a transfer did
 * happen, `crew rm` also writes a human-facing stderr summary naming the
 * orphan crew, because an operator who never sees that line will not go
 * looking for their moved work.
 *
 * Agrees with `capability unbind`: `crew rm` and `crew member rm` print their tolerant
 * booleans (`deleted`, `removed`) on stdout and narrate the tolerant-false case
 * on stderr — the same shape `capability unbind` uses for its own `removed` and
 * `remainingCrewIds`. One vocabulary across both families.
 *
 * Exit codes: 0 ok; 1 usage error, hub refusal (400/403), or malformed
 * response; 2 the hub is unresolvable; 3 the human credential is absent or
 * irrecoverable (remedy names `owenloop login --hub <origin>`).
 */
async function dispatchCrew(io: CliIO, args: Args): Promise<number> {
  const USAGE_FORMS =
    'usage: owenloop crew list [--hub <url>] | ' +
    'owenloop crew new <name> --kind personal|shared [--owner <memberId>] [--hub <url>] | ' +
    'owenloop crew rm <crewId> [--hub <url>] | ' +
    'owenloop crew member add <crewId> <principalKind> <principalId> [--hub <url>] | ' +
    'owenloop crew member rm <crewId> <principalId> [--hub <url>]';

  // --- validation: everything below runs BEFORE any I/O, so a usage error on a
  //     multi-hub machine reports the usage problem (exit 1), not exit 2.
  const sub = args.positionals[1];
  if (sub !== 'list' && sub !== 'new' && sub !== 'rm' && sub !== 'member') {
    throw new CliError(`unknown crew subcommand '${sub ?? ''}' — ${USAGE_FORMS}`);
  }

  let memberSub: 'add' | 'rm' | undefined;
  let name = '';
  let crewId = '';
  let principalKind = '';
  let principalId = '';
  let kind = '';
  let owner: string | undefined;

  if (sub === 'new') {
    const raw = args.positionals[2];
    if (raw === undefined || raw === '') {
      throw new CliError(`missing required argument: <name> (${USAGE_FORMS})`);
    }
    name = raw;
    const rawKind = last(args, 'kind');
    if (rawKind === undefined || rawKind === '') {
      throw new CliError(`missing required option: --kind personal|shared (${USAGE_FORMS})`);
    }
    kind = rawKind;
    const rawOwner = last(args, 'owner');
    if (rawOwner !== undefined) {
      if (rawOwner === '') {
        throw new CliError(`--owner requires a member id (${USAGE_FORMS})`);
      }
      owner = rawOwner;
    }
  } else if (sub === 'rm') {
    const raw = args.positionals[2];
    if (raw === undefined || raw === '') {
      throw new CliError(`missing required argument: <crewId> (${USAGE_FORMS})`);
    }
    crewId = raw;
  } else if (sub === 'member') {
    const msub = args.positionals[2];
    if (msub !== 'add' && msub !== 'rm') {
      throw new CliError(`unknown crew member subcommand '${msub ?? ''}' — ${USAGE_FORMS}`);
    }
    memberSub = msub;
    const rawCrewId = args.positionals[3];
    if (rawCrewId === undefined || rawCrewId === '') {
      throw new CliError(`missing required argument: <crewId> (${USAGE_FORMS})`);
    }
    crewId = rawCrewId;
    if (memberSub === 'add') {
      const rawKind = args.positionals[4];
      if (rawKind === undefined || rawKind === '') {
        throw new CliError(`missing required argument: <principalKind> (${USAGE_FORMS})`);
      }
      principalKind = rawKind;
      const rawId = args.positionals[5];
      if (rawId === undefined || rawId === '') {
        throw new CliError(`missing required argument: <principalId> (${USAGE_FORMS})`);
      }
      principalId = rawId;
    } else {
      const rawId = args.positionals[4];
      if (rawId === undefined || rawId === '') {
        throw new CliError(`missing required argument: <principalId> (${USAGE_FORMS})`);
      }
      principalId = rawId;
    }
  }

  const origin = resolveAgentHub(io, args, 'manage crews on');
  const slot: CredentialSlotSelector = { principal: 'human' };

  // The human bearer for the resolved origin. Absent → exit 3 with the same
  // remedy wording `binding`/`agent new` use.
  const cred = readCredential(io, origin, slot);
  if (cred === null) {
    throw new CliError(`no human credential for ${origin} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
  }

  try {
    if (sub === 'list') {
      const { res, cred: used } = await authedGet(io, origin, slot, cred, '/api/crews');
      // `assertAuthOk`'s generic wording (frozen contract, mirrors `binding
      // list`); message passthrough is a POST-path behavior below.
      assertAuthOk(res, used, origin);
      let body: unknown;
      try {
        body = (await res.json()) as unknown;
      } catch {
        throw new CliError('crews: malformed response — body is not valid JSON');
      }
      let crews;
      try {
        crews = asCrews(body);
      } catch (e) {
        throw new CliError((e as Error).message);
      }
      print(io, { ok: true, hub: origin, crews });
      return 0;
    }

    // `new`, `rm`, `member add`, and `member rm` share one POST ladder; only the
    // path, the request body, the guard, and the printed shape differ.
    let endpoint: string;
    let reqBody: Record<string, unknown>;
    if (sub === 'new') {
      endpoint = 'create_crew';
      reqBody = { name, kind, ...(owner !== undefined ? { ownerMemberId: owner } : {}) };
    } else if (sub === 'rm') {
      endpoint = 'delete_crew';
      reqBody = { crewId };
    } else if (memberSub === 'add') {
      endpoint = 'add_crew_member';
      reqBody = { crewId, principalKind, principalId };
    } else {
      endpoint = 'remove_crew_member';
      reqBody = { crewId, principalId };
    }

    const { res } = await authedPost(io, origin, slot, cred, `/api/${endpoint}`, reqBody);

    if (res.status === 401) {
      // A 401 that survived `authedPost`'s one refresh-and-retry. The human slot
      // never holds an agent kind, so this generic wording applies; the catch
      // below upgrades this to exit 3.
      throw new CliError('credential rejected by the hub — run `owenloop login`');
    }
    if (!res.ok) {
      // Surface the hub's typed `message` VERBATIM (an unknown crew id on
      // member add/rm, a non-admin 403, an active-workflow delete refusal, an
      // unvalidated --kind value all surface uniformly). Never include raw
      // body text.
      let message: string | undefined;
      try {
        const errBody = (await res.json()) as unknown;
        if (typeof errBody === 'object' && errBody !== null) {
          const m = (errBody as Record<string, unknown>).message;
          if (typeof m === 'string' && m !== '') message = m;
        }
      } catch {
        // Non-JSON body — fall through to the generic status message.
      }
      throw new CliError(message ?? `hub ${origin} rejected the request (HTTP ${res.status})`);
    }

    let body: unknown;
    try {
      body = (await res.json()) as unknown;
    } catch {
      // A FIXED string — never V8's SyntaxError message, which embeds a
      // verbatim snippet of the raw body.
      throw new CliError(`${endpoint}: malformed success response — body is not valid JSON`);
    }

    if (sub === 'new') {
      let created;
      try {
        created = asCrewCreated(body);
      } catch (e) {
        throw new CliError((e as Error).message);
      }
      print(io, {
        ok: true,
        hub: origin,
        crewId: created.id,
        name: created.name,
        kind: created.kind,
        ownerMemberId: created.ownerMemberId,
      });
      return 0;
    }

    if (sub === 'rm') {
      let deletedWire;
      try {
        deletedWire = asCrewDeleted(body);
      } catch (e) {
        throw new CliError((e as Error).message);
      }
      // `deleted` (and every transfer field the wire carried) is printed, never
      // hidden — the same tolerant-boolean shape `capability unbind` prints. See the
      // function doc-comment.
      print(io, { ok: true, hub: origin, ...deletedWire });
      if (!deletedWire.deleted) {
        io.err(`no crew '${deletedWire.crewId}' to delete — nothing was removed`);
      } else if (deletedWire.orphanCrewName !== undefined) {
        const runs = deletedWire.runsTransferred?.length ?? 0;
        const stamps = deletedWire.stampsTransferred ?? 0;
        const running = deletedWire.runningRunsTransferred;
        const runningClause = running !== undefined && running.length > 0 ? ` (${running.length} still running)` : '';
        io.err(
          `crew '${deletedWire.crewId}' deleted — ${stamps} stamp(s) from ${runs} run(s)${runningClause} moved to '${deletedWire.orphanCrewName}' (${deletedWire.orphanCrewId})`,
        );
      }
      return 0;
    }

    if (memberSub === 'add') {
      let added;
      try {
        added = asCrewMemberAdded(body);
      } catch (e) {
        throw new CliError((e as Error).message);
      }
      // The argv crewId, not a wire value: `CrewMemberWire` deliberately does
      // not narrow a `crewId` field (it is reused for `crews[].members[]`,
      // where a per-member crewId would be redundant), so the request's own
      // crewId is the only one available to print.
      print(io, { ok: true, hub: origin, crewId, principalKind: added.principalKind, principalId: added.principalId });
      return 0;
    }

    // `member rm`
    let removedWire;
    try {
      removedWire = asCrewMemberRemoved(body);
    } catch (e) {
      throw new CliError((e as Error).message);
    }
    print(io, {
      ok: true,
      hub: origin,
      crewId: removedWire.crewId,
      principalId: removedWire.principalId,
      removed: removedWire.removed,
    });
    if (!removedWire.removed) {
      io.err(`${removedWire.principalId} was not a member of crew '${removedWire.crewId}' — nothing was removed`);
    }
    return 0;
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
}

// ---- setup & doctor ---------------------------------------------------------
//
// `owenloop setup` is the idempotent converger for a machine's install (identity
// model doc §7 Flow A/B): human login → agent credential → owenloop settings →
// Claude Code/Codex plugins → a final doctor pass. `owenloop doctor` (§8) is the
// read-only probe of the same core surfaces plus both harness plugin states. Both
// share `resolveSetupHub` (one target) and the agent-slot probe.
//
// Secrets discipline (§6 "rule of gates"): NO code path here passes a token to
// `io.out`/`io.err`/an Error. The only token hops live inside
// `mintAgentCredential`/`rekeyAgentCredential` (caller→store). The succession
// prompt renders name/last-active/crews; doctor renders identity/crews; the
// owenloop settings file receives `hubOrigin` only.

/** One step's outcome in the setup summary. `noted` = informational, never a failure. */
interface SetupStep {
  step: string;
  action: 'skipped' | 'done' | 'noted';
  detail: string;
}

export interface CrewRosterInstallOptions {
  /** Test seam for a temporary-name collision before target installation. */
  tempName?: () => string;
  /** Test seam for a short/failed temporary write after the file was created. */
  writeTemp?: (path: string, contents: string) => void;
}

/** Probe before any mkdir or temporary write. An existing operator file is a
 * successful no-op; every other existing filesystem object remains an error. */
function hasExistingCrewRosterTarget(path: string): boolean {
  try {
    const target = lstatSync(path);
    if (!target.isFile()) throw new Error(`crew roster target exists but is not a regular file: ${path}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Install a fully-written strongest-layer roster without replacing an
 * operator's file. Only EEXIST from the final exclusive link is interpreted
 * as an existing target; failures creating its parent or temporary file stay
 * failures instead of being misreported as a harmless skip.
 */
export function installCrewRosterIfAbsent(
  path: string,
  contents: string,
  options: CrewRosterInstallOptions = {},
): 'created' | 'existing' {
  // This is deliberately before mkdir/temp creation: a setup rerun must be a
  // zero-write no-op even in a read-only or full directory.
  if (hasExistingCrewRosterTarget(path)) return 'existing';
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, options.tempName?.() ?? `.${randomUUID()}.roster.tmp`);
  let tempWritten = false;
  try {
    try {
      (options.writeTemp ?? ((candidate, body) => writeFileSync(candidate, body, { encoding: 'utf8', flag: 'wx' })))(temp, contents);
      tempWritten = true;
    } catch (error) {
      // `writeFileSync` can throw after creating a partial file (ENOSPC,
      // interruption). EEXIST is the one exception: that temp was never ours
      // and must not be removed. Every other failed write gets its partial
      // cleanup before the error reaches setup.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
	try {
	  unlinkSync(temp);
	} catch {
	  // Nothing was created, or cleanup has no recovery path.
	}
      }
      throw error;
    }
    try {
      linkSync(temp, path);
      return 'created';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // EEXIST is meaningful only for the target installation. Verify that it
      // is a real roster file before calling it an intentional operator file.
      if (!hasExistingCrewRosterTarget(path)) throw error;
      return 'existing';
    }
  } finally {
    if (tempWritten) {
      try { unlinkSync(temp); } catch { /* target installation already decided; cleanup is best-effort */ }
    }
  }
}

/** One doctor check line: a ✓/✗ label + a distinct detail/remedy. */
interface DoctorCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/** The doctor report: the ordered checks and whether the five CORE checks (excluding plugins) all passed. */
interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

/** A locally-stored agent slot that verified live against the hub. */
interface VerifiedAgent {
  name: string;
  actorId: string;
  /** The matching identity from the `agent_identities` listing, when one could be resolved (id first, else name). */
  identity: AgentIdentitySummary | undefined;
}

/**
 * The plugin checks are rendered but NON-FATAL: a developer may use either
 * Claude Code or Codex, and a missing harness or failed plugin convergence must
 * not make the core setup/doctor result fail. The setup ACT reports each issue as
 * `noted` and continues with the other harness.
 */
const PLUGIN_CHECK_FATAL = false;

/**
 * Resolve the hub `setup`/`doctor` target. Deviates from `resolveAgentHub` in
 * exactly ONE way (documented in the plan §4): a fresh machine — which is the
 * Flow A mainline — has NO stored hub, so instead of `resolveAgentHub`'s exit-2
 * it falls back to the production `DEFAULT_HUB` with a printed notice. The
 * wrong-hub-mint risk `resolveAgentHub` guards against does not apply: the mint
 * happens only AFTER the human logs in through this hub's own browser consent,
 * and the target line is printed first.
 *
 * - `--hub <origin>` → `normalizeOrigin`.
 * - else `listStoredHubOrigins`: exactly one → use it; more than one → `CliError`
 *   exitCode 2 listing them; zero or `null` (keychain/external cannot enumerate)
 *   → `DEFAULT_HUB` + notice.
 *
 * `OWENLOOP_HUB` stays excluded (O2/O3 parity). Shared by both commands so they
 * agree on the target.
 */
function resolveSetupHub(io: CliIO, args: Args): string {
  const flagVal = last(args, 'hub');
  if (flagVal !== undefined) {
    try {
      return normalizeOrigin(flagVal);
    } catch (e) {
      throw new CliError((e as Error).message);
    }
  }
  const discovered = discoverStoredHubs(io);
  if (discovered.kind === 'one') return discovered.origin;
  if (discovered.kind === 'multiple') {
    throw new CliError(
      `more than one hub is configured on this machine — pass --hub <origin> to pick one; stored hubs: ${discovered.origins.join(', ')}`,
      { exitCode: 2 },
    );
  }
  io.err(`targeting ${DEFAULT_HUB} (pass --hub to override)`);
  return DEFAULT_HUB;
}

/**
 * Is `cmd` an executable file on `env.PATH`? A pure PATH scan (no exec), so it is
 * hermetic-testable by pointing `PATH` at a fixture dir with a chmod +x stub.
 * A directory entry, a non-executable file, or an unreadable dir is skipped.
 */
function commandOnPath(env: Record<string, string | undefined>, cmd: string): boolean {
  const path = env.PATH;
  if (!path) return false;
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    const full = join(dir, cmd);
    try {
      const st = statSync(full);
      if (st.isFile() && (st.mode & 0o111) !== 0) return true;
    } catch {
      // not here — keep scanning
    }
  }
  return false;
}

/**
 * Coerce a raw string (a hostname) into a valid agent account name, or `''` when
 * nothing usable survives. Lowercase; drop every character outside the account
 * body class `[a-z0-9._-]`; strip leading non-alphanumerics (the account MUST
 * start alphanumeric); clamp to 64 chars. A suggestion only — never parsed or
 * matched (§2); the user may accept it or type any valid label.
 */
export function sanitizeAgentName(raw: string): string {
  let s = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  s = s.replace(/^[^a-z0-9]+/, '');
  if (s.length > 64) s = s.slice(0, 64);
  return s;
}

/**
 * The identity's last-active instant in epoch-ms: `max` of its two non-null
 * timestamps (`lastUsedAt`, the rekey-surviving token-level max; `lastContactAt`,
 * the identity-level any-protocol contact), or `null` when both are absent. Both
 * recording paths are monotone, so `max` is the correct "most recent activity".
 */
export function lastActiveMs(identity: AgentIdentitySummary): number | null {
  const c = identity.lastContactAt;
  const u = identity.lastUsedAt;
  if (c === null) return u;
  if (u === null) return c;
  return Math.max(c, u);
}

/**
 * Render an elapsed-time delta (ms) as a short relative string: `just now`,
 * `<n>m ago`, `<n>h ago`, `<n>d ago`. A `null` delta (no recorded activity)
 * renders `never`. Negative deltas (clock skew) clamp to `just now`.
 */
export function formatLastActive(deltaMs: number | null): string {
  if (deltaMs === null) return 'never';
  const ms = Math.max(0, deltaMs);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * File-backend agent account names stored for `origin`, or `null` when the
 * backend cannot enumerate (keychain/external) — mirrors `listStoredHubOrigins`'
 * backend-awareness. The keychain interface is get/set/delete only, so the real
 * agent probe on a keychain machine is the identity-name-keyed reads in step 3.
 */
function enumerateAgentAccounts(io: CliIO, origin: string): string[] | null {
  if (credentialBackend(io.env, io.keychain).kind !== 'file') return null;
  const file = readCredentialFile(credentialFilePath(io.env));
  return Object.keys(file.hubs[origin] ?? {})
    .filter((k) => k.startsWith('agent:'))
    .map((k) => k.slice('agent:'.length));
}

/**
 * Probe local agent slots (`names`) for one that verifies live against the hub's
 * `whoami`. Reads each `agent:<name>` slot; a hit is verified with `authedGet`
 * (ensureFreshOAuth no-ops on the `agent` kind; a 401 = revoked → `sawRevoked`).
 * Prefers a slot whose `whoami actor.id` matches a listed identity id; falls back
 * to the first otherwise-verified slot (id/name mismatch is tolerated, never a
 * hard fail — see plan §5). Never a write.
 */
async function probeAgentSlots(
  io: CliIO,
  origin: string,
  names: string[],
  identities: AgentIdentitySummary[],
): Promise<{ verified: VerifiedAgent | null; sawSlot: boolean; sawRevoked: boolean }> {
  let verified: VerifiedAgent | null = null;
  let sawSlot = false;
  let sawRevoked = false;
  for (const name of names) {
    const cred = readCredential(io, origin, { principal: 'agent', account: name });
    if (cred === null) continue;
    sawSlot = true;
    let res: Response;
    try {
      ({ res } = await authedGet(io, origin, { principal: 'agent', account: name }, cred, '/api/whoami'));
    } catch {
      continue;
    }
    if (res.status === 401) {
      sawRevoked = true;
      continue;
    }
    if (!res.ok) continue;
    let actorId = '';
    try {
      actorId = asWhoami(await res.json()).actor.id;
    } catch {
      continue;
    }
    const byId = identities.find((i) => i.id === actorId);
    const byName = identities.find((i) => i.name === name);
    const va: VerifiedAgent = { name, actorId, identity: byId ?? byName };
    if (byId) return { verified: va, sawSlot, sawRevoked };
    if (verified === null) verified = va;
  }
  return { verified, sawSlot, sawRevoked };
}

/**
 * The interactive prompt for a verb that must ask, or the non-interactive
 * guard. Returns `io.prompt` when injected; else, when stdin is a real TTY, the
 * default readline prompt; else a `CliError` naming that verb's bypass flags —
 * thrown BEFORE any mutation (and, for `install`, before any hub I/O at all) so
 * a scripted/piped run never blocks and never half-applies.
 *
 * `unavailable` is the refusal wording. It defaults to `setup`'s, so `setup`'s
 * callers keep their message byte-for-byte; `install` passes its own, which
 * must name `--map` and `--accept-defaults`.
 */
function requirePrompt(io: CliIO, unavailable?: string): (question: string) => Promise<string> {
  if (io.prompt) return io.prompt;
  if (process.stdin.isTTY) return defaultPrompt;
  throw new CliError(
    unavailable ??
      'setup needs to ask which Scoped Identity to use, but stdin is not interactive — pass ' +
        '--new-agent <name> to create a new Scoped Identity, or --replace-agent <name> to replace an existing one',
  );
}

/**
 * Prompt for an agent name (Flow A). Offers `sanitizeAgentName(hostname())` as a
 * prefill an empty answer accepts; an invalid answer re-prompts once, then a
 * `CliError`. The name is a SUGGESTION only — any valid label is accepted.
 */
async function promptAgentName(io: CliIO): Promise<string> {
  const prompt = requirePrompt(io);
  const prefill = sanitizeAgentName(hostname());
  const question = prefill ? `Name this Scoped Identity [${prefill}]: ` : 'Name this Scoped Identity: ';
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = (await prompt(question)).trim();
    const answer = raw === '' ? prefill : raw;
    if (answer === '') {
      io.err('an agent name is required');
      continue;
    }
    try {
      credentialSlot({ principal: 'agent', account: answer });
      return answer;
    } catch {
      io.err(`invalid agent name '${answer}' — expected 1-64 chars matching [A-Za-z0-9][A-Za-z0-9._-]*`);
    }
  }
  throw new CliError('no valid agent name provided');
}

/**
 * Render the succession question (Flow B) and read a choice. The framing
 * sentences are adapted from the model doc (§7 Flow B), restated in the settled
 * vocabulary; the radio glyphs become numbered
 * terminal choices (the honest line-input adaptation). `[1]` = new installation;
 * `[k]` = replace the (k-2)th non-disabled identity. Each Replace line shows the
 * name, `last active <relative>`, and crews. Invalid input re-prompts once, then
 * a `CliError`.
 */
async function promptSuccession(
  io: CliIO,
  identities: AgentIdentitySummary[],
): Promise<{ kind: 'new' } | { kind: 'replace'; identity: AgentIdentitySummary }> {
  const prompt = requirePrompt(io);
  const candidates = identities.filter((i) => !i.disabled);
  const now = nowMs();
  const lines: string[] = [
    'Is this a new installation, or does it replace an existing one?',
    '',
    '  [1] New installation → create a new Scoped Identity',
  ];
  candidates.forEach((id, i) => {
    const active = lastActiveMs(id);
    const rel = formatLastActive(active === null ? null : now - active);
    const crews = id.crews.length ? id.crews.join(', ') : '(none)';
    lines.push(`  [${i + 2}] Replace: ${id.name}  last active ${rel} · crews: ${crews}`);
  });
  lines.push('');
  lines.push('⚠ "Replace" revokes that Scoped Identity\'s current credential. If it is still');
  lines.push('  running somewhere, it will be disconnected there.');
  lines.push('');
  const max = candidates.length + 1;
  const question = `${lines.join('\n')}\nChoose [1-${max}]: `;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = (await prompt(attempt === 0 ? question : `Choose [1-${max}]: `)).trim();
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= max) {
      if (n === 1) return { kind: 'new' };
      return { kind: 'replace', identity: candidates[n - 2]! };
    }
    io.err(`please enter a number between 1 and ${max}`);
  }
  throw new CliError('no valid choice provided');
}

export interface HarnessPluginState {
  id: HarnessId;
  cliName: 'claude' | 'codex';
  cliFound: boolean;
  installed: boolean;
  installedVersion: string | null;
  cliVersion: string | null;
}

interface HarnessConfig {
  id: HarnessId;
  cliName: HarnessPluginState['cliName'];
  displayName: string;
  marketplaceDir: string;
  marketplaceManifest: string;
}

const HARNESS_CONFIGS: Record<HarnessId, HarnessConfig> = {
  'claude-code': {
    id: 'claude-code',
    cliName: 'claude',
    displayName: 'Claude Code',
    marketplaceDir: 'claude-code',
    marketplaceManifest: '.claude-plugin/marketplace.json',
  },
  codex: {
    id: 'codex',
    cliName: 'codex',
    displayName: 'Codex',
    marketplaceDir: 'codex',
    marketplaceManifest: '.agents/plugins/marketplace.json',
  },
};

const HARNESS_IDS: readonly HarnessId[] = ['claude-code', 'codex'];
const PLUGIN_SELECTOR = 'owenloop@owenloop';

/**
 * Resolve a bundled marketplace root from either the source tree (`src/cli.ts`)
 * or the shipped tree (`dist/src/cli.js`). The manifest check prevents a partial
 * package from producing a path that the harness cannot consume.
 */
export function resolveBundledMarketplaceRoot(harness: HarnessId): string | null {
  const config = HARNESS_CONFIGS[harness];
  try {
    const candidates = [
      new URL(`../plugins/${config.marketplaceDir}/`, import.meta.url),
      new URL(`../../plugins/${config.marketplaceDir}/`, import.meta.url),
    ];
    for (const candidate of candidates) {
      const root = fileURLToPath(candidate);
      if (existsSync(join(root, config.marketplaceManifest))) return root;
    }
  } catch {
    // A missing or malformed bundle must degrade to manual instructions.
  }
  return null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizedPluginVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const version = value.trim();
  return version === '' ? null : version;
}

function firstOutputLine(value: string): string | null {
  const line = value.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return line === '' ? null : line;
}

interface ParsedPluginList {
  known: boolean;
  installed: boolean;
  installedVersion: string | null;
}

function parsePluginList(stdout: string, harness: HarnessId): ParsedPluginList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { known: false, installed: false, installedVersion: null };
  }

  if (harness === 'claude-code') {
    if (!Array.isArray(parsed)) return { known: false, installed: false, installedVersion: null };
    const entry = parsed.find((item): item is Record<string, unknown> => {
      const row = recordOf(item);
      if (row === null) return false;
      const id = typeof row.id === 'string' ? row.id : '';
      return id === PLUGIN_SELECTOR || id.split('@', 1)[0] === 'owenloop';
    });
    return entry === undefined
      ? { known: true, installed: false, installedVersion: null }
      : { known: true, installed: true, installedVersion: normalizedPluginVersion(entry.version) };
  }

  const root = recordOf(parsed);
  if (root === null || !Array.isArray(root.installed)) return { known: false, installed: false, installedVersion: null };
  const entry = root.installed.find((item): item is Record<string, unknown> => {
    const row = recordOf(item);
    if (row === null || row.installed !== true) return false;
    return (
      row.pluginId === PLUGIN_SELECTOR ||
      (row.name === 'owenloop' && row.marketplaceName === 'owenloop')
    );
  });
  return entry === undefined
    ? { known: true, installed: false, installedVersion: null }
    : { known: true, installed: true, installedVersion: normalizedPluginVersion(entry.version) };
}

function probeCliVersion(
  run: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string },
  cliName: HarnessPluginState['cliName'],
): string | null {
  try {
    const result = run(cliName, ['--version']);
    return result.status === 0 ? firstOutputLine(result.stdout) : null;
  } catch {
    return null;
  }
}

/** Probe both harnesses using their structured installed-plugin JSON channels. */
function probePlugin(io: CliIO): HarnessPluginState[] {
  const run = io.runCommand ?? defaultRunCommand;
  return HARNESS_IDS.map((id) => {
    const config = HARNESS_CONFIGS[id];
    const cliFound = commandOnPath(io.env, config.cliName);
    if (!cliFound) {
      return { id, cliName: config.cliName, cliFound: false, installed: false, installedVersion: null, cliVersion: null };
    }

    let installed = false;
    let installedVersion: string | null = null;
    try {
      const result = run(config.cliName, ['plugin', 'list', '--json']);
      if (result.status === 0) {
        const parsed = parsePluginList(result.stdout, id);
        // A successful command with malformed output cannot establish presence.
        // Treat it as not installed, matching the non-zero-exit path below.
        installed = parsed.known ? parsed.installed : false;
        installedVersion = parsed.installedVersion;
      }
    } catch {
      // A failed probe cannot establish presence; the ACT remains PATH-gated.
      installed = false;
      installedVersion = null;
    }

    return {
      id,
      cliName: config.cliName,
      cliFound,
      installed,
      installedVersion,
      cliVersion: probeCliVersion(run, config.cliName),
    };
  });
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function resolvedMarketplaceRoot(io: CliIO, harness: HarnessId): string | null {
  const resolver = io.resolveBundledMarketplaceRoot ?? resolveBundledMarketplaceRoot;
  try {
    return resolver(harness);
  } catch {
    return null;
  }
}

function pluginRemedy(harness: HarnessId, root: string | null): string {
  const config = HARNESS_CONFIGS[harness];
  const source = root ?? '<bundled marketplace root>';
  return harness === 'claude-code'
    ? `${config.cliName} plugin marketplace add ${source} && ${config.cliName} plugin install ${PLUGIN_SELECTOR}`
    : `${config.cliName} plugin marketplace add ${source} && ${config.cliName} plugin add ${PLUGIN_SELECTOR}`;
}

function printManualPluginInstructions(io: CliIO, harness: HarnessId): void {
  const config = HARNESS_CONFIGS[harness];
  io.err(`${config.displayName} plugin — install manually:`);
  io.err(`  ${config.cliName} plugin marketplace add <bundled marketplace root>`);
  io.err(
    `  ${config.cliName} plugin ${harness === 'claude-code' ? 'install' : 'add'} ${PLUGIN_SELECTOR}`,
  );
}

function reportPluginCommandFailure(
  io: CliIO,
  cmd: string,
  args: string[],
  result: { stdout: string; stderr: string } | null,
  error: unknown = undefined,
): void {
  io.err(`plugin command failed: ${cmd} ${args.join(' ')}`);
  const childOutput = result === null ? '' : [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  if (childOutput !== '') io.err(childOutput);
  if (error !== undefined) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== '') io.err(message);
  }
}

function runPluginCommand(io: CliIO, cmd: string, args: string[]): boolean {
  const run = io.runCommand ?? defaultRunCommand;
  try {
    const result = run(cmd, args);
    if (result.status === 0) return true;
    reportPluginCommandFailure(io, cmd, args, result);
  } catch (error) {
    reportPluginCommandFailure(io, cmd, args, null, error);
  }
  return false;
}

type MarketplaceGate = 'same' | 'absent' | 'different' | 'unknown';

function codexMarketplaceGate(io: CliIO, root: string): MarketplaceGate {
  const run = io.runCommand ?? defaultRunCommand;
  let result: { status: number | null; stdout: string; stderr: string };
  try {
    result = run('codex', ['plugin', 'marketplace', 'list', '--json']);
  } catch {
    return 'absent';
  }
  if (result.status !== 0) return 'absent';

  try {
    const parsed = recordOf(JSON.parse(result.stdout));
    if (parsed === null || !Array.isArray(parsed.marketplaces)) return 'absent';
    const entry = parsed.marketplaces.find((item) => recordOf(item)?.name === 'owenloop');
    if (entry === undefined) return 'absent';
    const row = recordOf(entry);
    const source = recordOf(row?.marketplaceSource)?.source;
    if (typeof source !== 'string' || source.trim() === '') return 'unknown';
    return canonicalPath(source) === canonicalPath(root) ? 'same' : 'different';
  } catch {
    return 'absent';
  }
}

type PluginStepOutcome = Pick<SetupStep, 'action' | 'detail'>;

/** Converge one harness without making plugin failures fatal to setup. */
function installPluginStep(io: CliIO, state: HarnessPluginState): PluginStepOutcome {
  const config = HARNESS_CONFIGS[state.id];
  if (!state.cliFound) return { action: 'noted', detail: `${config.cliName} not on PATH` };
  if (state.installed && state.installedVersion === null) {
    return { action: 'skipped', detail: 'installed (version unknown)' };
  }

  const expectedVersion = packageVersion().trim();
  const currentVersion = state.installedVersion?.trim() ?? null;
  if (state.installed && currentVersion === expectedVersion) {
    return { action: 'skipped', detail: `owenloop ${currentVersion} already current` };
  }

  const root = resolvedMarketplaceRoot(io, state.id);
  if (root === null) {
    printManualPluginInstructions(io, state.id);
    return { action: 'noted', detail: 'bundled marketplace root unavailable — printed manual instructions' };
  }

  const upgrading = state.installed && currentVersion !== null;
  if (state.id === 'claude-code') {
    if (!runPluginCommand(io, 'claude', ['plugin', 'marketplace', 'add', root])) {
      return { action: 'noted', detail: 'marketplace add failed' };
    }
    const verb = upgrading ? 'update' : 'install';
    if (!runPluginCommand(io, 'claude', ['plugin', verb, PLUGIN_SELECTOR])) {
      return { action: 'noted', detail: `${verb} failed` };
    }
    return { action: 'done', detail: upgrading ? `updated to ${expectedVersion}` : `installed ${expectedVersion}` };
  }

  const marketplace = codexMarketplaceGate(io, root);
  if (marketplace === 'different') {
    return {
      action: 'noted',
      detail: "marketplace 'owenloop' is already added from a different source; remove it before adding this source",
    };
  }
  if (marketplace === 'unknown') {
    return { action: 'noted', detail: 'could not determine the existing Codex marketplace source' };
  }
  if (marketplace === 'absent' && !runPluginCommand(io, 'codex', ['plugin', 'marketplace', 'add', root])) {
    return { action: 'noted', detail: 'marketplace add failed' };
  }
  if (!runPluginCommand(io, 'codex', ['plugin', 'add', PLUGIN_SELECTOR])) {
    return { action: 'noted', detail: 'plugin add failed' };
  }
  return { action: 'done', detail: upgrading ? `updated to ${expectedVersion}` : `installed ${expectedVersion}` };
}

function enrollmentEnvelopeNewKeyId(value: unknown): string | undefined {
  const envelope = recordOf(value);
  if (envelope === null || typeof envelope.payload !== 'string') return undefined;
  try {
    const payload = JSON.parse(decodeBase64Strict(envelope.payload, { allowEmpty: true }).toString('utf8')) as unknown;
    const record = recordOf(payload);
    const newKey = recordOf(record?.newKey);
    return typeof newKey?.keyid === 'string' ? newKey.keyid : undefined;
  } catch {
    return undefined;
  }
}

function enrollmentEnvelopesFromResponse(body: unknown): unknown[] {
  if (Array.isArray(body)) return body.map((row) => recordOf(row)?.envelope ?? row);
  const record = recordOf(body);
  if (record === null) throw new CliError('enrollments: malformed response — expected an array of entries');
  for (const key of ['enrollments', 'entries', 'envelopes', 'items']) {
    const rows = record[key];
    if (Array.isArray(rows)) return rows.map((row) => recordOf(row)?.envelope ?? row);
  }
  if (record.envelope !== undefined) return [record.envelope];
  throw new CliError('enrollments: malformed response — expected an array of entries');
}

/**
 * Register the already-created machine key as a signed enrollment grant. This
 * helper owns only the D1 relay action: the hub stores the DSSE envelope, while
 * the human signing key signs locally and the machine private key never enters
 * the request body.
 */
async function registerMachineEnrollment(
  io: CliIO,
  origin: string,
  humanCred: Credential,
  keys: Pick<PrincipalKeyManager, 'inspect' | 'withSigningKey'>,
  humanRef: PrincipalKeyRef,
  machinePublicKey: Parameters<typeof buildEnrollmentGrant>[0]['newKey'],
): Promise<SetupStep> {
  const noted = (detail: string): SetupStep => ({ step: 'enrollment', action: 'noted', detail });
  const skipped = (detail: string): SetupStep => ({ step: 'enrollment', action: 'skipped', detail });
  const done = (detail: string): SetupStep => ({ step: 'enrollment', action: 'done', detail });

  let human: Awaited<ReturnType<PrincipalKeyManager['inspect']>>;
  try {
    human = await keys.inspect(humanRef);
  } catch {
    return skipped('human signing key could not be inspected');
  }
  if (!human.exists || human.publicKey === undefined) {
    return skipped('no human signing key is stored');
  }

  let list: { res: Response; cred: Credential };
  try {
    list = await authedGet(io, origin, { principal: 'human' }, humanCred, '/api/enrollments');
  } catch {
    return noted('hub enrollment listing unavailable');
  }
  if (!list.res.ok) return noted(`hub enrollment listing rejected (HTTP ${list.res.status})`);

  let existing: unknown[];
  try {
    existing = enrollmentEnvelopesFromResponse(await list.res.json());
  } catch (error) {
    return noted(error instanceof CliError ? error.message : 'hub enrollment listing was not valid JSON');
  }
  if (existing.some((entry) => enrollmentEnvelopeNewKeyId(entry) === machinePublicKey.keyid)) {
    return skipped('machine key already registered');
  }

  const grant = buildEnrollmentGrant({
    newKey: machinePublicKey,
    principal: { kind: 'machine', id: 'local' },
    scope: DEFAULT_MACHINE_SCOPE,
    grantedBy: human.publicKey.keyid,
    validFrom: nowMs(),
  });

  let envelope: unknown;
  try {
    envelope = await keys.withSigningKey(humanRef, async (signKeyPath) => {
      const signer = createSshSigner({ namespace: DSSE_SSH_NAMESPACE, signKeyPath });
      const signed = await dsseSignEnrollmentGrant(Buffer.from(canonicalJsonBytes(grant)), signer);
      return signed.envelope;
    });
  } catch (error) {
    if (error instanceof SshSignerError) return noted(`enrollment signing unavailable: ${error.message}`);
    return noted('could not sign enrollment grant');
  }

  let posted: { res: Response; cred: Credential };
  try {
    posted = await authedPost(io, origin, { principal: 'human' }, list.cred, '/api/enrollments', { envelope });
  } catch {
    return noted('hub enrollment registration unavailable');
  }
  if (posted.res.status === 409) return skipped('machine key already registered');
  if (!posted.res.ok) return noted(`hub enrollment registration rejected (HTTP ${posted.res.status})`);
  return done('machine key registered');
}

/**
 * `owenloop setup` — converge this machine's install in eight probe→(skip|act)
 * steps, idempotently: a second run performs ZERO writes (no store mutation, no
 * key generation, no settings write, no browser, no mint/rekey/register POST).
 * Each ACT is reached only through its probe failing.
 *
 * Flags: `--hub <url>`; mutually-exclusive `--new-agent <name>` / `--replace-agent
 * <name>` (bypass the interactive agent branches); `--crews <a,b>` (mint only —
 * a usage error with `--replace-agent`, which preserves crews); `--scopes <a,b>`
 * (mint only — the minted token's scopes, default `work`; a usage error with
 * `--replace-agent`, which preserves scopes); `--reuse-ssh-key <path>` (human
 * signing key only — validate an existing Ed25519 SSH key and record it instead
 * of generating the human key; a conflict with an existing key is a hard error).
 *
 * Exit: 0 when every step ended skipped/done/noted AND doctor's core (non-plugin)
 * checks pass; 1 otherwise. Any hard failure throws (mapped to an exit code by
 * `mainAsync`).
 */
async function dispatchSetup(io: CliIO, args: Args): Promise<number> {
  // --- usage validation, before any I/O ---
  const newAgent = last(args, 'new-agent');
  const replaceAgent = last(args, 'replace-agent');
  if (newAgent !== undefined && replaceAgent !== undefined) {
    throw new CliError('pass at most one of --new-agent or --replace-agent, not both');
  }
  const crewsRaw = last(args, 'crews');
  let crews: string[] | undefined;
  if (crewsRaw !== undefined) {
    crews = crewsRaw
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    if (crews.length === 0) throw new CliError('--crews requires at least one crew name');
  }
  if (replaceAgent !== undefined && crews !== undefined) {
    throw new CliError(
      "--crews cannot be combined with --replace-agent — re-keying preserves the agent's crews (manage crews in the console)",
    );
  }
  // --scopes: same shape as --crews. Absent → undefined (mint inherits the
  // `?? ['work']` default). Present but empty → usage error, before any I/O.
  const scopesRaw = last(args, 'scopes');
  let scopes: string[] | undefined;
  if (scopesRaw !== undefined) {
    scopes = scopesRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (scopes.length === 0) throw new CliError('--scopes requires at least one scope name');
  }
  if (replaceAgent !== undefined && scopes !== undefined) {
    throw new CliError(
      "--scopes cannot be combined with --replace-agent — re-keying preserves the agent's scopes (mint a new agent to change scopes)",
    );
  }
  for (const [flagName, val] of [
    ['--new-agent', newAgent],
    ['--replace-agent', replaceAgent],
  ] as const) {
    if (val !== undefined) {
      try {
        credentialSlot({ principal: 'agent', account: val });
      } catch (e) {
        throw new CliError(`${flagName}: invalid agent name — ${(e as Error).message}`);
      }
    }
  }

  // Symmetric with `dispatchLogin`: when an external credential command supplies
  // this hub's credentials, the local store is never consulted, so setup's
  // human-login step (step 2, which opens the loopback OAuth browser) and its
  // agent mint would strand keys nobody reads. Refuse BEFORE any browser opens —
  // otherwise setup completes the full OAuth round-trip only to fail at
  // storeCredential's backstop, wasting a browser trip on the flagship command.
  if (externalCredentialCommand(io.env) !== undefined) {
    throw new CliError(
      'an external credential command is configured (OWENLOOP_CREDENTIAL_COMMAND), so it — not the ' +
        'local store — supplies credentials for this hub; unset it to use `owenloop login`',
    );
  }

  // --reuse-ssh-key: explicit SSH-key reuse for the HUMAN key only. The key
  // itself is validated (and challenged) inside the signing-keys step; here
  // only the path shape is checked, so a typo fails BEFORE any browser opens.
  const reuseSshKey = last(args, 'reuse-ssh-key');
  if (reuseSshKey !== undefined && reuseSshKey.trim() === '') {
    throw new CliError('--reuse-ssh-key requires a key file path');
  }
  if (reuseSshKey !== undefined && !existsSync(reuseSshKey)) {
    throw new CliError('--reuse-ssh-key: no such file');
  }

  const origin = resolveSetupHub(io, args);
  const steps: SetupStep[] = [];

  // --- [1/8] inspect: zero writes, best-effort probes ---
  io.err('[1/8] inspect');
  io.err(`  human credential: ${readCredential(io, origin, { principal: 'human' }) !== null ? 'present' : 'none — will log in'}`);
  const inspectSettingsPath = owenloopSettingsPath(io.env);
  let settingsNote: string;
  if (!existsSync(inspectSettingsPath)) {
    settingsNote = 'missing — will write';
  } else {
    try {
      const raw = readOwenloopSettingsRaw(inspectSettingsPath);
      const found = raw && typeof raw.hubOrigin === 'string' ? raw.hubOrigin : undefined;
      settingsNote = found === origin ? `hubOrigin already ${origin}` : `hubOrigin ${found ?? '(unset)'} — will update`;
    } catch {
      settingsNote = 'present but unreadable — the settings step will error if still corrupt';
    }
  }
  io.err(`  owenloop settings: ${settingsNote}`);
  io.err(`  claude on PATH: ${commandOnPath(io.env, 'claude') ? 'yes' : 'no'}`);
  io.err(`  codex on PATH: ${commandOnPath(io.env, 'codex') ? 'yes' : 'no'}`);
  const inspectAccts = enumerateAgentAccounts(io, origin);
  io.err(
    inspectAccts === null
      ? '  agent slots: checked in step 3'
      : `  agent slots: ${inspectAccts.length ? inspectAccts.map((a) => `agent:${a}`).join(', ') : 'none'}`,
  );
  steps.push({ step: 'inspect', action: 'done', detail: 'probed local state' });

  // --- [2/8] human login: the hard gate that makes step 3's rekey legal ---
  io.err('[2/8] human login');
  let humanCred = readCredential(io, origin, { principal: 'human' });
  let humanIdentity: WhoamiIdentity;
  if (humanCred !== null) {
    try {
      const verified = await verifyCredential(io, origin, { principal: 'human' }, humanCred);
      humanCred = verified.cred;
      humanIdentity = verified.identity;
      io.err(`✓ human: ${humanIdentity.email ?? humanIdentity.actor.id} @ ${humanIdentity.orgName}`);
      steps.push({ step: 'human login', action: 'skipped', detail: `${humanIdentity.email ?? humanIdentity.actor.id} @ ${humanIdentity.orgName}` });
    } catch (e) {
      if (!(e instanceof CliError)) throw e; // a genuine non-credential error is not a re-login trigger
      const r = await runLoopbackOAuth(io, origin);
      humanCred = r.cred;
      humanIdentity = r.identity;
      io.err(`✓ human: signed in as ${humanIdentity.email ?? humanIdentity.actor.id} @ ${humanIdentity.orgName}`);
      steps.push({ step: 'human login', action: 'done', detail: `signed in as ${humanIdentity.email ?? humanIdentity.actor.id}` });
    }
  } else {
    const r = await runLoopbackOAuth(io, origin);
    humanCred = r.cred;
    humanIdentity = r.identity;
    io.err(`✓ human: signed in as ${humanIdentity.email ?? humanIdentity.actor.id} @ ${humanIdentity.orgName}`);
    steps.push({ step: 'human login', action: 'done', detail: `signed in as ${humanIdentity.email ?? humanIdentity.actor.id}` });
  }

  // --- [3/8] agent ---
  io.err('[3/8] agent');
  const { res: idRes } = await authedGet(io, origin, { principal: 'human' }, humanCred, '/api/agent_identities');
  if (idRes.status === 403) {
    throw new CliError('setup needs an admin credential to manage Scoped Identities (hub returned 403)');
  }
  assertAuthOk(idRes, humanCred, origin);
  const identities = asAgentIdentities(await idRes.json());

  const candidateNames = new Set<string>(identities.map((i) => i.name));
  candidateNames.add('default');
  const probe = await probeAgentSlots(io, origin, [...candidateNames], identities);

  let agentAccount: string;
  let agentCrews: string[] | undefined;
  // The stable principal id for the agent signing key: the hub's agent actor
  // id (`agentId`), which rekey preserves and mint mints fresh.
  let agentPrincipalId: string;
  if (probe.verified !== null) {
    agentAccount = probe.verified.name;
    agentPrincipalId = probe.verified.actorId;
    agentCrews = probe.verified.identity?.crews;
    const crewsStr = probe.verified.identity ? ` (crews: ${probe.verified.identity.crews.join(', ') || 'none'})` : '';
    io.err(`✓ agent: ${agentAccount}${crewsStr}`);
    steps.push({ step: 'agent', action: 'skipped', detail: `agent:${agentAccount} verified` });
  } else {
    // ACT — resolve which agent to connect, then mint or rekey.
    let action: { mode: 'mint'; name: string } | { mode: 'rekey'; agentId: string; name: string };
    if (newAgent !== undefined) {
      action = { mode: 'mint', name: newAgent };
    } else if (replaceAgent !== undefined) {
      const target = identities.find((i) => i.name === replaceAgent);
      if (target === undefined) {
        throw new CliError(
          `no Scoped Identity named '${replaceAgent}' on ${origin} — available: ${identities.map((i) => i.name).join(', ') || '(none)'}`,
        );
      }
      action = { mode: 'rekey', agentId: target.id, name: replaceAgent };
    } else if (identities.length === 0) {
      // Flow A — fresh org, prompt for a name.
      action = { mode: 'mint', name: await promptAgentName(io) };
    } else {
      // Flow B — succession.
      const choice = await promptSuccession(io, identities);
      action =
        choice.kind === 'new'
          ? { mode: 'mint', name: await promptAgentName(io) }
          : { mode: 'rekey', agentId: choice.identity.id, name: choice.identity.name };
    }

    if (action.mode === 'mint') {
      const result = await mintAgentCredential(io, origin, { principal: 'human' }, humanCred, { name: action.name, crews, scopes });
      agentAccount = action.name;
      agentPrincipalId = result.agentId;
      agentCrews = result.crews;
      io.err(`✓ agent: minted agent:${agentAccount} (crews: ${result.crews.join(', ') || 'none'}; scopes: ${result.scopes.join(', ')})`);
      steps.push({ step: 'agent', action: 'done', detail: `minted agent:${agentAccount}` });
    } else {
      const result = await rekeyAgentCredential(io, origin, { principal: 'human' }, humanCred, { agentId: action.agentId, name: action.name });
      agentAccount = action.name;
      agentPrincipalId = result.agentId;
      io.err(`✓ agent: re-keyed agent:${agentAccount} (revoked ${result.revokedTokenIds.length} old token(s))`);
      steps.push({ step: 'agent', action: 'done', detail: `re-keyed agent:${agentAccount}` });
    }
  }

  // --- [4/8] signing keys: human → machine → agent, idempotently ---
  // Prints kind + state + backend ONLY. Never key bytes, fingerprints,
  // secret-store values, or reused private-key paths.
  io.err('[4/8] signing keys');
  const keys = io.principalKeys ?? new PrincipalKeyManager({ env: io.env });
  const humanRef: PrincipalKeyRef = { origin, kind: 'human', id: humanIdentity.actor.id };
  const machineRef: PrincipalKeyRef = { origin, kind: 'machine', id: 'local' };
  const agentRef: PrincipalKeyRef = { origin, kind: 'agent', id: agentPrincipalId };
  const ensured: string[] = [];
  let machine: Awaited<ReturnType<PrincipalKeyManager['ensure']>>;
  {
    const human = await keys.ensure(humanRef, reuseSshKey !== undefined ? { reuse: { path: reuseSshKey } } : undefined);
    ensured.push(`human ${human.state} (${human.backend})`);
    machine = await keys.ensure(machineRef);
    ensured.push(`machine ${machine.state} (${machine.backend})`);
    const agent = await keys.ensure(agentRef);
    ensured.push(`agent ${agent.state} (${agent.backend})`);
  }
  io.err(`✓ signing keys: ${ensured.join(', ')}`);
  steps.push({ step: 'signing keys', action: 'done', detail: ensured.join(', ') });

  // Registration is deliberately subordinate to key convergence: a missing
  // SSHSIG tool, absent human key, or unavailable hub is a noted convergence
  // result, never a reason to undo the three silent key ensures above.
  const enrollment = await registerMachineEnrollment(io, origin, humanCred, keys, humanRef, machine.publicKey);
  io.err(`${enrollment.action === 'noted' ? '!' : '✓'} enrollment: ${enrollment.detail}`);
  steps.push(enrollment);

  // --- [5/8] owenloop settings ---
  io.err('[5/8] owenloop settings');
  const settingsPath = owenloopSettingsPath(io.env);
  const existingSettings = readOwenloopSettingsRaw(settingsPath); // corrupt file → hard CliError (never clobber)
  const currentHub = existingSettings && typeof existingSettings.hubOrigin === 'string' ? existingSettings.hubOrigin : undefined;
  if (existingSettings !== null && currentHub === origin) {
    io.err(`✓ owenloop settings: hubOrigin already ${origin}`);
    steps.push({ step: 'owenloop settings', action: 'skipped', detail: settingsPath });
  } else {
    const written = writeOwenloopHubOrigin(io.env, origin);
    io.err(`✓ owenloop settings: hubOrigin ${written.previous ?? '(unset)'} → ${origin}`);
    steps.push({ step: 'owenloop settings', action: 'done', detail: `${written.previous ?? '(unset)'} → ${origin}` });
  }
  if (agentAccount !== 'default') {
    io.err(`non-default agent account — run owenloop work with OWENLOOP_ACCOUNT=${agentAccount}`);
  }

  // --- [6/8] crew rosters ---
  io.err('[6/8] crew rosters');
  if (agentCrews === undefined || agentCrews.length === 0) {
    const detail = 'no crews known for this agent';
    io.err(`! crew rosters: ${detail}`);
    steps.push({ step: 'crew rosters', action: 'noted', detail });
  } else {
    for (const crew of agentCrews) {
      const path = crewRosterPath(io.env, crew);
      // Write a complete private temp first, then install it with link(2): the
      // link is exclusive (EEXIST leaves an operator file untouched), while a
      // short write can only leave a removable temp, never a corrupt roster.
      const installed = installCrewRosterIfAbsent(
	path,
	`${JSON.stringify({ crew, note: `machine-local overrides for crew ${crew}; wins over settings.json and hub rosters — see docs/cli.md`, roster: {} }, null, 2)}\n`,
	);
	if (installed === 'created') {
	io.err(`✓ crew roster ${crew}: created`);
	steps.push({ step: 'crew rosters', action: 'done', detail: `${crew}: ${path}` });
	} else {
	io.err(`✓ crew roster ${crew}: existing file left untouched`);
	steps.push({ step: 'crew rosters', action: 'skipped', detail: `${crew}: ${path}` });
      }
    }
  }

  // --- [7/8] plugin (non-fatal) ---
  io.err('[7/8] plugin');
  for (const pluginState of probePlugin(io)) {
    const outcome = installPluginStep(io, pluginState);
    const marker = outcome.action === 'noted' ? '!' : '✓';
    io.err(`${marker} plugin (${pluginState.id}): ${outcome.detail}`);
    steps.push({ step: `plugin (${pluginState.id})`, ...outcome });
  }

  // --- [8/8] doctor pass ---
  io.err('[8/8] doctor');
  const doctor = await runDoctor(io, origin);

  print(io, { ok: doctor.ok, hub: origin, steps, doctor: { ok: doctor.ok, checks: doctor.checks } });
  return doctor.ok ? 0 : 1;
}

/**
 * `owenloop enrollments` — read the hub's relayed DSSE envelopes and classify
 * each roster entry locally. This command never creates keys and never writes a
 * roster entry. D1 intentionally installs no chain validator, so a valid signed
 * grant is visible as `unverifiable` until WP-D4 supplies that validator.
 */
async function dispatchEnrollments(io: CliIO, args: Args): Promise<number> {
  const origin = resolveSetupHub(io, args);
  const slot: CredentialSlotSelector = { principal: 'human' };
  const cred = readCredential(io, origin, slot);
  if (cred === null) {
    throw new CliError(`no human credential for ${origin} — run: owenloop login --hub ${origin}`, { exitCode: 3 });
  }

  const { res, cred: used } = await authedGet(io, origin, slot, cred, '/api/enrollments');
  assertAuthOk(res, used, origin);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CliError('enrollments: malformed response — body is not valid JSON');
  }
  let envelopes: unknown[];
  try {
    envelopes = enrollmentEnvelopesFromResponse(body);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : 'enrollments: malformed response');
  }

  let allowedSignersText: string | undefined;
  try {
    const roots = resolveAllowedSigners(io.env);
    allowedSignersText = roots.kind === 'present' ? roots.text : undefined;
  } catch {
    allowedSignersText = undefined;
  }

  const verdicts: RosterVerdict[] = [];
  for (const envelope of envelopes) {
    verdicts.push(await verifyRosterEntry({ envelope, allowedSignersText }));
  }
  print(io, { ok: true, hub: origin, enrollments: verdicts });
  return 0;
}

/**
 * `owenloop doctor` — the read-only probe of the five install surfaces plus the
 * two harness plugin checks, rendering one distinct ✓/✗ line each. NO configuration writes (no
 * mint, rekey, slot create/delete, settings write, or browser). The one
 * carve-out: `authedGet`'s persist=true MAY rotate-and-persist an expiring human
 * oauth token — as every authed verb does — because a refresh WITHOUT persisting
 * would strand the rotated refresh token and corrupt the install (worse than a
 * write). Tests use non-expiring tokens so the strict zero-write assertion holds.
 */
async function dispatchDoctor(io: CliIO, args: Args): Promise<number> {
  const origin = resolveSetupHub(io, args);
  const doctor = await runDoctor(io, origin);
  print(io, { ok: doctor.ok, hub: origin, checks: doctor.checks });
  return doctor.ok ? 0 : 1;
}

/**
 * Run the doctor checks in order, printing each ✓/✗ line to stderr and
 * returning the structured result. Never short-circuits — a machine with no
 * working human credential still renders the later checks (the agent probe
 * degrades honestly). `ok` reflects the five core checks only; both plugin checks
 * render but, while `PLUGIN_CHECK_FATAL` is false, never affect `ok`.
 */
async function runDoctor(io: CliIO, origin: string): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  let coreOk = true;
  const record = (label: string, ok: boolean, detail: string, core: boolean): void => {
    io.err(`${ok ? '✓' : '✗'} ${label}: ${detail}`);
    checks.push({ label, ok, detail });
    if (core && !ok) coreOk = false;
  };

  // 1. human slot
  const humanCred = readCredential(io, origin, { principal: 'human' });
  if (humanCred === null) {
    record('human credential', false, `none stored for ${origin} — run owenloop setup (or owenloop login --hub ${origin})`, true);
  } else {
    record('human credential', true, 'present', true);
  }

  // 2. human plane
  let humanOk = false;
  let usableHumanCred: Credential | null = null;
  if (humanCred !== null) {
    try {
      const { cred, identity } = await verifyCredential(io, origin, { principal: 'human' }, humanCred);
      humanOk = true;
      usableHumanCred = cred;
      record('human plane', true, `${identity.email ?? identity.actor.id} @ ${identity.orgName}`, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/refresh/i.test(msg)) {
        record('human plane', false, 'human credential present but irrecoverable (refresh failed) — run owenloop login', true);
      } else if (/rejected by the hub|revoked or invalid/.test(msg)) {
        record('human plane', false, 'human credential rejected by the hub — run owenloop login', true);
      } else {
        record('human plane', false, `could not reach the hub — ${msg}`, true);
      }
    }
  } else {
    record('human plane', false, 'not checked — no human credential to verify', true);
  }

  // Best-effort identities listing for the agent checks (soft: a 403/failure degrades, never throws).
  let identities: AgentIdentitySummary[] = [];
  let identitiesForbidden = false;
  let identitiesAvailable = false;
  if (humanOk && usableHumanCred !== null) {
    try {
      const { res } = await authedGet(io, origin, { principal: 'human' }, usableHumanCred, '/api/agent_identities');
      if (res.status === 403) {
        identitiesForbidden = true;
      } else if (res.ok) {
        identities = asAgentIdentities(await res.json());
        identitiesAvailable = true;
      }
    } catch {
      // leave degraded
    }
  }

  // 3. agent slot (presence) + 4. agent plane (verification)
  const candidateNames = new Set<string>(identities.map((i) => i.name));
  const fileAccts = enumerateAgentAccounts(io, origin);
  if (fileAccts !== null) for (const a of fileAccts) candidateNames.add(a);
  candidateNames.add('default');
  const agentProbe = await probeAgentSlots(io, origin, [...candidateNames], identities);

  if (!agentProbe.sawSlot) {
    if (!identitiesAvailable && !humanOk && fileAccts === null) {
      record('agent slot', false, 'not probeable without a working human credential', true);
    } else {
      record('agent slot', false, `no agent credential stored for ${origin} — run owenloop setup`, true);
    }
    record('agent plane', false, 'no agent credential to verify — run owenloop setup', true);
  } else {
    record('agent slot', true, 'present', true);
    if (agentProbe.verified !== null) {
      const va = agentProbe.verified;
      const crews = va.identity
        ? `crews: ${va.identity.crews.join(', ') || 'none'}`
        : identitiesForbidden
          ? '(crews not visible — requires an admin credential)'
          : '(crews unknown)';
      const idPart = va.identity ? va.identity.id : va.actorId;
      record('agent plane', true, `${va.name} (agent id ${idPart}) · ${crews}`, true);
    } else if (agentProbe.sawRevoked) {
      record('agent plane', false, 'agent token revoked or invalid — re-run owenloop setup (Replace) or Reconnect in the console', true);
    } else {
      record('agent plane', false, 'agent credential present but could not be verified against the hub', true);
    }
  }

  // 5. owenloop settings
  const settingsPath = owenloopSettingsPath(io.env);
  let settingsRaw: Record<string, unknown> | null = null;
  let settingsError: string | null = null;
  try {
    settingsRaw = readOwenloopSettingsRaw(settingsPath);
  } catch (e) {
    settingsError = e instanceof Error ? e.message : String(e);
  }
  if (settingsError !== null) {
    record('owenloop settings', false, settingsError, true);
  } else if (settingsRaw === null) {
    record('owenloop settings', false, `missing (${settingsPath})`, true);
  } else {
    const found = typeof settingsRaw.hubOrigin === 'string' ? settingsRaw.hubOrigin : undefined;
    if (found !== origin) {
      record('owenloop settings', false, `hubOrigin is ${found ?? '(unset)'}, expected ${origin}`, true);
    } else {
      record('owenloop settings', true, settingsPath, true);
    }
  }

  // Crew-roster diagnostics are informational per crew. Global disk discovery
  // complements the verified agent's authoritative crew list: a malformed
  // bounded-hash file cannot decode its own identity, but the worker still
  // resolves that requested deterministic target and must fail closed on it.
  const crewNames = new Set<string>();
  try {
    for (const file of discoverCrewRosterFiles(io.env)) crewNames.add(file.crew);
  } catch (error) {
    record('crew roster discovery', false, error instanceof Error ? error.message : String(error), false);
  }
  if (agentProbe.verified?.identity !== undefined) {
    for (const crew of agentProbe.verified.identity.crews) crewNames.add(crew);
  }
  for (const crew of [...crewNames].sort()) {
    try {
	const settings = loadSettings(io.env);
	const layers = effectiveRosterLayers(io.env, crew, { origin: settings.hubOrigin, account: io.env.OWENLOOP_ACCOUNT ?? 'default' });
      const merged = mergeRosterLayers(layers);
      const found = layers
	.map((layer) => `${layer.source}=${layer.roster === undefined ? 'absent' : 'found'}`)
	.join(', ');
      const harnesses = [...new Set(Object.values(merged).flatMap((entry) => entry.candidates.map((candidate) => candidate.harness)))];
      const present = harnesses.filter((id) => adapterFor(id) !== undefined);
      const missing = harnesses.filter((id) => adapterFor(id) === undefined);
      record(
	`crew roster (${crew})`,
	true,
	`layers: ${found}; harnesses present: ${present.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}`,
	false,
      );
    } catch (error) {
      record(`crew roster (${crew})`, false, error instanceof Error ? error.message : String(error), false);
    }
  }

  // plugins (rendered; non-core while PLUGIN_CHECK_FATAL is false)
  for (const pluginState of probePlugin(io)) {
    const config = HARNESS_CONFIGS[pluginState.id];
    if (!pluginState.cliFound) {
      record(`plugin (${pluginState.id})`, false, `${config.displayName} (${config.cliName}) not on PATH`, PLUGIN_CHECK_FATAL);
    } else if (!pluginState.installed) {
      const root = resolvedMarketplaceRoot(io, pluginState.id);
      const cliVersion = pluginState.cliVersion ?? 'unknown';
      record(
        `plugin (${pluginState.id})`,
        false,
        `not installed — ${pluginRemedy(pluginState.id, root)} · ${config.cliName} ${cliVersion}`,
        PLUGIN_CHECK_FATAL,
      );
    } else if (pluginState.installedVersion === null) {
      record(
        `plugin (${pluginState.id})`,
        true,
        `owenloop version unknown · ${config.cliName} ${pluginState.cliVersion ?? 'unknown'}`,
        PLUGIN_CHECK_FATAL,
      );
    } else if (pluginState.installedVersion === packageVersion().trim()) {
      record(
        `plugin (${pluginState.id})`,
        true,
        `owenloop ${pluginState.installedVersion} · ${config.cliName} ${pluginState.cliVersion ?? 'unknown'}`,
        PLUGIN_CHECK_FATAL,
      );
    } else {
      record(
        `plugin (${pluginState.id})`,
        false,
        `owenloop ${pluginState.installedVersion} but CLI is ${packageVersion().trim()} — run owenloop setup · ${config.cliName} ${pluginState.cliVersion ?? 'unknown'}`,
        PLUGIN_CHECK_FATAL,
      );
    }
  }

  return { ok: coreOk, checks };
}

/**
 * Async entry point that adds network I/O for `add` and the hub commands on top
 * of the otherwise fully-synchronous engine/CLI (see the doc comment on
 * `sleepMs` above and README "sync end to end"). `main`/`dispatch` stay sync and
 * unchanged — this wraps them, routing only the network-touching verbs through
 * the async path, so every existing command and test keeps working exactly as
 * before.
 */
export const ASYNC_COMMANDS = new Set(['add', 'login', 'logout', 'connect', 'publish', 'trust', 'push', 'install', 'start', 'cancel', 'provide', 'reject', 'retry', 'instance', 'agent', 'capability', 'routing', 'crew', 'roster', 'setup', 'doctor', 'enrollments', 'mcp', 'shift']);

export async function mainAsync(argv: string[], io: CliIO = defaultIO()): Promise<number> {
  // Delegate execution-side and shift argv tails before root parsing. Their
  // roles own their option grammars, including repeated/value forms that the
  // engine parser must not consume. These dynamic imports are cold-start
  // boundaries: ordinary root commands never evaluate execution adapters.
  if (argv[0] === 'work' || argv[0] === 'shift' || argv[0] === 'util') {
    try {
      if (argv[0] === 'work') {
        const { mainAsync: runWork } = await import('../packages/work/src/main.ts');
        return await runWork(argv.slice(1));
      }
      if (argv[0] === 'util') {
				const { mainAsync: runWork } = await import('../packages/work/src/main.ts');
				return await runWork(['util', ...argv.slice(1)]);
      }
      const { run: runShift } = await import('../packages/work/src/roles/shift.ts');
      return await runShift(argv.slice(1));
    } catch (e) {
      io.err(`error: ${(e as Error).message}`);
      return 1;
    }
  }

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
      case 'publish':
        return await dispatchPublish(io, args);
      case 'trust':
        return await dispatchTrust(io, args);
      case 'push':
        return await dispatchPush(io, args);
      case 'install':
        return await dispatchInstall(io, args);
      case 'start':
	return await dispatchStart(io, args);
      case 'cancel':
        return await dispatchCancel(io, args);
      case 'provide':
	return args.options.has('hub') ? await dispatchProvide(io, args) : main(argv, io);
      case 'reject':
	return args.options.has('hub') ? await dispatchReject(io, args) : main(argv, io);
      case 'retry':
	// Local engine store unless --hub; only the hub half is async, and
	// main()'s own `case 'retry'` stays the local implementation so the
	// synchronous callers of main() keep working.
	return args.options.has('hub') ? await dispatchRetry(io, args) : main(argv, io);
      case 'instance':
        return await dispatchInstance(io, args);
      case 'agent':
        return await dispatchAgent(io, args);
      case 'capability':
        return await dispatchCapability(io, args);
      case 'routing':
        return await dispatchRouting(io, args);
      case 'crew':
        return await dispatchCrew(io, args);
      case 'roster':
	return await dispatchRoster(io, args);
      case 'setup':
        return await dispatchSetup(io, args);
      case 'doctor':
        return await dispatchDoctor(io, args);
      case 'enrollments':
        return await dispatchEnrollments(io, args);
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

/** Run the synchronous engine CLI. The `work` and `shift` namespaces are async-only. */
export function main(argv: string[], io: CliIO = defaultIO()): number {
  if (argv[0] === 'work' || argv[0] === 'shift') {
    io.err(`error: owenloop ${argv[0]} requires the async entry point`);
    return 1;
  }
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
