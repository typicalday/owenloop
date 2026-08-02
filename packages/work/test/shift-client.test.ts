import { createServer, type Server } from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  noDaemonMessage,
  parseNextArgs,
  parseStateDirArgs,
  requestShift,
  ShiftClientError,
  shiftSocketPath,
} from '../src/shift/client.ts';
import { parseStartArgs } from '../src/roles/shift.ts';

const BIN = fileURLToPath(new URL('../../../bin/owenloop.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function listenSocket(handler: (socket: import('node:net').Socket) => void): Promise<{ server: Server; path: string }> {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-client-'));
  roots.push(root);
  const path = shiftSocketPath(root);
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { server, path };
}

test('parseNextArgs defaults to 90 seconds and converts finite non-negative seconds', () => {
  assert.deepEqual(parseNextArgs([]), { waitMs: 90_000 });
  assert.deepEqual(parseNextArgs(['--wait', '1.25', '--state-dir', '/state']), { waitMs: 1_250, stateDir: '/state' });
  assert.deepEqual(parseNextArgs(['--wait=0']), { waitMs: 0 });
  assert.match(parseNextArgs(['--wait', '-1']).error!, /finite non-negative/);
  assert.match(parseNextArgs(['--wait', 'Infinity']).error!, /finite non-negative/);
  assert.match(parseNextArgs(['--wait']).error!, /missing value/);
  assert.match(parseNextArgs(['--bogus']).error!, /unknown option/);
});

test('state-dir and start parser preserve explicit crews versus --all and reject no crews', () => {
  assert.deepEqual(parseStateDirArgs(['--state-dir=/tmp/state']), { stateDir: '/tmp/state' });
  assert.deepEqual(parseStartArgs(['alpha', 'alpha', ' beta ']).servePools, ['alpha', 'beta']);
  assert.deepEqual(parseStartArgs(['--all']).servePools, []);
  assert.match(parseStartArgs([]).error!, /at least one crew.*--all/);
  assert.match(parseStartArgs(['--all', 'alpha']).error!, /cannot be combined/);
});

test('requestShift sends one JSON line and parses a fragmented live response', async () => {
  const { server, path } = await listenSocket((socket) => {
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      raw += chunk;
      if (!raw.includes('\n')) return;
      assert.deepEqual(JSON.parse(raw), { op: 'status' });
      socket.write('{"name":"box",');
      setTimeout(() => socket.end('"serve_pools":[],"cap":2,"free":2,"running":0,"attended_at":null,"started_at":1}\n'), 1);
    });
  });
  try {
    assert.deepEqual(await requestShift(path, { op: 'status' }), {
      name: 'box', serve_pools: [], cap: 2, free: 2, running: 0, attended_at: null, started_at: 1,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('requestShift reports exact absent-daemon guidance and exposes absent=true', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-client-'));
  roots.push(root);
  const path = shiftSocketPath(root);
  await assert.rejects(
    () => requestShift(path, { op: 'status' }),
    (error: unknown) => {
      assert.ok(error instanceof ShiftClientError);
      assert.equal(error.absent, true);
      assert.equal(error.message, noDaemonMessage(path));
      return true;
    },
  );
});

test('requestShift rejects malformed daemon JSON and oversized requests', async () => {
  const malformed = await listenSocket((socket) => socket.end('not-json\n', () => socket.destroy()));
  try {
    await assert.rejects(() => requestShift(malformed.path, { op: 'status' }), /malformed JSON/);
  } finally {
    await new Promise<void>((resolve) => malformed.server.close(() => resolve()));
  }

  const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-client-large-'));
  roots.push(root);
  const path = shiftSocketPath(root);
  const server = createServer((socket) => socket.end('{"ok":true}\n', () => socket.destroy()));
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    const huge = { op: 'clock_in' as const, name: 'n'.repeat(70_000), serve_pools: [] };
    await assert.rejects(() => requestShift(path, huge), /request is too large/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('root shift status returns JSON no-daemon status with exit 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-cli-'));
  roots.push(root);
  const result = spawnSync(process.execPath, [BIN, 'shift', 'status', '--state-dir', root], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', HOME: root, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'no daemon', socket: shiftSocketPath(root) });
  assert.equal(result.stderr, '');
});

test('root shift next and end preserve exact absent-daemon guidance', () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-shift-cli-'));
  roots.push(root);
  const env = { PATH: process.env['PATH'] ?? '', HOME: root, NODE_NO_WARNINGS: '1' };
  for (const args of [
    ['shift', 'next', '--wait', '0', '--state-dir', root],
    ['shift', 'end', '--state-dir', root],
  ]) {
    const result = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${noDaemonMessage(shiftSocketPath(root))}\n`);
  }
});
