/**
 * DRILL 1 — kill -9 mid-work, and the final-breath handoff (WO-6.1, M4).
 *
 * The M4 single-principal failure mode: a step agent dies while holding an
 * order. Two independent sub-drills prove owenwork's two truths about it, END
 * TO END against the real `bin/owenloop.mjs` over stdio + a mock hub.
 *
 * Credential path: owenloop file store (NO OWENWORK_TOKEN). Each child resolves
 * its bearer from the seeded fixture store; the first hub request carries
 * `Bearer drill_agent_tok`, proving the store path (not an env override) — the
 * M4-distinguishing requirement.
 *
 *  1a KILL -9 (ungraceful): SIGKILL is uncatchable, so there is NO final breath
 *     — the holder emits no `release`, and the order would strand until the
 *     hub's lease TTL, then re-offer. We assert the owenwork-side truth (no
 *     release on a hard kill) and then emulate the re-offer by having a fresh
 *     holder pick up the same run and complete it. CAVEAT: the TTL reap +
 *     re-offer is HUB-side behavior; the mock hub only emulates it. This drill
 *     asserts what owenwork does (no release on SIGKILL; a re-acquiring holder
 *     completes the order), not a real hub reaper.
 *
 *  1b FINAL BREATH (graceful): a CLEAN exit — SIGTERM, SIGINT, or stdin EOF
 *     (session death) — fires a targeted `release` FAST, so the order re-offers
 *     immediately instead of stranding until the lease TTL. Three variants, each
 *     asserting exactly one `release {workflow, run}` on the wire, delivered far
 *     inside the (multi-minute, prod) lease TTL, and NO `submit`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { callTool, handshake, spawnMcp, startMockHub, until, type HubReq, type McpChild } from './helpers/mcp-stdio-client.ts';
import { DRILL_AUTH, fixtureEnv, seedCredentialStore } from './helpers/credential-fixture.ts';

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

/** Canned hub: healthy claimed lease, green closing submit, ack'd release. */
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

const of = (reqs: HubReq[], verb: string): HubReq[] => reqs.filter((r) => r.verb === verb);
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'owenwork-drill1-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Start the mock hub and seed the store at its exact (dynamic) loopback origin. */
async function hubWithStore(): Promise<{ origin: string; reqs: HubReq[]; server: import('node:http').Server }> {
  const hub = await startMockHub(hubScript);
  seedCredentialStore(home, hub.origin); // exact origin, dynamic port
  return hub;
}

function spawnHold(origin: string): McpChild {
  // credential path: owenloop file store (no OWENWORK_TOKEN)
  return spawnMcp(
    ['hold', '--order', 'wf1/run1', '--origin', origin, '--heartbeat-interval', '25', '--mcp'],
    fixtureEnv(home),
  );
}

test('1a: SIGKILL mid-work emits NO release (uncatchable) — a fresh holder re-acquires and completes', async () => {
  const { origin, reqs, server } = await hubWithStore();
  const victim = spawnHold(origin);
  try {
    await handshake(victim);
    await until(() => of(reqs, 'heartbeat').length >= 1, 'first heartbeat (holding)');

    // The store path — not an env override — authenticated this holder.
    assert.equal(reqs[0]!.auth, DRILL_AUTH, 'first hub request carried the store token');

    victim.child.kill('SIGKILL'); // uncatchable — no final breath is possible
    assert.notEqual(await victim.exited, 0, 'SIGKILL takes the process down non-cleanly');

    // Settle, then prove the owenwork-side truth: a hard kill leaves NO release.
    await realSleep(300);
    assert.equal(of(reqs, 'release').length, 0, 'SIGKILL emits no release — the order strands until the hub TTL');

    // Emulate the hub's post-TTL re-offer: a fresh holder picks up the SAME run
    // and completes it. (The reap/re-offer is hub-side; the mock hub emulates it.)
    const heir = spawnHold(origin);
    try {
      await handshake(heir);
      const got = await callTool(heir, 'get_order');
      assert.equal(got.isError, false, 'the re-offered order is claimable again');
      assert.equal(got.body.run, 'run1');
      const sub = await callTool(heir, 'submit', { path: 'pr', value: { url: 'x' }, done: true });
      assert.equal(sub.isError, false);
      assert.equal(sub.body.closed, true, 'the order completes elsewhere');
      assert.equal(of(reqs, 'submit').length, 1, 'exactly one submit — from the heir, not the killed victim');
      heir.endStdin();
      assert.equal(await heir.exited, 0);
    } finally {
      heir.child.kill('SIGKILL');
    }
  } finally {
    server.close();
    victim.child.kill('SIGKILL');
  }
});

/**
 * 1b core: a clean shutdown fires exactly one fast `release {workflow, run}`,
 * far inside the lease TTL, with no submit. `trigger` injects the shutdown and
 * returns the wall time just before it (for the timing bound).
 */
async function finalBreathVariant(trigger: (mcp: McpChild) => number): Promise<void> {
  const { origin, reqs, server } = await hubWithStore();
  const mcp = spawnHold(origin);
  try {
    await handshake(mcp);
    await until(() => of(reqs, 'heartbeat').length >= 1, 'first heartbeat (holding)');
    assert.equal(reqs[0]!.auth, DRILL_AUTH, 'store-path bearer (no OWENWORK_TOKEN)');

    const signalledAt = trigger(mcp);
    await until(() => of(reqs, 'release').length >= 1, 'a release after the clean shutdown');

    const rels = of(reqs, 'release');
    assert.equal(rels.length, 1, 'exactly one targeted release');
    assert.deepEqual(rels[0]!.body, { workflow: 'wf1', run: 'run1' }, 'release names the bound order');
    // The final breath is effectively immediate — the drill proves it lands in
    // well under 2s, versus the multi-minute lease TTL a strand would wait out.
    assert.ok(rels[0]!.at - signalledAt <= 2000, `release landed ${rels[0]!.at - signalledAt}ms after shutdown (fast, not a TTL wait)`);
    assert.equal(of(reqs, 'submit').length, 0, 'a released order is never submitted');

    // A signal stops the loop, not the transport: end stdin to exit. (For the
    // stdin-EOF variant this is a no-op — it was the trigger.)
    mcp.endStdin();
    assert.equal(await mcp.exited, 0, `released outcome exits 0, stderr:\n${mcp.stderr()}`);
  } finally {
    server.close();
    mcp.child.kill('SIGKILL');
  }
}

test('1b variant A: SIGTERM → immediate release, no submit, exit 0', async () => {
  await finalBreathVariant((mcp) => {
    const t = Date.now();
    mcp.child.kill('SIGTERM');
    return t;
  });
});

test('1b variant B: SIGINT → immediate release, no submit, exit 0', async () => {
  await finalBreathVariant((mcp) => {
    const t = Date.now();
    mcp.child.kill('SIGINT');
    return t;
  });
});

test('1b variant C: stdin EOF (session death) → immediate release, no submit, exit 0', async () => {
  await finalBreathVariant((mcp) => {
    const t = Date.now();
    mcp.endStdin();
    return t;
  });
});
