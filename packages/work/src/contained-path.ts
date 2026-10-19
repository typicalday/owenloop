import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { isInside } from './harness/gatekeeper.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve a caller-supplied path to a real file inside one containment root.
 *
 * Two checks, in this order and for two different attacks. The LEXICAL check
 * rejects traversal (`../../etc/passwd`) before the filesystem is touched at
 * all, so a probe cannot learn whether a path outside the root exists. The
 * CANONICAL check then resolves symlinks on both sides and re-tests, because a
 * name that is lexically inside the root can still POINT outside it — the
 * lexical check alone would happily read the target of `evidence.json ->
 * /Users/me/.ssh/id_ed25519`.
 *
 * `errorPrefix` is a machine-readable family name the caller owns, so each
 * consumer keeps its own stable error vocabulary (`submit-value-file-…`,
 * `file-artifact-…`) while the containment logic itself is written once. It is
 * written once deliberately: two copies of a security check drift, and the copy
 * that drifts is the one nobody is looking at.
 */
export async function resolveContainedPath(
  workdir: string,
  relativePath: string,
  errorPrefix: string,
): Promise<string> {
  const candidate = resolve(workdir, relativePath);
  if (!isInside(workdir, candidate)) {
    throw new Error(`${errorPrefix}-outside-workdir: ${relativePath} is outside the run workdir`);
  }
  try {
    const canonicalWorkdir = await realpath(workdir);
    const canonicalCandidate = await realpath(candidate);
    if (!isInside(canonicalWorkdir, canonicalCandidate)) {
      throw new Error(`${errorPrefix}-outside-workdir: ${relativePath} is outside the run workdir`);
    }
    return canonicalCandidate;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${errorPrefix}-outside-workdir:`)) throw error;
    throw new Error(`${errorPrefix}-read-failed: could not read ${relativePath}: ${errorMessage(error)}`);
  }
}

/** Read through one opened file, refusing namespace or content movement. */
export async function readContainedFile(
  workdir: string,
  relativePath: string,
  errorPrefix: string,
): Promise<{ path: string; bytes: Buffer }> {
  const candidate = resolve(workdir, relativePath);
  if (!isInside(workdir, candidate)) {
    throw new Error(`${errorPrefix}-outside-workdir: ${relativePath} is outside the run workdir`);
  }
  const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
    && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs && a.size === b.size;
  const moved = () => new Error(`${errorPrefix}-read-failed: file or containing directory changed during read: ${relativePath}`);
  try {
    const root = await realpath(workdir);
    const rootBefore = await lstat(root, { bigint: true });
    const path = await realpath(candidate);
    if (!isInside(root, path)) {
      throw new Error(`${errorPrefix}-outside-workdir: ${relativePath} is outside the run workdir`);
    }
    if (path === root) throw moved();
    // A returned pathname is not a retained filesystem object. Snapshot every
    // containing directory too: an ancestor can be renamed to a symlink and
    // restored while the leaf itself remains unchanged. Directory metadata
    // fences that movement, including a swap back to the original inode.
    const directories = [root];
    const suffix = relative(root, dirname(path));
    if (suffix !== '') for (const part of suffix.split(sep)) directories.push(join(directories[directories.length - 1]!, part));
    const before: BigIntStats[] = [];
    for (const directory of directories) {
      const info = await lstat(directory, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()) throw moved();
      before.push(info);
    }
    if (!same(rootBefore, before[0]!)) throw moved();
    const fileBefore = await lstat(path, { bigint: true });
    if (!fileBefore.isFile() || fileBefore.isSymbolicLink()) throw moved();
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!same(fileBefore, await handle.stat({ bigint: true }))) throw moved();
      const bytes = await handle.readFile();
      if (!same(fileBefore, await handle.stat({ bigint: true }))) throw moved();
      if (!same(fileBefore, await lstat(path, { bigint: true }))) throw moved();
      for (let index = directories.length - 1; index >= 0; index--) {
	const after = await lstat(directories[index]!, { bigint: true });
	if (!after.isDirectory() || after.isSymbolicLink() || !same(before[index]!, after)) throw moved();
      }
      return { path, bytes };
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${errorPrefix}-`)) throw error;
    throw new Error(`${errorPrefix}-read-failed: could not read ${relativePath}: ${errorMessage(error)}`);
  }
}
