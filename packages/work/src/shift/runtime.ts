/**
 * `owenloop work shift` — the internal standing Shift loop.
 *
 * The human-facing shift daemon uses the same setup and ShiftLoop through
 * `runShiftRuntime(..., { daemon: true })`; this module remains the single place
 * that resolves settings, credentials, caches, child spawners, and signal
 * behavior. The retired shift stdio-MCP mount is intentionally absent.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createHubClient } from '../hub/client.ts';
import { resolveBearer } from '../credentials/resolve.ts';
import { loadSettings } from '../settings/settings.ts';
import { DEFAULT_HUB_ROSTER_SYNC_TIMEOUT_MS, syncHubRosterCache, withHubRosterSyncTimeout } from '../settings/hub-roster-cache.ts';
import { resolveCacheDir } from '../bundle/cache.ts';
import { createShiftLoop, type ShiftLoop } from './loop.ts';
import { createShiftLogSink } from './logsink.ts';
import { prepareShiftLogDir, shiftLogFile } from './logretention.ts';
import { stampShiftEvent, type ShiftEvent, type ShiftEventBody } from './protocol.ts';
import { createDefaultSpawner, type WorkerFailure } from './spawn.ts';
import { resolveStateDir, ensureStateDir, reconcileInFlight } from './state.ts';
import { reconcileActiveSessions, sessionsPath } from '../harness/session-store.ts';
import {
  resolveAllowedWorkdirRoots,
  resolveWorkRepo,
  resolveWorkRoot,
} from '../agent/workdir.ts';
import { installSignalHandlers, type SignalHost } from '../roles/signals.ts';
import { createShiftDaemon, type ShiftDaemon } from './server.ts';
import {
  createBundleIngestor,
  createStoreInstructionSource,
  globalStoreRoot,
} from '../../../../src/store/index.ts';

// Re-exported so existing importers keep their import site while the
// implementation lives in the shared signals seam.
export { installSignalHandlers, type SignalHost };

const DEFAULT_CAP = 3;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_MAX_AGENTS = 4;
const DEFAULT_PRESENCE_MS = 60_000;
const DEFAULT_ROSTER_SYNC_MS = 15 * 60_000;

/**
 * Record types written to the LOG FILE but never delivered over the socket.
 *
 * The split is not "important vs unimportant" — it is what each consumer is.
 * A record about a UNIT OF WORK THAT MOVED (`dispatched`, `reaped`, `failed`,
 * `order-dropped`, `bundle-miss`, `ended`, `gate`) tells a socket client
 * something it cannot otherwise learn, so it goes to both sinks. Everything
 * else is about the SHIFT'S OWN CONDITION, and that is different on each side:
 *
 * - On the SOCKET it is redundant or harmful. Every `ShiftCapacity` response
 *   already carries live `cap`, `free`, and `running`, so `capacity` and
 *   `parked` restate on the wire what the response states anyway — while
 *   queueing ANY record instantly satisfies a parked `owenloop shift next`,
 *   which must BLOCK until there is work to report. That is the bug this set
 *   exists to prevent: a shift that is merely full, merely idle, or merely
 *   unable to reach the hub would wake every attending terminal with news of
 *   nothing having happened.
 * - In the FILE it is the only record of that condition. The file has no
 *   response envelope, so without these records a reader cannot tell an idle
 *   shift (no orders offered) from a saturated one (orders offered, no slots)
 *   from a stranded one (hub unreachable, so nothing was ever offered).
 *
 * `hub-error` IS IN THIS SET, AND THE REASON IS BOTH HALVES ABOVE.
 *
 * A FAILED HUB CALL IS NOT A UNIT OF WORK MOVING. Nothing was dispatched,
 * reaped, or dropped — the shift failed to ask. So the "a socket client cannot
 * learn it otherwise" justification for both-sinks does not apply, and the
 * blocking contract of `shift next` does.
 *
 * The volume makes it a correctness problem rather than a style one, because
 * `hub-error` is LEVEL-TRIGGERED and cannot self-limit. `noteServerBackoff`
 * (`loop.ts`) sets a backoff only for a `HubError` with `status === 429`; an
 * unreachable hub (ECONNREFUSED, DNS failure, timeout, HTTP 500) sets none, so
 * the loop emits one `hub-error` per poll tick for as long as the outage lasts
 * — about 720/hour per workflow at the 5s default. The socket queue holds
 * `MAX_EVENT_QUEUE` (1000) records and evicts the OLDEST, so roughly 83 minutes
 * of outage would evict every `dispatched`, `failed`, and `reaped` record a
 * parked client actually needs, and every `owenloop shift next` during the
 * outage would return instantly with a record that is not work.
 *
 * `shift.log` is append-only and unbounded, so it still keeps every attempt for
 * an operator to count and time. Whether the FILE should ALSO collapse a long
 * outage into fewer records is a separate, open question (idea
 * W99TXHD9jqwpymifl-5-C) — frequency and routing are independent concerns, and
 * this set is the one that decides routing.
 *
 * `event-queue-overflow` never reaches `consumeEvent` at all — `server.ts`
 * hands it straight to the log sink through `onSynthesized`, because the queue
 * is what overflowed. It is listed here so the category is stated in one place.
 */
const FILE_ONLY_EVENTS: ReadonlySet<ShiftEventBody['type']> = new Set([
  'parked',
  'capacity',
  'hub-error',
  'event-queue-overflow',
]);

/**
 * Does this event type reach the SOCKET consumer (a parked `owenloop shift
 * next`), or only `shift.log`?
 *
 * The routing rule as a pure predicate so it can be asserted directly rather
 * than only through a daemon's timing. `consumeEvent` is its one production
 * caller; a `false` here means the record still reaches the file.
 */
export function reachesSocketConsumer(type: ShiftEventBody['type']): boolean {
  return !FILE_ONLY_EVENTS.has(type);
}

export function resolveCap(flagCap: number | undefined, settingsCap: number | undefined): number {
  return flagCap ?? settingsCap ?? DEFAULT_CAP;
}

export function resolveStateDirOverride(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  settingsStateDir: string | undefined,
): string | undefined {
  return flag ?? env['OWENLOOP_STATE_DIR'] ?? settingsStateDir;
}

export function resolveMaxConcurrentAgents(
  flagMax: number | undefined,
  settingsMax: number | undefined,
): number {
  return flagMax ?? settingsMax ?? DEFAULT_MAX_AGENTS;
}

export function resolveShiftName(
  flagName: string | undefined,
  opts: { shiftId?: string; hostname?: string; cwd?: string; pid?: number } = {},
): string {
  if (flagName !== undefined && flagName !== '') return flagName;
  const suffix =
    opts.shiftId !== undefined && opts.shiftId !== ''
      ? opts.shiftId.replace(/^shf_/, '').replace(/-/g, '').slice(0, 6)
      : `p${opts.pid ?? process.pid}`;
  return `${opts.hostname ?? hostname()}/${basename(opts.cwd ?? process.cwd())}#${suffix}`;
}

export interface ParsedArgs {
  origin?: string;
  as?: string;
  name?: string;
  serveCrews?: string[];
  cap?: number;
  workflow?: string;
  pollIntervalMs?: number;
  once?: boolean;
  maxAgents?: number;
  cacheDir?: string;
  stateDir?: string;
  /** `--log-dir` — where `shift.log` and `<run>.log` are written. */
  logDir?: string;
  /** `--log-max-age` — worker-log retention in milliseconds. `0` reaps eagerly. */
  logMaxAgeMs?: number;
  /**
   * `--work-root <dir>` — REPEATABLE. Each occurrence adds one directory the
   * shift may accept as an order's working directory; passing none leaves the
   * shift unrestricted. Distinct from `settings.workRoot` (singular), which is
   * where owenloop CREATES per-run directories — see `src/agent/workdir.ts`.
   */
  workRoots?: string[];
  error?: string;
}

/** Parse shift's internal `--flag value` and `--flag=value` forms. */
export function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  const takeValue = (a: string, i: number): { value: string; next: number } | { error: string } => {
    const eq = a.indexOf('=');
    if (eq !== -1) return { value: a.slice(eq + 1), next: i };
    const v = args[i + 1];
    if (v === undefined) return { error: `missing value for ${a}` };
    return { value: v, next: i + 1 };
  };
  const intFlag = (raw: string, flag: string): number | { error: string } => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { error: `${flag} must be a non-negative integer, got '${raw}'` };
    }
    return n;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const name = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    switch (name) {
      case '--once':
        parsed.once = true;
        break;
      case '--origin':
      case '--as':
      case '--name':
      case '--serve-crews':
      case '--cap':
      case '--max-agents':
      case '--workflow':
      case '--poll-interval':
      case '--cache-dir':
      case '--log-dir':
      case '--log-max-age':
      case '--work-root':
      case '--state-dir': {
        const r = takeValue(a, i);
        if ('error' in r) return { error: r.error };
        i = r.next;
        if (name === '--origin') parsed.origin = r.value;
        else if (name === '--as') parsed.as = r.value;
        else if (name === '--name') {
          if (r.value.trim() === '') return { error: '--name requires a non-empty value' };
          parsed.name = r.value;
        } else if (name === '--serve-crews') {
          parsed.serveCrews = r.value.split(',').map((s) => s.trim()).filter((s) => s !== '');
        } else if (name === '--workflow') parsed.workflow = r.value;
        else if (name === '--cache-dir') parsed.cacheDir = r.value;
        else if (name === '--state-dir') parsed.stateDir = r.value;
        else if (name === '--log-dir') parsed.logDir = r.value;
        else if (name === '--log-max-age') {
          const n = intFlag(r.value, '--log-max-age');
          if (typeof n !== 'number') return { error: n.error };
          parsed.logMaxAgeMs = n;
        } else if (name === '--cap') {
          const n = intFlag(r.value, '--cap');
          if (typeof n !== 'number') return { error: n.error };
          parsed.cap = n;
        } else if (name === '--max-agents') {
          const n = intFlag(r.value, '--max-agents');
          if (typeof n !== 'number') return { error: n.error };
          parsed.maxAgents = n;
        } else if (name === '--poll-interval') {
          const n = intFlag(r.value, '--poll-interval');
          if (typeof n !== 'number') return { error: n.error };
          parsed.pollIntervalMs = n;
        } else if (name === '--work-root') {
          // ACCUMULATES rather than overwrites — one directory per occurrence
          // is what makes a multi-project boundary expressible at all. A shift
          // that may work in two projects needs two roots, and there is no
          // separator that is safe inside a path on every platform.
          (parsed.workRoots ??= []).push(r.value);
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
    'usage: owenloop work shift [--origin <url>] [--as <account>] [--name <n>] [--serve-crews a,b] [--cap <n>]\n' +
      '                      [--workflow <id>] [--poll-interval <ms>] [--once]\n' +
      '                      [--max-agents <n>] [--cache-dir <p>] [--state-dir <p>]\n' +
      '                      [--log-dir <p>] [--log-max-age <ms>] [--work-root <dir>]...\n',
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ShiftRuntimeOptions {
  /** Build the Unix-socket shift daemon around the same loop instead of self-driving directly. */
  daemon?: boolean;
  /** Output prefix for errors and lifecycle messages. */
  role?: 'shift';
  /** Socket path selected by the shift command. */
  socketPath?: string;
}

/** Public Shift daemon transport is a Unix-domain socket on macOS and Linux. */
export function assertShiftDaemonPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    throw new Error(
      'the public Shift daemon is not supported on Windows: Windows named-pipe transport is not implemented; ' +
      'use `owenloop work shift` directly',
    );
  }
}

/**
 * Shared runtime setup for the internal shift and public shift daemon.
 * `parsed` is already grammar-validated by the caller; this function owns all
 * credential/settings/cache/spawner resolution so the two entry points cannot
 * drift.
 */
export async function runShiftRuntime(parsed: ParsedArgs, options: ShiftRuntimeOptions = {}): Promise<number> {
  const daemonMode = options.daemon === true;
  const roleLabel = options.role === 'shift' ? 'owenloop shift' : 'owenloop work shift';
  if (daemonMode) {
    try {
      assertShiftDaemonPlatform();
    } catch (error) {
      process.stderr.write(`${roleLabel}: ${errMsg(error)}\n`);
      return 1;
    }
  }
  const env = process.env;
  let settings;
  try {
    settings = loadSettings(env);
  } catch (err) {
    process.stderr.write(`${roleLabel}: ${errMsg(err)}\n`);
    return 1;
  }

  const origin = parsed.origin ?? settings.hubOrigin;
  if (origin === undefined || origin.trim() === '') {
    process.stderr.write(`${roleLabel}: no hub origin — pass --origin <url> or set hubOrigin in settings\n`);
    return 2;
  }

  if (parsed.as !== undefined && parsed.as.trim() === '') {
    process.stderr.write(`${roleLabel}: --as requires a non-empty account name\n`);
    return 2;
  }
  const account = parsed.as ?? 'default';

  const bearer = await resolveBearer({ origin, account, env });
  if (!bearer.ok) {
    process.stderr.write(`${roleLabel}: ${bearer.message}\n`);
    return bearer.code;
  }
  const token = bearer.token;

  let cacheDir: string;
  let stateDir: string;
  try {
    cacheDir = parsed.cacheDir ?? resolveCacheDir(env, settings.cacheDir);
    stateDir = resolveStateDir(env, resolveStateDirOverride(parsed.stateDir, env, settings.stateDir));
  } catch (err) {
    process.stderr.write(`${roleLabel}: ${errMsg(err)}\n`);
    return 1;
  }

  const now = () => Date.now();
  const shiftId = `shf_${randomUUID()}`;
  const startedAt = now();
  const name = resolveShiftName(parsed.name, { shiftId });
  // Explicit names are the human/stable identity. Unnamed shifts deliberately
  // keep their per-boot public suffix for presence uniqueness, so their durable
  // state directory is the stable owner key used by session reconciliation.
  const shiftOwner = parsed.name ?? stateDir;

  try {
    ensureStateDir(stateDir);
  } catch (err) {
    process.stderr.write(`${roleLabel}: cannot initialize dispatch state at ${stateDir}: ${errMsg(err)}\n`);
    return 1;
  }
  {
    // Reconcile the Shift's own dispatch records for capacity housekeeping. The
    // session sweep below must use the session row's PID and ownership fields,
    // not this run-id set, because every Shift on the machine shares the store.
    reconcileInFlight(stateDir);
    try {
      const retired = reconcileActiveSessions(
        sessionsPath(cacheDir),
        { shiftName: name, shiftOwner },
        Date.now(),
      );
      for (const rec of retired) {
        process.stderr.write(
          `${roleLabel}: retired orphaned session ${rec.workflow}/${rec.run} step '${rec.step}' ` +
            `(harness '${rec.harness}', attempt ${String(rec.attempt ?? 1)}, ` +
            `shift '${String(rec.shiftName)}', pid ${String(rec.pid)} confirmed dead) — its worker is gone, ` +
            'so the next attempt replays cold\n',
        );
      }
    } catch (err) {
      process.stderr.write(`${roleLabel}: session reconcile failed (continuing): ${errMsg(err)}\n`);
    }
  }

  // ── ON-DISK LOGGING ──
  //
  // Prepared AFTER `ensureStateDir` because the log directory DEFAULTS to the
  // state directory, and BEFORE the spawner because every dispatch needs the
  // destination.
  //
  // `prepareShiftLogDir` resolves the directory, creates it, claims it for this
  // shift's state directory, and sweeps aged-out worker logs — and degrades to
  // "less logging" rather than failing the shift at every one of those steps.
  // Its branches are unit-tested directly; what THIS site owns is the wiring:
  // which flags, settings and environment reach it, and that a `ready: false`
  // result withholds both the sink and the spawner's log directory.
  const prepared = prepareShiftLogDir({
    flagDir: parsed.logDir,
    flagMaxAgeMs: parsed.logMaxAgeMs,
    env,
    settingsLogDir: settings.shiftLogDir,
    settingsMaxAgeMs: settings.shiftLogMaxAgeMs,
    stateDir,
    now: Date.now(),
    err: (line) => process.stderr.write(`${line}\n`),
    label: roleLabel,
  });
  const logDir = prepared.dir;
  const logDirReady = prepared.ready;

  const logSink = logDirReady
    ? createShiftLogSink({
        path: shiftLogFile(logDir),
        err: (line) => process.stderr.write(`${line}\n`),
      })
    : undefined;

  const cap = resolveCap(parsed.cap, settings.dispatchCap);
  const maxConcurrentAgents = resolveMaxConcurrentAgents(parsed.maxAgents, settings.maxConcurrentAgents);
  const workRoot = resolveWorkRoot(env, settings.workRoot, cacheDir);
  const workRepo = resolveWorkRepo(env, settings.workRepo);
  /**
   * The operator's filesystem boundary, resolved once here so the loop receives
   * an already-absolute list and does no precedence work of its own.
   *
   * Precedence is `--work-root` (repeatable) > `OWENLOOP_ALLOWED_WORKDIR_ROOTS`
   * > `settings.allowedWorkdirRoots` > none. Each rung REPLACES the one below
   * rather than adding to it: a narrowing control that could only ever widen
   * would not be a safety control at all.
   *
   * Relative entries resolve against THIS process's cwd, which is where the
   * operator typed the flag. `settings.allowedWorkdirRoots` cannot be relative
   * — `validateSettings` rejects that at load, because a stored boundary that
   * moves with the launch directory is the exact failure this key removes.
   */
  const allowedWorkdirRoots =
    parsed.workRoots !== undefined && parsed.workRoots.length > 0
      ? parsed.workRoots.map((entry) => resolve(process.cwd(), entry))
      : resolveAllowedWorkdirRoots(env, settings.allowedWorkdirRoots, process.cwd());
  const hub = createHubClient({ origin, getToken: async () => token });
  const monotonicNow = () => performance.now();
  const home = [env.HOME, env.USERPROFILE].find(
    (value) => value !== undefined && value.trim() !== '',
  );
  // Legacy orders and modern agent orders do not need Shift-side instruction
  // lookup. Keep serving those lanes without a home directory; a modern command
  // order still fails closed because its exact digest cannot be resolved.
  const instructionSource = home === undefined
    ? undefined
    : createStoreInstructionSource({
	projectRoot: join(process.cwd(), 'workflows'),
	globalRoot: globalStoreRoot(home),
	verifier: createBundleIngestor(),
      });
  const resolveOrderStep = async (order: { defDigest?: string; step: string }) => {
    if (
      instructionSource === undefined ||
      order.defDigest === undefined ||
      order.defDigest.trim() === ''
    ) return undefined;
    if (await instructionSource.prime(order.defDigest) !== 'resolved') return undefined;
    return instructionSource.getVerifiedStep(order.defDigest, order.step);
  };
  let daemon: ShiftDaemon | undefined;
  /**
   * `loop` is constructed BELOW this function, so it is captured by reference
   * rather than value — exactly as `daemon` is, and for the same reason. Both
   * are safe because nothing calls `reportWorkerFailure` until a spawned child
   * exits, which cannot happen before construction finishes.
   *
   * A one-field holder rather than a bare `let`: `let loopRef; loopRef = loop;`
   * is a single write in the same scope as the declaration, which is exactly
   * the shape `prefer-const` rejects. The field write is not a rebinding, so
   * the holder can be `const`.
   */
  const loopRef: { current: ShiftLoop | undefined } = { current: undefined };

  /**
   * Attach the `{ts, shift, shiftId}` envelope. Reads the shift's name LIVE from
   * the loop rather than closing over the startup `name`, because `clock_in` can
   * rename a shift mid-run and a record must carry the name in force when it was
   * produced. Before the loop exists there is nothing to dispatch and therefore
   * nothing to stamp, so the fallback to `name` is unreachable in practice and
   * still correct if it is ever reached.
   */
  const stamp = (body: ShiftEventBody): ShiftEvent =>
    stampShiftEvent(body, { name: loopRef.current?.getShift().name ?? name, id: shiftId }, now());

  /**
   * THE ONE PLACE a shift event fans out to its consumers: the socket daemon
   * (live, ephemeral, only in daemon mode) and the on-disk log (durable, always
   * when a log directory resolved).
   *
   * Each consumer is wrapped SEPARATELY. A daemon whose FIFO throws must not
   * cost the file its record, and a full disk must not cost a parked client its
   * event. Neither failure may reach the loop, which is why nothing rethrows.
   *
   * The two consumers do NOT receive the same set: `FILE_ONLY_EVENTS` reaches
   * the file only. Routing is decided HERE rather than at each emit site so an
   * emitter never has to know how many sinks exist.
   */
  const consumeEvent = (event: ShiftEvent): void => {
    if (daemonMode && reachesSocketConsumer(event.type)) {
      try {
        daemon?.onEvent(event);
      } catch (err) {
        process.stderr.write(`${roleLabel}: shift event queue failed: ${errMsg(err)} (continuing)\n`);
      }
    }
    // `createShiftLogSink.write` already swallows and reports its own failures;
    // this guard covers a throw from anywhere else in the call.
    try {
      logSink?.write(event);
    } catch (err) {
      process.stderr.write(`${roleLabel}: shift event sink failed: ${errMsg(err)} (continuing)\n`);
    }
  };

  // The agent-run child must stay completely offline. Refresh before entering
  // the park loop, but let an unavailable hub degrade to machine layers. The
  // durable error is buffered until after `parked`: a parked shift's first log
  // record is its self-describing identity, even when this refresh fails.
  let startupRosterSyncFailure: string | undefined;
  try {
    await withHubRosterSyncTimeout((signal) => syncHubRosterCache({ client: hub, env, origin, account, signal }));
  } catch (error) {
    startupRosterSyncFailure = `roster sync failed at shift start: ${errMsg(error)} (continuing)`;
    process.stderr.write(`${roleLabel}: ${startupRosterSyncFailure}\n`);
  }

  const reportWorkerFailure = (failure: WorkerFailure): void => {
    // A worker failure is detected by the SPAWNER's `exit`/`error` listener, not
    // inside the loop's sweep, so it never passes through the loop's `emit()`.
    // It is stamped here for the same reason `ended` is stamped in `server.ts`:
    // every record on the wire and in the file carries the same envelope, with
    // no exceptions a consumer would have to special-case.
    const event = stamp({
      type: 'failed' as const,
      workflow: failure.workflow,
      run: failure.run,
      step: failure.step ?? '(unknown)',
      kind: failure.kind,
      executable: failure.executable,
      exitStatus: failure.exitStatus,
      signal: failure.signal,
      message: failure.message,
    });
    consumeEvent(event);
    process.stderr.write(`${roleLabel}: worker failure ${JSON.stringify(event)}\n`);
    // The third consumer, and the one that changes behaviour: charge the
    // failure against the step's dispatch brake so a step that fails the same
    // way forever is re-dispatched on a backoff instead of once per poll.
    loopRef.current?.noteWorkerFailure(failure);
  };
  const spawner = createDefaultSpawner(
    origin,
    account,
    undefined,
    shiftId,
    reportWorkerFailure,
    // `undefined` when the log directory could not be created, which is what
    // makes `buildSpawnPlan` emit no `logFile` and the worker launch with its
    // output discarded exactly as it did before this change.
    logDirReady
      ? { dir: logDir, err: (line: string) => process.stderr.write(`${line}\n`) }
      : undefined,
    allowedWorkdirRoots,
    parsed.serveCrews,
  );
  const pollIntervalMs = parsed.pollIntervalMs ?? DEFAULT_POLL_MS;

  const loop = createShiftLoop({
    hub,
    spawner,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now,
    monotonicNow,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    // Previously daemon-mode only, because the socket daemon was the only
    // consumer. The file sink is a second consumer that exists in BOTH modes, so
    // the loop now emits whenever either consumer is present.
    ...(daemonMode || logSink !== undefined ? { onEvent: consumeEvent } : {}),
    cacheDir,
    stateDir,
    cap,
    serveCrews: parsed.serveCrews ?? [],
    name,
    shiftOwner,
    commandRouting: settings.commandRouting,
    resolveOrderStep,
    pollIntervalMs,
    presenceIntervalMs: DEFAULT_PRESENCE_MS,
    rosterSyncIntervalMs: DEFAULT_ROSTER_SYNC_MS,
    rosterSyncTimeoutMs: DEFAULT_HUB_ROSTER_SYNC_TIMEOUT_MS,
    syncRosters: (signal) => syncHubRosterCache({ client: hub, env, origin, account, signal }),
    maxConcurrentAgents,
    workRoot,
    ...(workRepo !== undefined ? { workRepo } : {}),
    shiftId,
    startedAt,
    ...(parsed.workflow !== undefined ? { workflow: parsed.workflow } : {}),
    ...(parsed.once === true ? { once: true } : {}),
  });
  // Close the loop on `reportWorkerFailure`'s forward reference. Assigned
  // immediately after construction, long before any child can exit.
  loopRef.current = loop;

  /**
   * The first record in a shift's log: what this process is, where it is, and
   * what it will serve. `shift.log` is read on a machine, days later, by someone
   * who has only the file — so the file must be SELF-DESCRIBING. Every later
   * record identifies the shift by name and id alone; this one is what those
   * names resolve to.
   *
   * Written by `runtime.ts` rather than the loop because the loop knows its cap
   * and crews but not the origin it was pointed at, the host, or the launch
   * directory. Suppressed under `--once`, matching the console `parked as …`
   * line — a one-shot drain is not a parked shift.
   *
   * FILE-ONLY, via `FILE_ONLY_EVENTS` — this goes through `consumeEvent` like
   * every other record, and `consumeEvent` withholds it from the socket. A
   * startup record sitting in the daemon's FIFO would make the first `next`
   * after every start return instantly with a record about the shift itself,
   * breaking the contract that an idle `next` BLOCKS until there is work to
   * report; `packages/work/test/shift-blocking-acceptance.test.ts` asserts that
   * blocking behaviour directly.
   */
  const emitParked = (): void => {
    consumeEvent(
      stamp({
        type: 'parked',
        origin,
        cap,
        serveCrews: parsed.serveCrews ?? [],
        hostname: hostname(),
        cwd: process.cwd(),
      }),
    );
  };

  const emitStartupRosterSyncFailure = (): void => {
    if (startupRosterSyncFailure === undefined) return;
    consumeEvent(stamp({ type: 'hub-error', op: 'roster_sync', message: startupRosterSyncFailure }));
    startupRosterSyncFailure = undefined;
  };

  if (daemonMode) {
    daemon = createShiftDaemon({
      socketPath: options.socketPath ?? join(stateDir, 'shift.sock'),
      stateDir,
      loop,
      hub,
      now,
      startedAt,
      shiftId,
      err: (line) => process.stderr.write(`${line}\n`),
      // The daemon's self-made records (`event-queue-overflow`, `ended`) go
      // STRAIGHT to the file, never back through `consumeEvent` — `consumeEvent`
      // feeds `daemon.onEvent`, and the daemon has already put each of these in
      // its own queue. For `event-queue-overflow` that routing is load-bearing
      // rather than merely tidy: its queue is the thing that just overflowed.
      ...(logSink !== undefined ? { onSynthesized: (event: ShiftEvent) => logSink.write(event) } : {}),
    });
    installSignalHandlers(daemon, process, (line) => process.stderr.write(`${line}\n`), {
      role: 'shift',
      drainNote: 'draining, in-flight children keep running',
      stopReason: 'signal',
    });
    if (parsed.once !== true) {
      process.stdout.write(`owenloop shift: parked as '${name}' @ ${origin} (cap ${cap})\n`);
      emitParked();
      emitStartupRosterSyncFailure();
    } else {
      emitStartupRosterSyncFailure();
    }
    return daemon.run();
  }

  installSignalHandlers(loop, process, (line) => process.stderr.write(`${line}\n`));
  if (parsed.once !== true) {
    process.stdout.write(`owenloop work shift: parked as '${name}' @ ${origin} (cap ${cap})\n`);
    emitParked();
    emitStartupRosterSyncFailure();
  } else {
    emitStartupRosterSyncFailure();
  }
  return loop.run();
}

export async function run(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.error !== undefined) {
    process.stderr.write(`owenloop work shift: ${parsed.error}\n`);
    usage();
    return 2;
  }
  if (args.some((arg) => arg === '--mcp' || arg.startsWith('--mcp='))) {
    process.stderr.write('owenloop work shift: unknown option \'--mcp\'\n');
    usage();
    return 2;
  }
  return runShiftRuntime(parsed);
}
