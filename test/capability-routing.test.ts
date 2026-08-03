/**
 * `owenloop capability bind|unbind|list` driven in-process through `mainAsync`. The three
 * hub endpoints (`POST /api/add_capability_route`, `POST /api/remove_capability_route`,
 * `GET /api/capability_routes`) and the OAuth refresh endpoints are canned
 * `routedFetch`/`stallingFetch` routes — no live hub is needed or contacted.
 *
 * Fully hermetic: every test materializes its own `$HOME`, cwd, env, fake
 * keychain and `fetch` via `makeIo`, so no ambient machine state is read.
 *
 * No token-leak assertion here (unlike `agent.test.ts`): no endpoint in this
 * feature returns a secret — a capability route writes nothing locally and the
 * responses carry capability/crew names only.
 *
 * The invariants these tests pin, beyond the obvious happy paths:
 *   - the routes are `add_capability_route`/`remove_capability_route` and nothing else
 *     (the retired `set_`/`delete_`-prefixed names must never be requested);
 *   - a capability binds MANY crews: `capability bind` is ADDITIVE (`alreadyRouted` says
 *     whether the pair was already there) and `capability list` returns MANY rows per
 *     capability, all of which must survive to stdout — nothing may key on `capability`;
 *   - `capability unbind` takes `<capability> <crew>`; the missing `<crew>` is a usage error
 *     with zero network, not a capability-wide removal;
 *   - `unbind` is **idempotent**: a 200 `{removed: false}` (the pair was never bound)
 *     is exit 0 with a full stdout document plus a "was not bound" stderr line;
 *   - `remainingCrewIds: []` is the PARKED signal and earns a stderr warning;
 *   - a `capability list` row with `crewName: null` is a DANGLING route and is PRINTED,
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
 * A realistic 200 `add_capability_route` body — `{ text, capability, alreadyRouted,
 * routedCrewCount }`, with `alreadyRouted`/`routedCrewCount` at the BODY's top level
 * exactly as the hub spreads them. `over` patches the nested row; `top` patches
 * the body's own fields.
 */
function addOk(over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): RouteHandler {
  return () => ({
    status: 200,
    json: {
      text: "Capability 'gpu' bound to crew 'ml-crew' (now 1 crew).",
      route: {
        capability: 'gpu',
        crewId: 'crw_1',
        crewName: 'ml-crew',
        createdBy: 'u_1',
        createdAt: 1,
        ...over,
      },
      alreadyRouted: false,
      routedCrewCount: 1,
      ...top,
    },
  });
}

/**
 * A realistic 200 `remove_capability_route` body — `{ text, capability, crewId, removed,
 * remainingCrewIds }`. Defaults to a removal that LEAVES another live crew.
 */
function removeOk(over: Record<string, unknown> = {}): RouteHandler {
  return () => ({
    status: 200,
    json: {
      text: "Capability 'gpu' unbound from crew 'ml-crew'.",
      capability: 'gpu',
      crewId: 'crw_1',
      removed: true,
      remainingCrewIds: ['crw_2'],
      ...over,
    },
  });
}

const ROW_A = { capability: 'gpu', crewId: 'crw_1', crewName: 'ml-crew', createdBy: 'u_1', createdAt: 1 };
const ROW_A2 = { capability: 'gpu', crewId: 'crw_2', crewName: 'spare-fleet', createdBy: 'u_1', createdAt: 3 };
const ROW_B = { capability: 'repo-access', crewId: 'crw_3', crewName: 'build-fleet', createdBy: 'u_2', createdAt: 2 };
/** A DANGLING route: the bound crew row was deleted, so the hub has no name to resolve. */
const ROW_DANGLING = { capability: 'gpu', crewId: 'crw_gone', crewName: null, createdBy: 'u_1', createdAt: 4 };

/** A realistic 200 `capability_routes` body — `{ text, routes }`. */
function listOk(rows: unknown[] = [ROW_A, ROW_B]): RouteHandler {
  return () => ({ status: 200, json: { text: `${rows.length} capability route(s).`, routes: rows } });
}

/** Parse the single JSON document the command wrote to stdout. */
function stdoutJson(t: HubIo): Record<string, unknown> {
  return JSON.parse(t.out.join('\n')) as Record<string, unknown>;
}

// ---- happy paths ------------------------------------------------------------

test('capability bind: a fresh add POSTs add_capability_route and prints alreadyRouted: false with NO stderr', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/add_capability_route': addOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  // Exactly one request, to the `add_`-prefixed route — pinning that the retired
  // `set_`-prefixed route name survives nowhere in the code path.
  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.pathname, '/api/add_capability_route');
  assert.equal(req.method, 'POST');
  assert.equal(req.authorization, 'Bearer mcpat_x');
  assert.deepEqual(JSON.parse(req.body!), { capability: 'gpu', crew: 'ml-crew' });

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    capability: 'gpu',
    crew: 'ml-crew',
    alreadyRouted: false,
    routedCrewCount: 1,
  });
  assert.equal(stdoutJson(t).text, undefined, 'no raw hub body spread onto stdout');
  assert.deepEqual(t.err, [], 'an add has no consequence to warn about — nothing on stderr');
});

test('capability bind: a REPEAT add is a normal success — alreadyRouted: true, no stderr, no provenance leak', async () => {
  // Capability routing is ADDITIVE and idempotent per (capability, crew) pair: re-adding the same
  // pair is a 200 no-op, not an error, and it never displaces another crew.
  const { fetch, calls } = routedFetch({
    'POST /api/add_capability_route': addOk({ createdBy: 'u_original', createdAt: 999 }, { alreadyRouted: true, routedCrewCount: 2 }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/add_capability_route')!;
  assert.deepEqual(JSON.parse(req.body!), { capability: 'gpu', crew: 'ml-crew' }, 'the request body is identical to a fresh add');

  const out = stdoutJson(t);
  // The wire's `capability` carries the ORIGINAL row's creator/timestamp (the repeat
  // add preserved it); both are validated but belong to `capability list`, not to
  // this document. Asserted BEFORE the deepEqual below, which narrows `out`.
  assert.equal(out.createdBy, undefined, 'createdBy is validated on the wire, never printed here');
  assert.equal(out.createdAt, undefined, 'createdAt is validated on the wire, never printed here');
  assert.deepEqual(out, {
    ok: true,
    hub: ORIGIN,
    capability: 'gpu',
    crew: 'ml-crew',
    alreadyRouted: true,
    routedCrewCount: 2,
  });
  assert.deepEqual(t.err, [], 'a repeat add is silent too');
});

test('capability bind: stdout prints the SERVER-echoed capability/crew, not argv', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_capability_route': addOk({ capability: 'gpu', crewName: 'ml-crew-canonical' }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'bind', 'GPU', 'ML-Crew', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const out = stdoutJson(t);
  assert.equal(out.crew, 'ml-crew-canonical', 'stdout tells the truth about what the hub stored');
  assert.equal(out.capability, 'gpu', 'the capability is the hub-echoed value too, not argv');
});

test('capability unbind: POSTs remove_capability_route with {capability, crew} and prints the full removal document', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/remove_capability_route': removeOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'unbind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.pathname, '/api/remove_capability_route');
  assert.equal(req.method, 'POST');
  assert.equal(req.authorization, 'Bearer mcpat_x');
  // `crew` is REQUIRED on the wire now — the old capability-only body is a 400.
  assert.deepEqual(JSON.parse(req.body!), { capability: 'gpu', crew: 'ml-crew' });

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    capability: 'gpu',
    crewId: 'crw_1',
    removed: true,
    remainingCrewIds: ['crw_2'],
  });
  // Another LIVE crew still serves the capability, so nothing is parked.
  assert.ok(!t.err.join('\n').includes('parked'), 'no parked warning while live routes remain');
});

test('capability unbind: removing the LAST live capability PARKS the capability — remainingCrewIds: [] plus a stderr warning', async () => {
  const { fetch } = routedFetch({
    'POST /api/remove_capability_route': removeOk({ remainingCrewIds: [] }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'unbind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    capability: 'gpu',
    crewId: 'crw_1',
    removed: true,
    remainingCrewIds: [],
  });
  // stderr only, so `| jq` on stdout is unaffected. The operator has to learn
  // that in-flight steps just parked.
  assert.match(t.err.join('\n'), /gpu: no live routes remain — runs waiting on this capability are parked/);
});

test('capability unbind: a pair that was never bound is exit 0 with removed: false and a "was not bound" stderr line', async () => {
  // The hub answers 200 `{removed: false}` for a pair it never held, never a 404
  // (the `removeCrewMember` `{existed}` house pattern) — that tolerance is what
  // makes `capability unbind` idempotent. `crewId` is `null` here because the argument
  // matched neither a live crew name nor one of this capability's own rows.
  const { fetch } = routedFetch({
    'POST /api/remove_capability_route': removeOk({
      text: "Capability 'gpu' was not bound to 'no-such-crew'.",
      crewId: null,
      removed: false,
      remainingCrewIds: ['crw_1'],
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'unbind', 'gpu', 'no-such-crew', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    capability: 'gpu',
    crewId: null,
    removed: false,
    remainingCrewIds: ['crw_1'],
  });
  assert.match(t.err.join('\n'), /gpu was not bound to 'no-such-crew' — nothing was removed/);
  assert.ok(!t.err.join('\n').includes('parked'), 'a no-op removal parked nothing');
});

test('capability unbind: a tolerant removal that ALSO leaves zero live routes warns only about the no-op', async () => {
  // `removed: false` wins the stderr line: nothing changed, so nothing was parked
  // BY THIS CALL even though the capability happens to have no live routes.
  const { fetch } = routedFetch({
    'POST /api/remove_capability_route': removeOk({ crewId: null, removed: false, remainingCrewIds: [] }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'unbind', 'gpu', 'no-such-crew', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.match(t.err.join('\n'), /was not bound/);
  assert.ok(!t.err.join('\n').includes('parked'), 'this call parked nothing — it removed nothing');
});

test('capability list: GETs capability_routes and prints the guard-narrowed rows', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/capability_routes': listOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/capability_routes')!;
  assert.equal(req.method, 'GET');
  assert.equal(req.body, undefined, 'a GET carries no request body');
  assert.equal(req.authorization, 'Bearer mcpat_x');

  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, routes: [ROW_A, ROW_B] });
});

test('capability list: MANY rows for ONE capability all survive to stdout, in wire order', async () => {
  // The many-to-many regression test. One row per (capability, crew) pair means `gpu`
  // appears three times; anything keying a map on `capability` would silently keep one.
  const { fetch } = routedFetch({ 'GET /api/capability_routes': listOk([ROW_A, ROW_A2, ROW_B, ROW_DANGLING]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const routes = stdoutJson(t).routes as Record<string, unknown>[];
  assert.deepEqual(routes, [ROW_A, ROW_A2, ROW_B, ROW_DANGLING], 'every row survives, in the order the hub sent them');
  assert.equal(routes.filter((b) => b.capability === 'gpu').length, 3, 'all three gpu rows are present');
});

test('capability list: a DANGLING row (crewName: null) is PRINTED, not dropped and not an error', async () => {
  // The bound crew row was deleted. The capability routes nothing, but the operator
  // has to be able to SEE it in order to clean it up — so `null` is surfaced.
  const { fetch } = routedFetch({ 'GET /api/capability_routes': listOk([ROW_DANGLING]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, routes: [ROW_DANGLING] });
  assert.equal((stdoutJson(t).routes as Record<string, unknown>[])[0]!.crewName, null);
});

test('capability list: an org with ZERO routes is exit 0 with routes: [], not an error', async () => {
  const { fetch } = routedFetch({ 'GET /api/capability_routes': listOk([]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, routes: [] });
});

// ---- exit 3: human credential absent / irrecoverable -----------------------

test('capability: exit 3 with the login remedy when no human credential exists (all three subcommands, zero network)', async () => {
  for (const argv of [
    ['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB],
    ['capability', 'unbind', 'gpu', 'ml-crew', '--hub', HUB],
    ['capability', 'list', '--hub', HUB],
  ]) {
    const { fetch, calls } = routedFetch({
      'POST /api/add_capability_route': addOk(),
      'POST /api/remove_capability_route': removeOk(),
      'GET /api/capability_routes': listOk(),
    });
    const t = makeIo({ fetch }); // empty keychain

    const code = await mainAsync(argv, t.io);
    assert.equal(code, 3, `argv ${JSON.stringify(argv)}`);
    assert.match(t.err.join('\n'), new RegExp(`run: owenloop login --hub ${ORIGIN.replace(/[.]/g, '\\.')}`));
    assert.equal(calls.length, 0, 'no network without a human credential');
  }
});

test('capability bind: an expired human oauth REFRESHES once and retries with the refreshed bearer', async () => {
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 200, json: { access_token: 'mcpat_new', expires_in: 3600 } }),
    'POST /api/add_capability_route': addOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.ok(calls.some((c) => c.pathname === '/mcp/token'), 'a refresh happened');
  const req = calls.find((c) => c.pathname === '/api/add_capability_route')!;
  assert.equal(req.authorization, 'Bearer mcpat_new', 'the POST used the refreshed bearer');

  // The rotated credential was persisted.
  const human = JSON.parse(t.store.get(kcHuman(ORIGIN))!) as Credential;
  assert.equal(human.accessToken, 'mcpat_new');
});

test('capability bind: an expired human oauth whose refresh is REJECTED is exit 3 (irrecoverable)', async () => {
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 400, json: { error: 'invalid_grant' } }),
    'POST /api/add_capability_route': addOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), new RegExp(`run: owenloop login --hub ${ORIGIN.replace(/[.]/g, '\\.')}`));
  assert.ok(!calls.some((c) => c.pathname === '/api/add_capability_route'), 'nothing bound after a failed refresh');
});

test('capability bind: a 401 that survives the retry is `credential rejected`, exit 3', async () => {
  // An `oauth-pasted` credential has no refresh path, so the 401 is final on the
  // first response — the exact "irrecoverable credential" family.
  const { fetch } = routedFetch({
    'POST /api/add_capability_route': () => ({ status: 401, json: { error: 'unauthorized' } }),
  });
  const t = makeIo({ fetch });
  t.store.set(kcHuman(ORIGIN), JSON.stringify({ kind: 'oauth-pasted', accessToken: 'mcpat_x' }));

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), /credential rejected/);
});

// ---- exit 2: hub resolution -------------------------------------------------

test('capability list: exit 2 when no --hub and the store knows zero hubs, naming the capability purpose', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/capability_routes': listOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });

  const code = await mainAsync(['capability', 'list'], t.io);
  assert.equal(code, 2);
  const err = t.err.join('\n');
  assert.match(err, /--hub/);
  assert.match(err, /owenloop login/);
  // Proves `resolveAgentHub`'s purpose parameter is actually wired through —
  // the message must NOT say "mint on" for a capability command.
  assert.match(err, /manage capability routes on/);
  assert.doesNotMatch(err, /mint on/);
  assert.equal(calls.length, 0, 'no network before an unresolvable hub');
});

test('capability bind: exit 2 lists the stored origins when the store knows more than one hub', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/add_capability_route': addOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  writeCredentialFile(credentialFilePath(t.io.env), {
    version: 2,
    hubs: {
      'https://a.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_a' } },
      'https://b.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_b' } },
    },
  });

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew'], t.io);
  assert.equal(code, 2);
  const err = t.err.join('\n');
  assert.match(err, /manage capability routes on/);
  assert.match(err, /stored hubs:/);
  assert.match(err, /https:\/\/a\.example/);
  assert.match(err, /https:\/\/b\.example/);
  assert.equal(calls.length, 0);
});

test('capability: a missing positional beats hub resolution — usage error (exit 1), not exit 2', async () => {
  // Multi-hub machine: if validation ran AFTER resolveAgentHub these would be a
  // confusing exit 2 about hubs rather than the real problem. `capability unbind gpu` is
  // in here because `<crew>` is now required on `rm` too.
  for (const [argv, missing] of [
    [['capability', 'bind'], '<capability>'],
    [['capability', 'bind', 'gpu'], '<crew>'],
    [['capability', 'unbind'], '<capability>'],
    [['capability', 'unbind', 'gpu'], '<crew>'],
  ] as [string[], string][]) {
    const { fetch, calls } = routedFetch({
      'POST /api/add_capability_route': addOk(),
      'POST /api/remove_capability_route': removeOk(),
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

test('capability bind: a 400 capability_route_invalid surfaces the hub message verbatim, exit 1, empty stdout', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_capability_route': () => ({
      status: 400,
      json: { error: 'capability_route_invalid', message: 'crew "ml-crew" does not exist' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /crew "ml-crew" does not exist/);
  assert.deepEqual(t.out, [], 'nothing on stdout for a hub refusal');
});

test('capability bind: a 403 (non-admin human) surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_capability_route': () => ({
      status: 403,
      json: { error: 'forbidden', message: 'admin role required' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /admin role required/);
});

test('capability unbind: a 400 on remove surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/remove_capability_route': () => ({
      status: 400,
      json: { error: 'capability_route_invalid', message: 'capability "gpu" is not valid' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'unbind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /capability "gpu" is not valid/);
});

// ---- malformed 200s (field-only errors, no body echo) -----------------------

test('capability bind: a 200 with no capability is exit 1, naming the missing field only', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_capability_route': () => ({ status: 200, json: { text: 'ok', alreadyRouted: false, routedCrewCount: 1 } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /add_capability_route: malformed success response — missing route/);
  assert.deepEqual(t.out, []);
});

test('capability bind: a capability whose crewName is NULL is exit 1 — an add resolves a LIVE crew by name', async () => {
  // The one place `crewName: null` is malformed rather than a dangling capability:
  // `add_capability_route` resolved its crew BY NAME, so the crew is live by
  // construction. `capability list` treats the same null as legitimate (see above).
  const { fetch } = routedFetch({ 'POST /api/add_capability_route': addOk({ crewName: null }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /add_capability_route: malformed success response — route missing non-empty string crewName/);
  assert.deepEqual(t.out, []);
});

test('capability bind: a non-boolean alreadyRouted is exit 1, naming that field', async () => {
  const { fetch } = routedFetch({ 'POST /api/add_capability_route': addOk({}, { alreadyRouted: 'yes' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /add_capability_route: malformed success response — missing boolean alreadyRouted/);
  assert.doesNotMatch(t.err.join('\n'), /yes/, 'the offending VALUE is never echoed');
});

test('capability bind: a non-number routedCrewCount is exit 1, naming that field', async () => {
  const { fetch } = routedFetch({ 'POST /api/add_capability_route': addOk({}, { routedCrewCount: '2' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /add_capability_route: malformed success response — missing number routedCrewCount/);
});

test('capability bind: a 200 that is NOT valid JSON is exit 1 with a FIXED message, never the parse error', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_capability_route': () => ({ status: 200, raw: 'not json at all' }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  const err = t.err.join('\n');
  assert.match(err, /add_capability_route: malformed success response — body is not valid JSON/);
  assert.doesNotMatch(err, /Unexpected token/, 'the V8 parse-error snippet must never surface');
});

test('capability unbind: a 200 with NO removed key at all is exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/remove_capability_route': () => ({ status: 200, json: { text: 'ok', capability: 'gpu', remainingCrewIds: [] } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'unbind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_capability_route: malformed success response — missing boolean removed/);
  assert.deepEqual(t.out, []);
});

test('capability unbind: an ABSENT remainingCrewIds THROWS — it is deliberately not lenient', async () => {
  // Defaulting an absent `remainingCrewIds` to `[]` would assert "this capability is
  // PARKED" — the alarming reading — off a malformed body. Pinned so nobody
  // "harmonizes" it with the lenient nullable fields.
  const { fetch } = routedFetch({
    'POST /api/remove_capability_route': () => ({
      status: 200,
      json: { text: 'ok', capability: 'gpu', crewId: 'crw_1', removed: true },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'unbind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_capability_route: malformed success response — missing array remainingCrewIds/);
  assert.deepEqual(t.out, [], 'nothing on stdout — the parked question is left unanswered, not guessed');
});

test('capability unbind: a non-array remainingCrewIds is exit 1 naming that field', async () => {
  const { fetch } = routedFetch({ 'POST /api/remove_capability_route': removeOk({ remainingCrewIds: 'crw_2' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'unbind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_capability_route: malformed success response — missing array remainingCrewIds/);
});

test('capability unbind: a remainingCrewIds element that is not a non-empty string is exit 1, naming the INDEX', async () => {
  const { fetch } = routedFetch({ 'POST /api/remove_capability_route': removeOk({ remainingCrewIds: ['crw_2', ''] }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'unbind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_capability_route: malformed success response — remainingCrewIds\[1\] is not a non-empty string/);
});

test('capability list: a malformed row is exit 1, naming the INDEX and field only', async () => {
  const { fetch } = routedFetch({
    'GET /api/capability_routes': listOk([ROW_A, ROW_B, { ...ROW_A, capability: '' }]),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /capability_routes: malformed response — routes\[2\] missing non-empty string capability/);
  assert.deepEqual(t.out, []);
});

test('capability list: a row whose crewName is a non-string, non-null value is exit 1 naming that field', async () => {
  // `null` is legitimate (dangling); a number is not.
  const { fetch } = routedFetch({ 'GET /api/capability_routes': listOk([{ ...ROW_A, crewName: 7 }]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /capability_routes: malformed response — routes\[0\] crewName must be a non-empty string or null/);
});

test('capability list: a 200 with no routes array is exit 1', async () => {
  const { fetch } = routedFetch({ 'GET /api/capability_routes': () => ({ status: 200, json: { text: 'ok' } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /capability_routes: malformed response — expected a `routes` array/);
});

// ---- usage errors: zero network --------------------------------------------

test('capability: usage errors are exit 1 with ZERO network calls', async () => {
  for (const argv of [
    ['capability'],
    ['capability', 'bogus'],
    ['capability', 'bind'],
    ['capability', 'bind', 'gpu'],
    ['capability', 'unbind'],
    // `<crew>` is REQUIRED on `rm` now. This argv was a SUCCESS before the
    // many-to-many migration and is deliberately a usage error today.
    ['capability', 'unbind', 'gpu'],
  ]) {
    const { fetch, calls } = routedFetch({
      'POST /api/add_capability_route': addOk(),
      'POST /api/remove_capability_route': removeOk(),
      'GET /api/capability_routes': listOk(),
    });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 1, `argv ${JSON.stringify(argv)}`);
    assert.equal(calls.length, 0, `no network on a usage error: ${JSON.stringify(argv)}`);
  }
});

test('capability list: an unknown option is rejected by preflight before any side effect', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/capability_routes': listOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'list', '--bogus', 'x', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /unknown option --bogus for 'capability'/);
  assert.equal(calls.length, 0);
});

// ---- transport discipline ---------------------------------------------------

test('capability bind: a hub TIMEOUT is a plain exit 1 (a flaky network is not an irrecoverable credential)', async () => {
  const { fetch, calls } = stallingFetch({ 'POST /api/add_capability_route': addOk() }, ['POST /api/add_capability_route']);
  const t = makeIo({ fetch, env: { OWENLOOP_HUB_TIMEOUT_MS: '80' } });
  seedHumanOauth(t);

  const code = await mainAsync(['capability', 'bind', 'gpu', 'ml-crew', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /did not respond within/);
  assert.ok(calls.some((c) => c.pathname === '/api/add_capability_route'), 'the POST was attempted (and stalled)');
});

test('capability: every request sets redirect: error — proof it went through hubFetch, not raw fetch', async () => {
  for (const [argv, pathname] of [
    [['capability', 'bind', 'gpu', 'ml-crew'], '/api/add_capability_route'],
    [['capability', 'unbind', 'gpu', 'ml-crew'], '/api/remove_capability_route'],
    [['capability', 'list'], '/api/capability_routes'],
  ] as [string[], string][]) {
    const { fetch, calls } = routedFetch({
      'POST /api/add_capability_route': addOk(),
      'POST /api/remove_capability_route': removeOk(),
      'GET /api/capability_routes': listOk(),
    });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 0, t.err.join('\n'));
    const req = calls.find((c) => c.pathname === pathname)!;
    assert.equal(req.redirect, 'error', `${pathname} must be fetched with redirect: 'error'`);
  }
});
