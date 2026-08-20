/**
 * Workflow definition loading & validation.
 *
 * A workflow is authored as a single self-contained YAML file. The engine is
 * domain-neutral, so a definition is *just wiring*: declared inputs, plus a set
 * of steps connected by the artifacts they `consumes` / `produces`. This module
 * turns that YAML into a validated `WorkflowDef` — parsing the path patterns
 * (paths.ts), filling defaults, and rejecting mis-wired graphs (dangling
 * consumes, two writers for one artifact, map/reduce mismatches, dependency
 * cycles) *before* an instance is ever created.
 *
 *   name: delivery
 *   inputs:
 *     - name: proposal
 *   steps:
 *     - name: planner
 *       consumes: [proposal]
 *       produces: [plan]
 *       body: |
 *         Draft a plan for ${WORKFLOW}.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseConsume, parseProduce, parseWorkdirFrom } from './paths.ts';
import { parseDurationMs, parseDurationSecs } from './util.ts';
import { assertValidSchema } from './schema.ts';
// The separator lives with composition/matching (capabilities.ts); the parser
// only enforces that an AUTHORED name never contains it.
import { MODIFIER_SEPARATOR } from './capabilities.ts';
import type { Acceptance, ConsumePattern, EffectDef, EscalationDef, FiringTrigger, GroupDef, InputDef, InvariantDef, InvariantPredicate, JsonSchema, OnCancelDef, StepDef, ProducePattern, WorkflowDef } from './types.ts';

// ---- raw (pre-validation) YAML shapes ---------------------------------------

interface RawInput {
  name?: unknown;
  producer?: unknown;
  seedOwed?: unknown;
  schema?: unknown;
}
/** Hand-maintained key allowlist for RawInput — kept next to the interface so
 *  the two can't silently drift (§27 unknown-key rejection). */
const RAW_INPUT_KEYS = ['name', 'producer', 'seedOwed', 'schema'] as const;

/** A produce entry: either a bare `"plan"` string, or
 *  `{ name, schema, judges, maxAttempts, maxSchemaFailures }`. */
interface RawProduce {
  name?: unknown;
  schema?: unknown;
  /** §24 judges: optional quality-gate list hanging off a singleton produce entry. */
  judges?: unknown;
  /** §6/§18 per-produce override of the step's maxAttempts. */
  maxAttempts?: unknown;
  /** §6/§18 per-produce override of the step's maxSchemaFailures. */
  maxSchemaFailures?: unknown;
  bind?: unknown;
}
const RAW_PRODUCE_KEYS = ['name', 'schema', 'judges', 'maxAttempts', 'maxSchemaFailures', 'bind'] as const;

/** §26: a `group:` entry in a `produces:` list — spans multiple sibling stems, not a produce itself. */
interface RawGroup {
  group?: unknown;
  mode?: unknown;
  of?: unknown;
}
/** Hand-maintained key allowlist for RawGroup — a `group:` entry is a
 *  DIFFERENT (smaller) shape than RawProduce, not a produce with extra
 *  fields, so it gets its own allowlist rather than folding into
 *  RAW_PRODUCE_KEYS (§27 unknown-key rejection). */
const RAW_GROUP_KEYS = ['group', 'mode', 'of'] as const;

/** A single raw `judges:` list entry on a produce. */
interface RawJudge {
  name?: unknown;
  body?: unknown;
  bodyFile?: unknown;
  model?: unknown;
  inputs?: unknown;
  cadence?: unknown;
  maxRunsPerDay?: unknown;
  executor?: unknown;
  command?: unknown;
  spec?: unknown;
  capabilities?: unknown;
}
const RAW_JUDGE_KEYS = ['name', 'body', 'bodyFile', 'model', 'inputs', 'cadence', 'maxRunsPerDay', 'executor', 'command', 'spec', 'capabilities'] as const;

interface RawStep {
  name?: unknown;
  consumes?: unknown;
  produces?: unknown;
  generates?: unknown;
  invalidates?: unknown;
  cadence?: unknown;
  maxRunsPerDay?: unknown;
  parallel?: unknown;
  maxAttempts?: unknown;
  maxSchemaFailures?: unknown;
  model?: unknown;
  workdir?: unknown;
  workdirFrom?: unknown;
  terminal?: unknown;
  effect?: unknown;
  on?: unknown;
  idleAfter?: unknown;
  body?: unknown;
  bodyFile?: unknown;
  /** M2-GRAMMAR: if present, this entry is a calls: step (Mode 2 runtime composition). */
  calls?: unknown;
  reapTtl?: unknown;
  /** A2: opaque routing capabilities for peer-orchestrator claim filtering. */
  capabilities?: unknown;
  /** A3: per-step max total lease lifetime (duration string). */
  maxLease?: unknown;
  /** §27.3: opaque extension map — validated as a map, never interpreted. */
  x?: unknown;
  /** Declares which kind of executor this step's order is for. Opaque
   *  passthrough, mirrors `model`. */
  executor?: unknown;
  /** Required when executor is 'command'; opaque command string. */
  command?: unknown;
  /** Optional opaque config object for a non-agent/non-command executor type. */
  spec?: unknown;
  /** Per-step escalation rule: `{ after: <n>, modifier: <declared value> }`. */
  escalation?: unknown;
  /** Cleanup-on-cancel declaration: `{ consumes: [<stem>...] }`. */
  onCancel?: unknown;
}
/** Keys valid on a normal (non-calls:, non-include:) step entry. */
const RAW_STEP_KEYS = [
  'name', 'consumes', 'produces', 'generates', 'invalidates', 'cadence',
  'maxRunsPerDay', 'parallel', 'maxAttempts', 'maxSchemaFailures', 'model',
  'workdir', 'workdirFrom', 'terminal', 'effect', 'on', 'idleAfter', 'body', 'bodyFile',
  'calls', 'reapTtl', 'capabilities', 'maxLease', 'x', 'executor', 'command', 'spec',
  'escalation', 'onCancel',
] as const;

/** Duck-typed sniffer for a raw calls: directive (Mode 2). */
interface RawCalls {
  name?: unknown;
  calls?: unknown;
  inputs?: unknown;
  produces?: unknown;
}
/** Keys valid on a calls: step entry — a DIFFERENT (smaller) shape than RawStep;
 *  the `calls:` key is what routes an entry here instead of RAW_STEP_KEYS. */
const RAW_CALLS_KEYS = ['name', 'calls', 'inputs', 'produces'] as const;

/** Duck-typed sniffer for a raw include directive. */
interface RawInclude {
  include?: unknown;
  as?: unknown;
  inputs?: unknown;
}
/** Keys valid on an include: directive entry — the `include:` key is the
 *  discriminator that routes an entry here instead of RAW_STEP_KEYS/RAW_CALLS_KEYS. */
const RAW_INCLUDE_KEYS = ['include', 'as', 'inputs'] as const;

interface RawDef {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputs?: unknown;
  steps?: unknown;
  outputs?: unknown;
  invariants?: unknown;
  engine?: unknown;
  /** §27.3: opaque extension map — validated as a map, never interpreted. */
  x?: unknown;
  /** Optional def-level allow-list of executor values (typo guard for step/judge `executor:`). */
  executors?: unknown;
  /** Optional declared modifier vocabulary (unordered set of plain names). */
  modifiers?: unknown;
}
const RAW_DEF_KEYS = ['name', 'title', 'description', 'inputs', 'steps', 'outputs', 'invariants', 'engine', 'x', 'executors', 'modifiers'] as const;

// ---- defaults ----------------------------------------------------------------

const DEFAULTS = {
  cadence: '0s',
  maxRunsPerDay: 1000,
  parallel: 1,
  maxAttempts: 3,
  maxSchemaFailures: 5,
} as const;

/**
 * The engine-version contract (§27). A workflow definition may declare
 * `engine: <n>`; it must be a positive integer no greater than this constant
 * or buildDef throws a DefError — catching an author running a definition
 * written against a newer engine generation than the one running, before any
 * instance is created, rather than failing confusingly mid-run. The check is
 * forward-compatible (`>`, not `!==`): a def declaring an older supported
 * version keeps loading unchanged even after this constant is bumped.
 * Omitting `engine:` defaults to this same value (fully backward compatible:
 * no existing definition needs to add it).
 */
export const SUPPORTED_ENGINE_VERSION = 1;

// ---- small coercion helpers --------------------------------------------------

function asString(v: unknown, ctx: string): string {
  if (typeof v !== 'string') throw new DefError(`${ctx} must be a string`);
  return v;
}
function asStringArray(v: unknown, ctx: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new DefError(`${ctx} must be a list of strings`);
  }
  return v as string[];
}
/**
 * A routing capability as an author may write it: no separator, no surrounding
 * whitespace, non-empty.
 *
 * Deliberately NOT a full charset rule. Capability names are opaque routing
 * labels shared with a hub whose own validation is length + non-empty + no
 * `personal:` prefix; imposing a charset here would reject names that already
 * bind successfully today. The one new restriction is the reserved separator.
 */
function assertAuthoredCapability(value: string, ctx: string): void {
  if (value.trim().length === 0) {
    throw new DefError(`${ctx}: capability names must not be empty or whitespace`);
  }
  if (value.includes(MODIFIER_SEPARATOR)) {
    throw new DefError(
      `${ctx}: capability '${value}' must not contain '${MODIFIER_SEPARATOR}' — ` +
      'the suffix position is reserved for the modifier the engine composes at offer time ' +
      "(a run carrying 'deep' turns the authored capability 'wise' into 'wise:deep')",
    );
  }
}

/**
 * Parse the def-level `modifiers:` block into a validated, order-insensitive
 * set of plain names.
 *
 * Order is NOT preserved as meaning: the list is a vocabulary, and nothing in
 * the engine compares two modifiers or treats one as higher than another. The
 * array shape is only YAML's way of writing a set. The vocabulary is fixed
 * here; every downstream gate checks membership in it and nothing else.
 */
function parseModifiers(v: unknown, ctx: string): string[] {
  const values = asStringArray(v, ctx);
  if (values.length === 0) {
    throw new DefError(`${ctx} must list at least one modifier, or be omitted entirely`);
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (value.trim().length === 0) {
      throw new DefError(`${ctx}: modifier names must not be empty or whitespace`);
    }
    if (/\s/.test(value)) {
      throw new DefError(
	`${ctx}: modifier '${value}' must not contain whitespace — ` +
	'a modifier is composed onto every authored capability as ' +
	`'<capability>${MODIFIER_SEPARATOR}<modifier>' and travels as a routing key`,
      );
    }
    if (value.includes(MODIFIER_SEPARATOR)) {
      throw new DefError(
        `${ctx}: modifier '${value}' must not contain '${MODIFIER_SEPARATOR}' — ` +
        'it is the separator the engine composes with',
      );
    }
    if (seen.has(value)) throw new DefError(`${ctx}: duplicate modifier '${value}'`);
    seen.add(value);
  }
  return values;
}

/** Parse a step's `escalation:` block. Cross-checks against the def's declared
 *  modifier set and the step's effective maxAttempts happen in `validateDef`,
 *  which is the first place that sees the whole def. */
function parseEscalation(v: unknown, ctx: string): EscalationDef {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new DefError(`${ctx} must be a mapping of { after, modifier }`);
  }
  const raw = v as Record<string, unknown>;
  assertNoUnknownKeys(raw, ['after', 'modifier'] as const, ctx);
  if (raw['after'] === undefined) throw new DefError(`${ctx} must set 'after'`);
  if (raw['modifier'] === undefined) throw new DefError(`${ctx} must set 'modifier'`);
  const after = asNumber(raw['after'], 0, `${ctx}.after`);
  if (!Number.isInteger(after) || after < 1) {
    throw new DefError(`${ctx}.after must be a positive integer (rejection count that triggers the escalated re-offer)`);
  }
  const modifier = asString(raw['modifier'], `${ctx}.modifier`);
  if (modifier.trim().length === 0) throw new DefError(`${ctx}.modifier must not be empty`);
  return { after, modifier };
}

/** Parse a step's `onCancel:` block. Stem-membership cross-checks live in
 *  validateDef because they need the step's parsed consumes. */
function parseOnCancel(v: unknown, ctx: string): OnCancelDef {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new DefError(`${ctx} must be a mapping of { consumes }`);
  }
  const raw = v as Record<string, unknown>;
  assertNoUnknownKeys(raw, ['consumes'] as const, ctx);
  if (raw['consumes'] === undefined) {
    throw new DefError(`${ctx} must set 'consumes' (the subset of the step's consumes the cancel-path firing requires; use [] for none)`);
  }
  return { consumes: asStringArray(raw['consumes'], `${ctx}.consumes`) };
}

function asNumber(v: unknown, fallback: number, ctx: string): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DefError(`${ctx} must be a number`);
  return v;
}
function asBool(v: unknown, fallback: boolean, ctx: string): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new DefError(`${ctx} must be a boolean`);
  return v;
}
/** Coerce + validate a JSON Schema, re-raising schema.ts errors as DefErrors. */
function asSchema(v: unknown, ctx: string): JsonSchema {
  try {
    assertValidSchema(v, ctx);
  } catch (e) {
    throw new DefError((e as Error).message);
  }
  return v as JsonSchema;
}
/**
 * Coerce + validate a raw `engine:` value (§27): must be a positive integer
 * no greater than SUPPORTED_ENGINE_VERSION. Defaults to SUPPORTED_ENGINE_VERSION
 * when omitted, so every WorkflowDef in memory carries a definite, checked
 * `engine` number — never `undefined` — regardless of whether the author
 * wrote `engine:` at all. Using a `>` (not `!==`) comparison against the max
 * keeps this forward-compatible: once SUPPORTED_ENGINE_VERSION is bumped past
 * 1, older defs that still declare `engine: 1` (or omit it) must keep loading
 * exactly as before — only defs requesting a version the running binary
 * doesn't yet support should be rejected.
 */
function asEngineVersion(v: unknown, name: string): number {
  if (v === undefined) return SUPPORTED_ENGINE_VERSION;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new DefError(`workflow '${name}': engine must be a positive integer`);
  }
  if (v > SUPPORTED_ENGINE_VERSION) {
    throw new DefError(
      `workflow '${name}' requires engine version ${v} but this owenloop only supports up to ${SUPPORTED_ENGINE_VERSION} — upgrade owenloop`,
    );
  }
  return v;
}

/**
 * Coerce a raw `x:` value (§27.3): must be a plain map (a YAML mapping), else
 * a load-time DefError. The CONTENTS are deliberately not validated — `x:` is
 * the sanctioned opaque extension point for external runners/tooling; the
 * engine only guarantees its shape and carries it through untouched.
 */
function asExtension(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new DefError(`${ctx} must be a map (a YAML mapping of extension fields)`);
  }
  return v as Record<string, unknown>;
}

/**
 * Reject any key on `obj` that isn't in `allowed` (§27). A typo'd or
 * forward-looking field (e.g. `bodyfile:`, `maxAttepts:`) previously parsed
 * silently and was dropped on the floor — this turns that into a DefError
 * naming the exact offending key(s) and where they were found, instead of a
 * confusing "why isn't my field doing anything" debugging session.
 *
 * Call immediately after a duck-type cast (`as RawX`) and before any field
 * reads, so the check runs against the same raw object every other coercion
 * helper reads from.
 */
function assertNoUnknownKeys(obj: object, allowed: readonly string[], ctx: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(obj).filter((k) => !allowedSet.has(k));
  if (unknown.length > 0) {
    throw new DefError(`${ctx}: unknown key${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `'${k}'`).join(', ')}`);
  }
}

/**
 * Read a step/judge `bodyFile`, enforcing that it resolves to a regular file
 * contained within `baseDir` (the def file's own directory). Closes SEC-1: an
 * unchecked `join()` + `readFileSync()` let a remote definition with enough
 * `../` components read arbitrary local files during `owenloop add`, and that
 * content then flowed into emitted orders.
 *
 * `ctx` is the caller's error prefix (e.g. `step 'planner'` / `judge 'rigor'`);
 * every failure throws `DefError`. A missing target keeps the historical
 * "could not be read (resolved to '...')" message shape so anything matching
 * /could not be read/ stays green.
 *
 * The containment root is `baseDir` itself. For an installed package `baseDir`
 * is always at or below `<defsDir>/<owner>-<repo>/`, so this is strictly
 * stronger than package-root containment and needs no extra plumbing.
 */
function readBodyFileContained(baseDir: string, rel: string, ctx: string): string {
  if (rel === '' || rel.includes('\0')) {
    throw new DefError(
      `${ctx}: bodyFile '${rel}' must be a relative path with no '.' or '..' components`,
    );
  }
  // Reject absolute paths: POSIX/Windows leading separators and drive prefixes.
  if (isAbsolute(rel) || /^[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new DefError(`${ctx}: bodyFile '${rel}' must be a relative path, not absolute`);
  }
  // Reject any '.' or '..' segment (split on both separators — catches
  // doubled separators and backslash tricks). The proposal asks to reject '.'
  // too, not just '..'.
  const segments = rel.split(/[\\/]+/);
  if (segments.some((s) => s === '.' || s === '..')) {
    throw new DefError(
      `${ctx}: bodyFile '${rel}' must be a relative path with no '.' or '..' components`,
    );
  }
  const resolvedPath = join(baseDir, rel);
  let realBase: string;
  let realTarget: string;
  try {
    // Compare realpath-to-realpath so a symlinked temp dir (macOS /var ->
    // /private/var) doesn't spuriously fail containment, and so a symlink
    // INSIDE the package pointing outside resolves — and is caught — below.
    realBase = realpathSync(baseDir);
    realTarget = realpathSync(resolvedPath);
  } catch (e) {
    throw new DefError(
      `${ctx}: bodyFile '${rel}' could not be read (resolved to '${resolvedPath}'): ${(e as Error).message}`,
    );
  }
  // The `+ sep` is load-bearing: without it '/pkg-evil' would pass containment
  // for base '/pkg'. A regular-file target can never equal realBase itself.
  if (!realTarget.startsWith(realBase + sep)) {
    throw new DefError(`${ctx}: bodyFile '${rel}' resolves outside the workflow's directory`);
  }
  if (!statSync(realTarget).isFile()) {
    throw new DefError(`${ctx}: bodyFile '${rel}' does not resolve to a regular file`);
  }
  return readFileSync(realTarget, 'utf8');
}

/**
 * Parse a `judges:` list hanging off a produce entry (§24 YAML surface). Each
 * entry's `bodyFile` (if present) is resolved against `baseDir` and read
 * eagerly, exactly like a step's `bodyFile` (#38) — by the time the judge is
 * synthesized it carries a plain resolved `body`.
 */
function parseJudges(v: unknown, ctx: string, baseDir?: string): NonNullable<ProducePattern['judges']> {
  if (!Array.isArray(v)) throw new DefError(`${ctx} must be a list`);
  const seen = new Set<string>();
  return v.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new DefError(`${ctx}[${i}] must be a { name, body|bodyFile, ... } mapping`);
    }
    const raw = entry as RawJudge;
    assertNoUnknownKeys(raw, RAW_JUDGE_KEYS, `${ctx}[${i}]`);
    const name = asString(raw.name, `${ctx}[${i}].name`);
    if (seen.has(name)) throw new DefError(`${ctx}: duplicate judge name '${name}'`);
    seen.add(name);
    const hasBody = raw.body !== undefined;
    const hasBodyFile = raw.bodyFile !== undefined;
    if (hasBody && hasBodyFile) {
      throw new DefError(`judge '${name}': set either body or bodyFile, not both`);
    }
    if (!hasBody && !hasBodyFile) {
      throw new DefError(`judge '${name}': must set either body or bodyFile`);
    }
    let body: string;
    if (hasBodyFile) {
      const bodyFileRel = asString(raw.bodyFile, `judge '${name}'.bodyFile`);
      if (baseDir === undefined) {
        throw new DefError(
          `judge '${name}': bodyFile requires a workflow loaded from disk (no base directory to resolve '${bodyFileRel}' against)`,
        );
      }
      body = readBodyFileContained(baseDir, bodyFileRel, `judge '${name}'`);
    } else {
      body = asString(raw.body, `judge '${name}'.body`);
    }
    const judge: NonNullable<ProducePattern['judges']>[number] = { name, body };
    if (raw.model !== undefined) judge.model = asString(raw.model, `judge '${name}'.model`);
    if (raw.inputs !== undefined) judge.inputs = asBool(raw.inputs, false, `judge '${name}'.inputs`);
    if (raw.cadence !== undefined) judge.cadence = asString(raw.cadence, `judge '${name}'.cadence`);
    if (raw.maxRunsPerDay !== undefined) {
      judge.maxRunsPerDay = asNumber(raw.maxRunsPerDay, DEFAULTS.maxRunsPerDay, `judge '${name}'.maxRunsPerDay`);
    }
    if (raw.executor !== undefined) judge.executor = asString(raw.executor, `judge '${name}'.executor`);
    if (raw.command !== undefined) judge.command = asString(raw.command, `judge '${name}'.command`);
    if (raw.spec !== undefined) judge.spec = asExtension(raw.spec, `judge '${name}'.spec`);
    if (raw.capabilities !== undefined) {
      const caps = asStringArray(raw.capabilities, `judge '${name}'.capabilities`);
      if (caps.length === 0) {
        throw new DefError(
          `judge '${name}'.capabilities must not be empty — omit the key to inherit the producing step's capabilities`,
        );
      }
      for (const cap of caps) assertAuthoredCapability(cap, `judge '${name}'.capabilities`);
      judge.capabilities = caps;
    }
    return judge;
  });
}

/**
 * Parse a `group:` entry in a `produces:` list (§26 YAML surface). Contributes
 * zero ProducePatterns — it names an exclusivity contract across sibling stems
 * declared elsewhere in the SAME produces list, so it's parsed and returned
 * separately rather than folded into the pattern array.
 */
function parseGroup(v: RawGroup, ctx: string): GroupDef {
  assertNoUnknownKeys(v, RAW_GROUP_KEYS, ctx);
  const group = asString(v.group, `${ctx}.group`);
  const mode = asString(v.mode, `group '${group}'.mode`);
  if (mode !== 'exactlyOne' && mode !== 'atMostOne' && mode !== 'atLeastOne') {
    throw new DefError(`group '${group}': mode must be one of exactlyOne, atMostOne, atLeastOne, got '${mode}'`);
  }
  if (!Array.isArray(v.of)) throw new DefError(`group '${group}': of: must be a list`);
  const of = v.of.map((s, i) => asString(s, `group '${group}'.of[${i}]`));
  return { group, mode, of };
}

/**
 * The `from` a bind gets when its author omits one: the final segment of
 * `to`. A shorthand `bind: modifier` therefore reads the accepted
 * object's `modifier` key, while `bind: meta.customer` reads `customer`.
 */
function defaultBindFrom(to: string): string {
  return to.slice(to.lastIndexOf('.') + 1);
}

/**
 * Parse a step's `produces` list. Each entry is either a bare pattern string
 * (`plan`, `gather.source[]`), a mapping `{ name, schema, judges, maxAttempts,
 * maxSchemaFailures }` attaching a JSON Schema the produced value must satisfy
 * at commit time (§19), a quality-gate list (§24), and/or a per-produce
 * override of the step's §6/§18 stall caps, or a `{ group, mode, of }`
 * exclusivity declaration (§26) spanning sibling stems produced by this same
 * list. `baseDir` resolves judge `bodyFile:` entries. Returns both the produce
 * patterns and any groups found, as a pure function (no out-param mutation).
 */
function parseProduces(v: unknown, ctx: string, baseDir?: string): { patterns: ProducePattern[]; groups: GroupDef[] } {
  if (v === undefined) return { patterns: [], groups: [] };
  if (!Array.isArray(v)) throw new DefError(`${ctx} must be a list`);
  const patterns: ProducePattern[] = [];
  const groups: GroupDef[] = [];
  v.forEach((entry, i) => {
    if (typeof entry === 'string') {
      patterns.push(parseProduce(entry));
      return;
    }
    if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      if ('group' in entry) {
        groups.push(parseGroup(entry as RawGroup, `${ctx}[${i}]`));
        return;
      }
      const raw = entry as RawProduce;
      assertNoUnknownKeys(raw, RAW_PRODUCE_KEYS, `${ctx}[${i}]`);
      const name = asString(raw.name, `${ctx}[${i}].name`);
      const pat = parseProduce(name);
      if (raw.schema !== undefined) pat.schema = asSchema(raw.schema, `produce '${name}'.schema`);
      if (raw.judges !== undefined) {
        if (pat.kind !== 'singleton') {
          throw new DefError(`produce '${name}': judges: is only supported on singleton produces (v1), got a ${pat.kind} produce`);
        }
        pat.judges = parseJudges(raw.judges, `produce '${name}'.judges`, baseDir);
      }
      if (raw.maxAttempts !== undefined) {
        const v = asNumber(raw.maxAttempts, 0, `produce '${name}'.maxAttempts`);
        if (v < 0) throw new DefError(`produce '${name}'.maxAttempts must be a non-negative number`);
        pat.maxAttempts = v;
      }
      if (raw.maxSchemaFailures !== undefined) {
        const v = asNumber(raw.maxSchemaFailures, 0, `produce '${name}'.maxSchemaFailures`);
        if (v < 0) throw new DefError(`produce '${name}'.maxSchemaFailures must be a non-negative number`);
        pat.maxSchemaFailures = v;
      }
      if (raw.bind !== undefined) {
				// bind.from is always a dot-separated object path. When omitted, it
				// defaults to the final segment of bind.to; missing paths are refused.
				if (typeof raw.bind === 'string') {
					pat.bind = { to: raw.bind, from: defaultBindFrom(raw.bind) };
				} else if (typeof raw.bind === 'object' && raw.bind !== null && !Array.isArray(raw.bind)) {
					const bind = raw.bind as { to?: unknown; from?: unknown };
					assertNoUnknownKeys(bind, ['to', 'from'], `produce '${name}'.bind`);
					const to = asString(bind.to, `produce '${name}'.bind.to`);
					const from = bind.from === undefined
						? defaultBindFrom(to)
						: asString(bind.from, `produce '${name}'.bind.from`);
					pat.bind = { to, from };
				} else {
					throw new DefError(`produce '${name}'.bind must be a string or a { to, from } mapping`);
				}
      }
      patterns.push(pat);
      return;
    }
    throw new DefError(`${ctx}[${i}] must be a string or a { name, schema, judges, maxAttempts, maxSchemaFailures, bind } mapping`);
  });
  return { patterns, groups };
}

export class DefError extends Error {}

// ---- Mode 1 include-directive helpers (M1-GRAMMAR) ---------------------------

/** Duck-check: does this raw step-list entry look like an include directive? */
function isIncludeDirective(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'include' in v;
}

/** Duck-check: does this raw step-list entry look like a calls: directive (M2-GRAMMAR)? */
function isCallsDirective(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'calls' in v && !('include' in v);
}

/** Parse and validate a raw include directive (M1-GRAMMAR pre-checks). */
function parseIncludeDirective(
  raw: unknown,
  i: number,
  parentName: string,
): { defName: string; as: string; inputs: Record<string, string> } {
  const obj = raw as RawInclude;
  assertNoUnknownKeys(obj, RAW_INCLUDE_KEYS, `step entry [${i}] include directive`);
  // include: must be a non-empty string
  if (typeof obj.include !== 'string' || obj.include.trim() === '') {
    throw new DefError(`step entry [${i}] 'include:' must be a workflow name string`);
  }
  const defName = obj.include.trim();
  // as: is required
  if (obj.as === undefined) {
    throw new DefError(`step entry [${i}] include directive is missing 'as:'`);
  }
  // as: must be a string
  if (typeof obj.as !== 'string') {
    throw new DefError(`step entry [${i}] include 'as:' must be a string`);
  }
  const as = obj.as;
  // as: must be a valid identifier token
  if (!/^[a-z][a-zA-Z0-9_-]*$/.test(as)) {
    throw new DefError(
      `include 'as:' value '${as}' must be a non-empty identifier matching ^[a-z][a-zA-Z0-9_-]*$`,
    );
  }
  // inputs: is optional; if present must be an object mapping strings to strings
  const inputs: Record<string, string> = {};
  if (obj.inputs !== undefined) {
    if (typeof obj.inputs !== 'object' || obj.inputs === null || Array.isArray(obj.inputs)) {
      throw new DefError(
        `include '${as}' inputs: must be an object mapping child input names to outer artifact names`,
      );
    }
    for (const [k, v] of Object.entries(obj.inputs as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new DefError(`include '${as}' inputs: value for key '${k}' must be a string`);
      }
      inputs[k] = v;
    }
  }
  void parentName; // used by callers for cross-checks after collecting all directives
  return { defName, as, inputs };
}

// ---- invariant helpers -------------------------------------------------------

/** Collect every stem referenced by `path` atoms in a predicate tree. */
function collectPredicateStems(pred: InvariantPredicate): string[] {
  if ('path' in pred) return [pred.path];
  if ('state' in pred) return [];
  if ('all' in pred) return pred.all.flatMap(collectPredicateStems);
  if ('any' in pred) return pred.any.flatMap(collectPredicateStems);
  return collectPredicateStems(pred.not); // 'not'
}

// Allowed `is` literals for path atoms
const ALLOWED_IS = new Set<string>([
  'owed', 'green', 'rejected', 'retracted', 'skipped', 'submitted', 'present', 'absent',
]);

/** Parse a raw object into an InvariantPredicate, throwing DefError on shape errors. */
function parseInvariantPredicate(v: unknown, ctx: string): InvariantPredicate {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new DefError(`${ctx} must be a predicate object`);
  }
  const obj = v as Record<string, unknown>;
  const discriminants = (['path', 'state', 'all', 'any', 'not'] as const).filter((k) => k in obj);
  if (discriminants.length === 0) {
    throw new DefError(`${ctx} must have exactly one of: path, state, all, any, not (got none)`);
  }
  if (discriminants.length > 1) {
    throw new DefError(`${ctx} must have exactly one of: path, state, all, any, not (got: ${discriminants.join(', ')})`);
  }
  const key = discriminants[0]!;
  if (key === 'path') {
    const path = asString(obj['path'], `${ctx}.path`);
    const is = asString(obj['is'], `${ctx}.is`);
    if (!ALLOWED_IS.has(is)) {
      throw new DefError(`${ctx}.is must be one of: ${[...ALLOWED_IS].join(', ')} (got '${is}')`);
    }
    return { path, is: is as Acceptance | 'present' | 'absent' };
  }
  if (key === 'state') {
    if (obj['state'] !== 'done') throw new DefError(`${ctx}.state must be 'done'`);
    return { state: 'done' };
  }
  if (key === 'all') {
    if (!Array.isArray(obj['all'])) throw new DefError(`${ctx}.all must be an array`);
    return { all: (obj['all'] as unknown[]).map((item, i) => parseInvariantPredicate(item, `${ctx}.all[${i}]`)) };
  }
  if (key === 'any') {
    if (!Array.isArray(obj['any'])) throw new DefError(`${ctx}.any must be an array`);
    return { any: (obj['any'] as unknown[]).map((item, i) => parseInvariantPredicate(item, `${ctx}.any[${i}]`)) };
  }
  // key === 'not'
  return { not: parseInvariantPredicate(obj['not'], `${ctx}.not`) };
}

/** Parse a raw invariants array into InvariantDef[], throwing DefError on shape errors. */
function parseInvariants(v: unknown, ctx: string): InvariantDef[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new DefError(`${ctx} must be a list`);
  return v.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new DefError(`${ctx}[${i}] must be a mapping`);
    }
    const raw = item as Record<string, unknown>;
    const name = asString(raw['name'], `${ctx}[${i}].name`);
    if (!('requires' in raw)) {
      throw new DefError(`${ctx}[${i}] ('${name}') must have a 'requires' predicate`);
    }
    const inv: InvariantDef = {
      name,
      requires: parseInvariantPredicate(raw['requires'], `invariant '${name}'.requires`),
    };
    if (raw['description'] !== undefined) {
      inv.description = asString(raw['description'], `invariant '${name}'.description`);
    }
    if (raw['when'] !== undefined) {
      inv.when = parseInvariantPredicate(raw['when'], `invariant '${name}'.when`);
    }
    return inv;
  });
}

// ---- parse + build -----------------------------------------------------------

/**
 * Instance-to-definition pinning (§28): a stable content hash of a compiled
 * WorkflowDef, used to detect when the live definition has drifted from an
 * instance's pinned snapshot. Sha256 of the def's canonical JSON form,
 * truncated to 16 hex chars — long enough to be practically collision-free
 * for this purpose (detecting accidental drift, not an adversarial actor),
 * short enough to be a legible field in `status` output.
 */
export function hashDef(def: WorkflowDef): string {
  return createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 16);
}

/**
 * Build a `WorkflowDef` from a parsed YAML object, coercing types and filling
 * defaults — but WITHOUT the static wiring checks. Throws DefError only on
 * malformed shapes (wrong types, missing name/steps). Use `parseDef` for the
 * full build-and-validate; this is exposed mainly so the validator can be
 * exercised on a built-but-invalid graph.
 */
export function buildDef(raw: unknown, source?: string, baseDir?: string): WorkflowDef {
  if (typeof raw !== 'object' || raw === null) {
    throw new DefError(`workflow definition${source ? ` (${source})` : ''} must be a mapping`);
  }
  const r = raw as RawDef;
  assertNoUnknownKeys(r, RAW_DEF_KEYS, `workflow definition${source ? ` (${source})` : ''}`);
  const name = asString(r.name, 'name');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    throw new DefError(`workflow name '${name}' must be alphanumeric (with - or _)`);
  }
  const engine = asEngineVersion(r.engine, name);

  const inputs: InputDef[] = (Array.isArray(r.inputs) ? r.inputs : []).map((ri, i) => {
    const raw = ri as RawInput;
    assertNoUnknownKeys(raw, RAW_INPUT_KEYS, `inputs[${i}]`);
    const inName = asString(raw.name, `inputs[${i}].name`);
    const input: InputDef = {
      name: inName,
      producer: raw.producer === undefined ? 'human' : asString(raw.producer, `inputs[${i}].producer`),
      seedOwed: asBool(raw.seedOwed, false, `inputs[${i}].seedOwed`),
    };
    if (raw.schema !== undefined) input.schema = asSchema(raw.schema, `input '${inName}'.schema`);
    return input;
  });

  if (!Array.isArray(r.steps) || r.steps.length === 0) {
    throw new DefError(`workflow '${name}' must declare at least one step`);
  }

  // Parse the step list, splitting normal steps from include directives (M1-GRAMMAR).
  const includes: NonNullable<WorkflowDef['_includes']> = [];
  const steps: StepDef[] = [];
  for (const [i, rl] of (r.steps as unknown[]).entries()) {
    if (isIncludeDirective(rl)) {
      const inc = parseIncludeDirective(rl, i, name);
      includes.push({ pos: steps.length, ...inc });
    } else {
      steps.push(...buildStep(rl as RawStep, i, baseDir));
    }
  }

  // M1-GRAMMAR post-parse cross-checks: duplicate as: and as:/step-name collision.
  if (includes.length > 0) {
    const asSeen = new Set<string>();
    const stepNameSet = new Set(steps.map((l) => l.name));
    for (const inc of includes) {
      if (asSeen.has(inc.as)) {
        throw new DefError(`include 'as:' value '${inc.as}' is used more than once in workflow '${name}'`);
      }
      asSeen.add(inc.as);
      if (stepNameSet.has(inc.as)) {
        throw new DefError(`include 'as:' value '${inc.as}' collides with sibling step name '${inc.as}' in workflow '${name}'`);
      }
    }
  }

  // Require at least one step OR at least one include directive.
  // (The steps array above may be empty if ALL entries are includes — that is fine
  //  once expanded. But we still need the workflow to have some work.)

  const def: WorkflowDef = { name, engine, inputs, steps };
  if (includes.length > 0) def._includes = includes;
  if (r.title !== undefined) def.title = asString(r.title, 'title');
  if (r.description !== undefined) def.description = asString(r.description, 'description');
  const invariants = parseInvariants(r.invariants, 'invariants');
  if (invariants.length > 0) def.invariants = invariants;
  if (r.outputs !== undefined) {
    const outs = asStringArray(r.outputs, 'outputs');
    if (outs.length > 0) def.outputs = outs;
  }
  if (r.x !== undefined) def.x = asExtension(r.x, `workflow '${name}'.x`);
  if (r.executors !== undefined) def.executors = asStringArray(r.executors, `workflow '${name}'.executors`);
  if (r.modifiers !== undefined) def.modifiers = parseModifiers(r.modifiers, `workflow '${name}'.modifiers`);
  return def;
}

// ---- Mode 1 expand helpers (M1-EXPAND) ----------------------------------------

/**
 * Prefix all names/stems in a StepDef with `${prefix}.`. Pure — returns a new StepDef.
 * Rewrites: step name, consume stems, produce stems, generates stems, invalidates, and
 * effect.onInvalidate step-name strings (but not 'pin'/'escalate').
 *
 * `defInputs` is the INCLUDED definition's declared input names, unprefixed. A
 * `workdirFrom` stem may name one of those instead of one of the step's own
 * consumes, and that stem is prefixed exactly like a consume stem is, because
 * an unmapped child input is hoisted into the parent under `${prefix}.${name}`.
 * Omitting the list would leave such a stem unparseable here and therefore
 * silently unprefixed, pointing at a stem the expanded definition does not have.
 */
function prefixStep(step: StepDef, prefix: string, defInputs: readonly string[] = []): StepDef {
  const prefixStem = (stem: string): string => `${prefix}.${stem}`;

  const newConsumes = step.consumes.map((c) => {
    const stem = prefixStem(c.stem);
    let raw: string;
    if (c.mode === 'plain') {
      raw = stem;
    } else if (c.mode === 'map') {
      raw = `${stem}[$${c.binder}]${c.suffix}`;
    } else {
      // reduce
      raw = `${stem}[*]${c.suffix}`;
    }
    return { ...c, stem, raw };
  });

  const prefixProduce = (p: ProducePattern): ProducePattern => {
    const stem = prefixStem(p.stem);
    let raw: string;
    if (p.kind === 'singleton') {
      raw = stem;
    } else if (p.kind === 'collection') {
      raw = `${stem}[]`;
    } else {
      // map
      raw = `${stem}[$${p.binder}]${p.suffix}`;
    }
    return { ...p, stem, raw };
  };

  const newProduces = step.produces.map(prefixProduce);
  const newGenerates = step.generates ? step.generates.map(prefixProduce) : undefined;

  const newInvalidates = step.invalidates.map(prefixStem);

  let newEffect = step.effect;
  if (step.effect?.onInvalidate && step.effect.onInvalidate !== 'pin' && step.effect.onInvalidate !== 'escalate') {
    newEffect = { ...step.effect, onInvalidate: prefixStem(step.effect.onInvalidate) };
  }

  // judges: marker names a local stem (unlike calls:, which names an external
  // workflow) — it must be prefixed to keep pointing at the (now-prefixed) produce.
  const newJudges = step.judges !== undefined ? prefixStem(step.judges) : undefined;
  // onCancel consumes name local stems, so they must follow the same prefixing
  // rule as ordinary consumes. Build a fresh object to avoid aliasing a child
  // definition into an expanded parent.
  const newOnCancel = step.onCancel !== undefined
    ? { consumes: step.onCancel.consumes.map(prefixStem) }
    : undefined;

  // workdirFrom names a local consumed stem or a declared input of the included
  // definition, followed by a dotted value path. Prefix only the stem; the value
  // path is a field path inside that artifact's value.
  let newWorkdirFrom = step.workdirFrom;
  if (step.workdirFrom !== undefined) {
    const parsed = parseWorkdirFrom(step.workdirFrom, step.consumes, defInputs);
    if (parsed) newWorkdirFrom = `${prefixStem(parsed.stem)}.${parsed.path}`;
  }

  const result: StepDef = {
    ...step,
    name: prefixStem(step.name),
    consumes: newConsumes,
    produces: newProduces,
    invalidates: newInvalidates,
  };
  // Each include alias is an independent materialization. Clone the opaque
  // extension carrier so nested values cannot leak mutations across aliases or
  // back into the resolved child definition. Preserve true absence.
  if (step.x !== undefined) result.x = structuredClone(step.x);
  if (newGenerates !== undefined) result.generates = newGenerates;
  if (newEffect !== undefined) result.effect = newEffect;
  if (newJudges !== undefined) result.judges = newJudges;
  if (newOnCancel !== undefined) result.onCancel = newOnCancel;
  if (newWorkdirFrom !== undefined) result.workdirFrom = newWorkdirFrom;
  return result;
}

/**
 * Expand all `_includes` directives in a `WorkflowDef`, returning a new def with
 * the child steps spliced in (prefixed + inputs rewired). Pure — never mutates input.
 *
 * `resolve` maps a def name to its un-expanded `WorkflowDef` (or undefined if unknown).
 * `stack` tracks the include chain for cycle detection (defaults to `[def.name]`).
 */
export function expandIncludes(
  def: WorkflowDef,
  resolve: (name: string) => WorkflowDef | undefined,
  stack?: string[],
): WorkflowDef {
  if (!def._includes || def._includes.length === 0) return def;

  const currentStack = stack ?? [def.name];

  // Build the ordered slot list: interleave normal steps and include directives by pos.
  // Each include has a `pos` = index in the original steps array where it is inserted.
  // We reconstruct the full ordered list in a single pass.
  const sortedIncludes = [...def._includes].sort((a, b) => a.pos - b.pos);

  const resultSteps: StepDef[] = [];
  const resultInputs: import('./types.ts').InputDef[] = [...def.inputs];
  const resultOutputs: string[] = [...(def.outputs ?? [])];

  // Walk the original steps interspersed with includes.
  let stepIdx = 0;
  let incIdx = 0;

  while (stepIdx < def.steps.length || incIdx < sortedIncludes.length) {
    // Emit all include directives whose pos <= current step index.
    while (incIdx < sortedIncludes.length && sortedIncludes[incIdx]!.pos <= stepIdx) {
      const inc = sortedIncludes[incIdx]!;
      incIdx++;

      // (a) resolve child def
      const childRaw = resolve(inc.defName);
      if (!childRaw) {
        throw new DefError(`include names workflow '${inc.defName}' which does not exist`);
      }

      // (b) cycle check
      if (currentStack.includes(inc.defName)) {
        throw new DefError(`include cycle: ${[...currentStack, inc.defName].join(' -> ')}`);
      }

      // (c) recurse: expand the child's includes first
      const child = expandIncludes(childRaw, resolve, [...currentStack, inc.defName]);

      // (d) M1-VALIDATE: inputs map keys must be real child inputs
      const childInputNames = new Set(child.inputs.map((inp) => inp.name));
      for (const k of Object.keys(inc.inputs)) {
        if (!childInputNames.has(k)) {
          throw new DefError(
            `include 'as ${inc.as}' maps input '${k}' which workflow '${inc.defName}' does not declare`,
          );
        }
      }

      // (e) prefix child steps
      const childInputList = child.inputs.map((inp) => inp.name);
      const prefixedSteps = child.steps.map((l) => prefixStep(l, inc.as, childInputList));

      // (f) handle inputs: mapped inputs become internal edges; unmapped are hoisted
      const inputRewrites = new Map<string, string>(); // prefixed-stem -> outer artifact
      for (const childInp of child.inputs) {
        const prefixedStem = `${inc.as}.${childInp.name}`;
        if (inc.inputs[childInp.name] !== undefined) {
          // Mapped: rewrite consumes referencing this stem to the outer artifact
          inputRewrites.set(prefixedStem, inc.inputs[childInp.name]!);
        } else {
          // Unmapped: hoist as outer input with prefixed name
          resultInputs.push({ ...childInp, name: prefixedStem });
        }
      }

      // Apply input rewrites to prefixed steps
      const prefixedChildInputStems = child.inputs.map((inp) => `${inc.as}.${inp.name}`);
      const rewrittenSteps = prefixedSteps.map((l) => {
        const rewrittenConsumes = l.consumes.map((c) => {
          const outer = inputRewrites.get(c.stem);
          if (outer !== undefined) {
            // Replace the consume with a plain consume to the outer artifact
            return { raw: outer, mode: 'plain' as const, stem: outer, suffix: '' };
          }
          return c;
        });
        // A workdirFrom stem naming a MAPPED child input has to follow the same
        // rewrite its consumes just took, or it would keep pointing at the
        // child-local stem that this expansion just replaced. Split against the
        // pre-rewrite consumes plus every prefixed child input, because the stem
        // may be either and both are subject to the mapping.
        let rewrittenWorkdirFrom = l.workdirFrom;
        if (l.workdirFrom !== undefined) {
          const parsed = parseWorkdirFrom(l.workdirFrom, l.consumes, prefixedChildInputStems);
          const outer = parsed ? inputRewrites.get(parsed.stem) : undefined;
          if (parsed && outer !== undefined) rewrittenWorkdirFrom = `${outer}.${parsed.path}`;
        }
        // onCancel consume stems follow ordinary consume rewrites for mapped
        // child inputs; otherwise the expanded step would name a stem it no
        // longer consumes.
        const rewrittenOnCancel = l.onCancel === undefined
          ? undefined
          : { consumes: l.onCancel.consumes.map((stem) => inputRewrites.get(stem) ?? stem) };
        const rewrittenStep: StepDef = {
          ...l,
          consumes: rewrittenConsumes,
          workdirFrom: rewrittenWorkdirFrom,
        };
        if (rewrittenOnCancel !== undefined) rewrittenStep.onCancel = rewrittenOnCancel;
        return rewrittenStep;
      });

      resultSteps.push(...rewrittenSteps);

      // (g) merge child outputs
      for (const stem of child.outputs ?? []) {
        const prefixedStem = `${inc.as}.${stem}`;
        if (!resultOutputs.includes(prefixedStem)) {
          resultOutputs.push(prefixedStem);
        }
      }
    }

    // Emit the next normal step (if any remain)
    if (stepIdx < def.steps.length) {
      resultSteps.push(def.steps[stepIdx]!);
      stepIdx++;
    }
  }

  const expanded: WorkflowDef = {
    ...def,
    steps: resultSteps,
    inputs: resultInputs,
    outputs: resultOutputs.length > 0 ? resultOutputs : def.outputs,
    _includes: undefined,
  };

  // CAS store roots are live loader provenance, deliberately non-enumerable so
  // they never enter hashes or persisted snapshots. The spread above therefore
  // cannot carry them. Preserve the original descriptor explicitly so an
  // include-expanded CAS definition still coordinates its snapshot writes with
  // bundle GC.
  const storeRoots = Object.getOwnPropertyDescriptor(def, 'bundleStoreRoots');
  if (storeRoots !== undefined) {
    Object.defineProperty(expanded, 'bundleStoreRoots', storeRoots);
  }
  return expanded;
}

/** Build a validated `WorkflowDef` from a parsed YAML object (or throw DefError). */
export function parseDef(raw: unknown, source?: string, baseDir?: string): WorkflowDef {
  const def = buildDef(raw, source, baseDir);
  const errors = validateDef(def);
  if (errors.length) {
    throw new DefError(
      `invalid workflow '${def.name}'${source ? ` (${source})` : ''}:\n  - ${errors.join('\n  - ')}`,
    );
  }
  return def;
}

/**
 * Synthesize one full StepDef per declared `judges:` entry on a produce
 * pattern (§24 §3.2, §7.2). Shape mirrors the `calls:` template above, with
 * exactly three deltas from a hand-written step: the `judges: <stem>` marker
 * (eligibility trigger, replacing inputsGreen — see model.ts), `produces: []`
 * (a judge emits a verdict against the judged stem, not a new artifact), and
 * `consumes: [stem, ...(inputs ? producerConsumeStems : [])]` so authority
 * flows from the existing consume-edge check (`assertAuthority`) with no
 * special-casing. Everything else (cadence, maxRunsPerDay, model, body,
 * maxAttempts/maxSchemaFailures defaults) is inherited exactly like
 * an ordinary step, because judge orders flow through the normal
 * eligibleFirings → applySchedule → claim → buildOrder pipeline (§7.1).
 */
function synthesizeJudgeSteps(
  producerStepName: string,
  pat: ProducePattern,
  producerConsumeStems: string[],
  producerX?: Record<string, unknown>,
  producerCapabilities?: string[],
): StepDef[] {
  if (!pat.judges || pat.judges.length === 0) return [];
  return pat.judges.map((j): StepDef => {
    const consumeStems = j.inputs ? [pat.stem, ...producerConsumeStems] : [pat.stem];
    const consumes = consumeStems.map((stem) => parseConsume(stem));
    const cadence = j.cadence ?? DEFAULTS.cadence;
    const step: StepDef = {
      name: `${producerStepName}.${pat.stem}.judges.${j.name}`,
      judges: pat.stem,
      consumes,
      produces: [],
      invalidates: [],
      cadence,
      cadenceSecs: parseDurationSecs(cadence),
      maxRunsPerDay: j.maxRunsPerDay ?? DEFAULTS.maxRunsPerDay,
      parallel: 1,
      maxAttempts: DEFAULTS.maxAttempts,
      maxSchemaFailures: DEFAULTS.maxSchemaFailures,
      body: j.body,
    };
    // Every native judge executes under the producer's complete opaque extension
    // carrier. Clone per judge so neither producer nor sibling mutations can
    // alter another synthesized step. Absence stays absence: no empty x bag.
    if (producerX !== undefined) step.x = structuredClone(producerX);
    // Routing: an explicit judge `capabilities:` wins; otherwise the judge
    // INHERITS the producer's. Without inheritance every synthesized judge
    // would be capability-silent, and a capability-silent step bypasses the
    // claim filter entirely — any polling crew could claim the judge that
    // gates work routed deliberately to one crew. Copied, not shared, so a
    // later mutation of either step cannot reach the other (same contract as
    // the `x` clone above).
    if (j.capabilities !== undefined) step.capabilities = [...j.capabilities];
    else if (producerCapabilities !== undefined) step.capabilities = [...producerCapabilities];
    if (j.model !== undefined) step.model = j.model;
    if (j.executor !== undefined) step.executor = j.executor;
    if (j.command !== undefined) step.command = j.command;
    if (j.spec !== undefined) step.spec = j.spec;
    return step;
  });
}

function buildStep(rl: RawStep, i: number, baseDir?: string): StepDef[] {
  // M2-GRAMMAR: if this entry carries a 'calls' key, parse it as a calls: step (Mode 2).
  if (typeof rl.calls !== 'undefined') {
    const rawCalls = rl as RawCalls;
    assertNoUnknownKeys(rawCalls, RAW_CALLS_KEYS, `steps[${i}] (calls: step)`);
    const name = asString(rawCalls.name, `steps[${i}].name`);
    const callsTarget = asString(rawCalls.calls, `step '${name}'.calls`);
    // parse inputs: optional mapping of child input name -> parent artifact name
    const callsInputs: Record<string, string> = {};
    if (rawCalls.inputs !== undefined) {
      if (typeof rawCalls.inputs !== 'object' || rawCalls.inputs === null || Array.isArray(rawCalls.inputs)) {
        throw new DefError(`step '${name}'.inputs: must be an object mapping child input names to parent artifact names`);
      }
      for (const [k, v] of Object.entries(rawCalls.inputs as Record<string, unknown>)) {
        if (typeof v !== 'string') throw new DefError(`step '${name}'.inputs: value for key '${k}' must be a string`);
        callsInputs[k] = v;
      }
    }
    // parse produces: (required; exactly one — enforced by validateDef)
    const { patterns: producesPatterns, groups: callsGroups } = parseProduces(rawCalls.produces, `step '${name}'.produces`, baseDir);
    for (const p of producesPatterns) {
      if (p.judges && p.judges.length > 0) {
        throw new DefError(`step '${name}': judges: is not supported on a calls: step's produces (produce '${p.stem}')`);
      }
    }
    if (callsGroups.length > 0) {
      throw new DefError(`step '${name}': group: is not supported on a calls: step's produces (group '${callsGroups[0]!.group}')`);
    }
    const step: StepDef = {
      name,
      calls: callsTarget,
      callsInputs,
      consumes: [],          // calls: steps have no consumes in StepDef (eligibility is engine-managed)
      produces: producesPatterns,
      invalidates: [],
      cadence: DEFAULTS.cadence,
      cadenceSecs: 0,
      maxRunsPerDay: DEFAULTS.maxRunsPerDay,
      parallel: 1,
      maxAttempts: 1,        // never worker-fired; 1 is a safe non-zero sentinel
      maxSchemaFailures: DEFAULTS.maxSchemaFailures,
      body: '',              // machine-handled: no prompt body
    };
    return [step];
  }

  assertNoUnknownKeys(rl, RAW_STEP_KEYS, `steps[${i}]`);
  const name = asString(rl.name, `steps[${i}].name`);
  const consumes = asStringArray(rl.consumes, `step '${name}'.consumes`).map(parseConsume);
  const { patterns: producesPatterns, groups } = parseProduces(rl.produces, `step '${name}'.produces`, baseDir);
  const { patterns: generatesPatterns, groups: generatesGroups } = parseProduces(rl.generates, `step '${name}'.generates`, baseDir);
  if (generatesGroups.length > 0) {
    throw new DefError(`step '${name}': group: is not supported on a generates: entry (group '${generatesGroups[0]!.group}')`);
  }
  const cadence = rl.cadence === undefined ? DEFAULTS.cadence : asString(rl.cadence, `step '${name}'.cadence`);
  const hasBody = rl.body !== undefined;
  const hasBodyFile = rl.bodyFile !== undefined;
  if (hasBody && hasBodyFile) {
    throw new DefError(`step '${name}': set either body or bodyFile, not both`);
  }
  let body: string;
  if (hasBodyFile) {
    const bodyFileRel = asString(rl.bodyFile, `step '${name}'.bodyFile`);
    if (baseDir === undefined) {
      throw new DefError(
        `step '${name}': bodyFile requires a workflow loaded from disk (no base directory to resolve '${bodyFileRel}' against)`,
      );
    }
    body = readBodyFileContained(baseDir, bodyFileRel, `step '${name}'`);
  } else {
    body = hasBody ? asString(rl.body, `step '${name}'.body`) : '';
  }
  const step: StepDef = {
    name,
    consumes,
    produces: [...producesPatterns, ...generatesPatterns], // engine reads this unified array
    invalidates: rl.invalidates === undefined
      ? consumes.map((c) => c.stem)
      : asStringArray(rl.invalidates, `step '${name}'.invalidates`),
    cadence,
    cadenceSecs: parseDurationSecs(cadence),
    maxRunsPerDay: asNumber(rl.maxRunsPerDay, DEFAULTS.maxRunsPerDay, `step '${name}'.maxRunsPerDay`),
    parallel: asNumber(rl.parallel, DEFAULTS.parallel, `step '${name}'.parallel`),
    maxAttempts: asNumber(rl.maxAttempts, DEFAULTS.maxAttempts, `step '${name}'.maxAttempts`),
    maxSchemaFailures: asNumber(rl.maxSchemaFailures, DEFAULTS.maxSchemaFailures, `step '${name}'.maxSchemaFailures`),
    body,
  };
  if (rl.workdir !== undefined) step.workdir = asString(rl.workdir, `step '${name}'.workdir`);
  if (rl.workdirFrom !== undefined) step.workdirFrom = asString(rl.workdirFrom, `step '${name}'.workdirFrom`);
  if (rl.model !== undefined) step.model = asString(rl.model, `step '${name}'.model`);
  if (rl.executor !== undefined) step.executor = asString(rl.executor, `step '${name}'.executor`);
  if (rl.command !== undefined) step.command = asString(rl.command, `step '${name}'.command`);
  if (rl.spec !== undefined) step.spec = asExtension(rl.spec, `step '${name}'.spec`);
  if (rl.x !== undefined) step.x = asExtension(rl.x, `step '${name}'.x`);
  if (asBool(rl.terminal, false, `step '${name}'.terminal`)) step.terminal = true;
  if (generatesPatterns.length > 0) step.generates = generatesPatterns; // kept for lint only
  if (groups.length > 0) step.groups = groups;
  if (rl.effect !== undefined) {
    if (typeof rl.effect !== 'object' || rl.effect === null || Array.isArray(rl.effect)) {
      throw new DefError(`step '${name}'.effect must be an object`);
    }
    const rawEffect = rl.effect as Record<string, unknown>;
    const effectDef: EffectDef = {};
    if (rawEffect['idempotent'] !== undefined) {
      effectDef.idempotent = asBool(rawEffect['idempotent'], true, `step '${name}'.effect.idempotent`);
    }
    if (rawEffect['onInvalidate'] !== undefined) {
      const oi = asString(rawEffect['onInvalidate'], `step '${name}'.effect.onInvalidate`);
      effectDef.onInvalidate = oi; // any string accepted here; D-D checks in validateDef
    }
    step.effect = effectDef;
  }
  if (rl.on !== undefined) {
    const rawOn = asStringArray(rl.on, `step '${name}'.on`);
    if (rawOn.length === 0) {
      throw new DefError(`step '${name}'.on must not be empty; a step must have at least one firing trigger`);
    }
    for (const tok of rawOn) {
      if (tok !== 'inputsGreen' && tok !== 'allGreen' && tok !== 'idle') {
        throw new DefError(
          `step '${name}': on: token '${tok}' is not supported; supported: 'inputsGreen', 'allGreen', 'idle'. ` +
          'Cleanup that must still run when the run is cancelled is declared with the step-level onCancel: key, not a firing trigger.',
        );
      }
    }
    step.on = rawOn as FiringTrigger[];
  }
  if (rl.idleAfter !== undefined) {
    const idleAfterStr = asString(rl.idleAfter, `step '${name}'.idleAfter`);
    step.idleAfter = idleAfterStr;
    step.idleAfterMs = parseDurationSecs(idleAfterStr) * 1000;
  }
  if (rl.reapTtl !== undefined) {
    const reapTtlStr = asString(rl.reapTtl, `step '${name}'.reapTtl`);
    step.reapTtlMs = parseDurationMs(reapTtlStr);
  }
  // A2: opaque routing capabilities. Empty list normalizes to absent (claimable by
  // any caller), mirroring the groups.length > 0 pattern below.
  if (rl.capabilities !== undefined) {
    const ls = asStringArray(rl.capabilities, `step '${name}'.capabilities`);
    for (const cap of ls) assertAuthoredCapability(cap, `step '${name}'.capabilities`);
    if (ls.length > 0) step.capabilities = ls;
  }
  if (rl.escalation !== undefined) {
    step.escalation = parseEscalation(rl.escalation, `step '${name}'.escalation`);
  }
  if (rl.onCancel !== undefined) {
    step.onCancel = parseOnCancel(rl.onCancel, `step '${name}'.onCancel`);
  }
  // A3: per-step max total lease lifetime (duration string, same as reapTtl).
  if (rl.maxLease !== undefined) {
    step.maxLeaseMs = parseDurationMs(asString(rl.maxLease, `step '${name}'.maxLease`));
  }
  // generates: entries may not declare judges: (they are lint-exempt side outputs,
  // not part of the step's primary contract) — hard error mirrors the calls: check above.
  for (const p of generatesPatterns) {
    if (p.judges && p.judges.length > 0) {
      throw new DefError(`step '${name}': judges: is not supported on a generates: entry (produce '${p.stem}')`);
    }
  }
  const producerConsumeStems = consumes.map((c) => c.stem);
  const judgeSteps = producesPatterns.flatMap((p) =>
    synthesizeJudgeSteps(name, p, producerConsumeStems, step.x, step.capabilities),
  );
  return [step, ...judgeSteps];
}

// ---- validation --------------------------------------------------------------

/**
 * Static wiring checks over a built definition. Returns human-readable error
 * strings (empty = valid). Catches the mistakes that would otherwise surface as
 * a workflow that never settles or never makes progress.
 */
export function validateDef(def: WorkflowDef): string[] {
  const errors: string[] = [];

  // unique step names
  const stepNames = new Set<string>();
  for (const l of def.steps) {
    if (stepNames.has(l.name)) errors.push(`duplicate step name '${l.name}'`);
    stepNames.add(l.name);
  }

  // an input name may not collide with a step name or a produced artifact
  const inputNames = new Set(def.inputs.map((i) => i.name));
  for (const dup of [...inputNames].filter((n) => stepNames.has(n))) {
    errors.push(`'${dup}' is both an input and a step name`);
  }

  for (const l of def.steps) {
    if (l.workdir === undefined && l.workdirFrom === undefined) continue;
    if (l.workdir !== undefined && l.workdirFrom !== undefined) {
      errors.push(`step '${l.name}': workdir and workdirFrom are mutually exclusive; use one`);
      continue;
    }
    if (l.workdirFrom === undefined) continue;

    const raw = l.workdirFrom.trim();
    // A stem that is itself dotted (`a.b`) would otherwise split into `a` + `b`
    // and report a confusing missing-stem error, so name the real mistake first:
    // the expression is a bare artifact name with no value path after it.
    const bareStem = l.consumes.some((c) => c.stem === raw) || inputNames.has(raw);
    if (bareStem) {
      errors.push(
        `step '${l.name}': workdirFrom must use '<stem>.<dotted.path>' with a non-empty value path`,
      );
      continue;
    }
    const firstDot = raw.indexOf('.');
    const valuePath = firstDot >= 0 ? raw.slice(firstDot + 1) : '';
    if (firstDot <= 0 || valuePath.length === 0) {
      errors.push(
        `step '${l.name}': workdirFrom must use '<stem>.<dotted.path>' with a non-empty value path`,
      );
      continue;
    }

    // A workdirFrom value becomes a filesystem path, so the stem must name
    // something this def actually declares: one of the step's own plain
    // consumes, or one of the definition's declared inputs.
    //
    // The input form exists because a COMMAND step cannot consume a human seed
    // at all — `exec/instructions.ts` gates command orders with `hardRule:
    // true`, and `consumed-verifier.ts` refuses any consumed value lacking a
    // producer signature, which a human-supplied input never has. Naming the
    // input here routes it through `OrderPacket.workdir` instead, which is a
    // spawn parameter rather than shell text or a consumed artifact.
    //
    // This deliberately relaxes an earlier rule that demanded a CONSUME, on the
    // stated grounds that the value must pass the consume-side gate "before a
    // worker can cd into it". That protection was not real: the engine resolves
    // this expression itself and ships a plain string as `OrderPacket.workdir`,
    // an explicitly "opaque location hint" that no proof covers and that the
    // command worker uses unverified. See `paths.ts`'s parseWorkdirFrom header
    // for the full argument, and note that the runtime bound on a worker's cwd
    // is the operator's declared work roots, not this check.
    const parsed = parseWorkdirFrom(raw, l.consumes, [...inputNames]);
    if (!parsed) {
      const stem = raw.slice(0, firstDot);
      errors.push(
        `step '${l.name}': workdirFrom stem '${stem}' is neither in consumes nor a declared input; ` +
        "a step may only take its workdir from an artifact it consumes or from one of the definition's inputs",
      );
    } else if (parsed.mode !== 'plain') {
      errors.push(
        `step '${l.name}': workdirFrom stem '${parsed.stem}' uses a ${parsed.mode} consume; ` +
        'workdirFrom requires a plain consume',
      );
    }
  }

  // one writer per artifact: map produced singleton/collection stems to producers
  const producerOf = new Map<string, string>(); // stem -> step name
  const collectionStems = new Set<string>();
  for (const name of inputNames) producerOf.set(name, 'human');
  for (const l of def.steps) {
    // a step must consume in exactly one mode (plain-only, or one map, or one reduce)
    const maps = l.consumes.filter((c) => c.mode === 'map');
    const reduces = l.consumes.filter((c) => c.mode === 'reduce');
    if (maps.length > 1) errors.push(`step '${l.name}' has more than one map consume`);
    if (reduces.length > 1) errors.push(`step '${l.name}' has more than one reduce consume`);
    if (maps.length && reduces.length) {
      errors.push(`step '${l.name}' mixes a map and a reduce consume (pick one shape)`);
    }

    for (const p of l.produces) {
      if (p.kind === 'collection') {
        collectionStems.add(p.stem);
        register(producerOf, p.stem, l.name, errors);
      } else if (p.kind === 'singleton') {
        register(producerOf, p.stem, l.name, errors);
      }
      // map outputs (gather.source[$i].formatcheck) are per-element children; the
      // collection they live under is owned by whoever produces the bare elements.
    }

    // map/reduce steps must produce the matching output shape
    if (maps.length && !l.produces.some((p) => p.kind === 'map')) {
      errors.push(`step '${l.name}' maps an element but produces no per-element (\$i) output`);
    }
    if (l.produces.some((p) => p.kind === 'map') && !maps.length) {
      errors.push(`step '${l.name}' produces a per-element output but has no map (\$i) consume to bind it`);
    }
  }

  // a reduce-mode step whose only produces are collections can never fire: eligibleFirings'
  // reduce branch (src/model.ts) derives the discharge set from singletonProduces(step) only,
  // so zero singleton produces means outs.length === 0 and no firing is ever pushed — the step
  // is silently dead (collection debt owed forever, absent from eligible/pending/blocked).
  for (const l of def.steps) {
    const isReduce = l.consumes.some((c) => c.mode === 'reduce');
    const hasCollectionProduce = l.produces.some((p) => p.kind === 'collection');
    const hasSingletonProduce = l.produces.some((p) => p.kind === 'singleton');
    if (isReduce && hasCollectionProduce && !hasSingletonProduce) {
      errors.push(`step ${l.name} is reduce-mode but produces only collections; reduce steps can only discharge singleton produces`);
    }
  }

  // same stem in both produces: and generates: on the same step is a hard error
  for (const l of def.steps) {
    if (!l.generates || l.generates.length === 0) continue;
    const generatedStems = new Set(l.generates.map((p) => p.stem));
    // produces-only patterns are those NOT in generates (using object identity since generates
    // patterns are the same ProducePattern objects we unioned into produces)
    const producesOnly = l.produces.filter((p) => !l.generates!.includes(p));
    for (const p of producesOnly) {
      if (generatedStems.has(p.stem)) {
        errors.push(`step '${l.name}': stem '${p.stem}' appears in both produces: and generates: (remove it from one)`);
      }
    }
  }

  // outputs: entries must name stems produced by some step
  if (def.outputs && def.outputs.length > 0) {
    const allProducedStems = new Set<string>(
      def.steps.flatMap((l) => l.produces.map((p) => p.stem)),
    );
    for (const stem of def.outputs) {
      if (!allProducedStems.has(stem)) {
        errors.push(`outputs: entry '${stem}' is not produced by any step`);
      }
    }
  }

  // every consumed stem must have a producer (an input or a step output)
  for (const l of def.steps) {
    for (const c of l.consumes) {
      if (c.mode === 'plain') {
        if (!producerOf.has(c.stem)) {
          errors.push(`step '${l.name}' consumes '${c.raw}' but nothing produces '${c.stem}'`);
        }
      } else {
        // map/reduce: the stem must be a collection produced somewhere
        if (!collectionStems.has(c.stem)) {
          errors.push(`step '${l.name}' consumes collection '${c.raw}' but no step produces '${c.stem}[]'`);
        }
      }
    }
  }

  // Collect steps already reported as dangling-consume (to avoid double-report
  // with the reachability check below, which catches the subtler case of a
  // producer that exists but is itself unreachable).
  const danglingSteps = new Set<string>();
  for (const l of def.steps) {
    for (const c of l.consumes) {
      if (c.mode === 'plain' && !producerOf.has(c.stem)) {
        danglingSteps.add(l.name);
      } else if (c.mode !== 'plain' && !collectionStems.has(c.stem)) {
        danglingSteps.add(l.name);
      }
    }
  }
  errors.push(...reachabilityErrors(def, danglingSteps));

  errors.push(...detectCycles(def, producerOf, collectionStems));

  // effect: validation
  for (const l of def.steps) {
    if (!l.effect) continue;
    // terminal: true and effect: are mutually exclusive (effect: is the forward spelling)
    if (l.terminal && l.effect) {
      errors.push(
        `step '${l.name}': terminal: true and effect: are mutually exclusive; ` +
        `effect: is the forward spelling — remove terminal: true`,
      );
    }
    // onInvalidate validation (D-D cross-reference checks for named-handler strings)
    const oi = l.effect.onInvalidate;
    if (oi !== undefined && oi !== 'pin' && oi !== 'escalate') {
      // Named handler: cross-reference checks
      const handlerStep = def.steps.find((h) => h.name === oi);
      if (!handlerStep) {
        errors.push(`step '${l.name}': effect.onInvalidate '${oi}' names a step that does not exist in this workflow`);
      } else if (oi === l.name) {
        errors.push(`step '${l.name}': effect.onInvalidate '${oi}' names itself; a step cannot be its own handler`);
      } else if (handlerStep.produces.length === 0) {
        errors.push(`step '${l.name}': effect.onInvalidate handler '${oi}' produces no outputs; a handler must produce at least one output`);
      }
    }
  }

  // W1-VALIDATE: executor:/command: shape rules (declarative executor dispatch).
  // Only two hard requirements; any other executor value is fully opaque.
  for (const l of def.steps) {
    const executor = l.executor ?? 'agent';
    // Deliberately `l.executor === 'agent'` (explicit opt-in), NOT
    // `(l.executor ?? 'agent') === 'agent'` — that stricter form would also
    // catch every default-agent step that already gets away with an empty
    // body today (e.g. calls:-adjacent or generator-only fixtures), breaking
    // existing defs that never write `executor:` at all. Scoping the check to
    // an EXPLICIT `executor: agent` keeps every pre-existing def byte-for-byte
    // unaffected while still catching "someone opted into the agent executor
    // type and forgot a body".
    if (l.executor === 'agent' && l.body.trim() === '') {
      errors.push(`step '${l.name}' has executor 'agent' but no body: (an agent step needs a prompt)`);
    } else if (executor === 'command') {
      if (l.command === undefined) {
        errors.push(`step '${l.name}' has executor 'command' but no command:`);
      }
    }
    // any other executor value: opaque, no body/command requirement
  }

  // W1-VALIDATE: executors: def-level allow-list typo guard. Applied AFTER the
  // per-step `executor` default (?? 'agent') — a def declaring `executors:
  // [command]` (deliberately excluding 'agent') still fails a step that omits
  // `executor:` entirely, since its effective executor is 'agent'. This is
  // intended (the list is exhaustive once declared), documented in
  // docs/authoring.md.
  if (def.executors && def.executors.length > 0) {
    const allowed = new Set(def.executors);
    for (const l of def.steps) {
      const executor = l.executor ?? 'agent';
      if (!allowed.has(executor)) {
        errors.push(`step '${l.name}' has executor '${executor}' but workflow '${def.name}'.executors does not list it`);
      }
    }
  }

  // on: token validation — belt-and-suspenders over buildStep's throw
  for (const l of def.steps) {
    if (!l.on) continue;
    if (l.on.length === 0) {
      errors.push(`step '${l.name}': on: must not be empty; a step must have at least one firing trigger`);
    }
    for (const tok of l.on) {
      if (tok !== 'inputsGreen' && tok !== 'allGreen' && tok !== 'idle') {
        errors.push(
          `step '${l.name}': on: token '${tok}' is not supported; ` +
          `supported: 'inputsGreen', 'allGreen', 'idle'. Cleanup that must still run when the run is cancelled is declared with the step-level onCancel: key, not a firing trigger.`,
        );
      }
    }
  }

  // idle/idleAfter cross-checks
  for (const l of def.steps) {
    const hasIdle = l.on?.includes('idle') ?? false;
    if (hasIdle && l.idleAfterMs === undefined) {
      errors.push(`step '${l.name}': on: includes 'idle' but idleAfter is not set; idleAfter is required for the idle trigger`);
    }
    if (!hasIdle && l.idleAfterMs !== undefined) {
      errors.push(`step '${l.name}': idleAfter is set but 'idle' is not in on:; idleAfter is only meaningful with the idle trigger`);
    }
  }

  // an allGreen/idle evaluator step that declares consumes can never commit: both firings
  // (src/model.ts) are built with inputs: [], so the claim fingerprint is empty, but commit-time
  // casCheck (src/engine.ts) derives required inputs from consumes and finds no fingerprint
  // entry for them — every firing is born-rejected forever. Evaluators must declare their
  // output under generates: with no consumes: (see examples/workflows/sla-watchdog.yaml, monitor).
  for (const l of def.steps) {
    const triggers = l.on ?? ['inputsGreen'];
    if (triggers.some((t) => t === 'allGreen' || t === 'idle') && l.consumes.length > 0) {
      errors.push(`evaluator step ${l.name} (on: allGreen/idle) must not declare consumes; its firings carry no input fingerprint`);
    }
  }

  // onCancel: cross-checks. A cancel-path firing is keyless and fires once, so
  // it can require only the step's own plain consumes.
  for (const l of def.steps) {
    if (l.onCancel === undefined) continue;
    const seen = new Set<string>();
    for (const stem of l.onCancel.consumes) {
      if (seen.has(stem)) {
        errors.push(`step '${l.name}': onCancel.consumes lists '${stem}' more than once`);
        continue;
      }
      seen.add(stem);
      const consume = l.consumes.find((candidate) => candidate.stem === stem);
      if (consume === undefined) {
        errors.push(
          `step '${l.name}': onCancel.consumes names '${stem}', which is not one of the step's consumes ` +
          `[${l.consumes.map((candidate) => candidate.stem).join(', ')}]`,
        );
        continue;
      }
      if (consume.mode !== 'plain') {
        errors.push(
          `step '${l.name}': onCancel.consumes names '${stem}', which the step consumes in ${consume.mode} mode ` +
          `('${consume.raw}'); the cancel-path firing is keyless, so only plain consumes may be listed`,
        );
      }
    }
  }

  // M2-VALIDATE: calls: step per-def rules.
  // Note: cross-def checks (target-def existence, child input-key validity) cannot be done here
  // because validateDef is a pure per-def function with no resolver. Those checks live in loadDefs
  // Phase 2, analogous to how expandIncludes validates include input-key mappings.
  for (const l of def.steps) {
    if (!l.calls) continue;
    // (a) calls: step must produce exactly one output (one child, one outcome path — v1)
    if (l.produces.length !== 1) {
      errors.push(`calls: step '${l.name}' must produce exactly one output (got ${l.produces.length})`);
    }
    // A calls: outcome is published by the composition machinery rather than
    // accepted through green(), so it has no transactional bind write path.
    // Refuse it at definition load instead of allowing a silently stale route.
    for (const produce of l.produces) {
      if (produce.bind !== undefined) {
				errors.push(
					`calls: step '${l.name}' produce '${produce.raw}' declares bind, which is not supported on calls: outcomes`,
				);
      }
    }
    // (b) callsInputs VALUES must be real parent artifacts (inputs or step-produced stems)
    for (const [, parentArtifact] of Object.entries(l.callsInputs ?? {})) {
      if (!producerOf.has(parentArtifact)) {
        errors.push(
          `calls: step '${l.name}' maps to parent artifact '${parentArtifact}' which is not produced by any step or input`,
        );
      }
    }
  }

  // J24-VALIDATE: synthesized judge step per-def rules.
  for (const l of def.steps) {
    if (l.judges === undefined) continue;
    // (a) a judge step must produce nothing — it commits a verdict against the
    //     judged stem, not a new artifact.
    if (l.produces.length !== 0) {
      errors.push(`judge step '${l.name}' must produce no outputs (got ${l.produces.length})`);
    }
    // (b) the judged stem must be a real producer with exactly one producer,
    //     and that producer's own produce entry must be the singleton the
    //     judge was synthesized from (defensive — buildStep already enforces
    //     singleton-only, this guards against future direct StepDef construction).
    const judgedStem = l.judges;
    if (!producerOf.has(judgedStem)) {
      errors.push(`judge step '${l.name}' judges '${judgedStem}' but nothing produces it`);
    } else if (collectionStems.has(judgedStem)) {
      errors.push(`judge step '${l.name}' judges '${judgedStem}' which is a collection produce; judges: is singleton-only (v1)`);
    }
    // (c) the judge step must consume the judged stem (authority flows from consumes).
    if (!l.consumes.some((c) => c.mode === 'plain' && c.stem === judgedStem)) {
      errors.push(`judge step '${l.name}' does not consume its judged stem '${judgedStem}'`);
    }
  }

  // G25-VALIDATE: declarative exclusive produce-groups per-def rules.
  for (const l of def.steps) {
    if (l.groups === undefined || l.groups.length === 0) continue;
    const claimedStems = new Set<string>();
    const groupNames = new Set<string>();
    for (const g of l.groups) {
      if (groupNames.has(g.group)) {
        errors.push(`step '${l.name}': group '${g.group}' is declared more than once`);
      }
      groupNames.add(g.group);
      if (g.mode !== 'exactlyOne' && g.mode !== 'atMostOne' && g.mode !== 'atLeastOne') {
        errors.push(`step '${l.name}': group '${g.group}' has unknown mode '${g.mode}'`);
      }
      if (g.of.length < 2) {
        errors.push(`step '${l.name}': group '${g.group}' needs at least two members`);
      }
      for (const stem of g.of) {
        const p = l.produces.find((p) => p.stem === stem);
        if (!p) {
          errors.push(`step '${l.name}': group '${g.group}' names '${stem}' in of: but this step does not produce it`);
          continue;
        }
        if (p.kind !== 'singleton') {
          errors.push(`step '${l.name}': group '${g.group}' member '${stem}' is a ${p.kind} produce; group membership is singleton-only (v1)`);
        }
        if (claimedStems.has(stem)) {
          errors.push(`step '${l.name}': stem '${stem}' is claimed by more than one group`);
        }
        claimedStems.add(stem);
      }
    }
  }

  // ---- routing modifiers and escalation ------------------------------------
  //
  // Three separate rules, each with its own precondition. They are grouped
  // because they all read `def.modifiers`, not because they are one check.
  //
  //   R1  escalation.modifier must be a member of the def's declared set, and
  //       a step may not carry `escalation:` at all in a def that declares no
  //       `modifiers:` — there is no target vocabulary for it to draw from.
  //   R2  escalation.after must be strictly less than the effective maxAttempts
  //       of EVERY produce on the step. At judgmentRejects >= maxAttempts the
  //       engine freezes the artifact (`model.ts` isStalled), so a rule
  //       authored at or past that threshold re-offers a step that can never
  //       run again. Taking the MINIMUM across produces is the conservative
  //       reading: the step is dead as soon as its shortest-fused produce
  //       freezes, whatever the others allow.
  //   R3  in a def that declares `modifiers:`, every command step must author
  //       `capabilities`. A capability-silent step bypasses the claim filter
  //       (`engine.ts` A2) entirely, so any polling crew could claim it —
  //       and, under composition, it would never receive a modifier suffix
  //       either, silently opting out of the routing the def just declared.
  //
  //       SCOPED DELIBERATELY to modifier-declaring defs. The plan document
  //       states this rule unconditionally, but every def that predates
  //       modifiers (examples/workflows/command-executor.yaml among them) has
  //       capability-silent command steps, and the same document promises
  //       "defs without `modifiers:` run exactly as today". Opting into the
  //       new routing vocabulary is what turns the stricter rule on.
  const declaredModifiers = new Set(def.modifiers ?? []);
  const modifierBinds: Array<{ step: string; artifact: string }> = [];
  for (const l of def.steps) {
    for (const p of l.produces) {
      const bind = p.bind;
      if (bind === undefined) continue;
      if (p.kind === 'collection') {
		errors.push(`step '${l.name}' produce '${p.raw}' bind is not supported on collection produces`);
		continue;
      }
      if (bind.to === 'modifier') {
				if (declaredModifiers.size === 0) {
					errors.push(
						`step '${l.name}' produce '${p.stem}' binds modifier but workflow '${def.name}' declares no modifiers:`,
					);
				}
				modifierBinds.push({ step: l.name, artifact: p.stem });
      } else if (!/^meta\.[A-Za-z_][A-Za-z0-9_-]*$/.test(bind.to)) {
				errors.push(
					`step '${l.name}' produce '${p.stem}' bind.to '${bind.to}' must be 'modifier' or 'meta.<key>'`,
				);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(bind.from)) {
				errors.push(
					`step '${l.name}' produce '${p.stem}' bind.from '${bind.from}' must be a non-empty dot-path of identifier segments`,
				);
      }
    }
  }
  if (modifierBinds.length > 1) {
    errors.push(
      `workflow '${def.name}' binds modifier more than once: ${modifierBinds.map((b) => `'${b.step}.${b.artifact}'`).join(', ')}`,
    );
  }
  for (const l of def.steps) {
    if (l.escalation === undefined) continue;
    if (declaredModifiers.size === 0) {
      errors.push(
        `step '${l.name}': escalation is set but workflow '${def.name}' declares no modifiers:; ` +
        'escalation.modifier must name a declared modifier',
      );
    } else if (!declaredModifiers.has(l.escalation.modifier)) {
      errors.push(
        `step '${l.name}': escalation.modifier '${l.escalation.modifier}' is not in workflow ` +
        `'${def.name}'.modifiers (${[...declaredModifiers].join(', ')})`,
      );
    }
    // An escalated re-offer is the same step's capabilities composed with the
    // target modifier. A step with no capabilities composes nothing, so the
    // re-offer would be byte-identical to the original offer: a rule that can
    // never route anywhere new.
    if (l.capabilities === undefined || l.capabilities.length === 0) {
      errors.push(
        `step '${l.name}': escalation is set but the step authors no capabilities; ` +
        'an escalated re-offer composes <capability>:<modifier>, so there is nothing to escalate',
      );
    }
    // The rule is REACHABILITY: at least one owed output must be able to sit at
    // `after` judgment rejects while still being re-offered. That is a MAX over
    // the per-produce caps, not a MIN, because the engine evaluates the trigger
    // per owed path and drops frozen paths from the firing rather than killing
    // the firing:
    //
    //   - eligibleFirings (model.ts) filters a step's outputs to the ones that
    //     are still debt AND not frozen, and emits the firing when that filtered
    //     list is non-empty. A step producing `plan` (cap 6) and `consult`
    //     (cap 2) keeps firing for `plan` after `consult` has stalled.
    //   - routingFor (engine.ts) then tests `f.outputs.find((p) => isEscalated(
    //     arts.get(p), rule.after))` — the SAME filtered list. One live path over
    //     the threshold is enough to route.
    //
    // So the shortest-fused produce freezing does not end the step, and a
    // MIN ceiling would reject a def whose escalation is plainly reachable
    // through a longer-fused produce. The `>=` is still right at the MAX: an
    // artifact with `judgmentRejects >= cap` is stalled (isStalled, model.ts),
    // therefore frozen, therefore filtered out of `f.outputs` before routingFor
    // ever looks at it — so `after` equal to the highest cap can never fire.
    const attemptCeilings = l.produces.length > 0
      ? l.produces.map((p) => p.maxAttempts ?? l.maxAttempts)
      : [l.maxAttempts];
    const ceiling = Math.max(...attemptCeilings);
    if (l.escalation.after >= ceiling) {
      errors.push(
        `step '${l.name}': escalation.after (${l.escalation.after}) must be strictly less than ` +
        `the step's highest per-produce maxAttempts (${ceiling}); at ${ceiling} rejections every ` +
        'output has frozen, so the escalated re-offer could never run',
      );
    }
  }
  if (declaredModifiers.size > 0) {
    for (const l of def.steps) {
      if ((l.executor ?? 'agent') !== 'command') continue;
      if (l.capabilities === undefined || l.capabilities.length === 0) {
        errors.push(
          `step '${l.name}': workflow '${def.name}' declares modifiers:, so every command step must ` +
          'author capabilities: — a capability-silent step is claimable by any crew and never ' +
          'receives a modifier',
        );
      }
    }
  }

  // Semantic invariant validation: unknown stem references and duplicate names.
  if (def.invariants && def.invariants.length > 0) {
    const invariantNames = new Set<string>();
    for (const inv of def.invariants) {
      if (invariantNames.has(inv.name)) {
        errors.push(`invariant name '${inv.name}' is declared more than once`);
      }
      invariantNames.add(inv.name);
      const stems = collectPredicateStems(inv.requires);
      if (inv.when) stems.push(...collectPredicateStems(inv.when));
      for (const stem of stems) {
        if (!producerOf.has(stem)) {
          errors.push(`invariant '${inv.name}' references unknown stem '${stem}' (not an input or produced artifact)`);
        }
      }
    }
  }

  return errors;
}

function register(map: Map<string, string>, stem: string, step: string, errors: string[]): void {
  const existing = map.get(stem);
  if (existing && existing !== step) {
    errors.push(`artifact '${stem}' has two producers: '${existing}' and '${step}'`);
  }
  map.set(stem, step);
}

/** Detect a dependency cycle in the consume→produce graph (a deadlock). */
function detectCycles(
  def: WorkflowDef,
  producerOf: Map<string, string>,
  collectionStems: Set<string>,
): string[] {
  // edges: step -> producer-of-each-consumed-stem (excluding human inputs)
  const deps = new Map<string, Set<string>>();
  for (const l of def.steps) deps.set(l.name, new Set());
  for (const l of def.steps) {
    for (const c of l.consumes) {
      const producer = producerOf.get(c.stem) ?? (collectionStems.has(c.stem) ? producerOf.get(c.stem) : undefined);
      if (producer && producer !== 'human' && producer !== l.name) deps.get(l.name)!.add(producer);
    }
  }

  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>([...deps.keys()].map((k) => [k, WHITE]));
  const stack: string[] = [];
  const cycles: string[] = [];

  const visit = (n: string): void => {
    color.set(n, GREY);
    stack.push(n);
    for (const m of deps.get(n) ?? []) {
      const c = color.get(m);
      if (c === GREY) {
        const from = stack.indexOf(m);
        cycles.push(`dependency cycle: ${[...stack.slice(from), m].join(' → ')}`);
      } else if (c === WHITE) {
        visit(m);
      }
    }
    stack.pop();
    color.set(n, BLACK);
  };
  for (const n of deps.keys()) if (color.get(n) === WHITE) visit(n);
  return cycles;
}

/**
 * Forward reachability from the seeded inputs. Returns error strings for any
 * step that can never fire because one of its consumed stems is not transitively
 * reachable from the workflow inputs, even though a producer exists (a dead
 * island). Does NOT double-report when a dangling-consume error already fired
 * for the same step (caller passes `danglingSteps` to suppress).
 */
function reachabilityErrors(
  def: WorkflowDef,
  danglingSteps: Set<string>,
): string[] {
  const reachable = new Set<string>(def.inputs.map((i) => i.name));
  const reachedStep = new Set<string>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const l of def.steps) {
      if (reachedStep.has(l.name)) continue;
      const allReachable = l.consumes.every((c) => reachable.has(c.stem));
      if (allReachable) {
        reachedStep.add(l.name);
        changed = true;
        for (const p of l.produces) {
          reachable.add(p.stem);
        }
      }
    }
  }

  const errors: string[] = [];
  for (const l of def.steps) {
    if (reachedStep.has(l.name)) continue;
    if (danglingSteps.has(l.name)) continue; // already reported as dangling-consume
    // find the first unreachable consumed stem
    const blocker = l.consumes.find((c) => !reachable.has(c.stem));
    const stem = blocker?.stem ?? '(unknown)';
    errors.push(
      `step '${l.name}' is unreachable: it can never fire (consumes '${stem}' which nothing reachable produces)`,
    );
  }
  return errors;
}

/**
 * Returns warning strings for any singleton or collection stem that nothing
 * consumes, on a non-terminal step. Map outputs are excluded (they are
 * per-element children, not consumed as top-level stems). Terminal steps are
 * explicitly intended sinks. Stems declared under generates: are exempt.
 */
function deadEndWarnings(def: WorkflowDef): string[] {
  // all stems consumed by any step
  const consumed = new Set<string>(
    def.steps.flatMap((l) => l.consumes.map((c) => c.stem)),
  );
  // stems declared under generates: are intentionally unconsumed — lint-exempt
  const generatedStems = new Set<string>(
    def.steps.flatMap((l) => (l.generates ?? []).map((p) => p.stem)),
  );
  // stems declared in workflow outputs: are intentional public leaves — lint-exempt
  const workflowOutputStems = new Set<string>(def.outputs ?? []);

  const warnings: string[] = [];
  for (const l of def.steps) {
    if (l.terminal) continue; // terminal steps are intended sinks
    for (const p of l.produces) {
      if (p.kind === 'map') continue; // per-element outputs are not top-level stems
      if (generatedStems.has(p.stem)) continue; // generates: exempt
      if (workflowOutputStems.has(p.stem)) continue; // workflow outputs: exempt
      if (!consumed.has(p.stem)) {
        warnings.push(
          `step '${l.name}' produces '${p.stem}' but nothing consumes it ` +
          `(dead-end output; declare it under generates: if no consumer is expected, ` +
          `list it in the workflow outputs: if it is a public interface leaf, ` +
          `or mark the step terminal: true if this is an intended sink)`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Returns warning strings for a suffixed reduce (`src[*].child`) whose
 * `.child` pattern is not actually produced by any map step over the same
 * stem `src` — i.e. no step has a `produces:` map pattern with `stem ===
 * src` and `suffix === '.child'`. The stem-level "consumed collection must
 * have a producer" check (validateDef) already covers the bare-stem case;
 * this is the narrower, suffix-specific dangling-wiring case, non-fatal
 * because the wiring might be intentionally satisfied by a differently
 * shaped producer.
 */
function danglingReduceSuffixWarnings(def: WorkflowDef): string[] {
  const mapProduceSuffixesByStem = new Map<string, Set<string>>();
  for (const l of def.steps) {
    for (const p of l.produces) {
      if (p.kind !== 'map') continue;
      if (!mapProduceSuffixesByStem.has(p.stem)) mapProduceSuffixesByStem.set(p.stem, new Set());
      mapProduceSuffixesByStem.get(p.stem)!.add(p.suffix);
    }
  }

  const warnings: string[] = [];
  for (const l of def.steps) {
    for (const c of l.consumes) {
      if (c.mode !== 'reduce' || c.suffix === '') continue;
      const suffixes = mapProduceSuffixesByStem.get(c.stem);
      if (!suffixes || !suffixes.has(c.suffix)) {
        warnings.push(
          `step '${l.name}' consumes '${c.raw}' but no map step produces ` +
          `'${c.stem}[$i]${c.suffix}' (dangling suffixed-reduce wiring)`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Whether a consume can receive a value produced by this exact pattern.
 *
 * Keeping map suffixes here is essential: `items[$i].review` does not make a
 * consumer of `items[*].analysis` (or bare `items[*]`) downstream merely
 * because both lanes share the `items` stem.
 */
function consumesProducedPattern(consume: ConsumePattern, produce: ProducePattern): boolean {
  if (consume.stem !== produce.stem) return false;
  if (produce.kind === 'singleton') return consume.mode === 'plain';
  if (produce.kind === 'collection') {
    return consume.mode !== 'plain' && consume.suffix === '';
  }
  return consume.mode !== 'plain' && consume.suffix === produce.suffix;
}

/** Warn when routed work can run before the artifact that writes the modifier. */
function unroutedCapabilityWarnings(def: WorkflowDef): string[] {
  let bindingStep: StepDef | undefined;
  let boundArtifact: ProducePattern | undefined;
  for (const step of def.steps) {
    const bound = step.produces.find((p) => p.bind?.to === 'modifier');
    if (bound !== undefined) {
      bindingStep = step;
      boundArtifact = bound;
      break;
    }
  }
  if (bindingStep === undefined || boundArtifact === undefined) return [];

  // Forward graph closure from the bound artifact. The binding step itself is
  // exempt, but its unbound sibling outputs must not make a branch downstream.
  const reachedSteps = new Set<string>([bindingStep.name]);
  const reachedArtifacts: ProducePattern[] = [boundArtifact];
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of def.steps) {
      if (reachedSteps.has(step.name)) continue;
      if (!step.consumes.some((consume) => reachedArtifacts.some((produce) => consumesProducedPattern(consume, produce)))) continue;
      reachedSteps.add(step.name);
      reachedArtifacts.push(...step.produces);
      changed = true;
    }
  }

  const warnings: string[] = [];
  for (const step of def.steps) {
    if (step.capabilities === undefined || step.capabilities.length === 0) continue;
    if (reachedSteps.has(step.name)) continue;
    warnings.push(
      `step '${step.name}' declares capabilities (${step.capabilities.join(', ')}) but is not downstream of artifact '${boundArtifact.raw}' bound to modifier`,
    );
  }
  return warnings;
}

/** Whether a discovery-convention value is a YAML mapping. */
function isDiscoveryMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Return advisory issues for Owenloop's optional x.discovery convention.
 *
 * This deliberately does not assign a severity. W2.1 can promote these same
 * deterministic issues for library definitions without duplicating validation.
 * The parser and engine continue to treat all extension contents as opaque.
 */
function discoveryIssues(def: WorkflowDef): string[] {
  const issues: string[] = [];
  const discovery = def.x?.discovery;
  if (discovery === undefined) return ['x.discovery: missing required discovery metadata'];
  if (!isDiscoveryMap(discovery)) return ['x.discovery: expected a map'];

  const requiredString = (value: unknown, path: string): string | undefined => {
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push(path + ': expected a non-empty string');
      return undefined;
    }
    return value;
  };
  const requiredPhraseList = (value: unknown, path: string): void => {
    if (!Array.isArray(value) || value.length === 0) {
      issues.push(path + ': expected a non-empty array of non-empty strings');
      return;
    }
    for (const [index, item] of value.entries()) requiredString(item, path + '[' + index + ']');
  };
  /**
   * Validate a mapping in the order its fields were authored.  Required
   * fields absent from the mapping follow in the convention's fixed order,
   * making both kinds of diagnostic deterministic.
   */
  const visitMapFields = (
    value: Record<string, unknown>,
    allowed: readonly string[],
    path: string,
    visitKnownField: (key: string, fieldValue: unknown) => void,
  ): void => {
    const allowedSet = new Set(allowed);
    const present = new Set<string>();
    for (const key of Object.keys(value)) {
      if (!allowedSet.has(key)) {
        issues.push(path + '.' + key + ': unknown field');
        continue;
      }
      present.add(key);
      visitKnownField(key, value[key]);
    }
    for (const key of allowed) if (!present.has(key)) visitKnownField(key, undefined);
  };

  const inputs = new Map(def.inputs.map((input) => [input.name, { schema: input.schema }]));
  const outputs = new Map(
    (def.outputs ?? []).map((name) => {
      const artifact = def.steps.flatMap((step) => [...step.produces, ...(step.generates ?? [])])
        .find((produce) => produce.stem === name);
      return [name, { schema: artifact?.schema }];
    }),
  );
  const validateInterfaceEntries = (
    value: unknown,
    path: 'inputs' | 'outputs',
    declared: ReadonlyMap<string, { schema?: unknown }>,
  ): void => {
    const fieldPath = 'x.discovery.interface.' + path;
    const singular = path === 'inputs' ? 'input' : 'output';
    if (!Array.isArray(value)) {
      issues.push(fieldPath + ': expected an array');
      return;
    }

    const seen = new Set<string>();
    for (const [index, entry] of value.entries()) {
      const entryPath = fieldPath + '[' + index + ']';
      if (!isDiscoveryMap(entry)) {
        issues.push(entryPath + ': expected a map');
        continue;
      }

      visitMapFields(entry, ['name', 'summary', 'schemaRef'], entryPath, (key, fieldValue) => {
        switch (key) {
          case 'name': {
            const name = requiredString(fieldValue, entryPath + '.name');
            if (name === undefined) break;

            // Record every non-blank name before declaration lookup. This
            // preserves both useful findings for repeated unknown names.
            if (seen.has(name)) {
              issues.push(entryPath + '.name: duplicate workflow ' + singular + " '" + name + "'");
            } else {
              seen.add(name);
            }

            const artifact = declared.get(name);
            if (artifact === undefined) {
              issues.push(entryPath + '.name: unknown workflow ' + singular + " '" + name + "'");
            } else if (artifact.schema === undefined) {
              issues.push(entryPath + '.schemaRef: workflow ' + singular + " '" + name + "' has no schema");
            }
            break;
          }
          case 'summary':
            requiredString(fieldValue, entryPath + '.summary');
            break;
          case 'schemaRef': {
            const schemaRef = requiredString(fieldValue, entryPath + '.schemaRef');
            if (schemaRef !== undefined && !schemaRef.startsWith('#/')) {
              issues.push(entryPath + '.schemaRef: expected a local JSON pointer starting with \'#/\'');
            }
            break;
          }
        }
      });
    }
    for (const name of declared.keys()) {
      if (!seen.has(name)) issues.push(fieldPath + ': missing workflow ' + singular + " '" + name + "'");
    }
  };

  const validateInterface = (value: unknown): void => {
    if (!isDiscoveryMap(value)) {
      issues.push('x.discovery.interface: expected a map');
      return;
    }
    visitMapFields(value, ['inputs', 'outputs'], 'x.discovery.interface', (key, fieldValue) => {
      if (key === 'inputs') validateInterfaceEntries(fieldValue, 'inputs', inputs);
      else validateInterfaceEntries(fieldValue, 'outputs', outputs);
    });
  };

  visitMapFields(discovery, ['description', 'whenToUse', 'notFor', 'interface'], 'x.discovery', (key, value) => {
    switch (key) {
      case 'description':
        requiredString(value, 'x.discovery.description');
        break;
      case 'whenToUse':
        requiredPhraseList(value, 'x.discovery.whenToUse');
        break;
      case 'notFor':
        requiredPhraseList(value, 'x.discovery.notFor');
        break;
      case 'interface':
        validateInterface(value);
        break;
    }
  });
  return issues;
}

/**
 * Static lint over a workflow definition. Returns both the hard errors from
 * `validateDef` (which `parseDef` / `loadDefFile` would throw on) and
 * non-fatal warnings (dead-end outputs, dangling suffixed-reduce wiring).
 * Warnings never block loading — this function is the right surface for
 * author tooling / CI checks.
 *
 * These warnings are suppressed when there are hard errors: a broken graph
 * may have spurious orphan stems that will resolve once the errors are fixed.
 */
export function lintDef(def: WorkflowDef): { errors: string[]; warnings: string[] } {
  const errors = validateDef(def);
  const warnings = errors.length === 0
    ? [...deadEndWarnings(def), ...danglingReduceSuffixWarnings(def), ...unroutedCapabilityWarnings(def), ...discoveryIssues(def)]
    : [];
  return { errors, warnings };
}

/**
 * The steps a def declares as cleanup-on-cancel, in definition order. The
 * control plane calls this when it cancels a run.
 */
export function cancelCleanupSteps(def: WorkflowDef): StepDef[] {
  return def.steps.filter((step) => step.onCancel !== undefined);
}

// ---- WS-6: scope-aware calls: target resolution -------------------------------

/** Stable private-map key for one installed coordinate at one verified digest. */
export function digestScopedCallsTargetKey(
  digest: string,
  target: string,
): string {
  return `${digest}/${target}`;
}

/**
 * Resolve one `calls:` edge to the def map KEY that edge names, honoring CAS
 * bundle scope. Returns `undefined` when nothing matches (the caller reports the
 * `does not exist` error, or skips, as it always has).
 *
 * THREE CASES, checked in this order:
 *
 *  1. `target` contains `/` — an explicitly QUALIFIED reference. When the
 *     calling definition carries a lock digest for that exact target, prefer the
 *     digest-scoped coordinate alias registered by the CAS loader. That preserves
 *     an already-running parent's selection when a project coordinate later
 *     shadows the global coordinate it originally pinned. Without a reachable
 *     pinned alias, use the direct coordinate/package key so new lookups retain
 *     project-over-global precedence and the engine can surface a pin mismatch.
 *     Never fall back to a bare lookup: an author who wrote a qualified name
 *     asked for one specific definition.
 *
 *  2. `from` carries a `bundleDigest` (it was loaded out of a CAS bundle) and
 *     `target` is bare — resolve SIBLING-FIRST: search the map for a def whose
 *     `bundleDigest` equals `from.bundleDigest` and whose own name equals
 *     `target`. This is what makes `calls: build` inside bundle A bind to
 *     bundle A's `build` and never to bundle B's.
 *
 *  3. Otherwise — today's plain flat-map lookup, byte-for-byte unchanged. Every
 *     def loaded off the filesystem or handed to `createEngine({ defs })` has
 *     no `bundleDigest`, so it takes this path exactly as before.
 *
 * A bare `calls:` from a CAS def that names NO sibling falls through case 2 into
 * case 3, so an out-of-bundle name still resolves if the flat map holds it and
 * still produces the existing `does not exist` error if it does not.
 */
function resolveCallsTargetKey(
  defs: Map<string, WorkflowDef>,
  target: string,
  from: WorkflowDef,
): string | undefined {
  if (target.includes('/')) {
    const pinnedDigest = from.bundleLock?.[target];
    if (pinnedDigest !== undefined) {
      const pinnedKey = digestScopedCallsTargetKey(pinnedDigest, target);
      if (defs.has(pinnedKey)) return pinnedKey;
    }
    return defs.has(target) ? target : undefined;
  }
  if (from.bundleDigest !== undefined) {
    for (const [key, candidate] of defs) {
      if (candidate.bundleDigest === from.bundleDigest && candidate.name === target) return key;
    }
  }
  return defs.has(target) ? target : undefined;
}

/**
 * The def a `calls:` edge names, honoring CAS bundle scope — the value form of
 * {@link resolveCallsTargetKey}. This is the ONE resolution rule shared by
 * load-time validation (`finalizeDefs`), cycle detection, and the engine's
 * spawn path, so a def that validates at load time is the same def the engine
 * spawns at runtime.
 */
export function resolveCallsTarget(
  defs: Map<string, WorkflowDef>,
  target: string,
  from: WorkflowDef,
): WorkflowDef | undefined {
  const key = resolveCallsTargetKey(defs, target, from);
  return key === undefined ? undefined : defs.get(key);
}

// ---- M2-CYCLE: cross-def calls-cycle detection --------------------------------

/** A calls cycle and the resolved definition keys on its displayed path. */
export interface CallsCycleFinding {
  message: string;
  members: string[];
}

interface CallsGraph {
  keys: string[];
  order: Map<string, number>;
  edges: Map<string, string[]>;
}

function buildCallsGraph(defs: Map<string, WorkflowDef>): CallsGraph {
  const keys = [...defs.keys()];
  const edges = new Map<string, string[]>();
  for (const [key, def] of defs) {
    // WS-6: graph nodes are RESOLVED map keys, not bare calls text. Two bundles
    // may both export `build` without being fused into one graph node.
    const children = new Set<string>();
    for (const step of def.steps) {
      if (step.calls === undefined) continue;
      const child = resolveCallsTargetKey(defs, step.calls, def);
      if (child !== undefined) children.add(child);
    }
    edges.set(key, [...children]);
  }
  return {
    keys,
    order: new Map(keys.map((key, index) => [key, index])),
    edges,
  };
}

/**
 * Preserve the original tri-color DFS exactly for strict loading. It stops at
 * the first back edge, so finalizeDefs remains O(V+E) and retains its stable
 * first-cycle message and traversal precedence.
 */
function findFirstCallsCycle(graph: CallsGraph): string[] | undefined {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map(graph.keys.map((key) => [key, WHITE]));
  const stack: string[] = [];
  const visit = (key: string): string[] | undefined => {
    color.set(key, GREY);
    stack.push(key);
    for (const child of graph.edges.get(key) ?? []) {
      const state = color.get(child) ?? WHITE;
      if (state === GREY) return [...stack.slice(stack.indexOf(child)), child];
      if (state === WHITE) {
		const found = visit(child);
		if (found !== undefined) return found;
      }
    }
    stack.pop();
    color.set(key, BLACK);
    return undefined;
  };
  for (const key of graph.keys) {
    if ((color.get(key) ?? WHITE) !== WHITE) continue;
    const found = visit(key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function cycleFingerprint(cycle: readonly string[]): string {
  const members = cycle.slice(0, -1);
  return members
    .map((_, index) => [...members.slice(index), ...members.slice(0, index)].join('\u0000'))
    .sort()[0] ?? '';
}

function canonicalizeCycle(cycle: string[], order: Map<string, number>): string[] {
  const members = cycle.slice(0, -1);
  let first = 0;
  for (let index = 1; index < members.length; index++) {
    if ((order.get(members[index]!) ?? Number.MAX_SAFE_INTEGER) < (order.get(members[first]!) ?? Number.MAX_SAFE_INTEGER)) {
      first = index;
    }
  }
  const rotated = [...members.slice(first), ...members.slice(0, first)];
  return [...rotated, rotated[0]!];
}

/** Return each cyclic SCC, indexed by every member, using deterministic Tarjan traversal. */
function cyclicComponentsByMember(graph: CallsGraph): Map<string, Set<string>> {
  let nextIndex = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const byMember = new Map<string, Set<string>>();

  const visit = (key: string): void => {
    index.set(key, nextIndex);
    lowlink.set(key, nextIndex);
    nextIndex++;
    stack.push(key);
    onStack.add(key);

    for (const child of graph.edges.get(key) ?? []) {
      if (!index.has(child)) {
		visit(child);
		lowlink.set(key, Math.min(lowlink.get(key)!, lowlink.get(child)!));
      } else if (onStack.has(child)) {
		lowlink.set(key, Math.min(lowlink.get(key)!, index.get(child)!));
      }
    }

    if (lowlink.get(key) !== index.get(key)) return;
    const members: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      members.push(member);
      if (member === key) break;
    }
    const cyclic = members.length > 1 || (graph.edges.get(key) ?? []).includes(key);
    if (!cyclic) return;
    const component = new Set(members);
    for (const member of members) byMember.set(member, component);
  };

  for (const key of graph.keys) {
    if (!index.has(key)) visit(key);
  }
  return byMember;
}

/** Find one deterministic simple cycle through member inside its cyclic SCC. */
function cycleThroughMember(
  member: string,
  component: ReadonlySet<string>,
  graph: CallsGraph,
): string[] | undefined {
  const pathBack = (key: string, target: string, path: string[], seen: Set<string>): string[] | undefined => {
    for (const child of graph.edges.get(key) ?? []) {
      if (!component.has(child)) continue;
      if (child === target) return [...path, child];
      if (seen.has(child)) continue;
      seen.add(child);
      const found = pathBack(child, target, [...path, child], seen);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  for (const child of graph.edges.get(member) ?? []) {
    if (!component.has(child)) continue;
    if (child === member) return [member, member];
    const found = pathBack(child, member, [child], new Set([member, child]));
    if (found !== undefined) return [member, ...found];
  }
  return undefined;
}

/**
 * Report calls cycles in a flat def map. This is the Mode 2 analogue of the
 * Mode 1 include-cycle guard in expandIncludes; the two edge kinds stay
 * deliberately separate. Findings use resolved map identity, not bare call
 * text, so CAS bundle siblings cannot be accidentally fused. The first finding
 * is strict loading's legacy DFS witness. Further findings add at most one
 * deterministic witness for each still-unattributed cyclic member, keeping
 * authoring attribution polynomial and every finding's members consistent with
 * its displayed path without enumerating exponentially many simple cycles.
 */
export function reportCallsCycles(defs: Map<string, WorkflowDef>): CallsCycleFinding[] {
  const graph = buildCallsGraph(defs);
  const first = findFirstCallsCycle(graph);
  if (first === undefined) return [];

  const cycles: string[][] = [first];
  const seen = new Set([cycleFingerprint(first)]);
  const attributed = new Set(first.slice(0, -1));
  const components = cyclicComponentsByMember(graph);
  for (const member of graph.keys) {
    if (attributed.has(member)) continue;
    const component = components.get(member);
    if (component === undefined) continue;
    const witness = cycleThroughMember(member, component, graph);
    if (witness === undefined) continue; // unreachable for a member of a cyclic SCC
    const cycle = canonicalizeCycle(witness, graph.order);
    for (const cycleMember of cycle.slice(0, -1)) attributed.add(cycleMember);
    const fingerprint = cycleFingerprint(cycle);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    cycles.push(cycle);
  }

  return cycles.map((cycle) => ({
    message: `calls cycle: ${cycle.join(' -> ')}`,
    members: cycle.slice(0, -1),
  }));
}

// ---- filesystem loading ------------------------------------------------------

/** Load and validate a single workflow definition from a YAML file. */
export function loadDefFile(file: string): WorkflowDef {
  const text = readFileSync(file, 'utf8');
  const raw = parseYaml(text);
  const def = parseDef(raw, basename(file), dirname(file));
  def.dir = file;
  return def;
}

/**
 * Read, YAML-parse, and shape-build a single def file, attributing any failure
 * to the file: a bare `steps[0]: unknown key 'x'` (or a raw YAML syntax error)
 * is a debugging trap when a whole defs directory is being loaded.
 */
function buildDefFile(file: string): WorkflowDef {
  const text = readFileSync(file, 'utf8');
  try {
    return buildDef(parseYaml(text), basename(file), dirname(file));
  } catch (e) {
    throw new DefError(`${file}: ${(e as Error).message}`);
  }
}

/**
 * Load every workflow definition under `dir`: each `*.yaml` / `*.yml` file, and
 * each immediate subdirectory containing a `workflow.yaml`. Returns them keyed
 * by name (throwing on a duplicate name across files).
 *
 * Two-phase: Phase 1 builds every def (may have `_includes`). Phase 2 expands
 * all includes and validates each expanded def. This lets includes reference sibling
 * defs in the same directory (M1-SITE).
 */
export function loadDefs(dir: string): Map<string, WorkflowDef> {
  // Phase 1 (scan) then Phase 2/3 (finalize). The two phases are split so a
  // caller that needs to MERGE raw maps from several dirs before validating
  // (e.g. the CLI's installed-defs fold-in, which must let a base def `calls:`
  // an installed def across the boundary) can run one finalize over the merged
  // raw map. For a single dir this is exactly the old inline body.
  return finalizeDefs(loadDefsUnfinalized(dir));
}

/**
 * Phase 1 of def loading: scan `dir` and build every workflow def UN-finalized
 * (includes not yet expanded, no cross-def / cycle validation). Loads each
 * top-level `*.yaml` / `*.yml` file (excluding a top-level `workflow.yaml`) and
 * each immediate subdirectory's `workflow.yaml`. Throws `DefError` on a
 * duplicate name WITHIN this dir. This is a pure extraction of what used to live
 * inline in `loadDefs` — `loadDefs(dir)` is exactly `finalizeDefs(loadDefsUnfinalized(dir))`.
 *
 * Exported so a caller can merge the raw maps of several dirs and run a single
 * `finalizeDefs` over the union (giving correct include-expansion and cross-def
 * `calls:` resolution across the merged boundary). This function stays a pure
 * dir-scanner: it holds NO ledger / `installed.json` knowledge (that composition
 * lives at the CLI layer where cwd and defsDir are both known).
 */
export function loadDefsUnfinalized(dir: string): Map<string, WorkflowDef> {
  const raw = new Map<string, WorkflowDef>();
  const addRaw = (def: WorkflowDef, file: string): void => {
    if (raw.has(def.name)) throw new DefError(`duplicate workflow name '${def.name}' under ${dir}`);
    def.dir = file;
    raw.set(def.name, def);
  };
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      const wf = join(full, 'workflow.yaml');
      if (existsSync(wf) && statSync(wf).isFile()) {
        addRaw(buildDefFile(wf), wf);
      }
    } else if (/\.ya?ml$/.test(entry) && entry !== 'workflow.yaml') {
      addRaw(buildDefFile(full), full);
    }
  }
  return raw;
}

/**
 * Phase 2/3 of def loading, factored out so it is the ONE validator every
 * public construction path shares — the filesystem `loadDefs` above AND the
 * in-memory `createEngine({ defs })` factory path (REL-4). Given a raw def map
 * (each def possibly still carrying `_includes`), it: expands each def's
 * includes; runs the cross-def `calls:` checks (target existence, `callsInputs`
 * key validity, exactly-one child output); runs `validateDef` per expanded def;
 * and finally performs the bounded first-cycle DFS over the whole expanded map.
 * `reportCallsCycles` exposes the wider per-member authoring report. Returns the
 * expanded, validated map. Throws `DefError` on the first problem — the same
 * messages, in the same order, the filesystem loader has always produced (this
 * is a pure extraction of what used to live inline in `loadDefs`).
 *
 * A host wiring an `Engine` by hand with its own set can call this to get the
 * same validation the factory and the loader apply. `expandIncludes` is a no-op
 * for a def without `_includes` (the normal in-memory case), so passing a plain
 * def map through is cheap and only adds the cross-def + cycle checks.
 */
export interface FinalizeDefsOptions {
  /**
   * Explicit versioned targets whose definitions live in another installed
   * bundle. Install-time validation may defer those edges; executable discovery
   * later validates them against the complete store map before any run starts.
   */
  allowUnresolvedVersionedCalls?: ReadonlySet<string>;
  /**
   * Permit unresolved `calls:` edges in an explicitly partial, read-only map.
   * Never use this option to construct an executable resolver.
   */
  allowUnresolvedCalls?: boolean;
}

/**
 * Return every direct cross-definition `calls:` error for one expanded
 * definition. Strict loading uses the first result to retain its historical
 * throw behavior; tolerant authoring commands can present the complete list.
 */
export function validateCallsEdges(
  def: WorkflowDef,
  defs: Map<string, WorkflowDef>,
  options: FinalizeDefsOptions = {},
): string[] {
  const errors: string[] = [];
  for (const step of def.steps) {
    if (!step.calls) continue;
    const childDef = resolveCallsTarget(defs, step.calls, def);
    if (!childDef) {
      if (
		options.allowUnresolvedCalls !== true
		&& options.allowUnresolvedVersionedCalls?.has(step.calls) !== true
      ) {
		errors.push(`calls names workflow '${step.calls}' which does not exist`);
      }
      continue;
    }
    const childInputNames = new Set(childDef.inputs.map((input) => input.name));
    for (const key of Object.keys(step.callsInputs ?? {})) {
      if (!childInputNames.has(key)) {
		errors.push(`calls '${step.name}' maps input '${key}' which workflow '${step.calls}' does not declare`);
      }
    }
    const childOutputs = childDef.outputs ?? [];
    if (childOutputs.length === 0) {
      errors.push(`calls names workflow '${step.calls}' which declares no outputs:`);
    }
    if (childOutputs.length > 1) {
      errors.push(`calls names workflow '${step.calls}' which declares ${childOutputs.length} outputs:, calls: v1 requires exactly one`);
    }
  }
  return errors;
}

export function finalizeDefs(
  raw: Map<string, WorkflowDef>,
  options: FinalizeDefsOptions = {},
): Map<string, WorkflowDef> {
  const out = new Map<string, WorkflowDef>();
  const resolver = (name: string): WorkflowDef | undefined => raw.get(name);
  for (const [name, def] of raw) {
    const expanded = expandIncludes(def, resolver);

    const callsErrors = validateCallsEdges(expanded, raw, options);
    if (callsErrors.length > 0) throw new DefError(callsErrors[0]);

    const errors = validateDef(expanded);
    if (errors.length) {
      throw new DefError(
        `invalid workflow '${name}' (${def.dir ?? 'unknown'}):\n  - ${errors.join('\n  - ')}`,
      );
    }
    out.set(name, expanded);
  }

  // Preserve strict loading's first, stable cycle error after all per-def checks
  // without paying the wider authoring reporter's per-member attribution cost.
  const cycle = findFirstCallsCycle(buildCallsGraph(out));
  if (cycle !== undefined) throw new DefError(`calls cycle: ${cycle.join(' -> ')}`);

  return out;
}

/** One file that `loadDefsRaw` could not turn into a def (malformed YAML, bad shape, duplicate name). */
export interface DefLoadFailure {
  file: string;
  error: string;
}

/**
 * Like `loadDefs` but uses `buildDef` (not `parseDef`) so wiring errors are
 * returned in the lint result rather than thrown. Used by `owenloop lint`.
 * Skips files that fail shape-parsing (malformed YAML or bad types); pass
 * `failures` to collect what was skipped and why, so callers can surface it.
 *
 * Two-phase: Phase 1 collects all defs. Phase 2 expands includes best-effort
 * (silently skips expansion failures so the lint caller sees un-expanded defs).
 */
export function scanDefsRaw(dir: string, failures?: DefLoadFailure[]): Map<string, WorkflowDef> {
  // Phase 1: build all defs, skipping (and recording) malformed files.
  const raw = new Map<string, WorkflowDef>();
  const tryAdd = (file: string): void => {
    try {
      const text = readFileSync(file, 'utf8');
      const def = buildDef(parseYaml(text), basename(file), dirname(file));
      def.dir = file;
      if (raw.has(def.name)) {
        failures?.push({ file, error: `duplicate workflow name '${def.name}' under ${dir}` });
        return;
      }
      raw.set(def.name, def);
    } catch (e) {
      failures?.push({ file, error: (e as Error).message });
    }
  };
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      const wf = join(full, 'workflow.yaml');
      if (existsSync(wf) && statSync(wf).isFile()) tryAdd(wf);
    } else if (/\.ya?ml$/.test(entry) && entry !== 'workflow.yaml') {
      tryAdd(full);
    }
  }

  return raw;
}

/** Best-effort include expansion for a complete, already-merged raw map. */
export function expandDefsRaw(raw: Map<string, WorkflowDef>): Map<string, WorkflowDef> {
  const out = new Map<string, WorkflowDef>();
  const resolver = (name: string): WorkflowDef | undefined => raw.get(name);
  for (const [name, def] of raw) {
    try {
      const expanded = expandIncludes(def, resolver);
      out.set(name, expanded);
    } catch {
      // Expansion failed (e.g. missing child, cycle); keep un-expanded so lint can report.
      out.set(name, def);
    }
  }

  return out;
}

/**
 * Compatibility wrapper for tolerant single-directory loading. Raw loading
 * builds and expands includes best-effort; callers explicitly invoke shared
 * calls validation and cycle reporting against the complete definition map.
 */
export function loadDefsRaw(dir: string, failures?: DefLoadFailure[]): Map<string, WorkflowDef> {
  return expandDefsRaw(scanDefsRaw(dir, failures));
}
