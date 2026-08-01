/**
 * REAL-child e2e proving distinct foreground shift identity and live scope.
 *
 * Two `owenloop shift start` children inherit the same host, cwd, identity, and
 * command line. Each receives a separate state directory. The daemon-generated
 * presence names remain distinct, and socket `clock_in` changes only the scope
 * of the daemon that received the request.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { isShiftError } from '../src/shift/protocol.ts';
import { spawnShift, type ShiftChild } from './helpers/shift-client.ts';
import { startMockHub, until, type HubReq } from './helpers/mcp-stdio-client.ts';

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

/** Same start flags for both children except the required state/cache dirs. */
function spawnIdenticalShift(origin: string, cacheDir: string, stateDir: string): ShiftChild {
  return spawnShift(
    [
      'crew-initial', '--origin', origin, '--cap', '3', '--poll-interval', '25',
      '--cache-dir', cacheDir, '--state-dir', stateDir,
    ],
    { OWENWORK_TOKEN: TOKEN, XDG_CONFIG_HOME: configDir },
  );
}

test('two identical-argv shift children get distinct presence names, and clock_in scopes stay isolated', async () => {
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

  const shiftA = spawnIdenticalShift(origin, cacheDirA, stateDirA);
  const shiftB = spawnIdenticalShift(origin, cacheDirB, stateDirB);
  try {
    await Promise.all([shiftA.ready, shiftB.ready]);
    const initialA = await shiftA.request({ op: 'status' });
    const initialB = await shiftB.request({ op: 'status' });
    assert.equal(isShiftError(initialA), false);
    assert.equal(isShiftError(initialB), false);
    if (isShiftError(initialA) || isShiftError(initialB) || !('name' in initialA) || !('name' in initialB)) {
      throw new Error('unexpected status error');
    }

    const inA = await shiftA.request({ op: 'clock_in', serve_pools: ['crew-a'], name: initialA.name });
    const inB = await shiftB.request({ op: 'clock_in', serve_pools: ['crew-b'], name: initialB.name });
    assert.equal(isShiftError(inA), false, `clock_in A failed: ${JSON.stringify(inA)}`);
    assert.equal(isShiftError(inB), false, `clock_in B failed: ${JSON.stringify(inB)}`);
    if (isShiftError(inA) || isShiftError(inB) || !('name' in inA) || !('name' in inB)) {
      throw new Error('unexpected clock_in error');
    }

    const nameA = inA.name;
    const nameB = inB.name;
    const expectedPrefix = `${hostname()}/${basename(process.cwd())}#`;
    assert.ok(nameA.startsWith(expectedPrefix), `nameA ${nameA} missing prefix ${expectedPrefix}`);
    assert.ok(nameB.startsWith(expectedPrefix), `nameB ${nameB} missing prefix ${expectedPrefix}`);
    assert.match(nameA, /#[0-9a-f]{6}$/);
    assert.match(nameB, /#[0-9a-f]{6}$/);
    assert.notEqual(nameA, nameB, 'two identical-argv shifts must not collide on one presence name');

    // The conductor id is present on the hub wire even though the local status
    // protocol intentionally exposes only the public shift identity fields.
    await until(
      () => of(reqs, 'presence_ping').some((r) => r.body?.['name'] === nameA)
        && of(reqs, 'presence_ping').some((r) => r.body?.['name'] === nameB),
      'both children to ping presence with their own names',
    );
    const pings = of(reqs, 'presence_ping');
    const lastFor = (name: string): HubReq | undefined => [...pings].reverse().find((r) => r.body?.['name'] === name);
    const lastA = lastFor(nameA);
    const lastB = lastFor(nameB);
    assert.ok(lastA, `no presence ping found carrying name ${nameA}`);
    assert.ok(lastB, `no presence ping found carrying name ${nameB}`);
    const cidA = lastA!.body?.['conductor_id'] as string | undefined;
    const cidB = lastB!.body?.['conductor_id'] as string | undefined;
    assert.ok(cidA, 'conductor_id echoed on A presence');
    assert.ok(cidB, 'conductor_id echoed on B presence');
    assert.notEqual(cidA, cidB);
    const suffixA = nameA.slice(nameA.lastIndexOf('#') + 1);
    const suffixB = nameB.slice(nameB.lastIndexOf('#') + 1);
    assert.ok(cidA!.replace(/^cnd_/, '').replace(/-/g, '').startsWith(suffixA), `${cidA} does not start with ${suffixA}`);
    assert.ok(cidB!.replace(/^cnd_/, '').replace(/-/g, '').startsWith(suffixB), `${cidB} does not start with ${suffixB}`);

    // A socket next marks attendance but does not change the other daemon's
    // mutable scope. The background loop sends the forced presence pings.
    const wnA = await shiftA.request({ op: 'next', wait_ms: 0 });
    const wnB = await shiftB.request({ op: 'next', wait_ms: 0 });
    assert.equal(isShiftError(wnA), false);
    assert.equal(isShiftError(wnB), false);
    await until(() => of(reqs, 'presence_ping').filter((r) => r.body?.['attended_at'] !== undefined).length >= 2, 'attendance pings');
    const attendedA = [...of(reqs, 'presence_ping')].reverse().find((r) => r.body?.['name'] === nameA && r.body?.['attended_at'] !== undefined);
    const attendedB = [...of(reqs, 'presence_ping')].reverse().find((r) => r.body?.['name'] === nameB && r.body?.['attended_at'] !== undefined);
    assert.deepEqual(attendedA?.body?.['serve_pools'], ['crew-a'], "A's own ping carries only A's scope");
    assert.deepEqual(attendedB?.body?.['serve_pools'], ['crew-b'], "B's own ping carries only B's scope — clock_in on A did not leak into B");

    await Promise.all([shiftA.request({ op: 'end' }), shiftB.request({ op: 'end' })]);
    assert.equal(await shiftA.exited, 0, `A exit 0, stderr:\n${shiftA.stderr()}`);
    assert.equal(await shiftB.exited, 0, `B exit 0, stderr:\n${shiftB.stderr()}`);
  } finally {
    shiftA.child.kill('SIGKILL');
    shiftB.child.kill('SIGKILL');
    server.close();
  }
});
