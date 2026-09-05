import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

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
