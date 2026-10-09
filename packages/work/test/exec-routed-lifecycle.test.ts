import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createExecLoop, type ExecLoopOptions } from '../src/exec/loop.ts';
import { createRoutedGroupRunner, type CommandResult, type RoutedRunningCommand } from '../src/exec/runner.ts';
import type { RoutedExecutionController } from '../src/exec/routed-loop.ts';
import type { HubClient } from '../src/hub/client.ts';
import { HubError, type OrderPacket } from '../src/hub/types.ts';

const sleepForever = (): Promise<void> => new Promise(() => {});
const order = (): OrderPacket => ({
  workflow: 'root', run: 'native-run', step: 'build', key: 'build', worker: 'command',
  inputs: [], outputs: [], consumes: {}, owes: [{ path: 'out', version: 1,
    judgmentRejects: 0, schemaRejects: 0, reasons: [] }], defDigest: 'signed-digest',
  routing: {},
} as unknown as OrderPacket);
const direct = (): CommandResult => ({ exitCode: 0, outputHash: `sha256:${'0'.repeat(64)}`,
  stdoutBytes: 0, stderrBytes: 0, outputTail: '', startedAt: 1, finishedAt: 2, durationMs: 1 });

function fixture(events: string[], overrides: Partial<RoutedExecutionController> = {}, frameId = 'root') {
  const packet = order();
  packet.workflow = frameId;
  const hub = {
    async getOrder() { events.push('get-order'); return { text: '', workflow: 'root', run: 'native-run',
      order: packet, lease: { claimed: true } }; },
    async heartbeat() { events.push('heartbeat'); return { text: '' }; },
    async release() { throw new Error('ordinary broad release was called'); },
    async submit() { throw new Error('ordinary broad submit was called'); },
    async reject() { throw new Error('ordinary broad reject was called'); },
    async ask() { throw new Error('ordinary broad ask was called'); },
  } as unknown as HubClient;
  let starts = 0;
  const releaseObservations: unknown[] = [];
  const control: RoutedExecutionController = {
    frameId,
    runner: { start(): RoutedRunningCommand {
      starts++;
      events.push('physical-start');
      return { done: Promise.resolve(direct()), kill: async () => {},
	async settleEffects() { events.push('group-empty'); return { scope: 'original-posix-group',
	  state: 'empty', evidence: { pgid: 42, observedAt: 0, reason: 'test' } }; } };
    } },
    async prestart() { events.push('prestart'); return { cleanup: async () => { events.push('cache-cleanup'); } }; },
    async quiesce() { events.push('freeze'); return { quiescing: true, effects: 'settled' }; },
    async postrun({ receipt }) { events.push('parent-postrun'); assert.equal(receipt.kind, 'command-receipt');
      return { outcome: 'submitted', claim: 'closed' }; },
    async targetedRelease(_order, _reason, observation) { events.push('targeted-release');
      releaseObservations.push(observation); return 'released'; },
    ...overrides,
  };
  const opts: ExecLoopOptions = {
    hub, runner: { start: () => { throw new Error('ordinary runner used'); } },
    workflow: 'root', run: 'native-run', holder: { kind: 'exec', id: 'host:1' },
    instructions: { async resolveCommand() { events.push('signed-resolve'); return { ok: true,
      command: 'printf hello' }; },
      async resolveRoutedCommandDefinition() { events.push('signed-resolve'); return { ok: true,
	command: 'printf hello', inputWitnessRequired: true }; },
      async resolveStep() { throw new Error('unused'); } },
    routedExecution: control, routedPublicEnv: { HOME: '/private/public-stage',
      OWENLOOP_CONFIG_DIR: '/private/public-stage/config' },
    env: { PATH: process.env.PATH, HOME: '/private/original-home' },
    cwd: tmpdir(), sleep: sleepForever, now: Date.now, out: () => {}, err: () => {},
  };
  return { opts, control, starts: () => starts, releaseObservations };
}

test('fenced routed success uses one prestart/start and parent postrun only after freeze and original-group settlement', async () => {
  const events: string[] = [];
  const { opts, starts } = fixture(events);
  assert.equal(await createExecLoop(opts).run(), 'submitted', JSON.stringify(events));
  assert.equal(starts(), 1);
  assert.equal(events.filter((event) => event === 'prestart').length, 1);
  assert.deepEqual(events.filter((event) => event !== 'get-order' && event !== 'signed-resolve'), [
    'prestart', 'physical-start', 'freeze', 'group-empty',
    'parent-postrun', 'cache-cleanup',
  ]);
});

test('native root lease accepts only the exact signed child frame', async () => {
  const events: string[] = [];
  const nested = fixture(events, {}, 'routing/child-frame');
  assert.equal(await createExecLoop(nested.opts).run(), 'submitted');
  assert.equal(nested.starts(), 1);
  const wrongEvents: string[] = [];
  const wrong = fixture(wrongEvents, { frameId: 'routing/other-frame' }, 'routing/child-frame');
  assert.equal(await createExecLoop(wrong.opts).run(), 'unresolved-instructions');
  assert.equal(wrong.starts(), 0);
  assert.ok(!wrongEvents.includes('parent-postrun'));
});

test('routed mode refuses simultaneous ordinary prestart before first contact', () => {
  const events: string[] = [];
  const { opts } = fixture(events);
  assert.throws(() => createExecLoop({ ...opts, routedPrestart: async () => {} }), /ordinary prestart seam/);
  assert.deepEqual(events, []);
});

test('invalid or unbounded controller budgets refuse before first contact', () => {
  for (const invalid of [0, -1, Number.POSITIVE_INFINITY, Number.NaN, 3_600_001]) {
    const events: string[] = [];
    const { opts } = fixture(events, { lifecycleDeadlineMs: invalid });
    assert.throws(() => createExecLoop(opts), /invalid routed lifecycleDeadlineMs/);
    assert.deepEqual(events, []);
  }
});

test('prestart ambiguity yields zero starts and no broad consequence', async () => {
  const events: string[] = [];
  const { opts, starts, releaseObservations } = fixture(events, { async prestart() {
    events.push('prestart'); throw new Error('lost report ACK'); } });
  assert.equal(await createExecLoop(opts).run(), 'unresolved-instructions');
  assert.equal(starts(), 0);
  assert.deepEqual(releaseObservations, [{ observation: 'not-started' }]);
  assert.deepEqual(events.slice(-2), ['freeze', 'targeted-release']);
});

test('stalled original-session first contact is bounded without ordinary release', async () => {
  const events: string[] = [];
  const { opts, starts } = fixture(events, { prestartDeadlineMs: 15, leaseRpcDeadlineMs: 25 });
  opts.hub = { ...opts.hub, async getOrder() { events.push('get-order-pending');
    return new Promise(() => {}); } } as HubClient;
  assert.equal(await createExecLoop(opts).run(), 'routed-quarantined');
  assert.equal(starts(), 0);
  assert.ok(events.includes('get-order-pending'));
  assert.ok(!events.includes('targeted-release'));
  assert.ok(!events.includes('parent-postrun'));
});

test('operator stop during one-use prestart never starts a shell or postrun', async () => {
  const events: string[] = [];
  let entered!: () => void;
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { opts, starts, releaseObservations } = fixture(events, { prestart: async () => {
    events.push('prestart'); entered(); await pending;
    return { cleanup: async () => { events.push('cache-cleanup'); } };
  } });
  const loop = createExecLoop(opts);
  const running = loop.run();
  await waiting;
  loop.stop();
  finish();
  assert.equal(await running, 'killed');
  assert.equal(starts(), 0);
  assert.deepEqual(releaseObservations, [{ observation: 'not-started' }]);
  assert.ok(!events.includes('parent-postrun'));
  assert.ok(events.includes('targeted-release'));
  assert.ok(events.includes('cache-cleanup'));
});

test('uncertain original group preserves cache and withholds postrun/release', async () => {
  const events: string[] = [];
  const { opts, control } = fixture(events);
  control.runner = { start() { events.push('physical-start'); return { done: Promise.resolve(direct()),
    kill: async () => {}, async settleEffects() { events.push('group-uncertain'); return {
      scope: 'original-posix-group', state: 'uncertain', evidence: { pgid: 42, observedAt: 0, reason: 'test' },
    }; } }; } };
  assert.equal(await createExecLoop(opts).run(), 'routed-quarantined');
  assert.ok(events.includes('freeze'));
  assert.ok(!events.includes('parent-postrun'));
  assert.ok(!events.includes('targeted-release'));
  assert.ok(!events.includes('cache-cleanup'));
});

test('ambiguous physical start is never retried or released', async () => {
  const events: string[] = [];
  const { opts, control } = fixture(events);
  control.runner = { start() { events.push('physical-start-attempt'); throw new Error('unknown spawn outcome'); } };
  assert.equal(await createExecLoop(opts).run(), 'routed-quarantined');
  assert.equal(events.filter((event) => event === 'physical-start-attempt').length, 1);
  assert.ok(!events.includes('targeted-release'));
  assert.ok(!events.includes('cache-cleanup'));
});

test('lost parent postrun ACK quarantines exact dispatched receipt without release or cleanup', async () => {
  const events: string[] = [];
  const { opts, control } = fixture(events);
  control.postrun = async () => { events.push('parent-postrun-dispatched'); throw new Error('ACK lost'); };
  assert.equal(await createExecLoop(opts).run(), 'routed-quarantined');
  assert.equal(events.filter((event) => event === 'parent-postrun-dispatched').length, 1);
  assert.ok(!events.includes('targeted-release'));
  assert.ok(!events.includes('cache-cleanup'));
});

test('stop aborts an awaited parent postrun before any later Hub effect', async () => {
  const events: string[] = [];
  let entered!: () => void;
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { opts, control } = fixture(events);
  control.postrun = async (_input, ctx) => {
    events.push('postrun-signing'); entered(); await pending;
    if (ctx.signal.aborted) return { outcome: 'command-failed', claim: 'uncertain' };
    events.push('new-hub-submit');
    return { outcome: 'submitted', claim: 'closed' };
  };
  const loop = createExecLoop(opts);
  const result = loop.run();
  await waiting;
  loop.stop();
  finish();
  assert.equal(await result, 'routed-quarantined');
  assert.ok(!events.includes('new-hub-submit'));
  assert.ok(!events.includes('targeted-release'));
  assert.ok(!events.includes('cache-cleanup'));
});

test('incomplete direct output never enters parent postrun', async () => {
  const events: string[] = [];
  const { opts, control } = fixture(events);
  control.runner = { start() { events.push('physical-start'); return {
    done: Promise.resolve({ ...direct(), exitCode: null, error: 'output-incomplete' }),
    kill: async () => {}, async settleEffects() { events.push('group-empty'); return {
      scope: 'original-posix-group', state: 'empty', evidence: { pgid: 42, observedAt: 0, reason: 'test' },
    }; },
  }; } };
  assert.equal(await createExecLoop(opts).run(), 'unresolved-instructions');
  assert.ok(!events.includes('parent-postrun'));
  assert.ok(events.includes('targeted-release'));
});

test('clean stop during broker quiesce reaches release and cleanup but no postrun', async () => {
  const events: string[] = [];
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const closing = new Promise<{quiescing:true;effects:'settled'}>((resolve) => {
    finish = () => resolve({ quiescing:true, effects:'settled' }); });
  const { opts } = fixture(events, { quiesce: async () => {
    events.push('freeze-pending'); enter(); return closing; } });
  const loop = createExecLoop(opts);
  const running = loop.run();
  await entered;
  loop.stop('test stop');
  finish();
  assert.equal(await running, 'killed');
  assert.equal(events.filter((event) => event === 'freeze-pending').length, 1);
  assert.ok(!events.includes('parent-postrun'));
  assert.ok(events.indexOf('freeze-pending') < events.indexOf('targeted-release'));
  assert.ok(events.indexOf('targeted-release') < events.indexOf('cache-cleanup'));
});

test('uncertain stop preserves bytes and refuses release', async () => {
  const events: string[] = [];
  const { opts, control } = fixture(events);
  control.quiesce = async () => { events.push('freeze-uncertain');
    return { quiescing: true, effects: 'uncertain' }; };
  let entered!: () => void;
  const beforeDone = new Promise<void>((resolve) => { entered = resolve; });
  control.runner = { start() { events.push('physical-start'); entered(); return {
    done: new Promise<CommandResult>(() => {}), kill: async () => {},
    async settleEffects() { events.push('group-empty'); return { scope: 'original-posix-group',
      state: 'empty', evidence: { pgid: 42, observedAt: 0, reason: 'test' } }; },
  }; } };
  const loop = createExecLoop(opts);
  const running = loop.run();
  await beforeDone;
  loop.stop();
  assert.equal(await running, 'routed-quarantined');
  assert.ok(!events.includes('targeted-release'));
  assert.ok(!events.includes('cache-cleanup'));
});

test('terminal native lease during a live shell quarantines despite exact local closures', async () => {
  const events: string[] = [];
  let tick!: () => void;
  const tickGate = new Promise<void>((resolve) => { tick = resolve; });
  let started!: () => void;
  const startedGate = new Promise<void>((resolve) => { started = resolve; });
  const { opts, control } = fixture(events);
  const originalHub = opts.hub;
  opts.hub = { ...originalHub, async heartbeat() { events.push('heartbeat-forbidden');
    throw new HubError(403, 'old claim'); } } as HubClient;
  opts.sleep = async () => tickGate;
  control.runner = { start() { events.push('physical-start'); started(); return {
    done: new Promise<CommandResult>(() => {}), kill: async () => {},
    async settleEffects() { events.push('group-empty'); return { scope: 'original-posix-group',
      state: 'empty', evidence: { pgid: 42, observedAt: 0, reason: 'test' } }; },
  }; } };
  const result = createExecLoop(opts).run();
  await startedGate;
  tick();
  assert.equal(await result, 'routed-quarantined');
  assert.ok(events.includes('heartbeat-forbidden'));
  assert.ok(events.includes('group-empty'));
  assert.ok(!events.includes('parent-postrun'));
  assert.ok(!events.includes('targeted-release'));
  assert.ok(!events.includes('cache-cleanup'));
});

test('stalled heartbeat RPC becomes terminal under monotonic failure window', async () => {
  const events: string[] = [];
  const { opts, control } = fixture(events, { leaseRpcDeadlineMs: 20 });
  const originalHub = opts.hub;
  opts.hub = { ...originalHub, async heartbeat() { events.push('heartbeat-pending');
    return new Promise(() => {}); } } as HubClient;
  opts.sleep = async () => {};
  opts.failureWindowMs = 35;
  opts.heartbeatIntervalMs = 1;
  control.runner = { start() { events.push('physical-start'); return {
    done: new Promise<CommandResult>(() => {}), kill: async () => {},
    async settleEffects() { events.push('group-empty'); return { scope: 'original-posix-group',
      state: 'empty', evidence: { pgid: 42, observedAt: 0, reason: 'test' } }; },
  }; } };
  assert.equal(await createExecLoop(opts).run(), 'routed-quarantined');
  assert.ok(events.filter((event) => event === 'heartbeat-pending').length >= 2);
  assert.ok(events.includes('group-empty'));
  assert.ok(!events.includes('targeted-release'));
  assert.ok(!events.includes('cache-cleanup'));
});

test('stalled parent quiesce times out and late completion cannot release or delete', async () => {
  const events: string[] = [];
  let finish!: () => void;
  let custodySignal: AbortSignal | undefined;
  const held = new Promise<{quiescing:true;effects:'settled'}>((resolve) => {
    finish = () => resolve({ quiescing:true, effects:'settled' }); });
  const { opts } = fixture(events, { lifecycleDeadlineMs: 25, quiesce: async (ctx) => {
    custodySignal = ctx.signal;
    events.push('freeze-pending'); return held; } });
  assert.equal(await createExecLoop(opts).run(), 'routed-quarantined');
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(custodySignal?.aborted, false, 'parent custody remains independently live');
  assert.ok(!events.includes('parent-postrun'));
  assert.ok(!events.includes('targeted-release'));
  assert.ok(!events.includes('cache-cleanup'));
});

test('lost quiesce ACK still starts retained group settlement', async () => {
  const events: string[] = [];
  const { opts } = fixture(events, { lifecycleDeadlineMs: 25,
    quiesce: async () => { events.push('freeze-pending'); return new Promise(() => {}); },
  });
  assert.equal(await createExecLoop(opts).run(), 'routed-quarantined');
  assert.ok(events.indexOf('group-empty') > events.indexOf('freeze-pending'));
  assert.ok(!events.includes('parent-postrun'));
  assert.ok(!events.includes('targeted-release'));
  assert.ok(!events.includes('cache-cleanup'));
});

test('real same-group writer stops despite lost quiesce ACK; role stays quarantined', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-routed-stop-'));
  try {
    const events: string[] = [];
    const { opts, control } = fixture(events, { lifecycleDeadlineMs: 100,
      quiesce: async () => { events.push('freeze-pending'); return new Promise(() => {}); },
    });
    const real = createRoutedGroupRunner({ graceMs: 20 });
    let group!: RoutedRunningCommand;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    control.runner = { start(command, options) { group = real.start(command, options); started(); return group; } };
    opts.cwd = cwd;
    const written = join(cwd, 'writes.txt');
    opts.instructions = { async resolveCommand() { return { ok: true,
      command: `${JSON.stringify(process.execPath)} -e "setInterval(()=>require('fs').appendFileSync(process.argv[1],'x'),5)" ${JSON.stringify(written)}`,
    }; }, async resolveRoutedCommandDefinition() { return { ok: true, inputWitnessRequired: true,
      command: `${JSON.stringify(process.execPath)} -e "setInterval(()=>require('fs').appendFileSync(process.argv[1],'x'),5)" ${JSON.stringify(written)}`,
    }; }, async resolveStep() { throw new Error('unused'); } };
    const loop = createExecLoop(opts);
    const result = loop.run();
    await startedPromise;
    for (let tries = 0; tries < 40 && !existsSync(written); tries++)
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.ok(existsSync(written), 'writer reached its workdir');
    loop.stop();
    assert.equal(await result, 'routed-quarantined');
    const settled = await group.settleEffects({ reason: 'stop', deadlineAt: performance.now() + 2_000 });
    assert.equal(settled.state, 'empty');
    const size = statSync(written).size;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(statSync(written).size, size, 'no same-group writes after settlement');
    assert.ok(!events.includes('targeted-release'));
    assert.ok(!events.includes('cache-cleanup'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('timed-out targeted release keeps bytes even if release resolves later', async () => {
  const events: string[] = [];
  let finish!: () => void;
  const held = new Promise<'released'>((resolve) => { finish = () => resolve('released'); });
  const { opts } = fixture(events, { lifecycleDeadlineMs: 25,
    targetedRelease: async () => { events.push('targeted-release-pending'); return held; },
    postrun: async () => { events.push('parent-postrun'); return { outcome: 'command-failed', claim: 'held' }; },
  });
  assert.equal(await createExecLoop(opts).run(), 'routed-quarantined');
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(!events.includes('cache-cleanup'));
});

test('stop aborts a not-yet-dispatched normal targeted release', async () => {
  const events: string[] = [];
  let entered!: () => void;
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { opts } = fixture(events, {
    postrun: async () => ({ outcome: 'command-failed', claim: 'held' }),
    targetedRelease: async (_order, _reason, _group, ctx) => {
      events.push('release-preflight'); entered(); await pending;
      if (ctx.signal.aborted) return 'uncertain';
      events.push('native-release-write'); return 'released';
    },
  });
  const loop = createExecLoop(opts);
  const result = loop.run();
  await waiting;
  loop.stop();
  finish();
  assert.equal(await result, 'routed-quarantined');
  assert.ok(!events.includes('native-release-write'));
  assert.ok(!events.includes('cache-cleanup'));
});

test('clean-stop release timeout aborts later write while parent custody persists', async () => {
  const events: string[] = [];
  let started!: () => void;
  const startedGate = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void;
  let releaseSignal: AbortSignal | undefined;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const { opts, control } = fixture(events, { lifecycleDeadlineMs: 25,
    targetedRelease: async (_order, _reason, _group, ctx) => {
      releaseSignal = ctx.signal; events.push('clean-stop-release-pending');
      await held;
      if (ctx.signal.aborted) return 'uncertain';
      events.push('native-release-write'); return 'released';
    },
  });
  control.runner = { start() { started(); return { done: new Promise<CommandResult>(() => {}),
    kill: async () => {}, async settleEffects() { events.push('group-empty'); return {
      scope: 'original-posix-group', state: 'empty', evidence: { pgid: 42, observedAt: 0, reason: 'test' },
    }; } }; } };
  const loop = createExecLoop(opts);
  const result = loop.run();
  await startedGate;
  loop.stop();
  assert.equal(await result, 'routed-quarantined');
  assert.equal(releaseSignal?.aborted, true);
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(!events.includes('native-release-write'));
  assert.ok(!events.includes('cache-cleanup'));
});

test('expired lifecycle before postrun invokes no parent consequence callback', async () => {
  const events: string[] = [];
  const { opts } = fixture(events, { lifecycleDeadlineMs: 5 });
  opts.instructions = { async resolveCommand() { return { ok: true, command: 'printf hello',
    revalidateAfterRun: async () => { events.push('postrun-revalidate-pending');
      await new Promise<void>((resolve) => setTimeout(resolve, 15)); return undefined; } }; },
    async resolveRoutedCommandDefinition() { return { ok: true, command: 'printf hello',
      inputWitnessRequired: true, revalidateAfterRun: async () => {
	events.push('postrun-revalidate-pending');
	await new Promise<void>((resolve) => setTimeout(resolve, 15)); return undefined; } }; },
    async resolveStep() { throw new Error('unused'); } };
  assert.equal(await createExecLoop(opts).run(), 'routed-quarantined');
  assert.ok(events.includes('postrun-revalidate-pending'));
  assert.ok(!events.includes('parent-postrun'));
  assert.ok(!events.includes('targeted-release'));
});

test('expired lifecycle after exact postrun invokes no targeted release', async () => {
  const events: string[] = [];
  const { opts } = fixture(events, { lifecycleDeadlineMs: 5,
    postrun: async () => { events.push('parent-postrun');
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      return { outcome: 'command-failed', claim: 'held' }; },
  });
  assert.equal(await createExecLoop(opts).run(), 'routed-quarantined');
  assert.ok(events.includes('parent-postrun'));
  assert.ok(!events.includes('targeted-release'));
  assert.ok(!events.includes('cache-cleanup'));
});

test('real managed runner writes the permitted cwd before parent receipt; original-group proof is scoped', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-routed-exec-'));
  try {
    const events: string[] = [];
    const { opts, control } = fixture(events);
    control.runner = createRoutedGroupRunner({ graceMs: 30 });
    opts.cwd = cwd;
    opts.instructions = { async resolveCommand() { return { ok: true,
      command: `printf live > ${JSON.stringify(join(cwd, 'write.txt'))}` }; },
      async resolveRoutedCommandDefinition() { return { ok: true, inputWitnessRequired: true,
	command: `printf live > ${JSON.stringify(join(cwd, 'write.txt'))}` }; },
      async resolveStep() { throw new Error('unused'); } };
    control.postrun = async ({ receipt }) => {
      events.push('parent-postrun');
      assert.equal(readFileSync(join(cwd, 'write.txt'), 'utf8'), 'live');
      assert.equal(receipt.exitCode, 0);
      return { outcome: 'submitted', claim: 'closed' };
    };
    assert.equal(await createExecLoop(opts).run(), 'submitted');
    assert.equal(readFileSync(join(cwd, 'write.txt'), 'utf8'), 'live');
    assert.ok(events.indexOf('group-empty') < events.indexOf('parent-postrun'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
