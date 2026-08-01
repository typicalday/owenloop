/**
 * REAL-child e2e proving the shifts.md §2 acceptance scenario end to end
 * (shifts.md §8 item 4): two `owenloop work proxy --mcp` children, spawned with the
 * IDENTICAL argv (no `--name`, no `--serve-pools`), the same
 * `OWENWORK_TOKEN`, and the same inherited `cwd` — the exact situation that
 * used to collide on one hub presence row keyed by `(principal, name)`. Each
 * gets its own `--state-dir` (state dirs are never meant to be shared) but
 * shares everything an operator would actually share: host, directory,
 * identity, command line.
 *
 * Proves:
 *  - each child's default presence name is `<host>/<dir>#<6-hex>`, and the two
 *    names differ only in that suffix (the §6 defect, fixed, on the wire) —
 *    i.e. two DISTINCT hub rows instead of one flip-flopping row;
 *  - each name's 6-hex suffix is a genuine prefix of that same child's own
 *    `conductor_id` (the cid the console would show), not an unrelated value;
 *  - `clock_in` on each child sets a DIFFERENT serve_pools, and each child's
 *    own next presence ping carries only its own scope — clock_in on one
 *    child never leaks into the other's identity.
 *
 * The mock hub scripts `wake` to `changed:false` throughout, so neither child
 * ever sweeps or dispatches — this test is purely about identity on the wire.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { callTool, handshake, spawnMcp, startMockHub, until, type HubReq, type McpChild } from './helpers/mcp-stdio-client.ts';

const TOKEN = 'tok-shift-e2e';

let root: string;
let configDir: string;
let cacheDirA: string;
let stateDirA: string;
let cacheDirB: string;
let stateDirB: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenwork-shift-e2e-'));
  configDir = join(root, 'config'); // isolates settings via XDG_CONFIG_HOME
  cacheDirA = join(root, 'cache-a');
  stateDirA = join(root, 'state-a');
  cacheDirB = join(root, 'cache-b');
  stateDirB = join(root, 'state-b');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function of(reqs: HubReq[], verb: string): HubReq[] {
  return reqs.filter((r) => r.verb === verb);
}

/** Identical argv for both children except cache/state dirs — everything an
 * operator would actually leave shared (host, cwd, identity) stays shared. */
function spawnIdenticalProxy(origin: string, cacheDir: string, stateDir: string): McpChild {
  return spawnMcp(
    ['proxy', '--mcp', '--origin', origin, '--workflow', 'wf1', '--cap', '3', '--poll-interval', '25', '--cache-dir', cacheDir, '--state-dir', stateDir],
    { OWENWORK_TOKEN: TOKEN, XDG_CONFIG_HOME: configDir },
  );
}

test('two identical-argv proxy --mcp children on one host+dir+identity get distinct presence names, and clock_in scopes stay isolated', async () => {
  const { origin, reqs, server } = await startMockHub((verb) => {
    switch (verb) {
      case 'wake':
        return { text: '', cursor: 1, changed: false }; // never sweeps — identity-only test
      case 'presence_ping':
        return { text: '', ok: true, name: 'p', lastSeen: 1 };
      default:
        return { text: '' };
    }
  });

  const mcpA = spawnIdenticalProxy(origin, cacheDirA, stateDirA);
  const mcpB = spawnIdenticalProxy(origin, cacheDirB, stateDirB);
  try {
    await handshake(mcpA);
    await handshake(mcpB);

    // clock_in each to a DIFFERENT crew scope before either pings, so the very
    // first presence ping already carries the post-clock_in scope.
    const inA = await callTool(mcpA, 'clock_in', { serve_pools: ['crew-a'] });
    const inB = await callTool(mcpB, 'clock_in', { serve_pools: ['crew-b'] });
    assert.equal(inA.isError, false, `clock_in A failed: ${JSON.stringify(inA.body)}`);
    assert.equal(inB.isError, false, `clock_in B failed: ${JSON.stringify(inB.body)}`);

    const nameA = inA.body.name as string;
    const nameB = inB.body.name as string;
    const cidA = inA.body.conductor_id as string | undefined;
    const cidB = inB.body.conductor_id as string | undefined;

    // Same host/dir prefix (both children inherit this test process's cwd).
    const expectedPrefix = `${hostname()}/${basename(process.cwd())}#`;
    assert.ok(nameA.startsWith(expectedPrefix), `nameA ${nameA} missing prefix ${expectedPrefix}`);
    assert.ok(nameB.startsWith(expectedPrefix), `nameB ${nameB} missing prefix ${expectedPrefix}`);

    // Distinct 6-hex suffixes — the §6 fix, on the wire.
    assert.match(nameA, /#[0-9a-f]{6}$/);
    assert.match(nameB, /#[0-9a-f]{6}$/);
    assert.notEqual(nameA, nameB, 'two identical-argv proxies must not collide on one presence name');

    // Distinct conductor ids too, and each name's suffix is a genuine prefix
    // of that SAME child's own cid — not a coincidence, not swapped.
    assert.ok(cidA, 'conductor_id echoed on clock_in reply');
    assert.ok(cidB, 'conductor_id echoed on clock_in reply');
    assert.notEqual(cidA, cidB);
    const suffixA = nameA.slice(nameA.lastIndexOf('#') + 1);
    const suffixB = nameB.slice(nameB.lastIndexOf('#') + 1);
    assert.ok(cidA!.replace(/^cnd_/, '').replace(/-/g, '').startsWith(suffixA), `${cidA} does not start with ${suffixA}`);
    assert.ok(cidB!.replace(/^cnd_/, '').replace(/-/g, '').startsWith(suffixB), `${cidB} does not start with ${suffixB}`);

    // whats_next on each triggers iterate(), which pings presence.
    const wnA = await callTool(mcpA, 'whats_next', { wait_ms: 0 });
    const wnB = await callTool(mcpB, 'whats_next', { wait_ms: 0 });
    assert.equal(wnA.isError, false);
    assert.equal(wnB.isError, false);

    await until(() => of(reqs, 'presence_ping').length >= 2, 'both children to have pinged presence at least once');
    const pings = of(reqs, 'presence_ping');
    const lastFor = (name: string): HubReq | undefined => [...pings].reverse().find((r) => r.body?.['name'] === name);
    const lastA = lastFor(nameA);
    const lastB = lastFor(nameB);
    assert.ok(lastA, `no presence ping found carrying name ${nameA}`);
    assert.ok(lastB, `no presence ping found carrying name ${nameB}`);
    assert.deepEqual(lastA!.body?.['serve_pools'], ['crew-a'], "A's own ping carries only A's scope");
    assert.deepEqual(lastB!.body?.['serve_pools'], ['crew-b'], "B's own ping carries only B's scope — clock_in on A did not leak into B");

    mcpA.endStdin();
    mcpB.endStdin();
    assert.equal(await mcpA.exited, 0, `A exit 0, stderr:\n${mcpA.stderr()}`);
    assert.equal(await mcpB.exited, 0, `B exit 0, stderr:\n${mcpB.stderr()}`);
  } finally {
    mcpA.child.kill('SIGKILL');
    mcpB.child.kill('SIGKILL');
    server.close();
  }
});
