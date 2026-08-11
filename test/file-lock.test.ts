import { spawn, type ChildProcessByStdio } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
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

const legacyScript = fileURLToPath(new URL('./fixtures/legacy-file-lock-client.ts', import.meta.url));
const newHolderScript = fileURLToPath(new URL('./fixtures/file-lock-holder.ts', import.meta.url));

type TestChild = ChildProcessByStdio<null, Readable, Readable>;

function spawnClient(script: string, args: string[] = []): TestChild {
  return spawn(
    process.execPath,
    ['--experimental-strip-types', script, lockPath, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function waitForLine(child: TestChild, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${expected}: ${stderr}`)), 5_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(`${expected}\n`)) {
	clearTimeout(timeout);
	resolve();
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!stdout.includes(`${expected}\n`)) {
	clearTimeout(timeout);
	reject(new Error(`client exited before ${expected} (${String(code)}/${String(signal)}): ${stderr}`));
      }
    });
  });
}

function waitForExit(child: TestChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

async function legacyAttempt(waitMs = 80, staleMs = 0): Promise<void> {
  const child = spawnClient(legacyScript, [String(waitMs), String(staleMs)]);
  await waitForLine(child, 'BLOCKED');
  await waitForExit(child);
}

function guard(): { format?: unknown; host?: unknown } {
  return JSON.parse(readFileSync(lockPath, 'utf8')) as { format?: unknown; host?: unknown };
}

test('release preserves the permanent parseable old-client guard', () => {
  const handle = acquireFileLockSync(lockPath);
  releaseFileLock(handle);

  assert.equal(existsSync(lockPath), true);
  assert.deepEqual(guard(), {
    format: 'owenloop-sqlite-lock-v2',
    host: 'owenloop/sqlite-lock/v2',
    startedAt: (guard() as { startedAt?: unknown }).startedAt,
  });
  assert.equal(existsSync(`${lockPath}.sqlite-v2`), true);
});

test('new clients exclude each other and a crashed holder releases the SQLite transaction', async () => {
  const child = spawnClient(newHolderScript);
  try {
    await waitForLine(child, 'READY');
    await assert.rejects(
      acquireFileLock(lockPath, { waitMs: 40, pollMs: 5, label: 'test parent' }),
      (error: unknown) => error instanceof FileLockTimeoutError && error.holderPid === child.pid,
    );

    const exited = waitForExit(child);
    assert.equal(child.kill('SIGKILL'), true);
    await exited;

    const afterCrash = await acquireFileLock(lockPath, { waitMs: 2_000, pollMs: 5 });
    releaseFileLock(afterCrash);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('an actual old JSON client acquired first blocks a new client until graceful old release', async () => {
  const legacy = spawnClient(legacyScript, ['5_000', '30_000']);
  try {
    await waitForLine(legacy, 'ENTERED');
    await assert.rejects(
      acquireFileLock(lockPath, { waitMs: 40, pollMs: 5 }),
      (error: unknown) =>
	error instanceof FileLockTimeoutError &&
	error.legacy &&
	error.holderPid === legacy.pid &&
	/manual/u.test(error.message),
    );

    const exited = waitForExit(legacy);
    assert.equal(legacy.kill('SIGTERM'), true);
    await exited;

    const next = await acquireFileLock(lockPath, { waitMs: 2_000, pollMs: 5 });
    releaseFileLock(next);
  } finally {
    if (legacy.exitCode === null && legacy.signalCode === null) legacy.kill('SIGKILL');
  }
});

test('the permanent guard blocks old acquisition even after release and after its mtime ages', async () => {
  const handle = acquireFileLockSync(lockPath);
  releaseFileLock(handle);
  const old = new Date(Date.now() - 24 * 60 * 60_000);
  utimesSync(lockPath, old, old);

  await legacyAttempt(100, 0);
  assert.equal(guard().host, 'owenloop/sqlite-lock/v2');
});

test('an old client cannot enter while a new client holds the aged guard pathname', async () => {
  const handle = acquireFileLockSync(lockPath);
  try {
    const old = new Date(Date.now() - 24 * 60 * 60_000);
    utimesSync(lockPath, old, old);
    await legacyAttempt(100, 0);
  } finally {
    releaseFileLock(handle);
  }
});

test('a new-client crash leaves old clients blocked while a later new client reacquires', async () => {
  const child = spawnClient(newHolderScript);
  try {
    await waitForLine(child, 'READY');
    await legacyAttempt(80, 0);
    const exited = waitForExit(child);
    child.kill('SIGKILL');
    await exited;

    await legacyAttempt(80, 0);
    const next = acquireFileLockSync(lockPath, { waitMs: 2_000, pollMs: 5 });
    releaseFileLock(next);
    await legacyAttempt(80, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('corrupt or pre-boundary legacy pathnames fail closed with manual-cleanup diagnostics', () => {
  for (const payload of ['not json', `SQLite format 3${String.fromCharCode(0)}pre-boundary`]) {
    rmSync(lockPath, { force: true });
    writeFileSync(lockPath, payload);
    assert.throws(
      () => acquireFileLockSync(lockPath, { waitMs: 10, pollMs: 1 }),
      (error: unknown) =>
	error instanceof FileLockTimeoutError &&
	error.legacy &&
	/will not delete automatically/u.test(error.message) &&
	/remove it manually/u.test(error.message),
    );
    assert.equal(readFileSync(lockPath, 'utf8'), payload);
  }
});
