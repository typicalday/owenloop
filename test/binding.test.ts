/**
 * `owenloop binding new|rm|list` driven in-process through `mainAsync`. The three
 * hub endpoints (`POST /api/add_label_binding`, `POST /api/remove_label_binding`,
 * `GET /api/label_bindings`) and the OAuth refresh endpoints are canned
 * `routedFetch`/`stallingFetch` routes — no live hub is needed or contacted.
 *
 * Fully hermetic: every test materializes its own `$HOME`, cwd, env, fake
 * keychain and `fetch` via `makeIo`, so no ambient machine state is read.
 *
 * No token-leak assertion here (unlike `agent.test.ts`): no endpoint in this
 * feature returns a secret — a label binding writes nothing locally and the
 * responses carry label/pool names only.
 *
 * The invariants these tests pin, beyond the obvious happy paths:
 *   - the routes are `add_label_binding`/`remove_label_binding` and nothing else
 *     (the retired `set_`/`delete_`-prefixed names must never be requested);
 *   - a label binds MANY pools: `binding new` is ADDITIVE (`alreadyBound` says
 *     whether the pair was already there) and `binding list` returns MANY rows per
 *     label, all of which must survive to stdout — nothing may key on `label`;
 *   - `binding rm` takes `<label> <pool>`; the missing `<pool>` is a usage error
 *     with zero network, not a label-wide removal;
 *   - `rm` is **idempotent**: a 200 `{removed: false}` (the pair was never bound)
 *     is exit 0 with a full stdout document plus a "was not bound" stderr line;
 *   - `remainingPoolIds: []` is the PARKED signal and earns a stderr warning;
 *   - a `list` row with `poolName: null` is a DANGLING binding and is PRINTED,
 *     never dropped and never an error;
 *   - stdout is always exactly one JSON document, so `| jq` works.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainAsync } from '../src/cli.ts';
import { credentialFilePath, writeCredentialFile } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { kcHuman, makeIo, OAUTH_METADATA, routedFetch, stallingFetch } from './hubkit.ts';
import type { HubIo, RouteHandler } from './hubkit.ts';

const HUB = 'http://127.0.0.1:9';
const ORIGIN = 'http://127.0.0.1:9';

/** Seed a fresh (non-expiring) human oauth credential into the fake keychain. */
function seedHumanOauth(t: HubIo, over: Partial<Extract<Credential, { kind: 'oauth' }>> = {}): void {
  t.store.set(
    kcHuman(ORIGIN),
    JSON.stringify({
      kind: 'oauth',
      accessToken: 'mcpat_x',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
      clientId: 'c',
      ...over,
    }),
  );
}

/**
 * A realistic 200 `add_label_binding` body — `{ text, binding, alreadyBound,
 * boundPoolCount }`, with `alreadyBound`/`boundPoolCount` at the BODY's top level
 * exactly as the hub spreads them. `over` patches the nested row; `top` patches
 * the body's own fields.
 */
function addOk(over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): RouteHandler {
  return () => ({
    status: 200,
    json: {
      text: "Label 'gpu' bound to pool 'ml-pool' (now 1 pool).",
      binding: {
        label: 'gpu',
        poolId: 'pl_1',
        poolName: 'ml-pool',
        createdBy: 'u_1',
        createdAt: 1,
        ...over,
      },
      alreadyBound: false,
      boundPoolCount: 1,
      ...top,
    },
  });
}

/**
 * A realistic 200 `remove_label_binding` body — `{ text, label, poolId, removed,
 * remainingPoolIds }`. Defaults to a removal that LEAVES another live pool.
 */
function removeOk(over: Record<string, unknown> = {}): RouteHandler {
  return () => ({
    status: 200,
    json: {
      text: "Label 'gpu' unbound from pool 'ml-pool'.",
      label: 'gpu',
      poolId: 'pl_1',
      removed: true,
      remainingPoolIds: ['pl_2'],
      ...over,
    },
  });
}

const ROW_A = { label: 'gpu', poolId: 'pl_1', poolName: 'ml-pool', createdBy: 'u_1', createdAt: 1 };
const ROW_A2 = { label: 'gpu', poolId: 'pl_2', poolName: 'spare-fleet', createdBy: 'u_1', createdAt: 3 };
const ROW_B = { label: 'repo-access', poolId: 'pl_3', poolName: 'build-fleet', createdBy: 'u_2', createdAt: 2 };
/** A DANGLING binding: the bound pool row was deleted, so the hub has no name to resolve. */
const ROW_DANGLING = { label: 'gpu', poolId: 'pl_gone', poolName: null, createdBy: 'u_1', createdAt: 4 };

/** A realistic 200 `label_bindings` body — `{ text, bindings }`. */
function listOk(rows: unknown[] = [ROW_A, ROW_B]): RouteHandler {
  return () => ({ status: 200, json: { text: `${rows.length} label binding(s).`, bindings: rows } });
}

/** Parse the single JSON document the command wrote to stdout. */
function stdoutJson(t: HubIo): Record<string, unknown> {
  return JSON.parse(t.out.join('\n')) as Record<string, unknown>;
}

// ---- happy paths ------------------------------------------------------------

test('binding new: a fresh add POSTs add_label_binding and prints alreadyBound: false with NO stderr', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/add_label_binding': addOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  // Exactly one request, to the `add_`-prefixed route — pinning that the retired
  // `set_`-prefixed route name survives nowhere in the code path.
  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.pathname, '/api/add_label_binding');
  assert.equal(req.method, 'POST');
  assert.equal(req.authorization, 'Bearer mcpat_x');
  assert.deepEqual(JSON.parse(req.body!), { label: 'gpu', pool: 'ml-pool' });

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    label: 'gpu',
    pool: 'ml-pool',
    alreadyBound: false,
    boundPoolCount: 1,
  });
  assert.equal(stdoutJson(t).text, undefined, 'no raw hub body spread onto stdout');
  assert.deepEqual(t.err, [], 'an add has no consequence to warn about — nothing on stderr');
});

test('binding new: a REPEAT add is a normal success — alreadyBound: true, no stderr, no provenance leak', async () => {
  // Binding is ADDITIVE and idempotent per (label, pool) pair: re-adding the same
  // pair is a 200 no-op, not an error, and it never displaces another pool.
  const { fetch, calls } = routedFetch({
    'POST /api/add_label_binding': addOk({ createdBy: 'u_original', createdAt: 999 }, { alreadyBound: true, boundPoolCount: 2 }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/add_label_binding')!;
  assert.deepEqual(JSON.parse(req.body!), { label: 'gpu', pool: 'ml-pool' }, 'the request body is identical to a fresh add');

  const out = stdoutJson(t);
  // The wire's `binding` carries the ORIGINAL row's creator/timestamp (the repeat
  // add preserved it); both are validated but belong to `binding list`, not to
  // this document. Asserted BEFORE the deepEqual below, which narrows `out`.
  assert.equal(out.createdBy, undefined, 'createdBy is validated on the wire, never printed here');
  assert.equal(out.createdAt, undefined, 'createdAt is validated on the wire, never printed here');
  assert.deepEqual(out, {
    ok: true,
    hub: ORIGIN,
    label: 'gpu',
    pool: 'ml-pool',
    alreadyBound: true,
    boundPoolCount: 2,
  });
  assert.deepEqual(t.err, [], 'a repeat add is silent too');
});

test('binding new: stdout prints the SERVER-echoed label/pool, not argv', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_label_binding': addOk({ label: 'gpu', poolName: 'ml-pool-canonical' }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'GPU', 'ML-Pool', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const out = stdoutJson(t);
  assert.equal(out.pool, 'ml-pool-canonical', 'stdout tells the truth about what the hub stored');
  assert.equal(out.label, 'gpu', 'the label is the hub-echoed value too, not argv');
});

test('binding rm: POSTs remove_label_binding with {label, pool} and prints the full removal document', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/remove_label_binding': removeOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.pathname, '/api/remove_label_binding');
  assert.equal(req.method, 'POST');
  assert.equal(req.authorization, 'Bearer mcpat_x');
  // `pool` is REQUIRED on the wire now — the old label-only body is a 400.
  assert.deepEqual(JSON.parse(req.body!), { label: 'gpu', pool: 'ml-pool' });

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    label: 'gpu',
    poolId: 'pl_1',
    removed: true,
    remainingPoolIds: ['pl_2'],
  });
  // Another LIVE pool still serves the label, so nothing is parked.
  assert.ok(!t.err.join('\n').includes('parked'), 'no parked warning while live bindings remain');
});

test('binding rm: removing the LAST live binding PARKS the label — remainingPoolIds: [] plus a stderr warning', async () => {
  const { fetch } = routedFetch({
    'POST /api/remove_label_binding': removeOk({ remainingPoolIds: [] }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    label: 'gpu',
    poolId: 'pl_1',
    removed: true,
    remainingPoolIds: [],
  });
  // stderr only, so `| jq` on stdout is unaffected. The operator has to learn
  // that in-flight steps just parked.
  assert.match(t.err.join('\n'), /gpu: no live bindings remain — runs waiting on this label are parked/);
});

test('binding rm: a pair that was never bound is exit 0 with removed: false and a "was not bound" stderr line', async () => {
  // The hub answers 200 `{removed: false}` for a pair it never held, never a 404
  // (the `removePoolMember` `{existed}` house pattern) — that tolerance is what
  // makes `binding rm` idempotent. `poolId` is `null` here because the argument
  // matched neither a live pool name nor one of this label's own rows.
  const { fetch } = routedFetch({
    'POST /api/remove_label_binding': removeOk({
      text: "Label 'gpu' was not bound to 'no-such-pool'.",
      poolId: null,
      removed: false,
      remainingPoolIds: ['pl_1'],
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', 'no-such-pool', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    label: 'gpu',
    poolId: null,
    removed: false,
    remainingPoolIds: ['pl_1'],
  });
  assert.match(t.err.join('\n'), /gpu was not bound to 'no-such-pool' — nothing was removed/);
  assert.ok(!t.err.join('\n').includes('parked'), 'a no-op removal parked nothing');
});

test('binding rm: a tolerant removal that ALSO leaves zero live bindings warns only about the no-op', async () => {
  // `removed: false` wins the stderr line: nothing changed, so nothing was parked
  // BY THIS CALL even though the label happens to have no live bindings.
  const { fetch } = routedFetch({
    'POST /api/remove_label_binding': removeOk({ poolId: null, removed: false, remainingPoolIds: [] }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', 'no-such-pool', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.match(t.err.join('\n'), /was not bound/);
  assert.ok(!t.err.join('\n').includes('parked'), 'this call parked nothing — it removed nothing');
});

test('binding list: GETs label_bindings and prints the guard-narrowed rows', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/label_bindings': listOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/label_bindings')!;
  assert.equal(req.method, 'GET');
  assert.equal(req.body, undefined, 'a GET carries no request body');
  assert.equal(req.authorization, 'Bearer mcpat_x');

  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, bindings: [ROW_A, ROW_B] });
});

test('binding list: MANY rows for ONE label all survive to stdout, in wire order', async () => {
  // The many-to-many regression test. One row per (label, pool) pair means `gpu`
  // appears three times; anything keying a map on `label` would silently keep one.
  const { fetch } = routedFetch({ 'GET /api/label_bindings': listOk([ROW_A, ROW_A2, ROW_B, ROW_DANGLING]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const bindings = stdoutJson(t).bindings as Record<string, unknown>[];
  assert.deepEqual(bindings, [ROW_A, ROW_A2, ROW_B, ROW_DANGLING], 'every row survives, in the order the hub sent them');
  assert.equal(bindings.filter((b) => b.label === 'gpu').length, 3, 'all three gpu rows are present');
});

test('binding list: a DANGLING row (poolName: null) is PRINTED, not dropped and not an error', async () => {
  // The bound pool row was deleted. The binding routes nothing, but the operator
  // has to be able to SEE it in order to clean it up — so `null` is surfaced.
  const { fetch } = routedFetch({ 'GET /api/label_bindings': listOk([ROW_DANGLING]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, bindings: [ROW_DANGLING] });
  assert.equal((stdoutJson(t).bindings as Record<string, unknown>[])[0]!.poolName, null);
});

test('binding list: an org with ZERO bindings is exit 0 with bindings: [], not an error', async () => {
  const { fetch } = routedFetch({ 'GET /api/label_bindings': listOk([]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, bindings: [] });
});

// ---- exit 3: human credential absent / irrecoverable -----------------------

test('binding: exit 3 with the login remedy when no human credential exists (all three subcommands, zero network)', async () => {
  for (const argv of [
    ['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB],
    ['binding', 'rm', 'gpu', 'ml-pool', '--hub', HUB],
    ['binding', 'list', '--hub', HUB],
  ]) {
    const { fetch, calls } = routedFetch({
      'POST /api/add_label_binding': addOk(),
      'POST /api/remove_label_binding': removeOk(),
      'GET /api/label_bindings': listOk(),
    });
    const t = makeIo({ fetch }); // empty keychain

    const code = await mainAsync(argv, t.io);
    assert.equal(code, 3, `argv ${JSON.stringify(argv)}`);
    assert.match(t.err.join('\n'), new RegExp(`run: owenloop login --hub ${ORIGIN.replace(/[.]/g, '\\.')}`));
    assert.equal(calls.length, 0, 'no network without a human credential');
  }
});

test('binding new: an expired human oauth REFRESHES once and retries with the refreshed bearer', async () => {
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 200, json: { access_token: 'mcpat_new', expires_in: 3600 } }),
    'POST /api/add_label_binding': addOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.ok(calls.some((c) => c.pathname === '/mcp/token'), 'a refresh happened');
  const req = calls.find((c) => c.pathname === '/api/add_label_binding')!;
  assert.equal(req.authorization, 'Bearer mcpat_new', 'the POST used the refreshed bearer');

  // The rotated credential was persisted.
  const human = JSON.parse(t.store.get(kcHuman(ORIGIN))!) as Credential;
  assert.equal(human.accessToken, 'mcpat_new');
});

test('binding new: an expired human oauth whose refresh is REJECTED is exit 3 (irrecoverable)', async () => {
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 400, json: { error: 'invalid_grant' } }),
    'POST /api/add_label_binding': addOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), new RegExp(`run: owenloop login --hub ${ORIGIN.replace(/[.]/g, '\\.')}`));
  assert.ok(!calls.some((c) => c.pathname === '/api/add_label_binding'), 'nothing bound after a failed refresh');
});

test('binding new: a 401 that survives the retry is `credential rejected`, exit 3', async () => {
  // An `oauth-pasted` credential has no refresh path, so the 401 is final on the
  // first response — the exact "irrecoverable credential" family.
  const { fetch } = routedFetch({
    'POST /api/add_label_binding': () => ({ status: 401, json: { error: 'unauthorized' } }),
  });
  const t = makeIo({ fetch });
  t.store.set(kcHuman(ORIGIN), JSON.stringify({ kind: 'oauth-pasted', accessToken: 'mcpat_x' }));

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), /credential rejected/);
});

// ---- exit 2: hub resolution -------------------------------------------------

test('binding list: exit 2 when no --hub and the store knows zero hubs, naming the binding purpose', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/label_bindings': listOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });

  const code = await mainAsync(['binding', 'list'], t.io);
  assert.equal(code, 2);
  const err = t.err.join('\n');
  assert.match(err, /--hub/);
  assert.match(err, /owenloop login/);
  // Proves `resolveAgentHub`'s purpose parameter is actually wired through —
  // the message must NOT say "mint on" for a binding command.
  assert.match(err, /manage label bindings on/);
  assert.doesNotMatch(err, /mint on/);
  assert.equal(calls.length, 0, 'no network before an unresolvable hub');
});

test('binding new: exit 2 lists the stored origins when the store knows more than one hub', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/add_label_binding': addOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  writeCredentialFile(credentialFilePath(t.io.env), {
    version: 2,
    hubs: {
      'https://a.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_a' } },
      'https://b.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_b' } },
    },
  });

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool'], t.io);
  assert.equal(code, 2);
  const err = t.err.join('\n');
  assert.match(err, /manage label bindings on/);
  assert.match(err, /stored hubs:/);
  assert.match(err, /https:\/\/a\.example/);
  assert.match(err, /https:\/\/b\.example/);
  assert.equal(calls.length, 0);
});

test('binding: a missing positional beats hub resolution — usage error (exit 1), not exit 2', async () => {
  // Multi-hub machine: if validation ran AFTER resolveAgentHub these would be a
  // confusing exit 2 about hubs rather than the real problem. `binding rm gpu` is
  // in here because `<pool>` is now required on `rm` too.
  for (const [argv, missing] of [
    [['binding', 'new'], '<label>'],
    [['binding', 'new', 'gpu'], '<pool>'],
    [['binding', 'rm'], '<label>'],
    [['binding', 'rm', 'gpu'], '<pool>'],
  ] as [string[], string][]) {
    const { fetch, calls } = routedFetch({
      'POST /api/add_label_binding': addOk(),
      'POST /api/remove_label_binding': removeOk(),
    });
    const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
    writeCredentialFile(credentialFilePath(t.io.env), {
      version: 2,
      hubs: {
        'https://a.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_a' } },
        'https://b.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_b' } },
      },
    });

    const code = await mainAsync(argv, t.io);
    assert.equal(code, 1, `the usage error wins for ${JSON.stringify(argv)}`);
    assert.match(t.err.join('\n'), new RegExp(`missing required argument: ${missing}`));
    assert.equal(calls.length, 0);
  }
});

// ---- hub refusals (message passthrough) -------------------------------------

test('binding new: a 400 label_binding_invalid surfaces the hub message verbatim, exit 1, empty stdout', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_label_binding': () => ({
      status: 400,
      json: { error: 'label_binding_invalid', message: 'pool "ml-pool" does not exist' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /pool "ml-pool" does not exist/);
  assert.deepEqual(t.out, [], 'nothing on stdout for a hub refusal');
});

test('binding new: a 403 (non-admin human) surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_label_binding': () => ({
      status: 403,
      json: { error: 'forbidden', message: 'admin role required' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /admin role required/);
});

test('binding rm: a 400 on remove surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/remove_label_binding': () => ({
      status: 400,
      json: { error: 'label_binding_invalid', message: 'label "gpu" is not valid' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /label "gpu" is not valid/);
});

// ---- malformed 200s (field-only errors, no body echo) -----------------------

test('binding new: a 200 with no binding is exit 1, naming the missing field only', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_label_binding': () => ({ status: 200, json: { text: 'ok', alreadyBound: false, boundPoolCount: 1 } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /add_label_binding: malformed success response — missing binding/);
  assert.deepEqual(t.out, []);
});

test('binding new: a binding whose poolName is NULL is exit 1 — an add resolves a LIVE pool by name', async () => {
  // The one place `poolName: null` is malformed rather than a dangling binding:
  // `add_label_binding` resolved its pool BY NAME, so the pool is live by
  // construction. `binding list` treats the same null as legitimate (see above).
  const { fetch } = routedFetch({ 'POST /api/add_label_binding': addOk({ poolName: null }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /add_label_binding: malformed success response — binding missing non-empty string poolName/);
  assert.deepEqual(t.out, []);
});

test('binding new: a non-boolean alreadyBound is exit 1, naming that field', async () => {
  const { fetch } = routedFetch({ 'POST /api/add_label_binding': addOk({}, { alreadyBound: 'yes' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /add_label_binding: malformed success response — missing boolean alreadyBound/);
  assert.doesNotMatch(t.err.join('\n'), /yes/, 'the offending VALUE is never echoed');
});

test('binding new: a non-number boundPoolCount is exit 1, naming that field', async () => {
  const { fetch } = routedFetch({ 'POST /api/add_label_binding': addOk({}, { boundPoolCount: '2' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /add_label_binding: malformed success response — missing number boundPoolCount/);
});

test('binding new: a 200 that is NOT valid JSON is exit 1 with a FIXED message, never the parse error', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_label_binding': () => ({ status: 200, raw: 'not json at all' }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  const err = t.err.join('\n');
  assert.match(err, /add_label_binding: malformed success response — body is not valid JSON/);
  assert.doesNotMatch(err, /Unexpected token/, 'the V8 parse-error snippet must never surface');
});

test('binding rm: a 200 with NO removed key at all is exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/remove_label_binding': () => ({ status: 200, json: { text: 'ok', label: 'gpu', remainingPoolIds: [] } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_label_binding: malformed success response — missing boolean removed/);
  assert.deepEqual(t.out, []);
});

test('binding rm: an ABSENT remainingPoolIds THROWS — it is deliberately not lenient', async () => {
  // Defaulting an absent `remainingPoolIds` to `[]` would assert "this label is
  // PARKED" — the alarming reading — off a malformed body. Pinned so nobody
  // "harmonizes" it with the lenient nullable fields.
  const { fetch } = routedFetch({
    'POST /api/remove_label_binding': () => ({
      status: 200,
      json: { text: 'ok', label: 'gpu', poolId: 'pl_1', removed: true },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_label_binding: malformed success response — missing array remainingPoolIds/);
  assert.deepEqual(t.out, [], 'nothing on stdout — the parked question is left unanswered, not guessed');
});

test('binding rm: a non-array remainingPoolIds is exit 1 naming that field', async () => {
  const { fetch } = routedFetch({ 'POST /api/remove_label_binding': removeOk({ remainingPoolIds: 'pl_2' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_label_binding: malformed success response — missing array remainingPoolIds/);
});

test('binding rm: a remainingPoolIds element that is not a non-empty string is exit 1, naming the INDEX', async () => {
  const { fetch } = routedFetch({ 'POST /api/remove_label_binding': removeOk({ remainingPoolIds: ['pl_2', ''] }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_label_binding: malformed success response — remainingPoolIds\[1\] is not a non-empty string/);
});

test('binding list: a malformed row is exit 1, naming the INDEX and field only', async () => {
  const { fetch } = routedFetch({
    'GET /api/label_bindings': listOk([ROW_A, ROW_B, { ...ROW_A, label: '' }]),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /label_bindings: malformed response — bindings\[2\] missing non-empty string label/);
  assert.deepEqual(t.out, []);
});

test('binding list: a row whose poolName is a non-string, non-null value is exit 1 naming that field', async () => {
  // `null` is legitimate (dangling); a number is not.
  const { fetch } = routedFetch({ 'GET /api/label_bindings': listOk([{ ...ROW_A, poolName: 7 }]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /label_bindings: malformed response — bindings\[0\] poolName must be a non-empty string or null/);
});

test('binding list: a 200 with no bindings array is exit 1', async () => {
  const { fetch } = routedFetch({ 'GET /api/label_bindings': () => ({ status: 200, json: { text: 'ok' } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /label_bindings: malformed response — expected a `bindings` array/);
});

// ---- usage errors: zero network --------------------------------------------

test('binding: usage errors are exit 1 with ZERO network calls', async () => {
  for (const argv of [
    ['binding'],
    ['binding', 'bogus'],
    ['binding', 'new'],
    ['binding', 'new', 'gpu'],
    ['binding', 'rm'],
    // `<pool>` is REQUIRED on `rm` now. This argv was a SUCCESS before the
    // many-to-many migration and is deliberately a usage error today.
    ['binding', 'rm', 'gpu'],
  ]) {
    const { fetch, calls } = routedFetch({
      'POST /api/add_label_binding': addOk(),
      'POST /api/remove_label_binding': removeOk(),
      'GET /api/label_bindings': listOk(),
    });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 1, `argv ${JSON.stringify(argv)}`);
    assert.equal(calls.length, 0, `no network on a usage error: ${JSON.stringify(argv)}`);
  }
});

test('binding list: an unknown option is rejected by preflight before any side effect', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/label_bindings': listOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'list', '--bogus', 'x', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /unknown option --bogus for 'binding'/);
  assert.equal(calls.length, 0);
});

// ---- transport discipline ---------------------------------------------------

test('binding new: a hub TIMEOUT is a plain exit 1 (a flaky network is not an irrecoverable credential)', async () => {
  const { fetch, calls } = stallingFetch({ 'POST /api/add_label_binding': addOk() }, ['POST /api/add_label_binding']);
  const t = makeIo({ fetch, env: { OWENLOOP_HUB_TIMEOUT_MS: '80' } });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /did not respond within/);
  assert.ok(calls.some((c) => c.pathname === '/api/add_label_binding'), 'the POST was attempted (and stalled)');
});

test('binding: every request sets redirect: error — proof it went through hubFetch, not raw fetch', async () => {
  for (const [argv, pathname] of [
    [['binding', 'new', 'gpu', 'ml-pool'], '/api/add_label_binding'],
    [['binding', 'rm', 'gpu', 'ml-pool'], '/api/remove_label_binding'],
    [['binding', 'list'], '/api/label_bindings'],
  ] as [string[], string][]) {
    const { fetch, calls } = routedFetch({
      'POST /api/add_label_binding': addOk(),
      'POST /api/remove_label_binding': removeOk(),
      'GET /api/label_bindings': listOk(),
    });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 0, t.err.join('\n'));
    const req = calls.find((c) => c.pathname === pathname)!;
    assert.equal(req.redirect, 'error', `${pathname} must be fetched with redirect: 'error'`);
  }
});
