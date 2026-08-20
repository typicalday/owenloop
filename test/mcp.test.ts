/**
 * Acceptance for `owenloop mcp` — the stdio control-plane server (O2), driven
 * end to end through `mainAsync(['mcp', ...])` with an injected `stdinStream`
 * (a `PassThrough`) and an injected `fetch`. Hermetic: `mkdtempSync` cwd + a
 * fixture `$HOME`, a fake keychain (or the 0600 file backend via
 * `OWENLOOP_NO_KEYCHAIN=1`), and either a `routedFetch` or a real loopback
 * `realHttpServer` — no ambient network, no real keychain.
 *
 * The load-bearing assertions:
 *   - the handshake advertises the 27 baseline+create_agent+crew tools;
 *     `stage_enrollment` is gated (Decision 7);
 *   - a `tools/call` becomes ONE authenticated `/api/*` request and the REST
 *     reply maps to a tool result (2xx → body, non-2xx → isError);
 *   - a missing/expired credential yields a NON-interactive tool error that
 *     names `owenloop login --hub <origin>` — the browser is NEVER opened;
 *   - a 401 refreshes EXACTLY once and retries;
 *   - `create_agent` writes the minted `olp_` token straight to the store and
 *     NEVER lets any byte of the mint response body reach an outbound frame
 *     (the full-transcript no-`olp_` assertion);
 *   - origin resolution walks a 5-rung ladder (`--hub` flag → `OWENLOOP_HUB`
 *     env → `~/.owenloop/config.json` → a single inferred file-backend hub →
 *     `DEFAULT_HUB`) and falls through silently at every rung except a
 *     malformed `--hub`/`OWENLOOP_HUB`, which is the only origin error left
 *     (exit 1) — absent or ambiguous inference now resolves to `DEFAULT_HUB`
 *     instead of exiting 2;
 *   - the four crew tools are plain REST passthroughs (no response narrowing),
 *     `remove_crew_member`'s tolerant `removed:false` is never turned into a
 *     tool error, and `delete_crew` is NOT advertised (deliberately excluded).
 */

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { dsseVerifySubmission } from '../src/crypto/index.ts';
import { publicKeyDescriptor } from '../src/crypto/keys.ts';
import type { PrincipalKeyManager } from '../src/crypto/keys.ts';
import { resetSshKeygenProbe } from '../src/crypto/ssh.ts';
import type { SshProcessAdapter } from '../src/crypto/ssh.ts';
import { mainAsync } from '../src/cli.ts';
import type { CliIO } from '../src/cli.ts';
import { storeCredential } from '../src/credentials.ts';
import { DEFAULT_HUB } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { globalConfigPath, writeGlobalConfig } from '../src/global-config.ts';
import { resolveMcpOrigin, resolveRepoScope } from '../src/mcp/serve.ts';
import { kcHuman, kcKey, makeIo, OAUTH_METADATA, realHttpServer, routedFetch } from './hubkit.ts';
import type { HubIo, RouteHandler } from './hubkit.ts';

const ORIGIN = 'http://127.0.0.1:9';
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** A never-expiring human credential that needs no token endpoint to use. */
const PASTED_HUMAN: Credential = { kind: 'oauth-pasted', accessToken: 'mcpat_human' };
const PUB_TEXT = readFileSync(new URL('./fixtures/crypto/fixture-key.pub', import.meta.url), 'utf8');
const PUBLIC_KEY = publicKeyDescriptor(PUB_TEXT);
const SIGNING_REF = { origin: ORIGIN, kind: 'machine' as const, id: 'local' };
const ARMOR = '-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n';

const SIGNING_KEYS: Pick<PrincipalKeyManager, 'inspect' | 'resolveRef' | 'withSigningKey'> = {
  resolveRef: () => SIGNING_REF,
  inspect: async () => ({ exists: true, source: 'generated', backend: 'file', publicKey: PUBLIC_KEY }),
  withSigningKey: async (_ref, callback) => callback('/fake/private-key'),
};

function fakeSshProcess(): SshProcessAdapter {
  return {
    probe: () => ({ status: 255, stderr: Buffer.from('No principal matched\\n') }),
    async run(_cmd, args) {
      const stdout = args[0] === '-y' && args[1] === '-f' ? PUB_TEXT : ARMOR;
      return { status: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), timedOut: false, truncated: false };
    },
  };
}

afterEach(() => {
  resetSshKeygenProbe();
});

/** Seed a `human` credential into the keychain-backed store for `origin`. */
function seedHuman(t: HubIo, origin = ORIGIN, cred: Credential = PASTED_HUMAN): void {
  t.store.set(kcHuman(origin), JSON.stringify(cred));
}

interface Frame {
  jsonrpc: string;
  id?: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    tools?: Array<{ name: string; description?: string }>;
    serverInfo?: { version: string };
  };
  error?: { code: number; message: string };
}

/**
 * Drive the `mcp` command to completion: attach a `PassThrough` as stdin, run
 * `mainAsync`, feed each line + newline, then EOF. The command resolves on EOF
 * (exit 0) or earlier (exit 1 on a malformed `--hub`/`OWENLOOP_HUB` — the only
 * origin error left; absent/ambiguous inference now falls through to
 * `DEFAULT_HUB` instead of exiting). Returns the exit code and every outbound
 * JSON-RPC frame (parsed from `io.out`).
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

const fakeGit = (url: string) => (cmd: string, args: string[]) =>
  cmd === 'git' && args[args.length - 1] === 'origin'
    ? { status: 0, stdout: `${url}\n`, stderr: '' }
    : { status: 1, stdout: '', stderr: 'not a git repository\n' };

/** The parsed JSON of a tool result's single text block. */
function resultJson(frame: Frame): unknown {
  return JSON.parse(frame.result!.content![0]!.text);
}

// ---- handshake + tool advertising -------------------------------------------

test('mcp: handshake advertises 27 tools (22 baseline + create_agent + 4 crew tools); stage_enrollment is hidden when the probe 404s', async () => {
  // Probe hits POST /api/stage_enrollment → 404 (route unregistered) → hidden.
  const routes: Record<string, RouteHandler> = { 'POST /api/stage_enrollment': () => ({ status: 404, json: { error: 'not_found' } }) };
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { code, frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, LIST]);
  assert.equal(code, 0, t.err.join('\n'));
  const serverInfo = frames[0]!.result!.serverInfo!;
  assert.notEqual(serverInfo.version, '0.0.1');
  assert.equal(serverInfo.version, PACKAGE_VERSION);
  const names = frames[1]!.result!.tools!.map((x) => x.name);
  assert.equal(names.length, 27, names.join(','));
  assert.ok(names.includes('create_agent'));
  assert.ok(!names.includes('stage_enrollment'));
  // Sanity: the 22 baseline names are all present.
  for (const n of ['whats_next', 'pending_gates', 'submit', 'reject_artifact', 'retry_artifact', 'provide_input', 'start_run', 'create_workflow', 'get_workflow', 'list_workflows', 'delete_workflow', 'get_status', 'heartbeat', 'get_order', 'release', 'publish_event', 'list_subscriptions', 'presence_ping', 'list_shifts', 'get_rosters', 'list_harness_models', 'wake']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  // The four crew tools are all present.
  for (const n of ['list_crews', 'create_crew', 'add_crew_member', 'remove_crew_member']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  const listWorkflows = frames[1]!.result!.tools!.find((tool) => tool.name === 'list_workflows');
  assert.equal(listWorkflows?.description, 'Discover published workflow definitions and decide which one fits a task.');
  // Regression guard for the human's deliberate exclusion decision (see buildCrewTools).
  assert.ok(!names.includes('delete_crew'), 'delete_crew must never be advertised on this server');
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

test('mcp: start_run defaults scope to the session repo name', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/start_run': () => ({ status: 200, json: { ok: true } }),
  });
  const t = makeIo({
    fetch,
    env: { OWENLOOP_MCP_ENROLLMENT: '0' },
    runCommand: fakeGit('https://github.com/typicalday/owenloop.git'),
  });
  seedHuman(t);

  const { code } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'start_run', { workflow_name: 'd' })]);

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(calls[0]!.body!), { workflow_name: 'd', scope: 'owenloop' });
});

test('mcp: an explicit start_run scope beats the repo-name default', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/start_run': () => ({ status: 200, json: { ok: true } }),
  });
  const t = makeIo({
    fetch,
    env: { OWENLOOP_MCP_ENROLLMENT: '0' },
    runCommand: fakeGit('https://github.com/typicalday/owenloop.git'),
  });
  seedHuman(t);

  const { code } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'start_run', { workflow_name: 'd', scope: 'other' })]);

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(calls[0]!.body!), { workflow_name: 'd', scope: 'other' });
});

test('mcp: a missing or failing repo probe sends no start_run scope', async () => {
  for (const runCommand of [
    undefined,
    () => ({ status: 1, stdout: '', stderr: 'not a git repository\n' }),
  ]) {
    const { fetch, calls } = routedFetch({
      'POST /api/start_run': () => ({ status: 200, json: { ok: true } }),
    });
    const t = makeIo({ fetch, env: { OWENLOOP_MCP_ENROLLMENT: '0' }, runCommand });
    seedHuman(t);

    const { code } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'start_run', { workflow_name: 'd' })]);

    assert.equal(code, 0, t.err.join('\n'));
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    assert.ok(!('scope' in body));
  }
});

test('mcp: start_run priority rides through unchanged', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/start_run': () => ({ status: 200, json: { ok: true } }),
  });
  const t = makeIo({ fetch, env: { OWENLOOP_MCP_ENROLLMENT: '0' } });
  seedHuman(t);

  const { code } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'start_run', { workflow_name: 'd', priority: 'high' })]);

  assert.equal(code, 0, t.err.join('\n'));
  assert.equal((JSON.parse(calls[0]!.body!) as Record<string, unknown>).priority, 'high');
});

test('mcp: resolveRepoScope parses only valid origin repo names', () => {
  const cases = [
    { url: 'https://github.com/typicalday/owenloop.git', expected: 'owenloop' },
    { url: 'git@github.com:typicalday/owenloop.git', expected: 'owenloop' },
    { url: 'ssh://git@github.com/o/r.git', expected: 'r' },
    { url: 'https://github.com/o/r', expected: 'r' },
    { url: 'https://github.com/o/r/', expected: 'r' },
    { url: '', expected: undefined },
    { url: 'https://github.com/o/r with space', expected: undefined },
  ] as const;

  for (const fixture of cases) {
    const t = makeIo({ runCommand: fakeGit(fixture.url) });
    assert.equal(resolveRepoScope(t.io), fixture.expected, fixture.url);
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

test('mcp: hub passthrough fields are advertised, optional, and forwarded unchanged', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/reject_artifact': () => ({ status: 200, json: { ok: true } }),
    'POST /api/create_workflow': () => ({ status: 200, json: { ok: true } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch, env: { OWENLOOP_MCP_ENROLLMENT: '0' } });
  seedHuman(t);

  const { code, frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [
    INIT,
    LIST,
    call(3, 'reject_artifact', { workflow: 'wf', path: 'plan', reason: 'needs more depth', requested: 'deep' }),
    call(4, 'reject_artifact', { workflow: 'wf', path: 'plan', reason: 'needs more depth' }),
    call(5, 'create_workflow', { yaml: 'version: 1', bundle_digest: 'sha256:bundle', ephemeral: true }),
    call(6, 'create_workflow', { yaml: 'version: 1' }),
  ]);

  assert.equal(code, 0, t.err.join('\n'));
  const tools = (frames[1]!.result as {
    tools: Array<{
      name: string;
      inputSchema: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    }>;
  }).tools;
  const reject = tools.find((tool) => tool.name === 'reject_artifact')!;
  const create = tools.find((tool) => tool.name === 'create_workflow')!;
  assert.deepEqual(reject.inputSchema.properties.requested, { type: 'string' });
  assert.deepEqual(reject.inputSchema.required, ['workflow', 'path', 'reason']);
  assert.equal(reject.inputSchema.additionalProperties, false);
  assert.deepEqual(create.inputSchema.properties.bundle_digest, { type: 'string' });
  assert.deepEqual(create.inputSchema.properties.ephemeral, { type: 'boolean' });
  assert.deepEqual(create.inputSchema.required, ['yaml']);
  assert.equal(create.inputSchema.additionalProperties, false);

  for (const id of [3, 4, 5, 6]) {
    const frame = frames.find((candidate) => candidate.id === id)!;
    assert.equal(frame.error, undefined, `tool call ${id} must pass local schema validation`);
    assert.deepEqual(resultJson(frame), { ok: true });
  }

  const rejections = calls.filter((row) => row.pathname === '/api/reject_artifact');
  assert.equal(rejections.length, 2, 'one POST per reject_artifact call');
  assert.ok(rejections.every((row) => row.method === 'POST'));
  assert.deepEqual(JSON.parse(rejections[0]!.body!), { workflow: 'wf', path: 'plan', reason: 'needs more depth', requested: 'deep' });
  assert.deepEqual(JSON.parse(rejections[1]!.body!), { workflow: 'wf', path: 'plan', reason: 'needs more depth' });

  const creations = calls.filter((row) => row.pathname === '/api/create_workflow');
  assert.equal(creations.length, 2, 'one POST per create_workflow call');
  assert.ok(creations.every((row) => row.method === 'POST'));
  assert.deepEqual(JSON.parse(creations[0]!.body!), { yaml: 'version: 1', bundle_digest: 'sha256:bundle', ephemeral: true });
  assert.deepEqual(JSON.parse(creations[1]!.body!), { yaml: 'version: 1' });
});

test('mcp: pending_gates preserves optional serve_crews and returns each hub response unchanged', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/pending_gates': ({ body }) => {
      const request = JSON.parse(body ?? '{}') as Record<string, unknown>;
      return { status: 200, json: 'serve_crews' in request ? { gates: ['crew-scoped'] } : { gates: ['all-visible'] } };
    },
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [
    INIT,
    LIST,
    call(3, 'pending_gates', {}),
    call(4, 'pending_gates', { serve_crews: ['alpha', 'beta'] }),
    call(5, 'pending_gates', { serve_crews: 'alpha' }),
    call(6, 'pending_gates', { serve_crews: ['alpha', 1] }),
    call(7, 'pending_gates', { unexpected: true }),
  ]);

  const frameFor = (id: number): Frame => frames.find((frame) => frame.id === id)!;
  const pending = frameFor(2).result!.tools!.find((tool) => tool.name === 'pending_gates') as unknown as {
    description: string;
    inputSchema: unknown;
  };
  assert.deepEqual(pending.inputSchema, {
    type: 'object',
    properties: { serve_crews: { type: 'array', items: { type: 'string' } } },
    additionalProperties: false,
  });
  assert.match(pending.description, /waiting on a person/u);
  assert.match(pending.description, /after starting or attending runs/u);
  assert.deepEqual(resultJson(frameFor(3)), { gates: ['all-visible'] });
  assert.deepEqual(resultJson(frameFor(4)), { gates: ['crew-scoped'] });
  for (const id of [5, 6, 7]) {
    assert.equal(frameFor(id).error!.code, -32602, 'invalid tool arguments must use the JSON-RPC INVALID_PARAMS envelope');
  }

  const gates = calls.filter((row) => row.pathname === '/api/pending_gates');
  assert.equal(gates.length, 2, 'invalid arguments must not reach the hub');
  assert.equal(gates[0]!.authorization, 'Bearer mcpat_human');
  assert.equal(gates[0]!.method, 'POST');
  assert.deepEqual(JSON.parse(gates[0]!.body!), {});
  assert.equal(gates[1]!.method, 'POST');
  assert.deepEqual(JSON.parse(gates[1]!.body!), { serve_crews: ['alpha', 'beta'] });
});

test('mcp: retry_artifact is an authenticated POST and leaves omitted text absent', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/retry_artifact': () => ({ status: 200, json: { ok: true } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [
    INIT,
    call(3, 'retry_artifact', { workflow: 'wf', path: 'pr', text: 'use the fixture' }),
    call(4, 'retry_artifact', { workflow: 'wf', path: 'pr' }),
  ]);
  assert.deepEqual(resultJson(frames[1]!), { ok: true });
  assert.deepEqual(resultJson(frames[2]!), { ok: true });

  const retries = calls.filter((row) => row.pathname === '/api/retry_artifact');
  assert.equal(retries.length, 2, 'one authenticated POST per retry_artifact call');
  assert.equal(retries[0]!.authorization, 'Bearer mcpat_human');
  assert.deepEqual(JSON.parse(retries[0]!.body!), { workflow: 'wf', path: 'pr', text: 'use the fixture' });
  assert.deepEqual(JSON.parse(retries[1]!.body!), { workflow: 'wf', path: 'pr' });
  assert.equal('text' in JSON.parse(retries[1]!.body!), false, 'omitted text must not be defaulted by the MCP client');
});

test('mcp: get_rosters and list_harness_models are authenticated GET passthroughs', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'GET /api/rosters': () => ({ status: 200, json: { global: {}, crews: [] } }),
    'GET /api/harness_models': () => ({ status: 200, json: { harnesses: [], models: [] } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);
  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'get_rosters'), call(4, 'list_harness_models')]);
  assert.deepEqual(resultJson(frames[1]!), { global: {}, crews: [] });
  assert.deepEqual(resultJson(frames[2]!), { harnesses: [], models: [] });
  assert.equal(calls.filter((row) => row.pathname === '/api/rosters')[0]!.method, 'GET');
  assert.equal(calls.filter((row) => row.pathname === '/api/harness_models')[0]!.method, 'GET');
});

test('mcp: judge submit signs the exact judged version from the claim fingerprint', async () => {
  let submitBody: Record<string, unknown> | undefined;
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/get_order': () => ({
      status: 200,
      json: {
        text: '',
        workflow: 'wf1',
        run: 'run1',
        order: {
          run: 'run1',
          workflow: 'wf1',
	  step: 'judge-result',
          key: 'k',
          defDigest: 'def-digest',
	  inputs: ['result'],
	  outputs: [],
	  judge: 'result',
	  consumes: { result: { value: 'seen' } },
	  consumedFingerprint: { result: 3 },
	  owes: [],
        },
        lease: { claimed: true },
      },
    }),
    'POST /api/submit': (req) => {
      submitBody = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
      return { status: 200, json: { text: 'ok', outcome: 'green' } };
    },
  };
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);
  const mcpIo = t.io as unknown as {
    principalKeys?: Pick<PrincipalKeyManager, 'inspect' | 'resolveRef' | 'withSigningKey'>;
    sshProcess?: SshProcessAdapter;
  };
  mcpIo.principalKeys = SIGNING_KEYS;
  mcpIo.sshProcess = fakeSshProcess();

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'submit', {
    workflow: 'wf1',
    run: 'run1',
    path: 'result',
    value: { answer: 42 },
  })]);
  assert.deepEqual(resultJson(frames[1]!), { text: 'ok', outcome: 'green' });
  assert.ok(submitBody !== undefined);
  assert.deepEqual(submitBody.value, { answer: 42 });
  assert.equal(typeof submitBody.proof, 'string');

  const verified = await dsseVerifySubmission(JSON.parse(submitBody.proof as string), {
    async verify(_bytes, signature) {
      return signature.toString('utf8') === ARMOR
        ? { keyid: PUBLIC_KEY.keyid, principal: 'machine', format: 'sshsig' as const }
        : null;
    },
  });
  const record = JSON.parse(verified.payloadBytes.toString('utf8')) as {
    produced: Array<{ artifact: string; version: number }>;
    consumedFingerprint: Record<string, number>;
  };
  assert.equal(record.produced[0]!.artifact, 'result');
  assert.equal(record.produced[0]!.version, 3);
  assert.deepEqual(record.consumedFingerprint, { result: 3 });
});

test('mcp: each producer submit signs the owed target the hub issues for that claim', async () => {
  // Every submit re-reads the immutable order packet, so the signed version
  // tracks the hub's issued target rather than a process-local counter. The
  // fake hub advances the target between reads (as a real hub does once the
  // first commit lands), and the second proof must follow it.
  let orderCalls = 0;
  const submitted: Array<Record<string, unknown>> = [];
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/get_order': () => {
      orderCalls += 1;
      return {
        status: 200,
        json: {
          text: '',
          workflow: 'wf1',
	  run: 'run1',
          order: {
	    run: 'run1',
            workflow: 'wf1',
            step: 'producer',
            key: 'k',
            defDigest: 'def-digest',
	    inputs: [],
            outputs: ['result'],
	    consumes: {},
	    consumedFingerprint: {},
	    owes: [{ path: 'result', version: orderCalls, judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
          },
          lease: { claimed: true },
        },
      };
    },
    'POST /api/submit': (req) => {
      submitted.push(JSON.parse(req.body ?? '{}') as Record<string, unknown>);
      return { status: 200, json: { text: 'ok', outcome: 'green' } };
    },
  };
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);
  const mcpIo = t.io as unknown as {
    principalKeys?: Pick<PrincipalKeyManager, 'inspect' | 'resolveRef' | 'withSigningKey'>;
    sshProcess?: SshProcessAdapter;
  };
  mcpIo.principalKeys = SIGNING_KEYS;
  mcpIo.sshProcess = fakeSshProcess();

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [
    INIT,
    call(3, 'submit', { workflow: 'wf1', run: 'run1', path: 'result', value: { answer: 1 } }),
    call(4, 'submit', { workflow: 'wf1', run: 'run1', path: 'result', value: { answer: 2 } }),
  ]);
  assert.deepEqual(resultJson(frames[1]!), { text: 'ok', outcome: 'green' });
  assert.deepEqual(resultJson(frames[2]!), { text: 'ok', outcome: 'green' });
  assert.equal(orderCalls, 2, 'each submit re-reads the immutable order packet');
  assert.equal(submitted.length, 2);

  const signedVersions: number[] = [];
  for (const body of submitted) {
    assert.equal(typeof body.proof, 'string');
    const verified = await dsseVerifySubmission(JSON.parse(body.proof as string), {
      async verify(_bytes, signature) {
	return signature.toString('utf8') === ARMOR
	  ? { keyid: PUBLIC_KEY.keyid, principal: 'machine', format: 'sshsig' as const }
	  : null;
      },
    });
    const record = JSON.parse(verified.payloadBytes.toString('utf8')) as {
      produced: Array<{ artifact: string; version: number }>;
    };
    assert.equal(record.produced[0]!.artifact, 'result');
    signedVersions.push(record.produced[0]!.version);
  }
  assert.deepEqual(signedVersions, [1, 2]);
});

test('mcp: a producer submit stays unsigned when the hub issues no owed target version', async () => {
  const submitted: Array<Record<string, unknown>> = [];
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/get_order': () => ({
      status: 200,
      json: {
        text: '',
        workflow: 'wf1',
        run: 'run1',
        order: {
          run: 'run1',
          workflow: 'wf1',
          step: 'producer',
          key: 'k',
          defDigest: 'def-digest',
          inputs: [],
          outputs: ['result'],
          consumes: {},
          consumedFingerprint: {},
          owes: [{ path: 'result', judgmentRejects: 0, schemaRejects: 0, reasons: [] }],
        },
        lease: { claimed: true },
      },
    }),
    'POST /api/submit': (req) => {
      submitted.push(JSON.parse(req.body ?? '{}') as Record<string, unknown>);
      return { status: 200, json: { text: 'ok', outcome: 'green' } };
    },
  };
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);
  const mcpIo = t.io as unknown as {
    principalKeys?: Pick<PrincipalKeyManager, 'inspect' | 'resolveRef' | 'withSigningKey'>;
    sshProcess?: SshProcessAdapter;
  };
  mcpIo.principalKeys = SIGNING_KEYS;
  mcpIo.sshProcess = fakeSshProcess();

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [
    INIT,
    call(3, 'submit', { workflow: 'wf1', run: 'run1', path: 'result', value: { answer: 1 } }),
  ]);
  assert.deepEqual(resultJson(frames[1]!), { text: 'ok', outcome: 'green' });
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]!.proof, undefined);
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

test('mcp: list_workflows is an authenticated GET passthrough and preserves explicit ephemeral-discovery flags', async () => {
  const body = {
    workflows: [{
      name: 'metadata-rich',
      title: 'Metadata-rich',
      inputs: ['request', 'notes'],
      inputSchemas: [
	{
	  name: 'request',
	  schema: {
	    type: 'object',
	    properties: { items: { type: 'array', items: { type: 'string' } } },
	  },
	},
	{ name: 'notes' },
      ],
      x: {
	discovery: { tags: ['planning'] },
	vendor: { nested: { enabled: true } },
      },
    }],
  };
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'GET /api/workflows': () => ({ status: 200, json: body }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [
    INIT,
    call(3, 'list_workflows'),
    call(4, 'list_workflows', { include_ephemeral: true }),
    call(5, 'list_workflows', { include_ephemeral: false }),
  ]);
  for (const id of [3, 4, 5]) {
    assert.deepEqual(resultJson(frames.find((frame) => frame.id === id)!), body, 'the client must return the full hub body without a local response schema');
  }

  const workflows = calls.filter((row) => row.pathname === '/api/workflows');
  assert.equal(workflows.length, 3, 'exactly one hub call per list_workflows invocation');
  assert.ok(workflows.every((row) => row.method === 'GET'));
  assert.ok(workflows.every((row) => row.authorization === 'Bearer mcpat_human'));
  assert.deepEqual(workflows.map((row) => new URL(row.url).search), ['', '?include_ephemeral=true', '?include_ephemeral=false']);
});

test('mcp: delete_workflow advertises a constrained name and posts it unchanged', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/delete_workflow': () => ({ status: 200, json: { retired: true } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [
    INIT,
    LIST,
    call(3, 'delete_workflow', { name: 'eph-report-123-abc' }),
    call(4, 'delete_workflow', { name: '' }),
  ]);
  const tools = (frames[1]!.result as {
    tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } }>;
  }).tools;
  const remove = tools.find((tool) => tool.name === 'delete_workflow')!;
  assert.deepEqual(remove.inputSchema.properties.name, { type: 'string', minLength: 1 });
  assert.deepEqual(remove.inputSchema.required, ['name']);
  assert.equal(remove.inputSchema.additionalProperties, false);
  assert.deepEqual(resultJson(frames.find((frame) => frame.id === 3)!), { retired: true });
  assert.equal(frames.find((frame) => frame.id === 4)!.error!.code, -32602, 'an empty name must fail locally');

  const deletions = calls.filter((row) => row.pathname === '/api/delete_workflow');
  assert.equal(deletions.length, 1, 'schema-invalid names must never reach the hub');
  assert.equal(deletions[0]!.method, 'POST');
  assert.equal(deletions[0]!.authorization, 'Bearer mcpat_human');
  assert.deepEqual(JSON.parse(deletions[0]!.body!), { name: 'eph-report-123-abc' });
});

test('mcp: delete_workflow preserves an active-root refusal message', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/delete_workflow': () => ({
      status: 409,
      json: { error: 'workflow_delete_refused', message: "cannot be deleted while active root 'run_123' references it" },
    }),
  };
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'delete_workflow', { name: 'eph-report-123-abc' })]);
  assert.equal(frames[1]!.result!.isError, true);
  assert.deepEqual(resultJson(frames[1]!), {
    error: 'workflow_delete_refused',
    message: "cannot be deleted while active root 'run_123' references it",
  });
});

test('mcp: serving-capability schema fields are optional and passthrough preserves them unchanged', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/presence_ping': () => ({ status: 200, json: { ok: true } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [
    INIT,
    LIST,
    call(3, 'presence_ping', { name: 'c1', serve_capabilities: ['build:deep'], shift_id: 'shf_x', started_at: 123 }),
    call(4, 'presence_ping', { name: 'c1' }),
  ]);

  // Schema guard: these fields are advertised as optional; the existing call shape
  // (required/additionalProperties) is byte-identical to before.
  const tools = (frames[1]!.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean } }> }).tools;
  const ping = tools.find((x) => x.name === 'presence_ping')!;
  const whatsNext = tools.find((x) => x.name === 'whats_next')!;
  assert.ok('serve_capabilities' in whatsNext.inputSchema.properties, 'whats_next serving set advertised');
  assert.equal(whatsNext.inputSchema.additionalProperties, false);
  assert.ok('shift_id' in ping.inputSchema.properties, 'shift_id advertised');
  assert.ok('started_at' in ping.inputSchema.properties, 'started_at advertised');
  assert.ok('serve_capabilities' in ping.inputSchema.properties, 'presence serving set advertised');
  assert.deepEqual(ping.inputSchema.required, ['name']);
  assert.equal(ping.inputSchema.additionalProperties, false);

  const pings = calls.filter((c) => c.pathname === '/api/presence_ping');
  assert.equal(pings.length, 2);
  // Highest-risk detail: request fields are snake_case and must survive the verbatim passthrough.
  assert.deepEqual(JSON.parse(pings[0]!.body!), { name: 'c1', serve_capabilities: ['build:deep'], shift_id: 'shf_x', started_at: 123 });
  // Omitting the new fields still posts exactly the old shape — no keys added.
  assert.deepEqual(JSON.parse(pings[1]!.body!), { name: 'c1' });
});

// ---- crew tools --------------------------------------------------------------

test('mcp: list_crews is a plain GET passthrough — the full body (including the orphan crew row) survives with no filtering or narrowing', async () => {
  const body = {
    text: '2 crews',
    crews: [
      {
        id: 'crw_1',
        name: 'alex-personal',
        kind: 'personal',
        ownerMemberId: 'mem_alex',
        members: [{ principalKind: 'member', principalId: 'mem_alex', addedBy: 'mem_alex', addedAt: 1700000000000 }],
      },
      {
        // Deliberately included: the orphan crew is a normal row here, not filtered out.
        // `id` is a normal randomId() — NOT the reserved name — per
        // owenloop-service manage-crews.ts's `ensureOrphanCrew`; the reserved
        // NAME (`ORPHAN_CREW_NAME`) is what `orphan:` prefixes, at :104.
        id: 'crw_orphan',
        name: 'orphan:unrouted',
        kind: 'orphan',
        ownerMemberId: null,
        members: [
          { principalKind: 'member', principalId: 'mem_admin1', addedBy: 'mem_admin1', addedAt: 1700000000000 },
          { principalKind: 'member', principalId: 'mem_admin2', addedBy: 'mem_admin2', addedAt: 1700000000000 },
        ],
      },
    ],
  };
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'GET /api/crews': () => ({ status: 200, json: body }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'list_crews', {})]);
  assert.deepEqual(resultJson(frames[1]!), body, 'no filtering or narrowing — the full hub body, orphan row included');

  const crews = calls.filter((c) => c.pathname === '/api/crews');
  assert.equal(crews.length, 1, 'exactly one hub call');
  assert.equal(crews[0]!.method, 'GET');
  assert.equal(crews[0]!.authorization, 'Bearer mcpat_human', 'the human bearer rode the Authorization header');
});

test('mcp: create_crew forwards name/kind, includes ownerMemberId only when given, and maps the 2xx {text,crew} body through', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/create_crew': (req) => {
      const parsed = JSON.parse(req.body ?? '{}') as { name: string };
      return { status: 200, json: { text: `crew ${parsed.name} created`, crew: { id: `pl_${parsed.name}`, name: parsed.name, kind: 'personal' } } };
    },
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [
    INIT,
    call(3, 'create_crew', { name: 'alex-personal', kind: 'personal', ownerMemberId: 'mem_alex' }),
    call(4, 'create_crew', { name: 'team-shared', kind: 'shared' }),
  ]);
  assert.deepEqual(resultJson(frames[1]!), { text: 'crew alex-personal created', crew: { id: 'pl_alex-personal', name: 'alex-personal', kind: 'personal' } });
  assert.deepEqual(resultJson(frames[2]!), { text: 'crew team-shared created', crew: { id: 'pl_team-shared', name: 'team-shared', kind: 'personal' } });

  const posts = calls.filter((c) => c.pathname === '/api/create_crew');
  assert.equal(posts.length, 2);
  assert.deepEqual(JSON.parse(posts[0]!.body!), { name: 'alex-personal', kind: 'personal', ownerMemberId: 'mem_alex' });
  // Omitting ownerMemberId posts EXACTLY {name, kind} — no extra key, no null/undefined placeholder.
  assert.deepEqual(JSON.parse(posts[1]!.body!), { name: 'team-shared', kind: 'shared' });
});

test('mcp: add_crew_member forwards crewId/principalKind/principalId unchanged and maps the 2xx {text,member} body through', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/add_crew_member': () => ({
      status: 200,
      json: { text: 'member added', member: { crewId: 'crw_1', principalKind: 'agent', principalId: 'agt_1' } },
    }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'add_crew_member', { crewId: 'crw_1', principalKind: 'agent', principalId: 'agt_1' })]);
  assert.deepEqual(resultJson(frames[1]!), { text: 'member added', member: { crewId: 'crw_1', principalKind: 'agent', principalId: 'agt_1' } });

  const posts = calls.filter((c) => c.pathname === '/api/add_crew_member');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0]!.body!), { crewId: 'crw_1', principalKind: 'agent', principalId: 'agt_1' });
});

test('mcp: remove_crew_member — a tolerant hub 200 {removed:false} (never-a-member) is a NORMAL result, never turned into a tool error', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/remove_crew_member': () => ({
      status: 200,
      json: { text: 'not a member', crewId: 'crw_1', principalId: 'mem_never', removed: false },
    }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'remove_crew_member', { crewId: 'crw_1', principalId: 'mem_never' })]);
  // The hub's tolerant semantics (200, removed:false) must NOT be reinterpreted as an error here.
  assert.equal(frames[1]!.result!.isError, undefined, 'a tolerant removed:false is a normal (non-error) result');
  assert.deepEqual(resultJson(frames[1]!), { text: 'not a member', crewId: 'crw_1', principalId: 'mem_never', removed: false });

  const posts = calls.filter((c) => c.pathname === '/api/remove_crew_member');
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0]!.body!), { crewId: 'crw_1', principalId: 'mem_never' });
});

test('mcp: a hub 400 orphan-crew refusal on a crew tool maps to isError (non-2xx still becomes an error, unlike the tolerant remove case)', async () => {
  // Real hub contract, not invented: `isCrewError` maps to `{error:'crew_invalid', message}`
  // (owenloop-service apps/hub-edge/src/index.ts:320-321), and the message text is
  // `assertNotOrphanCrew`'s own wording verbatim (manage-crews.ts:187-193), with
  // `addCrewMember`'s `what` clause (manage-crews.ts:307).
  const orphanMessage =
    "crew 'orphan:unrouted' is the org's internal orphan crew — its membership is the org admin roster and " +
    'cannot be edited directly. It holds work whose crew was deleted; re-route those runs by stamping them ' +
    'elsewhere or cancel them.';
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/add_crew_member': () => ({
      status: 400,
      json: { error: 'crew_invalid', message: orphanMessage },
    }),
  };
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  // `crewId` is the crew's ID, not its NAME — `orphan:unrouted` is the reserved
  // NAME (`ORPHAN_CREW_NAME`), while the id the hub assigns via `ensureOrphanCrew`
  // is a normal `randomId()`. A plausible id is used here for the argument; it is
  // the tool's REQUEST shape, distinct from the hub's error message above, which
  // names the crew by its NAME (mirroring `crew.name` in `assertNotOrphanCrew`).
  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'add_crew_member', { crewId: 'crw_orphan', principalKind: 'member', principalId: 'mem_x' })]);
  assert.equal(frames[1]!.result!.isError, true);
  assert.deepEqual(resultJson(frames[1]!), { error: 'crew_invalid', message: orphanMessage });
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
    crews: ['alex-personal'],
    crewIds: ['crw_1'],
  };
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/mint_agent_token': () => ({ status: 200, json: mintBody }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { code, frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'create_agent', { name: 'newbot', crews: ['alex-personal'] })]);
  assert.equal(code, 0, t.err.join('\n'));

  // The result is built from scratch — the token/text/id/agentId/crewIds are gone.
  assert.deepEqual(resultJson(frames[1]!), { name: 'newbot', crews: ['alex-personal'], stored: true });

  // FULL-TRANSCRIPT assertion: the secret appears in NO outbound frame and NO stderr line.
  for (const line of t.out) assert.ok(!line.includes('olp_'), `olp_ leaked to stdout frame: ${line}`);
  for (const line of t.err) assert.ok(!line.includes('olp_'), `olp_ leaked to stderr: ${line}`);

  // The token WAS written to the agent:<name> slot, verbatim.
  const stored = JSON.parse(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'newbot' }))!) as Credential;
  assert.deepEqual(stored, { kind: 'agent', accessToken: SECRET });

  // The mint request defaulted scopes:['work'] and forwarded name + crews.
  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token');
  assert.deepEqual(JSON.parse(mint!.body!), { name: 'newbot', scopes: ['work'], crews: ['alex-personal'] });
});

test('mcp: create_agent honors a passed scopes array in the mint body', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/mint_agent_token': () => ({ status: 200, json: { token: 'olp_Shift_tok', crews: [] } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { code, frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'create_agent', { name: 'condbot', scopes: ['work', 'run'] })]);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(frames[1]!.result!.isError, undefined);

  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token');
  assert.deepEqual(JSON.parse(mint!.body!), { name: 'condbot', scopes: ['work', 'run'] });
  for (const line of t.out) assert.ok(!line.includes('olp_'), `olp_ leaked to stdout frame: ${line}`);
  assert.ok(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'condbot' })), 'agent:condbot stored');
});

test('mcp: create_agent with no scopes defaults the mint body to work-only', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/mint_agent_token': () => ({ status: 200, json: { token: 'olp_def_tok', crews: [] } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { code } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'create_agent', { name: 'defbot' })]);
  assert.equal(code, 0, t.err.join('\n'));

  const mint = calls.find((c) => c.pathname === '/api/mint_agent_token');
  assert.deepEqual(JSON.parse(mint!.body!), { name: 'defbot', scopes: ['work'] });
});

test('mcp: create_agent rejects empty scopes BEFORE any network call, storing nothing', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  // No human credential seeded (like the invalid-name test): scope validation
  // runs before any credential read, so no gating probe or mint call fires.

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'create_agent', { name: 'emptybot', scopes: [] })]);
  assert.equal(frames[1]!.result!.isError, true);
  assert.match(frames[1]!.result!.content![0]!.text, /invalid scopes/);
  assert.equal(calls.length, 0, 'no hub call was made for invalid scopes');
  assert.equal(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'emptybot' })), undefined, 'nothing stored');
});

test('mcp: create_agent rejects an invalid name BEFORE any network call', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  // No human credential seeded and no routes: if the handler reached the network it would throw.

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'create_agent', { name: 'bad name!' })]);
  assert.equal(frames[1]!.error!.code, -32602);
  assert.match(frames[1]!.error!.message, /invalid arguments for tool 'create_agent'/u);
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
      return { status: 200, json: { token: `olp_${name}_tok`, crews: [] } };
    },
  };
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  seedHuman(t);

  const { frames } = await driveMcp(t, ['mcp', '--hub', ORIGIN], [INIT, call(3, 'create_agent', { name: 'alpha' }), call(4, 'create_agent', { name: 'beta' })]);
  // Both replied (matched by id — order may interleave).
  const byId = new Map(frames.filter((f) => f.id !== undefined).map((f) => [f.id, f]));
  assert.deepEqual(resultJson(byId.get(3)!), { name: 'alpha', crews: [], stored: true });
  assert.deepEqual(resultJson(byId.get(4)!), { name: 'beta', crews: [], stored: true });
  // Both tokens landed in their own slots.
  assert.deepEqual(JSON.parse(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'alpha' }))!), { kind: 'agent', accessToken: 'olp_alpha_tok' });
  assert.deepEqual(JSON.parse(t.store.get(kcKey(ORIGIN, { principal: 'agent', account: 'beta' }))!), { kind: 'agent', accessToken: 'olp_beta_tok' });
});

// ---- origin resolution ------------------------------------------------------

test('mcp: with no --hub, no OWENLOOP_HUB, no config file, and no stored hub (file backend) → resolves to DEFAULT_HUB, NOT exit 2', async () => {
  let fetchCalls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected network request in origin-fallback test');
  };
  const t = makeIo({ env: { OWENLOOP_NO_KEYCHAIN: '1' }, fetch });
  assert.equal(resolveMcpOrigin(t.io, undefined), DEFAULT_HUB, 'falls all the way through the ladder to the production default');

  const { code, frames } = await driveMcp(t, ['mcp'], [INIT]);
  assert.equal(fetchCalls, 0, 'origin fallback must not reach the network');
  assert.equal(code, 0, t.err.join('\n'));
  assert.notEqual(frames[0]?.result?.serverInfo, undefined, 'the handshake completes instead of exiting before it');
});

test('mcp: with two stored file-backend hubs and no config file and no --hub → resolves to DEFAULT_HUB, NOT exit 2 (the behavior change)', async () => {
  let fetchCalls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('unexpected network request in ambiguous-origin test');
  };
  const t = makeIo({ env: { OWENLOOP_NO_KEYCHAIN: '1' }, fetch });
  await storeCredential(t.io, 'http://127.0.0.1:9', { principal: 'human' }, PASTED_HUMAN);
  await storeCredential(t.io, 'http://127.0.0.1:10', { principal: 'human' }, PASTED_HUMAN);

  assert.equal(resolveMcpOrigin(t.io, undefined), DEFAULT_HUB, 'an ambiguous file-backend store now falls through instead of refusing');

  const { code } = await driveMcp(t, ['mcp'], [INIT]);
  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(fetchCalls, 0, 'ambiguous origin fallback must not reach the network');
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

// REGRESSION — this is the exact bug: a real macOS install (keychain backend,
// unenumerable) with a perfectly valid human credential already logged in,
// and no env var set. Before this change, `owenloop mcp` exited 2 here even
// though the operator had done everything right. Two angles on the same fact:
// (a) drives the real command end to end with `owenloop login`'s config file
// present, the honest post-fix shape; (b) calls `resolveMcpOrigin` directly
// with NO config file, proving the ladder's rung 5 alone — not a config file
// the user happens to have — is what stops the exit-2 regression from coming
// back if rung 3 ever breaks.
test('mcp: REGRESSION — keychain backend + a stored human credential + no --hub/env, with the config file login writes → starts instead of exiting 2', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/stage_enrollment': () => ({ status: 404, json: {} }),
    'POST /api/whats_next': () => ({ status: 200, json: { ok: true } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch }); // default backend = fake keychain, unenumerable — the exact bug scenario
  seedHuman(t, ORIGIN);
  writeGlobalConfig(globalConfigPath(t.home), { version: 1, hub: ORIGIN });

  const { code, frames } = await driveMcp(t, ['mcp'], [INIT, call(3, 'whats_next', {})]);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(resultJson(frames[1]!), { ok: true });
  assert.ok(calls.some((c) => c.pathname === '/api/whats_next'));
});

test('mcp: REGRESSION — keychain backend + a stored human credential + no --hub/env/config file → resolveMcpOrigin still returns DEFAULT_HUB, never exit 2', () => {
  const t = makeIo({}); // default backend = fake keychain, unenumerable — no config file written at all
  seedHuman(t, ORIGIN); // a valid human credential IS present; it is simply unenumerable — that was the whole bug
  assert.doesNotThrow(() => resolveMcpOrigin(t.io, undefined));
  assert.equal(resolveMcpOrigin(t.io, undefined), DEFAULT_HUB);
});

test('mcp: resolveMcpOrigin — the --hub flag beats a config file naming a different hub', () => {
  const t = makeIo({});
  writeGlobalConfig(globalConfigPath(t.home), { version: 1, hub: 'http://127.0.0.1:20' });
  assert.equal(resolveMcpOrigin(t.io, 'http://127.0.0.1:9'), 'http://127.0.0.1:9');
});

test('mcp: resolveMcpOrigin — OWENLOOP_HUB beats a config file (the dev override is preserved)', () => {
  const t = makeIo({ env: { OWENLOOP_HUB: 'http://127.0.0.1:30' } });
  writeGlobalConfig(globalConfigPath(t.home), { version: 1, hub: 'http://127.0.0.1:20' });
  assert.equal(resolveMcpOrigin(t.io, undefined), 'http://127.0.0.1:30');
});

test('mcp: resolveMcpOrigin — the config file is used when neither --hub nor OWENLOOP_HUB is set', () => {
  const t = makeIo({});
  writeGlobalConfig(globalConfigPath(t.home), { version: 1, hub: 'http://127.0.0.1:40' });
  assert.equal(resolveMcpOrigin(t.io, undefined), 'http://127.0.0.1:40');
});

test('mcp: resolveMcpOrigin — the config file (rung 3) beats a single inferred file-backend hub (rung 4)', async () => {
  const t = makeIo({ env: { OWENLOOP_NO_KEYCHAIN: '1' } });
  await storeCredential(t.io, 'http://127.0.0.1:50', { principal: 'human' }, PASTED_HUMAN);
  writeGlobalConfig(globalConfigPath(t.home), { version: 1, hub: 'http://127.0.0.1:40' });
  assert.equal(resolveMcpOrigin(t.io, undefined), 'http://127.0.0.1:40', 'rung 3 wins over the single-hub rung-4 inference');
});

test('mcp: resolveMcpOrigin — with nothing configured anywhere (keychain backend, nothing stored) → DEFAULT_HUB, no throw', () => {
  const t = makeIo({});
  assert.doesNotThrow(() => resolveMcpOrigin(t.io, undefined));
  assert.equal(resolveMcpOrigin(t.io, undefined), DEFAULT_HUB);
});

test('mcp: resolveMcpOrigin — a corrupt config.json falls through to DEFAULT_HUB, never throws, never resolves to garbage', () => {
  const write = (t: HubIo, content: string): void => {
    mkdirSync(join(t.home, '.owenloop'), { recursive: true });
    writeFileSync(globalConfigPath(t.home), content);
  };

  // Not valid JSON at all.
  {
    const t = makeIo({});
    write(t, '{not json');
    assert.doesNotThrow(() => resolveMcpOrigin(t.io, undefined));
    assert.equal(resolveMcpOrigin(t.io, undefined), DEFAULT_HUB);
  }
  // Valid JSON, but no `hub` field.
  {
    const t = makeIo({});
    write(t, JSON.stringify({ version: 1 }));
    assert.equal(resolveMcpOrigin(t.io, undefined), DEFAULT_HUB);
  }
  // `hub` present but not a string.
  {
    const t = makeIo({});
    write(t, JSON.stringify({ version: 1, hub: 12345 }));
    assert.equal(resolveMcpOrigin(t.io, undefined), DEFAULT_HUB);
  }
  // `hub` is a string but does not parse as a valid http(s) origin.
  {
    const t = makeIo({});
    write(t, JSON.stringify({ version: 1, hub: 'not a url' }));
    assert.equal(resolveMcpOrigin(t.io, undefined), DEFAULT_HUB);
  }
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
