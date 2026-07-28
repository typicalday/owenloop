/**
 * `owenloop binding new|rm|list` driven in-process through `mainAsync`. The three
 * hub endpoints (`POST /api/set_label_binding`, `POST /api/delete_label_binding`,
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
 *   - `binding new` POSTs to `/api/set_label_binding` and to nothing else (the
 *     v1 `create_`-prefixed route name is dead and must never be requested);
 *   - `binding new` on an already-bound label is a normal SUCCESS (the hub
 *     upserts), reporting `previousPool` on stdout and `old → new` on stderr;
 *   - a fresh bind emits NO stderr echo;
 *   - `rm`'s stdout is `{ ok, hub, label }` — `deleted` is validated on the wire
 *     but never printed;
 *   - `rm` is **idempotent**: a 200 `{deleted: false}` (the label was not bound)
 *     is exit 0 with stdout identical to a real delete; only a 200 whose
 *     `deleted` is absent or non-boolean is exit 1;
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

/** A realistic 200 `set_label_binding` body — `{ text, binding }`, house shape. */
function setOk(over: Record<string, unknown> = {}): RouteHandler {
  return () => ({
    status: 200,
    json: {
      text: 'Label "gpu" is now bound to pool "ml-pool".',
      binding: {
        label: 'gpu',
        poolId: 'pl_1',
        poolName: 'ml-pool',
        createdBy: 'u_1',
        createdAt: 1,
        previousPoolName: null,
        ...over,
      },
    },
  });
}

/** A realistic 200 `delete_label_binding` body — `{ text, deleted: true }`. */
function deleteOk(): RouteHandler {
  return () => ({ status: 200, json: { text: 'Label "gpu" is no longer bound.', deleted: true } });
}

const ROW_A = { label: 'gpu', poolId: 'pl_1', poolName: 'ml-pool', createdBy: 'u_1', createdAt: 1 };
const ROW_B = { label: 'repo-access', poolId: 'pl_2', poolName: 'build-fleet', createdBy: 'u_2', createdAt: 2 };

/** A realistic 200 `label_bindings` body — `{ text, bindings }`. */
function listOk(rows: unknown[] = [ROW_A, ROW_B]): RouteHandler {
  return () => ({ status: 200, json: { text: `${rows.length} label binding(s).`, bindings: rows } });
}

/** Parse the single JSON document the command wrote to stdout. */
function stdoutJson(t: HubIo): Record<string, unknown> {
  return JSON.parse(t.out.join('\n')) as Record<string, unknown>;
}

// ---- happy paths ------------------------------------------------------------

test('binding new: fresh bind POSTs set_label_binding and prints previousPool: null with NO stderr echo', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/set_label_binding': setOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  // Exactly one request, to the `set_`-prefixed route — pinning that the dead
  // v1 `create_`-prefixed route name survives nowhere in the code path.
  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.pathname, '/api/set_label_binding');
  assert.equal(req.method, 'POST');
  assert.equal(req.authorization, 'Bearer mcpat_x');
  assert.deepEqual(JSON.parse(req.body!), { label: 'gpu', pool: 'ml-pool' });

  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, label: 'gpu', pool: 'ml-pool', previousPool: null });
  assert.equal(stdoutJson(t).text, undefined, 'no raw hub body spread onto stdout');
  assert.ok(!t.err.join('\n').includes('→'), 'a FRESH bind emits no retarget echo');
});

test('binding new: a RETARGET is a normal success — previousPool on stdout, old → new on stderr', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/set_label_binding': setOk({ poolName: 'cheap-fleet', previousPoolName: 'gpu-fleet' }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'cheap-fleet', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  // The CLI sends no "retarget" flag — the upsert is entirely server-side, so
  // the request body is identical to the fresh-bind case.
  const req = calls.find((c) => c.pathname === '/api/set_label_binding')!;
  assert.deepEqual(JSON.parse(req.body!), { label: 'gpu', pool: 'cheap-fleet' });

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    label: 'gpu',
    pool: 'cheap-fleet',
    previousPool: 'gpu-fleet',
  });
  // U+2192, the house glyph for an old → new progress line.
  assert.ok(t.err.join('\n').includes('gpu: gpu-fleet → cheap-fleet'), 'the retarget echo goes to stderr verbatim');
});

test('binding new: stdout prints the SERVER-echoed label/pool, not argv', async () => {
  const { fetch } = routedFetch({
    'POST /api/set_label_binding': setOk({ label: 'gpu', poolName: 'ml-pool-canonical' }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ML-Pool', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(stdoutJson(t).pool, 'ml-pool-canonical', 'stdout tells the truth about what the hub stored');
});

test('binding rm: POSTs delete_label_binding and prints { ok, hub, label } with NO deleted key', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/delete_label_binding': deleteOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const req = calls.find((c) => c.pathname === '/api/delete_label_binding')!;
  assert.equal(req.method, 'POST');
  assert.equal(req.authorization, 'Bearer mcpat_x');
  assert.deepEqual(JSON.parse(req.body!), { label: 'gpu' });

  // The wire body carries `deleted: true` (the guard validates it) but stdout
  // must not — that split is the frozen §2.4 output contract.
  const out = stdoutJson(t);
  assert.equal(out.deleted, undefined, 'deleted is validated on the wire, never printed');
  assert.deepEqual(out, { ok: true, hub: ORIGIN, label: 'gpu' });
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
    ['binding', 'rm', 'gpu', '--hub', HUB],
    ['binding', 'list', '--hub', HUB],
  ]) {
    const { fetch, calls } = routedFetch({
      'POST /api/set_label_binding': setOk(),
      'POST /api/delete_label_binding': deleteOk(),
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
    'POST /api/set_label_binding': setOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.ok(calls.some((c) => c.pathname === '/mcp/token'), 'a refresh happened');
  const req = calls.find((c) => c.pathname === '/api/set_label_binding')!;
  assert.equal(req.authorization, 'Bearer mcpat_new', 'the POST used the refreshed bearer');

  // The rotated credential was persisted.
  const human = JSON.parse(t.store.get(kcHuman(ORIGIN))!) as Credential;
  assert.equal(human.accessToken, 'mcpat_new');
});

test('binding new: an expired human oauth whose refresh is REJECTED is exit 3 (irrecoverable)', async () => {
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 400, json: { error: 'invalid_grant' } }),
    'POST /api/set_label_binding': setOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), new RegExp(`run: owenloop login --hub ${ORIGIN.replace(/[.]/g, '\\.')}`));
  assert.ok(!calls.some((c) => c.pathname === '/api/set_label_binding'), 'nothing bound after a failed refresh');
});

test('binding new: a 401 that survives the retry is `credential rejected`, exit 3', async () => {
  // An `oauth-pasted` credential has no refresh path, so the 401 is final on the
  // first response — the exact "irrecoverable credential" family.
  const { fetch } = routedFetch({
    'POST /api/set_label_binding': () => ({ status: 401, json: { error: 'unauthorized' } }),
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
  const { fetch, calls } = routedFetch({ 'POST /api/set_label_binding': setOk() });
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

test('binding new: a missing positional beats hub resolution — usage error (exit 1), not exit 2', async () => {
  // Multi-hub machine: if validation ran AFTER resolveAgentHub this would be a
  // confusing exit 2 about hubs rather than the real problem.
  const { fetch, calls } = routedFetch({ 'POST /api/set_label_binding': setOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  writeCredentialFile(credentialFilePath(t.io.env), {
    version: 2,
    hubs: {
      'https://a.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_a' } },
      'https://b.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_b' } },
    },
  });

  const code = await mainAsync(['binding', 'new'], t.io);
  assert.equal(code, 1, 'the usage error wins');
  assert.match(t.err.join('\n'), /missing required argument: <label>/);
  assert.equal(calls.length, 0);
});

// ---- hub refusals (message passthrough) -------------------------------------

test('binding new: a 400 label_binding_invalid surfaces the hub message verbatim, exit 1, empty stdout', async () => {
  const { fetch } = routedFetch({
    'POST /api/set_label_binding': () => ({
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
    'POST /api/set_label_binding': () => ({
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

test('binding rm: a 400 on delete surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/delete_label_binding': () => ({
      status: 400,
      json: { error: 'label_binding_invalid', message: 'label "gpu" is not bound' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /label "gpu" is not bound/);
});

// ---- malformed 200s (field-only errors, no body echo) -----------------------

test('binding new: a 200 with no binding is exit 1, naming the missing field only', async () => {
  const { fetch } = routedFetch({
    'POST /api/set_label_binding': () => ({ status: 200, json: { text: 'ok' } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  const err = t.err.join('\n');
  assert.match(err, /set_label_binding: malformed success response — missing binding/);
  assert.deepEqual(t.out, []);
});

test('binding new: a 200 whose binding is missing poolName is exit 1, naming that field', async () => {
  const { fetch } = routedFetch({
    'POST /api/set_label_binding': () => ({
      status: 200,
      json: { text: 'ok', binding: { label: 'gpu', poolId: 'pl_1', createdBy: 'u_1', createdAt: 1 } },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /set_label_binding: malformed success response — binding missing non-empty string poolName/);
});

test('binding new: a 200 that is NOT valid JSON is exit 1 with a FIXED message, never the parse error', async () => {
  const { fetch } = routedFetch({
    'POST /api/set_label_binding': () => ({ status: 200, raw: 'not json at all' }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  const err = t.err.join('\n');
  assert.match(err, /set_label_binding: malformed success response — body is not valid JSON/);
  assert.doesNotMatch(err, /Unexpected token/, 'the V8 parse-error snippet must never surface');
});

test('binding new: a non-string, non-null previousPoolName is exit 1 naming that field', async () => {
  const { fetch } = routedFetch({ 'POST /api/set_label_binding': setOk({ previousPoolName: 7 }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /previousPoolName must be a non-empty string or null/);
});

test('binding new: a binding with previousPoolName ABSENT is exit 0 with previousPool: null (deliberate leniency)', async () => {
  // A serializer that drops `undefined` must not turn a successful bind into a
  // failure — absent and null both mean "fresh bind". Pinned so nobody
  // "tightens" the guard by accident.
  const { fetch } = routedFetch({
    'POST /api/set_label_binding': () => ({
      status: 200,
      json: {
        text: 'ok',
        binding: { label: 'gpu', poolId: 'pl_1', poolName: 'ml-pool', createdBy: 'u_1', createdAt: 1 },
      },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, label: 'gpu', pool: 'ml-pool', previousPool: null });
  assert.ok(!t.err.join('\n').includes('→'), 'an absent previousPoolName is a fresh bind — no echo');
});

test('binding rm: a 200 with NO deleted key at all is exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/delete_label_binding': () => ({ status: 200, json: { text: 'ok' } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /delete_label_binding: malformed success response — missing boolean deleted/);
  assert.deepEqual(t.out, []);
});

test('binding rm: a 200 with deleted: false (the label was not bound) is exit 0 with identical stdout — rm is idempotent', async () => {
  // The hub answers 200 `{deleted: false}` for an unbound label, never a 404
  // (owenloop-service docs/decisions/label-bindings.md). stdout must be
  // byte-identical to a real delete — that identity is what idempotent means
  // at this surface, and a scripted consumer must not have to branch on it.
  const { fetch } = routedFetch({
    'POST /api/delete_label_binding': () => ({
      status: 200,
      json: { text: "Label 'gpu' was not bound.", label: 'gpu', deleted: false },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'rm', 'gpu', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, label: 'gpu' });
  assert.deepEqual(t.err, [], 'no extra stderr line either — rm prints nothing extra when the label was not bound');
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
  ]) {
    const { fetch, calls } = routedFetch({
      'POST /api/set_label_binding': setOk(),
      'POST /api/delete_label_binding': deleteOk(),
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
  const { fetch, calls } = stallingFetch({ 'POST /api/set_label_binding': setOk() }, ['POST /api/set_label_binding']);
  const t = makeIo({ fetch, env: { OWENLOOP_HUB_TIMEOUT_MS: '80' } });
  seedHumanOauth(t);

  const code = await mainAsync(['binding', 'new', 'gpu', 'ml-pool', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /did not respond within/);
  assert.ok(calls.some((c) => c.pathname === '/api/set_label_binding'), 'the POST was attempted (and stalled)');
});

test('binding: every request sets redirect: error — proof it went through hubFetch, not raw fetch', async () => {
  for (const [argv, pathname] of [
    [['binding', 'new', 'gpu', 'ml-pool'], '/api/set_label_binding'],
    [['binding', 'rm', 'gpu'], '/api/delete_label_binding'],
    [['binding', 'list'], '/api/label_bindings'],
  ] as [string[], string][]) {
    const { fetch, calls } = routedFetch({
      'POST /api/set_label_binding': setOk(),
      'POST /api/delete_label_binding': deleteOk(),
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
