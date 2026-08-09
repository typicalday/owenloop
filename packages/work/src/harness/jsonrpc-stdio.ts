/**
 * A newline-delimited JSON-RPC 2.0 client over a child process's stdio.
 *
 * Attribution: adapted from the kanna project's app-server client
 * (`github.com/jakemor/kanna`), MIT-style license, Copyright (c) 2025 Jake Mor.
 * Knowledge was ported, not source; the fuller license note (kanna's grant
 * carve-out, and why it does not bind typicalday) lives in the adapter module
 * that names the vendor, because this file may not.
 *
 * VENDOR-NEUTRAL BY MANDATE. `test/harness-isolation.test.ts` greps a vendor
 * pattern over the FULL TEXT — code and comments alike — of every `.ts` under
 * `src/harness/`, and allowlists only the per-harness adapter modules by exact
 * path. This file is NOT on that allowlist, so it may not name a provider, a
 * provider's binary, a provider's env var, or a provider's own source files
 * anywhere in it. Everything here is therefore described in protocol terms.
 *
 * WHY IT IS HAND-ROLLED. The repo keeps a deliberately small runtime dependency
 * set, and the server this drives deviates from JSON-RPC 2.0 in a way that
 * breaks strict libraries anyway (see `classifyFrame`): inbound frames carry no
 * `jsonrpc` member at all.
 *
 * TWO LAYERS, ON PURPOSE:
 *  - `createRpcCore` — framing, correlation, timeouts, and dispatch over an
 *    injected `write` sink. No process, no streams, no timers you cannot
 *    control. This is the layer the framing/correlation unit tests drive, so a
 *    framing bug fails a test that never spawned anything.
 *  - `startStdioRpc` — spawns the child and wires the core to its stdio.
 *
 * Failure stance: total on the read path. A line that is not JSON, a response
 * for an id nobody is waiting on, and a notification for an unknown method are
 * all REPORTED (through `onStderr`) and skipped — never thrown, because one
 * stray byte on stdout must not kill a live session. Every request is
 * independently timed out, because a server that silently drops an unknown
 * method (which the server this was written for does) would otherwise leak the
 * pending promise forever.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

/** One decoded inbound frame. Every member is optional — see `classifyFrame`. */
export interface JsonRpcFrame {
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A JSON-RPC `error` object, surfaced as a rejection from `request`. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

/** The dispatch callbacks both layers share. */
export interface RpcHandlers {
  /** Every server→client NOTIFICATION (a frame with `method` and no `id`). */
  onNotification(method: string, params: unknown): void;
  /**
   * Every server→client REQUEST (a frame with both `method` and `id`). Resolve
   * with the result value, or throw to make the client reply with a JSON-RPC
   * error. The client ALWAYS writes exactly one reply either way: an unanswered
   * server request blocks the server's turn indefinitely.
   */
  onServerRequest(method: string, params: unknown, id: number | string): Promise<unknown>;
  /**
   * Diagnostics. Carries the child's stderr line by line AND this client's own
   * read-path complaints (unparseable line, unknown response id, unclassifiable
   * frame). A reporting channel, not an error channel — nothing on it is fatal,
   * and nothing under `src/` may print.
   */
  onStderr(line: string): void;
}

export interface RpcCoreOptions extends RpcHandlers {
  /** Sink for one outbound frame, already serialized and newline-terminated. */
  write(line: string): void;
  /** Per-request timeout in ms. Default 120_000. */
  requestTimeoutMs?: number;
}

export interface RpcCore {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  /** Feed one chunk of the inbound byte stream. Chunk boundaries are arbitrary. */
  onData(chunk: Buffer | string): void;
  /** Reject every in-flight request (disposal, child exit, spawn failure). */
  rejectAll(err: Error): void;
  /** How many requests are still awaiting a response. For tests and assertions. */
  pendingCount(): number;
}

export interface StdioRpcOptions extends RpcHandlers {
  /** Executable to spawn. Resolved through `PATH` when it is a bare name. */
  command: string;
  args: string[];
  cwd?: string;
  /**
   * The child's environment. OMITTED means "inherit this process's environment
   * untouched" (node's own `spawn` default) — that is a recorded decision for
   * this transport, not an oversight. When supplied it REPLACES the child's
   * environment wholesale, so a caller that supplies it must pass a full
   * environment, not a set of deltas.
   */
  env?: Record<string, string | undefined>;
  /** Per-request timeout in ms. Default 120_000. */
  requestTimeoutMs?: number;
  /** Child process exit. Fires once, after every pending request is rejected. */
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
}

export interface StdioRpcClient {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  /** SIGTERM the child's process group, SIGKILL after a grace period. Idempotent. */
  dispose(): Promise<void>;
  readonly pid: number | undefined;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** How long `dispose` waits after SIGTERM before escalating to SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** Bookkeeping for one outbound request awaiting its response. */
interface Pending {
  method: string;
  startedAt: number;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/** What a decoded inbound frame turns out to be. */
export type FrameKind = 'response' | 'server-request' | 'notification' | 'unknown';

/**
 * Classify a decoded frame.
 *
 * DELIBERATELY DOES NOT LOOK AT `jsonrpc`. The server this client was written
 * against omits the `jsonrpc` member from every inbound frame — responses
 * arrive as `{id, result}`, errors as `{error, id}`, notifications as
 * `{method, params, emittedAtMs}`. A validator that requires `jsonrpc === '2.0'`
 * rejects 100% of real traffic, so classification keys on the presence of
 * `id` / `method` / `result` / `error` only, in this order.
 *
 * Exported so a unit test can pin the rule directly.
 */
export function classifyFrame(frame: JsonRpcFrame): FrameKind {
  const hasId = 'id' in frame && frame.id !== undefined && frame.id !== null;
  if (hasId && ('result' in frame || 'error' in frame)) return 'response';
  if (hasId && typeof frame.method === 'string') return 'server-request';
  if (typeof frame.method === 'string') return 'notification';
  return 'unknown';
}

/**
 * A line-oriented, UTF-8-safe reader over a byte stream.
 *
 * `StringDecoder` is what makes a multi-byte character split across two chunks
 * survive: decoding each chunk independently emits replacement characters at
 * the seam. Exported so the framing tests can drive it directly.
 */
export function createLineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  return (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      // `noUncheckedIndexedAccess` is on; slicing avoids indexed reads entirely.
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (trimmed.trim() !== '') onLine(trimmed);
      nl = buffer.indexOf('\n');
    }
  };
}

/**
 * The protocol engine: framing in, correlation and dispatch out, over an
 * injected `write`. Knows nothing about processes.
 */
export function createRpcCore(opts: RpcCoreOptions): RpcCore {
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pending = new Map<number, Pending>();
  let nextId = 1;

  function send(msg: unknown): void {
    opts.write(`${JSON.stringify(msg)}\n`);
  }

  function handleResponse(frame: JsonRpcFrame): void {
    const id = typeof frame.id === 'number' ? frame.id : Number(frame.id);
    const p = pending.get(id);
    if (p === undefined) {
      // A LATE response for an id that already timed out (or was never ours)
      // lands here. Reporting and dropping it is required — throwing would take
      // down a healthy session over a message nobody is waiting for.
      opts.onStderr(`[unmatched response] id=${String(frame.id)}`);
      return;
    }
    clearTimeout(p.timer);
    pending.delete(id);
    if (frame.error !== undefined && frame.error !== null) {
      p.reject(new JsonRpcError(frame.error.code, frame.error.message, frame.error.data));
      return;
    }
    p.resolve(frame.result);
  }

  function handleServerRequest(frame: JsonRpcFrame): void {
    const id = frame.id as number | string;
    const method = frame.method as string;
    // ALWAYS exactly one reply. `void` the promise deliberately: the reply is
    // written inside it, and there is no caller to await.
    void (async (): Promise<void> => {
      try {
        const result = await opts.onServerRequest(method, frame.params, id);
        send({ jsonrpc: '2.0', id, result: result ?? {} });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        });
      }
    })();
  }

  const onData = createLineReader((line) => {
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(line) as JsonRpcFrame;
    } catch {
      // A stray non-JSON line is a diagnostic, not a fatal error: report it and
      // keep reading so the NEXT valid line still parses.
      opts.onStderr(`[non-JSON stdout] ${line}`);
      return;
    }
    if (typeof frame !== 'object' || frame === null) {
      opts.onStderr(`[non-object frame] ${line}`);
      return;
    }
    switch (classifyFrame(frame)) {
      case 'response':
        handleResponse(frame);
        return;
      case 'server-request':
        handleServerRequest(frame);
        return;
      case 'notification':
        opts.onNotification(frame.method as string, frame.params);
        return;
      case 'unknown':
        opts.onStderr(`[unclassifiable frame] ${line}`);
        return;
    }
  });

  return {
    onData,
    pendingCount: () => pending.size,

    rejectAll(err: Error): void {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      pending.clear();
    },

    request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      const id = nextId++;
      const budget = timeoutMs ?? requestTimeoutMs;
      const startedAt = Date.now();
      const p = new Promise<T>((resolve, reject) => {
        // MANDATORY (not defensive): this server answers a genuinely-absent
        // method with NO frame at all, so correlation alone leaks the pending
        // entry forever. `unref` so a still-pending request cannot hold the
        // event loop — and therefore a test runner — open.
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`request '${method}' timed out after ${Date.now() - startedAt}ms`));
        }, budget);
        timer.unref();
        pending.set(id, {
          method,
          startedAt,
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });
      });
      send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      return p;
    },

    notify(method: string, params?: unknown): void {
      send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
    },
  };
}

/** Spawn `command args` and speak newline-delimited JSON-RPC to its stdio. */
export function startStdioRpc(opts: StdioRpcOptions): StdioRpcClient {
  // `detached: true` puts the child in its OWN process group, which is the only
  // thing that makes `process.kill(-pid, ...)` able to reap the grandchildren
  // the child spawns on its own.
  //
  // ENVIRONMENT: this transport does not decide it. With no `env` option the
  // child inherits this process's environment untouched, which is the recorded
  // decision for the adapter that uses this transport; with one, that value is
  // the child's whole environment. Either way the policy lives in the caller.
  const child: ChildProcessWithoutNullStreams = spawn(opts.command, opts.args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });

  let disposed = false;
  let exited = false;
  let disposePromise: Promise<void> | undefined;

  const core = createRpcCore({
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    write: (line) => {
      if (child.stdin.destroyed || child.stdin.writableEnded) return;
      child.stdin.write(line);
    },
    onNotification: opts.onNotification,
    onServerRequest: opts.onServerRequest,
    onStderr: opts.onStderr,
  });

  child.stdout.on('data', core.onData);
  child.stdout.on('error', (err: Error) => opts.onStderr(`[stdout error] ${err.message}`));

  const readStderr = createLineReader((line) => opts.onStderr(line));
  child.stderr.on('data', readStderr);
  child.stderr.on('error', (err: Error) => opts.onStderr(`[stderr error] ${err.message}`));

  child.stdin.on('error', (err: Error) => opts.onStderr(`[stdin error] ${err.message}`));

  child.on('error', (err: Error) => {
    opts.onStderr(`[spawn error] ${err.message}`);
    // Node 22 emits `error` followed by `close`, but no `exit`, when the
    // executable does not exist. Mark that pre-spawn failure terminal so
    // `dispose()` does not wait on an `exit` event that can never arrive. Do
    // not invoke `onExit`: the caller that owns the failed startup still has
    // the original error and can report its safe, specific message once.
    if (child.pid === undefined) exited = true;
    core.rejectAll(err);
  });

  child.on('exit', (code, signal) => {
    exited = true;
    core.rejectAll(new Error(`process exited (code=${String(code)}, signal=${String(signal)})`));
    opts.onExit(code, signal);
  });

  return {
    get pid(): number | undefined {
      return child.pid;
    },

    request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      if (disposed || exited) {
        return Promise.reject(new Error(`cannot send '${method}': the client is no longer running`));
      }
      return core.request<T>(method, params, timeoutMs);
    },

    notify(method: string, params?: unknown): void {
      if (disposed || exited) return;
      core.notify(method, params);
    },

    dispose(): Promise<void> {
      // Idempotent: the second call returns the same promise the first made.
      if (disposePromise !== undefined) return disposePromise;
      disposed = true;
      core.rejectAll(new Error('client disposed'));

      disposePromise = (async (): Promise<void> => {
        if (exited) return;
        const done = new Promise<void>((resolve) => {
          if (exited) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
        });
        try {
          child.stdin.end();
        } catch {
          // a closed pipe is not an error at teardown
        }
        killGroup(child.pid, 'SIGTERM', opts.onStderr);
        await Promise.race([done, sleepUnref(KILL_GRACE_MS)]);
        if (!exited) {
          killGroup(child.pid, 'SIGKILL', opts.onStderr);
          await Promise.race([done, sleepUnref(KILL_GRACE_MS)]);
        }
      })();
      return disposePromise;
    },
  };
}

/** A timer that cannot by itself keep the event loop alive. */
function sleepUnref(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

/**
 * Signal the child's whole process group, falling back to the process itself.
 *
 * `ESRCH` ("no such process") means it is already gone, which is the success
 * case at teardown, not a failure. `EPERM` can happen when the group is gone
 * but the pid was recycled; both are reported and swallowed.
 */
function killGroup(pid: number | undefined, signal: NodeJS.Signals, onStderr: (line: string) => void): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'ESRCH' && code !== 'EPERM') onStderr(`[kill group ${signal}] ${String(err)}`);
  }
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'ESRCH') onStderr(`[kill ${signal}] ${String(err)}`);
  }
}
