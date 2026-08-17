/**
 * `owenloop work agent-run <order-id>` (Phase 3) — the detached, self-leasing worker
 * that HOSTS one step agent, and the harness-registry COMPOSITION ROOT.
 *
 * The shift spawns one detached
 * `owenloop work agent-run <workflow>/<run> --origin <url>` per AGENT order — the
 * ONLY path an agent order takes, since Phase 5 deleted the legacy stamp path
 * it used to share the lane with. This
 * process owns that order end to end: it takes the lease on first contact,
 * renders the step's brief, starts the step agent inside a harness adapter with
 * a work-holder MCP mount born bound to this order, keeps the lease warm
 * underneath the turn, and learns whether the agent submitted FROM THE HUB.
 * Nothing is ever written to any agent-definition directory.
 *
 * The orchestration CORE lives in `src/agent/loop.ts` (lease + adapter + confirm
 * phase, every side effect injected); this role only parses the arg contract,
 * resolves origin/credential/cache, tags the holder identity, resolves WHICH
 * adapter hosts the agent, loads the brief template, wires the signal seam, and
 * maps `AgentRunOutcome` to an exit code.
 *
 * ── WHERE THE ADAPTERS COME FROM (Phase 6) ──
 *
 * `src/harness/registry.ts` starts empty and forbids a barrel, so SOMEBODY has
 * to import the adapter modules for their `register(...)` side effect to fire.
 * Through Phase 5 that somebody was this file AND `src/roles/lint.ts`, each
 * carrying the same import pair in the same hand-maintained order. Phase 6
 * consolidated both into `src/harnesses.ts`; this file imports THAT, and the
 * single line is directly below the header. Adapter import order — which decides
 * the default harness — now has exactly one owner.
 *
 * ── WHERE THE STEP SPEC COMES FROM ──
 *
 * The order packet carries a `defDigest` reference but no authoritative prompt,
 * harness, or permission text. The worker resolves the digest and step name
 * through the verified local workflow store. The prepare cache remains available
 * for routing and session state, but never supplies execution instructions.
 *
 * ── CREDENTIALS ──
 *
 * Origin/credential resolution mirrors `exec`: origin `--origin` → settings; the
 * bearer comes from owenloop's store via `resolveBearer`, reading the
 * `agent:<account>` slot for the account the shift set in this child's
 * `OWENLOOP_ACCOUNT` spawn env (default `default`). `agent-run` has NO `--as`
 * flag — the spawn-env channel is the contract.
 *
 * D10, CLOSED IN PHASE 6. The MCP mount this worker builds carries no
 * credential — the mounted work-holder resolves its own from the same store —
 * and as of Phase 6 the dev-only `OWENLOOP_TOKEN` override is no longer
 * inherited by the harness child either. Both adapters filter it out through
 * `filterOwenloopEnv` (`src/harness/child-env.ts`), an allowlist scoped to the
 * `OWENLOOP_*` namespace ONLY, so nothing a harness needs in order to start —
 * `PATH`, `HOME`, `NODE_OPTIONS`, a shift setting, a vendor's own credential
 * variable — can be stranded by it.
 *
 * The consequence lands in this file: because the child cannot see the override,
 * THIS ROLE IGNORES IT TOO, so worker and child authenticate as the same
 * principal. See the block around the `resolveBearer` call. `resolveBearer`
 * itself is unchanged and every other role still honours the override.
 *
 * Phase 4's narrower guarantee still holds and is still asserted: the rejection
 * delta and the replay brief carry no credential material
 * (`test/agent-rejection.test.ts`).
 *
 * ── WHERE THE STEP AGENT WORKS (Phase 4) ──
 *
 * `OrderPacket.workdir` (the hub's choice) > `<workRoot>/<workflow>/<run>/` >
 * this process's cwd. The middle rung is new: see `src/agent/workdir.ts` for the
 * per-RUN layout and the reaper that removes it.
 */
// ── The composition root, imported for its side effect ──────────────────────
//
// PHASE 6: this file used to carry the adapter imports itself, and so did
// `src/roles/lint.ts` — two roots whose import ORDER had to be kept identical by
// hand, because the first id registered is the default harness. Both now import
// the single root, `src/harnesses.ts`, which owns that order. Without this line
// nothing is registered and every run fails with `'no-harness'`.
import '../harnesses.ts';
// ─────────────────────────────────────────────────────────────────────────────
import { hostname } from 'node:os';

import { resolveCacheDir } from '../bundle/cache.ts';
import {
  createAgentRunLoop,
  type AdapterResolution,
  type AgentRunOutcome,
  type CrewRosterResolution,
} from '../agent/loop.ts';
import { createDefaultStoreInstructionResolver, type InstructionResolver } from '../exec/instructions.ts';
import { createConsumedVerifier, type ConsumedVerifier } from '../consumed-verifier.ts';
import type { NormalizedStepSpec } from '../bundle/types.ts';
import { createHubClient, type HubClient } from '../hub/client.ts';
import { resolveBearer } from '../credentials/resolve.ts';
import { loadSettings } from '../settings/settings.ts';
import { effectiveRosterLayers, mergeRosterLayers, type MergedRoster } from '../settings/roster.ts';
import { adapterFor, defaultHarnessId, registeredHarnessIds } from '../harness/registry.ts';
import { parseHarnessCarrier } from '../bundle/fetch.ts';
import { normalizeStepPermissions, validateHarnessOptions } from '../harness/permissions.ts';
import {
  appendSession,
  latestForTask,
  sessionsPath,
  type SessionRecord,
} from '../harness/session-store.ts';
import {
  ensureWorkDir,
  resolveAllowedWorkdirRoots,
  resolveWorkRepo,
  resolveWorkRoot,
} from '../agent/workdir.ts';
import type { ContactHolder, OrderPacket } from '../hub/types.ts';
import { resolveShiftId, resolveTarget } from './hold.ts';
import { installSignalHandlers, type SignalHost } from './signals.ts';

const DEFAULT_INTERVAL_MS = 60_000;

interface ParsedArgs {
  orderId?: string;
  workflow?: string;
  origin?: string;
  shift?: string;
  harness?: string;
  heartbeatIntervalMs?: number;
  jumpToleranceMs?: number;
  submitGraceMs?: number;
  confirmIntervalMs?: number;
  error?: string;
}

/** Positive-integer flag parse shared by the four ms knobs. */
function positiveMs(name: string, raw: string): { value: number } | { error: string } {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { error: `${name} must be a positive integer, got '${raw}'` };
  }
  return { value: n };
}

/**
 * Parse the positional `<order-id>` plus `--workflow`/`--origin`/`--shift`/
 * `--harness`/`--heartbeat-interval`/`--jump-tolerance`/`--submit-grace`/
 * `--confirm-interval`. Supports `--flag value` and `--flag=value`; a second
 * positional or an unknown flag is an error. Mirrors `src/roles/exec.ts`.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  const takeValue = (a: string, i: number): { value: string; next: number } | { error: string } => {
    const eq = a.indexOf('=');
    if (eq !== -1) return { value: a.slice(eq + 1), next: i };
    const v = args[i + 1];
    if (v === undefined) return { error: `missing value for ${a}` };
    return { value: v, next: i + 1 };
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-')) {
      if (parsed.orderId !== undefined) return { error: `unexpected extra argument '${a}'` };
      parsed.orderId = a;
      continue;
    }
    const name = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    switch (name) {
      case '--workflow':
      case '--origin':
      case '--shift':
      case '--harness':
      case '--heartbeat-interval':
      case '--jump-tolerance':
      case '--submit-grace':
      case '--confirm-interval': {
        const r = takeValue(a, i);
        if ('error' in r) return { error: r.error };
        i = r.next;
        if (name === '--workflow') parsed.workflow = r.value;
        else if (name === '--origin') parsed.origin = r.value;
        else if (name === '--shift') parsed.shift = r.value;
	else if (name === '--harness') {
	  parsed.harness = r.value;
	} else {
          const n = positiveMs(name, r.value);
          if ('error' in n) return { error: n.error };
          if (name === '--heartbeat-interval') parsed.heartbeatIntervalMs = n.value;
          else if (name === '--jump-tolerance') parsed.jumpToleranceMs = n.value;
          else if (name === '--submit-grace') parsed.submitGraceMs = n.value;
          else parsed.confirmIntervalMs = n.value;
        }
        break;
      }
      default:
        return { error: `unknown option '${a}'` };
    }
  }
  return parsed;
}

function usage(): void {
  process.stderr.write(
    'usage: owenloop work agent-run <workflow>/<run> [--origin <url>] [--harness <id>] [--shift <id>]\n' +
      '                         [--heartbeat-interval <ms>] [--jump-tolerance <ms>]\n' +
      '                         [--submit-grace <ms>] [--confirm-interval <ms>]\n' +
      '   or: owenloop work agent-run <run> --workflow <wf> [...]\n',
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map the loop's outcome onto the process exit code (see usage.ts). */
export function exitCodeFor(outcome: AgentRunOutcome): number {
  switch (outcome) {
    case 'submitted':
    case 'completed':
      return 0;
    case 'misroute':
    case 'workdir-denied':
    case 'no-template':
    case 'no-harness':
    case 'incompatible-harness-policy':
    case 'unstamped-order':
    case 'unresolvable-crew':
    case 'unresolvable-capability':
    case 'unverified-consumed':
    case 'session-store-failed':
    case 'no-submit':
    case 'killed':
    case 'lease-lost':
    case 'ownership-error':
    case 'hub-unreachable':
    case 'stopped':
      return 1;
  }
}

/**
 * Injectable process-boundary deps for `run` — defaulting to the real ones, so
 * the role wiring (holder tag, adapter resolution, signal handlers, outcome
 * mapping) is testable without spawning a harness, signaling the test process,
 * or reaching a real hub.
 */
export interface RunDeps {
  signalHost?: SignalHost;
  hub?: HubClient;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Store-backed instruction resolver; injected tests may provide a fake. */
  instructions?: InstructionResolver;
  /** Consume-side verifier; injected tests may provide a fake. */
  consumedVerifier?: ConsumedVerifier;
  /** Environment used to derive the global workflow-store root. */
  env?: Record<string, string | undefined>;
  /** cwd for an order that carries no `workdir` (default `process.cwd()`). */
  cwd?: string;
  /**
   * Holder id override (default `<hostname>:<pid>`) — pinned in tests. Injecting
   * `hub` also skips credential resolution entirely, so a test needs no
   * owenloop credential store on disk.
   */
  holderId?: string;
}

/**
 * Import the module named by `OWENLOOP_HARNESS_MODULE`, if any, so its
 * `register(...)` side effect fires before adapter resolution.
 *
 * TEST SEAM. Phase 4 filled the composition root's static import block above
 * with the real adapters, so production no longer needs this to have ANY
 * adapter at all. What it still buys is the ability for a drill to register a
 * FAKE adapter inside a real spawned child without the child reaching for a
 * real CLI. Production leaves the variable unset and this is a no-op. Drills
 * that use it select a fake adapter through a roster candidate, because the
 * statically imported real adapters occupy the front of the registry and would
 * otherwise win the `defaultHarnessId()` tie-break. A failed import is
 * reported and then ignored — resolution proceeds and fails honestly with
 * `'no-harness'` if nothing ended up registered.
 */
async function loadHarnessModule(spec: string | undefined, err: (line: string) => void): Promise<void> {
  if (spec === undefined || spec.trim() === '') return;
  try {
    await import(spec);
  } catch (e) {
    err(`owenloop work agent-run: could not load OWENLOOP_HARNESS_MODULE '${spec}': ${errMsg(e)}`);
  }
}

export async function run(args: string[], deps: RunDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const parsed = parseArgs(args);
  if (parsed.error !== undefined) {
    err(`owenloop work agent-run: ${parsed.error}`);
    usage();
    return 2;
  }
  if (parsed.orderId === undefined || parsed.orderId === '') {
    err('owenloop work agent-run: missing required <order-id>');
    usage();
    return 2;
  }

  const target = resolveTarget(parsed.orderId, parsed.workflow);
  if ('error' in target) {
    err(`owenloop work agent-run: ${target.error}`);
    usage();
    return 2;
  }

  const env = deps.env ?? process.env;
  let settings;
  try {
    settings = loadSettings(env);
  } catch (e) {
    err(`owenloop work agent-run: ${errMsg(e)}`);
    return 1;
  }

  const origin = parsed.origin ?? settings.hubOrigin;
  if (origin === undefined || origin.trim() === '') {
    err('owenloop work agent-run: no hub origin — pass --origin <url> or set hubOrigin in settings');
    return 2;
  }

  const consumedVerifier = deps.consumedVerifier ?? createConsumedVerifier({
    env,
    now: () => Date.now(),
  });

  const instructionCwd = deps.cwd ?? process.cwd();
  let instructions = deps.instructions;
  if (instructions === undefined) {
    try {
      instructions = createDefaultStoreInstructionResolver({ cwd: instructionCwd, env, consumedVerifier });
    } catch (e) {
      err(`owenloop work agent-run: instruction store unavailable: ${errMsg(e)}`);
      return 1;
    }
  }

  let cacheDir: string;
  try {
    cacheDir = resolveCacheDir(env, settings.cacheDir);
  } catch (e) {
    err(`owenloop work agent-run: ${errMsg(e)}`);
    return 1;
  }

  // D10, CLOSED in Phase 6 (see the header). The dev-only bearer override is no
  // longer passed to harness children: `filterOwenloopEnv` denies it in both
  // adapters, because a harness child is an ordinary process that inherits this
  // environment and at least one harness persists its start parameters to disk.
  //
  // THIS BLOCK IS THE OTHER HALF OF THAT CHANGE, and the two must stay together.
  // If the worker kept honouring the override while the child could not see it,
  // the two sides would authenticate as different principals: the worker with
  // the override, the child falling back to its `agent:<account>` credential
  // slot. An empty slot would then surface mid-order as an opaque MCP handshake
  // failure, long after startup. So `agent-run` ignores the override too. Both
  // sides now read the same slot, and an empty slot fails at STARTUP through
  // `resolveBearer`'s existing exit-code-2 refusal, whose message names the
  // login command to run.
  //
  // SCOPE: this file only. `resolveBearer` is unchanged and every other role
  // keeps the override — `agent-run` is the one role that spawns a harness.
  const workerEnv = { ...env };
  if ((workerEnv['OWENLOOP_TOKEN'] ?? '') !== '') {
    delete workerEnv['OWENLOOP_TOKEN'];
    err(
      'owenloop work agent-run: OWENLOOP_TOKEN is set and is being IGNORED here. The dev-only ' +
        'bearer override is not passed to harness children, so honouring it would ' +
        'authenticate the worker and the harness child as different principals. ' +
        'Authenticate the account instead: `owenloop login --hub <origin> --as agent:<account>`.',
    );
  }

  const account = workerEnv['OWENLOOP_ACCOUNT'] ?? 'default';
  // The crews the HUB STAMPED on the order decide which rosters apply, so this
  // runs per order inside the loop — the stamp does not exist at process start.
  const resolveCrewRosters = (crews: readonly string[]): CrewRosterResolution => {
    const rosters: MergedRoster[] = [];
    for (const crew of crews) {
      try {
				rosters.push(mergeRosterLayers(effectiveRosterLayers(env, crew, { origin, account })));
      } catch (e) {
				return { ok: false, crew, detail: errMsg(e) };
      }
    }
    return { ok: true, rosters };
  };
  let hub = deps.hub;
  if (hub === undefined) {
    const bearer = await resolveBearer({ origin, account, env: workerEnv });
    if (!bearer.ok) {
      err(`owenloop work agent-run: ${bearer.message}`);
      return bearer.code;
    }
    const token = bearer.token;
    hub = createHubClient({ origin, getToken: async () => token });
  }
  const client = hub;

  await loadHarnessModule(env['OWENLOOP_HARNESS_MODULE'], err);

  const shiftId = resolveShiftId(parsed.shift, env);
  const shiftName = env['OWENLOOP_SHIFT_NAME'];
  const shiftOwner = env['OWENLOOP_SHIFT_OWNER'];
  const holder: ContactHolder = {
    kind: 'exec',
    id: deps.holderId ?? `${hostname()}:${process.pid}`,
    ...(shiftId !== undefined ? { shiftId } : {}),
  };

  /**
   * The winning roster candidate is deliberately above the debug --harness
   * flag: it extends the existing rule that resolved routing wins over a
   * step's authored model and effort. Every rank is a plain string comparison.
   */
  const resolveAdapter = (
    chosenHarness: string | undefined,
    stepHarness: string | undefined,
  ): AdapterResolution => {
    const id =
      chosenHarness ??
      parsed.harness ??
      (stepHarness !== undefined && stepHarness !== '' ? stepHarness : undefined) ??
      defaultHarnessId() ??
      '';
    const adapter = id !== '' ? adapterFor(id) : undefined;
    return {
      // Keep an explicit blank `--harness` visible to the refusal instead of
      // silently treating it as an absent override and selecting the default.
      // A roster candidate still outranks it at the line above.
      id: id !== '' || parsed.harness !== undefined ? id : '<none>',
      ...(adapter !== undefined ? { adapter } : {}),
      registered: registeredHarnessIds(),
    };
  };

  /** Resolve the verified step from the local workflow store, never the prepare cache. */
  const loadStep = async (order: OrderPacket): Promise<NormalizedStepSpec | null> => {
    let resolved;
    try {
      resolved = await instructions.resolveStep(order);
    } catch (e) {
      err(`owenloop work agent-run: instruction refusal (integrity): ${errMsg(e)}`);
      return null;
    }
    if (!resolved.ok) {
      err(`owenloop work agent-run: ${resolved.reason}`);
      return null;
    }

    // Harness adapters build their child environment from process.env. This
    // worker owns one agent order, so the resolver-derived bundle root is
    // per-order state; clear it when provenance is absent to prevent stale
    // values from reaching a later step in the same process.
    if (resolved.bundleDir !== undefined) process.env['OWENLOOP_BUNDLE_DIR'] = resolved.bundleDir;
    else delete process.env['OWENLOOP_BUNDLE_DIR'];

    // Run identity is engine-derived from this worker's target, never a consumed
    // artifact value. Both registered adapter paths read process.env when they
    // build their child environments, so one setter covers both; overwrite
    // ambient values so a nested agent sees its own identity, not its parent's.
    process.env['OWENLOOP_WORKFLOW'] = target.workflow;
    process.env['OWENLOOP_RUN'] = target.run;

    let carrier: ReturnType<typeof parseHarnessCarrier>;
    const rawStep = resolved.step as unknown as Record<string, unknown>;
    try {
      carrier = parseHarnessCarrier(rawStep, order.workflow, resolved.step.name);
    } catch (e) {
      err(`owenloop work agent-run: instruction refusal (harness-carrier): ${errMsg(e)}`);
      return null;
    }

    if (carrier.harnessOptions !== undefined) {
      const errors = validateHarnessOptions(carrier.harnessOptions, resolved.step.name)
	.filter((finding) => finding.severity === 'error');
      if (errors.length > 0) {
	for (const finding of errors) {
	  err(
	    `owenloop work agent-run: instruction refusal (harness-policy): step '${finding.step}' ` +
	      `x.harness.${finding.field ?? '<bag>'}: ${finding.message}`,
	  );
	}
	return null;
      }
    }

    return {
      step: resolved.step.name,
      brief: resolved.step.body,
      ...(carrier.harness !== undefined ? { harness: carrier.harness } : {}),
      permissions: normalizeStepPermissions(carrier.harnessOptions, resolved.step),
    };
  };

  /**
   * The session-store sink. A durable `active` row is a provider-work start
   * gate: failure propagates to the loop, which abandons the turn and releases
   * the order before delivery. Later lifecycle rows remain best-effort resume
   * metadata and are reported without replacing the lease as the hub truth.
   */
  const sessionsFile = sessionsPath(cacheDir);
  const writeSession = (rec: SessionRecord): void => {
    try {
      appendSession(sessionsFile, rec, { warn: err });
    } catch (e) {
      err(`owenloop work agent-run: could not record the session in ${sessionsFile}: ${errMsg(e)}`);
      if (rec.status === 'active') throw e;
    }
  };

  /**
   * PHASE 4 — where the step agent works when the hub supplies no `workdir`.
   *
   * Precedence, highest first:
   *  1. `deps.cwd` — the test seam. An injected cwd is an explicit instruction
   *     and must not be second-guessed by a settings key.
   *  2. `<workRoot>/<workflow>/<run>/`, created here.
   *  3. `process.cwd()`, if creating that directory fails.
   *
   * `OrderPacket.workdir` outranks all three, but it lives on the packet, which
   * this role never sees — `src/agent/loop.ts` applies it over whatever is
   * passed here.
   *
   * Created EAGERLY, before the first order arrives, because the loop takes a
   * plain `cwd: string` and turning it into a thunk would push a filesystem
   * concern into the pure orchestration core. The cost of being early is one
   * empty directory for a run whose packets all carry a hub `workdir`; the
   * reaper removes it on the same terms as any other.
   */
  let workCwd = deps.cwd ?? process.cwd();
  if (deps.cwd === undefined) {
    const workRoot = resolveWorkRoot(env, settings.workRoot, cacheDir);
    const workRepo = resolveWorkRepo(env, settings.workRepo);
    try {
      workCwd = ensureWorkDir({
        workRoot,
        workflow: target.workflow,
        run: target.run,
        ...(workRepo !== undefined ? { workRepo } : {}),
        err,
      });
    } catch (e) {
      err(
        `owenloop work agent-run: could not create a work directory under ${workRoot}: ${errMsg(e)} — ` +
          `falling back to ${workCwd}`,
      );
    }
  }

  const loop = createAgentRunLoop({
    hub: client,
    workflow: target.workflow,
    run: target.run,
    holder,
    origin,
    account,
    ...(shiftId !== undefined ? { shiftId } : {}),
    ...(shiftName !== undefined && shiftName !== '' ? { shiftName } : {}),
    ...(shiftOwner !== undefined && shiftOwner !== '' ? { shiftOwner } : {}),
    cwd: workCwd,
    // Machine policy, resolved from the SAME two sources the shift resolves it
    // from: `OWENLOOP_ALLOWED_WORKDIR_ROOTS` (which `owenloop shift start`
    // exports when the operator passed `--work-root`) then the settings file.
    // Resolved against `process.cwd()`, not `workCwd`: a relative root in the
    // env means "relative to where this process was launched", and `workCwd`
    // may be a directory owenloop just created under the cache root.
    allowedWorkdirRoots: resolveAllowedWorkdirRoots(env, settings.allowedWorkdirRoots, process.cwd()),
    loadStep,
    resolveAdapter,
    resolveCrewRosters,
    // Phase-1 availability means registry membership. A real binary or
    // credential probe requires new HarnessAdapter contract surface.
    harnessAvailable: (id) => adapterFor(id) !== undefined,
    consumedVerifier,
    appendSession: writeSession,
    // Both readers key on the engine TASK — `(workflow, step, key)` — and not on
    // `(workflow, run, step)`. The hub mints a fresh run id every time it claims
    // a step, so a run-keyed lookup can only ever see records written by the
    // firing that is asking: `nextAttempt` returned 1 forever and `latestSession`
    // returned null forever, which made the whole resume path unreachable.
    nextAttempt: (task) => {
      const prev = latestForTask(sessionsFile, task);
      return prev === null ? 1 : prev.attempt + 1;
    },
    // PHASE 4: the same reader `nextAttempt` uses, handed to the loop whole so
    // it can decide resume vs cold replay. Reads only; the loop is what writes.
    latestSession: (task) => latestForTask(sessionsFile, task),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    out,
    err,
    heartbeatIntervalMs: parsed.heartbeatIntervalMs ?? DEFAULT_INTERVAL_MS,
    // Test affordances only: each exposes an existing knob (defaults unchanged)
    // so a drill can provoke a clock jump or a short confirm without waiting.
    ...(parsed.jumpToleranceMs !== undefined ? { jumpToleranceMs: parsed.jumpToleranceMs } : {}),
    ...(parsed.submitGraceMs !== undefined ? { submitGraceMs: parsed.submitGraceMs } : {}),
    ...(parsed.confirmIntervalMs !== undefined ? { confirmIntervalMs: parsed.confirmIntervalMs } : {}),
  });

  installSignalHandlers(loop, deps.signalHost ?? process, err, {
    role: 'agent-run',
    drainNote: 'stopping the step agent and releasing the order',
    stopReason: 'signal',
  });

  const outcome = await loop.run();
  return exitCodeFor(outcome);
}
