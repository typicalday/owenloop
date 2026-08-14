/**
 * The `agent-run` orchestration core (Phase 3) — the detached, self-leasing
 * worker that HOSTS one step agent instead of stamping a file for someone else
 * to run.
 *
 * It is `src/exec/loop.ts` for AGENT orders: same shared lease loop, same
 * first-contact race, same `mapNoHold`, same `stop()` guard, every side effect
 * injected (hub, adapter resolution, step material, session-store writer,
 * sleep/clock, output sinks) so tests drive it with fakes and no real process.
 *
 * ══ THE INVARIANT ══
 *
 * The step agent signals TASK completion by calling the `submit` MCP tool inside
 * the mounted `owenloop work hold --mcp` grandchild. This worker learns of that ONLY
 * from the hub lease outcome — `createLeaseLoop().run()` resolving `'completed'`,
 * or a direct `hub.getOrder` seeing `lease.outcome`. The harness stream
 * (`AgentEvent`) and the SETTLING of `adapter.start()` are telemetry and
 * liveness only, and are never evidence of task success or failure.
 *
 * The trap this design exists to avoid: `start()` resolves at TURN end, which
 * happens within milliseconds of the agent calling `submit`, while the worker's
 * next lease heartbeat may be a full `heartbeatIntervalMs` away. A worker that
 * read "`start()` settled with no outcome yet" as "the agent did not submit"
 * would RELEASE a run that had just completed, and the hub would re-offer a
 * closed order. So `start()` settling never releases. It only:
 *
 *   1. writes the session record `turn-ended`; then
 *   2. enters the bounded CONFIRM phase (`confirmOutcome` below), racing the
 *      lease loop against a short-cadence `hub.getOrder` poll.
 *
 * ══ THE CLOSED CONTRACT QUESTION ══
 *
 * `docs/agent-runner.md` recorded the promise-settle semantics of a non-resume
 * harness failure as OPEN: `start()` may reject with a plain `Error`, or resolve
 * after emitting `exited`. As the single caller, Phase 3 CLOSES it: BOTH settle
 * paths are treated identically — each writes `turn-ended` and enters the
 * confirm phase, and neither is read as success or failure. Nothing in this file
 * branches on the settle shape.
 *
 * ══ PHASE 4: RESUME ON REJECTION ══
 *
 * Until Phase 4 this loop only ever called `adapter.start(...)`, so a re-offer —
 * including a REJECTION re-offer, where the agent needs to hear three sentences
 * of feedback about work it already did — paid for a whole cold start with the
 * whole brief. `chooseTurn` below now picks one of two paths per firing:
 *
 *   RESUME — `adapter.deliver(prevRef, <the rejection delta>, ...)`. The provider
 *     still holds the original brief, the file reads, the tool results and the
 *     prior submission, so the message is ONLY what is new. Same session token,
 *     `attempt` incremented.
 *   COLD REPLAY — `adapter.start(<brief + a trailing rejection section>, ...)`.
 *     A new session, a new token, `attempt` incremented all the same.
 *
 * The resume/replay decision is spelled out in `chooseTurn`'s own comment. A
 * resume that the provider refuses (`ResumeUnavailableError`) falls back to a
 * cold replay WITHIN THE SAME FIRING — the order is still leased, so handing it
 * back would waste a whole re-offer cycle to learn something already known.
 */
import { existsSync } from 'node:fs';

import { createLeaseLoop, type LeaseOutcome } from '../lease/loop.ts';
import type { HubClient } from '../hub/client.ts';
import type { ContactHolder, GetOrderResponse, OrderPacket, ResolutionPayload } from '../hub/types.ts';
import type { ConsumedVerifier } from '../consumed-verifier.ts';
import type { NormalizedStepSpec } from '../bundle/types.ts';
import type {
  AgentEvent,
  DeliverArgs,
  HarnessAdapter,
  HarnessSessionRef,
  StartArgs,
} from '../harness/contract.ts';
import { isResumeUnavailable } from '../harness/contract.ts';
import { preflightStepPermissions } from '../harness/permissions.ts';
import { orderId, type SessionRecord, type SessionStatus } from '../harness/session-store.ts';
import {
  buildOwenloopMcp,
  renderBrief,
  renderRejection,
  renderReplayBrief,
  type BriefSpec,
} from './brief.ts';
import {
  resolveCapabilityModel,
  type CapabilityModelMap,
  type CapabilityResolution,
} from './capability-model.ts';

/** Discriminated result of one worker life; the role maps these to exit codes. */
export type AgentRunOutcome =
  | 'submitted' // the hub reported an outcome — the agent's submit landed (exit 0)
  | 'completed' // the order had already finished at first contact (exit 0)
  | 'misroute' // null packet, or a command order — released, not ours (exit 1)
  | 'no-template' // no cached bundle / no step spec for the step (exit 1)
  | 'no-harness' // the resolved harness id names no registered adapter (exit 1)
  | 'incompatible-harness-policy' // selected adapter cannot enforce the restrictions (exit 1)
  | 'unresolvable-capability' // no settings row for the order's capabilities (exit 1)
  | 'unverified-consumed' // dynamic values or rejection reasons failed verification (exit 1)
  | 'session-store-failed' // durable active-row gate failed before provider work (exit 1)
  | 'no-submit' // the turn ended and the confirm grace expired with no outcome (exit 1)
  | 'killed' // a signal aimed at the worker tore the session down + released (exit 1)
  | 'lease-lost' // the lease went terminal without an outcome (exit 1)
  | 'ownership-error' // 403 — the run is not ours (exit 1)
  | 'hub-unreachable' // transient failures spanned the window (exit 1)
  | 'stopped'; // stop() arrived before the hold was established (exit 1)

/**
 * Locate the normalized step spec for an order. Injected because the lookup is
 * I/O (the verified workflow store) and because resolving the local definition
 * is the role's business, not the loop's. `null` means instruction resolution
 * refused; the loop releases and leaves the order for the pickup window.
 *
 * The spec arrives already normalized from the verified `StepDef` — brief,
 * harness id, and `StepPermissions`. The loop stays vendor-neutral: it never
 * reaches into a step definition's extension bag, so there is no key to name.
 */
export type StepLoader = (order: OrderPacket) => Promise<NormalizedStepSpec | null>;

/**
 * The outcome of resolving which adapter hosts this step agent.
 *
 * The loop never reads a registry and never names a harness: the role
 * (`src/roles/agent-run.ts`, the composition root) owns the precedence
 * `--harness` > `OWENLOOP_HARNESS` > the step def's `harness` field > the
 * built-in default, and hands back the id it picked plus the adapter, if any.
 * `registered` is only ever used to make the failure message actionable.
 */
export interface AdapterResolution {
  id: string;
  adapter?: HarnessAdapter;
  registered: string[];
}

/** `stepHarness` is the step def's `harness` field, the third precedence rank. */
export type AdapterResolver = (stepHarness: string | undefined) => AdapterResolution;

/** Default confirm-phase cadence: one `get_order` per second. */
export const DEFAULT_CONFIRM_INTERVAL_MS = 1_000;
/** Default confirm-phase bound: give the hub 15s to show the submit's outcome. */
export const DEFAULT_SUBMIT_GRACE_MS = 15_000;

export interface AgentRunLoopOptions {
  hub: HubClient;
  workflow: string;
  run: string;
  /** The worker's holder tag `{kind:'exec', id}` — `'exec'` is drain-exempt. */
  holder: ContactHolder;
  /** Hub origin — rides the mounted work-holder's `--origin`. */
  origin: string;
  /** Scoped Identity account — rides the mounted work-holder's `--as`. */
  account: string;
  /** Advisory Shift attribution — rides `--shift=<cid>` (may be absent). */
  shiftId?: string;
  /** cwd for the step agent when the order packet carries no `workdir`. */
  cwd: string;
  loadStep: StepLoader;
  resolveAdapter: AdapterResolver;
  /**
   * THIS MACHINE'S capability → `{model, effort}` map, straight from the
   * settings file (plan §5). The loop resolves the order's composed capabilities
   * against it before dispatch and REFUSES the order when nothing matches —
   * there is no default model here, by design.
   *
   * Absent (or empty) means the shift declared no map at all, which makes every
   * capability-bearing order unresolvable. That is deliberate: a shift that
   * forgot its map should say so on the first order, not run everything on a
   * hardcoded model.
   */
  capabilityModels?: CapabilityModelMap;
  /** Gate dynamic values and rejection reasons before any prompt rendering. */
  consumedVerifier?: ConsumedVerifier;
  /** Append one session record. Wired to `appendSession` by the role. */
  appendSession: (rec: SessionRecord) => void;
  /** The attempt number for this `(workflow, run, step)`. Wired to `latestFor`. */
  nextAttempt: (workflow: string, run: string, step: string) => number;
  /**
   * PHASE 4 — the last session record for this `(workflow, run, step)`, or `null`
   * when the step has never run here. Wired to `latestFor(sessionsFile, ...)` by
   * the role, the same reader `nextAttempt` already uses.
   *
   * It is what makes a resume possible at all: the prior `token` to resume, the
   * `harness` that minted it, the `cwd` it is scoped to, and the
   * `deliveredReasonAt` watermark that says which reasons the session has already
   * heard. Absent (or returning `null`) ⇒ every firing is a cold start, which is
   * exactly the pre-Phase-4 behaviour.
   */
  latestSession?: (workflow: string, run: string, step: string) => SessionRecord | null;
  /**
   * Does this directory still exist? Injected for the same reason every other
   * side effect here is: a unit test drives the "the work dir was reaped, so the
   * session cannot resume" branch without touching a filesystem. Defaults to
   * `node:fs` `existsSync`.
   */
  dirExists?: (path: string) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random?: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
  heartbeatIntervalMs?: number;
  jumpToleranceMs?: number;
  failureWindowMs?: number;
  /** Confirm-phase poll cadence (default `DEFAULT_CONFIRM_INTERVAL_MS`). */
  confirmIntervalMs?: number;
  /** Confirm-phase upper bound (default `DEFAULT_SUBMIT_GRACE_MS`). */
  submitGraceMs?: number;
}

export interface AgentRunLoop {
  run(): Promise<AgentRunOutcome>;
  /** Final breath: tear the session down and release. Wired to SIGINT/SIGTERM. */
  stop(reason?: string): void;
}

/** How the bounded confirm phase ended. */
export type ConfirmResult = 'submitted' | 'lease-lost' | 'no-submit';

export interface ConfirmOptions {
  hub: HubClient;
  workflow: string;
  run: string;
  holder: ContactHolder;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  err: (line: string) => void;
  intervalMs: number;
  graceMs: number;
  /**
   * Bail out early. Set once the caller's race is already decided (the lease
   * loop settled, or a signal arrived), so a pending poll cannot hold the event
   * loop open for the rest of the grace. The returned value is discarded in
   * that case.
   */
  cancelled?: () => boolean;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * How this order's model was decided.
 *
 *   `resolved`  — a settings row matched; `resolution` names it, plus the model
 *                 and effort the harness starts with.
 *   `refused`   — the order named capabilities and NONE of them, exact or bare,
 *                 has a row. The order is handed back; nothing launches. Plan
 *                 §5: "never a silent default model".
 *   `unrouted`  — the order named NO capabilities at all, so there is nothing to
 *                 look up. This is not a failure: a def that declares no
 *                 `modifiers:` may author capability-silent steps, and those
 *                 have always run at the harness's own default model. The loop
 *                 passes no model and no effort, exactly as it did for a step
 *                 with no authored tier before this scheme existed.
 */
export type OrderRouting =
  | { kind: 'resolved'; resolution: CapabilityResolution }
  | { kind: 'refused'; capabilities: readonly string[] }
  | { kind: 'unrouted' };

/**
 * Resolve an order's composed capabilities against this machine's map.
 *
 * ONLY `packet.capabilities` is consulted. `packet.model` — the def's authored
 * tier name under the retired scheme — is deliberately ignored: a tier is an
 * abstract rung with no meaning left, and reading it as a model id would put a
 * literal `strong` on the wire to a vendor.
 */
export function resolveOrderRouting(
  packet: OrderPacket,
  map: CapabilityModelMap | undefined,
): OrderRouting {
  const capabilities = packet.capabilities ?? [];
  if (capabilities.length === 0) return { kind: 'unrouted' };
  const resolution = map === undefined ? undefined : resolveCapabilityModel(map, capabilities);
  return resolution === undefined ? { kind: 'refused', capabilities } : { kind: 'resolved', resolution };
}

/**
 * Poll `get_order` at `intervalMs` for at most `graceMs`, answering ONE
 * question: did the hub see the agent's `submit`?
 *
 *  - `lease.outcome` present  ⇒ `'submitted'` — the run closed.
 *  - `lease.claimed === false` with no outcome ⇒ `'lease-lost'` — something
 *    else took the run; releasing would be wrong and a submit would race it.
 *  - the grace expires, still claimed, still no outcome ⇒ `'no-submit'`.
 *
 * It calls `hub.getOrder` DIRECTLY rather than poking the lease loop:
 * `LeaseLoop`'s public surface is `{run, stop}` with no probe-now method, and
 * `src/lease/loop.ts` is load-bearing for six existing drills and must stay
 * unchanged. Re-calling `get_order` while already holding the claim is exactly
 * what the lease loop's own heartbeat does, so this adds no new hub semantics.
 *
 * A throwing `get_order` is transient by assumption: it is logged and the poll
 * continues until the grace expires. Nothing here releases; only the caller does.
 */
export async function confirmOutcome(o: ConfirmOptions): Promise<ConfirmResult> {
  const deadline = o.now() + o.graceMs;
  for (;;) {
    if (o.cancelled?.() === true) return 'no-submit';
    let res: GetOrderResponse | undefined;
    try {
      res = await o.hub.getOrder({ workflow: o.workflow, run: o.run, holder: o.holder });
    } catch (e) {
      o.err(`owenloop work agent-run: confirm get_order failed: ${errMsg(e)} (retrying within the grace)`);
    }
    if (res !== undefined) {
      if (res.lease.outcome !== undefined) return 'submitted';
      if (res.lease.claimed === false) return 'lease-lost';
    }
    if (o.now() >= deadline) return 'no-submit';
    await o.sleep(o.intervalMs);
  }
}

export function createAgentRunLoop(opts: AgentRunLoopOptions): AgentRunLoop {
  const { hub, workflow } = opts;
  const runId = opts.run;
  const order = orderId(workflow, runId);

  let signalled = false;
  let leaseSettled = false;
  let torndown = false;
  let leasePromise: Promise<LeaseOutcome> | undefined;
  let adapter: HarnessAdapter | undefined;
  let sessionRef: HarnessSessionRef | undefined;
  let adapterId = '';
  let stepName = '';
  let attempt = 1;
  let createdAt = 0;
  let recordCwd = opts.cwd;
  /** The watermark written on every record this firing produces — see
   *  `SessionRecord.deliveredReasonAt`. Carried forward from the prior record
   *  when this firing delivered no new reasons, so it can never regress. */
  let deliveredReasonAt: number | undefined;
  /** Captures a thrown safety-gate append from the synchronous `started` event. */
  let activePersistenceFailure: unknown;

  let resolveOrder: ((res: GetOrderResponse) => void) | undefined;
  const orderReady = new Promise<GetOrderResponse>((r) => {
    resolveOrder = r;
  });

  const lease = createLeaseLoop({
    hub,
    workflow,
    run: runId,
    role: 'agent-run',
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

  /**
   * Append one session record. `harness`/`token` come from the `started` event's
   * ref when there is one; before that event (a harness that died on launch)
   * they fall back to the resolved adapter id and an empty token, so the store
   * still shows the attempt existed and died.
   */
  function record(status: SessionStatus): void {
    if (stepName === '') return; // no order packet yet — nothing to key a record by
    const at = opts.now();
    if (createdAt === 0) createdAt = at;
    opts.appendSession({
      workflow,
      run: runId,
      step: stepName,
      order,
      attempt,
      harness: sessionRef?.harness ?? adapterId,
      token: sessionRef?.token ?? '',
      cwd: recordCwd,
      status,
      createdAt,
      ...(deliveredReasonAt !== undefined ? { deliveredReasonAt } : {}),
      updatedAt: at,
    });
  }

  /**
   * Tear the harness session down. Guarded so the signal path and the normal
   * end-of-run path together still stop the session exactly once; never throws.
   */
  async function teardown(): Promise<void> {
    if (adapter === undefined || sessionRef === undefined || torndown) return;
    torndown = true;
    try {
      await adapter.stop(sessionRef);
    } catch (e) {
      opts.err(`owenloop work agent-run: adapter stop failed: ${errMsg(e)} (ignored)`);
    }
  }

  /** A first-contact / no-hold lease outcome → worker outcome. Mirrors exec. */
  function mapNoHold(o: LeaseOutcome): AgentRunOutcome {
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

  /**
   * A lease outcome observed while the turn was still running.
   *
   * `'completed'` here is a SUCCESS, not a failure: the agent called `submit`
   * and the lease loop's heartbeat saw the outcome before the model turn ended.
   */
  function mapLeaseDuringTurn(o: LeaseOutcome): AgentRunOutcome {
    if (o === 'completed') return 'submitted';
    if (o === 'ownership-error') return 'ownership-error';
    if (o === 'hub-unreachable') return 'hub-unreachable';
    return 'lease-lost';
  }

  /** Log one harness event. Telemetry only — nothing here decides an outcome. */
  function onEvent(e: AgentEvent): void {
    switch (e.kind) {
      case 'started':
        sessionRef = e.ref;
        opts.err(`owenloop work agent-run: session started for ${order} (harness '${e.ref.harness}')`);
	// This synchronous event is the cold-start gate. The adapter must not
	// begin provider work until the callback returns. A thrown durable append
	// therefore aborts the turn before delivery and is handled separately
	// from an ordinary harness failure below.
	try {
	  record('active');
	} catch (error) {
	  activePersistenceFailure = error;
	  throw error;
	}
        return;
      case 'progress':
        opts.err(`owenloop work agent-run: ${e.text}`);
        return;
      case 'needs_input':
        opts.err(
          `owenloop work agent-run: WARNING the step agent asked for input and this contract has no reply channel — ${e.question}`,
        );
        return;
      case 'turn_ended':
        opts.err(`owenloop work agent-run: turn ended for ${order} (telemetry — the hub decides the outcome)`);
        return;
      case 'exited':
        opts.err(
          `owenloop work agent-run: harness exited (code ${String(e.exitCode)}${e.error !== undefined ? `, ${e.error}` : ''}) — telemetry only, ignored for the outcome`,
        );
        return;
    }
  }

  /**
   * Tell the hub what this shift resolved the order to (plan §6), before the
   * harness launches.
   *
   * BEST EFFORT, ALWAYS. A hub that is unreachable, older than the verb, or
   * simply erroring must never be able to stop work the shift is otherwise
   * ready to do — the report is observability, not a gate, and the hub's own
   * verb says so. A failure is logged and swallowed.
   *
   * An `unrouted` order is not reported at all: the payload's `capability` is
   * required and non-empty on the hub side, and there is no capability to name.
   */
  async function reportResolution(routing: OrderRouting, harness: string): Promise<void> {
    if (routing.kind === 'unrouted') return;
    const payload: ResolutionPayload =
      routing.kind === 'resolved'
        ? {
            capability: routing.resolution.capability,
            match: routing.resolution.match,
            model: routing.resolution.model,
            effort: routing.resolution.effort,
            harness,
          }
        : // The refusal names the capability the order was OFFERED under — the
          // first one — because that is the row an operator has to add. Model
          // and effort are absent: nothing was selected.
          { capability: routing.capabilities[0] ?? '', match: 'refused', harness };
    try {
      await opts.hub.reportResolution({ workflow, run: runId, resolution: payload });
    } catch (e) {
      opts.err(`owenloop work agent-run: reporting the resolution for ${order} failed (continuing): ${errMsg(e)}`);
    }
  }

  /** Release and finish. Used by every path that hands the order back. */
  async function releaseWith(reason: string, outcome: AgentRunOutcome): Promise<AgentRunOutcome> {
    lease.stop(reason);
    await leasePromise;
    return outcome;
  }

  async function run(): Promise<AgentRunOutcome> {
    leasePromise = lease.run();
    void leasePromise.then(() => {
      leaseSettled = true;
    });

    // First contact race: the order arrives (hold established), or the lease
    // resolves terminally before we ever established it.
    const first = await Promise.race([
      orderReady.then((res) => ({ t: 'order' as const, res })),
      leasePromise.then((o) => ({ t: 'lease' as const, o })),
    ]);
    if (first.t === 'lease') return mapNoHold(first.o);

    let packet = first.res.order;
    if (packet === null || packet.worker === 'command') {
      opts.err(`owenloop work agent-run: ${order} is not an agent order (misroute) — releasing`);
      return releaseWith('misroute', 'misroute');
    }

    // Consume-side verification is the prompt boundary. Do this before loading
    // or rendering any step brief: `owes[].reasons` is dynamic text supplied by
    // the transport, and an unverified rejection thread must never reach a
    // provider session. The same whole-order gate also protects `consumes`.
    const hasConsumedData =
      Object.keys(packet.consumes).length > 0
      || packet.owes.some((owed) => owed.reasons.length > 0 || owed.proof !== undefined);
    if (hasConsumedData) {
      if (opts.consumedVerifier === undefined) {
        const detail =
          `consume-side verifier is not configured; dynamic values cannot be admitted to an agent prompt`;
        opts.err(`owenloop work agent-run: consumed artifact refusal (prerequisite) for ${order}: ${detail}`);
        return releaseWith('unverified-consumed', 'unverified-consumed');
      }
      try {
        const checked = await opts.consumedVerifier(packet, { hardRule: false });
        if (!checked.ok) {
          opts.err(`owenloop work agent-run: ${checked.reason} — releasing ${order}`);
          return releaseWith('unverified-consumed', 'unverified-consumed');
        }
        packet = checked.order;
        for (const warning of checked.warnings) opts.err(warning);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        opts.err(`owenloop work agent-run: consumed artifact refusal (prerequisite) for ${order}: ${detail} — releasing`);
        return releaseWith('unverified-consumed', 'unverified-consumed');
      }
    }

    stepName = packet.step;
    recordCwd = packet.workdir ?? opts.cwd;

    // The step spec. No bundle / no spec ⇒ we cannot brief anybody; release so
    // the order lapses back through the hub's pickup window.
    let material: NormalizedStepSpec | null;
    try {
      material = await opts.loadStep(packet);
    } catch (e) {
      opts.err(`owenloop work agent-run: loading the step spec for ${order} failed: ${errMsg(e)}`);
      material = null;
    }
    if (material === null) {
      opts.err(`owenloop work agent-run: no step spec for '${packet.step}' — releasing for the pickup window`);
      return releaseWith('no-template', 'no-template');
    }
    /** `material` is a `let`, so its null-narrowing does not survive into the
     *  closures below. This const carries the narrowing across. */
    const step: NormalizedStepSpec = material;

    const resolution = opts.resolveAdapter(step.harness);
    adapterId = resolution.id;
    if (resolution.adapter === undefined) {
      const known = resolution.registered.length > 0 ? resolution.registered.join(', ') : '<none>';
      opts.err(`owenloop work agent-run: no adapter registered for harness '${resolution.id}' (registered: ${known}) — releasing`);
      return releaseWith('no-harness', 'no-harness');
    }
    adapter = resolution.adapter;
    /** The same object as `adapter`, but narrowed — the module-scope `adapter`
     *  stays `HarnessAdapter | undefined` for `teardown`/`stop`. */
    const active: HarnessAdapter = resolution.adapter;

    attempt = opts.nextAttempt(workflow, runId, packet.step);

    const spec: BriefSpec = {
      workflow,
      run: runId,
      origin: opts.origin,
      account: opts.account,
      ...(opts.shiftId !== undefined ? { shiftId: opts.shiftId } : {}),
      // Straight from the packet, not from settings: the modifier is the hub's
      // statement about the RUN, and a shift has no say in it.
      ...(packet.modifier !== undefined ? { modifier: packet.modifier } : {}),
      ...(packet.escalated === true ? { escalated: true } : {}),
    };
    // Permissions arrive PRE-NORMALIZED in the spec. `prepare` ran
    // `normalizeStepPermissions` over the step's `x.harness` options at cache
    // time, so this loop never looks inside an extension bag and never has a bag
    // key — vendor-keyed lookup does not exist in neutral code any more.
    const permissions = step.permissions;

    // Mandatory final-boundary preflight. Common checks run first, followed by
    // the selected adapter's exact capability check. A refusal starts neither a
    // cold session nor a resumed provider process; the held claim is released.
    const policyIssues = [
      ...preflightStepPermissions(permissions),
      ...active.preflight(permissions),
    ];
    if (policyIssues.length > 0) {
      for (const issue of policyIssues) {
	opts.err(
	  `owenloop work agent-run: harness policy refusal for ${order} on '${resolution.id}'` +
	    `${issue.field !== undefined ? ` (${issue.field})` : ''}: ${issue.message}`,
	);
      }
      return releaseWith('incompatible-harness-policy', 'incompatible-harness-policy');
    }

    // ---- ROUTING: which model serves this order, and telling the hub --------
    //
    // DELIBERATELY THE LAST GATE BEFORE DISPATCH, and deliberately AFTER every
    // launch gate above (misroute, consumed verification, step spec, adapter,
    // harness policy). Plan §3: the launch gates block on a malformed order
    // before model selection is even attempted, so a refusal never has to be
    // explained in terms of a model the order was never going to reach.
    const routing = resolveOrderRouting(packet, opts.capabilityModels);

    // Plan §6: the record must exist BEFORE tokens are spent, which is why this
    // is a dedicated verb and not a field on the next heartbeat. It is reported
    // on the refusal path too — a refusal is a true observation of what this
    // shift resolved, and the whole point of the report is that the hub can say
    // why an order did or did not run.
    await reportResolution(routing, resolution.id);

    if (routing.kind === 'refused') {
      opts.err(
        `owenloop work agent-run: no settings row for ${order} — the order's capabilities ` +
          `[${routing.capabilities.join(', ')}] match neither an exact row nor a bare name row in ` +
          `'capabilityModels'. Add a row for one of them (a bare row such as ` +
          `'${routing.capabilities[0]?.split(':')[0] ?? ''}' covers every modifier) and restart the shift. ` +
          `Releasing — this shift will not pick a model it was not told to use.`,
      );
      return releaseWith('unresolvable-capability', 'unresolvable-capability');
    }
    if (routing.kind === 'unrouted') {
      opts.err(
        `owenloop work agent-run: ${order} carries no capabilities, so no settings row applies — ` +
          `running on '${resolution.id}''s own default model.`,
      );
    } else {
      opts.out(
        `owenloop work agent-run: ${order} resolved '${routing.resolution.capability}' ` +
          `(${routing.resolution.match} row) → ${routing.resolution.model} at ${routing.resolution.effort}`,
      );
    }

    // ---- PHASE 4: resume or cold replay? -----------------------------------
    //
    // The delta first, because "is there anything new to say?" is one of the
    // resume preconditions. `renderRejection` reads `packet.owes[].reasons`
    // filtered to `at > prev.deliveredReasonAt` — the packet's `owes` IS the set
    // of paths being re-armed, so no extra path filter is needed here.
    const prev = opts.latestSession?.(workflow, runId, packet.step) ?? null;
    const dirExists = opts.dirExists ?? existsSync;
    const delta = renderRejection({
      packet,
      ...(prev?.deliveredReasonAt !== undefined ? { deliveredReasonAt: prev.deliveredReasonAt } : {}),
    });

    // EVERY condition must hold. Each is a separate reason, and each is a
    // documented cold-start case rather than an error:
    //   prev !== null                  first firing — there is no session to resume
    //   prev.token !== ''              the record predates its `started` event, so
    //                                  no provider token was ever minted
    //   prev.harness === resolution.id NEVER resume a session into a different
    //                                  vendor; the token means nothing there
    //   prev.status !== 'dead'         a session recorded dead is not resumable
    //   resumeTier !== 'replay'        the adapter says it has no resume at all
    //   prev.cwd === recordCwd         the resolved working directory moved, so the
    //                                  session is scoped to the wrong place
    //   dirExists(prev.cwd)            a reaped work dir invalidates the session
    //   delta.message !== ''           nothing new to say — a resume that says
    //                                  nothing spends a turn communicating nothing
    const resumable =
      prev !== null &&
      prev.token !== '' &&
      prev.harness === resolution.id &&
      prev.status !== 'dead' &&
      active.resumeTier !== 'replay' &&
      prev.cwd === recordCwd &&
      dirExists(prev.cwd) &&
      delta.message !== '';

    // The watermark this firing's records carry. It STARTS at the prior value —
    // never at the delta's — and advances only once the reasons have actually
    // reached the agent (`markDelivered`, called after `deliver`/`start`
    // RESOLVES). Carrying the prior value forward is also what keeps a cold start
    // with no new feedback from making already-delivered reasons look undelivered.
    deliveredReasonAt = prev?.deliveredReasonAt;

    /**
     * Advance the watermark to the newest reason this firing carried.
     *
     * CALLED ONLY AFTER THE TURN'S DELIVERY RESOLVED. Persisting the advance
     * BEFORE the delivery is attempted permanently swallows the feedback: a
     * `deliver` that fails for a non-resume reason (transport/spawn failure), or
     * a process that dies mid-turn, would leave a record claiming the reasons
     * were delivered by a session that never conveyed them, and the next firing
     * would filter every one of them out (`at > watermark`) and cold-start with a
     * BARE brief — so the agent would never learn why it was rejected and would
     * repeat the rejected submission.
     *
     * The `ResumeUnavailable` → cold-replay fallback stays correct because
     * `coldArgs()` re-renders from `prev?.deliveredReasonAt`, not from this
     * variable.
     */
    function markDelivered(): void {
      if (delta.deliveredReasonAt !== undefined) deliveredReasonAt = delta.deliveredReasonAt;
    }

    const owenloopMcp = buildOwenloopMcp(spec);
    const resolvedModel =
      routing.kind === 'resolved'
        ? { model: routing.resolution.model, effort: routing.resolution.effort }
        : undefined;
    const deliverArgs: DeliverArgs = {
      cwd: recordCwd,
      owenloopMcp,
      permissions,
      ...(resolvedModel ?? {}),
    };
    /** Built lazily: a cold start after a refused resume needs a FRESH one. */
    const coldArgs = (): StartArgs => ({
      // The replay brief is the ordinary brief PLUS a trailing rejection section,
      // capped at roughly 100k tokens. With no delta it is just the brief.
      brief: renderReplayBrief(renderBrief(step.brief, spec), {
        packet,
        ...(prev?.deliveredReasonAt !== undefined
          ? { deliveredReasonAt: prev.deliveredReasonAt }
          : {}),
      }),
      cwd: recordCwd,
      owenloopMcp,
      permissions,
      ...(resolvedModel ?? {}),
    });

    const path = resumable ? 'resume' : delta.message !== '' ? 'cold replay' : 'cold start';
    opts.out(
      `owenloop work agent-run: hosting ${order} (step '${packet.step}', harness '${resolution.id}', attempt ${attempt}, ${path})`,
    );

    type TurnResult = { t: 'turn'; failure?: unknown; persistenceFailure?: unknown };

    /** Cold-start this firing. Shared by the ordinary path and the fallback. */
    async function coldStart(): Promise<TurnResult> {
      activePersistenceFailure = undefined;
      try {
        const ref = await active.start(coldArgs(), onEvent);
        sessionRef = ref;
        // The replay brief carried the reasons, and the turn it opened has now
        // ended — only here is the watermark honest. (The `active` row written
        // from the `started` event fires INSIDE this call and therefore still
        // carries the prior watermark, which is the safe direction: a crash
        // between the two re-delivers rather than swallows.)
        markDelivered();
        return { t: 'turn' };
      } catch (e: unknown) {
	if (activePersistenceFailure !== undefined) {
	  await teardown();
	  return { t: 'turn', persistenceFailure: activePersistenceFailure };
	}
        return { t: 'turn', failure: e };
      }
    }

    /**
     * One turn, by whichever path the decision above picked. NEVER rejects: both
     * settle shapes are folded into one 'turn' result on purpose (the closed
     * contract question — see this file's header).
     */
    async function chooseTurn(): Promise<TurnResult> {
      if (!resumable || prev === null) return coldStart();

      // Resume keeps the PRIOR token, so the store shows two rows for the same
      // `(workflow, run, step)` with the same token and successive attempts —
      // which is how "same session" is observable at all. `deliver` never emits
      // `started`, so the record has to be written here rather than from the
      // event, and `createdAt` is the SESSION's birth, not this attempt's.
      sessionRef = { harness: prev.harness, token: prev.token };
      createdAt = prev.createdAt;
      opts.err(
        `owenloop work agent-run: resuming session ${prev.token} for ${order} with ${delta.count} new rejection reason${delta.count === 1 ? '' : 's'} (no brief re-sent)`,
      );
      // Deliberately written with the PRIOR watermark: nothing has been delivered
      // yet, and this row is what the next firing reads if this turn never
      // completes. See `markDelivered`. This durable write is also the resume
      // delivery gate; failure stops the old provider session without delivery.
      try {
	record('active');
      } catch (error) {
	await teardown();
	return { t: 'turn', persistenceFailure: error };
      }

      try {
        await active.deliver(sessionRef, delta.message, deliverArgs, onEvent);
        markDelivered();
        return { t: 'turn' };
      } catch (e: unknown) {
        if (!isResumeUnavailable(e)) return { t: 'turn', failure: e };
        // The provider forgot the session. The order is still leased, so falling
        // back HERE costs one cold start; handing it back would cost a whole
        // re-offer cycle to rediscover the same fact.
        opts.err(
          `owenloop work agent-run: resume of session ${prev.token} was refused (${errMsg(e)}) — falling back to a cold replay in this same firing`,
        );
        // Forget the dead session so the `started` event mints a new record with
        // a NEW token and its own createdAt, and so teardown does not try to stop
        // a session the provider has already lost.
        sessionRef = undefined;
        createdAt = 0;
        return coldStart();
      }
    }

    const turnDone = chooseTurn();

    const raced = await Promise.race([turnDone, leasePromise.then((o) => ({ t: 'lease' as const, o }))]);

    if (raced.t === 'lease') {
      await teardown();
      if (raced.o === 'completed') {
        opts.out(`owenloop work agent-run: ${order} completed mid-turn (the hub reported an outcome)`);
        record('submitted');
        return 'submitted';
      }
      record('dead');
      if (signalled) {
        opts.err(`owenloop work agent-run: signalled mid-turn — tore the session down, released ${order}`);
        return 'killed';
      }
      opts.err(`owenloop work agent-run: lease ${raced.o} mid-turn — tore the session down, no outcome observed`);
      return mapLeaseDuringTurn(raced.o);
    }

    if (raced.persistenceFailure !== undefined) {
      opts.err(
	`owenloop work agent-run: durable active-session persistence failed before provider delivery for ${order}: ` +
	`${errMsg(raced.persistenceFailure)} — releasing`,
      );
      return releaseWith('session-store-failed', 'session-store-failed');
    }

    // TURN END — NOT task end. Log the failure shape for humans, then confirm.
    if (raced.failure !== undefined) {
      const why = isResumeUnavailable(raced.failure)
        ? `the harness could not resume the session (${errMsg(raced.failure)})`
        : errMsg(raced.failure);
      opts.err(`owenloop work agent-run: the turn failed (${why}) — confirming with the hub before deciding anything`);
    }
    record('turn-ended');

    const confirmed = await Promise.race([
      confirmOutcome({
        hub,
        workflow,
        run: runId,
        holder: opts.holder,
        sleep: opts.sleep,
        now: opts.now,
        err: opts.err,
        intervalMs: opts.confirmIntervalMs ?? DEFAULT_CONFIRM_INTERVAL_MS,
        graceMs: opts.submitGraceMs ?? DEFAULT_SUBMIT_GRACE_MS,
        cancelled: () => signalled || leaseSettled,
      }).then((v) => ({ t: 'confirm' as const, v })),
      leasePromise.then((o) => ({ t: 'lease' as const, o })),
    ]);

    await teardown();

    if (confirmed.t === 'lease') {
      if (confirmed.o === 'completed') {
        record('submitted');
        opts.out(`owenloop work agent-run: ${order} submitted (the lease loop observed the hub outcome)`);
        return 'submitted';
      }
      record('dead');
      if (signalled) return 'killed';
      return mapLeaseDuringTurn(confirmed.o);
    }

    switch (confirmed.v) {
      case 'submitted':
        record('submitted');
        opts.out(`owenloop work agent-run: ${order} submitted (confirmed by the hub) — stopping without release`);
        // The run has CLOSED. Releasing after a close is a confusing no-op that
        // races nothing useful, so stop the lease without one.
        lease.stop('submitted', { release: false });
        await leasePromise;
        return 'submitted';
      case 'lease-lost':
        record('dead');
        opts.err(`owenloop work agent-run: the claim on ${order} is gone and no outcome was reported — not releasing`);
        lease.stop('lease-lost', { release: false });
        await leasePromise;
        return 'lease-lost';
      case 'no-submit':
        record('dead');
        opts.err(
          `owenloop work agent-run: the turn ended and no submit reached the hub within the confirm grace — releasing ${order} for re-offer`,
        );
        // Release so the hub re-offers immediately instead of waiting out the
        // claim TTL. This is the ONLY path that releases on a turn end.
        return releaseWith('no-submit', 'no-submit');
    }
  }

  function stop(reason?: string): void {
    if (signalled) return;
    signalled = true;
    void teardown();
    lease.stop(reason ?? 'signal'); // release:true — hand the killed order back
  }

  return { run, stop };
}
