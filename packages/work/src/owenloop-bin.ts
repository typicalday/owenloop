/**
 * Resolve this installation's packaged Owenloop entrypoint.
 *
 * Source-driven tests import `packages/work/src/**`, while built/runtime code
 * imports `dist/packages/work/src/**`; those layouts are one parent apart.
 * Every child Owenloop process must use this resolver so a stale executable
 * earlier on PATH cannot split a Shift, its worker, and the worker's born-bound
 * MCP server across different installations.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolveOwenloopBin(): string {
  const candidates = [
    new URL('../../../bin/owenloop.mjs', import.meta.url),
    new URL('../../../../bin/owenloop.mjs', import.meta.url),
  ].map((url) => fileURLToPath(url));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
