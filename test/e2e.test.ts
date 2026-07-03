/**
 * End-to-end tests: drive the real `bin/owenloop.mjs` binary as a subprocess,
 * against a real on-disk SQLite database and the shipped example workflows.
 * Nothing here imports the engine directly — it goes argv → JSON → SQLite → JSON,
 * exactly as a wiring (the worker that runs orders) would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleDefNames } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'owenloop.mjs');
const DEFS = join(ROOT, 'examples', 'workflows');
const FIXTURES = join(ROOT, 'test', 'fixtures');

interface RawResult {
  status: number;
  stdout: string;
  stderr: string;
}

function raw(db: string, args: string[]): RawResult {
  return rawAgainst(db, DEFS, args);
}

/** Like `raw`, but against an explicit defs dir instead of the shipped examples —
 *  used by the §28 pinning test, which must edit its own throwaway def mid-test. */
function rawAgainst(db: string, defsDir: string, args: string[]): RawResult {
  const res = spawnSync(process.execPath, [BIN, ...args, '--db', db, '--defs', defsDir], {
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** Run the CLI, assert success, parse JSON stdout. */
function makeCli(db: string) {
  return (...args: string[]): any => {
    const r = raw(db, args);
    if (r.status !== 0) {
      throw new Error(`owenloop ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
    }
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : null;
  };
}

/** Like `makeCli`, but against an explicit defs dir. */
function makeCliAgainst(db: string, defsDir: string) {
  return (...args: string[]): any => {
    const r = rawAgainst(db, defsDir, args);
    if (r.status !== 0) {
      throw new Error(`owenloop ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
    }
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : null;
  };
}

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-e2e-'));
  return join(dir, 'state.db');
}

function orderFor(tick: any, step: string): any {
  const o = tick.orders.find((x: any) => x.step === step);
  assert.ok(o, `expected an order for '${step}', got: ${tick.orders.map((x: any) => x.step).join(', ')}`);
  return o;
}

// -----------------------------------------------------------------------------

test('delivery: full pipeline with a reviewer knock-back ends green & terminal', () => {
  const db = tmpDb();
  const ow = makeCli(db);

  const wf = ow('create', 'delivery', '--provide', `proposal=${JSON.stringify({ text: 'add dark mode' })}`).workflow;
  assert.ok(wf.startsWith('wf'), wf);

  // planner: only eligible step at the start
  let t = ow('tick', wf);
  assert.deepEqual(t.orders.map((o: any) => o.step), ['planner']);
  let o = orderFor(t, 'planner');
  assert.deepEqual(o.consumes, { proposal: { text: 'add dark mode' } }); // captured green input
  assert.equal(ow('green', wf, o.run, 'plan', '--value', JSON.stringify({ plan: 'do X' })).outcome, 'green');
  ow('close', wf, o.run);

  // builder
  o = orderFor(ow('tick', wf), 'builder');
  ow('green', wf, o.run, 'pr', '--value', JSON.stringify({ url: 'pr/1' }));
  ow('close', wf, o.run);

  // reviewer knocks the PR back — re-arming the builder, not producing a verdict
  o = orderFor(ow('tick', wf), 'reviewer');
  ow('reject', wf, 'pr', '--by', 'reviewer', '--text', 'tests missing');
  ow('close', wf, o.run, '--outcome', 'no_work');

  // the knock-back re-armed the builder (this tick proves it)
  o = orderFor(ow('tick', wf), 'builder');
  // the feedback thread is delivered on the order's `owes`
  const prOwe = o.owes.find((x: any) => x.path === 'pr');
  assert.equal(prOwe.acceptance, 'rejected');
  assert.ok(prOwe.reasons.at(-1).text.includes('tests missing'));
  ow('green', wf, o.run, 'pr', '--value', JSON.stringify({ url: 'pr/2' }));
  ow('close', wf, o.run);

  // reviewer now approves
  o = orderFor(ow('tick', wf), 'reviewer');
  ow('green', wf, o.run, 'verdict', '--value', JSON.stringify({ approve: true }));
  ow('close', wf, o.run);

  // merger: terminal completion
  o = orderFor(ow('tick', wf), 'merger');
  assert.equal(ow('green', wf, o.run, 'merge', '--value', JSON.stringify({ sha: 'abc' }), '--terminal').outcome, 'green');
  ow('close', wf, o.run);

  const st = ow('status', wf);
  assert.equal(st.done, true, JSON.stringify(st.debts));
  assert.deepEqual(st.eligible, []);

  const merge = ow('show', wf).find((a: any) => a.path === 'merge');
  assert.equal(merge.acceptance, 'green');
  assert.equal(merge.terminal, true);

  rmSync(join(db, '..'), { recursive: true, force: true });
});

test('research: collection fan-out, retract, born-rejected CAS, and reduce re-derivation', () => {
  const db = tmpDb();
  // Bare-member reduce semantics (gates on members, not verdicts) — the
  // shipped `research` example moved to a suffixed reduce
  // (`gather.source[*].verdict`); this fixture keeps the bare-reduce shape.
  const ow = makeCliAgainst(db, FIXTURES);

  const wf = ow('create', 'reduce', '--provide', `question=${JSON.stringify({ q: 'why is the sky blue' })}`).workflow;

  // gather: emit a collection, then seal
  let o = orderFor(ow('tick', wf), 'gather');
  const emitted = ow('emit', wf, o.run, '--items', JSON.stringify([{ url: 'a' }, { url: 'b' }, { url: 'c' }]));
  assert.deepEqual(emitted.created, ['gather.source[0]', 'gather.source[1]', 'gather.source[2]']);
  ow('seal', wf, o.run);
  ow('close', wf, o.run);

  // after the seal, the map (check ×3) and the reduce (synth) are all eligible
  const t = ow('tick', wf);
  const checks = t.orders.filter((x: any) => x.step === 'check');
  assert.equal(checks.length, 3, 'one check firing per element');
  const synth = orderFor(t, 'synth'); // claimed now — its fingerprint snapshots all 3 sources

  // check 0 and 2 pass; source 1 is retracted (drops out of the reduce)
  for (const c of checks) {
    if (c.index === 1) continue;
    ow('green', wf, c.run, c.outputs[0], '--value', JSON.stringify({ ok: true }));
    ow('close', wf, c.run);
  }
  const c1 = checks.find((x: any) => x.index === 1);
  ow('retract', wf, 'gather.source[1]', '--by', 'check', '--text', 'paywalled');
  ow('close', wf, c1.run, '--outcome', 'skipped');

  // greening the draft on the *pre-retract* synth run must born-reject: an input moved
  // Use raw() because born-rejected now exits non-zero; stdout still carries the JSON result.
  const staleRaw = raw(db, ['green', wf, synth.run, 'draft', '--value', JSON.stringify({ answer: 'v1' })]);
  const stale = JSON.parse(staleRaw.stdout.trim());
  assert.equal(stale.outcome, 'born-rejected', JSON.stringify(stale));
  ow('close', wf, synth.run, '--outcome', 'failed');

  // a fresh reduce over the surviving sources greens cleanly
  const synth2 = orderFor(ow('tick', wf), 'synth');
  assert.equal(ow('green', wf, synth2.run, 'draft', '--value', JSON.stringify({ answer: 'v2' })).outcome, 'green');
  ow('close', wf, synth2.run);

  const st = ow('status', wf);
  assert.equal(st.done, true, JSON.stringify(st.debts));

  const arts = ow('show', wf);
  assert.equal(arts.find((a: any) => a.path === 'gather.source[1]').acceptance, 'retracted');
  assert.equal(arts.find((a: any) => a.path === 'draft').acceptance, 'green');
  assert.deepEqual(arts.find((a: any) => a.path === 'draft').value, { answer: 'v2' });

  rmSync(join(db, '..'), { recursive: true, force: true });
});

test('delivery: a PR knocked back to the cap stalls, then `retry` clears it', () => {
  const db = tmpDb();
  const ow = makeCli(db);
  const wf = ow('create', 'delivery', '--provide', `proposal=${JSON.stringify({ text: 'x' })}`).workflow;
  ow('green', wf, orderFor(ow('tick', wf), 'planner').run, 'plan', '--value', JSON.stringify({ plan: 'v1' }));

  // build → reject until the builder is no longer re-armed (stalled at its cap)
  let guard = 0;
  for (;;) {
    assert.ok(++guard <= 20, 'pr should have stalled by now');
    const builder = ow('tick', wf).orders.find((o: any) => o.step === 'builder');
    if (!builder) break; // not re-armed → stalled
    ow('green', wf, builder.run, 'pr', '--value', JSON.stringify({ pr: guard }));
    ow('close', wf, builder.run);
    const reviewer = orderFor(ow('tick', wf), 'reviewer');
    ow('reject', wf, 'pr', '--by', 'reviewer', '--text', `unfit #${guard}`);
    ow('close', wf, reviewer.run, '--outcome', 'no_work');
  }

  const pr = ow('status', wf).debts.find((d: any) => d.path === 'pr');
  assert.equal(pr.stalled, true);
  assert.equal(pr.kind, 'judgment');

  // clear the stall with guidance; the builder re-arms with a reset count
  ow('retry', wf, 'pr', '--text', 'use the new harness');
  const b2 = orderFor(ow('tick', wf), 'builder');
  assert.equal(b2.owes.find((w: any) => w.path === 'pr').judgmentRejects, 0);
  assert.ok(b2.owes.find((w: any) => w.path === 'pr').reasons.at(-1).text.includes('use the new harness'));

  // and the pipeline now completes
  ow('green', wf, b2.run, 'pr', '--value', JSON.stringify({ pr: 'final' }));
  ow('close', wf, b2.run);
  let o = orderFor(ow('tick', wf), 'reviewer');
  ow('green', wf, o.run, 'verdict', '--value', JSON.stringify({ ok: true }));
  ow('close', wf, o.run);
  o = orderFor(ow('tick', wf), 'merger');
  ow('green', wf, o.run, 'merge', '--value', JSON.stringify({ sha: 'z' }), '--terminal');
  ow('close', wf, o.run);
  assert.equal(ow('status', wf).done, true);

  rmSync(join(db, '..'), { recursive: true, force: true });
});

test('a crash-steping producer surfaces failedRuns in status and the bulk status --all', () => {
  const db = tmpDb();
  const ow = makeCli(db);
  const wf = ow('create', 'delivery', '--provide', `proposal=${JSON.stringify({ text: 'x' })}`).workflow;

  // the planner claims and closes `failed` three times without greening — a
  // crash step, which §6 never stalls (judgmentRejects stays 0)
  for (let i = 0; i < 3; i++) {
    const planner = orderFor(ow('tick', wf), 'planner');
    ow('close', wf, planner.run, '--outcome', 'failed');
  }

  const plan = ow('status', wf).debts.find((d: any) => d.path === 'plan');
  assert.equal(plan.failedRuns, 3, 'single-instance status carries the streak');
  assert.equal(plan.stalled, false, 'a crash step is not a §6 judgment stall');

  // the bulk fleet read derives the same per-debt counter in one process
  const entry = ow('status', '--all').find((e: any) => e.workflow === wf);
  assert.equal(entry.debts.find((d: any) => d.path === 'plan').failedRuns, 3);

  // a clean close breaks the streak: plan greens, so it is no longer a debt
  const ok = orderFor(ow('tick', wf), 'planner');
  ow('green', wf, ok.run, 'plan', '--value', JSON.stringify({ plan: 'v1' }));
  ow('close', wf, ok.run);
  assert.equal(ow('status', wf).debts.find((d: any) => d.path === 'plan'), undefined);

  rmSync(join(db, '..'), { recursive: true, force: true });
});

test('a seedOwed input gates the pipeline until `provide` supplies it', () => {
  const db = tmpDb();
  const ow = makeCli(db);

  // create WITHOUT --provide: proposal is owed, so nothing is eligible yet
  const wf = ow('create', 'delivery').workflow;
  let st = ow('status', wf);
  assert.equal(st.done, false);
  assert.ok(st.debts.some((d: any) => d.path === 'proposal'), 'proposal should be an open debt');
  assert.ok(st.blocked.some((b: any) => b.step === 'planner' && b.blockedOn.includes('proposal')));
  assert.deepEqual(ow('tick', wf).orders, [], 'no orders while the input is owed');

  // supply it — now the planner is eligible
  ow('provide', wf, 'proposal', '--value', JSON.stringify({ text: 'ship it' }));
  st = ow('status', wf);
  assert.ok(!st.debts.some((d: any) => d.path === 'proposal'), 'proposal is settled');
  const t = ow('tick', wf);
  assert.deepEqual(t.orders.map((o: any) => o.step), ['planner']);
  assert.deepEqual(t.orders[0].consumes, { proposal: { text: 'ship it' } });

  rmSync(join(db, '..'), { recursive: true, force: true });
});

test('CLI surfaces errors as non-zero exit + stderr', () => {
  const db = tmpDb();

  // unknown command
  const bad = raw(db, ['frobnicate']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown command/);

  // unknown workflow definition
  const noDef = raw(db, ['create', 'nope']);
  assert.equal(noDef.status, 1);
  assert.match(noDef.stderr, /unknown workflow definition/);

  // operating on a non-existent instance
  const noWf = raw(db, ['status', 'wf_does_not_exist']);
  assert.equal(noWf.status, 1);
  assert.match(noWf.stderr, /no such workflow instance/);

  rmSync(join(db, '..'), { recursive: true, force: true });
});

test('list and defs reflect created instances', () => {
  const db = tmpDb();
  const ow = makeCli(db);

  const expectedDefNames = exampleDefNames(DEFS);
  assert.ok(expectedDefNames.length >= 5, 'sanity: examples/workflows should yield several defs, not a degenerate/empty set');
  assert.deepEqual(ow('defs').map((d: any) => d.name).sort(), expectedDefNames);
  assert.deepEqual(ow('list'), []);

  const wf = ow('create', 'delivery', '--title', 'Dark mode', '--provide', `proposal=${JSON.stringify({ text: 'x' })}`).workflow;
  const list = ow('list');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, wf);
  assert.equal(list[0].def, 'delivery');
  assert.equal(list[0].title, 'Dark mode');
  assert.equal(list[0].done, false);

  ow('delete', wf);
  assert.deepEqual(ow('list'), []);

  rmSync(join(db, '..'), { recursive: true, force: true });
});

// ---- §28: instance-to-definition pinning ------------------------------------

test('§28: an in-flight instance stays pinned to its original def shape after the source YAML is edited, and `adopt` re-wires it deliberately', () => {
  const db = tmpDb();
  const defsDir = mkdtempSync(join(tmpdir(), 'owenloop-e2e-pin-'));
  const yamlPath = join(defsDir, 'pinnable.yaml');
  const ow = makeCliAgainst(db, defsDir);

  const original = [
    'name: pinnable',
    'inputs:',
    '  - name: proposal',
    'steps:',
    '  - name: planner',
    '    consumes: [proposal]',
    '    produces: [plan]',
    '    body: "original prompt"',
    '  - name: builder',
    '    consumes: [plan]',
    '    produces: [pr]',
    '    terminal: true',
    '',
  ].join('\n');
  writeFileSync(yamlPath, original);

  // 1. Create an instance against the original shape.
  const wf = ow('create', 'pinnable', '--provide', `proposal=${JSON.stringify({ text: 'ship it' })}`).workflow;
  let st = ow('status', wf);
  assert.equal(st.defDrift, false, 'no drift yet — the source has not moved');

  // 2. Edit the YAML on disk: change planner's body AND add a brand-new step
  // (notifier) so there's both a "changed prompt" and a "fresh debt" to prove
  // out.
  const edited = [
    'name: pinnable',
    'inputs:',
    '  - name: proposal',
    'steps:',
    '  - name: planner',
    '    consumes: [proposal]',
    '    produces: [plan]',
    '    body: "brand new prompt"',
    '  - name: builder',
    '    consumes: [plan]',
    '    produces: [pr]',
    '  - name: notifier',
    '    consumes: [pr]',
    '    produces: [notice]',
    '    terminal: true',
    '',
  ].join('\n');
  writeFileSync(yamlPath, edited);

  // 3. tick the ALREADY-CREATED instance: it must still behave per the
  // ORIGINAL (pinned) shape — planner's prompt/body must still be the old
  // one, not the new one, and no 'notice' debt should appear (that step
  // doesn't exist in the pinned snapshot).
  const t1 = ow('tick', wf);
  const plannerOrder = orderFor(t1, 'planner');
  assert.match(plannerOrder.prompt, /original prompt/, 'pinned instance must use the ORIGINAL body, not the edited one');

  ow('green', wf, plannerOrder.run, 'plan', '--value', JSON.stringify({ v: 1 }));
  ow('close', wf, plannerOrder.run);

  st = ow('status', wf);
  assert.ok(!st.debts.some((d: any) => d.path === 'notice'), 'pinned instance must not know about the notifier step added after it was created');

  // 4. status now reports defDrift: true — the live def has moved on.
  st = ow('status', wf);
  assert.equal(st.defDrift, true);

  // 5. Deliberately adopt the new shape.
  const adoptRes = ow('adopt', wf);
  assert.equal(adoptRes.ok, true);
  assert.equal(adoptRes.workflow, wf);
  assert.equal(typeof adoptRes.defHash, 'string');
  assert.equal(typeof adoptRes.previousHash, 'string');
  assert.notEqual(adoptRes.defHash, adoptRes.previousHash);

  // 6. subsequent status: drift is cleared, and the new notifier debt has
  // materialized (proves settle() ran as part of adopt).
  st = ow('status', wf);
  assert.equal(st.defDrift, false);
  assert.ok(st.debts.some((d: any) => d.path === 'notice'), 'adopt must settle() so the new notifier debt materializes immediately');

  // 7. the instance now behaves per the NEW shape on the next tick: builder
  // is no longer terminal, and a subsequent notifier step is reachable once
  // pr is greened.
  builder: {
    const tb = ow('tick', wf);
    const builderOrder = orderFor(tb, 'builder');
    ow('green', wf, builderOrder.run, 'pr', '--value', JSON.stringify({ n: 1 }));
    ow('close', wf, builderOrder.run);
  }
  const tn = ow('tick', wf);
  const notifierOrder = orderFor(tn, 'notifier');
  assert.ok(notifierOrder, 'notifier step (only present in the adopted shape) is now reachable');

  rmSync(join(db, '..'), { recursive: true, force: true });
  rmSync(defsDir, { recursive: true, force: true });
});
