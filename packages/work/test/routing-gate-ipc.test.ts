import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const bin = fileURLToPath(new URL('../../../bin/owenloop.mjs', import.meta.url));

async function runShim(mode: 'allow' | 'wrong-token' | 'disconnect' | 'no-reply' | 'no-ipc' | 'ordinary') {
  const root = mkdtempSync(join(tmpdir(), 'routing-gate-ipc-'));
  const token = 'a'.repeat(32);
  const gate = join(root, `.${token}.gate`);
  const handoff = join(root, 'handoff.json');
  writeFileSync(gate, 'start');
  const routed = mode !== 'ordinary';
  const child = spawn(process.execPath, [bin, '--help'], {
    env: { ...process.env, OWENLOOP_START_GATE: gate,
      ...(routed ? { OWENLOOP_ROUTING_HANDOFF: handoff } : {}) },
    stdio: mode === 'no-ipc' || mode === 'ordinary'
      ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: unknown[] = [];
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  child.on('message', message => {
    messages.push(message);
    if (mode === 'allow' || mode === 'wrong-token') {
      child.send({ type: 'routing-gate-entry-allowed',
	dispatchToken: mode === 'allow' ? token : 'b'.repeat(32) }, error => {
	assert.ifError(error);
	if (child.connected) child.disconnect();
      });
    } else if (mode === 'disconnect' && child.connected) child.disconnect();
  });
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
	child.once('exit', (code, signal) => resolve({ code, signal }))),
      new Promise<never>((_, reject) => {
	timer = setTimeout(() => reject(new Error('shim gate timed out')), 7_000);
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    return { ...exit, messages, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
}

test('the real routed CLI shim waits for direct-child IPC allow before import', async () => {
  const result = await runShim('allow');
  assert.equal(result.messages.length, 1);
  assert.equal((result.messages[0] as { type: string }).type, 'routing-gate-entered');
  assert.equal((result.messages[0] as { dispatchToken: string }).dispatchToken, 'a'.repeat(32));
  assert.match((result.messages[0] as { routingHandoff: string }).routingHandoff, /\/handoff\.json$/);
  assert.equal(result.code, 0, result.stderr);
});

test('routed shim refuses missing IPC, wrong parent token, disconnect, and missing reply', async () => {
  for (const mode of ['no-ipc', 'wrong-token', 'disconnect', 'no-reply'] as const) {
    const result = await runShim(mode);
    assert.equal(result.code, 75, `${mode}: ${result.stderr}`);
    assert.equal(result.messages.length, mode === 'no-ipc' ? 0 : 1);
  }
});

test('ordinary gated CLI still starts without IPC', async () => {
  const result = await runShim('ordinary');
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.messages, []);
});
