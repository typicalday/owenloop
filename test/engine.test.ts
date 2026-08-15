import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, ModifierRefusalError } from '../src/engine.ts';
import type { Order } from '../src/engine.ts';
import { buildDef, hashDef } from '../src/defs.ts';
import { createDefInstructionSource } from '../src/order-resolver.ts';
import type { OrderInstructionSource } from '../src/order-resolver.ts';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { StepDef, WorkflowDef } from '../src/types.ts';
import { assertReferenceContract, def, input, step } from './helpers.ts';

// ---- fixtures & harness ------------------------------------------------------

const delivery = def(
  'delivery',
  [input('proposal')],
  [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
    step({ name: 'reviewer', consumes: ['pr'], produces: ['verdict'] }),
    step({ name: 'merger', consumes: ['verdict'], produces: ['merge'] }),
  ],
);

const research = def(
  'research',
  [input('question')],
  [
    step({ name: 'gather', consumes: ['question'], produces: ['gather.source[]'] }),
    step({
      name: 'formatcheck',
      consumes: ['gather.source[$i]'],
      produces: ['gather.source[$i].formatcheck'],
    }),
    step({ name: 'synthesize', consumes: ['gather.source[*]'], produces: ['draft'] }),
  ],
);

function makeEngine(
  defs: WorkflowDef[],
  opts: { reapTtlMs?: number; instructionSource?: OrderInstructionSource } = {},
): {
  engine: Engine;
  store: Store;
} {
  const store = openStore(':memory:');
  const byName = new Map(defs.map((d) => [d.name, d]));
  const engine = new Engine(
    store,
    (name) => {
      const d = byName.get(name);
      if (!d) throw new Error(`no def: ${name}`);
      return d;
    },
    // Default mirrors the factory/CLI wiring: seed the loaded-def adapter
    // with the registered defs. An explicit source replaces it outright.
    {
      ...(opts.reapTtlMs !== undefined ? { reapTtlMs: opts.reapTtlMs } : {}),
      instructionSource: opts.instructionSource ?? createDefInstructionSource(defs),
    },
  );
  return { engine, store };
}

/** Tick and return the single order for `step`, asserting exactly one exists. */
function fire(engine: Engine, wf: string, stepName: string, now: number): Order {
  const t = engine.tick(wf, { now });
  const matching = t.orders.filter((o) => o.step === stepName);
  assert.equal(
    matching.length,
    1,
    `expected exactly one ${stepName} order at t=${now}, got [${t.orders.map((o) => o.step)}]`,
  );
  return matching[0]!;
}

/** Drive a plain step's order to green and close it. */
function complete(engine: Engine, wf: string, o: Order, value: Record<string, unknown> = {}, opts: { terminal?: boolean } = {}): void {
  for (const out of o.outputs) engine.green(wf, o.run, out, value, opts);
  engine.close(wf, o.run);
}

// ---- the happy path ----------------------------------------------------------

test('happy path: planner → builder → reviewer → merger to done', () => {
  const { engine } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery');

  complete(engine, wf, fire(engine, wf, 'planner', 1000), { plan: 'v1' });
  complete(engine, wf, fire(engine, wf, 'builder', 2000), { pr: 1 });
  complete(engine, wf, fire(engine, wf, 'reviewer', 3000), { ok: true });
  complete(engine, wf, fire(engine, wf, 'merger', 4000), { merged: true }, { terminal: true });

  const s = engine.status(wf);
  assert.equal(s.done, true);
  assert.equal(s.debts.length, 0);

  // nothing left to do
  assert.equal(engine.tick(wf, { now: 5000 }).orders.length, 0);
});

test('a firing carries its consumed input handles, claim-time fingerprint, and owed reason thread', () => {
  const { engine } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery', { provide: { proposal: { goal: 'ship it' } } });

  const planner = fire(engine, wf, 'planner', 1000);
  assert.deepEqual(planner.consumes, { proposal: { goal: 'ship it' } });
  assert.deepEqual(planner.consumedFingerprint, { proposal: 1 });
  assert.deepEqual(planner.outputs, ['plan']);
  assert.deepEqual(planner.owes.map((w) => w.path), ['plan']);
});

test("an owed output's issued version is the target the consumer later checks a proof against", () => {
  // The producer signs `owes[].version` into its submission proof; the consumer
  // passes its own claim-time fingerprint to verifyConsumed as expectedVersion.
  // Those two numbers must be the same one, which is why the engine issues the
  // target (committed + 1) rather than the currently-committed version.
  const { engine } = makeEngine([orderShapeDef()]);
  const wf = engine.createInstance('ordershape', { provide: { proposal: { text: 'x' } } });

  // a never-produced artifact sits at v0, so its first target is v1
  const planner1 = fire(engine, wf, 'planner', 1000);
  const target1 = planner1.owes.find((w) => w.path === 'plan')!.version;
  assert.equal(target1, 1);
  complete(engine, wf, planner1, { plan: 'v1' });

  const runner1 = fire(engine, wf, 'runner', 2000);
  assert.equal(runner1.consumedFingerprint!.plan, target1, 'the producer signs what the consumer checks');
  complete(engine, wf, runner1, { result: 'ok' });

  // a knock-back re-fires the producer under a NEW claim, which issues a fresh
  // target — the stale one is never reused
  engine.reject(wf, 'plan', 'runner', 'needs rework');
  const planner2 = fire(engine, wf, 'planner', 3000);
  const target2 = planner2.owes.find((w) => w.path === 'plan')!.version;
  assert.equal(target2, target1 + 1);
  complete(engine, wf, planner2, { plan: 'v2' });

  const runner2 = fire(engine, wf, 'runner', 4000);
  assert.equal(runner2.consumedFingerprint!.plan, target2);
});

test('a missing human input is not fireable, so no claim can emit a negative fingerprint version', () => {
  const missingInputDef = def(
    'missing-input',
    [input('question', { seedOwed: true })],
    [step({ name: 'producer', consumes: ['question'], produces: ['answer'] })],
  );
  const { engine } = makeEngine([missingInputDef]);
  const wf = engine.createInstance('missing-input');
  const tick = engine.tick(wf, { now: 1000 });
  assert.equal(tick.orders.length, 0);
});

test('workdirFrom resolves a nested consumed value into the reference order without normalizing the path', () => {
  const dynamic = def(
    'dynamic-workdir',
    [input('workspace')],
    [step({
      name: 'builder',
      consumes: ['workspace'],
      produces: ['pr'],
      workdirFrom: 'workspace.payload.worktreePath',
      body: 'SENTINEL dynamic workdir prompt',
    })],
  );
  const { engine, store } = makeEngine([dynamic]);
  const wf = engine.createInstance('dynamic-workdir', {
    provide: { workspace: { payload: { worktreePath: ' ./repo/worktree ' } } },
  });

  const order = fire(engine, wf, 'builder', 1000);
  assertReferenceContract(order);
  assert.equal(order.workdir, ' ./repo/worktree ', 'the authored path bytes pass through unchanged');
  assert.deepEqual(order.consumes, { workspace: { payload: { worktreePath: ' ./repo/worktree ' } } });
  assert.equal(store.listRuns(wf).length, 1);
  assert.equal(store.listRuns(wf)[0]!.order?.workdir, ' ./repo/worktree ');
});

test('workdirFrom resolves a declared input the step does not consume, and defers until it is provided', () => {
  // The delivery shape: a command step that creates the worktree cannot consume
  // anything (a human seed carries no producer signature, and the command-order
  // consumed gate hard-refuses that), so the run-supplied project root reaches
  // it as the resolved cwd instead.
  const dynamic = def(
    'input-workdir',
    [input('target', { seedOwed: true })],
    [step({
      name: 'provisioner',
      consumes: [],
      produces: ['workspace'],
      workdirFrom: 'target.path',
      body: 'SENTINEL input workdir prompt',
    })],
  );
  const { engine, store } = makeEngine([dynamic]);
  const wf = engine.createInstance('input-workdir');

  // Owed: the step is otherwise eligible, so the ONLY thing holding it is the
  // input. It must defer rather than fire with no workdir, and must not burn a
  // run, a task claim, or budget while it waits.
  const first = engine.tick(wf, { now: 1000 });
  assert.deepEqual(first.orders, []);
  assert.equal(first.deferred.length, 1);
  assert.equal(first.deferred[0]!.reason, 'workdir-unresolved');
  assert.match(first.deferred[0]!.detail ?? '', /input 'target' is not green yet/);
  assert.equal(store.listRuns(wf).length, 0);

  // Provided: the same step now fires with the input's value as its cwd, and
  // the value does NOT appear in order.consumes — it never became a consume.
  engine.provideInput(wf, 'target', { path: '/Users/alex/code/dev' });
  const order = fire(engine, wf, 'provisioner', 2000);
  assert.equal(order.workdir, '/Users/alex/code/dev');
  assert.deepEqual(order.consumes, {});
  assert.equal(store.listRuns(wf)[0]!.order?.workdir, '/Users/alex/code/dev');
});

test('workdirFrom defers unresolved values without emitting an order, run, task, budget use, or parallel claim', () => {
  const cases: Array<{ label: string; workspace: Record<string, unknown>; detail: RegExp }> = [
    {
      label: 'missing nested property',
      workspace: { payload: {} },
      detail: /value at 'payload\.worktreePath' is undefined/,
    },
    {
      label: 'non-object intermediate',
      workspace: { payload: 'not-an-object' },
      detail: /value at 'payload\.worktreePath' is not an object/,
    },
    {
      label: 'array intermediate',
      workspace: { payload: [] },
      detail: /value at 'payload\.worktreePath' is not an object/,
    },
    {
      label: 'non-string final value',
      workspace: { payload: { worktreePath: 42 } },
      detail: /value at 'payload\.worktreePath' must be a non-empty string/,
    },
    {
      label: 'empty final value',
      workspace: { payload: { worktreePath: '' } },
      detail: /value at 'payload\.worktreePath' must be a non-empty string/,
    },
    {
      label: 'whitespace-only final value',
      workspace: { payload: { worktreePath: ' \t ' } },
      detail: /value at 'payload\.worktreePath' must be a non-empty string/,
    },
  ];

  for (const [index, candidate] of cases.entries()) {
    const workflow = `dynamic-workdir-${index}`;
    const dynamic = def(
      workflow,
      [input('workspace')],
      [step({
        name: 'builder',
        consumes: ['workspace'],
        produces: ['pr'],
        workdirFrom: 'workspace.payload.worktreePath',
        maxRunsPerDay: 1,
        parallel: 1,
      })],
    );
    const { engine, store } = makeEngine([dynamic]);
    const wf = engine.createInstance(workflow, { provide: { workspace: candidate.workspace } });

    const first = engine.tick(wf, { now: 1000 });
    assert.deepEqual(first.orders, [], candidate.label);
    assert.equal(first.deferred.length, 1, candidate.label);
    assert.equal(first.deferred[0]!.reason, 'workdir-unresolved', candidate.label);
    assert.match(first.deferred[0]!.detail ?? '', candidate.detail, candidate.label);
    assert.equal(store.listRuns(wf).length, 0, `${candidate.label}: unresolved workdir must not insert a run`);
    assert.equal(store.getTask(wf, 'builder', ''), undefined, `${candidate.label}: unresolved workdir must not claim a task`);
    assert.equal(store.countRuns(wf, 'builder', 0), 0, `${candidate.label}: unresolved workdir must not use budget`);

    // A second tick must still reach workdir resolution. If the first attempt had
    // consumed the parallel slot or daily budget, this would report that gate instead.
    const second = engine.tick(wf, { now: 2000 });
    assert.deepEqual(second.orders, [], `${candidate.label}: second tick`);
    assert.equal(second.deferred[0]!.reason, 'workdir-unresolved', `${candidate.label}: second tick`);
    assert.equal(store.listRuns(wf).length, 0, `${candidate.label}: repeated deferral must not insert a run`);
  }
});

test('workdir-unresolved preserves an idle alarm so the firing can retry', () => {
  const dynamic = def(
    'dynamic-idle-workdir',
    [input('workspace'), input('pending', { seedOwed: true })],
    [step({
      name: 'builder',
      consumes: ['workspace'],
      produces: ['pr'],
      workdirFrom: 'workspace.payload.worktreePath',
      on: ['idle'],
      idleAfterMs: 60_000,
    })],
  );
  const { engine, store } = makeEngine([dynamic]);
  const wf = engine.createInstance('dynamic-idle-workdir', {
    provide: { workspace: { payload: {} } },
  });
  const alarm = 5_000;
  engine.setAlarm(wf, 'builder', alarm);

  const first = engine.tick(wf, { now: alarm });
  assert.equal(first.orders.length, 0);
  assert.equal(first.deferred[0]!.reason, 'workdir-unresolved');
  assert.equal(store.getAlarm(wf, 'builder'), alarm);

  const second = engine.tick(wf, { now: alarm });
  assert.equal(second.deferred[0]!.reason, 'workdir-unresolved');
  assert.equal(store.getAlarm(wf, 'builder'), alarm);
});

test('claim persists the emitted order packet in the same txn — present the moment tick returns', () => {
  const { engine, store } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery', { provide: { proposal: { goal: 'ship it' } } });

  const planner = fire(engine, wf, 'planner', 1000);
  // The emitted Order IS the persisted packet, written in the claim txn — so it
  // is already on the run row the instant tick returns (no separate write).
  assert.deepStrictEqual(store.getRun(planner.run)?.order, planner);
});

test('sweep: every claimed run row carries a persisted order whose run/step match the row', () => {
  const { engine, store } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery', { provide: { proposal: { text: 'x' } } });

  complete(engine, wf, fire(engine, wf, 'planner', 1000), { plan: 'v1' });
  complete(engine, wf, fire(engine, wf, 'builder', 2000), { pr: 1 });
  complete(engine, wf, fire(engine, wf, 'reviewer', 3000), { ok: true });

  const runs = store.listRuns(wf);
  assert.ok(runs.length >= 3, 'at least the three claimed steps produced run rows');
  for (const row of runs) {
    assert.ok(row.order, `run ${row.id} (${row.step}) has a persisted order`);
    assert.equal(row.order!.run, row.id, 'order.run matches the row id');
    assert.equal(row.order!.step, row.step, 'order.step matches the row step');
  }
});

test('§27.3: a step-level x: rides through buildOrder onto the Order untouched; steps without x: emit orders without it', () => {
  const stepX = { agentProfile: 'claude-research', budget: { maxTokens: 400_000 }, tools: ['search_web'] };
  const wfDef = def(
    'xflow',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'], x: stepX }),
      step({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
    ],
  );
  const { engine } = makeEngine([wfDef]);
  const wf = engine.createInstance('xflow');

  const planner = fire(engine, wf, 'planner', 1000);
  // carried through verbatim — same pass-through contract as `model`
  assert.deepEqual(planner.x, stepX);
  complete(engine, wf, planner, { plan: 'v1' });

  const builder = fire(engine, wf, 'builder', 2000);
  assert.equal(builder.x, undefined);
});

// ---- WP-B1 reference-mode order contract -------------------------------------
// (assertReferenceContract lives in helpers.ts — every emission test uses it)

/** Sentinel strings unique per order-shape test, so a leak is unambiguous. */
const RUNNER_SENTINEL = 'SENTINEL-cmd-b9f3 runner command';
const AGENT_SENTINEL = 'SENTINEL-a71d do the agent thing';
const JUDGE_SENTINEL = 'SENTINEL-j44e judge the thing';

function orderShapeDef(): WorkflowDef {
  return def(
    'ordershape',
    [input('proposal')],
    [
      // plain agent step
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'], body: AGENT_SENTINEL }),
      // command worker step
      step({
        name: 'runner',
        consumes: ['plan'],
        produces: ['result'],
        executor: 'command',
        command: RUNNER_SENTINEL,
        spec: { timeout: 300 },
        body: 'unused body for command step',
      }),
      // map producer + per-element consumer
      step({ name: 'gather', consumes: ['result'], produces: ['gather.src[]'] }),
      step({
        name: 'check',
        consumes: ['gather.src[$i]'],
        produces: ['gather.src[$i].checked'],
        body: 'check ${KEY} at ${INDEX}',
      }),
    ],
  );
}

/** Judge def built through buildDef so synthesizeJudgeSteps produces the real
 *  synthesized judge step (correct name + `submitted`-trigger eligibility). */
function judgeShapeDef(): WorkflowDef {
  return buildDef({
    name: 'judgeshape',
    inputs: [{ name: 'proposal', seedOwed: true }],
    steps: [
      {
        name: 'researcher',
        consumes: ['proposal'],
        produces: [{ name: 'report', judges: [{ name: 'completeness', body: JUDGE_SENTINEL }] }],
        body: 'produce the report',
      },
    ],
  });
}

test('WP-B1: plain, map, judge, and command-worker orders are reference packets — no prompt/command/owes[].acceptance anywhere', () => {
  const { engine } = makeEngine([orderShapeDef(), judgeShapeDef()]);

  // plain agent order: worker absent when the step declares no executor
  const wf1 = engine.createInstance('ordershape', { provide: { proposal: { text: 'x' } } });
  const planner = fire(engine, wf1, 'planner', 1000);
  assertReferenceContract(planner);
  assert.equal(planner.worker, undefined);
  complete(engine, wf1, planner, { plan: 'v1' });

  // command-worker order: authored executor maps to worker; command text
  // is available ONLY through resolution, never on the order
  const runner = fire(engine, wf1, 'runner', 2000);
  assertReferenceContract(runner);
  assert.equal(runner.worker, 'command');
  assert.deepEqual(runner.spec, { timeout: 300 });
  const runnerResolved = engine.resolveOrder(runner);
  assert.equal(runnerResolved.command, RUNNER_SENTINEL);
  complete(engine, wf1, runner, { result: 'ok' });

  // map element order: the element key rides unchanged to the resolver, and
  // INDEX/KEY materialize at resolution time, not emission time
  const gather = fire(engine, wf1, 'gather', 3000);
  assertReferenceContract(gather);
  const emitted = engine.emit(wf1, gather.run, [{ value: { n: 1 } }, { value: { n: 2 } }]);
  assert.equal(emitted.outcome, 'emitted');
  engine.close(wf1, gather.run);
  const checks = engine.tick(wf1, { now: 4000 }).orders.filter((o) => o.step === 'check');
  assert.equal(checks.length, 2, 'one order per map element');
  for (const check of checks) {
    assertReferenceContract(check);
    assert.ok(check.key.length > 0, 'map order carries its element key');
    const resolved = engine.resolveOrder(check);
    assert.equal(resolved.prompt, `check ${check.key} at ${check.index ?? ''}`);
    engine.close(wf1, check.run, 'no_work');
  }

  // judge order: a synthesized step name resolves through the same boundary
  const wf2 = engine.createInstance('judgeshape', { provide: { proposal: { text: 'y' } } });
  const researcher = fire(engine, wf2, 'researcher', 5000);
  assertReferenceContract(researcher);
  engine.green(wf2, researcher.run, 'report', { v: 1 });
  engine.close(wf2, researcher.run);
  const judge = fire(engine, wf2, 'researcher.report.judges.completeness', 6000);
  assertReferenceContract(judge);
  assert.equal(judge.judge, 'report');
  assert.equal(engine.resolveOrder(judge).prompt, JUDGE_SENTINEL);

  // serialized packets contain none of the authored sentinel bytes
  for (const o of [planner, runner, gather, ...checks, researcher, judge]) {
    const json = JSON.stringify(o);
    assert.ok(!json.includes(AGENT_SENTINEL), 'serialized order must not contain prompt bytes');
    assert.ok(!json.includes(RUNNER_SENTINEL), 'serialized order must not contain command bytes');
    assert.ok(!json.includes(JUDGE_SENTINEL), 'serialized order must not contain judge prompt bytes');
    assert.ok(!json.includes('unused body for command step'), 'command-step body must not ride the order either');
  }
});

test('WP-B1: defDigest is present and stable across repeated firings from the same pinned definition', () => {
  const { engine } = makeEngine([orderShapeDef()]);
  const wf = engine.createInstance('ordershape', { provide: { proposal: { text: 'x' } } });

  const planner1 = fire(engine, wf, 'planner', 1000);
  complete(engine, wf, planner1, { plan: 'v1' });
  complete(engine, wf, fire(engine, wf, 'runner', 2000), { result: 'ok' });

  // the downstream consumer knocks plan back; planner re-fires from the SAME
  // pinned snapshot, so the digest must not move
  engine.reject(wf, 'plan', 'runner', 'needs rework');
  const planner2 = fire(engine, wf, 'planner', 3000);
  assert.equal(planner2.defDigest, planner1.defDigest, 'same pinned def → identical digest');
  assertReferenceContract(planner2);
  // and the knocked-back order still carries the dynamic feedback
  assert.ok(planner2.owes.find((w) => w.path === 'plan')!.reasons.some((r) => r.text === 'needs rework'));
});

// ---- knock-back cycle (judgment reject) -------------------------------------

test('knock-back: a judgment reject re-arms the producer and carries feedback', () => {
  const { engine, store } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery');

  complete(engine, wf, fire(engine, wf, 'planner', 1000), { plan: 'v1' });
  complete(engine, wf, fire(engine, wf, 'builder', 2000), { pr: 'v1' });

  // reviewer rejects the pr instead of greening a verdict
  const reviewer = fire(engine, wf, 'reviewer', 3000);
  engine.reject(wf, 'pr', 'reviewer', 'tests fail on CI');
  engine.close(wf, reviewer.run, 'no_work');

  let s = engine.status(wf);
  const pr = s.debts.find((d) => d.path === 'pr');
  assert.equal(pr?.acceptance, 'rejected');
  assert.equal(pr?.kind, 'judgment');
  // reviewer is no longer eligible (its input is non-green), builder is re-armed
  assert.deepEqual(s.eligible.map((e) => e.step), ['builder']);

  // the re-fired builder sees the reviewer's feedback on the owed pr
  const builder2 = fire(engine, wf, 'builder', 4000);
  assert.deepEqual(builder2.outputs, ['pr']);
  assert.ok(builder2.owes[0]!.reasons.some((r) => r.text.includes('tests fail on CI')));
  // the judgment reject bumped the §6 stall counter
  assert.equal(store.getArtifact(wf, 'pr')?.judgmentRejects, 1);
  complete(engine, wf, builder2, { pr: 'v2' });

  // now the review passes and we finish
  complete(engine, wf, fire(engine, wf, 'reviewer', 5000), { ok: true });
  complete(engine, wf, fire(engine, wf, 'merger', 6000), { merged: true }, { terminal: true });
  assert.equal(engine.status(wf).done, true);
});

// ---- §6 liveness: stall at the cap, cleared by retry ------------------------

test('§6 stall: a judgment-rejected output stops re-arming at the cap, until retry', () => {
  const { engine } = makeEngine([delivery]); // builder maxAttempts defaults to 3
  const wf = engine.createInstance('delivery');
  complete(engine, wf, fire(engine, wf, 'planner', 1000), { plan: 'v1' });

  // three build→reject cycles drive pr's judgment-reject count to the cap
  let now = 2000;
  for (let i = 1; i <= 3; i++) {
    const builder = fire(engine, wf, 'builder', now++);
    // the owed pr carries its running judgment count for wiring-level escalation
    assert.equal(builder.owes.find((w) => w.path === 'pr')!.judgmentRejects, i - 1);
    engine.green(wf, builder.run, 'pr', { pr: i });
    engine.close(wf, builder.run);

    const reviewer = fire(engine, wf, 'reviewer', now++);
    engine.reject(wf, 'pr', 'reviewer', `attempt ${i} unfit`);
    engine.close(wf, reviewer.run, 'no_work');
  }

  // pr now has 3 judgment rejects == cap → stalled: the engine will NOT re-fire it
  assert.deepEqual(engine.tick(wf, { now: 9000 }).orders, [], 'a stalled output must not re-fire');
  let s = engine.status(wf);
  const stalled = s.debts.find((d) => d.path === 'pr');
  assert.equal(stalled?.stalled, true);
  assert.equal(stalled?.kind, 'judgment');
  assert.equal(s.done, false);
  // a stalled step is stuck, not "blocked on inputs" (its inputs are green)
  assert.equal(s.blocked.find((b) => b.step === 'builder'), undefined);

  // the human clears the stall with a line of guidance
  engine.retry(wf, 'pr', 'human', 'switch to the new fixture');
  const recovered = fire(engine, wf, 'builder', 10000);
  const prOwe = recovered.owes.find((w) => w.path === 'pr')!;
  assert.equal(prOwe.judgmentRejects, 0, 'retry resets the stall count');
  assert.ok(prOwe.reasons.at(-1)!.text.includes('switch to the new fixture'));

  // and the pipeline runs to completion
  engine.green(wf, recovered.run, 'pr', { pr: 'final' });
  engine.close(wf, recovered.run);
  complete(engine, wf, fire(engine, wf, 'reviewer', 11000), { ok: true });
  complete(engine, wf, fire(engine, wf, 'merger', 12000), { merged: true }, { terminal: true });
  assert.equal(engine.status(wf).done, true);
});

// ---- commit-side verb guards (audit F3/F5/F7) -------------------------------

test('reject: refuses a never-built owed artifact — no judgmentRejects bump, producer still offered', () => {
  const { engine, store } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery');
  complete(engine, wf, fire(engine, wf, 'planner', 1000), { plan: 'v1' });
  // builder has not fired yet — pr is still owed (never built).
  assert.equal(store.getArtifact(wf, 'pr')?.acceptance, 'owed');

  assert.throws(
    () => engine.reject(wf, 'pr', 'reviewer', 'premature verdict'),
    /cannot reject 'pr' in state 'owed': a verdict requires a built version/,
  );

  const pr = store.getArtifact(wf, 'pr');
  assert.equal(pr?.acceptance, 'owed', 'artifact untouched');
  assert.equal(pr?.judgmentRejects, 0, 'no stall-counter bump from a refused reject');
  assert.deepEqual(engine.status(wf).eligible.map((e) => e.step), ['builder'], 'producer still offered');
});

test('reject: refuses a retracted collection member — stays retracted, not resurrected to a live debt', () => {
  const { engine, store } = makeEngine([research]);
  const wf = engine.createInstance('research', { provide: { question: { q: 'why' } } });

  const gather = fire(engine, wf, 'gather', 1000);
  engine.emit(wf, gather.run, [{ value: { s: 'a' } }, { value: { s: 'b' } }]);
  engine.seal(wf, gather.run, {});
  engine.close(wf, gather.run);

  engine.retract(wf, 'gather.source[1]', 'human', 'duplicate');
  assert.equal(store.getArtifact(wf, 'gather.source[1]')?.acceptance, 'retracted');

  assert.throws(
    () => engine.reject(wf, 'gather.source[1]', 'human', 'change of mind'),
    /cannot reject 'gather\.source\[1\]' in state 'retracted': a verdict requires a built version/,
  );
  assert.equal(store.getArtifact(wf, 'gather.source[1]')?.acceptance, 'retracted', 'stays retracted, not resurrected');
});

test('reject: unaffected on a built green or submitted artifact (existing behavior)', () => {
  const { engine, store } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery');
  complete(engine, wf, fire(engine, wf, 'planner', 1000), { plan: 'v1' });
  complete(engine, wf, fire(engine, wf, 'builder', 2000), { pr: 'v1' });

  // reviewer rejects the built (green) pr — still legal.
  const reviewer = fire(engine, wf, 'reviewer', 3000);
  const r = engine.reject(wf, 'pr', 'reviewer', 'tests fail on CI');
  engine.close(wf, reviewer.run, 'no_work');
  assert.equal(r.outcome, 'rejected');
  assert.equal(store.getArtifact(wf, 'pr')?.acceptance, 'rejected');
  assert.equal(store.getArtifact(wf, 'pr')?.judgmentRejects, 1);
});

test('retract: refuses an actor who does not consume the member (no authority)', () => {
  const { engine, store } = makeEngine([research]);
  const wf = engine.createInstance('research', { provide: { question: { q: 'why' } } });

  const gather = fire(engine, wf, 'gather', 1000);
  engine.emit(wf, gather.run, [{ value: { s: 'a' } }, { value: { s: 'b' } }]);
  engine.seal(wf, gather.run, {});
  engine.close(wf, gather.run);

  // 'gather' produces the member but does not consume it, and 'synthesize'
  // consumes gather.source[*] (the reduce), not gather.source[$i] — neither
  // is a legitimate authority; an unknown actor name must also be refused.
  assert.throws(() => engine.retract(wf, 'gather.source[1]', 'gather', 'nope'), /has no authority/);
  assert.throws(() => engine.retract(wf, 'gather.source[1]', 'no-such-step', 'nope'), /unknown actor/);
  assert.equal(store.getArtifact(wf, 'gather.source[1]')?.acceptance, 'green', 'untouched by the refused retracts');

  // a consuming step (formatcheck, via gather.source[$i]) and human both have authority.
  engine.retract(wf, 'gather.source[1]', 'formatcheck', 'bad element');
  assert.equal(store.getArtifact(wf, 'gather.source[1]')?.acceptance, 'retracted');
});

test('retry: refuses an actor with no authority, and refuses a retracted artifact', () => {
  const { engine, store } = makeEngine([delivery]); // builder maxAttempts defaults to 3
  const wf = engine.createInstance('delivery');
  complete(engine, wf, fire(engine, wf, 'planner', 1000), { plan: 'v1' });

  let now = 2000;
  for (let i = 1; i <= 3; i++) {
    const builder = fire(engine, wf, 'builder', now++);
    engine.green(wf, builder.run, 'pr', { pr: i });
    engine.close(wf, builder.run);
    const reviewer = fire(engine, wf, 'reviewer', now++);
    engine.reject(wf, 'pr', 'reviewer', `attempt ${i} unfit`);
    engine.close(wf, reviewer.run, 'no_work');
  }
  assert.equal(engine.status(wf).debts.find((d) => d.path === 'pr')?.stalled, true);

  // an actor with no consume edge over 'pr' has no authority to retry it.
  assert.throws(() => engine.retry(wf, 'pr', 'merger', 'let me try'), /has no authority/);
  assert.throws(() => engine.retry(wf, 'pr', 'no-such-step', 'let me try'), /unknown actor/);
  assert.equal(store.getArtifact(wf, 'pr')?.judgmentRejects, 3, 'refused retries leave the stall untouched');

  // by human on a stalled artifact still works (counter reset preserved).
  engine.retry(wf, 'pr', 'human', 'switch to the new fixture');
  assert.equal(store.getArtifact(wf, 'pr')?.judgmentRejects, 0);

  // a retracted collection member cannot be resurrected via retry — retract is final.
  const { engine: e2, store: s2 } = makeEngine([research]);
  const wf2 = e2.createInstance('research', { provide: { question: { q: 'why' } } });
  const gather = fire(e2, wf2, 'gather', 1000);
  e2.emit(wf2, gather.run, [{ value: { s: 'a' } }]);
  e2.seal(wf2, gather.run, {});
  e2.close(wf2, gather.run);
  e2.retract(wf2, 'gather.source[0]', 'human', 'duplicate');
  assert.throws(
    () => e2.retry(wf2, 'gather.source[0]', 'human'),
    /retracted, which is terminal/,
  );
  assert.equal(s2.getArtifact(wf2, 'gather.source[0]')?.acceptance, 'retracted');
});

test('human green: enforces the declared output schema — a schema-invalid value is refused, artifact unchanged', () => {
  const planner = step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] });
  planner.produces[0]!.schema = {
    type: 'object',
    required: ['plan'],
    properties: { plan: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  };
  const withSchema = def('schemedelivery', [input('proposal')], [planner]);
  const { engine, store } = makeEngine([withSchema]);
  const wf = engine.createInstance('schemedelivery');

  assert.throws(
    () => engine.green(wf, 'human', 'plan', { wrong: 1 }),
    /human green for 'plan' failed schema/,
  );
  const plan = store.getArtifact(wf, 'plan');
  assert.equal(plan?.acceptance, 'owed', 'artifact untouched on a refused human green');
  assert.equal(plan?.version, 0, 'no version bump on a refused human green');

  // a schema-valid value still greens (existing behavior).
  const r = engine.green(wf, 'human', 'plan', { plan: 'v1' });
  assert.equal(r.outcome, 'green');
  assert.equal(store.getArtifact(wf, 'plan')?.acceptance, 'green');
});

// ---- crash-step: consecutive failed-run counter -----------------------------

test('crash-step: status surfaces a producer that keeps closing failed without greening', () => {
  const { engine, store } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery');

  // planner crashes three times: claim a run, close it `failed`, never green.
  // The plan stays `owed`, so it never bumps judgmentRejects → §6 never stalls
  // it. The only signal is the failed-run streak.
  let now = 1000;
  for (let i = 1; i <= 3; i++) {
    const planner = fire(engine, wf, 'planner', now++);
    engine.close(wf, planner.run, 'failed');
    assert.equal(store.recentFailedRuns(wf, 'planner'), i);
  }

  const s = engine.status(wf);
  const plan = s.debts.find((d) => d.path === 'plan');
  assert.equal(plan?.failedRuns, 3, 'the owed plan carries its producer crash streak');
  assert.equal(plan?.stalled, false, 'a crash-step is not a §6 judgment stall');
  assert.equal(s.done, false);

  // a clean close breaks the streak and the pipeline proceeds
  complete(engine, wf, fire(engine, wf, 'planner', now++), { plan: 'v1' });
  assert.equal(store.recentFailedRuns(wf, 'planner'), 0, 'an ok close resets the streak');
  // plan is green now — no longer a debt, so it carries no failedRuns
  assert.equal(engine.status(wf).debts.find((d) => d.path === 'plan'), undefined);
});

test('recentFailedRuns: only the consecutive trailing failures count', () => {
  const { engine, store } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery');

  // ok, then two failures: the ok is older, so the trailing streak is 2
  complete(engine, wf, fire(engine, wf, 'planner', 1000), { plan: 'v1' });
  assert.equal(store.recentFailedRuns(wf, 'planner'), 0);

  // re-arm the plan so the planner fires again, then crash twice
  engine.reject(wf, 'plan', 'human', 'redo');
  for (let i = 1; i <= 2; i++) {
    const planner = fire(engine, wf, 'planner', 1000 + i);
    engine.close(wf, planner.run, 'failed');
  }
  assert.equal(store.recentFailedRuns(wf, 'planner'), 2, 'older ok does not extend the streak');

  // a fresh ok close zeroes it again
  complete(engine, wf, fire(engine, wf, 'planner', 2000), { plan: 'v2' });
  assert.equal(store.recentFailedRuns(wf, 'planner'), 0);
});

test('crash-step on a map element: failedRuns is keyed by the element path, not ""', () => {
  // A map producer fires once per element, its run keyed by the consumed
  // element path (model.ts: `key: m.path`). status() must recover that firing
  // key from the debt path — otherwise it queries the run log with key "" and
  // reports failedRuns=0 for every map element. (B1 regression guard.)
  const { engine, store } = makeEngine([research]);
  const wf = engine.createInstance('research', { provide: { question: { q: 'why' } } });

  // gather emits two sources then seals → the formatcheck map has one firing per
  // element, each keyed by its element path.
  const gather = fire(engine, wf, 'gather', 1000);
  engine.emit(wf, gather.run, [{ value: { s: 'a' } }, { value: { s: 'b' } }]);
  engine.seal(wf, gather.run, { count: 2 });
  engine.close(wf, gather.run);

  // Crash the source[0] firing twice. Each crash leaves its formatcheck owed, so
  // the next tick re-fires it; close every *other* order ok so only source[0]
  // keeps a trailing-failed streak in the run log.
  let now = 2000;
  for (let i = 1; i <= 2; i++) {
    const t = engine.tick(wf, { now: now++ });
    const fc0 = t.orders.find((o) => o.step === 'formatcheck' && o.key === 'gather.source[0]');
    assert.ok(fc0, `formatcheck[0] order on crash ${i}`);
    for (const o of t.orders) if (o.run !== fc0.run) complete(engine, wf, o, { ok: true });
    engine.close(wf, fc0.run, 'failed');
    // the run log keys this streak under the element path, never ""
    assert.equal(store.recentFailedRuns(wf, 'formatcheck', 'gather.source[0]'), i);
    assert.equal(store.recentFailedRuns(wf, 'formatcheck', ''), 0);
  }

  const s = engine.status(wf);
  const d0 = s.debts.find((d) => d.path === 'gather.source[0].formatcheck');
  assert.ok(d0, 'the owed source[0].formatcheck is a debt');
  assert.equal(d0.failedRuns, 2, 'failedRuns counted per element via the recovered firing key');
  assert.equal(d0.stalled, false, 'a crash step is not a §6 judgment stall');
  // a sibling element that never crashed carries no streak
  const d1 = s.debts.find((d) => d.path === 'gather.source[1].formatcheck');
  assert.equal(d1, undefined, 'source[1] greened — not a debt, no failedRuns');
});

// ---- forward cascade through the engine -------------------------------------

test('forward cascade: re-deciding plan structurally re-rejects the green pr', () => {
  const { engine, store } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery');

  complete(engine, wf, fire(engine, wf, 'planner', 1000), { plan: 'v1' });
  complete(engine, wf, fire(engine, wf, 'builder', 2000), { pr: 'v1' });

  // a human re-opens the plan; the forward cascade must invalidate the pr built on it
  engine.reject(wf, 'plan', 'human', 'scope changed');

  const s = engine.status(wf);
  const plan = s.debts.find((d) => d.path === 'plan');
  const pr = s.debts.find((d) => d.path === 'pr');
  assert.equal(plan?.kind, 'judgment'); // the human's reject
  assert.equal(pr?.kind, 'structural'); // the engine's cascade
  // structural rejects do NOT count toward the §6 stall cap
  assert.equal(store.getArtifact(wf, 'pr')?.judgmentRejects, 0);
  const prHistory = store.getArtifactHistory(wf, 'pr');
  assert.ok(prHistory?.versions[0]?.events.some((event) =>
    event.action === 'reject' && event.actor === 'engine' && event.kind === 'structural'),
  'the downstream invalidation is retained as an engine-authored structural cascade event');
  // only planner is eligible now (builder's input went non-green)
  assert.deepEqual(s.eligible.map((e) => e.step), ['planner']);

  engine.retry(wf, 'pr', 'human', 'rebuild after cascade');
  assert.ok(store.getArtifactHistory(wf, 'pr')?.versions[0]?.events.some((event) =>
    event.action === 'retry' && event.actor === 'human'),
  'an explicit re-arm is retained with its human actor on the affected version');

  // re-green the plan; builder re-arms and we can proceed
  complete(engine, wf, fire(engine, wf, 'planner', 3000), { plan: 'v2' });
  const builder2 = fire(engine, wf, 'builder', 4000);
  // consumes maps each input path to its full value object
  assert.deepEqual(builder2.consumes, { plan: { plan: 'v2' } });
});

// ---- M2B: deepEqual must be order-insensitive on object keys ----------------

// Minimal calls: fixture (mirrors test/calls.test.ts's childDef/parentDef/deliverStep
// pattern) — deepEqual only guards the M2B-REPROVIDE / MACHINE-GREEN calls: cascade,
// so exercising it requires a calls: step.
const deepEqualChildDef: WorkflowDef = {
  ...def(
    'deepEqualChildDef',
    [input('data', { seedOwed: true })],
    [step({ name: 'worker', consumes: ['data'], produces: ['result'] })],
  ),
  outputs: ['result'],
};

const deepEqualDeliverStep: StepDef = {
  ...step({ name: 'deliver', produces: ['delivered'] }),
  calls: 'deepEqualChildDef',
  callsInputs: { data: 'sandbox' },
  consumes: [],
};

const deepEqualParentDef: WorkflowDef = def(
  'deepEqualParentDef',
  [input('proposal', { seedOwed: true })],
  [
    step({ name: 'provision', consumes: ['proposal'], produces: ['sandbox'] }),
    deepEqualDeliverStep,
  ],
);

test('deepEqual on calls: gate input is order-insensitive: key reorder alone must not re-provide', () => {
  const { engine, store } = makeEngine([deepEqualChildDef, deepEqualParentDef]);
  const parentWf = engine.createInstance('deepEqualParentDef', { provide: { proposal: { text: 'hello' } } });

  // Green sandbox with keys in one order, tick → child spawned with that value.
  const provOrder = fire(engine, parentWf, 'provision', 1000);
  complete(engine, parentWf, provOrder, { a: 1, b: 2 });
  engine.tick(parentWf, { now: 1000 });

  const childRow = store.findChildByParent(parentWf, 'delivered');
  assert.ok(childRow !== undefined, 'child should be spawned after sandbox is green');
  const before = store.getArtifact(childRow!.id, 'data');
  assert.deepEqual(before?.value, { a: 1, b: 2 });

  // Re-provide the parent's proposal input, driving a new sandbox value with the SAME
  // keys/values but in a different insertion order — semantically identical.
  const sandboxArt = store.getArtifact(parentWf, 'sandbox');
  assert.ok(sandboxArt !== undefined);
  store.putArtifact({
    ...sandboxArt!,
    version: sandboxArt!.version + 1,
    value: { b: 2, a: 1 },
  });

  // Tick parent → maintainCalls runs again; deepEqual must treat {a:1,b:2} and {b:2,a:1}
  // as equal, so no re-provide (version must not bump).
  engine.tick(parentWf, { now: 2000 });
  const after = store.getArtifact(childRow!.id, 'data');
  assert.equal(after?.version, before?.version, 'key-order-only change must not trigger re-provide');
});

// ---- collections: emit / seal / map / reduce --------------------------------

test('collection: gather emits a set, formatcheck maps it, synthesize reduces it', () => {
  const { engine } = makeEngine([research]);
  const wf = engine.createInstance('research', { provide: { question: { q: 'why' } } });

  // gather emits three sources then seals
  const gather = fire(engine, wf, 'gather', 1000);
  const { created } = engine.emit(wf, gather.run, [
    { value: { s: 'a' } },
    { value: { s: 'b' } },
    { value: { s: 'c' } },
  ]);
  assert.deepEqual(created, ['gather.source[0]', 'gather.source[1]', 'gather.source[2]']);
  engine.seal(wf, gather.run, { count: 3 });
  engine.close(wf, gather.run);

  // the map now has one firing per element; the reduce is also unblocked (it
  // consumes the bare members + seal, which are all green)
  const t = engine.tick(wf, { now: 2000 });
  const fcs = t.orders.filter((o) => o.step === 'formatcheck');
  const syn = t.orders.filter((o) => o.step === 'synthesize');
  assert.deepEqual(
    fcs.map((o) => o.key).sort(),
    ['gather.source[0]', 'gather.source[1]', 'gather.source[2]'],
  );
  assert.equal(syn.length, 1);
  assert.deepEqual(
    syn[0]!.inputs.sort(),
    ['gather.source.sealed', 'gather.source[0]', 'gather.source[1]', 'gather.source[2]'],
  );

  for (const o of t.orders) complete(engine, wf, o, { ok: true });
  assert.equal(engine.status(wf).done, true);
});

test('collection: a retracted member drops out of the reduce', () => {
  const { engine } = makeEngine([research]);
  const wf = engine.createInstance('research');

  const gather = fire(engine, wf, 'gather', 1000);
  engine.emit(wf, gather.run, [{ value: { s: 'a' } }, { value: { s: 'b' } }]);
  engine.seal(wf, gather.run, {});
  engine.close(wf, gather.run);

  // a human retracts source[1]; it must not block the reduce, and its formatcheck
  // child must be tombstoned by the cascade
  engine.retract(wf, 'gather.source[1]', 'human', 'duplicate');

  // process whatever's eligible — the surviving formatcheck and the reduce
  const t = engine.tick(wf, { now: 2000 });
  const fcKeys = t.orders.filter((o) => o.step === 'formatcheck').map((o) => o.key);
  assert.deepEqual(fcKeys, ['gather.source[0]']); // only the live member maps
  const syn = t.orders.find((o) => o.step === 'synthesize');
  assert.deepEqual(syn?.inputs.sort(), ['gather.source.sealed', 'gather.source[0]']);

  for (const o of t.orders) complete(engine, wf, o, { ok: true });
  assert.equal(engine.status(wf).done, true);
});

// ---- routing: skip cascade + revival ----------------------------------------

const routed = def(
  'routed',
  [input('ticket')],
  [
    step({ name: 'triage', consumes: ['ticket'], produces: ['route'] }),
    step({ name: 'escalate', consumes: ['route'], produces: ['escalation'] }),
    step({ name: 'notify', consumes: ['escalation'], produces: ['notice'] }),
  ],
);

test('routing: a producer-skipped branch settles, cascades skip, and re-arms on revival', () => {
  const { engine } = makeEngine([routed]);
  const wf = engine.createInstance('routed');

  complete(engine, wf, fire(engine, wf, 'triage', 1000), { route: 'simple' });

  // escalate decides this ticket is not worth escalating → skips its own output
  const escalate = fire(engine, wf, 'escalate', 2000);
  engine.skip(wf, 'escalation', 'escalate', 'route=simple, no escalation needed');
  engine.close(wf, escalate.run, 'skipped');

  // the skip cascades to notify; the workflow is "done" (no debts remain)
  let s = engine.status(wf);
  assert.equal(s.done, true);
  assert.equal(s.debts.length, 0);
  // nothing is eligible — the dead branch is settled, not stuck
  assert.equal(engine.tick(wf, { now: 2500 }).orders.length, 0);

  // the ticket is re-triaged and the route flips → the skipped branch revives
  engine.reject(wf, 'route', 'human', 're-triage: now urgent');
  complete(engine, wf, fire(engine, wf, 'triage', 3000), { route: 'urgent' });

  // escalate is re-armed (its skip was fingerprinted at the old route version)
  s = engine.status(wf);
  assert.deepEqual(s.eligible.map((e) => e.step), ['escalate']);
  const escalation = engine.store.getArtifact(wf, 'escalation');
  assert.equal(escalation?.acceptance, 'owed');

  // this time it really escalates, and the cascade revives notify too
  complete(engine, wf, fire(engine, wf, 'escalate', 4000), { level: 2 });
  complete(engine, wf, fire(engine, wf, 'notify', 5000), { sent: true });
  assert.equal(engine.status(wf).done, true);
});

// ---- concurrency: commit-fingerprint CAS ------------------------------------

test('concurrency: a stale commit is born-rejected when its input moved mid-run', () => {
  const { engine } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery');

  complete(engine, wf, fire(engine, wf, 'planner', 1000), { plan: 'v1' });

  // builder claims its work against plan v1
  const builder = fire(engine, wf, 'builder', 2000);
  assert.deepEqual(builder.consumes, { plan: { plan: 'v1' } });

  // meanwhile the plan is re-decided and re-greened to v2
  engine.reject(wf, 'plan', 'human', 'pivot');
  complete(engine, wf, fire(engine, wf, 'planner', 2500), { plan: 'v2' });

  // builder finally commits its (stale) pr → born-rejected, not green
  const res = engine.green(wf, builder.run, 'pr', { built: 'on v1' });
  assert.equal(res.outcome, 'born-rejected');
  engine.close(wf, builder.run, 'failed');

  // pr is still a debt; the re-fired builder now builds on v2 and greens cleanly
  const builder2 = fire(engine, wf, 'builder', 3000);
  assert.deepEqual(builder2.consumes, { plan: { plan: 'v2' } });
  assert.equal(engine.green(wf, builder2.run, 'pr', { built: 'on v2' }).outcome, 'green');
});

test('concurrency: a born-rejected (CAS-stale) run auto-releases its lease — next tick mints a fresh run with the current input version', () => {
  const { engine, store } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery');
  complete(engine, wf, fire(engine, wf, 'planner', 1000), { plan: 'v1' });
  const builder = fire(engine, wf, 'builder', 2000);
  assert.deepEqual(builder.consumes, { plan: { plan: 'v1' } });
  engine.reject(wf, 'plan', 'human', 'pivot');
  complete(engine, wf, fire(engine, wf, 'planner', 2500), { plan: 'v2' });
  const res = engine.green(wf, builder.run, 'pr', { built: 'on v1' });
  assert.equal(res.outcome, 'born-rejected');
  assert.equal(store.getRun(builder.run)?.outcome, 'no_work', 'born-reject auto-closes the run');
  assert.equal(store.getTask(wf, 'builder', '')?.status, 'idle', 'born-reject re-arms the task');
  const builder2 = fire(engine, wf, 'builder', 3000);          // NO manual close()
  assert.notEqual(builder2.run, builder.run, 'fresh run id on next tick');
  assert.deepEqual(builder2.consumes, { plan: { plan: 'v2' } });
  assert.equal(engine.green(wf, builder2.run, 'pr', { built: 'on v2' }).outcome, 'green');
});

test('concurrency: born-reject reasons distinguish absent-from-fingerprint vs moved-version', () => {
  // ABSENT arm — mirror the real allGreen-with-consumes trap: an allGreen firing
  // carries an empty claim fingerprint, but the step still declares consumes:,
  // so requiredInputs demands a path that was never fingerprinted.
  const trapped = def('trapped', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'evaluator', consumes: ['plan'], produces: ['outcome'], on: ['allGreen'] }),
  ]);
  const { engine: engine1, store: store1 } = makeEngine([trapped]);
  const wf1 = engine1.createInstance('trapped');

  complete(engine1, wf1, fire(engine1, wf1, 'planner', 1000), { plan: 'v1' });
  const ev = fire(engine1, wf1, 'evaluator', 2000);
  assert.deepEqual(ev.consumes, {}, 'allGreen firing carries no consumed input handles');

  const res1 = engine1.green(wf1, ev.run, 'outcome', { done: true });
  assert.equal(res1.outcome, 'born-rejected');
  assert.match(res1.reason ?? '', /was not in the claim fingerprint/);
  assert.doesNotMatch(res1.reason ?? '', /moved version/);

  const stored1 = store1.getArtifact(wf1, 'outcome')?.reasons.at(-1);
  assert.match(stored1?.text ?? '', /^born-rejected: plan was not in the claim fingerprint/);
  assert.equal(stored1?.action, 'born-rejected');
  assert.equal(stored1?.kind, 'structural');

  // CHANGED arm — same shape as the stale-commit test above: the path WAS
  // fingerprinted at claim time, but a concurrent commit moved it since.
  const { engine: engine2, store: store2 } = makeEngine([delivery]);
  const wf2 = engine2.createInstance('delivery');

  complete(engine2, wf2, fire(engine2, wf2, 'planner', 1000), { plan: 'v1' });
  const builder = fire(engine2, wf2, 'builder', 2000);
  engine2.reject(wf2, 'plan', 'human', 'pivot');
  complete(engine2, wf2, fire(engine2, wf2, 'planner', 2500), { plan: 'v2' });

  const res2 = engine2.green(wf2, builder.run, 'pr', { built: 'on v1' });
  assert.equal(res2.outcome, 'born-rejected');
  assert.match(res2.reason ?? '', /moved version during this run/);
  assert.match(res2.reason ?? '', /claimed v1, now v2/);
  assert.doesNotMatch(res2.reason ?? '', /not in the claim fingerprint/);

  const stored2 = store2.getArtifact(wf2, 'pr')?.reasons.at(-1);
  assert.match(stored2?.text ?? '', /^born-rejected: plan moved version during this run/);
});

test('a reaped run cannot commit (lease check)', () => {
  const { engine } = makeEngine([delivery], { reapTtlMs: 100 });
  const wf = engine.createInstance('delivery');

  const planner = fire(engine, wf, 'planner', 1000);
  // never closed; a later tick past the TTL reaps the lease and re-claims it
  const t = engine.tick(wf, { now: 1000 + 200 });
  assert.equal(t.reaped, 1);
  assert.deepEqual(t.orders.map((o) => o.step), ['planner']);
  assert.notEqual(t.orders[0]!.run, planner.run); // a fresh lease

  // the stranded original run may no longer green anything
  assert.throws(
    () => engine.green(wf, planner.run, 'plan', { plan: 'zombie' }),
    /no longer holds its lease/,
  );
  // the fresh lease commits normally
  assert.equal(engine.green(wf, t.orders[0]!.run, 'plan', { plan: 'live' }).outcome, 'green');
});

test('reap bumps the attempts counter', () => {
  const { engine, store } = makeEngine([delivery], { reapTtlMs: 100 });
  const wf = engine.createInstance('delivery');
  fire(engine, wf, 'planner', 1000);
  engine.tick(wf, { now: 1300 });
  assert.equal(store.getTask(wf, 'planner', '')?.attempts, 1);
});

// ---- cadence + daily budget --------------------------------------------------

test('cadence gates re-runs and the daily budget caps them', () => {
  const poll = def(
    'poll',
    [input('seed')],
    [step({ name: 'watch', consumes: ['seed'], produces: ['report'], cadenceSecs: 60, maxRunsPerDay: 2 })],
  );
  const { engine } = makeEngine([poll]);
  const wf = engine.createInstance('poll');

  // first run fires immediately; we close it as no_work so `report` stays owed
  const first = fire(engine, wf, 'watch', 10_000);
  engine.close(wf, first.run, 'no_work');

  // 30s later: still owed, but the cadence (60s) gate blocks a re-claim
  assert.equal(engine.tick(wf, { now: 40_000 }).orders.length, 0);

  // 60s later: cadence satisfied → a second run (this exhausts the daily budget)
  const second = fire(engine, wf, 'watch', 70_000);
  engine.close(wf, second.run, 'no_work');

  // cadence is satisfied again, but the budget of 2/day is spent → no run
  assert.equal(engine.tick(wf, { now: 140_000 }).orders.length, 0);
});

test('parallel cap limits concurrent claims of a fanned-out map', () => {
  const fan = def(
    'fan',
    [input('q')],
    [
      step({ name: 'gather', consumes: ['q'], produces: ['gather.item[]'] }),
      step({
        name: 'work',
        consumes: ['gather.item[$i]'],
        produces: ['gather.item[$i].done'],
        parallel: 2,
      }),
    ],
  );
  const { engine } = makeEngine([fan]);
  const wf = engine.createInstance('fan');

  const g = fire(engine, wf, 'gather', 1000);
  engine.emit(wf, g.run, [{ value: {} }, { value: {} }, { value: {} }, { value: {} }]);
  engine.seal(wf, g.run, {});
  engine.close(wf, g.run);

  // four elements are eligible, but parallel:2 caps the tick to two claims
  const t = engine.tick(wf, { now: 2000 });
  assert.equal(t.orders.filter((o) => o.step === 'work').length, 2);
});

// ---- schema validation (§18) -------------------------------------------------

/** A delivery whose planner output `plan` must match a JSON Schema. */
function schemaOut(maxSchemaFailures = 3): WorkflowDef {
  const planner = step({ name: 'planner', consumes: ['proposal'], produces: ['plan'], maxSchemaFailures });
  planner.produces[0]!.schema = {
    type: 'object',
    required: ['plan'],
    properties: { plan: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  };
  return def('schemad', [input('proposal')], [
    planner,
    step({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
  ]);
}

test('schema: a conforming green is accepted', () => {
  const { engine, store } = makeEngine([schemaOut()]);
  const wf = engine.createInstance('schemad');
  const o = fire(engine, wf, 'planner', 1000);
  const res = engine.green(wf, o.run, 'plan', { plan: 'v1' });
  assert.equal(res.outcome, 'green');
  assert.equal(store.getArtifact(wf, 'plan')?.acceptance, 'green');
});

test('schema: a non-conforming green is schema-rejected, not greened', () => {
  const { engine, store } = makeEngine([schemaOut()]);
  const wf = engine.createInstance('schemad');
  const o = fire(engine, wf, 'planner', 1000);
  const res = engine.green(wf, o.run, 'plan', { wrong: 1 } as Record<string, unknown>);
  assert.equal(res.outcome, 'schema-rejected');
  assert.ok(res.issues && res.issues.length > 0, 'carries the violations');
  assert.match(res.reason ?? '', /schema validation failed/);
  const art = store.getArtifact(wf, 'plan');
  assert.equal(art?.acceptance, 'rejected');
  assert.equal(art?.version, 0, 'never greened, so version is untouched');
  assert.equal(art?.schemaRejects, 1);
  // the failure is recorded as a `validation` reject, distinct from a judgment one
  const last = art!.reasons[art!.reasons.length - 1]!;
  assert.equal(last.kind, 'validation');
  assert.equal(last.action, 'schema-reject');
  assert.equal(store.getArtifact(wf, 'plan')?.judgmentRejects, 0);
});

test('schema: the worker can correct and re-green on the same open run (inner-step retry)', () => {
  const { engine, store } = makeEngine([schemaOut()]);
  const wf = engine.createInstance('schemad');
  const o = fire(engine, wf, 'planner', 1000);
  assert.equal(engine.green(wf, o.run, 'plan', { wrong: 1 } as Record<string, unknown>).outcome, 'schema-rejected');
  // same run is still open and holds its lease — a corrected value greens
  assert.equal(engine.green(wf, o.run, 'plan', { plan: 'fixed' }).outcome, 'green');
  assert.equal(store.getArtifact(wf, 'plan')?.acceptance, 'green');
  engine.close(wf, o.run);
  assert.deepEqual(engine.tick(wf, { now: 2000 }).orders.map((x) => x.step), ['builder']);
});

test('schema: repeated failures stall the producer after maxSchemaFailures', () => {
  const { engine, store } = makeEngine([schemaOut(3)]);
  const wf = engine.createInstance('schemad');
  const o = fire(engine, wf, 'planner', 1000);
  for (let i = 0; i < 3; i++) {
    assert.equal(engine.green(wf, o.run, 'plan', { bad: i } as Record<string, unknown>).outcome, 'schema-rejected');
  }
  assert.equal(store.getArtifact(wf, 'plan')?.schemaRejects, 3);
  engine.close(wf, o.run, 'no_work');

  // stalled: the engine will not re-arm the producer
  assert.equal(engine.tick(wf, { now: 2000 }).orders.filter((x) => x.step === 'planner').length, 0);
  const plan = engine.status(wf).debts.find((d) => d.path === 'plan');
  assert.equal(plan?.stalled, true);
  assert.equal(plan?.kind, 'validation');
});

test('schema: a retry clears the schema stall and re-arms the producer', () => {
  const { engine, store } = makeEngine([schemaOut(2)]);
  const wf = engine.createInstance('schemad');
  const o = fire(engine, wf, 'planner', 1000);
  for (let i = 0; i < 2; i++) engine.green(wf, o.run, 'plan', { bad: i } as Record<string, unknown>);
  engine.close(wf, o.run, 'no_work');
  assert.equal(engine.tick(wf, { now: 2000 }).orders.filter((x) => x.step === 'planner').length, 0);

  engine.retry(wf, 'plan', 'human', 'schema fixed upstream');
  assert.equal(store.getArtifact(wf, 'plan')?.schemaRejects, 0);
  const o2 = fire(engine, wf, 'planner', 3000);
  assert.equal(engine.green(wf, o2.run, 'plan', { plan: 'good' }).outcome, 'green');
});

test('schema: emit refuses a non-conforming element atomically and bumps the seal', () => {
  const gather = step({ name: 'gather', consumes: ['question'], produces: ['gather.source[]'] });
  gather.produces[0]!.schema = { type: 'object', required: ['url'], properties: { url: { type: 'string' } } };
  const d = def('research', [input('question')], [
    gather,
    step({ name: 'synthesize', consumes: ['gather.source[*]'], produces: ['draft'] }),
  ]);
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('research');
  const g = fire(engine, wf, 'gather', 1000);

  // one good + one bad: the whole emit is refused (atomic), nothing accretes
  const bad = engine.emit(wf, g.run, [{ value: { url: 'ok' } }, { value: { nope: 1 } }]);
  assert.equal(bad.outcome, 'schema-rejected');
  assert.deepEqual(bad.created, []);
  assert.ok(!store.getArtifact(wf, 'gather.source[0]'), 'no member written');
  const seal = store.getArtifact(wf, 'gather.source.sealed');
  assert.equal(seal?.acceptance, 'rejected');
  assert.equal(seal?.schemaRejects, 1);

  // a fully-conforming emit on the same open run succeeds and accretes from 0
  const ok = engine.emit(wf, g.run, [{ value: { url: 'a' } }, { value: { url: 'b' } }]);
  assert.equal(ok.outcome, 'emitted');
  assert.deepEqual(ok.created, ['gather.source[0]', 'gather.source[1]']);
});

test('§11.1: emit after the seal greens is refused (sealed-rejected), lease stays open, run still closes', () => {
  const gather = step({ name: 'gather', consumes: ['question'], produces: ['gather.source[]'] });
  const d = def('research', [input('question')], [
    gather,
    step({ name: 'synthesize', consumes: ['gather.source[*]'], produces: ['draft'] }),
  ]);
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('research');
  const g = fire(engine, wf, 'gather', 1000);

  engine.emit(wf, g.run, [{ value: { s: 'a' } }, { value: { s: 'b' } }]);
  engine.seal(wf, g.run, { count: 2 });
  const sealBefore = store.getArtifact(wf, 'gather.source.sealed');
  assert.equal(sealBefore?.acceptance, 'green');

  // same open lease, late emit after the seal is already green
  const late = engine.emit(wf, g.run, [{ value: { s: 'c' } }]);
  assert.equal(late.outcome, 'sealed-rejected');
  assert.deepEqual(late.created, []);
  assert.ok(late.reason?.includes('gather.source'));

  // no new member, no counter changes, seal still green
  assert.ok(!store.getArtifact(wf, 'gather.source[2]'), 'no new member written');
  const sealAfter = store.getArtifact(wf, 'gather.source.sealed');
  assert.equal(sealAfter?.acceptance, 'green');
  assert.equal(sealAfter?.version, sealBefore?.version, 'seal untouched by the refused emit');
  assert.equal(sealAfter?.schemaRejects, sealBefore?.schemaRejects, 'no counters bumped');

  // the lease stays open — the run can still close cleanly
  assert.doesNotThrow(() => engine.close(wf, g.run));
});

test('schema: createInstance rejects a provided input that violates its schema', () => {
  const proposalIn = { ...input('proposal'), schema: { type: 'object', required: ['goal'] } };
  const d = def('d', [proposalIn], [step({ name: 'a', consumes: ['proposal'], produces: ['plan'] })]);
  const { engine } = makeEngine([d]);
  assert.throws(() => engine.createInstance('d', { provide: { proposal: { nope: 1 } } }), /failed schema/);
  const wf = engine.createInstance('d', { provide: { proposal: { goal: 'ship' } } });
  assert.ok(engine.status(wf).eligible.some((f) => f.step === 'a'));
});

test('schema: provideInput rejects a value that violates the input schema', () => {
  const proposalIn = { ...input('proposal', { seedOwed: true }), schema: { type: 'object', required: ['goal'] } };
  const d = def('d', [proposalIn], [step({ name: 'a', consumes: ['proposal'], produces: ['plan'] })]);
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('d');
  assert.throws(() => engine.provideInput(wf, 'proposal', { nope: 1 }), /failed schema/);
  assert.equal(store.getArtifact(wf, 'proposal')?.acceptance, 'owed', 'rejected provide leaves it owed');
  engine.provideInput(wf, 'proposal', { goal: 'ship' });
  assert.equal(store.getArtifact(wf, 'proposal')?.acceptance, 'green');
});

// ---- deferred channel (tick observability) -----------------------------------

test('deferred: always present — empty on a normal order-emitting tick and on an idle tick', () => {
  const { engine } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery');

  // normal tick: one planner order, deferred is empty
  const t1 = engine.tick(wf, { now: 1000 });
  assert.equal(t1.orders.length, 1);
  assert.deepEqual(t1.deferred, []);

  // drive all the way to done
  complete(engine, wf, t1.orders[0]!, { plan: 'v1' });
  complete(engine, wf, fire(engine, wf, 'builder', 2000), { pr: 1 });
  complete(engine, wf, fire(engine, wf, 'reviewer', 3000), { ok: true });
  complete(engine, wf, fire(engine, wf, 'merger', 4000), { merged: true }, { terminal: true });

  // idle tick: nothing to do
  const t2 = engine.tick(wf, { now: 5000 });
  assert.deepEqual(t2.orders, []);
  assert.deepEqual(t2.deferred, []);
});

test('deferred: in-flight — a second tick while a run is open produces a deferred in-flight entry', () => {
  const { engine } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery');

  // tick once to open a planner run — do NOT close it
  const t1 = engine.tick(wf, { now: 1000 });
  assert.equal(t1.orders.length, 1);
  assert.equal(t1.orders[0]!.step, 'planner');

  // tick again — the run is still open, so planner should be deferred in-flight
  const t2 = engine.tick(wf, { now: 2000 });
  assert.deepEqual(t2.orders, []);
  assert.equal(t2.deferred.length, 1);
  assert.deepEqual(t2.deferred[0], {
    step: 'planner',
    key: '',
    inputs: ['proposal'],
    outputs: ['plan'],
    reason: 'in-flight',
  });
  assert.equal(t2.deferred[0]!.index, undefined);
});

test('deferred: cadence — a tick before the cadence interval elapses defers with reason cadence', () => {
  const cadenced = def(
    'cadenced',
    [input('seed')],
    [step({ name: 'watch', consumes: ['seed'], produces: ['report'], cadenceSecs: 60 })],
  );
  const { engine } = makeEngine([cadenced]);
  const wf = engine.createInstance('cadenced');

  // fire and close one run at t=10000
  const first = fire(engine, wf, 'watch', 10_000);
  engine.close(wf, first.run, 'no_work');

  // tick at t=40000 — only 30s have elapsed, cadence is 60s
  const t = engine.tick(wf, { now: 40_000 });
  assert.deepEqual(t.orders, []);
  assert.equal(t.deferred.length, 1);
  assert.equal(t.deferred[0]!.reason, 'cadence');
  assert.equal(t.deferred[0]!.step, 'watch');
});

test('deferred: daily-budget — once the budget is spent, subsequent ticks defer with reason daily-budget', () => {
  const budgeted = def(
    'budgeted',
    [input('seed')],
    [step({ name: 'watch', consumes: ['seed'], produces: ['report'], cadenceSecs: 0, maxRunsPerDay: 1 })],
  );
  const { engine } = makeEngine([budgeted]);
  const wf = engine.createInstance('budgeted');

  // use the one allowed run
  const first = fire(engine, wf, 'watch', 10_000);
  engine.close(wf, first.run, 'no_work');

  // next tick — budget exhausted for the day
  const t = engine.tick(wf, { now: 20_000 });
  assert.deepEqual(t.orders, []);
  assert.equal(t.deferred.length, 1);
  assert.equal(t.deferred[0]!.reason, 'daily-budget');
  assert.equal(t.deferred[0]!.step, 'watch');
});

test('deferred: parallel-cap — a map step with parallel:2 and 4 elements defers 2 with reason parallel-cap', () => {
  const fan = def(
    'fan2',
    [input('q')],
    [
      step({ name: 'gather', consumes: ['q'], produces: ['gather.item[]'] }),
      step({
        name: 'work',
        consumes: ['gather.item[$i]'],
        produces: ['gather.item[$i].done'],
        parallel: 2,
      }),
    ],
  );
  const { engine } = makeEngine([fan]);
  const wf = engine.createInstance('fan2');

  const g = fire(engine, wf, 'gather', 1000);
  engine.emit(wf, g.run, [{ value: {} }, { value: {} }, { value: {} }, { value: {} }]);
  engine.seal(wf, g.run, {});
  engine.close(wf, g.run);

  // 4 eligible elements, parallel cap is 2 → 2 orders, 2 deferred
  const t = engine.tick(wf, { now: 2000 });
  const workOrders = t.orders.filter((o) => o.step === 'work');
  const workDeferred = t.deferred.filter((d) => d.step === 'work');
  assert.equal(workOrders.length, 2);
  assert.equal(workDeferred.length, 2);
  assert.ok(workDeferred.every((d) => d.reason === 'parallel-cap'));
});

// ---- idle trigger + nextAlarm + setAlarm/clearAlarm integration (PR3b) -------

test('(i) nextAlarm: dueAt computed from lastProgressMs + idleAfterMs when no alarm_at set', () => {
  const IDLE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
  const idleDef = def('idle', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'completion', produces: ['outcome'], on: ['idle'], idleAfterMs: IDLE_AFTER_MS }),
  ]);
  const { engine } = makeEngine([idleDef]);
  const wf = engine.createInstance('idle');

  // Tick at T=1000 to settle the workflow (creates artifacts with updated_at ≈ 1000ms real)
  engine.tick(wf, { now: 1000 });

  // nextAlarm: dueAt = lastProgressMs + idleAfterMs
  const result = engine.nextAlarm(wf, { now: 1000 });
  assert.ok(result.dueAt !== null, 'dueAt must be set for a workflow with idle steps');
  assert.ok(result.dueAt! > 0, 'dueAt must be positive');

  // isDue at now=dueAt
  const result2 = engine.nextAlarm(wf, { now: result.dueAt! });
  assert.equal(result2.isDue, true, 'isDue must be true when now >= dueAt');

  // isDue before dueAt
  const result3 = engine.nextAlarm(wf, { now: result.dueAt! - 1 });
  assert.equal(result3.isDue, false, 'isDue must be false when now < dueAt');
});

test('(i) setAlarm / clearAlarm on engine; nextAlarm reflects alarm_at override', () => {
  const IDLE_AFTER_MS = 30 * 60 * 1000;
  const idleDef = def('idle2', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'completion', produces: ['outcome'], on: ['idle'], idleAfterMs: IDLE_AFTER_MS }),
  ]);
  const { engine } = makeEngine([idleDef]);
  const wf = engine.createInstance('idle2');

  const customAlarm = 9999;
  engine.setAlarm(wf, 'completion', customAlarm);

  const r1 = engine.nextAlarm(wf, { now: customAlarm - 1 });
  assert.equal(r1.dueAt, customAlarm, 'dueAt should equal the set alarm');
  assert.equal(r1.isDue, false, 'isDue=false before alarm');

  const r2 = engine.nextAlarm(wf, { now: customAlarm });
  assert.equal(r2.isDue, true, 'isDue=true at alarm time');

  engine.clearAlarm(wf, 'completion');
  // After clear, dueAt falls back to lastProgressMs + idleAfterMs
  const r3 = engine.nextAlarm(wf, { now: customAlarm });
  // r3.dueAt is now lastProgressMs + IDLE_AFTER_MS, which is >= customAlarm
  // (we just know it changed — it's no longer customAlarm)
  assert.notEqual(r3.dueAt, customAlarm, 'dueAt should no longer be customAlarm after clearAlarm');
});

test('idle trigger fires the evaluator step when alarm is set and threshold is reached', () => {
  // Use setAlarm to bypass the lastProgressMs-based threshold, since lastProgressMs
  // uses the real clock (putArtifact stamps updated_at with nowMs()) and tests use
  // explicit now. The absolute alarm_at override is the reliable path for integration tests.
  const IDLE_AFTER_MS = 30 * 60 * 1000;
  const idleDef = def('idle3', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'completion', produces: ['outcome'], on: ['idle'], idleAfterMs: IDLE_AFTER_MS }),
  ]);
  const { engine } = makeEngine([idleDef]);
  const wf = engine.createInstance('idle3');

  // Tick at T=1000: planner fires (inputsGreen)
  const t1 = engine.tick(wf, { now: 1000 });
  assert.ok(t1.orders.some((o) => o.step === 'planner'), 'planner order expected on first tick');

  // Close the planner run so no task is in-flight
  const plannerRun = t1.orders.find((o) => o.step === 'planner')!.run;
  engine.close(wf, plannerRun, 'no_work');

  // Set an explicit alarm at T=5000 so we control the threshold
  const alarmAt = 5000;
  engine.setAlarm(wf, 'completion', alarmAt);

  // Tick BEFORE alarm: completion must NOT fire
  const tBefore = engine.tick(wf, { now: alarmAt - 1 });
  const completionBefore = tBefore.orders.filter((o) => o.step === 'completion');
  assert.equal(completionBefore.length, 0, 'completion must NOT fire before alarm threshold');

  // Close any new planner run so no task is in-flight for the next tick
  for (const o of tBefore.orders.filter((o) => o.step === 'planner')) {
    engine.close(wf, o.run, 'no_work');
  }

  // Tick AT alarm: completion MUST fire (alarm_at threshold reached, workflow has debts)
  const tAt = engine.tick(wf, { now: alarmAt });
  const completionAt = tAt.orders.filter((o) => o.step === 'completion');
  assert.equal(completionAt.length, 1, 'completion MUST fire when alarm threshold is reached');
  assert.equal(completionAt[0]!.cause, 'idle', 'order must carry cause=idle');

  // TickResult.dueAt must be a number (idle step exists)
  assert.ok(tAt.dueAt !== undefined, 'dueAt field must be present when idle steps exist');
  assert.equal(typeof tAt.dueAt, 'number', 'dueAt must be a number');
});

// ---- Alarm survives close/reap; claim clears it ----

test('alarm set before close is preserved; reap also preserves alarm; claim clears it', () => {
  const idleDef = def('alarm-survive', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'completion', produces: ['outcome'], on: ['idle'], idleAfterMs: 9_999_999 }),
  ]);
  const { engine, store } = makeEngine([idleDef], { reapTtlMs: 500 });
  const wf = engine.createInstance('alarm-survive');
  const ALARM = 99_999;

  // Part A: alarm survives a normal close
  const runId1 = 'run_close_test';
  store.insertRun(runId1, { workflow: wf, step: 'completion', key: '' }, 0);
  store.putTask({ workflow: wf, step: 'completion', key: '', status: 'claimed',
    run: runId1, claimedAt: 1000, attempts: 0, alarmAt: ALARM });
  engine.close(wf, runId1, 'ok');
  assert.equal(store.getAlarm(wf, 'completion'), ALARM, 'close() must not clear a freshly-set alarm');

  // Part B: alarm survives reap
  // (reapTtlMs=500; claimedAt=0; now=1000 => 1000-0=1000 > 500 => stale)
  const runId2 = 'run_reap_test';
  store.insertRun(runId2, { workflow: wf, step: 'completion', key: '' }, 0);
  store.putTask({ workflow: wf, step: 'completion', key: '', status: 'claimed',
    run: runId2, claimedAt: 0, attempts: 1, alarmAt: ALARM });
  engine.reap(wf, 1000);
  assert.equal(store.getAlarm(wf, 'completion'), ALARM, 'reap() must not clear a set alarm');

  // Part C: claim-time consume still works
  engine.setAlarm(wf, 'completion', 1); // past => immediately due
  const t = engine.tick(wf, { now: 2 });
  const completionOrder = t.orders.find((o) => o.step === 'completion');
  assert.ok(completionOrder, 'completion must fire when idle alarm is due');
  assert.equal(store.getAlarm(wf, 'completion'), undefined,
    'claim() must clear alarm_at at claim time');
});

// ---- Lease ownership at commit (openRun guard) ----

test('openRun: a reaped or superseded run cannot commit', () => {
  const { engine } = makeEngine([delivery], { reapTtlMs: 0 });
  const wf = engine.createInstance('delivery');

  // Claim planner as R1 at T=1000
  const t1 = engine.tick(wf, { now: 1000 });
  const r1 = t1.orders.find((o) => o.step === 'planner');
  assert.ok(r1, 'planner must fire on first tick');

  // Reap at T=1001 (1001-1000=1 > ttl=0 => stale)
  engine.reap(wf, 1001);

  // Sub-case A: green on reaped run must throw
  assert.throws(
    () => engine.green(wf, r1.run, 'plan', { v: 1 }),
    /no longer holds its lease|reaped or superseded/,
    'green on a reaped run must throw'
  );

  // Sub-case B: R2 re-claims; R1 green must still throw
  const t2 = engine.tick(wf, { now: 2000 });
  const r2 = t2.orders.find((o) => o.step === 'planner');
  assert.ok(r2, 'planner must re-fire after reap');
  assert.notEqual(r2.run, r1.run, 'R2 must be a distinct run id');
  assert.throws(
    () => engine.green(wf, r1.run, 'plan', { v: 1 }),
    /no longer holds its lease|reaped or superseded/,
    'green on superseded run must throw even after re-claim'
  );
});

// ---- M2-CREATE: createInstance with producedBy persists parent coordinates ----

test('createInstance with producedBy persists parent coordinates and is readable', () => {
  const store = openStore(':memory:');
  const engine = new Engine(store, (name) => {
    if (name === 'delivery') return delivery;
    throw new Error(`unknown def: ${name}`);
  });

  const parentWf = 'wf_parent_test';
  const parentPath = 'deliver';

  const childId = engine.createInstance('delivery', {
    producedBy: { parentWf, parentPath },
  });

  // Verify via getWorkflow
  const row = store.getWorkflow(childId);
  assert.ok(row !== undefined, 'child workflow row must exist');
  assert.deepEqual(
    row.producedBy,
    { parentWf, parentPath },
    'producedBy must round-trip through insertWorkflow',
  );

  // Verify via findChildByParent
  const found = store.findChildByParent(parentWf, parentPath);
  assert.ok(found !== undefined, 'findChildByParent must return the child');
  assert.equal(found.id, childId, 'findChildByParent must return the correct child');
  assert.deepEqual(found.producedBy, { parentWf, parentPath });

  store.close();
});

// ---- §28: instance-to-definition pinning ------------------------------------

/** Like makeEngine, but the resolver map is mutable so a test can swap what a
 *  def NAME resolves to after an instance has already been created — the
 *  scenario this feature exists to guard against. */
function makeMutableEngine(initial: WorkflowDef[]): {
  engine: Engine;
  store: Store;
  setDef: (d: WorkflowDef) => void;
  removeDef: (name: string) => void;
} {
  const store = openStore(':memory:');
  const byName = new Map(initial.map((d) => [d.name, d]));
  const engine = new Engine(store, (name) => {
    const d = byName.get(name);
    if (!d) throw new Error(`no def: ${name}`);
    return d;
  }, { instructionSource: createDefInstructionSource(initial) });
  return {
    engine,
    store,
    setDef: (d) => byName.set(d.name, d),
    removeDef: (name) => byName.delete(name),
  };
}

test('§28: createInstance stamps a defSnapshot/defHash matching the def used', () => {
  const { engine, store } = makeMutableEngine([delivery]);
  const wf = engine.createInstance('delivery');
  const row = store.getWorkflow(wf);
  assert.ok(row !== undefined);
  assert.deepEqual(row.defSnapshot, delivery);
  assert.equal(row.defHash, hashDef(delivery));
});

test('§28: the def snapshot pins modifiers: and escalation: across a republish', () => {
  // The routing vocabulary is part of the pinned shape, not a live lookup. A
  // republish that widens the modifier set or retargets an escalation must not
  // reach an instance already created against the old def — otherwise a run
  // in flight could start escalating to a modifier its own capabilities were
  // never composed against.
  const original = def(
    'graded',
    [input('proposal')],
    [
      step({
        name: 'builder',
        consumes: ['proposal'],
        produces: ['pr'],
        capabilities: ['build'],
        escalation: { after: 2, modifier: 'deep' },
      }),
    ],
    ['express', 'deep'],
  );
  const { engine, store, setDef } = makeMutableEngine([original]);
  const wf = engine.createInstance('graded');

  const republished = def(
    'graded',
    [input('proposal')],
    [
      step({
        name: 'builder',
        consumes: ['proposal'],
        produces: ['pr'],
        capabilities: ['build'],
        escalation: { after: 1, modifier: 'exhaustive' },
      }),
    ],
    ['express', 'deep', 'exhaustive'],
  );
  setDef(republished);

  const pinned = store.getWorkflow(wf)?.defSnapshot;
  assert.ok(pinned !== undefined, 'instance carries a pin');
  assert.deepEqual(pinned.modifiers, ['express', 'deep'], 'pinned modifier set is the original one');
  assert.deepEqual(
    pinned.steps[0]!.escalation,
    { after: 2, modifier: 'deep' },
    'pinned escalation rule is the original one',
  );
  assert.notEqual(hashDef(original), hashDef(republished), 'hashDef distinguishes the two vocabularies');

  // adopt() is the explicit opt-in that moves the instance onto the new shape.
  engine.adopt(wf);
  const adopted = store.getWorkflow(wf)?.defSnapshot;
  assert.deepEqual(adopted!.modifiers, ['express', 'deep', 'exhaustive']);
  assert.deepEqual(adopted!.steps[0]!.escalation, { after: 1, modifier: 'exhaustive' });
});

// ---- createInstance modifier: validated against the pin, stored on the row ---

function gradedDef(modifiers?: string[]): WorkflowDef {
  return def(
    'graded',
    [input('proposal')],
    [step({ name: 'builder', consumes: ['proposal'], produces: ['pr'], capabilities: ['build'] })],
    modifiers,
  );
}

test('createInstance stores a declared modifier on the run record', () => {
  const { engine, store } = makeEngine([gradedDef(['express', 'deep'])]);
  const wf = engine.createInstance('graded', { modifier: 'deep' });
  assert.equal(store.getWorkflow(wf)?.modifier, 'deep');
});

test('createInstance without a modifier leaves the run record unmodified', () => {
  const { engine, store } = makeEngine([gradedDef(['express', 'deep'])]);
  const wf = engine.createInstance('graded');
  assert.equal(store.getWorkflow(wf)?.modifier, undefined);
});

test('createInstance refuses a modifier the def does not declare', () => {
  const { engine } = makeEngine([gradedDef(['express', 'deep'])]);
  assert.throws(
    () => engine.createInstance('graded', { modifier: 'exhaustive' }),
    (e: unknown) =>
      e instanceof ModifierRefusalError &&
      e.defName === 'graded' &&
      e.modifier === 'exhaustive' &&
      // The declared set travels on the error so the hub can render a usable
      // 400 instead of "invalid modifier".
      JSON.stringify(e.declared) === JSON.stringify(['express', 'deep']) &&
      /not declared by workflow 'graded' \(declared: express, deep\)/.test(e.message),
  );
});

test('createInstance refuses any modifier on a def that declares none', () => {
  // A distinct message: the fix is to add `modifiers:` to the def, not to pick
  // a different value from a set that does not exist.
  const { engine } = makeEngine([gradedDef()]);
  assert.throws(
    () => engine.createInstance('graded', { modifier: 'deep' }),
    (e: unknown) =>
      e instanceof ModifierRefusalError &&
      e.declared.length === 0 &&
      /declares no modifiers:, so it cannot be started with modifier 'deep'/.test(e.message),
  );
});

test('a refused modifier leaves no partial instance behind', () => {
  const { engine, store } = makeEngine([gradedDef(['express'])]);
  assert.throws(() => engine.createInstance('graded', { modifier: 'deep' }), ModifierRefusalError);
  assert.equal(store.listWorkflows().length, 0, 'the creating transaction rolled back');
});

test('createInstance validates the modifier against the snapshot it pins, not a later republish', () => {
  // The vocabulary that legitimizes a modifier and the modifier itself are
  // stamped on the same row in the same transaction. Republishing the def with
  // a narrower set afterwards cannot retroactively invalidate a live run.
  const { engine, store, setDef } = makeMutableEngine([gradedDef(['express', 'deep'])]);
  const wf = engine.createInstance('graded', { modifier: 'deep' });

  setDef(gradedDef(['express']));

  assert.equal(store.getWorkflow(wf)?.modifier, 'deep', 'the live run keeps its modifier');
  assert.deepEqual(store.getWorkflow(wf)?.defSnapshot?.modifiers, ['express', 'deep'], 'and the set that legitimized it');
  // A NEW instance resolves the republished def and is held to the narrower set.
  assert.throws(() => engine.createInstance('graded', { modifier: 'deep' }), ModifierRefusalError);
});

test('§28: defFor falls back to name-resolution for a legacy row with no snapshot', () => {
  const { engine, store } = makeMutableEngine([delivery]);
  const wf = 'wf_legacy_test';
  store.insertWorkflow(wf, { def: 'delivery' }); // simulate a pre-feature row: no snapshot
  assert.equal(store.getWorkflow(wf)?.defSnapshot, undefined, 'sanity: row really has no pin');
  // A verb that goes through defFor must resolve via resolveDef (the delivery
  // def registered under that name), not throw — even with zero artifacts
  // seeded (this row bypassed createInstance's seeding on purpose).
  const s = engine.status(wf);
  assert.deepEqual(s.debts, [], 'no artifacts were ever seeded on this bypassed row');
  assert.equal(s.defDrift, undefined, 'no pin to compare against on a legacy row');
});

test('§28: an instance stays pinned to its original def shape even after the live def changes', () => {
  const { engine, setDef } = makeMutableEngine([delivery]);
  const wf = engine.createInstance('delivery');

  // Swap the live def under the same name for a DIFFERENT shape: builder now
  // requires an extra consumed input ('extra') that the pinned instance never
  // seeded and shouldn't need.
  const changed = def(
    'delivery',
    [input('proposal'), input('extra')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({ name: 'builder', consumes: ['plan', 'extra'], produces: ['pr'] }),
      step({ name: 'reviewer', consumes: ['pr'], produces: ['verdict'] }),
      step({ name: 'merger', consumes: ['verdict'], produces: ['merge'] }),
    ],
  );
  setDef(changed);

  // Drive the pinned instance through planner -> builder exactly like the
  // original happy-path test. If the pin didn't hold, builder would now be
  // blocked waiting on the unseeded 'extra' input.
  complete(engine, wf, fire(engine, wf, 'planner', 1000), { plan: 'v1' });
  const builderOrder = fire(engine, wf, 'builder', 2000);
  assert.deepEqual(
    builderOrder.inputs.sort(),
    ['plan'],
    'pinned instance must still see builder as consuming only "plan", not "plan"+"extra"',
  );
});

test('§28: status().defDrift is false when the live def matches the pin', () => {
  const { engine } = makeMutableEngine([delivery]);
  const wf = engine.createInstance('delivery');
  assert.equal(engine.status(wf).defDrift, false);
});

test('§28: status().defDrift is true when the live def has changed since pinning', () => {
  const { engine, setDef } = makeMutableEngine([delivery]);
  const wf = engine.createInstance('delivery');

  const changed = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'], body: 'a new prompt' }),
      step({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
      step({ name: 'reviewer', consumes: ['pr'], produces: ['verdict'] }),
      step({ name: 'merger', consumes: ['verdict'], produces: ['merge'] }),
    ],
  );
  setDef(changed);

  assert.equal(engine.status(wf).defDrift, true);
});

test('§28: status() does not throw when the live def can no longer be resolved for a pinned instance', () => {
  const { engine, removeDef } = makeMutableEngine([delivery]);
  const wf = engine.createInstance('delivery');
  removeDef('delivery'); // simulate the source YAML being deleted/renamed

  const s = engine.status(wf);
  assert.equal(s.done, false, 'status must still work off the pinned snapshot');
  assert.equal(s.defDrift, undefined, "can't determine drift when the live def can't resolve at all");
});

test('§28: adopt re-pins to the current def, clears drift, and settles a newly-introduced debt', () => {
  const { engine, setDef } = makeMutableEngine([delivery]);
  const wf = engine.createInstance('delivery');

  // A concrete difference: a brand-new step producing a brand-new stem.
  // `pendingOwed`/`settle` materializes fresh STEP OUTPUTS as debts (unlike
  // workflow `inputs`, which are only ever seeded once, at createInstance
  // time) — so this is the shape of def change that actually gives adopt's
  // settle() call something new to surface.
  const changed = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
      step({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
      step({ name: 'reviewer', consumes: ['pr'], produces: ['verdict'] }),
      step({ name: 'merger', consumes: ['verdict'], produces: ['merge'] }),
      step({ name: 'notifier', consumes: ['verdict'], produces: ['notice'] }),
    ],
  );
  setDef(changed);
  assert.equal(engine.status(wf).defDrift, true);

  const res = engine.adopt(wf);
  assert.equal(res.workflow, wf);
  assert.equal(res.defHash, hashDef(changed));
  assert.equal(res.previousHash, hashDef(delivery));

  const s = engine.status(wf);
  assert.equal(s.defDrift, false, 'drift must be cleared once re-pinned to the live def');
  assert.ok(
    s.debts.some((d) => d.path === 'notice'),
    'adopt must settle() so the new def shape\'s fresh debt (notice, from the new notifier step) materializes immediately',
  );
});

test('§28: adopt on an unknown workflow id throws', () => {
  const { engine } = makeMutableEngine([delivery]);
  assert.throws(() => engine.adopt('wf_does_not_exist'), /no such workflow instance/);
});

test('WP-B1: an emitted digest keeps the original prompt and command after the source definition mutates', () => {
  const mutable = def(
    'mutable-instructions',
    [input('proposal', { seedOwed: true })],
    [
      step({
        name: 'runner',
        consumes: ['proposal'],
        produces: ['result'],
        executor: 'command',
        body: 'original prompt',
        command: 'original command',
      }),
    ],
  );
  const { engine } = makeEngine([mutable]);
  const wf = engine.createInstance('mutable-instructions', { provide: { proposal: { text: 'x' } } });
  const order = fire(engine, wf, 'runner', 1000);
  assert.equal(engine.resolveOrder(order).prompt, 'original prompt');
  assert.equal(engine.resolveOrder(order).command, 'original command');

  mutable.steps[0]!.body = 'mutated prompt';
  mutable.steps[0]!.command = 'mutated command';

  assert.equal(engine.resolveOrder(order).prompt, 'original prompt');
  assert.equal(engine.resolveOrder(order).command, 'original command');
});

test('WP-B1 pin/adopt: a pinned instance keeps the OLD digest + OLD prompt bytes after the source changes; adopt flips both to the NEW ones', () => {
  const { engine, setDef } = makeMutableEngine([delivery]);
  const wf = engine.createInstance('delivery', { provide: { proposal: { text: 'x' } } });

  const planner1 = fire(engine, wf, 'planner', 1000);
  const oldDigest = planner1.defDigest;
  assert.equal(engine.resolveOrder(planner1).prompt, 'run planner', 'sanity: default helper body');

  // Swap the live def under the same name — new body bytes, new digest.
  const changed = def(
    'delivery',
    [input('proposal')],
    [
      step({ name: 'planner', consumes: ['proposal'], produces: ['plan'], body: 'a new prompt' }),
      step({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
      step({ name: 'reviewer', consumes: ['pr'], produces: ['verdict'] }),
      step({ name: 'merger', consumes: ['verdict'], produces: ['merge'] }),
    ],
  );
  setDef(changed);

  // The pinned instance's NEXT order: original digest, original bytes — even
  // though the live map no longer holds them under the name.
  complete(engine, wf, planner1, { plan: 'v1' });
  engine.reject(wf, 'plan', 'builder', 'rework');
  const planner2 = fire(engine, wf, 'planner', 2000);
  assert.equal(planner2.defDigest, oldDigest, 'pinned order keeps the original digest');
  assert.equal(engine.resolveOrder(planner2).prompt, 'run planner', 'pinned order resolves the original prompt bytes');
  assert.notEqual(engine.resolver.resolve({ defDigest: oldDigest, step: 'planner', key: '' }).prompt, 'a new prompt');

  // Adopt: the next order carries the NEW digest and resolves the NEW bytes.
  engine.close(wf, planner2.run, 'no_work');
  engine.adopt(wf);
  const planner3 = fire(engine, wf, 'planner', 3000);
  assert.notEqual(planner3.defDigest, oldDigest, 'adopted order carries the new digest');
  assert.equal(engine.resolveOrder(planner3).prompt, 'a new prompt', 'adopted order resolves the new prompt bytes');
});

test('§28: adopt throws when the live def no longer resolves at all (unlike status, which tolerates it)', () => {
  const { engine, removeDef } = makeMutableEngine([delivery]);
  const wf = engine.createInstance('delivery');
  removeDef('delivery');
  assert.throws(() => engine.adopt(wf), /no def: delivery/);
});
