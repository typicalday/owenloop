/**
 * Shift daemon: owns one Unix socket, one self-driven ProxyLoop, a bounded
 * local event FIFO, and at most one parked `next` client.
 *
 * The loop remains the only owner of hub cursor, presence cadence, capacity,
 * dispatch, and child reconciliation. This wrapper only translates local socket
 * requests and loop observations into the Phase 2 JSON-lines protocol.
 */
import { chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { createServer, createConnection, type Server, type Socket } from 'node:net';

import type { HubClient } from '../hub/client.ts';
import type { ProxyLoop } from '../proxy/loop.ts';
import {
  MAX_EVENT_QUEUE,
  MAX_REQUEST_LINE_BYTES,
  OVERLAP_ERROR,
  type ShiftCapacity,
  type ShiftError,
  type ShiftEvent,
  type ShiftRequest,
  type ShiftResponse,
  type ShiftStatus,
} from './protocol.ts';

export interface ShiftDaemonOptions {
  socketPath: string;
  stateDir: string;
  loop: ProxyLoop;
  hub: HubClient;
  now: () => number;
  startedAt: number;
  conductorId?: string;
  err: (line: string) => void;
}

export interface ShiftDaemon {
  run(): Promise<number>;
  /** Stop the daemon. `end` performs the final attendance-clearing ping. */
  stop(reason?: 'end' | 'signal' | 'loop'): void;
  status(): ShiftStatus;
  /** Callback passed into createProxyLoop for local dispatch observations. */
  onEvent(event: ShiftEvent): void;
  socketPath: string;
}

interface ParkedNext {
  socket: Socket;
  timer: NodeJS.Timeout | undefined;
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

function writeResponse(socket: Socket, response: ShiftResponse): void {
  if (socket.destroyed) return;
  try {
    socket.end(`${JSON.stringify(response)}\n`);
  } catch {
    socket.destroy();
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
    const pools = obj['serve_pools'];
    if (typeof name !== 'string' || name.trim() === '' || name.trim().length > 200) {
      return errorResponse('clock_in name must be a non-empty string of at most 200 characters');
    }
    if (!Array.isArray(pools) || !pools.every((pool) => typeof pool === 'string' && pool.trim() !== '')) {
      return errorResponse('clock_in serve_pools must be an array of non-empty crew names');
    }
    return {
      op: 'clock_in',
      name: name.trim(),
      serve_pools: pools.map((pool) => (pool as string).trim()),
    };
  }
  return errorResponse(typeof op === 'string' ? `unknown operation '${op}'` : 'request requires an operation');
}

export function createShiftDaemon(opts: ShiftDaemonOptions): ShiftDaemon {
  let server: Server | undefined;
  let socketInode: number | bigint | undefined;
  let opened = false;
  let shutdownStarted = false;
  let shutdownReason: 'end' | 'signal' | 'loop' | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let loopPromise: Promise<number> | undefined;
  let parked: ParkedNext | undefined;
  const events: ShiftEvent[] = [];

  const capacity = (): Omit<ShiftCapacity, 'events'> => {
    const cap = opts.loop.getCap();
    const free = opts.loop.freeCapacity();
    return { cap, free, running: cap - free };
  };

  const status = (): ShiftStatus => {
    const shift = opts.loop.getShift();
    return {
      name: shift.name,
      serve_pools: shift.servePools,
      ...capacity(),
      attended_at: opts.loop.getAttendedAt() ?? null,
      started_at: opts.startedAt,
    };
  };

  const sendParked = (response: ShiftCapacity): void => {
    const current = parked;
    if (current === undefined) return;
    parked = undefined;
    if (current.timer !== undefined) clearTimeout(current.timer);
    writeResponse(current.socket, response);
  };

  const drainEvents = (): ShiftEvent[] => {
    const drained = events.splice(0, events.length);
    return drained;
  };

  const capacityResponse = (): ShiftCapacity => ({ ...capacity(), events: drainEvents() });

  const enqueue = (event: ShiftEvent): void => {
    if (events.length >= MAX_EVENT_QUEUE) {
      events.shift();
      opts.err(`shift event queue overflow — dropping oldest event`);
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
      if (socketInode !== undefined && current.ino !== socketInode) return;
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
      if (socketInode !== undefined && currentPath.isSocket() && currentPath.ino !== socketInode) {
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
        serve_pools: shift.servePools,
        ...(opts.conductorId !== undefined ? { conductor_id: opts.conductorId } : {}),
        started_at: opts.startedAt,
        // Deliberately omit attended_at. The merged hub contract interprets
        // omission as overwrite-to-NULL; JSON null is rejected by validation.
      });
    } catch (error) {
      opts.err(`final shift presence clear failed: ${errMsg(error)} (continuing shutdown)`);
    }
  };

  const requestShutdown = (reason: 'end' | 'signal' | 'loop'): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    shutdownStarted = true;
    shutdownReason = reason;
    if (reason === 'end') {
      enqueue({ type: 'ended' });
    } else if (parked !== undefined) {
      // A signal or unexpected loop exit does not synthesize an `ended` event,
      // but it must not leave a client socket holding the process open forever.
      const current = parked;
      parked = undefined;
      if (current.timer !== undefined) clearTimeout(current.timer);
      current.socket.destroy();
    }
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
    })();
    return shutdownPromise;
  };

  const handleRequest = async (socket: Socket, value: unknown): Promise<void> => {
    const parsed = validateRequest(value);
    if ('error' in parsed) {
      writeResponse(socket, parsed);
      return;
    }
    if (parsed.op === 'status') {
      writeResponse(socket, status());
      return;
    }
    if (shutdownStarted && parsed.op !== 'end') {
      writeResponse(socket, errorResponse('shift daemon is ending'));
      return;
    }
    if (parsed.op === 'clock_in') {
      // validateRequest completed all validation before this mutation.
      opts.loop.setShift({ name: parsed.name, servePools: parsed.serve_pools });
      writeResponse(socket, status());
      return;
    }
    if (parsed.op === 'end') {
      await requestShutdown('end');
      writeResponse(socket, { ok: true, ended: true });
      return;
    }

    // `next` is the only operation that can remain parked.
    if (parked !== undefined) {
      writeResponse(socket, errorResponse(OVERLAP_ERROR));
      return;
    }
    opts.loop.noteAttended(opts.now());
    const current = capacityResponse();
    if (current.events.length > 0 || parsed.wait_ms === 0 || shutdownStarted) {
      writeResponse(socket, current);
      return;
    }
    const timer = setTimeout(() => {
      if (parked?.socket !== socket) return;
      sendParked(capacityResponse());
    }, parsed.wait_ms);
    parked = { socket, timer };
  };

  const handleConnection = (socket: Socket): void => {
    let buffer = Buffer.alloc(0);
    let replied = false;
    const replyError = (message: string): void => {
      if (replied) return;
      replied = true;
      writeResponse(socket, errorResponse(message));
    };
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
      const raw = buffer.subarray(0, newline).toString('utf8');
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        writeResponse(socket, errorResponse('malformed JSON request'));
        return;
      }
      void handleRequest(socket, value).catch((error) => {
        writeResponse(socket, errorResponse(errMsg(error)));
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
      if (parked?.socket === socket) {
        if (parked.timer !== undefined) clearTimeout(parked.timer);
        parked = undefined;
      }
    });
  };

  const openSocket = async (): Promise<void> => {
    mkdirSync(opts.stateDir, { recursive: true });
    try {
      const current = lstatSync(opts.socketPath);
      if (!current.isSocket()) {
        throw new Error(`cannot start shift daemon: ${opts.socketPath} exists and is not a socket`);
      }
      const probe = await probeSocket(opts.socketPath);
      if (probe === 'active') throw new Error(`cannot start shift daemon: another daemon is active at ${opts.socketPath}`);
      unlinkSync(opts.socketPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') throw error;
    }

    const nextServer = createServer(handleConnection);
    server = nextServer;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        nextServer.off('listening', onListening);
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
      socketInode = lstatSync(opts.socketPath).ino;
      opened = true;
    } catch (error) {
      try {
        nextServer.close();
      } catch {
        // best effort
      }
      throw error;
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
