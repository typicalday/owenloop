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

  assert.deepEqual(run('defs').json().map((d: any) => d.name).sort(), ['delivery', 'full-cycle', 'intake', 'onboarding', 'provisioned-delivery', 'research', 'routing', 'sla-watchdog']);
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

test('status --all surfaces a producer crash loop (consecutive failedRuns) per debt', () => {
  const { run } = makeCli();
  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;

  // the planner claims and closes `failed` three times without greening — a
  // crash loop that §6 never stalls (judgmentRejects stays 0)
  for (let i = 0; i < 3; i++) {
    const order = run('tick', wf).json().orders.find((o: any) => o.loop === 'planner');
    assert.ok(order, `planner order on attempt ${i + 1}`);
    run('close', wf, order.run, '--outcome', 'failed');
  }

  const entry = run('status', '--all').json().find((e: any) => e.workflow === wf);
  const plan = entry.debts.find((d: any) => d.path === 'plan');
  assert.equal(plan.failedRuns, 3, 'the bulk fleet read carries the crash-loop streak');
  assert.equal(plan.stalled, false, 'a crash loop is not a §6 judgment stall');
  // a clean close clears it on the next read
  const order = run('tick', wf).json().orders.find((o: any) => o.loop === 'planner');
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
  const step = (loop: string, path: string, terminal = false) => {
    const order = run('tick', wf).json().orders.find((o: any) => o.loop === loop);
    assert.ok(order, `${loop} order`);
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

// ---- store/path defaulting --------------------------------------------------

test('with no --db or OWEFLOW_DB, the store defaults under cwd/.oweflow', () => {
  const { run, home } = makeCli({ setDbEnv: false });
  const r = run('list'); // any command that opens the store
  assert.equal(r.code, 0);
  assert.ok(existsSync(join(home, '.oweflow', 'state.db')), 'created the default db path');
});

// ---- oweflow lint ------------------------------------------------------------

test('oweflow lint exits 0 for clean definitions and prints JSON', () => {
  const { run } = makeCli();
  const r = run('lint');
  assert.equal(r.code, 0);
  const results = r.json();
  assert.ok(Array.isArray(results));
  assert.ok(results.every((x: any) => 'def' in x && Array.isArray(x.errors) && Array.isArray(x.warnings)));
  assert.ok(results.every((x: any) => x.errors.length === 0), 'example defs should have no errors');
});

test('oweflow lint <name> exits 0 and returns a single object', () => {
  const { run } = makeCli();
  const r = run('lint', 'delivery');
  assert.equal(r.code, 0);
  const result = r.json();
  assert.equal(result.def, 'delivery');
  assert.deepEqual(result.errors, []);
});

test('oweflow lint exits non-zero when a definition has wiring errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oweflow-lint-bad-'));
  writeFileSync(
    join(dir, 'broken.yaml'),
    'name: broken\ninputs:\n  - name: seed\nloops:\n  - name: a\n    consumes: [seed]\n    produces: [mid]\n  - name: b\n    consumes: [ghost]\n    produces: [out]\n    terminal: true\n',
  );
  const { run } = makeCli({ defs: dir });
  const r = run('lint');
  assert.equal(r.code, 1, 'exits non-zero when errors are present');
  const results = r.json();
  const broken = results.find((x: any) => x.def === 'broken');
  assert.ok(broken, 'broken def is in the output');
  assert.ok(broken.errors.length > 0, 'broken def has errors');
});

test('oweflow lint exits 0 when a def has warnings but no errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oweflow-lint-warn-'));
  writeFileSync(
    join(dir, 'warned.yaml'),
    'name: warned\ninputs:\n  - name: seed\nloops:\n  - name: a\n    consumes: [seed]\n    produces: [useful, orphan]\n  - name: b\n    consumes: [useful]\n    produces: [done]\n    terminal: true\n',
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
  assert.equal(trace.timeline[0].loop, 'planner');
  assert.equal(trace.timeline[0].seq, 1);
  assert.ok(typeof trace.summary.done === 'boolean');
});

test('trace --format text is non-empty and contains a loop name and outcome', () => {
  const { run } = makeCli();

  const wf = run('create', 'delivery', '--provide', `proposal=${J({ text: 'x' })}`).json().workflow;
  const plannerOrder = run('tick', wf).json().orders[0];
  run('green', wf, plannerOrder.run, 'plan', '--value', J({ plan: 'v1' }));
  run('close', wf, plannerOrder.run);

  const r = run('trace', wf, '--format', 'text');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.length > 0, 'text output is non-empty');
  assert.match(r.out, /planner/, 'output contains loop name "planner"');
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
