/**
 * Shift daemon: owns one Unix socket, one self-driven ShiftLoop, a bounded
 * local event FIFO, and at most one parked `next` client.
 *
 * The loop remains the only owner of hub cursor, presence cadence, capacity,
 * dispatch, and child reconciliation. This wrapper only translates local socket
 * requests and loop observations into the Phase 2 JSON-lines protocol.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { createServer, createConnection, type Server, type Socket } from 'node:net';

import type { HubClient } from '../hub/client.ts';
import type { ShiftLoop } from '../shift/loop.ts';
import {
  MAX_EVENT_QUEUE,
  MAX_REQUEST_LINE_BYTES,
  MAX_RESPONSE_LINE_BYTES,
  OVERLAP_ERROR,
  stampShiftEvent,
  type ShiftCapacity,
  type ShiftError,
  type ShiftEvent,
  type ShiftEventBody,
  type ShiftRequest,
  type ShiftResponse,
  type ShiftStatus,
} from './protocol.ts';
import { truncateEventToBytes } from './truncate.ts';

export interface ShiftDaemonOptions {
  socketPath: string;
  stateDir: string;
  loop: ShiftLoop;
  hub: HubClient;
  now: () => number;
  startedAt: number;
  shiftId?: string;
  err: (line: string) => void;
  /**
   * Called with each already-stamped event this daemon SYNTHESIZES rather than
   * receives through `onEvent` — today `event-queue-overflow` and `ended`.
   *
   * These two are the only shift events that never pass through `emit()` in
   * `loop.ts`, so they are the only ones a second consumer would otherwise never
   * see. In `runtime.ts` this callback is the on-disk log sink, which is what
   * makes the file and the socket carry the same record set.
   *
   * The callback must write somewhere that is NOT this daemon's queue. For
   * `event-queue-overflow` that is load-bearing: the queue is what overflowed.
   */
  onSynthesized?: (event: ShiftEvent) => void;
}

export interface ShiftDaemon {
  run(): Promise<number>;
  /** Stop the daemon. `end` performs the final attendance-clearing ping. */
  stop(reason?: 'end' | 'signal' | 'loop'): void;
  status(): ShiftStatus;
  /** Callback passed into createShiftLoop for local dispatch observations. */
  onEvent(event: ShiftEvent): void;
  socketPath: string;
}

interface ParkedNext {
  socket: Socket;
  timer: NodeJS.Timeout | undefined;
}

interface FileIdentity {
  dev: number;
  ino: number;
  ctimeMs: number;
}

interface StartupLock {
  path: string;
  server: Server;
  identity: FileIdentity;
}

const REQUEST_IDLE_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_MS = 500;

function serializedResponseBytes(response: ShiftCapacity): number {
  return Buffer.byteLength(`${JSON.stringify(response)}\n`, 'utf8');
}

/**
 * A single event can be larger than the response ceiling. It is delivered once
 * with its string fields shortened and an explicit marker instead of blocking
 * every later event in the FIFO forever.
 *
 * The algorithm lives in `truncate.ts` and is SHARED with the on-disk log sink,
 * so the file's line ceiling and the wire's are one rule with one
 * implementation. Only the byte accounting differs, and that is what the
 * callback supplies: here, a whole response envelope carrying this one event.
 */
function truncateEventForResponse(event: ShiftEvent, envelope: Omit<ShiftCapacity, 'events'>): ShiftEvent {
  return truncateEventToBytes(event, MAX_RESPONSE_LINE_BYTES, (candidate) =>
    serializedResponseBytes({ ...envelope, events: [candidate] }));
}

function fileIdentity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ctimeMs === right.ctimeMs;
}

function errorResponse(message: string): ShiftError {
  return { error: message };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStaleSocketError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'ENOTCONN' || code === 'EPIPE' || code === 'ETIMEDOUT';
}

async function probeSocket(path: string): Promise<'active' | 'stale'> {
  return new Promise<'active' | 'stale'>((resolve, reject) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (result: 'active' | 'stale'): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish('active'));
    socket.once('error', (error: unknown) => {
      if (isStaleSocketError(error)) finish('stale');
      else {
        settled = true;
        socket.destroy();
        reject(error);
      }
    });
    socket.setTimeout(250, () => finish('stale'));
  });
}

async function bindStartupLock(path: string): Promise<Server> {
  const lockServer = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        lockServer.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        lockServer.off('error', onError);
        resolve();
      };
      lockServer.once('error', onError);
      lockServer.once('listening', onListening);
      lockServer.listen(path);
    });
    return lockServer;
  } catch (error) {
    try { lockServer.close(); } catch { /* not listening */ }
    throw error;
  }
}

/**
 * Acquire an atomic, probeable startup lock.
 *
 * The lock is itself a Unix listener. `listen()` is the atomic acquisition
 * point, and a crashed owner leaves a socket path that a successor can probe;
 * ownership therefore does not depend on a PID that the OS could later reuse.
 */
async function acquireStartupLock(socketPath: string): Promise<StartupLock> {
  const lockPath = `${socketPath}.lock`;
  const waitUntil = Date.now() + 2_000;
  for (;;) {
    try {
      const lockServer = await bindStartupLock(lockPath);
      try {
        chmodSync(lockPath, 0o600);
        return { path: lockPath, server: lockServer, identity: fileIdentity(lstatSync(lockPath)) };
      } catch (error) {
        try { lockServer.close(); } catch { /* best effort */ }
        try { unlinkSync(lockPath); } catch { /* best effort */ }
        throw error;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EADDRINUSE') throw error;
    }

    let current: Stats;
    try {
      current = lstatSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
      throw error;
    }
    if (!current.isSocket()) {
      throw new Error(`cannot start shift daemon: startup lock ${lockPath} exists and is not a socket`);
    }

    const observedIdentity = fileIdentity(current);
    const probe = await probeSocket(lockPath);
    if (probe === 'active') {
      if (Date.now() >= waitUntil) {
        throw new Error(`cannot start shift daemon: another daemon is starting at ${socketPath}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      continue;
    }

    let currentAgain: Stats;
    try {
      currentAgain = lstatSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
      throw error;
    }
    if (!sameFileIdentity(observedIdentity, fileIdentity(currentAgain))) continue;
    // ACCEPTED LIMITATION: this lstat-then-unlink sequence is not atomic. A
    // same-user hostile local process could substitute the path between the
    // check and unlink, but the 0600 socket is in the user's own state
    // directory, where that process already has direct write access.
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
    }
  }
}

function releaseStartupLock(lock: StartupLock): void {
  try { lock.server.close(); } catch { /* already closed */ }
  try {
    const current = lstatSync(lock.path);
    if (sameFileIdentity(lock.identity, fileIdentity(current))) unlinkSync(lock.path);
  } catch {
    // The lock may already have been reclaimed after a crash or operator action.
  }
}

function forceCloseSocket(socket: Socket): void {
  socket.unref();
  try {
    // resetAndDestroy aborts queued writes instead of waiting for a client
    // that stopped reading. Older Node versions fall back to destroy().
    if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
    else socket.destroy();
  } catch {
    socket.destroy();
  }
}

function writeResponse(socket: Socket, response: ShiftResponse): void {
  if (socket.destroyed) return;
  try {
    socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
  } catch {
    forceCloseSocket(socket);
  }
}

function validateRequest(value: unknown): ShiftRequest | ShiftError {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return errorResponse('request must be a JSON object');
  const obj = value as Record<string, unknown>;
  const op = obj['op'];
  if (op === 'status' || op === 'end') return { op };
  if (op === 'next') {
    const wait = obj['wait_ms'];
    if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0) {
      return errorResponse('next wait_ms must be a finite non-negative number');
    }
    return { op: 'next', wait_ms: wait };
  }
  if (op === 'clock_in') {
    const name = obj['name'];
    const crews = obj['serve_crews'];
    if (typeof name !== 'string' || name.trim() === '' || name.trim().length > 200) {
      return errorResponse('clock_in name must be a non-empty string of at most 200 characters');
    }
    if (!Array.isArray(crews) || !crews.every((crew) => typeof crew === 'string' && crew.trim() !== '')) {
      return errorResponse('clock_in serve_crews must be an array of non-empty crew names');
    }
    return {
      op: 'clock_in',
      name: name.trim(),
      serve_crews: crews.map((crew) => (crew as string).trim()),
    };
  }
  return errorResponse(typeof op === 'string' ? `unknown operation '${op}'` : 'request requires an operation');
}

export function createShiftDaemon(opts: ShiftDaemonOptions): ShiftDaemon {
  let server: Server | undefined;
  let socketIdentity: FileIdentity | undefined;
  let opened = false;
  let shutdownStarted = false;
  let shutdownReason: 'end' | 'signal' | 'loop' | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let loopPromise: Promise<number> | undefined;
  let parked: ParkedNext | undefined;
  let shutdownGraceTimer: NodeJS.Timeout | undefined;
  const connections = new Set<Socket>();
  const shutdownSockets = new Set<Socket>();
  const events: ShiftEvent[] = [];

  /**
   * How many events the FIFO has evicted since this daemon started, and the
   * cumulative count at which the NEXT overflow record is written.
   *
   * Reporting every eviction is not an option: an unattended shift — no client
   * ever calls `next`, so nothing ever drains the queue — evicts one event per
   * event forever, and a per-eviction record would roughly double the volume of
   * a file this change does not rotate.
   *
   * Reporting only the first eviction is not an option either: that record says
   * `dropped: 1` and is never corrected, so the operator reading the file learns
   * that loss STARTED and never learns its size.
   *
   * So: report at each power of ten (1, 10, 100, 1000, …). At most ~7 records
   * for any run a real machine can produce, the first arrives immediately, and
   * every record carries a current cumulative total.
   */
  let dropped = 0;
  let nextOverflowReport = 1;

  /** Attach the `{ts, shift, shiftId}` envelope this daemon is responsible for. */
  const stamp = (body: ShiftEventBody): ShiftEvent =>
    stampShiftEvent(body, { name: opts.loop.getShift().name, id: opts.shiftId ?? '' }, opts.now());

  const capacity = (): Omit<ShiftCapacity, 'events'> => {
    const cap = opts.loop.getCap();
    const free = opts.loop.freeCapacity();
    return { cap, free, running: cap - free };
  };

  const status = (): ShiftStatus => {
    const shift = opts.loop.getShift();
    return {
      name: shift.name,
      serve_crews: shift.serveCrews,
      ...capacity(),
      attended_at: opts.loop.getAttendedAt() ?? null,
      started_at: opts.startedAt,
    };
  };

  const respond = (socket: Socket, response: ShiftResponse): void => {
    writeResponse(socket, response);
  };

  const sendParked = (response: ShiftCapacity): void => {
    const current = parked;
    if (current === undefined) return;
    parked = undefined;
    if (current.timer !== undefined) clearTimeout(current.timer);
    respond(current.socket, response);
  };

  const capacityResponse = (): ShiftCapacity => {
    const envelope = capacity();
    const selected: ShiftEvent[] = [];
    while (selected.length < events.length) {
      const next = events[selected.length]!;
      const candidate = { ...envelope, events: [...selected, next] };
      if (serializedResponseBytes(candidate) <= MAX_RESPONSE_LINE_BYTES) {
        selected.push(next);
        continue;
      }
      if (selected.length > 0) break;

      // Never let one pathological event block the FIFO permanently. The
      // original event is consumed once as a marked, size-safe representation.
      const shortened = truncateEventForResponse(next, envelope);
      selected.push(shortened);
    }
    events.splice(0, selected.length);
    return { ...envelope, events: selected };
  };

  const enqueue = (event: ShiftEvent): void => {
    if (events.length >= MAX_EVENT_QUEUE) {
      events.shift();
      opts.err(`shift event queue overflow — dropping oldest event`);
      dropped += 1;
      if (dropped === nextOverflowReport) {
        nextOverflowReport *= 10;
        // DIRECT to the caller's sink — never enqueue(). enqueue() feeds the
        // very queue that just overflowed, so an overflow event routed through
        // it would evict another event, overflow again, and recurse under
        // exactly the load that produced the overflow.
        try {
          opts.onSynthesized?.(stamp({ type: 'event-queue-overflow', dropped }));
        } catch (e) {
          opts.err(`shift event sink failed: ${e instanceof Error ? e.message : String(e)} (continuing)`);
        }
      }
    }
    events.push(event);
    if (parked !== undefined) sendParked(capacityResponse());
  };

  const onEvent = (event: ShiftEvent): void => enqueue(event);

  const cleanupSocket = (): void => {
    if (!opened) return;
    try {
      const current = lstatSync(opts.socketPath);
      if (!current.isSocket()) return;
      if (socketIdentity !== undefined && !sameFileIdentity(socketIdentity, fileIdentity(current))) return;
      unlinkSync(opts.socketPath);
    } catch {
      // The socket may already have been removed by an operator or a failed bind.
    }
    opened = false;
  };

  const closeListening = async (): Promise<void> => {
    if (server === undefined) {
      cleanupSocket();
      return;
    }
    const current = server;
    server = undefined;

    // Node removes a Unix socket by pathname when Server.close() completes.
    // If another process replaced our path after the original socket was
    // unlinked, move the successor aside until the old server has closed. This
    // prevents the old server from removing the successor by pathname.
    let preservedPath: string | undefined;
    try {
      const currentPath = lstatSync(opts.socketPath);
      if (socketIdentity !== undefined && currentPath.isSocket() && !sameFileIdentity(socketIdentity, fileIdentity(currentPath))) {
        preservedPath = `${opts.socketPath}.closing-${process.pid}-${Date.now()}`;
        renameSync(opts.socketPath, preservedPath);
      }
    } catch {
      // The path may already be absent; the server can still be closed.
    }

    const restoreSuccessor = (): void => {
      if (preservedPath === undefined) return;
      try {
        try {
          lstatSync(opts.socketPath);
          unlinkSync(preservedPath);
        } catch {
          renameSync(preservedPath, opts.socketPath);
        }
      } catch {
        // Best effort. Never remove a path that appeared after the rename.
      }
    };

    if (preservedPath !== undefined) {
      // Do not await the callback: an end request must still be able to write
      // its acknowledgement on the already accepted connection. The successor
      // is restored when the old listener has finished closing.
      try {
        current.close(() => restoreSuccessor());
      } catch {
        restoreSuccessor();
      }
    } else {
      // Do not await the callback: an end request must still be able to write
      // its acknowledgement on the already accepted connection.
      try {
        current.close();
      } catch {
        // already closed
      }
    }
    cleanupSocket();
  };

  const finalClear = async (): Promise<void> => {
    const shift = opts.loop.getShift();
    try {
      await opts.hub.presencePing({
        name: shift.name,
        serve_crews: shift.serveCrews,
	serve_capabilities: opts.loop.getServeCapabilities(),
        ...(opts.shiftId !== undefined ? { shift_id: opts.shiftId } : {}),
        started_at: opts.startedAt,
        // Deliberately omit attended_at. The merged hub contract interprets
        // omission as overwrite-to-NULL; JSON null is rejected by validation.
      });
    } catch (error) {
      opts.err(`final shift presence clear failed: ${errMsg(error)} (continuing shutdown)`);
    }
  };

  const destroyConnections = (): void => {
    for (const socket of connections) {
      if (shutdownSockets.has(socket)) continue;
      forceCloseSocket(socket);
    }
  };

  const armShutdownGrace = (): void => {
    if (shutdownGraceTimer !== undefined || connections.size === 0) return;
    shutdownGraceTimer = setTimeout(() => {
      shutdownGraceTimer = undefined;
      for (const socket of connections) forceCloseSocket(socket);
    }, SHUTDOWN_GRACE_MS);
  };

  const requestShutdown = (reason: 'end' | 'signal' | 'loop', preserve?: Socket): Promise<void> => {
    if (shutdownPromise !== undefined) {
      if (preserve !== undefined) shutdownSockets.add(preserve);
      return shutdownPromise;
    }
    shutdownStarted = true;
    shutdownReason = reason;
    shutdownSockets.clear();
    if (preserve !== undefined) shutdownSockets.add(preserve);
    if (reason === 'end') {
      if (parked !== undefined) shutdownSockets.add(parked.socket);
      // `ended` is synthesized here rather than received from the loop, so it is
      // one of the two events `emit()` in loop.ts never stamps. Stamp it once
      // and hand the SAME record to both consumers, so the socket and the file
      // agree on its `ts` down to the millisecond.
      //
      // Note the narrow meaning, which `docs/shift-logs.md` states for readers
      // of the file: `ended` is written only for `reason === 'end'` — an
      // operator ran `owenloop shift end`. A signal or a loop failure ends the
      // process without one, so a `shift.log` with no trailing `ended` record
      // describes a shift that stopped some other way, or is still running.
      const ended = stamp({ type: 'ended' });
      enqueue(ended);
      try {
        opts.onSynthesized?.(ended);
      } catch (e) {
        opts.err(`shift event sink failed: ${e instanceof Error ? e.message : String(e)} (continuing)`);
      }
    } else if (parked !== undefined) {
      // A signal or unexpected loop exit does not synthesize an `ended` event,
      // but it must not leave a client socket holding the process open forever.
      const current = parked;
      parked = undefined;
      if (current.timer !== undefined) clearTimeout(current.timer);
    }
    // Do not exempt already-responded sockets: socket.end() can still be
    // blocked on a client that stopped reading. New connections are rejected
    // by handleConnection while shutdownStarted is true.
    destroyConnections();
    opts.loop.stop();
    shutdownPromise = (async () => {
      if (loopPromise !== undefined) {
        try {
          await loopPromise;
        } catch (error) {
          opts.err(`shift loop failed during shutdown: ${errMsg(error)}`);
        }
      }
      if (shutdownReason === 'end') await finalClear();
      await closeListening();
      // The end acknowledgement and a parked `ended` response are allowed a
      // bounded flush window; an unread client must not keep the daemon alive.
      armShutdownGrace();
    })();
    return shutdownPromise;
  };

  const handleRequest = async (socket: Socket, value: unknown): Promise<void> => {
    const parsed = validateRequest(value);
    if ('error' in parsed) {
      respond(socket, parsed);
      return;
    }
    if (parsed.op === 'status') {
      respond(socket, status());
      return;
    }
    if (shutdownStarted && parsed.op !== 'end') {
      respond(socket, errorResponse('shift daemon is ending'));
      return;
    }
    if (parsed.op === 'clock_in') {
      // validateRequest completed all validation before this mutation.
      opts.loop.setShift({ name: parsed.name, serveCrews: parsed.serve_crews });
      respond(socket, status());
      return;
    }
    if (parsed.op === 'end') {
      await requestShutdown('end', socket);
      respond(socket, { ok: true, ended: true });
      return;
    }

    // `next` is the only operation that can remain parked.
    if (parked !== undefined) {
      respond(socket, errorResponse(OVERLAP_ERROR));
      return;
    }
    opts.loop.noteAttended(opts.now());
    const current = capacityResponse();
    if (current.events.length > 0 || parsed.wait_ms === 0 || shutdownStarted) {
      respond(socket, current);
      return;
    }
    const timer = setTimeout(() => {
      if (parked?.socket !== socket) return;
      sendParked(capacityResponse());
    }, parsed.wait_ms);
    parked = { socket, timer };
  };

  const handleConnection = (socket: Socket): void => {
    connections.add(socket);
    if (shutdownStarted) {
      connections.delete(socket);
      forceCloseSocket(socket);
      return;
    }
    let buffer = Buffer.alloc(0);
    let replied = false;
    const replyError = (message: string): void => {
      if (replied) return;
      replied = true;
      respond(socket, errorResponse(message));
    };
    socket.setTimeout(REQUEST_IDLE_TIMEOUT_MS, () => {
      if (!replied) replyError('request timed out waiting for a complete line');
    });
    socket.on('data', (chunk: Buffer) => {
      if (replied) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_LINE_BYTES) {
        replyError(`request line exceeds ${MAX_REQUEST_LINE_BYTES} bytes`);
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      replied = true;
      socket.setTimeout(0);
      const raw = buffer.subarray(0, newline).toString('utf8');
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        respond(socket, errorResponse('malformed JSON request'));
        return;
      }
      void handleRequest(socket, value).catch((error) => {
        respond(socket, errorResponse(errMsg(error)));
      });
    });
    socket.on('error', () => {
      // A client disappearing while parked is equivalent to cancellation. Do not
      // leave the single-park slot held forever.
      if (parked?.socket === socket) {
        if (parked.timer !== undefined) clearTimeout(parked.timer);
        parked = undefined;
      }
    });
    socket.on('close', () => {
      connections.delete(socket);
      shutdownSockets.delete(socket);
      if (parked?.socket === socket) {
        if (parked.timer !== undefined) clearTimeout(parked.timer);
        parked = undefined;
      }
      if (connections.size === 0 && shutdownGraceTimer !== undefined) {
        clearTimeout(shutdownGraceTimer);
        shutdownGraceTimer = undefined;
      }
    });
  };

  const openSocket = async (): Promise<void> => {
    mkdirSync(opts.stateDir, { recursive: true });
    const startupLock = await acquireStartupLock(opts.socketPath);
    try {
      try {
        const current = lstatSync(opts.socketPath);
        if (!current.isSocket()) {
          throw new Error(`cannot start shift daemon: ${opts.socketPath} exists and is not a socket`);
        }
        const probedIdentity = fileIdentity(current);
        const probe = await probeSocket(opts.socketPath);
        if (probe === 'active') throw new Error(`cannot start shift daemon: another daemon is active at ${opts.socketPath}`);
        try {
          const beforeUnlink = lstatSync(opts.socketPath);
          if (!sameFileIdentity(probedIdentity, fileIdentity(beforeUnlink))) {
            throw new Error(`cannot start shift daemon: socket changed while checking ${opts.socketPath}`);
          }
          // ACCEPTED LIMITATION: this lstat-then-unlink sequence is not
          // atomic. A same-user hostile local process could substitute the
          // path between the check and unlink, but the 0600 socket is in the
          // user's own state directory, where that process already has direct
          // write access.
          unlinkSync(opts.socketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'ENOENT') throw error;
      }

      const nextServer = createServer(handleConnection);
      server = nextServer;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          nextServer.off('listening', onListening);
          server = undefined;
          try { nextServer.close(); } catch { /* not listening */ }
          reject(error);
        };
        const onListening = (): void => {
          nextServer.off('error', onError);
          resolve();
        };
        nextServer.once('error', onError);
        nextServer.once('listening', onListening);
        nextServer.listen(opts.socketPath);
      });
      try {
        chmodSync(opts.socketPath, 0o600);
        socketIdentity = fileIdentity(lstatSync(opts.socketPath));
        opened = true;
      } catch (error) {
        server = undefined;
        try {
          nextServer.close();
        } catch {
          // best effort
        }
        throw error;
      }
    } finally {
      releaseStartupLock(startupLock);
    }
  };

  const daemon: ShiftDaemon = {
    socketPath: opts.socketPath,
    status,
    onEvent,
    stop: (reason = 'signal') => {
      void requestShutdown(reason);
    },
    run: async () => {
      await openSocket();
      // A stop can arrive while openSocket is awaiting listen(). If shutdown
      // already won that race, close the just-opened listener and do not start
      // a loop after shutdown has completed.
      if (shutdownStarted) {
        await closeListening();
        return 0;
      }
      loopPromise = opts.loop.run();
      // A signal or explicit stop can arrive in the small window between
      // binding the socket and starting the loop. Re-apply the stop after the
      // loop promise exists so an early shutdown cannot leave the loop parked.
      if (shutdownStarted) opts.loop.stop();
      try {
        await loopPromise;
      } finally {
        await requestShutdown('loop');
      }
      return 0;
    },
  };

  return daemon;
}
