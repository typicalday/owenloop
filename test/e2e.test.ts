/**
 * End-to-end tests: drive the real `bin/oweflow.mjs` binary as a subprocess,
 * against a real on-disk SQLite database and the shipped example workflows.
 * Nothing here imports the engine directly — it goes argv → JSON → SQLite → JSON,
 * exactly as a wiring (the worker that runs orders) would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'oweflow.mjs');
const DEFS = join(ROOT, 'examples', 'workflows');

interface RawResult {
  status: number;
  stdout: string;
  stderr: string;
}

function raw(db: string, args: string[]): RawResult {
  const res = spawnSync(process.execPath, [BIN, ...args, '--db', db, '--defs', DEFS], {
    encoding: 'utf8',
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** Run the CLI, assert success, parse JSON stdout. */
function makeCli(db: string) {
  return (...args: string[]): any => {
    const r = raw(db, args);
    if (r.status !== 0) {
      throw new Error(`oweflow ${args.join(' ')} exited ${r.status}: ${r.stderr.trim()}`);
    }
    const out = r.stdout.trim();
    return out ? JSON.parse(out) : null;
  };
}

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oweflow-e2e-'));
  return join(dir, 'state.db');
}

function orderFor(tick: any, loop: string): any {
  const o = tick.orders.find((x: any) => x.loop === loop);
  assert.ok(o, `expected an order for '${loop}', got: ${tick.orders.map((x: any) => x.loop).join(', ')}`);
  return o;
}

// -----------------------------------------------------------------------------

test('delivery: full pipeline with a reviewer knock-back ends green & terminal', () => {
  const db = tmpDb();
  const ow = makeCli(db);

  const wf = ow('create', 'delivery', '--provide', `proposal=${JSON.stringify({ text: 'add dark mode' })}`).workflow;
  assert.ok(wf.startsWith('wf'), wf);

  // planner: only eligible loop at the start
  let t = ow('tick', wf);
  assert.deepEqual(t.orders.map((o: any) => o.loop), ['planner']);
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
  const ow = makeCli(db);

  const wf = ow('create', 'research', '--provide', `question=${JSON.stringify({ q: 'why is the sky blue' })}`).workflow;

  // gather: emit a collection, then seal
  let o = orderFor(ow('tick', wf), 'gather');
  const emitted = ow('emit', wf, o.run, '--items', JSON.stringify([{ url: 'a' }, { url: 'b' }, { url: 'c' }]));
  assert.deepEqual(emitted.created, ['gather.source[0]', 'gather.source[1]', 'gather.source[2]']);
  ow('seal', wf, o.run);
  ow('close', wf, o.run);

  // after the seal, the map (check ×3) and the reduce (synth) are all eligible
  const t = ow('tick', wf);
  const checks = t.orders.filter((x: any) => x.loop === 'check');
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
  const stale = ow('green', wf, synth.run, 'draft', '--value', JSON.stringify({ answer: 'v1' }));
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
    const builder = ow('tick', wf).orders.find((o: any) => o.loop === 'builder');
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

test('a crash-looping producer surfaces failedRuns in status and the bulk status --all', () => {
  const db = tmpDb();
  const ow = makeCli(db);
  const wf = ow('create', 'delivery', '--provide', `proposal=${JSON.stringify({ text: 'x' })}`).workflow;

  // the planner claims and closes `failed` three times without greening — a
  // crash loop, which §6 never stalls (judgmentRejects stays 0)
  for (let i = 0; i < 3; i++) {
    const planner = orderFor(ow('tick', wf), 'planner');
    ow('close', wf, planner.run, '--outcome', 'failed');
  }

  const plan = ow('status', wf).debts.find((d: any) => d.path === 'plan');
  assert.equal(plan.failedRuns, 3, 'single-instance status carries the streak');
  assert.equal(plan.stalled, false, 'a crash loop is not a §6 judgment stall');

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
  assert.ok(st.blocked.some((b: any) => b.loop === 'planner' && b.blockedOn.includes('proposal')));
  assert.deepEqual(ow('tick', wf).orders, [], 'no orders while the input is owed');

  // supply it — now the planner is eligible
  ow('provide', wf, 'proposal', '--value', JSON.stringify({ text: 'ship it' }));
  st = ow('status', wf);
  assert.ok(!st.debts.some((d: any) => d.path === 'proposal'), 'proposal is settled');
  const t = ow('tick', wf);
  assert.deepEqual(t.orders.map((o: any) => o.loop), ['planner']);
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

  assert.deepEqual(ow('defs').map((d: any) => d.name).sort(), ['delivery', 'full-cycle', 'intake', 'onboarding', 'provisioned-delivery', 'research', 'routing', 'sla-watchdog']);
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
