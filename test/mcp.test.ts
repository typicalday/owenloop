/**
 * Acceptance for `owenloop mcp` — the stdio control-plane server (O2), driven
 * end to end through `mainAsync(['mcp', ...])` with an injected `stdinStream`
 * (a `PassThrough`) and an injected `fetch`. Hermetic: `mkdtempSync` cwd + a
 * fixture `$HOME`, a fake keychain (or the 0600 file backend via
 * `OWENLOOP_NO_KEYCHAIN=1`), and either a `routedFetch` or a real loopback
 * `realHttpServer` — no ambient network, no real keychain.
 *
 * The load-bearing assertions:
 *   - the handshake advertises the 18 baseline+create_agent tools;
 *     `stage_enrollment` is gated (Decision 7);
 *   - a `tools/call` becomes ONE authenticated `/api/*` request and the REST
 *     reply maps to a tool result (2xx → body, non-2xx → isError);
 *   - a missing/expired credential yields a NON-interactive tool error that
 *     names `owenloop login --hub <origin>` — the browser is NEVER opened;
 *   - a 401 refreshes EXACTLY once and retries;
 *   - `create_agent` writes the minted `olp_` token straight to the store and
 *     NEVER lets any byte of the mint response body reach an outbound frame
 *     (the full-transcript no-`olp_` assertion);
 *   - origin resolution exits 2 (naming both remedies) on absent/ambiguous
 *     inference, and exit 1 on a malformed `--hub`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mainAsync } from '../src/cli.ts';
import type { CliIO } from '../src/cli.ts';
import { storeCredential } from '../src/credentials.ts';
import type { Credential } from '../src/hub.ts';
import { kcHuman, kcKey, makeIo, OAUTH_METADATA, realHttpServer, routedFetch } from './hubkit.ts';
import type { HubIo, RouteHandler } from './hubkit.ts';

const ORIGIN = 'http://127.0.0.1:9';

/** A never-expiring human credential that needs no token endpoint to use. */
const PASTED_HUMAN: Credential = { kind: 'oauth-pasted', accessToken: 'mcpat_human' };

/** Seed a `human` credential into the keychain-backed store for `origin`. */
function seedHuman(t: HubIo, origin = ORIGIN, cred: Credential = PASTED_HUMAN): void {
  t.store.set(kcHuman(origin), JSON.stringify(cred));
}

interface Frame {
  jsonrpc: string;
  id?: number;
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean; tools?: Array<{ name: string }> };
  error?: { code: number; message: string };
}

/**
 * Drive the `mcp` command to completion: attach a `PassThrough` as stdin, run
 * `mainAsync`, feed each line + newline, then EOF. The command resolves on EOF
 * (exit 0) or earlier (exit 2 origin-ambiguity / exit 1 malformed hub). Returns
 * the exit code and every outbound JSON-RPC frame (parsed from `io.out`).
 */
async function driveMcp(t: HubIo, argv: string[], lines: string[]): Promise<{ code: number; frames: Frame[] }> {
  const stdin = new PassThrough();
  (t.io as CliIO).stdinStream = stdin;
  const runP = mainAsync(argv, t.io);
  for (const line of lines) stdin.write(`${line}\n`);
  stdin.end();
  const code = await runP;
  const frames = t.out.map((s) => JSON.parse(s) as Frame);
  return { code, frames };
}

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const call = (id: number, name: string, args: Record<string, unknown> = {}): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

/** The parsed JSON of a tool result's single text block. */
function resultJson(frame: Frame): unknown {
  return JSON.parse(frame.result!.content![0]!.text);
}

// ---- handshake + tool advertising -------------------------------------------

test('mcp: handshake advertises 18 tools (17 baseline + create_agent); stage_enrollment is hidden when the probe 404s', async () => {
  // Probe hits POST /api/stage_enrollment → 404 (route unregistered) → hidden.
  const routes: Record<string, RouteHandler> = { 'POST /api/stage_enrollment': () => ({ status: 404, json: { error: 'not_found' } }) };
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { code, frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, LIST]);
  assert.equal(code, 0, t.err.join('\n'));
  const names = frames[1]!.result!.tools!.map((x) => x.name);
  assert.equal(names.length, 18, names.join(','));
  assert.ok(names.includes('create_agent'));
  assert.ok(!names.includes('stage_enrollment'));
  // Sanity: the 17 baseline names are all present.
  for (const n of ['whats_next', 'submit', 'reject_artifact', 'provide_input', 'start_run', 'create_workflow', 'get_workflow', 'list_workflows', 'get_status', 'heartbeat', 'get_order', 'release', 'publish_event', 'list_subscriptions', 'presence_ping', 'list_conductors', 'wake']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});

test('mcp: stage_enrollment gating — env override 1 shows it, 0 hides it, and an unset probe that 400s shows it', async () => {
  // OWENLOOP_MCP_ENROLLMENT=1 → shown, no probe fetch at all.
  {
    const { fetch, calls } = routedFetch({});
    const t = makeIo({ fetch, env: { OWENLOOP_MCP_ENROLLMENT: '1' } });
    seedHuman(t);
    const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, LIST]);
    assert.ok(frames[1]!.result!.tools!.some((x) => x.name === 'stage_enrollment'));
    assert.equal(calls.length, 0, 'no probe when the env override decides');
  }
  // OWENLOOP_MCP_ENROLLMENT=0 → hidden, no probe fetch.
  {
    const { fetch, calls } = routedFetch({});
    const t = makeIo({ fetch, env: { OWENLOOP_MCP_ENROLLMENT: '0' } });
    seedHuman(t);
    const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, LIST]);
    assert.ok(!frames[1]!.result!.tools!.some((x) => x.name === 'stage_enrollment'));
    assert.equal(calls.length, 0);
  }
  // Unset → probe; a registered route answers 400 to the empty body → shown.
  {
    const { fetch } = routedFetch({ 'POST /api/stage_enrollment': () => ({ status: 400, json: { error: 'name required' } }) });
    const t = makeIo({ fetch });
    seedHuman(t);
    const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, LIST]);
    assert.ok(frames[1]!.result!.tools!.some((x) => x.name === 'stage_enrollment'), 'a 400 (route present) enables the tool');
  }
});

// ---- baseline passthrough ---------------------------------------------------

test('mcp: a baseline tool call becomes ONE authenticated POST and maps the 2xx body to a text result', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/whats_next': () => ({ status: 200, json: { orders: [{ path: 'wf/run/step' }] } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'whats_next', { workflow: 'wf' })]);
  assert.deepEqual(resultJson(frames[1]!), { orders: [{ path: 'wf/run/step' }] });

  const whats = calls.filter((c) => c.pathname === '/api/whats_next');
  assert.equal(whats.length, 1, 'exactly one hub call for the tool');
  assert.equal(whats[0]!.authorization, 'Bearer mcpat_human', 'the human bearer rode the Authorization header');
  assert.deepEqual(JSON.parse(whats[0]!.body!), { workflow: 'wf' });
});

test('mcp: a non-2xx REST reply maps to an isError result carrying the body message', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/submit': () => ({ status: 409, json: { error: 'schema_rejected', message: 'value failed schema' } }),
  };
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'submit', { workflow: 'wf', run: 'r', path: 'p', value: {} })]);
  assert.equal(frames[1]!.result!.isError, true);
  assert.deepEqual(resultJson(frames[1]!), { error: 'schema_rejected', message: 'value failed schema' });
});

test('mcp: get_workflow encodes the name into the GET path', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'GET /api/workflows/a%2Fb': () => ({ status: 200, json: { name: 'a/b' } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'get_workflow', { name: 'a/b' })]);
  assert.deepEqual(resultJson(frames[1]!), { name: 'a/b' });
  // The slash in the name is percent-encoded into a single path segment (never a bare `/`).
  assert.ok(calls.some((c) => c.pathname === '/api/workflows/a%2Fb' && c.method === 'GET'));
  assert.ok(!calls.some((c) => c.pathname === '/api/workflows/a/b'), 'the name must not split into two path segments');
});

// ---- non-interactive auth failure -------------------------------------------

test('mcp: with NO stored credential a tool call returns a non-interactive login instruction and NEVER opens a browser', async () => {
  // A fetch that throws if ever called — proves the auth-failure path is short-circuited before any network.
  const throwingFetch = (async () => {
    throw new Error('network must not be touched on an auth failure');
  }) as typeof globalThis.fetch;
  const t = makeIo({ fetch: throwingFetch });
  // No seedHuman → no credential in any slot.

  const { code, frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'whats_next', { workflow: 'wf' })]);
  assert.equal(code, 0);
  assert.equal(frames[1]!.result!.isError, true);
  assert.match(frames[1]!.result!.content![0]!.text, /owenloop login --hub http:\/\/127\.0\.0\.1:9/);
  assert.equal(t.openedUrls.length, 0, 'the browser was never opened (non-interactive)');
});

// ---- refresh exactly once ---------------------------------------------------

test('mcp: a 401 on an oauth credential refreshes EXACTLY once and retries the call', async () => {
  const oauth: Credential = { kind: 'oauth', accessToken: 'mcpat_old', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, clientId: 'c' };
  let whatsAttempts = 0;
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 200, json: { access_token: 'mcpat_new', expires_in: 3600, refresh_token: 'rt2' } }),
    'POST /api/whats_next': () => (++whatsAttempts === 1 ? { status: 401, json: { error: 'expired' } } : { status: 200, json: { ok: true } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  t.store.set(kcHuman(ORIGIN), JSON.stringify(oauth));

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'whats_next', { workflow: 'wf' })]);
  assert.deepEqual(resultJson(frames[1]!), { ok: true });

  assert.equal(calls.filter((c) => c.pathname === '/mcp/token').length, 1, 'refreshed exactly once');
  assert.equal(whatsAttempts, 2, 'the call was retried after refresh');
  // The refreshed access token was persisted to the store.
  assert.equal((JSON.parse(t.store.get(kcHuman(ORIGIN))!) as Credential).accessToken, 'mcpat_new');
  // The retried call carried the NEW bearer.
  const whats = calls.filter((c) => c.pathname === '/api/whats_next');
  assert.equal(whats[1]!.authorization, 'Bearer mcpat_new');
});

// ---- create_agent secret discipline -----------------------------------------

test('mcp: create_agent stores the minted olp_ token and NEVER echoes any byte of the mint body (full-transcript no-olp_)', async () => {
  const SECRET = 'olp_SUPERSECRETVALUE123';
  const mintBody = {
    // The hub mint response leaks the plaintext in BOTH `text` and `token`.
    text: `Agent token minted (id agt_1). Store this secret now — it will not be shown again:\n${SECRET}`,
    id: 'agt_1',
    token: SECRET,
    agentId: 'agt_1',
    pools: ['alex-personal'],
    poolIds: ['pl_1'],
  };
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/mint_agent_token': () => ({ status: 200, json: mintBody }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { code, frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'create_agent', { name: 'newbot', pools: ['alex-personal'] })]);
  assert.equal(code, 0, t.err.join('\n'));

  // The result is built from scratch — the token/text/id/agentId/poolIds are gone.
  assert.deepEqual(resultJson(frames[1]!), { name: 'newbot', pools: ['alex-personal'], stored: true });

  // FULL-TRANSCRIPT assertion: the secret appears in NO outbound frame and NO stderr line.
  for (const line of t.out) assert.ok(!line.includes('olp_'), `olp_ leaked to stdout frame: ${line}`);
  for (const line of t.err) assert.ok(!line.includes('olp_'), `olp_ leaked to stderr: ${line}`);

  // The token WAS written to the agent:<name> slot, verbatim.
  const stored = JSON.parse(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'newbot' }))!) as Credential;
  assert.deepEqual(stored, { kind: 'agent', accessToken: SECRET });

  // The mint request hardcoded scopes:['work'] and forwarded name + pools.
  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token');
  assert.deepEqual(JSON.parse(mint!.body!), { name: 'newbot', scopes: ['work'], pools: ['alex-personal'] });
});

test('mcp: create_agent rejects an invalid name BEFORE any network call', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  // No human credential seeded and no routes: if the handler reached the network it would throw.

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'create_agent', { name: 'bad name!' })]);
  assert.equal(frames[1]!.result!.isError, true);
  assert.match(frames[1]!.result!.content![0]!.text, /invalid agent name/);
  assert.equal(calls.length, 0, 'no hub call was made for an invalid name');
});

test('mcp: create_agent surfaces the hub error message (only) on a non-2xx mint, and stores nothing', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/mint_agent_token': () => ({ status: 409, json: { error: 'name_taken', message: "agent 'dup' already exists" } }),
  };
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'create_agent', { name: 'dup' })]);
  assert.equal(frames[1]!.result!.isError, true);
  assert.match(frames[1]!.result!.content![0]!.text, /already exists/);
  assert.equal(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'dup' })), undefined, 'nothing stored on a failed mint');
});

test('mcp: two concurrent create_agent calls both mint and both store (serialized through the credential lock)', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/mint_agent_token': (req) => {
      const name = (JSON.parse(req.body ?? '{}') as { name: string }).name;
      return { status: 200, json: { token: `olp_${name}_tok`, pools: [] } };
    },
  };
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'create_agent', { name: 'alpha' }), call(4, 'create_agent', { name: 'beta' })]);
  // Both replied (matched by id — order may interleave).
  const byId = new Map(frames.filter((f) => f.id !== undefined).map((f) => [f.id, f]));
  assert.deepEqual(resultJson(byId.get(3)!), { name: 'alpha', pools: [], stored: true });
  assert.deepEqual(resultJson(byId.get(4)!), { name: 'beta', pools: [], stored: true });
  // Both tokens landed in their own slots.
  assert.deepEqual(JSON.parse(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'alpha' }))!), { kind: 'agent', accessToken: 'olp_alpha_tok' });
  assert.deepEqual(JSON.parse(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'beta' }))!), { kind: 'agent', accessToken: 'olp_beta_tok' });
});

// ---- origin resolution ------------------------------------------------------

test('mcp: with no --hub, no OWENLOOP_HUB, and no stored hub (file backend) → exit 2 naming BOTH remedies, nothing on stdout', async () => {
  const t = makeIo({ env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  const { code, frames } = await driveMcp(t, ['mcp'], [INIT]);
  assert.equal(code, 2);
  assert.equal(frames.length, 0, 'stdout (the protocol channel) stays empty on an origin error');
  const msg = t.err.join('\n');
  assert.match(msg, /owenloop login --hub/);
  assert.match(msg, /--hub <origin>/);
});

test('mcp: with two stored file-backend hubs and no --hub → exit 2 (ambiguous), listing the origins', async () => {
  const t = makeIo({ env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  await storeCredential(t.io, 'http://127.0.0.1:9', { principal: 'human' }, PASTED_HUMAN);
  await storeCredential(t.io, 'http://127.0.0.1:10', { principal: 'human' }, PASTED_HUMAN);

  const { code } = await driveMcp(t, ['mcp'], [INIT]);
  assert.equal(code, 2);
  const msg = t.err.join('\n');
  assert.match(msg, /multiple hubs/);
  assert.match(msg, /127\.0\.0\.1/);
});

test('mcp: exactly one stored file-backend hub is INFERRED with no --hub', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/whats_next': () => ({ status: 200, json: { ok: true } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  await storeCredential(t.io, ORIGIN, { principal: 'human' }, PASTED_HUMAN);

  const { code, frames } = await driveMcp(t, ['mcp'], [INIT, call(3, 'whats_next', {})]);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(resultJson(frames[1]!), { ok: true });
  assert.ok(calls.some((c) => c.pathname === '/api/whats_next'));
});

test('mcp: a malformed --hub is a CliError → exit 1', async () => {
  const t = makeIo({});
  const { code } = await driveMcp(t, ['mcp', '--hub', 'not a url'], [INIT]);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /error:/);
});

// ---- real loopback smoke ----------------------------------------------------

test('mcp: end-to-end over a real loopback server — handshake, then a tool call that hits the wire', async () => {
  const server = await realHttpServer({
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/whats_next': () => ({ status: 200, json: { orders: [] } }),
  });
  try {
    const t = makeIo({}); // no injected fetch → real global fetch against the loopback server
    seedHuman(t, server.origin);

    const { code, frames } = await driveMcp(t, ['mcp', '--hub', server.origin], [INIT, call(3, 'whats_next', {})]);
    assert.equal(code, 0, t.err.join('\n'));
    assert.deepEqual(resultJson(frames[1]!), { orders: [] });
    const whats = server.calls.filter((c) => c.pathname === '/api/whats_next');
    assert.equal(whats.length, 1);
    assert.equal(whats[0]!.authorization, 'Bearer mcpat_human');
  } finally {
    await server.close();
  }
});
