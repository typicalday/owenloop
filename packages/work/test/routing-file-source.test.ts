import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

import { openRoutedFileSource } from '../src/hub/routed-file-source.ts';

const rootOpener = (workdir: string) => open(workdir,
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
const nativeTest = (['darwin', 'linux'].includes(process.platform)
  && ['arm64', 'x64'].includes(process.arch)) ? test : test.skip;

async function readConfined(workdir: string, file: string,
  extra: { afterRootOpen?: () => void } = {}): Promise<string> {
  const source = await openRoutedFileSource({ workdir, file }, { openRoot: rootOpener, ...extra });
  try {
    const parts: Buffer[] = [];
    for await (const part of source.chunks) parts.push(Buffer.from(part));
    await source.complete();
    assert.equal(Buffer.concat(parts).byteLength, source.size);
    return Buffer.concat(parts).toString();
  } finally { source.close(); }
}

nativeTest('native routed opener follows only in-root relative and absolute symlinks', async () => {
  const base = mkdtempSync(join(tmpdir(), 'owenloop-native-links-'));
  const root = join(base, 'root');
  const outside = join(base, 'secret.txt');
  try {
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'nested', 'inside.txt'), 'inside');
    writeFileSync(outside, 'outside');
    symlinkSync('nested', join(root, 'relative'));
    symlinkSync(join(root, 'nested', 'inside.txt'), join(root, 'absolute'));
    symlinkSync(outside, join(root, 'escape'));
    assert.equal(await readConfined(root, 'relative/inside.txt'), 'inside');
    assert.equal(await readConfined(root, 'relative//inside.txt'), 'inside');
    assert.equal(await readConfined(root, 'absolute'), 'inside');
    assert.equal(await readConfined(root, join(root, 'nested', 'inside.txt')), 'inside');
    await assert.rejects(readConfined(root, 'escape'), /file-artifact-outside-workdir/);
    await assert.rejects(readConfined(root, '../secret.txt'), /file-artifact-outside-workdir/);
    await assert.rejects(readConfined(root, outside), /file-artifact-outside-workdir/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

nativeTest('native routed opener reads through the held root after its pathname is replaced', async () => {
  const base = mkdtempSync(join(tmpdir(), 'owenloop-native-root-'));
  const root = join(base, 'root');
  const moved = join(base, 'moved');
  const outside = join(base, 'outside');
  try {
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(root, 'artifact'), 'inside');
    writeFileSync(join(outside, 'artifact'), 'outside');
    const result = await readConfined(root, 'artifact', { afterRootOpen() {
      renameSync(root, moved);
      symlinkSync(outside, root, 'dir');
    } });
    assert.equal(result, 'inside');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

nativeTest('concurrent ancestor toggling never streams outside bytes', async () => {
  const base = mkdtempSync(join(tmpdir(), 'owenloop-native-race-'));
  const root = join(base, 'root');
  const safe = join(root, 'safe');
  const outside = join(base, 'outside');
  mkdirSync(safe, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(safe, 'artifact'), 'inside');
  writeFileSync(join(outside, 'artifact'), 'outside');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { renameSync, symlinkSync, unlinkSync } = require('node:fs');
    const { join } = require('node:path');
    let done = false;
    parentPort.on('message', () => { done = true; });
    function tick() {
      if (done) return;
      const parked = join(workerData.root, 'parked');
      try { renameSync(workerData.safe, parked); } catch {}
      try { symlinkSync(workerData.outside, workerData.safe, 'dir'); } catch {}
      try { unlinkSync(workerData.safe); } catch {}
      try { renameSync(parked, workerData.safe); } catch {}
      setImmediate(tick);
    }
    parentPort.postMessage('ready'); tick();
  `, { eval: true, workerData: { root, safe, outside } });
  try {
    await new Promise<void>(resolve => worker.once('message', () => resolve()));
    for (let i = 0; i < 60; i++) {
      try { assert.equal(await readConfined(root, 'safe/artifact'), 'inside'); }
      catch (error) { assert.match(String(error), /file-artifact-outside-workdir/); }
    }
  } finally {
    worker.postMessage('stop');
    await worker.terminate();
    rmSync(base, { recursive: true, force: true });
  }
});

nativeTest('routed upload refuses a missing native helper before opening a file', async () => {
  const base = mkdtempSync(join(tmpdir(), 'owenloop-native-missing-'));
  try {
    let opened = false;
    await assert.rejects(openRoutedFileSource({ workdir: base, file: 'artifact' }, {
      helperPath: join(base, 'missing-helper'),
      openRoot: async workdir => { opened = true; return rootOpener(workdir); },
    }), /file-artifact-helper-unavailable/);
    assert.equal(opened, false);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

nativeTest('routed upload refuses a helper executable inside the workdir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-native-untrusted-'));
  try {
    const executable = join(root, 'routing-file-open');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    let opened = false;
    await assert.rejects(openRoutedFileSource({ workdir: root, file: 'artifact' }, {
      helperPath: executable,
      openRoot: async workdir => { opened = true; return rootOpener(workdir); },
    }), /file-artifact-helper-unavailable: helper is inside workdir/);
    assert.equal(opened, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

nativeTest('routed source waits for helper exit after all bytes arrive', async () => {
  const base = mkdtempSync(join(tmpdir(), 'owenloop-native-exit-'));
  const root = join(base, 'root');
  try {
    mkdirSync(root);
    const executable = join(base, 'delayed-helper');
    writeFileSync(executable,
      '#!/bin/sh\nprintf "OK 6\\n" >&4\nprintf inside\nsleep 0.2\nexit 0\n', { mode: 0o755 });
    const source = await openRoutedFileSource({ workdir: root, file: 'artifact' }, {
      helperPath: executable, openRoot: rootOpener,
    });
    const started = Date.now();
    let text = '';
    for await (const part of source.chunks) text += Buffer.from(part).toString();
    await source.complete();
    source.close();
    assert.equal(text, 'inside');
    assert.ok(Date.now() - started >= 120);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

nativeTest('native opener refuses a FIFO promptly and a file shrunk during streaming', async () => {
  const root = mkdtempSync(join(tmpdir(), 'owenloop-native-type-'));
  try {
    execFileSync('mkfifo', [join(root, 'pipe')]);
    const started = Date.now();
    await assert.rejects(readConfined(root, 'pipe'), /file-artifact-invalid/);
    assert.ok(Date.now() - started < 1_000);
    const file = join(root, 'large');
    writeFileSync(file, 'x');
    truncateSync(file, 12 * 1024 * 1024);
    const source = await openRoutedFileSource({ workdir: root, file: 'large' }, { openRoot: rootOpener });
    try {
      const iterator = source.chunks[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).done, false);
      truncateSync(file, 0);
      for await (const _part of { [Symbol.asyncIterator]: () => iterator }) { /* drain */ }
      await assert.rejects(source.complete(), /file-artifact-read-failed/);
    } finally { source.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
