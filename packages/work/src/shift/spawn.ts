/**
 * The detached-exec spawn seam (plan decision 6).
 *
 * Every order the shift dispatches becomes a DETACHED
 * `owenloop work exec <workflow>/<run> --origin <url>` child: `detached: true`,
 * stdout ignored, bounded stderr diagnostics, `unref()` — so the child is its own process-group leader and
 * survives the parent's death (SP5-verified kernel reparenting). The shift meters
 * and hands off; the child self-leases (C5). Both ids ride the argv as the
 * composite `<workflow>/<run>` order-id `owenloop work exec` parses, and `--origin`
 * is passed through so the detached child reaches the SAME hub the shift is
 * parked at without re-reading settings. The shift-resolved account rides the
 * child's spawn ENV as `OWENLOOP_ACCOUNT` (exec has no `--as` flag — the spawn
 * env is the contract), selecting which Scoped Identity credential slot
 * (agent:<account>) exec reads.
 *
 * `Spawner` is an injected seam; unit tests always fake it and NEVER spawn a
 * real child. The default impl's argv/option construction is factored into the
 * pure `buildSpawnPlan` so a test can assert the exact shape as data.
 */
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

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
   * The harness id to host the step agent in, for `kind: 'agent-run'` only.
   * Absent carries no `--harness` flag, leaving the child to resolve the id
   * from `OWENLOOP_HARNESS`, the step def, or its built-in default. Ignored for
   * `'exec'` (a command order has no step agent).
   */
  harness?: string;
}

/** The result the loop records: the child's pid. */
export interface SpawnResult {
  pid: number;
}

/** The spawn seam. Injected; faked in tests. */
export type Spawner = (spec: SpawnSpec) => SpawnResult;

/** Safe, bounded metadata emitted when a detached worker fails. Only a
 * whitelisted, redacted refusal/startup diagnostic may be derived from child
 * stderr; prompts, progress, artifact values, environments, and credentials
 * are never reported. */
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
  options: { detached: true; stdio: ['ignore', 'ignore', 'pipe']; env: NodeJS.ProcessEnv };
}

const MAX_STDERR_TAIL_BYTES = 16 * 1024;
const MAX_DIAGNOSTIC_CHARS = 1_024;

function stripControlCharacters(value: string): string {
  return [...value].filter((character) => {
    const code = character.codePointAt(0)!;
    return code === 9 || (code >= 32 && code !== 127);
  }).join('');
}

/**
 * Select one deliberately narrow worker diagnostic. Agent progress and prompt
 * text use the same stream, so arbitrary stderr must never cross into Shift
 * events. These prefixes are emitted only by pre-session refusal/startup gates.
 *
 * Both worker roles are covered, because `WorkerFailure.kind` has two values and
 * an `exec` child that refuses at startup must not report the useless generic
 * message while an `agent-run` child reports the real cause. The two roles carry
 * DIFFERENT risk, so the allowlists are not shared:
 *
 *  - `owenloop work agent-run:` — the step agent's prompt text and model
 *    progress ride this same stream, so only the pre-session gates are matched.
 *  - `owenloop work exec:` — the child's COMMAND output never reaches this
 *    stream at all. `runCommand` (`packages/work/src/exec/runner.ts`) spawns the
 *    command with its own `['ignore','pipe','pipe']` stdio and consumes both
 *    streams into `outputHash`/`outputTail`; nothing is re-emitted to the exec
 *    child's own stderr. Every `owenloop work exec:` line is therefore the
 *    driver's own prose. Even so, only the startup/refusal gates are matched —
 *    the mid-run submit/reject lines can quote hub response text.
 */
export function safeWorkerDiagnostic(stderr: string): string | undefined {
  const line = stderr
    .split(/\r?\n/u)
    .reverse()
    .map((candidate) => stripControlCharacters(candidate).trim())
    .find((candidate) =>
      /^owenloop work agent-run: consumed artifact refusal \((?:no-proof|signature|value-digest|version|chain|scope|prerequisite)\) /u.test(candidate)
      || /^owenloop work agent-run: (?:loading the step spec .* failed:|no step spec |no adapter registered for harness |instruction store unavailable:|instruction refusal \((?:integrity|harness-carrier)\):|could not load OWENLOOP_HARNESS_MODULE |no hub origin)/u.test(candidate)
      || /^owenloop work exec: instruction refusal \((?:unknown-digest|unknown-step|ambiguous-step|integrity|no-digest|missing-command|unverified-def|origin-policy|unverified-consumed)\) /u.test(candidate)
      || /^owenloop work exec: (?:instruction store unavailable:|no hub origin|missing required <order-id>)/u.test(candidate),
    );
  if (line === undefined) return undefined;

  const redacted = line
    .replace(/\b(Bearer\s+)[^\s]+/giu, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|password|secret)(\s*[:=]\s*)[^\s,;]+/giu, '$1$2[redacted]')
    .replace(/([?&](?:api[_-]?key|token|password|secret)=)[^&\s]+/giu, '$1[redacted]');
  return redacted.slice(0, MAX_DIAGNOSTIC_CHARS);
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
 * selects the role positional (`exec` vs `agent-run`) and `spec.harness`
 * appends `--harness <id>` on the `agent-run` branch. Everything else — the
 * composite order positional, `--origin`, `--shift`, and every spawn option
 * — is identical for both kinds, so an agent-run child is detached,
 * stdio-ignored, and account-scoped exactly like an exec child.
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
      ...(role === 'agent-run' && spec.harness !== undefined && spec.harness !== ''
        ? ['--harness', spec.harness]
        : []),
    ],
    options: { detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, OWENLOOP_ACCOUNT: account } },
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
    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_TAIL_BYTES);
    });
    // The stderr pipe is a libuv handle owned by THIS process, and `child.unref()`
    // does not cover it. Left referenced, the Shift's event loop stays alive for
    // the child's entire lifetime — an `owenloop work shift --once` run would
    // block until every dispatched worker exited, defeating the detached
    // hand-off this seam exists to perform. Unref the pipe too: data still
    // arrives while the Shift is running (its poll loop and daemon socket hold
    // the loop open), it simply stops being a reason to keep running.
    //
    // `ChildProcess.stderr` is typed `Readable`, which declares no `unref`. The
    // concrete object for a `'pipe'` stdio slot is a `net.Socket`, which does.
    // Probe rather than assert the type, so a future non-Socket stream is a
    // silent no-op instead of a TypeError in the dispatch path.
    const stderrPipe = child.stderr as (Readable & { unref?: () => void }) | null;
    if (typeof stderrPipe?.unref === 'function') stderrPipe.unref();
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
      const message = safeWorkerDiagnostic(stderrTail) ?? 'worker exited without completing successfully';
      report(code, signal, message);
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
    return { pid: child.pid };
  };
}
