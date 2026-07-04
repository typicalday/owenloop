/**
 * §26 — declarative exclusive produce-groups. A step's `produces:` list may
 * carry `{ group, mode, of }` entries declaring a commit-exclusivity contract
 * across two or more of the step's own singleton sibling stems:
 *   - 'exactlyOne'/'atMostOne' — the engine refuses a second commit once one
 *     member is green, and auto-skips the untouched siblings.
 *   - 'atLeastOne' — no commit-time refusal; done-ness simply stops counting
 *     the other members once one is green.
 *
 * This replaces the old convention of a router step manually calling
 * `engine.skip()` on its losing branch (see engine.test.ts's 'routed' fixture)
 * with a declarative, engine-enforced contract that the model checker explores
 * exactly like the real engine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import type { Order } from '../src/engine.ts';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { ArtifactData, WorkflowDef } from '../src/types.ts';
import { buildDef, validateDef } from '../src/defs.ts';
import { applyOutcome, eligibleFirings, modelCheck, settleInMemory } from '../src/model.ts';

// ---- fixture def --------------------------------------------------------------

/**
 * A router that produces exactly one of two exclusive route outputs.
 * maxSchemaFailures: 0 and maxAttempts: 1000 on every step disable schema-reject
 * and judgment-reject stalling (see check.test.ts's convention) so modelCheck's
 * BFS explores only the group-relevant outcomes within a bounded search, not
 * incidental stall dynamics unrelated to §26.
 */
function routerDef(mode: 'exactlyOne' | 'atMostOne' | 'atLeastOne' = 'exactlyOne'): WorkflowDef {
  return buildDef({
    name: 'routerDef',
    inputs: [{ name: 'ticket' }],
    steps: [
      {
        name: 'triage',
        consumes: ['ticket'],
        produces: [
          'simple',
          'urgent',
          { group: 'route', mode, of: ['simple', 'urgent'] },
        ],
        maxSchemaFailures: 0,
        maxAttempts: 1000,
      },
      { name: 'handleSimple', consumes: ['simple'], produces: ['simpleDone'], maxSchemaFailures: 0, maxAttempts: 1000 },
      { name: 'handleUrgent', consumes: ['urgent'], produces: ['urgentDone'], maxSchemaFailures: 0, maxAttempts: 1000 },
    ],
  });
}

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

function fire(engine: Engine, wf: string, stepName: string): Order {
  const t = engine.tick(wf, { now: Date.now() });
  const matching = t.orders.filter((o) => o.step === stepName);
  assert.equal(matching.length, 1, `expected exactly one ${stepName} order, got [${t.orders.map((o) => o.step)}]`);
  return matching[0]!;
}

// ---- defs sanity ---------------------------------------------------------------

test('groups: buildDef parses group: into StepDef.groups and validateDef is clean', () => {
  const d = routerDef();
  const triage = d.steps.find((s) => s.name === 'triage')!;
  assert.deepEqual(triage.groups, [{ group: 'route', mode: 'exactlyOne', of: ['simple', 'urgent'] }]);
  // group: contributes zero ProducePatterns of its own
  assert.deepEqual(triage.produces.map((p) => p.stem).sort(), ['simple', 'urgent']);
  const errors = validateDef(d);
  assert.deepEqual(errors, []);
});

// ---- (a) both branches refused: winner already green, second commit refused ----

test('groups: (a) exactlyOne — a second commit to the losing sibling is refused (group-rejected)', () => {
  const { engine, store } = makeEngine([routerDef('exactlyOne')]);
  const wf = engine.createInstance('routerDef', { provide: { ticket: { text: 'x' } } });

  const triageRun = fire(engine, wf, 'triage').run;
  const winRes = engine.green(wf, triageRun, 'simple', { ok: true });
  assert.equal(winRes.outcome, 'green');

  // by the time the winner's green() returns, settle() has already run the
  // auto-skip cascade — urgent is already 'skipped', not merely 'owed'.
  assert.equal(getArt(store, wf, 'urgent')?.acceptance, 'skipped');

  // the sibling commit is refused regardless — groupCasCheck runs before any
  // other commit logic, so even a late/racing attempt against the now-skipped
  // sibling is refused with 'group-rejected', not silently mutated.
  const loseRes = engine.green(wf, triageRun, 'urgent', { ok: true });
  assert.equal(loseRes.outcome, 'group-rejected');
  assert.match(loseRes.reason ?? '', /route.*exactlyOne.*simple.*green/);

  // the refused artifact was NOT mutated further — still skipped, version 0
  const urgentArt = getArt(store, wf, 'urgent');
  assert.equal(urgentArt?.acceptance, 'skipped');
  assert.equal(urgentArt?.version, 0);

  engine.close(wf, triageRun);
});

// ---- (a2) ordering: group refusal preempts schema validation, not the reverse --

test('groups: (a2) a schema-invalid commit against an already-decided losing sibling is group-rejected, not schema-rejected', () => {
  // A dedicated def where 'urgent' additionally declares a schema, so a
  // commit to it can be BOTH schema-invalid AND targeting a group loser at
  // the same time. groupCasCheck must run before schema validation (same
  // "check first, don't mutate on refusal" ordering as the other structural
  // refusal checks, and the same ordering already correct in the human-bypass
  // and judge-approve branches) — so the outcome must be 'group-rejected'
  // and NEITHER schemaRejects NOR the artifact's acceptance/version should
  // move, exactly as a group refusal never mutates anything.
  const d = buildDef({
    name: 'orderingDef',
    inputs: [{ name: 'ticket' }],
    steps: [
      {
        name: 'triage',
        consumes: ['ticket'],
        produces: [
          'simple',
          { name: 'urgent', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } },
          { group: 'route', mode: 'exactlyOne', of: ['simple', 'urgent'] },
        ],
        maxSchemaFailures: 0,
        maxAttempts: 1000,
      },
      { name: 'handleSimple', consumes: ['simple'], produces: ['simpleDone'], maxSchemaFailures: 0, maxAttempts: 1000 },
      { name: 'handleUrgent', consumes: ['urgent'], produces: ['urgentDone'], maxSchemaFailures: 0, maxAttempts: 1000 },
    ],
  });
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('orderingDef', { provide: { ticket: { text: 'x' } } });

  const triageRun = fire(engine, wf, 'triage').run;
  const winRes = engine.green(wf, triageRun, 'simple', { ok: true });
  assert.equal(winRes.outcome, 'green');
  assert.equal(getArt(store, wf, 'urgent')?.acceptance, 'skipped');

  // attempt to green the losing sibling with a value that would ALSO fail its
  // own declared schema (missing the required 'ok' property).
  const loseRes = engine.green(wf, triageRun, 'urgent', { wrong: 1 } as Record<string, unknown>);
  assert.equal(loseRes.outcome, 'group-rejected');
  assert.match(loseRes.reason ?? '', /route.*exactlyOne.*simple.*green/);

  // neither counter moved, and the artifact was not mutated beyond the
  // earlier auto-skip — schema validation never ran.
  const urgentArt = getArt(store, wf, 'urgent');
  assert.equal(urgentArt?.acceptance, 'skipped');
  assert.equal(urgentArt?.version, 0);
  assert.equal(urgentArt?.schemaRejects, 0);
  assert.equal(urgentArt?.judgmentRejects, 0);

  engine.close(wf, triageRun);
});

// ---- (b) auto-skip: winner commits, sibling auto-skips without manual intervention --

test('groups: (b) exactlyOne — committing one member auto-skips the untouched sibling', () => {
  const { engine, store } = makeEngine([routerDef('exactlyOne')]);
  const wf = engine.createInstance('routerDef', { provide: { ticket: { text: 'x' } } });

  const triageRun = fire(engine, wf, 'triage').run;
  engine.green(wf, triageRun, 'simple', { ok: true });
  engine.close(wf, triageRun);

  const urgentArt = getArt(store, wf, 'urgent');
  assert.equal(urgentArt?.acceptance, 'skipped');
  const lastReason = urgentArt?.reasons[urgentArt.reasons.length - 1];
  assert.equal(lastReason?.action, 'skip');
  assert.equal(lastReason?.kind, 'exclusive');
  assert.match(lastReason?.text ?? '', /route.*exactlyOne.*simple/);

  // the dead branch (handleUrgent) never fires; the live branch does
  const t = engine.tick(wf);
  assert.ok(t.orders.some((o) => o.step === 'handleSimple'));
  assert.ok(t.orders.every((o) => o.step !== 'handleUrgent'));
});

// ---- (c) atMostOne: zero winners is a legal end state, no refusal, no auto-skip --

test('groups: (c) atMostOne — a producer that routes to neither member (both manually skipped) is legal, no group refusal', () => {
  const d = buildDef({
    name: 'atMostOneDef',
    inputs: [{ name: 'ticket', seedOwed: false }],
    steps: [
      {
        name: 'triage',
        consumes: ['ticket'],
        produces: ['simple', 'urgent', { group: 'route', mode: 'atMostOne', of: ['simple', 'urgent'] }],
      },
    ],
  });
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('atMostOneDef', { provide: { ticket: { text: 'x' } } });

  const triageRun = fire(engine, wf, 'triage').run;
  // the producer decides this ticket needs neither branch (e.g. it's spam) and
  // manually skips both — an atMostOne group tolerates zero winners; nothing
  // about the group logic forces or refuses this, unlike exactlyOne/atLeastOne
  // which both require at least one member to eventually be green.
  engine.skip(wf, 'simple', 'triage', 'not applicable to this ticket');
  engine.skip(wf, 'urgent', 'triage', 'not applicable to this ticket');
  engine.close(wf, triageRun);

  assert.equal(getArt(store, wf, 'simple')?.acceptance, 'skipped');
  assert.equal(getArt(store, wf, 'urgent')?.acceptance, 'skipped');

  // no group-rejected outcome was ever produced — these were plain manual skips,
  // not auto-skips or refusals (group auto-skip only fires once a winner exists).
  const simpleReasons = getArt(store, wf, 'simple')?.reasons ?? [];
  const urgentReasons = getArt(store, wf, 'urgent')?.reasons ?? [];
  assert.ok(simpleReasons.every((r) => r.kind !== 'exclusive'));
  assert.ok(urgentReasons.every((r) => r.kind !== 'exclusive'));

  // the workflow is fully settled — nothing outstanding
  assert.equal(engine.status(wf).done, true);
});

// ---- (d) atLeastOne — a green member discharges done-ness even with a sibling still owed --

test('groups: (d) atLeastOne — one green member is enough for done, no refusal, no auto-skip', () => {
  const d = buildDef({
    name: 'atLeastOneDef',
    inputs: [{ name: 'ticket', seedOwed: false }],
    steps: [
      {
        name: 'triage',
        consumes: ['ticket'],
        produces: ['simple', 'urgent', { group: 'route', mode: 'atLeastOne', of: ['simple', 'urgent'] }],
      },
    ],
  });
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('atLeastOneDef', { provide: { ticket: { text: 'x' } } });

  const triageRun = fire(engine, wf, 'triage').run;
  engine.green(wf, triageRun, 'simple', { ok: true });
  engine.close(wf, triageRun);

  // 'urgent' is untouched (still owed) — atLeastOne never auto-skips
  assert.equal(getArt(store, wf, 'urgent')?.acceptance, 'owed');
  assert.equal(getArt(store, wf, 'simple')?.acceptance, 'green');

  // yet the workflow is done: atLeastOne is satisfied by one green member
  const status = engine.status(wf);
  assert.equal(status.done, true);

  // a subsequent commit to 'urgent' is NOT refused (atLeastOne never gates commits)
  const res = engine.green(wf, 'human', 'urgent', { ok: true });
  assert.equal(res.outcome, 'green');
  assert.equal(engine.status(wf).done, true);
});

// ---- (e) cascade re-arm: winner un-greens, auto-skipped sibling revives --------

test('groups: (e) rejecting the winner re-arms the auto-skipped sibling (cascade revival)', () => {
  const { engine, store } = makeEngine([routerDef('exactlyOne')]);
  const wf = engine.createInstance('routerDef', { provide: { ticket: { text: 'x' } } });

  const triageRun = fire(engine, wf, 'triage').run;
  engine.green(wf, triageRun, 'simple', { ok: true });
  engine.close(wf, triageRun);
  assert.equal(getArt(store, wf, 'urgent')?.acceptance, 'skipped');

  // the ticket is re-triaged: reject the winner, re-fire triage, this time producing urgent
  engine.reject(wf, 'simple', 'human', 're-triage: now urgent');
  const triageRun2 = fire(engine, wf, 'triage').run;
  engine.green(wf, triageRun2, 'urgent', { ok: true });
  engine.close(wf, triageRun2);

  // simple auto-skips as the new loser; urgent is the new winner
  assert.equal(getArt(store, wf, 'urgent')?.acceptance, 'green');
  assert.equal(getArt(store, wf, 'simple')?.acceptance, 'skipped');

  const t = engine.tick(wf);
  assert.ok(t.orders.some((o) => o.step === 'handleUrgent'));
  assert.ok(t.orders.every((o) => o.step !== 'handleSimple'));
});

// ---- (f) judges interaction: group refusal gates the judge-approve moment ------

test('groups: (f) a judged group member is refused at the judge-approve moment, not at producer submit', () => {
  const d = buildDef({
    name: 'judgedGroupDef',
    inputs: [{ name: 'ticket', seedOwed: false }],
    steps: [
      {
        name: 'triage',
        consumes: ['ticket'],
        produces: [
          'simple',
          { name: 'urgent', judges: [{ name: 'sanity', body: 'check it' }] },
          { group: 'route', mode: 'exactlyOne', of: ['simple', 'urgent'] },
        ],
      },
      { name: 'handleSimple', consumes: ['simple'], produces: ['simpleDone'] },
    ],
  });
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('judgedGroupDef', { provide: { ticket: { text: 'x' } } });

  const triageRun = fire(engine, wf, 'triage').run;
  // 'urgent' producer commit lands 'submitted' (judges gate the actual green,
  // not the producer commit) — no winner exists yet, so its judge order is
  // legitimately offered and claimed here (a real in-flight run).
  const submitRes = engine.green(wf, triageRun, 'urgent', { ok: true });
  assert.equal(submitRes.outcome, 'submitted');
  const judgeOrder = fire(engine, wf, 'triage.urgent.judges.sanity');

  // NOW 'simple' wins, while the judge run above is already in-flight — this
  // models the real race the group-aware eligibility filter cannot prevent
  // (the order was claimed before the winner landed). §26.2's auto-skip now
  // also covers a still-`submitted` sibling, so 'urgent' auto-skips in this
  // very same settle (engine.close's cascade) rather than staying wedged in
  // 'submitted'. The judge's eventual approve is still refused — no longer by
  // groupCasCheck's group check (the artifact isn't `submitted` anymore to
  // even reach it) but by the ordinary stale-run/acceptance-mismatch guard
  // (`born-rejected`). Either refusal path is correct; what matters is
  // 'urgent' never flips to green.
  engine.green(wf, triageRun, 'simple', { ok: true });
  assert.equal(getArt(store, wf, 'simple')?.acceptance, 'green');
  engine.close(wf, triageRun);
  assert.equal(getArt(store, wf, 'urgent')?.acceptance, 'skipped', 'urgent auto-skips in the same settle as the winner');

  // the judge fires and approves — this must still be refused, now via
  // born-rejected (acceptance no longer submitted) rather than group-rejected.
  const judgeRes = engine.green(wf, judgeOrder.run, 'urgent', {});
  assert.equal(judgeRes.outcome, 'born-rejected');
  assert.equal(getArt(store, wf, 'urgent')?.acceptance, 'skipped', 'urgent must remain skipped, not flip to green');
});

// ---- (f3) §26.2: a submitted sibling still awaiting judgment auto-skips too ----

test('groups: (f3) a submitted (judge-pending) losing sibling is auto-skipped by the same settle as the winner, reaching done', () => {
  const d = buildDef({
    name: 'judgedGroupDef4',
    inputs: [{ name: 'ticket', seedOwed: false }],
    steps: [
      {
        name: 'triage',
        consumes: ['ticket'],
        produces: [
          'simple',
          { name: 'urgent', judges: [{ name: 'sanity', body: 'check it' }] },
          { group: 'route', mode: 'exactlyOne', of: ['simple', 'urgent'] },
        ],
      },
      { name: 'handleSimple', consumes: ['simple'], produces: ['simpleDone'] },
    ],
  });
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('judgedGroupDef4', { provide: { ticket: { text: 'x' } } });

  const triageRun = fire(engine, wf, 'triage').run;
  // 'urgent' lands 'submitted' first (still awaiting its judge's verdict) —
  // no winner exists yet.
  const submitRes = engine.green(wf, triageRun, 'urgent', { ok: true });
  assert.equal(submitRes.outcome, 'submitted');
  assert.equal(getArt(store, wf, 'urgent')?.acceptance, 'submitted');

  // NOW 'simple' wins — this settle must auto-skip the still-submitted 'urgent'
  // sibling in the SAME settle as the winner's commit (§26.2), not leave it
  // wedged in 'submitted' forever (an OUTSTANDING state the old owed/rejected
  // -only guard could never resolve).
  engine.green(wf, triageRun, 'simple', { ok: true });
  engine.close(wf, triageRun);

  assert.equal(getArt(store, wf, 'urgent')?.acceptance, 'skipped', 'submitted loser must auto-skip, not stay wedged');
  const lastReason = getArt(store, wf, 'urgent')?.reasons.slice(-1)[0];
  assert.equal(lastReason?.action, 'skip');
  assert.equal(lastReason?.kind, 'exclusive');

  // no judge order for the now-skipped sibling is ever offered again — this
  // same tick also claims the still-outstanding handleSimple order, so grab
  // it here rather than ticking again (a second tick would see nothing new,
  // since the run claimed on this tick is already in-flight).
  const t = engine.tick(wf);
  assert.ok(t.orders.every((o) => o.step !== 'triage.urgent.judges.sanity'));

  // and the workflow reaches done: true once the remaining debt (handleSimple) settles
  assert.equal(engine.status(wf).done, false, 'handleSimple has not fired yet');
  const handleOrder = t.orders.find((o) => o.step === 'handleSimple');
  assert.ok(handleOrder, 'expected a handleSimple order on this tick');
  const handleRun = handleOrder!.run;
  engine.green(wf, handleRun, 'simpleDone', { ok: true });
  engine.close(wf, handleRun);
  assert.equal(engine.status(wf).done, true);
});

// ---- (f4) §26.2 + §16.1: winner later un-greened → skipped ex-submitted sibling
//           re-arms with a CLEAN approvals ledger (no stale partial sign-off leak) ----

test('groups: (f4) rejecting the winner re-arms the ex-submitted skipped sibling with approvals cleared', () => {
  const d = buildDef({
    name: 'judgedGroupDef5',
    inputs: [{ name: 'ticket', seedOwed: false }],
    steps: [
      {
        name: 'triage',
        consumes: ['ticket'],
        produces: [
          'simple',
          {
            name: 'urgent',
            judges: [
              { name: 'first', body: 'check one' },
              { name: 'second', body: 'check two' },
            ],
          },
          { group: 'route', mode: 'exactlyOne', of: ['simple', 'urgent'] },
        ],
      },
    ],
  });
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('judgedGroupDef5', { provide: { ticket: { text: 'x' } } });

  const triageRun = fire(engine, wf, 'triage').run;
  const submitRes = engine.green(wf, triageRun, 'urgent', { ok: true });
  assert.equal(submitRes.outcome, 'submitted');

  // both of urgent's judges become eligible in parallel (judges are not
  // sequenced — each independently fires once 'urgent' is submitted) — the
  // same tick claims both orders, so grab both here rather than calling
  // fire() a second time (which would see nothing new: the first call's tick
  // already claimed both as in-flight runs).
  let t = engine.tick(wf, { now: Date.now() });
  const firstJudgeOrder = t.orders.find((o) => o.step === 'triage.urgent.judges.first')!;
  const secondJudgeOrderEarly = t.orders.find((o) => o.step === 'triage.urgent.judges.second')!;
  assert.ok(firstJudgeOrder && secondJudgeOrderEarly, 'expected both judge orders on this tick');

  // only 'first' signs off — a partial approvals ledger entry is now recorded
  // on the still-submitted artifact. Close 'second's run unresolved (it never
  // approves before the skip lands) so it does not linger in-flight forever.
  const partialRes = engine.green(wf, firstJudgeOrder.run, 'urgent', {});
  assert.equal(partialRes.outcome, 'approved');
  engine.close(wf, firstJudgeOrder.run);
  engine.close(wf, secondJudgeOrderEarly.run);
  const beforeSkip = getArt(store, wf, 'urgent');
  assert.equal(beforeSkip?.acceptance, 'submitted');
  assert.ok(beforeSkip?.approvals && Object.keys(beforeSkip.approvals).length > 0, 'partial sign-off recorded');

  // 'simple' now wins — this settle must auto-skip 'urgent' (still submitted,
  // with the partial approvals ledger) and, per §26.2, clear that ledger so a
  // later resubmission never inherits the stale partial sign-off.
  engine.green(wf, triageRun, 'simple', { ok: true });
  engine.close(wf, triageRun);

  const skipped = getArt(store, wf, 'urgent');
  assert.equal(skipped?.acceptance, 'skipped');
  assert.equal(skipped?.approvals, undefined, 'approvals must be cleared on the skipped ex-submitted artifact');

  // the winner is later rejected — 'ticket' itself never moves (only 'simple'
  // does), so the fingerprint-gated §16.1 rearm loop does not flip 'urgent'
  // to 'owed' by itself (mirrors (e): the sibling stays exactly as settle left
  // it — skipped, approvals-clean — until re-triage directly re-produces it).
  // Re-triage fires because the now-rejected 'simple' is once again a debt.
  engine.reject(wf, 'simple', 'human', 're-triage: now urgent');
  t = engine.tick(wf, { now: Date.now() });
  const triageRun2 = t.orders.find((o) => o.step === 'triage')!.run;

  const beforeResubmit = getArt(store, wf, 'urgent');
  assert.equal(beforeResubmit?.acceptance, 'skipped');
  assert.equal(beforeResubmit?.approvals, undefined, 'skipped artifact must still have a clean approvals ledger');

  const resubmitRes = engine.green(wf, triageRun2, 'urgent', { ok: true });
  assert.equal(resubmitRes.outcome, 'submitted');
  assert.equal(getArt(store, wf, 'urgent')?.approvals, undefined, 'resubmission starts with no approvals');
  engine.close(wf, triageRun2);

  // both judges must sign off again — the old partial sign-off from before the
  // skip is gone, not silently satisfying the 'first' judge a second time.
  // Same as above: both judges are eligible in parallel on one tick.
  t = engine.tick(wf, { now: Date.now() });
  const firstJudgeOrder2 = t.orders.find((o) => o.step === 'triage.urgent.judges.first')!;
  const secondJudgeOrder2 = t.orders.find((o) => o.step === 'triage.urgent.judges.second')!;
  assert.ok(firstJudgeOrder2 && secondJudgeOrder2, 'expected both judge orders on this tick');

  const firstRes2 = engine.green(wf, firstJudgeOrder2.run, 'urgent', {});
  assert.equal(firstRes2.outcome, 'approved');
  const secondRes2 = engine.green(wf, secondJudgeOrder2.run, 'urgent', {});
  assert.equal(secondRes2.outcome, 'green');
  assert.equal(getArt(store, wf, 'urgent')?.acceptance, 'green');
});

// ---- (f2) eligibility never offers a NEW judge order once a winner already exists --

test('groups: (f2) eligibleFirings never offers a fresh judge order for a group-blocked submitted sibling', () => {
  const d = buildDef({
    name: 'judgedGroupDef2',
    inputs: [{ name: 'ticket', seedOwed: false }],
    steps: [
      {
        name: 'triage',
        consumes: ['ticket'],
        produces: [
          'simple',
          { name: 'urgent', judges: [{ name: 'sanity', body: 'check it' }] },
          { group: 'route', mode: 'exactlyOne', of: ['simple', 'urgent'] },
        ],
      },
    ],
  });
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('judgedGroupDef2', { provide: { ticket: { text: 'x' } } });

  const triageRun = fire(engine, wf, 'triage').run;
  // 'simple' wins first, 'urgent' submits afterward — the winner already exists
  // by the time urgent's judge would become eligible.
  engine.green(wf, triageRun, 'simple', { ok: true });
  const submitRes = engine.green(wf, triageRun, 'urgent', { ok: true });
  assert.equal(submitRes.outcome, 'submitted');
  engine.close(wf, triageRun);

  // §26.2: 'urgent' auto-skips in the very same settle (engine.close's cascade)
  // that lands 'simple' as the winner, since a submitted sibling is now
  // covered by the auto-skip guard — it never survives to be independently
  // suppressed by eligibleFirings.
  assert.equal(getArt(store, wf, 'urgent')?.acceptance, 'skipped');

  // Before the fix, this tick would dispatch a judge order doomed to
  // group-reject (a wasted subagent spawn). After the fix, there is no judge
  // order because the sibling is already skipped.
  const t = engine.tick(wf);
  assert.ok(t.orders.every((o) => o.step !== 'triage.urgent.judges.sanity'));
});

// ---- (g) checker exploration: modelCheck explores group-reject/auto-skip -------

test('groups: (g) modelCheck reports the router def as completable and dead-end free', () => {
  const d = routerDef('exactlyOne');
  const report = modelCheck(d, { maxDepth: 12, maxStates: 2000 });
  assert.ok(report.stats.statesExplored > 0);
  // The router always reaches done: whichever sibling wins, the other auto-skips
  // and its dead-branch handler never fires — the checker must find this reachable.
  assert.equal(report.completable, true, JSON.stringify(report, null, 2));
  assert.deepEqual(report.deadlocks, []);
});

// ---- (h) differential conformance: group-reject refusal matches the real engine --

test('groups: (h) conformance — a losing-sibling commit is refused identically in engine and checker', () => {
  const d = routerDef('exactlyOne');

  // Engine side
  const { engine } = makeEngine([d]);
  const wf = engine.createInstance('routerDef', { provide: { ticket: { text: 'x' } } });
  const triageRun = fire(engine, wf, 'triage').run;
  engine.green(wf, triageRun, 'simple', { ok: true });
  const engineRefusal = engine.green(wf, triageRun, 'urgent', { ok: true });
  assert.equal(engineRefusal.outcome, 'group-rejected');
  engine.close(wf, triageRun);

  // In-memory (checker) side — mirror the same firing sequence
  let memMap = new Map<string, ArtifactData>();
  memMap.set('ticket', {
    workflow: '',
    path: 'ticket',
    producer: 'human',
    acceptance: 'owed',
    version: 0,
    reasons: [],
    judgmentRejects: 0,
    schemaRejects: 0,
  });
  memMap = settleInMemory(d, memMap);
  memMap.set('ticket', { ...memMap.get('ticket')!, acceptance: 'green', version: 1 });
  memMap = settleInMemory(d, memMap);

  const triageFirings1 = eligibleFirings(d, memMap);
  const triageFiring1 = triageFirings1.find((f) => f.step === 'triage' && f.outputs.includes('simple'));
  assert.ok(triageFiring1, 'expected a triage firing targeting simple');
  memMap = applyOutcome(d, memMap, { ...triageFiring1!, outputs: ['simple'] }, 'green', { maxCollectionSize: 2 })[0]!;
  assert.equal(memMap.get('simple')?.acceptance, 'green');

  // Now the sibling: eligibleOutcomes must offer 'group-reject' (not 'green') for urgent
  const triageFirings2 = eligibleFirings(d, memMap);
  const triageFiring2 = triageFirings2.find((f) => f.step === 'triage' && f.outputs.includes('urgent'));
  // urgent should have auto-skipped by now (mirrors the engine's cascade) — so there
  // should be no eligible firing targeting it at all, matching the engine's post-close state.
  assert.equal(triageFiring2, undefined, 'urgent should already be auto-skipped, not re-eligible');
  assert.equal(memMap.get('urgent')?.acceptance, 'skipped');
});

// ---- (h2) differential conformance: a SUBMITTED losing sibling auto-skips
//           identically in engine and checker, with approvals cleared on both ----

test('groups: (h2) conformance — a submitted (judge-pending) losing sibling auto-skips identically in engine and checker, approvals cleared on both', () => {
  const d = buildDef({
    name: 'judgedConformanceDef',
    inputs: [{ name: 'ticket', seedOwed: false }],
    steps: [
      {
        name: 'triage',
        consumes: ['ticket'],
        produces: [
          'simple',
          { name: 'urgent', judges: [{ name: 'sanity', body: 'check it' }] },
          { group: 'route', mode: 'exactlyOne', of: ['simple', 'urgent'] },
        ],
      },
    ],
  });

  // Engine side: 'urgent' submits (still awaiting its judge), then 'simple' wins.
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('judgedConformanceDef', { provide: { ticket: { text: 'x' } } });
  const triageRun = fire(engine, wf, 'triage').run;
  const submitRes = engine.green(wf, triageRun, 'urgent', { ok: true });
  assert.equal(submitRes.outcome, 'submitted');
  engine.green(wf, triageRun, 'simple', { ok: true });
  engine.close(wf, triageRun);
  const engineUrgent = getArt(store, wf, 'urgent');
  assert.equal(engineUrgent?.acceptance, 'skipped');
  assert.equal(engineUrgent?.approvals, undefined);

  // In-memory (checker) side — mirror the same firing sequence via
  // eligibleFirings/applyOutcome/settleInMemory, exactly like (h).
  let memMap = new Map<string, ArtifactData>();
  memMap.set('ticket', {
    workflow: '',
    path: 'ticket',
    producer: 'human',
    acceptance: 'owed',
    version: 0,
    reasons: [],
    judgmentRejects: 0,
    schemaRejects: 0,
  });
  memMap = settleInMemory(d, memMap);
  memMap.set('ticket', { ...memMap.get('ticket')!, acceptance: 'green', version: 1 });
  memMap = settleInMemory(d, memMap);

  const triageFirings1 = eligibleFirings(d, memMap);
  const urgentFiring = triageFirings1.find((f) => f.step === 'triage' && f.outputs.includes('urgent'));
  assert.ok(urgentFiring, 'expected a triage firing targeting urgent');
  memMap = applyOutcome(d, memMap, { ...urgentFiring!, outputs: ['urgent'] }, 'green', { maxCollectionSize: 2 })[0]!;
  assert.equal(memMap.get('urgent')?.acceptance, 'submitted', 'urgent should be submitted, awaiting its judge');

  const triageFirings2 = eligibleFirings(d, memMap);
  const simpleFiring = triageFirings2.find((f) => f.step === 'triage' && f.outputs.includes('simple'));
  assert.ok(simpleFiring, 'expected a triage firing targeting simple');
  memMap = applyOutcome(d, memMap, { ...simpleFiring!, outputs: ['simple'] }, 'green', { maxCollectionSize: 2 })[0]!;
  assert.equal(memMap.get('simple')?.acceptance, 'green');

  // urgent must now match the engine: auto-skipped, approvals cleared, no
  // eligible firing remains for it.
  const triageFirings3 = eligibleFirings(d, memMap);
  const urgentFiring3 = triageFirings3.find((f) => f.step === 'triage' && f.outputs.includes('urgent'));
  assert.equal(urgentFiring3, undefined, 'submitted urgent should already be auto-skipped, not re-eligible');
  const memUrgent = memMap.get('urgent');
  assert.equal(memUrgent?.acceptance, 'skipped');
  assert.equal(memUrgent?.approvals, undefined);
});

// ---- (i) human retry does not bypass group suppression -------------------------

test('groups: (i) a human retry of a group-blocked judged sibling is still suppressed until the winner is knocked down', () => {
  // Same shape as scenario (f): simple/urgent exactlyOne, urgent gated by a judge.
  const d = buildDef({
    name: 'judgedGroupDef3',
    inputs: [{ name: 'ticket', seedOwed: false }],
    steps: [
      {
        name: 'triage',
        consumes: ['ticket'],
        produces: [
          'simple',
          { name: 'urgent', judges: [{ name: 'sanity', body: 'check it' }] },
          { group: 'route', mode: 'exactlyOne', of: ['simple', 'urgent'] },
        ],
      },
    ],
  });
  const { engine, store } = makeEngine([d]);
  const wf = engine.createInstance('judgedGroupDef3', { provide: { ticket: { text: 'x' } } });

  const triageRun = fire(engine, wf, 'triage').run;
  engine.green(wf, triageRun, 'simple', { ok: true }); // simple wins
  const submitRes = engine.green(wf, triageRun, 'urgent', { ok: true }); // urgent -> submitted
  assert.equal(submitRes.outcome, 'submitted');
  engine.close(wf, triageRun);

  // Before the fix: this tick would still offer a judge order for urgent's
  // judge (wasted spawn, doomed to group-reject). After the fix: suppressed.
  let t = engine.tick(wf);
  assert.ok(t.orders.every((o) => o.step !== 'triage.urgent.judges.sanity'));

  // A human retry re-arms urgent to 'owed' — but the winner (simple) is still
  // green, so maintainDecisions' own auto-skip cascade (run synchronously
  // inside retry's settle()) immediately auto-skips it right back. Retry is
  // not a bypass of group exclusivity in either the auto-skip layer or the
  // eligibility layer this plan adds.
  engine.retry(wf, 'urgent', 'human', 'force re-judge');
  assert.equal(store.getArtifact(wf, 'urgent')?.acceptance, 'skipped');
  t = engine.tick(wf);
  assert.ok(
    t.orders.every((o) => o.step !== 'triage.urgent.judges.sanity'),
    'retry does not bypass group suppression while a winner is green',
  );

  // Knock the winner down — the real, documented lever: un-green the winner,
  // not a retry bypass. 'urgent' stays skipped (its own required inputs never
  // moved), but 'triage' becomes eligible again since 'simple' is no longer a
  // group-blocking winner — the next tick re-fires triage itself.
  engine.reject(wf, 'simple', 'human', 're-triage');
  t = engine.tick(wf);
  assert.ok(t.orders.some((o) => o.step === 'triage'));
});

// ---- (j)-(l): eligibleFirings pre-filter, exercised directly (pure function) ----

test('groups: (j) eligibleFirings itself excludes a group-blocked owed sibling, independent of auto-skip', () => {
  const d = routerDef('exactlyOne');
  const arts = new Map<string, ArtifactData>();
  arts.set('ticket', { workflow: '', path: 'ticket', producer: 'human', acceptance: 'green', version: 1, reasons: [], judgmentRejects: 0, schemaRejects: 0 });
  arts.set('simple', { workflow: '', path: 'simple', producer: 'triage', acceptance: 'green', version: 1, reasons: [], judgmentRejects: 0, schemaRejects: 0 });
  arts.set('urgent', { workflow: '', path: 'urgent', producer: 'triage', acceptance: 'owed', version: 0, reasons: [], judgmentRejects: 0, schemaRejects: 0 });
  const firings = eligibleFirings(d, arts);
  // triage's own outputs filter must exclude 'urgent' — it is group-blocked by 'simple'.
  const triageFiring = firings.find((f) => f.step === 'triage');
  assert.ok(!triageFiring || !triageFiring.outputs.includes('urgent'));
});

test('groups: (k) atLeastOne group never suppresses (regression)', () => {
  const d = routerDef('atLeastOne');
  const arts = new Map<string, ArtifactData>();
  arts.set('ticket', { workflow: '', path: 'ticket', producer: 'human', acceptance: 'green', version: 1, reasons: [], judgmentRejects: 0, schemaRejects: 0 });
  arts.set('simple', { workflow: '', path: 'simple', producer: 'triage', acceptance: 'green', version: 1, reasons: [], judgmentRejects: 0, schemaRejects: 0 });
  arts.set('urgent', { workflow: '', path: 'urgent', producer: 'triage', acceptance: 'owed', version: 0, reasons: [], judgmentRejects: 0, schemaRejects: 0 });
  const firings = eligibleFirings(d, arts);
  const triageFiring = firings.find((f) => f.step === 'triage');
  assert.ok(triageFiring, 'atLeastOne must still offer urgent');
  assert.ok(triageFiring!.outputs.includes('urgent'));
});

test('groups: (l) no winner yet — no suppression (regression)', () => {
  const d = routerDef('exactlyOne');
  const arts = new Map<string, ArtifactData>();
  arts.set('ticket', { workflow: '', path: 'ticket', producer: 'human', acceptance: 'green', version: 1, reasons: [], judgmentRejects: 0, schemaRejects: 0 });
  arts.set('simple', { workflow: '', path: 'simple', producer: 'triage', acceptance: 'owed', version: 0, reasons: [], judgmentRejects: 0, schemaRejects: 0 });
  arts.set('urgent', { workflow: '', path: 'urgent', producer: 'triage', acceptance: 'owed', version: 0, reasons: [], judgmentRejects: 0, schemaRejects: 0 });
  const firings = eligibleFirings(d, arts);
  const triageFiring = firings.find((f) => f.step === 'triage');
  assert.ok(triageFiring, 'no winner yet — both siblings still offered');
  assert.ok(triageFiring!.outputs.includes('simple'));
  assert.ok(triageFiring!.outputs.includes('urgent'));
});

// ---- validation: group grammar rejections (mirrors §24 J24-VALIDATE tests) -----

test('groups: buildDef rejects an unknown mode', () => {
  assert.throws(
    () =>
      buildDef({
        name: 'bad',
        inputs: [{ name: 'a' }],
        steps: [
          {
            name: 'triage',
            consumes: ['a'],
            produces: ['simple', 'urgent', { group: 'route', mode: 'onlyOne', of: ['simple', 'urgent'] }],
          },
        ],
      }),
    /mode must be one of exactlyOne, atMostOne, atLeastOne/,
  );
});

test('validateDef rejects a group with fewer than two members', () => {
  const d = buildDef({
    name: 'bad',
    inputs: [{ name: 'a' }],
    steps: [
      {
        name: 'triage',
        consumes: ['a'],
        produces: ['simple', { group: 'route', mode: 'exactlyOne', of: ['simple'] }],
      },
    ],
  });
  const errors = validateDef(d);
  assert.ok(errors.some((e) => e.includes('needs at least two members')), errors.join('; '));
});

test('validateDef rejects a group naming a stem this step does not produce', () => {
  const d = buildDef({
    name: 'bad',
    inputs: [{ name: 'a' }],
    steps: [
      {
        name: 'triage',
        consumes: ['a'],
        produces: ['simple', { group: 'route', mode: 'exactlyOne', of: ['simple', 'ghost'] }],
      },
    ],
  });
  const errors = validateDef(d);
  assert.ok(errors.some((e) => e.includes("names 'ghost' in of: but this step does not produce it")), errors.join('; '));
});

test('validateDef rejects a group member that is a collection produce', () => {
  const d = buildDef({
    name: 'bad',
    inputs: [{ name: 'a' }],
    steps: [
      {
        name: 'gatherer',
        consumes: ['a'],
        produces: ['simple', 'items[]', { group: 'route', mode: 'exactlyOne', of: ['simple', 'items'] }],
      },
    ],
  });
  const errors = validateDef(d);
  assert.ok(
    errors.some((e) => e.includes("member 'items' is a collection produce; group membership is singleton-only")),
    errors.join('; '),
  );
});

test('validateDef rejects a group with an empty of: list', () => {
  const d = buildDef({
    name: 'bad',
    inputs: [{ name: 'a' }],
    steps: [
      {
        name: 'triage',
        consumes: ['a'],
        produces: ['simple', { group: 'route', mode: 'exactlyOne', of: [] }],
      },
    ],
  });
  const errors = validateDef(d);
  assert.ok(errors.some((e) => e.includes('needs at least two members')), errors.join('; '));
});

test('validateDef rejects a group naming a stem produced by a DIFFERENT step (not this one)', () => {
  const d = buildDef({
    name: 'bad',
    inputs: [{ name: 'a' }],
    steps: [
      {
        name: 'triage',
        consumes: ['a'],
        produces: ['simple', { group: 'route', mode: 'exactlyOne', of: ['simple', 'elsewhere'] }],
      },
      { name: 'other', consumes: ['a'], produces: ['elsewhere'] },
    ],
  });
  const errors = validateDef(d);
  // Same error family as "not produced at all" — group membership is scoped to
  // THIS step's own produces list, so a stem owned by a sibling step in the
  // def is indistinguishable from a stem that doesn't exist anywhere.
  assert.ok(
    errors.some((e) => e.includes("names 'elsewhere' in of: but this step does not produce it")),
    errors.join('; '),
  );
});

test('validateDef allows two groups on one step with disjoint members', () => {
  const d = buildDef({
    name: 'ok',
    inputs: [{ name: 'a' }],
    steps: [
      {
        name: 'triage',
        consumes: ['a'],
        produces: [
          'simple',
          'urgent',
          'lowPriority',
          'highPriority',
          { group: 'severity', mode: 'exactlyOne', of: ['simple', 'urgent'] },
          { group: 'priority', mode: 'exactlyOne', of: ['lowPriority', 'highPriority'] },
        ],
      },
    ],
  });
  const errors = validateDef(d);
  assert.deepEqual(errors, []);
  const triage = d.steps.find((s) => s.name === 'triage')!;
  assert.equal(triage.groups?.length, 2);
});

test('validateDef rejects a stem claimed by two different groups on the same step', () => {
  const d = buildDef({
    name: 'bad',
    inputs: [{ name: 'a' }],
    steps: [
      {
        name: 'triage',
        consumes: ['a'],
        produces: [
          'simple',
          'urgent',
          'critical',
          { group: 'g1', mode: 'exactlyOne', of: ['simple', 'urgent'] },
          { group: 'g2', mode: 'exactlyOne', of: ['simple', 'critical'] },
        ],
      },
    ],
  });
  const errors = validateDef(d);
  assert.ok(errors.some((e) => e.includes("stem 'simple' is claimed by more than one group")), errors.join('; '));
});

test('buildDef rejects group: declared on a calls: step\'s produces', () => {
  assert.throws(
    () =>
      buildDef({
        name: 'bad',
        inputs: [{ name: 'a' }],
        steps: [
          {
            name: 'delegator',
            calls: 'child',
            produces: ['out', { group: 'route', mode: 'exactlyOne', of: ['out', 'other'] }],
          },
        ],
      }),
    /group: is not supported on a calls: step's produces/,
  );
});

test('buildDef rejects group: declared on a generates: entry', () => {
  assert.throws(
    () =>
      buildDef({
        name: 'bad',
        inputs: [{ name: 'a' }],
        steps: [
          {
            name: 'x',
            consumes: ['a'],
            produces: ['plan'],
            generates: ['side1', 'side2', { group: 'route', mode: 'exactlyOne', of: ['side1', 'side2'] }],
          },
        ],
      }),
    /group: is not supported on a generates: entry/,
  );
});
