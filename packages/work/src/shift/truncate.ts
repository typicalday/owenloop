/**
 * Byte-bounding one `ShiftEvent`, shared by the two consumers that must bound it.
 *
 * There is exactly ONE line-size rule, and both consumers apply it:
 *  - the socket daemon (`server.ts`) measures a whole response envelope, and
 *  - the on-disk JSON Lines sink (`logsink.ts`) measures one serialized line,
 *
 * so the ceiling in the file matches the ceiling on the wire and a future
 * uploader tailing the file never faces a line the socket would have refused.
 * The two differ only in HOW bytes are counted, which is why `measure` is a
 * parameter rather than a second copy of the algorithm.
 *
 * THE ENVELOPE IS NEVER TRUNCATED AWAY. `type`, `ts`, and `shiftId` are exempt:
 * they are the fields that make a record self-describing, they are bounded by
 * construction (a literal, an ISO-8601 timestamp, `shf_<uuid>`), and blanking
 * them would leave a reader with a marked husk it cannot place in time or
 * attribute to a process. `shift` — the operator-chosen name — is NOT exempt;
 * it is unbounded input and is shortened like any other string field, and only
 * when it is the largest one left.
 */
import { RESPONSE_TRUNCATION_MARKER, type ShiftEvent } from './protocol.ts';

/** Fields whose value must survive truncation intact. See the module comment. */
const PROTECTED_KEYS: ReadonlySet<string> = new Set(['type', 'ts', 'shiftId']);

/** Shorten `value` to at most `maxBytes` UTF-8 bytes, marker included. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(RESPONSE_TRUNCATION_MARKER, 'utf8');
  if (maxBytes <= markerBytes) return RESPONSE_TRUNCATION_MARKER;
  let prefix = Buffer.from(value, 'utf8').subarray(0, maxBytes - markerBytes).toString('utf8');
  while (Buffer.byteLength(prefix, 'utf8') > maxBytes - markerBytes) prefix = prefix.slice(0, -1);
  return `${prefix}${RESPONSE_TRUNCATION_MARKER}`;
}

/**
 * Render one event within `maxBytes`, as `measure` counts them.
 *
 * A single event can be larger than the ceiling. It is delivered once with its
 * string fields progressively halved — largest first — and an explicit
 * `RESPONSE_TRUNCATION_MARKER`, rather than blocking every later event forever.
 *
 * `measure` receives the CANDIDATE event and returns the byte length the caller
 * cares about: the socket adds its response envelope, the file sink adds the
 * trailing newline.
 */
export function truncateEventToBytes(
  event: ShiftEvent,
  maxBytes: number,
  measure: (candidate: ShiftEvent) => number,
): ShiftEvent {
  const candidate = { ...event } as Record<string, unknown>;
  const stringKeys = Object.keys(candidate).filter(
    (key) => typeof candidate[key] === 'string' && !PROTECTED_KEYS.has(key),
  );
  const markerBytes = Buffer.byteLength(RESPONSE_TRUNCATION_MARKER, 'utf8');

  while (measure(candidate as unknown as ShiftEvent) > maxBytes) {
    const key = stringKeys
      .filter((name) => candidate[name] !== RESPONSE_TRUNCATION_MARKER)
      .sort(
        (left, right) =>
          Buffer.byteLength(String(candidate[right]), 'utf8') -
          Buffer.byteLength(String(candidate[left]), 'utf8'),
      )[0];
    if (key === undefined) break;
    const value = String(candidate[key]);
    const currentBytes = Buffer.byteLength(value, 'utf8');
    const targetBytes = Math.max(markerBytes, Math.floor(currentBytes / 2));
    const shortened = truncateUtf8(value, targetBytes);
    candidate[key] = shortened === value ? RESPONSE_TRUNCATION_MARKER : shortened;
  }

  // Final backstop if a future event shape needs more reduction than the
  // progressive shortening above provided. Non-string fields (and the protected
  // envelope) are left alone, so a pathological case can still exceed the
  // ceiling rather than lose the identity that makes the record readable.
  if (measure(candidate as unknown as ShiftEvent) > maxBytes) {
    for (const key of stringKeys) candidate[key] = RESPONSE_TRUNCATION_MARKER;
  }
  return candidate as unknown as ShiftEvent;
}
