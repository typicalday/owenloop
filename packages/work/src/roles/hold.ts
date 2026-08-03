/**
 * `owenloop work hold --order <id>` (C4) — keeps one order's lease alive on behalf
 * of an interactive session and performs the final-breath handoff when that
 * session goes away.
 *
 * It heartbeats the order's lease on a safe cadence (default 60s — well inside
 * the hub's reap TTL; no verb exposes the TTL, so the cadence is a client
 * constant) with jitter/backoff on transient failures, and on SIGINT, SIGTERM,
 * or stdin EOF performs a targeted `release` so the order re-offers immediately
 * instead of stranding until its lease expires. The loop CORE lives in
 * `src/hold/loop.ts` with every side effect injected; this role parses flags,
 * resolves origin/token, builds the real hub client, wires the signal + stdin
 * seams (`src/roles/signals.ts`), and maps the loop's `HoldOutcome` to an exit
 * code.
 *
 * SESSION IDENTITY: `--session <id>` (env fallback `OWENLOOP_SESSION`) rides
 * every get_order/heartbeat as the B3 holder tag `{kind:'session', id}`. A
 * holder is now ALWAYS sent (D5): when no session id is configured, `id`
 * falls back to `anon:<hostname>:<pid>` — never omitted. Only `kind:'session'`
 * — exec identity is C5's.
 *
 * SHIFT ATTRIBUTION: `--shift <cid>` (env fallback
 * `OWENLOOP_SHIFT_ID`), when known, rides along on the holder as
 * `shiftId` — self-declared and advisory only (D8/INV-82), never used for
 * authorization, routing, dispatch, or claim correctness.
 *
 * STDIN EOF: a live stdin pipe closing means the parent interactive session
 * died, so hold takes its final breath. When stdin is `/dev/null` or already
 * closed at spawn (backgrounded/detached use), pass `--ignore-stdin` so hold
 * does not final-breath at birth.
 *
 * Origin/credential resolution mirrors `shift`: origin `--origin` → settings;
 * the bearer comes from owenloop's store via `resolveBearer`, reading the
 * `agent:<account>` slot for `--as <account>` (default `default`, so a hand-run
 * hold and a shift-stamped `hold --as <account>` both work), with
 * `OWENLOOP_TOKEN` as a documented dev-only override. Exit codes are documented
 * in `src/usage.ts`.
 */
import { hostname } from 'node:os';

import { createHubClient, type HubClient } from '../hub/client.ts';
import { resolveBearer } from '../credentials/resolve.ts';
import { loadSettings } from '../settings/settings.ts';
import { createHoldLoop, type HoldOutcome } from '../hold/loop.ts';
import { createHoldMcp } from '../hold/mcp.ts';
import { createMcpServer, pumpStdin, type LineStream } from '../mcp/server.ts';
import type { ContactHolder } from '../hub/types.ts';
import { installSignalHandlers, watchStdinEof, type SignalHost, type StdinHost } from './signals.ts';

const DEFAULT_INTERVAL_MS = 60_000;
// Deliberate duplicate of main.ts's VERSION (also '0.0.0'): the roles must not
// import the CLI entry module, and the MCP serverInfo version is cosmetic.
const VERSION = '0.0.0';

interface ParsedArgs {
  order?: string;
  workflow?: string;
  session?: string;
  origin?: string;
  as?: string;
  shift?: string;
  heartbeatIntervalMs?: number;
  jumpToleranceMs?: number;
  ignoreStdin: boolean;
  mcp: boolean;
  error?: string;
}

/** Parse `--flag value` and `--flag=value`; unknown flags are an error. */
export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { ignoreStdin: false, mcp: false };
  const takeValue = (a: string, i: number): { value: string; next: number } | { error: string } => {
    const eq = a.indexOf('=');
    if (eq !== -1) return { value: a.slice(eq + 1), next: i };
    const v = args[i + 1];
    if (v === undefined) return { error: `missing value for ${a}` };
    return { value: v, next: i + 1 };
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    switch (name) {
      case '--ignore-stdin':
        parsed.ignoreStdin = true;
        break;
      case '--mcp':
        parsed.mcp = true;
        break;
      case '--order':
      case '--workflow':
      case '--session':
      case '--origin':
      case '--as':
      case '--shift':
      case '--heartbeat-interval':
      case '--jump-tolerance': {
        const r = takeValue(a, i);
        if ('error' in r) return { ignoreStdin: false, mcp: false, error: r.error };
        i = r.next;
        if (name === '--order') parsed.order = r.value;
        else if (name === '--workflow') parsed.workflow = r.value;
        else if (name === '--session') parsed.session = r.value;
        else if (name === '--origin') parsed.origin = r.value;
        else if (name === '--as') parsed.as = r.value;
        else if (name === '--shift') parsed.shift = r.value;
        else if (name === '--heartbeat-interval') {
          const n = Number(r.value);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            return { ignoreStdin: false, mcp: false, error: `--heartbeat-interval must be a positive integer, got '${r.value}'` };
          }
          parsed.heartbeatIntervalMs = n;
        } else if (name === '--jump-tolerance') {
          const n = Number(r.value);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            return { ignoreStdin: false, mcp: false, error: `--jump-tolerance must be a positive integer, got '${r.value}'` };
          }
          parsed.jumpToleranceMs = n;
        }
        break;
      }
      default:
        return { ignoreStdin: false, mcp: false, error: `unknown option '${a}'` };
    }
  }
  return parsed;
}

/** Both accepted `--order` forms, for usage messages. */
const ORDER_FORMS = '--order <workflow>/<run>  (or  --order <run> --workflow <wf>)';

/**
 * Resolve (workflow, run) from `--order` (+ optional `--workflow`).
 *  - composite `<workflow>/<run>`: split on the FIRST `/` only (run ids must
 *    not be silently truncated). A conflicting `--workflow` is a usage error.
 *  - bare `<run>`: requires `--workflow`.
 */
export function resolveTarget(order: string, workflowFlag?: string): { workflow: string; run: string } | { error: string } {
  const slash = order.indexOf('/');
  if (slash !== -1) {
    const workflow = order.slice(0, slash);
    const run = order.slice(slash + 1);
    if (workflow === '' || run === '') {
      return { error: `--order '${order}' is malformed — expected ${ORDER_FORMS}` };
    }
    if (workflowFlag !== undefined && workflowFlag !== workflow) {
      return { error: `--order carries workflow '${workflow}' but --workflow says '${workflowFlag}' — drop one` };
    }
    return { workflow, run };
  }
  if (workflowFlag === undefined || workflowFlag === '') {
    return { error: `--order '${order}' has no workflow — use ${ORDER_FORMS}` };
  }
  return { workflow: workflowFlag, run: order };
}

function usage(): void {
  process.stderr.write(
    'usage: owenloop work hold --order <workflow>/<run> [--origin <url>] [--as <account>] [--session <id>]\n' +
      '                     [--shift <id>] [--heartbeat-interval <ms>] [--jump-tolerance <ms>] [--ignore-stdin] [--mcp]\n' +
      '   or: owenloop work hold --order <run> --workflow <wf> [...]\n',
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve the born-bound `--shift` cid: explicit `--shift`, else env
 * `OWENLOOP_SHIFT_ID`, else `undefined` (no cid known — a hand-run hold
 * with no stamped/exported cid). Advisory only (D8/INV-82).
 */
export function resolveShiftId(shift: string | undefined, env: Record<string, string | undefined>): string | undefined {
  const id = shift ?? env['OWENLOOP_SHIFT_ID'];
  return id !== undefined && id !== '' ? id : undefined;
}

/**
 * Resolve the B3 session-holder tag (D5): explicit `--session`, else env
 * `OWENLOOP_SESSION`, else a per-process fallback `anon:<hostname>:<pid>` —
 * NEVER undefined. The fallback is deliberately unique per process (not a
 * shared constant like `'anon'`): `release --session <id>` drains match on
 * session id, and a shared constant would let unrelated Shifts' claims
 * collide in a drain. `opts.shiftId` rides along on the holder when known
 * (advisory only, D8/INV-82); `opts.hostname`/`opts.pid` are test seams.
 */
export function resolveHolder(
  session: string | undefined,
  env: Record<string, string | undefined>,
  opts: { shiftId?: string; hostname?: string; pid?: number } = {},
): ContactHolder {
  const configured = session ?? env['OWENLOOP_SESSION'];
  const id =
    configured !== undefined && configured !== '' ? configured : `anon:${opts.hostname ?? hostname()}:${opts.pid ?? process.pid}`;
  return {
    kind: 'session',
    id,
    ...(opts.shiftId !== undefined ? { shiftId: opts.shiftId } : {}),
  };
}

/** Map the loop's outcome onto the process exit code (see usage.ts). */
export function exitCodeFor(outcome: HoldOutcome): number {
  switch (outcome) {
    case 'completed':
    case 'released':
    case 'stopped':
      return 0;
    case 'ownership-error':
    case 'lease-lost':
    case 'hub-unreachable':
    case 'release-failed':
      return 1;
  }
}

/**
 * Injectable process-boundary deps for `run` — defaulting to the real ones.
 * Mirrors the loop's injected-seams pattern so the ROLE wiring (signal
 * handlers, stdin-EOF watcher, message lines) is testable without signaling
 * the test process, closing real stdin, or reaching a real hub.
 */
export interface RunDeps {
  signalHost?: SignalHost;
  stdin?: StdinHost;
  hub?: HubClient;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function run(args: string[], deps: RunDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const parsed = parseArgs(args);
  if (parsed.error !== undefined) {
    err(`owenloop work hold: ${parsed.error}`);
    usage();
    return 2;
  }
  if (parsed.order === undefined || parsed.order === '') {
    err('owenloop work hold: missing required --order <id>');
    usage();
    return 2;
  }
  // In --mcp mode stdin IS the JSON-RPC transport; its EOF is the session-death
  // signal that fires the final breath. --ignore-stdin (don't watch stdin) is
  // therefore contradictory.
  if (parsed.mcp && parsed.ignoreStdin) {
    err('owenloop work hold: --mcp and --ignore-stdin are mutually exclusive (stdin is the MCP transport)');
    usage();
    return 2;
  }

  const target = resolveTarget(parsed.order, parsed.workflow);
  if ('error' in target) {
    err(`owenloop work hold: ${target.error}`);
    usage();
    return 2;
  }

  const env = process.env;
  let settings;
  try {
    settings = loadSettings(env);
  } catch (e) {
    err(`owenloop work hold: ${errMsg(e)}`);
    return 1;
  }

  const origin = parsed.origin ?? settings.hubOrigin;
  if (origin === undefined || origin.trim() === '') {
    err('owenloop work hold: no hub origin — pass --origin <url> or set hubOrigin in settings');
    return 2;
  }

  if (parsed.as !== undefined && parsed.as.trim() === '') {
    err('owenloop work hold: --as requires a non-empty account name');
    return 2;
  }
  const account = parsed.as ?? 'default';
  const bearer = await resolveBearer({ origin, account, env });
  if (!bearer.ok) {
    err(`owenloop work hold: ${bearer.message}`);
    return bearer.code;
  }
  const token = bearer.token;

  const shiftId = resolveShiftId(parsed.shift, env);
  const holder = resolveHolder(parsed.session, env, { shiftId });

  const hub = deps.hub ?? createHubClient({ origin, getToken: async () => token });

  // --mcp: run the born-bound work-holder as a stdio MCP server (get_order /
  // submit) with the lease loop kept warm underneath. stdout is the JSON-RPC
  // channel, so every diagnostic (and the loop's own lines) goes to stderr;
  // stdin is the transport, and its EOF (the session died) fires the final
  // breath.
  if (parsed.mcp) {
    const mount = createHoldMcp({
      hub,
      workflow: target.workflow,
      run: target.run,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      err,
      holder,
      ...(parsed.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: parsed.heartbeatIntervalMs } : {}),
      ...(parsed.jumpToleranceMs !== undefined ? { jumpToleranceMs: parsed.jumpToleranceMs } : {}),
    });
    const server = createMcpServer({
      name: 'owenloop-hold',
      version: VERSION,
      tools: mount.tools,
      write: (msg) => void process.stdout.write(`${JSON.stringify(msg)}\n`),
      err,
    });
    installSignalHandlers(mount.loop, deps.signalHost ?? process, err, {
      role: 'hold',
      drainNote: 'final breath',
      stopReason: 'signal',
    });
    // The MCP server must keep answering until the TRANSPORT ends, not until
    // the lease loop does (plan section 4): a submit that closes the run
    // terminates the loop, but the submit's own response frame may still be
    // racing down the stdout pipe and the client may issue further calls (they
    // fast-fail via the mount's terminal guard). So: stdin EOF is both the
    // final-breath trigger AND the exit condition; the loop's outcome only
    // decides the exit code. A signal stops the loop early too — the process
    // then serves fast-fails until the parent closes the pipe (a second signal
    // still hard-exits via installSignalHandlers).
    const stdin = (deps.stdin ?? process.stdin) as unknown as LineStream;
    const eof = new Promise<void>((resolve) => {
      pumpStdin(stdin, server, () => {
        mount.loop.stop('stdin-eof');
        resolve();
      });
    });
    const outcome = await mount.loop.run();
    await eof;
    return exitCodeFor(outcome);
  }

  const loop = createHoldLoop({
    hub,
    workflow: target.workflow,
    run: target.run,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    out,
    err,
    heartbeatIntervalMs: parsed.heartbeatIntervalMs ?? DEFAULT_INTERVAL_MS,
    // Test affordance only: exposes the lease loop's existing jumpToleranceMs
    // knob (default unchanged) so a drill can trip the clock-jump lease check
    // with a short freeze instead of a real >30s laptop sleep.
    ...(parsed.jumpToleranceMs !== undefined ? { jumpToleranceMs: parsed.jumpToleranceMs } : {}),
    holder,
  });

  installSignalHandlers(loop, deps.signalHost ?? process, err, {
    role: 'hold',
    drainNote: 'final breath',
    stopReason: 'signal',
  });
  if (!parsed.ignoreStdin) {
    watchStdinEof(deps.stdin ?? process.stdin, () => loop.stop('stdin-eof'));
  }

  const outcome = await loop.run();
  return exitCodeFor(outcome);
}
