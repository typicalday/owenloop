import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { createShiftLoop, MAX_PENDING_CANDIDATE_AGE_MS, type ShiftLoop, type ShiftLoopOptions } from '../src/shift/loop.ts';
import { buildSpawnPlan, createDefaultSpawner, safeWorkerDiagnostic, type SpawnSpec, type Spawner } from '../src/shift/spawn.ts';
import { readChildRecords, readChildReservations, reserveChild, writeChildRecord } from '../src/shift/state.ts';
import { sessionsPath } from '../src/harness/session-store.ts';
import { readStepSpec, writeBundle } from '../src/bundle/cache.ts';
import type { CachedBundle } from '../src/bundle/types.ts';
import type { NormalizedStepSpec } from '../src/bundle/types.ts';
import { ORDER_TOKEN, ORIGIN_TOKEN } from '../src/agent/brief.ts';
import { installSignalHandlers, type SignalHost } from '../src/roles/signals.ts';
import type { HubClient } from '../src/hub/client.ts';
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
  perWf?: Record<string, { def?: string; orders: WorkOrder[] }>;
  perWfThrows?: Record<string, Error>;
  onTargetedWhatsNext?: () => void;
  presenceThrows?: boolean;
  presence?: Array<{ error?: Error }>;
}

function mockHub(cfg: MockCfg): { hub: HubClient; calls: Call[] } {
  const calls: Call[] = [];
  let wakeIdx = 0;
  let presenceIdx = 0;
  const hub: HubClient = {
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
        const instances: InboxInstance[] = (cfg.inbox ?? []).map((w) => ({
          workflow: w,
          def: 'demo',
          done: false,
          eligible: 1,
          blocked: 0,
          owedSeededInputs: [],
        }));
        return { text: '', instances };
      }
      cfg.onTargetedWhatsNext?.();
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
    async release() {
      return { text: '' };
    },
    async submit(req) {
      calls.push({ verb: 'submit', arg: req });
      return { text: '' };
    },
    async reject() { return { text: '', ok: true }; },
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

test('whats_next carries serve_crews: default [] reaches the per-instance wire arg', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { orders: [] } } });
  const { spawner } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1', serveCrews: [] })).run();
  assert.deepEqual(perWfWhatsNext(calls), { workflow: 'wf1', serve_crews: [] });
});

test('whats_next carries serve_crews: a narrowed subset reaches the per-instance wire arg', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { orders: [] } } });
  const { spawner } = fakeSpawner();
  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1', serveCrews: ['a'] })).run();
  assert.deepEqual(perWfWhatsNext(calls), { workflow: 'wf1', serve_crews: ['a'] });
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

test('presence pings on its own cadence, carrying name + serve crews', async () => {
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
  assert.deepEqual(pings[0]!.arg, { name: 'box', serve_crews: ['x'] });
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
  assert.deepEqual(pings[0]!.arg, { name: 'box', serve_crews: [], shift_id: 'shf_abc', started_at: 12345 });
});

test('a presence failure does not kill the loop', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }], presenceThrows: true });
  const { spawner } = fakeSpawner();
  const code = await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1' })).run();
  assert.equal(code, 0);
  assert.equal(count(calls, 'presence'), 1);
  assert.equal(count(calls, 'wake'), 1); // reached wake despite the presence throw
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

test('modern agent order never passes a disagreeing cache harness', async () => {
  cacheBuilderWithHarness('cache-harness');
  const order = modernWo('run_modern_harness', 'builder', 'agent');
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [order] } } });
  const { spawner, spawns } = fakeSpawner();

  await createShiftLoop(baseOpts(hub, spawner, { once: true, workflow: 'wf1' })).run();

  assert.equal(spawns.length, 1);
  assert.equal('harness' in spawns[0]!, false);
});

test('only orders with both modern fields absent use the legacy cache fallback', async () => {
  cacheCommandBundle();
  const workerOnly = { ...wo('run_worker_only', 'cmd'), worker: 'command' };
  const digestOnly = { ...wo('run_digest_only', 'cmd'), defDigest: 'sha256:only' };
  const legacy = wo('run_legacy', 'cmd');
  const errors: string[] = [];
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: { wf1: { def: 'demo', orders: [workerOnly, digestOnly, legacy] } },
  });
  const { spawner, spawns } = fakeSpawner();

  await createShiftLoop(baseOpts(hub, spawner, {
    once: true,
    workflow: 'wf1',
    err: (line) => errors.push(line),
  })).run();

  assert.deepEqual(spawns.map((spawned) => spawned.run), ['run_legacy']);
  assert.equal(errors.filter((line) => /incomplete modern work order/u.test(line)).length, 2);
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

test('Shift never passes a cache-derived harness to the agent-run child', async () => {
  cacheBuilderWithHarness('cache-harness');
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [wo('run_deadbeef', 'builder')] } } });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));
  await loop.iterate();
  assert.equal('harness' in spawns[0]!, false, 'agent-run resolves the verified order-pinned harness');
});

test('a step naming no harness passes no harness to the agent-run child', async () => {
  cacheBuilderWithHarness();
  const { hub } = mockHub({ wake: [{ changed: true, cursor: 1 }], perWf: { wf1: { def: 'demo', orders: [wo('run_deadbeef', 'builder')] } } });
  const { spawner, spawns } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));
  await loop.iterate();
  // No `harness` on the step ⇒ no key at all, leaving the child's own precedence
  // (--harness → OWENLOOP_HARNESS → step def → registry head) in charge.
  assert.equal('harness' in spawns[0]!, false);
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

test('setShift updates the live name/serveCrews; the next presence ping carries them', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: false, cursor: 0 }] });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));
  await loop.iterate(); // first iterate always pings (lastPresence starts at -Infinity)
  loop.setShift({ name: 'shiftB', serveCrews: ['project-bar'] });
  await loop.iterate(); // setShift reset the presence timer, so this pings again immediately
  const pings = calls.filter((c) => c.verb === 'presence');
  assert.equal(pings.length, 2);
  assert.deepEqual(pings[1]!.arg, { name: 'shiftB', serve_crews: ['project-bar'] });
});

test('after setShift({serveCrews}), the per-instance whats_next carries the new serveCrews', async () => {
  const { hub, calls } = mockHub({ wake: [{ changed: true, cursor: 1 }, { changed: true, cursor: 2 }] });
  const { spawner } = fakeSpawner();
  const loop = createShiftLoop(baseOpts(hub, spawner, { workflow: 'wf1' }));
  await loop.iterate(); // first sweep uses the initial serveCrews ([])
  loop.setShift({ serveCrews: ['project-bar'] });
  await loop.iterate();
  const wn = calls.filter((c) => c.verb === 'whats_next');
  assert.deepEqual(wn[wn.length - 1]!.arg, { workflow: 'wf1', serve_crews: ['project-bar'] });
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
  assert.deepEqual(pings[0]!.arg, { name: 'z', serve_crews: ['y'] });
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
  assert.deepEqual(pings[0]!.arg, { name: 'box', serve_crews: [] });
});

// ---- spawn seam -------------------------------------------------------------

test('buildSpawnPlan produces the detached `exec <workflow>/<run> --origin` argv shape as pure data', () => {
  const plan = buildSpawnPlan({ workflow: 'wf1', run: 'run_zzzz' }, 'https://hub.example', 'ci', '/pkg/bin/owenloop.mjs', '/usr/bin/node');
  assert.equal(plan.command, '/usr/bin/node');
  // Account rides the spawn ENV (OWENLOOP_ACCOUNT), NOT the argv — exec has no --as flag.
  assert.deepEqual(plan.args, ['/pkg/bin/owenloop.mjs', 'work', 'exec', 'wf1/run_zzzz', '--origin', 'https://hub.example']);
  assert.equal(plan.options.detached, true);
  assert.deepEqual(plan.options.stdio, ['ignore', 'ignore', 'pipe']);
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
  assert.deepEqual(plan.options.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(plan.options.env['OWENLOOP_ACCOUNT'], 'ci');
});

test('buildSpawnPlan: kind agent-run appends --harness <id> when one is named, and --shift still rides', () => {
  const plan = buildSpawnPlan(
    { workflow: 'wf1', run: 'run_zzzz', kind: 'agent-run', harness: 'h1' },
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
    '--harness',
    'h1',
  ]);
});

test('buildSpawnPlan: an empty or absent harness carries no --harness flag, and a harness on an exec spec is ignored', () => {
  const noHarness = buildSpawnPlan(
    { workflow: 'wf1', run: 'run_zzzz', kind: 'agent-run', harness: '' },
    'https://hub.example',
    'ci',
    '/pkg/bin/owenloop.mjs',
    '/usr/bin/node',
  );
  assert.equal(noHarness.args.includes('--harness'), false);
  // A command order has no step agent; a stray harness on an exec spec is inert.
  const execSpec = buildSpawnPlan(
    { workflow: 'wf1', run: 'run_zzzz', harness: 'h1' },
    'https://hub.example',
    'ci',
    '/pkg/bin/owenloop.mjs',
    '/usr/bin/node',
  );
  assert.deepEqual(execSpec.args, ['/pkg/bin/owenloop.mjs', 'work', 'exec', 'wf1/run_zzzz', '--origin', 'https://hub.example']);
});

test('createDefaultSpawner reports a nonzero detached worker exit with bounded safe metadata', async () => {
  const script = join(stateDir, '..', 'exit-seven.mjs');
  writeFileSync(script, 'process.exit(7);\n');
  // Production Shift has a listening daemon and poll loop keeping its event
  // loop alive. Model that here because the detached child is deliberately
  // unref'd; Node 22 may otherwise let the isolated test process drain before
  // delivering the child's `exit` event.
  const keepAlive = setTimeout(() => {}, 5_000);
  const failure = new Promise<Parameters<NonNullable<Parameters<typeof createDefaultSpawner>[4]>>[0]>((resolve) => {
    const spawner = createDefaultSpawner(ORIGIN, 'default', script, 'shf_test', resolve);
    spawner({ workflow: 'wf1', run: 'run_failed', step: 'builder', kind: 'agent-run', harness: 'codex' });
  });

  try {
    assert.deepEqual(await failure, {
      workflow: 'wf1',
      run: 'run_failed',
      step: 'builder',
      kind: 'agent-run',
      harness: 'codex',
      executable: `${process.execPath} ${script}`,
      exitStatus: 7,
      signal: null,
      message: 'worker exited without completing successfully',
    });
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
    spawner({ workflow: 'delivery', run: 'run_1', step: 'builder', kind: 'agent-run', harness: 'codex' });
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

test('safeWorkerDiagnostic ignores prompts, progress, and arbitrary stderr', () => {
  assert.equal(safeWorkerDiagnostic('prompt contents\nprovider progress\narbitrary failure\n'), undefined);
});

// REGRESSION: `WorkerFailure.kind` has two values, but the allowlist matched only
// `owenloop work agent-run:` prefixes. An `exec` child that refused at startup
// therefore always reported the useless generic message. Every kind matched here
// is a real member of `InstructionRefusalKind`
// (packages/work/src/exec/instructions.ts) rendered by `refusal()`.
test('safeWorkerDiagnostic surfaces an exec startup refusal instead of the generic message', () => {
  const reported = safeWorkerDiagnostic(
    "owenloop work exec: instruction refusal (unverified-def) for wf1/run_9 step 'cmd' " +
      "defDigest 'sha256:abc': publication signature did not verify\n",
  );
  assert.match(reported ?? '', /instruction refusal \(unverified-def\)/u);
  assert.equal(
    safeWorkerDiagnostic('owenloop work exec: no hub origin — pass --origin <url> or set hubOrigin in settings\n'),
    'owenloop work exec: no hub origin — pass --origin <url> or set hubOrigin in settings',
  );
});

// The widening is deliberately limited to the pre-run startup/refusal gates. A
// mid-run exec line can quote hub response text, so it must stay unmatched.
test('safeWorkerDiagnostic still refuses mid-run exec lines and arbitrary exec stderr', () => {
  assert.equal(safeWorkerDiagnostic('owenloop work exec: submit to workspace rejected (schema): hub said token=abc\n'), undefined);
  assert.equal(safeWorkerDiagnostic('owenloop work exec: running wf1/run_9 (step \'cmd\')\n'), undefined);
  assert.equal(safeWorkerDiagnostic('owenloop work exec: something entirely unrecognized\n'), undefined);
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

// REGRESSION: `stdio: [...,'pipe']` creates a libuv handle owned by the SHIFT
// process, and `child.unref()` does not cover it. Left referenced, the Shift's
// event loop stays alive for the child's whole lifetime, so `owenloop work
// shift --once` would block until every dispatched worker exited — defeating the
// detached hand-off this seam exists to perform.
test('the spawner does not keep its own event loop referenced for the detached child lifetime', async () => {
  const script = join(stateDir, '..', 'slow-child.mjs');
  writeFileSync(script, "process.stderr.write('early\\n');\nsetTimeout(() => {}, 60_000);\n");
  const spawner = createDefaultSpawner(ORIGIN, 'default', script, 'shf_test');

  // `_getActiveHandles()` lists exactly the handles that are a reason for this
  // process's event loop to keep running. The child's stderr pipe appears there
  // as a `Socket` while it is referenced, and drops off once unref'd — data
  // still reaches the tail buffer for as long as the Shift is up, it simply
  // stops holding the loop open.
  //
  // Measured as a DELTA across the one spawn, never as an absolute count: under
  // `node --test` the runner's own piped stdio already contributes referenced
  // Sockets that have nothing to do with this seam. Verified to fail (delta 1)
  // when `child.stderr.unref()` is removed from `createDefaultSpawner`.
  const activeSockets = (): number =>
    (process as unknown as { _getActiveHandles: () => { constructor: { name: string } }[] })
      ._getActiveHandles()
      .filter((handle) => handle.constructor.name === 'Socket').length;

  const before = activeSockets();
  spawner({ workflow: 'wf1', run: 'run_detach', step: 'cmd' });
  assert.equal(
    activeSockets() - before,
    0,
    "the child stderr pipe must be unref'd alongside the child itself",
  );
});

// createDefaultSpawner is a thin wrapper: it captures shiftId at
// construction and passes it straight through to buildSpawnPlan (see spawn.ts
// doc comment) before calling the real `spawn`. Per this file's own testing
// contract ("pure buildSpawnPlan so a test can assert the exact shape as
// data" / never launch a real child), the buildSpawnPlan tests above are the
// intended coverage for the shiftId threading — createDefaultSpawner
// itself is deliberately NOT exercised here.

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
      out: (l) => out.push(l),
    }),
  ).iterate();

  assert.equal(spawns.length, 2);
  assert.equal(readChildRecords(stateDir).length, 2);
  assert.match(out.join('\n'), /at the agent-run cap \(2\)/);
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
});

test('a whats_next response older than 90 seconds is not dispatched into immediate capacity', async () => {
  cacheBuilderStep();
  let monotonic = 0;
  const { hub } = mockHub({
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
  })).iterate();

  assert.equal(dispatched, 0);
  assert.equal(spawns.length, 0);
  assert.match(err.join('\n'), /claim expired before local dispatch/);
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
    let wall = 50_000;
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

test('a queued claim is discarded before the hub pickup window can expire and re-offer it', async () => {
  cacheBuilderStep();
  const orders = [wo('run_first', 'builder'), wo('run_stale', 'builder')];
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
      isAlive: (candidatePid) => alive.has(candidatePid),
      monotonicNow: () => monotonic,
      err: (line) => err.push(line),
    }),
  );

  assert.equal(await loop.iterate(), 1);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);

  alive.delete(1000);
  monotonic = MAX_PENDING_CANDIDATE_AGE_MS;

  assert.equal(await loop.iterate(), 0);
  assert.deepEqual(spawns.map((spawn) => spawn.run), ['run_first']);
  assert.match(err.join('\n'), /queued claim expired before local dispatch/);
  assert.equal(count(calls, 'whats_next'), 1, 'classifying the stale local candidate does not require another hub sweep');
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

test('a reservation write failure prevents spawn and removes the losing gate', async () => {
  cacheBuilderStep();
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(stateDir, 'run_reserve_fail.json'));
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_reserve_fail', 'builder')]),
  });
  const { spawner, spawns } = fakeSpawner();
  const err: string[] = [];

  const dispatched = await createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    err: (line) => err.push(line),
  })).iterate();

  assert.equal(dispatched, 0);
  assert.equal(spawns.length, 0, 'spawn is unreachable until the reservation is durable');
  assert.equal(readChildReservations(stateDir).length, 0);
  assert.equal(readdirSync(stateDir).some((name) => name.endsWith('.gate')), false);
  assert.match(err.join('\n'), /agent-run spawn for wf1\/run_reserve_fail failed:/u);
});

test('a PID-record finalization failure terminates the gated child and never opens its gate', async () => {
  cacheBuilderStep();
  const { hub } = mockHub({
    wake: [{ changed: true, cursor: 1 }],
    perWf: agentWf([wo('run_finalize_fail', 'builder')]),
  });
  let gatePath: string | undefined;
  let terminated = 0;
  const spawner: Spawner = (spec) => {
    gatePath = spec.startGate;
    assert.equal(gatePath === undefined ? undefined : readFileSync(gatePath, 'utf8'), 'wait\n');
    rmSync(join(stateDir, 'run_finalize_fail.json'));
    mkdirSync(join(stateDir, 'run_finalize_fail.json'));
    return { pid: 4242, terminate: () => { terminated++; } };
  };
  const err: string[] = [];

  const dispatched = await createShiftLoop(baseOpts(hub, spawner, {
    workflow: 'wf1',
    err: (line) => err.push(line),
  })).iterate();

  assert.equal(dispatched, 0);
  assert.equal(terminated, 1, 'the spawned process is terminated after PID persistence fails');
  assert.equal(gatePath === undefined ? true : existsSync(gatePath), false, 'the child never observes a start signal');
  assert.equal(readChildRecords(stateDir).length, 0);
  assert.equal(readChildReservations(stateDir).length, 0);
  assert.match(err.join('\n'), /child reservation .* is missing or was replaced/u);
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
