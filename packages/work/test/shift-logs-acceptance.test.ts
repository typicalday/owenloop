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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { writeBundle } from '../src/bundle/cache.ts';
import type { CachedBundle } from '../src/bundle/types.ts';
import { defInstructionDigest } from '../../../src/order-resolver.ts';
import { finalizeDefs, loadDefFile } from '../../../src/defs.ts';
import { installSignedBundleFixture, writeBundleSource } from '../../../test/helpers/store-fixture.ts';
import { readChildRecords } from '../src/shift/state.ts';
import { logOwnersDir, registerShiftLogOwner, runLogFile, shiftLogFile } from '../src/shift/logretention.ts';
import { spawnShift, type ShiftChild } from './helpers/shift-client.ts';
import { startMockHub, until } from './helpers/mcp-stdio-client.ts';
import { strippedOwenloopEnv } from './helpers/ambient-env.ts';

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
    // `runCli` spreads process.env into the child, so every ambient OWENLOOP_*
    // variable reaches the CLI under test unless this object overrides it. Deny
    // the namespace first, then set back what the fixture wants — the miss that
    // bit was OWENLOOP_CONFIG_DIR, which sits ABOVE $XDG_CONFIG_HOME/owenloop in
    // the config-dir ladder (`configDir` in src/hub.ts) and so outranks the
    // XDG_CONFIG_HOME below. Every owenloop shift exports a slice of the
    // namespace, so a miss is red on an agent-driven build and green in CI.
    ...strippedOwenloopEnv(),
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

interface DispatchHubState {
  /** Flip to true to make the one order visible to `whats_next`. */
  dispatchEnabled: boolean;
  /**
   * Serve `get_order` with `order: null`, which `exec/loop.ts` classifies as a
   * MISROUTE: the worker releases the claim and exits 1. That non-zero exit is
   * what arms the spawner's `exit` listener and, through it,
   * `runShiftRuntime`'s `reportWorkerFailure`.
   */
  misroute: boolean;
  /** Every `submit` the hub received, in order. */
  submits: Array<Record<string, unknown> | undefined>;
}

/**
 * The mock hub every dispatching acceptance test in this file runs against: it
 * advertises one instance, hands out `wf_logging/run_logging` EXACTLY ONCE, and
 * records every submit so a test can prove the order actually completed rather
 * than merely that the daemon stayed up.
 */
function dispatchHub(state: DispatchHubState): (verb: string, body: Record<string, unknown> | undefined) => unknown {
  const order = orderPacket();
  let orderVisible = true;
  return (verb, body) => {
    if (verb === 'presence_ping') return { text: '', ok: true, name: String(body?.['name'] ?? 'shift'), lastSeen: Date.now() };
    if (verb === 'wake') return { text: '', cursor: state.dispatchEnabled ? 2 : 1, changed: state.dispatchEnabled };
    if (verb === 'whats_next') {
      if (body?.['workflow'] === undefined) {
        return {
          text: '',
          instances: [{ workflow: 'wf_logging', def: 'demo', done: false, eligible: 1, blocked: 0, owedSeededInputs: [] }],
        };
      }
      if (state.dispatchEnabled && orderVisible) {
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
    if (verb === 'get_order') {
      return {
        text: '', workflow: 'wf_logging', run: 'run_logging',
        order: state.misroute ? null : order,
        lease: { claimed: true },
      };
    }
    if (verb === 'heartbeat') return { text: '' };
    if (verb === 'submit') {
      state.submits.push(body);
      return { text: '', outcome: 'green', closed: true };
    }
    if (verb === 'release') return { text: '', released: true };
    return { text: '' };
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

/**
 * The COMPLETE JSON Lines records in `text` — every `…\n`-terminated line, with
 * a trailing fragment dropped.
 *
 * WHY A FRAGMENT IS EXPECTED HERE AND NOT A DEFECT. `readWhenContains` reads a
 * file the shift daemon is still alive and still appending to, and it reads it
 * twice: once to test the needle, once to return the bytes. A record can be
 * mid-append between those two reads. `trimEnd().split('\n')` would hand that
 * half-written line to `JSON.parse` and fail the run for a reason that has
 * nothing to do with the code under test.
 *
 * This is the same rule `docs/shift-logs.md` gives an uploader — "a trailing
 * line with no `\n` is not yet a record; parse whole lines and carry the
 * remainder into the next read" — so the test consumes the file the way the
 * contract says to, rather than the way that happens to work when nothing is
 * writing.
 *
 * It does NOT weaken the "every line is valid JSON" assertion. A complete line
 * that will not parse still fails; only the not-yet-a-line is skipped.
 */
function completeLines(text: string): string[] {
  const lines = text.split('\n');
  // `split` puts whatever follows the last `\n` in the final element: `''` when
  // the text ends cleanly, a partial record when it does not. Either way the
  // final element is not a complete line, so it goes.
  lines.pop();
  return lines;
}

/**
 * Every COMPLETE record in `shift.log`, once one of them has `type === type`.
 *
 * Waiting on a SUBSTRING is what made the earlier version racy in two separate
 * ways, and this helper closes both. `readWhenContains(path, '"parked"')`
 * returns the moment the bytes `{"type":"parked"` hit the file — before the
 * record's closing brace and newline exist — so the caller could parse a
 * fragment. And its second `readFileSync` is a different instant from its
 * probe, so a record could begin appending in between. Waiting on a complete,
 * PARSED record of the wanted type removes both: the predicate and the returned
 * value come from the same read, and a partial trailing line simply means "not
 * yet", which is another poll rather than a failure.
 *
 * The JSON Lines contract is still enforced, not relaxed — every complete line
 * must parse, and a complete line that does not fails the test right here.
 */
async function readShiftLogRecords(
  path: string,
  type: string,
  label: string,
): Promise<Record<string, unknown>[]> {
  let records: Record<string, unknown>[] = [];
  await until(
    () => {
      if (!existsSync(path)) return false;
      records = completeLines(readFileSync(path, 'utf8')).map((line, index) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch (error) {
          assert.fail(`${label} line ${index + 1} is not valid JSON: ${line} (${String(error)})`);
        }
      });
      return records.some((record) => record.type === type);
    },
    `${label} (${path}) to hold a complete '${type}' record`,
    20_000,
  );
  return records;
}

test('a shift-dispatched worker\'s output lands in <run>.log and shift.log is JSON Lines', async () => {
  const hub: DispatchHubState = { dispatchEnabled: false, misroute: false, submits: [] };
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: 'hash-logging', steps: [{ name: 'cmd', executor: 'command' }] },
    fetchedAt: 0,
    origin: 'acceptance-test',
  };
  writeBundle(cacheDir, bundle, []);

  const { origin, reqs, server } = await startMockHub(dispatchHub(hub));

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
    // Index 0 deliberately: the claim is that the FIRST record is `parked`, so a
    // reader holding only the file can resolve every later record's `shift` and
    // `shiftId`. Finding a `parked` record somewhere would be a weaker claim.
    const parked = (await readShiftLogRecords(shiftLogFile(logDir), 'parked', 'shift.log'))[0]!;
    assert.equal(parked.type, 'parked');
    assert.equal(parked.origin, origin, 'the first record must name the hub this shift serves');
    assert.equal(parked.cap, 1);
    assert.deepEqual(parked.serveCrews, ['crew-logging']);
    assert.equal(typeof parked.hostname, 'string');
    assert.equal(typeof parked.cwd, 'string');
    assert.match(String(parked.shiftId), /^shf_/u);
    assert.equal(new Date(String(parked.ts)).toISOString(), parked.ts);

    // ── AND THE DESTINATION IS OWNER-ONLY, END TO END ──
    // Asserted here rather than only in the unit tests because these modes are
    // requested at creation and then never re-applied, so what matters is the
    // mode a REAL shift leaves on disk after really creating the directory and
    // really appending its first record. `shift.log` quotes hub and workflow
    // messages verbatim in its `hub-error` and `order-dropped` records, and
    // `<run>.log` beside it is raw worker output.
    assert.equal((statSync(logDir).mode & 0o777).toString(8), '700', 'the log directory must be owner-only');
    assert.equal((statSync(shiftLogFile(logDir)).mode & 0o777).toString(8), '600', 'shift.log must be owner-only');

    hub.dispatchEnabled = true;

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

    // NOTE the absence of the command's own output is NOT asserted here. The
    // needle awaited above ('declared neither workdir nor workdirFrom') is
    // written at `exec/loop.ts:533`, immediately BEFORE `runner.start` at :540,
    // so at this instant the command provably has not run yet and no
    // implementation could have put its output in the file. The claim is made
    // once, below, against the post-run re-read.

    // ── shift.log carries the structured dispatch record ──
    const records = await readShiftLogRecords(shiftLogFile(logDir), 'dispatched', 'shift.log');
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
    const finalWorkerLog = readFileSync(runLogFile(logDir, 'run_logging'), 'utf8');
    assert.ok(
      finalWorkerLog.includes('declared neither workdir'),
      'the worker log must survive both its run record and the shift',
    );

    // ── THE COMMAND'S CAPTURED OUTPUT IS RELAYED, NOT INHERITED ──
    //
    // `owenloop work exec` does not INHERIT the command's streams, it CAPTURES
    // them into the receipt it submits to the hub and RELAYS the captured tail
    // through its own stdout. Both the receipt and `<run>.log` contain that
    // tail; full streams are represented only by the receipt's hash and
    // stdout/stderr byte counts.
    //
    // THIS READ IS THE ONE THAT CAN FAIL, and the ordering above is why. The
    // run record is gone (the worker exited) and the shift itself has exited,
    // so `echo ${MARKER}` provably ran and every byte either stream was ever
    // going to receive has been written and flushed. A future change that made
    // the worker inherit the command's streams instead of capturing them would
    // put the bytes in unprefixed and double them; the exact shape asserted
    // here rules that out. Asserted before the command ran, it would merely
    // have flaked.
    const markerLines = finalWorkerLog.split('\n').filter((line) => line.includes(MARKER));
    assert.deepEqual(
      markerLines,
      [`  | ${MARKER}`],
      `the command's output must appear exactly once, relayed and prefixed: ${finalWorkerLog}`,
    );
    const finalShiftLog = readFileSync(shiftLogFile(logDir), 'utf8');
    assert.ok(finalShiftLog.includes('"ended"'), 'the shutdown record must be on disk too');
    // THE SHIFT HAS EXITED, so this read is not racing an appender and the file
    // must be whole: no trailing fragment, every line valid JSON. The
    // newline-termination assertion is the part that only holds here — the
    // mid-run reads above legitimately catch a partial record and use
    // `completeLines` for exactly that reason.
    assert.ok(finalShiftLog.endsWith('\n'), 'a shift that exited leaves no half-written record');
    for (const line of completeLines(finalShiftLog)) JSON.parse(line);

    assert.ok(reqs.length > 0);
  } finally {
    server.close();
  }
});

test('a failed worker writes a stamped failed record, though nothing in the loop emitted it', async () => {
  // THE ENVELOPE BYPASS. Almost every record in `shift.log` is stamped by
  // `loop.ts`'s `emit()`, which the unit tests in
  // `shift-loop-attendance-events.test.ts` cover directly. `failed` is one of
  // the records that never passes through it: a worker failure is detected by
  // the SPAWNER's `exit` listener, in the shift process but outside the loop,
  // and `runShiftRuntime.reportWorkerFailure` stamps it with its own `stamp`
  // helper. Two stamping sites means two chances to disagree about the wire
  // contract, and no unit test can reach the second one — `reportWorkerFailure`
  // is a closure inside `runShiftRuntime`, constructed only by a real startup.
  //
  // So this test drives a REAL failure and asserts the record it produces is
  // envelope-identical to the loop's, right down to sharing the `shiftId` on
  // the `parked` record in the same file.
  const hub: DispatchHubState = { dispatchEnabled: false, misroute: true, submits: [] };
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: 'hash-logging', steps: [{ name: 'cmd', executor: 'command' }] },
    fetchedAt: 0,
    origin: 'acceptance-test',
  };
  writeBundle(cacheDir, bundle, []);

  const { origin, server } = await startMockHub(dispatchHub(hub));

  try {
    shift = spawnShift(
      [
        'crew-logging', '--origin', origin, '--cap', '1', '--poll-interval', '25',
        '--cache-dir', cacheDir, '--state-dir', stateDir, '--log-dir', logDir,
      ],
      env(),
    );
    // A `const` alias so the stderr predicate below can close over the daemon:
    // `shift` is a module-level `let` that `afterEach` also writes, so TypeScript
    // will not carry its narrowing into an arrow function.
    const daemon = shift;
    await daemon.ready;
    const parked = (await readShiftLogRecords(shiftLogFile(logDir), 'parked', 'shift.log'))[0]!;

    hub.dispatchEnabled = true;

    // `misroute: true` makes `get_order` serve `order: null`, so the worker
    // releases the claim and exits 1 instead of running the command.
    const records = await readShiftLogRecords(shiftLogFile(logDir), 'failed', 'shift.log');
    const failures = records.filter((record) => record.type === 'failed');
    // EXACTLY ONE. `spawn.ts` latches `failureReported`, so an `error` event
    // arriving after an `exit` event must not produce a second record.
    assert.equal(failures.length, 1, JSON.stringify(failures));
    const failure = failures[0]!;

    // ── the payload `reportWorkerFailure` builds ──
    assert.equal(failure.workflow, 'wf_logging');
    assert.equal(failure.run, 'run_logging');
    assert.equal(failure.step, 'cmd');
    assert.equal(failure.kind, 'exec');
    assert.equal(failure.exitStatus, 1, 'the misrouted worker exits 1');
    assert.equal(failure.signal, null, 'it exited on its own, so no signal');
    assert.equal(failure.message, 'worker exited without completing successfully');
    assert.equal(typeof failure.executable, 'string');

    // ── THE ENVELOPE, which is the reason this test exists ──
    //
    // Compared against the `dispatched` record, NOT against `parked`. Both
    // `parked` and `failed` are stamped by `runtime.ts`'s `stamp`, so comparing
    // those two only proves that one function is self-consistent — a single
    // wrong id inside `stamp` would satisfy it. `dispatched` is stamped by
    // `loop.ts`'s `emit()`, the OTHER site, so this is a genuine cross-site
    // agreement check: it fails if either site drifts.
    const dispatched = records.find((record) => record.type === 'dispatched');
    assert.ok(dispatched !== undefined, JSON.stringify(records));
    assert.equal(new Date(String(failure.ts)).toISOString(), failure.ts, 'ts must be an ISO-8601 string');
    assert.equal(failure.shift, dispatched.shift, "the failure must name the same shift as the loop's own records");
    assert.equal(
      failure.shiftId, dispatched.shiftId,
      'the two stamping sites must agree on the id — this is what a hardcoded or dropped id fails',
    );
    assert.equal(parked.shiftId, dispatched.shiftId, 'and the startup record agrees with both');
    assert.match(String(failure.shiftId), /^shf_/u);

    // ── THE OPERATOR'S VIEW, which lands STRICTLY AFTER the record ──
    //
    // `reportWorkerFailure` (runtime.ts) appends the `failed` record to
    // `shift.log` FIRST and writes the human line to its own stderr SECOND, and
    // that line then has to cross a pipe into this process. So the log record
    // waited on above is not evidence that the stderr line has arrived, and
    // reading `daemon.stderr()` here with no wait failed ~7% of runs (4 of 55)
    // with an empty capture and the message below. Poll for it, exactly the way
    // this test already polls the log file.
    const workerFailureReports = (): string[] =>
      daemon.stderr().split('\n').filter((line) => line.includes('worker failure'));
    await until(
      () => workerFailureReports().length > 0,
      "the shift to report the worker failure on its own stderr",
      20_000,
    );
    // ONE report, not "at least one": `spawn.ts` latches `failureReported` so an
    // `error` event arriving after `exit` cannot produce a second line. Polling
    // moved the wait off the count; it did not weaken the count.
    assert.equal(
      workerFailureReports().length, 1,
      `expected one worker-failure report, got:\n${daemon.stderr()}`,
    );
    assert.ok(workerFailureReports()[0]!.includes('"type":"failed"'), workerFailureReports()[0]);

    // And the daemon is still alive and serving after reporting it.
    const status = (await daemon.request({ op: 'status' })) as { cap?: number };
    assert.equal(status.cap, 1, JSON.stringify(status));

    const ending = runCli(['shift', 'end', '--state-dir', stateDir]);
    assert.equal((await ending.result).code, 0);
    assert.equal(await daemon.exited, 0, daemon.stderr());

    // THE LATCH, re-checked after the writer is gone. The count above was taken
    // while the shift was still running, so it could only ever have caught a
    // duplicate that had already arrived. The process has now exited, so no
    // further report can be PRODUCED — and an unread byte still sitting in the
    // pipe could only ADD to this count, never remove one. So this recheck can
    // catch a late duplicate the first one missed, and can never mask one.
    assert.equal(
      workerFailureReports().length, 1,
      `the failure must be reported once for the whole shift, got:\n${daemon.stderr()}`,
    );
  } finally {
    server.close();
  }
});

test('a real shift startup sweeps aged worker logs and spares every claimed shift\'s live ones', async () => {
  // `prepareShiftLogDir`'s branches are unit-tested against a temp directory.
  // This test proves the OTHER half: that `runShiftRuntime` actually calls it,
  // with the operator's `--log-max-age` and the resolved `--state-dir`, before
  // the daemon starts serving. It is deliberately the only acceptance test for
  // the sweep — driving each failure branch through a real daemon would cost
  // five processes to learn what five function calls already established.
  const hub: DispatchHubState = { dispatchEnabled: false, misroute: false, submits: [] };
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: 'hash-logging', steps: [{ name: 'cmd', executor: 'command' }] },
    fetchedAt: 0,
    origin: 'acceptance-test',
  };
  writeBundle(cacheDir, bundle, []);
  const { origin, server } = await startMockHub(dispatchHub(hub));

  try {
    // TWO other shifts' state directories, both sharing this log directory and
    // both holding a live `<run>.json`. They differ in ONE thing: `claimed` has
    // registered itself in `<log-dir>/.owners` and `unclaimed` has not. That is
    // the contrast the registry exists to create, and the only reason the two
    // logs below meet different fates.
    const claimedStateDir = join(root, 'claimed-state');
    const unclaimedStateDir = join(root, 'unclaimed-state');
    mkdirSync(logDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(claimedStateDir, { recursive: true });
    mkdirSync(unclaimedStateDir, { recursive: true });
    registerShiftLogOwner(logDir, claimedStateDir);

    const age = (name: string): string => {
      const path = runLogFile(logDir, name);
      writeFileSync(path, `${name} bytes\n`);
      const seconds = (Date.now() - 60 * 60 * 1000) / 1000;
      utimesSync(path, seconds, seconds);
      return path;
    };
    const claimedLive = age('run_claimed_live');
    const unclaimedLive = age('run_unclaimed_live');
    const abandoned = age('run_abandoned');
    writeFileSync(join(claimedStateDir, 'run_claimed_live.json'), '{}');
    writeFileSync(join(unclaimedStateDir, 'run_unclaimed_live.json'), '{}');
    // NOTE this shift's OWN state directory is left empty on purpose. A record
    // here would be reconciled by the loop as a real in-flight child, which is a
    // different subsystem's behaviour; `prepareShiftLogDir`'s unit tests already
    // cover the own-state-dir gate directly.

    shift = spawnShift(
      [
        'crew-logging', '--origin', origin, '--cap', '1', '--poll-interval', '25',
        '--cache-dir', cacheDir, '--state-dir', stateDir, '--log-dir', logDir,
        // 0ms retention: EVERY completed worker log is old enough. What survives
        // survives because of an in-flight record, not because of its age.
        '--log-max-age', '0',
      ],
      env(),
    );
    await shift.ready;

    // The report names the count and the age actually used, once.
    await until(() => shift!.stderr().includes('worker log(s) older than'), 'the startup sweep report', 20_000);
    const reports = shift.stderr().split('\n').filter((line) => line.includes('worker log(s) older than'));
    assert.equal(reports.length, 1, `expected one sweep report, got:\n${shift.stderr()}`);
    assert.ok(reports[0]!.includes('reaped 2 worker log(s) older than 0ms'), reports[0]);
    assert.ok(reports[0]!.includes(logDir), reports[0]);

    assert.equal(existsSync(abandoned), false, 'a completed run past the age must be reaped');
    assert.equal(
      existsSync(claimedLive), true,
      "a CLAIMED shift's in-flight worker log must survive — this is the orphaned-inode case the registry prevents",
    );
    assert.equal(
      existsSync(unclaimedLive), false,
      'and the same log with no claim behind it is reaped, which is what makes the line above a real result',
    );

    // The claim this shift wrote is on disk, absolute, and did not displace the
    // other shift's: two shifts sharing a log directory means two claim files.
    const claims = readdirSync(logOwnersDir(logDir));
    assert.equal(claims.length, 2, claims.join(', '));
    const owners = claims.map((name) => (JSON.parse(readFileSync(join(logOwnersDir(logDir), name), 'utf8')) as { stateDir: string }).stateDir);
    assert.deepEqual(owners.sort(), [stateDir, claimedStateDir].sort());
    for (const path of owners) assert.equal(isAbsolute(path), true, `${path} must be absolute`);

    // `.owners` itself is never mistaken for a worker log, even at 0ms retention.
    assert.equal(existsSync(logOwnersDir(logDir)), true);
    // And the sweep did not eat shift.log, which the daemon is writing right now.
    assert.ok(readFileSync(shiftLogFile(logDir), 'utf8').includes('"parked"'));

    const ending = runCli(['shift', 'end', '--state-dir', stateDir]);
    assert.equal((await ending.result).code, 0);
    assert.equal(await shift.exited, 0, shift.stderr());
  } finally {
    server.close();
  }
});

test('an unwritable --log-dir loses the logs and still COMPLETES the order', async () => {
  // The claim under test is `a full disk must never fail an order`. Proving the
  // daemon merely comes up does not test that claim: with logging disabled the
  // spawner takes a DIFFERENT branch — it falls back to
  // `stdio: ['ignore','ignore','ignore']` and passes no log directory — and only
  // a real dispatch runs that branch. So this test dispatches one, waits for the
  // hub to receive the worker's submit, and only then checks that nothing was
  // logged.
  const hub: DispatchHubState = { dispatchEnabled: false, misroute: false, submits: [] };
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: 'hash-logging', steps: [{ name: 'cmd', executor: 'command' }] },
    fetchedAt: 0,
    origin: 'acceptance-test',
  };
  writeBundle(cacheDir, bundle, []);

  const { origin, server } = await startMockHub(dispatchHub(hub));

  try {
    // The log directory's PARENT is a regular file, so `mkdirSync` fails ENOTDIR.
    // Chosen over a permission bit because it does not depend on the uid the test
    // runs as: root walks straight through a 0o500 directory and the branch under
    // test would never be taken.
    const blocker = join(root, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const blockedLogDir = join(blocker, 'logs');

    shift = spawnShift(
      [
        'crew-logging', '--origin', origin, '--cap', '1', '--poll-interval', '25',
        '--cache-dir', cacheDir, '--state-dir', stateDir, '--log-dir', blockedLogDir,
      ],
      env(),
    );
    await shift.ready;
    const status = (await shift.request({ op: 'status' })) as { cap?: number };
    assert.equal(status.cap, 1, JSON.stringify(status));

    // Reported ONCE at startup, naming the directory, and saying what it means.
    //
    // WAITED FOR, not sampled. The write happens before the socket binds, so
    // `await shift.ready` almost always implies it — but "almost always" is how
    // the worker-failure assertion in this file became a ~7% flake: a stderr
    // chunk still has to cross a pipe into this process, and no await here
    // orders that crossing. Polling first costs nothing and cannot mask a
    // duplicate, because the count is still asserted as exactly one.
    const startupReports = (): string[] =>
      shift!.stderr().split('\n').filter((line) => line.includes('cannot create shift log directory'));
    await until(() => startupReports().length > 0, 'the startup log-directory failure report', 20_000);
    assert.equal(startupReports().length, 1, `expected exactly one report, got:\n${shift.stderr()}`);
    assert.ok(startupReports()[0]!.includes(blockedLogDir), startupReports()[0]);
    assert.ok(startupReports()[0]!.includes('continuing with logging disabled'), startupReports()[0]);

    // ── THE ORDER RUNS TO COMPLETION ANYWAY ──
    hub.dispatchEnabled = true;
    await until(() => hub.submits.length > 0, 'the dispatched worker to submit its receipt', 20_000);
    await until(
      () => !existsSync(join(stateDir, 'run_logging.json')),
      'the in-flight run record to be reaped',
      20_000,
    );
    // The receipt is the command's captured output, unaffected by logging being
    // off — the worker still did its whole job, it just left no diary.
    assert.ok(
      JSON.stringify(hub.submits[0]).includes(MARKER),
      `the receipt must still carry the command's output: ${JSON.stringify(hub.submits[0])}`,
    );

    // ── AND NOTHING WAS WRITTEN ANYWHERE ──
    // `existsSync(blockedLogDir)` is NOT the assertion to make here: that path
    // lives under a regular file, so `stat()` fails ENOTDIR and the answer is
    // false whatever the shift did. The load-bearing checks are that the blocker
    // is still a regular FILE of the original bytes (nothing unlinked it and
    // made a directory in its place) and the stray sweep just below.
    assert.equal(lstatSync(blocker).isFile(), true, 'the blocking file must still be a regular file');
    assert.equal(readFileSync(blocker, 'utf8'), 'x', 'the blocking file must be untouched');
    // Not silently redirected into the state directory either: with `ready:false`
    // the runtime builds NO sink and passes NO log directory, so neither
    // `shift.log` nor `<run>.log` exists under any of the paths in play.
    for (const stray of [shiftLogFile(stateDir), runLogFile(stateDir, 'run_logging'), shiftLogFile(root), runLogFile(root, 'run_logging')]) {
      assert.equal(existsSync(stray), false, `nothing must be written to ${stray}`);
    }

    const ending = runCli(['shift', 'end', '--state-dir', stateDir]);
    assert.equal((await ending.result).code, 0);
    assert.equal(await shift.exited, 0, shift.stderr());
  } finally {
    server.close();
  }
});
