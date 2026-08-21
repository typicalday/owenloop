/**
 * `owenloop work exec <order-id>` (C5) — the detached, self-leasing command worker.
 *
 * The shift (C3) spawns one detached `owenloop work exec <workflow>/<run> --origin
 * <url>` per COMMAND order. This process owns that order end to end: it takes the
 * lease on first contact, keeps it warm while it shells the order's `command`
 * out, and submits a receipt to every owed output path — then exits. It is the
 * one process in the system that actually executes an order's command string.
 *
 * The orchestration CORE lives in `src/exec/loop.ts` (lease + runner + receipt,
 * every side effect injected); this role only parses the arg contract, resolves
 * origin/token, builds the real hub client + default runner, tags the exec
 * holder identity, wires the signal seam, and maps the loop's `ExecOutcome` to an
 * exit code.
 *
 * ORDER ID: a positional `<workflow>/<run>` composite (or a bare `<run>` plus
 * `--workflow <wf>`), resolved by the same `resolveTarget` `hold` uses. The shift
 * always emits the composite form.
 *
 * HOLDER IDENTITY: every get_order/heartbeat rides the B3 holder tag
 * `{kind:'exec', id}` where id is `<hostname>:<pid>`. `kind:'exec'` is the drain
 * exemption (B3/C6): an exec-held claim survives a SESSION drain — only a signal
 * aimed at THIS process hands the order back. `--shift <cid>` (env fallback
 * `OWENLOOP_SHIFT_ID`), when known, rides along on the holder as
 * `shiftId` — self-declared and advisory only (D8/INV-82).
 *
 * Origin/credential resolution mirrors `hold`/`shift`: origin `--origin` →
 * settings; the bearer comes from owenloop's store via `resolveBearer`, reading
 * the `agent:<account>` slot for the account the shift set in this child's
 * `OWENLOOP_ACCOUNT` spawn env (default `default`), with `OWENLOOP_TOKEN` as a
 * documented dev-only override. Exec has NO `--as` flag — the spawn-env channel
 * is the contract. Exit codes are documented in `src/usage.ts`.
 */
import { hostname } from 'node:os';
import { join } from 'node:path';

import { createHubClient, type HubClient } from '../hub/client.ts';
import { resolveBearer } from '../credentials/resolve.ts';
import { resolveAllowedWorkdirRoots } from '../agent/workdir.ts';
import { loadSettings } from '../settings/settings.ts';
import { createExecLoop, type ExecOutcome } from '../exec/loop.ts';
import { createDefaultStoreInstructionResolver, type InstructionResolver } from '../exec/instructions.ts';
import { createHubBundleRecoveryHandler } from '../bundle/pull.ts';
import { createDefaultRunner, type CommandRunner } from '../exec/runner.ts';
import { createConsumedVerifier, type ConsumedVerifier } from '../consumed-verifier.ts';
import { resolveShiftId, resolveTarget } from './hold.ts';
import type { ContactHolder } from '../hub/types.ts';
import { installSignalHandlers, type SignalHost } from './signals.ts';

const DEFAULT_INTERVAL_MS = 60_000;

interface ParsedArgs {
  orderId?: string;
  workflow?: string;
  origin?: string;
  shift?: string;
  heartbeatIntervalMs?: number;
  jumpToleranceMs?: number;
  error?: string;
}

/**
 * Parse the positional `<order-id>` plus `--workflow`/`--origin`/
 * `--heartbeat-interval`/`--jump-tolerance`. Supports `--flag value` and
 * `--flag=value`; a second positional or an unknown flag is an error.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  const takeValue = (a: string, i: number): { value: string; next: number } | { error: string } => {
    const eq = a.indexOf('=');
    if (eq !== -1) return { value: a.slice(eq + 1), next: i };
    const v = args[i + 1];
    if (v === undefined) return { error: `missing value for ${a}` };
    return { value: v, next: i + 1 };
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) {
      if (parsed.orderId !== undefined) return { error: `unexpected extra argument '${a}'` };
      parsed.orderId = a;
      continue;
    }
    const name = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    switch (name) {
      case '--workflow':
      case '--origin':
      case '--shift':
      case '--heartbeat-interval':
      case '--jump-tolerance': {
        const r = takeValue(a, i);
        if ('error' in r) return { error: r.error };
        i = r.next;
        if (name === '--workflow') parsed.workflow = r.value;
        else if (name === '--origin') parsed.origin = r.value;
        else if (name === '--shift') parsed.shift = r.value;
        else if (name === '--heartbeat-interval') {
          const n = Number(r.value);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            return { error: `--heartbeat-interval must be a positive integer, got '${r.value}'` };
          }
          parsed.heartbeatIntervalMs = n;
        } else if (name === '--jump-tolerance') {
          const n = Number(r.value);
          if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
            return { error: `--jump-tolerance must be a positive integer, got '${r.value}'` };
          }
          parsed.jumpToleranceMs = n;
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
    'usage: owenloop work exec <workflow>/<run> [--origin <url>] [--shift <id>] [--heartbeat-interval <ms>] [--jump-tolerance <ms>]\n' +
      '   or: owenloop work exec <run> --workflow <wf> [...]\n',
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map the loop's outcome onto the process exit code (see usage.ts). */
export function exitCodeFor(outcome: ExecOutcome): number {
  switch (outcome) {
    case 'submitted':
    case 'completed':
    case 'rejected':
    case 'judge-rejected':
      return 0;
    case 'misroute':
    case 'workdir-denied':
    case 'unresolved-instructions':
    case 'killed':
    case 'lease-lost':
    case 'ownership-error':
    case 'hub-unreachable':
    case 'submit-rejected':
    case 'submit-failed':
    case 'command-failed':
    case 'ask-failed':
    case 'judge-no-verdict':
    case 'reject-failed':
    case 'stopped':
      return 1;
  }
}

/**
 * Injectable process-boundary deps for `run` — defaulting to the real ones, so
 * the role wiring (holder tag, signal handlers, outcome mapping) is testable
 * without spawning a real child, signaling the test process, or reaching a real
 * hub.
 */
export interface RunDeps {
  signalHost?: SignalHost;
  hub?: HubClient;
  runner?: CommandRunner;
  /** Store-backed instruction resolver; injected tests may provide a fake. */
  instructions?: InstructionResolver;
  /** Consume-side verifier; injected tests may provide a fake. */
  consumedVerifier?: ConsumedVerifier;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** cwd for a command order that carries no `workdir` (default `process.cwd()`). */
  cwd?: string;
  /** Environment used to derive the global workflow-store root. */
  env?: Record<string, string | undefined>;
  /** Holder id override (default `<hostname>:<pid>`) — pinned in tests. */
  holderId?: string;
}

export async function run(args: string[], deps: RunDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const parsed = parseArgs(args);
  if (parsed.error !== undefined) {
    err(`owenloop work exec: ${parsed.error}`);
    usage();
    return 2;
  }
  if (parsed.orderId === undefined || parsed.orderId === '') {
    err('owenloop work exec: missing required <order-id>');
    usage();
    return 2;
  }

  const target = resolveTarget(parsed.orderId, parsed.workflow);
  if ('error' in target) {
    err(`owenloop work exec: ${target.error}`);
    usage();
    return 2;
  }

  const env = deps.env ?? process.env;
  let settings;
  try {
    settings = loadSettings(env);
  } catch (e) {
    err(`owenloop work exec: ${errMsg(e)}`);
    return 1;
  }

  const consumedVerifier = deps.consumedVerifier ?? createConsumedVerifier({
    env,
    now: () => Date.now(),
  });

  const origin = parsed.origin ?? settings.hubOrigin;
  if (origin === undefined || origin.trim() === '') {
    err('owenloop work exec: no hub origin — pass --origin <url> or set hubOrigin in settings');
    return 2;
  }

  const cwd = deps.cwd ?? process.cwd();
  // Machine policy, resolved from the SAME two sources the shift resolves it
  // from: `OWENLOOP_ALLOWED_WORKDIR_ROOTS` (which `owenloop shift start` exports
  // when the operator passed `--work-root`) then the settings file. An
  // independently launched `owenloop work exec` therefore honours the settings
  // file on its own, with no shift involved.
  const allowedWorkdirRoots = resolveAllowedWorkdirRoots(env, settings.allowedWorkdirRoots, cwd);
  const account = env['OWENLOOP_ACCOUNT'] ?? 'default';
  const bearer = await resolveBearer({ origin, account, env });
  if (!bearer.ok) {
    err(`owenloop work exec: ${bearer.message}`);
    return bearer.code;
  }
  const token = bearer.token;

  let instructions = deps.instructions;
  if (instructions === undefined) {
    try {
      const home = [env.HOME, env.USERPROFILE].find(
	(value) => value !== undefined && value.trim() !== '',
      );
      if (home === undefined) throw new Error('cannot locate the global workflow store: set HOME or USERPROFILE');
      instructions = createDefaultStoreInstructionResolver({
	cwd,
	env,
	consumedVerifier,
	onMissing: createHubBundleRecoveryHandler({
	  origin,
	  token,
	  home,
	  projectRoot: join(cwd, 'workflows'),
	  env,
	  warn: (line) => err(`owenloop work exec: ${line}`),
	}),
      });
    } catch (e) {
      err(`owenloop work exec: instruction store unavailable: ${errMsg(e)}`);
      return 1;
    }
  }

  const shiftId = resolveShiftId(parsed.shift, env);
  const holder: ContactHolder = {
    kind: 'exec',
    id: deps.holderId ?? `${hostname()}:${process.pid}`,
    ...(shiftId !== undefined ? { shiftId } : {}),
  };
  const hub = deps.hub ?? createHubClient({ origin, getToken: async () => token });
  const runner = deps.runner ?? createDefaultRunner();

  const loop = createExecLoop({
    hub,
    runner,
    workflow: target.workflow,
    run: target.run,
    origin,
    env,
    holder,
    instructions,
    cwd,
    allowedWorkdirRoots,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    out,
    err,
    heartbeatIntervalMs: parsed.heartbeatIntervalMs ?? DEFAULT_INTERVAL_MS,
    // Test affordance only: exposes the lease loop's existing jumpToleranceMs
    // knob (default unchanged) so a drill can trip the clock-jump lease check
    // with a short freeze instead of a real >30s laptop sleep.
    ...(parsed.jumpToleranceMs !== undefined ? { jumpToleranceMs: parsed.jumpToleranceMs } : {}),
  });

  installSignalHandlers(loop, deps.signalHost ?? process, err, {
    role: 'exec',
    drainNote: 'killing the command and releasing the order',
    stopReason: 'signal',
  });

  const outcome = await loop.run();
  return exitCodeFor(outcome);
}
