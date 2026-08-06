/**
 * The exec orchestration core (C5) — the detached, self-leasing command worker.
 *
 * A command order the shift (C3) dispatched becomes a detached `owenloop work exec`
 * process. This core drives its whole life against the hub, every side effect
 * injected (hub client, command runner, sleep/clock, output sinks) so tests run
 * it with a fake hub + fake runner and no real timers or child processes:
 *
 *  1. FIRST CONTACT — starts the shared lease loop (`src/lease/loop.ts`) with the
 *     exec holder tag `{kind:'exec', id}` (the B3 drain exemption: exec-held
 *     claims survive a session drain). The loop's first `get_order` beats the
 *     lease and delivers the order packet via `onOrder`; the loop then keeps the
 *     lease warm underneath everything below.
 *  2. VALIDATE — a `null` packet, a non-`command` worker, or a missing/empty
 *     `owes` list is a MISROUTE (plan decision 3): not exec's to fail (a Step
 *     Agent could legitimately run it), so a targeted release, no submit, exit 1.
 *     A command worker's `defDigest` is then resolved through the verified local
 *     workflow store. Missing or corrupt instructions are a named refusal, not a
 *     misroute, and no child process is started.
 *  3. RUN + RACE — the runner shells the command out while the lease loop runs.
 *     Whichever settles first wins (plan decision 9):
 *       - command settles (any exit code, or a machinery error) ⇒ build a
 *         receipt and `submit` it to every owed path, then stop the lease
 *         WITHOUT release (the run just closed). Exit 0 — delivering the receipt
 *         IS the job, even for a failing command (the exit code carries truth).
 *       - lease goes terminal first (lease-lost / ownership-error / unreachable /
 *         the engine closed the run) ⇒ kill the command's process group, NO
 *         submit (a submit would race the re-offer), exit 1.
 *  4. FINAL BREATH — a SIGINT/SIGTERM aimed at exec itself is an operator killing
 *     the work (drain only exempts exec from the SESSION's death): `stop()` kills
 *     the command group and takes a targeted release, exit 1 (plan decision 1).
 *     Killed work NEVER gets a receipt — even when the TERM'd command settles
 *     before the release round-trip resolves the lease (the common ordering),
 *     the submit path checks `signalled` and bails to `killed`.
 *
 * The role (`src/roles/exec.ts`) maps each `ExecOutcome` to an exit code.
 */
import { createHash } from 'node:crypto';

import { createLeaseLoop, type LeaseOutcome } from '../lease/loop.ts';
import type { HubClient } from '../hub/client.ts';
import type { ContactHolder, GetOrderResponse, OrderPacket } from '../hub/types.ts';
import type { CommandRunner, CommandResult, RunningCommand } from './runner.ts';
import type { InstructionResolver } from './instructions.ts';
import { buildReceipt } from './receipt.ts';
import { buildSubmitProof, type SubmissionKeyManager } from '../submit-proof.ts';
import type { SshProcessAdapter } from '../../../../src/crypto/ssh.ts';

/** sha256 of the empty byte string — the hash for a run with no captured output. */
const EMPTY_HASH = createHash('sha256').digest('hex');

/** Discriminated result of an exec run; the role maps these to exit codes. */
export type ExecOutcome =
  | 'submitted' // receipt delivered to every owed path (exit 0)
  | 'completed' // the order already finished at first contact (exit 0)
  | 'misroute' // null / non-command packet — released, not our failure (exit 1)
  | 'unresolved-instructions' // local-store instruction refusal — released, never spawned (exit 1)
  | 'killed' // a signal aimed at exec killed the command + released (exit 1)
  | 'lease-lost' // the lease went terminal while the command ran (exit 1)
  | 'ownership-error' // 403 — the run is not ours (exit 1)
  | 'hub-unreachable' // transient failures spanned the window (exit 1)
  | 'submit-rejected' // a submit returned a non-green/submitted outcome (exit 1)
  | 'submit-failed' // a submit threw (exit 1)
  | 'stopped'; // stop() arrived before the hold was established (exit 1)

export interface ExecLoopOptions {
  hub: HubClient;
  runner: CommandRunner;
  workflow: string;
  run: string;
  /** Hub origin used to resolve the local machine signing key. */
  origin?: string;
  principalKeys?: SubmissionKeyManager;
  env?: Record<string, string | undefined>;
  /** Injectable ssh-keygen seam for hermetic submit-proof tests. */
  sshProcess?: SshProcessAdapter;
  /** The exec process holder tag `{kind:'exec', id}` — id is `<hostname>:<pid>`. */
  holder: ContactHolder;
  /** Resolves command text from a verified local workflow-store object. */
  instructions: InstructionResolver;
  /** cwd for the command when the order packet carries no `workdir`. */
  cwd: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random?: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
  heartbeatIntervalMs?: number;
  jumpToleranceMs?: number;
  failureWindowMs?: number;
}

export interface ExecLoop {
  run(): Promise<ExecOutcome>;
  /** Final breath: kill the command group and release. Wired to SIGINT/SIGTERM. */
  stop(reason?: string): void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createExecLoop(opts: ExecLoopOptions): ExecLoop {
  const { hub, runner, workflow } = opts;
  const runId = opts.run;

  let running: RunningCommand | undefined;
  let signalled = false;
  let leasePromise: Promise<LeaseOutcome> | undefined;

  let resolveOrder: ((res: GetOrderResponse) => void) | undefined;
  const orderReady = new Promise<GetOrderResponse>((r) => {
    resolveOrder = r;
  });

  const lease = createLeaseLoop({
    hub,
    workflow,
    run: runId,
    role: 'exec',
    holder: opts.holder,
    onOrder: (res) => resolveOrder?.(res),
    sleep: opts.sleep,
    now: opts.now,
    out: opts.out,
    err: opts.err,
    ...(opts.random !== undefined ? { random: opts.random } : {}),
    ...(opts.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: opts.heartbeatIntervalMs } : {}),
    ...(opts.jumpToleranceMs !== undefined ? { jumpToleranceMs: opts.jumpToleranceMs } : {}),
    ...(opts.failureWindowMs !== undefined ? { failureWindowMs: opts.failureWindowMs } : {}),
  });

  /** A CommandResult standing in for a runner that threw before producing one. */
  function machineryFailure(e: unknown): CommandResult {
    const t = opts.now();
    return {
      exitCode: null,
      error: errMsg(e),
      outputHash: `sha256:${EMPTY_HASH}`,
      stdoutBytes: 0,
      stderrBytes: 0,
      outputTail: '',
      startedAt: t,
      finishedAt: t,
      durationMs: 0,
    };
  }

  /** A first-contact / no-hold lease outcome → exec outcome. */
  function mapNoHold(o: LeaseOutcome): ExecOutcome {
    switch (o) {
      case 'completed':
        return 'completed';
      case 'ownership-error':
        return 'ownership-error';
      case 'hub-unreachable':
        return 'hub-unreachable';
      case 'lease-lost':
        return 'lease-lost';
      case 'stopped':
        return signalled ? 'killed' : 'stopped';
      case 'released':
      case 'release-failed':
        // stop() with release fired before the hold was ever established.
        return 'killed';
    }
  }

  /** A lease outcome observed while the command was running (exit 1 always). */
  function mapLeaseDuringRun(o: LeaseOutcome): ExecOutcome {
    if (o === 'ownership-error') return 'ownership-error';
    if (o === 'hub-unreachable') return 'hub-unreachable';
    return 'lease-lost';
  }

  /** Build the receipt and submit it to every owed path. */
  async function submitReceipt(result: CommandResult, order: OrderPacket, resolvedCommand: string): Promise<ExecOutcome> {
    if (signalled) {
      // The operator killed the work and the command settled before the lease
      // (the release HTTP round-trip is slower than a TERM'd child dying), so
      // the done branch won the race. Plan decision 1: NO receipt for killed
      // work — a submit here would race the release/re-offer. stop() already
      // took the targeted release; just wait for it.
      opts.err(`owenloop work exec: signalled — killed work gets no receipt, released ${workflow}/${runId}`);
      await leasePromise;
      return 'killed';
    }
    const receipt = buildReceipt(result, {
      command: resolvedCommand,
      orchestrator: opts.holder.id,
      workflow,
      run: runId,
      step: order.step,
    });

    for (const owe of order.owes) {
      let res;
      try {
        let proof: string | undefined;
        if (opts.origin !== undefined) {
          proof = await buildSubmitProof({
            origin: opts.origin,
            order,
            path: owe.path,
            value: receipt,
            now: opts.now,
            warn: opts.err,
            ...(opts.principalKeys !== undefined ? { principalKeys: opts.principalKeys } : {}),
            ...(opts.env !== undefined ? { env: opts.env } : {}),
            ...(opts.sshProcess !== undefined ? { sshProcess: opts.sshProcess } : {}),
          });
        }
        res = await hub.submit({
          workflow,
          run: runId,
          path: owe.path,
          value: receipt,
          ...(proof !== undefined ? { proof } : {}),
          holder: opts.holder,
        });
      } catch (e) {
        opts.err(`owenloop work exec: submit to ${owe.path} failed: ${errMsg(e)}`);
        lease.stop('submit-failed'); // targeted release (idempotent) — best effort
        await leasePromise;
        return 'submit-failed';
      }
      const outcome = res.outcome;
      if (outcome !== 'green' && outcome !== 'submitted') {
        opts.err(`owenloop work exec: submit to ${owe.path} rejected (${outcome ?? 'unknown'}): ${res.text}`);
        // born-rejected ⇒ the claim is already gone, no release; otherwise a
        // targeted release is idempotent and harmless.
        lease.stop('submit-rejected', outcome === 'born-rejected' ? { release: false } : undefined);
        await leasePromise;
        return 'submit-rejected';
      }
      opts.out(`owenloop work exec: submitted receipt to ${owe.path} (${outcome})`);
    }

    // Every owed path landed — the run has closed, so stop WITHOUT releasing.
    lease.stop('submitted', { release: false });
    await leasePromise;
    return 'submitted';
  }

  async function run(): Promise<ExecOutcome> {
    leasePromise = lease.run();

    // First contact race: the order arrives (hold established), or the lease
    // resolves terminally before we ever established it.
    const first = await Promise.race([
      orderReady.then((res) => ({ t: 'order' as const, res })),
      leasePromise.then((o) => ({ t: 'lease' as const, o })),
    ]);
    if (first.t === 'lease') return mapNoHold(first.o);

    const order = first.res.order;
    if (
      order === null ||
      order.worker !== 'command' ||
      !Array.isArray(order.owes) ||
      order.owes.length === 0
    ) {
      opts.err(`owenloop work exec: ${workflow}/${runId} is not a command order (misroute) — releasing`);
      lease.stop('misroute'); // targeted release — not exec's to fail
      await leasePromise;
      return 'misroute';
    }

    let resolvedCommand: string;
    try {
      const resolved = await opts.instructions.resolveCommand(order);
      if (!resolved.ok) {
        opts.err(`owenloop work exec: ${resolved.reason}`);
        lease.stop('unresolved-instructions');
        await leasePromise;
        return 'unresolved-instructions';
      }
      resolvedCommand = resolved.command;
    } catch (e) {
      opts.err(
        `owenloop work exec: instruction refusal (integrity) for ${workflow}/${runId} ` +
          `defDigest '${order.defDigest}': ${errMsg(e)}`,
      );
      lease.stop('unresolved-instructions');
      await leasePromise;
      return 'unresolved-instructions';
    }

    // Run the command and race it against the lease going terminal.
    let cmd: RunningCommand;
    try {
      cmd = runner.start(resolvedCommand, { cwd: order.workdir ?? opts.cwd });
    } catch (e) {
      return submitReceipt(machineryFailure(e), order, resolvedCommand);
    }
    running = cmd;
    opts.out(`owenloop work exec: running ${workflow}/${runId} (step '${order.step}')`);

    const outcome = await Promise.race([
      cmd.done.then((r) => ({ t: 'done' as const, r })).catch((e: unknown) => ({ t: 'done' as const, r: machineryFailure(e) })),
      leasePromise.then((o) => ({ t: 'lease' as const, o })),
    ]);

    if (outcome.t === 'lease') {
      await cmd.kill(); // no receipt — a submit now would race the re-offer
      if (signalled) {
        opts.err(`owenloop work exec: signalled mid-run — killed the command group, released ${workflow}/${runId}`);
        return 'killed';
      }
      opts.err(`owenloop work exec: lease ${outcome.o} while the command ran — killed the command, no receipt submitted`);
      return mapLeaseDuringRun(outcome.o);
    }

    return submitReceipt(outcome.r, order, resolvedCommand);
  }

  function stop(reason?: string): void {
    if (signalled) return;
    signalled = true;
    if (running !== undefined) void running.kill();
    lease.stop(reason ?? 'signal'); // release:true — hand the killed order back
  }

  return { run, stop };
}
