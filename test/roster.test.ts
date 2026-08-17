import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mainAsync } from '../src/cli.ts';
import type { Keychain } from '../src/cli.ts';
import { kcHuman, kcKey, makeIo, routedFetch } from './hubkit.ts';
import type { RouteHandler } from './hubkit.ts';

const ORIGIN = 'https://hub.example.test';
const human = { kind: 'oauth-pasted' as const, accessToken: 'human-token' };
const agent = { kind: 'agent' as const, accessToken: 'agent-token' };

test('roster org put surfaces an unprivileged hub refusal without a write-shaped success', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/put_roster': () => ({ status: 403, json: { error: 'forbidden', message: 'admin role required' } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  t.store.set(kcHuman(ORIGIN), JSON.stringify(human));
  const code = await mainAsync(['roster', 'org', 'put', 'build', '--candidate', 'codex:gpt-5:high', '--hub', ORIGIN], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /admin role required/u);
  assert.equal(t.out.length, 0);
  assert.equal(calls.filter((call) => call.pathname === '/api/put_roster').length, 1);
});

test('roster org and registry GET their live read endpoints with a human credential', async () => {
  const routes: Record<string, RouteHandler> = {
    'GET /api/rosters': () => ({ status: 200, json: { global: {}, crews: [] } }),
    'GET /api/harness_models': () => ({ status: 200, json: { harnesses: [{ harness: 'codex', displayName: '' }], models: [] } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  t.store.set(kcHuman(ORIGIN), JSON.stringify(human));
  assert.equal(await mainAsync(['roster', 'org', '--hub', ORIGIN], t.io), 0, t.err.join('\n'));
  assert.equal(await mainAsync(['roster', 'registry', '--hub', ORIGIN], t.io), 0, t.err.join('\n'));
  assert.equal(calls.filter((call) => call.pathname === '/api/rosters')[0]!.method, 'GET');
  assert.equal(calls.filter((call) => call.pathname === '/api/harness_models')[0]!.method, 'GET');
  const registry = JSON.parse(t.out.at(-1)!) as { registry: { harnesses: Array<{ displayName: string }> } };
  assert.equal(registry.registry.harnesses[0]?.displayName, '', 'the service permits an intentionally blank display name');
});

test('roster org preserves an own __proto__ capability and rejects array rosters', async () => {
  const protoRoster = JSON.parse(
    '{"global":{"__proto__":[{"harness":"codex","model":"gpt-5","effort":"high"}]},"crews":[]}',
  ) as unknown;
  const { fetch } = routedFetch({ 'GET /api/rosters': () => ({ status: 200, json: protoRoster }) });
  const t = makeIo({ fetch });
  t.store.set(kcHuman(ORIGIN), JSON.stringify(human));
  assert.equal(await mainAsync(['roster', 'org', '--hub', ORIGIN], t.io), 0, t.err.join('\n'));
  const output = JSON.parse(t.out.join('\n')) as { rosters: { global: Record<string, unknown> } };
  assert.deepEqual(output.rosters.global['__proto__'], [{ harness: 'codex', model: 'gpt-5', effort: 'high' }]);

  const malformed = makeIo({ fetch: routedFetch({ 'GET /api/rosters': () => ({ status: 200, json: { global: [], crews: [] } }) }).fetch });
  malformed.store.set(kcHuman(ORIGIN), JSON.stringify(human));
  assert.equal(await mainAsync(['roster', 'org', '--hub', ORIGIN], malformed.io), 1);
  assert.match(malformed.err.join('\n'), /roster must be an object/u);
});

test('roster read verbs reject malformed 2xx bodies and preserve credential exit code 3', async () => {
  for (const [args, route, body] of [
    [['roster', 'org', '--hub', ORIGIN], 'GET /api/rosters', { global: {}, crews: [{}] }],
    [['roster', 'registry', '--hub', ORIGIN], 'GET /api/harness_models', { harnesses: [{}], models: [] }],
  ] as const) {
    const t = makeIo({ fetch: routedFetch({ [route]: () => ({ status: 200, json: body }) }).fetch });
    t.store.set(kcHuman(ORIGIN), JSON.stringify(human));
    assert.equal(await mainAsync([...args], t.io), 1);
    assert.equal(t.out.length, 0);
    assert.match(t.err.join('\n'), /malformed success response/u);
  }
  for (const [args, route, token] of [
    [['roster', 'org', '--hub', ORIGIN], 'GET /api/rosters', human],
    [['roster', 'registry', '--hub', ORIGIN], 'GET /api/harness_models', human],
    [['roster', 'sync', '--hub', ORIGIN], 'GET /api/whoami', agent],
  ] as const) {
    const routes: Record<string, RouteHandler> = { [route]: () => ({ status: 401, json: { message: 'nope' } }) };
    if (args[1] === 'sync') routes['GET /api/rosters'] = () => ({ status: 200, json: { global: {}, crews: [] } });
    const t = makeIo({ fetch: routedFetch(routes).fetch });
    t.store.set(args[1] === 'sync' ? kcKey(ORIGIN, { principal: 'agent' }) : kcHuman(ORIGIN), JSON.stringify(token));
    assert.equal(await mainAsync([...args], t.io), 3, `${args.join(' ')}: ${t.err.join('\n')}`);
  }
});

test('roster sync defaults to the default agent slot and writes a readable local cache', async () => {
  const routes: Record<string, RouteHandler> = {
    'GET /api/whoami': () => ({ status: 200, json: { orgId: 'org_1', orgName: 'Example', actor: {}, tokenStatus: 'active', authMethod: 'token' } }),
    'GET /api/rosters': () => ({ status: 200, json: { global: { build: [{ harness: 'codex', model: 'gpt-5', effort: 'high' }] }, crews: [] } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-command-'));
  try {
    const t = makeIo({ fetch, env: { HOME: home } });
    t.store.set(kcKey(ORIGIN, { principal: 'agent' }), JSON.stringify(agent));
    const code = await mainAsync(['roster', 'sync', '--hub', ORIGIN], t.io);
    assert.equal(code, 0, t.err.join('\n'));
    assert.match(t.out.join('\n'), /cachePath/u);
    const auth = calls.filter((call) => call.pathname === '/api/rosters')[0]!.authorization;
    assert.equal(auth, 'Bearer agent-token');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('roster sync reports a missing default agent slot and still refuses an explicit human slot', async () => {
  const t = makeIo({ fetch: routedFetch({}).fetch });
  assert.equal(await mainAsync(['roster', 'sync', '--hub', ORIGIN], t.io), 3);
  assert.match(t.err.join('\n'), /slot `agent:default`/u);
  const t2 = makeIo({ fetch: routedFetch({}).fetch });
  assert.equal(await mainAsync(['roster', 'sync', '--hub', ORIGIN, '--as', 'human'], t2.io), 1);
  assert.match(t2.err.join('\n'), /requires an agent credential/u);
});

test('each roster form rejects flags belonging to another form before credentials or hub I/O', async () => {
  const cases = [
    ['roster', 'show', '--hub', ORIGIN],
    ['roster', 'org', '--candidate', 'codex:gpt-5:high'],
    ['roster', 'org', 'put', 'build', '--model', 'gpt-5:high'],
    ['roster', 'org', 'rm', 'build', '--candidate', 'codex:gpt-5:high'],
    ['roster', 'registry', '--crew', 'delivery'],
    ['roster', 'registry', 'put', 'codex', '--candidate', 'codex:gpt-5:high'],
    ['roster', 'sync', '--model', 'gpt-5:high'],
  ];
  for (const args of cases) {
    const { fetch, calls } = routedFetch({});
    const t = makeIo({ fetch });
    assert.equal(await mainAsync(args, t.io), 1, args.join(' '));
    assert.match(t.err.join('\n'), /not valid for this roster command/u);
    assert.equal(calls.length, 0, `${args.join(' ')} must fail before hub I/O`);
  }
});

test('roster forms retain global --db and --defs options while narrowing their own flags', async () => {
  const t = makeIo({ fetch: routedFetch({}).fetch });
  assert.equal(await mainAsync(['roster', 'show', '--db', 'ignored.db', '--defs', 'ignored-defs'], t.io), 0, t.err.join('\n'));
});

test('roster mutations reject malformed or wrong-verb 2xx responses', async () => {
  const cases: Array<{ endpoint: string; args: string[]; body: unknown }> = [
    {
      endpoint: 'put_roster',
      args: ['roster', 'org', 'put', 'build', '--candidate', 'codex:gpt-5:high', '--hub', ORIGIN],
      body: { crewId: null, capability: 'build', removed: true },
    },
    {
      endpoint: 'delete_roster_row',
      args: ['roster', 'org', 'rm', 'build', '--hub', ORIGIN],
      body: {},
    },
    {
      endpoint: 'put_harness_models',
      args: ['roster', 'registry', 'put', 'codex', '--model', 'gpt-5:high', '--hub', ORIGIN],
      body: { crewId: null, crewName: null, capability: 'build', candidates: [], warnings: [] },
    },
  ];
  for (const scenario of cases) {
    const { fetch } = routedFetch({ [`POST /api/${scenario.endpoint}`]: () => ({ status: 200, json: scenario.body }) });
    const t = makeIo({ fetch });
    t.store.set(kcHuman(ORIGIN), JSON.stringify(human));
    assert.equal(await mainAsync(scenario.args, t.io), 1, scenario.endpoint);
    assert.equal(t.out.length, 0, `${scenario.endpoint} must not print ok:true for malformed success`);
    assert.match(t.err.join('\n'), new RegExp(`${scenario.endpoint}: malformed success response`, 'u'));
  }
});

test('roster org put, org rm, and registry put accept only their proven success shapes', async () => {
  const routes: Record<string, RouteHandler> = {
    'POST /api/put_roster': () => ({
      status: 200,
      json: { crewId: 'crew_1', crewName: 'delivery', capability: 'build', candidates: [{ harness: 'codex', model: 'gpt-5', effort: 'high' }], warnings: ['model is deprecated'] },
    }),
    'POST /api/delete_roster_row': () => ({ status: 200, json: { crewId: null, capability: 'build', removed: true } }),
    'POST /api/put_harness_models': () => ({
      status: 200,
      json: { harness: 'codex', displayName: '', models: [{ model: 'gpt-5', efforts: ['high'], updatedAt: 1, updatedBy: 'member_1' }] },
    }),
  };
  const { fetch } = routedFetch(routes);
  const t = makeIo({ fetch });
  t.store.set(kcHuman(ORIGIN), JSON.stringify(human));

  assert.equal(await mainAsync(['roster', 'org', 'put', 'build', '--crew', 'delivery', '--candidate', 'codex:gpt-5:high', '--hub', ORIGIN], t.io), 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.pop()!).result, { crewId: 'crew_1', crewName: 'delivery', capability: 'build', candidates: [{ harness: 'codex', model: 'gpt-5', effort: 'high' }], warnings: ['model is deprecated'] });

  assert.equal(await mainAsync(['roster', 'org', 'rm', 'build', '--hub', ORIGIN], t.io), 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.pop()!).result, { crewId: null, capability: 'build', removed: true });

  assert.equal(await mainAsync(['roster', 'registry', 'put', 'codex', '--display-name', '', '--model', 'gpt-5:high', '--hub', ORIGIN], t.io), 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(t.out.pop()!).result, { harness: 'codex', displayName: '', models: [{ model: 'gpt-5', efforts: ['high'], updatedAt: 1, updatedBy: 'member_1' }] });
});

test('roster payload and sync-slot syntax fail before any credential lookup or hub request', async () => {
  const cases = [
    ['roster', 'org', 'put', 'build', '--candidate', 'not-a-candidate', '--hub', ORIGIN],
    ['roster', 'registry', 'put', 'codex', '--model', 'not-a-model', '--hub', ORIGIN],
    ['roster', 'registry', 'put', 'codex', '--display-name', '--model', 'gpt-5:high', '--hub', ORIGIN],
    ['roster', 'sync', '--as', 'agent:', '--hub', ORIGIN],
  ];
  for (const args of cases) {
    let credentialAccesses = 0;
    const keychain: Keychain = {
      get: () => { credentialAccesses++; return null; },
      set: () => { credentialAccesses++; },
      delete: () => { credentialAccesses++; },
    };
    const { fetch, calls } = routedFetch({});
    const t = makeIo({ fetch, keychain });
    assert.equal(await mainAsync(args, t.io), 1, args.join(' '));
    assert.equal(credentialAccesses, 0, `${args.join(' ')} must not access credentials`);
    assert.equal(calls.length, 0, `${args.join(' ')} must not call the hub`);
  }
});
