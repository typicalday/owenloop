import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { createShiftLoop } from '../src/shift/loop.ts';
import type { ShiftLoopOptions } from '../src/shift/loop.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { WorkOrder } from '../src/hub/types.ts';
import type { ShiftEvent } from '../src/shift/protocol.ts';
import { writeChildRecord } from '../src/shift/state.ts';
import { writeBundle } from '../src/bundle/cache.ts';
import type { CachedBundle, NormalizedStepSpec } from '../src/bundle/types.ts';
import type { Spawner } from '../src/shift/spawn.ts';
import { until } from './helpers/mcp-stdio-client.ts';

let root: string;
let stateDir: string;
let cacheDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-attendance-events-'));
  stateDir = join(root, 'state');
  cacheDir = join(root, 'cache');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function mockHub(wakeChanged = false): { hub: HubClient; pings: Array<Record<string, unknown>> } {
  const pings: Array<Record<string, unknown>> = [];
  const hub: HubClient = {
    async wake() { return { text: '', cursor: 1, changed: wakeChanged }; },
    async presencePing(req) { pings.push({ ...req }); return { text: '', ok: true, name: req.name, lastSeen: 1 }; },
    async whatsNext() { return { text: '', workflow: 'wf1', def: 'demo', orders: [] }; },
    async getOrder(req) { return { text: '', workflow: req.workflow, run: req.run, order: null, lease: { claimed: true } }; },
    async heartbeat() { return { text: '', ok: true }; },
    async release() { return { text: '' }; },
    async submit() { return { text: '' }; },
    async reject() { return { text: '', ok: true }; },
    async whoami() { return { text: '', orgId: '', orgName: '', actor: { id: '', kind: 'agent', role: 'agent', scopes: [] }, tokenStatus: 'active', authMethod: 'token' }; },
  };
  return { hub, pings };
}

/**
 * The `{ts, shift, shiftId}` envelope `emit()` stamps onto EVERY event, spelled
 * out with `baseOpts`'s values: `now: () => 100`, `name: 'box'`, and no
 * `shiftId` at all, which `emit()` renders as the empty string.
 *
 * Written out here rather than hidden behind a matcher because these are GOLDEN
 * assertions — the envelope is part of the wire contract now, and a reader of
 * this file should see exactly what a consumer receives.
 */
const ENVELOPE = { ts: new Date(100).toISOString(), shift: 'box', shiftId: '' } as const;

function baseOpts(hub: HubClient, spawner: Spawner, extra: Partial<ShiftLoopOptions> = {}): ShiftLoopOptions {
  return {
    hub,
    spawner,
    sleep: async () => {},
    now: () => 100,
    out: () => {},
    err: () => {},
    cacheDir,
    stateDir,
    cap: 3,
    serveCrews: [],
    name: 'box',
    workflow: 'wf1',
    pollIntervalMs: 10,
    presenceIntervalMs: 60_000,
    ...extra,
  };
}

function cacheCommand(): void {
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: 'hash', steps: [{ name: 'cmd', executor: 'command' }] },
    fetchedAt: 0,
    origin: 'test',
  };
  writeBundle(cacheDir, bundle, []);
}

function cacheAgent(): void {
  const spec: NormalizedStepSpec = { step: 'builder', brief: 'build', permissions: { extensions: {} } };
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: 'hash', steps: [{ name: 'builder', body: '' }] },
    fetchedAt: 0,
    origin: 'test',
  };
  writeBundle(cacheDir, bundle, [spec]);
}

function order(step: string): WorkOrder {
  return { workflow: 'wf1', run: 'run_1', step, consumes: {}, expected_outputs: [], feedback: [], advisory: {}, submit_hint: '' };
}

test('attendance is omitted before noteAttended and included after an immediate ping', async () => {
  const { hub, pings } = mockHub(false);
  const loop = createShiftLoop(baseOpts(hub, () => ({ pid: 1000 })));
  await loop.iterate();
  assert.equal('attended_at' in pings[0]!, false);

  loop.noteAttended(1234);
  await loop.iterate();
  assert.equal(pings.length, 2, 'attendance makes presence due without waiting for cadence');
  assert.equal(pings[1]!.attended_at, 1234);
  assert.equal(loop.getAttendedAt(), 1234);
});

test('attendance recorded DURING an in-flight ping still forces the very next ping', async () => {
  // The lost-wakeup race. `noteAttended` forces presence due by setting
  // lastPresence to -Infinity. A ping already awaiting the hub then completes
  // and stamps lastPresence = now(), overwriting that sentinel — so the
  // attendance the client just recorded would not reach the hub for a full
  // presenceIntervalMs (60s in production) instead of on the next iteration.
  const pings: Array<Record<string, unknown>> = [];
  let releasePing: (() => void) | undefined;
  const hub: HubClient = {
    async wake() { return { text: '', cursor: 1, changed: false }; },
    async presencePing(req) {
      pings.push({ ...req });
      // Park only the first ping, mid-flight, exactly where the race lives.
      if (pings.length === 1) await new Promise<void>((resolve) => { releasePing = resolve; });
      return { text: '', ok: true, name: req.name, lastSeen: 1 };
    },
    async whatsNext() { return { text: '', workflow: 'wf1', def: 'demo', orders: [] }; },
    async getOrder(req) { return { text: '', workflow: req.workflow, run: req.run, order: null, lease: { claimed: true } }; },
    async heartbeat() { return { text: '', ok: true }; },
    async release() { return { text: '' }; },
    async submit() { return { text: '' }; },
    async reject() { return { text: '', ok: true }; },
    async whoami() { return { text: '', orgId: '', orgName: '', actor: { id: '', kind: 'agent', role: 'agent', scopes: [] }, tokenStatus: 'active', authMethod: 'token' }; },
  };
  // A frozen clock: without the fix nothing but the sentinel can make the
  // second ping due, so this asserts the sentinel survives and nothing else.
  const loop = createShiftLoop(baseOpts(hub, () => ({ pid: 1000 }), { now: () => 100 }));

  const first = loop.iterate();
  await until(() => releasePing !== undefined, 'the first presence ping to be in flight');
  assert.equal('attended_at' in pings[0]!, false, 'no attendance recorded yet');

  // The socket `next` arrives while the first ping is still awaiting the hub.
  loop.noteAttended(1234);
  releasePing!();
  await first;

  await loop.iterate();
  assert.equal(pings.length, 2, 'attendance during an in-flight ping must still force the next ping');
  assert.equal(pings[1]!.attended_at, 1234, 'the forced ping carries the recorded attendance');
});

test('successful command dispatch emits one dispatched event with the child pid', async () => {
  cacheCommand();
  const events: ShiftEvent[] = [];
  const { hub } = mockHub(true);
  const spawner: Spawner = () => ({ pid: 4321 });
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    onEvent: (event) => events.push(event),
    // The mock hub returns the order only for per-workflow mode.
    workflow: 'wf1',
  }));
  const original = hub.whatsNext;
  hub.whatsNext = async (req) => req?.workflow === undefined
    ? { text: '', instances: [{ workflow: 'wf1', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }] }
    : { text: '', workflow: 'wf1', def: 'demo', orders: [order('cmd')] };
  await loop.iterate();
  hub.whatsNext = original;
  assert.deepEqual(events.filter((event) => event.type === 'dispatched'), [{
    type: 'dispatched', workflow: 'wf1', run: 'run_1', step: 'cmd', kind: 'exec', pid: 4321, ...ENVELOPE,
  }]);
});

test('dead child reconciliation emits one reaped event', async () => {
  writeChildRecord(stateDir, { workflow: 'wf1', run: 'run_dead', pid: 77, spawnedAt: 0, kind: 'exec' });
  const events: ShiftEvent[] = [];
  const { hub } = mockHub(false);
  const loop = createShiftLoop(baseOpts(hub, () => ({ pid: 1000 }), {
    isAlive: () => false,
    onEvent: (event) => events.push(event),
  }));
  await loop.iterate();
  assert.deepEqual(events, [{
    type: 'reaped', workflow: 'wf1', run: 'run_dead', kind: 'exec', pid: 77, ...ENVELOPE,
  }]);
});

test('spawn failure emits one failed event and writes no child record', async () => {
  cacheAgent();
  const events: ShiftEvent[] = [];
  const { hub } = mockHub(true);
  const spawner: Spawner = () => { throw new Error('fork bomb'); };
  const loop = createShiftLoop(baseOpts(hub, spawner, {
    onEvent: (event) => events.push(event),
  }));
  hub.whatsNext = async (req) => req?.workflow === undefined
    ? { text: '', instances: [{ workflow: 'wf1', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }] }
    : { text: '', workflow: 'wf1', def: 'demo', orders: [order('builder')] };
  await loop.iterate();
  assert.deepEqual(events.filter((event) => event.type === 'failed'), [{
    type: 'failed', workflow: 'wf1', run: 'run_1', step: 'builder', kind: 'agent-run', message: 'fork bomb',
    ...ENVELOPE,
  }]);
});

/**
 * ── THE PROMOTED EVENTS ──
 *
 * Each test below covers one class of refusal or condition that used to exist
 * ONLY as a stderr line — and stderr is precisely what a dispatched shift
 * discards. The assertions check two things together, because the point of the
 * promotion is that both hold: the record is now structured AND the operator's
 * console text did not change.
 */

test('a refused modern order emits one order-dropped event and keeps its console text', async () => {
  const events: ShiftEvent[] = [];
  const errors: string[] = [];
  const { hub } = mockHub(true);
  const loop = createShiftLoop(baseOpts(hub, () => ({ pid: 1000 }), {
    onEvent: (event) => events.push(event),
    err: (line) => errors.push(line),
  }));
  hub.whatsNext = async (req) => req?.workflow === undefined
    ? { text: '', instances: [{ workflow: 'wf1', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }] }
    : {
      text: '', workflow: 'wf1', def: 'demo',
      orders: [{ ...order('cmd'), defDigest: 'sha256:abc', worker: 'wat' }],
    };
  await loop.iterate();

  const dropped = events.filter((event) => event.type === 'order-dropped');
  assert.equal(dropped.length, 1, JSON.stringify(events));
  assert.deepEqual(dropped[0], {
    type: 'order-dropped',
    workflow: 'wf1',
    run: 'run_1',
    step: 'cmd',
    reason: 'unsupported-worker',
    message: "unsupported worker 'wat' — leaving for manual pickup",
    ...ENVELOPE,
  });
  // The console line an operator watching a foreground shift sees is UNCHANGED:
  // the record is an addition, not a replacement.
  assert.ok(
    errors.includes("[wf1/run_1] unsupported worker 'wat' — leaving for manual pickup"),
    errors.join('\n'),
  );
});

test('a hub whats_next failure emits one hub-error event', async () => {
  const events: ShiftEvent[] = [];
  const { hub } = mockHub(true);
  const loop = createShiftLoop(baseOpts(hub, () => ({ pid: 1000 }), {
    onEvent: (event) => events.push(event),
  }));
  hub.whatsNext = async (req) => {
    if (req?.workflow === undefined) {
      return { text: '', instances: [{ workflow: 'wf1', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }] };
    }
    throw new Error('hub is down');
  };
  await loop.iterate();

  assert.deepEqual(events.filter((event) => event.type === 'hub-error'), [{
    type: 'hub-error', op: 'whats_next', workflow: 'wf1', message: 'hub is down', ...ENVELOPE,
  }]);
});

test('a missing cached bundle emits one bundle-miss event', async () => {
  // Nothing is written to the cache, so the legacy path finds no bundle.
  const events: ShiftEvent[] = [];
  const { hub } = mockHub(true);
  const loop = createShiftLoop(baseOpts(hub, () => ({ pid: 1000 }), {
    onEvent: (event) => events.push(event),
  }));
  hub.whatsNext = async (req) => req?.workflow === undefined
    ? { text: '', instances: [{ workflow: 'wf1', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }] }
    : { text: '', workflow: 'wf1', def: 'demo', orders: [order('cmd')] };
  await loop.iterate();

  assert.deepEqual(events.filter((event) => event.type === 'bundle-miss'), [{
    type: 'bundle-miss', workflow: 'wf1', def: 'demo', ...ENVELOPE,
  }]);
});

test('a full dispatch cap emits one capacity event carrying both numbers', async () => {
  cacheCommand();
  const events: ShiftEvent[] = [];
  const { hub } = mockHub(true);
  // cap 0 means the shift is at capacity the moment it has anything to do.
  const loop = createShiftLoop(baseOpts(hub, () => ({ pid: 1000 }), {
    cap: 0,
    onEvent: (event) => events.push(event),
  }));
  hub.whatsNext = async (req) => req?.workflow === undefined
    ? { text: '', instances: [{ workflow: 'wf1', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }] }
    : { text: '', workflow: 'wf1', def: 'demo', orders: [order('cmd')] };
  await loop.iterate();

  assert.deepEqual(events.filter((event) => event.type === 'capacity'), [{
    type: 'capacity', inFlight: 0, cap: 0, ...ENVELOPE,
  }]);
});

test('one unbroken stretch at capacity emits ONE capacity event, not one per tick', async () => {
  // REGRESSION GUARD. This branch runs on every CHANGED wake for as long as the
  // shift stays full, so a level-triggered event floods two durable consumers:
  // `shift.log`, which is never rotated, and a parked `owenloop shift next`,
  // which must BLOCK on an idle shift rather than return a record about the
  // shift itself. `packages/work/test/shift-blocking-acceptance.test.ts` caught
  // exactly that — its second parked `next` returned instantly on a `capacity`
  // record. The console line beside the emit stays level-triggered on purpose;
  // only the event is edge-triggered.
  cacheCommand();
  const events: ShiftEvent[] = [];
  // `changed: true` on every wake is what a busy hub looks like, and is what
  // makes the branch re-run each tick.
  const { hub } = mockHub(true);
  const loop = createShiftLoop(baseOpts(hub, () => ({ pid: 1000 }), {
    cap: 0,
    onEvent: (event) => events.push(event),
  }));
  hub.whatsNext = async (req) => req?.workflow === undefined
    ? { text: '', instances: [{ workflow: 'wf1', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }] }
    : { text: '', workflow: 'wf1', def: 'demo', orders: [order('cmd')] };

  await loop.iterate();
  await loop.iterate();
  await loop.iterate();

  assert.equal(
    events.filter((event) => event.type === 'capacity').length,
    1,
    JSON.stringify(events.filter((event) => event.type === 'capacity')),
  );
});

test('a throwing event sink is reported and never reaches the loop', async () => {
  // The file sink and the socket queue are BOTH failure-prone consumers (a full
  // disk, an overflowing FIFO). Neither may cost a dispatch, so `emit` catches.
  const errors: string[] = [];
  cacheCommand();
  const { hub } = mockHub(true);
  const loop = createShiftLoop(baseOpts(hub, () => ({ pid: 4321 }), {
    onEvent: () => { throw new Error('sink exploded'); },
    err: (line) => errors.push(line),
  }));
  hub.whatsNext = async (req) => req?.workflow === undefined
    ? { text: '', instances: [{ workflow: 'wf1', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }] }
    : { text: '', workflow: 'wf1', def: 'demo', orders: [order('cmd')] };

  // The assertion is that this resolves at all rather than rejecting.
  await loop.iterate();

  assert.ok(
    errors.some((line) => line.includes('shift event sink failed: sink exploded (continuing)')),
    errors.join('\n'),
  );
  // And the dispatch it was reporting on still happened.
  assert.equal(readdirSync(stateDir).some((name) => name.endsWith('.json')), true, 'the order was still dispatched');
});
