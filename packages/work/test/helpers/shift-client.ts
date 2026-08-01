/** Test helpers for the real foreground `owenloop shift start` daemon. */
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';

import { requestShift, type ShiftClientError } from '../../src/shift/client.ts';
import type { ShiftRequest, ShiftResponse } from '../../src/shift/protocol.ts';

const BIN = join(import.meta.dirname, '..', '..', '..', '..', 'bin', 'owenloop.mjs');
const READY_TIMEOUT_MS = 10_000;

export interface ShiftChild {
  child: ChildProcess;
  stateDir: string;
  socketPath: string;
  stderr(): string;
  stdout(): string;
  exited: Promise<number | null>;
  /** Resolve after the daemon has bound its socket and answers status. */
  ready: Promise<void>;
  request(request: ShiftRequest): Promise<ShiftResponse>;
  /** End stdin; shift does not use stdin, so this is only a convenience for tests. */
  endStdin(): void;
}

function optionValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === name) return args[i + 1];
  }
  return undefined;
}

async function waitForReady(socketPath: string, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`shift daemon exited before readiness (code ${String(child.exitCode)}); stderr:\n${stderr()}`);
    }
    if (existsSync(socketPath)) {
      try {
        await requestShift(socketPath, { op: 'status' });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for shift socket ${socketPath}; last error: ${lastError}; stderr:\n${stderr()}`);
}

/** Spawn the real root CLI in foreground daemon mode. Include an explicit --state-dir. */
export function spawnShift(args: string[], env: Record<string, string | undefined>): ShiftChild {
  const stateDir = optionValue(args, '--state-dir');
  if (stateDir === undefined || stateDir.trim() === '') {
    throw new Error('spawnShift requires an explicit --state-dir');
  }
  const socketPath = join(stateDir, 'shift.sock');
  const child = spawn(process.execPath, [BIN, 'shift', 'start', ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const stderrText = (): string => stderr;
  const ready = waitForReady(socketPath, child, stderrText);
  return {
    child,
    stateDir,
    socketPath,
    stderr: stderrText,
    stdout: () => stdout,
    exited,
    ready,
    request: (request) => requestShift(socketPath, request),
    endStdin: () => child.stdin!.end(),
  };
}

/** Open a raw socket and send one request, exposing the socket for cancellation tests. */
export function rawShiftRequest(socketPath: string, request: ShiftRequest): {
  socket: Socket;
  response: Promise<ShiftResponse>;
} {
  const socket = createConnection(socketPath);
  const response = new Promise<ShiftResponse>((resolve, reject) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      try {
        resolve(JSON.parse(line) as ShiftResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
  });
  return { socket, response };
}

export function isAbsent(error: unknown): boolean {
  return (error as ShiftClientError | undefined)?.absent === true;
}
