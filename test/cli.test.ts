/**
 * CLI surface tests, driven IN-PROCESS through `main(argv, io)` with an injected
 * `CliIO`. This exercises argv parsing, JSON validation, command dispatch, exit
 * codes, and the stdout/stderr contract directly (the e2e files spawn the binary
 * as a subprocess, which is the real integration check but can't attribute branch
 * coverage). Fast, and lets us assert the precise error text for every bad input.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';

const EXAMPLES = join(import.meta.dirname, '..', 'examples', 'workflows');

/** A CLI bound to a fresh temp db + a cwd; returns captured streams + exit code. */
function makeCli(opts: { defs?: string; setDbEnv?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'oweflow-cli-'));
  const db = join(home, 'state.db');
  const env: Record<string, string | undefined> = { OWEFLOW_DEFS: opts.defs ?? EXAMPLES };
  if (opts.setDbEnv !== false) env.OWEFLOW_DB = db;
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
  assert.match(r.out, /^oweflow — a dataflow workflow engine/);
});

test('help / --help / -h all print usage', () => {
  const { run } = makeCli();
  for (const h of ['help', '--help', '-h']) {
    const r = run(h);
    assert.equal(r.code, 0, h);
    assert.match(r.out, /Usage: oweflow <command>/, h);
  }
});

test('an unknown command exits 1 and echoes usage', () => {
  const { run } = makeCli();
  const r = run('frobnicate');
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown command: frobnicate/);
  assert.match(r.err, /Usage: oweflow/, 'usage is included to orient the user');
});

// ---- the full lifecycle, in-process -----------------------------------------

test('a full delivery happy path runs end to end through main()', () => {
  const { run } = makeCli();

  assert.deepEqual(run('defs').json().map((d: any) => d.name).sort(), ['delivery', 'intake', 'research', 'routing']);
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
  for (const [loop, out, value, terminal] of steps) {
    const order = run('tick', wf).json().orders.find((o: any) => o.loop === loop);
    assert.ok(order, `order for ${loop}`);
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
  const gatherRun = run('tick', wf).json().orders.find((o: any) => o.loop === 'gather').run;

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
    const order = run('tick', wf).json().orders.find((o: any) => o.loop === 'builder');
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
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  // re-open against a defs dir that no longer contains 'delivery' — status can't be derived
  const noDefs = mkdtempSync(join(tmpdir(), 'oweflow-nodefs-'));
  const out: string[] = [];
  const code = main(['list'], { cwd: home, env: { OWEFLOW_DB: db, OWEFLOW_DEFS: noDefs }, out: (s) => out.push(s), err: () => {} });
  const list = JSON.parse(out.join('\n'));
  assert.equal(code, 0, 'list still succeeds');
  assert.equal(list[0].id, wf, 'the instance is still listed');
  assert.equal(list[0].done, null, 'done is null when the def is missing, not a crash');
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
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  // re-open against a defs dir without 'delivery' — status can't be derived
  const noDefs = mkdtempSync(join(tmpdir(), 'oweflow-nodefs-'));
  const out: string[] = [];
  const code = main(['status', '--all'], { cwd: home, env: { OWEFLOW_DB: db, OWEFLOW_DEFS: noDefs }, out: (s) => out.push(s), err: () => {} });
  const all = JSON.parse(out.join('\n'));
  assert.equal(code, 0, 'the fleet read still succeeds');
  assert.equal(all.length, 1);
  assert.equal(all[0].workflow, wf, 'identity is still reported from the stored row');
  assert.match(all[0].error, /unknown workflow definition/, 'status failure degrades to an error field');
  assert.equal(all[0].done, undefined, 'no derived status when the def is missing');
});

// ---- store/path defaulting --------------------------------------------------

test('with no --db or OWEFLOW_DB, the store defaults under cwd/.oweflow', () => {
  const { run, home } = makeCli({ setDbEnv: false });
  const r = run('list'); // any command that opens the store
  assert.equal(r.code, 0);
  assert.ok(existsSync(join(home, '.oweflow', 'state.db')), 'created the default db path');
});
