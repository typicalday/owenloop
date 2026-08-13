import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import type { HubClient } from '../src/hub/client.ts';
import type { ShiftLoop } from '../src/shift/loop.ts';
import { createShiftDaemon, type ShiftDaemon } from '../src/shift/server.ts';
import {
  MAX_EVENT_QUEUE,
  MAX_RESPONSE_LINE_BYTES,
  OVERLAP_ERROR,
  RESPONSE_TRUNCATION_MARKER,
  stampShiftEvent,
  type GateEvent,
  type ShiftEvent,
  type ShiftEventBody,
} from '../src/shift/protocol.ts';
import { requestShift } from '../src/shift/client.ts';
import { rawShiftRequest } from './helpers/shift-client.ts';

interface FakeState {
  name: string;
  serveCrews: string[];
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
  /** Everything the daemon handed straight to the log sink, bypassing the FIFO. */
  synthesized: ShiftEvent[];
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
  /** Throw from the log sink, to drive the overflow report's own failure path. */
  synthesizedThrows?: boolean;
} = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-server-'));
  roots.push(root);
  const state: FakeState = {
    name: 'box', serveCrews: ['alpha'], cap: 3, stopped: false, childAlive: true,
  };
  const pings: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const synthesized: ShiftEvent[] = [];
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
    getShift: () => ({ name: state.name, serveCrews: [...state.serveCrews] }),
    setShift: (next: { name?: string; serveCrews?: string[] }) => {
      if (next.name !== undefined) state.name = next.name;
      if (next.serveCrews !== undefined) state.serveCrews = [...next.serveCrews];
      return { name: state.name, serveCrews: [...state.serveCrews] };
    },
    noteAttended: (at: number) => { state.attended = at; },
    getAttendedAt: () => state.attended,
    noteRunEnded: () => {},
  } as unknown as ShiftLoop;
  const socketPath = options.socketPath ?? join(root, 'shift.sock');
  const daemon = createShiftDaemon({
    socketPath,
    stateDir: root,
    loop,
    hub: fakeHub(pings, options.onPresence),
    now: () => 1234,
    startedAt: 99,
    shiftId: 'shf_test',
    err: (line) => errors.push(line),
    onSynthesized: (event) => {
      if (options.synthesizedThrows === true) throw new Error('sink exploded');
      synthesized.push(event);
    },
  });
  const run = daemon.run();
  const value = { root, socketPath, daemon, run, state, pings, errors, synthesized };
  fixtures.push(value);
  return value;
}

/**
 * Stamp an event body with the `{ts, shift, shiftId}` envelope every `ShiftEvent`
 * now carries.
 *
 * In production the loop's `emit()` stamps; here the loop is a fake, so the test
 * stamps with the SAME identity the fixture gives the daemon (`now: () => 1234`,
 * shift name `box`, id `shf_test`). Using the fixture's own values is what makes
 * a stamped expectation comparable to what the daemon returns.
 */
function ev(body: ShiftEventBody): ShiftEvent {
  return stampShiftEvent(body, { name: 'box', id: 'shf_test' }, 1234);
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
    name: 'box', serve_crews: ['alpha'], cap: 3, free: 3, running: 0, attended_at: null, started_at: 99,
  });
  assert.deepEqual(await rawResponse(f.socketPath, ['not-json\n']), { error: 'malformed JSON request' });
  assert.deepEqual(await rawResponse(f.socketPath, ['{"op":"wat"}\n']), { error: "unknown operation 'wat'" });
  assert.deepEqual(await rawResponse(f.socketPath, ['x'.repeat(64 * 1024 + 1)]), {
    error: 'request line exceeds 65536 bytes',
  });
  await stop(f);
});

test('status, atomic clock-in validation, attendance, typed gate event drain, and wait timeout', async () => {
  const f = fixture();
  await waitForPath(f.socketPath);
  const before = await requestShift(f.socketPath, { op: 'status' });
  assert.equal('attended_at' in before && before.attended_at, null);

  const invalid = await requestShift(f.socketPath, { op: 'clock_in', name: '', serve_crews: ['beta'] });
  assert.deepEqual(invalid, { error: 'clock_in name must be a non-empty string of at most 200 characters' });
  assert.equal(f.state.name, 'box');
  assert.deepEqual(f.state.serveCrews, ['alpha']);
  assert.equal(f.state.cap, 3);
  assert.equal(f.state.stopped, false);
  assert.equal(f.state.childAlive, true);

  const clocked = await requestShift(f.socketPath, { op: 'clock_in', name: 'shift-b', serve_crews: ['beta'] });
  assert.equal('name' in clocked && clocked.name, 'shift-b');
  assert.deepEqual(f.state.serveCrews, ['beta']);

  const failed = ev({ type: 'failed', workflow: 'wf1', run: 'r1', step: 's', kind: 'exec', message: 'boom' });
  const gate = ev({
    type: 'gate',
    workflow: 'wf_gate',
    run: 'run_gate',
    name: 'approval',
    question: 'Should the gate continue?',
  } satisfies GateEvent);
  f.daemon.onEvent(failed);
  f.daemon.onEvent(gate);
  const attended = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  assert.deepEqual('events' in attended && attended.events, [failed, gate]);
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
  if ('events' in firstResponse) assert.deepEqual(firstResponse.events, [ev({ type: 'ended' })]);
  assert.deepEqual(await ending, { ok: true, ended: true });
  assert.equal(await f.run, 0);
  assert.equal(f.state.stopped, true);
});

test('event FIFO is bounded at 1000 entries and drops oldest entries with a warning', async () => {
  const f = fixture();
  await waitForPath(f.socketPath);
  for (let i = 0; i < 1_005; i++) {
    f.daemon.onEvent(ev({ type: 'failed', workflow: 'wf', run: `r${i}`, step: 's', kind: 'exec', message: 'x' }));
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

test('queue overflow reports to the log sink at each power of ten, never through the FIFO', async () => {
  const f = fixture();
  await waitForPath(f.socketPath);

  // 1,000 events fill the FIFO without evicting anything; each of the next 100
  // evicts exactly one. So `dropped` climbs 1..100 and crosses three powers of
  // ten: 1, 10, 100.
  const total = MAX_EVENT_QUEUE + 100;
  for (let i = 0; i < total; i++) {
    f.daemon.onEvent(ev({ type: 'failed', workflow: 'wf', run: `r${i}`, step: 's', kind: 'exec', message: 'x' }));
  }

  // Every eviction still writes the free-text warning — that line is unchanged
  // and unthrottled; only the structured record is rate-limited.
  assert.equal(f.errors.length, 100);
  assert.deepEqual([...new Set(f.errors)], ['shift event queue overflow — dropping oldest event']);

  // Three records, at cumulative totals 1, 10 and 100 — not one per eviction,
  // and not just the first.
  assert.deepEqual(f.synthesized, [
    ev({ type: 'event-queue-overflow', dropped: 1 }),
    ev({ type: 'event-queue-overflow', dropped: 10 }),
    ev({ type: 'event-queue-overflow', dropped: 100 }),
  ]);
  // Spelled out, because deepEqual against `ev()` passes even if BOTH sides
  // lose the envelope: each record carries `{ts, shift, shiftId}`.
  for (const record of f.synthesized) {
    assert.equal(record.ts, new Date(1234).toISOString());
    assert.equal(record.shift, 'box');
    assert.equal(record.shiftId, 'shf_test');
  }

  // The overflow record went to the sink ONLY. Had it been routed through
  // enqueue(), it would sit in the FIFO and be drained here — and it would have
  // evicted a real event to make room, under exactly the load that overflowed.
  const response = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  assert.equal('events' in response, true);
  if ('events' in response) {
    assert.equal(response.events.length, MAX_EVENT_QUEUE);
    assert.equal(response.events.some((event) => event.type === 'event-queue-overflow'), false);
    // Drop-oldest, so the survivors are the LAST 1,000 of the 1,100 pushed.
    assert.equal((response.events[0] as { run?: string }).run, 'r100');
    assert.equal((response.events.at(-1) as { run?: string }).run, `r${total - 1}`);
  }
  await stop(f);
});

test('a throwing log sink cannot kill the overflow path or the daemon', async () => {
  const f = fixture({ synthesizedThrows: true });
  await waitForPath(f.socketPath);

  for (let i = 0; i < MAX_EVENT_QUEUE + 10; i++) {
    f.daemon.onEvent(ev({ type: 'failed', workflow: 'wf', run: `r${i}`, step: 's', kind: 'exec', message: 'x' }));
  }

  // The sink threw on both attempted records (dropped 1 and dropped 10). The
  // failure is reported as free text — turning it into an event would write it
  // to the sink that just failed.
  const sinkFailures = f.errors.filter((line) => line.startsWith('shift event sink failed'));
  assert.deepEqual(sinkFailures, [
    'shift event sink failed: sink exploded (continuing)',
    'shift event sink failed: sink exploded (continuing)',
  ]);
  // Every eviction was still warned about, and every event still reached the FIFO.
  assert.equal(f.errors.length - sinkFailures.length, 10);

  // Still serving: the throw propagated out of neither onEvent nor the socket.
  const response = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  assert.equal('events' in response, true);
  if ('events' in response) assert.equal(response.events.length, MAX_EVENT_QUEUE);
  assert.deepEqual(await requestShift(f.socketPath, { op: 'status' }), {
    // `attended_at` is 1234, not null: the `next` above was served, which is
    // itself the proof the daemon survived the throwing sink.
    name: 'box', serve_crews: ['alpha'], cap: 3, free: 3, running: 0, attended_at: 1234, started_at: 99,
  });
  await stop(f);
});

test('a legal 1,000-event response with 200-character steps fits the client ceiling', async () => {
  const f = fixture();
  await waitForPath(f.socketPath);
  const workflow = `wf_${'w'.repeat(32)}`;
  const run = `run_${'r'.repeat(32)}`;
  const step = 's'.repeat(200);
  for (let i = 0; i < 1_000; i++) {
    f.daemon.onEvent(ev({ type: 'dispatched', workflow, run: `${run}_${i}`, step, kind: 'agent-run', pid: 123456 }));
  }
  const response = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  assert.equal('events' in response, true);
  if ('events' in response) {
    assert.equal(response.events.length, 1_000);
    assert.ok(Buffer.byteLength(`${JSON.stringify(response)}\n`, 'utf8') <= MAX_RESPONSE_LINE_BYTES);
  }
  await stop(f);
});

test('size-aware event drain retains events that exceed one response and preserves order', async () => {
  const f = fixture();
  await waitForPath(f.socketPath);
  const message = 'é'.repeat(150_000);
  for (let i = 0; i < 3; i++) {
    f.daemon.onEvent(ev({ type: 'failed', workflow: 'wf', run: `r${i}`, step: 's', kind: 'exec', message }));
  }

  const first = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  const second = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  const third = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  const empty = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  for (const [response, run] of [[first, 'r0'], [second, 'r1'], [third, 'r2']] as const) {
    assert.equal('events' in response, true);
    if ('events' in response) {
      assert.equal(response.events.length, 1);
      assert.equal((response.events[0] as { run?: string }).run, run);
      assert.ok(Buffer.byteLength(`${JSON.stringify(response)}\n`, 'utf8') <= MAX_RESPONSE_LINE_BYTES);
    }
  }
  assert.deepEqual('events' in empty && empty.events, []);
  await stop(f);
});

test('an oversized single event is delivered once with an explicit truncation marker', async () => {
  const f = fixture();
  await waitForPath(f.socketPath);
  f.daemon.onEvent(ev({
    type: 'failed', workflow: 'wf', run: 'r0', step: 's', kind: 'exec', message: '💥'.repeat(200_000),
  }));

  const response = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  assert.equal('events' in response, true);
  if ('events' in response) {
    assert.equal(response.events.length, 1);
    const event = response.events[0] as { message?: string };
    assert.equal(typeof event.message, 'string');
    assert.equal(event.message?.endsWith(RESPONSE_TRUNCATION_MARKER), true);
    assert.ok(Buffer.byteLength(`${JSON.stringify(response)}\n`, 'utf8') <= MAX_RESPONSE_LINE_BYTES);
  }

  const empty = await requestShift(f.socketPath, { op: 'next', wait_ms: 0 });
  assert.deepEqual('events' in empty && empty.events, []);
  await stop(f);
});

test('end lets the daemon process exit while a responded client stops reading', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-unread-'));
  roots.push(root);
  const socketPath = join(root, 'shift.sock');
  const serverModule = new URL('../src/shift/server.ts', import.meta.url).href;
  const childScript = join(root, 'daemon.mjs');
  writeFileSync(childScript, [
    `import { createShiftDaemon } from ${JSON.stringify(serverModule)};`,
    "const socketPath = process.argv[2];",
    "let resolveLoop;",
    "const loop = {",
    "  run: () => new Promise((resolve) => { resolveLoop = resolve; }),",
    "  stop: () => resolveLoop?.(0),",
    "  freeCapacity: () => 0,",
    "  getCap: () => 0,",
    "  getShift: () => ({ name: 'box', serveCrews: ['alpha'] }),",
    "  setShift: () => ({ name: 'box', serveCrews: ['alpha'] }),",
    "  noteAttended: () => {},",
    "  getAttendedAt: () => undefined,",
    "};",
    "const hub = { presencePing: async () => ({ text: '', ok: true, name: 'box', lastSeen: 1 }) };",
    "const daemon = createShiftDaemon({ socketPath, stateDir: socketPath.slice(0, socketPath.lastIndexOf('/')), loop, hub, now: () => 1, startedAt: 1, err: console.error });",
    "const message = 'x'.repeat(16 * 1024);",
    "for (let i = 0; i < 1000; i++) daemon.onEvent({ type: 'failed', workflow: 'wf', run: `run_${i}`, step: 'step', kind: 'exec', message });",
    "daemon.run().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });",
  ].join('\n'));
  const daemon = spawn(process.execPath, [childScript, socketPath], { stdio: ['ignore', 'ignore', 'inherit'] });
  const daemonExit = new Promise<number | null>((resolve, reject) => {
    daemon.once('error', reject);
    daemon.once('exit', (code) => resolve(code));
  });
  await waitForPath(socketPath);
  const unread = spawn('python3', ['-c', [
    'import select, socket, sys, time',
    'sock = socket.socket(socket.AF_UNIX)',
    'sock.connect(sys.argv[1])',
    'sock.sendall(b\'{"op":"next","wait_ms":0}\\n\')',
    'print("ready", flush=True)',
    'deadline = time.monotonic() + 2.0',
    'while time.monotonic() < deadline:',
    '    readable, _, _ = select.select([sock], [], [], 0.05)',
    '    if not readable: continue',
    '    try: data = sock.recv(1, socket.MSG_PEEK)',
    '    except OSError: sys.exit(0)',
    '    if not data: sys.exit(0)',
    'sys.exit(2)',
  ].join('\n'), socketPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise<void>((resolve, reject) => {
    unread.stdout!.once('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) resolve();
      else reject(new Error(`unread client output: ${chunk.toString()}`));
    });
    unread.once('error', reject);
  });
  const unreadExit = new Promise<number | null>((resolve) => unread.once('exit', (code) => resolve(code)));
  try {
    await waitForPath(socketPath);
    await ready;
    assert.deepEqual(await requestShift(socketPath, { op: 'end' }), { ok: true, ended: true });
    const exitCode = await Promise.race([
      daemonExit,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('daemon stayed alive with unread client')), 1_500)),
    ]);
    assert.equal(exitCode, 0);
  } finally {
    if (daemon.exitCode === null) daemon.kill('SIGKILL');
    if (unread.exitCode === null) unread.kill('SIGKILL');
    await Promise.allSettled([daemonExit, unreadExit]);
  }
});

test('shutdown destroys a connection accepted after the initial teardown pass', async () => {
  let enteredFinal: () => void = () => {};
  let releaseFinal: () => void = () => {};
  const finalStarted = new Promise<void>((resolve) => { enteredFinal = resolve; });
  const finalRelease = new Promise<void>((resolve) => { releaseFinal = resolve; });
  const f = fixture({
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
  const late = createConnection(f.socketPath);
  await new Promise<void>((resolve, reject) => {
    late.once('connect', () => {
      late.write('{"op":"status"');
      resolve();
    });
    late.once('error', reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(late.destroyed, true);
  releaseFinal();
  assert.deepEqual(await ending, { ok: true, ended: true });
  await f.run;
  late.destroy();
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
  const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-stale-'));
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

test('a crashed startup lock is recovered by probing its stale lock socket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-stale-lock-'));
  roots.push(root);
  const path = join(root, 'shift.sock');
  execFileSync('python3', ['-c', [
    'import socket, sys',
    'sock = socket.socket(socket.AF_UNIX)',
    'sock.bind(sys.argv[1])',
    'sock.close()',
  ].join('; '), `${path}.lock`]);
  assert.equal(lstatSync(`${path}.lock`).isSocket(), true);
  const f = fixture({ socketPath: path });
  await waitForPath(path);
  assert.equal(existsSync(`${path}.lock`), false);
  await stop(f);
});

test('regular files, directories, and symlinks are never removed as stale sockets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-nonsocket-'));
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
  const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-inode-'));
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
