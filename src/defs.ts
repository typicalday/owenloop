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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseConsume, parseProduce } from './paths.ts';
import { parseDurationMs, parseDurationSecs } from './util.ts';
import { assertValidSchema } from './schema.ts';
import type { Acceptance, EffectDef, FiringTrigger, GroupDef, InputDef, InvariantDef, InvariantPredicate, JsonSchema, StepDef, ProducePattern, WorkflowDef } from './types.ts';

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

/** A produce entry: either a bare `"plan"` string, or `{ name, schema, judges }`. */
interface RawProduce {
  name?: unknown;
  schema?: unknown;
  /** §24 judges: optional quality-gate list hanging off a singleton produce entry. */
  judges?: unknown;
}
const RAW_PRODUCE_KEYS = ['name', 'schema', 'judges'] as const;

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
}
const RAW_JUDGE_KEYS = ['name', 'body', 'bodyFile', 'model', 'inputs', 'cadence', 'maxRunsPerDay'] as const;

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
  terminal?: unknown;
  effect?: unknown;
  on?: unknown;
  idleAfter?: unknown;
  body?: unknown;
  bodyFile?: unknown;
  /** M2-GRAMMAR: if present, this entry is a calls: step (Mode 2 runtime composition). */
  calls?: unknown;
  reapTtl?: unknown;
}
/** Keys valid on a normal (non-calls:, non-include:) step entry. */
const RAW_STEP_KEYS = [
  'name', 'consumes', 'produces', 'generates', 'invalidates', 'cadence',
  'maxRunsPerDay', 'parallel', 'maxAttempts', 'maxSchemaFailures', 'model',
  'workdir', 'terminal', 'effect', 'on', 'idleAfter', 'body', 'bodyFile',
  'calls', 'reapTtl',
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
}
const RAW_DEF_KEYS = ['name', 'title', 'description', 'inputs', 'steps', 'outputs', 'invariants', 'engine'] as const;

// ---- defaults ----------------------------------------------------------------

const DEFAULTS = {
  cadence: '0s',
  maxRunsPerDay: 1000,
  parallel: 1,
  maxAttempts: 3,
  maxSchemaFailures: 5,
  workdir: 'main',
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
      const resolvedPath = join(baseDir, bodyFileRel);
      try {
        body = readFileSync(resolvedPath, 'utf8');
      } catch (e) {
        throw new DefError(`judge '${name}': bodyFile '${bodyFileRel}' could not be read (resolved to '${resolvedPath}'): ${(e as Error).message}`);
      }
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
 * Parse a step's `produces` list. Each entry is either a bare pattern string
 * (`plan`, `gather.source[]`), a mapping `{ name, schema, judges }` attaching
 * a JSON Schema the produced value must satisfy at commit time (§19) and/or a
 * quality-gate list (§24), or a `{ group, mode, of }` exclusivity declaration
 * (§26) spanning sibling stems produced by this same list. `baseDir` resolves
 * judge `bodyFile:` entries. Returns both the produce patterns and any groups
 * found, as a pure function (no out-param mutation).
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
      patterns.push(pat);
      return;
    }
    throw new DefError(`${ctx}[${i}] must be a string or a { name, schema, judges } mapping`);
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
  return def;
}

// ---- Mode 1 expand helpers (M1-EXPAND) ----------------------------------------

/**
 * Prefix all names/stems in a StepDef with `${prefix}.`. Pure — returns a new StepDef.
 * Rewrites: step name, consume stems, produce stems, generates stems, invalidates, and
 * effect.onInvalidate step-name strings (but not 'pin'/'escalate').
 */
function prefixStep(step: StepDef, prefix: string): StepDef {
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
      raw = `${stem}[*]`;
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

  const result: StepDef = {
    ...step,
    name: prefixStem(step.name),
    consumes: newConsumes,
    produces: newProduces,
    invalidates: newInvalidates,
  };
  if (newGenerates !== undefined) result.generates = newGenerates;
  if (newEffect !== undefined) result.effect = newEffect;
  if (newJudges !== undefined) result.judges = newJudges;
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
      const prefixedSteps = child.steps.map((l) => prefixStep(l, inc.as));

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
      const rewrittenSteps = prefixedSteps.map((l) => {
        const rewrittenConsumes = l.consumes.map((c) => {
          const outer = inputRewrites.get(c.stem);
          if (outer !== undefined) {
            // Replace the consume with a plain consume to the outer artifact
            return { raw: outer, mode: 'plain' as const, stem: outer, suffix: '' };
          }
          return c;
        });
        return { ...l, consumes: rewrittenConsumes };
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

  return {
    ...def,
    steps: resultSteps,
    inputs: resultInputs,
    outputs: resultOutputs.length > 0 ? resultOutputs : def.outputs,
    _includes: undefined,
  };
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
 * workdir, maxAttempts/maxSchemaFailures defaults) is inherited exactly like
 * an ordinary step, because judge orders flow through the normal
 * eligibleFirings → applySchedule → claim → buildOrder pipeline (§7.1).
 */
function synthesizeJudgeSteps(
  producerStepName: string,
  pat: ProducePattern,
  producerConsumeStems: string[],
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
      workdir: DEFAULTS.workdir,
      body: j.body,
    };
    if (j.model !== undefined) step.model = j.model;
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
      workdir: DEFAULTS.workdir,
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
    const resolvedPath = join(baseDir, bodyFileRel);
    try {
      body = readFileSync(resolvedPath, 'utf8');
    } catch (e) {
      throw new DefError(`step '${name}': bodyFile '${bodyFileRel}' could not be read (resolved to '${resolvedPath}'): ${(e as Error).message}`);
    }
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
    workdir: rl.workdir === undefined ? DEFAULTS.workdir : asString(rl.workdir, `step '${name}'.workdir`),
    body,
  };
  if (rl.model !== undefined) step.model = asString(rl.model, `step '${name}'.model`);
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
          `step '${name}': on: token '${tok}' is not supported; supported: 'inputsGreen', 'allGreen', 'idle'`,
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
  // generates: entries may not declare judges: (they are lint-exempt side outputs,
  // not part of the step's primary contract) — hard error mirrors the calls: check above.
  for (const p of generatesPatterns) {
    if (p.judges && p.judges.length > 0) {
      throw new DefError(`step '${name}': judges: is not supported on a generates: entry (produce '${p.stem}')`);
    }
  }
  const producerConsumeStems = consumes.map((c) => c.stem);
  const judgeSteps = producesPatterns.flatMap((p) => synthesizeJudgeSteps(name, p, producerConsumeStems));
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
          `supported: 'inputsGreen', 'allGreen', 'idle'.`,
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
 * Static lint over a workflow definition. Returns both the hard errors from
 * `validateDef` (which `parseDef` / `loadDefFile` would throw on) and
 * non-fatal warnings (dead-end outputs). Warnings never block loading — this
 * function is the right surface for author tooling / CI checks.
 *
 * Dead-end warnings are suppressed when there are hard errors: a broken graph
 * may have spurious orphan stems that will resolve once the errors are fixed.
 */
export function lintDef(def: WorkflowDef): { errors: string[]; warnings: string[] } {
  const errors = validateDef(def);
  const warnings = errors.length === 0 ? deadEndWarnings(def) : [];
  return { errors, warnings };
}

// ---- M2-CYCLE: cross-def calls-cycle detection --------------------------------

/**
 * Walk the calls: edges in a flat def map and throw a DefError if any cycle exists.
 * This is the Mode 2 analogue of the Mode 1 include-cycle guard in expandIncludes.
 * Note: include: and calls: are DIFFERENT edge kinds — they are checked separately.
 *
 * Called from loadDefs Phase 2 after all defs are expanded and per-def validated.
 */
function detectCallsCycles(defs: Map<string, WorkflowDef>): void {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>([...defs.keys()].map((k) => [k, WHITE]));
  const stack: string[] = [];

  const visit = (name: string): void => {
    color.set(name, GREY);
    stack.push(name);
    const def = defs.get(name);
    // Unique calls: edges from this def (multiple steps might call the same child)
    const callsEdges = new Set((def?.steps ?? []).filter((l) => l.calls).map((l) => l.calls!));
    for (const child of callsEdges) {
      if (!defs.has(child)) continue; // missing-def error is reported separately in loadDefs
      const c = color.get(child) ?? WHITE;
      if (c === GREY) {
        const from = stack.indexOf(child);
        throw new DefError(`calls cycle: ${[...stack.slice(from), child].join(' -> ')}`);
      }
      if (c === WHITE) visit(child);
    }
    stack.pop();
    color.set(name, BLACK);
  };

  for (const name of defs.keys()) {
    if ((color.get(name) ?? WHITE) === WHITE) visit(name);
  }
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
 * Load every workflow definition under `dir`: each `*.yaml` / `*.yml` file, and
 * each immediate subdirectory containing a `workflow.yaml`. Returns them keyed
 * by name (throwing on a duplicate name across files).
 *
 * Two-phase: Phase 1 builds every def (may have `_includes`). Phase 2 expands
 * all includes and validates each expanded def. This lets includes reference sibling
 * defs in the same directory (M1-SITE).
 */
export function loadDefs(dir: string): Map<string, WorkflowDef> {
  // Phase 1: build all defs (un-expanded) from disk.
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
      try {
        if (statSync(wf).isFile()) {
          const text = readFileSync(wf, 'utf8');
          addRaw(buildDef(parseYaml(text), basename(wf), dirname(wf)), wf);
        }
      } catch (e) {
        if (e instanceof DefError) throw e;
        /* no workflow.yaml in this subdir — skip */
      }
    } else if (/\.ya?ml$/.test(entry) && entry !== 'workflow.yaml') {
      const text = readFileSync(full, 'utf8');
      addRaw(buildDef(parseYaml(text), basename(full), dirname(full)), full);
    }
  }

  // Phase 2: expand includes, run per-def validation, and cross-def calls: checks.
  const out = new Map<string, WorkflowDef>();
  const resolver = (name: string): WorkflowDef | undefined => raw.get(name);
  for (const [name, def] of raw) {
    const expanded = expandIncludes(def, resolver);

    // M2-VALIDATE cross-def: target-def existence + child input-key validity.
    // These cannot live in validateDef (pure per-def, no resolver) — same split as expandIncludes.
    for (const l of expanded.steps) {
      if (!l.calls) continue;
      const childDef = resolver(l.calls);
      if (!childDef) {
        throw new DefError(`calls names workflow '${l.calls}' which does not exist`);
      }
      const childInputNames = new Set(childDef.inputs.map((i) => i.name));
      for (const k of Object.keys(l.callsInputs ?? {})) {
        if (!childInputNames.has(k)) {
          throw new DefError(`calls '${l.name}' maps input '${k}' which workflow '${l.calls}' does not declare`);
        }
      }
      // M2B-OUTCOME v1: the called workflow must declare exactly one output.
      const childOutputs = childDef.outputs ?? [];
      if (childOutputs.length === 0) {
        throw new DefError(`calls names workflow '${l.calls}' which declares no outputs:`);
      }
      if (childOutputs.length > 1) {
        throw new DefError(`calls names workflow '${l.calls}' which declares ${childOutputs.length} outputs:, calls: v1 requires exactly one`);
      }
    }

    const errors = validateDef(expanded);
    if (errors.length) {
      throw new DefError(
        `invalid workflow '${name}' (${def.dir ?? 'unknown'}):\n  - ${errors.join('\n  - ')}`,
      );
    }
    out.set(name, expanded);
  }

  // M2-CYCLE: detect calls: cycles over the full expanded def map (after all per-def checks pass).
  detectCallsCycles(out);

  return out;
}

/**
 * Like `loadDefs` but uses `buildDef` (not `parseDef`) so wiring errors are
 * returned in the lint result rather than thrown. Used by `owenloop lint`.
 * Silently skips files that fail shape-parsing (malformed YAML or bad types).
 *
 * Two-phase: Phase 1 collects all defs. Phase 2 expands includes best-effort
 * (silently skips expansion failures so the lint caller sees un-expanded defs).
 */
export function loadDefsRaw(dir: string): Map<string, WorkflowDef> {
  // Phase 1: build all defs silently skipping malformed files.
  const raw = new Map<string, WorkflowDef>();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      const wf = join(full, 'workflow.yaml');
      try {
        if (statSync(wf).isFile()) {
          const text = readFileSync(wf, 'utf8');
          const def = buildDef(parseYaml(text), basename(wf), dirname(wf));
          def.dir = wf;
          if (!raw.has(def.name)) raw.set(def.name, def);
        }
      } catch { /* no workflow.yaml or buildDef failed shape-check — skip */ }
    } else if (/\.ya?ml$/.test(entry) && entry !== 'workflow.yaml') {
      try {
        const text = readFileSync(full, 'utf8');
        const def = buildDef(parseYaml(text), basename(full), dirname(full));
        def.dir = full;
        if (!raw.has(def.name)) raw.set(def.name, def);
      } catch { /* malformed YAML or shape error — skip */ }
    }
  }

  // Phase 2: expand includes best-effort; on failure keep the un-expanded def.
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

  // M2-CYCLE: best-effort calls-cycle check so lint can surface cycle errors.
  try {
    detectCallsCycles(out);
  } catch {
    // Cycle errors are surfaced via validateDef in the lint caller; swallow here.
  }

  return out;
}
