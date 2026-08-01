/**
 * Process-lifecycle signal seams shared by the standing roles (`proxy`, `hold`).
 *
 * Extracted from `src/roles/proxy.ts` (C3) so C4's `hold` reuses the exact
 * same shutdown mechanism instead of inventing a second one. Two seams:
 *
 *  - `installSignalHandlers` — first SIGINT/SIGTERM flips the target's
 *    `stop(reason?)`; a second signal (either kind) hard-exits 130 (an
 *    operator insisting). The role name and the first-signal drain note are
 *    parameterized so each role prints its own line; proxy's defaults keep its
 *    messages byte-identical to C3 (its regression test asserts them).
 *  - `watchStdinEof` — fires a callback once when stdin reaches EOF (`end` or
 *    `close`). For `hold`, stdin EOF is the parent-session-death signal (a live
 *    pipe closing means the interactive session that spawned hold is gone), so
 *    it triggers the same final-breath handoff a signal does.
 *
 * Both take injectable hosts (a `process`-shaped slice / a stream-shaped slice)
 * so the wiring is testable without signaling the real process or closing real
 * stdin.
 */

/** The slice of `process` the signal wiring needs — injectable for tests. */
export interface SignalHost {
  on(signal: 'SIGINT' | 'SIGTERM', handler: () => void): unknown;
  exit(code: number): void;
}

/** Message/behavior knobs for a role's signal wiring. */
export interface SignalOptions {
  /** Role name for the message prefix `owenloop work <role>:` (default `proxy`). */
  role?: string;
  /** First-signal note after `<sig> received — ` (default proxy's drain note). */
  drainNote?: string;
  /** Reason handed to `target.stop()` on the first signal (roles that care). */
  stopReason?: string;
}

const DEFAULT_ROLE = 'proxy';
const DEFAULT_DRAIN_NOTE = 'draining, in-flight children keep running';

/**
 * Clean-shutdown signal wiring: the first SIGINT/SIGTERM flips
 * `target.stop(reason)`; a second signal hard-exits 130. Exported with an
 * injectable host so the wiring is testable without signaling the test process.
 */
export function installSignalHandlers(
  target: { stop(reason?: string): void },
  host: SignalHost,
  err: (line: string) => void,
  opts: SignalOptions = {},
): void {
  const role = opts.role ?? DEFAULT_ROLE;
  const drainNote = opts.drainNote ?? DEFAULT_DRAIN_NOTE;
  let signalled = false;
  const onSignal = (sig: 'SIGINT' | 'SIGTERM'): void => {
    if (signalled) {
      err(`owenloop work ${role}: second ${sig} — exiting now`);
      host.exit(130);
      return;
    }
    signalled = true;
    err(`owenloop work ${role}: ${sig} received — ${drainNote}`);
    target.stop(opts.stopReason);
  };
  host.on('SIGINT', () => onSignal('SIGINT'));
  host.on('SIGTERM', () => onSignal('SIGTERM'));
}

/** The slice of a readable stream the EOF watcher needs — injectable for tests. */
export interface StdinHost {
  on(event: 'end' | 'close', handler: () => void): unknown;
  /** Flowing mode is required for `end` to fire on a piped stdin; optional. */
  resume?(): void;
}

/**
 * Fire `cb` exactly once when the stream reaches EOF (`end` or `close`,
 * whichever comes first). Calls `resume()` if present so a paused stdin starts
 * flowing (otherwise `end` never arrives). Idempotent — a stream that emits
 * both `end` and `close` still calls back once.
 */
export function watchStdinEof(stream: StdinHost, cb: () => void): void {
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    cb();
  };
  stream.on('end', fire);
  stream.on('close', fire);
  stream.resume?.();
}
