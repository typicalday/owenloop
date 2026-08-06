import { mkdtempSync, rmSync } from 'node:fs';
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
    type: 'dispatched', workflow: 'wf1', run: 'run_1', step: 'cmd', kind: 'exec', pid: 4321,
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
  assert.deepEqual(events, [{ type: 'reaped', workflow: 'wf1', run: 'run_dead', kind: 'exec', pid: 77 }]);
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
  }]);
});
