import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { HubClient } from '../src/hub/client.ts';
import type { ProxyLoop } from '../src/proxy/loop.ts';
import { createShiftDaemon, type ShiftDaemon } from '../src/shift/server.ts';
import { OVERLAP_ERROR } from '../src/shift/protocol.ts';
import { requestShift } from '../src/shift/client.ts';
import { rawShiftRequest } from './helpers/shift-client.ts';

interface FakeState {
  name: string;
  servePools: string[];
  cap: number;
  attended?: number;
  stopped: boolean;
  childAlive: boolean;
  resolveRun?: (code: number) => void;
}

interface Fixture {
  root: string;
  socketPath: string;
  daemon: ShiftDaemon;
  run: Promise<number>;
  state: FakeState;
  pings: Array<Record<string, unknown>>;
  errors: string[];
}

let roots: string[] = [];
let fixtures: Fixture[] = [];
beforeEach(() => { roots = []; fixtures = []; });
afterEach(async () => {
  await Promise.allSettled(fixtures.map(async (fixture) => {
    fixture.daemon.stop('signal');
    await fixture.run;
  }));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeHub(pings: Array<Record<string, unknown>>, onPresence?: (request: Record<string, unknown>) => Promise<void> | void): HubClient {
  return {
    presencePing: async (request: Record<string, unknown>) => {
      pings.push({ ...request });
      await onPresence?.(request);
      return { text: '', ok: true, name: String(request.name), lastSeen: 1 };
    },
  } as unknown as HubClient;
}

function fixture(options: {
  socketPath?: string;
  onPresence?: (request: Record<string, unknown>) => Promise<void> | void;
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'owenwork-shift-server-'));
  roots.push(root);
  const state: FakeState = {
    name: 'box', servePools: ['alpha'], cap: 3, stopped: false, childAlive: true,
  };
  const pings: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const loop = {
    run: () => new Promise<number>((resolve) => { state.resolveRun = resolve; }),
    stop: () => {
      state.stopped = true;
      state.resolveRun?.(0);
    },
    iterate: async () => 0,
    freeCapacity: () => state.cap,
    getCap: () => state.cap,
    setCap: (cap: number) => { state.cap = cap; },
    getShift: () => ({ name: state.name, servePools: [...state.servePools] }),
    setShift: (next: { name?: string; servePools?: string[] }) => {
      if (next.name !== undefined) state.name = next.name;
      if (next.servePools !== undefined) state.servePools = [...next.servePools];
      return { name: state.name, servePools: [...state.servePools] };
    },
    noteAttended: (at: number) => { state.attended = at; },
    getAttendedAt: () => state.attended,
    noteRunEnded: () => {},
  } as unknown as ProxyLoop;
  const socketPath = options.socketPath ?? join(root, 'shift.sock');
  const daemon = createShiftDaemon({
    socketPath,
    stateDir: root,
    loop,
    hub: fakeHub(pings, options.onPresence),
    now: () => 1234,
    startedAt: 99,
    conductorId: 'cnd_test',
    err: (line) => errors.push(line),
  });
  const run = daemon.run();
  const value = { root, socketPath, daemon, run, state, pings, errors };
  fixtures.push(value);
  return value;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(existsSync(path), true, `socket did not appear: ${path}`);
}

async function waitForSocketMode(path: string, mode: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (existsSync(path) && (lstatSync(path).mode & 0o777) !== mode && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(lstatSync(path).mode & 0o777, mode, `socket mode was not ${mode.toString(8)}: ${path}`);
}

async function waitForLoop(f: Fixture): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (f.state.resolveRun === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.notEqual(f.state.resolveRun, undefined, 'loop did not start');
}

async function stop(f: Fixture, reason: 'signal' | 'loop' = 'signal'): Promise<void> {
  await waitForLoop(f);
  f.daemon.stop(reason);
  await f.run;
}

async function rawResponse(path: string, writes: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      for (const write of writes) socket.write(write);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as unknown);
      } catch (error) {
        reject(error);
      }
      socket.destroy();
    });
    socket.on('error', reject);
  });
}

test('fragmented JSON, malformed requests, and oversized requests receive structured errors', async () => {
  const f = fixture();
  await waitForPath(f.socketPath);
  await waitForSocketMode(f.socketPath, 0o600);
  assert.deepEqual(await rawResponse(f.socketPath, ['{"op":"sta', 'tus"}\n']), {
    name: 'box', serve_pools: ['alpha'], cap: 3, free: 3, running: 0, attended_at: null, started_at: 99,
  });
  assert.deepEqual(await rawResponse(f.socketPath, ['not-json\n']), { error: 'malformed JSON request' });
  assert.deepEqual(await rawResponse(f.socketPath, ['{"op":"wat"}\n']), { error: "unknown operation 'wat'" });
  assert.deepEqual(await rawResponse(f.socketPath, ['x'.repeat(64 * 1024 + 1)]), {
    error: 'request line exceeds 65536 bytes',
  });
  await stop(f);
});

test('status, atomic clock-in validation, attendance, queued event drain, and wait timeout', async () => {
  const f = fixture();
  await waitForPath(f.socketPath);
  const before = await requestShift(f.socketPath, { op: 'status' });
  assert.equal('attended_at' in before && before.attended_at, null);

  const invalid = await requestShift(f.socketPath, { op: 'clock_in', name: '', serve_pools: ['beta'] });
  assert.deepEqual(invalid, { error: 'clock_in name must be a non-empty string of at most 200 characters' });
  assert.equal(f.state.name, 'box');
  assert.deepEqual(f.state.servePools, ['alpha']);
  assert.equal(f.state.cap, 3);
  assert.equal(f.state.stopped, false);
  assert.equal(f.state.childAlive, true);

  const clocked = await requestShift(f.socketPath, { op: 'clock_in', name: 'shift-b', serve_pools: ['beta'] });
  assert.equal('name' in clocked && clocked.name, 'shift-b');
  assert.deepEqual(f.state.servePools, ['beta']);

  f.daemon.onEvent({ type: 'failed', workflow: 'wf1', run: 'r1', step: 's', kind: 'exec', message: 'boom' });
  const attended = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  assert.deepEqual('events' in attended && attended.events, [{ type: 'failed', workflow: 'wf1', run: 'r1', step: 's', kind: 'exec', message: 'boom' }]);
  assert.equal(f.state.attended, 1234);

  const started = Date.now();
  const timeout = await requestShift(f.socketPath, { op: 'next', wait_ms: 20 });
  assert.ok(Date.now() - started < 500, 'wait timeout is bounded');
  assert.deepEqual('events' in timeout && timeout.events, []);
  await stop(f);
});

test('only one next parks, overlap preserves exact error, and end wakes the parked client', async () => {
  const f = fixture();
  await waitForPath(f.socketPath);
  const first = rawShiftRequest(f.socketPath, { op: 'next', wait_ms: 10_000 });
  while (f.state.attended === undefined) await new Promise((resolve) => setTimeout(resolve, 5));
  const overlap = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  assert.deepEqual(overlap, { error: OVERLAP_ERROR });

  const ending = requestShift(f.socketPath, { op: 'end' });
  const firstResponse = await first.response;
  assert.equal('events' in firstResponse, true);
  if ('events' in firstResponse) assert.deepEqual(firstResponse.events, [{ type: 'ended' }]);
  assert.deepEqual(await ending, { ok: true, ended: true });
  assert.equal(await f.run, 0);
  assert.equal(f.state.stopped, true);
});

test('event FIFO is bounded at 1000 entries and drops oldest entries with a warning', async () => {
  const f = fixture();
  await waitForPath(f.socketPath);
  for (let i = 0; i < 1_005; i++) {
    f.daemon.onEvent({ type: 'failed', workflow: 'wf', run: `r${i}`, step: 's', kind: 'exec', message: 'x' });
  }
  const response = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  assert.equal('events' in response, true);
  if ('events' in response) {
    assert.equal(response.events.length, 1_000);
    assert.equal((response.events[0] as { run?: string }).run, 'r5');
  }
  assert.equal(f.errors.length, 5);
  await stop(f);
});

test('end sends one attendance-clearing ping and leaves detached children alone', async () => {
  const f = fixture();
  await waitForPath(f.socketPath);
  await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  assert.equal(f.state.childAlive, true);
  assert.deepEqual(await requestShift(f.socketPath, { op: 'end' }), { ok: true, ended: true });
  assert.equal(f.pings.length, 1);
  assert.equal(f.pings[0]!.attended_at, undefined);
  assert.equal(f.state.childAlive, true);
});

test('active daemon refusal leaves the socket untouched', async () => {
  const first = fixture();
  await waitForPath(first.socketPath);
  const second = fixture({ socketPath: first.socketPath });
  await assert.rejects(second.run, /another daemon is active/);
  assert.equal(existsSync(first.socketPath), true);
  await stop(first);
});

test('stale socket recovery removes only a refused socket and binds a new daemon', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenwork-shift-stale-'));
  roots.push(root);
  const path = join(root, 'shift.sock');
  execFileSync('python3', ['-c', [
    'import socket, sys',
    'sock = socket.socket(socket.AF_UNIX)',
    'sock.bind(sys.argv[1])',
    'sock.close()',
  ].join('; '), path]);
  assert.equal(lstatSync(path).isSocket(), true);
  const f = fixture({ socketPath: path });
  await waitForPath(path);
  assert.equal(lstatSync(path).isSocket(), true);
  await stop(f);
});

test('regular files, directories, and symlinks are never removed as stale sockets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenwork-shift-nonsocket-'));
  roots.push(root);
  for (const kind of ['file', 'directory', 'symlink'] as const) {
    const path = join(root, kind);
    if (kind === 'file') writeFileSync(path, 'keep');
    else if (kind === 'directory') mkdirSync(path);
    else {
      const target = join(root, 'target');
      writeFileSync(target, 'target');
      symlinkSync(target, path);
    }
    const f = fixture({ socketPath: path });
    await assert.rejects(f.run, /exists and is not a socket/);
    assert.equal(lstatSync(path).isSymbolicLink(), kind === 'symlink');
  }
});

test('inode-safe cleanup does not remove a successor socket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenwork-shift-inode-'));
  roots.push(root);
  let enteredFinal: () => void = () => {};
  let releaseFinal: () => void = () => {};
  const finalStarted = new Promise<void>((resolve) => { enteredFinal = resolve; });
  const finalRelease = new Promise<void>((resolve) => { releaseFinal = resolve; });
  const f = fixture({
    socketPath: join(root, 'shift.sock'),
    onPresence: async (request) => {
      if (request.attended_at === undefined) {
        enteredFinal();
        await finalRelease;
      }
    },
  });
  await waitForPath(f.socketPath);
  const ending = requestShift(f.socketPath, { op: 'end' });
  await finalStarted;
  unlinkSync(f.socketPath);
  const successor = createServer(() => {});
  await new Promise<void>((resolve) => successor.listen(f.socketPath, resolve));
  releaseFinal();
  assert.deepEqual(await ending, { ok: true, ended: true });
  await f.run;
  await waitForPath(f.socketPath);
  assert.equal(existsSync(f.socketPath), true);
  await new Promise<void>((resolve) => successor.close(() => resolve()));
  try { unlinkSync(f.socketPath); } catch { /* close may already remove it */ }
});

test('signal shutdown cleans the socket without sending the explicit end clear ping', async () => {
  for (const reason of ['signal', 'loop'] as const) {
    const f = fixture();
    await waitForPath(f.socketPath);
    await stop(f, reason);
    assert.equal(existsSync(f.socketPath), false);
    assert.deepEqual(f.pings, []);
  }
});
