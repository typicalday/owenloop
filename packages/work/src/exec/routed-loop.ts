/**
 * Fenced routed command composition. The parent broker freezes role/holder
 * effects and owns every postrun Hub consequence. Original-group settlement
 * is local evidence only; native reoffer keeps its ordinary at-least-once rule.
 */
import { performance } from 'node:perf_hooks';

import { isExistingDirectory, isWorkdirAllowed } from '../agent/workdir.ts';
import type { HubClient } from '../hub/client.ts';
import type { OrderPacket } from '../hub/types.ts';
import { createLeaseLoop, type LeaseOutcome } from '../lease/loop.ts';
import { routedWorkerEnv } from '../roles/routing-role-env.ts';
import type { CommandResult, GroupSettlement, RoutedCommandRunner, RoutedRunningCommand } from './runner.ts';
import { readPayloadFile, resolvePayload, type ParsedPayload } from './payload.ts';
import { buildReceipt, type CommandReceipt } from './receipt.ts';
import { deliverConsumes, deliverFeedback, deliverPayloadFile, removeConsumesDir,
  type ExecLoop, type ExecLoopOptions, type ExecOutcome } from './loop.ts';

export interface RoutedPostrunResult {
  /** Only a parent-owned, scoped receipt authority may report these outcomes. */
  outcome: 'submitted' | 'submit-rejected' | 'rejected' | 'judge-rejected' | 'command-failed';
  claim: 'closed' | 'held' | 'uncertain';
}

/**
 * Methods are implemented by the parent operation against its internally held
 * generation. The role never receives or supplies a fleet-seal token. A real
 * implementation must reobserve after signing and retry sleeps, before every
 * submit/ask/reject/collection write, and reconcile a lost ACK using only the
 * exact already-dispatched request. The production role remains fenced until
 * that implementation has joined wire and process proof.
 */
export interface RoutedExecutionController {
  /** Exact signed child frame from the parent grant; HTTP/lease uses root. */
  frameId: string;
  runner: RoutedCommandRunner;
  /** Required signed prestart witness and one-use reserve/report admission. */
  prestart(order: OrderPacket, signal: AbortSignal): Promise<{
    consumedFilePathsJson?: string;
    cleanup?: () => Promise<void>;
  } | void>;
  /** Synchronous parent freeze begins on invocation, before the first await. */
  quiesce(ctx: { signal: AbortSignal; deadlineAt: number }): Promise<{ quiescing: true; effects: 'settled' | 'uncertain' }>;
  /** Parent-owned scoped consequence after broker freeze and local group result. */
  postrun(input: { order: OrderPacket; command: string; result: CommandResult;
    payload: ParsedPayload; receipt: CommandReceipt; group: GroupSettlement },
    ctx: { signal: AbortSignal; deadlineAt: number }): Promise<RoutedPostrunResult>;
  /** Parent checks current native claim before any targeted release. */
  targetedRelease(order: OrderPacket, reason: string,
    observation: { group: { scope: 'original-posix-group'; state: 'empty' } }
      | { observation: 'not-started' },
    ctx: { signal: AbortSignal; deadlineAt: number }): Promise<'released' | 'already-closed' | 'uncertain'>;
  /** Monotonic group-settlement budget; defaults to 10 seconds. */
  groupSettleMs?: number;
  /** One total bounded freeze/group/consequence budget, from first freeze. */
  lifecycleDeadlineMs?: number;
  /** One bounded prestart call; startup binding also has its own Service expiry. */
  prestartDeadlineMs?: number;
  /** Timeout of each original-session lease RPC, including first contact. */
  leaseRpcDeadlineMs?: number;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function createRoutedExecLoop(opts: ExecLoopOptions, control: RoutedExecutionController): ExecLoop {
  const groupSettleMs = control.groupSettleMs ?? 10_000;
  const lifecycleDeadlineMs = control.lifecycleDeadlineMs ?? 120_000;
  const prestartDeadlineMs = control.prestartDeadlineMs ?? 60_000;
  const leaseRpcDeadlineMs = control.leaseRpcDeadlineMs ?? 10_000;
  for (const [name, value] of Object.entries({ groupSettleMs, lifecycleDeadlineMs,
    prestartDeadlineMs, leaseRpcDeadlineMs })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 3_600_000)
      throw new Error(`invalid routed ${name}`);
  }
  const abort = new AbortController();
  // Parent custody must keep terminating/reconciling after this caller times out.
  const custodyAbort = new AbortController();
  const consequenceAbort = new AbortController();
  const releaseAbort = new AbortController();
  let stopped = false;
  let timedOut = false;
  let closureDeadlineAt: number | undefined;
  let terminal: LeaseOutcome | undefined;
  let command: RoutedRunningCommand | undefined;
  let settledGroup: GroupSettlement | undefined;
  let groupSettlePromise: Promise<Awaited<ReturnType<RoutedRunningCommand['settleEffects']>>> | undefined;
  let startAttempted = false;
  let postrunAttempted = false;
  let releaseAttempted = false;
  let freeze: Promise<{ quiescing: true; effects: 'settled' | 'uncertain' }> | undefined;
  let leasePromise: Promise<LeaseOutcome> | undefined;
  let resolveOrder!: (order: OrderPacket | null) => void;
  const orderReady = new Promise<OrderPacket | null>((resolve) => { resolveOrder = resolve; });
  const leaseRpc = async <T>(work: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
	timer = setTimeout(() => reject(new Error('routed lease RPC timed out')), leaseRpcDeadlineMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const leaseHub = {
    getOrder: (request: Parameters<HubClient['getOrder']>[0]) =>
      leaseRpc(() => opts.hub.getOrder(request)),
    heartbeat: (request: Parameters<HubClient['heartbeat']>[0]) =>
      leaseRpc(() => opts.hub.heartbeat(request)),
  } as HubClient;
  const lease = createLeaseLoop({
    hub: leaseHub, workflow: opts.workflow, run: opts.run, role: 'exec', holder: opts.holder,
    onOrder: ({ order }) => resolveOrder(order), sleep: opts.sleep, now: () => performance.now(),
    out: opts.out, err: opts.err,
    ...(opts.random !== undefined ? { random: opts.random } : {}),
    ...(opts.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: opts.heartbeatIntervalMs } : {}),
    ...(opts.jumpToleranceMs !== undefined ? { jumpToleranceMs: opts.jumpToleranceMs } : {}),
    ...(opts.failureWindowMs !== undefined ? { failureWindowMs: opts.failureWindowMs } : {}),
  });
  const context = (deadlineAt: number) => ({ signal: custodyAbort.signal, deadlineAt });
  const consequenceContext = (deadlineAt: number) => ({ signal: consequenceAbort.signal, deadlineAt });
  const releaseContext = (deadlineAt: number) => ({ signal: releaseAbort.signal, deadlineAt });
  const awaitBounded = async <T>(label: string, work: () => Promise<T>, deadlineAt: number): Promise<T> => {
    const remaining = deadlineAt - performance.now();
    if (remaining <= 0) {
      timedOut = true; abort.abort(); consequenceAbort.abort(); releaseAbort.abort();
      throw new Error(`${label} deadline expired`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([work(), new Promise<never>((_resolve, reject) => {
	timer = setTimeout(() => { timedOut = true; abort.abort(); consequenceAbort.abort(); releaseAbort.abort();
	  reject(new Error(`${label} deadline expired`)); }, remaining);
      })]);
      if (performance.now() >= deadlineAt) {
	timedOut = true; abort.abort(); consequenceAbort.abort(); releaseAbort.abort();
	throw new Error(`${label} deadline expired`);
      }
      return result;
    } finally { if (timer) clearTimeout(timer); }
  };
  const freezeNow = () => {
    if (!freeze) {
      closureDeadlineAt = performance.now() + lifecycleDeadlineMs;
      try { freeze = control.quiesce(context(closureDeadlineAt)); }
      catch (error) { freeze = Promise.reject(error); }
      // Stop may arrive while another await is pending. Observe the rejection
      // immediately; the main settlement still awaits the same promise.
      void freeze.catch(() => {});
    }
    return freeze;
  };
  const startGroupSettlement = (reason: 'natural-exit' | 'stop') => {
    if (!command) return undefined;
    if (!groupSettlePromise) {
      try { groupSettlePromise = command.settleEffects({ reason,
	deadlineAt: performance.now() + groupSettleMs }); }
      catch (error) { groupSettlePromise = Promise.reject(error); }
      // A caller's timeout must not cancel the retained supervisor's teardown.
      void groupSettlePromise.catch(() => {});
    }
    return groupSettlePromise;
  };
  const active = () => !stopped && terminal === undefined && !abort.signal.aborted;
  const quarantine = async (reason: string): Promise<ExecOutcome> => {
    opts.err(`owenloop work exec: routed ${opts.workflow}/${opts.run} quarantined (${reason})`);
    freezeNow();
    try { await awaitBounded('parent quiesce', () => freezeNow(), closureDeadlineAt!); }
    catch { opts.err('owenloop work exec: parent effect freeze remains uncertain'); }
    lease.stop('routed-quarantine', { release: false });
    if (leasePromise) {
      try { await awaitBounded('lease stop observation', () => leasePromise!, closureDeadlineAt!); }
      catch { opts.err('owenloop work exec: routed lease stop remains uncertain'); }
    }
    return 'routed-quarantined';
  };
  const settle = async (reason: 'natural-exit' | 'stop'): Promise<GroupSettlement | undefined> => {
    freezeNow();
    const groupWork = startGroupSettlement(reason);
    const ack = await awaitBounded('parent quiesce', () => freezeNow(), closureDeadlineAt!);
    if (!ack.quiescing || ack.effects !== 'settled') throw new Error('parent effect freeze is uncertain');
    if (groupWork) {
      const group = await awaitBounded('original group settlement', () => groupWork, closureDeadlineAt!);
      if (group.scope !== 'original-posix-group' || group.state !== 'empty')
	throw new Error('original process group is uncertain');
      settledGroup = group;
      return group;
    }
    return undefined;
  };
  const finish = async (order: OrderPacket, reason: string, cleanup: Array<() => Promise<void>>,
    closed: boolean, allowStopped = false): Promise<boolean> => {
    if (timedOut || (stopped && !allowStopped) ||
      (terminal !== undefined && !(closed && terminal === 'completed'))) return false;
    if (!closed) {
      // The latch flips before runner.start. A synchronous throw after that
      // point is ambiguous, so it cannot use the no-start assertion.
      const observation = !startAttempted ? { observation: 'not-started' as const }
	: settledGroup?.scope === 'original-posix-group' && settledGroup.state === 'empty'
	  ? { group: { scope: 'original-posix-group' as const, state: 'empty' as const } }
	  : undefined;
      if (!observation) return false;
      releaseAttempted = true;
      const released = await awaitBounded('targeted release',
	() => control.targetedRelease(order, reason, observation,
	  allowStopped ? releaseContext(closureDeadlineAt!) : consequenceContext(closureDeadlineAt!)),
	closureDeadlineAt!);
      if (released === 'uncertain' || timedOut || (stopped && !allowStopped)) return false;
    }
    // The role has already completed and closed its synchronous payload read;
    // cache downloads finished before start. The managed runner's original
    // group was settled before finish. This is local custody, not a claim that
    // arbitrary escaped descendants have stopped.
    for (const remove of cleanup)
      await awaitBounded('custody cleanup', remove, closureDeadlineAt!);
    lease.stop(reason, { release: false });
    await awaitBounded('lease stop observation', () => leasePromise!, closureDeadlineAt!);
    return true;
  };

  async function run(): Promise<ExecOutcome> {
    if (!opts.routedPublicEnv || !opts.env) {
      freezeNow();
      return quarantine('bound original/public command environment is absent');
    }
    leasePromise = lease.run();
    void leasePromise.then((outcome) => { terminal = outcome; abort.abort(); freezeNow(); },
      () => { terminal = 'hub-unreachable'; abort.abort(); freezeNow(); });
    let first: { kind: 'order'; order: OrderPacket | null } | { kind: 'lease'; outcome: LeaseOutcome };
    try {
      first = await awaitBounded('routed first contact', () => Promise.race([
	orderReady.then((order) => ({ kind: 'order' as const, order })),
	leasePromise!.then((outcome) => ({ kind: 'lease' as const, outcome })),
      ]), performance.now() + prestartDeadlineMs);
    } catch { return quarantine('first contact is uncertain'); }
    if (first.kind === 'lease') return first.outcome === 'completed' ? 'completed' : quarantine('no live first contact');
    const order = first.order;
    if (!order) return quarantine('missing command order');
    const startupDeadlineAt = performance.now() + prestartDeadlineMs;
    const cleanup: Array<() => Promise<void>> = [];
    try {
      if (order.worker !== 'command' || !order.routing || !Array.isArray(order.owes)
	|| order.owes.length === 0 || order.workflow !== control.frameId || order.run !== opts.run)
	throw new Error('invalid routed command order');
      if (order.workdir !== undefined && (!isWorkdirAllowed(order.workdir, opts.allowedWorkdirRoots ?? [])
	|| !(opts.dirExists ?? isExistingDirectory)(order.workdir)))
	throw new Error('routed workdir is unavailable');
      const resolved = await awaitBounded('signed command resolution',
	() => opts.instructions.resolveRoutedCommandDefinition?.(order)
	  ?? Promise.resolve({ ok: false as const, kind: 'integrity' as const,
	    reason: 'routed signed definition resolver unavailable' }), startupDeadlineAt);
      if (!active() || !resolved.ok || resolved.inputWitnessRequired !== true)
	throw new Error('signed command resolution refused');
      const childEnv = routedWorkerEnv(opts.env, opts.routedPublicEnv);
      childEnv['OWENLOOP_WORKFLOW'] = opts.workflow;
      childEnv['OWENLOOP_RUN'] = opts.run;
      if (resolved.bundleDir === undefined) delete childEnv['OWENLOOP_BUNDLE_DIR'];
      else childEnv['OWENLOOP_BUNDLE_DIR'] = resolved.bundleDir;
      if (order.modifier === undefined) delete childEnv['OWENLOOP_MODIFIER'];
      else childEnv['OWENLOOP_MODIFIER'] = order.modifier;
      const consumesDir = deliverConsumes(childEnv, order.consumes);
      if (consumesDir) cleanup.push(async () => removeConsumesDir(consumesDir));
      const feedback = order.owes.filter((owe) => owe.reasons.length > 0)
	.map((owe) => ({ path: owe.path, reasons: owe.reasons }));
      const feedbackDir = deliverFeedback(childEnv, feedback.length ? feedback : undefined);
      if (feedbackDir) cleanup.push(async () => removeConsumesDir(feedbackDir));
      const payload = deliverPayloadFile(childEnv, opts.err);
      if (!payload.dir || !payload.file) throw new Error('private payload channel is unavailable');
      if (payload.dir) cleanup.push(async () => removeConsumesDir(payload.dir));
      if (resolved.revalidate && await awaitBounded('signed prestart revalidation',
	resolved.revalidate, startupDeadlineAt))
	throw new Error('signed command changed before prestart');
      if (!active()) throw new Error('stopped before prestart');
      const prepared = await awaitBounded('prestart', () => control.prestart(order, abort.signal),
	startupDeadlineAt);
      if (prepared?.cleanup) cleanup.push(prepared.cleanup);
      if (prepared?.consumedFilePathsJson !== undefined)
	childEnv['OWENLOOP_CONSUMED_FILE_PATHS_JSON'] = prepared.consumedFilePathsJson;
      if (!active()) throw new Error('stopped during prestart');
      // The only physical start in this branch; never retry an ambiguous start.
      startAttempted = true;
      command = control.runner.start(resolved.command, { cwd: order.workdir ?? opts.cwd, env: childEnv });
      const firstEnd = await Promise.race([
	command.done.then((result) => { freezeNow(); startGroupSettlement('natural-exit');
	  return { kind: 'done' as const, result }; }),
	leasePromise.then(() => { freezeNow(); startGroupSettlement('stop');
	  return { kind: 'terminal' as const }; }),
	new Promise<{kind:'stop'}>((resolveStop) => {
	  if (stopped) resolveStop({ kind:'stop' });
	  else stopWaiter = () => resolveStop({ kind:'stop' });
	}),
      ]);
      // Freeze immediately on direct exit or stop before interpreting bytes.
      freezeNow();
      const group = await settle(firstEnd.kind === 'done' && active() ? 'natural-exit' : 'stop');
      if (firstEnd.kind !== 'done' || !active()) {
	if (stopped && terminal === undefined && !timedOut
	  && await finish(order, 'routed-stop', cleanup, false, true)) return 'killed';
	return quarantine('stop or lease loss during command');
      }
      const result = firstEnd.result;
      if (!group) throw new Error('original group settlement missing');
      if (result.exitCode === null || result.error !== undefined || result.signal !== undefined)
	throw new Error('command output is incomplete');
      const parsed = resolvePayload({ payloadLine: result.payloadLine,
	payloadOverCap: result.payloadOverCap, file: readPayloadFile(payload.file) });
      if (resolved.revalidateAfterRun && await awaitBounded('signed postrun revalidation',
	resolved.revalidateAfterRun, closureDeadlineAt!))
	throw new Error('signed command changed after run');
      if (!active()) return quarantine('stopped before parent postrun');
      const receipt = buildReceipt(result, { command: resolved.command,
	orchestrator: opts.holder.id, workflow: opts.workflow, run: opts.run, step: order.step }, parsed);
      postrunAttempted = true;
      const post = await awaitBounded('parent postrun',
	() => control.postrun({ order, command: resolved.command, result, payload: parsed, receipt, group },
	  consequenceContext(closureDeadlineAt!)), closureDeadlineAt!);
      if (stopped || post.claim === 'uncertain' ||
	(terminal !== undefined && !(post.claim === 'closed' && terminal === 'completed')))
	return quarantine('postrun outcome is uncertain');
      if (!await finish(order, 'routed-postrun', cleanup, post.claim === 'closed'))
	return quarantine('native closure or reader death is uncertain');
      return post.outcome;
    } catch (error) {
      opts.err(`owenloop work exec: routed command refused: ${message(error)}`);
      if ((startAttempted && !command) || postrunAttempted || releaseAttempted || timedOut) {
	freezeNow();
	return quarantine('ambiguous start, postrun or release');
      }
      try {
	await settle('stop');
	if (terminal !== undefined) return quarantine('lease loss during refusal');
	if (await finish(order, stopped ? 'routed-stop' : 'routed-refusal', cleanup,
	  false, stopped)) return stopped ? 'killed' : 'unresolved-instructions';
      } catch (closureError) {
	opts.err(`owenloop work exec: routed closure uncertain: ${message(closureError)}`);
      }
      return quarantine('refusal could not prove closure');
    }
  }

  let stopWaiter: (() => void) | undefined;
  function stop(): void {
    if (stopped) return;
    stopped = true;
    abort.abort();
    consequenceAbort.abort();
    freezeNow();
    startGroupSettlement('stop');
    stopWaiter?.();
    // Heartbeat stays active until the bounded closure attempt completes.
    // A controller loss is quarantined; ordinary final-breath release is never used.
  }
  return { run, stop };
}
