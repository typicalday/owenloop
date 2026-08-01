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
import { ACCOUNT_TOKEN, CONDUCTOR_TOKEN, ORDER_TOKEN, ORIGIN_TOKEN } from '../src/agent/brief.ts';
import { createFakeAdapter } from '../src/harness/fake.ts';
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
  command?: string;
  claimed?: boolean;
  outcome?: string;
}

/** A get_order response carrying an AGENT order packet (no `command`). */
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
      ...(o.command !== undefined ? { command: o.command } : {}),
      prompt: '',
      consumes: {},
      owes: [],
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
  `conductor: ${CONDUCTOR_TOKEN}`,
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
  conductorId?: string;
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
    ...(b.conductorId !== undefined ? { conductorId: b.conductorId } : {}),
    cwd: '/fallback/cwd',
    loadStep: b.loadStep ?? (async () => (b.spec === undefined ? baseSpec() : b.spec)),
    resolveAdapter: () => resolution,
    appendSession: (rec) => records.push(rec),
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
    conductorId: 'cnd_1',
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
    ['# brief', 'order: wf1/run1', 'origin: https://hub.example', 'account: acct-1', 'conductor: cnd_1'].join('\n'),
  );
  assert.equal(start.args.cwd, '/repo/wt');
  assert.deepEqual(start.args.owenworkMcp, {
    command: 'owenloop',
    args: ['work', 'hold', '--order', 'wf1/run1', '--origin', 'https://hub.example', '--as', 'acct-1', '--conductor=cnd_1', '--mcp'],
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
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ worker: 'command', command: 'echo hi' })] });
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
