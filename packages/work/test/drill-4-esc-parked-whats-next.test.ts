/**
 * DRILL 4 — Esc'd parked whats_next → clean cancel, no leak (WO-6.1, M4).
 *
 * The M4 failure mode: a conductor issues `whats_next`, it parks with no work,
 * and the human hits Esc (or the client drops the call) — the JSON-RPC/MCP
 * client-cancel path (`notifications/cancelled`). owenwork must abort the park
 * CLEANLY: per the cancel contract the cancelled call sends NO response frame
 * (mcp/server.ts), the server stays alive for the next call, and because a
 * parked proxy holds NO leases and dispatched nothing, there is nothing to
 * strand — no orphan child, no stamped file, no stray hub verb. This drills the
 * D12 cancel-mid-park path end to end through real `proxy --mcp`.
 *
 * Credential path: owenloop file store (no OWENWORK_TOKEN) — the first hub
 * request (presence/wake during the park) carries `Bearer drill_agent_tok`.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { handshake, spawnMcp, startMockHub, until, type HubReq, type McpChild } from './helpers/mcp-stdio-client.ts';
import { DRILL_AUTH, fixtureEnv, seedCredentialStore } from './helpers/credential-fixture.ts';

const of = (reqs: HubReq[], verb: string): HubReq[] => reqs.filter((r) => r.verb === verb);

let root: string;
let home: string;
let cacheDir: string;
let stateDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenwork-drill4-'));
  home = join(root, 'home');
  cacheDir = join(root, 'cache');
  stateDir = join(root, 'state');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An IDLE hub: wake never reports change, so whats_next parks and dispatches nothing. */
function hubScript(verb: string): unknown {
  switch (verb) {
    case 'wake':
      return { text: '', cursor: 0, changed: false };
    case 'presence_ping':
      return { text: '', ok: true, name: 'p', lastSeen: 1 };
    default:
      return { text: '' };
  }
}

function spawnProxy(origin: string): McpChild {
  // credential path: owenloop file store (no OWENWORK_TOKEN)
  return spawnMcp(
    [
      'proxy', '--mcp', '--origin', origin, '--workflow', 'wf1', '--cap', '3',
      '--poll-interval', '25',
      '--cache-dir', cacheDir, '--state-dir', stateDir,
    ],
    fixtureEnv(home),
  );
}

/**
 * Every `*.md` file anywhere under the whole fixture root (home, cache, state).
 * Phase 5 deleted the stamp path, so the honest guard is no longer "the agents
 * dir is empty" — there is no agents dir — it is "NOTHING anywhere wrote an
 * agent-definition file", and the fixture pins HOME so the built-in default
 * location is inside this tree too.
 */
function stampedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(root);
  return out;
}

test('an Esc during a parked whats_next cancels cleanly — no reply frame, server survives, nothing leaked', async () => {
  const { origin, reqs, server } = await startMockHub(hubScript);
  seedCredentialStore(home, origin); // exact dynamic origin
  const mcp = spawnProxy(origin);
  try {
    await handshake(mcp);

    // Park a long whats_next WITHOUT awaiting it; keep its request id so we can
    // both cancel it and prove no reply ever comes back for it.
    const parkedId = mcp.fireRequest('tools/call', { name: 'whats_next', arguments: { wait_ms: 10_000 } });

    // The park is observably live once it has hit the hub (presence/wake).
    await until(() => reqs.length >= 1, 'the park to reach the hub');
    assert.equal(reqs[0]!.auth, DRILL_AUTH, 'first hub request carried the store token');

    // THE Esc: client-cancel for that request id.
    mcp.notify('notifications/cancelled', { requestId: parkedId, reason: 'client cancelled (Esc)' });

    // Give the cancel time to land and (wrongly) reply, if it were going to.
    await new Promise((r) => setTimeout(r, 300));

    // (i) The cancel contract: NO response frame ever arrives for the cancelled id.
    assert.ok(
      !mcp.frames.some((f) => f.id === parkedId),
      `a cancelled call must send no reply, but a frame for id ${parkedId} arrived`,
    );

    // (ii) The server is ALIVE: ping and tools/list answer normally.
    const pong = await mcp.request('ping');
    assert.deepEqual(pong.result, {}, 'ping answers after the cancel');
    const list = await mcp.request('tools/list');
    const names = (list.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(names, ['clock_in', 'set_dispatch_cap', 'submit', 'whats_next'], 'tools still served');

    // (iii) NO leak: the idle park dispatched nothing — no stamped agent files,
    // and no get_order/release on the wire (the proxy held no leases).
    assert.deepEqual(stampedFiles(), [], 'an idle park writes no agent-definition file anywhere');
    assert.equal(of(reqs, 'get_order').length, 0, 'no get_order — nothing was dispatched');
    assert.equal(of(reqs, 'release').length, 0, 'no release — the proxy held no leases to strand');

    // (iv) Clean exit on transport EOF.
    mcp.endStdin();
    assert.equal(await mcp.exited, 0, `exit 0 on transport EOF, stderr:\n${mcp.stderr()}`);
  } finally {
    server.close();
    mcp.child.kill('SIGKILL');
  }
});
