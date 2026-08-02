/**
 * DRILL 4 — a disconnected parked shift next cancels cleanly.
 *
 * The socket transport has the same important property as the retired MCP park:
 * a client can disconnect while `next` is parked, the daemon survives, and a
 * later client can still use the daemon without a leaked lease or child.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { isShiftError } from '../src/shift/protocol.ts';
import { rawShiftRequest, spawnShift, type ShiftChild } from './helpers/shift-client.ts';
import { startMockHub, until } from './helpers/mcp-stdio-client.ts';
import { DRILL_AUTH, fixtureEnv, seedCredentialStore } from './helpers/credential-fixture.ts';

const of = (reqs: Array<{ verb: string }>, verb: string): Array<{ verb: string }> => reqs.filter((r) => r.verb === verb);

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

/** An IDLE hub: wake never reports change, so the shift parks and dispatches nothing. */
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

function spawnDaemon(origin: string): ShiftChild {
  return spawnShift(
    [
      'crew-a', '--origin', origin, '--cap', '3', '--poll-interval', '25',
      '--cache-dir', cacheDir, '--state-dir', stateDir,
    ],
    fixtureEnv(home),
  );
}

/** Every `*.md` file anywhere under the fixture root. */
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

test('a disconnected parked shift next cancels cleanly — no reply frame, daemon survives, nothing leaked', async () => {
  const { origin, reqs, server } = await startMockHub(hubScript);
  seedCredentialStore(home, origin); // exact dynamic origin
  const daemon = spawnDaemon(origin);
  try {
    await daemon.ready;

    // Park a long shift next without awaiting it, then disconnect the socket.
    const parked = rawShiftRequest(daemon.socketPath, { op: 'next', wait_ms: 10_000 });
    void parked.response.catch(() => undefined);

    // The park is observably accepted once the attendance-forced presence ping
    // lands. Waiting for that ping also prevents cancellation from racing the
    // socket's initial connect/write.
    await until(
      () => reqs.some((r) => r.verb === 'presence_ping' && r.body?.['attended_at'] !== undefined),
      'the attended presence ping',
    );
    assert.equal(reqs[0]!.auth, DRILL_AUTH, 'first hub request carried the store token');

    // The socket equivalent of Esc/client cancellation: close the outstanding
    // request connection without sending a response.
    parked.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The daemon is alive: status answers after the cancellation.
    const status = await daemon.request({ op: 'status' });
    assert.equal(isShiftError(status), false);
    if (!isShiftError(status) && 'attended_at' in status) {
      assert.notEqual(status.attended_at, null, 'a valid next marks attendance before parking');
    }

    // The idle park dispatched nothing — no stamped file and no hub lease verbs.
    assert.deepEqual(stampedFiles(), [], 'an idle park writes no agent-definition file anywhere');
    assert.equal(of(reqs, 'get_order').length, 0, 'no get_order — nothing was dispatched');
    assert.equal(of(reqs, 'release').length, 0, 'no release — the shift held no lease to strand');

    const end = await daemon.request({ op: 'end' });
    assert.deepEqual(end, { ok: true, ended: true });
    assert.equal(await daemon.exited, 0, `exit 0 after end, stderr:\n${daemon.stderr()}`);
  } finally {
    server.close();
    daemon.child.kill('SIGKILL');
  }
});
