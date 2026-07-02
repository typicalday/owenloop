/**
 * CLI surface tests, driven IN-PROCESS through `main(argv, io)` with an injected
 * `CliIO`. This exercises argv parsing, JSON validation, command dispatch, exit
 * codes, and the stdout/stderr contract directly (the e2e files spawn the binary
 * as a subprocess, which is the real integration check but can't attribute branch
 * coverage). Fast, and lets us assert the precise error text for every bad input.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../src/cli.ts';
import { exampleDefNames } from './helpers.ts';

const EXAMPLES = join(import.meta.dirname, '..', 'examples', 'workflows');

/** A CLI bound to a fresh temp db + a cwd; returns captured streams + exit code. */
function makeCli(opts: { defs?: string; setDbEnv?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-cli-'));
  const db = join(home, 'state.db');
  const env: Record<string, string | undefined> = { OWENLOOP_DEFS: opts.defs ?? EXAMPLES };
  if (opts.setDbEnv !== false) env.OWENLOOP_DB = db;
  const run = (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, { cwd: home, env, out: (s) => out.push(s), err: (s) => err.push(s) });
    const outText = out.join('\n');
    return {
      code,
      out: outText,
      err: err.join('\n'),
      json: () => JSON.parse(outText),
    };
  };
  return { run, home, db };
}

const J = (v: unknown) => JSON.stringify(v);

// ---- usage / help / unknown command -----------------------------------------

test('no command prints usage and exits 0', () => {
  const { run } = makeCli();
  const r = run();
  assert.equal(r.code, 0);
  assert.match(r.out, /^owenloop — a dataflow workflow engine/);
});

test('help / --help / -h all print usage', () => {
  const { run } = makeCli();
  for (const h of ['help', '--help', '-h']) {
    const r = run(h);
    assert.equal(r.code, 0, h);
    assert.match(r.out, /Usage: owenloop <command>/, h);
  }
});

test('an unknown command exits 1 and echoes usage', () => {
  const { run } = makeCli();
  const r = run('frobnicate');
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown command: frobnicate/);
  assert.match(r.err, /Usage: owenloop/, 'usage is included to orient the user');
});

test('opening a downgraded database via the CLI exits 1 with a clear stderr message', () => {
  const { run, db } = makeCli();
  const first = run('list');
  assert.equal(first.code, 0, 'first open on a fresh db succeeds and creates schema');

  // Simulate a newer binary having stamped a higher schema_version directly
  // on the same db file the CLI just created.
  const raw = new DatabaseSync(db);
  raw.exec(`INSERT INTO meta (k, v) VALUES ('schema_version', '99') ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
  raw.close();

  const second = run('list');
  assert.equal(second.code, 1, 'reopening a newer-schema db must exit non-zero');
  assert.match(second.err, /schema_version/i);
  assert.match(second.err, /newer|upgrade/i, 'message should tell the operator to upgrade');
});

// ---- the full lifecycle, in-process -----------------------------------------

test('a full delivery happy path runs end to end through main()', () => {
  const { run } = makeCli();

  const expectedDefNames = exampleDefNames(EXAMPLES);
  assert.ok(expectedDefNames.length >= 5, 'sanity: examples/workflows should yield several defs, not a degenerate/empty set');
  assert.deepEqual(run('defs').json().map((d: any) => d.name).sort(), expectedDefNames);
  assert.deepEqual(run('list').json(), []);

  const wf = run('create', 'delivery', '--title', 'Dark mode', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  assert.match(wf, /^wf_/);
  assert.equal(run('list').json()[0].title, 'Dark mode');

  const steps: Array<[string, string, Record<string, unknown>, boolean?]> = [
    ['planner', 'plan', { plan: 'v1' }],
    ['builder', 'pr', { pr: '#1' }],
    ['reviewer', 'verdict', { ok: true }],
    ['merger', 'merge', { sha: 'abc' }, true],
  ];
  for (const [step, out, value, terminal] of steps) {
    const order = run('tick', wf).json().orders.find((o: any) => o.step === step);
    assert.ok(order, `order for ${step}`);
    const argv = ['green', wf, order.run, out, '--value', J(value)];
    if (terminal) argv.push('--terminal');
    assert.equal(run(...argv).json().outcome, 'green');
    run('close', wf, order.run);
  }
  const st = run('status', wf).json();
  assert.equal(st.done, true);
  assert.ok(run('show', wf).json().some((a: any) => a.path === 'merge' && a.terminal === true));

  assert.equal(run('delete', wf).json().deleted, wf);
  assert.deepEqual(run('list').json(), []);
});

// ---- delete: refuses children unless --recursive ----------------------------

test('delete refuses a workflow with children unless --recursive is passed', () => {
  const { run } = makeCli();

  // provisioned-delivery: provision -> deliver (calls: delivery) -> teardown
  const parent = run(
    'create',
    'provisioned-delivery',
    '--provide',
    `proposal=${J({ text: 'x' })}`,
  ).json().workflow;

  const provOrder = run('tick', parent).json().orders.find((o: any) => o.step === 'provision');
  assert.ok(provOrder, 'provision order');
  run('green', parent, provOrder.run, 'sandbox', '--value', J({ env: 'test' }));
  run('close', parent, provOrder.run);

  // Tick again: maintainCalls spawns the child `delivery` instance.
  run('tick', parent);
  const children = run('list').json().filter((w: any) => w.id !== parent);
  assert.equal(children.length, 1, 'child instance should be spawned via calls:');

  const refused = run('delete', parent);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /child instance/);
  assert.match(refused.err, /--recursive/);
  // parent must still exist after the refusal
  assert.ok(run('list').json().some((w: any) => w.id === parent));

  const ok = run('delete', parent, '--recursive');
  assert.equal(ok.code, 0);
  assert.equal(ok.json().deleted, parent);
  assert.deepEqual(run('list').json(), [], 'parent and child both gone');
});

// ---- JSON validation on --value / --provide / --items -----------------------

test('--value must be a JSON object, not an array / scalar / null', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const planRun = run('tick', wf).json().orders[0].run;
  for (const bad of ['[1,2]', '"a string"', '42', 'null', 'true']) {
    const r = run('green', wf, planRun, 'plan', '--value', bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /expected a JSON object/, bad);
  }
  // and syntactically invalid JSON is a distinct, clearer error
  const r = run('green', wf, planRun, 'plan', '--value', '{not json');
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid JSON/);
});

test('green with no --value defaults to an empty object', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const planRun = run('tick', wf).json().orders[0].run;
  const r = run('green', wf, planRun, 'plan'); // no --value
  assert.equal(r.code, 0);
  assert.equal(r.json().outcome, 'green');
  assert.deepEqual(run('show', wf).json().find((a: any) => a.path === 'plan').value, {});
});

test('--provide rejects a malformed pair and malformed JSON', () => {
  const { run } = makeCli();
  const noEq = run('create', 'delivery', '--provide', 'proposal'); // missing '='
  assert.equal(noEq.code, 1);
  assert.match(noEq.err, /expected name=value/);

  const badJson = run('create', 'delivery', '--provide', 'proposal={bad');
  assert.equal(badJson.code, 1);
  assert.match(badJson.err, /invalid JSON for 'proposal'/);
});

test('emit rejects malformed and non-array --items', () => {
  const { run } = makeCli();
  const wf = run('create', 'research', '--provide', `question=${J({})}`).json().workflow;
  const gatherRun = run('tick', wf).json().orders.find((o: any) => o.step === 'gather').run;

  const notJson = run('emit', wf, gatherRun, '--items', '[{bad');
  assert.equal(notJson.code, 1);
  assert.match(notJson.err, /--items must be a JSON array/);

  const notArray = run('emit', wf, gatherRun, '--items', J({ url: 'a' }));
  assert.equal(notArray.code, 1);
  assert.match(notArray.err, /--items must be a JSON array/);

  const missing = run('emit', wf, gatherRun); // no --items at all
  assert.equal(missing.code, 1);
  assert.match(missing.err, /missing required option: --items/);
});

// ---- arg-parsing forms & optional-defaulting commands -----------------------

test('inline --key=value is parsed the same as a separated option', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--title=Inline title', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  assert.equal(run('list').json()[0].title, 'Inline title');
});

test('tick --now=<ms> drives the clock deterministically (rate fixture)', () => {
  const { run } = makeCli({ defs: join(import.meta.dirname, 'fixtures') });
  const wf = run('create', 'rate', '--provide', `seed=${J({})}`).json().workflow;
  const T0 = 1_700_000_000_000;
  const first = run('tick', wf, `--now=${T0}`).json();
  assert.equal(first.orders.length, 1);
  run('close', wf, first.orders[0].run, '--outcome', 'no_work');
  // 30 minutes later: under the 1h cadence → held back
  assert.equal(run('tick', wf, `--now=${T0 + 30 * 60_000}`).json().orders.length, 0);
});

// ---- runs / reap --------------------------------------------------------------

test('runs: lists closed and open runs, joining claim state only for the open one', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  // First run: claim, green, close — a closed run with no claim-state fields.
  const r1 = run('tick', wf).json().orders[0];
  run('green', wf, r1.run, 'plan', '--value', J({ plan: 'v1' }));
  run('close', wf, r1.run);

  // Second run: builder claims `pr`, left open (not greened/closed).
  const r2 = run('tick', wf).json().orders.find((o: any) => o.step === 'builder');
  assert.ok(r2, 'builder order should be available after planner closed');

  const rows = run('runs', wf).json();
  assert.equal(rows.length, 2);

  const closedRow = rows.find((r: any) => r.run === r1.run);
  assert.equal(closedRow.step, 'planner');
  assert.equal(closedRow.outcome, 'ok');
  assert.equal(closedRow.claimedAt, undefined, 'a closed run carries no claim-state fields');
  assert.equal(closedRow.attempts, undefined);

  const openRow = rows.find((r: any) => r.run === r2.run);
  assert.equal(openRow.step, 'builder');
  assert.equal(openRow.outcome, 'open');
  assert.equal(typeof openRow.claimedAt, 'number');
  assert.equal(typeof openRow.attempts, 'number');
  assert.ok(openRow.claimAgeMs >= 0);
});

test('runs --open: returns only the open run, with its claim join populated', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const order = run('tick', wf).json().orders[0]; // planner, left open
  const rows = run('runs', wf, '--open').json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run, order.run);
  assert.equal(rows[0].step, 'planner');
  assert.equal(typeof rows[0].claimedAt, 'number');
  assert.equal(typeof rows[0].attempts, 'number');
  assert.ok(rows[0].claimAgeMs >= 0);
  assert.equal(typeof rows[0].heartbeatAgeMs, 'undefined', 'no heartbeat sent yet');
});

test('reap --now clears a fresh claim (admin stand-down) and invalidates its run', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const order = run('tick', wf).json().orders[0]; // planner claimed, well within the 2h default TTL
  const r = run('reap', wf, '--now');
  assert.equal(r.code, 0);
  const body = r.json();
  assert.equal(body.reaped, 1, '--now forces the fresh claim stale regardless of real TTL');
  assert.equal(body.details.length, 1);
  assert.equal(body.details[0].step, 'planner');
  assert.equal(body.details[0].key, '');
  assert.equal(body.details[0].run, order.run);

  // The old run no longer holds its lease — green/close on it must fail loudly.
  const g = run('green', wf, order.run, 'plan', '--value', J({ plan: 'v1' }));
  assert.equal(g.code, 1);
  assert.match(g.err, /no longer holds its lease|reaped or superseded/);
});

test('reap (no --now) leaves a fresh claim alone', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const order = run('tick', wf).json().orders[0];
  const r = run('reap', wf);
  assert.equal(r.code, 0);
  const body = r.json();
  assert.equal(body.reaped, 0, 'a fresh claim is well within the default TTL');
  assert.deepEqual(body.details, []);

  // The run still holds its lease — green/close still succeeds normally.
  assert.equal(run('green', wf, order.run, 'plan', '--value', J({ plan: 'v1' })).json().outcome, 'green');
  assert.equal(run('close', wf, order.run).json().outcome, 'ok');
});

test('reap: unknown workflow is a labelled error', () => {
  const { run } = makeCli();
  const r = run('reap', 'wf_nope');
  assert.equal(r.code, 1);
  assert.match(r.err, /workflow not found: wf_nope/);
});

test('close defaults its outcome to "ok" when --outcome is omitted', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const r = run('tick', wf).json().orders[0].run;
  run('green', wf, r, 'plan', '--value', J({ plan: 'v1' }));
  assert.equal(run('close', wf, r).json().outcome, 'ok');
});

test('a bare retry (no --by/--text) clears a stall with default guidance', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  run('green', wf, run('tick', wf).json().orders[0].run, 'plan', '--value', J({ plan: 'v1' }));
  // knock pr back until the builder stops being re-armed (stalled at the cap)
  let guard = 0;
  for (;;) {
    const order = run('tick', wf).json().orders.find((o: any) => o.step === 'builder');
    if (!order || guard++ > 10) break;
    run('green', wf, order.run, 'pr', '--value', J({ pr: '#x' }));
    run('close', wf, order.run); // close so the builder re-arms on the next reject
    run('reject', wf, 'pr', '--by', 'reviewer', '--text', 'no');
  }
  assert.equal(run('status', wf).json().debts.find((d: any) => d.path === 'pr').stalled, true);
  const r = run('retry', wf, 'pr'); // bare — exercises the human/default-guidance branch
  assert.equal(r.code, 0);
  assert.equal(r.json().action, 'retry');
  assert.equal(run('status', wf).json().debts.find((d: any) => d.path === 'pr').stalled, false);
});

test('missing positional args fail with a labelled error', () => {
  const { run } = makeCli();
  assert.match(run('status').err, /missing required argument: workflow/);
  assert.match(run('green', 'wf_x', 'run_y').err, /missing required argument: path/);
  assert.match(run('create').err, /missing required argument: def/);
});

test('list tolerates a workflow whose definition is no longer available (done: null)', () => {
  const { run, db, home } = makeCli();
  // §28: `create` now always pins a snapshot, so a normally-created instance
  // survives its def going missing (see the dedicated pinning test below,
  // "list keeps working off the pin..."). To exercise the true legacy path —
  // an un-pinned row with no snapshot to fall back on — insert one directly,
  // the same way store.test.ts's legacy-row tests do, bypassing `create`.
  run('list'); // ensures the db file + schema exist before we poke it directly
  const raw = new DatabaseSync(db);
  raw.prepare(
    `INSERT INTO workflow (id, def, title, params, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('wf_legacy_no_pin', 'delivery', null, '{}', Date.now());
  raw.close();

  // re-open against a defs dir that no longer contains 'delivery' — status can't be derived
  const noDefs = mkdtempSync(join(tmpdir(), 'owenloop-nodefs-'));
  const out: string[] = [];
  const code = main(['list'], { cwd: home, env: { OWENLOOP_DB: db, OWENLOOP_DEFS: noDefs }, out: (s) => out.push(s), err: () => {} });
  const list = JSON.parse(out.join('\n'));
  assert.equal(code, 0, 'list still succeeds');
  assert.equal(list[0].id, 'wf_legacy_no_pin', 'the instance is still listed');
  assert.equal(list[0].done, null, 'done is null when the def is missing and there is no pin to fall back on');
});

test('§28: list keeps working off the pin for a normally-created instance even after its def goes missing', () => {
  const { run, db, home } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  // re-open against a defs dir that no longer contains 'delivery' — a
  // pre-pinning instance would have degraded to done: null (see the test
  // above); a pinned instance keeps deriving real status off its snapshot.
  const noDefs = mkdtempSync(join(tmpdir(), 'owenloop-nodefs-'));
  const out: string[] = [];
  const code = main(['list'], { cwd: home, env: { OWENLOOP_DB: db, OWENLOOP_DEFS: noDefs }, out: (s) => out.push(s), err: () => {} });
  const list = JSON.parse(out.join('\n'));
  assert.equal(code, 0);
  assert.equal(list[0].id, wf);
  assert.equal(list[0].done, false, 'the pinned instance still derives a real status, not null');
});

// ---- status --all (the fleet read) ------------------------------------------

test('status --all returns one full status entry per instance, with identity + task key', () => {
  const { run } = makeCli();
  assert.deepEqual(run('status', '--all').json(), [], 'empty fleet is an empty array');

  const a = run('create', 'delivery', '--title', 'A', '--provide', `proposal=${J({ text: 'x' })}`, '--param', 'task=t_aaa').json().workflow;
  const b = run('create', 'research', '--title', 'B', '--provide', `question=${J({})}`).json().workflow;

  const all = run('status', '--all').json();
  assert.equal(all.length, 2);
  const byWf: Record<string, any> = Object.fromEntries(all.map((e: any) => [e.workflow, e]));

  // identity + join key + the full derived status, all in one call
  const ea = byWf[a];
  assert.equal(ea.def, 'delivery');
  assert.equal(ea.title, 'A');
  assert.equal(ea.task, 't_aaa', 'the --param task is surfaced as the join key');
  assert.equal(typeof ea.done, 'boolean');
  assert.ok(Array.isArray(ea.debts) && Array.isArray(ea.eligible) && Array.isArray(ea.blocked));

  // an instance created without --param task reports a null join key
  assert.equal(byWf[b].task, null);
  assert.equal(byWf[b].def, 'research');
});

test('status --all isolates an instance whose definition is missing (error field, no crash)', () => {
  const { run, db, home } = makeCli();
  // §28: `create` now always pins a snapshot, so this test — which is
  // specifically about the "def missing entirely, no way to derive status"
  // path — needs a genuinely un-pinned (pre-pinning-era) row. Insert one
  // directly, same as the analogous `list` test above.
  run('status', '--all'); // ensures the db file + schema exist before we poke it directly
  const raw = new DatabaseSync(db);
  raw.prepare(
    `INSERT INTO workflow (id, def, title, params, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('wf_legacy_no_pin', 'delivery', null, '{}', Date.now());
  raw.close();

  // re-open against a defs dir without 'delivery' — status can't be derived
  const noDefs = mkdtempSync(join(tmpdir(), 'owenloop-nodefs-'));
  const out: string[] = [];
  const code = main(['status', '--all'], { cwd: home, env: { OWENLOOP_DB: db, OWENLOOP_DEFS: noDefs }, out: (s) => out.push(s), err: () => {} });
  const all = JSON.parse(out.join('\n'));
  assert.equal(code, 0, 'the fleet read still succeeds');
  assert.equal(all.length, 1);
  assert.equal(all[0].workflow, 'wf_legacy_no_pin', 'identity is still reported from the stored row');
  assert.match(all[0].error, /unknown workflow definition/, 'status failure degrades to an error field');
  assert.equal(all[0].done, undefined, 'no derived status when the def is missing and there is no pin to fall back on');
});

test('§28: status --all keeps deriving real status for a pinned instance even after its def goes missing', () => {
  const { run, db, home } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const noDefs = mkdtempSync(join(tmpdir(), 'owenloop-nodefs-'));
  const out: string[] = [];
  const code = main(['status', '--all'], { cwd: home, env: { OWENLOOP_DB: db, OWENLOOP_DEFS: noDefs }, out: (s) => out.push(s), err: () => {} });
  const all = JSON.parse(out.join('\n'));
  assert.equal(code, 0);
  assert.equal(all.length, 1);
  assert.equal(all[0].workflow, wf);
  assert.equal(all[0].error, undefined, 'no error — the pin makes the live def unnecessary');
  assert.equal(typeof all[0].done, 'boolean', 'real derived status from the pinned snapshot');
});

test('status --all surfaces a producer crash step (consecutive failedRuns) per debt', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  // the planner claims and closes `failed` three times without greening — a
  // crash step that §6 never stalls (judgmentRejects stays 0)
  for (let i = 0; i < 3; i++) {
    const order = run('tick', wf).json().orders.find((o: any) => o.step === 'planner');
    assert.ok(order, `planner order on attempt ${i + 1}`);
    run('close', wf, order.run, '--outcome', 'failed');
  }

  const entry = run('status', '--all').json().find((e: any) => e.workflow === wf);
  const plan = entry.debts.find((d: any) => d.path === 'plan');
  assert.equal(plan.failedRuns, 3, 'the bulk fleet read carries the crash-step streak');
  assert.equal(plan.stalled, false, 'a crash step is not a §6 judgment stall');
  // a clean close clears it on the next read
  const order = run('tick', wf).json().orders.find((o: any) => o.step === 'planner');
  run('green', wf, order.run, 'plan', '--value', J({ plan: 'v1' }));
  run('close', wf, order.run);
  const after = run('status', '--all').json().find((e: any) => e.workflow === wf);
  assert.equal(after.debts.find((d: any) => d.path === 'plan'), undefined, 'plan is green — no longer a debt');
});

test('status --all rejects a trailing workflow positional (one or all is ambiguous)', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const r = run('status', '--all', wf);
  assert.equal(r.code, 1, 'contradictory args exit 1');
  assert.match(r.err, /takes no workflow argument/);
});

test('status --all reports a finished instance as done with no debts', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  // drive the whole pipeline to its terminal merge
  const step = (step: string, path: string, terminal = false) => {
    const order = run('tick', wf).json().orders.find((o: any) => o.step === step);
    assert.ok(order, `${step} order`);
    const args = ['green', wf, order.run, path, '--value', J({ ok: true })];
    if (terminal) args.push('--terminal');
    run(...args);
    run('close', wf, order.run);
  };
  step('planner', 'plan');
  step('builder', 'pr');
  step('reviewer', 'verdict');
  step('merger', 'merge', true);

  const entry = run('status', '--all').json().find((e: any) => e.workflow === wf);
  assert.equal(entry.done, true, 'the finished instance reads done in the fleet');
  assert.deepEqual(entry.debts, [], 'a done instance owes nothing');
  assert.deepEqual(entry.eligible, [], 'and has no eligible steps');
});

// ---- wait --------------------------------------------------------------------

test('wait --until eligible returns immediately when a step is already eligible', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const r = run('wait', wf, '--until', 'eligible', '--timeout', '5s');
  assert.equal(r.code, 0);
  const body = r.json();
  assert.ok(body.eligible.length > 0, 'planner should already be eligible right after create');
});

test('wait --until done returns immediately when the workflow is already fully green', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const step = (step: string, path: string, terminal = false) => {
    const order = run('tick', wf).json().orders.find((o: any) => o.step === step);
    assert.ok(order, `${step} order`);
    const args = ['green', wf, order.run, path, '--value', J({ ok: true })];
    if (terminal) args.push('--terminal');
    run(...args);
    run('close', wf, order.run);
  };
  step('planner', 'plan');
  step('builder', 'pr');
  step('reviewer', 'verdict');
  step('merger', 'merge', true);

  const r = run('wait', wf, '--until', 'done', '--timeout', '5s');
  assert.equal(r.code, 0);
  assert.equal(r.json().done, true);
});

test('wait --until eligible times out when the condition is never met', () => {
  const { run } = makeCli();
  // A freshly created instance with nothing provided has no eligible steps
  // yet in some defs, but `delivery` seeds `plan` as eligible immediately —
  // use a workflow that is already fully done, so `eligible` stays empty.
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const step = (step: string, path: string, terminal = false) => {
    const order = run('tick', wf).json().orders.find((o: any) => o.step === step);
    const args = ['green', wf, order.run, path, '--value', J({ ok: true })];
    if (terminal) args.push('--terminal');
    run(...args);
    run('close', wf, order.run);
  };
  step('planner', 'plan');
  step('builder', 'pr');
  step('reviewer', 'verdict');
  step('merger', 'merge', true);

  // now the workflow is done: it will never become eligible again
  const r = run('wait', wf, '--until', 'eligible', '--timeout', '1s');
  assert.equal(r.code, 1);
  const body = r.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'timeout');
  assert.equal(body.until, 'eligible');
});

test('wait --until done times out when the condition is never met', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const r = run('wait', wf, '--until', 'done', '--timeout', '1s');
  assert.equal(r.code, 1);
  const body = r.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, 'timeout');
  assert.equal(body.until, 'done');
});

test('wait: bad --until value exits 1 with a labelled error, no polling attempted', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const r = run('wait', wf, '--until', 'frobnicate');
  assert.equal(r.code, 1);
  assert.match(r.err, /--until must be "eligible" or "done"/);
});

test('wait: bad --timeout value exits 1 mentioning --timeout', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const r = run('wait', wf, '--until', 'eligible', '--timeout', 'nope');
  assert.equal(r.code, 1);
  assert.match(r.err, /--timeout:/);
});

test('wait: missing workflow positional fails with the standard labelled error', () => {
  const { run } = makeCli();
  const r = run('wait');
  assert.match(r.err, /missing required argument: workflow/);
});

test('wait on an unknown workflow id fails the same way plain status does', () => {
  const { run } = makeCli();
  const statusErr = run('status', 'wf_does_not_exist').err;
  const waitErr = run('wait', 'wf_does_not_exist', '--until', 'done').err;
  assert.equal(statusErr, waitErr, 'wait must not invent a new error path for an unknown workflow');
});

test('wait: omitting --timeout does not throw (default kicks in silently)', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  // Already-eligible case exercises "no --timeout given" without waiting
  // out the real 10-minute default.
  const r = run('wait', wf, '--until', 'eligible');
  assert.equal(r.code, 0);
});

// ---- store/path defaulting --------------------------------------------------

test('with no --db or OWENLOOP_DB, the store defaults under cwd/.owenloop', () => {
  const { run, home } = makeCli({ setDbEnv: false });
  const r = run('list'); // any command that opens the store
  assert.equal(r.code, 0);
  assert.ok(existsSync(join(home, '.owenloop', 'state.db')), 'created the default db path');
});

// ---- owenloop lint ------------------------------------------------------------

test('owenloop lint exits 0 for clean definitions and prints JSON', () => {
  const { run } = makeCli();
  const r = run('lint');
  assert.equal(r.code, 0);
  const results = r.json();
  assert.ok(Array.isArray(results));
  assert.ok(results.every((x: any) => 'def' in x && Array.isArray(x.errors) && Array.isArray(x.warnings)));
  assert.ok(results.every((x: any) => x.errors.length === 0), 'example defs should have no errors');
});

test('owenloop lint <name> exits 0 and returns a single object', () => {
  const { run } = makeCli();
  const r = run('lint', 'delivery');
  assert.equal(r.code, 0);
  const result = r.json();
  assert.equal(result.def, 'delivery');
  assert.deepEqual(result.errors, []);
});

test('owenloop lint exits non-zero when a definition has wiring errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lint-bad-'));
  writeFileSync(
    join(dir, 'broken.yaml'),
    'name: broken\ninputs:\n  - name: seed\nsteps:\n  - name: a\n    consumes: [seed]\n    produces: [mid]\n  - name: b\n    consumes: [ghost]\n    produces: [out]\n    terminal: true\n',
  );
  const { run } = makeCli({ defs: dir });
  const r = run('lint');
  assert.equal(r.code, 1, 'exits non-zero when errors are present');
  const results = r.json();
  const broken = results.find((x: any) => x.def === 'broken');
  assert.ok(broken, 'broken def is in the output');
  assert.ok(broken.errors.length > 0, 'broken def has errors');
});

test('owenloop lint exits 0 when a def has warnings but no errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lint-warn-'));
  writeFileSync(
    join(dir, 'warned.yaml'),
    'name: warned\ninputs:\n  - name: seed\nsteps:\n  - name: a\n    consumes: [seed]\n    produces: [useful, orphan]\n  - name: b\n    consumes: [useful]\n    produces: [done]\n    terminal: true\n',
  );
  const { run } = makeCli({ defs: dir });
  const r = run('lint');
  assert.equal(r.code, 0, 'exits 0 when only warnings');
  const results = r.json();
  const warned = results.find((x: any) => x.def === 'warned');
  assert.ok(warned.warnings.length > 0, 'has at least one warning');
  assert.deepEqual(warned.errors, []);
});

// ---- trace command ----------------------------------------------------------

test('trace outputs valid JSON with timeline and artifacts fields', () => {
  const { run } = makeCli();

  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  // Run the planner so there is at least one run in the history
  const plannerOrder = run('tick', wf).json().orders[0];
  assert.ok(plannerOrder);
  run('green', wf, plannerOrder.run, 'plan', '--value', J({ plan: 'v1' }));
  run('close', wf, plannerOrder.run);

  const r = run('trace', wf);
  assert.equal(r.code, 0, r.err);
  const trace = r.json();
  assert.ok(Array.isArray(trace.timeline), 'has timeline array');
  assert.ok(Array.isArray(trace.artifacts), 'has artifacts array');
  assert.ok(trace.timeline.length >= 1, 'timeline has at least one event');
  assert.equal(trace.timeline[0].step, 'planner');
  assert.equal(trace.timeline[0].seq, 1);
  assert.ok(typeof trace.summary.done === 'boolean');
});

test('trace --format text is non-empty and contains a step name and outcome', () => {
  const { run } = makeCli();

  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const plannerOrder = run('tick', wf).json().orders[0];
  run('green', wf, plannerOrder.run, 'plan', '--value', J({ plan: 'v1' }));
  run('close', wf, plannerOrder.run);

  const r = run('trace', wf, '--format', 'text');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.length > 0, 'text output is non-empty');
  assert.match(r.out, /planner/, 'output contains step name "planner"');
  assert.match(r.out, /ok/, 'output contains outcome "ok"');
  assert.match(r.out, /Timeline/, 'output contains Timeline header');
  assert.match(r.out, /Artifacts/, 'output contains Artifacts header');
});

test('trace on a workflow with no runs still succeeds with empty timeline', () => {
  const { run } = makeCli();

  // Create but never tick — no runs at all
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const r = run('trace', wf);
  assert.equal(r.code, 0);
  const trace = r.json();
  assert.deepEqual(trace.timeline, [], 'no runs means empty timeline');
  assert.ok(Array.isArray(trace.artifacts), 'artifacts still present');
  assert.equal(trace.summary.totalRuns, 0);
});

test('trace exits 1 when workflow argument is missing', () => {
  const { run } = makeCli();
  const r = run('trace');
  assert.equal(r.code, 1);
  assert.match(r.err, /missing required argument: workflow/);
});

// ---- graph command ----------------------------------------------------------

test('graph <def-name> emits DOT containing digraph and node ids', () => {
  const { run } = makeCli();
  const r = run('graph', 'delivery');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /digraph/);
  assert.match(r.out, /planner/);
  assert.match(r.out, /proposal/);
});

test('graph --format mermaid emits flowchart', () => {
  const { run } = makeCli();
  const r = run('graph', 'delivery', '--format', 'mermaid');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /flowchart/);
  assert.match(r.out, /-->/);
});

test('graph <wf-id> emits overlay-colored DOT', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  // Drive planner to green so at least one node is colored
  const order = run('tick', wf).json().orders[0];
  run('green', wf, order.run, 'plan', '--value', J({ plan: 'v1' }));
  run('close', wf, order.run);

  const r = run('graph', wf);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /digraph/);
  assert.match(r.out, /fillcolor/, 'overlay colors present');
});

test('graph --format json emits the structured WorkflowGraph', () => {
  const { run } = makeCli();
  const r = run('graph', 'delivery', '--format', 'json');
  assert.equal(r.code, 0, r.err);
  const g = r.json();
  assert.equal(g.def, 'delivery');
  assert.ok(Array.isArray(g.nodes), 'has nodes array');
  assert.ok(Array.isArray(g.edges), 'has edges array');
  assert.equal(typeof g.hasOverlay, 'boolean');
});

test('graph with an unknown arg exits 1 with a helpful message listing known defs', () => {
  const { run } = makeCli();
  const r = run('graph', 'no-such-thing');
  assert.equal(r.code, 1);
  assert.match(r.err, /neither a known workflow definition/);
  assert.match(r.err, /delivery/, 'error lists known def names');
});

test('graph missing arg exits 1 with labelled error', () => {
  const { run } = makeCli();
  const r = run('graph');
  assert.equal(r.code, 1);
  assert.match(r.err, /missing required argument/);
});

// ---- green/emit/seal exit-code contract -------------------------------------

test('green: clean success exits 0 and still prints the result JSON', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const planRun = run('tick', wf).json().orders[0].run;
  const r = run('green', wf, planRun, 'plan', '--value', J({ plan: 'v1' }));
  assert.equal(r.code, 0);
  assert.equal(r.json().outcome, 'green');
  assert.equal(r.err, '');
});

test('green: born-rejected exits non-zero and still prints result JSON', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  // Drive planner: green plan, close run
  const planRun = run('tick', wf).json().orders.find((o: any) => o.step === 'planner').run;
  assert.equal(run('green', wf, planRun, 'plan', '--value', J({ plan: 'v1' })).code, 0);
  run('close', wf, planRun);
  // Claim builder (fingerprints plan@v1)
  const builderRun = run('tick', wf).json().orders.find((o: any) => o.step === 'builder').run;
  // Reject plan from builder's perspective (builder consumes plan, so has authority)
  run('reject', wf, 'plan', '--by', 'builder', '--text', 'changed my mind');
  // Green pr from builder — plan no longer green => CAS mismatch => born-rejected
  const r = run('green', wf, builderRun, 'pr', '--value', J({ url: 'pr/1' }));
  assert.equal(r.code, 1);
  const j = r.json();
  assert.equal(j.outcome, 'born-rejected');
  assert.match(r.err, /born-rejected/);
});

test('reject: a stale judge verdict (CAS mismatch) exits non-zero and reports born-rejected, not a silent success', () => {
  // Reproduces the judged-research.yaml walkthrough's judge-reject call
  // (`owenloop reject $wf report --by researcher.report.judges.rigor ...`)
  // in the specific race §24.4/§4.6 guards against: the judge's order was
  // claimed against an older `report` version that has since moved on
  // (here, a sibling judge already rejected it first), so this judge's
  // reject must be refused as born-rejected — not silently reported ok.
  const { run } = makeCli();
  const wf = run('create', 'judged-research', '--provide', `question=${J({ text: 'why is the sky blue' })}`).json().workflow;

  const researcherRun = run('tick', wf).json().orders.find((o: any) => o.step === 'researcher').run;
  assert.equal(run('green', wf, researcherRun, 'report', '--value', J({ sections: ['intro'] })).code, 0);
  run('close', wf, researcherRun);

  // Both judge orders claim against the same (now `submitted`) report version.
  const judgeOrders = run('tick', wf).json().orders;
  const completenessStep = 'researcher.report.judges.completeness';
  const rigorStep = 'researcher.report.judges.rigor';
  assert.ok(judgeOrders.some((o: any) => o.step === completenessStep));
  assert.ok(judgeOrders.some((o: any) => o.step === rigorStep));

  // completeness rejects first — report leaves `submitted`, re-arming researcher.
  const r1 = run('reject', wf, 'report', '--by', completenessStep, '--text', 'missing a section');
  assert.equal(r1.code, 0);
  assert.equal(r1.json().outcome, 'rejected');

  // rigor's in-flight verdict for that same (now-stale) submission arrives late.
  const r2 = run('reject', wf, 'report', '--by', rigorStep, '--text', 'no citations for claim 2');
  assert.equal(r2.code, 1, 'a stale judge reject must exit non-zero, not report a false success');
  const j2 = r2.json();
  assert.equal(j2.outcome, 'born-rejected');
  assert.match(r2.err, /born-rejected/);
});

test('reject: retract and skip are unaffected — still exit 0 with { ok: true } on a normal (non-judge) reject', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const planRun = run('tick', wf).json().orders[0].run;
  assert.equal(run('green', wf, planRun, 'plan', '--value', J({ plan: 'v1' })).code, 0);
  run('close', wf, planRun);

  // A plain (non-judge) reject on a normal artifact — no CAS guard applies,
  // this is the ordinary consumer-invalidation path and must stay a clean success.
  const r = run('reject', wf, 'plan', '--by', 'builder', '--text', 'needs rework');
  assert.equal(r.code, 0);
  const j = r.json();
  assert.equal(j.ok, true);
  assert.equal(j.action, 'reject');
  assert.equal(j.outcome, 'rejected');
});

test('green: schema-rejected exits non-zero and still prints result JSON', () => {
  const FIXTURES = join(import.meta.dirname, 'fixtures');
  const { run } = makeCli({ defs: FIXTURES });
  const wf = run('create', 'schemacheck', '--provide', `spec=${J({ goal: 'test' })}`).json().workflow;
  const order = run('tick', wf).json().orders[0];
  // steps must be integer >= 1 per schema; send a string to violate it
  const r = run('green', wf, order.run, 'plan', '--value', J({ steps: 'not-a-number' }));
  assert.equal(r.code, 1);
  assert.equal(r.json().outcome, 'schema-rejected');
  assert.match(r.err, /schema-rejected/);
});

test('emit: schema-rejected exits non-zero and still prints result JSON', () => {
  const FIXTURES = join(import.meta.dirname, 'fixtures');
  const { run } = makeCli({ defs: FIXTURES });
  const wf = run('create', 'schemacheck', '--provide', `spec=${J({ goal: 'test' })}`).json().workflow;
  // Drive planner to green so gather becomes available
  const planOrder = run('tick', wf).json().orders[0];
  run('green', wf, planOrder.run, 'plan', '--value', J({ steps: 1 }));
  run('close', wf, planOrder.run);
  // Now gather is ready
  const gatherOrder = run('tick', wf).json().orders[0];
  // Emit an item violating the schema (url must be a non-empty string)
  const r = run('emit', wf, gatherOrder.run, '--items', J([{ noturl: 'bad' }]));
  assert.equal(r.code, 1);
  assert.notEqual(r.json().outcome, 'emitted');
  assert.ok(r.err.length > 0);
});

// ---- §28: instance-to-definition pinning (adopt, status defDrift) ----------

/** Two temp defs dirs, both defining a workflow named 'pinnable', with a
 *  structural difference (dirB adds a 'notifier' step off 'verdict' producing
 *  'notice', a fresh debt to prove adopt's settle() ran). Mirrors the "reopen
 *  main() against a different OWENLOOP_DEFS, same db" pattern already used by
 *  the `list`/`status --all` "definition missing" tests above — the closest
 *  precedent in this file for varying the live def between two CLI calls. */
function pinnableDefDirs(): { dirA: string; dirB: string } {
  const dirA = mkdtempSync(join(tmpdir(), 'owenloop-pin-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'owenloop-pin-b-'));
  const yamlA = [
    'name: pinnable',
    'inputs:',
    '  - name: proposal',
    'steps:',
    '  - name: planner',
    '    consumes: [proposal]',
    '    produces: [plan]',
    '  - name: builder',
    '    consumes: [plan]',
    '    produces: [pr]',
    '  - name: reviewer',
    '    consumes: [pr]',
    '    produces: [verdict]',
    '    terminal: true',
    '',
  ].join('\n');
  const yamlB = [
    'name: pinnable',
    'inputs:',
    '  - name: proposal',
    'steps:',
    '  - name: planner',
    '    consumes: [proposal]',
    '    produces: [plan]',
    '  - name: builder',
    '    consumes: [plan]',
    '    produces: [pr]',
    '  - name: reviewer',
    '    consumes: [pr]',
    '    produces: [verdict]',
    '  - name: notifier',
    '    consumes: [verdict]',
    '    produces: [notice]',
    '    terminal: true',
    '',
  ].join('\n');
  writeFileSync(join(dirA, 'pinnable.yaml'), yamlA);
  writeFileSync(join(dirB, 'pinnable.yaml'), yamlB);
  return { dirA, dirB };
}

test('owenloop status <wf> reports no defDrift when the live def has not changed', () => {
  const { dirA } = pinnableDefDirs();
  const { run } = makeCli({ defs: dirA });
  const wf = run('create', 'pinnable', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const status = run('status', wf).json();
  assert.equal(status.defDrift, false);
});

test('owenloop status <wf> reports defDrift: true once the live def diverges from the pin', () => {
  const { dirA, dirB } = pinnableDefDirs();
  const { run, db, home } = makeCli({ defs: dirA });
  const wf = run('create', 'pinnable', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  // Reopen main() against dirB (same db, a structurally different 'pinnable').
  const out: string[] = [];
  const code = main(['status', wf], { cwd: home, env: { OWENLOOP_DB: db, OWENLOOP_DEFS: dirB }, out: (s) => out.push(s), err: () => {} });
  assert.equal(code, 0);
  const status = JSON.parse(out.join('\n'));
  assert.equal(status.defDrift, true);
});

test('owenloop adopt <wf> re-pins to the current def and settles a newly-introduced debt', () => {
  const { dirA, dirB } = pinnableDefDirs();
  const { run, db, home } = makeCli({ defs: dirA });
  const wf = run('create', 'pinnable', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const callAgainst = (defs: string, ...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, { cwd: home, env: { OWENLOOP_DB: db, OWENLOOP_DEFS: defs }, out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join('\n'), err: err.join('\n'), json: () => JSON.parse(out.join('\n')) };
  };

  // adopt against dirB (the changed def)
  const adoptRes = callAgainst(dirB, 'adopt', wf);
  assert.equal(adoptRes.code, 0);
  const body = adoptRes.json();
  assert.equal(body.ok, true);
  assert.equal(body.workflow, wf);
  assert.equal(typeof body.defHash, 'string');
  assert.equal(typeof body.previousHash, 'string');

  // subsequent status (still against dirB) shows no drift and the new debt
  const statusRes = callAgainst(dirB, 'status', wf);
  const status = statusRes.json();
  assert.equal(status.defDrift, false);
  assert.ok(status.debts.some((d: any) => d.path === 'notice'), 'adopt must settle() the new notifier step debt');
});

test('owenloop adopt on an unknown workflow id exits non-zero with a clear message', () => {
  const { dirA } = pinnableDefDirs();
  const { run } = makeCli({ defs: dirA });
  const r = run('adopt', 'wf_does_not_exist');
  assert.equal(r.code, 1);
  assert.match(r.err, /no such workflow instance/);
});
