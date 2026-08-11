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
 * bag (Phase 3's worker today, Phase 5's normalized prepare later). Do not
 * "fix" this by passing the step plus a bagKey argument: same leak, one
 * indirection later.
 *
 * Failure stance: TOTAL. It never throws, never mutates its input, and has no
 * I/O. A malformed bag normalizes to `{ extensions: {} }`. Validation is not
 * this function's job — normalization runs at dispatch time where throwing would
 * kill a live order. Two other layers do the validating, and BOTH report rather
 * than degrade: the def parser (`parseHarnessCarrier` in `src/bundle/fetch.ts`)
 * throws on a carrier it cannot read at all — including a def still carrying the
 * legacy pre-`x.harness` bag key (`LEGACY_BAG_KEY`, same file) — and `owenloop
 * lint` errors on a bad FIELD inside a well-formed bag.
 *
 * Field rules are carried over from the legacy compile layer's `KNOWN_FIELDS` /
 * `RESERVED_KEYS` / `isStringOrStringArray`; the live copies now sit in this
 * directory's per-harness adapter module (grep them there — `src/adapters/` was
 * deleted in Phase 5, and do not trust a line number). Eight of the eighteen are
 * harness-neutral and get lifted; two are reserved and are stripped; the other
 * eight have no neutral meaning and land in `extensions`, along with every key
 * the bag carries that the known list does not mention.
 */
import type { PermissionIssue, StepPermissions } from './contract.ts';
import type { LintFinding } from './types.ts';

/** Fields with a harness-neutral meaning — lifted out of the bag. */
const NEUTRAL_KEYS = [
  'tools',
  'disallowedTools',
  'filesystem',
  'network',
  'permissionMode',
  'maxTurns',
  'model',
  'effort',
] as const;

const FILESYSTEM_VALUES = new Set(['read-only', 'workspace-write', 'unrestricted']);
const NETWORK_VALUES = new Set(['owenloop-only', 'unrestricted']);
const STALE_RESTRICTION_KEYS = ['filesystem', 'network'] as const;

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
 * `[]` when the field was explicitly present but names no tools. This preserves
 * the security-relevant distinction between an absent allow-list and `tools: []`.
 */
function toolList(v: unknown): string[] | undefined {
  if (typeof v === 'string') {
    return v.split(',').map((s) => s.trim()).filter((s) => s !== '');
  }
  if (Array.isArray(v)) {
    return v.filter((e): e is string => typeof e === 'string' && e !== '');
  }
  return undefined;
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
 * lifted (the eight neutral fields) nor reserved (`name`/`description`) lands
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

  if (typeof src['filesystem'] === 'string' && FILESYSTEM_VALUES.has(src['filesystem'])) {
    out.filesystem = src['filesystem'] as StepPermissions['filesystem'];
  }
  if (typeof src['network'] === 'string' && NETWORK_VALUES.has(src['network'])) {
    out.network = src['network'] as StepPermissions['network'];
  }

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

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function isStringOrStringArray(v: unknown): boolean {
  return typeof v === 'string' || (Array.isArray(v) && v.every((entry) => typeof entry === 'string'));
}

/**
 * Validate the reserved, harness-neutral `x.harness` fields before normalization.
 * Unknown keys remain opaque and produce no finding here.
 */
export function validateHarnessOptions(bag: Record<string, unknown>, step: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const error = (field: string, message: string): void => {
    findings.push({ severity: 'error', step, field, message });
  };
  const check = (field: string, ok: (value: unknown) => boolean, expected: string): void => {
    if (field in bag && !ok(bag[field])) {
      error(field, `${field} must be ${expected}, got ${typeName(bag[field])}`);
    }
  };

  check('tools', isStringOrStringArray, 'a string or string[]');
  check('disallowedTools', isStringOrStringArray, 'a string or string[]');
  check('permissionMode', (v) => typeof v === 'string' && v !== '', 'a non-empty string');
  check('model', (v) => typeof v === 'string' && v !== '', 'a non-empty string');
  check('effort', (v) => typeof v === 'string' && v !== '', 'a non-empty string');
  check('maxTurns', (v) => typeof v === 'number' && Number.isInteger(v) && v > 0, 'a positive integer');

  for (const key of RESERVED_KEYS) {
    if (key in bag) error(key, `'${key}' is generated and cannot be set in the bag`);
  }

  if ('filesystem' in bag && !FILESYSTEM_VALUES.has(bag['filesystem'] as string)) {
    error('filesystem', `filesystem must be one of ${[...FILESYSTEM_VALUES].join('|')}`);
  }
  if ('network' in bag && !NETWORK_VALUES.has(bag['network'] as string)) {
    error('network', `network must be one of ${[...NETWORK_VALUES].join('|')}`);
  }

  if (isStringOrStringArray(bag['tools']) && isStringOrStringArray(bag['disallowedTools'])) {
    const allowed = new Set(toolList(bag['tools']) ?? []);
    const denied = new Set(toolList(bag['disallowedTools']) ?? []);
    const overlap = [...allowed].filter((tool) => denied.has(tool)).sort();
    if (overlap.length > 0) {
      error('tools', `tools and disallowedTools overlap: ${overlap.join(', ')}`);
    }
  }

  return findings;
}

/**
 * Validate a normalized permission object at the final dispatch boundary.
 * The stale-extension check catches caches produced before filesystem/network
 * became first-class restrictions; running such a cache would silently ignore
 * the authored restriction.
 */
export function preflightStepPermissions(permissions: StepPermissions): PermissionIssue[] {
  const issues: PermissionIssue[] = [];
  const overlap = (permissions.tools ?? [])
    .filter((tool) => (permissions.disallowedTools ?? []).includes(tool))
    .sort();
  if (overlap.length > 0) {
    issues.push({ field: 'tools', message: `tools and disallowedTools overlap: ${overlap.join(', ')}` });
  }
  for (const key of STALE_RESTRICTION_KEYS) {
    if (key in permissions.extensions) {
      issues.push({
	field: key,
	message:
	  `restriction '${key}' is buried in permissions.extensions from an old cache and would be ignored; ` +
	  'rerun `owenloop work prepare`',
      });
    }
  }
  return issues;
}
