/**
 * The command payload channel. A command returns its payload through exactly
 * one of two transports, and this module parses whichever it used.
 *
 * STDOUT MARKER. The command prints `PAYLOAD_MARKER` followed by JSON on one
 * line. The runner captures the bounded raw text after the marker; this module
 * parses it. Bounded at `PAYLOAD_MAX_BYTES` because the scanner holds the line
 * in memory while it reads it, and an unbounded line is an unbounded buffer.
 *
 * PAYLOAD FILE. The command writes the same JSON to the path in
 * `OWENLOOP_PAYLOAD_FILE`, which exec always sets. Bounded at
 * `PAYLOAD_FILE_MAX_BYTES` instead, because the bytes are already on disk and
 * the only cost of reading them is the read itself.
 *
 * WHY THE FILE EXISTS AT ALL. The two caps are not cosmetic. A command step
 * whose result exceeds 64 KiB used to have no way to return it: the stdout line
 * was dropped, and the step produced nothing. The hub, meanwhile, has offloaded
 * artifacts above 64 KiB to R2 since long before this channel existed
 * (`hub-core/src/artifacts.ts`), accepting up to 25 MB. So the transport, not
 * the storage, was the ceiling, and only for command steps — an agent step
 * submits over HTTP and never met it.
 *
 * BOTH AT ONCE IS A REFUSAL, NOT A PRECEDENCE RULE. A command that prints a
 * marker line AND writes the file has stated its result twice, and nothing in
 * either transport says which statement it meant. Picking one silently would
 * publish a value the author did not choose. `resolvePayload` refuses and names
 * the conflict instead.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** The exact line prefix a command must print on stdout to emit a payload. */
export const PAYLOAD_MARKER = '##owenloop:payload##';

/** Maximum UTF-8 byte length of the JSON text after the marker. */
export const PAYLOAD_MAX_BYTES = 64 * 1024;

/**
 * Maximum byte length of `OWENLOOP_PAYLOAD_FILE`.
 *
 * A COARSE PRE-FILTER, NOT THE AUTHORITATIVE LIMIT. The hub's ceiling is 25 MB
 * (`MAX_ARTIFACT_BYTES` in `hub-core/src/artifacts.ts`), but it is measured on
 * the whole serialized artifact value, which for a command step is the entire
 * `CommandReceipt` — the payload plus the command, up to 4 KiB of `outputTail`,
 * an output hash and seven id fields. A payload at exactly 25 MB therefore
 * serializes to strictly more than 25 MB and is refused hub-side with certainty.
 * This value reserves ~1 MB of envelope headroom so that a payload the worker
 * accepts is not one the hub is guaranteed to reject.
 *
 * It cannot be more than a pre-filter, because the hub's effective cap is
 * `min(tier.artifactMaxBytes, MAX_ARTIFACT_BYTES)` and the lowest tier is 5 MB
 * (`shared/src/tiers.ts`). The worker does not know the org's tier, so the hub
 * stays authoritative and may refuse well below this. What the worker buys by
 * checking at all is the cheap, specific half of the refusal: it can name the
 * file and its exact size before spending an HTTP round trip to be told a
 * serialized value was too large.
 */
export const PAYLOAD_FILE_MAX_BYTES = 24_000_000;

/** The environment variable naming the payload file. Always set on a command spawn. */
export const PAYLOAD_FILE_ENV = 'OWENLOOP_PAYLOAD_FILE';

export interface RejectDirective {
  path: string;
  text: string;
}

export interface ParsedPayload {
  /** Present when the source contained valid JSON, including `null`/primitives. */
  payload?: unknown;
  /** Present when the source or its reject directive could not be used. */
  payloadError?: string;
  /** Present only for a strictly valid reject directive. */
  reject?: RejectDirective;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse payload JSON that is already known to be non-empty and within its
 * source's cap. Shared by both transports so a reject directive means the same
 * thing however it arrived.
 */
function parsePayloadJson(jsonText: string): ParsedPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { payloadError: `payload JSON is malformed: ${message}` };
  }

  if (!isRecord(payload) || !('reject' in payload)) return { payload };

  const rawReject = payload['reject'];
  if (!isRecord(rawReject)) {
    return { payload, payloadError: 'payload reject directive must be an object' };
  }
  const path = rawReject['path'];
  const text = rawReject['text'];
  if (!hasNonEmptyString(path) || !hasNonEmptyString(text)) {
    return { payload, payloadError: 'payload reject directive requires non-empty string path and text' };
  }

  return { payload, reject: { path, text } };
}

/**
 * Parse the raw text after `PAYLOAD_MARKER`.
 *
 * `overCap` comes from the runner's bounded scanner. It is separate from the
 * string because the scanner must not retain more than the cap just to report
 * that a later byte made the line too large.
 */
export function parsePayloadLine(payloadLine?: string, overCap = false): ParsedPayload {
  if (overCap) return { payloadError: `payload JSON exceeds the ${PAYLOAD_MAX_BYTES / 1024} KiB cap` };
  if (payloadLine === undefined) return {};

  const jsonText = payloadLine.trim();
  if (jsonText === '') return { payloadError: 'payload marker has no JSON text' };
  if (Buffer.byteLength(jsonText, 'utf8') > PAYLOAD_MAX_BYTES) {
    return { payloadError: `payload JSON exceeds the ${PAYLOAD_MAX_BYTES / 1024} KiB cap` };
  }

  return parsePayloadJson(jsonText);
}

/** What the payload file held, as three mutually exclusive outcomes. */
export interface PayloadFileRead {
  /** The file's trimmed text. Absent when the command did not use this channel. */
  text?: string;
  /** Why the file could not be used. Absent when there was nothing wrong with it. */
  error?: string;
  /**
   * The file's size in bytes, whenever it was measured — including on the
   * over-cap refusal, where the size is the whole point. Absent when the file
   * could not be opened or stat'ed at all. Reported so a conflict can name it
   * after the temp directory is gone.
   */
  bytes?: number;
}

/**
 * Read `OWENLOOP_PAYLOAD_FILE` back after the command exits.
 *
 * ABSENT AND EMPTY BOTH MEAN "THIS CHANNEL WAS NOT USED", and the difference
 * from the marker line is deliberate. Printing the marker is an affirmative act
 * with nothing after it, so an empty marker line is an error. The file already
 * has a path the worker chose and handed over, and `> "$OWENLOOP_PAYLOAD_FILE"`
 * is what a shell does to a path it is about to maybe write — truncating it
 * says nothing about intent. Treating that as an error would make the natural
 * shell idiom fail for commands that then return through stdout.
 *
 * ANYTHING OTHER THAN A REGULAR FILE AT THAT PATH IS AN ERROR, not an absence:
 * exec created an empty private directory and named a file inside it, so a
 * directory, a symlink or a FIFO there is the command having done something
 * unintended.
 *
 * THE WHOLE READ GOES THROUGH ONE DESCRIPTOR, opened once and checked from its
 * own `fstat`. Opening and then re-resolving the path — `statSync` followed by
 * `readFileSync` — leaves a window in which the file the checks passed and the
 * file the bytes came from are not the same file. The child that wrote this path
 * is not necessarily gone: a command may background a grandchild that redirects
 * its own descriptors, and the shell exits while it keeps running.
 */
export function readPayloadFile(path: string | undefined): PayloadFileRead {
  if (path === undefined) return {};

  let fd: number;
  try {
    // O_NONBLOCK and O_NOFOLLOW are both load-bearing.
    //
    // O_NONBLOCK: a FIFO at this path makes a blocking open wait for a writer
    // that may never arrive. That wait is synchronous and on the worker's only
    // thread, so it stops heartbeats, holds the lease and cannot time out —
    // an operator kill is the only recovery. Opening non-blocking returns a
    // descriptor immediately, and the `isFile` check below then refuses it.
    // On a regular file the flag has no effect at all.
    //
    // O_NOFOLLOW: `stat` follows symlinks, so a regular-file check alone would
    // publish whatever the link pointed at. Same user, so this is not a
    // privilege boundary — but the guard says "a regular file exec named", and
    // following a link silently makes that false.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // ENOENT is the ordinary case — the command returned through stdout, or
    // returned nothing. Any other open failure is reported rather than silently
    // read as an absence, because "we could not look" is not "there was
    // nothing there".
    if (code === 'ENOENT') return {};
    if (code === 'ELOOP' || code === 'EMLINK') {
      return { error: `${PAYLOAD_FILE_ENV} is a symbolic link, not a regular file` };
    }
    return { error: `cannot read ${PAYLOAD_FILE_ENV}: ${errorMessage(error)}` };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { error: `${PAYLOAD_FILE_ENV} is not a regular file` };
    }

    // Checked from the descriptor's own stat rather than after reading, so an
    // oversized file is refused without pulling it into memory first.
    const size = stat.size;
    if (size > PAYLOAD_FILE_MAX_BYTES) {
      return {
        bytes: size,
        error:
          `${PAYLOAD_FILE_ENV} is ${size} bytes, over the ${PAYLOAD_FILE_MAX_BYTES} byte cap ` +
          '— a payload this large must be written as an artifact, not returned through the payload channel',
      };
    }

    // Bounded by the size just measured on THIS descriptor, so a file that keeps
    // growing cannot be read past the cap however large it becomes. A file that
    // shrank yields a short read, and a truncated JSON document is reported as
    // malformed — the honest outcome for a file that changed while it was read.
    const buffer = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const chunk = readSync(fd, buffer, filled, size - filled, null);
      if (chunk === 0) break;
      filled += chunk;
    }

    const text = buffer.subarray(0, filled).toString('utf8').trim();
    if (text === '') return { bytes: filled };
    return { bytes: filled, text };
  } catch (error) {
    return { error: `cannot read ${PAYLOAD_FILE_ENV}: ${errorMessage(error)}` };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A descriptor that will not close changes nothing about what was read,
      // and throwing here would replace a good result with an unrelated error.
    }
  }
}

/** The two transports as the caller observed them, before either is trusted. */
export interface PayloadSources {
  /** Raw text after the stdout marker, from the runner's bounded scanner. */
  payloadLine?: string;
  /** The scanner saw a marker line that exceeded its cap. */
  payloadOverCap?: boolean;
  /** The result of reading `OWENLOOP_PAYLOAD_FILE`. */
  file?: PayloadFileRead;
}

/**
 * Describe a both-transports conflict in enough detail to act on it from the
 * receipt alone.
 *
 * The sizes are the point. By the time anyone reads this the private temp
 * directory has been removed, so the file cannot be inspected; and the marker
 * line is frequently printed by a nested helper the author did not write, while
 * the receipt keeps only the last 4 KiB of stdout. Naming both byte counts is
 * usually enough to identify which half of a script did what.
 *
 * A file that could not be read is still a use of the file transport, so it
 * stays a conflict rather than falling back to the marker. Its error rides along
 * instead of being discarded: it is the more specific and more actionable of the
 * two facts, and a caller told only "you used both" would never learn that the
 * file was, say, over the cap.
 */
function describeConflict(sources: PayloadSources, file: PayloadFileRead): string {
  const marker =
    sources.payloadOverCap === true
      ? `over the ${PAYLOAD_MAX_BYTES} byte cap`
      : `${Buffer.byteLength(sources.payloadLine ?? '', 'utf8')} bytes`;
  const fileSize = file.bytes === undefined ? 'unreadable' : `${file.bytes} bytes`;
  const detail = file.error === undefined ? '' : ` The file itself was also unusable: ${file.error}`;
  return (
    `a payload arrived through both the stdout ${PAYLOAD_MARKER} line (${marker}) and ` +
    `${PAYLOAD_FILE_ENV} (${fileSize}) — a command must return its payload through exactly one of them, ` +
    `because nothing here says which one it meant.${detail}`
  );
}

/**
 * Resolve the one payload a command returned, across both transports.
 *
 * The conflict case is a refusal by design; see this module's header. Note that
 * an over-cap marker line still counts as "the command used stdout" — it stated
 * a result there, and the fact that the statement was too long to read does not
 * turn it into a command that only used the file.
 */
export function resolvePayload(sources: PayloadSources): ParsedPayload {
  const file = sources.file ?? {};
  const usedMarker = sources.payloadLine !== undefined || sources.payloadOverCap === true;
  const usedFile = file.text !== undefined || file.error !== undefined;

  if (usedMarker && usedFile) return { payloadError: describeConflict(sources, file) };

  if (file.error !== undefined) return { payloadError: file.error };
  if (file.text !== undefined) return parsePayloadJson(file.text);

  return parsePayloadLine(sources.payloadLine, sources.payloadOverCap ?? false);
}
