/**
 * A shift must not feed orders to a disk that cannot hold them.
 *
 * The incident is recorded in `loop.ts`'s `noteWorkerFailure` docstring: a
 * worker "exited 1 with no signal, killed by ENOSPC inside its own error
 * logging". The child died while trying to say why it was dying, so the shift
 * saw a bare non-zero exit, learned nothing, and re-offered the same order onto
 * the same full disk.
 *
 * The two properties under test pull in opposite directions and both matter.
 * REFUSE: while the disk is below the floor, no new order is claimed, and one
 * record names the reason. DO NOT STOP: unlike the vanished `TMPDIR` that
 * `host-preflight.ts` exits for, a full disk self-heals, so the shift stays up,
 * keeps polling, and resumes on its own. A gate that exited instead would turn a
 * condition that commonly clears in minutes into an outage needing a human.
 */

import { mkdtempSync, rmSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { createShiftLoop } from '../src/shift/loop.ts';
import type { ShiftLoopOptions } from '../src/shift/loop.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { ShiftEvent } from '../src/shift/protocol.ts';
import {
  DEFAULT_DISK_FLOOR_BYTES,
  checkDiskFloor,
  formatBytes,
  nearestExistingAncestor,
  realStatfsProbe,
  resolveDiskFloorBytes,
  type DiskSpace,
  type StatfsProbe,
} from '../src/shift/disk-floor.ts';

const GIB = 1024 * 1024 * 1024;

// ── the module itself ───────────────────────────────────────────────────────

function fsProbe(freeBytes: number | undefined, existing: readonly string[] = ['/']): StatfsProbe {
  return {
    freeBytes: () => freeBytes,
    exists: (path) => existing.includes(path),
  };
}

test('below the floor is low, at and above the floor is ok', () => {
  const low = checkDiskFloor('/', GIB, fsProbe(GIB - 1));
  assert.equal(low.state, 'low');
  assert.equal(low.state === 'low' ? low.freeBytes : -1, GIB - 1);
  assert.equal(low.state === 'low' ? low.floorBytes : -1, GIB, 'the record carries BOTH numbers');

  // Exactly at the floor is enough. The floor is "this much must remain", not
  // "more than this much", and a boundary that refused would make a floor of 0
  // mean something different from switching the gate off.
  assert.equal(checkDiskFloor('/', GIB, fsProbe(GIB)).state, 'ok');
  assert.equal(checkDiskFloor('/', GIB, fsProbe(GIB * 4)).state, 'ok');
});

test('a floor of zero switches the gate off entirely', () => {
  // The operator escape hatch. Someone deliberately running a machine close to
  // full, or hitting a floor this module got wrong, must be able to say so
  // without downgrading the CLI — so `0` reports `unknown`, never `low`.
  assert.equal(checkDiskFloor('/', 0, fsProbe(1)).state, 'unknown');
  assert.equal(checkDiskFloor('/', -1, fsProbe(1)).state, 'unknown');
});

test('an unmeasurable disk FAILS OPEN rather than refusing work', () => {
  // THE MOST IMPORTANT ASSERTION IN THIS FILE. A check that refused whenever it
  // could not measure the disk would convert its own blind spot into the total
  // outage it exists to prevent — on exactly the exotic hosts least likely to
  // be debugged quickly. The measured failure mode is a full disk, not an
  // unmeasurable one.
  assert.equal(checkDiskFloor('/', GIB, fsProbe(undefined)).state, 'unknown');
  // Nothing on the path exists, not even the filesystem root.
  assert.equal(checkDiskFloor('/nowhere', GIB, fsProbe(0, [])).state, 'unknown');
});

test('a work root that does not exist yet is measured through its nearest existing parent', () => {
  // A work root is normally ABSENT on a first run — `resolveWorkRoot` defaults
  // it to `<cacheDir>/work` and `prepareWorkdir` mkdir -p's it on demand. A
  // check that required the path to exist would report `unknown` on every clean
  // install and never fire when it mattered.
  const probe = fsProbe(GIB - 1, ['/var', '/']);
  assert.equal(nearestExistingAncestor('/var/a/b/c', probe), '/var');
  assert.equal(checkDiskFloor('/var/a/b/c', GIB, probe).state, 'low');
});

test('the ancestor walk terminates at the filesystem root instead of looping', () => {
  assert.equal(nearestExistingAncestor('/a/b/c', fsProbe(0, [])), undefined);
});

test('precedence is flag, then settings, then the default', () => {
  assert.equal(resolveDiskFloorBytes(5, 9), 5);
  assert.equal(resolveDiskFloorBytes(undefined, 9), 9);
  assert.equal(resolveDiskFloorBytes(undefined, undefined), DEFAULT_DISK_FLOOR_BYTES);
  // `0` from either rung must survive as a real value, not be swallowed by a
  // `||` that reads it as absent — it is how the gate is switched off.
  assert.equal(resolveDiskFloorBytes(0, 9), 0);
  assert.equal(resolveDiskFloorBytes(undefined, 0), 0);
});

test('the real probe reports bavail, the space an unprivileged writer can use', () => {
  // `bfree` counts blocks reserved for root, which no shift child can write
  // into. Reading it would report hundreds of megabytes of headroom that does
  // not exist, on precisely the full disk this gate exists to catch.
  const dir = tmpdir();
  const stat = statfsSync(dir);
  assert.equal(realStatfsProbe.freeBytes(dir), Number(stat.bavail) * Number(stat.bsize));
  assert.equal(realStatfsProbe.exists(dir), true);
  assert.equal(realStatfsProbe.exists(join(dir, 'owenloop-no-such-path-9d3f')), false);
  assert.equal(realStatfsProbe.freeBytes(join(dir, 'owenloop-no-such-path-9d3f')), undefined);
});

test('byte counts are rendered for an operator reading a log line', () => {
  assert.equal(formatBytes(GIB), '1.0 GiB');
  assert.equal(formatBytes(GIB * 3 / 2), '1.5 GiB');
  assert.equal(formatBytes(200 * 1024 * 1024), '200 MiB');
  assert.equal(formatBytes(512), '512 B');
});

// ── the gate inside the loop ────────────────────────────────────────────────

let root: string;
let stateDir: string;
let cacheDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-disk-floor-'));
  stateDir = join(root, 'state');
  cacheDir = join(root, 'cache');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A hub that always reports a changed cursor, so every tick wants to sweep. */
function mockHub(onWhatsNext: () => void): HubClient {
  return {
    async wake() { return { text: '', cursor: 1, changed: true }; },
    async presencePing(req) { return { text: '', ok: true, name: req.name, lastSeen: 1 }; },
    async whatsNext() {
      onWhatsNext();
      return { text: '', instances: [] };
    },
    async getOrder(req) { return { text: '', workflow: req.workflow, run: req.run, order: null, lease: { claimed: true } }; },
    async heartbeat() { return { text: '', ok: true }; },
    async release() { return { text: '' }; },
    async submit() { return { text: '' }; },
    async reject() { return { text: '', ok: true }; },
    async ask() { return { text: '', ok: true }; },
    async requestApproval() { return { text: '', ok: false }; },
    async answerApproval() { return { text: '', ok: false }; },
    async listPendingApprovals() { return { text: '', approvals: [] }; },
    async reportResolution(req) {
      return { text: '', workflow: req.workflow, run: req.run, step: '', recorded: true, claimed: true };
    },
    async whoami() {
      return { text: '', orgId: '', orgName: '', actor: { id: '', kind: 'agent', role: 'agent', scopes: [] }, tokenStatus: 'active', authMethod: 'token' };
    },
  } as HubClient;
}

function baseOpts(hub: HubClient, extra: Partial<ShiftLoopOptions> = {}): ShiftLoopOptions {
  return {
    hub,
    spawner: () => ({ pid: 1000 }),
    sleep: async () => {},
    now: () => 100,
    out: () => {},
    err: () => {},
    cacheDir,
    stateDir,
    cap: 3,
    serveCrews: [],
    name: 'box',
    shiftId: 'shf_unit',
    workflow: 'wf1',
    pollIntervalMs: 10,
    presenceIntervalMs: 60_000,
    hostPreflight: () => [],
    ...extra,
  };
}

const LOW: DiskSpace = { state: 'low', path: '/w', freeBytes: 100 * 1024 * 1024, floorBytes: GIB };
const OK: DiskSpace = { state: 'ok', path: '/w', freeBytes: 4 * GIB, floorBytes: GIB };

test('a low disk defers the sweep, names the reason, and does NOT stop the shift', async () => {
  const events: ShiftEvent[] = [];
  const lines: string[] = [];
  let sweeps = 0;
  const loop = createShiftLoop(baseOpts(mockHub(() => { sweeps += 1; }), {
    onEvent: (event) => events.push(event),
    out: (line) => lines.push(line),
    diskSpace: () => LOW,
  }));

  await loop.iterate();

  assert.equal(sweeps, 0, 'no order may be claimed onto a disk that cannot hold its work');
  const lowDisk = events.filter((event) => event.type === 'low-disk');
  assert.equal(lowDisk.length, 1, JSON.stringify(events));
  assert.deepEqual(lowDisk[0], {
    type: 'low-disk', path: '/w', freeBytes: LOW.state === 'low' ? LOW.freeBytes : 0, floorBytes: GIB,
    ts: new Date(100).toISOString(), shift: 'box', shiftId: 'shf_unit',
  });
  assert.ok(
    lines.some((line) => line.includes('low disk') && line.includes('/w') && line.includes('100 MiB')),
    `the console line must name the measured directory and the free space: ${JSON.stringify(lines)}`,
  );
  // No `wedged`, and the loop is still willing to run: a full disk is LOCAL but
  // SELF-HEALING, which is the split `host-preflight.ts` exists on the other
  // side of.
  assert.deepEqual(events.filter((event) => event.type === 'wedged'), []);
});

test('the record is EDGE-triggered: one per low-disk episode, not one per tick', async () => {
  // A shift sitting on a full disk for an hour writes one line, not 720. This is
  // the same rule the at-capacity record follows, and the reason both are
  // file-only: a persistent condition that repeated on the socket would evict
  // the work records a parked `shift next` is actually waiting for.
  const events: ShiftEvent[] = [];
  const lines: string[] = [];
  const loop = createShiftLoop(baseOpts(mockHub(() => {}), {
    onEvent: (event) => events.push(event),
    out: (line) => lines.push(line),
    diskSpace: () => LOW,
  }));

  for (let i = 0; i < 5; i += 1) await loop.iterate();

  assert.equal(events.filter((event) => event.type === 'low-disk').length, 1, JSON.stringify(events));
  // The console line stays LEVEL-triggered on purpose: a live tail is watched by
  // someone who wants to see the shift is still stuck.
  assert.equal(lines.filter((line) => line.includes('low disk')).length, 5);
});

test('recovery needs no operator and no timer, and re-arms for the next episode', async () => {
  // The whole design rests on this. Refusing sets `sweepOwed`; `sweepOwed` makes
  // the next tick want to sweep; wanting to sweep re-measures the disk. There is
  // no separate recovery path to get wrong.
  const events: ShiftEvent[] = [];
  const lines: string[] = [];
  let sweeps = 0;
  let disk: DiskSpace = LOW;
  const loop = createShiftLoop(baseOpts(mockHub(() => { sweeps += 1; }), {
    onEvent: (event) => events.push(event),
    out: (line) => lines.push(line),
    diskSpace: () => disk,
  }));

  await loop.iterate();
  assert.equal(sweeps, 0);

  disk = OK;
  await loop.iterate();
  assert.equal(sweeps, 1, 'space returned, so the deferred sweep happens by itself');
  assert.ok(
    lines.some((line) => line.includes('disk space recovered')),
    JSON.stringify(lines),
  );

  // A machine that fills and drains twice writes TWO records. A flag that only
  // ever latched would hide every episode after the first.
  disk = LOW;
  await loop.iterate();
  assert.equal(events.filter((event) => event.type === 'low-disk').length, 2, JSON.stringify(events));
});

test('a loop built without a disk probe never refuses work', async () => {
  // `runtime.ts` owns flag/settings/default precedence and supplies the real
  // closure. A loop constructed without a work root and a floor has no basis to
  // decline anything, so the default must be permission to dispatch.
  const events: ShiftEvent[] = [];
  let sweeps = 0;
  const loop = createShiftLoop(baseOpts(mockHub(() => { sweeps += 1; }), {
    onEvent: (event) => events.push(event),
  }));

  await loop.iterate();

  assert.equal(sweeps, 1);
  assert.deepEqual(events.filter((event) => event.type === 'low-disk'), []);
});

test('an unmeasurable disk lets the shift work', async () => {
  let sweeps = 0;
  const loop = createShiftLoop(baseOpts(mockHub(() => { sweeps += 1; }), {
    diskSpace: () => ({ state: 'unknown', path: '/w' }),
  }));

  await loop.iterate();
  assert.equal(sweeps, 1);
});
