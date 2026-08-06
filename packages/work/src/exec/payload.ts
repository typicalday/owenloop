/**
 * The command payload channel. The runner only captures the bounded raw text
 * after the marker; this module parses that text and validates the one
 * worker-to-hub directive supported by exec.
 */

/** The exact line prefix a command must print on stdout to emit a payload. */
export const PAYLOAD_MARKER = '##owenloop:payload##';

/** Maximum UTF-8 byte length of the JSON text after the marker. */
export const PAYLOAD_MAX_BYTES = 64 * 1024;

export interface RejectDirective {
  path: string;
  text: string;
}

export interface ParsedPayload {
  /** Present when the marker contained valid JSON, including `null`/primitives. */
  payload?: unknown;
  /** Present when the marker or its reject directive could not be used. */
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
