import { realpathSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

/** Resolve existing directory aliases without following the socket or creating any directories. */
function physicalParent(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    const parent = dirname(path);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw error;
    return join(physicalParent(parent), basename(path));
  }
}

/** Only the kernel address needs to be short. State, permissions and cleanup use the original path. */
export function shiftSocketAddress(path: string, platform: NodeJS.Platform = process.platform): string {
  const limit = platform === 'darwin' ? 104 : platform === 'linux' ? 108 : undefined;
  if (limit === undefined || Buffer.byteLength(path) <= limit) return path;

  const cwd = process.cwd();
  const fromHere = relative(cwd, path);
  if (Buffer.byteLength(fromHere) <= limit) return fromHere;

  const physical = join(physicalParent(dirname(path)), basename(path));
  if (Buffer.byteLength(physical) <= limit) return physical;
  const fromPhysicalCwd = relative(realpathSync.native(cwd), physical);
  if (Buffer.byteLength(fromPhysicalCwd) <= limit) return fromPhysicalCwd;

  throw new Error(
    `Shift socket path exceeds the ${limit}-byte limit on ${platform}: ${path} ` +
    `(${Buffer.byteLength(path)} bytes). Run Shift from the state directory with --state-dir . or choose a shorter --state-dir.`,
  );
}

export function shiftStartupLockPath(socketPath: string): string {
  return `${socketPath}.lock`;
}
