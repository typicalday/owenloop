/**
 * Terminal-shaped acceptance coverage for the public shift daemon.
 *
 * The daemon runs as one real foreground child. Separate real CLI children act
 * as the two blocking terminals and the third terminal that ends the shift.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { writeBundle } from '../src/bundle/cache.ts';
import type { CachedBundle } from '../src/bundle/types.ts';
import { defInstructionDigest } from '../../../src/order-resolver.ts';
import { finalizeDefs, loadDefFile } from '../../../src/defs.ts';
import { installSignedBundleFixture, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import { readChildRecords } from '../src/shift/state.ts';
import { OVERLAP_ERROR } from '../src/shift/protocol.ts';
import { spawnShift, type ShiftChild } from './helpers/shift-client.ts';
import { startMockHub, until, type HubReq } from './helpers/mcp-stdio-client.ts';

const BIN = fileURLToPath(new URL('../../../bin/owenloop.mjs', import.meta.url));
const TOKEN = 'tok-shift-blocking-acceptance';

interface CommandResult {
  child: ChildProcess;
  result: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

let root: string;
let home: string;
let localDefDigest = '';
let configDir: string;
let cacheDir: string;
let stateDir: string;
let shift: ShiftChild | undefined;
let commands: CommandResult[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-shift-blocking-'));
  home = join(root, 'home');
  configDir = join(root, 'config');
  cacheDir = join(root, 'cache');
  stateDir = join(root, 'state');
  shift = undefined;
  commands = [];

  const workflow = `name: demo
inputs:
  - name: seed
    seedOwed: true
steps:
  - name: cmd
    consumes: [seed]
    produces: [result]
    terminal: true
    executor: command
    command: 'sleep 5'
    body: ""
`;
  const sourceDir = writeBundleSource({ name: 'demo', workflow });
  const installed = await installSignedBundleFixture({
    sourceDir,
    root: join(home, '.owenloop', 'workflows'),
    home,
    configHome: configDir,
  });
  const loaded = loadDefFile(join(installed.result.objectPath, 'workflow.yaml'));
  const definition = finalizeDefs(new Map([[loaded.name, loaded]])).get(loaded.name);
  assert.ok(definition !== undefined);
  localDefDigest = defInstructionDigest(definition);
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function stopDetachedExecutions(): Promise<void> {
  const records = readChildRecords(stateDir);
  for (const record of records) {
    try {
      process.kill(record.pid, 'SIGTERM');
    } catch {
      // The detached child may have exited between the state read and signal.
    }
  }
  if (records.length === 0) return;
  await until(
    () => records.every((record) => !processIsAlive(record.pid)),
    `detached executions to exit (${records.map((record) => record.pid).join(', ')})`,
    10_000,
  );
}

function makeWritableTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) makeWritableTree(join(path, child));
    chmodSync(path, 0o755);
  } else {
    chmodSync(path, 0o644);
  }
}

afterEach(async () => {
  const daemon = shift;
  daemon?.child.kill('SIGKILL');
  for (const command of commands) {
    if (command.child.exitCode === null) command.child.kill('SIGKILL');
  }
  await Promise.allSettled([
    ...(daemon === undefined ? [] : [daemon.exited]),
    ...commands.map((command) => command.result),
  ]);
  await stopDetachedExecutions();
  if (lstatSync(root, { throwIfNoEntry: false })) makeWritableTree(root);
  rmSync(root, { recursive: true, force: true });
});

function env(): Record<string, string | undefined> {
  return {
    HOME: home,
    OWENLOOP_TOKEN: TOKEN,
    XDG_CONFIG_HOME: configDir,
    NODE_NO_WARNINGS: '1',
  };
}

function runCli(args: string[], extraEnv: Record<string, string | undefined> = env()): CommandResult {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  const command = { child, result };
  commands.push(command);
  return command;
}

function jsonResult<T>(result: { stdout: string }): T {
  return JSON.parse(result.stdout) as T;
}

function requests(reqs: HubReq[], verb: string): HubReq[] {
  return reqs.filter((request) => request.verb === verb);
}

function orderPacket() {
  return {
    run: 'run_blocking',
    workflow: 'wf_blocking',
    step: 'cmd',
    key: 'cmd',
    inputs: [],
    outputs: ['result'],
    worker: 'command',
    defDigest: localDefDigest,
    consumes: {},
    owes: [{ path: 'result', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
}

test('idle next blocks, dispatch wakes it, a second next parks, and a third terminal ends the shift', async () => {
  let dispatchEnabled = false;
  let dispatchAt: number | undefined;
  let orderVisible = true;
  const order = orderPacket();
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: 'hash-blocking', steps: [{ name: 'cmd', executor: 'command' }] },
    fetchedAt: 0,
    origin: 'acceptance-test',
  };
  writeBundle(cacheDir, bundle, []);

  const { origin, reqs, server } = await startMockHub((verb, body) => {
    if (verb === 'presence_ping') return { text: '', ok: true, name: String(body?.['name'] ?? 'shift'), lastSeen: Date.now() };
    if (verb === 'wake') return { text: '', cursor: dispatchEnabled ? 2 : 1, changed: dispatchEnabled };
    if (verb === 'whats_next') {
      if (body?.['workflow'] === undefined) {
        return {
          text: '',
          instances: [{ workflow: 'wf_blocking', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }],
        };
      }
      if (dispatchEnabled && orderVisible) {
        orderVisible = false;
        dispatchAt = Date.now();
        return { text: '', workflow: 'wf_blocking', def: 'demo', orders: [{
          workflow: 'wf_blocking',
          run: 'run_blocking',
          step: 'cmd',
          prompt: '',
          consumes: {},
          expected_outputs: [],
          feedback: [],
          advisory: {},
          submit_hint: '',
        }] };
      }
      return { text: '', workflow: 'wf_blocking', def: 'demo', orders: [] };
    }
    if (verb === 'get_order') return { text: '', workflow: 'wf_blocking', run: 'run_blocking', order, lease: { claimed: true } };
    if (verb === 'heartbeat') return { text: '' };
    if (verb === 'submit') return { text: '', outcome: 'green', closed: true };
    if (verb === 'release') return { text: '', released: true };
    return { text: '' };
  });

  try {
    const noDaemon = runCli(['shift', 'status', '--state-dir', stateDir]);
    const noDaemonResult = await noDaemon.result;
    assert.equal(noDaemonResult.code, 0);
    assert.deepEqual(jsonResult(noDaemonResult), { status: 'no daemon', socket: join(stateDir, 'shift.sock') });

    shift = spawnShift(
      ['crew-blocking', '--origin', origin, '--cap', '1', '--poll-interval', '25', '--cache-dir', cacheDir, '--state-dir', stateDir],
      env(),
    );
    await shift.ready;

    const unattended = runCli(['shift', 'status', '--state-dir', stateDir]);
    const unattendedResult = await unattended.result;
    assert.equal(unattendedResult.code, 0);
    const unattendedStatus = jsonResult<{ attended_at: number | null; serve_crews: string[] }>(unattendedResult);
    assert.equal(unattendedStatus.attended_at, null);
    assert.deepEqual(unattendedStatus.serve_crews, ['crew-blocking']);

    const firstNext = runCli(['shift', 'next', '--wait', '90', '--state-dir', stateDir]);
    await until(
      () => requests(reqs, 'presence_ping').some((request) => request.body?.['attended_at'] !== undefined),
      'the first blocking next to record attendance',
    );

    const stillBlocked = await Promise.race([
      firstNext.result.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100)),
    ]);
    assert.equal(stillBlocked, true, 'idle shift next --wait 90 must remain blocked');

    const attended = runCli(['shift', 'status', '--state-dir', stateDir]);
    const attendedResult = await attended.result;
    assert.equal(attendedResult.code, 0);
    const attendedStatus = jsonResult<{ attended_at: number | null }>(attendedResult);
    assert.equal(typeof attendedStatus.attended_at, 'number');

    dispatchEnabled = true;
    const firstResult = await firstNext.result;
    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.notEqual(dispatchAt, undefined, 'the fake hub must observe a dispatched order');
    const dispatchLatency = Date.now() - dispatchAt!;
    assert.ok(dispatchLatency < 2_000, `dispatch-to-return latency was ${dispatchLatency}ms`);
    const firstResponse = jsonResult<{ events: Array<{ type: string }> }>(firstResult);
    assert.ok(firstResponse.events.some((event) => event.type === 'dispatched'), JSON.stringify(firstResponse));

    const secondNext = runCli(['shift', 'next', '--wait', '90', '--state-dir', stateDir]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Also the guard on which records may reach the socket: a shift that is
    // merely FULL has nothing to report to a parked client, and a `capacity`
    // record queued here would satisfy this call instantly. That record is
    // file-only for exactly this reason — see FILE_ONLY_EVENTS in runtime.ts.
    assert.equal(secondNext.child.exitCode, null, 'the second terminal next must park while no event is available');

    const presenceBeforeEnd = requests(reqs, 'presence_ping').length;
    const ending = runCli(['shift', 'end', '--state-dir', stateDir]);
    const endedResult = await ending.result;
    assert.equal(endedResult.code, 0, endedResult.stderr);
    assert.deepEqual(jsonResult(endedResult), { ok: true, ended: true });

    const secondResult = await secondNext.result;
    assert.equal(secondResult.code, 0, secondResult.stderr);
    // The envelope's `ts`, `shift`, and `shiftId` are produced by a REAL shift
    // process here, so their values cannot be predicted — only their presence
    // and shape. The `ended` event is checked field by field for that reason.
    const secondResponse = jsonResult<{
      events: Array<{ type: string; ts?: string; shift?: string; shiftId?: string }>;
    }>(secondResult);
    assert.equal(secondResponse.events.length, 1, JSON.stringify(secondResponse.events));
    const ended = secondResponse.events[0]!;
    // Strip the three unpredictable envelope fields and assert the EXACT shape
    // of what remains. This keeps the "an `ended` event carries no other
    // payload" property that a field-by-field check would silently drop if a
    // future change added a key.
    const { ts, shift: shiftName, shiftId, ...rest } = ended;
    assert.deepEqual(rest, { type: 'ended' });
    assert.equal(typeof shiftName, 'string');
    assert.notEqual(shiftName, '', 'a real shift always names itself');
    assert.match(shiftId ?? '', /^shf_/u);
    assert.equal(new Date(ts ?? '').toISOString(), ts);

    const exited = await shift.exited;
    assert.equal(exited, 0, shift.stderr());

    const afterEnd = runCli(['shift', 'status', '--state-dir', stateDir]);
    const afterEndResult = await afterEnd.result;
    assert.equal(afterEndResult.code, 0);
    assert.deepEqual(jsonResult(afterEndResult), { status: 'no daemon', socket: join(stateDir, 'shift.sock') });

    await until(
      () => requests(reqs, 'presence_ping').length > presenceBeforeEnd,
      'the post-attendance final presence ping',
    );
    const postEndPings = requests(reqs, 'presence_ping').slice(presenceBeforeEnd);
    const finalPing = postEndPings[postEndPings.length - 1];
    assert.ok(finalPing, 'the final presence ping must occur after attendance');
    assert.equal(Object.hasOwn(finalPing.body ?? {}, 'attended_at'), false);
  } finally {
    shift?.child.kill('SIGKILL');
    server.close();
  }
});

test('terminal-only daemon dispatches before any shift next and keeps presence unattended', async () => {
  let orderVisible = true;
  const order = orderPacket();
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: 'hash-terminal-only', steps: [{ name: 'cmd', executor: 'command' }] },
    fetchedAt: 0,
    origin: 'acceptance-test',
  };
  writeBundle(cacheDir, bundle, []);

  const { origin, reqs, server } = await startMockHub((verb, body) => {
    if (verb === 'presence_ping') return { text: '', ok: true, name: String(body?.['name'] ?? 'shift'), lastSeen: Date.now() };
    if (verb === 'wake') return { text: '', cursor: 2, changed: true };
    if (verb === 'whats_next') {
      if (body?.['workflow'] === undefined) {
        return {
          text: '',
          instances: [{ workflow: 'wf_blocking', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }],
        };
      }
      if (orderVisible) {
        orderVisible = false;
        return { text: '', workflow: 'wf_blocking', def: 'demo', orders: [{
          workflow: 'wf_blocking',
          run: 'run_blocking',
          step: 'cmd',
          prompt: '',
          consumes: {},
          expected_outputs: [],
          feedback: [],
          advisory: {},
          submit_hint: '',
        }] };
      }
      return { text: '', workflow: 'wf_blocking', def: 'demo', orders: [] };
    }
    if (verb === 'get_order') return { text: '', workflow: 'wf_blocking', run: 'run_blocking', order, lease: { claimed: true } };
    if (verb === 'heartbeat') return { text: '' };
    if (verb === 'submit') return { text: '', outcome: 'green', closed: true };
    if (verb === 'release') return { text: '', released: true };
    return { text: '' };
  });

  try {
    const daemon = spawnShift(
      ['crew-terminal-only', '--origin', origin, '--cap', '1', '--poll-interval', '25', '--cache-dir', cacheDir, '--state-dir', stateDir],
      env(),
    );
    shift = daemon;
    await daemon.ready;

    await until(
      () => requests(reqs, 'get_order').some((request) => request.body?.['workflow'] === 'wf_blocking'),
      'the unattended daemon to claim the visible order',
    );
    assert.equal(daemon.child.exitCode, null, 'the foreground daemon must remain alive before attendance');
    const preAttendancePings = requests(reqs, 'presence_ping');
    assert.ok(preAttendancePings.length > 0, 'the daemon must ping presence before attendance');
    assert.ok(
      preAttendancePings.every((request) => !Object.hasOwn(request.body ?? {}, 'attended_at')),
      JSON.stringify(preAttendancePings),
    );

    const next = runCli(['shift', 'next', '--wait', '0', '--state-dir', stateDir]);
    const nextResult = await next.result;
    assert.equal(nextResult.code, 0, nextResult.stderr);
    const response = jsonResult<{ events: Array<{ type: string; workflow?: string; run?: string }> }>(nextResult);
    assert.ok(
      response.events.some((event) => event.type === 'dispatched' && event.workflow === 'wf_blocking' && event.run === 'run_blocking'),
      JSON.stringify(response),
    );

    const ending = runCli(['shift', 'end', '--state-dir', stateDir]);
    const endedResult = await ending.result;
    assert.equal(endedResult.code, 0, endedResult.stderr);
    assert.deepEqual(jsonResult(endedResult), { ok: true, ended: true });
    assert.equal(await daemon.exited, 0, daemon.stderr());
  } finally {
    shift?.child.kill('SIGKILL');
    server.close();
  }
});

test('attending shift survives cancellation and dispatches while no client is parked', async () => {
  let dispatchEnabled = false;
  let orderVisible = true;
  const order = orderPacket();
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: 'hash-attending-cancel', steps: [{ name: 'cmd', executor: 'command' }] },
    fetchedAt: 0,
    origin: 'acceptance-test',
  };
  writeBundle(cacheDir, bundle, []);

  const { origin, reqs, server } = await startMockHub((verb, body) => {
    if (verb === 'presence_ping') return { text: '', ok: true, name: String(body?.['name'] ?? 'shift'), lastSeen: Date.now() };
    if (verb === 'wake') return { text: '', cursor: dispatchEnabled ? 2 : 1, changed: dispatchEnabled };
    if (verb === 'whats_next') {
      if (body?.['workflow'] === undefined) {
        return {
          text: '',
          instances: [{ workflow: 'wf_blocking', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }],
        };
      }
      if (dispatchEnabled && orderVisible) {
        orderVisible = false;
        return { text: '', workflow: 'wf_blocking', def: 'demo', orders: [{
          workflow: 'wf_blocking',
          run: 'run_blocking',
          step: 'cmd',
          prompt: '',
          consumes: {},
          expected_outputs: [],
          feedback: [],
          advisory: {},
          submit_hint: '',
        }] };
      }
      return { text: '', workflow: 'wf_blocking', def: 'demo', orders: [] };
    }
    if (verb === 'get_order') return { text: '', workflow: 'wf_blocking', run: 'run_blocking', order, lease: { claimed: true } };
    if (verb === 'heartbeat') return { text: '' };
    if (verb === 'submit') return { text: '', outcome: 'green', closed: true };
    if (verb === 'release') return { text: '', released: true };
    return { text: '' };
  });

  try {
    const daemon = spawnShift(
      ['crew-attending-cancel', '--origin', origin, '--cap', '1', '--poll-interval', '25', '--cache-dir', cacheDir, '--state-dir', stateDir],
      env(),
    );
    shift = daemon;
    await daemon.ready;

    const attendee = runCli(['shift', 'next', '--wait', '90', '--state-dir', stateDir]);
    await until(
      () => requests(reqs, 'presence_ping').some((request) => request.body?.['attended_at'] !== undefined),
      'the attending next to record attendance',
    );
    assert.equal(daemon.child.exitCode, null, 'the daemon must be alive while the attendee is parked');

    if (attendee.child.exitCode === null) attendee.child.kill('SIGTERM');
    await attendee.result;
    assert.ok(
      attendee.child.exitCode !== null || attendee.child.signalCode !== null,
      'the cancelled attendee must exit before dispatch is enabled',
    );

    let probeResponse: { events?: Array<{ type: string }>; error?: string } | undefined;
    const probeDeadline = Date.now() + 2_000;
    while (probeResponse === undefined && Date.now() < probeDeadline) {
      const probe = runCli(['shift', 'next', '--wait', '0', '--state-dir', stateDir]);
      const probeResult = await probe.result;
      assert.equal(probeResult.code, 0, probeResult.stderr);
      const parsed = jsonResult<{ events?: Array<{ type: string }>; error?: string }>(probeResult);
      if (parsed.error !== OVERLAP_ERROR) probeResponse = parsed;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(probeResponse, 'the cancelled attendee must release the single parked slot');
    assert.equal(probeResponse.error, undefined, JSON.stringify(probeResponse));
    assert.deepEqual(probeResponse.events, []);

    dispatchEnabled = true;
    await until(
      () => requests(reqs, 'get_order').some((request) => request.body?.['workflow'] === 'wf_blocking'),
      'the daemon to dispatch after attendee cancellation',
    );
    assert.equal(daemon.child.exitCode, null, 'the daemon must remain alive after the attendee exits');

    const replacement = runCli(['shift', 'next', '--wait', '0', '--state-dir', stateDir]);
    const replacementResult = await replacement.result;
    assert.equal(replacementResult.code, 0, replacementResult.stderr);
    const replacementResponse = jsonResult<{ events: Array<{ type: string; workflow?: string; run?: string }> }>(replacementResult);
    assert.ok(
      replacementResponse.events.some((event) => event.type === 'dispatched' && event.workflow === 'wf_blocking' && event.run === 'run_blocking'),
      JSON.stringify(replacementResponse),
    );

    const ending = runCli(['shift', 'end', '--state-dir', stateDir]);
    const endedResult = await ending.result;
    assert.equal(endedResult.code, 0, endedResult.stderr);
    assert.deepEqual(jsonResult(endedResult), { ok: true, ended: true });
    assert.equal(await daemon.exited, 0, daemon.stderr());
  } finally {
    shift?.child.kill('SIGKILL');
    server.close();
  }
});
