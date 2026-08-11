import { spawn, type ChildProcessByStdio } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  acquireFileLock,
  acquireFileLockSync,
  FileLockTimeoutError,
  releaseFileLock,
} from '../src/lock.ts';

let dir: string;
let lockPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owenloop-file-lock-'));
  lockPath = join(dir, 'writer.lock');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedSqliteLock(): void {
  const handle = acquireFileLockSync(lockPath);
  releaseFileLock(handle);
}

function replaceWithLegacyPayload(payload: string): void {
  const replacement = join(dir, `replacement-${Math.random().toString(36).slice(2)}`);
  writeFileSync(replacement, payload);
  renameSync(replacement, lockPath);
}

function waitForReady(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('READY\n')) resolve();
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`lock holder exited before ready (${String(code)}/${String(signal)}): ${stderr}`));
    });
  });
}

test('async acquisition never deletes a replacement installed after candidate inspection', async () => {
  seedSqliteLock();
  const payload = JSON.stringify({ pid: 111, startedAt: 1, token: 'replacement' });
  let replaced = false;

  await assert.rejects(
    acquireFileLock(lockPath, {
      waitMs: 15,
      pollMs: 1,
      beforeOpen: () => {
	if (replaced) return;
	replaced = true;
	replaceWithLegacyPayload(payload);
      },
    }),
    (error: unknown) => error instanceof FileLockTimeoutError && /legacy lockfile/u.test(error.message),
  );
  assert.equal(readFileSync(lockPath, 'utf8'), payload);
});

test('sync acquisition never deletes a replacement installed after candidate inspection', () => {
  seedSqliteLock();
  const payload = JSON.stringify({ pid: 222, startedAt: 1, token: 'replacement' });
  let replaced = false;

  assert.throws(
    () => acquireFileLockSync(lockPath, {
      waitMs: 15,
      pollMs: 1,
      beforeOpen: () => {
	if (replaced) return;
	replaced = true;
	replaceWithLegacyPayload(payload);
      },
    }),
    (error: unknown) => error instanceof FileLockTimeoutError && /legacy lockfile/u.test(error.message),
  );
  assert.equal(readFileSync(lockPath, 'utf8'), payload);
});

test('release closes only the acquired SQLite object and never removes a replacement pathname', () => {
  const handle = acquireFileLockSync(lockPath);
  const payload = JSON.stringify({ replacement: true });
  const replacement = join(dir, 'replacement');
  writeFileSync(replacement, payload);

  let pathnameReplaced = false;
  try {
    renameSync(replacement, lockPath);
    pathnameReplaced = true;
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    assert.ok(existsSync(lockPath), 'Windows kept the open SQLite pathname stable');
  }

  releaseFileLock(handle);

  if (pathnameReplaced) {
    assert.equal(readFileSync(lockPath, 'utf8'), payload);
  } else {
    renameSync(replacement, lockPath);
    assert.equal(readFileSync(lockPath, 'utf8'), payload);
  }
});

test('a second process blocks while held and acquires after the holder crashes', async () => {
  const script = fileURLToPath(new URL('./fixtures/file-lock-holder.ts', import.meta.url));
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', script, lockPath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await waitForReady(child);
    await assert.rejects(
      acquireFileLock(lockPath, { waitMs: 30, pollMs: 5, label: 'test parent' }),
      (error: unknown) => error instanceof FileLockTimeoutError && error.holderPid === child.pid,
    );

    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    assert.equal(child.kill('SIGKILL'), true);
    await exited;

    const afterCrash = await acquireFileLock(lockPath, { waitMs: 2_000, pollMs: 5 });
    releaseFileLock(afterCrash);
    assert.ok(existsSync(lockPath), 'crash release keeps the persistent lock database');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
