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
import type { MergedRoster } from '../src/settings/roster.ts';
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
  /** Consumed input artifact values, keyed by path. */
  consumes?: Record<string, unknown>;
  /** Owed outputs, with their standing reject counts. */
  owes?: Array<{
    path: string;
    judgmentRejects?: number;
    schema?: unknown;
    schemaAppliesTo?: 'value' | 'member';
  }>;
  /** Extension bag. */
  x?: Record<string, unknown>;
  /** The composed capabilities the engine offered this step under. */
  capabilities?: string[];
  /** The hub's ordered crew stamp for a capability-bearing order. */
  crews?: string[];
  /** Exercise the explicit missing-stamp protocol failure. */
  omitCrewStamp?: boolean;
  /** The run's routing modifier, as `start_run` recorded it. */
  modifier?: string;
  /** Set by the engine when it re-offered this step at its escalation target. */
  escalated?: boolean;
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
      ...(o.capabilities !== undefined
		? {
			capabilities: o.capabilities,
			...(o.omitCrewStamp ? {} : { crews: o.crews ?? ['test-crew'] }),
		}
		: {}),
      ...(o.modifier !== undefined ? { modifier: o.modifier } : {}),
      ...(o.escalated !== undefined ? { escalated: o.escalated } : {}),
      ...(o.worker !== undefined ? { worker: o.worker } : {}),
      defDigest: 'test-agent-digest',
      ...(o.x !== undefined ? { x: o.x } : {}),
      consumes: o.consumes ?? {},
      owes: (o.owes ?? []).map((w) => ({
        path: w.path,
        judgmentRejects: w.judgmentRejects ?? 0,
        schemaRejects: 0,
        reasons: [],
        ...(w.schema !== undefined ? { schema: w.schema, schemaAppliesTo: w.schemaAppliesTo } : {}),
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
    async ask() { return { text: '', ok: true }; },
    // The tool-approval gate is not exercised by these tests; a fake that never
    // opens an approval, and a non-answer is a denial.
    async requestApproval() { return { text: '', ok: false }; },
    async answerApproval() { return { text: '', ok: false }; },
    async listPendingApprovals() { return { text: '', approvals: [] }; },
    async reportResolution(req) {
      calls.push({ verb: 'report_resolution', arg: req });
      return {
        text: '',
        workflow: req.workflow,
        run: req.run,
        step: 'builder',
        recorded: true,
        claimed: true,
      };
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
  allowedWorkdirRoots?: string[];
  hub: HubClient;
  adapter?: HarnessAdapter;
  resolution?: AdapterResolution;
  spec?: NormalizedStepSpec | null;
  loadStep?: AgentRunLoopOptions['loadStep'];
  submitGraceMs?: number;
  shiftId?: string;
  shiftName?: string;
  shiftOwner?: string;
  consumedVerifier?: AgentRunLoopOptions['consumedVerifier'];
  resolveCrewRosters?: AgentRunLoopOptions['resolveCrewRosters'];
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
    ...(b.shiftName !== undefined ? { shiftName: b.shiftName } : {}),
    ...(b.shiftOwner !== undefined ? { shiftOwner: b.shiftOwner } : {}),
    cwd: '/fallback/cwd',
    loadStep: b.loadStep ?? (async () => (b.spec === undefined ? baseSpec() : b.spec)),
    resolveAdapter: () => resolution,
    harnessAvailable: (id) => id === 'fake',
    ...(b.consumedVerifier === undefined ? {} : { consumedVerifier: b.consumedVerifier }),
    resolveCrewRosters: b.resolveCrewRosters ?? (() => ({ ok: true, rosters: [] })),
    ...(b.allowedWorkdirRoots === undefined ? {} : { allowedWorkdirRoots: b.allowedWorkdirRoots }),
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
const resolvedRosters = (rosters: readonly MergedRoster[]): AgentRunLoopOptions['resolveCrewRosters'] =>
  () => ({ ok: true, rosters });

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
  const h = buildOpts({ hub, adapter, shiftId: 'shf_test', shiftName: 'shift-A', shiftOwner: '/state/shift-a' });

  await createAgentRunLoop(h.opts).run();

  const first = h.records[0]!;
  assert.equal(first.harness, 'fake');
  assert.equal(first.token, 'tok-77');
  assert.equal(first.cwd, '/repo/wt');
  assert.equal(first.attempt, 3);
  assert.equal(first.order, 'wf1/run1');
  assert.equal(first.step, 'builder');
  assert.equal(first.createdAt, 1_000);
  assert.equal(first.pid, process.pid);
  assert.equal(first.shiftName, 'shift-A');
  assert.equal(first.shiftOwner, '/state/shift-a');
  assert.equal(first.shiftId, 'shf_test');
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
  // ...and the packet's own `model` field is DELIBERATELY not the override any
  // more. It carries the def's authored tier NAME from the retired scheme
  // (`strong`, `m-override`), which is not a vendor model id; putting it on the
  // wire would send a nonexistent model to the harness. The per-start override
  // now comes only from a `roster` row, and this order carries no
  // capabilities to match one with.
  assert.equal(start.args.model, undefined);
});

// ---- capability routing from real packet data -------------------------------
//
// `capability-model.test.ts` covers the RESOLVER by calling
// `resolveCapabilityCandidates` with literal arguments. These tests cover the
// WIRING instead: that the loop reads `packet.capabilities`, hands them to the
// settings map, puts the winning row on the harness `start` args, tells the hub
// what it picked, and refuses the order outright when no row matches. Without
// them the packet reader is the only unexercised part of the path, and a shift
// that silently ran every order on the harness default would ship green.

/** A merged crew roster produced by the composition root. */
const MAP: MergedRoster = {
  'build:deep': { candidates: [{ harness: 'fake', model: 'claude-opus-5', effort: 'xhigh' }], source: 'test' },
  build: { candidates: [{ harness: 'fake', model: 'claude-sonnet-5', effort: 'high' }], source: 'test' },
  wise: { candidates: [{ harness: 'fake', model: 'claude-fable-5', effort: 'xhigh' }], source: 'test' },
};

/**
 * Resolve one order packet all the way to the harness `start` args.
 *
 * These packets carry `consumes`/`owes` data, so the loop's consume-side gate
 * demands a verifier before any of it can reach a prompt. That gate is not what
 * these tests are about, so it is satisfied with a pass-through that admits the
 * packet unchanged; the refusal behavior has its own tests further down.
 */
async function startArgsFor(o: OrderOpts, map: MergedRoster = MAP): Promise<StartArgs> {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder(o), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({
    hub,
    adapter,
    resolveCrewRosters: resolvedRosters([map]),
    consumedVerifier: async (order) => ({ ok: true, order, warnings: [] }),
  });
  await createAgentRunLoop(h.opts).run();
  const start = adapter.calls.find((c) => c.kind === 'start');
  assert.ok(start !== undefined && start.kind === 'start');
  return start.args;
}

test('an exact compound row serves the order, and its model and effort ride to the harness', async () => {
  const args = await startArgsFor({ capabilities: ['build:deep'], modifier: 'deep' });
  assert.equal(args.model, 'claude-opus-5');
  assert.equal(args.effort, 'xhigh');
});

test('a compound with no exact row falls back to the bare capability name', async () => {
  // `build:express` has no row of its own; the bare `build` row covers every
  // modifier the operator did not call out.
  const args = await startArgsFor({ capabilities: ['build:express'], modifier: 'express' });
  assert.equal(args.model, 'claude-sonnet-5');
  assert.equal(args.effort, 'high');
});

test('an exact row on a LATER capability beats a bare row on an earlier one', async () => {
  // Both passes run across the whole list before the other is tried. Resolving
  // capability-by-capability instead would hand this order to `build`'s bare
  // row and never see that `wise` was named exactly.
  const args = await startArgsFor({ capabilities: ['build:express', 'wise'] });
  assert.equal(args.model, 'claude-fable-5');
  assert.equal(args.effort, 'xhigh');
});

test('an order carrying no capabilities runs on the harness default, not a guessed model', async () => {
  // Not a failure. A def with no `modifiers:` may author capability-silent
  // steps, and those have always run at whatever model the harness itself
  // defaults to. The loop says so on stderr rather than inventing a row.
  const args = await startArgsFor({ modifier: undefined });
  assert.equal(args.model, undefined);
  assert.equal(args.effort, undefined);
});

test('an order whose capabilities match no row is REFUSED, never run on a default model', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ capabilities: ['paint:deep'] })] });
  const h = buildOpts({ hub, adapter, resolveCrewRosters: resolvedRosters([MAP]) });

  const outcome = await createAgentRunLoop(h.opts).run();

  assert.equal(outcome, 'unresolvable-capability');
  assert.equal(adapter.calls.filter((c) => c.kind === 'start').length, 0, 'no harness turn was started');
  assert.equal(calls.filter((c) => c.verb === 'release').length, 1, 'the lease went back for another shift to try');
  assert.ok(h.errs.some((l) => l.includes('no crew roster row') && l.includes('paint:deep')));
});

test('a shift with NO roster at all refuses a capability-bearing order', async () => {
  // The map has no built-in default on purpose: a shift that never declared
  // what serves what must say so on its first order, not run everything on a
  // hardcoded model and look like it worked.
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder({ capabilities: ['build:deep'] })] });
  const h = buildOpts({ hub, adapter });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'unresolvable-capability');
  assert.equal(adapter.calls.filter((c) => c.kind === 'start').length, 0);
});

test('a capability-bearing order without a crew stamp is released loudly, never routed', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({
    getOrder: [agentOrder({ capabilities: ['build:deep'], omitCrewStamp: true })],
  });
  let resolverCalls = 0;
  const h = buildOpts({
    hub,
    adapter,
    resolveCrewRosters: () => {
      resolverCalls += 1;
      return { ok: true, rosters: [MAP] };
    },
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'unstamped-order');
  assert.equal(resolverCalls, 0);
  assert.equal(adapter.calls.filter((c) => c.kind === 'start').length, 0);
  assert.equal(calls.filter((c) => c.verb === 'release').length, 1);
  assert.ok(h.errs.some((line) => line.includes('NO crews stamp') && line.includes('no fallback')));
});

test('empty and malformed crew stamps are released without silently repairing them', async () => {
  for (const crews of [[], ['ok', '  ']]) {
    const adapter = createFakeAdapter();
    const { hub } = mockHub({ getOrder: [agentOrder({ capabilities: ['build:deep'], crews })] });
    let resolverCalls = 0;
    const h = buildOpts({
      hub,
      adapter,
      resolveCrewRosters: () => {
			resolverCalls += 1;
			return { ok: true, rosters: [MAP] };
      },
    });

    assert.equal(await createAgentRunLoop(h.opts).run(), 'unstamped-order');
    assert.equal(resolverCalls, 0, JSON.stringify(crews));
    assert.equal(adapter.calls.filter((c) => c.kind === 'start').length, 0);
    assert.ok(h.errs.some((line) => line.includes(JSON.stringify(crews))));
  }
});

test('an unresolvable stamped crew is released with its name and resolution error', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ capabilities: ['build:deep'], crews: ['openai'] })] });
  const h = buildOpts({
    hub,
    adapter,
    resolveCrewRosters: () => ({ ok: false, crew: 'openai', detail: 'invalid crew roster at /tmp/openai.json' }),
  });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'unresolvable-crew');
  assert.equal(adapter.calls.filter((c) => c.kind === 'start').length, 0);
  assert.equal(calls.filter((c) => c.verb === 'release').length, 1);
  assert.ok(h.errs.some((line) => line.includes('openai') && line.includes('invalid crew roster')));
});

test('the stamped crew order is the roster-resolution sequence', async () => {
  const a: MergedRoster = {
    build: { candidates: [{ harness: 'fake', model: 'from-a', effort: 'high' }], source: 'a' },
  };
  const b: MergedRoster = {
    build: { candidates: [{ harness: 'fake', model: 'from-b', effort: 'high' }], source: 'b' },
  };
  const byCrew: Record<string, MergedRoster> = { a, b };

  for (const [crews, model] of [[['a', 'b'], 'from-a'], [['b', 'a'], 'from-b']] as const) {
    const adapter = createFakeAdapter();
    const { hub } = mockHub({
      getOrder: [agentOrder({ capabilities: ['build'], crews: [...crews] }), agentOrder({ claimed: false, outcome: 'green' })],
    });
    let received: readonly string[] | undefined;
    const h = buildOpts({
      hub,
      adapter,
      resolveCrewRosters: (stamp) => {
			received = stamp;
			return { ok: true, rosters: stamp.map((crew) => byCrew[crew]!) };
      },
    });

    assert.equal(await createAgentRunLoop(h.opts).run(), 'submitted');
    const start = adapter.calls.find((call) => call.kind === 'start');
    assert.ok(start !== undefined && start.kind === 'start');
    assert.equal(start.args.model, model);
    assert.deepEqual(received, crews);
  }
});

test('the resolution is reported to the hub BEFORE the harness turn starts', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({
    getOrder: [agentOrder({ capabilities: ['build:deep'] }), agentOrder({ claimed: false, outcome: 'green' })],
  });
  const h = buildOpts({ hub, adapter, resolveCrewRosters: resolvedRosters([MAP]) });

  await createAgentRunLoop(h.opts).run();

  const report = calls.find((c) => c.verb === 'report_resolution');
  assert.ok(report !== undefined, 'the hub was told what this shift picked');
  assert.deepEqual(report.arg, {
    workflow: 'wf1',
    run: 'run1',
    resolution: {
      capability: 'build:deep',
      match: 'exact',
      model: 'claude-opus-5',
      effort: 'xhigh',
      harness: 'fake',
    },
  });
});

test('a bare-row hit reports match `bare`, and a refusal reports match `refused`', async () => {
  const bare = await reportFor({ capabilities: ['build:express'] }, MAP);
  assert.equal(bare?.match, 'bare');
  // The BARE NAME, not the compound — the hub records what actually served.
  assert.equal(bare?.capability, 'build');

  const refused = await reportFor({ capabilities: ['paint:deep'] }, MAP);
  assert.equal(refused?.match, 'refused');
  assert.equal(refused?.capability, 'paint:deep');
  assert.equal(refused?.model, undefined, 'a refusal names no model — none was chosen');
});

test('an order with no capabilities reports nothing — there was no routing decision', async () => {
  assert.equal(await reportFor({}, MAP), undefined);
});

test('a failing report_resolution is logged and the order runs anyway', async () => {
  // Observability must never be able to stop work. The hub verb's own contract
  // says the same on its side; this is the client half of that promise.
  const adapter = createFakeAdapter();
  const { hub } = mockHub({
    getOrder: [agentOrder({ capabilities: ['build:deep'] }), agentOrder({ claimed: false, outcome: 'green' })],
  });
  hub.reportResolution = async (): Promise<never> => {
    throw new HubError(500, 'report_resolution blew up');
  };
  const h = buildOpts({ hub, adapter, resolveCrewRosters: resolvedRosters([MAP]) });

  await createAgentRunLoop(h.opts).run();

  assert.equal(adapter.calls.filter((c) => c.kind === 'start').length, 1, 'the turn still ran');
  assert.ok(h.errs.some((l) => l.includes('reporting the resolution') && l.includes('continuing')));
});

/** Run one order and return the `resolution` payload the loop reported, if any. */
async function reportFor(
  o: OrderOpts,
  map: MergedRoster,
): Promise<Record<string, unknown> | undefined> {
  const { hub, calls } = mockHub({ getOrder: [agentOrder(o), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter: createFakeAdapter(), resolveCrewRosters: resolvedRosters([map]) });
  await createAgentRunLoop(h.opts).run();
  const report = calls.find((c) => c.verb === 'report_resolution');
  if (report === undefined) return undefined;
  return (report.arg as { resolution: Record<string, unknown> }).resolution;
}

test('the run modifier reaches the brief, and an engine escalation says so', async () => {
  const plain = await startArgsFor({ capabilities: ['build:deep'], modifier: 'deep' });
  assert.match(plain.brief, /^Routing: this run was started at the 'deep' depth modifier\.$/mu);
  assert.ok(!plain.brief.includes('RE-OFFERED'), 'a first pass is not announced as a recovery attempt');

  const escalated = await startArgsFor({ capabilities: ['build:deep'], modifier: 'deep', escalated: true });
  assert.match(escalated.brief, /RE-OFFERED at a deeper modifier/u);

  // No modifier on the packet means no routing line at all — a run started
  // without one is not "at the default depth", it is depth-less.
  const none = await startArgsFor({ capabilities: ['build:deep'] });
  assert.ok(!none.brief.includes('Routing:'));
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

// ---- operator-declared work roots -------------------------------------------
//
// The policy the OPERATOR of this machine set, not the hub. A denial is a
// RELEASE and it lands BEFORE the step spec is loaded and before any provider
// session opens, so a machine that was never configured to host this tree
// spends nothing on it.

test('a packet workdir outside every declared root is released before any session opens', async () => {
  const adapter = createFakeAdapter();
  const { hub, calls } = mockHub({ getOrder: [agentOrder({ workdir: '/elsewhere/proj' })] });
  const h = buildOpts({ hub, adapter, allowedWorkdirRoots: ['/allowed'] });

  assert.equal(await createAgentRunLoop(h.opts).run(), 'workdir-denied');
  assert.deepEqual(adapter.calls, []);
  assert.equal(h.records.length, 0);
  assert.ok(verbs(calls).includes('release'));
});

test('a packet workdir inside a declared root proceeds normally', async () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({
    getOrder: [agentOrder({ workdir: '/allowed/proj/wt' }), agentOrder({ claimed: false, outcome: 'green' })],
  });
  const h = buildOpts({ hub, adapter, allowedWorkdirRoots: ['/allowed'] });

  await createAgentRunLoop(h.opts).run();
  assert.equal(h.records[0]!.cwd, '/allowed/proj/wt');
});

test('a packet that names NO workdir is never denied, whatever the roots are', async () => {
  // The fallback is `<workRoot>/<workflow>/<run>/` — a directory owenloop
  // ITSELF created under the operator's own cache root. Denying that would deny
  // every agent order on any machine that declared a root at all.
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder(), agentOrder({ claimed: false, outcome: 'green' })] });
  const h = buildOpts({ hub, adapter, allowedWorkdirRoots: ['/allowed'] });

  await createAgentRunLoop(h.opts).run();
  assert.equal(h.records[0]!.cwd, '/fallback/cwd');
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

// ---- the shape contract reaches the harness ---------------------------------

test('a declared owed schema travels from the order packet into the rendered brief', () => {
  // The renderer and the projection are each covered on their own; this pins
  // the seam BETWEEN them. `briefOwes` is module-private and reshapes the
  // packet's owes into the brief spec, so a field the engine projects and the
  // renderer knows how to print still reaches nobody unless it is copied here.
  // That omission is silent — nothing fails, the agent is just never told the
  // shape, which is the exact defect this whole change exists to close.
  const schema = { type: 'object', required: ['url'], properties: { url: { type: 'string' } } };
  const adapter = createFakeAdapter();
  const { hub } = mockHub({
    getOrder: [agentOrder({ owes: [{ path: 'pr', schema, schemaAppliesTo: 'value' }] })],
  });
  const h = buildOpts({ hub, adapter });

  return createAgentRunLoop(h.opts)
    .run()
    .then(() => {
      const start = adapter.calls.find((c) => c.kind === 'start');
      assert.ok(start && start.kind === 'start', 'the adapter was started');
      assert.match(start.args.brief, /The value you submit to `pr` must satisfy this JSON Schema\./);
      assert.ok(start.args.brief.includes(JSON.stringify(schema, null, 2)), 'the schema arrives whole');
    });
});

test('a collection member schema keeps its `member` wording end to end', () => {
  const schema = { type: 'object', required: ['url'] };
  const adapter = createFakeAdapter();
  const { hub } = mockHub({
    getOrder: [agentOrder({ owes: [{ path: 'source[]', schema, schemaAppliesTo: 'member' }] })],
  });
  const h = buildOpts({ hub, adapter });

  return createAgentRunLoop(h.opts)
    .run()
    .then(() => {
      const start = adapter.calls.find((c) => c.kind === 'start');
      assert.ok(start && start.kind === 'start');
      assert.match(start.args.brief, /Each member you emit into `source\[\]` must satisfy this JSON Schema/);
    });
});

test('an order whose owes declare no schema renders no shape claim', () => {
  const adapter = createFakeAdapter();
  const { hub } = mockHub({ getOrder: [agentOrder({ owes: [{ path: 'pr' }] })] });
  const h = buildOpts({ hub, adapter });

  return createAgentRunLoop(h.opts)
    .run()
    .then(() => {
      const start = adapter.calls.find((c) => c.kind === 'start');
      assert.ok(start && start.kind === 'start');
      assert.ok(!/JSON Schema/.test(start.args.brief), 'silence, not a claim of being unconstrained');
    });
});
