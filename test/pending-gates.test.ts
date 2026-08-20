/** Hermetic coverage for the hub-only pending-gates command. */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainAsync } from '../src/cli.ts';
import { hubBindingPath, writeHubBinding } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { kcHuman, makeIo, routedFetch } from './hubkit.ts';

const ORIGIN = 'http://127.0.0.1:9';
const OAUTH_CRED: Credential = {
  kind: 'oauth',
  accessToken: 'mcpat_pending_gates_fixture',
  refreshToken: 'rt_pending_gates_fixture',
  expiresAt: Date.now() + 3_600_000,
  clientId: 'client_pending_gates_fixture',
};

function bind(t: ReturnType<typeof makeIo>): void {
  t.store.set(kcHuman(ORIGIN), JSON.stringify(OAUTH_CRED));
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
}

test('pending-gates --hub posts an empty body with the human credential and prints the hub body unchanged', async () => {
  const body = { gates: [{ workflow: 'wf_1', path: 'proposal', question: 'Which target?' }] };
  const { fetch, calls } = routedFetch({
    'POST /api/pending_gates': () => ({ status: 200, json: body }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['pending-gates', '--hub', ORIGIN], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${ORIGIN}/api/pending_gates`);
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.authorization, `Bearer ${OAUTH_CRED.accessToken}`);
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), {});
  assert.equal(t.out.join('\n'), JSON.stringify(body, null, 2));
});

test('pending-gates without --hub fails before local state or network access', async () => {
  let networkCalls = 0;
  const fetch = (() => {
    networkCalls += 1;
    throw new Error('network must not be reached');
  }) as unknown as typeof globalThis.fetch;
  const t = makeIo({ fetch });

  const code = await mainAsync(['pending-gates'], t.io);

  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /no local-engine equivalent/u);
  assert.match(t.err.join('\n'), /--hub <url>/u);
  assert.equal(networkCalls, 0);
  assert.equal(existsSync(join(t.cwd, '.owenloop', 'state.db')), false);
});

test('pending-gates rejects a valueless --hub and extra positional arguments before credentials or network access', async () => {
  let networkCalls = 0;
  const fetch = (() => {
    networkCalls += 1;
    throw new Error('network must not be reached');
  }) as unknown as typeof globalThis.fetch;
  const t = makeIo({ fetch });

  assert.equal(await mainAsync(['pending-gates', '--hub'], t.io), 1);
  assert.match(t.err.join('\n'), /missing value for --hub/u);
  assert.equal(await mainAsync(['pending-gates', 'unexpected', '--hub', ORIGIN], t.io), 1);
  assert.match(t.err.join('\n'), /invalid pending-gates arguments/u);
  assert.equal(networkCalls, 0);
});

test('pending-gates surfaces a hub message and rejects malformed JSON responses', async () => {
  {
    const { fetch } = routedFetch({
      'POST /api/pending_gates': () => ({ status: 403, json: { message: 'not allowed to view gates' } }),
    });
    const t = makeIo({ fetch });
    bind(t);
    assert.equal(await mainAsync(['pending-gates', '--hub', ORIGIN], t.io), 1);
    assert.match(t.err.join('\n'), /not allowed to view gates/u);
  }

  {
    const { fetch } = routedFetch({
      'POST /api/pending_gates': () => ({ status: 200, raw: '{invalid json' }),
    });
    const t = makeIo({ fetch });
    bind(t);
    assert.equal(await mainAsync(['pending-gates', '--hub', ORIGIN], t.io), 1);
    assert.match(t.err.join('\n'), /pending_gates: malformed success response/u);
  }
});
