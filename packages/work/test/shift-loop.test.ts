import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  createShiftLoop,
  HUB_PICKUP_WINDOW_MS,
  MAX_PENDING_CANDIDATE_AGE_MS,
  MAX_RELEASE_REASON_POINTS,
  STEP_BRAKE_DECAY_MS,
  STEP_BRAKE_DELAYS_MS,
  withDispatchLock,
  type ShiftLoop,
  type ShiftLoopOptions,
} from '../src/shift/loop.ts';
import {
  buildSpawnPlan,
  createDefaultSpawner,
  type SpawnSpec,
  type Spawner,
  type WorkerExit,
} from '../src/shift/spawn.ts';
import {
  finalizeChildReservation,
  readChildRecords,
  readChildReservations,
  removeChildRecord,
  reserveChild,
  startReservedChild,
  ShiftStateRecordError,
  writeChildRecord,
} from '../src/shift/state.ts';
import { sessionsPath } from '../src/harness/session-store.ts';
import { readStepSpec, writeBundle } from '../src/bundle/cache.ts';
import type { CachedBundle } from '../src/bundle/types.ts';
import type { NormalizedStepSpec } from '../src/bundle/types.ts';
import { ORDER_TOKEN, ORIGIN_TOKEN } from '../src/agent/brief.ts';
import { installSignalHandlers, type SignalHost } from '../src/roles/signals.ts';
import { exitCodeFor } from '../src/roles/agent-run.ts';
import type { HubClient } from '../src/hub/client.ts';
import { reachesSocketConsumer } from '../src/shift/runtime.ts';
import { HubError, type InboxInstance, type WorkOrder } from '../src/hub/types.ts';

// ---- fixtures ---------------------------------------------------------------
//
// D2 dispatch split: the shift makes NO first-contact get_order. COMMAND orders
// spawn a detached `owenloop work exec` child (+ `exec` record); AGENT orders spawn a
// detached `owenloop work agent-run` child (+ `agent-run` record). BOTH lanes spawn —
// there is no lean-order handout and no flag selecting between paths. Metering
// counts both record kinds. These tests exercise both lanes accordingly.

/** The options object the shift builds for `sweepWorkDirs` (Phase 4 reaper). */
type SweepOpts = Parameters<NonNullable<ShiftLoopOptions['sweepWorkDirs']>>[0];

const ORIGIN = 'https://hub.example';
const DEMO_HASH = 'abcdef1234567890';

let stateDir: string;
let cacheDir: string;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-loop-'));
  stateDir = join(root, 'state');
  cacheDir = join(root, 'cache');
});
afterEach(() => {
  for (const d of [stateDir, cacheDir]) rmSync(join(d, '..'), { recursive: true, force: true });
});

interface Call {
  verb: string;
  arg?: unknown;
}

interface WakeStep {
  changed?: boolean;
  cursor?: number;
  throw?: boolean;
  error?: Error;
}

interface MockCfg {
  wake?: WakeStep[];
  inbox?: string[];
  inboxInstances?: InboxInstance[];
  perWf?: Record<string, { def?: string; orders: WorkOrder[] }>;
  perWfThrows?: Record<string, Error>;
  onTargetedWhatsNext?: () => void | Promise<void>;
  presenceThrows?: boolean;
  presence?: Array<{ error?: Error }>;
  releaseError?: Error;
}

function mockHub(cfg: MockCfg): { hub: HubClient; calls: Call[] } {
  const calls: Call[] = [];
  let wakeIdx = 0;
  let presenceIdx = 0;
  const hub: HubClient = {
    // Not exercised here: the byte-bodied upload has its own tests.
    async putFileArtifact() {
      throw new Error('putFileArtifact is not exercised by this test');
    },
    async wake(cursor) {
      calls.push({ verb: 'wake', arg: cursor });
      const seq = cfg.wake ?? [{ changed: true, cursor: 1 }];
      const s = seq[Math.min(wakeIdx, seq.length - 1)]!;
      wakeIdx++;
      if (s.error !== undefined) throw s.error;
      if (s.throw) throw new Error('wake boom');
      return { text: '', cursor: s.cursor ?? 0, changed: s.changed ?? true };
    },
    async presencePing(req) {
      calls.push({ verb: 'presence', arg: req });
      const sequence = cfg.presence;
      if (sequence !== undefined && sequence.length > 0) {
	const step = sequence[Math.min(presenceIdx, sequence.length - 1)]!;
	presenceIdx++;
	if (step.error !== undefined) throw step.error;
      }
      if (cfg.presenceThrows) throw new Error('presence boom');
      return { text: '', ok: true, name: req.name, lastSeen: 0 };
    },
    async whatsNext(req) {
      calls.push({ verb: 'whats_next', arg: req });
      if (req === undefined || req.workflow === undefined) {
	const instances: InboxInstance[] = cfg.inboxInstances ?? (cfg.inbox ?? []).map((w) => ({
          workflow: w,
          def: 'demo',
          done: false,
          eligible: 1,
          blocked: 0,
          owedSeededInputs: [],
        }));
        return { text: '', instances };
      }
      await cfg.onTargetedWhatsNext?.();
      const failure = cfg.perWfThrows?.[req.workflow];
      if (failure !== undefined) throw failure;
      const p = cfg.perWf?.[req.workflow] ?? { orders: [] };
      return { text: '', workflow: req.workflow, ...(p.def !== undefined ? { def: p.def } : {}), orders: p.orders };
    },
    async getOrder(req) {
      calls.push({ verb: 'get_order', arg: req });
      return { text: '', workflow: req.workflow, run: req.run, order: null, lease: { claimed: true } };
    },
    async heartbeat() {
      return { text: '' };
    },
    async release(req) {
      calls.push({ verb: 'release', arg: req });
      if (cfg.releaseError !== undefined) throw cfg.releaseError;
      return { text: '' };
    },
    async submit(req) {
      calls.push({ verb: 'submit', arg: req });
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
      return { text: '', workflow: req.workflow, run: req.run, step: '', recorded: true, claimed: true };
    },
    async whoami() {
      return { text: '', orgId: '', orgName: '', actor: { id: '', kind: 'agent', role: 'agent', scopes: [] }, tokenStatus: 'active', authMethod: 'token' };
    },
  };
  return { hub, calls };
}

function wo(run: string, step: string, workflow = 'wf1'): WorkOrder {
  return { workflow, run, step, consumes: {}, expected_outputs: [], feedback: [], advisory: {}, submit_hint: '' };
}

function modernWo(
  run: string,
  step: string,
  worker: 'command' | 'agent',
  defDigest = 'sha256:order-pinned',
): WorkOrder {
  return { ...wo(run, step), worker, defDigest };
}

function fakeSpawner(): { spawner: Spawner; spawns: SpawnSpec[] } {
  const spawns: SpawnSpec[] = [];
  let pid = 1000;
  const spawner: Spawner = (spec) => {
    spawns.push(spec);
    return { pid: pid++ };
  };
  return { spawner, spawns };
}

function baseOpts(hub: HubClient, spawner: Spawner, extra: Partial<ShiftLoopOptions> = {}): ShiftLoopOptions {
  return {
    hub,
    spawner,
    sleep: async () => {},
    now: () => 0,
    out: () => {},
    err: () => {},
    cacheDir,
    stateDir,
    cap: 3,
    serveCrews: [],
    name: 'box',
    pollIntervalMs: 5000,
    presenceIntervalMs: 60_000,
    isAlive: () => true,
    ...extra,
  };
}

const count = (calls: Call[], verb: string): number => calls.filter((c) => c.verb === verb).length;

/** Cache a bundle whose 'cmd' step is a COMMAND step (exec/spawn lane). */
function cacheCommandBundle(): void {
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: DEMO_HASH, steps: [{ name: 'cmd', executor: 'command' }] },
    fetchedAt: Date.now(),
    origin: 'x',
  };
  writeBundle(cacheDir, bundle, []);
}

/** Cache a legacy bundle with both dispatch lanes represented. */
function cacheMixedBundle(): void {
  const bundle: CachedBundle = {
    def: {
      name: 'demo',
      hash: DEMO_HASH,
      steps: [{ name: 'builder', body: '' }, { name: 'cmd', executor: 'command' }],
    },
    fetchedAt: Date.now(),
    origin: 'x',
  };
  writeBundle(cacheDir, bundle, []);
}

const BRIEF_BODY = `run ${ORDER_TOKEN} @ ${ORIGIN_TOKEN}\n`;

/** Cache a bundle whose 'builder' step is an AGENT step with a real brief. */
function cacheBuilderStep(): void {
  const tpl: NormalizedStepSpec = { step: 'builder', brief: BRIEF_BODY, permissions: { extensions: {} } };
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: DEMO_HASH, steps: [{ name: 'builder', body: '' }] },
    fetchedAt: Date.now(),
    origin: 'x',
  };
  writeBundle(cacheDir, bundle, [tpl]);
}

/** Command orders that spawn need a cached command bundle + def echoed back. */
function cmdWf(orders: WorkOrder[]): Record<string, { def: string; orders: WorkOrder[] }> {
  return { wf1: { def: 'demo', orders } };
}

// ---- park-loop behavior -----------------------------------------------------

test('changed:false ⇒ no whats_next sweep', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 5 }] });
  const { spawner } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1' })).run();
  assert.equal(count(calls, 'wake'), 1);
  assert.equal(count(calls, 'whats_next'), 0);
});

test('changed:true ⇒ sweep and spawn a command order (no shift-side get_order)', async () => {
  cacheCommandBundle();
  const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: cmdWf([wo('run_aaaa1111', 'cmd')]) });
  const { spawner, spawns } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1' })).run();
  assert.equal(count(calls, 'whats_next'), 1);
  assert.equal(count(calls, 'get_order'), 0); // the shift never first-contacts
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.run, 'run_aaaa1111');
});

// WO-4.3 selection contract at the wire: the per-instance whats_next call must
// carry serve_crews equal to opts.serveCrews — the DEFAULT [] (hub reads empty
// as "serve ALL the actor's crews") and a NARROWED subset both reach it. This
// is the whats_next twin of the presence-side assertion below (~L256); it does
// NOT duplicate the hub-client forwarding tests in test/hub-client.test.ts.
const perWfWhatsNext = (calls: Call[]): unknown =>
  calls.find((c) => c.verb === 'whats_next' && (c.arg as { workflow?: string } | undefined)?.workflow === 'wf1')?.arg;

test('whats_next carries serve_crews and the default empty serving set per instance', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { orders: [] } } });
  const { spawner } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1', serveCrews: [] })).run();
  assert.deepEqual(perWfWhatsNext(calls), { workflow: 'wf1', serve_crews: [], serve_capabilities: [] });
});

test('whats_next carries serve_crews and the default empty serving set for a narrowed shift', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { orders: [] } } });
  const { spawner } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1', serveCrews: ['a'] })).run();
  assert.deepEqual(perWfWhatsNext(calls), { workflow: 'wf1', serve_crews: ['a'], serve_capabilities: [] });
});

test('the computed serving set is sent on inbox, targeted, and presence requests', async () => {
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    inbox: ['wf1'],
    perWf: { wf1: { orders: [] } },
  });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    computeServeCapabilities: () => ['build', 'review:deep'],
  }));

  await loop.run();

  const inbox = calls.find((call) => call.verb === 'whats_next' && (call.arg as { workflow?: string }).workflow === undefined);
  const targeted = perWfWhatsNext(calls);
  const presence = calls.find((call) => call.verb === 'presence');
  assert.deepEqual(inbox?.arg, { serve_capabilities: ['build', 'review:deep'] });
  assert.deepEqual(targeted, {
    workflow: 'wf1',
    serve_crews: [],
    serve_capabilities: ['build', 'review:deep'],
  });
  assert.deepEqual(presence?.arg, {
    name: 'box',
    serve_crews: [],
    serve_capabilities: ['build', 'review:deep'],
  });

  const exposed = loop.getServeCapabilities();
  exposed.pop();
  assert.deepEqual(loop.getServeCapabilities(), ['build', 'review:deep']);
});

test('monotonic cursor adoption across ticks', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 5 }, { changed: false, cursor: 9 }] });
  const { spawner } = fakeSpawner();
  const h: { loop?: ShiftLoop } = {};
  let sleeps = 0;
  const sleep = async (): Promise<void> => {
    sleeps++;
    if (sleeps >= 2) h.loop!.stop();
  };
  const loop = createShiftLoop(baseOpts(hub, spawner, { sleep, workflow: 'wf1' }));
  h.loop = loop;
  const code = await loop.run();
  assert.equal(code, 0);
  const wakes = calls.filter((c) => c.verb === 'wake');
  assert.equal(wakes[0]!.arg, undefined); // bootstrap
  assert.equal(wakes[1]!.arg, 5); // adopted the first cursor
});

test('wake failure is non-fatal — the loop survives and retries', async () => {
  const { hub, calls } = mockHub({ wake: [{ throw: true }, { changed: false, cursor: 2 }] });
  const { spawner } = fakeSpawner();
  const h: { loop?: ShiftLoop } = {};
  let sleeps = 0;
  const sleep = async (): Promise<void> => {
    sleeps++;
    if (sleeps >= 2) h.loop!.stop();
  };
  const loop = createShiftLoop(baseOpts(hub, spawner, { sleep, workflow: 'wf1' }));
  h.loop = loop;
  const code = await loop.run();
  assert.equal(code, 0);
  assert.equal(count(calls, 'wake'), 2);
  assert.equal(count(calls, 'whats_next'), 0); // never swept after a wake throw
});

test('Retry-After metadata delays the next Shift poll', async () => {
  const { hub } = mockHub({
    wake: [{ error: new HubError(429, 'slow down', 'rate_limited', 23_000) }],
  });
  const { spawner } = fakeSpawner();
  const sleeps: number[] = [];
  const holder: { loop?: ShiftLoop } = {};
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    monotonicNow: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
      holder.loop!.stop();
    },
  }));
  holder.loop = loop;

  await loop.run();
  assert.deepEqual(sleeps, [23_000]);
});

test('presence Retry-After skips wake and whats_next in the same iteration and controls sleep', async () => {
  const { hub, calls } = mockHub({
    presence: [{ error: new HubError(429, 'slow down', 'rate_limited', 23_000) }],
  });
  const { spawner } = fakeSpawner();
  const sleeps: number[] = [];
  const holder: { loop?: ShiftLoop } = {};
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    monotonicNow: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
      holder.loop!.stop();
    },
  }));
  holder.loop = loop;

  await loop.run();

  assert.deepEqual(calls.map((call) => call.verb), ['presence']);
  assert.deepEqual(sleeps, [23_000]);
});

test('an iteration inside Retry-After performs local reconciliation but no hub polling', async () => {
  let now = 0;
  let monotonic = 0;
  const { hub, calls } = mockHub({
    presence: [{ error: new HubError(429, 'slow down', 'rate_limited', 23_000) }],
  });
  const { spawner } = fakeSpawner();
  const events: string[] = [];
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    now: () => now,
    monotonicNow: () => monotonic,
    isAlive: () => false,
    onEvent: (event) => events.push(event.type),
  }));

  await loop.iterate();
  writeChildRecord(stateDir, {
    workflow: 'wf1',
    run: 'run_dead_during_backoff',
    pid: 44,
    spawnedAt: 0,
    kind: 'exec',
  });
  now = 10_000;
  monotonic = 10_000;

  await loop.iterate();

  assert.deepEqual(calls.map((call) => call.verb), ['presence']);
  assert.deepEqual(events, ['reaped']);
  assert.equal(readChildRecords(stateDir).length, 0);
});

test('presence Retry-After still dispatches an already-queued local claim', async () => {
  cacheBuilderStep();
  const rateLimited = new HubError(429, 'slow down', 'rate_limited', 23_000);
  const orders = [wo('run_first', 'builder'), wo('run_queued', 'builder')];
  const { hub, calls } = mockHub({
    presence: [{}, { error: rateLimited }],
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf(orders),
  });
  const alive = new Set<number>();
  const spawns: SpawnSpec[] = [];
  let pid = 1000;
  const spawner: Spawner = (spec) => {
    spawns.push(spec);
    alive.add(pid);
    return { pid: pid++ };
  };
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 10,
    maxConcurrentAgents: 1,
    localQueueHoldMs: MAX_PENDING_CANDIDATE_AGE_MS,
    presenceIntervalMs: 0,
    isAlive: (candidatePid) => alive.has(candidatePid),
  }));

  assert.equal(await loop.iterate(), 1);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);
  const callsBeforeBackoff = calls.length;
  alive.delete(1000);

  assert.equal(await loop.iterate(), 1);

  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first', 'run_queued']);
  assert.deepEqual(
    calls.slice(callsBeforeBackoff).map((call) => call.verb),
    ['presence'],
    'the rate-limited iteration must do no later hub polling',
  );
});

test('a targeted whats_next Retry-After stops the remaining workflow sweep', async () => {
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    inbox: ['wf1', 'wf2', 'wf3'],
    perWfThrows: {
      wf1: new HubError(429, 'slow down', 'rate_limited', 23_000),
    },
  });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner));

  await loop.iterate();

  const targeted = calls
    .filter((call) => call.verb === 'whats_next')
    .map((call) => (call.arg as { workflow?: string } | undefined)?.workflow)
    .filter((workflow): workflow is string => workflow !== undefined);
  assert.deepEqual(targeted, ['wf1']);
});

for (const wallJump of [-1_000_000_000, 1_000_000_000]) {
  const direction = wallJump < 0 ? 'backward' : 'forward';
  test(`a ${direction} wall-clock jump does not change a Retry-After deadline`, async () => {
    let wall = 50_000;
    let monotonic = 0;
    const { hub, calls } = mockHub({
      presence: [{ error: new HubError(429, 'slow down', 'rate_limited', 23_000) }, {}],
      wake: [{ changed: false, cursor: 1 }],
    });
    const { spawner } = fakeSpawner();
    const loop = createShiftLoop(baseOpts(hub, spawner, {
      workflow: 'wf1',
      now: () => wall,
      monotonicNow: () => monotonic,
    }));

    await loop.iterate();
    wall += wallJump;
    monotonic = 22_999;
    await loop.iterate();
    assert.deepEqual(calls.map((call) => call.verb), ['presence']);

    monotonic = 23_000;
    await loop.iterate();
    assert.deepEqual(calls.map((call) => call.verb), ['presence', 'presence', 'wake']);
  });
}

// ---- presence cadence -------------------------------------------------------

test('presence pings on its own cadence, carrying name, serve crews, and serving set', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
  const { spawner } = fakeSpawner();
  let t = 0;
  const h: { loop?: ShiftLoop } = {};
  let sleeps = 0;
  const sleep = async (): Promise<void> => {
    sleeps++;
    t += 30_000;
    if (sleeps >= 3) h.loop!.stop();
  };
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    sleep,
    now: () => t,
    monotonicNow: () => t,
    serveCrews: ['x'],
    presenceIntervalMs: 60_000,
    workflow: 'wf1',
  }));
  h.loop = loop;
  await loop.run();
  const pings = calls.filter((c) => c.verb === 'presence');
  assert.equal(pings.length, 2); // t=0 and t=60000, not the t=30000 tick
  assert.deepEqual(pings[0]!.arg, { name: 'box', serve_crews: ['x'], serve_capabilities: [] });
});

for (const wallJump of [-1_000_000_000, 1_000_000_000]) {
  const direction = wallJump < 0 ? 'backward' : 'forward';
  test(`a ${direction} wall-clock jump does not change presence cadence`, async () => {
    let wall = 50_000;
    let monotonic = 0;
    const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
    const { spawner } = fakeSpawner();
    const loop = createShiftLoop(baseOpts(hub, spawner, {
      workflow: 'wf1',
      now: () => wall,
      monotonicNow: () => monotonic,
      presenceIntervalMs: 60_000,
    }));

    await loop.iterate();
    wall += wallJump;
    monotonic = 59_999;
    await loop.iterate();
    assert.equal(count(calls, 'presence'), 1);

    monotonic = 60_000;
    await loop.iterate();
    assert.equal(count(calls, 'presence'), 2);
  });
}

// W7: when the role wires shiftId/startedAt, presence carries them too
// (advisory only, D8/INV-82); omitted when unset (the test above).
test('presence carries shift_id + started_at when the role sets them', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
  const { spawner } = fakeSpawner();
  await createShiftLoop(
    baseOpts(hub, spawner, { once: true, workflow: 'wf1', shiftId: 'shf_abc', startedAt: 12345 }),
  ).run();
  const pings = calls.filter((c) => c.verb === 'presence');
  assert.equal(pings.length, 1);
  assert.deepEqual(pings[0]!.arg, { name: 'box', serve_crews: [], serve_capabilities: [], shift_id: 'shf_abc', started_at: 12345 });
});

test('a presence failure does not kill the loop', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }], presenceThrows: true });
  const { spawner } = fakeSpawner();
  const code = await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1' })).run();
  assert.equal(code, 0);
  assert.equal(count(calls, 'presence'), 1);
  assert.equal(count(calls, 'wake'), 1); // reached wake despite the presence throw
});

test('a roster cache refresh failure logs continuing and does not stop dispatch', async () => {
	const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
	const { spawner } = fakeSpawner();
	const errors: string[] = [];
	const events: Array<{ type: string; op?: string; message?: string }> = [];
	let revision = 'before';
	const code = await createShiftLoop(baseOpts(hub, spawner, {
		once: true,
		rosterSyncIntervalMs: 0,
		syncRosters: async () => {
			revision = 'after';
			throw new Error('hub unavailable');
		},
		computeServeCapabilities: () => [revision],
		err: (line) => errors.push(line),
		onEvent: (event) => events.push(event),
	})).run();
	assert.equal(code, 0);
	assert.equal(count(calls, 'wake'), 1);
	assert.deepEqual(calls.find((call) => call.verb === 'presence')?.arg, {
		name: 'box',
		serve_crews: [],
		serve_capabilities: ['after'],
	});
	assert.match(errors.join('\n'), /roster sync failed: hub unavailable \(continuing\)/u);
	assert.deepEqual(events.filter((event) => event.type === 'hub-error'), [
		{ type: 'hub-error', op: 'roster_sync', message: 'roster sync failed: hub unavailable (continuing)', ts: new Date(0).toISOString(), shift: 'box', shiftId: '' },
	]);
});

test('a throwing serving-set computation retains the last advertisement and does not stop the loop', async () => {
	const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
	const { spawner } = fakeSpawner();
	let failCompute = false;
	const loop = createShiftLoop(baseOpts(hub, spawner, {
		once: true,
		rosterSyncIntervalMs: 0,
		syncRosters: async () => {},
		computeServeCapabilities: () => {
			if (failCompute) throw new Error('bad roster');
			return ['last-good'];
		},
	}));

	failCompute = true;
	const code = await loop.run();

	assert.equal(code, 0);
	assert.deepEqual(loop.getServeCapabilities(), ['last-good']);
	assert.deepEqual(calls.find((call) => call.verb === 'presence')?.arg, {
		name: 'box',
		serve_crews: [],
		serve_capabilities: ['last-good'],
	});
	assert.equal(count(calls, 'wake'), 1);
});

test('a never-settling roster refresh times out and the shift still reaches normal work', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
  const { spawner } = fakeSpawner();
  let aborted = false;
  const errors: string[] = [];
  const code = await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    rosterSyncIntervalMs: 0,
    rosterSyncTimeoutMs: 1,
    syncRosters: (signal) => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })),
    err: (line) => errors.push(line),
  })).run();
  assert.equal(code, 0);
  assert.equal(aborted, true);
  assert.equal(count(calls, 'wake'), 1);
  assert.match(errors.join('\n'), /aborted|timed out/u);
});

test('a failed roster refresh advances its cadence instead of retrying on every poll', async () => {
  const { hub } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
  const { spawner } = fakeSpawner();
  const holder: { loop?: ShiftLoop } = {};
  let now = 0;
  let sleeps = 0;
  let attempts = 0;
  const sleep = async (): Promise<void> => {
    sleeps++;
    now = sleeps === 1 ? 5 : sleeps === 2 ? 6 : 7;
    if (sleeps >= 3) holder.loop!.stop();
  };
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    sleep,
    monotonicNow: () => now,
    rosterSyncIntervalMs: 5,
    syncRosters: async () => { attempts++; throw new Error('hub unavailable'); },
  }));
  holder.loop = loop;
  assert.equal(await loop.run(), 0);
  assert.equal(attempts, 1, 'the next two polls are still inside the 5ms attempt cadence');
});

test('a rate-limited roster refresh suppresses the due presence ping for that iteration', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
  const { spawner } = fakeSpawner();
  const code = await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    rosterSyncIntervalMs: 0,
    syncRosters: async () => { throw new HubError(429, 'slow down', 'rate_limited', 60_000); },
  })).run();
  assert.equal(code, 0);
  assert.equal(count(calls, 'presence'), 0, 'Retry-After suppresses all later hub calls in this iteration');
  assert.equal(count(calls, 'wake'), 0, 'the existing backoff guard still suppresses the poll');
});

// ---- metering (command lane) ------------------------------------------------

test('over-cap command orders are metered: cap 3 of 5 offered spawn', async () => {
  cacheCommandBundle();
  const orders = ['run_1', 'run_2', 'run_3', 'run_4', 'run_5'].map((r) => wo(r, 'cmd'));
  const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: cmdWf(orders) });
  const { spawner, spawns } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1', cap: 3 })).run();
  assert.equal(spawns.length, 3); // cap 3, 5 offered
  assert.equal(count(calls, 'get_order'), 0);
});

test('pre-existing live records count against capacity (startup recovery)', async () => {
  cacheCommandBundle();
  writeChildRecord(stateDir, { workflow: 'wf1', run: 'run_old1', pid: 11, spawnedAt: 0 });
  writeChildRecord(stateDir, { workflow: 'wf1', run: 'run_old2', pid: 22, spawnedAt: 0 });
  const orders = ['run_a', 'run_b', 'run_c'].map((r) => wo(r, 'cmd'));
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: cmdWf(orders) });
  const { spawner, spawns } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1', cap: 3, isAlive: () => true })).run();
  assert.equal(spawns.length, 1); // 3 cap − 2 live = 1 free
});

test('dead records are reaped, freeing capacity', async () => {
  cacheCommandBundle();
  writeChildRecord(stateDir, { workflow: 'wf1', run: 'run_dead1', pid: 11, spawnedAt: 0 });
  writeChildRecord(stateDir, { workflow: 'wf1', run: 'run_dead2', pid: 22, spawnedAt: 0 });
  const orders = ['run_a', 'run_b', 'run_c'].map((r) => wo(r, 'cmd'));
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: cmdWf(orders) });
  const { spawner, spawns } = fakeSpawner();
  // isAlive false for the recovered records (pid<100), true for freshly spawned (pid>=1000)
  const isAlive = (pid: number): boolean => pid >= 1000;
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1', cap: 3, isAlive })).run();
  assert.equal(spawns.length, 3); // both dead ⇒ full capacity
});

test('a command order already tracked by a live exec record is not re-spawned (dedupe)', async () => {
  cacheCommandBundle();
  writeChildRecord(stateDir, { workflow: 'wf1', run: 'run_dup', pid: 11, spawnedAt: 0, kind: 'exec' });
  const orders = [wo('run_dup', 'cmd'), wo('run_new', 'cmd')];
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: cmdWf(orders) });
  const { spawner, spawns } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1', cap: 3, isAlive: () => true })).run();
  assert.deepEqual(spawns.map((s) => s.run), ['run_new']);
});

test('at zero free capacity the loop skips whats_next entirely', async () => {
  writeChildRecord(stateDir, { workflow: 'wf1', run: 'r1', pid: 1, spawnedAt: 0 });
  writeChildRecord(stateDir, { workflow: 'wf1', run: 'r2', pid: 2, spawnedAt: 0 });
  writeChildRecord(stateDir, { workflow: 'wf1', run: 'r3', pid: 3, spawnedAt: 0 });
  const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: cmdWf([wo('run_x', 'cmd')]) });
  const { spawner, spawns } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1', cap: 3, isAlive: () => true })).run();
  assert.equal(count(calls, 'whats_next'), 0);
  assert.equal(spawns.length, 0);
});

test('a changed wake skipped at full capacity is swept after capacity frees even when the cursor is unchanged', async () => {
  cacheCommandBundle();
  writeChildRecord(stateDir, { workflow: 'wf1', run: 'run_prior', pid: 10, spawnedAt: 0 });
  const alive = new Set([10]);
  const { hub, calls } = mockHub({
    wake: [
      { changed: true, cursor: 1 },
      { changed: false, cursor: 1 },
    ],
    perWf: cmdWf([wo('run_next', 'cmd')]),
  });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(
    baseOpts(hub, spawner, {
      workflow: 'wf1',
      cap: 1,
      isAlive: (pid) => pid >= 1000 || alive.has(pid),
    }),
  );

  assert.equal(await loop.iterate(), 0);
  assert.equal(count(calls, 'whats_next'), 0);

  alive.delete(10);

  assert.equal(await loop.iterate(), 1);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_next']);
  assert.equal(count(calls, 'whats_next'), 1);
});

// ---- inbox mode -------------------------------------------------------------

test('inbox mode fans out to each servable instance', async () => {
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: DEMO_HASH, steps: [{ name: 'cmd', executor: 'command' }] },
    fetchedAt: Date.now(),
    origin: 'x',
  };
  writeBundle(cacheDir, bundle, []);
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    inbox: ['wfA', 'wfB'],
    perWf: {
      wfA: { def: 'demo', orders: [wo('run_a', 'cmd', 'wfA')] },
      wfB: { def: 'demo', orders: [wo('run_b', 'cmd', 'wfB')] },
    },
  });
  const { spawner, spawns } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, cap: 3 })).run();
  // one inbox call + one per-instance whats_next each
  assert.equal(count(calls, 'whats_next'), 3);
  assert.deepEqual(spawns.map((s) => s.run).sort(), ['run_a', 'run_b']);
});

const inboxInstance = (workflow: string, eligible: number): InboxInstance => ({
  workflow,
  def: 'demo',
  done: false,
  eligible,
  blocked: 0,
  owedSeededInputs: [],
});

async function inboxFanOutScenario(servable: ReadonlySet<string>): Promise<{ calls: Call[]; spawns: SpawnSpec[]; workflows: string[] }> {
  cacheCommandBundle();
  const workflows = Array.from({ length: 11 }, (_, index) => `wf${String(index + 1).padStart(2, '0')}`);
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    inboxInstances: workflows.map((workflow) => inboxInstance(workflow, servable.has(workflow) ? 1 : 0)),
    perWf: Object.fromEntries(workflows.map((workflow) => [
      workflow,
      { def: 'demo', orders: [wo(`run_${workflow}`, 'cmd', workflow)] },
    ])),
  });
  const { spawner, spawns } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, cap: workflows.length })).run();
  return { calls, spawns, workflows };
}

const targetedWorkflows = (calls: Call[]): string[] => calls
  .filter((call) => call.verb === 'whats_next' && (call.arg as { workflow?: string }).workflow !== undefined)
  .map((call) => (call.arg as { workflow: string }).workflow);

test('inbox mode targets only the two workflows with eligible work', async () => {
  const servable = new Set(['wf03', 'wf09']);
  const { calls, spawns } = await inboxFanOutScenario(servable);

  assert.equal(
    calls.filter((call) => call.verb === 'whats_next' && (call.arg as { workflow?: string }).workflow === undefined).length,
    1,
  );
  assert.deepEqual(targetedWorkflows(calls), ['wf03', 'wf09']);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_wf03', 'run_wf09']);
});

test('inbox mode keeps the all-servable fan-out and dispatch control unchanged', async () => {
  const servable = new Set(Array.from({ length: 11 }, (_, index) => `wf${String(index + 1).padStart(2, '0')}`));
  const { calls, spawns, workflows } = await inboxFanOutScenario(servable);

  assert.equal(
    calls.filter((call) => call.verb === 'whats_next' && (call.arg as { workflow?: string }).workflow === undefined).length,
    1,
  );
  assert.deepEqual(targetedWorkflows(calls), workflows);
  assert.deepEqual(
    calls
      .filter((call) => call.verb === 'whats_next' && (call.arg as { workflow?: string }).workflow !== undefined)
      .map((call) => call.arg),
    workflows.map((workflow) => ({ workflow, serve_crews: [], serve_capabilities: [] })),
  );
  assert.deepEqual(spawns.map((spawn) => spawn.run), workflows.map((workflow) => `run_${workflow}`));
});

test('inbox filtering fails open for missing and malformed eligible values', async () => {
  const malformed = {
    workflow: 'wfMalformed',
    def: 'demo',
    done: false,
    eligible: 'zero',
    blocked: 0,
    owedSeededInputs: [],
  } as unknown as InboxInstance;
  const missing = {
    workflow: 'wfMissing',
    def: 'demo',
    done: false,
    blocked: 0,
    owedSeededInputs: [],
  } as unknown as InboxInstance;
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    inboxInstances: [inboxInstance('wfZero', 0), missing, malformed],
  });
  const { spawner } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true })).run();

  assert.deepEqual(targetedWorkflows(calls), ['wfMissing', 'wfMalformed']);
});

test('explicit workflow mode has no inbox request and always targets the configured workflow', async () => {
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    inboxInstances: [inboxInstance('wfExplicit', 0)],
    perWf: { wfExplicit: { orders: [] } },
  });
  const { spawner } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wfExplicit' })).run();

  assert.deepEqual(calls.filter((call) => call.verb === 'whats_next').map((call) => call.arg), [{
    workflow: 'wfExplicit',
    serve_crews: [],
    serve_capabilities: [],
  }]);
});

test('a zero-eligible inbox snapshot defers newly eligible work until the next poll', async () => {
  cacheCommandBundle();
  const instances = [inboxInstance('wfRace', 0)];
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }, { changed: true, cursor: 2 }],
    inboxInstances: instances,
    perWf: { wfRace: { def: 'demo', orders: [wo('run_race', 'cmd', 'wfRace')] } },
  });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner));

  await loop.iterate();
  assert.deepEqual(targetedWorkflows(calls), []);
  instances[0]!.eligible = 1;
  await loop.iterate();
  assert.deepEqual(targetedWorkflows(calls), ['wfRace']);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_race']);
});

test('the reaper keeps a zero-eligible workflow directory while reaping an observed sibling', async () => {
  const workRoot = join(cacheDir, 'work');
  const skipped = join(workRoot, 'wfZero', 'run_zero');
  const observed = join(workRoot, 'wfEligible', 'run_eligible');
  mkdirSync(skipped, { recursive: true });
  mkdirSync(observed, { recursive: true });
  for (const dir of [skipped, observed]) utimesSync(dir, new Date(0), new Date(0));

  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    inboxInstances: [inboxInstance('wfZero', 0), inboxInstance('wfEligible', 1)],
    perWf: { wfEligible: { orders: [] } },
  });
  const { spawner } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    workRoot,
    workDirTtlMs: 0,
    now: () => Date.now(),
  })).run();

  assert.deepEqual(targetedWorkflows(calls), ['wfEligible']);
  assert.ok(existsSync(skipped), 'the inbox-only workflow has no run-list evidence and is not scanned');
  assert.ok(!existsSync(observed), 'the targeted sibling is scanned and its expired empty directory is reaped');
});

test('a terminal-between-inbox-and-fetch race is consumed once without repeated error logging', async () => {
  const terminal = new HubError(
    403,
    'workflow wfOld is done — a non-running instance is not servable',
    'forbidden',
  );
  const { hub, calls } = mockHub({
    wake: [
      { changed: true, cursor: 1 },
      { changed: false, cursor: 1 },
    ],
    inbox: ['wfOld'],
    perWfThrows: { wfOld: terminal },
  });
  const { spawner } = fakeSpawner();
  const out: string[] = [];
  const err: string[] = [];
  const holder: { loop?: ShiftLoop } = {};
  let sleeps = 0;
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    sleep: async () => {
      sleeps++;
      if (sleeps >= 2) holder.loop!.stop();
    },
  }));
  holder.loop = loop;

  await loop.run();
  assert.equal(
    calls.filter((call) => call.verb === 'whats_next' && (call.arg as { workflow?: string } | undefined)?.workflow === 'wfOld').length,
    1,
  );
  assert.match(out.join('\n'), /skipped stale terminal inbox candidate/);
  assert.doesNotMatch(err.join('\n'), /whats_next for wfOld failed/);
});

// ---- command routing at the loop level --------------------------------------

async function withCommandStep(routing: 'shift' | 'manual' | undefined) {
  cacheCommandBundle();
  const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [wo('run_cmd', 'cmd')] } } });
  const { spawner, spawns } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1', ...(routing !== undefined ? { commandRouting: routing } : {}) })).run();
  return { calls, spawns };
}

test('a manual-routed command order gets no spawn (left for pickup)', async () => {
  const { spawns } = await withCommandStep('manual');
  assert.equal(spawns.length, 0);
});

test('a shift-routed command order dispatches', async () => {
  const { spawns } = await withCommandStep('shift');
  assert.deepEqual(spawns.map((s) => s.run), ['run_cmd']);
});

// ---- authoritative modern wire routing --------------------------------------

test('wire command routing wins when the definition-name cache says agent', async () => {
  cacheBuilderStep();
  const order = modernWo('run_wire_command', 'builder', 'command');
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [order] } } });
  const { spawner, spawns } = fakeSpawner();

  await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    workflow: 'wf1',
    resolveOrderStep: async () => ({ name: 'builder', executor: 'command' }),
  })).run();

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.kind, undefined, 'wire command selects the exec lane');
});

test('wire agent routing wins when the definition-name cache says command', async () => {
  cacheCommandBundle();
  const order = modernWo('run_wire_agent', 'cmd', 'agent');
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [order] } } });
  const { spawner, spawns } = fakeSpawner();
  let exactCommandLookups = 0;

  await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    workflow: 'wf1',
    resolveOrderStep: async () => {
      exactCommandLookups++;
      return { name: 'cmd', executor: 'command' };
    },
  })).run();

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.kind, 'agent-run');
  assert.equal(exactCommandLookups, 0, 'agent lane leaves exact instruction lookup to agent-run');
});

test('modern command routing comes from the exact order digest, not the latest cache', async () => {
  cacheCommandBundle();
  const order = modernWo('run_exact_manual', 'cmd', 'command', 'sha256:older-manual');
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [order] } } });
  const { spawner, spawns } = fakeSpawner();

  await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    workflow: 'wf1',
    commandRouting: 'shift',
    resolveOrderStep: async (received) => {
      assert.equal(received.defDigest, 'sha256:older-manual');
      return { name: 'cmd', executor: 'command', x: { owenloop: { routing: 'manual' } } };
    },
  })).run();

  assert.equal(spawns.length, 0, 'exact digest manual routing fails closed despite cache metadata');
});

test('modern command order fails closed when exact digest metadata is unavailable', async () => {
  const errors: string[] = [];
  const order = modernWo('run_missing_digest', 'cmd', 'command', 'sha256:missing');
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [order] } } });
  const { spawner, spawns } = fakeSpawner();

  await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    workflow: 'wf1',
    resolveOrderStep: async () => undefined,
    err: (line) => errors.push(line),
  })).run();

  assert.equal(spawns.length, 0);
  assert.match(errors.join('\n'), /exact command routing metadata.*sha256:missing.*unavailable/u);
});

test('modern command dispatches when its exact resolver recovers the missing bundle', async () => {
  const order = modernWo('run_recovered_digest', 'cmd', 'command', 'sha256:recovered');
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [order] } } });
  const { spawner, spawns } = fakeSpawner();
  let recoveryResolutions = 0;

  await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    workflow: 'wf1',
    resolveOrderStep: async (received) => {
      recoveryResolutions++;
      assert.equal(received.defDigest, 'sha256:recovered');
      // The injected resolver is the shift runtime's production store source;
      // resolving here represents its one-shot fetch/install/re-prime recovery.
      return { name: 'cmd', executor: 'command' };
    },
  })).run();

  assert.equal(recoveryResolutions, 1);
  assert.deepEqual(spawns.map((spawned) => spawned.run), ['run_recovered_digest']);
});

test('modern command verification recovery failure drops the claim without spawning or releasing it', async () => {
  const order = modernWo('run_verification_failed', 'cmd', 'command', 'sha256:untrusted');
  const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [order] } } });
  const { spawner, spawns } = fakeSpawner();
  const events: Array<{ type: string; reason?: string; run?: string; message?: string }> = [];

  await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    workflow: 'wf1',
    resolveOrderStep: async () => { throw new Error('publication signature is invalid'); },
    onEvent: (event) => events.push(event),
  })).run();

  assert.equal(spawns.length, 0);
  assert.equal(count(calls, 'release'), 0, 'verification failures remain available for manual pickup');
  assert.equal(
    events.some((event) =>
      event.type === 'order-dropped' &&
      event.run === 'run_verification_failed' &&
      event.reason === 'verification-failed' &&
      /signature is invalid/u.test(event.message ?? '')),
    true,
  );
});

test('modern agent order never passes a disagreeing cache harness', async () => {
  cacheBuilderWithHarness('cache-harness');
  const order = modernWo('run_modern_harness', 'builder', 'agent');
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [order] } } });
  const { spawner, spawns } = fakeSpawner();

  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1' })).run();

  assert.equal(spawns.length, 1);
  assert.equal('harness' in spawns[0]!, false);
});

test('the deployed default-agent projection dispatches exactly one modern agent-run without cache routing', async () => {
  // The real engine always projects defDigest, but omits worker when the authored
  // step has no explicit executor. A disagreeing latest-name cache must be inert.
  cacheCommandBundle();
  const projected = { ...wo('run_default_agent', 'cmd'), defDigest: 'sha256:projected-default-agent' };
  const errors: string[] = [];
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: { wf1: { def: 'demo', orders: [projected] } },
  });
  const { spawner, spawns } = fakeSpawner();
  let exactCommandLookups = 0;

  await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    workflow: 'wf1',
    resolveOrderStep: async () => {
      exactCommandLookups++;
      return { name: 'cmd', executor: 'command' };
    },
    err: (line) => errors.push(line),
  })).run();

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.workflow, 'wf1');
  assert.equal(spawns[0]!.run, 'run_default_agent');
  assert.equal(spawns[0]!.step, 'cmd');
  assert.equal(spawns[0]!.kind, 'agent-run');
  assert.equal(typeof spawns[0]!.startGate, 'string');
  assert.equal(exactCommandLookups, 0, 'default-agent routing stays in agent-run');
  assert.equal(errors.some((line) => /cached bundle|legacy orders/u.test(line)), false);
});

test('only orders with both modern fields absent use the legacy cache fallback; malformed boundaries fail closed', async () => {
  cacheCommandBundle();
  const malformed = [
    { ...wo('run_worker_only', 'cmd'), worker: 'command' },
    { ...wo('run_empty_digest', 'cmd'), defDigest: '' },
    { ...wo('run_invalid_digest', 'cmd'), defDigest: 42 },
    { ...wo('run_empty_worker', 'cmd'), defDigest: 'sha256:valid', worker: '' },
    { ...wo('run_invalid_worker', 'cmd'), defDigest: 'sha256:valid', worker: 42 },
    { ...wo('run_unknown_worker', 'cmd'), defDigest: 'sha256:valid', worker: 'future' },
  ] as unknown as WorkOrder[];
  const legacy = wo('run_legacy', 'cmd');
  const errors: string[] = [];
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: { wf1: { def: 'demo', orders: [...malformed, legacy] } },
  });
  const { spawner, spawns } = fakeSpawner();

  await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    workflow: 'wf1',
    err: (line) => errors.push(line),
  })).run();

  assert.deepEqual(spawns.map((spawned) => spawned.run), ['run_legacy']);
  assert.equal(errors.filter((line) => /malformed modern work order/u.test(line)).length, 5);
  assert.equal(errors.filter((line) => /unsupported worker 'future'/u.test(line)).length, 1);
});

// ---- agent lane: detached agent-run child ------------------------------------

test('a dispatched agent order spawns a detached agent-run child and records it', async () => {
  cacheBuilderStep();
  const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [wo('run_deadbeef', 'builder')] } } });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));
  const dispatched = await loop.iterate();

  assert.equal(dispatched, 1);
  // ONE spawn, and it is the agent-run kind — no lean order, no handout.
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.kind, 'agent-run');
  assert.equal(spawns[0]!.workflow, 'wf1');
  assert.equal(spawns[0]!.run, 'run_deadbeef');
  assert.equal(count(calls, 'get_order'), 0); // still no first-contact get_order
  // An in-flight record was written with the runner kind and the child's real pid.
  const recs = readChildRecords(stateDir);
  assert.equal(recs.length, 1);
  assert.equal(recs[0]!.kind, 'agent-run');
  assert.notEqual(recs[0]!.pid, 0);
  assert.equal(recs[0]!.step, 'builder');
  assert.equal(recs[0]!.def, 'demo');
  assert.equal(recs[0]!.hash, DEMO_HASH);
});

test('a prepared-cache harness never becomes agent-run spawn metadata', async () => {
  cacheBuilderWithHarness('cached-harness');
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [wo('run_deadbeef', 'builder')] } } });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));
  await loop.iterate();

  assert.equal(spawns[0]?.workflow, 'wf1');
  assert.equal(spawns[0]?.run, 'run_deadbeef');
  assert.equal(spawns[0]?.kind, 'agent-run');
  assert.equal('harness' in spawns[0]!, false, 'agent-run resolves the verified order-pinned harness');
});

test('a step naming no harness also leaves agent-run resolution to the child', async () => {
  cacheBuilderWithHarness();
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [wo('run_deadbeef', 'builder')] } } });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));
  await loop.iterate();

  assert.equal(spawns[0]?.workflow, 'wf1');
  assert.equal(spawns[0]?.run, 'run_deadbeef');
  assert.equal(spawns[0]?.kind, 'agent-run');
  assert.equal('harness' in spawns[0]!, false, 'agent-run resolves the verified order-pinned harness');
});

test('a missing bundle leaves an agent order for pickup with a warning — no spawn', async () => {
  const errs: string[] = [];
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [wo('run_deadbeef', 'builder')] } } });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1', err: (l) => errs.push(l) }));
  const dispatched = await loop.iterate();
  assert.equal(dispatched, 0);
  assert.equal(spawns.length, 0);
  assert.ok(errs.some((e) => /no cached bundle/.test(e)));
});

test('an order a LIVE agent-run child already holds is never re-dispatched', async () => {
  cacheBuilderStep();
  // The run already has a live agent-run child. The hub may still offer the
  // order (its lease has not lapsed hub-side yet); re-spawning would double-brief
  // one claim, so the sweep must skip it.
  writeChildRecord(stateDir, { workflow: 'wf1', run: 'run_deadbeef', pid: 4242, spawnedAt: 0, kind: 'agent-run', def: 'demo', hash: DEMO_HASH, step: 'builder' });
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [wo('run_deadbeef', 'builder')] } } });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1', cap: 2 }));
  const dispatched = await loop.iterate();
  assert.equal(dispatched, 0);
  assert.equal(spawns.length, 0);
  assert.equal(readChildRecords(stateDir).length, 1); // the pre-existing record, untouched
});

// ---- legacy pinned-hash dispatch (E, DD-4) ----------------------------------
//
// The explicitly legacy order shape omits worker and defDigest, so Shift has only
// the response's def NAME. That compatibility path uses readDispatchBundle: a
// unique pinned hash wins over latest; conflicting pins refuse dispatch.

const CHILD_H1 = 'aaaa1111bbbb2222'; // the version a parent pins (older fetchedAt)
const CHILD_H2 = 'cccc3333dddd4444'; // a newer, UNPINNED cached hash of the same name
const tpl = (marker: string): NormalizedStepSpec => ({ step: 'builder', brief: `${marker} ${ORDER_TOKEN}\n`, permissions: { extensions: {} } });

/** Parent (pinning child@CHILD_H1) + child@h1 (pinned) + child@h2 (newer, unpinned). */
function cachePinnedChild(): void {
  writeBundle(
    cacheDir,
    { def: { name: 'parent', hash: 'ph1', steps: [{ name: 'sub', calls: 'child' }], pins: [{ call: 'sub', name: 'child', version: 1, hash: CHILD_H1 }] }, fetchedAt: Date.now(), origin: 'x' },
    [],
  );
  writeBundle(cacheDir, { def: { name: 'child', hash: CHILD_H1, steps: [{ name: 'builder', body: '' }] }, fetchedAt: 1000, origin: 'x' }, [tpl('H1TEMPLATE')]);
  writeBundle(cacheDir, { def: { name: 'child', hash: CHILD_H2, steps: [{ name: 'builder', body: '' }] }, fetchedAt: 9000, origin: 'x' }, [tpl('H2TEMPLATE')]);
}

test('a sweep serving def=child dispatches the PINNED hash, not the newer unpinned latest', async () => {
  cachePinnedChild();
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'child', orders: [wo('run_deadbeef', 'builder')] } } });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));
  const dispatched = await loop.iterate();

  assert.equal(dispatched, 1);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.kind, 'agent-run');
  // The legacy in-flight record preserves the selected pinned hash for
  // compatibility diagnostics. Modern agent-run instruction selection uses the
  // authoritative order digest instead of this cache-derived record field.
  const recs = readChildRecords(stateDir);
  assert.equal(recs.length, 1);
  assert.equal(recs[0]!.hash, CHILD_H1);
  assert.notEqual(recs[0]!.hash, CHILD_H2);
  // The pinned bundle really is the one carrying H1's brief.
  const spec = readStepSpec(cacheDir, 'child', CHILD_H1, 'builder');
  assert.ok(spec !== null);
  assert.match(spec.brief, /H1TEMPLATE/);
  assert.doesNotMatch(spec.brief, /H2TEMPLATE/);
});

test('conflicting pins for def=child ⇒ no dispatch, a warning, orders left for pickup', async () => {
  // Two cached parents pin DIFFERENT hashes of the same child name (legal across
  // parents; the hub only forbids it inside one parent's tree).
  writeBundle(cacheDir, { def: { name: 'parentA', hash: 'pa1', steps: [{ name: 'sub', calls: 'child' }], pins: [{ call: 'sub', name: 'child', version: 1, hash: CHILD_H1 }] }, fetchedAt: 0, origin: 'x' }, []);
  writeBundle(cacheDir, { def: { name: 'parentB', hash: 'pb1', steps: [{ name: 'sub', calls: 'child' }], pins: [{ call: 'sub', name: 'child', version: 2, hash: CHILD_H2 }] }, fetchedAt: 0, origin: 'x' }, []);
  writeBundle(cacheDir, { def: { name: 'child', hash: CHILD_H1, steps: [{ name: 'builder', body: '' }] }, fetchedAt: 1000, origin: 'x' }, [tpl('H1TEMPLATE')]);
  writeBundle(cacheDir, { def: { name: 'child', hash: CHILD_H2, steps: [{ name: 'builder', body: '' }] }, fetchedAt: 9000, origin: 'x' }, [tpl('H2TEMPLATE')]);

  const errs: string[] = [];
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'child', orders: [wo('run_deadbeef', 'builder')] } } });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1', err: (l) => errs.push(l) }));
  const dispatched = await loop.iterate();

  assert.equal(dispatched, 0); // refused — no version guessed
  assert.equal(spawns.length, 0);
  assert.equal(readChildRecords(stateDir).length, 0);
  assert.ok(errs.some((e) => /pinned to 2 distinct hashes/.test(e)), errs.join(' | '));
});

// ---- shutdown ---------------------------------------------------------------

test('stop() before run ⇒ run resolves 0 with zero hub calls', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));
  loop.stop();
  const code = await loop.run();
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
});

test('stop() during the park ⇒ run resolves 0 and makes no further hub call', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
  const { spawner } = fakeSpawner();
  const h: { loop?: ShiftLoop } = {};
  const sleep = async (): Promise<void> => {
    h.loop!.stop(); // stop while parked, after the first iteration
  };
  const loop = createShiftLoop(baseOpts(hub, spawner, { sleep, workflow: 'wf1' }));
  h.loop = loop;
  const code = await loop.run();
  assert.equal(code, 0);
  assert.equal(count(calls, 'wake'), 1); // exactly one iteration, no calls after stop
});

// ---- dispatch-cap surface (MCP set_dispatch_cap) ----------------------------

test('getCap/setCap/freeCapacity expose the live cap', async () => {
  const { hub } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1', cap: 3 }));
  assert.equal(loop.getCap(), 3);
  assert.equal(loop.freeCapacity(), 3);
  loop.setCap(5);
  assert.equal(loop.getCap(), 5);
  assert.equal(loop.freeCapacity(), 5);
});

// ---- shift identity surface (MCP clock_in, shifts.md §8 item 4) ------------

test('setShift updates the live name, crews, and serving set on the next presence ping', async () => {
	const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
	const { spawner } = fakeSpawner();
	const loop = createShiftLoop(baseOpts(hub, spawner, {
		workflow: 'wf1',
		computeServeCapabilities: (crews) => crews.length === 0 ? ['all'] : [`for-${crews[0]!}`],
	}));
	await loop.iterate(); // first iterate always pings (lastPresence starts at -Infinity)
	loop.setShift({ name: 'shiftB', serveCrews: ['project-bar'] });
	await loop.iterate(); // setShift reset the presence timer, so this pings again immediately
	const pings = calls.filter((c) => c.verb === 'presence');
	assert.equal(pings.length, 2);
	assert.deepEqual(pings[1]!.arg, {
		name: 'shiftB',
		serve_crews: ['project-bar'],
		serve_capabilities: ['for-project-bar'],
	});
	assert.deepEqual(loop.getServeCapabilities(), ['for-project-bar']);
});

test('after setShift({serveCrews}), the per-instance whats_next carries the new serveCrews', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 1 }, { changed: true, cursor: 2 }] });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));
  await loop.iterate(); // first sweep uses the initial serveCrews ([])
  loop.setShift({ serveCrews: ['project-bar'] });
  await loop.iterate();
  const wn = calls.filter((c) => c.verb === 'whats_next');
  assert.deepEqual(wn[wn.length - 1]!.arg, { workflow: 'wf1', serve_crews: ['project-bar'], serve_capabilities: [] });
});

test('setShift recomputes the serving set immediately and logs only the change', () => {
  const { hub } = mockHub({});
  const { spawner } = fakeSpawner();
  const output: string[] = [];
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    computeServeCapabilities: (crews) => crews.length === 0 ? ['all'] : [`for-${crews[0]!}`],
    out: (line) => output.push(line),
  }));

  assert.deepEqual(loop.getServeCapabilities(), ['all']);
  loop.setShift({ serveCrews: ['project-bar'] });
  assert.deepEqual(loop.getServeCapabilities(), ['for-project-bar']);
  assert.deepEqual(output, ['serving for-project-bar']);
});

test('roster refresh recomputes the serving set before the next hub requests', async () => {
	const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 0 }], perWf: { wf1: { orders: [] } } });
	const { spawner } = fakeSpawner();
	let monotonic = 0;
	let revision = 'before';
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    monotonicNow: () => monotonic,
    presenceIntervalMs: 60_000,
    rosterSyncIntervalMs: 10,
    computeServeCapabilities: () => [revision],
    syncRosters: async () => { revision = 'after'; },
  }));

	assert.deepEqual(loop.getServeCapabilities(), ['before']);
	monotonic = 10;
	await loop.iterate();
	assert.deepEqual(loop.getServeCapabilities(), ['after']);
	assert.deepEqual(calls.find((call) => call.verb === 'presence')?.arg, {
		name: 'box',
		serve_crews: [],
		serve_capabilities: ['after'],
	});
	assert.deepEqual(perWfWhatsNext(calls), {
		workflow: 'wf1',
		serve_crews: [],
		serve_capabilities: ['after'],
	});
});

test('setShift is a partial update: an omitted field leaves that part of the shift unchanged (via getShift() and the next ping)', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1', serveCrews: ['x'] }));
  loop.setShift({ serveCrews: ['y'] });
  assert.deepEqual(loop.getShift(), { name: 'box', serveCrews: ['y'] }); // name untouched by a scope-only call
  loop.setShift({ name: 'z' });
  assert.deepEqual(loop.getShift(), { name: 'z', serveCrews: ['y'] }); // scope untouched by a name-only call

  await loop.iterate();
  const pings = calls.filter((c) => c.verb === 'presence');
  assert.deepEqual(pings[0]!.arg, { name: 'z', serve_crews: ['y'], serve_capabilities: [] });
});

test('setShift makes the next presence ping due immediately, even mid-cadence (control: a plain tick does not ping early)', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
  const { spawner } = fakeSpawner();
  let t = 0;
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    now: () => t,
    monotonicNow: () => t,
    presenceIntervalMs: 60_000,
  }));
  await loop.iterate(); // t=0: first iterate always pings
  t = 10_000; // well short of the 60s cadence
  await loop.iterate(); // control: no ping yet — cadence has not elapsed
  assert.equal(calls.filter((c) => c.verb === 'presence').length, 1);

  loop.setShift({ name: 'shiftC' });
  await loop.iterate(); // setShift forces presence due NOW, despite t still < 60s since the last real ping
  const pings = calls.filter((c) => c.verb === 'presence');
  assert.equal(pings.length, 2, 'the setShift-triggered ping fired even though the cadence had not elapsed');
  assert.equal((pings[1]!.arg as { name?: string } | undefined)?.name, 'shiftC');
});

// D3: [] is SENT, never omitted — the hub reads an omitted serve_crews as
// "unchanged from the previous ping" in general wire semantics, but a ping is
// full-current-truth, so [] must appear on the wire to mean "all crews".
test('setShift({serveCrews: []}) sends serve_crews: [] on the wire, not omitted', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1', serveCrews: ['only-one'] }));
  loop.setShift({ serveCrews: [] });
  await loop.iterate();
  const pings = calls.filter((c) => c.verb === 'presence');
  assert.deepEqual(pings[0]!.arg, { name: 'box', serve_crews: [], serve_capabilities: [] });
});

// ---- spawn seam -------------------------------------------------------------

test('buildSpawnPlan produces the detached `exec <workflow>/<run> --origin` argv shape as pure data', () => {
  const plan = buildSpawnPlan({ workflow: 'wf1', run: 'run_zzzz' }, 'https://hub.example', 'ci', '/pkg/bin/owenloop.mjs', '/usr/bin/node');
  assert.equal(plan.command, '/usr/bin/node');
  // Account rides the spawn ENV (OWENLOOP_ACCOUNT), NOT the argv — exec has no --as flag.
  assert.deepEqual(plan.args, ['/pkg/bin/owenloop.mjs', 'work', 'exec', 'wf1/run_zzzz', '--origin', 'https://hub.example']);
  assert.equal(plan.options.detached, true);
  assert.deepEqual(plan.options.stdio, ['ignore', 'ignore', 'ignore']);
  assert.equal(plan.options.env['OWENLOOP_ACCOUNT'], 'ci');
  // Inherited parent env survives (env starts from process.env, then stamps the account).
  assert.equal(plan.options.env['PATH'], process.env['PATH']);
});

// W7: the dispatching Shift's id, when supplied, rides as a trailing
// `--shift <cid>` flag — after execPath so pre-W7 positional callers
// (the test above) are unaffected.
test('buildSpawnPlan appends --shift <cid> when a shiftId is supplied', () => {
  const plan = buildSpawnPlan(
    { workflow: 'wf1', run: 'run_zzzz' },
    'https://hub.example',
    'ci',
    '/pkg/bin/owenloop.mjs',
    '/usr/bin/node',
    'shf_abc123',
  );
  assert.deepEqual(plan.args, ['/pkg/bin/owenloop.mjs', 'work', 'exec', 'wf1/run_zzzz', '--origin', 'https://hub.example', '--shift', 'shf_abc123']);
});

// An empty shiftId (the "unresolved" state, per resolveShiftId) degrades
// safely to no flag at all — never `--shift ''`.
test('buildSpawnPlan omits --shift entirely when shiftId is empty or absent', () => {
  const withUndefined = buildSpawnPlan({ workflow: 'wf1', run: 'run_zzzz' }, 'https://hub.example', 'ci', '/pkg/bin/owenloop.mjs', '/usr/bin/node');
  assert.deepEqual(withUndefined.args, ['/pkg/bin/owenloop.mjs', 'work', 'exec', 'wf1/run_zzzz', '--origin', 'https://hub.example']);
  const withEmpty = buildSpawnPlan({ workflow: 'wf1', run: 'run_zzzz' }, 'https://hub.example', 'ci', '/pkg/bin/owenloop.mjs', '/usr/bin/node', '');
  assert.deepEqual(withEmpty.args, ['/pkg/bin/owenloop.mjs', 'work', 'exec', 'wf1/run_zzzz', '--origin', 'https://hub.example']);
});

// Phase 3 / D6: the SAME seam builds the runner-dispatch argv. `kind` selects
// the role positional; everything else is byte-identical to the exec plan, so a
// runner child is detached, stdio-ignored and account-stamped the same way.
test('buildSpawnPlan: kind agent-run swaps the role positional and keeps every other field', () => {
  const plan = buildSpawnPlan(
    { workflow: 'wf1', run: 'run_zzzz', kind: 'agent-run' },
    'https://hub.example',
    'ci',
    '/pkg/bin/owenloop.mjs',
    '/usr/bin/node',
  );
  assert.deepEqual(plan.args, ['/pkg/bin/owenloop.mjs', 'work', 'agent-run', 'wf1/run_zzzz', '--origin', 'https://hub.example']);
  assert.equal(plan.options.detached, true);
  assert.deepEqual(plan.options.stdio, ['ignore', 'ignore', 'ignore']);
  assert.equal(plan.options.env['OWENLOOP_ACCOUNT'], 'ci');
});

test('buildSpawnPlan: agent-run carries --shift but never manufactures a --harness override', () => {
  const plan = buildSpawnPlan(
    { workflow: 'wf1', run: 'run_zzzz', kind: 'agent-run' },
    'https://hub.example',
    'ci',
    '/pkg/bin/owenloop.mjs',
    '/usr/bin/node',
    'shf_abc123',
  );
  assert.deepEqual(plan.args, [
    '/pkg/bin/owenloop.mjs',
    'work', 'agent-run',
    'wf1/run_zzzz',
    '--origin',
    'https://hub.example',
    '--shift',
    'shf_abc123',
  ]);
  assert.equal(plan.args.includes('--harness'), false);
});

test('buildSpawnPlan carries the live shift ownership name in the agent child environment', () => {
  const plan = buildSpawnPlan(
    {
      workflow: 'wf1',
      run: 'run_zzzz',
      kind: 'agent-run',
      shiftName: 'shift-A',
      shiftOwner: '/state/shift-a',
    },
    'https://hub.example',
    'ci',
    '/pkg/bin/owenloop.mjs',
    '/usr/bin/node',
  );

  assert.equal(plan.options.env['OWENLOOP_SHIFT_NAME'], 'shift-A');
  assert.equal(plan.options.env['OWENLOOP_SHIFT_OWNER'], '/state/shift-a');
});

test('createDefaultSpawner reports a nonzero detached worker exit with generic lifecycle metadata', async () => {
  const script = join(stateDir, '..', 'exit-seven.mjs');
  writeFileSync(script, 'process.exit(7);\n');
  // Production Shift has a listening daemon and poll loop keeping its event
  // loop alive. Model that here because the detached child is deliberately
  // unref'd; Node 22 may otherwise let the isolated test process drain before
  // delivering the child's `exit` event.
  const keepAlive = setTimeout(() => {}, 5_000);
  const exits: WorkerExit[] = [];
  const failure = new Promise<Parameters<NonNullable<Parameters<typeof createDefaultSpawner>[4]>>[0]>((resolve) => {
    const spawner = createDefaultSpawner(
      ORIGIN,
      'default',
      script,
      'shf_test',
      resolve,
      undefined,
      undefined,
      (exit) => exits.push(exit),
    );
    spawner({ workflow: 'wf1', run: 'run_failed', step: 'builder', kind: 'agent-run' });
  });

  try {
    assert.deepEqual(await failure, {
      workflow: 'wf1',
      run: 'run_failed',
      step: 'builder',
      kind: 'agent-run',
      executable: `${process.execPath} ${script}`,
      exitStatus: 7,
      signal: null,
      message: 'worker exited without completing successfully',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(exits.length, 1, 'the independent exit latch emits once even for a nonzero exit');
    assert.equal(exits[0]!.exitStatus, 7);
    assert.equal(exits[0]!.signal, null);
    assert.ok(exits[0]!.pid > 0);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('createDefaultSpawner reports a clean agent-run exit without a worker failure', async () => {
  const script = join(stateDir, '..', 'exit-zero.mjs');
  writeFileSync(script, 'process.exit(0);\n');
  const keepAlive = setTimeout(() => {}, 5_000);
  const failures: unknown[] = [];
  const exits: WorkerExit[] = [];
  const exit = new Promise<WorkerExit>((resolve) => {
    const spawner = createDefaultSpawner(
      ORIGIN,
      'default',
      script,
      'shf_test',
      (failure) => failures.push(failure),
      undefined,
      undefined,
      (reported) => {
	exits.push(reported);
	resolve(reported);
      },
    );
    spawner({ workflow: 'wf1', run: 'run_completed', step: 'builder', kind: 'agent-run' });
  });

  try {
    assert.equal(exitCodeFor('submitted'), 0, 'a mid-turn completion takes this clean-exit path');
    const reported = await exit;
    assert.equal(reported.workflow, 'wf1');
    assert.equal(reported.run, 'run_completed');
    assert.equal(reported.kind, 'agent-run');
    assert.equal(reported.exitStatus, 0);
    assert.equal(reported.signal, null);
    assert.ok(reported.pid > 0);
    assert.deepEqual(failures, []);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(exits.length, 1, 'a clean exit is reported exactly once');
  } finally {
    clearTimeout(keepAlive);
  }
});

test('createDefaultSpawner never lets allowlisted-looking agent progress reach a failure event', async () => {
  const script = join(stateDir, '..', 'refuse.mjs');
  writeFileSync(
    script,
    "process.stderr.write(\"owenloop work agent-run: consumed artifact refusal (signature) model progress contains token=very-secret-value and a private prompt\\n\");\n" +
      'process.exit(1);\n',
  );
  const keepAlive = setTimeout(() => {}, 5_000);
  const failure = new Promise<Parameters<NonNullable<Parameters<typeof createDefaultSpawner>[4]>>[0]>((resolve) => {
    const spawner = createDefaultSpawner(ORIGIN, 'default', script, 'shf_test', resolve);
    spawner({ workflow: 'delivery', run: 'run_1', step: 'builder', kind: 'agent-run' });
  });

  try {
    const reported = await failure;
    assert.equal(reported.message, 'worker exited without completing successfully');
    assert.equal(JSON.stringify(reported).includes('very-secret-value'), false);
    assert.equal(JSON.stringify(reported).includes('private prompt'), false);
    assert.equal(JSON.stringify(reported).includes('consumed artifact refusal'), false);
  } finally {
    clearTimeout(keepAlive);
  }
});

// REGRESSION: a synchronous spawn failure yields no pid AND makes Node emit
// `error` on a later tick (verified on node v22: `pid` undefined, events
// `error` then `close`, no `exit`). In production the trigger is resource
// exhaustion in the Shift (EMFILE/ENOMEM), because the spawned command is
// always `process.execPath`; an unresolvable `execPath` reproduces the same
// code path here. The `pid === undefined` throw is the caller's single signal —
// `createShiftLoop.dispatchCandidate` converts it into one `failed` event — so
// the deferred `error` handler must NOT also report, or one dispatch attempt
// produces two daemon `failed` events.
test('a spawn that returns no pid throws once and never also reports a duplicate worker failure', async () => {
  const realExecPath = process.execPath;
  const failures: unknown[] = [];
  const keepAlive = setTimeout(() => {}, 400);
  try {
    Object.defineProperty(process, 'execPath', { value: '/nonexistent/owenloop-node', configurable: true, writable: true });
    const spawner = createDefaultSpawner(ORIGIN, 'default', '/pkg/bin/owenloop.mjs', 'shf_test', (failure) => failures.push(failure));
    assert.throws(
      () => spawner({ workflow: 'wf1', run: 'run_nopid', step: 'cmd' }),
      /returned no pid/u,
    );
  } finally {
    Object.defineProperty(process, 'execPath', { value: realExecPath, configurable: true, writable: true });
  }

  // Let the deferred `error` event land before asserting; that event is what
  // used to produce the second report.
  await new Promise((resolve) => setTimeout(resolve, 200));
  clearTimeout(keepAlive);
  assert.deepEqual(failures, [], 'the throw is the single report path for a spawn that yields no pid');
});

// REGRESSION: both detached worker roles share one stdio topology. The real
// parent process exits before either worker writes to stderr. A parent-owned pipe
// would close its read end at that point; the later write would raise EPIPE and
// terminate the worker before the completion marker.
test('detached exec and agent-run workers survive late stderr writes after Shift exits', async () => {
  const markerDir = join(stateDir, '..', 'detached-markers');
  mkdirSync(markerDir);
  const parentFixture = fileURLToPath(new URL('./fixtures/detached-worker-parent.ts', import.meta.url));
  const workerFixture = fileURLToPath(new URL('./fixtures/detached-worker-child.mjs', import.meta.url));
  const parent = spawn(process.execPath, [parentFixture, workerFixture], {
    env: { ...process.env, DETACHED_MARKER_DIR: markerDir },
    stdio: 'ignore',
  });

  const [code, signal] = await once(parent, 'exit') as [number | null, NodeJS.Signals | null];
  assert.equal(code, 0);
  assert.equal(signal, null);

  const deadline = Date.now() + 5_000;
  const markers = ['exec.done', 'agent-run.done'];
  // A marker's directory entry can become visible before its synchronous write
  // has emitted every byte, so wait for the completion contract itself.
  const completed = (name: string): boolean => {
    try {
      return readFileSync(join(markerDir, name), 'utf8') === 'completed\n';
    } catch {
      return false;
    }
  };
  while (!markers.every(completed) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const marker of markers) {
    assert.equal(readFileSync(join(markerDir, marker), 'utf8'), 'completed\n', `${marker} proves the worker survived stderr`);
  }
});

test('a dispatched command order writes an exec child record carrying the returned pid', async () => {
  cacheCommandBundle();
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: cmdWf([wo('run_rec', 'cmd')]) });
  const { spawner } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1' })).run();
  const recFile = join(stateDir, 'run_rec.json');
  assert.equal(existsSync(recFile), true);
  const rec = JSON.parse(readFileSync(recFile, 'utf8')) as { run: string; pid: number; kind?: string };
  assert.equal(rec.run, 'run_rec');
  assert.equal(rec.pid, 1000);
  assert.equal(rec.kind, 'exec');
});

// ---- end-of-run slot release ------------------------------------------------

test('noteRunEnded frees the dispatch slot immediately (closed-submit end-of-run signal)', async () => {
  cacheBuilderStep();
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }, { changed: false, cursor: 1 }],
    perWf: { wf1: { def: 'demo', orders: [wo('run_x1234', 'builder')] } },
  });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));

  // Dispatch consumes a slot.
  assert.equal(await loop.iterate(), 1);
  assert.equal(loop.freeCapacity(), 2);

  // The shift's submit tool saw closed:true → the run-ended signal: the slot
  // frees NOW, without waiting for the child's pid probe to go stale.
  loop.noteRunEnded('run_x1234');
  assert.equal(loop.freeCapacity(), 3, 'the dispatch slot freed immediately');
  assert.equal(readChildRecords(stateDir).length, 0, 'the in-flight record is gone');
});

test('a mid-turn completion releases capacity even when the pid probe stays alive', async () => {
  cacheBuilderStep();
  const orders = [wo('run_mid_turn', 'builder')];
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }, { changed: true, cursor: 2 }],
    perWf: agentWf(orders),
  });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 1,
    maxConcurrentAgents: 1,
  }));

  assert.equal(await loop.iterate(), 1);
  assert.equal(loop.freeCapacity(), 0);
  const record = readChildRecords(stateDir)[0]!;

  loop.noteChildExited({
    workflow: 'wf1',
    run: record.run,
    kind: 'agent-run',
    pid: record.pid,
  });
  loop.noteChildExited({
    workflow: 'wf1',
    run: record.run,
    kind: 'agent-run',
    pid: record.pid,
  });
  assert.equal(loop.freeCapacity(), 1);
  assert.equal(readChildRecords(stateDir).length, 0);

  orders[0] = wo('run_mid_turn_next', 'builder');
  assert.equal(await loop.iterate(), 1, 'the shift accepts a new order after the clean child exit');
  assert.deepEqual(spawns.map((spec) => spec.run), ['run_mid_turn', 'run_mid_turn_next']);
});

test('a stale child exit report cannot free a later dispatch of the same run', async () => {
  cacheBuilderStep();
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_reoffered', 'builder')]),
  });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 1,
    maxConcurrentAgents: 1,
  }));

  await loop.iterate();
  const first = readChildRecords(stateDir)[0]!;
  writeChildRecord(stateDir, { ...first, pid: first.pid + 1 });

  loop.noteChildExited({ workflow: 'wf1', run: first.run, kind: 'agent-run', pid: first.pid });
  assert.deepEqual(readChildRecords(stateDir).map((record) => record.pid), [first.pid + 1]);
  assert.equal(loop.freeCapacity(), 0, 'the later child still owns the only slot');
});

test('two shared-state loops keep a replacement reservation when a stale reaper races it', () => {
  const now = 120_001;
  const stale = reserveChild(stateDir, {
    workflow: 'wf1',
    run: 'run_reservation_reaper_race',
    reservedAt: 0,
    childKind: 'agent-run',
    step: 'builder',
  });
  const { hub: firstHub } = mockHub({ wake: [{ changed: false, cursor: 1 }] });
  const { hub: secondHub } = mockHub({ wake: [{ changed: false, cursor: 1 }] });
  const { spawner } = fakeSpawner();
  const firstErrors: string[] = [];
  let replacement: ReturnType<typeof reserveChild> | undefined;
  let injected = false;
  const second = createShiftLoop(baseOpts(secondHub, spawner, {
    workflow: 'wf1',
    cap: 1,
    now: () => now,
  }));
  const first = createShiftLoop(baseOpts(firstHub, spawner, {
    workflow: 'wf1',
    cap: 1,
    now: () => now,
    err: (line) => firstErrors.push(line),
    dispatchLockOptions: {
	beforeOpen: () => {
	  if (injected) return;
	  injected = true;
	  assert.equal(second.freeCapacity(), 1, 'the other Shift removed the stale reservation first');
	  replacement = reserveChild(stateDir, {
	    workflow: 'wf1',
	    run: stale.reservation.run,
	    reservedAt: now,
	    childKind: 'agent-run',
	    step: 'builder',
	  });
	},
    },
  }));

  first.freeCapacity();

  assert.deepEqual(readChildReservations(stateDir), [replacement!.reservation]);
  assert.equal(existsSync(replacement!.gatePath), true, 'the replacement gate survives the stale reaper');
  assert.equal(second.freeCapacity(), 0, 'the replacement reservation retains the only capacity slot');
  assert.deepEqual(firstErrors, [], 'the stale observer did not report an abandonment it did not remove');
});

test('two shared-state loops keep a finalized replacement when a stale reservation reaper races it', () => {
  const now = 120_001;
  const replacementPid = 222;
  const stale = reserveChild(stateDir, {
    workflow: 'wf1',
    run: 'run_finalized_reservation_reaper_race',
    reservedAt: 0,
    childKind: 'agent-run',
    step: 'builder',
  });
  const { hub: firstHub } = mockHub({ wake: [{ changed: false, cursor: 1 }] });
  const { hub: secondHub } = mockHub({ wake: [{ changed: false, cursor: 1 }] });
  const { spawner } = fakeSpawner();
  const firstErrors: string[] = [];
  let replacementGate = '';
  let injected = false;
  const second = createShiftLoop(baseOpts(secondHub, spawner, {
    workflow: 'wf1',
    cap: 1,
    now: () => now,
    isAlive: (pid) => pid === replacementPid,
  }));
  const first = createShiftLoop(baseOpts(firstHub, spawner, {
    workflow: 'wf1',
    cap: 1,
    now: () => now,
    isAlive: (pid) => pid === replacementPid,
    err: (line) => firstErrors.push(line),
    dispatchLockOptions: {
	beforeOpen: () => {
	  if (injected) return;
	  injected = true;
	  assert.equal(second.freeCapacity(), 1, 'the other Shift removed the stale reservation first');
	  const replacement = reserveChild(stateDir, {
	    workflow: 'wf1',
	    run: stale.reservation.run,
	    reservedAt: now,
	    childKind: 'agent-run',
	    step: 'builder',
	  });
	  const child = finalizeChildReservation(stateDir, replacement.reservation, {
	    pid: replacementPid,
	    spawnedAt: now,
	    kind: 'agent-run',
	    step: 'builder',
	  });
	  startReservedChild(stateDir, child);
	  replacementGate = replacement.gatePath;
	},
    },
  }));

  first.freeCapacity();

  assert.deepEqual(readChildRecords(stateDir).map((record) => record.pid), [replacementPid]);
  assert.equal(existsSync(replacementGate), true, 'the replacement gate survives the stale reaper');
  assert.equal(second.freeCapacity(), 0, 'the finalized replacement retains the only capacity slot');
  assert.deepEqual(firstErrors, [], 'the stale observer did not report an abandonment it did not remove');
});

test('a stale live gate settler cannot overwrite a replacement reservation after child exit', () => {
  const firstPid = 111;
  const stale = reserveChild(stateDir, {
    workflow: 'wf1',
    run: 'run_live_gate_reservation_race',
    reservedAt: 0,
    childKind: 'agent-run',
    step: 'builder',
  });
  const firstChild = finalizeChildReservation(stateDir, stale.reservation, {
    pid: firstPid,
    spawnedAt: 0,
    kind: 'agent-run',
    step: 'builder',
  });
  const { hub: firstHub } = mockHub({ wake: [{ changed: false, cursor: 1 }] });
  const { hub: secondHub } = mockHub({ wake: [{ changed: false, cursor: 1 }] });
  const { spawner } = fakeSpawner();
  let replacement: ReturnType<typeof reserveChild> | undefined;
  let injected = false;
  const second = createShiftLoop(baseOpts(secondHub, spawner, {
    workflow: 'wf1',
    cap: 1,
    isAlive: (pid) => pid === firstPid,
  }));
  const first = createShiftLoop(baseOpts(firstHub, spawner, {
    workflow: 'wf1',
    cap: 1,
    isAlive: (pid) => pid === firstPid,
    dispatchLockOptions: {
	beforeOpen: () => {
	  if (injected) return;
	  injected = true;
	  second.noteChildExited({
	    workflow: firstChild.workflow,
	    run: firstChild.run,
	    kind: 'agent-run',
	    pid: firstChild.pid,
	  });
	  withDispatchLock(stateDir, {}, () => {
	    replacement = reserveChild(stateDir, {
	      workflow: 'wf1',
	      run: firstChild.run,
	      reservedAt: 0,
	      childKind: 'agent-run',
	      step: 'builder',
	    });
	  });
	},
    },
  }));

  first.freeCapacity();

  assert.deepEqual(readChildReservations(stateDir), [replacement!.reservation]);
  assert.equal(existsSync(replacement!.gatePath), true, 'the replacement gate survives stale settlement');
  assert.equal(second.freeCapacity(), 0, 'the replacement reservation retains the only capacity slot');
});

test('a stale live gate settler cannot overwrite a finalized replacement after child exit', () => {
  const firstPid = 111;
  const replacementPid = 222;
  const stale = reserveChild(stateDir, {
    workflow: 'wf1',
    run: 'run_live_gate_finalized_race',
    reservedAt: 0,
    childKind: 'agent-run',
    step: 'builder',
  });
  const firstChild = finalizeChildReservation(stateDir, stale.reservation, {
    pid: firstPid,
    spawnedAt: 0,
    kind: 'agent-run',
    step: 'builder',
  });
  const { hub: firstHub } = mockHub({ wake: [{ changed: false, cursor: 1 }] });
  const { hub: secondHub } = mockHub({ wake: [{ changed: false, cursor: 1 }] });
  const { spawner } = fakeSpawner();
  let replacementGate = '';
  let replacementToken = '';
  let injected = false;
  const isAlive = (pid: number): boolean => pid === firstPid || pid === replacementPid;
  const second = createShiftLoop(baseOpts(secondHub, spawner, {
    workflow: 'wf1',
    cap: 1,
    isAlive,
  }));
  const first = createShiftLoop(baseOpts(firstHub, spawner, {
    workflow: 'wf1',
    cap: 1,
    isAlive,
    dispatchLockOptions: {
	beforeOpen: () => {
	  if (injected) return;
	  injected = true;
	  second.noteChildExited({
	    workflow: firstChild.workflow,
	    run: firstChild.run,
	    kind: 'agent-run',
	    pid: firstChild.pid,
	  });
	  withDispatchLock(stateDir, {}, () => {
	    const replacement = reserveChild(stateDir, {
	      workflow: 'wf1',
	      run: firstChild.run,
	      reservedAt: Date.now(),
	      childKind: 'agent-run',
	      step: 'builder',
	    });
	    const child = finalizeChildReservation(stateDir, replacement.reservation, {
	      pid: replacementPid,
	      spawnedAt: 1,
	      kind: 'agent-run',
	      step: 'builder',
	    });
	    startReservedChild(stateDir, child);
	    replacementGate = replacement.gatePath;
	    replacementToken = replacement.reservation.token;
	  });
	},
    },
  }));

  first.freeCapacity();

  assert.deepEqual(readChildRecords(stateDir).map((record) => record.pid), [replacementPid]);
  assert.equal(readChildRecords(stateDir)[0]?.gateToken, replacementToken, 'the replacement handoff survives stale settlement');
  assert.equal(existsSync(replacementGate), true, 'the replacement gate survives stale settlement');
  assert.equal(second.freeCapacity(), 0, 'the finalized replacement retains the only capacity slot');
});

test('two shared-state loops keep a replacement record when a stale reaper races it', () => {
  const firstPid = 111;
  const replacementPid = 222;
  writeChildRecord(stateDir, {
    workflow: 'wf1',
    run: 'run_reaper_race',
    pid: firstPid,
    spawnedAt: 0,
    kind: 'agent-run',
  });
  const { hub: firstHub } = mockHub({ wake: [{ changed: false, cursor: 1 }] });
  const { hub: secondHub } = mockHub({ wake: [{ changed: false, cursor: 1 }] });
  const { spawner } = fakeSpawner();
  const reaped: string[] = [];
  const isAlive = (pid: number): boolean => pid === replacementPid;
  let injected = false;
  const second = createShiftLoop(baseOpts(secondHub, spawner, {
    workflow: 'wf1',
    cap: 1,
    isAlive,
    onEvent: (event) => reaped.push(event.type),
  }));
  const first = createShiftLoop(baseOpts(firstHub, spawner, {
    workflow: 'wf1',
    cap: 1,
    isAlive,
    onEvent: (event) => reaped.push(event.type),
    dispatchLockOptions: {
	beforeOpen: () => {
	  if (injected) return;
	  injected = true;
	  assert.equal(second.freeCapacity(), 1, 'the other Shift reaped the stale record first');
	  writeChildRecord(stateDir, {
	    workflow: 'wf1',
	    run: 'run_reaper_race',
	    pid: replacementPid,
	    spawnedAt: 1,
	    kind: 'agent-run',
	  });
	},
    },
  }));

  first.freeCapacity();

  assert.deepEqual(readChildRecords(stateDir).map((record) => record.pid), [replacementPid]);
  assert.equal(second.freeCapacity(), 0, 'the replacement worker retains the only capacity slot');
  assert.deepEqual(reaped, ['reaped'], 'only the Shift that removed the stale record emits reaped');
});

// ---- role-level signal wiring (through the loop seam) -----------------------

test('signal wiring: first signal stops the loop once; second hard-exits 130', () => {
  const stops: string[] = [];
  const exits: number[] = [];
  const errs: string[] = [];
  const handlers = new Map<string, () => void>();
  const host: SignalHost = {
    on: (sig, handler) => handlers.set(sig, handler),
    exit: (code) => {
      exits.push(code);
    },
  };
  installSignalHandlers({ stop: () => stops.push('stop') }, host, (l) => errs.push(l));

  assert.deepEqual([...handlers.keys()].sort(), ['SIGINT', 'SIGTERM']); // both wired

  handlers.get('SIGINT')!(); // first signal → clean drain
  assert.deepEqual(stops, ['stop']);
  assert.deepEqual(exits, []);
  assert.ok(errs.some((e) => /SIGINT received — draining/.test(e)));

  handlers.get('SIGTERM')!(); // second signal (either kind) → hard exit
  assert.deepEqual(stops, ['stop']); // no second stop
  assert.deepEqual(exits, [130]);
  assert.ok(errs.some((e) => /second SIGTERM — exiting now/.test(e)));
});

// ---- iterate() e2e: agent dispatch, park, wake flip -------------------------

test('e2e: iterate() dispatches an agent order, parks quiet, and re-sweeps only when a submit-shaped event flips wake', async () => {
  cacheBuilderStep();
  const calls: Call[] = [];
  let events = 1; // the pending order is event #1
  let openOrders: WorkOrder[] = [wo('run_deadbeef', 'builder')];
  let cursor: number | undefined;
  const hub: HubClient = {
    // Not exercised here: the byte-bodied upload has its own tests.
    async putFileArtifact() {
      throw new Error('putFileArtifact is not exercised by this test');
    },
    async wake(c) {
      cursor = c;
      const changed = c === undefined || c < events;
      calls.push({ verb: 'wake', arg: changed });
      return { text: '', cursor: events, changed };
    },
    async whatsNext(req) {
      calls.push({ verb: 'whats_next', arg: req?.workflow });
      return { text: '', workflow: 'wf1', def: 'demo', orders: openOrders };
    },
    async getOrder(req) {
      calls.push({ verb: 'get_order', arg: req.run });
      return { text: '', workflow: req.workflow, run: req.run, order: null, lease: { claimed: true } };
    },
    async submit(req) {
      calls.push({ verb: 'submit', arg: req.run });
      events++; // the submit writes an event — this is what flips the next wake
      openOrders = []; // the order is fulfilled and no longer offered
      return { text: '' };
    },
    async presencePing(req) {
      return { text: '', ok: true, name: req.name, lastSeen: 0 };
    },
    async heartbeat() {
      return { text: '' };
    },
    async release() {
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
      return { text: '', workflow: req.workflow, run: req.run, step: '', recorded: true, claimed: true };
    },
    async whoami() {
      return { text: '', orgId: '', orgName: '', actor: { id: '', kind: 'agent', role: 'agent', scopes: [] }, tokenStatus: 'active', authMethod: 'token' };
    },
  };
  void cursor; // referenced only to model the hub's cursor threading

  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));

  // Iteration 1: wake changed → sweep → one detached agent-run child.
  assert.equal(await loop.iterate(), 1);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.kind, 'agent-run');

  // Iteration 2: wake unchanged → no sweep, no new work.
  assert.equal(await loop.iterate(), 0);

  // The detached runner submits — the event that flips the next wake.
  await hub.submit({ workflow: 'wf1', run: 'run_deadbeef', path: 'pr', value: { ok: true }, done: true });

  // Iteration 3: wake changed again → re-sweep finds no open orders.
  assert.equal(await loop.iterate(), 0);
  assert.equal(spawns.length, 1, 'no second child for a finished run');

  const wakes = calls.filter((c) => c.verb === 'wake').map((c) => c.arg);
  assert.deepEqual(wakes, [true, false, true]);
  assert.equal(calls.filter((c) => c.verb === 'whats_next').length, 2); // swept on iters 1 and 3
  assert.equal(calls.filter((c) => c.verb === 'get_order').length, 0); // never first-contacts
});

// ---- agent-run dispatch: capacity, failure, lane separation ------------------
//
// AGENT orders have exactly ONE path: a detached `owenloop work agent-run` child.
// There is no flag or lean-order handoff. The child resolves its verified step and
// harness from the authoritative order digest; Shift's cache is legacy-only. The
// tests below pin capacity, failure handling, and command-lane separation.

/** Cache a builder-step bundle, optionally declaring a harness on the step. */
function cacheBuilderWithHarness(harness?: string): void {
  const tpl: NormalizedStepSpec = { step: 'builder', brief: BRIEF_BODY, permissions: { extensions: {} } };
  writeBundle(
    cacheDir,
    {
      def: {
        name: 'demo',
        hash: DEMO_HASH,
        steps: [{ name: 'builder', body: '', ...(harness !== undefined ? { harness } : {}) }],
      },
      fetchedAt: 0,
      origin: ORIGIN,
    },
    [tpl],
  );
}

function agentWf(orders: WorkOrder[]): Record<string, { def: string; orders: WorkOrder[] }> {
  return { wf1: { def: 'demo', orders } };
}

// The child reads its own step spec, so a bundle with no cached spec for the step
// still dispatches — the failure (if any) belongs to the child, not the sweep.
test('an agent order dispatches even with no cached step spec', async () => {
  writeBundle(cacheDir, { def: { name: 'demo', hash: DEMO_HASH, steps: [{ name: 'builder', body: '' }] }, fetchedAt: 0, origin: ORIGIN }, []);
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: agentWf([wo('run_deadbeef', 'builder')]) });
  const { spawner, spawns } = fakeSpawner();
  const dispatched = await createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' })).iterate();
  assert.equal(dispatched, 1);
  assert.equal(spawns.length, 1);
});

test('maxConcurrentAgents caps agent-run dispatch on top of the global cap', async () => {
  cacheBuilderStep();
  const orders = [wo('run_a1', 'builder'), wo('run_b2', 'builder'), wo('run_c3', 'builder')];
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: agentWf(orders) });
  const { spawner, spawns } = fakeSpawner();
  const out: string[] = [];
  await createShiftLoop(
    baseOpts(hub, spawner, {
      workflow: 'wf1',
      cap: 10, // plenty of global room — the agent cap is what must bite
      maxConcurrentAgents: 2,
      localQueueHoldMs: MAX_PENDING_CANDIDATE_AGE_MS,
      out: (l) => out.push(l),
    }),
  ).iterate();

  assert.equal(spawns.length, 2);
  assert.equal(readChildRecords(stateDir).length, 2);
  assert.match(out.join('\n'), /at the agent-run cap \(2\)/);
});

// ---- exec reserve -----------------------------------------------------------

test('the default exec reserve keeps one cap slot reachable by command work', async () => {
  cacheMixedBundle();
  const orders = [
    wo('run_agent_1', 'builder'),
    wo('run_agent_2', 'builder'),
    wo('run_agent_3', 'builder'),
    wo('run_command', 'cmd'),
  ];
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: cmdWf(orders) });
  const { spawner, spawns } = fakeSpawner();
  const out: string[] = [];
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    maxConcurrentAgents: 3,
    localQueueHoldMs: MAX_PENDING_CANDIDATE_AGE_MS,
    out: (line) => out.push(line),
  }));

  assert.equal(loop.agentCeiling(), 2);
  assert.equal(await loop.iterate(), 3);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_agent_1', 'run_agent_2', 'run_command']);
  assert.match(out.join('\n'), /agent-run cap \(2, 3 requested minus a 1-slot exec reserve\)/);
});

test('a full agent lane does not defer whats_next while command capacity remains', async () => {
  cacheCommandBundle();
  writeChildRecord(stateDir, {
    workflow: 'wf1', run: 'run_agent_1', pid: process.pid, spawnedAt: 0, kind: 'agent-run', step: 'builder',
  });
  writeChildRecord(stateDir, {
    workflow: 'wf1', run: 'run_agent_2', pid: process.pid, spawnedAt: 0, kind: 'agent-run', step: 'builder',
  });
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: cmdWf([wo('run_command', 'cmd')]),
  });
  const { spawner, spawns } = fakeSpawner();
  const out: string[] = [];
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    out: (line) => out.push(line),
  }));

  assert.equal(loop.agentCeiling(), 2);
  assert.equal(await loop.iterate(), 1);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_command']);
  assert.equal(out.some((line) => line.includes('deferring whats_next')), false);
});

test('execReserve 0 restores the previous agent-only cap behavior', async () => {
  cacheBuilderStep();
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_agent_1', 'builder'), wo('run_agent_2', 'builder'), wo('run_agent_3', 'builder')]),
  });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    maxConcurrentAgents: 3,
    execReserve: 0,
  }));

  assert.equal(loop.agentCeiling(), 3);
  assert.equal(await loop.iterate(), 3);
  assert.equal(spawns.length, 3);
});

test('the reserve clamp keeps a cap-1 shift able to dispatch an agent', async () => {
  cacheBuilderStep();
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_agent_1', 'builder')]),
  });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 1,
    maxConcurrentAgents: 4,
  }));

  assert.equal(loop.agentCeiling(), 1);
  assert.equal(await loop.iterate(), 1);
  assert.equal(spawns.length, 1);
});

test('a larger reserve remains inside cap while command work fills the held slots', async () => {
  cacheMixedBundle();
  const orders = [
    wo('run_agent_1', 'builder'),
    wo('run_agent_2', 'builder'),
    wo('run_command_1', 'cmd'),
    wo('run_command_2', 'cmd'),
  ];
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: cmdWf(orders) });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    maxConcurrentAgents: 3,
    execReserve: 2,
  }));

  assert.equal(loop.agentCeiling(), 1);
  assert.equal(await loop.iterate(), 3);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_agent_1', 'run_command_1', 'run_command_2']);
});

test('a zero agent ceiling releases agent work instead of holding its claim', async () => {
  cacheBuilderStep();
  const events: import('../src/shift/protocol.ts').ShiftEvent[] = [];
  const errors: string[] = [];
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_agent_1', 'builder')]),
  });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    maxConcurrentAgents: 0,
    onEvent: (event) => events.push(event),
    err: (line) => errors.push(line),
  }));

  assert.equal(loop.agentCeiling(), 0);
  assert.equal(await loop.iterate(), 0);
  assert.equal(spawns.length, 0);
  assert.deepEqual(events.map((event) => event.type === 'order-dropped' ? event.reason : event.type), ['agent-lane-closed']);
  assert.deepEqual(calls.filter((call) => call.verb === 'release').map((call) => call.arg), [
    {
      workflow: 'wf1',
      run: 'run_agent_1',
      reason: 'agent-lane-closed: this shift runs no agent-run children (agent ceiling 0) — handing the claim back to the hub',
    },
  ]);
  assert.match(errors.join('\n'), /agent ceiling 0/);
});

// ---- undispatchable claims --------------------------------------------------

test('a cap-1 shift releases an extra agent claim rather than keeping it locally', async () => {
  cacheBuilderStep();
  const events: import('../src/shift/protocol.ts').ShiftEvent[] = [];
  const { hub, calls } = mockHub({
    wake: [
      { changed: true, cursor: 1 },
      { changed: false, cursor: 1 },
    ],
    perWf: agentWf([wo('run_first', 'builder'), wo('run_second', 'builder')]),
  });
  const alive = new Set<number>();
  const spawns: SpawnSpec[] = [];
  let pid = 1000;
  const spawner: Spawner = (spec) => {
    spawns.push(spec);
    alive.add(pid);
    return { pid: pid++ };
  };
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 1,
    maxConcurrentAgents: 4,
    isAlive: (candidatePid) => alive.has(candidatePid),
    onEvent: (event) => events.push(event),
  }));

  assert.equal(await loop.iterate(), 1);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);
  assert.deepEqual(calls.filter((call) => call.verb === 'release').map((call) => call.arg), [
    {
      workflow: 'wf1',
      run: 'run_second',
      reason: 'dispatch-cap-full: at the dispatch cap (1) — handing the claim back to the hub',
    },
  ]);
  assert.equal(
    events.some((event) =>
      event.type === 'order-dropped' &&
      event.run === 'run_second' &&
      event.reason === 'dispatch-cap-full'),
    true,
  );

  // The released claim is unfinished business, so the next tick sweeps even
  // though the cursor did NOT change. Before this was wired, a capacity release
  // left ready work with nothing to bring it back: a child exiting locally is
  // not a hub event, and with no local queue the order is not retained here
  // either — so the shift sat idle holding the capacity it had just freed.
  alive.delete(1000);
  assert.equal(await loop.iterate(), 1);
  assert.equal(count(calls, 'whats_next'), 2, 'the unchanged cursor did not suppress the re-poll');
  // `perWf` is a fixed list with no claim state, so the re-poll is answered
  // with the same two orders and the first one dispatches again. A real hub
  // would have the released order at the head instead. What this asserts is
  // that the freed slot DID go back to the hub and DID dispatch — the run name
  // is the mock's, not the behaviour's.
  assert.equal(spawns.length, 2, 'the freed slot dispatched rather than idling');
});

test('a capacity release re-arms the sweep; a closed agent lane does not', async () => {
  cacheBuilderStep();
  // Two shifts, identical in every way that matters to the second tick: the
  // cursor is UNCHANGED and there is free capacity. They differ only in WHY the
  // first tick handed the claim back. Only the transient reason should send the
  // shift back to the hub.
  const capacity = mockHub({
    wake: [{ changed: true, cursor: 1 }, { changed: false, cursor: 1 }],
    perWf: agentWf([wo('run_first', 'builder'), wo('run_second', 'builder')]),
  });
  const alive = new Set<number>();
  let pid = 2000;
  const capacityLoop = createShiftLoop(baseOpts(capacity.hub, (spec) => {
    void spec;
    alive.add(pid);
    return { pid: pid++ };
  }, {
    workflow: 'wf1',
    cap: 1,
    maxConcurrentAgents: 4,
    isAlive: (candidatePid) => alive.has(candidatePid),
  }));
  await capacityLoop.iterate();
  alive.clear();
  await capacityLoop.iterate();
  assert.equal(
    count(capacity.calls, 'whats_next'),
    2,
    'dispatch-cap-full is transient: capacity can free, so the order is worth re-polling for',
  );

  const laneClosed = mockHub({
    wake: [{ changed: true, cursor: 1 }, { changed: false, cursor: 1 }],
    perWf: agentWf([wo('run_agent_1', 'builder')]),
  });
  const laneClosedLoop = createShiftLoop(baseOpts(laneClosed.hub, fakeSpawner().spawner, {
    workflow: 'wf1',
    maxConcurrentAgents: 0,
  }));
  await laneClosedLoop.iterate();
  await laneClosedLoop.iterate();
  assert.equal(
    count(laneClosed.calls, 'whats_next'),
    1,
    'agent-lane-closed is a standing configuration, not a transient shortage — '
      + 're-arming it would poll the hub every tick forever and never dispatch',
  );
});

test('an agent-lane cap releases an undispatchable agent claim', async () => {
  cacheBuilderStep();
  const events: import('../src/shift/protocol.ts').ShiftEvent[] = [];
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_first', 'builder'), wo('run_second', 'builder')]),
  });
  const { spawner, spawns } = fakeSpawner();

  await createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 10,
    maxConcurrentAgents: 1,
    execReserve: 0,
    onEvent: (event) => events.push(event),
  })).iterate();

  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);
  assert.deepEqual(calls.filter((call) => call.verb === 'release').map((call) => call.arg), [
    {
      workflow: 'wf1',
      run: 'run_second',
      reason: 'agent-cap-full: at the agent-run cap (1) — handing the claim back to the hub',
    },
  ]);
  assert.equal(
    events.some((event) => event.type === 'order-dropped' && event.reason === 'agent-cap-full'),
    true,
  );
});

test('an agent-capacity cooldown re-arms on agent room, not a broad total-capacity change', async () => {
  cacheBuilderStep();
  let monotonic = 0;
  writeChildRecord(stateDir, {
    workflow: 'wf1', run: 'run_agent_blocker', pid: process.pid, spawnedAt: 0, kind: 'agent-run', step: 'builder',
  });
  const perWf = agentWf([wo('run_agent_released', 'builder')]);
  const { hub, calls } = mockHub({
    wake: [
      { changed: true, cursor: 1 },
      { changed: true, cursor: 2 },
      { changed: false, cursor: 2 },
    ],
    perWf,
  });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 3,
    maxConcurrentAgents: 1,
    execReserve: 0,
    monotonicNow: () => monotonic,
  }));

  await loop.iterate();
  assert.equal(count(calls, 'whats_next'), 1);
  assert.equal(spawns.length, 0, 'the first agent order is released while the lane is full');

  // More total dispatch capacity is irrelevant while the sole agent lane is
  // still occupied. A changed cursor may sweep, but must not re-claim it.
  loop.setCap(4);
  monotonic = 1;
  await loop.iterate();
  assert.equal(count(calls, 'whats_next'), 1, 'a broad capacity-vector change did not clear agent saturation');

  // Freeing the relevant lane before the monotonic deadline is the early
  // retry signal, even when the hub cursor stays unchanged. A real hub gives
  // this re-offer a fresh run id.
  removeChildRecord(stateDir, 'run_agent_blocker');
  perWf.wf1!.orders = [wo('run_agent_reoffer', 'builder')];
  monotonic = 2;
  await loop.iterate();
  assert.equal(count(calls, 'whats_next'), 2);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_agent_reoffer']);
});

test('an agent-capacity cooldown suppresses fresh-run churn until its fixed monotonic deadline', async () => {
  cacheBuilderStep();
  let monotonic = 0;
  writeChildRecord(stateDir, {
    workflow: 'wf1', run: 'run_agent_blocker', pid: process.pid, spawnedAt: 0, kind: 'agent-run', step: 'builder',
  });
  const perWf = agentWf([]);
  let offered = 0;
  const { hub, calls } = mockHub({
    wake: [
      { changed: true, cursor: 1 },
      { changed: true, cursor: 2 },
      { changed: true, cursor: 3 },
      { changed: false, cursor: 3 },
      { changed: true, cursor: 4 },
    ],
    perWf,
    onTargetedWhatsNext: () => {
      offered++;
      perWf.wf1!.orders = [wo(`run_agent_reoffer_${offered}`, 'builder')];
    },
  });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 3,
    maxConcurrentAgents: 1,
    execReserve: 0,
    monotonicNow: () => monotonic,
  }));

  await loop.iterate();
  assert.equal(count(calls, 'whats_next'), 1);
  assert.deepEqual(calls.filter((call) => call.verb === 'release').map((call) => call.arg), [
    {
      workflow: 'wf1',
      run: 'run_agent_reoffer_1',
      reason: 'agent-cap-full: at the agent-run cap (1) — handing the claim back to the hub',
    },
  ]);

  monotonic = 1;
  await loop.iterate();
  monotonic = 29_999;
  await loop.iterate();
  assert.equal(count(calls, 'whats_next'), 1, 'busy cursor activity before 30s did not re-claim the stable step');

  monotonic = 30_000;
  await loop.iterate();
  assert.equal(count(calls, 'whats_next'), 2, 'the fixed deadline retries on an unchanged wake');
  assert.deepEqual(calls.filter((call) => call.verb === 'release').map((call) => call.arg), [
    {
      workflow: 'wf1',
      run: 'run_agent_reoffer_1',
      reason: 'agent-cap-full: at the agent-run cap (1) — handing the claim back to the hub',
    },
    {
      workflow: 'wf1',
      run: 'run_agent_reoffer_2',
      reason: 'agent-cap-full: at the agent-run cap (1) — handing the claim back to the hub',
    },
  ]);

  monotonic = 30_001;
  await loop.iterate();
  assert.equal(count(calls, 'whats_next'), 2, 'the fresh release arms a new fixed window instead of sliding it');
});

test('a workflow cooldown leaves inbox and sibling workflows observable, but deliberately delays its command work', async () => {
  cacheCommandBundle();
  let monotonic = 0;
  writeChildRecord(stateDir, {
    workflow: 'wfA', run: 'run_agent_blocker', pid: process.pid, spawnedAt: 0, kind: 'agent-run', step: 'builder',
  });
  const perWf = {
    wfA: { def: 'demo', orders: [modernWo('run_agent_a1', 'builder', 'agent')] },
    wfB: { def: 'demo', orders: [wo('run_command_b1', 'cmd', 'wfB')] },
  };
  const { hub, calls } = mockHub({
    wake: [
      { changed: true, cursor: 1 },
      { changed: true, cursor: 2 },
      { changed: false, cursor: 2 },
    ],
    inbox: ['wfA', 'wfB'],
    perWf,
  });
  const { spawner, spawns } = fakeSpawner();
  const reapers: SweepOpts[] = [];
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    cap: 5,
    maxConcurrentAgents: 1,
    execReserve: 0,
    monotonicNow: () => monotonic,
    workRoot: join(cacheDir, 'work'),
    sweepWorkDirs: (options) => {
      reapers.push(options);
      return [];
    },
  }));

  await loop.iterate();
  perWf.wfA.orders = [
    modernWo('run_agent_a2', 'builder', 'agent'),
    wo('run_command_a_delayed', 'cmd', 'wfA'),
  ];
  perWf.wfB.orders = [wo('run_command_b2', 'cmd', 'wfB')];

  monotonic = 1;
  await loop.iterate();
  const targetedBeforeDeadline = calls
    .filter((call) => call.verb === 'whats_next' && (call.arg as { workflow?: string }).workflow !== undefined)
    .map((call) => (call.arg as { workflow?: string }).workflow);
  assert.deepEqual(targetedBeforeDeadline, ['wfA', 'wfB', 'wfB']);
  assert.equal(
    calls.filter((call) => call.verb === 'whats_next' && (call.arg as { workflow?: string }).workflow === undefined).length,
    2,
    'the untargeted inbox request stays outside the targeted cooldown',
  );
  assert.deepEqual([...reapers.at(-1)!.workflows], ['wfB'], 'the reaper sees the observed sibling, not skipped wfA');
  assert.equal(spawns.some((spawn) => spawn.run === 'run_command_a_delayed'), false);

  monotonic = 30_000;
  await loop.iterate();
  assert.equal(
    spawns.some((spawn) => spawn.run === 'run_command_a_delayed'),
    true,
    'workflow-wide suppression intentionally delays command work until the bound',
  );
});

test('a sweep with only a cooled workflow does not call the work-directory reaper', async () => {
  cacheBuilderStep();
  let monotonic = 0;
  writeChildRecord(stateDir, {
    workflow: 'wf1', run: 'run_agent_blocker', pid: process.pid, spawnedAt: 0, kind: 'agent-run', step: 'builder',
  });
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }, { changed: true, cursor: 2 }],
    perWf: agentWf([wo('run_agent_released', 'builder')]),
  });
  const { spawner } = fakeSpawner();
  const reapers: SweepOpts[] = [];
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 3,
    maxConcurrentAgents: 1,
    execReserve: 0,
    monotonicNow: () => monotonic,
    workRoot: join(cacheDir, 'work'),
    sweepWorkDirs: (options) => {
      reapers.push(options);
      return [];
    },
  }));

  await loop.iterate();
  assert.equal(reapers.length, 1);
  monotonic = 1;
  await loop.iterate();
  assert.equal(count(calls, 'whats_next'), 1, 'the targeted call was suppressed');
  assert.equal(reapers.length, 1, 'no hub observation means no reaper call');
});

test('a command lane at capacity releases its extra claim', async () => {
  cacheCommandBundle();
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: cmdWf([wo('run_first', 'cmd'), wo('run_second', 'cmd')]),
  });
  const { spawner, spawns } = fakeSpawner();

  await createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 1,
  })).iterate();

  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);
  assert.deepEqual(calls.filter((call) => call.verb === 'release').map((call) => call.arg), [
    {
      workflow: 'wf1',
      run: 'run_second',
      reason: 'dispatch-cap-full: at the dispatch cap (1) — handing the claim back to the hub',
    },
  ]);
});

test('a release failure is observable without interrupting dispatch', async () => {
  cacheBuilderStep();
  const events: import('../src/shift/protocol.ts').ShiftEvent[] = [];
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_first', 'builder'), wo('run_second', 'builder')]),
    releaseError: new Error('hub unavailable'),
  });
  const { spawner, spawns } = fakeSpawner();

  await createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 1,
    onEvent: (event) => events.push(event),
  })).iterate();
  await Promise.resolve();

  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);
  assert.equal(
    events.some((event) =>
      event.type === 'hub-error' && event.op === 'release' && event.message === 'hub unavailable'),
    true,
  );
});

test('a rate-limited release backs off later hub polling', async () => {
  cacheBuilderStep();
  let monotonic = 0;
  const events: import('../src/shift/protocol.ts').ShiftEvent[] = [];
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_first', 'builder'), wo('run_second', 'builder')]),
    releaseError: new HubError(429, 'slow down', 'rate_limited', 23_000),
  });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 1,
    monotonicNow: () => monotonic,
    onEvent: (event) => events.push(event),
  }));

  await loop.iterate();
  await Promise.resolve();
  await Promise.resolve();
  const callsBeforeBackoff = calls.length;

  monotonic = 1;
  await loop.iterate();

  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);
  assert.equal(calls.length, callsBeforeBackoff, 'a release Retry-After suppresses later hub polling');
  assert.equal(
    events.some((event) => event.type === 'hub-error' && event.op === 'release'),
    true,
  );
});

test('a re-offer with a live child is never released', async () => {
  cacheBuilderStep();
  writeChildRecord(stateDir, {
    workflow: 'wf1',
    run: 'run_live',
    pid: process.pid,
    spawnedAt: 0,
    kind: 'agent-run',
    step: 'builder',
  });
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_live', 'builder')]),
  });
  const { spawner, spawns } = fakeSpawner();

  await createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 10,
  })).iterate();

  assert.equal(spawns.length, 0);
  assert.equal(count(calls, 'release'), 0);
});

test('agentCeiling follows live dispatch-cap changes', () => {
  const { hub } = mockHub({});
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    cap: 3,
    maxConcurrentAgents: 4,
  }));

  assert.equal(loop.agentCeiling(), 2);
  loop.setCap(1);
  assert.equal(loop.agentCeiling(), 1);
  loop.setCap(5);
  assert.equal(loop.agentCeiling(), 4);
});

test('a claimed order queued by the agent cap dispatches after a child exits without a new hub wake', async () => {
  cacheBuilderStep();
  const orders = [wo('run_first', 'builder'), wo('run_second', 'builder')];
  const { hub, calls } = mockHub({
    wake: [
      { changed: true, cursor: 1 },
      { changed: false, cursor: 1 },
    ],
    perWf: agentWf(orders),
  });
  const alive = new Set<number>();
  const spawns: SpawnSpec[] = [];
  let pid = 1000;
  const spawner: Spawner = (spec) => {
    spawns.push(spec);
    alive.add(pid);
    return { pid: pid++ };
  };
  const loop = createShiftLoop(
    baseOpts(hub, spawner, {
      workflow: 'wf1',
      cap: 10,
      maxConcurrentAgents: 1,
      localQueueHoldMs: MAX_PENDING_CANDIDATE_AGE_MS,
      isAlive: (candidatePid) => alive.has(candidatePid),
    }),
  );

  assert.equal(await loop.iterate(), 1);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);
  assert.equal(count(calls, 'whats_next'), 1);

  alive.delete(1000);

  assert.equal(await loop.iterate(), 1);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first', 'run_second']);
  assert.equal(
    count(calls, 'whats_next'),
    1,
    'the second run was already claimed, so local dispatch must not wait for a new hub sweep',
  );
});

test('pending age includes a 40-second whats_next response before 81 seconds in the local queue', async () => {
  cacheBuilderStep();
  let wall = 0;
  let monotonic = 0;
  const orders = [wo('run_first', 'builder'), wo('run_stale', 'builder')];
  const { hub, calls } = mockHub({
    wake: [
      { changed: true, cursor: 1 },
      { changed: false, cursor: 1 },
    ],
    perWf: agentWf(orders),
    onTargetedWhatsNext: () => { monotonic += 40_000; },
  });
  const alive = new Set<number>();
  const spawns: SpawnSpec[] = [];
  let pid = 1000;
  const err: string[] = [];
  const spawner: Spawner = (spec) => {
    spawns.push(spec);
    alive.add(pid);
    return { pid: pid++ };
  };
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 10,
    maxConcurrentAgents: 1,
    localQueueHoldMs: MAX_PENDING_CANDIDATE_AGE_MS,
    isAlive: (candidatePid) => alive.has(candidatePid),
    now: () => wall,
    monotonicNow: () => monotonic,
    err: (line) => err.push(line),
  }));

  assert.equal(await loop.iterate(), 1);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);
  alive.delete(1000);
  monotonic += 81_000;

  assert.equal(await loop.iterate(), 0);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);
  assert.match(err.join('\n'), /queued claim expired before local dispatch/);
  assert.equal(count(calls, 'whats_next'), 1);
  assert.deepEqual(calls.filter((call) => call.verb === 'release').map((call) => call.arg), [
    {
      workflow: 'wf1',
      run: 'run_stale',
      reason: 'claim-expired: queued claim expired before local dispatch — handing the claim back to the hub',
    },
  ]);
});

test('a whats_next response older than 90 seconds is not dispatched into immediate capacity', async () => {
  cacheBuilderStep();
  let monotonic = 0;
  const events: import('../src/shift/protocol.ts').ShiftEvent[] = [];
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_stale', 'builder')]),
    onTargetedWhatsNext: () => { monotonic += MAX_PENDING_CANDIDATE_AGE_MS + 1; },
  });
  const { spawner, spawns } = fakeSpawner();
  const err: string[] = [];

  const dispatched = await createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    monotonicNow: () => monotonic,
    err: (line) => err.push(line),
    onEvent: (event) => events.push(event),
  })).iterate();

  assert.equal(dispatched, 0);
  assert.equal(spawns.length, 0);
  assert.match(err.join('\n'), /claim expired before local dispatch/);
  assert.deepEqual(calls.filter((call) => call.verb === 'release').map((call) => call.arg), [
    {
      workflow: 'wf1',
      run: 'run_stale',
      reason: 'claim-expired: claim expired before local dispatch — handing the claim back to the hub',
    },
  ]);
  assert.equal(
    events.some((event) => event.type === 'order-dropped' && event.reason === 'claim-expired'),
    true,
  );
});

test('a fresh whats_next response still dispatches immediately', async () => {
  cacheBuilderStep();
  let monotonic = 0;
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_fresh', 'builder')]),
    onTargetedWhatsNext: () => { monotonic += 40_000; },
  });
  const { spawner, spawns } = fakeSpawner();

  const dispatched = await createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    monotonicNow: () => monotonic,
  })).iterate();

  assert.equal(dispatched, 1);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_fresh']);
});

for (const wallJump of [-1_000_000_000, 1_000_000_000]) {
  const direction = wallJump < 0 ? 'backward' : 'forward';
  test(`a ${direction} wall-clock jump cannot expire a fresh claim`, async () => {
    cacheBuilderStep();
    let wall = 2_000_000_000;
    let monotonic = 0;
    const { hub } = mockHub({
      wake: [{ changed: true, cursor: 1 }],
      perWf: agentWf([wo(`run_wall_${direction}`, 'builder')]),
      onTargetedWhatsNext: () => {
	wall += wallJump;
	monotonic += 1_000;
      },
    });
    const { spawner, spawns } = fakeSpawner();

    const dispatched = await createShiftLoop(baseOpts(hub, spawner, {
      workflow: 'wf1',
      now: () => wall,
      monotonicNow: () => monotonic,
    })).iterate();

    assert.equal(dispatched, 1);
    assert.equal(spawns.length, 1);
  });
}

test('persisted child timestamps use wall time rather than the monotonic clock', async () => {
  cacheBuilderStep();
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_wall_timestamp', 'builder')]),
  });
  const { spawner } = fakeSpawner();

  await createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    now: () => 123_456_789,
    monotonicNow: () => 17,
  })).iterate();

  assert.equal(readChildRecords(stateDir)[0]?.spawnedAt, 123_456_789);
});

test('queued claims release at their hold deadline even while capacity remains saturated', async () => {
  cacheBuilderStep();
  const orders = [wo('run_first', 'builder'), wo('run_stale', 'builder'), wo('run_stale_2', 'builder')];
  const { hub, calls } = mockHub({
    wake: [
      { changed: true, cursor: 1 },
      { changed: false, cursor: 1 },
    ],
    perWf: agentWf(orders),
  });
  const alive = new Set<number>();
  const spawns: SpawnSpec[] = [];
  let pid = 1000;
  let monotonic = 0;
  const err: string[] = [];
  const events: import('../src/shift/protocol.ts').ShiftEvent[] = [];
  const spawner: Spawner = (spec) => {
    spawns.push(spec);
    alive.add(pid);
    return { pid: pid++ };
  };
  const loop = createShiftLoop(
    baseOpts(hub, spawner, {
      workflow: 'wf1',
      cap: 10,
      maxConcurrentAgents: 1,
      localQueueHoldMs: 30_000,
      isAlive: (candidatePid) => alive.has(candidatePid),
      monotonicNow: () => monotonic,
      err: (line) => err.push(line),
      onEvent: (event) => events.push(event),
    }),
  );

  assert.equal(await loop.iterate(), 1);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);

  monotonic = 30_000;

  assert.equal(await loop.iterate(), 0);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);
  assert.match(err.join('\n'), /queued claim expired before local dispatch/);
  assert.equal(count(calls, 'whats_next'), 1, 'classifying the stale local candidate does not require another hub sweep');
  assert.deepEqual(calls.filter((call) => call.verb === 'release').map((call) => call.arg), [
    {
      workflow: 'wf1',
      run: 'run_stale',
      reason: 'claim-expired: queued claim expired before local dispatch — handing the claim back to the hub',
    },
    {
      workflow: 'wf1',
      run: 'run_stale_2',
      reason: 'claim-expired: queued claim expired before local dispatch — handing the claim back to the hub',
    },
  ]);
  assert.equal(
    events.filter((event) => event.type === 'order-dropped' && event.reason === 'claim-expired').length,
    2,
  );
});

test('live agent-run records consume the agent cap; the global cap still applies too', async () => {
  cacheBuilderStep();
  // One runner already in flight (this very process's pid ⇒ provably alive).
  writeChildRecord(stateDir, { workflow: 'wf1', run: 'run_prior', pid: process.pid, spawnedAt: 0, kind: 'agent-run', step: 'builder' });
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: agentWf([wo('run_a1', 'builder'), wo('run_b2', 'builder')]) });
  const { spawner, spawns } = fakeSpawner();
  await createShiftLoop(
    baseOpts(hub, spawner, { workflow: 'wf1', cap: 10, maxConcurrentAgents: 2, isAlive: () => true }),
  ).iterate();

  assert.equal(spawns.length, 1, 'the prior live runner consumed one of the two agent slots');

  // And the global cap is not bypassed: cap 1 with a live record leaves no room.
  const b = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: agentWf([wo('run_c3', 'builder')]) });
  const s2 = fakeSpawner();
  await createShiftLoop(
    baseOpts(b.hub, s2.spawner, { workflow: 'wf1', cap: 1, maxConcurrentAgents: 9, isAlive: () => true }),
  ).iterate();
  assert.equal(s2.spawns.length, 0);
});

test('a failing agent-run spawn is reported and removes its reservation and closed gate', async () => {
  cacheBuilderStep();
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: agentWf([wo('run_deadbeef', 'builder')]) });
  let gatePath: string | undefined;
  const spawner: Spawner = (spec) => {
    gatePath = spec.startGate;
    assert.equal(gatePath === undefined ? undefined : readFileSync(gatePath, 'utf8'), 'wait\n');
    throw new Error('fork bomb');
  };
  const err: string[] = [];
  const dispatched = await createShiftLoop(
    baseOpts(hub, spawner, { workflow: 'wf1', err: (l) => err.push(l) }),
  ).iterate();

  assert.equal(dispatched, 0);
  assert.equal(readChildRecords(stateDir).length, 0);
  assert.equal(readChildReservations(stateDir).length, 0);
  assert.equal(gatePath === undefined ? true : existsSync(gatePath), false);
  assert.match(err.join('\n'), /agent-run spawn for wf1\/run_deadbeef failed: fork bomb/);
});

test('a canonical-path obstruction racing reservation fails closed before spawn', async () => {
  cacheBuilderStep();
  const recordPath = join(stateDir, 'run_reserve_fail.json');
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_reserve_fail', 'builder')]),
    onTargetedWhatsNext: () => {
      mkdirSync(recordPath, { recursive: true });
    },
  });
  const { spawner, spawns } = fakeSpawner();
  const err: string[] = [];
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    err: (line) => err.push(line),
  }));

  await assert.rejects(
    loop.iterate(),
    (error: unknown) => error instanceof ShiftStateRecordError && error.path === recordPath,
  );
  assert.equal(spawns.length, 0, 'spawn is unreachable until the reservation is durable');
  assert.equal(readdirSync(stateDir).some((name) => name.endsWith('.gate')), false);
  assert.match(err.join('\n'), /agent-run spawn for wf1\/run_reserve_fail failed:/u);
});

test('a PID-record finalization failure cancels a real gated child and emits one failure event', async () => {
  cacheBuilderStep();
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_finalize_fail', 'builder')]),
  });
  const script = join(stateDir, '..', 'gated-worker.mjs');
  writeFileSync(
    script,
    "import { readFileSync } from 'node:fs';\n" +
      "const gate = process.env.OWENLOOP_START_GATE;\n" +
      "setInterval(() => {\n" +
      "  if (gate !== undefined && readFileSync(gate, 'utf8') === 'start\\n') process.exit(0);\n" +
      "}, 20);\n",
  );
  const workerFailures: unknown[] = [];
  const realSpawner = createDefaultSpawner(
    ORIGIN,
    'default',
    script,
    'shf_test',
    (failure) => workerFailures.push(failure),
  );
  let gatePath: string | undefined;
  let childPid: number | undefined;
  const spawner: Spawner = (spec) => {
    gatePath = spec.startGate;
    assert.equal(gatePath === undefined ? undefined : readFileSync(gatePath, 'utf8'), 'wait\n');
    const spawned = realSpawner(spec);
    childPid = spawned.pid;
    rmSync(join(stateDir, 'run_finalize_fail.json'));
    mkdirSync(join(stateDir, 'run_finalize_fail.json'));
    return spawned;
  };
  const err: string[] = [];
  const events: string[] = [];
  const keepAlive = setTimeout(() => {}, 5_000);

  try {
    const loop = createShiftLoop(baseOpts(hub, spawner, {
      workflow: 'wf1',
      err: (line) => err.push(line),
      onEvent: (event) => events.push(event.type),
    }));

    await assert.rejects(
      loop.iterate(),
      (error: unknown) =>
	error instanceof ShiftStateRecordError
	&& error.path === join(stateDir, 'run_finalize_fail.json'),
    );
    assert.notEqual(childPid, undefined);
    const deadline = Date.now() + 5_000;
    while (childPid !== undefined && Date.now() < deadline) {
      try {
	process.kill(childPid, 0);
	await new Promise((resolve) => setTimeout(resolve, 20));
      } catch {
	break;
      }
    }
    assert.throws(() => process.kill(childPid!, 0), /ESRCH/u, 'dispatcher cancellation terminates the child');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(events.filter((type) => type === 'failed'), ['failed']);
    assert.deepEqual(workerFailures, [], 'SIGTERM from dispatcher cancellation is not a second failure');
    assert.equal(gatePath === undefined ? true : existsSync(gatePath), false, 'the child never observes a start signal');
    assert.equal(existsSync(join(stateDir, 'run_finalize_fail.json')), true, 'the corrupt canonical path remains for operator repair');
    assert.match(err.join('\n'), /canonical record is unreadable/u);
    assert.match(err.join('\n'), /failed to cancel dispatch reservation/u);
  } finally {
    clearTimeout(keepAlive);
    if (childPid !== undefined) {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
});

test('a broken state-directory path fails closed before hub polling or spawn', async () => {
  cacheBuilderStep();
  writeFileSync(stateDir, 'not a directory');
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_never', 'builder')]),
  });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));

  await assert.rejects(loop.iterate(), /ENOTDIR|not a directory/iu);
  assert.equal(calls.length, 1, 'presence may run before local state reconciliation');
  assert.equal(calls[0]?.verb, 'presence');
  assert.equal(spawns.length, 0);
});

test('a corrupt canonical state record disables dispatch before work polling or spawn', async () => {
  cacheBuilderStep();
  mkdirSync(stateDir, { recursive: true });
  const broken = join(stateDir, 'broken.json');
  writeFileSync(broken, '{ truncated');
  const { hub, calls } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_never', 'builder')]),
  });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1', cap: 1 }));

  await assert.rejects(
    loop.iterate(),
    (error: unknown) =>
      error instanceof ShiftStateRecordError
      && error.path === broken
      && error.message.includes('dispatch is disabled'),
  );
  assert.deepEqual(calls.map((call) => call.verb), ['presence']);
  assert.equal(spawns.length, 0);
});

test('two direct Shift loops sharing one state directory serialize capacity reservation', async () => {
  cacheBuilderStep();
  let arrivals = 0;
  let releaseBarrier: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const meetAtTargetedPoll = async (): Promise<void> => {
    arrivals += 1;
    if (arrivals === 2) releaseBarrier?.();
    await barrier;
  };
  const firstHub = mockHub({
    wake: [{ changed: true, cursor: 1 }, { changed: false, cursor: 1 }],
    perWf: agentWf([wo('run_direct_a', 'builder')]),
    onTargetedWhatsNext: meetAtTargetedPoll,
  });
  const secondHub = mockHub({
    wake: [{ changed: true, cursor: 1 }, { changed: false, cursor: 1 }],
    perWf: agentWf([wo('run_direct_b', 'builder')]),
    onTargetedWhatsNext: meetAtTargetedPoll,
  });
  const { spawner, spawns } = fakeSpawner();
  const firstOut: string[] = [];
  const secondOut: string[] = [];
  const firstLoop = createShiftLoop(baseOpts(firstHub.hub, spawner, {
    workflow: 'wf1',
    cap: 1,
    maxConcurrentAgents: 1,
    localQueueHoldMs: MAX_PENDING_CANDIDATE_AGE_MS,
    out: (line) => firstOut.push(line),
  }));
  const secondLoop = createShiftLoop(baseOpts(secondHub.hub, spawner, {
    workflow: 'wf1',
    cap: 1,
    maxConcurrentAgents: 1,
    localQueueHoldMs: MAX_PENDING_CANDIDATE_AGE_MS,
    out: (line) => secondOut.push(line),
  }));

  const results = await Promise.all([firstLoop.iterate(), secondLoop.iterate()]);

  assert.deepEqual([...results].sort(), [0, 1]);
  assert.equal(spawns.length, 1);
  const inFlight = [...readChildRecords(stateDir), ...readChildReservations(stateDir)];
  assert.equal(inFlight.length, 1, 'one durable slot carries capacity after the dispatch race');
  assert.match([...firstOut, ...secondOut].join('\n'), /lost a shared-capacity race/u);

  const losingIndex = results[0] === 0 ? 0 : 1;
  const losingLoop = losingIndex === 0 ? firstLoop : secondLoop;
  const losingRun = losingIndex === 0 ? 'run_direct_a' : 'run_direct_b';
  removeChildRecord(stateDir, inFlight[0]!.run);

  assert.equal(await losingLoop.iterate(), 1, 'the losing loop retained its already-claimed candidate locally');
  assert.deepEqual(spawns.map((spawn) => spawn.run), [inFlight[0]!.run, losingRun]);
  const losingHubCalls = losingIndex === 0 ? firstHub.calls : secondHub.calls;
  assert.equal(count(losingHubCalls, 'whats_next'), 1, 'retry used the local queue without another hub sweep');
});

test('a fresh same-run reservation consumes capacity and suppresses a hub re-offer', async () => {
  cacheBuilderStep();
  reserveChild(stateDir, {
    workflow: 'wf1',
    run: 'run_reserved_offer',
    reservedAt: 0,
    childKind: 'agent-run',
    step: 'builder',
  });
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_reserved_offer', 'builder'), wo('run_new_offer', 'builder')]),
  });
  const { spawner, spawns } = fakeSpawner();

  const dispatched = await createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 2,
    execReserve: 0,
  })).iterate();

  assert.equal(dispatched, 1);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_new_offer']);
  assert.deepEqual(readChildReservations(stateDir).map((reservation) => reservation.run), ['run_reserved_offer']);
});

test('an expired dispatch reservation is cancelled and reported before new work is polled', async () => {
  reserveChild(stateDir, {
    workflow: 'wf1',
    run: 'run_abandoned',
    reservedAt: 0,
    childKind: 'exec',
    step: 'cmd',
  });
  const { hub } = mockHub({ wake: [{ changed: false, cursor: 1 }] });
  const { spawner } = fakeSpawner();
  const err: string[] = [];

  await createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    now: () => 120_001,
    err: (line) => err.push(line),
  })).iterate();

  assert.equal(readChildReservations(stateDir).length, 0);
  assert.equal(readdirSync(stateDir).some((name) => name.endsWith('.gate')), false);
  assert.match(err.join('\n'), /abandoned exec dispatch reservation expired and was cancelled/u);
});

// Command orders keep their own lane: they spawn `exec` (kind absent on the spec,
// which `buildSpawnPlan` reads as 'exec') and write an `exec` record.
test('COMMAND orders stay on the exec lane', async () => {
  cacheCommandBundle();
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: cmdWf([wo('run_aaaa1111', 'cmd')]) });
  const { spawner, spawns } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' })).iterate();
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.kind, undefined);
  assert.equal(readChildRecords(stateDir)[0]!.kind, 'exec');
});

// Regression (caught by test/drill-runner-cap.test.ts): a runner is a PROCESS.
// Re-dispatching a run a live runner holds puts a second harness session on a
// single claim — two step agents briefed for the same order, racing to submit.
// The skip must be silent, NOT charged to the agent cap.
test('a run a live agent-run child holds is skipped silently, not via the cap path', async () => {
  cacheBuilderStep();
  writeChildRecord(stateDir, {
    workflow: 'wf1', run: 'run_deadbeef', pid: process.pid, spawnedAt: 0, kind: 'agent-run', step: 'builder',
  });
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: agentWf([wo('run_deadbeef', 'builder')]) });
  const { spawner, spawns } = fakeSpawner();
  const out: string[] = [];
  await createShiftLoop(
    baseOpts(hub, spawner, {
      workflow: 'wf1', cap: 10, maxConcurrentAgents: 9,
      isAlive: () => true, out: (l) => out.push(l),
    }),
  ).iterate();

  assert.equal(spawns.length, 0, 'the live runner keeps the order — no second child');
  assert.equal(/at the agent-run cap/.test(out.join('\n')), false);
});

// ---- PHASE 4: the reaper's composition point ---------------------------------
//
// `sweepWorkDirs` can only retire the sessions of a run it is removing if the
// shift hands it the store's path, and the ONE path that must arrive is
// `sessionsPath(cacheDir)` — the very file `owenloop work agent-run` writes, built by
// the same `resolveCacheDir`. Pointing this anywhere else re-opens the teardown
// hole silently: dirs still vanish, sessions stay `active`, the next firing
// resumes into an empty tree. So pin the wiring itself, not just the sweep.
test('the shift hands the reaper the session store at sessionsPath(cacheDir)', async () => {
  cacheBuilderStep();
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: agentWf([]) });
  const { spawner } = fakeSpawner();
  const workRoot = join(cacheDir, 'work');

  let captured: SweepOpts | undefined;
  await createShiftLoop(
    baseOpts(hub, spawner, {
      workflow: 'wf1',
      workRoot,
      sweepWorkDirs: (o: SweepOpts) => {
        captured = o;
        return [];
      },
    }),
  ).iterate();

  assert.ok(captured !== undefined, 'a sweeping tick must run the reaper');
  assert.equal(captured.sessionsFile, sessionsPath(cacheDir));
  assert.equal(captured.workRoot, workRoot);
});

// ---- the per-step failure brake ---------------------------------------------
//
// Regression cover for the storm observed 2026-08-12: a step that refuses its
// order and exits WITHOUT submitting is re-offered by the hub under a FRESH run
// id every time, so every run-keyed guard in this file (liveRuns, workerRuns,
// claimed, pendingCandidates) misses and the shift respawns without bound.
//
// The brake keys on (workflow, step, key) — the identity that repeats — and
// counts WORKER FAILURES, not dispatches. The distinction is the whole design:
// one sweep can legitimately offer several distinct runs of one step, and
// counting dispatches would meter that healthy concurrency. See the
// 'concurrent runs of one step are never braked' case below, which fails
// against a dispatch-counting brake.

/**
 * Drive repeated sweeps of one step, each under a brand-new run id, with a
 * controllable clock. `fail(run)` reports that run's child exited non-zero,
 * exactly as the shift runtime's `reportWorkerFailure` does in production.
 */
function stormLoop(
  runs: string[],
  monotonic: () => number,
  step = 'cmd',
  wake?: WakeStep[],
): {
  loop: ShiftLoop;
  spawns: SpawnSpec[];
  errs: string[];
  calls: Call[];
  next: () => void;
  fail: (run: string) => void;
} {
  cacheCommandBundle();
  let i = 0;
  const orders = [wo(runs[0]!, step)];
  const { hub, calls } = mockHub({ perWf: cmdWf(orders), ...(wake !== undefined ? { wake } : {}) });
  const { spawner, spawns } = fakeSpawner();
  const errs: string[] = [];
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    monotonicNow: monotonic,
    // Children never survive the next reconcile, so local capacity is always
    // free — the brake, not capacity, is what this exercises.
    isAlive: () => false,
    err: (line) => errs.push(line),
  }));
  const next = (): void => {
    i += 1;
    orders[0] = wo(runs[i]!, step);
  };
  // A WHOLE failure record, which is what the runtime actually hands over. The
  // old `{ run }` shorthand let these cases drift from production: the loop now
  // also releases the dead worker's claim, and a shorthand record would have
  // hidden that this path has a hub effect at all.
  const fail = (run: string): void => {
    loop.noteWorkerFailure({
      workflow: 'wf1',
      run,
      step,
      kind: 'exec',
      executable: '/usr/bin/node /bin/owenloop.mjs',
      exitStatus: 1,
      signal: null,
      message: 'worker exited without completing successfully',
    });
  };
  return { loop, spawns, errs, calls, next, fail };
}

test('every brake delay remains inside the hub pickup window', () => {
  assert.ok(Math.max(...STEP_BRAKE_DELAYS_MS) < HUB_PICKUP_WINDOW_MS);
});

test('a step whose worker keeps failing is braked instead of respawned forever', async () => {
  let monotonic = 0;
  const runs = ['run_storm01', 'run_storm02', 'run_storm03'];
  const { loop, spawns, errs, next, fail } = stormLoop(runs, () => monotonic);

  // The first dispatch is free — nothing has failed yet.
  await loop.iterate();
  assert.deepEqual(spawns.map((s) => s.run), ['run_storm01']);

  // Its child exits non-zero. That first failure arms the 2s window.
  fail('run_storm01');
  next();
  await loop.iterate();
  assert.deepEqual(
    spawns.map((s) => s.run),
    ['run_storm01'],
    'a fresh run id of a just-failed step must not respawn immediately',
  );
  assert.ok(
    errs.some((line) => line.includes("step 'cmd' has failed") && line.includes('braking')),
    `a braked dispatch must say so; got ${JSON.stringify(errs)}`,
  );

  // ...and it is a rate limit, not a ban: past the window the step runs again.
  monotonic = 2_000;
  next();
  await loop.iterate();
  assert.deepEqual(spawns.map((s) => s.run), ['run_storm01', 'run_storm03']);
});

test('consecutive failures lengthen the window; the delay is not flat', async () => {
  let monotonic = 0;
  const runs = ['run_b1', 'run_b2', 'run_b3', 'run_b4'];
  const { loop, spawns, next, fail } = stormLoop(runs, () => monotonic);

  await loop.iterate();                              // run_b1 spawns
  fail('run_b1');         // failure 1 → 2s window

  monotonic = 2_000;
  next();
  await loop.iterate();                              // run_b2 spawns
  fail('run_b2');         // failure 2 → 8s window

  // 2s past the second failure would have been enough after the FIRST one.
  monotonic = 4_000;
  next();
  await loop.iterate();
  assert.deepEqual(
    spawns.map((s) => s.run),
    ['run_b1', 'run_b2'],
    'the second failure must arm a longer window than the first',
  );

  monotonic = 10_000; // 8s past failure 2
  next();
  await loop.iterate();
  assert.deepEqual(spawns.map((s) => s.run), ['run_b1', 'run_b2', 'run_b4']);
});

test('concurrent runs of one step are never braked — only failures count', async () => {
  // The case a dispatch-counting brake gets wrong. Five distinct runs of ONE
  // step, same empty key, offered in a SINGLE sweep, none of which has failed:
  // this is legitimate concurrency and every one must spawn up to the cap.
  cacheCommandBundle();
  const orders = ['run_1', 'run_2', 'run_3', 'run_4', 'run_5'].map((r) => wo(r, 'cmd'));
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: cmdWf(orders) });
  const { spawner, spawns } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    workflow: 'wf1',
    cap: 5,
    monotonicNow: () => 0,
  })).run();
  assert.equal(spawns.length, 5, 'no failure has been reported, so nothing may be braked');
});

test('a braked candidate is not queued for local dispatch', async () => {
  const monotonic = 0;
  const runs = ['run_q01', 'run_q02'];
  const { loop, spawns, calls, next, fail } = stormLoop(runs, () => monotonic);

  await loop.iterate();
  fail('run_q01');
  next();
  await loop.iterate(); // braked

  // A braked candidate that had been queued would be re-dispatched by the very
  // next drain, with no window elapsed — which would defeat the brake entirely.
  await loop.iterate();
  assert.deepEqual(spawns.map((s) => s.run), ['run_q01']);

  // Exactly ONE release: the dead worker's own, handed back at the moment of
  // failure. This assertion used to read `0`, with the comment "the brake
  // deliberately leaves claims to lapse" — that lapse is the defect. A claim
  // left held sits INFLIGHT on the hub with a frozen heartbeat, so the order is
  // neither running nor re-offerable and nothing distinguishes it from work in
  // progress; measured once at 34 minutes before an operator released it by
  // hand.
  //
  // The count matters as much as the fact, and the reason it stays at one is
  // NOT that the brake runs before the claim — it does not. `whats_next` claims
  // first and the brake check sits inside `dispatchCandidate`, which is why its
  // own log line says it is "leaving this claim to lapse". A braked candidate
  // therefore still costs a claim; it just never reaches a spawn.
  //
  // That is what bounds this: a release is only ever emitted downstream of a
  // spawn or a failed spawn attempt, and both are gated by the brake ladder
  // (2s, 8s, 30s, 60s, 90s). So there is no claim-fail-release hot loop — two
  // further drains follow this release and neither adds another.
  //
  // What does rise is re-claiming. A released order is re-offered immediately
  // instead of lapsing after the hub's 120s reap, so a braked shift can pick it
  // up and idle on it once per sweep until the window expires. That is a real
  // cost against the org Durable Object, taken deliberately: the alternative is
  // the order staying invisible for the whole reap window.
  assert.equal(count(calls, 'release'), 1, 'the dead worker hands its claim back, once');
});

test('a brake expiry sweeps again even when wake reports no change', async () => {
  let monotonic = 0;
  const { loop, spawns, calls, next, fail } = stormLoop(
    ['run_alarm_a', 'run_alarm_b'],
    () => monotonic,
    'cmd',
    [
      { changed: true, cursor: 1 },
      { changed: true, cursor: 2 },
      { changed: false, cursor: 2 },
    ],
  );

  await loop.iterate();
  fail('run_alarm_a');
  next();
  await loop.iterate(); // run_alarm_b is braked and arms the 2s re-sweep.
  assert.deepEqual(spawns.map((spec) => spec.run), ['run_alarm_a']);
  assert.equal(count(calls, 'whats_next'), 2);

  await loop.iterate();
  assert.equal(count(calls, 'whats_next'), 2, 'an unchanged wake must not sweep before the brake expires');
  assert.deepEqual(spawns.map((spec) => spec.run), ['run_alarm_a']);

  monotonic = 2_000;
  await loop.iterate();
  assert.equal(count(calls, 'whats_next'), 3, 'the due brake triggers its own sweep');
  assert.deepEqual(spawns.map((spec) => spec.run), ['run_alarm_a', 'run_alarm_b']);
});

test('a run that ends clears its step’s failure streak', async () => {
  let monotonic = 0;
  const runs = ['run_e1', 'run_e2', 'run_e3'];
  const { loop, spawns, next, fail } = stormLoop(runs, () => monotonic);

  await loop.iterate();
  fail('run_e1'); // 2s window armed

  monotonic = 2_000;
  next();
  await loop.iterate();                       // run_e2 spawns
  loop.noteRunEnded('run_e2');                // it PROGRESSED — streak cleared

  // With the streak cleared, a later failure starts again at the SHORTEST
  // delay rather than inheriting the earlier count.
  next();
  await loop.iterate();
  assert.deepEqual(spawns.map((s) => s.run), ['run_e1', 'run_e2', 'run_e3']);
});

test('fanned-out keys of one step do not brake each other', async () => {
  cacheCommandBundle();
  const keyed = (run: string, key: string): WorkOrder => ({ ...wo(run, 'cmd'), key });
  const orders = [keyed('run_k1', 'alpha'), keyed('run_k2', 'beta'), keyed('run_k3', 'gamma')];
  const { hub } = mockHub({ perWf: cmdWf(orders) });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    cap: 10,
    monotonicNow: () => 0,
    isAlive: () => false,
  }));

  await loop.iterate();
  // 'alpha' fails; 'beta' and 'gamma' are unrelated orders of the same step.
  // This case builds its own loop rather than using `stormLoop`, because the
  // fan-out keys are the point — so it reports the failure directly.
  loop.noteWorkerFailure({
    workflow: 'wf1',
    run: 'run_k1',
    step: 'cmd',
    kind: 'exec',
    executable: '/usr/bin/node /bin/owenloop.mjs',
    exitStatus: 1,
    signal: null,
    message: 'worker exited without completing successfully',
  });
  await loop.iterate();

  // Keying the brake on the step alone would have braked beta and gamma too.
  assert.deepEqual(
    spawns.map((s) => s.run).slice(0, 3).sort(),
    ['run_k1', 'run_k2', 'run_k3'],
  );
});

test('a dead worker hands its claim back naming the failure', async () => {
  const { loop, calls, fail } = stormLoop(['run_r01'], () => 0);

  await loop.iterate();
  fail('run_r01');

  const releases = calls.filter((call) => call.verb === 'release').map((call) => call.arg);
  assert.deepEqual(releases, [{
    workflow: 'wf1',
    run: 'run_r01',
    // The reason is what makes the release worth anything to an operator, and
    // it names the supervisor because the supervisor is who is speaking. A
    // worker that fails through its own error path sends a more specific reason
    // first and the hub keeps that one; this account is what an operator gets
    // when no such reason ever arrived, which is the case worth fixing.
    //
    // `message` is the spawner's own bounded lifecycle string, never worker
    // output: agent-run stderr is untrusted and is deliberately never quoted
    // back. The exit status is the half that separates "this step is broken"
    // from "this host is broken", so it travels with the message.
    reason: 'shift supervisor: exec worker exited without completing successfully (exitStatus 1)',
  }]);
});

test('a spawn that never starts hands its claim back and charges the brake', async () => {
  // The other half of the same hole, and the arm that matters most. The claim
  // is taken by `whats_next` BEFORE any spawn is attempted, so a spawn that
  // throws strands it exactly as a dead worker does — except no `WorkerFailure`
  // is ever reported for a child that never existed, so the failure path above
  // cannot cover this one. `spawn.ts` names what lands here: EMFILE from too
  // many concurrent children, ENOMEM from a host out of memory. That is
  // precisely when an order most needs to reach a shift that can still fork.
  cacheCommandBundle();
  const orders = [wo('run_x01', 'cmd')];
  const { hub, calls } = mockHub({ perWf: cmdWf(orders) });
  const spawner: Spawner = () => {
    throw new Error('ENOMEM: fork failed');
  };
  const errs: string[] = [];
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    monotonicNow: () => 0,
    isAlive: () => false,
    err: (line) => errs.push(line),
  }));

  await loop.iterate();

  assert.deepEqual(
    calls.filter((call) => call.verb === 'release').map((call) => call.arg),
    [{
      workflow: 'wf1',
      run: 'run_x01',
      // `spawn` is the command prefix; an agent-run reads 'agent-run spawn'.
      // The spawner's own message travels with it because the difference
      // between EMFILE and a missing executable is the difference between
      // "wait" and "this shift is misconfigured".
      reason: 'shift supervisor: spawn failed — ENOMEM: fork failed',
    }],
  );

  // Charging the brake is not decoration here, it is what keeps the release
  // safe. A released claim is re-offered at once instead of lapsing after the
  // hub's pickup window, so on a host that cannot fork at all the brake is the
  // only thing standing between this shift and a claim-fail-release loop.
  orders[0] = wo('run_x02', 'cmd');
  await loop.iterate();
  assert.ok(
    errs.some((line) => line.includes("step 'cmd' has failed") && line.includes('braking')),
    `a spawn failure must arm the brake; got ${JSON.stringify(errs)}`,
  );
  assert.equal(
    count(calls, 'release'),
    1,
    'the braked sweep leaves its claim to lapse, so it adds no second release',
  );
});

test('a dispatch that aborts a started child says so instead of blaming the spawn', async () => {
  // The catch covers two different failures and an operator has to be able to
  // tell them apart. This is the arm where the spawn SUCCEEDED and something
  // after it threw — and it is not hypothetical: `out` is wired to
  // `process.stdout.write`, which on a detached daemon writing to a log file is
  // synchronous and throws on ENOSPC. That is the exact host condition that
  // produced the stall this whole change exists to end, so the release reason
  // must not send an operator hunting a fork failure that never happened.
  cacheCommandBundle();
  const orders = [wo('run_y01', 'cmd')];
  const { hub, calls } = mockHub({ perWf: cmdWf(orders) });
  let killed = 0;
  const spawner: Spawner = () => ({ pid: 4242, cancel: () => { killed += 1; } });
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    monotonicNow: () => 0,
    isAlive: () => false,
    out: () => { throw new Error('ENOSPC: no space left on device, write'); },
  }));

  await loop.iterate();

  // The child really was running, so the release is only honest if it was also
  // killed. Exactly once: a double kill would mean the catch and the reservation
  // cleanup are both terminating it.
  assert.equal(killed, 1, 'an aborted dispatch must kill the child it started');
  assert.deepEqual(
    calls.filter((call) => call.verb === 'release').map((call) => call.arg),
    [{
      workflow: 'wf1',
      run: 'run_y01',
      reason: 'shift supervisor: spawn started then aborted — ENOSPC: no space left on device, write',
    }],
  );
});

test('an unbounded dispatch error is clamped before it reaches the hub', async () => {
  // The dispatch catch interpolates the raw error message, and that message is
  // NOT bounded: `acquireDispatchLock` throws a `FileLockTimeoutError` carrying
  // a filesystem path, and a path is bounded only by PATH_MAX. The hub truncates
  // at the same limit anyway, so the reason for clamping here is that the reason
  // we SEND is then the reason an operator reads, with no silent server-side
  // shortening in between.
  cacheCommandBundle();
  const { hub, calls } = mockHub({ perWf: cmdWf([wo('run_w01', 'cmd')]) });
  const spawner: Spawner = () => {
    throw new Error('x'.repeat(4096));
  };
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    monotonicNow: () => 0,
    isAlive: () => false,
  }));

  await loop.iterate();

  const release = calls.find((call) => call.verb === 'release')?.arg as { reason: string };
  // Count code points, not UTF-16 units: a clamp that sliced by unit could halve
  // a surrogate pair and put a lone surrogate on the wire.
  assert.equal(Array.from(release.reason).length, MAX_RELEASE_REASON_POINTS);
  assert.ok(release.reason.startsWith('shift supervisor: spawn failed — xxx'));
});

test('a worker failure for a run this shift never dispatched releases nothing', () => {
  // `noteWorkerFailure` is driven by a child `exit` event, and a shift only
  // learns about children it started. Reaching it with an unknown run means the
  // bookkeeping is already wrong, and the wrong thing to do is guess: releasing
  // a claim this shift does not hold would hand back another shift's live work.
  // The guard that prevents that is otherwise untested — deleting it leaves the
  // whole suite green.
  cacheCommandBundle();
  const { hub, calls } = mockHub({ perWf: cmdWf([wo('run_z01', 'cmd')]) });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    monotonicNow: () => 0,
    isAlive: () => false,
  }));

  loop.noteWorkerFailure({
    workflow: 'wf1',
    run: 'run_never_dispatched',
    step: 'cmd',
    kind: 'exec',
    executable: '/usr/bin/node /bin/owenloop.mjs',
    exitStatus: 1,
    signal: null,
    message: 'worker exited without completing successfully',
  });

  assert.equal(count(calls, 'release'), 0);
});

test('a step that goes long enough without failing starts its next brake from the shortest delay', async () => {
  // The streak is reset two ways: by a run that ends cleanly, and — here — by
  // simply not failing for long enough. Without the decay, a step that fails
  // once a day climbs to the longest delay and stays there on the strength of
  // failures nobody remembers.
  //
  // Read through spawns rather than log lines, exactly as the ladder test above
  // does: 2s past the second failure is enough only if that failure was treated
  // as the FIRST of a new streak. If the streak had carried over, the second
  // failure would arm 8s and nothing would spawn here.
  let monotonic = 0;
  const { loop, spawns, next, fail } = stormLoop(['run_d1', 'run_d2', 'run_d3'], () => monotonic);

  await loop.iterate();                                  // run_d1 spawns
  fail('run_d1');                                        // failure 1 → 2s window

  // Past the decay window, so failure 1 is forgotten — but well inside
  // STEP_BRAKE_FORGET_MS, so the row itself still exists. The reset has to come
  // from the decay check, not from the sweep having pruned the entry.
  monotonic = STEP_BRAKE_DECAY_MS + 1_000;
  next();
  await loop.iterate();                                  // run_d2 spawns
  fail('run_d2');

  monotonic += STEP_BRAKE_DELAYS_MS[0]!;
  next();
  await loop.iterate();
  assert.deepEqual(
    spawns.map((s) => s.run),
    ['run_d1', 'run_d2', 'run_d3'],
    'a failure long after the previous one must start the ladder over, not extend it',
  );
});

// ── issue #300: a hung hub call must not hang the shift silently ─────────────

type ShiftEventRecord = import('../src/shift/protocol.ts').ShiftEvent;
type WakeResponse = Awaited<ReturnType<HubClient['wake']>>;

/** Yield to the event loop until `cond` holds (bounded, so a wrong test fails instead of hanging). */
async function settle(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`never settled: ${what}`);
}

/** A `schedule` seam that hands the timer callbacks to the test instead of a clock. */
function fakeSchedule(): {
  schedule: NonNullable<ShiftLoopOptions['schedule']>;
  timers: Array<{ fn: () => void; everyMs: number; cancelled: boolean }>;
} {
  const timers: Array<{ fn: () => void; everyMs: number; cancelled: boolean }> = [];
  return {
    timers,
    schedule: (fn, everyMs) => {
      const entry = { fn, everyMs, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
}

test('#300: a wake that never settles is cut short by hubCallTimeoutMs and counted like any other failure', async () => {
  // The incident: the loop awaited one hub call for hours. The fake below never
  // resolves AND ignores the abort signal, which is the worst case the deadline
  // has to cover (a transport that honours the signal only makes it easier).
  const { hub } = mockHub({});
  const hanging: HubClient = { ...hub, wake: () => new Promise<WakeResponse>(() => {}) };
  const { spawner } = fakeSpawner();
  const errs: string[] = [];
  const events: ShiftEventRecord[] = [];
  let preflights = 0;
  const loop = createShiftLoop(baseOpts(hanging, spawner, {
    hubCallTimeoutMs: 20,
    err: (line) => errs.push(line),
    onEvent: (event) => events.push(event),
    hostPreflight: () => {
      preflights += 1;
      return [];
    },
  }));

  await loop.iterate();
  assert.equal(loop.getCyclesCompleted(), 1, 'the tick completed instead of hanging');
  assert.match(errs.join('\n'), /^wake failed: wake timed out after 20ms \(retrying next tick\)$/mu);
  assert.deepEqual(
    events.filter((event) => event.type === 'hub-error').map(({ ts: _ts, shift: _shift, shiftId: _id, ...body }) => body),
    [{ type: 'hub-error', op: 'wake', message: 'wake timed out after 20ms' }],
    'a timeout is recorded on the SAME terms as any other failed wake',
  );

  // #305's preflight runs on every HOST_PREFLIGHT_STREAK-th (3rd) NON-rate-limited
  // failure. A timeout is not a 429, so three of them must reach it — the
  // proof that the streak advanced exactly as three connection resets would.
  assert.equal(preflights, 0);
  await loop.iterate();
  await loop.iterate();
  assert.equal(preflights, 1, 'three consecutive timeouts advance hubFailureStreak to the preflight');
  assert.equal(loop.getCyclesCompleted(), 3);
});

test('#300: the deadline covers whats_next and presence_ping too, and each failure keeps its own report', async () => {
  const { hub } = mockHub({});
  const { spawner } = fakeSpawner();
  const errs: string[] = [];
  const events: ShiftEventRecord[] = [];

  // Inbox `whats_next` hangs: the sweep is abandoned on the usual terms.
  const hangingInbox: HubClient = { ...hub, whatsNext: () => new Promise<never>(() => {}) };
  const inboxLoop = createShiftLoop(baseOpts(hangingInbox, spawner, {
    hubCallTimeoutMs: 20,
    err: (line) => errs.push(line),
    onEvent: (event) => events.push(event),
  }));
  await inboxLoop.iterate();
  assert.match(errs.join('\n'), /^inbox whats_next failed: inbox whats_next timed out after 20ms$/mu);
  assert.deepEqual(
    events.filter((event) => event.type === 'hub-error').map((event) => [event.op, event.message]),
    [['whats_next', 'inbox whats_next timed out after 20ms']],
  );

  // Presence hangs: logged and continued, exactly as a thrown ping is today.
  errs.length = 0;
  const hangingPresence: HubClient = { ...hub, presencePing: () => new Promise<never>(() => {}) };
  const presenceLoop = createShiftLoop(baseOpts(hangingPresence, spawner, {
    hubCallTimeoutMs: 20,
    err: (line) => errs.push(line),
  }));
  await presenceLoop.iterate();
  assert.match(errs.join('\n'), /^presence ping failed: presence ping timed out after 20ms \(continuing\)$/mu);
  assert.equal(presenceLoop.getCyclesCompleted(), 1);
});

test('#300: cycles_completed and last_poll_at move only when a cycle actually completes', async () => {
  const { hub } = mockHub({});
  const { spawner } = fakeSpawner();
  let now = 1_000;
  const loop = createShiftLoop(baseOpts(hub, spawner, { now: () => now }));

  assert.equal(loop.getCyclesCompleted(), 0);
  assert.equal(loop.getLastPollAt(), undefined, 'nothing has completed yet, and status must say so (null), not 0');

  await loop.iterate();
  assert.equal(loop.getCyclesCompleted(), 1);
  assert.equal(loop.getLastPollAt(), 1_000);

  now = 2_000;
  await loop.iterate();
  assert.equal(loop.getCyclesCompleted(), 2);
  assert.equal(loop.getLastPollAt(), 2_000);
});

test('#300: the watchdog reports `stalled` once per episode, from a timer the hung loop cannot block', async () => {
  const { hub } = mockHub({});
  const wakes: Array<(w: WakeResponse) => void> = [];
  const hanging: HubClient = {
    ...hub,
    wake: () => new Promise<WakeResponse>((resolve) => {
      wakes.push(resolve);
    }),
  };
  const { spawner } = fakeSpawner();
  const { schedule, timers } = fakeSchedule();
  let monotonic = 0;
  const errs: string[] = [];
  const events: ShiftEventRecord[] = [];
  const stalled = (): Array<{ lastPollAt: number | null; sinceMs: number }> =>
    events.flatMap((event) => (event.type === 'stalled' ? [{ lastPollAt: event.lastPollAt, sinceMs: event.sinceMs }] : []));
  const loop = createShiftLoop(baseOpts(hanging, spawner, {
    now: () => 500_000 + monotonic,
    monotonicNow: () => monotonic,
    pollIntervalMs: 5_000,
    // The real deadline is far longer than this test, which resolves every
    // wake by hand; the threshold below is 3 × 5 000 + 30 000 = 45 000.
    hubCallTimeoutMs: 30_000,
    heartbeatIntervalMs: 0,
    schedule,
    err: (line) => errs.push(line),
    onEvent: (event) => events.push(event),
  }));

  const running = loop.run();
  try {
    await settle(() => wakes.length === 1, 'first wake in flight');
    assert.equal(timers.length, 1, 'heartbeat disabled, so the watchdog is the only timer');
    const watchdog = timers[0]!;
    assert.equal(watchdog.everyMs, 5_000, 'the watchdog checks once per poll interval');

    // Just under the threshold: healthy, even though no cycle has EVER completed.
    monotonic = 44_999;
    watchdog.fn();
    assert.deepEqual(stalled(), []);

    // Over it: one record, measured from the start of `run`, with no cycle to name.
    monotonic = 45_000;
    watchdog.fn();
    assert.deepEqual(stalled(), [{ lastPollAt: null, sinceMs: 45_000 }]);
    assert.match(
      errs.join('\n'),
      /^poll loop stalled: no progress for 45000ms \(threshold 45000ms; last completed cycle never\)$/mu,
    );

    // Still stalled: EDGE-triggered, so no second record for the same episode.
    monotonic = 90_000;
    watchdog.fn();
    assert.equal(stalled().length, 1, 'one record per stall episode');

    // Recovery: the hung call finally answers, the cycle completes, and the
    // loop parks the next wake. The completed cycle re-arms the watchdog.
    wakes[0]!({ text: '', cursor: 1, changed: false });
    await settle(() => wakes.length === 2, 'second wake in flight');
    assert.equal(loop.getCyclesCompleted(), 1);
    assert.equal(loop.getLastPollAt(), 590_000);
    watchdog.fn();
    assert.equal(stalled().length, 1, 'a fresh cycle is not a stall');

    // A NEW episode, measured from that completed cycle, gets its own record.
    monotonic = 90_000 + 45_000;
    watchdog.fn();
    assert.deepEqual(stalled(), [
      { lastPollAt: null, sinceMs: 45_000 },
      { lastPollAt: 590_000, sinceMs: 45_000 },
    ]);
  } finally {
    loop.stop();
    for (const resolve of wakes) resolve({ text: '', cursor: 1, changed: false });
  }
  assert.equal(await running, 0);
  assert.equal(timers.every((timer) => timer.cancelled), true, 'stop() clears the watchdog');
});

test('#300: a hub-instructed Retry-After pause is not a stall', async () => {
  // The loop sleeps out a 429's Retry-After on the hub's own instruction. The
  // watchdog measures from the END of that pause, so an honest 100s backoff
  // produces no `stalled`, but a loop that then fails to wake up does.
  const { hub } = mockHub({
    presence: [{ error: new HubError(429, 'slow down', 'rate_limited', 100_000) }],
  });
  const { spawner } = fakeSpawner();
  const { schedule, timers } = fakeSchedule();
  let monotonic = 0;
  let releaseSleep: (() => void) | undefined;
  const events: ShiftEventRecord[] = [];
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    monotonicNow: () => monotonic,
    pollIntervalMs: 5_000,
    hubCallTimeoutMs: 30_000,
    heartbeatIntervalMs: 0,
    schedule,
    sleep: () => new Promise<void>((resolve) => {
      releaseSleep = resolve;
    }),
    onEvent: (event) => events.push(event),
  }));

  const running = loop.run();
  try {
    await settle(() => releaseSleep !== undefined, 'loop parked in its backoff sleep');
    const watchdog = timers[0]!;
    monotonic = 45_000;
    watchdog.fn();
    assert.deepEqual(events.filter((event) => event.type === 'stalled'), [], 'inside the backoff: healthy');
    monotonic = 100_000 + 45_000;
    watchdog.fn();
    assert.equal(events.filter((event) => event.type === 'stalled').length, 1, 'past the backoff with no cycle: stalled');
  } finally {
    loop.stop();
    releaseSleep?.();
  }
  assert.equal(await running, 0);
});

test('#300: a long cycle of many settled calls is not a stall; one call that never settles is', async () => {
  // A cycle serialises wake, the inbox, one targeted whats_next per workflow,
  // and more. Against a slow-but-alive hub those can sum past the threshold
  // while each one answers. The watchdog must measure from the last SETTLED
  // call, not the last completed cycle, or it reports every such sweep.
  const { hub } = mockHub({});
  type InboxResponse = Awaited<ReturnType<HubClient['whatsNext']>>;
  const wakes: Array<(w: WakeResponse) => void> = [];
  const inboxes: Array<(r: InboxResponse) => void> = [];
  const slow: HubClient = {
    ...hub,
    wake: () => new Promise<WakeResponse>((resolve) => {
      wakes.push(resolve);
    }),
    whatsNext: () => new Promise<InboxResponse>((resolve) => {
      inboxes.push(resolve);
    }),
  };
  const { spawner } = fakeSpawner();
  const { schedule, timers } = fakeSchedule();
  let monotonic = 0;
  const events: ShiftEventRecord[] = [];
  const stalled = (): Array<{ lastPollAt: number | null; sinceMs: number }> =>
    events.flatMap((event) => (event.type === 'stalled' ? [{ lastPollAt: event.lastPollAt, sinceMs: event.sinceMs }] : []));
  const loop = createShiftLoop(baseOpts(slow, spawner, {
    now: () => 500_000 + monotonic,
    monotonicNow: () => monotonic,
    pollIntervalMs: 5_000,
    hubCallTimeoutMs: 30_000, // threshold 3 × 5 000 + 30 000 = 45 000
    heartbeatIntervalMs: 0,
    schedule,
    err: () => {},
    onEvent: (event) => events.push(event),
  }));

  const running = loop.run();
  try {
    await settle(() => wakes.length === 1, 'first wake in flight');
    const watchdog = timers[0]!;

    // Wake answers after 30 s (under the deadline) with news, so the cycle
    // goes on to the inbox — which is now the call in flight.
    monotonic = 30_000;
    wakes[0]!({ text: '', cursor: 1, changed: true });
    await settle(() => inboxes.length === 1, 'inbox whats_next in flight');

    // 60 s since `run` started and no cycle has completed, but the last call
    // settled 30 s ago: the loop is slow, not hung. Measured from the cycle
    // alone this would already be a (false) stall.
    monotonic = 60_000;
    watchdog.fn();
    assert.deepEqual(stalled(), [], 'a cycle of settled calls summing past the threshold is not a stall');
    assert.equal(loop.getCyclesCompleted(), 0, 'and that verdict did not need a completed cycle');

    // The inbox answers too; the cycle completes and the next wake parks.
    inboxes[0]!({ text: '', instances: [] });
    await settle(() => wakes.length === 2, 'second wake in flight');
    assert.equal(loop.getCyclesCompleted(), 1);

    // Now ONE call that never settles: nothing moves the reference, so the
    // threshold after the last progress (the completed cycle at 60 s) trips.
    monotonic = 60_000 + 44_999;
    watchdog.fn();
    assert.deepEqual(stalled(), []);
    monotonic = 60_000 + 45_000;
    watchdog.fn();
    assert.deepEqual(stalled(), [{ lastPollAt: 560_000, sinceMs: 45_000 }]);
  } finally {
    loop.stop();
    for (const resolve of wakes) resolve({ text: '', cursor: 1, changed: false });
    for (const resolve of inboxes) resolve({ text: '', instances: [] });
  }
  assert.equal(await running, 0);
});

test('#300: the heartbeat fires on its own cadence, never under `once`, and is file-only', async () => {
  const { hub } = mockHub({});
  const { spawner } = fakeSpawner();

  // `once` runs one cycle and returns: nothing to watch, so no timers at all.
  const onceTimers = fakeSchedule();
  const onceLoop = createShiftLoop(baseOpts(hub, spawner, { once: true, schedule: onceTimers.schedule }));
  assert.equal(await onceLoop.run(), 0);
  assert.deepEqual(onceTimers.timers, [], '`once` mode starts neither watchdog nor heartbeat');

  // Daemon mode: the heartbeat is the second timer, on the default five-minute cadence.
  const wakes: Array<(w: WakeResponse) => void> = [];
  const hanging: HubClient = {
    ...hub,
    wake: () => new Promise<WakeResponse>((resolve) => {
      wakes.push(resolve);
    }),
  };
  const { schedule, timers } = fakeSchedule();
  const events: ShiftEventRecord[] = [];
  let now = 7_000;
  const loop = createShiftLoop(baseOpts(hanging, spawner, {
    now: () => now,
    hubCallTimeoutMs: 30_000,
    schedule,
    onEvent: (event) => events.push(event),
  }));
  const running = loop.run();
  try {
    await settle(() => wakes.length === 1, 'first wake in flight');
    assert.deepEqual(timers.map((timer) => timer.everyMs), [5_000, 5 * 60_000], 'watchdog, then heartbeat at 5 minutes');
    const heartbeat = timers[1]!;
    const beats = (): unknown[] =>
      events.filter((event) => event.type === 'heartbeat').map(({ ts: _ts, shift: _shift, shiftId: _id, ...body }) => body);

    // Before any cycle completes the record still says so: this is what makes a
    // silent daemon readable — a heartbeat with a frozen count IS the diagnosis.
    heartbeat.fn();
    assert.deepEqual(beats(), [
      { type: 'heartbeat', cyclesCompleted: 0, lastPollAt: null, hubFailureStreak: 0, stalled: false },
    ]);

    wakes[0]!({ text: '', cursor: 1, changed: false });
    await settle(() => wakes.length === 2, 'second wake in flight');
    // The clock moves only after the first cycle completed, so the heartbeat's
    // lastPollAt is the completion time (7_000), not the current time.
    now = 8_000;
    heartbeat.fn();
    assert.deepEqual(beats(), [
      { type: 'heartbeat', cyclesCompleted: 0, lastPollAt: null, hubFailureStreak: 0, stalled: false },
      { type: 'heartbeat', cyclesCompleted: 1, lastPollAt: 7_000, hubFailureStreak: 0, stalled: false },
    ]);
  } finally {
    loop.stop();
    for (const resolve of wakes) resolve({ text: '', cursor: 1, changed: false });
  }
  assert.equal(await running, 0);
  assert.equal(timers.every((timer) => timer.cancelled), true, 'stop() clears both timers');

  // FILE-ONLY: proof of life must not wake a parked `owenloop shift next`; the
  // watchdog's `stalled` is the record that does.
  assert.equal(reachesSocketConsumer('heartbeat'), false);
  assert.equal(reachesSocketConsumer('stalled'), true);
});
