/**
 * REAL-child e2e for `owenloop work proxy --mcp` (plan test 5): spawns the actual
 * `bin/owenloop.mjs` over real stdio against a `node:http` mock hub and drills
 * the D2 conductor mount on the wire — DORMANCY (a mounted proxy makes zero
 * hub requests until a tool is called), a whats_next park that sweeps
 * wake→whats_next and really spawns a detached `owenloop work agent-run` child (the
 * ONLY agent path), the D7 capacity-view reply, the set_dispatch_cap round-trip,
 * and the --mcp/--once usage error.
 *
 * `pretest` builds `dist/`, so the bin shim resolves for the children.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { writeBundle } from '../src/bundle/cache.ts';
import type { CachedBundle } from '../src/bundle/types.ts';
import type { NormalizedStepSpec } from '../src/bundle/types.ts';
import { ORDER_TOKEN, ORIGIN_TOKEN } from '../src/agent/brief.ts';
import type { WorkOrder } from '../src/hub/types.ts';
import { callTool, handshake, spawnMcp, startMockHub, until, type HubReq, type McpChild } from './helpers/mcp-stdio-client.ts';

const TOKEN = 'tok-e2e';
const DEMO_HASH = 'abcdef1234567890';
const BRIEF_BODY = `run ${ORDER_TOKEN} @ ${ORIGIN_TOKEN}\n`;

let root: string;
let configDir: string;
let cacheDir: string;
let stateDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenwork-proxy-e2e-'));
  configDir = join(root, 'config'); // isolates settings via XDG_CONFIG_HOME
  cacheDir = join(root, 'cache');
  stateDir = join(root, 'state');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Seed the bundle cache with the demo def + its normalized builder step spec. */
function seedCache(): void {
  const tpl: NormalizedStepSpec = { step: 'builder', brief: BRIEF_BODY, permissions: { extensions: {} } };
  const bundle: CachedBundle = {
    def: { name: 'demo', hash: DEMO_HASH, steps: [{ name: 'builder', body: '' }] },
    fetchedAt: 0,
    origin: 'seed',
  };
  writeBundle(cacheDir, bundle, [tpl]);
}

const ORDER: WorkOrder = {
  workflow: 'wf1',
  run: 'run_x1234',
  step: 'builder',
  prompt: 'build it',
  consumes: {},
  expected_outputs: [{ path: 'pr' }],
  feedback: [],
  advisory: {},
  submit_hint: 'submit pr',
};

function of(reqs: HubReq[], verb: string): HubReq[] {
  return reqs.filter((r) => r.verb === verb);
}

function spawnProxy(origin: string, extra: string[] = []): McpChild {
  return spawnMcp(
    [
      'proxy', '--mcp', '--origin', origin, '--workflow', 'wf1', '--cap', '3',
      '--poll-interval', '25',
      '--cache-dir', cacheDir, '--state-dir', stateDir,
      ...extra,
    ],
    { OWENWORK_TOKEN: TOKEN, XDG_CONFIG_HOME: configDir },
  );
}

test('proxy --mcp on the wire: dormant until called, then whats_next sweeps and really spawns a detached agent-run child', async () => {
  seedCache();
  const { origin, reqs, server } = await startMockHub((verb) => {
    switch (verb) {
      case 'wake':
        return { text: '', cursor: 1, changed: true };
      case 'whats_next':
        return { text: '', workflow: 'wf1', def: 'demo', orders: [ORDER] };
      case 'presence_ping':
        return { text: '', ok: true, name: 'p', lastSeen: 1 };
      default:
        return { text: '' };
    }
  });
  const mcp = spawnProxy(origin);
  try {
    const init = await handshake(mcp);
    assert.equal(init.result.serverInfo.name, 'owenwork-proxy');
    const list = await mcp.request('tools/list');
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(names, ['clock_in', 'set_dispatch_cap', 'submit', 'whats_next']);

    // DORMANCY: a mounted-but-idle proxy is driven only by tool calls — after
    // the full handshake and a settling pause it has made ZERO hub requests.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(reqs.length, 0, `dormant mount made hub calls: ${JSON.stringify(reqs.map((r) => r.verb))}`);

    // One park: wake says changed → whats_next serves the order → the agent step
    // is dispatched as a detached `agent-run` child. The reply is the D7 CAPACITY
    // VIEW; it hands back no order handles, because there is nothing for the
    // caller to run.
    const res = await callTool(mcp, 'whats_next', { wait_ms: 5_000 });
    assert.equal(res.isError, false, `whats_next failed: ${JSON.stringify(res.body)}; stderr:\n${mcp.stderr()}`);
    assert.equal(res.body.orders, undefined, 'no order handles on the wire');
    assert.equal(res.body.cap, 3);
    assert.equal(typeof res.body.free, 'number');
    assert.equal(res.body.running, (res.body.cap as number) - (res.body.free as number));

    // The sweep really rode the wire, authenticated.
    await until(() => of(reqs, 'whats_next').length >= 1, 'whats_next on the wire');
    assert.ok(of(reqs, 'wake').length >= 1, 'wake pre-check happened');
    assert.equal(reqs[0]!.auth, `Bearer ${TOKEN}`);

    // A REAL detached agent-run child was spawned for the order. In --mcp mode
    // stdout is the JSON-RPC transport, so the loop's own lines land on stderr.
    await until(() => /dispatched agent-run wf1\/run_x1234 \(step 'builder', pid \d+\)/.test(mcp.stderr()), 'agent-run dispatch line');

    // Nothing stamped anything: the cache holds normalized step specs and there
    // is no compiled-template directory at all.
    assert.ok(existsSync(join(cacheDir, 'bundles', 'demo', DEMO_HASH, 'steps', 'builder.json')), 'step spec cached');
    assert.equal(existsSync(join(cacheDir, 'bundles', 'demo', DEMO_HASH, 'templates')), false, 'no templates dir');

    // set_dispatch_cap round-trip on the same mount.
    const cap = await callTool(mcp, 'set_dispatch_cap', { cap: 5 });
    assert.equal(cap.isError, false);
    assert.equal(cap.body.cap, 5);

    mcp.endStdin();
    assert.equal(await mcp.exited, 0, `exit 0 on transport EOF, stderr:\n${mcp.stderr()}`);
  } finally {
    mcp.child.kill('SIGKILL');
    server.close();
  }
});

test('proxy --mcp --once is a usage error (exit 2) — contradictory dispatch modes', async () => {
  const mcp = spawnProxy('http://127.0.0.1:9', ['--once']);
  try {
    assert.equal(await mcp.exited, 2);
    assert.match(mcp.stderr(), /mutually exclusive/);
  } finally {
    mcp.child.kill('SIGKILL');
  }
});
