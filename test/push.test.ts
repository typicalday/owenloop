/**
 * `owenloop push` driven in-process through `mainAsync` with an injected
 * `fetch` mocking `GET /api/workflows` + `POST /api/create_workflow` (via
 * `makeFakeHub`, and the OAuth token endpoint for the refresh path).
 * Hermetic: `mkdtempSync` cwd + defs dir, fixture `$HOME`, fake keychain —
 * no real network, no ambient state, no client-side push ledger — every
 * diff is against the fake hub's own server-truth state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mainAsync } from '../src/cli.ts';
import { hubBindingPath, readHubBinding, writeHubBinding } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { kcHuman, kcKey, makeFakeHub, makeIo, OAUTH_METADATA, routedFetch, stallingFetch } from './hubkit.ts';
import type { HubIo, RouteHandler } from './hubkit.ts';

const ORIGIN = 'http://127.0.0.1:9';

function validDef(name: string): string {
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

function writeDefs(cwd: string, defs: Record<string, string>): void {
  const dir = join(cwd, 'workflows');
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(defs)) writeFileSync(join(dir, file), body);
}

/** Extract the def name from a create_workflow request body, so a fake hub can
 *  echo the name it acknowledged (as the real hub does) and pass strict REL-9
 *  validation. */
function defName(body: string | undefined): string {
  const yaml = typeof body === 'string' ? (JSON.parse(body) as { yaml?: string }).yaml ?? '' : '';
  return /^name:\s*(\S+)/m.exec(yaml)?.[1] ?? '';
}

const OAUTH_CRED: Credential = {
  kind: 'oauth',
  accessToken: 'mcpat_a',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3_600_000,
  clientId: 'c',
};

/** Seed a bound project + stored credential into a HubIo. */
function bind(t: HubIo, cred: Credential = OAUTH_CRED): void {
  t.store.set(kcHuman(ORIGIN), JSON.stringify(cred));
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
}

test('push: first push sends every def, all land as new on the fake hub, exits 0', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const result = JSON.parse(t.out.join('\n'));
  assert.deepEqual(result.pushed.sort(), ['bar', 'foo']);
  assert.deepEqual(result.noop, []);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 2);

  assert.equal(hub.state.get('foo')?.version, 1);
  assert.equal(hub.state.get('bar')?.version, 1);
});

// ---- validation gate must mirror `check`'s current (not stale) predicate ----

/**
 * Regression fixture for the PR #78 reject: `push`'s client-side validation
 * gate mirrored `check`'s OLD single-bucket "definite defect" predicate
 * (deadlocks>0 || stuck>0), stale after `check` was split into true-deadlock-
 * only + informational stuck. Shape: 'a' produces x (schema-stall disabled);
 * 'c' consumes x (a non-human producer, so judgment-reject IS modeled — see
 * eligibleOutcomes's hasRejectableInput gate) with maxAttempts: 1, so one
 * reject freezes y. Independently, 'd' consumes 'seed' directly and stays
 * eligible at that same state — a MOVING stuck state (identical fixture to
 * test/check.test.ts and test/add.test.ts). Zero true deadlocks, zero
 * invariant violations, the def stays completable. Before the fix, `push`'s
 * stale predicate rejected this as "definite defects found (... 0 deadlock(s),
 * N stuck state(s))" even though `owenloop check` blesses the identical def
 * with exit 0 — a self-contradiction.
 */
function stuckBrakeDef(name: string): string {
  return [
    `name: ${name}`,
    'inputs:',
    '  - name: seed',
    '    seedOwed: true',
    'steps:',
    '  - name: a',
    '    consumes: [seed]',
    '    produces: [x]',
    '    maxSchemaFailures: 0',
    '    body: run a',
    '  - name: c',
    '    consumes: [x]',
    '    produces: [y]',
    '    maxAttempts: 1',
    '    maxSchemaFailures: 0',
    '    terminal: true',
    '    body: run c',
    '  - name: d',
    '    consumes: [seed]',
    '    produces: [z]',
    '    maxSchemaFailures: 0',
    '    terminal: true',
    '    body: run d',
    '',
  ].join('\n');
}

test('push: a completable def with a maxAttempts brake on one branch and a moving independent branch (a MOVING stuck state) is NOT rejected as a definite defect', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'stuckbrake.yaml': stuckBrakeDef('stuckbrake') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const result = JSON.parse(t.out.join('\n'));
  assert.deepEqual(result.pushed, ['stuckbrake']);
  assert.equal(hub.state.get('stuckbrake')?.version, 1, 'the stuck-brake def pushed cleanly, mirroring `check`\'s verdict');
});

/**
 * Regression fixture for the structurallyDeadSteps divergence: `push`'s
 * definite-defect predicate omitted the `structurallyDeadSteps` term that
 * `check` has always included, so a validateDef-missed structurally-dead step
 * (a reduce step whose `produces: []` discharges nothing, so it can NEVER
 * fire under any bounds — see test/check.test.ts's `precision-map` fixture)
 * was never reported as a structurally-dead defect by `push`'s message, even
 * when `push` happened to reject the def anyway (this exact fixture also
 * trips an unrelated true-deadlock elsewhere in its reachable state graph, so
 * the OLD predicate's `deadlocks` term coincidentally still exits 1 — see
 * modelCheck's report on this def: bounded=false, deadlocks.length=130,
 * structurallyDeadSteps=['reducer']). What this test actually proves: the
 * error message/classification now correctly names the real defect
 * (`1 structurally dead step`) instead of only the incidental deadlock count
 * — pre-fix, `/structurally dead step/` never appears in `push`'s output for
 * this def; post-fix it does, matching `check`'s wording exactly. Both must
 * now agree via the shared `hasDefiniteCheckDefect`.
 */
function precisionMapDef(name: string): string {
  return [
    `name: ${name}`,
    'inputs:',
    '  - name: seed',
    '    seedOwed: false',
    'steps:',
    '  - name: fanout',
    '    consumes: [seed]',
    '    produces: ["items[]"]',
    '    body: fan out',
    '  - name: mapper',
    '    consumes: ["items[$i]"]',
    '    produces: ["items[$i].checked"]',
    '    body: check item',
    '  - name: reducer',
    '    consumes: ["items[*].checked"]',
    '    produces: []',
    '    body: reduce (produces nothing — can never fire)',
    '',
  ].join('\n');
}

test('push: a def with a validateDef-missed structurally-dead step is REJECTED (mirrors check)', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'precision-map.yaml': precisionMapDef('precision-map') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1, 'a structurally-dead step must refuse the push, mirroring check');
  const errText = t.err.join('\n');
  assert.match(errText, /refusing to push/);
  assert.match(errText, /definite defects found/);
  assert.match(errText, /1 structurally dead step/);
  assert.equal(hub.state.get('precision-map'), undefined, 'nothing was sent to the hub');
});

/**
 * A SECOND, minimal structurally-dead fixture with no incidental true
 * deadlocks anywhere else in its reachable state graph (unlike precision-map
 * above, whose extra `mapper` step happens to also produce 130 unrelated true
 * deadlocks) — `fanout` produces `items[]` and `reducer` is the sole consumer,
 * discharging nothing (`produces: []`). modelCheck on this def reports
 * bounded=false, deadlocks=[], invariantViolations=[], structurallyDeadSteps=
 * ['reducer']. This isolates the EXACT #77 residual gap: pre-fix, `push`'s
 * predicate (invariantViolations>0 || (!bounded && deadlocks>0)) evaluates to
 * FALSE for this report — nothing else trips it — so `push` sent this broken
 * def cleanly at exit 0, in direct contradiction with `owenloop check` exiting
 * 1 on the identical def. THIS TEST FAILS PRE-FIX (pushes at exit 0) and
 * PASSES POST-FIX (rejects at exit 1) — see the precision-map test above for
 * why THAT fixture's pre/post-fix delta is message-only, not accept/reject.
 */
function deadReduceDef(name: string): string {
  return [
    `name: ${name}`,
    'inputs:',
    '  - name: seed',
    '    seedOwed: false',
    'steps:',
    '  - name: fanout',
    '    consumes: [seed]',
    '    produces: ["items[]"]',
    '    body: fan out',
    '    maxSchemaFailures: 0',
    '  - name: reducer',
    '    consumes: ["items[*]"]',
    '    produces: []',
    '    body: reduce (produces nothing — can never fire)',
    '    maxSchemaFailures: 0',
    '',
  ].join('\n');
}

test('push: a minimal, incident-free structurally-dead step is REJECTED (the exact #77 residual gap: silently pushed pre-fix)', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'dead-reduce.yaml': deadReduceDef('dead-reduce') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1, 'a structurally-dead step must refuse the push, mirroring check — pre-fix this pushed at exit 0');
  const errText = t.err.join('\n');
  assert.match(errText, /refusing to push/);
  assert.match(errText, /definite defects found/);
  assert.match(errText, /0 invariant violation/);
  assert.match(errText, /1 structurally dead step/);
  assert.match(errText, /0 true deadlock/);
  assert.equal(hub.state.get('dead-reduce'), undefined, 'nothing was sent to the hub');
});

// ---- unknown-option rejection: the headline repro (safety flag typo) --------

test('push --dryrn is rejected before any I/O — the safety-flag typo does NOT push (zero fetches, hub unchanged)', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  // A fully push-able state: bound project + real defs. Without the guard, this
  // WOULD do a real push — which is exactly the silent-drop hazard being fixed.
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);

  const code = await mainAsync(['push', '--dryrn'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /--dryrn/, 'names the offending option');
  assert.match(t.err.join('\n'), /did you mean --dry-run\?/, 'suggests the intended flag');
  assert.equal(calls.length, 0, 'no network I/O whatsoever before the rejection');
  assert.equal(hub.state.get('foo'), undefined, 'nothing landed on the fake hub');
});

test('push --frce (typo of --force) is rejected with zero fetches', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);

  const code = await mainAsync(['push', '--frce'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /--frce/);
  assert.match(t.err.join('\n'), /did you mean --force\?/);
  assert.equal(calls.length, 0);
});

test('push --help prints usage and exits 0 without touching the hub', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);

  const code = await mainAsync(['push', '--help'], t.io);
  assert.equal(code, 0);
  assert.match(t.out.join('\n'), /Usage: owenloop <command>/);
  assert.equal(calls.length, 0, 'help short-circuits before any push work');
});

test('push: a genuinely valid --dry-run/--force invocation still parses (no over-rejection)', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);

  const code = await mainAsync(['push', '--dry-run', '--force'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  // --dry-run means the diff is read but nothing is created.
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 0);
});

test('push: a re-push with no changes is a no-op — zero create_workflow calls (local hash diff)', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);
  await mainAsync(['push'], t.io);

  t.out.length = 0;
  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 0);
  const result = JSON.parse(t.out.join('\n'));
  assert.deepEqual(result.unchanged, ['foo']);
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.noop, []);
  assert.match(t.err.join('\n'), /= foo \(unchanged\)/);
});

test('push: a changed def is re-pushed; unchanged siblings are skipped', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);
  await mainAsync(['push'], t.io);

  // Change foo (add a benign title so its hash differs), leave bar alone.
  writeFileSync(join(t.cwd, 'workflows', 'foo.yaml'), `title: hi\n${validDef('foo')}`);
  t.out.length = 0;
  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  assert.deepEqual(result.pushed, ['foo']);
  assert.deepEqual(result.unchanged, ['bar']);
  assert.equal(hub.state.get('foo')?.version, 2);
  assert.equal(hub.state.get('bar')?.version, 1);
});

test('push --force re-sends even unchanged defs; the server reports it back as a noop, not pushed', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);
  await mainAsync(['push'], t.io);

  const { fetch: secondFetch, calls } = routedFetch(hub.routes);
  t.io.fetch = secondFetch;
  t.out.length = 0;
  const code = await mainAsync(['push', '--force'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  // Content is byte-identical, so the server's own idempotent create_workflow
  // reports unchanged:true — --force still SENDS the request (one round-trip)
  // but the CLI reports it as a noop, not a pushed version bump.
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.noop, ['foo']);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 1);
  assert.equal(hub.state.get('foo')?.version, 1, 'no version bump — server-side no-op');
});

test('push --force on a genuinely different def still version-forwards and reports pushed', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);
  await mainAsync(['push'], t.io);

  writeFileSync(join(t.cwd, 'workflows', 'foo.yaml'), `title: hi\n${validDef('foo')}`);
  t.out.length = 0;
  const code = await mainAsync(['push', '--force'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.join('\n')).pushed, ['foo']);
  assert.equal(hub.state.get('foo')?.version, 2);
});

test('push --dry-run sends nothing — reports new/changed/unchanged from server truth', async () => {
  const hub = makeFakeHub([{ name: 'bar', yaml: validDef('bar') }]);
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);

  const code = await mainAsync(['push', '--dry-run'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.new, ['foo']);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.unchanged, ['bar']);
  assert.deepEqual(result.wouldPush, ['foo']);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 0, 'dry-run never posts');
  assert.equal(calls.filter((c) => c.pathname === '/api/workflows').length, 1, 'still reads server truth for the diff');
});

test('push <name>: positional narrowing pushes only the named def; unknown name errors', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);

  const code = await mainAsync(['push', 'foo'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.join('\n')).pushed, ['foo']);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 1);
  assert.equal(hub.state.has('bar'), false, 'bar never touched');

  t.out.length = 0;
  const bad = await mainAsync(['push', 'nope'], t.io);
  assert.equal(bad, 1);
  assert.match(t.err.join('\n'), /unknown workflow definition 'nope'/);
});

test('push: a def that fails validation aborts the whole push — nothing sent, not even the server diff fetch', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  const broken = ['name: broken', 'inputs:', '  - name: seed', 'steps:', '  - name: w', '    consumes: [ghost]', '    produces: [out]', '    terminal: true', ''].join('\n');
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'broken.yaml': broken });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /invalid workflow 'broken'/);
  assert.equal(calls.length, 0, 'nothing sent when validation fails — not even GET /api/workflows');
});

test('push: an include-using def is refused as not hub-pushable', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  const parent = ['name: parent', 'inputs:', '  - name: seed', '    seedOwed: true', 'steps:', '  - include: child', '    as: c', '    inputs:', '      seed: seed', ''].join('\n');
  writeDefs(t.cwd, { 'parent.yaml': parent });
  bind(t);

  const code = await mainAsync(['push', 'parent'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /uses include:, not hub-pushable/);
  assert.equal(calls.length, 0);
});

test('push: a def using bodyFile: is refused as not hub-pushable', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  const withBodyFile = ['name: withfile', 'steps:', '  - name: a', '    bodyFile: prompt.md', '    produces: [y]', ''].join('\n');
  writeDefs(t.cwd, { 'withfile.yaml': withBodyFile, 'prompt.md': 'hello' });
  bind(t);

  const code = await mainAsync(['push', 'withfile'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /uses bodyFile:, not hub-pushable/);
  assert.equal(calls.length, 0);
});

test('push: a server {ok:false} mid-batch records successes, still exits 1', async () => {
  let n = 0;
  const create: RouteHandler = (req) => {
    n += 1;
    // Echo the pushed def's name so the first success passes strict validation
    // (the real hub echoes the name it acknowledged; a stand-in name would now
    // be caught as a malformed response — see REL-9).
    const name = defName(req.body);
    return n === 1
      ? { status: 200, json: { ok: true, name, version: 1, hash: 'r' } }
      : { status: 200, json: { ok: false, error: 'engine version 2 unsupported' } };
  };
  const { fetch } = routedFetch({ 'GET /api/workflows': () => ({ status: 200, json: { workflows: [] } }), 'POST /api/create_workflow': create });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'aaa.yaml': validDef('aaa'), 'zzz.yaml': validDef('zzz') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.ok, false);
  assert.equal(result.pushed.length, 1);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /engine version 2 unsupported/);
});

test('push: a malformed 2xx create_workflow response is reported as a failure, not a success (REL-9)', async () => {
  // 200 with ok:true but a missing hash/version — a malformed success. Before
  // strict validation this coerced to defaults and reported as pushed.
  const { fetch } = routedFetch({
    'GET /api/workflows': () => ({ status: 200, json: { workflows: [] } }),
    'POST /api/create_workflow': (req) => ({ status: 200, json: { ok: true, name: defName(req.body) } }),
  });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.ok, false);
  assert.deepEqual(result.pushed, []);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /malformed success response/);
});

test('push: a 429 mid-batch halts the rest of the batch and surfaces Retry-After (REL-10)', async () => {
  // Three defs: first lands, second 429s (with Retry-After) — the third must
  // never be attempted (no hammering a rate-limited server).
  let n = 0;
  const create: RouteHandler = (req) => {
    n += 1;
    if (n === 1) return { status: 200, json: { ok: true, name: defName(req.body), version: 1, hash: 'r' } };
    return { status: 429, json: { error: 'slow down' }, headers: { 'retry-after': '30' } };
  };
  const { fetch, calls } = routedFetch({
    'GET /api/workflows': () => ({ status: 200, json: { workflows: [] } }),
    'POST /api/create_workflow': create,
  });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'a.yaml': validDef('a'), 'b.yaml': validDef('b'), 'c.yaml': validDef('c') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.ok, false);
  // Exactly two POSTs — the third def is never sent after the 429.
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 2, 'third def never attempted');
  assert.equal(result.pushed.length, 1);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /rate limited by the hub \(retry after 30\)/);
  assert.equal(result.skipped.length, 1, 'the not-yet-attempted def is reported as skipped');
  assert.match(t.err.join('\n'), /stopping — rate limited by the hub; 1 def\(s\) not attempted/);
});

test('push: a 429 without a Retry-After header omits the suffix cleanly (REL-10)', async () => {
  const { fetch } = routedFetch({
    'GET /api/workflows': () => ({ status: 200, json: { workflows: [] } }),
    'POST /api/create_workflow': () => ({ status: 429, json: { error: 'slow down' } }),
  });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /^rate limited by the hub$/);
  assert.deepEqual(result.skipped, [], 'the sole def was the one that 429d — nothing left to skip');
});

test('push: a hub.json carrying a remote-http origin is refused before any network call (SEC-2 defense in depth)', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  // A binding written by an older CLI, before the transport policy existed —
  // writeHubBinding does no scheme validation, so it lands verbatim.
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: 'http://api.example.com' });
  t.store.set(kcHuman('http://api.example.com'), JSON.stringify(OAUTH_CRED));

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /only allowed for loopback/);
  assert.match(t.err.join('\n'), /owenloop connect/);
  assert.equal(calls.length, 0, 'no network call on a refused insecure binding');
});

test('push: a 401 on an oauth credential refreshes once and retries', async () => {
  const create: RouteHandler = (req) => ({ status: 200, json: { ok: true, name: defName(req.body), version: 1, hash: 'r' } });
  // create_workflow 401s for the old token, 200s for the refreshed one.
  const attempts: string[] = [];
  const routes: Record<string, RouteHandler> = {
    'GET /api/workflows': () => ({ status: 200, json: { workflows: [] } }),
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 200, json: { access_token: 'mcpat_new', expires_in: 3600 } }),
    // First call uses old token → 401; after refresh, second call → 200.
    'POST /api/create_workflow': (req) => (attempts.push('x') === 1 ? { status: 401, json: { error: 'expired' } } : create(req)),
  };
  const { fetch, calls: recorded } = routedFetch(routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t, { kind: 'oauth', accessToken: 'mcpat_old', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, clientId: 'c' });

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.join('\n')).pushed, ['foo']);
  assert.ok(recorded.some((c) => c.pathname === '/mcp/token'), 'refresh happened');
  // The stored credential was updated to the refreshed access token.
  assert.equal((JSON.parse(t.store.get(kcHuman(ORIGIN))!) as Credential).accessToken, 'mcpat_new');
});

test('push: a 401 on an agent token is a hard error (no refresh path)', async () => {
  const { fetch } = routedFetch({
    'GET /api/workflows': () => ({ status: 200, json: { workflows: [] } }),
    'POST /api/create_workflow': () => ({ status: 401, json: { error: 'revoked' } }),
  });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t, { kind: 'agent', accessToken: 'olp_x' });

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /revoked or invalid/);
});

test('push: a 401 on the GET /api/workflows diff fetch is a hard error before any create_workflow call', async () => {
  const { fetch, calls } = routedFetch({
    'GET /api/workflows': () => ({ status: 401, json: { error: 'invalid' } }),
    'POST /api/create_workflow': () => ({ status: 200, json: { ok: true, name: 'foo', version: 1, hash: 'r' } }),
  });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t, { kind: 'agent', accessToken: 'olp_x' });

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /revoked or invalid/);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 0);
});

test('push: a malformed GET /api/workflows response is a clean CliError', async () => {
  const { fetch } = routedFetch({
    'GET /api/workflows': () => ({ status: 200, json: { notWorkflows: [] } }),
  });
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /expected a `workflows` array/);
});

test('push: missing hub.json errors with a connect hint', async () => {
  const { fetch } = routedFetch({});
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  // no bind()
  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /not bound to a hub/);
});

test('push: bound but no stored credential errors with a login hint', async () => {
  const { fetch } = routedFetch({});
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
  // credential not seeded
  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /no stored credential/);
});

test('push --hub disagreeing with the project binding errors, names both origins, sends nothing', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t); // binds to ORIGIN = http://127.0.0.1:9

  const code = await mainAsync(['push', '--hub', 'http://127.0.0.1:10'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /bound to http:\/\/127\.0\.0\.1:9/);
  assert.match(t.err.join('\n'), /http:\/\/127\.0\.0\.1:10/);
  assert.match(t.err.join('\n'), /owenloop connect/);
  assert.equal(calls.length, 0, 'zero network calls on a binding mismatch');
});

// ---- boolean flag parsing (BOOLEAN_FLAGS) ------------------------------------

test('push --force foo does not swallow the positional — only foo is force-sent, bar is untouched', async () => {
  const hub = makeFakeHub();
  const t = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo'), 'bar.yaml': validDef('bar') });
  bind(t);
  await mainAsync(['push'], t.io); // both already pushed once

  const { fetch: secondFetch, calls } = routedFetch(hub.routes);
  t.io.fetch = secondFetch;
  t.out.length = 0;
  const code = await mainAsync(['push', '--force', 'foo'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const result = JSON.parse(t.out.join('\n'));
  // "foo" stayed a positional (narrowing the push to just foo) instead of being
  // swallowed as --force's value — the misparse this regresses against would
  // have force-sent EVERY def (both foo and bar) with two create_workflow calls.
  assert.deepEqual(result.unchanged, [], 'bar was excluded from selection entirely, not merely reported unchanged');
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 1, 'bar was NOT force-sent');
  // foo's content is byte-identical to what's already on the hub, so --force
  // still sends it but the server reports it back as a noop, not a pushed bump.
  assert.deepEqual(result.pushed, []);
  assert.deepEqual(result.noop, ['foo']);
  assert.equal(hub.state.get('bar')?.version, 1, 'bar was never re-sent, still at its original version');
});

// ---- hash portability across checkouts (server-truth diff has no client state) --

test('push: identical content pushed from a second, differently-pathed checkout is all unchanged — zero network calls', async () => {
  const hub = makeFakeHub();
  const first = makeIo({ fetch: routedFetch(hub.routes).fetch });
  writeDefs(first.cwd, { 'foo.yaml': validDef('foo') });
  bind(first);
  const firstCode = await mainAsync(['push'], first.io);
  assert.equal(firstCode, 0, first.err.join('\n'));

  // A fresh checkout at a different absolute path, with the same def content
  // and the same (portable) hub.json copied verbatim — the diff is entirely
  // server-side, so a different checkout path is irrelevant.
  const second = makeIo();
  writeDefs(second.cwd, { 'foo.yaml': validDef('foo') });
  second.store.set(kcHuman(ORIGIN), JSON.stringify(OAUTH_CRED));
  writeHubBinding(hubBindingPath(second.cwd), { version: 1, hub: ORIGIN });
  assert.notEqual(first.cwd, second.cwd, 'sanity: genuinely different absolute paths');

  const { fetch: secondFetch, calls } = routedFetch(hub.routes);
  second.io.fetch = secondFetch;
  const code = await mainAsync(['push'], second.io);
  assert.equal(code, 0, second.err.join('\n'));
  const result = JSON.parse(second.out.join('\n'));
  assert.deepEqual(result.unchanged, ['foo']);
  assert.deepEqual(result.pushed, []);
  assert.equal(calls.filter((c) => c.pathname === '/api/create_workflow').length, 0, 'zero create_workflow calls');
});

// ---- request deadlines on push's hub/auth calls (REL-7) ---------------------

test('push: a stalled GET /api/workflows diff fetch times out with a clear message (REL-7)', async () => {
  const hub = makeFakeHub();
  const { fetch } = stallingFetch(hub.routes, ['GET /api/workflows']);
  const t = makeIo({ fetch, env: { OWENLOOP_HUB_TIMEOUT_MS: '200' } });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /hub did not respond within [\d.]+s/);
});

test('push: a stalled create_workflow times out and is recorded as a per-def failure (REL-7)', async () => {
  const hub = makeFakeHub();
  const { fetch } = stallingFetch(hub.routes, ['POST /api/create_workflow']);
  const t = makeIo({ fetch, env: { OWENLOOP_HUB_TIMEOUT_MS: '200' } });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.ok, false);
  assert.equal(result.failed[0].name, 'foo');
  assert.match(result.failed[0].error, /hub did not respond within [\d.]+s/);
});

test('push: a stalled token refresh (expired oauth credential) times out (REL-7)', async () => {
  const hub = makeFakeHub();
  const routes: Record<string, RouteHandler> = {
    ...hub.routes,
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 200, json: { access_token: 'mcpat_new', expires_in: 3600 } }),
  };
  const { fetch } = stallingFetch(routes, ['POST /mcp/token']);
  const t = makeIo({ fetch, env: { OWENLOOP_HUB_TIMEOUT_MS: '200' } });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  // An already-expired oauth credential forces a refresh up front, which stalls.
  bind(t, { kind: 'oauth', accessToken: 'mcpat_old', refreshToken: 'rt', expiresAt: Date.now() - 1000, clientId: 'c' });

  const code = await mainAsync(['push'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /hub did not respond within [\d.]+s/);
});

// ---- credential slots (--as) ------------------------------------------------

test('push --as agent:ci authenticates with that slot and leaves hub.json alone', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
  t.store.set(kcHuman(ORIGIN), JSON.stringify({ kind: 'agent', accessToken: 'olp_human_side' }));
  t.store.set(kcKey(ORIGIN, { principal: 'agent', account: 'ci' }), JSON.stringify({ kind: 'agent', accessToken: 'olp_ci' }));

  const code = await mainAsync(['push', '--as', 'agent:ci'], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.ok(calls.length > 0);
  for (const call of calls) assert.equal(call.authorization, 'Bearer olp_ci', `${call.pathname} used the named slot`);
  assert.deepEqual(readHubBinding(hubBindingPath(t.cwd)), { version: 1, hub: ORIGIN }, 'the binding is credential-agnostic');
});

test('push: an empty slot errors naming the slot, sending nothing', async () => {
  const hub = makeFakeHub();
  const { fetch, calls } = routedFetch(hub.routes);
  const t = makeIo({ fetch });
  writeDefs(t.cwd, { 'foo.yaml': validDef('foo') });
  bind(t);

  const code = await mainAsync(['push', '--as', 'agent:ci'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /no stored credential for .* in slot `agent:ci`/);
  assert.equal(calls.length, 0, 'nothing sent, and no fallback to the human slot');
});
