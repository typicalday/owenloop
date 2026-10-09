/**
 * `owenloop work shift` — the internal standing Shift loop.
 *
 * The human-facing shift daemon uses the same setup and ShiftLoop through
 * `runShiftRuntime(..., { daemon: true })`; this module remains the single place
 * that resolves settings, credentials, caches, child spawners, and signal
 * behavior. The retired shift stdio-MCP mount is intentionally absent.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, rmdirSync, unlinkSync, writeFileSync, type Dir, type Stats } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createHubClient, type RoutingHubClient } from '../hub/client.ts';
import { HubError, type RoutingScope, type RoutingSessionOpenResponse, type RoutingOfferCandidate, type LocalTupleEligibility, type LocalModelTuple } from '../hub/types.ts';
import { resolveBearer } from '../credentials/resolve.ts';
import { createTrustedRoutedReferenceV2Reader, createTrustedRoutedInputPairV2Reader,
  type RoutedServicePrestartPairV2, type RoutedClaimV2,
  type RoutedReferenceV2 } from '../hosted/trusted-routed-reference-v2.ts';
import { createRecordedRoutedV2Reader, createRecordedRoutedInputPairV2Reader,
  type RoutedServiceRecordedPairV2, type RecordedClaimV2,
  type RecordedBindingV2, type RecordedReferenceV2 } from '../hosted/trusted-routed-recorded-v2.ts';
import { createDirectRoutedInvocationReader } from '../hosted/trusted-routed-invocation.ts';
import type { InvocationRelayKey, VerifiedInvocationReceipt } from '../../../../src/types.ts';
import { loadSettings } from '../settings/settings.ts';
import { DEFAULT_HUB_ROSTER_SYNC_TIMEOUT_MS, readHubRosterCache, syncHubRosterCache, withHubRosterSyncTimeout } from '../settings/hub-roster-cache.ts';
import { effectiveRosterLayers, mergeRosterLayers } from '../settings/roster.ts';
import { resolveCapabilityCandidates, type RosterCandidate } from '../agent/capability-model.ts';
import { adapterFor } from '../harness/registry.ts';
import { computeServeCapabilities } from '../settings/serving.ts';
import { resolveCacheDir } from '../bundle/cache.ts';
import { checkDiskFloor, resolveDiskFloorBytes } from './disk-floor.ts';
import {
  createLockedRemovalCallbacks,
  createShiftLoop,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HUB_CALL_TIMEOUT_MS,
  type ShiftLoop,
} from './loop.ts';
import { createHubBundleRecoveryHandler } from '../bundle/pull.ts';
import { createShiftLogSink } from './logsink.ts';
import { prepareShiftLogDir, shiftLogFile } from './logretention.ts';
import { stampShiftEvent, type ShiftEvent, type ShiftEventBody } from './protocol.ts';
import { createDefaultSpawner, type Spawner, type WorkerExit, type WorkerFailure } from './spawn.ts';
import { resolveStateDir, ensureStateDir, reconcileInFlight, readChildReservations, type ChildReservation, type Liveness, type Reconciliation } from './state.ts';
import { FileLockTimeoutError, type AcquireFileLockOpts } from '../../../../src/lock.ts';
import { reconcileActiveSessions, sessionsPath } from '../harness/session-store.ts';
import {
  resolveAllowedWorkdirRoots,
  resolveWorkRepo,
  resolveWorkRoot,
} from '../agent/workdir.ts';
import { installSignalHandlers, type SignalHost } from '../roles/signals.ts';
import { createShiftDaemon, type ShiftDaemon } from './server.ts';
import { createRoutingBroker, type RoutingBroker } from './routing-broker.ts';
import { createRoutedDefinitionMaintenance, stageRoutedDefinition } from './routing-definition-stage.ts';
import { createRoutedSubmissionAuthority } from './routing-submit-authority.ts';
import { createRoutedLaunchAuthority } from './routing-launch-authority.ts';
import { valueDigestHex } from '../../../../src/crypto/canonical.ts';
import type { RoutedDefinitionStage } from './routing-definition-stage.ts';
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
const DEFAULT_EXEC_RESERVE = 1;
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
 *
 * `heartbeat` (issue #300) is periodic proof of life on a fixed cadence. It
 * carries nothing to act on, so the blocking contract of `shift next` applies:
 * a client parked for work must not be woken every five minutes by a record
 * that says only "still here". `stalled`, the watchdog's edge-triggered
 * counterpart, is NOT in this set for the reason `wedged` is not.
 */
const FILE_ONLY_EVENTS: ReadonlySet<ShiftEventBody['type']> = new Set([
  'parked',
  'capacity',
  'hub-error',
  'event-queue-overflow',
  'low-disk',
  'heartbeat',
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

export function resolveExecReserve(
  flagReserve: number | undefined,
  settingsReserve: number | undefined,
): number {
  return flagReserve ?? settingsReserve ?? DEFAULT_EXEC_RESERVE;
}

export function resolveLocalQueueHoldMs(
  flagHold: number | undefined,
  settingsHold: number | undefined,
): number {
  return flagHold ?? settingsHold ?? 0;
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
  execReserve?: number;
  /** `--disk-floor <bytes>` — free space required to start new work. `0` disables. */
  diskFloorBytes?: number;
  localQueueHoldMs?: number;
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
      case '--exec-reserve':
      case '--disk-floor':
      case '--local-queue-hold':
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
		} else if (name === '--exec-reserve') {
	  const n = intFlag(r.value, '--exec-reserve');
	  if (typeof n !== 'number') return { error: n.error };
	  parsed.execReserve = n;
        } else if (name === '--disk-floor') {
          const n = intFlag(r.value, '--disk-floor');
          if (typeof n !== 'number') return { error: n.error };
          parsed.diskFloorBytes = n;
		} else if (name === '--local-queue-hold') {
	  const n = intFlag(r.value, '--local-queue-hold');
	  if (typeof n !== 'number') return { error: n.error };
	  parsed.localQueueHoldMs = n;
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
      '                      [--max-agents <n>] [--exec-reserve <n>] [--local-queue-hold <ms>] [--cache-dir <p>] [--state-dir <p>]\n' +
      '                      [--log-dir <p>] [--log-max-age <ms>] [--work-root <dir>]...\n',
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reconcile startup state under the same per-removal dispatch lock as the live
 * loop. A busy neighbour is recoverable: the first poll-loop iteration retries
 * shortly, whereas failing the entire Shift startup would strand its work.
 */
export function reconcileStartupState(
  stateDir: string,
  report: (line: string) => void,
  options: {
    dispatchLockOptions?: Pick<AcquireFileLockOpts, 'beforeOpen'>;
    isAlive?: Liveness;
  } = {},
): Reconciliation | undefined {
  try {
    return reconcileInFlight(stateDir, {
      ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
      ...createLockedRemovalCallbacks(stateDir, {
	dispatchLockOptions: options.dispatchLockOptions,
	waitMs: 1_000,
	label: 'owenloop Shift startup reaper',
      }),
    });
  } catch (error) {
    if (!(error instanceof FileLockTimeoutError)) throw error;
    report(`startup dispatch-state reconciliation deferred: ${errMsg(error)} (the poll-loop reconciliation will retry)`);
    return undefined;
  }
}

export interface ShiftRuntimeOptions {
  /** Build the Unix-socket shift daemon around the same loop instead of self-driving directly. */
  daemon?: boolean;
  /** Output prefix for errors and lifecycle messages. */
  role?: 'shift';
  /** Socket path selected by the shift command. */
  socketPath?: string;
  /** Test/embedder spawner; production uses the detached worker spawner. */
  spawner?: Spawner;
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

/** Routed child broker needs a reviewed local transport on each platform. */
export function assertRoutedShiftPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') throw new Error('routed Shift is not supported on Windows: private broker named-pipe ACLs are not implemented');
}

/** Revoke broker caps immediately, then stop the original session even when
 * remote receipt revocation is uncertain. The stop result remains rejected so
 * callers cannot report a clean Shift drain in that case. */
export function createRoutingStop(drainBroker: () => Promise<void>, stopSession: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    let drained: Promise<void>;
    try { drained = drainBroker(); }
    catch (error) { drained = Promise.reject(error); }
    pending = drained.finally(stopSession);
    return pending;
  };
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
  let routingEnabled: boolean;
  try {
    routingEnabled = routingSessionEnabled(env);
    settings = loadSettings(env);
  } catch (err) {
    process.stderr.write(`${roleLabel}: ${errMsg(err)}\n`);
    return 1;
  }
  if (routingEnabled) {
    try { assertRoutedShiftPlatform(); }
    catch (error) { process.stderr.write(`${roleLabel}: ${errMsg(error)}\n`); return 1; }
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

  // A routed Shift and its detached children must resolve the same enrolled
  // account. The ambient development token cannot authorize either side.
  const bearer = await resolveBearer({ origin, account,
    env: routingEnabled ? { ...env, OWENLOOP_TOKEN: undefined } : env });
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
  let shiftId = `shf_${randomUUID()}`;
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
    reconcileStartupState(stateDir, (line) => process.stderr.write(`${roleLabel}: ${line}\n`));
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
  const execReserve = resolveExecReserve(parsed.execReserve, settings.execReserve);
  const localQueueHoldMs = resolveLocalQueueHoldMs(parsed.localQueueHoldMs, settings.localQueueHoldMs);
  const diskFloorBytes = resolveDiskFloorBytes(parsed.diskFloorBytes, settings.diskFloorBytes);
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
  let definitionMaintenance: ReturnType<typeof createRoutedDefinitionMaintenance> | undefined;
  if (routingEnabled) {
    try { definitionMaintenance = createRoutedDefinitionMaintenance({ stateDir, workRoot, now }); }
    catch {
      process.stderr.write(`${roleLabel}: routed definition stage root unavailable\n`);
      return 1;
    }
  }
  const monotonicNow = () => performance.now();
  const routingBackoff = routingEnabled ? createRoutingBackoff(monotonicNow) : undefined;
  let hub = createHubClient({ origin, getToken: async () => token,
    ...(routingBackoff ? { routingSession: { allowedOrigin: origin, get: () => undefined,
      beforeRequest: routingBackoff.beforeRequest, onRateLimit: routingBackoff.onRateLimit } } : {}) });
  let routingSession: ShiftRoutingSession | undefined;
  let routingBroker: RoutingBroker | undefined;
  let routingBrokerDrain: Promise<void> | undefined;
  let routingStop: Promise<void> | undefined;
  const drainRoutingBroker = (): Promise<void> => {
    routingBrokerDrain ??= routingBroker?.close({ revokeNormalReceipts: true }) ?? Promise.resolve();
    void routingBrokerDrain.catch(() => {
      process.exitCode = 1;
      process.stderr.write('owenloop shift: routed collection outcome quarantined during broker drain\n');
    });
    return routingBrokerDrain;
  };
  const stopRouting = createRoutingStop(drainRoutingBroker, () => routingSession?.stop() ?? Promise.resolve());
  const trackedStopRouting = (): Promise<void> => {
    routingStop ??= stopRouting();
    void routingStop.catch(() => {});
    return routingStop;
  };
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
	onMissing: createHubBundleRecoveryHandler({
	  origin,
	  token,
	  home,
	  projectRoot: join(process.cwd(), 'workflows'),
	  env,
	  warn: (line) => process.stderr.write(`${roleLabel}: ${line}\n`),
	}),
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

  if (routingEnabled) {
    try {
      const principal = await hub.whoami(AbortSignal.timeout(DEFAULT_HUB_CALL_TIMEOUT_MS));
      if (!['token', 'oauth'].includes(principal.authMethod) || principal.tokenStatus !== 'active') {
	throw new Error('routing requires an enrolled bearer');
      }
      routingSession = await openShiftRoutingSession({ origin, stateDir, workRoot: resolve(workRoot),
	...(workRepo ? { workRepo: resolve(workRepo) } : {}),
	monotonicNow, routingBackoff,
	orgId: principal.orgId, principalId: principal.actor.id, getToken: async () => token,
	onMaintenanceError: () => process.stderr.write(`${roleLabel}: parked routing session maintenance failed\n`),
	onDrained: () => { void drainRoutingBroker(); },
	onRetiring: sessionId => routingBroker?.revokeSession(sessionId) ?? Promise.resolve(),
	scope: {
	  ...(parsed.workflow ? { workflows: [parsed.workflow] } : {}),
	  ...(parsed.serveCrews?.length ? { crews: parsed.serveCrews } : {}),
	  capabilities: computeServeCapabilities({ env, crews: parsed.serveCrews ?? [], hub: { origin, account } }),
	},
      });
      routingBroker = await createRoutingBroker();
      hub = routingSession.hub;
      shiftId = routingSession.identity()!.shiftId;
    } catch {
      await routingSession?.stop();
      process.stderr.write(`${roleLabel}: routing session initialization failed\n`);
      return 1;
    }
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
  const reportWorkerExit = (exit: WorkerExit): void => {
    loopRef.current?.noteChildExited(exit);
  };
  const spawner = options.spawner ?? createDefaultSpawner(
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
    reportWorkerExit,
  );
  const pollIntervalMs = parsed.pollIntervalMs ?? DEFAULT_POLL_MS;

  const localSelection = new WeakMap<RoutingOfferCandidate, { tuples: LocalTupleEligibility[]; snapshot: string }>();
  const routingRosterOptions = () => ({ env, origin, account,
    serving: loopRef.current?.getShift().serveCrews ?? parsed.serveCrews ?? [],
    harnessAvailable: (harness: string) => adapterFor(harness) !== undefined });
  const selectRoutingTuples = (candidate: RoutingOfferCandidate): LocalTupleEligibility[] => {
    const selected = selectLocalRoutingTuplesWithSnapshot(candidate, routingRosterOptions());
    if (selected) localSelection.set(candidate, selected);
    return selected?.tuples ?? [];
  };
  const routingRosterSnapshot = (candidate: RoutingOfferCandidate) =>
    localSelection.get(candidate)?.snapshot
      ?? selectLocalRoutingTuplesWithSnapshot(candidate, routingRosterOptions())?.snapshot;

  const loop = createShiftLoop({
    hub,
    ...(routingSession ? { routingSession, selectRoutingTuples, routingRosterSnapshot,
      maintainDefinitionStages: definitionMaintenance!.sweep,
      closeDefinitionStages: definitionMaintenance!.close,
      stageRoutedDefinition: (order: import('../hub/types.ts').WorkOrder, rootWorkflow: string) => {
	const captured = routingSession.brokerTarget();
	if (!captured) throw new Error('routed definition session unavailable');
	const expected = { workflow: rootWorkflow, run: order.run };
	return stageRoutedDefinition({
	  order, rootWorkflow, origin, token, stateDir, workRoot, sourceEnv: env,
	  beforeRequest: routingBackoff!.beforeRequest,
	  onRateLimit: routingBackoff!.onRateLimit,
	  readInvocationBinding: captured.readInvocationBinding,
	  readCurrentPair: async (phase, target) => {
	    if (target.workflow !== expected.workflow || target.run !== expected.run)
	      throw new Error('routed definition target changed');
	    return phase === 'prestart'
	      ? captured.routedV2PairRead(target)
	      : captured.routedLiveV2PairRead(target);
	  },
	  stillAuthorized: () => {
	    const identity = routingSession.identity();
	    const routing = order.routing;
	    return !!identity && !!routing
	      && identity.orgId === routing.decision.binding.orgId
	      && identity.principalId === routing.claim.principalId
	      && identity.sessionId === routing.claim.sessionId
	      && identity.shiftId === routing.claim.shiftId
	      && now() < Math.min(identity.expiresAt, routing.decision.binding.expiresAt,
		routing.preference.expiresAt);
	  },
	});
      },
      createRoutingSubmissionAuthority: stage => createRoutedSubmissionAuthority({
	origin, env, now, verifyOrder: stage.verifyOrder,
	canSubmit: stage.canSubmit, canReplay: stage.canReplay, canCollect: stage.canCollect,
      }),
      createRoutingInputAuthority: (stage, target, rootWorkflow) => ({
	validateInvocationKey: key => stage.validateInvocationKey?.(key) === true,
	observe: async (response, phase) => {
	  if (!stage.verifyRoutedInput) throw new Error('routed input authority unavailable');
	  const started = { wall: now(), monotonic: performance.now() };
	  const expected = { workflow: rootWorkflow, run: response.run };
	  const pair = phase === 'prestart'
	    ? await target.routedV2PairRead(expected)
	    : await target.routedLiveV2PairRead(expected);
	  await stage.verifyRoutedInput(response, pair, phase, started);
	  return pair;
	},
	observeInvocation: async (response, phase, key) => {
	  if (!stage.readInvocationBinding) throw new Error('routed invocation authority unavailable');
	  const expected = { workflow: rootWorkflow, run: response.run };
	  const pair = phase === 'prestart'
	    ? await target.routedV2PairRead(expected)
	    : await target.routedLiveV2PairRead(expected);
	  const relay = await stage.readInvocationBinding(response, pair, phase, key);
	  return { pair, relay };
	},
      }),
      createRoutingLaunchAuthority: (order, offer) => createRoutedLaunchAuthority({
	offered: order, ...(offer ? { offer } : {}),
	currentTuples: candidate => selectLocalRoutingTuples(candidate, routingRosterOptions()),
	currentRosterSnapshot: candidate =>
	  selectLocalRoutingTuplesWithSnapshot(candidate, routingRosterOptions())?.snapshot,
      }) } : {}),
	...(routingBroker ? { routingBroker, onStopRouting: trackedStopRouting } : {}),
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
    hubCallTimeoutMs: DEFAULT_HUB_CALL_TIMEOUT_MS,
    heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
    syncRosters: (signal) => syncHubRosterCache({ client: hub, env, origin, account, signal }),
    computeServeCapabilities: (crews) => computeServeCapabilities({
      env,
      crews,
      hub: { origin, account },
      warn: (message) => process.stderr.write(`${roleLabel}: shift: ${message}\n`),
    }),
    maxConcurrentAgents,
    execReserve,
    localQueueHoldMs,
    workRoot,
    /*
     * Resolved here, not in the loop: `runtime.ts` owns flag/settings/default
     * precedence for every other tunable, and the loop consumes a decision. A
     * loop built without this closure has no disk gate at all, which is the
     * right default for a caller that never told it where work lands.
     */
    diskSpace: () => checkDiskFloor(workRoot, diskFloorBytes),
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
    try { return await daemon.run(); } finally {
      loop.stop();
      if (routingStop) await routingStop;
      else await routingSession?.stop();
    }
  }

  installSignalHandlers(loop, process, (line) => process.stderr.write(`${line}\n`));
  if (parsed.once !== true) {
    process.stdout.write(`owenloop work shift: parked as '${name}' @ ${origin} (cap ${cap})\n`);
    emitParked();
    emitStartupRosterSyncFailure();
  } else {
    emitStartupRosterSyncFailure();
  }
  try { return await loop.run(); } finally {
    loop.stop();
    if (routingStop) await routingStop;
    else await routingSession?.stop();
  }
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

/** Private handoff wire for the later trusted role consumer. Both Hub
 * credentials remain in Shift. expiresAt is a consumption deadline,
 * not a renewable lease; each sibling receives a different file and nonce. */
export interface RoutingHandoffV1 {
  version: 'routing-handoff-v1'; incarnation: string; nonce: string;
  origin: string; orgId: string; sessionId: string; shiftId: string;
  broker?: { socketPath: string; cap: string };
  /** Narrower cap for the agent's separate born-bound holder process. */
  holderBroker?: { socketPath: string; cap: string };
  /** Private signed snapshot. No bearer, signer or operator HOME path. */
  definitionStage?: { path: string; digest: string };
  /** Shift-resolved default agent work root; never derived from public stage. */
  workRoot?: string;
  /** Shift-resolved git worktree source, when configured. */
  workRepo?: string;
  reservation: ChildReservation; createdAt: number; expiresAt: number; sessionExpiresAt: number;
}
export interface RoutingHandoff {
  path: string;
  /** Parent-owned generation of the exact one-use handoff file. */
  incarnation?: string;
  nonce?: string;
  /** Exact reservation/incarnation owner callback; safe after child consumption. */
  terminal(reason?: 'normal-close' | 'child-exit' | 'revoked'): void;
}
export interface ShiftRoutingSession {
  hub: RoutingHubClient;
  identity(): { orgId: string; principalId: string; sessionId: string; shiftId: string; expiresAt: number } | undefined;
  /** Captures the exact incarnation, including after later scope rotation. */
  brokerTarget(): { hub: RoutingHubClient; identity: NonNullable<ReturnType<ShiftRoutingSession['identity']>>;
    currentIdentity: ShiftRoutingSession['identity'];
    routedV2Read: (kind: 'reference' | 'claim', expected: { workflow: string; run: string }) =>
      Promise<RoutedReferenceV2 | RoutedClaimV2>;
    routedLiveV2Read: (kind: 'reference' | 'claim', expected: { workflow: string; run: string }) =>
      Promise<RecordedReferenceV2 | RecordedClaimV2>;
    routedV2PairRead: (expected: { workflow: string; run: string }) => Promise<RoutedServicePrestartPairV2>;
    routedLiveV2PairRead: (expected: { workflow: string; run: string }) => Promise<RoutedServiceRecordedPairV2>;
    readInvocationBinding: (key: InvocationRelayKey, phase: 'prestart' | 'recorded-live',
      expected: { workflow: string; run: string }, binding?: RecordedBindingV2) =>
      Promise<VerifiedInvocationReceipt | undefined> } | undefined;
  createHandoff(reservation: ChildReservation, broker?: { socketPath: string; cap: string;
    holder?: { socketPath: string; cap: string } }, definitionStage?: RoutedDefinitionStage): RoutingHandoff;
  maintain(): Promise<void>;
  /** Monotonic service deadline shared with Shift's other Hub requests. */
  nextRequestAllowedAt(): number;
  /** Open new authority for changed serving selections; never widen a session. */
  ensureScope(selection: { capabilities: string[]; crews: string[] }): Promise<void>;
  /** Stop dispatch. Live detached workers preserve the shared session. */
  stop(): Promise<void>;
}
const HANDOFF_BATCH = 64;
const HANDOFF_MAX_BYTES = 16_384;
const incarnationName = /^inc_[a-f0-9]{32}$/;
const handoffName = /^([a-f0-9]{32})\.json$/;
function sameInode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function privateDirectory(path: string, create = false): Stats {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || (process.getuid && stat.uid !== process.getuid())) throw new Error('routing private directory refused');
  return stat;
}
function removeExactHandoff(path: string, inode: Stats): void {
  try {
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || !sameInode(current, inode)) throw new Error('routing handoff ownership changed');
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('routing handoff cleanup failed');
  }
}

/** Bounded cursor over recognized private entries. No PID/tag grants deletion.
 * If this application never starts again, expired files may physically remain. */
function handoffMaintenance(root: string, now: () => number, preserved: Set<string>) {
  const rootInode = privateDirectory(root);
  let roots: Dir | undefined;
  let entries: { directory: string; name: string; inode: Stats; dir: Dir } | undefined;
  const close = () => {
    entries?.dir.closeSync(); entries = undefined;
    roots?.closeSync(); roots = undefined;
  };
  const sweep = () => {
    if (!sameInode(privateDirectory(root), rootInode)) throw new Error('routing private root changed');
    roots ??= opendirSync(root);
    for (let scanned = 0; scanned < HANDOFF_BATCH; scanned++) {
      if (!entries) {
	const entry = roots.readSync();
	if (!entry) { close(); break; }
	if (!entry.isDirectory() || !incarnationName.test(entry.name)) continue;
	const directory = join(root, entry.name);
	try { entries = { directory, name: entry.name, inode: privateDirectory(directory), dir: opendirSync(directory) }; }
	catch { continue; }
      }
      const entry = entries.dir.readSync();
      if (!entry) {
	const directory = entries.directory;
	entries.dir.closeSync(); entries = undefined;
	try { if (!preserved.has(directory)) rmdirSync(directory); } catch { /* Nonempty/live or already removed. Never recursive. */ }
	continue;
      }
      const match = handoffName.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const path = join(entries.directory, entry.name);
      let fd: number | undefined;
      try {
	if (!sameInode(privateDirectory(entries.directory), entries.inode)) continue;
	const expected = lstatSync(path);
	if (!expected.isFile() || expected.isSymbolicLink() || (expected.mode & 0o777) !== 0o600
	  || (process.getuid && expected.uid !== process.getuid()) || expected.size > HANDOFF_MAX_BYTES) continue;
	fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	if (!sameInode(fstatSync(fd), expected)) continue;
	const bytes = Buffer.alloc(HANDOFF_MAX_BYTES + 1);
	const count = readSync(fd, bytes, 0, bytes.length, 0);
	if (count > HANDOFF_MAX_BYTES) continue;
	const p = JSON.parse(bytes.subarray(0, count).toString('utf8')) as RoutingHandoffV1;
	if (p.version !== 'routing-handoff-v1' || p.incarnation !== entries.name || p.nonce !== match[1]
	  || !p.reservation || !/^[a-f0-9]{32}$/.test(p.reservation.token)
	  || !Number.isSafeInteger(p.createdAt) || !Number.isSafeInteger(p.expiresAt)
	  || !Number.isSafeInteger(p.sessionExpiresAt) || p.expiresAt > p.createdAt + 120_000
	  || p.expiresAt > p.sessionExpiresAt || p.expiresAt <= p.createdAt) continue;
	if (now() >= p.expiresAt && sameInode(privateDirectory(entries.directory), entries.inode)) removeExactHandoff(path, expected);
      } catch { /* Unknown/substituted/unreadable entries never authorize broader cleanup. */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  };
  return { sweep, close };
}

/** One clock and deadline for every request from a routed Shift origin. */
export function createRoutingBackoff(monotonicNow: () => number = () => performance.now()) {
  let nextAllowedAt = Number.NEGATIVE_INFINITY;
  return {
    nextAllowedAt: () => nextAllowedAt,
    onRateLimit: (error: HubError) => {
      if (error.status === 429) nextAllowedAt = Math.max(nextAllowedAt, monotonicNow() + (error.retryAfterMs ?? 30_000));
    },
    beforeRequest: () => {
      const remainingMs = nextAllowedAt - monotonicNow();
      if (remainingMs > 0) throw new HubError(429, 'routing backoff active', undefined, remainingMs);
    },
  };
}

/** Opt-in trusted runtime closure. Neither this value nor its capability is an
 * MCP argument, persisted dispatch event, global env variable or log payload. */
interface ShiftRoutingSessionOptions {
  stateDir: string; origin: string; orgId: string; principalId: string; scope: RoutingScope;
  workRoot?: string; workRepo?: string;
  getToken: () => Promise<string>; fetchImpl?: typeof fetch; now?: () => number; nonce?: () => string;
  monotonicNow?: () => number;
  routingBackoff?: ReturnType<typeof createRoutingBackoff>;
  /** Keeps a stopped Shift alive while detached workers still own sessions. */
  postStopSchedule?: (fn: () => void, everyMs: number) => () => void;
  onMaintenanceError?: () => void;
  onClosed?: () => void;
  onDrained?: () => void;
  /** Stop one original incarnation's mutation caps before scope rotation. */
  onRetiring?: (sessionId: string) => Promise<void>;
}

export async function openShiftRoutingSession(opts: ShiftRoutingSessionOptions): Promise<ShiftRoutingSession> {
  const normalize = (scope: RoutingScope): RoutingScope => Object.fromEntries(
    Object.entries(scope).sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, [...new Set(values)].sort()]));
  const workflows = opts.scope.workflows && [...opts.scope.workflows];
  let scope = normalize(structuredClone(opts.scope));
  type Incarnation = Awaited<ReturnType<typeof openRoutingIncarnation>>;
  let active: Incarnation;
  const retired = new Set<Incarnation>();
  let stopped = false;
  let changing: Promise<void> = Promise.resolve();
  const monotonicNow = opts.monotonicNow ?? (() => performance.now());
  const backoff = opts.routingBackoff ?? createRoutingBackoff(monotonicNow);
  let cancelParked: (() => void) | undefined;
  const live = () => Boolean(active.identity()) || [...retired].some(incarnation => Boolean(incarnation.identity()));
  const onClosed = () => {
    for (const incarnation of retired) if (!incarnation.identity()) retired.delete(incarnation);
    if (stopped && !live()) { cancelParked?.(); cancelParked = undefined; opts.onDrained?.(); }
  };
  const incarnationOptions = { ...opts, onClosed, beforeRequest: backoff.beforeRequest, onRateLimit: backoff.onRateLimit };
  active = await openRoutingIncarnation({ ...incarnationOptions, scope });
  // Callers keep this client, while each request resolves the current authority.
  // In-flight calls and old handoffs retain their original incarnation closure.
  const hub = new Proxy(active.hub, {
    get: (_target, property) => Reflect.get(active.hub, property),
    set: (_target, property, value) => Reflect.set(active.hub, property, value),
  });
  let parkedInFlight = false;
  let quarantined = false;
  let rotating = false;
  const session: ShiftRoutingSession = {
    hub,
    identity: () => quarantined || rotating ? undefined : active.identity(),
    brokerTarget: () => {
	if (quarantined || rotating) return undefined;
      const incarnation = active;
      const identity = incarnation.identity();
      return identity ? { hub: incarnation.hub, identity, currentIdentity: incarnation.identity,
	routedV2Read: incarnation.readRoutedV2,
	routedLiveV2Read: incarnation.readRecordedV2,
	routedV2PairRead: incarnation.readRoutedPairV2,
	routedLiveV2PairRead: incarnation.readRecordedPairV2,
	readInvocationBinding: incarnation.readInvocationBinding } : undefined;
    },
    nextRequestAllowedAt: backoff.nextAllowedAt,
    createHandoff: (reservation, broker, definitionStage) => {
      if (stopped || quarantined || rotating) throw new Error('routing session stopped');
      return active.createHandoff(reservation, broker, definitionStage);
    },
    async ensureScope(selection) {
      const desired = normalize({
	...(workflows ? { workflows } : {}),
	...(selection.crews.length ? { crews: [...selection.crews] } : {}),
	capabilities: [...selection.capabilities],
      });
      const change = changing.catch(() => {}).then(async () => {
	if (stopped || quarantined) throw new Error('routing session stopped');
	backoff.beforeRequest();
	if (JSON.stringify(scope) === JSON.stringify(desired)
	  && (active.identity()?.expiresAt ?? 0) > (opts.now ?? Date.now)()) return;
	// Never alter the old session, nor discard it on a failed open.
	const next = await openRoutingIncarnation({ ...incarnationOptions, scope: desired });
	if (stopped) { await next.stop(); throw new Error('routing session stopped'); }
	const previous = active;
	active = next;
	scope = desired;
	if (previous.identity()) retired.add(previous);
	// The original session remains active while its exact remote revocation
	// settles. Failure leaves the old incarnation in retained custody.
	if (previous.identity()) {
	  rotating = true;
	  try { await opts.onRetiring?.(previous.identity()!.sessionId); }
	  catch (error) { quarantined = true; throw error; }
	  finally { rotating = false; }
	}
	// A retired incarnation retains renewal authority while an owned worker
	// remains live. Its terminal callbacks close that exact old session.
	const closeRateLimit = await previous.stop();
	if (previous.identity()) retired.add(previous);
	if (closeRateLimit) throw closeRateLimit;
      });
      changing = change;
      await change;
    },
    async maintain() {
      // A failed scope expansion rejects its caller, but never poisons the
      // still-valid authority's independent renewal path.
      await changing.catch(() => {});
      if (monotonicNow() < backoff.nextAllowedAt()) return;
      // An older worker's session normally expires first. Renew in deadline
      // order so a slow or rate-limited newer session cannot starve it.
      const incarnations = [active, ...retired].sort((a, b) =>
	(a.identity()?.expiresAt ?? Number.POSITIVE_INFINITY) - (b.identity()?.expiresAt ?? Number.POSITIVE_INFINITY));
      let firstError: unknown;
      for (const incarnation of incarnations) {
	if (!incarnation.identity()) { retired.delete(incarnation); continue; }
	try { await incarnation.maintain(); }
	catch (error) {
	  if (error instanceof HubError && error.status === 429) {
	    throw error; // Service forbids further requests until Retry-After.
	  }
	  if (firstError === undefined) firstError = error;
	}
	if (!incarnation.identity()) retired.delete(incarnation);
      }
      if (firstError !== undefined) throw firstError;
    },
    async stop() {
      stopped = true;
      try { await changing; } catch { /* Failed scope changes retain active. */ }
      await active.stop();
      for (const incarnation of retired) await incarnation.stop();
      if (live() && !cancelParked) {
	const schedule = opts.postStopSchedule ?? ((fn: () => void, everyMs: number) => {
	  const timer = setInterval(fn, everyMs);
	  return () => clearInterval(timer);
	});
	cancelParked = schedule(() => {
	  if (!live()) { onClosed(); return; }
	  if (parkedInFlight || monotonicNow() < backoff.nextAllowedAt()) return;
	  parkedInFlight = true;
	  void session.maintain().catch(() => {
	    opts.onMaintenanceError?.();
	  }).finally(() => { parkedInFlight = false; onClosed(); });
	}, 30_000);
      }
    },
  };
  return session;
}

async function openRoutingIncarnation(opts: ShiftRoutingSessionOptions & {
  beforeRequest?: () => void; onRateLimit?: (error: HubError) => void;
}): Promise<
  Omit<ShiftRoutingSession, 'brokerTarget' | 'ensureScope' | 'nextRequestAllowedAt' | 'stop'> & {
    readRoutedV2: NonNullable<ReturnType<ShiftRoutingSession['brokerTarget']>>['routedV2Read'];
    readRecordedV2: NonNullable<ReturnType<ShiftRoutingSession['brokerTarget']>>['routedLiveV2Read'];
    readRoutedPairV2: NonNullable<ReturnType<ShiftRoutingSession['brokerTarget']>>['routedV2PairRead'];
    readRecordedPairV2: NonNullable<ReturnType<ShiftRoutingSession['brokerTarget']>>['routedLiveV2PairRead'];
    readInvocationBinding: NonNullable<ReturnType<ShiftRoutingSession['brokerTarget']>>['readInvocationBinding'];
    stop(): Promise<HubError | undefined>;
  }
> {
  const origin = new URL(opts.origin);
  if (origin.protocol !== 'https:' || origin.origin !== opts.origin || origin.username || origin.password) throw new Error('routing origin refused');
  const now = opts.now ?? Date.now;
  ensureStateDir(opts.stateDir);
  const root = join(opts.stateDir, '.routing-handoffs');
  privateDirectory(root, true);
  const preserved = new Set<string>();
  const maintenance = handoffMaintenance(root, now, preserved);
  maintenance.sweep();
  let authority: RoutingSessionOpenResponse | undefined;
  const hub = createHubClient({ origin: opts.origin, getToken: opts.getToken,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    routingSession: { allowedOrigin: opts.origin, get: () => authority, now,
      beforeRequest: opts.beforeRequest, onRateLimit: opts.onRateLimit } });
  try { authority = await hub.openRoutingSession({ scope: opts.scope }, AbortSignal.timeout(10_000)); }
  catch (error) {
    maintenance.close();
    // scopedPost already sanitizes HTTP errors. Retain status/Retry-After so
    // session rotation participates in the loop's existing server backoff.
    if (error instanceof HubError) throw error;
    throw new Error('routing session open failed');
  }
  if (!authority || !/^rs_[a-f0-9-]{36}$/.test(authority.sessionId)
    || !authority.shiftId?.startsWith('shf_') || typeof authority.credential !== 'string'
    || !authority.credential.startsWith(`rs1.${authority.sessionId}.`)
    || !/^rs1\.rs_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(authority.credential)
    || !Number.isSafeInteger(authority.expiresAt) || authority.expiresAt <= now()) {
    authority = undefined; maintenance.close(); throw new Error('routing session response refused');
  }
  const incarnation = `inc_${randomBytes(16).toString('hex')}`;
  const directory = join(root, incarnation);
  let directoryInode: Stats;
  try {
    mkdirSync(directory, { mode: 0o700 }); // Exclusive incarnation ownership.
    directoryInode = privateDirectory(directory);
    preserved.add(directory);
  } catch {
    try { await hub.closeRoutingSession(AbortSignal.timeout(10_000)); } catch { /* Expiry remains the remote bound. */ }
    authority = undefined; maintenance.close();
    throw new Error('routing incarnation creation failed');
  }
  const rootInode = privateDirectory(root);
  const ensureIncarnation = () => {
    if (!sameInode(privateDirectory(root), rootInode)) throw new Error('routing private root changed');
    try {
      if (!sameInode(privateDirectory(directory), directoryInode)) throw new Error('routing incarnation changed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Another startup may reclaim an empty incarnation. Recreate only an
      // absent entry exclusively; a substituted directory is never adopted.
      mkdirSync(directory, { mode: 0o700 });
      directoryInode = privateDirectory(directory);
    }
  };
  const owned = new Map<string, RoutingHandoff>();
  let stopped = false;
  let renewalDenied = false;
  let renewing: Promise<void> | undefined;
  let closing: Promise<HubError | undefined> | undefined;
  const finish = (): Promise<HubError | undefined> => {
    if (!stopped || owned.size > 0) return Promise.resolve(undefined);
    closing ??= (async () => {
      let closeRateLimit: HubError | undefined;
      try {
	await renewing;
	if (authority) await hub.closeRoutingSession(AbortSignal.timeout(10_000));
      } catch (error) {
	// Remote expiry bounds authority. A 429 also gates the next Shift poll.
	if (error instanceof HubError && error.status === 429) closeRateLimit = error;
      }
      finally {
	authority = undefined;
	maintenance.close();
	try { if (sameInode(privateDirectory(directory), directoryInode)) rmdirSync(directory); } catch { /* Preserve substituted or nonempty entries. */ }
	opts.onClosed?.();
      }
      return closeRateLimit;
    })();
    return closing;
  };
  return {
    hub,
    identity: () => renewalDenied ? undefined : authority && ({ orgId: opts.orgId, principalId: opts.principalId,
      sessionId: authority.sessionId, shiftId: authority.shiftId, expiresAt: authority.expiresAt }),
    async readRoutedV2(kind, expected) {
      // Shift stop forbids new handoffs but an already owned detached worker
      // retains its original incarnation until terminal/remote expiry.
      if (renewalDenied || !authority || now() >= authority.expiresAt) throw new Error('routed v2 session unavailable');
      const sessionId = authority.sessionId, shiftId = authority.shiftId;
      const reader = createTrustedRoutedReferenceV2Reader({ origin: opts.origin,
	getToken: opts.getToken, expected, beforeRequest: opts.beforeRequest,
	onRateLimit: opts.onRateLimit,
	getSession: async () => {
	  if (!authority || authority.sessionId !== sessionId || authority.shiftId !== shiftId
	    || now() >= authority.expiresAt) throw new Error('routed v2 session changed');
	  return authority.credential;
	} });
      return kind === 'reference' ? reader.readReference() : reader.readClaim();
    },
    async readRoutedPairV2(expected) {
      if (renewalDenied || !authority || now() >= authority.expiresAt)
				throw new Error('routed pair session unavailable');
			const sessionId = authority.sessionId, shiftId = authority.shiftId;
			const reader = createTrustedRoutedInputPairV2Reader({ origin: opts.origin,
				getToken: opts.getToken, expected, beforeRequest: opts.beforeRequest,
				onRateLimit: opts.onRateLimit,
				getSession: async () => {
					if (renewalDenied || !authority || authority.sessionId !== sessionId || authority.shiftId !== shiftId
						|| now() >= authority.expiresAt) throw new Error('routed pair session changed');
					return authority.credential;
				} });
			const pair = await reader.read();
			if (renewalDenied || !authority || authority.sessionId !== sessionId || authority.shiftId !== shiftId
				|| now() >= authority.expiresAt) throw new Error('routed pair session changed');
      return pair;
    },
    async readRecordedV2(kind, expected) {
      if (renewalDenied || !authority || now() >= authority.expiresAt)
	throw new Error('routed recorded session unavailable');
      const sessionId = authority.sessionId, shiftId = authority.shiftId;
      const reader = createRecordedRoutedV2Reader({ origin: opts.origin,
	getToken: opts.getToken, expected, beforeRequest: opts.beforeRequest,
	onRateLimit: opts.onRateLimit,
	getSession: async () => {
	  if (!authority || authority.sessionId !== sessionId || authority.shiftId !== shiftId
	    || now() >= authority.expiresAt) throw new Error('routed recorded session changed');
	  return authority.credential;
	} });
      return kind === 'reference' ? reader.readReference() : reader.readClaim();
    },
    async readRecordedPairV2(expected) {
      if (renewalDenied || !authority || now() >= authority.expiresAt)
				throw new Error('routed recorded pair session unavailable');
			const sessionId = authority.sessionId, shiftId = authority.shiftId;
			const reader = createRecordedRoutedInputPairV2Reader({ origin: opts.origin,
				getToken: opts.getToken, expected, beforeRequest: opts.beforeRequest,
				onRateLimit: opts.onRateLimit,
				getSession: async () => {
					if (renewalDenied || !authority || authority.sessionId !== sessionId || authority.shiftId !== shiftId
						|| now() >= authority.expiresAt) throw new Error('routed recorded pair session changed');
					return authority.credential;
				} });
			const pair = await reader.read();
			if (renewalDenied || !authority || authority.sessionId !== sessionId || authority.shiftId !== shiftId
				|| now() >= authority.expiresAt) throw new Error('routed recorded pair session changed');
      return pair;
    },
    async readInvocationBinding(key, phase, expected, binding) {
      if (renewalDenied || !authority || now() >= authority.expiresAt)
	throw new Error('routed invocation session unavailable');
      const sessionId = authority.sessionId, shiftId = authority.shiftId;
      const reader = createDirectRoutedInvocationReader({ origin: opts.origin,
	orgId: opts.orgId, getToken: opts.getToken, expected,
	beforeRequest: opts.beforeRequest, onRateLimit: opts.onRateLimit,
	getSession: async () => {
	  if (!authority || authority.sessionId !== sessionId || authority.shiftId !== shiftId
	    || now() >= authority.expiresAt) throw new Error('routed invocation session changed');
	  return authority.credential;
	} });
      const result = await reader(key, phase, binding);
      if (!authority || authority.sessionId !== sessionId || authority.shiftId !== shiftId
	|| now() >= authority.expiresAt) throw new Error('routed invocation session changed');
      return result;
    },
    createHandoff(reservation, broker, definitionStage) {
      if (stopped || renewalDenied || !authority || now() >= authority.expiresAt || owned.has(reservation.token)
	|| !readChildReservations(opts.stateDir).some(r => r.token === reservation.token
	  && r.workflow === reservation.workflow && r.run === reservation.run && r.reservedAt === reservation.reservedAt)) throw new Error('routing reservation unavailable');
      if (opts.workRoot !== undefined && resolve(opts.workRoot) !== opts.workRoot)
	throw new Error('routing work root unavailable');
      if (opts.workRepo !== undefined && resolve(opts.workRepo) !== opts.workRepo)
	throw new Error('routing work repo unavailable');
      ensureIncarnation();
      const nonce = (opts.nonce ?? (() => randomBytes(16).toString('hex')))();
      if (!/^[a-f0-9]{32}$/.test(nonce) || !sameInode(privateDirectory(directory), directoryInode)) throw new Error('routing handoff ownership refused');
      const path = join(directory, `${nonce}.json`);
      const createdAt = now();
      const payload: RoutingHandoffV1 = { version: 'routing-handoff-v1', incarnation, nonce,
	origin: opts.origin, orgId: opts.orgId, sessionId: authority.sessionId, shiftId: authority.shiftId,
	...(opts.workRoot ? { workRoot: opts.workRoot } : {}),
	...(opts.workRepo ? { workRepo: opts.workRepo } : {}),
	...(broker ? { broker: { socketPath: broker.socketPath, cap: broker.cap },
	  ...(broker.holder ? { holderBroker: broker.holder } : {}) } : {}),
	...(definitionStage ? { definitionStage: { path: definitionStage.path, digest: definitionStage.digest } } : {}),
	reservation: { ...reservation }, createdAt,
	expiresAt: Math.min(createdAt + 120_000, authority.expiresAt), sessionExpiresAt: authority.expiresAt };
      if (payload.expiresAt <= createdAt) throw new Error('routing handoff deadline expired');
      let fd: number | undefined;
      let inode: Stats | undefined;
      try {
	fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	inode = fstatSync(fd);
	const bytes = JSON.stringify(payload);
	if (Buffer.byteLength(bytes) > HANDOFF_MAX_BYTES) throw new Error('routing handoff too large');
	writeFileSync(fd, bytes);
      } catch {
	if (inode) removeExactHandoff(path, inode);
	throw new Error('routing handoff creation failed');
      } finally { if (fd !== undefined) closeSync(fd); }
      let terminal = false;
      const handoff: RoutingHandoff = { path, incarnation, nonce, terminal: () => {
	if (terminal) return;
	terminal = true;
	try {
	  if (!sameInode(privateDirectory(root), rootInode)) throw new Error('routing handoff ownership changed');
	  try {
	    if (!sameInode(privateDirectory(directory), directoryInode)) throw new Error('routing handoff ownership changed');
	    removeExactHandoff(path, inode!);
	  } catch (error) {
	    // Another startup may remove an empty incarnation after this child
	    // consumed its file. No path remains to clean up in that case.
	    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	  }
	} finally {
	  owned.delete(reservation.token);
	  void finish();
	}
      } };
      owned.set(reservation.token, handoff);
      return handoff;
    },
    async maintain() {
      if (closing) { await closing; return; }
      maintenance.sweep();
      // stop() forbids new handoffs but a live detached worker still owns this
      // session. Rotation and global stop both keep it renewable until terminal.
      if (renewalDenied || !authority || (stopped && owned.size === 0) || now() < authority.expiresAt - 60_000) return;
      renewing ??= (async () => {
	let renewed;
	try { renewed = await hub.renewRoutingSession(AbortSignal.timeout(10_000)); }
	catch (error) {
	  if (error instanceof HubError && (error.status === 401 || error.status === 403)) renewalDenied = true;
	  throw error;
	}
	if (!authority || renewed.sessionId !== authority.sessionId || renewed.shiftId !== authority.shiftId
	  || !Number.isSafeInteger(renewed.expiresAt) || renewed.expiresAt <= now()) throw new Error('routing renewal refused');
	authority = { ...authority, expiresAt: renewed.expiresAt };
      })();
      try { await renewing; } finally { renewing = undefined; }
    },
    async stop() { stopped = true; return finish(); },
  };
}

/** Nonsecret opt-in switch; its value is never a credential transport. */
export function routingSessionEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env['OWENLOOP_ROUTING_SESSION'];
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  throw new Error('OWENLOOP_ROUTING_SESSION must be 0 or 1');
}

export function selectShiftRoutingTuples(candidate: RoutingOfferCandidate, local: readonly RosterCandidate[], available: (tuple: LocalModelTuple) => boolean = () => true): LocalTupleEligibility[] {
  const policy = candidate.rolePolicy;
  if (!policy || policy.unknownRole !== 'refuse' || policy.revision !== candidate.context.rolePolicyRevision
    || !['research', 'implementation', 'review', 'judge'].includes(candidate.role)) return [];
  return candidate.tuples.filter(row => row.eligible && row.available && available(row.tuple)
    && local.some(t => t.harness === row.tuple.harness && t.model === row.tuple.model && t.effort === row.tuple.effort)
    && policy.rules.some(rule => rule.model === row.tuple.model && rule.roles.some(role => role === candidate.role)));
}

/** Local account and crew authority for one service offer context. */
function selectLocalRoutingTuplesWithSnapshot(candidate: RoutingOfferCandidate, opts: {
  env: NodeJS.ProcessEnv; origin: string; account: string; serving: readonly string[];
  harnessAvailable: (harness: string) => boolean;
}): { tuples: LocalTupleEligibility[]; snapshot: string } | undefined {
  const cache = readHubRosterCache(opts.env, opts.origin, opts.account);
  if (cache.kind !== 'hit' || cache.data.orgId !== candidate.context.orgId) return undefined;
  const crew = cache.data.crews.find(row => row.crewId === candidate.context.crewId)?.crewName;
  if (!crew || (opts.serving.length > 0 && !opts.serving.includes(crew))) return undefined;
  const merged = mergeRosterLayers(effectiveRosterLayers(opts.env, crew, {
    origin: opts.origin, account: opts.account,
  }));
  const rows = Object.fromEntries(Object.entries(merged).map(([key, row]) => [key, row.candidates]));
  const selected = resolveCapabilityCandidates(rows, [candidate.context.capability]);
  if (!selected) return undefined;
  return { tuples: selectShiftRoutingTuples(candidate, selected.candidates)
    .filter(row => opts.harnessAvailable(row.tuple.harness)),
    snapshot: valueDigestHex({ crew, capability: selected.capability, match: selected.match,
      candidates: selected.candidates }) };
}

export function selectLocalRoutingTuples(candidate: RoutingOfferCandidate, opts: {
  env: NodeJS.ProcessEnv; origin: string; account: string; serving: readonly string[];
  harnessAvailable: (harness: string) => boolean;
}): LocalTupleEligibility[] {
  return selectLocalRoutingTuplesWithSnapshot(candidate, opts)?.tuples ?? [];
}
