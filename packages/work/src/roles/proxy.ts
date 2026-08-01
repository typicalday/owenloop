/**
 * `owenloop work proxy` — the internal standing Conductor loop.
 *
 * The human-facing shift daemon uses the same setup and ProxyLoop through
 * `runProxyRuntime(..., { daemon: true })`; this module remains the single place
 * that resolves settings, credentials, caches, child spawners, and signal
 * behavior. The retired proxy stdio-MCP mount is intentionally absent.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';

import { createHubClient } from '../hub/client.ts';
import { resolveBearer } from '../credentials/resolve.ts';
import { loadSettings } from '../settings/settings.ts';
import { resolveCacheDir } from '../bundle/cache.ts';
import { createProxyLoop } from '../proxy/loop.ts';
import { createDefaultSpawner } from '../proxy/spawn.ts';
import { resolveStateDir, ensureStateDir, reconcileInFlight } from '../proxy/state.ts';
import { reconcileActiveSessions, sessionsPath } from '../harness/session-store.ts';
import { resolveWorkRepo, resolveWorkRoot } from '../agent/workdir.ts';
import { installSignalHandlers, type SignalHost } from './signals.ts';
import { createShiftDaemon, type ShiftDaemon } from '../shift/server.ts';

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
  return flag ?? env['OWENWORK_STATE_DIR'] ?? settingsStateDir;
}

export function resolveMaxConcurrentAgents(
  flagMax: number | undefined,
  settingsMax: number | undefined,
): number {
  return flagMax ?? settingsMax ?? DEFAULT_MAX_AGENTS;
}

export function resolveShiftName(
  flagName: string | undefined,
  opts: { conductorId?: string; hostname?: string; cwd?: string; pid?: number } = {},
): string {
  if (flagName !== undefined && flagName !== '') return flagName;
  const suffix =
    opts.conductorId !== undefined && opts.conductorId !== ''
      ? opts.conductorId.replace(/^cnd_/, '').replace(/-/g, '').slice(0, 6)
      : `p${opts.pid ?? process.pid}`;
  return `${opts.hostname ?? hostname()}/${basename(opts.cwd ?? process.cwd())}#${suffix}`;
}

export interface ParsedArgs {
  origin?: string;
  as?: string;
  name?: string;
  servePools?: string[];
  cap?: number;
  workflow?: string;
  pollIntervalMs?: number;
  once?: boolean;
  maxAgents?: number;
  cacheDir?: string;
  stateDir?: string;
  error?: string;
}

/** Parse proxy's internal `--flag value` and `--flag=value` forms. */
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
      case '--serve-pools':
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
        } else if (name === '--serve-pools') {
          parsed.servePools = r.value.split(',').map((s) => s.trim()).filter((s) => s !== '');
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
    'usage: owenloop work proxy [--origin <url>] [--as <account>] [--name <n>] [--serve-pools a,b] [--cap <n>]\n' +
      '                      [--workflow <id>] [--poll-interval <ms>] [--once]\n' +
      '                      [--max-agents <n>] [--cache-dir <p>] [--state-dir <p>]\n',
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ProxyRuntimeOptions {
  /** Build the Unix-socket shift daemon around the same loop instead of self-driving directly. */
  daemon?: boolean;
  /** Output prefix for errors and lifecycle messages. */
  role?: 'proxy' | 'shift';
  /** Socket path selected by the shift command. */
  socketPath?: string;
}

/**
 * Shared runtime setup for the internal proxy and public shift daemon.
 * `parsed` is already grammar-validated by the caller; this function owns all
 * credential/settings/cache/spawner resolution so the two entry points cannot
 * drift.
 */
export async function runProxyRuntime(parsed: ParsedArgs, options: ProxyRuntimeOptions = {}): Promise<number> {
  const daemonMode = options.daemon === true;
  const roleLabel = options.role === 'shift' ? 'owenloop shift' : 'owenloop work proxy';
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

  ensureStateDir(stateDir);
  {
    const liveRunIds = new Set(
      reconcileInFlight(stateDir).live.filter((r) => r.kind === 'agent-run').map((r) => r.run),
    );
    try {
      const retired = reconcileActiveSessions(sessionsPath(cacheDir), liveRunIds, Date.now());
      for (const rec of retired) {
        process.stderr.write(
          `${roleLabel}: retired orphaned session ${rec.workflow}/${rec.run} step '${rec.step}' ` +
            `(harness '${rec.harness}', attempt ${String(rec.attempt ?? 1)}) — its runner is gone, ` +
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
  const conductorId = `cnd_${randomUUID()}`;
  const startedAt = now();
  const name = resolveShiftName(parsed.name, { conductorId });
  const spawner = createDefaultSpawner(origin, account, undefined, conductorId);
  const pollIntervalMs = parsed.pollIntervalMs ?? DEFAULT_POLL_MS;

  let daemon: ShiftDaemon | undefined;
  const loop = createProxyLoop({
    hub,
    spawner,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    ...(daemonMode ? { onEvent: (event) => daemon?.onEvent(event) } : {}),
    cacheDir,
    stateDir,
    cap,
    servePools: parsed.servePools ?? [],
    name,
    commandRouting: settings.commandRouting,
    pollIntervalMs,
    presenceIntervalMs: DEFAULT_PRESENCE_MS,
    maxConcurrentAgents,
    workRoot,
    ...(workRepo !== undefined ? { workRepo } : {}),
    conductorId,
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
      conductorId,
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
    process.stdout.write(`owenloop work proxy: parked as '${name}' @ ${origin} (cap ${cap})\n`);
  }
  return loop.run();
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.error !== undefined) {
    process.stderr.write(`owenloop work proxy: ${parsed.error}\n`);
    usage();
    return 2;
  }
  if (args.some((arg) => arg === '--mcp' || arg.startsWith('--mcp='))) {
    process.stderr.write('owenloop work proxy: unknown option \'--mcp\'\n');
    usage();
    return 2;
  }
  return runProxyRuntime(parsed);
}
