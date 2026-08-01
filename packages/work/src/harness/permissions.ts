/**
 * `normalizeStepPermissions` — the PURE translation from a step def's
 * harness-specific `x.<bagKey>` bag into the harness-neutral `StepPermissions`
 * that every adapter reads.
 *
 * The type itself lives in `./contract.ts` (both adapters read it as part of the
 * contract surface); only the normalizing function lives here, so the
 * dependency runs one way and there is no cycle.
 *
 * SHAPE DECISION — this takes the ALREADY-EXTRACTED bag, not the step. If it
 * took the step it would have to know which bag key to reach for, and that key
 * IS a harness vendor name — putting a vendor name in a non-adapter file and
 * breaking the isolation rule this phase establishes. The CALLER extracts the
 * bag (Phase 3's runner today, Phase 5's normalized prepare later). Do not
 * "fix" this by passing the step plus a bagKey argument: same leak, one
 * indirection later.
 *
 * Failure stance: TOTAL. It never throws, never mutates its input, and has no
 * I/O. A malformed bag normalizes to `{ extensions: {} }`. Validation is not
 * this function's job — normalization runs at dispatch time where throwing would
 * kill a live order. Two other layers do the validating, and BOTH report rather
 * than degrade: the def parser (`parseHarnessCarrier` in `src/bundle/fetch.ts`)
 * throws on a carrier it cannot read at all — including a def still carrying the
 * legacy pre-`x.harness` bag key (`LEGACY_BAG_KEY`, same file) — and `owenwork
 * lint` errors on a bad FIELD inside a well-formed bag.
 *
 * Field rules are carried over from the legacy compile layer's `KNOWN_FIELDS` /
 * `RESERVED_KEYS` / `isStringOrStringArray`; the live copies now sit in this
 * directory's per-harness adapter module (grep them there — `src/adapters/` was
 * deleted in Phase 5, and do not trust a line number). Six of the sixteen are
 * harness-neutral and get lifted; two are reserved and are stripped; the other
 * eight have no neutral meaning and land in `extensions`, along with every key
 * the bag carries that the known list does not mention.
 */
import type { StepPermissions } from './contract.ts';

/** The six fields with a harness-neutral meaning — lifted out of the bag. */
const NEUTRAL_KEYS = ['tools', 'disallowedTools', 'permissionMode', 'maxTurns', 'model', 'effort'] as const;

/** Generated/reserved frontmatter keys. Stripped: an adapter must never see an
 *  author's attempt at them. They do NOT reach `extensions`. */
const RESERVED_KEYS = ['name', 'description'] as const;

/** Keys that never appear in `extensions`, valid or not. */
const LIFTED_OR_STRIPPED = new Set<string>([...NEUTRAL_KEYS, ...RESERVED_KEYS]);

function isPlainMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Normalize a tool list. The bag legitimately accepts EITHER a comma-separated
 * string or a string array. A string is split on `,` with each entry trimmed and
 * empties dropped; an array is copied with non-string entries dropped. Returns
 * `undefined` when nothing survives, so the key is ABSENT rather than `[]` —
 * "no `tools` key" and "an empty allow-list" mean different things to a harness.
 */
function toolList(v: unknown): string[] | undefined {
  let out: string[];
  if (typeof v === 'string') {
    out = v.split(',').map((s) => s.trim()).filter((s) => s !== '');
  } else if (Array.isArray(v)) {
    out = v.filter((e): e is string => typeof e === 'string' && e !== '');
  } else {
    return undefined;
  }
  return out.length > 0 ? out : undefined;
}

/** A non-empty string, verbatim and unvalidated; otherwise `undefined`. */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** A positive integer, otherwise `undefined`. Anything else is dropped rather
 *  than corrected — lint already errors on it, and normalization must not throw. */
function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * Translate one step's bag into `StepPermissions`.
 *
 * `bag` is the already-extracted `x.<bagKey>` object; `undefined`, `null`, an
 * array, or any non-object all normalize to `{ extensions: {} }` (plus the
 * step's model, when it has one).
 *
 * MODEL PRECEDENCE: the step's FIRST-CLASS `model` field wins over a bag-level
 * `model`, carried over verbatim from the legacy frontmatter builder's
 * `if (step.model !== undefined) fm['model'] = step.model`. That is today's live
 * behavior and its meaning must not change — getting it backwards would silently
 * alter which model live steps run under once Phase 5 routes prepare through
 * this function. Note the precedence is decided on PRESENCE (a defined step
 * model shadows the bag), and only then is the winner dropped if it is not a
 * non-empty string.
 *
 * `extensions` is lossless by construction: every bag key that is neither
 * lifted (the six neutral fields) nor reserved (`name`/`description`) lands
 * there verbatim, including keys the known-field list has never heard of. Lint
 * stays the place that warns about unknown keys.
 *
 * The input is never mutated; nested values are shared by reference (verbatim
 * pass-through is the point).
 */
export function normalizeStepPermissions(
  bag: Record<string, unknown> | undefined,
  step?: { model?: string },
): StepPermissions {
  const src = isPlainMap(bag) ? bag : {};

  const extensions: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (LIFTED_OR_STRIPPED.has(k)) continue;
    extensions[k] = v;
  }

  const out: StepPermissions = { extensions };

  const tools = toolList(src['tools']);
  if (tools !== undefined) out.tools = tools;

  const disallowedTools = toolList(src['disallowedTools']);
  if (disallowedTools !== undefined) out.disallowedTools = disallowedTools;

  const permissionMode = nonEmptyString(src['permissionMode']);
  if (permissionMode !== undefined) out.permissionMode = permissionMode;

  const maxTurns = positiveInt(src['maxTurns']);
  if (maxTurns !== undefined) out.maxTurns = maxTurns;

  const rawModel = step?.model !== undefined ? step.model : src['model'];
  const model = nonEmptyString(rawModel);
  if (model !== undefined) out.model = model;

  const effort = nonEmptyString(src['effort']);
  if (effort !== undefined) out.effort = effort;

  return out;
}
