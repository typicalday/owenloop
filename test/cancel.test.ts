/**
 * Public remote `owenloop cancel` command. Hermetic: all credentials live in a
 * fake keychain and every hub request uses the injected route table.
 *
 * The behaviours pinned here are the ones a caller can be hurt by. The
 * already-terminal no-op exiting 0 is the load-bearing one: a stuck run is
 * routinely cancelled twice (once by a script, once by a human who did not see
 * the first), and a second cancel that exited non-zero would read as "the
 * cancel failed" and invite a pointless escalation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainAsync } from '../src/cli.ts';
import { hubBindingPath, writeHubBinding } from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { kcHuman, makeIo, routedFetch } from './hubkit.ts';

const ORIGIN = 'http://127.0.0.1:9';
const WORKFLOW = 'wf_stuck';
const OAUTH_CRED: Credential = {
  kind: 'oauth',
  accessToken: 'mcpat_cancel_fixture',
  refreshToken: 'rt_cancel_fixture',
  expiresAt: Date.now() + 3_600_000,
  clientId: 'client_cancel_fixture',
};

function bind(t: ReturnType<typeof makeIo>): void {
  t.store.set(kcHuman(ORIGIN), JSON.stringify(OAUTH_CRED));
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
}

test('cancel: happy path posts the workflow and reason with the human credential', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/cancel_run': () => ({
      status: 200,
      json: {
        text: `Workflow ${WORKFLOW} cancelled.`,
        workflow: WORKFLOW,
        cancelled: true,
        closedRuns: ['run_a', 'run_b'],
      },
    }),
  });
  // The ambient OWENLOOP_HUB names production on this machine. The project
  // binding must win, or a cancel typed against staging would land on prod.
  const t = makeIo({ fetch, env: { OWENLOOP_HUB: 'https://api.owenloop.com' } });
  bind(t);

  const code = await mainAsync(['cancel', WORKFLOW, '--reason', 'worktree deleted'], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${ORIGIN}/api/cancel_run`, 'the project binding wins over ambient OWENLOOP_HUB');
  assert.equal(calls[0]!.authorization, `Bearer ${OAUTH_CRED.accessToken}`);
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), {
    workflow: WORKFLOW,
    reason: 'worktree deleted',
  });
  assert.deepEqual(JSON.parse(t.out.join('\n')), {
    ok: true,
    hub: ORIGIN,
    workflow: WORKFLOW,
    cancelled: true,
    status: 'cancelled',
    closedRuns: ['run_a', 'run_b'],
    reason: 'worktree deleted',
  });
});

test('cancel: omitting --reason sends no reason key at all', async () => {
  const { fetch, calls } = routedFetch({
    'POST /api/cancel_run': () => ({
      status: 200,
      json: { text: 'ok', workflow: WORKFLOW, cancelled: true, closedRuns: [] },
    }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['cancel', WORKFLOW], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  // Omitted means omitted — not a `reason: null` the hub would store verbatim.
  assert.deepEqual(JSON.parse(calls[0]!.body ?? '{}'), { workflow: WORKFLOW });
  assert.equal('reason' in JSON.parse(t.out.join('\n')), false);
});

test('cancel: an already-terminal instance is a no-op that still exits 0', async () => {
  const { fetch } = routedFetch({
    'POST /api/cancel_run': () => ({
      status: 200,
      json: {
        text: `Workflow ${WORKFLOW} is already done — nothing to cancel.`,
        workflow: WORKFLOW,
        cancelled: false,
        status: 'done',
      },
    }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['cancel', WORKFLOW], t.io);

  assert.equal(code, 0, 'a repeated cancel is success, not failure');
  const printed = JSON.parse(t.out.join('\n')) as Record<string, unknown>;
  assert.equal(printed.cancelled, false);
  // The hub reports the state it FOUND; we must not overwrite it with the
  // 'cancelled' we would have set.
  assert.equal(printed.status, 'done');
  assert.equal('closedRuns' in printed, false, 'nothing was closed, so no closedRuns key');
});

test('cancel: missing or empty --reason fails before credential and network access', async () => {
  const cases = [
    { argv: ['cancel', WORKFLOW, '--reason'], error: /missing value for --reason/u },
    { argv: ['cancel', WORKFLOW, '--reason='], error: /invalid empty value for --reason/u },
  ] as const;

  for (const fixture of cases) {
    let networkCalls = 0;
    const fetch = (() => {
      networkCalls += 1;
      throw new Error('network must not be reached');
    }) as unknown as typeof globalThis.fetch;
    const t = makeIo({ fetch });
    bind(t);

    const code = await mainAsync([...fixture.argv], t.io);

    assert.equal(code, 1, `${fixture.argv.join(' ')} must be a usage error`);
    assert.match(t.err.join('\n'), fixture.error);
    assert.equal(networkCalls, 0);
  }
});

test('cancel: a missing workflow argument is a usage error', async () => {
  const t = makeIo({});
  bind(t);
  const code = await mainAsync(['cancel'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /missing required argument: workflow/u);
});

test('cancel: no human credential exits 3 and names the login command', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  // Bind the project but store no credential.
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });

  const code = await mainAsync(['cancel', WORKFLOW], t.io);

  assert.equal(code, 3);
  assert.match(t.err.join('\n'), /no human credential/u);
  assert.match(t.err.join('\n'), /owenloop login --hub/u);
  assert.equal(calls.length, 0);
});

test('cancel: the hub refusal message is surfaced verbatim', async () => {
  const { fetch } = routedFetch({
    'POST /api/cancel_run': () => ({
      status: 403,
      json: { error: 'forbidden', message: 'cancel_run requires a human role' },
    }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['cancel', WORKFLOW], t.io);

  assert.equal(code, 1);
  // An agent credential can never cancel; the operator needs to read WHY
  // rather than a bare HTTP 403.
  assert.match(t.err.join('\n'), /cancel_run requires a human role/u);
});

test('cancel: a success body without a cancelled flag is refused, not assumed', async () => {
  const { fetch } = routedFetch({
    'POST /api/cancel_run': () => ({ status: 200, json: { text: 'ok', workflow: WORKFLOW } }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['cancel', WORKFLOW], t.io);

  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /missing cancelled flag/u);
});

test('cancel: --hub must agree with the project binding', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['cancel', WORKFLOW, '--hub', 'http://127.0.0.1:10'], t.io);

  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /bound to http:\/\/127\.0\.0\.1:9/u);
  assert.equal(calls.length, 0, 'a mismatched hub is refused before any request');
});
