/** Credential-free routed agent composition, still held behind agent-run's
 * top-level startup fence until provider resume/terminal acceptance is proven. */
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { createAgentRunLoop, type AgentRunOutcome } from '../agent/loop.ts';
import { resolveCacheDir } from '../bundle/cache.ts';
import { createConsumedVerifier, type ConsumedVerifier } from '../consumed-verifier.ts';
import { adapterFor, registeredHarnessIds } from '../harness/registry.ts';
import { appendSession, sessionsPath } from '../harness/session-store.ts';
import { allocateRoutedFileCache } from '../hub/routed-file-cache.ts';
import type { ContactHolder, OrderPacket } from '../hub/types.ts';
import { createTrustedRoutedInputV2Admission } from '../hosted/trusted-input-admission.ts';
import { createBrokerRoutedReferenceV2Reader } from '../hosted/trusted-routed-reference-v2.ts';
import type { RoutingHandoffV1 } from '../shift/runtime.ts';
import { createRoutedAgentSelection } from './routing-agent-launch.ts';
import { createRoutedAgentLifecycle } from './routing-agent-lifecycle.ts';
import { createRoutedAgentStepLoader } from './routing-agent-step.ts';
import { assertRoutedAgentWorkdirDisjoint, planRoutedAgentWorkdir } from './routing-agent-workdir.ts';
import { createRoutingHolderHandoff } from './routing-holder-handoff.ts';
import { createRoutingRoleClient } from './routing-role-client.ts';
import { openRoutingRoleStage } from './routing-role-stage.ts';
import { routedWorkerEnv } from './routing-role-env.ts';
import { routedProducerVerifier } from './routing-producer-verifier.ts';

const refused = (): Error => new Error('routed agent role refused');

function replaceProcessEnv(next: Record<string, string | undefined>): () => void {
  const previous = { ...process.env };
  const install = (env: Record<string, string | undefined>) => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  };
  install(next);
  return () => install(previous);
}

/** Build all child authority from the one-use Shift handoff. No settings,
 * resolveBearer, account store, or private signer enters this composition. */
export async function prepareRoutedAgentRunner(args: {
  handoff: RoutingHandoffV1;
  originalEnv: Record<string, string | undefined>;
  out: (line: string) => void; err: (line: string) => void;
  heartbeatIntervalMs?: number; jumpToleranceMs?: number;
  submitGraceMs?: number; confirmIntervalMs?: number;
}): Promise<{ loop: ReturnType<typeof createAgentRunLoop>;
  run(): Promise<AgentRunOutcome> }> {
  const { handoff } = args;
  if (handoff.reservation.childKind !== 'agent-run' || !handoff.definitionStage
    || !handoff.broker || !handoff.holderBroker || !handoff.workRoot) throw refused();
  const client = createRoutingRoleClient(handoff);
  const stage = openRoutingRoleStage(handoff);
  const HOME = stage.publicEnv.HOME, OWENLOOP_CONFIG_DIR = stage.publicEnv.OWENLOOP_CONFIG_DIR;
  if (!HOME || !OWENLOOP_CONFIG_DIR) throw refused();
  const publicEnv = { HOME, OWENLOOP_CONFIG_DIR };
  const planned = planRoutedAgentWorkdir({ workRoot: handoff.workRoot,
    ...(handoff.workRepo ? { workRepo: handoff.workRepo } : {}),
    workflow: handoff.reservation.workflow, run: handoff.reservation.run,
    definitionStagePath: handoff.definitionStage.path,
    originalEnv: args.originalEnv, publicEnv, err: args.err });
  const providerEnv = routedWorkerEnv(args.originalEnv, publicEnv);
  // Cache custody is inside the durable stage owner marker. A post-gate role
  // exit cannot prove vendor descendants stopped reading, so this runner does
  // not delete the cache on exit. Shift's stage lifecycle owns the bytes.
  const cache = allocateRoutedFileCache(handoff.definitionStage.path);
  let holderHandoff: ReturnType<typeof createRoutingHolderHandoff> | undefined;
  try {
  const workflow = handoff.reservation.workflow, run = handoff.reservation.run;
  // The role contacts with its exact retained PID. Only the nested MCP holder
  // subcap uses the original routing session holder identity.
  const holder: ContactHolder = { kind: 'exec', id: `${hostname()}:${process.pid}`,
    shiftId: handoff.shiftId };
  const strictConsumed = createConsumedVerifier({ env: publicEnv,
    now: Date.now, artifactPolicy: 'enforce' });
  const consumedVerifier: ConsumedVerifier = routedProducerVerifier(strictConsumed);
  let admittedPacket: OrderPacket | undefined;
  const observedInput = createTrustedRoutedInputV2Admission({
    reader: createBrokerRoutedReferenceV2Reader(client.routed, { workflow, run },
      () => performance.now()),
    instructions: stage.instructions, consumedVerifier,
    expected: { workflow, run }, monotonicNow: () => performance.now(),
  });
  const sessionsFile = sessionsPath(resolveCacheDir(publicEnv));
  const lifecycle = createRoutedAgentLifecycle({ child: client.routed,
    generation: `${handoff.incarnation}:${handoff.nonce}:${run}` });
  const sessionHolder: ContactHolder = { kind: 'session', id: handoff.sessionId,
    shiftId: handoff.shiftId };
  const select = createRoutedAgentSelection({ child: client.routed, sessionHolder,
    roleHolder: holder, workflow, frameWorkflow: stage.frameWorkflow,
    definitionName: stage.definitionName, run,
    beforeFinalCheck: (order) => {
      if (order.workdir === undefined) planned.materialize();
      else assertRoutedAgentWorkdirDisjoint(order.workdir, dirname(handoff.definitionStage!.path));
    } });
  const loop = createAgentRunLoop({
    hub: client, workflow, run, holder, origin: handoff.origin, account: 'routed',
    shiftId: handoff.shiftId,
    ...(args.originalEnv.OWENLOOP_SHIFT_NAME ? { shiftName: args.originalEnv.OWENLOOP_SHIFT_NAME } : {}),
    ...(args.originalEnv.OWENLOOP_SHIFT_OWNER ? { shiftOwner: args.originalEnv.OWENLOOP_SHIFT_OWNER } : {}),
    cwd: planned.cwd, allowedWorkdirRoots: planned.allowedWorkdirRoots,
    loadStep: createRoutedAgentStepLoader({ instructions: stage.instructions,
      instructionCwd: handoff.definitionStage.path, workflow, run, err: args.err,
      admittedRoutedInputV2: order => !!admittedPacket && isDeepStrictEqual(admittedPacket, order) }),
    resolveAdapter: (chosenHarness, stepHarness) => {
      const id = chosenHarness ?? stepHarness ?? '';
      const adapter = id === 'codex' ? adapterFor(id) : undefined;
      return { id: id || '<none>', ...(adapter ? { adapter } : {}),
	registered: registeredHarnessIds() };
    },
    resolveCrewRosters: crew => ({ ok: false, crew: crew[0] ?? 'routed',
      detail: 'routed server selection required' }),
    harnessAvailable: id => id === 'codex' && adapterFor(id) !== undefined,
    consumedVerifier,
    routedInputV2: { observe: async order => {
      if (order.workflow !== stage.frameWorkflow
	|| order.routing?.claim.binding.def.workflowName !== stage.definitionName)
	return { ok: false, reason: 'routed-stage-frame-changed' };
      const result = await observedInput.observe(order);
      admittedPacket = result.ok ? structuredClone(order) : undefined;
      return result;
    } },
    routedSelect: (order, signal) => select(order, signal),
    routedLifecycle: lifecycle,
    createRoutingHolderPath: () => {
      if (holderHandoff) throw refused();
      holderHandoff = createRoutingHolderHandoff(handoff, cache.custodyRoot);
      return holderHandoff.path;
    },
    routedFileCacheRoot: cache.publishedRoot,
    appendSession: rec => appendSession(sessionsFile, rec),
    nextAttempt: () => 1,
    latestSession: () => null,
    latestRunSession: () => null,
    sleep: ms => new Promise<void>(resolve => setTimeout(resolve, ms)),
    now: Date.now, out: args.out, err: args.err,
    heartbeatIntervalMs: args.heartbeatIntervalMs ?? 60_000,
    ...(args.jumpToleranceMs ? { jumpToleranceMs: args.jumpToleranceMs } : {}),
    ...(args.submitGraceMs ? { submitGraceMs: args.submitGraceMs } : {}),
    ...(args.confirmIntervalMs ? { confirmIntervalMs: args.confirmIntervalMs } : {}),
  });
  return { loop, run: async () => {
    const restore = replaceProcessEnv(providerEnv);
    let outcome: AgentRunOutcome = 'routed-quarantined';
    try { outcome = await loop.run(); return outcome; }
    catch {
      lifecycle.requestStop();
      await lifecycle.complete('stop').catch(() => 'uncertain');
      throw refused();
    }
    finally {
      restore();
      // Unknown mutation or group state keeps the holder/cache custody for
      // exact parent recovery; a role exit is not a cleanup proof.
      if (outcome !== 'routed-quarantined') {
	holderHandoff?.cleanup();
	await cache.cleanup();
      }
    }
  } };
  } catch {
    holderHandoff?.cleanup();
    await cache.cleanup();
    throw refused();
  }
}
