/**
 * `owenloop crew list|new|rm|member add|member rm` driven in-process through
 * `mainAsync`. The five hub endpoints (`GET /api/crews`, `POST
 * /api/create_crew`, `/api/delete_crew`, `/api/add_crew_member`,
 * `/api/remove_crew_member`) and the OAuth refresh endpoints are canned
 * `routedFetch`/`stallingFetch` routes — no live hub is needed or contacted.
 *
 * Fully hermetic: every test materializes its own `$HOME`, cwd, env, fake
 * keychain and `fetch` via `makeIo`, so no ambient machine state is read.
 *
 * Modeled line-for-line on `binding.test.ts`. The invariants these tests pin,
 * beyond the obvious happy paths — the absent/tolerant-field semantics are the
 * heart of this feature:
 *   - `crew list` marks the orphan crew with a derived `orphan: boolean` and
 *     never filters it out;
 *   - `crew rm` on an unknown crew id is a normal 200 `{deleted: false}` (never
 *     a 404), exit 0, with a stderr line naming the crew id — UNLIKE `binding
 *     rm`, `crew rm` DOES print `deleted` on stdout;
 *   - `delete_crew`'s six optional transfer fields are on stdout IF AND ONLY IF
 *     the wire carried them — never defaulted to `0`/`null`/`[]`; a real
 *     transfer also gets a stderr summary naming the orphan crew;
 *   - `crew member rm` on a non-member is a normal 200 `{removed: false}`,
 *     exit 0, with a stderr line — mirrors `crew rm`'s tolerant shape;
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

const CREW_A = { id: 'pl_1', name: 'team-a', kind: 'shared', ownerMemberId: null, createdBy: 'u_1', createdAt: 1 };
const MEMBER_A = { principalKind: 'member', principalId: 'u_2', addedBy: 'u_1', addedAt: 2 };
const ORPHAN_CREW = { id: 'pl_orphan', name: 'orphan:unrouted', kind: 'orphan', ownerMemberId: null, createdBy: 'u_1', createdAt: 0 };

/** A realistic 200 `GET /api/crews` body — `{ text, crews }`, house shape. */
function listOk(crews: unknown[] = [{ ...CREW_A, members: [MEMBER_A] }, { ...ORPHAN_CREW, members: [] }]): RouteHandler {
  return () => ({ status: 200, json: { text: `${crews.length} crew(s).`, crews } });
}

/** A realistic 200 `create_crew` body — `{ text, crew }`. */
function createOk(over: Record<string, unknown> = {}): RouteHandler {
  return () => ({
    status: 200,
    json: {
      text: 'Crew "team-a" created.',
      crew: { id: 'pl_1', name: 'team-a', kind: 'shared', ownerMemberId: null, createdBy: 'u_1', createdAt: 1, ...over },
    },
  });
}

/** A realistic 200 `delete_crew` body naming which of the three shapes to send. */
function deleteOk(over: Record<string, unknown> = {}): RouteHandler {
  return () => ({ status: 200, json: { text: 'ok', crewId: 'pl_1', deleted: true, ...over } });
}

/** A realistic 200 `add_crew_member` body — `{ text, member }`. */
function addMemberOk(over: Record<string, unknown> = {}): RouteHandler {
  return () => ({
    status: 200,
    json: { text: 'ok', member: { principalKind: 'member', principalId: 'u_2', addedBy: 'u_1', addedAt: 2, ...over } },
  });
}

/** A realistic 200 `remove_crew_member` body — `{ text, crewId, principalId, removed }`. */
function removeMemberOk(removed = true, over: Record<string, unknown> = {}): RouteHandler {
  return () => ({ status: 200, json: { text: 'ok', crewId: 'pl_1', principalId: 'u_2', removed, ...over } });
}

/** Parse the single JSON document the command wrote to stdout. */
function stdoutJson(t: HubIo): Record<string, unknown> {
  return JSON.parse(t.out.join('\n')) as Record<string, unknown>;
}

// ---- happy paths ------------------------------------------------------------

test('crew list: GETs crews and prints the guard-narrowed rows, marking the orphan crew', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/crews': listOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/crews')!;
  assert.equal(req.method, 'GET');
  assert.equal(req.body, undefined, 'a GET carries no request body');
  assert.equal(req.authorization, 'Bearer mcpat_x');

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    crews: [
      { ...CREW_A, orphan: false, members: [MEMBER_A] },
      { ...ORPHAN_CREW, orphan: true, members: [] },
    ],
  });
});

test('crew list: an org with ZERO crews is exit 0 with crews: [], not an error', async () => {
  const { fetch } = routedFetch({ 'GET /api/crews': listOk([]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, crews: [] });
});

test('crew list: a crew whose name starts with orphan: but whose kind is shared is STILL marked orphan', async () => {
  const { fetch } = routedFetch({
    'GET /api/crews': listOk([{ ...CREW_A, id: 'pl_9', name: 'orphan:legacy', kind: 'shared', members: [] }]),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const crews = stdoutJson(t).crews as { orphan: boolean }[];
  assert.equal(crews[0]!.orphan, true, 'name-prefix alone is enough to mark orphan, even with kind=shared');
});

test("crew new: POSTs create_crew with { name, kind } (no ownerMemberId key) when --owner is absent", async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_crew': createOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/create_crew')!;
  assert.equal(req.method, 'POST');
  assert.deepEqual(JSON.parse(req.body!), { name: 'team-a', kind: 'shared' });
  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    crewId: 'pl_1',
    name: 'team-a',
    kind: 'shared',
    ownerMemberId: null,
  });
});

test('crew new: --owner is forwarded as ownerMemberId in the request body', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/create_crew': createOk({ kind: 'personal', ownerMemberId: 'member_7' }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'personal', '--owner', 'member_7', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/create_crew')!;
  assert.deepEqual(JSON.parse(req.body!), { name: 'team-a', kind: 'personal', ownerMemberId: 'member_7' });
  assert.equal(stdoutJson(t).ownerMemberId, 'member_7');
});

test('crew new: --kind is forwarded VERBATIM and unvalidated client-side (the hub is the enforcement of record)', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_crew': createOk({ kind: 'bogus-kind' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'bogus-kind', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const req = calls.find((c) => c.pathname === '/api/create_crew')!;
  assert.deepEqual(JSON.parse(req.body!), { name: 'team-a', kind: 'bogus-kind' });
});

test('crew new: prints the SERVER-ECHOED name/kind/id, not argv, when the hub normalizes them', async () => {
  // argv asks for 'team-a'; the hub stores it differently (e.g. normalized)
  // and mints its own id. Every other happy-path test's canned body happens
  // to match argv, so a regression that printed argv instead of `created.*`
  // would pass all of them — this is the one test that would catch it.
  const { fetch, calls } = routedFetch({
    'POST /api/create_crew': createOk({ id: 'pl_7', name: 'team-a-2', kind: 'shared' }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/create_crew')!;
  assert.deepEqual(JSON.parse(req.body!), { name: 'team-a', kind: 'shared' }, 'the request still carries the argv name');
  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    crewId: 'pl_7',
    name: 'team-a-2',
    kind: 'shared',
    ownerMemberId: null,
  });
});

test('crew rm: a normal delete with NO transfer prints { ok, hub, crewId, deleted, membersRemoved }, no stderr', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/delete_crew': deleteOk({ membersRemoved: 2 }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/delete_crew')!;
  assert.equal(req.method, 'POST');
  assert.deepEqual(JSON.parse(req.body!), { crewId: 'pl_1' });

  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, crewId: 'pl_1', deleted: true, membersRemoved: 2 });
  assert.deepEqual(t.err, [], 'no transfer happened — no stderr line');
});

test('crew rm: deleted: false (unknown crew id) is exit 0, prints deleted: false with NO membersRemoved key, and a stderr line', async () => {
  const { fetch } = routedFetch({ 'POST /api/delete_crew': deleteOk({ deleted: false, crewId: 'pl_bogus' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'rm', 'pl_bogus', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const out = stdoutJson(t);
  assert.equal(out.membersRemoved, undefined, 'never default-fill an absent optional field');
  assert.deepEqual(out, { ok: true, hub: ORIGIN, crewId: 'pl_bogus', deleted: false });
  assert.match(t.err.join('\n'), /no crew 'pl_bogus' to delete — nothing was removed/);
});

test('crew rm: a delete WITH transfer prints every transfer field the wire carried and a stderr summary naming the orphan crew', async () => {
  const { fetch } = routedFetch({
    'POST /api/delete_crew': deleteOk({
      membersRemoved: 3,
      orphanCrewId: 'pl_orphan',
      orphanCrewName: 'orphan:unrouted',
      stampsTransferred: 5,
      runsTransferred: ['run_1', 'run_2'],
      runningRunsTransferred: ['run_2'],
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    crewId: 'pl_1',
    deleted: true,
    membersRemoved: 3,
    orphanCrewId: 'pl_orphan',
    orphanCrewName: 'orphan:unrouted',
    stampsTransferred: 5,
    runsTransferred: ['run_1', 'run_2'],
    runningRunsTransferred: ['run_2'],
  });
  assert.match(
    t.err.join('\n'),
    /crew 'pl_1' deleted — 5 stamp\(s\) from 2 run\(s\) \(1 still running\) moved to 'orphan:unrouted' \(pl_orphan\)/,
  );
});

test('crew rm: a transfer with NO still-running runs omits the "(N still running)" clause entirely', async () => {
  const { fetch } = routedFetch({
    'POST /api/delete_crew': deleteOk({
      membersRemoved: 1,
      orphanCrewId: 'pl_orphan',
      orphanCrewName: 'orphan:unrouted',
      stampsTransferred: 2,
      runsTransferred: ['run_1'],
      // runningRunsTransferred deliberately absent
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const err = t.err.join('\n');
  assert.match(err, /crew 'pl_1' deleted — 2 stamp\(s\) from 1 run\(s\) moved to 'orphan:unrouted' \(pl_orphan\)/);
  assert.doesNotMatch(err, /still running/);
});

test('crew member add: POSTs add_crew_member with argv values and prints the argv crewId with the server-echoed principal', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/add_crew_member': addMemberOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'member', 'add', 'pl_1', 'member', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/add_crew_member')!;
  assert.deepEqual(JSON.parse(req.body!), { crewId: 'pl_1', principalKind: 'member', principalId: 'u_2' });
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, crewId: 'pl_1', principalKind: 'member', principalId: 'u_2' });
});

test('crew member add: principalKind is forwarded verbatim (e.g. "agent"), unvalidated client-side', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/add_crew_member': addMemberOk({ principalKind: 'agent', principalId: 'agent_1' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'member', 'add', 'pl_1', 'agent', 'agent_1', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const req = calls.find((c) => c.pathname === '/api/add_crew_member')!;
  assert.deepEqual(JSON.parse(req.body!), { crewId: 'pl_1', principalKind: 'agent', principalId: 'agent_1' });
});

test('crew member rm: removed: true prints { ok, hub, crewId, principalId, removed: true } with NO stderr', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/remove_crew_member': removeMemberOk(true) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'member', 'rm', 'pl_1', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/remove_crew_member')!;
  assert.deepEqual(JSON.parse(req.body!), { crewId: 'pl_1', principalId: 'u_2' });
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, crewId: 'pl_1', principalId: 'u_2', removed: true });
  assert.deepEqual(t.err, []);
});

test('crew member rm: removed: false (never a member) is exit 0, prints removed: false, and a stderr line', async () => {
  const { fetch } = routedFetch({ 'POST /api/remove_crew_member': removeMemberOk(false) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'member', 'rm', 'pl_1', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, crewId: 'pl_1', principalId: 'u_2', removed: false });
  assert.match(t.err.join('\n'), /u_2 was not a member of crew 'pl_1' — nothing was removed/);
});

// ---- exit 3: human credential absent / irrecoverable -----------------------

test('crew: exit 3 with the login remedy when no human credential exists (all five subcommands, zero network)', async () => {
  for (const argv of [
    ['crew', 'list'],
    ['crew', 'new', 'team-a', '--kind', 'shared'],
    ['crew', 'rm', 'pl_1'],
    ['crew', 'member', 'add', 'pl_1', 'member', 'u_2'],
    ['crew', 'member', 'rm', 'pl_1', 'u_2'],
  ]) {
    const { fetch, calls } = routedFetch({
      'GET /api/crews': listOk(),
      'POST /api/create_crew': createOk(),
      'POST /api/delete_crew': deleteOk(),
      'POST /api/add_crew_member': addMemberOk(),
      'POST /api/remove_crew_member': removeMemberOk(),
    });
    const t = makeIo({ fetch }); // empty keychain

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 3, `argv ${JSON.stringify(argv)}`);
    assert.match(t.err.join('\n'), new RegExp(`run: owenloop login --hub ${ORIGIN.replace(/[.]/g, '\\.')}`));
    assert.equal(calls.length, 0, 'no network without a human credential');
  }
});

test('crew list: an expired human oauth REFRESHES once and retries with the refreshed bearer', async () => {
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 200, json: { access_token: 'mcpat_new', expires_in: 3600 } }),
    'GET /api/crews': listOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['crew', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.ok(calls.some((c) => c.pathname === '/mcp/token'), 'a refresh happened');
  const req = calls.find((c) => c.pathname === '/api/crews')!;
  assert.equal(req.authorization, 'Bearer mcpat_new', 'the GET used the refreshed bearer');

  const human = JSON.parse(t.store.get(kcHuman(ORIGIN))!) as Credential;
  assert.equal(human.accessToken, 'mcpat_new');
});

test('crew new: an expired human oauth whose refresh is REJECTED is exit 3 (irrecoverable)', async () => {
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 400, json: { error: 'invalid_grant' } }),
    'POST /api/create_crew': createOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), new RegExp(`run: owenloop login --hub ${ORIGIN.replace(/[.]/g, '\\.')}`));
  assert.ok(!calls.some((c) => c.pathname === '/api/create_crew'), 'nothing created after a failed refresh');
});

test('crew new: a 401 that survives the retry is `credential rejected`, exit 3', async () => {
  const { fetch } = routedFetch({
    'POST /api/create_crew': () => ({ status: 401, json: { error: 'unauthorized' } }),
  });
  const t = makeIo({ fetch });
  t.store.set(kcHuman(ORIGIN), JSON.stringify({ kind: 'oauth-pasted', accessToken: 'mcpat_x' }));

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), /credential rejected/);
});

// ---- exit 2: hub resolution -------------------------------------------------

test('crew list: exit 2 when no --hub and the store knows zero hubs, naming the crew purpose', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/crews': listOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });

  const code = await mainAsync(['crew', 'list'], t.io);
  assert.equal(code, 2);
  const err = t.err.join('\n');
  assert.match(err, /--hub/);
  assert.match(err, /owenloop login/);
  // Proves `resolveAgentHub`'s purpose parameter is actually wired through —
  // the message must NOT say "mint on" for a crew command.
  assert.match(err, /manage crews on/);
  assert.doesNotMatch(err, /mint on/);
  assert.equal(calls.length, 0, 'no network before an unresolvable hub');
});

test('crew new: exit 2 lists the stored origins when the store knows more than one hub', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_crew': createOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  writeCredentialFile(credentialFilePath(t.io.env), {
    version: 2,
    hubs: {
      'https://a.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_a' } },
      'https://b.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_b' } },
    },
  });

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'shared'], t.io);
  assert.equal(code, 2);
  const err = t.err.join('\n');
  assert.match(err, /manage crews on/);
  assert.match(err, /stored hubs:/);
  assert.match(err, /https:\/\/a\.example/);
  assert.match(err, /https:\/\/b\.example/);
  assert.equal(calls.length, 0);
});

test('crew new: a missing positional beats hub resolution — usage error (exit 1), not exit 2', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_crew': createOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  writeCredentialFile(credentialFilePath(t.io.env), {
    version: 2,
    hubs: {
      'https://a.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_a' } },
      'https://b.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_b' } },
    },
  });

  const code = await mainAsync(['crew', 'new'], t.io);
  assert.equal(code, 1, 'the usage error wins');
  assert.match(t.err.join('\n'), /missing required argument: <name>/);
  assert.equal(calls.length, 0);
});

// ---- hub refusals (message passthrough) -------------------------------------

test('crew new: a 400 (unknown --owner member) surfaces the hub message verbatim, exit 1, empty stdout', async () => {
  const { fetch } = routedFetch({
    'POST /api/create_crew': () => ({
      status: 400,
      json: { error: 'crew_invalid', message: 'unknown member id "member_bogus"' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'personal', '--owner', 'member_bogus', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /unknown member id "member_bogus"/);
  assert.deepEqual(t.out, [], 'nothing on stdout for a hub refusal');
});

test('crew new: a 403 (non-admin human) surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/create_crew': () => ({ status: 403, json: { error: 'forbidden', message: 'admin role required' } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /admin role required/);
});

test('crew rm: a 400 (crew has active workflows) surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/delete_crew': () => ({
      status: 400,
      json: { error: 'crew_in_use', message: 'crew "pl_1" has active workflows and cannot be deleted' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /crew "pl_1" has active workflows and cannot be deleted/);
});

test('crew member add: a 400 (unknown crew) surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_crew_member': () => ({ status: 400, json: { error: 'crew_not_found', message: 'unknown crew: pl_bogus' } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'member', 'add', 'pl_bogus', 'member', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /unknown crew: pl_bogus/);
});

// ---- malformed 200s (field-only errors, no body echo) -----------------------

test('crew list: a 200 with no crews array is exit 1', async () => {
  const { fetch } = routedFetch({ 'GET /api/crews': () => ({ status: 200, json: { text: 'ok' } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /crews: malformed response — expected a `crews` array/);
  assert.deepEqual(t.out, []);
});

test('crew list: a malformed crew row is exit 1, naming the INDEX and field only', async () => {
  const { fetch } = routedFetch({
    'GET /api/crews': listOk([{ ...CREW_A, members: [], name: '' }]),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /crews: malformed response — crews\[0\] missing non-empty string name/);
  assert.deepEqual(t.out, []);
});

test('crew list: a crew row with no members array is exit 1', async () => {
  const { fetch } = routedFetch({ 'GET /api/crews': () => ({ status: 200, json: { text: 'ok', crews: [CREW_A] } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /crews: malformed response — crews\[0\] missing members array/);
});

test('crew list: a malformed member row is exit 1, naming the crew AND member index', async () => {
  const { fetch } = routedFetch({
    'GET /api/crews': listOk([{ ...CREW_A, members: [{ ...MEMBER_A, principalId: '' }] }]),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /crews: malformed response — crews\[0\]\.members\[0\] missing non-empty string principalId/);
});

test('crew list: a non-string, non-null ownerMemberId is exit 1 naming that field', async () => {
  const { fetch } = routedFetch({ 'GET /api/crews': listOk([{ ...CREW_A, ownerMemberId: 7, members: [] }]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /ownerMemberId must be a non-empty string or null/);
});

test('crew list: a 200 that is NOT valid JSON is exit 1 with a FIXED message, never the parse error', async () => {
  const { fetch } = routedFetch({ 'GET /api/crews': () => ({ status: 200, raw: 'not json at all' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  const err = t.err.join('\n');
  assert.match(err, /crews: malformed response — body is not valid JSON/);
  assert.doesNotMatch(err, /Unexpected token/, 'the V8 parse-error snippet must never surface');
});

test('crew new: a 200 with no crew is exit 1, naming the missing field only', async () => {
  const { fetch } = routedFetch({ 'POST /api/create_crew': () => ({ status: 200, json: { text: 'ok' } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /create_crew: malformed success response — missing crew/);
  assert.deepEqual(t.out, []);
});

test('crew new: a 200 whose crew is missing a required field is exit 1, naming that field', async () => {
  const { fetch } = routedFetch({
    'POST /api/create_crew': () => ({
      status: 200,
      json: { text: 'ok', crew: { id: 'pl_1', kind: 'shared', ownerMemberId: null, createdBy: 'u_1', createdAt: 1 } },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /create_crew: malformed success response — crew missing non-empty string name/);
});

test('crew new: a crew with ownerMemberId ABSENT is exit 0 with ownerMemberId: null (deliberate leniency)', async () => {
  const { fetch } = routedFetch({
    'POST /api/create_crew': () => ({
      status: 200,
      json: { text: 'ok', crew: { id: 'pl_1', name: 'team-a', kind: 'shared', createdBy: 'u_1', createdAt: 1 } },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'shared', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(stdoutJson(t).ownerMemberId, null);
});

test('crew rm: a 200 with NO deleted key at all is exit 1', async () => {
  const { fetch } = routedFetch({ 'POST /api/delete_crew': () => ({ status: 200, json: { text: 'ok', crewId: 'pl_1' } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /delete_crew: malformed success response — missing boolean deleted/);
  assert.deepEqual(t.out, []);
});

test('crew rm: a non-number membersRemoved is exit 1 naming that field', async () => {
  const { fetch } = routedFetch({ 'POST /api/delete_crew': deleteOk({ membersRemoved: 'two' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /delete_crew: malformed success response — membersRemoved must be a number/);
});

test('crew rm: a non-string-array runsTransferred is exit 1 naming that field', async () => {
  const { fetch } = routedFetch({ 'POST /api/delete_crew': deleteOk({ runsTransferred: [1, 2] }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /delete_crew: malformed success response — runsTransferred must be an array of strings/);
});

test('crew rm: a 200 that is NOT valid JSON is exit 1 with a FIXED message', async () => {
  const { fetch } = routedFetch({ 'POST /api/delete_crew': () => ({ status: 200, raw: 'not json' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'rm', 'pl_1', '--hub', HUB], t.io);
  assert.equal(code, 1);
  const err = t.err.join('\n');
  assert.match(err, /delete_crew: malformed success response — body is not valid JSON/);
  assert.doesNotMatch(err, /Unexpected token/);
});

test('crew member add: a 200 with no member is exit 1, naming the missing field only', async () => {
  const { fetch } = routedFetch({ 'POST /api/add_crew_member': () => ({ status: 200, json: { text: 'ok' } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'member', 'add', 'pl_1', 'member', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /add_crew_member: malformed success response — missing member/);
  assert.deepEqual(t.out, []);
});

test('crew member add: a 200 whose member is missing a required field is exit 1, naming that field', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_crew_member': () => ({
      status: 200,
      json: { text: 'ok', member: { principalKind: 'member', addedBy: 'u_1', addedAt: 2 } },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'member', 'add', 'pl_1', 'member', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /add_crew_member: malformed success response — member missing non-empty string principalId/);
});

test('crew member rm: a 200 with NO removed key at all is exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/remove_crew_member': () => ({ status: 200, json: { text: 'ok', crewId: 'pl_1', principalId: 'u_2' } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'member', 'rm', 'pl_1', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_crew_member: malformed success response — missing boolean removed/);
  assert.deepEqual(t.out, []);
});

test('crew member rm: a 200 missing crewId is exit 1, naming that field', async () => {
  const { fetch } = routedFetch({
    'POST /api/remove_crew_member': () => ({ status: 200, json: { text: 'ok', principalId: 'u_2', removed: true } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'member', 'rm', 'pl_1', 'u_2', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_crew_member: malformed success response — missing non-empty string crewId/);
});

// ---- usage errors: zero network --------------------------------------------

test('crew: usage errors are exit 1 with ZERO network calls', async () => {
  for (const argv of [
    ['crew'],
    ['crew', 'bogus'],
    ['crew', 'new'],
    ['crew', 'new', 'team-a'], // missing --kind
    ['crew', 'rm'],
    ['crew', 'member'],
    ['crew', 'member', 'bogus'],
    ['crew', 'member', 'add'],
    ['crew', 'member', 'add', 'pl_1'],
    ['crew', 'member', 'add', 'pl_1', 'member'],
    ['crew', 'member', 'rm'],
    ['crew', 'member', 'rm', 'pl_1'],
  ]) {
    const { fetch, calls } = routedFetch({
      'GET /api/crews': listOk(),
      'POST /api/create_crew': createOk(),
      'POST /api/delete_crew': deleteOk(),
      'POST /api/add_crew_member': addMemberOk(),
      'POST /api/remove_crew_member': removeMemberOk(),
    });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 1, `argv ${JSON.stringify(argv)}`);
    assert.equal(calls.length, 0, `no network on a usage error: ${JSON.stringify(argv)}`);
  }
});

test('crew new: --owner= (explicit empty value) is a usage error, exit 1, zero network', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/create_crew': createOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'new', 'team-a', '--kind', 'shared', '--owner=', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /--owner requires a member id/);
  assert.equal(calls.length, 0);
});

test('crew list: an unknown option is rejected by preflight before any side effect', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/crews': listOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'list', '--bogus', 'x', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /unknown option --bogus for 'crew'/);
  assert.equal(calls.length, 0);
});

// ---- transport discipline ---------------------------------------------------

test('crew list: a hub TIMEOUT is a plain exit 1 (a flaky network is not an irrecoverable credential)', async () => {
  const { fetch, calls } = stallingFetch({ 'GET /api/crews': listOk() }, ['GET /api/crews']);
  const t = makeIo({ fetch, env: { OWENLOOP_HUB_TIMEOUT_MS: '80' } });
  seedHumanOauth(t);

  const code = await mainAsync(['crew', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /did not respond within/);
  assert.ok(calls.some((c) => c.pathname === '/api/crews'), 'the GET was attempted (and stalled)');
});

test('crew: every request sets redirect: error — proof it went through hubFetch, not raw fetch', async () => {
  for (const [argv, pathname] of [
    [['crew', 'list'], '/api/crews'],
    [['crew', 'new', 'team-a', '--kind', 'shared'], '/api/create_crew'],
    [['crew', 'rm', 'pl_1'], '/api/delete_crew'],
    [['crew', 'member', 'add', 'pl_1', 'member', 'u_2'], '/api/add_crew_member'],
    [['crew', 'member', 'rm', 'pl_1', 'u_2'], '/api/remove_crew_member'],
  ] as [string[], string][]) {
    const { fetch, calls } = routedFetch({
      'GET /api/crews': listOk(),
      'POST /api/create_crew': createOk(),
      'POST /api/delete_crew': deleteOk(),
      'POST /api/add_crew_member': addMemberOk(),
      'POST /api/remove_crew_member': removeMemberOk(),
    });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 0, t.err.join('\n'));
    const req = calls.find((c) => c.pathname === pathname)!;
    assert.equal(req.redirect, 'error', `${pathname} must be fetched with redirect: 'error'`);
  }
});
