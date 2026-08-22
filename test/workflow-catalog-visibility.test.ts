/** Hermetic CLI contract for workflow catalog visibility administration. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainAsync } from '../src/cli.ts';
import { kcHuman, makeIo, routedFetch, stallingFetch } from './hubkit.ts';

const HUB = 'http://127.0.0.1:9';
const ORIGIN = 'http://127.0.0.1:9';

function seedHuman(t: ReturnType<typeof makeIo>): void {
  t.store.set(kcHuman(ORIGIN), JSON.stringify({ kind: 'oauth-pasted', accessToken: 'mcpat_human' }));
}

function ok(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: 'ignored',
    name: 'report',
    catalogVisible: false,
    previousCatalogVisible: true,
    ...over,
  };
}

function stdoutJson(t: ReturnType<typeof makeIo>): Record<string, unknown> {
  assert.equal(t.out.length, 1, 'one stdout document');
  return JSON.parse(t.out[0]!) as Record<string, unknown>;
}

test('catalog visibility hidden POSTs the exact human-authenticated body and whitelists stdout', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/set_workflow_catalog_visibility': () => ({ status: 200, json: ok({ unknown: 'must not print' }) }),
  });
  const t = makeIo({ fetch });
  seedHuman(t);

  assert.equal(await mainAsync(['catalog', 'visibility', 'report', 'hidden', '--hub', HUB], t.io), 0, t.err.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.pathname, '/api/set_workflow_catalog_visibility');
  assert.equal(calls[0]!.authorization, 'Bearer mcpat_human');
  assert.equal(calls[0]!.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0]!.body!), { name: 'report', visible: false });
  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    name: 'report',
    catalogVisible: false,
    previousCatalogVisible: true,
    unchanged: false,
  });
  assert.deepEqual(t.err, []);
});

test('catalog visibility visible maps to true and reports server-echoed fields', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/set_workflow_catalog_visibility': () => ({
      status: 200,
      json: ok({ name: 'server-normalized', catalogVisible: true, previousCatalogVisible: false }),
    }),
  });
  const t = makeIo({ fetch });
  seedHuman(t);

  assert.equal(await mainAsync(['catalog', 'visibility', 'client-name', 'visible', '--hub', HUB], t.io), 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(calls[0]!.body!), { name: 'client-name', visible: true });
  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    name: 'server-normalized',
    catalogVisible: true,
    previousCatalogVisible: false,
    unchanged: false,
  });
});

test('catalog visibility treats an unchanged response as successful and auditable', async () => {
  const { fetch } = routedFetch({
    'POST /api/set_workflow_catalog_visibility': () => ({ status: 200, json: ok({ unchanged: true }) }),
  });
  const t = makeIo({ fetch });
  seedHuman(t);

  assert.equal(await mainAsync(['catalog', 'visibility', 'report', 'hidden', '--hub', HUB], t.io), 0, t.err.join('\n'));
  assert.equal(stdoutJson(t).unchanged, true);
  assert.deepEqual(t.err, []);
});

test('catalog visibility preserves an unknown-definition message without generic replacement', async () => {
  const message = `DefNotFoundError: unknown workflow definition 'missing'`;
  const { fetch } = routedFetch({
    'POST /api/set_workflow_catalog_visibility': () => ({ status: 404, json: { error: 'def_not_found', message } }),
  });
  const t = makeIo({ fetch });
  seedHuman(t);

  assert.equal(await mainAsync(['catalog', 'visibility', 'missing', 'hidden', '--hub', HUB], t.io), 1);
  assert.match(t.err.join('\n'), /DefNotFoundError: unknown workflow definition 'missing'/);
  assert.doesNotMatch(t.err.join('\n'), /rejected the request/);
  assert.deepEqual(t.out, []);
});

test('catalog visibility rejects every malformed argv before credentials or network work', async () => {
  const invalid = [
    ['catalog'],
    ['catalog', 'show'],
    ['catalog', 'visibility'],
    ['catalog', 'visibility', '', 'hidden'],
    ['catalog', 'visibility', 'report'],
    ['catalog', 'visibility', 'report', 'show'],
    ['catalog', 'visibility', 'report', 'false'],
    ['catalog', 'visibility', 'report', 'hidden', 'extra'],
    ['catalog', 'visibility', 'report', 'hidden', '--bogus', 'x'],
  ];
  for (const argv of invalid) {
    const { fetch, calls } = routedFetch({
      'POST /api/set_workflow_catalog_visibility': () => ({ status: 200, json: ok() }),
    });
    const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
    assert.equal(await mainAsync([...argv, '--hub', HUB], t.io), 1, JSON.stringify(argv));
    assert.equal(calls.length, 0, JSON.stringify(argv));
  }
});

test('catalog visibility needs a human credential and turns a surviving 401 into the exit-3 login remedy', async () => {
  const absent = routedFetch({
    'POST /api/set_workflow_catalog_visibility': () => ({ status: 200, json: ok() }),
  });
  const tAbsent = makeIo({ fetch: absent.fetch });
  assert.equal(await mainAsync(['catalog', 'visibility', 'report', 'hidden', '--hub', HUB], tAbsent.io), 3);
  assert.match(tAbsent.err.join('\n'), /no human credential/);
  assert.match(tAbsent.err.join('\n'), /owenloop login --hub http:\/\/127\.0\.0\.1:9/);
  assert.equal(absent.calls.length, 0);

  const rejected = routedFetch({
    'POST /api/set_workflow_catalog_visibility': () => ({ status: 401, json: { error: 'unauthorized' } }),
  });
  const tRejected = makeIo({ fetch: rejected.fetch });
  seedHuman(tRejected);
  assert.equal(await mainAsync(['catalog', 'visibility', 'report', 'hidden', '--hub', HUB], tRejected.io), 3);
  assert.match(tRejected.err.join('\n'), /credential rejected/);
  assert.match(tRejected.err.join('\n'), /owenloop login --hub http:\/\/127\.0\.0\.1:9/);
});

test('catalog visibility rejects malformed 2xx responses with fixed field-only errors and empty stdout', async () => {
  const malformed: { label: string; raw?: string; json?: Record<string, unknown> }[] = [
    { label: 'invalid JSON', raw: 'not json' },
    { label: 'missing name', json: { catalogVisible: true, previousCatalogVisible: false } },
    { label: 'bad catalogVisible', json: { name: 'report', catalogVisible: 'true', previousCatalogVisible: false } },
    { label: 'bad previousCatalogVisible', json: { name: 'report', catalogVisible: true, previousCatalogVisible: null } },
    { label: 'bad unchanged', json: { name: 'report', catalogVisible: true, previousCatalogVisible: false, unchanged: 'yes' } },
  ];
  for (const item of malformed) {
    const { fetch } = routedFetch({
      'POST /api/set_workflow_catalog_visibility': () => ({ status: 200, raw: item.raw, json: item.json }),
    });
    const t = makeIo({ fetch });
    seedHuman(t);
    assert.equal(await mainAsync(['catalog', 'visibility', 'report', 'visible', '--hub', HUB], t.io), 1, item.label);
    assert.match(t.err.join('\n'), /set_workflow_catalog_visibility: malformed success response/);
    assert.deepEqual(t.out, []);
  }
});

test('catalog help has no side effects and the setter uses shared timeout transport', async () => {
  const help = routedFetch({
    'POST /api/set_workflow_catalog_visibility': () => ({ status: 200, json: ok() }),
  });
  const tHelp = makeIo({ fetch: help.fetch });
  assert.equal(await mainAsync(['catalog', '--help'], tHelp.io), 0);
  assert.match(tHelp.out.join('\n'), /catalog visibility <name> visible\|hidden \[--hub <url>\]/);
  assert.equal(help.calls.length, 0);

  const stalled = stallingFetch(
    { 'POST /api/set_workflow_catalog_visibility': () => ({ status: 200, json: ok() }) },
    ['POST /api/set_workflow_catalog_visibility'],
  );
  const tStalled = makeIo({ fetch: stalled.fetch, env: { OWENLOOP_HUB_TIMEOUT_MS: '80' } });
  seedHuman(tStalled);
  assert.equal(await mainAsync(['catalog', 'visibility', 'report', 'hidden', '--hub', HUB], tStalled.io), 1);
  assert.match(tStalled.err.join('\n'), /did not respond within/);
});
