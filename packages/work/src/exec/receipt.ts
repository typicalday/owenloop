/**
 * The command receipt (C5, plan decision 8) — the audit record exec submits for
 * a command order. It IS the result contract: the hub `submit` verb has no
 * failure channel, so a receipt is submitted for EVERY finished command — a
 * non-zero `exitCode` (or `exitCode: null` + `error` for machinery failure)
 * carries the truth, and exec still exits 0 because its job (deliver the
 * receipt) succeeded. Pure construction so it is trivially asserted in tests.
 */
import type { CommandResult } from './runner.ts';

/** The submitted artifact value for a command order. */
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
export function buildReceipt(result: CommandResult, ctx: ReceiptContext): CommandReceipt {
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
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    orchestrator: ctx.orchestrator,
    workflow: ctx.workflow,
    run: ctx.run,
    step: ctx.step,
  };
}
