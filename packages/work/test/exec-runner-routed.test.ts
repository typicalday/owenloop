import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

import { createRoutedGroupRunner } from '../src/exec/runner.ts';
import { PAYLOAD_MARKER } from '../src/exec/payload.ts';
import { ROUTED_GROUP_SUPERVISOR } from '../src/exec/routed-group-supervisor.ts';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('routed supervisor preserves direct shell result, output and payload before scoped settlement', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-routed-group-'));
  try {
    const runner = createRoutedGroupRunner({ graceMs: 30 });
    const running = runner.start(`printf 'out\\n${PAYLOAD_MARKER}{"n":1}\\n'; printf err >&2; exit 3`, { cwd });
    const result = await running.done;
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdoutBytes, `out\n${PAYLOAD_MARKER}{"n":1}\n`.length);
    assert.equal(result.stderrBytes, 3);
    assert.equal(result.outputHash, `sha256:${createHash('sha256').update(`out\n${PAYLOAD_MARKER}{"n":1}\nerr`).digest('hex')}`);
    assert.equal(result.outputTail, `out\n${PAYLOAD_MARKER}{"n":1}\nerr`);
    assert.equal(result.payloadLine, '{"n":1}');
    const settled = await running.settleEffects({ reason: 'natural-exit', deadlineAt: performance.now() + 5_000 });
    assert.equal(settled.scope, 'original-posix-group');
    assert.equal(settled.state, 'empty', JSON.stringify(settled));
    assert.equal(settled.evidence.reason, 'group-absent-at-observation');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('routed machinery failure before sentinel spawn is an empty never-started group', async () => {
  const cwd = join(tmpdir(), `owenloop-missing-routed-cwd-${process.pid}-${Date.now()}`);
  const running = createRoutedGroupRunner().start('echo unreachable', { cwd });
  const direct = await running.done;
  assert.equal(direct.exitCode, null);
  assert.ok(direct.error);
  const settled = await running.settleEffects({ reason: 'stop', deadlineAt: performance.now() + 100 });
  assert.equal(settled.state, 'empty');
  assert.equal(settled.evidence.reason, 'never-started');
});

test('routed supervisor preserves bounded full-stream hash under backpressure', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-routed-group-'));
  let running;
  try {
    const size = 2 * 1024 * 1024;
    running = createRoutedGroupRunner({ graceMs: 20 }).start(`head -c ${size} /dev/zero >&2; printf hi`, { cwd });
    const direct = await running.done;
    assert.equal(direct.exitCode, 0, JSON.stringify(direct));
    assert.equal(direct.stdoutBytes, 2);
    assert.equal(direct.stderrBytes, size);
    assert.equal(direct.outputHash,
      `sha256:${createHash('sha256').update('hi').digest('hex')}+${createHash('sha256').update(Buffer.alloc(size)).digest('hex')}`);
    const settled = await running.settleEffects({ reason: 'natural-exit', deadlineAt: performance.now() + 5_000 });
    assert.equal(settled.state, 'empty', JSON.stringify(settled));
  } finally {
    if (running) await running.settleEffects({ reason: 'stop', deadlineAt: performance.now() + 5_000 });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('inherited output pipes cannot prevent direct shell result or group settlement', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-routed-group-'));
  let running;
  try {
    const background = `setInterval(()=>{},1000);process.on('SIGTERM',()=>{})`;
    running = createRoutedGroupRunner({ graceMs: 50 }).start(
      `${quote(process.execPath)} -e ${quote(background)} & echo direct`, { cwd },
    );
    const direct = await Promise.race([running.done, sleep(2_000).then(() => { throw new Error('direct result hung'); })]);
    assert.equal(direct.exitCode, null, JSON.stringify(direct));
    assert.equal(direct.error, 'output-incomplete');
    assert.equal(direct.outputTail, 'direct\n');
    const settled = await running.settleEffects({ reason: 'natural-exit', deadlineAt: performance.now() + 5_000 });
    assert.equal(settled.state, 'empty', JSON.stringify(settled));
  } finally {
    if (running) await running.settleEffects({ reason: 'stop', deadlineAt: performance.now() + 5_000 });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('slow consumer never receives success for truncated direct output', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-routed-group-'));
  const child = spawn(process.execPath, ['--eval', ROUTED_GROUP_SUPERVISOR], {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const token = 'fedcba9876543210fedcba9876543210';
  const size = 512 * 1024;
  let bytes = 0;
  child.stdout!.pause();
  child.stdout!.on('data', (chunk: Buffer) => { bytes += chunk.length; });
  try {
    const result = new Promise<{ code: number | null; error?: string; stdoutBytes: number }>((resolve, reject) => {
      child.on('message', (raw: unknown) => {
        const msg = raw as { token?: string; type?: string; code: number | null; error?: string; stdoutBytes: number };
        if (msg.token === token && msg.type === 'shell-result') resolve(msg);
      });
      child.on('error', reject);
    });
    child.send({ type: 'start', token, command: `head -c ${size} /dev/zero`, cwd, env: process.env, graceMs: 30 });
    await sleep(500); // deliberately hold the parent output pipe beyond the old 200 ms cutoff
    child.stdout!.resume();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('output result hung')), 5_000);
      }),
    ]).finally(() => { if (timeout) clearTimeout(timeout); });
    assert.equal(observed.code === 0 ? observed.stdoutBytes === size : observed.error === 'output-incomplete', true,
      JSON.stringify(observed));
    if (observed.code === 0) assert.equal(bytes, size);
    child.send({ type: 'settle', token, reason: 'natural-exit' });
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('post-exit pipe deadline is monotonic under a regressed wall clock', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-routed-group-'));
  const child = spawn(process.execPath, ['--eval', `Date.now=()=>-1000000000000;\n${ROUTED_GROUP_SUPERVISOR}`], {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const token = 'abcdef0123456789abcdef0123456789';
  child.stdout!.resume();
  child.stderr!.resume();
  try {
    const result = new Promise<{ code: number | null; error?: string }>((resolve, reject) => {
      child.on('message', (raw: unknown) => {
        const msg = raw as { token?: string; type?: string; code: number | null; error?: string };
        if (msg.token === token && msg.type === 'shell-result') resolve(msg);
      });
      child.on('error', reject);
    });
    child.send({ type: 'start', token, command: 'sleep 30 & exit 0', cwd, env: process.env, graceMs: 30 });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('post-exit cutoff hung')), 2_000);
      }),
    ]).finally(() => { if (timeout) clearTimeout(timeout); });
    assert.equal(observed.code, null);
    assert.equal(observed.error, 'output-incomplete');
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.send({ type: 'settle', token, reason: 'natural-exit' });
    await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('expired caller wait reports uncertain while retained supervisor continues teardown', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-routed-group-'));
  let running;
  try {
    running = createRoutedGroupRunner({ graceMs: 50 }).start('sleep 30', { cwd });
    const early = await running.settleEffects({ reason: 'stop', deadlineAt: performance.now() - 1 });
    assert.equal(early.state, 'uncertain');
    assert.equal(early.evidence.reason, 'deadline');
    const later = await running.settleEffects({ reason: 'stop', deadlineAt: performance.now() + 5_000 });
    assert.equal(later.state, 'empty', JSON.stringify(later));
  } finally {
    if (running) await running.settleEffects({ reason: 'stop', deadlineAt: performance.now() + 5_000 });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('EPERM and a present or recycled PGID remain uncertain after supervisor exit', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-routed-group-'));
  try {
    const denied = createRoutedGroupRunner({ graceMs: 20, groupProbe: () => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    } }).start('exit 0', { cwd });
    await denied.done;
    const deniedResult = await denied.settleEffects({ reason: 'natural-exit', deadlineAt: performance.now() + 150 });
    assert.equal(deniedResult.state, 'uncertain');
    assert.equal(deniedResult.evidence.reason, 'group-probe-EPERM-at-deadline');

    const present = createRoutedGroupRunner({ graceMs: 20, groupProbe: () => {} }).start('exit 0', { cwd });
    await present.done;
    const presentResult = await present.settleEffects({ reason: 'natural-exit', deadlineAt: performance.now() + 100 });
    assert.equal(presentResult.state, 'uncertain');
    assert.equal(presentResult.evidence.reason, 'group-present-at-deadline');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('a non-leader sentinel refuses before any group signal', async () => {
  // The outer fixture is itself detached, so even a broken helper cannot
  // signal the test runner's process group.
  const script = `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['--eval',${JSON.stringify(ROUTED_GROUP_SUPERVISOR)}],
      {stdio:['ignore','ignore','ignore','ipc'],detached:false});
    const seen=[];
    child.on('message',m=>seen.push(m.type));
    child.on('exit',(code)=>{console.log(JSON.stringify({seen,code}));process.exit(0)});
    child.send({type:'start',token:'0123456789abcdef0123456789abcdef',command:'sleep 1',
      cwd:process.cwd(),env:process.env,graceMs:10});
    setTimeout(()=>{child.kill();process.exit(3)},2000).unref();
  `;
  const outer = spawn(process.execPath, ['--eval', script], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  outer.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    outer.on('error', reject);
    outer.on('close', resolve);
  });
  assert.equal(code, 0);
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { seen: string[]; code: number };
  assert.deepEqual(result.seen, ['unsafe-group']);
  assert.equal(result.code, 2);
});

test('parent IPC disconnect leaves sentinel-owned bounded teardown running', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-routed-group-'));
  const ready = join(cwd, 'ready');
  const writes = join(cwd, 'writes');
  const writer = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>fs.appendFileSync(${JSON.stringify(writes)},'x'),20)`;
  const child = spawn(process.execPath, ['--eval', ROUTED_GROUP_SUPERVISOR], {
    cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const token = '0123456789abcdef0123456789abcdef';
  try {
    const readyMessage = new Promise<void>((resolve, reject) => {
      child.on('message', (raw: unknown) => {
        const msg = raw as { token?: string; type?: string };
        if (msg.token === token && msg.type === 'ready') resolve();
        if (msg.token === token && msg.type === 'unsafe-group') reject(new Error('sentinel refused its own group'));
      });
      child.on('error', reject);
    });
    child.send({ type: 'start', token, command: `${quote(process.execPath)} -e ${quote(writer)} >/dev/null 2>&1`,
      cwd, env: process.env, graceMs: 80 });
    await readyMessage;
    for (let i = 0; i < 100 && !existsSync(ready); i++) await sleep(10);
    assert.equal(existsSync(ready), true);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.disconnect();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('disconnected sentinel did not exit')), 5_000);
        }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
    assert.equal(child.signalCode, 'SIGKILL');
    assert.throws(() => process.kill(-(child.pid as number), 0), { code: 'ESRCH' });
    const count = existsSync(writes) ? readFileSync(writes).length : 0;
    await sleep(180);
    assert.equal(existsSync(writes) ? readFileSync(writes).length : 0, count);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('natural shell exit does not leave a TERM-ignoring same-group writer alive', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-routed-group-'));
  const ready = join(cwd, 'ready');
  const writes = join(cwd, 'writes');
  const writer = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>fs.appendFileSync(${JSON.stringify(writes)},'x'),20)`;
  const command = `${quote(process.execPath)} -e ${quote(writer)} >/dev/null 2>&1 & while [ ! -f ${quote(ready)} ]; do sleep 0.01; done; exit 0`;
  let running;
  try {
    running = createRoutedGroupRunner({ graceMs: 80 }).start(command, { cwd });
    const direct = await running.done;
    assert.equal(direct.exitCode, 0, JSON.stringify(direct));
    assert.equal(existsSync(ready), true);
    const settled = await running.settleEffects({ reason: 'natural-exit', deadlineAt: performance.now() + 5_000 });
    assert.equal(settled.state, 'empty', JSON.stringify(settled));
    const count = existsSync(writes) ? readFileSync(writes).length : 0;
    await sleep(180);
    assert.equal(existsSync(writes) ? readFileSync(writes).length : 0, count);
  } finally {
    if (running) await running.settleEffects({ reason: 'stop', deadlineAt: performance.now() + 5_000 });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('stop settles a live direct shell before group-empty evidence', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'owenloop-routed-group-'));
  let running;
  try {
    running = createRoutedGroupRunner({ graceMs: 50 }).start('sleep 30', { cwd });
    await sleep(80);
    const settled = await running.settleEffects({ reason: 'stop', deadlineAt: performance.now() + 5_000 });
    assert.equal(settled.state, 'empty', JSON.stringify(settled));
    const direct = await running.done;
    assert.equal(direct.exitCode, null);
    assert.ok(direct.signal !== undefined, JSON.stringify(direct));
  } finally {
    if (running) await running.settleEffects({ reason: 'stop', deadlineAt: performance.now() + 5_000 });
    rmSync(cwd, { recursive: true, force: true });
  }
});
