/**
 * Documented-behavior scenarios.
 *
 * Where edge.e2e.test.ts hammers the failure corners, this file checks the
 * *positive* behaviors the design doc promises, as multi-step stories a real
 * operator would hit: the map `parallel` cap (§3), map and reduce as concurrent
 * branches that gate on members not verdicts (§3/§11), the reason thread riding
 * the next order (§4), stall → retry → re-stall with `blocked` excluding the
 * stalled step (§6/§17), the level-trigger re-firing on a re-provided input and
 * staying idempotent on a healthy graph (§7), and the `unbuilt` status kind (§17).
 * All drive the real binary against real SQLite.
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

function harness(defsDir: string = EXAMPLES) {
  const db = join(mkdtempSync(join(tmpdir(), 'owenloop-scn-')), 'state.db');
  const ow = (...args: string[]): any => {
    const r = spawnSync(process.execPath, [BIN, ...args, '--db', db, '--defs', defsDir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`owenloop ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : null;
  };
  ow.cleanup = () => rmSync(dirname(db), { recursive: true, force: true });
  return ow;
}

const J = (v: unknown) => JSON.stringify(v);
const find = (tick: any, step: string) => tick.orders.find((o: any) => o.step === step);
const arts = (ow: any, wf: string) => ow('show', wf) as any[];
const art = (ow: any, wf: string, path: string) => arts(ow, wf).find((a) => a.path === path);

/** Build a delivery to all-green-but-not-merged; returns the workflow id. */
function deliverToVerdict(ow: any): string {
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  for (const [step, out] of [['planner', 'plan'], ['builder', 'pr'], ['reviewer', 'verdict']] as const) {
    const o = find(ow('tick', wf), step);
    ow('green', wf, o.run, out, '--value', J({}));
    ow('close', wf, o.run);
  }
  return wf;
}

// ============================================================================
// §3 — the firing rule: map fan-out, the parallel cap, member-gated reduce
// ============================================================================

test('§3 map: a single tick claims at most `parallel` element firings', () => {
  const ow = harness(FIXTURES);
  const wf = ow('create', 'mapcap', '--provide', `seed=${J({})}`).workflow;
  const s = find(ow('tick', wf), 'spawn');
  ow('emit', wf, s.run, '--items', J([{}, {}, {}, {}, {}])); // 5 elements
  ow('seal', wf, s.run);
  ow('close', wf, s.run);

  const inFlight = (t: any) => t.orders.filter((o: any) => o.step === 'work').length;
  const t1 = ow('tick', wf);
  assert.equal(inFlight(t1), 2, 'cap=2 even though 5 elements are eligible');
  assert.equal(inFlight(ow('tick', wf)), 0, 'nothing more claimable while the 2 leases are held');

  for (const o of t1.orders.filter((o: any) => o.step === 'work')) {
    ow('green', wf, o.run, o.outputs[0], '--value', J({}));
    ow('close', wf, o.run);
  }
  assert.equal(inFlight(ow('tick', wf)), 2, 'freeing the leases lets the next 2 in');
  ow.cleanup();
});

test('§3 reduce gates on members, not verdicts — a rejected map verdict does not block it', () => {
  // Bare-member reduce semantics — the shipped `research` example moved to a
  // suffixed reduce (`gather.source[*].verdict`); this fixture keeps the
  // bare-reduce shape research.yaml used to have.
  const ow = harness(FIXTURES);
  const wf = ow('create', 'reduce', '--provide', `question=${J({ q: 'x' })}`).workflow;
  const g = find(ow('tick', wf), 'gather');
  ow('emit', wf, g.run, '--items', J([{ u: 'a' }, { u: 'b' }]));
  ow('seal', wf, g.run);
  ow('close', wf, g.run);

  // ONE tick claims the per-element checks AND the reduce — they are concurrent branches
  const t = ow('tick', wf);
  const checks = t.orders.filter((o: any) => o.step === 'check');
  const synth = find(t, 'synth');
  assert.equal(checks.length, 2, 'a check firing per element');
  assert.ok(synth, 'the reduce is eligible alongside the maps, not after them');

  // green one verdict, REJECT the other — the members themselves stay green
  ow('green', wf, checks[0].run, checks[0].outputs[0], '--value', J({ ok: true }));
  ow('close', wf, checks[0].run);
  ow('reject', wf, checks[1].outputs[0], '--by', 'synth', '--text', 'bad verdict');
  assert.deepEqual(
    arts(ow, wf).filter((a) => /source\[\d+\]$/.test(a.path)).map((a) => a.acceptance),
    ['green', 'green'],
    'a rejected verdict does not touch the members',
  );
  // so the reduce greens regardless of the verdict's state — its lever is retract, not a verdict
  assert.equal(ow('green', wf, synth.run, 'draft', '--value', J({ d: 1 })).outcome, 'green');
  ow.cleanup();
});

// ============================================================================
// §4 — the reason thread rides the next order
// ============================================================================

test('§4 a re-armed order carries the artifact\'s full reason history in owes[]', () => {
  const ow = harness();
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  ow('green', wf, find(ow('tick', wf), 'planner').run, 'plan', '--value', J({}));
  const b = find(ow('tick', wf), 'builder');
  ow('green', wf, b.run, 'pr', '--value', J({}));
  ow('close', wf, b.run);
  ow('reject', wf, 'pr', '--by', 'reviewer', '--text', 'needs tests');

  const reorder = find(ow('tick', wf), 'builder');
  const owed = reorder.owes.find((o: any) => o.path === 'pr');
  assert.ok(owed, 'the re-armed order owes pr');
  assert.equal(owed.acceptance, 'rejected');
  assert.equal(owed.judgmentRejects, 1);
  assert.equal(owed.reasons.at(-1).text, 'needs tests', 'the worker sees why it was knocked back');
  assert.equal(owed.reasons.at(-1).by, 'reviewer');
  ow.cleanup();
});

// ============================================================================
// §6 / §17 — stalls: re-stall after retry, and blocked excludes a stalled step
// ============================================================================

test('§6 stall → retry → re-stall: retry resets the counter and the step can stall again', () => {
  const ow = harness();
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  ow('green', wf, find(ow('tick', wf), 'planner').run, 'plan', '--value', J({}));

  // knock pr back until the builder stops being re-armed (out of attempts)
  const knockUntilStalled = () => {
    for (let i = 0; i < 20; i++) {
      const o = find(ow('tick', wf), 'builder');
      if (!o) break;
      ow('green', wf, o.run, 'pr', '--value', J({}));
      ow('close', wf, o.run);
      ow('reject', wf, 'pr', '--by', 'reviewer', '--text', 'no');
    }
    return ow('status', wf).debts.find((d: any) => d.path === 'pr');
  };

  const first = knockUntilStalled();
  assert.equal(first.stalled, true, 'stalls at the cap');
  // §17: a stalled step is NOT "blocked" (it isn't waiting on an input) and not eligible
  const st = ow('status', wf);
  assert.ok(!st.blocked.some((b: any) => b.step === 'builder'), 'blocked excludes the stalled step');
  assert.ok(!st.eligible.some((e: any) => e.step === 'builder'), 'a stalled step is not re-armed');

  // retry is the only counter-reset; the step becomes live again
  ow('retry', wf, 'pr', '--text', 'new test harness, try again');
  assert.equal(art(ow, wf, 'pr').judgmentRejects, 0, 'retry zeroes the counter');
  assert.equal(ow('status', wf).debts.find((d: any) => d.path === 'pr').stalled, false);
  assert.ok(ow('status', wf).eligible.some((e: any) => e.step === 'builder'), 'builder live again');

  // ...and the very same failure mode can stall it a second time
  assert.equal(knockUntilStalled().stalled, true, 're-accumulates to a fresh stall');
  ow.cleanup();
});

// ============================================================================
// §7 — the level-trigger: re-provide cascades; a healthy graph is idempotent
// ============================================================================

test('§7 re-providing an input forward-invalidates the whole downstream chain', () => {
  const ow = harness();
  const wf = deliverToVerdict(ow);
  assert.equal(art(ow, wf, 'plan').acceptance, 'green');
  assert.equal(art(ow, wf, 'verdict').acceptance, 'green');

  // a new version of the root input re-arms everything derived from it
  ow('provide', wf, 'proposal', '--value', J({ text: 'v2' }));
  assert.equal(art(ow, wf, 'proposal').version, 2, 're-provide bumps the version');
  const st = ow('status', wf);
  assert.equal(st.done, false);
  for (const p of ['plan', 'pr', 'verdict']) {
    const d = st.debts.find((x: any) => x.path === p);
    assert.ok(d, `${p} re-opened`);
    assert.equal(d.kind, 'structural', `${p} fell back structurally, not as a judgment debt`);
  }
  ow.cleanup();
});

test('§7 a terminal output survives a re-provided input while the rest re-derives', () => {
  const ow = harness();
  const wf = deliverToVerdict(ow);
  const m = find(ow('tick', wf), 'merger');
  ow('green', wf, m.run, 'merge', '--value', J({ sha: 'abc' }), '--terminal');
  ow('close', wf, m.run);
  assert.equal(ow('status', wf).done, true);

  ow('provide', wf, 'proposal', '--value', J({ text: 'v2' }));
  assert.equal(art(ow, wf, 'merge').acceptance, 'green', 'the merge is irreversible (§15.2)');
  assert.equal(art(ow, wf, 'merge').terminal, true);
  assert.equal(ow('status', wf).done, false, 'but the non-terminal chain re-opened');
  ow.cleanup();
});

test('§7 settle is idempotent on a healthy graph — extra ticks produce no orders', () => {
  const ow = harness();
  const wf = deliverToVerdict(ow);
  const m = find(ow('tick', wf), 'merger');
  ow('green', wf, m.run, 'merge', '--value', J({}), '--terminal');
  ow('close', wf, m.run);
  assert.equal(ow('status', wf).done, true);

  const before = JSON.stringify(arts(ow, wf).map((a) => [a.path, a.acceptance, a.version]));
  for (let i = 0; i < 5; i++) {
    assert.equal(ow('tick', wf).orders.length, 0, `tick ${i} re-fires nothing`);
  }
  const after = JSON.stringify(arts(ow, wf).map((a) => [a.path, a.acceptance, a.version]));
  assert.equal(after, before, 'the level-trigger leaves a healthy graph untouched');
  assert.equal(ow('status', wf).done, true);
  ow.cleanup();
});

// ============================================================================
// §17 — derived status: the `unbuilt` kind
// ============================================================================

test('§17 a never-built owed artifact is classified as kind "unbuilt"', () => {
  const ow = harness();
  const wf = ow('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).workflow;
  const st = ow('status', wf);
  const plan = st.debts.find((d: any) => d.path === 'plan');
  assert.equal(plan.kind, 'unbuilt', 'owed-and-never-rejected reads as unbuilt, not a judgment/structural debt');
  assert.equal(plan.stalled, false);
  // and downstream steps with no green input yet are "blocked", not eligible
  assert.ok(st.blocked.some((b: any) => b.step === 'builder' && b.blockedOn.includes('plan')));
  assert.deepEqual(st.eligible.map((e: any) => e.step), ['planner'], 'only the root step can run');
  ow.cleanup();
});
