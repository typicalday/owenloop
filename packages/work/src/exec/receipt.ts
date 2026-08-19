/**
 * The command receipt (C5, plan decision 8) — the artifact value exec submits
 * only for a successful ordinary command and for a judge that exits 0. Because
 * the hub `submit` verb has no failure channel, a failed ordinary command puts
 * this same receipt in `hub.ask`'s diagnostic context and submits nothing. A
 * non-zero judge exit uses `reject` instead, and signal-killed work submits
 * neither. Pure construction so it is trivially asserted in tests.
 */
import { parsePayloadLine, type ParsedPayload } from './payload.ts';
import type { CommandResult } from './runner.ts';

/** A command's artifact value on success, or failure diagnostics in `hub.ask` context. */
export interface CommandReceipt {
  kind: 'command-receipt';
  command: string;
  exitCode: number | null;
  signal?: string;
  error?: string;
  outputHash: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputTail: string;
  payload?: unknown;
  payloadError?: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** The holder id of the exec process that ran it (`<hostname>:<pid>`). */
  orchestrator: string;
  workflow: string;
  run: string;
  step: string;
}

export interface ReceiptContext {
  command: string;
  orchestrator: string;
  workflow: string;
  run: string;
  step: string;
}

/** Fold a raw `CommandResult` and its order context into the submitted receipt. */
export function buildReceipt(
  result: CommandResult,
  ctx: ReceiptContext,
  parsedPayload: ParsedPayload = parsePayloadLine(result.payloadLine, result.payloadOverCap),
): CommandReceipt {
  return {
    kind: 'command-receipt',
    command: ctx.command,
    exitCode: result.exitCode,
    ...(result.signal !== undefined ? { signal: result.signal } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    outputHash: result.outputHash,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    outputTail: result.outputTail,
    ...('payload' in parsedPayload ? { payload: parsedPayload.payload } : {}),
    ...(parsedPayload.payloadError !== undefined ? { payloadError: parsedPayload.payloadError } : {}),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    orchestrator: ctx.orchestrator,
    workflow: ctx.workflow,
    run: ctx.run,
    step: ctx.step,
  };
}
