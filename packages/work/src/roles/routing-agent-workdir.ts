/** Shift-pinned fallback workdir for a routed agent. The public definition
 * stage is never a place for authored code to work. */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { ensureWorkDir, resolveAllowedWorkdirRoots, runWorkDir } from '../agent/workdir.ts';

const refused = (): Error => new Error('routing agent workdir refused');

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve existing symlink ancestors before creating a not-yet-present run dir. */
function futureRealpath(path: string): string {
  const remaining: string[] = [];
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw refused();
    remaining.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...remaining);
}

export function assertRoutedAgentWorkdirDisjoint(workdir: string, privateBase: string): void {
  if (!isAbsolute(workdir) || !isAbsolute(privateBase)) throw refused();
  try {
    const actual = futureRealpath(workdir);
    const privateRoot = realpathSync(privateBase);
    if (inside(actual, privateRoot) || inside(privateRoot, actual)) throw refused();
  } catch { throw refused(); }
}

export function prepareRoutedAgentWorkdir(args: {
  workRoot: string | undefined; workRepo?: string;
  workflow: string; run: string; definitionStagePath: string;
  originalEnv: Record<string, string | undefined>;
  cwd?: string; err?: (line: string) => void;
}): { cwd: string; allowedWorkdirRoots: string[] } {
  const { workRoot, workRepo } = args;
  if (!workRoot || !isAbsolute(workRoot) || resolve(workRoot) !== workRoot
    || (workRepo !== undefined && (!isAbsolute(workRepo) || resolve(workRepo) !== workRepo)))
    throw refused();
  const privateBase = dirname(args.definitionStagePath);
  const planned = runWorkDir(workRoot, args.workflow, args.run);
  assertRoutedAgentWorkdirDisjoint(planned, privateBase);
  if (workRepo) assertRoutedAgentWorkdirDisjoint(workRepo, privateBase);
  // Pin machine policy from the original Shift env before any provider-facing
  // environment is replaced with the public stage HOME/config.
  const allowedWorkdirRoots = resolveAllowedWorkdirRoots(args.originalEnv, undefined,
    args.cwd ?? process.cwd());
  const cwd = ensureWorkDir({ workRoot, workflow: args.workflow, run: args.run,
    ...(workRepo ? { workRepo } : {}), ...(args.err ? { err: args.err } : {}) });
  assertRoutedAgentWorkdirDisjoint(cwd, privateBase);
  return { cwd, allowedWorkdirRoots };
}
