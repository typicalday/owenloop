/**
 * The detached-exec spawn seam (plan decision 6).
 *
 * Every order the proxy dispatches becomes a DETACHED
 * `owenloop work exec <workflow>/<run> --origin <url>` child: `detached: true`,
 * `stdio: 'ignore'`, `unref()` — so the child is its own process-group leader and
 * survives the parent's death (SP5-verified kernel reparenting). The proxy meters
 * and hands off; the child self-leases (C5). Both ids ride the argv as the
 * composite `<workflow>/<run>` order-id `owenloop work exec` parses, and `--origin`
 * is passed through so the detached child reaches the SAME hub the proxy is
 * parked at without re-reading settings. The proxy-resolved account rides the
 * child's spawn ENV as `OWENWORK_ACCOUNT` (exec has no `--as` flag — the spawn
 * env is the contract), selecting which Scoped Identity credential slot
 * (agent:<account>) exec reads.
 *
 * `Spawner` is an injected seam; unit tests always fake it and NEVER spawn a
 * real child. The default impl's argv/option construction is factored into the
 * pure `buildSpawnPlan` so a test can assert the exact shape as data.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * What to spawn: the order to run. `run` IS the order id (hub verb contract);
 * `workflow` pairs with it (every hub verb needs both). The hub `origin` is NOT
 * here — it is captured by `createDefaultSpawner` (one hub per proxy), so the
 * loop, which knows only the order, calls the seam without carrying it.
 */
export interface SpawnSpec {
  workflow: string;
  run: string;
  /**
   * Which role the detached child runs (Phase 3). Absent ⇒ `'exec'`, so every
   * pre-Phase-3 caller and every faked spawner in the existing tests keeps its
   * exact meaning.
   *
   *  - `'exec'`     — a COMMAND order; the child runs `owenloop work exec`.
   *  - `'agent-run'` — an AGENT order; the child runs `owenloop work agent-run` and
   *    hosts the step agent itself. This is the ONLY agent path.
   */
  kind?: 'exec' | 'agent-run';
  /**
   * The harness id to host the step agent in, for `kind: 'agent-run'` only.
   * Absent carries no `--harness` flag, leaving the child to resolve the id
   * from `OWENWORK_HARNESS`, the step def, or its built-in default. Ignored for
   * `'exec'` (a command order has no step agent).
   */
  harness?: string;
}

/** The result the loop records: the child's pid. */
export interface SpawnResult {
  pid: number;
}

/** The spawn seam. Injected; faked in tests. */
export type Spawner = (spec: SpawnSpec) => SpawnResult;

/** The fully-resolved spawn arguments — pure data, asserted directly in tests. */
export interface SpawnPlan {
  command: string;
  args: string[];
  options: { detached: true; stdio: 'ignore'; env: NodeJS.ProcessEnv };
}

/**
 * Resolve the single packaged `bin/owenloop.mjs` from this module's URL.
 *
 * Source-driven tests import `packages/work/src/**`, while installed/runtime
 * execution imports `dist/packages/work/src/**`; those layouts are one parent
 * level apart. Choose the existing candidate so detached children use the root
 * binary in both layouts.
 */
export function resolveOwenloopBin(): string {
  const candidates = [
    new URL('../../../../bin/owenloop.mjs', import.meta.url),
    new URL('../../../../../bin/owenloop.mjs', import.meta.url),
  ].map((url) => fileURLToPath(url));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/**
 * Build the argv + options for a detached
 * `owenloop work exec <workflow>/<run> --origin <url>`. Pure — no spawn, no I/O — so
 * tests assert the shape without launching anything. Runs the bin under the
 * current Node (`execPath`), matching the `owenloop work exec <order-id>` arg contract
 * (the composite `<workflow>/<run>` carries both ids in one positional).
 *
 * The account is NOT an argv flag — it rides `options.env.OWENWORK_ACCOUNT`.
 * `env` starts from `process.env` so the detached child keeps the parent's
 * environment inheritance (which is otherwise implicit when `env` is unset),
 * then sets the resolved account on top.
 *
 * `conductorId` (W7, trailing — after `execPath` so existing positional
 * callers are unaffected), when non-empty, appends `--conductor <cid>` so the
 * spawned `owenloop work exec` child self-declares which Conductor dispatched it
 * (advisory only, D8/INV-82). Omitted/empty carries no flag at all.
 *
 * Phase 3 (D6) widens this ONE seam rather than adding a second: `spec.kind`
 * selects the role positional (`exec` vs `agent-run`) and `spec.harness`
 * appends `--harness <id>` on the `agent-run` branch. Everything else — the
 * composite order positional, `--origin`, `--conductor`, and every spawn option
 * — is identical for both kinds, so an agent-run child is detached,
 * stdio-ignored, and account-scoped exactly like an exec child.
 */
export function buildSpawnPlan(
  spec: SpawnSpec,
  origin: string,
  account: string,
  binPath: string,
  execPath: string = process.execPath,
  conductorId?: string,
): SpawnPlan {
  const role = spec.kind === 'agent-run' ? 'agent-run' : 'exec';
  return {
    command: execPath,
    args: [
      binPath,
      'work',
      role,
      `${spec.workflow}/${spec.run}`,
      '--origin',
      origin,
      ...(conductorId !== undefined && conductorId !== '' ? ['--conductor', conductorId] : []),
      ...(role === 'agent-run' && spec.harness !== undefined && spec.harness !== ''
        ? ['--harness', spec.harness]
        : []),
    ],
    options: { detached: true, stdio: 'ignore', env: { ...process.env, OWENWORK_ACCOUNT: account } },
  };
}

/**
 * The default detached spawner. Captures the resolved hub `origin`, the
 * resolved `account`, the packaged bin path, and the dispatching Conductor's
 * `conductorId` once at construction; each spawn threads them into the
 * child's argv + spawn env. `execPath` is passed explicitly (rather than
 * relying on `buildSpawnPlan`'s default) so `conductorId` — trailing after it
 * — can be supplied positionally.
 */
export function createDefaultSpawner(
  origin: string,
  account: string,
  binPath: string = resolveOwenloopBin(),
  conductorId?: string,
): Spawner {
  return (spec: SpawnSpec): SpawnResult => {
    const plan = buildSpawnPlan(spec, origin, account, binPath, process.execPath, conductorId);
    const child = spawn(plan.command, plan.args, plan.options);
    child.unref();
    if (child.pid === undefined) {
      const role = spec.kind === 'agent-run' ? 'agent-run' : 'exec';
      throw new Error(`spawn of 'owenloop work ${role} ${spec.workflow}/${spec.run}' returned no pid`);
    }
    return { pid: child.pid };
  };
}
