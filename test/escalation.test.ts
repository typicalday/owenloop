/**
 * §7 — the engine-applied escalation transition.
 *
 * A step may author `escalation: { after: N, modifier: M }`. Once the artifact
 * it owes has taken N judgment rejections, the engine offers that step composed
 * with M instead of the run's own modifier, marks the order `escalated`, and
 * writes ONE history record for the episode. A human `retry` zeroes the reject
 * counter, which ends the episode and returns the next offer to the run's
 * modifier.
 *
 * Nothing about the transition is stored as engine state: it is recomputed from
 * the artifact counters on every offer (`routingFor`). These tests pin the
 * consequences of that choice — no half-applied promotion, no duplicate record,
 * and a reversal that needs no undo path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { ArtifactEvent, WorkflowDef } from '../src/types.ts';
import { def, input, step } from './helpers.ts';

function makeEngine(defs: WorkflowDef[]): { engine: Engine; store: Store } {
  const store = openStore(':memory:');
  const byName = new Map(defs.map((d) => [d.name, d]));
  const engine = new Engine(store, (name) => {
    const d = byName.get(name);
    if (!d) throw new Error(`no def: ${name}`);
    return d;
  });
  return { engine, store };
}

/**
 * One builder step owing `pr`, escalating to `deep` after 2 judgment rejections.
 *
 * `maxAttempts: 5` against `after: 2` is the window install validation (R2)
 * guarantees: rejections 2, 3 and 4 run escalated, and the artifact freezes at
 * 5. Without that gap the escalated attempt would never run.
 */
function escalatingDef(opts: { escalate?: boolean } = {}): WorkflowDef {
  const escalate = opts.escalate ?? true;
  return def(
    'graded',
    [input('proposal')],
    [
      step({
        name: 'builder',
        consumes: ['proposal'],
        produces: ['pr'],
        capabilities: ['build'],
        maxAttempts: 5,
        ...(escalate ? { escalation: { after: 2, modifier: 'deep' } } : {}),
      }),
    ],
    ['express', 'deep'],
  );
}

/** Seed the instance's input so the builder is eligible. */
function seed(engine: Engine, wf: string): void {
  engine.provideInput(wf, 'proposal', { text: 'ship it' });
}

/**
 * Claim the builder, land a version, and have a human judgment-reject it —
 * one full rejection cycle. Returns the order that was claimed, so a caller can
 * assert on the routing THAT attempt was offered under.
 */
function rejectOnce(engine: Engine, wf: string, now: number): ReturnType<Engine['tick']>['orders'][number] {
  const order = engine.tick(wf, { now }).orders.find((o) => o.step === 'builder');
  assert.ok(order, `builder must be offered at now=${now}`);
  engine.green(wf, order.run, 'pr', { url: `https://example.test/${now}` });
  engine.close(wf, order.run);
  engine.reject(wf, 'pr', 'human', 'not good enough');
  return order;
}

/** The escalation records on `pr`, in write order. */
function escalations(store: Store, wf: string): ArtifactEvent[] {
  return (store.getArtifactHistory(wf, 'pr')?.events ?? []).filter((e) => e.action === 'escalated');
}

// ---- the transition itself ---------------------------------------------------

test('escalation: the re-offer carries the target modifier and is marked escalated', () => {
  const { engine } = makeEngine([escalatingDef()]);
  const wf = engine.createInstance('graded', { modifier: 'express' });
  seed(engine, wf);

  const first = rejectOnce(engine, wf, 0);
  assert.deepEqual(first.capabilities, ['build:express'], 'attempt 1 runs at the run\'s own grade');
  assert.equal(first.escalated, undefined);

  const second = rejectOnce(engine, wf, 1);
  assert.deepEqual(second.capabilities, ['build:express'], 'one rejection is below the threshold');
  assert.equal(second.escalated, undefined);

  // Two rejections banked — the third offer is the escalated one.
  const third = engine.tick(wf, { now: 2 }).orders[0]!;
  assert.deepEqual(third.capabilities, ['build:deep']);
  assert.equal(third.modifier, 'deep');
  assert.equal(third.escalated, true);
});

test('escalation: the run\'s own modifier is never rewritten', () => {
  // The promotion is step-scoped and per-offer. What the caller asked for — and
  // is billed for — stays exactly as `start_run` recorded it.
  const { engine, store } = makeEngine([escalatingDef()]);
  const wf = engine.createInstance('graded', { modifier: 'express' });
  seed(engine, wf);

  rejectOnce(engine, wf, 0);
  rejectOnce(engine, wf, 1);
  const escalated = engine.tick(wf, { now: 2 }).orders[0]!;

  assert.equal(escalated.modifier, 'deep');
  assert.equal(store.getWorkflow(wf)?.modifier, 'express', 'the run record is untouched');
});

test('escalation: a step with no escalation block keeps its compound until the stall brake', () => {
  const { engine } = makeEngine([escalatingDef({ escalate: false })]);
  const wf = engine.createInstance('graded', { modifier: 'express' });
  seed(engine, wf);

  for (let i = 0; i < 4; i++) {
    const o = rejectOnce(engine, wf, i);
    assert.deepEqual(o.capabilities, ['build:express'], `attempt ${i + 1} stays at the authored grade`);
    assert.equal(o.escalated, undefined);
  }
});

test('escalation: an unmodified run promotes from BARE capabilities', () => {
  // A def may declare modifiers and be started without one. The escalation rule
  // is authored routing, not a function of what the caller asked for, so it
  // still fires — promoting `build` to `build:deep`.
  const { engine } = makeEngine([escalatingDef()]);
  const wf = engine.createInstance('graded');
  seed(engine, wf);

  assert.deepEqual(rejectOnce(engine, wf, 0).capabilities, ['build']);
  assert.deepEqual(rejectOnce(engine, wf, 1).capabilities, ['build']);

  const escalated = engine.tick(wf, { now: 2 }).orders[0]!;
  assert.deepEqual(escalated.capabilities, ['build:deep']);
  assert.equal(escalated.modifier, 'deep');
  assert.equal(escalated.escalated, true);
});

test('escalation: a run ALREADY at the target is a no-op, not an event', () => {
  // Nothing to promote — the offer would compose identically. Marking it
  // `escalated` would tell the hub to downgrade its wait policy for no reason,
  // and a history record would claim a transition that never happened.
  const { engine, store } = makeEngine([escalatingDef()]);
  const wf = engine.createInstance('graded', { modifier: 'deep' });
  seed(engine, wf);

  rejectOnce(engine, wf, 0);
  rejectOnce(engine, wf, 1);
  const third = engine.tick(wf, { now: 2 }).orders[0]!;

  assert.deepEqual(third.capabilities, ['build:deep']);
  assert.equal(third.modifier, 'deep');
  assert.equal(third.escalated, undefined, 'no promotion happened');
  assert.equal(escalations(store, wf).length, 0);
});

// ---- the stall window --------------------------------------------------------

test('escalation: escalated attempts fire before the stall brake, then freeze at maxAttempts', () => {
  // R2 (`after < maxAttempts`) exists so this window is non-empty. With
  // after=2 / maxAttempts=5, rejections 3, 4 and 5 are produced by escalated
  // offers; the fifth freezes the artifact and the step stops being offered.
  const { engine } = makeEngine([escalatingDef()]);
  const wf = engine.createInstance('graded', { modifier: 'express' });
  seed(engine, wf);

  rejectOnce(engine, wf, 0);
  rejectOnce(engine, wf, 1);

  for (let i = 2; i < 5; i++) {
    const o = rejectOnce(engine, wf, i);
    assert.equal(o.escalated, true, `attempt ${i + 1} runs escalated`);
    assert.deepEqual(o.capabilities, ['build:deep']);
  }

  // Five judgment rejections === maxAttempts: the artifact is stalled and the
  // producer is no longer re-armed. It waits for a human.
  assert.equal(engine.tick(wf, { now: 9 }).orders.length, 0, 'stalled — no further offers');
});

// ---- once per episode --------------------------------------------------------

test('escalation: exactly ONE history record per rejection episode, however many offers', () => {
  const { engine, store } = makeEngine([escalatingDef()]);
  const wf = engine.createInstance('graded', { modifier: 'express' });
  seed(engine, wf);

  rejectOnce(engine, wf, 0);
  rejectOnce(engine, wf, 1);
  // Three separate escalated offers in the same episode.
  rejectOnce(engine, wf, 2);
  rejectOnce(engine, wf, 3);
  rejectOnce(engine, wf, 4);

  const recs = escalations(store, wf);
  assert.equal(recs.length, 1, 'the rule is recomputed per offer; the record is written once');

  const rec = recs[0]!;
  assert.equal(rec.actor, 'engine');
  assert.equal(rec.version, 0, 'anchored to the artifact, not to one produced version');
  assert.equal(rec.metadata?.step, 'builder');
  assert.equal(rec.metadata?.from, 'express');
  assert.equal(rec.metadata?.to, 'deep');
  assert.equal(rec.metadata?.after, 2);
  assert.equal(rec.metadata?.episode, 0);
  assert.equal(rec.metadata?.judgmentRejects, 2, 'the count at the crossing offer, not the latest');
});

test('escalation: an unmodified run records no `from`', () => {
  const { engine, store } = makeEngine([escalatingDef()]);
  const wf = engine.createInstance('graded');
  seed(engine, wf);

  rejectOnce(engine, wf, 0);
  rejectOnce(engine, wf, 1);
  engine.tick(wf, { now: 2 });

  const rec = escalations(store, wf)[0]!;
  assert.equal(rec.metadata?.to, 'deep');
  assert.equal('from' in (rec.metadata ?? {}), false, 'promotion was from bare capabilities');
});

// ---- retry ends the episode --------------------------------------------------

test('escalation: a human retry ends the episode and the next offer is back at the run\'s modifier', () => {
  const { engine } = makeEngine([escalatingDef()]);
  const wf = engine.createInstance('graded', { modifier: 'express' });
  seed(engine, wf);

  rejectOnce(engine, wf, 0);
  rejectOnce(engine, wf, 1);
  assert.equal(rejectOnce(engine, wf, 2).escalated, true, 'the episode reached the threshold');

  engine.retry(wf, 'pr', 'human', 'different approach, start over');

  const after = engine.tick(wf, { now: 4 }).orders[0]!;
  assert.deepEqual(after.capabilities, ['build:express'], 'retry zeroed the counter — no promotion');
  assert.equal(after.escalated, undefined);
});

test('escalation: a SECOND episode writes a second record, not a swallowed duplicate', () => {
  const { engine, store } = makeEngine([escalatingDef()]);
  const wf = engine.createInstance('graded', { modifier: 'express' });
  seed(engine, wf);

  rejectOnce(engine, wf, 0);
  rejectOnce(engine, wf, 1);
  rejectOnce(engine, wf, 2); // escalated, episode 0 recorded
  assert.equal(escalations(store, wf).length, 1);

  engine.retry(wf, 'pr', 'human', 'reset');
  rejectOnce(engine, wf, 3);
  rejectOnce(engine, wf, 4);
  const second = engine.tick(wf, { now: 5 }).orders[0]!;
  assert.equal(second.escalated, true, 'the rule fires again on fresh rejections');

  const recs = escalations(store, wf);
  assert.equal(recs.length, 2, 'a distinct episode is a distinct record');
  assert.equal(recs[0]!.metadata?.episode, 0);
  assert.equal(recs[1]!.metadata?.episode, 1);
});

// ---- the claim filter follows the escalated compound -------------------------

test('escalation: the caller capability filter is judged against the ESCALATED compound', () => {
  // The whole point of escalating is to reach a different crew. If the A2
  // filter still matched the pre-escalation compound, the exactly-bound
  // recovery crew would be deferred and the crew that already failed would keep
  // claiming.
  const { engine } = makeEngine([escalatingDef()]);
  const wf = engine.createInstance('graded', { modifier: 'express' });
  seed(engine, wf);

  const modes = { 'build:express': 'exact' as const, 'build:deep': 'exact' as const };
  const first = engine.tick(wf, { now: 0, capabilities: ['build:express'], matchModes: modes }).orders[0]!;
  engine.green(wf, first.run, 'pr', { url: 'https://example.test/1' });
  engine.close(wf, first.run);
  engine.reject(wf, 'pr', 'human', 'no');
  const second = engine.tick(wf, { now: 1, capabilities: ['build:express'], matchModes: modes }).orders[0]!;
  engine.green(wf, second.run, 'pr', { url: 'https://example.test/2' });
  engine.close(wf, second.run);
  engine.reject(wf, 'pr', 'human', 'still no');

  // The original crew is now shut out of its own step.
  const shutOut = engine.tick(wf, { now: 2, capabilities: ['build:express'], matchModes: modes });
  assert.equal(shutOut.orders.length, 0);
  assert.equal(shutOut.deferred.filter((d) => d.reason === 'capability-mismatch').length, 1);

  // The recovery crew claims it.
  const recovery = engine.tick(wf, { now: 3, capabilities: ['build:deep'], matchModes: modes });
  assert.equal(recovery.orders.length, 1);
  assert.deepEqual(recovery.orders[0]!.capabilities, ['build:deep']);
  assert.equal(recovery.orders[0]!.escalated, true);
});

// ---- retention ---------------------------------------------------------------

test('escalation: deleting the run removes the escalation history with it', () => {
  const { engine, store } = makeEngine([escalatingDef()]);
  const wf = engine.createInstance('graded', { modifier: 'express' });
  seed(engine, wf);

  rejectOnce(engine, wf, 0);
  rejectOnce(engine, wf, 1);
  engine.tick(wf, { now: 2 });
  assert.equal(escalations(store, wf).length, 1);

  store.deleteWorkflow(wf);
  assert.equal(store.getArtifactHistory(wf, 'pr'), undefined, 'history deletes with the run');
  assert.equal(store.getWorkflow(wf), undefined);
});
