import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createExecLoop, type ExecLoop, type ExecLoopOptions } from '../src/exec/loop.ts';
import { HubError, type ContactHolder, type GetOrderResponse } from '../src/hub/types.ts';
import type { HubClient } from '../src/hub/client.ts';
import type { CommandResult, CommandRunner, RunningCommand } from '../src/exec/runner.ts';
import type { CommandReceipt } from '../src/exec/receipt.ts';

// ---- fakes ------------------------------------------------------------------

interface Call {
  verb: string;
  arg?: unknown;
}
interface SubmitCall {
  path: string;
  value: unknown;
  holder?: ContactHolder;
}

const EXEC: ContactHolder = { kind: 'exec', id: 'host:123' };
const macrotaskSleep = (): Promise<void> => new Promise((r) => setImmediate(r));

interface OrderOpts {
  command?: string;
  worker?: string;
  workdir?: string;
  owes?: string[];
  claimed?: boolean;
  outcome?: string;
}

/** A get_order response carrying a command order packet. */
function commandOrder(o: OrderOpts = {}): GetOrderResponse {
  const paths = o.owes ?? ['out'];
  return {
    text: '',
    workflow: 'wf1',
    run: 'run1',
    order: {
      run: 'run1',
      workflow: 'wf1',
      step: 'builder',
      key: 'k',
      inputs: [],
      outputs: [],
      ...(o.workdir !== undefined ? { workdir: o.workdir } : {}),
      worker: o.worker ?? 'command',
      command: o.command ?? 'echo hi',
      prompt: '',
      consumes: {},
      owes: paths.map((path) => ({ path, acceptance: '', judgmentRejects: 0, schemaRejects: 0, reasons: [] })),
    },
    lease: { claimed: o.claimed ?? true, ...(o.outcome !== undefined ? { outcome: o.outcome } : {}) },
  };
}

/** A get_order response with a non-command / null packet (a misroute). */
function nonCommandOrder(order: GetOrderResponse['order'], lease?: Partial<GetOrderResponse['lease']>): GetOrderResponse {
  return { text: '', workflow: 'wf1', run: 'run1', order, lease: { claimed: true, ...lease } };
}

interface MockCfg {
  getOrder: Array<GetOrderResponse | Error> | ((n: number) => GetOrderResponse);
  heartbeat?: (n: number) => void;
  submit?: Array<string | Error>;
  release?: () => Promise<{ text: string }>;
}

function mockHub(cfg: MockCfg): { hub: HubClient; calls: Call[]; submits: SubmitCall[] } {
  const calls: Call[] = [];
  const submits: SubmitCall[] = [];
  let goIdx = 0;
  let hbIdx = 0;
  let subIdx = 0;

  const hub: HubClient = {
    async getOrder(req) {
      calls.push({ verb: 'get_order', arg: req });
      const s = cfg.getOrder;
      const item = Array.isArray(s) ? s[Math.min(goIdx, s.length - 1)]! : s(goIdx);
      goIdx++;
      if (item instanceof Error) throw item;
      return item;
    },
    async heartbeat(req) {
      calls.push({ verb: 'heartbeat', arg: req });
      cfg.heartbeat?.(hbIdx++);
      return { text: '' };
    },
    async release(req) {
      calls.push({ verb: 'release', arg: req });
      return cfg.release !== undefined ? cfg.release() : { text: '' };
    },
    async submit(req) {
      submits.push({ path: req.path, value: req.value, holder: req.holder });
      const s = cfg.submit ?? ['green'];
      const item = s[Math.min(subIdx, s.length - 1)]!;
      subIdx++;
      if (item instanceof Error) throw item;
      return { text: `submit ${item}`, outcome: item };
    },
    async whatsNext() {
      return { text: '' };
    },
    async whoami() {
      return { text: '', orgId: '', orgName: '', actor: { id: '', kind: 'agent', role: 'agent', scopes: [] }, tokenStatus: 'active', authMethod: 'token' };
    },
    async wake() {
      return { text: '', cursor: 0, changed: false };
    },
    async presencePing(req) {
      return { text: '', ok: true, name: req.name, lastSeen: 0 };
    },
  };
  return { hub, calls, submits };
}

// ---- fake runner ------------------------------------------------------------

function result(exitCode: number | null, extra: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode,
    outputHash: 'sha256:beef',
    stdoutBytes: 0,
    stderrBytes: 0,
    outputTail: '',
    startedAt: 0,
    finishedAt: 1,
    durationMs: 1,
    ...extra,
  };
}

interface FakeRunner {
  runner: CommandRunner;
  starts: Array<{ command: string; cwd: string }>;
  state: { kills: number };
  resolve: (r: CommandResult) => void;
  reject: (e: unknown) => void;
}

/** A runner whose single command settles only when the test says so. */
function fakeRunner(opts: { throwOnStart?: Error; resolveOnKill?: CommandResult } = {}): FakeRunner {
  const starts: Array<{ command: string; cwd: string }> = [];
  const state = { kills: 0 };
  let resolveDone!: (r: CommandResult) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<CommandResult>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  const runner: CommandRunner = {
    start(command, o): RunningCommand {
      starts.push({ command, cwd: o.cwd });
      if (opts.throwOnStart !== undefined) throw opts.throwOnStart;
      return {
        done,
        kill: async (): Promise<void> => {
          state.kills++;
          // Like the real runner: a TERM'd command settles (fast) with a signal.
          if (opts.resolveOnKill !== undefined) resolveDone(opts.resolveOnKill);
        },
      };
    },
  };
  return { runner, starts, state, resolve: resolveDone, reject: rejectDone };
}

function baseOpts(hub: HubClient, runner: CommandRunner, extra: Partial<ExecLoopOptions> = {}): ExecLoopOptions {
  return {
    hub,
    runner,
    workflow: 'wf1',
    run: 'run1',
    holder: EXEC,
    cwd: '/work',
    sleep: macrotaskSleep,
    now: () => 0,
    random: () => 0.5,
    out: () => {},
    err: () => {},
    heartbeatIntervalMs: 1000,
    jumpToleranceMs: 500,
    failureWindowMs: 5000,
    ...extra,
  };
}

const only = (calls: Call[], verb: string): Call[] => calls.filter((c) => c.verb === verb);

// ---- happy path -------------------------------------------------------------

test('runs the command and submits a receipt to the owed path (exit-success outcome)', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder({ command: 'make build' })], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep(); // let first contact + start settle
  fr.resolve(result(0, { outputHash: 'sha256:abc' }));

  assert.equal(await p, 'submitted');
  // First contact carried the exec holder.
  assert.deepEqual((only(calls, 'get_order')[0]!.arg as { holder?: unknown }).holder, EXEC);
  // The runner ran the order's command in the order's cwd (falls back to opts.cwd).
  assert.deepEqual(fr.starts, [{ command: 'make build', cwd: '/work' }]);
  // Exactly one receipt to the owed path.
  assert.equal(submits.length, 1);
  assert.equal(submits[0]!.path, 'out');
  // W7/D4: submit carries the exec holder through too, not just get_order.
  assert.deepEqual(submits[0]!.holder, EXEC);
  const receipt = submits[0]!.value as CommandReceipt;
  assert.equal(receipt.kind, 'command-receipt');
  assert.equal(receipt.command, 'make build');
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.outputHash, 'sha256:abc');
  assert.equal(receipt.orchestrator, 'host:123');
  assert.equal(receipt.step, 'builder');
  // The run closed via submit → no release (release:false path).
  assert.equal(only(calls, 'release').length, 0);
});

test('uses the order workdir as the command cwd when the packet carries one', async () => {
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [commandOrder({ workdir: '/repo/wt' })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  await p;
  assert.equal(fr.starts[0]!.cwd, '/repo/wt');
});

test('submits a receipt to EVERY owed path, in order', async () => {
  const fr = fakeRunner();
  const { hub, submits } = mockHub({ getOrder: [commandOrder({ owes: ['a', 'b', 'c'] })], submit: ['green', 'submitted', 'green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submitted');
  assert.deepEqual(submits.map((s) => s.path), ['a', 'b', 'c']);
});

test('a non-zero exit still submits a receipt carrying the exit code (outcome submitted)', async () => {
  const fr = fakeRunner();
  const { hub, submits } = mockHub({ getOrder: [commandOrder()], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(3));
  assert.equal(await p, 'submitted');
  assert.equal((submits[0]!.value as CommandReceipt).exitCode, 3);
});

test('a machinery failure (runner done rejects) submits a null-exit receipt', async () => {
  const fr = fakeRunner();
  const { hub, submits } = mockHub({ getOrder: [commandOrder()], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.reject(new Error('spawn EACCES'));
  assert.equal(await p, 'submitted');
  const receipt = submits[0]!.value as CommandReceipt;
  assert.equal(receipt.exitCode, null);
  assert.equal(receipt.error, 'spawn EACCES');
});

test('a runner that throws at start submits a machinery-failure receipt', async () => {
  const fr = fakeRunner({ throwOnStart: new Error('cannot fork') });
  const { hub, submits } = mockHub({ getOrder: [commandOrder()], submit: ['green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'submitted');
  assert.equal((submits[0]!.value as CommandReceipt).exitCode, null);
  assert.equal((submits[0]!.value as CommandReceipt).error, 'cannot fork');
});

// ---- misroute (not exec's to fail) ------------------------------------------

test('a null order packet is a misroute — release, no run, no submit', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [nonCommandOrder(null)] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'misroute');
  assert.equal(fr.starts.length, 0);
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'release').length, 1);
});

test('an agent (non-command) worker is a misroute', async () => {
  const fr = fakeRunner();
  const { hub, calls } = mockHub({ getOrder: [commandOrder({ worker: 'agent' })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'misroute');
  assert.equal(fr.starts.length, 0);
  assert.equal(only(calls, 'release').length, 1);
});

test('a packet lacking owes entirely is a misroute, not a crash', async () => {
  const fr = fakeRunner();
  const base = commandOrder().order!;
  const malformed = { ...base, owes: undefined } as unknown as GetOrderResponse['order'];
  const { hub, calls, submits } = mockHub({ getOrder: [nonCommandOrder(malformed)] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'misroute');
  assert.equal(fr.starts.length, 0);
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'release').length, 1);
});

test('an order that owes nothing is a misroute', async () => {
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [commandOrder({ owes: [] })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'misroute');
  assert.equal(fr.starts.length, 0);
});

// ---- submit failures --------------------------------------------------------

test('a schema-rejected submit ⇒ submit-rejected (releases — the claim may still be ours)', async () => {
  const fr = fakeRunner();
  const { hub, calls } = mockHub({ getOrder: [commandOrder()], submit: ['schema-rejected'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submit-rejected');
  assert.equal(only(calls, 'release').length, 1);
});

test('a born-rejected submit ⇒ submit-rejected with NO release (the claim is already gone)', async () => {
  const fr = fakeRunner();
  const { hub, calls } = mockHub({ getOrder: [commandOrder()], submit: ['born-rejected'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submit-rejected');
  assert.equal(only(calls, 'release').length, 0);
});

test('a submit that throws ⇒ submit-failed (best-effort release)', async () => {
  const fr = fakeRunner();
  const { hub, calls } = mockHub({ getOrder: [commandOrder()], submit: [new Error('network down')] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submit-failed');
  assert.equal(only(calls, 'release').length, 1);
});

test('the first rejected submit stops the run — later owed paths are not written', async () => {
  const fr = fakeRunner();
  const { hub, submits } = mockHub({ getOrder: [commandOrder({ owes: ['a', 'b'] })], submit: ['schema-rejected', 'green'] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep();
  fr.resolve(result(0));
  assert.equal(await p, 'submit-rejected');
  assert.deepEqual(submits.map((s) => s.path), ['a']); // stopped after the rejection
});

// ---- lease lost mid-run -----------------------------------------------------

test('a 403 heartbeat while the command runs ⇒ kill, no submit, ownership-error', async () => {
  const fr = fakeRunner(); // command never settles
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder()],
    heartbeat: () => {
      throw new HubError(403, 'forbidden', 'forbidden');
    },
    submit: ['green'],
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'ownership-error');
  assert.equal(fr.state.kills, 1);
  assert.equal(submits.length, 0);
  // The exec holder rode the heartbeat too (plan decision 1).
  const beats = only(calls, 'heartbeat');
  assert.ok(beats.length >= 1);
  assert.deepEqual((beats[0]!.arg as { holder?: unknown }).holder, EXEC);
});

test('a lost lease (heartbeat fails, classify shows unclaimed) mid-run ⇒ kill, lease-lost', async () => {
  const fr = fakeRunner();
  const { hub, submits } = mockHub({
    getOrder: [commandOrder(), commandOrder({ claimed: false })], // fc holding, classify: gone
    heartbeat: () => {
      throw new HubError(500, 'lease gone');
    },
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'lease-lost');
  assert.equal(fr.state.kills, 1);
  assert.equal(submits.length, 0);
});

// ---- first contact terminal (no command) ------------------------------------

test('first contact already completed ⇒ completed, command never runs', async () => {
  const fr = fakeRunner();
  const { hub, calls, submits } = mockHub({ getOrder: [commandOrder({ claimed: false, outcome: 'ok' })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'completed');
  assert.equal(fr.starts.length, 0);
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'release').length, 0);
});

test('first contact unclaimed with no outcome ⇒ lease-lost, command never runs', async () => {
  const fr = fakeRunner();
  const { hub } = mockHub({ getOrder: [commandOrder({ claimed: false })] });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  assert.equal(await loop.run(), 'lease-lost');
  assert.equal(fr.starts.length, 0);
});

// ---- signal (final breath) --------------------------------------------------

test('a signal mid-run kills the command group, releases, and exits killed', async () => {
  const fr = fakeRunner(); // never settles
  const h: { loop?: ExecLoop } = {};
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder()],
    release: () => Promise.resolve({ text: '' }),
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  h.loop = loop;
  const p = loop.run();
  await macrotaskSleep(); // reach the run+race
  loop.stop('signal');
  assert.equal(await p, 'killed');
  assert.ok(fr.state.kills >= 1); // kill is idempotent; stop() + the lease race may both call it
  assert.equal(submits.length, 0);
  assert.equal(only(calls, 'release').length, 1);
});

test('no receipt when the killed command settles BEFORE the release resolves the lease', async () => {
  // The submit-after-kill race: stop() TERMs the command, which dies in
  // milliseconds, while the lease only resolves after the release HTTP
  // round-trip — so cmd.done wins the race. Killed work must still get NO
  // receipt (plan decisions 1 and 9).
  const fr = fakeRunner({ resolveOnKill: result(null, { signal: 'SIGTERM' }) });
  const { hub, calls, submits } = mockHub({
    getOrder: [commandOrder()],
    // A slow release: several macrotasks, so cmd.done (already resolved by the
    // kill) beats the lease promise to the race.
    release: () =>
      new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(() => r({ text: '' }))))),
  });
  const loop = createExecLoop(baseOpts(hub, fr.runner));
  const p = loop.run();
  await macrotaskSleep(); // reach the run+race
  loop.stop('signal'); // kill resolves cmd.done synchronously; release is still in flight
  assert.equal(await p, 'killed');
  assert.equal(submits.length, 0); // the whole point: no receipt for killed work
  assert.equal(only(calls, 'release').length, 1);
  assert.ok(fr.state.kills >= 1);
});
