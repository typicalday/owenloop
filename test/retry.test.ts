/**
 * Remote and local retry coverage. The remote path is hermetic: credentials
 * live in the fake keychain and fetch is a route table. The local round trip
 * proves retry --text actually releases an ask and carries the answer forward.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, mainAsync } from '../src/cli.ts';
import { hubBindingPath, writeHubBinding } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { kcHuman, makeIo, routedFetch } from './hubkit.ts';

const ORIGIN = 'http://127.0.0.1:9';
const WORKFLOW = 'wf_bbbbbbbbbbbbbbbbbbbbbbbb';
const OAUTH_CRED: Credential = {
  kind: 'oauth',
  accessToken: 'mcpat_retry_fixture',
  refreshToken: 'rt_retry_fixture',
  expiresAt: Date.now() + 3_600_000,
  clientId: 'client_retry_fixture',
};
const EXAMPLES = new URL('../examples/workflows', import.meta.url).pathname;

function bind(t: ReturnType<typeof makeIo>): void {
  t.store.set(kcHuman(ORIGIN), JSON.stringify(OAUTH_CRED));
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
}

test('retry --hub posts text with the human credential and prints a stable receipt', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/retry_artifact': () => ({ status: 200, json: { ok: true, unexpected: 'ignored' } }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['retry', WORKFLOW, 'pr', '--hub', ORIGIN, '--text', 'use the new fixture'], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${ORIGIN}/api/retry_artifact`);
  assert.equal(calls[0]!.authorization, `Bearer ${OAUTH_CRED.accessToken}`);
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), {
    workflow: WORKFLOW,
    path: 'pr',
    text: 'use the new fixture',
  });
  assert.deepEqual(JSON.parse(t.out.join('\n')), {
    ok: true,
    action: 'retry',
    path: 'pr',
    workflow: WORKFLOW,
    hub: ORIGIN,
  });
});

test('retry --hub omits text from the request body when it is absent', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/retry_artifact': () => ({ status: 200, json: {} }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['retry', WORKFLOW, 'pr', '--hub', ORIGIN], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), { workflow: WORKFLOW, path: 'pr' });
});

test('retry --hub refuses --by before using credentials or the network', async () => {
  let networkCalls = 0;
  const fetch = (() => {
    networkCalls += 1;
    throw new Error('network must not be reached');
  }) as unknown as typeof globalThis.fetch;
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['retry', WORKFLOW, 'pr', '--hub', ORIGIN, '--by', 'reviewer'], t.io);

  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /--by cannot be combined with --hub/u);
  assert.equal(networkCalls, 0);
});

test('retry --hub rejects a malformed workflow id before credentials or fetch', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/retry_artifact': () => ({ status: 200, json: {} }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const workflow = 'wf_bad';
  const code = await mainAsync(['retry', workflow, 'pr', '--hub', ORIGIN, '--text', 'retry this'], t.io);

  assert.equal(code, 1);
  assert.equal(
    t.err.join('\n'),
    `error: invalid workflow id '${workflow}': expected wf_ followed by 24 lowercase hexadecimal characters`,
  );
  assert.deepEqual(t.out, []);
  assert.equal(calls.length, 0);
});

test('local retry answers ask on the reason thread without fetching', async () => {
  let networkCalls = 0;
  const fetch = (() => {
    networkCalls += 1;
    throw new Error('local retry must not fetch');
  }) as unknown as typeof globalThis.fetch;
  const t = makeIo({ fetch, env: { OWENLOOP_DEFS: EXAMPLES } });
  const lastOutput = <T>(): T => JSON.parse(t.out[t.out.length - 1]!) as T;

  assert.equal(main(['create', 'delivery', '--provide', 'proposal={"text":"ship it"}'], t.io), 0, t.err.join('\n'));
  const workflow = lastOutput<{ workflow: string }>().workflow;
  assert.equal(main(['tick', workflow], t.io), 0, t.err.join('\n'));
  const firstOrder = lastOutput<{ orders: Array<{ run: string }> }>().orders[0]!;

  assert.equal(main(['ask', workflow, 'plan', 'which repository?', '--by', 'planner'], t.io), 0, t.err.join('\n'));
  assert.equal(main(['close', workflow, firstOrder.run, '--outcome', 'no_work'], t.io), 0, t.err.join('\n'));
  assert.equal(main(['status', workflow], t.io), 0, t.err.join('\n'));
  const held = lastOutput<{ debts: Array<{ path: string; stalled: boolean; question?: string }> }>().debts.find((d) => d.path === 'plan')!;
  assert.equal(held.stalled, true);
  assert.equal(held.question, 'which repository?');

  assert.equal(await mainAsync(['retry', workflow, 'plan', '--text', 'the owenloop repository'], t.io), 0, t.err.join('\n'));
  assert.equal(networkCalls, 0);

  assert.equal(main(['tick', workflow], t.io), 0, t.err.join('\n'));
  const nextOrder = lastOutput<{ orders: Array<{ step: string; owes: Array<{ path: string; reasons: Array<{ text: string }> }> }> }>()
    .orders.find((order) => order.step === 'planner')!;
  const plan = nextOrder.owes.find((owed) => owed.path === 'plan')!;
  assert.ok(plan.reasons.some((reason) => reason.text === 'the owenloop repository'));
});
