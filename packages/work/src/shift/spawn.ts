/**
 * The detached-exec spawn seam (plan decision 6).
 *
 * Every order the shift dispatches becomes a DETACHED
 * `owenloop work exec <workflow>/<run> --origin <url>` child: `detached: true`,
 * stdin ignored, stdout and stderr appended to `<log-dir>/<run>.log` when the
 * shift resolved a log directory (and ignored when it did not), `unref()` — so
 * the child is its own process-group leader and
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
import { closeSync, openSync } from 'node:fs';

import { resolveOwenloopBin } from '../owenloop-bin.ts';
import { runLogFile } from './logretention.ts';

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
   *
   * It is ONE INPUT to the reported label, not the label itself, and it is the
   * LOWER-ranked one: `reportedHarnessId` puts the child's `OWENLOOP_HARNESS`
   * above it, because the child does.
   */
  harness?: string;
  /** Closed start gate created by the durable Shift reservation. */
  startGate?: string;
}

/** The result the loop records plus best-effort pre-start cancellation handles. */
export interface SpawnResult {
  pid: number;
  /**
   * Dispatcher-owned cancellation. The default spawner disarms spontaneous
   * lifecycle reporting before sending SIGTERM, so one failed dispatch emits
   * one Shift failure event.
   */
  cancel?: () => void;
  /** Legacy injected-spawner compatibility. New dispatcher code prefers cancel. */
  terminate?: () => void;
}

/** The spawn seam. Injected; faked in tests. */
export type Spawner = (spec: SpawnSpec) => SpawnResult;

/**
 * Where a detached worker's own stdout and stderr are appended, when the shift
 * has a log directory. `dir` absent ⇒ workers stay `stdio: ['ignore','ignore',
 * 'ignore']`, exactly as before this option existed.
 */
export interface WorkerLogOptions {
  /** The resolved log directory. `<dir>/<run>.log` is the destination. */
  dir: string;
  /** One-time failure report sink for a log that could not be opened. */
  err?: (line: string) => void;
}

/**
 * Open one worker's log for appending, or give up and return `undefined`.
 *
 * A LOG THAT WILL NOT OPEN MUST NEVER FAIL AN ORDER. A full disk, a read-only
 * directory, or a path an operator deleted underneath the shift costs
 * observability for that worker and nothing else: the caller falls back to
 * `'ignore'` on slots 1 and 2 and dispatches anyway.
 *
 * `report` is the caller's LATCHED sink — see `createDefaultSpawner`. This
 * function reports on every failure it sees; the latch that turns that into one
 * line per shift lives with the spawner, which is the thing whose lifetime the
 * latch is scoped to.
 *
 * MODE 0600, OWNER ONLY. A worker runs authored workflow content, so its
 * stdout and stderr are attacker-influenceable data and may contain whatever a
 * step printed — including a token a step echoed. `exec/loop.ts` already writes
 * its agent-produced artifact JSON with `mode: 0o600` for exactly this reason;
 * a raw worker log is the same data class and strictly less filtered. Without
 * an explicit mode `openSync` creates 0666 & ~umask, which is 0644 under the
 * usual 022 — readable by every local account.
 *
 * THE MODE APPLIES ONLY WHEN THE FILE IS CREATED. Append mode never re-chmods,
 * so a `<run>.log` left behind by a build from before this became explicit
 * keeps its old permissions. That is deliberate: silently tightening a file an
 * operator may have already handed to an uploader account is a worse surprise
 * than a stale-permission file the operator can fix with one `chmod`.
 */
function openWorkerLog(path: string, report: (line: string) => void): number | undefined {
  try {
    return openSync(path, 'a', 0o600);
  } catch (e) {
    report(
      `owenloop shift: could not open worker log ${path}: ${err(e)} — dispatching with its output discarded`,
    );
    return undefined;
  }
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Safe, bounded metadata emitted when a detached worker fails. Detached
 * worker stderr is not attached to Shift as a PIPE: agent-run output is
 * untrusted, and a parent-owned pipe can kill either worker with EPIPE after
 * Shift exits. It is appended to a per-run FILE instead — see
 * `createDefaultSpawner`. */
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

/**
 * The harness id to REPORT on an agent-run worker failure — a best-effort
 * mirror of the id the CHILD resolved, never an independent decision.
 *
 * It mirrors `resolveAdapter` in `roles/agent-run.ts`, minus the `--harness`
 * rank the Shift never emits:
 *
 *   1. `OWENLOOP_HARNESS` when the variable is SET. Set-but-blank is not a
 *      fall-through: the child refuses that config outright and names it
 *      `<empty OWENLOOP_HARNESS>`, so the failure event says the same thing.
 *   2. `spec.harness` — the prepared-cache step's `harness` field — when it is
 *      a non-empty string. An empty string counts as absent, matching the
 *      child.
 *   3. Otherwise the child took the first REGISTERED adapter. This process
 *      cannot name it: the Shift is a neutral dispatcher and never imports the
 *      adapter composition root, so its own registry is empty and asking it
 *      would answer `undefined`. Report the placeholder instead.
 *
 * WHY THE ORDER MATTERS. It used to read `spec.harness ?? OWENLOOP_HARNESS`,
 * which is the child's precedence INVERTED. An operator who pinned
 * `OWENLOOP_HARNESS` on a shift whose cached step also named a harness got a
 * failure event naming the harness that did NOT run — the single most
 * misleading field in the record, since the harness is the first thing an
 * operator reaches for when a worker dies.
 *
 * BEST-EFFORT IS DELIBERATE at rank 2. A modern agent order carries no
 * `spec.harness` at all (the child reads the verified, order-pinned step), so
 * rank 2 only ever fires on the legacy cache path. The alternative — the Shift
 * verifying the order digest itself purely to label a failure — would duplicate
 * the child's whole resolution for a diagnostic string.
 *
 * `env` is the environment the CHILD is spawned with (`plan.options.env`), not
 * this process's — they differ, and the child's is the one that decided.
 */
export function reportedHarnessId(
  spec: Pick<SpawnSpec, 'harness'>,
  env: NodeJS.ProcessEnv,
): string {
  const fromEnv = env['OWENLOOP_HARNESS'];
  if (fromEnv !== undefined) return fromEnv.trim() === '' ? '<empty OWENLOOP_HARNESS>' : fromEnv;
  if (spec.harness !== undefined && spec.harness !== '') return spec.harness;
  return '<registered default>';
}

/**
 * The stdio topology of a detached worker.
 *
 * Slot 0 is always `'ignore'`: a worker reads nothing. Slots 1 and 2 are either
 * both `'ignore'` (no log destination resolved, or opening it failed) or both
 * the SAME descriptor number — one file opened once and handed to stdout and
 * stderr together, which is exactly shell `2>&1`.
 */
export type WorkerStdio = ['ignore', 'ignore', 'ignore'] | ['ignore', number, number];

/** The fully-resolved spawn arguments — pure data, asserted directly in tests. */
export interface SpawnPlan {
  command: string;
  args: string[];
  options: { detached: true; stdio: WorkerStdio; env: NodeJS.ProcessEnv };
  /**
   * Absolute path this worker's stdout and stderr should be appended to, when a
   * log directory is configured. A PATH, never a descriptor: `buildSpawnPlan`
   * stays pure, and `createDefaultSpawner` does the opening.
   */
  logFile?: string;
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
 *
 * `allowedWorkdirRoots` (trailing, for the same reason) rides the child's spawn
 * env as `OWENLOOP_ALLOWED_WORKDIR_ROOTS`, a `:`-separated list — the same
 * "spawn env is the contract" shape as `OWENLOOP_ACCOUNT`, and for the same
 * reason: neither `owenloop work exec` nor `owenloop work agent-run` has an
 * operator-facing flag for it. It carries the roots the SHIFT resolved, so an
 * operator's `owenloop shift start --work-root` reaches a detached child that
 * would otherwise only see the settings file. Empty or omitted sets no variable
 * at all, so the child falls through to its own settings-file resolution and
 * the plan stays byte-identical to the pre-policy shape.
 *
 * `logDir` (trailing, after `shiftId`, for the same reason) adds the worker's
 * log DESTINATION to the plan as `<logDir>/<run>.log`. The plan still carries
 * `stdio: ['ignore','ignore','ignore']`: opening the file is I/O, this function
 * is pure, and `createDefaultSpawner` substitutes the descriptors. Omitted ⇒ no
 * `logFile` key at all, and the plan is byte-identical to the pre-logging shape.
 */
export function buildSpawnPlan(
  spec: SpawnSpec,
  origin: string,
  account: string,
  binPath: string,
  execPath: string = process.execPath,
  shiftId?: string,
  logDir?: string,
  allowedWorkdirRoots?: string[],
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
	...(allowedWorkdirRoots !== undefined && allowedWorkdirRoots.length > 0
	  ? { OWENLOOP_ALLOWED_WORKDIR_ROOTS: allowedWorkdirRoots.join(':') }
	  : {}),
      },
    },
    ...(logDir !== undefined && logDir !== '' ? { logFile: runLogFile(logDir, spec.run) } : {}),
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
  logging?: WorkerLogOptions,
  allowedWorkdirRoots?: string[],
): Spawner {
  // ONE report per shift, not one per dispatch. Every condition that stops a
  // worker log from opening — a full disk, a read-only log directory, an
  // operator deleting it underneath a running shift — PERSISTS across the
  // dispatches that follow, so an unlatched report writes one stderr line per
  // dispatch for as long as the shift runs. The event sink latches its own
  // failure report the same way (`logsink.ts`); these are the two failure paths
  // of the same feature and they make the operator the same promise.
  let reportedOpenFailure = false;
  const reportOpenFailure = (line: string): void => {
    if (reportedOpenFailure) return;
    reportedOpenFailure = true;
    logging?.err?.(line);
  };
  return (spec: SpawnSpec): SpawnResult => {
    const plan = buildSpawnPlan(
      spec,
      origin,
      account,
      binPath,
      process.execPath,
      shiftId,
      logging?.dir,
      allowedWorkdirRoots,
    );
    // Open the log ONCE and hand the SAME descriptor to slots 1 and 2. Opening
    // it twice would create two independent file offsets, and the two streams
    // would overwrite each other's bytes — silent corruption no unit test on the
    // plan can catch. One descriptor used twice is exactly shell `2>&1`.
    //
    // ALWAYS APPEND, never truncate. A retried or re-armed run reuses its run
    // id, and the prior attempt's output is precisely the evidence this feature
    // exists to keep.
    const logFd = plan.logFile === undefined
      ? undefined
      : openWorkerLog(plan.logFile, reportOpenFailure);
    const options = logFd === undefined
      ? plan.options
      : { ...plan.options, stdio: ['ignore', logFd, logFd] as WorkerStdio };
    let child;
    try {
      child = spawn(plan.command, plan.args, options);
    } finally {
      // The parent's copy must go once the child has inherited its own dup, and
      // it must go even when `spawn` throws. A long-lived shift that leaked one
      // descriptor per dispatch would eventually hit EMFILE and stop
      // dispatching entirely.
      if (logFd !== undefined) {
        try {
          closeSync(logFd);
        } catch {
          // Nothing useful remains to do with a descriptor that will not close.
        }
      }
    }
    const kind = spec.kind === 'agent-run' ? 'agent-run' : 'exec';
    const harness = kind === 'agent-run' ? reportedHarnessId(spec, plan.options.env) : undefined;
    // This process is the executable Shift actually launched. The harness may
    // start its own vendor process later, but reporting or guessing that
    // executable here would couple the neutral dispatcher to one adapter.
    const executable = `${process.execPath} ${binPath}`;
    // THE INVARIANT: no worker stdio slot is ever a PARENT-OWNED PIPE. Once
    // Shift exits, a detached worker may keep writing diagnostics, and a pipe
    // whose reader has vanished kills the writer with EPIPE — losing the worker,
    // not just its output.
    //
    // A FILE DESCRIPTOR IS NOT A PIPE, and slots 1 and 2 are now an appended
    // file: it outlives the parent, needs no live reader, and cannot raise
    // EPIPE. So the invariant holds unchanged while the bytes are kept.
    //
    // "Agent-run stderr is untrusted" also still holds, and still means what it
    // always meant: worker output is never quoted back as a failure message.
    // The bounded generic lifecycle message below is what a failure reports.
    // Untrusted is a reason not to REPEAT those bytes, never a reason to
    // discard them before an operator can read them — reading them is the whole
    // point of `<run>.log`.
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
    const kill = (): void => {
      try {
	child.kill('SIGTERM');
      } catch {
	// The child may already have exited after a cancelled or missing gate.
      }
    };
    return {
      pid: child.pid,
      cancel: () => {
	// Dispatcher-owned termination has its own authoritative failure event.
	// Latch first so the resulting signal exit cannot report a second event.
	failureReported = true;
	kill();
      },
      terminate: kill,
    };
  };
}
