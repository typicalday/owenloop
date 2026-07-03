/**
 * Edge-case end-to-end battery.
 *
 * Where e2e.test.ts walks the two happy paths, this file hammers the corners the
 * design spec is most particular about — the ones that are easy to get subtly
 * wrong and would rot silently: the level-triggered cascade, terminal completion,
 * empty / fully-retracted collections, the commit CAS (born-rejected), the
 * reaper + zombie-commit guard, cadence / daily-budget gating, skip routing, and
 * the authority / lifecycle invariants. Every test drives the real binary as a
 * subprocess against real SQLite — argv → JSON → store → JSON.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'owenloop.mjs');
const EXAMPLES = join(ROOT, 'examples', 'workflows');
const FIXTURES = join(ROOT, 'test', 'fixtures');

/** A throwing CLI bound to a fresh temp db + a defs dir, plus `.raw` for error paths. */
function harness(defsDir: string = EXAMPLES) {
  const db = join(mkdtempSync(join(tmpdir(), 'owenloop-edge-')), 'state.db');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [BIN, ...args, '--db', db, '--defs', defsDir], { encoding: 'utf8' });
  const ow = (...args: string[]): any => {
    const r = run(...args);
    if (r.status !== 0) throw new Error(`owenloop ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : null;
  };
  // owAny: like ow but tolerates a non-zero exit. stdout is always JSON (the
  // engine always prints the result before checking outcome); stderr carries the
  // human-readable reason when exit is non-zero. Returns parsed JSON from stdout.
  ow.any = (...args: string[]): any => {
    const r = run(...args);
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : null;
  };
  ow.raw = (...args: string[]) => run(...args);
  ow.cleanup = () => rmSync(dirname(db), { recursive: true, force: true });
  return ow;
}

const J = (v: unknown) => JSON.stringify(v);

/** Tick once and return the (first) order for `step`, asserting it exists. */
function claim(ow: any, wf: string, step: string): any {
  const t = ow('tick', wf);
  const o = t.orders.find((x: any) => x.step === step);
  assert.ok(o, `expected an order for '${step}', got: [${t.orders.map((x: any) => x.step).join(', ')}]`);
  return o;
}

/** Drive delivery up to (but not including) the merge; returns the workflow id. */
function deliverToMerge(ow: any): string {
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  let o = claim(ow, wf, 'planner');
  ow('green', wf, o.run, 'plan', '--value', J({ plan: 'v1' }));
  ow('close', wf, o.run);
  o = claim(ow, wf, 'builder');
  ow('green', wf, o.run, 'pr', '--value', J({ pr: '#1' }));
  ow('close', wf, o.run);
  o = claim(ow, wf, 'reviewer');
  ow('green', wf, o.run, 'verdict', '--value', J({ ok: true }));
  ow('close', wf, o.run);
  return wf;
}

const arts = (ow: any, wf: string) => ow('show', wf) as any[];
const art = (ow: any, wf: string, path: string) => arts(ow, wf).find((a) => a.path === path);

// ============================================================================
// A. Forward cascade & terminal completion (§7, §11.8, §15.2)
// ============================================================================

test('cascade: re-planning forward-invalidates the whole downstream chain (structural)', () => {
  const ow = harness();
  const wf = deliverToMerge(ow); // plan, pr, verdict all green; merge not yet made

  // the builder consumes `plan`, so it has authority to invalidate it
  ow('reject', wf, 'plan', '--by', 'builder', '--text', 'wrong approach');

  const st = ow('status', wf);
  assert.equal(st.done, false);
  const byPath = Object.fromEntries(st.debts.map((d: any) => [d.path, d]));
  assert.equal(byPath['plan'].kind, 'judgment', 'the explicit reject is a judgment');
  assert.equal(byPath['pr'].kind, 'structural', 'pr fell back via the cascade');
  assert.equal(byPath['verdict'].kind, 'structural', 'verdict fell back transitively');
  assert.match(byPath['pr'].reason, /plan/, 'the structural reason names the cause');
  // value is KEPT as context for the redo, not deleted (§11.8)
  assert.deepEqual(art(ow, wf, 'pr').value, { pr: '#1' });
  ow.cleanup();
});

test('terminal: a merged (terminal) output survives an upstream reject; the rest re-derives', () => {
  const ow = harness();
  const wf = deliverToMerge(ow);
  const o = claim(ow, wf, 'merger');
  assert.equal(ow('green', wf, o.run, 'merge', '--value', J({ sha: 'abc' }), '--terminal').outcome, 'green');
  ow('close', wf, o.run);
  assert.equal(ow('status', wf).done, true);

  // now re-judge the plan: the cascade re-arms pr/verdict but MUST NOT cross the
  // terminal merge boundary (§15.2) — its inputs no longer exist to re-derive from
  ow('reject', wf, 'plan', '--by', 'builder', '--text', 'second thoughts');

  const merge = art(ow, wf, 'merge');
  assert.equal(merge.acceptance, 'green', 'terminal merge stays green');
  assert.equal(merge.terminal, true);
  const st = ow('status', wf);
  assert.equal(st.done, false, 'the non-terminal upstream re-opened');
  assert.ok(!st.debts.some((d: any) => d.path === 'merge'), 'merge is not a debt');
  ow.cleanup();
});

// ============================================================================
// B. Collections: empty / fully-retracted / retract-after-green / blocking (§11)
// ============================================================================

// Bare-member reduce semantics (gates on members, not verdicts) — the shipped
// `research` example moved to a suffixed reduce (`gather.source[*].verdict`);
// this battery drives `test/fixtures/reduce.yaml`, which keeps the bare-reduce
// shape research.yaml used to have. Callers must use `harness(FIXTURES)`.
function startResearch(ow: any): string {
  return ow('create', 'reduce', '--provide', `question=${J({ q: 'why' })}`).workflow;
}

test('collection: an EMPTY sealed collection still reduces (the engine never counts §11.5)', () => {
  const ow = harness(FIXTURES);
  const wf = startResearch(ow);
  const g = claim(ow, wf, 'gather');
  ow('seal', wf, g.run); // seal with ZERO emitted members
  ow('close', wf, g.run);

  // synth reduces over the empty live set; "enough" is the producer's call, not the engine's
  const s = claim(ow, wf, 'synth');
  assert.ok(!Object.keys(s.consumes).some((k) => /\[\d+\]/.test(k)), 'no member elements — the reduce rests only on the seal');
  assert.equal(ow('green', wf, s.run, 'draft', '--value', J({ answer: 'none found' })).outcome, 'green');
  ow('close', wf, s.run);
  assert.equal(ow('status', wf).done, true);
  ow.cleanup();
});

test('collection: a fully-retracted collection reduces over the survivors (empty set)', () => {
  const ow = harness(FIXTURES);
  const wf = startResearch(ow);
  const g = claim(ow, wf, 'gather');
  ow('emit', wf, g.run, '--items', J([{ url: 'a' }, { url: 'b' }]));
  ow('seal', wf, g.run);
  ow('close', wf, g.run);

  ow('retract', wf, 'gather.source[0]', '--by', 'check', '--text', 'bad');
  ow('retract', wf, 'gather.source[1]', '--by', 'check', '--text', 'bad');

  const s = claim(ow, wf, 'synth');
  assert.ok(!Object.keys(s.consumes).some((k) => /\[\d+\]/.test(k)), 'all members retracted → reduce rests only on the seal');
  ow('green', wf, s.run, 'draft', '--value', J({ answer: 'empty' }));
  ow('close', wf, s.run);
  const st = ow('status', wf);
  assert.equal(st.done, true);
  // retracted members are settled — they NEVER show as debts (§17)
  assert.ok(!st.debts.some((d: any) => d.path.startsWith('gather.source')));
  ow.cleanup();
});

test('collection: retract-after-green tombstones the element and re-derives the draft', () => {
  const ow = harness(FIXTURES);
  const wf = startResearch(ow);
  let g = claim(ow, wf, 'gather');
  ow('emit', wf, g.run, '--items', J([{ url: 'a' }, { url: 'b' }]));
  ow('seal', wf, g.run);
  ow('close', wf, g.run);

  // members are born green on emit, so ONE tick claims the per-element checks AND
  // the reduce together — take the synth order from that same tick, don't re-tick
  const t = ow('tick', wf);
  for (const c of t.orders.filter((x: any) => x.step === 'check')) {
    ow('green', wf, c.run, c.outputs[0], '--value', J({ ok: true }));
    ow('close', wf, c.run);
  }
  const s = t.orders.find((x: any) => x.step === 'synth');
  assert.ok(s, 'synth is eligible the instant the collection is sealed');
  ow('green', wf, s.run, 'draft', '--value', J({ from: 'a+b' }));
  ow('close', wf, s.run);
  assert.equal(ow('status', wf).done, true);

  // now retract a GREEN member: it tombstones, and the draft auto-rejects (kept) to re-derive
  ow('retract', wf, 'gather.source[0]', '--by', 'check', '--text', 'retracted after the fact');
  assert.equal(art(ow, wf, 'gather.source[0]').acceptance, 'retracted');
  const draft = art(ow, wf, 'draft');
  assert.equal(draft.acceptance, 'rejected', 'draft fell back to a debt');
  assert.deepEqual(draft.value, { from: 'a+b' }, 'old draft kept as context for the redo');

  // a fresh reduce over the single survivor greens cleanly
  const s2 = claim(ow, wf, 'synth');
  const members = Object.keys(s2.consumes).filter((k) => /\[\d+\]/.test(k));
  assert.deepEqual(members, ['gather.source[1]'], 'only the survivor remains in the reduce');
  ow('green', wf, s2.run, 'draft', '--value', J({ from: 'b' }));
  ow('close', wf, s2.run);
  assert.equal(ow('status', wf).done, true);
  ow.cleanup();
});

test('collection: a REJECTED (non-retracted) member blocks the reduce; retracting it unblocks', () => {
  const ow = harness(FIXTURES);
  const wf = startResearch(ow);
  const g = claim(ow, wf, 'gather');
  ow('emit', wf, g.run, '--items', J([{ url: 'a' }, { url: 'b' }]));
  ow('seal', wf, g.run);
  ow('close', wf, g.run);

  // reject member 1 (judgment) — it is a declared debt, so synth must NOT be eligible
  ow('reject', wf, 'gather.source[1]', '--by', 'check', '--text', 'looks wrong');
  assert.ok(!ow('tick', wf).orders.some((o: any) => o.step === 'synth'), 'rejected member blocks the reduce');
  const blocked = ow('status', wf).blocked.find((b: any) => b.step === 'synth');
  assert.ok(blocked && blocked.blockedOn.includes('gather.source[1]'));

  // retract it instead → it drops out and synth becomes eligible
  ow('retract', wf, 'gather.source[1]', '--by', 'check', '--text', 'give up on it');
  assert.ok(ow('tick', wf).orders.some((o: any) => o.step === 'synth') ||
    ow('status', wf).eligible.some((f: any) => f.step === 'synth'), 'retract unblocks the reduce');
  ow.cleanup();
});

// ----------------------------------------------------------------------------
// B2. Suffixed reduce (`src[*].child`): mirrors the bare-reduce battery above,
// but gates on a map step's per-element child, not the bare member (§11).
// ----------------------------------------------------------------------------

function startReduceSuffix(ow: any): string {
  return ow('create', 'reducesuffix', '--provide', `question=${J({ q: 'why' })}`).workflow;
}

test('suffixed reduce: an EMPTY sealed collection still reduces (no children required)', () => {
  const ow = harness(FIXTURES);
  const wf = startReduceSuffix(ow);
  const g = claim(ow, wf, 'gather');
  ow('seal', wf, g.run); // seal with ZERO emitted members
  ow('close', wf, g.run);

  const s = claim(ow, wf, 'synth');
  assert.ok(!Object.keys(s.consumes).some((k) => /\[\d+\]/.test(k)), 'no member children — the reduce rests only on the seal');
  ow('green', wf, s.run, 'draft', '--value', J({ answer: 'none found' }));
  ow('close', wf, s.run);
  assert.equal(ow('status', wf).done, true);
  ow.cleanup();
});

test("suffixed reduce: fires once every live member's child is green, keyed by child path", () => {
  const ow = harness(FIXTURES);
  const wf = startReduceSuffix(ow);
  const g = claim(ow, wf, 'gather');
  ow('emit', wf, g.run, '--items', J([{ url: 'a' }, { url: 'b' }]));
  ow('seal', wf, g.run);
  ow('close', wf, g.run);

  // bare members are born green, but synth must NOT be eligible until their
  // .formatcheck children are also green (the whole point of the suffix).
  const t = ow('tick', wf);
  assert.ok(!t.orders.some((o: any) => o.step === 'synth'), 'children not green yet — reduce not eligible');

  const checks = t.orders.filter((o: any) => o.step === 'formatcheck');
  assert.equal(checks.length, 2);
  for (const c of checks) {
    ow('green', wf, c.run, c.outputs[0], '--value', J({ ok: true }));
    ow('close', wf, c.run);
  }

  const s = claim(ow, wf, 'synth');
  const childKeys = Object.keys(s.consumes).filter((k) => k.endsWith('.formatcheck'));
  assert.deepEqual(childKeys.sort(), ['gather.source[0].formatcheck', 'gather.source[1].formatcheck']);
  assert.ok(!Object.keys(s.consumes).some((k) => /\[\d+\]$/.test(k)), 'bare member paths are not in the consumes payload');
  ow('green', wf, s.run, 'draft', '--value', J({ from: 'a+b' }));
  ow('close', wf, s.run);
  assert.equal(ow('status', wf).done, true);
  ow.cleanup();
});

test('suffixed reduce: a REJECTED child blocks the reduce even though its bare member is green', () => {
  const ow = harness(FIXTURES);
  const wf = startReduceSuffix(ow);
  const g = claim(ow, wf, 'gather');
  ow('emit', wf, g.run, '--items', J([{ url: 'a' }, { url: 'b' }]));
  ow('seal', wf, g.run);
  ow('close', wf, g.run);

  const checks = ow('tick', wf).orders.filter((o: any) => o.step === 'formatcheck');
  ow('green', wf, checks[0].run, checks[0].outputs[0], '--value', J({ ok: true }));
  ow('close', wf, checks[0].run);
  ow('reject', wf, checks[1].outputs[0], '--by', 'human', '--text', 'bad formatting');
  ow('close', wf, checks[1].run);

  assert.ok(!ow('tick', wf).orders.some((o: any) => o.step === 'synth'), 'a rejected child blocks the reduce');
  const blocked = ow('status', wf).blocked.find((b: any) => b.step === 'synth');
  assert.ok(blocked && blocked.blockedOn.includes('gather.source[1].formatcheck'), 'blockedOn names the child, not the bare member');

  // retract the bare member instead → it (and its child) drop out, unblocking synth
  ow('retract', wf, 'gather.source[1]', '--by', 'human', '--text', 'give up on it');
  assert.ok(
    ow('tick', wf).orders.some((o: any) => o.step === 'synth') ||
    ow('status', wf).eligible.some((f: any) => f.step === 'synth'),
    'retracting the member unblocks the reduce',
  );
  ow.cleanup();
});

test('suffixed reduce: a re-armed child after green knocks the reduce output back', () => {
  const ow = harness(FIXTURES);
  const wf = startReduceSuffix(ow);
  const g = claim(ow, wf, 'gather');
  ow('emit', wf, g.run, '--items', J([{ url: 'a' }, { url: 'b' }]));
  ow('seal', wf, g.run);
  ow('close', wf, g.run);

  const checks = ow('tick', wf).orders.filter((o: any) => o.step === 'formatcheck');
  for (const c of checks) {
    ow('green', wf, c.run, c.outputs[0], '--value', J({ ok: true }));
    ow('close', wf, c.run);
  }
  const s = claim(ow, wf, 'synth');
  ow('green', wf, s.run, 'draft', '--value', J({ from: 'a+b' }));
  ow('close', wf, s.run);
  assert.equal(ow('status', wf).done, true);

  // reject a child after the reduce already greened → draft falls back to a debt
  ow('reject', wf, 'gather.source[1].formatcheck', '--by', 'human', '--text', 'redo');
  const draft = art(ow, wf, 'draft');
  assert.equal(draft.acceptance, 'rejected', 'draft re-armed off the rejected child, not the (still-green) bare member');
  ow.cleanup();
});

test('collection: emit accretes after the highest index across calls', () => {
  const ow = harness(FIXTURES);
  const wf = startResearch(ow);
  const g = claim(ow, wf, 'gather');
  const first = ow('emit', wf, g.run, '--items', J([{ url: 'a' }, { url: 'b' }]));
  assert.deepEqual(first.created, ['gather.source[0]', 'gather.source[1]']);
  const second = ow('emit', wf, g.run, '--items', J([{ url: 'c' }]));
  assert.deepEqual(second.created, ['gather.source[2]'], 'accretes, never restarts at 0');
  ow.cleanup();
});

test('collection: emit on a stale run (input moved) born-rejects the seal, creates nothing', () => {
  const ow = harness(FIXTURES);
  const wf = startResearch(ow);
  const g = claim(ow, wf, 'gather'); // snapshots question@v1
  ow('reject', wf, 'question', '--by', 'gather', '--text', 'question changed underneath us');

  const res = ow.any('emit', wf, g.run, '--items', J([{ url: 'a' }]));
  assert.deepEqual(res.created, [], 'no elements are accreted from a stale run');
  assert.equal(art(ow, wf, 'gather.source.sealed').acceptance, 'rejected', 'the seal is born-rejected');
  assert.ok(!art(ow, wf, 'gather.source[0]'), 'no member artifact was written');
  ow.cleanup();
});

test('collection: seal on a stale run (input moved) is born-rejected', () => {
  const ow = harness(FIXTURES);
  const wf = startResearch(ow);
  const g = claim(ow, wf, 'gather');
  ow('emit', wf, g.run, '--items', J([{ url: 'a' }])); // emit while still fresh
  ow('reject', wf, 'question', '--by', 'gather', '--text', 'changed mid-run');

  const res = ow.any('seal', wf, g.run);
  assert.equal(res.outcome, 'born-rejected');
  assert.match(res.reason, /not green at commit/);
  assert.equal(art(ow, wf, 'gather.source.sealed').acceptance, 'rejected');
  ow.cleanup();
});

// ============================================================================
// C. Concurrency & the commit CAS (§12)
// ============================================================================

test('CAS: a plain commit is born-rejected when its input moved during the run', () => {
  const ow = harness();
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  let o = claim(ow, wf, 'planner');
  ow('green', wf, o.run, 'plan', '--value', J({ plan: 'v1' }));
  ow('close', wf, o.run);

  // claim the builder (snapshots plan@v1), THEN invalidate plan underneath it
  const builder = claim(ow, wf, 'builder');
  ow('reject', wf, 'plan', '--by', 'builder', '--text', 'changed my mind');

  // committing the stale builder run must be born-rejected, never green-for-an-instant
  const res = ow.any('green', wf, builder.run, 'pr', '--value', J({ pr: '#1' }));
  assert.equal(res.outcome, 'born-rejected');
  const pr = art(ow, wf, 'pr');
  assert.equal(pr.acceptance, 'rejected');
  assert.equal(pr.reasons.at(-1).action, 'born-rejected');
  assert.equal(pr.reasons.at(-1).kind, 'structural', 'a born-reject is structural, not a judgment');
  assert.equal(pr.judgmentRejects, 0, 'structural rejects NEVER count toward the stall cap (§6/§11.9)');
  ow.cleanup();
});

test('CAS: a reaped run is a zombie — its commit is refused (lease no longer held)', () => {
  const ow = harness();
  const T0 = 1_700_000_000_000;
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  // claim AT T0 so the lease timestamp is anchored to the test clock, not wall time
  const stranded = ow('tick', wf, '--now', String(T0)).orders.find((o: any) => o.step === 'planner');
  assert.ok(stranded, 'planner claimed at T0');
  // re-tick far in the future: the lease is past its 2h TTL → reaped → re-armed
  const later = ow('tick', wf, '--now', String(T0 + 3 * 3600_000));
  assert.equal(later.reaped, 1, 'the stranded claim was reaped');
  assert.ok(later.orders.some((o: any) => o.step === 'planner'), 'planner re-armed under a fresh run');

  // the original run may no longer commit
  const r = ow.raw('green', wf, stranded.run, 'plan', '--value', J({ plan: 'late' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no longer holds its lease|reaped|superseded/);
  ow.cleanup();
});

test('CAS: committing on an already-closed run is refused', () => {
  const ow = harness();
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  const o = claim(ow, wf, 'planner');
  ow('green', wf, o.run, 'plan', '--value', J({ plan: 'v1' }));
  ow('close', wf, o.run);
  const r = ow.raw('green', wf, o.run, 'plan', '--value', J({ plan: 'again' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already closed/);
  ow.cleanup();
});

// ============================================================================
// D. Scheduler: cadence / daily budget / over-ticking (§13, rate fixture)
// ============================================================================

function startRate(ow: any): string {
  return ow('create', 'rate', '--provide', `seed=${J({})}`).workflow;
}

test('schedule: an eligible step is not re-fired until its cadence elapses', () => {
  const ow = harness(FIXTURES);
  const wf = startRate(ow);
  const T0 = 1_700_000_000_000;

  const first = ow('tick', wf, '--now', String(T0));
  assert.equal(first.orders.length, 1, 'fires at T0');
  ow('close', wf, first.orders[0].run, '--outcome', 'no_work'); // pong stays owed → still eligible

  const tooSoon = ow('tick', wf, '--now', String(T0 + 59 * 60_000)); // 59m < 1h cadence
  assert.equal(tooSoon.orders.length, 0, 'cadence gate holds it back');

  const due = ow('tick', wf, '--now', String(T0 + 60 * 60_000)); // exactly 1h → due
  assert.equal(due.orders.length, 1, 'fires again once the cadence has elapsed');
  ow.cleanup();
});

test('schedule: maxRunsPerDay caps firings within a day even when cadence has elapsed', () => {
  const ow = harness(FIXTURES);
  const wf = startRate(ow);
  // anchor at local noon so the three ticks stay within one local day (budget is day-scoped)
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  const T0 = noon.getTime();

  const r1 = ow('tick', wf, '--now', String(T0));
  ow('close', wf, r1.orders[0].run, '--outcome', 'no_work');
  const r2 = ow('tick', wf, '--now', String(T0 + 3600_000));
  assert.equal(r2.orders.length, 1, 'second run is within budget');
  ow('close', wf, r2.orders[0].run, '--outcome', 'no_work');

  const r3 = ow('tick', wf, '--now', String(T0 + 2 * 3600_000)); // cadence ok, but budget spent
  assert.equal(r3.orders.length, 0, 'maxRunsPerDay=2 blocks the third firing today');
  ow.cleanup();
});

test('schedule: over-ticking is safe — repeated ticks never double-claim', () => {
  const ow = harness(FIXTURES);
  const wf = startRate(ow);
  const T0 = 1_700_000_000_000;
  const orders = [];
  for (let i = 0; i < 5; i++) orders.push(...ow('tick', wf, '--now', String(T0)).orders);
  assert.equal(orders.length, 1, 'exactly one claim despite five ticks at the same instant');
  ow.cleanup();
});

// ============================================================================
// E. Routing: skip + the skip-cascade + reversibility (§16.1, §11.8)
// ============================================================================

test('routing: a dead branch skips and the cascade settles its whole subtree to done', () => {
  const ow = harness();
  const wf = ow('create', 'routing', '--provide', `ticket=${J({ kind: 'refund' })}`).workflow;

  const tr = claim(ow, wf, 'triage');
  ow('green', wf, tr.run, 'route', '--value', J({ branch: 'refund' }));
  ow('close', wf, tr.run);

  // the firing rule fires EVERY eligible consumer — both branches get an order
  const t = ow('tick', wf);
  const refund = t.orders.find((o: any) => o.step === 'refund');
  const deny = t.orders.find((o: any) => o.step === 'deny');
  assert.ok(refund && deny, 'both branches eligible (no XOR over edges §16.1)');

  ow('green', wf, refund.run, 'refund_done', '--value', J({ refunded: true }));
  ow('close', wf, refund.run);
  ow('skip', wf, 'denial', '--by', 'deny', '--text', 'route=refund, deny is dead');
  ow('close', wf, deny.run, '--outcome', 'skipped');

  const st = ow('status', wf);
  assert.equal(st.done, true, JSON.stringify(st.debts));
  assert.equal(art(ow, wf, 'denial').acceptance, 'skipped');
  assert.equal(art(ow, wf, 'notice').acceptance, 'skipped', 'the dead subtree auto-skipped in one sweep');
  ow.cleanup();
});

test('routing: re-judging the route revives the previously-skipped branch (level-triggered)', () => {
  const ow = harness();
  const wf = ow('create', 'routing', '--provide', `ticket=${J({ kind: 'refund' })}`).workflow;
  let o = claim(ow, wf, 'triage');
  ow('green', wf, o.run, 'route', '--value', J({ branch: 'refund' }));
  ow('close', wf, o.run);
  let t = ow('tick', wf);
  const refund = t.orders.find((x: any) => x.step === 'refund');
  const deny = t.orders.find((x: any) => x.step === 'deny');
  ow('green', wf, refund.run, 'refund_done', '--value', J({ refunded: true }));
  ow('close', wf, refund.run);
  ow('skip', wf, 'denial', '--by', 'deny', '--text', 'dead');
  ow('close', wf, deny.run, '--outcome', 'skipped');
  assert.equal(ow('status', wf).done, true);
  assert.equal(art(ow, wf, 'denial').acceptance, 'skipped');

  // re-judge the route and re-green it with the OTHER branch — the decision moved
  ow('reject', wf, 'route', '--by', 'refund', '--text', 'actually deny this');
  assert.equal(ow('status', wf).done, false, 'live branch re-opened');
  o = claim(ow, wf, 'triage');
  ow('green', wf, o.run, 'route', '--value', J({ branch: 'deny' }));
  ow('close', wf, o.run);

  // the deny branch must have revived from skipped → owed (its input moved §11.8)
  assert.notEqual(art(ow, wf, 'denial').acceptance, 'skipped', 'skipped branch re-armed when the route moved');
  ow.cleanup();
});

// ============================================================================
// F. Authority & lifecycle guards (§4, §11.3, §16.1)
// ============================================================================

test('authority: only a consumer (or human) may judgment-reject an artifact (§4)', () => {
  const ow = harness();
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  // planner consumes `proposal`, NOT `pr` — it has no authority to invalidate pr
  const r = ow.raw('reject', wf, 'pr', '--by', 'planner', '--text', 'nope');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /authority/);
  // a human always may
  ow('green', wf, claim(ow, wf, 'planner').run, 'plan', '--value', J({ plan: 'v1' }));
  ow('reject', wf, 'plan', '--by', 'human', '--text', 'human override');
  assert.equal(art(ow, wf, 'plan').acceptance, 'rejected');
  ow.cleanup();
});

test('guard: retract is only valid on a collection member, never a singleton (§11.3)', () => {
  const ow = harness();
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  const r = ow.raw('retract', wf, 'plan', '--by', 'human', '--text', 'no');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /collection member/);
  ow.cleanup();
});

test('guard: only the producer (or human) may skip its own output (§16.1)', () => {
  const ow = harness();
  const wf = ow('create', 'routing', '--provide', `ticket=${J({ kind: 'x' })}`).workflow;
  // `denial` is produced by `deny`; `refund` may not skip it
  const r = ow.raw('skip', wf, 'denial', '--by', 'refund', '--text', 'not mine');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only the producer/);
  ow.cleanup();
});

// ============================================================================
// G. Lifecycle bookkeeping: versions, reason threads, status classification
// ============================================================================

test('version: bumps only on green (re)production, never on a reject (§12.1)', () => {
  const ow = harness();
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  assert.equal(art(ow, wf, 'proposal').version, 1, 'a provided input starts at v1');

  let o = claim(ow, wf, 'planner');
  ow('green', wf, o.run, 'plan', '--value', J({ plan: 'v1' }));
  ow('close', wf, o.run);
  assert.equal(art(ow, wf, 'plan').version, 1, 'first green → v1');

  ow('reject', wf, 'plan', '--by', 'builder', '--text', 'redo');
  assert.equal(art(ow, wf, 'plan').version, 1, 'reject does NOT bump the version');

  o = claim(ow, wf, 'planner');
  ow('green', wf, o.run, 'plan', '--value', J({ plan: 'v2' }));
  ow('close', wf, o.run);
  assert.equal(art(ow, wf, 'plan').version, 2, 're-green → v2');
  ow.cleanup();
});

test('reasons: the invalidation thread is append-only and ordered (§4)', () => {
  const ow = harness();
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  let o = claim(ow, wf, 'planner');
  ow('green', wf, o.run, 'plan', '--value', J({ plan: 'v1' }));
  ow('close', wf, o.run);
  o = claim(ow, wf, 'builder');
  ow('green', wf, o.run, 'pr', '--value', J({ pr: '#1' }));
  ow('close', wf, o.run);

  ow('reject', wf, 'pr', '--by', 'reviewer', '--text', 'round one');
  o = claim(ow, wf, 'builder'); // re-armed only because the prior run was closed
  ow('green', wf, o.run, 'pr', '--value', J({ pr: '#2' }));
  ow('close', wf, o.run);
  ow('reject', wf, 'pr', '--by', 'reviewer', '--text', 'round two');

  const texts = art(ow, wf, 'pr').reasons.map((r: any) => r.text);
  assert.deepEqual(texts, ['round one', 'round two'], 'reasons accumulate in order, never overwrite');
  ow.cleanup();
});

test('status: distinguishes judgment vs structural debts; excludes settled artifacts (§17)', () => {
  const ow = harness();
  const wf = deliverToMerge(ow);
  ow('reject', wf, 'plan', '--by', 'builder', '--text', 'judgment call');

  const st = ow('status', wf);
  const plan = st.debts.find((d: any) => d.path === 'plan');
  const pr = st.debts.find((d: any) => d.path === 'pr');
  assert.equal(plan.kind, 'judgment');
  assert.equal(pr.kind, 'structural');
  assert.equal(plan.stalled, false, 'one reject is well under the cap');
  ow.cleanup();
});

// ============================================================================
// H. Multi-instance isolation (§9)
// ============================================================================

test('isolation: two instances in one db do not interfere; delete is scoped', () => {
  const ow = harness();
  const wf1 = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'one' })}`).workflow;
  const wf2 = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'two' })}`).workflow;

  // advance wf1 only
  ow('green', wf1, claim(ow, wf1, 'planner').run, 'plan', '--value', J({ plan: 'p1' }));

  assert.equal(art(ow, wf1, 'plan').acceptance, 'green');
  assert.equal(art(ow, wf2, 'plan').acceptance, 'owed', 'wf2 untouched');
  assert.deepEqual(art(ow, wf2, 'proposal').value, { text: 'two' }, 'wf2 keeps its own input');

  ow('delete', wf1);
  assert.deepEqual(ow('list').map((w: any) => w.id), [wf2], 'delete removed only wf1');
  assert.equal(ow('status', wf2).done, false, 'wf2 still operable');
  ow.cleanup();
});

// ============================================================================
// I. CLI robustness — hostile / malformed input fails loudly, never corrupts state
// ============================================================================

test('robustness: bad references and malformed input fail with a clear error, exit 1', () => {
  const ow = harness();
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  const run = claim(ow, wf, 'planner').run;

  const cases: Array<[string[], RegExp]> = [
    [['create', 'nonesuch'], /unknown workflow definition/],
    [['status', 'wf_doesnotexist'], /no such workflow instance/],
    [['provide', wf, 'bogusinput', '--value', '{}'], /no such input artifact/],
    [['green', wf, run, 'plan', '--value', 'not-json{'], /invalid JSON/],
    [['green', wf, run, 'nonexistent_output', '--value', '{}'], /unknown artifact/],
    [['reject', wf, 'plan', '--by', 'ghoststep', '--text', 'x'], /unknown actor/],
  ];
  for (const [args, re] of cases) {
    const r = ow.raw(...args);
    assert.equal(r.status, 1, `'${args.join(' ')}' should exit 1`);
    assert.match(r.stderr, re, `'${args.join(' ')}' stderr`);
  }

  // and a malformed collection emit is rejected before anything is written
  ow('green', wf, run, 'plan', '--value', J({ plan: 'v1' }));
  const research = ow('create', 'research', '--provide', `question=${J({})}`).workflow;
  const gr = claim(ow, research, 'gather').run;
  const bad = ow.raw('emit', research, gr, '--items', J({ not: 'an array' }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /must be a JSON array/);
  ow.cleanup();
});

test('robustness: re-sealing an already-sealed collection is an idempotent no-op', () => {
  const ow = harness();
  const wf = ow('create', 'research', '--provide', `question=${J({})}`).workflow;
  const g = claim(ow, wf, 'gather');
  ow('emit', wf, g.run, '--items', J([{ url: 'a' }]));
  assert.equal(ow('seal', wf, g.run).outcome, 'green');
  // sealing again must not throw or double-mark — same green result
  assert.equal(ow('seal', wf, g.run).outcome, 'green', 'seal is idempotent');
  assert.equal(art(ow, wf, 'gather.source.sealed').acceptance, 'green');
  ow.cleanup();
});
