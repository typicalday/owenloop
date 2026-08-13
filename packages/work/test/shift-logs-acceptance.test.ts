/**
 * Terminal-shaped acceptance coverage for shift logging.
 *
 * A REAL `owenloop shift start` dispatches a REAL `owenloop work exec` worker
 * against a mock hub, and the assertions are made against the bytes on disk
 * afterwards. Nothing here is stubbed at the logging seam — that is the point:
 * the claim under test is that an operator with only the log directory can
 * reconstruct what happened.
 *
 * THE DEFINITION-OF-DONE CASE is the `workdir` fallback warning. `owenloop work
 * exec` writes it to its own stderr when a command step declared neither
 * `workdir:` nor `workdirFrom:`. Before this change a shift-dispatched worker's
 * stderr was `/dev/null`, so the warning existed and nobody could ever see it
 * (`docs/bundles.md`, "Working directory for command steps"). Finding that exact
 * line inside `<run>.log` is what proves the stdio contract actually changed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
import { runLogFile, shiftLogFile } from '../src/shift/logretention.ts';
import { spawnShift, type ShiftChild } from './helpers/shift-client.ts';
import { startMockHub, until } from './helpers/mcp-stdio-client.ts';

const BIN = fileURLToPath(new URL('../../../bin/owenloop.mjs', import.meta.url));
const TOKEN = 'tok-shift-logs-acceptance';
const MARKER = 'owenloop-shift-log-acceptance-marker';

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
let logDir: string;
let shift: ShiftChild | undefined;
let commands: CommandResult[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-shift-logs-acc-'));
  home = join(root, 'home');
  configDir = join(root, 'config');
  cacheDir = join(root, 'cache');
  stateDir = join(root, 'state');
  logDir = join(root, 'logs');
  shift = undefined;
  commands = [];

  // NOTE the step declares neither `workdir:` nor `workdirFrom:`. That absence
  // is what arms the fallback warning this file exists to catch.
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
    command: 'echo ${MARKER}'
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

function runCli(args: string[]): CommandResult {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, ...env() },
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

function orderPacket() {
  return {
    run: 'run_logging',
    workflow: 'wf_logging',
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

/** Read a file once it exists and contains `needle`, or fail with what it held. */
async function readWhenContains(path: string, needle: string, label: string): Promise<string> {
  await until(
    () => existsSync(path) && readFileSync(path, 'utf8').includes(needle),
    `${label} (${path}) to contain '${needle}'`,
    20_000,
  );
  return readFileSync(path, 'utf8');
}

test('a shift-dispatched worker\'s output lands in <run>.log and shift.log is JSON Lines', async () => {
  let dispatchEnabled = false;
  let orderVisible = true;
  const order = orderPacket();
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: 'hash-logging', steps: [{ name: 'cmd', executor: 'command' }] },
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
          instances: [{ workflow: 'wf_logging', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }],
        };
      }
      if (dispatchEnabled && orderVisible) {
        orderVisible = false;
        return { text: '', workflow: 'wf_logging', def: 'demo', orders: [{
          workflow: 'wf_logging',
          run: 'run_logging',
          step: 'cmd',
          prompt: '',
          consumes: {},
          expected_outputs: [],
          feedback: [],
          advisory: {},
          submit_hint: '',
        }] };
      }
      return { text: '', workflow: 'wf_logging', def: 'demo', orders: [] };
    }
    if (verb === 'get_order') return { text: '', workflow: 'wf_logging', run: 'run_logging', order, lease: { claimed: true } };
    if (verb === 'heartbeat') return { text: '' };
    if (verb === 'submit') return { text: '', outcome: 'green', closed: true };
    if (verb === 'release') return { text: '', released: true };
    return { text: '' };
  });

  try {
    shift = spawnShift(
      [
        'crew-logging', '--origin', origin, '--cap', '1', '--poll-interval', '25',
        '--cache-dir', cacheDir, '--state-dir', stateDir, '--log-dir', logDir,
      ],
      env(),
    );
    await shift.ready;

    // ── shift.log exists and starts self-describing, before any dispatch ──
    const parkedRaw = await readWhenContains(shiftLogFile(logDir), '"parked"', 'shift.log');
    const parked = JSON.parse(parkedRaw.trimEnd().split('\n')[0]!) as Record<string, unknown>;
    assert.equal(parked.type, 'parked');
    assert.equal(parked.origin, origin, 'the first record must name the hub this shift serves');
    assert.equal(parked.cap, 1);
    assert.deepEqual(parked.serveCrews, ['crew-logging']);
    assert.equal(typeof parked.hostname, 'string');
    assert.equal(typeof parked.cwd, 'string');
    assert.match(String(parked.shiftId), /^shf_/u);
    assert.equal(new Date(String(parked.ts)).toISOString(), parked.ts);

    dispatchEnabled = true;

    // ── THE DEFINITION-OF-DONE ASSERTION ──
    //
    // This exact warning was previously written to a worker fd pointed at
    // /dev/null. Finding it in <run>.log is the proof the topology changed.
    const workerLog = await readWhenContains(
      runLogFile(logDir, 'run_logging'),
      'declared neither workdir nor workdirFrom',
      '<run>.log',
    );
    assert.ok(workerLog.includes("step 'cmd' (wf_logging/run_logging)"), workerLog);
    assert.ok(workerLog.includes('A future release will require a step'), workerLog);

    // The worker's other own-voice lines are here too, which is the general
    // claim: `<run>.log` is the WORKER PROCESS's stdout and stderr.
    assert.ok(workerLog.includes('owenloop work exec: holding wf_logging/run_logging'), workerLog);

    // ── AND THE COMMAND'S OWN OUTPUT IS DELIBERATELY NOT HERE ──
    //
    // `owenloop work exec` does not INHERIT the command's streams, it CAPTURES
    // them into the receipt it submits to the hub. So `<run>.log` holds exactly
    // the worker's own diagnostics and the receipt holds exactly the command's
    // output — one destination each, no duplication. Asserting the absence is
    // what keeps that split from silently changing; a future change that made
    // the worker inherit instead of capture would double every command's output
    // and break receipt fidelity, and this line is what would catch it.
    assert.equal(
      workerLog.includes(MARKER),
      false,
      `the command's captured output must stay in the receipt, not the log: ${workerLog}`,
    );

    // ── shift.log carries the structured dispatch record ──
    const dispatchedRaw = await readWhenContains(shiftLogFile(logDir), '"dispatched"', 'shift.log');
    const records = dispatchedRaw.trimEnd().split('\n').map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        assert.fail(`shift.log line ${index + 1} is not valid JSON: ${line} (${String(error)})`);
      }
    });
    // EVERY line parses and EVERY line carries the envelope — that is the whole
    // contract an uploader implements against.
    for (const record of records) {
      assert.equal(typeof record.type, 'string');
      assert.equal(typeof record.ts, 'string');
      assert.equal(typeof record.shift, 'string');
      assert.match(String(record.shiftId), /^shf_/u);
    }
    const dispatched = records.find((record) => record.type === 'dispatched');
    assert.ok(dispatched !== undefined, JSON.stringify(records));
    assert.equal(dispatched.workflow, 'wf_logging');
    assert.equal(dispatched.run, 'run_logging');
    assert.equal(dispatched.step, 'cmd');
    assert.equal(typeof dispatched.pid, 'number');
    // Every record in one file shares one shiftId: this is one process's log.
    assert.equal(new Set(records.map((record) => record.shiftId)).size, 1);

    // ── the log outlives the run record AND the shift ──
    await until(
      () => !existsSync(join(stateDir, 'run_logging.json')),
      'the in-flight run record to be reaped',
      20_000,
    );
    const ending = runCli(['shift', 'end', '--state-dir', stateDir]);
    assert.equal((await ending.result).code, 0);
    assert.equal(await shift.exited, 0, shift.stderr());

    assert.equal(existsSync(join(stateDir, 'run_logging.json')), false);
    assert.ok(
      readFileSync(runLogFile(logDir, 'run_logging'), 'utf8').includes('declared neither workdir'),
      'the worker log must survive both its run record and the shift',
    );
    const finalShiftLog = readFileSync(shiftLogFile(logDir), 'utf8');
    assert.ok(finalShiftLog.includes('"ended"'), 'the shutdown record must be on disk too');
    for (const line of finalShiftLog.trimEnd().split('\n')) JSON.parse(line);

    assert.ok(reqs.length > 0);
  } finally {
    server.close();
  }
});

test('an unwritable --log-dir disables logging without stopping the shift', async () => {
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: 'hash-logging', steps: [{ name: 'cmd', executor: 'command' }] },
    fetchedAt: 0,
    origin: 'acceptance-test',
  };
  writeBundle(cacheDir, bundle, []);

  const { origin, server } = await startMockHub((verb, body) => {
    if (verb === 'presence_ping') return { text: '', ok: true, name: String(body?.['name'] ?? 'shift'), lastSeen: Date.now() };
    if (verb === 'wake') return { text: '', cursor: 1, changed: false };
    if (verb === 'whats_next') return { text: '', instances: [] };
    return { text: '' };
  });

  try {
    // A path under a read-only parent: `mkdirSync` cannot create it.
    const blocked = join(root, 'blocked');
    mkdirSync(blocked);
    chmodSync(blocked, 0o500);

    shift = spawnShift(
      [
        'crew-logging', '--origin', origin, '--cap', '1', '--poll-interval', '25',
        '--cache-dir', cacheDir, '--state-dir', stateDir, '--log-dir', join(blocked, 'logs'),
      ],
      env(),
    );
    // The assertion is that the daemon comes up and serves at all.
    await shift.ready;
    const status = (await shift.request({ op: 'status' })) as { cap?: number };
    assert.equal(status.cap, 1, JSON.stringify(status));
    assert.ok(
      shift.stderr().includes('cannot create shift log directory'),
      `expected a one-time report, got:\n${shift.stderr()}`,
    );
    assert.ok(shift.stderr().includes('continuing with logging disabled'), shift.stderr());

    const ending = runCli(['shift', 'end', '--state-dir', stateDir]);
    assert.equal((await ending.result).code, 0);
    assert.equal(await shift.exited, 0, shift.stderr());
  } finally {
    server.close();
  }
});
