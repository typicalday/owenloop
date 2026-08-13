/**
 * The shift's structured on-disk log — `<log-dir>/shift.log`, JSON Lines.
 *
 * This is the SECOND consumer of the `ShiftEvent` contract (the Unix socket is
 * the first), and it is deliberately not a new logging abstraction: it receives
 * the same stamped records `emit()` fans to the socket, serializes each as one
 * line, and appends. A future hub uploader becomes the THIRD consumer of those
 * same records by tailing this file — not by rewriting this code.
 *
 * ── WHY `appendFileSync`, NOT `createWriteStream` ──
 *
 * Shift events are low volume — a handful per dispatch, reap, failure, or gate
 * — so throughput is not the constraint. Crash durability is. A stream's
 * buffered lines are lost when the process dies abruptly, which is exactly the
 * crash the log exists to explain. `appendFileSync` holds NO descriptor between
 * writes: every line is on disk before `write()` returns, and there is nothing
 * to flush or close at shutdown. That is why this module exposes no `close()` —
 * there is no open resource to release, and a no-op `close()` would only invite
 * a caller to believe ordering or durability depended on calling it.
 *
 * ── WHY ONE SYSCALL PER LINE ──
 *
 * Each record is serialized to a complete `…\n` string and written with a
 * SINGLE `appendFileSync` call. Two shifts sharing a log directory both open
 * with `O_APPEND`, so single-call writes cannot interleave into a half-line;
 * lines stay individually parseable and the `shiftId` on each record says which
 * process wrote it.
 *
 * ── WHY A WRITE FAILURE IS NOT AN ERROR THE CALLER SEES ──
 *
 * `write()` never throws. A shift that cannot log must still dispatch work: a
 * full disk is not a reason to stop delivering. The failure is reported ONCE
 * through `err` — the report is latched, not the writing — so a broken sink
 * cannot spam one line per event, while a transient failure (a disk that frees
 * up, a directory an operator recreates) starts logging again on its own.
 */
import { appendFileSync } from 'node:fs';

import { MAX_RESPONSE_LINE_BYTES, type ShiftEvent } from './protocol.ts';
import { truncateEventToBytes } from './truncate.ts';

export interface ShiftLogSinkOptions {
  /** Absolute path of the JSON Lines file to append to. */
  path: string;
  /** Where the one-time failure report goes. Never the sink itself. */
  err: (line: string) => void;
  /** Injected for tests; defaults to `node:fs` `appendFileSync`. */
  append?: (path: string, line: string) => void;
}

export interface ShiftLogSink {
  /** Append one event as a single JSON Lines record. Never throws. */
  write(event: ShiftEvent): void;
}

/** Serialized bytes of one JSON Lines record, newline included. */
function lineBytes(event: ShiftEvent): number {
  return Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8');
}

export function createShiftLogSink(opts: ShiftLogSinkOptions): ShiftLogSink {
  const append = opts.append ?? ((path: string, line: string) => {
    appendFileSync(path, line);
  });
  let reported = false;

  return {
    write(event: ShiftEvent): void {
      let line: string;
      try {
        // Bound the line by the SAME ceiling the socket applies, so the file
        // never carries a record the wire protocol would have refused and an
        // uploader can size its reads from one documented number.
        const bounded = truncateEventToBytes(event, MAX_RESPONSE_LINE_BYTES, lineBytes);
        line = `${JSON.stringify(bounded)}\n`;
      } catch (e) {
        // Serialization itself failed (a cyclic or unserializable field). There
        // is no line to write, and no partial write happened.
        if (!reported) {
          reported = true;
          opts.err(`shift log sink could not serialize an event: ${errMsg(e)} (logging continues)`);
        }
        return;
      }
      try {
        append(opts.path, line);
      } catch (e) {
        if (!reported) {
          reported = true;
          opts.err(`shift log sink write to ${opts.path} failed: ${errMsg(e)} (continuing without it)`);
        }
      }
    },
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
