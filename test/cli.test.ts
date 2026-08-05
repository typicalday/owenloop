/**
 * CLI surface tests, driven IN-PROCESS through `main(argv, io)` with an injected
 * `CliIO`. This exercises argv parsing, JSON validation, command dispatch, exit
 * codes, and the stdout/stderr contract directly (the e2e files spawn the binary
 * as a subprocess, which is the real integration check but can't attribute branch
 * coverage). Fast, and lets us assert the precise error text for every bad input.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ASYNC_COMMANDS, classifyAddSource, COMMAND_OPTIONS, main, mainAsync, USAGE } from '../src/cli.ts';
import type { CliIO } from '../src/cli.ts';
import { ADD_JOURNAL_FILENAME } from '../src/add.ts';
import {
  defDigest,
  globalStoreRoot,
  storeIndexPath,
  workflowCoordinate,
  WORKFLOW_STORE_INDEX_FILENAME,
} from '../src/store/index.ts';
import type { BundleIngestor, BundleSource, DefDigest, PreCommitVerifier, WorkflowCoordinate } from '../src/store/index.ts';
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

test('an unknown command is rejected BEFORE the state db is created', () => {
  const { run, home } = makeCli({ setDbEnv: false });
  const r = run('frobnicate');
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown command: frobnicate/);
  assert.equal(existsSync(join(home, '.owenloop')), false, 'no .owenloop/ dir mkdir-ed for an unknown command');
});

// ---- unknown-option rejection (before any side effect) ----------------------

test('a misspelled option on a sync command exits 1, names the offender, suggests the fix', () => {
  const { run } = makeCli();
  const r = run('green', 'wf_x', 'run_x', 'plan', '--terminl');
  assert.equal(r.code, 1);
  assert.match(r.err, /--terminl/, 'names the offending option');
  assert.match(r.err, /--terminal/, 'suggests the nearest valid option');
  assert.match(r.err, /valid options for 'green'/, 'lists the valid options');
});

test('a misspelled option is rejected BEFORE openCtx creates the state db', () => {
  const { run, home } = makeCli({ setDbEnv: false });
  const r = run('create', 'delivery', '--titel', 'x');
  assert.equal(r.code, 1);
  assert.match(r.err, /--titel/);
  assert.match(r.err, /did you mean --title\?/);
  assert.equal(existsSync(join(home, '.owenloop')), false, 'guard fires ahead of the .owenloop/ mkdir');
});

test('an unknown boolean-style option (no value) is still rejected', () => {
  const { run } = makeCli();
  const r = run('status', 'wf_x', '--verbse');
  assert.equal(r.code, 1);
  assert.match(r.err, /--verbse/);
});

test('every currently-valid flag combination is still accepted (over-rejection guard)', () => {
  const { run } = makeCli({ defs: join(import.meta.dirname, 'fixtures') });
  const wf = run('create', 'rate', '--provide', `seed=${J({})}`).json().workflow;
  // multi-flag positive: --now / --shallow / repeated --capability all pass the guard.
  const r = run('tick', wf, '--now=1700000000000', '--shallow', '--capability', 'a', '--capability', 'b');
  assert.equal(r.code, 0, r.err);
  // --defs accepted (allowlisted globally) on a command that does not read it.
  assert.equal(run('list', '--defs', 'unused-dir').code, 0, 'globals allowlisted everywhere');
});

test('cmd --help prints usage and exits 0 without doing the command (sync path)', () => {
  const { run } = makeCli();
  const r = run('list', '--help');
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage: owenloop <command>/);
});

// ---- the option table is the single source of truth ------------------------

test('COMMAND_OPTIONS covers exactly the commands USAGE advertises', () => {
  // USAGE lists one command per "  <name>" line; help/--help/-h are dispatch
  // entry points, not advertised verbs, but must still be table members so the
  // help escape hatch and unknown-command detection agree.
  const advertised = new Set(
    USAGE.split('\n')
      .map((l) => /^  ([a-z][a-z-]*)\b/.exec(l)?.[1])
      .filter((x): x is string => x !== undefined),
  );
  const tableKeys = new Set(COMMAND_OPTIONS.keys());
  tableKeys.delete('help'); // help is an entry point, not a USAGE line
  assert.deepEqual([...tableKeys].sort(), [...advertised].sort());
});

test('every ASYNC_COMMANDS member has a COMMAND_OPTIONS entry (no unreachable async verb)', () => {
  for (const cmd of ASYNC_COMMANDS) {
    assert.ok(COMMAND_OPTIONS.has(cmd), `async command '${cmd}' must declare its options`);
  }
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

test('tick --now (space form) is a boolean flag now, not a value — non-numeric --now is rejected', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  // Space form: `--now` binds boolean 'true' (see BOOLEAN_FLAGS), so
  // Number('true') would be NaN without the guard — must fail loudly, not
  // silently drive the engine's clock with NaN.
  const spaceForm = run('tick', wf, '--now', '123');
  assert.equal(spaceForm.code, 1);
  assert.match(spaceForm.err, /invalid value for --now/);

  const eqForm = run('tick', wf, '--now=abc');
  assert.equal(eqForm.code, 1);
  assert.match(eqForm.err, /invalid value for --now/);
});

test('tick --capability passes the caller filter through to the engine (A2)', () => {
  // A temp def dir with two steps, one capability-routed 'claude', one 'codex'.
  const defsDir = mkdtempSync(join(tmpdir(), 'owenloop-capabilities-'));
  writeFileSync(
    join(defsDir, 'capabilitytest.yaml'),
    [
      'name: capabilitytest',
      'steps:',
      '  - name: alpha',
      '    consumes: [seed]',
      '    produces: [a]',
      '    capabilities: [claude]',
      '  - name: beta',
      '    consumes: [seed]',
      '    produces: [b]',
      '    capabilities: [codex]',
      'inputs:',
      '  - name: seed',
      '    seedOwed: true',
      '',
    ].join('\n'),
  );
  const { run } = makeCli({ defs: defsDir });
  const wf = run('create', 'capabilitytest', '--provide', `seed=${J({})}`).json().workflow;

  // A caller serving only 'claude' claims alpha, defers beta as capability-mismatch.
  const t = run('tick', wf, '--capability', 'claude').json();
  assert.deepEqual(t.orders.map((o: any) => o.step), ['alpha'], 'only the matching-capability step is claimed');
  const mismatch = t.deferred.find((d: any) => d.reason === 'capability-mismatch');
  assert.ok(mismatch, 'the disjoint step is reported capability-mismatch');
  assert.equal(mismatch.step, 'beta');
});

test('heartbeat --now=<non-numeric> is rejected, not silently NaN', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const order = run('tick', wf).json().orders[0];

  const r = run('heartbeat', wf, order.run, '--now=abc');
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid value for --now/);
});

test('check --max-depth=<non-numeric> is rejected, not silently NaN', () => {
  const { run } = makeCli();
  const r = run('check', 'delivery', '--max-depth=abc');
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid value for --max-depth/);
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

test('order: prints the persisted order packet for a run, identical to the tick output', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const order = run('tick', wf).json().orders[0]; // planner order, incl its run id
  const res = run('order', wf, order.run);
  assert.equal(res.code, 0);
  assert.deepStrictEqual(res.json(), order, 'read-back packet equals the order the tick emitted');
});

test('order: unknown run exits 1 with a run-not-found message', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  const res = run('order', wf, 'run_bogus');
  assert.equal(res.code, 1);
  assert.match(res.err, /run not found/);
});

test('order: a run queried under the wrong workflow exits 1 with a belongs-to message', () => {
  const { run } = makeCli();
  const wfA = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const wfB = run('create', 'delivery', '--provide', `proposal=${J({ text: 'y' })}`).json().workflow;

  const order = run('tick', wfA).json().orders[0];
  const res = run('order', wfB, order.run);
  assert.equal(res.code, 1);
  assert.match(res.err, /belongs to workflow/);
});

test('order: a legacy run without a persisted order exits 1 with a no-persisted-order message', () => {
  const { run, db } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  // Simulate a pre-v7 run row: order_json NULL.
  const raw = new DatabaseSync(db);
  raw
    .prepare('INSERT INTO run (id, workflow, step, key, order_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('run_legacy', wf, 'planner', '', null, 1000, 1000);
  raw.close();

  const res = run('order', wf, 'run_legacy');
  assert.equal(res.code, 1);
  assert.match(res.err, /no persisted order/);
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

test('owenloop lint reports files that fail to parse instead of silently omitting them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lint-unparseable-'));
  writeFileSync(
    join(dir, 'fine.yaml'),
    'name: fine\ninputs:\n  - name: seed\nsteps:\n  - name: a\n    consumes: [seed]\n    produces: [out]\n    terminal: true\n',
  );
  // typo'd key: buildDef rejects the shape, so the def never loads
  writeFileSync(
    join(dir, 'typo.yaml'),
    'name: typo\nsteps:\n  - name: a\n    produces: [y]\n    maxAttepts: 3\n',
  );
  const { run } = makeCli({ defs: dir });
  const r = run('lint');
  assert.equal(r.code, 1, 'a file create would refuse to load must fail lint too');
  const results = r.json();
  const failed = results.find((x: any) => x.file?.endsWith('typo.yaml'));
  assert.ok(failed, 'unparseable file appears in lint output');
  assert.match(failed.errors[0], /unknown key 'maxAttepts'/);
  const fine = results.find((x: any) => x.def === 'fine');
  assert.deepEqual(fine.errors, [], 'healthy sibling def still lints clean');
});

test("owenloop lint <name> for a def stuck in a broken file explains why it wasn't found", () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-lint-broken-name-'));
  writeFileSync(
    join(dir, 'typo.yaml'),
    'name: typo\nsteps:\n  - name: a\n    produces: [y]\n    maxAttepts: 3\n',
  );
  const { run } = makeCli({ defs: dir });
  const r = run('lint', 'typo');
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown workflow definition 'typo'/);
  assert.match(r.err, /typo\.yaml/, 'points at the file that failed to load');
  assert.match(r.err, /unknown key 'maxAttepts'/, 'includes the load error');
});

test('owenloop check on an unknown def lists files that failed to load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-check-broken-'));
  writeFileSync(join(dir, 'mangled.yaml'), 'name: mangled\nsteps: [\n');
  const { run } = makeCli({ defs: dir });
  const r = run('check', 'mangled');
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown workflow definition 'mangled'/);
  assert.match(r.err, /mangled\.yaml/, 'points at the file that failed to load');
});

test('strict-loading commands name the broken file, not just the error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owenloop-defs-broken-'));
  writeFileSync(
    join(dir, 'fine.yaml'),
    'name: fine\ninputs:\n  - name: seed\nsteps:\n  - name: a\n    consumes: [seed]\n    produces: [out]\n    terminal: true\n',
  );
  writeFileSync(
    join(dir, 'typo.yaml'),
    'name: typo\nsteps:\n  - name: a\n    produces: [y]\n    maxAttepts: 3\n',
  );
  const { run } = makeCli({ defs: dir });
  // `defs` uses the strict loader: one broken file fails the whole dir, so the
  // error must say WHICH file — otherwise a defs dir is undebuggable at size.
  const r = run('defs');
  assert.equal(r.code, 1);
  assert.match(r.err, /typo\.yaml/);
  assert.match(r.err, /unknown key 'maxAttepts'/);
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

test('emit: sealed-rejected exits non-zero after the seal has greened, on the same open lease', () => {
  const FIXTURES = join(import.meta.dirname, 'fixtures');
  const { run } = makeCli({ defs: FIXTURES });
  const wf = run('create', 'schemacheck', '--provide', `spec=${J({ goal: 'test' })}`).json().workflow;
  const planOrder = run('tick', wf).json().orders[0];
  run('green', wf, planOrder.run, 'plan', '--value', J({ steps: 1 }));
  run('close', wf, planOrder.run);
  const gatherOrder = run('tick', wf).json().orders[0];
  run('emit', wf, gatherOrder.run, '--items', J([{ url: 'a' }]));
  const sealRes = run('seal', wf, gatherOrder.run, '--value', J({}));
  assert.equal(sealRes.code, 0);

  // same open lease, late emit after the seal is already green
  const r = run('emit', wf, gatherOrder.run, '--items', J([{ url: 'b' }]));
  assert.equal(r.code, 1, 'a late emit after a green seal must exit non-zero (§11.1)');
  assert.equal(r.json().outcome, 'sealed-rejected');
  assert.match(r.err, /sealed-rejected/);

  // the lease is still open — the run can still close cleanly
  const closeRes = run('close', wf, gatherOrder.run);
  assert.equal(closeRes.code, 0);
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

// ---- §23.6.8 deep tick: tick is deep by default; --shallow scopes it --------

test('tick is deep by default (surfaces calls: child orders); --shallow scopes to this instance', () => {
  const { run } = makeCli();

  // provisioned-delivery: provision -> deliver (calls: delivery) -> teardown.
  const parent = run(
    'create',
    'provisioned-delivery',
    '--provide',
    `proposal=${J({ text: 'x' })}`,
  ).json().workflow;

  // Shallow tick: maintainCalls still spawns the child, but the result carries
  // ONLY this instance's own orders (the parent's provision), never the child's.
  const shallow = run('tick', parent, '--shallow').json();
  assert.ok(shallow.orders.length > 0, 'shallow tick still yields the parent\'s own orders');
  assert.ok(
    shallow.orders.every((o: any) => o.workflow === parent),
    '--shallow returns only the parent instance\'s orders',
  );
  const child = run('list').json().find((w: any) => w.id !== parent);
  assert.ok(child, 'the child delivery instance is spawned even under a shallow tick');

  // Deep tick (default): the spawned child's order now surfaces through the
  // parent tick, stamped with the child's own workflow id.
  const deep = run('tick', parent).json();
  const childOrder = deep.orders.find((o: any) => o.workflow === child.id);
  assert.ok(childOrder, 'a deep tick surfaces an order from the spawned child instance');
});

// ---- SEC-3: openCtx default-db path refuses a symlinked `.owenloop` ----------

test('SEC-3: default state.db under a symlinked `.owenloop` is refused; the link target gains no state.db', () => {
  // No OWENLOOP_DB / --db → the db path is the built-in default cwd/.owenloop/state.db.
  const { run, home } = makeCli({ setDbEnv: false });
  const elsewhere = mkdtempSync(join(tmpdir(), 'owenloop-clielsewhere-'));
  symlinkSync(elsewhere, join(home, '.owenloop'));

  const r = run('defs');
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /refusing to write under/);
  assert.match(r.err, /symbolic link/);
  assert.deepEqual(readdirSync(elsewhere), [], 'the symlink target directory gained no state.db');
});

test('SEC-3: an explicit --db under a plain dir skips the guard even when `.owenloop` is a symlink', () => {
  const { run, home } = makeCli({ setDbEnv: false });
  // A symlinked `.owenloop` is present, but the operator points --db elsewhere.
  symlinkSync(mkdtempSync(join(tmpdir(), 'owenloop-clielsewhere2-')), join(home, '.owenloop'));
  const realDb = join(mkdtempSync(join(tmpdir(), 'owenloop-clidb-')), 'state.db');

  const r = run('defs', '--db', realDb);
  assert.equal(r.code, 0, r.err);
  assert.equal(existsSync(realDb), true, 'the explicit db path opened normally');
});

test('SEC-3: default state.db is a symlink inside a real `.owenloop` → refused; the link target is untouched', () => {
  // A REAL `.owenloop/` (parent-dir guard passes) but `state.db` is a symlink
  // to a file elsewhere — opening the default db would follow it.
  const { run, home } = makeCli({ setDbEnv: false });
  const elsewhere = mkdtempSync(join(tmpdir(), 'owenloop-clidbtarget-'));
  const target = join(elsewhere, 'evil.db');
  writeFileSync(target, 'original');
  mkdirSync(join(home, '.owenloop'));
  symlinkSync(target, join(home, '.owenloop', 'state.db'));

  const r = run('defs');
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /refusing to write to/);
  assert.match(r.err, /symbolic link/);
  assert.equal(readFileSync(target, 'utf8'), 'original', 'the symlink target was not written through');
});

test('SEC-3: an explicit --db that is itself a symlink still opens (operator intent preserved)', () => {
  const { run, home } = makeCli({ setDbEnv: false });
  mkdirSync(join(home, '.owenloop'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'owenloop-cliexptgt-'));
  const realDb = join(elsewhere, 'real.db');
  const linkDir = mkdtempSync(join(tmpdir(), 'owenloop-cliexplink-'));
  const linkDb = join(linkDir, 'state.db');
  symlinkSync(realDb, linkDb);

  const r = run('defs', '--db', linkDb);
  assert.equal(r.code, 0, r.err);
  assert.equal(existsSync(realDb), true, 'the explicit db symlink was followed (override behavior preserved)');
});

// ---- `add` bundle route (USAGE / allowlist / classifier / --global) -------------

test('USAGE advertises the bundle add syntax, --global, and --recover --global', () => {
  assert.match(USAGE, /add <bundle\.wnlp \| https:\/\/url> \[--global\]/, 'bundle add line');
  assert.match(USAGE, /--global: ~\/\.owenloop\/workflows/, 'global store location documented');
  assert.match(USAGE, /add --recover \[--global\]/, 'global recover line');
});

test('COMMAND_OPTIONS registers --global on add (and --recover stays)', () => {
  const opts = COMMAND_OPTIONS.get('add');
  assert.ok(opts, 'add has an option table');
  assert.ok(opts!.has('global'), '--global is allowlisted on add');
  assert.ok(opts!.has('recover'), '--recover is still allowlisted on add');
});

test('classifyAddSource: owner/repo[@ref] keeps the GitHub route', () => {
  assert.deepEqual(classifyAddSource('acme/widgets'), { kind: 'github', spec: 'acme/widgets' });
  assert.deepEqual(classifyAddSource('acme/widgets@main'), {
    kind: 'github',
    spec: 'acme/widgets@main',
  });
});

test('classifyAddSource: a .wnlp path is a bundle FILE regardless of existence', () => {
  assert.deepEqual(classifyAddSource('packs/widget.wnlp'), { kind: 'file', path: 'packs/widget.wnlp' });
  assert.deepEqual(classifyAddSource('/abs/widget.wnlp'), { kind: 'file', path: '/abs/widget.wnlp' });
  assert.deepEqual(classifyAddSource('missing.wnlp'), { kind: 'file', path: 'missing.wnlp' });
});

test('classifyAddSource: http(s) URLs take the bundle route; other schemes are refused', () => {
  assert.deepEqual(classifyAddSource('https://example.com/w.wnlp'), {
    kind: 'url',
    url: 'https://example.com/w.wnlp',
  });
  assert.deepEqual(classifyAddSource('http://example.com/w.wnlp'), {
    kind: 'url',
    url: 'http://example.com/w.wnlp',
  });
  for (const bad of ['ftp://example.com/w.wnlp', 'ssh://acme/widgets', 'file:///tmp/w.wnlp']) {
    assert.throws(() => classifyAddSource(bad), (e: Error) => {
      assert.match(e.message, /unsupported source scheme/);
      assert.match(e.message, /owner\/repo\[@ref\] \(GitHub\), a local \.wnlp file, or an http\(s\) URL/);
      return true;
    }, bad);
  }
});

// ---- fake A1/A2 adapters for the CLI bundle route ----------------------------
// Same fixture discipline as test/workflow-store-install.test.ts: the "bundle"
// is plain JSON (coordinate + files + claim), the digest is computed HERE with
// node:crypto, and the fake ingestor recomputes it as the tamper gate. The
// real ~/.owenloop is never touched — HOME is injected per test.

interface CliWireManifest {
  coordinate: { namespace: string; name: string; version: string };
  files: Record<string, string>;
  claim: string;
  digest: string;
}

function cliSha256Content(
  coordinate: CliWireManifest['coordinate'],
  files: Record<string, string>,
): string {
  return createHash('sha256')
    .update(new TextEncoder().encode(JSON.stringify({ coordinate, files })))
    .digest('hex');
}

function cliValidDefYaml(name: string): string {
  return [
    `name: ${name}`,
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: worker',
    '    consumes: [seed]',
    '    produces: [out]',
    '    terminal: true',
    '    maxSchemaFailures: 0',
    '',
  ].join('\n');
}

function cliMakeBundle(name = 'widget'): CliWireManifest {
  const coordinate = { namespace: 'acme', name, version: '1.0.0' };
  const files = { 'def.yaml': cliValidDefYaml(name) };
  const digest = cliSha256Content(coordinate, files);
  return { coordinate, files, claim: digest, digest };
}

function cliBundleBytes(m: CliWireManifest): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ coordinate: m.coordinate, files: m.files, claim: m.claim }),
  );
}

function cliFakeIngestor(): BundleIngestor & { ingests: number } {
  const state = { ingests: 0 };
  return {
    ingests: 0,
    async ingest(input: {
      source: BundleSource;
      bytes: Uint8Array;
      stagingDir: string;
    }): Promise<{ coordinate: WorkflowCoordinate; digest: DefDigest }> {
      state.ingests++;
      (this as { ingests: number }).ingests = state.ingests;
      const m = JSON.parse(new TextDecoder().decode(input.bytes));
      if (cliSha256Content(m.coordinate, m.files) !== m.claim) {
        throw new Error('fake A1: bundle digest mismatch — refusing');
      }
      mkdirSync(input.stagingDir, { recursive: true });
      for (const [rel, content] of Object.entries(m.files)) {
        const full = join(input.stagingDir, rel);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, content as string);
      }
      return { coordinate: workflowCoordinate(m.coordinate), digest: defDigest(m.claim) };
    },
    async verifyInstalledObject(): Promise<void> {},
  };
}

function cliFakeVerifier(): PreCommitVerifier & { calls: number } {
  const state = { calls: 0 };
  return {
    calls: 0,
    async verify(): Promise<void> {
      state.calls++;
      (this as { calls: number }).calls = state.calls;
    },
  };
}

/** A hermetic CliIO for the async bundle route: temp HOME + cwd, captured streams. */
function makeBundleCli(opts: {
  env?: Record<string, string | undefined>;
  bundleIngestor?: BundleIngestor;
  preCommitVerifier?: PreCommitVerifier;
  fetch?: typeof globalThis.fetch;
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'owenloop-clibundle-'));
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-clibundlecwd-'));
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    cwd,
    env: { HOME: home, ...opts.env },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    bundleIngestor: opts.bundleIngestor,
    preCommitVerifier: opts.preCommitVerifier,
    fetch: opts.fetch,
  };
  const run = async (...argv: string[]) => {
    const code = await mainAsync(argv, io);
    const outText = out.join('\n');
    return { code, out: outText, err: err.join('\n'), json: () => JSON.parse(outText) };
  };
  return { run, home, cwd, io };
}

// ---- --global / --defs conflict ------------------------------------------------

test('add --global with --defs (flag) is refused with the fixed conflict message', async () => {
  const { run, home } = makeBundleCli();
  const r = await run('add', 'x.wnlp', '--global', '--defs', '/somewhere');
  assert.equal(r.code, 1);
  assert.match(r.err, /--global cannot be combined with --defs: the global store lives in the home directory/);
  assert.equal(existsSync(join(home, '.owenloop', 'workflows')), false, 'no global store was created');
});

test('add --global with OWENLOOP_DEFS set (env) is refused the same way', async () => {
  const { run } = makeBundleCli({ env: { OWENLOOP_DEFS: '/somewhere' } });
  const r = await run('add', 'x.wnlp', '--global');
  assert.equal(r.code, 1);
  assert.match(r.err, /--global cannot be combined with --defs/);
});

test('bundle add without HOME or USERPROFILE refuses instead of using ambient home', async () => {
  const { run, cwd } = makeBundleCli({
    env: { HOME: undefined, USERPROFILE: undefined },
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
  });
  const bundlePath = join(cwd, 'missing-home.wnlp');
  writeFileSync(bundlePath, cliBundleBytes(cliMakeBundle('missing-home')));

  const r = await run('add', bundlePath);
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot locate the global workflow store: set HOME or USERPROFILE/);
  assert.equal(existsSync(join(cwd, 'workflows')), false, 'no project store was created');
});

test('add GitHub source with --global is refused before any network request', async () => {
  let fetchCalls = 0;
  const fetchFn = (async () => {
    fetchCalls++;
    throw new Error('network must not be reached');
  }) as typeof globalThis.fetch;
  const { run } = makeBundleCli({ fetch: fetchFn });

  const r = await run('add', 'acme/widgets', '--global');

  assert.equal(r.code, 1);
  assert.match(r.err, /--global is only supported for \.wnlp bundle sources/);
  assert.equal(fetchCalls, 0, 'GitHub SHA/tarball fetches were not attempted');
});

test('add --recover --global with a defs override is refused too', async () => {
  const { run } = makeBundleCli({ env: { OWENLOOP_DEFS: '/somewhere' } });
  const r = await run('add', '--recover', '--global');
  assert.equal(r.code, 1);
  assert.match(r.err, /--global cannot be combined with --defs/);
});

// ---- fail-closed adapter gates at the CLI dispatch site --------------------------

test('add <bundle.wnlp> without a BundleIngestor fails closed BEFORE any commit', async () => {
  const { run, cwd } = makeBundleCli({ preCommitVerifier: cliFakeVerifier() });
  const bundlePath = join(cwd, 'w.wnlp');
  writeFileSync(bundlePath, cliBundleBytes(cliMakeBundle()));
  const r = await run('add', bundlePath);
  assert.equal(r.code, 1);
  assert.match(r.err, /BundleIngestor adapter is bound/);
  assert.match(r.err, /nothing was staged or committed/);
  assert.equal(existsSync(join(cwd, 'workflows')), false, 'no project store root created');
  assert.equal(existsSync(join(cwd, 'workflows', WORKFLOW_STORE_INDEX_FILENAME)), false);
});

test('add <bundle.wnlp> without a PreCommitVerifier fails closed BEFORE any commit', async () => {
  const { run, cwd } = makeBundleCli({ bundleIngestor: cliFakeIngestor() });
  const bundlePath = join(cwd, 'w.wnlp');
  writeFileSync(bundlePath, cliBundleBytes(cliMakeBundle()));
  const r = await run('add', bundlePath);
  assert.equal(r.code, 1);
  assert.match(r.err, /PreCommitVerifier adapter is bound/);
  assert.match(r.err, /nothing was staged or committed/);
  assert.equal(existsSync(join(cwd, 'workflows')), false, 'no project store root created');
});

// ---- bundle FILE read discipline -------------------------------------------------

test('add <missing.wnlp> names the path and reports file not found', async () => {
  const { run, cwd } = makeBundleCli({
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
  });
  const r = await run('add', join(cwd, 'missing.wnlp'));
  assert.equal(r.code, 1);
  assert.match(r.err, /could not read bundle at .*missing\.wnlp: file not found/);
});

test('add <symlink.wnlp> is refused (never read through a link)', async () => {
  const { run, cwd } = makeBundleCli({
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
  });
  const real = join(cwd, 'real.wnlp');
  writeFileSync(real, cliBundleBytes(cliMakeBundle()));
  const link = join(cwd, 'link.wnlp');
  symlinkSync(real, link);
  const r = await run('add', link);
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing bundle at .*link\.wnlp: it is a symlink/);
});

test('add <dir.wnlp> is refused (not a regular file)', async () => {
  const { run, cwd } = makeBundleCli({
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
  });
  mkdirSync(join(cwd, 'dir.wnlp'));
  const r = await run('add', join(cwd, 'dir.wnlp'));
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing bundle at .*dir\.wnlp: not a regular file/);
});

test('an oversized bundle file is refused before allocation (cap via OWENLOOP_TARBALL_MAX_BYTES)', async () => {
  const { run, cwd } = makeBundleCli({
    env: { OWENLOOP_TARBALL_MAX_BYTES: '10' },
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
  });
  const big = join(cwd, 'big.wnlp');
  writeFileSync(big, cliBundleBytes(cliMakeBundle())); // well over 10 bytes
  const r = await run('add', big);
  assert.equal(r.code, 1);
  assert.match(r.err, /over the 10-byte cap/);
});

// ---- successful installs: structured JSON out + hardened store state -------------

test('add <bundle.wnlp> installs into the PROJECT store and prints the structured result', async () => {
  const { run, cwd } = makeBundleCli({
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
  });
  const bundle = cliMakeBundle();
  const bundlePath = join(cwd, 'widget.wnlp');
  writeFileSync(bundlePath, cliBundleBytes(bundle));

  const r = await run('add', bundlePath);
  assert.equal(r.code, 0, r.err);
  const result = r.json();
  const root = join(cwd, 'workflows');
  assert.deepEqual(result, {
    ok: true,
    source: bundlePath,
    level: 'project',
    coordinate: 'acme/widget@1.0.0',
    digest: bundle.digest,
    objectPath: join(root, 'objects', 'sha256', bundle.digest),
    installed: true,
  });

  // On-disk state: hardened object + index entry keyed by coordinate.
  const defFile = join(root, 'objects', 'sha256', bundle.digest, 'def.yaml');
  assert.equal(readFileSync(defFile, 'utf8'), cliValidDefYaml('widget'));
  assert.equal(statSync(defFile).mode & 0o777, 0o444, 'installed file is read-only');
  assert.equal(statSync(join(root, 'objects', 'sha256', bundle.digest)).mode & 0o777, 0o555, 'object dir is non-writable');
  const index = JSON.parse(readFileSync(join(root, WORKFLOW_STORE_INDEX_FILENAME), 'utf8'));
  assert.deepEqual(index.entries, { 'acme/widget@1.0.0': { digest: bundle.digest, pinned: false } });
  assert.equal(existsSync(join(root, '.owenloop-staging')), false, 'staging cleared');
  assert.equal(existsSync(join(cwd, '.owenloop', ADD_JOURNAL_FILENAME)), false, 'journal removed');
});

test('fresh bundle install derives recovery markers from injected HOME only', async () => {
  const { run, cwd, home } = makeBundleCli({
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
  });
  const bundle = cliMakeBundle('hermetic-marker');
  const bundlePath = join(cwd, 'hermetic-marker.wnlp');
  writeFileSync(bundlePath, cliBundleBytes(bundle));

  const r = await run('add', bundlePath);
  assert.equal(r.code, 0, r.err);

  // The marker directory is derived from CliIO.env.HOME, not node:os homedir().
  // The successful install removes the one-shot marker file but leaves the
  // fixture-owned directory. No marker state is written under the project.
  const injectedMarkerDir = join(home, '.owenloop', 'recovery-markers');
  assert.equal(existsSync(injectedMarkerDir), true, 'marker directory belongs to injected HOME');
  assert.deepEqual(readdirSync(injectedMarkerDir), [], 'successful install removes the fixture marker');
  assert.equal(existsSync(join(cwd, '.owenloop', 'recovery-markers')), false, 'project state has no marker directory');
});

test('add relative .wnlp path resolves against injected CliIO.cwd, not process.cwd', async () => {
  const { run, cwd } = makeBundleCli({
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
  });
  const bundle = cliMakeBundle('relative');
  writeFileSync(join(cwd, 'relative.wnlp'), cliBundleBytes(bundle));

  // Put a same-named invalid file in a different process cwd. If the CLI ever
  // regresses to process.cwd(), the fake A1 adapter rejects this file instead
  // of installing the bundle from the injected CliIO.cwd.
  const processCwd = mkdtempSync(join(tmpdir(), 'owenloop-processcwd-'));
  writeFileSync(join(processCwd, 'relative.wnlp'), 'not the injected bundle');
  const previousCwd = process.cwd();
  process.chdir(processCwd);
  try {
    const r = await run('add', 'relative.wnlp');

    assert.equal(r.code, 0, r.err);
    assert.equal(r.json().source, 'relative.wnlp', 'diagnostics preserve the supplied relative path');
    assert.equal(r.json().objectPath, join(cwd, 'workflows', 'objects', 'sha256', bundle.digest));
  } finally {
    process.chdir(previousCwd);
  }
});

test('add <bundle.wnlp> --global installs under ~/.owenloop/workflows (injected HOME)', async () => {
  const { run, cwd, home } = makeBundleCli({
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
  });
  const bundle = cliMakeBundle('gadget');
  const bundlePath = join(cwd, 'gadget.wnlp');
  writeFileSync(bundlePath, cliBundleBytes(bundle));

  const r = await run('add', bundlePath, '--global');
  assert.equal(r.code, 0, r.err);
  const root = globalStoreRoot(home);
  assert.deepEqual(r.json(), {
    ok: true,
    source: bundlePath,
    level: 'global',
    coordinate: 'acme/gadget@1.0.0',
    digest: bundle.digest,
    objectPath: join(root, 'objects', 'sha256', bundle.digest),
    installed: true,
  });
  assert.equal(existsSync(join(root, 'objects', 'sha256', bundle.digest, 'def.yaml')), true);
  const index = JSON.parse(readFileSync(storeIndexPath(root), 'utf8'));
  assert.deepEqual(index.entries, { 'acme/gadget@1.0.0': { digest: bundle.digest, pinned: false } });
  assert.equal(existsSync(join(cwd, 'workflows')), false, 'no project store was created');
});

test('two bundle adds from different cwd values serialize on one canonical --defs lock', async () => {
  const sharedDefs = mkdtempSync(join(tmpdir(), 'owenloop-shared-defs-'));
  const a = makeBundleCli({
    env: { OWENLOOP_DEFS: sharedDefs },
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
  });
  const b = makeBundleCli({
    env: { OWENLOOP_DEFS: sharedDefs },
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
  });
  const bundleA = cliMakeBundle('alpha');
  const bundleB = cliMakeBundle('beta');
  writeFileSync(join(a.cwd, 'alpha.wnlp'), cliBundleBytes(bundleA));
  writeFileSync(join(b.cwd, 'beta.wnlp'), cliBundleBytes(bundleB));

  const [resultA, resultB] = await Promise.all([
    a.run('add', 'alpha.wnlp'),
    b.run('add', 'beta.wnlp'),
  ]);

  assert.equal(resultA.code, 0, resultA.err);
  assert.equal(resultB.code, 0, resultB.err);
  const index = JSON.parse(readFileSync(storeIndexPath(sharedDefs), 'utf8'));
  assert.deepEqual(index.entries, {
    'acme/alpha@1.0.0': { digest: bundleA.digest, pinned: false },
    'acme/beta@1.0.0': { digest: bundleB.digest, pinned: false },
  });
});

test('add https://url fetches the bundle through io.fetch (User-Agent + redirect: error)', async () => {
  const bundle = cliMakeBundle('remote');
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(Buffer.from(cliBundleBytes(bundle)), { status: 200 });
  }) as typeof globalThis.fetch;
  const { run, cwd } = makeBundleCli({
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
    fetch: fetchFn,
  });

  const r = await run('add', 'https://example.com/remote.wnlp');
  assert.equal(r.code, 0, r.err);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call, 'fetch was called exactly once');
  assert.equal(call.url, 'https://example.com/remote.wnlp');
  assert.equal((call.init?.headers as Record<string, string>)['User-Agent'], 'owenloop');
  assert.equal(call.init?.redirect, 'error');
  assert.deepEqual(r.json(), {
    ok: true,
    source: 'https://example.com/remote.wnlp',
    level: 'project',
    coordinate: 'acme/remote@1.0.0',
    digest: bundle.digest,
    objectPath: join(cwd, 'workflows', 'objects', 'sha256', bundle.digest),
    installed: true,
  });
});

test('add https://url surfaces a non-2xx status and commits nothing', async () => {
  const fetchFn = (async () => new Response('nope', { status: 404 })) as typeof globalThis.fetch;
  const { run, cwd } = makeBundleCli({
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
    fetch: fetchFn,
  });
  const r = await run('add', 'https://example.com/gone.wnlp');
  assert.equal(r.code, 1);
  assert.match(r.err, /could not fetch bundle from https:\/\/example\.com\/gone\.wnlp: server returned 404/);
  assert.equal(existsSync(join(cwd, 'workflows')), false);
});

test('add https://url refuses redirects instead of following them silently', async () => {
  const fetchFn = (async () => new Response('', { status: 302, headers: { location: '/elsewhere' } })) as typeof globalThis.fetch;
  const { run, cwd } = makeBundleCli({
    bundleIngestor: cliFakeIngestor(),
    preCommitVerifier: cliFakeVerifier(),
    fetch: fetchFn,
  });
  const r = await run('add', 'https://example.com/moved.wnlp');
  assert.equal(r.code, 1);
  assert.match(r.err, /could not fetch bundle from https:\/\/example\.com\/moved\.wnlp/, 'undici surfaces the redirect refusal');
  assert.equal(existsSync(join(cwd, 'workflows')), false);
});

// ---- add --recover --global -------------------------------------------------------

test('add --recover --global with nothing to recover reports recovered:false', async () => {
  const { run, home } = makeBundleCli();
  const r = await run('add', '--recover', '--global');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json(), {
    ok: true,
    recovered: false,
    message: 'nothing to recover — no interrupted install found',
  });
  assert.equal(existsSync(globalStoreRoot(home)), true, 'the global root was probed/created');
});

test('add --recover --global rolls a finalizing v2 journal forward (offline)', async () => {
  const { run, home } = makeBundleCli();
  const root = globalStoreRoot(home);
  const stagingRoot = join(root, '.owenloop-staging');
  const stagingDir = join(stagingRoot, 'stg_cli');
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, 'leftover'), 'x');
  mkdirSync(join(root, '.owenloop'), { recursive: true });
  writeFileSync(
    join(root, '.owenloop', ADD_JOURNAL_FILENAME),
    JSON.stringify({
      version: 2,
      phase: 'finalizing',
      destSegments: ['objects', 'sha256', 'f'.repeat(64)],
      stagingId: 'stg_cli',
      hadDest: true,
      root,
      metadataHash: 'a'.repeat(64),
      label: 'acme/widget@1.0.0',
    }),
  );

  const r = await run('add', '--recover', '--global');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json(), {
    ok: true,
    recovered: true,
    outcome: 'rolled-forward',
    message: 'interrupted install completed (rolled forward)',
  });
  assert.equal(existsSync(stagingRoot), false, 'staging cleared by the roll-forward');
  assert.equal(existsSync(join(root, '.owenloop', ADD_JOURNAL_FILENAME)), false, 'journal removed');
});

test('add --recover --global refuses a v1 (GitHub) journal at the global root', async () => {
  // v1 journals are the GitHub route's schema; the global store has no ledger
  // to vouch, so recovery must fail closed with the entry-point message.
  const { run, home } = makeBundleCli();
  const root = globalStoreRoot(home);
  mkdirSync(join(root, '.owenloop'), { recursive: true });
  writeFileSync(
    join(root, '.owenloop', ADD_JOURNAL_FILENAME),
    JSON.stringify({
      version: 1,
      phase: 'applying',
      source: 'acme/widgets',
      sha: 'a'.repeat(40),
      folder: 'acme-widgets-deadbeef',
      stagingId: 'stg_v1',
      hadDest: false,
      defsDir: root,
    }),
  );

  const r = await run('add', '--recover', '--global');
  assert.equal(r.code, 1);
  assert.match(r.err, /requires the GitHub recovery entry point/);
  assert.equal(existsSync(join(root, '.owenloop', ADD_JOURNAL_FILENAME)), true, 'journal preserved as evidence');
});

test('add --recover --global refuses a journal recorded against a different store root', async () => {
  const { run, home } = makeBundleCli();
  const root = globalStoreRoot(home);
  mkdirSync(join(root, '.owenloop'), { recursive: true });
  writeFileSync(
    join(root, '.owenloop', ADD_JOURNAL_FILENAME),
    JSON.stringify({
      version: 2,
      phase: 'applying',
      destSegments: ['objects', 'sha256', 'b'.repeat(64)],
      stagingId: 'stg_else',
      hadDest: false,
      root: '/tmp/some-other-store',
      metadataHash: 'c'.repeat(64),
      label: 'acme/widget@1.0.0',
    }),
  );

  const r = await run('add', '--recover', '--global');
  assert.equal(r.code, 1);
  assert.match(r.err, /journal records store root '\/tmp\/some-other-store'/);
  assert.match(r.err, /re-run against the same store root/);
});
