// Faithful test copy of origin/main's pre-SQLite stale-lock algorithm.
import {
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { performance } from 'node:perf_hooks';

const lockPathArg = process.argv[2];
const waitMs = Number(process.argv[3] ?? 250);
const staleMs = Number(process.argv[4] ?? 0);
if (lockPathArg === undefined) throw new Error('usage: legacy-file-lock-client <path> [wait-ms] [stale-ms]');
const lockPath: string = lockPathArg;

const sleepCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const currentHost = hostname();
const raw = JSON.stringify({
  pid: process.pid,
  startedAt: Date.now(),
  token: `legacy-${process.pid}`,
  host: currentHost,
});

function readRaw(): string | null {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function stale(candidate: string): boolean {
  let holder: { pid?: unknown; host?: unknown } | null = null;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      holder = parsed as { pid?: unknown; host?: unknown };
    }
  } catch {
    // origin/main falls through to the mtime fallback for unparseable bytes.
  }
  if (holder !== null && typeof holder.host === 'string' && holder.host !== currentHost) return false;
  if (holder !== null && typeof holder.pid === 'number' && Number.isInteger(holder.pid) && holder.pid > 0) {
    return !pidAlive(holder.pid);
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

const deadline = performance.now() + waitMs;
let acquired = false;
while (!acquired) {
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    try {
      writeFileSync(fd, raw);
    } finally {
      closeSync(fd);
    }
    acquired = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const candidate = readRaw();
    if (candidate !== null && stale(candidate) && readRaw() === candidate) {
      rmSync(lockPath, { force: true });
      continue;
    }
    if (performance.now() >= deadline) {
      process.stdout.write('BLOCKED\n');
      process.exit(0);
    }
    Atomics.wait(sleepCell, 0, 0, 5);
  }
}

process.stdout.write('ENTERED\n');
const release = (): void => {
  if (readRaw() === raw) rmSync(lockPath, { force: true });
  process.exit(0);
};
process.on('SIGTERM', release);
process.on('SIGINT', release);
// Optional test hook: make this legacy pathname old while the process still owns it.
if (process.env['OWENLOOP_TEST_AGE_LEGACY'] === '1') {
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockPath, old, old);
}
setInterval(() => {}, 60_000);
