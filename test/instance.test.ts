/**
 * Public remote `owenloop instance show` command. Hermetic: all credentials live in
 * a fake keychain and every hub request uses the injected route table.
 *
 * The behaviours pinned here are the ones an operator diagnosing a stuck run is
 * hurt by getting wrong. The load-bearing pair is `defDrift` and
 * `waitingOnCapabilities`: those two fields are the difference between "the run
 * is stuck and I have no idea why" and the two actual answers — the instance is
 * pinned to a superseded def, or a step's capability has no crew bound. Both
 * look identical from the outside (nothing happens), so neither may be dropped,
 * defaulted, or silently coerced.
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
  accessToken: 'mcpat_instance_fixture',
  refreshToken: 'rt_instance_fixture',
  expiresAt: Date.now() + 3_600_000,
  clientId: 'client_instance_fixture',
};

/** A mid-flight instance: one owed input, one blocked step, one run in flight. */
const STATUS = {
  text: `Workflow ${WORKFLOW} is not done. Owed/blocked: verdict (any). 0 step(s) eligible next.`,
  done: false,
  debts: [{ path: 'verdict', acceptance: 'any', stalled: false }],
  eligible: [],
  blocked: [{ step: 'merger', missing: ['verdict'] }],
  inFlight: [{ step: 'reviewer', run: 'run_abc' }],
  defDrift: false,
};

function bind(t: ReturnType<typeof makeIo>): void {
  t.store.set(kcHuman(ORIGIN), JSON.stringify(OAUTH_CRED));
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });
}

test('instance show: GETs the status route and prints every diagnostic field', async () => {
  const { fetch, calls } = routedFetch({
    [`GET /api/status/${WORKFLOW}`]: () => ({ status: 200, json: STATUS }),
  });
  // The ambient OWENLOOP_HUB names production on this machine. The project
  // binding must win, or a read typed against staging would hit prod.
  const t = makeIo({ fetch, env: { OWENLOOP_HUB: 'https://api.owenloop.com' } });
  bind(t);

  const code = await mainAsync(['instance', 'show', WORKFLOW], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(calls[0]!.url, `${ORIGIN}/api/status/${WORKFLOW}`, 'the project binding wins over ambient OWENLOOP_HUB');
  assert.equal(calls[0]!.authorization, `Bearer ${OAUTH_CRED.accessToken}`);
  assert.deepEqual(JSON.parse(t.out.join('\n')), {
    ok: true,
    hub: ORIGIN,
    workflow: WORKFLOW,
    done: false,
    debts: STATUS.debts,
    eligible: [],
    blocked: STATUS.blocked,
    inFlight: STATUS.inFlight,
    defDrift: false,
  });
});

/**
 * The two "why is nothing happening" answers. A pinned instance never picks up
 * a republished def, and a capability with no crew bound is never offered to
 * anyone — from the outside both are indistinguishable from an idle shift, so
 * the command must surface them rather than let the operator guess.
 */
test('instance show: surfaces def drift and unbound capabilities verbatim', async () => {
  const waiting = [{ step: 'merger', capabilities: ['utility:standard'] }];
  const { fetch } = routedFetch({
    [`GET /api/status/${WORKFLOW}`]: () => ({
      status: 200,
      json: { ...STATUS, defDrift: true, waitingOnCapabilities: waiting },
    }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['instance', 'show', WORKFLOW], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  const printed = JSON.parse(t.out.join('\n')) as Record<string, unknown>;
  assert.equal(printed.defDrift, true);
  assert.deepEqual(printed.waitingOnCapabilities, waiting);
});

/**
 * `getStatus` OMITS `waitingOnCapabilities` when nothing is parked (its own
 * comment says so explicitly). Printing `[]` in that case would read as "the
 * hub answered the question and the answer is none", which is the same shape a
 * future hub bug returning an empty list would produce. Absent means absent.
 */
test('instance show: omits waitingOnCapabilities entirely when the hub omits it', async () => {
  const { fetch } = routedFetch({
    [`GET /api/status/${WORKFLOW}`]: () => ({ status: 200, json: STATUS }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['instance', 'show', WORKFLOW], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.equal('waitingOnCapabilities' in JSON.parse(t.out.join('\n')), false);
});

test('instance show: a done instance reports done true', async () => {
  const { fetch } = routedFetch({
    [`GET /api/status/${WORKFLOW}`]: () => ({
      status: 200,
      json: { text: 'done', done: true, debts: [], eligible: [], blocked: [], inFlight: [], defDrift: false },
    }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['instance', 'show', WORKFLOW], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(JSON.parse(t.out.join('\n')).done, true);
});

/**
 * A workflow id is interpolated into the URL path. If it were not encoded, an id
 * containing a slash would address a different route entirely and the command
 * would report another instance's state as if it were this one.
 */
test('instance show: the workflow id is percent-encoded into the path', async () => {
  const { fetch, calls } = routedFetch({
    'GET /api/status/wf%2Fodd': () => ({
      status: 200,
      json: { text: 'x', done: false, debts: [], eligible: [], blocked: [], inFlight: [], defDrift: false },
    }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['instance', 'show', 'wf/odd'], t.io);

  assert.equal(code, 0, t.err.join('\n'));
  assert.equal(calls[0]!.url, `${ORIGIN}/api/status/wf%2Fodd`);
});

test('instance show: an unknown or missing subcommand is a usage error', async () => {
  for (const argv of [['instance'], ['instance', 'list'], ['instance', 'bogus', WORKFLOW]]) {
    const { fetch, calls } = routedFetch({});
    const t = makeIo({ fetch });
    bind(t);

    const code = await mainAsync([...argv], t.io);

    assert.equal(code, 1, argv.join(' '));
    assert.match(t.err.join('\n'), /unknown instance subcommand/u);
    // `instance list` is not built yet — it must fail as an unknown subcommand
    // rather than quietly doing something else.
    assert.equal(calls.length, 0, `${argv.join(' ')} must not reach the network`);
  }
});

test('instance show: a missing workflow argument is a usage error', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['instance', 'show'], t.io);

  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /missing required argument: workflow/u);
  assert.equal(calls.length, 0);
});

test('instance show: no human credential exits 3 and names the login command', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  writeHubBinding(hubBindingPath(t.cwd), { version: 1, hub: ORIGIN });

  const code = await mainAsync(['instance', 'show', WORKFLOW], t.io);

  assert.equal(code, 3);
  assert.match(t.err.join('\n'), /no human credential/u);
  assert.match(t.err.join('\n'), /owenloop login --hub/u);
  assert.equal(calls.length, 0);
});

test('instance show: an unknown workflow surfaces the hub message verbatim', async () => {
  const { fetch } = routedFetch({
    [`GET /api/status/${WORKFLOW}`]: () => ({
      status: 404,
      json: { error: 'not_found', message: `no instance ${WORKFLOW}` },
    }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['instance', 'show', WORKFLOW], t.io);

  assert.equal(code, 1);
  assert.match(t.err.join('\n'), new RegExp(`no instance ${WORKFLOW}`, 'u'));
});

/**
 * `done` is what a script branches on. A body without it is not a status, and
 * defaulting the missing flag to `false` would report a finished run as still
 * running — the exact wrong answer for the operator deciding whether to cancel.
 */
test('instance show: a success body without a done flag is refused, not defaulted', async () => {
  const { fetch } = routedFetch({
    [`GET /api/status/${WORKFLOW}`]: () => ({ status: 200, json: { text: 'ok', debts: [] } }),
  });
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['instance', 'show', WORKFLOW], t.io);

  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /missing done flag/u);
  assert.deepEqual(t.out, []);
});

test('instance show: --hub must agree with the project binding', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  bind(t);

  const code = await mainAsync(['instance', 'show', WORKFLOW, '--hub', 'http://127.0.0.1:10'], t.io);

  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /bound to http:\/\/127\.0\.0\.1:9/u);
  assert.equal(calls.length, 0, 'a mismatched hub is refused before any request');
});
