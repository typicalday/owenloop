/**
 * REAL-child e2e for `owenloop work hold --mcp` (plan test 4): spawns the actual
 * `bin/owenloop.mjs` over real stdio against a `node:http` mock hub and drills
 * the born-bound work-holder on the wire — heartbeats from birth, get_order,
 * the closing submit whose response frame must NOT race process exit (reviewer
 * error 1), post-terminal fast-fails with no hub traffic (reviewer error 2),
 * the SIGTERM-pre-submit final breath, and the --mcp/--ignore-stdin usage
 * error.
 *
 * `pretest` builds `dist/`, so the bin shim resolves for the children.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { callTool, handshake, spawnMcp, startMockHub, until, type HubReq, type McpChild } from './helpers/mcp-stdio-client.ts';

const TOKEN = 'tok-e2e';

let configDir: string;
beforeEach(() => {
  // Isolate settings: a temp XDG_CONFIG_HOME means the child sees NO settings
  // file — origin comes only from --origin, token only from OWENLOOP_TOKEN.
  configDir = mkdtempSync(join(tmpdir(), 'owenloop-hold-e2e-'));
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

function childEnv(): Record<string, string | undefined> {
  return { OWENLOOP_TOKEN: TOKEN, XDG_CONFIG_HOME: configDir, OWENLOOP_SESSION: '' };
}

function of(reqs: HubReq[], verb: string): HubReq[] {
  return reqs.filter((r) => r.verb === verb);
}

const ORDER_PACKET = {
  run: 'run1',
  workflow: 'wf1',
  step: 'builder',
  key: 'k',
  inputs: [],
  outputs: ['pr'],
  prompt: 'do the thing',
  consumes: {},
  owes: [],
};

/** Canned hub: healthy lease, green closing submit. */
function hubScript(verb: string): unknown {
  switch (verb) {
    case 'get_order':
      return { text: 'here', workflow: 'wf1', run: 'run1', order: ORDER_PACKET, lease: { claimed: true } };
    case 'heartbeat':
      return { text: 'hb' };
    case 'release':
      return { text: 'released', released: true };
    case 'submit':
      return { text: 'ok', outcome: 'green', closed: true };
    default:
      return { text: '' };
  }
}

function spawnHold(origin: string, extra: string[] = []): McpChild {
  return spawnMcp(['hold', '--order', 'wf1/run1', '--origin', origin, '--heartbeat-interval', '25', '--mcp', ...extra], childEnv());
}

test('hold --mcp full lifecycle on the wire: heartbeats from birth, closing submit answers, then fast-fails until stdin EOF (reviewer errors 1+2)', async () => {
  const { origin, reqs, server } = await startMockHub(hubScript);
  const mcp = spawnHold(origin);
  try {
    const init = await handshake(mcp);
    assert.equal(init.result.serverInfo.name, 'owenloop-hold');

    const list = await mcp.request('tools/list');
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(names, ['ask', 'get_order', 'reject', 'submit']);

    // Heartbeats from BIRTH: the lease loop runs under the mount with zero
    // tool calls issued — first contact plus renewals appear on the wire.
    await until(() => of(reqs, 'heartbeat').length >= 2, 'heartbeats from birth');
    assert.ok(of(reqs, 'get_order').length >= 1, 'the loop made first contact');
    assert.equal(reqs[0]!.auth, `Bearer ${TOKEN}`, 'the token rode as a Bearer header');

    // The tool live-fetches the packet for the BOUND run — no ids from the model.
    const got = await callTool(mcp, 'get_order');
    assert.equal(got.isError, false);
    assert.equal(got.body.workflow, 'wf1');
    assert.equal(got.body.order.prompt, 'do the thing');

    // THE error-1 regression: the closing submit terminates the lease loop, but
    // its own response frame must still arrive intact — the process may not
    // exit until the transport (stdin) ends.
    const sub = await callTool(mcp, 'submit', { path: 'pr', value: { url: 'x' }, done: true });
    assert.equal(sub.isError, false, `closing submit answered normally, got: ${JSON.stringify(sub.body)}`);
    assert.equal(sub.body.outcome, 'green');
    assert.equal(sub.body.closed, true);

    // THE error-2 regression, on the wire: once the hold is terminal, both
    // tools fast-fail with isError and make NO hub call. The loop settles a
    // beat after the submit, so poll to the guard first.
    await until(
      () => of(reqs, 'submit').length === 1,
      'exactly one submit on the wire',
    );
    let guard = await callTool(mcp, 'get_order');
    while (!guard.isError) guard = await callTool(mcp, 'get_order');
    assert.match(guard.body.error, /no longer held/);

    const before = reqs.length;
    const g = await callTool(mcp, 'get_order');
    assert.equal(g.isError, true);
    assert.match(g.body.error, /no longer held/);
    const s = await callTool(mcp, 'submit', { path: 'pr', value: 2 });
    assert.equal(s.isError, true);
    assert.match(s.body.error, /no longer held/);
    assert.equal(reqs.length, before, 'terminal fast-fails made no hub calls');
    assert.equal(of(reqs, 'release').length, 0, 'a closed run is not released — the claim is already gone');

    // Transport EOF is the exit condition; the completed hold exits 0.
    mcp.endStdin();
    assert.equal(await mcp.exited, 0, `exit 0, stderr:\n${mcp.stderr()}`);
  } finally {
    mcp.child.kill('SIGKILL');
    server.close();
  }
});

test('hold --mcp restricted selector registers exactly get_order and submit on tools/list', async () => {
  const { origin, server } = await startMockHub(hubScript);
  const mcp = spawnHold(origin, ['--mcp-tools=get_order,submit']);
  try {
    await handshake(mcp);
    const list = await mcp.request('tools/list');
    const names = (list.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    assert.deepEqual(names, ['get_order', 'submit']);

    mcp.endStdin();
    assert.equal(await mcp.exited, 0, `exit 0, stderr:\n${mcp.stderr()}`);
  } finally {
    mcp.child.kill('SIGKILL');
    server.close();
  }
});

test('hold --mcp on SIGTERM before any submit: releases on the wire, never submits, exits 0 at stdin EOF', async () => {
  const { origin, reqs, server } = await startMockHub(hubScript);
  const mcp = spawnHold(origin);
  try {
    await handshake(mcp);
    await until(() => of(reqs, 'heartbeat').length >= 1, 'first heartbeat');

    mcp.child.kill('SIGTERM');
    // The final breath: a targeted release rides the wire so the order
    // re-offers immediately instead of stranding until lease expiry.
    await until(() => of(reqs, 'release').length >= 1, 'release after SIGTERM');
    assert.deepEqual(of(reqs, 'release')[0]!.body, { workflow: 'wf1', run: 'run1' });
    assert.equal(of(reqs, 'submit').length, 0, 'nothing was submitted');

    // The signal stops the LOOP, not the transport: the server keeps serving
    // fast-fails until the parent closes the pipe.
    const g = await callTool(mcp, 'get_order');
    assert.equal(g.isError, true);
    assert.match(g.body.error, /no longer held/);

    mcp.endStdin();
    assert.equal(await mcp.exited, 0, `released outcome exits 0, stderr:\n${mcp.stderr()}`);
  } finally {
    mcp.child.kill('SIGKILL');
    server.close();
  }
});

test('hold --mcp --ignore-stdin is a usage error (exit 2) — stdin IS the transport', async () => {
  const mcp = spawnMcp(['hold', '--order', 'wf1/run1', '--mcp', '--ignore-stdin'], childEnv());
  try {
    assert.equal(await mcp.exited, 2);
    assert.match(mcp.stderr(), /mutually exclusive/);
  } finally {
    mcp.child.kill('SIGKILL');
  }
});
