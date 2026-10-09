/** Credential-free routed command role composition. The production role entry
 * remains fenced until the joined Worker/broker/real-shell acceptance passes. */
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { createConsumedVerifier, type ConsumedVerifier } from '../consumed-verifier.ts';
import type { ExecLoop, ExecLoopOptions, ExecOutcome } from '../exec/loop.ts';
import { createRoutedGroupRunner } from '../exec/runner.ts';
import { createShiftVerifiedRoutedExecLoop, type RoutedExecutionController } from '../exec/routed-loop.ts';
import type { ContactHolder } from '../hub/types.ts';
import { RoutingBrokerTransportLoss } from '../hub/routing-child-client.ts';
import { createTrustedRoutedInputV2Admission } from '../hosted/trusted-input-admission.ts';
import { createBrokerRoutedReferenceV2Reader } from '../hosted/trusted-routed-reference-v2.ts';
import type { RoutingHandoffV1 } from '../shift/runtime.ts';
import { commandPostrunBodyDigest } from '../shift/routing-command-postrun.ts';
import { createRoutedCommandPrestart } from './routing-command-launch.ts';
import { assertRoutedAgentWorkdirDisjoint, planRoutedAgentWorkdir } from './routing-agent-workdir.ts';
import { createRoutingRoleClient } from './routing-role-client.ts';
import { openRoutingRoleStage } from './routing-role-stage.ts';
import { routedProducerVerifier } from './routing-producer-verifier.ts';

const refused = (): Error => new Error('routed command role refused');

/** All authority comes from one consumed Shift handoff and its private broker.
 * The child neither reads an account token nor invokes a broad Hub write. */
export async function prepareRoutedCommandRunner(args: {
  handoff: RoutingHandoffV1;
  originalEnv: Record<string, string | undefined>;
  out: (line: string) => void; err: (line: string) => void;
  heartbeatIntervalMs?: number; jumpToleranceMs?: number;
}): Promise<{ loop: ExecLoop; run(): Promise<ExecOutcome> }> {
  const { handoff } = args;
  if (handoff.reservation.childKind !== 'exec' || !handoff.definitionStage
    || !handoff.broker || !handoff.workRoot) throw refused();
  const root = handoff.reservation.workflow, run = handoff.reservation.run;
  const client = createRoutingRoleClient(handoff);
  const child = client.routed;
  const stage = openRoutingRoleStage(handoff, child);
  const HOME = stage.publicEnv.HOME;
  const OWENLOOP_CONFIG_DIR = stage.publicEnv.OWENLOOP_CONFIG_DIR;
  if (!HOME || !OWENLOOP_CONFIG_DIR) throw refused();
  const publicEnv = { HOME, OWENLOOP_CONFIG_DIR };
  const holder: ContactHolder = { kind: 'exec', id: `${hostname()}:${process.pid}`,
    shiftId: handoff.shiftId };

  // The original-session read is parent authenticated. It supplies the exact
  // signed child frame; the URL/CLI target remains the canonical root.
  let frameId: string;
  try {
    const fresh = await child.readRoutingClaim({ workflow: root, run });
    const claim = fresh.routing.claim;
    frameId = claim.binding.frameId;
    if (fresh.freshness !== 'fresh-at-read' || fresh.atomicLaunch !== false
      || !frameId || frameId !== stage.frameWorkflow
      || claim.binding.def.workflowName !== stage.definitionName
      || claim.orderId !== run || claim.binding.runId !== root
      || claim.sessionId !== handoff.sessionId || claim.shiftId !== handoff.shiftId)
      throw refused();
  } catch { throw refused(); }

  const planned = planRoutedAgentWorkdir({ workRoot: handoff.workRoot,
    ...(handoff.workRepo ? { workRepo: handoff.workRepo } : {}),
    workflow: root, run, definitionStagePath: handoff.definitionStage.path,
    originalEnv: args.originalEnv, publicEnv, err: args.err });
  const strictConsumed = createConsumedVerifier({ env: publicEnv,
    now: Date.now, artifactPolicy: 'enforce' });
  const consumedVerifier: ConsumedVerifier = routedProducerVerifier(strictConsumed);
  const observedInput = createTrustedRoutedInputV2Admission({
    reader: createBrokerRoutedReferenceV2Reader(child, { workflow: root, run },
      () => performance.now()),
    instructions: stage.instructions, consumedVerifier,
    expected: { workflow: root, run }, monotonicNow: () => performance.now(),
  });
  const oneUse = createRoutedCommandPrestart({ child, holder, workflow: root, frameId, run,
    privateBase: handoff.definitionStage.path, inputAdmission: observedInput,
    beforeFinalCheck: (order) => {
      if (order.workdir === undefined) planned.materialize();
      else assertRoutedAgentWorkdirDisjoint(order.workdir, dirname(handoff.definitionStage!.path));
    } });
  const controller: RoutedExecutionController = {
    frameId, runner: createRoutedGroupRunner(),
    prestart: (order, signal) => {
      if (order.workdir !== undefined)
	assertRoutedAgentWorkdirDisjoint(order.workdir, dirname(handoff.definitionStage!.path));
      return oneUse(order, signal);
    },
    quiesce: async (ctx) => {
      if (ctx.signal.aborted || performance.now() >= ctx.deadlineAt) throw refused();
      return child.quiesce();
    },
    postrun: async ({ result, payload, receipt, group }, ctx) => {
      if (ctx.signal.aborted || performance.now() >= ctx.deadlineAt
	|| group.scope !== 'original-posix-group' || group.state !== 'empty') throw refused();
      const { payloadLine: _line, payloadOverCap: _overCap, ...dataResult } = result;
      const request = { result: dataResult, receipt,
	parsed: { ...(payload.reject ? { reject: payload.reject } : {}),
	  ...(payload.payloadError ? { payloadError: payload.payloadError } : {}) },
	group: { scope: 'original-posix-group' as const, state: 'empty' as const } };
      const bodyDigest = commandPostrunBodyDigest(request);
      const remaining = () => Math.floor(ctx.deadlineAt - performance.now());
      try {
	if (remaining() <= 0 || ctx.signal.aborted) throw refused();
	const answer = await child.commandPostrun(request, ctx.signal, Math.min(30_000, remaining()));
	if (remaining() <= 0 || ctx.signal.aborted) throw refused();
	return answer;
      } catch (error) {
	// A semantic refusal or malformed parent response is never converted to
	// success. Only a lost socket may query a result the parent cached already.
	if (!(error instanceof RoutingBrokerTransportLoss) || ctx.signal.aborted) throw error;
      }
      const recoveryDeadlineAt = Math.min(ctx.deadlineAt, performance.now() + 10_000);
      const recoveryRemaining = () => Math.floor(recoveryDeadlineAt - performance.now());
      while (recoveryRemaining() > 0 && !ctx.signal.aborted) {
	const status = await child.commandPostrunStatus(bodyDigest, ctx.signal,
	  Math.min(1_000, recoveryRemaining()));
	if (recoveryRemaining() <= 0 || ctx.signal.aborted) throw refused();
	if (status.state === 'committed') return status.result;
	if (status.state === 'unavailable') break;
	await delay(Math.min(50, recoveryRemaining()), undefined, { signal: ctx.signal });
      }
      throw refused();
    },
    targetedRelease: async (_order, _reason, observation, ctx) => {
      if (ctx.signal.aborted || performance.now() >= ctx.deadlineAt) throw refused();
      const result = await child.commandFinish(observation);
      return result.state;
    },
  };
  // LeaseLoop races its interval sleep against stop, but that leaves the
  // losing timer live. Retain and clear only this role's timers after run()
  // settles so a completed child never waits another heartbeat interval to exit.
  const pendingSleeps = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
  const sleep = (ms: number) => new Promise<void>(resolve => {
    const pending = { timer: undefined as unknown as ReturnType<typeof setTimeout>, resolve };
    pending.timer = setTimeout(() => { pendingSleeps.delete(pending); resolve(); }, ms);
    pendingSleeps.add(pending);
  });
  const loopOptions: ExecLoopOptions = { hub: client, runner: controller.runner,
    workflow: root, run, holder, instructions: stage.instructions,
    routedExecution: controller, routedPublicEnv: publicEnv,
    cwd: planned.cwd, allowedWorkdirRoots: planned.allowedWorkdirRoots,
    env: args.originalEnv, out: args.out, err: args.err,
    sleep, now: Date.now,
    ...(args.heartbeatIntervalMs ? { heartbeatIntervalMs: args.heartbeatIntervalMs } : {}),
    ...(args.jumpToleranceMs ? { jumpToleranceMs: args.jumpToleranceMs } : {}),
  };
  const rawLoop = createShiftVerifiedRoutedExecLoop(loopOptions, controller);
  const runRole = async (): Promise<ExecOutcome> => {
    try { return await rawLoop.run(); }
    finally {
      for (const pending of pendingSleeps) { clearTimeout(pending.timer); pending.resolve(); }
      pendingSleeps.clear();
    }
  };
  const loop: ExecLoop = { run: runRole, stop: () => rawLoop.stop() };
  return { loop, run: runRole };
}
