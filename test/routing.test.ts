/**
 * `owenloop routing alerts|show|rule list|rule add|rule rm` driven in-process
 * through `mainAsync`. The five hub endpoints (`GET /api/routing_alerts`,
 * `GET /api/run_routing/:wf`, `GET /api/capability_reroutes`,
 * `POST /api/add_capability_reroute`, `POST /api/remove_capability_reroute`) and
 * the OAuth refresh endpoints are canned `routedFetch`/`stallingFetch` routes —
 * no live hub is needed or contacted.
 *
 * Fully hermetic: every test materializes its own `$HOME`, cwd, env, fake
 * keychain and `fetch` via `makeIo`, so no ambient machine state and no ambient
 * `OWENLOOP_*` variable is ever read.
 *
 * No token-leak assertion here (unlike `agent.test.ts`): no endpoint in this
 * feature returns a secret — routing state names workflows, capabilities, steps
 * and crews, and this command writes nothing locally.
 *
 * The invariants these tests pin, beyond the obvious happy paths:
 *   - the array keys are `alerts` and `reroutes` — the same class of trap that
 *     shipped `capability list` broken twice (`bindings`, not `routes`);
 *   - WIRE ORDER IS SEMANTIC and is never re-sorted: `routing alerts` is
 *     newest-first org-wide and oldest-first when `--workflow` scopes it, and
 *     `routing rule list` is the order the hub TRIES the substitutions in;
 *   - an alert's `modifier`/`step`/`detail` are legitimately `null` and must
 *     survive to stdout rather than being dropped or rejected;
 *   - `routing show` OMITS the `modifier` key for an unmodified run — it never
 *     prints `null` or `''`, because "a modifier named nothing" is not a state;
 *   - `rule add` is idempotent per `(capability, target)` pair (`alreadyPresent`
 *     is a normal 200, silent on stderr) while `rule rm` is tolerant of a rule
 *     that was never there (`removed: false` is exit 0 plus a stderr line);
 *   - `remainingTargets: []` is the HOLDS signal and earns a stderr warning, and
 *     an ABSENT `remainingTargets` is an error rather than a silent `[]`;
 *   - stdout is always exactly one JSON document, so `| jq` works.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mainAsync } from '../src/cli.ts';
import {
  asCapabilityRerouteRemoved,
  asRoutingAlerts,
  asRunRouting,
  credentialFilePath,
  writeCredentialFile,
} from '../src/hub.ts';
import type { Credential } from '../src/hub.ts';
import { kcHuman, makeIo, OAUTH_METADATA, routedFetch, stallingFetch } from './hubkit.ts';
import type { HubIo, RouteHandler } from './hubkit.ts';

const HUB = 'http://127.0.0.1:9';
const ORIGIN = 'http://127.0.0.1:9';
const WORKFLOW_A = 'wf_aaaaaaaaaaaaaaaaaaaaaaaa';
const WORKFLOW_B = 'wf_bbbbbbbbbbbbbbbbbbbbbbbb';
const WORKFLOW_C = 'wf_cccccccccccccccccccccccc';
const MISSING_WORKFLOW = 'wf_ffffffffffffffffffffffff';

/** Seed a fresh (non-expiring) human oauth credential into the fake keychain. */
function seedHumanOauth(t: HubIo, over: Partial<Extract<Credential, { kind: 'oauth' }>> = {}): void {
  t.store.set(
    kcHuman(ORIGIN),
    JSON.stringify({
      kind: 'oauth',
      accessToken: 'mcpat_x',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
      clientId: 'c',
      ...over,
    }),
  );
}

// ---- fixtures ---------------------------------------------------------------

/**
 * A `binding-gap` alert — the hub HELD an offer because the compound capability
 * `build:express` had no live crew binding. `capability` is always the COMPOUND,
 * and `detail` is a JSON metadata string this CLI forwards but never parses.
 */
const ALERT_GAP = {
  id: 'ral_1',
  at: 1786139457984,
  workflow: WORKFLOW_A,
  kind: 'binding-gap',
  capability: 'build:express',
  modifier: 'express',
  step: 'builder',
  detail: '{"waited":0}',
};
/** A `reroute` alert on a different run — the newer of the two, org-wide. */
const ALERT_REROUTE = {
  id: 'ral_2',
  at: 1786139999999,
  workflow: WORKFLOW_B,
  kind: 'reroute',
  capability: 'build:express',
  modifier: 'express',
  step: 'builder',
  detail: '{"target":"build:standard"}',
};
/**
 * An alert whose three nullable fields are ALL `null` — the hub's own answer for
 * an org-level event carrying no step and no modifier, not a defect.
 */
const ALERT_NULLS = {
  id: 'ral_3',
  at: 1786140000000,
  workflow: WORKFLOW_C,
  kind: 'wait-start',
  capability: 'build',
  modifier: null,
  step: null,
  detail: null,
};

/** A realistic 200 `routing_alerts` body — `{ text, alerts }`. */
function alertsOk(rows: unknown[] = [ALERT_REROUTE, ALERT_GAP]): RouteHandler {
  return () => ({ status: 200, json: { text: `${rows.length} routing alert(s).`, alerts: rows } });
}

/**
 * A realistic 200 `run_routing` body. `over` patches the body's own fields;
 * note that `modifier` is ABSENT by default, which is what an unmodified run
 * looks like on the wire.
 */
function showOk(over: Record<string, unknown> = {}): RouteHandler {
  return () => ({
    status: 200,
    json: {
      text: `Routing for ${WORKFLOW_A}.`,
      workflow: WORKFLOW_A,
      defName: 'delivery',
      waitPolicy: { wait: 'forever' },
      alerts: [ALERT_GAP],
      resolutionReports: [{ step: 'builder', match: 'capability-route', crew: 'build-fleet' }],
      escalations: [],
      ...over,
    },
  });
}

/**
 * Reroute rules for TWO source capabilities, deliberately NOT in
 * capability-alphabetical order — this is the order the hub tries them
 * (`capability`, then `position`, then `target`), and it must survive verbatim.
 */
const RULE_EXPRESS_1 = { capability: 'build:express', target: 'build:standard', position: 0, createdAt: 10 };
const RULE_EXPRESS_2 = { capability: 'build:express', target: 'build', position: 1, createdAt: 11 };
const RULE_AUDIT = { capability: 'audit:deep', target: 'audit', position: 0, createdAt: 12 };

/** A realistic 200 `capability_reroutes` body — `{ text, reroutes }`. */
function rulesOk(rows: unknown[] = [RULE_EXPRESS_1, RULE_EXPRESS_2, RULE_AUDIT]): RouteHandler {
  return () => ({ status: 200, json: { text: `${rows.length} reroute rule(s).`, reroutes: rows } });
}

/**
 * A realistic 200 `add_capability_reroute` body — the row is NESTED under
 * `reroute` while `alreadyPresent`/`ruleCount` sit at the body's top level.
 * `over` patches the nested row; `top` patches the body's own fields.
 */
function addRuleOk(over: Record<string, unknown> = {}, top: Record<string, unknown> = {}): RouteHandler {
  return () => ({
    status: 200,
    json: {
      text: "'build:express' now reroutes to 'build:standard' (2 rule(s)).",
      reroute: { ...RULE_EXPRESS_1, ...over },
      alreadyPresent: false,
      ruleCount: 2,
      ...top,
    },
  });
}

/** A realistic 200 `remove_capability_reroute` body, leaving one other target. */
function rmRuleOk(over: Record<string, unknown> = {}): RouteHandler {
  return () => ({
    status: 200,
    json: {
      text: "Removed the 'build:express' → 'build:standard' reroute.",
      capability: 'build:express',
      target: 'build:standard',
      removed: true,
      remainingTargets: ['build'],
      ...over,
    },
  });
}

/** Parse the single JSON document the command wrote to stdout. */
function stdoutJson(t: HubIo): Record<string, unknown> {
  return JSON.parse(t.out.join('\n')) as Record<string, unknown>;
}

// ---- routing alerts ---------------------------------------------------------

test('routing alerts: GETs routing_alerts with NO query and prints the rows in wire order', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/routing_alerts': alertsOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'alerts', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.pathname, '/api/routing_alerts');
  assert.equal(req.method, 'GET');
  assert.equal(req.body, undefined, 'a GET carries no request body');
  assert.equal(req.authorization, 'Bearer mcpat_x');
  assert.equal(new URL(req.url).search, '', 'neither optional filter was asked for, so neither is sent');

  // Unscoped is the org-wide NEWEST-FIRST inbox. The fixture is in that order
  // and stdout must not reorder it.
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, alerts: [ALERT_REROUTE, ALERT_GAP] });
  assert.equal(stdoutJson(t).workflow, undefined, 'no filter was applied, so no workflow key is claimed');
  assert.equal(stdoutJson(t).text, undefined, 'no raw hub body spread onto stdout');
});

test('routing alerts: --workflow and --limit ride on the query string and the filter is echoed back', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/routing_alerts': alertsOk([ALERT_GAP]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'alerts', '--workflow', WORKFLOW_A, '--limit', '50', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  // `routedFetch` keys routes on METHOD + pathname only, so the query string is
  // asserted off the recorded url.
  assert.equal(new URL(calls[0]!.url).search, `?workflow=${WORKFLOW_A}&limit=50`);

  // Echoing the filter back is what lets a script tell a scoped OLDEST-FIRST
  // timeline from the unscoped newest-first inbox without re-reading argv.
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, workflow: WORKFLOW_A, alerts: [ALERT_GAP] });
});

test('routing alerts: an alert whose modifier/step/detail are NULL is printed, not dropped and not an error', async () => {
  const { fetch } = routedFetch({ 'GET /api/routing_alerts': alertsOk([ALERT_NULLS]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'alerts', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, alerts: [ALERT_NULLS] });
  const row = (stdoutJson(t).alerts as Record<string, unknown>[])[0]!;
  assert.equal(row.modifier, null);
  assert.equal(row.step, null);
  assert.equal(row.detail, null);
});

test('routing alerts: an org with ZERO alerts is exit 0 with alerts: [] — the desirable answer, not an error', async () => {
  const { fetch } = routedFetch({ 'GET /api/routing_alerts': alertsOk([]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'alerts', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, alerts: [] });
});

test('routing alerts: a malformed row is exit 1, naming the INDEX and field only', async () => {
  const { fetch } = routedFetch({
    'GET /api/routing_alerts': alertsOk([ALERT_GAP, { ...ALERT_REROUTE, capability: '' }]),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'alerts', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /routing_alerts: malformed response — alerts\[1\] missing non-empty string capability/);
  assert.deepEqual(t.out, []);
});

test('routing alerts: a row whose step is a non-string, non-null value is exit 1 without echoing the value', async () => {
  const { fetch } = routedFetch({ 'GET /api/routing_alerts': alertsOk([{ ...ALERT_GAP, step: 7 }]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'alerts', '--hub', HUB], t.io);
  assert.equal(code, 1);
  const err = t.err.join('\n');
  assert.match(err, /routing_alerts: malformed response — alerts\[0\] step must be a non-empty string or null/);
  assert.doesNotMatch(err, /build:express/, 'no other body value leaks into the message either');
});

test('routing alerts: a 200 with no alerts array is exit 1', async () => {
  const { fetch } = routedFetch({ 'GET /api/routing_alerts': () => ({ status: 200, json: { text: 'ok' } }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'alerts', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /routing_alerts: malformed response — expected an `alerts` array/);
});

test('routing alerts: a 200 that is NOT valid JSON is exit 1 with a FIXED message, never the parse error', async () => {
  const { fetch } = routedFetch({ 'GET /api/routing_alerts': () => ({ status: 200, raw: 'not json at all' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'alerts', '--hub', HUB], t.io);
  assert.equal(code, 1);
  const err = t.err.join('\n');
  assert.match(err, /routing_alerts: malformed response — body is not valid JSON/);
  assert.doesNotMatch(err, /Unexpected token/, 'the V8 parse-error snippet must never surface');
});

test('routing alerts: a non-numeric --limit is a client-side error with ZERO network calls', async () => {
  // Flag hygiene, not a copy of hub semantics: the hub silently DROPS a limit it
  // cannot use and applies its own default, which would report a page size the
  // operator never asked for.
  for (const argv of [
    ['routing', 'alerts', '--limit', 'abc'],
    ['routing', 'alerts', '--limit'], // bare flag — the parser records the string 'true'
  ]) {
    const { fetch, calls } = routedFetch({ 'GET /api/routing_alerts': alertsOk() });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 1, `argv ${JSON.stringify(argv)}`);
    assert.match(t.err.join('\n'), /invalid value for --limit/);
    assert.equal(calls.length, 0, `no network on a flag error: ${JSON.stringify(argv)}`);
  }
});

test('routing alerts: an EMPTY --workflow is a usage error, never a silently unscoped listing', async () => {
  // The hub treats `workflow=` as absent and answers org-wide, so accepting an
  // empty value would print `"workflow": ""` over an unscoped result set —
  // stdout claiming a filter that was never applied.
  const { fetch, calls } = routedFetch({ 'GET /api/routing_alerts': alertsOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'alerts', '--workflow', '', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /invalid empty value for --workflow/);
  assert.equal(calls.length, 0);
});

test('routing alerts: a VALUELESS --workflow is a usage error, not a filter on the literal string "true"', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/routing_alerts': alertsOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'alerts', '--hub', HUB, '--workflow'], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /missing value for --workflow/);
  assert.equal(calls.length, 0);
});

// ---- routing show -----------------------------------------------------------

test('routing show: GETs run_routing/<wf> and prints the whitelisted routing document', async () => {
  const { fetch, calls } = routedFetch({ [`GET /api/run_routing/${WORKFLOW_A}`]: showOk({ modifier: 'express' }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'show', WORKFLOW_A, '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.pathname, `/api/run_routing/${WORKFLOW_A}`);
  assert.equal(calls[0]!.method, 'GET');

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    workflow: WORKFLOW_A,
    defName: 'delivery',
    modifier: 'express',
    waitPolicy: { wait: 'forever' },
    alerts: [ALERT_GAP],
    resolutionReports: [{ step: 'builder', match: 'capability-route', crew: 'build-fleet' }],
    escalations: [],
  });
  assert.equal(stdoutJson(t).text, undefined, 'no raw hub body spread onto stdout');
});

test('routing show: an UNMODIFIED run omits the modifier key entirely — never null, never empty string', async () => {
  const { fetch } = routedFetch({ [`GET /api/run_routing/${WORKFLOW_A}`]: showOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'show', WORKFLOW_A, '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const out = stdoutJson(t);
  assert.equal('modifier' in out, false, 'the ABSENCE of the key is how stdout says "no modifier"');
  assert.equal(out.defName, 'delivery');
});

test('routing show: waitPolicy.then and unknown joined-row fields are forwarded VERBATIM', async () => {
  // `resolutionReports` and `escalations` belong to adjacent subsystems and are
  // object-checked, then passed through — an additive field there must widen what
  // this command prints rather than break it.
  const { fetch } = routedFetch({
    [`GET /api/run_routing/${WORKFLOW_A}`]: showOk({
      waitPolicy: { wait: '30m', then: 'fallback' },
      resolutionReports: [{ step: 'builder', match: 'reroute', somethingNew: { nested: true } }],
      escalations: [{ step: 'builder', at: 5, from: 'build:express', to: 'build' }],
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'show', WORKFLOW_A, '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const out = stdoutJson(t);
  assert.deepEqual(out.waitPolicy, { wait: '30m', then: 'fallback' });
  assert.deepEqual(out.resolutionReports, [{ step: 'builder', match: 'reroute', somethingNew: { nested: true } }]);
  assert.deepEqual(out.escalations, [{ step: 'builder', at: 5, from: 'build:express', to: 'build' }]);
});

test('routing show: rejects a malformed workflow id before fetch', async () => {
  const { fetch, calls } = routedFetch({});
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const workflow = 'a/b';
  const code = await mainAsync(['routing', 'show', workflow, '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.equal(
    t.err.join('\n'),
    `error: invalid workflow id '${workflow}': expected wf_ followed by 24 lowercase hexadecimal characters`,
  );
  assert.deepEqual(t.out, []);
  assert.equal(calls.length, 0);
});

test('routing show: an unknown workflow surfaces the hub message verbatim, exit 1, empty stdout', async () => {
  // The hub verb throws an untyped error for a run this org does not own, and its
  // edge maps that to a 500 whose message is generic. This command prints
  // WHATEVER `message` the hub sends, so a future typed 404 needs no change here
  // — but today the honest expectation is the generic text below.
  const { fetch } = routedFetch({
    [`GET /api/run_routing/${MISSING_WORKFLOW}`]: () => ({
      status: 500,
      json: { error: 'internal_error', message: 'internal server error' },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'show', MISSING_WORKFLOW, '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /internal server error/);
  assert.deepEqual(t.out, [], 'nothing on stdout for a hub refusal');
});

test('routing show: a 403 (a run in another org) surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    [`GET /api/run_routing/${WORKFLOW_A}`]: () => ({ status: 403, json: { error: 'forbidden', message: 'not your org' } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'show', WORKFLOW_A, '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /not your org/);
});

test('routing show: each malformed 2xx is exit 1, naming the field or index only', async () => {
  for (const [patch, pattern] of [
    [{ defName: '' }, /run_routing: malformed success response — missing non-empty string defName/],
    [{ modifier: '' }, /run_routing: malformed success response — modifier must be a non-empty string when present/],
    [{ waitPolicy: 'forever' }, /run_routing: malformed success response — waitPolicy is not an object/],
    [{ waitPolicy: {} }, /run_routing: malformed success response — waitPolicy missing non-empty string wait/],
    [{ alerts: undefined }, /run_routing: malformed success response — missing array alerts/],
    [{ resolutionReports: undefined }, /run_routing: malformed success response — missing array resolutionReports/],
    [{ escalations: [7] }, /run_routing: malformed success response — escalations\[0\] is not an object/],
  ] as [Record<string, unknown>, RegExp][]) {
    // `undefined` in the patch object deletes the key from the canned body.
    const { fetch } = routedFetch({
      [`GET /api/run_routing/${WORKFLOW_A}`]: () => {
        const result = showOk(patch)({ url: new URL(HUB), body: undefined, method: 'GET', authorization: null });
        const json = { ...(result.json as Record<string, unknown>) };
        for (const [k, v] of Object.entries(patch)) if (v === undefined) delete json[k];
        return { status: 200, json };
      },
    });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync(['routing', 'show', WORKFLOW_A, '--hub', HUB], t.io);
    assert.equal(code, 1, `patch ${JSON.stringify(patch)}`);
    assert.match(t.err.join('\n'), pattern);
    assert.deepEqual(t.out, [], `nothing on stdout for ${JSON.stringify(patch)}`);
  }
});

// ---- routing rule list ------------------------------------------------------

test('routing rule list: GETs capability_reroutes and prints the guard-narrowed rows', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/capability_reroutes': rulesOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.pathname, '/api/capability_reroutes');
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(calls[0]!.body, undefined);

  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, reroutes: [RULE_EXPRESS_1, RULE_EXPRESS_2, RULE_AUDIT] });
});

test('routing rule list: WIRE ORDER is preserved — the array is the hub try-order, never re-sorted', async () => {
  // ORDER PIN. The fixture is deliberately NOT capability-alphabetical
  // (`build:express` rows come before `audit:deep`) and the two `build:express`
  // rows are in ascending `position`. Any client-side tidy-up would misreport
  // which substitution the hub attempts first.
  const { fetch } = routedFetch({ 'GET /api/capability_reroutes': rulesOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  const reroutes = stdoutJson(t).reroutes as Record<string, unknown>[];
  assert.deepEqual(
    reroutes.map((r) => `${String(r.capability)}→${String(r.target)}`),
    ['build:express→build:standard', 'build:express→build', 'audit:deep→audit'],
  );
  assert.deepEqual(
    reroutes.filter((r) => r.capability === 'build:express').map((r) => r.position),
    [0, 1],
    'a source capability’s rules stay in ascending position',
  );
});

test('routing rule list: an org with ZERO reroute rules is exit 0 with reroutes: []', async () => {
  const { fetch } = routedFetch({ 'GET /api/capability_reroutes': rulesOk([]) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'list', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), { ok: true, hub: ORIGIN, reroutes: [] });
});

test('routing rule list: a malformed row is exit 1, naming the INDEX and field only', async () => {
  const { fetch } = routedFetch({
    'GET /api/capability_reroutes': rulesOk([RULE_EXPRESS_1, { ...RULE_AUDIT, position: '0' }]),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /capability_reroutes: malformed response — reroutes\[1\] missing number position/);
  assert.deepEqual(t.out, []);
});

test('routing rule list: a 200 with no reroutes array is exit 1 — the array key is `reroutes`, not `bindings`', async () => {
  const { fetch } = routedFetch({
    'GET /api/capability_reroutes': () => ({ status: 200, json: { text: 'ok', bindings: [RULE_AUDIT] } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'list', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /capability_reroutes: malformed response — expected a `reroutes` array/);
});

// ---- routing rule add -------------------------------------------------------

test('routing rule add: a fresh add POSTs {capability, target} with NO position key and prints alreadyPresent: false', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/add_capability_reroute': addRuleOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'add', 'build:express', 'build:standard', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.equal(calls.length, 1);
  const req = calls[0]!;
  assert.equal(req.pathname, '/api/add_capability_reroute');
  assert.equal(req.method, 'POST');
  assert.equal(req.authorization, 'Bearer mcpat_x');
  // The OMITTED `position` key is what tells the hub to APPEND. Sending `null`
  // or `0` would each mean something else.
  assert.deepEqual(JSON.parse(req.body!), { capability: 'build:express', target: 'build:standard' });

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    capability: 'build:express',
    target: 'build:standard',
    position: 0,
    alreadyPresent: false,
    ruleCount: 2,
  });
  assert.equal(stdoutJson(t).createdAt, undefined, 'createdAt is validated on the wire, never printed here');
  assert.deepEqual(t.err, [], 'an add has no consequence to warn about — nothing on stderr');
});

test('routing rule add: --position rides on the request body as a JSON NUMBER', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/add_capability_reroute': addRuleOk({ position: 2 }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(
    ['routing', 'rule', 'add', 'build:express', 'build:standard', '--position', '2', '--hub', HUB],
    t.io,
  );
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(JSON.parse(calls[0]!.body!), { capability: 'build:express', target: 'build:standard', position: 2 });
  assert.equal(stdoutJson(t).position, 2);
});

test('routing rule add: a REPEAT add is a normal success — alreadyPresent: true, exit 0, NO stderr', async () => {
  // The write is idempotent per (capability, target) pair, so a repeat is a 200
  // no-op rather than an error, and `reroute.createdAt` echoes the ORIGINAL row.
  const { fetch } = routedFetch({
    'POST /api/add_capability_reroute': addRuleOk({ createdAt: 999 }, { alreadyPresent: true, ruleCount: 2 }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'add', 'build:express', 'build:standard', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    capability: 'build:express',
    target: 'build:standard',
    position: 0,
    alreadyPresent: true,
    ruleCount: 2,
  });
  assert.deepEqual(t.err, [], 'a repeat add is silent too');
});

test('routing rule add: stdout prints the SERVER-echoed capability/target/position, not argv', async () => {
  // Omitting `--position` APPENDS, so the rank printed here is routinely one the
  // operator never typed.
  const { fetch } = routedFetch({
    'POST /api/add_capability_reroute': addRuleOk({ capability: 'build:express', target: 'build', position: 7 }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'add', 'BUILD:express', 'build', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  const out = stdoutJson(t);
  assert.equal(out.capability, 'build:express', 'stdout tells the truth about what the hub stored');
  assert.equal(out.position, 7, 'the appended rank comes from the hub, not from argv');
});

test('routing rule add: a 400 capability_reroute_invalid surfaces the hub message verbatim, exit 1, empty stdout', async () => {
  // The identity rule is the hub's to enforce, and it is deliberately NOT
  // re-implemented client-side.
  const { fetch } = routedFetch({
    'POST /api/add_capability_reroute': () => ({
      status: 400,
      json: {
        error: 'capability_reroute_invalid',
        message: 'capability and target must differ — a capability cannot reroute to itself',
      },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'add', 'build:express', 'build:express', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /a capability cannot reroute to itself/);
  assert.deepEqual(t.out, [], 'nothing on stdout for a hub refusal');
});

test('routing rule add: a 403 (non-admin human) surfaces the hub message, exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/add_capability_reroute': () => ({ status: 403, json: { error: 'forbidden', message: 'admin role required' } }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'add', 'build:express', 'build', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /admin role required/);
});

test('routing rule add: each malformed 2xx is exit 1, naming the field only', async () => {
  for (const [route, pattern] of [
    [
      () => ({ status: 200, json: { text: 'ok', alreadyPresent: false, ruleCount: 1 } }),
      /add_capability_reroute: malformed success response — missing reroute/,
    ],
    [addRuleOk({}, { alreadyPresent: 'yes' }), /add_capability_reroute: malformed success response — missing boolean alreadyPresent/],
    [addRuleOk({}, { ruleCount: '2' }), /add_capability_reroute: malformed success response — missing number ruleCount/],
    [addRuleOk({ target: '' }), /add_capability_reroute: malformed success response — reroute missing non-empty string target/],
    [
      () => ({ status: 200, raw: '<html>gateway</html>' }),
      /add_capability_reroute: malformed success response — body is not valid JSON/,
    ],
  ] as [RouteHandler, RegExp][]) {
    const { fetch } = routedFetch({ 'POST /api/add_capability_reroute': route });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync(['routing', 'rule', 'add', 'build:express', 'build', '--hub', HUB], t.io);
    assert.equal(code, 1);
    assert.match(t.err.join('\n'), pattern);
    assert.deepEqual(t.out, []);
  }
});

// ---- routing rule rm --------------------------------------------------------

test('routing rule rm: POSTs remove_capability_reroute with {capability, target} and prints the full removal document', async () => {
  const { fetch, calls } = routedFetch({ 'POST /api/remove_capability_reroute': rmRuleOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'rm', 'build:express', 'build:standard', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.pathname, '/api/remove_capability_reroute');
  assert.deepEqual(JSON.parse(calls[0]!.body!), { capability: 'build:express', target: 'build:standard' });

  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    capability: 'build:express',
    target: 'build:standard',
    removed: true,
    remainingTargets: ['build'],
  });
  assert.ok(!t.err.join('\n').includes('HOLDS'), 'another substitution remains, so nothing holds');
});

test('routing rule rm: a rule that was never there is exit 0 with removed: false and a "had no reroute" stderr line', async () => {
  // The hub answers a tolerant 200, never a 404 — that is what makes `rule rm`
  // idempotent, and it is the deliberate asymmetry against `rule add`, which CAN
  // fail with a 400.
  const { fetch } = routedFetch({
    'POST /api/remove_capability_reroute': rmRuleOk({
      text: "'build:express' had no reroute to 'nope'.",
      target: 'nope',
      removed: false,
      remainingTargets: ['build:standard', 'build'],
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'rm', 'build:express', 'nope', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t), {
    ok: true,
    hub: ORIGIN,
    capability: 'build:express',
    target: 'nope',
    removed: false,
    remainingTargets: ['build:standard', 'build'],
  });
  assert.match(t.err.join('\n'), /build:express had no reroute to 'nope' — nothing was removed/);
  assert.ok(!t.err.join('\n').includes('HOLDS'), 'a no-op removal changed nothing');
});

test('routing rule rm: removing the LAST rule leaves remainingTargets: [] and warns that the capability now HOLDS', async () => {
  const { fetch } = routedFetch({ 'POST /api/remove_capability_reroute': rmRuleOk({ remainingTargets: [] }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'rm', 'build:express', 'build:standard', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.deepEqual(stdoutJson(t).remainingTargets, []);
  // stderr only, so `| jq` on stdout is unaffected.
  assert.match(t.err.join('\n'), /build:express: no reroute rules remain — it now HOLDS whenever it has no live crew binding/);
});

test('routing rule rm: a tolerant removal that ALSO leaves zero rules warns only about the no-op', async () => {
  const { fetch } = routedFetch({
    'POST /api/remove_capability_reroute': rmRuleOk({ removed: false, remainingTargets: [] }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'rm', 'build:express', 'build:standard', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));
  assert.match(t.err.join('\n'), /had no reroute/);
  assert.ok(!t.err.join('\n').includes('HOLDS'), 'this call removed nothing, so it changed no holding behavior');
});

test('routing rule rm: an ABSENT remainingTargets THROWS — it is deliberately not lenient', async () => {
  // Defaulting an absent `remainingTargets` to `[]` would assert "this capability
  // now HOLDS whenever it is unbound" — the alarming reading, and exactly the
  // signal an operator acts on — off a malformed body.
  const { fetch } = routedFetch({
    'POST /api/remove_capability_reroute': () => ({
      status: 200,
      json: { text: 'ok', capability: 'build:express', target: 'build:standard', removed: true },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'rm', 'build:express', 'build:standard', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_capability_reroute: malformed success response — missing array remainingTargets/);
  assert.deepEqual(t.out, [], 'nothing on stdout — the holds question is left unanswered, not guessed');
});

test('routing rule rm: a remainingTargets element that is not a non-empty string is exit 1, naming the INDEX', async () => {
  const { fetch } = routedFetch({ 'POST /api/remove_capability_reroute': rmRuleOk({ remainingTargets: ['build', ''] }) });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'rm', 'build:express', 'build:standard', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(
    t.err.join('\n'),
    /remove_capability_reroute: malformed success response — remainingTargets\[1\] is not a non-empty string/,
  );
});

test('routing rule rm: a 200 with no removed key at all is exit 1', async () => {
  const { fetch } = routedFetch({
    'POST /api/remove_capability_reroute': () => ({
      status: 200,
      json: { text: 'ok', capability: 'build:express', target: 'build', remainingTargets: [] },
    }),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'rule', 'rm', 'build:express', 'build', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /remove_capability_reroute: malformed success response — missing boolean removed/);
});

// ---- usage errors: zero network --------------------------------------------

test('routing: usage errors are exit 1 with ZERO network calls and name the usage forms', async () => {
  for (const argv of [
    ['routing'],
    ['routing', 'bogus'],
    ['routing', 'show'],
    ['routing', 'show', ''],
    ['routing', 'rule'],
    ['routing', 'rule', 'bogus'],
    ['routing', 'rule', 'add'],
    ['routing', 'rule', 'add', 'build:express'],
    ['routing', 'rule', 'rm'],
    // The missing `<target>`: without it, a capability-only `rm` would drop every
    // substitution the operator ever wrote for that source.
    ['routing', 'rule', 'rm', 'build:express'],
  ]) {
    const { fetch, calls } = routedFetch({
      'GET /api/routing_alerts': alertsOk(),
      'GET /api/capability_reroutes': rulesOk(),
      'POST /api/add_capability_reroute': addRuleOk(),
      'POST /api/remove_capability_reroute': rmRuleOk(),
    });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 1, `argv ${JSON.stringify(argv)}`);
    assert.match(t.err.join('\n'), /usage: owenloop routing alerts/, `usage forms for ${JSON.stringify(argv)}`);
    assert.equal(calls.length, 0, `no network on a usage error: ${JSON.stringify(argv)}`);
  }
});

test('routing: an unknown subcommand and an unknown rule sub-subcommand each name what was typed', async () => {
  const { fetch } = routedFetch({ 'GET /api/routing_alerts': alertsOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);
  assert.equal(await mainAsync(['routing', 'bogus', '--hub', HUB], t.io), 1);
  assert.match(t.err.join('\n'), /unknown routing subcommand 'bogus'/);

  const t2 = makeIo({ fetch });
  seedHumanOauth(t2);
  assert.equal(await mainAsync(['routing', 'rule', 'bogus', '--hub', HUB], t2.io), 1);
  assert.match(t2.err.join('\n'), /unknown routing rule subcommand 'bogus'/);
});

test('routing: a missing positional beats hub resolution — usage error (exit 1), not exit 2', async () => {
  // Multi-hub machine: if validation ran AFTER resolveAgentHub these would be a
  // confusing exit 2 about hubs rather than the real problem.
  for (const [argv, missing] of [
    [['routing', 'show'], '<workflow>'],
    [['routing', 'rule', 'add'], '<capability>'],
    [['routing', 'rule', 'add', 'build:express'], '<target>'],
    [['routing', 'rule', 'rm', 'build:express'], '<target>'],
  ] as [string[], string][]) {
    const { fetch, calls } = routedFetch({ 'GET /api/routing_alerts': alertsOk() });
    const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });
    writeCredentialFile(credentialFilePath(t.io.env), {
      version: 2,
      hubs: {
        'https://a.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_a' } },
        'https://b.example': { human: { kind: 'oauth-pasted', accessToken: 'mcpat_b' } },
      },
    });

    const code = await mainAsync(argv, t.io);
    assert.equal(code, 1, `the usage error wins for ${JSON.stringify(argv)}`);
    assert.match(t.err.join('\n'), new RegExp(`missing required argument: ${missing}`));
    assert.equal(calls.length, 0);
  }
});

test('routing alerts: an unknown option is rejected by preflight before any side effect', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/routing_alerts': alertsOk() });
  const t = makeIo({ fetch });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'alerts', '--bogus', 'x', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /unknown option --bogus for 'routing'/);
  assert.equal(calls.length, 0);
});

// ---- exit 3: human credential absent / irrecoverable -----------------------

test('routing: exit 3 with the login remedy when no human credential exists (all five subcommands, zero network)', async () => {
  for (const argv of [
    ['routing', 'alerts', '--hub', HUB],
    ['routing', 'show', WORKFLOW_A, '--hub', HUB],
    ['routing', 'rule', 'list', '--hub', HUB],
    ['routing', 'rule', 'add', 'build:express', 'build', '--hub', HUB],
    ['routing', 'rule', 'rm', 'build:express', 'build', '--hub', HUB],
  ]) {
    const { fetch, calls } = routedFetch({
      'GET /api/routing_alerts': alertsOk(),
      [`GET /api/run_routing/${WORKFLOW_A}`]: showOk(),
      'GET /api/capability_reroutes': rulesOk(),
      'POST /api/add_capability_reroute': addRuleOk(),
      'POST /api/remove_capability_reroute': rmRuleOk(),
    });
    const t = makeIo({ fetch }); // empty keychain

    const code = await mainAsync(argv, t.io);
    assert.equal(code, 3, `argv ${JSON.stringify(argv)}`);
    assert.match(t.err.join('\n'), new RegExp(`run: owenloop login --hub ${ORIGIN.replace(/[.]/g, '\\.')}`));
    assert.equal(calls.length, 0, 'no network without a human credential');
  }
});

test('routing rule add: an expired human oauth REFRESHES once and retries with the refreshed bearer', async () => {
  const { fetch, calls } = routedFetch({
    'GET /.well-known/oauth-authorization-server': () => ({ status: 200, json: OAUTH_METADATA }),
    'POST /mcp/token': () => ({ status: 200, json: { access_token: 'mcpat_new', expires_in: 3600 } }),
    'POST /api/add_capability_reroute': addRuleOk(),
  });
  const t = makeIo({ fetch });
  seedHumanOauth(t, { accessToken: 'mcpat_old', expiresAt: Date.now() - 1000 });

  const code = await mainAsync(['routing', 'rule', 'add', 'build:express', 'build:standard', '--hub', HUB], t.io);
  assert.equal(code, 0, t.err.join('\n'));

  assert.ok(calls.some((c) => c.pathname === '/mcp/token'), 'a refresh happened');
  assert.equal(calls.find((c) => c.pathname === '/api/add_capability_reroute')!.authorization, 'Bearer mcpat_new');
  assert.equal((JSON.parse(t.store.get(kcHuman(ORIGIN))!) as Credential).accessToken, 'mcpat_new');
});

test('routing alerts: a 401 that survives the retry is `credential rejected`, exit 3', async () => {
  // An `oauth-pasted` credential has no refresh path, so the 401 is final on the
  // first response — the exact "irrecoverable credential" family.
  const { fetch } = routedFetch({
    'GET /api/routing_alerts': () => ({ status: 401, json: { error: 'unauthorized' } }),
  });
  const t = makeIo({ fetch });
  t.store.set(kcHuman(ORIGIN), JSON.stringify({ kind: 'oauth-pasted', accessToken: 'mcpat_x' }));

  const code = await mainAsync(['routing', 'alerts', '--hub', HUB], t.io);
  assert.equal(code, 3);
  assert.match(t.err.join('\n'), /credential rejected/);
});

// ---- exit 2: hub resolution -------------------------------------------------

test('routing: exit 2 when no --hub and the store knows zero hubs, naming the routing purpose', async () => {
  const { fetch, calls } = routedFetch({ 'GET /api/routing_alerts': alertsOk() });
  const t = makeIo({ fetch, env: { OWENLOOP_NO_KEYCHAIN: '1' } });

  const code = await mainAsync(['routing', 'alerts'], t.io);
  assert.equal(code, 2);
  const err = t.err.join('\n');
  assert.match(err, /--hub/);
  assert.match(err, /owenloop login/);
  // Proves `resolveAgentHub`'s purpose parameter is actually wired through — the
  // message must not say "mint on" for a routing command.
  assert.match(err, /manage routing on/);
  assert.doesNotMatch(err, /mint on/);
  assert.equal(calls.length, 0, 'no network before an unresolvable hub');
});

// ---- transport discipline ---------------------------------------------------

test('routing alerts: a hub TIMEOUT is a plain exit 1 (a flaky network is not an irrecoverable credential)', async () => {
  const { fetch, calls } = stallingFetch({ 'GET /api/routing_alerts': alertsOk() }, ['GET /api/routing_alerts']);
  const t = makeIo({ fetch, env: { OWENLOOP_HUB_TIMEOUT_MS: '80' } });
  seedHumanOauth(t);

  const code = await mainAsync(['routing', 'alerts', '--hub', HUB], t.io);
  assert.equal(code, 1);
  assert.match(t.err.join('\n'), /did not respond within/);
  assert.ok(calls.some((c) => c.pathname === '/api/routing_alerts'), 'the GET was attempted (and stalled)');
});

test('routing: every request sets redirect: error — proof it went through hubFetch, not raw fetch', async () => {
  for (const [argv, pathname] of [
    [['routing', 'alerts'], '/api/routing_alerts'],
    [['routing', 'show', WORKFLOW_A], `/api/run_routing/${WORKFLOW_A}`],
    [['routing', 'rule', 'list'], '/api/capability_reroutes'],
    [['routing', 'rule', 'add', 'build:express', 'build:standard'], '/api/add_capability_reroute'],
    [['routing', 'rule', 'rm', 'build:express', 'build:standard'], '/api/remove_capability_reroute'],
  ] as [string[], string][]) {
    const { fetch, calls } = routedFetch({
      'GET /api/routing_alerts': alertsOk(),
      [`GET /api/run_routing/${WORKFLOW_A}`]: showOk(),
      'GET /api/capability_reroutes': rulesOk(),
      'POST /api/add_capability_reroute': addRuleOk(),
      'POST /api/remove_capability_reroute': rmRuleOk(),
    });
    const t = makeIo({ fetch });
    seedHumanOauth(t);

    const code = await mainAsync([...argv, '--hub', HUB], t.io);
    assert.equal(code, 0, t.err.join('\n'));
    const req = calls.find((c) => c.pathname === pathname)!;
    assert.equal(req.redirect, 'error', `${pathname} must be fetched with redirect: 'error'`);
  }
});

// ---- narrower unit tests (the pure edges the CLI paths cannot reach) --------

test('asRoutingAlerts: absent and null are BOTH accepted for the three nullable fields, and both narrow to null', async () => {
  // The hub sends explicit `null`s today (`?? null` at the query layer). The
  // absent branch is defensive leniency, deliberately kept so an older or
  // trimmed hub response is readable rather than an error.
  const explicitNulls = asRoutingAlerts({ alerts: [ALERT_NULLS] })[0]!;
  const absent = asRoutingAlerts({
    alerts: [{ id: 'ral_9', at: 1, workflow: 'wf', kind: 'fallback', capability: 'build' }],
  })[0]!;
  for (const row of [explicitNulls, absent]) {
    assert.equal(row.modifier, null);
    assert.equal(row.step, null);
    assert.equal(row.detail, null);
  }
  assert.equal(absent.kind, 'fallback', 'an unlisted kind is forwarded verbatim, never narrowed to an enum');
});

test('asRoutingAlerts: a kind the CLI has never heard of is forwarded, not rejected', async () => {
  // A kind added on the hub later must widen what this CLI PRINTS, never break
  // the command — the `CrewWire.kind` stance.
  const row = asRoutingAlerts({ alerts: [{ ...ALERT_GAP, kind: 'some-future-kind' }] })[0]!;
  assert.equal(row.kind, 'some-future-kind');
});

test('asRunRouting: an ABSENT modifier omits the key; an EMPTY-STRING modifier is malformed', async () => {
  const base = {
    workflow: WORKFLOW_A,
    defName: 'delivery',
    waitPolicy: { wait: 'forever' },
    alerts: [],
    resolutionReports: [],
    escalations: [],
  };
  const unmodified = asRunRouting(base);
  assert.equal('modifier' in unmodified, false, 'absent stays absent — never defaulted to an empty string');
  assert.equal(asRunRouting({ ...base, modifier: 'express' }).modifier, 'express');
  assert.throws(
    () => asRunRouting({ ...base, modifier: '' }),
    /run_routing: malformed success response — modifier must be a non-empty string when present/,
  );
});

test('asRunRouting: waitPolicy.then is forwarded verbatim when present and omitted when absent', async () => {
  const base = { workflow: WORKFLOW_A, defName: 'delivery', alerts: [], resolutionReports: [], escalations: [] };
  assert.equal('then' in asRunRouting({ ...base, waitPolicy: { wait: 'forever' } }).waitPolicy, false);
  assert.equal(asRunRouting({ ...base, waitPolicy: { wait: '30m', then: 'fallback' } }).waitPolicy.then, 'fallback');
});

test('asCapabilityRerouteRemoved: remainingTargets is strict — absent, non-array, and bad elements all throw', async () => {
  const base = { capability: 'build:express', target: 'build', removed: true };
  assert.deepEqual(asCapabilityRerouteRemoved({ ...base, remainingTargets: [] }).remainingTargets, []);
  assert.throws(() => asCapabilityRerouteRemoved(base), /missing array remainingTargets/);
  assert.throws(() => asCapabilityRerouteRemoved({ ...base, remainingTargets: 'build' }), /missing array remainingTargets/);
  assert.throws(
    () => asCapabilityRerouteRemoved({ ...base, remainingTargets: ['build', 7] }),
    /remainingTargets\[1\] is not a non-empty string/,
  );
});
