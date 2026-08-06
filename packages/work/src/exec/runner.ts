/**
 * The command-runner seam (C5, plan decision 7).
 *
 * exec's one job that actually touches the machine: shell out the order's opaque
 * `command` string, capture its result, and — on a kill — take down the whole
 * process group. It is a SEAM so the exec loop's tests drive a fake runner and
 * never spawn a real child; only `exec-runner.test.ts` exercises the default
 * impl, against harmless fixtures in a test-created temp cwd.
 *
 * The default runner spawns `/bin/sh -c <command>` DETACHED (its own process
 * group, so a group-kill reaches every descendant the command forks) with
 * stdout/stderr piped. It captures:
 *  - `outputHash`: sha256 over the FULL stdout bytes then the FULL stderr bytes
 *    (in that order): `sha256:<hex>`. To hash the full streams in that order
 *    with bounded live memory, stdout is fed to the hash as it arrives and
 *    stderr chunks that arrive before stdout ends are buffered, then flushed in
 *    order. That out-of-order buffer is CAPPED at 1 MiB (a long command
 *    streaming progress to stderr while stdout stays open would otherwise
 *    buffer its entire stderr — an OOM vector). On overflow the capture
 *    degrades deterministically to the two-part form
 *    `sha256:<sha256(full stdout)>+<sha256(full stderr)>` — both streams still
 *    fully hashed, only the interleaved ordering claim is dropped, and the
 *    hash string itself says which form it is. Memory stays bounded either way.
 *  - `outputTail`: the last 4 KiB of the combined (stdout-then-stderr) output,
 *    decoded lossily as UTF-8 — enough for a human to eyeball a failure without
 *    bloating the submitted receipt (each retained tail buffer is itself capped
 *    at 1 MiB). Binary / no-trailing-newline output is fine: the tail is a lossy
 *    excerpt, the hash is over raw bytes.
 *
 * Execution-machinery failure (spawn ENOENT, a missing cwd, an `error` event)
 * resolves — never rejects — with `exitCode: null` and an `error` string, so the
 * exec loop can submit a receipt for it (plan decision 2) rather than crashing.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { PAYLOAD_MARKER, PAYLOAD_MAX_BYTES } from './payload.ts';

const RETAIN_CAP_BYTES = 1024 * 1024; // 1 MiB retained per stream (for the tail)
const TAIL_BYTES = 4096; // last 4 KiB of combined output kept in the receipt
const DEFAULT_GRACE_MS = 5_000; // SIGTERM → grace → SIGKILL on a group kill

/** The raw execution facts a run produces; the loop wraps these into a receipt. */
export interface CommandResult {
  /** The command's exit code, or `null` when killed by signal / machinery failed. */
  exitCode: number | null;
  /** The signal that terminated the command, when it was signalled. */
  signal?: string;
  /** Set only on execution-machinery failure (spawn/cwd/error) — not a non-zero exit. */
  error?: string;
  /**
   * `sha256:<hex>` over full stdout bytes then full stderr bytes, or — when
   * out-of-order stderr overflowed the 1 MiB buffer cap — the two-part
   * `sha256:<stdout hex>+<stderr hex>` (each stream hashed fully on its own).
   */
  outputHash: string;
  stdoutBytes: number;
  stderrBytes: number;
  /** Last ≤4 KiB of combined stdout+stderr, decoded lossily as UTF-8. */
  outputTail: string;
  /** Raw text after the last matching stdout payload marker, before JSON parsing. */
  payloadLine?: string;
  /** True when the last matching marker line exceeded the payload cap. */
  payloadOverCap?: boolean;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

/** A command that is running (or has failed to start). */
export interface RunningCommand {
  /** Resolves once the command settles (any exit code, kill, or machinery error). */
  done: Promise<CommandResult>;
  /** Idempotently take down the command's process group (TERM → grace → KILL). */
  kill(): Promise<void>;
}

/** The runner seam. Injected into the exec loop; faked in the loop's tests. */
export interface CommandRunner {
  start(command: string, opts: { cwd: string; env?: Record<string, string | undefined> }): RunningCommand;
}

/** The fully-resolved spawn arguments — pure data, asserted directly in tests. */
export interface CommandPlan {
  command: string;
  args: string[];
  options: {
    cwd: string;
    detached: true;
    stdio: ['ignore', 'pipe', 'pipe'];
    env?: Record<string, string | undefined>;
  };
}

/**
 * Build the argv + options for a detached `/bin/sh -c <command>`. Pure — no
 * spawn, no I/O — so tests assert the shape without launching anything. POSIX
 * `/bin/sh` keeps the default runner portable (ubuntu-latest CI, macOS dev).
 */
export function buildCommandPlan(
  command: string,
  cwd: string,
  env?: Record<string, string | undefined>,
): CommandPlan {
  // If a future package interpolates consumed values into command text or the
  // child environment, that path must inherit resolveCommand's consume-side
  // verification gate before this spawn plan is ever built. OWENLOOP_BUNDLE_DIR,
  // when supplied by exec/loop.ts, is resolver-derived after that gate and is
  // not a consumed artifact value.
  return {
    command: '/bin/sh',
    args: ['-c', command],
    options: {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env !== undefined ? { env } : {}),
    },
  };
}

/** Append `chunk` to a rolling tail buffer keeping only its last `cap` bytes. */
function appendTail(buf: Buffer, chunk: Buffer, cap: number): Buffer {
  const next = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
  return next.length > cap ? next.subarray(next.length - cap) : next;
}

export interface DefaultRunnerOptions {
  /** SIGTERM→SIGKILL grace on a group kill (default 5_000). */
  graceMs?: number;
  /** Clock seam (default `Date.now`). */
  now?: () => number;
  /** Timer seam for the kill grace (default real `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The default command runner: spawns `/bin/sh -c <command>` in its own process
 * group and captures a bounded result. Every timing/timer seam is injectable so
 * the kill-grace path is testable without wall-clock waits.
 */
export function createDefaultRunner(opts: DefaultRunnerOptions = {}): CommandRunner {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

  return {
    start(command: string, startOpts: { cwd: string; env?: Record<string, string | undefined> }): RunningCommand {
      const startedAt = now();
      const plan = buildCommandPlan(command, startOpts.cwd, startOpts.env);

      const hash = createHash('sha256'); // stdout-then-stderr, the ordered form
      const stderrHash = createHash('sha256'); // stderr alone — the degraded fallback
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTail: Buffer = Buffer.alloc(0);
      let stderrTail: Buffer = Buffer.alloc(0);
      let stdoutEnded = false;
      // stderr that arrived before stdout ended, held to preserve the ordered
      // hash — CAPPED: on overflow we drop it and degrade to the two-part hash
      // (`hash` then covers stdout only; `stderrHash` always covers all stderr).
      const pendingStderr: Buffer[] = [];
      let pendingStderrBytes = 0;
      let degraded = false;

      // Scan stdout lines independently of the bounded output tails. The
      // scanner retains only the marker prefix plus the payload cap, so a
      // command cannot force the runner to buffer an unbounded stream.
      const payloadMarker = Buffer.from(PAYLOAD_MARKER, 'utf8');
      const payloadLineCap = payloadMarker.length + PAYLOAD_MAX_BYTES + 1; // +1 detects overflow
      let payloadLineBuffer = Buffer.alloc(0);
      let payloadLineCapped = false;
      let payloadLine: string | undefined;
      let payloadOverCap = false;

      const appendPayloadLine = (chunk: Buffer): void => {
        if (payloadLineCapped || chunk.length === 0) return;
        const remaining = payloadLineCap - payloadLineBuffer.length;
        if (chunk.length > remaining) {
          payloadLineBuffer = Buffer.concat([payloadLineBuffer, chunk.subarray(0, remaining)]);
          payloadLineCapped = true;
          return;
        }
        payloadLineBuffer = Buffer.concat([payloadLineBuffer, chunk]);
      };

      const finishPayloadLine = (): void => {
        if (payloadLineBuffer.length === 0) return;
        let line = payloadLineBuffer;
        if (line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        if (line.length < payloadMarker.length || !line.subarray(0, payloadMarker.length).equals(payloadMarker)) {
          payloadLineBuffer = Buffer.alloc(0);
          payloadLineCapped = false;
          return;
        }
        const rawPayload = line.subarray(payloadMarker.length);
        if (payloadLineCapped || rawPayload.length > PAYLOAD_MAX_BYTES) {
          payloadLine = undefined;
          payloadOverCap = true;
        } else {
          payloadLine = rawPayload.toString('utf8');
          payloadOverCap = false;
        }
        payloadLineBuffer = Buffer.alloc(0);
        payloadLineCapped = false;
      };

      const scanPayload = (chunk: Buffer): void => {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(0x0a, offset);
          const end = newline === -1 ? chunk.length : newline;
          appendPayloadLine(chunk.subarray(offset, end));
          if (newline === -1) break;
          finishPayloadLine();
          offset = newline + 1;
        }
      };

      let settled = false;
      let resolveDone!: (r: CommandResult) => void;
      const done = new Promise<CommandResult>((r) => {
        resolveDone = r;
      });

      const finish = (exitCode: number | null, signal: string | null, error?: string): void => {
        if (settled) return;
        finishPayloadLine();
        settled = true;
        // Flush any stderr that arrived before stdout ended, preserving the
        // stdout-then-stderr hash ordering (a no-op when degraded — dropped).
        if (!degraded) for (const c of pendingStderr) hash.update(c);
        pendingStderr.length = 0;
        pendingStderrBytes = 0;
        const finishedAt = now();
        const combined = Buffer.concat([stdoutTail, stderrTail]);
        const tail = combined.length > TAIL_BYTES ? combined.subarray(combined.length - TAIL_BYTES) : combined;
        resolveDone({
          exitCode,
          ...(signal !== null ? { signal } : {}),
          ...(error !== undefined ? { error } : {}),
          outputHash: degraded
            ? `sha256:${hash.digest('hex')}+${stderrHash.digest('hex')}`
            : `sha256:${hash.digest('hex')}`,
          stdoutBytes,
          stderrBytes,
          outputTail: tail.toString('utf8'),
          ...(payloadLine !== undefined ? { payloadLine } : {}),
          ...(payloadOverCap ? { payloadOverCap: true } : {}),
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
        });
      };

      let child;
      try {
        child = spawn(plan.command, plan.args, plan.options);
      } catch (e) {
        finish(null, null, e instanceof Error ? e.message : String(e));
        return { done, kill: async (): Promise<void> => {} };
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        stdoutBytes += chunk.length;
        stdoutTail = appendTail(stdoutTail, chunk, RETAIN_CAP_BYTES);
        scanPayload(chunk);
      });
      child.stdout?.on('end', () => {
        finishPayloadLine();
        stdoutEnded = true;
        if (!degraded) for (const c of pendingStderr) hash.update(c);
        pendingStderr.length = 0;
        pendingStderrBytes = 0;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrHash.update(chunk); // always — this is the degraded fallback
        if (!degraded) {
          if (stdoutEnded) {
            hash.update(chunk);
          } else if (pendingStderrBytes + chunk.length > RETAIN_CAP_BYTES) {
            // Out-of-order stderr overflowed the cap: drop the held chunks and
            // degrade — `hash` stays stdout-only, `stderrHash` has everything.
            degraded = true;
            pendingStderr.length = 0;
            pendingStderrBytes = 0;
          } else {
            pendingStderr.push(chunk);
            pendingStderrBytes += chunk.length;
          }
        }
        stderrBytes += chunk.length;
        stderrTail = appendTail(stderrTail, chunk, RETAIN_CAP_BYTES);
      });

      child.on('error', (e: Error) => finish(null, null, e.message));
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));

      const kill = async (): Promise<void> => {
        if (settled || child.pid === undefined) return;
        const pid = child.pid;
        try {
          process.kill(-pid, 'SIGTERM'); // negative pid → the whole process group
        } catch {
          // Group already gone (raced the close) — nothing to signal.
          return;
        }
        // Grace, then a hard SIGKILL if it is still alive.
        await Promise.race([done, sleep(graceMs)]);
        if (settled) return;
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Gone between the grace and now — fine.
        }
      };

      return { done, kill };
    },
  };
}
