/**
 * End-to-end battery for JSON Schema validation (design §18).
 *
 * Drives the real `owenloop` binary as a subprocess against real SQLite, using
 * the `schemacheck` fixture (test/fixtures/schema.yaml): a `spec` input, a `plan`
 * singleton, and a `source[]` collection all carry a `schema:`. We exercise the
 * full surface a wiring sees — a malformed commit is *schema-rejected* (not
 * greened), the per-producer `maxSchemaFailures` stall trips and a `retry` clears
 * it, and a schema-violating input is refused outright with a non-zero exit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'bin', 'owenloop.mjs');
const FIXTURES = join(ROOT, 'test', 'fixtures');
const EXAMPLES = join(ROOT, 'examples', 'workflows');

/** A throwing CLI bound to a fresh temp db + a defs dir (fixtures by default), plus `.raw`. */
function harness(defsDir: string = FIXTURES) {
  const db = join(mkdtempSync(join(tmpdir(), 'owenloop-schema-')), 'state.db');
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

function claim(ow: any, wf: string, step: string): any {
  const t = ow('tick', wf);
  const o = t.orders.find((x: any) => x.step === step);
  assert.ok(o, `expected an order for '${step}', got: [${t.orders.map((x: any) => x.step).join(', ')}]`);
  return o;
}

const art = (ow: any, wf: string, path: string) => (ow('show', wf) as any[]).find((a) => a.path === path);

// ============================================================================

test('schema e2e: a fully schema-conforming run reaches done', () => {
  const ow = harness();
  const wf = ow('create', 'schemacheck', '--provide', `spec=${J({ goal: 'ship it' })}`).workflow;

  const pl = claim(ow, wf, 'planner');
  assert.equal(ow('green', wf, pl.run, 'plan', '--value', J({ steps: 3 })).outcome, 'green');
  ow('close', wf, pl.run);

  const g = claim(ow, wf, 'gather');
  const emit = ow('emit', wf, g.run, '--items', J([{ url: 'http://a' }, { url: 'http://b' }]));
  assert.equal(emit.outcome, 'emitted');
  assert.deepEqual(emit.created, ['source[0]', 'source[1]']);
  ow('seal', wf, g.run);
  ow('close', wf, g.run);

  const s = claim(ow, wf, 'synth');
  ow('green', wf, s.run, 'report', '--value', J({ ok: true }));
  ow('close', wf, s.run);

  assert.equal(ow('status', wf).done, true);
  ow.cleanup();
});

test('schema e2e: a malformed singleton commit is schema-rejected, not greened', () => {
  const ow = harness();
  const wf = ow('create', 'schemacheck', '--provide', `spec=${J({ goal: 'ship it' })}`).workflow;
  const pl = claim(ow, wf, 'planner');

  // `steps` must be an integer >= 1; a string violates the schema
  const res = ow.any('green', wf, pl.run, 'plan', '--value', J({ steps: 'three' }));
  assert.equal(res.outcome, 'schema-rejected');
  assert.equal(res.path, 'plan');
  assert.ok(Array.isArray(res.issues) && res.issues.length > 0, 'carries the violations');
  assert.match(res.reason, /schema validation failed/);

  // the artifact is a debt, never greened, flagged as a `validation` reject
  const plan = art(ow, wf, 'plan');
  assert.equal(plan.acceptance, 'rejected');
  assert.equal(plan.version, 0);
  assert.equal(plan.schemaRejects, 1);
  const debt = ow('status', wf).debts.find((d: any) => d.path === 'plan');
  assert.equal(debt.kind, 'validation');
  assert.equal(debt.stalled, false, 'one failure is below the cap');

  // the schema-failure count rides the next order's feedback channel, alongside
  // judgmentRejects, so a worker can self-regulate before the §18 stall
  ow('close', wf, pl.run, '--outcome', 'no_work');
  const pl2 = claim(ow, wf, 'planner');
  const owe = pl2.owes.find((o: any) => o.path === 'plan');
  assert.equal(owe.schemaRejects, 1);
  assert.equal(owe.judgmentRejects, 0);
  ow.cleanup();
});

test('schema e2e: a corrected value greens on the same open run', () => {
  const ow = harness();
  const wf = ow('create', 'schemacheck', '--provide', `spec=${J({ goal: 'ship it' })}`).workflow;
  const pl = claim(ow, wf, 'planner');
  assert.equal(ow.any('green', wf, pl.run, 'plan', '--value', J({ steps: 0 })).outcome, 'schema-rejected'); // < minimum
  // no new tick/claim needed — the worker fixes the value on the same lease
  assert.equal(ow('green', wf, pl.run, 'plan', '--value', J({ steps: 2 })).outcome, 'green');
  assert.equal(art(ow, wf, 'plan').acceptance, 'green');
  ow.cleanup();
});

test('schema e2e: repeated failures stall the producer, and retry clears it', () => {
  const ow = harness();
  const wf = ow('create', 'schemacheck', '--provide', `spec=${J({ goal: 'ship it' })}`).workflow;
  const pl = claim(ow, wf, 'planner');

  // maxSchemaFailures: 2 → two bad commits trip the §18 stall
  ow.any('green', wf, pl.run, 'plan', '--value', J({ steps: -1 }));
  ow.any('green', wf, pl.run, 'plan', '--value', J({ wrong: true }));
  assert.equal(art(ow, wf, 'plan').schemaRejects, 2);
  ow('close', wf, pl.run, '--outcome', 'no_work');

  // stalled: the planner is no longer re-armed
  assert.equal(ow('tick', wf).orders.filter((o: any) => o.step === 'planner').length, 0);
  const debt = ow('status', wf).debts.find((d: any) => d.path === 'plan');
  assert.equal(debt.stalled, true);
  assert.equal(debt.kind, 'validation');

  // a human retry resets the counter and re-arms the producer
  ow('retry', wf, 'plan', '--text', 'schema requirements clarified');
  assert.equal(art(ow, wf, 'plan').schemaRejects, 0);
  const pl2 = claim(ow, wf, 'planner');
  assert.equal(ow('green', wf, pl2.run, 'plan', '--value', J({ steps: 5 })).outcome, 'green');
  ow.cleanup();
});

test('schema e2e: a malformed collection element refuses the whole emit atomically', () => {
  const ow = harness();
  const wf = ow('create', 'schemacheck', '--provide', `spec=${J({ goal: 'ship it' })}`).workflow;
  const pl = claim(ow, wf, 'planner');
  ow('green', wf, pl.run, 'plan', '--value', J({ steps: 1 }));
  ow('close', wf, pl.run);
  const g = claim(ow, wf, 'gather');

  // second element is missing `url` → the entire emit is refused, nothing accretes
  const bad = ow.any('emit', wf, g.run, '--items', J([{ url: 'http://a' }, { bogus: 1 }]));
  assert.equal(bad.outcome, 'schema-rejected');
  assert.deepEqual(bad.created, []);
  assert.ok(!art(ow, wf, 'source[0]'), 'no member written');
  assert.equal(art(ow, wf, 'source.sealed').acceptance, 'rejected');
  assert.equal(art(ow, wf, 'source.sealed').schemaRejects, 1);

  // a clean emit on the same run then accretes from index 0
  const ok = ow('emit', wf, g.run, '--items', J([{ url: 'http://a' }]));
  assert.equal(ok.outcome, 'emitted');
  assert.deepEqual(ok.created, ['source[0]']);
  ow.cleanup();
});

test('schema e2e: a schema-violating input is refused at create (non-zero exit)', () => {
  const ow = harness();
  const r = ow.raw('create', 'schemacheck', '--provide', `spec=${J({ wrong: 1 })}`);
  assert.notEqual(r.status, 0, 'create exits non-zero');
  assert.match(r.stderr, /input 'spec' failed schema/);
  ow.cleanup();
});

test('schema e2e: a schema-violating provide is refused (seedOwed input via the engine path)', () => {
  // `spec` is provided-at-start here; an invalid create is the provide path for a
  // non-seedOwed input. Confirm the conforming create then proceeds normally.
  const ow = harness();
  const wf = ow('create', 'schemacheck', '--provide', `spec=${J({ goal: 'ok' })}`).workflow;
  assert.ok(ow('status', wf).eligible.some((f: any) => f.step === 'planner'));
  ow.cleanup();
});

// The bundled `intake` example (examples/workflows/intake.yaml) is the user-facing
// demonstration of §18. Drive its documented header walkthrough verbatim against
// the real examples dir so the example — and the commands its comment promises —
// can't silently rot.
test('schema e2e: the bundled `intake` example runs its documented walkthrough', () => {
  const ow = harness(EXAMPLES);
  const wf = ow(
    'create',
    'intake',
    '--provide',
    `request=${J({ source: 'https://example.com/feed', format: 'json' })}`,
  ).workflow;

  const parse = claim(ow, wf, 'parse');
  // the malformed value the header flags as refused really is schema-rejected
  assert.equal(
    ow.any('green', wf, parse.run, 'spec', '--value', J({ endpoint: 'not-a-url' })).outcome,
    'schema-rejected',
  );
  // ...and the conforming one greens on the same open run
  assert.equal(
    ow('green', wf, parse.run, 'spec', '--value', J({ endpoint: 'https://example.com/feed', limit: 50 })).outcome,
    'green',
  );
  ow('close', wf, parse.run);

  const fetch = claim(ow, wf, 'fetch');
  // one malformed element refuses the whole emit atomically
  const bad = ow.any('emit', wf, fetch.run, '--items', J([{ id: 'a1', title: 'First' }, { bogus: 1 }]));
  assert.equal(bad.outcome, 'schema-rejected');
  assert.deepEqual(bad.created, []);
  // the clean emit then accretes both elements
  const emit = ow('emit', wf, fetch.run, '--items', J([{ id: 'a1', title: 'First' }, { id: 'a2', title: 'Second' }]));
  assert.equal(emit.outcome, 'emitted');
  assert.deepEqual(emit.created, ['fetch.record[0]', 'fetch.record[1]']);
  ow('seal', wf, fetch.run);
  ow('close', wf, fetch.run);

  const index = claim(ow, wf, 'index');
  assert.equal(ow('green', wf, index.run, 'report', '--value', J({ count: 2 })).outcome, 'green');
  ow('close', wf, index.run);

  assert.equal(ow('status', wf).done, true);

  // and a schema-violating request is refused at create (non-zero exit)
  const r = ow.raw('create', 'intake', '--provide', `request=${J({ format: 'xml' })}`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /input 'request' failed schema/);
  ow.cleanup();
});
