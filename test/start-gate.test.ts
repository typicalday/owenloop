import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

const BIN = fileURLToPath(new URL('../bin/owenloop.mjs', import.meta.url));

type GatedChild = ChildProcessByStdio<null, Readable, Readable>;

let dir: string;
const children = new Set<GatedChild>();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owenloop-start-gate-'));
});
afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  rmSync(dir, { recursive: true, force: true });
});

function spawnGated(gatePath: string): GatedChild {
  const child = spawn(process.execPath, [BIN, '--help'], {
    env: { ...process.env, OWENLOOP_START_GATE: gatePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  return child;
}

function waitForExit(child: GatedChild, timeoutMs = 5_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`gated child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, signal });
    });
  });
}

test('the executable blocks before CLI import until the gate says start', async () => {
  const gatePath = join(dir, 'start.gate');
  writeFileSync(gatePath, 'wait\n');
  const child = spawnGated(gatePath);
  const exited = waitForExit(child);

  await sleep(100);
  assert.equal(child.exitCode, null, 'the CLI has not imported or exited while the gate is closed');
  assert.equal(existsSync(gatePath), true);

  writeFileSync(gatePath, 'start\n');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(existsSync(gatePath), false);
});

test('the executable removes a cancelled gate and exits 75 before CLI import', async () => {
  const gatePath = join(dir, 'cancel.gate');
  writeFileSync(gatePath, 'cancel\n');
  const child = spawnGated(gatePath);

  assert.deepEqual(await waitForExit(child), { code: 75, signal: null });
  assert.equal(existsSync(gatePath), false);
});

test('the executable exits 75 when the expected gate is missing', async () => {
  const gatePath = join(dir, 'missing.gate');
  const child = spawnGated(gatePath);

  assert.deepEqual(await waitForExit(child), { code: 75, signal: null });
  assert.equal(existsSync(gatePath), false);
});
