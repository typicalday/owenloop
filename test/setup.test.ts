/**
 * `owenloop setup` — the idempotent converger (identity model §7 Flow A/B),
 * driven in-process through `mainAsync` against the stateful `makeIdentityHub`
 * fake. Proves: the six steps run in order, a fresh machine mints/logs in, a
 * SECOND run performs zero writes (idempotency), the succession prompt (Flow B)
 * renders verbatim framing and rekeys the chosen agent, the `--replace-agent` /
 * `--new-agent` bypasses skip the prompt, and the non-interactive guard fires.
 *
 * Secrets discipline: `assertNoOlp(t)` ends EVERY acceptance test — the fake's
 * mint/rekey tokens all start `olp_` and ride in the response `text` field, so a
 * leak to stdout/stderr would trip it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mainAsync, sanitizeAgentName, lastActiveMs, formatLastActive } from '../src/cli.ts';
import type { AgentIdentitySummary } from '../src/hub.ts';
import { asAgentIdentities, asRekeyAgentTokenOk } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import {
  assertNoOlp,
  fakeKeychain,
  kcHuman,
  kcKey,
  makeIdentityHub,
  makeIo,
  routedFetch,
} from './hubkit.ts';
import { owenworkSettingsPath } from '../src/owenwork.ts';

const HUB = 'http://127.0.0.1:9';
const ORIGIN = 'http://127.0.0.1:9';

/** An `openUrl` that plays the browser+consent, driving the real loopback callback. */
function driveCallback() {
  return (authUrl: string) => {
    const u = new URL(authUrl);
    const cb = new URL(u.searchParams.get('redirect_uri')!);
    cb.searchParams.set('code', 'auth-code-1');
    cb.searchParams.set('state', u.searchParams.get('state')!);
    void fetch(cb.toString()).catch(() => {});
  };
}

/** Seed a fresh, non-expiring human oauth credential directly into a keychain store. */
function seedHuman(store: Map<string, string>): void {
  store.set(
    kcHuman(ORIGIN),
    JSON.stringify({
      kind: 'oauth',
      accessToken: 'mcpat_seeded',
      refreshToken: 'rt_seeded',
      expiresAt: Date.now() + 3_600_000,
      clientId: 'client-abc',
    }),
  );
}

// ---- Flow A: fresh machine ---------------------------------------------------

test('setup: fresh machine, scripted --new-agent runs steps 2-6 in order and converges', async () => {
  const { routes } = makeIdentityHub();
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch, onOpenUrl: driveCallback() });

  const code = await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  // Step banners appear in order on stderr.
  const errText = t.err.join('\n');
  const order = ['[1/6]', '[2/6]', '[3/6]', '[4/6]', '[5/6]', '[6/6]'];
  let last = -1;
  for (const marker of order) {
    const at = errText.indexOf(marker);
    assert.ok(at > last, `banner ${marker} out of order (at ${at}, prev ${last})`);
    last = at;
  }

  // Network order: DCR + token grant precede the mint.
  const regIdx = calls.findIndex((c) => c.pathname === '/mcp/register');
  const tokIdx = calls.findIndex((c) => c.pathname === '/mcp/token');
  const mintIdx = calls.findIndex((c) => c.pathname === '/api/mint_agent_token');
  assert.ok(regIdx >= 0 && tokIdx >= 0 && mintIdx >= 0, 'register, token, mint all called');
  assert.ok(regIdx < mintIdx && tokIdx < mintIdx, 'auth precedes mint');

  // Human slot + agent:buildbox slot landed in the keychain.
  const human = JSON.parse(t.store.get(kcHuman(ORIGIN))!) as Credential;
  assert.equal(human.accessToken, 'mcpat_access');
  assert.ok(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'buildbox' })), 'agent:buildbox stored');

  // owenwork settings written with hubOrigin = the hub.
  const settings = JSON.parse(readFileSync(owenworkSettingsPath(t.io.env), 'utf8'));
  assert.equal(settings.hubOrigin, ORIGIN);

  // Machine-readable summary on stdout; doctor ran.
  const summary = JSON.parse(t.out.join('\n'));
  assert.equal(summary.ok, true);
  assert.equal(summary.hub, ORIGIN);
  assert.ok(Array.isArray(summary.doctor.checks) && summary.doctor.checks.length >= 5, 'doctor checks present');

  assertNoOlp(t);
});

test('setup: fresh machine interactive — injected prompt names the agent; empty answer accepts the hostname prefill', async () => {
  // (a) a typed name.
  {
    const { routes } = makeIdentityHub();
    const { fetch } = routedFetch(routes);
    const questions: string[] = [];
    const t = makeIo({
      fetch,
      onOpenUrl: driveCallback(),
      prompt: async (q) => {
        questions.push(q);
        return 'mybox';
      },
    });
    assert.equal(await mainAsync(['setup', '--hub', HUB], t.io), 0, t.err.join('\n'));
    assert.ok(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'mybox' })), 'agent:mybox stored');
    assert.match(questions.join('\n'), /Name this Scoped Identity \[/, 'prefill prompt shown');
    assertNoOlp(t);
  }

  // (b) an empty answer accepts the sanitized-hostname prefill.
  {
    const expected = sanitizeAgentName(hostname());
    assert.ok(expected !== '', 'test host has a sanitizable hostname');
    const { routes } = makeIdentityHub();
    const { fetch } = routedFetch(routes);
    const t = makeIo({ fetch, onOpenUrl: driveCallback(), prompt: async () => '' });
    assert.equal(await mainAsync(['setup', '--hub', HUB], t.io), 0, t.err.join('\n'));
    assert.ok(
      t.store.get(kcKey(ORIGIN, { principal: 'agent', account: expected })),
      `agent:${expected} stored from the hostname prefill`,
    );
    assertNoOlp(t);
  }
});

// ---- idempotency: the second run is a no-op ---------------------------------

test('setup: a second run performs ZERO writes (no store mutation, no settings write, no browser, no mint)', async () => {
  const sharedHome = mkdtempSync(join(tmpdir(), 'owenloop-setup-home-'));
  const { keychain, store } = fakeKeychain();
  const { routes } = makeIdentityHub();

  // Run 1 — converge a fresh machine.
  const r1 = routedFetch(routes);
  const t1 = makeIo({ fetch: r1.fetch, keychain, store, env: { HOME: sharedHome }, onOpenUrl: driveCallback() });
  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t1.io), 0, t1.err.join('\n'));

  const storeSnapshot = [...store.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const settingsPath = owenworkSettingsPath(t1.io.env);
  const settingsBytes = readFileSync(settingsPath, 'utf8');

  // Run 2 — same state, fresh call recorder.
  const r2 = routedFetch(routes);
  const t2 = makeIo({ fetch: r2.fetch, keychain, store, env: { HOME: sharedHome } });
  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t2.io), 0, t2.err.join('\n'));

  assert.deepEqual([...store.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), storeSnapshot, 'keychain unchanged on the second run');
  assert.equal(readFileSync(settingsPath, 'utf8'), settingsBytes, 'settings file byte-identical');
  assert.equal(t2.openedUrls.length, 0, 'no browser opened on the second run');

  const run2Posts = r2.calls.filter((c) => c.method === 'POST').map((c) => c.pathname);
  for (const forbidden of ['/api/mint_agent_token', '/api/rekey_agent_token', '/mcp/register', '/mcp/token']) {
    assert.ok(!run2Posts.includes(forbidden), `no ${forbidden} on the idempotent second run`);
  }

  assertNoOlp(t2);
});

// ---- external credential command: refuse before opening the browser ---------

test('setup: an external credential command refuses BEFORE any browser opens (symmetric with login)', async () => {
  // Same incident class as the login guard (PR #69): when OWENLOOP_CREDENTIAL_COMMAND
  // is set the external command — not the local store — supplies this hub's
  // credentials, so setup's human-login step (which opens the loopback OAuth
  // browser) and its agent mint would strand keys nobody reads. Setup must fail
  // FAST with login's EXACT refusal, at the top, before any step runs.
  //
  // What the guard replaces: without it, setup gives a confusing, non-symmetric
  // late failure. In external mode `readCredential` never returns null — the
  // command either yields a well-formed credential or THROWS (hub.ts
  // runCredentialCommand). So a missing/failing command (here `my-helper`, not
  // on PATH) throws at step 1 inspect with a raw "external credential command
  // failed … status 127" message; a succeeding command instead fails later at
  // step 3's mint refusal after network calls. Either way the loopback-OAuth
  // browser is never reached, so `openedUrls` is a standing witness that no
  // browser opens — and the DISTINGUISHING signal this test asserts is that the
  // error is login's clean refusal, which only the guard produces. Pre-fix the
  // error is the raw status-127 text (no OWENLOOP_CREDENTIAL_COMMAND / "unset
  // it" guidance), so this test fails without the guard and passes with it.
  //
  // driveCallback is wired only defensively: if a future refactor ever let the
  // browser branch be reached, the callback keeps the run from hanging.
  const { routes } = makeIdentityHub();
  const { fetch } = routedFetch(routes);
  const t = makeIo({
    fetch,
    onOpenUrl: driveCallback(),
    env: { OWENLOOP_CREDENTIAL_COMMAND: 'my-helper --hub prod' },
  });

  const code = await mainAsync(['setup', '--hub', HUB, '--new-agent', 'buildbox'], t.io);
  assert.equal(code, 1);
  assert.equal(t.openedUrls.length, 0, 'no browser/loopback flow ever started');
  const errText = t.err.join('\n');
  assert.match(errText, /OWENLOOP_CREDENTIAL_COMMAND/);
  assert.match(errText, /unset it to use `owenloop login`/);
  assert.equal(t.store.size, 0, 'nothing written to the local store');
  assertNoOlp(t);
});

// ---- Flow B: succession -----------------------------------------------------

test('setup: succession prompt (Flow B) renders verbatim framing and rekeys the chosen agent', async () => {
  const day = 86_400_000;
  const { routes, state } = makeIdentityHub({
    identities: [
      { id: 'agent_mbp', name: 'alexs-mbp', pools: ['alex-personal'], lastContactAt: Date.now() - 4 * day },
      { id: 'agent_hermes', name: 'hermes-worker', pools: ['logistics'], lastContactAt: Date.now() - 2 * 60_000 },
      { id: 'agent_never', name: 'idle-box', pools: ['spare'], lastContactAt: null },
    ],
  });
  const { fetch, calls } = routedFetch(routes);
  const questions: string[] = [];
  const t = makeIo({ fetch, prompt: async (q) => (questions.push(q), '2') }); // choose [2] = replace alexs-mbp
  seedHuman(t.store);

  const code = await mainAsync(['setup', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const q = questions.join('\n');
  assert.match(q, /Is this a new installation, or does it replace an existing one\?/, 'verbatim framing');
  assert.match(q, /alexs-mbp/);
  assert.match(q, /hermes-worker/);
  assert.match(q, /last active 4d ago/);
  assert.match(q, /last active 2m ago/);
  assert.match(q, /last active never/, 'null-both identity renders never');
  assert.match(q, /pools: alex-personal/);
  assert.match(q, /pools: logistics/);
  assert.match(q, /⚠ "Replace" revokes/);
  assert.match(q, /disconnected there/);

  // The rekey was issued for alexs-mbp, and its slot now holds a rekeyed token.
  const rekey = calls.find((c) => c.pathname === '/api/rekey_agent_token');
  assert.ok(rekey, 'rekey called');
  assert.equal(JSON.parse(rekey!.body!).agentId, 'agent_mbp');
  const slot = t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'alexs-mbp' }));
  assert.ok(slot, 'agent:alexs-mbp slot written');
  assert.match((JSON.parse(slot!) as Credential).accessToken, /^olp_rekeyed_/, 'slot holds the rekeyed token');
  // The original identity's token in state was revoked by the rekey (or there was none).
  assert.ok([...state.tokens.values()].some((tk) => tk.agentId === 'agent_mbp' && !tk.revoked), 'a live token exists post-rekey');

  assertNoOlp(t);
});

// ---- explicit bypass flags --------------------------------------------------

test('setup --replace-agent: prompt-free rekey; unknown name errors; --pools is a usage error', async () => {
  // (a) a valid replace, no prompt injected — proves the flag path never prompts.
  {
    const { routes, state } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', pools: ['ops'], token: { plaintext: 'olp_worker_live' } }] });
    const { fetch, calls } = routedFetch(routes);
    const t = makeIo({ fetch }); // NO prompt seam
    seedHuman(t.store);

    assert.equal(await mainAsync(['setup', '--hub', HUB, '--replace-agent', 'worker'], t.io), 0, t.err.join('\n'));
    const rekey = calls.find((c) => c.pathname === '/api/rekey_agent_token');
    assert.ok(rekey, 'rekey called');
    assert.equal(JSON.parse(rekey!.body!).agentId, 'agent_w');
    assert.match((JSON.parse(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'worker' }))!) as Credential).accessToken, /^olp_rekeyed_/);
    assert.ok([...state.tokens.values()].some((tk) => tk.plaintext === 'olp_worker_live' && tk.revoked), 'the old worker token was revoked');
    assertNoOlp(t);
  }

  // (b) an unknown --replace-agent name errors listing the available names, no rekey.
  {
    const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', pools: [] }] });
    const { fetch, calls } = routedFetch(routes);
    const t = makeIo({ fetch });
    seedHuman(t.store);

    assert.equal(await mainAsync(['setup', '--hub', HUB, '--replace-agent', 'ghost'], t.io), 1);
    assert.match(t.err.join('\n'), /no Scoped Identity named 'ghost'/);
    assert.match(t.err.join('\n'), /worker/, 'lists the available names');
    assert.ok(!calls.some((c) => c.pathname === '/api/rekey_agent_token'), 'no rekey on an unknown name');
    assertNoOlp(t);
  }

  // (c) --replace-agent + --pools is a usage error before any network.
  {
    const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', pools: [] }] });
    const { fetch, calls } = routedFetch(routes);
    const t = makeIo({ fetch });
    seedHuman(t.store);

    assert.equal(await mainAsync(['setup', '--hub', HUB, '--replace-agent', 'worker', '--pools', 'a'], t.io), 1);
    assert.match(t.err.join('\n'), /--pools cannot be combined with --replace-agent/);
    assert.equal(calls.length, 0, 'no network touched before the usage error');
    assertNoOlp(t);
  }
});

test('setup --new-agent with a non-empty org: mint path forwards --pools, no prompt', async () => {
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_x', name: 'other', pools: ['team'] }] });
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch }); // NO prompt seam — --new-agent must not prompt
  seedHuman(t.store);

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'fresh', '--pools', 'a,b'], t.io), 0, t.err.join('\n'));
  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token');
  assert.ok(mint, 'mint called');
  const body = JSON.parse(mint!.body!);
  assert.equal(body.name, 'fresh');
  assert.deepEqual(body.pools, ['a', 'b'], '--pools forwarded to the mint body');
  assert.ok(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'fresh' })), 'agent:fresh stored');
  assertNoOlp(t);
});

test('setup --new-agent: --scopes forwards into the mint body', async () => {
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_x', name: 'other', pools: ['team'] }] });
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch }); // NO prompt seam — --new-agent must not prompt
  seedHuman(t.store);

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--new-agent', 'fresh', '--scopes', 'work,run'], t.io), 0, t.err.join('\n'));
  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token');
  assert.ok(mint, 'mint called');
  const body = JSON.parse(mint!.body!);
  assert.equal(body.name, 'fresh');
  assert.deepEqual(body.scopes, ['work', 'run'], '--scopes forwarded to the mint body');
  assertNoOlp(t);
});

test('setup --replace-agent + --scopes is a usage error before any network', async () => {
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_w', name: 'worker', pools: [] }] });
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t.store);

  assert.equal(await mainAsync(['setup', '--hub', HUB, '--replace-agent', 'worker', '--scopes', 'work,run'], t.io), 1);
  assert.match(t.err.join('\n'), /--scopes cannot be combined with --replace-agent/);
  assert.equal(calls.length, 0, 'no network touched before the usage error');
  assertNoOlp(t);
});

// ---- non-interactive guard --------------------------------------------------

test('setup: identities exist, no flags, no prompt seam → CliError naming both bypass flags, no mint/rekey', async () => {
  const { routes } = makeIdentityHub({ identities: [{ id: 'agent_x', name: 'other', pools: [] }] });
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch }); // no prompt; test stdin is not a TTY
  seedHuman(t.store);

  assert.equal(await mainAsync(['setup', '--hub', HUB], t.io), 1);
  const err = t.err.join('\n');
  assert.match(err, /--new-agent <name>/, 'names --new-agent');
  assert.match(err, /--replace-agent <name>/, 'names --replace-agent');
  assert.ok(!calls.some((c) => c.pathname === '/api/mint_agent_token' || c.pathname === '/api/rekey_agent_token'), 'no mint/rekey');
  assertNoOlp(t);
});

// ---- pure-unit helpers ------------------------------------------------------

test('sanitizeAgentName: lowercases, strips out-of-class chars, strips leading non-alnum, clamps to 64', () => {
  assert.equal(sanitizeAgentName('Alexs-MBP.local'), 'alexs-mbp.local');
  assert.equal(sanitizeAgentName('__weird!!name'), 'weirdname');
  assert.equal(sanitizeAgentName('...---'), '', 'nothing alphanumeric survives → empty');
  assert.equal(sanitizeAgentName('a'.repeat(80)).length, 64, 'clamped to 64');
  assert.equal(sanitizeAgentName('Böx-Ñame'), 'bx-ame', 'non-ascii dropped');
});

test('lastActiveMs: max of the two non-null timestamps, or null when both absent', () => {
  const base = (over: Partial<AgentIdentitySummary>): AgentIdentitySummary => ({
    id: 'i', name: 'n', disabled: false, pools: [], lastContactAt: null, lastUsedAt: null, ...over,
  });
  assert.equal(lastActiveMs(base({})), null);
  assert.equal(lastActiveMs(base({ lastContactAt: 100 })), 100);
  assert.equal(lastActiveMs(base({ lastUsedAt: 200 })), 200);
  assert.equal(lastActiveMs(base({ lastContactAt: 100, lastUsedAt: 200 })), 200, 'max wins');
  assert.equal(lastActiveMs(base({ lastContactAt: 300, lastUsedAt: 200 })), 300, 'max wins the other way');
});

test('formatLastActive: minutes/hours/days/just now/never', () => {
  assert.equal(formatLastActive(null), 'never');
  assert.equal(formatLastActive(-5), 'just now', 'clock skew clamps');
  assert.equal(formatLastActive(30_000), 'just now', 'under a minute');
  assert.equal(formatLastActive(5 * 60_000), '5m ago');
  assert.equal(formatLastActive(3 * 3_600_000), '3h ago');
  assert.equal(formatLastActive(4 * 86_400_000), '4d ago');
});

test('asAgentIdentities: rejects malformed shapes, tolerates absent timestamps/pools', () => {
  assert.throws(() => asAgentIdentities({}), /expected an `identities` array/);
  assert.throws(() => asAgentIdentities({ identities: [{ name: 'x' }] }), /missing non-empty string id/);
  assert.throws(() => asAgentIdentities({ identities: [{ id: 'a', name: 'x', lastUsedAt: 'soon' }] }), /lastUsedAt must be a number or null/);
  const ok = asAgentIdentities({ identities: [{ id: 'a', name: 'x' }] });
  assert.deepEqual(ok, [{ id: 'a', name: 'x', disabled: false, pools: [], lastContactAt: null, lastUsedAt: null }]);
});

test('asRekeyAgentTokenOk: field-name-only errors never echo an olp_ value from the body', () => {
  // A malformed body whose `text` carries the plaintext, with a missing id.
  assert.throws(
    () => asRekeyAgentTokenOk({ text: 'store this: olp_leaky_secret', id: '', agentId: 'a', token: 'olp_ok' }),
    (e: Error) => {
      assert.match(e.message, /missing non-empty string id/);
      assert.doesNotMatch(e.message, /olp_/, 'the error never echoes a token value');
      return true;
    },
  );
  // A well-formed body narrows cleanly.
  const ok = asRekeyAgentTokenOk({ id: 't1', token: 'olp_new', agentId: 'a1', revokedTokenIds: ['old'], scopes: ['work'] });
  assert.equal(ok.agentId, 'a1');
  assert.deepEqual(ok.revokedTokenIds, ['old']);
});
