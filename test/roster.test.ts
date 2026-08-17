import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mainAsync } from '../src/cli.ts';
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
    'GET /api/harness_models': () => ({ status: 200, json: { harnesses: [], models: [] } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const t = makeIo({ fetch });
  t.store.set(kcHuman(ORIGIN), JSON.stringify(human));
  assert.equal(await mainAsync(['roster', 'org', '--hub', ORIGIN], t.io), 0, t.err.join('\n'));
  assert.equal(await mainAsync(['roster', 'registry', '--hub', ORIGIN], t.io), 0, t.err.join('\n'));
  assert.equal(calls.filter((call) => call.pathname === '/api/rosters')[0]!.method, 'GET');
  assert.equal(calls.filter((call) => call.pathname === '/api/harness_models')[0]!.method, 'GET');
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
