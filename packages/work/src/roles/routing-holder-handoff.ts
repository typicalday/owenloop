/** One-use, private handoff for the nested routed hold MCP process. */
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync,
  readSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { RoutingHandoffV1 } from '../shift/runtime.ts';

export interface RoutingHolderHandoffV1 {
  version: 'routing-holder-v1'; origin: string; workflow: string; run: string;
  sessionId: string; shiftId: string; expiresAt: number;
  broker: { socketPath: string; cap: string };
}

function validOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; }
  catch { return false; }
}

export function createRoutingHolderHandoff(handoff: RoutingHandoffV1, now = Date.now()): {
  path: string; cleanup(): void;
} {
  if (handoff.reservation.childKind !== 'agent-run' || !handoff.broker || !handoff.holderBroker
    || handoff.holderBroker.socketPath !== handoff.broker.socketPath
    || handoff.holderBroker.cap === handoff.broker.cap
    || !validOrigin(handoff.origin) || !Number.isSafeInteger(now)
    || now >= handoff.sessionExpiresAt) throw new Error('routing holder handoff refused');
  const directory = mkdtempSync(join(tmpdir(), 'ol-rh-'));
  chmodSync(directory, 0o700);
  const path = join(directory, `${randomBytes(16).toString('hex')}.json`);
  const payload: RoutingHolderHandoffV1 = {
    version: 'routing-holder-v1', origin: handoff.origin,
    workflow: handoff.reservation.workflow, run: handoff.reservation.run,
    sessionId: handoff.sessionId, shiftId: handoff.shiftId,
    expiresAt: Math.min(now + 120_000, handoff.sessionExpiresAt), broker: handoff.holderBroker,
  };
  try { writeFileSync(path, JSON.stringify(payload), { flag: 'wx', mode: 0o600 }); }
  catch (error) { try { rmdirSync(directory); } catch { /* Preserve substituted entries. */ } throw error; }
  const inode = lstatSync(path);
  return { path, cleanup() {
    try {
      const current = lstatSync(path);
      if (current.dev === inode.dev && current.ino === inode.ino && current.isFile()) unlinkSync(path);
    } catch { /* Already consumed or replaced: never unlink a replacement. */ }
    try { rmdirSync(directory); } catch { /* Preserve unexpected entries. */ }
  } };
}

export function consumeRoutingHolderHandoff(args: { path: string; origin: string;
  workflow: string; run: string; now?: () => number }): RoutingHolderHandoffV1 {
  const { path } = args;
  let fd: number | undefined;
  let owned: { dev: number; ino: number; directoryDev: number; directoryIno: number } | undefined;
  let payload: RoutingHolderHandoffV1 | undefined;
  try {
    const directory = dirname(path);
    if (!isAbsolute(path) || normalize(path) !== path || !/^ol-rh-[A-Za-z0-9]{6}$/.test(basename(directory))
      || !/^[a-f0-9]{32}\.json$/.test(basename(path))) throw new Error();
    const dir = lstatSync(directory), before = lstatSync(path);
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700
      || (process.getuid && dir.uid !== process.getuid())
      || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600 || (process.getuid && before.uid !== process.getuid())
      || before.size > 4096) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(fd);
    if (file.dev !== before.dev || file.ino !== before.ino || file.size !== before.size
      || file.nlink !== 1 || !file.isFile()) throw new Error();
    owned = { dev: file.dev, ino: file.ino, directoryDev: dir.dev, directoryIno: dir.ino };
    const bytes = Buffer.alloc(4097);
    let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    const after = fstatSync(fd);
    if (length !== file.size || length > 4096 || after.size !== file.size
      || after.mtimeMs !== file.mtimeMs || after.ctimeMs !== file.ctimeMs) throw new Error();
    const value = JSON.parse(bytes.subarray(0, length).toString('utf8')) as RoutingHolderHandoffV1;
    const now = (args.now ?? Date.now)();
    if (!value || value.version !== 'routing-holder-v1' || !validOrigin(args.origin)
      || value.origin !== args.origin || value.workflow !== args.workflow || value.run !== args.run
      || !/^rs_[a-f0-9-]{36}$/.test(value.sessionId) || !value.shiftId.startsWith('shf_')
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now
      || !value.broker || !isAbsolute(value.broker.socketPath)
      || basename(value.broker.socketPath) !== 'broker.sock'
      || !/^ol-rb-[A-Za-z0-9]{6}$/.test(basename(dirname(value.broker.socketPath)))
      || !/^[a-f0-9]{64}$/.test(value.broker.cap)
      || Object.hasOwn(value, 'credential') || Object.hasOwn(value, 'token')) throw new Error();
    payload = value;
  } catch { /* A malformed or substituted file cannot authorize a bearer fallback. */ }
  finally {
    if (fd !== undefined) try { closeSync(fd); } catch { payload = undefined; }
    if (owned) try {
      const currentDir = lstatSync(dirname(path));
      const current = lstatSync(path);
      if (currentDir.dev !== owned.directoryDev || currentDir.ino !== owned.directoryIno
        || current.dev !== owned.dev || current.ino !== owned.ino) payload = undefined;
      else unlinkSync(path);
    } catch { payload = undefined; }
    if (owned) try {
      const currentDir = lstatSync(dirname(path));
      if (currentDir.dev === owned.directoryDev && currentDir.ino === owned.directoryIno)
        rmdirSync(dirname(path));
    } catch { /* Retain unexpected entries. */ }
  }
  if (!payload) throw new Error('routing holder handoff refused');
  return payload;
}
