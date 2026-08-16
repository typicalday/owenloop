import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { spawnShift, type ShiftChild } from './helpers/shift-client.ts';
import { startMockHub } from './helpers/mcp-stdio-client.ts';

const TOKEN = 'tok-shift-signal-e2e';

let root: string;
let configDir: string;
let children: ShiftChild[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'owenloop-shift-signal-'));
  configDir = join(root, 'config');
  children = [];
});

afterEach(() => {
  for (const child of children) child.child.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
});

test('SIGINT and SIGTERM clean each foreground shift socket without an end ping', async () => {
  const { origin, server } = await startMockHub((verb, body) => {
    if (verb === 'presence_ping') return { text: '', ok: true, name: String(body?.['name'] ?? 'shift'), lastSeen: Date.now() };
    if (verb === 'wake') return { text: '', cursor: 1, changed: false };
    return { text: '' };
  });
  try {
    for (const [index, signal] of (['SIGINT', 'SIGTERM'] as const).entries()) {
      const stateDir = join(root, `state-${String(index)}`);
      const cacheDir = join(root, `cache-${String(index)}`);
      const shift = spawnShift(
	[
	  'crew-signal', '--origin', origin, '--poll-interval', '25',
	  '--cache-dir', cacheDir, '--state-dir', stateDir,
	],
        { OWENLOOP_TOKEN: TOKEN, HOME: configDir, OWENLOOP_CONFIG_DIR: undefined, NODE_NO_WARNINGS: '1' },
      );
      children.push(shift);
      await shift.ready;
      shift.child.kill(signal);
      assert.equal(await shift.exited, 0, `${signal} failed; stderr:\n${shift.stderr()}`);
      assert.equal(existsSync(shift.socketPath), false, `${signal} left ${shift.socketPath}`);
    }
  } finally {
    server.close();
  }
});
