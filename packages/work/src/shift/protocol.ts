/**
 * Local JSON-lines protocol for the foreground shift daemon.
 *
 * The protocol is deliberately small: one request per Unix-socket connection,
 * one response line, then the connection closes. The hub remains the owner of
 * workflow state; this protocol only carries local dispatch observations and
 * attendance commands between the CLI and one daemon process.
 */

export const SHIFT_SOCKET_NAME = 'shift.sock';
export const DEFAULT_NEXT_WAIT_MS = 90_000;
export const MAX_REQUEST_LINE_BYTES = 64 * 1024;
/**
 * The server measures each response's serialized UTF-8 byte length against this
 * ceiling and retains FIFO events that do not fit. A single event whose fields
 * exceed the ceiling is rendered with an explicit truncation marker.
 */
export const MAX_RESPONSE_LINE_BYTES = 512 * 1024;
export const RESPONSE_TRUNCATION_MARKER = '[truncated]';
export const MAX_EVENT_QUEUE = 1_000;
export const OVERLAP_ERROR = 'whats_next is already parked — one park at a time (cancel it or wait for it to return)';
export const NO_DAEMON_SUFFIX = ' — start one with: owenloop shift start <crew…>';

export type ShiftRequest =
  | { op: 'next'; wait_ms: number }
  | { op: 'status' }
  | { op: 'clock_in'; serve_crews: string[]; name: string }
  | { op: 'end' };

export interface DispatchedEvent {
  type: 'dispatched';
  workflow: string;
  run: string;
  step: string;
  kind: 'exec' | 'agent-run';
  pid: number;
}

export interface ReapedEvent {
  type: 'reaped';
  workflow: string;
  run: string;
  kind: 'exec' | 'agent-run';
  pid: number;
}

export interface FailedEvent {
  type: 'failed';
  workflow: string;
  run: string;
  step: string;
  kind: 'exec' | 'agent-run';
  harness?: string;
  executable?: string;
  exitStatus?: number | null;
  signal?: NodeJS.Signals | null;
  message: string;
}

/** Reserved for a future local representation of a pending hub gate. */
export interface GateEvent {
  type: 'gate';
  workflow?: string;
  run?: string;
  name?: string;
  question?: string;
}

export interface EndedEvent {
  type: 'ended';
}

export type ShiftEvent = DispatchedEvent | ReapedEvent | FailedEvent | GateEvent | EndedEvent;

export interface ShiftCapacity {
  cap: number;
  free: number;
  running: number;
  events: ShiftEvent[];
}

export interface ShiftStatus {
  name: string;
  serve_crews: string[];
  cap: number;
  free: number;
  running: number;
  attended_at: number | null;
  started_at: number;
}

export interface ShiftError {
  error: string;
}

export type ShiftResponse = ShiftCapacity | ShiftStatus | ShiftError | { ok: true; ended: true };

export function isShiftError(value: unknown): value is ShiftError {
  return typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string';
}
