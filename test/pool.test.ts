/**
 * `owenloop pool list|new|rm|member add|member rm` driven in-process through
 * `mainAsync`. The five hub endpoints (`GET /api/pools`, `POST
 * /api/create_pool`, `/api/delete_pool`, `/api/add_pool_member`,
 * `/api/remove_pool_member`) and the OAuth refresh endpoints are canned
 * `routedFetch`/`stallingFetch` routes — no live hub is needed or contacted.
 *
 * Fully hermetic: every test materializes its own `$HOME`, cwd, env, fake
 * keychain and `fetch` via `makeIo`, so no ambient machine state is read.
 *
 * Modeled line-for-line on `binding.test.ts`. The invariants these tests pin,
 * beyond the obvious happy paths — the absent/tolerant-field semantics are the
 * heart of this feature:
 *   - `pool list` marks the orphan pool with a derived `orphan: boolean` and
 *     never filters it out;
 *   - `pool rm` on an unknown pool id is a normal 200 `{deleted: false}` (never
 *     a 404), exit 0, with a stderr line naming the pool id — UNLIKE `binding
 *     rm`, `pool rm` DOES print `deleted` on stdout;
 *   - `delete_pool`'s six optional transfer fields are on stdout IF AND ONLY IF
 *     the wire carried them — never defaulted to `0`/`null`/`[]`; a real
 *     transfer also gets a stderr summary naming the orphan pool;
 *   - `pool member rm` on a non-member is a normal 200 `{removed: false}`,
 *     exit 0, with a stderr line — mirrors `pool rm`'s tolerant shape;
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

const POOL_A = { id: 'pl_1', name: 'team-a', kind: 'shared', ownerMemberId: null, createdBy: 'u_1', createdAt: 1 };
const MEMBER_A = { principalKind: 'member', principalId: 'u_2', addedBy: 'u_1', addedAt: 2 };
const ORPHAN_POOL = { id: 'pl_orphan', name: 'orphan:unrouted', kind: 'orphan', ownerMemberId: null, createdBy: 'u_1', createdAt: 0 };

/** A realistic 200 `GET /api/pools` body — `{ text, pools }`, house shape. */
function listOk(pools: unknown[] = [{ ...POOL_A, members: [MEMBER_A] }, { ...ORPHAN_POOL, members: [] }]): RouteHandler {
  return () => ({ status: 200, json: { text: `${pools.length} pool(s).`, pools } });
}

/** A realistic 200 `create_pool` body — `{ text, pool }`. */
function createOk(over: Record<string, unknown> = {}): RouteHandler {
  return () => ({
    status: 200,
    json: {
      text: 'Pool "team-a" created.',
      pool: { id: 'pl_1', name: 'team-a', kind: 'shared', ownerMemberId: null, createdBy: 'u_1', createdAt: 1, ...over },
    },
  });
}

/** A realistic 200 `delete_pool` body naming which of the three shapes to send. */
function deleteOk(over: Record<string, unknown> = {}): RouteHandler {
  return () => ({ status: 200, json: { text: 'ok', poolId: 'pl_1', deleted: true, ...over } });
}

/** A realistic 200 `add_pool_member` body — `{ text, member }`. */
function addMemberOk(over: Record<string, unknown> = {}): RouteHandler {
  return () => ({
    status: 200,
    json: { text: 'ok', member: { principalKind: 'member', principalId: 'u_2', addedBy: 'u_1', addedAt: 2, ...over } },
  });
}

/** A realistic 200 `remove_pool_member` body — `{ text, poolId, principalId, removed }`. */
function removeMemberOk(removed = true, over: Record<string, unknown> = {}): RouteHandler {
  return () => ({ status: 200, json: { text: 'ok', poolId: 'pl_1', principalId: 'u_2', removed, ...over } });
}

/** Parse the single JSON document the command wrote to stdout. */
function stdoutJson(t: HubIo): Record<string, unknown> {
  return JSON.parse(t.out.join('\n')) as Record<string, unknown>;
}

// ---- happy paths ------------------------------------------------------------

test('pool list: GETs pools and prints the guard-narrowed rows, marking the orphan pool', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/pools': listOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/pools')!;
  assert.equal(req.method, 'GET');
  assert.equal(req.body, undefined, 'a GET carries no request body');
  assert.equal(req.authorization, 'Bearer mcpat_x');

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    pools: [
      { ...POOL_A, orphan: false, members: [MEMBER_A] },
      { ...ORPHAN_POOL, orphan: true, members: [] },
    ],
  });
});

test('pool list: an org with ZERO pools is exit 0 with pools: [], not an error', async () => {
  const { fetch } = routedFetch({ 'GET /api/pools': listOk([]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, pools: [] });
});

test('pool list: a pool whose name starts with orphan: but whose kind is shared is STILL marked orphan', async () => {
  const { fetch } = routedFetch({
    'GET /api/pools': listOk([{ ...POOL_A, id: 'pl_9', name: 'orphan:legacy', kind: 'shared', members: [] }]),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const pools = stdoutJson(t).pools as { orphan: boolean }[];
  assert.equal(pools[0]!.orphan, true, 'name-prefix alone is enough to mark orphan, even with kind=shared');
});

test("pool new: POSTs create_pool with { name, kind } (no ownerMemberId key) when --owner is absent", async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_pool': createOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/create_pool')!;
  assert.equal(req.method, 'POST');
  assert.deepEqual(JSON.parse(req.body!), { name: 'team-a', kind: 'shared' });
  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    poolId: 'pl_1',
    name: 'team-a',
    kind: 'shared',
    ownerMemberId: null,
  });
});

test('pool new: --owner is forwarded as ownerMemberId in the request body', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/create_pool': createOk({ kind: 'personal', ownerMemberId: 'member_7' }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'new', 'team-a', '--kind', 'personal', '--owner', 'member_7', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/create_pool')!;
  assert.deepEqual(JSON.parse(req.body!), { name: 'team-a', kind: 'personal', ownerMemberId: 'member_7' });
  assert.equal(stdoutJson(t).ownerMemberId, 'member_7');
});

test('pool new: --kind is forwarded VERBATIM and unvalidated client-side (the hub is the enforcement of record)', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_pool': createOk({ kind: 'bogus-kind' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'new', 'team-a', '--kind', 'bogus-kind', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const req = calls.find((c) => c.pathname === '/api/create_pool')!;
  assert.deepEqual(JSON.parse(req.body!), { name: 'team-a', kind: 'bogus-kind' });
});

test('pool rm: a normal delete with NO transfer prints { ok, hub, poolId, deleted, membersRemoved }, no stderr', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/delete_pool': deleteOk({ membersRemoved: 2 }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/delete_pool')!;
  assert.equal(req.method, 'POST');
  assert.deepEqual(JSON.parse(req.body!), { poolId: 'pl_1' });

  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, poolId: 'pl_1', deleted: true, membersRemoved: 2 });
  assert.deepEqual(t.err, [], 'no transfer happened — no stderr line');
});

test('pool rm: deleted: false (unknown pool id) is exit 0, prints deleted: false with NO membersRemoved key, and a stderr line', async () => {
  const { fetch } = routedFetch({ 'POST /api/delete_pool': deleteOk({ deleted: false, poolId: 'pl_bogus' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'rm', 'pl_bogus', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const out = stdoutJson(t);
  assert.equal(out.membersRemoved, undefined, 'never default-fill an absent optional field');
  assert.deepEqual(out, { ok: true, hub: ORIGIN, poolId: 'pl_bogus', deleted: false });
  assert.match(t.err.join('\n'), /no pool 'pl_bogus' to delete — nothing was removed/);
});

test('pool rm: a delete WITH transfer prints every transfer field the wire carried and a stderr summary naming the orphan pool', async () => {
  const { fetch } = routedFetch({
    'POST /api/delete_pool': deleteOk({
      membersRemoved: 3,
      orphanPoolId: 'pl_orphan',
      orphanPoolName: 'orphan:unrouted',
      stampsTransferred: 5,
      runsTransferred: ['run_1', 'run_2'],
      runningRunsTransferred: ['run_2'],
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    poolId: 'pl_1',
    deleted: true,
    membersRemoved: 3,
    orphanPoolId: 'pl_orphan',
    orphanPoolName: 'orphan:unrouted',
    stampsTransferred: 5,
    runsTransferred: ['run_1', 'run_2'],
    runningRunsTransferred: ['run_2'],
  });
  assert.match(
    t.err.join('\n'),
    /pool 'pl_1' deleted — 5 stamp\(s\) from 2 run\(s\) \(1 still running\) moved to 'orphan:unrouted' \(pl_orphan\)/,
  );
});

test('pool rm: a transfer with NO still-running runs omits the "(N still running)" clause entirely', async () => {
  const { fetch } = routedFetch({
    'POST /api/delete_pool': deleteOk({
      membersRemoved: 1,
      orphanPoolId: 'pl_orphan',
      orphanPoolName: 'orphan:unrouted',
      stampsTransferred: 2,
      runsTransferred: ['run_1'],
      // runningRunsTransferred deliberately absent
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const err = t.err.join('\n');
  assert.match(err, /pool 'pl_1' deleted — 2 stamp\(s\) from 1 run\(s\) moved to 'orphan:unrouted' \(pl_orphan\)/);
  assert.doesNotMatch(err, /still running/);
});

test('pool member add: POSTs add_pool_member with argv values and prints the argv poolId with the server-echoed principal', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/add_pool_member': addMemberOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'member', 'add', 'pl_1', 'member', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/add_pool_member')!;
  assert.deepEqual(JSON.parse(req.body!), { poolId: 'pl_1', principalKind: 'member', principalId: 'u_2' });
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, poolId: 'pl_1', principalKind: 'member', principalId: 'u_2' });
});

test('pool member add: principalKind is forwarded verbatim (e.g. "agent"), unvalidated client-side', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/add_pool_member': addMemberOk({ principalKind: 'agent', principalId: 'agent_1' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'member', 'add', 'pl_1', 'agent', 'agent_1', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const req = calls.find((c) => c.pathname === '/api/add_pool_member')!;
  assert.deepEqual(JSON.parse(req.body!), { poolId: 'pl_1', principalKind: 'agent', principalId: 'agent_1' });
});

test('pool member rm: removed: true prints { ok, hub, poolId, principalId, removed: true } with NO stderr', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/remove_pool_member': removeMemberOk(true) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'member', 'rm', 'pl_1', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/remove_pool_member')!;
  assert.deepEqual(JSON.parse(req.body!), { poolId: 'pl_1', principalId: 'u_2' });
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, poolId: 'pl_1', principalId: 'u_2', removed: true });
  assert.deepEqual(t.err, []);
});

test('pool member rm: removed: false (never a member) is exit 0, prints removed: false, and a stderr line', async () => {
  const { fetch } = routedFetch({ 'POST /api/remove_pool_member': removeMemberOk(false) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'member', 'rm', 'pl_1', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, poolId: 'pl_1', principalId: 'u_2', removed: false });
  assert.match(t.err.join('\n'), /u_2 was not a member of pool 'pl_1' — nothing was removed/);
});

// ---- exit 3: human credential absent / irrecoverable -----------------------

test('pool: exit 3 with the login remedy when no human credential exists (all five subcommands, zero network)', async () => {
  for (const argv of [
    ['pool', 'list'],
    ['pool', 'new', 'team-a', '--kind', 'shared'],
    ['pool', 'rm', 'pl_1'],
    ['pool', 'member', 'add', 'pl_1', 'member', 'u_2'],
    ['pool', 'member', 'rm', 'pl_1', 'u_2'],
  ]) {
    const { fetch, calls } = routedFetch({
      'GET /api/pools': listOk(),
      'POST /api/create_pool': createOk(),
      'POST /api/delete_pool': deleteOk(),
      'POST /api/add_pool_member': addMemberOk(),
      'POST /api/remove_pool_member': removeMemberOk(),
    });
    const t = makeIo({ fetch }); // empty keychain

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 3, `argv ${JSON.stringify(argv)}`);
    assert.match(t.err.join('\n'), new RegExp(`run: owenloop login --hub ${ORIGIN.replace(/[.]/g, '\\.')}`));
    assert.equal(calls.length, 0, 'no network without a human credential');
  }
});

test('pool list: an expired human oauth REFRESHES once and retries with the refreshed bearer', async () => {
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 200, json: { access_token: 'mcpat_new', expires_in: 3600 } }),
    'GET /api/pools': listOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['pool', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.ok(calls.some((c) => c.pathname === '/mcp/token'), 'a refresh happened');
  const req = calls.find((c) => c.pathname === '/api/pools')!;
  assert.equal(req.authorization, 'Bearer mcpat_new', 'the GET used the refreshed bearer');

  const human = JSON.parse(t.store.get(kcHuman(ORIGIN))!) as Credential;
  assert.equal(human.accessToken, 'mcpat_new');
});

test('pool new: an expired human oauth whose refresh is REJECTED is exit 3 (irrecoverable)', async () => {
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 400, json: { error: 'invalid_grant' } }),
    'POST /api/create_pool': createOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['pool', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), new RegExp(`run: owenloop login --hub ${ORIGIN.replace(/[.]/g, '\\.')}`));
  assert.ok(!calls.some((c) => c.pathname === '/api/create_pool'), 'nothing created after a failed refresh');
});

test('pool new: a 401 that survives the retry is `credential rejected`, exit 3', async () => {
  const { fetch } = routedFetch({
    'POST /api/create_pool': () => ({ status: 401, json: { error: 'unauthorized' } }),
  });
  const t = makeIo({ fetch });
  t.store.set(kcHuman(ORIGIN), JSON.stringify({ kind: 'oauth-pasted', accessToken: 'mcpat_x' }));

  const code = await mainAsync(['pool', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), /credential rejected/);
});

// ---- exit 2: hub resolution -------------------------------------------------

test('pool list: exit 2 when no --hub and the store knows zero hubs, naming the pool purpose', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/pools': listOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });

  const code = await mainAsync(['pool', 'list'], t.io);
  assert.equal(code, 2);
  const err = t.err.join('\n');
  assert.match(err, /--hub/);
  assert.match(err, /owenloop login/);
  // Proves `resolveAgentHub`'s purpose parameter is actually wired through —
  // the message must NOT say "mint on" for a pool command.
  assert.match(err, /manage pools on/);
  assert.doesNotMatch(err, /mint on/);
  assert.equal(calls.length, 0, 'no network before an unresolvable hub');
});

test('pool new: exit 2 lists the stored origins when the store knows more than one hub', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_pool': createOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  writeCredentialFile(credentialFilePath(t.io.env), {
    version: 2,
    hubs: {
      'https://a.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_a' } },
      'https://b.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_b' } },
    },
  });

  const code = await mainAsync(['pool', 'new', 'team-a', '--kind', 'shared'], t.io);
  assert.equal(code, 2);
  const err = t.err.join('\n');
  assert.match(err, /manage pools on/);
  assert.match(err, /stored hubs:/);
  assert.match(err, /https:\/\/a\.example/);
  assert.match(err, /https:\/\/b\.example/);
  assert.equal(calls.length, 0);
});

test('pool new: a missing positional beats hub resolution — usage error (exit 1), not exit 2', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_pool': createOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  writeCredentialFile(credentialFilePath(t.io.env), {
    version: 2,
    hubs: {
      'https://a.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_a' } },
      'https://b.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_b' } },
    },
  });

  const code = await mainAsync(['pool', 'new'], t.io);
  assert.equal(code, 1, 'the usage error wins');
  assert.match(t.err.join('\n'), /missing required argument: <name>/);
  assert.equal(calls.length, 0);
});

// ---- hub refusals (message passthrough) -------------------------------------

test('pool new: a 400 (unknown --owner member) surfaces the hub message verbatim, exit 1, empty stdout', async () => {
  const { fetch } = routedFetch({
    'POST /api/create_pool': () => ({
      status: 400,
      json: { error: 'pool_invalid', message: 'unknown member id "member_bogus"' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'new', 'team-a', '--kind', 'personal', '--owner', 'member_bogus', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /unknown member id "member_bogus"/);
  assert.deepEqual(t.out, [], 'nothing on stdout for a hub refusal');
});

test('pool new: a 403 (non-admin human) surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/create_pool': () => ({ status: 403, json: { error: 'forbidden', message: 'admin role required' } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /admin role required/);
});

test('pool rm: a 400 (pool has active workflows) surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/delete_pool': () => ({
      status: 400,
      json: { error: 'pool_in_use', message: 'pool "pl_1" has active workflows and cannot be deleted' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /pool "pl_1" has active workflows and cannot be deleted/);
});

test('pool member add: a 400 (unknown pool) surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_pool_member': () => ({ status: 400, json: { error: 'pool_not_found', message: 'unknown pool: pl_bogus' } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'member', 'add', 'pl_bogus', 'member', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /unknown pool: pl_bogus/);
});

// ---- malformed 200s (field-only errors, no body echo) -----------------------

test('pool list: a 200 with no pools array is exit 1', async () => {
  const { fetch } = routedFetch({ 'GET /api/pools': () => ({ status: 200, json: { text: 'ok' } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /pools: malformed response — expected a `pools` array/);
  assert.deepEqual(t.out, []);
});

test('pool list: a malformed pool row is exit 1, naming the INDEX and field only', async () => {
  const { fetch } = routedFetch({
    'GET /api/pools': listOk([{ ...POOL_A, members: [], name: '' }]),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /pools: malformed response — pools\[0\] missing non-empty string name/);
  assert.deepEqual(t.out, []);
});

test('pool list: a pool row with no members array is exit 1', async () => {
  const { fetch } = routedFetch({ 'GET /api/pools': () => ({ status: 200, json: { text: 'ok', pools: [POOL_A] } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /pools: malformed response — pools\[0\] missing members array/);
});

test('pool list: a malformed member row is exit 1, naming the pool AND member index', async () => {
  const { fetch } = routedFetch({
    'GET /api/pools': listOk([{ ...POOL_A, members: [{ ...MEMBER_A, principalId: '' }] }]),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /pools: malformed response — pools\[0\]\.members\[0\] missing non-empty string principalId/);
});

test('pool list: a non-string, non-null ownerMemberId is exit 1 naming that field', async () => {
  const { fetch } = routedFetch({ 'GET /api/pools': listOk([{ ...POOL_A, ownerMemberId: 7, members: [] }]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /ownerMemberId must be a non-empty string or null/);
});

test('pool list: a 200 that is NOT valid JSON is exit 1 with a FIXED message, never the parse error', async () => {
  const { fetch } = routedFetch({ 'GET /api/pools': () => ({ status: 200, raw: 'not json at all' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  const err = t.err.join('\n');
  assert.match(err, /pools: malformed response — body is not valid JSON/);
  assert.doesNotMatch(err, /Unexpected token/, 'the V8 parse-error snippet must never surface');
});

test('pool new: a 200 with no pool is exit 1, naming the missing field only', async () => {
  const { fetch } = routedFetch({ 'POST /api/create_pool': () => ({ status: 200, json: { text: 'ok' } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /create_pool: malformed success response — missing pool/);
  assert.deepEqual(t.out, []);
});

test('pool new: a 200 whose pool is missing a required field is exit 1, naming that field', async () => {
  const { fetch } = routedFetch({
    'POST /api/create_pool': () => ({
      status: 200,
      json: { text: 'ok', pool: { id: 'pl_1', kind: 'shared', ownerMemberId: null, createdBy: 'u_1', createdAt: 1 } },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /create_pool: malformed success response — pool missing non-empty string name/);
});

test('pool new: a pool with ownerMemberId ABSENT is exit 0 with ownerMemberId: null (deliberate leniency)', async () => {
  const { fetch } = routedFetch({
    'POST /api/create_pool': () => ({
      status: 200,
      json: { text: 'ok', pool: { id: 'pl_1', name: 'team-a', kind: 'shared', createdBy: 'u_1', createdAt: 1 } },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(stdoutJson(t).ownerMemberId, null);
});

test('pool rm: a 200 with NO deleted key at all is exit 1', async () => {
  const { fetch } = routedFetch({ 'POST /api/delete_pool': () => ({ status: 200, json: { text: 'ok', poolId: 'pl_1' } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /delete_pool: malformed success response — missing boolean deleted/);
  assert.deepEqual(t.out, []);
});

test('pool rm: a non-number membersRemoved is exit 1 naming that field', async () => {
  const { fetch } = routedFetch({ 'POST /api/delete_pool': deleteOk({ membersRemoved: 'two' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /delete_pool: malformed success response — membersRemoved must be a number/);
});

test('pool rm: a non-string-array runsTransferred is exit 1 naming that field', async () => {
  const { fetch } = routedFetch({ 'POST /api/delete_pool': deleteOk({ runsTransferred: [1, 2] }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /delete_pool: malformed success response — runsTransferred must be an array of strings/);
});

test('pool rm: a 200 that is NOT valid JSON is exit 1 with a FIXED message', async () => {
  const { fetch } = routedFetch({ 'POST /api/delete_pool': () => ({ status: 200, raw: 'not json' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 1);
  const err = t.err.join('\n');
  assert.match(err, /delete_pool: malformed success response — body is not valid JSON/);
  assert.doesNotMatch(err, /Unexpected token/);
});

test('pool member add: a 200 with no member is exit 1, naming the missing field only', async () => {
  const { fetch } = routedFetch({ 'POST /api/add_pool_member': () => ({ status: 200, json: { text: 'ok' } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'member', 'add', 'pl_1', 'member', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /add_pool_member: malformed success response — missing member/);
  assert.deepEqual(t.out, []);
});

test('pool member add: a 200 whose member is missing a required field is exit 1, naming that field', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_pool_member': () => ({
      status: 200,
      json: { text: 'ok', member: { principalKind: 'member', addedBy: 'u_1', addedAt: 2 } },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'member', 'add', 'pl_1', 'member', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /add_pool_member: malformed success response — member missing non-empty string principalId/);
});

test('pool member rm: a 200 with NO removed key at all is exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/remove_pool_member': () => ({ status: 200, json: { text: 'ok', poolId: 'pl_1', principalId: 'u_2' } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'member', 'rm', 'pl_1', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_pool_member: malformed success response — missing boolean removed/);
  assert.deepEqual(t.out, []);
});

test('pool member rm: a 200 missing poolId is exit 1, naming that field', async () => {
  const { fetch } = routedFetch({
    'POST /api/remove_pool_member': () => ({ status: 200, json: { text: 'ok', principalId: 'u_2', removed: true } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'member', 'rm', 'pl_1', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_pool_member: malformed success response — missing non-empty string poolId/);
});

// ---- usage errors: zero network --------------------------------------------

test('pool: usage errors are exit 1 with ZERO network calls', async () => {
  for (const argv of [
    ['pool'],
    ['pool', 'bogus'],
    ['pool', 'new'],
    ['pool', 'new', 'team-a'], // missing --kind
    ['pool', 'rm'],
    ['pool', 'member'],
    ['pool', 'member', 'bogus'],
    ['pool', 'member', 'add'],
    ['pool', 'member', 'add', 'pl_1'],
    ['pool', 'member', 'add', 'pl_1', 'member'],
    ['pool', 'member', 'rm'],
    ['pool', 'member', 'rm', 'pl_1'],
  ]) {
    const { fetch, calls } = routedFetch({
      'GET /api/pools': listOk(),
      'POST /api/create_pool': createOk(),
      'POST /api/delete_pool': deleteOk(),
      'POST /api/add_pool_member': addMemberOk(),
      'POST /api/remove_pool_member': removeMemberOk(),
    });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 1, `argv ${JSON.stringify(argv)}`);
    assert.equal(calls.length, 0, `no network on a usage error: ${JSON.stringify(argv)}`);
  }
});

test('pool new: --owner= (explicit empty value) is a usage error, exit 1, zero network', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_pool': createOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'new', 'team-a', '--kind', 'shared', '--owner=', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /--owner requires a member id/);
  assert.equal(calls.length, 0);
});

test('pool list: an unknown option is rejected by preflight before any side effect', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/pools': listOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'list', '--bogus', 'x', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /unknown option --bogus for 'pool'/);
  assert.equal(calls.length, 0);
});

// ---- transport discipline ---------------------------------------------------

test('pool list: a hub TIMEOUT is a plain exit 1 (a flaky network is not an irrecoverable credential)', async () => {
  const { fetch, calls } = stallingFetch({ 'GET /api/pools': listOk() }, ['GET /api/pools']);
  const t = makeIo({ fetch, env: { OWENLOOP_HUB_TIMEOUT_MS: '80' } });
  seedHumanOauth(t);

  const code = await mainAsync(['pool', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /did not respond within/);
  assert.ok(calls.some((c) => c.pathname === '/api/pools'), 'the GET was attempted (and stalled)');
});

test('pool: every request sets redirect: error — proof it went through hubFetch, not raw fetch', async () => {
  for (const [argv, pathname] of [
    [['pool', 'list'], '/api/pools'],
    [['pool', 'new', 'team-a', '--kind', 'shared'], '/api/create_pool'],
    [['pool', 'rm', 'pl_1'], '/api/delete_pool'],
    [['pool', 'member', 'add', 'pl_1', 'member', 'u_2'], '/api/add_pool_member'],
    [['pool', 'member', 'rm', 'pl_1', 'u_2'], '/api/remove_pool_member'],
  ] as [string[], string][]) {
    const { fetch, calls } = routedFetch({
      'GET /api/pools': listOk(),
      'POST /api/create_pool': createOk(),
      'POST /api/delete_pool': deleteOk(),
      'POST /api/add_pool_member': addMemberOk(),
      'POST /api/remove_pool_member': removeMemberOk(),
    });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 0, t.err.join('\n'));
    const req = calls.find((c) => c.pathname === pathname)!;
    assert.equal(req.redirect, 'error', `${pathname} must be fetched with redirect: 'error'`);
  }
});
