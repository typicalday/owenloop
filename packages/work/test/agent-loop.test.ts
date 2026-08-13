/**
 * `createAgentRunLoop` — the `agent-run` orchestration core (Phase 3).
 *
 * Everything here is driven by injected fakes: a mock hub, `createFakeAdapter`
 * (or a hand-rolled adapter when a test needs to hold a turn open), a
 * macrotask sleep, and an in-memory session sink. No process, no timers, no fs.
 *
 * The assertions that matter most are the ones about WHO decides the outcome:
 * a turn that failed but whose submit landed is a SUCCESS, and a turn that
 * ended cleanly with no hub outcome is a FAILURE. The harness never votes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  confirmOutcome,
  createAgentRunLoop,
  type AdapterResolution,
  type AgentRunLoopOptions,
} from '../src/agent/loop.ts';
import { ACCOUNT_TOKEN, SHIFT_TOKEN, ORDER_TOKEN, ORIGIN_TOKEN } from '../src/agent/brief.ts';
import { resolveOwenloopBin } from '../src/owenloop-bin.ts';
import { createFakeAdapter } from '../src/harness/fake.ts';
import { createModelPolicy } from '../src/agent/model-policy.ts';
import type { AgentEvent, HarnessAdapter, HarnessSessionRef, StartArgs } from '../src/harness/contract.ts';
import { ResumeUnavailableError } from '../src/harness/contract.ts';
import type { SessionRecord } from '../src/harness/session-store.ts';
import { HubError, type ContactHolder, type GetOrderResponse } from '../src/hub/types.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { NormalizedStepSpec } from '../src/bundle/types.ts';

// ---- fakes ------------------------------------------------------------------

const HOLDER: ContactHolder = { kind: 'exec', id: 'host:99' };
const macrotaskSleep = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Call {
  verb: string;
  arg?: unknown;
}

interface OrderOpts {
  step?: string;
  workdir?: string;
  model?: string;
  worker?: string;
  claimed?: boolean;
  outcome?: string;
  /** Consumed input artifact values, keyed by path — `plan` carries the lane. */
  consumes?: Record<string, unknown>;
  /** Owed outputs; their `judgmentRejects` drive retry escalation. */
  owes?: Array<{ path: string; judgmentRejects?: number }>;
  /** Extension bag — the authored escalation ladder lives under a namespace. */
  x?: Record<string, unknown>;
}

/** A get_order response carrying an agent order packet. */
function agentOrder(o: OrderOpts = {}): GetOrderResponse {
  return {
    text: '',
    workflow: 'wf1',
    run: 'run1',
    order: {
      run: 'run1',
      workflow: 'wf1',
      step: o.step ?? 'builder',
      key: 'k',
      inputs: [],
      outputs: [],
      ...(o.workdir !== undefined ? { workdir: o.workdir } : {}),
      ...(o.model !== undefined ? { model: o.model } : {}),
      ...(o.worker !== undefined ? { worker: o.worker } : {}),
      defDigest: 'test-agent-digest',
      ...(o.x !== undefined ? { x: o.x } : {}),
      consumes: o.consumes ?? {},
      owes: (o.owes ?? []).map((w) => ({
        path: w.path,
        judgmentRejects: w.judgmentRejects ?? 0,
        schemaRejects: 0,
        reasons: [],
      })),
    },
    lease: { claimed: o.claimed ?? true, ...(o.outcome !== undefined ? { outcome: o.outcome } : {}) },
  };
}

/** A first-contact response with no hold at all. */
function noHold(lease: GetOrderResponse['lease']): GetOrderResponse {
  return { text: '', workflow: 'wf1', run: 'run1', order: null, lease };
}

interface MockCfg {
  getOrder: Array<GetOrderResponse | Error> | ((n: number) => GetOrderResponse | Error);
  heartbeat?: (n: number) => void;
}

function mockHub(cfg: MockCfg): { hub: HubClient; calls: Call[] } {
  const calls: Call[] = [];
  let goIdx = 0;
  let hbIdx = 0;
  const hub: HubClient = {
    async getOrder(req) {
      calls.push({ verb: 'get_order', arg: req });
      const s = cfg.getOrder;
      const item = Array.isArray(s) ? s[Math.min(goIdx, s.length - 1)]! : s(goIdx);
      goIdx++;
      if (item instanceof Error) throw item;
      return item;
    },
    async heartbeat(req) {
      calls.push({ verb: 'heartbeat', arg: req });
      cfg.heartbeat?.(hbIdx++);
      return { text: '' };
    },
    async release(req) {
      calls.push({ verb: 'release', arg: req });
      return { text: '' };
    },
    async submit(req) {
      calls.push({ verb: 'submit', arg: req });
      return { text: '', outcome: 'green' };
    },
    async whatsNext() {
      return { text: '' };
    },
    async reject() { return { text: '', ok: true }; },
    async whoami() {
      return {
        text: '',
        orgId: '',
        orgName: '',
        actor: { id: '', kind: 'agent', role: 'agent', scopes: [] },
        tokenStatus: 'active',
        authMethod: 'token',
      };
    },
    async wake() {
      return { text: '', cursor: 0, changed: false };
    },
    async presencePing(req) {
      return { text: '', ok: true, name: req.name, lastSeen: 0 };
    },
  };
  return { hub, calls };
}

/** An adapter whose `start` emits `started` and then parks until `settle()`. */
function pendingAdapter(id = 'fake'): {
  adapter: HarnessAdapter;
  stops: HarnessSessionRef[];
  started: Promise<void>;
  settle: (err?: Error) => void;
} {
  const ref: HarnessSessionRef = { harness: id, token: 'tok-pending' };
  const stops: HarnessSessionRef[] = [];
  let release: ((err?: Error) => void) | undefined;
  const gate = new Promise<Error | undefined>((r) => {
    release = (err?: Error) => r(err);
  });
  let announce: (() => void) | undefined;
  const started = new Promise<void>((r) => {
    announce = r;
  });
  const adapter: HarnessAdapter = {
    id,
    resumeTier: 'native-token',
    preflight: () => [],
    async start(_args: StartArgs, onEvent: (e: AgentEvent) => void): Promise<HarnessSessionRef> {
      onEvent({ kind: 'started', ref });
      announce?.();
      const err = await gate;
      if (err !== undefined) throw err;
      return ref;
    },
    async deliver(): Promise<void> {
      // unused by the agent-run loop this phase
    },
    async stop(target: HarnessSessionRef): Promise<void> {
      stops.push(target);
    },
  };
  return { adapter, stops, started, settle: (err?: Error) => release?.(err) };
}

const TEMPLATE = [
  '# brief',
  `order: ${ORDER_TOKEN}`,
  `origin: ${ORIGIN_TOKEN}`,
  `account: ${ACCOUNT_TOKEN}`,
  `shift: ${SHIFT_TOKEN}`,
].join('\n');

/** The default step spec the loop loads: the token brief, no options. */
const baseSpec = (): NormalizedStepSpec => ({ step: 'builder', brief: TEMPLATE, permissions: { extensions: {} } });

interface Harnessed {
  opts: AgentRunLoopOptions;
  records: SessionRecord[];
  errs: string[];
  outs: string[];
}

interface BuildOpts {
  hub: HubClient;
  adapter?: HarnessAdapter;
  resolution?: AdapterResolution;
  spec?: NormalizedStepSpec | null;
  loadStep?: AgentRunLoopOptions['loadStep'];
  submitGraceMs?: number;
  shiftId?: string;
  consumedVerifier?: AgentRunLoopOptions['consumedVerifier'];
  modelPolicy?: AgentRunLoopOptions['modelPolicy'];
  appendSession?: AgentRunLoopOptions['appendSession'];
  latestSession?: AgentRunLoopOptions['latestSession'];
  dirExists?: AgentRunLoopOptions['dirExists'];
}

function buildOpts(b: BuildOpts): Harnessed {
  const records: SessionRecord[] = [];
  const errs: string[] = [];
  const outs: string[] = [];
  const resolution: AdapterResolution =
    b.resolution ?? { id: b.adapter?.id ?? 'fake', ...(b.adapter !== undefined ? { adapter: b.adapter } : {}), registered: ['fake'] };
  const opts: AgentRunLoopOptions = {
    hub: b.hub,
    workflow: 'wf1',
    run: 'run1',
    holder: HOLDER,
    origin: 'https://hub.example',
    account: 'acct-1',
    ...(b.shiftId !== undefined ? { shiftId: b.shiftId } : {}),
    cwd: '/fallback/cwd',
    loadStep: b.loadStep ?? (async () => (b.spec === undefined ? baseSpec() : b.spec)),
    resolveAdapter: () => resolution,
    ...(b.consumedVerifier === undefined ? {} : { consumedVerifier: b.consumedVerifier }),
    ...(b.modelPolicy === undefined ? {} : { modelPolicy: b.modelPolicy }),
    appendSession: b.appendSession ?? ((rec) => records.push(rec)),
    ...(b.latestSession === undefined ? {} : { latestSession: b.latestSession }),
    ...(b.dirExists === undefined ? {} : { dirExists: b.dirExists }),
    nextAttempt: () => 3,
    sleep: macrotaskSleep,
    now: () => 1_000,
    out: (l) => outs.push(l),
    err: (l) => errs.push(l),
    heartbeatIntervalMs: 60_000,
    confirmIntervalMs: 1,
    submitGraceMs: b.submitGraceMs ?? 0,
  };
  return { opts, records, errs, outs };
}

const statuses = (records: SessionRecord[]): string[] => records.map((r) => r.status);
const verbs = (calls: Call[]): string[] => calls.map((c) => c.verb);

// ---- happy path -------------------------------------------------------------

test('happy path: the turn ends, the confirm poll sees the hub outcome, and the runner submits without releasing', async () => {
  const adapter = createFakeAdapter({ start: { events: [{ kind: 'turn_ended' }] } });
  const { hub, calls } = mockHub({
    getOrder: [agentOrder(), agentOrder({ claimed: false, outcome: 'green' })],
  });
  const h = buildOpts({ hub, adapter });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'submitted');
  assert.deepEqual(statuses(h.records), ['active', 'turn-ended', 'submitted']);
  // A submitted run is CLOSED — releasing it would be a confusing no-op.
  assert.ok(!verbs(calls).includes('release'));
  // The session was torn down on the way out.
  assert.deepEqual(
    adapter.calls.filter((c) => c.kind === 'stop').length,
    1,
  );
});

test('the session record carries the resolved harness, its token, the packet cwd, and the injected attempt', async () => {
  const adapter = createFakeAdapter({ id: 'fake', token: 'tok-77' });
  const { hub } = mockHub({ getOrder: [agentOrder({ workdir: '/repo/wt' }), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter });

  await createAgentRunLoop(h.opts).run();

  const first = h.records[0]!;
  assert.equal(first.harness, 'fake');
  assert.equal(first.token, 'tok-77');
  assert.equal(first.cwd, '/repo/wt');
  assert.equal(first.attempt, 3);
  assert.equal(first.order, 'wf1/run1');
  assert.equal(first.step, 'builder');
  assert.equal(first.createdAt, 1_000);
});

test('the brief is rendered and the work-holder mount is born bound to this order', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder({ workdir: '/repo/wt', model: 'm-override' }), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({
    hub,
    adapter,
    shiftId: 'shf_1',
    spec: {
      step: 'builder',
      brief: TEMPLATE,
      permissions: { tools: ['Read', 'Write'], maxTurns: 4, model: 'm-step', extensions: { custom: 1 } },
    },
  });

  await createAgentRunLoop(h.opts).run();

  const start = adapter.calls.find((c) => c.kind === 'start');
  assert.ok(start !== undefined && start.kind === 'start');
  assert.equal(
    start.args.brief,
    ['# brief', 'order: wf1/run1', 'origin: https://hub.example', 'account: acct-1', 'shift: shf_1'].join('\n'),
  );
  assert.equal(start.args.cwd, '/repo/wt');
  assert.deepEqual(start.args.owenloopMcp, {
    command: process.execPath,
    // `--never-release`: this loop's own exec lease is the holder of record.
    args: [resolveOwenloopBin(), 'work', 'hold', '--order', 'wf1/run1', '--origin', 'https://hub.example', '--as', 'acct-1', '--shift=shf_1', '--mcp', '--never-release'],
  });
  // Permissions arrive PRE-NORMALIZED on the step spec — `prepare` already ran
  // `normalizeStepPermissions` over `x.harness`, so this loop passes them
  // through untouched and never performs a vendor-keyed lookup.
  assert.deepEqual(start.args.permissions.tools, ['Read', 'Write']);
  assert.equal(start.args.permissions.maxTurns, 4);
  assert.deepEqual(start.args.permissions.extensions, { custom: 1 });
  // The step spec's model rides inside the permissions...
  assert.equal(start.args.permissions.model, 'm-step');
  // ...while the order packet's model is the per-start override.
  assert.equal(start.args.model, 'm-override');
});

// ---- tier resolution from real packet data ----------------------------------
//
// `model-policy.test.ts` covers the algorithm by calling `pickModel` with
// literal arguments. These tests cover the WIRING instead: that the loop pulls
// the lane out of `consumes.plan.lane`, the reject count out of `owes[]`, and
// the escalation ladder out of the extension bag, and hands all three to the
// resolver. Without them, the packet readers are the only unexercised part of
// the path, and an escalation bug that only appears UNDER a lane ships green.

/**
 * Resolve one order packet all the way to the harness `start` args.
 *
 * These packets carry `consumes`/`owes` data, so the loop's consume-side gate
 * demands a verifier before any of it can reach a prompt. That gate is not what
 * these tests are about, so it is satisfied with a pass-through that admits the
 * packet unchanged; the refusal behavior has its own tests further down.
 */
async function startArgsFor(o: OrderOpts): Promise<StartArgs> {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder(o), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({
    hub,
    adapter,
    modelPolicy: createModelPolicy(),
    consumedVerifier: async (order) => ({ ok: true, order, warnings: [] }),
  });
  await createAgentRunLoop(h.opts).run();
  const start = adapter.calls.find((c) => c.kind === 'start');
  assert.ok(start !== undefined && start.kind === 'start');
  return start.args;
}

test('the authored tier is resolved through the lane carried on the consumed plan artifact', async () => {
  // No lane anywhere: the tier resolves, nothing clamps.
  assert.equal((await startArgsFor({ model: 'strong' })).model, 'opus');

  // A real express lane, shaped exactly as the engine copies a green `plan`
  // artifact's value into `consumes['plan']`.
  assert.equal((await startArgsFor({ model: 'strong', consumes: { plan: { lane: 'express' } } })).model, 'sonnet');

  // SCAFFOLDING: the deep floor is the TOP tier (`strongest` → fable), not
  // `strong`. Under a `strong` floor the top tier was unreachable by lane —
  // only a def authoring `strongest` outright could enter it — which made
  // "deep" mean "second best" and gave the crew no way to say otherwise.
  // Phase 2 deletes the lane clamp in favour of per-step model arms; until
  // then, deep means the crew's best tier.
  assert.equal((await startArgsFor({ model: 'fast', consumes: { plan: { lane: 'deep' } } })).model, 'fable');

  // The top tier is pinned against the express cap even when the lane is real.
  assert.equal((await startArgsFor({ model: 'strongest', consumes: { plan: { lane: 'express' } } })).model, 'fable');
});

test('a malformed lane on the plan artifact fails open to no clamp', async () => {
  // Fail-open is deliberate: a bad plan artifact must never stop an agent from
  // running. Every one of these yields `undefined`, i.e. no lane adjustment.
  for (const plan of [
    { lane: 'EXPRESS' }, // wrong case is not a lane
    { lane: 'turbo' }, // unknown string
    { lane: 42 }, // wrong type
    { lane: null },
    {}, // key absent
    'express', // the artifact value is not an object
    null,
    ['express'], // arrays are not lane carriers
  ]) {
    const args = await startArgsFor({ model: 'strong', consumes: { plan } });
    assert.equal(args.model, 'opus', `expected no clamp for plan=${JSON.stringify(plan)}`);
  }

  // A packet with no `plan` key at all is the planner's own firing.
  assert.equal((await startArgsFor({ model: 'strong', consumes: {} })).model, 'opus');
});

test('reject escalation beats the express cap on a real packet, and consult paths do not count', async () => {
  const express = { plan: { lane: 'express' } };

  // The delivery line's reviewer step is authored `strong:4`. Under an express
  // lane it starts clamped, bumps effort at the threshold, and escalates the
  // model at twice the threshold — it never gets stuck at the cap.
  const cold = await startArgsFor({ model: 'strong:4', consumes: express, owes: [{ path: 'verdict' }] });
  assert.equal(cold.model, 'sonnet');
  assert.equal(cold.effort, 'xhigh');

  const bumped = await startArgsFor({
    model: 'strong:4',
    consumes: express,
    owes: [{ path: 'verdict', judgmentRejects: 3 }],
  });
  assert.equal(bumped.model, 'sonnet');
  assert.equal(bumped.effort, 'max');

  const escalated = await startArgsFor({
    model: 'strong:4',
    consumes: express,
    owes: [{ path: 'verdict', judgmentRejects: 6 }],
  });
  assert.equal(escalated.model, 'opus');
  assert.equal(escalated.effort, 'max');

  // With no effort suffix to bump, reaching the threshold escalates the model
  // straight away — still under the express lane that clamped it.
  assert.equal(
    (await startArgsFor({ model: 'strong', consumes: express, owes: [{ path: 'pr', judgmentRejects: 3 }] })).model,
    'opus',
  );

  // The count is the MAX across owed outputs, but consult paths are excluded:
  // an occasional mentor round would otherwise escalate every later firing.
  assert.equal(
    (
      await startArgsFor({
        model: 'strong',
        consumes: express,
        owes: [
          { path: 'pr', judgmentRejects: 0 },
          { path: 'consultRequest', judgmentRejects: 9 },
          { path: 'planConsult', judgmentRejects: 9 },
        ],
      })
    ).model,
    'sonnet',
  );
});

test('the authored escalation ladder is read from the packet extension bag', async () => {
  const express = { plan: { lane: 'express' } };
  const bag = { delivery: { escalation: { model: 'strongest', attempts: 2 } } };

  // Below the authored threshold: rung 1 is the step's own model, lane-adjusted.
  assert.equal(
    (await startArgsFor({ model: 'strong', consumes: express, x: bag, owes: [{ path: 'pr', judgmentRejects: 1 }] }))
      .model,
    'sonnet',
  );

  // At the authored threshold: rung 2 is the authored model, pinned against
  // the lane — the express cap does not pull it back down.
  assert.equal(
    (await startArgsFor({ model: 'strong', consumes: express, x: bag, owes: [{ path: 'pr', judgmentRejects: 2 }] }))
      .model,
    'fable',
  );

  // A malformed bag fails open to the default staged rule, same as the lane.
  assert.equal(
    (
      await startArgsFor({
        model: 'strong',
        consumes: express,
        x: { delivery: { escalation: 'nope' } },
        owes: [{ path: 'pr', judgmentRejects: 3 }],
      })
    ).model,
    'opus',
  );
});

// ---- the invariant: the hub decides, never the harness -----------------------

test('a turn that FAILED still confirms, and a landed submit makes it a success', async () => {
  const adapter = createFakeAdapter({ start: { events: [{ kind: 'progress', text: 'working' }], dieWith: 'harness died' } });
  const { hub } = mockHub({ getOrder: [agentOrder(), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'submitted');
  assert.deepEqual(statuses(h.records), ['active', 'turn-ended', 'submitted']);
  assert.ok(h.errs.some((l) => l.includes('harness died') && l.includes('confirming with the hub')));
});

test('a clean turn with no hub outcome is a FAILURE: no-submit, released for re-offer', async () => {
  const adapter = createFakeAdapter({ start: { events: [{ kind: 'turn_ended' }] } });
  const { hub, calls } = mockHub({ getOrder: [agentOrder(), agentOrder()] });
  const h = buildOpts({ hub, adapter });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'no-submit');
  assert.deepEqual(statuses(h.records), ['active', 'turn-ended', 'dead']);
  assert.ok(verbs(calls).includes('release'));
});

test('start() rejecting as unresumable is a cold-start failure: dead, released, and never crashes', async () => {
  const adapter = createFakeAdapter({ start: { resumeUnavailable: true } });
  const { hub, calls } = mockHub({ getOrder: [agentOrder(), agentOrder()] });
  const h = buildOpts({ hub, adapter });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'no-submit');
  // No `started` event ever fired, so there is no `active` record — but the
  // attempt is still on the record so the store shows it happened and died.
  assert.deepEqual(statuses(h.records), ['turn-ended', 'dead']);
  assert.equal(h.records[0]!.harness, 'fake');
  assert.equal(h.records[0]!.token, '');
  assert.ok(h.errs.some((l) => l.includes('could not resume the session')));
  assert.ok(verbs(calls).includes('release'));
});

test('cold start requires a durable active row before provider work', async () => {
  const ref: HarnessSessionRef = { harness: 'fake', token: 'cold-session' };
  let providerWorkStarted = false;
  const stops: HarnessSessionRef[] = [];
  const adapter: HarnessAdapter = {
    id: 'fake',
    resumeTier: 'native-token',
    preflight: () => [],
    async start(_args, onEvent) {
      onEvent({ kind: 'started', ref });
      providerWorkStarted = true;
      return ref;
    },
    async deliver() {
      assert.fail('cold-start persistence failure must not deliver');
    },
    async stop(target) {
      stops.push(target);
    },
  };
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  const attemptedStatuses: string[] = [];
  const h = buildOpts({
    hub,
    adapter,
    appendSession: (record) => {
      attemptedStatuses.push(record.status);
      if (record.status === 'active') throw new Error('active fsync failed');
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'session-store-failed');
  assert.equal(providerWorkStarted, false);
  assert.deepEqual(attemptedStatuses, ['active']);
  assert.deepEqual(stops, [ref]);
  assert.equal(verbs(calls).filter((verb) => verb === 'release').length, 1);
  assert.equal(verbs(calls).filter((verb) => verb === 'get_order').length, 1, 'the confirm phase never starts');
  assert.ok(h.errs.some((line) => line.includes('durable active-session persistence failed before provider delivery')));
});

test('resume requires a durable active row before provider delivery', async () => {
  const previous: SessionRecord = {
    workflow: 'wf1',
    run: 'run1',
    step: 'builder',
    order: 'wf1/run1',
    attempt: 2,
    harness: 'fake',
    token: 'resume-session',
    cwd: '/fallback/cwd',
    status: 'turn-ended',
    createdAt: 500,
    deliveredReasonAt: 10,
    updatedAt: 800,
  };
  const first = agentOrder({ owes: [{ path: 'out' }] });
  assert.ok(first.order !== null);
  first.order.owes[0]!.reasons = [{
    at: 20,
    action: 'reject',
    kind: 'judgment',
    by: 'reviewer',
    text: 'revise the output',
  }];
  let deliveries = 0;
  const stops: HarnessSessionRef[] = [];
  const adapter: HarnessAdapter = {
    id: 'fake',
    resumeTier: 'native-token',
    preflight: () => [],
    async start() {
      assert.fail('a resumable session must not cold-start');
    },
    async deliver() {
      deliveries += 1;
    },
    async stop(target) {
      stops.push(target);
    },
  };
  const { hub, calls } = mockHub({ getOrder: [first] });
  const attemptedStatuses: string[] = [];
  const h = buildOpts({
    hub,
    adapter,
    latestSession: () => previous,
    dirExists: () => true,
    consumedVerifier: async (order) => ({ ok: true, order, warnings: [] }),
    appendSession: (record) => {
      attemptedStatuses.push(record.status);
      if (record.status === 'active') throw new Error('resume active fsync failed');
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'session-store-failed');
  assert.equal(deliveries, 0);
  assert.deepEqual(attemptedStatuses, ['active']);
  assert.deepEqual(stops, [{ harness: 'fake', token: 'resume-session' }]);
  assert.equal(verbs(calls).filter((verb) => verb === 'release').length, 1);
  assert.equal(verbs(calls).filter((verb) => verb === 'get_order').length, 1, 'the confirm phase never starts');
});

test('the confirm poll treats a lost claim as lease-lost and does NOT release', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder(), noHold({ claimed: false })] });
  const h = buildOpts({ hub, adapter });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'lease-lost');
  assert.deepEqual(statuses(h.records), ['active', 'turn-ended', 'dead']);
  assert.ok(!verbs(calls).includes('release'));
});

// ---- lease terminal mid-turn ------------------------------------------------

test('the lease going terminal mid-turn tears the session down and maps the outcome', async () => {
  const p = pendingAdapter();
  const { hub } = mockHub({
    getOrder: [agentOrder()],
    heartbeat: () => {
      throw new HubError(403, 'forbidden');
    },
  });
  const h = buildOpts({ hub, adapter: p.adapter });

  const loop = createAgentRunLoop(h.opts);
  const running = loop.run();
  await p.started;
  const outcome = await running;

  assert.equal(outcome, 'ownership-error');
  assert.deepEqual(statuses(h.records), ['active', 'dead']);
  assert.equal(p.stops.length, 1);
  // The turn never settled — the loop did not wait for it.
  p.settle();
});

test('a mid-turn hub outcome is a SUCCESS, not a lost lease', async () => {
  const p = pendingAdapter();
  let beats = 0;
  const { hub, calls } = mockHub({
    // First contact holds; the post-failure classify sees the finished order.
    getOrder: [agentOrder(), noHold({ claimed: false, outcome: 'green' })],
    heartbeat: () => {
      beats += 1;
      throw new Error('lease gone');
    },
  });
  const h = buildOpts({ hub, adapter: p.adapter });

  const loop = createAgentRunLoop(h.opts);
  const running = loop.run();
  await p.started;
  const outcome = await running;

  assert.equal(outcome, 'submitted');
  assert.equal(beats, 1);
  assert.deepEqual(statuses(h.records), ['active', 'submitted']);
  assert.equal(p.stops.length, 1);
  assert.ok(!verbs(calls).includes('release'));
  p.settle();
});

// ---- first contact ----------------------------------------------------------

test('first contact: an already-finished order maps to completed with no adapter start', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [noHold({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'completed');
  assert.deepEqual(adapter.calls, []);
  assert.deepEqual(h.records, []);
});

test('first contact: an unclaimed lease with no outcome maps to lease-lost', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [noHold({ claimed: false })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'lease-lost');
  assert.deepEqual(adapter.calls, []);
});

test('first contact: a 403 maps to ownership-error', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [new HubError(403, 'forbidden')] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'ownership-error');
});

// ---- release-and-hand-back paths --------------------------------------------

test('a command order is a misroute: released, nothing started', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ worker: 'command' })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'misroute');
  assert.deepEqual(adapter.calls, []);
  assert.ok(verbs(calls).includes('release'));
});

test('a null order packet is a misroute too', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [noHold({ claimed: true })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'misroute');
});

test('no template for the step releases the order for the pickup window', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  const h = buildOpts({ hub, adapter, spec: null });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'no-template');
  assert.deepEqual(adapter.calls, []);
  assert.ok(verbs(calls).includes('release'));
});

test('a throwing step loader is treated as no-template, not as a crash', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder()] });
  const h = buildOpts({
    hub,
    adapter,
    loadStep: async () => {
      throw new Error('cache exploded');
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'no-template');
  assert.ok(h.errs.some((l) => l.includes('cache exploded')));
});

test('an unregistered harness id fails honestly, naming the id and what IS registered', async () => {
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  const h = buildOpts({ hub, resolution: { id: 'ghost', registered: ['fake', 'other'] } });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'no-harness');
  const line = h.errs.find((l) => l.includes('no adapter registered'));
  assert.ok(line !== undefined);
  assert.ok(line.includes("'ghost'"));
  assert.ok(line.includes('fake, other'));
  assert.ok(verbs(calls).includes('release'));
});

test('an unsupported harness policy starts nothing, reports every reason, and releases the claim', async () => {
  const adapter = createFakeAdapter();
  adapter.preflight = () => [
    { field: 'tools', message: 'tool allow-lists are unsupported' },
    { field: 'network', message: "network 'owenloop-only' is unsupported" },
  ];
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  const h = buildOpts({
    hub,
    adapter,
    spec: {
      ...baseSpec(),
      permissions: { tools: [], network: 'owenloop-only', extensions: {} },
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'incompatible-harness-policy');
  assert.deepEqual(adapter.calls, [], 'preflight runs before cold start or resume');
  assert.ok(verbs(calls).includes('release'));
  assert.ok(h.errs.some((line) => line.includes('(tools): tool allow-lists are unsupported')));
  assert.ok(h.errs.some((line) => line.includes("(network): network 'owenloop-only' is unsupported")));
});

test('unverified consumed values and complete rejection threads are refused before prompt rendering or adapter start', async () => {
  const adapter = createFakeAdapter();
  const packetResponse = agentOrder();
  const packet = packetResponse.order!;
  packet.consumes = { input: 'dynamic-value' };
  packet.owes = [{
    path: 'out',
    judgmentRejects: 0,
    schemaRejects: 1,
    reasons: [
      { at: 1, action: 'schema-reject', kind: 'validation', by: 'untrusted-transport', text: 'untrusted-rejection-marker' },
      { at: 2, action: 'schema-reject', kind: 'validation', by: 'engine', text: 'second-reason' },
    ],
    proof: '{invalid-proof}',
  }];
  const { hub, calls } = mockHub({ getOrder: [packetResponse] });
  let seenReasons = 0;
  const h = buildOpts({
    hub,
    adapter,
    consumedVerifier: async (order) => {
      seenReasons = order.owes[0]!.reasons.length;
      return { ok: false, reason: "consumed artifact refusal (signature) for wf1/run1 step 'builder' artifact 'out': rejection proof did not verify" };
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'unverified-consumed');
  assert.equal(seenReasons, 2, 'the gate receives the complete reason thread before replay truncation');
  assert.deepEqual(adapter.calls, [], 'the refused packet never starts an adapter session');
  assert.ok(verbs(calls).includes('release'));
  assert.ok(h.errs.some((line) => line.includes('rejection proof did not verify')));
});

// ---- stop() -----------------------------------------------------------------

test('stop() tears the session down and releases the order', async () => {
  const p = pendingAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  const h = buildOpts({ hub, adapter: p.adapter });

  const loop = createAgentRunLoop(h.opts);
  const running = loop.run();
  await p.started;
  loop.stop('signal');
  const outcome = await running;

  assert.equal(outcome, 'killed');
  assert.equal(p.stops.length, 1);
  assert.ok(verbs(calls).includes('release'));
  p.settle();
});

test('stop() is idempotent — a second call tears nothing down twice', async () => {
  const p = pendingAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder()] });
  const h = buildOpts({ hub, adapter: p.adapter });

  const loop = createAgentRunLoop(h.opts);
  const running = loop.run();
  await p.started;
  loop.stop('signal');
  loop.stop('signal');
  await running;

  assert.equal(p.stops.length, 1);
  p.settle();
});

// ---- confirmOutcome, directly -----------------------------------------------

test('confirmOutcome: an outcome on the lease answers submitted on the first poll', async () => {
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ claimed: false, outcome: 'green' })] });
  const got = await confirmOutcome({
    hub,
    workflow: 'wf1',
    run: 'run1',
    holder: HOLDER,
    sleep: macrotaskSleep,
    now: () => 0,
    err: () => undefined,
    intervalMs: 1,
    graceMs: 10_000,
  });
  assert.equal(got, 'submitted');
  assert.equal(calls.length, 1);
});

test('confirmOutcome: it polls until the grace expires, then answers no-submit', async () => {
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  let t = 0;
  const got = await confirmOutcome({
    hub,
    workflow: 'wf1',
    run: 'run1',
    holder: HOLDER,
    sleep: macrotaskSleep,
    now: () => {
      t += 1;
      return t;
    },
    err: () => undefined,
    intervalMs: 1,
    graceMs: 3,
  });
  assert.equal(got, 'no-submit');
  // now() #1 sets the deadline at 4; the poll's checks land on 2, 3, 4.
  assert.equal(calls.length, 3);
});

test('confirmOutcome: a throwing get_order is transient — it keeps polling, it never releases', async () => {
  const { hub, calls } = mockHub({
    getOrder: (n) => (n === 0 ? new Error('boom') : agentOrder({ claimed: false, outcome: 'green' })),
  });
  const errs: string[] = [];
  let t = 0;
  const got = await confirmOutcome({
    hub,
    workflow: 'wf1',
    run: 'run1',
    holder: HOLDER,
    sleep: macrotaskSleep,
    now: () => t++,
    err: (l) => errs.push(l),
    intervalMs: 1,
    graceMs: 100,
  });
  assert.equal(got, 'submitted');
  assert.equal(calls.length, 2);
  assert.ok(errs.some((l) => l.includes('confirm get_order failed') && l.includes('boom')));
});

test('confirmOutcome: cancelled() short-circuits before any hub call', async () => {
  const { hub, calls } = mockHub({ getOrder: [agentOrder()] });
  const got = await confirmOutcome({
    hub,
    workflow: 'wf1',
    run: 'run1',
    holder: HOLDER,
    sleep: macrotaskSleep,
    now: () => 0,
    err: () => undefined,
    intervalMs: 1,
    graceMs: 10_000,
    cancelled: () => true,
  });
  assert.equal(got, 'no-submit');
  assert.deepEqual(calls, []);
});

test('a plain Error and a ResumeUnavailableError take the SAME settle path — nothing branches on the shape', async () => {
  const shapes: Array<{ label: string; err: Error }> = [
    { label: 'plain', err: new Error('plain failure') },
    { label: 'unresumable', err: new ResumeUnavailableError('no session') },
  ];
  for (const shape of shapes) {
    const p = pendingAdapter();
    const { hub, calls } = mockHub({ getOrder: [agentOrder(), agentOrder()] });
    const h = buildOpts({ hub, adapter: p.adapter });
    const running = createAgentRunLoop(h.opts).run();
    await p.started;
    p.settle(shape.err);
    assert.equal(await running, 'no-submit', shape.label);
    assert.deepEqual(statuses(h.records), ['active', 'turn-ended', 'dead'], shape.label);
    assert.ok(verbs(calls).includes('release'), shape.label);
  }
});
