/** Private routing handoff consumption before worker instruction or network effects. */
import { basename, dirname, isAbsolute, normalize } from 'node:path';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, unlinkSync, type Stats } from 'node:fs';
import type { RoutingHandoffV1 } from '../shift/runtime.ts';

function exactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}

/** Consume the private per-spawn capability before any network or authored code.
 * The path's private inode ownership authorizes cleanup even if JSON is invalid.
 * A substituted directory/file never authorizes deleting its replacement. */
export function consumeRoutingHandoff(args: {
  env: Record<string, string | undefined>; origin: string;
  target: { workflow: string; run: string }; kind: 'exec' | 'agent-run'; now?: () => number;
}): RoutingHandoffV1 | undefined {
  const path = args.env.OWENLOOP_ROUTING_HANDOFF;
  const scoped = path !== undefined || process.env.OWENLOOP_ROUTING_HANDOFF !== undefined;
  for (const env of [args.env, process.env]) {
    delete env.OWENLOOP_ROUTING_HANDOFF;
    if (scoped) {
      delete env.OWENLOOP_TOKEN;
      delete env.OWENLOOP_ROUTING_SESSION;
    }
  }
  if (path === undefined) {
    if (scoped) throw new Error('routing handoff refused');
    return undefined;
  }
  const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
  const privateDir = (dir: string) => {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
      || (process.getuid && stat.uid !== process.getuid())) throw new Error();
    return stat;
  };
  let fd: number | undefined;
  let owned: { file: Stats; directory: Stats; root: Stats } | undefined;
  let payload: RoutingHandoffV1 | undefined;
  let failed = false;
  const directory = dirname(path), root = dirname(directory);
  try {
    if (!isAbsolute(path) || normalize(path) !== path || basename(root) !== '.routing-handoffs'
      || !/^inc_[a-f0-9]{32}$/.test(basename(directory)) || !/^[a-f0-9]{32}\.json$/.test(basename(path))) throw new Error();
    const rootStat = privateDir(root), directoryStat = privateDir(directory);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
      || (process.getuid && before.uid !== process.getuid())) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(fd);
    if (!same(file, before) || !file.isFile() || file.nlink !== 1 || (file.mode & 0o777) !== 0o600
      || file.uid !== before.uid || !same(privateDir(root), rootStat) || !same(privateDir(directory), directoryStat)) throw new Error();
    owned = { file, root: rootStat, directory: directoryStat };
    if (file.size > 16_384) throw new Error();
    const bytes = Buffer.alloc(16_385);
    let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    const after = fstatSync(fd);
    if (length > 16_384 || length !== file.size || after.size !== file.size || after.mtimeMs !== file.mtimeMs
      || after.ctimeMs !== file.ctimeMs) throw new Error();
    const p = JSON.parse(bytes.subarray(0, length).toString('utf8')) as RoutingHandoffV1;
    const now = (args.now ?? Date.now)();
    if (!p || p.version !== 'routing-handoff-v1' || p.incarnation !== basename(directory)
      || p.nonce + '.json' !== basename(path) || !exactHttpsOrigin(args.origin) || p.origin !== args.origin
      || typeof p.orgId !== 'string' || !p.orgId.trim()
      || Object.hasOwn(p, 'credential')
      || typeof p.sessionId !== 'string' || !/^rs_[a-f0-9-]{36}$/.test(p.sessionId)
      || typeof p.shiftId !== 'string' || !p.shiftId.startsWith('shf_')
      || (p.workRoot !== undefined && (typeof p.workRoot !== 'string'
	|| !isAbsolute(p.workRoot) || normalize(p.workRoot) !== p.workRoot))
      || (p.workRepo !== undefined && (typeof p.workRepo !== 'string'
	|| !isAbsolute(p.workRepo) || normalize(p.workRepo) !== p.workRepo))
      || (p.broker !== undefined && (!p.broker || typeof p.broker !== 'object'
	|| typeof p.broker.socketPath !== 'string' || !isAbsolute(p.broker.socketPath)
	|| normalize(p.broker.socketPath) !== p.broker.socketPath
	|| basename(p.broker.socketPath) !== 'broker.sock'
	|| !/^ol-rb-[A-Za-z0-9]{6}$/.test(basename(dirname(p.broker.socketPath)))
	|| typeof p.broker.cap !== 'string' || !/^[a-f0-9]{64}$/.test(p.broker.cap)))
      || (p.holderBroker !== undefined && (args.kind !== 'agent-run' || !p.broker
	|| !p.holderBroker || typeof p.holderBroker !== 'object'
	|| p.holderBroker.socketPath !== p.broker.socketPath
	|| typeof p.holderBroker.cap !== 'string' || !/^[a-f0-9]{64}$/.test(p.holderBroker.cap)
	|| p.holderBroker.cap === p.broker.cap))
      || (p.definitionStage !== undefined && (!p.definitionStage
	|| typeof p.definitionStage.path !== 'string' || !isAbsolute(p.definitionStage.path)
	|| normalize(p.definitionStage.path) !== p.definitionStage.path
	|| !basename(p.definitionStage.path).startsWith('.routing-def-')
	|| typeof p.definitionStage.digest !== 'string'
	|| !/^[0-9a-f]{64}$/.test(p.definitionStage.digest)))
      || !Number.isSafeInteger(p.createdAt) || !Number.isSafeInteger(p.expiresAt)
      || !Number.isSafeInteger(p.sessionExpiresAt) || p.createdAt > now || p.expiresAt <= now
      || p.expiresAt > p.createdAt + 120_000 || p.expiresAt > p.sessionExpiresAt
      || !p.reservation || p.reservation.recordType !== 'reservation'
      || p.reservation.workflow !== args.target.workflow || p.reservation.run !== args.target.run
      || p.reservation.childKind !== args.kind || !/^[a-f0-9]{32}$/.test(p.reservation.token)
      || !Number.isSafeInteger(p.reservation.reservedAt) || p.reservation.reservedAt > p.createdAt
      || p.createdAt - p.reservation.reservedAt > 120_000) throw new Error();
    payload = p;
  } catch { failed = true; }
  finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { failed = true; }
    }
    if (owned) {
      try {
	const current = lstatSync(path);
	if (!same(privateDir(root), owned.root) || !same(privateDir(directory), owned.directory)
	  || !current.isFile() || current.isSymbolicLink() || !same(current, owned.file)) failed = true;
	else unlinkSync(path);
      } catch { failed = true; }
    }
  }
  if (failed || !payload) throw new Error('routing handoff refused');
  return payload;
}
