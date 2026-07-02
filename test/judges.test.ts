/**
 * §24 — artifact judges (docs/proposals/artifact-judge.md). End-to-end engine
 * coverage for the `judges:` feature: a producer step's `produces` entry
 * declares one or more judges; the producer's `green` commit lands the
 * artifact `submitted` instead of `green`; each judge is a synthesized
 * StepDef that fires through the *normal* eligibility/claim/order pipeline
 * (§7.1) and renders its verdict via the existing `green`/`reject` verbs
 * against the judged stem (Q2).
 *
 * Fixture: `researcher` produces `report`, gated by two judges —
 * `completeness` and `rigor` — mirroring the proposal's §5 example.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { ArtifactData, WorkflowDef } from '../src/types.ts';
import { buildDef, validateDef } from '../src/defs.ts';

// ---- fixture def ---------------------------------------------------------------

function researcherDef(opts: { maxAttempts?: number } = {}): WorkflowDef {
  return buildDef({
    name: 'researcherDef',
    inputs: [{ name: 'question', seedOwed: true }],
    steps: [
      {
        name: 'researcher',
        consumes: ['question'],
        produces: [
          {
            name: 'report',
            judges: [
              { name: 'completeness', body: 'evaluate completeness' },
              { name: 'rigor', body: 'evaluate rigor' },
            ],
          },
        ],
        maxAttempts: opts.maxAttempts ?? 3,
      },
    ],
  });
}

function researcherWithInputsJudgeDef(): WorkflowDef {
  return buildDef({
    name: 'researcherInputsJudgeDef',
    inputs: [{ name: 'question', seedOwed: true }],
    steps: [
      {
        name: 'researcher',
        consumes: ['question'],
        produces: [
          {
            name: 'report',
            judges: [
              { name: 'completeness', body: 'evaluate completeness', inputs: true },
            ],
          },
        ],
      },
    ],
  });
}

// ---- harness ----------------------------------------------------------------

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

function getArt(store: Store, wf: string, path: string): ArtifactData | undefined {
  return store.getArtifact(wf, path);
}

// ---- defs sanity: synthesis shape --------------------------------------------

test('judges: buildDef synthesizes one StepDef per judge, validateDef is clean', () => {
  const d = researcherDef();
  const judgeSteps = d.steps.filter((s) => s.judges !== undefined);
  assert.equal(judgeSteps.length, 2);
  assert.deepEqual(
    judgeSteps.map((s) => s.name).sort(),
    ['researcher.report.judges.completeness', 'researcher.report.judges.rigor'],
  );
  for (const s of judgeSteps) {
    assert.equal(s.judges, 'report');
    assert.deepEqual(s.produces, []);
    assert.ok(s.consumes.some((c) => c.stem === 'report'), 'judge step must consume the judged stem');
  }
  const errors = validateDef(d);
  assert.deepEqual(errors, []);
});

// ---- (a) all-approve → green --------------------------------------------------

test('judges: (a) producer commit lands submitted; both judges approve → green', () => {
  const { engine, store } = makeEngine([researcherDef()]);
  const wf = engine.createInstance('researcherDef', { provide: { question: { text: 'why' } } });

  const tick1 = engine.tick(wf);
  assert.equal(tick1.orders.length, 1, 'only the researcher should be eligible pre-submission');
  const researchRun = tick1.orders[0]!.run;
  const res = engine.green(wf, researchRun, 'report', { sections: ['intro'] });
  assert.equal(res.outcome, 'submitted');
  engine.close(wf, researchRun);

  const submitted = getArt(store, wf, 'report');
  assert.equal(submitted?.acceptance, 'submitted');
  assert.equal(submitted?.version, 1);

  const status1 = engine.status(wf);
  assert.equal(status1.done, false, 'submitted must count as outstanding, not done');
  assert.equal(status1.pending.length, 1);
  assert.deepEqual(status1.pending[0]!.pendingJudges.sort(), ['completeness', 'rigor']);

  const tick2 = engine.tick(wf);
  const judgeOrders = tick2.orders.filter((o) => o.step.includes('.judges.'));
  assert.equal(judgeOrders.length, 2, 'both judges should be eligible on a submitted report');

  const completenessOrder = judgeOrders.find((o) => o.step.endsWith('.completeness'))!;
  const rigorOrder = judgeOrders.find((o) => o.step.endsWith('.rigor'))!;
  assert.deepEqual(completenessOrder.outputs, ['report']);
  assert.equal(completenessOrder.owes[0]?.acceptance, 'submitted');

  // First judge approves — ledger records one slot, artifact stays submitted.
  const r1 = engine.green(wf, completenessOrder.run, 'report', {});
  assert.equal(r1.outcome, 'approved');
  engine.close(wf, completenessOrder.run);
  assert.equal(getArt(store, wf, 'report')?.acceptance, 'submitted');
  assert.deepEqual(getArt(store, wf, 'report')?.approvals, { completeness: 1 });

  // Second judge approves — all declared judges have now signed → green.
  const r2 = engine.green(wf, rigorOrder.run, 'report', {});
  assert.equal(r2.outcome, 'green');
  engine.close(wf, rigorOrder.run);

  const finalArt = getArt(store, wf, 'report');
  assert.equal(finalArt?.acceptance, 'green');
  assert.deepEqual(finalArt?.approvals, { completeness: 1, rigor: 1 });

  const status2 = engine.status(wf);
  assert.equal(status2.done, true);
  assert.equal(status2.pending.length, 0);
});

// ---- (b) one-reject → rebuild → resubmit → re-judge, ledger cleared ----------

test('judges: (b) a single reject wins immediately; rebuild clears the ledger for re-judging', () => {
  const { engine, store } = makeEngine([researcherDef()]);
  const wf = engine.createInstance('researcherDef', { provide: { question: { text: 'why' } } });

  const run1 = engine.tick(wf).orders[0]!.run;
  engine.green(wf, run1, 'report', { sections: [] });
  engine.close(wf, run1);

  const tick2 = engine.tick(wf);
  const judgeOrders = tick2.orders.filter((o) => o.step.includes('.judges.'));
  const completenessOrder = judgeOrders.find((o) => o.step.endsWith('.completeness'))!;
  const rigorOrder = judgeOrders.find((o) => o.step.endsWith('.rigor'))!;

  // rigor approves first (ledger gets a partial entry)...
  engine.green(wf, rigorOrder.run, 'report', {});
  engine.close(wf, rigorOrder.run);
  assert.deepEqual(getArt(store, wf, 'report')?.approvals, { rigor: 1 });

  // ...then completeness rejects — wins immediately, regardless of rigor's sign-off.
  engine.reject(wf, 'report', completenessOrder.step, 'missing citations');
  engine.close(wf, completenessOrder.run);

  const rejected = getArt(store, wf, 'report');
  assert.equal(rejected?.acceptance, 'rejected');
  assert.equal(rejected?.judgmentRejects, 1);
  assert.equal(rejected?.approvals, undefined, 'ledger must be cleared on reject');

  // Producer re-arms and rebuilds.
  const tick3 = engine.tick(wf);
  const researchOrder2 = tick3.orders.find((o) => o.step === 'researcher');
  assert.ok(researchOrder2 !== undefined, 'researcher must be re-armed after a judge reject');
  const res2 = engine.green(wf, researchOrder2!.run, 'report', { sections: ['intro', 'body'] });
  assert.equal(res2.outcome, 'submitted');
  engine.close(wf, researchOrder2!.run);

  const resubmitted = getArt(store, wf, 'report');
  assert.equal(resubmitted?.acceptance, 'submitted');
  assert.equal(resubmitted?.version, 2);
  assert.equal(resubmitted?.approvals, undefined, 'fresh submission starts with no approvals');

  // Both judges must re-fire on the new version — including rigor, which already
  // approved v1 but has not signed v2.
  const tick4 = engine.tick(wf);
  const judgeOrders2 = tick4.orders.filter((o) => o.step.includes('.judges.'));
  assert.equal(judgeOrders2.length, 2, 'both judges re-fire on the fresh submission');
});

// ---- (c) stall at maxAttempts -------------------------------------------------

test('judges: (c) repeated judge rejects stall the producer at maxAttempts', () => {
  const { engine, store } = makeEngine([researcherDef({ maxAttempts: 2 })]);
  const wf = engine.createInstance('researcherDef', { provide: { question: { text: 'why' } } });

  for (let i = 0; i < 2; i++) {
    const run = engine.tick(wf).orders.find((o) => o.step === 'researcher')!.run;
    engine.green(wf, run, 'report', { sections: [] });
    engine.close(wf, run);
    const judgeOrder = engine.tick(wf).orders.find((o) => o.step.endsWith('.completeness'))!;
    engine.reject(wf, 'report', judgeOrder.step, 'still missing citations');
    engine.close(wf, judgeOrder.run);
  }

  const art = getArt(store, wf, 'report');
  assert.equal(art?.acceptance, 'rejected');
  assert.equal(art?.judgmentRejects, 2);

  // Stalled: researcher must not be re-armed a third time.
  const tick = engine.tick(wf);
  assert.ok(tick.orders.every((o) => o.step !== 'researcher'), 'producer must be stalled, not re-armed');

  const status = engine.status(wf);
  assert.ok(status.debts.some((d) => d.path === 'report'), 'stalled report should surface as a debt');
});

// ---- (d) cascade discard without a strike -------------------------------------

test('judges: (d) an input-move cascade discards a submitted verdict without bumping judgmentRejects', () => {
  const { engine, store } = makeEngine([researcherDef()]);
  const wf = engine.createInstance('researcherDef', { provide: { question: { text: 'v1' } } });

  const run1 = engine.tick(wf).orders[0]!.run;
  engine.green(wf, run1, 'report', { sections: ['a'] });
  engine.close(wf, run1);
  assert.equal(getArt(store, wf, 'report')?.acceptance, 'submitted');

  // The question input moves (re-provided) while report is submitted and un-judged.
  engine.provideInput(wf, 'question', { text: 'v2' });

  const moved = getArt(store, wf, 'report');
  assert.equal(moved?.acceptance, 'rejected', 'cascade reject re-arms the producer');
  assert.equal(moved?.judgmentRejects, 0, 'a cascade discard is not a quality verdict — no strike');

  const tick = engine.tick(wf);
  assert.ok(tick.orders.some((o) => o.step === 'researcher'), 'producer re-arms after the cascade');
});

// ---- (e) §4.6 stale-verdict race: resubmit while a judge order is in flight --

test('judges: (e) a stale judge verdict against a resubmitted version is born-rejected', () => {
  const { engine, store } = makeEngine([researcherDef()]);
  const wf = engine.createInstance('researcherDef', { provide: { question: { text: 'why' } } });

  const run1 = engine.tick(wf).orders[0]!.run;
  engine.green(wf, run1, 'report', { sections: ['a'] });
  engine.close(wf, run1);

  // Claim the completeness judge order against v1 (fingerprints v1).
  const tick2 = engine.tick(wf);
  const completenessOrder = tick2.orders.find((o) => o.step.endsWith('.completeness'))!;

  // Meanwhile, a human bypasses and greens report directly (moves it off `submitted`).
  const humanRes = engine.green(wf, 'human', 'report', { sections: ['a', 'b'] });
  assert.equal(humanRes.outcome, 'green');
  assert.equal(getArt(store, wf, 'report')?.version, 2);

  // The stale judge order's verdict arrives late — must be refused, not applied.
  const staleRes = engine.green(wf, completenessOrder.run, 'report', {});
  assert.equal(staleRes.outcome, 'born-rejected');

  // report is untouched by the stale verdict — still green at v2.
  const art = getArt(store, wf, 'report');
  assert.equal(art?.acceptance, 'green');
  assert.equal(art?.version, 2);
});

// ---- (e2) §4.6 stale-verdict race: sibling judge already settled it ----------

test('judges: (e2) a stale judge verdict against an artifact another judge already rejected is born-rejected', () => {
  const { engine, store } = makeEngine([researcherDef()]);
  const wf = engine.createInstance('researcherDef', { provide: { question: { text: 'why' } } });

  const run1 = engine.tick(wf).orders[0]!.run;
  engine.green(wf, run1, 'report', { sections: ['a'] });
  engine.close(wf, run1);

  const tick2 = engine.tick(wf);
  const completenessOrder = tick2.orders.find((o) => o.step.endsWith('.completeness'))!;
  const rigorOrder = tick2.orders.find((o) => o.step.endsWith('.rigor'))!;

  // rigor rejects first — report leaves `submitted`.
  engine.reject(wf, 'report', rigorOrder.step, 'not rigorous');
  engine.close(wf, rigorOrder.run);
  assert.equal(getArt(store, wf, 'report')?.acceptance, 'rejected');

  // completeness's in-flight verdict for the same (now-stale) submission arrives late.
  const staleRes = engine.green(wf, completenessOrder.run, 'report', {});
  assert.equal(staleRes.outcome, 'born-rejected');

  // Only one strike recorded — the sibling's stale verdict must not double-count.
  assert.equal(getArt(store, wf, 'report')?.judgmentRejects, 1);
});

// ---- (e3) §4.6 stale-verdict race: a stale judge REJECT (not approve) ---------

test('judges: (e3) a stale judge reject against a resubmitted version is born-rejected, not corrupting v2', () => {
  const { engine, store } = makeEngine([researcherDef()]);
  const wf = engine.createInstance('researcherDef', { provide: { question: { text: 'why' } } });

  const run1 = engine.tick(wf).orders[0]!.run;
  engine.green(wf, run1, 'report', { sections: ['a'] });
  engine.close(wf, run1);

  // Claim the completeness judge order against v1 (fingerprints v1).
  const tick2 = engine.tick(wf);
  const completenessOrder = tick2.orders.find((o) => o.step.endsWith('.completeness'))!;
  const rigorOrder = tick2.orders.find((o) => o.step.endsWith('.rigor'))!;

  // A sibling judge (rigor) rejects v1 first — report leaves `submitted`, one strike.
  engine.reject(wf, 'report', rigorOrder.step, 'not rigorous');
  engine.close(wf, rigorOrder.run);
  assert.equal(getArt(store, wf, 'report')?.acceptance, 'rejected');
  assert.equal(getArt(store, wf, 'report')?.judgmentRejects, 1);

  // Producer rebuilds and resubmits — a fresh v2, ledger cleared.
  const researchOrder2 = engine.tick(wf).orders.find((o) => o.step === 'researcher')!;
  engine.green(wf, researchOrder2.run, 'report', { sections: ['a', 'b'] });
  engine.close(wf, researchOrder2.run);
  const v2 = getArt(store, wf, 'report');
  assert.equal(v2?.acceptance, 'submitted');
  assert.equal(v2?.version, 2);

  // A second judge round claims fresh orders against v2 — get a partial approval
  // recorded on v2's ledger before the stale v1 verdict arrives.
  const tick3 = engine.tick(wf);
  const rigorOrder2 = tick3.orders.find((o) => o.step.endsWith('.rigor'))!;
  engine.green(wf, rigorOrder2.run, 'report', {});
  engine.close(wf, rigorOrder2.run);
  assert.deepEqual(getArt(store, wf, 'report')?.approvals, { rigor: 2 });

  // The completeness judge's stale v1 order — still holding its lease from before
  // the rebuild — finally renders its (late) reject verdict. Must be refused
  // (born-rejected), not applied to the unrelated newer v2 submission.
  const staleRejectRes = engine.reject(wf, 'report', completenessOrder.step, 'stale: missing citations (v1)');
  assert.equal(staleRejectRes.outcome, 'born-rejected');

  // v2 is untouched by the stale reject: still submitted at v2, one strike total
  // (not double-bumped), and the in-progress approval ledger survives intact.
  const art = getArt(store, wf, 'report');
  assert.equal(art?.acceptance, 'submitted', 'v2 must not be re-rejected by the stale v1 verdict');
  assert.equal(art?.version, 2);
  assert.equal(art?.judgmentRejects, 1, 'the stale reject must not double-bump judgmentRejects');
  assert.deepEqual(art?.approvals, { rigor: 2 }, 'v2\'s in-progress approval ledger must survive intact');

  // The stale judge order's lease was released (not left dangling): a fresh
  // completeness order should be claimable on the next tick.
  const tick4 = engine.tick(wf);
  const refiredCompleteness = tick4.orders.find((o) => o.step === completenessOrder.step);
  assert.ok(refiredCompleteness !== undefined, 'the stale judge order releases its lease and can re-fire');
  assert.notEqual(refiredCompleteness!.run, completenessOrder.run);
});

// ---- (f) dead judge order reaped, re-fired, no judgmentRejects bump ----------

test('judges: (f) a dead judge order is reaped and re-fired without a judgmentRejects strike', () => {
  const { engine, store } = makeEngine([researcherDef()]);
  const wf = engine.createInstance('researcherDef', { provide: { question: { text: 'why' } } });

  const run1 = engine.tick(wf).orders[0]!.run;
  engine.green(wf, run1, 'report', { sections: ['a'] });
  engine.close(wf, run1);

  const tick2 = engine.tick(wf);
  const completenessOrder = tick2.orders.find((o) => o.step.endsWith('.completeness'))!;
  // Never verdict — simulate an order that dies (crash/timeout): force the TTL
  // to have elapsed by ticking with a far-future clock so reap() strands it.
  const farFuture = Date.now() + 3 * 60 * 60 * 1000; // > default 2h reapTtlMs
  // tick() does maintain → reap → eligible → claim in one pass (§7.1's pipeline),
  // so the stranded order is reaped AND re-claimed within this same tick.
  const tick3 = engine.tick(wf, { now: farFuture });
  assert.ok(tick3.reaped >= 1, 'the stranded completeness order should be reaped');

  const art = getArt(store, wf, 'report');
  assert.equal(art?.acceptance, 'submitted', 'the artifact stays submitted — no verdict was rendered');
  assert.equal(art?.judgmentRejects, 0, 'an order failure is not a judge reject (§4.10)');

  // The judge must be re-eligible and re-claimed in that same reap-and-retry tick.
  const refired = tick3.orders.find((o) => o.step === completenessOrder.step);
  assert.ok(refired !== undefined, 'the judge should re-fire after being reaped');
  assert.notEqual(refired!.run, completenessOrder.run, 'the reaped order gets a fresh run id');
});

// ---- (g) human green bypasses pending judges ---------------------------------

test('judges: (g) human green on a submitted artifact bypasses all pending judges at once', () => {
  const { engine, store } = makeEngine([researcherDef()]);
  const wf = engine.createInstance('researcherDef', { provide: { question: { text: 'why' } } });

  const run1 = engine.tick(wf).orders[0]!.run;
  engine.green(wf, run1, 'report', { sections: ['a'] });
  engine.close(wf, run1);
  assert.equal(getArt(store, wf, 'report')?.acceptance, 'submitted');

  const res = engine.green(wf, 'human', 'report', { sections: ['a', 'b'], approvedManually: true });
  assert.equal(res.outcome, 'green');

  const art = getArt(store, wf, 'report');
  assert.equal(art?.acceptance, 'green');
  assert.equal(art?.approvals, undefined, 'the human bypass does not sign the ledger, it overrides it');

  const status = engine.status(wf);
  assert.equal(status.done, true);
});

// ---- (h) human retry after a judge-reject stall clears the ledger -----------

test('judges: (h) human retry after a judge-reject stall clears both counters and the ledger', () => {
  const { engine, store } = makeEngine([researcherDef({ maxAttempts: 1 })]);
  const wf = engine.createInstance('researcherDef', { provide: { question: { text: 'why' } } });

  const run1 = engine.tick(wf).orders[0]!.run;
  engine.green(wf, run1, 'report', { sections: [] });
  engine.close(wf, run1);

  const tick2 = engine.tick(wf);
  const rigorOrder = tick2.orders.find((o) => o.step.endsWith('.rigor'))!;
  engine.green(wf, rigorOrder.run, 'report', {}); // rigor approves, partial ledger
  engine.close(wf, rigorOrder.run);
  assert.deepEqual(getArt(store, wf, 'report')?.approvals, { rigor: 1 });

  const completenessOrder = tick2.orders.find((o) => o.step.endsWith('.completeness'))!;
  engine.reject(wf, 'report', completenessOrder.step, 'missing citations');
  engine.close(wf, completenessOrder.run);

  // Stalled (maxAttempts: 1).
  const stalledTick = engine.tick(wf);
  assert.ok(stalledTick.orders.every((o) => o.step !== 'researcher'));

  engine.retry(wf, 'report', 'human', 'go again, be thorough');
  const retried = getArt(store, wf, 'report');
  assert.equal(retried?.acceptance, 'owed');
  assert.equal(retried?.judgmentRejects, 0);
  assert.equal(retried?.approvals, undefined, 'retry clears the stale partial ledger too');

  const resumed = engine.tick(wf);
  assert.ok(resumed.orders.some((o) => o.step === 'researcher'), 'producer resumes after retry');
});

// ---- (i) terminal is applied at judge-approve, not producer-commit -----------

test('judges: (i) terminal applies only once the last judge approves, not at producer commit', () => {
  const d = buildDef({
    name: 'terminalJudgedDef',
    inputs: [{ name: 'question', seedOwed: true }],
    steps: [
      {
        name: 'researcher',
        consumes: ['question'],
        produces: [{ name: 'report', judges: [{ name: 'completeness', body: 'evaluate' }] }],
        terminal: true,
      },
    ],
  });
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('terminalJudgedDef', { provide: { question: { text: 'why' } } });

  const run1 = engine.tick(wf).orders[0]!.run;
  engine.green(wf, run1, 'report', { sections: ['a'] });
  engine.close(wf, run1);

  const submitted = getArt(store, wf, 'report');
  assert.equal(submitted?.acceptance, 'submitted');
  assert.ok(!submitted?.terminal, 'terminal must NOT be applied at producer commit when judges are declared');

  const judgeOrder = engine.tick(wf).orders.find((o) => o.step.endsWith('.completeness'))!;
  engine.green(wf, judgeOrder.run, 'report', {});
  engine.close(wf, judgeOrder.run);

  const final = getArt(store, wf, 'report');
  assert.equal(final?.acceptance, 'green');
  assert.equal(final?.terminal, true, 'terminal applies once the judge approves');
});

// ---- (j) judge throttling — cadence / maxRunsPerDay flow through applySchedule --

test('judges: (j) a judge with maxRunsPerDay: 1 is deferred, not claimed, once its daily budget is spent', () => {
  const d = buildDef({
    name: 'throttledJudgeDef',
    inputs: [{ name: 'question', seedOwed: true }],
    steps: [
      {
        name: 'researcher',
        consumes: ['question'],
        produces: [
          {
            name: 'report',
            judges: [{ name: 'completeness', body: 'evaluate', maxRunsPerDay: 1 }],
          },
        ],
      },
    ],
  });
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('throttledJudgeDef', { provide: { question: { text: 'why' } } });

  const run1 = engine.tick(wf).orders[0]!.run;
  engine.green(wf, run1, 'report', { sections: ['a'] });
  engine.close(wf, run1);

  const tick2 = engine.tick(wf);
  const judgeOrder = tick2.orders.find((o) => o.step.endsWith('.completeness'))!;
  assert.ok(judgeOrder, 'first judge run should be claimed within the daily budget');

  // Reject without closing cleanly re-arms the ledger check, but the key point here
  // is budget accounting: the judge already used its one daily run, so a second
  // eligible firing (before the first is even resolved) must be deferred, not claimed.
  const tick3 = engine.tick(wf);
  const secondJudgeOrder = tick3.orders.find((o) => o.step.endsWith('.completeness'));
  assert.equal(secondJudgeOrder, undefined, 'no second concurrent judge claim once the daily budget (1) is spent');
  const deferredEntry = tick3.deferred.find((f) => f.step === judgeOrder.step);
  assert.equal(deferredEntry?.reason, 'daily-budget');

  // Resolve the in-flight run so acceptance state is left clean.
  engine.green(wf, judgeOrder.run, 'report', {});
  engine.close(wf, judgeOrder.run);
  assert.equal(getArt(store, wf, 'report')?.acceptance, 'green');
});

test('judges: (j2) a judge with cadence defers a re-fire until the gap elapses', () => {
  const d = buildDef({
    name: 'cadenceJudgeDef',
    inputs: [{ name: 'question', seedOwed: true }],
    steps: [
      {
        name: 'researcher',
        consumes: ['question'],
        produces: [
          {
            name: 'report',
            judges: [{ name: 'completeness', body: 'evaluate', cadence: '1h' }],
          },
        ],
        maxAttempts: 5,
      },
    ],
  });
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('cadenceJudgeDef', { provide: { question: { text: 'why' } } });

  const run1 = engine.tick(wf).orders[0]!.run;
  engine.green(wf, run1, 'report', { sections: ['a'] });
  engine.close(wf, run1);

  const t0 = Date.now();
  const tick2 = engine.tick(wf, { now: t0 });
  const judgeOrder = tick2.orders.find((o) => o.step.endsWith('.completeness'))!;
  engine.reject(wf, 'report', judgeOrder.step, 'needs more detail');
  engine.close(wf, judgeOrder.run);

  const run2 = engine.tick(wf, { now: t0 }).orders.find((o) => o.step === 'researcher')!.run;
  engine.green(wf, run2, 'report', { sections: ['a', 'b'] });
  engine.close(wf, run2);

  // Re-fire attempted immediately after the prior judge run — still within the 1h cadence gap.
  const tickSoon = engine.tick(wf, { now: t0 + 60_000 });
  const soonOrder = tickSoon.orders.find((o) => o.step.endsWith('.completeness'));
  assert.equal(soonOrder, undefined, 'judge must not re-fire before its cadence gap elapses');
  const deferredSoon = tickSoon.deferred.find((f) => f.step.endsWith('.completeness'));
  assert.equal(deferredSoon?.reason, 'cadence');

  // Once the cadence gap has elapsed, the judge is eligible again.
  const tickLater = engine.tick(wf, { now: t0 + 61 * 60_000 });
  const laterOrder = tickLater.orders.find((o) => o.step.endsWith('.completeness'));
  assert.ok(laterOrder !== undefined, 'judge should re-fire once the cadence gap has elapsed');
});

// ---- (k) judge authority is scoped to its own judged stem only --------------

test('judges: (k) a judge with inputs:true cannot reject a stem it only consumes for context', () => {
  const { engine, store } = makeEngine([researcherWithInputsJudgeDef()]);
  const wf = engine.createInstance('researcherInputsJudgeDef', { provide: { question: { text: 'why' } } });

  const run1 = engine.tick(wf).orders.find((o) => o.step === 'researcher')!.run;
  engine.green(wf, run1, 'report', { sections: ['a'] });
  engine.close(wf, run1);
  assert.equal(getArt(store, wf, 'report')?.acceptance, 'submitted');

  const tick2 = engine.tick(wf);
  const judgeOrder = tick2.orders.find((o) => o.step.includes('.judges.'))!;
  assert.ok(judgeOrder, 'the inputs:true judge should be eligible on the submitted report');

  const questionBefore = getArt(store, wf, 'question');

  // The judge consumes `question` for context (inputs: true) but does not
  // judge it — rejecting it must be refused, not applied.
  assert.throws(() => engine.reject(wf, 'question', judgeOrder.step, 'trying to reject the wrong stem'));

  // `question` is completely untouched by the refused reject.
  assert.deepEqual(getArt(store, wf, 'question'), questionBefore);

  // The judged `report` is untouched too — still submitted, no ledger change.
  const reportAfter = getArt(store, wf, 'report');
  assert.equal(reportAfter?.acceptance, 'submitted');
  assert.equal(reportAfter?.judgmentRejects, 0);

  // The SAME judge rejecting its own declared stem (`report`) still works.
  const res = engine.reject(wf, 'report', judgeOrder.step, 'actually reject the judged stem');
  assert.equal(res.outcome, 'rejected');
  engine.close(wf, judgeOrder.run);

  const reportRejected = getArt(store, wf, 'report');
  assert.equal(reportRejected?.acceptance, 'rejected');
  assert.equal(reportRejected?.judgmentRejects, 1);
});
