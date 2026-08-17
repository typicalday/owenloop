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

test('roster sync uses the agent slot and writes a readable local cache', async () => {
  const routes: Record<string, RouteHandler> = {
    'GET /api/whoami': () => ({ status: 200, json: { orgId: 'org_1', orgName: 'Example', actor: {}, tokenStatus: 'active', authMethod: 'token' } }),
    'GET /api/rosters': () => ({ status: 200, json: { global: { build: [{ harness: 'codex', model: 'gpt-5', effort: 'high' }] }, crews: [] } }),
  };
  const { fetch, calls } = routedFetch(routes);
  const home = mkdtempSync(join(tmpdir(), 'owenloop-roster-command-'));
  try {
    const t = makeIo({ fetch, env: { HOME: home } });
    t.store.set(kcKey(ORIGIN, { principal: 'agent' }), JSON.stringify(agent));
    const code = await mainAsync(['roster', 'sync', '--hub', ORIGIN, '--as', 'agent'], t.io);
    assert.equal(code, 0, t.err.join('\n'));
    assert.match(t.out.join('\n'), /cachePath/u);
    const auth = calls.filter((call) => call.pathname === '/api/rosters')[0]!.authorization;
    assert.equal(auth, 'Bearer agent-token');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('roster sync refuses a missing or human slot with exit 3 or usage failure', async () => {
  const t = makeIo({ fetch: routedFetch({}).fetch });
  assert.equal(await mainAsync(['roster', 'sync', '--hub', ORIGIN], t.io), 1);
  assert.match(t.err.join('\n'), /requires an agent credential/u);
  const t2 = makeIo({ fetch: routedFetch({}).fetch });
  assert.equal(await mainAsync(['roster', 'sync', '--hub', ORIGIN, '--as', 'agent'], t2.io), 3);
});
