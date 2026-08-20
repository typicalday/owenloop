/**
 * Hosted reject/provide transport coverage, plus the no-`--hub` fallback used
 * by the installed async CLI entry point.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, mainAsync } from '../src/cli.ts';
import type { Credential } from '../src/hub.ts';
import { hubBindingPath, writeHubBinding } from '../src/hub.ts';
import { kcHuman, makeIo, routedFetch } from './hubkit.ts';

const ORIGIN = 'http://127.0.0.1:9';
const WORKFLOW = 'wf_hosted';
const OAUTH_CRED: Credential = {
  kind: 'oauth',
  accessToken: 'mcpat_reject_provide_fixture',
  refreshToken: 'rt_reject_provide_fixture',
  expiresAt: Date.now() + 3_600_000,
  clientId: 'client_reject_provide_fixture',
};
const EXAMPLES = new URL('../examples/workflows', import.meta.url).pathname;

function bind(t: ReturnType<typeof makeIo>): void {
  t.store.set(kcHuman(ORIGIN), JSON.stringify(OAUTH_CRED));
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
}

test('reject --hub posts the human-attributed wire shape and prints a stable receipt', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/reject_artifact': () => ({ status: 200, json: { unexpected: 'ignored' } }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync([
    'reject', WORKFLOW, 'pr', '--hub', ORIGIN, '--text', 'the tests need a regression', '--requested', 'deep',
  ], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${ORIGIN}/api/reject_artifact`);
  assert.equal(calls[0]!.authorization, `Bearer ${OAUTH_CRED.accessToken}`);
  const body = JSON.parse(calls[0]!.body ?? '{}') as Record<string, unknown>;
  assert.deepEqual(body, {
    workflow: WORKFLOW,
    path: 'pr',
    reason: 'the tests need a regression',
    requested: 'deep',
  });
  assert.equal('by' in body, false);
  assert.deepEqual(JSON.parse(t.out.join('\n')), {
    ok: true,
    action: 'reject',
    path: 'pr',
    workflow: WORKFLOW,
    hub: ORIGIN,
    requested: 'deep',
  });
});

test('reject --hub omits requested when absent', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/reject_artifact': () => ({ status: 200, json: {} }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['reject', WORKFLOW, 'pr', '--hub', ORIGIN, '--text', 'please revise'], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), {
    workflow: WORKFLOW,
    path: 'pr',
    reason: 'please revise',
  });
});

test('reject --hub validates its remote-only arguments before credentials or fetch', async () => {
  let networkCalls = 0;
  const fetch = (() => {
    networkCalls += 1;
    throw new Error('network must not be reached');
  }) as unknown as typeof globalThis.fetch;

  const missing = makeIo({ fetch });
  assert.equal(await mainAsync(['reject', WORKFLOW, 'pr', '--hub', ORIGIN], missing.io), 1);
  assert.match(missing.err.join('\n'), /missing value for --text/u);

  const valueless = makeIo({ fetch });
  assert.equal(await mainAsync(['reject', WORKFLOW, 'pr', '--hub', ORIGIN, '--text'], valueless.io), 1);
  assert.match(valueless.err.join('\n'), /missing value for --text/u);

  const empty = makeIo({ fetch });
  assert.equal(await mainAsync(['reject', WORKFLOW, 'pr', '--hub', ORIGIN, '--text', ''], empty.io), 1);
  assert.match(empty.err.join('\n'), /invalid empty value for --text/u);

  const attributed = makeIo({ fetch });
  assert.equal(await mainAsync(['reject', WORKFLOW, 'pr', '--hub', ORIGIN, '--by', 'reviewer', '--text', 'no'], attributed.io), 1);
  assert.match(attributed.err.join('\n'), /--by cannot be combined with --hub/u);
  assert.equal(networkCalls, 0);
});

test('provide --hub posts name rather than input and prints a stable receipt', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/provide_input': () => ({ status: 201, json: { unexpected: 'ignored' } }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['provide', WORKFLOW, 'proposal', '--hub', ORIGIN, '--value', '{"text":"ship it"}'], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${ORIGIN}/api/provide_input`);
  assert.equal(calls[0]!.authorization, `Bearer ${OAUTH_CRED.accessToken}`);
  const body = JSON.parse(calls[0]!.body ?? '{}') as Record<string, unknown>;
  assert.deepEqual(body, { workflow: WORKFLOW, name: 'proposal', value: { text: 'ship it' } });
  assert.equal('input' in body, false);
  assert.deepEqual(JSON.parse(t.out.join('\n')), {
    ok: true,
    provided: 'proposal',
    workflow: WORKFLOW,
    hub: ORIGIN,
  });
});

test('provide --hub defaults value and rejects non-object JSON before fetch', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/provide_input': () => ({ status: 200, json: {} }),
  });
  const t = makeIo({ fetch });
  bind(t);

  assert.equal(await mainAsync(['provide', WORKFLOW, 'proposal', '--hub', ORIGIN], t.io), 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), { workflow: WORKFLOW, name: 'proposal', value: {} });

  let networkCalls = 0;
  const noFetch = (() => {
    networkCalls += 1;
    throw new Error('network must not be reached');
  }) as unknown as typeof globalThis.fetch;
  for (const value of ['[]', 'null', '"scalar"', '{']) {
    const invalid = makeIo({ fetch: noFetch });
    assert.equal(await mainAsync(['provide', WORKFLOW, 'proposal', '--hub', ORIGIN, '--value', value], invalid.io), 1);
    assert.match(invalid.err.join('\n'), /invalid JSON|expected a JSON object/u);
  }
  assert.equal(networkCalls, 0);
});

test('hosted reject and provide surface credential and hub failures consistently', async () => {
  const missingCredential = makeIo();
  writeHubBinding(hubBindingPath(missingCredential.cwd), { version: 1, hub: ORIGIN });
  const missingCode = await mainAsync(['provide', WORKFLOW, 'proposal', '--hub', ORIGIN], missingCredential.io);
  assert.equal(missingCode, 3);
  assert.match(missingCredential.err.join('\n'), new RegExp(`owenloop login --hub ${ORIGIN}`, 'u'));

  const { fetch } = routedFetch({
    'POST /api/reject_artifact': () => ({ status: 409, json: { message: 'artifact is not rejectable' } }),
  });
  const rejected = makeIo({ fetch });
  bind(rejected);
  const rejectedCode = await mainAsync(['reject', WORKFLOW, 'pr', '--hub', ORIGIN, '--text', 'no'], rejected.io);
  assert.equal(rejectedCode, 1);
  assert.match(rejected.err.join('\n'), /artifact is not rejectable/u);
});

test('mainAsync keeps local provide and reject on the SQLite engine without fetching', async () => {
  let networkCalls = 0;
  const fetch = (() => {
    networkCalls += 1;
    throw new Error('local commands must not fetch');
  }) as unknown as typeof globalThis.fetch;
  const t = makeIo({ fetch, env: { OWENLOOP_DEFS: EXAMPLES } });
  const lastOutput = <T>(): T => JSON.parse(t.out[t.out.length - 1]!) as T;

  assert.equal(main(['create', 'delivery'], t.io), 0, t.err.join('\n'));
  const workflow = lastOutput<{ workflow: string }>().workflow;
  assert.equal(await mainAsync(['provide', workflow, 'proposal', '--value', '{"text":"ship it"}'], t.io), 0, t.err.join('\n'));
  assert.deepEqual(lastOutput<unknown>(), { ok: true, provided: 'proposal' });

  assert.equal(main(['tick', workflow], t.io), 0, t.err.join('\n'));
  const planner = lastOutput<{ orders: Array<{ run: string }> }>().orders[0]!;
  assert.equal(main(['green', workflow, planner.run, 'plan', '--value', '{"plan":"v1"}'], t.io), 0, t.err.join('\n'));
  assert.equal(main(['close', workflow, planner.run], t.io), 0, t.err.join('\n'));

  assert.equal(await mainAsync(['reject', workflow, 'plan', '--by', 'builder', '--text', 'needs rework'], t.io), 0, t.err.join('\n'));
  assert.deepEqual(lastOutput<unknown>(), { ok: true, action: 'reject', path: 'plan', outcome: 'rejected' });
  assert.equal(networkCalls, 0);
});
