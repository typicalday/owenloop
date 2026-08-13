/**
 * Producer-side mirror of the hub's raw-string submit normalization.
 *
 * WHY THIS EXISTS — the proof-dropping bug it fixes:
 *
 * An agent may hand `submit` a JSON-encoded STRING instead of an object
 * (`'{"prUrl":"…","number":145}'`). The hub accepts that as a documented
 * fallback: `hub-core`'s `submitOutput` runs `normalizeSubmitValue` on it and
 * stores the resulting OBJECT. But because the stored bytes are no longer the
 * bytes the producer signed, the hub cannot claim the signature covers what it
 * stored, so it drops the submission proof outright:
 *
 *   const narrowedProof = typeof rawValue === 'string' ? undefined
 *                                                      : narrowSubmitProof(proof);
 *
 * The drop is silent on both sides. The producer signed successfully and got no
 * warning; the hub committed the artifact with no proof. A downstream COMMAND
 * step consuming that artifact then refuses it forever (`hardRule: true`), and
 * nothing in either log says why. Observed live: the delivery `pr` artifact
 * committed unproven while `workspace` — produced by an `exec` step, which
 * always submits an object receipt — carried its proof fine.
 *
 * THE FIX: normalize here, before signing and before sending, so the producer
 * signs exactly the object the hub will store and the hub never takes its
 * string branch. This function is a deliberate byte-for-byte mirror of
 * `owenloop-service` `packages/hub-core/src/normalize-submit-value.ts`; the two
 * must agree, because any divergence produces a signature over bytes the hub
 * did not store, which the consumer then rejects.
 *
 * A string this function cannot normalize is passed through UNCHANGED to the
 * hub, which rejects it with `artifact-normalization-failed` exactly as it does
 * today. Refusing locally would invent a failure mode the protocol does not
 * have and would hide the hub's own diagnostic text from the agent.
 */

const FENCE_RE = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;

/**
 * The value to sign and send for `raw`.
 *
 * Non-string input is returned as-is: only the string fallback triggers the
 * hub's normalization, so only a string can desynchronize signed bytes from
 * stored bytes.
 *
 * A string is repaired the way the hub repairs it — strip a surrounding
 * ```json fence, escape bare control characters inside string literals, parse —
 * and the parsed plain object is returned. Anything that fails to parse, or
 * parses to a non-object (a bare number, an array, `null`), is returned as the
 * original string so the hub renders its own verdict on it.
 */
export function normalizeSubmitValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;

  const fenceMatch = FENCE_RE.exec(raw);
  const stripped = fenceMatch ? fenceMatch[1]! : raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    try {
      parsed = JSON.parse(escapeBareControlCharsInStrings(stripped));
    } catch {
      return raw;
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return raw;
  return parsed;
}

/**
 * Escape bare newlines/carriage-returns/tabs that appear INSIDE JSON string
 * literals — the "worker emitted a multi-line string value" failure mode. A
 * single pass tracking whether we are inside a string literal (respecting `\"`
 * escapes) is enough; structural whitespace between tokens is left alone
 * because `JSON.parse` already tolerates it raw.
 */
function escapeBareControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}
