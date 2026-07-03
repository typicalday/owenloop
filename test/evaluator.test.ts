/**
 * Tests for the allGreen firing trigger (§21): eligibility, bootstrap exclusion,
 * fall-out-of-done re-arm, no-thrash, and trigger-cause threading.
 *
 * Tests (a)-(e) from the build plan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibleFirings, maintainDecisions } from '../src/model.ts';
import type { TimeFacts } from '../src/model.ts';
import { arts, def, input, step } from './helpers.ts';

// ---- (a) back-compat: a step with no on: fires exactly as inputsGreen --------

test('(a) back-compat: no on: → fires same as inputsGreen explicit', () => {
  // Setup: proposal(green) → planner(no on:) → plan(owed)
  const d = def('bc', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
  ]);
  const state = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 0 },
  ]);

  const firings = eligibleFirings(d, state);
  assert.equal(firings.length, 1);
  assert.equal(firings[0]!.step, 'planner');
  // no cause on inputsGreen (implicit default)
  assert.equal(firings[0]!.cause, undefined);

  // Explicit on: ['inputsGreen'] should give identical result
  const dExplicit = def('bc-explicit', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'], on: ['inputsGreen'] }),
  ]);
  const firingsExplicit = eligibleFirings(dExplicit, state);
  assert.equal(firingsExplicit.length, 1);
  assert.equal(firingsExplicit[0]!.step, 'planner');
  assert.equal(firingsExplicit[0]!.cause, undefined);
});

// ---- (b) allGreen eligibility lifecycle --------------------------------------

test('(b) allGreen eligibility lifecycle', () => {
  // Three-step workflow: planner, builder, completion (on:['allGreen'])
  const d = def('lifecycle', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
    step({ name: 'completion', produces: ['outcome'], on: ['allGreen'] }),
  ]);

  // Step 1: plan owed, pr owed, outcome owed — completion NOT eligible
  const step1 = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 0 },
    { path: 'pr', producer: 'builder', acceptance: 'owed', version: 0 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);
  const f1 = eligibleFirings(d, step1);
  const completionFirings1 = f1.filter((f) => f.step === 'completion');
  assert.equal(completionFirings1.length, 0, 'completion must not be eligible when plan and pr are owed');

  // Step 2: plan green, pr owed — completion NOT eligible (builder debt remains)
  const step2 = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'pr', producer: 'builder', acceptance: 'owed', version: 0 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);
  const f2 = eligibleFirings(d, step2);
  const completionFirings2 = f2.filter((f) => f.step === 'completion');
  assert.equal(completionFirings2.length, 0, 'completion must not be eligible when pr is still owed');

  // Step 3: plan green, pr green — completion IS eligible (bootstrap exclusion: outcome excluded)
  const step3 = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);
  const f3 = eligibleFirings(d, step3);
  const completionFirings3 = f3.filter((f) => f.step === 'completion');
  assert.equal(completionFirings3.length, 1, 'completion must be eligible when all non-evaluator artifacts are green');
  assert.equal(completionFirings3[0]!.cause, 'allGreen');

  // Step 4: green outcome → the outcome artifact is now green (done)
  const step4 = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'green', version: 1 },
  ]);
  // Completion should NOT be re-eligible when outcome is already green
  const f4 = eligibleFirings(d, step4);
  const completionFirings4 = f4.filter((f) => f.step === 'completion');
  assert.equal(completionFirings4.length, 0, 'completion must not be eligible when outcome is already green');
});

// ---- (c) bootstrap exclusion -------------------------------------------------

test('(c) bootstrap exclusion: single-step evaluator workflow fires at T=0', () => {
  // Setup: single-step workflow — only the completion evaluator, no other steps.
  // The only debt is outcome itself (the evaluator's own output), which is excluded.
  const d = def('single-eval', [], [
    step({ name: 'completion', produces: ['outcome'], on: ['allGreen'] }),
  ]);
  const state = arts([
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);
  const firings = eligibleFirings(d, state);
  const completionFirings = firings.filter((f) => f.step === 'completion');
  assert.equal(
    completionFirings.length,
    1,
    'bootstrap exclusion: the evaluator must be eligible even when its own output is the only debt',
  );
  assert.equal(completionFirings[0]!.cause, 'allGreen');
});

// ---- (d) fall-out-of-done re-arm + no-thrash ---------------------------------

test('(d) fall-out-of-done re-arm + no-thrash', () => {
  const d = def('rearm', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'completion', produces: ['outcome'], on: ['allGreen'] }),
  ]);

  // State A: plan green, outcome green → done
  const stateA = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'green', version: 1 },
  ]);
  // maintainDecisions on stable done state → no rearm ops
  const opsA = maintainDecisions(d, stateA);
  const rearmOpsA = opsA.filter((op) => op.kind === 'reject' && op.path === 'outcome');
  assert.equal(rearmOpsA.length, 0, 'no re-arm op when outcome is green and workflow is all-green');

  // Introduce a debt: set plan back to owed (upstream re-arm)
  const stateFellOut = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'green', version: 1 },
  ]);

  // maintainDecisions → outcome gets a 'reject' op (re-arm)
  const opsFellOut = maintainDecisions(d, stateFellOut);
  const rearmOps = opsFellOut.filter((op) => op.kind === 'reject' && op.path === 'outcome');
  assert.equal(rearmOps.length, 1, 'outcome must be re-armed when workflow falls out of done');

  // State B after applying op: outcome is owed
  const stateB = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);

  // eligibleFirings: completion is NOT eligible yet (plan is a debt)
  const firingsB = eligibleFirings(d, stateB);
  const completionB = firingsB.filter((f) => f.step === 'completion');
  assert.equal(completionB.length, 0, 'completion must not be eligible when plan is a debt');

  // Green plan again (resolve the debt)
  const stateC = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);

  // eligibleFirings: completion IS eligible (cause='allGreen')
  const firingsC = eligibleFirings(d, stateC);
  const completionC = firingsC.filter((f) => f.step === 'completion');
  assert.equal(completionC.length, 1, 'completion must be eligible after plan greens again');
  assert.equal(completionC[0]!.cause, 'allGreen');

  // No-thrash: maintainDecisions on the stable all-green state (outcome green) → zero allGreen-rearm ops
  const stateStable = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 2 },
    { path: 'outcome', producer: 'completion', acceptance: 'green', version: 2 },
  ]);
  const opsStable = maintainDecisions(d, stateStable);
  const rearmOpsStable = opsStable.filter(
    (op) => op.kind === 'reject' && op.path === 'outcome' && op.reason.includes('allGreen-rearm'),
  );
  assert.equal(rearmOpsStable.length, 0, 'no thrash: no allGreen-rearm op when workflow is all-green and outcome is green');
});

// ---- (e) trigger-cause threading on the Firing level -------------------------

test('(e) trigger-cause is threaded onto the Firing', () => {
  const d = def('cause-check', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'completion', produces: ['outcome'], on: ['allGreen'] }),
  ]);

  // All non-evaluator artifacts green; outcome is owed
  const state = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);

  const firings = eligibleFirings(d, state);
  const completionFiring = firings.find((f) => f.step === 'completion');
  assert.ok(completionFiring, 'expected a completion firing');
  assert.equal(completionFiring!.cause, 'allGreen', 'firing must carry cause=allGreen');
  // inputs must be empty (no consumed inputs for allGreen step)
  assert.deepEqual(completionFiring!.inputs, []);
});

// ============================================================
// (b)-(i) idle trigger tests (§21.8 — PR3b)
// ============================================================

// A minimal 3-step workflow: planner → builder → completion(idle)
function makeIdleDef(idleAfterMs: number) {
  return def('idle-wf', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'builder', consumes: ['plan'], produces: ['pr'] }),
    step({ name: 'completion', produces: ['outcome'], on: ['idle'], idleAfterMs }),
  ]);
}

function makeTimeFacts(overrides: Partial<TimeFacts> = {}): TimeFacts {
  return {
    now: 0,
    lastProgressMs: 0,
    inFlight: false,
    alarms: new Map(),
    ...overrides,
  };
}

// ---- (b) idle NOT eligible before threshold, eligible at/after threshold ------

test('(b) idle NOT eligible before threshold; IS eligible at/after threshold', () => {
  const IDLE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
  const d = makeIdleDef(IDLE_AFTER_MS);

  // State: plan owed (workflow has debt), outcome owed
  const state = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 0 },
    { path: 'pr', producer: 'builder', acceptance: 'owed', version: 0 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);

  const T = 1_000_000; // arbitrary epoch base
  const lastProgressMs = T;

  // Before threshold: now = T + 5min, threshold = T + 30min
  const timeBefore = makeTimeFacts({ now: T + 5 * 60 * 1000, lastProgressMs, inFlight: false });
  const firingsBefore = eligibleFirings(d, state, timeBefore).filter((f) => f.step === 'completion');
  assert.equal(firingsBefore.length, 0, 'idle must NOT be eligible before the threshold');

  // Exactly at threshold: now = T + 30min
  const timeAt = makeTimeFacts({ now: T + IDLE_AFTER_MS, lastProgressMs, inFlight: false });
  const firingsAt = eligibleFirings(d, state, timeAt).filter((f) => f.step === 'completion');
  assert.equal(firingsAt.length, 1, 'idle IS eligible at exactly the threshold');
  assert.equal(firingsAt[0]!.cause, 'idle');
  assert.deepEqual(firingsAt[0]!.inputs, []);

  // After threshold: now = T + 60min
  const timeAfter = makeTimeFacts({ now: T + 60 * 60 * 1000, lastProgressMs, inFlight: false });
  const firingsAfter = eligibleFirings(d, state, timeAfter).filter((f) => f.step === 'completion');
  assert.equal(firingsAfter.length, 1, 'idle IS eligible after the threshold');
  assert.equal(firingsAfter[0]!.cause, 'idle');
});

// ---- (c) SLIDING window: advancing lastProgressMs pushes the threshold forward ---

test('(c) sliding window: advancing lastProgressMs resets the idle threshold', () => {
  const IDLE_AFTER_MS = 30 * 60 * 1000;
  const d = makeIdleDef(IDLE_AFTER_MS);

  const state = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 0 },
    { path: 'pr', producer: 'builder', acceptance: 'owed', version: 0 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);

  const T = 1_000_000;
  const now = T + 29 * 60 * 1000; // 29 minutes after T

  // With lastProgressMs = T (29min ago), idle is not eligible (29m < 30m)
  const time1 = makeTimeFacts({ now, lastProgressMs: T, inFlight: false });
  const f1 = eligibleFirings(d, state, time1).filter((f) => f.step === 'completion');
  assert.equal(f1.length, 0, 'idle NOT eligible when 29m since last progress (threshold is 30m)');

  // Simulate progress at T+1min (lastProgressMs advances to T+1min).
  // New threshold = T+1min + 30min = T+31min. now = T+29min < T+31min → still not eligible.
  const time2 = makeTimeFacts({ now, lastProgressMs: T + 60 * 1000, inFlight: false });
  const f2 = eligibleFirings(d, state, time2).filter((f) => f.step === 'completion');
  assert.equal(f2.length, 0, 'idle NOT eligible after sliding window advances (threshold pushed forward)');
});

// ---- (d) ABSOLUTE alarm override -------------------------------------------------

test('(d) absolute alarm_at overrides the relative lastProgress + idleAfter threshold', () => {
  const IDLE_AFTER_MS = 30 * 60 * 1000;
  const d = makeIdleDef(IDLE_AFTER_MS);

  const state = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 0 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);

  const T = 1_000_000;
  const lastProgressMs = T;
  // alarm_at set to T+5min (earlier than lastProgressMs+30min = T+30min)
  const alarmAt = T + 5 * 60 * 1000;

  // At exactly alarm_at: idle IS eligible (absolute override wins)
  const timeAtAlarm = makeTimeFacts({
    now: alarmAt,
    lastProgressMs,
    inFlight: false,
    alarms: new Map([['completion', alarmAt]]),
  });
  const firings = eligibleFirings(d, state, timeAtAlarm).filter((f) => f.step === 'completion');
  assert.equal(firings.length, 1, 'idle IS eligible when alarm_at threshold is reached');
  assert.equal(firings[0]!.cause, 'idle');

  // Before alarm_at (5 min before): NOT eligible even though lastProgress+idleAfter would be in future
  const timeBefore = makeTimeFacts({
    now: alarmAt - 1,
    lastProgressMs,
    inFlight: false,
    alarms: new Map([['completion', alarmAt]]),
  });
  const firingsBefore = eligibleFirings(d, state, timeBefore).filter((f) => f.step === 'completion');
  assert.equal(firingsBefore.length, 0, 'idle NOT eligible 1ms before alarm_at');
});

// ---- (e) IN-FLIGHT ≠ idle (R12) -----------------------------------------------

test('(e) idle is NOT eligible when any run is in-flight', () => {
  const IDLE_AFTER_MS = 30 * 60 * 1000;
  const d = makeIdleDef(IDLE_AFTER_MS);

  const state = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 0 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);

  const T = 1_000_000;
  // Well past threshold so idle would be eligible if not for inFlight
  const timeInFlight = makeTimeFacts({
    now: T + 60 * 60 * 1000,
    lastProgressMs: T,
    inFlight: true, // a run is claimed and fresh
  });
  const firings = eligibleFirings(d, state, timeInFlight).filter((f) => f.step === 'completion');
  assert.equal(firings.length, 0, 'idle must NOT be eligible when any run is in-flight');
});

// ---- (f) NOT-done gate: idle fires only when workflow has non-evaluator debts ---

test('(f) idle is NOT eligible when the workflow is all-green (allGreen owns it)', () => {
  const IDLE_AFTER_MS = 30 * 60 * 1000;
  const d = makeIdleDef(IDLE_AFTER_MS);

  // Workflow all-green (excluding evaluator's outcome): proposal green, plan green, pr green
  // outcome is owed (the evaluator's own output — excluded from all-green check)
  const state = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'green', version: 1 },
    { path: 'pr', producer: 'builder', acceptance: 'green', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);

  const T = 1_000_000;
  // Past threshold
  const time = makeTimeFacts({ now: T + 60 * 60 * 1000, lastProgressMs: T, inFlight: false });
  const firings = eligibleFirings(d, state, time);
  const idleFirings = firings.filter((f) => f.step === 'completion' && f.cause === 'idle');
  assert.equal(idleFirings.length, 0, 'idle must NOT be eligible when workflow is all-green');
});

// ---- (g) HEARTBEAT re-arm: idle re-arm when alarm elapsed and outcome is green ---

test('(g) heartbeat re-arm: maintainDecisions emits idle-rearm when alarm elapsed and outcome is green', () => {
  const IDLE_AFTER_MS = 30 * 60 * 1000;
  const d = makeIdleDef(IDLE_AFTER_MS);

  const T = 1_000_000;

  // State: outcome is green (idle fired once), plan is still owed (not done)
  const stateGreenOutcome = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 0 },
    { path: 'outcome', producer: 'completion', acceptance: 'green', version: 1 },
  ]);

  // No alarm, now < lastProgressMs + idleAfterMs → idleEligible = false → no re-arm
  const timeNoAlarm = makeTimeFacts({ now: T + 5 * 60 * 1000, lastProgressMs: T, inFlight: false });
  const opsNoAlarm = maintainDecisions(d, stateGreenOutcome, timeNoAlarm);
  const rearmOpsNoAlarm = opsNoAlarm.filter(
    (op) => op.kind === 'reject' && op.path === 'outcome' && op.reason.includes('idle-rearm'),
  );
  assert.equal(rearmOpsNoAlarm.length, 0, 'no idle-rearm when threshold not reached (no thrash)');

  // Alarm set to T+5min, now = T+5min → idleEligible = true → idle-rearm op emitted
  const timeAlarmElapsed = makeTimeFacts({
    now: T + 5 * 60 * 1000,
    lastProgressMs: T,
    inFlight: false,
    alarms: new Map([['completion', T + 5 * 60 * 1000]]),
  });
  const opsAlarmElapsed = maintainDecisions(d, stateGreenOutcome, timeAlarmElapsed);
  const rearmOps = opsAlarmElapsed.filter(
    (op) => op.kind === 'reject' && op.path === 'outcome' && op.reason.includes('idle-rearm'),
  );
  assert.equal(rearmOps.length, 1, 'idle-rearm op emitted when alarm elapsed and outcome is green');
});

// ============================================================
// Terminal-settle invariant tests (§15.2)
// ============================================================

// ---- (f) terminal-settle: evaluator NOT re-armed when terminal artifact is green ----

test('(f) terminal-settle invariant: evaluator not re-armed when terminal artifact is green', () => {
  // Workflow: planner → plan, merger (terminal) → merge (terminal:true), completion (allGreen) → outcome
  // State: merge is green+terminal, plan went back to owed (mid-pipeline debt after terminal green)
  // maintainDecisions: outcome must NOT be re-armed (terminal artifact is green)
  const d = def('terminal-wf', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'merger', consumes: ['plan'], produces: ['merge'], terminal: true }),
    step({ name: 'completion', produces: ['outcome'], on: ['allGreen'] }),
  ]);

  const state = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 1 },
    { path: 'merge', producer: 'merger', acceptance: 'green', version: 1, terminal: true },
    { path: 'outcome', producer: 'completion', acceptance: 'green', version: 1 },
  ]);

  const ops = maintainDecisions(d, state);
  const rearmOps = ops.filter((op) => op.kind === 'reject' && op.path === 'outcome');
  assert.equal(rearmOps.length, 0, 'outcome must NOT be re-armed when a terminal artifact is green');
});

// ---- (g) non-regression: poller (no terminal) still re-arms normally -----------

test('(g) non-regression: poller (no terminal artifact) still re-arms when workflow falls out of done', () => {
  // Same shape but no terminal artifact — the allGreen evaluator must still re-arm
  const d = def('poller-wf', [input('proposal')], [
    step({ name: 'planner', consumes: ['proposal'], produces: ['plan'] }),
    step({ name: 'completion', produces: ['outcome'], on: ['allGreen'] }),
  ]);
  // No terminal artifact — plan is owed after a fall-out-of-done
  const state = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 2 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 1 },
    { path: 'outcome', producer: 'completion', acceptance: 'green', version: 1 },
  ]);
  const ops = maintainDecisions(d, state);
  const rearmOps = ops.filter((op) => op.kind === 'reject' && op.path === 'outcome');
  assert.equal(
    rearmOps.length,
    1,
    'outcome MUST be re-armed when no terminal artifact is green (poller pattern)',
  );
});

// ---- (h) PURITY: eligibleFirings is idempotent for fixed (arts, timeFacts) ----

test('(h) purity: eligibleFirings is idempotent for identical (arts, timeFacts)', () => {
  const IDLE_AFTER_MS = 30 * 60 * 1000;
  const d = makeIdleDef(IDLE_AFTER_MS);

  const state = arts([
    { path: 'proposal', producer: 'human', acceptance: 'green', version: 1 },
    { path: 'plan', producer: 'planner', acceptance: 'owed', version: 0 },
    { path: 'outcome', producer: 'completion', acceptance: 'owed', version: 0 },
  ]);

  const T = 1_000_000;
  const time = makeTimeFacts({ now: T + 60 * 60 * 1000, lastProgressMs: T, inFlight: false });

  const result1 = eligibleFirings(d, state, time);
  const result2 = eligibleFirings(d, state, time);

  assert.equal(result1.length, result2.length, 'eligibleFirings must be idempotent');
  for (let i = 0; i < result1.length; i++) {
    assert.deepEqual(result1[i], result2[i], `firing[${i}] must be identical across calls`);
  }
});
