/**
 * `owenloop work proxy` — the standing Conductor loop (C3).
 *
 * Parks at the hub: short-polls the B5 `wake` endpoint, sweeps `whats_next`
 * only when something changed and there is free dispatch capacity, and spawns
 * ONE detached child per order — `owenloop work exec <run>` for a command step,
 * `owenloop work agent-run <run>` for an agent step — metering at `cap − in-flight`
 * (default 3) and refreshing Conductor presence on its cadence. It makes no
 * `get_order` first contact and holds no leases; the spawned child does that.
 * Clean shutdown on SIGINT/SIGTERM (in-flight sweep finishes; detached children
 * keep running — that is the drain semantic).
 *
 * The loop CORE lives in `src/proxy/loop.ts` with every side effect injected;
 * this role only parses flags, resolves settings/origin/account/dirs, builds the
 * real hub client + default spawner, wires the signal handlers, and returns the
 * loop's exit code. D2 mounts the same core behind stdio-MCP tools.
 *
 * Resolution mirrors `prepare`: origin `--origin` → `settings.hubOrigin`; the
 * bearer comes from owenloop's store via `resolveBearer` — it reads the
 * `agent:<account>` slot for the account selected by `--as` (default `default`),
 * with `OWENWORK_TOKEN` as a documented dev-only override. The proxy is the ONE
 * `--as` surface: it resolves the account once and threads it into the spawned
 * child's env (`OWENWORK_ACCOUNT`), so `exec` and `agent-run` children alike read
 * the slot the proxy picked. Exit codes: 0 clean shutdown · 1 runtime failure ·
 * 2 usage error (C1 contract).
 *
 * PRESENCE NAME (shifts.md §6): the hub keys a presence row by (principal,
 * name), so the default name is SESSION-UNIQUE — `<hostname>/<cwd
 * basename>#<short cid>` (`resolveShiftName`) — one row per shift, not one row
 * per machine+directory that concurrent shifts would overwrite in turns. An
 * explicit `--name` still wins verbatim. In `--mcp` mode the `clock_in` tool
 * (`src/proxy/mcp.ts`) can change the live name/scope after boot; these
 * startup log lines are stale after that by design.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename } from 'node:path';

import { createHubClient } from '../hub/client.ts';
import { resolveBearer } from '../credentials/resolve.ts';
import { loadSettings } from '../settings/settings.ts';
import { resolveCacheDir } from '../bundle/cache.ts';
import { createProxyLoop } from '../proxy/loop.ts';
import { buildProxyTools } from '../proxy/mcp.ts';
import { createDefaultSpawner } from '../proxy/spawn.ts';
import { resolveStateDir, ensureStateDir, reconcileInFlight } from '../proxy/state.ts';
import { reconcileActiveSessions, sessionsPath } from '../harness/session-store.ts';
import { resolveWorkRepo, resolveWorkRoot } from '../agent/workdir.ts';
import { createMcpServer, pumpStdin, type LineStream } from '../mcp/server.ts';
import { installSignalHandlers, type SignalHost } from './signals.ts';
import { resolveHolder } from './hold.ts';

// Deliberate duplicate of main.ts's VERSION (also '0.0.0'): the roles must not
// import the CLI entry module, and the MCP serverInfo version is cosmetic.
const VERSION = '0.0.0';

// Re-exported so existing importers (proxy-loop.test.ts) keep their import site
// while the implementation lives in the shared `signals.ts` seam (C4).
export { installSignalHandlers, type SignalHost };

const DEFAULT_CAP = 3;
const DEFAULT_POLL_MS = 5_000;

/**
 * Dispatch-cap precedence: `--cap` > `settings.dispatchCap` > built-in default.
 * A CLI flag or the settings-file value always wins over the default of 3.
 */
export function resolveCap(flagCap: number | undefined, settingsCap: number | undefined): number {
  return flagCap ?? settingsCap ?? DEFAULT_CAP;
}

/**
 * State-dir override precedence: `--state-dir` > env `OWENWORK_STATE_DIR` >
 * `settings.stateDir`. Returns `undefined` when none is set, letting
 * `resolveStateDir` fall through to its XDG/HOME default.
 */
export function resolveStateDirOverride(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  settingsStateDir: string | undefined,
): string | undefined {
  return flag ?? env['OWENWORK_STATE_DIR'] ?? settingsStateDir;
}
const DEFAULT_MAX_AGENTS = 4;

/**
 * Agent-cap precedence: `--max-agents` > `settings.maxConcurrentAgents` >
 * built-in 4. A SEPARATE budget from `resolveCap`'s exec cap; the two never
 * borrow from each other.
 */
export function resolveMaxConcurrentAgents(
  flagMax: number | undefined,
  settingsMax: number | undefined,
): number {
  return flagMax ?? settingsMax ?? DEFAULT_MAX_AGENTS;
}

/**
 * The shift's presence name. An explicit `--name` wins verbatim. The DEFAULT is
 * session-unique: `<hostname>/<cwd-basename>#<short>`, where <short> is the first
 * 6 hex chars of this process's `cnd_` incarnation id. The hub keys presence rows
 * by (principal, name), so two sessions in ONE directory under ONE identity must
 * NOT resolve to one name — that is the shifts.md §6 defect this fixes.
 * `hostname` / `cwd` / `pid` are test seams.
 */
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

const DEFAULT_PRESENCE_MS = 60_000;

export interface ParsedArgs {
  origin?: string;
  as?: string;
  name?: string;
  servePools?: string[];
  cap?: number;
  workflow?: string;
  pollIntervalMs?: number;
  once?: boolean;
  mcp?: boolean;
  maxAgents?: number;
  cacheDir?: string;
  stateDir?: string;
  error?: string;
}

/** Parse `--flag value` and `--flag=value` forms; unknown flags are an error. */
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
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { error: `${flag} must be a non-negative integer, got '${raw}'` };
    return n;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    switch (name) {
      case '--once':
        parsed.once = true;
        break;
      case '--mcp':
        parsed.mcp = true;
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
          // D8: an empty --name would otherwise reach the hub and fail on the
          // first ping, up to 60s later — reject it here instead, at parse time.
          if (r.value.trim() === '') return { error: '--name requires a non-empty value' };
          parsed.name = r.value;
        }
        else if (name === '--serve-pools') parsed.servePools = r.value.split(',').map((s) => s.trim()).filter((s) => s !== '');
        else if (name === '--workflow') parsed.workflow = r.value;
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
      '                      [--workflow <id>] [--poll-interval <ms>] [--once] [--mcp]\n' +
      '                      [--max-agents <n>] [--cache-dir <p>] [--state-dir <p>]\n',
  );
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.error !== undefined) {
    process.stderr.write(`owenloop work proxy: ${parsed.error}\n`);
    usage();
    return 2;
  }
  // --once (bootstrap one sweep, then exit) and --mcp (a standing stdio-MCP park
  // driven on demand by a Conductor) are contradictory dispatch modes.
  if (parsed.mcp === true && parsed.once === true) {
    process.stderr.write('owenloop work proxy: --mcp and --once are mutually exclusive\n');
    usage();
    return 2;
  }

  const env = process.env;
  let settings;
  try {
    settings = loadSettings(env);
  } catch (err) {
    process.stderr.write(`owenloop work proxy: ${errMsg(err)}\n`);
    return 1;
  }

  const origin = parsed.origin ?? settings.hubOrigin;
  if (origin === undefined || origin.trim() === '') {
    process.stderr.write('owenloop work proxy: no hub origin — pass --origin <url> or set hubOrigin in settings\n');
    return 2;
  }

  // The account selects which agent slot to read AND is threaded, unchanged,
  // into the spawned child's env (`OWENWORK_ACCOUNT`), so every dispatched child
  // reads the SAME credential slot the proxy selected via `--as`.
  if (parsed.as !== undefined && parsed.as.trim() === '') {
    process.stderr.write('owenloop work proxy: --as requires a non-empty account name\n');
    return 2;
  }
  const account = parsed.as ?? 'default';

  const bearer = await resolveBearer({ origin, account, env });
  if (!bearer.ok) {
    process.stderr.write(`owenloop work proxy: ${bearer.message}\n`);
    return bearer.code;
  }
  const token = bearer.token;

  let cacheDir: string;
  let stateDir: string;
  try {
    cacheDir = parsed.cacheDir ?? resolveCacheDir(env, settings.cacheDir);
    // Dir precedence: flag > env > settings > XDG/built-in default.
    stateDir = resolveStateDir(env, resolveStateDirOverride(parsed.stateDir, env, settings.stateDir));
  } catch (err) {
    process.stderr.write(`owenloop work proxy: ${errMsg(err)}\n`);
    return 1;
  }

  // ── PHASE 6, ITEM 4: crash reconcile, ONCE, at boot ────────────────────────
  //
  // `src/agent/loop.ts` writes `status: 'active'` when a turn starts and rewrites
  // it at turn end. A runner killed mid-turn — SIGKILL, a panic, a reboot — never
  // reaches the rewrite, so the store keeps claiming a turn is in flight when no
  // process exists. This is the only place that corrects it.
  //
  // BOOT, NOT PER-ITERATION. A sweep on every loop pass would race a child that
  // has been spawned but has not yet written its first session record: the
  // proxy's own state-dir record appears at spawn, but there is a window in which
  // the session row is `active` and the run looks live only by that record. At
  // boot the question is unambiguous — anything `active` whose runner is not in
  // the state dir died with the last incarnation.
  //
  // THIS IS BEFORE THE LOOP IS BUILT and covers BOTH dispatch modes (`--mcp`,
  // which never calls `loop.run()`, and the normal park), because a crash does
  // not care which mode the next proxy comes back in.
  //
  // Retirements are logged to STDERR unconditionally: in `--mcp` mode stdout is
  // the JSON-RPC transport and a stray line there corrupts the protocol frame.
  ensureStateDir(stateDir);
  {
    // The same expression `reapWorkDirs` uses in `src/proxy/loop.ts`: only
    // `agent-run` children own a session, so only their run ids count as live.
    const liveRunIds = new Set(
      reconcileInFlight(stateDir).live.filter((r) => r.kind === 'agent-run').map((r) => r.run),
    );
    try {
      const retired = reconcileActiveSessions(sessionsPath(cacheDir), liveRunIds, Date.now());
      for (const rec of retired) {
        process.stderr.write(
          `owenloop work proxy: retired orphaned session ${rec.workflow}/${rec.run} step '${rec.step}' ` +
            `(harness '${rec.harness}', attempt ${String(rec.attempt ?? 1)}) — its runner is gone, ` +
            'so the next attempt replays cold\n',
        );
      }
    } catch (err) {
      // FAIL-OPEN, and only here. `reconcileActiveSessions` propagates because
      // its other potential caller (the work-dir reaper) must not delete a
      // directory whose sessions it failed to retire. Boot has no such coupling:
      // an unwritable session store is a reason to log and park, not a reason to
      // refuse to serve orders at all.
      process.stderr.write(`owenloop work proxy: session reconcile failed (continuing): ${errMsg(err)}\n`);
    }
  }

  const cap = resolveCap(parsed.cap, settings.dispatchCap);
  const maxConcurrentAgents = resolveMaxConcurrentAgents(parsed.maxAgents, settings.maxConcurrentAgents);
  // PHASE 4: the same two values `agent-run` resolves, so the process that
  // CREATES a work directory and the process that REMOVES it agree on the root.
  // There is no proxy flag for either — a divergence between the two would be a
  // proxy deleting directories the runner is still filling.
  const workRoot = resolveWorkRoot(env, settings.workRoot, cacheDir);
  const workRepo = resolveWorkRepo(env, settings.workRepo);

  const hub = createHubClient({ origin, getToken: async () => token });

  // W7: this Conductor process incarnation's self-declared id + start time —
  // generated once per process, never persisted (D1), carried on presence
  // pings and carried into every holder/order this Conductor dispatches
  // (advisory only, D8/INV-82). The proxy has no session concept, so its own
  // submit-path holder is built here too (resolveHolder(undefined, ...) falls
  // back to the D5 anon:<hostname>:<pid> id).
  const now = () => Date.now();
  const conductorId = `cnd_${randomUUID()}`;
  const startedAt = now();
  // Session-unique default name (shifts.md §6): an explicit --name wins
  // unchanged; otherwise the name carries this process's conductorId suffix so
  // two sessions in ONE directory under ONE identity get DISTINCT presence rows.
  const name = resolveShiftName(parsed.name, { conductorId });
  const holder = resolveHolder(undefined, env, { conductorId });
  const spawner = createDefaultSpawner(origin, account, undefined, conductorId);

  // In --mcp mode stdout is the JSON-RPC transport, so the loop's own out lines
  // MUST go to stderr; otherwise they frame-corrupt the protocol channel.
  const pollIntervalMs = parsed.pollIntervalMs ?? DEFAULT_POLL_MS;
  const loop = createProxyLoop({
    hub,
    spawner,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now,
    out: (line) => process[parsed.mcp === true ? 'stderr' : 'stdout'].write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
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

  installSignalHandlers(loop, process, (line) => process.stderr.write(`${line}\n`));

  // --mcp: mount the SAME loop core behind a stdio-MCP server. The loop is
  // driven on demand by the Conductor's tool calls (whats_next parks via
  // iterate()); we do NOT call loop.run(). The process stays alive on stdin (the
  // transport) and exits on its EOF.
  if (parsed.mcp === true) {
    ensureStateDir(stateDir);
    const server = createMcpServer({
      name: 'owenwork-proxy',
      version: VERSION,
      tools: buildProxyTools({
        loop,
        hub,
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        now,
        pollIntervalMs,
        holder,
        conductorId,
      }),
      write: (msg) => void process.stdout.write(`${JSON.stringify(msg)}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
    process.stderr.write(`owenloop work proxy: stdio-MCP mount '${name}' @ ${origin} (cap ${cap})\n`);
    await new Promise<void>((resolve) => {
      pumpStdin(process.stdin as unknown as LineStream, server, () => {
        loop.stop();
        resolve();
      });
    });
    return 0;
  }

  if (parsed.once !== true) {
    process.stdout.write(`owenloop work proxy: parked as '${name}' @ ${origin} (cap ${cap})\n`);
  }
  return loop.run();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
