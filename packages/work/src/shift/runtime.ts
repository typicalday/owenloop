/**
 * `owenloop work shift` — the internal standing Shift loop.
 *
 * The human-facing shift daemon uses the same setup and ShiftLoop through
 * `runShiftRuntime(..., { daemon: true })`; this module remains the single place
 * that resolves settings, credentials, caches, child spawners, and signal
 * behavior. The retired shift stdio-MCP mount is intentionally absent.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createHubClient } from '../hub/client.ts';
import { resolveBearer } from '../credentials/resolve.ts';
import { loadSettings } from '../settings/settings.ts';
import { resolveCacheDir } from '../bundle/cache.ts';
import { createShiftLoop } from './loop.ts';
import { createDefaultSpawner, type WorkerFailure } from './spawn.ts';
import { resolveStateDir, ensureStateDir, reconcileInFlight } from './state.ts';
import { reconcileActiveSessions, sessionsPath } from '../harness/session-store.ts';
import { resolveWorkRepo, resolveWorkRoot } from '../agent/workdir.ts';
import { installSignalHandlers, type SignalHost } from '../roles/signals.ts';
import { createShiftDaemon, type ShiftDaemon } from './server.ts';
import {
  createBundleIngestor,
  createStoreInstructionSource,
  globalStoreRoot,
} from '../../../../src/store/index.ts';

// Re-exported so existing importers keep their import site while the
// implementation lives in the shared signals seam.
export { installSignalHandlers, type SignalHost };

const DEFAULT_CAP = 3;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_AGENTS = 4;
const DEFAULT_PRESENCE_MS = 60_000;

export function resolveCap(flagCap: number | undefined, settingsCap: number | undefined): number {
  return flagCap ?? settingsCap ?? DEFAULT_CAP;
}

export function resolveStateDirOverride(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  settingsStateDir: string | undefined,
): string | undefined {
  return flag ?? env['OWENLOOP_STATE_DIR'] ?? settingsStateDir;
}

export function resolveMaxConcurrentAgents(
  flagMax: number | undefined,
  settingsMax: number | undefined,
): number {
  return flagMax ?? settingsMax ?? DEFAULT_MAX_AGENTS;
}

export function resolveShiftName(
  flagName: string | undefined,
  opts: { shiftId?: string; hostname?: string; cwd?: string; pid?: number } = {},
): string {
  if (flagName !== undefined && flagName !== '') return flagName;
  const suffix =
    opts.shiftId !== undefined && opts.shiftId !== ''
      ? opts.shiftId.replace(/^shf_/, '').replace(/-/g, '').slice(0, 6)
      : `p${opts.pid ?? process.pid}`;
  return `${opts.hostname ?? hostname()}/${basename(opts.cwd ?? process.cwd())}#${suffix}`;
}

export interface ParsedArgs {
  origin?: string;
  as?: string;
  name?: string;
  serveCrews?: string[];
  cap?: number;
  workflow?: string;
  pollIntervalMs?: number;
  once?: boolean;
  maxAgents?: number;
  cacheDir?: string;
  stateDir?: string;
  error?: string;
}

/** Parse shift's internal `--flag value` and `--flag=value` forms. */
export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  const takeValue = (a: string, i: number): { value: string; next: number } | { error: string } => {
    const eq = a.indexOf('=');
    if (eq !== -1) return { value: a.slice(eq + 1), next: i };
    const v = args[i + 1];
    if (v === undefined) return { error: `missing value for ${a}` };
    return { value: v, next: i + 1 };
  };
  const intFlag = (raw: string, flag: string): number | { error: string } => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { error: `${flag} must be a non-negative integer, got '${raw}'` };
    }
    return n;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    switch (name) {
      case '--once':
        parsed.once = true;
        break;
      case '--origin':
      case '--as':
      case '--name':
      case '--serve-crews':
      case '--cap':
      case '--max-agents':
      case '--workflow':
      case '--poll-interval':
      case '--cache-dir':
      case '--state-dir': {
        const r = takeValue(a, i);
        if ('error' in r) return { error: r.error };
        i = r.next;
        if (name === '--origin') parsed.origin = r.value;
        else if (name === '--as') parsed.as = r.value;
        else if (name === '--name') {
          if (r.value.trim() === '') return { error: '--name requires a non-empty value' };
          parsed.name = r.value;
        } else if (name === '--serve-crews') {
          parsed.serveCrews = r.value.split(',').map((s) => s.trim()).filter((s) => s !== '');
        } else if (name === '--workflow') parsed.workflow = r.value;
        else if (name === '--cache-dir') parsed.cacheDir = r.value;
        else if (name === '--state-dir') parsed.stateDir = r.value;
        else if (name === '--cap') {
          const n = intFlag(r.value, '--cap');
          if (typeof n !== 'number') return { error: n.error };
          parsed.cap = n;
        } else if (name === '--max-agents') {
          const n = intFlag(r.value, '--max-agents');
          if (typeof n !== 'number') return { error: n.error };
          parsed.maxAgents = n;
        } else if (name === '--poll-interval') {
          const n = intFlag(r.value, '--poll-interval');
          if (typeof n !== 'number') return { error: n.error };
          parsed.pollIntervalMs = n;
        }
        break;
      }
      default:
        return { error: `unknown option '${a}'` };
    }
  }
  return parsed;
}

function usage(): void {
  process.stderr.write(
    'usage: owenloop work shift [--origin <url>] [--as <account>] [--name <n>] [--serve-crews a,b] [--cap <n>]\n' +
      '                      [--workflow <id>] [--poll-interval <ms>] [--once]\n' +
      '                      [--max-agents <n>] [--cache-dir <p>] [--state-dir <p>]\n',
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ShiftRuntimeOptions {
  /** Build the Unix-socket shift daemon around the same loop instead of self-driving directly. */
  daemon?: boolean;
  /** Output prefix for errors and lifecycle messages. */
  role?: 'shift';
  /** Socket path selected by the shift command. */
  socketPath?: string;
}

/**
 * Shared runtime setup for the internal shift and public shift daemon.
 * `parsed` is already grammar-validated by the caller; this function owns all
 * credential/settings/cache/spawner resolution so the two entry points cannot
 * drift.
 */
export async function runShiftRuntime(parsed: ParsedArgs, options: ShiftRuntimeOptions = {}): Promise<number> {
  const daemonMode = options.daemon === true;
  const roleLabel = options.role === 'shift' ? 'owenloop shift' : 'owenloop work shift';
  const env = process.env;
  let settings;
  try {
    settings = loadSettings(env);
  } catch (err) {
    process.stderr.write(`${roleLabel}: ${errMsg(err)}\n`);
    return 1;
  }

  const origin = parsed.origin ?? settings.hubOrigin;
  if (origin === undefined || origin.trim() === '') {
    process.stderr.write(`${roleLabel}: no hub origin — pass --origin <url> or set hubOrigin in settings\n`);
    return 2;
  }

  if (parsed.as !== undefined && parsed.as.trim() === '') {
    process.stderr.write(`${roleLabel}: --as requires a non-empty account name\n`);
    return 2;
  }
  const account = parsed.as ?? 'default';

  const bearer = await resolveBearer({ origin, account, env });
  if (!bearer.ok) {
    process.stderr.write(`${roleLabel}: ${bearer.message}\n`);
    return bearer.code;
  }
  const token = bearer.token;

  let cacheDir: string;
  let stateDir: string;
  try {
    cacheDir = parsed.cacheDir ?? resolveCacheDir(env, settings.cacheDir);
    stateDir = resolveStateDir(env, resolveStateDirOverride(parsed.stateDir, env, settings.stateDir));
  } catch (err) {
    process.stderr.write(`${roleLabel}: ${errMsg(err)}\n`);
    return 1;
  }

  try {
    ensureStateDir(stateDir);
  } catch (err) {
    process.stderr.write(`${roleLabel}: cannot initialize dispatch state at ${stateDir}: ${errMsg(err)}\n`);
    return 1;
  }
  {
    const liveRunIds = new Set(
      reconcileInFlight(stateDir).live.filter((r) => r.kind === 'agent-run').map((r) => r.run),
    );
    try {
      const retired = reconcileActiveSessions(sessionsPath(cacheDir), liveRunIds, Date.now());
      for (const rec of retired) {
        process.stderr.write(
          `${roleLabel}: retired orphaned session ${rec.workflow}/${rec.run} step '${rec.step}' ` +
            `(harness '${rec.harness}', attempt ${String(rec.attempt ?? 1)}) — its worker is gone, ` +
            'so the next attempt replays cold\n',
        );
      }
    } catch (err) {
      process.stderr.write(`${roleLabel}: session reconcile failed (continuing): ${errMsg(err)}\n`);
    }
  }

  const cap = resolveCap(parsed.cap, settings.dispatchCap);
  const maxConcurrentAgents = resolveMaxConcurrentAgents(parsed.maxAgents, settings.maxConcurrentAgents);
  const workRoot = resolveWorkRoot(env, settings.workRoot, cacheDir);
  const workRepo = resolveWorkRepo(env, settings.workRepo);
  const hub = createHubClient({ origin, getToken: async () => token });
  const now = () => Date.now();
  const monotonicNow = () => performance.now();
  const home = [env.HOME, env.USERPROFILE].find(
    (value) => value !== undefined && value.trim() !== '',
  );
  // Legacy orders and modern agent orders do not need Shift-side instruction
  // lookup. Keep serving those lanes without a home directory; a modern command
  // order still fails closed because its exact digest cannot be resolved.
  const instructionSource = home === undefined
    ? undefined
    : createStoreInstructionSource({
	projectRoot: join(process.cwd(), 'workflows'),
	globalRoot: globalStoreRoot(home),
	verifier: createBundleIngestor(),
      });
  const resolveOrderStep = async (order: { defDigest?: string; step: string }) => {
    if (
      instructionSource === undefined ||
      order.defDigest === undefined ||
      order.defDigest.trim() === ''
    ) return undefined;
    if (await instructionSource.prime(order.defDigest) !== 'resolved') return undefined;
    return instructionSource.getVerifiedStep(order.defDigest, order.step);
  };
  const shiftId = `shf_${randomUUID()}`;
  const startedAt = now();
  const name = resolveShiftName(parsed.name, { shiftId });
  let daemon: ShiftDaemon | undefined;
  const reportWorkerFailure = (failure: WorkerFailure): void => {
    const event = {
      type: 'failed' as const,
      workflow: failure.workflow,
      run: failure.run,
      step: failure.step ?? '(unknown)',
      kind: failure.kind,
      ...(failure.harness !== undefined ? { harness: failure.harness } : {}),
      executable: failure.executable,
      exitStatus: failure.exitStatus,
      signal: failure.signal,
      message: failure.message,
    };
    daemon?.onEvent(event);
    process.stderr.write(`${roleLabel}: worker failure ${JSON.stringify(event)}\n`);
  };
  const spawner = createDefaultSpawner(origin, account, undefined, shiftId, reportWorkerFailure);
  const pollIntervalMs = parsed.pollIntervalMs ?? DEFAULT_POLL_MS;

  const loop = createShiftLoop({
    hub,
    spawner,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now,
    monotonicNow,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    ...(daemonMode ? { onEvent: (event) => daemon?.onEvent(event) } : {}),
    cacheDir,
    stateDir,
    cap,
    serveCrews: parsed.serveCrews ?? [],
    name,
    commandRouting: settings.commandRouting,
    resolveOrderStep,
    pollIntervalMs,
    presenceIntervalMs: DEFAULT_PRESENCE_MS,
    maxConcurrentAgents,
    workRoot,
    ...(workRepo !== undefined ? { workRepo } : {}),
    shiftId,
    startedAt,
    ...(parsed.workflow !== undefined ? { workflow: parsed.workflow } : {}),
    ...(parsed.once === true ? { once: true } : {}),
  });

  if (daemonMode) {
    daemon = createShiftDaemon({
      socketPath: options.socketPath ?? join(stateDir, 'shift.sock'),
      stateDir,
      loop,
      hub,
      now,
      startedAt,
      shiftId,
      err: (line) => process.stderr.write(`${line}\n`),
    });
    installSignalHandlers(daemon, process, (line) => process.stderr.write(`${line}\n`), {
      role: 'shift',
      drainNote: 'draining, in-flight children keep running',
      stopReason: 'signal',
    });
    if (parsed.once !== true) {
      process.stdout.write(`owenloop shift: parked as '${name}' @ ${origin} (cap ${cap})\n`);
    }
    return daemon.run();
  }

  installSignalHandlers(loop, process, (line) => process.stderr.write(`${line}\n`));
  if (parsed.once !== true) {
    process.stdout.write(`owenloop work shift: parked as '${name}' @ ${origin} (cap ${cap})\n`);
  }
  return loop.run();
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.error !== undefined) {
    process.stderr.write(`owenloop work shift: ${parsed.error}\n`);
    usage();
    return 2;
  }
  if (args.some((arg) => arg === '--mcp' || arg.startsWith('--mcp='))) {
    process.stderr.write('owenloop work shift: unknown option \'--mcp\'\n');
    usage();
    return 2;
  }
  return runShiftRuntime(parsed);
}
