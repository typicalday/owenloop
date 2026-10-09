import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { startManagedStdioRpc } from '../src/harness/jsonrpc-stdio.ts';

const handlers = {
  onNotification: () => {}, onServerRequest: async () => null, onStderr: () => {}, onExit: () => {},
};
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('managed JSON-RPC forwards exact frames and returns original group absence', async () => {
  const ambient = process.env.OWENLOOP_TOKEN;
  const secret = `routed-secret-${randomUUID()}`;
  process.env.OWENLOOP_TOKEN = secret;
  const publicEnv = { ...process.env };
  delete publicEnv.OWENLOOP_TOKEN;
  const script = String.raw`
    let pending = '';
    process.stdin.on('data', chunk => {
      pending += chunk.toString();
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
	const line = pending.slice(0, end); pending = pending.slice(end + 1);
	const frame = JSON.parse(line);
	process.stdout.write(JSON.stringify({id:frame.id,result:{echo:frame.params,
	  tokenSeen:process.env.OWENLOOP_TOKEN || null}}) + '\n');
      }
    });
  `;
  const client = startManagedStdioRpc({ command: process.execPath, args: ['-e', script],
    graceMs: 20, env: publicEnv, ...handlers });
  try {
    await client.ready;
    const answer = await client.request<{ echo: unknown }>('echo', { text: 'é\n😀' });
    assert.deepEqual(answer, { echo: { text: 'é\n😀' }, tokenSeen: null });
    const supervisorProcess = execFileSync('/bin/ps', ['eww', '-p', String(client.pid)],
      { encoding: 'utf8' });
    assert.ok(!supervisorProcess.includes(secret), 'supervisor environment excludes ambient Owenloop bearer');
    const result = await client.settleEffects({ reason: 'stop', deadlineAt: performance.now() + 5_000 });
    assert.equal(result.scope, 'original-posix-group');
    assert.equal(result.state, 'empty');
    assert.match(result.evidence.reason, /group-absent/);
  } finally {
    await client.dispose();
    if (ambient === undefined) delete process.env.OWENLOOP_TOKEN;
    else process.env.OWENLOOP_TOKEN = ambient;
  }
});

test('provider final response is delivered before its close invalidates pending RPC', async () => {
  const script = String.raw`
    process.stdin.once('data', chunk => {
      const frame = JSON.parse(chunk.toString().split('\n')[0]);
      process.stdout.write(JSON.stringify({id:frame.id,result:{final:true,blob:'x'.repeat(128*1024)}})+'\n',
	() => process.exit(0));
    });
  `;
  const client = startManagedStdioRpc({ command: process.execPath, args: ['-e', script],
    graceMs: 20, env: { ...process.env }, ...handlers });
  try {
    await client.ready;
    const result = await client.request<{ final: boolean; blob: string }>('final', {});
    assert.equal(result.final, true);
    assert.equal(result.blob.length, 128 * 1024);
    await client.settleEffects({ reason: 'normal-exit', deadlineAt: performance.now() + 5_000 });
  } finally { await client.dispose(); }
});

test('supervisor spawn failure rejects ready without an unhandled child error', async () => {
  const node = process.execPath;
  let client!: ReturnType<typeof startManagedStdioRpc>;
  try {
    Object.defineProperty(process, 'execPath', { value: '/missing/routed-node-fixture' });
    client = startManagedStdioRpc({ command: node, args: ['-e', ''],
      env: { ...process.env }, ...handlers });
  } finally {
    Object.defineProperty(process, 'execPath', { value: node });
  }
  await assert.rejects(client.ready, /supervisor error|closed before ready/);
  const result = await client.settleEffects({ reason: 'setup-failed',
    deadlineAt: performance.now() + 2_000 });
  assert.equal(result.state, 'uncertain');
});

test('leader exit does not bypass same-group descendant teardown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'routed-stdio-'));
  const marker = join(root, 'marker');
  const writer = String.raw`
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    setInterval(() => fs.appendFileSync(process.argv[1], 'x'), 20);
  `;
  const leader = String.raw`
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', process.argv[2], process.argv[1]],
      {detached:false,stdio:'ignore'});
    child.on('spawn', () => setTimeout(() => process.exit(0), 100));
  `;
  const client = startManagedStdioRpc({ command: process.execPath,
    args: ['-e', leader, marker, writer], graceMs: 50, env: { ...process.env }, ...handlers });
  try {
    await client.ready;
    await pause(300);
    const before = readFileSync(marker).length;
    assert.ok(before > 0);
    const result = await client.settleEffects({ reason: 'normal-exit', deadlineAt: performance.now() + 5_000 });
    assert.equal(result.scope, 'original-posix-group');
    assert.equal(result.state, 'empty');
    const atSettlement = readFileSync(marker).length;
    await pause(150);
    assert.equal(readFileSync(marker).length, atSettlement);
  } finally {
    await client.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
