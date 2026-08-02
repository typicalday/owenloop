/**
 * Terminal-shaped acceptance coverage for the public shift daemon.
 *
 * The daemon runs as one real foreground child. Separate real CLI children act
 * as the two blocking terminals and the third terminal that ends the shift.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { writeBundle } from '../src/bundle/cache.ts';
import type { CachedBundle } from '../src/bundle/types.ts';
import { spawnShift, type ShiftChild } from './helpers/shift-client.ts';
import { startMockHub, until, type HubReq } from './helpers/mcp-stdio-client.ts';

const BIN = fileURLToPath(new URL('../../../bin/owenloop.mjs', import.meta.url));
const TOKEN = 'tok-shift-blocking-acceptance';

interface CommandResult {
  child: ChildProcess;
  result: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

let root: string;
let configDir: string;
let cacheDir: string;
let stateDir: string;
let shift: ShiftChild | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenwork-shift-blocking-'));
  configDir = join(root, 'config');
  cacheDir = join(root, 'cache');
  stateDir = join(root, 'state');
});

afterEach(() => {
  shift?.child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

function env(): Record<string, string | undefined> {
  return {
    OWENWORK_TOKEN: TOKEN,
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
  return { child, result };
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
    command: 'sleep 5',
    prompt: '',
    consumes: {},
    owes: [{ path: 'result', acceptance: 'required', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
  };
}

test('idle next blocks, dispatch wakes it, a second next parks, and a third terminal ends the shift', async () => {
  let dispatchEnabled = false;
  let dispatchAt: number | undefined;
  let orderVisible = true;
  const order = orderPacket();
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: 'hash-blocking', steps: [{ name: 'cmd', worker: 'command' }] },
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
    const unattendedStatus = jsonResult<{ attended_at: number | null; serve_pools: string[] }>(unattendedResult);
    assert.equal(unattendedStatus.attended_at, null);
    assert.deepEqual(unattendedStatus.serve_pools, ['crew-blocking']);

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
    assert.equal(secondNext.child.exitCode, null, 'the second terminal next must park while no event is available');

    const presenceBeforeEnd = requests(reqs, 'presence_ping').length;
    const ending = runCli(['shift', 'end', '--state-dir', stateDir]);
    const endedResult = await ending.result;
    assert.equal(endedResult.code, 0, endedResult.stderr);
    assert.deepEqual(jsonResult(endedResult), { ok: true, ended: true });

    const secondResult = await secondNext.result;
    assert.equal(secondResult.code, 0, secondResult.stderr);
    const secondResponse = jsonResult<{ events: Array<{ type: string }> }>(secondResult);
    assert.deepEqual(secondResponse.events, [{ type: 'ended' }]);

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
