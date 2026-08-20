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
 *       - an ordinary command settles ⇒ build a receipt. A payload reject is
 *         delivered FIRST (the hub refuses a reject once the claim has closed,
 *         and the last owed submit is what closes it). A successful command
 *         submits that receipt to every owed path; a failed command raises an
 *         operator question with the receipt as diagnostic context and submits
 *         nothing.
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

import { isWorkdirAllowed } from '../agent/workdir.ts';
import { createLeaseLoop, type LeaseOutcome } from '../lease/loop.ts';
import type { HubClient } from '../hub/client.ts';
import { HubError, type ContactHolder, type GetOrderResponse, type OrderPacket, type SubmitRequest } from '../hub/types.ts';
import type { CommandRunner, CommandResult, RunningCommand } from './runner.ts';
import type { InstructionResolver } from './instructions.ts';
import { parsePayloadLine } from './payload.ts';
import { buildReceipt, type CommandReceipt } from './receipt.ts';
import { buildSubmitProof, type SubmissionKeyManager } from '../submit-proof.ts';
import type { SshProcessAdapter } from '../../../../src/crypto/ssh.ts';

/** sha256 of the empty byte string — the hash for a run with no captured output. */
const EMPTY_HASH = createHash('sha256').digest('hex');

/** Submit retries are intentionally narrow: 429 is known not to reach the verb. */
const SUBMIT_MAX_ATTEMPTS = 3;
const SUBMIT_RETRY_WINDOW_MS = 30_000;
const SUBMIT_FALLBACK_DELAYS_MS = [5_000, 10_000] as const;
const SUBMIT_ERROR_DETAIL_MAX_CHARS = 160;

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
  | 'workdir-denied' // the order named a cwd outside this machine's declared roots — released (exit 1)
  | 'unresolved-instructions' // local-store instruction refusal — released, never spawned (exit 1)
  | 'killed' // a signal aimed at exec killed the command + released (exit 1)
  | 'lease-lost' // the lease went terminal while the command ran (exit 1)
  | 'ownership-error' // 403 — the run is not ours (exit 1)
  | 'hub-unreachable' // transient failures spanned the window (exit 1)
  | 'submit-rejected' // a submit returned a non-green/submitted outcome (exit 1)
  | 'submit-failed' // a submit threw (exit 1)
  | 'command-failed' // non-zero exit; a question was raised on the owed path (exit 1)
  | 'ask-failed' // the command failed and the question could not be delivered (exit 1)
  | 'rejected' // a payload reject landed and closed the run; owed paths stay debts (exit 0)
  | 'judge-rejected' // a judge delivered a non-zero verdict through reject (exit 0)
  | 'judge-no-verdict' // a judge ended with machinery/signal failure (exit 1)
  | 'reject-failed' // a reject was refused or threw; nothing was submitted (exit 1)
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
  /**
   * The directories this MACHINE's operator declared as places work may happen,
   * already resolved to absolute paths by `resolveAllowedWorkdirRoots`.
   *
   * NOT `workRoot`. `workRoot` is the single directory owenloop CREATES worktrees
   * under; this is the set of directories an ORDER is permitted to name as its
   * cwd. They answer different questions and neither derives from the other.
   *
   * UNSET or EMPTY means NO RESTRICTION — the pre-existing behaviour, and the
   * only default that does not break every shift already running.
   */
  allowedWorkdirRoots?: string[];
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
 * Keep edge response bodies out of the run log without changing HubError's
 * transport contract for other callers. In particular, Cloudflare's HTML 1015
 * page contributes no useful diagnosis beyond the 429 classification.
 */
function formatSubmitError(e: unknown): string {
  if (!(e instanceof HubError)) return errMsg(e);
  if (e.status === 429) return 'HTTP 429 (rate limited)';

  const detail = e.message.replace(/\s+/g, ' ').trim();
  const boundedDetail =
    detail.length <= SUBMIT_ERROR_DETAIL_MAX_CHARS
      ? detail
      : `${detail.slice(0, SUBMIT_ERROR_DETAIL_MAX_CHARS - 1)}…`;
  return `HTTP ${e.status}${e.code === undefined ? '' : ` (${e.code})`}${boundedDetail === '' ? '' : `: ${boundedDetail}`}`;
}

interface CommandOutcomeFields {
  exitCode: number | null;
  signal?: string;
  error?: string;
}

/**
 * The one predicate that decides both how child output is logged and whether
 * its receipt may be submitted.
 *
 * runner.ts reports a signalled child with `exitCode: null`, so a separate
 * signal check is unnecessary.
 */
function commandSucceeded(result: CommandOutcomeFields): boolean {
  return result.exitCode === 0 && result.error === undefined;
}

/** How a command failed, as an English predicate. */
function describeCommandFailure(result: CommandOutcomeFields): string {
  if (result.error !== undefined) return `could not be run (${result.error})`;
  if (result.signal !== undefined) return `was killed by ${result.signal}`;
  return `exited ${result.exitCode}`;
}

/**
 * Append the child's captured output to a payload reject reason when it gives
 * the consumer diagnosis that the script's one-line reason cannot.
 *
 * A reject consumer receives only this text. The same `outputTail` already
 * reaches the worker log through `relayChildOutput` and the receipt through
 * `receipt.ts`, but a step that consumes a rejected artifact sees neither:
 * a delivery builder otherwise learns only that local checks failed. Matching
 * `relayChildOutput`'s trailing-newline trim makes the log and reject carry
 * identical bytes, while the label prevents the child's words from being
 * mistaken for the script's reason.
 *
 * Scripts normally print their `##owenloop:payload##` directive to stdout, so
 * that marker remains in the tail just as it does in `relayChildOutput`.
 * Stripping it here would duplicate the runner's bounded marker scanner. The
 * runner caps the tail at 4 KiB, and a large final payload can crowd out its
 * diagnostics; that pre-existing limit belongs in the runner, not this relay.
 */
function withCommandOutput(text: string, outputTail: string): string {
  const tail = outputTail.replace(/\n+$/, '');
  if (tail === '') return text;
  return `${text}\n\n--- command output (last ${Buffer.byteLength(tail, 'utf8')} bytes) ---\n${tail}`;
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

/**
 * Deliver the owed-artifact reason threads to a command child. The same
 * inline-or-file collision rule as consumes applies: a nested command must
 * never inherit stale feedback from its parent order.
 */
function deliverFeedback(
  childEnv: Record<string, string | undefined>,
  feedback: Array<{ path: string; reasons: unknown[] }> | undefined,
): string | undefined {
  if (feedback === undefined) {
    delete childEnv['OWENLOOP_FEEDBACK'];
    delete childEnv['OWENLOOP_FEEDBACK_FILE'];
    return undefined;
  }
  let json: string;
  try {
    json = JSON.stringify(feedback);
  } catch (e) {
    throw new Error(`cannot serialize the order's feedback for OWENLOOP_FEEDBACK: ${errMsg(e)}`);
  }
  if (Buffer.byteLength(json, 'utf8') <= CONSUMES_INLINE_MAX_BYTES) {
    childEnv['OWENLOOP_FEEDBACK'] = json;
    delete childEnv['OWENLOOP_FEEDBACK_FILE'];
    return undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-consumes-'));
  try {
    const file = join(dir, 'feedback.json');
    writeFileSync(file, json, { encoding: 'utf8', mode: 0o600 });
    childEnv['OWENLOOP_FEEDBACK_FILE'] = file;
    delete childEnv['OWENLOOP_FEEDBACK'];
    return dir;
  } catch (e) {
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

  /**
   * Wait for a server-approved submit retry without continuing after the
   * concurrent lease loop has made the claim terminal.
   */
  async function waitForSubmitRetry(ms: number): Promise<LeaseOutcome | undefined> {
    const settled = await Promise.race([
      opts.sleep(ms).then(() => ({ kind: 'slept' as const })),
      leasePromise!.then((outcome) => ({ kind: 'lease' as const, outcome })),
    ]);
    return settled.kind === 'lease' ? settled.outcome : undefined;
  }

  /** Stop a failed submit exactly as the pre-retry implementation did. */
  async function failSubmit(path: string, error: unknown): Promise<ExecOutcome> {
    opts.err(`owenloop work exec: submit to ${path} failed: ${formatSubmitError(error)}`);
    lease.stop('submit-failed'); // targeted release (idempotent) — best effort
    await leasePromise;
    return 'submit-failed';
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

  /**
   * Deliver a PAYLOAD reject before the owed submits, and say whether this
   * worker is finished.
   *
   * Its text is the script's reason plus a labeled child-output tail. That
   * tail makes a reject actionable for a consumer that never sees the receipt,
   * where the runner's output would otherwise be the only diagnosis.
   *
   * The distinction from `issueReject` is the third outcome. A judge reject is
   * always the end of the run; a payload reject may leave the claim open, and
   * when it does the caller decides whether the command result may deliver
   * owed receipts. So this returns either a terminal `ExecOutcome` or the
   * sentinel `'continue'`.
   *
   *   refused / threw   → terminal. `issueReject` has already logged it and
   *                       settled the lease. Nothing is submitted: a reject that
   *                       did not land must not be followed by a receipt that
   *                       greens the path the reject was protesting.
   *   landed, closed    → terminal `'rejected'`. The rejected path was consumed
   *                       by this firing, the hub closed the run `no_work`, and
   *                       the owed paths stay debts for the next firing.
   *   landed, still open → `'continue'`. The rejected path was not consumed
   *                       here, so the claim and the consume fingerprint are
   *                       both intact. A successful command may submit its
   *                       owed receipts; a failed command escalates instead.
   *
   * `closed` is read from the hub's own response rather than re-derived from the
   * order, because the consumed-input test lives in the hub
   * (`reject-artifact.ts` checks `runRow.fingerprint`, which is what the engine
   * recorded at claim time — not what the def declares the step consumes).
   */
  async function relayPayloadReject(
    path: string,
    text: string,
    outputTail: string,
    owed: number,
  ): Promise<ExecOutcome | 'continue'> {
    const body = withCommandOutput(text, outputTail);
    let res;
    try {
      res = await hub.reject({ workflow, run: runId, path, text: body });
    } catch (e) {
      opts.err(`owenloop work exec: reject of ${path} failed: ${errMsg(e)}`);
      // Nothing has been submitted yet, so unlike the post-submit case there
      // are no committed receipts to reason about. Release and let the step be
      // re-offered.
      lease.stop('reject-failed');
      await leasePromise;
      return 'reject-failed';
    }
    if (res.ok !== true) {
      opts.err(`owenloop work exec: reject of ${path} was refused: ${res.text}`);
      lease.stop('reject-failed', res.closed === true ? { release: false } : undefined);
      await leasePromise;
      return 'reject-failed';
    }
    if (res.closed === true) {
      opts.out(`owenloop work exec: rejected ${path} — run closed, ${owed} owed path(s) left as debts`);
      lease.stop('rejected', { release: false });
      await leasePromise;
      return 'rejected';
    }
    opts.out(`owenloop work exec: rejected ${path} (not consumed by this firing) — claim remains open`);
    return 'continue';
  }

  /**
   * Relay the child's own output unconditionally: to this process's stdout
   * when the command succeeds, and stderr otherwise.
   *
   * ## Why this exists
   *
   * Until this was added, a command step that failed produced a worker log that
   * named the failure and said NOTHING about its cause. The runner captures the
   * last 4 KiB of combined stdout+stderr as `outputTail` and puts it in the
   * receipt — but a receipt only reaches a human if the submit is ACCEPTED, and
   * the most common command-step failure is precisely the one where it is not:
   * the script dies before printing a payload line, so the receipt has no
   * `payload` key and `merge`'s schema rejects it. The one artifact carrying the
   * diagnosis was discarded by the same event that made it necessary.
   *
   * Measured on `wf_40bd0c3f6783f9d31291d74d`: the `merger` step failed four
   * times across two shifts and one foreground `owenloop work exec`, and every
   * one of those logs contained the same three lines — holding, running,
   * schema-rejected — with no trace of what the child said. Reproducing the
   * script by hand outside the engine was the only way to see its stderr.
   *
   * The success half matters because a non-judge command can defer with exit 0
   * and no payload. Failed commands now escalate through `ask`, but
   * `merge-gate` still uses that exit-0 deferral on its `cadence: 2m`
   * re-offer. Before this relay, every deferral produced three identical log
   * lines and no reason; the measured 40-minute case is recorded in
   * `src/config-dir.ts:19-26`.
   *
   * Silence is printed rather than skipped because "this gate printed nothing"
   * is itself the diagnosis, and an absent line is indistinguishable from the
   * bug this relay fixes.
   *
   * `outputTail` is capped at 4 KiB by the runner (`runner.ts:40`), and a
   * delivery run has roughly eleven command steps, so the worst case is about
   * 44 KiB per run. That cap is why no volume knob exists: a knob would let a
   * machine silently reintroduce this exact bug. Each line is prefixed so the
   * child's words are never mistaken for exec's own.
  */
  function relayChildOutput(result: CommandResult, step: string): void {
    const succeeded = commandSucceeded(result);
    // TWO CHANNELS ON PURPOSE, and this is not tidiness to be refactored away.
    // `opts.err` is the channel a reader treats as trouble; routing a green
    // step's routine output there would make every successful step look like a
    // problem. A successful command's output is a RECORD, a failed one's is a
    // DIAGNOSIS. Do not unify them.
    const write = succeeded ? opts.out : opts.err;
    if (succeeded) {
      write(`owenloop work exec: the command for step '${step}' succeeded; its output follows`);
    } else {
      write(`owenloop work exec: the command for step '${step}' ${describeCommandFailure(result)}; its last output follows`);
    }
    const tail = result.outputTail.replace(/\n+$/, '');
    if (tail === '') {
      write('  (the command produced no output)');
      return;
    }
    for (const line of tail.split('\n')) write(`  | ${line}`);
  }

  /** The operator-facing failure text shown by `owenloop inbox`. */
  function failureQuestion(receipt: CommandReceipt, path: string, resolvedCommand: string): string {
    const head =
      `the command for step '${receipt.step}' ${describeCommandFailure(receipt)}, ` +
      `so '${path}' was not produced and no receipt was submitted.\n` +
      `command: ${resolvedCommand}\n` +
      `exit code: ${receipt.exitCode ?? 'none'}` +
      (receipt.signal !== undefined ? `, signal: ${receipt.signal}` : '') +
      (receipt.error !== undefined ? `, error: ${receipt.error}` : '') +
      `\noutput: ${receipt.stdoutBytes} stdout byte(s), ${receipt.stderrBytes} stderr byte(s), ` +
      `hash ${receipt.outputHash}`;
    return withCommandOutput(head, receipt.outputTail);
  }

  /**
   * A failed command does not green anything. Raise a question on its own owed
   * path and retain the receipt as diagnostic context instead.
   */
  async function escalateCommandFailure(
    receipt: CommandReceipt,
    order: OrderPacket,
    resolvedCommand: string,
  ): Promise<ExecOutcome> {
    // run() returns misroute when order.owes is empty, so this index is safe.
    const path = order.owes[0]!.path;
    const how = describeCommandFailure(receipt);

    opts.err(
      `owenloop work exec: the command for step '${order.step}' ${how} — ` +
	`no receipt will be submitted; escalating on ${path}`,
    );
    // ask closes the run, so one firing can raise only one question. The
    // remaining owed paths stay debts for the next firing.
    if (order.owes.length > 1) {
      const rest = order.owes.slice(1).map((owe) => owe.path).join(', ');
      opts.err(
	`owenloop work exec: ${order.owes.length - 1} other owed path(s) were not escalated ` +
	  `because ask closes the run: ${rest}`,
      );
    }

    let res;
    try {
      res = await hub.ask({
	workflow,
	run: runId,
	path,
	question: failureQuestion(receipt, path, resolvedCommand),
	context: JSON.stringify(receipt),
      });
    } catch (e) {
      opts.err(`owenloop work exec: ask on ${path} failed: ${errMsg(e)}`);
      lease.stop('ask-failed');
      await leasePromise;
      return 'ask-failed';
    }
    if (res.ok !== true) {
      opts.err(`owenloop work exec: ask on ${path} was refused: ${res.text}`);
      lease.stop('ask-failed', res.closed === true ? { release: false } : undefined);
      await leasePromise;
      return 'ask-failed';
    }
    opts.out(`owenloop work exec: asked ${path} — the artifact is held for a human and nothing was greened`);
    lease.stop('command-failed', res.closed === true ? { release: false } : undefined);
    await leasePromise;
    return 'command-failed';
  }

  /** Build the command receipt, then deliver, reject, or escalate it. */
  async function deliverCommandResult(result: CommandResult, order: OrderPacket, resolvedCommand: string): Promise<ExecOutcome> {
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

    // Before any of the branches below decide what to do about the failure.
    // Every one of them is reachable with a useless log otherwise.
    relayChildOutput(result, order.step);

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

    // ---- the payload reject goes FIRST, and it is not an ordering nicety ----
    //
    // It used to run after every owed submit, on the reasoning that "all owed
    // submissions must land before invalidating a consumed input; rejection
    // moves the consume fingerprint and would born-reject later submits from
    // this run". The second half of that sentence is true. The first half made
    // the reject UNDELIVERABLE, because the submits it waited on are what kill
    // the claim it needs.
    //
    // The hub refuses a reject from a run whose claim has closed
    // (`hub-core/src/verbs/reject-artifact.ts`: `held` requires
    // `runRow.outcome === undefined`, and the refusal is explicit —
    // "is not currently held by an open claim — nothing was rejected"). A step's
    // last owed submit closes the run. So for the single-owed-path case — which
    // is every gate in the delivery workflow — submit-then-reject could only
    // ever produce the pair observed on `run_ecfedb23a84194e446159e67`:
    //
    //     submitted receipt to mergeable (green)
    //     reject of pr was refused: ... is not currently held by an open claim
    //
    // The gate greened its own output and its reject evaporated, so `merger`
    // proceeded on a PR the gate had explicitly refused to confirm. The def-side
    // cascade that was supposed to un-green `mergeable` never fired, because it
    // hangs off a `pr` rejection that never happened.
    //
    // Rejecting first is correct in both directions, and which one applies is
    // the hub's answer, not a guess:
    //
    //   `closed: true`  — the rejected path WAS one of this firing's consumed
    //     inputs, so the hub closed the run `no_work` (not `failed`: no attempt
    //     is burned). The owed paths stay debts and the step re-fires against the
    //     rebuilt input. Skipping the submits here is not a loss — an artifact
    //     derived from an input this same command just declared bad is exactly
    //     what the engine's dead-input cascade would have thrown away anyway.
    //     This is also the branch that makes the old born-reject warning moot:
    //     there are no later submits to born-reject.
    //
    //   `closed: false` — the rejected path was NOT consumed by this firing, so
    //     the claim is still open and the fingerprint has not moved. Fall through
    //     to the command-result gate: a success submits every owed path, while a
    //     failure escalates through ask and submits nothing.
    //
    // A REFUSED reject now submits nothing. That is the point: previously the
    // receipt had already landed and greened a path whose gate had failed.
    if (order.judge === undefined && parsedPayload.reject !== undefined) {
      const rejected = await relayPayloadReject(
        parsedPayload.reject.path,
        parsedPayload.reject.text,
        result.outputTail,
        order.owes.length,
      );
      if (rejected !== 'continue') return rejected;
    }

    if (!commandSucceeded(result)) return escalateCommandFailure(receipt, order, resolvedCommand);

    for (const owe of order.owes) {
      let proof: string | undefined;
      try {
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
      } catch (e) {
        return failSubmit(owe.path, e);
      }

      // One logical receipt gets one request object. A retry replays these same
      // fields (including the proof) rather than producing a fresh signature.
      const submitRequest: SubmitRequest = Object.freeze({
        workflow,
        run: runId,
        path: owe.path,
        value: receipt,
        ...(proof !== undefined ? { proof } : {}),
        holder: opts.holder,
      });
      const retryStartedAt = opts.now();
      let res: Awaited<ReturnType<HubClient['submit']>> | undefined;

      for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt++) {
        try {
          res = await hub.submit(submitRequest);
          break;
        } catch (e) {
          const retryable = e instanceof HubError && e.status === 429;
          if (!retryable || attempt === SUBMIT_MAX_ATTEMPTS) return failSubmit(owe.path, e);

          const delay = e.retryAfterMs ?? SUBMIT_FALLBACK_DELAYS_MS[attempt - 1]!;
          const remaining = SUBMIT_RETRY_WINDOW_MS - (opts.now() - retryStartedAt);
          // Never retry ahead of a server delay, nor hold this receipt beyond
          // the bounded retry window just because a malformed/large header said to.
          if (delay > remaining) return failSubmit(owe.path, e);

          opts.err(
            `owenloop work exec: submit to ${owe.path} failed: ${formatSubmitError(e)}; ` +
              `retrying attempt ${attempt + 1}/${SUBMIT_MAX_ATTEMPTS} after ${delay}ms`,
          );
          const leaseOutcome = await waitForSubmitRetry(delay);
          // stop() marks this worker as signalled before its best-effort release
          // finishes. The retry sleep can therefore win this race while the
          // release is still in flight; do not issue a new submit in that gap.
          if (signalled) {
            opts.err(`owenloop work exec: signalled while waiting to retry submit to ${owe.path} — no further receipt sent`);
            return 'killed';
          }
          if (leaseOutcome !== undefined) {
            opts.err(`owenloop work exec: lease ${leaseOutcome} while waiting to retry submit to ${owe.path} — no further receipt sent`);
            return mapLeaseDuringRun(leaseOutcome);
          }
        }
      }

      // Each non-success attempt returns from this function, so this only
      // satisfies TypeScript's control-flow analysis after the bounded loop.
      if (res === undefined) return failSubmit(owe.path, new Error('submit retry ended without a response'));
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

    // MACHINE POLICY, checked before any instruction is resolved and long before
    // anything is spawned. The operator who started this shift named the
    // directories work may happen in (`owenloop shift start --work-root`, or
    // `allowedWorkdirRoots` in settings); an order naming anything else is
    // refused HERE, in the worker, because the worker is the only process that
    // ever sees `OrderPacket.workdir` — the shift's `whats_next` sweep receives
    // a `WorkOrder`, which has no such field.
    //
    // RELEASED, not failed. This is not a defect in the order and not a failure
    // of the work: it is one machine declining work it was not configured to
    // host. A targeted release returns the order to the hub's pickup window so a
    // differently-configured machine can take it, exactly like `misroute`.
    // Submitting a failure receipt instead would kill a run that is perfectly
    // valid somewhere else.
    //
    // ONLY an order-NAMED workdir is checked. An order that declares none
    // inherits this worker's own launch directory, which the operator chose
    // themselves when they started the shift — bounding an operator's own
    // choice by the operator's own roots protects nobody and would deny every
    // step that legitimately declares no workdir.
    if (
      order.workdir !== undefined &&
      !isWorkdirAllowed(order.workdir, opts.allowedWorkdirRoots ?? [])
    ) {
      const roots = (opts.allowedWorkdirRoots ?? []).join(', ');
      opts.err(
        `owenloop work exec: step '${order.step}' (${workflow}/${runId}) names workdir ` +
          `'${order.workdir}', which is outside every work root this machine declared (${roots}) — ` +
          'releasing for the pickup window',
      );
      lease.stop('workdir-denied'); // targeted release — local policy, not a failure
      await leasePromise;
      return 'workdir-denied';
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
    // on every path out of this block, including a spawn that threw.
    //
    // On the RECEIPT path the removal follows the child's exit, because a
    // script may read the file late in its run. On the LEASE-TERMINAL path it
    // does not: `cmd.kill()` (see `exec/runner.ts`) posts SIGTERM, races `done`
    // against the grace timer, then posts SIGKILL and returns WITHOUT awaiting
    // `done`, so this unlink can precede full reaping of the killed process
    // group. That is deliberate and harmless — the run is abandoned and submits
    // no receipt — but it is not a guarantee to build on. Do not add work here
    // that assumes the child is gone.
    let consumesDir: string | undefined;
    let feedbackDir: string | undefined;
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
				const feedback = order.owes
					.filter((owe) => owe.reasons.length > 0)
					.map((owe) => ({ path: owe.path, reasons: owe.reasons }));
				feedbackDir = deliverFeedback(childEnv, feedback.length > 0 ? feedback : undefined);
				if (order.modifier === undefined) delete childEnv['OWENLOOP_MODIFIER'];
				else childEnv['OWENLOOP_MODIFIER'] = order.modifier;
        // The order carries no workdir when the step declared neither `workdir:`
        // nor `workdirFrom:` (the hub resolves `workdirFrom` and ships the
        // result, so an absent field IS that signal). Substituting the shift's
        // launch directory silently is how a run ends up operating on an
        // unintended tree with nothing in the output saying so, hence the
        // record. It stays a WARNING: `provisioner` creates the worktree its
        // successors use and `deprovisioner` deletes its own, so both
        // legitimately have no workdir to resolve, and a throw here would break
        // every delivery run the moment it shipped.
        //
        // WHERE THIS LINE ACTUALLY GOES. `opts.err` is this process's stderr.
        // Run by hand, that is the operator's terminal. Dispatched by
        // `owenloop shift start`, `createDefaultSpawner` (`src/shift/spawn.ts`)
        // now attaches fd 1 and fd 2 to `<log-dir>/<run>.log`, so this warning
        // is on disk under the run id it belongs to and outlives both the
        // worker and the shift. See `docs/shift-logs.md`.
        //
        // It was previously discarded: every worker launched with
        // `stdio: ['ignore','ignore','ignore']`, so a shift-dispatched exec
        // wrote this line to `/dev/null`. That was the blocker on turning this
        // warning into a throw — an unseen warning is not a migration notice.
        // The delivery half is now done; the enforcement release is still a
        // separate decision. `docs/bundles.md` ("Working directory for command
        // steps") tracks the same state for bundle authors.
        //
        // The RECEIPT still does not carry it: the receipt captures the
        // *command's* streams, and this line is the exec worker's own.
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
	return deliverCommandResult(machineryFailure(e), order, resolvedCommand);
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

      return deliverCommandResult(outcome.r, order, resolvedCommand);
    } finally {
      removeConsumesDir(consumesDir);
      removeConsumesDir(feedbackDir);
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
