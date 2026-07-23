/**
 * `owenloop agent new <name>` driven in-process through `mainAsync`. The hub
 * mint endpoint (`POST /api/mint_agent_token`) and the OAuth refresh endpoints
 * are canned `routedFetch`/`stallingFetch` routes; credentials land in an
 * injected fake keychain or, with OWENLOOP_NO_KEYCHAIN=1, the 0600 file under a
 * fixture `$HOME`. Fully hermetic — every test materializes its own `$HOME`/env
 * via `makeIo`, so no ambient state is read.
 *
 * THE flagship invariant (identity model §6): the minted `olp_` token goes
 * process→store only and never reaches stdout or stderr. `assertNoTokenLeak`
 * asserts that on EVERY test, and the fake mint route deliberately embeds the
 * token inside its `text` field (exactly like the real server) so the assertion
 * is load-bearing, not vacuous.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainAsync } from '../src/cli.ts';
import type { Keychain } from '../src/cli.ts';
import { credentialFilePath, readCredentialFile, writeCredentialFile } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { kcHuman, kcKey, makeIo, OAUTH_METADATA, routedFetch, stallingFetch } from './hubkit.ts';
import type { HubIo, RouteHandler } from './hubkit.ts';

const HUB = 'http://127.0.0.1:9';
const ORIGIN = 'http://127.0.0.1:9';

/** The one-time plaintext token the fake hub mints — embedded in `text` too. */
const TOKEN = 'olp_1f2e_secretpart';

/**
 * THE flagship assertion, run on every test: neither stdout nor stderr may ever
 * contain the `olp_` substring. stdout is the brief's named target; stderr is
 * covered because error paths print there.
 */
function assertNoTokenLeak(t: HubIo): void {
  assert.ok(!t.out.join('\n').includes('olp_'), 'stdout must not contain an olp_ token');
  assert.ok(!t.err.join('\n').includes('olp_'), 'stderr must not contain an olp_ token');
}

/** A realistic 200 mint body: the token is ALSO inside `text`, like the real server. */
function mintOk(): RouteHandler {
  return () => ({
    status: 200,
    json: {
      text: `Agent token minted (id tok_1) for pool(s) personal-alex. Store this secret now — it will not be shown again:\n${TOKEN}`,
      id: 'tok_1',
      token: TOKEN,
      agentId: 'agent_1',
      pools: ['personal-alex'],
      poolIds: ['pool_1'],
    },
  });
}

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

// ---- happy path -------------------------------------------------------------

test('agent new: mints, stores the token in slot agent:<name>, prints a token-free confirmation', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--pools', 'a,b', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  // The mint request carried the human bearer and the exact JSON body.
  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token')!;
  assert.equal(mint.authorization, 'Bearer mcpat_x');
  assert.deepEqual(JSON.parse(mint.body!), { name: 'codex', scopes: ['work'], pools: ['a', 'b'] });

  // The token landed in slot agent:codex, as an `agent` credential.
  const stored = JSON.parse(t.store.get(kcKey(ORIGIN, 'agent:codex'))!) as Credential;
  assert.deepEqual(stored, { kind: 'agent', accessToken: TOKEN });

  // stdout confirmation: whitelisted fields only, server-resolved pools, no token/text.
  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.ok, true);
  assert.equal(result.name, 'codex');
  assert.equal(result.slot, 'agent:codex');
  assert.equal(result.storage, 'keychain');
  assert.deepEqual(result.pools, ['personal-alex']);
  assert.deepEqual(result.scopes, ['work']);
  assert.equal(result.hub, ORIGIN);
  assert.equal(result.agentId, 'agent_1');
  assert.equal(result.tokenId, 'tok_1');
  assert.equal(result.token, undefined, 'no token field on the confirmation');
  assert.equal(result.text, undefined, 'no text field on the confirmation');

  assertNoTokenLeak(t);
});

test('agent new: --pools omitted sends NO pools key (server defaults to the personal pool)', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token')!;
  const body = JSON.parse(mint.body!);
  assert.deepEqual(body, { name: 'codex', scopes: ['work'] });
  assert.ok(!('pools' in body), 'the pools key is omitted entirely, never sent as []');
  assertNoTokenLeak(t);
});

// ---- origin resolution: --hub → single stored hub → exit 2 -----------------

test('agent new: exit 2 when no --hub and the store knows zero hubs (keychain-only machine)', async () => {
  // OWENLOOP_NO_KEYCHAIN=1 + empty fixture $HOME → listStoredHubOrigins() is [].
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });

  const code = await mainAsync(['agent', 'new', 'codex'], t.io);
  assert.equal(code, 2);
  const err = t.err.join('\n');
  assert.match(err, /--hub/);
  assert.match(err, /owenloop login/);
  assert.equal(calls.length, 0, 'no network before an unresolvable hub');
  assertNoTokenLeak(t);
});

test('agent new: exit 2 lists the stored origins when the store knows more than one hub', async () => {
  const { fetch } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  writeCredentialFile(credentialFilePath(t.io.env), {
    version: 2,
    hubs: {
      'https://a.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_a' } },
      'https://b.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_b' } },
    },
  });

  const code = await mainAsync(['agent', 'new', 'codex'], t.io);
  assert.equal(code, 2);
  const err = t.err.join('\n');
  assert.match(err, /stored hubs:/);
  assert.match(err, /https:\/\/a\.example/);
  assert.match(err, /https:\/\/b\.example/);
  assertNoTokenLeak(t);
});

test('agent new: no --hub with exactly one stored hub auto-resolves and mints (file backend end-to-end)', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  const path = credentialFilePath(t.io.env);
  writeCredentialFile(path, {
    version: 2,
    hubs: { [ORIGIN]: { human: { kind: 'oauth-pasted', accessToken: 'mcpat_x' } } },
  });

  const code = await mainAsync(['agent', 'new', 'codex'], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token')!;
  assert.equal(mint.authorization, 'Bearer mcpat_x');

  const result = JSON.parse(t.out.join('\n'));
  assert.equal(result.storage, 'file');
  assert.equal(result.hub, ORIGIN);

  // The token landed in the file, and the human slot is left intact (merge).
  const file = readCredentialFile(path);
  assert.deepEqual(file.hubs[ORIGIN]?.['agent:codex'], { kind: 'agent', accessToken: TOKEN });
  assert.equal(file.hubs[ORIGIN]?.human?.accessToken, 'mcpat_x');
  assertNoTokenLeak(t);
});

// ---- exit 3: human credential absent / irrecoverable -----------------------

test('agent new: exit 3 when no human credential exists for the resolved hub', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch }); // empty keychain

  const code = await mainAsync(['agent', 'new', 'codex', '--hub', HUB], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), new RegExp(`run: owenloop login --hub ${ORIGIN.replace(/[.]/g, '\\.')}`));
  assert.equal(calls.length, 0, 'no mint attempted without a human credential');
  assert.equal(t.store.get(kcKey(ORIGIN, 'agent:codex')), undefined);
  assertNoTokenLeak(t);
});

test('agent new: an expired human oauth that REFRESHES proceeds and mints with the refreshed bearer', async () => {
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 200, json: { access_token: 'mcpat_new', expires_in: 3600 } }),
    'POST /api/mint_agent_token': mintOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['agent', 'new', 'codex', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.ok(calls.some((c) => c.pathname === '/mcp/token'), 'a refresh happened');
  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token')!;
  assert.equal(mint.authorization, 'Bearer mcpat_new', 'mint used the refreshed bearer');

  // The refreshed human credential was persisted, and the agent token stored.
  const human = JSON.parse(t.store.get(kcHuman(ORIGIN))!) as Credential;
  assert.equal(human.accessToken, 'mcpat_new');
  const stored = JSON.parse(t.store.get(kcKey(ORIGIN, 'agent:codex'))!) as Credential;
  assert.equal(stored.accessToken, TOKEN);
  assertNoTokenLeak(t);
});

test('agent new: an expired human oauth whose refresh is REJECTED is exit 3 (irrecoverable)', async () => {
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 400, json: { error: 'invalid_grant' } }),
    'POST /api/mint_agent_token': mintOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['agent', 'new', 'codex', '--hub', HUB], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), new RegExp(`run: owenloop login --hub ${ORIGIN.replace(/[.]/g, '\\.')}`));
  assert.ok(!calls.some((c) => c.pathname === '/api/mint_agent_token'), 'nothing minted after a failed refresh');
  assert.equal(t.store.get(kcKey(ORIGIN, 'agent:codex')), undefined);
  assertNoTokenLeak(t);
});

test('agent new: a hub TIMEOUT during mint is a plain exit 1 (a flaky network is not an irrecoverable credential)', async () => {
  const { fetch, calls } = stallingFetch({ 'POST /api/mint_agent_token': mintOk() }, ['POST /api/mint_agent_token']);
  const t = makeIo({ fetch, env: { OWENLOOP_HUB_TIMEOUT_MS: '80' } });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /did not respond within/);
  assert.ok(calls.some((c) => c.pathname === '/api/mint_agent_token'), 'the mint was attempted (and stalled)');
  assert.equal(t.store.get(kcKey(ORIGIN, 'agent:codex')), undefined);
  assertNoTokenLeak(t);
});

// ---- server refusals (surfaced verbatim, nothing stored) -------------------

test('agent new: an existing name surfaces the hub error verbatim, exit 1, nothing stored', async () => {
  const { fetch } = routedFetch({
    'POST /api/mint_agent_token': () => ({
      status: 400,
      json: { error: 'agent_name_invalid', message: 'agent name already taken: "codex"' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /agent name already taken: "codex"/);
  assert.equal(t.store.get(kcKey(ORIGIN, 'agent:codex')), undefined, 'nothing stored on a name clash');
  assertNoTokenLeak(t);
});

test('agent new: a pool_invalid 4xx surfaces the hub message, exit 1, nothing stored', async () => {
  const { fetch } = routedFetch({
    'POST /api/mint_agent_token': () => ({
      status: 400,
      json: { error: 'pool_invalid', message: 'a key must name at least one pool' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--pools', 'nope', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /a key must name at least one pool/);
  assert.equal(t.store.get(kcKey(ORIGIN, 'agent:codex')), undefined);
  assertNoTokenLeak(t);
});

test('agent new: a forbidden 403 (non-member pool) surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/mint_agent_token': () => ({
      status: 403,
      json: { error: 'forbidden', message: 'not a member of pool "secret"' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--pools', 'secret', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /not a member of pool "secret"/);
  assertNoTokenLeak(t);
});

// ---- malformed success (field-only error, no body echo) --------------------

test('agent new: a malformed 200 (missing token) is exit 1, names the field only, echoes no body text, stores nothing', async () => {
  const { fetch } = routedFetch({
    'POST /api/mint_agent_token': () => ({
      status: 200,
      json: {
        // Still carries the token inside `text` — the no-leak assertion must hold.
        text: `Store this secret now — it will not be shown again:\n${TOKEN}`,
        id: 'tok_1',
        agentId: 'agent_1',
        pools: ['personal-alex'],
        // token: MISSING
      },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /missing non-empty string token/);
  assert.equal(t.store.get(kcKey(ORIGIN, 'agent:codex')), undefined);
  assertNoTokenLeak(t);
});

test('agent new: a 200 whose body is NOT valid JSON is exit 1, names invalid-JSON only, leaks no body text, stores nothing', async () => {
  // The success path is the one endpoint whose body carries the plaintext token.
  // A 200 with a raw, non-JSON body (a proxy/truncation quirk, or a hub bug that
  // dumps the token as text) makes `res.json()` throw a V8 SyntaxError whose
  // message embeds a verbatim snippet of that body — the token. The mint code
  // must wrap the parse and throw a FIXED string, never the parse-error message.
  const { fetch } = routedFetch({
    'POST /api/mint_agent_token': () => ({
      status: 200,
      // Raw text body (not JSON) that literally contains the token.
      raw: `Store this secret now — it will not be shown again:\n${TOKEN}`,
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--hub', HUB], t.io);
  assert.equal(code, 1);
  const err = t.err.join('\n');
  assert.match(err, /malformed success response — body is not valid JSON/);
  // The V8 parse-error snippet must NOT surface — only the fixed message above.
  assert.doesNotMatch(err, /Unexpected token/);
  assert.equal(t.store.get(kcKey(ORIGIN, 'agent:codex')), undefined, 'nothing stored');
  assertNoTokenLeak(t);
});

// ---- keychain write failure AFTER a successful mint ------------------------

test('agent new: a keychain write failure after a successful mint is exit 1 (minted-but-unstored), no token leak', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const store = new Map<string, string>();
  const composite = (service: string, account: string): string => `${service}\u0000${account}`;
  // A keychain that reads (to fetch the human bearer) but fails every write.
  const failingKeychain: Keychain = {
    get: (s, a) => store.get(composite(s, a)) ?? null,
    set: () => {
      throw new Error('keychain is locked');
    },
    delete: (s, a) => void store.delete(composite(s, a)),
  };
  const t = makeIo({ fetch, keychain: failingKeychain, store });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--hub', HUB], t.io);
  assert.equal(code, 1);
  const err = t.err.join('\n');
  assert.match(err, /minted but could not be stored locally/);
  assert.match(err, /re-running `agent new codex` will refuse the taken name/);
  assert.ok(calls.some((c) => c.pathname === '/api/mint_agent_token'), 'the token WAS minted server-side');
  assert.equal(store.get(kcKey(ORIGIN, 'agent:codex')), undefined, 'nothing stored');
  assertNoTokenLeak(t); // the failure message must still carry no olp_
});

// ---- external credential command: refused before any read/network ----------

test('agent new: OWENLOOP_CREDENTIAL_COMMAND is refused before any network (nothing minted, name not burned)', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_CREDENTIAL_COMMAND: 'my-cred-helper' } });

  const code = await mainAsync(['agent', 'new', 'codex', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /OWENLOOP_CREDENTIAL_COMMAND/);
  assert.equal(calls.length, 0, 'no network — refused before any read or mint');
  assertNoTokenLeak(t);
});

// ---- client-side name validation: zero network -----------------------------

test('agent new: a client-side invalid name is exit 1 with the account-regex message and ZERO fetch calls', async () => {
  for (const bad of ['bad name', '', 'a'.repeat(65), '-leadinghyphen']) {
    const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync(['agent', 'new', bad, '--hub', HUB], t.io);
    assert.equal(code, 1, `name ${JSON.stringify(bad)} should be rejected`);
    assert.match(t.err.join('\n'), /invalid agent name/);
    assert.equal(calls.length, 0, 'no network for a client-rejected name');
    assertNoTokenLeak(t);
  }
});

test('agent new: --pools "" is a usage error with no network', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--pools', '', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /--pools requires at least one pool name/);
  assert.equal(calls.length, 0);
  assertNoTokenLeak(t);
});

// ---- subcommand / usage errors ---------------------------------------------

test('agent new: usage errors for an unknown subcommand and a missing name (exit 1, no network)', async () => {
  for (const argv of [['agent'], ['agent', 'list'], ['agent', 'new']]) {
    const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync(argv, t.io);
    assert.equal(code, 1, `argv ${JSON.stringify(argv)}`);
    assert.equal(calls.length, 0, 'no network on a usage error');
    assertNoTokenLeak(t);
  }
});

test('agent new: an unknown option is rejected by preflight before any side effect', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--bogus', 'x', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /unknown option --bogus for 'agent'/);
  assert.equal(calls.length, 0);
  assertNoTokenLeak(t);
});

// ---- selectable scopes ------------------------------------------------------

test('agent new: --scopes work,run mints with those scopes and prints them', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--scopes', 'work,run', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token')!;
  assert.deepEqual(JSON.parse(mint.body!), { name: 'codex', scopes: ['work', 'run'] });

  const result = JSON.parse(t.out.join('\n'));
  assert.deepEqual(result.scopes, ['work', 'run'], 'printed scopes reflect the resolved request value');
  assertNoTokenLeak(t);
});

test('agent new: --conductor is sugar for --scopes work,run', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--conductor', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token')!;
  assert.deepEqual(JSON.parse(mint.body!), { name: 'codex', scopes: ['work', 'run'] });

  const result = JSON.parse(t.out.join('\n'));
  assert.deepEqual(result.scopes, ['work', 'run']);
  assertNoTokenLeak(t);
});

test('agent new: --scopes and --conductor together is a usage error, no network', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--scopes', 'work,run', '--conductor', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /at most one of --scopes or --conductor/);
  assert.equal(calls.length, 0, 'no network on a usage error');
  assertNoTokenLeak(t);
});

test('agent new: --scopes "" is a usage error before any network call', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/mint_agent_token': mintOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['agent', 'new', 'codex', '--scopes', '', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /--scopes requires at least one scope name/);
  assert.equal(calls.length, 0, 'no network on a usage error');
  assertNoTokenLeak(t);
});
