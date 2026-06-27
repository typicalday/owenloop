import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import type { Order } from '../src/engine.ts';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { WorkflowDef } from '../src/types.ts';
import { def, input, step } from './helpers.ts';

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

function makeEngine(defs: WorkflowDef[], opts: { reapTtlMs?: number } = {}): {
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
    opts,
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

test('a firing carries its consumed input handles and owed reason thread', () => {
  const { engine } = makeEngine([delivery]);
  const wf = engine.createInstance('delivery', { provide: { proposal: { goal: 'ship it' } } });

  const planner = fire(engine, wf, 'planner', 1000);
  assert.deepEqual(planner.consumes, { proposal: { goal: 'ship it' } });
  assert.deepEqual(planner.outputs, ['plan']);
  assert.deepEqual(planner.owes.map((w) => w.path), ['plan']);
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
  // only planner is eligible now (builder's input went non-green)
  assert.deepEqual(s.eligible.map((e) => e.step), ['planner']);

  // re-green the plan; builder re-arms and we can proceed
  complete(engine, wf, fire(engine, wf, 'planner', 3000), { plan: 'v2' });
  const builder2 = fire(engine, wf, 'builder', 4000);
  // consumes maps each input path to its full value object
  assert.deepEqual(builder2.consumes, { plan: { plan: 'v2' } });
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
