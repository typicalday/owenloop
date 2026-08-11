/**
 * The detached-exec spawn seam (plan decision 6).
 *
 * Every order the shift dispatches becomes a DETACHED
 * `owenloop work exec <workflow>/<run> --origin <url>` child: `detached: true`,
 * all stdio ignored, `unref()` — so the child is its own process-group leader and
 * survives the parent's death (SP5-verified kernel reparenting). The shift meters
 * and hands off; the child self-leases (C5). Both ids ride the argv as the
 * composite `<workflow>/<run>` order-id `owenloop work exec` parses, and `--origin`
 * is passed through so the detached child reaches the SAME hub the shift is
 * parked at without re-reading settings. The shift-resolved account rides the
 * child's spawn ENV as `OWENLOOP_ACCOUNT` (exec has no `--as` flag — the spawn
 * env is the contract), selecting which Scoped Identity credential slot
 * (agent:<account>) exec reads.
 *
 * `Spawner` is an injected seam; most loop tests fake it. The default impl's
 * argv/option construction is factored into the pure `buildSpawnPlan`, while a
 * focused lifecycle regression uses harmless local children.
 */
import { spawn } from 'node:child_process';

import { resolveOwenloopBin } from '../owenloop-bin.ts';

export { resolveOwenloopBin } from '../owenloop-bin.ts';

/**
 * What to spawn: the order to run. `run` IS the order id (hub verb contract);
 * `workflow` pairs with it (every hub verb needs both). The hub `origin` is NOT
 * here — it is captured by `createDefaultSpawner` (one hub per shift), so the
 * loop, which knows only the order, calls the seam without carrying it.
 */
export interface SpawnSpec {
  workflow: string;
  run: string;
  /** Step name, carried only for safe local lifecycle reporting. */
  step?: string;
  /**
   * Which role the detached child runs (Phase 3). Absent ⇒ `'exec'`, so every
   * pre-Phase-3 caller and every faked spawner in the existing tests keeps its
   * exact meaning.
   *
   *  - `'exec'`     — a COMMAND order; the child runs `owenloop work exec`.
   *  - `'agent-run'` — an AGENT order; the child runs `owenloop work agent-run` and
   *    hosts the step agent itself. This is the ONLY agent path.
   */
  kind?: 'exec' | 'agent-run';
  /**
   * Optional safe lifecycle-reporting label for an `agent-run` child. This field
   * never becomes `--harness`; the child resolves the authoritative harness from
   * CLI/environment/verified runtime definition precedence.
   */
  harness?: string;
  /** Closed start gate created by the durable Shift reservation. */
  startGate?: string;
}

/** The result the loop records plus a best-effort pre-start termination handle. */
export interface SpawnResult {
  pid: number;
  terminate?: () => void;
}

/** The spawn seam. Injected; faked in tests. */
export type Spawner = (spec: SpawnSpec) => SpawnResult;

/** Safe, bounded metadata emitted when a detached worker fails. Detached
 * worker stderr is not attached to Shift: agent-run output is untrusted, and a
 * parent-owned pipe can kill either worker with EPIPE after Shift exits. */
export interface WorkerFailure {
  workflow: string;
  run: string;
  step?: string;
  kind: 'exec' | 'agent-run';
  harness?: string;
  executable: string;
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  message: string;
}

export type WorkerFailureReporter = (failure: WorkerFailure) => void;

/** The fully-resolved spawn arguments — pure data, asserted directly in tests. */
export interface SpawnPlan {
  command: string;
  args: string[];
  options: { detached: true; stdio: ['ignore', 'ignore', 'ignore']; env: NodeJS.ProcessEnv };
}

/**
 * Build the argv + options for a detached
 * `owenloop work exec <workflow>/<run> --origin <url>`. Pure — no spawn, no I/O — so
 * tests assert the shape without launching anything. Runs the bin under the
 * current Node (`execPath`), matching the `owenloop work exec <order-id>` arg contract
 * (the composite `<workflow>/<run>` carries both ids in one positional).
 *
 * The account is NOT an argv flag — it rides `options.env.OWENLOOP_ACCOUNT`.
 * `env` starts from `process.env` so the detached child keeps the parent's
 * environment inheritance (which is otherwise implicit when `env` is unset),
 * then sets the resolved account on top.
 *
 * `shiftId` (W7, trailing — after `execPath` so existing positional
 * callers are unaffected), when non-empty, appends `--shift <cid>` so the
 * spawned `owenloop work exec` child self-declares which Shift dispatched it
 * (advisory only, D8/INV-82). Omitted/empty carries no flag at all.
 *
 * Phase 3 (D6) widens this ONE seam rather than adding a second: `spec.kind`
 * selects the role positional (`exec` vs `agent-run`). Everything else — the
 * composite order positional, `--origin`, `--shift`, and every spawn option
 * — is identical for both kinds, so an agent-run child is detached,
 * stdio-ignored, and account-scoped exactly like an exec child.
 *
 * The Shift never emits `--harness`. A prepared-cache step is dispatch metadata,
 * not an operator override; the `agent-run` child resolves its authoritative
 * inputs in precedence order (`--harness`, `OWENLOOP_HARNESS`, verified runtime
 * step, registered default). The Shift command has no operator-facing harness
 * flag, so there is no legitimate CLI override for this seam to carry.
 */
export function buildSpawnPlan(
  spec: SpawnSpec,
  origin: string,
  account: string,
  binPath: string,
  execPath: string = process.execPath,
  shiftId?: string,
): SpawnPlan {
  const role = spec.kind === 'agent-run' ? 'agent-run' : 'exec';
  return {
    command: execPath,
    args: [
      binPath,
      'work',
      role,
      `${spec.workflow}/${spec.run}`,
      '--origin',
      origin,
      ...(shiftId !== undefined && shiftId !== '' ? ['--shift', shiftId] : []),
    ],
    options: {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
	...process.env,
	OWENLOOP_ACCOUNT: account,
	...(spec.startGate !== undefined ? { OWENLOOP_START_GATE: spec.startGate } : {}),
      },
    },
  };
}

/**
 * The default detached spawner. Captures the resolved hub `origin`, the
 * resolved `account`, the packaged bin path, and the dispatching Shift's
 * `shiftId` once at construction; each spawn threads them into the
 * child's argv + spawn env. `execPath` is passed explicitly (rather than
 * relying on `buildSpawnPlan`'s default) so `shiftId` — trailing after it
 * — can be supplied positionally.
 */
export function createDefaultSpawner(
  origin: string,
  account: string,
  binPath: string = resolveOwenloopBin(),
  shiftId?: string,
  onFailure?: WorkerFailureReporter,
): Spawner {
  return (spec: SpawnSpec): SpawnResult => {
    const plan = buildSpawnPlan(spec, origin, account, binPath, process.execPath, shiftId);
    const child = spawn(plan.command, plan.args, plan.options);
    const kind = spec.kind === 'agent-run' ? 'agent-run' : 'exec';
    const harness = kind === 'agent-run'
      ? (spec.harness ?? process.env['OWENLOOP_HARNESS'] ?? 'auto')
      : undefined;
    // This process is the executable Shift actually launched. The harness may
    // start its own vendor process later, but reporting or guessing that
    // executable here would couple the neutral dispatcher to one adapter.
    const executable = `${process.execPath} ${binPath}`;
    // No worker stdio slot is a parent-owned pipe. Once Shift exits, a detached
    // worker may keep writing diagnostics without receiving EPIPE from a vanished
    // reader. Agent-run stderr is untrusted; exec failures therefore use the same
    // bounded generic lifecycle message rather than capturing worker output.
    let failureReported = false;
    const report = (exitStatus: number | null, signal: NodeJS.Signals | null, message: string): void => {
      if (failureReported || onFailure === undefined) return;
      failureReported = true;
      onFailure({
	workflow: spec.workflow,
	run: spec.run,
	...(spec.step !== undefined ? { step: spec.step } : {}),
	kind,
	...(harness !== undefined ? { harness } : {}),
	executable,
	exitStatus,
	signal,
	message,
      });
    };
    child.once('error', () => report(null, null, 'worker process failed to start'));
    child.once('exit', (code, signal) => {
      if (code === 0) return;
      report(code, signal, 'worker exited without completing successfully');
    });
    child.unref();
    if (child.pid === undefined) {
      // A synchronous spawn failure leaves no pid AND makes Node emit `error` on
      // a later tick (verified on node v22: `pid` undefined, events `error` then
      // `close`, no `exit`). The spawned COMMAND here is always
      // `process.execPath`, never `binPath`, so the trigger is not a missing bin
      // — it is resource exhaustion in the Shift itself (EMFILE from too many
      // concurrent children, ENOMEM), which is exactly the condition a busy
      // dispatcher hits. Throwing is what the caller sees, and
      // `createShiftLoop.dispatchCandidate` already turns that throw into one
      // `failed` event. Latch the reporter closed first, or the `error` handler
      // registered above fires afterwards and emits a SECOND `failed` event —
      // two daemon events for one dispatch attempt.
      failureReported = true;
      throw new Error(`spawn of 'owenloop work ${kind} ${spec.workflow}/${spec.run}' returned no pid`);
    }
    return {
      pid: child.pid,
      terminate: () => {
	try {
	  child.kill('SIGTERM');
	} catch {
	  // The child may already have exited after a cancelled or missing gate.
	}
      },
    };
  };
}
