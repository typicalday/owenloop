/**
 * Thin client for the local shift daemon's one-request-per-connection socket.
 */
import { createConnection } from 'node:net';
import { join } from 'node:path';

import {
  DEFAULT_NEXT_WAIT_MS,
  MAX_REQUEST_LINE_BYTES,
  NO_DAEMON_SUFFIX,
  SHIFT_SOCKET_NAME,
  type ShiftRequest,
  type ShiftResponse,
} from './protocol.ts';

export interface ShiftClientErrorOptions {
  absent?: boolean;
  code?: string;
}

export class ShiftClientError extends Error {
  readonly absent: boolean;
  readonly code: string | undefined;

  constructor(message: string, opts: ShiftClientErrorOptions = {}) {
    super(message);
    this.name = 'ShiftClientError';
    this.absent = opts.absent ?? false;
    this.code = opts.code;
  }
}

export function shiftSocketPath(stateDir: string): string {
  return join(stateDir, SHIFT_SOCKET_NAME);
}

export function noDaemonMessage(socketPath: string): string {
  return `no shift daemon at ${socketPath}${NO_DAEMON_SUFFIX}`;
}

/** Send one request and parse the daemon's one-line response. */
export function requestShift(socketPath: string, request: ShiftRequest): Promise<ShiftResponse> {
  return new Promise<ShiftResponse>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let buffer = Buffer.alloc(0);

    const fail = (error: ShiftClientError): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    socket.once('connect', () => {
      const line = Buffer.from(`${JSON.stringify(request)}\n`, 'utf8');
      if (line.length > MAX_REQUEST_LINE_BYTES) {
        fail(new ShiftClientError('request is too large', { code: 'EMSGSIZE' }));
        return;
      }
      socket.write(line);
    });

    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_LINE_BYTES * 2) {
        fail(new ShiftClientError('daemon response is too large', { code: 'EMSGSIZE' }));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      const raw = buffer.subarray(0, newline).toString('utf8');
      settled = true;
      socket.destroy();
      try {
        resolve(JSON.parse(raw) as ShiftResponse);
      } catch {
        reject(new ShiftClientError('daemon returned malformed JSON'));
      }
    });

    socket.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code;
      const absent = code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK' || code === 'EPIPE';
      fail(new ShiftClientError(absent ? noDaemonMessage(socketPath) : error.message, { absent, code }));
    });

    socket.once('close', () => {
      if (!settled) fail(new ShiftClientError('shift daemon closed the connection before replying'));
    });
  });
}

export interface ParsedNextArgs {
  waitMs: number;
  stateDir?: string;
  error?: string;
}

export function parseNextArgs(args: string[]): ParsedNextArgs {
  let waitMs = DEFAULT_NEXT_WAIT_MS;
  let stateDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    const name = raw.startsWith('--') && raw.includes('=') ? raw.slice(0, raw.indexOf('=')) : raw;
    const readValue = (): string | undefined => {
      const eq = raw.indexOf('=');
      if (eq !== -1) return raw.slice(eq + 1);
      i++;
      return args[i];
    };
    if (name === '--wait') {
      const value = readValue();
      if (value === undefined || value.trim() === '') return { waitMs, error: 'missing value for --wait' };
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0) return { waitMs, error: `--wait must be a finite non-negative number of seconds, got '${value}'` };
      waitMs = seconds * 1000;
    } else if (name === '--state-dir') {
      const value = readValue();
      if (value === undefined || value.trim() === '') return { waitMs, error: 'missing value for --state-dir' };
      stateDir = value;
    } else {
      return { waitMs, error: `unknown option '${raw}'` };
    }
  }
  return { waitMs, ...(stateDir !== undefined ? { stateDir } : {}) };
}

export function parseStateDirArgs(args: string[]): { stateDir?: string; error?: string } {
  let stateDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    const name = raw.startsWith('--') && raw.includes('=') ? raw.slice(0, raw.indexOf('=')) : raw;
    if (name !== '--state-dir') return { error: `unknown option '${raw}'` };
    const eq = raw.indexOf('=');
    const value = eq !== -1 ? raw.slice(eq + 1) : args[++i];
    if (value === undefined || value.trim() === '') return { error: 'missing value for --state-dir' };
    stateDir = value;
  }
  return { ...(stateDir !== undefined ? { stateDir } : {}) };
}
