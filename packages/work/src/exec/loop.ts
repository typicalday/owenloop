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
 *       - an ordinary command settles (any exit code, or a machinery error) ⇒
 *         build a receipt and `submit` it to every owed path. A payload reject
 *         follows those submits. Exit 0 means the receipt/reject delivery won;
 *         the receipt's exit code still carries the command result.
 *       - a judge command exits 0 ⇒ submit its receipt; a non-zero exit ⇒ send
 *         `reject` for `order.judge` without a receipt; signal or machinery
 *         failure ⇒ no verdict, leave the claim for the reap path.
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createLeaseLoop, type LeaseOutcome } from '../lease/loop.ts';
import type { HubClient } from '../hub/client.ts';
import type { ContactHolder, GetOrderResponse, OrderPacket } from '../hub/types.ts';
import type { CommandRunner, CommandResult, RunningCommand } from './runner.ts';
import type { InstructionResolver } from './instructions.ts';
import { parsePayloadLine } from './payload.ts';
import { buildReceipt } from './receipt.ts';
import { buildSubmitProof, type SubmissionKeyManager } from '../submit-proof.ts';
import type { SshProcessAdapter } from '../../../../src/crypto/ssh.ts';

/** sha256 of the empty byte string — the hash for a run with no captured output. */
const EMPTY_HASH = createHash('sha256').digest('hex');

/**
 * The largest serialized `consumes` payload delivered inline in
 * `OWENLOOP_CONSUMES`; anything strictly larger goes to a file named by
 * `OWENLOOP_CONSUMES_FILE`. Measured with `Buffer.byteLength(json, 'utf8')` —
 * never `json.length`, which counts UTF-16 code units and under-reports every
 * multi-byte character.
 *
 * 64 KiB, chosen against the binding OS limit rather than a round number:
 * Linux `execve` enforces `MAX_ARG_STRLEN`, a hard PER-ENTRY cap of 131072
 * bytes (32 × 4 KiB pages) independent of the total `ARG_MAX`; macOS has no
 * per-entry cap but shares ~1 MB of `ARG_MAX` across argv AND the whole
 * environment block, and the child environment here starts from a full
 * inherited `process.env`. 64 KiB clears the Linux per-entry cap with room for
 * the `OWENLOOP_CONSUMES=` prefix and leaves the rest of the macOS budget to
 * the inherited block.
 */
export const CONSUMES_INLINE_MAX_BYTES = 65_536;

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
  | 'rejected' // a payload directive was delivered after all submits (exit 0)
  | 'judge-rejected' // a judge delivered a non-zero verdict through reject (exit 0)
  | 'judge-no-verdict' // a judge ended with machinery/signal failure (exit 1)
  | 'reject-failed' // the receipt landed but its follow-up reject failed (exit 1)
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

/**
 * Put the order's consumed inputs on `childEnv`, and return the temp DIRECTORY
 * holding the overflow file — or `undefined` when the payload went inline.
 *
 * The contract a command script sees, and the reason it is two variables:
 *
 *   - `OWENLOOP_CONSUMES` carries `JSON.stringify(order.consumes ?? {})`
 *     verbatim whenever that fits within `CONSUMES_INLINE_MAX_BYTES`. It is set
 *     even when there are no consumed inputs — the value is then `{}`, not an
 *     absent variable.
 *   - `OWENLOOP_CONSUMES_FILE` names a `0600` UTF-8 file holding that same JSON
 *     when it does not fit.
 *
 * Exactly ONE of the two is present on any spawn, because this function always
 * assigns one and `delete`s the other. That mutual exclusion is what lets the
 * presence of `OWENLOOP_CONSUMES_FILE` act as the discriminator with no third
 * "mode" variable, and it is required anyway by the collision rule below.
 *
 * COLLISION RULE (the same reasoning as `OWENLOOP_WORKFLOW`/`OWENLOOP_RUN` at
 * the spawn site): `childEnv` starts from `process.env`, and a shift can itself
 * have been launched from inside another command step, so both names may
 * already carry the PARENT order's values — a stale inputs object in the inline
 * case, and in the file case a path whose directory has already been removed.
 * Neither name is ever conditionally assigned.
 *
 * The JSON is the raw `order.consumes` object with no envelope, so a command
 * script and an agent step see the identical shape. Key omission is preserved:
 * an input that was declared but never produced is ABSENT from the object, not
 * present as `null`, and a script tests for it with `'key' in consumes`.
 */
function deliverConsumes(
  childEnv: Record<string, string | undefined>,
  consumes: Record<string, unknown> | undefined,
): string | undefined {
  // `order.consumes` arrives JSON-decoded off the wire, so there is no
  // realistic cycle or BigInt to throw on. The throw is still surfaced rather
  // than swallowed: leaving the variable unset would push a script back onto
  // deriving its context from its cwd — the exact failure this delivery exists
  // to remove — so the caller turns it into a machinery failure and no child is
  // spawned.
  let json: string;
  try {
    json = JSON.stringify(consumes ?? {});
  } catch (e) {
    throw new Error(`cannot serialize the order's consumed inputs for OWENLOOP_CONSUMES: ${errMsg(e)}`);
  }

  if (Buffer.byteLength(json, 'utf8') <= CONSUMES_INLINE_MAX_BYTES) {
    childEnv['OWENLOOP_CONSUMES'] = json;
    delete childEnv['OWENLOOP_CONSUMES_FILE'];
    return undefined;
  }

  // `mkdtempSync` rather than a composed run/step/random filename: several
  // shifts run concurrently on one machine, and this gives a collision-free
  // `0700` directory without owning a naming scheme. The file is `0600`
  // because its content is agent-produced artifact data.
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-consumes-'));
  try {
    const file = join(dir, 'consumes.json');
    writeFileSync(file, json, { encoding: 'utf8', mode: 0o600 });
    childEnv['OWENLOOP_CONSUMES_FILE'] = file;
    delete childEnv['OWENLOOP_CONSUMES'];
    return dir;
  } catch (e) {
    // The directory exists but the caller will never learn its path, so remove
    // it here rather than leaking it; the caller's `finally` only covers a
    // directory this function returned.
    removeConsumesDir(dir);
    throw e;
  }
}

/** Best-effort removal of an overflow directory; a cleanup failure never fails a step. */
function removeConsumesDir(dir: string | undefined): void {
  if (dir === undefined) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Swallowed on purpose: the child has already exited and its receipt is
    // authoritative. A temp-directory that outlives the run is a tidiness
    // problem, not a result.
  }
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

  /** Deliver one reject verb and settle the lease after the response arrives. */
  async function issueReject(
    path: string,
    text: string,
    successOutcome: 'rejected' | 'judge-rejected',
  ): Promise<ExecOutcome> {
    try {
      const res = await hub.reject({ workflow, run: runId, path, text });
      if (res.ok !== true) {
        opts.err(`owenloop work exec: reject of ${path} was refused: ${res.text}`);
        lease.stop('reject-failed', res.closed === true ? { release: false } : undefined);
        await leasePromise;
        return 'reject-failed';
      }
      // A closed response means the hub already ended the claiming run. For a
      // non-closed reject, release the still-open claim before this worker exits.
      lease.stop(successOutcome, res.closed === true ? { release: false } : undefined);
      await leasePromise;
      return successOutcome;
    } catch (e) {
      opts.err(`owenloop work exec: reject of ${path} failed: ${errMsg(e)}`);
      // Receipts, when any, are already committed. Do not retry blindly or
      // pretend the reject landed.
      lease.stop('reject-failed');
      await leasePromise;
      return 'reject-failed';
    }
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

    const parsedPayload = parsePayloadLine(result.payloadLine, result.payloadOverCap);
    if (order.judge !== undefined) {
      if (result.exitCode === null) {
        // A signal or machinery failure is not a verdict. Leave the claim for
        // the engine's reap path rather than releasing a silent judgement.
        opts.err(`owenloop work exec: judge ${order.judge} ended without a verdict`);
        lease.stop('judge-no-verdict', { release: false });
        await leasePromise;
        return 'judge-no-verdict';
      }
      if (result.exitCode !== 0) {
        // Judge payload directives are deliberately ignored: one judge order
        // has one verdict, and the command exit code supplies that verdict.
        let text = result.outputTail;
        if (parsedPayload.payload !== undefined && typeof parsedPayload.payload === 'object' && parsedPayload.payload !== null && !Array.isArray(parsedPayload.payload)) {
          const reason = (parsedPayload.payload as Record<string, unknown>)['reason'];
          if (typeof reason === 'string' && reason.trim() !== '') text = reason;
        }
        if (text === '') text = `judge command exited with code ${result.exitCode}`;
        return issueReject(order.judge, text, 'judge-rejected');
      }
    }

    const receipt = buildReceipt(result, {
      command: resolvedCommand,
      orchestrator: opts.holder.id,
      workflow,
      run: runId,
      step: order.step,
    }, parsedPayload);

    for (const owe of order.owes) {
      let res;
      try {
        let proof: string | undefined;
        if (opts.origin !== undefined) {
	  // The immutable order can authorize a judge proof only when the owed
	  // path is the fingerprinted judged artifact. Producer command receipts
	  // remain unsigned until the hub issues a retry-safe target version.
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

    if (order.judge === undefined && parsedPayload.reject !== undefined) {
      // All owed submissions must land before invalidating a consumed input;
      // rejection moves the consume fingerprint and would born-reject later
      // submits from this run.
      return issueReject(parsedPayload.reject.path, parsedPayload.reject.text, 'rejected');
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
    let resolvedBundleDir: string | undefined;
    try {
      const resolved = await opts.instructions.resolveCommand(order);
      if (!resolved.ok) {
        opts.err(`owenloop work exec: ${resolved.reason}`);
        lease.stop('unresolved-instructions');
        await leasePromise;
        return 'unresolved-instructions';
      }
      resolvedCommand = resolved.command;
      resolvedBundleDir = resolved.bundleDir;
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
    // `consumesDir` holds the OWENLOOP_CONSUMES_FILE overflow directory when
    // the serialized inputs did not fit inline. The `finally` below removes it
    // on every path out of this block — including a spawn that threw — and
    // never before the child has exited, because a script may read the file
    // late in its run.
    let consumesDir: string | undefined;
    try {
      let cmd: RunningCommand;
      try {
        // spawn's env replaces the child environment. Start from the actual exec
        // process environment so config-only opts.env cannot strip PATH/HOME, then
        // explicitly remove bundle provenance for loose definitions.
        const childEnv: Record<string, string | undefined> = { ...process.env };
        if (resolvedBundleDir === undefined) delete childEnv['OWENLOOP_BUNDLE_DIR'];
        else childEnv['OWENLOOP_BUNDLE_DIR'] = resolvedBundleDir;
        // Run identity is engine-derived from ExecLoopOptions, never a consumed
        // artifact value, and always present. The consumed inputs that follow ARE
        // artifact values, and they are admitted here only because
        // `resolveCommand` above already ran the consume-side verification gate
        // (`hardRule: true`) and refused the order outright on absent,
        // unverifiable, or invalid evidence. They travel in the environment
        // block and nowhere else — never in argv and never in the command text,
        // which is returned verbatim from the verified store and is not
        // interpolated. All four names below overwrite inherited values so a
        // nested exec sees its own order rather than its parent's.
        childEnv['OWENLOOP_WORKFLOW'] = workflow;
        childEnv['OWENLOOP_RUN'] = runId;
        consumesDir = deliverConsumes(childEnv, order.consumes);
        // The order carries no workdir when the step declared neither `workdir:`
        // nor `workdirFrom:` (the hub resolves `workdirFrom` and ships the
        // result, so an absent field IS that signal). Substituting the shift's
        // launch directory silently is how a run ends up operating on an
        // unintended tree with nothing in the output saying so, hence the
        // record. It stays a WARNING: `provisioner` creates the worktree its
        // successors use and `deprovisioner` deletes its own, so both
        // legitimately have no workdir to resolve, and a throw here would break
        // every delivery run the moment it shipped.
        const cwd = order.workdir ?? opts.cwd;
        if (order.workdir === undefined) {
          opts.err(
            `owenloop work exec: step '${order.step}' (${workflow}/${runId}) declared neither workdir nor ` +
              `workdirFrom — inheriting the shift launch directory '${resolve(cwd)}' as the command's cwd. ` +
              'A future release will require a step to declare this inheritance explicitly.',
          );
        }
        const startOptions = { cwd, env: childEnv };
        cmd = runner.start(resolvedCommand, startOptions);
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
    } finally {
      removeConsumesDir(consumesDir);
    }
  }

  function stop(reason?: string): void {
    if (signalled) return;
    signalled = true;
    if (running !== undefined) void running.kill();
    lease.stop(reason ?? 'signal'); // release:true — hand the killed order back
  }

  return { run, stop };
}
